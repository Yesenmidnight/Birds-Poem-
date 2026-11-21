import { BufferGeometry, Color, DoubleSide, Float32BufferAttribute, Vector3, type IUniform, type ShaderMaterial } from 'three';
import { makeLitMaterial, rgb, type LightingUniforms } from '../glsl/lit';
import { clamp, lerp, makeRng } from '../util/math';
import { bodyGradient, bodySDF, type BodyParams } from './bodySdf';
import { FeatherBatch, featherMatrix, mirrorMatrix, type FeatherColorFn, type FeatherSpec } from './feathers';

/**
 * 收拢的翅膀与长尾的排布。全部先按右半身摆放，再用 mirrorMatrix 镜像出左半身，
 * 这样羽色里的“前缘 / 后缘 / 外侧”在两侧都保持解剖学上正确的位置。
 *
 * 肩背的玫瑰粉棕不是正羽而是绒羽，由 plumage.ts 画在躯体绒毛层里；这里是收拢的整片黑色翼面
 * （覆羽、次级/三级飞羽、初级飞羽，黑底白边）和长尾羽这些硬挺的片状正羽。
 */
type V3 = [number, number, number];

const BLACK = rgb('#1b191d');
const BLACK_SOFT = rgb('#2e2a2d');
const WHITE = rgb('#ece6da');

const mix = (a: Color, b: Color, t: number): Color => a.clone().lerp(b, clamp(t, 0, 1));

/** 黑色覆羽，带一截白梢——连起来就是翼斑。羽片像瓦片一样顺着翅长叠着，露在外面的正好是白梢。
 *  白梢只占露出那一截的后半段：前半段还是黑的，白翼斑才是一道干净的窄带，而不是一串白圆点。 */
const covert: FeatherColorFn = (_a, along) => mix(BLACK, WHITE, smooth(0.78, 0.84, along));
/** 中覆羽、初级覆羽：纯黑——侧面只读出大覆羽那一道翼斑。 */
const covertSmall: FeatherColorFn = () => BLACK;
/** 飞羽：黑，后缘一条细白羽缘。 */
const flight: FeatherColorFn = (across, along) => {
  const fringe = smooth(0.96, 1.0, across) * 0.75 + smooth(0.985, 1.0, along) * 0.25;
  return mix(BLACK, WHITE, clamp(fringe, 0, 1) * 0.05);
};
/** 初级飞羽：黑，后缘只有一丝很淡的白线——收拢时 9 片叠在一起，白边太亮会成一把梳子。 */
const primary: FeatherColorFn = (across, along) => {
  const fringe = smooth(0.97, 1.0, across) * 0.6 + smooth(0.99, 1.0, along) * 0.4;
  return mix(BLACK, WHITE, clamp(fringe, 0, 1) * 0.06);
};
/** 三级飞羽：黑，两缘各一条窄白边。 */
const tertial: FeatherColorFn = (across, along) => {
  const edge = smooth(0.8, 0.95, Math.abs(across)) * 0.85 + smooth(0.9, 0.99, along) * 0.6;
  return mix(BLACK, WHITE, clamp(edge, 0, 1) * 0.7);
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
}

/**
 * 右翼的几排羽毛，从盖在最外面的覆羽到最贴身的初级飞羽。
 * 收拢的翅是一块贴着两胁的干净包络面：覆羽在最外层，顺翅根一行排开、羽尖朝后下方，像瓦片一样
 * 一片压着一片的侧缘，露出来的白梢连成一道翼斑；次级飞羽从覆羽底下垂下来，连成整片黑翼面；
 * 三级飞羽带白边盖在次级飞羽后段上；初级飞羽最长最尖，收拢时指向后方搭在尾基上方。
 * 羽根的 x = 体表 + 偏移，偏移按“覆羽在外、飞羽在内”从 0.20 递减到 0.08；
 * 翼面底下的体表绒毛压到极短（body.ts），壳层毛不会从黑羽里钻出来。
 * 覆羽一律是平的（cup 0）：瓦片只要有一点鼓度，中段就会顶破压在它上面的前一片。
 */
