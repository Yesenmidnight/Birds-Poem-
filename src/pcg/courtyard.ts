/**
 * 《雪精灵的冬日庭院与阳光花房》——核心舞台的纯数据布局（COURTYARD_PLAN.md）。
 *
 * 零 three 依赖，Node 直接 import（只用可擦除语法、相对导入写全 .ts 扩展名）。
 * 两种消费者读同一份数据：
 *   - 仿真层：buildWorld(buildCourtyardLayout()) → 碰撞体（tools/courtyard_check.mjs 无头自检）；
 *   - 画面层：src/courtyard/* 的视觉构建器按这里导出的尺寸常量与描述数据建网格，谁都不手填几何。
 *
 * 坐标：1 单位 = 1 cm，+Y 向上，北 = −Z（洋房在南侧草坪的对面），南 = +Z（草坪 / 相机一侧）。
 * 主角枝 HERO_BRANCH 原位不动（世界原点，沿 +X，鸟面朝 −X），院心大树从它的粗端后方长出来。
 */
import { interpKeys, makeRng, noise3, smoothstep } from '../util/math.ts';
import { flattenPoints, sampleArc } from '../sim/spline.ts';
import type { CurveLayout, Layout, SlopeLayout, TreeLimb } from './layout.ts';
import { HERO_BRANCH, saggingWire } from './layout.ts';
import { snowHeight, buildWorld } from '../sim/buildWorld.ts';
import { Heightfield } from '../sim/heightfield.ts';
import type { SimWorld, SimWorldOptions } from '../sim/world.ts';
import type { SpringParams } from '../sim/curvePerch.ts';

type V3 = [number, number, number];

// ───────────────────────────────────── 场地基准 ─────────────────────────────────────

/** 雪被基准高度：主角枝 (y≈0) 距雪面 1.25 m。 */
export const SNOW_BASE = -125;
/** 围院范围（栅栏中心线）。东翼从 x=360 起整座大植物园温室贯穿南北，栅栏随之东移到温室东墙外 120 cm。 */
export const YARD = { x0: -1100, x1: 1640, z0: -1200, z1: 1200 } as const;

/** 雪面：一片起伏厚雪，墙根 / 树根 / 阳光房外沿堆风吹雪垄。高度场随院子向东扩到 1900。 */
export const GROUND = {
  tag: 'snow',
  x0: -1400,
  z0: -1400,
  x1: 1900,
  z1: 1400,
  cell: 4,
  base: SNOW_BASE,
  drift: 10,
  seed: 5,
  mounds: [
    // 洋房南墙根（门口留空）
    { x: -660, z: -540, height: 20, radius: 64 },
    { x: -560, z: -540, height: 22, radius: 64 },
    { x: -460, z: -540, height: 20, radius: 64 },
    { x: -360, z: -540, height: 22, radius: 64 },
    { x: -160, z: -540, height: 18, radius: 60 },
    // 阳光房南墙根（门口留空）、东西山墙根
    { x: -100, z: -150, height: 16, radius: 56 },
    { x: -10, z: -150, height: 16, radius: 56 },
    { x: 160, z: -150, height: 16, radius: 56 },
    { x: 260, z: -150, height: 16, radius: 56 },
    { x: 350, z: -480, height: 16, radius: 56 },
    { x: 350, z: -360, height: 16, radius: 56 },
    { x: 350, z: -240, height: 16, radius: 56 },
    { x: -150, z: -480, height: 16, radius: 56 },
    { x: -150, z: -360, height: 16, radius: 56 },
    { x: -150, z: -240, height: 16, radius: 56 },
    // 大植物园西墙根（双开门一段留空）
    { x: 350, z: -110, height: 16, radius: 56 },
    { x: 350, z: 0, height: 18, radius: 56 },
    { x: 350, z: 110, height: 18, radius: 56 },
    { x: 350, z: 520, height: 18, radius: 56 },
    { x: 350, z: 640, height: 18, radius: 56 },
    { x: 350, z: 760, height: 16, radius: 56 },
    { x: 350, z: 880, height: 16, radius: 56 },
    { x: 350, z: 1000, height: 16, radius: 56 },
    { x: 350, z: 1110, height: 14, radius: 50 },
    // 大植物园南北两端墙根
    { x: 700, z: -1195, height: 12, radius: 50 },
    { x: 1100, z: -1195, height: 12, radius: 50 },
    { x: 700, z: 1195, height: 12, radius: 50 },
    { x: 1100, z: 1195, height: 12, radius: 50 },
    // 栅栏沿线的风吹雪
    { x: -900, z: 1190, height: 16, radius: 80 },
    { x: -600, z: 1190, height: 18, radius: 80 },
    { x: 0, z: 1190, height: 16, radius: 80 },
    { x: -1090, z: -700, height: 16, radius: 80 },
    { x: -1090, z: -200, height: 18, radius: 80 },
    { x: -1090, z: 300, height: 16, radius: 80 },
    { x: -1090, z: 800, height: 18, radius: 80 },
    { x: 1630, z: -700, height: 16, radius: 70 },
    { x: 1630, z: -200, height: 18, radius: 70 },
    { x: 1630, z: 300, height: 16, radius: 70 },
    { x: 1630, z: 800, height: 18, radius: 70 },
    { x: -900, z: -1190, height: 16, radius: 80 },
    { x: -300, z: -1190, height: 14, radius: 80 },
    // 院心大树根部（观鸟管线那棵老海棠的主干基部 (−146, −125, −58)：从栖枝粗端后方 1 m 斜倚上来）
    { x: -146, z: -58, height: 12, radius: 58 },
    // 草坪上的几道长雪垄
    { x: -520, z: 640, height: 7, radius: 150 },
    { x: 320, z: 820, height: 8, radius: 170 },
    { x: -760, z: 120, height: 7, radius: 140 },
    { x: 640, z: 260, height: 7, radius: 150 },
    { x: -320, z: -300, height: 6, radius: 120 },
    // 长椅 / 路灯 / 电线杆脚下
    { x: -395, z: -200, height: 8, radius: 50 },
    { x: 150, z: 430, height: 7, radius: 36 },
    { x: -950, z: 550, height: 10, radius: 44 },
  ],
};

/** 雪面高度（和 buildWorld 同一个公式）：放石板、长草、立东西都要贴着雪面。 */
export const snowAt = snowHeight(GROUND);

// ───────────────────────────────────── 三层小洋房 ─────────────────────────────────────

/** 洋房：北侧，东西向 1040 cm、进深 620 cm，三层，双坡顶。 */
export const HOUSE = {
  x0: -700,
  x1: 340,
  z0: -1180,
  z1: -560,
  /** 楼板：F1 地面（雪面）/ F1 顶 = F2 地面 / F2 顶 = F3 地面 / F3 顶。 */
  floors: [-125, 170, 460, 750],
  yEave: 760,
  yRidge: 880,
  zRidge: -870,
  roofThick: 14,
  overhang: 40,
  wallT: 24,
} as const;

export interface WindowSpec {
  /** 所在墙面。 */
  face: 'south' | 'north' | 'west' | 'east';
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** z 范围（west / east 面）。 */
  z0?: number;
  z1?: number;
  cols: number;
  rows: number;
  /** 窗里透出暖光（0..1）。 */
  lit: number;
  /** 窗下木花箱。 */
  box: boolean;
}

function southWindow(x0: number, x1: number, y0: number, y1: number, cols: number, rows: number, lit: number, box = false): WindowSpec {
  return { face: 'south', x0, x1, y0, y1, cols, rows, lit, box };
}

/** 全部窗户（门另有 door / balconyDoor / terraceDoor）。 */
export const WINDOWS: WindowSpec[] = [
  // 一楼南面（阳光房占掉了东段，它背后不留窗）
  southWindow(-640, -540, -10, 120, 2, 3, 0.55),
  southWindow(-440, -340, -10, 120, 2, 3, 0.9),
  // 二楼南面：阳台门两侧
  southWindow(-440, -340, 215, 355, 2, 3, 0.75, true),
  southWindow(-40, 60, 215, 355, 2, 3, 0.35, true),
  // 三楼南面
  southWindow(-640, -540, 520, 660, 2, 3, 0.2, true),
  southWindow(-440, -340, 520, 660, 2, 3, 0.65, true),
  southWindow(-240, -140, 520, 660, 2, 3, 0.1, true),
  southWindow(-40, 60, 520, 660, 2, 3, 0.45, true),
  // 东西山墙：每层两扇
  { face: 'west', x0: HOUSE.x0, x1: HOUSE.x0, z0: -1080, z1: -980, y0: -10, y1: 120, cols: 2, rows: 3, lit: 0.3, box: false },
  { face: 'west', x0: HOUSE.x0, x1: HOUSE.x0, z0: -800, z1: -700, y0: -10, y1: 120, cols: 2, rows: 3, lit: 0.0, box: false },
  { face: 'west', x0: HOUSE.x0, x1: HOUSE.x0, z0: -1080, z1: -980, y0: 215, y1: 355, cols: 2, rows: 3, lit: 0.5, box: false },
  { face: 'west', x0: HOUSE.x0, x1: HOUSE.x0, z0: -800, z1: -700, y0: 215, y1: 355, cols: 2, rows: 3, lit: 0.0, box: false },
  { face: 'west', x0: HOUSE.x0, x1: HOUSE.x0, z0: -1080, z1: -980, y0: 520, y1: 660, cols: 2, rows: 3, lit: 0.0, box: false },
  { face: 'west', x0: HOUSE.x0, x1: HOUSE.x0, z0: -800, z1: -700, y0: 520, y1: 660, cols: 2, rows: 3, lit: 0.3, box: false },
  // 西山墙中段补窗：两窗之间 280 cm 的空白墙面，每层各补一扇
  { face: 'west', x0: HOUSE.x0, x1: HOUSE.x0, z0: -940, z1: -840, y0: -10, y1: 120, cols: 2, rows: 3, lit: 0.0, box: false },
  { face: 'west', x0: HOUSE.x0, x1: HOUSE.x0, z0: -940, z1: -840, y0: 215, y1: 355, cols: 2, rows: 3, lit: 0.65, box: false },
  { face: 'west', x0: HOUSE.x0, x1: HOUSE.x0, z0: -940, z1: -840, y0: 520, y1: 660, cols: 2, rows: 3, lit: 0.15, box: false },
  // 东山墙中段同样补上（大植物园贴着东山墙，外面看不见，从温室里透过砖墙也看不见——不补）
  { face: 'east', x0: HOUSE.x1, x1: HOUSE.x1, z0: -1080, z1: -980, y0: -10, y1: 120, cols: 2, rows: 3, lit: 0.0, box: false },
  { face: 'east', x0: HOUSE.x1, x1: HOUSE.x1, z0: -800, z1: -700, y0: -10, y1: 120, cols: 2, rows: 3, lit: 0.4, box: false },
  { face: 'east', x0: HOUSE.x1, x1: HOUSE.x1, z0: -1080, z1: -980, y0: 215, y1: 355, cols: 2, rows: 3, lit: 0.0, box: false },
  { face: 'east', x0: HOUSE.x1, x1: HOUSE.x1, z0: -800, z1: -700, y0: 215, y1: 355, cols: 2, rows: 3, lit: 0.0, box: false },
  { face: 'east', x0: HOUSE.x1, x1: HOUSE.x1, z0: -1080, z1: -980, y0: 520, y1: 660, cols: 2, rows: 3, lit: 0.0, box: false },
  { face: 'east', x0: HOUSE.x1, x1: HOUSE.x1, z0: -800, z1: -700, y0: 520, y1: 660, cols: 2, rows: 3, lit: 0.0, box: false },
  // 北面（背面）
  { face: 'north', x0: -600, x1: -500, y0: -10, y1: 120, cols: 2, rows: 3, lit: 0.0, box: false },
  { face: 'north', x0: -200, x1: -100, y0: -10, y1: 120, cols: 2, rows: 3, lit: 0.0, box: false },
  { face: 'north', x0: -600, x1: -500, y0: 215, y1: 355, cols: 2, rows: 3, lit: 0.0, box: false },
  { face: 'north', x0: -200, x1: -100, y0: 215, y1: 355, cols: 2, rows: 3, lit: 0.0, box: false },
  { face: 'north', x0: -600, x1: -500, y0: 520, y1: 660, cols: 2, rows: 3, lit: 0.0, box: false },
  { face: 'north', x0: -200, x1: -100, y0: 520, y1: 660, cols: 2, rows: 3, lit: 0.0, box: false },
];

/** 洋房正门（南面西段）。 */
export const HOUSE_DOOR = { x0: -280, x1: -190, y0: -125, y1: 85 } as const;
/** 二楼阳台：从二楼地面挑出，木栏杆。 */
export const BALCONY = { x0: -470, x1: 150, z1: -450, yFloor: 170, slabT: 15, railTop: 286, railT: 8 } as const;
/** 二楼阳台门。 */
export const BALCONY_DOOR = { x0: -220, x1: -130, y0: 170, y1: 380 } as const;
/** 二楼防雪雨棚：从墙面斜挑出来盖住阳台。 */
export const AWNING = { x0: -480, x1: 160, zWall: -560, zOut: -430, yWall: 410, yOut: 372, thick: 6 } as const;
/** 三楼小露台（东端），铁艺护栏。 */
export const TERRACE = { x0: 170, x1: 340, z1: -440, yFloor: 460, slabT: 15, railTop: 576, railT: 6 } as const;
export const TERRACE_DOOR = { x0: 230, x1: 310, y0: 475, y1: 685 } as const;
/** 红砖烟囱（穿出屋面）。 */
export const CHIMNEY = { x0: -560, x1: -480, z0: -900, z1: -820, y0: 700, y1: 975, capT: 20 } as const;
/** 外挂空调机（西山墙）。 */
// 西山墙南端的空墙（一楼三扇窗 z −1080..−700 以南、包角以北），不再挡在一楼中间那扇窗前
export const AC_UNIT = { x0: -735, x1: HOUSE.x0, y0: 20, y1: 80, z0: -690, z1: -610 } as const;
/** 正门小雨棚。 */
export const PORCH = { x0: -300, x1: -170, zWall: -560, zOut: -480, yWall: 120, yOut: 100, thick: 6 } as const;

/** 洋房屋面顶面高度（南坡 / 北坡同一公式：过 (z1, yEave) 与 (zRidge, yRidge)），含檐口外挑段的延伸。 */
export function houseRoofY(z: number): number {
  const dz = z - HOUSE.zRidge;
  return HOUSE.yRidge - (Math.abs(dz) / Math.abs(HOUSE.zRidge - HOUSE.z1)) * (HOUSE.yRidge - HOUSE.yEave);
}

// ───────────────────────────────────── 覆雪面：视觉和碰撞共用一份尺寸 ─────────────────────────────────────
/**
 * 洋房屋顶 / 二楼雨棚 / 正门小雨棚的雪被参数。House.ts 画雪、buildCourtyardLayout 抬碰撞顶面，读的是同一份：
 * 雪板沿屋面法线从 offset 铺到 offset + thick（House.ts slab() 的数学），参考线就是屋面板顶面线；
 * 檐口一条雪卷（半径 rollR、轴在参考线檐端上方 rollDrop / eaveRollRise）、屋脊一条雪卷（半径 ridgeRollR、轴在屋脊线上方 ridgeRollY）。
 * 碰撞体的顶面 = 雪板顶面线（视觉积雪的真实外表面），雪卷 = 同半径的圆杆栖木。
 */
export const ROOF_SNOW = {
  thick: 26,
  offset: -4,
  /** 雪板参考线从檐口往里收多少（雪板不铺到檐口尽头，外面由檐口雪卷接管）。 */
  eaveInset: 14,
  /** 参考线檐端相对屋面下压 / 屋脊端相对屋脊上抬。 */
  refDrop: 6,
  ridgeRise: 6,
  eaveRollR: 17,
  eaveRollRise: 4,
  ridgeRollR: 14,
  ridgeRollY: 24,
  /** 屋脊雪卷脚下那段陡坡的宽度（两侧各一段，在屋脊线相接）。 */
  ridgeFoot: 20,
} as const;
export const AWNING_SNOW = { thick: 12, offset: AWNING.thick, rollR: 11, rollDrop: 10, rollInset: 6 } as const;
export const PORCH_SNOW = { thick: 10, offset: PORCH.thick, rollR: 9, rollDrop: 8, rollInset: 4 } as const;

/** 斜板参考线 (zA, yA)→(zB, yB) 沿法线整体抬 lift：返回抬后的线 + 法线（和 House.ts slab() 同一套数学，法线 y 取正）。 */
export function slabLift(
  zA: number,
  yA: number,
  zB: number,
  yB: number,
  lift: number,
): { zA: number; yA: number; zB: number; yB: number; ny: number; nz: number } {
  const dz = zB - zA;
  const dy = yB - yA;
  const len = Math.hypot(dz, dy);
  const ny = Math.abs(dz) / len;
  const nz = (-Math.sign(dz) * dy) / len;
  return { zA: zA + nz * lift, yA: yA + ny * lift, zB: zB + nz * lift, yB: yB + ny * lift, ny, nz };
}

/** 斜板线在 z 处的高度（线性插值，允许外推）。 */
export function lineY(l: { zA: number; yA: number; zB: number; yB: number }, z: number): number {
  return l.yA + ((l.yB - l.yA) * (z - l.zA)) / (l.zB - l.zA);
}

