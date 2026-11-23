/**
 * 几何合批：同一材质的所有零碎几何（盒、柱、面片）合成一个静态网格，一类材质一次绘制。
 * 庭院的砖块、窗格、栏杆、栅栏、花盆……全都靠它把 Draw Call 压进预算。
 * 所有几何进组前统一补齐 position / normal / uv 和索引，mergeGeometries 才肯合并。
 */
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  Matrix4,
  Mesh,
  Vector3,
  type Material,
  type Object3D,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export interface BatchOptions {
  cast?: boolean;
  receive?: boolean;
  /** 自定义属性：每个顶点一个常量值（如窗玻璃的 aLit、叶片的 aColor）。 */
  attrs?: Record<string, number[]>;
  /** 按 uv 给每个顶点算 aEdge = (到 u 向两条边的归一化距离, 到 v 向两条边的)：玻璃结霜用，盒子玻璃也要有它才能和面片玻璃合并。 */
  edgeFromUv?: boolean;
}

interface Group {
  mat: Material;
  geos: BufferGeometry[];
  cast: boolean;
  receive: boolean;
  name: string;
}

export class Batch {
  private readonly groups = new Map<string, Group>();

  constructor(private readonly castDefault = true, private readonly receiveDefault = true) {}

  /** 加一块几何进组；给了矩阵就地变换。 */
  add(key: string, mat: Material, geo: BufferGeometry, m?: Matrix4, opts: BatchOptions = {}): void {
    if (m) geo.applyMatrix4(m);
    const count = geo.attributes.position.count;
    if (!geo.attributes.normal) geo.computeVertexNormals();
    if (!geo.attributes.uv) geo.setAttribute('uv', new Float32BufferAttribute(new Float32Array(count * 2), 2));
    if (!geo.index) {
      const idx = new Uint32Array(count);
      for (let i = 0; i < count; i++) idx[i] = i;
      geo.setIndex(new BufferAttribute(idx, 1));
    }
    if (opts.attrs) {
      for (const [name, v] of Object.entries(opts.attrs)) {
        const arr = new Float32Array(count * v.length);
        for (let i = 0; i < count; i++) arr.set(v, i * v.length);
        geo.setAttribute(name, new Float32BufferAttribute(arr, v.length));
      }
    }
    if (opts.edgeFromUv) {
      const uv = geo.attributes.uv as BufferAttribute;
      const edge = new Float32Array(count * 2);
      for (let i = 0; i < count; i++) {
        edge[i * 2] = Math.min(uv.getX(i), 1 - uv.getX(i));
        edge[i * 2 + 1] = Math.min(uv.getY(i), 1 - uv.getY(i));
      }
      geo.setAttribute('aEdge', new BufferAttribute(edge, 2));
    }
    let g = this.groups.get(key);
    if (!g) {
      g = { mat, geos: [], cast: opts.cast ?? this.castDefault, receive: opts.receive ?? this.receiveDefault, name: key };
      this.groups.set(key, g);
    }
    g.geos.push(geo);
  }

  /** 轴对齐盒：[min, max]。 */
  box(key: string, mat: Material, min: readonly number[], max: readonly number[], opts: BatchOptions = {}): void {
    const w = Math.max(1e-3, max[0] - min[0]);
    const h = Math.max(1e-3, max[1] - min[1]);
    const d = Math.max(1e-3, max[2] - min[2]);
    const geo = new BoxGeometry(w, h, d);
    geo.translate(min[0] + w / 2, min[1] + h / 2, min[2] + d / 2);
    this.add(key, mat, geo, undefined, opts);
  }

  /** 圆柱：底面中心 (x, y, z)、半径、高、分段；可绕 x / z 轴翻转成横管。 */
  cyl(key: string, mat: Material, x: number, y: number, z: number, r: number, h: number, seg = 12, rx = 0, rz = 0, opts: BatchOptions = {}): void {
    const geo = new CylinderGeometry(r, r, h, seg, 1);
    if (rx) geo.rotateX(rx);
    if (rz) geo.rotateZ(rz);
    geo.translate(x, y, z);
    this.add(key, mat, geo, undefined, opts);
  }

