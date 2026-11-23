import {
  BufferGeometry,
  CatmullRomCurve3,
  Curve,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Matrix4,
  Mesh,
  Quaternion,
  SphereGeometry,
  TubeGeometry,
  Vector2,
  Vector3,
  Vector4,
  type IUniform,
  type Raycaster,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeLitMaterial, rgb, type LightingUniforms } from '../glsl/lit';
import { NOISE_GLSL } from '../glsl/noise';
import type { Perch } from '../bird/parts';
import { TAU, clamp, interpKeys, lerp, makeRng, noise1, noise3, smoothstep } from '../util/math';
import { BranchSway, FRUIT_SWAY_GLSL, LIMB_GLSL, SWAY_GLSL, makeLimbUniforms, writeLimbSlots } from './branchSway';
import { HairField } from './hairs';
import { makeLichenMaterial, makeMossMaterial, shellStack } from './shellFuzz';
import { HAZE_GLSL, makeHazeUniforms } from './haze';
import { growCrabappleTree, type CrabappleTreeOptions } from './crabappleTree';

/** 没开大气透视时各材质共用的一组雾 uniform（长度 0 = 关闭，画面逐位不变）。 */
const NO_HAZE = makeHazeUniforms();
/** 没挂到会晃的树上时（观鸟入口的果簇材质）共用的空活跃枝槽位：全部为 0 = 顶点不动。 */
const NO_LIMB = makeLimbUniforms();

/**
 * 程序化冬枝：沿样条曲线放平行标架，半径由关键点插值再叠加树皮微雕（纵裂沟、枝节微膨环、木疤）；
 * 树皮配色（条纹、沟底压暗、横向皮孔、地衣斑、残雪）在片元着色器里按“沿枝长度 × 环向角”现算。
 * 观鸟入口的主枝上再挂：层叠芽鳞的冬芽、雪顶红果侧枝、多壳层的冬苔藓 / 地衣绒垫、单三角形的植物细绒毛与雾凇霜针，
 * 全部跟着悬臂梁弯曲模态一起颤（branchSway.ts）。
 */
export interface LimbSpec {
  points: [number, number, number][];
  radii: number[];
  segments?: number;
  radial?: number;
  seed?: number;
  snow?: boolean;
  /** 额外的积雪厚度（厘米）：远看的大树枝要更厚的雪才读得出雪冠（观鸟主枝不填，公式逐位不变）。 */
  snowDepth?: number;
  /** 雪面以抹平纵裂沟 / 细颗粒的树皮为底（粗枝用：雪帽网格一列 0.4 cm 宽，贴着沟底走沟脊会戳穿雪沿成黑牙）。观鸟主枝不填。 */
  smoothSnow?: boolean;
  /** 雪帽半宽的倍率（远看的大树枝填 0.6~0.75：真树老枝上的雪是一条压在顶面的脊，两侧露出暗皮；观鸟主枝不填 = 1，公式逐位不变）。 */
  snowHalfK?: number;
  /** 在这些弧长比例处长芽。 */
  buds?: number[];
  /** 木疤：[沿枝弧长 cm, 环向角 rad, 大小 cm]，只给主枝。 */
  knots?: [number, number, number][];
  /** 这根枝长在母枝（主枝）的哪个归一化弧长上：随主枝的弯曲一起动（不填 = 不动）。 */
  attach?: number;
  /** 自己也弯：用红果侧枝那个滞后振子（aSway.z = 1）。 */
  bend?: boolean;
  /** 之字形枝节所在的控制点序号：节上微膨 + 紧随其后的环状叶痕皱褶（细枝 / 果台用）。 */
  nodePoints?: number[];
  /** 从这个归一化弧长起是当年生嫩梢：树皮染栗褐、皮孔浅色略明显。 */
  young?: number;
  /**
   * 母子枝中心轴焊合契约（所有非主枝必须填）：parent = 母枝在 (LIMBS + FRONT_LIMBS) 全表里的序号（0 = 主枝）；
   * 附着位置三选一：atX = 母枝上的枝条坐标 x（主枝用）、atPoint = 母枝控制点序号、at = 母枝上的归一化弧长。
   * 建网格前起点强制覆写为母枝样条在该处的精确中心、第二控制点顺母枝切线过渡、起始半径钳到 0.72 × 母枝半径；
   * attach（主枝模态弧长）和子枝的刚性附着弧长全部由附着位置算出，不手估。
   */
  parent?: number;
  atX?: number;
  atPoint?: number;
  at?: number;
  /** 短果台：从这一根的梢头呈伞房状束生一簇越冬海棠果（fruits 果数；empty 不带果的空果梗数）。 */
  berries?: { fruits: number; empty: number; far?: boolean };
  /** 果的大小：相对观鸟入口那枚 3 mm 迷你果的倍数（addWeldedLimbs 用；院心老树 ~1 cm 的果 = 3.8）。 */
  berryScale?: number;
  /** 积雪帽的环向列数（不填 = 观鸟主枝的 14；远看的细枝可以降到 6~8 省面数，雪帽的 aSnow / 边缘锯齿公式不变）。 */
  snowCols?: number;
  /** false = 不是栖木（板根 / 果台）：舞台建碰撞体时跳过它（画面照常画）。不填 = 可落。 */
  perch?: boolean;
}

/** 一枚冬芽的摆放：位置 / 朝向 / 大小、主枝模态的 aSway，它在枝上的归一化弧长 t，和焊合树的枝条随动标签（limb）。 */
interface BudSpot {
  p: Vector3;
  q: Quaternion;
  s: Vector3;
  sway: [number, number, number];
  t: number;
  /** [自己的枝号 + 1, 母枝号 + 1, 焊口弧长]（焊合树才有）：芽按 t 跟着枝弯。 */
  limb?: readonly [number, number, number];
}

interface Frame {
  c: Vector3;
  t: Vector3;
  n: Vector3;
  b: Vector3;
  r: number;
  along: number;
  /** 枝节（叶痕环）的弧长位置（厘米）：没有的枝为 undefined。 */
  nodes?: readonly number[];
  /** 子枝穿出母枝树皮的弧长位置和枝领扩粗量（厘米）：喇叭形枝领从穿出点顺着子枝指数衰减；主枝为 undefined。 */
  collar?: readonly [number, number];
  /** 额外的积雪厚度（厘米），来自 LimbSpec.snowDepth。 */
  snowDepth?: number;
  smoothSnow?: boolean;
  snowHalfK?: number;
}

const UP = new Vector3(0, 1, 0);

/** 0..1 的整数哈希（枝节位置抖动用）。 */
function hash1(n: number): number {
  const s = Math.sin(n * 12.9898 + 4.1414) * 43758.5453;
  return s - Math.floor(s);
}

/** 平行传输标架：法线沿曲线平滑旋转，不会像 Frenet 标架那样在拐点翻转。 */
export function parallelFrames(points: Vector3[]): { t: Vector3; n: Vector3; b: Vector3 }[] {
  const count = points.length;
  const tangents: Vector3[] = [];
  for (let i = 0; i < count; i++) {
    const a = points[Math.max(i - 1, 0)];
    const b = points[Math.min(i + 1, count - 1)];
    tangents.push(new Vector3().subVectors(b, a).normalize());
  }
  const t0 = tangents[0];
  const ref = Math.abs(t0.y) < 0.9 ? UP : new Vector3(1, 0, 0);
  let n = new Vector3().crossVectors(t0, ref).normalize();
  const q = new Quaternion();
  const axis = new Vector3();
  const out: { t: Vector3; n: Vector3; b: Vector3 }[] = [];
  for (let i = 0; i < count; i++) {
    const t = tangents[i];
    if (i > 0) {
      axis.crossVectors(tangents[i - 1], t);
      const sin = axis.length();
      const cos = clamp(tangents[i - 1].dot(t), -1, 1);
      if (sin > 1e-7) {
        q.setFromAxisAngle(axis.multiplyScalar(1 / sin), Math.atan2(sin, cos));
        n.applyQuaternion(q);
      }
      n.addScaledVector(t, -n.dot(t)).normalize();
    }
    out.push({ t: t.clone(), n: n.clone(), b: new Vector3().crossVectors(t, n).normalize() });
  }
  return out;
}

/**
 * 树皮表面半径（厘米）：基础半径 + 低频鼓包 + 细碎粗糙 − 纵裂沟 + 枝节微膨环 + 木疤。
 * 网格、积雪、脚爪抓握查询都走这一个函数，脚趾贴的就是画出来的那个树皮面。cx / cz 是环向的余弦 / 正弦。
 */
export function ringRadius(r: number, along: number, cx: number, cz: number, seed: number, knots?: readonly [number, number, number][], nodes?: readonly number[], collar?: readonly [number, number], smooth = false): number {
  const lump = (noise3(along * 0.5 + seed * 13.7, cx * 1.6, cz * 1.6) - 0.5) * 2;
  const fine = (noise3(along * 3.5 + seed * 7.1, cx * 5.0, cz * 5.0) - 0.5) * 2;
  let extra = 0;
  // 纵裂沟：沿枝拉长的沟壑，环向频率按周长定（间距约 0.35 cm，粗枝最疏）。只在噪声低谷里刻一道细沟（约一成面积），
  // 半径 0.14~0.36 cm 以上就有（鸟脚下的栖枝也看得到苍劲的纵向裂纹），深度随半径（粗枝约 2 mm）
  // 老干（r > 2.5）上的纵裂沟是纵向长沟：环向 2.5 cm 一道（kf = 0.4 r）、沿枝 25 cm 一个起伏；细枝保持 0.35 cm 的细裂纹
  const bigG = smoothstep(2.5, 7, r);
  const kf = r * 0.4 * bigG + clamp(r / 0.35, 0.6, 3.5) * (1 - bigG);
  const fis = noise3(along * (0.9 - 0.86 * bigG) + seed * 3.3 + 11.0, cx * kf, cz * kf);
  const groove = clamp((-0.35 - fis) / 0.35, 0, 1);
  // smooth：给粗枝的雪面当基底——雪会把纵裂沟和细颗粒填平，而不是贴着沟底走（见 snowSurface）
  if (!smooth) extra -= r * 0.1 * groove * groove * smoothstep(0.14, 0.36, r);
  // 枝节微膨环（细枝上才看得见）：每隔约 3.1 cm（按种子抖动）一圈微膨，紧随其后一道浅沟
  if (r < 1.3) {
    const P = 3.1;
    const i = Math.floor(along / P);
    const p = (i + 0.5) * P + (hash1(i * 7.31 + seed * 13.7) - 0.5) * 1.4;
    const d = along - p;
    extra += r * (0.07 * Math.exp(-(d * d) / 0.0256) - 0.03 * Math.exp(-((d - 0.3) ** 2) / 0.0144));
  }
  // 之字形枝节（叶痕环）：节上鼓起一个不规则的疙瘩，往梢侧 0.45 mm 一道紧挨着的环沟——海棠 / 苹果属枝条的标志性节点
  if (nodes) {
    for (const na of nodes) {
      const d = along - na;
      extra += r * (0.22 * Math.exp(-(d * d) / 0.0009) - 0.1 * Math.exp(-((d - 0.045) ** 2) / 0.0004));
    }
  }
  // 木疤：中心一个发暗的凹坑、外圈一道隆起
  if (knots) {
    const th = Math.atan2(cz, cx);
    for (const kn of knots) {
      const dth = Math.atan2(Math.sin(th - kn[1]), Math.cos(th - kn[1]));
      const d2 = ((along - kn[0]) / 0.14) ** 2 + ((dth * r) / 0.11) ** 2;
      extra += kn[2] * (Math.exp(-d2) - 1.4 * Math.exp(-d2 * 5));
    }
  }
  // 枝领：子枝从母枝树皮穿出处（collar[0]）最粗，顺着子枝约 2.5 个直径内指数衰减成正常的枝粗——
  // 真实侧枝的基部是喇叭形接进母枝的，没有这一圈浅角钻出的枝会被雪面 / 母枝轮廓截成一道平切口；埋在母枝木质里的那段保持穿出点的粗细
  if (collar !== undefined) extra += collar[1] * Math.exp(-Math.max(along - collar[0], 0) / 0.12);
  return r * (1 + 0.03 * lump + (smooth ? 0 : 0.03 * fine)) + extra;
}

/** 枝条横截面的“顶面”方向与“侧向”（侧向 = 切线 × 顶面，主枝上指向枝条坐标系的 +Z）。 */
export function limbAxes(t: Vector3, up: Vector3, side: Vector3): void {
  up.copy(UP).addScaledVector(t, -UP.dot(t)).normalize();
  side.crossVectors(t, up).normalize();
}

/** 积雪帽的半宽（弧度）：越平的枝条积雪越宽，越陡越窄；细梢只挂一条窄边。 */
function snowHalf(f: Frame, seed: number): number {
  return 1.62 * (1 - 0.5 * Math.abs(f.t.y)) * (0.86 + 0.28 * (noise1(f.along * 0.45 + seed, 3) - 0.5) * 2) * clamp(f.r / 0.3, 0.35, 1) * (f.snowHalfK ?? 1);
}

/** 脚爪落点（枝条坐标系的 x 与环向角）：积雪在这里被踩得微微凹下去。对外接口（观鸟 / 漫游入口都用 x）。 */
export interface SnowPress {
  worldX: number;
  alpha: number;
}
/**
 * 踩凹的内部表示：worldX 换算成主枝的累积弧长（雪帽网格的 aSnow.x 和 CPU 的 snowSurface 用的都是累积弧长，
 * 两边逐位一致，tools/rigcheck.mjs 才能逐顶点对上；以前这里混用了 x，凹印落到了 47 cm 外的粗端上）。
 */
interface Press {
  along: number;
  alpha: number;
}
const PRESS_NONE: readonly Press[] = [];
/** 踩凹的深度和半径（厘米）；雪帽的顶点着色器里是同一组常数。 */
const PRESS_DEPTH = 0.035;
const PRESS_RADIUS = 0.16;

/**
 * 积雪帽在环向角 ph（从顶面起算，朝 side 为正）处的表面半径；这个角度上没有雪就返回 null。
 * 网格和脚爪的抓握查询都走这一个函数，脚趾贴的就是真正画出来的那个雪面。
 * press 是脚爪落点（累积弧长）：雪在这些地方被踩得微微凹下去一点，凹不穿到树皮。
 */
export function snowSurface(
  f: Frame,
  seed: number,
  ph: number,
  along: number,
  up: Vector3,
  side: Vector3,
  press: readonly Press[] = PRESS_NONE,
): number | null {
  const half = snowHalf(f, seed);
  if (Math.abs(ph) > half) return null;
  // 大树枝的额外雪厚（远看的树才填；观鸟主枝 0，公式逐位不变）
  const depthAmt = 0.15 * clamp(f.r / 0.55, 0.4, 1.25) + (f.snowDepth ?? 0) * clamp(f.r / 1.5, 0.25, 1);
  const cx = up.x * Math.cos(ph) + side.x * Math.sin(ph);
  const cy = up.y * Math.cos(ph) + side.y * Math.sin(ph);
  const cz = up.z * Math.cos(ph) + side.z * Math.sin(ph);
  const prof = Math.pow(Math.cos((ph / Math.max(half, 1e-3)) * Math.PI * 0.5), 0.7);
  const lumps = 0.55 + 0.45 * noise3(along * 2.0, ph * 2.2 + seed, 5.5);
  const depth = depthAmt * prof * lumps;
  // 粗枝（LimbSpec.smoothSnow）的雪不以真实的沟壑树皮为底，而以抹平纵裂沟 / 细颗粒的树皮为底：雪帽网格在这个半径上一列 0.4 cm 宽，
  // 贴着沟底走的话沟脊会从边缘列之间戳穿雪沿，成一排黑牙。观鸟主枝不填这个标记，网格和抓握查询逐位不变
  const bark = ringRadius(f.r, along, cx * f.n.x + cy * f.n.y + cz * f.n.z, cx * f.b.x + cy * f.b.y + cz * f.b.z, seed, undefined, f.nodes, f.collar, f.smoothSnow === true);
  // 脚爪落点处雪被踩出的小凹：沿枝（累积弧长差）和环向各一个高斯——和雪帽顶点着色器里的公式逐位一致
  let dent = 0;
  for (const p of press) {
    const da = along - p.along;
    const dl = (ph - p.alpha) * f.r;
    dent += PRESS_DEPTH * Math.exp(-(da * da + dl * dl) / (PRESS_RADIUS * PRESS_RADIUS));
  }
  return Math.max(bark, bark + depth + 0.004 - dent);
}

/**
 * 雪帽边缘的蓬松粉雪起伏（厘米）：越靠边越大。只用 sin 组合（CPU 与 GLSL 的 sin 一致），网格、抓握查询与
 * 顶点着色器共用同一个公式——tools/rigcheck.mjs 逐顶点比对网格与查询，两边不能差。
 * 频率必须低于主枝网格步长（2.15 mm）能解析的程度：沿枝 8.5 rad/cm（波长 7.4 mm）和 19 rad/cm（3.3 mm）两项，
 * 以前 47 rad/cm（1.3 mm）比步长还短，边缘混叠成一排等距的白订书针。
 */
export function snowEdgeRelief(along: number, ph: number, edge: number): number {
  const e = Math.max((edge - 0.55) / 0.45, 0);
  if (e <= 0) return 0;
  const n =
    0.6 * Math.sin(along * 8.5 + 1.7 * Math.sin(along * 2.1 + ph * 4.0)) +
    0.4 * Math.sin(along * 19.0 + ph * 14.0 + 0.8 * Math.sin(along * 5.0));
  return 0.024 * e * e * (0.55 + 0.45 * n);
}

export interface Limb {
  bark: BufferGeometry;
  snow: BufferGeometry | null;
  curve: CatmullRomCurve3;
  radii: number[];
  seed: number;
  frames: Frame[];
  /** 枝条总长（厘米）。 */
  length: number;
  /** 这根枝怎么跟着枝条弯曲（aSway 的来源）；不弯的树为 null。 */
  sway?: { attach: number | null; bend: boolean; fixed?: number } | null;
}

/** 母枝上离枝条坐标 x 最近的那一帧所在的归一化弧长（子枝按 x 指定附着位置用）。 */
function arcFractionAtX(limb: Limb, x: number): number {
  const frames = limb.frames;
  let i = 0;
  while (i < frames.length - 2 && frames[i + 1].c.x < x) i++;
  const a = frames[i];
  const b = frames[i + 1];
  const u = clamp((x - a.c.x) / (b.c.x - a.c.x), 0, 1);
  return (i + u) / (frames.length - 1);
}

/** 沿枝归一化弧长 s = along / length 处的帧（相邻两帧线性插值）。 */
export function frameAlong(limb: Limb, along: number): Frame {
  const frames = limb.frames;
  const u = clamp(along / limb.length, 0, 1) * (frames.length - 1);
  const i = Math.min(Math.floor(u), frames.length - 2);
  const a = frames[i];
  const b = frames[i + 1];
  const k = u - i;
  return {
    c: a.c.clone().lerp(b.c, k),
    t: a.t.clone().lerp(b.t, k).normalize(),
    n: a.n.clone().lerp(b.n, k).normalize(),
    b: a.b.clone().lerp(b.b, k).normalize(),
    r: lerp(a.r, b.r, k),
    along: lerp(a.along, b.along, k),
    nodes: a.nodes,
    collar: a.collar,
    snowDepth: a.snowDepth,
    smoothSnow: a.smoothSnow,
    snowHalfK: a.snowHalfK,
  };
}

/** 曲线上离给定点最近的采样点所在的归一化弧长（控制点 → 弧长，枝节 / 果台附着点用）。 */
export function arcFractionAt(curve: CatmullRomCurve3, point: Vector3, samples = 400): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i <= samples; i++) {
    const d = curve.getPointAt(i / samples).distanceToSquared(point);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best / samples;
}

/**
 * 焊合树的枝条随动标签（见 branchSway.ts 的 LIMB_GLSL）：给整块几何写常量的 aLimb / aLimbP——果簇、果顶雪帽、冬芽这类附着物
 * 自己不弯（own = 0），整块刚性跟着母枝在焊口处的位移走；主干上的东西（树兜雪坡、分叉窝雪鞍）两项都 0 = 不动。
 * own / parent 都是枝号 + 1（0 = 无）。
 */
function tagLimbConst(geo: BufferGeometry, own: number, ownS: number, parent: number, parentS: number): BufferGeometry {
  const n = geo.attributes.position.count;
  const a = new Float32Array(n * 2);
  const b = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    a.set([own, ownS], i * 2);
    b.set([parent, parentS], i * 2);
  }
  geo.setAttribute('aLimb', new Float32BufferAttribute(a, 2));
  geo.setAttribute('aLimbP', new Float32BufferAttribute(b, 2));
  return geo;
}

