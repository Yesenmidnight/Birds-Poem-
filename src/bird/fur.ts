import {
  FrontSide,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Matrix4,
  Mesh,
  Vector2,
  Vector3,
  Vector4,
  type BufferGeometry,
  type IUniform,
  ShaderMaterial,
} from 'three';
import { NOISE_GLSL } from '../glsl/noise';
import { makeLitMaterial, rgb, type LightingUniforms } from '../glsl/lit';
import { PLUMAGE_PARS } from './plumage';

/**
 * 绒毛：壳层法（shell fur），“梳顺的毛绒”。
 *
 * 同一张体表网格沿法线向外叠成几十层，每层在片元着色器里用三维噪声裁掉一部分，
 * 露出来的就是一缕缕毛丝。噪声按“毛流方向”高度拉伸，所以裁出来的是顺着毛流拉长的细丝缕，
 * 而不是一团团圆疙瘩。
 *
 * 毛形是“根立尖顺”：毛根先沿法线立起，把绒毛层撑出厚实的空气层（蓬松的来源），
 * 中后段平滑地倒向毛流方向，毛尖几乎贴着身体流淌（顺滑的来源）。
 * 所有长度起伏和方向扰动都只看空间坐标，相邻顶点的毛丝方向高度一致，才能成缕、不扎手。
 * 整个过程只有几何和数学，没有任何贴图。
 */
export interface FurSettings {
  shellCount: number;
  furLen: number;
  fluff: number;
  clump: number;
  tuftScale: number;
  stretch: number;
  density: number;
  scallop: number;
  sheen: number;
  translucency: number;
  /** 毛流方向上低频波浪的强度（空间连续，不是逐顶点随机）。 */
  random: number;
}

export const FUR_DEFAULTS: FurSettings = {
  shellCount: 96,
  // 根立尖顺后毛的法向高度约为毛长的 0.81 倍，0.27 刚好补回第一版 0.22 × 0.92 的厚度
  furLen: 0.27,
  fluff: 0.55,
  clump: 1.2,
  tuftScale: 14.0,
  stretch: 0.88,
  density: 1.0,
  scallop: 1.9,
  sheen: 0.35,
  translucency: 0.8,
  random: 0.16,
};

const MAX_STROKES = 3;

const FUR_VERTEX_PARS = /* glsl */ `
${NOISE_GLSL}
attribute vec3 aFlow;
attribute vec2 aW;
attribute vec4 aRegion;
attribute vec3 aParam;
// 被收拢的翅压住之前的毛长系数；翅展开后按 uWingOpen 恢复
attribute float aPress;
// 左右翅的展翅度（x = 右翅，y = 左翅）
uniform vec2 uWingOpen;
// 嘴根周围一圈毛（aJaw = 1）：张嘴后这段毛临时压短，两瓣颌不会埋在毛里；合拢态全长（body.ts 不静态压它）
attribute float aJaw;
uniform float uJawOpen;
attribute float aLayer;
uniform mat4 uBones[2];
uniform float uShellCount;
uniform float uFurLen;
uniform float uFluff;
uniform float uClump;
uniform float uTuftScale;
uniform float uScallop;
uniform float uRandom;
uniform vec4 uStroke[3];
uniform vec3 uStrokeDir[3];
uniform float uStrokeAge[3];
// 蒙皮前的静止局部坐标：色斑、毛簇、毛长起伏都按它采样，才能牢牢长在皮肤上跟着头一起转
varying vec3 vRestPos;
varying vec3 vRestN;
varying vec3 vRestFlow;
varying vec3 vParam;
varying float vT;
varying float vClump;
varying vec3 vStrandT;
// 头颈两根骨骼的权重和：羽色按它把关——跟着头转的皮肤只能是白毛（plumage.ts 的黑鞍领前缘）
varying float vBoneW;
`;

