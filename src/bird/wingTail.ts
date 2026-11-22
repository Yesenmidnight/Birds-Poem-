import { BufferAttribute, BufferGeometry, Color, DoubleSide, Float32BufferAttribute, Vector3, type IUniform, type ShaderMaterial } from 'three';
import { makeLitMaterial, rgb, type LightingUniforms } from '../glsl/lit';
import { clamp, lerp, makeRng } from '../util/math';
import { bodyGradient, bodySDF, type BodyParams } from './bodySdf';
import {
  FEATHER_KIND,
  FeatherBatch,
  featherMatrix,
  frameRotation,
  mirrorMatrix,
  WING_SKIN_PARS,
  type FeatherColorFn,
  type FeatherRig,
  type FeatherSpec,
  type WingRigUniforms,
} from './feathers';

/**
 * 翅膀与长尾的排布。全部先按右半身摆放，再用 mirrorMatrix 镜像出左半身，
 * 这样羽色里的“前缘 / 后缘 / 外侧”在两侧都保持解剖学上正确的位置。
 *
 * 翅膀是可展开的：满展态按三段骨骼链（肩 → 肘 → 腕 → 腕掌）在翼平面里摆好，每片羽记一份
 * “收拢 → 满展”的绕羽根旋转和平移，open = 0 完全是收拢态。
 * 肩背的玫瑰粉棕不是正羽而是绒羽，由 plumage.ts 画在躯体绒毛层里；这里是翅
 * （覆羽、次级/三级飞羽、初级飞羽）和长尾羽。
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
 * 翅上的白只来自次级/三级飞羽的外翈。
 * 羽尖只带一丝几乎看不见的暖灰褐，让叠瓦层次读得出来，不再是一排白麻将牌
 */
const covert: FeatherColorFn = (_a, along) => mix(BLACK, BLACK_SOFT, smooth(0.5, 1.0, along) * 0.45);
/** 中覆羽、初级覆羽：纯黑——翼根那块浓郁的深炭黑褐三角。 */
const covertSmall: FeatherColorFn = () => BLACK;
/**
 * 次级飞羽（翼上）：物理自洽的双色羽翈——羽轴与内翈深炭黑，外翈宽阔干净的奶油白。
 * 展开时黑白相间成百褶扇；收拢叠压时暗部藏在下层，只露出纵向白羽缘
 */
const flight: FeatherColorFn = (across, along) => {
  const outer = smooth(0.08, 0.42, across) * (0.85 + 0.15 * smooth(0.0, 0.3, along));
  return mix(BLACK, WHITE, outer * 0.92);
};
/**
 * 初级飞羽（翼上）：烟灰炭褐，往羽尖略深，只带一丝极淡的浅缘——9 片叠在一起收束成翅尖；
 * 羽轴在着色器里单独压深，翼下读得出一条条深色羽轴
 */
const primary: FeatherColorFn = (across, along) => {
  const base = mix(rgb('#473c37'), rgb('#2c2422'), 0.35 + 0.65 * along);
  const fringe = smooth(0.94, 1.0, across) * 0.7 + smooth(0.985, 1.0, along) * 0.3;
  return mix(base, WHITE, clamp(fringe, 0, 1) * 0.18);
};
/**
 * 三级飞羽：朝背脊的内翈（across < 0；背面视图里靠背中线那一侧，用 vFrag.x 配色探针确认过）大半片是
 * 外侧一多半是奶油白（羽轴旁留一线黑，白边才是一道修长的细边而不是整片宽花瓣），朝翅外侧的外翈是深黑褐，
 * 羽尖带一丝暖白——收拢时 3 片沿内上缘阶梯叠瓦就是 3 级白边阶梯
 */
const tertial: FeatherColorFn = (across, along) => {
  const inner = smooth(0.28, 0.66, -across);
  const tip = smooth(0.95, 1.0, along) * 0.35;
  return mix(BLACK, WHITE, clamp(inner * 0.95 + tip * 0.5, 0, 1));
};

