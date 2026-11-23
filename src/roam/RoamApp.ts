import {
  ACESFilmicToneMapping,
  PCFShadowMap,
  PerspectiveCamera,
  Plane,
  Quaternion,
  Raycaster,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Lighting } from '../core/Lighting';
import { Panel } from '../ui/Panel';
import { Backdrop } from '../world/Backdrop';
import { Branches } from '../world/Branch';
import { Sky } from '../world/Sky';
import { Snowfall } from '../world/Snowfall';
import { Bird } from '../bird/Bird';
import { FUR_DEFAULTS } from '../bird/fur';
import { MotionController } from '../bird/motion/MotionController';
import { restPose } from '../bird/motion/Pose';
import type { Pose } from '../bird/motion/Pose';
import { FOOT_SPOTS } from '../bird/parts';
import type { FootState } from '../bird/legs';
import { TEST_SPOTS } from '../sim/autopilot';
import { TestRig } from './TestRig';
import { BirdController } from './BirdController';
import type { CameraRig, ViewMode } from './CameraRig';
import type { Player } from './Player';
import type { Stage } from './stage';

export interface ViewPreset {
  /** 相机方位角：+Z 方向为 0，向 +X 为正。 */
  az: number;
  /** 相机仰角。 */
  el: number;
  /** 相机到 target 的距离（厘米）。 */
  dist: number;
  target: [number, number, number];
}

/**
 * 视角预设。鸟站在原点、面朝世界 -X、右翅在 +Z 一侧。
 * tp* 是第三人称机位：从鸟的右后上方看过去，数字是相机到躯干中心的距离（厘米），
 * 覆盖 PLAN 里第三人称活动与飞行的 35~180 cm 一段。视角名后面可以接 "@距离" 临时改距离（tp@22）。
 * 这些是 OrbitControls 自由机位（操控关着 / 截图脚本用）；操控开着时的机位由 CameraRig 管（追尾 / 过肩 / 纯第一人称）。
 */
export const VIEWS: Record<string, ViewPreset> = {
  threequarter: { az: -0.62, el: 0.16, dist: 12, target: [0.2, 2.6, -0.3] },
  head: { az: -0.75, el: 0.1, dist: 4.6, target: [-0.6, 3.55, 0.05] },
  side: { az: 0.0, el: 0.05, dist: 11.5, target: [0.6, 2.4, 0] },
  wide: { az: -0.5, el: 0.2, dist: 28, target: [2, 2, 0] },
  tp35: { az: 0.5, el: 0.26, dist: 35, target: [0.6, 2.6, 0] },
  tp60: { az: 0.5, el: 0.28, dist: 60, target: [0.6, 2.6, 0] },
  tp100: { az: 0.5, el: 0.3, dist: 100, target: [0.6, 2.6, 0] },
  tp180: { az: 0.5, el: 0.32, dist: 180, target: [0.6, 2.6, 0] },
  // 仿真调试台：全景看整棵树和整套表面，tree 从侧面看树冠，wire 贴着跨街电线看小球落上去，feet 看脚爪抓枝
  rig: { az: 0.9, el: 0.28, dist: 720, target: [-30, 110, 0] },
  tree: { az: 1.2, el: 0.12, dist: 340, target: [-40, 130, -10] },
  wire: { az: 0.35, el: 0.1, dist: 90, target: [0, 108, 50] },
  feet: { az: 0.75, el: 0.32, dist: 3.2, target: [0.05, 0.15, 0.05] },
  // 抬起的脚藏在腹羽下面，从鸟的前侧略低一点往上瞧才看得清张开的脚趾（el / dist 取 OrbitControls 的下限）
  under: { az: -0.75, el: -0.18, dist: 3.6, target: [0, 0.25, 0.15] },
};
const VIEW_NAMES = Object.keys(VIEWS);
/** 飘雪箱子绕相机包裹的半边长（厘米）和片数：飞行距离 70~150 cm 下看得见雪。 */
const SNOW_RANGE = 130;
const SNOW_COUNT = 2600;
/** 漫游的阴影相机罩住鸟周围这么大（厘米）：4096 贴图下 ±150 还有 13 px/cm，影子跟着鸟走。 */
const SHADOW_EXTENT = 150;

