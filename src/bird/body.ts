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
import { clamp, smoothstep } from '../util/math';

/**
 * 把躯体距离场变成网格，并给每个顶点算出绒毛着色器需要的一切：
 * 区域权重（配色）、毛流方向（顺毛/理毛的朝向）、绒毛长度系数、骨骼权重。
 */
export interface BodyAttributes {
  geometry: BufferGeometry;
  triangleCount: number;
}

/** 口角暗线：从嘴角出发向后下方伸进绒毛里的那一小段（右半身，左半身镜像）。 */
const GAPE_A: [number, number, number] = [0.15, 3.55, 1.545];
const GAPE_B: [number, number, number] = [0.31, 3.47, 1.48];
const GAPE_D = [GAPE_B[0] - GAPE_A[0], GAPE_B[1] - GAPE_A[1], GAPE_B[2] - GAPE_A[2]];
const GAPE_LEN2 = GAPE_D[0] ** 2 + GAPE_D[1] ** 2 + GAPE_D[2] ** 2;

export function buildBody(params: BodyParams = LONG_TAILED_TIT, cell = 0.055): BodyAttributes {
  const { min, max } = params.bounds;
  const t0 = performance.now();
  const net = surfaceNets((x, y, z) => bodySDF(x, y, z, params), min, max, cell);
  const count = net.positions.length / 3;

  const normals = new Float32Array(count * 3);
  const flow = new Float32Array(count * 3);
  const region = new Float32Array(count * 4);
  const weights = new Float32Array(count * 2);
  const param = new Float32Array(count * 3);

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
    // 背上短一截，从后颈往头顶逐渐放长，颈背交界处不留一道棱
    furLen -= 0.16 * smoothstep(0.0, 0.6, ny) * (1 - smoothstep(2.75, 3.4, y)) * (1 - smoothstep(-0.3, 0.3, z));
    // 眼周只在眼睑壳那一圈压秃：下眼圈露出一线眼睑壳，眉弓的白绒则直接压到上睑缘；
    // 往外渐次放长，贴着眼圈的毛是短的，不会立成一圈睫毛
    const eyeCy = params.head.c[1] + params.eyeDir[1] * params.eyeOffset;
    const brow = smoothstep(-0.06 * er, 0.44 * er, y - eyeCy);
    const lidR = er * (0.65 - 0.2 * brow);
    furLen *= 1 - 0.95 * (1 - smoothstep(lidR, lidR + er * 0.6, eyeD));
    // 嘴根附近绒毛略短；喙壳底下的体表彻底压住，毛尖不会从黑喙里钻出来
    const beakD = Math.hypot(x - bx, y - by, z - bz);
    furLen *= 0.55 + 0.45 * smoothstep(0.15, 0.45, beakD);
    const bUp = (y - by) * upy + (z - bz) * upz;
    furLen *= smoothstep(0.95, 1.2, Math.hypot(x / 0.15, (bUp - 0.03) / 0.12));
    // 口腔：张嘴时从上下颌之间露出来的体表（颌根截面以内，含嘴根前方鼓出来的那一段）不长毛，着色器再把它染成深暗的口腔色。
    // 范围与 plumage.ts 的口腔色一致：合拢时这一块全被上下颌盖住
    const bAl = (y - by) * bdy + (z - bz) * bdz;
    const mouth =
      (1 - smoothstep(0.1, 0.135, Math.abs(x))) *
      (1 - smoothstep(0.09, 0.12, bUp)) *
      smoothstep(-0.05, -0.02, bUp) *
      (1 - smoothstep(0.14, 0.2, bAl));
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
    // 收拢的翅贴在两胁：翅底下的体表绒毛只压成柔和的短绒（约 0.14），不剃秃——收拢翅的包络面就放在这层短绒
    // 外侧一点点，抬翅时露出来的是自然的粉白胁下绒毛，不会出现一块灰疤。
    // 上缘留出过渡，让肩背的玫瑰粉棕绒羽自然垂搭在中覆羽根部上；前缘斜着切（上面从 z≈0 起、下面收到 z≈-0.7），
    // 让胸侧和两胁前下方的饱满白绒向后上方蓬起，盖住翅的前弯和下前缘
    const yTop = z >= -1.5 ? 3.2 + 0.1 * z : 3.05 + 0.08 * (z + 1.5);
    const yBot = z >= -2.6 ? 2.17 + 0.1 * z : 1.91 + 0.27 * (-2.6 - z);
    const zFront = -0.7 * (3.1 - y);
    const panel =
      smoothstep(0.35, 0.6, Math.abs(nx)) *
      smoothstep(yBot - 0.1, yBot + 0.08, y) *
      (1 - smoothstep(yTop - 0.08, yTop + 0.14, y)) *
      (1 - smoothstep(zFront - 0.15, zFront + 0.25, z)) *
      smoothstep(-3.6, -3.2, z);
    furLen = furLen * (1 - panel) + 0.14 * panel;
    // 腹底靠近腿的位置也短一些
    furLen *= 0.7 + 0.3 * smoothstep(0.35, 0.7, y);

    // ---- 骨骼权重：头、颈两根骨骼，其余归身体 ----
    const dh = nd[0];
    const wHeadBone = 1 - smoothstep(1.0, 1.42, dh);
    const wNeckBone =
      (1 - wHeadBone) * smoothstep(0.95, 1.2, dh) * (1 - smoothstep(1.35, 1.95, dh));
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