/**
 * 檐口雪卷（轴 (zR, yR)、半径 R）和雪板顶面线的交点，取靠屋脊一侧的那个（toRidge = 朝屋脊的 z 方向）：
 * 雪板从这点铺到屋脊坡脚、雪卷管檐口，两者在这里等高相接，鸟从雪板走到雪卷不会被绊。
 */
export function rollCross(
  zR: number,
  yR: number,
  R: number,
  top: { zA: number; yA: number; zB: number; yB: number },
  toRidge: 1 | -1,
): { z: number; y: number } {
  let a = 0;
  let b = R;
  for (let i = 0; i < 48; i++) {
    const m = (a + b) / 2;
    const above = yR + Math.sqrt(R * R - m * m) - lineY(top, zR + toRidge * m);
    if (above > 0) a = m;
    else b = m;
  }
  const t = (a + b) / 2;
  return { z: zR + toRidge * t, y: lineY(top, zR + toRidge * t) };
}

// ───────────────────────────────────── 玻璃阳光房 ─────────────────────────────────────

/**
 * 玻璃阳光房：紧贴洋房一楼南侧东段，双坡玻璃顶，脊沿 X。
 * 室内地面 yFloor 高出雪被 35 cm（防雪垄穿进室内），四周 55 cm 高的红砖矮墙，矮墙以上全是玻璃；
 * 南墙一扇半推开的外开门，南坡一扇撑开的天窗。碰撞体中空：矮墙 / 整厚玻璃 / 立柱 / 横梁 / 花架是独立盒体，屋面是天窗留口的连续斜板。
 */
export const GH = {
  x0: -140,
  x1: 340,
  z0: -560,
  z1: -160,
  yFloor: -90,
  yLowWall: -35,
  yEave: 140,
  yRidge: 250,
  zRidge: -360,
  wallT: 12,
  floorT: 20,
  postT: 9,
  /** 玻璃碰撞盒厚度：整堵墙厚（12 cm），外皮和矮墙平齐——2 cm 薄片高速会穿透，还会卡进柱子和玻璃的夹缝。 */
  glassT: 12,
  roofT: 8,
  /** 柱距 120（屋架 / 侧墙柱列）。 */
  baysX: [-140, -20, 100, 220, 340],
  baysZ: [-560, -440, -360, -280, -160],
  /** 南墙柱列：门洞 (30..116) 里不能立柱，门两侧各补一根。 */
  postsSouthX: [-140, -20, 20, 125, 220, 340],
} as const;

/** 半推开的庭院玻璃门：南侧，铰链在西侧门框，向外（朝草坪 +Z）推开 openDeg。 */
export const GH_DOOR = { x0: 30, x1: 116, y0: GH.yFloor, y1: 100, openDeg: 55, leafT: 4, frameT: 3 } as const;
/** 斜顶透气天窗：南坡，开口 60 × 70（平面投影），盖子铰链在下沿、向上撑起（开口从上方完全畅通）。 */
export const GH_VENT = { x0: 130, x1: 190, z0: -322, z1: -252, openDeg: 50, curbH: 10, lidT: 5 } as const;

/** 阳光房屋面在某 z 处的高度（南坡 z ≥ zRidge、北坡 z ≤ zRidge）。 */
export function ghRoofY(z: number): number {
  const run = z >= GH.zRidge ? GH.z1 - GH.zRidge : GH.zRidge - GH.z0;
  return GH.yRidge - (Math.abs(z - GH.zRidge) / run) * (GH.yRidge - GH.yEave);
}

/** 天窗盖：铰链在下沿 (z1, roofY(z1))，向上翻开 openDeg 后的自由边。合拢时从铰链指向上沿（朝 −Z、仰 28.8°）。 */
export function ventLid(): { hinge: V3; free: V3; dir: V3; len: number } {
  const dz = GH_VENT.z1 - GH_VENT.z0;
  const dy = ghRoofY(GH_VENT.z0) - ghRoofY(GH_VENT.z1);
  const len = Math.hypot(dz, dy);
  const closed = Math.atan2(dy, dz);
  const a = closed + (GH_VENT.openDeg * Math.PI) / 180;
  const dir: V3 = [0, Math.sin(a), -Math.cos(a)];
  const hinge: V3 = [(GH_VENT.x0 + GH_VENT.x1) / 2, ghRoofY(GH_VENT.z1), GH_VENT.z1];
  return { hinge, free: [hinge[0], hinge[1] + dir[1] * len, hinge[2] + dir[2] * len], dir, len };
}

/** 推开的门扇：从铰链 (x0, z1) 出发指向自由边的单位方向（朝 +Z 外开）。 */
export function doorLeaf(): { hinge: V3; dir: V3; len: number } {
  const a = (GH_DOOR.openDeg * Math.PI) / 180;
  return { hinge: [GH_DOOR.x0, 0, GH.z1], dir: [Math.cos(a), 0, Math.sin(a)], len: GH_DOOR.x1 - GH_DOOR.x0 - 2 * GH_DOOR.frameT };
}

/**
 * 小阳光房东墙通往大植物园的拱门：开口 z −420..−300（120 宽），从地面到 yTop 直墙、再接半径 r 的半圆拱顶；
 * 东墙的矮墙 / 玻璃在这一段断开，两墙之间 20 cm 的缝用雪松拱框衬起来，地面从 −90 顺一级石阶落到温室地形。
 */
export const GH_ARCH = { z0: -540, z1: -420, yTop: 40, r: 60, frameT: 6 } as const;
/** 东墙柱列：拱门 (−420..−300) 里不立柱，两侧各一根。 */
export const GH_POSTS_EAST_Z = [-560, -540, -420, -400, -280, -160] as const;

/** 室内陈设的尺寸（画面与碰撞共用）。 */
export const GH_FIXTURES = {
  /** 东墙下的双层阶梯原木花架：下层深、上层退后一级。 */
  shelf: {
    xBack: 328,
    z0: -400,
    z1: -198,
    tiers: [
      { x0: 266, y0: -24, y1: -18 },
      { x0: 292, y0: 46, y1: 52 },
    ],
    railR: 1.8,
    postT: 6,
  },
  /** 天窗正下方的三级阶梯花架（顶台正对天窗开口；顶台上的盆靠后摆，落点前半留空）。 */
  stand: {
    z0: -340,
    z1: -250,
    tiers: [
      { x0: 120, x1: 200, y0: -36, y1: -30 },
      { x0: 135, x1: 200, y0: 14, y1: 20 },
      { x0: 150, x1: 200, y0: 70, y1: 76 },
    ],
  },
  /** 西墙下的工作木桌 + 一碟清水陶盘。 */
  table: { x0: -128, x1: -68, z0: -460, z1: -220, y0: 25, y1: 30, legT: 5 },
  dish: { x: -98, z: -340, r: 14, y: 30 },
  /** 横梁（沿 Z 连接南北檐梁），中间那根注册为栖木。 */
  ties: [-20, 100, 220],
  tieY0: 124,
  tieY1: 136,
  /** 铁艺吊篮：挂在脊梁上。 */
  baskets: [
    { x: 20, z: -360, y: 190, r: 18 },
    { x: 250, z: -360, y: 190, r: 18 },
  ],
} as const;

export type PlantKind = 'monstera' | 'fern' | 'camellia' | 'cyclamen' | 'daisy' | 'ivy' | 'geranium';

// ───────────────────────────────────── 大植物园温室（东翼）─────────────────────────────────────

/**
 * 大型春日生态植物园（维多利亚式铸铁拱架玻璃温室）：贯穿院子东侧南北 x 360..1520、z −1180..1180，
 * 檐口 330、拱顶 600（室内净高约 7 m），每半跨 6 段折线拱（consRoofY）；白色铸铁柱 / 拱架 / 檩条 / 拉杆。
 * 西墙朝雪院开双开高玻璃门（CONSV_DOOR），北段贴洋房东山墙的是实心砖墙，中段和小阳光房之间开一道拱门（GH_ARCH）；
 * 西坡上一道 900 cm 长的透气天窗（CONSV_VENT，三扇盖子从下沿撑起）。室内不是硬地，是春日泥土草坪微地形
 * （springHeight，碰撞体同一张高度场）、碎石汀步和一处浅水石槽（TROUGH）。碰撞体中空：矮墙 / 12 cm 厚玻璃 / 立柱 / 檐梁是盒体，拱面是天窗留口的连续斜板。
 */
export const CONSV = {
  x0: 360,
  x1: 1520,
  z0: -1180,
  z1: 1180,
  /** 墙根石台面 / 室内地形的最低处。 */
  yFloor: -104,
  /** 矮墙顶。 */
  yLowWall: -44,
  yEave: 330,
  yRidge: 600,
  xRidge: 940,
  wallT: 16,
  postT: 10,
  /** 玻璃碰撞盒厚度（12 cm，和西墙 / 端墙外皮平齐，内皮留 4 cm 窗台）。 */
  glassT: 12,
  beamT: 10,
  bayZ: 200,
  archSegs: 6,
  /** 西墙柱列 z（双开门 200..440 和拱门 −420..−300 里不立柱）。 */
  postsWestZ: [-1180, -980, -780, -580, -440, -300, -160, 40, 200, 440, 620, 800, 980, 1180],
  postsEastZ: [-1180, -980, -780, -580, -380, -180, 20, 220, 420, 620, 820, 1020, 1180],
  /** 南北端墙柱列 x（到檐口）。 */
  postsEndX: [360, 560, 760, 940, 1120, 1320, 1520],
} as const;

/** 西墙双开高玻璃门：两扇各 120 宽，从石台面到 y1；向外（朝雪院 −X）推开 openDeg。 */
export const CONSV_DOOR = { z0: 200, z1: 440, y1: 226, openDeg: 105, leafT: 4 } as const;
/** 西坡透气天窗：开口占一整段拱（x 748..842），z −300..600，三扇盖子从下沿（x0）撑起 openDeg，开口从上方完全畅通。 */
export const CONSV_VENT = { x0: 748, x1: 842, z0: -300, z1: 600, openDeg: 55, curbH: 12, lidT: 4, lids: 3 } as const;

/** 拱顶折线：西半跨从檐口 (x0, yEave) 到脊 (xRidge, yRidge) 分 archSegs 段，段内线性；东半跨镜像。 */
export function consRoofY(x: number): number {
  const n = CONSV.archSegs;
  const half = CONSV.xRidge - CONSV.x0;
  const u = Math.min(1, Math.abs(x - CONSV.xRidge) / half);
  const H = CONSV.yRidge - CONSV.yEave;
  const yj = (j: number): number => CONSV.yEave + H * Math.sin((1 - j / n) * Math.PI * 0.5);
  const k = Math.min(n - 1, Math.floor(u * n));
  return yj(k) + (yj(k + 1) - yj(k)) * (u * n - k);
}

/** 拱顶折线的节点 x（西檐 → 脊）：k = 0..archSegs。 */
export function consRoofNodeX(k: number): number {
  return CONSV.x0 + ((CONSV.xRidge - CONSV.x0) * k) / CONSV.archSegs;
}

/** 天窗第 i 扇盖子：铰链在下沿 (x0, consRoofY(x0))，盖长 = 开口宽，从下沿往脊的方向撑起。 */
export function consVentLid(i: number): { hinge: V3; free: V3; dir: V3; len: number; z0: number; z1: number } {
  const len = CONSV_VENT.x1 - CONSV_VENT.x0;
  const closed = Math.atan2(consRoofY(CONSV_VENT.x1) - consRoofY(CONSV_VENT.x0), len);
  const a = closed + (CONSV_VENT.openDeg * Math.PI) / 180;
  const dir: V3 = [Math.cos(a), Math.sin(a), 0];
  const dz = (CONSV_VENT.z1 - CONSV_VENT.z0) / CONSV_VENT.lids;
  const z0 = CONSV_VENT.z0 + dz * i;
  const hinge: V3 = [CONSV_VENT.x0, consRoofY(CONSV_VENT.x0) + 3, z0];
  return { hinge, free: [hinge[0] + dir[0] * len, hinge[1] + dir[1] * len, hinge[2]], dir, len, z0, z1: z0 + dz };
}

/** 双开门第 i 扇（0 = 北侧铰链 z0、1 = 南侧铰链 z1）：铰链、指向自由边的单位方向、门扇长。 */
export function consDoorLeaf(i: 0 | 1): { hinge: V3; dir: V3; len: number } {
  const a = (CONSV_DOOR.openDeg * Math.PI) / 180;
  const len = (CONSV_DOOR.z1 - CONSV_DOOR.z0) / 2 - 3;
  return i === 0
    ? { hinge: [CONSV.x0, 0, CONSV_DOOR.z0], dir: [-Math.sin(a), 0, Math.cos(a)], len }
    : { hinge: [CONSV.x0, 0, CONSV_DOOR.z1], dir: [-Math.sin(a), 0, -Math.cos(a)], len };
}

// ───────────────────────────────────── 温室里的春日微地形 ─────────────────────────────────────

/** 春日泥土草坪微地形：温室墙皮以内，20 cm 格（碰撞高度场和画面网格同一张）。 */
export const SPRING = { x0: CONSV.x0 + CONSV.wallT, z0: CONSV.z0 + CONSV.wallT, x1: CONSV.x1 - CONSV.wallT, z1: CONSV.z1 - CONSV.wallT, cell: 20, curbW: 60 } as const;
/** 浅水景石槽：一块下沉的石台上凿出的长方形水槽（实心碰撞盒，槽沿可停）。 */
export const TROUGH = { x0: 700, z0: 520, x1: 860, z1: 610, base: -92, h: 26, water: 9, pad: 190 } as const;
/** 碎石汀步：从西门进来往东北绕到主海棠脚下，一条支径往南到石槽。 */
/** 小径的半宽（cm）：带状网格 55，两侧各再留 5 cm 给路缘砖；草 / 野花在小径两侧 72 cm 内不长。 */
export const PATH_HALF = 55;

/**
 * 沿一条小径每 step cm 重采样一次（Catmull-Rom），返回 (x, z) 和单位切向 (tx, tz)：带状网格 / 路缘砖 / 花境种植都用它。
 * 一段一段地走：每段按长度切成整数份，最后补上终点。
 */
export function samplePath(path: readonly V3[], step: number): { x: number; z: number; tx: number; tz: number }[] {
  const out: { x: number; z: number; tx: number; tz: number }[] = [];
  const P = (i: number): [number, number] => {
    const k = Math.max(0, Math.min(path.length - 1, i));
    return [path[k][0], path[k][2]];
  };
  // Catmull-Rom 在 t 处的值（四个控制点 a b c d）
  const cr = (a: number, b: number, c: number, d: number, t: number): number => {
    const t2 = t * t;
    const t3 = t2 * t;
    return 0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  };
  for (let i = 0; i + 1 < path.length; i++) {
    const p0 = P(i - 1);
    const p1 = P(i);
    const p2 = P(i + 1);
    const p3 = P(i + 2);
    const n = Math.max(1, Math.round(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / step));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const x = cr(p0[0], p1[0], p2[0], p3[0], t);
      const z = cr(p0[1], p1[1], p2[1], p3[1], t);
      const t1 = Math.min(1, t + 0.05);
      const dx = cr(p0[0], p1[0], p2[0], p3[0], t1) - x;
      const dz = cr(p0[1], p1[1], p2[1], p3[1], t1) - z;
      const L = Math.hypot(dx, dz) || 1;
      out.push({ x, z, tx: dx / L, tz: dz / L });
    }
  }
  const last = out[out.length - 1];
  const e = path[path.length - 1];
  if (last) out.push({ x: e[0], z: e[2], tx: last.tx, tz: last.tz });
  return out;
}

export const GRAVEL_PATHS: V3[][] = [
  [[420, 330], [470, 300], [520, 268], [570, 240], [620, 205], [670, 165], [715, 118], [752, 62], [778, 0], [790, -70], [782, -140], [758, -205], [722, -262], [688, -318], [662, -372]].map(([x, z]) => [x, 0, z] as V3),
  [[520, 268], [548, 318], [580, 372], [618, 424], [660, 470], [700, 505], [730, 522]].map(([x, z]) => [x, 0, z] as V3),
  [[778, 0], [830, -40], [884, -96], [930, -160], [962, -228], [980, -292]].map(([x, z]) => [x, 0, z] as V3),
];
/** 春日草坪的范围权重：汀步和石槽上不长草。 */
export function springGrassDensity(x: number, z: number): number {
  const s = SPRING;
  if (x < s.x0 + 14 || x > s.x1 - 14 || z < s.z0 + 14 || z > s.z1 - 14) return 0;
  if (x > TROUGH.x0 - 14 && x < TROUGH.x1 + 14 && z > TROUGH.z0 - 14 && z < TROUGH.z1 + 14) return 0;
  for (const p of GRAVEL_PATHS) if (nearPolyline(x, z, p, PATH_HALF + 17)) return 0;
  for (const t of SPRING_TREES) if ((x - t.base[0]) ** 2 + (z - t.base[2]) ** 2 < 26 * 26) return 0;
  const d = Math.min(x - s.x0, s.x1 - x, z - s.z0, s.z1 - z);
  return smoothstep(14, 90, d) * (0.75 + 0.25 * noise3(x / 210, z / 210, 4.4));
}

