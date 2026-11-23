/**
 * 三层北海道风小洋房（视觉层）：浅暖米白拉毛外墙、深胡桃木窗框 / 门、带厚实雪被的双坡屋顶、红砖烟囱、
 * 二楼挑出木阳台 + 防雪雨棚、三楼小露台铁艺护栏、窗下木花箱、外挂空调机、檐沟。
 * 全部尺寸读 src/pcg/courtyard.ts（HOUSE / WINDOWS / BALCONY / …），和碰撞盒一字不差。
 * 同类材质全部合批：墙体 1、木作 2、玻璃 1、雪 1、砖 1、金属 1、发光 1。
 */
import { BoxGeometry, BufferGeometry, ConeGeometry, Float32BufferAttribute, Matrix4, Vector3 } from 'three';
import {
  AC_UNIT,
  GH,
  AWNING_SNOW,
  ROOF_SNOW,
  PORCH_SNOW,
  AWNING,
  BALCONY,
  BALCONY_DOOR,
  CHIMNEY,
  HOUSE,
  HOUSE_DOOR,
  PORCH,
  TERRACE,
  TERRACE_DOOR,
  WINDOWS,
  houseRoofY,
  type WindowSpec,
} from '../pcg/courtyard';
import { Batch, type BatchOptions } from './batch';
import { makeRng } from '../util/math';
import type { CourtyardMaterials } from './materials';

type Face = WindowSpec['face'];
type Mat = CourtyardMaterials[keyof CourtyardMaterials];

/** 墙面上的局部坐标 → 世界轴对齐盒：u 沿墙、y 高、w 向外（0 = 墙面）。 */
function faceBox(face: Face, u0: number, u1: number, y0: number, y1: number, w0: number, w1: number): { min: number[]; max: number[] } {
  if (face === 'south') return { min: [u0, y0, HOUSE.z1 + w0], max: [u1, y1, HOUSE.z1 + w1] };
  if (face === 'north') return { min: [u0, y0, HOUSE.z0 - w1], max: [u1, y1, HOUSE.z0 - w0] };
  if (face === 'west') return { min: [HOUSE.x0 - w1, y0, u0], max: [HOUSE.x0 - w0, y1, u1] };
  return { min: [HOUSE.x1 + w0, y0, u0], max: [HOUSE.x1 + w1, y1, u1] };
}

/** 墙面上 (u, y, w) → 世界点。 */
function facePoint(face: Face, u: number, y: number, w: number): [number, number, number] {
  const b = faceBox(face, u, u, y, y, w, w);
  return [b.min[0], b.min[1], b.min[2]];
}

function fbox(batch: Batch, key: string, mat: Mat, face: Face, u0: number, u1: number, y0: number, y1: number, w0: number, w1: number, opts: BatchOptions = {}): void {
  const b = faceBox(face, u0, u1, y0, y1, w0, w1);
  batch.box(key, mat, b.min, b.max, opts);
}

/** 每扇窗的反光相位（确定性）。 */
function windowPhase(u: number, y: number): number {
  const v = Math.sin(u * 0.37 + y * 0.11) * 43758.5453;
  return v - Math.floor(v);
}

/** 窗洞在墙面上的 u 范围。 */
function windowU(w: WindowSpec): [number, number] {
  return w.face === 'south' || w.face === 'north' ? [w.x0, w.x1] : [w.z0 ?? 0, w.z1 ?? 0];
}

