import { BufferGeometry, Color, DoubleSide, Float32BufferAttribute, Vector3, type IUniform, type ShaderMaterial } from 'three';
import { makeLitMaterial, rgb, type LightingUniforms } from '../glsl/lit';
import { clamp, lerp, makeRng } from '../util/math';
import { bodyGradient, bodySDF, type BodyParams } from './bodySdf';
import { FeatherBatch, featherMatrix, mirrorMatrix, type FeatherColorFn, type FeatherSpec } from './feathers';

/**
 * 收拢的翅膀与长尾的排布。全部先按右半身摆放，再用 mirrorMatrix 镜像出左半身，
 * 这样羽色里的“前缘 / 后缘 / 外侧”在两侧都保持解剖学上正确的位置。
 *
 * 肩背的玫瑰粉棕不是正羽而是绒羽，由 plumage.ts 画在躯体绒毛层里；这里是收拢的翅
 * （覆羽、次级/三级飞羽、初级飞羽，暖炭黑底 + 后半段奶油白细羽缘）和长尾羽。
 */
type V3 = [number, number, number];

/** 黑羽的底色：带一点暖度的深炭黑褐，不是死黑的 #000。 */
const BLACK = rgb('#262226');
const BLACK_SOFT = rgb('#332d30');
/** 羽缘、翼斑的奶油白。 */
const WHITE = rgb('#f0e9dc');

const mix = (a: Color, b: Color, t: number): Color => a.clone().lerp(b, clamp(t, 0, 1));

/**
 * 大覆羽：和中覆羽一样是纯深炭黑褐——北长尾山雀没有大山雀那种横穿翅膀的白色大覆羽翼斑，
 * 翅上的白只来自后半段三级/次级飞羽顺翅长向后收束的纵向羽缘。
 * 羽尖只带一丝几乎看不见的暖灰褐，让叠瓦层次读得出来，不再是一排白麻将牌
 */
const covert: FeatherColorFn = (_a, along) => mix(BLACK, BLACK_SOFT, smooth(0.5, 1.0, along) * 0.45);
/** 中覆羽、初级覆羽：纯黑——侧面只读出大覆羽那一道翼斑。 */
const covertSmall: FeatherColorFn = () => BLACK;
/** 次级飞羽：黑，下缘一条奶油白细羽缘。 */
const flight: FeatherColorFn = (across, along) => {
  const fringe = smooth(0.9, 0.98, across) * 0.8 + smooth(0.97, 1.0, along) * 0.2;
  return mix(BLACK, WHITE, clamp(fringe, 0, 1) * 0.6);
};
/** 初级飞羽：黑，下缘只有一丝很淡的浅线——9 片叠在一起收束成翅尖，白边太亮会成一把梳子。 */
const primary: FeatherColorFn = (across, along) => {
  const fringe = smooth(0.94, 1.0, across) * 0.7 + smooth(0.985, 1.0, along) * 0.3;
  return mix(BLACK, WHITE, clamp(fringe, 0, 1) * 0.22);
};
/** 三级飞羽：黑，两缘各一条窄而清晰的奶油白羽缘——侧面那 2~3 道顺着翅长向后收束的细白线。 */
const tertial: FeatherColorFn = (across, along) => {
  const edge = smooth(0.82, 0.94, Math.abs(across)) * 0.85 + smooth(0.9, 0.99, along) * 0.5;
  return mix(BLACK, WHITE, clamp(edge, 0, 1) * 0.85);
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
  /** 给出羽尖（y、z；x 由体表 + 偏移算出）时，方向和长度都由它决定。 */
  tipA?: [number, number];
  tipB?: [number, number];
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
  /** 顺向叠瓦：被前一片压住的位置（沿羽轴 0..1），叠压 AO 从这里往羽尖过渡。 */
  expose?: number;
  /** 长度的随机浮动比例。 */
  lenJitter?: number;
  /** 羽缘柔度（见 FeatherSpec.edgeSoft）。 */
  edgeSoft?: number;
  /**
   * 羽根往体表里扣的深度（cm）：真鸟翅膀的前缘（腕弯）和上缘（覆羽根）是埋进肩胸绒毛里的，
   * 不是一层悬在外面的纸片。tuckAll 对整排羽根生效（上缘），tuckFront 只对每排最前面几片生效（前缘）。
   */
  tuckAll?: number;
  tuckFront?: number;
}

