/**
 * 《雪精灵的冬日庭院》合流入口（index.html / garden.html 同一个应用）：一镜到底的"观鸟 ↔ 漫游"。
 *
 *   观鸟态（默认进场）：长焦微距浅景深——小鸟和脚下的精雕主角枝（含前景红果侧枝）在硬件 MSAA 的锐利层里，背后的三层洋房、阳光房、
 *   雪院、老海棠的树干和其余全部枝条整层圆盘散景虚化（BokehStage：图层 0 渲染进 0.55× 离屏图 → Vogel 圆盘散景 → 主画布底层；
 *   再清深度把图层 1 直绘到主画布）。OrbitControls 完全开着（3.5~90 cm 滚轮、360° 环绕、鼠标拨果枝），右侧是完整的观鸟面板（src/ui/Panel），
 *   底部正中和面板顶部各一枚「展翅漫游小院 ➔」。
 *   点按钮 → 不刷新页面：bokehMix 0.6 s 内 1 → 0（小院由虚变清对焦），相机同一时间段从观鸟机位过渡到第三人称追尾视角，
 *   BirdController 接管（鸟留在栖枝上、保持横站朝向，立刻能按 WASD 蹦跳 / 空格起飞 / Shift 冲刺 / 右键滑翔），面板滑出、HUD 淡入、
 *   右上角出现「← 返回观鸟」。漫游态里 R = 回栖枝重置（保持漫游态）。
 *   「← 返回观鸟」→ 关操控 / 退 Pointer Lock，鸟回栖枝横站、恢复栖枝宿主的微生命，相机 0.6 s 推回 threequarter 微距，bokehMix 0 → 1。
 *
 * URL：?play=1 直接以清晰漫游态启动；?play=0&view=xxx 给 tools/shoot.mjs 拍预设机位（非观鸟微距的展示机位自动令 bokehMix = 0）；
 * ?ui=0 不建面板 / 按钮（截图）；?debug=1 碰撞叠加；?tour=1 开掠飞巡游演示（驱动草浪和树叶的气流）。
 * 渲染器 / 相机 / 灯光 / 天空 / 飘雪 / 雪地 / 碰撞叠加 / HUD / 气流：各个视觉构建器都挂在 scene 下，全部读 src/pcg/courtyard.ts 的同一份数据；
 * 碰撞体也按这份数据建（buildCourtyardWorld），操控层只认 Stage 这一层。window.__birds = app（tools/shoot.mjs 多机位截图、rigcheck 读 branches）。
 */
import { ACESFilmicToneMapping, CatmullRomCurve3, Color, ConeGeometry, DoubleSide, Group, Mesh, MeshBasicMaterial, PerspectiveCamera, PCFShadowMap, Plane, Quaternion, Raycaster, Scene, SRGBColorSpace, Vector2, Vector3, WebGLRenderer } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Sky } from '../world/Sky';
import { SnowPuff } from '../world/snowPuff';
import { crabapplePerchCurves } from '../world/crabappleTree';
import type { Limb, SnowPress } from '../world/Branch';
import { Bird, type BirdPart, type BlinkPose, type TailPose, type WingPose } from '../bird/Bird';
import { FUR_DEFAULTS } from '../bird/fur';
import { MotionController, type MotionCue } from '../bird/motion/MotionController';
import { restPose, type Pose } from '../bird/motion/Pose';
import { Panel } from '../ui/Panel';
import { buildCourtyardLayout, buildCourtyardWorld, CONSV, GROUND, isPerchLimb, buildSpringGround, springHeight, WATCH_VIEWS, watchCamera } from '../pcg/courtyard';
import type { Layout } from '../pcg/layout';
import { buildGround } from '../sim/buildWorld';
import type { Surface } from '../sim/surface';
import { CurvePerch } from '../sim/curvePerch';
import type { FlySpot } from '../sim/autopilot';
import { BirdController } from '../roam/BirdController';
import type { Stage, StagePerchInteract, Wake } from '../roam/stage';
import { CourtyardLighting } from './CourtyardLighting';
import { CourtyardMaterials } from './materials';
import { buildSnowGround } from './SnowGround';
import { SnowPrints } from './SnowPrints';
import { CourtyardSnowfall } from './Snowfall';
import { Overlay } from './Overlay';
import { buildYard } from './Yard';
import { buildPines } from './Pines';
import { buildHouse } from './House';
import { buildTree, type TreeBuild } from './Tree';
import { buildGreenhouse, type GreenhouseBuild } from './Greenhouse';
import { buildConservatory, type ConservatoryBuild } from './Conservatory';
import { Batch } from './batch';
import { buildPlants } from './Plants';
import { buildGrass, type GrassBuild } from './Grass';
import { buildSpringLawn, type SpringLawnBuild } from './SpringLawn';
import { buildFoliage, type FoliageBuild } from './Foliage';
import { AirflowField, airflowUniforms } from './Airflow';
import { CROSS_ALONG, PerchHost } from './PerchHost';
import { BokehStage, LAYER_BG, LAYER_FG } from './BokehStage';
import { DynamicWires } from './DynamicWires';
import { Music, trackLabel } from './Music';

type V3 = [number, number, number];

export interface ViewPreset {
  pos: V3;
  target: V3;
  fov?: number;
  /** 观鸟微距机位（鸟和主角枝锐利、背景散景）；展示机位（全景 / 植物园 / 洋房……）不标 = 清晰全画。 */
  macro?: boolean;
}

/** 观鸟微距预设（面板"视角"分段的顺序 = pcg/courtyard.ts 的 WATCH_VIEWS 顺序，机位和视线锥禁入区是同一份数据）。 */
const WATCH_NAMES = ['threequarter', 'side', 'front', 'back', 'head', 'tail', 'wide', 'top', 'topfront', 'rear'];
const WATCH_LABELS = ['四分之三', '侧面', '正面', '背面', '头部', '尾部', '远景', '俯视', '斜俯视', '正后方'];
/** 面板里顺带的几个小院展示机位（清晰全画，散景自动关）。 */
const YARD_VIEWS: [string, string][] = [
  ['全景', 'overview'],
  ['老海棠', 'tree'],
  ['植物园', 'consv'],
  ['洋房', 'house'],
];

/** 展示镜头：开场观鸟微距、院落全景、三楼屋檐俯瞰、枯草地微距、大植物园全景 / 室内草坡与海棠 / 天窗、花房内部…… */
export const VIEWS: Record<string, ViewPreset> = {};
WATCH_VIEWS.forEach((v, i) => {
  VIEWS[WATCH_NAMES[i]] = { pos: watchCamera(v), target: v.target, fov: 28, macro: true };
});
Object.assign(VIEWS, {
  overview: { pos: [-1900, 720, 3000], target: [260, 120, -320], fov: 42 },
  house: { pos: [-340, 150, 1150], target: [-340, 380, -560], fov: 42 },
  eave: { pos: [400, 870, -380], target: [-320, -60, 460], fov: 52 },
  grass: { pos: [290, -104, 560], target: [120, 150, -300], fov: 52 },
  inside: { pos: [200, 50, -215], target: [300, 30, -360], fov: 55 },
  inside2: { pos: [-60, 60, -230], target: [100, 120, -420], fov: 60 },
  inside3: { pos: [150, 30, -215], target: [20, -10, -470], fov: 55 },
  tree: { pos: [-760, 340, 980], target: [-40, 260, -60], fov: 42 },
  bird: { pos: [-9, 14, 44], target: [-2, 1, 0], fov: 30 },
  vent: { pos: [320, 440, 60], target: [160, 230, -290], fov: 38 },
  door: { pos: [130, 40, 230], target: [70, 20, -170], fov: 42 },
  // 整座院子的正俯视（观鸟的"俯视"预设占了 top 这个名字）
  yardtop: { pos: [300, 3600, 2], target: [300, 0, 0], fov: 45 },
  lawn: { pos: [-700, -40, 700], target: [0, 120, -200], fov: 50 },
  // 大植物园
  consv: { pos: [-900, 520, 2400], target: [900, 120, -200], fov: 46 },
  consvDoor: { pos: [-300, 190, 330], target: [640, 100, 320], fov: 46 },
  consvIn: { pos: [520, 40, 760], target: [1000, 220, -300], fov: 55 },
  consvIn2: { pos: [1300, 120, 860], target: [700, 320, -500], fov: 58 },
  consvVent: { pos: [500, 880, 520], target: [860, 420, 80], fov: 50 },
  consvMacro: { pos: [640, -62, 440], target: [900, 60, 120], fov: 48 },
  consvTree: { pos: [700, 180, -120], target: [1050, 260, -350], fov: 50 },
  // 小花房 / 洋房西山墙 / 拱门
  stand: { pos: [60, 40, -180], target: [170, 30, -300], fov: 55 },
  west: { pos: [-1650, 300, -200], target: [-700, 330, -870], fov: 38 },
  arch: { pos: [40, 20, -480], target: [360, 10, -480], fov: 50 },
});
/** 观鸟态的竖直视场角：微距（≤ 40 cm）恒 28°（和观鸟入口一样），拉远到 700 cm 放宽到 62°（长焦在 5 m 外装不下院子）。 */
const FOV_NEAR = 28;
const FOV_FAR = 62;
/** 观鸟态的轨道范围（厘米）：3.5 cm 贴到喙尖微距，90 cm 看整根主角枝。 */
const DIST_MIN = 3.5;
const DIST_MAX = 90;
/** 阴影相机：相机贴近鸟时只罩鸟周围这么大（4096 贴图 → 0.07 cm/px，鸟自己的影子和观鸟入口一样清楚），拉远后扩到整座院子。 */
const SHADOW_NEAR = 150;
const SHADOW_FAR = 1750;
/** 院子中心（阴影相机罩整座院子时的对准点，和 CourtyardLighting 原来的一样）。 */
const YARD_CENTER = new Vector3(270, 150, 0);
/** 观鸟 ↔ 漫游的一镜到底时长（秒）：散焦度、镜头交接、相机推回都用它。 */
const TRANSITION = 0.6;
/** 底部操作提示条的键位说明。 */
const HELP_TEXT =
  'WASD 蹦跳/转向 · 空格 起跳/飞升 · Shift 飞行加速冲刺 · 右键/C 收翼滑翔落枝 · S 空中减速急刹 · V 切换视角 · G 自由巡飞 · R 回栖枝';
