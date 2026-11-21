/**
 * 动作用的小曲线：都是无状态的纯函数，时间单位是秒。
 */

export const DEG = Math.PI / 180;

/** Minimum-jerk 位置曲线：速度、加速度都从零平滑起步、平滑到位，鸟类快速转头就是这个形状。 */
export function minJerk(u: number): number {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  return u * u * u * (10 - 15 * u + 6 * u * u);
}

/**
 * 顿挫到位：minimum-jerk 冲到位后带一次极微弱的弹簧过冲（约 3%）再停住。
 * u 以“到位时刻”为单位：u ≤ 1 是主行程，u > 1 是过冲回稳（约半个行程时间后停住）。
 */
export function snap(u: number): number {
  if (u <= 1) return minJerk(u);
  const t = u - 1;
  return 1 + 0.03 * Math.sin(t * 9) * Math.exp(-t * 7);
}

/**
 * 欠阻尼弹簧受一击后的响应，归一化到第一个峰值为 1：甩尾、弹翅回落用。
 * period 是振荡周期，damping 是阻尼比（0..1，越小晃得越久）。
 */
export function spring(t: number, period: number, damping: number): number {
  if (t <= 0 || damping >= 1) return 0;
  const w = (Math.PI * 2) / period;
  const wd = w * Math.sqrt(1 - damping * damping);
  const peak = Math.atan(wd / (damping * w)) / wd;
  const norm = Math.exp(-damping * w * peak) * Math.sin(wd * peak);
  return (Math.exp(-damping * w * t) * Math.sin(wd * t)) / norm;
}

/** 0→1→0 的非对称脉冲：rise 秒升、fall 秒落，两端都是 minimum-jerk 的柔和起落（眨眼、瞬膜）。 */
export function pulse(t: number, rise: number, fall: number): number {
  if (t <= 0 || t >= rise + fall) return 0;
  return t < rise ? minJerk(t / rise) : 1 - minJerk((t - rise) / fall);
}

/**
 * 弹起再收回、收回时略微越过零点再稳住（弹翅“扑棱一下立刻收拢”）：
 * rise 秒弹到 1，fall 秒收回并过冲到 -rebound，再用 fall·0.6 回到 0。
 */
export function flick(t: number, rise: number, fall: number, rebound = 0.12): number {
  if (t <= 0) return 0;
  if (t < rise) return minJerk(t / rise);
  const u = (t - rise) / fall;
  if (u < 1) return 1 - minJerk(u) * (1 + rebound);
  const v = (t - rise - fall) / (fall * 0.6);
  return v < 1 ? -rebound * (1 - minJerk(v)) : 0;
}
