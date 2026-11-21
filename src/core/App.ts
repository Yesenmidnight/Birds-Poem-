import { ACESFilmicToneMapping, PCFShadowMap, PerspectiveCamera, SRGBColorSpace, Scene, WebGLRenderer } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Lighting } from './Lighting';
import { Panel } from '../ui/Panel';
import { Backdrop } from '../world/Backdrop';
import { Branches } from '../world/Branch';
import { Sky } from '../world/Sky';
import { Snowfall } from '../world/Snowfall';
import { Bird, type BirdPart } from '../bird/Bird';
import { FUR_DEFAULTS } from '../bird/fur';
import type { Perch } from '../bird/parts';

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
  head: { az: -0.75, el: 0.1, dist: 4.6, target: [-0.55, 3.75, 0.05] },
  tail: { az: -0.35, el: 0.3, dist: 13, target: [3.5, 1.6, 0] },
  wide: { az: -0.5, el: 0.2, dist: 28, target: [2, 2, 0] },
};
const VIEW_NAMES = Object.keys(VIEWS);

/** 栖枝在落点处的参数，脚趾要绕着它抓握。 */
const PERCH: Perch = { radius: 0.42, axisY: -0.42, axisZ: 0 };

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

  private elapsed = 0;
  private last = 0;
  private fpsWindow = 0;
  private fpsCount = 0;
  private stats: { set(text: string): void }[] = [];

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
    this.branches = new Branches(this.lighting.uniforms);
    this.bird = new Bird(this.lighting.uniforms, PERCH);
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

  private readonly tick = (now: number): void => {
    const dt = this.last ? Math.min((now - this.last) / 1000, 0.1) : 0.016;
    this.last = now;
    this.elapsed += dt;

    this.controls.update();
    this.snowfall.update(this.elapsed);
    this.bird.update(dt);
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
    p.segmented(vw, ['四分之三', '侧面', '正面', '背面', '头部', '尾部', '远景'], 0, (i) =>
      this.setView(VIEW_NAMES[i]),
    );

    const fl = p.section('绒毛');
    p.slider(fl, '壳层数', 4, 96, 1, this.bird.fur.shellCount, (v) => this.bird.fur.setShellCount(v), (v) => v.toFixed(0));
    p.slider(fl, '毛长', 0.05, 0.5, 0.005, FUR_DEFAULTS.furLen, (v) => (fur.uFurLen.value = v), (v) => `${v.toFixed(3)}`);
    p.slider(fl, '蓬松度', 0, 1, 0.01, FUR_DEFAULTS.fluff, (v) => (fur.uFluff.value = v));
    p.slider(fl, '毛簇尺度', 1.5, 12, 0.1, FUR_DEFAULTS.tuftScale, (v) => (fur.uTuftScale.value = v));
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