  /** 两点之间的圆管（栏杆、链条、电线杆横担）。 */
  tube(key: string, mat: Material, a: readonly number[], b: readonly number[], r: number, seg = 8, opts: BatchOptions = {}): void {
    const va = new Vector3(a[0], a[1], a[2]);
    const vb = new Vector3(b[0], b[1], b[2]);
    const n = vb.clone().sub(va);
    const len = n.length();
    if (len < 1e-6) return;
    const geo = new CylinderGeometry(r, r, len, seg, 1);
    const m = new Matrix4();
    const up = new Vector3(0, 1, 0);
    n.multiplyScalar(1 / len);
    const axis = new Vector3().crossVectors(up, n);
    if (axis.lengthSq() > 1e-10) m.makeRotationAxis(axis.normalize(), Math.acos(Math.min(1, Math.max(-1, up.dot(n)))));
    else if (n.y < 0) m.makeRotationX(Math.PI);
    m.setPosition(va.clone().add(vb).multiplyScalar(0.5));
    this.add(key, mat, geo, m, opts);
  }

  /** 平面四边形（玻璃、屋面雪层、叶面）：四个角逆时针（法线朝外）。uv 0..1，aEdge = 到最近边的归一化距离（玻璃结霜用）。 */
  quad(
    key: string,
    mat: Material,
    a: readonly number[],
    b: readonly number[],
    c: readonly number[],
    d: readonly number[],
    opts: BatchOptions & { edge?: boolean } = {},
  ): void {
    const geo = new BufferGeometry();
    const pos = new Float32Array([...a, ...b, ...c, ...d]);
    geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    geo.computeVertexNormals();
    if (opts.edge !== false) {
      // 到四条边的归一化距离（按 uv 算），玻璃着色器用它把霜结晶往边角赶
      geo.setAttribute('aEdge', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1], 2));
    }
    this.add(key, mat, geo, undefined, opts);
  }

  /** 任意几何 + 矩阵。 */
  geo(key: string, mat: Material, g: BufferGeometry, m: Matrix4 | undefined, opts: BatchOptions = {}): void {
    this.add(key, mat, g, m, opts);
  }

  /** 斜放的矩形木料（椽条 / 天窗盖框）：从 (yA, zA) 到 (yB, zB) 沿 z 方向铺，截面 w（x 向）× h（法向厚）。 */
  sloped(key: string, mat: Material, x: number, yA: number, zA: number, yB: number, zB: number, w: number, h: number, opts: BatchOptions = {}): void {
    const dz = zB - zA;
    const dy = yB - yA;
    const len = Math.hypot(dz, dy);
    const ang = Math.atan2(dy, dz);
    const geo = new BoxGeometry(w, h, len);
    const m = new Matrix4();
    m.makeRotationX(-ang);
    m.setPosition(x, (yA + yB) / 2, (zA + zB) / 2);
    this.add(key, mat, geo, m, opts);
  }

  /** 把所有组合成网格挂到 parent 上，返回网格数（= Draw Call 数）。 */
  build(parent: Object3D): Mesh[] {
    const out: Mesh[] = [];
    for (const g of this.groups.values()) {
      const merged = g.geos.length === 1 ? g.geos[0] : mergeGeometries(g.geos, false);
      if (!merged) throw new Error(`合批失败：${g.name}`);
      if (g.geos.length > 1) for (const x of g.geos) x.dispose();
      merged.computeBoundingSphere();
      const mesh = new Mesh(merged, g.mat);
      mesh.name = `batch:${g.name}`;
      mesh.castShadow = g.cast;
      mesh.receiveShadow = g.receive;
      parent.add(mesh);
      out.push(mesh);
    }
    return out;
  }

  get groupCount(): number {
    return this.groups.size;
  }
}
