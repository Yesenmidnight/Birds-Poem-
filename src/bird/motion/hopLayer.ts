import { clamp, lerp } from '../../util/math';
import { minJerk } from './curves';
import { MotionLayer, type MotionContext, type MotionEvents } from './layers';
import type { Pose } from './Pose';

export type HopKind = 'hop' | 'turnHop';

/**
 * 蹦跳层要驱动的外部世界：鸟根、腿架重绑、树枝冲击、雪粉、踩雪印。由观鸟入口实现（App），
 * 这一层的姿态贡献（翅 / 尾 / 头）照常写进 Pose，蹲起与前俯仰身通过 Bird.setHopPose、脚通过 setFootPose 直接给。
 */
export interface HopHost {
  /** 鸟根所在枝条坐标 x（厘米，主枝坐标系，0 = 默认落点）。 */
  readonly birdX: number;
  /** 鸟当前的朝向（绕世界 Y 的弧度）。 */
  readonly heading: number;
  /** 把鸟根摆到沿枝 x 处（含枝条弯曲位移）并绕世界 Y 转 heading；lift 是腾空抬升量（厘米，世界 +Y）。 */
  placeRoot(x: number, heading: number, lift: number): void;
  /** 落枝：按新的落点与朝向重绑两脚，更新踩雪印与枝条的静载位置。 */
  bindFeet(x: number, heading: number): void;
  /** 起跳离枝：枝条卸载（回弹）。 */
  takeOff(): void;
  /** 蹬枝 / 落地的冲击与震雪（strength 1 ≈ 落地；puff = 雪粉粒数）。 */
  impact(strength: number, puff: number): void;
  /** 蹲伏时把枝往下预压（厘米，鸟脚处的额外下垂）。 */
  preload(sag: number): void;
  /** 默认落点附近允许蹦跳的范围 [xmin, xmax]（枝条坐标）。 */
  readonly range: readonly [number, number];
}

/** 三个阶段的时长（秒）：预蹲蓄力 / 腾空抛物线 / 落枝抓握缓冲。 */
const SQUAT = 0.07;
const AIR = 0.13;
const AIR_TURN = 0.17;
const LAND = 0.1;
/** 腾空最大抬升（厘米）。 */
const LIFT = 0.85;

type Phase = 'idle' | 'squat' | 'air' | 'land';

/**
 * 枝头蹦跳：预蹲蓄力（70 ms，躯干下沉微前倾、腿架屈膝、枝被预压）→ 腾空抛物线（130 ms，蹬枝回弹颤动 + 震落微雪，
 * 双脚松握半收成微弯钩、双翅微闪、尾羽微扇、头部保持空间注视方向）→ 落枝抓握缓冲（100 ms，双爪贴上新落点、
 * 双腿弹簧吸收冲击、压得枝上下颤两下）。两种：侧跳（沿枝左右挪一步）与转身跳（原地 180° 换向）。
 * 平时每 5~12 s 自动在安全段内轻跳一两步或转身。
 */
export class HopLayer extends MotionLayer {
  host: HopHost | null = null;
  /** 自动蹦跳（面板总开关关掉时停）。 */
  auto = true;
  /** 这一帧要交给 Bird.setHopPose 的量：蹲伏 0..1.5、前俯仰身（弧度）、侧倾。 */
  crouch = 0;
  pitch = 0;
  roll = 0;
  /** 这一帧两只脚的状态（左 = legs[0] = 局部 +x 侧）。 */
  readonly feet: [{ grip: number; lift: number }, { grip: number; lift: number }] = [
    { grip: 1, lift: 0 },
    { grip: 1, lift: 0 },
  ];
  /** 这一帧鸟根的落点（枝条坐标 x）、朝向、抬升。 */
  rootX = 0;
  rootHeading = 0;
  rootLift = 0;
  /** 当前是否正在蹦（面板 / 截图用）。 */
  get busy(): boolean {
    return this.phase !== 'idle';
  }

  private phase: Phase = 'idle';
  private t = 0;
  private x0 = 0;
  private x1 = 0;
  private h0 = 0;
  private h1 = 0;
  private airTime = AIR;
  private autoIn = 4;
  /** 连跳：落地后再跳一步的倒计时（Infinity = 不连跳）。 */
  private chainIn = Infinity;
  private chained = false;

