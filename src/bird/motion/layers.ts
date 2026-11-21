import { Vector3, type Quaternion } from 'three';
import { TAU, clamp, lerp, noise1 } from '../../util/math';
import { DEG, flick, minJerk, pulse, snap, spring } from './curves';
import type { Pose } from './Pose';

/** 每帧由 MotionController 填好的环境：时间、活跃度、随机数、注视目标、头部位置与鸟的朝向。 */
export interface MotionContext {
  time: number;
  /** 情绪活跃度 0..1：越高转得越勤、动作越大。 */
  activity: number;
  rng: () => number;
  /** 注视目标（世界坐标）；null 表示随机注视。 */
  gazeWorld: Vector3 | null;
  /** 相机世界坐标，偶尔看镜头用。 */
  cameraWorld: Vector3;
  /** 头部（眼睛高度）的世界坐标。 */
  headWorld: Vector3;
  /** 世界方向 → 鸟局部方向的旋转。 */
  worldToLocal: Quaternion;
}

/** 跨层事件：跳视层发、眨眼层和甩尾层收（按计数器比对，不需要事件队列）。 */
export interface MotionEvents {
  saccades: number;
  /** 最近一次跳视的角幅度（弧度）。 */
  lastSaccadeMagnitude: number;
  tiltEnds: number;
}

export abstract class MotionLayer {
  /** 往 pose 里叠加本层这一帧的贡献（角度相加，眼睑取最大）。 */
  abstract update(dt: number, ctx: MotionContext, pose: Pose, events: MotionEvents): void;
}

/**
 * 呼吸：3.5~4.2 Hz 快吸慢呼（吸气占 35%），胸腹微膨胀，尾尖跟着极轻微地点。
 */
export class BreathLayer extends MotionLayer {
  private phase = 0;
  private rate = 3.8;
  private rateLeft = 0;

  update(dt: number, ctx: MotionContext, pose: Pose): void {
    // 频率在区间内缓慢漂移，每个周期重新抽一个
    this.rateLeft -= dt;
    if (this.rateLeft <= 0) {
      this.rate = lerp(3.5, 4.2, ctx.rng());
      this.rateLeft = 1 / this.rate;
    }
    this.phase += dt * this.rate;
    const ph = this.phase % 1;
    const b = ph < 0.35 ? minJerk(ph / 0.35) : 1 - minJerk((ph - 0.35) / 0.65);
    pose.breath += b * lerp(0.75, 1.15, ctx.activity);
    pose.tail.pitch += 0.35 * DEG * b;
  }
}

const YAW_LIMIT = 100 * DEG;
const PITCH_UP = 35 * DEG;
const PITCH_DOWN = 30 * DEG;

/**
 * 顿挫跳视 + 歪头：每隔 0.35~1.2 s 换一个注视点，50~85 ms minimum-jerk 冲到位并带极微弱过冲，
 * 定格观察；到位后有概率歪头（roll 12°~26°）保持片刻再回正。跟随模式下改为追鼠标。
 */
export class GazeLayer extends MotionLayer {
  holdYaw = 0;
  holdPitch = 0;
  private yaw = 0;
  private pitch = 0;
  private fromYaw = 0;
  private fromPitch = 0;
  private saccT = Infinity;
  private saccDur = 0.07;
  private dwell = 0;
  private nextDwell = 0.4;
  // 歪头
  private roll = 0;
  private rollFrom = 0;
  private rollTo = 0;
  private rollT = Infinity;
  private rollHold = 1;
  private readonly tmp = new Vector3();

  /** 世界坐标目标 → 鸟局部注视角（yaw 朝鸟右为正，pitch 低头为正，和 setHeadPose 一致）。 */
  private lookAngles(ctx: MotionContext, target: Vector3): { yaw: number; pitch: number } {
    const d = this.tmp.subVectors(target, ctx.headWorld);
    if (d.lengthSq() < 1e-8) return { yaw: this.holdYaw, pitch: this.holdPitch };
    d.normalize().applyQuaternion(ctx.worldToLocal);
    return {
      yaw: clamp(Math.atan2(d.x, d.z), -YAW_LIMIT, YAW_LIMIT),
      pitch: clamp(-Math.asin(clamp(d.y, -1, 1)), -PITCH_UP, PITCH_DOWN),
    };
  }

  private startSaccade(yaw: number, pitch: number, events: MotionEvents): void {
    const d = Math.hypot(yaw - this.yaw, pitch - this.pitch);
    this.fromYaw = this.yaw;
    this.fromPitch = this.pitch;
    this.holdYaw = yaw;
    this.holdPitch = pitch;
    this.saccT = 0;
    this.saccDur = lerp(0.05, 0.085, clamp(d / (90 * DEG), 0, 1));
    events.saccades++;
    events.lastSaccadeMagnitude = d;
  }

  private startTilt(ctx: MotionContext, sign: number): void {
    this.rollFrom = this.roll;
    this.rollTo = sign * lerp(12, 26, ctx.rng()) * DEG;
    this.rollT = 0;
    this.rollHold = lerp(0.5, 1.8, ctx.rng());
  }

