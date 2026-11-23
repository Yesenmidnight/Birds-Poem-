/**
 * 大植物园温室（视觉层）：白色铸铁珐琅柱 / 檐梁 / 折线拱架 / 檩条 / 拉杆，灰色石砌矮墙 + 石压顶，结霜玻璃（墙 / 山墙 / 12 段折线拱面），
 * 西墙双开高玻璃门（外开 105°）、西坡三扇从下沿撑起的天窗盖 + 铁杆，北段贴洋房的是砖墙。
 * 室内：春日泥土草坪微地形（碰撞高度场的节点表原样建网格）、碎石汀步、浅水石槽。
 * 全部尺寸读 src/pcg/courtyard.ts（CONSV / CONSV_DOOR / CONSV_VENT / SPRING / TROUGH / GRAVEL_PATHS）。
 * 静态件进全院共用的 Batch；玻璃用小花房同一个材质；地形网格单独一次绘制。
 */
import { BoxGeometry, BufferAttribute, BufferGeometry, Matrix4, Mesh } from 'three';
import { CONSV, CONSV_DOOR, CONSV_VENT, GRAVEL_PATHS, PATH_HALF, TROUGH, consDoorLeaf, consRoofNodeX, consRoofY, consVentLid, samplePath } from '../pcg/courtyard';
import type { Heightfield } from '../sim/heightfield';
import { Batch, type BatchOptions } from './batch';
import { paneHash } from './glass';
import type { CourtyardMaterials } from './materials';

type V3 = [number, number, number];
type Mat = CourtyardMaterials[keyof CourtyardMaterials];

export interface ConservatoryBuild {
  /** 春日微地形网格（和碰撞高度场同一张节点表）。 */
  springGround: Mesh;
}

