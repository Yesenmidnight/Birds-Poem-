import {
  ACESFilmicToneMapping,
  PCFShadowMap,
  PerspectiveCamera,
  Plane,
  Quaternion,
  Raycaster,
  SRGBColorSpace,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Lighting } from './Lighting';
import { Panel } from '../ui/Panel';
import { Backdrop } from '../world/Backdrop';
import { Branches, type SnowPress } from '../world/Branch';
import { Sky } from '../world/Sky';
import { Snowfall } from '../world/Snowfall';
import { SnowPuff } from '../world/snowPuff';
import { Bird, type BirdPart, type BlinkPose, type TailPose, type WingPose } from '../bird/Bird';
import { FUR_DEFAULTS } from '../bird/fur';
import { MotionController, type MotionCue } from '../bird/motion/MotionController';
import type { HopHost } from '../bird/motion/hopLayer';
import { restPose } from '../bird/motion/Pose';
import type { Foot, ToeSurface } from '../bird/parts';
import type { FootState } from '../bird/legs';

const UP = new Vector3(0, 1, 0);
const clamp01 = (v: number): number => Math.min(Math.max(v, 0), 1);

export interface ViewPreset {
  /** 相机方位角：+Z 方向为 0，向 +X 为正。 */
  az: number;
  /** 相机仰角。 */
  el: number;
  dist: number;
  target: [number, number, number];
}

/** 鸟站在原点、面朝 -X、尾巴伸向 +X。 */
export const VIEWS: Record<string, ViewPreset> = {
  // 俯角收到 8°、靶心略降：右前景的海棠果枝离相机近（z 约 1 cm），俯角大了果簇会被透视推出下边
  threequarter: { az: -0.62, el: 0.14, dist: 12, target: [0.2, 2.0, -0.3] },
  side: { az: 0.0, el: 0.05, dist: 11.5, target: [0.6, 2.4, 0] },
  front: { az: -Math.PI / 2 + 0.18, el: 0.08, dist: 11.5, target: [-0.3, 2.1, 0] },
  back: { az: Math.PI / 2 - 0.2, el: 0.2, dist: 12, target: [0.5, 2.5, 0] },
  head: { az: -0.75, el: 0.1, dist: 4.6, target: [-0.6, 3.55, 0.05] },
  tail: { az: -0.35, el: 0.3, dist: 13, target: [3.5, 1.6, 0] },
  wide: { az: -0.5, el: 0.2, dist: 28, target: [2, 2, 0] },
  // 俯视自检：正上方偏后看，头在上、尾在下；斜前上方看翅与肩胸的衔接
  top: { az: Math.PI / 2 + 0.12, el: 1.18, dist: 10, target: [0.5, 2.4, 0] },
  topfront: { az: -Math.PI / 2 + 0.55, el: 0.8, dist: 10.5, target: [0.2, 2.5, 0] },
  // 正后方平视：对照真鸟正背面参考图看 T 字黑鞍和双翅 V 字抱拢
  rear: { az: Math.PI / 2 + 0.04, el: 0.08, dist: 10, target: [0.4, 2.5, 0] },
};
/** 竖直视场角：近景（≤ 40 cm）恒 28°，拉远到 90 cm（轨道最远）放宽到 44°，整根栖枝连前景果枝一镜装下。 */
const FOV_NEAR = 28;
const FOV_FAR = 44;
/** 轨道距离范围（厘米）：3.5 cm 贴到喙尖微距，90 cm 看整根主角枝；再远背景就空了。 */
const DIST_MIN = 3.5;
const DIST_MAX = 90;
const VIEW_NAMES = Object.keys(VIEWS);

/**
 * 横枝构图：主枝在枝条坐标系里沿 +X 生长，整组绕 Y 转这个角度后横穿画面（鸟面朝 -X 看过来，粗的那头在画面左后方、
 * 细梢伸向右前方），再斜 12° 让鸟是"斜横站"而不是正横站。鸟本身不转：面朝 -X，光位和所有视角都不变。
 */
const BRANCH_YAW = -Math.PI / 2 + 0.21;
/** 横站的两个落点：沿枝左右分开（厘米，枝条坐标系里主枝的 +X 方向）、都在枝顶；积雪在这里被踩出小凹。 */
const CROSS_ALONG = 0.34;

export interface AppOptions {
  ui: boolean;
  dprCap: number;
}