/**
 * 仿真调试台作为舞台：活动场地（离原点 170 cm 以外开始被逆风软边界往回带，1.5 倍 255 是软风墙，掉到 −200 以下放回场上空 40）、
 * 景点表、雪面基准高度、回栖点（观鸟的初始栖枝：主角枝 x = 0，面朝世界 -X，鸟群原点在世界原点）。
 * 雪地边缘在 280：山雀 700 cm/s 满舵转弯半径 ~400，边界得留出足够余量。
 */
const RIG_STAGE: Omit<Stage, 'world' | 'perches'> = {
  bounds: { x: 0, y: 40, z: 0, radius: 170, voidY: -200 },
  flySpots: TEST_SPOTS,
  groundY: -73,
  home: { root: { x: 0, y: 0, z: 0, yaw: -Math.PI / 2 }, query: { x: 0, y: 0.3, z: 0, hx: -1, hz: 0 }, perchX: 0 },
};

export interface RoamAppOptions {
  ui: boolean;
  /** 画面左上角的数值 HUD（截图自检时把帧率、三角形数、壳层数直接留在画面里）。 */
  hud: boolean;
  dprCap: number;
  /** 绒毛自动 LOD 的初始开关。 */
  autoLod: boolean;
  /** 仿真调试台（雪面、电线、盒体、小球探针）的初始开关。 */
  rig: boolean;
  /** 第三人称操控的初始开关（WASD / 方向键 + 空格）。 */
  play: boolean;
  /** 调试：覆盖视场角（NaN = 用默认值）。 */
  fov: number;
}

/**
 * 《雪精灵的城市漫游》的应用外壳。与观鸟的 core/App 是两个独立入口，只共用鸟、世界部件、光照和面板模块。
 * 操控 + 相机 + 自动巡飞在 BirdController（可挂到任何舞台：冬日庭院、大植物园传一份 Stage 就行），这里只管场景、画面、面板和 HUD。
 */
export class RoamApp {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly lighting: Lighting;
  readonly panel: Panel | null;
  readonly sky: Sky;
  readonly backdrop: Backdrop;
  readonly snowfall: Snowfall;
  readonly branches: Branches;
  readonly bird: Bird;
  readonly motion = new MotionController();
  /** 仿真调试台：碰撞世界 + 画面 + 小球探针。 */
  readonly rig: TestRig;
  /** 当前视角名（tools/bench.mjs 重挂动画循环时用）。 */
  view = 'tp35';
  /** 操控 + 相机 + 自动巡飞（阶段 5 解耦出的通用控制器）。 */
  readonly ctrl: BirdController;

  private readonly hud: HTMLElement | null;
  private readonly hudStats: HTMLElement;
  private readonly scratch = new Vector3();
  private elapsed = 0;
  private last = 0;
  private fpsWindow = 0;
  private fpsCount = 0;
  private stats: { set(text: string): void }[] = [];
  /** 手动壳层数滑块，以及它记录的值（自动 LOD 开着时滑块只用来显示实际层数，关掉后还原成这个值）。 */
  private manualShells: { set(v: number): void } | null = null;
  private manualShellValue = 96;
  private backdropOn = true;
  private rigOn = true;
  private probeStat: { set(text: string): void } | null = null;
  /** 动态腿爪的演示状态：脚趾张开程度、抬脚、躯干前俯。每帧在动作系统之后覆盖应用。 */
  private readonly legDemo = { open: 0, liftRight: false, liftLeft: false, pitch: 0 };
  /** 动作系统这一帧的 Pose（动作系统关着时为 null）：操控层在它上面叠加翅 / 尾。 */
  private basePose: Pose | null = null;
  private playerStat: { set(text: string): void } | null = null;
  // 鼠标注视：指针 NDC → 过头部、正对相机的平面上的点
  private readonly pointerNdc = new Vector2();
  private pointerInside = false;
  private readonly pointerRay = new Raycaster();
  private readonly gazePlane = new Plane();
  private readonly gazePoint = new Vector3();
  private readonly headWorld = new Vector3();
  private readonly birdQuat = new Quaternion();
  private readonly birdInvQuat = new Quaternion();
  private readonly camDir = new Vector3();