export function buildConservatory(m: CourtyardMaterials, batch: Batch, glass: Mat, field: Heightfield, paneStart: number): ConservatoryBuild {
  const c = CONSV;
  const { x0, x1, z0, z1, yFloor, yLowWall, yEave, yRidge, wallT, postT } = c;
  let paneIndex = paneStart;
  const nc = { cast: false } as const;
  const frame = m.enamelWarm;

  /** 一块玻璃：a→b 沿 u，b→c 沿 v；size = (u 长, v 长)；face 0 墙 / 1 屋面。 */
  const pane = (a: V3, b: V3, c2: V3, d: V3, size: [number, number], face: number): void => {
    batch.quad('glass', glass, a, b, c2, d, { attrs: { aSize: [size[0], size[1]], aPane: [paneHash(paneIndex++)], aFace: [face] }, cast: false, receive: false });
  };
  const paneAxes = (o: V3, u: V3, v: V3, su: number, sv: number, face = 0): void => {
    const p = (fu: number, fv: number): V3 => [o[0] + u[0] * su * fu + v[0] * sv * fv, o[1] + u[1] * su * fu + v[1] * sv * fv, o[2] + u[2] * su * fu + v[2] * sv * fv];
    pane(p(0, 0), p(1, 0), p(1, 1), p(0, 1), [su, sv], face);
  };
  /** 沿 x 方向斜放的矩形料（拱架的每一肢）：从 (xA, yA) 到 (xB, yB)，在 z 处，截面 w（z 向）× h（法向厚）。 */
  const slopedX = (key: string, mat: Mat, z: number, xA: number, yA: number, xB: number, yB: number, w: number, h: number, opts: BatchOptions = {}): void => {
    const dx = xB - xA;
    const dy = yB - yA;
    const len = Math.hypot(dx, dy);
    const mtx = new Matrix4().makeRotationZ(Math.atan2(dy, dx));
    // 板的顶面贴着拱面：沿法线往下挪 h/2
    const nx = -dy / len;
    const ny = dx / len;
    const sgn = ny > 0 ? 1 : -1;
    mtx.setPosition((xA + xB) / 2 + nx * sgn * (h / 2 + 1), (yA + yB) / 2 + ny * sgn * (h / 2 + 1), z);
    batch.geo(key, mat, new BoxGeometry(len, h, w), mtx, opts);
  };

  // ── 矮墙：灰色石砌 + 石压顶 + 顶上薄雪；西墙北段贴洋房的是砖墙 ──
  const lowWall = (ax0: number, az0: number, ax1: number, az1: number, brick = false): void => {
    batch.box(brick ? 'brick' : 'ashlar', brick ? m.brick : m.ashlar, [ax0, yFloor - 30, az0], [ax1, yLowWall, az1]);
    // 压顶石板：和墙身同一块砌石材质（m.stone 是冬景的落石材质，朝上的面会自动铺雪 + 白色盐析斑点，温室里不能用）
    batch.box('ashlar', m.ashlar, [ax0 - 2, yLowWall, az0 - 2], [ax1 + 2, yLowWall + 4, az1 + 2], nc);
  };
  lowWall(x0, z0, x0 + wallT, -560, true);
  lowWall(x0, -420, x0 + wallT, CONSV_DOOR.z0 - 6);
  lowWall(x0, CONSV_DOOR.z1 + 6, x0 + wallT, z1);
  lowWall(x1 - wallT, z0, x1, z1);
  lowWall(x0, z0, x1, z0 + wallT);
  lowWall(x0, z1 - wallT, x1, z1);
  // 拱门段（z −540..−420）没有矮墙，只有石门槛（小花房那边画了石阶）
  batch.box('ashlar', m.ashlar, [x0, yFloor - 30, -540], [x0 + wallT, yFloor - 2, -420], nc);

  // ── 铸铁柱：西 / 东墙柱列、端墙柱列、门框柱 ──
  const post = (px: number, pz: number, w = postT): void => batch.box('enamel', frame, [px - w / 2, yLowWall, pz - w / 2], [px + w / 2, yEave, pz + w / 2]);
  for (const pz of c.postsWestZ) post(x0 + wallT / 2, pz);
  for (const pz of c.postsEastZ) post(x1 - wallT / 2, pz);
  for (const px of c.postsEndX) {
    post(px, z0 + wallT / 2);
    post(px, z1 - wallT / 2);
  }
  for (const dz of [CONSV_DOOR.z0 - 6, CONSV_DOOR.z1]) batch.box('enamel', frame, [x0 - 2, yFloor, dz], [x0 + wallT + 2, yEave, dz + 6]);
  // 柱头小托 / 柱础（方形小块）
  for (const pz of c.postsWestZ) {
    batch.box('enamel', frame, [x0 - 1, yLowWall, pz - 7], [x0 + wallT + 1, yLowWall + 8, pz + 7], nc);
    batch.box('enamel', frame, [x0 - 1, yEave - 20, pz - 7], [x0 + wallT + 1, yEave - 12, pz + 7], nc);
  }
  for (const pz of c.postsEastZ) {
    batch.box('enamel', frame, [x1 - wallT - 1, yLowWall, pz - 7], [x1 + 1, yLowWall + 8, pz + 7], nc);
    batch.box('enamel', frame, [x1 - wallT - 1, yEave - 20, pz - 7], [x1 + 1, yEave - 12, pz + 7], nc);
  }

  // ── 檐梁（四边）+ 脊梁 + 每开间的折线拱架 + 檩条 + 拉杆 ──
  batch.box('enamel', frame, [x0 - 2, yEave - 12, z0 - 2], [x1 + 2, yEave, z0 + 14]);
  batch.box('enamel', frame, [x0 - 2, yEave - 12, z1 - 14], [x1 + 2, yEave, z1 + 2]);
  batch.box('enamel', frame, [x0 - 2, yEave - 12, z0], [x0 + 14, yEave, z1]);
  batch.box('enamel', frame, [x1 - 14, yEave - 12, z0], [x1 + 2, yEave, z1]);
  batch.box('enamel', frame, [c.xRidge - 7, yRidge - 16, z0], [c.xRidge + 7, yRidge, z1]);
  for (let pz = z0; pz <= z1; pz += c.bayZ) {
    for (let k = 0; k < c.archSegs; k++) {
      const xa = consRoofNodeX(k);
      const xb = consRoofNodeX(k + 1);
      // 西坡；东坡镜像
      slopedX('enamel', frame, pz, xa, consRoofY(xa), xb, consRoofY(xb), 8, 10);
      slopedX('enamel', frame, pz, c.xRidge + (c.xRidge - xa), consRoofY(xa), c.xRidge + (c.xRidge - xb), consRoofY(xb), 8, 10);
    }
    // 脊上的小尖顶装饰（每一榅）
    batch.cyl('enamel', frame, c.xRidge, yRidge + 6, pz, 4, 14, 6, 0, 0, nc);
  }
  for (let k = 1; k < c.archSegs; k++) {
    for (const side of [-1, 1] as const) {
      const nw = consRoofNodeX(k);
      const px = side < 0 ? nw : c.xRidge + (c.xRidge - nw);
      const v = CONSV_VENT;
      // 西坡天窗那一段的檩条只在天窗两端之外有（中间是 curb）
      if (side < 0 && Math.abs(nw - v.x0) < 3) {
        batch.box('enamel', frame, [px - 3, consRoofY(px) - 8, z0], [px + 3, consRoofY(px), v.z0 - 8], nc);
        batch.box('enamel', frame, [px - 3, consRoofY(px) - 8, v.z1 + 8], [px + 3, consRoofY(px), z1], nc);
      } else if (side < 0 && Math.abs(nw - v.x1) < 3) {
        batch.box('enamel', frame, [px - 3, consRoofY(px) - 8, z0], [px + 3, consRoofY(px), v.z0 - 8], nc);
        batch.box('enamel', frame, [px - 3, consRoofY(px) - 8, v.z1 + 8], [px + 3, consRoofY(px), z1], nc);
      } else batch.box('enamel', frame, [px - 3, consRoofY(px) - 8, z0], [px + 3, consRoofY(px), z1], nc);
    }
  }
  // 拉杆：每开间一根细杆，和骨架同色的白珐琅（深色铁杆在玻璃后面会变成一道道黑线）
  for (let pz = z0 + c.bayZ; pz < z1 - 10; pz += c.bayZ) batch.tube('enamel', m.enamel, [x0 + 20, yEave - 6, pz], [x1 - 20, yEave - 6, pz], 1.4, 6, nc);

  // ── 墙玻璃：西墙（拱门 / 门洞上方留亮子）、东墙、端墙（矩形到檐口）──
  const rowSplit = 120;
  const westSpans: [number, number][] = [
    [-560, -540 - 6],
    [-420 + 6, CONSV_DOOR.z0 - 6],
    [CONSV_DOOR.z1 + 6, z1],
  ];
  const xg = x0 + 5;
  for (const [za, zb] of westSpans) {
    for (const [ya, yb] of [
      [yLowWall, rowSplit],
      [rowSplit, yEave],
    ] as const) paneAxes([xg, ya + 2, za], [0, 0, 1], [0, 1, 0], zb - za, yb - ya - 4);
  }
  // 拱门 / 门洞上方的亮子（和拱门 / 门框顶齐）
  paneAxes([xg, 104, -540], [0, 0, 1], [0, 1, 0], 120, yEave - 106);
  paneAxes([xg, CONSV_DOOR.y1 + 8, CONSV_DOOR.z0], [0, 0, 1], [0, 1, 0], CONSV_DOOR.z1 - CONSV_DOOR.z0, yEave - CONSV_DOOR.y1 - 10);
  for (const [ya, yb] of [
    [yLowWall, rowSplit],
    [rowSplit, yEave],
  ] as const) paneAxes([x1 - 5 - 2, ya + 2, z0 + 3], [0, 0, 1], [0, 1, 0], z1 - z0 - 6, yb - ya - 4);
  for (const gz of [z0 + 7, z1 - 9]) {
    for (const [ya, yb] of [
      [yLowWall, rowSplit],
      [rowSplit, yEave],
    ] as const) paneAxes([x0 + 3, ya + 2, gz], [1, 0, 0], [0, 1, 0], x1 - x0 - 6, yb - ya - 4);
    // 端墙上的折线拱：每一段一个梯形（从檐口到拱面），再加放射状的铸铁肋
    for (let k = 0; k < c.archSegs; k++) {
      const xa = consRoofNodeX(k);
      const xb = consRoofNodeX(k + 1);
      const ya = consRoofY(xa);
      const yb = consRoofY(xb);
      pane([xa, yEave + 1, gz], [xb, yEave + 1, gz], [xb, yb - 2, gz], [xa, ya - 2, gz], [xb - xa, ya - yEave], 0);
      const xm = c.xRidge + (c.xRidge - xa);
      const xn = c.xRidge + (c.xRidge - xb);
      pane([xm, yEave + 1, gz], [xn, yEave + 1, gz], [xn, yb - 2, gz], [xm, ya - 2, gz], [xn - xm, ya - yEave], 0);
      // 放射肋：从檐口 / 节点朝脊方向的斜杆（每一榅两根）
      if (k % 2 === 1) {
        batch.box('enamel', frame, [xa - 2, yEave, gz - 2], [xa + 2, ya - 2, gz + 2], nc);
        batch.box('enamel', frame, [xm - 2, yEave, gz - 2], [xm + 2, ya - 2, gz + 2], nc);
      }
    }
  }

  // ── 拱面玻璃：每段每开间一块；天窗那一段（西坡 k=4）按 z 分两截 ──
  const v = CONSV_VENT;
  for (let k = 0; k < c.archSegs; k++) {
    const xa = consRoofNodeX(k);
    const xb = consRoofNodeX(k + 1);
    const ya = consRoofY(xa) + 1;
    const yb = consRoofY(xb) + 1;
    const len = Math.hypot(xb - xa, yb - ya);
    for (const side of [-1, 1] as const) {
      const xA = side < 0 ? xa : c.xRidge + (c.xRidge - xa);
      const xB = side < 0 ? xb : c.xRidge + (c.xRidge - xb);
      const isVent = side < 0 && Math.abs(xa - v.x0) < 3;
      const zSpans: [number, number][] = isVent ? [
        [z0, v.z0],
        [v.z1, z1],
      ] : [[z0, z1]];
      for (const [za, zb] of zSpans) {
        // 按开间切
        for (let pz = za; pz < zb - 1; pz += c.bayZ) {
          const q = Math.min(zb, pz + c.bayZ);
          pane([xA, ya, pz + 2], [xB, yb, pz + 2], [xB, yb, q - 2], [xA, ya, q - 2], [q - pz - 4, len], 1);
        }
      }
    }
  }

  // ── 天窗：两侧 + 两端的 curb（铸铁），三扇盖子从下沿撑起（框 + 玻璃 + 自由边横杆），铁杆撑着 ──
  for (const cx of [v.x0 - 8, v.x1]) batch.box('enamel', frame, [cx, consRoofY(cx + 4) - 6, v.z0 - 8], [cx + 8, consRoofY(cx + 4) + v.curbH, v.z1 + 8]);
  batch.box('enamel', frame, [v.x0 - 8, consRoofY(v.x0) - 6, v.z0 - 8], [v.x1 + 8, consRoofY(v.x1) + v.curbH, v.z0]);
  batch.box('enamel', frame, [v.x0 - 8, consRoofY(v.x0) - 6, v.z1], [v.x1 + 8, consRoofY(v.x1) + v.curbH, v.z1 + 8]);
  for (let i = 0; i < v.lids; i++) {
    const lid = consVentLid(i);
    const a = Math.atan2(lid.dir[1], lid.dir[0]);
    const n: V3 = [-Math.sin(a), Math.cos(a), 0];
    const local = (yOff: number, sOff: number): Matrix4 => {
      const mtx = new Matrix4().makeRotationZ(a);
      mtx.setPosition(lid.hinge[0] + lid.dir[0] * sOff + n[0] * yOff, lid.hinge[1] + lid.dir[1] * sOff + n[1] * yOff, lid.hinge[2]);
      return mtx;
    };
    const add = (g: BoxGeometry, yOff: number, sOff: number, key: string, mat: Mat, opts: BatchOptions = {}): void => batch.geo(key, mat, g, local(yOff, sOff), opts);
    const mk = (l: number, h: number, w: number, x: number, z: number): BoxGeometry => {
      const g = new BoxGeometry(l, h, w);
      g.translate(x, 0, z);
      return g;
    };
    const L = lid.len;
    const W = lid.z1 - lid.z0;
    add(mk(L, 4, 5, L / 2, 2.5), 0, 0, 'enamel', frame);
    add(mk(L, 4, 5, L / 2, W - 2.5), 0, 0, 'enamel', frame);
    add(mk(5, 4, W, 2.5, W / 2), 0, 0, 'enamel', frame);
    add(mk(5, 4, W, L - 2.5, W / 2), 0, 0, 'enamel', frame);
    add(mk(3, 3, W, L / 2, W / 2), 0, 0, 'enamel', frame);
    add(mk(L - 10, 1.2, W - 10, L / 2, W / 2), 0, 0, 'glass', glass, { ...nc, attrs: { aSize: [L - 10, W - 10], aPane: [paneHash(paneIndex++)], aFace: [1] }, edgeFromUv: true });
    // 自由边横杆（栖木）和撑杆
    batch.cyl('enamel', frame, lid.free[0], lid.free[1] + 2.5, (lid.z0 + lid.z1) / 2, 1.6, W - 4, 7, Math.PI / 2, 0, nc);
    batch.tube('metal', m.metal, [v.x1 + 2, consRoofY(v.x1) + v.curbH, (lid.z0 + lid.z1) / 2], [lid.free[0] - 1, lid.free[1] - 1, (lid.z0 + lid.z1) / 2], 0.6, 6, nc);
  }

  // ── 西墙双开高玻璃门（外开 105°）：铸铁门框 + 上下两块玻璃 + 把手；门外两级石阶 ──
  for (const i of [0, 1] as const) {
    const leaf = consDoorLeaf(i);
    const a = Math.atan2(leaf.dir[0], leaf.dir[2]);
    const mtx = new Matrix4().makeRotationY(a);
    mtx.setPosition(leaf.hinge[0], 0, leaf.hinge[2]);
    const L = leaf.len;
    const H = CONSV_DOOR.y1 - yFloor;
    const mk = (w: number, h: number, d: number, x: number, y: number, z: number, key: string, mat: Mat, attrs?: Record<string, number[]>): void => {
      const g = new BoxGeometry(w, h, d);
      g.translate(x, yFloor + y + h / 2, z + w / 2);
      batch.geo(key, mat, g, mtx, { cast: true, attrs, edgeFromUv: key === 'glass' });
    };
    // 门扇局部：z 从铰链沿门扇长，x 是厚度方向
    mk(4.5, H, 7, 0, 0, 0, 'enamel', frame);
    mk(4.5, H, 7, 0, 0, L - 7, 'enamel', frame);
    mk(4.5, 14, L, 0, 0, 0, 'enamel', frame);
    mk(4.5, 7, L, 0, H - 7, 0, 'enamel', frame);
    mk(4.5, 6, L, 0, H * 0.46, 0, 'enamel', frame);
    mk(1.2, H * 0.46 - 20, L - 14, 0, 14, 7, 'glass', glass, { aSize: [L - 14, H * 0.46 - 20], aPane: [paneHash(paneIndex++)], aFace: [0] });
    mk(1.2, H - 7 - (H * 0.46 + 6) - 5, L - 14, 0, H * 0.46 + 6, 7, 'glass', glass, { aSize: [L - 14, H - 7 - (H * 0.46 + 6) - 5], aPane: [paneHash(paneIndex++)], aFace: [0] });
    mk(3, 22, 3, 0, H * 0.42, L - 16, 'metal', m.metal);
  }
  batch.box('ashlarOut', m.ashlarOut, [318, yFloor - 26, CONSV_DOOR.z0 - 4], [342, -115, CONSV_DOOR.z1 + 4]);
  batch.box('ashlarOut', m.ashlarOut, [338, yFloor - 26, CONSV_DOOR.z0 - 4], [x0, yFloor, CONSV_DOOR.z1 + 4]);
  batch.box('snow', m.snow, [316, -115, CONSV_DOOR.z0 - 4], [340, -112, CONSV_DOOR.z1 + 4], { cast: false, receive: false });

  // ── 浅水石槽：四壁 + 底 + 水面 + 压顶 ──
  const t = TROUGH;
  const ty = t.base + t.h;
  for (const [ax0, az0, ax1, az1] of [
    [t.x0, t.z0, t.x1, t.z0 + 10],
    [t.x0, t.z1 - 10, t.x1, t.z1],
    [t.x0, t.z0, t.x0 + 10, t.z1],
    [t.x1 - 10, t.z0, t.x1, t.z1],
  ] as const) batch.box('ashlar', m.ashlar, [ax0, t.base, az0], [ax1, ty, az1]);
  batch.box('ashlar', m.ashlar, [t.x0, t.base, t.z0], [t.x1, t.base + 6, t.z1]);
  batch.quad('water', m.water, [t.x0 + 10, t.base + t.water, t.z0 + 10], [t.x0 + 10, t.base + t.water, t.z1 - 10], [t.x1 - 10, t.base + t.water, t.z1 - 10], [t.x1 - 10, t.base + t.water, t.z0 + 10], { cast: false, receive: false, edge: false });
  for (const [ax0, az0, ax1, az1] of [
    [t.x0 - 3, t.z0 - 3, t.x1 + 3, t.z0 + 12],
    [t.x0 - 3, t.z1 - 12, t.x1 + 3, t.z1 + 3],
    [t.x0 - 3, t.z0, t.x0 + 12, t.z1],
    [t.x1 - 12, t.z0, t.x1 + 3, t.z1],
  ] as const) batch.box('stone', m.stone, [ax0, ty, az0], [ax1, ty + 4, az1], nc);

  // ── 鹅卵石碎石小径 + 嵌入式青石板：贴着地形的带状网格（横断面找平、只高出地面 1.6 cm），面数全在片元里 ──
  const half = PATH_HALF;
  {
    const pos: number[] = [];
    const nor: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    // 地形法线（高度场中心差分）：小径面跟着坡面受光
    const groundN = (x: number, z: number): V3 => {
      const e = 12;
      const dx = (field.heightAt(x + e, z) - field.heightAt(x, z)) / e;
      const dz = (field.heightAt(x, z + e) - field.heightAt(x, z)) / e;
      const L = Math.hypot(dx, 1, dz);
      return [-dx / L, 1 / L, -dz / L];
    };
    let base = 0;
    for (const path of GRAVEL_PATHS) {
      const smp = samplePath(path, 20);
      let along = 0;
      // 横断面 4 个顶点全部贴着地形抬 1.6 cm（土丘上按"找平"铺会在中间被地形顶穿）
      const LATS = [-1, -0.34, 0.34, 1];
      for (const [i, s] of smp.entries()) {
        const lx = -s.tz;
        const lz = s.tx;
        if (i > 0) along += Math.hypot(s.x - smp[i - 1].x, s.z - smp[i - 1].z);
        const n = groundN(s.x, s.z);
        for (const k of LATS) {
          const px = s.x + lx * half * k;
          const pz = s.z + lz * half * k;
          pos.push(px, field.heightAt(px, pz) + 1.6, pz);
          nor.push(n[0], n[1], n[2]);
          uv.push((k + 1) / 2, along / 100);
        }
        if (i > 0) {
          const a = base + (i - 1) * 4;
          for (let c = 0; c < 3; c++) idx.push(a + c, a + c + 1, a + c + 4, a + c + 1, a + c + 5, a + c + 4);
        }
      }
      base += smp.length * 4;
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(nor), 3));
    g.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
    g.setIndex(idx);
    batch.add('path', m.path, g, undefined, { cast: false });
  }
  // ── 赤陶路缘砖：小径两侧各一排（20 × 7 × 10，砖顶高出路面 3 cm），矮墙内沿也砌一圈（门口 / 拱门留口）──
  const brick = (cx: number, cz: number, ang: number): void => {
    const geo = new BoxGeometry(20, 7, 10);
    geo.rotateY(ang);
    geo.translate(cx, field.heightAt(cx, cz) + 1.5, cz);
    batch.add('edging', m.edging, geo, undefined, { cast: false });
  };
  for (const path of GRAVEL_PATHS) {
    for (const s of samplePath(path, 20)) {
      // 砖的长轴顺着切向：rotateY(θ) 把局部 x 转到 (cos θ, −sin θ)，取 θ = atan2(−tz, tx)
      const ang = Math.atan2(-s.tz, s.tx);
      brick(s.x - s.tz * (half + 5), s.z + s.tx * (half + 5), ang);
      brick(s.x + s.tz * (half + 5), s.z - s.tx * (half + 5), ang);
    }
  }
  const off = 6;
  for (let z = z0 + wallT + off + 10; z < z1 - wallT - 10; z += 20) {
    const inDoor = z > CONSV_DOOR.z0 - 14 && z < CONSV_DOOR.z1 + 14;
    const inArch = z > -554 && z < -406;
    if (!inDoor && !inArch) brick(x0 + wallT + off, z, -Math.PI / 2);
    brick(x1 - wallT - off, z, -Math.PI / 2);
  }
  for (let x = x0 + wallT + off + 10; x < x1 - wallT - 10; x += 20) {
    brick(x, z0 + wallT + off, 0);
    brick(x, z1 - wallT - off, 0);
  }

  // ── 春日微地形网格：碰撞高度场的节点表原样建（严格对齐）──
  const w = field.nx + 1;
  const pos = new Float32Array(w * (field.nz + 1) * 3);
  for (let iz = 0; iz <= field.nz; iz++) {
    for (let ix = 0; ix <= field.nx; ix++) {
      const k = iz * w + ix;
      pos[k * 3] = field.x0 + ix * field.cell;
      pos[k * 3 + 1] = field.heights[k];
      pos[k * 3 + 2] = field.z0 + iz * field.cell;
    }
  }
  const idx: number[] = [];
  for (let iz = 0; iz < field.nz; iz++) {
    for (let ix = 0; ix < field.nx; ix++) {
      const a = iz * w + ix;
      idx.push(a, a + w, a + 1, a + 1, a + w, a + w + 1);
    }
  }
  const groundGeo = new BufferGeometry();
  groundGeo.setAttribute('position', new BufferAttribute(pos, 3));
  groundGeo.setIndex(idx);
  groundGeo.computeVertexNormals();
  const springGround = new Mesh(groundGeo, m.springGround);
  springGround.name = 'spring-ground';
  springGround.receiveShadow = true;
  return { springGround };
}