const WING_ROWS: RowSpec[] = [
  {
    // 初级飞羽：最长最尖，收拢时羽尖交叠在尾基上方
    count: 9,
    rootA: [2.42, -1.1, 0.06],
    rootB: [2.34, -1.75, 0.06],
    tipA: [0.5, 2.8, -3.3],
    tipB: [0.18, 2.65, -3.5],
    dirA: [0, 0, -1],
    dirB: [0, 0, -1],
    nrmA: [0.85, 0.5, 0.1],
    nrmB: [0.6, 0.78, 0.25],
    lenA: 2.2,
    lenB: 2.6,
    width: 0.7,
    asym: 0.3,
    bare: 0.14,
    tipPos: 0.42,
    tipPow: 1.5,
    cup: 0,
    bow: 0,
    twist: 0.08,
    color: primary,
    stack: 0.003,
  },
  {
    // 次级飞羽：从翅根垂向后下方，9 片侧缘压得很紧，连成一整片深色翼面，末端露出细细的白缘
    count: 9,
    rootA: [2.74, -0.3, 0.075],
    rootB: [2.6, -1.5, 0.075],
    dirA: [0.02, -0.85, -0.52],
    dirB: [0.02, -0.92, -0.39],
    nrmA: [0.94, 0.33, 0.05],
    nrmB: [0.94, 0.33, 0.05],
    lenA: 0.9,
    lenB: 0.85,
    width: 0.6,
    asym: 0.34,
    bare: 0.1,
    tipPos: 0.5,
    tipPow: 0.9,
    cup: 0,
    bow: 0,
    twist: 0,
    color: flight,
    stack: 0.003,
  },
  {
    // 三级飞羽：两缘各一条窄白边，盖在次级飞羽的后段上
    count: 3,
    rootA: [2.95, -0.6, 0.09],
    rootB: [2.8, -1.1, 0.09],
    dirA: [0.02, -0.78, -0.62],
    dirB: [0.02, -0.85, -0.52],
    nrmA: [0.94, 0.33, 0.05],
    nrmB: [0.94, 0.33, 0.05],
    lenA: 1.2,
    lenB: 1.15,
    width: 0.56,
    asym: 0.42,
    bare: 0.08,
    tipPos: 0.5,
    tipPow: 0.8,
    cup: 0,
    bow: 0,
    twist: 0,
    color: tertial,
    stack: 0.004,
  },
  {
    // 初级覆羽：盖住初级飞羽的根部
    count: 5,
    rootA: [2.64, -1.1, 0.085],
    rootB: [2.54, -1.75, 0.085],
    dirA: [-0.02, -0.7, -0.71],
    dirB: [-0.02, -0.7, -0.71],
    nrmA: [0.95, 0.3, 0.05],
    nrmB: [0.95, 0.3, 0.05],
    lenA: 0.6,
    lenB: 0.56,
    width: 0.36,
    asym: 0.4,
    bare: 0.04,
    tipPos: 0.7,
    tipPow: 0.35,
    cup: 0,
    bow: 0,
    twist: 0,
    color: covertSmall,
    stack: 0.002,
  },
  {
    // 大覆羽：14 片顺翅根排开、侧缘深深相压，方一点的圆梢连成一道连续的窄翼斑
    count: 14,
    rootA: [2.96, 0.2, 0.095],
    rootB: [2.78, -1.0, 0.095],
    dirA: [0.03, -0.92, -0.39],
    dirB: [0.03, -0.92, -0.39],
    nrmA: [0.94, 0.33, 0.05],
    nrmB: [0.94, 0.33, 0.05],
    lenA: 0.52,
    lenB: 0.48,
    width: 0.44,
    asym: 0.42,
    bare: 0.04,
    tipPos: 0.74,
    tipPow: 0.3,
    cup: 0,
    bow: 0,
    twist: 0,
    color: covert,
    stack: 0.0015,
  },
  {
    // 中覆羽：最外层，纯黑，压在大覆羽的基部上，绝不盖住大覆羽的白翼斑
    count: 10,
    rootA: [3.16, 0.32, 0.1],
    rootB: [3.02, -0.7, 0.1],
    dirA: [0.02, -0.66, -0.75],
    dirB: [0.02, -0.66, -0.75],
    nrmA: [0.92, 0.38, 0.05],
    nrmB: [0.92, 0.38, 0.05],
    lenA: 0.42,
    lenB: 0.38,
    width: 0.32,
    asym: 0.5,
    bare: 0.03,
    tipPos: 0.7,
    tipPow: 0.35,
    cup: 0,
    bow: 0,
    twist: 0,
    color: covertSmall,
    stack: 0.0015,
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
        dir.normalize();
        // 羽尖贴着包络面：两胁从前往后先窄后宽，直着伸出去的羽片后半段不是埋进体表就是翘离体表，
        // 压不住后面那片的羽根，瓦片的叠压顺序就乱了（每片都露出整个羽身）。
        // 把羽尖拉回“体表 + 偏移”处，只比后面那片的羽根高出半个叠压步长，刚好压在它上面
        tip.copy(root).addScaledVector(dir, len);
        tip.x = surfaceHalfWidth(p, tip.y, tip.z) + offset - row.stack * 0.5;
        dir.subVectors(tip, root);
        len = dir.length();
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

/** 翼面范围的上缘（与 body.ts / plumage.ts 里压毛的翼面区同一条线）。 */
function wingTop(z: number): number {
  return z >= -1.1 ? 3.3 + 0.2 * z : 3.08 + 0.12 * (z + 1.1);
}
/**
 * 翼面范围的下缘：顺着次级飞羽垂到的位置走，到尾基附近抬回去（那里只有搭在尾基上的初级飞羽）。
 * 底板比这条线再收 0.06，让次级飞羽的羽尖盖过底板的下缘，看不到一条硬边
 */
function wingBottom(z: number): number {
  return (z >= -1.9 ? 2.0 + 0.13 * z : 1.77 + 0.9 * (-1.9 - z)) + 0.06;
}

/**
 * 收拢的翅的底板：贴着体表的一整片深色薄壳，范围就是翼面区，比所有正羽都靠里。
 * 正羽之间、羽尖与体表之间难免有缝，缝里透出的是这块和羽色一致的深色底板，
 * 整只翅才是一块完整、收敛的黑翼面，而不是一片片各自为政的羽片。
 * 四边带 0.09 cm 的透明渐隐（aDist 是到最近一条边的距离），边缘融进四周的绒毛里，没有硬边。
 */
export function buildWingPanel(p: BodyParams, side: 1 | -1 = 1): BufferGeometry {
  const z0 = 0.5;
  const z1 = -2.6;
  const nz = 44;
  const ny = 12;
  const pos: number[] = [];
  const nrm: number[] = [];
  const dist: number[] = [];
  const idx: number[] = [];
  const g = [0, 0, 0];
  for (let i = 0; i <= nz; i++) {
    const z = lerp(z0, z1, i / nz);
    // 上缘收进中覆羽底下，下缘比次级飞羽的羽尖再低一点：羽尖落在底板上，看不到一排羽尖的硬边
    const yB = wingBottom(z) - 0.12;
    const yT = wingTop(z) - 0.14;
    for (let j = 0; j <= ny; j++) {
      const y = lerp(yB, yT, j / ny);
      const x = surfaceHalfWidth(p, y, z) + 0.045;
      pos.push(side * x, y, z);
      bodyGradient(side * x, y, z, p, g);
      const gl = Math.hypot(g[0], g[1], g[2]) || 1;
      nrm.push((side * g[0]) / gl, g[1] / gl, g[2] / gl);
      dist.push(Math.max(Math.min(y - yB, yT - y, z0 - z, z - z1), 0));
      if (i < nz && j < ny) {
        const a = i * (ny + 1) + j;
        const b = a + ny + 1;
        if (side === 1) idx.push(a, b, a + 1, a + 1, b, b + 1);
        else idx.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(nrm, 3));
  geometry.setAttribute('aDist', new Float32BufferAttribute(dist, 1));
  geometry.setIndex(idx);
  geometry.translate(-side * WING_PIVOT.x, -WING_PIVOT.y, -WING_PIVOT.z);
  geometry.computeBoundingSphere();
  return geometry;
}

/** 翼面底板的材质：和正羽一样的哑光深色，不抢羽片的层次；四边渐隐。 */
export function makeWingPanelMaterial(lighting: LightingUniforms): ShaderMaterial {
  const uniforms: Record<string, IUniform> = { uPanelCol: { value: BLACK.clone().multiplyScalar(0.9) } };
  return makeLitMaterial({
    lighting,
    side: DoubleSide,
    alphaToCoverage: true,
    uniforms,
    vertexPars: /* glsl */ `
attribute float aDist;
varying float vDist;
`,
    vertexMain: /* glsl */ `
	vDist = aDist;
`,
    fragmentPars: /* glsl */ `
uniform vec3 uPanelCol;
varying float vDist;
`,
    surface: /* glsl */ `
	Surf s;
	s.albedo = uPanelCol;
	s.ao = 1.0;
	s.wrap = 0.4;
	s.specTint = vec3( 1.0 );
	s.gloss = 0.4;
	s.specAmt = 0.04;
	s.alpha = smoothstep( 0.0, 0.09, vDist );
	return s;
`,
  });
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
