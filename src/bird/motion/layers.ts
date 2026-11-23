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
  tailFlicks: number;
  wingFlicks: number;
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

// 转头上限 52°：再大头身一体的圆团子会被拉出一圈“帽兜”一样的凹脸圈（山雀真实转头靠的是整条颈椎 + 身体跟随，不是脖子硬拧）
const YAW_LIMIT = 52 * DEG;
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

  /** 随机注视：多数在当前注视点附近小跳，偶尔看镜头；幅度 22°~46°（身体会顺着跟 25%~34%，不需要头硬拧到 90°+）。 */
  private pickRandom(ctx: MotionContext, events: MotionEvents): void {
    let yaw: number;
    let pitch: number;
    if (ctx.rng() < 0.12) {
      ({ yaw, pitch } = this.lookAngles(ctx, ctx.cameraWorld));
    } else {
      const mag = lerp(22, 46, ctx.rng()) * DEG;
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
 * 时而伴随双翅从肩头往背上方 90~130 ms 的大幅轻弹（下缘张开、翅尖上挑、微微展开）；
 * 大转头、歪头回正之后更容易来一下。
 */
export class FidgetLayer extends MotionLayer {
  private next = 2.5;
  private pending: number | null = null;
  private tailT = Infinity;
  private tailAmp = 0.35;
  private tailYaw = 0;
  private wingT = Infinity;
  private wingOpen = 0.11;
  private seenSaccades = 0;
  private seenTiltEnds = 0;

  cueTail(ctx: MotionContext, events: MotionEvents): void {
    this.tailT = 0;
    this.tailAmp = lerp(0.28, 0.45, ctx.rng());
    this.tailYaw = ctx.rng() < 0.4 ? (ctx.rng() - 0.5) * 0.2 : 0;
    events.tailFlicks++;
  }

  cueWing(ctx: MotionContext, events: MotionEvents): void {
    this.wingT = 0;
    this.wingOpen = lerp(0.08, 0.14, ctx.rng());
    events.wingFlicks++;
  }

  update(dt: number, ctx: MotionContext, pose: Pose, events: MotionEvents): void {
    this.next -= dt;
    if (this.next <= 0) {
      this.cueTail(ctx, events);
      if (ctx.rng() < lerp(0.3, 0.5, ctx.activity)) this.cueWing(ctx, events);
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
      this.cueTail(ctx, events);
      if (ctx.rng() < 0.5) this.cueWing(ctx, events);
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
      // 弹翅 = 翅微微张开（open 0.08~0.14：肩和腕仍埋在毛里，只有中后段与翅尖松开）配合后段往背上方轻抬，
      // 翅尖微挑（twist）、微微向外展（sweep），90~130 ms 干脆收拢。
      // 以前是整片翅绕肩刚性地抬 0.55~0.8 rad：前端会从肩毛里露出一个圆钝小头；
      // rebound 取 0：翅只往上、不压回体表以内——翼下绒毛只比羽片矮一点点，往里压一丝就会从黑羽上冒出来
      const f = flick(this.wingT, 0.045, 0.07, 0);
      for (const side of ['left', 'right'] as const) {
        pose.wing[side].open += this.wingOpen * f;
        pose.wing[side].flap += 0.2 * f;
        pose.wing[side].twist += 0.06 * f;
        pose.wing[side].sweep -= 0.08 * f;
      }
      if (this.wingT > 0.3) this.wingT = Infinity;
    }
  }
}

/** 展翅扑翼演示全程时长（秒）。 */
export const SPREAD_DURATION = 1.95;

/**
 * 展翅扑翼演示：0.5 s 把双翅从收拢平滑展开（三段 Z 字折叠链打开、飞羽折扇张成短圆的百褶扇），
 * 扑翼在展开的后半程就接上来（0.18 s 起扑、0.5 s 到满幅）：翅膀一边展开一边上扬，展满那一刻正好从上扬过渡进
 * 第一下下扑，中间不停顿；轻扑两下后（随扑翼微微前扫、翼面随之翻转）从最后一次上扬的顶点开始收拢（1.2 s 起 0.7 s），
 * 扑幅随收拢柔和回落，翅边收边落回体侧。期间身体微微下蹲前俯、尾羽略展，像是枝上扑棱一下整理羽毛。
 */
export class SpreadLayer extends MotionLayer {
  private t = Infinity;

  cue(): void {
    this.t = 0;
  }

  update(dt: number, ctx: MotionContext, pose: Pose): void {
    if (this.t === Infinity) return;
    this.t += dt;
    const t = this.t;
    if (t >= SPREAD_DURATION) {
      this.t = Infinity;
      return;
    }
    // 展翅度：0.5 s 展开、1.2 s 起收拢（收拢的起点对准最后一次上扬的顶点，见下面的相位）
    const open = minJerk(t / 0.5) * (1 - minJerk((t - 1.2) / 0.7));
    // 扑翼包络：展开的后半程起扑（0.18 ~ 0.5 s 升到满幅）、随收拢柔和回落（1.2 ~ 1.6 s）
    const env = minJerk((t - 0.18) / 0.32) * (1 - minJerk((t - 1.2) / 0.4));
    // 相位：0.2 s 从零往上扬、0.31 s 到顶（展开到六成时），展满（0.5 s）后紧接着第一下下扑；1.2 s 恰好又是上扬顶点
    const ph = (t - 0.2) * TAU * 2.25;
    const flap = (0.22 + 0.42 * Math.sin(ph)) * env;
    for (const side of ['left', 'right'] as const) {
      pose.wing[side].open += open;
      pose.wing[side].flap += flap;
      pose.wing[side].sweep += 0.1 * env + 0.06 * Math.sin(ph + 0.6) * env;
      pose.wing[side].twist += 0.1 * Math.sin(ph - 0.9) * env;
    }
    pose.body.pitch += 0.05 * open;
    pose.tail.spread += 0.35 * open;
    pose.tail.pitch += 0.1 * open;
    void ctx;
  }
}

/**
 * 扭扭身子（躯干重心联动）：大角度跳视转头时身体顺着转头方向柔和弹簧滞后跟随 25%~34%（头颈的相对转角回掉其中近一半）；
 * 甩尾、弹翅时身体前俯微蹲反冲一下再弹簧回稳。躯干绕脚踝抓握点转，双脚始终抓牢树枝。
 */
export class SwayLayer extends MotionLayer {
  private yaw = 0;
  private yawVel = 0;
  private pitchT = Infinity;
  private pitchAmp = 0.06;
  private seenTail = 0;
  private seenWing = 0;

  update(dt: number, ctx: MotionContext, pose: Pose, events: MotionEvents): void {
    // 跟随转头：欠阻尼弹簧（周期 0.4 s、阻尼比 0.75）半隐式积分，身体比头慢半拍
    const target = pose.head.yaw * lerp(0.25, 0.34, ctx.activity);
    const w = TAU / 0.4;
    this.yawVel += (-w * w * (this.yaw - target) - 1.5 * w * this.yawVel) * dt;
    this.yaw += this.yawVel * dt;
    pose.body.yaw += this.yaw;
    // 身体已经跟着转过去一部分，颈部的相对转角回掉这部分的一半：头身一体的圆团子大转头时才不会被拧出帽兜状的凹脸圈
    pose.head.yaw -= this.yaw * 0.45;

    // 甩尾 / 弹翅的反冲：前俯一下再弹回（弹翅幅度更大一些）
    if (events.tailFlicks !== this.seenTail) {
      this.seenTail = events.tailFlicks;
      this.pitchT = 0;
      this.pitchAmp = lerp(0.04, 0.07, ctx.rng());
    }
    if (events.wingFlicks !== this.seenWing) {
      this.seenWing = events.wingFlicks;
      this.pitchT = 0;
      this.pitchAmp = lerp(0.08, 0.12, ctx.rng());
    }
    if (this.pitchT < Infinity) {
      this.pitchT += dt;
      pose.body.pitch += this.pitchAmp * spring(this.pitchT, 0.3, 0.45);
      if (this.pitchT > 0.8) this.pitchT = Infinity;
    }
  }
}
