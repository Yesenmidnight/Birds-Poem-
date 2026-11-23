/**
 * 向心 Catmull-Rom 样条的弧长等距采样——three 的 CatmullRomCurve3(…, 'centripetal').getSpacedPoints()
 * 的纯数学等价实现。
 *
 * 画面上的树枝是 three 采样的，脚爪也烘在那条中心线上；仿真层的曲线栖木必须落在同一条线上。
 * 所以这里逐式照搬 three 的算法，连运算顺序都保持一致：端点外用 2·p0 − p1 的幻影点、
 * 向心参数 dt = 距离^0.5、200 段弦长累加的弧长表、二分反查加线性插值把“弧长比例”换回参数 t。
 * tools/sim.mjs 会拿 three 本尊逐点比对。
 */

/** three 的 Curve.arcLengthDivisions。 */
const ARC_DIVISIONS = 200;

export interface ArcSamples {
  /** 采样点数（= 段数 + 1）。 */
  count: number;
  /** 弧长等距的中心点，平铺 xyz。 */
  centers: Float64Array;
  /** 曲线总长（厘米）。 */
  length: number;
}

/** 控制点平铺成 xyz。 */
export function flattenPoints(points: ReadonlyArray<readonly [number, number, number]>): Float64Array {
  const out = new Float64Array(points.length * 3);
  for (let i = 0; i < points.length; i++) out.set(points[i], i * 3);
  return out;
}

/** 一个坐标轴上的三次多项式：p(0) = x1、p(1) = x2，两端斜率由四个控制点和向心参数决定（three 的 CubicPoly）。 */
function axis(x0: number, x1: number, x2: number, x3: number, dt0: number, dt1: number, dt2: number, w: number): number {
  let t1 = (x1 - x0) / dt0 - (x2 - x0) / (dt0 + dt1) + (x2 - x1) / dt1;
  let t2 = (x2 - x1) / dt1 - (x3 - x1) / (dt1 + dt2) + (x3 - x2) / dt2;
  t1 *= dt1;
  t2 *= dt1;
  const c0 = x1;
  const c1 = t1;
  const c2 = -3 * x1 + 3 * x2 - 2 * t1 - t2;
  const c3 = 2 * x1 - 2 * x2 + t1 + t2;
  const w2 = w * w;
  const w3 = w2 * w;
  return c0 + c1 * w + c2 * w2 + c3 * w3;
}

/** 样条在参数 t（0..1，按控制段等分）处的点，写进 out[0..2]。pts 是 n 个平铺的控制点，n ≥ 2。 */
export function romPoint(pts: Float64Array, n: number, t: number, out: Float64Array): void {
  const p = (n - 1) * t;
  let seg = Math.floor(p);
  let w = p - seg;
  if (w === 0 && seg === n - 1) {
    seg = n - 2;
    w = 1;
  }
  const a = seg * 3;
  const b = a + 3;
  const x1 = pts[a];
  const y1 = pts[a + 1];
  const z1 = pts[a + 2];
  const x2 = pts[b];
  const y2 = pts[b + 1];
  const z2 = pts[b + 2];
  // 幻影端点：three 是 (p0 − p1) + p0，照这个顺序算
  const last = (n - 1) * 3;
  const prev = (n - 2) * 3;
  const x0 = seg > 0 ? pts[a - 3] : (x1 - x2) + x1;
  const y0 = seg > 0 ? pts[a - 2] : (y1 - y2) + y1;
  const z0 = seg > 0 ? pts[a - 1] : (z1 - z2) + z1;
  const x3 = seg + 2 < n ? pts[b + 3] : (pts[last] - pts[prev]) + pts[last];
  const y3 = seg + 2 < n ? pts[b + 4] : (pts[last + 1] - pts[prev + 1]) + pts[last + 1];
  const z3 = seg + 2 < n ? pts[b + 5] : (pts[last + 2] - pts[prev + 2]) + pts[last + 2];

  const dx0 = x0 - x1;
  const dy0 = y0 - y1;
  const dz0 = z0 - z1;
  const dx1 = x1 - x2;
  const dy1 = y1 - y2;
  const dz1 = z1 - z2;
  const dx2 = x2 - x3;
  const dy2 = y2 - y3;
  const dz2 = z2 - z3;
  let dt0 = Math.pow(dx0 * dx0 + dy0 * dy0 + dz0 * dz0, 0.25);
  let dt1 = Math.pow(dx1 * dx1 + dy1 * dy1 + dz1 * dz1, 0.25);
  let dt2 = Math.pow(dx2 * dx2 + dy2 * dy2 + dz2 * dz2, 0.25);
  // 两点重合时参数退化，three 的保护
  if (dt1 < 1e-4) dt1 = 1;
  if (dt0 < 1e-4) dt0 = dt1;
  if (dt2 < 1e-4) dt2 = dt1;

  out[0] = axis(x0, x1, x2, x3, dt0, dt1, dt2, w);
  out[1] = axis(y0, y1, y2, y3, dt0, dt1, dt2, w);
  out[2] = axis(z0, z1, z2, z3, dt0, dt1, dt2, w);
}

/**
 * 沿曲线每隔相同弧长取一个点（divisions 段）。pts 是 n 个平铺的控制点。
 * 半径这类逐点的量要按“第几个采样点”用 interpKeys 插值，和画面网格保持一致。
 */
export function sampleArc(pts: Float64Array, n: number, divisions: number): ArcSamples {
  const last = new Float64Array(3);
  const cur = new Float64Array(3);
  // 弧长表：参数方向 200 等分，逐段累加弦长
  const arc = new Float64Array(ARC_DIVISIONS + 1);
  romPoint(pts, n, 0, last);
  let sum = 0;
  for (let p = 1; p <= ARC_DIVISIONS; p++) {
    romPoint(pts, n, p / ARC_DIVISIONS, cur);
    const dx = cur[0] - last[0];
    const dy = cur[1] - last[1];
    const dz = cur[2] - last[2];
    sum += Math.sqrt(dx * dx + dy * dy + dz * dz);
    arc[p] = sum;
    last.set(cur);
  }

  const centers = new Float64Array((divisions + 1) * 3);
  const tmp = new Float64Array(3);
  for (let d = 0; d <= divisions; d++) {
    // 弧长比例 → 参数：在弧长表里二分找到所在段，再线性插值（three 的 getUtoTmapping）
    const target = (d / divisions) * sum;
    let low = 0;
    let high = ARC_DIVISIONS;
    let i = 0;
    while (low <= high) {
      i = Math.floor(low + (high - low) / 2);
      const cmp = arc[i] - target;
      if (cmp < 0) low = i + 1;
      else if (cmp > 0) high = i - 1;
      else {
        high = i;
        break;
      }
    }
    i = high;
    const t = arc[i] === target ? i / ARC_DIVISIONS : (i + (target - arc[i]) / (arc[i + 1] - arc[i])) / ARC_DIVISIONS;
    romPoint(pts, n, t, tmp);
    centers.set(tmp, d * 3);
  }
  return { count: divisions + 1, centers, length: sum };
}
