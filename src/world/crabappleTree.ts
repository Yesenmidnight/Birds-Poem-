import { CatmullRomCurve3, Vector3 } from 'three';
// 导入写全 .ts 扩展名：tools/courtyard_check.mjs 在 Node 里直接 import 这个文件（和 src/sim / src/pcg 同一套约定）
import { makeRng, noise1 } from '../util/math.ts';
import type { CurveLayout } from '../pcg/layout.ts';
import type { SpringParams } from '../sim/curvePerch.ts';
import type { LimbSpec } from './Branch';

/**
 * 观鸟入口那棵 6 米的冬雪红果老海棠（枝条坐标系，厘米），对照两张实拍重构：
 * 斜倚 S 形曲干从地面 y = −125 以 22° 倚向栖枝这一侧升到低腰分叉（y ≈ −30 ~ +10），在那里开张分出 6~7 股粗细错落的
 * 主枝——内圈 3 股以 50°~58° 斜升撑起冠顶（y ≈ 380~430），外圈 4 股以 20°~36° 大跨度长弧线舒展、先升再平拱再受重力
 * 下垂（裙枝尖端 −15° ~ −22°），冠幅 5.0~5.8 m；绝不留直捅天际的中央直杆（主干到分叉后只剩一根 30 cm 的弱梢收尖）。
 * 主枝上逐级分出带微折曲与下垂弧度的二级枝（~45 根）、三级冠梢（~250 根）和果台（160~220 簇、每簇 4~6 果），
 * 织成参考图那种疏密交错、柔美蓬松的冠缘细梢网和满树绛红繁星。主角栖枝 LIMBS[0] 经一条近乎水平、微微起拱的
 * 过渡二级大枝汇入分叉中心。
 *
 * 全部走 Branches.addWeldedLimbs 的母子枝中心轴焊合契约（parent = 本表序号，母枝必须排在子枝前面；at / atPoint 指定附着处）：
 * 没有一根手填悬空起点。细分按层级递减：主干 72×56 → 主枝 64×12 → 二级枝 24×8 → 冠梢 14×6 → 果台 4×4
 * （2026-11-23 二级枝 / 冠梢加密：中景里 10×6 / 5×4 的折铁丝感太明显；segments 同时是碰撞曲线的弧长采样数）。
 * 默认三分之四相机在枝条坐标 (+0.67, +0.14, +0.73) 方向（+z 侧前方）往 −x / −z 看：主干在它的左后方；
 * 太阳在枝条坐标约 (−0.3, ·, +0.73) 的方位（世界方位 −100°），主干在 −z 侧，不挡鸟的光。
 */

type P3 = [number, number, number];

/** 主枝栖枝 LIMBS[0] 的基部与起始切线（过渡枝末端要和它 C¹ 衔接：位置相同、切线相同、半径 2.4 → 2.45 略包住）。 */
const PERCH_BASE: P3 = [-46, -4.6, -11];
const PERCH_TANGENT = new Vector3(20, 2.85, 7.3).normalize();

const DEG = Math.PI / 180;

export interface CrabappleTree {
  specs: LimbSpec[];
  /** 树兜雪坡：中心（枝条坐标）、半径、高。 */
  rootMound: { center: P3; R: number; H: number; seed: number };
  /** 从主干分出的枝（过渡枝 + 主枝）在 specs 里的序号：分叉窝里堆雪鞍用。 */
  trunkChildren: number[];
  /** 果台序号（rigcheck / 调试用）。 */
  spurs: number[];
}

/**
 * 枝条禁入区钩子（庭院里用：树冠不能扎进阳光房 / 洋房）：返回 false = 这根枝不许长。不传 = 不限（观鸟入口）。
 * 主枝撞进禁区就缩短重长（最多 6 次、每次 ×0.88），二级枝 / 冠梢 / 果台撞进去就直接不要——挨着暖房的老树本来就被修剪成朝外长的样子。
 */
export type LimbAvoid = (points: readonly P3[], radii: readonly number[]) => boolean;

export interface CrabappleTreeOptions {
  avoid?: LimbAvoid;
  /** false = 不建树兜雪坡（庭院有真实的雪地高度场，雪丘由地面的高度场自己堆；观鸟入口没有地面，要靠这块雪坡接住树根）。 */
  rootMound?: boolean;
}