/**
 * 收拢的右翅：腕关节收在前上方，所有羽片顺着体侧朝尾基（-Z）向后流，只带 10°~22° 的下倾。
 * 每一排都是顺着翅长的叠瓦：羽根沿翅轴排成一行、羽轴与行向平行，前一片压住后一片的基部，
 * 露出来的正好是后一片的末端（覆羽的白梢、飞羽的羽缘）。
 * 由里到外：次级飞羽 → 初级飞羽 → 三级飞羽 → 大覆羽 → 中覆羽 / 初级覆羽。
 * 羽根的 x = 体表 + 偏移，整只翅是贴着两胁的一层包络面；翼下的体表绒毛只压短不剃秃（body.ts），
 * 包络面放在短绒外侧一点点，抬翅时露出来的是自然的胁下绒毛。
 */
const WING_ROWS: RowSpec[] = [
  {
    // 初级飞羽：从腕部出发搭在次级飞羽上，9 片侧缘相压，收束成搭在尾基上方的尖长翅尖
    count: 9,
    rootA: [2.45, -0.5, 0.06],
    rootB: [2.6, -0.36, 0.066],
    tipA: [2.45, -2.5],
    tipB: [2.6, -3.35],
    dirA: [0, -0.1, -1],
    dirB: [0, -0.05, -1],
    nrmA: [0.9, 0.42, 0.08],
    nrmB: [0.75, 0.65, 0.12],
    lenA: 2.2,
    lenB: 2.6,
    width: 0.48,
    asym: 0.4,
    bare: 0.12,
    tipPos: 0.45,
    tipPow: 1.4,
    cup: 0,
    bow: 0,
    twist: 0.06,
    color: primary,
    stack: 0,
    tuckFront: 0.04,
  },
  {
    // 次级飞羽：从翅根朝后下方顺向叠瓦，连成一整片深色翼面，下缘一条奶油白细羽缘
    count: 17,
    rootA: [2.72, -0.3, 0.065],
    rootB: [2.6, -1.7, 0.065],
    dirA: [0.03, -0.37, -0.93],
    dirB: [0.03, -0.37, -0.93],
    nrmA: [0.94, 0.33, 0.05],
    nrmB: [0.94, 0.33, 0.05],
    lenA: 1.0,
    lenB: 0.82,
    width: 0.42,
    asym: 0.6,
    bare: 0.1,
    tipPos: 0.7,
    tipPow: 0.3,
    cup: 0,
    bow: 0,
    twist: 0,
    color: flight,
    stack: 0.003,
    expose: 0.89,
    tuckFront: 0.04,
  },
  {
    // 三级飞羽：3 片上下错开、侧缘相压，盖在次级飞羽的中后段上，两缘的奶油白羽缘连成 2~3 道细白线
    count: 3,
    rootA: [2.8, -0.85, 0.07],
    rootB: [2.6, -1.2, 0.069],
    dirA: [0.03, -0.26, -0.966],
    dirB: [0.03, -0.28, -0.96],
    nrmA: [0.94, 0.33, 0.05],
    nrmB: [0.94, 0.33, 0.05],
    lenA: 1.15,
    lenB: 1.1,
    width: 0.5,
    asym: 0.42,
    bare: 0.08,
    tipPos: 0.5,
    tipPow: 0.8,
    cup: 0,
    bow: 0,
    twist: 0,
    color: tertial,
    stack: 0,
    tuckFront: 0.04,
  },
  {
    // 初级覆羽：盖住腕部初级飞羽的根部
    count: 5,
    rootA: [2.62, -0.42, 0.07],
    rootB: [2.46, -0.52, 0.07],
    dirA: [0.02, -0.21, -0.978],
    dirB: [0.02, -0.21, -0.978],
    nrmA: [0.94, 0.33, 0.05],
    nrmB: [0.94, 0.33, 0.05],
    lenA: 0.5,
    lenB: 0.46,
    width: 0.24,
    asym: 0.45,
    bare: 0.04,
    tipPos: 0.72,
    tipPow: 0.35,
    cup: 0,
    bow: 0,
    twist: 0,
    color: covertSmall,
    stack: 0.002,
    expose: 0.75,
    tuckFront: 0.04,
  },
  {
    // 大覆羽：9 片宽而柔边的羽片顺翅长叠瓦，深炭黑褐，和白翼斑无关（见 covert）
    count: 9,
    rootA: [2.98, -0.14, 0.08],
    rootB: [2.82, -1.32, 0.08],
    dirA: [0.03, -0.22, -0.975],
    dirB: [0.03, -0.24, -0.97],
    nrmA: [0.94, 0.33, 0.05],
    nrmB: [0.94, 0.33, 0.05],
    lenA: 0.46,
    lenB: 0.42,
    width: 0.3,
    asym: 0.45,
    bare: 0.03,
    tipPos: 0.6,
    tipPow: 0.3,
    cup: 0,
    bow: 0,
    twist: 0,
    color: covert,
    stack: 0.0015,
    expose: 0.66,
    edgeSoft: 1,
    // 上缘：整排羽根埋进肩背绒毛里，只有羽身露在外面
    tuckAll: 0.03,
    tuckFront: 0.03,
  },
  {
    // 中覆羽：最外层的黑色窄带，根部被肩背的玫瑰粉棕绒毛搭住
    count: 12,
    rootA: [3.1, -0.1, 0.08],
    rootB: [2.98, -1.15, 0.08],
    dirA: [0.03, -0.19, -0.98],
    dirB: [0.03, -0.21, -0.977],
    nrmA: [0.93, 0.36, 0.05],
    nrmB: [0.93, 0.36, 0.05],
    lenA: 0.4,
    lenB: 0.36,
    width: 0.16,
    asym: 0.5,
    bare: 0.03,
    tipPos: 0.72,
    tipPow: 0.35,
    cup: 0,
    bow: 0,
    twist: 0,
    color: covertSmall,
    stack: 0.0015,
    expose: 0.78,
    // 上缘 + 前缘：翅的上角整个埋进肩部绒毛窝里
    tuckAll: 0.04,
    tuckFront: 0.03,
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

function widthProfile(v: number, tipPos: number, tipPow: number): number {
  const w =
    v < tipPos
      ? Math.pow(Math.sin((v / tipPos) * Math.PI * 0.5), 0.6)
      : Math.pow(Math.cos(((v - tipPos) / (1 - tipPos)) * Math.PI * 0.5), tipPow);
  return Math.max(w, 0.012);
}

const UP = new Vector3(0, 1, 0);

/**
 * 翅根枢轴（鸟局部坐标，右翅；左翅镜像）= 真实的肩关节：在翅膀最前端、深埋在胸肩绒毛窝的里侧。
 * 弹翅时腕肩前部始终埋在绒毛里不动，只有中后段翼面和翅尖绕它往背上方扬起，
 * 前缘不会像掀车门一样翻出体外戳出黑尖刺。
 */
export const WING_PIVOT = new Vector3(0.62, 2.85, -0.15);

/** 一片羽在侧面 (y, z) 上的投影，翼面底板和翼下压毛都用它算羽片的覆盖范围。 */
interface Placement {
  y0: number;
  z0: number;
  dy: number;
  dz: number;
  len: number;
  width: number;
  asym: number;
  bare: number;
  tipPos: number;
  tipPow: number;
}

export interface FeatherSet {
  geometry: BufferGeometry;
  count: number;
  placements: Placement[];
}

/** 一片放好的羽毛：羽根、方向、法线、长度、规格，以及侧面投影。 */
interface PlacedFeather {
  root: Vector3;
  dir: Vector3;
  nrm: Vector3;
  spec: FeatherSpec;
  placement: Placement;
}

/**
 * 收拢右翅的全部羽片 placement（随机种子固定，左右翅共用同一份侧面投影）。
 * 羽根的 x = 体表 + 偏移 − 内扣；给出羽尖的排（飞羽）羽尖贴在体表包络面上。
 */
function placeWingFeathers(p: BodyParams, seed = 5): PlacedFeather[] {
  const rng = makeRng(seed);
  const root = new Vector3();
  const dir = new Vector3();
  const nrm = new Vector3();
  const tip = new Vector3();
  const out: PlacedFeather[] = [];

  for (const row of WING_ROWS) {
    for (let i = 0; i < row.count; i++) {
      const f = row.count > 1 ? i / (row.count - 1) : 0;
      const y = lerp(row.rootA[0], row.rootB[0], f) + (rng() - 0.5) * 0.03;
      const z = lerp(row.rootA[1], row.rootB[1], f) + (rng() - 0.5) * 0.03;
      const offset = lerp(row.rootA[2], row.rootB[2], f) - i * row.stack;
      // 前缘与上缘的羽根往体表里扣：上缘整排都扣，前缘只扣每排最前面几片
      const tuck = (row.tuckAll ?? 0) + (row.tuckFront ?? 0) * (1 - smooth(0, 0.35, f));
      root.set(surfaceHalfWidth(p, y, z) + offset - tuck, y, z);

      const jitter = row.lenJitter ?? 0.03;
      let len = lerp(row.lenA, row.lenB, f) * (1 + (rng() - 0.5) * 2 * jitter);
      if (row.tipA && row.tipB) {
        tip.set(0, lerp(row.tipA[0], row.tipB[0], f), lerp(row.tipA[1], row.tipB[1], f));
        // 羽尖贴在体表包络面上：尾基比两胁窄，按体表算 x，翅尖才搭在尾基上而不是插进身体里
        tip.x = surfaceHalfWidth(p, tip.y, tip.z) + offset - row.stack * 0.5;
        dir.subVectors(tip, root);
        len = dir.length();
      } else {
        dir.set(
          lerp(row.dirA[0], row.dirB[0], f),
          lerp(row.dirA[1], row.dirB[1], f),
          lerp(row.dirA[2], row.dirB[2], f),
        );
        dir.normalize();
        // 羽尖贴着包络面：两胁从前往后先窄后宽，直着伸出去的羽片后半段不是埋进体表就是翘离体表，
        // 压不住后面那片的羽根，瓦片的叠压顺序就乱了。羽尖拉回“体表 + 偏移”处，只比后面那片的羽根高出半个叠压步长
        tip.copy(root).addScaledVector(dir, len);
        tip.x = surfaceHalfWidth(p, tip.y, tip.z) + offset - row.stack * 0.5;
        dir.subVectors(tip, root);
        len = dir.length();
      }
      dir.normalize();
      nrm
        .set(lerp(row.nrmA[0], row.nrmB[0], f), lerp(row.nrmA[1], row.nrmB[1], f), lerp(row.nrmA[2], row.nrmB[2], f))
        .normalize();

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
        expose: row.expose,
      };
      // 侧面投影（右半身坐标）：羽轴方向投到 (y, z) 平面
      const pl = Math.hypot(dir.y, dir.z) || 1;
      out.push({
        root: root.clone(),
        dir: dir.clone(),
        nrm: nrm.clone(),
        spec,
        placement: {
          y0: y,
          z0: z,
          dy: dir.y / pl,
          dz: dir.z / pl,
          len,
          width: row.width,
          asym: row.asym,
          bare: row.bare,
          tipPos: row.tipPos,
          tipPow: row.tipPow,
        },
      });
    }
  }
  return out;
}

/** 收拢翅全部羽片的侧面投影：翼内底壳和翼下压毛的覆盖范围都从它来。 */
export function wingPlacements(p: BodyParams, seed = 5): Placement[] {
  return placeWingFeathers(p, seed).map((f) => f.placement);
}

/**
 * 收拢的右翅：几何在鸟局部坐标里，所有顶点都已减去枢轴，便于绕枢轴旋转。
 * 每片羽顺着体表弯曲贴合（见 FeatherBatch.conformToBody），中后段不再悬空。
 */
export function buildWing(p: BodyParams, seed = 5, side: 1 | -1 = 1): FeatherSet {
  const batch = new FeatherBatch();
  const feathers = placeWingFeathers(p, seed);
  for (const f of feathers) {
    const m = featherMatrix(f.root, f.dir, f.nrm);
    batch.add(f.spec, side === 1 ? m : mirrorMatrix(m));
  }
  batch.conformToBody((y, z) => surfaceHalfWidth(p, y, z));

  const geometry = batch.build();
  geometry.translate(-side * WING_PIVOT.x, -WING_PIVOT.y, -WING_PIVOT.z);
  return { geometry, count: batch.count, placements: feathers.map((f) => f.placement) };
}

/** 翼面覆盖距离场的采样范围与步长（鸟局部坐标，右半身）。 */
const PANEL_Z0 = 0.3;
const PANEL_Z1 = -3.5;
const PANEL_Y0 = 1.7;
const PANEL_Y1 = 3.3;
const PANEL_CELL = 0.03;

/**
 * 羽片覆盖的有符号距离场：侧面 (y, z) 任一点到羽片覆盖边缘的距离（cm）——有羽处为正，无羽处为负。
 */
export interface CoverField {
  sample(y: number, z: number): number;
}

/**
 * 把所有羽片投到侧面 (y, z) 平面算出覆盖范围，再做倒角距离变换。
 * 翼内底壳的内缩轮廓和翼下压毛的范围都从这一个场来：离无羽区不到某个距离的地方不算“被翅盖住”。
 */
export function wingCoverField(placements: Placement[], cell = PANEL_CELL): CoverField {
  const nz = Math.ceil((PANEL_Z0 - PANEL_Z1) / cell) + 1;
  const ny = Math.ceil((PANEL_Y1 - PANEL_Y0) / cell) + 1;
  const covered = new Uint8Array(nz * ny);
  const dist = new Float32Array(nz * ny);
  const INF = 1e9;

  const at = (i: number, j: number): number => i * ny + j;
  for (let i = 0; i < nz; i++) {
    const z = PANEL_Z0 - i * cell;
    for (let j = 0; j < ny; j++) {
      const y = PANEL_Y0 + j * cell;
      let hit = 0;
      for (const f of placements) {
        const qy = y - f.y0;
        const qz = z - f.z0;
        const along = (qy * f.dy + qz * f.dz) / f.len;
        if (along < 0 || along > 1) continue;
        const across = qy * f.dz - qz * f.dy;
        const half = across > 0 ? f.width * (1 - f.asym) : f.width * f.asym;
        const u = (along - f.bare) / (1 - f.bare);
        if (u < 0) continue;
        if (Math.abs(across) <= half * widthProfile(u, f.tipPos, f.tipPow)) {
          hit = 1;
          break;
        }
      }
      const k = at(i, j);
      covered[k] = hit;
      dist[k] = hit ? INF : 0;
    }
  }

  // 倒角距离变换两遍：有羽的格子到最近“无羽”格子的距离（din），无羽的格子到最近有羽格子的距离（dout）
  const chamfer = (d: Float32Array, pass: (i: number, j: number) => boolean): void => {
    const D1 = cell;
    const D2 = cell * Math.SQRT2;
    for (let i = 0; i < nz; i++) {
      for (let j = 0; j < ny; j++) {
        if (!pass(i, j)) continue;
        let v = d[at(i, j)];
        if (i > 0) v = Math.min(v, d[at(i - 1, j)] + D1);
        if (j > 0) v = Math.min(v, d[at(i, j - 1)] + D1);
        if (i > 0 && j > 0) v = Math.min(v, d[at(i - 1, j - 1)] + D2);
        if (i > 0 && j < ny - 1) v = Math.min(v, d[at(i - 1, j + 1)] + D2);
        d[at(i, j)] = v;
      }
    }
    for (let i = nz - 1; i >= 0; i--) {
      for (let j = ny - 1; j >= 0; j--) {
        if (!pass(i, j)) continue;
        let v = d[at(i, j)];
        if (i < nz - 1) v = Math.min(v, d[at(i + 1, j)] + D1);
        if (j < ny - 1) v = Math.min(v, d[at(i, j + 1)] + D1);
        if (i < nz - 1 && j < ny - 1) v = Math.min(v, d[at(i + 1, j + 1)] + D2);
        if (i < nz - 1 && j > 0) v = Math.min(v, d[at(i + 1, j - 1)] + D2);
        d[at(i, j)] = v;
      }
    }
  };
  // dist 已初始化为“有羽 = INF、无羽 = 0”，第一遍只更新有羽的格子
  chamfer(dist, (i, j) => covered[at(i, j)] === 1);
  const outside = new Float32Array(nz * ny);
  for (let k = 0; k < outside.length; k++) outside[k] = covered[k] ? 0 : 1e9;
  chamfer(outside, (i, j) => covered[at(i, j)] === 0);

  // 双线性采样有符号距离：有羽处为正（到羽片覆盖边缘的距离），无羽处为负（到覆盖边缘的距离）；
  // 采样范围之外当作很远的无羽区
  const iz = (z: number): number => (PANEL_Z0 - z) / cell;
  const iy = (y: number): number => (y - PANEL_Y0) / cell;
  const signed = (i: number, j: number): number => (covered[at(i, j)] ? dist[at(i, j)] : -outside[at(i, j)]);
  return {
    sample(y: number, z: number): number {
      const fi = iz(z);
      const fj = iy(y);
      if (fi < -1 || fj < -1 || fi > nz || fj > ny) return -0.5;
      const i = Math.min(nz - 2, Math.max(0, Math.floor(fi)));
      const j = Math.min(ny - 2, Math.max(0, Math.floor(fj)));
      const tz = Math.min(1, Math.max(0, fi - i));
      const ty = Math.min(1, Math.max(0, fj - j));
      const d00 = signed(i, j);
      const d10 = signed(i + 1, j);
      const d01 = signed(i, j + 1);
      const d11 = signed(i + 1, j + 1);
      return (d00 * (1 - tz) + d10 * tz) * (1 - ty) + (d01 * (1 - tz) + d11 * tz) * ty;
    },
  };
}

/** 底板相对羽片轮廓的内缩量：离无羽区不到这个距离的地方不画。 */
const PANEL_INSET = 0.08;
/** 内缩量之外的渐隐宽度。 */
const PANEL_FADE = 0.07;

/**
 * 收拢翅的翼内遮光底壳：严格藏在正羽轮廓以内的一整片深色薄壳，只负责堵住羽片根部之间的缝，
 * 翅膀的外轮廓 100% 由羽片自身的圆弧和尖端决定。
 * 覆盖范围和距离变换来自 wingCoverField：离无羽区不到 0.08 cm 的地方不画，0.08~0.15 cm 之间渐隐——
 * 形状自然内缩、边缘圆润，绝不会伸出羽片之外形成直边或折角。
 */
export function buildWingPanel(p: BodyParams, side: 1 | -1, placements: Placement[]): BufferGeometry {
  const cell = PANEL_CELL;
  const nz = Math.ceil((PANEL_Z0 - PANEL_Z1) / cell) + 1;
  const ny = Math.ceil((PANEL_Y1 - PANEL_Y0) / cell) + 1;
  const field = wingCoverField(placements, cell);
  const dist = new Float32Array(nz * ny);
  for (let i = 0; i < nz; i++) {
    for (let j = 0; j < ny; j++) dist[i * ny + j] = field.sample(PANEL_Y0 + j * cell, PANEL_Z0 - i * cell);
  }

  const alpha = (d: number): number => smooth(PANEL_INSET, PANEL_INSET + PANEL_FADE, d);
  const keep = (i: number, j: number): boolean => dist[i * ny + j] > PANEL_INSET;

  // 只在四个角都在内缩范围里的格子上出面，最外一圈的 alpha 正好为 0，边缘是渐隐的
  const pos: number[] = [];
  const nrm: number[] = [];
  const alp: number[] = [];
  const idx: number[] = [];
  const vid = new Int32Array(nz * ny).fill(-1);
  const g = [0, 0, 0];
  for (let i = 0; i < nz; i++) {
    const z = PANEL_Z0 - i * cell;
    for (let j = 0; j < ny; j++) {
      if (!keep(i, j)) continue;
      const y = PANEL_Y0 + j * cell;
      const x = surfaceHalfWidth(p, y, z) + 0.03;
      vid[i * ny + j] = pos.length / 3;
      pos.push(side * x, y, z);
      bodyGradient(side * x, y, z, p, g);
      const gl = Math.hypot(g[0], g[1], g[2]) || 1;
      nrm.push((side * g[0]) / gl, g[1] / gl, g[2] / gl);
      alp.push(alpha(dist[i * ny + j]));
    }
  }
  for (let i = 0; i < nz - 1; i++) {
    for (let j = 0; j < ny - 1; j++) {
      const a = vid[i * ny + j];
      const b = vid[(i + 1) * ny + j];
      const c = vid[i * ny + j + 1];
      const d = vid[(i + 1) * ny + j + 1];
      if (a < 0 || b < 0 || c < 0 || d < 0) continue;
      // i 增大 = z 减小（向后），j 增大 = y 增大（向上）：按右手定则决定绕序，右半身朝外
      if (side === 1) idx.push(a, b, c, c, b, d);
      else idx.push(a, c, b, c, d, b);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(nrm, 3));
  geometry.setAttribute('aDist', new Float32BufferAttribute(alp, 1));
  geometry.setIndex(idx);
  geometry.translate(-side * WING_PIVOT.x, -WING_PIVOT.y, -WING_PIVOT.z);
  geometry.computeBoundingSphere();
  return geometry;
}

/** 翼面底板的材质：和正羽一样的哑光深色，不抢羽片的层次；aDist 是已经算好的边缘渐隐系数。 */
export function makeWingPanelMaterial(lighting: LightingUniforms): ShaderMaterial {
  const uniforms: Record<string, IUniform> = { uPanelCol: { value: BLACK.clone().multiplyScalar(0.92) } };
  return makeLitMaterial({
    lighting,
    side: DoubleSide,
    alphaToCoverage: true,
    uniforms,
    vertexPars: /* glsl */ `
attribute float aDist;
varying float vFade;
`,
    vertexMain: /* glsl */ `
	vFade = aDist;
`,
    fragmentPars: /* glsl */ `
uniform vec3 uPanelCol;
varying float vFade;
`,
    surface: /* glsl */ `
	Surf s;
	s.albedo = uPanelCol;
	s.ao = 1.0;
	s.wrap = 0.4;
	s.specTint = vec3( 1.0 );
	s.gloss = 0.4;
	s.specAmt = 0.04;
	s.alpha = vFade;
	return s;
`,
  });
}

/**
 * 长尾：6 对，逐级变短，微微展开。几何在鸟局部坐标里减去尾基，每片羽毛带 aFan 属性
 * （左右侧、第几对），扇开时在顶点着色器里绕尾基的竖直轴转动（见 feathers.ts 的 uSpread）。
 * 羽根沿羽轴往臀部里深插 TAIL_ROOT_INSET，羽尖位置不变：从背面看尾基的分叉处全埋在臀部和
 * 尾上覆羽的绒毛里，不会露出一排黑三角；枢轴仍在自然的尾基关节上。
 */
export const TAIL_PAIRS = 6;
const TAIL_ROOT_INSET = 0.32;

export function buildTail(p: BodyParams): FeatherSet {
  const batch = new FeatherBatch();
  const base = new Vector3(...p.tailBase);
  const dir0 = new Vector3(...p.tailDir).normalize();
  for (let k = 0; k < TAIL_PAIRS; k++) {
    const d = dir0.clone().applyAxisAngle(UP, -k * 0.085);
    d.y -= 0.012 * k;
    d.normalize();
    const rootT = base.clone().add(new Vector3(0.05 + 0.075 * k, -0.025 * k, 0.02 * k)).addScaledVector(d, -TAIL_ROOT_INSET);
    const nrmT = new Vector3(Math.sin(k * 0.1), Math.cos(k * 0.1), 0.06);
    const m = featherMatrix(rootT, d, nrmT);
    const fan = k / (TAIL_PAIRS - 1);
    const spec: FeatherSpec = {
      length: 7.6 * (1 - 0.085 * k) + TAIL_ROOT_INSET,
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
  return { geometry, count: batch.count, placements: [] };
}
