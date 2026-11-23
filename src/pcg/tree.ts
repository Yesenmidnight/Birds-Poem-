/**
 * 整棵树（纯数据）：鸟停的那根主枝是“主角枝”，位置原封不动（观鸟入口靠它定脚爪落点），
 * 树干从它粗端的正后方长出来，其余枝条围绕树干一层层长出去。
 *
 * 输出的每一根枝条都是 TreeLimb（一种 CurveLayout）：碰撞层（buildWorld → CurvePerch）和画面层
 * （Branches.addLimbs：树皮 / 积雪 / 芽点）读的是同一份数据，谁都不手填几何。
 * 子枝的附着点在父枝的**真实轴线**上取（和碰撞体同一个样条采样器）——按控制折线取会偏出 1~2 cm，
 * 子枝基部就从父枝里露出来（tools/sim.mjs 的 tree 场景核对这一点）。
 * 只用可擦除语法、相对导入写全 .ts 扩展名，Node 直接 import。
 */
import { flattenPoints, sampleArc } from '../sim/spline.ts';
import { interpKeys, makeRng } from '../util/math.ts';
import type { CurveLayout, TreeLimb, TreeLayout } from './layout.ts';

type V3 = [number, number, number];
const DEG = Math.PI / 180;

/** 轴线采样数（附着点在它上面取）。 */
const AXIS_DIV = 64;

/** 一根枝条的真实轴线：弧长比例 t 处的中心点、切向，返回当地的半径（半径按弧长等分插值，和 buildCurve 一致）。 */
class Axis {
  private readonly centers: Float64Array;
  private readonly radii: readonly number[];
  constructor(points: readonly V3[], radii: readonly number[]) {
    this.radii = radii;
    this.centers = sampleArc(flattenPoints(points), points.length, AXIS_DIV).centers;
  }
  at(t: number, outP: V3, outT: V3): number {
    const c = this.centers;
    const i = Math.round(Math.min(1, Math.max(0, t)) * AXIS_DIV);
    outP[0] = c[i * 3];
    outP[1] = c[i * 3 + 1];
    outP[2] = c[i * 3 + 2];
    const a = Math.max(0, i - 1) * 3;
    const b = Math.min(AXIS_DIV, i + 1) * 3;
    const dx = c[b] - c[a];
    const dy = c[b + 1] - c[a + 1];
    const dz = c[b + 2] - c[a + 2];
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    outT[0] = dx / len;
    outT[1] = dy / len;
    outT[2] = dz / len;
    return interpKeys(this.radii as number[], i / AXIS_DIV);
  }
}

/** 方位角（+X 为 0，朝 +Z 为正）+ 仰角 → 单位方向。 */
function dirFrom(az: number, elev: number, out: V3): V3 {
  const c = Math.cos(elev);
  out[0] = c * Math.cos(az);
  out[1] = Math.sin(elev);
  out[2] = c * Math.sin(az);
  return out;
}

/** 从方向向量反算方位角 / 仰角（弧度）。 */
function anglesOf(d: readonly number[]): { az: number; elev: number } {
  const h = Math.hypot(d[0], d[2]);
  return { az: Math.atan2(d[2], d[0]), elev: Math.atan2(d[1], h) };
}

/**
 * 一根枝条的控制点：从 base 出发，方向从 (az0, elev0) 平滑转到 (az0 + bend, elev1)，4 个控制点。
 * az0 / elev0 / elev1 是弧度，bend 是度（真树的一级枝都是“先仰后平”地往外甩：仰角沿枝一路往下走，
 * 方位角只慢慢偏十几度；偏转按 u² 越靠梢越偏）。
 */
function limbPoints(base: V3, az0: number, elev0: number, elev1: number, bendDeg: number, length: number): V3[] {
  const pts: V3[] = [[base[0], base[1], base[2]]];
  const d: V3 = [0, 0, 0];
  const step = length / 3;
  const bend = bendDeg * DEG;
  for (let k = 1; k <= 3; k++) {
    const u = k / 3;
    dirFrom(az0 + bend * u * u, elev0 + (elev1 - elev0) * u, d);
    const p = pts[k - 1];
    pts.push([p[0] + d[0] * step, p[1] + d[1] * step, p[2] + d[2] * step]);
  }
  return pts;
}