/**
 * 二级枝 / 冠梢的悬臂弹簧（2026-11-23；和温室春树同一套数）：根部焊在母枝上不动、梢端最大（振型 (s/L)²，和画面层顶点着色器同一个公式）。
 * gain 按"一跳的蹬速 ≈ 83 cm/s"定：二级枝梢端沉 ~1.3 cm、冠梢 ~1.8 cm（枝中段只有四分之一）；鸟站上时另有静态下垂（sag），离枝回弹。
 * 主干 / 过渡枝 / 7 股主枝（母枝是主干）保持刚性。
 */
export const CRAB_SECONDARY_SPRING: SpringParams = { freq: 2.4, damping: 0.08, gain: 0.2, mode: 'cantilever', sag: 0.4 };
export const CRAB_TWIG_SPRING: SpringParams = { freq: 4.5, damping: 0.06, gain: 0.55, mode: 'cantilever', sag: 0.8 };

/**
 * 老海棠里能落脚的枝（板根 / 果台不算）→ 碰撞层曲线；tag 带它在 specs 里的序号（`tree:12`），落地时按序号找回画面上那根枝。
 * 传 Branches.treeSpecs 也行（同一种枝条表）。二级枝（母枝 = 主枝）和冠梢（母枝 = 二级枝）带悬臂弹簧；冠梢再挂到母枝的振子上
 * （springParent = 母枝在这批曲线里的序号 + base：母枝弯了，冠梢的根跟着走，焊口不裂）。
 * @param base 这批曲线在布局里的起始序号（buildCourtyardLayout 里主角枝排在最前 = 1）。
 */
export function crabapplePerchCurves(tree: { specs: LimbSpec[] }, base = 0): CurveLayout[] {
  const out: CurveLayout[] = [];
  /** 每根枝的碰撞曲线在这批里的序号（不是栖木的 = −1）。 */
  const ordinal = new Int32Array(tree.specs.length).fill(-1);
  tree.specs.forEach((s, i) => {
    if (s.perch === false) return;
    ordinal[i] = out.length;
    const parent = s.parent !== undefined ? tree.specs[s.parent] : undefined;
    const parentIsSecondary = parent !== undefined && parent.parent !== undefined && parent.parent !== 0;
    const spring = parentIsSecondary ? CRAB_TWIG_SPRING : parent !== undefined && parent.parent === 0 ? CRAB_SECONDARY_SPRING : undefined;
    const c: CurveLayout = { tag: `tree:${i}`, points: s.points, radii: s.radii, segments: s.segments, radial: s.radial, seed: s.seed, snow: s.snow, buds: s.buds, spring };
    if (spring && parentIsSecondary && s.parent !== undefined && ordinal[s.parent] >= 0) {
      c.springParent = base + ordinal[s.parent];
      c.springAt = s.at ?? 0;
    }
    out.push(c);
  });
  return out;
}

/**
 * 斜倚 S 形主干：x 从 −134 到 −88（Δx 46 / Δy 115 ≈ 22°），中段倚得最狠、根颈和分叉处收着点（S 形）；
 * z 向中段鼓向 −z 一点，让曲干在三分之四视角里是真正的三维弯曲。radii 16 → 10.2 到分叉，再收成弱梢。
 */
const TRUNK: { p: P3; r: number }[] = [
  { p: [-146, -125, -58], r: 16 },
  { p: [-142, -108, -61], r: 15.2 },
  { p: [-132, -88, -63], r: 14.2 },
  { p: [-121, -68, -60], r: 13.2 },
  { p: [-110, -48, -55], r: 12.2 },
  { p: [-101, -28, -53], r: 11.2 },
  { p: [-96, -10, -50], r: 10.2 },
  { p: [-95, 6, -48], r: 8.0 },
  { p: [-98, 19, -50], r: 3.2 },
  { p: [-100, 30, -52], r: 0.4 },
];
/** 主干上各段的序号（TRUNK 下标）：外圈主枝 / 内圈主枝 / 过渡枝从这些高度分出。 */
const ATTACH = { O: 4, LOW: 5, FORK: 6 } as const;

/**
 * 一根斜升 → 平拱 → 下垂的长弧线枝：水平方位 az（枝条坐标 x-z 平面，0 = +x 朝栖枝），水平伸距 reach，
 * 坡角从 a0（基部）线性过渡到 a1（尖端），高度沿弧累积；平面里带合轴曲折（左右微摆 wobble）。返回 5 个控制点。
 */