const FUR_VERTEX_MAIN = /* glsl */ `
	float wHead = aW.y;
	float wNeck = aW.x;
	float wBody = max( 0.0, 1.0 - wHead - wNeck );
	mat4 sk = uBones[0] * wNeck + uBones[1] * wHead + mat4( 1.0 ) * wBody;
	vec3 base = ( sk * vec4( position, 1.0 ) ).xyz;
	vec3 nL = normalize( mat3( uBones[0] ) * normal * wNeck + mat3( uBones[1] ) * normal * wHead + normal * wBody );
	vec3 fL = normalize( mat3( uBones[0] ) * aFlow * wNeck + mat3( uBones[1] ) * aFlow * wHead + aFlow * wBody );

	#ifdef CORE_PASS
		float t = 0.0;
	#else
		float t = aLayer / max( uShellCount - 1.0, 1.0 );
	#endif

	// 所有噪声都按蒙皮前的静止坐标 position 采样（绝不用 base）：头一转，静态噪声场若按蒙皮后的位置采样，
	// 就会在皮肤上“游移”——脸颊白毛撞进静止的口腔暗区染成黑胡子，毛簇也会随着转头重新排列
	// 羽片叠瓦：绒毛长度随位置缓慢起伏，轮廓才有“一层层羽毛”的起伏感。
	// 起伏只看空间坐标，相邻顶点才会连续——绝不能混进逐顶点的随机数
	float sc = snoise( position * uScallop );
	float clumpAmt = sc * 0.5 + 0.5;
	// 翅展开 0.25~0.7 之间，翼下压短的绒毛平滑回弹到全长；收拢态（uWingOpen = 0）和原来完全一样
	float wingOpen = position.x >= 0.0 ? uWingOpen.x : uWingOpen.y;
	float furK = mix( aParam.x, aPress, smoothstep( 0.25, 0.7, wingOpen ) );
	// 张嘴 0.04~0.2 rad 之间，嘴根周围一圈的毛压到 0.3；合拢态（uJawOpen = 0）逐位不变
	furK = mix( furK, min( furK, 0.3 ), aJaw * smoothstep( 0.04, 0.2, uJawOpen ) );
	float len = uFurLen * furK * ( 0.72 + 0.56 * clumpAmt ) * mix( 0.78, 1.32, uFluff );
	// 毛长的细碎起伏同样是空间连续的低频噪声
	len *= 0.82 + 0.36 * ( snoise( position * 5.0 + 3.1 ) * 0.5 + 0.5 );

	// 毛簇：相干噪声让相邻的毛聚成一缕。频率压到网格单元以上，方向场在顶点之间才是平滑的。
	// 噪声在静止坐标里取样后再用蒙皮矩阵转过来，毛缕的方向跟着皮肤一起转
	float cs = uTuftScale * 0.4;
	vec3 cn = mat3( sk ) * vec3(
		snoise( position * cs + 31.7 ),
		snoise( position * cs + 7.3 ),
		snoise( position * cs + 19.1 ) );
	vec3 clump = cn - nL * dot( cn, nL );

	// 抚摸：靠近划过位置的毛顺着划动方向倒伏（划动位置是当前鸟局部坐标，所以这里用 base）
	vec3 pet = vec3( 0.0 );
	float petW = 0.0;
	for ( int i = 0; i < 3; i ++ ) {
		vec3 d = base - uStroke[ i ].xyz;
		float fall = exp( - dot( d, d ) / ( uStroke[ i ].w * uStroke[ i ].w ) ) * uStrokeAge[ i ];
		vec3 dir = uStrokeDir[ i ] - nL * dot( uStrokeDir[ i ], nL );
		pet += dir * fall;
		petW += fall;
	}
	petW = clamp( petW, 0.0, 1.0 );

	// 微方向扰动：低频、空间连续的波动，像梳过的毛流里轻微起伏的波浪，而不是逐顶点乱扯
	vec3 rn = mat3( sk ) * vec3(
		snoise( position * 4.0 + 11.0 ),
		snoise( position * 4.0 + 23.0 ),
		snoise( position * 4.0 + 37.0 ) );
	rn -= nL * dot( rn, nL );
	vec3 T = fL + clump * uClump + rn * uRandom + pet * 2.5;
	T = T - nL * dot( T, nL );
	T = length( T ) > 1e-4 ? normalize( T ) : vec3( 0.0, 1.0, 0.0 );

	// 根立尖顺：倾角沿毛长从 0 平滑升到 phiTip，弯曲集中在 bendStart 之后——
	// 毛根立着撑厚度，中后段顺滑地倒向毛流方向，终端倾角约 70°~80°
	float phiTip = mix( 1.45, 1.22, uFluff );
	float bendStart = mix( 0.18, 0.36, uFluff );
	phiTip = mix( phiTip, 1.52, petW * 0.85 );
	bendStart = mix( bendStart, 0.08, petW );
	len *= 1.0 - 0.38 * petW;
	#ifdef CORE_PASS
		len = 0.0;
	#endif
	// 沿毛长数值积分出毛的位置（6 步中点法）
	const int STEPS = 6;
	float dt = t / float( STEPS );
	vec3 acc = vec3( 0.0 );
	for ( int i = 0; i < STEPS; i ++ ) {
		float tau = ( float( i ) + 0.5 ) * dt;
		float ph = phiTip * smoothstep( bendStart, 1.0, tau );
		acc += nL * cos( ph ) + T * sin( ph );
	}
	pos = base + acc * ( dt * len );
	float phi = phiTip * smoothstep( bendStart, 1.0, t );
	nrm = normalize( nL * cos( phi ) + T * sin( phi ) * 0.45 );

	vRestPos = position;
	vRestN = normal;
	vRestFlow = aFlow;
	vParam = vec3( furK, aParam.y, aParam.z );
	vBoneW = aW.x + aW.y;
	vT = t;
	vClump = clumpAmt;
	vStrandT = normalize( mat3( modelMatrix ) * ( nL * cos( phi ) + T * sin( phi ) ) );
`;

