import {
  FrontSide,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Matrix4,
  Mesh,
  Vector3,
  Vector4,
  type BufferGeometry,
  type IUniform,
  type ShaderMaterial,
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
varying vec3 vPos;
varying vec3 vNO;
varying vec3 vFlowO;
varying vec3 vParam;
varying float vT;
varying float vClump;
varying vec3 vStrandT;
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

	// 羽片叠瓦：绒毛长度随位置缓慢起伏，轮廓才有“一层层羽毛”的起伏感。
	// 起伏只看空间坐标 base，相邻顶点才会连续——绝不能混进逐顶点的随机数
	float sc = snoise( base * uScallop );
	float clumpAmt = sc * 0.5 + 0.5;
	float len = uFurLen * aParam.x * ( 0.72 + 0.56 * clumpAmt ) * mix( 0.78, 1.32, uFluff );
	// 毛长的细碎起伏同样是空间连续的低频噪声
	len *= 0.82 + 0.36 * ( snoise( base * 5.0 + 3.1 ) * 0.5 + 0.5 );

	// 毛簇：相干噪声让相邻的毛聚成一缕。频率压到网格单元以上，方向场在顶点之间才是平滑的
	float cs = uTuftScale * 0.4;
	vec3 cn = vec3(
		snoise( base * cs + 31.7 ),
		snoise( base * cs + 7.3 ),
		snoise( base * cs + 19.1 ) );
	vec3 clump = cn - nL * dot( cn, nL );

	// 抚摸：靠近划过位置的毛顺着划动方向倒伏
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
	vec3 rn = vec3(
		snoise( base * 4.0 + 11.0 ),
		snoise( base * 4.0 + 23.0 ),
		snoise( base * 4.0 + 37.0 ) );
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

	vPos = base;
	vNO = nL;
	vFlowO = fL;
	vParam = aParam;
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
varying vec3 vPos;
varying vec3 vNO;
varying vec3 vFlowO;
varying vec3 vParam;
varying float vT;
varying float vClump;
varying vec3 vStrandT;
`;

const FUR_SURFACE = /* glsl */ `
	#ifdef CORE_PASS
		float alpha = 1.0;
	#else
		// 毛簇图样：在毛流方向上高度拉伸噪声，裁出来的是顺着毛流拉长的细丝缕而不是圆疙瘩；
		// 毛尖处阈值更高，所以只有最密的毛缕能长到外层
		vec3 fO = normalize( vFlowO );
		vec3 q = vPos - fO * dot( vPos, fO ) * uStretch;
		float d1 = fbm3( q * uTuftScale );
		float d2 = snoise( q * uTuftScale * 2.7 + 41.0 ) * 0.5 + 0.5;
		float dens = d1 * 0.68 + d2 * 0.32;
		float thr = mix( 0.3, 0.8, pow( vT, 0.8 ) ) * uDensity;
		float cov = dens - thr;
		float aa = fwidth( cov ) + 1e-5;
		float alpha = clamp( cov / aa + 0.5, 0.0, 1.0 );
		// 毛尖淡出，轮廓才不会像一圈硬刺
		alpha *= 1.0 - smoothstep( 0.6, 1.0, vT ) * 0.92;
	#endif
	Surf s;
	s.alpha = alpha;
	// 明暗的细碎起伏也只看空间坐标，保持连续
	s.albedo = plumage( vPos, normalize( vNO ), vParam.z ) * ( 0.94 + 0.12 * ( snoise( vPos * 9.0 ) * 0.5 + 0.5 ) );
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

export class Fur {
  readonly group = new Group();
  readonly uniforms: Record<string, IUniform>;
  readonly trianglesPerShell: number;

  private readonly shells: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  private readonly maxShells: number;

  constructor(
    base: BufferGeometry,
    lighting: LightingUniforms,
    settings: FurSettings = FUR_DEFAULTS,
    maxShells = 96,
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
      uStroke: { value: Array.from({ length: MAX_STROKES }, () => new Vector4(0, 0, 0, 0.3)) },
      uStrokeDir: { value: Array.from({ length: MAX_STROKES }, () => new Vector3(0, 0, -1)) },
      uStrokeAge: { value: new Array<number>(MAX_STROKES).fill(0) },
      uColWhite: { value: rgb('#ebe6de') },
      uColPink: { value: rgb('#e2c0b9') },
      uColRose: { value: rgb('#b9847c') },
      uColBlack: { value: rgb('#1b191d') },
      uColCrown: { value: rgb('#f0dcd2') },
      uColSkin: { value: rgb('#4a3c38') },
    };

    const material = (core: boolean): ShaderMaterial =>
      makeLitMaterial({
        lighting,
        uniforms: this.uniforms,
        side: FrontSide,
        alphaToCoverage: !core,
        defines: core ? { CORE_PASS: '' } : undefined,
        vertexPars: FUR_VERTEX_PARS,
        vertexMain: FUR_VERTEX_MAIN,
        fragmentPars: FUR_FRAGMENT_PARS,
        surface: FUR_SURFACE,
        extraLight: core ? undefined : FUR_EXTRA_LIGHT,
      });

    // 最里层是一张实心的“皮肤”，负责堵住缝隙和投影
    const coreMesh = new Mesh(base, material(true));
    coreMesh.castShadow = true;
    coreMesh.receiveShadow = true;
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
