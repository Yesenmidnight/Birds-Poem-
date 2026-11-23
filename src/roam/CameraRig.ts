/**
 * 第三人称 / 第一人称相机控制器（阶段 5）。从 RoamApp 抽出来，和 BirdController 一起可以挂到任何舞台（只认 Bird / Player / 碰撞世界）：
 *  - orbit：OrbitControls 自由环绕（自由巡飞观赏、调试台预设机位）：跟随点平滑追鸟、相机避障、（操控开时）按键 / 飞行自动绕到鸟背后；
 *  - chase（默认）：锁定追尾——相机挂在视角方位 viewYaw 的后上方（22~28 cm，FOV 58），不走 Orbit；地面上竖直只跟地形的大起伏（低通），
 *    每跳 2~5 cm 的上下留给鸟在画面里雀跃、地平线不晃；飞行跟着机体俯仰、坡度微倾；
 *  - shoulder：第一人称过肩——鸟群局部后上方往前看，画面底部只露头顶 + 上肩 + 双翼根部；
 *  - eye：纯第一人称——两眼之间（FOV 84），藏掉身体。
 * 旋转模型（2026-11-23 用户要求 360° 全向）：viewYaw（世界方位，无上限）/ viewPitch 是唯一的真源，三档机位都挂在 viewYaw 上——
 * Pointer Lock 移鼠标 360° 无限转，没锁定时左键拖拽也转，不回正、没有左右空气墙；"看哪走哪"：地面 W 朝 viewYaw 跳、S 背对它后撤、
 * 枝上 W+空格 朝它跃离；飞行中鸟按最短角差压坡追 viewYaw，A/D 键盘 / 边界转弯时视角跟着航向走；鸟头 gaze 先朝视角看。
 * V 在 chase → shoulder → eye 间循环，切换 VIEW_BLEND_TIME 秒丝滑过渡（位姿插值 + FOV / 近裁面平滑）。
 * 准星：Pointer Lock 时在画面中心画一个半透明小圆点。
 */
import { Euler, type PerspectiveCamera, Quaternion, Vector3, type WebGLRenderer } from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Bird } from '../bird/Bird';
import { clamp } from '../util/math';
import { makeContact, type Surface } from '../sim/surface';
import { CurvePerch, makeCurveFrame } from '../sim/curvePerch';
import type { SimWorld } from '../sim/world';
import type { Player } from './Player';

/** 第三人称机位的竖直视场角（度）。比观鸟的 28° 略宽，飞行时视野够用，近看鸟又不太变形。 */
const FOV = 34;
/** 相机跟随的平滑系数（1 / 秒）。 */
const FOLLOW_RATE = 22;
/** 相机避障：相机离枝条 / 树干 / 雪面至少这么远（厘米；相机近裁面 0.5）。 */
const CAMERA_CLEAR = 0.8;
/** 障碍让开后相机放回轨道半径的平滑系数（1 / 秒）；拉近是立刻的，不许穿帮。 */
const CAMERA_RELEASE = 6;
/** 避障把相机往鸟身边拉的硬下限（厘米，从轨道目标点 = 躯干中心量）：再近就怼进绒毛里糊满全屏，还会触发近景满壳层。 */
const CAMERA_MIN_DIST = 8.5;
/** 相机只躲半径不小于这个值的枝条（厘米）+ 建筑盒体 + 雪地；细枝 / 细线不挡视线。 */
const CAMERA_MIN_RADIUS = 1;
/** 第三人称跟随：按着键 / 转身时相机绕到鸟背后的速率（1 / 秒）和靠到的俯仰角（弧度，往上抬）；飞行中慢一些（鼠标拖开能多看一会儿）。 */
const FOLLOW_TURN = 6;
const FLIGHT_CAM_TRAIL = 1;
const FOLLOW_ELEV = 0.3;
/** 飞行时跟随点往前多看的量 = 相机距离 × 这个系数（鸟落在画面中心偏下约 atan(0.12) ≈ 7°）。 */
const FLIGHT_LEAD_K = 0.12;
/** 飞行距离靠到 flightDist 的速率（1 / 秒）：起飞那一下要从枝上的 15 cm 很快退到 70 cm，不然相机贴着一只在加速的鸟。 */
const FLIGHT_DIST_RATE = 4;
/** orbit 模式的鼠标视线引导：镜头偏离"鸟背后 / FOLLOW_ELEV"不到死区（弧度）不转；方位偏到 LOOK_FULL 满舵；抬高 / 压低到 LOOK_DIVE / LOOK_CLIMB 满幅俯仰。 */
const LOOK_DEAD = 0.14;
const LOOK_FULL = 0.6;
const LOOK_CLIMB = 0.35;
const LOOK_DIVE = 0.6;

/** 视角模式：chase = 锁定追尾（默认，地面和飞行都用它）；shoulder = 第一人称过肩；eye = 纯第一人称；orbit = OrbitControls 自由环绕（自由巡飞 / 调试机位，不进 V 循环）。 */
export type ViewMode = 'chase' | 'shoulder' | 'eye' | 'orbit';
/** 这一帧实际在用的机位。 */
type ViewNow = ViewMode;
const VIEW_CYCLE: ViewMode[] = ['chase', 'shoulder', 'eye'];
const UP = new Vector3(0, 1, 0);

/** 锁定追尾：相机在视角方位的后方这么远（厘米，滚轮 16~60 可调）、默认仰角（相机在锚点上方这么多：和原来的 8 cm 抬高等价）。 */
const CHASE_DIST = 26;
const CHASE_LIFT = 8;
const CHASE_EL = Math.atan2(CHASE_LIFT, CHASE_DIST);
/** 视角俯仰能带着追尾相机绕到锚点下方 / 上方的极限（弧度）：往下看接近俯视，往上看从 below 看（相机贴地由避障拉回来）。 */
const CHASE_EL_MIN = -0.5;
const CHASE_EL_MAX = 1.35;
const CHASE_FOV = 58;
/** 追尾的锚点水平位置 / 竖直位置的平滑系数（1 / 秒）：地面竖直只跟脚下地面的高度（腾空的抛物线根本不进来，见 chasePose），
 *  所以可以跟得快（τ 0.12 s：跳上雪垄 / 栏杆时镜头及时抬起来）；飞行竖直 τ 0.1 s（爬升俯冲要跟）；机体俯仰只跟 45%（平滑），坡度只跟 25%。 */
const CHASE_XZ_RATE = 22;
const CHASE_Y_RATE_GROUND = 8;
const CHASE_Y_RATE_FLY = 10;
const CHASE_PITCH_RATE = 6;
const CHASE_ROLL = 0.25;
/** Shift 冲刺时叠在追尾 / 过肩 / 第一人称 FOV 上的动态扩张（度）：提速的推背感。 */
const BOOST_FOV = 5;
/** 第一人称过肩机位：鸟群局部坐标（+Z 喙、+Y 上、原点在两脚之间），在尾根上方往前看——头顶只占画面下缘约 20%，
 *  肩和翼根在画面底部两角，前视开阔；离背 7 cm 外，不会钻进绒毛壳层看见"洋葱皮"。 */