export class App implements HopHost {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly lighting: Lighting;
  readonly panel: Panel | null;
  readonly sky: Sky;
  readonly backdrop: Backdrop;
  readonly snowfall: Snowfall;
  /** 蹬枝 / 落地震落的雪粉 */
  readonly puff = new SnowPuff();
  readonly branches: Branches;
  readonly bird: Bird;
  readonly motion = new MotionController();

  // ---- HopHost：蹦跳层驱动的外部世界 ----
  /** 允许蹦跳的落点范围（枝条坐标 x）：再远就出了苔藓减薄的抓握区、往右会一头撞进前景的海棠果枝（枝根在 x ≈ 2.65） */
  readonly range: readonly [number, number] = [-3.0, 2.0];
  private perchX = 0;
  /** 正在抓枝的两只脚里 legs[0]（局部 +x 侧）落在枝条坐标的哪一侧（±1），由 standAcross 按朝向定。 */
  private footSign = 1;
  private facing = -Math.PI / 2;
  private readonly swayOff = new Vector2();
  private readonly rootPos = new Vector3();
  private readonly swayVec = new Vector3();
  private readonly ankleLift = new Vector3();
  private readonly puffPos = new Vector3();
  private readonly footState: FootState = { grip: 1, ankle: null };

  private elapsed = 0;
  private last = 0;
  private hazeGate = 1;
  private fpsWindow = 0;
  private fpsCount = 0;
  private stats: { set(text: string): void }[] = [];
  // 鼠标注视：指针 NDC → 过头部、正对相机的平面上的点；指针速度用来判断"快速划过"红果侧枝
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

