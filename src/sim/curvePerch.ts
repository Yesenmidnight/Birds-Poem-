/**
 * 曲线栖木：树枝、跨街电线、栏杆这类“细长实心体”的表面。
 *
 * 形状是一串弧长等距的中心点加上逐点半径：每一段是一个圆台，两端是半球形的头。
 * 表面只算基础半径，不含树皮鼓包和积雪帽（它们最多让真实表面偏出 8.5% r，物理上可以忽略；
 * 脚爪落点仍然走画面那边的精确表面函数）。
 *
 * 最近点查询分两步：先在中心线上找“到轴的距离减去当地半径”最小的轴点，再沿径向推到表面。
 * 半径沿轴的变化很缓（半角 2° 以内），所以“先找轴点再取径向”的误差远小于 1 毫米。
 * 找轴点时先每隔 8 个采样点粗搜一遍，只在可能更近的粗样本附近细化——查询量降到原来的四分之一左右，
 * 结果和逐段暴力搜索完全一致（closestBrute 是参照实现，tools/sim.mjs 会比对）。
 *
 * 落上会颤的（电线、细枝）带一个一阶振型，用解析解推进，任意步长都不会发散：
 *   wire（默认）       两端固定的电线：中点按阻尼谐振子沿世界 +Y 位移，两端固定点不动（一阶振型 sin(πs/L)）；
 *   cantilever（2026-11-23） 焊在母枝上的枝条：根部 u = 0 处位移恒为 0、梢端最大，振型 (s/L)²（和画面层顶点着色器的
 *                      offset · aLimbS² 同一个公式，鸟根跟着 offsetAt 走就是跟着画面上的枝走）；鸟站上时还有一个静态下垂的平衡点
 *                      （load：枝先沉一下，离枝回弹）；母枝也会弯时，枝根刚性跟着母枝在焊口处的位移走（linkParent），焊口绝不裂开。
 */

import { Vec3 } from './math.ts';
import { SURFACE_CURVE, type Contact, type Surface } from './surface.ts';

export interface SpringParams {
  /** 固有频率（赫兹）。 */
  freq: number;
  /** 阻尼比 0..1：0 一直晃，越接近 1 停得越快。 */
  damping: number;
  /** 落点的法向速度（厘米 / 秒）里有多少变成中点 / 梢端的初速。 */
  gain: number;
  /** 振型：'wire'（默认）两端固定、中点最大；'cantilever' 根部焊在母枝上不动、梢端最大 (s/L)²。 */
  mode?: 'wire' | 'cantilever';
  /** cantilever 专用：鸟站上时梢端的静态下垂（厘米，按落点处的振型权重折算；离枝回弹到 0）。 */
  sag?: number;
}

interface SpringState {
  w: number;
  zeta: number;
  gain: number;
  /** 中点 / 梢端位移的上限（厘米），也用来撑开包围盒。 */
  limit: number;
  /** 中点 / 梢端位移（厘米）与速度（厘米 / 秒）。 */
  x: number;
  v: number;
  /** 静态平衡点（厘米）：鸟站上时枝下垂的量，离枝为 0。 */
  eq: number;
  /** 静态下垂量（厘米，cantilever）。 */
  sag: number;
  cantilever: boolean;
  /** 母枝（也会弯时）和焊口在母枝上的弧长（厘米）：枝根跟着母枝在该处的位移刚性运动。 */
  parent: CurvePerch | null;
  parentS: number;
  /** 包围盒要外扩的总量（厘米）：自己的 limit + 母枝那一路的。 */
  amp: number;
}

/** 曲线上某弧长处的标架：中心、单位切线、顶面方向、侧向（切线 × 顶面）、基础半径。 */
export interface CurveFrame {
  cx: number;
  cy: number;
  cz: number;
  tx: number;
  ty: number;
  tz: number;
  ux: number;
  uy: number;
  uz: number;
  sx: number;
  sy: number;
  sz: number;
  radius: number;
}

export function makeCurveFrame(): CurveFrame {
  return { cx: 0, cy: 0, cz: 0, tx: 1, ty: 0, tz: 0, ux: 0, uy: 1, uz: 0, sx: 0, sy: 0, sz: 1, radius: 0 };
}

/** 粗搜的间隔（采样点数）。 */
const COARSE = 8;
const scratchFrame = makeCurveFrame();