/** 地形高度：西门往东抬升的缓坡 + 两个尺度的起伏 + 主海棠脚下的土丘 + 石槽洼地，墙根一圈压平到石台面。 */
export function springHeight(x: number, z: number): number {
  const s = SPRING;
  const u = Math.max(0, Math.min(1, (x - (s.x0 + 20)) / 760));
  let h = CONSV.yFloor + 62 * (u * u * (3 - 2 * u));
  const w = smoothstep(0, 220, x - s.x0) * smoothstep(0, 220, s.x1 - x) * smoothstep(0, 220, z - s.z0) * smoothstep(0, 220, s.z1 - z);
  h += w * (18 * (noise3(x / 430, z / 430, 2.7) - 0.5) * 2 + 6 * (noise3(x / 150 + 3, z / 150, 8.1) - 0.5) * 2);
  const dx = x - 1050;
  const dz = z + 350;
  h += 34 * Math.exp(-(dx * dx + dz * dz) / (2 * 330 * 330)) * w;
  const tx = x - (TROUGH.x0 + TROUGH.x1) / 2;
  const tz = z - (TROUGH.z0 + TROUGH.z1) / 2;
  const pad = Math.exp(-(tx * tx + tz * tz) / (2 * TROUGH.pad * TROUGH.pad));
  h = h * (1 - pad) + TROUGH.base * pad;
  const d = Math.min(x - s.x0, s.x1 - x, z - s.z0, s.z1 - z);
  const k = smoothstep(0, s.curbW, d);
  return CONSV.yFloor * (1 - k) + h * k;
}

/** 春日草坪的碰撞高度场（buildCourtyardWorld 加进 SimWorld；画面网格按同一张节点表建）。 */
export function buildSpringGround(): Heightfield {
  const s = SPRING;
  const field = new Heightfield(s.x0, s.z0, s.x1, s.z1, s.cell);
  field.fill(springHeight);
  return field;
}

// ───────────────────────────────────── 海棠树生成器 ─────────────────────────────────────

/** 一根焊合树的枝条：CurveLayout + 母子枝焊合契约（parent 本表序号 / atPoint 控制点 / at 弧长）+ 海棠特征。 */
export interface CrabLimb extends TreeLimb {
  nodePoints?: number[];
  young?: number;
  berries?: { fruits: number; empty: number };
  berryScale?: number;
  /** 果台 / 花台：短枝，不是栖木（画面层按梢头挂果 / 挂花）。 */
  spur?: boolean;
  /** 花：梢头挂几簇垂丝海棠花（春树）。 */
  blossom?: number;
  /** false = 不是栖木（板根 / 果台），碰撞层不注册。 */
  perch?: boolean;
}

export interface TreePlan {
  seed: number;
  base: V3;
  /** 树干顶（分叉点）。 */
  top: V3;
  trunkR0: number;
  trunkR1: number;
  /** 抓地外扩的板根数（0 = 不要）。 */
  roots: number;
  snow: boolean;
  /** 主冠枝：在树干上的弧长比例、方位角（度，+X 为 0 朝 +Z 为正）、长度、起止仰角（度）。 */
  crown: { t: number; az: number; len: number; elev0: number; elev1: number }[];
  /** 越冬果：果台相对观鸟迷你果的倍数（院心老树 3.8 ≈ 1 cm 的海棠果）。 */
  fruitScale?: number;
  /** 春树：果台改挂花簇。 */
  blossom?: boolean;
  /** 每根二级枝上的细枝数 [最少, 最多]（不填 = 3~5；枝叶繁茂的春树 5~7）。 */
  twigs?: [number, number];
  seg: { trunk: [number, number]; crown: [number, number]; sec: [number, number]; twig: [number, number]; spur: [number, number] };
  /** 禁入区检查（庭院树避开阳光房 / 洋房 / 温室）；室内树不传。 */
  clear?: (pts: V3[], radii: number[], kind: 'crown' | 'sec' | 'twig') => boolean;
}

/** 蜿蜒的枝：从 base 出发，方向从 (az0, elev0) 转到 (az0 + bend, elev1)，方位每步左右摆 zig 度。 */
function windingPoints(base: V3, az0: number, elev0: number, elev1: number, bend: number, zig: number, length: number, n: number, rng: () => number): V3[] {
  const pts: V3[] = [[base[0], base[1], base[2]]];
  const step = length / n;
  for (let k = 1; k <= n; k++) {
    const u = k / n;
    const az = az0 + bend * u + (k % 2 === 0 ? 1 : -1) * zig * (0.4 + 0.6 * rng());
    const d = dirFrom(az, elev0 + (elev1 - elev0) * u);
    const p = pts[k - 1];
    pts.push([p[0] + d[0] * step, p[1] + d[1] * step, p[2] + d[2] * step]);
  }
  return pts;
}

/**
 * 长一棵海棠（院心的越冬老树 / 温室里的春树同一套骨架）：树干（可选板根）→ 在中高处自然分叉成多根蜿蜒收尖的主冠枝 →
 * 二级枝 → 带芽的细枝 → 短果台。全部按母子枝中心轴焊合契约交给 Branches.addWeldedLimbs（枝领 / 叶痕 / 嫩梢在那里生成）。
 */
export function growCrabapple(p: TreePlan): CrabLimb[] {
  const rng = makeRng(p.seed);
  const limbs: CrabLimb[] = [];
  const b = p.base;
  const top = p.top;
  // 树干：微 S 形
  const mid1: V3 = [b[0] + (top[0] - b[0]) * 0.35 + (rng() - 0.5) * 8, b[1] + (top[1] - b[1]) * 0.35, b[2] + (top[2] - b[2]) * 0.35 + (rng() - 0.5) * 8];
  const mid2: V3 = [b[0] + (top[0] - b[0]) * 0.7 + (rng() - 0.5) * 8, b[1] + (top[1] - b[1]) * 0.7, b[2] + (top[2] - b[2]) * 0.7 + (rng() - 0.5) * 8];
  const trunkPts = [b, mid1, mid2, top];
  const trunkRadii = [p.trunkR0, p.trunkR0 * 0.72, p.trunkR0 * 0.58, p.trunkR1];
  limbs.push({ tag: 'tree', points: trunkPts, radii: trunkRadii, segments: p.seg.trunk[0], radial: p.seg.trunk[1], seed: p.seed % 97, snow: p.snow, parent: -1, attach: 0 });
  const trunk = new Axis(trunkPts, trunkRadii, 96);
  const at: V3 = [0, 0, 0];
  const tn: V3 = [0, 0, 0];
  // 板根：从树干低处斜着扎出去、往雪面 / 地面收尖
  for (let k = 0; k < p.roots; k++) {
    const t = 0.2 + rng() * 0.12;
    const r = trunk.at(t, at, tn);
    const az = (k / p.roots) * 360 + rng() * 40;
    const len = 70 + rng() * 50;
    const d = dirFrom(az * DEG, (-28 - rng() * 12) * DEG);
    const pts: V3[] = [[at[0], at[1], at[2]], [at[0] + d[0] * len * 0.5, at[1] + d[1] * len * 0.5 - 6, at[2] + d[2] * len * 0.5], [at[0] + d[0] * len, Math.min(at[1] + d[1] * len, b[1] + 6), at[2] + d[2] * len]];
    limbs.push({ tag: 'root', points: pts, radii: [r * 0.34, r * 0.18, r * 0.05], segments: 10, radial: 8, seed: Math.floor(rng() * 100), snow: p.snow, parent: 0, attach: t, perch: false });
  }
  const clear = p.clear ?? (() => true);
  for (const c of p.crown) {
    const rT = trunk.at(c.t, at, tn);
    const az = (c.az + (rng() - 0.5) * 12) * DEG;
    const elev0 = (c.elev0 - 3 + (rng() - 0.5) * 6) * DEG;
    const elev1 = (c.elev1 + (rng() - 0.5) * 6) * DEG;
    const bend = (rng() - 0.5) * 30 * DEG;
    const zig = (5 + rng() * 6) * DEG;
    const n = 5;
    let len = c.len * (1.02 + rng() * 0.12);
    const radiiOf = (rr: number): number[] => [rr * 0.6, rr * 0.45, rr * 0.28, rr * 0.14, rr * 0.05];
    let pts = windingPoints(at, az, elev0, elev1, bend, zig, len, n, rng);
    for (let tries = 0; tries < 6 && !clear(pts, radiiOf(rT), 'crown'); tries++) {
      len *= 0.88;
      pts = windingPoints(at, az, elev0, elev1, bend, zig, len, n, rng);
    }
    const idx = limbs.length;
    limbs.push({ tag: 'tree', points: pts, radii: radiiOf(rT), segments: p.seg.crown[0], radial: p.seg.crown[1], seed: Math.floor(rng() * 100), snow: p.snow, parent: 0, attach: c.t, young: 0.72, nodePoints: [2, 3] });
    const axis1 = new Axis(pts, radiiOf(rT), 48);
    // 二级枝：沿主冠枝左右交替 4~5 根
    const n2 = 4 + (rng() < 0.5 ? 1 : 0);
    for (let k = 0; k < n2; k++) {
      const t = 0.3 + (k / n2) * 0.58 + (rng() - 0.5) * 0.05;
      const r2 = 0.5 * axis1.at(t, at, tn);
      const a = anglesOf(tn);
      const side = k % 2 === 0 ? 1 : -1;
      const az2 = a.az + side * (40 + rng() * 28) * DEG;
      const e0 = a.elev + (rng() - 0.5) * 14 * DEG;
      const e1 = e0 - (14 + rng() * 12) * DEG;
      const len2 = len * (0.4 + rng() * 0.18) * (1 - 0.3 * t);
      const pts2 = windingPoints(at, az2, e0, e1, side * (6 + rng() * 10) * DEG, (4 + rng() * 5) * DEG, len2, 3, rng);
      const radii2 = [r2, r2 * 0.66, r2 * 0.34, r2 * 0.1];
      if (!clear(pts2, radii2, 'sec')) continue;
      const idx2 = limbs.length;
      limbs.push({ tag: 'tree', points: pts2, radii: radii2, segments: p.seg.sec[0], radial: p.seg.sec[1], seed: Math.floor(rng() * 100), snow: p.snow, spring: SECONDARY_SPRING, parent: idx, attach: t, young: 0.55, nodePoints: [1, 2] });
      const axis2 = new Axis(pts2, radii2, 32);
      // 细枝：二级枝上 3~5 根（春树 7~10 根），带芽
      const n3 = p.twigs ? p.twigs[0] + Math.floor(rng() * (p.twigs[1] - p.twigs[0] + 1)) : 3 + Math.floor(rng() * 3);
      for (let j = 0; j < n3; j++) {
        const t3 = Math.min(1, 0.35 + (j / Math.max(1, n3 - 1)) * 0.6 + (rng() - 0.5) * 0.05);
        const r3 = 0.5 * axis2.at(t3, at, tn);
        const a3 = anglesOf(tn);
        const side3 = j % 2 === 0 ? -1 : 1;
        const az3 = a3.az + side3 * (32 + rng() * 30) * DEG;
        const e3 = a3.elev + (rng() - 0.5) * 18 * DEG;
        const len3 = Math.max(14, len2 * (0.38 + rng() * 0.18));
        const pts3 = windingPoints(at, az3, e3, e3 - (10 + rng() * 14) * DEG, side3 * (8 + rng() * 12) * DEG, 0, len3, 2, rng);
        const radii3 = [Math.max(r3, 0.22), Math.max(r3, 0.22) * 0.5, 0.05];
        if (!clear(pts3, radii3, 'twig')) continue;
        const idx3 = limbs.length;
        limbs.push({ tag: 'tree-twig', points: pts3, radii: radii3, segments: p.seg.twig[0], radial: p.seg.twig[1], seed: Math.floor(rng() * 100), snow: p.snow, spring: TWIG_SPRING, buds: [0.6 + rng() * 0.3], parent: idx2, attach: t3, young: 0.3, nodePoints: [1] });
        // 果台 / 花台：三成的细枝梢头再长一截 3~6 cm 的短枝
        if ((p.fruitScale || p.blossom) && rng() < (p.fruitScale ? 0.2 : 0.3)) pushSpur(limbs, idx3, pts3, radii3, at, tn, rng, p);
      }
      // 二级枝上的果台 / 花台：冬树 1~2 个；盛放的春树 3~5 个沿枝散布（二年生枝上的花台是海棠开花的主体，内膛才有花）
      if (p.fruitScale || p.blossom) {
        const nS = p.blossom ? 3 + Math.floor(rng() * 3) : 1 + (rng() < (p.fruitScale ? 0.3 : 0.5) ? 1 : 0);
        for (let s = 0; s < nS; s++) {
          const ts = 0.28 + rng() * 0.62;
          const rs = Math.min(0.5 * axis2.at(ts, at, tn), 0.6);
          const as = anglesOf(tn);
          const azS = as.az + (rng() < 0.5 ? 1 : -1) * (50 + rng() * 40) * DEG;
          const eS = Math.max(as.elev - (15 + rng() * 25) * DEG, -25 * DEG);
          const lenS = 3 + rng() * 3;
          const d = dirFrom(azS, eS);
          const ptsS: V3[] = [[at[0], at[1], at[2]], [at[0] + d[0] * lenS * 0.5, at[1] + d[1] * lenS * 0.5, at[2] + d[2] * lenS * 0.5], [at[0] + d[0] * lenS, at[1] + d[1] * lenS, at[2] + d[2] * lenS]];
          if (clear && !clear(ptsS, [rs, rs * 0.5, 0.14], 'twig')) continue;
          limbs.push(spurLimb(ptsS, rs, idx2, ts, rng, p));
        }
      }
    }
  }
  return limbs;
}

function spurLimb(pts: V3[], rParent: number, parent: number, attach: number, rng: () => number, p: TreePlan): CrabLimb {
  const r = Math.min(rParent, 0.6);
  const base: CrabLimb = { tag: 'spur', points: pts, radii: [r, r * 0.5, 0.14], segments: p.seg.spur[0], radial: p.seg.spur[1], seed: Math.floor(rng() * 100), snow: false, parent, attach, nodePoints: [1], young: 0.6, spur: true, perch: false };
  if (p.fruitScale) base.berries = { fruits: 3 + Math.floor(rng() * 3), empty: rng() < 0.3 ? 1 : 0 };
  if (p.blossom) base.blossom = 1;
  return base;
}

function pushSpur(limbs: CrabLimb[], parentIdx: number, parentPts: V3[], parentRadii: number[], at: V3, tn: V3, rng: () => number, p: TreePlan): void {
  const tip = parentPts[parentPts.length - 1];
  const prev = parentPts[parentPts.length - 2];
  const d0 = Math.hypot(tip[0] - prev[0], tip[1] - prev[1], tip[2] - prev[2]) || 1;
  tn[0] = (tip[0] - prev[0]) / d0;
  tn[1] = (tip[1] - prev[1]) / d0;
  tn[2] = (tip[2] - prev[2]) / d0;
  const a = anglesOf(tn);
  const azS = a.az + (rng() < 0.5 ? 1 : -1) * (40 + rng() * 30) * DEG;
  const eS = Math.max(a.elev - (10 + rng() * 20) * DEG, -25 * DEG);
  const lenS = 3 + rng() * 3;
  const d = dirFrom(azS, eS);
  at[0] = tip[0];
  at[1] = tip[1];
  at[2] = tip[2];
  const pts: V3[] = [[tip[0], tip[1], tip[2]], [tip[0] + d[0] * lenS * 0.5, tip[1] + d[1] * lenS * 0.5, tip[2] + d[2] * lenS * 0.5], [tip[0] + d[0] * lenS, tip[1] + d[1] * lenS, tip[2] + d[2] * lenS]];
  limbs.push(spurLimb(pts, parentRadii[parentRadii.length - 2] * 2, parentIdx, 0.92, rng, p));
}

/** 越冬的院心海棠老树：板根抓地、主干在 y≈330 分叉成 5 根主冠枝（其中一根低处的大侧枝），果台挂满越冬红果。 */
export function growCourtyardTree(): CrabLimb[] {
  return growCrabapple({
    seed: 23,
    base: TREE_BASE,
    top: [TREE_BASE[0] + 6, 330, TREE_BASE[2] - 12],
    trunkR0: 30,
    trunkR1: 10.5,
    roots: 6,
    snow: true,
    fruitScale: 3.8,
    seg: { trunk: [40, 20], crown: [28, 12], sec: [14, 7], twig: [6, 4], spur: [4, 4] },
    clear: limbClear,
    crown: [
      { t: 0.7, az: -114, len: 440, elev0: 34, elev1: 12 },
      { t: 0.62, az: -52, len: 400, elev0: 44, elev1: 18 },
      { t: 0.9, az: 96, len: 360, elev0: 46, elev1: 22 },
      { t: 0.84, az: 172, len: 340, elev0: 44, elev1: 16 },
      { t: 1.0, az: 8, len: 330, elev0: 58, elev1: 36 },
      { t: 0.96, az: -150, len: 300, elev0: 54, elev1: 30 },
      { t: 0.93, az: 52, len: 300, elev0: 52, elev1: 30 },
      { t: 0.98, az: -16, len: 260, elev0: 62, elev1: 40 },
    ],
  });
}

/**
 * 温室里的春日树：两棵垂丝海棠（主树盛放）+ 一棵枝叶繁茂的阔叶树，长在 springHeight 的坡上。
 * 高度按拱顶净空定：主海棠 495、阔叶树 475（2026-11-23 各下压 25 cm），梢头离拱面玻璃至少一个板厚（8 cm），不穿顶梁。
 */
export const SPRING_TREES: { kind: 'crabapple' | 'broadleaf'; base: V3; height: number; seed: number }[] = [
  { kind: 'crabapple', base: [1050, 0, -350], height: 495, seed: 101 },
  { kind: 'crabapple', base: [620, 0, -380], height: 390, seed: 102 },
  { kind: 'broadleaf', base: [1200, 0, 340], height: 475, seed: 103 },
];

