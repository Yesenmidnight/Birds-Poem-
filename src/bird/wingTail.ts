import { Color, Vector3, type BufferGeometry } from 'three';
import { rgb } from '../glsl/lit';
import { clamp, lerp, makeRng } from '../util/math';
import { bodySDF, type BodyParams } from './bodySdf';
import { FeatherBatch, featherMatrix, mirrorMatrix, type FeatherColorFn, type FeatherSpec } from './feathers';

/**
 * 收拢的翅膀与长尾的排布。全部先按右半身摆放，再用 mirrorMatrix 镜像出左半身，
 * 这样羽色里的“前缘 / 后缘 / 外侧”在两侧都保持解剖学上正确的位置。
 *
 * 静态里露在外面的只有初级飞羽的羽扇（从后下方的绒毛里探出来搭在臀部上）；
 * 贴着身子的翅身（覆羽、次级/三级飞羽）被体表那层玫瑰粉棕的绒毛盖着，见 RowSpec.hidden。
 */
type V3 = [number, number, number];

const BLACK = rgb('#1b191d');
const BLACK_SOFT = rgb('#2e2a2d');
const WHITE = rgb('#f3efe7');

const mix = (a: Color, b: Color, t: number): Color => a.clone().lerp(b, clamp(t, 0, 1));

/** 黑色覆羽，带一截宽白梢——连起来就是翼斑。羽片像瓦片一样顺着翅长叠着，露在外面的那一截正好是白梢。 */
const covert: FeatherColorFn = (_a, along) => mix(BLACK, WHITE, smooth(0.6, 0.7, along));
/** 白梢较窄的覆羽。 */
const covertSmall: FeatherColorFn = (_a, along) => mix(BLACK, WHITE, smooth(0.58, 0.68, along) * 0.9);
/** 飞羽：黑，后缘一条细白羽缘。 */
const flight: FeatherColorFn = (across, along) => {
  const fringe = smooth(0.93, 1.0, across) * 0.7 + smooth(0.97, 1.0, along) * 0.3;
  return mix(BLACK, WHITE, clamp(fringe, 0, 1) * 0.9);
};
/** 三级飞羽：黑，两缘都有较宽的白边。 */
const tertial: FeatherColorFn = (across, along) => {
  const edge = smooth(0.72, 0.88, Math.abs(across)) * 0.55 + smooth(0.88, 0.99, along) * 0.6;
  return mix(BLACK, WHITE, clamp(edge, 0, 1) * 0.9);
};

/** 尾羽：中央几对黑，最外侧一对白，倒数第二对外缘白。 */
const tailColor = (pair: number): FeatherColorFn => (across, along) => {
  if (pair >= 5) return mix(WHITE, rgb('#e4ded5'), 0.35 * smooth(0.75, 1.0, along));
  if (pair === 4) return mix(BLACK, WHITE, smooth(0.2, 0.5, across) * 0.95);
  return mix(BLACK, BLACK_SOFT, 0.15 + 0.5 * (pair / 4) + 0.15 * (across * 0.5 + 0.5));
};