const SHOULDER_LOCAL = new Vector3(0, 7.9, -7.2);
/** 过肩镜头相对机体的俯仰偏置（弧度）：略仰 3°，头顶弧顶压到画面 80% 处（鸟身只占下缘 20%），地平线在 79% 附近。 */
const SHOULDER_PITCH = 0.05;
const SHOULDER_FOV = 70;
/** 纯第一人称：两眼之间、略靠前（眼在 (±0.45, 3.48, 1.22)）。 */
const EYE_LOCAL = new Vector3(0, 3.6, 1.2);
const EYE_FOV = 84;
/** 藏 / 露身体的门限（镜头离眼点的距离，厘米）：进第一人称是"飞进头里"——进到这么近才藏，不是一按键鸟就消失；
 *  离开时走出这么远再露出来（再早会从身体里穿帮）。取 12：追尾 ↔ 第一人称时鸟在画面里约占 40% 的那一刻藏 / 露
 *  （7 cm 时约 60%，跳变更明显）；过肩机位离眼 9.4 cm < 门限，所以过肩 → 第一人称一按键就藏（只少了画面底部 19% 的头顶）、
 *  第一人称 → 过肩走到过渡结束才露。过肩机位 (0, 7.9, −7.2) 本身就在绒毛壳层包络外（背壳最远 0.5 cm），不需要近端裁剪——
 *  绒毛是 ShaderMaterial，three 只在 material.clipping === true 且着色器带 clipping 块时才裁，fur.ts 的着色器字符串是锁死的，
 *  裁剪面挂上去是空操作（试过）。 */
const EYE_HIDE_DIST = 12;
/** 第一人称的近裁面（厘米）：过肩机位离翼根只有 7 cm。 */
const FP_NEAR = 0.15;
/** 视角切换的过渡时长（秒）。 */
const VIEW_BLEND_TIME = 0.45;
/** 第一人称镜头的滚转只跟坡度的这个比例（防晕 3D）。 */
const CAM_ROLL = 0.3;
/** 第一人称镜头俯仰 / 滚转跟机体的平滑系数（1 / 秒）：滤掉扑翼波浪的高频抖动。 */
const FP_PITCH_RATE = 8;
const FP_ROLL_RATE = 6;
/** Pointer Lock 鼠标灵敏度（弧度 / 像素）；没锁定时左键拖拽的灵敏度（拖满屏约转 150°）。 */
const LOOK_SENS = 0.0022;
const DRAG_SENS = 0.005;
/** 视角俯仰的范围（弧度，正 = 往上看）：往下能看到自己的脚，往上看到天顶附近。 */
const VIEW_PITCH_UP = 0.95;
const VIEW_PITCH_DOWN = -1.25;
/** 视角方位偏离机头多少弧度以内不转（鼠标是直接指着视角的，死区比第三人称的小）。 */
const FP_LOOK_DEAD = 0.04;
/** 自动巡飞的观赏距离（厘米）：34° 视场下 80 cm 处鸟约占画面 1/10，看得清姿态又不失场景。 */
const AUTO_DIST = 45;
/** 追尾相机锚点在鸟群局部的高度（躯干中心）。 */
const ANCHOR_LOCAL_Y = 2.8;

export class CameraRig {
  viewMode: ViewMode = 'chase';
  /** 跟随机位开关（调试台定格截图时关掉，摆好的机位不会被拉回鸟背后）。 */
  camFollow = true;
  /** 飞行距离（orbit 模式，滚轮调）。 */
  flightDist = 70;
  /** 追尾距离（厘米，滚轮调）。 */
  chaseDist = CHASE_DIST;
  /** 过肩机位（公开：截图脚本调构图）。 */
  shoulderLocal = SHOULDER_LOCAL.clone();
  shoulderPitch = SHOULDER_PITCH;
  eyeLocal = EYE_LOCAL.clone();
  /** 视角方位（世界，atan2(x, z) 约定，正 = 往左；无上限，每帧绕回 ±π）和俯仰（弧度，正 = 往上看）：三档机位的唯一真源。 */
  viewYaw = 0;
  viewPitch = 0;
  /** Pointer Lock 锁着（准星显示、鼠标直接转视角）。 */
  locked = false;

  private readonly camera: PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly bird: Bird;
  private readonly player: Player;
  private readonly world: SimWorld;
  private viewNow: ViewNow = 'chase';
  private viewBlend = 1;
  private lastManual: ViewMode = 'chase';
  /** 换档过渡的起点，记成相对鸟的局部量（位置相对鸟群原点、朝向相对航向）：飞行中 0.45 s 鸟能飞出 300 cm，
   *  固定世界起点会让镜头从原地慢慢插值去追、中途掉队 100 多厘米鸟飞出画面（第一版就这样）。 */
  private readonly viewFromLocal = new Vector3();
  private readonly viewFromQuatLocal = new Quaternion();
  private readonly fromPos = new Vector3();
  private readonly fromQuat = new Quaternion();
  /** 上一帧真正渲染出去的机位（每帧 beforePlayer 开头存，那时相机还没被还原成 orbit 机位）。换档的过渡要从这里起步：
   *  不能拿 updateView 那一刻的 camera.position——它已经是 orbit 机位了（追尾 → 过肩会从几十厘米外的 orbit 相机飞过来）。 */
  private readonly lastPos = new Vector3();
  private readonly lastQuat = new Quaternion();
  /** 同一时刻鸟群原点的位置和航向方位（算相对量用：上一帧的相机位要配上一帧的鸟，不然混进一帧的位移）。 */
  private readonly lastBirdPos = new Vector3();
  /** 开操控时立的标记：下一帧 updateView 从 lastPos 重新过渡到当前档位。 */
  private pendingReblend = false;
  /** 这一段过渡的时长（秒）：换档 0.45；外部舞台开操控时可以传自己的时长（庭院的对焦拉环是 0.6，镜头和散景同步收） */
  private blendTime = VIEW_BLEND_TIME;
  private readonly orbitPos = new Vector3();
  private readonly orbitQuat = new Quaternion();
  private readonly camTargetPos = new Vector3();
  private readonly camTargetQuat = new Quaternion();
  private readonly camEuler = new Euler(0, 0, 0, 'YXZ');
  private fpPitch = 0;
  private fpRoll = 0;
  private fovNow = FOV;
  private nearNow = 0.5;
  private bodyHidden = false;
  private bodyHiddenApplied = false;
  // 追尾：锚点、平滑后的机体俯仰、滚转
  private chasePitchBody = 0;
  private chaseRollNow = 0;
  private readonly chaseAnchor = new Vector3();
  /** 地面上锚点的竖直目标 = 脚下地面的高度（根贴地时的锚点高度；腾空时保持）。 */
  private groundAnchorY = 0;
  private chaseInit = false;
  /** 上一帧还在飞：飞行 → 落地那一帧锚点竖直直接贴回鸟（俯冲时速度前馈把锚点压到鸟下方 60 多厘米，地面低通要好几秒才回来）。 */
  private wasFlying = false;
  // 跟随点：平滑后的跟随点和上一帧的它（差量同时加到 orbit 的目标和相机上，视角偏移不变）
  private readonly followPoint = new Vector3();
  private readonly followPrev = new Vector3();
  private readonly followTarget = new Vector3();
  private followInit = false;
  // 相机避障：这一帧实际用的"目标 → 相机"长度比例（1 = 轨道半径上）、比例上的满距离位置、最近表面查询
  camPull = 1;
  private readonly camProbe = new Vector3();
  private readonly camFrame = makeCurveFrame();
  /** 下限和障碍冲突时绕竖直轴挪开的方位角（弧度）和那时的相机偏移。 */
  private camSlide = 0;
  private readonly camSlideV = new Vector3();
  /** 跟随机位：目标 → 相机的偏移；上一帧鸟的航向（算这一帧转了多少）；orbit 更新前的轨道半径（认出用户缩放）。 */
  private readonly camOff = new Vector3();
  private readonly lastHeading = new Vector3(0, 0, -1);
  private camLenBefore = 0;
  private lastHeadingAz = 0;
  private lookInit = false;
  /** 没锁定鼠标时的左键拖拽：按着、上一次的位置、拖了多远（拖过就不当点击处理，不然一松手就锁鼠标）。 */
  private dragging = false;
  private dragX = 0;
  private dragY = 0;
  private dragMoved = 0;
  private readonly scratch = new Vector3();
  private readonly scratch2 = new Vector3();
  /** 相机避障的最近表面查询结果和这一帧的拉近比例（截图脚本读）。 */
  readonly camContact = makeContact();
  readonly camFull = new Vector3();
  private readonly reticle: HTMLElement;
  private readonly canvas: HTMLElement;