/**
 * 一级枝的排布：在树干上的弧长比例、方位角（度）、长度、起止仰角、方位偏转。
 * 方位按 137° 的叶序绕干交错；朝 +Z 的几根都放在电线（y≈100）以上，朝 +X / −X 的放在下部，
 * 最低一根朝 −X（鸟的背后、远离所有看鸟机位）。长度随高度递减：下部的枝能到树干一半长，树冠才撑得开。
 */
const LIMB_PLAN = [
  { t: 0.33, az: 180, len: 150, elev0: 40, elev1: 8, bend: -14 },
  { t: 0.42, az: 317, len: 140, elev0: 44, elev1: 14, bend: 12 },
  { t: 0.5, az: 231, len: 125, elev0: 46, elev1: 16, bend: -10 },
  { t: 0.58, az: 94, len: 110, elev0: 48, elev1: 20, bend: 10 },
  { t: 0.66, az: 8, len: 95, elev0: 50, elev1: 24, bend: -8 },
  { t: 0.74, az: 282, len: 85, elev0: 52, elev1: 26, bend: 8 },
  { t: 0.82, az: 145, len: 70, elev0: 54, elev1: 30, bend: -8 },
  { t: 0.9, az: 40, len: 55, elev0: 56, elev1: 36, bend: 6 },
];

/** 二级枝 / 细枝会颤：鸟（8 g）落上去只是轻轻一沉；无头压测里小球砸上去的幅度也在厘米级。 */
const SECONDARY_SPRING = { freq: 2.2, damping: 0.08, gain: 0.03 };
const TWIG_SPRING = { freq: 4.5, damping: 0.06, gain: 0.1 };

/**
 * 长一棵树。hero 是主角枝（world/Branch.ts 的 LIMBS[0] 同一份数据）：树干贴着它粗端的后方长出来，
 * 它本身不在返回值里——碰撞体由调用方按 hero 另建，画面由 Branches 自己画。
 */