function smooth(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

interface RowSpec {
  count: number;
  /** 羽根：y、z、以及相对体表向外的偏移。 */
  rootA: [number, number, number];
  rootB: [number, number, number];
  /** 给出羽尖目标点时，方向和长度都由它决定。 */
  tipA?: V3;
  tipB?: V3;
  dirA: V3;
  dirB: V3;
  nrmA: V3;
  nrmB: V3;
  lenA: number;
  lenB: number;
  width: number;
  asym: number;
  bare: number;
  tipPos: number;
  tipPow: number;
  cup: number;
  bow: number;
  twist: number;
  color: FeatherColorFn;
  /** 每往后一片，羽根往体表压多少，让靠前的羽毛盖住靠后的。 */
  stack: number;
  /** 长度的随机浮动比例。 */
  lenJitter?: number;
  /** 方向的随机偏转（弧度）。 */
  angleJitter?: number;
  /** 羽缘柔度（见 FeatherSpec.edgeSoft）。 */
  edgeSoft?: number;
  /**
   * 只留数据、暂不生成网格。贴着身子的翅身（覆羽、次级/三级飞羽）在静态里被体表绒毛盖着，
   * 单独摆出来只是一排排互不相连的羽片，不如藏在毛里；等 M2 做弹翅时再连同绒毛一起重排。
   */
  hidden?: boolean;
}

/** 右翼的几排羽毛，从盖在最外面的覆羽到最贴身的初级飞羽。 */
const WING_ROWS: RowSpec[] = [
  {
    // 初级飞羽：最长最尖，收拢时羽尖交叠在尾基上方
    count: 9,
    rootA: [2.40, -1.15, 0.07],
    rootB: [2.34, -1.95, 0.07],
    tipA: [0.48, 2.75, -3.3],
    tipB: [0.16, 2.62, -3.5],
    dirA: [0, 0, -1],
    dirB: [0, 0, -1],
    nrmA: [0.82, 0.52, 0.12],
    nrmB: [0.55, 0.78, 0.28],
    lenA: 2.2,
    lenB: 2.6,
    width: 0.5,
    asym: 0.28,
    bare: 0.14,
    tipPos: 0.42,
    tipPow: 1.5,
    cup: 0.12,
    bow: 0.025,
    twist: 0.6,
    color: flight,
    stack: 0.005,
  },
  {
    // 初级覆羽：盖住初级飞羽的根部（片数少，每片露在外面的那一截正好是白梢）
    count: 4,
    rootA: [2.63, -1.1, 0.11],
    rootB: [2.54, -1.8, 0.11],
    dirA: [-0.06, -0.02, -0.998],
    dirB: [-0.05, -0.02, -0.998],
    nrmA: [0.82, 0.52, 0.12],
    nrmB: [0.7, 0.65, 0.2],
    lenA: 0.8,
    lenB: 0.72,
    width: 0.38,
    asym: 0.36,
    bare: 0.05,
    tipPos: 0.85,
    tipPow: 0.35,
    cup: 0.12,
    bow: 0.02,
    twist: 0.15,
    color: covertSmall,
    stack: 0.005,
    hidden: true,
  },
  {
    // 次级飞羽：彼此压得很紧，连成一整片深色翼面
    count: 6,
    rootA: [2.63, -0.25, 0.1],
    rootB: [2.48, -1.1, 0.1],
    dirA: [0.05, -0.3, -0.953],
    dirB: [0.04, -0.3, -0.953],
    nrmA: [0.88, 0.46, 0.08],
    nrmB: [0.88, 0.46, 0.08],
    lenA: 1.95,
    lenB: 1.8,
    width: 0.62,
    asym: 0.32,
    bare: 0.12,
    tipPos: 0.5,
    tipPow: 0.9,
    cup: 0.12,
    bow: 0.02,
    twist: 0.06,
    color: flight,
    stack: 0.006,
    hidden: true,
  },
  {
    // 三级飞羽
    count: 3,
    rootA: [2.73, -0.65, 0.14],
    rootB: [2.64, -1.1, 0.14],
    dirA: [0.08, -0.3, -0.952],
    dirB: [0.06, -0.3, -0.952],
    nrmA: [0.88, 0.46, 0.08],
    nrmB: [0.88, 0.46, 0.08],
    lenA: 2.15,
    lenB: 2.0,
    width: 0.7,
    asym: 0.4,
    bare: 0.1,
    tipPos: 0.5,
    tipPow: 0.8,
    cup: 0.12,
    bow: 0.02,
    twist: 0.05,
    color: tertial,
    stack: 0.008,
    hidden: true,
  },
  {
    // 大覆羽：白梢连成翼斑（间距约为羽长的一半，前一片的羽尖压在后一片白梢起点之前）
    count: 4,
    rootA: [2.90, 0.2, 0.16],
    rootB: [2.74, -0.8, 0.16],
    dirA: [0.07, -0.3, -0.953],
    dirB: [0.05, -0.3, -0.953],
    nrmA: [0.88, 0.46, 0.08],
    nrmB: [0.88, 0.46, 0.08],
    lenA: 0.8,
    lenB: 0.72,
    width: 0.36,
    asym: 0.4,
    bare: 0.05,
    tipPos: 0.85,
    tipPow: 0.35,
    cup: 0.12,
    bow: 0.02,
    twist: 0.1,
    color: covert,
    stack: 0.005,
    hidden: true,
  },
  {
    // 中覆羽
    count: 3,
    rootA: [3.06, 0.38, 0.19],
    rootB: [2.92, -0.35, 0.19],
    dirA: [0.09, -0.32, -0.944],
    dirB: [0.07, -0.32, -0.944],
    nrmA: [0.86, 0.48, 0.1],
    nrmB: [0.86, 0.48, 0.1],
    lenA: 0.56,
    lenB: 0.5,
    width: 0.3,
    asym: 0.42,
    bare: 0.04,
    tipPos: 0.85,
    tipPow: 0.35,
    cup: 0.12,
    bow: 0.02,
    twist: 0.08,
    color: covertSmall,
    stack: 0.005,
    hidden: true,
  },
];

/** 体表在 (y, z) 处的半宽：取各椭球在该处的最大 x 跨度。 */
function bodyHalfWidth(p: BodyParams, y: number, z: number): number {
  let w = 0;
  for (const e of [p.belly, p.back, p.chest, p.neck, p.rump, p.head]) {
    const a = (y - e.c[1]) / e.r[1];
    const b = (z - e.c[2]) / e.r[2];
    const q = 1 - a * a - b * b;
    if (q > 0) w = Math.max(w, e.r[0] * Math.sqrt(q));
  }
  return w;
}

/**
 * 体表在 (y, z) 处的真实半宽：沿 x 从各椭球的最大跨度向外搜距离场的零点。
 * 平滑最小值会把几块椭球交界处的表面往外推好几分，只按椭球算羽根会埋进身体里。
 */
function surfaceHalfWidth(p: BodyParams, y: number, z: number): number {
  let lo = bodyHalfWidth(p, y, z);
  if (bodySDF(lo, y, z, p) >= 0) return lo;
  let hi = lo + 0.05;
  while (bodySDF(hi, y, z, p) < 0 && hi < lo + 1) hi += 0.05;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    if (bodySDF(mid, y, z, p) < 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

const UP = new Vector3(0, 1, 0);

/** 翅根枢轴（鸟局部坐标，右翅；左翅镜像）。翅膀绕它抬落、前后扫、翻转。 */
export const WING_PIVOT = new Vector3(0.9, 2.8, -0.6);

export interface FeatherSet {
  geometry: BufferGeometry;
  count: number;
}

/** 收拢的右翅：几何在鸟局部坐标里，所有顶点都已减去枢轴，便于绕枢轴旋转。 */
export function buildWing(p: BodyParams, seed = 5, side: 1 | -1 = 1): FeatherSet {
  const batch = new FeatherBatch();
  const rng = makeRng(seed);
  const root = new Vector3();
  const dir = new Vector3();
  const nrm = new Vector3();
  const tip = new Vector3();

  for (const row of WING_ROWS) {
    if (row.hidden) continue;
    for (let i = 0; i < row.count; i++) {
      const f = row.count > 1 ? i / (row.count - 1) : 0;
      const y = lerp(row.rootA[0], row.rootB[0], f) + (rng() - 0.5) * 0.06;
      const z = lerp(row.rootA[1], row.rootB[1], f) + (rng() - 0.5) * 0.06;
      const offset = lerp(row.rootA[2], row.rootB[2], f) - i * row.stack;
      root.set(surfaceHalfWidth(p, y, z) + offset, y, z);

      const jitter = row.lenJitter ?? 0.04;
      let len = lerp(row.lenA, row.lenB, f) * (1 + (rng() - 0.5) * 2 * jitter);
      if (row.tipA && row.tipB) {
        tip.set(
          lerp(row.tipA[0], row.tipB[0], f),
          lerp(row.tipA[1], row.tipB[1], f),
          lerp(row.tipA[2], row.tipB[2], f),
        );
        dir.subVectors(tip, root);
        len = dir.length();
      } else {
        dir.set(
          lerp(row.dirA[0], row.dirB[0], f),
          lerp(row.dirA[1], row.dirB[1], f),
          lerp(row.dirA[2], row.dirB[2], f),
        );
      }
      dir.normalize();
      nrm
        .set(lerp(row.nrmA[0], row.nrmB[0], f), lerp(row.nrmA[1], row.nrmB[1], f), lerp(row.nrmA[2], row.nrmB[2], f))
        .normalize();

      if (row.angleJitter) {
        const ja = (rng() - 0.5) * 2 * row.angleJitter;
        const jt = (rng() - 0.5) * 2 * row.angleJitter;
        dir.applyAxisAngle(nrm, ja);
        const across = new Vector3().crossVectors(nrm, dir).normalize();
        dir.applyAxisAngle(across, jt).normalize();
      }
      const spec: FeatherSpec = {
        length: len,
        width: row.width,
        asym: row.asym,
        bare: row.bare,
        tipPos: row.tipPos,
        tipPow: row.tipPow,
        cup: row.cup,
        bow: row.bow,
        twist: row.twist,
        color: row.color,
        edgeSoft: row.edgeSoft,
      };
      const m = featherMatrix(root, dir, nrm);
      batch.add(spec, side === 1 ? m : mirrorMatrix(m));
    }
  }

  const geometry = batch.build();
  geometry.translate(-side * WING_PIVOT.x, -WING_PIVOT.y, -WING_PIVOT.z);
  return { geometry, count: batch.count };
}

/** 尾羽对数。 */
export const TAIL_PAIRS = 6;

/**
 * 长尾：6 对，逐级变短，微微展开。几何在鸟局部坐标里减去尾基，每片羽毛带 aFan 属性
 * （左右侧、第几对），扇开时在顶点着色器里绕尾基的竖直轴转动（见 feathers.ts 的 uSpread）。
 */
export function buildTail(p: BodyParams): FeatherSet {
  const batch = new FeatherBatch();
  const base = new Vector3(...p.tailBase);
  const dir0 = new Vector3(...p.tailDir).normalize();
  for (let k = 0; k < TAIL_PAIRS; k++) {
    const d = dir0.clone().applyAxisAngle(UP, -k * 0.085);
    d.y -= 0.012 * k;
    d.normalize();
    const rootT = base.clone().add(new Vector3(0.05 + 0.075 * k, -0.025 * k, 0.02 * k));
    const nrmT = new Vector3(Math.sin(k * 0.1), Math.cos(k * 0.1), 0.06);
    const m = featherMatrix(rootT, d, nrmT);
    const fan = k / (TAIL_PAIRS - 1);
    const spec: FeatherSpec = {
      length: 7.6 * (1 - 0.085 * k),
      width: 0.78 * (1 - 0.05 * k),
      asym: 0.46,
      bare: 0.1,
      tipPos: 0.5,
      tipPow: 1.1,
      cup: 0.12,
      bow: 0.008,
      twist: 0,
      color: tailColor(k),
      fan: [1, fan],
    };
    const specL: FeatherSpec = { ...spec, fan: [-1, fan] };
    batch.add(spec, m);
    batch.add(specL, mirrorMatrix(m));
  }
  const geometry = batch.build();
  geometry.translate(-base.x, -base.y, -base.z);
  return { geometry, count: batch.count };
}