  constructor(camera: PerspectiveCamera, controls: OrbitControls, renderer: WebGLRenderer, bird: Bird, player: Player, world: SimWorld, domParent: HTMLElement) {
    this.camera = camera;
    this.controls = controls;
    this.bird = bird;
    this.player = player;
    this.world = world;
    this.viewYaw = Math.atan2(player.headingX, player.headingZ);
    this.lastHeadingAz = this.viewYaw;
    this.lookInit = true;

    this.canvas = renderer.domElement;

    // 准星：一个半透明的小圆环（Pointer Lock 时显示），位置跟着准星偏置走
    this.reticle = document.createElement('div');
    const s = this.reticle.style;
    s.position = 'fixed';
    s.left = '0';
    s.top = '0';
    s.width = '12px';
    s.height = '12px';
    s.margin = '-6px 0 0 -6px';
    s.border = '1.5px solid rgba(255,255,255,0.55)';
    s.borderRadius = '50%';
    s.boxShadow = '0 0 3px rgba(0,0,0,0.6), inset 0 0 2px rgba(0,0,0,0.3)';
    s.pointerEvents = 'none';
    s.display = 'none';
    s.zIndex = '5';
    domParent.appendChild(this.reticle);

    const canvas = this.canvas;
    // Pointer Lock：点一下画面就锁定鼠标，移动鼠标直接转视角（360° 无限转）；Esc 退出后左键拖拽也能转
    canvas.addEventListener('click', () => {
      if (this.dragMoved > 4) {
        this.dragMoved = 0;
        return;
      }
      if (!this.player.enabled || this.viewMode === 'orbit' || document.pointerLockElement === canvas) return;
      canvas.requestPointerLock();
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
    });
    document.addEventListener('mousemove', (e) => {
      if (this.locked) {
        this.turnView(-e.movementX * LOOK_SENS, -e.movementY * LOOK_SENS);
      } else if (this.dragging) {
        const dx = e.clientX - this.dragX;
        const dy = e.clientY - this.dragY;
        this.dragX = e.clientX;
        this.dragY = e.clientY;
        this.dragMoved += Math.abs(dx) + Math.abs(dy);
        this.turnView(-dx * DRAG_SENS, -dy * DRAG_SENS);
      }
    });
    // 没锁定时左键拖拽转视角（orbit 模式归 OrbitControls）
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !this.player.enabled || this.viewMode === 'orbit' || this.locked) return;
      this.dragging = true;
      this.dragX = e.clientX;
      this.dragY = e.clientY;
      this.dragMoved = 0;
    });
    window.addEventListener('pointerup', (e) => {
      if (e.button === 0) this.dragging = false;
    });
    // 鼠标右键 = 收力滑翔（和 C 键一样；Shift 是冲刺）；追尾模式下滚轮调追尾距离（orbit 模式的滚轮归 OrbitControls）
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button === 2) this.player.glideHold = true;
    });
    canvas.addEventListener('pointerup', (e) => {
      if (e.button === 2) this.player.glideHold = false;
    });
    canvas.addEventListener('wheel', (e) => {
      if (this.viewMode !== 'chase') return;
      this.chaseDist = clamp(this.chaseDist + e.deltaY * 0.02, 16, 60);
    }, { passive: true });
    window.addEventListener('blur', () => (this.player.glideHold = false));
  }

  get viewBlendNow(): number {
    return this.viewBlend;
  }

  get viewNowName(): ViewNow {
    return this.viewNow;
  }

  get bodyHiddenNow(): boolean {
    return this.bodyHidden;
  }

  /** V 键：chase → shoulder → eye 循环（自由巡飞的 orbit 不在循环里，按 V 先接管回手动再切）。 */
  cycleView(): void {
    if (this.player.auto) this.player.setAuto(false);
    const i = VIEW_CYCLE.indexOf(this.viewMode === 'orbit' ? this.lastManual : this.viewMode);
    this.setViewMode(VIEW_CYCLE[(i + 1) % VIEW_CYCLE.length] ?? 'chase');
  }

  /** 操控从关到开：镜头从现在 orbit 的位置过渡到当前档位（默认追尾在鸟后上方 26 cm），不要一帧跳过去。
   *  只立个标记，起点在下一帧 updateView 里取（那时 start() 的预设机位已经摆好）。 */
  reblend(time = VIEW_BLEND_TIME): void {
    this.pendingReblend = true;
    this.blendTime = time;
    // FOV / 近裁面的过渡也从镜头现在的值起步：外部舞台在 orbit 模式下按距离改过 FOV（庭院观鸟态微距是 28°），
    // 不同步的话开操控的第一帧先跳回 orbit 的 34°、再爬到追尾的 58°
    this.fovNow = this.camera.fov;
    this.nearNow = this.camera.near;
  }

  setViewMode(mode: ViewMode): void {
    this.viewMode = mode;
    this.blendTime = VIEW_BLEND_TIME;
    if (mode !== 'orbit') this.lastManual = mode;
  }

  /** 自由巡飞的相机部分：开 = orbit 自由环绕、距离退到观赏距离；关 = 回到上一次的手动视角。 */
  setAutoCamera(on: boolean): void {
    this.viewMode = on ? 'orbit' : this.lastManual;
    if (on) this.flightDist = AUTO_DIST;
  }

  /** 预设机位（调试台 / bench 的 tp* 等，orbit 模式）。 */
  setView(az: number, el: number, dist: number, target: [number, number, number]): void {
    this.followInit = false;
    this.controls.target.set(target[0], target[1], target[2]);
    const c = Math.cos(el);
    this.camera.position.set(target[0] + dist * c * Math.sin(az), target[1] + dist * Math.sin(el), target[2] + dist * c * Math.cos(az));
    this.controls.update();
    this.orbitPos.copy(this.camera.position);
    this.orbitQuat.copy(this.camera.quaternion);
    this.chaseInit = false;
  }

  private headingAzimuth(): number {
    return Math.atan2(this.player.headingX, this.player.headingZ);
  }

  /**
   * 每帧第一步（鸟更新之前）：OrbitControls 从上一帧的轨道结果出发处理鼠标 / 阻尼，然后（操控开着）跟到鸟背后。
   * OrbitControls 是从相机当前位置反算轨道的：第一人称上一帧改写过相机，先把 orbit 管线自己的结果放回去。
   * 操控关着（调试台预设机位）时只做前两步，机位全归 OrbitControls。
   */
  beforePlayer(dt: number): void {
    // 上一帧渲染出去的机位（操控关着 = orbit 机位；开着 = updateView 末尾写进去的档位机位），换档 / 开操控的过渡从这里起步
    this.lastPos.copy(this.camera.position);
    this.lastQuat.copy(this.camera.quaternion);
    this.lastBirdPos.copy(this.bird.group.position);
    this.camera.position.copy(this.orbitPos);
    this.camera.quaternion.copy(this.orbitQuat);
    if (this.player.enabled) this.restoreCamera();
    this.camLenBefore = this.camera.position.distanceTo(this.controls.target);
    this.controls.update();
    if (!this.player.enabled) {
      this.saveOrbit();
      return;
    }
    // 用户滚轮缩放（orbit 改了轨道半径）：飞行距离跟着改，不然下一帧又被拉回 70 cm
    const lenNow = this.camera.position.distanceTo(this.controls.target);
    if (Math.abs(lenNow - this.camLenBefore) > 1e-4) this.flightDist = Math.min(150, Math.max(25, lenNow));
    // 相机自动跟到鸟背后（飞行中 / 按着键 / 转身时）；自动巡飞是自由环绕，不回正，只把距离退到观赏距离
    if (this.player.auto) this.easeAutoDistance(dt);
    else this.followHeading(dt);
  }

  /**
   * 每帧第二步（鸟更新之后）：orbit 管线收尾（跟随点追鸟 → 重新看向目标 → 避障），再按视角模式决定这一帧真正用的机位
   * （orbit / chase / shoulder / eye，带切换过渡），最后准星偏置补偿和准星 DOM。
   */
  afterPlayer(dt: number): void {
    // 鸟挪完这一帧再把 orbit 相机挪过去（同一个帧内，镜头不比鸟慢一帧）：相机被拉到鸟身边 8.5 cm 时慢一帧就是 10 cm / 50° 的偏差
    this.followBird(dt);
    this.camera.lookAt(this.controls.target);
    this.avoidCamera(dt);
    this.orbitPos.copy(this.camera.position);
    this.orbitQuat.copy(this.camera.quaternion);
    this.updateViewYaw();
    this.updateView(dt);
    this.updateReticleDom();
  }

  /** 下一帧让跟随点直接跳到鸟身上（摆完机位后用，不然平滑会把机位拽回去）。 */
  resetFollow(): void {
    this.followInit = false;
  }

  /** 不过渡，直接跳到当前档位的机位（调试脚本摆完机位 / 设定视角后用，不然前 0.45 s 相机方向是过渡中间值）。 */
  snapView(): void {
    this.viewNow = this.viewMode;
    this.viewBlend = 1;
    this.pendingReblend = false;
  }

  /** 操控关着时由外壳每帧记下 orbit 管线的相机位姿（下一帧先放回去）。 */
  saveOrbit(): void {
    this.orbitPos.copy(this.camera.position);
    this.orbitQuat.copy(this.camera.quaternion);
  }

  /** 镜头的水平视线方向给地面上的 WASD：orbit = 从相机指向鸟；chase / shoulder / eye = 视角方位（看哪走哪）。 */
  cameraDirection(out: { x: number; z: number }): void {
    if (this.viewMode === 'orbit') {
      const off = this.camOff.subVectors(this.camera.position, this.controls.target);
      const hl = Math.hypot(off.x, off.z);
      if (hl > 1e-6) {
        out.x = -off.x / hl;
        out.z = -off.z / hl;
      }
      return;
    }
    out.x = Math.sin(this.viewYaw);
    out.z = Math.cos(this.viewYaw);
  }

  /** 纯第一人称站在平地上时身体跟转的方位；别的档位 / 飞行中返回 null。 */
  faceYawForPlayer(): number | null {
    return this.viewMode === 'eye' ? this.viewYaw : null;
  }

  /** 转视角（弧度，正 = 往左 / 往上看）：方位无上限（每帧绕回 ±π），俯仰夹在舒适范围内。 */
  private turnView(dyaw: number, dpitch: number): void {
    this.viewYaw += dyaw;
    this.viewPitch = clamp(this.viewPitch + dpitch, VIEW_PITCH_DOWN, VIEW_PITCH_UP);
  }

  /** 飞行中没按 A/D、W/S 时航向 / 俯仰跟视角（写进 player.lookYaw / lookPitch，−1..1，已经去过死区）。 */
  steerFlight(): void {
    if (this.viewMode === 'orbit') this.updateLookSteer();
    else this.updateLookSteerView();
  }

  /** 视角在注视目标（世界坐标，离头 80 cm）：视角偏离机头时给动作系统的 gazeWorld，鸟头先朝它看（头颈上限内）。 */
  gazeTarget(headWorld: Vector3, out: Vector3): Vector3 | null {
    if (Math.abs(this.viewError()) < 0.03 && Math.abs(this.viewPitch) < 0.03) return null;
    const cp = Math.cos(this.viewPitch);
    return out.set(headWorld.x + Math.sin(this.viewYaw) * cp * 80, headWorld.y + Math.sin(this.viewPitch) * 80, headWorld.z + Math.cos(this.viewYaw) * cp * 80);
  }

  /** 视角方位 − 航向方位，绕回 ±π（正 = 视角在机头左边）。 */
  private viewError(): number {
    let e = this.viewYaw - this.headingAzimuth();
    e = Math.atan2(Math.sin(e), Math.cos(e));
    return e;
  }

  /** OrbitControls 只在 orbit 模式且没锁定鼠标时响应拖动（追尾 / 第一人称里鼠标归 Pointer Lock）。 */
  get controlsEnabled(): boolean {
    return this.viewMode === 'orbit' && !this.locked;
  }

  // ───────────────────────── orbit 管线 ─────────────────────────

  /**
   * 第三人称相机跟随：跟随点以指数平滑追鸟的躯干中心，这一帧的差量同时加到 orbit 的目标和相机上（鼠标拖出的视角偏移保持不变）。
   * 飞行时跟随点顺着速度往前带：平滑本身会落后 v/FOLLOW_RATE（6 m/s 时 29 cm，鸟会被挤到画面边上），先把它抵消掉，
   * 再按相机距离的 FLIGHT_LEAD_K 多往前看一点。自由巡飞是环绕观赏：不往前带（带了鸟就被挤到画面边上，相机避障往目标点退的时候会越过鸟）。
   */
  private followBird(dt: number): void {
    this.player.followTarget(this.followTarget);
    if (this.player.flying) {
      const v = this.player.flight.vel;
      const speed = v.length();
      const lead = speed / FOLLOW_RATE + (this.player.auto ? 0 : FLIGHT_LEAD_K * this.camera.position.distanceTo(this.controls.target));
      if (speed > 1e-6) {
        const s = lead / speed;
        this.followTarget.x += v.x * s;
        this.followTarget.y += v.y * s;
        this.followTarget.z += v.z * s;
      }
    }
    if (!this.followInit) {
      this.followPoint.copy(this.followTarget);
      this.followInit = true;
    }
    this.followPrev.copy(this.followPoint);
    this.followPoint.lerp(this.followTarget, 1 - Math.exp(-FOLLOW_RATE * dt));
    this.followTarget.subVectors(this.followPoint, this.followPrev);
    this.controls.target.add(this.followTarget);
    this.camera.position.add(this.followTarget);
  }

  /**
   * 相机偏移绕竖直轴换个方位：先试上次用的角，再 ±15°…±90°（先近后远），取第一条从鸟到 dist 处整条通视的方向。
   * 找到了写进 camSlideV / camSlide 返回 true；都不行把 camSlide 归零返回 false（调用方退回硬下限）。
   */
  private slideCamera(dist: number): boolean {
    const target = this.controls.target;
    const full = this.camFull;
    const probe = this.camProbe;
    const q = this.camContact;
    const v = this.camSlideV;
    const tryAngle = (ang: number): boolean => {
      const c = Math.cos(ang);
      const sn = Math.sin(ang);
      v.set(full.x * c + full.z * sn, full.y, -full.x * sn + full.z * c).setLength(dist);
      for (let i = 1; i <= 6; i++) {
        probe.copy(target).addScaledVector(v, i / 6);
        this.world.closest(probe.x, probe.y, probe.z, q);
        if (this.blocksCamera(q)) return false;
      }
      return true;
    };
    if (this.camSlide !== 0 && tryAngle(this.camSlide)) return true;
    if (tryAngle(0)) {
      this.camSlide = 0;
      return true;
    }
    for (let k = 1; k <= 6; k++) {
      const ang = (k * Math.PI) / 12;
      if (tryAngle(ang) || tryAngle(-ang)) {
        this.camSlide = tryAngle(ang) ? ang : -ang;
        return true;
      }
    }
    this.camSlide = 0;
    return false;
  }

  /** 相机避障只躲粗的东西：树干 / 粗枝（半径 ≥ CAMERA_MIN_RADIUS）、建筑盒体、雪地；细枝细线不算挡视线。 */
  private blocksCamera(c: { surface: Surface | null; dist: number; u: number }): boolean {
    if (c.surface === null || Math.abs(c.dist) >= CAMERA_CLEAR) return false;
    if (c.surface instanceof CurvePerch) return c.surface.frameAt(c.u, this.camFrame).radius >= CAMERA_MIN_RADIUS;
    return true;
  }

  /**
   * 上一帧避障把相机拉近过：先放回轨道半径上再让 orbit 更新。OrbitControls.update() 是从相机当前位置反算轨道半径的，
   * 不还原的话拉近过的位置会被当成新的轨道半径，越陷越深直到撞上 minDistance。
   */
  private restoreCamera(): void {
    if (this.camPull < 1) this.camera.position.copy(this.controls.target).add(this.camFull);
  }

  /**
   * 第三人称跟随机位（操控开着、camFollow 开着时）：orbit 更新完之后，把"目标 → 相机"的偏移绕竖直轴转向鸟的背后
   * （航向的反方向），俯仰角靠到 FOLLOW_ELEV。跟着转的时机 = 飞行中、按着方向键、或者鸟正在转身（原地掉头蹦）；
   * 站着不动又不按键时不跟，鼠标拖开的角度就留着随便看。只改这一帧的相机位置；OrbitControls 下一帧从相机位置反算轨道。
   */
  private followHeading(dt: number): void {
    if (!this.camFollow || this.viewMode !== 'orbit') return;
    const off = this.camOff.subVectors(this.camera.position, this.controls.target);
    const len = off.length();
    if (len < 1e-6) return;
    const hx = this.player.headingX;
    const hz = this.player.headingZ;
    // 这一帧鸟转了多少（掉头蹦中途松手也要跟）
    let turned = Math.atan2(hx, hz) - Math.atan2(this.lastHeading.x, this.lastHeading.z);
    turned = Math.atan2(Math.sin(turned), Math.cos(turned));
    this.lastHeading.set(hx, 0, hz);
    const following = this.player.flying || this.player.inputActive || Math.abs(turned) > 0.01;
    if (!following) return;
    const rate = this.player.flying ? FLIGHT_CAM_TRAIL : FOLLOW_TURN;
    const k = 1 - Math.exp(-rate * dt);
    let d = Math.atan2(-hx, -hz) - Math.atan2(off.x, off.z);
    d = Math.atan2(Math.sin(d), Math.cos(d));
    const yaw = Math.atan2(off.x, off.z) + d * k;
    const elev = Math.asin(Math.max(-1, Math.min(1, off.y / len)));
    // 飞行中俯仰角不碰：镜头抬高往下看 = 俯冲、压低往上看 = 爬升（updateLookSteer 读它），只把方位慢慢拖回鸟背后
    const el = this.player.flying ? elev : elev + (FOLLOW_ELEV - elev) * k;
    const dist = this.player.flying ? len + (this.flightDist - len) * (1 - Math.exp(-FLIGHT_DIST_RATE * dt)) : len;
    off.set(Math.cos(el) * Math.sin(yaw), Math.sin(el), Math.cos(el) * Math.cos(yaw)).multiplyScalar(dist);
    this.camera.position.copy(this.controls.target).add(off);
  }

  /** 自动巡飞：相机距离退到观赏距离（不回正方位，鼠标随便绕）；滚轮改了 flightDist 就朝新值靠。 */
  private easeAutoDistance(dt: number): void {
    const off = this.camOff.subVectors(this.camera.position, this.controls.target);
    const len = off.length();
    if (len < 1e-6) return;
    off.setLength(len + (this.flightDist - len) * (1 - Math.exp(-FLIGHT_DIST_RATE * dt)));
    this.camera.position.copy(this.controls.target).add(off);
  }

  /**
   * orbit 模式的鼠标视线引导：镜头相对鸟背后的方位偏多少，鸟就往那边转（偏角过死区才算，到 LOOK_FULL 满舵）；
   * 镜头比 FOLLOW_ELEV 抬得更高（往下看）就俯冲、压得更低（往上看）就爬升。
   * 符号：e = 视线方位 − 航向方位（都按 atan2(x, z)）。鸟朝 +Z、视线往左（+X）偏时 e > 0，该往左转 = turn 正（KeyA），
   * 所以 lookYaw = +dead(e)。注意相机在鸟的后左方时视线朝的是右前方——第一版按"相机在哪侧"想当然写成了 −e，左右反了。
   */
  private updateLookSteer(): void {
    const off = this.camOff.subVectors(this.camera.position, this.controls.target);
    const len = off.length();
    if (len < 1e-6) return;
    const hx = this.player.headingX;
    const hz = this.player.headingZ;
    let e = Math.atan2(-off.x, -off.z) - Math.atan2(hx, hz);
    e = Math.atan2(Math.sin(e), Math.cos(e));
    const dead = (v: number): number => (Math.abs(v) < LOOK_DEAD ? 0 : v - Math.sign(v) * LOOK_DEAD);
    this.player.lookYaw = Math.max(-1, Math.min(1, dead(e) / LOOK_FULL));
    const dp = Math.asin(Math.max(-1, Math.min(1, -off.y / len))) + FOLLOW_ELEV;
    const want = dead(dp);
    this.player.lookPitch = Math.max(-1, Math.min(1, want / (want > 0 ? LOOK_CLIMB : LOOK_DIVE)));
  }

  /**
   * 看哪飞哪：视角方位和航向的最短角差就是转向意图（过 FP_LOOK_DEAD 死区才转，到 LOOK_FULL 满舵）——甩鼠标 180° 看身后，
   * 镜头立刻转过去，鸟按最短角差压坡追；视角仰角就是俯仰意图（抬高到 LOOK_CLIMB 满幅爬升、压低到 LOOK_DIVE 满幅俯冲）。
   */
  private updateLookSteerView(): void {
    const dead = (v: number): number => (Math.abs(v) < FP_LOOK_DEAD ? 0 : v - Math.sign(v) * FP_LOOK_DEAD);
    this.player.lookYaw = clamp(dead(this.viewError()) / LOOK_FULL, -1, 1);
    const want = dead(this.viewPitch);
    this.player.lookPitch = clamp(want / (want > 0 ? LOOK_CLIMB : LOOK_DIVE), -1, 1);
  }

  /**
   * 视角方位的维护：视角是独立的世界方位，鼠标写多少就是多少、不回正；只有两种情况跟着航向走——
   *  ① 重置 / 传送（一帧航向差 ≥ 0.5 rad 的 snap）：视角加上同样的差量，保持"看鸟背后"的相对关系；
   *  ② 飞行中 A/D 键盘转弯、或边界把鸟拗回场内：航向差量加到视角上，镜头跟着鸟一起转（鼠标定的角差保持不变）。
   * 鸟追视角自己转出来的航向差不加（加了角差永远关不上、鸟一直转）。
   */
  private updateViewYaw(): void {
    const hz = this.headingAzimuth();
    if (!this.lookInit) {
      this.lastHeadingAz = hz;
      this.lookInit = true;
    }
    let dh = hz - this.lastHeadingAz;
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    this.lastHeadingAz = hz;
    const p = this.player;
    if (Math.abs(dh) >= 0.5) this.viewYaw += dh;
    else if (dh !== 0 && p.flying && !p.auto && (p.keyTurnHeld || Math.abs(p.flight.boundaryTurn()) > 0.01)) this.viewYaw += dh;
    if (this.viewYaw > Math.PI) this.viewYaw -= Math.PI * 2;
    else if (this.viewYaw < -Math.PI) this.viewYaw += Math.PI * 2;
  }

  /**
   * 相机避障（操控开着时）：沿"目标 → 相机"采 10 个点，哪一个贴进了枝条 / 树干 / 雪地（离最近表面 < CAMERA_CLEAR），
   * 相机就退到它的前面（再二分 4 次精修）——整条视线都不被挡住，不只是相机自己不穿模。拉近立刻、放开平滑。
   * 只改这一帧的相机位置：下一帧 restoreCamera() 先把它放回去，鼠标拖出的视角偏移不受影响。
   */
  private avoidCamera(dt: number): void {
    const cam = this.camera.position;
    const target = this.controls.target;
    const q = this.camContact;
    this.camFull.subVectors(cam, target);
    let want = 1;
    const probe = this.camProbe;
    let lo = 0;
    let hi = 1;
    for (let i = 1; i <= 10; i++) {
      const s = i / 10;
      probe.copy(target).addScaledVector(this.camFull, s);
      this.world.closest(probe.x, probe.y, probe.z, q);
      if (!this.blocksCamera(q)) continue;
      hi = s;
      if (i === 1) {
        // 离鸟最近的一段就在障碍里（目标贴着树干 / 雪坡）：不动相机
        return;
      }
      lo = (i - 1) / 10;
      for (let k = 0; k < 4; k++) {
        const mid = (lo + hi) * 0.5;
        probe.copy(target).addScaledVector(this.camFull, mid);
        this.world.closest(probe.x, probe.y, probe.z, q);
        if (!this.blocksCamera(q)) lo = mid;
        else hi = mid;
      }
      want = lo;
      break;
    }
    // 硬下限：离躯干再近也不拉（用户自己缩到 8.5 cm 以内时不往外推）
    const minPull = Math.min(1, CAMERA_MIN_DIST / Math.max(this.camFull.length(), 1e-6));
    if (want < minPull) {
      // 粗枝就在鸟身边 8.5 cm 内：硬按下限停会卡在枝条里，改为绕竖直轴换一个方位（距离停在下限上）
      if (this.slideCamera(Math.min(this.camFull.length(), CAMERA_MIN_DIST))) {
        cam.copy(target).add(this.camSlideV);
        this.camPull = 0;
        return;
      }
      want = minPull;
    }
    if (want >= 1 && this.camPull >= 1) return;
    this.camPull = want < this.camPull ? want : want - (want - this.camPull) * Math.exp(-CAMERA_RELEASE * dt);
    if (this.camPull > 0.999) this.camPull = 1;
    cam.copy(target).addScaledVector(this.camFull, this.camPull);
  }

  /** 追尾机位的避障：锚点 → 机位的线段上第一个贴着障碍的点之前停下，离锚点最近 CAMERA_MIN_DIST（不换方位，锁定视角不乱飘）。 */
  private pullChase(anchor: Vector3, pos: Vector3): void {
    const q = this.camContact;
    const full = this.scratch2.subVectors(pos, anchor);
    let want = 1;
    const probe = this.camProbe;
    let lo = 0;
    let hi = 1;
    for (let i = 1; i <= 10; i++) {
      const s = i / 10;
      probe.copy(anchor).addScaledVector(full, s);
      this.world.closest(probe.x, probe.y, probe.z, q);
      if (!this.blocksCamera(q)) continue;
      if (i === 1) return;
      hi = s;
      lo = (i - 1) / 10;
      for (let k = 0; k < 4; k++) {
        const mid = (lo + hi) * 0.5;
        probe.copy(anchor).addScaledVector(full, mid);
        this.world.closest(probe.x, probe.y, probe.z, q);
        if (!this.blocksCamera(q)) lo = mid;
        else hi = mid;
      }
      want = Math.max(lo, Math.min(1, CAMERA_MIN_DIST / Math.max(full.length(), 1e-6)));
      break;
    }
    pos.copy(anchor).addScaledVector(full, want);
  }

  // ───────────────────────── 机位合成 ─────────────────────────

  /**
   * 这一帧的机位和模式切换的丝滑过渡。目标机位：
   *  - orbit：orbit 管线这一帧的结果（orbitPos / orbitQuat）；
   *  - chase：平滑航向 + 27% 准星偏角 的后上方（锚点竖直低通），俯仰跟机体（滤掉扑翼波浪）、滚转只跟 25% 坡度；
   *  - shoulder：鸟群局部 shoulderLocal 处，朝机头方向看；eye：两眼之间 eyeLocal 处，藏掉头 / 喙 / 身体绒毛 / 腿。
   * 切换时从切换那一刻的相机位姿（相对鸟的位置 + 视角方位，跟着鸟走）过渡到目标位姿（实时），VIEW_BLEND_TIME 秒；FOV / 近裁面跟着各自的目标平滑。
   * 纯第一人称藏身体：按镜头离眼点的距离藏 / 露（见 EYE_HIDE_DIST），不是一按键就消失、过渡走完才出现。
   */
  private updateView(dt: number): void {
    const p = this.player;
    const want: ViewNow = this.viewMode;
    if (want !== this.viewNow || this.pendingReblend) {
      // 起点记成相对鸟的局部量：位置减同一时刻的鸟群原点再绕竖直轴转回视角方位、朝向左乘 −视角方位（机位挂在视角上，不是航向）
      const az0 = this.viewYaw;
      this.viewFromLocal.copy(this.lastPos).sub(this.lastBirdPos).applyAxisAngle(UP, -az0);
      this.viewFromQuatLocal.setFromAxisAngle(UP, -az0).multiply(this.lastQuat);
      this.viewBlend = 0;
      this.pendingReblend = false;
      this.viewNow = want;
    }
    this.viewBlend = Math.min(1, this.viewBlend + dt / this.blendTime);
    const k = this.viewBlend * this.viewBlend * (3 - 2 * this.viewBlend);
    if (want === 'orbit') {
      this.camTargetPos.copy(this.orbitPos);
      this.camTargetQuat.copy(this.orbitQuat);
    } else if (want === 'chase') {
      this.chasePose(dt);
    } else {
      const g = this.bird.group;
      g.updateMatrixWorld();
      if (want === 'eye') {
        this.camTargetPos.copy(this.eyeLocal).applyMatrix4(g.matrixWorld);
      } else {
        // 过肩机位挂在视角方位上（鼠标转到哪、机位就在鸟的哪一边的后上方），不随航向 / 机体俯仰滚转
        const l = this.shoulderLocal;
        const cy = Math.cos(this.viewYaw);
        const sy = Math.sin(this.viewYaw);
        this.camTargetPos.set(g.position.x + l.x * cy + l.z * sy, g.position.y + l.y, g.position.z - l.x * sy + l.z * cy);
      }
      const flying = p.flying;
      const bodyPitch = flying ? p.flight.bodyPitch : 0;
      const bank = flying ? p.flight.bank : 0;
      const pitchTarget = (want === 'eye' ? bodyPitch : 0) + (want === 'shoulder' ? this.shoulderPitch : 0);
      this.fpPitch += (pitchTarget - this.fpPitch) * (1 - Math.exp(-FP_PITCH_RATE * dt));
      this.fpRoll += (bank * CAM_ROLL - this.fpRoll) * (1 - Math.exp(-FP_ROLL_RATE * dt));
      // 撞了一下：镜头小震一下
      if (flying && p.flight.bumpT < 0.25) this.camTargetPos.y += Math.sin(p.flight.bumpT * 70) * 0.04 * (1 - p.flight.bumpT / 0.25);
      // 相机看自己的局部 −Z：yaw 要加 π 才是顺着视角方位看；x 正 = 抬头（视角俯仰 + 机体俯仰的平滑），z 正 = 和鸟同向压坡
      this.camEuler.set(this.fpPitch + this.viewPitch, this.viewYaw + Math.PI, this.fpRoll, 'YXZ');
      this.camTargetQuat.setFromEuler(this.camEuler);
    }
    if (k >= 1) {
      this.camera.position.copy(this.camTargetPos);
      this.camera.quaternion.copy(this.camTargetQuat);
    } else {
      // 起点跟着鸟走（位置 + 视角方位），插值的两端都贴着鸟，飞行中切换也不会掉队
      const az1 = this.viewYaw;
      this.fromPos.copy(this.viewFromLocal).applyAxisAngle(UP, az1).add(this.bird.group.position);
      this.fromQuat.setFromAxisAngle(UP, az1).multiply(this.viewFromQuatLocal);
      this.camera.position.lerpVectors(this.fromPos, this.camTargetPos, k);
      this.camera.quaternion.slerpQuaternions(this.fromQuat, this.camTargetQuat, k);
    }
    // FOV / 近裁面（冲刺时三档锁定机位都叠一层动态 FOV：Flight 的 boost 已经平滑过，推背感和回落都不突兀）
    const boostFov = p.flying && want !== 'orbit' ? BOOST_FOV * p.flight.boost : 0;
    const fovT = (want === 'orbit' ? FOV : want === 'eye' ? EYE_FOV : want === 'shoulder' ? SHOULDER_FOV : CHASE_FOV) + boostFov;
    const nearT = want === 'orbit' ? 0.5 : FP_NEAR;
    const kf = 1 - Math.exp(-6 * dt);
    this.fovNow += (fovT - this.fovNow) * kf;
    this.nearNow += (nearT - this.nearNow) * kf;
    if (Math.abs(this.camera.fov - this.fovNow) > 0.01 || Math.abs(this.camera.near - this.nearNow) > 0.001) {
      this.camera.fov = this.fovNow;
      this.camera.near = this.nearNow;
      this.camera.updateProjectionMatrix();
    }
    // 藏 / 露身体按"镜头离眼点多近"判：进第一人称飞到 EYE_HIDE_DIST 以内才藏（已藏就保持），离开走出这段距离（或过渡走完）才露
    if (want === 'eye' || this.bodyHidden) {
      const gb = this.bird.group;
      gb.updateMatrixWorld();
      const eyeD = this.camera.position.distanceTo(this.scratch.copy(EYE_LOCAL).applyMatrix4(gb.matrixWorld));
      if (want === 'eye') {
        if (this.bodyHidden || eyeD < EYE_HIDE_DIST || k >= 1) this.bodyHidden = true;
      } else if (eyeD >= EYE_HIDE_DIST || k >= 1) {
        this.bodyHidden = false;
      }
    }
    this.applyBodyVisibility();
    this.controls.enabled = this.controlsEnabled;
  }

  /**
   * 锁定追尾的机位：绕锚点（躯干中心）的球面轨道——方位 = 视角方位 viewYaw（鼠标 360° 转多少就在多少，不跟航向、不回正），
   * 仰角 = 默认 CHASE_EL − 视角俯仰（往上看相机绕到下面、往下看绕到上面，夹在 EL_MIN / EL_MAX 之间）；
   * 锚点水平快跟（τ 0.05），竖直地面低通（τ 0.6 s：只跟地形大起伏，每跳 2~5 cm 留给鸟在画面里雀跃、地平线不晃）、飞行快跟；
   * 镜头俯仰 = −仰角 + 机体俯仰的 45%（平滑），滚转只跟 25% 坡度；机位被树干 / 雪坡挡住就沿锚点 → 机位拉回来。
   */
  private chasePose(dt: number): void {
    const p = this.player;
    const g = this.bird.group;
    const kxz = 1 - Math.exp(-CHASE_XZ_RATE * dt);
    const ky = 1 - Math.exp(-(p.flying ? CHASE_Y_RATE_FLY : CHASE_Y_RATE_GROUND) * dt);
    this.scratch.set(0, ANCHOR_LOCAL_Y, 0).applyQuaternion(g.quaternion).add(g.position);
    // 一阶平滑追匀速目标的稳定落后 = v·dt / k（每帧只追上 k 倍差量；不是连续时间的 v / rate）：先把这段补上，鸟才稳稳在画面里。
    // 地面的竖直不补（每跳 2~5 cm 就是要滤掉的），飞行的竖直补（爬升 / 俯冲要跟）
    const v = p.flying ? p.flight.vel : p.loco.vel;
    this.scratch.x += (v.x * dt) / kxz;
    this.scratch.z += (v.z * dt) / kxz;
    if (p.flying) this.scratch.y += (v.y * dt) / ky;
    // 地面上锚点的竖直只跟"脚下地面"的高度：站着 / 蓄力 / 蹬伸 / 缓冲时根就贴在地面上，腾空那一跳的抛物线不跟（地平线不晃），
    // 落到新的高度（雪垄 / 台阶 / 栏杆）才跟过去。以前是 1.6/s 的低通连抛物线一起滤：时间常数 0.6 s，在庭院 20° 的雪垄上
    // 一跳爬高 10 cm 锚点就落后 6 cm，追尾镜头埋进雪里只剩一屏白
    if (!p.flying && p.loco.phase !== 'air') this.groundAnchorY = this.scratch.y;
    const ty = p.flying ? this.scratch.y : this.groundAnchorY;
    // 刚建好 / 鸟被传送了（重置回栖枝、调试脚本挪位置）：锚点和航向直接跳过去，不然低通要从老位置飘过来
    //（阈值 60 cm：稳态落后本身就有 30 多 cm，太低会误判成传送、锚点来回跳）
    if (!this.chaseInit || this.chaseAnchor.distanceTo(this.scratch) > 60) {
      this.chaseAnchor.copy(this.scratch);
      this.chaseAnchor.y = ty;
      this.chaseInit = true;
    }
    if (this.wasFlying && !p.flying) {
      this.chaseAnchor.y = this.scratch.y;
      this.groundAnchorY = this.scratch.y;
    }
    this.wasFlying = p.flying;
    this.chaseAnchor.x += (this.scratch.x - this.chaseAnchor.x) * kxz;
    this.chaseAnchor.z += (this.scratch.z - this.chaseAnchor.z) * kxz;
    this.chaseAnchor.y += (ty - this.chaseAnchor.y) * ky;
    const az = this.viewYaw;
    const el = clamp(CHASE_EL - this.viewPitch, CHASE_EL_MIN, CHASE_EL_MAX);
    const bodyPitch = p.flying ? p.flight.bodyPitch : 0;
    this.chasePitchBody += (bodyPitch - this.chasePitchBody) * (1 - Math.exp(-CHASE_PITCH_RATE * dt));
    this.chaseRollNow += ((p.flying ? p.flight.bank : 0) * CHASE_ROLL - this.chaseRollNow) * (1 - Math.exp(-FP_ROLL_RATE * dt));
    const d = this.chaseDist;
    const ce = Math.cos(el);
    this.camTargetPos.set(this.chaseAnchor.x - Math.sin(az) * ce * d, this.chaseAnchor.y + Math.sin(el) * d, this.chaseAnchor.z - Math.cos(az) * ce * d);
    this.pullChase(this.chaseAnchor, this.camTargetPos);
    this.camEuler.set(-el + 0.45 * this.chasePitchBody, az + Math.PI, this.chaseRollNow, 'YXZ');
    this.camTargetQuat.setFromEuler(this.camEuler);
  }

  private applyBodyVisibility(): void {
    if (this.bodyHidden === this.bodyHiddenApplied) return;
    this.bodyHiddenApplied = this.bodyHidden;
    const show = !this.bodyHidden;
    this.bird.setPartVisible('fur', show);
    this.bird.setPartVisible('beak', show);
    this.bird.setPartVisible('eyes', show);
    // 翅膀也藏：从眼睛的位置翼尖在眼平面后方，本来就在画面外；站在枝上时收拢的翅膀倒是会挡在画面下半
    this.bird.setPartVisible('legs', show);
    this.bird.setPartVisible('feathers', show);
  }

  /** 准星 DOM：Pointer Lock 锁着才显示（orbit 模式除外），位置 = 画面中心。 */
  private updateReticleDom(): void {
    if (!this.locked || this.viewMode === 'orbit') {
      if (this.reticle.style.display !== 'none') this.reticle.style.display = 'none';
      return;
    }
    const r = this.canvas.getBoundingClientRect();
    // 相机就是视角，准星永远在画面中心
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const s = this.reticle.style;
    if (s.display !== 'block') s.display = 'block';
    s.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
  }
}