/** 尾羽：中央几对黑，最外侧一对白，倒数第二对外缘白。 */
const tailColor = (pair: number): FeatherColorFn => (across, along) => {
  if (pair >= 5) return mix(WHITE, rgb('#e4ded5'), 0.35 * smooth(0.75, 1.0, along));
  if (pair === 4) return mix(BLACK, WHITE, smooth(0.2, 0.5, across) * 0.95);
  return mix(BLACK, BLACK_SOFT, 0.15 + 0.5 * (pair / 4) + 0.15 * (across * 0.5 + 0.5));
};

/** 给 A / 中 / B 三点的二次插值（t = 0..1，t = 0.5 时正好过中点）。 */
function quad(a: number, m: number, b: number, t: number): number {
  const u = 1 - t;
  return u * u * a + 2 * u * t * m + t * t * b;
}

function smooth(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/** 关节在翼平面里的位置 (u, v)：肩在枢轴原点，肘略靠后、腕略靠前，腕掌向前偏约 35°。 */
const JOINT_E: [number, number] = [0.95, -0.14];
const JOINT_W: [number, number] = [2.0, 0.14];
const JOINT_M: [number, number] = [2.78, 0.66];

/** 骨段上参数 t（0 = 近端，1 = 远端）处、向前偏 dv 的点：各排羽的满展羽根都挂在所属骨段上。 */
const onHumerus = (t: number, dv: number): [number, number] => [lerp(0, JOINT_E[0], t), lerp(0, JOINT_E[1], t) + dv];
const onForearm = (t: number, dv: number): [number, number] => [lerp(JOINT_E[0], JOINT_W[0], t), lerp(JOINT_E[1], JOINT_W[1], t) + dv];
const onManus = (t: number, dv: number): [number, number] => [lerp(JOINT_W[0], JOINT_M[0], t), lerp(JOINT_W[1], JOINT_M[1], t) + dv];

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
  /** 可展翅绑定：羽的类别（腹面配色、羽轴处理按它区分）。 */
  kind: number;
  /** 满展布局（见 SpreadRow）。 */
  spread: SpreadRow;
}

/**
 * 一排羽的满展布局：翼平面坐标（u 沿翼展向外、v 向前，cm），羽根行从 A 端到 B 端落在所属骨段上，
 * 羽轴方向角从 +u 向后量（度），沿羽长的缩放给 A / 中 / B 三点，白翈宽度缩放、沿背侧法线的叠放高度。
 */
