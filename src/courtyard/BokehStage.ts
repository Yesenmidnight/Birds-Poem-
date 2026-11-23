/**
 * 前背景双层分离的圆盘散景（观鸟微距的"长焦浅景深"）：
 *   背景 = 图层 0（天空 / 雪地 / 洋房 / 阳光房 / 大植物园 / 院落 / 草坪花境 / 老海棠 / 春树 / 远处飘雪），前景 = 图层 1
 *   （小鸟 96 层绒毛 / 主角横枝 + 前景红果侧枝 / 蹬枝雪粉 / 近处飘雪 / 调试叠加）。
 *   观鸟态（mix > 0.005）三步：
 *     ① 主相机只看图层 0，渲染进一张 0.55× 的半精度离屏图（线性 HDR，不做色调映射）；
 *     ② Golden-Angle Vogel 圆盘散景（最多 24 采样）：亮部按超出量提权化成奶油光斑，再按 mix 叠一层浅雪雾，全屏画到主画布底层（不写深度），
 *        出口处补上和主画布一样的 ACES + sRGB（不然散景收光圈的一瞬背景会跳色）；
 *     ③ 清掉主画布的深度，主相机只看图层 1 直接画到原生 MSAA 主画布上——绒毛边缘是硬件抗锯齿的锐利边缘，没有深度图 DoF 的糊边漏色，
 *        也不会把同深度的旁枝一起"对焦"进来。
 *   漫游态（mix ≤ 0.005）：关掉离屏通道，主相机同时开两个图层单趟直绘，零额外 GPU 开销。
 *   阴影贴图：three 的阴影通道按主相机的图层筛投影物——锐利层那趟先让相机看全两个图层把阴影贴图画全（房屋 / 老海棠的影子落在主角枝上），
 *   画完立刻切回只看前景层再进颜色通道（包了一层 shadowMap.render 的钩子）；背景层那趟不更新阴影，沿用上一帧的贴图（虚化后看不出）。
 */
import { Color, HalfFloatType, LinearFilter, Mesh, NoBlending, OrthographicCamera, PlaneGeometry, RGBAFormat, Scene, ShaderMaterial, Vector2, WebGLRenderTarget, type Object3D, type PerspectiveCamera, type WebGLRenderer } from 'three';

/** 背景虚化层 / 前景锐利层的图层号。 */
export const LAYER_BG = 0;
export const LAYER_FG = 1;
const ALL_LAYERS = (1 << LAYER_BG) | (1 << LAYER_FG);

/** 散焦圆盘最多 / 最少采样数（随散焦度增减，过渡到清晰态的路上省下来）。 */
const SAMPLES_MAX = 24;
const SAMPLES_MIN = 6;

export class BokehStage {
  readonly target: WebGLRenderTarget;
  readonly uniforms: Record<string, { value: unknown }> = {
    tBg: { value: null },
    uTexel: { value: new Vector2(1, 1) },
    /** 散焦半径（离屏图像素），随画布高度走。 */
    uRadius: { value: 14 },
    /** 这一帧的散焦度 0..1（过渡 × 面板滑块）。 */
    uMix: { value: 1 },
    /** 浅雪雾（线性色）：背景往它柔化，红砖墙 / 白窗框的硬对比退后。 */
    uHaze: { value: new Color(0.6, 0.66, 0.74) },
    uHazeK: { value: 0.18 },
    /** 亮部提权：线性亮度超过 uBrightT 的采样按超出量 × uBrightK 加权，光斑往外化开。 */
    uBrightK: { value: 1.6 },
    uBrightT: { value: 0.9 },
    /** 亮部外扩的光晕（按能量守恒再叠一层）。 */
    uGlowK: { value: 0.35 },
  };
  private readonly renderer: WebGLRenderer;
  private readonly scale: number;
  private readonly quadScene = new Scene();
  private readonly quadCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  /** 阴影贴图画完之后要执行的回调（锐利层那趟用它把相机切回只看前景层）。 */
  private afterShadow: (() => void) | null = null;
  /** 每趟渲染之前的回调（飘雪按 bg / fg / all 决定这一趟画近处还是远处的雪片）。 */
  onPass: ((pass: 'bg' | 'fg' | 'all') => void) | null = null;