  /** 第三人称操控（转发自控制器：截图脚本 / 面板用）。 */
  get player(): Player {
    return this.ctrl.player;
  }

  /** 相机控制器（转发：截图脚本调机位 / 准星）。 */
  private get cam(): CameraRig {
    return this.ctrl.cam;
  }

  constructor(root: HTMLElement, opts: RoamAppOptions) {
    this.renderer = new WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, opts.dprCap));
    this.renderer.setSize(root.clientWidth, root.clientHeight);
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.9;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;
    root.appendChild(this.renderer.domElement);

    this.camera = new PerspectiveCamera(
      Number.isFinite(opts.fov) && opts.fov > 0 ? opts.fov : 34,
      root.clientWidth / root.clientHeight,
      0.5,
      4000,
    );
    this.lighting = new Lighting(this.scene);
    // 漫游的阴影相机罩住鸟周围一圈（观鸟页的 ±10 cm 只罩鸟和枝条），每帧跟着鸟走（followSun）
    const shadowCam = this.lighting.sun.shadow.camera;
    shadowCam.left = -SHADOW_EXTENT;
    shadowCam.right = SHADOW_EXTENT;
    shadowCam.top = SHADOW_EXTENT;
    shadowCam.bottom = -SHADOW_EXTENT;
    shadowCam.near = 1;
    shadowCam.far = 900;
    shadowCam.updateProjectionMatrix();

    this.sky = new Sky(this.lighting.uniforms.uSunDir.value);
    this.backdrop = new Backdrop();
    this.snowfall = new Snowfall(11, SNOW_COUNT, SNOW_RANGE);
    this.branches = new Branches(this.lighting.uniforms, FOOT_SPOTS);
    // 栖枝几何从树枝那里精确查（样条高度、树皮鼓包、积雪帽），脚爪才贴在真实的面上
    this.bird = new Bird(this.lighting.uniforms, this.branches.perchAt(0));
    this.bird.furLod.enabled = opts.autoLod;
    // 仿真调试台：碰撞体来自 src/pcg/layout.ts 的纯数据，画面从同一份数据建（整棵树的枝条画进 branches）
    this.rig = new TestRig(this.lighting.uniforms, this.branches);
    this.rig.group.visible = opts.rig;
    this.scene.add(this.sky.mesh, this.backdrop.mesh, this.snowfall.mesh, this.branches, this.bird.group, this.rig.group, this.rig.overlay);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false;
    this.controls.minDistance = 3.5;
    this.controls.maxDistance = 800;
    this.controls.minPolarAngle = 0.35;
    this.controls.maxPolarAngle = 1.75;
    this.controls.rotateSpeed = 0.6;
    this.controls.zoomSpeed = 0.8;

    // 舞台 = 调试台：碰撞世界 + 栖面查询（主角枝 / 子枝的精确栖面）+ 活动场地 + 景点 + 回栖点；控制器只认 Stage 这一层
    const rig = this.rig;
    const branches = this.branches;
    const stage: Stage = {
      ...RIG_STAGE,
      world: rig.world,
      perches: {
        limbOf: (s) => rig.limbOf(s),
        tagOf: (s) => rig.tagOf(s),
        perchAt: (x) => branches.perchAt(x),
        limbPerch: (limb, u) => branches.limbPerch(limb, u),
      },
    };
    this.ctrl = new BirdController(this.bird, stage, this.motion, this.camera, this.controls, this.renderer, root);
    if (opts.play) this.ctrl.setEnabled(true);

    this.panel = opts.ui ? new Panel(root) : null;
    if (this.panel) this.buildPanel();

    // 数值 HUD：截图时帧率、三角形数、壳层数直接留在画面里，近远对比图自己会说话
    this.hud = opts.hud ? document.createElement('div') : null;
    this.hudStats = document.createElement('div');
    if (this.hud) {
      this.hud.className = 'hud';
      const title = document.createElement('div');
      title.className = 'hud__title';
      title.textContent = '雪精灵的城市漫游';
      const sub = document.createElement('div');
      sub.className = 'hud__sub';
      sub.textContent =
        '原型 · 三档视角 360° 自由看 · 鼠标：点击画面锁定后随便转（Esc 退出，没锁定时左键拖拽）· 地面：W 朝镜头方向转身连跳（3.8 跳 / 秒）、S 不转身后撤跳、A、D 侧跳 / 枝上 W、S 顺枝、A、D 掉头、W + 空格朝镜头方向跃离 / 腾空按住空格展翅起飞 · 飞行：自动巡航扑翼、鸟追着镜头方向飞，W / 空格爬升、Shift / 右键滑翔着陆、S 空中急刹、A、D 压坡（镜头跟着转） · V 追尾 → 过肩 → 纯第一人称（滚轮调追尾距离）· G 自由巡飞（第三人称自由环绕，按操控键接管）';
      this.hud.append(title, sub, this.hudStats);
      root.appendChild(this.hud);
    }

    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointermove', (e) => {
      const r = canvas.getBoundingClientRect();
      this.pointerNdc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      this.pointerInside = true;
    });
    canvas.addEventListener('pointerleave', () => (this.pointerInside = false));

    window.addEventListener('resize', () => this.resize(root));
    window.addEventListener('keydown', (e) => {
      if (e.key === 'h' || e.key === 'H') {
        if (this.panel) this.panel.visible = !this.panel.visible;
      }
    });
  }

  // ───────────── 截图脚本 / 面板用的转发（相机和操控都在 BirdController 里） ─────────────

  /** 视角模式（'follow' 是旧脚本的名字 = orbit 自由环绕）。 */
  get viewMode(): ViewMode {
    return this.cam.viewMode;
  }

  set viewMode(mode: ViewMode | 'follow') {
    this.cam.setViewMode(mode === 'follow' ? 'orbit' : mode);
  }

  get viewNow(): string {
    return this.cam.viewNowName;
  }

  get viewBlend(): number {
    return this.cam.viewBlendNow;
  }

  get bodyHidden(): boolean {
    return this.cam.bodyHiddenNow;
  }

  /** 视角方位 / 俯仰（世界方位 atan2(x, z) 正 = 往左；俯仰正 = 往上看）：截图脚本模拟鼠标直接改。 */
  get viewYaw(): number {
    return this.cam.viewYaw;
  }

  set viewYaw(v: number) {
    this.cam.viewYaw = v;
  }

  get viewPitch(): number {
    return this.cam.viewPitch;
  }

  set viewPitch(v: number) {
    this.cam.viewPitch = v;
  }

  /** 相机避障的探针读数（截图脚本用）。 */
  get camContact() {
    return this.cam.camContact;
  }

  get camPull(): number {
    return this.cam.camPull;
  }

  get camFull(): Vector3 {
    return this.cam.camFull;
  }

  /** 下一帧让跟随点直接跳到鸟身上（摆完机位后用）。 */
  set followInit(_v: false) {
    this.cam.resetFollow();
  }

  /** 飞行中没按 A/D、W/S 时航向 / 俯仰跟镜头 / 准星（截图脚本的 looksteer 场景直接调）。 */
  updateLookSteer(): void {
    this.cam.steerFlight();
  }

  get flightDist(): number {
    return this.cam.flightDist;
  }

  set flightDist(v: number) {
    this.cam.flightDist = v;
  }

  get camFollow(): boolean {
    return this.cam.camFollow;
  }

  set camFollow(v: boolean) {
    this.cam.camFollow = v;
  }

  get shoulderLocal(): Vector3 {
    return this.cam.shoulderLocal;
  }

  set shoulderLocal(v: Vector3) {
    this.cam.shoulderLocal.copy(v);
  }

  get shoulderPitch(): number {
    return this.cam.shoulderPitch;
  }

  set shoulderPitch(v: number) {
    this.cam.shoulderPitch = v;
  }

  /** V 键 / 面板：追尾 → 过肩 → 纯第一人称 循环。 */
  toggleView(): void {
    this.ctrl.toggleView();
  }

  /** 自由巡飞开关（G 键 / 面板）。 */
  setAuto(on: boolean): void {
    this.ctrl.setAuto(on);
  }

  /** 调试脚本摆完机位（直接改 controls / camera）后调：记进 orbit 管线，下一帧 beforePlayer 才不会把它还原回旧轨道位。 */
  saveOrbit(): void {
    this.cam.saveOrbit();
  }

  /** 调试脚本设定视角后调：不做 0.45 s 过渡，直接跳到当前档位的机位。 */
  snapView(): void {
    this.cam.snapView();
  }

  start(view = 'tp35'): void {
    this.setView(view);
    this.renderer.setAnimationLoop(this.tick);
  }

  /** 切到预设机位；名字可带 "@距离" 临时改相机距离（厘米），比如 tp@22。 */
  setView(name: string): void {
    const at = name.indexOf('@');
    const v = VIEWS[at < 0 ? name : name.slice(0, at)] ?? VIEWS.tp35;
    const dist = at < 0 ? v.dist : parseFloat(name.slice(at + 1)) || v.dist;
    this.view = name;
    this.cam.setView(v.az, v.el, dist, v.target);
  }

  private resize(root: HTMLElement): void {
    const w = root.clientWidth;
    const h = root.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  /** 微生命动作：算出这一帧的 Pose 并应用到鸟身上（总开关关闭时不应用）。准星偏着时头先朝准星看。 */
  private updateMotion(dt: number): void {
    const m = this.motion;
    // 头颈姿态相对躯干定义，注视目标按躯干当前朝向反算（扭身时头才不会盯着错的方向）
    this.bird.bodyWorldQuaternion(this.birdQuat);
    this.birdInvQuat.copy(this.birdQuat).invert();
    this.bird.headWorldPosition(this.headWorld);
    let gaze: Vector3 | null = null;
    if (this.player.enabled) {
      // 操控开着：准星偏出去时鸟头先朝准星注视（身体再转身 / 压坡追上去）；准星回正了没目标，动作系统照旧随机跳视
      gaze = this.ctrl.gazeTarget(this.headWorld, this.gazePoint);
    } else if (m.gazeMode === 'pointer' && this.pointerInside) {
      this.pointerRay.setFromCamera(this.pointerNdc, this.camera);
      this.gazePlane.setFromNormalAndCoplanarPoint(this.camera.getWorldDirection(this.camDir).negate(), this.headWorld);
      gaze = this.pointerRay.ray.intersectPlane(this.gazePlane, this.gazePoint);
    }
    const pose = m.update(dt, {
      headWorld: this.headWorld,
      worldToLocal: this.birdInvQuat,
      cameraWorld: this.camera.position,
      gazeWorld: gaze,
    });
    this.basePose = m.enabled ? pose : null;
    if (m.enabled) this.bird.applyPose(pose);
  }

  /** 相机到鸟躯干中心的距离（厘米），HUD 和远景虚化层的开关都用它。 */
  private cameraDistance(): number {
    return this.camera.position.distanceTo(this.bird.group.localToWorld(this.scratch.set(0, 2.5, -0.6)));
  }

  /** 太阳阴影相机跟着鸟走（对准点吸附到 2 cm 格点，不然阴影纹素跟着平滑移动会一直闪）。 */
  private followSun(): void {
    const p = this.bird.group.position;
    this.lighting.sun.target.position.set(Math.round(p.x / 2) * 2, Math.round(p.y / 2) * 2, Math.round(p.z / 2) * 2);
    this.lighting.setSun(this.lighting.azimuth, this.lighting.elevation);
  }

  /** 动态腿爪演示：有任何设置时，在动作系统之后覆盖脚的状态和躯干前俯（腿架按两段链跟着髋走）。 */
  private applyLegDemo(): void {
    const d = this.legDemo;
    if (d.open === 0 && !d.liftRight && !d.liftLeft && d.pitch === 0) return;
    this.bird.setBodyPose({ pitch: d.pitch, yaw: 0, roll: 0 });
    const foot = (lift: boolean, side: 1 | -1): FootState => {
      if (!lift) return { grip: 1 - d.open, ankle: null };
      const c = this.bird.legRig.gripCenter;
      // 抬到胸前下方：往前 0.3、往上 0.3 cm，张开的脚趾从腹羽下缘露出来
      return { grip: 1 - d.open, ankle: new Vector3(0.3 * side, c.y + 0.3, c.z + 0.3) };
    };
    this.bird.setFootPose('right', foot(d.liftRight, 1));
    this.bird.setFootPose('left', foot(d.liftLeft, -1));
  }

  private readonly tick = (now: number): void => {
    const dt = this.last ? Math.min((now - this.last) / 1000, 0.1) : 0.016;
    this.last = now;
    this.elapsed += dt;

    // 相机第一步：orbit 管线先处理鼠标 / 阻尼（操控开着时再跟到鸟背后）
    this.ctrl.beforePlayer(dt);
    this.snowfall.update(this.elapsed);
    this.bird.update(dt);
    this.updateMotion(dt);
    // 操控开着：镜头方向 → 步态 / 飞行 → 相机第二步（orbit 收尾 + 追尾 / 过肩 / 第一人称机位 + 准星）+ 气流尾迹
    if (this.player.enabled) this.ctrl.update(dt, this.basePose);
    else {
      this.applyLegDemo();
      this.controls.enabled = true;
    }
    // 天空球 / 飘雪箱子跟着相机，太阳阴影相机跟着鸟（观鸟页那边相机就在原点附近不用管；漫游会飞出 8 m，天空球半径只有 800）
    this.sky.mesh.position.copy(this.camera.position);
    this.snowfall.uniforms.uCenter.value.copy(this.camera.position);
    this.followSun();
    // 仿真调试台：小球探针和会颤的表面一起推进（调试台关掉时也推进，开关只管画面）
    this.rig.update(dt);
    // 绒毛壳层数按相机距离 / 像素密度自动缩放（关掉时还原成手动层数）
    this.bird.updateFurLod(this.camera, this.renderer.domElement.height, dt);
    // 远景虚化层是给微距观鸟用的色斑（75~240 cm）：第三人称距离上相机会钻进色斑里、糊住鸟，拉远就收掉；
    // 飞行时相机跟着鸟跑出枝头那一片，色斑是按枝头摆的，飞起来直接关
    const dist = this.cameraDistance();
    this.backdrop.mesh.visible = this.backdropOn && dist < 70 && !(this.player.enabled && this.player.flying);

    this.renderer.render(this.scene, this.camera);

    this.fpsCount++;
    this.fpsWindow += dt;
    if (this.fpsWindow >= 0.25) {
      const fps = this.fpsCount / this.fpsWindow;
      const info = this.renderer.info.render;
      const lod = this.bird.furLod;
      const distText = `相机 ${dist.toFixed(1)} cm`;
      const texts = [
        `${fps.toFixed(0)} fps · ${(1000 / fps).toFixed(1)} ms`,
        `${info.calls} 次 · ${info.triangles.toLocaleString('en-US')} 三角形`,
        lod.enabled ? `${this.bird.fur.shellCount} 层` : `${this.bird.fur.shellCount} 层（手动）`,
      ];
      this.stats.forEach((s, i) => s.set(texts[i] ?? ''));
      // 探针状态：活着几颗、落定几颗、最大压入（只在跑，面板和 HUD 每 0.25 s 读一次）
      const probes = this.rig.probes;
      const alive = probes.alive();
      this.probeStat?.set(
        `${alive} 颗 · 落定 ${probes.resting()} · 最大压入 ${probes.maxPenetration.toFixed(2)} cm${this.rig.paused ? ' · 已暂停' : ''}`,
      );
      // HUD 里多写一句等效距离：第三人称视场角比观鸟的宽，同样的距离折算过去更长
      if (this.hud) {
        const eq = lod.enabled ? `（等效 ${lod.distEq.toFixed(1)}）` : '，自动 LOD 关';
        const probeText = this.rigOn && alive ? `\n探针 ${alive} · 落定 ${probes.resting()}` : '';
        const playText = this.player.enabled ? `\n${this.player.statusText()}` : '';
        this.hudStats.textContent = `${texts[0]}\n${texts[1]}\n${texts[2]} · ${distText}${eq}${probeText}${playText}`;
        this.playerStat?.set(this.player.statusText());
      }
      // 自动 LOD 开着时手动壳层数不生效，滑块只跟着显示实际层数
      if (lod.enabled && this.manualShells) this.manualShells.set(this.bird.fur.shellCount);
      this.fpsWindow = 0;
      this.fpsCount = 0;
    }
  };

  private buildPanel(): void {
    const p = this.panel!;
    const lod = this.bird.furLod;
    const fur = this.bird.furUniforms;
    const pct = (v: number): string => `${(v * 100).toFixed(0)}%`;

    p.header('雪精灵的城市漫游', '原型 · 第三人称可操控山雀');

    const st = p.section('状态');
    this.stats = [p.stat(st, '帧率'), p.stat(st, '绘制'), p.stat(st, '绒毛壳层')];

    const vw = p.section('视角');
    p.segmented(vw, ['特写', '头部', '侧面', '远景', '35 cm', '60 cm', '100 cm', '180 cm', '脚部', '调试台', '树冠', '电线', '腹底'], 4, (i) =>
      this.setView(VIEW_NAMES[i]),
    );

    // 自动 LOD：开关 + 三个锚点的层数 + 低壳层时的毛长 / 密度补偿。距离锚点（14 / 35 / 180 cm）在 furLod.ts
    const fl = p.section('绒毛自动 LOD');
    // 手动壳层数：自动 LOD 开着时不生效（整行压暗，只跟着显示实际层数），关掉后还原成记下的值
    const manual = document.createElement('div');
    const syncManual = (): void => {
      manual.classList.toggle('is-locked', lod.enabled);
      this.manualShells?.set(lod.enabled ? this.bird.fur.shellCount : this.manualShellValue);
    };
    p.toggle(fl, '自动 LOD', lod.enabled, (on) => {
      lod.enabled = on;
      if (on) lod.reset();
      syncManual();
    });
    fl.appendChild(manual);
    this.manualShellValue = this.bird.fur.shellCount;
    this.manualShells = p.slider(
      manual,
      '手动层数',
      4,
      96,
      1,
      this.manualShellValue,
      (v) => {
        this.manualShellValue = v;
        this.bird.setFurShells(v);
      },
      (v) => v.toFixed(0),
    );
    syncManual();
    p.slider(fl, '近景层数', 32, 96, 1, lod.nearShells, (v) => (lod.nearShells = v), (v) => v.toFixed(0));
    p.slider(fl, '中距层数', 8, 64, 1, lod.midShells, (v) => (lod.midShells = v), (v) => v.toFixed(0));
    p.slider(fl, '远景层数', 4, 48, 1, lod.farShells, (v) => (lod.farShells = v), (v) => v.toFixed(0));
    p.slider(fl, '毛长补偿', 0, 0.2, 0.005, lod.lenBoost, (v) => (lod.lenBoost = v), (v) => `+${pct(v)}`);
    p.slider(fl, '密度补偿', -0.5, 0.5, 0.01, lod.densityBias, (v) => (lod.densityBias = v), (v) => {
      const s = pct(Math.abs(v));
      return v < 0 ? `−${s}` : `+${s}`;
    });

    const fr = p.section('绒毛');
    p.slider(fr, '毛长', 0.05, 0.5, 0.005, FUR_DEFAULTS.furLen, (v) => (fur.uFurLen.value = v), (v) => v.toFixed(3));
    p.slider(fr, '蓬松度', 0, 1, 0.01, FUR_DEFAULTS.fluff, (v) => (fur.uFluff.value = v), pct);
    p.slider(fr, '密度', 0.4, 1.6, 0.01, FUR_DEFAULTS.density, (v) => (fur.uDensity.value = v), pct);

    const ml = p.section('微生命');
    p.toggle(ml, '动作系统', this.motion.enabled, (on) => {
      this.motion.enabled = on;
      if (!on) this.bird.applyPose(restPose());
    });
    p.slider(ml, '活跃度', 0, 100, 1, Math.round(this.motion.activity * 100), (v) => (this.motion.activity = v / 100), (v) =>
      `${v.toFixed(0)}%`,
    );
    p.segmented(ml, ['随机注视', '跟随鼠标'], this.motion.gazeMode === 'pointer' ? 1 : 0, (i) => (this.motion.gazeMode = i === 0 ? 'auto' : 'pointer'));

    const sc = p.section('场景');
    p.toggle(sc, '远景虚化', true, (on) => (this.backdropOn = on));
    p.toggle(sc, '飘雪', true, (on) => (this.snowfall.mesh.visible = on));
    p.button(sc, '隐藏面板 (H)', () => (p.visible = false));

    // 仿真调试台：纯数学碰撞层（src/sim）的画面与探针。碰撞线框叠在画面上，看碰撞体和管子 / 盒子对不对得上
    const rg = p.section('仿真调试台');
    p.toggle(rg, '调试台', this.rigOn, (on) => {
      this.rigOn = on;
      this.rig.group.visible = on;
    });
    p.toggle(rg, '碰撞线框', this.rig.overlay.visible, (on) => (this.rig.overlay.visible = on));
    p.toggle(rg, '暂停仿真', this.rig.paused, (on) => (this.rig.paused = on));
    const row = document.createElement('div');
    row.className = 'seg';
    row.style.cursor = 'default';
    rg.appendChild(row);
    p.button(row, '撒 60 颗小球', () => this.rig.scatter(60));
    p.button(row, '电线落球', () => this.rig.scatterAlong(this.rig.curve('wire')!, 12));
    p.button(row, '清空小球', () => this.rig.clearProbes());
    this.probeStat = p.stat(rg, '探针');
    this.probeStat.set('0 颗 · 落定 0 · 最大压入 0.00 cm');

    // 操控（阶段 3~6）：地面 W 朝镜头方向转身连跳、S 不转身后撤、A、D 侧跳；枝上 W、S 顺枝、A、D 掉头；腾空按住空格起飞；
    // 飞行自动巡航扑翼、鸟追镜头方向飞；三档视角 360° 自由看；V 循环；G 自由巡飞 = AI 自动驾驶 + 第三人称自由环绕
    const pl = p.section(
      '操控 · 鼠标：点击画面锁定后 360° 随便转（Esc 退出；没锁定时左键拖拽）· 地面：W 朝镜头方向转身连跳、S 不转身后撤跳、A、D 侧跳 / 枝上 W、S 顺枝、A、D 掉头、W + 空格朝镜头方向跃离 / 空格小跳 / 腾空按住空格起飞 · 飞行：自动巡航扑翼、鸟追镜头方向飞，W / 空格爬升、Shift / 右键滑翔着陆、S 空中急刹、A、D 压坡 · V 追尾 → 过肩 → 纯第一人称 · 追尾模式滚轮调距离',
    );
    p.toggle(pl, '操控', this.player.enabled, (on) => this.ctrl.setEnabled(on));
    this.playerStat = p.stat(pl, '状态');
    this.playerStat.set(this.player.statusText());
    const mrow = document.createElement('div');
    mrow.className = 'seg';
    pl.appendChild(mrow);
    p.button(mrow, '视角：追尾 / 过肩 / 第一人称 (V)', () => this.toggleView());
    p.button(mrow, '回到栖枝', () => this.player.reset());
    // 自由巡飞（阶段 5 观赏模式）：AI 在景点之间轮换着飞（前瞻避障、高低起伏、扑翼-滑翔），相机是不自动回正的第三人称自由环绕
    const au = p.section('自由巡飞（观赏模式）· AI 自动驾驶在树冠 / 电线 / 屋顶 / 雪地之间轮换着飞，前瞻避障；相机 360° 自由环绕、滚轮缩放，不自动回正；按任意操控键或再点开关接管回手动');
    p.toggle(au, '自由巡飞 (G)', this.player.auto, (on) => this.setAuto(on));

    // 动态腿爪（阶段 2 调试，操控关着时才生效）：两段链反向运动学 + 三态脚趾。前俯时躯干绕抓握点转、跗跖跟着髋调；抬脚时脚趾绕虚拟圆柱张开
    const lg = p.section('动态腿爪');
    p.slider(lg, '脚趾张开', 0, 1, 0.01, 0, (v) => (this.legDemo.open = v), pct);
    p.slider(lg, '前俯', -0.3, 0.3, 0.01, 0, (v) => (this.legDemo.pitch = v), (v) => `${(v * 180 / Math.PI).toFixed(0)}°`);
    p.toggle(lg, '抬右脚', false, (on) => (this.legDemo.liftRight = on));
    p.toggle(lg, '抬左脚', false, (on) => (this.legDemo.liftLeft = on));
  }
}
