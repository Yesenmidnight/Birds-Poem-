/**
 * 动态电线（2026-11-23 合流返工）：跨院双层电线（顶面一条薄积雪）+ 大植物园拱架下的细长拉杆——从静态合批（Yard.ts 的 Batch）里拆出来，
 * 按碰撞层 CurvePerch 的弹簧位移实时改顶点。
 *
 * 合流前原版这些是 TestRig 那套动态管子；合流时被塞进静态 Batch，碰撞体在颤、画面却是死的（弹簧时间静止 Bug 的另一半：
 * CourtyardApp.tick 每帧 world.advance(dt) 推进弹簧，这里负责把位移画出来）。
 *
 * 做法（和 TestRig.addTube 一致）：建网格时记一份静止坐标 base；每帧只在 perch.offset 变了时按 offsetAt(s) 改每一行的 y——
 * 管子、雪条、调试中心线一起动，鸟根跟着同一个 offsetAt 走（Player），所以鸟脚和线零脱节。
 * 两端固定的电线（振型 sin(πs/L)，中点最大、两端不动）：鸟落上去线先沉再上下弹晃几下（2.4 Hz 欠阻尼）。
 * 放在背景层（图层 0，庭院的默认图层）：观鸟态跟房屋一起虚化，漫游态单趟直绘。
 */
import { BufferAttribute, BufferGeometry, Color, Float32BufferAttribute, Group, Line, LineBasicMaterial, Mesh, type Material } from 'three';
import { CurvePerch, makeCurveFrame, type CurveFrame } from '../sim/curvePerch';
import type { CourtyardMaterials } from './materials';

/** 一块会动的网格 / 线：顶点按 rows × cols 排，行 i 对应弧长 s = i / (rows − 1) × 全长。 */
interface FlexPart {
  attr: BufferAttribute;
  /** 没有振动位移的顶点坐标。 */
  base: Float32Array;
  cols: number;
  rows: number;
}

interface Flex {
  perch: CurvePerch;
  parts: FlexPart[];
  last: number;
}

/** 电线雪条的环向列数（顶面 ±55° 一条带）。 */
const SNOW_COLS = 4;
/** 电线雪条的半张角（弧度）和冠顶厚度（厘米）。 */
const SNOW_HALF = 0.96;
const SNOW_TOP = 0.16;
/** 调试中心线的颜色（和 Overlay 的 wire / cv-tie 同色）。 */
const LINE_COLOR: Record<string, number> = { wire: 0xff5a4a, 'cv-tie': 0xffb03a };

export class DynamicWires {
  readonly group = new Group();
  /** 调试中心线（挂进 Overlay 的组里，?debug=1 才看得见）：跟管子一起随振动更新。 */
  readonly debug = new Group();
  private readonly flex: Flex[] = [];
  private readonly frame: CurveFrame = makeCurveFrame();

  /**
   * @param perches 要画成动态管子的曲线栖木（按 tag 挑好的：电线两根 + 拉杆若干）。tag 决定材质 / 雪条 / 中心线颜色。
   */
  constructor(perches: readonly { perch: CurvePerch; tag: string }[], m: CourtyardMaterials) {
    this.group.name = 'dynamic-wires';
    this.debug.name = 'dynamic-wires-debug';
    for (const { perch, tag } of perches) {
      const wire = tag === 'wire';
      const f: Flex = { perch, parts: [], last: 0 };
      this.flex.push(f);
      // 管子：半径 = 碰撞半径（鸟脚贴的就是它；以前静态批里画 0.9、碰撞 0.6，脚陷在线里 0.3 cm）
      const tube = this.tube(perch, wire ? 8 : 6, wire ? m.wire : m.metal, tag);
      f.parts.push(tube.part);
      this.group.add(tube.mesh);
      if (wire) {
        const snow = this.snowStrip(perch, m.snow);
        f.parts.push(snow.part);
        this.group.add(snow.mesh);
      }
      const line = this.centerLine(perch, LINE_COLOR[tag] ?? 0xffb03a);
      f.parts.push(line.part);
      this.debug.add(line.mesh);
    }
    // 首帧就按当前位移摆好（重置 / 读完页面时弹簧可能在动）
    this.update(true);
  }

  /** 每帧：perch.offset 变了才写顶点（静止时零开销）。force = 强制重写。必须在 world.advance(dt) 之后调。 */
  update(force = false): void {
    for (const f of this.flex) {
      const off = f.perch.offset;
      if (!force && off === f.last) continue;
      f.last = off;
      for (const part of f.parts) {
        const arr = part.attr.array as Float32Array;
        const base = part.base;
        const rows = part.rows;
        const cols = part.cols;
        for (let i = 0; i < rows; i++) {
          const d = f.perch.offsetAt((i / (rows - 1)) * f.perch.length);
          for (let j = 0; j < cols; j++) {
            const k = (i * cols + j) * 3 + 1;
            arr[k] = base[k] + d;
          }
        }
        part.attr.needsUpdate = true;
      }
    }
  }

