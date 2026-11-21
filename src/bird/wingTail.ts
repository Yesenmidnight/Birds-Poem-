import { Color, Vector3, type BufferGeometry } from 'three';
import { rgb } from '../glsl/lit';
import { clamp, lerp, makeRng } from '../util/math';
import type { BodyParams } from './bodySdf';
import { FeatherBatch, featherMatrix, mirrorMatrix, type FeatherColorFn } from './feathers';

/**
 * 收拢的翅膀与长尾的排布。全部先按右半身摆放，再用 mirrorMatrix 镜像出左半身，
 * 这样羽色里的“前缘 / 后缘 / 外侧”在两侧都保持解剖学上正确的位置。
 */
type V3 = [number, number, number];

const BLACK = rgb('#1b191d');
const BLACK_SOFT = rgb('#2e2a2d');
const WHITE = rgb('#f3efe7');
const ROSE = rgb('#a86f68');
const ROSE_DARK = rgb('#7d5751');

const mix = (a: Color, b: Color, t: number): Color => a.clone().lerp(b, clamp(t, 0, 1));

/** 黑色覆羽，带一截宽白梢——连起来就是翼斑。 */
const covert: FeatherColorFn = (_a, along) => mix(BLACK, WHITE, smooth(0.68, 0.78, along));
/** 白梢较窄的覆羽。 */
const covertSmall: FeatherColorFn = (_a, along) => mix(BLACK, WHITE, smooth(0.78, 0.88, along) * 0.9);
/** 飞羽：黑，后缘一条细白羽缘。 */
const flight: FeatherColorFn = (across, along) => {
  const fringe = smooth(0.86, 0.97, across) * 0.5 + smooth(0.95, 1.0, along) * 0.5;
  return mix(BLACK, WHITE, clamp(fringe, 0, 1) * 0.85);
};
/** 三级飞羽：黑，两缘都有较宽的白边。 */
const tertial: FeatherColorFn = (across, along) => {
  const edge = smooth(0.72, 0.88, Math.abs(across)) * 0.55 + smooth(0.88, 0.99, along) * 0.6;
  return mix(BLACK, WHITE, clamp(edge, 0, 1) * 0.9);
};
/** 肩羽：玫瑰褐色，白梢。 */
const scapular: FeatherColorFn = (_a, along) =>
  mix(mix(ROSE_DARK, ROSE, smooth(0.0, 0.55, along)), WHITE, smooth(0.8, 0.92, along) * 0.85);

/** 更浅、白梢更宽的肩羽。 */
const scapularPale: FeatherColorFn = (_a, along) =>
  mix(mix(ROSE, rgb('#cfa49c'), smooth(0.0, 0.5, along)), WHITE, smooth(0.62, 0.84, along) * 0.9);
/** 更深的肩羽。 */
const scapularDark: FeatherColorFn = (_a, along) =>
  mix(ROSE_DARK, ROSE, smooth(0.1, 0.7, along));

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
  /** 几种羽色轮换使用。 */
  variants?: FeatherColorFn[];
  /** 羽缘柔度（见 FeatherSpec.edgeSoft）。 */
  edgeSoft?: number;
}