const FUR_FRAGMENT_PARS = /* glsl */ `
${PLUMAGE_PARS}
uniform float uTuftScale;
uniform float uStretch;
uniform float uDensity;
uniform float uSheen;
uniform float uTranslucency;
varying vec3 vRestPos;
varying vec3 vRestN;
varying vec3 vRestFlow;
varying vec3 vParam;
varying float vT;
varying float vClump;
varying vec3 vStrandT;
varying float vBoneW;
`;

const FUR_SURFACE = /* glsl */ `
	#ifdef CORE_PASS
		float alpha = 1.0;
	#else
		// 毛簇图样：在毛流方向上高度拉伸噪声，裁出来的是顺着毛流拉长的细丝缕而不是圆疙瘩；
		// 毛尖处阈值更高，所以只有最密的毛缕能长到外层。采样同样在静止坐标里做，毛缕才不会随转头游移
		vec3 fO = normalize( vRestFlow );
		vec3 q = vRestPos - fO * dot( vRestPos, fO ) * uStretch;
		float d1 = fbm3( q * uTuftScale );
		float d2 = snoise( q * uTuftScale * 2.7 + 41.0 ) * 0.5 + 0.5;
		float dens = d1 * 0.68 + d2 * 0.32;
		float thr = mix( 0.3, 0.8, pow( vT, 0.8 ) ) * uDensity;
		float cov = dens - thr;
		float aa = fwidth( cov ) + 1e-5;
		float alpha = clamp( cov / aa + 0.5, 0.0, 1.0 );
		// 毛尖淡出，轮廓才不会像一圈硬刺
		alpha *= 1.0 - smoothstep( 0.6, 1.0, vT ) * 0.92;
		// 毛长系数压到零的地方（喙根四周、眼睑底下、翼面底下）没有毛：壳层已经塌贴在皮肤上，
		// 再画出来就是一层半透明碎点盖在深色皮肤上，所以随毛长一起淡出
		alpha *= smoothstep( 0.02, 0.08, vParam.x );
	#endif
	Surf s;
	s.alpha = alpha;
	// 明暗的细碎起伏也只看空间坐标，保持连续。羽色按静止坐标算：口腔暗区、口角线、眼圈皮肤都写死在静止坐标里；
	// 黑鞍领的前缘还要按头颈骨骼权重退让（boneW），大角度转头时后颈窝不会拽出黑尖角
	s.albedo = plumage( vRestPos, normalize( vRestN ), vParam.z, vBoneW ) * ( 0.94 + 0.12 * ( snoise( vRestPos * 9.0 ) * 0.5 + 0.5 ) );
	// 簇与簇之间的凹处更暗一点
	s.ao = mix( 0.42, 1.0, pow( vT, 0.55 ) ) * ( 0.7 + 0.3 * vClump );
	s.wrap = 0.55;
	s.specTint = vec3( 1.0 );
	s.gloss = 0.3;
	s.specAmt = 0.0;
	return s;
`;