function archLimb(base: P3, az: number, reach: number, a0: number, a1: number, wobble: number, phase: number): P3[] {
  const dir = new Vector3(Math.cos(az * DEG), 0, Math.sin(az * DEG));
  const side = new Vector3(-dir.z, 0, dir.x);
  const N = 16;
  const pts: P3[] = [[base[0], base[1], base[2]]];
  let h = 0;
  let s = 0;
  const ds = reach / N;
  for (let i = 1; i <= N; i++) {
    const u = i / N;
    const a = (a0 + (a1 - a0) * u) * DEG;
    h += Math.tan(a) * ds;
    s += ds;
    if (i % 4 === 0) {
      const lat = Math.sin(u * 5.5 + phase) * wobble * reach * u;
      pts.push([base[0] + dir.x * s + side.x * lat, base[1] + h, base[2] + dir.z * s + side.z * lat]);
    }
  }
  return pts;
}

export function growCrabappleTree(seed = 2024, perchSeed = 0, opts: CrabappleTreeOptions = {}): CrabappleTree {
  const rng = makeRng(seed);
  const avoid = opts.avoid;
  const specs: LimbSpec[] = [];
  const sd = (): number => Math.floor(rng() * 1000);
  const P = (x: number, y: number, z: number): P3 => [x, y, z];
  const v = (p: P3): Vector3 => new Vector3(p[0], p[1], p[2]);
  const curveOf = (spec: LimbSpec): CatmullRomCurve3 => new CatmullRomCurve3(spec.points.map(v), false, 'centripetal');

  // ---- 斜倚 S 形主干（0 号，无母枝）：倾角 22° 让"朝上一侧"有稳定定义，迎雪侧挂一条连续的窄厚积雪脊带 ----
  specs.push({
    points: TRUNK.map((t) => P(t.p[0], t.p[1], t.p[2])),
    radii: TRUNK.map((t) => t.r),
    segments: 72,
    // 环向 56：周长 100 cm 的根颈一环 1.8 cm，才采样得出 2.5 cm 一道的纵裂沟（40 环时一环正好一道沟，沟纹欠采样成锯齿边）
    radial: 56,
    seed: 71,
    snow: true,
    snowDepth: 0.25,
    snowCols: 10,
    smoothSnow: true,
    snowHalfK: 0.8,
    buds: [0.995],
  });

  // ---- 根颈：四条盘结的板根，从主根基部往外张开，近树干处拱出雪面、远处钻进雪里 ----
  const c0 = TRUNK[0].p;
  for (let k = 0; k < 4; k++) {
    const a = (20 + 90 * k + (rng() - 0.5) * 28) * DEG;
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    specs.push({
      points: [P(c0[0], c0[1], c0[2]), P(c0[0] + 13 * dx, -117.5, c0[2] + 13 * dz), P(c0[0] + 25 * dx, -119, c0[2] + 25 * dz), P(c0[0] + 34 * dx, -122.5, c0[2] + 34 * dz)],
      radii: [5.5, 3.2, 1.6, 0.4],
      segments: 10,
      radial: 8,
      seed: sd(),
      snow: false,
      parent: 0,
      at: 0,
      perch: false,
    });
  }

  // ---- 过渡二级大枝：从分叉中心近乎水平、微微起拱地接到主枝栖枝基部（消除以前那个突兀的鹅脖子包）----
  // 末两点沿栖枝切线，再越过接缝 1.5 cm 盖住栖枝雪帽的起点（两段雪帽在接缝站位的雪厚噪声不同，不重叠会漏一条缝）。
  // 雪厚不能加（栖枝的 snowDepth 是 0）。雪帽半宽 snowHalf 里有一项 noise1(弧长 × 0.45 + seed)：过渡枝末端
  //（弧长 = 全长 − 1.5）和栖枝起点（弧长 0）要取到同一个值，不然两段雪帽在接缝处一宽一窄留一道台阶——在 1000 个种子里挑
  const fork = TRUNK[ATTACH.FORK].p;
  const tEnd = v(PERCH_BASE);
  const tPrev = tEnd.clone().addScaledVector(PERCH_TANGENT, -12);
  const tOver = tEnd.clone().addScaledVector(PERCH_TANGENT, 1.5);
  // 出分叉几乎平着走（只抬 6 cm，再微微下沉到栖枝）：mid 机位在 az 30° 看过来，这段枝正对相机——枝段一抬头，顶面的雪帽就是端着看的一颗鹅头
  const tAll = [P(fork[0], fork[1], fork[2]), P(-82, -4.0, -37), P(-64, -5.2, -24), P(tPrev.x, tPrev.y, tPrev.z), P(tEnd.x, tEnd.y, tEnd.z), P(tOver.x, tOver.y, tOver.z)];
  const tLen = new CatmullRomCurve3(tAll.map(v), false, 'centripetal').getLength() - 1.5;
  const goal = noise1(perchSeed, 3);
  let tSeed = 12;
  let bestGap = 9;
  for (let s = 0; s < 1000; s++) {
    const gap = Math.abs(noise1(tLen * 0.45 + s, 3) - goal);
    if (gap < bestGap) {
      bestGap = gap;
      tSeed = s;
    }
  }
  const transitionIndex = specs.length;
  specs.push({
    points: tAll,
    radii: [5.2, 4.6, 3.8, 3.0, 2.45, 2.45],
    segments: 40,
    radial: 18,
    seed: tSeed,
    snow: true,
    smoothSnow: true,
    snowCols: 10,
    snowHalfK: 0.6,
    parent: 0,
    atPoint: ATTACH.FORK,
  });

  // ---- 7 股主枝：内圈 3 股斜升撑冠顶，外圈 4 股长弧线外拱下垂（裙枝）；az 在 x-z 平面里量，0 = 朝栖枝 ----
  interface Scaffold {
    key: string;
    at: number;
    az: number;
    reach: number;
    a0: number;
    a1: number;
    wobble: number;
    r0: number;
    snowDepth: number;
    inner: boolean;
  }
  const scaffolds: Scaffold[] = [
    { key: 'I1', at: ATTACH.FORK, az: 30, reach: 250, a0: 76, a1: 14, wobble: 0.045, r0: 6.0, snowDepth: 0.5, inner: true },
    { key: 'I2', at: ATTACH.FORK, az: 125, reach: 228, a0: 74, a1: 14, wobble: 0.05, r0: 5.6, snowDepth: 0.5, inner: true },
    { key: 'I3', at: ATTACH.LOW, az: 215, reach: 192, a0: 66, a1: 10, wobble: 0.05, r0: 5.2, snowDepth: 0.5, inner: true },
    { key: 'O1', at: ATTACH.LOW, az: 345, reach: 200, a0: 50, a1: -8, wobble: 0.06, r0: 6.6, snowDepth: 0.6, inner: false },
    { key: 'O2', at: ATTACH.O, az: 170, reach: 190, a0: 48, a1: -10, wobble: 0.06, r0: 6.0, snowDepth: 0.6, inner: false },
    { key: 'O3', at: ATTACH.O, az: 80, reach: 200, a0: 38, a1: -18, wobble: 0.055, r0: 6.4, snowDepth: 0.6, inner: false },
    { key: 'O4', at: ATTACH.O, az: 290, reach: 174, a0: 26, a1: -22, wobble: 0.06, r0: 5.4, snowDepth: 0.6, inner: false },
  ];
  const trunkChildren: number[] = [transitionIndex];
  const secondaryParents: number[] = [];
  const scaffoldInner = new Map<number, boolean>();
  for (const sc of scaffolds) {
    const base = TRUNK[sc.at].p;
    const phase = rng() * 6.28;
    const radii = [sc.r0, sc.r0 * 0.6, sc.r0 * 0.35, sc.r0 * 0.16, 0.06];
    let reach = sc.reach;
    let pts = archLimb(base, sc.az, reach, sc.a0, sc.a1, sc.wobble, phase);
    // 撞进禁入区的主枝：缩短重长（不耗随机数，其余枝条不受影响）
    for (let tries = 0; avoid && tries < 6 && !avoid(pts, radii); tries++) {
      reach *= 0.88;
      pts = archLimb(base, sc.az, reach, sc.a0, sc.a1, sc.wobble, phase);
    }
    trunkChildren.push(specs.length);
    scaffoldInner.set(specs.length, sc.inner);
    specs.push({
      points: pts,
      radii,
      segments: 64,
      radial: 12,
      seed: sd(),
      snow: true,
      snowDepth: sc.snowDepth,
      snowCols: 10,
      smoothSnow: true,
      snowHalfK: 0.85,
      parent: 0,
      atPoint: sc.at,
    });
    secondaryParents.push(specs.length - 1);
  }

  // ---- 二级枝（母枝 = 主枝）：左右交替斜出，先升后平再受重力下垂，带合轴曲折 ----
  const twigCandidates: { index: number; spec: LimbSpec; curve: CatmullRomCurve3 }[] = [];
  const secondaryIndices: { index: number; spec: LimbSpec; curve: CatmullRomCurve3 }[] = [];
  const branchFrom = (parentIndex: number, t: number, azOff: number, L: number, a0: number, a1: number, zig: number): { pts: P3[]; base: Vector3 } => {
    const parentSpec = specs[parentIndex];
    const curve = curveOf(parentSpec);
    const base = curve.getPointAt(t);
    const tan = curve.getTangentAt(t);
    const az = Math.atan2(tan.z, tan.x) + azOff * DEG;
    const dir = new Vector3(Math.cos(az), 0, Math.sin(az));
    const side = new Vector3(-dir.z, 0, dir.x);
    const pts: P3[] = [P(base.x, base.y, base.z)];
    const stations = [0.35, 0.68, 1.0];
    const flip = rng() < 0.5 ? 1 : -1;
    let h = 0;
    let sPrev = 0;
    stations.forEach((u, i) => {
      const a = (a0 + (a1 - a0) * u) * DEG;
      h += Math.tan(a) * (u - sPrev) * L;
      sPrev = u;
      // 之字折曲：每一站往侧向反方向摆 zig，摆幅随弧长放大（海棠细枝特有的微折曲，没有三点共线的直刺）
      const lat = (i % 2 === 0 ? 1 : -1) * flip * zig * L * (0.3 + 0.7 * u);
      pts.push(P(base.x + dir.x * u * L + side.x * lat, base.y + h, base.z + dir.z * u * L + side.z * lat));
    });
    return { pts, base };
  };
  for (const parentIndex of secondaryParents) {
    const parentSpec = specs[parentIndex];
    const isInner = scaffoldInner.get(parentIndex) === true;
    const ts = isInner ? [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.97] : [0.26, 0.36, 0.46, 0.56, 0.66, 0.76, 0.86, 0.96];
    let sideSign = rng() < 0.5 ? 1 : -1;
    for (const t of ts) {
      const rHere = parentSpec.radii[0] + (parentSpec.radii[parentSpec.radii.length - 1] - parentSpec.radii[0]) * t;
      const L = ((isInner ? 100 : 82) + rng() * (isInner ? 70 : 52)) * (1 - 0.3 * t) * (t > 0.8 ? 1 - 0.35 * (t - 0.8) / 0.2 : 1);
      const a0 = (isInner ? 40 : 26) + rng() * 12;
      const a1 = (isInner ? -12 : -22) - rng() * 14;
      const azOff = sideSign * (42 + rng() * 24);
      sideSign = -sideSign;
      // 基部半径自己先钳到 0.68 × 母枝 here 的半径（契约钳 0.72，后面的键按比例跟着才不会鼓包）
      const r0 = Math.min(Math.max(0.42, 0.46 * rHere), 0.68 * rHere);
      const { pts } = branchFrom(parentIndex, t, azOff, L, a0, a1, 0.06 + rng() * 0.04);
      const radiiSec = [r0, r0 * 0.6, r0 * 0.3, Math.min(0.08, r0 * 0.2)];
      if (avoid && !avoid(pts, radiiSec)) continue;
      specs.push({
        points: pts,
        radii: radiiSec,
        segments: 24,
        radial: 8,
        seed: sd(),
        snow: true,
        snowDepth: 0.25,
        snowCols: 5,
        smoothSnow: true,
        snowHalfK: 0.9,
        young: 0.3,
        buds: [0.97],
        parent: parentIndex,
        at: t,
      });
      const idx = specs.length - 1;
      secondaryIndices.push({ index: idx, spec: specs[idx], curve: curveOf(specs[idx]) });
    }
  }

  // ---- 三级冠梢（母枝 = 二级枝）：当年生栗红细梢，之字折曲 + 重力下垂，末梢一枚顶芽；果台多半挂在这些梢上 ----
  for (const sec of secondaryIndices) {
    const tts = [0.2, 0.32, 0.44, 0.56, 0.68, 0.8, 0.9, 0.97].filter(() => rng() > 0.1);
    let sideSign = rng() < 0.5 ? 1 : -1;
    for (const tt of tts) {
      const L2 = 38 + rng() * 42 * (1 - 0.35 * tt);
      const a0 = 15 + rng() * 12;
      const a1 = -35 - rng() * 20;
      const azOff = sideSign * (38 + rng() * 30);
      sideSign = -sideSign;
      // 基部半径按母枝 here 的半径取（焊合契约只钳 radii[0]，后面的键不跟着缩会在梢中段鼓一个包）
      const rHere = sec.spec.radii[0] + (sec.spec.radii[sec.spec.radii.length - 1] - sec.spec.radii[0]) * tt;
      const r0 = Math.min(0.34, 0.6 * rHere);
      const { pts } = branchFrom(sec.index, tt, azOff, L2, a0, a1, 0.12 + rng() * 0.08);
      const radii3 = [r0, r0 * 0.58, r0 * 0.17];
      if (avoid && !avoid(pts, radii3)) continue;
      specs.push({
        points: pts,
        radii: radii3,
        segments: 14,
        radial: 6,
        seed: sd(),
        snow: true,
        snowDepth: 0.1,
        snowCols: 2,
        young: 0,
        parent: sec.index,
        at: tt,
      });
      twigCandidates.push({ index: specs.length - 1, spec: specs[specs.length - 1], curve: curveOf(specs[specs.length - 1]) });
    }
  }

  // ---- 果台：冠梢上 55%、二级枝上 60%、主枝外段 45% 的概率各挂一簇（160~220 簇），从枝侧斜出、略往下 ----
  const spurs: number[] = [];
  const hangSpur = (c: { index: number; spec: LimbSpec; curve: CatmullRomCurve3 }, t: number): void => {
    const base = c.curve.getPointAt(t);
    const tan = c.curve.getTangentAt(t);
    const rHere = c.spec.radii[0] + (c.spec.radii[c.spec.radii.length - 1] - c.spec.radii[0]) * t;
    const ss = rng() < 0.5 ? 1 : -1;
    const az = Math.atan2(tan.z, tan.x) + ss * (60 + rng() * 30) * DEG;
    const dir = new Vector3(Math.cos(az), 0, Math.sin(az)).setY(-0.1 - rng() * 0.2).normalize();
    const L = 4 + rng() * 4;
    // 起始半径自己先钳到 0.72 × 母枝半径（焊合契约会再钳一次），后面的键按比例跟着，不然钳完会鼓出一个包
    const r0 = Math.min(Math.max(0.22, 0.8 * rHere), 0.7 * rHere);
    const pts: P3[] = [P(base.x, base.y, base.z), P(base.x + dir.x * 0.5 * L, base.y + dir.y * 0.5 * L, base.z + dir.z * 0.5 * L), P(base.x + dir.x * L, base.y + dir.y * L, base.z + dir.z * L)];
    const seed = sd();
    const fruits = 4 + Math.floor(rng() * 2);
    if (avoid && !avoid(pts, [r0, r0 * 0.55, 0.1])) return;
    specs.push({
      points: pts,
      radii: [r0, r0 * 0.55, 0.1],
      segments: 4,
      radial: 4,
      seed,
      snow: false,
      young: 0.75,
      berries: { fruits, empty: 0, far: true },
      berryScale: 6.0,
      parent: c.index,
      at: t,
      perch: false,
    });
    spurs.push(specs.length - 1);
  };
  for (const tw of twigCandidates) if (rng() < 0.33) hangSpur(tw, 0.4 + rng() * 0.5);
  for (const sec of secondaryIndices) if (rng() < 0.6) hangSpur(sec, 0.5 + rng() * 0.45);
  for (const pi of secondaryParents) {
    const sc = { index: pi, spec: specs[pi], curve: curveOf(specs[pi]) };
    if (rng() < 0.45) hangSpur(sc, 0.7 + rng() * 0.25);
  }

  return {
    specs,
    // 树兜雪坡：半径 2.4 m，外缘用长距离渐隐融进雾里（以前 R 60 的雪饼在全景里是一枚荷包蛋）
    rootMound: { center: [c0[0], c0[1], c0[2]], R: 240, H: 14, seed: 5 },
    trunkChildren,
    spurs,
  };
}
