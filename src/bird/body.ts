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
    fl = Math.hypot(fx, fy, fz) || 1;
    flow.set([fx / fl, fy / fl, fz / fl], i * 3);

    // ---- 绒毛长度系数 ----
    // 脸颊和喉部最蓬，背部较短，翅上区域让位给正羽
    let furLen =
      1.0 + 0.12 * wHead * (1 - smoothstep(0.35, 0.8, ny)) + 0.06 * wChest - 0.16 * wBack * smoothstep(0.0, 0.6, ny);
    const s = x >= 0 ? 1 : -1;
    const eyeD = eyeAxisDist(x, y, z, params, s);
    const eyeMask = 1 - smoothstep(params.eyePatch * 0.78, params.eyePatch * 1.1, eyeD);
    furLen *= 1 - 0.97 * eyeMask;
    const beakD = Math.hypot(x - bx, y - by, z - bz);
    furLen *= 0.55 + 0.45 * smoothstep(0.15, 0.45, beakD);
    // 翅膀覆盖区（两胁中后段）；肩部一带的绒毛留长一点，让它自然漫过肩羽的根部
    const wingMask =
      smoothstep(0.8, 1.05, Math.abs(x)) *
      smoothstep(1.95, 2.25, y) *
      (1 - smoothstep(3.0, 3.3, y)) *
      (1 - smoothstep(0.1, 0.5, z)) *
      (1 - smoothstep(-2.6, -2.2, z));
    const shoulder = smoothstep(2.65, 3.0, y);
    furLen = furLen * (1 - wingMask) + (0.4 + 0.35 * shoulder) * wingMask;
    // 腹底靠近腿的位置也短一些
    furLen *= 0.7 + 0.3 * smoothstep(0.35, 0.7, y);

    // ---- 骨骼权重：头、颈两根骨骼，其余归身体 ----
    const dh = nd[0];
    const wHeadBone = 1 - smoothstep(1.0, 1.42, dh);
    const wNeckBone =
      (1 - wHeadBone) * smoothstep(0.95, 1.2, dh) * (1 - smoothstep(1.35, 1.95, dh));
    weights.set([wNeckBone, wHeadBone], i * 2);

    // 眼周裸区传给着色器，用来画深色皮肤
    param.set([furLen, fract(Math.sin(i * 12.9898) * 43758.5453), eyeMask], i * 3);
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
