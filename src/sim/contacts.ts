/**
 * 小球探针：验证表面查询与接触求解的最小刚体。
 *
 * 每颗是一个球：半隐式欧拉积分 + 子步（每子步位移不超过半个半径，细电线也穿不过去）+ 位置推出 +
 * 速度响应。它不是鸟的物理本体——鸟是运动学驱动的——但飞行动作里身体、翼尖对楼体的穿透检查
 * 走的是同一套查询；无头压测也用它把每一样表面的接触都压一遍。
 * 速度响应一律按“球相对表面”的速度算：电线自己颤上来碰到球，球照样被弹开。
 * 落定的小球“粘”在表面上：记下落点的表面参数，会动的表面（电线在颤）按参数跟着走，表面离开才被叫醒。
 */
import { Vec3 } from './math.ts';
import { makeContact, type Contact, type Surface } from './surface.ts';
import type { SimWorld } from './world.ts';

/** 内部固定步长（秒）：会动的表面和球按同一个节拍推进。 */
const FRAME = 1 / 240;
/** 落定的球离表面多远以内算还贴着（厘米）。 */
const GLUE = 1.5;

export class ProbeSet {
  readonly count: number;
  readonly px: Float64Array;
  readonly py: Float64Array;
  readonly pz: Float64Array;
  readonly vx: Float64Array;
  readonly vy: Float64Array;
  readonly vz: Float64Array;
  /** 0 = 空位，1 = 下落中，2 = 已落定。 */
  readonly state: Uint8Array;
  radius: number;
  /** 低速时的反弹系数；落点法向速度低于 20 cm/s 时完全不弹，落稳不抖。 */
  restitution: number;
  /** 库仑摩擦系数。 */
  friction: number;
  /**
   * 整个生命期内最大的穿透深度（厘米），压测指标。只统计静止表面：会动的表面在两步之间
   * 扫进球里多少算多少，那不是求解器的错。
   */
  maxPenetration = 0;
  /** 撞击回调：下落中的球撞上表面时调用（speed 是相对表面的法向落速），用来触发电线、细枝的颤动。 */
  onImpact: ((contact: Contact, speed: number) => void) | null = null;

  // 落定时记下的表面与表面参数（曲线：弧长 / 环向角）
  private readonly restSurface: (Surface | null)[];
  private readonly restU: Float64Array;
  private readonly restV: Float64Array;
  private readonly contact: Contact = makeContact();
  private readonly tmp = new Vec3();
  private cursor = 0;

  constructor(count: number, radius: number) {
    this.count = count;
    this.radius = radius;
    this.restitution = 0.3;
    this.friction = 0.5;
    this.px = new Float64Array(count);
    this.py = new Float64Array(count);
    this.pz = new Float64Array(count);
    this.vx = new Float64Array(count);
    this.vy = new Float64Array(count);
    this.vz = new Float64Array(count);
    this.state = new Uint8Array(count);
    this.restSurface = new Array(count).fill(null);
    this.restU = new Float64Array(count);
    this.restV = new Float64Array(count);
  }

  /** 放一颗球，返回编号；满了返回 −1。 */
  spawn(x: number, y: number, z: number, vx = 0, vy = 0, vz = 0): number {
    for (let k = 0; k < this.count; k++) {
      const i = (this.cursor + k) % this.count;
      if (this.state[i] !== 0) continue;
      this.cursor = (i + 1) % this.count;
      this.px[i] = x;
      this.py[i] = y;
      this.pz[i] = z;
      this.vx[i] = vx;
      this.vy[i] = vy;
      this.vz[i] = vz;
      this.state[i] = 1;
      this.restSurface[i] = null;
      return i;
    }
    return -1;
  }

  clear(): void {
    this.state.fill(0);
    this.maxPenetration = 0;
  }

  /** 正在下落 / 已落定的球数。 */
  alive(): number {
    let n = 0;
    for (let i = 0; i < this.count; i++) if (this.state[i] !== 0) n++;
    return n;
  }

  resting(): number {
    let n = 0;
    for (let i = 0; i < this.count; i++) if (this.state[i] === 2) n++;
    return n;
  }

  /**
   * 推进 dt 秒：会动的表面（world.advance）和球按同一个固定步长一起走，
   * 这样表面在两步之间最多挪 |svel| × FRAME。
   */
  step(world: SimWorld, dt: number): void {
    const frames = Math.max(1, Math.ceil(dt / FRAME));
    const h = dt / frames;
    for (let f = 0; f < frames; f++) {
      world.advance(h);
      this.substep(world, world.gravity, h);
    }
  }