  /** 立刻起跳（面板按钮 / 截图定格）。正在蹦时忽略。 */
  cue(kind: HopKind, dx?: number): void {
    if (this.phase !== 'idle' || !this.host) return;
    const [lo, hi] = this.host.range;
    this.x0 = this.host.birdX;
    this.h0 = this.host.heading;
    if (kind === 'turnHop') {
      this.x1 = clamp(this.x0 + (dx ?? (this.chainDir() * (0.15 + 0.45 * Math.random()))), lo, hi);
      this.h1 = this.h0 + Math.PI;
      this.airTime = AIR_TURN;
    } else {
      let d = dx ?? (1.3 + 1.1 * Math.random()) * this.chainDir();
      if (this.x0 + d < lo || this.x0 + d > hi) d = -d;
      this.x1 = clamp(this.x0 + d, lo, hi);
      this.h1 = this.h0;
      this.airTime = AIR;
    }
    this.phase = 'squat';
    this.t = 0;
    this.chainIn = Infinity;
  }

  /** 回到栖枝重新接管时清掉在途的蹦跳（起跳到一半被别的东西接走了）：下一帧从宿主的落点重新站着来。 */
  reset(): void {
    this.phase = 'idle';
    this.t = 0;
    this.chainIn = Infinity;
    this.autoIn = 4;
    this.rootLift = 0;
    this.crouch = 0;
    this.pitch = 0;
    this.roll = 0;
    this.feet[0].grip = this.feet[1].grip = 1;
    this.feet[0].lift = this.feet[1].lift = 0;
  }

  /** 往哪边跳：偏向落点范围的中点，免得一步步跳出安全段。 */
  private chainDir(): number {
    if (!this.host) return 1;
    const [lo, hi] = this.host.range;
    const mid = (lo + hi) * 0.5;
    if (Math.abs(this.host.birdX - mid) < 0.3) return Math.random() < 0.5 ? -1 : 1;
    return this.host.birdX > mid ? -1 : 1;
  }