export class CurvePerch implements Surface {
  readonly kind = SURFACE_CURVE;
  id = -1;
  readonly min = new Vec3();
  readonly max = new Vec3();
  /** 曲线总长（厘米）。 */
  readonly length: number;
  /** 段数（= 采样点数 − 1）。 */
  readonly segments: number;
  /** 带振子（落上会颤）：SimWorld 每帧推进它。 */
  readonly dynamic: boolean;

  private readonly c: Float64Array;
  private readonly r: Float64Array;
  private readonly s: Float64Array;
  private readonly tan: Float64Array;
  private readonly up: Float64Array;
  private readonly side: Float64Array;
  private readonly maxSeg: number;
  private readonly rMax: number;
  private readonly coarseDist: Float64Array;
  private readonly spring: SpringState | null;
  // 最近轴点的查询结果
  private hitSeg = 0;
  private hitT = 0;

  /**
   * centers 是 count 个弧长等距的中心点（平铺 xyz，见 spline.ts 的 sampleArc），radii 是逐点基础半径。
   * 两端的半径建议收到很小（0.05 左右），否则端头的半球会显得钝。
   */
  constructor(centers: Float64Array, radii: Float64Array, count: number, spring: SpringParams | null = null) {
    if (count < 2) throw new Error('CurvePerch 至少要两个采样点');
    const n = count - 1;
    this.segments = n;
    this.c = centers;
    this.r = radii;
    this.tan = new Float64Array(count * 3);
    this.up = new Float64Array(count * 3);
    this.side = new Float64Array(count * 3);
    this.s = new Float64Array(count);
    this.coarseDist = new Float64Array(Math.floor(n / COARSE) + 2);

    let maxSeg = 0;
    let rMax = 0;
    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      // 切线：相邻采样点的差（两端用单侧），和画面网格的平行标架取法一致
      const a = Math.max(i - 1, 0) * 3;
      const b = Math.min(i + 1, n) * 3;
      let tx = centers[b] - centers[a];
      let ty = centers[b + 1] - centers[a + 1];
      let tz = centers[b + 2] - centers[a + 2];
      let len = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
      tx /= len;
      ty /= len;
      tz /= len;
      this.tan[i3] = tx;
      this.tan[i3 + 1] = ty;
      this.tan[i3 + 2] = tz;
      // 顶面：世界 +Y 投到与切线垂直的平面上；枝条接近竖直时改用 +X
      let ux = -tx * ty;
      let uy = 1 - ty * ty;
      let uz = -tz * ty;
      len = Math.sqrt(ux * ux + uy * uy + uz * uz);
      if (len < 1e-6) {
        ux = 1 - tx * tx;
        uy = -ty * tx;
        uz = -tz * tx;
        len = Math.sqrt(ux * ux + uy * uy + uz * uz);
      }
      ux /= len;
      uy /= len;
      uz /= len;
      this.up[i3] = ux;
      this.up[i3 + 1] = uy;
      this.up[i3 + 2] = uz;
      // 侧向 = 切线 × 顶面（主枝上指向世界 +Z，和 Branches.perchAt 的约定一致）
      this.side[i3] = ty * uz - tz * uy;
      this.side[i3 + 1] = tz * ux - tx * uz;
      this.side[i3 + 2] = tx * uy - ty * ux;
      if (i > 0) {
        const dx = centers[i3] - centers[i3 - 3];
        const dy = centers[i3 + 1] - centers[i3 - 2];
        const dz = centers[i3 + 2] - centers[i3 - 1];
        const seg = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (seg > maxSeg) maxSeg = seg;
        this.s[i] = this.s[i - 1] + seg;
      }
      if (radii[i] > rMax) rMax = radii[i];
    }
    this.maxSeg = maxSeg;
    this.rMax = rMax;
    this.length = this.s[n];

