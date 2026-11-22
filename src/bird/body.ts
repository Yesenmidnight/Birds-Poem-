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
import { clamp, lerp, smoothstep } from '../util/math';

/**
 * 翼下压毛范围相对羽片覆盖边缘再往里收的距离（cm）。不能大：覆羽那一排的羽带只有 0.3 cm 宽，
 * 往里收 0.07 等于整排都不压毛，全长绒毛会把覆羽埋成一个个黑圆点。上缘、前缘外一圈的毛靠下面的
 * drape 判定保持全长，漫过翅边把翅包住
 */
const WING_FUR_INSET = 0.02;
/** 翅下缘、翅尖以外仍保持短绒的距离（cm，负值 = 从覆盖边缘往外再压这么多）：翅的下缘和尖才干净。 */
const WING_FUR_UNDER = -0.1;

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
  // 口角暗线：从嘴角出发向后下方伸进绒毛里的那一小段（右半身，左半身镜像），相对嘴根定位，头移动时跟着走
  const GAPE_A: [number, number, number] = [params.beakBase[0] + 0.15, params.beakBase[1] - 0.01, params.beakBase[2] + 0.105];
  const GAPE_B: [number, number, number] = [params.beakBase[0] + 0.31, params.beakBase[1] - 0.09, params.beakBase[2] + 0.04];
  const GAPE_D = [GAPE_B[0] - GAPE_A[0], GAPE_B[1] - GAPE_A[1], GAPE_B[2] - GAPE_A[2]];
  const GAPE_LEN2 = GAPE_D[0] ** 2 + GAPE_D[1] ** 2 + GAPE_D[2] ** 2;

  const normals = new Float32Array(count * 3);
  const flow = new Float32Array(count * 3);
  const region = new Float32Array(count * 4);
  const weights = new Float32Array(count * 2);
  const param = new Float32Array(count * 3);
  const press = new Float32Array(count);

  const g = [0, 0, 0];
  const [bx, by, bz] = params.beakBase;
  const bl = Math.hypot(...params.beakDir);
  const bdy = params.beakDir[1] / bl;
  const bdz = params.beakDir[2] / bl;
  // 喙的“上方”：喙轴（在 yz 平面里）与 x 轴的叉积
  const upl = Math.hypot(bdz, bdy);
  const upy = bdz / upl;
  const upz = -bdy / upl;

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
    let fx = x - bx;
    let fy = y - by;
    let fz = z - bz;
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
    // 嘴根附近绒毛略短；喙壳底下的体表彻底压住，毛尖不会从黑喙里钻出来
    const beakD = Math.hypot(x - bx, y - by, z - bz);
    furLen *= 0.55 + 0.45 * smoothstep(0.15, 0.45, beakD);
    const bUp = (y - by) * upy + (z - bz) * upz;
    // 沿喙轴的坐标：原点在嘴根，向前为正。喙底的压毛和口腔都必须有沿喙轴的下限——这两条圆柱如果只设上限，
    // 就会沿着喙轴一路向后穿过脑壳，从后枕下方的背上钻出来，在鞍背正中剃出一块黑秃坑
    const bAl = (y - by) * bdy + (z - bz) * bdz;
    // 喙壳底下的体表压毛：只在嘴根及其前方（下限 -0.18~-0.05），嘴根后方的脸照常长毛，嘴根不剃秃
    const beakRoot = smoothstep(-0.18, -0.05, bAl);
    furLen *= 1 - (1 - smoothstep(0.95, 1.2, Math.hypot(x / 0.15, (bUp - 0.03) / 0.12))) * beakRoot;
    // 口腔：张嘴时从上下颌之间露出来的体表（颌根截面以内，含嘴根前方鼓出来的那一段）不长毛，着色器再把它染成口腔色。
    // 范围与 plumage.ts 的口腔色一致：合拢时这一块全被上下颌盖住；沿喙轴只到颌根稍后（下限 -0.22~-0.08）
    // 截面必须严格落在上下颌壳的轮廓以内（颌壳基部半宽 0.168、上高 0.15、下高 0.088，往前收细），
    // 稍大一点合拢时嘴根两侧就会露出一线口腔色
    const mouth =
      (1 - smoothstep(0.08, 0.11, Math.abs(x))) *
      (1 - smoothstep(0.07, 0.095, bUp)) *
      smoothstep(-0.03, -0.01, bUp) *
      (1 - smoothstep(0.12, 0.17, bAl)) *
      smoothstep(-0.22, -0.08, bAl);
    furLen *= 1 - mouth;
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
    // 只有真正被黑翅盖在正下方的柳叶心部才把毛压成柔和短绒，再按边缘朝向决定压毛范围从哪里开始：
    // 上缘、前缘以外（肩背、胸侧）的毛全长，漫过翅边把翅包住；下缘以外 0.1 cm 内仍是短绒，
    // 翅的下缘才不会被白毛刷边。过渡带都是 0.15 cm 宽，没有平底凹坑和断崖
    const cover = wingCover.sample(y, z);
    const drape = Math.max(smoothstep(-0.1, 0.4, ny), smoothstep(0.3, 0.6, nz));
    const inset = lerp(WING_FUR_UNDER, WING_FUR_INSET, drape);
    const panel = smoothstep(0.15, 0.4, Math.abs(nx)) * smoothstep(inset, inset + 0.15, cover);
    // 被翅压住之前的毛长单独存进 aPress：翅展开后着色器按展翅度把它放回全长（见 fur.ts 的 uWingOpen）
    press.set([furLen], i);
    furLen = furLen * (1 - panel) + 0.22 * panel;
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