/** 右翼的六排羽毛，从最外层的肩羽到最贴身的初级飞羽。 */
const WING_ROWS: RowSpec[] = [
  {
    // 初级飞羽：最长最尖，收拢时羽尖交叠在尾基上方
    count: 9,
    rootA: [2.40, -1.15, 0.05],
    rootB: [2.34, -1.95, 0.05],
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
    cup: 0.3,
    bow: 0.025,
    twist: 0.6,
    color: flight,
    stack: 0.005,
  },
  {
    // 初级覆羽：盖住初级飞羽的根部
    count: 8,
    rootA: [2.63, -1.1, 0.11],
    rootB: [2.54, -1.8, 0.11],
    dirA: [-0.36, 0.0, -0.93],
    dirB: [-0.5, 0.1, -0.86],
    nrmA: [0.82, 0.52, 0.12],
    nrmB: [0.7, 0.65, 0.2],
    lenA: 1.0,
    lenB: 1.25,
    width: 0.44,
    asym: 0.36,
    bare: 0.05,
    tipPos: 0.5,
    tipPow: 0.8,
    cup: 0.3,
    bow: 0.02,
    twist: 0.15,
    color: covertSmall,
    stack: 0.005,
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
    cup: 0.3,
    bow: 0.02,
    twist: 0.06,
    color: flight,
    stack: 0.006,
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
    cup: 0.3,
    bow: 0.02,
    twist: 0.05,
    color: tertial,
    stack: 0.008,
  },
  {
    // 大覆羽：白梢连成翼斑
    count: 8,
    rootA: [2.90, 0.2, 0.16],
    rootB: [2.74, -0.8, 0.16],
    dirA: [0.07, -0.3, -0.953],
    dirB: [0.05, -0.3, -0.953],
    nrmA: [0.88, 0.46, 0.08],
    nrmB: [0.88, 0.46, 0.08],
    lenA: 1.05,
    lenB: 0.95,
    width: 0.48,
    asym: 0.4,
    bare: 0.05,
    tipPos: 0.5,
    tipPow: 0.7,
    cup: 0.3,
    bow: 0.02,
    twist: 0.1,
    color: covert,
    stack: 0.005,
  },
  {
    // 中覆羽
    count: 8,
    rootA: [3.06, 0.38, 0.19],
    rootB: [2.92, -0.35, 0.19],
    dirA: [0.09, -0.32, -0.944],
    dirB: [0.07, -0.32, -0.944],
    nrmA: [0.86, 0.48, 0.1],
    nrmB: [0.86, 0.48, 0.1],
    lenA: 0.72,
    lenB: 0.62,
    width: 0.38,
    asym: 0.42,
    bare: 0.04,
    tipPos: 0.5,
    tipPow: 0.7,
    cup: 0.3,
    bow: 0.02,
    twist: 0.08,
    color: covertSmall,
    stack: 0.005,
  },
  {
    // 肩羽：玫瑰褐带白梢，长短错落地披在翅膀上缘，一直铺到背中段
    count: 13,
    rootA: [3.16, 0.62, 0.22],
    rootB: [2.86, -1.45, 0.17],
    dirA: [0.2, -0.4, -0.9],
    dirB: [0.15, -0.42, -0.895],
    nrmA: [0.78, 0.58, 0.2],
    nrmB: [0.84, 0.5, 0.16],
    lenA: 1.45,
    lenB: 1.2,
    width: 0.46,
    asym: 0.42,
    bare: 0.1,
    tipPos: 0.45,
    tipPow: 0.8,
    cup: 0.3,
    bow: 0.03,
    twist: 0.1,
    color: scapular,
    stack: 0.008,
    lenJitter: 0.28,
    angleJitter: 0.32,
    variants: [scapular, scapularPale, scapularDark],
    // 肩羽是从绒毛里长出来的，羽缘柔化一点，不要像硬纸片插在毛里
    edgeSoft: 1,
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

const UP = new Vector3(0, 1, 0);

export function buildWingAndTail(p: BodyParams, seed = 5): { geometry: BufferGeometry; count: number } {
  const batch = new FeatherBatch();
  const rng = makeRng(seed);
  const root = new Vector3();
  const dir = new Vector3();
  const nrm = new Vector3();
  const tip = new Vector3();

  for (const row of WING_ROWS) {
    for (let i = 0; i < row.count; i++) {
      const f = row.count > 1 ? i / (row.count - 1) : 0;
      const y = lerp(row.rootA[0], row.rootB[0], f) + (rng() - 0.5) * 0.06;
      const z = lerp(row.rootA[1], row.rootB[1], f) + (rng() - 0.5) * 0.06;
      const offset = lerp(row.rootA[2], row.rootB[2], f) - i * row.stack;
      root.set(bodyHalfWidth(p, y, z) + offset, y, z);

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
        const side = new Vector3().crossVectors(nrm, dir).normalize();
        dir.applyAxisAngle(side, jt).normalize();
      }
      const color = row.variants ? row.variants[i % row.variants.length] : row.color;
      const spec = {
        length: len,
        width: row.width,
        asym: row.asym,
        bare: row.bare,
        tipPos: row.tipPos,
        tipPow: row.tipPow,
        cup: row.cup,
        bow: row.bow,
        twist: row.twist,
        color,
        edgeSoft: row.edgeSoft,
      };
      const m = featherMatrix(root, dir, nrm);
      batch.add(spec, m);
      batch.add(spec, mirrorMatrix(m));
    }
  }

  // ---------- 尾：6 对，逐级变短，微微展开 ----------
  const base = new Vector3(...p.tailBase);
  const dir0 = new Vector3(...p.tailDir).normalize();
  const count = 6;
  for (let k = 0; k < count; k++) {
    const d = dir0.clone().applyAxisAngle(UP, -k * 0.085);
    d.y -= 0.012 * k;
    d.normalize();
    const rootT = base.clone().add(new Vector3(0.05 + 0.075 * k, -0.025 * k, 0.02 * k));
    const nrmT = new Vector3(Math.sin(k * 0.1), Math.cos(k * 0.1), 0.06);
    const m = featherMatrix(rootT, d, nrmT);
    const spec = {
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
    };
    batch.add(spec, m);
    batch.add(spec, mirrorMatrix(m));
  }

  return { geometry: batch.build(), count: batch.count };
}