/**
 * 进出通道的飞行路径折线（落点在 CORRIDORS 里按生成好的树算）。单独放在树生成器之前：
 * 春树长枝时要躲开这些航线（springTreeClear），而航线末端的落点又要从生成好的树上取——两条定义不能互相等。
 */
const CORRIDOR_PATHS: Record<string, V3[]> = {
  door: [
    [96, 10, 220],
    [96, 10, -120],
    [96, 0, -205],
    [160, -5, -225],
    [230, -8, -235],
    [262, -8, -242],
  ],
  vent: [
    [170, 430, -290],
    [170, 275, -290],
    [170, 215, -290],
    [170, 150, -290],
    [168, 104, -282],
  ],
  // 大植物园西门：从雪院低空进双开门，掠过缓坡草坪，落到石槽北沿
  'cons-door': [
    [240, -60, 320],
    [300, -70, 320],
    [340, -78, 320],
    [380, -82, 320],
    [450, -78, 340],
    [520, -74, 380],
    [600, -70, 430],
    [680, -56, 480],
    [780, -40, 524],
  ],
  // 大植物园天窗：从拱顶正上方俯冲穿过撑开的盖子，落到主海棠的冠枝上
  'cons-vent': [
    [795, 790, 100],
    [795, 700, 100],
    [795, 640, 100],
    [795, 560, 100],
    [795, 480, 100],
    [850, 440, 0],
    [930, 390, -220],
    [985, 330, -350],
    [1005, 300, -400],
  ],
  // 小阳光房 → 拱门 → 大植物园：贴着草坪低飞进来，到第二棵海棠下方再顺着它的主冠枝爬升到落点
  arch: [
    [280, -30, -480],
    [330, -40, -480],
    [362, -52, -480],
    [400, -60, -478],
    [460, -60, -462],
    [520, -58, -435],
    [580, -40, -428],
    [612, 30, -440],
    [630, 95, -458],
    [647, 150, -460],
    [647, 182, -450],
  ],
};

/** 点到折线的最近距离（沿每段线段采样）。 */
function distToPath(p: V3, path: V3[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i];
    const b = path[i + 1];
    const abx = b[0] - a[0];
    const aby = b[1] - a[1];
    const abz = b[2] - a[2];
    const len2 = abx * abx + aby * aby + abz * abz || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby + (p[2] - a[2]) * abz) / len2));
    best = Math.min(best, Math.hypot(p[0] - a[0] - abx * t, p[1] - a[1] - aby * t, p[2] - a[2] - abz * t));
  }
  return best;
}

/** 春树的禁入区：温室里进出航线（西门 / 天窗 / 拱门）周围 34 cm 内不长二级枝 / 细枝；主冠枝是航线落点的载体，不查
 *  （落点就在主冠枝上，航线的末段本来就贴着它飞）。 */
function springTreeClear(pts: V3[], _radii: number[], kind?: 'crown' | 'sec' | 'twig'): boolean {
  if (kind === 'crown') return true;
  for (const [name, path] of Object.entries(CORRIDOR_PATHS)) {
    if (name === 'door' || name === 'vent') continue;
    for (let i = 0; i < pts.length; i++) {
      // 控制点 + 相邻控制点的中点都要查（样条在两点之间还会鼓出去一点，34 cm 的余量足够）
      const p = pts[i];
      const q = i + 1 < pts.length ? [(p[0] + pts[i + 1][0]) / 2, (p[1] + pts[i + 1][1]) / 2, (p[2] + pts[i + 1][2]) / 2] as V3 : null;
      for (const s of q ? [p, q] : [p]) {
        if (distToPath(s, path) < 34) return false;
      }
    }
  }
  return true;
}

function growSpringTree(t: { kind: 'crabapple' | 'broadleaf'; base: V3; height: number; seed: number }, i: number): CrabLimb[] {
  const y = springHeight(t.base[0], t.base[2]) - 12;
  const h = t.height;
  const fork = 0.58;
  const crab = t.kind === 'crabapple';
  return growCrabapple({
    seed: t.seed,
    base: [t.base[0], y, t.base[2]],
    top: [t.base[0] + 6, y + h * fork, t.base[2] - 4],
    trunkR0: crab ? h * 0.045 : h * 0.05,
    trunkR1: crab ? h * 0.018 : h * 0.02,
    roots: 0,
    snow: false,
    blossom: crab,
    twigs: [7, 10],
    clear: springTreeClear,
    seg: { trunk: [20, 12], crown: [16, 8], sec: [10, 6], twig: [5, 3], spur: [4, 3] },
    crown: [
      { t: 0.78, az: -120 + i * 40, len: h * 0.62, elev0: 48, elev1: 20 },
      { t: 0.86, az: -30 + i * 40, len: h * 0.58, elev0: 54, elev1: 26 },
      { t: 0.94, az: 60 + i * 40, len: h * 0.6, elev0: 50, elev1: 22 },
      { t: 1.0, az: 150 + i * 40, len: h * 0.56, elev0: 60, elev1: 34 },
    ],
  });
}

/** 三棵春树的全部枝条（第一次调用时生成一次：画面 / 碰撞 / 走廊落点读同一份）。 */
let springLimbsCache: CrabLimb[][] | null = null;
export function springTreeLimbs(): CrabLimb[][] {
  if (!springLimbsCache) springLimbsCache = SPRING_TREES.map(growSpringTree);
  return springLimbsCache;
}

/** 这根枝算不算栖木（碰撞层只注册能落脚的枝：树干 / 主冠枝 / 二级枝 / 细枝，板根和果台不算）。画面层和碰撞层按同一个判式各筛一遍，序号才对得上。 */
export const isPerchLimb = (l: CrabLimb): boolean => l.perch !== false && l.tag !== 'root' && l.tag !== 'spur';

/**
 * 一棵树的栖木 → 碰撞层曲线。带悬臂弹簧的枝（二级枝 / 细枝）顺便挂到母枝的振子上：springParent = 母枝曲线在这批里的序号 + base。
 * @param base 这批曲线在布局里的起始序号（buildCourtyardLayout 按累计长度给）。
 */
export function perchCurvesOf(limbs: CrabLimb[], tagPrefix = '', base = 0): CurveLayout[] {
  const out: CurveLayout[] = [];
  /** 每根枝在这批里的序号（不是栖木的 = −1）。 */
  const ordinal = new Int32Array(limbs.length).fill(-1);
  for (const [li, l] of limbs.entries()) {
    if (!isPerchLimb(l)) continue;
    ordinal[li] = out.length;
    const c: CurveLayout = { tag: tagPrefix + l.tag, points: l.points, radii: l.radii, segments: l.segments, radial: l.radial, seed: l.seed, snow: l.snow, buds: l.buds, spring: l.spring };
    // 母枝自己也会弯（细枝焊在二级枝上）：母枝弯了多少，细枝的根跟着走多少
    const parent = l.parent > 0 ? limbs[l.parent] : undefined;
    if (l.spring && parent?.spring && parent.parent !== undefined && parent.parent >= 0 && ordinal[l.parent] >= 0) {
      c.springParent = base + ordinal[l.parent];
      c.springAt = l.attach ?? 0;
    }
    out.push(c);
  }
  return out;
}

/** 树枝上离弧长比例 t 处的点上方 2 cm（走廊落点）。 */
export function limbLanding(limbs: CrabLimb[], index: number, t: number): V3 {
  const l = limbs[index];
  const axis = new Axis(l.points, l.radii, 64);
  const p: V3 = [0, 0, 0];
  const tn: V3 = [0, 0, 0];
  const r = axis.at(t, p, tn);
  return [p[0], p[1] + r + 2, p[2]];
}

export interface PotSpec {
  kind: PlantKind;
  /** 盆底中心（盆底所在高度）。 */
  x: number;
  y: number;
  z: number;
  /** 盆口半径 / 盆高。 */
  r: number;
  h: number;
  /** 植株尺度（1 = 标准大小）。 */
  scale: number;
  /** 花色。 */
  hue: number;
  seed: number;
}

const pot = (kind: PlantKind, x: number, y: number, z: number, r: number, h: number, scale: number, hue: number, seed: number): PotSpec => ({
  kind, x, y, z, r, h, scale, hue, seed,
});

/** 温室里的全部花盆（地面大盆 / 花架中盆 / 桌上小盆 / 吊篮不算盆）。 */
export const POTS: PotSpec[] = [
  // 地面大盆
  pot('monstera', -50, GH.yFloor, -490, 24, 34, 1.0, 0, 1),
  pot('fern', 90, GH.yFloor, -500, 22, 30, 1.0, 0, 2),
  pot('camellia', 240, GH.yFloor, -500, 20, 28, 1.0, 0.0, 3),
  pot('camellia', 230, GH.yFloor, -230, 18, 26, 0.85, 0.93, 4),
  pot('monstera', -40, GH.yFloor, -215, 16, 22, 0.6, 0, 5),
  pot('fern', -100, GH.yFloor, -195, 14, 20, 0.6, 0, 6),
  // 花架上层
  pot('cyclamen', 310, 52, -383, 11, 14, 1.0, 0.95, 11),
  pot('daisy', 310, 52, -349, 11, 14, 1.0, 0.13, 12),
  pot('geranium', 310, 52, -315, 11, 14, 1.0, 0.0, 13),
  pot('daisy', 310, 52, -281, 11, 14, 1.0, 0.13, 14),
  pot('cyclamen', 310, 52, -247, 11, 14, 1.0, 0.83, 15),
  pot('geranium', 310, 52, -213, 11, 14, 1.0, 0.98, 16),
  // 花架下层
  pot('fern', 296, -18, -382, 13, 16, 0.7, 0, 21),
  pot('ivy', 296, -18, -342, 13, 16, 0.9, 0, 22),
  pot('cyclamen', 296, -18, -302, 13, 16, 1.0, 0.6, 23),
  pot('fern', 296, -18, -262, 13, 16, 0.7, 0, 24),
  pot('geranium', 296, -18, -222, 13, 16, 1.0, 0.05, 25),
  // 阶梯花架
  pot('daisy', 168, -30, -300, 12, 15, 1.0, 0.13, 31),
  pot('cyclamen', 168, 20, -300, 12, 15, 1.0, 0.9, 32),
  pot('geranium', 184, 76, -326, 10, 12, 0.8, 0.0, 33),
  // 工作桌上
  pot('daisy', -112, 30, -430, 8, 10, 0.7, 0.13, 41),
  pot('cyclamen', -86, 30, -250, 8, 10, 0.7, 0.95, 42),
  pot('ivy', -112, 30, -260, 8, 10, 0.7, 0, 43),
];

// ───────────────────────────────────── 院心大树 ─────────────────────────────────────

/** 树干根部（雪面下）：贴着主角枝粗端的后方 3 cm，主角枝 2.4 的基部整个藏在干里。 */
export const TREE_BASE: V3 = [-49, -131, -14];

const DEG = Math.PI / 180;

/** 方位角（+X 为 0，朝 +Z 为正）+ 仰角 → 单位方向。 */
function dirFrom(az: number, elev: number): V3 {
  const c = Math.cos(elev);
  return [c * Math.cos(az), Math.sin(elev), c * Math.sin(az)];
}

function anglesOf(d: readonly number[]): { az: number; elev: number } {
  const h = Math.hypot(d[0], d[2]);
  return { az: Math.atan2(d[2], d[0]), elev: Math.atan2(d[1], h) };
}

class Axis {
  private readonly centers: Float64Array;
  private readonly radii: readonly number[];
  private readonly div: number;
  constructor(points: readonly V3[], radii: readonly number[], div = 64) {
    this.radii = radii;
    this.div = div;
    this.centers = sampleArc(flattenPoints(points), points.length, div).centers;
  }
  at(t: number, outP: V3, outT: V3): number {
    const c = this.centers;
    const i = Math.round(Math.min(1, Math.max(0, t)) * this.div);
    outP[0] = c[i * 3];
    outP[1] = c[i * 3 + 1];
    outP[2] = c[i * 3 + 2];
    const a = Math.max(0, i - 1) * 3;
    const b = Math.min(this.div, i + 1) * 3;
    const dx = c[b] - c[a];
    const dy = c[b + 1] - c[a + 1];
    const dz = c[b + 2] - c[a + 2];
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    outT[0] = dx / len;
    outT[1] = dy / len;
    outT[2] = dz / len;
    return interpKeys(this.radii as number[], i / this.div);
  }
}

/**
 * 二级枝 / 细枝的悬臂弹簧（2026-11-23 改悬臂模式）：根部焊在母枝上不动、梢端最大（振型 (s/L)²），鸟站上时静态下垂、离枝回弹。
 * gain 按"一跳的蹬速 ≈ 83 cm/s"定：二级枝梢端沉 ~1.3 cm、细枝 ~1.8 cm（枝中段只有四分之一）（旧的 0.04 / 0.1 是给几百 cm/s 的落球定的，鸟一跳只有 2 mm，看不见）。
 * 主干和一级主冠枝（parent = 0）保持刚性：以前的 PRIMARY_SPRING 已去掉。
 */
const SECONDARY_SPRING: SpringParams = { freq: 2.4, damping: 0.08, gain: 0.2, mode: 'cantilever', sag: 0.4 };
const TWIG_SPRING: SpringParams = { freq: 4.5, damping: 0.06, gain: 0.55, mode: 'cantilever', sag: 0.8 };

/**
 * 观鸟微距的预设机位（庭院坐标：主角枝沿 +X、鸟横站面朝 +Z）：az = 相机方位（+Z 为 0、向 +X 为正）、el = 仰角、dist = 离靶心的距离。
 * 由观鸟入口 core/App.ts 的 VIEWS 镜像映射过来（az = −az_index − π/2、target = (−z, y, −x)），画面的 VIEWS 和下面的视线锥都读这一份。
 * 顺序 = 面板"视角"分段的顺序。
 */
export const WATCH_VIEWS: { az: number; el: number; dist: number; target: V3 }[] = [
  // 开场机位：三分之四（相机在鸟的右前侧 55°），右前景是海棠果枝、身后是阳光房的砖墙和玻璃
  { az: -0.95, el: 0.14, dist: 12, target: [0.2, 2.0, -0.3] },
  { az: -Math.PI / 2, el: 0.05, dist: 11.5, target: [0, 2.4, -0.6] },
  { az: -0.18, el: 0.08, dist: 11.5, target: [0, 2.1, 0.3] },
  { az: -Math.PI + 0.2, el: 0.2, dist: 12, target: [0, 2.5, -0.5] },
  { az: -0.82, el: 0.1, dist: 4.6, target: [-0.05, 3.55, 0.6] },
  { az: -1.22, el: 0.3, dist: 13, target: [0, 1.6, -3.5] },
  { az: -1.07, el: 0.2, dist: 28, target: [0, 2, -2] },
  { az: 2 * Math.PI - 3.26, el: 1.18, dist: 10, target: [0, 2.4, -0.5] },
  { az: -0.55, el: 0.8, dist: 10.5, target: [0, 2.5, -0.2] },
  { az: Math.PI - 0.04, el: 0.08, dist: 10, target: [0, 2.5, -0.4] },
];
/** 预设机位的相机位置（世界坐标）。 */
export const watchCamera = (v: { az: number; el: number; dist: number; target: V3 }): V3 => {
  const c = Math.cos(v.el);
  return [v.target[0] + v.dist * c * Math.sin(v.az), v.target[1] + v.dist * Math.sin(v.el), v.target[2] + v.dist * c * Math.cos(v.az)];
};

/**
 * 观鸟视线锥：从每个预设机位的相机到鸟（靶心）之间、张角 = 竖直视场 28° 在 16:9 下的横向半角（约 24°）再加枝条半径的余量（取 27°）。
 * 老海棠的枝条不许伸进锥里——观鸟态背景整层虚化，一根虚掉的细枝横在锐利的小鸟前面就是一道糊掉的影子。
 * 只管相机到鸟这一段（再远 5% 以内）：鸟身后的枝条是背景，本来就该在那儿。默认机位 threequarter 本来就干净（探针 0 根），
 * 挡住的是正面 / 尾部 / 远景 / 俯视 / 正后方几个预设共用的同一根二级细枝。
 */
const WATCH_CONES: { c: V3; f: V3; d: number; cosHalf: number }[] = WATCH_VIEWS.map((v) => {
  const c = watchCamera(v);
  const f: V3 = [v.target[0] - c[0], v.target[1] - c[1], v.target[2] - c[2]];
  const d = Math.hypot(f[0], f[1], f[2]);
  for (let k = 0; k < 3; k++) f[k] /= d;
  return { c, f, d, cosHalf: Math.cos((27 * Math.PI) / 180) };
});

/**
 * 枝条禁入区（AABB，见下方 NO_GO）：阳光房的空气 + 屋面 + 天窗盖、洋房 + 屋面 + 雨棚 + 阳台楼板、电线杆、路灯。
 * 枝条采样点（按枝条半径外扩）落进去就不要：一级枝缩短重长，二三级枝直接放弃。
 * 观鸟管线那棵老海棠搬进院子时也走它（growCrabappleTree 的 avoid 钩子）：树冠朝着阳光房那一侧被修剪得短一些，
 * 伸进观鸟预设机位视线锥的枝条也一并剪掉（见 WATCH_CONES）。
 */