/**
 * swaySpec.attach = null 表示这根就是主枝（aSway.x = 自己的归一化弧长）；否则是挂在主枝 attach 处的子枝
 * （aSway.x = 附着点的归一化弧长、aSway.y = 自己枝内离根的归一化距离）；不传 = 不弯（漫游入口的树）。
 * swaySpec.fixed 给了表示 aSway.y 恒等于它（长在另一根会弯的枝上的短果台：整根跟着那根枝的该处刚性运动）。
 * 踩凹不烘进网格：雪帽顶点着色器按 uPress 现算（换落脚点时跟着走），这里只建没踩过的雪面。
 */
export function buildLimb(spec: LimbSpec, swaySpec?: { attach: number | null; bend: boolean; fixed?: number; collar?: readonly [number, number]; static?: boolean; limb?: readonly [number, number, number] }): Limb {
  const seed = spec.seed ?? 0;
  const segs = spec.segments ?? 150;
  const radial = spec.radial ?? 28;
  const pts = spec.points.map((p) => new Vector3(p[0], p[1], p[2]));
  const curve = new CatmullRomCurve3(pts, false, 'centripetal');
  const length = curve.getLength();
  const centers = curve.getSpacedPoints(segs);
  const pf = parallelFrames(centers);
  // 枝节（叶痕环）：控制点 → 弧长
  const nodes = spec.nodePoints ? spec.nodePoints.map((k) => arcFractionAt(curve, pts[k]) * length) : undefined;

  const frames: Frame[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    frames.push({
      c: centers[i],
      t: pf[i].t,
      n: pf[i].n,
      b: pf[i].b,
      r: interpKeys(spec.radii, t),
      along: t * length,
      nodes,
      collar: swaySpec?.collar,
      snowDepth: spec.snowDepth,
      smoothSnow: spec.smoothSnow,
      snowHalfK: spec.snowHalfK,
    });
  }
  const swayOf = (along: number): [number, number, number] => {
    // static：只要枝领（环向扩粗）不要任何摆动（庭院里焊合的树不弯，aSway 全零）
    if (!swaySpec || swaySpec.static) return [0, 0, 0];
    const d = along / length;
    if (swaySpec.attach === null) return [d, 0, 0];
    return [swaySpec.attach, swaySpec.fixed ?? d, swaySpec.bend ? 1 : 0];
  };

  // ---------- 树皮网格 ----------
  const cols = radial + 1;
  const pos = new Float32Array((segs + 1) * cols * 3);
  const bark = new Float32Array((segs + 1) * cols * 4);
  const knotMask = new Float32Array((segs + 1) * cols);
  const wetA = new Float32Array((segs + 1) * cols);
  const skin = new Float32Array((segs + 1) * cols * 2);
  const sway = new Float32Array((segs + 1) * cols * 3);
  // 焊合树的枝条随动（aLimb / aLimbP，见 branchSway.ts 的 LIMB_GLSL）：没给 limb 标签 = 不写属性（主角枝一套逐位不变）
  const limbTag = swaySpec?.limb;
  const limbA = limbTag ? new Float32Array((segs + 1) * cols * 2) : null;
  const limbB = limbTag ? new Float32Array((segs + 1) * cols * 2) : null;
  const idx: number[] = [];
  const tmp = new Vector3();
  const bUp = new Vector3();
  const bSide = new Vector3();
  const bDir = new Vector3();
  for (let i = 0; i <= segs; i++) {
    const f = frames[i];
    // 到雪帽边缘的角距离（弧度）：雪帽正下方那条融雪湿木带按它算；没有雪帽的枝记 2（着色器里当成"无"）
    limbAxes(f.t, bUp, bSide);
    const half = spec.snow ? snowHalf(f, seed) : 2;
    // 嫩梢标记（0..1）与枝节标记（离最近枝节的高斯，0..1）
    const youngK = spec.young === undefined ? 0 : smoothstep(spec.young - 0.1, spec.young + 0.08, i / segs);
    let nodeK = 0;
    if (nodes) for (const na of nodes) nodeK += Math.exp(-((f.along - na) ** 2) / 0.0009);
    for (let j = 0; j <= radial; j++) {
      const th = (j / radial) * TAU;
      const cx = Math.cos(th);
      const cz = Math.sin(th);
      const rr = ringRadius(f.r, f.along, cx, cz, seed, spec.knots, nodes, swaySpec?.collar);
      tmp.copy(f.c).addScaledVector(f.n, cx * rr).addScaledVector(f.b, cz * rr);
      const k = i * cols + j;
      pos.set([tmp.x, tmp.y, tmp.z], k * 3);
      bark.set([f.along, th, f.r, seed], k * 4);
      knotMask[k] = spec.knots ? 1 : 0;
      skin.set([youngK, Math.min(nodeK, 1)], k * 2);
      bDir.copy(f.n).multiplyScalar(cx).addScaledVector(f.b, cz);
      const phi = Math.atan2(bDir.dot(bSide), bDir.dot(bUp));
      wetA[k] = spec.snow ? clamp(Math.abs(phi) - half, -1, 1) : 2;
      sway.set(swayOf(f.along), k * 3);
      if (limbTag && limbA && limbB) {
        limbA.set([limbTag[0], f.along / length], k * 2);
        limbB.set([limbTag[1], limbTag[2]], k * 2);
      }
      if (i < segs && j < radial) {
        const a = k;
        const b = k + 1;
        const c = k + cols;
        const d = c + 1;
        idx.push(a, b, c, b, d, c);
      }
    }
  }
  const barkGeo = new BufferGeometry();
  barkGeo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  barkGeo.setAttribute('aBark', new Float32BufferAttribute(bark, 4));
  barkGeo.setAttribute('aKnot', new Float32BufferAttribute(knotMask, 1));
  barkGeo.setAttribute('aWet', new Float32BufferAttribute(wetA, 1));
  barkGeo.setAttribute('aSkin', new Float32BufferAttribute(skin, 2));
  barkGeo.setAttribute('aSway', new Float32BufferAttribute(sway, 3));
  if (limbA && limbB) {
    barkGeo.setAttribute('aLimb', new Float32BufferAttribute(limbA, 2));
    barkGeo.setAttribute('aLimbP', new Float32BufferAttribute(limbB, 2));
  }
  barkGeo.setIndex(idx);
  barkGeo.computeVertexNormals();

  // ---------- 积雪帽：只在朝上的一面生成一条有厚度的弧面；靠边的几列带蓬松的锯齿轮廓（真实几何，不是 alpha 裁切） ----------
  let snowGeo: BufferGeometry | null = null;
  if (spec.snow) {
    const K = spec.snowCols ?? 14;
    const scols = K + 1;
    const spos = new Float32Array((segs + 1) * scols * 3);
    const sn = new Float32Array((segs + 1) * scols * 4);
    const ssway = new Float32Array((segs + 1) * scols * 3);
    const slimbA = limbTag ? new Float32Array((segs + 1) * scols * 2) : null;
    const slimbB = limbTag ? new Float32Array((segs + 1) * scols * 2) : null;
    const sidx: number[] = [];
    const up = new Vector3();
    const side = new Vector3();
    const dir = new Vector3();
    for (let i = 0; i <= segs; i++) {
      const f = frames[i];
      limbAxes(f.t, up, side);
      const half = snowHalf(f, seed);
      for (let j = 0; j <= K; j++) {
        const ph = ((j / K) * 2 - 1) * half;
        const edge = Math.abs(ph) / half;
        dir.copy(up).multiplyScalar(Math.cos(ph)).addScaledVector(side, Math.sin(ph));
        // 踩凹不烘进网格：雪帽顶点着色器按 uPress 现算（换落脚点时跟着走），这里只建没踩过的雪面
        const rr = snowSurface(f, seed, ph, f.along, up, side)! + snowEdgeRelief(f.along, ph, edge);
        tmp.copy(f.c).addScaledVector(dir, rr);
        const k = i * scols + j;
        spos.set([tmp.x, tmp.y, tmp.z], k * 3);
        sn.set([f.along, ph, f.r, edge], k * 4);
        ssway.set(swayOf(f.along), k * 3);
        if (limbTag && slimbA && slimbB) {
          slimbA.set([limbTag[0], f.along / length], k * 2);
          slimbB.set([limbTag[1], limbTag[2]], k * 2);
        }
        if (i < segs && j < K) {
          const a = k;
          const b = k + 1;
          const c = k + scols;
          const d = c + 1;
          sidx.push(a, b, c, b, d, c);
        }
      }
    }
    snowGeo = new BufferGeometry();
    snowGeo.setAttribute('position', new Float32BufferAttribute(spos, 3));
    snowGeo.setAttribute('aSnow', new Float32BufferAttribute(sn, 4));
    snowGeo.setAttribute('aSway', new Float32BufferAttribute(ssway, 3));
    if (slimbA && slimbB) {
      snowGeo.setAttribute('aLimb', new Float32BufferAttribute(slimbA, 2));
      snowGeo.setAttribute('aLimbP', new Float32BufferAttribute(slimbB, 2));
    }
    snowGeo.setIndex(sidx);
    snowGeo.computeVertexNormals();
  }

  return { bark: barkGeo, snow: snowGeo, curve, radii: spec.radii, seed, frames, length, sway: swaySpec && !swaySpec.static ? swaySpec : null };
}

/**
 * 主枝 + 几根带芽的细枝，鸟停在主枝 x≈0 处（枝面高度约 y=0）。坐标是枝条自己的坐标系（主枝沿 +X）：观鸟入口把整组绕 Y 转
 * 约 90° 让主枝横穿画面，鸟横站在枝上；漫游入口不转，顺着枝走。抓握查询（perchAt / limbPerch）输出的都是世界坐标。
 * 这是一棵活的、休眠的树（山樱 / 樱桃一类）：细枝皮面光滑红褐带皮孔，枝梢收尖、带顶芽，木疤只出现在粗的老枝段。
 */
export const LIMBS: LimbSpec[] = [
  {
    points: [
      [-46, -4.6, -11],
      [-26, -1.75, -3.7],
      [-11, -0.58, -0.55],
      [0, -0.35, 0],
      [9.5, -0.05, 0.75],
      [21, 1.1, 1.9],
    ],
    // 落脚段（x −1~+1）的半径收到 0.28~0.33：真鸟比例的细栖枝（原来 0.37 太粗，像顺着一根粗管走独木桥）
    radii: [2.4, 1.35, 0.7, 0.36, 0.24, 0.015],
    segments: 320,
    radial: 36,
    seed: 1,
    snow: true,
    buds: [0.86, 0.93, 0.985],
    // 木疤只在粗的老枝段（r > 1 cm）；细枝段是光滑的当年生 / 二年生枝，没有疤
    knots: [
      [10.0, 1.1, 0.04],
      [24.0, 2.3, 0.055],
    ],
  },
  // 侧枝都往 −Z（转了 90° 之后是远离相机的那一侧）斜出生长，不会从鸟胸前穿过
  {
    points: [
      [-13, -0.72, -0.75],
      [-15.2, 1.7, -1.6],
      [-17.8, 3.9, -2.4],
      [-18.6, 6.3, -2.9],
      [-19, 7.6, -2.3],
    ],
    radii: [0.36, 0.26, 0.17, 0.08, 0.015],
    segments: 110,
    radial: 16,
    seed: 2,
    snow: true,
    buds: [0.35, 0.62, 0.88, 0.985],
    parent: 0,
    atX: -13,
  },
  {
    points: [
      // 根部埋在主枝轴心里（主枝在 x = 8 处中心 (8.0, −0.14, 0.62)、半径 0.24），中后段往上、往 −Z 斜出去；
      // 原来起点 (9.5, −0.1, −0.6) 离主枝轴心 1.35 cm，根部切口悬空
      [8.0, -0.14, 0.62],
      [11.5, 1.5, -1.6],
      [13.5, 3.4, -2.3],
      [14.6, 5.2, -2.0],
    ],
    radii: [0.24, 0.16, 0.09, 0.015],
    segments: 110,
    radial: 16,
    seed: 3,
    snow: true,
    buds: [0.4, 0.72, 0.95, 0.985],
    parent: 0,
    atX: 9.5,
  },
  {
    points: [
      [16.5, 0.55, 1.4],
      [19, 0.2, 2.6],
      [21.5, -0.35, 3.4],
    ],
    radii: [0.14, 0.09, 0.012],
    segments: 80,
    radial: 14,
    seed: 4,
    snow: true,
    buds: [0.55, 0.9, 0.98],
    parent: 0,
    atX: 16.5,
  },
];

/** 海棠主梢（FRONT_LIMBS[0]）在 (LIMBS + FRONT_LIMBS) 全表里的序号：它的子枝（分叉、果台）用 parent 指向它。 */
const TWIG = LIMBS.length;

/**
 * 观鸟入口右前景的海棠果枝（漫游入口不装：它的鸟顺着主枝走，不需要前景装饰）。
 * 全部按"母子枝中心轴焊合契约"建（parent + atX / atPoint）：没有一根手填悬空起点——建网格前子枝起点强制覆写为母枝样条在
 * 附着处的精确中心、起始半径钳到 0.72 × 母枝半径，attach 与刚性附着弧长全部由附着位置算出（大振幅摇晃时母子枝交界零错位）。
 * 海棠主梢从主枝轴心 x ≈ 2.2 处以 31° 的腋角斜向右上（第一节几乎在主枝正上方竖起、只在顶面偏 +z 5°——默认三分之四相机
 * 在主枝 +z 侧前方，出枝朝 +z 的话嫩梢根部会被主枝轮廓挡成"平切口"），之字形折曲（陡升 → 平折 → 平伸）延伸到
 * x ≈ 5.15 / y ≈ 1.55 / z ≈ 0.85 的右上留白处；下半段灰褐老皮，从 0.42 起是当年生的栗红嫩梢，每个节点一圈叶痕环。
 * 两根粗短的果台（多年生短枝）生在中段偏内侧（第三节 x ≈ 3.15、第五节 x ≈ 3.85，两簇果在默认 front / threequarter 取景里都完整入框），梢头一枚顶芽；越冬的海棠果以
 * "同果台伞房束生"的方式挂在果台尖端：所有果梗从同一点长出、呈扇形散开后受重力单调下垂。
 * 嫩枝不铺独立雪壳、不插雾凇针（snow: false），只靠树皮着色器朝上一面挂薄霜；主梢、分叉和果台都带自己的滞后振子（bend）。
 */
export const FRONT_LIMBS: LimbSpec[] = [
  {
    points: [
      [2.2, -0.2, 0.2],
      // 第一节几乎在主枝正上方竖起（出枝方向只在顶面偏 +z 约 5°）：默认三分之四相机在主枝 −z 侧后方，出枝朝 +z 的话嫩梢根部会被主枝轮廓挡成"平切口"
      [2.81, 0.14, 0.19],
      [3.15, 1.0, 0.5],
      [3.55, 1.26, 0.42],
      [3.85, 1.36, 0.6],
      [4.5, 1.5, 0.78],
      [5.15, 1.55, 0.85],
    ],
    radii: [0.085, 0.075, 0.066, 0.058, 0.05, 0.038, 0.014],
    segments: 110,
    radial: 14,
    seed: 5,
    snow: false,
    buds: [0.99],
    parent: 0,
    atX: 2.2,
    bend: true,
    nodePoints: [1, 2, 3, 4, 5],
    young: 0.42,
  },
  // 分叉：从第三节往上分出的一根细杈，梢头一枚冬芽
  {
    points: [
      [3.55, 1.26, 0.42],
      [3.67, 1.58, 0.36],
      [3.85, 1.82, 0.3],
    ],
    radii: [0.032, 0.02, 0.01],
    segments: 24,
    radial: 10,
    seed: 8,
    snow: false,
    buds: [0.98],
    parent: TWIG,
    atPoint: 3,
    bend: true,
    young: 0.1,
  },
  // 果台 A（主簇 3~4 果 + 1 根空梗）：从第三节朝相机、略往上伸出
  {
    points: [
      [3.15, 1.0, 0.5],
      [3.18, 1.04, 0.64],
      [3.2, 1.07, 0.75],
    ],
    radii: [0.062, 0.054, 0.03],
    segments: 14,
    radial: 12,
    seed: 6,
    snow: false,
    buds: [1.0],
    parent: TWIG,
    atPoint: 2,
    bend: true,
    nodePoints: [1, 2],
    berries: { fruits: 4, empty: 1 },
  },
  // 果台 B（副簇 2 果）：从第五节伸出
  {
    points: [
      [3.85, 1.36, 0.6],
      [3.89, 1.38, 0.74],
      [3.91, 1.39, 0.84],
    ],
    radii: [0.052, 0.045, 0.026],
    segments: 12,
    radial: 10,
    seed: 7,
    snow: false,
    buds: [1.0],
    parent: TWIG,
    atPoint: 4,
    bend: true,
    nodePoints: [1, 2],
    berries: { fruits: 2, empty: 0 },
  },
];

