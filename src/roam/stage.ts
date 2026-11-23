/**
 * 舞台给操控 / 相机控制器的全部外部依赖（阶段 5 解耦：控制器不再认识 TestRig，冬日庭院、大植物园各给一份）。
 * 一个舞台 = 碰撞世界 + 栖面查询 + 活动场地 + 景点 + 回栖点；画面（树枝、雪地、建筑）由舞台自己建，控制器只认这里的数据。
 */
import type { SimWorld } from '../sim/world';
import type { Surface } from '../sim/surface';
import type { CurvePerch } from '../sim/curvePerch';
import type { FlySpot } from '../sim/autopilot';
import type { Perch } from '../bird/parts';
import type { Limb } from '../world/Branch';

/** 栖面查询：落地那一刻脚爪贴的是画面上那个面（树皮鼓包 + 雪帽 + 脚下雪坑），不是碰撞体的光滑圆柱。 */
export interface StagePerches {
  /** 曲线表面属于哪根子枝（不是树的枝 = null）。 */
  limbOf(surface: CurvePerch): Limb | null;
  /** 表面的布局标签（'branch' = 主角枝，走 perchAt）。 */
  tagOf(surface: Surface): string | null;
  /** 主角枝上世界 x 处的精确栖面。 */
  perchAt(worldX: number): Perch;
  /** 子枝上弧长 u 处的精确栖面。 */
  limbPerch(limb: Limb, u: number): Perch;
  /**
   * 栖面交互钩子（2026-11-23，可选）：由画面层自己算弯曲的栖面（庭院主角枝：悬臂梁模态在 CPU 推进、位移在着色器里叠加，
   * 碰撞体本身是刚性 CurvePerch）。操控层按步态相位调用它——落地 / 蹬离给冲量、蓄力时预压、鸟根每帧跟着它的弯曲位移走；
   * 震雪粉、果梗单摆这些微交互也在这里接。没给 = 栖面不弯（调试台 / 城市入口）。
   */
  interact?: StagePerchInteract;
}

/** 主角枝这类画面层弯曲的栖面：操控层（Player）按步态相位调用的四个钩子，worldX 都是世界坐标厘米。 */
export interface StagePerchInteract {
  /** 落到 surface 上（步态落定 / 飞行落定）：impact = 法向冲击速度（厘米 / 秒）。 */
  land(surface: Surface, worldX: number, impact: number): void;
  /** 离开 surface 腾空：pushSpeed = 蹬离的等效蹬速（0 = 走出边缘掉下去，不是蹬的）。 */
  leave(surface: Surface, worldX: number, pushSpeed: number): void;
  /** 蹲伏蓄力中：k = 步态的蹲伏量 0..1，按它预压枝条。 */
  crouch(surface: Surface, worldX: number, k: number): void;
  /** surface 在 worldX 处此刻相对落定那一刻的竖直弯曲位移（厘米）：鸟根跟着它走。 */
  lift(surface: Surface, worldX: number): number;
}

/** "回到栖枝"：重置时鸟群的位姿、步态落点查询位置和朝向、主角枝上对应的 x。 */
export interface StageHome {
  /** 鸟群原点（局部 +Z = 喙）和绕竖直的偏航（弧度）。 */
  root: { x: number; y: number; z: number; yaw: number };
  /** 步态 place 的查询点（根上方一点）和朝向。 */
  query: { x: number; y: number; z: number; hx: number; hz: number };
  /** 主角枝上对应的 x（栖面查询用）。 */
  perchX: number;
}

export interface Stage {
  /** 纯数学碰撞世界。 */
  world: SimWorld;
  perches: StagePerches;
  /** 活动场地：软边界 / 风墙的中心 (x, z) 与半边长（厘米；radiusZ 不填 = 正方形）、虚空兜底高度 voidY、兜底放回高度 y。 */
  bounds: { x: number; y: number; z: number; radius: number; radiusZ?: number; voidY: number };
  /** 自由巡飞的景点表和雪面基准高度（自动驾驶算离地高度用）。 */
  flySpots: FlySpot[];
  groundY: number;
  /** "回到栖枝"。 */
  home: StageHome;
}

/**
 * 气流尾迹：控制器每帧喂给舞台（大植物园的草浪 / 树叶着色器读它）。全部是世界坐标 / 厘米每秒。
 * 扑翼相位和展翅度直接取 Flight 的表现量；地面蹦跳时 flapping 为 false、wingOpen 是助推抖翅的量（0 或抖动中）。
 */
export interface Wake {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  speed: number;
  /** 扑翼相位（弧度，14 Hz 连续累计）。 */
  flapPhase: number;
  /** 展翅度 0..1。 */
  wingOpen: number;
  flapping: boolean;
  flying: boolean;
}

export function makeWake(): Wake {
  return { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, speed: 0, flapPhase: 0, wingOpen: 0, flapping: false, flying: false };
}