/** 山墙三角（两端）：三棱柱，sign = +1 朝 +X 外（东山墙）、−1 朝 −X 外（西山墙）。 */
function gableGeometry(xFace: number, sign: 1 | -1): BufferGeometry {
  const zS = HOUSE.z1;
  const zN = HOUSE.z0;
  const y0 = HOUSE.yEave - 2;
  const y1 = HOUSE.yRidge + 2;
  const zR = HOUSE.zRidge;
  const xa = xFace;
  const xb = xFace + sign * 10;
  //        A0 B0 A1 B1 A2 B2
  const v = [
    [xa, y0, zS], [xb, y0, zS], [xa, y0, zN], [xb, y0, zN], [xa, y1, zR], [xb, y1, zR],
  ];
  const tri = [
    [1, 3, 5], [0, 5, 2], // 外面 / 内面
    [0, 3, 1], [0, 2, 3], // 底
    [0, 1, 5], [0, 5, 4], // 南斜面
    [2, 3, 5], [2, 5, 4], // 北斜面
  ];
  const idx: number[] = [];
  for (const t of tri) {
    if (sign > 0) idx.push(t[0], t[1], t[2]);
    else idx.push(t[0], t[2], t[1]);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(v.flat(), 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * 斜板（屋面 / 雨棚）：沿 z 从 (zA, yA) 到 (zB, yB)，厚 thick，x 范围 [x0, x1]；offset = 板底离板面的距离（沿法线）。
 * cell > 0 = 顶 / 底面按 cell cm 一格细分（雪被：雪印的顶点下压要落在细分的顶点上；碰撞体那边 readSlab 同一套数学）。
 */
function slab(batch: Batch, key: string, mat: Mat, x0: number, x1: number, zA: number, yA: number, zB: number, yB: number, thick: number, offset = 0, opts: BatchOptions = {}, cell = 0): void {
  const dz = zB - zA;
  const dy = yB - yA;
  const len = Math.hypot(dz, dy);
  const ang = Math.atan2(dy, dz);
  const geo = cell > 0 ? new BoxGeometry(x1 - x0, thick, len, Math.max(1, Math.ceil((x1 - x0) / cell)), 1, Math.max(1, Math.ceil(len / cell))) : new BoxGeometry(x1 - x0, thick, len);
  const n = new Vector3(0, -dz, dy).normalize();
  if (n.y < 0) n.negate();
  const m = new Matrix4();
  const off = n.multiplyScalar(offset + thick / 2);
  m.makeRotationX(-ang);
  m.setPosition((x0 + x1) / 2 + off.x, (yA + yB) / 2 + off.y, (zA + zB) / 2 + off.z);
  batch.add(key, mat, geo, m, opts);
}

/** 带窗的墙洞：窗框 + 竖横梃 + 玻璃（aLit）+ 带雪的窗台 + 窗下木花箱。 */
function addWindow(batch: Batch, m: CourtyardMaterials, w: WindowSpec): void {
  const [u0, u1] = windowU(w);
  const f = 8;
  const o = { cast: false } as const;
  fbox(batch, 'walnut', m.walnut, w.face, u0, u0 + f, w.y0, w.y1, -6, 5, o);
  fbox(batch, 'walnut', m.walnut, w.face, u1 - f, u1, w.y0, w.y1, -6, 5, o);
  fbox(batch, 'walnut', m.walnut, w.face, u0, u1, w.y1 - f, w.y1, -6, 5, o);
  fbox(batch, 'walnut', m.walnut, w.face, u0, u1, w.y0, w.y0 + f, -6, 5, o);
  for (let i = 1; i < w.cols; i++) {
    const u = u0 + ((u1 - u0) * i) / w.cols;
    fbox(batch, 'walnut', m.walnut, w.face, u - 1.6, u + 1.6, w.y0, w.y1, -4, 2, o);
  }
  for (let j = 1; j < w.rows; j++) {
    const y = w.y0 + ((w.y1 - w.y0) * j) / w.rows;
    fbox(batch, 'walnut', m.walnut, w.face, u0, u1, y - 1.6, y + 1.6, -4, 2, o);
  }
  // 玻璃：一整片，贴在墙面外 0.8 cm、窗棂内侧（窗棂凸出墙面 5 cm，玻璃四周留出 4 cm 深的窗洞内凹；原来放在 w = −2
  // 被整面实心外墙埋住，全楼的窗都看不见玻璃）。aWin = 窗根 / 窗顶 / 每扇窗的反光相位
  batch.quad(
    'window-glass',
    m.windowGlass,
    facePoint(w.face, u0 + 2, w.y0 + 2, 0.8),
    facePoint(w.face, u1 - 2, w.y0 + 2, 0.8),
    facePoint(w.face, u1 - 2, w.y1 - 2, 0.8),
    facePoint(w.face, u0 + 2, w.y1 - 2, 0.8),
    { attrs: { aLit: [w.lit], aWin: [w.y0, w.y1, windowPhase(u0, w.y0)] }, cast: false, receive: false, edge: false },
  );
  // 窗台：木挑板 + 薄雪
  fbox(batch, 'cedar', m.cedar, w.face, u0 - 6, u1 + 6, w.y0 - 6, w.y0, -4, 12, o);
  fbox(batch, 'snow', m.snow, w.face, u0 - 5, u1 + 5, w.y0, w.y0 + 3.5, 0, 11, { cast: false, receive: false });
  // 窗下木花箱（带雪）
  if (w.box && w.face === 'south') {
    fbox(batch, 'pine', m.pine, w.face, u0 - 4, u1 + 4, w.y0 - 24, w.y0 - 2, 0, 24, {});
    fbox(batch, 'snow', m.snow, w.face, u0 - 3, u1 + 3, w.y0 - 4, w.y0 + 1, 1, 23, { cast: false, receive: false });
  }
}

/** 门（洋房正门）：深胡桃木门扇 + 上亮子 + 门廊小雨棚（雪）+ 两侧木托架 + 壁灯 + 门阶石。 */
function addHouseDoor(batch: Batch, m: CourtyardMaterials): void {
  const d = HOUSE_DOOR;
  const o = { cast: false } as const;
  fbox(batch, 'walnut', m.walnut, 'south', d.x0 - 8, d.x0, d.y0, d.y1 + 8, -6, 5, o);
  fbox(batch, 'walnut', m.walnut, 'south', d.x1, d.x1 + 8, d.y0, d.y1 + 8, -6, 5, o);
  fbox(batch, 'walnut', m.walnut, 'south', d.x0 - 8, d.x1 + 8, d.y1, d.y1 + 8, -6, 5, o);
  fbox(batch, 'walnut', m.walnut, 'south', d.x0, d.x1, d.y0, d.y1 - 30, -3, 3, o);
  // 四格凹板（颜色更深一档的同一木料，凸出 1.5 cm 形成线脚）
  const w = (d.x1 - d.x0) * 0.34;
  const h = (d.y1 - 30 - d.y0) * 0.28;
  for (const [px, py] of [
    [0.27, 0.28],
    [0.73, 0.28],
    [0.27, 0.68],
    [0.73, 0.68],
  ] as const) {
    const cx = d.x0 + (d.x1 - d.x0) * px;
    const cy = d.y0 + (d.y1 - 30 - d.y0) * py;
    fbox(batch, 'walnut', m.walnut, 'south', cx - w / 2, cx + w / 2, cy - h / 2, cy + h / 2, 3, 4.5, o);
  }
  // 把手
  batch.cyl('metal', m.metal, d.x1 - 12, 10, HOUSE.z1 + 5, 2.2, 8, 8, Math.PI / 2, 0, o);
  batch.quad(
    'window-glass',
    m.windowGlass,
    facePoint('south', d.x0 + 2, d.y1 - 28, 0.8),
    facePoint('south', d.x1 - 2, d.y1 - 28, 0.8),
    facePoint('south', d.x1 - 2, d.y1 - 2, 0.8),
    facePoint('south', d.x0 + 2, d.y1 - 2, 0.8),
    { attrs: { aLit: [0.85], aWin: [d.y1 - 28, d.y1, 0.31] }, cast: false, receive: false, edge: false },
  );
  // 门廊雨棚：斜板（cedar 底 + 雪）+ 托架
  slab(batch, 'cedar', m.cedar, PORCH.x0, PORCH.x1, PORCH.zOut, PORCH.yOut, PORCH.zWall, PORCH.yWall, PORCH.thick, 0);
  // 雪被尺寸读 PORCH_SNOW（碰撞体的落脚面 = 这块雪板的顶面线）；顶面按 30 cm 一格细分（雪印顶点下压）
  slab(batch, 'snow', m.snow, PORCH.x0, PORCH.x1, PORCH.zOut, PORCH.yOut, PORCH.zWall, PORCH.yWall, PORCH_SNOW.thick, PORCH_SNOW.offset, { cast: true }, 30);
  batch.cyl('snow', m.snow, (PORCH.x0 + PORCH.x1) / 2, PORCH.yOut + PORCH.thick + PORCH_SNOW.rollDrop, PORCH.zOut - PORCH_SNOW.rollInset, PORCH_SNOW.rollR, PORCH.x1 - PORCH.x0 + 6, 10, 0, Math.PI / 2, { cast: true });
  for (const px of [PORCH.x0 + 10, PORCH.x1 - 10]) batch.tube('cedar', m.cedar, [px, PORCH.yWall - 50, PORCH.zWall], [px, PORCH.yOut + 2, PORCH.zOut + 6], 3, 6);
  // 门阶石（两级）+ 壁灯
  const y0 = HOUSE.floors[0];
  batch.box('ashlarOut', m.ashlarOut, [d.x0 - 10, y0 - 2, PORCH.zWall], [d.x1 + 10, y0 + 14, PORCH.zWall + 50], o);
  batch.box('ashlarOut', m.ashlarOut, [d.x0 - 16, y0 - 2, PORCH.zWall + 50], [d.x1 + 16, y0 + 7, PORCH.zWall + 90], o);
  batch.box('snow', m.snow, [d.x0 - 14, y0 + 7, PORCH.zWall + 56], [d.x1 + 14, y0 + 11, PORCH.zWall + 88], { cast: false, receive: false });
  batch.box('metal', m.metal, [d.x1 + 16, 40, PORCH.zWall], [d.x1 + 22, 70, PORCH.zWall + 6], o);
  batch.box('glow', m.glow, [d.x1 + 15, 46, PORCH.zWall + 6], [d.x1 + 23, 64, PORCH.zWall + 14], { cast: false, receive: false });
}

/** 玻璃门（阳台门 / 露台门）：两扇对开木框玻璃门。 */
function addGlassDoor(batch: Batch, m: CourtyardMaterials, d: { x0: number; x1: number; y0: number; y1: number }, lit: number): void {
  const f = 7;
  const o = { cast: false } as const;
  fbox(batch, 'walnut', m.walnut, 'south', d.x0 - f, d.x0, d.y0, d.y1 + f, -6, 5, o);
  fbox(batch, 'walnut', m.walnut, 'south', d.x1, d.x1 + f, d.y0, d.y1 + f, -6, 5, o);
  fbox(batch, 'walnut', m.walnut, 'south', d.x0 - f, d.x1 + f, d.y1, d.y1 + f, -6, 5, o);
  const mid = (d.x0 + d.x1) / 2;
  fbox(batch, 'walnut', m.walnut, 'south', mid - 3, mid + 3, d.y0, d.y1, -4, 4, o);
  for (const [a, b] of [
    [d.x0, d.x0 + 5],
    [mid - 8, mid - 3],
    [mid + 3, mid + 8],
    [d.x1 - 5, d.x1],
  ] as const) fbox(batch, 'walnut', m.walnut, 'south', a, b, d.y0, d.y1, -4, 4, o);
  fbox(batch, 'walnut', m.walnut, 'south', d.x0, mid - 3, d.y0, d.y0 + 30, -4, 4, o);
  fbox(batch, 'walnut', m.walnut, 'south', mid + 3, d.x1, d.y0, d.y0 + 30, -4, 4, o);
  for (const y of [d.y0 + 30, d.y0 + (d.y1 - d.y0) * 0.55]) fbox(batch, 'walnut', m.walnut, 'south', d.x0, d.x1, y - 2, y + 2, -4, 4, o);
  batch.quad(
    'window-glass',
    m.windowGlass,
    facePoint('south', d.x0 + 2, d.y0 + 2, 0.8),
    facePoint('south', d.x1 - 2, d.y0 + 2, 0.8),
    facePoint('south', d.x1 - 2, d.y1 - 2, 0.8),
    facePoint('south', d.x0 + 2, d.y1 - 2, 0.8),
    { attrs: { aLit: [lit], aWin: [d.y0, d.y1, windowPhase(d.x0, d.y0)] }, cast: false, receive: false, edge: false },
  );
}

/** 二楼木阳台：楼板 + 松木台面 + 雪 + 三面栏杆（立柱 / 扶手 / 细栏）+ 雨棚 + 一串小彩灯。 */
function addBalcony(batch: Batch, m: CourtyardMaterials): void {
  const b = BALCONY;
  const nc = { cast: false } as const;
  batch.box('cedar', m.cedar, [b.x0, b.yFloor - b.slabT, HOUSE.z1], [b.x1, b.yFloor - 2, b.z1]);
  batch.box('pine', m.pine, [b.x0 + 2, b.yFloor - 2, HOUSE.z1], [b.x1 - 2, b.yFloor, b.z1 - 2], nc);
  batch.box('snow', m.snow, [b.x0 + 6, b.yFloor, HOUSE.z1 + 40], [b.x1 - 6, b.yFloor + 4, b.z1 - 8], { cast: false, receive: false });
  const postT = 9;
  for (const [px, pz] of [
    [b.x0 + postT / 2, b.z1 - postT / 2],
    [b.x1 - postT / 2, b.z1 - postT / 2],
    [b.x0 + postT / 2, HOUSE.z1 + 20],
    [b.x1 - postT / 2, HOUSE.z1 + 20],
    [(b.x0 + b.x1) / 2, b.z1 - postT / 2],
  ] as const) batch.box('cedar', m.cedar, [px - postT / 2, b.yFloor, pz - postT / 2], [px + postT / 2, b.railTop + 4, pz + postT / 2]);
  batch.box('cedar', m.cedar, [b.x0, b.railTop - b.railT, b.z1 - b.railT], [b.x1, b.railTop, b.z1]);
  batch.box('cedar', m.cedar, [b.x0, b.yFloor + 8, b.z1 - 5], [b.x1, b.yFloor + 13, b.z1], nc);
  for (let x = b.x0 + 14; x < b.x1 - 10; x += 14) batch.box('cedar', m.cedar, [x - 1.6, b.yFloor + 13, b.z1 - 4.5], [x + 1.6, b.railTop - b.railT, b.z1 - 1.5], nc);
  for (const sx of [b.x0, b.x1 - b.railT]) {
    batch.box('cedar', m.cedar, [sx, b.railTop - b.railT, HOUSE.z1], [sx + b.railT, b.railTop, b.z1]);
    for (let z = HOUSE.z1 + 14; z < b.z1 - 10; z += 14) batch.box('cedar', m.cedar, [sx + 1, b.yFloor + 13, z - 1.6], [sx + b.railT - 1, b.railTop - b.railT, z + 1.6], nc);
    batch.cyl('snow', m.snow, sx + b.railT / 2, b.railTop + 3, (HOUSE.z1 + b.z1) / 2, 5.5, b.z1 - HOUSE.z1 - 4, 8, Math.PI / 2, 0, { cast: false, receive: false });
  }
  batch.cyl('snow', m.snow, (b.x0 + b.x1) / 2, b.railTop + 3, b.z1 - b.railT / 2, 6, b.x1 - b.x0 - 4, 8, 0, Math.PI / 2, { cast: false, receive: false });
  // 雨棚：cedar 斜板 + 雪 + 托架
  slab(batch, 'cedar', m.cedar, AWNING.x0, AWNING.x1, AWNING.zOut, AWNING.yOut, AWNING.zWall, AWNING.yWall, AWNING.thick, 0);
  // 雪被尺寸读 AWNING_SNOW（碰撞体的落脚面 = 这块雪板的顶面线）；顶面按 30 cm 一格细分（雪印顶点下压）
  slab(batch, 'snow', m.snow, AWNING.x0, AWNING.x1, AWNING.zOut, AWNING.yOut, AWNING.zWall, AWNING.yWall, AWNING_SNOW.thick, AWNING_SNOW.offset, { cast: true }, 30);
  batch.cyl('snow', m.snow, (AWNING.x0 + AWNING.x1) / 2, AWNING.yOut + AWNING.thick + AWNING_SNOW.rollDrop, AWNING.zOut - AWNING_SNOW.rollInset, AWNING_SNOW.rollR, AWNING.x1 - AWNING.x0 + 8, 10, 0, Math.PI / 2, { cast: true });
  for (const px of [AWNING.x0 + 20, AWNING.x1 - 20]) batch.tube('cedar', m.cedar, [px, AWNING.yWall - 60, AWNING.zWall], [px, AWNING.yOut + 2, AWNING.zOut + 8], 3.5, 6);
  for (let i = 0; i < 9; i++) {
    const x = AWNING.x0 + 40 + i * 62;
    batch.cyl('glow', m.glow, x, AWNING.yOut - 6 - Math.sin((i / 8) * Math.PI) * 6, AWNING.zOut + 10, 2.2, 4.5, 6, Math.PI / 2, 0, { cast: false, receive: false });
  }
}

/** 三楼小露台：楼板 + 铁艺护栏（细圆柱）+ 雪。 */
function addTerrace(batch: Batch, m: CourtyardMaterials): void {
  const t = TERRACE;
  const nc = { cast: false } as const;
  batch.box('cedar', m.cedar, [t.x0, t.yFloor - t.slabT, HOUSE.z1], [t.x1, t.yFloor - 2, t.z1]);
  batch.box('pine', m.pine, [t.x0 + 2, t.yFloor - 2, HOUSE.z1], [t.x1 - 2, t.yFloor, t.z1 - 2], nc);
  batch.box('snow', m.snow, [t.x0 + 6, t.yFloor, HOUSE.z1 + 40], [t.x1 - 6, t.yFloor + 4, t.z1 - 8], { cast: false, receive: false });
  const r = t.railT;
  batch.box('metal', m.metal, [t.x0, t.railTop - r, t.z1 - r], [t.x1, t.railTop, t.z1]);
  batch.box('metal', m.metal, [t.x0, t.yFloor + 10, t.z1 - r], [t.x1, t.yFloor + 10 + r, t.z1], nc);
  batch.box('metal', m.metal, [t.x0, t.railTop - r, t.z1], [t.x0 + r, t.railTop, HOUSE.z1]);
  batch.box('metal', m.metal, [t.x1 - r, t.railTop - r, t.z1], [t.x1, t.railTop, HOUSE.z1]);
  batch.box('metal', m.metal, [t.x0, t.yFloor + 10, t.z1], [t.x0 + r, t.yFloor + 10 + r, HOUSE.z1], nc);
  batch.box('metal', m.metal, [t.x1 - r, t.yFloor + 10, t.z1], [t.x1, t.yFloor + 10 + r, HOUSE.z1], nc);
  const barH = t.railTop - t.yFloor - 10;
  for (let x = t.x0 + 12; x < t.x1 - 8; x += 12) batch.cyl('metal', m.metal, x, (t.yFloor + 10 + t.railTop) / 2, t.z1 - r / 2, 1.3, barH, 6, 0, 0, nc);
  for (let z = HOUSE.z1 + 12; z < t.z1 - 8; z += 12) {
    batch.cyl('metal', m.metal, t.x0 + r / 2, (t.yFloor + 10 + t.railTop) / 2, z, 1.3, barH, 6, 0, 0, nc);
    batch.cyl('metal', m.metal, t.x1 - r / 2, (t.yFloor + 10 + t.railTop) / 2, z, 1.3, barH, 6, 0, 0, nc);
  }
  for (const [px, pz] of [
    [t.x0 + r / 2, t.z1 - r / 2],
    [t.x1 - r / 2, t.z1 - r / 2],
    [(t.x0 + t.x1) / 2, t.z1 - r / 2],
    [t.x0 + r / 2, HOUSE.z1 + 10],
    [t.x1 - r / 2, HOUSE.z1 + 10],
  ] as const) {
    batch.cyl('metal', m.metal, px, (t.yFloor + t.railTop) / 2, pz, 2.4, t.railTop - t.yFloor, 8, 0, 0);
    batch.cyl('snow', m.snow, px, t.railTop + 2.5, pz, 4, 5, 8, 0, 0, { cast: false, receive: false });
  }
  batch.cyl('snow', m.snow, (t.x0 + t.x1) / 2, t.railTop + 2, t.z1 - r / 2, 4, t.x1 - t.x0 - 4, 8, 0, Math.PI / 2, { cast: false, receive: false });
}

/** 双坡屋顶 + 厚雪被（檐口卷边）+ 屋脊雪 + 山墙封檐板 + 檐沟 + 砖烟囱。 */
function addRoof(batch: Batch, m: CourtyardMaterials): void {
  const h = HOUSE;
  const rx0 = h.x0 - h.overhang;
  const rx1 = h.x1 + h.overhang;
  const zS = h.z1 + h.overhang;
  const zN = h.z0 - h.overhang;
  slab(batch, 'cedar', m.cedar, rx0, rx1, zS, houseRoofY(zS), h.zRidge, h.yRidge, h.roofThick, -h.roofThick);
  slab(batch, 'cedar', m.cedar, rx0, rx1, zN, houseRoofY(zN), h.zRidge, h.yRidge, h.roofThick, -h.roofThick);
  // 雪被：厚板（底面压进屋面板 4 cm）+ 檐口卷边 + 屋脊雪。尺寸读 ROOF_SNOW（碰撞体的落脚面 = 这块雪板的顶面线，
  // 两边同一份数字）；雪板顶面按 35 cm 一格细分，雪印的顶点下压才有顶点可落
  const snowT = ROOF_SNOW.thick;
  const eaveDrop = ROOF_SNOW.refDrop;
  const inset = ROOF_SNOW.eaveInset;
  slab(batch, 'snow', m.snow, rx0 - 6, rx1 + 6, zS + inset, houseRoofY(zS) - eaveDrop, h.zRidge, h.yRidge + ROOF_SNOW.ridgeRise, snowT, ROOF_SNOW.offset, { cast: true }, 35);
  slab(batch, 'snow', m.snow, rx0 - 6, rx1 + 6, zN - inset, houseRoofY(zN) - eaveDrop, h.zRidge, h.yRidge + ROOF_SNOW.ridgeRise, snowT, ROOF_SNOW.offset, { cast: true }, 35);
  batch.cyl('snow', m.snow, (rx0 + rx1) / 2, houseRoofY(zS) + ROOF_SNOW.eaveRollRise, zS + inset, ROOF_SNOW.eaveRollR, rx1 - rx0 + 14, 12, 0, Math.PI / 2, { cast: true });
  batch.cyl('snow', m.snow, (rx0 + rx1) / 2, houseRoofY(zN) + ROOF_SNOW.eaveRollRise, zN - inset, ROOF_SNOW.eaveRollR, rx1 - rx0 + 14, 12, 0, Math.PI / 2, { cast: true });
  batch.cyl('snow', m.snow, (rx0 + rx1) / 2, h.yRidge + ROOF_SNOW.ridgeRollY, h.zRidge, ROOF_SNOW.ridgeRollR, rx1 - rx0 + 14, 12, 0, Math.PI / 2, { cast: true });
  // 山墙封檐板（两侧斜边）
  for (const x of [rx0, rx1 - 8]) {
    for (const [za, zb] of [
      [zS, h.zRidge],
      [zN, h.zRidge],
    ] as const) slab(batch, 'cedar', m.cedar, x, x + 8, za, houseRoofY(za), zb, h.yRidge, 16, -h.roofThick - 14, { cast: false });
  }
  // 檐沟（南北）+ 落水管
  batch.cyl('metal', m.metal, (rx0 + rx1) / 2, houseRoofY(zS) - h.roofThick - 4, zS + 2, 5, rx1 - rx0, 10, 0, Math.PI / 2, { cast: false });
  batch.cyl('metal', m.metal, (rx0 + rx1) / 2, houseRoofY(zN) - h.roofThick - 4, zN - 2, 5, rx1 - rx0, 10, 0, Math.PI / 2, { cast: false });
  batch.cyl('metal', m.metal, rx0 + 30, (houseRoofY(zS) - h.roofThick - 30 + h.floors[0]) / 2, h.z1 + 6, 4, houseRoofY(zS) - h.roofThick - 30 - h.floors[0], 8, 0, 0, { cast: false });
  batch.tube('metal', m.metal, [rx0 + 30, houseRoofY(zS) - h.roofThick - 30, h.z1 + 6], [rx0 + 30, houseRoofY(zS) - h.roofThick - 4, zS - 2], 4, 8, { cast: false });
  // 砖烟囱 + 石帽 + 雪 + 两个陶烟囱管
  const c = CHIMNEY;
  batch.box('brick', m.brick, [c.x0, c.y0, c.z0], [c.x1, c.y1, c.z1]);
  batch.box('stone', m.stone, [c.x0 - 6, c.y1, c.z0 - 6], [c.x1 + 6, c.y1 + c.capT, c.z1 + 6]);
  batch.box('snow', m.snow, [c.x0 - 7, c.y1 + c.capT, c.z0 - 7], [c.x1 + 7, c.y1 + c.capT + 8, c.z1 + 7], { cast: true });
  for (const px of [c.x0 + 22, c.x1 - 22]) {
    batch.cyl('brick', m.brick, px, c.y1 + c.capT + 16, (c.z0 + c.z1) / 2, 9, 24, 10, 0, 0);
    batch.cyl('brick', m.brick, px, c.y1 + c.capT + 30, (c.z0 + c.z1) / 2, 11, 4, 10, 0, 0);
  }
}

/**
 * 四角包角（交替长短的石块）、层间腰线（石带 + 顶上一条积雪）、屋檐冰柱（檐口 / 山墙斜檐下倒挂的锥形冰柱）。
 */
function addTrim(batch: Batch, m: CourtyardMaterials): void {
  const h = HOUSE;
  const nc = { cast: false } as const;
  // 四角包角：从勒脚顶到檐口，30 cm 一层，长短交替，凸出墙面 3 cm
  const corners: { x: number; z: number }[] = [
    { x: h.x0, z: h.z0 },
    { x: h.x1, z: h.z0 },
    { x: h.x0, z: h.z1 },
    { x: h.x1, z: h.z1 },
  ];
  const span = (a: number, b: number): [number, number] => (a < b ? [a, b] : [b, a]);
  for (const c of corners) {
    // 这两面墙各自朝外的方向
    const ox = c.x === h.x0 ? -1 : 1;
    const oz = c.z === h.z0 ? -1 : 1;
    let k = 0;
    for (let y = h.floors[0] + 18; y + 30 <= h.yEave - 2; y += 30, k++) {
      // 长短交替：这层 x 面上长、z 面上短，下一层反过来
      const lx = k % 2 === 0 ? 44 : 26;
      const lz = k % 2 === 0 ? 26 : 44;
      // 贴 x 面的那块：凸出 3 cm、沿墙从角往里 lz
      const [xa0, xa1] = span(c.x, c.x + ox * 3);
      const [za0, za1] = span(c.z, c.z - oz * lz);
      batch.box('ashlarOut', m.ashlarOut, [xa0, y, za0], [xa1, y + 28, za1], nc);
      // 贴 z 面的那块
      const [zb0, zb1] = span(c.z, c.z + oz * 3);
      const [xb0, xb1] = span(c.x, c.x - ox * lx);
      batch.box('ashlarOut', m.ashlarOut, [xb0, y, zb0], [xb1, y + 28, zb1], nc);
    }
  }
  // 层间腰线：石带凸出 4 cm，顶上一条薄雪
  for (const y of [h.floors[1] - 6, h.floors[2] - 6]) {
    const t = 12;
    batch.box('ashlarOut', m.ashlarOut, [h.x0 - 4, y, h.z0 - 4], [h.x1 + 4, y + t, h.z1 + 4], { cast: false });
    batch.box('snow', m.snow, [h.x0 - 5, y + t, h.z0 - 5], [h.x1 + 5, y + t + 3.5, h.z1 + 5], { cast: false, receive: false });
  }
  // 屋檐冰柱：南 / 北檐口下、东西山墙斜檐下，一排长短不一的倒挂锥
  const rng = makeRng(818);
  const icicle = (x: number, y: number, z: number, r: number, len: number): void => {
    const g = new ConeGeometry(r, len, 6, 1);
    const pos = g.attributes.position;
    const tip = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) tip[i] = (pos.getY(i) + len / 2) / len;
    g.setAttribute('aTip', new Float32BufferAttribute(tip, 1));
    g.rotateX(Math.PI);
    g.translate(x, y - len / 2 + 1, z);
    batch.add('ice', m.ice, g, undefined, { cast: false, receive: false });
  };
  const rx0 = h.x0 - h.overhang;
  const rx1 = h.x1 + h.overhang;
  const zS = h.z1 + h.overhang;
  const zN = h.z0 - h.overhang;
  const yEaveS = houseRoofY(zS) - h.roofThick;
  for (let x = rx0 + 14; x < rx1 - 10; x += 11 + rng() * 14) {
    const len = 8 + rng() * rng() * 42;
    icicle(x, yEaveS - 2, zS - 6 - rng() * 4, 1.2 + len * 0.06, len);
    icicle(x + 4, yEaveS - 2, zN + 6 + rng() * 4, 1.2 + len * 0.05, len * (0.6 + rng() * 0.5));
  }
  // 山墙斜檐（东西两端）：沿坡每隔一段一根
  for (const gx of [rx0 + 4, rx1 - 4]) {
    for (const [za, zb] of [
      [zS - 8, h.zRidge],
      [zN + 8, h.zRidge],
    ] as const) {
      const steps = 14;
      for (let i = 0; i < steps; i++) {
        const z = za + ((zb - za) * (i + 0.5)) / steps;
        const len = 6 + rng() * rng() * 34;
        icicle(gx + (gx < 0 ? 6 : -6), houseRoofY(z) - h.roofThick - 14, z, 1.1 + len * 0.06, len);
      }
    }
  }
  // 二楼雨棚 / 门廊小雨棚 / 阳台栏杆下的几根
  for (let x = AWNING.x0 + 20; x < AWNING.x1 - 10; x += 16 + rng() * 20) {
    const len = 6 + rng() * rng() * 26;
    icicle(x, AWNING.yOut + 2, AWNING.zOut - 2, 1 + len * 0.06, len);
  }
  for (let x = PORCH.x0 + 16; x < PORCH.x1 - 8; x += 18 + rng() * 16) {
    const len = 6 + rng() * rng() * 22;
    icicle(x, PORCH.yOut + 2, PORCH.zOut - 2, 1 + len * 0.06, len);
  }
}

/** 外挂空调机（西山墙）：金属外壳 + 深色格栅 + 风扇罩 + 支架 + 顶上积雪。 */
function addAc(batch: Batch, m: CourtyardMaterials): void {
  const a = AC_UNIT;
  batch.box('metal', m.metal, [a.x0, a.y0, a.z0], [a.x1, a.y1, a.z1]);
  batch.box('walnut', m.walnut, [a.x0 - 1, a.y0 + 6, a.z0 + 6], [a.x0 + 0.5, a.y1 - 6, a.z1 - 6], { cast: false, receive: false });
  batch.cyl('metal', m.metal, a.x0 - 1.5, (a.y0 + a.y1) / 2, (a.z0 + a.z1) / 2, 22, 1.5, 16, 0, Math.PI / 2, { cast: false, receive: false });
  for (const pz of [a.z0 + 10, a.z1 - 10]) batch.tube('metal', m.metal, [a.x0, a.y0 - 2, pz], [HOUSE.x0, a.y0 - 30, pz], 2.5, 6, { cast: false });
  batch.box('snow', m.snow, [a.x0 - 2, a.y1, a.z0 - 2], [a.x1, a.y1 + 5, a.z1 + 2], { cast: true });
}

export function buildHouse(m: CourtyardMaterials, batch: Batch): void {
  const h = HOUSE;
  batch.box('stucco', m.stucco, [h.x0, -130, h.z0], [h.x1, h.yEave, h.z1]);
  batch.geo('stucco', m.stucco, gableGeometry(h.x0, -1), undefined);
  batch.geo('stucco', m.stucco, gableGeometry(h.x1, 1), undefined);
  batch.box('ashlarOut', m.ashlarOut, [h.x0 - 6, h.floors[0] - 10, h.z0 - 6], [h.x1 + 6, h.floors[0] + 18, h.z1 + 6], { cast: false });
  for (const w of WINDOWS) addWindow(batch, m, w);
  addHouseDoor(batch, m);
  addGlassDoor(batch, m, BALCONY_DOOR, 0.7);
  addGlassDoor(batch, m, TERRACE_DOOR, 0.2);
  // 阳光房里通往洋房的玻璃门（视觉；洋房碰撞体仍是实心盒）
  addGlassDoor(batch, m, { x0: 180, x1: 260, y0: GH.yFloor, y1: GH.yFloor + 200 }, 0.6);
  addBalcony(batch, m);
  addTerrace(batch, m);
  addRoof(batch, m);
  addAc(batch, m);
  addTrim(batch, m);
}