export function limbClear(points: readonly V3[], radii: readonly number[]): boolean {
  const axis = new Axis(points, radii, 24);
  const p: V3 = [0, 0, 0];
  const tn: V3 = [0, 0, 0];
  for (let i = 2; i <= 22; i++) {
    const r = axis.at(i / 24, p, tn) + 10;
    for (const z of NO_GO) {
      if (p[0] > z.min[0] - r && p[0] < z.max[0] + r && p[1] > z.min[1] - r && p[1] < z.max[1] + r && p[2] > z.min[2] - r && p[2] < z.max[2] + r) return false;
    }
    // 观鸟视线锥：采样点（含枝条半径）在锥内、且离相机比鸟近（或只远 5%）就不要。离镜头 1 cm 内的也不许（整根枝都看不见了）
    const rr = r - 10;
    for (const cone of WATCH_CONES) {
      const vx = p[0] - cone.c[0];
      const vy = p[1] - cone.c[1];
      const vz = p[2] - cone.c[2];
      const camD = Math.hypot(vx, vy, vz);
      if (camD < rr + 1.5) return false;
      const along = vx * cone.f[0] + vy * cone.f[1] + vz * cone.f[2];
      if (along <= 0 || along > cone.d * 1.05) continue;
      const perp = Math.hypot(vx - cone.f[0] * along, vy - cone.f[1] * along, vz - cone.f[2] * along);
      if (Math.atan2(perp - rr, along) < (27 * Math.PI) / 180) return false;
    }
  }
  return true;
}


// ───────────────────────────────────── 院落设施 ─────────────────────────────────────

/** 木电线杆（西南角，栅栏内 150 cm；原来在东南角，东翼盖了大植物园后挪过来，电线不再穿温室）。 */
export const POLE = { x0: -958, x1: -942, z0: 542, z1: 558, y0: -135, y1: 590, arms: [560, 520] } as const;
/** 跨院双层下垂电线：从木杆横担两端的瓷瓶连到洋房西山墙的檐口（进户线），斜跨西南草坪上空。 */
export const WIRES = {
  a: [-950, 568, 530] as V3,
  b: [-950, 528, 570] as V3,
  pA: [-724, 745, -700] as V3,
  pB: [-724, 705, -650] as V3,
  sag: [70, 64] as const,
};

/** 栅栏：高 110，柱距 200，两道横杆，南侧留院门。 */
export const FENCE = {
  yTop: -15,
  postT: 10,
  railT: 5,
  railH: 8,
  rails: [-30, -72] as const,
  gate: { x0: -300, x1: -200 } as const,
  spacing: 200,
} as const;

/** 汀步：从院门绕到阳光房门口的主径，再去洋房正门，一条支径到长椅。每 50 cm 一块。 */
export const STONE_PATHS: V3[][] = [
  [
    [-250, 1150], [-245, 1095], [-235, 1040], [-222, 986], [-205, 934], [-183, 884], [-158, 836], [-130, 790], [-100, 747], [-70, 706],
    [-40, 666], [-12, 626], [12, 586], [32, 545], [48, 502], [60, 458], [70, 413], [78, 367], [84, 320], [88, 272],
    [92, 224], [94, 176], [95, 128], [96, 80], [96, 32], [96, -16], [96, -64], [96, -112], [96, -150],
  ].map(([x, z]) => [x, 0, z] as V3),
  [
    [-12, 626], [-40, 580], [-70, 540], [-100, 498], [-130, 456], [-160, 414], [-190, 372], [-215, 328], [-236, 282], [-252, 234],
    [-262, 186], [-268, 138], [-270, 90], [-268, 42], [-262, -6], [-252, -54], [-240, -102], [-228, -150], [-218, -198], [-210, -246],
    [-206, -294], [-208, -342], [-214, -390], [-222, -438], [-230, -486], [-236, -530],
  ].map(([x, z]) => [x, 0, z] as V3),
  [
    [-206, -294], [-240, -300], [-275, -304], [-310, -306], [-345, -306],
  ].map(([x, z]) => [x, 0, z] as V3),
];
/** 每块石板的半径（按顺序循环，带一点确定性变化）。 */
export function stoneRadius(i: number): number {
  return 25 + 5 * noise3(i * 1.7, 3.3, 7.1);
}

/** 院落木长椅：面朝 +X（阳光房 / 大树方向），椅背在西侧。 */
export const BENCH = { x0: -424, x1: -370, z0: -290, z1: -110, seatY: -76, seatT: 6, backTop: -22, backT: 6 } as const;

/** 庭院弯头暖光路灯。 */
export const LAMP = { x: 150, z: 430, postR: 4.5, yTop: 140, lantern: { x: 112, y: 112, z: 430, w: 24, h: 32 } } as const;

/** 墙角枯苇丛：高 150~200 cm 的芦苇状枯茎。 */
export const REED_CLUMPS: { x: number; z: number; r: number; count: number }[] = [
  { x: -1040, z: 1130, r: 70, count: 140 },
  { x: 1580, z: 1100, r: 50, count: 100 },
  { x: -1040, z: -480, r: 60, count: 110 },
  { x: -760, z: -600, r: 55, count: 90 },
  { x: -760, z: -900, r: 55, count: 90 },
  { x: -980, z: -250, r: 55, count: 90 },
];

// ───────────────────────────────────── 积雪枯草地 ─────────────────────────────────────

export const GRASS = {
  count: 16000,
  seed: 31,
  /** 草叶高度范围（cm）。 */
  hMin: 12,
  hMax: 40,
  /** 狗尾草穗数量。 */
  heads: 2000,
  headHMin: 26,
  headHMax: 44,
} as const;

/** 点是否在轴对齐盒内（含边界）。 */
export function pointInBox(x: number, y: number, z: number, min: readonly number[], max: readonly number[]): boolean {
  return x >= min[0] && x <= max[0] && y >= min[1] && y <= max[1] && z >= min[2] && z <= max[2];
}

function distToSegment2(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2));
  const cx = ax + dx * t;
  const cz = az + dz * t;
  return (px - cx) ** 2 + (pz - cz) ** 2;
}

function nearPolyline(px: number, pz: number, pts: readonly V3[], radius: number): boolean {
  for (let i = 1; i < pts.length; i++) {
    if (distToSegment2(px, pz, pts[i - 1][0], pts[i - 1][2], pts[i][0], pts[i][2]) < radius * radius) return true;
  }
  return false;
}

/**
 * 枯草密度 0..1：阳光房 / 洋房 / 长椅脚下 / 石板径上不长；门前留出一条稀疏的进出走廊；
 * 西南草坪最密，墙根一带（除枯苇丛）偏疏；成簇分布（两个尺度的噪声相乘）。
 */
export function grassDensity(x: number, z: number): number {
  if (pointInBox(x, 0, z, [GH.x0 - 30, 0, GH.z0 - 20], [GH.x1 + 30, 0, GH.z1 + 30])) return 0;
  if (pointInBox(x, 0, z, [HOUSE.x0 - 40, 0, HOUSE.z0 - 40], [HOUSE.x1 + 40, 0, HOUSE.z1 + 40])) return 0;
  if (pointInBox(x, 0, z, [CONSV.x0 - 20, 0, CONSV.z0 - 20], [CONSV.x1 + 20, 0, CONSV.z1 + 20])) return 0;
  if (pointInBox(x, 0, z, [BENCH.x0 - 20, 0, BENCH.z0 - 20], [BENCH.x1 + 20, 0, BENCH.z1 + 20])) return 0;
  for (const path of STONE_PATHS) if (nearPolyline(x, z, path, 42)) return 0;
  for (const c of REED_CLUMPS) if ((x - c.x) ** 2 + (z - c.z) ** 2 < c.r * c.r * 0.5) return 0.1;
  // 门前走廊：稀疏（小花房的门、大植物园的西门）
  let gate = 1;
  if (x > 40 && x < 160 && z > -160 && z < 260) gate = 0.12;
  if (x > 200 && x < 372 && z > 180 && z < 460) gate = Math.min(gate, 0.1);
  // 区域权重：西南草坪 1，院北靠近洋房 0.55，东北（电线杆一带）0.7
  let w = 1;
  if (z < -300) w *= 0.6;
  if (x > 500) w *= 0.7;
  if (z > 950) w *= 0.85;
  const clump = noise3(x / 95, z / 95, 3.7) * 0.65 + noise3(x / 31 + 7.1, z / 31 + 2.3, 9.2) * 0.35;
  const d = Math.max(0, (clump - 0.36) / 0.64);
  return Math.min(1, d * d * 2.6 * w * gate);
}

// ───────────────────────────────────── 通道与检验 ─────────────────────────────────────

/** 鸟身碰撞球半径的一半再加余量：通道里每个采样点离任何碰撞体至少这么远。 */
export const CLEARANCE = 6;

export interface Corridor {
  name: string;
  /** 飞行路径折线（从院外到室内落点上方）。 */
  points: V3[];
  /** 最后落定的落点（栖木 / 花架顶面上方 2 cm）。 */
  landing: V3;
}

/** 进出通道：小花房的半开玻璃门（东侧留出的净空）和撑开的天窗；大植物园的西门、天窗和从小花房过去的拱门。
 *  路径折线在 CORRIDOR_PATHS（春树长枝时躲开它们），落点在这里按生成好的树算。 */
export const CORRIDORS: Corridor[] = [
  { name: 'door', points: CORRIDOR_PATHS.door, landing: [266, -14, -244] },
  { name: 'vent', points: CORRIDOR_PATHS.vent, landing: [165, 78, -280] },
  // 大植物园西门：落到石槽北沿压顶石上（压顶高出壁顶 4 cm，宽 15 cm）
  { name: 'cons-door', points: CORRIDOR_PATHS['cons-door'], landing: [(TROUGH.x0 + TROUGH.x1) / 2, TROUGH.base + TROUGH.h + 6, TROUGH.z0 + 4.5] },
  // 大植物园天窗：落到主海棠的冠枝上
  { name: 'cons-vent', points: CORRIDOR_PATHS['cons-vent'], landing: limbLanding(springTreeLimbs()[0], 1, 0.35) },
  // 小阳光房 → 拱门 → 大植物园，落到第二棵海棠的冠枝上
  { name: 'arch', points: CORRIDOR_PATHS.arch, landing: limbLanding(springTreeLimbs()[1], 1, 0.35) },
];

/** 阳光房室内净空盒（球探针的落点必须在这里面）。 */
export const GH_INTERIOR = { min: [GH.x0 + 12, GH.yFloor, GH.z0 + 4] as V3, max: [GH.x1 - 12, GH.yRidge - 10, GH.z1 - 12] as V3 };

/** 点是否在阳光房室内（墙内、地板之上、屋面玻璃之下）。 */
export function insideGreenhouse(x: number, y: number, z: number): boolean {
  return x > GH.x0 + GH.wallT && x < GH.x1 - GH.wallT && z > GH.z0 + 4 && z < GH.z1 - GH.wallT && y > GH.yFloor && y < ghRoofY(z) - GH.roofT - 1;
}

/** 枝条禁入区。 */
const NO_GO: { min: V3; max: V3 }[] = [
  { min: [GH.x0 - 8, GH.yFloor - 20, GH.z0 - 8], max: [GH.x1 + 8, GH.yRidge + 16, GH.z1 + 8] },
  { min: [GH_VENT.x0 - 10, 180, GH_VENT.z0 - 12], max: [GH_VENT.x1 + 10, 282, GH_VENT.z1 + 10] },
  { min: [HOUSE.x0 - 50, -130, HOUSE.z0 - 50], max: [HOUSE.x1 + 50, HOUSE.yRidge + 24, AWNING.zOut - 6] },
  { min: [CONSV.x0 - 10, CONSV.yFloor - 30, CONSV.z0 - 10], max: [CONSV.x1 + 10, CONSV.yRidge + 70, CONSV.z1 + 10] },
  { min: [POLE.x0 - 30, -140, POLE.z0 - 30], max: [POLE.x1 + 30, POLE.y1 + 20, POLE.z1 + 30] },
  { min: [LAMP.x - 30, -140, LAMP.z - 30], max: [LAMP.x + 30, LAMP.lantern.y + LAMP.lantern.h + 20, LAMP.z + 30] },
];

// ───────────────────────────────────── 布局组装 ─────────────────────────────────────

function line(tag: string, a: V3, b: V3, r: number, per = 5): CurveLayout {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  return { tag, points: [a, b], radii: [r, r], segments: Math.max(2, Math.round(len / per)) };
}

/** 闭合多边形栖木（花盆口沿 / 吊篮沿）。 */
function ring(tag: string, cx: number, cy: number, cz: number, r: number, tube: number, n = 16): CurveLayout {
  const pts: V3[] = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push([cx + Math.cos(a) * r, cy, cz + Math.sin(a) * r]);
  }
  return { tag, points: pts, radii: [tube, tube], segments: n * 2 };
}

function box(tag: string, min: V3, max: V3): { tag: string; min: V3; max: V3 } {
  return { tag, min, max };
}

/** 沿 z 倾斜的斜板：顶面从 (zA, yA) 走到 (zB, yB)，x 范围 x0..x1（洋房双坡顶、雨棚、阳光房玻璃顶、天窗随坡 curb）。 */
function slopeZ(tag: string, x0: number, x1: number, zA: number, yA: number, zB: number, yB: number, thick: number): SlopeLayout {
  return { tag, axis: 'z', x0, x1, z0: zA, z1: zB, yA, yB, thick };
}

/** 沿 x 倾斜的斜板：顶面从 (xA, yA) 走到 (xB, yB)，z 范围 z0..z1（植物园折线拱面、天窗盖子）。 */
function slopeX(tag: string, z0: number, z1: number, xA: number, yA: number, xB: number, yB: number, thick: number): SlopeLayout {
  return { tag, axis: 'x', x0: xA, x1: xB, z0, z1, yA, yB, thick };
}

/**
 * 沿 y 分级的山墙三角（洋房两端）：12 级方盒，每级顶面的两个角 (zRidge ± half, yTop) 都在屋面 houseRoofY 之下 ≥ 3 cm
 * （half = (yRidge − yTop − 3) / 屋面斜率，即级顶 = min(两端屋面高) − 3）；级底接上一级的级顶、第一级坐在楼体盒顶上。
 * 最上一级的级顶高出屋面板底，整个三角阁楼被楼体 / 屋面板 / 阶梯盒封死。
 * 2026-11-23 修复：原来 6 级按"级顶处的三角宽度"取 half，每级低侧角翘出屋面 0~7 cm。
 */
function gableBoxes(tag: string, x0: number, x1: number, steps = 12): { tag: string; min: V3; max: V3 }[] {
  const out: { tag: string; min: V3; max: V3 }[] = [];
  const y0 = HOUSE.yEave;
  const k = (HOUSE.yRidge - HOUSE.yEave) / Math.abs(HOUSE.zRidge - HOUSE.z1);
  const dy = (HOUSE.yRidge - HOUSE.yEave) / steps;
  for (let i = 0; i < steps; i++) {
    const yTop = y0 + dy * (i + 1);
    const half = (HOUSE.yRidge - yTop - 3) / k;
    if (half < 0.5) continue;
    out.push(box(tag, [x0, y0 + dy * i, HOUSE.zRidge - half], [x1, yTop, HOUSE.zRidge + half]));
  }
  return out;
}

/**
 * 组装完整布局：曲线栖木 + 雪面 + 盒体 + 斜板。
 *
 * 落脚规则（飞行器的 landingClean 拒绝落点 1 cm 内贴着别的面）：同一个顶面只放一种表面——
 * 画面上是平顶的（木扶手 / 栅栏横杆 / 靠背顶板 / 拉梁 / 花架板）只留干净盒顶，圆杆栖木只放在画面上真是圆杆的地方
 * （电线 / 树枝 / 灯臂 / 花架前沿横杆 / 门扇顶框 / 电线杆瓷瓶上方的电线）；圆杆正下方如果有盒体，盒顶至少下沉 4 cm。
 * 屋面 / 雨棚 / 玻璃斜顶 / 折线拱面全是连续的 SlopeSurface，不再有台阶立面和盒间缝隙。
 *
 * treeCurves = 院心那棵老海棠的栖枝曲线（world/crabappleTree.ts 的 crabapplePerchCurves）：那边的生成器依赖 three，
 * 这个纯数据模块不 import 它，由调用方生成好传进来——页面（CourtyardApp）和 tools/courtyard_check.mjs 传的是同一份。不传 = 院心没有树。
 */
