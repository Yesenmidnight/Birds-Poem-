/**
 * 可复用的小鸟控制器（阶段 5 解耦）：把"步态 / 飞行操控 + 三档锁定视角 / 自由环绕避障相机 + 准星 + AI 自动巡飞"从 RoamApp 抽出来，
 * 冬日庭院、大植物园各建一份，只依赖舞台给的 Stage（碰撞世界 / 栖面查询 / 活动场地 / 景点 / 回栖点）和 Bird / MotionController。
 *
 * 每帧两步（夹着鸟的更新）：
 *   beforePlayer(dt)   —— orbit 管线先处理鼠标 / 阻尼（OrbitControls 从相机当前位置反算轨道，要在第一人称改写相机之后先放回去）；
 *   update(dt, base)   —— 镜头方向 → Player（步态 / 飞行）→ orbit 管线收尾 + 这一帧真正的机位 + 准星，最后发气流尾迹 onWake。
 * 按键：V 三档视角循环、G 自由巡飞开关（H 面板归应用外壳）；操控键本身在 Player 里。
 * 气流尾迹 Wake：鸟的世界坐标 / 速度 / 扑翼相位 / 展翅度，供大植物园的草浪和树叶着色器读（每帧覆盖同一个对象，不分配）。
 */
import { type PerspectiveCamera, type Vector3, type WebGLRenderer } from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Bird } from '../bird/Bird';
import type { MotionController } from '../bird/motion/MotionController';
import type { Pose } from '../bird/motion/Pose';
import type { ViewMode } from './CameraRig';
import { CameraRig } from './CameraRig';
import { Player } from './Player';
import { makeWake, type Stage, type Wake } from './stage';

export class BirdController {
  readonly player: Player;
  readonly cam: CameraRig;
  /** 每帧的气流尾迹（世界坐标 / 厘米每秒 / 扑翼相位 / 展翅度）：舞台挂 onWake 来读。 */
  readonly wake: Wake = makeWake();
  onWake: ((w: Wake) => void) | null = null;
  /** 镜头水平视线（地面 WASD 用），常驻。 */
  private readonly dir = { x: 0, z: -1 };
  private readonly motion: MotionController;

  constructor(bird: Bird, stage: Stage, motion: MotionController, camera: PerspectiveCamera, controls: OrbitControls, renderer: WebGLRenderer, domParent: HTMLElement) {
    this.motion = motion;
    this.player = new Player(bird, stage, motion);
    this.cam = new CameraRig(camera, controls, renderer, bird, this.player, stage.world, domParent);
    window.addEventListener('keydown', this.onKeyDown);
  }

  get viewMode(): ViewMode {
    return this.cam.viewMode;
  }

  /** 开关操控。开：从鸟现在站的地方接着控制；关：回到舞台的栖点。 */
  setEnabled(on: boolean): void {
    this.player.setEnabled(on);
    if (!on) return;
    // 操控开着时动作系统的注视跟着准星走（MotionController 只在 pointer 模式读 gazeWorld）；关了留给面板的随机注视
    this.motion.gazeMode = 'pointer';
    // 镜头从 orbit 机位过渡到当前档位（默认追尾），不一帧跳过去
    this.cam.reblend();
  }

  /** 自由巡飞开关（G 键 / 面板）：开 = 飞行交给自动驾驶、相机切成不自动回正的第三人称自由环绕、距离退到观赏距离。 */
  setAuto(on: boolean): void {
    if (on === this.player.auto) return;
    this.player.setAuto(on);
    this.cam.setAutoCamera(on);
  }

  /** V 键 / 面板：追尾 → 过肩 → 纯第一人称 循环。 */
  toggleView(): void {
    this.cam.cycleView();
  }

  setViewMode(mode: ViewMode): void {
    this.cam.setViewMode(mode);
  }

  /** 每帧第一步（鸟更新之前）。 */
  beforePlayer(dt: number): void {
    this.cam.beforePlayer(dt);
  }

  /** 操控开着时每帧第二步（鸟的动作系统更新之后）：推进操控、合成机位、发尾迹。 */
  update(dt: number, base: Pose | null): void {
    const p = this.player;
    this.cam.cameraDirection(this.dir);
    p.camDirX = this.dir.x;
    p.camDirZ = this.dir.z;
    p.faceYaw = this.cam.faceYawForPlayer();
    if (p.flying && p.camSteer) this.cam.steerFlight();
    p.update(dt, base);
    this.cam.afterPlayer(dt);
    // 气流尾迹：飞行取 Flight 的根 / 速度 / 表现量；地面蹦跳取步态的根 / 速度，翅是助推抖动 / 落地收翅的量
    const w = this.wake;
    if (p.flying) {
      const f = p.flight;
      w.x = f.pos.x;
      w.y = f.pos.y;
      w.z = f.pos.z;
      w.vx = f.vel.x;
      w.vy = f.vel.y;
      w.vz = f.vel.z;
      w.speed = f.speed;
      w.flapPhase = f.flapPhase;
      w.wingOpen = f.wingOpen;
      w.flapping = f.flapping;
      w.flying = true;
    } else {
      const l = p.loco;
      w.x = l.pos.x;
      w.y = l.pos.y;
      w.z = l.pos.z;
      w.vx = l.vel.x;
      w.vy = l.vel.y;
      w.vz = l.vel.z;
      w.speed = Math.hypot(l.vel.x, l.vel.y, l.vel.z);
      // 地面蹦跳的"扑翼相位"：站着不动不推；蹦起来 / 蹬伸 / 有速度时按速度推进（气流着色器用它做翼下气柱的颤动和拨草尾流）
      const moving = w.speed > 15 || l.phase === 'air' || l.phase === 'push';
      if (moving) this.groundPhase = (this.groundPhase + dt * (2 + Math.min(w.speed, 150) / 45)) % 1;
      w.flapPhase = this.groundPhase * Math.PI * 2;
      w.wingOpen = Math.max(p.wingOpenNow, l.phase === 'push' || l.phase === 'air' ? 0.4 : moving ? 0.15 : 0);
      w.flapping = false;
      w.flying = false;
    }
    this.onWake?.(w);
  }

  /** 地面蹦跳时推进的扑翼相位（周期数 0..1；站着不动时停住）。 */
  private groundPhase = 0;

  /** 注视目标（世界坐标，离头 80 cm）：准星在偏的时候鸟头先朝它看（喂给动作系统的 gazeWorld）；准星回正了返回 null。 */
  gazeTarget(headWorld: Vector3, out: Vector3): Vector3 | null {
    return this.cam.gazeTarget(headWorld, out);
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (!this.player.enabled) return;
    if (e.code === 'KeyV') this.toggleView();
    else if (e.code === 'KeyG') this.setAuto(!this.player.auto);
  };
}