const FUR_EXTRA_LIGHT = /* glsl */ `
	float sh = sunShadow();
	// 逆光透射：绒毛被身后的阳光照透
	float back = clamp( dot( -V, uSunDir ), 0.0, 1.0 );
	float ndl = dot( N, uSunDir );
	vec3 trans = uSunColor * back * ( 0.35 + 0.65 * ( 1.0 - abs( ndl ) ) ) * 0.5 * sh * ( 0.25 + 0.75 * vT ) * uTranslucency;
	// 轮廓上散射的天光
	float fres = pow( 1.0 - clamp( dot( N, V ), 0.0, 1.0 ), 3.0 );
	// 深色羽毛几乎不吃轮廓光，否则黑羽会被洗成灰的
	float lum = dot( s.albedo, vec3( 0.3, 0.5, 0.2 ) );
	float lumW = smoothstep( 0.0, 0.3, lum );
	vec3 rim = uSkyColor * fres * 0.4 * vT * mix( 0.1, 1.0, lumW );
	// 沿毛丝方向的高光（Kajiya-Kay）
	vec3 T = normalize( vStrandT );
	vec3 H = normalize( uSunDir + V );
	float tdh = dot( T, H );
	float sinTH = sqrt( max( 1.0 - tdh * tdh, 0.0 ) );
	vec3 sheen = uSunColor * pow( sinTH, 48.0 ) * uSheen * sh * mix( 0.3, 1.0, vT ) * mix( 0.14, 1.0, lumW );
	return s.albedo * trans + rim + sheen * mix( vec3( 0.7, 0.8, 1.0 ), s.albedo, 0.85 );
`;

/**
 * 翼臂绒毛垫（wingTail.ts 的 buildWingArm 底面）专用的增量：满展态挂在翅枢轴下，收拢时随 uArmOpen 把整块垫缩回
 * 枢轴、毛长同步压到 0（收拢态一点不露）；配色不走 plumage()（那是躯干的分区），而是背脊炭黑 / 前缘包边 + 腹面纯白，
 * 靠肩内侧过渡到肩羽的奶白。躯干绒毛用的着色器字符串完全不动，只有 arm 实例才用下面这些替换过的版本。
 */