  /** 调试：立刻朝指定角度跳视。 */
  cueSaccade(yaw: number, pitch: number, events: MotionEvents): void {
    this.startSaccade(clamp(yaw, -YAW_LIMIT, YAW_LIMIT), clamp(pitch, -PITCH_UP, PITCH_DOWN), events);
  }

  /** 调试：立刻歪头。 */
  cueTilt(ctx: MotionContext, sign = 1): void {
    this.startTilt(ctx, sign);
  }

  /** 随机注视：多数在当前注视点附近小跳，偶尔大转头，偶尔看镜头。 */
  private pickRandom(ctx: MotionContext, events: MotionEvents): void {
    let yaw: number;
    let pitch: number;
    if (ctx.rng() < 0.12) {
      ({ yaw, pitch } = this.lookAngles(ctx, ctx.cameraWorld));
    } else {
      const big = ctx.rng() < lerp(0.2, 0.4, ctx.activity);
      const mag = (big ? lerp(35, 95, ctx.rng()) : lerp(8, 30, ctx.rng())) * DEG;
      const ang = ctx.rng() * TAU;
      yaw = clamp(this.holdYaw + Math.cos(ang) * mag, -YAW_LIMIT, YAW_LIMIT);
      pitch = clamp(this.holdPitch + Math.sin(ang) * mag * 0.45, -PITCH_UP, PITCH_DOWN);
    }
    this.startSaccade(yaw, pitch, events);
  }

  update(dt: number, ctx: MotionContext, pose: Pose, events: MotionEvents): void {
    this.dwell += dt;
    const idle = this.saccT > this.saccDur * 2.5;

    // 1. 发起跳视：跟随鼠标时目标偏离超过 12° 才跳；随机时按停留时间跳
    if (idle && this.dwell > 0.15) {
      if (ctx.gazeWorld) {
        const a = this.lookAngles(ctx, ctx.gazeWorld);
        const far = Math.hypot(a.yaw - this.holdYaw, a.pitch - this.holdPitch);
        if (far > 12 * DEG) this.startSaccade(a.yaw, a.pitch, events);
      } else if (this.dwell >= this.nextDwell) {
        this.pickRandom(ctx, events);
      }
    }

    // 2. 跳视行程：冲到位 → 过冲回稳 → 定格
    if (this.saccT < Infinity) {
      this.saccT += dt;
      const x = snap(this.saccT / this.saccDur);
      this.yaw = lerp(this.fromYaw, this.holdYaw, x);
      this.pitch = lerp(this.fromPitch, this.holdPitch, x);
      if (this.saccT > this.saccDur * 2.5) {
        this.saccT = Infinity;
        this.yaw = this.holdYaw;
        this.pitch = this.holdPitch;
        this.dwell = 0;
        this.nextDwell = lerp(0.35, 1.2, ctx.rng()) * lerp(1, 0.6, ctx.activity);
        // 到位后按概率歪头：转头越大越容易歪
        const p = lerp(0.25, 0.45, ctx.activity) + (events.lastSaccadeMagnitude > 40 * DEG ? 0.15 : 0);
        if (this.rollT === Infinity && ctx.rng() < p) {
          const sign = ctx.rng() < 0.7 ? (this.holdYaw >= 0 ? 1 : -1) : ctx.rng() < 0.5 ? 1 : -1;
          this.startTilt(ctx, sign);
        }
      }
    } else {
      this.yaw = this.holdYaw;
      this.pitch = this.holdPitch;
    }

    // 3. 歪头：快速歪到位 → 保持 → 柔和回正
    if (this.rollT < Infinity) {
      this.rollT += dt;
      const rise = 0.14;
      if (this.rollT < rise) {
        this.roll = lerp(this.rollFrom, this.rollTo, snap(this.rollT / 0.1));
      } else if (this.rollT < rise + this.rollHold) {
        this.roll = this.rollTo;
      } else {
        const u = (this.rollT - rise - this.rollHold) / 0.3;
        if (u >= 1) {
          this.roll = 0;
          this.rollT = Infinity;
          events.tiltEnds++;
        } else {
          this.roll = lerp(this.rollTo, 0, minJerk(u));
        }
      }
    }

    // 4. 定格时的极微弱漂移，避免完全僵死
    const wobble = 0.5 * DEG;
    pose.head.yaw += this.yaw + wobble * (noise1(ctx.time * 0.9, 1) - 0.5) * 2;
    pose.head.pitch += this.pitch + wobble * (noise1(ctx.time * 0.7, 2) - 0.5) * 2;
    pose.head.roll += this.roll;
  }
}

/**
 * 眨眼与瞬膜：每 2.5~6 s 一次真实眨眼（12% 连眨两下）；大角度跳视时约 40% 联动一次 120 ms 瞬膜横扫。
 */
export class BlinkLayer extends MotionLayer {
  private nextBlink = 2.5;
  private blinkT = Infinity;
  private secondT = Infinity;
  private willDouble = false;
  private nictT = Infinity;
  private seenSaccades = 0;