    this.spring = spring
      ? {
          w: 2 * Math.PI * spring.freq,
          zeta: Math.min(0.95, Math.max(0, spring.damping)),
          gain: spring.gain,
          // 振幅上限 = 800 cm/s 落速激出来的振幅（最多 30 cm），也用来撑开包围盒
          limit: Math.min(30, (Math.abs(spring.gain) * 800) / (2 * Math.PI * spring.freq)),
          x: 0,
          v: 0,
          eq: 0,
          sag: Math.max(0, spring.sag ?? 0),
          cantilever: spring.mode === 'cantilever',
          parent: null,
          parentS: 0,
          amp: Math.min(30, (Math.abs(spring.gain) * 800) / (2 * Math.PI * spring.freq)),
        }
      : null;
    this.dynamic = this.spring !== null;

    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < count; i++) {
      const x = centers[i * 3];
      const y = centers[i * 3 + 1];
      const z = centers[i * 3 + 2];
      const rr = radii[i];
      if (x - rr < minX) minX = x - rr;
      if (x + rr > maxX) maxX = x + rr;
      if (y - rr < minY) minY = y - rr;
      if (y + rr > maxY) maxY = y + rr;
      if (z - rr < minZ) minZ = z - rr;
      if (z + rr > maxZ) maxZ = z + rr;
    }
    const amp = this.spring ? this.spring.amp : 0;
    this.min.set(minX, minY - amp, minZ);
    this.max.set(maxX, maxY + amp, maxZ);
  }

  /** 参考点（电线中点 / 悬臂枝梢端）此刻的位移（厘米，沿世界 +Y；悬臂枝含母枝带过来的刚性位移）：画面层拿它判断“这根动没动”。 */
  get offset(): number {
    const sp = this.spring;
    return sp ? this.offsetAt(sp.cantilever ? this.length : this.length / 2) : 0;
  }

  /** 振子自己的位移（厘米，不含母枝带过来的）：画面层的活跃枝槽位写的就是它（母枝那一份由子枝按 aLimbP 另算）。 */
  get ownOffset(): number {
    return this.spring ? this.spring.x : 0;
  }

  /** 是不是焊在母枝上的悬臂枝（根部不动、梢端最大）；电线 / 没弹簧的是 false。 */
  get cantilever(): boolean {
    return this.spring !== null && this.spring.cantilever;
  }

  /** 悬臂枝焊在哪根母枝上（母枝也会弯时才有）；电线 / 主枝一级 / 没弹簧的是 null。 */
  get parentPerch(): CurvePerch | null {
    return this.spring ? this.spring.parent : null;
  }

  /**
   * 悬臂枝焊在母枝上：枝根刚性跟着母枝在弧长 parentS 处的位移走（母枝自己也在弯时）。必须在登记进 SimWorld 之前调用
   * （包围盒要按母枝那一路的振幅一起撑开）。只能挂一层：母枝的母枝是刚性的主干 / 主枝。
   */
  linkParent(parent: CurvePerch, sRel: number): void {
    const sp = this.spring;
    if (!sp) return;
    sp.parent = parent;
    sp.parentS = Math.min(1, Math.max(0, sRel)) * parent.length;
    const extra = sp.limit + (parent.spring ? parent.spring.amp : 0) - sp.amp;
    sp.amp += extra;
    this.min.y -= extra;
    this.max.y += extra;
  }

  /** 振型在弧长 s 处的权重：电线 sin(πu)（两端 0、中点 1）；悬臂枝 u²（根 0、梢 1）。 */
  shapeAt(s: number): number {
    const u = Math.min(1, Math.max(0, s / this.length));
    const sp = this.spring;
    return sp && sp.cantilever ? u * u : Math.sin(Math.PI * u);
  }

  /**
   * 鸟站上 / 离开悬臂枝：on = true 时静态平衡点让枝在落点处下垂 sag 厘米（越靠梢端垂得越多），on = false 回到 0（枝回弹）。
   * 电线（wire 模式）没有静态下垂，调用无效果。
   */
  load(sRel: number, on: boolean): void {
    const sp = this.spring;
    if (!sp || !sp.cantilever) return;
    sp.eq = on ? -sp.sag * this.shapeAt(Math.min(1, Math.max(0, sRel)) * this.length) : 0;
  }

  /**
   * 落枝冲量：sRel 是落点在弧长上的比例 0..1，speed 是落点相对表面的法向速度（厘米 / 秒，≥ 0），
   * ny 是接触法线的竖直分量——冲量顺着 −n 推电线：从上方砸下来（ny > 0）电线先往下走，
   * 从下方顶到（ny < 0）先往上走。电线迎面撞上球时 speed 是相对接近速度，电线因此减速。
   * 悬臂枝按落点处的振型权重折算：落在根部不动，落在梢端最大。
   */
  excite(sRel: number, speed: number, ny: number): void {
    const sp = this.spring;
    if (!sp) return;
    const u = Math.min(1, Math.max(0, sRel));
    // 初速封顶在“最大振幅对应的速度”：多颗球同时砸中也不会把电线砸出 limit
    const vMax = sp.limit * sp.w;
    sp.v = Math.min(vMax, Math.max(-vMax, sp.v - sp.gain * speed * ny * this.shapeAt(u * this.length)));
  }

  /** 推进振动（解析解，任意步长都稳定）；悬臂枝绕静态平衡点 eq 振荡。 */
  advance(dt: number): void {
    const sp = this.spring;
    if (!sp || dt <= 0 || (sp.x === sp.eq && sp.v === 0)) return;
    const wd = sp.w * Math.sqrt(1 - sp.zeta * sp.zeta);
    const c = Math.cos(wd * dt);
    const s = Math.sin(wd * dt);
    const e = Math.exp(-sp.zeta * sp.w * dt);
    const x = sp.x - sp.eq;
    const v = sp.v;
    const nx = e * (x * c + ((v + sp.zeta * sp.w * x) / wd) * s);
    const nv = e * (v * c - ((sp.zeta * sp.w * v + sp.w * sp.w * x) / wd) * s);
    sp.x = nx + sp.eq;
    sp.v = nv;
    // 撞到振幅上限：位移钳住的同时把继续往外冲的速度清零，否则表面速度（svel）和实际位置对不上，
    // 球会被“免费”托在原地却永远算不出落定
    if (sp.x > sp.limit) {
      sp.x = sp.limit;
      if (sp.v > 0) sp.v = 0;
    } else if (sp.x < -sp.limit) {
      sp.x = -sp.limit;
      if (sp.v < 0) sp.v = 0;
    }
    if (Math.abs(sp.x - sp.eq) < 1e-4 && Math.abs(sp.v) < 1e-3) {
      sp.x = sp.eq;
      sp.v = 0;
    }
  }

  /** 弧长 s 处的位移（厘米）：自己的振型 × 振子位移 + 母枝在焊口处带过来的刚性位移。 */
  offsetAt(s: number): number {
    const sp = this.spring;
    if (!sp) return 0;
    const base = sp.parent ? sp.parent.offsetAt(sp.parentS) : 0;
    return base + sp.x * this.shapeAt(s);
  }

  closest(px: number, py: number, pz: number, out: Contact): Contact {
    this.nearestAxis(px, py, pz);
    let seg = this.hitSeg;
    let t = this.hitT;
    let oy = 0;
    // 振动时位移沿弧长变化很慢：先按静止中心线找到落点，把查询点逆位移后再找一次就够（悬臂枝连母枝带过来的那一份一起逆）
    if (this.spring && this.offset !== 0) {
      this.nearestAxis(px, py - this.offsetAt(this.arcAt(seg, t)), pz);
      seg = this.hitSeg;
      t = this.hitT;
      oy = this.offsetAt(this.arcAt(seg, t));
    }
    return this.finish(px, py, pz, seg, t, oy, out);
  }

  /** 逐段暴力搜索的参照实现（不含振动）：结果必须和 closest 完全一致，tools/sim.mjs 拿它当标准答案。 */
  closestBrute(px: number, py: number, pz: number, out: Contact): Contact {
    let bestD = Infinity;
    let bestSeg = 0;
    let bestT = 0;
    for (let s2 = 0; s2 < this.segments; s2++) {
      const a = s2 * 3;
      const ex = this.c[a + 3] - this.c[a];
      const ey = this.c[a + 4] - this.c[a + 1];
      const ez = this.c[a + 5] - this.c[a + 2];
      const wx = px - this.c[a];
      const wy = py - this.c[a + 1];
      const wz = pz - this.c[a + 2];
      const len2 = ex * ex + ey * ey + ez * ez;
      let t = len2 > 1e-18 ? (wx * ex + wy * ey + wz * ez) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = wx - ex * t;
      const dy = wy - ey * t;
      const dz = wz - ez * t;
      const surf = Math.sqrt(dx * dx + dy * dy + dz * dz) - (this.r[s2] + (this.r[s2 + 1] - this.r[s2]) * t);
      if (surf < bestD) {
        bestD = surf;
        bestSeg = s2;
        bestT = t;
      }
    }
    return this.finish(px, py, pz, bestSeg, bestT, 0, out);
  }

  pointAt(u: number, v: number, offset: number, out: Vec3): Vec3 {
    const f = this.frameAt(u, scratchFrame);
    const rr = f.radius + offset;
    const cv = Math.cos(v);
    const sv = Math.sin(v);
    out.x = f.cx + (f.ux * cv + f.sx * sv) * rr;
    out.y = f.cy + (f.uy * cv + f.sy * sv) * rr;
    out.z = f.cz + (f.uz * cv + f.sz * sv) * rr;
    return out;
  }

  /** 弧长 s 处的标架（含当前振动位移）。 */
  frameAt(sAbs: number, out: CurveFrame): CurveFrame {
    const s = Math.min(this.length, Math.max(0, sAbs));
    // s 严格递增，二分找所在段
    let lo = 0;
    let hi = this.segments;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.s[mid] <= s) lo = mid;
      else hi = mid;
    }
    const seg = lo;
    const t = this.s[seg + 1] > this.s[seg] ? (s - this.s[seg]) / (this.s[seg + 1] - this.s[seg]) : 0;
    const a = seg * 3;
    const b = a + 3;
    out.cx = this.c[a] + (this.c[b] - this.c[a]) * t;
    out.cy = this.c[a + 1] + (this.c[b + 1] - this.c[a + 1]) * t + this.offsetAt(this.arcAt(seg, t));
    out.cz = this.c[a + 2] + (this.c[b + 2] - this.c[a + 2]) * t;
    this.basis(seg, t, out);
    return out;
  }

  /** 第 seg 段上参数 t 处的方向标架与半径（不含中心点）。 */
  private basis(seg: number, t: number, out: CurveFrame): CurveFrame {
    const a = seg * 3;
    const b = a + 3;
    const tx = this.tan[a] + (this.tan[b] - this.tan[a]) * t;
    const ty = this.tan[a + 1] + (this.tan[b + 1] - this.tan[a + 1]) * t;
    const tz = this.tan[a + 2] + (this.tan[b + 2] - this.tan[a + 2]) * t;
    let ux = this.up[a] + (this.up[b] - this.up[a]) * t;
    let uy = this.up[a + 1] + (this.up[b + 1] - this.up[a + 1]) * t;
    let uz = this.up[a + 2] + (this.up[b + 2] - this.up[a + 2]) * t;
    // 重新正交化：插值出来的顶面不一定垂直于切线
    const k = ux * tx + uy * ty + uz * tz;
    ux -= tx * k;
    uy -= ty * k;
    uz -= tz * k;
    const len = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
    ux /= len;
    uy /= len;
    uz /= len;
    out.tx = tx;
    out.ty = ty;
    out.tz = tz;
    out.ux = ux;
    out.uy = uy;
    out.uz = uz;
    out.sx = ty * uz - tz * uy;
    out.sy = tz * ux - tx * uz;
    out.sz = tx * uy - ty * ux;
    out.radius = this.r[seg] + (this.r[seg + 1] - this.r[seg]) * t;
    return out;
  }

  /**
   * 把“轴点在第 seg 段的参数 t 处、沿 +Y 有位移 oy”写成一次接触：
   * 从查询点指向轴点取径向，推到半径处得到表面点，距离 = 到轴的距离 − 半径。
   * 表面点到查询点的方向就是法线，所以 |p − q| = |dist|、(p − q) 沿法线，两者严格自洽。
   */
  private finish(px: number, py: number, pz: number, seg: number, t: number, oy: number, out: Contact): Contact {
    const a = seg * 3;
    const b = a + 3;
    const ax = this.c[a] + (this.c[b] - this.c[a]) * t;
    const ay = this.c[a + 1] + (this.c[b + 1] - this.c[a + 1]) * t + oy;
    const az = this.c[a + 2] + (this.c[b + 2] - this.c[a + 2]) * t;
    let dx = px - ax;
    let dy = py - ay;
    let dz = pz - az;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const f = this.basis(seg, t, scratchFrame);
    let inv = 1;
    if (d > 1e-9) inv = 1 / d;
    else {
      // 正落在轴上：法线取顶面方向，距离就是负的半径
      dx = f.ux;
      dy = f.uy;
      dz = f.uz;
    }
    const nx = dx * inv;
    const ny = dy * inv;
    const nz = dz * inv;
    // 环向角：从顶面起算，朝 side 为正（和画面那边 perchAt 的 alpha 同一个约定）
    const alpha = Math.atan2(nx * f.sx + ny * f.sy + nz * f.sz, nx * f.ux + ny * f.uy + nz * f.uz);
    out.surface = this;
    out.px = ax + nx * f.radius;
    out.py = ay + ny * f.radius;
    out.pz = az + nz * f.radius;
    out.nx = nx;
    out.ny = ny;
    out.nz = nz;
    out.dist = d - f.radius;
    // 表面沿法线的速度：振子速度 × 一阶振型在弧长 s 处的比例，再投到法线上
    // 表面沿法线的速度：振子速度 × 振型在弧长 s 处的权重（母枝带过来的刚性位移是慢变量，不记），再投到法线上
    out.svel = this.spring ? this.spring.v * this.shapeAt(this.arcAt(seg, t)) * ny : 0;
    out.u = this.arcAt(seg, t);
    out.v = alpha;
    out.face = -1;
    return out;
  }

  private arcAt(seg: number, t: number): number {
    return this.s[seg] + (this.s[seg + 1] - this.s[seg]) * t;
  }

  /**
   * 在静止中心线上找“到轴的距离 − 当地半径”最小的点，结果放在 hitSeg / hitT。
   * 先每隔 COARSE 个采样点粗搜；真正的最近点离它最近的粗样本不超过半格（COARSE / 2 段），
   * 半径差再计入 rMax，所以只细化“粗距离 ≤ 最小表面距离 + rMax + 半格长”的粗样本附近就是完备的。
   */
  private nearestAxis(px: number, py: number, pz: number): void {
    const n = this.segments;
    const c = this.c;
    const r = this.r;
    const coarse = this.coarseDist;
    let best = Infinity;
    let nc = 0;
    for (let i = 0; i < n; i += COARSE) {
      const dx = px - c[i * 3];
      const dy = py - c[i * 3 + 1];
      const dz = pz - c[i * 3 + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      coarse[nc++] = d;
      if (d - r[i] < best) best = d - r[i];
    }
    // 末尾那个采样点一定要量：曲线的另一头可能离查询点最近
    const lx = px - c[n * 3];
    const ly = py - c[n * 3 + 1];
    const lz = pz - c[n * 3 + 2];
    const last = Math.sqrt(lx * lx + ly * ly + lz * lz);
    coarse[nc++] = last;
    if (last - r[n] < best) best = last - r[n];

    const limit = best + this.rMax + 0.5 * COARSE * this.maxSeg;
    const half = COARSE >> 1;
    let bestD = Infinity;
    let bestSeg = 0;
    let bestT = 0;
    let done = -1;
    for (let k = 0; k < nc; k++) {
      if (coarse[k] > limit) continue;
      const i = k === nc - 1 ? n : k * COARSE;
      const lo = Math.max(0, i - half);
      const hi = Math.min(n - 1, i + half - 1);
      for (let s2 = Math.max(lo, done + 1); s2 <= hi; s2++) {
        const a = s2 * 3;
        const ex = c[a + 3] - c[a];
        const ey = c[a + 4] - c[a + 1];
        const ez = c[a + 5] - c[a + 2];
        const wx = px - c[a];
        const wy = py - c[a + 1];
        const wz = pz - c[a + 2];
        const len2 = ex * ex + ey * ey + ez * ez;
        let t = len2 > 1e-18 ? (wx * ex + wy * ey + wz * ez) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const dx = wx - ex * t;
        const dy = wy - ey * t;
        const dz = wz - ez * t;
        const surf = Math.sqrt(dx * dx + dy * dy + dz * dz) - (r[s2] + (r[s2 + 1] - r[s2]) * t);
        if (surf < bestD) {
          bestD = surf;
          bestSeg = s2;
          bestT = t;
        }
      }
      if (hi > done) done = hi;
    }
    this.hitSeg = bestSeg;
    this.hitT = bestT;
  }
}