interface SpreadRow {
  rootA: [number, number];
  rootB: [number, number];
  angA: number;
  angB: number;
  /** 羽轴再往上翘的分量（A → B）：靠近身体的内侧羽片要搭在鼓起的背 / 臀部绒毛上面，不能扎进身体里。 */
  tilt: [number, number];
  len: [number, number, number];
  /** 满展时白翈宽度缩放 */
  white: number;
  /** 满展时羽尖放宽（汤匙圆头） */
  tip: number;
  /** 满展时沿背侧法线的叠放高度（覆羽压在飞羽上面） */
  lift: number;
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
    // 初级飞羽：从腕部出发压在次级飞羽、三级飞羽下面，9 片侧缘相压。收拢时顺着体侧上后方一路贴着
    // 臀部收窄的体表向背中线抱拢，羽尖在尾基正上方彼此靠拢——盖住下背两侧，不撇在圆肚子最外侧
    count: 9,
    rootA: [2.45, -0.12, 0.06],
    rootB: [2.62, 0.02, 0.066],
    tipA: [2.78, -3.14],
    tipB: [2.84, -3.24],
    dirA: [0, -0.1, -1],
    dirB: [0, -0.05, -1],
    nrmA: [0.99, 0.02, 0.03],
    nrmB: [0.99, 0.02, 0.03],
    lenA: 2.2,
    lenB: 2.6,
    width: 0.48,
    asym: 0.4,
    bare: 0.12,
    tipPos: 0.45,
    tipPow: 1.0,
    cup: 0,
    bow: 0,
    twist: 0.06,
    color: primary,
    stack: 0,
    tuckFront: 0.04,
    // 满展：沿腕掌从腕到指尖依次排开，从朝后内（最内侧）扇到朝前外（最外侧），
    // 中段最长、内外两端渐短 → 宽阔圆弧翼尖；总扇幅约 90°，羽尖处外侧几片略分开
    kind: FEATHER_KIND.primary,
    spread: { rootA: onManus(0.1, 0.05), rootB: onManus(1.0, 0), angA: 84, angB: -4, tilt: [0.08, 0], len: [0.69, 0.95, 0.89], white: 1, tip: 1.3, lift: 0 },
  },
  {
    // 次级飞羽：像真鸟收拢翅那样，17 片的羽根沿翅上缘（前臂）从肘侧排到腕侧，羽轴从上缘斜往下后方垂下、
    // 彼此侧缘相压——肘侧（靠身体）的更陡，腕侧的更平；每片只露出带白羽缘的外翈一窄条，连成一排斜向叠搭在
    // 初级飞羽上的平行细纹。羽尖从下前方（肘侧）到上后方（腕侧）斜向圆润递进，全部收在初级飞羽勾出的柳叶下缘
    // 以内：不再 17 片齐刷刷截在同一条 z 上砍出直角黑台阶，也不垂到初级飞羽下缘以下。肘侧的压在腕侧的上面
    count: 17,
    rootA: [3.0, -1.6, 0.08],
    rootB: [2.96, -0.55, 0.082],
    dirA: [0.03, -0.3, -0.95],
    dirB: [0.03, -0.55, -0.83],
    nrmA: [0.99, 0.02, 0.03],
    nrmB: [0.99, 0.02, 0.03],
    lenA: 0.94,
    lenB: 0.8,
    width: 0.42,
    asym: 0.6,
    bare: 0.1,
    tipPos: 0.7,
    tipPow: 0.3,
    cup: 0,
    bow: 0,
    twist: 0,
    color: flight,
    stack: -0.0004,
    tuckFront: 0.04,
    // 满展：沿前臂从腕端（A）到肘端（B）铺满内圈翼面，外侧的朝后外、内侧的朝后内（约 45° 扇幅）；
    // 收拢时为了柳叶翼面只做了 0.86~0.94 cm，展开后放到真鸟比例（约 1.4~1.45 cm）；白翈收窄成折扇里的一道道白褶。
    // spread.len 是相对收拢长度的比例：收拢长度一改就要重配，展开后的羽长才不变
    kind: FEATHER_KIND.secondary,
    spread: { rootA: onForearm(0.97, 0), rootB: onForearm(0.09, 0.08), angA: 76, angB: 122, tilt: [0.02, 0.3], len: [1.5, 1.67, 1.8], white: 0.34, tip: 1.15, lift: 0.04 },
  },
  {
    // 三级飞羽：3 片宽圆羽全部集中在紧贴肩羽下方的翅内上缘窄带里——羽根每片只低 0.08、后移 0.21，
    // 主要沿 -Z 前后由短到长阶梯叠压，贴着翼面不鼓包；前一片压在后一片的基部上面，每片露出朝背脊的宽白内翈
    // + 羽轴一线黑心。正背面看是内上缘 3 级白边阶梯，侧面 / 斜前看只是翅上内缘一道修长的奶油白叠边
    // （上一版 3 片从 y 3.02 竖排到 2.22，像三颗浮在翅面上的大瓜子）。羽根埋在肩羽绒毛里
    count: 3,
    rootA: [3.02, -0.62, 0.106],
    rootB: [2.86, -1.04, 0.1],
    dirA: [0.03, -0.14, -0.99],
    dirB: [0.03, -0.14, -0.99],
    nrmA: [0.99, 0.02, 0.03],
    nrmB: [0.99, 0.02, 0.03],
    lenA: 0.75,
    lenB: 1.3,
    width: 0.32,
    // 内翈（白）0.144、外翈（黑）0.176：每片露出一条修长的白翈边 + 一条黑翈（羽片窄一点，侧面看才是一道细边而不是三片宽花瓣）
    asym: 0.45,
    bare: 0.08,
    tipPos: 0.5,
    tipPow: 0.7,
    cup: 0,
    bow: 0,
    twist: 0,
    color: tertial,
    // 正的：前一片 offset 最大，压在后一片上面（后面的露出前一片羽尖之后的那一截）
    stack: 0.003,
    tuckFront: 0,
    // 满展：肘部的三级飞羽，朝后内盖住翅根和身体的接缝，压在次级飞羽内侧几片上面（len 按新的收拢长度重配，展开羽长不变）
    kind: FEATHER_KIND.tertial,
    spread: { rootA: onHumerus(1.0, 0.1), rootB: onHumerus(0.8, 0.05), angA: 112, angB: 126, tilt: [0.45, 0.6], len: [2.15, 1.6, 1.27], white: 0.45, tip: 1.3, lift: 0.12 },
  },
  {
    // 初级覆羽：盖住腕部初级飞羽的根部。整排收在主翼面前缘轮廓以内（羽根在初级飞羽根部后上方 0.1~0.2），
    // 前缘外侧的胸绒垂搭下来把它埋住——上一版第一片 (z -0.42) 单独戳在胸侧白毛里，像一颗孤立的圆黑豆
    count: 5,
    rootA: [2.72, -0.2, 0.08],
    rootB: [2.66, -0.3, 0.08],
    dirA: [0.02, -0.21, -0.978],
    dirB: [0.02, -0.21, -0.978],
    nrmA: [0.99, 0.02, 0.03],
    nrmB: [0.99, 0.02, 0.03],
    lenA: 0.44,
    lenB: 0.4,
    width: 0.22,
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
    // 满展：沿腕掌盖在初级飞羽根部上方，方向比初级飞羽略收拢
    kind: FEATHER_KIND.covert,
    spread: { rootA: onManus(0.12, 0.1), rootB: onManus(0.87, 0.08), angA: 46, angB: 4, tilt: [0.05, 0], len: [1.93, 2.06, 2.07], white: 1.6, tip: 1.2, lift: 0.03 },
  },
  {
    // 大覆羽：9 片宽而柔边的羽片顺翅长叠瓦，深炭黑褐，和白翼斑无关（见 covert）
    count: 9,
    rootA: [3.0, 0.18, 0.112],
    rootB: [2.92, -1.3, 0.112],
    dirA: [0.03, -0.22, -0.975],
    dirB: [0.03, -0.24, -0.97],
    nrmA: [0.99, 0.02, 0.03],
    nrmB: [0.99, 0.02, 0.03],
    lenA: 0.5,
    lenB: 0.46,
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
    // 上缘：整排羽根埋进肩背绒毛里，只有羽身露在外面。羽缘不再用 edgeSoft 软化：软边半透明，底下压短的毛
    // 从边里透出来就是一串黑麻点；边缘利落，靠外侧的肩背长毛漫过来搭住它
    tuckAll: 0.03,
    tuckFront: 0.03,
    // 满展：沿前臂盖住次级飞羽的根部
    kind: FEATHER_KIND.covert,
    spread: { rootA: onForearm(0.95, 0.12), rootB: onForearm(0.07, 0.14), angA: 80, angB: 108, tilt: [0, 0.12], len: [1.5, 1.5, 1.5], white: 1.35, tip: 1.2, lift: 0.04 },
  },
  {
    // 中覆羽：最外层的黑色窄带，根部被肩背的玫瑰粉棕绒毛搭住
    count: 12,
    rootA: [3.12, 0.2, 0.12],
    rootB: [3.08, -1.15, 0.12],
    dirA: [0.03, -0.19, -0.98],
    dirB: [0.03, -0.21, -0.977],
    nrmA: [0.99, 0.02, 0.03],
    nrmB: [0.99, 0.02, 0.03],
    lenA: 0.44,
    lenB: 0.4,
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
    kind: FEATHER_KIND.covert,
    spread: { rootA: onForearm(0.9, 0.34), rootB: onHumerus(0.3, 0.4), angA: 72, angB: 104, tilt: [0, 0.12], len: [1.5, 1.5, 1.5], white: 2.0, tip: 1.2, lift: 0.05 },
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
 * 翅根枢轴（鸟局部坐标，右翅；左翅镜像）= 真实的肩关节：在翅膀最前端、埋在胸肩绒毛窝的里侧。
 * 对照斜前真鸟照：收拢翅的腕弯前角就在眼睛 / 脸颊后下方（z ≈ +0.2），枢轴跟着前移到腮下的前胸窝（z +0.12），
 * 横向随加宽后的体表外移（体表在 (y 2.72, z 0.12) 处半宽 1.26，枢轴在皮层里侧 0.4）；满展态的骨骼链
 * 和各排羽根都挂在枢轴坐标系里，枢轴一动整只展翅跟着走，左右镜像对称不变。
 * 弹翅时腕肩前部始终埋在绒毛里不动，只有中后段翼面和翅尖绕它往背上方扬起，
 * 前缘不会像掀车门一样翻出体外戳出黑尖刺。
 * 高度略低于肩背顶（2.72）：枢轴越靠上，翅前端（在枢轴下方外侧）抬得越多，俯视弹翅峰值时
 * 会从肩毛里露出一个圆钝小头；压低后前端基本只往里钻，露出来的更少。
 */
export const WING_PIVOT = new Vector3(0.85, 2.72, 0.12);

// ---------------------------------------------------------------------------------------------
// 满展布局：三段式翅骨骼链 肩 S → 肘 E → 腕 W → 腕掌 M 在"翼平面"里摆开（右翅，翅枢轴坐标系）。
// 翼平面由二面角 δ（略上抬）和后掠角 σ 决定：eU 沿翼展向外、eV 向前（弦向）、eN 朝背侧。
// 收拢态是 Z 字折在体侧（肱骨朝后、前臂朝前、腕掌朝后），展开态各段落回翼平面：肱骨向外略后、
// 前臂向外略前、腕掌向前偏约 35°——长尾山雀是短圆的百褶羽扇，腕掌前偏多、初级飞羽扇幅宽。
// 每排羽的满展羽根落在所属骨段上（沿段的参数 + 弦向偏移 + 法向叠放高度），羽轴方向按折扇角给出，
// 再换算成"收拢态羽片标架 → 展开态标架"的绕羽根旋转（见 feathers.ts 的 FeatherRig）。
// 展开态是按真鸟展翅照片直接摆的静态姿态；open 在收拢 / 满展之间按羽片连续插值，中间过程
// 就是百褶羽扇顺着骨骼链张开的样子。
// ---------------------------------------------------------------------------------------------
const DEG = Math.PI / 180;
/** 翼平面：二面角 20°（展开时略上抬）、后掠 7°。 */
const WING_DIHEDRAL = 20 * DEG;
const WING_SWEEP = 7 * DEG;
const cosD = Math.cos(WING_DIHEDRAL);
const sinS = Math.sin(WING_SWEEP);
const cosS = Math.cos(WING_SWEEP);
/** 翼展方向（向外） */
const SPAN_U = new Vector3(cosD * cosS, Math.sin(WING_DIHEDRAL), -cosD * sinS);
/** 弦向（向前） */
const CHORD_V = new Vector3(sinS, 0, cosS);
/** 翼平面背侧法线 */
const DORSAL_N = new Vector3().crossVectors(CHORD_V, SPAN_U);

/** 翼平面里的点 (u 向外, v 向前, n 朝背侧) → 枢轴坐标。 */
function wingPlane(u: number, v: number, n = 0): Vector3 {
  return new Vector3().addScaledVector(SPAN_U, u).addScaledVector(CHORD_V, v).addScaledVector(DORSAL_N, n);
}

/** 翼平面里的方向：从 +u 向后（−v）转 ang（弧度）。 */
function wingDir(ang: number): Vector3 {
  return new Vector3().addScaledVector(SPAN_U, Math.cos(ang)).addScaledVector(CHORD_V, -Math.sin(ang));
}

/**
 * 一只翅膀的展翅 uniform：羽片材质、翼内底壳材质、阴影深度材质共用这同一份。
 * 变形全在顶点着色器里按绑定数据算，这里只负责 open 本身。
 */
export class WingRig {
  readonly uniforms: WingRigUniforms = { uOpen: { value: 0 } };

  constructor(readonly side: 1 | -1) {}

  set(open: number): void {
    this.uniforms.uOpen.value = clamp(open, 0, 1);
  }
}

/** 翼内底壳肩段的展开旋转：和肱骨段一样，把贴在体侧、朝后的那片壳转到翼平面里朝外。 */
const PANEL_ROT = frameRotation(
  new Vector3(0, -0.15, -1).normalize(),
  new Vector3(0.94, 0.33, 0.05),
  wingDir(0),
  DORSAL_N.clone(),
);
/** 满展时底壳整体往后挪一点、略微抬离翼平面：前缘和覆羽根对齐，不伸出翅的前缘。 */
const PANEL_SHIFT = wingPlane(0, -0.08, 0.02);

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

/** 一片放好的羽毛：羽根、方向、法线、长度、规格，以及侧面投影和展翅绑定数据。 */
interface PlacedFeather {
  root: Vector3;
  dir: Vector3;
  nrm: Vector3;
  spec: FeatherSpec;
  placement: Placement;
  kind: number;
  /** 满展态（右翅枢轴坐标）：羽根、羽轴方向、羽长缩放、白翈宽度缩放、羽尖放宽 */
  spread: { root: Vector3; dir: Vector3; lenScale: number; whiteScale: number; tipFull: number };
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
        spread: {
          root: wingPlane(lerp(row.spread.rootA[0], row.spread.rootB[0], f), lerp(row.spread.rootA[1], row.spread.rootB[1], f), row.spread.lift),
          dir: wingDir(lerp(row.spread.angA, row.spread.angB, f) * DEG).addScaledVector(UP, lerp(row.spread.tilt[0], row.spread.tilt[1], f)).normalize(),
          // 沿羽长缩放给三点，中间按二次插值
          lenScale: quad(row.spread.len[0], row.spread.len[1], row.spread.len[2], f),
          whiteScale: row.spread.white,
          tipFull: row.spread.tip,
        },
        kind: row.kind,
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
 * 翅膀（默认收拢态）：几何在鸟局部坐标里，所有顶点都已减去枢轴，便于绕枢轴做整翅的抬落/扫转。
 * 每片羽顺着体表弯曲贴合（见 FeatherBatch.conformToBody），并带上展翅绑定：收拢态羽根、
 * 收拢 → 满展的绕羽根旋转和平移——顶点着色器按 uOpen 插值；open = 0 时逐顶点恒等，就是这里的收拢态。
 */
export function buildWing(p: BodyParams, seed = 5, side: 1 | -1 = 1): FeatherSet {
  const batch = new FeatherBatch();
  const feathers = placeWingFeathers(p, seed);
  for (const f of feathers) {
    const m = featherMatrix(f.root, f.dir, f.nrm);
    // 收拢态羽片标架 → 满展态标架（羽轴沿折扇方向、羽面贴着翼平面朝上）
    const rot = frameRotation(f.dir, f.nrm, f.spread.dir, DORSAL_N);
    const root = new Vector3(f.root.x - WING_PIVOT.x, f.root.y - WING_PIVOT.y, f.root.z - WING_PIVOT.z);
    const rig: FeatherRig = {
      kind: f.kind,
      // 几何减过枢轴、左翅按 x 镜像，绑定数据也要进同一个坐标系：镜像共轭一个旋转 = 轴镜像、角度取反
      // （S·R(a, θ)·S = R(S·a, −θ)，右手系翻转了）
      root: new Vector3(side * root.x, root.y, root.z),
      axis: new Vector3(side * rot.axis.x, rot.axis.y, rot.axis.z),
      angle: side * rot.angle,
      trans: new Vector3(side * (f.spread.root.x - root.x), f.spread.root.y - root.y, f.spread.root.z - root.z),
      lenScale: f.spread.lenScale,
      whiteScale: f.spread.whiteScale,
      tipFull: f.spread.tipFull,
      weight: 1,
    };
    batch.add(f.spec, side === 1 ? m : mirrorMatrix(m), rig);
  }
  batch.conformToBody((y, z) => surfaceHalfWidth(p, y, z));

  const geometry = batch.build();
  geometry.translate(-side * WING_PIVOT.x, -WING_PIVOT.y, -WING_PIVOT.z);
  // aMisc.x（未贴体的 x）是鸟局部坐标，BufferGeometry.translate 只动 position：这里同步减掉枢轴，
  // 它才和 position、aRigA.xyz 在同一个翅枢轴坐标系里——否则一展翅每个顶点先往外瞬移 0.75 cm 再绕羽根转，
  // 各排羽会浮在翼平面上方彼此分开
  const misc = geometry.attributes.aMisc as BufferAttribute;
  for (let i = 0; i < misc.count; i++) misc.setX(i, misc.getX(i) - side * WING_PIVOT.x);
  misc.needsUpdate = true;
  return { geometry, count: batch.count, placements: feathers.map((f) => f.placement) };
}

/** 翼面覆盖距离场的采样范围与步长（鸟局部坐标，右半身）。 */
const PANEL_Z0 = 0.6;
const PANEL_Z1 = -3.5;
const PANEL_Y0 = 1.7;
const PANEL_Y1 = 3.45;
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
  // 可展翅：只有肩段（枢轴后方 0.6 cm 以内）跟着肱骨走，更靠后的部分不跟、展翅时在材质里彻底渐隐（不留白带）
  const bones: number[] = [];
  const chord: number[] = [];
  const vid = new Int32Array(nz * ny).fill(-1);
  const g = [0, 0, 0];
  for (let i = 0; i < nz; i++) {
    const z = PANEL_Z0 - i * cell;
    for (let j = 0; j < ny; j++) {
      if (!keep(i, j)) continue;
      const y = PANEL_Y0 + j * cell;
      const x = surfaceHalfWidth(p, y, z) + 0.045;
      vid[i * ny + j] = pos.length / 3;
      pos.push(side * x, y, z);
      bodyGradient(side * x, y, z, p, g);
      const gl = Math.hypot(g[0], g[1], g[2]) || 1;
      nrm.push((side * g[0]) / gl, g[1] / gl, g[2] / gl);
      alp.push(alpha(dist[i * ny + j]));
      bones.push(0.9 * smooth(-1.25, -0.6, z - WING_PIVOT.z));
      // 底壳的"羽轴"取竖直方向：满展时沿这个方向把弦长压到 0.55，前缘才不会伸出翅的前缘
      chord.push(0, -1, 0);
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
  geometry.setAttribute('aAxis', new Float32BufferAttribute(chord, 3));
  // 绕枢轴（肩）转肱骨段的那个旋转，羽根在原点；弦长（沿竖直方向）满展时压到 0.45，整体后移一点
  const nv = pos.length / 3;
  const rigA = new Float32Array(nv * 4);
  const rigB = new Float32Array(nv * 4);
  const rigC = new Float32Array(nv * 4);
  const misc = new Float32Array(nv * 4);
  for (let i = 0; i < nv; i++) {
    rigA[i * 4 + 3] = bones[i];
    rigB.set([side * PANEL_SHIFT.x, PANEL_SHIFT.y, PANEL_SHIFT.z, 0.45], i * 4);
    rigC.set([side * PANEL_ROT.axis.x, PANEL_ROT.axis.y, PANEL_ROT.axis.z, side * PANEL_ROT.angle], i * 4);
    // 未贴体的 x 就用自己的 x（底壳不释放压弯）
    misc[i * 4] = pos[i * 3] - side * WING_PIVOT.x;
    misc[i * 4 + 1] = 1;
  }
  geometry.setAttribute('aRigA', new BufferAttribute(rigA, 4));
  geometry.setAttribute('aRigB', new BufferAttribute(rigB, 4));
  geometry.setAttribute('aRigC', new BufferAttribute(rigC, 4));
  geometry.setAttribute('aMisc', new BufferAttribute(misc, 4));
  geometry.setIndex(idx);
  geometry.translate(-side * WING_PIVOT.x, -WING_PIVOT.y, -WING_PIVOT.z);
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * 翼面底板的材质：收拢时翼上是和正羽一样的哑光深色（不抢羽片的层次）；展翅后翼下露出纯白的翅下覆羽 /
 * 前翼膜底色，和胸腹绒毛连成一片。aDist 是已经算好的边缘渐隐系数，枢轴后方 1.5~2.2 cm 以外的部分随展翅度渐隐。
 */
export function makeWingPanelMaterial(lighting: LightingUniforms, rig: WingRigUniforms): ShaderMaterial {
  const uniforms: Record<string, IUniform> = {
    uPanelCol: { value: BLACK.clone().multiplyScalar(0.92) },
    uPanelVent: { value: rgb('#ebe6de') },
  };
  return makeLitMaterial({
    lighting,
    side: DoubleSide,
    alphaToCoverage: true,
    uniforms: { ...uniforms, uOpen: rig.uOpen },
    vertexPars: /* glsl */ `
${WING_SKIN_PARS}
attribute float aDist;
attribute vec3 aAxis;
varying float vFade;
varying vec3 vPanelP;
`,
    vertexMain: /* glsl */ `
	vPanelP = pos;
	vFade = aDist * ( 1.0 - uOpen * smoothstep( 0.8, 1.3, -pos.z ) );
	vec3 axis = aAxis;
	vec3 nOut;
	pos = wingSkinPoint( pos, nrm, axis, nOut );
	nrm = nOut;
`,
    fragmentPars: /* glsl */ `
uniform vec3 uPanelCol;
uniform vec3 uPanelVent;
uniform float uOpen;
varying float vFade;
varying vec3 vPanelP;
`,
    surface: /* glsl */ `
	Surf s;
	// 翼下覆羽：顺着翅长的细绒纹，和胸腹白绒同色
	float grain = snoise( vec3( vPanelP.y * 9.0, vPanelP.z * 40.0, 11.0 ) ) * 0.5 + 0.5;
	if ( gl_FrontFacing ) {
		// 翼上：和覆羽一样的深炭黑褐，带顺着翅长的人字形羽小枝细纹（细节小于像素时淡出），不是一块光板
		float phase = ( -vPanelP.z - 1.15 * abs( vPanelP.y ) ) * 62.0;
		float atten = 1.0 - smoothstep( 0.1, 0.35, fwidth( phase ) );
		s.albedo = uPanelCol * ( 0.9 + 0.16 * ( 0.5 + 0.5 * sin( phase * 6.2831853 ) ) * atten );
	} else {
		// 翼下覆羽：顺着翅长的细绒纹，和胸腹白绒同色
		s.albedo = uPanelVent * ( 0.95 + 0.07 * grain );
	}
	s.ao = 1.0;
	s.wrap = 0.4;
	s.specTint = vec3( 1.0 );
	s.gloss = 0.4;
	s.specAmt = 0.04;
	// 展开后翼上那面的前缘渐隐成毛边（收拢态不变）：覆羽根接住它，不是一块硬边的黑板
	float lead = -0.45 * vPanelP.y - 0.08;
	s.alpha = vFade * ( gl_FrontFacing ? 1.0 - uOpen * smoothstep( 0.18, 0.46, lead ) : 1.0 );
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