/** 三档视角的中文名（HUD 的视角行）。 */
const VIEW_TEXT: Record<string, string> = { chase: '追尾', shoulder: '过肩', eye: '第一人称', orbit: '自由环绕' };

/**
 * 活动场地：长方形，中心 (250, 0)、半边长 1500 × 1300 ≈ 栅栏到栅栏（x −1250..1750、z ±1300，两轴各按各的半边长算超出比例）；
 * 1.35 倍外逆风、1.5 倍是风墙，都在栅栏外的雪原上空、不碰松林。掉到 −300 以下（雪面是实心的，正常到不了）放回场上空 40。
 */
const STAGE_BOUNDS = { x: 250, y: 40, z: 0, radius: 1500, radiusZ: 1300, voidY: -300 };
/** 自由巡飞（G）的景点：都在室外（温室里的落点 AI 找不到门），多半在栏杆 / 屋脊 / 树冠 / 电线这些能落的面上方。 */
const FLY_SPOTS: FlySpot[] = [
  { x: -160, y: 330, z: -430, r: 70 },
  { x: -500, y: 20, z: 700, r: 120 },
  { x: 255, y: 620, z: -400, r: 70 },
  { x: 130, y: 190, z: 430, r: 60 },
  { x: -60, y: 330, z: -20, r: 80 },
  { x: -400, y: 20, z: -200, r: 70 },
  { x: -180, y: 940, z: -870, r: 80 },
  { x: -850, y: 600, z: 540, r: 60 },
  { x: -800, y: 30, z: 200, r: 110 },
  { x: 100, y: 10, z: 300, r: 90 },
  { x: -250, y: 20, z: 1000, r: 100 },
];

export interface CourtyardAppOptions {
  ui: boolean;
  debug: boolean;
  dprCap: number;
  /** 启动时开不开掠飞巡游演示（合流后默认关：画面里有一只真鸟）。 */
  tour: boolean;
  /** 进场直接是漫游态（?play=1）；默认 false = 观鸟微距态。 */
  play: boolean;
  /** 背景音乐（观鸟 / 小院两首）；?music=0 关掉（截图 / 压测脚本）。第一次真实用户手势才起。 */
  music: boolean;
}

/** 掠飞巡游路线：从雪院低空进西门 → 掠过草坪（离地 30~90 cm）→ 绕主海棠树冠 → 从天窗俯冲出去 → 越过拱顶回来。 */
const TOUR_POINTS: V3[] = [
  [180, -70, 320],
  [330, -80, 320],
  [420, -80, 330],
  [560, -70, 420],
  [700, -60, 520],
  [820, -50, 470],
  [900, -20, 300],
  [960, 60, 80],
  [980, 180, -120],
  [1020, 300, -300],
  [1150, 360, -440],
  [1180, 300, -560],
  [1050, 250, -650],
  [900, 200, -520],
  [820, 250, -330],
  [795, 420, 50],
  [795, 560, 100],
  [795, 700, 100],
  [900, 760, 300],
  [1100, 720, 700],
  [1200, 600, 1100],
  [900, 500, 1250],
  [600, 420, 1200],
  [400, 300, 900],
  [300, 160, 560],
  [200, 40, 400],
];

export class CourtyardApp {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly lighting: CourtyardLighting;
  readonly sky: Sky;
  readonly snowfall = new CourtyardSnowfall();
  readonly overlay: Overlay;
  readonly tree: TreeBuild;
  readonly greenhouse: GreenhouseBuild;
  readonly conservatory: ConservatoryBuild;
  readonly grass: GrassBuild;
  readonly lawn: SpringLawnBuild;
  readonly foliage: FoliageBuild;
  readonly airflow: AirflowField;
  readonly layout: Layout;
  readonly mats: CourtyardMaterials;
  /** 前背景双层分离的圆盘散景（观鸟态）。 */
  readonly bokeh: BokehStage;
  readonly hud: HTMLElement | null;
  readonly panel: Panel | null;
  readonly marker: Group;
  /** 小鸟 + 微生命动作系统（呼吸 / 扫视 / 眨眼 / 甩尾 / 枝头蹦跳……）。 */
  readonly bird: Bird;
  readonly motion = new MotionController();
  /** 蹬枝 / 落地震落的雪粉。 */
  readonly puff = new SnowPuff();
  /** 雪印：鸟在覆雪面落地 / 蹬地踩出的坑（全院雪材质共用一份 uniform）。 */
  readonly prints = new SnowPrints();
  /** 碰撞面 → 布局 tag（按注册顺序：曲线 → 地面 → 盒 → 斜板 → 春日地形），雪印只认覆雪的 tag。 */
  private tags: string[] = [];
  /** 跨院双层电线（顶面雪条）+ 植物园拉杆的动态管子：按碰撞层 CurvePerch 的弹簧位移每帧改顶点（背景图层 0）。 */
  readonly wires: DynamicWires;
  /** 会颤的老海棠枝 / 春树枝：碰撞曲线 → 画面枝条表里的序号（写活跃枝槽位用）。 */
  private readonly crabLimbOf = new Map<Surface, number>();
  private readonly springLimbOf = new Map<Surface, number>();
  /** 这一帧的活跃颤动枝（按 |位移| 从大到小，最多 6 根；常驻数组，不每帧分配）。 */
  private readonly activeCrab: { limb: number; offset: number }[] = [];
  private readonly activeSpring: { limb: number; offset: number }[] = [];
  /** 主角枝雪印 / 雪粉用的落点（常驻）。 */
  private readonly heroPress: SnowPress[] = [
    { worldX: 0, alpha: 0.03 },
    { worldX: 0, alpha: -0.02 },
  ];
  private readonly heroSway = new Vector2();
  private readonly puffPos = new Vector3();
  /** 观鸟态的栖枝宿主（蹦跳层驱动的外部世界）。 */
  readonly perch: PerchHost;
  /** 舞台 = 碰撞世界 + 栖面查询 + 活动场地 + 景点 + 回栖点；操控 / 相机 / 自动巡飞都在 BirdController 里。 */
  readonly stage: Stage;
  readonly ctrl: BirdController;
  /** 背景音乐：观鸟态 lo-fi lullaby、漫游态 lo-fi chillhop（同调姊妹曲，交叉淡化；第一次真实手势才起）。 */
  readonly music: Music;
  /** 进场直接是漫游态（?play=1）。 */
  readonly play: boolean;
  /** 观鸟态（微距散景）/ 漫游态（清晰全画 + 操控）。 */
  mode: 'watch' | 'roam' = 'watch';
  view = 'threequarter';
  /** 当前的机位是不是观鸟微距（散景只在微距机位成立，展示机位自动清晰）。 */
  private macroView = true;
  /** 面板"背景虚化度"滑块（0..1，默认拉满）。 */
  bokehAmount = 1;
  /** 这一帧的散焦度 0..1（渲染用）。 */
  bokehMix = 1;
  private bokehFrom = 1;
  private bokehTo = 1;
  private bokehT = 1;
  private bokehDur = 0;
  /** 演示状态。 */
  tour = true;
  mouseSweep = true;
  external = false;