  cueBlink(ctx: MotionContext): void {
    this.blinkT = 0;
    this.secondT = Infinity;
    this.willDouble = ctx.rng() < 0.12;
    this.nextBlink = lerp(2.5, 6, ctx.rng()) * lerp(1, 0.7, ctx.activity);
  }

  cueNict(): void {
    this.nictT = 0;
  }

  update(dt: number, ctx: MotionContext, pose: Pose, events: MotionEvents): void {
    if (this.blinkT === Infinity) {
      this.nextBlink -= dt;
      if (this.nextBlink <= 0) this.cueBlink(ctx);
    }
    let lid = 0;
    if (this.blinkT < Infinity) {
      this.blinkT += dt;
      lid = pulse(this.blinkT, 0.055, 0.09);
      if (this.willDouble && this.secondT === Infinity && this.blinkT >= 0.16) this.secondT = 0;
      if (this.blinkT > 0.5) this.blinkT = Infinity;
    }
    if (this.secondT < Infinity) {
      this.secondT += dt;
      lid = Math.max(lid, pulse(this.secondT, 0.05, 0.085));
      if (this.secondT > 0.2) this.secondT = Infinity;
    }

    if (events.saccades !== this.seenSaccades) {
      this.seenSaccades = events.saccades;
      if (events.lastSaccadeMagnitude > 22 * DEG && ctx.rng() < 0.4) this.nictT = 0;
    }
    let nict = 0;
    if (this.nictT < Infinity) {
      this.nictT += dt;
      nict = pulse(this.nictT, 0.06, 0.06);
      if (this.nictT > 0.16) this.nictT = Infinity;
    }

    pose.eye.lidClose = Math.max(pose.eye.lidClose, lid);
    pose.eye.nict = Math.max(pose.eye.nict, nict);
  }
}

/**
 * 甩尾 + 弹翅：每隔几秒长尾快速上翘并微扇一瞬（欠阻尼弹簧回落），
 * 时而伴随双翅往背上方 90~130 ms 的轻弹；大转头、歪头回正之后更容易来一下。
 */
export class FidgetLayer extends MotionLayer {
  private next = 2.5;
  private pending: number | null = null;
  private tailT = Infinity;
  private tailAmp = 0.35;
  private tailYaw = 0;
  private wingT = Infinity;
  private wingAmp = 0.3;
  private seenSaccades = 0;
  private seenTiltEnds = 0;

  cueTail(ctx: MotionContext): void {
    this.tailT = 0;
    this.tailAmp = lerp(0.28, 0.45, ctx.rng());
    this.tailYaw = ctx.rng() < 0.4 ? (ctx.rng() - 0.5) * 0.2 : 0;
  }

  cueWing(ctx: MotionContext): void {
    this.wingT = 0;
    this.wingAmp = lerp(0.26, 0.36, ctx.rng());
  }

  update(dt: number, ctx: MotionContext, pose: Pose, events: MotionEvents): void {
    this.next -= dt;
    if (this.next <= 0) {
      this.cueTail(ctx);
      if (ctx.rng() < lerp(0.3, 0.5, ctx.activity)) this.cueWing(ctx);
      this.next = lerp(1.6, 5.5, ctx.rng()) * lerp(1.15, 0.7, ctx.activity);
    }
    // 大转头 / 歪头回正后，延迟一点再甩，像是"看完了准备换姿态"
    if (events.saccades !== this.seenSaccades) {
      this.seenSaccades = events.saccades;
      if (events.lastSaccadeMagnitude > 35 * DEG && ctx.rng() < 0.3) this.pending = ctx.time + lerp(0.15, 0.3, ctx.rng());
    }
    if (events.tiltEnds !== this.seenTiltEnds) {
      this.seenTiltEnds = events.tiltEnds;
      if (ctx.rng() < 0.25) this.pending = ctx.time + lerp(0.1, 0.25, ctx.rng());
    }
    if (this.pending !== null && ctx.time >= this.pending) {
      this.cueTail(ctx);
      if (ctx.rng() < 0.5) this.cueWing(ctx);
      this.pending = null;
    }

    if (this.tailT < Infinity) {
      this.tailT += dt;
      const s = spring(this.tailT, 0.16, 0.35);
      pose.tail.pitch += this.tailAmp * s;
      pose.tail.yaw += this.tailYaw * s;
      pose.tail.spread += 0.25 * Math.max(0, s) * Math.exp(-this.tailT / 0.12);
      if (this.tailT > 0.6) this.tailT = Infinity;
    }
    if (this.wingT < Infinity) {
      this.wingT += dt;
      // 翅尖往上背方向轻弹（twist），翅下缘微微张开（lift），立刻收拢。
      // rebound 取 0：翅只往上、不压回体表以内——翼下绒毛只比羽片矮一点点，往里压一丝就会从黑羽上冒出来
      const f = flick(this.wingT, 0.045, 0.07, 0);
      for (const side of ['left', 'right'] as const) {
        pose.wing[side].twist += 0.22 * this.wingAmp * f;
        pose.wing[side].lift += this.wingAmp * f;
      }
      if (this.wingT > 0.3) this.wingT = Infinity;
    }
  }
}