  update(dt: number, ctx: MotionContext, pose: Pose, events: MotionEvents): void {
    const host = this.host;
    this.crouch = 0;
    this.pitch = 0;
    this.roll = 0;
    this.feet[0].grip = this.feet[1].grip = 1;
    this.feet[0].lift = this.feet[1].lift = 0;
    this.rootLift = 0;
    if (!host) return;
    this.rootX = host.birdX;
    this.rootHeading = host.heading;

    if (this.phase === 'idle') {
      // 连跳 / 自动蹦跳的倒计时
      if (this.chainIn < Infinity) {
        this.chainIn -= dt;
        if (this.chainIn <= 0) {
          this.chainIn = Infinity;
          this.cue('hop');
        }
      } else if (this.auto) {
        this.autoIn -= dt;
        if (this.autoIn <= 0) {
          this.autoIn = 5 + 7 * ctx.rng();
          const turn = ctx.rng() < 0.3;
          this.cue(turn ? 'turnHop' : 'hop');
          // 三成概率连跳一步
          if (!turn && ctx.rng() < 0.3) this.chained = true;
        }
      }
      if (this.phase === 'idle') return;
    }

    this.t += dt;
    const t = this.t;
    if (this.phase === 'squat') {
      const u = clamp(t / SQUAT, 0, 1);
      const k = minJerk(u);
      // 蹲伏蓄力：躯干下沉微前倾，枝被预压
      this.crouch = k;
      this.pitch = 0.06 * k;
      // 转身跳：蹲伏时头先顺着要转的方向预瞄一点（山雀起跳前会先看向要去的那边），略带侧倾
      if (Math.abs(this.h1 - this.h0) > 0.01) {
        const dir = Math.sign(this.h1 - this.h0);
        pose.head.yaw += dir * 0.45 * k;
        pose.head.roll += dir * 0.08 * k;
      }
      host.preload(0.05 * k);
      if (u >= 1) {
        this.phase = 'air';
        this.t = 0;
        // 蹬枝：枝回弹颤动 + 震落一小撮雪粉
        host.takeOff();
        host.impact(0.55, 18);
      }
      return;
    }
    if (this.phase === 'air') {
      const u = clamp(t / this.airTime, 0, 1);
      const k = minJerk(u);
      const arc = Math.sin(Math.PI * u);
      this.rootX = lerp(this.x0, this.x1, k);
      this.rootLift = LIFT * arc;
      // 转身跳：身体在腾空的前 6%~82% 转过去。头相对身体的偏转从起跳初的 +0.45·dir（预瞄）平滑退到 0，
      // 中后段反向滞后一点（−0.35·dir，柔和的注视滞后）、落地前归零——全程 |yaw| ≤ 0.65 rad。
      // （以前在这里按"世界方向反减 π"：u≈0 时身体还没转，头却先反拧了 180°，脖子蒙皮拧成麻花）
      const turnU = minJerk(clamp((u - 0.06) / 0.76, 0, 1));
      this.rootHeading = this.h0 + (this.h1 - this.h0) * turnU;
      if (Math.abs(this.h1 - this.h0) > 0.01) {
        const dir = Math.sign(this.h1 - this.h0);
        const lead = 0.45 * (1 - minJerk(clamp(u / 0.45, 0, 1)));
        const lag = -0.35 * Math.sin(Math.PI * clamp((u - 0.3) / 0.62, 0, 1));
        pose.head.yaw += dir * (lead + lag);
        pose.head.roll += dir * 0.08 * (1 - minJerk(clamp(u / 0.5, 0, 1)));
      }
      // 双脚松握半收：grip 柔和退到 0.35、脚踝微微上收并略往前甩（收成微弯钩、悬在腹毛下面看得见，不水平劈叉也不埋进肚子里）
      const g = lerp(1, 0.35, minJerk(clamp(u / 0.45, 0, 1)));
      const lift = 0.08 * minJerk(clamp(u / 0.5, 0, 1));
      this.feet[0].grip = this.feet[1].grip = g;
      this.feet[0].lift = this.feet[1].lift = lift;
      // 双翅微闪（open 0.16~0.22）、尾羽微扇、起跳仰身
      const flick = Math.pow(arc, 0.7);
      for (const side of ['left', 'right'] as const) {
        pose.wing[side].open += 0.19 * flick;
        pose.wing[side].flap -= 0.12 * flick;
        pose.wing[side].sweep += 0.05 * flick;
      }
      pose.tail.spread += 0.3 * flick;
      pose.tail.pitch += 0.12 * flick;
      this.pitch = -0.09 * Math.sin(Math.PI * clamp(u / 0.7, 0, 1)) + 0.06 * minJerk(clamp((u - 0.55) / 0.45, 0, 1));
      if (u >= 1) {
        this.phase = 'land';
        this.t = 0;
        this.rootX = this.x1;
        this.rootHeading = this.h1;
        host.bindFeet(this.x1, this.h1);
        host.impact(1, 28);
        // 落地算一次甩尾事件：扭身层会顺着做一下前俯反冲
        events.tailFlicks++;
      }
      return;
    }
    // 落枝抓握缓冲
    const u = clamp(t / LAND, 0, 1);
    const settle = minJerk(clamp(u / 0.35, 0, 1));
    this.crouch = 0.75 * minJerk(clamp(u / 0.35, 0, 1)) * (1 - minJerk(clamp((u - 0.3) / 0.7, 0, 1)));
    this.pitch = 0.11 * minJerk(clamp(u / 0.3, 0, 1)) * (1 - minJerk(clamp((u - 0.25) / 0.75, 0, 1)));
    this.feet[0].grip = this.feet[1].grip = lerp(0.35, 1, settle);
    this.feet[0].lift = this.feet[1].lift = 0.08 * (1 - settle);
    const tail = Math.sin(Math.PI * u);
    pose.tail.yaw += 0.28 * tail;
    pose.tail.pitch += 0.1 * tail;
    pose.wing.left.open += 0.08 * (1 - minJerk(clamp(u / 0.4, 0, 1)));
    pose.wing.right.open += 0.08 * (1 - minJerk(clamp(u / 0.4, 0, 1)));
    if (u >= 1) {
      this.phase = 'idle';
      this.t = 0;
      if (this.chained) {
        this.chained = false;
        this.chainIn = 0.22;
      }
    }
  }
}