  private substep(world: SimWorld, g: number, h: number): void {
    const c = this.contact;
    const radius = this.radius;
    for (let i = 0; i < this.count; i++) {
      const st = this.state[i];
      if (st === 0) continue;
      let x = this.px[i];
      let y = this.py[i];
      let z = this.pz[i];
      if (st === 2) {
        const s = this.restSurface[i];
        if (s !== null && this.stillResting(world, i, s)) continue;
        // 表面挪开了（球原来架在两样东西之间、其中一样没了）或者别的东西撞进来：叫醒
        x = this.px[i];
        y = this.py[i];
        z = this.pz[i];
        this.state[i] = 1;
        this.restSurface[i] = null;
      }
      // 子步：每一步位移不超过半个半径
      const speed = Math.sqrt(this.vx[i] ** 2 + this.vy[i] ** 2 + this.vz[i] ** 2);
      const subs = Math.min(16, Math.max(1, Math.ceil((speed * h) / (0.5 * radius))));
      const dt = h / subs;
      let vx = this.vx[i];
      let vy = this.vy[i];
      let vz = this.vz[i];
      for (let k = 0; k < subs; k++) {
        vy -= g * dt;
        x += vx * dt;
        y += vy * dt;
        z += vz * dt;
        world.closest(x, y, z, c);
        if (c.surface === null || c.dist >= radius) continue;
        let pen = radius - c.dist;
        if (pen > this.maxPenetration && c.svel === 0) this.maxPenetration = pen;
        let nx = c.nx;
        let ny = c.ny;
        let nz = c.nz;
        if (c.dist < 0 && c.svel !== 0) {
          // 球心被会动的表面（沿世界 Y 颤）扫进体内：轴指向球心的方向几乎是随机的，
          // 改成沿表面运动的方向推出去，球一定被送到表面前进的那一侧
          const dir = c.svel > 0 ? 1 : -1;
          nx = 0;
          ny = dir;
          nz = 0;
        }
        // 位置推出
        x += nx * pen;
        y += ny * pen;
        z += nz * pen;
        // 相对表面的法向速度
        const svel = c.svel;
        const vn = vx * nx + vy * ny + vz * nz - svel;
        if (vn < 0) {
          // 法向：反弹系数随落速平滑升起，轻触不弹
          const impact = -vn;
          const e = this.restitution * smoothstep(20, 80, impact);
          const jn = -(1 + e) * vn;
          if (this.onImpact) this.onImpact(c, impact);
          vx += nx * jn;
          vy += ny * jn;
          vz += nz * jn;
          // 切向：库仑摩擦，切向速度最多削减 μ × 法向冲量（单位质量）
          const vn2 = vx * nx + vy * ny + vz * nz;
          let tx = vx - nx * vn2;
          let ty = vy - ny * vn2;
          let tz = vz - nz * vn2;
          const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
          if (tl > 1e-9) {
            const keep = Math.max(0, tl - this.friction * jn) / tl;
            tx *= keep;
            ty *= keep;
            tz *= keep;
            vx = nx * vn2 + tx;
            vy = ny * vn2 + ty;
            vz = nz * vn2 + tz;
          }
        }
        // 相对表面的速度已经很小的接触当成落定，速度记成表面的速度（醒了接着跟表面走）
        const rvx = vx - nx * svel;
        const rvy = vy - ny * svel;
        const rvz = vz - nz * svel;
        if (rvx * rvx + rvy * rvy + rvz * rvz < 4) {
          vx = nx * svel;
          vy = ny * svel;
          vz = nz * svel;
          this.state[i] = 2;
          this.restSurface[i] = c.surface;
          this.restU[i] = c.u;
          this.restV[i] = c.v;
          break;
        }
      }
      this.px[i] = x;
      this.py[i] = y;
      this.pz[i] = z;
      this.vx[i] = vx;
      this.vy[i] = vy;
      this.vz[i] = vz;
    }
  }

  /**
   * 已落定的球第 i 颗还贴在表面 s 上吗？贴着就把位置同步到表面上（返回 true），否则返回 false 让它醒。
   * 会动的表面按落定时的参数取点，球跟着表面走，表面永远扫不穿它；静止表面用容差判断。
   */
  private stillResting(world: SimWorld, i: number, s: Surface): boolean {
    const c = this.contact;
    const radius = this.radius;
    if (s.dynamic) {
      s.pointAt(this.restU[i], this.restV[i], radius, this.tmp);
      this.px[i] = this.tmp.x;
      this.py[i] = this.tmp.y;
      this.pz[i] = this.tmp.z;
      // 别的东西撞进来（比它现在贴的表面更近）才醒
      world.closest(this.tmp.x, this.tmp.y, this.tmp.z, c);
      return c.surface === s || c.dist >= radius - 1e-9;
    }
    world.closest(this.px[i], this.py[i], this.pz[i], c);
    // 容差内就算还贴着——最近的不一定是原来那个表面（球架在雪面和楼角的交界上时两边轮流最近），
    // 那就把记下的表面换成它；按“必须是原来那个”判断会反复叫醒 / 落定，留下 1e-2 cm 的残余穿透
    if (c.surface === null || Math.abs(c.dist - radius) >= GLUE) return false;
    this.restSurface[i] = c.surface;
    this.restU[i] = c.u;
    this.restV[i] = c.v;
    this.px[i] = c.px + c.nx * radius;
    this.py[i] = c.py + c.ny * radius;
    this.pz[i] = c.pz + c.nz * radius;
    return true;
  }
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
