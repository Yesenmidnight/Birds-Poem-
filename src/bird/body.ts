import { BufferAttribute, BufferGeometry } from 'three';
import {
  LONG_TAILED_TIT,
  bodyGradient,
  bodySDF,
  ellipsoidNormDist,
  eyeAxisDist,
  type BodyParams,
} from './bodySdf';
import { surfaceNets } from './surfaceNets';
import { wingCoverField, wingPlacements } from './wingTail';
import { BEAK_DROOP, BEAK_HINGE_DEPTH, BEAK_NOTCH, BEAK_REF_LEN, beakHalfWidth, beakLowerHeight, beakUpperHeight } from './beakProfile';
import { clamp, lerp, smoothstep } from '../util/math';

/**
 * 翅前缘 / 上缘处压毛的起点（cm，负值 = 从覆盖边缘往外这么多就开始压）。
 * 上缘（WING_FUR_INSET_TOP = 0）：翅边以外（肩背）的毛全长，顺毛流垂搭盖住覆羽 / 飞羽的上沿羽根——把翅边外的
 * 肩毛压短会把次级飞羽和覆羽顶部生硬的黑锯齿整条露出来成一道黑断崖；翅边底下的过渡带只有 0.015 宽。
 * 前缘（WING_FUR_INSET = -0.08）：胸侧的毛从翅边以外 0.08 就渐短——腕弯前角是收拢翅唯一从正面 / 斜前露出来的
 * 黑弧，胸毛全长倒过来会把它整个盖住；0.08 以外的胸毛仍是全长，毛尖自然搭在翅前角上，黑弧从毛窝里露出来
 */
const WING_FUR_INSET = -0.08;
const WING_FUR_INSET_TOP = 0;
/** 翅下缘、翅尖以外仍保持短绒的距离（cm，负值 = 从覆盖边缘往外再压这么多）：翅的下缘和尖才干净。 */
const WING_FUR_UNDER = -0.1;
/** 翼下短绒相对全长毛长的系数。压短的毛尖（约 0.03~0.08）必须低于羽片的离面高度（0.06~0.09）才不会穿出羽片。 */
const WING_FUR_PRESS = 0.11;

/**
 * 把躯体距离场变成网格，并给每个顶点算出绒毛着色器需要的一切：
 * 区域权重（配色）、毛流方向（顺毛/理毛的朝向）、绒毛长度系数、骨骼权重。
 */
export interface BodyAttributes {
  geometry: BufferGeometry;
  triangleCount: number;
}