  private elapsed = 0;
  private last = 0;
  private fpsWindow = 0;
  private fpsCount = 0;
  /** 四行统计（帧率 / 绘制 / 着色器 / 操控）同时写进 HUD 和面板。 */
  private readonly hudStatEls: HTMLElement[] = [];
  private readonly panelStats: { set(text: string): void }[] = [];
  /** HUD 的视角行（操控态跟着三档视角走）。 */
  private viewEl: HTMLElement | null = null;
  /** 回观鸟时相机从追尾机位推回微距机位的过渡。 */
  private fly: { t: number; dur: number; fromPos: Vector3; fromTarget: Vector3; fromFov: number; toPos: Vector3; toTarget: Vector3; toFov: number } | null = null;
  /** 动作系统这一帧的 Pose（动作系统关着时为 null）：操控层在它上面叠加翅 / 尾。 */
  private basePose: Pose | null = null;
  private readonly tourCurve = new CatmullRomCurve3(TOUR_POINTS.map((p) => new Vector3(p[0], p[1], p[2])), true, 'centripetal');
  private tourT = 0;
  private wingPhase = 0;
  private readonly mouse = new Vector2(1e9, 1e9);
  private mouseAt = -10;
  private readonly mousePos = new Vector3();
  private readonly mousePrev = new Vector3();
  private mouseHas = false;
  private readonly ray = new Raycaster();
  private sweepTargets: Mesh[] = [];
  // 鼠标划过果枝（观鸟态）：指针 NDC → 射线；指针速度判断"快速划过"
  private readonly pointerNdc = new Vector2();
  private readonly pointerPrev = new Vector2();
  private pointerTime = 0;
  private lastKick = -1;
  private pointerInside = false;
  private readonly pointerRay = new Raycaster();
  private readonly gazePlane = new Plane();
  private readonly gazePoint = new Vector3();
  private readonly headWorld = new Vector3();
  private readonly birdQuat = new Quaternion();
  private readonly birdInvQuat = new Quaternion();
  private readonly camDir = new Vector3();
  // 阴影相机跟鸟：光源视图里的纹素吸附
  private readonly shadowX = new Vector3();
  private readonly shadowY = new Vector3();
  private readonly shadowTarget = new Vector3();
  private readonly wakeScratch: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 };

  constructor(root: HTMLElement, opts: CourtyardAppOptions) {
    this.renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance', stencil: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, opts.dprCap));
    this.renderer.setSize(root.clientWidth, root.clientHeight);
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.92;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;
    root.appendChild(this.renderer.domElement);
    this.bokeh = new BokehStage(this.renderer, { scale: 0.55 });
    this.tour = opts.tour;
    this.play = opts.play;

    // 近裁面 0.5：开场微距离鸟 12 cm，观鸟入口同款；远裁面要装下松林和天空球
    this.camera = new PerspectiveCamera(FOV_NEAR, root.clientWidth / root.clientHeight, 0.5, 16000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    // 不许平移：观鸟态轨道目标始终是鸟（展示机位各自有自己的目标）
    this.controls.enablePan = false;
    this.controls.rotateSpeed = 0.6;
    this.controls.zoomSpeed = 0.8;
    this.applyControlsLimits(false);

    this.lighting = new CourtyardLighting(this.scene);
    // 散景的锐利层那趟只看前景图层：太阳得同时在两个图层上，不然那一趟没有阴影贴图
    this.lighting.sun.layers.enable(LAYER_FG);
    this.sky = new Sky(this.lighting.uniforms.uSunDir.value);
    this.sky.mesh.scale.setScalar(9);
    this.mats = new CourtyardMaterials(this.lighting.uniforms, this.prints);
    // 院心树先建：碰撞布局里的栖枝曲线直接取它建好的老海棠枝条表（画面和碰撞永远是同一棵树）
    this.tree = buildTree(this.lighting.uniforms);
    this.layout = buildCourtyardLayout(crabapplePerchCurves({ specs: this.tree.branches.treeSpecs }));
    this.airflow = new AirflowField(airflowUniforms());
    this.airflow.enabled = true;

    const snowField = buildGround(GROUND);
    const ground = buildSnowGround(snowField, this.mats.snow, this.mats.snowFar);
    // 电线 / 拉杆的中心线不画静态的：DynamicWires 自己画一条跟着振动的实时中心线（挂进 overlay 组）
    const DYNAMIC_TAGS = new Set(['wire', 'cv-tie']);
    this.overlay = new Overlay(this.layout, (t) => DYNAMIC_TAGS.has(t));
    this.overlay.visible = opts.debug;

    this.scene.add(this.sky.mesh, ground, this.snowfall.mesh, this.overlay.group, this.puff.mesh);
    this.grass = buildGrass(this.lighting.uniforms);
    // 洋房 / 小花房 / 大植物园 / 院落设施 / 植物 / 远景松林共用一个 Batch：同类材质全院只合成一个网格
    const batch = new Batch();
    this.greenhouse = buildGreenhouse(this.mats, batch, this.lighting.uniforms);
    const springField = buildSpringGround();
    this.conservatory = buildConservatory(this.mats, batch, this.greenhouse.glass as unknown as CourtyardMaterials['windowGlass'], springField, 5000);
    buildYard(this.mats, batch);
    buildPines(batch, this.mats, snowField);
    buildHouse(this.mats, batch);
    buildPlants(this.mats, batch);
    const statics = new Group();
    statics.name = 'courtyard-static';
    batch.build(statics);
    // 植物叶片 / 花瓣 / 冰柱不投影（省阴影通道的面数，室内暖光靠补光项）
    for (const mesh of statics.children) if (/^batch:(leaf|petal|stem|soil|glass|ice|pineFar|gravel|brick|cedarWarm)$/.test(mesh.name)) mesh.castShadow = false;
    this.lawn = buildSpringLawn(this.lighting.uniforms, springField, this.airflow);
    // 春树的叶 / 花和春树枝条共用同一份活跃枝槽位：枝弯了，挂在上面的叶和花一起走
    this.foliage = buildFoliage(this.lighting.uniforms, this.airflow, this.tree.springBranches.limbUniforms);
    this.scene.add(statics, this.tree.group, this.grass.group, this.conservatory.springGround, this.lawn.group, this.foliage.group);
    const snowMeshes = ground.children.filter((c): c is Mesh => c instanceof Mesh);
    this.sweepTargets = [...snowMeshes, this.conservatory.springGround];

    // 演示小鸟的替身：一枚深色的小镖 + 两片三角翅（只在巡游开着时可见）
    this.marker = new Group();
    this.marker.name = 'airflow-marker';
    const body = new Mesh(new ConeGeometry(2.2, 11, 6), new MeshBasicMaterial({ color: new Color('#2a2624') }));
    body.rotation.x = -Math.PI / 2;
    body.position.z = -3;
    const wingGeo = new ConeGeometry(1.2, 16, 3);
    for (const side of [-1, 1]) {
      const w = new Mesh(wingGeo, new MeshBasicMaterial({ color: new Color('#3a3430'), side: DoubleSide }));
      w.rotation.z = side * (Math.PI / 2);
      w.position.set(side * 8, 0, -1);
      w.scale.set(1, 1, 0.12);
      this.marker.add(w);
    }
    this.marker.add(body);
    this.marker.visible = false;
    this.scene.add(this.marker);

    // 小鸟：按"栖枝原位（沿 +X）"的落点建好，再由栖枝宿主把它转成横站（面朝 +Z = 朝草坪和相机这一侧，两脚沿枝左右分开）
    this.bird = new Bird(this.lighting.uniforms, this.tree.branches.perchAt(0));
    // 绒毛壳层数自动 LOD：微距 25 cm 内满配（和观鸟入口逐像素一致），中景 60 cm 降到 24 层，远景 16 层
    this.bird.furLod.nearDist = 25;
    this.bird.furLod.midDist = 60;
    this.scene.add(this.bird.group);
    this.perch = new PerchHost(this.bird, this.tree.branches, this.puff, this.motion.hop, 0);
    // 枝头蹦跳层驱动这个宿主（观鸟态）；操控接管时摘掉，不然蹦跳层落地时会把飞行中的鸟拽回枝上
    this.motion.hop.host = this.perch;
    this.stage = this.buildStage();
    // 跨院电线 + 拉杆的动态管子：绑定舞台世界里对应的 CurvePerch（背景图层 0：观鸟态跟房屋一起虚化，漫游态单趟直绘）
    const dynPerches: { perch: CurvePerch; tag: string }[] = [];
    this.layout.curves.forEach((c, i) => {
      if (DYNAMIC_TAGS.has(c.tag) && this.stage.world.surfaces[i] instanceof CurvePerch) dynPerches.push({ perch: this.stage.world.surfaces[i] as CurvePerch, tag: c.tag });
    });
    this.wires = new DynamicWires(dynPerches, this.mats);
    this.scene.add(this.wires.group);
    this.overlay.group.add(this.wires.debug);
    this.ctrl = new BirdController(this.bird, this.stage, this.motion, this.camera, this.controls, this.renderer, root);
    // 脚印 → 雪印（覆雪面才留）；落地冲击 / 蹬离 → 震落雪粉（室外覆雪的枝 / 线 / 栏杆 / 雪地）
    this.ctrl.player.onFootprint = (p, n, surface, kind) => {
      this.stampPrint(p, surface);
      this.puffAt(p, n, surface, kind);
    };
    this.ctrl.onWake = (w: Wake): void => {
      // 扑翼相位 Flight 给的是弧度，气流着色器要的是周期数
      // 展翅度也传给气流：地面蹦跳的拨草尾流乘它（蹬伸 / 腾空 0.4、站着 0）
      this.setBirdWake([w.x, w.y, w.z], [w.vx, w.vy, w.vz], w.flapPhase / (Math.PI * 2), w.wingOpen);
    };
    // 背景音乐：进场该放的那首先拉（观鸟 = watch，?play=1 = yard），好了以后另一首空闲预载；真正出声等第一次真实手势
    this.music = new Music(opts.music);
    this.music.prime(this.play ? 'yard' : 'watch');
    this.music.play(this.play ? 'yard' : 'watch');

    // 散景的图层分配：前景锐利层 = 小鸟 + 主角枝一套 + 雪粉 + 调试叠加；其余（房屋 / 雪院 / 老海棠 / 春树）留在背景层。
    // 飘雪两个图层都在，由 BokehStage 每趟渲染前按 uPass 分近处（锐利）/ 远处（虚化）
    this.bokeh.setForeground([this.bird.group, this.tree.heroGroup, this.puff.mesh, this.overlay.group]);
    this.bokeh.onPass = (pass) => (this.snowfall.uniforms.uPass.value = pass === 'bg' ? 0 : pass === 'fg' ? 1 : 2);
    this.bokeh.setSize(this.renderer.domElement.width, this.renderer.domElement.height);

    if (opts.ui) {
      this.hud = this.buildHud(root);
      this.panel = new Panel(root);
      this.buildPanel();
      this.buildButtons(root);
    } else {
      this.hud = null;
      this.panel = null;
    }
    window.addEventListener('resize', () => this.resize(root));
    window.addEventListener('keydown', (e) => {
      // 空格在漫游态里是跳 / 爬升（Player 自己处理并阻止页面滚动），观鸟态也不能让页面滚
      if (e.code === 'Space') e.preventDefault();
      if (e.code === 'KeyR' && this.mode === 'roam') this.resetToPerch();
      if (e.key === 'd' || e.key === 'D') this.overlay.visible = !this.overlay.group.visible;
      if (e.key === 'f' || e.key === 'F') this.setTour(!this.tour);
      if (e.key === 'm' || e.key === 'M') this.setMouseSweep(!this.mouseSweep);
      if ((e.key === 'h' || e.key === 'H') && this.panel) this.panel.visible = !this.panel.visible;
    });
    const onMove = (e: PointerEvent): void => {
      if (e.buttons !== 0) return;
      this.mouse.set((e.clientX / root.clientWidth) * 2 - 1, -(e.clientY / root.clientHeight) * 2 + 1);
      this.mouseAt = this.elapsed;
      // 鼠标快速划过前景的海棠果枝（NDC 速度 > 1.8 / s），拨动它轻晃，甩的方向跟着划过的方向（和观鸟入口同一套）。
      // 漫游态也放开（2026-11-23）：只要没在 Pointer Lock 里、镜头离主角枝够近（160 cm 内），划过果枝照样能拨动它——
      // 果梗单摆跟着主枝的加速度晃，鸟在旁边站着也不冲突
      const now = performance.now() / 1000;
      const speed = Math.hypot(this.mouse.x - this.pointerPrev.x, this.mouse.y - this.pointerPrev.y) / Math.max(now - this.pointerTime, 1e-3);
      const nearTwig = this.camera.position.lengthSq() < 160 * 160;
      if ((this.mode === 'watch' || (!document.pointerLockElement && nearTwig)) && this.pointerInside && speed > 1.8 && now - this.lastKick > 0.15) {
        this.pointerRay.setFromCamera(this.pointerNdc.copy(this.mouse), this.camera);
        if (this.tree.branches.twigHit(this.pointerRay)) {
          this.tree.branches.kickTwig(Math.min(speed * 0.35, 2.5), Math.sign(this.mouse.x - this.pointerPrev.x) || 1);
          this.lastKick = now;
        }
      }
      this.pointerPrev.copy(this.mouse);
      this.pointerTime = now;
      this.pointerInside = true;
    };
    root.addEventListener('pointermove', onMove);
    root.addEventListener('pointerleave', () => (this.pointerInside = false));
  }

  /** 舞台：碰撞世界（布局 + 温室春日地形）+ 栖面查询（碰撞曲线 → 画面的枝）+ 活动场地 + 景点 + 回栖点（主角枝 x = 0，横站面朝 +Z）。 */
  private buildStage(): Stage {
    const layout = this.layout;
    const world = buildCourtyardWorld(layout);
    const b = this.tree.branches;
    // 碰撞体 → 画面的枝：老海棠按 tag 里的序号对回 treeLimbs；春树按布局里的先后对回 springLimbs（只数能落脚的枝，和 perchCurvesOf 同一个判式）
    const limbs = new Map<Surface, Limb>();
    const springPerch: Limb[] = [];
    for (const t of this.tree.springTrees) {
      t.limbs.forEach((l, j) => {
        if (isPerchLimb(l)) springPerch.push(this.tree.springLimbs[t.offset + j]);
      });
    }
    let springK = 0;
    // 全部碰撞面的 tag（和 buildCourtyardWorld 的注册顺序一致：曲线 → 地面 → 盒 → 斜板 → 春日地形）
    this.tags = [...layout.curves.map((c) => c.tag), ...layout.grounds.map(() => 'ground'), ...layout.boxes.map((b) => b.tag), ...(layout.slopes ?? []).map((s) => s.tag), 'spring'];
    const tags = layout.curves.map((c) => c.tag);
    layout.curves.forEach((c, i) => {
      const s = world.surfaces[i];
      if (c.tag.startsWith('tree:')) {
        const k = Number(c.tag.slice(5));
        limbs.set(s, b.treeLimbs[k]);
        // 会颤的老海棠枝：碰撞曲线 → 枝条表序号（活跃枝槽位按它写 aLimb 号）
        if (s instanceof CurvePerch && s.dynamic) this.crabLimbOf.set(s, k);
      } else if (c.tag.startsWith('spring-')) {
        const limb = springPerch[springK++];
        limbs.set(s, limb);
        if (s instanceof CurvePerch && s.dynamic) this.springLimbOf.set(s, this.tree.springLimbs.indexOf(limb));
      }
    });
    return {
      world,
      perches: {
        limbOf: (s) => limbs.get(s) ?? null,
        tagOf: (s) => tags[s.id] ?? null,
        perchAt: (x) => b.perchAt(x),
        limbPerch: (limb, u) => b.limbPerch(limb, u),
        // 主角枝（tag branch：悬臂梁弯曲由画面层的 BranchSway 算）的栖面交互：落地 / 蹬离冲量、蓄力预压、鸟根跟着枝的位移走
        interact: this.heroInteract(),
      },
      bounds: STAGE_BOUNDS,
      flySpots: FLY_SPOTS,
      groundY: -120,
      home: { root: { x: 0, y: 0, z: 0, yaw: 0 }, query: { x: 0, y: 0.3, z: 0, hx: 0, hz: 1 }, perchX: 0 },
    };
  }

  /** 观鸟入口的树枝（tools/rigcheck.mjs 读 joints / weldedJoints / berryJoints）。 */
  get branches() {
    return this.tree.branches;
  }

  /** 碰撞面的布局 tag（调试 / 自检）；没有面（腾空）= null。 */
  tagOf(s: Surface | null): string | null {
    return s === null ? null : (this.tags[s.id] ?? null);
  }

  /**
   * 脚印 → 雪印：只认覆雪面——tag 以 snow 结尾的（屋顶 / 雨棚 / 栏杆 / 栅栏 / 长椅 / 汀步 / 阳台露台 / 灯笼尖顶的雪）、
   * 帽顶全是雪的几种盒顶（烟囱帽 / 窗台 / 花箱 / 空调）、室外雪地（ground）。
   * 室内草地（spring）、玻璃顶、电线、秃枝、木头 / 铁件 / 陶管口不留印。
   */
  private stampPrint(p: Vector3, surface: Surface): void {
    const t = this.tags[surface.id] ?? '';
    const snowy = t === 'ground' || /(^|-)snow$/.test(t) || /^(chimney|sill|flowerbox|ac)$/.test(t);
    if (snowy) this.prints.stamp(p.x, p.y, p.z);
  }

  /**
   * 操控态的雪粉（2026-11-23 找回）：落地冲击 / 蹬离室外覆雪表面时在脚下震落一撮——主角枝、院心老海棠的覆雪枝、跨院电线、
   * 覆雪的栏杆 / 栅栏 / 长椅 / 屋顶雪（tag 以 snow 结尾）、室外雪地；室内草地 / 玻璃 / 秃枝 / 铁件不震。
   * 粒数和初速按冲击力度（impactSpeed / pushSpeed，厘米 / 秒）给：步态一跳 ≈ 50~85，飞行落定是 Flare 触地速度。
   */
  private puffAt(p: Vector3, n: Vector3, surface: Surface, kind: 'land' | 'push'): void {
    const t = this.tags[surface.id] ?? '';
    if (surface instanceof CurvePerch) {
      const tag = t === 'branch' || t === 'wire' || t.startsWith('tree:');
      if (!tag) return;
    } else if (!(t === 'ground' || /(^|-)snow$/.test(t))) return;
    const loco = this.ctrl.player.loco;
    const v = kind === 'land' ? loco.impactSpeed : loco.pushSpeed;
    // 蹬离永远有一撮（腿把它蹬下来）；落地按冲击力度，轻落（< 10）几乎不震
    const k = kind === 'push' ? 0.6 : Math.min(1, v / 110);
    if (kind === 'land' && v < 10) return;
    this.puffPos.copy(p).addScaledVector(n, -0.06);
    this.puff.burst(this.puffPos, Math.round(8 + 14 * k), 7 + 5 * k);
  }

  /**
   * 主角枝的栖面交互（Stage.perches.interact，操控态）：观鸟态的栖枝宿主（PerchHost）在切进漫游时被摘掉，落在主角枝上时枝成了死木头——
   * 这里按步态相位把同一套微交互接回来：落地 → setBird(x, true) 静态体重微沉 + 爪印压雪 setPress + 按冲击速度的冲量 impulse（横枝弹颤、
   * 右前景海棠果梗单摆跟着晃）；蓄力 crouch → 按蹲伏量预压 preload；蹬离 → 放开体重和预压、按蹬速给冲量。鸟根每帧按 lift 跟着枝的弯曲位移走。
   */
  private heroInteract(): StagePerchInteract {
    const b = () => this.tree.branches;
    const isHero = (s: Surface): boolean => this.tags[s.id] === 'branch';
    const press = (x: number): void => {
      this.heroPress[0].worldX = x + CROSS_ALONG;
      this.heroPress[1].worldX = x - CROSS_ALONG;
      b().setPress(this.heroPress);
    };
    return {
      land: (s, x, impact) => {
        if (!isHero(s)) return;
        b().setBird(x, true);
        press(x);
        if (impact > 0) b().impulse(Math.min(1.4, 0.5 + impact / 140));
      },
      leave: (s, x, pushSpeed) => {
        if (!isHero(s)) return;
        b().setBird(x, false);
        b().preload(0);
        if (pushSpeed > 0) b().impulse(Math.min(0.9, 0.2 + pushSpeed / 110));
      },
      crouch: (s, _x, k) => {
        if (isHero(s)) b().preload(0.05 * k);
      },
      lift: (s, _x) => (isHero(s) ? b().swayOffsetAtBird(this.heroSway).x : 0),
    };
  }

  /**
   * 活跃颤动枝（2026-11-23）：从仿真世界的悬臂弹簧里挑这一帧 |梢端位移| 最大的几根（两棵树各最多 6 根），写进各自材质的 uActiveLimbs 槽位——
   * 顶点着色器按 (枝号, 梢端位移) × aLimbS² 叠加竖直位移（树皮 / 雪帽 / 冬芽 / 红果 / 春树叶花同一套），CPU 不重建任何网格。
   * 落在细枝上的那根和它带动的一圈子枝都会进前 6（子枝按母枝在焊口处的位移刚性跟）。
   */
  private updateActiveLimbs(): void {
    const crab = this.activeCrab;
    const spring = this.activeSpring;
    crab.length = 0;
    spring.length = 0;
    for (const p of this.stage.world.dynamicSurfaces) {
      if (!p.cantilever) continue;
      const off = p.ownOffset;
      if (off === 0) continue;
      const c = this.crabLimbOf.get(p);
      const list = c !== undefined ? crab : spring;
      const limb = c !== undefined ? c : this.springLimbOf.get(p);
      if (limb === undefined) continue;
      // 按 |位移| 从大到小插进前 6
      let at = 0;
      while (at < list.length && Math.abs(list[at].offset) >= Math.abs(off)) at++;
      if (at >= 6) continue;
      list.splice(at, 0, { limb, offset: off });
      if (list.length > 6) list.pop();
    }
    this.tree.branches.setActiveLimbs(crab);
    this.tree.springBranches.setActiveLimbs(spring);
  }

  /** 操控开着没有（漫游态）。 */
  get playing(): boolean {
    return this.ctrl.player.enabled;
  }

  start(view = 'threequarter'): void {
    // 两个图层的程序都先编译链接好（第一帧开操控 / 收光圈不再卡在同步编译上）
    this.camera.layers.enable(LAYER_FG);
    this.camera.layers.enable(LAYER_BG);
    this.setView(view);
    this.renderer.compile(this.scene, this.camera);
    // ?play=1：直接是清晰漫游态（不过渡）
    if (this.play) this.enterRoam(true);
    this.renderer.setAnimationLoop(this.tick);
  }

  /** 预设名，或自定义机位 `名字@px;py;pz@tx;ty;tz[@fov]`（坐标用分号隔开：tools/shoot.mjs 按逗号切视角）。 */
  setView(name: string): void {
    const at = name.indexOf('@');
    const key = at < 0 ? name : name.slice(0, at);
    const parts = at < 0 ? [] : name.slice(at + 1).split('@');
    const parse = (s: string | undefined): V3 | null => {
      if (!s) return null;
      const n = s.split(';').map(Number);
      return n.length === 3 && n.every(Number.isFinite) ? (n as V3) : null;
    };
    const cp = parse(parts[0]);
    const ct = parse(parts[1]);
    const v: ViewPreset = cp && ct ? { pos: cp, target: ct, fov: Number(parts[2]) || undefined } : (VIEWS[key] ?? VIEWS.threequarter);
    this.view = key;
    this.macroView = v.macro === true;
    if (v.fov && this.camera.fov !== v.fov) {
      this.camera.fov = v.fov;
      this.camera.updateProjectionMatrix();
    }
    this.controls.target.set(v.target[0], v.target[1], v.target[2]);
    this.camera.position.set(v.pos[0], v.pos[1], v.pos[2]);
    this.controls.update();
    // 记进相机控制器的 orbit 管线（下一帧 beforePlayer 先放回这个机位再处理鼠标），跟随点下一帧直接跳到鸟身上
    this.ctrl.cam.saveOrbit();
    this.ctrl.cam.resetFollow();
    // 预设机位是硬切：散焦度也直接到位（观鸟微距 = 滑块的值，展示机位 = 清晰）
    this.setBokeh(this.bokehGoal(), 0);
    this.updateViewLabel();
  }

  /** 外部可控飞行的小鸟直接驱动气流（传 null 交还给演示）。 */
  setBirdWake(pos: V3 | null, vel: V3 = [0, 0, 0], wingPhase = 0, wingOpen = 1): void {
    if (!pos) {
      this.external = false;
      return;
    }
    this.external = true;
    this.airflow.setBirdWake({ x: pos[0], y: pos[1], z: pos[2] }, { x: vel[0], y: vel[1], z: vel[2] }, wingPhase, wingOpen);
    this.marker.position.set(pos[0], pos[1], pos[2]);
    this.marker.visible = false;
  }

  setTour(on: boolean): void {
    this.tour = on;
    if (!on && !this.external) this.airflow.setBirdAbsent();
    this.refreshHud();
  }

  setMouseSweep(on: boolean): void {
    this.mouseSweep = on;
    this.refreshHud();
  }

  // ---------------------------------------------------------------------------------------------
  // 观鸟 ↔ 漫游：一镜到底
  // ---------------------------------------------------------------------------------------------

  /** 散焦度的目标：漫游态 / 展示机位 = 0（清晰），观鸟微距 = 面板滑块的值。 */
  private bokehGoal(): number {
    return this.mode === 'roam' || !this.macroView ? 0 : this.bokehAmount;
  }

  /** 把散焦度在 dur 秒内缓到目标（dur = 0 直接到位）。 */
  private setBokeh(to: number, dur: number): void {
    this.bokehFrom = this.bokehMix;
    this.bokehTo = to;
    this.bokehT = dur > 0 ? 0 : 1;
    this.bokehDur = dur;
    if (dur <= 0) this.bokehMix = to;
  }

  private updateBokeh(dt: number): void {
    if (this.bokehT >= 1) return;
    this.bokehT = Math.min(1, this.bokehT + dt / this.bokehDur);
    const k = this.bokehT * this.bokehT * (3 - 2 * this.bokehT);
    this.bokehMix = this.bokehFrom + (this.bokehTo - this.bokehFrom) * k;
  }

  /**
   * 「展翅漫游小院 ➔」：不刷新页面——鸟留在栖枝上、保持横站朝向，操控从这儿接着来；镜头的视角方位先对准现在观鸟机位的方位
   * （追尾机位是从观鸟机位往后退到追尾距离，不是绕 150° 甩到鸟背后），同一段时间里散焦度 1 → 0，小院由虚变清。
   * instant（?play=1）：不过渡，直接是漫游态。
   */
  enterRoam(instant = false): void {
    if (this.mode === 'roam') return;
    this.mode = 'roam';
    this.fly = null;
    this.motion.hop.auto = false;
    this.motion.hop.host = null;
    this.ctrl.setEnabled(true);
    // setEnabled 的枝轴吸附会把鸟拧成顺着枝站：按观鸟态的朝向重新摆正（两脚沿枝左右分开、趾包着枝）
    this.ctrl.player.perchFacing(Math.sin(this.perch.heading), Math.cos(this.perch.heading));
    const g = this.bird.group.position;
    this.ctrl.cam.viewYaw = Math.atan2(this.camera.position.x - g.x, this.camera.position.z - g.z);
    this.ctrl.setViewMode('chase');
    this.ctrl.cam.reblend(instant ? 0.001 : TRANSITION);
    if (instant) this.ctrl.cam.snapView();
    this.applyControlsLimits(true);
    this.setBokeh(this.bokehGoal(), instant ? 0 : TRANSITION);
    // 配乐换到小院那首：3 s 交叉淡化（比 0.6 s 的镜头过渡长，音乐不抢戏；?play=1 直接起这首）
    this.music.play('yard', instant ? 1.5 : 3);
    this.refreshUiMode();
  }

  /**
   * 「← 返回观鸟」：关操控、退 Pointer Lock，鸟回栖枝横站、栖枝宿主重新接管微生命；相机 dur 秒推回 threequarter 微距，散焦度 0 → 1。
   */
  enterBirdwatch(): void {
    if (this.mode === 'watch') return;
    this.mode = 'watch';
    if (document.pointerLockElement) document.exitPointerLock();
    this.ctrl.setAuto(false);
    this.ctrl.setEnabled(false);
    this.motion.hop.reset();
    this.motion.hop.host = this.perch;
    this.motion.hop.auto = true;
    this.motion.gazeMode = 'auto';
    this.tree.branches.preload(0);
    this.perch.bindFeet(0, 0);
    this.macroView = true;
    this.view = 'threequarter';
    this.startFly(VIEWS.threequarter, TRANSITION);
    this.setBokeh(this.bokehGoal(), TRANSITION);
    this.music.play('watch');
    this.refreshUiMode();
  }

  /**
   * 漫游态里按 R：回到院心栖枝（舞台的回栖点：主角枝 x = 0），保持漫游态——步态 / 脚 / 躯干归零、自由巡飞关掉、
   * 镜头跟随点直接跳到鸟身上并过渡回追尾视角（不一帧硬切，也不从院子另一头飘回来）。
   */
  resetToPerch(): void {
    if (this.mode !== 'roam') {
      this.enterBirdwatch();
      return;
    }
    this.ctrl.setAuto(false);
    this.ctrl.player.reset();
    // 回枝后还是观鸟态的横站朝向（reset 的枝轴吸附会让鸟顺着枝站）
    this.ctrl.player.perchFacing(Math.sin(this.perch.heading), Math.cos(this.perch.heading));
    this.ctrl.setViewMode('chase');
    this.ctrl.cam.resetFollow();
    this.ctrl.cam.reblend();
    this.tree.branches.preload(0);
    this.refreshHud();
  }

  /** 兼容旧名字（流程脚本）：漫游态里回栖枝重置；观鸟态里没意义。 */
  returnToPerch(): void {
    this.resetToPerch();
  }

  /** 相机从现在的机位（上一帧渲染出去的位姿）推回预设机位：位置 / 靶心 / 视场一起缓动，中途 OrbitControls 不收输入。 */
  private startFly(to: ViewPreset, dur: number): void {
    // 把阻尼里残留的转角一次用掉，不然推回的路上镜头会被残余的拖拽带偏
    this.controls.enableDamping = false;
    this.controls.update();
    this.controls.enabled = false;
    this.fly = {
      t: 0,
      dur,
      fromPos: this.camera.position.clone(),
      fromTarget: this.controls.target.clone(),
      fromFov: this.camera.fov,
      toPos: new Vector3(to.pos[0], to.pos[1], to.pos[2]),
      toTarget: new Vector3(to.target[0], to.target[1], to.target[2]),
      toFov: to.fov ?? FOV_NEAR,
    };
  }

  /** 推回的一步；返回 true = 还在推（这一帧视场角归它管）。 */
  private updateFly(dt: number): boolean {
    const f = this.fly;
    if (!f) return false;
    f.t = Math.min(1, f.t + dt / f.dur);
    const k = f.t * f.t * (3 - 2 * f.t);
    this.camera.position.lerpVectors(f.fromPos, f.toPos, k);
    this.controls.target.lerpVectors(f.fromTarget, f.toTarget, k);
    const fov = f.fromFov + (f.toFov - f.fromFov) * k;
    if (Math.abs(this.camera.fov - fov) > 1e-3) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    this.controls.update();
    this.ctrl.cam.saveOrbit();
    if (f.t >= 1) {
      this.fly = null;
      this.applyControlsLimits(false);
      this.controls.enableDamping = true;
      this.controls.enabled = true;
      this.controls.update();
      this.ctrl.cam.saveOrbit();
      this.ctrl.cam.resetFollow();
    }
    return true;
  }

  /** 轨道的距离 / 俯仰范围：观鸟态和观鸟入口一样（3.5~90 cm、不能钻到枝底），漫游态放开（自由巡飞的环绕距离可以到 150）。 */
  private applyControlsLimits(roam: boolean): void {
    this.controls.minDistance = DIST_MIN;
    this.controls.maxDistance = roam ? 7000 : DIST_MAX;
    this.controls.minPolarAngle = roam ? 0.04 : 0.55;
    this.controls.maxPolarAngle = roam ? 1.78 : 2.3;
  }

  /** 两态的界面：观鸟 = 右侧面板 + 底部主按钮；漫游 = 面板滑出、HUD / 操作提示淡入、右上角出现返回按钮。 */
  private refreshUiMode(): void {
    document.body.classList.toggle('is-roam', this.mode === 'roam');
    this.refreshHud();
  }

  private refreshHud(): void {
    if (!this.hud) return;
    const el = this.hud.querySelector('.garden-hud__flow') as HTMLElement;
    if (el) el.textContent = `气流演示：巡游 ${this.tour ? '开' : '关'}（F）· 鼠标划过 ${this.mouseSweep ? '开' : '关'}（M）${this.external ? '· 小鸟驱动' : ''}`;
  }

  /** HUD 的视角行：漫游态跟着三档视角走（V 切换），观鸟态写预设机位名。 */
  private updateViewLabel(): void {
    if (!this.viewEl) return;
    const text = this.mode === 'roam' ? `视角：${VIEW_TEXT[this.ctrl.viewMode] ?? this.ctrl.viewMode}（V 切换）` : `视角：${WATCH_LABELS[WATCH_NAMES.indexOf(this.view)] ?? this.view}`;
    if (this.viewEl.textContent !== text) this.viewEl.textContent = text;
  }

  private resize(root: HTMLElement): void {
    const w = root.clientWidth;
    const h = root.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.bokeh.setSize(this.renderer.domElement.width, this.renderer.domElement.height);
  }

  /** 巡游：闭环路线上等速飞，扑翼相位按飞行速度推进。 */
  private updateTour(dt: number): void {
    const L = this.tourCurve.getLength();
    const speed = 420;
    this.tourT = (this.tourT + (dt * speed) / L) % 1;
    const p = this.tourCurve.getPointAt(this.tourT);
    const tan = this.tourCurve.getTangentAt(this.tourT);
    this.wingPhase = (this.wingPhase + dt * 2.4) % 1;
    this.airflow.setBirdWake({ x: p.x, y: p.y, z: p.z }, { x: tan.x * speed, y: tan.y * speed, z: tan.z * speed }, this.wingPhase);
    this.marker.position.copy(p);
    this.marker.lookAt(p.clone().add(tan));
    this.marker.visible = true;
  }

  /** 鼠标划过：射线打到雪地 / 草坪，小鸟贴着地面 35 cm 掠过去，速度 = 鼠标的地面速度。 */
  private updateMouse(dt: number): void {
    if (!this.mouseSweep || this.elapsed - this.mouseAt > 1.6 || this.external) {
      this.mouseHas = false;
      return;
    }
    this.ray.setFromCamera(this.mouse, this.camera);
    const hits = this.ray.intersectObjects(this.sweepTargets, false);
    const hit = hits[0];
    if (!hit) {
      this.mouseHas = false;
      return;
    }
    const p = hit.point;
    // 在温室里就贴着春日地形，否则贴着雪面
    const inConsv = p.x > CONSV.x0 && p.x < CONSV.x1 && p.z > CONSV.z0 && p.z < CONSV.z1;
    const y = (inConsv ? springHeight(p.x, p.z) : p.y) + 35;
    this.mousePos.set(p.x, y, p.z);
    if (!this.mouseHas) {
      this.mousePrev.copy(this.mousePos);
      this.mouseHas = true;
    }
    const vx = (this.mousePos.x - this.mousePrev.x) / Math.max(dt, 1e-3);
    const vy = (this.mousePos.y - this.mousePrev.y) / Math.max(dt, 1e-3);
    const vz = (this.mousePos.z - this.mousePrev.z) / Math.max(dt, 1e-3);
    const sp = Math.hypot(vx, vy, vz);
    this.wingPhase = (this.wingPhase + dt * (0.6 + Math.min(sp, 900) * 0.004)) % 1;
    this.airflow.setBirdWake({ x: this.mousePos.x, y: this.mousePos.y, z: this.mousePos.z }, { x: vx, y: vy, z: vz }, this.wingPhase);
    this.mousePrev.copy(this.mousePos);
    this.marker.position.copy(this.mousePos);
    if (sp > 20) this.marker.lookAt(this.mousePos.clone().add(new Vector3(vx, vy, vz)));
    this.marker.visible = false;
  }

  /** 微生命动作：算出这一帧的 Pose 并应用到鸟身上（总开关关闭时不应用）。操控开着时准星偏着、头先朝准星看。 */
  private updateMotion(dt: number): void {
    const m = this.motion;
    // 头颈姿态相对躯干定义，注视目标按躯干当前朝向反算（扭身时头才不会盯着错的方向）
    this.bird.bodyWorldQuaternion(this.birdQuat);
    this.birdInvQuat.copy(this.birdQuat).invert();
    this.bird.headWorldPosition(this.headWorld);
    let gaze: Vector3 | null = null;
    if (this.ctrl.player.enabled) gaze = this.ctrl.gazeTarget(this.headWorld, this.gazePoint);
    else if (m.gazeMode === 'pointer' && this.pointerInside) {
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
    if (this.ctrl.player.enabled) return;
    // 观鸟态：鸟根跟着枝条的余震 / 蹦跳层走（动作系统关掉时也要跟，不然枝条弹颤时鸟会悬空 / 陷进枝里）
    if (m.enabled) this.perch.applyHop();
    else this.perch.placeRoot(this.perch.birdX, this.perch.heading, 0);
  }

  /** 观鸟态的竖直视场角随相机距离放宽（近景不变、远景装得下整棵树 / 整座院子），按时间平滑；轨道目标不在鸟身上（展示机位）时不碰预设的视场角。 */
  private updateFov(dt: number): void {
    if (this.mode !== 'watch' || this.controls.target.distanceTo(this.bird.group.position) > 30) return;
    const d = this.controls.getDistance();
    const goal = FOV_NEAR + (FOV_FAR - FOV_NEAR) * Math.min(Math.max((d - 40) / 660, 0), 1);
    const k = dt > 0 ? 1 - Math.exp(-dt / 0.12) : 1;
    this.camera.fov += (goal - this.camera.fov) * k;
    this.camera.updateProjectionMatrix();
  }

  /**
   * 阴影相机跟鸟：相机离鸟 1.5 m 内只罩鸟周围 ±150 cm（4096 贴图 → 0.07 cm/px，鸟自己的影子和观鸟入口一样清楚），
   * 拉远到 8 m 外扩到整座院子（对准点也靠回院子中心）；法线偏置跟着贴图比例缩（整院尺度的 2.2 cm 会把 4 cm 的鸟的影子整个推没）。
   * 对准点在光源视图里吸附到纹素格点：不然纹素跟着鸟平滑移动，影子边缘会一直闪。
   */
  private updateShadow(): void {
    const d = this.camera.position.distanceTo(this.bird.group.position);
    const k = Math.min(Math.max((d - SHADOW_NEAR) / 650, 0), 1);
    const extent = SHADOW_NEAR + (SHADOW_FAR - SHADOW_NEAR) * k;
    const sun = this.lighting.sun;
    const cam = sun.shadow.camera;
    if (Math.abs(cam.right - extent) > 0.5) {
      cam.left = -extent;
      cam.right = extent;
      cam.top = extent;
      cam.bottom = -extent;
      cam.updateProjectionMatrix();
    }
    sun.shadow.normalBias = 0.03 + (2.2 - 0.03) * k;
    sun.shadow.bias = -0.00002 + (-0.0006 + 0.00002) * k;
    const t = this.shadowTarget.copy(this.bird.group.position);
    t.y += 2.5;
    t.lerp(YARD_CENTER, k);
    // 光源视图的 x / y 轴（three 的阴影相机 lookAt 目标、up = +Y）：x = up × 光源方向，y = 光源方向 × x
    const dir = this.lighting.uniforms.uSunDir.value;
    this.shadowX.set(0, 1, 0).cross(dir).normalize();
    this.shadowY.crossVectors(dir, this.shadowX);
    const texel = (2 * extent) / sun.shadow.mapSize.x;
    const sx = t.dot(this.shadowX);
    const sy = t.dot(this.shadowY);
    t.addScaledVector(this.shadowX, Math.round(sx / texel) * texel - sx).addScaledVector(this.shadowY, Math.round(sy / texel) * texel - sy);
    sun.target.position.copy(t);
    this.lighting.setSun(this.lighting.azimuth, this.lighting.elevation);
  }

  private readonly tick = (now: number): void => {
    const dt = this.last ? Math.min((now - this.last) / 1000, 0.1) : 0.016;
    this.last = now;
    this.elapsed += dt;
    // 相机第一步：orbit 管线先处理鼠标 / 阻尼（操控开着时再跟到鸟背后）
    this.ctrl.beforePlayer(dt);
    this.snowfall.update(this.elapsed);
    this.puff.update(this.elapsed);
    this.prints.update(dt);
    // 弹性世界推进（2026-11-23 修"弹簧时间静止"Bug）：电线 / 老海棠细枝 / 春树花枝的振子每帧推进一步，再按当前位移改画面
    // （跨院电线 + 拉杆的动态管子顶点、两棵树活跃枝的 uActiveLimbs 槽位）。放在步态 / 飞行之前：鸟根和画面读的是同一帧的位移
    this.stage.world.advance(dt);
    this.wires.update();
    // 树枝先弯，鸟根再跟着枝走（applyHop 在 updateMotion 里）
    this.tree.branches.update(dt);
    this.bird.update(dt);
    const g = this.bird.group.position;
    this.updateMotion(dt);
    // 漫游态：镜头方向 → 步态 / 飞行 → 相机第二步（追尾 / 过肩 / 第一人称机位 + 准星）+ 气流尾迹；
    // 观鸟态：回观鸟的相机推回（推完视场角才按距离放宽）
    const playing = this.ctrl.player.enabled;
    if (playing) this.ctrl.update(dt, this.basePose);
    else if (!this.updateFly(dt)) this.updateFov(dt);
    // 步态 / 飞行可能刚激发 / 压弯了一根枝：按最新位移挑活跃枝写进槽位（这一帧就画出来）
    this.updateActiveLimbs();
    this.updateViewLabel();
    this.greenhouse.glass.uniforms.uTime.value = this.elapsed;
    this.grass.uniforms.uTime.value = this.elapsed;
    // 枯草给真实的小鸟让位（12 cm 内压弯压矮）
    this.grass.setBirdPos(g.x, g.y, g.z);
    this.lawn.uniforms.uTime.value = this.elapsed;
    this.foliage.uniforms.uTime.value = this.elapsed;
    this.airflow.uniforms.uTime.value = this.elapsed;
    if (!this.external) {
      const mouseFresh = this.mouseSweep && this.elapsed - this.mouseAt <= 1.6;
      // 观鸟态的小鸟只在抖翅 / 蹦跳腾空时扰动气流（站着不动不吹气柱）
      const idleWake = !playing && (this.motion.pose.wing.right.open > 0.04 || this.motion.hop.rootLift > 0);
      if (idleWake) {
        this.wingPhase = (this.wingPhase + dt * 2.4) % 1;
        const p = this.bird.group.position;
        const w = this.wakeScratch;
        w.x = p.x;
        w.y = p.y + 2.5;
        w.z = p.z;
        this.airflow.setBirdWake(w, { x: 0, y: 0, z: 0 }, this.wingPhase);
      } else if (mouseFresh) this.updateMouse(dt);
      else if (this.tour) this.updateTour(dt);
      else {
        this.airflow.setBirdAbsent();
        this.marker.visible = false;
      }
    }
    this.airflow.update(dt);
    this.updateShadow();
    // 绒毛壳层数按相机距离 / 像素密度自动缩放（微距满配）
    this.bird.updateFurLod(this.camera, this.renderer.domElement.height, dt);
    // 散焦度过渡 → 散景两趟（或清晰态单趟）渲染；绘制统计两趟累加
    this.updateBokeh(dt);
    this.renderer.info.reset();
    this.bokeh.render(this.scene, this.camera, this.bokehMix);
    this.fpsCount++;
    this.fpsWindow += dt;
    if (this.fpsWindow >= 0.5) {
      const fps = this.fpsCount / this.fpsWindow;
      const info = this.renderer.info;
      const texts = [
        `${fps.toFixed(0)} fps · ${(1000 / fps).toFixed(1)} ms`,
        `${info.render.calls} 次 / ${info.render.triangles.toLocaleString('en-US')} 三角形`,
        `${info.programs?.length ?? 0} 个着色器程序 · 绒毛 ${this.bird.fur.shellCount} 层`,
        playing ? this.ctrl.player.statusText() : this.mode === 'watch' ? `观鸟 · 散景 ${(this.bokehMix * 100).toFixed(0)}%` : '',
      ];
      this.hudStatEls.forEach((el, i) => (el.textContent = texts[i] ?? ''));
      this.panelStats.forEach((s, i) => s.set(texts[i] ?? ''));
      this.fpsWindow = 0;
      this.fpsCount = 0;
    }
  };

  /** 左上角 HUD（漫游态显示）+ 底部操作提示条。 */
  private buildHud(root: HTMLElement): HTMLElement {
    const hud = document.createElement('div');
    hud.className = 'garden-hud';
    hud.innerHTML = `
<div class="garden-hud__title">雪精灵的冬日庭院 · 春日植物园</div>
<div class="garden-hud__sub">三层小洋房 · 玻璃阳光花房 · 大植物园温室 · 积雪枯草地\n点击画面锁定鼠标 360° 视角（Esc 退出）· 滚轮调追尾远近 · D 碰撞叠加</div>
<div class="garden-hud__view"></div>
<div class="garden-hud__flow"></div>
<div class="garden-hud__stats"></div>`;
    const stats = hud.querySelector('.garden-hud__stats') as HTMLElement;
    for (let i = 0; i < 4; i++) {
      const el = document.createElement('div');
      stats.appendChild(el);
      this.hudStatEls.push(el);
    }
    this.viewEl = hud.querySelector('.garden-hud__view') as HTMLElement;
    root.appendChild(hud);
    const help = document.createElement('div');
    help.className = 'garden-help';
    help.textContent = HELP_TEXT;
    root.appendChild(help);
    this.refreshHud();
    return hud;
  }

  /** 底部正中的主按钮「展翅漫游小院 ➔」和右上角的「← 返回观鸟」。 */
  private buildButtons(root: HTMLElement): void {
    const cta = document.createElement('button');
    cta.type = 'button';
    cta.className = 'garden-cta';
    cta.title = '一镜到底：收小光圈对焦整座小院，镜头接到追尾视角，WASD 蹦跳、空格起飞';
    cta.innerHTML = '展翅漫游小院<span class="garden-cta__arrow" aria-hidden="true">➔</span>';
    cta.addEventListener('click', () => this.enterRoam());
    root.appendChild(cta);
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'garden-back';
    back.title = '回到微距观鸟：鸟回栖枝、镜头推回、背景重新虚化';
    back.innerHTML = '<span class="garden-back__arrow" aria-hidden="true">←</span> 返回观鸟';
    back.addEventListener('click', () => this.enterBirdwatch());
    root.appendChild(back);
    this.refreshUiMode();
  }

  /** 右侧观鸟面板（和观鸟入口 core/App.ts 同一套控件）+ 背景虚化度。 */
  private buildPanel(): void {
    const p = this.panel!;
    const fur = this.bird.furUniforms;
    const deg = (v: number): string => `${v.toFixed(0)}°`;

    p.header('北长尾山雀', '冬日小院 · 观鸟');
    // 主入口（和画面底部正中那个同一件事）：一镜到底进漫游
    const cta = p.button(p.el, '展翅漫游小院 ➔', () => this.enterRoam(), '一镜到底：收小光圈对焦整座小院，镜头接到追尾视角');
    cta.className = 'btn btn--cta';

    const st = p.section('状态');
    for (const label of ['帧率', '绘制', '着色器', '操控']) this.panelStats.push(p.stat(st, label));

    const vw = p.section('视角');
    p.segmented(vw, WATCH_LABELS, 0, (i) => this.setView(WATCH_NAMES[i]));
    p.segmented(
      vw,
      YARD_VIEWS.map(([label]) => label),
      -1,
      (i) => this.setView(YARD_VIEWS[i]?.[1] ?? 'overview'),
    );

    const fl = p.section('绒毛');
    p.slider(fl, '壳层数', 4, 96, 1, this.bird.fur.shellCount, (v) => this.bird.fur.setShellCount(v), (v) => v.toFixed(0));
    // 自动 LOD 开着时壳层数滑块只记着手动值（关掉自动 LOD 才生效）
    p.toggle(fl, '壳层自动 LOD', this.bird.furLod.enabled, (on) => {
      this.bird.furLod.enabled = on;
      if (on) this.bird.furLod.reset();
      else this.bird.setFurShells(this.bird.fur.shellCount);
    });
    p.slider(fl, '毛长', 0.05, 0.5, 0.005, FUR_DEFAULTS.furLen, (v) => (fur.uFurLen.value = v), (v) => `${v.toFixed(3)}`);
    p.slider(fl, '蓬松度', 0, 1, 0.01, FUR_DEFAULTS.fluff, (v) => (fur.uFluff.value = v));
    p.slider(fl, '毛簇尺度', 1.5, 20, 0.1, FUR_DEFAULTS.tuftScale, (v) => (fur.uTuftScale.value = v));
    p.slider(fl, '顺流拉伸', 0, 0.9, 0.01, FUR_DEFAULTS.stretch, (v) => (fur.uStretch.value = v));
    p.slider(fl, '密度', 0.4, 1.6, 0.01, FUR_DEFAULTS.density, (v) => (fur.uDensity.value = v));
    p.slider(fl, '成簇', 0, 2, 0.01, FUR_DEFAULTS.clump, (v) => (fur.uClump.value = v));
    p.slider(fl, '羽片起伏', 0.5, 6, 0.1, FUR_DEFAULTS.scallop, (v) => (fur.uScallop.value = v));

    const hd = p.section('头部');
    const pose = { yaw: 0, pitch: 0, roll: 0 };
    const apply = (): void => {
      const r = Math.PI / 180;
      this.bird.setHeadPose(pose.yaw * r, pose.pitch * r, pose.roll * r);
    };
    p.slider(hd, '左右转', -55, 55, 1, 0, (v) => ((pose.yaw = v), apply()), deg);
    p.slider(hd, '抬头低头', -45, 45, 1, 0, (v) => ((pose.pitch = v), apply()), deg);
    p.slider(hd, '歪头', -90, 90, 1, 0, (v) => ((pose.roll = v), apply()), deg);

    const pct = (v: number): string => `${v.toFixed(0)}%`;

    const ml = p.section('微生命');
    p.toggle(ml, '动作系统', this.motion.enabled, (on) => {
      this.motion.enabled = on;
      this.motion.hop.auto = on;
      if (!on) this.bird.applyPose(restPose());
    });
    p.slider(ml, '活跃度', 0, 100, 1, Math.round(this.motion.activity * 100), (v) => (this.motion.activity = v / 100), pct);
    p.segmented(ml, ['随机注视', '跟随鼠标'], 0, (i) => (this.motion.gazeMode = i === 0 ? 'auto' : 'pointer'));
    // 手动触发单个动作，方便逐个验收
    const cues = document.createElement('div');
    cues.className = 'seg';
    const cueList: [string, MotionCue][] = [
      ['歪头', 'tilt'],
      ['眨眼', 'blink'],
      ['瞬膜', 'nict'],
      ['甩尾', 'tailFlick'],
      ['弹翅', 'wingFlick'],
      ['展翅扑翼', 'spread'],
      ['侧跳', 'hop'],
      ['转身跳', 'turnHop'],
    ];
    for (const [label, kind] of cueList) p.button(cues, label, () => this.motion.cue(kind));
    ml.appendChild(cues);

    // 眨眼、瞬膜、张嘴、甩尾、弹翅：手动摆姿态检查结构（动作系统开着时会被它每帧覆盖）
    const mo = p.section('动作测试');
    const blink: BlinkPose = {};
    const applyBlink = (): void => this.bird.setBlink(blink);
    p.slider(mo, '眨眼', 0, 100, 1, 0, (v) => ((blink.lidClose = v / 100), applyBlink()), pct);
    p.slider(mo, '眯眼', 0, 100, 1, 0, (v) => ((blink.squint = v / 100), applyBlink()), pct);
    p.slider(mo, '瞬膜', 0, 100, 1, 0, (v) => ((blink.nictClose = v / 100), applyBlink()), pct);
    p.slider(mo, '张嘴', 0, 40, 1, 0, (v) => this.bird.setJawOpen((v * Math.PI) / 180), deg);
    const tail: TailPose = {};
    const applyTail = (): void => this.bird.setTailPose(tail);
    p.slider(mo, '尾上翘', -40, 70, 1, 0, (v) => ((tail.pitch = (v * Math.PI) / 180), applyTail()), deg);
    p.slider(mo, '尾左右甩', -80, 80, 1, 0, (v) => ((tail.yaw = (v * Math.PI) / 180), applyTail()), deg);
    p.slider(mo, '尾扇开', 0, 100, 1, 0, (v) => ((tail.spread = (v / 100) * 0.6), applyTail()), pct);
    const wing: WingPose = {};
    const applyWing = (): void => this.bird.setWingPose('both', wing);
    p.slider(mo, '展翅度', 0, 100, 1, 0, (v) => ((wing.open = v / 100), applyWing()), pct);
    p.slider(mo, '扑翼角', -40, 80, 1, 0, (v) => ((wing.flap = (v * Math.PI) / 180), applyWing()), deg);
    p.slider(mo, '翅后扫', 0, 70, 1, 0, (v) => ((wing.sweep = (v * Math.PI) / 180), applyWing()), deg);

    const pt = p.section('部件');
    const parts: [BirdPart, string][] = [
      ['fur', '绒毛'],
      ['feathers', '翅尾正羽'],
      ['beak', '喙'],
      ['eyes', '眼'],
      ['legs', '腿脚'],
    ];
    for (const [key, label] of parts) {
      p.toggle(pt, label, true, (on) => this.bird.setPartVisible(key, on));
    }

    const li = p.section('光线');
    p.slider(
      li,
      '太阳方位',
      -180,
      180,
      1,
      this.lighting.azimuth,
      (v) => this.lighting.setSun(v, this.lighting.elevation),
      deg,
    );
    p.slider(
      li,
      '太阳高度',
      3,
      85,
      1,
      this.lighting.elevation,
      (v) => this.lighting.setSun(this.lighting.azimuth, v),
      deg,
    );
    p.slider(li, '曝光', 0.3, 2.5, 0.01, this.renderer.toneMappingExposure, (v) => {
      this.renderer.toneMappingExposure = v;
    });

    const sc = p.section('画面');
    // 背景虚化度：观鸟微距的散焦强度（小院展示机位和漫游态本来就是清晰的）
    p.slider(sc, '背景虚化度', 0, 100, 1, 100, (v) => {
      this.bokehAmount = v / 100;
      this.setBokeh(this.bokehGoal(), 0.15);
    }, pct);
    p.toggle(sc, '飘雪', true, (on) => (this.snowfall.mesh.visible = on));
    p.button(sc, '隐藏面板 (H)', () => (p.visible = false));

    // 背景音乐：观鸟 / 小院两首 lo-fi 姊妹曲，观鸟 ↔ 漫游切换时交叉淡化；第一次点击 / 按键才出声（浏览器不许自动播放）
    const so = p.section('声音');
    p.toggle(so, '背景音乐', !this.music.muted, (on) => this.music.setMuted(!on));
    p.slider(so, '音量', 0, 100, 1, Math.round(this.music.volume * 100), (v) => this.music.setVolume(v / 100), pct);
    const track = p.stat(so, '曲目');
    track.set(trackLabel(this.music.desired));
    this.music.onTrack = (n) => track.set(trackLabel(n));
  }
}