const ARM_RETRACT = 'smoothstep( 0.25, 0.6, uArmOpen )';
const ARM_VERTEX_PARS = FUR_VERTEX_PARS + /* glsl */ `
uniform float uArmOpen;
`;
const ARM_VERTEX_MAIN = FUR_VERTEX_MAIN.replace(
  'vec3 base = ( sk * vec4( position, 1.0 ) ).xyz;',
  'vec3 base = ( sk * vec4( position, 1.0 ) ).xyz * ' + ARM_RETRACT + ';',
).replace(
  'furK = mix( furK, min( furK, 0.3 ), aJaw * smoothstep( 0.04, 0.2, uJawOpen ) );',
  'furK = mix( furK, min( furK, 0.3 ), aJaw * smoothstep( 0.04, 0.2, uJawOpen ) );\n\tfurK *= ' + ARM_RETRACT + ';',
);
if (ARM_VERTEX_MAIN === FUR_VERTEX_MAIN) throw new Error('fur.ts: 翼臂顶点着色器的替换锚点失效');
const ARM_FRAGMENT_PARS = FUR_FRAGMENT_PARS + /* glsl */ `
uniform vec3 uColArmDorsal;
uniform vec3 uColArmShoulder;
uniform vec3 uArmSpan;
// 翼臂绒毛垫的配色：背腹权重是底面烘进的 aParam.z（背脊炭黑、前缘包边和腹面纯白），
// 背脊靠肩内侧（沿翼展 0.05~0.8）从肩羽的奶白过渡到炭黑，分界线用噪声打散
vec3 armPlumage( vec3 p, float dorsal ) {
	float span = dot( p, uArmSpan );
	vec3 top = mix( uColArmShoulder, uColArmDorsal, smoothstep( 0.05, 0.8, span ) );
	float d = smoothstep( 0.3, 0.7, dorsal + ( snoise( p * 14.0 ) - 0.5 ) * 0.3 );
	return mix( uColWhite, top, d );
}
`;
const ARM_SURFACE = FUR_SURFACE.replace(
  'plumage( vRestPos, normalize( vRestN ), vParam.z, vBoneW )',
  'armPlumage( vRestPos, vParam.z )',
);
if (ARM_SURFACE === FUR_SURFACE) throw new Error('fur.ts: 翼臂片元着色器的替换锚点失效');

/** 翼臂绒毛垫的"皮肤"投影用：和壳层同一套内收缩放，收拢态的影子不会留下一整只展开的翼臂。 */
export function makeFurArmDepth(open: IUniform): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { uArmOpen: open },
    vertexShader: /* glsl */ `
uniform float uArmOpen;
void main() {
	gl_Position = projectionMatrix * modelViewMatrix * vec4( position * ${ARM_RETRACT}, 1.0 );
}
`,
    fragmentShader: /* glsl */ `
#include <packing>
void main() {
	gl_FragColor = packDepthToRGBA( gl_FragCoord.z );
}
`,
  });
}

export class Fur {
  readonly group = new Group();
  readonly uniforms: Record<string, IUniform>;
  readonly trianglesPerShell: number;
  /** 最里层的实心"皮肤"（翼臂垫要给它换投影深度材质）。 */
  readonly core: Mesh;

  private readonly shells: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  private readonly maxShells: number;