export function buildBody(params: BodyParams = LONG_TAILED_TIT, cell = 0.055): BodyAttributes {
  const { min, max } = params.bounds;
  const t0 = performance.now();
  const net = surfaceNets((x, y, z) => bodySDF(x, y, z, params), min, max, cell);
  const count = net.positions.length / 3;
  // 翼下压毛的覆盖范围：收拢翅羽片的真实投影（随机种子和 Bird 建翅用的一致）
  const wingCover = wingCoverField(wingPlacements(params));
  // 喙：铰链（params.beakBase，前脸皮层正下方）、喙轴、喙的"上方"，以及剖面原点 = 铰链沿喙轴后退 BEAK_HINGE_DEPTH
  // （原来 M1 的嘴根，埋在脸皮下）。头部的毛流从原点向后倒、口角线从原点量起、嘴根附近的毛长按到原点的距离算：
  // 这三样跟着原点走，铰链前移不会改变脸部绒毛的样子
  const [bx, by, bz] = params.beakBase;
  const bl = Math.hypot(...params.beakDir);
  const bdx = params.beakDir[0] / bl;
  const bdy = params.beakDir[1] / bl;
  const bdz = params.beakDir[2] / bl;
  // 喙的"上方"：喙轴（在 yz 平面里）与 x 轴的叉积
  const upl = Math.hypot(bdz, bdy);
  const upy = bdz / upl;
  const upz = -bdy / upl;
  const ox = bx - bdx * BEAK_HINGE_DEPTH;
  const oy = by - bdy * BEAK_HINGE_DEPTH;
  const oz = bz - bdz * BEAK_HINGE_DEPTH;
  // 口角暗线：从嘴角出发向后下方伸进绒毛里的那一小段（右半身，左半身镜像），相对剖面原点定位，头移动时跟着走
  const GAPE_A: [number, number, number] = [ox + 0.15, oy - 0.01, oz + 0.105];
  const GAPE_B: [number, number, number] = [ox + 0.31, oy - 0.09, oz + 0.04];
  const GAPE_D = [GAPE_B[0] - GAPE_A[0], GAPE_B[1] - GAPE_A[1], GAPE_B[2] - GAPE_A[2]];
  const GAPE_LEN2 = GAPE_D[0] ** 2 + GAPE_D[1] ** 2 + GAPE_D[2] ** 2;

  const normals = new Float32Array(count * 3);
  const flow = new Float32Array(count * 3);
  const region = new Float32Array(count * 4);
  const weights = new Float32Array(count * 2);
  const param = new Float32Array(count * 3);
  const press = new Float32Array(count);
  const jaw = new Float32Array(count);

  const g = [0, 0, 0];

  for (let i = 0; i < count; i++) {
    const x = net.positions[i * 3];
    const y = net.positions[i * 3 + 1];
    const z = net.positions[i * 3 + 2];

    bodyGradient(x, y, z, params, g);
    const gl = Math.hypot(g[0], g[1], g[2]) || 1;
    const nx = g[0] / gl;
    const ny = g[1] / gl;
    const nz = g[2] / gl;
    normals.set([nx, ny, nz], i * 3);

    // ---- 区域权重：离哪颗椭球最近就归谁，边界平滑过渡 ----
    const parts = [params.head, params.neck, params.chest, params.belly, params.back, params.rump];
    const nd = parts.map((e) => ellipsoidNormDist(x, y, z, e));
    let best = Infinity;
    for (const d of nd) best = Math.min(best, d);
    let sum = 0;
    const w = nd.map((d) => {
      const v = Math.exp(-(d - best) / 0.09);
      sum += v;
      return v;
    });
    // 颈部并入头部，臀部为其余部分
    const wHead = (w[0] + w[1]) / sum;
    const wChest = w[2] / sum;
    const wBelly = w[3] / sum;
    const wBack = (w[4] / sum) + w[5] / sum;
    region.set([wHead, wChest, wBelly, wBack], i * 4);

    // ---- 毛流：头上的羽毛从喙根向后倒，身上的向后向下顺 ----
    let fx = x - ox;
    let fy = y - oy;
    let fz = z - oz;
    let dot = fx * nx + fy * ny + fz * nz;
    fx -= nx * dot;
    fy -= ny * dot;
    fz -= nz * dot;
    let fl = Math.hypot(fx, fy, fz) || 1;
    const hx = fx / fl;
    const hy = fy / fl;
    const hz = fz / fl;

    // 身体基准方向：向后并略向下；腹部更偏下，尾部更偏后
    const low = clamp(-ny, 0, 1);
    let tx = 0.08 * Math.sign(x) * Math.abs(nx);
    let ty = -0.32 - 0.5 * low * (1 - Math.abs(ny));
    let tz = -1.0;
    // 肩羽（黑领后方到背中短尖之间的背上部两侧）的毛流略向后内侧倒：焦糖肉桂→奶白的肩羽顺着毛流向背中央汇成 V 字
    const scapZone = smoothstep(-0.4, -0.7, z) * (1 - smoothstep(-1.4, -1.7, z)) * smoothstep(2.75, 2.95, y);
    // 体型横向加宽后肩顶在 |x| ≈ 1.0~1.2：肩羽区的横向范围跟着外移
    const scapTilt = scapZone * smoothstep(0.2, 0.6, Math.abs(x)) * (1 - smoothstep(0.85, 1.15, Math.abs(x)));
    // 翅上缘外侧 0.3 cm 以内（还没压毛）的肩背长毛向下、向外侧倒，毛尖漫过收拢翅的上缘把它搭住——
    // 只有翅边以外长出来的毛才会平躺着盖在翅上；翅边底下压短的毛绝不能穿出来（穿出来是一根根立着的白点）
    const wingCoverHere = wingCover.sample(y, z);
    // 垂搭区间比肩羽区更长：整条翅上缘（从腮下的翅前角 z +0.2 到臀部）以外 0.3 cm 内的长毛都向下外侧倒，盖住羽根上沿
    const drapeZone = (1 - smoothstep(0.1, 0.3, z)) * (1 - smoothstep(-2.0, -2.4, z)) * smoothstep(2.7, 2.95, y);
    const drapeTilt = drapeZone * smoothstep(0.25, 0.55, ny) * smoothstep(-0.3, -0.08, wingCoverHere) * (1 - smoothstep(0.0, 0.04, wingCoverHere));
    tx = tx * (1 - scapTilt) - 0.22 * Math.sign(x) * scapTilt + 0.3 * Math.sign(x) * drapeTilt;
    ty -= 0.35 * drapeTilt;
    dot = tx * nx + ty * ny + tz * nz;
    tx -= nx * dot;
    ty -= ny * dot;
    tz -= nz * dot;
    fl = Math.hypot(tx, ty, tz) || 1;
    tx /= fl;
    ty /= fl;
    tz /= fl;

    const k = smoothstep(0.45, 0.9, wHead);
    fx = tx + (hx - tx) * k;
    fy = ty + (hy - ty) * k;
    fz = tz + (hz - tz) * k;

    // ---- 绒毛长度系数 ----
    const s = x >= 0 ? 1 : -1;
    const er = params.eyeRadius;
    const eyeD = eyeAxisDist(x, y, z, params, s);
    // 眼圈：眼周的毛从眼中轴向外辐射（真实鸟类的眼圈羽区就是这样），离眼越近越是如此。
    // 不这样的话，从嘴根往后的毛流会横着扫过眼面，正面斜看时远侧那只眼被自己的毛丝划成一道道灰纹
    {
      const ex = x - s * params.eyeDir[0] * params.eyeOffset - params.head.c[0];
      const ey = y - params.eyeDir[1] * params.eyeOffset - params.head.c[1];
      const ez = z - params.eyeDir[2] * params.eyeOffset - params.head.c[2];
      dot = ex * nx + ey * ny + ez * nz;
      const rx = ex - nx * dot;
      const ry = ey - ny * dot;
      const rz = ez - nz * dot;
      const rl = Math.hypot(rx, ry, rz);
      if (rl > 1e-4) {
        const wRing = 0.85 * (1 - smoothstep(er * 1.0, er * 2.3, eyeD));
        fx += (rx / rl - fx) * wRing;
        fy += (ry / rl - fy) * wRing;
        fz += (rz / rl - fz) * wRing;
      }
    }
    fl = Math.hypot(fx, fy, fz) || 1;
    flow.set([fx / fl, fy / fl, fz / fl], i * 3);

    // 脸颊和喉部最蓬，背上较短
    let furLen = 1.0 + 0.12 * wHead * (1 - smoothstep(0.35, 0.8, ny)) + 0.06 * wChest;
    // 背上短一截，从后颈往头顶逐渐放长，颈背交界处不留一道棱（高度跟随头部椭球：后枕在 head.c 下方 0.4~0.9）
    const neckY = params.head.c[1] - 0.9;
    furLen -= 0.16 * smoothstep(0.0, 0.6, ny) * (1 - smoothstep(neckY, neckY + 0.65, y)) * (1 - smoothstep(-0.3, 0.3, z));
    // 眼周只在紧贴睑裂的那一圈压秃，毛从睑缘外一点点就放长：露出来的眼睑壳只剩一线深色细睑缘，
    // 壳外沿整圈埋进眼周白绒毛底下，微距下不会看到一圈光滑的白色实心环；
    // 压秃半径仍略大于睑缘（上 0.52r、下 0.5r），贴着眼圈的毛不会立成一圈睫毛
    const eyeCy = params.head.c[1] + params.eyeDir[1] * params.eyeOffset;
    const brow = smoothstep(-0.06 * er, 0.44 * er, y - eyeCy);
    const lidR = er * (0.55 - 0.05 * brow);
    furLen *= 1 - 0.95 * (1 - smoothstep(lidR, lidR + er * 0.45, eyeD));
    // 嘴根压毛严格按合拢颌壳的真实剖面（beakProfile，和 parts.ts 的放样同一组公式；坐标原点在铰链）：
    // edge = 到颌壳边缘的近似距离（负 = 壳内）。原来按 0.15~0.18 的固定椭圆剃秃，比出肉处 0.11 的喙壳大一圈，
    // 黑喙四周露出一圈棱角分明的体素白边。现在：
    //   壳内深处留 0.2 的短绒（张嘴时颌根之间露出的那一丝体表是带绒的口腔底，不是光板多边形）；
    //   紧贴壳边 0.08 内压到底——毛沿法线往外长，壳边附近的毛再短也会穿出黑喙侧面，在下颌上洒一层白点；
    //   壳边以外 0.02 内升到 0.45 的细短白绒搭在喙根上，往外的放长速度分下巴 / 两侧两套（见下）。
    // 颌壳只在剖面原点前方存在：原点后方没有壳，压毛系数必须是 1.0（不是 0！）——之前把 bAl 下限乘进 shellIn，
    // 原点后方 0.2 × 0 = 0，加上喙脊下弯的抛物线往下拽，足迹会顺着喉部中线一路剃秃。
    // 口腔本体做在喙模型里（parts.ts 的嘴缝面 + 口腔侧壁 + 小舌），不再靠剃秃体表网格来充当口腔
    const bAl = (y - by) * bdy + (z - bz) * bdz;
    const dTip = (1 - bAl / params.beakLength) * params.beakLength;
    // 喙脊下弯把截面中心压低，bUp 要相对截面中心量
    const tRoot = BEAK_REF_LEN - dTip;
    const bUp = (y - by) * upy + (z - bz) * upz + (BEAK_DROOP * tRoot * tRoot) / BEAK_REF_LEN;
    const wB = beakHalfWidth(dTip);
    const hB = bUp > 0 ? beakUpperHeight(dTip) : beakLowerHeight(dTip);
    // 口角凹痕：嘴缝那一圈壳往里收 BEAK_NOTCH
    const rB0 = Math.hypot(x / wB, bUp / hB);
    const notch = 1 - BEAK_NOTCH * Math.exp(-((bUp / hB / (rB0 > 1e-6 ? rB0 : 1) / 0.16) ** 2));
    const edge = (rB0 / notch - 1) * Math.min(wB, hB);
    // 原点后方没有颌壳：inLoft = 0 → kOut = 1 → 不压；原点前方按到壳边的距离 edge 分壳内 / 壳外
    const inLoft = smoothstep(-BEAK_HINGE_DEPTH - 0.015, -BEAK_HINGE_DEPTH + 0.005, bAl);
    const kOut = 1 - (1 - smoothstep(0, 0.02, edge)) * inLoft;
    const shellIn = 0.2 * (1 - smoothstep(-0.08, -0.02, edge));
    // 壳外：紧贴壳边 0.45 的细短白绒。两侧和额头按到剖面原点的距离放长（和 M1 一样，毛根沿法线前翘，离喙太长
    // 张嘴时会立满上颌侧面）；下巴离壳边 0.06 就恢复全长——下巴是一面竖直的墙，之前按到原点的距离放长，
    // 半长的毛被一路拖到喉咙，剃出一条光滑沟。张嘴时下颌扫过的区间另由 aJaw 动态压短（见下）
    const beakD = Math.hypot(x - ox, y - oy, z - oz);
    const chin = 1 - smoothstep(-0.08, -0.03, bUp);
    const shellOut = lerp(0.45 + 0.55 * smoothstep(0.2, 0.5, beakD), 0.45 + 0.55 * smoothstep(0.02, 0.06, edge), chin);
    furLen *= lerp(shellIn, shellOut, kOut);
    // 嘴根周围 0.3~0.5 cm 的一圈毛（下巴 + 两侧面颊）：静态不压（合拢时下巴绒毛饱满），张嘴后由 fur.ts 按 uJawOpen
    // 临时压到 0.3——面颊毛根沿法线前翘 0.16，不压的话张开后两瓣颌的后半截都埋在毛尖里洒满白点
    jaw.set([1 - smoothstep(0.3, 0.52, beakD)], i);
    // 口角线上的毛略短，嘴角向后延伸的暗线才读得出来
    {
      const gx = Math.abs(x) - GAPE_A[0];
      const gy = y - GAPE_A[1];
      const gz = z - GAPE_A[2];
      const gt = clamp((gx * GAPE_D[0] + gy * GAPE_D[1] + gz * GAPE_D[2]) / GAPE_LEN2, 0, 1);
      const d = Math.hypot(gx - GAPE_D[0] * gt, gy - GAPE_D[1] * gt, gz - GAPE_D[2] * gt);
      furLen *= 1 - 0.35 * (1 - smoothstep(0.015, 0.045, d));
    }
    // 翼下压毛：严格按收拢翅正羽的真实覆盖范围来（羽片投影 + 距离变换，和翼内底壳同一个场）——
    // 只有真正被黑翅盖住的体表才把毛压成柔和短绒。上缘、前缘：翅边以外全长（肩背 / 胸侧长毛顺着毛流
    // 垂搭盖住羽根上沿），翅边往里 0.015~0.04 内压到底；只有下缘以外 0.1 cm 内仍是短绒，翅的下缘才不被白毛刷边
    const cover = wingCover.sample(y, z);
    const drape = Math.max(smoothstep(-0.1, 0.4, ny), smoothstep(0.3, 0.6, nz));
    let inset = lerp(WING_FUR_UNDER, WING_FUR_INSET, drape);
    // 翅上缘（覆盖区在正下方）和翅前缘（覆盖区在正后方）按覆盖距离场的梯度判，不用表面法线：
    // 肩前方前后后的法线方向变化太大。上缘的过渡带更窄（肩背长毛比胸侧毛长、毛尖更容易穿出羽片）
    const topEdge = smoothstep(0.05, 0.2, wingCover.sample(y - 0.15, z) - wingCover.sample(y + 0.15, z));
    const frontEdge = smoothstep(0.05, 0.2, wingCover.sample(y, z - 0.15) - wingCover.sample(y, z + 0.15));
    inset = lerp(inset, WING_FUR_INSET_TOP, topEdge * (1 - frontEdge));
    // 过渡带 0.04 宽、上缘 0.015：翅边底下立刻压到底，翅边以外紧挨着的毛还是全长——毛到翅边为止，
    // 中间几乎没有半长的毛尖穿出羽片
    const ramp = lerp(0.04, 0.015, topEdge * (1 - frontEdge));
    const panel = smoothstep(0.15, 0.4, Math.abs(nx)) * smoothstep(inset, inset + ramp, cover);
    // 被翅压住之前的毛长单独存进 aPress：翅展开后着色器按展翅度把它放回全长（见 fur.ts 的 uWingOpen）
    press.set([furLen], i);
    furLen = furLen * (1 - panel) + WING_FUR_PRESS * panel;
    // 腹底靠近腿的位置也短一些
    furLen *= 0.7 + 0.3 * smoothstep(0.35, 0.7, y);

    // ---- 骨骼权重：头、颈两根骨骼，其余归身体 ----
    // 按三维部位划分，不能只按高度切：back 椭球顶部高到 y=3.63，只看 y 会把整个上背和双肩判成头骨，
    // 头一转后背就绕前胸的枢轴甩出去、和留在原地的翅膀劈叉（转头归零的静态图看不出来）。
    // 1) 头部椭球在六颗椭球 softmax 里占的份额（温度放宽到 0.3，颈圈过渡带才有足够宽度）：
    //    前脸、眼周睑裂、喙根、脸颊、头顶、后枕的份额都 ≥ 0.4，饱和之后严格是 1.0，
    //    刚体的眼球和上下喙整组跟头骨转，大角度转头也不会滑出眼窝露黑边；份额跌到 0.15 以下是躯干。
    // 2) 颈圈过渡带（份额 0.15~0.42）里颈骨只分担一部分：份额 0.1 以下完全归躯干，上背、双肩、翼根
    //    （份额 ≈ 0.02~0.06）和下胸腹部都是 0，转头时一丝都不动。
    // 3) 后背再加一道 z 门限：z < -0.55 的背部、臀部全部归躯干，后枕到上背之间 z ≈ -0.55~-0.1 柔和渐变——
    //    门限太陡（-0.3~-0.12）大角度转头时后枕会留下一道斜向折痕；翼根、双肩的份额本来就只有 0.02~0.06，放宽门限也不会被带动。
    const sk = nd.map((d) => Math.exp(-(d - best) / 0.3));
    const skSum = sk[0] + sk[1] + sk[2] + sk[3] + sk[4] + sk[5];
    const headShare = sk[0] / skSum;
    const backGate = smoothstep(-0.55, -0.1, z);
    const wHeadBone = smoothstep(0.15, 0.42, headShare) * backGate;
    const wNeckBone = (1 - wHeadBone) * smoothstep(0.1, 0.33, headShare) * backGate;
    weights.set([wNeckBone, wHeadBone], i * 2);

    // aParam：毛长系数、逐顶点随机数、离眼中轴线的距离（着色器据此画眼睑里的深色皮肤）
    param.set([furLen, fract(Math.sin(i * 12.9898) * 43758.5453), eyeD], i * 3);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(net.positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.setAttribute('aFlow', new BufferAttribute(flow, 3));
  geometry.setAttribute('aRegion', new BufferAttribute(region, 4));
  geometry.setAttribute('aW', new BufferAttribute(weights, 2));
  geometry.setAttribute('aParam', new BufferAttribute(param, 3));
  geometry.setAttribute('aPress', new BufferAttribute(press, 1));
  geometry.setAttribute('aJaw', new BufferAttribute(jaw, 1));
  geometry.setIndex(new BufferAttribute(net.indices, 1));
  geometry.computeBoundingSphere();

  const ms = performance.now() - t0;
  console.info(
    `[bird] 躯体网格：${net.cellCount.toLocaleString('en-US')} 个采样单元，` +
      `${count.toLocaleString('en-US')} 顶点，${(net.indices.length / 3).toLocaleString('en-US')} 三角形，耗时 ${ms.toFixed(0)} ms`,
  );

  return { geometry, triangleCount: net.indices.length / 3 };
}

function fract(x: number): number {
  return x - Math.floor(x);
}
