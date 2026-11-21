/**
 * 北长尾山雀的躯体用“隐式距离场”定义：六颗椭球（头、颈、胸、腹、背、臀）做平滑并集。
 * 这只鸟几乎没有脖子，头是直接“焊”在球形胸腹上的，隐式曲面天然适合这种融为一体的体型；
 * 以后加别的鸟种时，换一组椭球参数就能换身形。
 * 坐标系：原点在两脚之间的枝面，+Z 朝前（喙），+Y 朝上，单位厘米。
 */

export interface Ellipsoid {
  c: [number, number, number];
  r: [number, number, number];
}

export interface BodyParams {
  head: Ellipsoid;
  neck: Ellipsoid;
  chest: Ellipsoid;
  belly: Ellipsoid;
  back: Ellipsoid;
  rump: Ellipsoid;
  /** 平滑并集的过渡宽度。 */
  blend: number;
  /** 眼睛朝向（正值在 +x 一侧，另一侧镜像），单位向量。 */
  eyeDir: [number, number, number];
  eyeRadius: number;
  /** 眼周裸露皮肤（不长羽毛）的半径。 */
  eyePatch: number;
  beakBase: [number, number, number];
  beakDir: [number, number, number];
  beakLength: number;
  tailBase: [number, number, number];
  tailDir: [number, number, number];
  bounds: { min: [number, number, number]; max: [number, number, number] };
}

const v = (x: number, y: number, z: number): [number, number, number] => {
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
};

export const LONG_TAILED_TIT: BodyParams = {
  head: { c: [0, 3.62, 0.72], r: [0.78, 0.8, 0.84] },
  neck: { c: [0, 2.9, 0.5], r: [0.6, 0.68, 0.64] },
  chest: { c: [0, 2.43, 0.82], r: [0.88, 0.95, 0.88] },
  belly: { c: [0, 1.83, -0.5], r: [1.28, 1.5, 2.0] },
  back: { c: [0, 2.58, -1.0], r: [1.1, 1.05, 1.5] },
  rump: { c: [0, 2.18, -2.65], r: [0.75, 0.8, 0.9] },
  blend: 0.45,
  eyeDir: v(0.86, 0.12, 0.5),
  eyeRadius: 0.16,
  eyePatch: 0.21,
  beakBase: [0, 3.56, 1.44],
  beakDir: v(0, -0.1, 1),
  beakLength: 0.48,
  tailBase: [0, 2.13, -3.15],
  tailDir: v(0, -0.22, -0.975),
  bounds: { min: [-1.45, 0.05, -3.9], max: [1.45, 4.5, 1.8] },
};

function sdEllipsoid(x: number, y: number, z: number, e: Ellipsoid): number {
  const px = x - e.c[0];
  const py = y - e.c[1];
  const pz = z - e.c[2];
  const [rx, ry, rz] = e.r;
  const k0 = Math.sqrt((px / rx) ** 2 + (py / ry) ** 2 + (pz / rz) ** 2);
  const k1 = Math.sqrt((px / (rx * rx)) ** 2 + (py / (ry * ry)) ** 2 + (pz / (rz * rz)) ** 2);
  return k1 > 1e-9 ? (k0 * (k0 - 1)) / k1 : -Math.min(rx, ry, rz);
}

/** 多项式平滑最小值：h 在 |a-b| < k 的范围内把拐角抹圆。 */
export function smin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/** 躯体的有符号距离，负值在体内。 */
export function bodySDF(x: number, y: number, z: number, p: BodyParams): number {
  let d = sdEllipsoid(x, y, z, p.head);
  d = smin(d, sdEllipsoid(x, y, z, p.neck), p.blend);
  d = smin(d, sdEllipsoid(x, y, z, p.chest), p.blend);
  d = smin(d, sdEllipsoid(x, y, z, p.belly), p.blend);
  d = smin(d, sdEllipsoid(x, y, z, p.back), p.blend);
  d = smin(d, sdEllipsoid(x, y, z, p.rump), p.blend);
  return d;
}

/** 距离场的梯度（中心差分），即曲面外法线方向。 */
export function bodyGradient(x: number, y: number, z: number, p: BodyParams, out: number[]): void {
  const e = 0.01;
  out[0] = bodySDF(x + e, y, z, p) - bodySDF(x - e, y, z, p);
  out[1] = bodySDF(x, y + e, z, p) - bodySDF(x, y - e, z, p);
  out[2] = bodySDF(x, y, z + e, p) - bodySDF(x, y, z - e, p);
}

/** 椭球归一化距离：<1 在内部，≈1 在表面。用于算区域权重。 */
export function ellipsoidNormDist(x: number, y: number, z: number, e: Ellipsoid): number {
  return Math.hypot((x - e.c[0]) / e.r[0], (y - e.c[1]) / e.r[1], (z - e.c[2]) / e.r[2]);
}

/** 体表某一点离眼睛中轴线的距离（判断是否落在眼周裸区内）。 */
export function eyeAxisDist(x: number, y: number, z: number, p: BodyParams, side: number): number {
  const cx = side * p.eyeDir[0] * 0.66 + p.head.c[0];
  const cy = p.eyeDir[1] * 0.66 + p.head.c[1];
  const cz = p.eyeDir[2] * 0.66 + p.head.c[2];
  const dx = x - cx;
  const dy = y - cy;
  const dz = z - cz;
  const along = dx * side * p.eyeDir[0] + dy * p.eyeDir[1] + dz * p.eyeDir[2];
  return Math.sqrt(Math.max(dx * dx + dy * dy + dz * dz - along * along, 0));
}