// ---------------------------------------------------------------------------------------------
// 冬芽：层叠芽鳞包裹的饱满芽（四层、每层五片鳞），鳞片是弯出去再收向芽轴的小曲面，边缘透暖棕，顶上沾雪；
// 中心一根暗色的芽芯锥——鳞片之间的缝里露出来的是它而不是背景（微距下细枝上的小芽才不会散成一团铁丝）
// ---------------------------------------------------------------------------------------------
export function buildBudGeometry(tiers = 4, n = 5): BufferGeometry {
  const pos: number[] = [];
  const aBud: number[] = [];
  const idx: number[] = [];
  const TIERS = tiers;
  const N = n;
  const ROWS = 3;
  const COLS = 4;
  // 芽芯：底圈 + 顶尖，扇形三角面
  const coreN = 10;
  const coreBase = pos.length / 3;
  for (let i = 0; i <= coreN; i++) {
    const a = (i / coreN) * TAU;
    pos.push(0.13 * Math.cos(a), 0.1, 0.13 * Math.sin(a));
    aBud.push(0, 0.1, 0.3);
  }
  pos.push(0, 1.0, 0);
  aBud.push(0, 0, 0.6);
  const coreApex = coreBase + coreN + 1;
  for (let i = 0; i < coreN; i++) idx.push(coreBase + i + 1, coreBase + i, coreApex);
  for (let t = 0; t < TIERS; t++) {
    const R = 0.4 - 0.075 * t;
    const y0 = 0.12 + 0.21 * t;
    const L = 0.36 - 0.04 * t;
    for (let i = 0; i < N; i++) {
      const a0 = ((i + 0.5 * t) / N) * TAU + t * 0.3;
      const base = pos.length / 3;
      for (let r = 0; r <= ROWS; r++) {
        const u = r / ROWS;
        // 鳞片的半张角：根部 45°（盖过相邻鳞片 36° 的间距，鳞片互相叠覆），到尖还有 22°——以前收到 5°，缝里透出背景像铁丝
        const spread = (1 - u * 0.5) * 1.25;
        const rad = R * (1 + 0.35 * Math.sin(Math.PI * u)) * (1 - 0.45 * u * u);
        const y = y0 + u * L - 0.05 * u * u;
        for (let c = 0; c <= COLS; c++) {
          const v = -1 + (2 * c) / COLS;
          const ang = a0 + v * spread * (Math.PI / N);
          pos.push(rad * Math.cos(ang), y, rad * Math.sin(ang));
          aBud.push(t / (TIERS - 1), v * v, u);
        }
      }
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const a = base + r * (COLS + 1) + c;
          idx.push(a, a + 1, a + COLS + 1, a + 1, a + COLS + 2, a + COLS + 1);
        }
      }
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('aBud', new Float32BufferAttribute(aBud, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------------------------------------
// 海棠果（迷你苹果）几何：参数化的果体——果轴 +Y（梗洼在上、萼洼在下），单位半径。梗洼是顶部漏斗状的凹陷、萼洼是底部
// 的凹陷，肩部五道微棱（五心皮）；aDir = 单位球上的原方向（着色器按它找萼洼 / 梗洼）。5 片宿存萼片是萼洼里略微卷曲的
// 窄薄带；梗洼雪帽是盖在梗洼上的一层蓬松的雪（走树枝积雪材质）
/**
 * 果梗：从果台尖 S 到梗洼入口 E 的三次 Hermite——起点切线 = 扇开的出口方向 d0（果梗一出来就散开，不粘连），
 * 终点切线 = 果轴（顺滑进入梗洼），中间自然弯成一道下垂的弧，没有折角。TubeGeometry 按弧长参数取点（getPointAt）。
 */
export class PedicelCurve extends Curve<Vector3> {
  constructor(
    private readonly s: Vector3,
    private readonly e: Vector3,
    private readonly d0: Vector3,
    private readonly axis: Vector3,
  ) {
    super();
  }

  getPoint(t: number, out = new Vector3()): Vector3 {
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    const len = this.s.distanceTo(this.e);
    out.copy(this.s).multiplyScalar(h00).addScaledVector(this.e, h01).addScaledVector(this.d0, h10 * len * 1.1).addScaledVector(this.axis, h11 * len * 0.55);
    return out;
  }
}

// ---------------------------------------------------------------------------------------------
const FRUIT_RINGS = 18;
const FRUIT_SLICES = 22;

/** 果面上一点（单位果）：phi 从顶（梗洼）0 → 底（萼洼）π；theta 环向。 */
function fruitPoint(phi: number, theta: number, out: Vector3): Vector3 {
  const sy = Math.cos(phi);
  const sr = Math.sin(phi);
  const lobe = 1 + 0.012 * Math.cos(theta * 5) * smoothstep(-0.3, 0.5, sy);
  const top = 1 - smoothstep(0, 0.34, sr);
  const bot = 1 - smoothstep(0, 0.3, sr);
  const y = sy - 0.17 * top * top + 0.02 * Math.exp(-(((sr - 0.36) / 0.07) ** 2)) + 0.14 * bot * bot;
  return out.set(sr * lobe * Math.cos(theta), y, sr * lobe * Math.sin(theta));
}

export function buildFruitGeometry(rings = FRUIT_RINGS, slices = FRUIT_SLICES): BufferGeometry {
  const pos: number[] = [];
  const dir: number[] = [];
  const idx: number[] = [];
  const p = new Vector3();
  const cols = slices + 1;
  for (let i = 0; i <= rings; i++) {
    const phi = (i / rings) * Math.PI;
    for (let j = 0; j <= slices; j++) {
      const th = (j / slices) * TAU;
      fruitPoint(phi, th, p);
      pos.push(p.x, p.y, p.z);
      dir.push(Math.sin(phi) * Math.cos(th), Math.cos(phi), Math.sin(phi) * Math.sin(th));
      if (i < rings && j < slices) {
        const a = i * cols + j;
        idx.push(a, a + 1, a + cols, a + 1, a + cols + 1, a + cols);
      }
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('aDir', new Float32BufferAttribute(dir, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const n = g.attributes.normal;
  // 两极那一圈面退化成零面积：法线直接取果轴方向；接缝两侧的法线取平均，不留一条亮线
  for (let i = 0; i <= rings; i++) {
    const a = i * cols;
    const b = a + slices;
    const y = pos[a * 3 + 1];
    if (Math.hypot(pos[a * 3], pos[a * 3 + 2]) < 0.04) {
      n.setXYZ(a, 0, Math.sign(y), 0);
      n.setXYZ(b, 0, Math.sign(y), 0);
      continue;
    }
    const nx = n.getX(a) + n.getX(b);
    const ny = n.getY(a) + n.getY(b);
    const nz = n.getZ(a) + n.getZ(b);
    const len = Math.hypot(nx, ny, nz) || 1;
    n.setXYZ(a, nx / len, ny / len, nz / len);
    n.setXYZ(b, nx / len, ny / len, nz / len);
  }
  return g;
}

/** 5 片宿存萼片（果局部单位坐标）：各 3 个三角形的窄薄带，从萼洼边沿朝果轴方向、略微卷曲；open = 张开翻过边沿，否则合拢收进萼洼。 */
export function buildSepals(open: boolean, rng: () => number): BufferGeometry {
  const pos: number[] = [];
  const dir: number[] = [];
  const idx: number[] = [];
  for (let k = 0; k < 5; k++) {
    const th = ((k + 0.3 * rng()) / 5) * TAU;
    const c = Math.cos(th);
    const s = Math.sin(th);
    const tx = -s;
    const tz = c;
    const base = pos.length / 3;
    const r0 = 0.2;
    const y0 = -0.905;
    const r1 = open ? 0.4 : 0.03;
    const y1 = open ? -0.965 : -0.78;
    const rm = (r0 + r1) * 0.5;
    const ym = (y0 + y1) * 0.5 + (open ? -0.03 : 0.02);
    const w0 = 0.05;
    const w1 = 0.027;
    pos.push(r0 * c - tx * w0, y0, r0 * s - tz * w0, r0 * c + tx * w0, y0, r0 * s + tz * w0);
    pos.push(rm * c - tx * w1, ym, rm * s - tz * w1, rm * c + tx * w1, ym, rm * s + tz * w1);
    pos.push(r1 * c, y1, r1 * s);
    for (let v = 0; v < 5; v++) {
      const x = pos[(base + v) * 3];
      const y = pos[(base + v) * 3 + 1];
      const z = pos[(base + v) * 3 + 2];
      const len = Math.hypot(x, y, z) || 1;
      dir.push(x / len, y / len, z / len);
    }
    idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2, base + 2, base + 3, base + 4);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('aDir', new Float32BufferAttribute(dir, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** 梗洼里的 3D 雪帽（果局部单位坐标）：盖在梗洼上的一层蓬松的雪，中心厚、边缘按噪声起伏、往肩上搭一点；aSnow 走树枝积雪材质。 */
export function buildSnowCap(seed: number, scale: number, K = 6, M = 20): BufferGeometry {
  const pos: number[] = [];
  const sn: number[] = [];
  const idx: number[] = [];
  const ph1 = noise1(seed * 3.1, 1) * TAU;
  const ph2 = noise1(seed * 5.7, 2) * TAU;
  for (let k = 0; k <= K; k++) {
    const u = k / K;
    for (let j = 0; j <= M; j++) {
      const th = (j / M) * TAU;
      const psiMax = 0.5 * scale * (1 + 0.16 * Math.sin(3 * th + ph1) + 0.08 * Math.sin(7 * th + ph2) + 0.04 * Math.sin(11 * th + ph1 * 2.3));
      const psi = u * psiMax;
      const sp = Math.sin(psi);
      const cp = Math.cos(psi);
      const lobe = 1 + 0.012 * Math.cos(th * 5) * smoothstep(-0.3, 0.5, cp);
      const t = (0.05 * (1 - Math.pow(u, 1.5)) + 0.006) * scale + 0.01 * (noise3(Math.cos(th) * 2.5 + seed, Math.sin(th) * 2.5, u * 2 + 3) - 0.5) * scale;
      const rad = 1 + t;
      pos.push(sp * lobe * Math.cos(th) * rad, cp * rad, sp * lobe * Math.sin(th) * rad);
      // aSnow = (沿枝弧长, 环向角, 半径, 边缘系数)：弧长取 1e3 让踩凹够不着，边缘系数 ≤ 0.88 不渐隐
      // 外圈 0.86 → 1.0 渐隐：轮廓靠几何起伏碎掉，再加这层渐隐不成一顶硬帽子
      sn.push(1e3, 0, 0, 0.88 + 0.12 * smoothstep(0.7, 1.0, u));
      if (k < K && j < M) {
        const a = k * (M + 1) + j;
        idx.push(a, a + 1, a + M + 1, a + 1, a + M + 2, a + M + 1);
      }
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('aSnow', new Float32BufferAttribute(sn, 4));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * 海棠果材质（观鸟入口的红果侧枝与庭院里焊合的果台共用）：果梗 / 果实 / 宿存萼 / 残痕按 aPart 分支上色；
 * 树枝弯曲（aSway）和果柄单摆（aSwing）都在这里接，庭院里静态的果台两者全零。
 */
export function makeFruitMaterial(lighting: LightingUniforms, sway: Record<string, IUniform>, haze: Record<string, IUniform> = NO_HAZE, limb: Record<string, IUniform> = NO_LIMB): ReturnType<typeof makeLitMaterial> {
  return makeLitMaterial({
    lighting,
    side: DoubleSide,
    // 果实不接收阴影贴图：鸟尾 / 树枝的硬阴影盖在果肩上是一口黑锅盖（three 不看 mesh.receiveShadow，见 lit.ts sunShadow）
    receiveShadow: false,
    uniforms: {
      uCapSnow: { value: rgb('#f6f8fb') },
      ...sway,
      ...haze,
      ...limb,
      uStalkBase: { value: rgb('#75593c') },
      uStalkTip: { value: rgb('#a63a30') },
      uSkinLit: { value: rgb('#e64535') },
      uSkinRed: { value: rgb('#b3121b') },
      uSkinDeep: { value: rgb('#3b050a') },
      uCalyxCol: { value: rgb('#3a251c') },
      uSepalLight: { value: rgb('#553a2b') },
      uKnobCol: { value: rgb('#3a2418') },
    },
    vertexPars: /* glsl */ `
${SWAY_GLSL}
${FRUIT_SWAY_GLSL}
${LIMB_GLSL}
attribute float aPart;
attribute float aT;
attribute float aSeed;
attribute vec3 aLocal;
varying vec3 vObj;
varying vec3 vLocal;
varying float vPart;
varying float vT;
varying float vSeed;
`,
    vertexMain: /* glsl */ `
	vObj = position;
	vLocal = aLocal;
	vPart = aPart;
	vT = aT;
	vSeed = aSeed;
	pos = swayBend( pos );
	pos = limbBend( pos );
	pos = fruitSwing( pos );
`,
    fragmentPars: /* glsl */ `
uniform vec3 uStalkBase;
uniform vec3 uStalkTip;
uniform vec3 uSkinLit;
uniform vec3 uSkinRed;
uniform vec3 uSkinDeep;
uniform vec3 uCalyxCol;
uniform vec3 uSepalLight;
uniform vec3 uKnobCol;
uniform vec3 uCapSnow;
varying vec3 vObj;
varying vec3 vLocal;
varying float vPart;
varying float vT;
varying float vSeed;
${HAZE_GLSL}
`,
    surface: /* glsl */ `
	Surf s;
	s.specTint = vec3( 1.0 );
	s.alpha = 1.0;
	if ( vPart < 0.5 ) {
		// 果梗：基部灰褐 → 果端红褐，带细微的纵向纹理
		vec3 col = mix( uStalkBase, uStalkTip, smoothstep( 0.0, 1.0, vT ) );
		col *= 0.9 + 0.2 * ( snoise( vObj * 240.0 ) * 0.5 + 0.5 );
		s.albedo = col;
		s.ao = 0.85;
		s.wrap = 0.4;
		s.gloss = 0.3;
		s.specAmt = 0.06;
		return s;
	}
	if ( vPart > 3.5 ) {
		// 远冠的海棠果（aPart 4）：果皮 + 梗洼上直接染一顶雪（远景果不另建雪帽几何，省面；细分的环少，萼洼 / 果点都省了）
		float ndlF = dot( N, uSunDir );
		vec3 skinF = mix( uSkinDeep, uSkinRed, smoothstep( -0.7, 0.2, ndlF ) );
		skinF = mix( skinF, uSkinLit, smoothstep( 0.35, 0.95, ndlF ) * 0.5 );
		skinF = mix( skinF, uCapSnow, smoothstep( 0.55, 0.8, vLocal.y ) );
		s.albedo = skinF;
		s.ao = 1.0;
		s.wrap = 0.35;
		s.gloss = 0.8;
		s.specAmt = 0.5;
		return s;
	}
	if ( vPart > 2.5 ) {
		// 空梗末端的残痕
		s.albedo = uKnobCol * ( 0.9 + 0.2 * ( snoise( vObj * 400.0 ) * 0.5 + 0.5 ) );
		s.ao = 0.8;
		s.wrap = 0.3;
		s.gloss = 0.2;
		s.specAmt = 0.04;
		return s;
	}
	if ( vPart > 1.5 ) {
		// 宿存萼片：深褐的干萼片，受光的那一半略浅
		s.albedo = mix( uCalyxCol, uSepalLight, 0.35 + 0.35 * ( snoise( vObj * 400.0 ) * 0.5 + 0.5 ) + 0.3 * max( N.y, 0.0 ) );
		s.ao = 0.75;
		s.wrap = 0.3;
		s.gloss = 0.25;
		s.specAmt = 0.05;
		return s;
	}
	// 海棠果皮：深邃红润——背光深酒红 → 正红 → 朝光面珊瑚红；漫反射收得紧（wrap 0.3），掠射角只泛一层很淡的果粉霜，
	// 蜡质的亮高光；细密的暖浅黄褐果点
	float ndl = dot( N, uSunDir );
	vec3 skin = mix( uSkinDeep, uSkinRed, smoothstep( -0.7, 0.2, ndl ) );
	skin = mix( skin, uSkinLit, smoothstep( 0.35, 0.95, ndl ) * 0.5 );
	skin *= 0.95 + 0.1 * ( snoise( vObj * 60.0 ) * 0.5 + 0.5 );
	vec3 cp = vObj * 58.0 + vSeed * 7.0;
	vec3 cell = floor( cp );
	float h = hash13( cell );
	vec3 fr = fract( cp ) - 0.5 - ( vec3( fract( h * 7.3 ), fract( h * 13.1 ), fract( h * 5.7 ) ) - 0.5 ) * 0.5;
	float dotMask = ( 1.0 - smoothstep( 0.1, 0.24, length( fr ) ) ) * step( 0.8, h );
	skin = mix( skin, vec3( 0.76, 0.48, 0.30 ), dotMask * 0.10 );
	float graze = pow( 1.0 - abs( dot( N, V ) ), 2.0 );
	skin = mix( skin, vec3( 0.9, 0.87, 0.88 ), 0.02 + 0.06 * graze );
	// 果底萼洼：洼里发暗（从下往上看是一个深褐的小洼，不是黑洞）
	float basin = smoothstep( 0.93, 0.965, -vLocal.y );
	skin = mix( skin, uCalyxCol, basin * 0.7 );
	// 背阴的小果：更暗、带微弱的纵皱（越靠萼端越明显）
	float ang = atan( vLocal.z, vLocal.x );
	float wr = ( 0.5 + 0.5 * sin( ang * 11.0 + snoise( vObj * 40.0 ) * 1.5 ) ) * smoothstep( -0.95, 0.4, -vLocal.y );
	skin *= mix( 1.0, 0.74 * ( 1.0 - 0.14 * wr ), step( 0.95, vSeed ) );
	s.albedo = skin;
	s.ao = 1.0 - 0.3 * basin;
	s.wrap = 0.3;
	s.gloss = 0.86;
	s.specAmt = 0.62;
	return s;
`,
    extraLight: /* glsl */ `
	// 逆光只透一点点珊瑚红（薄皮的迷你苹果），掠射角最强；萼片透一点暖褐
	float back = pow( max( dot( -V, uSunDir ), 0.0 ), 2.8 );
	float rim = 0.35 + 0.65 * ( 1.0 - abs( dot( N, V ) ) );
	vec3 glow = vec3( 0.0 );
	if ( vPart > 0.5 && vPart < 1.5 ) glow = vec3( 1.0, 0.42, 0.2 ) * 0.22 * rim;
	else if ( vPart > 1.5 && vPart < 2.5 ) glow = vec3( 1.0, 0.5, 0.25 ) * 0.08;
	else if ( vPart > 3.5 ) glow = vec3( 1.0, 0.42, 0.2 ) * 0.15 * rim;
	return hazeComposite( N, V, s, uSunColor * back * glow * sunShadow() );
`,
  });
}

// ---------------------------------------------------------------------------------------------
// 通用的海棠果簇（庭院的院心老树 / 温室春树的果台用）：和观鸟入口 buildBerries 同一套果梗 Hermite 弧、五棱迷你苹果、
// 宿存萼片、梗洼雪帽，但果台的走向、果的大小（scale = 相对观鸟入口那枚 3 mm 迷你果的倍数）、果数都由调用方给；
// 不摇晃（aSway / aSwing 全零），果梗扇面沿 fan 方向张开。detail 控制果体 / 雪帽的细分（远看的果子不用 800 面）。
// ---------------------------------------------------------------------------------------------
export interface FruitClusterOptions {
  fruits: number;
  empty: number;
  /** 相对观鸟入口迷你果（R ≈ 0.13 cm）的倍数：院心老树的海棠果 ~1 cm → 3.8。 */
  scale: number;
  /** 果梗扇面张开的方向（世界 / 树坐标系的水平向量）。 */
  fan: Vector3;
  /** 果体 [环数, 瓣数]。 */
  detail?: [number, number];
  /** 梗洼雪帽 [径向, 环向]。 */
  capDetail?: [number, number];
  /** 远景果簇：果梗 2 段 3 边、不建萼片和雪帽（雪顶在果材质里按 aPart 4 染）、松弛只跑 8 轮。 */
  far?: boolean;
}

export function buildFruitCluster(S: Vector3, tipDir: Vector3, o: FruitClusterOptions, rng: () => number): { geos: BufferGeometry[]; caps: BufferGeometry[] } {
  const DEG = Math.PI / 180;
  const [rings, slices] = o.detail ?? [FRUIT_RINGS, FRUIT_SLICES];
  const unit = buildFruitGeometry(rings, slices);
  const geos: BufferGeometry[] = [];
  const caps: BufferGeometry[] = [];
  const up = new Vector3(0, 1, 0);
  const down = new Vector3(0, -1, 0);
  const tmpA = new Vector3();
  const tmpB = new Vector3();
  const tmpC = new Vector3();
  const m4 = new Matrix4();
  const quat = new Quaternion();
  const scl = new Vector3();
  interface Fruit {
    R: number;
    aspect: number;
    center: Vector3;
    axis: Vector3;
    seed: number;
  }
  /** 贴上果材质要的属性：part 0 果梗 / 1 果实 / 2 萼片 / 3 残痕；静态果台 aSway / aSwing 全零。 */
  const collect = (g: BufferGeometry, part: number, seed: number, arc: (i: number) => number): void => {
    g.deleteAttribute('uv');
    const count = g.attributes.position.count;
    const sw = new Float32Array(count * 3);
    const pt = new Float32Array(count).fill(part);
    const tt = new Float32Array(count);
    const sd = new Float32Array(count).fill(seed);
    const dirs = g.attributes.aDir as Float32BufferAttribute | undefined;
    const loc = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      tt[i] = arc(i);
      if (dirs) loc.set([dirs.getX(i), dirs.getY(i), dirs.getZ(i)], i * 3);
    }
    g.setAttribute('aSway', new Float32BufferAttribute(sw, 3));
    g.setAttribute('aSwing', new Float32BufferAttribute(new Float32Array(count), 1));
    g.setAttribute('aPart', new Float32BufferAttribute(pt, 1));
    g.setAttribute('aT', new Float32BufferAttribute(tt, 1));
    g.setAttribute('aSeed', new Float32BufferAttribute(sd, 1));
    g.setAttribute('aLocal', new Float32BufferAttribute(loc, 3));
    g.deleteAttribute('aDir');
    geos.push(g);
  };
  // 束生方向：果台方向的一半 + 重力；扇面沿 fan（垂直于 mean 的分量）张开
  const mean = tipDir.clone().multiplyScalar(0.5).addScaledVector(down, 0.8).normalize();
  const e1 = o.fan.clone().addScaledVector(mean, -o.fan.dot(mean));
  if (e1.lengthSq() < 1e-6) e1.set(1, 0, 0).addScaledVector(mean, -mean.x);
  e1.normalize();
  const e2 = new Vector3().crossVectors(mean, e1).normalize();
  const total = o.fruits + o.empty;
  const fan = (14 + 12 * rng()) * DEG;
  const fruits: Fruit[] = [];
  const pedicels: { d0: Vector3; L: number; radius: number; empty: boolean; fruit: Fruit | null }[] = [];
  const sc = o.scale;
  for (let k = 0; k < total; k++) {
    const psi = (((k + 0.5) / total) * 2 - 1) * fan + (rng() - 0.5) * 8 * DEG;
    const d0 = mean.clone().multiplyScalar(Math.cos(psi)).addScaledVector(e1, Math.sin(psi)).addScaledVector(e2, (rng() - 0.5) * 0.3);
    const empty = k >= o.fruits;
    if (empty) d0.addScaledVector(e1, 0.3 * (k % 2 === 0 ? 1 : -1)).addScaledVector(up, 0.12);
    // 单调下垂：果梗出口方向不许朝上
    d0.y = Math.min(d0.y, -0.15);
    d0.normalize();
    const R = (0.125 + 0.035 * rng()) * sc;
    const L = (empty ? 0.4 + 0.1 * rng() : clamp(2 * (R / sc) * (2.0 + 0.5 * rng()), 0.48, 0.64)) * sc;
    let fruit: Fruit | null = null;
    if (!empty) {
      const aspect = 0.9 + 0.05 * rng();
      const center = S.clone().addScaledVector(d0, 0.4 * L).addScaledVector(down, 0.55 * L);
      fruit = { R, aspect, center, axis: down.clone(), seed: rng() * 0.9 };
      fruits.push(fruit);
    }
    pedicels.push({ d0, L, radius: (0.006 + 0.0025 * rng()) * sc * 1.3, empty, fruit });
  }
  // 松弛：果实两两不穿插（间距 ≥ Ri + Rj），只在水平面里推开——高低错落由果梗的长度定
  for (let it = 0; it < (o.far ? 8 : 30); it++) {
    for (let i = 0; i < fruits.length; i++) {
      for (let j = i + 1; j < fruits.length; j++) {
        const a = fruits[i];
        const b = fruits[j];
        tmpA.set(a.center.x - b.center.x, 0, a.center.z - b.center.z);
        let d = tmpA.length();
        const minD = a.R + b.R + 0.012 * sc;
        if (d >= minD) continue;
        if (d < 1e-5) {
          tmpA.set(rng() - 0.5, 0, rng() - 0.5);
          d = tmpA.length();
        }
        tmpA.multiplyScalar(1 / d);
        const push = (minD - d) * 0.5;
        a.center.addScaledVector(tmpA, push);
        b.center.addScaledVector(tmpA, -push);
      }
    }
  }
  const segs = o.far ? 2 : rings > 12 ? 12 : 8;
  const radial = o.far ? 3 : rings > 12 ? 5 : 4;
  for (const pd of pedicels) {
    let end: Vector3;
    let curve: PedicelCurve;
    if (pd.fruit) {
      const f = pd.fruit;
      tmpA.set(f.center.x - S.x, 0, f.center.z - S.z);
      if (tmpA.lengthSq() < 1e-6) tmpA.set(pd.d0.x, 0, pd.d0.z);
      tmpA.normalize();
      f.axis.copy(down).addScaledVector(tmpA, 0.3).normalize();
      end = f.center.clone().addScaledVector(f.axis, -0.83 * f.R * f.aspect);
      curve = new PedicelCurve(S, end, pd.d0, f.axis.clone());
    } else {
      end = S.clone().addScaledVector(pd.d0, 0.5 * pd.L).addScaledVector(down, 0.4 * pd.L);
      curve = new PedicelCurve(S, end, pd.d0, down.clone());
    }
    const tube = new TubeGeometry(curve, segs, pd.radius, radial, false);
    // 果梗往果端略粗（进入梗洼的那一段）
    const tp = tube.attributes.position;
    for (let i = 0; i < tp.count; i++) {
      const ring = Math.floor(i / (radial + 1));
      curve.getPointAt(ring / segs, tmpB);
      tmpC.set(tp.getX(i), tp.getY(i), tp.getZ(i)).sub(tmpB).multiplyScalar(1 + 0.3 * (ring / segs)).add(tmpB);
      tp.setXYZ(i, tmpC.x, tmpC.y, tmpC.z);
    }
    collect(tube, 0, 0, (i) => Math.floor(i / (radial + 1)) / segs);
    if (!pd.fruit) {
      const knob = new SphereGeometry(0.013 * sc, 8, 6);
      knob.translate(end.x, end.y, end.z);
      collect(knob, 3, 0, () => 0);
      continue;
    }
    quat.setFromUnitVectors(up, tmpA.copy(pd.fruit.axis).negate());
    scl.set(pd.fruit.R, pd.fruit.R * pd.fruit.aspect, pd.fruit.R);
    m4.compose(pd.fruit.center, quat, scl);
    collect(unit.clone().applyMatrix4(m4), o.far ? 4 : 1, pd.fruit.seed, () => 0);
    // 宿存萼：5 片深褐的干萼片，有的张开翻过萼洼边沿、有的合拢收进萼洼
    if (!o.far) collect(buildSepals(rng() < 0.5, rng).applyMatrix4(m4), 2, pd.fruit.seed, () => 0);
  }
  // 梗洼里的雪：只给每簇最上面的 1~2 果，只在凹陷的梗洼窝里堆一小撮
  const [ck, cm] = o.capDetail ?? [6, 20];
  (o.far ? [] : fruits)
    .sort((a, b) => b.center.y - a.center.y)
    .slice(0, 2)
    .forEach((f, i) => {
      const cap = buildSnowCap(f.seed * 100 + i, i === 0 ? 1 : 0.86, ck, cm);
      quat.setFromUnitVectors(up, tmpA.copy(f.axis).negate());
      scl.set(f.R, f.R * f.aspect, f.R);
      m4.compose(f.center, quat, scl);
      cap.applyMatrix4(m4);
      cap.deleteAttribute('uv');
      const count = cap.attributes.position.count;
      cap.setAttribute('aSway', new Float32BufferAttribute(new Float32Array(count * 3), 3));
      caps.push(cap);
    });
  unit.dispose();
  return { geos, caps };
}

/** addWeldedLimbs 焊合的整棵树的一条焊合记录：tree 是那次调用返回的枝条表，child / parent 是表内序号，sAttach 是母枝上的归一化弧长。 */
export interface WeldedJoint {
  tree: Limb[];
  child: number;
  parent: number;
  sAttach: number;
}

export class Branches extends Group {
  readonly barkUniforms: Record<string, IUniform>;
  /** 主枝（鸟停的那一根）的树皮网格：仿真调试台拿它的顶点去对碰撞体。 */
  readonly mainBark: BufferGeometry;
  /** 悬臂梁弯曲：模态坐标在 CPU 推进，位移在所有树枝材质的顶点着色器里叠加。 */
  readonly sway = new BranchSway();
  /**
   * 焊合树的活跃颤动枝槽位（uActiveLimbs，见 LIMB_GLSL）：老海棠 / 春树的树皮、雪、芽、果和 Foliage 的叶花共享同一个对象，
   * 舞台每帧从仿真世界挑正在晃的几根写进来（setActiveLimbs）。主角枝一套没有 aLimb 属性，不受影响。
   */
  readonly limbUniforms = makeLimbUniforms();
  /** 主枝（鸟停的那一根）：抓握查询用它的平行标架。 */
  private readonly main: Limb;
  /** 主枝 + LIMBS 的细枝（+ 观鸟入口的红果侧枝）：建好的几何留着给装饰层采样表面。 */
  readonly limbs: Limb[] = [];
  private readonly limbSpecs: LimbSpec[] = [];
  /** 母子枝焊合记录（tools/rigcheck.mjs 用）：子枝序号、母枝序号（全表 = LIMBS + FRONT_LIMBS）、母枝上的归一化弧长。 */
  readonly joints: { child: number; parent: number; sAttach: number }[] = [];
  /** addWeldedLimbs 焊合的整棵树的焊合记录（自检工具用）。 */
  readonly weldedJoints: WeldedJoint[] = [];
  /**
   * decor 模式建的那棵老海棠：growCrabappleTree 的枝条表和 addWeldedLimbs 返回的画面枝条（同序）。
   * 舞台建碰撞体时按序号把每条曲线对回画面上的那根枝，落地才能查到精确的栖面（树皮鼓包 + 雪帽）；观鸟入口不读。
   */
  readonly treeSpecs: LimbSpec[] = [];
  readonly treeLimbs: Limb[] = [];
  /** 老海棠的生成选项（庭院传禁入区 / 不建雪坡；观鸟入口不传 = 原样）。 */
  private readonly treeOpts: CrabappleTreeOptions | undefined;
  /**
   * 前景 / 背景两套容器（opts.split）：heroGroup = 主角枝一套（主枝 + 细枝 + 前景果枝 + 苔藓地衣绒毛），treeGroup = 老海棠一套
   * （主干 / 主枝 / 侧枝 / 冠梢果簇 + 主干苔藓地衣）。庭院按图层把它们拆到散景的锐利层 / 虚化层；不拆时两者都是 this，
   * 观鸟入口 / 城市入口逐位不变。
   */
  readonly heroGroup: Group;
  readonly treeGroup: Group;
  private readonly split: boolean;
  /** 当前的添加目标：构造时在两套容器之间切换，构造完回到 this（外部 addWeldedLimbs 照旧加在 this 下）。 */
  private sink: Group;
  /** 从雪下钻出的子枝基部堆的一小圈雪（把子枝和雪面的交界藏进雪里）：建完枝条合并成一个雪网格 */
  private readonly baseSnow: BufferGeometry[] = [];
  /** 子枝钻出雪面的点（枝条坐标 xyz + 遮蔽半径 w）：积雪材质按它给枝基部一圈柔和的接触遮蔽（天光被枝挡住），没用的槽位 w = 0。
   *  固定 6 个槽位（three 的 vec4[] uniform 会按着色器里的长度逐个 .toArray，数组短了会报错）。 */
  private readonly baseOcc: Vector4[] = Array.from({ length: 6 }, () => new Vector4());
  private baseOccCount = 0;
  /** 果簇连接记录（rigcheck 用）：果台尖与果柄根的静止位置、各自的 aSway、果梗曲线——任意摇晃状态下两者必须零脱节。 */
  readonly berryJoints: { spurTip: Vector3; root: Vector3; spurSway: [number, number, number]; rootSway: [number, number, number]; curve: Curve<Vector3> }[] = [];
  private press: Press[];
  /** 鸟脚在主枝上的归一化弧长：静态下垂的平衡点和冲击都按它算。 */
  private birdS = 0.5;
  /** 红果侧枝的树皮网格：鼠标快速划过时拿它做射线检测（没装装饰 = null）。 */
  private twigMesh: Mesh | null = null;
  /** 前景海棠果簇的网格：鼠标扫过红果串本身也能拨动（和嫩梢一起做射线检测）。 */
  private berryMesh: Mesh | null = null;
  /** 老树主干的叶状地衣贴片（建树时生成，并进观鸟主枝那套地衣壳层网格，不多一次绘制）。 */
  private readonly treeLichen: BufferGeometry[] = [];
  private readonly snowUniforms: Record<string, IUniform>;
  /** 大气透视（观鸟入口那棵 6 米海棠老树用）：所有树枝材质按引用共享，App 改一次全场景同步；默认关闭。 */
  readonly haze = makeHazeUniforms();
  /** 果材质专用的雾：同一组颜色 / 距离 / 远景门，只把上限压到 0.24——全景和仰视里海棠果要是点点绛红，不是灰点。 */
  readonly hazeFruit: Record<string, IUniform> = { ...this.haze, uHazeMax: { value: 0.24 } };
  // addLimbs 用的材质与芽点几何（和主枝同一套）
  private readonly barkMat: ReturnType<typeof makeLitMaterial>;
  private readonly snowMat: ReturnType<typeof makeLitMaterial>;
  private readonly budMat: ReturnType<typeof makeLitMaterial>;
  private readonly budGeo: BufferGeometry;

  /**
   * press：脚爪落点，积雪在那里被踩出小凹；和 Bird 的 FOOT_SPOTS 是同一组数。
   * decor：观鸟入口的前景装饰（红果侧枝、苔藓 / 地衣绒垫、细绒毛与雾凇针）+ 左后方那棵老海棠；漫游入口的整棵树不装（它自己 addLimbs）。
   * opts.bare：连主枝和 LIMBS 都不画（庭院温室里的春树：只靠 addWeldedLimbs 长出自己的骨架，主枝仍建着给内部查询用）。
   * opts.tree：老海棠的生成选项（庭院：树冠躲开建筑 / 不建树兜雪坡），不传 = 观鸟入口原样。
   * opts.noTree：decor 模式下不建左后方那棵 6 米的老海棠，只留主角枝 + 前景红果侧枝 + 苔藓地衣绒毛（观鸟入口的纯粹单枝展台，默认 false 不影响庭院）。
   * opts.split：把主角枝一套和老海棠一套分装进 heroGroup / treeGroup 两个子 Group（庭院散景按图层渲染用；主干地衣不再并进主角枝的地衣网格，多 1 次绘制）。
   */
  constructor(lighting: LightingUniforms, press: readonly SnowPress[] = [], decor = false, opts: { bare?: boolean; tree?: CrabappleTreeOptions; noTree?: boolean; split?: boolean } = {}) {
    super();
    this.treeOpts = opts.tree;
    this.split = opts.split === true;
    this.heroGroup = this.split ? new Group() : this;
    this.treeGroup = this.split ? new Group() : this;
    this.sink = this.heroGroup;
    if (this.split) {
      this.heroGroup.name = 'hero';
      this.treeGroup.name = 'tree';
      this.add(this.heroGroup, this.treeGroup);
    }
    this.barkUniforms = {
      uBarkDark: { value: rgb('#1e1a17') },
      uBarkMid: { value: rgb('#38322c') },
      uBarkLight: { value: rgb('#544b43') },
      uLichen: { value: rgb('#7d8878') },
      uLichenLight: { value: rgb('#9da693') },
      uLenticel: { value: rgb('#8a7f72') },
      uYoungBark: { value: rgb('#4a241e') },
      // 老干 / 大主枝的海棠老皮：深胡桃暖灰褐底 + 片状剥落的浅暖鹿皮斑；远冠细梢的紫栗红褐
      uOldBarkDark: { value: rgb('#3a3029') },
      uOldBarkMid: { value: rgb('#54463c') },
      uOldBarkFlake: { value: rgb('#736252') },
      uYoungBark2: { value: rgb('#5e2c24') },
      uLenticelYoung: { value: rgb('#b9a68e') },
      uSnowCol: { value: rgb('#f6f8fb') },
      uKnots: { value: [new Vector3(), new Vector3(), new Vector3(), new Vector3()] },
    };
    const swayU = this.sway.uniforms;
    this.main = buildLimb(LIMBS[0], { attach: null, bend: false });
    this.mainBark = this.main.bark;
    // 落点的 x 换算成主枝的累积弧长（雪帽网格 / CPU 查询 / 顶点着色器全用弧长）
    this.press = press.map((p) => ({ along: this.frameAt(p.worldX).along, alpha: p.alpha }));
    this.birdS = this.frameAt(0).along / this.main.length;
    this.sway.setBird(true, this.birdS);
    const knots = this.barkUniforms.uKnots.value as Vector3[];
    LIMBS[0].knots?.forEach((kn, i) => knots[i].set(kn[0], kn[1], kn[2]));


    const barkMat = makeLitMaterial({
      lighting,
      side: DoubleSide,
      uniforms: { ...this.barkUniforms, ...swayU, ...this.haze, ...this.limbUniforms },
      vertexPars: /* glsl */ `
${SWAY_GLSL}
${LIMB_GLSL}
attribute vec4 aBark;
attribute float aKnot;
attribute float aWet;
attribute vec2 aSkin;
varying vec4 vBark;
varying float vKnot;
varying float vWet;
varying vec2 vSkin;
`,
      vertexMain: /* glsl */ `
	vBark = aBark;
	vKnot = aKnot;
	vWet = aWet;
	vSkin = aSkin;
	pos = swayBend( pos );
	pos = limbBend( pos );
`,
      fragmentPars: /* glsl */ `
uniform vec3 uBarkDark;
uniform vec3 uBarkMid;
uniform vec3 uBarkLight;
uniform vec3 uLichen;
uniform vec3 uLichenLight;
uniform vec3 uLenticel;
uniform vec3 uYoungBark;
uniform vec3 uYoungBark2;
uniform vec3 uOldBarkDark;
uniform vec3 uOldBarkMid;
uniform vec3 uOldBarkFlake;
uniform vec3 uLenticelYoung;
uniform vec3 uSnowCol;
uniform vec3 uKnots[ 4 ];
varying vec4 vBark;
varying float vKnot;
varying float vWet;
varying vec2 vSkin;
${HAZE_GLSL}
`,
      surface: /* glsl */ `
	// 环向用 (cos, sin) 采样，保证接缝两侧连续；aBark = (沿枝弧长, 环向角, 基础半径, 种子)
	float along = vBark.x;
	float th = vBark.y;
	float r = vBark.z;
	float seed = vBark.w;
	vec3 sp = vec3( cos( th ), sin( th ), 0.0 );
	// 裂沟 / 地衣从半径 0.14~0.36 cm 起就有：鸟脚下的栖枝也看得到苍劲的纵向裂纹和斑驳地衣
	float old = smoothstep( 0.14, 0.36, r );
	// 纵裂沟：几何上已经凹进去，沟底再压暗；沟与沟之间的皮面是顺着枝长的细条纹 + 细碎颗粒
	// 环向的采样频率按半径换算（rs = r / 0.35 cm）：细枝上 1 rad ≈ 0.35 cm，16 cm 粗的老干上 1 rad = 16 cm，不换算的话
	// 裂纹 / 地衣在老干上全成了 4~5 cm 宽的横向色块；grain 保持角频率（老干上正好是 4 mm 的细颗粒）
	float rs = clamp( r / 0.35, 1.0, 48.0 );
	float big = smoothstep( 2.5, 7.0, r );
	// 像素足迹（厘米）：沿枝 fwidth(along)、环向 fwidth(th)·r。老干（big）上比 ~3 个像素还细的噪声项按足迹淡出——
	// 70 cm 外老干上 3~4 px 的 fine / grain 颗粒就是一片电视雪花（trunklow）；细枝（big = 0）完全不变
	float pxA = max( fwidth( along ), 1e-5 );
	float pxT = max( fwidth( th ) * r, 1e-5 );
	float fade = 1.0 - big * ( 1.0 - smoothstep( 3.0, 8.0, min( 0.5 / pxA, r / 40.0 / pxT ) ) );
	float fadeF = 1.0 - big * ( 1.0 - smoothstep( 3.0, 8.0, min( 0.2 / pxA, r / ( 9.0 * rs ) / pxT ) ) );
	float fadeS = 1.0 - big * ( 1.0 - smoothstep( 3.0, 8.0, min( 2.0 / pxA, r / ( 2.2 * rs ) / pxT ) ) );
	// 老干上的裂纹是纵向长沟（环向 2.5 cm 一道、沿枝 25 cm 一个起伏，和 ringRadius 的几何沟同一套）；细枝保持 0.35 cm 的细裂纹
	float kf = mix( clamp( r / 0.35, 0.6, 48.0 ), 0.4 * r, big );
	float fis = snoise( vec3( along * mix( 0.9, 0.04, big ) + seed * 3.3 + 11.0, sp.x * kf, sp.y * kf ) );
	float crack = smoothstep( -0.35, -0.7, fis ) * old;
	float grain = snoise( vec3( sp.x * 40.0, sp.y * 40.0, along * 2.0 + seed ) );
	float streak = fbm3( vec3( sp.x * 2.2 * rs, sp.y * 2.2 * rs, along * 0.5 ) );
	float fine = snoise( vec3( sp.x * 9.0 * rs, sp.y * 9.0 * rs, along * 5.0 ) ) * 0.5 + 0.5;
	float m = clamp( 0.5 + streak * 0.45 * fadeS + fine * 0.2 * fadeF + grain * 0.2 * fade, 0.0, 1.0 );
	// 北海道冬枝的风化冷色：深胡桃黑 → 灰褐主色 → 风化浅灰
	vec3 bark = m < 0.5 ? mix( uBarkDark, uBarkMid, m * 2.0 ) : mix( uBarkMid, uBarkLight, ( m - 0.5 ) * 2.0 );
	bark *= 1.0 - 0.6 * crack;
	// 老干 / 大主枝换成海棠老皮：深胡桃暖灰褐底 + 片状剥落的浅暖鹿皮斑（对照实拍），不是水泥铅灰
	float flake = fbm3( vec3( sp.x * 0.0833 * r, sp.y * 0.0833 * r, along * 0.09 + 21.0 ) );
	vec3 warm = mix( uOldBarkDark, uOldBarkMid, smoothstep( 0.2, 0.8, m ) );
	warm = mix( warm, uOldBarkFlake, smoothstep( 0.6, 0.72, flake ) * 0.55 );
	bark = mix( bark, warm, big );
	// 老干的大尺度：环向 6 cm 间距的纵向沟纹 + 30 cm 级的色斑。细枝那套 1 cm 纹理按半径换算后在 5 m 外全是亚像素，
	// 老树"苍劲"的远读感全靠这一层（沟底压暗一半、脊上略提亮）；细枝（big = 0）完全不变。fbm3 取值 0~1
	float fur = fbm3( vec3( sp.x * 0.1667 * r, sp.y * 0.1667 * r, along * 0.12 + 7.0 ) );
	float blotch = fbm3( vec3( sp.x * 0.0333 * r, sp.y * 0.0333 * r, along * 0.05 + 3.0 ) );
	bark *= mix( 1.0, ( 0.78 + 0.44 * blotch ) * ( 1.0 - 0.6 * ( 1.0 - smoothstep( 0.42, 0.62, fur ) ) + 0.3 * smoothstep( 0.6, 0.8, fur ) ), big );
	// 木疤：中心发暗的凹坑 + 一圈隆起的浅色边（只有带木疤的那根枝有，aKnot 门控）
	for ( int i = 0; i < 4; i ++ ) {
		vec3 kn = uKnots[ i ];
		if ( kn.z <= 0.0 ) continue;
		vec2 d = vec2( ( along - kn.x ) / 0.14, ( th - kn.y ) * r / 0.11 );
		float d2 = dot( d, d );
		bark = mix( bark, bark * 0.3, exp( - d2 * 5.0 ) * vKnot * 0.85 );
		bark = mix( bark, uBarkLight * 1.15, exp( -d2 ) * vKnot * 0.45 );
	}
	// 皮孔：稀疏（约 14% 的格子）、极细小（环向 0.45 mm × 沿枝 0.16 mm）、低对比的微细皮孔
	float thc = th * r;
	vec2 cell = vec2( floor( along / 0.3 ), floor( thc / 0.11 ) );
	float h = hash13( vec3( cell, seed ) );
	vec2 fr = vec2( fract( along / 0.3 ), fract( thc / 0.11 ) );
	vec2 ctr = vec2( 0.3 + 0.4 * fract( h * 7.3 ), 0.3 + 0.4 * fract( h * 13.1 ) );
	vec2 dd = ( fr - ctr ) * vec2( 0.3 / 0.008, 0.11 / 0.0225 );
	float lent = ( 1.0 - smoothstep( 0.5, 1.0, length( dd ) ) ) * step( 0.86, h );
	lent *= smoothstep( 0.8, 0.45, r ) * ( 1.0 - crack );
	bark = mix( bark, mix( uLenticel, uLenticelYoung, vSkin.x ), lent * mix( 0.22, 0.5, vSkin.x ) );
	// 当年生嫩梢（aSkin.x）：栗红褐的平滑嫩皮盖掉老皮的灰褐条纹，只留皮孔
	// 远冠细梢（young ≥ 0.5；观鸟主枝的嫩梢 ≤ 0.42 不受影响）过渡成温润的紫栗红褐
	vec3 yb = mix( uYoungBark, uYoungBark2, smoothstep( 0.5, 0.9, vSkin.x ) );
	bark = mix( bark, yb * ( 0.86 + 0.14 * fine + 0.12 * ( streak - 0.5 ) ), vSkin.x * 0.85 );
	// 之字形枝节的叶痕环（aSkin.y）：节上发暗，紧挨着是一圈细密的环状皱褶（远了按像素足迹淡出，不成噪点）
	float wr = 0.5 + 0.5 * sin( along * 380.0 );
	wr *= 1.0 - smoothstep( 0.4, 1.2, fwidth( along ) * 380.0 );
	bark *= 1.0 - vSkin.y * ( 0.2 + 0.12 * wr );
	// 壳状地衣：两个尺度叠出的灰绿斑驳（大块连片 + 细碎斑点），两种灰绿
	// 老干上的地衣按 5 cm 的斑块采样（细枝那套 1 cm 的在老干上是亚像素的椒盐）；第二层细碎斑点远了按足迹淡出
	float lk = mix( 9.0 * rs, 0.2 * r, big );
	float lk2 = mix( 28.0 * rs, 0.7 * r, big );
	float fadeL = 1.0 - big * ( 1.0 - smoothstep( 3.0, 8.0, min( 0.3 / pxA, r / lk2 / pxT ) ) );
	float li = fbm3( vec3( sp.x * lk, sp.y * lk, along * mix( 2.5, 0.15, big ) + 37.0 ) ) * 0.6 + fbm3( vec3( sp.x * lk2, sp.y * lk2, along * 8.0 + 11.0 ) ) * 0.4 * fadeL;
	float lichen = smoothstep( 0.42, 0.72, li ) * old;
	bark = mix( bark, mix( uLichen, uLichenLight, smoothstep( 0.6, 0.9, li ) ), lichen * 0.45 );
	// 雪线正下方一条融雪浸湿的深色带（aWet = 到雪帽边缘的角距离；> 1.5 表示这根枝没有雪帽）
	float wet = vWet < 1.5 ? exp( - pow( max( vWet, 0.0 ) / 0.35, 2.0 ) ) * 0.26 : 0.0;
	bark *= 1.0 - wet;
	// 朝上一面的零星残雪（雪帽之外）；没有雪帽的细枝靠这一层挂薄霜
	float up = N.y + ( fbm3( vWorldPos * 3.0 ) - 0.5 ) * 0.45;
	float sn = smoothstep( 0.5, 0.8, up );
	Surf s;
	s.albedo = mix( bark, uSnowCol, sn );
	s.ao = 1.0 - 0.25 * crack - wet * 0.5;
	s.wrap = 0.25;
	s.specTint = vec3( 1.0 );
	s.gloss = mix( mix( 0.2, 0.55, wet ), 0.45, sn ) + 0.15 * vSkin.x * ( 1.0 - sn );
	s.specAmt = mix( mix( 0.03, 0.12, wet ), 0.12, sn ) + 0.03 * vSkin.x * ( 1.0 - sn );
	s.alpha = 1.0;
	return s;
`,
      extraLight: /* glsl */ `
	return hazeComposite( N, V, s, vec3( 0.0 ) );
`,
    });

    const snowMat = this.makeSnowMat(lighting, false);
    this.snowUniforms = snowMat.uniforms;

    const budMat = makeLitMaterial({
      lighting,
      side: DoubleSide,
      uniforms: { ...swayU, ...this.haze, ...this.limbUniforms, uBudDark: { value: rgb('#3a1f18') }, uBudWarm: { value: rgb('#8a5232') }, uSnowCol: this.barkUniforms.uSnowCol },
      vertexPars: /* glsl */ `
${SWAY_GLSL}
${LIMB_GLSL}
attribute vec3 aBud;
varying vec3 vBud;
varying vec3 vObj;
`,
      vertexMain: /* glsl */ `
	vBud = aBud;
	vObj = position;
	pos = swayBend( pos );
	pos = limbBend( pos );
`,
      fragmentPars: /* glsl */ `
uniform vec3 uBudDark;
uniform vec3 uBudWarm;
uniform vec3 uSnowCol;
varying vec3 vBud;
varying vec3 vObj;
${HAZE_GLSL}
`,
      surface: /* glsl */ `
	// 芽鳞：深栗褐的鳞身、游离缘透一线暖棕（半透明的芽鳞边缘），鳞片根部更暗；顶上几片沾一层薄雪
	Surf s;
	vec3 bud = mix( uBudDark, uBudWarm, smoothstep( 0.0, 0.5, vBud.y ) * 0.65 + vBud.x * 0.2 );
	bud *= 0.9 + 0.2 * ( snoise( vObj * 90.0 ) * 0.5 + 0.5 );
	float snow = smoothstep( 0.55, 0.85, N.y + 0.15 * snoise( vObj * 60.0 ) ) * smoothstep( 0.3, 0.9, vBud.x );
	s.albedo = mix( bud, uSnowCol, snow );
	s.ao = mix( 0.7, 1.0, vBud.z );
	s.wrap = 0.35;
	s.specTint = vec3( 1.0 );
	s.gloss = 0.6;
	s.specAmt = 0.25;
	s.alpha = 1.0;
	return s;
`,
      extraLight: /* glsl */ `
	float back = pow( max( dot( -V, uSunDir ), 0.0 ), 2.0 );
	return hazeComposite( N, V, s, uSunColor * back * 0.3 * vBud.y * vec3( 1.0, 0.6, 0.35 ) * sunShadow() );
`,
    });

    const budGeo = buildBudGeometry();
    this.barkMat = barkMat;
    this.snowMat = snowMat;
    this.budMat = budMat;
    this.budGeo = budGeo;
    const budSpots: BudSpot[] = [];

    const list = decor ? [...LIMBS, ...FRONT_LIMBS] : LIMBS;
    // bare（庭院里焊合的春树）：不画观鸟主枝和它的细枝，这棵树只有 addWeldedLimbs 加进去的枝条
    for (const [index, spec] of (opts.bare ? [] : list).entries()) {
      // ---- 母子枝中心轴焊合：子枝起点 = 母枝样条在附着处的精确中心；attach / 刚性附着弧长全部由附着位置算出 ----
      let fixed: number | undefined;
      let collar: [number, number] | undefined;
      if (spec.parent !== undefined) {
        const w = this.weldSpec(index, spec, list, this.limbs, true);
        fixed = w.fixed;
        collar = w.collar;
      }
      const swaySpec = { attach: spec.attach ?? null, bend: !!spec.bend, fixed, collar };
      const limb = spec === LIMBS[0] ? this.main : buildLimb(spec, swaySpec);
      this.limbs.push(limb);
      this.limbSpecs.push(spec);
      // 从积雪的母枝上钻出的子枝：在它钻出雪面的那一点堆一小片扁雪透镜（半径 ≈ 0.17 cm、高 ≈ 0.04 cm，边缘按噪声起伏）——
      // 真实的雪会在枝基部堆起来，浅角钻出的细枝不然会被雪面截成一道平切的暗边
      if (collar !== undefined && list[spec.parent!].snow) {
        const parentLimb = this.limbs[spec.parent!];
        const mound = this.childSnowMound(limb, parentLimb, collar, spec, true);
        this.baseSnow.push(mound.geo);
        if (this.baseOccCount < this.baseOcc.length) {
          this.baseOcc[this.baseOccCount++].set(mound.exit.x, mound.exit.y, mound.exit.z, mound.rExit + 0.1);
        }
      }
      const barkMesh = new Mesh(limb.bark, barkMat);
      barkMesh.castShadow = true;
      barkMesh.receiveShadow = true;
      this.sink.add(barkMesh);
      // 鼠标划过的射线检测只拿嫩梢本体（果台太短、果实太小，不好点）
      if (spec === FRONT_LIMBS[0]) this.twigMesh = barkMesh;


      if (limb.snow) {
        const snowMesh = new Mesh(limb.snow, snowMat);
        snowMesh.castShadow = true;
        snowMesh.receiveShadow = true;
        this.sink.add(snowMesh);
      }

      for (const spot of this.budSpotsFor(limb, spec)) {
        budSpots.push(spot);
      }
    }
    const budMesh = this.mergeBuds(budSpots);
    if (budMesh) this.sink.add(budMesh);
    // 海棠嫩梢根部在主枝上的弧长：焊合契约算出来的（上面循环里写进 FRONT_LIMBS[0].attach）
    this.sway.twigS = FRONT_LIMBS[0].attach ?? 0.7;
    if (this.baseSnow.length > 0) {
      const lensMesh = new Mesh(mergeGeometries(this.baseSnow), this.makeSnowMat(lighting, false));
      lensMesh.castShadow = false;
      lensMesh.receiveShadow = true;
      this.sink.add(lensMesh);
      for (const g of this.baseSnow) g.dispose();
    }
    if (decor) {
      // 左后方那棵 6 米的冬日海棠老树：先建（主干的叶状地衣贴片要并进下面的地衣网格）；noTree 时跳过，背景只剩留白
      if (!opts.noTree) {
        this.sink = this.treeGroup;
        this.buildTree(lighting);
        this.sink = this.heroGroup;
      }
      this.buildBerries(lighting);
      this.buildMossAndLichen(lighting);
      this.buildFuzz(lighting);
    }
    // 构造时传进来的落点也要写进雪帽着色器（漫游入口只走构造函数、不会再调 setPress）
    this.setPress(press);
    // 外部的 addWeldedLimbs（庭院春树）照旧加在 this 下
    this.sink = this;
  }

  /**
   * 子枝基部的雪堆：贴着母枝雪面的一块圆盘（半径 R）沿母枝的 (弧长, 环向角) 铺开，按离中心的距离隆起成一座小丘（高 H，边缘按噪声起伏）——
   * 真实的雪会在枝基部堆起来，浅角钻出的细枝不然会被雪面截成一道平切的暗边。走树枝积雪材质（aSnow）。
   */
  private buildSnowMound(parent: Limb, s0: number, ph0: number, R: number, H: number, seed: number, fogFade = false, limbId = 0): BufferGeometry {
    const K = 6;
    const M = 18;
    const pos: number[] = [];
    const sn: number[] = [];
    const sw: number[] = [];
    const la: number[] = [];
    const lb: number[] = [];
    const idx: number[] = [];
    const up = new Vector3();
    const side = new Vector3();
    const dir = new Vector3();
    const f0 = frameAlong(parent, s0 * parent.length);
    // 雪堆不许比母枝本身还宽（R ≤ 1.15 × 母枝半径），环向角钳在母枝雪帽半宽以内：越出雪帽的雪堆会掉到树皮上，翘成白刺
    R = Math.min(R, f0.r * 1.15);
    // 隆起高度也钳到母枝半径的 0.28：0.1 cm 的细枝上堆 0.09 cm 高的雪堆是一座鲨鱼鳍（weld3 分叉顶的白尖峰）
    H = Math.min(H, f0.r * 0.28);
    const half0 = snowHalf(f0, parent.seed) * 0.96;
    const ph1 = noise1(seed * 3.1, 1) * TAU;
    const ph2 = noise1(seed * 5.7, 2) * TAU;
    for (let k = 0; k <= K; k++) {
      const u = k / K;
      for (let j = 0; j <= M; j++) {
        const th = (j / M) * TAU;
        const rad = R * u * (1 + 0.22 * Math.sin(3 * th + ph1) + 0.1 * Math.sin(7 * th + ph2));
        const along = f0.along + rad * Math.cos(th);
        const phi = clamp(ph0 + (rad * Math.sin(th)) / Math.max(f0.r, 0.05), -half0, half0);
        const f = frameAlong(parent, along);
        limbAxes(f.t, up, side);
        dir.copy(up).multiplyScalar(Math.cos(phi)).addScaledVector(side, Math.sin(phi));
        const snowR = snowSurface(f, parent.seed, phi, along, up, side);
        const edge = Math.abs(phi) / snowHalf(f, parent.seed);
        const rr = snowR !== null ? snowR + snowEdgeRelief(along, phi, edge) : ringRadius(f.r, along, dir.dot(f.n), dir.dot(f.b), parent.seed, parent === this.main ? LIMBS[0].knots : undefined);
        const h = H * Math.pow(Math.max(1 - u * u, 0), 1.4) * (0.85 + 0.3 * noise3(Math.cos(th) * 3 + seed, u * 3, Math.sin(th) * 3));
        pos.push(f.c.x + dir.x * (rr + h), f.c.y + dir.y * (rr + h), f.c.z + dir.z * (rr + h));
        // aSnow.y = 1：边缘按颜色融进雾里（老树分叉窝的雪鞍）；观鸟主枝上的小雪堆仍走 alpha 渐隐
        sn.push(1e3, fogFade ? 1 : 0, 0, 0.86 + 0.12 * smoothstep(0.7, 1.0, u));
        sw.push(along / parent.length, 0, 0);
        // 雪堆长在母枝表面：跟着母枝在这一点处的弯曲位移走（limbId = 母枝号 + 1；0 = 母枝刚性，不动）
        la.push(limbId, along / parent.length);
        lb.push(0, 0);
        if (k < K && j < M) {
          const a = k * (M + 1) + j;
          idx.push(a, a + 1, a + M + 1, a + 1, a + M + 2, a + M + 1);
        }
      }
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(pos, 3));
    g.setAttribute('aSnow', new Float32BufferAttribute(sn, 4));
    g.setAttribute('aSway', new Float32BufferAttribute(sw, 3));
    g.setAttribute('aLimb', new Float32BufferAttribute(la, 2));
    g.setAttribute('aLimbP', new Float32BufferAttribute(lb, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  /** 子枝在母枝上的归一化弧长：atX（母枝上的枝条坐标 x，主枝用）/ atPoint（母枝控制点序号）/ at 三选一。 */
  private attachmentArc(spec: LimbSpec, parentLimb: Limb, parentSpec: LimbSpec): number {
    if (spec.atX !== undefined) return arcFractionAtX(parentLimb, spec.atX);
    if (spec.atPoint !== undefined) {
      const p = parentSpec.points[spec.atPoint];
      return arcFractionAt(parentLimb.curve, new Vector3(p[0], p[1], p[2]));
    }
    return clamp(spec.at ?? 0, 0, 1);
  }

  /**
   * 母子枝中心轴焊合契约（构造函数的 LIMBS / FRONT_LIMBS 与 addWeldedLimbs 的整棵树共用同一份）：
   * 子枝起点 = 母枝样条在附着处的精确中心、第二控制点顺母枝切线过渡 15%、起始半径钳到 0.72 × 母枝半径、
   * 枝领放在真正钻出树皮的那一点。mainParent = true 表示表里的 0 号是主枝（观鸟入口）：挂主枝的子枝写 attach，
   * 其余按刚性附着弧长 fixed；false（焊合的整棵树）全部走 fixed。
   * 焊合记录 this.joints（rigcheck 用 b.limbs[j.child] 查）只在观鸟主枝那条路径上写：焊合的整棵树不进 this.limbs
   * （buildFuzz / 叶片等按 this.limbs 逐根长东西），它的焊合记录由 addWeldedLimbs 记进 weldedJoints。
   */
  private weldSpec(index: number, spec: LimbSpec, list: LimbSpec[], limbs: Limb[], mainParent: boolean): { fixed?: number; collar: [number, number]; sAttach: number } {
    const parentLimb = limbs[spec.parent!];
    if (!parentLimb) throw new Error(`枝条 ${index} 的母枝 ${spec.parent} 还没建（母枝序号必须小于子枝）`);
    const sAttach = this.attachmentArc(spec, parentLimb, list[spec.parent!]);
    const root = parentLimb.curve.getPointAt(sAttach, new Vector3());
    const tan = parentLimb.curve.getTangentAt(sAttach, new Vector3());
    const parentR = interpKeys(parentLimb.radii, sAttach);
    const pts = spec.points;
    // 第二控制点：保持到起点的距离，方向在"原出枝方向"和"母枝切线"之间过渡 15%——子枝先顺着母枝长一小段再斜出去（海沀主梢的腋角因此从 39° 收到 32°）
    const dir = new Vector3(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1], pts[1][2] - pts[0][2]);
    const len = dir.length() || 0.1;
    if (dir.dot(tan) < 0) tan.negate();
    dir.normalize().lerp(tan, 0.15).normalize();
    pts[0] = [root.x, root.y, root.z];
    pts[1] = [root.x + dir.x * len, root.y + dir.y * len, root.z + dir.z * len];
    // 起始半径钳到 0.72 × 母枝半径：子枝根部 100% 埋在母枝木质里、从树皮表面自然穿出
    spec.radii[0] = Math.min(spec.radii[0], 0.72 * parentR);
    // 枝领放在真正钻出树皮的那一点：从母枝轴心顺出枝方向走到离轴 parentR 时的弧长（腋角小的枝要爬很久才钻出来，枝领放在根部就埋在皮里了）
    const dPerp = Math.max(Math.sqrt(Math.max(1 - dir.dot(tan) ** 2, 0)), 0.2);
    // 枝领扩粗量：子枝越细（相对母枝）喇叭越大，细枝 +35%；粗到接近母枝的子枝只扩 +14%（不然比母枝还粗）
    const amp = spec.radii[0] * 0.35 * (1 - 0.6 * clamp(spec.radii[0] / parentR, 0, 1));
    const collar: [number, number] = [parentR / dPerp, amp];
    let fixed: number | undefined;
    if (mainParent && spec.parent === 0) {
      spec.attach = sAttach;
    } else {
      spec.attach = list[spec.parent!].attach;
      fixed = sAttach;
    }
    if (mainParent) this.joints.push({ child: index, parent: spec.parent!, sAttach });
    return { fixed, collar, sAttach };
  }

  /**
   * 子枝从积雪的母枝钻出雪面的那一点堆一小片雪透镜（返回雪堆几何 + 钻出点 / 子枝那里的半径）。
   * byX = true 按枝条坐标 x 找母枝上的弧长（主枝 / 顺着 +X 长的细枝，观鸟入口原样），否则按最近点找（任意走向的枝）。
   */
  private childSnowMound(child: Limb, parent: Limb, collar: readonly [number, number], spec: LimbSpec, byX: boolean, limbId = 0): { geo: BufferGeometry; exit: Vector3; rExit: number } {
    // 沿子枝往外走，找到它真正穿过雪面的那一点（离母枝轴心的距离 ≥ 该角度上的雪面半径），透镜的边落在这一点上
    const up = new Vector3();
    const side = new Vector3();
    let along = collar[0];
    const exit = new Vector3();
    let sExit = spec.attach ?? 0;
    let phExit = 0;
    const step = Math.max(0.004, interpKeys(parent.radii, spec.attach ?? 0.5) / 30);
    for (let i = 0; i < 100; i++) {
      child.curve.getPointAt(Math.min(along / child.length, 0.95), exit);
      sExit = byX ? arcFractionAtX(parent, exit.x) : arcFractionAt(parent.curve, exit, 200);
      const fp = frameAlong(parent, sExit * parent.length);
      limbAxes(fp.t, up, side);
      const radial = exit.clone().sub(fp.c);
      phExit = Math.atan2(radial.dot(side), radial.dot(up));
      const snowR = snowSurface(fp, parent.seed, phExit, fp.along, up, side);
      if (snowR === null || radial.length() >= snowR - 0.004) break;
      along += step;
    }
    // 雪堆和接触遮蔽的尺度跟着子枝粗细走：细嫩梢一圈小雪堆，粗侧枝基部堆成一片雪包
    const rExit = interpKeys(spec.radii, Math.min(along / child.length, 0.95));
    return { geo: this.buildSnowMound(parent, sExit, phExit, 0.28 + 0.8 * rExit, 0.085 + 0.1 * rExit, (spec.seed ?? 1) * 7 + 3, false, limbId), exit, rExit };
  }

  /** 枝上归一化弧长 t 处附着物的 aSway：主枝按自己的弧长；子枝按 (母枝附着弧长, 自己的弧长或焊合的刚性附着弧长, 是否自己弯)。 */
  private swayAt(limb: Limb, t: number): [number, number, number] {
    const s = limb.sway;
    if (!s || s.attach === null) return [t, 0, 0];
    return [s.attach, s.fixed ?? t, s.bend ? 1 : 0];
  }

  /**
   * 树枝积雪材质；fruit = true 给果顶雪帽用（多一项果柄单摆位移 aSwing）。
   * 踩凹在顶点着色器里按 uPress 现算（换落脚点时跟着走），网格里只建没踩过的雪面。
   */
  private makeSnowMat(lighting: LightingUniforms, fruit: boolean): ReturnType<typeof makeLitMaterial> {
    return makeLitMaterial({
      lighting,
      side: DoubleSide,
      alphaToCoverage: true,
      uniforms: { ...this.sway.uniforms, ...this.limbUniforms, uSnowCol: this.barkUniforms.uSnowCol, uSnowFog: { value: rgb('#adb0b4') }, uPress: { value: [new Vector2(1e3, 0), new Vector2(1e3, 0)] }, uBase: { value: this.baseOcc }, ...this.haze },
      vertexPars: /* glsl */ `
${SWAY_GLSL}
${LIMB_GLSL}
${fruit ? FRUIT_SWAY_GLSL : ''}
${NOISE_GLSL}
attribute vec4 aSnow;
uniform vec2 uPress[ 2 ];
varying float vEdge;
varying float vFogEdge;
varying vec3 vObj;
varying float vSpark;
`,
      vertexMain: /* glsl */ `
	float along = aSnow.x;
	float ph = aSnow.y;
	float r = aSnow.z;
	// 脚爪落点的踩凹（和 CPU 的 snowSurface 同一个公式，脚趾贴的就是这个面）
	float dent = 0.0;
	for ( int i = 0; i < 2; i ++ ) {
		float da = along - uPress[ i ].x;
		float dl = ( ph - uPress[ i ].y ) * r;
		dent += 0.035 * exp( - ( da * da + dl * dl ) / 0.0256 );
	}
	pos -= nrm * dent;
	vEdge = aSnow.w;
	// aSnow = (1e3, 1, 0, 边缘系数)：这块雪（树兜雪坡 / 老树分叉窝的雪鞍）的边缘按颜色融进雾里，不走 alphaToCoverage。
	// 树枝雪帽的 aSnow.y 是环向角（±1.4），不能只看它 > 0.5——否则雪帽朝 side 那一半的锯齿边会变成不透明硬边
	vFogEdge = ( aSnow.x > 999.0 && aSnow.y > 0.5 ) ? 1.0 : 0.0;
	vObj = position;
	// 闪光的采样尺度：树枝雪 40 rad/cm；大块的雪堆 / 根颈雪丘（aSnow.z = 0）远看时 40 rad/cm 全是亚像素噪点，降到 4
	vSpark = aSnow.z > 0.0 ? 40.0 : 4.0;
	pos = swayBend( pos );
	pos = limbBend( pos );
${fruit ? '\tpos = fruitSwing( pos );' : ''}
`,
      fragmentPars: /* glsl */ `
uniform vec3 uSnowCol;
uniform vec4 uBase[ 6 ];
uniform vec3 uSnowFog;
varying float vEdge;
varying float vFogEdge;
varying vec3 vObj;
varying float vSpark;
${HAZE_GLSL}
`,
      surface: /* glsl */ `
	float g = snoise( vObj * vSpark ) * 0.5 + 0.5;
	// 子枝基部的接触遮蔽：枝身挡住天光，贴着枝根的雪压暗一圈、往外 1.5 个遮蔽半径内渐亮（w = 0 的空槽位跳过）
	float occ = 0.0;
	for ( int i = 0; i < 6; i ++ ) {
		vec4 b = uBase[ i ];
		float q = distance( vObj, b.xyz ) / ( b.w + 0.01 );
		occ = max( occ, step( 0.01, b.w ) * exp( - q * q * 1.6 ) );
	}
	// 边缘一条窄窄的平滑渐隐（轮廓的蓬松靠网格几何，不靠噪声裁切），不再是白塑料壳的硬边。
	// 4× MSAA 的 alphaToCoverage 只能把手 alpha 量化成 5 档：几十厘米宽的渐隐带会出一圈圈灰色同心阶梯环，
	// 所以大树兜 / 雪鞍（vFogEdge）不走 alpha，在 extraLight 里把光照后的颜色朝雾色混
	float edgeFade = 1.0 - smoothstep( 0.88, 1.0, vEdge );
	float sp = step( 0.975, hash13( floor( vObj * vSpark ) ) );
	Surf s;
	s.albedo = uSnowCol * ( 0.95 + 0.05 * g );
	s.ao = 0.94 * ( 1.0 - 0.38 * occ );
	// 包裹度高：背阳坡也靠天光撑住亮度，不发灰腻子
	s.wrap = 0.72;
	// 雪粒的细碎闪光
	s.specTint = vec3( 1.0 );
	s.gloss = max( 0.5, sp * 0.92 );
	s.specAmt = 0.1 + sp * 0.45;
	s.alpha = mix( edgeFade, 1.0, vFogEdge );
	return s;
`,
      extraLight: /* glsl */ `
	// 次表面散射：雪是半透的，逆光和天光从薄处透出来——朝阳的雪边泛一点暖、背阴处靠天光透出淡蓝白
	float back = pow( max( dot( -V, uSunDir ), 0.0 ), 2.0 );
	float sss = 0.22 + 0.5 * back * ( 0.4 + 0.6 * ( 1.0 - abs( dot( N, V ) ) ) );
	vec3 tint = mix( vec3( 0.85, 0.92, 1.0 ), vec3( 1.0, 0.97, 0.9 ), back );
	float fogK = vFogEdge * smoothstep( 0.88, 1.0, vEdge );
	float k = 1.0 - ( 1.0 - hazeK() ) * ( 1.0 - fogK );
	vec3 target = mix( uHazeCol, uSnowFog, fogK );
	return mix( ( uSunColor * 0.3 * back * tint + uSkyColor * 0.16 * ( 1.0 - 0.5 * N.y ) ) * sunShadow() + uSunColor * 0.04 * sss * tint, target - shadeLit( N, V, s ), k );
`,
    });
  }

  /** 主角枝（鸟停的那一根）的样条数据：漫游入口的调试台按它建碰撞体，LIMBS 一改两边自动一致。 */
  mainSpec(): LimbSpec {
    return LIMBS[0];
  }

  /**
   * 一根枝上所有芽的位置 / 朝向 / 大小（芽长在枝梢一侧、略朝枝梢方向倾）：aSway 跟着芽的附着点——主枝上的芽按自己的
   * 归一化弧长，子枝上的芽按 (母枝附着点 s, 枝内距离 t)，会弯的子枝再带标志。
   */
  private budSpotsFor(limb: Limb, spec: LimbSpec, sway: [number, number, number] | null = null, limbTag?: readonly [number, number, number]): BudSpot[] {
    const out: BudSpot[] = [];
    const tmpN = new Vector3();
    const tmpT = new Vector3();
    const tmpV = new Vector3();
    for (const t of spec.buds ?? []) {
      const p = limb.curve.getPointAt(t);
      const r = interpKeys(limb.radii, t);
      const tangent = limb.curve.getTangentAt(t);
      if (Math.abs(tangent.y) > 0.95) {
        tmpN.set(1, 0, 0).addScaledVector(tangent, -tangent.x);
      } else {
        tmpN.set(0, 1, 0).addScaledVector(tangent, -tangent.y);
      }
      tmpN.normalize();
      tmpT.crossVectors(tangent, tmpN);
      const a = noise1(t * 40 + (spec.seed ?? 0), 9) * TAU;
      tmpV.copy(tmpN).multiplyScalar(Math.cos(a)).addScaledVector(tmpT, Math.sin(a));
      // 冬芽只长侧面以上：出芽方向的竖直分量至少 0.12（底面倒挂的冬芽是穿帮）
      if (tmpV.y < 0.12) {
        tmpV.y = 0.12;
        tmpV.normalize();
      }
      const s = clamp(r / 0.2, 0.55, 1.5);
      const q = new Quaternion().setFromUnitVectors(UP, tmpV.clone().multiplyScalar(0.7).addScaledVector(tangent, 0.55).normalize());
      out.push({
        p: p.clone().addScaledVector(tmpV, r * 0.92),
        q,
        s: new Vector3(0.12 * s, 0.2 * s, 0.12 * s),
        sway: sway ?? this.swayAt(limb, t),
        t,
        limb: limbTag,
      });
    }
    return out;
  }

  /**
   * 把冬芽按各自的位置 / 朝向 / 大小变换后合并成一个静态网格（aSway 跟着每个芽的附着点）。
   * 焊合树的芽带 limb 标签：按它在枝上的弧长 t 写 aLimb / aLimbP，跟着枝弯（观鸟主枝的芽没有标签，不写属性）。
   */
  private mergeBuds(spots: BudSpot[], geo: BufferGeometry = this.budGeo): Mesh | null {
    if (spots.length === 0) return null;
    const geos: BufferGeometry[] = [];
    for (const b of spots) {
      const g = geo.clone().applyMatrix4(new Matrix4().compose(b.p, b.q, b.s));
      const n = g.attributes.position.count;
      const sw = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) sw.set(b.sway, i * 3);
      g.setAttribute('aSway', new Float32BufferAttribute(sw, 3));
      if (b.limb) tagLimbConst(g, b.limb[0], b.t, b.limb[1], b.limb[2]);
      geos.push(g);
    }
    const mesh = new Mesh(mergeGeometries(geos), this.budMat);
    for (const g of geos) g.dispose();
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  /**
   * 往这棵树上加更多枝条（城市漫游入口的整棵树，枝条数据来自 pcg/tree.ts）：
   * 树皮 / 积雪 / 芽点用的都是和主枝同一套材质。所有树皮合成一个网格、积雪合成一个、芽点合成一个，
   * 整棵树只多 3 次绘制。观鸟入口不调用它，画面不变。返回每根枝条的样条与半径（落脚查询用）。
   */
  addLimbs(specs: LimbSpec[]): Limb[] {
    const barks: BufferGeometry[] = [];
    const snows: BufferGeometry[] = [];
    const limbs: Limb[] = [];
    const buds: BudSpot[] = [];
    for (const spec of specs) {
      const limb = buildLimb(spec);
      limbs.push(limb);
      barks.push(limb.bark);
      if (limb.snow) snows.push(limb.snow);
      // 这棵树不弯：芽的 aSway 归零
      buds.push(...this.budSpotsFor(limb, spec, [0, 0, 0]));
    }
    if (barks.length > 0) {
      const barkMesh = new Mesh(mergeGeometries(barks), this.barkMat);
      barkMesh.castShadow = true;
      barkMesh.receiveShadow = true;
      this.add(barkMesh);
    }
    if (snows.length > 0) {
      const snowMesh = new Mesh(mergeGeometries(snows), this.snowMat);
      snowMesh.castShadow = true;
      snowMesh.receiveShadow = true;
      this.add(snowMesh);
    }
    // 芽点：合并成一个静态网格。不能用 InstancedMesh——makeLitMaterial 的顶点着色器不处理 instanceMatrix
    const budMesh = this.mergeBuds(buds);
    if (budMesh) this.add(budMesh);
    return limbs;
  }

  /**
   * 往这棵树上加一整棵"焊合"的树（庭院的院心海棠老树 / 温室里的春树）：specs 里的 parent 是本表内的序号
   * （母枝必须排在子枝前面），母子枝中心轴焊合契约、喇叭形枝领、之字形枝节叶痕、当年生嫩梢与构造函数里的 LIMBS 完全同一套；
   * 母枝有雪时子枝钻出雪面处同样堆一小片雪。这棵树不弯（aSway 全零）。
   * 带 berries 的果台在梢头束生一簇海棠果（berryScale 相对观鸟入口迷你果的倍数），果 / 果梗 / 萼片合一个网格、梗洼雪帽并进雪网格。
   * budDetail / fruitDetail / capDetail 给远看的树降细分（[层数, 每层鳞数] / [环数, 瓣数] / [径向, 环向]）。
   * moundMinR：基部半径（cm）小于它的子枝不堆钻出雪面的雪透镜（远看的树，细枝上的 3 mm 雪堆看不见，省面数）；
   * noBuds：不画冬芽（春树已萌芽展叶，芽由实例叶 / 花代替）。
   * 返回每根枝条（limbPerch 落脚查询用）；焊合记录记进 this.weldedJoints（自检工具按它查子枝起点到母枝中心曲线的距离）。
   */
  addWeldedLimbs(specs: LimbSpec[], lighting: LightingUniforms, opts: { budDetail?: [number, number]; fruitDetail?: [number, number]; capDetail?: [number, number]; fruitSeed?: number; moundMinR?: number; noBuds?: boolean; haze?: Record<string, IUniform>; extraSnow?: BufferGeometry[] } = {}): Limb[] {
    const barks: BufferGeometry[] = [];
    const snows: BufferGeometry[] = [];
    const limbs: Limb[] = [];
    const buds: BudSpot[] = [];
    const fruitGeos: BufferGeometry[] = [];
    const budGeo = opts.budDetail ? buildBudGeometry(opts.budDetail[0], opts.budDetail[1]) : this.budGeo;
    const fruitRng = makeRng((opts.fruitSeed ?? 4242) + 1);
    const joints: WeldedJoint[] = [];
    for (const [index, spec] of specs.entries()) {
      let fixed: number | undefined;
      let collar: [number, number] | undefined;
      let sAttach = 0;
      if (spec.parent !== undefined) {
        const w = this.weldSpec(index, spec, specs, limbs, false);
        fixed = w.fixed;
        collar = w.collar;
        sAttach = w.sAttach;
        joints.push({ tree: limbs, child: index, parent: spec.parent!, sAttach });
      }
      // 枝条随动标签（LIMB_GLSL）：枝号 = 本表序号 + 1（碰撞曲线 tag 里的序号就是它），母枝号 + 焊口弧长
      const limbTag: [number, number, number] = [index + 1, spec.parent !== undefined ? spec.parent + 1 : 0, sAttach];
      const limb = buildLimb(spec, { attach: null, bend: false, fixed, collar, static: true, limb: limbTag });
      limbs.push(limb);
      barks.push(limb.bark);
      if (limb.snow) snows.push(limb.snow);
      const rBase = interpKeys(spec.radii, 0);
      if (collar !== undefined && specs[spec.parent!].snow && rBase >= (opts.moundMinR ?? 0)) snows.push(this.childSnowMound(limb, limbs[spec.parent!], collar, spec, false, limbTag[1]).geo);
      if (!opts.noBuds) {
        for (const b of this.budSpotsFor(limb, spec, [0, 0, 0], limbTag)) buds.push(b);
      }
      if (spec.berries) {
        const tip = limb.curve.getPointAt(1, new Vector3());
        const dir = limb.curve.getTangentAt(1, new Vector3());
        // 扇面方向：垂直于果台的水平向（果台的方位 + 90°），一簇果朝侧面散开
        const fan = new Vector3(-dir.z, 0, dir.x);
        if (fan.lengthSq() < 1e-6) fan.set(1, 0, 0);
        const cluster = buildFruitCluster(tip, dir, { fruits: spec.berries.fruits, empty: spec.berries.empty, far: spec.berries.far === true, scale: spec.berryScale ?? 3.8, fan, detail: opts.fruitDetail, capDetail: opts.capDetail }, fruitRng);
        // 果台自己不是栖木、没有弹簧：整簇果刚性跟着母枝在焊口处的位移走
        for (const g of cluster.geos) fruitGeos.push(tagLimbConst(g, 0, 0, limbTag[1], sAttach));
        for (const g of cluster.caps) snows.push(tagLimbConst(g, 0, 0, limbTag[1], sAttach));
      }
    }
    if (barks.length > 0) {
      const barkMesh = new Mesh(mergeGeometries(barks), this.barkMat);
      barkMesh.castShadow = true;
      barkMesh.receiveShadow = true;
      this.sink.add(barkMesh);
    }
    // 树兜雪坡长在刚性的主干上：补上全零的 aLimb / aLimbP，和别的雪几何合并时属性一致
    if (opts.extraSnow) snows.push(...opts.extraSnow.map((g) => tagLimbConst(g, 0, 0, 0, 0)));
    if (snows.length > 0) {
      const snowMesh = new Mesh(mergeGeometries(snows), this.snowMat);
      snowMesh.castShadow = true;
      snowMesh.receiveShadow = true;
      this.sink.add(snowMesh);
    }
    const budMesh = this.mergeBuds(buds, budGeo);
    if (budMesh) this.sink.add(budMesh);
    if (fruitGeos.length > 0) {
      const merged = mergeGeometries(fruitGeos);
      for (const g of fruitGeos) g.dispose();
      const mesh = new Mesh(merged, makeFruitMaterial(lighting, this.sway.uniforms, this.hazeFruit, this.limbUniforms));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.sink.add(mesh);
    }
    if (budGeo !== this.budGeo) budGeo.dispose();
    this.weldedJoints.push(...joints);
    return limbs;
  }

  // ------------------------------------------------------------------------------------------
  // 越冬红果：细果梗从嫩梢斜出再受重力下垂（4~5 段样条放样的超细果柄），果实是深红半透的小浆果，
  // 果脐（背离果梗的一端）微凹并带一枚小五角宿存萼斑，果顶一顶边缘柔和的薄雪小帽
  // ------------------------------------------------------------------------------------------
  // 越冬海棠果（Malus）：果台尖端的“伞房束生”——所有果梗从同一点长出、呈扇形散开后受重力单调下垂（5 个控制点的样条放样、
  // 12 段的细果梗，基部灰褐 → 果端红褐），果实是带梗洼 / 萼洼的迷你苹果，萼洼里 5 片深褐的宿存干萼片；
  // 同一簇里高低错落、两两不穿插，另有一根不带果的空梗（末端一个残痕）。梗洼里只有最上面 2~3 果盖着 3D 的蓬松雪帽。
  // ------------------------------------------------------------------------------------------
  // 越冬海棠果（Malus）：果台尖端的"伞房束生"——所有果梗从同一点长出、呈扇形散开后受重力单调下垂。果梗是从果台尖 S 到梗洼入口 E
  // 一次性重算的三次 Hermite 弧（起点切线 = 扇开的出口方向、终点切线 = 果轴；先做完果实防穿插松弛再算，没有折角），
  // 12 段的细果梗基部灰褐 → 果端红褐；果实是带梗洼 / 萼洼的迷你苹果，萼洼里 5 片深褐的宿存干萼片；同一簇里高低错落、两两不穿插，
  // 另有一根不带果的空梗（末端一个残痕）。只有每簇最上面 1~2 枚果的梗洼窝里堆一小撮 3D 蓬松白雪。
  // 果梗 / 果实 / 萼片 / 雪帽跟着果台晃（aSway 与果台根部逐位相同），再叠一项果柄单摆（aSwing：根部 0 → 果实 1）
  // ------------------------------------------------------------------------------------------
  private buildBerries(lighting: LightingUniforms): void {
    const rng = makeRng(777);
    const DEG = Math.PI / 180;
    const unit = buildFruitGeometry();
    const geos: BufferGeometry[] = [];
    const caps: BufferGeometry[] = [];
    const up = new Vector3(0, 1, 0);
    const down = new Vector3(0, -1, 0);
    // 默认 threequarter 视角里的屏幕右方向（枝条坐标系）：果梗的扇面沿着它左右张开，正面看才散得开
    const screenRight = new Vector3(0.74, 0, -0.67).normalize();
    const tmpA = new Vector3();
    const tmpB = new Vector3();
    const tmpC = new Vector3();
    const m4 = new Matrix4();
    const quat = new Quaternion();
    const scl = new Vector3();
    interface Fruit {
      R: number;
      aspect: number;
      center: Vector3;
      axis: Vector3;
      dark: boolean;
      seed: number;
    }
    /**
     * 给几何贴上属性并收进合并列表：part 0 果梗 / 1 果实 / 2 萼片 / 3 残痕；arc 给果梗的弧长参数（0 果台 → 1 果端）；
     * aSwing = 果柄单摆的权重：果梗按 arc^1.3 从根部 0 递增到果端 1，果实 / 萼片 / 残痕都是 1。
     */
    const collect = (g: BufferGeometry, sway: readonly [number, number, number], part: number, seed: number, arc: (i: number) => number): void => {
      g.deleteAttribute('uv');
      const count = g.attributes.position.count;
      const sw = new Float32Array(count * 3);
      const pt = new Float32Array(count).fill(part);
      const tt = new Float32Array(count);
      const sd = new Float32Array(count).fill(seed);
      const swing = new Float32Array(count);
      const dirs = g.attributes.aDir as Float32BufferAttribute | undefined;
      const loc = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        sw.set(sway, i * 3);
        tt[i] = arc(i);
        swing[i] = part === 0 ? Math.pow(tt[i], 1.3) : 1;
        if (dirs) loc.set([dirs.getX(i), dirs.getY(i), dirs.getZ(i)], i * 3);
      }
      g.setAttribute('aSway', new Float32BufferAttribute(sw, 3));
      g.setAttribute('aSwing', new Float32BufferAttribute(swing, 1));
      g.setAttribute('aPart', new Float32BufferAttribute(pt, 1));
      g.setAttribute('aT', new Float32BufferAttribute(tt, 1));
      g.setAttribute('aSeed', new Float32BufferAttribute(sd, 1));
      g.setAttribute('aLocal', new Float32BufferAttribute(loc, 3));
      g.deleteAttribute('aDir');
      geos.push(g);
    };

    let fruitSSum = 0;
    let fruitClusters = 0;
    for (const [index, spec] of FRONT_LIMBS.entries()) {
      if (!spec.berries) continue;
      const spur = this.limbs[LIMBS.length + index];
      if (!spur || !spur.sway) continue;
      // 果梗和果实都跟着果台：aSway = 果台根部顶点的 aSway（主枝附着弧长 + 焊合在嫩梢上的刚性附着弧长 + 弯曲标志），逐位相同
      const sway: [number, number, number] = [spur.sway.attach ?? 0, spur.sway.fixed ?? 1, 1];
      fruitSSum += spur.sway.fixed ?? 1;
      fruitClusters++;
      const spurDir = spur.curve.getTangentAt(1, new Vector3());
      const spurTip = spur.curve.getPointAt(1, new Vector3());
      // 果梗从顶芽下方的节间束生（离果台尖 0.035 cm）
      const S = spurTip.clone().addScaledVector(spurDir, -0.035);
      const mean = spurDir.clone().multiplyScalar(0.5).addScaledVector(down, 0.8).normalize();
      const e1 = screenRight.clone().addScaledVector(mean, -screenRight.dot(mean)).normalize();
      const e2 = new Vector3().crossVectors(mean, e1).normalize();
      const total = spec.berries.fruits + spec.berries.empty;
      const fan = (14 + 12 * rng()) * DEG;
      const fruits: Fruit[] = [];
      const pedicels: { d0: Vector3; L: number; radius: number; empty: boolean; fruit: Fruit | null }[] = [];
      for (let k = 0; k < total; k++) {
        const psi = (((k + 0.5) / total) * 2 - 1) * fan + (rng() - 0.5) * 8 * DEG;
        const d0 = mean.clone().multiplyScalar(Math.cos(psi)).addScaledVector(e1, Math.sin(psi)).addScaledVector(e2, (rng() - 0.5) * 0.3);
        // 空梗：扇面外侧朝外翘的那一根（果实在这里脱落了，只剩末端一个残痕）
        const empty = k >= spec.berries.fruits;
        if (empty) d0.addScaledVector(e1, 0.3 * (k % 2 === 0 ? 1 : -1)).addScaledVector(up, 0.12);
        // 第一根是背阴的小果：往扇面后方（远离相机）退一点
        const dark = k === 0 && spec.berries.fruits >= 3;
        if (dark) d0.addScaledVector(e2, -0.4);
        // 单调下垂：果梗出口方向不许朝上
        d0.y = Math.min(d0.y, -0.15);
        d0.normalize();
        const R = dark ? 0.11 + 0.012 * rng() : 0.125 + 0.035 * rng();
        // 果梗长 = 果径的 2.0~2.5 倍（0.48~0.64 cm）
        const L = empty ? 0.4 + 0.1 * rng() : clamp(2 * R * (2.0 + 0.5 * rng()), 0.48, 0.64);
        let fruit: Fruit | null = null;
        if (!empty) {
          const aspect = 0.9 + 0.05 * rng();
          // 初始果心：顺着出口方向走一段再垂下来
          const center = S.clone().addScaledVector(d0, 0.4 * L).addScaledVector(down, 0.55 * L);
          fruit = { R, aspect, center, axis: down.clone(), dark, seed: dark ? 0.99 : rng() * 0.9 };
          fruits.push(fruit);
        }
        pedicels.push({ d0, L, radius: 0.006 + 0.0025 * rng(), empty, fruit });
      }
      // 松弛：果实两两不穿插（间距 ≥ Ri + Rj + 0.012 cm），只在水平面里推开——高低错落由果梗的长度定
      for (let it = 0; it < 30; it++) {
        for (let i = 0; i < fruits.length; i++) {
          for (let j = i + 1; j < fruits.length; j++) {
            const a = fruits[i];
            const b = fruits[j];
            tmpA.set(a.center.x - b.center.x, 0, a.center.z - b.center.z);
            let d = tmpA.length();
            const minD = a.R + b.R + 0.012;
            if (d >= minD) continue;
            if (d < 1e-5) {
              tmpA.set(rng() - 0.5, 0, rng() - 0.5);
              d = tmpA.length();
            }
            tmpA.multiplyScalar(1 / d);
            const push = (minD - d) * 0.5;
            a.center.addScaledVector(tmpA, push);
            b.center.addScaledVector(tmpA, -push);
          }
        }
      }
      // 果台尖顶点实际的 aSway（从树皮网格上读回来，rigcheck 拿它和果梗的比）
      const spurSwayAttr = spur.bark.attributes.aSway;
      const spurSway: [number, number, number] = [
        spurSwayAttr.getX(spurSwayAttr.count - (spec.radial ?? 12) - 1),
        spurSwayAttr.getY(spurSwayAttr.count - (spec.radial ?? 12) - 1),
        spurSwayAttr.getZ(spurSwayAttr.count - (spec.radial ?? 12) - 1),
      ];
      for (const pd of pedicels) {
        // 果轴沿果梗末端的切线（梗洼朝上接着果梗）：由果心相对果台的水平偏移决定，正下方时竖直向下
        let end: Vector3;
        let curve: PedicelCurve;
        if (pd.fruit) {
          const f = pd.fruit;
          tmpA.set(f.center.x - S.x, 0, f.center.z - S.z);
          if (tmpA.lengthSq() < 1e-6) tmpA.set(pd.d0.x, 0, pd.d0.z);
          tmpA.normalize();
          f.axis.copy(down).addScaledVector(tmpA, 0.3).normalize();
          end = f.center.clone().addScaledVector(f.axis, -0.83 * f.R * f.aspect);
          curve = new PedicelCurve(S, end, pd.d0, f.axis.clone());
        } else {
          end = S.clone().addScaledVector(pd.d0, 0.5 * pd.L).addScaledVector(down, 0.4 * pd.L);
          curve = new PedicelCurve(S, end, pd.d0, down.clone());
        }
        this.berryJoints.push({ spurTip, root: S.clone(), spurSway, rootSway: sway, curve });
        const tube = new TubeGeometry(curve, 12, pd.radius, 5, false);
        // 果梗往果端略粗（进入梗洼的那一段）
        const tp = tube.attributes.position;
        for (let i = 0; i < tp.count; i++) {
          const ring = Math.floor(i / 6);
          curve.getPointAt(ring / 12, tmpB);
          tmpC.set(tp.getX(i), tp.getY(i), tp.getZ(i)).sub(tmpB).multiplyScalar(1 + 0.3 * (ring / 12)).add(tmpB);
          tp.setXYZ(i, tmpC.x, tmpC.y, tmpC.z);
        }
        collect(tube, sway, 0, 0, (i) => Math.floor(i / 6) / 12);
        if (!pd.fruit) {
          const knob = new SphereGeometry(0.013, 8, 6);
          knob.translate(end.x, end.y, end.z);
          collect(knob, sway, 3, 0, () => 0);
          continue;
        }
        quat.setFromUnitVectors(up, tmpA.copy(pd.fruit.axis).negate());
        scl.set(pd.fruit.R, pd.fruit.R * pd.fruit.aspect, pd.fruit.R);
        m4.compose(pd.fruit.center, quat, scl);
        collect(unit.clone().applyMatrix4(m4), sway, 1, pd.fruit.seed, () => 0);
        // 宿存萼：5 片深褐的干萼片，有的张开翻过萼洼边沿、有的合拢收进萼洼
        collect(buildSepals(rng() < 0.5, rng).applyMatrix4(m4), sway, 2, pd.fruit.seed, () => 0);
      }
      // 梗洼里的雪：只给每簇最上面的 1~2 果（背阴小果与下位果不盖），只在凹陷的梗洼窝里堆一小撮，边缘不规则
      fruits
        .filter((f) => !f.dark)
        .sort((a, b) => b.center.y - a.center.y)
        .slice(0, 2)
        .forEach((f, i) => {
          const cap = buildSnowCap(f.seed * 100 + i, i === 0 ? 1 : 0.86);
          quat.setFromUnitVectors(up, tmpA.copy(f.axis).negate());
          scl.set(f.R, f.R * f.aspect, f.R);
          m4.compose(f.center, quat, scl);
          cap.applyMatrix4(m4);
          const count = cap.attributes.position.count;
          const sw = new Float32Array(count * 3);
          const swing = new Float32Array(count).fill(1);
          for (let v = 0; v < count; v++) sw.set(sway, v * 3);
          cap.setAttribute('aSway', new Float32BufferAttribute(sw, 3));
          cap.setAttribute('aSwing', new Float32BufferAttribute(swing, 1));
          caps.push(cap);
        });
    }
    // 单摆按果台在嫩梢上的平均位置驱动
    if (fruitClusters > 0) this.sway.fruitS = fruitSSum / fruitClusters;
    unit.dispose();
    if (geos.length > 0) {
      const merged = mergeGeometries(geos);
      for (const g of geos) g.dispose();
      const mat = makeFruitMaterial(lighting, this.sway.uniforms, this.hazeFruit);
      const mesh = new Mesh(merged, mat);
      mesh.castShadow = true;
      // 不接收阴影贴图：低多边形果体的自阴影 / 邻果投影在果肩上是一块硬黑的盖子，漫反射本身已有 ndl 的明暗
      mesh.receiveShadow = false;
      this.berryMesh = mesh;
      this.sink.add(mesh);
    }
    // 梗洼里的雪帽走树枝积雪的材质（同一种雪、同一种次表面散射）+ 果柄单摆；不投影——低多边形的帽边会在果肩上投出一圈锯齿暗箍
    if (caps.length > 0) {
      const capMesh = new Mesh(mergeGeometries(caps), this.makeSnowMat(lighting, true));
      capMesh.castShadow = false;
      capMesh.receiveShadow = true;
      this.sink.add(capMesh);
      for (const g of caps) g.dispose();
    }
  }

  // ------------------------------------------------------------------------------------------
  // 观鸟入口左后方那棵 5.5~6 米的冬日海棠老树（decor 模式）：整棵树走 addWeldedLimbs（树皮 / 雪 / 芽 / 果各 1 次绘制），
  // 主干苔藓再 1 次，叶状地衣并进观鸟主枝那套地衣网格；分叉窝雪堆和根颈雪丘并进树的雪网格
  // ------------------------------------------------------------------------------------------
  private buildTree(lighting: LightingUniforms): void {
    const tree = growCrabappleTree(2024, LIMBS[0].seed, this.treeOpts);
    const m = tree.rootMound;
    // 庭院里有真实的雪地（高度场自己堆雪丘）：不建树兜雪坡，也不占接触遮蔽的槽位
    const mound = this.treeOpts?.rootMound === false ? [] : [this.buildRootMound(m.center, m.R, m.H, m.seed)];
    // 根颈的接触遮蔽占第 5 个槽位（前 4 个留给观鸟主枝的子枝），树的子枝最多再占 1 个
    if (mound.length > 0 && this.baseOccCount < 5) this.baseOcc[this.baseOccCount++].set(m.center[0], m.center[1] + 10, m.center[2], 24);
    const parent = this.sink;
    const before = parent.children.length;
    const limbs = this.addWeldedLimbs(tree.specs, lighting, {
      // 远看的细分：芽只剩一个暗点（80 cm 外 3 px），单层 3 片鳞 + 芽芯就够；远景果 4 环 5 瓣（仰视 100 cm 外 ≤ 20 px）
      budDetail: [1, 3],
      fruitDetail: [4, 5],
      capDetail: [3, 6],
      fruitSeed: 909,
      // 只有主枝 / 二级枝的钻出点堆雪透镜（冠梢和果台上的 3 mm 雪堆远看看不见，250 根冠梢能省 5 万面）
      moundMinR: 0.8,
      haze: this.haze,
      extraSnow: mound,
    });
    // 枝条表和画面枝条留给舞台做栖面查询（碰撞曲线 tag 里的序号 = specs 下标）
    this.treeSpecs.push(...tree.specs);
    this.treeLimbs.push(...limbs);
    // 阴影相机只罩鸟附近 ±10 cm，这棵树在它外面：不投影（省掉投影通道白渲染一遍十万面），照常受光
    const added = parent.children.slice(before);
    for (const c of added) c.castShadow = false;
    const trunk = limbs[0];
    // 分叉窝积雪：过渡枝和 4 股主枝从主干钻出那一站的顶面各堆一撮，并进树的雪网格。
    // 不能在主干上铺（第一版按主干半径铺成 24 cm 宽的雪盘裹在老干上，像一只白手套）
    const exits = tree.trunkChildren.map((idx) => this.exitToParent(limbs[idx], trunk));
    const drifts = exits.map((e, i) => {
      const child = limbs[tree.trunkChildren[i]];
      const f = frameAlong(child, e.s * child.length);
      // 分叉窝的雪鞍只堆薄薄一层（8 股主枝的雪堆叠在一起，按 0.08r 堆是一座大白鹅脖子包）
      return this.buildSnowMound(child, e.s, 0, f.r * 1.0, 0.03 * f.r + 0.05, 300 + tree.trunkChildren[i], true);
    });
    const snowMesh = added.find((c) => c instanceof Mesh && c.material === this.snowMat);
    if (snowMesh instanceof Mesh) {
      const merged = mergeGeometries([snowMesh.geometry, ...drifts]);
      if (merged) {
        snowMesh.geometry.dispose();
        for (const g of drifts) g.dispose();
        snowMesh.geometry = merged;
      }
    }
    this.buildTreeMossAndLichen(lighting, trunk, exits);
  }

  /** 子枝从母枝树皮钻出的那一点（母枝上的归一化弧长 + 环向角）：沿子枝往外走到离母枝轴心 ≥ 1.02 × 母枝半径处。 */
  private exitToParent(child: Limb, parent: Limb): { s: number; ph: number } {
    const up = new Vector3();
    const side = new Vector3();
    const p = new Vector3();
    let s = 0;
    let ph = 0;
    const step = Math.max(0.02, interpKeys(parent.radii, 0.5) / 30);
    for (let along = 0; along < child.length; along += step) {
      child.curve.getPointAt(Math.min(along / child.length, 0.95), p);
      s = arcFractionAt(parent.curve, p, 200);
      const fp = frameAlong(parent, s * parent.length);
      limbAxes(fp.t, up, side);
      const radial = p.clone().sub(fp.c);
      ph = Math.atan2(radial.dot(side), radial.dot(up));
      if (radial.length() >= fp.r * 1.02) break;
    }
    return { s, ph };
  }

  /**
   * 树兜雪坡：贴着地面的一块大圆盘（半径 R、高 H），离中心越高次衰减越薄、边缘按低频噪声起伏，外圈靠 aSnow.w 高次渐隐进雾里
   * （R 60 的小雪饼在全景里是一枚荷包蛋）；一侧堆得略高（风向）。法线按高度场解析求——36 环的网格用 computeVertexNormals
   * 会出一圈圈同心阶梯。走树枝积雪材质（aSnow = (1e3, 0, 0, 边缘系数)；aSnow.z = 0 让闪光的采样尺度放粗）。
   */
  private buildRootMound(center: readonly [number, number, number], R: number, H: number, seed: number): BufferGeometry {
    const K = 36;
    const M = 64;
    const pos: number[] = [];
    const nrm: number[] = [];
    const sn: number[] = [];
    const sw: number[] = [];
    const idx: number[] = [];
    const ph1 = noise1(seed * 3.1, 1) * TAU;
    const ph2 = noise1(seed * 5.7, 2) * TAU;
    const heightAt = (x: number, z: number): number => {
      const dx = x - center[0];
      const dz = z - center[2];
      const th = Math.atan2(dz, dx);
      const edge = R * (1 + 0.07 * Math.sin(3 * th + ph1) + 0.035 * Math.sin(7 * th + ph2));
      const u = clamp(Math.hypot(dx, dz) / edge, 0, 1);
      return H * Math.pow(Math.max(1 - u * u, 0), 1.6) * (0.85 + 0.3 * noise3(x * 0.012, z * 0.012, 1.7)) + H * 0.3 * Math.cos(th - 0.8) * u * (1 - u);
    };
    const e = 1.5;
    for (let k = 0; k <= K; k++) {
      const u = k / K;
      for (let j = 0; j <= M; j++) {
        const th = (j / M) * TAU;
        const rad = R * u * (1 + 0.07 * Math.sin(3 * th + ph1) + 0.035 * Math.sin(7 * th + ph2));
        const x = center[0] + rad * Math.cos(th);
        const z = center[2] + rad * Math.sin(th);
        pos.push(x, center[1] + heightAt(x, z), z);
        const gx = (heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e);
        const gz = (heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
        const nl2 = Math.hypot(gx, 1, gz);
        nrm.push(-gx / nl2, 1 / nl2, -gz / nl2);
        // 边缘系数：u^1.5 推到 1，材质在半径 25% 以外就开始把雪坡往雾色里混，越靠边越浓（一片匀白的雪饼在灰雾里是一枚光斑）
        sn.push(1e3, 1, 0, 0.88 + 0.12 * Math.pow(u, 1.5));
        sw.push(0, 0, 0);
        if (k < K && j < M) {
          const a = k * (M + 1) + j;
          idx.push(a, a + 1, a + M + 1, a + 1, a + M + 2, a + M + 1);
        }
      }
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new Float32BufferAttribute(nrm, 3));
    g.setAttribute('aSnow', new Float32BufferAttribute(sn, 4));
    g.setAttribute('aSway', new Float32BufferAttribute(sw, 3));
    g.setIndex(idx);
    return g;
  }

  /**
   * 老树主干的苔藓 / 地衣：分叉窝（积雪下方）几团厚实的冬苔藓 + 背阴侧两片；叶状地衣长在向阳的老皮上
   * （并进观鸟主枝那套地衣网格）。主干几十厘米长的贴片网格间距放粗（苔藓 1.2 cm、地衣 2 cm，远看），不弯（aSway 全零）。
   */
  private buildTreeMossAndLichen(lighting: LightingUniforms, trunk: Limb, exits: { s: number; ph: number }[]): void {
    const L = trunk.length;
    const rng = makeRng(818);
    const clumps = (n: number): { a: number; t: number; ra: number; rt: number }[] => {
      const out: { a: number; t: number; ra: number; rt: number }[] = [];
      for (let i = 0; i < n; i++) {
        const ra = 0.16 + 0.16 * rng();
        const rt = 0.2 + 0.2 * rng();
        out.push({ a: ra + rng() * (1 - 2 * ra), t: rt + rng() * (1 - 2 * rt), ra, rt });
      }
      return out;
    };
    // 主干半径 12~16 cm，贴片网格间距 1.2 cm（观鸟主枝是 0.3）照样贴得住弧面，面数省 2/3
    const opt = { spacing: 1.2, static: true };
    const mossGeos: BufferGeometry[] = [];
    // 分叉窝：钻出点上方 26 cm 到下方 10 cm，朝子枝那一侧
    for (const e of exits) {
      const along = e.s * L;
      mossGeos.push(this.buildPatch(trunk, Math.max(along - 26, 0), along + 10, e.ph, 0.55, clumps(5), opt));
    }
    // 背阴侧：太阳在枝条坐标约 (−0.3, ·, +0.73) 的方位，背阴 = +x / −z 那一侧；主干中下段两片
    const f = frameAlong(trunk, L * 0.45);
    const shade = new Vector3(0.3, 0, -0.73);
    const thShade = Math.atan2(shade.dot(f.b), shade.dot(f.n));
    mossGeos.push(this.buildPatch(trunk, L * 0.22, L * 0.33, thShade + 0.15, 0.42, clumps(6), opt));
    mossGeos.push(this.buildPatch(trunk, L * 0.45, L * 0.58, thShade - 0.2, 0.38, clumps(5), opt));
    if (mossGeos.length > 0) {
      const base = mergeGeometries(mossGeos);
      for (const g of mossGeos) g.dispose();
      const mesh = shellStack(base, 2, makeMossMaterial(lighting, 2, 0.45, this.sway.uniforms, 1.3, this.haze, 0.25));
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      this.sink.add(mesh);
    }
    // 叶状地衣：向阳的老皮（主干下部）
    const optL = { spacing: 2, static: true };
    this.treeLichen.push(this.buildPatch(trunk, L * 0.08, L * 0.2, thShade + Math.PI, 0.32, undefined, optL));
    this.treeLichen.push(this.buildPatch(trunk, L * 0.3, L * 0.38, thShade + Math.PI + 0.25, 0.22, undefined, optL));
  }

  // ------------------------------------------------------------------------------------------
  private buildMossAndLichen(lighting: LightingUniforms): void {
    const mossGeos: BufferGeometry[] = [];
    const lichenGeos: BufferGeometry[] = [];
    const main = this.main;
    // 拆分时老树主干的地衣另成一个网格（同一材质）放进 treeGroup：主角枝的地衣在锐利层、主干在虚化层，不能共用一个网格
    const treeLichen = this.split ? [] : this.treeLichen;
    // 沿主枝 x → 弧长
    const alongAtX = (x: number): number => this.frameAt(x).along;
    // 环向角 θ 在平行标架 (n, b) 里量：主枝起点处 n ≈ +Z（转了 90° 之后朝相机）、b ≈ −Y，所以 θ = −π/2 是顶面、
    // θ = 0 是朝相机的那一侧。雪帽盖住顶面两侧各约 1.5 rad，苔藓 / 地衣都贴在雪线以下的相机侧与底侧。
    // 只长在多年生老枝（r > 1 cm 的那一段）和分叉窝里：苔藓 / 地衣是常绿的，冬天在雪下的老皮上确实还是绿的，
    // 但鸟脚下这种 1~2 年的细枝上不会长
    const TOP = -Math.PI / 2;
    // 苔藓：分叉窝两处 + 老枝段侧上方的雪线边缘（半掩在雪下）；不贴正底腹
    // 苔藓团：每块贴片里撒 n 个随机椭圆团簇（u / v 方向的半径 ra / rt 都是归一化的），团簇径向衰减成圆润的小苔垫
    const mossRng = makeRng(313);
    const clumps = (n: number): { a: number; t: number; ra: number; rt: number }[] => {
      const out: { a: number; t: number; ra: number; rt: number }[] = [];
      for (let i = 0; i < n; i++) {
        const ra = 0.16 + 0.16 * mossRng();
        const rt = 0.2 + 0.2 * mossRng();
        out.push({ a: ra + mossRng() * (1 - 2 * ra), t: rt + mossRng() * (1 - 2 * rt), ra, rt });
      }
      return out;
    };
    mossGeos.push(this.buildPatch(main, alongAtX(-14.4), alongAtX(-12.0), TOP + 1.4, 0.75, clumps(4)));
    mossGeos.push(this.buildPatch(main, alongAtX(8.8), alongAtX(10.4), TOP + 1.4, 0.75, clumps(4)));
    mossGeos.push(this.buildPatch(main, alongAtX(-31), alongAtX(-24), TOP + 1.4, 0.7, clumps(6)));
    mossGeos.push(this.buildPatch(main, alongAtX(-23), alongAtX(-18.5), TOP + 1.4, 0.7, clumps(3)));
    // 叶状地衣：老枝段雪线正下方、比苔藓团更靠下的一带灰绿群落（和苔藓团错开）
    lichenGeos.push(this.buildPatch(main, alongAtX(-22), alongAtX(-17), TOP + 2.25, 0.35));
    lichenGeos.push(this.buildPatch(main, alongAtX(-33), alongAtX(-30.5), TOP + 2.25, 0.35));
    for (const g of treeLichen) lichenGeos.push(g);
    if (mossGeos.length > 0) {
      const base = mergeGeometries(mossGeos);
      for (const g of mossGeos) g.dispose();
      const layers = 7;
      this.sink.add(shellStack(base, layers, makeMossMaterial(lighting, layers, 0.09, this.sway.uniforms, 3.1)));
    }
    if (lichenGeos.length > 0) {
      const base = mergeGeometries(lichenGeos);
      for (const g of lichenGeos) g.dispose();
      const layers = 4;
      const mat = makeLichenMaterial(lighting, layers, this.sway.uniforms);
      this.sink.add(shellStack(base, layers, mat));
      if (this.split && this.treeLichen.length > 0) {
        const mesh = shellStack(mergeGeometries(this.treeLichen), layers, mat);
        mesh.receiveShadow = true;
        this.treeGroup.add(mesh);
      }
    }
  }

  /**
   * 贴着树皮的一块底面网格（枝条坐标系）：along0..1 弧长范围、环向角 thC ± thHalf；网格间距约 0.045 cm（地衣的圆裂片
   * 才解析得出来，粗了就是纸片碎片）。抓握区（|x| < 3.6）的毛长自动减薄到 0，防脚趾穿模。
   */
  private buildPatch(limb: Limb, along0: number, along1: number, thC: number, thHalf: number, clumps?: { a: number; t: number; ra: number; rt: number }[], opts: { spacing?: number; static?: boolean } = {}): BufferGeometry {
    const r0 = frameAlong(limb, (along0 + along1) * 0.5).r;
    // 网格间距：观鸟主枝 0.045 cm（地衣圆裂片要解析得出来）；大树主干几十厘米长的贴片用 spacing 放粗（远看）
    const spacing = opts.spacing ?? 0.045;
    const nx = Math.max(6, Math.round((along1 - along0) / spacing));
    const ny = Math.max(6, Math.round((2 * thHalf * r0) / spacing));
    const pos: number[] = [];
    const nrm: number[] = [];
    const len: number[] = [];
    const flow: number[] = [];
    const sway: number[] = [];
    const idx: number[] = [];
    const P = new Vector3();
    const N = new Vector3();
    const F = new Vector3();
    const s0 = opts.static ? 0 : along0 / this.main.length;
    const s1 = opts.static ? 0 : along1 / this.main.length;
    for (let i = 0; i <= nx; i++) {
      const u = i / nx;
      const along = lerp(along0, along1, u);
      const f = frameAlong(limb, along);
      for (let j = 0; j <= ny; j++) {
        const v = j / ny;
        const th = thC + (v * 2 - 1) * thHalf;
        const cx = Math.cos(th);
        const cz = Math.sin(th);
        const rr = ringRadius(f.r, along, cx, cz, limb.seed, limb === this.main ? LIMBS[0].knots : undefined, f.nodes, f.collar) + 0.006;
        N.copy(f.n).multiplyScalar(cx).addScaledVector(f.b, cz);
        P.copy(f.c).addScaledVector(N, rr);
        pos.push(P.x, P.y, P.z);
        nrm.push(N.x, N.y, N.z);
        // 长度系数：网格四条边严格归零（smoothstep(0, 0.14, ·) 在边上是 0，以前 min(u,1−u)+wob 会让边界留 0.74 的长度 → 地衣 / 苔藓
        // 被裁成直线切边），边以内再按噪声迂回、不成一块方地毯；抓握区（鸟横站与蹦跳的落点附近）减薄，防脚趾穿模
        // 低频慢近回（沿枝 2.7 cm 波长）+ 一项顺着枝较快的起伏（0.6 cm 波长）：狭长的苔藓条带宽度只有 0.16 cm，光靠低频慢近回边缘在几厘米内是一条直线
        const wob = (noise3(P.x * 2.3 + 5.0, P.y * 2.3, P.z * 2.3) - 0.5) * 0.4 + (noise3(along * 1.6 + 9.0, th * 2.5, 3.0) - 0.5) * 0.5;
        const win = smoothstep(0, 0.14, Math.min(u, 1 - u)) * smoothstep(0, 0.14, Math.min(v, 1 - v));
        const edge = win * smoothstep(0, 0.3, Math.min(u, 1 - u) + wob) * smoothstep(0, 0.3, Math.min(v, 1 - v) + wob);
        const grip = smoothstep(2.8, 3.6, Math.abs(P.x));
        // 中频岛状遮罩把整块 patch 打碎成几簇断续错落的小绒团（约一半面积是缝），再乘一丛一丛的隆起 × 细碎变化
        // 覆盖：叶状地衣用中频岛状遮罩（约一半面积是缝）；苔藓给了 clumps 就按随机椭圆团簇中心径向衰减 × 多频噪声——
        // 圆润的不规则小苔垫，团与团之间留缝
        let cover = smoothstep(0.44, 0.6, noise3(P.x * 2.6 + 3.0, P.y * 2.6, P.z * 2.6)) * (0.55 + 0.9 * noise3(P.x * 1.4 + 11.0, P.y * 1.4, P.z * 1.4)) * (0.7 + 0.6 * noise3(P.x * 9, P.y * 9, P.z * 9));
        if (clumps) {
          cover = 0;
          for (const c of clumps) {
            const d2 = ((u - c.a) / c.ra) ** 2 + ((v - c.t) / c.rt) ** 2;
            if (d2 < 1) cover = Math.max(cover, Math.pow(1 - d2, 1.1));
          }
          cover *= 0.55 + 0.45 * noise3(P.x * 6.0 + 3.0, P.y * 6.0, P.z * 6.0) + 0.25 * (noise3(P.x * 14.0, P.y * 14.0, P.z * 14.0) - 0.5);
        }
        len.push(edge * grip * cover);
        // 倒伏方向：竖直向上投到切平面里（苔藓朝上长）
        F.set(0, 1, 0).addScaledVector(N, -N.y);
        if (F.lengthSq() < 1e-6) F.set(0, 0, 1);
        F.normalize();
        flow.push(F.x, F.y, F.z);
        sway.push(lerp(s0, s1, u), 0, 0);
        if (i < nx && j < ny) {
          const a = i * (ny + 1) + j;
          idx.push(a, a + 1, a + ny + 1, a + 1, a + ny + 2, a + ny + 1);
        }
      }
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new Float32BufferAttribute(nrm, 3));
    g.setAttribute('aLen', new Float32BufferAttribute(len, 1));
    g.setAttribute('aFlow', new Float32BufferAttribute(flow, 3));
    g.setAttribute('aSway', new Float32BufferAttribute(sway, 3));
    g.setIndex(idx);
    return g;
  }

  // ------------------------------------------------------------------------------------------
  // 嫩枝表皮细绒毛（细侧枝）与雪帽边缘迎风段的雾凇晶簇：都沿枝连续随机采样 + 低频团簇遮罩，不定点成排插针
  // ------------------------------------------------------------------------------------------
  private buildFuzz(lighting: LightingUniforms): void {
    const hairs = new HairField(lighting, 6000, 'hair', this.sway.uniforms);
    const frost = new HairField(lighting, 5000, 'frost', this.sway.uniforms);
    const rng = makeRng(4242);
    const P = new Vector3();
    const T = new Vector3();
    const N = new Vector3();
    const D = new Vector3();
    const up = new Vector3();
    const side = new Vector3();
    const dir = new Vector3();
    // 风（枝条坐标系）：从相机那一侧（+Z）顺着枝梢方向（+X）斜着吹来，雾凇迎着风源长
    const WIND = new Vector3(0.7, 0.22, 0.62).normalize();
    for (const [index, limb] of this.limbs.entries()) {
      const spec = this.limbSpecs[index];
      const isMain = spec === LIMBS[0];
      // aSway：主枝上的按自己的归一化弧长；子枝上的按 (母枝附着点 s, 枝内距离 t)
      const swayAt = (t: number): [number, number, number] => this.swayAt(limb, t);
      // 细侧枝的表皮绒毛：密（每厘米约 500 根）、短（0.2~0.4 mm）、宽 0.035 mm，顺着枝梢方向贴伏，正面几乎隐形
      if (!isMain) {
        const count = Math.round(limb.length * 500);
        for (let k = 0; k < count; k++) {
          const t = 0.03 + 0.97 * rng();
          const f = frameAlong(limb, t * limb.length);
          limb.curve.getTangentAt(t, T);
          const a = rng() * TAU;
          N.copy(f.n).multiplyScalar(Math.cos(a)).addScaledVector(f.b, Math.sin(a));
          const rr = ringRadius(f.r, f.along, Math.cos(a), Math.sin(a), limb.seed, undefined, f.nodes, f.collar);
          P.copy(f.c).addScaledVector(N, rr);
          D.copy(T).multiplyScalar(0.9).addScaledVector(N, 0.18).normalize();
          hairs.add(P, D, N, 0.02 + 0.022 * rng(), 0.0035, rng(), swayAt(t));
        }
      }
      // 雾凇：只在雪帽迎风侧的边缘（+side），沿枝连续随机撒点（每厘米约 14 个候选），再乘低频团簇遮罩——
      // 约 35% 的边缘段聚成细小晶簇，其余 65% 干净留白；针 0.22~0.55 mm、宽 0.003~0.005 mm，顺着风向
      if (!limb.snow) continue;
      const count = Math.round(limb.length * 14);
      for (let k = 0; k < count; k++) {
        const t = rng();
        const f = frameAlong(limb, t * limb.length);
        limbAxes(f.t, up, side);
        const half = snowHalf(f, limb.seed);
        const ph = half * (0.9 + 0.1 * rng());
        dir.copy(up).multiplyScalar(Math.cos(ph)).addScaledVector(side, Math.sin(ph));
        const rr = snowSurface(f, limb.seed, ph, f.along, up, side)! + snowEdgeRelief(f.along, ph, ph / half);
        P.copy(f.c).addScaledVector(dir, rr);
        if (noise3(P.x * 1.3, P.y * 1.3 + 7.0, P.z * 1.3) < 0.58) continue;
        N.copy(dir);
        D.copy(WIND).addScaledVector(up, (rng() - 0.5) * 0.3).addScaledVector(f.t, (rng() - 0.5) * 0.3).normalize();
        frost.add(P, D, N, 0.022 + 0.033 * rng(), 0.003 + 0.002 * rng(), rng(), swayAt(t));
      }
    }
    hairs.commit();
    frost.commit();
    this.sink.add(hairs.mesh, frost.mesh);
  }

  /** 主枝上离给定枝条坐标 x 最近的那一帧（相邻两帧线性插值）。 */
  private frameAt(worldX: number): Frame {
    const frames = this.main.frames;
    let i = 0;
    while (i < frames.length - 2 && frames[i + 1].c.x < worldX) i++;
    const a = frames[i];
    const b = frames[i + 1];
    const u = clamp((worldX - a.c.x) / (b.c.x - a.c.x), 0, 1);
    return {
      c: a.c.clone().lerp(b.c, u),
      t: a.t.clone().lerp(b.t, u).normalize(),
      n: a.n.clone().lerp(b.n, u).normalize(),
      b: a.b.clone().lerp(b.b, u).normalize(),
      r: lerp(a.r, b.r, u),
      along: lerp(a.along, b.along, u),
      nodes: a.nodes,
      collar: a.collar,
      snowDepth: a.snowDepth,
      smoothSnow: a.smoothSnow,
      snowHalfK: a.snowHalfK,
    };
  }

  /** 把枝条坐标系里的栖面标架换到世界坐标：整组可能被入口转了角度（观鸟入口绕 Y 转 90° 让主枝横穿画面）。 */
  private toWorld(p: Perch): Perch {
    this.updateMatrix();
    p.center.applyMatrix4(this.matrix);
    p.tangent.transformDirection(this.matrix);
    p.up.transformDirection(this.matrix);
    p.side.transformDirection(this.matrix);
    return p;
  }

  /**
   * 主枝在给定枝条坐标 x 处的抓握几何：中心、切线、顶面/侧向，以及任意环向角、任意轴向偏移处的真实外表面半径
   * （树皮鼓包 + 积雪帽都算进去）。脚爪的每个路径点都从这里查，贴的就是画出来的那个面。
   */
  perchAt(worldX: number): Perch {
    const f = this.frameAt(worldX);
    return this.perchOf(this.main, f);
  }

  /** 主枝上离起点弧长 along（厘米）处的抓握几何，和 perchAt 同一套函数。 */
  perchAlong(along: number): Perch {
    return this.perchOf(this.main, frameAlong(this.main, along));
  }

  private perchOf(limb: Limb, f: Frame): Perch {
    const up = new Vector3();
    const side = new Vector3();
    limbAxes(f.t, up, side);
    const seed = limb.seed;
    const hasSnow = limb.snow !== null;
    const press = limb === this.main ? this.press : PRESS_NONE;
    const dir = new Vector3();
    return this.toWorld({
      center: f.c,
      tangent: f.t,
      up,
      side,
      radius: f.r,
      surfaceRadius: (alpha: number, along: number): number => {
        const alongAbs = f.along + along;
        dir.copy(up).multiplyScalar(Math.cos(alpha)).addScaledVector(side, Math.sin(alpha));
        const bark = ringRadius(f.r, alongAbs, dir.dot(f.n), dir.dot(f.b), seed, undefined, f.nodes, f.collar);
        const snow = hasSnow ? snowSurface(f, seed, alpha, alongAbs, up, side, press) : null;
        if (snow === null) return bark;
        return Math.max(bark, snow + snowEdgeRelief(alongAbs, alpha, Math.abs(alpha) / snowHalf(f, seed)));
      },
    });
  }

  /**
   * 任意一根枝条（addLimbs 加进来的树的枝条）上离弧长 u 最近的那个截面处的抓握几何，和 perchAt 同一套函数
   * （树皮鼓包 + 积雪帽），脚爪贴的是画出来的那个面。u 是从枝条起点起的弧长（厘米）：网格的帧按 getSpacedPoints 的
   * 弧长参数化采样，仿真层 CurvePerch 的弧长和它一致（tools/sim.mjs 的 spline 场景验证过），所以落地接触的 u 可以直接用。
   */
  limbPerch(limb: Limb, u: number): Perch {
    return this.perchOf(limb, frameAlong(limb, u));
  }

  /** 主枝的总长（厘米）和鸟默认落点（x = 0）的弧长。 */
  get mainLength(): number {
    return this.main.length;
  }
  get gripAlong(): number {
    return this.frameAt(0).along;
  }
  /** 主枝归一化弧长 s（固定端 0、梢 1）↔ 枝条坐标 x。 */
  alongToX(along: number): number {
    return frameAlong(this.main, along).c.x;
  }

  /** 换落脚点：积雪的踩凹跟着两只脚走（雪帽顶点着色器和 CPU 的抓握查询同时更新）。 */
  setPress(spots: readonly SnowPress[]): void {
    // x → 主枝累积弧长：着色器里 `da = along - uPress[i].x` 的 along 是弧长，CPU 的 snowSurface 同一个减法
    this.press = spots.map((p) => ({ along: this.frameAt(p.worldX).along, alpha: p.alpha }));
    const u = this.snowUniforms.uPress.value as Vector2[];
    for (let i = 0; i < 2; i++) {
      const p = this.press[i];
      u[i].set(p ? p.along : 1e3, p ? p.alpha : 0);
    }
  }

  /** 每帧推进悬臂梁模态。 */
  update(dt: number): void {
    this.sway.update(dt);
  }

  /** 鸟的落脚点（枝条坐标 x）：静态下垂的平衡点、冲击的模态权重都按它算；离枝（腾空）时 on = false。 */
  setBird(x: number, on: boolean): void {
    this.birdS = clamp(this.frameAt(x).along / this.main.length, 0, 1);
    this.sway.setBird(on, this.birdS);
  }

  /** 落地 / 蹬枝的冲击传给树枝（strength 1 ≈ 落地），作用在鸟脚处。 */
  impulse(strength: number): void {
    this.sway.impulse(strength, this.birdS);
  }

  /** 蹲伏蓄力时把枝往下预压（厘米，鸟脚处的额外下垂）。 */
  preload(sag: number): void {
    this.sway.preload = sag;
  }

  /**
   * 写活跃颤动枝槽位（舞台每帧从仿真世界挑正在晃的几根，按 |offset| 从大到小）：limb = 枝在 addWeldedLimbs 返回表里的序号
   * （= 碰撞曲线 tag 里的序号），offset = 梢端位移（厘米，仿真层 CurvePerch.ownOffset）。超过槽位数的那几根这一帧不画位移。
   */
  setActiveLimbs(entries: readonly { limb: number; offset: number }[]): void {
    writeLimbSlots(this.limbUniforms, entries);
  }

  /** 鼠标快速划过红果侧枝：拨动它轻晃；side 的正负决定往哪边甩。 */
  kickTwig(strength: number, side: number): void {
    this.sway.kickTwig(strength, side);
  }

  /** 射线是否扫到红果侧枝（鼠标拨动用）。 */
  twigHit(ray: Raycaster): boolean {
    const targets = [this.twigMesh, this.berryMesh].filter((m): m is Mesh => m !== null);
    if (targets.length === 0) return false;
    // 庭院散景把主角枝放在图层 1：射线默认只测图层 0，这里临时放开
    const mask = ray.layers.mask;
    ray.layers.enableAll();
    const hit = ray.intersectObjects(targets, false).length > 0;
    ray.layers.mask = mask;
    return hit;
  }

  /**
   * 鸟脚处枝条的弯曲位移（枝条坐标系，竖直 / 侧向，厘米）：鸟的根跟着它走，脚才不会陷进枝里或悬空。
   * 侧向是枝条坐标系的 z（观鸟入口转了 90° 之后是世界的前后）。
   */
  swayOffsetAtBird(out: Vector2): Vector2 {
    return this.sway.offsetAt(this.birdS, out);
  }

  /** 主枝归一化弧长 s（固定端 0、梢 1）处的弯曲位移（枝条坐标系）。 */
  swayOffsetAt(s: number, out: Vector2): Vector2 {
    return this.sway.offsetAt(s, out);
  }
}