  /** 沿曲线铺的圆管：行 = 弧长等距采样（和碰撞体同一套采样），列 = 环向 + 1（接缝列重复）。 */
  private tube(perch: CurvePerch, radial: number, mat: Material, tag: string): { mesh: Mesh; part: FlexPart } {
    const rows = perch.segments + 1;
    const cols = radial + 1;
    const pos = new Float32Array(rows * cols * 3);
    const nrm = new Float32Array(rows * cols * 3);
    const uv = new Float32Array(rows * cols * 2);
    const idx: number[] = [];
    const f = this.frame;
    for (let i = 0; i < rows; i++) {
      perch.frameAt((i / perch.segments) * perch.length, f);
      for (let j = 0; j < cols; j++) {
        const th = (j / radial) * Math.PI * 2;
        const cv = Math.cos(th);
        const sv = Math.sin(th);
        const nx = f.ux * cv + f.sx * sv;
        const ny = f.uy * cv + f.sy * sv;
        const nz = f.uz * cv + f.sz * sv;
        const k = i * cols + j;
        pos.set([f.cx + nx * f.radius, f.cy + ny * f.radius, f.cz + nz * f.radius], k * 3);
        nrm.set([nx, ny, nz], k * 3);
        uv.set([j / radial, i / (rows - 1)], k * 2);
        if (i < rows - 1 && j < radial) {
          const a = k;
          idx.push(a, a + 1, a + cols, a + 1, a + cols + 1, a + cols);
        }
      }
    }
    const geo = new BufferGeometry();
    const attr = new Float32BufferAttribute(pos, 3);
    geo.setAttribute('position', attr);
    geo.setAttribute('normal', new Float32BufferAttribute(nrm, 3));
    geo.setAttribute('uv', new Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    // 包围球按静止坐标算；振幅最多 ~1.7 cm，留一点余量就够（管线不做逐顶点剔除）
    geo.computeBoundingSphere();
    geo.boundingSphere!.radius += 4;
    const mesh = new Mesh(geo, mat);
    mesh.name = `dyn:${tag}`;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    return { mesh, part: { attr, base: pos.slice(), cols, rows } };
  }

  /** 电线顶面的薄积雪条：±SNOW_HALF 弧度的一条带，冠顶厚 SNOW_TOP、边缘收薄；每隔一个采样点取一行（省一半顶点）。 */
  private snowStrip(perch: CurvePerch, mat: Material): { mesh: Mesh; part: FlexPart } {
    const rows = Math.floor(perch.segments / 2) + 1;
    const cols = SNOW_COLS + 1;
    const pos = new Float32Array(rows * cols * 3);
    const uv = new Float32Array(rows * cols * 2);
    const idx: number[] = [];
    const f = this.frame;
    for (let i = 0; i < rows; i++) {
      perch.frameAt(((i * 2) / perch.segments) * perch.length, f);
      for (let j = 0; j < cols; j++) {
        const ph = ((j / SNOW_COLS) * 2 - 1) * SNOW_HALF;
        const t = Math.cos((ph / SNOW_HALF) * Math.PI * 0.5);
        const rr = f.radius + SNOW_TOP * Math.pow(t, 0.6) - 0.02;
        const dx = f.ux * Math.cos(ph) + f.sx * Math.sin(ph);
        const dy = f.uy * Math.cos(ph) + f.sy * Math.sin(ph);
        const dz = f.uz * Math.cos(ph) + f.sz * Math.sin(ph);
        const k = i * cols + j;
        pos.set([f.cx + dx * rr, f.cy + dy * rr, f.cz + dz * rr], k * 3);
        uv.set([j / SNOW_COLS, i / (rows - 1)], k * 2);
        if (i < rows - 1 && j < SNOW_COLS) {
          const a = k;
          idx.push(a, a + 1, a + cols, a + 1, a + cols + 1, a + cols);
        }
      }
    }
    const geo = new BufferGeometry();
    const attr = new Float32BufferAttribute(pos, 3);
    geo.setAttribute('position', attr);
    geo.setAttribute('uv', new Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    geo.boundingSphere!.radius += 4;
    const mesh = new Mesh(geo, mat);
    mesh.name = 'dyn:wire-snow';
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    return { mesh, part: { attr, base: pos.slice(), cols, rows } };
  }

  /** 曲线中心线（叠加显示用）：一条折线，顶点 i = 采样行 i（rows × 1 列，和管子同一套更新）。 */
  private centerLine(perch: CurvePerch, color: number): { mesh: Line; part: FlexPart } {
    const rows = perch.segments + 1;
    const pos = new Float32Array(rows * 3);
    const f = this.frame;
    for (let i = 0; i < rows; i++) {
      perch.frameAt((i / perch.segments) * perch.length, f);
      pos.set([f.cx, f.cy, f.cz], i * 3);
    }
    const geo = new BufferGeometry();
    const attr = new Float32BufferAttribute(pos, 3);
    geo.setAttribute('position', attr);
    const line = new Line(geo, new LineBasicMaterial({ color: new Color(color), transparent: true, opacity: 0.9, depthTest: false }));
    line.frustumCulled = false;
    line.renderOrder = 51;
    return { mesh: line, part: { attr, base: pos.slice(), cols: 1, rows } };
  }
}