  constructor(
    base: BufferGeometry,
    lighting: LightingUniforms,
    settings: FurSettings = FUR_DEFAULTS,
    maxShells = 96,
    arm?: { open: IUniform; span: Vector3 },
  ) {
    this.maxShells = maxShells;
    this.trianglesPerShell = (base.index?.count ?? 0) / 3;

    this.uniforms = {
      uShellCount: { value: settings.shellCount },
      uFurLen: { value: settings.furLen },
      uFluff: { value: settings.fluff },
      uClump: { value: settings.clump },
      uTuftScale: { value: settings.tuftScale },
      uStretch: { value: settings.stretch },
      uDensity: { value: settings.density },
      uScallop: { value: settings.scallop },
      uRandom: { value: settings.random },
      uSheen: { value: settings.sheen },
      uTranslucency: { value: settings.translucency },
      uBones: { value: [new Matrix4(), new Matrix4()] },
      uWingOpen: { value: new Vector2(0, 0) },
      uJawOpen: { value: 0 },
      uStroke: { value: Array.from({ length: MAX_STROKES }, () => new Vector4(0, 0, 0, 0.3)) },
      uStrokeDir: { value: Array.from({ length: MAX_STROKES }, () => new Vector3(0, 0, -1)) },
      uStrokeAge: { value: new Array<number>(MAX_STROKES).fill(0) },
      uColWhite: { value: rgb('#ebe6de') },
      uColPink: { value: rgb('#e2c0b9') },
      // 肩羽的焦糖肉桂 / 暖赤陶杏（plumage.ts 的 V 字肩羽上半段）
      uColRose: { value: rgb('#c48a6e') },
      uColBlack: { value: rgb('#1b191d') },
      uColCrown: { value: rgb('#f0dcd2') },
      uColSkin: { value: rgb('#4a3c38') },
    };
    if (arm) {
      this.uniforms.uArmOpen = arm.open;
      this.uniforms.uArmSpan = { value: arm.span };
      // 翼上背面前缘（小 / 中覆羽区）的深暖炭黑，和鞍领同一色系；靠肩内侧过渡到肩羽下半段的奶白
      this.uniforms.uColArmDorsal = { value: rgb('#2a2528') };
      this.uniforms.uColArmShoulder = { value: rgb('#e7d5ca') };
    }

    const material = (core: boolean): ShaderMaterial =>
      makeLitMaterial({
        lighting,
        uniforms: this.uniforms,
        side: FrontSide,
        alphaToCoverage: !core,
        defines: core ? { CORE_PASS: '' } : undefined,
        vertexPars: arm ? ARM_VERTEX_PARS : FUR_VERTEX_PARS,
        vertexMain: arm ? ARM_VERTEX_MAIN : FUR_VERTEX_MAIN,
        fragmentPars: arm ? ARM_FRAGMENT_PARS : FUR_FRAGMENT_PARS,
        surface: arm ? ARM_SURFACE : FUR_SURFACE,
        extraLight: core ? undefined : FUR_EXTRA_LIGHT,
      });

    // 最里层是一张实心的“皮肤”，负责堵住缝隙和投影
    const coreMesh = new Mesh(base, material(true));
    coreMesh.castShadow = true;
    coreMesh.receiveShadow = true;
    this.core = coreMesh;
    this.group.add(coreMesh);

    // 外面叠 maxShells 层壳，实际画多少层由 instanceCount 决定
    const geo = new InstancedBufferGeometry();
    geo.index = base.index;
    for (const [name, attr] of Object.entries(base.attributes)) {
      geo.setAttribute(name, attr);
    }
    const layers = new Float32Array(maxShells);
    for (let i = 0; i < maxShells; i++) layers[i] = i;
    geo.setAttribute('aLayer', new InstancedBufferAttribute(layers, 1));
    geo.instanceCount = settings.shellCount;
    if (base.boundingSphere) geo.boundingSphere = base.boundingSphere.clone();

    this.shells = new Mesh(geo, material(false));
    this.shells.frustumCulled = false;
    this.shells.receiveShadow = true;
    this.group.add(this.shells);
  }

  get shellCount(): number {
    return this.shells.geometry.instanceCount;
  }

  setShellCount(n: number): void {
    const count = Math.max(2, Math.min(this.maxShells, Math.round(n)));
    this.shells.geometry.instanceCount = count;
    this.uniforms.uShellCount.value = count;
  }

  /** 设置骨骼（0 = 颈，1 = 头）在鸟局部空间里的形变矩阵。 */
  setBone(index: 0 | 1, matrix: Matrix4): void {
    (this.uniforms.uBones.value as Matrix4[])[index].copy(matrix);
  }

  /**
   * 记录一次抚摸：point 为鸟局部坐标的接触点，dir 为划动方向（切平面内），
   * strength 为力度，0..1。随后逐帧用 age 衰减。
   */
  stroke(point: Vector3, dir: Vector3, radius: number, strength: number, slot = 0): void {
    (this.uniforms.uStroke.value as Vector4[])[slot].set(point.x, point.y, point.z, Math.max(radius, 0.05));
    (this.uniforms.uStrokeDir.value as Vector3[])[slot].copy(dir);
    this.uniforms.uStrokeAge.value[slot] = Math.max(strength, 0);
  }

  /** 抚摸痕迹的衰减，dt 单位秒。 */
  decayStrokes(dt: number): void {
    const ages = this.uniforms.uStrokeAge.value as number[];
    for (let i = 0; i < ages.length; i++) {
      ages[i] = Math.max(0, ages[i] - dt * 2.2);
    }
  }
}