  constructor(root: HTMLElement, opts: AppOptions) {
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

    this.camera = new PerspectiveCamera(28, root.clientWidth / root.clientHeight, 0.5, 4000);
    this.lighting = new Lighting(this.scene);

    this.sky = new Sky(this.lighting.uniforms.uSunDir.value);
    // 天空球放大到半径 1600：轨道最远 90 cm 时相机离原点不到 100 cm，稳稳在球里（BackSide 从外面看会被剔掉）；远裁面相应放到 4000
    this.sky.mesh.scale.setScalar(2.0);
    this.backdrop = new Backdrop();
    // 飘雪：雪箱 ±380 cm、从庭院雪地标高 y = −125 往上 650 cm，罩住整个取景范围；雪片大小按相机距离放大（uSizeK，近景 1）
    this.snowfall = new Snowfall(11, 6000, 380);
    // 纯粹的单枝微距展台：noTree = 不建左后方那棵 6 米的老海棠，画面里只有精雕的积雪主角横枝 + 前景海棠红果侧枝 + 苔藓地衣积雪细节，
    // 背景只剩天空留白和远景虚化色斑，四周不再有杂枝干扰观鸟构图
    this.branches = new Branches(this.lighting.uniforms, [], true, { noTree: true });
    // 大气透视：40 cm 以内完全不变（鸟和它脚下的栖枝），拉远后栖枝远端慢慢融进浅雾背景，画面越远越轻。雾混在光照之后的结果上，
    // 雾色直接取天空球地平线附近的显示色（略压暗一点）
    this.branches.haze.uHazeK.value.set(95, 40);
    this.branches.haze.uHazeMax.value = 0.4;
    this.branches.haze.uHazeCol.value.set('#a2aebd');
    // 鸟先按"顺枝站"的默认落点建好（腿架构造时按栖枝切线算沿枝偏移），再把整根主枝绕 Y 转成横穿画面、按新标架重绑两脚
    this.bird = new Bird(this.lighting.uniforms, this.branches.perchAt(0));
    // 绒毛壳层数自动 LOD：近景 25 cm 内满配（画面逐像素不变），中景 60 cm 降到 24 层，远景 16 层
    this.bird.furLod.nearDist = 25;
    this.bird.furLod.midDist = 60;
    this.branches.rotation.y = BRANCH_YAW;
    this.branches.updateMatrix();
    this.facing = this.bird.group.rotation.y;
    this.standAcross(0);
    this.branches.setPress(this.pressSpots(0));
    this.motion.hop.host = this;
    this.scene.add(this.sky.mesh, this.backdrop.mesh, this.snowfall.mesh, this.puff.mesh, this.branches, this.bird.group);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false;
    this.controls.minDistance = DIST_MIN;
    this.controls.maxDistance = DIST_MAX;
    this.controls.minPolarAngle = 0.55;
    this.controls.maxPolarAngle = 2.3;
    this.controls.rotateSpeed = 0.6;
    this.controls.zoomSpeed = 0.8;

    this.panel = opts.ui ? new Panel(root) : null;
    if (this.panel) this.buildPanel();

    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointermove', (e) => {
      const r = canvas.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * 2 - 1;
      const y = -((e.clientY - r.top) / r.height) * 2 + 1;
      const now = performance.now() / 1000;
      const dt = Math.max(now - this.pointerTime, 1e-3);
      // 鼠标快速划过红果侧枝（NDC 速度 > 1.8 / s）：拨动它轻晃，甩的方向跟着划过的方向
      const speed = Math.hypot(x - this.pointerPrev.x, y - this.pointerPrev.y) / dt;
      if (this.pointerInside && speed > 1.8 && now - this.lastKick > 0.15) {
        this.pointerRay.setFromCamera(this.pointerNdc.set(x, y), this.camera);
        if (this.branches.twigHit(this.pointerRay)) {
          this.branches.kickTwig(Math.min(speed * 0.35, 2.5), Math.sign(x - this.pointerPrev.x) || 1);
          this.lastKick = now;
        }
      }
      this.pointerPrev.set(x, y);
      this.pointerTime = now;
      this.pointerNdc.set(x, y);
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

  start(view = 'threequarter'): void {
    this.setView(view);
    // 预热：把场景里所有材质（包括暂时看不见的翼臂绒毛垫壳层）的着色器程序先编译链接好，第一次展翅不再卡在同步编译上
    this.renderer.compile(this.scene, this.camera);
    this.renderer.setAnimationLoop(this.tick);
  }

  setView(name: string): void {
    const v = VIEWS[name] ?? VIEWS.threequarter;
    this.controls.target.set(v.target[0], v.target[1], v.target[2]);
    const c = Math.cos(v.el);
    this.camera.position.set(
      v.target[0] + v.dist * c * Math.sin(v.az),
      v.target[1] + v.dist * Math.sin(v.el),
      v.target[2] + v.dist * c * Math.cos(v.az),
    );
    this.controls.update();
  }

  /**
   * 横站：两脚沿枝左右分开站在枝顶，脚掌朝前（Foot.heading），三根前趾包住枝的前侧、后趾扣住后侧——正面看两只小爪子
   * 左右分开稳稳抱住枝条。栖面按枝条当前的世界标架换到鸟的局部坐标，再交给腿架重绑（重算踝、跗跖长和包握的脚趾）。
   * x 是落点（枝条坐标）：默认 0，蹦跳落地后是新落点。
   */
  private standAcross(x: number): void {
    const g = this.bird.group;
    g.updateMatrix();
    const inv = g.matrix.clone().invert();
    const rot = new Quaternion();
    const scale = new Vector3();
    g.matrix.decompose(new Vector3(), rot, scale);
    const rotInv = rot.clone().invert();
    const perch = this.branches.perchAt(x);
    const surface: ToeSurface = {
      center: perch.center.clone().applyMatrix4(inv),
      tangent: perch.tangent.clone().applyQuaternion(rotInv),
      up: perch.up.clone().applyQuaternion(rotInv),
      side: perch.side.clone().applyQuaternion(rotInv),
      surfaceRadius: perch.surfaceRadius,
    };
    // 脚掌朝向 = 鸟的前方（局部 +Z，喙的方向）在栖枝切平面里相对 −切线 的角度
    const fwd = new Vector3(0, 0, 1).applyQuaternion(rot);
    const heading = Math.atan2(fwd.dot(perch.side), -fwd.dot(perch.tangent));
    // 左右落点按鸟的局部 +X 轴在栖枝切线上的投影定：正站时局部 +x 顺着切线，转身 180° 后逆着切线——
    // 写死 ±CROSS_ALONG 会让两条腿交叉去抓对面的落点（X 形）。legs[0] = 局部 +x 侧的髋，始终抓 +sgn 那一边
    const sgn = surface.tangent.x >= 0 ? 1 : -1;
    this.footSign = sgn;
    const feet: [Foot, Foot] = [
      { alpha: 0.03, along: sgn * CROSS_ALONG, side: 1, heading },
      { alpha: -0.02, along: -sgn * CROSS_ALONG, side: -1, heading },
    ];
    this.bird.legRig.bind(surface, feet);
  }

  /** 两只脚的踩雪印落点（枝条坐标 x），跟着 standAcross 定下的左右走。 */
  private pressSpots(x: number): SnowPress[] {
    const s = this.footSign;
    return [
      { worldX: x + s * CROSS_ALONG, alpha: 0.03 },
      { worldX: x - s * CROSS_ALONG, alpha: -0.02 },
    ];
  }

  // ---------------------------------------------------------------------------------------------
  // HopHost：枝头蹦跳层驱动的世界（鸟根 / 腿架重绑 / 树枝冲击 / 雪粉 / 踩雪印）
  // ---------------------------------------------------------------------------------------------
  get birdX(): number {
    return this.perchX;
  }
  get heading(): number {
    return this.facing;
  }

  placeRoot(x: number, heading: number, lift: number): void {
    this.perchX = x;
    this.facing = heading;
    const g = this.bird.group;
    g.rotation.y = heading;
    // 根的位置 = 枝上 x 处相对默认落点的位移（枝条本身有起伏）+ 枝条在脚处的弯曲位移（枝条坐标系的 y/z 换到世界）
    this.rootPos.copy(this.branches.perchAt(x).center).sub(this.branches.perchAt(0).center);
    const o = this.branches.swayOffsetAtBird(this.swayOff);
    this.rootPos.add(this.swayVec.set(0, o.x, o.y).applyAxisAngle(UP, this.branches.rotation.y));
    g.position.copy(this.rootPos);
    g.position.y += lift;
  }

  bindFeet(x: number, heading: number): void {
    this.branches.setBird(x, true);
    this.placeRoot(x, heading, 0);
    this.standAcross(x);
    this.branches.setPress(this.pressSpots(x));
  }

  takeOff(): void {
    this.branches.setBird(this.perchX, false);
    this.branches.preload(0);
  }

  impact(strength: number, puff: number): void {
    this.branches.impulse(strength);
    // 雪粉从两只脚之间、枝顶略偏下的位置震落（枝顶正中被肚子挡着）
    const perch = this.branches.perchAt(this.perchX);
    this.puffPos.copy(perch.center).addScaledVector(perch.up, perch.surfaceRadius(0, 0) - 0.08);
    this.puff.burst(this.puffPos, puff, 8 + 5 * strength);
  }

  preload(sag: number): void {
    this.branches.preload(sag);
  }

  /** 蹦跳层这一帧的输出：鸟根（含跟随枝条弯曲）、蹲伏 / 前俯、两只脚（抓握度 + 抬起量）。 */
  private applyHop(): void {
    const hop = this.motion.hop;
    this.placeRoot(hop.rootX, hop.rootHeading, hop.rootLift);
    this.bird.setHopPose(hop.crouch, hop.pitch, hop.roll);
    for (const i of [0, 1] as const) {
      const f = hop.feet[i];
      if (f.lift > 1e-4) {
        // 抬起的脚：踝相对静止位置微微上收、往前甩一点，脚趾半握成微弯钩
        this.bird.legRig.ankleRest(i, this.ankleLift);
        this.ankleLift.y += f.lift;
        this.ankleLift.z += f.lift * 1.4;
        this.footState.ankle = this.ankleLift;
      } else this.footState.ankle = null;
      this.footState.grip = f.grip;
      this.bird.setFootPose(i === 0 ? 'right' : 'left', this.footState);
    }
  }

  private resize(root: HTMLElement): void {
    const w = root.clientWidth;
    const h = root.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  /** 微生命动作：算出这一帧的 Pose 并应用到鸟身上（总开关关闭时不应用）。 */
  private updateMotion(dt: number): void {
    const m = this.motion;
    // 头颈姿态相对躯干定义，注视目标按躯干当前朝向反算（扭身时头才不会盯着错的方向）
    this.bird.bodyWorldQuaternion(this.birdQuat);
    this.birdInvQuat.copy(this.birdQuat).invert();
    this.bird.headWorldPosition(this.headWorld);
    let gaze: Vector3 | null = null;
    if (m.gazeMode === 'pointer' && this.pointerInside) {
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
    if (m.enabled) {
      this.bird.applyPose(pose);
      this.applyHop();
    } else {
      // 动作系统关掉（静止姿态）时鸟根仍跟着枝条的余震走，不然枝条弹颤时鸟会悬空 / 陷进枝里
      this.placeRoot(this.perchX, this.facing, 0);
    }
  }

  /** 竖直视场角随相机距离放宽（近景不变、拉远看全枝），按时间平滑，切预设视角时不猛地一跳。 */
  private updateFov(dt: number): void {
    const d = this.controls.getDistance();
    const goal = FOV_NEAR + (FOV_FAR - FOV_NEAR) * clamp01((d - 40) / (DIST_MAX - 40));
    const k = dt > 0 ? 1 - Math.exp(-dt / 0.12) : 1;
    this.camera.fov += (goal - this.camera.fov) * k;
    this.camera.updateProjectionMatrix();
    // 大气透视的远景门：微距机位（≤ 40 cm）时栖枝远端化成虚影，拉远到 150 cm 外回到有上限的淡雾（轨道最远 90 cm，只走到一半）
    this.hazeGate += (clamp01((d - 40) / 110) - this.hazeGate) * k;
    this.branches.haze.uHazeGate.value = this.hazeGate;
    // 远景虚化色斑圈（半径 75~240 cm）只在微距机位成立：40 cm 外开始淡出，80 cm 处全部退场
    this.backdrop.mesh.material.uniforms.uFade.value = 1 - clamp01((d - 40) / 40);
    // 飘雪片按相机距离放大：近景 1 倍（画面不变），远景最大 14 倍，不然 5 m 外 0.05 cm 的雪片全是亚像素
    // 雪箱随相机距离缩放：微距时是 ±124 × 62 cm 的箱子——6000 颗在这个箱子里的密度和以前 900 颗 ±48 cm 的一模一样（1576 颗/m³）；
    // 轨道最远 90 cm 时箱子还没开始扩（100 cm 外才扩），片幅按距离的 0.6 次方放大（线性放大时中景的近处雪片成了 30 px 的大光斑）
    const box = clamp01((d - 100) / 300);
    this.snowfall.uniforms.uRange.value = 124 + (380 - 124) * box;
    this.snowfall.uniforms.uHeight.value = 62 + (650 - 62) * box;
    this.snowfall.uniforms.uBase.value = -14 - 116 * box;
    // 片幅按距离的 0.6 次方放大；90 cm 处 ≈ 3.3 倍
    this.snowfall.uniforms.uSizeK.value = Math.min(Math.max(Math.pow(d / 12, 0.6), 1), 14);
  }

  private readonly tick = (now: number): void => {
    const dt = this.last ? Math.min((now - this.last) / 1000, 0.1) : 0.016;
    this.last = now;
    this.elapsed += dt;

    this.controls.update();
    this.updateFov(dt);
    this.snowfall.update(this.elapsed);
    this.puff.update(this.elapsed);
    // 树枝先弯，鸟根再跟着枝走（applyHop 在 updateMotion 里）
    this.branches.update(dt);
    this.bird.update(dt);
    // 绒毛壳层数按像素密度推进（近景恒满配）
    this.bird.updateFurLod(this.camera, this.renderer.domElement.height, dt);
    this.updateMotion(dt);
    this.renderer.render(this.scene, this.camera);

    this.fpsCount++;
    this.fpsWindow += dt;
    if (this.fpsWindow >= 0.5) {
      const fps = this.fpsCount / this.fpsWindow;
      const info = this.renderer.info;
      const texts = [
        `${fps.toFixed(0)} fps · ${(1000 / fps).toFixed(1)} ms`,
        `${info.render.calls} 次 / ${info.render.triangles.toLocaleString('en-US')} 三角形`,
        `${info.memory.textures} 张`,
        `${info.programs?.length ?? 0} 个`,
      ];
      this.stats.forEach((s, i) => s.set(texts[i] ?? ''));
      this.fpsWindow = 0;
      this.fpsCount = 0;
    }
  };

  private buildPanel(): void {
    const p = this.panel!;
    const fur = this.bird.furUniforms;
    const deg = (v: number): string => `${v.toFixed(0)}°`;

    p.header('北长尾山雀', '程序化观鸟 · 单枝展台');
    // 主入口（和画面底部正中那个同一件事）：飞进冬日小院自由漫游
    p.link(p.el, '展翅前往冬日小院 ➔', './garden.html', 'btn btn--cta', '飞进冬日小院：蹦跳 / 展翅 / 滑翔着陆');

    const st = p.section('状态');
    this.stats = [
      p.stat(st, '帧率'),
      p.stat(st, '绘制'),
      p.stat(st, '显存纹理'),
      p.stat(st, '着色器程序'),
    ];

    const vw = p.section('视角');
    p.segmented(vw, ['四分之三', '侧面', '正面', '背面', '头部', '尾部', '远景', '俯视', '斜俯视', '正后方'], 0, (i) =>
      this.setView(VIEW_NAMES[i]),
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

    const sc = p.section('场景');
    p.toggle(sc, '远景虚化', true, (on) => (this.backdrop.mesh.visible = on));
    p.toggle(sc, '飘雪', true, (on) => (this.snowfall.mesh.visible = on));
    p.button(sc, '隐藏面板 (H)', () => (p.visible = false));
  }
}