export function buildCourtyardLayout(treeCurves: CurveLayout[] = []): Layout {
  const curves: CurveLayout[] = [];
  const boxes: { tag: string; min: V3; max: V3 }[] = [];
  const slopes: SlopeLayout[] = [];

  // ── 树：主角枝 + 院心老海棠（观鸟管线那棵，栖枝在 curves[1..]）+ 温室里的三棵春树（只注册能落脚的枝）──
  curves.push(HERO_BRANCH);
  // 老海棠的曲线是调用方按 base = 0 建的（crabapplePerchCurves 不知道自己会排在主角枝后面）：挂到母枝上的序号统一往后挪 1
  curves.push(...treeCurves.map((c) => (c.springParent === undefined ? c : { ...c, springParent: c.springParent + 1 })));
  for (const tree of springTreeLimbs()) curves.push(...perchCurvesOf(tree, 'spring-', curves.length));

  // ── 跨院电线：两根完整的曲线栖木（两端固定的一阶振型：中点最大，2.4 Hz 欠阻尼——落上去先沉再上下弹晃几下）──
  curves.push({
    tag: 'wire',
    points: saggingWire(WIRES.a, WIRES.pA, WIRES.sag[0], 200),
    radii: [0.6, 0.6],
    segments: 200,
    spring: { freq: 2.4, damping: 0.02, gain: 0.3 },
  });
  curves.push({
    tag: 'wire',
    points: saggingWire(WIRES.b, WIRES.pB, WIRES.sag[1], 200),
    radii: [0.6, 0.6],
    segments: 200,
    spring: { freq: 2.4, damping: 0.02, gain: 0.3 },
  });
  // 电线杆：杆身封顶（顶面 = 杆顶雪帽 6 cm 的雪面）+ 两根横担（盒子就是木担本身 y ± 4；担顶雪条 r 4.5、轴在担顶上 6，
  // 是圆杆栖木）+ 四个瓷瓶（独立小方柱，顶面 = 瓶口 y + 12；电线从瓷瓶腰里 (y + 8) 出发，瓶顶离电线表面 3.4 cm）
  const pcx = (POLE.x0 + POLE.x1) / 2;
  const pcz = (POLE.z0 + POLE.z1) / 2;
  boxes.push(box('pole', [POLE.x0, POLE.y0, POLE.z0], [POLE.x1, POLE.y1 + 6, POLE.z1]));
  for (const y of POLE.arms) {
    boxes.push(box('pole', [pcx - 4, y - 4, pcz - 24], [pcx + 4, y + 4, pcz + 24]));
    for (const z of [pcz - 20, pcz + 20]) boxes.push(box('pole', [pcx - 2.6, y + 4, z - 2.6], [pcx + 2.6, y + 12, z + 2.6]));
    curves.push(line('pole-snow', [pcx, y + 6, pcz - 22], [pcx, y + 6, pcz + 22], 4.5, 6));
  }

  // ── 洋房 ──
  boxes.push(box('house', [HOUSE.x0, -130, HOUSE.z0], [HOUSE.x1, HOUSE.yEave, HOUSE.z1]));
  // 双坡大屋顶：两块连续斜板在屋脊相接，檐口外挑 40；底面压在墙顶（墙 yEave 760，檐口板底 746）
  const rx0 = HOUSE.x0 - HOUSE.overhang;
  const rx1 = HOUSE.x1 + HOUSE.overhang;
  const zEaveS = HOUSE.z1 + HOUSE.overhang;
  const zEaveN = HOUSE.z0 - HOUSE.overhang;
  slopes.push(slopeZ('roof', rx0, rx1, HOUSE.zRidge, HOUSE.yRidge, zEaveS, houseRoofY(zEaveS), HOUSE.roofThick));
  slopes.push(slopeZ('roof', rx0, rx1, zEaveN, houseRoofY(zEaveN), HOUSE.zRidge, HOUSE.yRidge, HOUSE.roofThick));
  // 屋顶雪被（2026-11-23 修复：原来碰撞顶面留在木板上，鸟落上去整只陷进 20 cm 厚的雪里）：
  // 雪板顶面 = House.ts 雪板的顶面线（参考线 (檐端内收 14, 屋面 − 6)→(屋脊, 屋脊 + 6) 沿法线抬 offset + thick），
  // 檐口从雪卷和雪板的等高交点铺起、铺到屋脊坡脚；最后 20 cm 一段陡坡爬到屋脊雪卷顶（918），两坡在屋脊线相接。
  // 雪板厚到把屋面板整个包住；檐口雪卷 = 同半径的圆杆栖木。
  const rs = ROOF_SNOW;
  for (const side of [1, -1] as const) {
    // side = +1 南坡（檐口在 +z 侧）/ −1 北坡
    const zEave = side > 0 ? zEaveS : zEaveN;
    const zRoll = zEave + side * rs.eaveInset;
    const yRoll = houseRoofY(zEave) + rs.eaveRollRise;
    const top = slabLift(zRoll, houseRoofY(zEave) - rs.refDrop, HOUSE.zRidge, HOUSE.yRidge + rs.ridgeRise, rs.offset + rs.thick);
    const start = rollCross(zRoll, yRoll, rs.eaveRollR, top, side > 0 ? -1 : 1);
    const zFoot = HOUSE.zRidge + side * rs.ridgeFoot;
    const yCrest = HOUSE.yRidge + rs.ridgeRollY + rs.ridgeRollR;
    slopes.push(slopeZ('roof-snow', rx0 - 6, rx1 + 6, start.z, start.y, zFoot, lineY(top, zFoot), rs.thick + 4));
    slopes.push(slopeZ('roof-snow', rx0 - 6, rx1 + 6, zFoot, lineY(top, zFoot), HOUSE.zRidge, yCrest, rs.thick + 14));
    curves.push(line('roof-snow', [rx0 - 7, yRoll, zRoll], [rx1 + 7, yRoll, zRoll], rs.eaveRollR, 8));
  }
  // 两端山墙：12 级阶梯盒，藏在可视三棱柱（墙皮外 10 cm）里
  boxes.push(...gableBoxes('gable', HOUSE.x0 - 8, HOUSE.x0));
  boxes.push(...gableBoxes('gable', HOUSE.x1, HOUSE.x1 + 8));
  // 烟囱：砖身 + 石帽和帽上 8 cm 雪（顶面 = 雪面）+ 两个陶烟囱管（管口 r 11 的圆面 → 内接方，顶面 = 管口）
  const chZ = (CHIMNEY.z0 + CHIMNEY.z1) / 2;
  const chSnowTop = CHIMNEY.y1 + CHIMNEY.capT + 8;
  boxes.push(box('chimney', [CHIMNEY.x0, CHIMNEY.y0, CHIMNEY.z0], [CHIMNEY.x1, CHIMNEY.y1, CHIMNEY.z1]));
  boxes.push(box('chimney', [CHIMNEY.x0 - 6, CHIMNEY.y1, CHIMNEY.z0 - 6], [CHIMNEY.x1 + 6, chSnowTop, CHIMNEY.z1 + 6]));
  for (const px of [CHIMNEY.x0 + 22, CHIMNEY.x1 - 22]) {
    boxes.push(box('chimney-pot', [px - 7.8, chSnowTop, chZ - 7.8], [px + 7.8, CHIMNEY.y1 + CHIMNEY.capT + 50, chZ + 7.8]));
  }
  // 二楼阳台：楼板 + 台面 4 cm 雪（顶面 = 雪面）+ 三面栏杆（木扶手盒顶 = 扶手顶；扶手顶上的雪卷 r 6 / r 5.5 是圆杆栖木）
  boxes.push(box('balcony', [BALCONY.x0, BALCONY.yFloor - BALCONY.slabT, HOUSE.z1], [BALCONY.x1, BALCONY.yFloor, BALCONY.z1]));
  boxes.push(box('balcony-snow', [BALCONY.x0 + 6, BALCONY.yFloor, HOUSE.z1 + 40], [BALCONY.x1 - 6, BALCONY.yFloor + 4, BALCONY.z1 - 8]));
  boxes.push(box('rail', [BALCONY.x0, BALCONY.railTop - BALCONY.railT, BALCONY.z1 - BALCONY.railT], [BALCONY.x1, BALCONY.railTop, BALCONY.z1]));
  boxes.push(box('rail', [BALCONY.x0, BALCONY.yFloor, BALCONY.z1], [BALCONY.x0 + BALCONY.railT, BALCONY.railTop, HOUSE.z1]));
  boxes.push(box('rail', [BALCONY.x1 - BALCONY.railT, BALCONY.yFloor, BALCONY.z1], [BALCONY.x1, BALCONY.railTop, HOUSE.z1]));
  curves.push(line('rail-snow', [BALCONY.x0 + 2, BALCONY.railTop + 3, BALCONY.z1 - BALCONY.railT / 2], [BALCONY.x1 - 2, BALCONY.railTop + 3, BALCONY.z1 - BALCONY.railT / 2], 6, 8));
  for (const sx of [BALCONY.x0, BALCONY.x1 - BALCONY.railT]) {
    curves.push(line('rail-snow', [sx + BALCONY.railT / 2, BALCONY.railTop + 3, HOUSE.z1 + 2], [sx + BALCONY.railT / 2, BALCONY.railTop + 3, BALCONY.z1 - 2], 5.5, 8));
  }
  // 二楼雨棚、正门小雨棚：cedar 板（藏在雪里）+ 雪被顶面（= House.ts 雪板顶面线，厚到雪板底）+ 贴墙那道雪板端面 + 檐口雪卷（圆杆栖木）
  slopes.push(slopeZ('awning', AWNING.x0, AWNING.x1, AWNING.zOut, AWNING.yOut, AWNING.zWall, AWNING.yWall, AWNING.thick));
  slopes.push(slopeZ('porch', PORCH.x0, PORCH.x1, PORCH.zOut, PORCH.yOut, PORCH.zWall, PORCH.yWall, PORCH.thick));
  for (const [sn, a, rollLen, tg] of [
    [AWNING_SNOW, AWNING, 4, 'awning'],
    [PORCH_SNOW, PORCH, 3, 'porch'],
  ] as const) {
    const top = slabLift(a.zOut - sn.rollInset, a.yOut, a.zWall, a.yWall, sn.offset + sn.thick);
    const yRoll = a.yOut + a.thick + sn.rollDrop;
    const zRoll = a.zOut - sn.rollInset;
    const start = rollCross(zRoll, yRoll, sn.rollR, top, -1);
    // 雪板：从雪卷交点铺到雪板上沿（贴墙 5 cm 处），厚 = 雪板法向厚度 / ny + 0.5（雪板底正好压在 cedar 板顶上）
    slopes.push(slopeZ(`${tg}-snow`, a.x0, a.x1, start.z, start.y, top.zB, top.yB, (sn.offset + sn.thick) / top.ny + 0.5));
    // 雪板上沿到墙面那道斜端面（视觉上雪板端头从上沿斜落到木板）
    slopes.push(slopeZ(`${tg}-snow`, a.x0, a.x1, top.zB, top.yB, a.zWall, a.yWall, 3));
    curves.push(line(`${tg}-snow`, [a.x0 - rollLen, yRoll, zRoll], [a.x1 + rollLen, yRoll, zRoll], sn.rollR, 8));
  }
  // 正门两级石阶（上级露石、下级盖着 4 cm 雪：顶面 = 雪面）
  boxes.push(box('step', [HOUSE_DOOR.x0 - 10, HOUSE_DOOR.y0 - 2, PORCH.zWall], [HOUSE_DOOR.x1 + 10, HOUSE_DOOR.y0 + 14, PORCH.zWall + 50]));
  boxes.push(box('step', [HOUSE_DOOR.x0 - 16, HOUSE_DOOR.y0 - 2, PORCH.zWall + 50], [HOUSE_DOOR.x1 + 16, HOUSE_DOOR.y0 + 7, PORCH.zWall + 90]));
  boxes.push(box('step-snow', [HOUSE_DOOR.x0 - 14, HOUSE_DOOR.y0 + 7, PORCH.zWall + 56], [HOUSE_DOOR.x1 + 14, HOUSE_DOOR.y0 + 11, PORCH.zWall + 88]));
  // 三楼露台：楼板 + 台面 4 cm 雪 + 铁艺护栏（盒子到铁扶手顶；前沿雪卷 r 4 是圆杆栖木，前沿三根立柱的雪帽藏在雪卷里；
  // 后角两根立柱的雪帽各是一小方台；侧面无雪）
  boxes.push(box('terrace', [TERRACE.x0, TERRACE.yFloor - TERRACE.slabT, HOUSE.z1], [TERRACE.x1, TERRACE.yFloor, TERRACE.z1]));
  boxes.push(box('terrace-snow', [TERRACE.x0 + 6, TERRACE.yFloor, HOUSE.z1 + 40], [TERRACE.x1 - 6, TERRACE.yFloor + 4, TERRACE.z1 - 8]));
  boxes.push(box('rail', [TERRACE.x0, TERRACE.railTop - TERRACE.railT, TERRACE.z1 - TERRACE.railT], [TERRACE.x1, TERRACE.railTop, TERRACE.z1]));
  boxes.push(box('rail', [TERRACE.x0, TERRACE.yFloor, TERRACE.z1], [TERRACE.x0 + TERRACE.railT, TERRACE.railTop, HOUSE.z1]));
  boxes.push(box('rail', [TERRACE.x1 - TERRACE.railT, TERRACE.yFloor, TERRACE.z1], [TERRACE.x1, TERRACE.railTop, HOUSE.z1]));
  curves.push(line('rail-snow', [TERRACE.x0 + 2, TERRACE.railTop + 2, TERRACE.z1 - TERRACE.railT / 2], [TERRACE.x1 - 2, TERRACE.railTop + 2, TERRACE.z1 - TERRACE.railT / 2], 4, 8));
  for (const px of [TERRACE.x0 + TERRACE.railT / 2, TERRACE.x1 - TERRACE.railT / 2]) {
    boxes.push(box('rail', [px - 2.8, TERRACE.railTop, HOUSE.z1 + 10 - 2.8], [px + 2.8, TERRACE.railTop + 5, HOUSE.z1 + 10 + 2.8]));
  }
  // 窗台：木挑板 + 3.5 cm 雪（顶面 = 雪面 y0 + 3.5；贴墙 1 cm 内落不了，外侧约 10 cm 是能落的窄台）。东山墙贴着大植物园，不做
  for (const w of WINDOWS) {
    if (w.face === 'east') continue;
    const [u0, u1] = w.face === 'south' || w.face === 'north' ? [w.x0, w.x1] : [w.z0 ?? 0, w.z1 ?? 0];
    if (w.face === 'south') boxes.push(box('sill', [u0 - 6, w.y0 - 6, HOUSE.z1], [u1 + 6, w.y0 + 3.5, HOUSE.z1 + 11]));
    else if (w.face === 'north') boxes.push(box('sill', [u0 - 6, w.y0 - 6, HOUSE.z0 - 11], [u1 + 6, w.y0 + 3.5, HOUSE.z0]));
    else boxes.push(box('sill', [HOUSE.x0 - 11, w.y0 - 6, u0 - 6], [HOUSE.x0, w.y0 + 3.5, u1 + 6]));
    // 窗下木花箱（箱里积雪高出箱口 1 cm：顶面 = 雪面）
    if (w.box && w.face === 'south') boxes.push(box('flowerbox', [w.x0 - 4, w.y0 - 24, HOUSE.z1], [w.x1 + 4, w.y0 + 1, HOUSE.z1 + 24]));
  }
  // 空调外机（顶上 5 cm 雪：顶面 = 雪面）
  boxes.push(box('ac', [AC_UNIT.x0 - 2, AC_UNIT.y0, AC_UNIT.z0 - 2], [AC_UNIT.x1, AC_UNIT.y1 + 5, AC_UNIT.z1 + 2]));

  // ── 阳光房：中空壳体 ──
  const { x0, x1, z0, z1, yFloor, yLowWall, yEave, zRidge, wallT, postT, glassT, roofT, floorT } = GH;
  // 地板（室内红砖面）
  boxes.push(box('gh-floor', [x0, yFloor - floorT, z0], [x1, yFloor, z1]));
  // 矮墙（南墙留门洞；东墙留通往大植物园的拱门）
  // 矮墙 + 石压顶（四面外挑 2、厚 4）+ 1.5 cm 薄雪（顶面 = yLowWall + 5.5，和 Greenhouse.ts wallSeg 同尺寸）
  const lowWall = (xa: number, xb: number, za: number, zb: number) => {
    const wx0 = Math.min(xa, xb);
    const wx1 = Math.max(xa, xb);
    const wz0 = Math.min(za, zb);
    const wz1 = Math.max(za, zb);
    boxes.push(box('gh-wall', [wx0, yFloor - floorT, wz0], [wx1, yLowWall, wz1]));
    boxes.push(box('gh-wall', [wx0 - 2, yLowWall, wz0 - 2], [wx1 + 2, yLowWall + 4, wz1 + 2]));
    boxes.push(box('gh-snow', [wx0 - 1, yLowWall + 4, wz0 - 1], [wx1 + 1, yLowWall + 5.5, wz1 + 1]));
  };
  lowWall(x0, GH_DOOR.x0, z1 - wallT, z1);
  lowWall(GH_DOOR.x1, x1, z1 - wallT, z1);
  lowWall(x1 - wallT, x1, z0, GH_ARCH.z0);
  lowWall(x1 - wallT, x1, GH_ARCH.z1, z1);
  lowWall(x0, x0 + wallT, z0, z1);
  // 玻璃墙：整堵墙的厚度（12 cm），外皮和矮墙 / 拱门框平齐、内皮连续，柱子嵌在玻璃里不再凸出；
  // 南墙留门洞、门上亮子；东墙拱门以上一段亮子；西墙整面
  boxes.push(box('gh-glass', [x0, yLowWall, z1 - glassT], [GH_DOOR.x0, yEave, z1]));
  boxes.push(box('gh-glass', [GH_DOOR.x1, yLowWall, z1 - glassT], [x1, yEave, z1]));
  boxes.push(box('gh-glass', [GH_DOOR.x0, GH_DOOR.y1, z1 - glassT], [GH_DOOR.x1, yEave, z1]));
  boxes.push(box('gh-glass', [x1 - glassT, yLowWall, z0], [x1, yEave, GH_ARCH.z0]));
  boxes.push(box('gh-glass', [x1 - glassT, yLowWall, GH_ARCH.z1], [x1, yEave, z1]));
  boxes.push(box('gh-glass', [x1 - glassT, GH_ARCH.yTop + GH_ARCH.r, GH_ARCH.z0], [x1, yEave, GH_ARCH.z1]));
  boxes.push(box('gh-glass', [x0, yLowWall, z0], [x0 + glassT, yEave, z1]));
  // 东西山墙上的玻璃三角：每坡一块竖立的窄斜板（整堵墙厚 12，x 范围和下面的玻璃墙盒相同）；顶面 = 屋面 − 3 cm，
  // 平行于屋面、整条埋在屋面板里，板底平行下沉压进玻璃墙盒里（和 Greenhouse.ts 的梯形玻璃同一条顶边）。
  // 2026-11-23 修复：原来按 16 级方盒近似、每级顶取级中点的屋面高度，每级低侧角翘出屋面 4~7 cm。
  for (const [gx0, gx1] of [
    [x1 - glassT, x1],
    [x0, x0 + glassT],
  ] as const) {
    const thick = yEave - 3 - (yLowWall - 20);
    slopes.push(slopeZ('gh-gable', gx0, gx1, zRidge, GH.yRidge - 3, z1, yEave - 3, thick));
    slopes.push(slopeZ('gh-gable', gx0, gx1, z0, yEave - 3, zRidge, GH.yRidge - 3, thick));
  }
  // 立柱（南墙 / 东西墙；南墙柱列避开门洞）：嵌在整厚的玻璃里，内外都不凸出
  const half = postT / 2;
  for (const px of GH.postsSouthX) {
    const cx = Math.min(x1 - half, Math.max(x0 + half, px));
    boxes.push(box('gh-post', [cx - half, yLowWall, z1 - wallT], [cx + half, yEave, z1 - wallT + postT]));
  }
  for (const pz of GH.baysZ) {
    const cz = Math.min(z1 - half, Math.max(z0 + half, pz));
    boxes.push(box('gh-post', [x0 + wallT - postT, yLowWall, cz - half], [x0 + wallT, yEave, cz + half]));
  }
  // 东墙柱列（拱门两侧各一根，拱门里不立柱）
  for (const pz of GH_POSTS_EAST_Z) {
    const cz = Math.min(z1 - half, Math.max(z0 + half, pz));
    boxes.push(box('gh-post', [x1 - wallT, yLowWall, cz - half], [x1 - wallT + postT, yEave, cz + half]));
  }
  // 拱门框：两根门帮 + 半圆拱顶（阶梯盒，比可见的半圆略小；最上一级两半合拢把顶封死）+ 一级石阶
  const ax = x1 - wallT - 2;
  const zc = (GH_ARCH.z0 + GH_ARCH.z1) / 2;
  for (const az of [GH_ARCH.z0 - GH_ARCH.frameT, GH_ARCH.z1]) boxes.push(box('gh-arch', [ax, yFloor, az], [x1 + 4, GH_ARCH.yTop, az + GH_ARCH.frameT]));
  for (let i = 0; i < 6; i++) {
    const ya = GH_ARCH.yTop + (GH_ARCH.r * i) / 6;
    const yb = GH_ARCH.yTop + (GH_ARCH.r * (i + 1)) / 6;
    const hw = Math.sqrt(Math.max(0, GH_ARCH.r ** 2 - ((GH_ARCH.r * (i + 1)) / 6) ** 2));
    if (zc - hw > GH_ARCH.z0 - GH_ARCH.frameT + 0.5) boxes.push(box('gh-arch', [ax, ya, GH_ARCH.z0 - GH_ARCH.frameT], [x1 + 4, yb, zc - hw]));
    if (zc + hw < GH_ARCH.z1 + GH_ARCH.frameT - 0.5) boxes.push(box('gh-arch', [ax, ya, zc + hw], [x1 + 4, yb, GH_ARCH.z1 + GH_ARCH.frameT]));
  }
  boxes.push(box('stone', [x1 - 14, yFloor - 18, GH_ARCH.z0], [x1 + CONSV.wallT + 8, yFloor - 8, GH_ARCH.z1]));
  // 阳光房东墙和大植物园西墙之间 20 cm 的缝：除拱门洞外整段填实（地面以下到拱顶），拱顶以上到植物园檐口再填一道过梁——
  // 两堵玻璃墙之间的双层空腔从上面 / 侧面都进不去，鸟不会被夹在缝里；过梁顶 (y 330) 是一条能落的窄檐
  boxes.push(box('gh-joint', [x1, yFloor - 50, z0], [CONSV.x0, GH_ARCH.yTop + GH_ARCH.r, GH_ARCH.z0]));
  boxes.push(box('gh-joint', [x1, yFloor - 50, GH_ARCH.z1], [CONSV.x0, GH_ARCH.yTop + GH_ARCH.r, z1]));
  boxes.push(box('gh-joint', [x1, GH_ARCH.yTop + GH_ARCH.r, z0], [CONSV.x0, CONSV.yEave, z1]));
  // 檐梁（南北）：顶面压到屋面板底下 2 cm，不再和屋面 / 玻璃顶重合；脊梁顶面压到屋面板里（整根藏在板内，只露出板下的梁身；屋脊就是两块板相接的一道线）
  boxes.push(box('gh-beam', [x0, yEave - 12, z1 - wallT - 2], [x1, yEave - 2, z1 - wallT + 6]));
  boxes.push(box('gh-beam', [x0, yEave - 12, z0], [x1, yEave - 2, z0 + wallT + 2]));
  boxes.push(box('gh-beam', [x0, GH.yRidge - 14, zRidge - 7], [x1, GH.yRidge - 4, zRidge + 7]));
  // 屋脊雪卷（Greenhouse.ts：r 7、轴在屋脊线上方 4 → 顶面 yRidge + 11）：圆杆栖木
  curves.push(line('gh-snow', [x0 - 3, GH.yRidge + 4, zRidge], [x1 + 3, GH.yRidge + 4, zRidge], 7, 8));
  // 屋面玻璃：南坡分三段——天窗以下（整宽）、天窗那一段（左右两块，中间留口）、天窗以上到脊（整宽）；北坡整宽。
  // 每段一块连续斜板（厚 8），檐口处板底 132 压住玻璃墙顶 140：墙顶和屋檐之间没有缝
  const v = GH_VENT;
  slopes.push(slopeZ('gh-roof', x0, x1, v.z1, ghRoofY(v.z1), z1, yEave, roofT));
  slopes.push(slopeZ('gh-roof', x0, v.x0, v.z0, ghRoofY(v.z0), v.z1, ghRoofY(v.z1), roofT));
  slopes.push(slopeZ('gh-roof', v.x1, x1, v.z0, ghRoofY(v.z0), v.z1, ghRoofY(v.z1), roofT));
  slopes.push(slopeZ('gh-roof', x0, x1, zRidge, GH.yRidge, v.z0, ghRoofY(v.z0), roofT));
  slopes.push(slopeZ('gh-roof', x0, x1, z0, yEave, zRidge, GH.yRidge, roofT));
  // 天窗：洞口四周随坡的 curb（顶面高出屋面 10 cm，连续斜板，鸟落上去能顺着走）；盖子（铰链在下沿、向上撑 79°）
  // 是一块陡斜板——顶面法线 ny 0.19 落不住，从屋里飞上去会被顺势挡开；撑窗细铁杆是栖木
  for (const cx of [v.x0 - 9, v.x1]) slopes.push(slopeZ('gh-vent', cx, cx + 9, v.z0 - 9, ghRoofY(v.z0 - 9) + v.curbH, v.z1 + 9, ghRoofY(v.z1 + 9) + v.curbH, v.curbH + 4));
  for (const za of [v.z0 - 9, v.z1]) slopes.push(slopeZ('gh-vent', v.x0 - 9, v.x1 + 9, za, ghRoofY(za) + v.curbH, za + 9, ghRoofY(za + 9) + v.curbH, v.curbH + 4));
  const lid = ventLid();
  slopes.push(slopeZ('gh-lid', v.x0, v.x1, lid.hinge[2], lid.hinge[1], lid.free[2], lid.free[1], 6));
  curves.push(line('gh-rod', [v.x1 + 4, ghRoofY(v.z1 - 4) + v.curbH + 1, v.z1 - 4], [v.x1 + 4, lid.free[1] - 2, lid.free[2] - 4], 0.5, 4));
  // 门扇（外开）：铰链在西侧门框；阶梯盒顶降到门顶下 4 cm，门顶边框做成一根圆杆栖木（顶面高出盒顶 6 cm）
  const leaf = doorLeaf();
  const stepsD = 10;
  for (let i = 0; i < stepsD; i++) {
    const sa = (leaf.len * i) / stepsD;
    const sb = (leaf.len * (i + 1)) / stepsD;
    boxes.push(
      box('gh-door', [
        leaf.hinge[0] + leaf.dir[0] * sa - 1,
        GH_DOOR.y0,
        GH.z1 + leaf.dir[2] * sa - 1.5,
      ], [
        leaf.hinge[0] + leaf.dir[0] * sb + 1,
        GH_DOOR.y1 - 4,
        GH.z1 + leaf.dir[2] * sb + 1.5,
      ]),
    );
  }
  curves.push(line('gh-door', [leaf.hinge[0] + leaf.dir[0] * 3, GH_DOOR.y1 + 2, GH.z1 + leaf.dir[2] * 3], [leaf.hinge[0] + leaf.dir[0] * (leaf.len - 3), GH_DOOR.y1 + 2, GH.z1 + leaf.dir[2] * (leaf.len - 3)], 2, 6));
  // 门框两侧立柱（嵌在玻璃里）
  boxes.push(box('gh-post', [GH_DOOR.x0 - 5, yLowWall, z1 - wallT], [GH_DOOR.x0, yEave, z1 - wallT + postT]));
  boxes.push(box('gh-post', [GH_DOOR.x1, yLowWall, z1 - wallT], [GH_DOOR.x1 + 5, yEave, z1 - wallT + postT]));
  // 横梁（沿 Z）：画面是雪松方木，单一干净盒顶（原来叠了一根同高的圆杆）
  for (const tx of GH_FIXTURES.ties) {
    boxes.push(box('gh-tie', [tx - 6, GH_FIXTURES.tieY0, z0 + 6], [tx + 6, GH_FIXTURES.tieY1, z1 - 6]));
  }
  // 花架：立柱 + 两层板 + 前沿圆杆（圆杆坐在板顶上，只占板边 4 cm，板面其余部分干净）
  const sh = GH_FIXTURES.shelf;
  for (const pz of [sh.z0, (sh.z0 + sh.z1) / 2, sh.z1]) {
    boxes.push(box('gh-shelf', [sh.xBack - 6, yFloor, pz - 3], [sh.xBack, sh.tiers[1].y1 + 10, pz + 3]));
    boxes.push(box('gh-shelf', [sh.tiers[0].x0, yFloor, pz - 3], [sh.tiers[0].x0 + 6, sh.tiers[0].y1, pz + 3]));
  }
  for (const tier of sh.tiers) {
    boxes.push(box('gh-shelf', [tier.x0, tier.y0, sh.z0], [sh.xBack, tier.y1, sh.z1]));
    curves.push(line('gh-rail', [tier.x0 + 2, tier.y1 + sh.railR, sh.z0 + 4], [tier.x0 + 2, tier.y1 + sh.railR, sh.z1 - 4], sh.railR, 6));
  }
  // 阶梯花架（天窗正下方）：四腿镂空的阶梯木架——碰撞也只有板和腿
  const st = GH_FIXTURES.stand;
  for (const tier of st.tiers) {
    boxes.push(box('gh-stand', [tier.x0, tier.y1 - 4, st.z0], [tier.x1, tier.y1, st.z1]));
    for (const [lx, lz] of [
      [tier.x0 + 3, st.z0 + 3],
      [tier.x0 + 3, st.z1 - 3],
      [tier.x1 - 3, st.z0 + 3],
      [tier.x1 - 3, st.z1 - 3],
    ] as const) boxes.push(box('gh-stand', [lx - 2.5, yFloor, lz - 2.5], [lx + 2.5, tier.y1 - 3.5, lz + 2.5]));
  }
  // 工作桌 + 陶盘
  const tb = GH_FIXTURES.table;
  boxes.push(box('gh-table', [tb.x0, tb.y0, tb.z0], [tb.x1, tb.y1, tb.z1]));
  const d = GH_FIXTURES.dish;
  boxes.push(box('gh-dish', [d.x - d.r, d.y, d.z - d.r], [d.x + d.r, d.y + 3, d.z + d.r]));
  // 吊篮：篮碗当盒体（碗口比篮沿低 4 cm），篮沿当栖木（圆杆顶高出碗口 5 cm），链条不碰
  for (const bk of GH_FIXTURES.baskets) {
    boxes.push(box('gh-basket', [bk.x - bk.r, bk.y - 16, bk.z - bk.r], [bk.x + bk.r, bk.y - 4, bk.z + bk.r]));
    curves.push(ring('gh-rail', bk.x, bk.y, bk.z, bk.r, 1.2, 20));
  }
  // 花盆：方盒碰撞 + 口沿栖木（有口沿的大盆，盆土 = 盒顶比口沿低 3.5 cm，圆杆顶高出盆土 5 cm；小盆口就是平的盒顶）；粗壮花枝（山茶）也注册
  for (const p of POTS) {
    if (p.r < 9) continue;
    const rim = p.r >= 13;
    boxes.push(box('pot', [p.x - p.r * 0.92, p.y, p.z - p.r * 0.92], [p.x + p.r * 0.92, p.y + p.h - (rim ? 3.5 : 0), p.z + p.r * 0.92]));
    if (rim) curves.push(ring('pot-rim', p.x, p.y + p.h, p.z, p.r * 0.96, 1.6, 18));
    if (p.kind === 'camellia') {
      const top = p.y + p.h;
      curves.push({
        tag: 'stem',
        points: [
          [p.x, top - 2, p.z],
          [p.x + 3, top + 16, p.z - 2],
          [p.x - 2, top + 32, p.z + 2],
          [p.x + 4, top + 46, p.z - 1],
        ],
        radii: [1.4, 1.2, 1.0, 0.6],
        segments: 12,
      });
    }
  }

  // ── 大植物园温室：中空壳体（矮墙 / 玻璃 / 立柱 / 檐梁 / 折线拱面 / 天窗 / 双开门）+ 拉杆 / 檩条 / 脊梁 + 石槽 + 汀步 ──
  {
    const c = CONSV;
    const { x0, x1, z0, z1, yFloor, yLowWall, yEave, wallT, postT, glassT } = c;
    const westSpans: [number, number][] = [
      [z0, GH_ARCH.z0],
      [GH_ARCH.z1, CONSV_DOOR.z0],
      [CONSV_DOOR.z1, z1],
    ];
    // 玻璃 12 cm 厚，和矮墙外皮平齐（内皮留 4 cm 窗台）；立柱嵌在玻璃里
    for (const [za, zb] of westSpans) {
      boxes.push(box('cv-wall', [x0, yFloor - 30, za], [x0 + wallT, yLowWall, zb]));
      boxes.push(box('cv-glass', [x0, yLowWall, za], [x0 + glassT, yEave, zb]));
    }
    // 拱门 / 门洞上方的亮子
    boxes.push(box('cv-glass', [x0, GH_ARCH.yTop + GH_ARCH.r + 4, GH_ARCH.z0], [x0 + glassT, yEave, GH_ARCH.z1]));
    boxes.push(box('cv-glass', [x0, CONSV_DOOR.y1 + 6, CONSV_DOOR.z0], [x0 + glassT, yEave, CONSV_DOOR.z1]));
    boxes.push(box('cv-wall', [x1 - wallT, yFloor - 30, z0], [x1, yLowWall, z1]));
    boxes.push(box('cv-glass', [x1 - glassT, yLowWall, z0], [x1, yEave, z1]));
    for (const [za, zb] of [
      [z0, z0 + wallT],
      [z1 - wallT, z1],
    ] as const) {
      boxes.push(box('cv-wall', [x0, yFloor - 30, za], [x1, yLowWall, zb]));
      boxes.push(box('cv-glass', [x0, yLowWall, za], [x1, yEave, zb]));
    }
    // 两端山墙玻璃三角：檐口 330 以上到拱面，按折线每段一块竖立的窄斜板（和端墙玻璃同厚 16、内皮平齐；顶面随拱面、
    // 比拱面低 3 cm 藏在拱面板里，板底随顶面平行下沉、埋在整面端墙玻璃里）。
    // 2026-11-23 补：原来端墙玻璃只到檐口，山墙三角是敞开的，鸟能从两端山墙钻进钻出
    for (const [za, zb] of [
      [z0, z0 + wallT],
      [z1 - wallT, z1],
    ] as const) {
      for (let k = 0; k < c.archSegs; k++) {
        const na = consRoofNodeX(k);
        const nb = consRoofNodeX(k + 1);
        const ya = consRoofY(na) - 3;
        const yb = consRoofY(nb) - 3;
        slopes.push(slopeX('cv-gable', za, zb, na, ya, nb, yb, Math.max(ya, yb) - yEave));
        slopes.push(slopeX('cv-gable', za, zb, CONSV.xRidge + (CONSV.xRidge - nb), yb, CONSV.xRidge + (CONSV.xRidge - na), ya, Math.max(ya, yb) - yEave));
      }
    }
    // 立柱
    for (const pz of c.postsWestZ) boxes.push(box('cv-post', [x0, yLowWall, pz - postT / 2], [x0 + postT, yEave, pz + postT / 2]));
    for (const pz of c.postsEastZ) boxes.push(box('cv-post', [x1 - postT, yLowWall, pz - postT / 2], [x1, yEave, pz + postT / 2]));
    for (const px of c.postsEndX) {
      boxes.push(box('cv-post', [px - postT / 2, yLowWall, z0], [px + postT / 2, yEave, z0 + postT]));
      boxes.push(box('cv-post', [px - postT / 2, yLowWall, z1 - postT], [px + postT / 2, yEave, z1]));
    }
    for (const dz of [CONSV_DOOR.z0 - 6, CONSV_DOOR.z1]) boxes.push(box('cv-post', [x0 - 2, yFloor, dz], [x0 + wallT + 2, yEave, dz + 6]));
    // 檐梁（四边）：顶面 330 = 檐口处拱面顶面，往里拱面一路升高，梁整根藏在拱面板之下
    boxes.push(box('cv-beam', [x0, yEave - 12, z0], [x1, yEave, z0 + 14]));
    boxes.push(box('cv-beam', [x0, yEave - 12, z1 - 14], [x1, yEave, z1]));
    boxes.push(box('cv-beam', [x0, yEave - 12, z0], [x0 + 14, yEave, z1]));
    boxes.push(box('cv-beam', [x1 - 14, yEave - 12, z0], [x1, yEave, z1]));
    // 折线拱面：每段一块连续斜板（厚 8），西坡天窗那一段按 z 分成两截；段与段在节点线上相接，没有立面没有缝
    const v = CONSV_VENT;
    const slabT = 8;
    for (let k = 0; k < c.archSegs; k++) {
      const na = consRoofNodeX(k);
      const nb = consRoofNodeX(k + 1);
      const ya = consRoofY(na);
      const yb = consRoofY(nb);
      const isVent = Math.abs(na - v.x0) < 3;
      const zSpans: [number, number][] = isVent ? [
        [z0, v.z0],
        [v.z1, z1],
      ] : [[z0, z1]];
      for (const [za, zb] of zSpans) slopes.push(slopeX('cv-roof', za, zb, na, ya, nb, yb, slabT));
      slopes.push(slopeX('cv-roof', z0, z1, CONSV.xRidge + (CONSV.xRidge - nb), yb, CONSV.xRidge + (CONSV.xRidge - na), ya, slabT));
    }
    // 天窗：两条随坡 curb + 两端横 curb（顶面高出拱面 12 cm，连续斜板，顺着能走）；三扇盖子（从下沿撑 71°）是陡斜板，
    // 顶面落不住；盖子自由边横杆 / 撑杆是栖木（横杆圆心在自由边上方 3 cm，杆顶离盖面板 1.5 cm）
    for (const cx of [v.x0 - 8, v.x1]) slopes.push(slopeX('cv-vent', v.z0 - 8, v.z1 + 8, cx, consRoofY(cx) + v.curbH, cx + 8, consRoofY(cx + 8) + v.curbH, v.curbH + 6));
    for (const za of [v.z0 - 8, v.z1]) slopes.push(slopeX('cv-vent', za, za + 8, v.x0 - 8, consRoofY(v.x0 - 8) + v.curbH, v.x1 + 8, consRoofY(v.x1 + 8) + v.curbH, v.curbH + 6));
    for (let i = 0; i < v.lids; i++) {
      const lid = consVentLid(i);
      slopes.push(slopeX('cv-lid', lid.z0, lid.z1, lid.hinge[0], lid.hinge[1], lid.free[0], lid.free[1], 6));
      curves.push(line('cv-rail', [lid.free[0], lid.free[1] + 3, lid.z0 + 2], [lid.free[0], lid.free[1] + 3, lid.z1 - 2], 1.6, 8));
      curves.push(line('cv-rod', [v.x1 + 2, consRoofY(v.x1) + v.curbH, (lid.z0 + lid.z1) / 2], [lid.free[0] - 1, lid.free[1] - 1, (lid.z0 + lid.z1) / 2], 0.6, 4));
    }
    // 双开门：两扇各 8 级阶梯盒 + 门扇顶框圆杆（栖木，圆心在门顶上 2 cm）；门外两级石阶
    for (const i of [0, 1] as const) {
      const leaf = consDoorLeaf(i);
      for (let s = 0; s < 8; s++) {
        const sa = (leaf.len * s) / 8;
        const sb = (leaf.len * (s + 1)) / 8;
        boxes.push(
          box('cv-door', [
            leaf.hinge[0] + leaf.dir[0] * sb - 2,
            yFloor,
            leaf.hinge[2] + Math.min(leaf.dir[2] * sa, leaf.dir[2] * sb) - 2,
          ], [
            leaf.hinge[0] + leaf.dir[0] * sa + 2,
            CONSV_DOOR.y1,
            leaf.hinge[2] + Math.max(leaf.dir[2] * sa, leaf.dir[2] * sb) + 2,
          ]),
        );
      }
      curves.push(line('cv-rail', [leaf.hinge[0] + leaf.dir[0] * 4, CONSV_DOOR.y1 + 2, leaf.hinge[2] + leaf.dir[2] * 4], [leaf.hinge[0] + leaf.dir[0] * (leaf.len - 2), CONSV_DOOR.y1 + 2, leaf.hinge[2] + leaf.dir[2] * (leaf.len - 2)], 2, 6));
    }
    boxes.push(box('stone', [318, yFloor - 26, CONSV_DOOR.z0 - 4], [342, -115, CONSV_DOOR.z1 + 4]));
    // 门外石阶上的 3 cm 雪（Conservatory.ts：x 316..340，顶面 −112）
    boxes.push(box('stone-snow', [316, -115, CONSV_DOOR.z0 - 4], [340, -112, CONSV_DOOR.z1 + 4]));
    boxes.push(box('stone', [338, yFloor - 26, CONSV_DOOR.z0 - 4], [x0, yFloor, CONSV_DOOR.z1 + 4]));
    // 拱架拉杆（每开间一根，檐口下 6 cm，离墙 20 cm）：栖木。
    // 檩条（每段折线的节点）画面上是从拱面往下 8 cm 的肋、和拱面板底平齐——整根埋在拱面板厚里，碰撞层不注册
    //（原来那根圆杆上半截在板里、只剩朝下的半边，落不上）。
    // 脊梁：画面是 14 cm 宽的方木，顶面和拱面在屋脊相接——换成和画面一样的盒体（原来那根圆杆同样只剩朝下的半边）
    // 细长钢拉杆（2026-11-23 起会颤：7 Hz 刚劲的小振，鸟落上去嗡一下；画面是 DynamicWires 的动态管子，不再塞进静态合批）
    for (let pz = z0 + c.bayZ; pz < z1 - 10; pz += c.bayZ) curves.push({ ...line('cv-tie', [x0 + 20, yEave - 6, pz], [x1 - 20, yEave - 6, pz], 1.4, 10), spring: { freq: 7, damping: 0.04, gain: 0.05 } });
    boxes.push(box('cv-beam', [CONSV.xRidge - 7, c.yRidge - 16, z0 + 10], [CONSV.xRidge + 7, c.yRidge, z1 - 10]));
    // 浅水石槽：四壁 + 压顶（压顶石 12 cm 宽、高出壁顶 4 cm，四条干净盒顶）+ 盆里的水面（低 21 cm）；
    // 原来盆顶和一个椭圆栖木圈重合、整圈落不住
    const ty = TROUGH.base + TROUGH.h;
    boxes.push(box('trough', [TROUGH.x0 - 3, TROUGH.base, TROUGH.z0 - 3], [TROUGH.x1 + 3, ty + 4, TROUGH.z0 + 12]));
    boxes.push(box('trough', [TROUGH.x0 - 3, TROUGH.base, TROUGH.z1 - 12], [TROUGH.x1 + 3, ty + 4, TROUGH.z1 + 3]));
    boxes.push(box('trough', [TROUGH.x0 - 3, TROUGH.base, TROUGH.z0], [TROUGH.x0 + 12, ty + 4, TROUGH.z1]));
    boxes.push(box('trough', [TROUGH.x1 - 12, TROUGH.base, TROUGH.z0], [TROUGH.x1 + 3, ty + 4, TROUGH.z1]));
    boxes.push(box('trough', [TROUGH.x0, TROUGH.base, TROUGH.z0], [TROUGH.x1, TROUGH.base + TROUGH.water, TROUGH.z1]));
    // 鹅卵石小径是贴着地形的带状网格（只高出地面 1.5 cm）：碰撞就是春日地形高度场本身，不再单独立盒
  }

  // ── 栅栏（四周，南侧留院门）：两道横杆就是木杆本身；上杆顶上的雪条（r 5、轴在杆顶上 2.5 → 顶面 −14.5）是圆杆栖木；
  // 柱 = 柱身到柱帽顶（yTop + 3）+ 柱头雪团（r 7.5 → 内接方，顶面 yTop + 8）──
  const f = FENCE;
  const rails = (ax: number, az: number, bx: number, bz: number, skip?: [number, number]) => {
    const along = Math.abs(bx - ax) > Math.abs(bz - az);
    const segs: [number, number][] = skip ? [
      [Math.min(ax, bx), skip[0]],
      [skip[1], Math.max(ax, bx)],
    ] : [[Math.min(ax, bx), Math.max(ax, bx)]];
    for (const [s0, s1] of segs) {
      if (s1 - s0 < 1) continue;
      for (const ry of f.rails) {
        boxes.push(along ? box('fence', [s0, ry, az - f.railT], [s1, ry + f.railH, az + f.railT]) : box('fence', [ax - f.railT, ry, s0], [ax + f.railT, ry + f.railH, s1]));
      }
      // 上杆顶面的雪条（两端各内收 3 cm）
      const ry0 = f.rails[0] + f.railH;
      if (s1 - s0 > 8) {
        curves.push(
          along
            ? line('fence-snow', [s0 + 3, ry0 + 2.5, az], [s1 - 3, ry0 + 2.5, az], 5, 6)
            : line('fence-snow', [ax, ry0 + 2.5, s0 + 3], [ax, ry0 + 2.5, s1 - 3], 5, 6),
        );
      }
    }
  };
  rails(YARD.x0, YARD.z1, YARD.x1, YARD.z1, [f.gate.x0, f.gate.x1]);
  rails(YARD.x0, YARD.z0, YARD.x1, YARD.z0);
  rails(YARD.x0, YARD.z0, YARD.x0, YARD.z1);
  rails(YARD.x1, YARD.z0, YARD.x1, YARD.z1);
  // 栅栏柱（每 200 一根，四角都有）：柱身 + 方柱帽（顶 yTop + 3）+ 柱头雪团（r 7.5 的圆盘 → 内接方，顶面 yTop + 8）
  const post = (x: number, z: number) => {
    boxes.push(box('fence-post', [x - f.postT / 2, SNOW_BASE - 10, z - f.postT / 2], [x + f.postT / 2, f.yTop + 3, z + f.postT / 2]));
    boxes.push(box('fence-snow', [x - 5.3, f.yTop + 3, z - 5.3], [x + 5.3, f.yTop + 8, z + 5.3]));
  };
  for (let x = YARD.x0; x <= YARD.x1; x += f.spacing) {
    post(x, YARD.z1);
    post(x, YARD.z0);
  }
  for (let z = YARD.z0 + f.spacing; z < YARD.z1; z += f.spacing) {
    post(YARD.x0, z);
    post(YARD.x1, z);
  }
  // 院门（关着的一扇）：门板盒顶 = 门板顶（yTop − 18）+ 门顶 4 cm 雪（顶面 = 雪面 yTop − 14，两端各内收 6 cm）
  boxes.push(box('gate', [f.gate.x0, SNOW_BASE - 10, YARD.z1 - 3], [f.gate.x1, f.yTop - 18, YARD.z1 + 3]));
  boxes.push(box('gate-snow', [f.gate.x0 + 6, f.yTop - 18, YARD.z1 - 3], [f.gate.x1 - 6, f.yTop - 14, YARD.z1 + 3]));

  // ── 汀步石板（石面高出雪 4 cm，顶面薄雪盖再高 0.6 cm）：石面和雪盖合成一个盒顶 = 雪盖顶（分开两个面的话落点 1 cm 内
  // 总贴着另一个面，飞行器永远拒绝落在雪盖上）；石边露出的那一圈最多高出画面 0.6 cm ──
  let si = 0;
  for (const path of STONE_PATHS) {
    for (const s of path) {
      const r = stoneRadius(si++);
      const y = snowAt(s[0], s[2]) + 4.6;
      boxes.push(box('stone', [s[0] - r * 0.85, y - 8.6, s[2] - r * 0.85], [s[0] + r * 0.85, y, s[2] + r * 0.85]));
    }
  }

  // ── 长椅：座面木板 + 雪座 4.5 cm（顶面 = 雪面）+ 靠背顶板（盒顶 = 板顶）+ 板顶雪卷 r 5.5（圆杆栖木，顶面 −14）──
  boxes.push(box('bench', [BENCH.x0, BENCH.seatY - BENCH.seatT, BENCH.z0], [BENCH.x1, BENCH.seatY, BENCH.z1]));
  boxes.push(box('bench-snow', [BENCH.x0 + 6, BENCH.seatY, BENCH.z0 + 4], [BENCH.x1 - 3, BENCH.seatY + 4.5, BENCH.z1 - 4]));
  boxes.push(box('bench', [BENCH.x0, BENCH.backTop - 8, BENCH.z0], [BENCH.x0 + BENCH.backT, BENCH.backTop, BENCH.z1]));
  curves.push(line('bench-snow', [BENCH.x0 + BENCH.backT / 2, BENCH.backTop + 2.5, BENCH.z0 + 2], [BENCH.x0 + BENCH.backT / 2, BENCH.backTop + 2.5, BENCH.z1 - 2], 5.5, 8));

  // ── 路灯：灯柱（顶面 140，弯臂从柱侧穿出，柱顶东半边干净可落）+ 灯笼（灯身到顶盘，再两级小尖顶：第二级顶面是栖点；弯臂末梢插在尖顶里）+ 弯头（栖木）──
  const lampY0 = snowAt(LAMP.x, LAMP.z) - 6;
  boxes.push(box('lamp', [LAMP.x - LAMP.postR, lampY0, LAMP.z - LAMP.postR], [LAMP.x + LAMP.postR, LAMP.yTop, LAMP.z + LAMP.postR]));
  const ln = LAMP.lantern;
  boxes.push(box('lantern', [ln.x - ln.w / 2, ln.y - 3, ln.z - ln.w / 2], [ln.x + ln.w / 2, ln.y + ln.h + 5, ln.z + ln.w / 2]));
  // 铁盖（四棱台，y+h+4.5 → +13.5）+ 盖上的雪锥（y+h+10.5 → +17.5，顶面 = 雪锥尖）：三级内接方盒近似
  boxes.push(box('lantern-snow', [ln.x - 5.6, ln.y + ln.h + 5, ln.z - 5.6], [ln.x + 5.6, ln.y + ln.h + 12, ln.z + 5.6]));
  boxes.push(box('lantern-snow', [ln.x - 2.9, ln.y + ln.h + 12, ln.z - 2.9], [ln.x + 2.9, ln.y + ln.h + 15, ln.z + 2.9]));
  boxes.push(box('lantern-snow', [ln.x - 1, ln.y + ln.h + 15, ln.z - 1], [ln.x + 1, ln.y + ln.h + 17.5, ln.z + 1]));
  curves.push({
    tag: 'lamp-arm',
    points: [
      [LAMP.x, LAMP.yTop - 10, LAMP.z],
      [LAMP.x - 6, LAMP.yTop + 12, LAMP.z],
      [LAMP.x - 22, LAMP.yTop + 22, LAMP.z],
      [ln.x + 6, LAMP.yTop + 20, LAMP.z],
      [ln.x, LAMP.yTop + 10, LAMP.z],
    ],
    radii: [2.4, 2.2, 2.0, 1.8, 1.6],
    segments: 24,
  });

  return { curves, grounds: [GROUND], boxes, slopes };
}

