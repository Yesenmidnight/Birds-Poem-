import type { TailPose, WingPose } from '../Bird';

/**
 * 所有动作层叠加写入的中间姿态，每帧由 Bird.applyPose 统一驱动各部件。
 * 角度全是弧度；闭睑、瞬膜、呼吸是 0..1 的量。动作层只往里加（眼睑取最大），互不感知，
 * 节奏与幅度由 MotionController 按活跃度统一调节。
 */
/** 躯干微姿态（弧度）：绕脚踝抓握点转，双脚始终抓牢树枝；pitch 前俯为正，yaw 与头同一方向。 */
export interface BodyPose {
  pitch: number;
  yaw: number;
  roll: number;
}

export interface Pose {
  head: { yaw: number; pitch: number; roll: number };
  /** 闭睑 0..1、眯眼 0..1、瞬膜扫过 0..1 */
  eye: { lidClose: number; squint: number; nict: number };
  /** 张嘴弧度 */
  jaw: number;
  wing: { left: Required<WingPose>; right: Required<WingPose> };
  tail: Required<TailPose>;
  /** 吸气量 0..1，驱动胸腹微膨胀 */
  breath: number;
  body: BodyPose;
}

export function restPose(): Pose {
  return {
    head: { yaw: 0, pitch: 0, roll: 0 },
    eye: { lidClose: 0, squint: 0, nict: 0 },
    jaw: 0,
    wing: {
      left: { open: 0, flap: 0, sweep: 0, twist: 0 },
      right: { open: 0, flap: 0, sweep: 0, twist: 0 },
    },
    tail: { pitch: 0, yaw: 0, roll: 0, spread: 0 },
    breath: 0,
    body: { pitch: 0, yaw: 0, roll: 0 },
  };
}

/** 就地清零（每帧开头调用，避免分配）。 */
export function resetPose(p: Pose): void {
  p.head.yaw = p.head.pitch = p.head.roll = 0;
  p.eye.lidClose = p.eye.squint = p.eye.nict = 0;
  p.jaw = 0;
  for (const side of ['left', 'right'] as const) {
    p.wing[side].open = 0;
    p.wing[side].flap = 0;
    p.wing[side].sweep = 0;
    p.wing[side].twist = 0;
  }
  p.tail.pitch = p.tail.yaw = p.tail.roll = p.tail.spread = 0;
  p.breath = 0;
  p.body.pitch = p.body.yaw = p.body.roll = 0;
}
