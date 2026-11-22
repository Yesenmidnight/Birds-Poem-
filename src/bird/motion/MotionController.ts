import { Quaternion, Vector3 } from 'three';
import { makeRng } from '../../util/math';
import { DEG } from './curves';
import { BlinkLayer, BreathLayer, FidgetLayer, GazeLayer, SpreadLayer, SwayLayer, type MotionContext, type MotionEvents, type MotionLayer } from './layers';
import { resetPose, restPose, type Pose } from './Pose';

/** 每帧由 App 提供的外部环境。 */
export interface MotionFrame {
  headWorld: Vector3;
  worldToLocal: Quaternion;
  cameraWorld: Vector3;
  /** 鼠标注视点（世界坐标），不在画面内为 null。 */
  gazeWorld: Vector3 | null;
}

export type MotionCue = 'saccade' | 'tilt' | 'blink' | 'nict' | 'tailFlick' | 'wingFlick' | 'spread';

/**
 * 微生命动作系统：呼吸、跳视/歪头、眨眼/瞬膜、甩尾/弹翅、扭身各自是一个独立的层，
 * 互不依赖，只通过跨层事件（跳视次数、歪头结束、甩尾/弹翅次数）松耦合；所有层写进同一个 Pose，
 * 再由 Bird.applyPose 统一驱动。节奏与幅度由活跃度统一调节。
 */
export class MotionController {
  enabled = true;
  /** 情绪活跃度 0..1。 */
  activity = 0.55;
  gazeMode: 'auto' | 'pointer' = 'auto';
  /** 调试：暂停时间推进，用于截图定格。 */
  paused = false;

  readonly pose: Pose = restPose();
  readonly events: MotionEvents = { saccades: 0, lastSaccadeMagnitude: 0, tiltEnds: 0, tailFlicks: 0, wingFlicks: 0 };
  readonly breath = new BreathLayer();
  readonly gaze = new GazeLayer();
  readonly blink = new BlinkLayer();
  readonly fidget = new FidgetLayer();
  readonly spread = new SpreadLayer();
  readonly sway = new SwayLayer();

  private readonly layers: MotionLayer[];
  private readonly rng = makeRng(20261122);
  private readonly ctx: MotionContext = {
    time: 0,
    activity: 0.55,
    rng: this.rng,
    gazeWorld: null,
    cameraWorld: new Vector3(),
    headWorld: new Vector3(),
    worldToLocal: new Quaternion(),
  };

  constructor() {
    // 扭身层放在最后：它读这一帧已经叠加好的头部转角和甩尾/弹翅事件
    this.layers = [this.breath, this.gaze, this.blink, this.fidget, this.spread, this.sway];
  }

  /** 每帧调用：推进时间并重新叠加出这一帧的 Pose。 */
  update(dt: number, frame: MotionFrame): Pose {
    this.ctx.time += dt;
    this.ctx.activity = this.activity;
    this.ctx.gazeWorld = this.gazeMode === 'pointer' ? frame.gazeWorld : null;
    this.ctx.cameraWorld.copy(frame.cameraWorld);
    this.ctx.headWorld.copy(frame.headWorld);
    this.ctx.worldToLocal.copy(frame.worldToLocal);
    if (!this.paused) this.step(dt);
    return this.pose;
  }

  /** 调试：以 1/120 s 步进 seconds 秒（截图定格动作用），环境沿用最近一帧。 */
  advance(seconds: number): void {
    const h = 1 / 120;
    for (let t = 0; t < seconds; t += h) {
      this.ctx.time += h;
      this.step(h);
    }
  }

  /** 调试：立刻触发一个动作。 */
  cue(kind: MotionCue): void {
    switch (kind) {
      case 'saccade':
        this.gaze.cueSaccade(this.gaze.holdYaw + 40 * DEG, this.gaze.holdPitch - 8 * DEG, this.events);
        break;
      case 'tilt':
        this.gaze.cueTilt(this.ctx, 1);
        break;
      case 'blink':
        this.blink.cueBlink(this.ctx);
        break;
      case 'nict':
        this.blink.cueNict();
        break;
      case 'tailFlick':
        this.fidget.cueTail(this.ctx, this.events);
        break;
      case 'wingFlick':
        this.fidget.cueWing(this.ctx, this.events);
        break;
      case 'spread':
        this.spread.cue();
        break;
    }
  }

  private step(dt: number): void {
    resetPose(this.pose);
    for (const layer of this.layers) layer.update(dt, this.ctx, this.pose, this.events);
  }
}
