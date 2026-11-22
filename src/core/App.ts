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
import { Branches } from '../world/Branch';
import { Sky } from '../world/Sky';
import { Snowfall } from '../world/Snowfall';
import { Bird, type BirdPart, type BlinkPose, type TailPose, type WingPose } from '../bird/Bird';
import { FUR_DEFAULTS } from '../bird/fur';
import { MotionController, type MotionCue } from '../bird/motion/MotionController';
import { restPose } from '../bird/motion/Pose';
import { FOOT_SPOTS } from '../bird/parts';

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
  threequarter: { az: -0.62, el: 0.16, dist: 12, target: [0.2, 2.6, -0.3] },
  side: { az: 0.0, el: 0.05, dist: 11.5, target: [0.6, 2.4, 0] },
  front: { az: -Math.PI / 2 + 0.18, el: 0.08, dist: 10, target: [-0.3, 2.6, 0] },
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
const VIEW_NAMES = Object.keys(VIEWS);

export interface AppOptions {
  ui: boolean;
  dprCap: number;
}

export class App {
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

  private elapsed = 0;
  private last = 0;
  private fpsWindow = 0;
  private fpsCount = 0;
  private stats: { set(text: string): void }[] = [];
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

    this.camera = new PerspectiveCamera(28, root.clientWidth / root.clientHeight, 0.5, 2000);
    this.lighting = new Lighting(this.scene);

    this.sky = new Sky(this.lighting.uniforms.uSunDir.value);
    this.backdrop = new Backdrop();
    this.snowfall = new Snowfall();
    this.branches = new Branches(this.lighting.uniforms, FOOT_SPOTS);
    // 栖枝几何从树枝那里精确查（样条高度、树皮鼓包、积雪帽），脚爪才贴在真实的面上
    this.bird = new Bird(this.lighting.uniforms, this.branches.perchAt(0));
    this.scene.add(this.sky.mesh, this.backdrop.mesh, this.snowfall.mesh, this.branches, this.bird.group);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false;
    this.controls.minDistance = 3.5;
    this.controls.maxDistance = 45;
    this.controls.minPolarAngle = 0.55;
    this.controls.maxPolarAngle = 1.72;
    this.controls.rotateSpeed = 0.6;
    this.controls.zoomSpeed = 0.8;

    this.panel = opts.ui ? new Panel(root) : null;
    if (this.panel) this.buildPanel();

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

  start(view = 'threequarter'): void {
    this.setView(view);
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
    if (m.enabled) this.bird.applyPose(pose);
  }

  private readonly tick = (now: number): void => {
    const dt = this.last ? Math.min((now - this.last) / 1000, 0.1) : 0.016;
    this.last = now;
    this.elapsed += dt;

    this.controls.update();
    this.snowfall.update(this.elapsed);
    this.bird.update(dt);
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

    p.header('北长尾山雀', '程序化观鸟 · 原型');

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
    p.slider(hd, '左右转', -100, 100, 1, 0, (v) => ((pose.yaw = v), apply()), deg);
    p.slider(hd, '抬头低头', -45, 45, 1, 0, (v) => ((pose.pitch = v), apply()), deg);
    p.slider(hd, '歪头', -90, 90, 1, 0, (v) => ((pose.roll = v), apply()), deg);

    const pct = (v: number): string => `${v.toFixed(0)}%`;

    const ml = p.section('微生命');
    p.toggle(ml, '动作系统', this.motion.enabled, (on) => {
      this.motion.enabled = on;
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
    p.slider(mo, '翅上抬', 0, 70, 1, 0, (v) => ((wing.lift = (v * Math.PI) / 180), applyWing()), deg);
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