  constructor(renderer: WebGLRenderer, opts: { scale?: number } = {}) {
    this.renderer = renderer;
    this.scale = opts.scale ?? 0.55;
    this.target = new WebGLRenderTarget(8, 8, {
      type: HalfFloatType,
      format: RGBAFormat,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    this.target.texture.name = 'bokeh-bg';
    this.uniforms.tBg.value = this.target.texture;
    const quad = new Mesh(
      new PlaneGeometry(2, 2),
      new ShaderMaterial({
        uniforms: this.uniforms,
        depthTest: false,
        depthWrite: false,
        blending: NoBlending,
        toneMapped: true,
        vertexShader: /* glsl */ `
varying vec2 vUv;
void main() {
	vUv = uv;
	gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`,
        fragmentShader: /* glsl */ `
uniform sampler2D tBg;
uniform vec2 uTexel;
uniform float uRadius;
uniform float uMix;
uniform vec3 uHaze;
uniform float uHazeK;
uniform float uBrightK;
uniform float uBrightT;
uniform float uGlowK;
varying vec2 vUv;
const float GOLDEN = 2.39996323;
float luma( vec3 c ) {
	return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
}
void main() {
	vec3 c0 = texture2D( tBg, vUv ).rgb;
	float r = uRadius * uMix;
	// 逐像素转一下采样盘：固定的采样图会显出环纹 / 网纹
	float jitter = fract( sin( dot( gl_FragCoord.xy, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ) * 6.2831853;
	int n = int( ceil( mix( ${SAMPLES_MIN.toFixed(1)}, ${SAMPLES_MAX.toFixed(1)}, uMix ) ) );
	float fn = float( n );
	vec3 acc = c0;
	float wsum = 1.0;
	vec3 glow = vec3( 0.0 );
	for ( int i = 0; i < ${SAMPLES_MAX}; i ++ ) {
		if ( i >= n ) break;
		float fi = float( i );
		// Vogel 圆盘：黄金角展开 + 面积均匀的半径，盘内采样密度一致
		float a = fi * GOLDEN + jitter;
		float rr = sqrt( ( fi + 0.5 ) / fn ) * r;
		vec2 o = vec2( cos( a ), sin( a ) ) * rr * uTexel;
		vec3 s = texture2D( tBg, vUv + o ).rgb;
		float b = max( luma( s ) - uBrightT, 0.0 );
		float w = 1.0 + uBrightK * b;
		acc += s * w;
		wsum += w;
		glow += s * b;
	}
	vec3 c = acc / wsum + glow / fn * uGlowK * uMix;
	// 浅雪雾柔化
	c = mix( c, uHaze, uHazeK * uMix );
	gl_FragColor = vec4( c, 1.0 );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}
`,
      }),
    );
    quad.frustumCulled = false;
    this.quadScene.add(quad);

    // 渲染器管线归这里管：手动清屏（两趟颜色之间只清深度）、阴影贴图按需更新、绘制统计累加两趟
    renderer.autoClear = false;
    renderer.shadowMap.autoUpdate = false;
    renderer.info.autoReset = false;
    // 阴影通道之后、颜色通道之前没有官方钩子：包一层 shadowMap.render
    const sm = renderer.shadowMap as unknown as { render: (lights: unknown[], scene: Scene, camera: PerspectiveCamera) => void };
    const orig = sm.render;
    sm.render = (lights: unknown[], scene: Scene, camera: PerspectiveCamera): void => {
      orig.call(renderer.shadowMap, lights, scene, camera);
      const hook = this.afterShadow;
      this.afterShadow = null;
      hook?.();
    };
  }

  /** 画布尺寸变了（设备像素）。 */
  setSize(width: number, height: number): void {
    const w = Math.max(2, Math.round(width * this.scale));
    const h = Math.max(2, Math.round(height * this.scale));
    this.target.setSize(w, h);
    (this.uniforms.uTexel.value as Vector2).set(1 / w, 1 / h);
    // 散焦半径 ≈ 离屏图高度的 1.6%（1080p 画布 ≈ 9.5 离屏像素 ≈ 17 画布像素）：拉满时砖墙 / 花架 / 树干还认得出轮廓，只是柔掉了
    this.uniforms.uRadius.value = h * 0.016;
  }

  /** 把一组物体（连同子孙）整体放进前景锐利层；其余物体留在图层 0。 */
  setForeground(objects: readonly Object3D[]): void {
    for (const o of objects) o.traverse((c) => c.layers.set(LAYER_FG));
  }

  /**
   * 画一帧。mix = 这一帧的散焦度（0..1）。
   * 调用方每帧先 renderer.info.reset()。
   */
  render(scene: Scene, camera: PerspectiveCamera, mix: number): void {
    const r = this.renderer;
    r.setRenderTarget(null);
    if (mix <= 0.005) {
      camera.layers.mask = ALL_LAYERS;
      this.onPass?.('all');
      r.shadowMap.needsUpdate = true;
      r.clear(true, true, false);
      r.render(scene, camera);
      return;
    }
    // ① 背景层 → 离屏图（线性 HDR）。阴影贴图不更新，沿用上一帧锐利层那趟画好的
    camera.layers.set(LAYER_BG);
    r.shadowMap.needsUpdate = false;
    this.onPass?.('bg');
    r.setRenderTarget(this.target);
    r.setClearColor(this.uniforms.uHaze.value as Color, 1);
    r.clear(true, true, false);
    r.render(scene, camera);
    // ② 散景全屏 → 主画布底层（不写深度）
    r.setRenderTarget(null);
    r.clear(true, true, false);
    this.uniforms.uMix.value = mix;
    r.render(this.quadScene, this.quadCam);
    // ③ 锐利层 → 主画布（原生 MSAA）：先清深度，阴影贴图这一趟看全两个图层，画完切回只看前景层
    r.clearDepth();
    camera.layers.mask = ALL_LAYERS;
    this.onPass?.('fg');
    r.shadowMap.needsUpdate = true;
    this.afterShadow = () => camera.layers.set(LAYER_FG);
    r.render(scene, camera);
  }

  dispose(): void {
    this.target.dispose();
  }
}