/** 布局里各类数量的速览（自检脚本 / HUD 用）。 */
export function courtyardStats(layout: Layout): { curves: number; boxes: number; slopes: number; grounds: number; byTag: Record<string, number> } {
  const byTag: Record<string, number> = {};
  // 老海棠每根枝一个 tag（tree:序号），速览里归成一类
  for (const c of layout.curves) {
    const k = c.tag.startsWith('tree:') ? 'tree:*' : c.tag;
    byTag[k] = (byTag[k] ?? 0) + 1;
  }
  for (const b of layout.boxes) byTag[b.tag] = (byTag[b.tag] ?? 0) + 1;
  for (const g of layout.grounds) byTag[g.tag] = (byTag[g.tag] ?? 0) + 1;
  const slopes = layout.slopes ?? [];
  for (const s of slopes) byTag[s.tag] = (byTag[s.tag] ?? 0) + 1;
  return { curves: layout.curves.length, boxes: layout.boxes.length, slopes: slopes.length, grounds: layout.grounds.length, byTag };
}

/**
 * 庭院的完整碰撞世界：buildCourtyardLayout 的雪面 / 曲线 / 盒体 / 斜板 + 温室里的春日微地形高度场（最后加进去的那个表面，
 * 和画面网格同一张节点表）。合流进主场景时用它代替 buildWorld(layout)。
 */
export function buildCourtyardWorld(layout: Layout, opts?: SimWorldOptions): SimWorld {
  const world = buildWorld(layout, opts);
  world.add(buildSpringGround());
  return world;
}