export function growTree(seed: number, hero: CurveLayout): TreeLayout {
  const rng = makeRng(seed);
  const limbs: TreeLimb[] = [];
  const hb = hero.points[0];

  // 树干：从雪面下 6 cm 起，贴着主角枝粗端正后方（离它 2 cm，主角枝 2.4 的基部整个藏在干里）笔直向上，
  // 过了电线高度以后微微向 −Z 倾，顶到雪面上方 3.8 m。半径 8.4 → 1.0，根部外扩
  const trunkPts: V3[] = [
    [hb[0] - 1.5, -86, hb[2] - 1.5],
    [hb[0] - 1.3, -40, hb[2] - 1.6],
    [hb[0] - 1.2, hb[1] - 0.4, hb[2] - 1.7],
    [hb[0] - 1.6, 40, hb[2] - 3.5],
    [-48.5, 95, -18.5],
    [-48.5, 150, -22.5],
    [-46, 205, -25.5],
    [-41, 255, -26.5],
    [-35, 300, -25],
  ];
  const trunkRadii = [8.4, 7.5, 6.9, 6.2, 5.4, 4.5, 3.5, 2.4, 1.0];
  limbs.push({
    tag: 'tree',
    points: trunkPts,
    radii: trunkRadii,
    segments: 80,
    radial: 36,
    seed: Math.floor(rng() * 100),
    // 近竖直的干没有积雪帽（顶面方向退化），侧面的雪靠树皮材质按 N.y 自己判
    snow: false,
    parent: -1,
    attach: 0,
  });
  const TRUNK = 0;
  const trunkAxis = new Axis(trunkPts, trunkRadii);

  const p: V3 = [0, 0, 0];
  const tn: V3 = [0, 0, 0];

  // 一级枝：按计划绕干分层
  for (const plan of LIMB_PLAN) {
    const rParent = trunkAxis.at(plan.t, p, tn);
    const rBase = 0.52 * rParent;
    const len = plan.len * (0.9 + rng() * 0.2);
    const az = (plan.az + (rng() - 0.5) * 14) * DEG;
    const elev0 = (plan.elev0 + (rng() - 0.5) * 8) * DEG;
    const elev1 = (plan.elev1 + (rng() - 0.5) * 8) * DEG;
    const bend = plan.bend + (rng() - 0.5) * 10;
    const pts = limbPoints(p, az, elev0, elev1, bend, len);
    const radii = [rBase, rBase * 0.72, rBase * 0.45, rBase * 0.25];
    const idx = limbs.length;
    limbs.push({
      tag: 'tree',
      points: pts,
      radii,
      segments: 48,
      radial: 22,
      seed: Math.floor(rng() * 100),
      snow: true,
      parent: TRUNK,
      attach: plan.t,
    });
    const axis1 = new Axis(pts, radii);

    // 二级枝：沿一级枝左右交替，3~4 根，能到父枝的一半长（越靠枝梢越短）
    const n2 = 3 + (rng() < 0.4 ? 1 : 0);
    for (let k = 0; k < n2; k++) {
      const t = 0.32 + (k / n2) * 0.62 + (rng() - 0.5) * 0.06;
      const r2 = 0.5 * axis1.at(t, p, tn);
      const a = anglesOf(tn);
      const side = k % 2 === 0 ? 1 : -1;
      const az2 = a.az + side * (40 + rng() * 25) * DEG;
      const e0 = a.elev + (rng() - 0.5) * 16 * DEG;
      const e1 = e0 - (15 + rng() * 12) * DEG;
      const len2 = len * (0.45 + rng() * 0.15) * (1 - 0.35 * t);
      const pts2 = limbPoints(p, az2, e0, e1, side * (6 + rng() * 10), len2);
      const radii2 = [r2, r2 * 0.7, r2 * 0.42, r2 * 0.18];
      const idx2 = limbs.length;
      limbs.push({
        tag: 'tree',
        points: pts2,
        radii: radii2,
        segments: 28,
        radial: 14,
        seed: Math.floor(rng() * 100),
        snow: true,
        spring: SECONDARY_SPRING,
        parent: idx,
        attach: t,
      });
      const axis2 = new Axis(pts2, radii2);

      // 细枝：二级枝上 3~5 根，带芽，落上会颤
      const n3 = 3 + Math.floor(rng() * 3);
      for (let j = 0; j < n3; j++) {
        const t3 = Math.min(1, 0.4 + (j / Math.max(1, n3 - 1)) * 0.55 + (rng() - 0.5) * 0.05);
        const r3 = 0.5 * axis2.at(t3, p, tn);
        const a3 = anglesOf(tn);
        const side3 = j % 2 === 0 ? -1 : 1;
        const az3 = a3.az + side3 * (35 + rng() * 25) * DEG;
        const e3 = a3.elev + (rng() - 0.5) * 20 * DEG;
        const len3 = Math.max(8, len2 * (0.35 + rng() * 0.15));
        limbs.push({
          tag: 'tree-twig',
          points: limbPoints(p, az3, e3, e3 - (10 + rng() * 15) * DEG, side3 * (8 + rng() * 12), len3),
          radii: [r3, r3 * 0.65, r3 * 0.35, 0.05],
          segments: 14,
          radial: 8,
          seed: Math.floor(rng() * 100),
          snow: true,
          spring: TWIG_SPRING,
          buds: [0.5 + rng() * 0.08, 0.7 + rng() * 0.08, 0.88 + rng() * 0.08].sort((x, y) => x - y),
          parent: idx2,
          attach: t3,
        });
      }
    }
  }

  return { limbs, trunk: TRUNK, base: [trunkPts[0][0], trunkPts[0][1], trunkPts[0][2]] };
}
