/**
 * 自研的解析光照模型 + three 阴影接入。
 *
 * 所有材质都用这一套：太阳直射（带阴影）、天空/地面半球环境光、高光。
 * 光照量全部来自 uniform，颜色和纹理细节由各材质的 surface() 在片元着色器里现算。
 */
import {
  Color,
  DoubleSide,
  FrontSide,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  Vector3,
  type IUniform,
  type Side,
} from 'three';
import { NOISE_GLSL } from './noise';

export interface LightingUniforms {
  uSunDir: { value: Vector3 }; // 世界空间，指向太阳
  uSunColor: { value: Color }; // 太阳辐射亮度（线性）
  uSkyColor: { value: Color }; // 天空半球环境光
  uGroundColor: { value: Color }; // 地面（雪地反弹）半球环境光
}

const LIGHT_UNIFORMS_GLSL = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
`;

/** 顶点着色器公共前缀。 */
const LIT_VERTEX_PARS = /* glsl */ `
#include <common>
#include <shadowmap_pars_vertex>
varying vec3 vWorldPos;
varying vec3 vWorldN;
`;

/**
 * 顶点着色器公共尾部：调用方先把位移结果放进 `pos`、法线放进 `nrm`，
 * 这里负责世界空间输出与阴影坐标。
 */
const LIT_VERTEX_TAIL = /* glsl */ `
	vec4 worldPosition = modelMatrix * vec4( pos, 1.0 );
	vWorldPos = worldPosition.xyz;
	vWorldN = normalize( mat3( modelMatrix ) * nrm );
	vec3 transformedNormal = normalize( normalMatrix * nrm );
	vec4 mvPosition = viewMatrix * worldPosition;
	gl_Position = projectionMatrix * mvPosition;
	#include <shadowmap_vertex>
`;

/** 片元着色器公共前缀：噪声、光照、阴影采样。 */
const LIT_FRAGMENT_PARS = /* glsl */ `
${NOISE_GLSL}
#include <common>
#include <packing>
#include <lights_pars_begin>
#include <shadowmap_pars_fragment>
${LIGHT_UNIFORMS_GLSL}
varying vec3 vWorldPos;
varying vec3 vWorldN;

struct Surf {
	vec3 albedo;
	float ao;        // 环境遮蔽，乘在漫反射上
	float wrap;      // 漫反射包裹系数，0 = 兰伯特，越大越柔
	vec3 specTint;   // 高光颜色
	float gloss;     // 0 粗糙 .. 1 光亮
	float specAmt;   // 高光强度
	float alpha;     // 配合 alphaToCoverage 使用
};

float sunShadow() {
#ifdef NO_RECEIVE_SHADOW
	// makeLitMaterial({ receiveShadow: false }) 的材质不取样阴影贴图。three 对 lights: true 的自定义 ShaderMaterial
	// 只按"场景里有投影灯"注入 USE_SHADOWMAP，不看你给 mesh.receiveShadow 设的 false（内置材质靠 uniform bool receiveShadow
	// 在 lights_fragment_begin 里判，我们这份 sunShadow 没有那一层）——前景海棠果肩上的黑锅盖就是这么来的
	return 1.0;
#else
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
	DirectionalLightShadow s = directionalLightShadows[ 0 ];
	return getShadow( directionalShadowMap[ 0 ], s.shadowMapSize, s.shadowIntensity, s.shadowBias, s.shadowRadius, vDirectionalShadowCoord[ 0 ] );
#else
	return 1.0;
#endif
#endif
}

vec3 shadeLit( vec3 N, vec3 V, Surf s ) {
	float sh = sunShadow();
	float ndl = dot( N, uSunDir );
	float diff = clamp( ( ndl + s.wrap ) / ( 1.0 + s.wrap ), 0.0, 1.0 );
	vec3 sun = uSunColor * diff * sh;
	vec3 hemi = mix( uGroundColor, uSkyColor, N.y * 0.5 + 0.5 );
	vec3 col = s.albedo * ( sun + hemi ) * s.ao;
	vec3 H = normalize( uSunDir + V );
	float ndh = max( dot( N, H ), 0.0 );
	float g = max( 1.0 - s.gloss, 0.03 );
	float shin = 2.0 / ( g * g * g * g ) - 2.0;
	float spec = pow( ndh, shin ) * s.specAmt * sh * step( 0.0, ndl );
	col += s.specTint * spec;
	return col;
}
`;

/** 片元着色器公共主函数：调用方提供 `Surf surface( vec3 N, vec3 V )`；bumpMain 是程序化凹凸段（没有凹凸的材质传空串，源码逐字节不变）。 */
const LIT_FRAGMENT_MAIN = (bumpMain: string): string => /* glsl */ `
void main() {
	vec3 N = normalize( vWorldN );
	#ifdef FLIP_BACKFACE
		if ( ! gl_FrontFacing ) N = - N;
	#endif
	vec3 V = normalize( cameraPosition - vWorldPos );
	Surf s = surface( N, V );
	#ifdef USE_ALPHA
		if ( s.alpha < 0.02 ) discard;
	#endif${bumpMain}
	vec3 col = shadeLit( N, V, s );
	#ifdef EXTRA_LIGHT
		col += extraLight( N, V, s );
	#endif
	gl_FragColor = vec4( col, s.alpha );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}
`;

/**
 * 程序化凹凸（零贴图）：调用方给 `float bumpHeight( vec3 p, vec3 N )`（世界空间高度，cm），这里用 dFdx / dFdy 把它转成
 * 受光法线的扰动（Mikkelsen 2008 的无参数表面凹凸，和 three 的 perturbNormalArb 同一推导）。
 * 屏幕像素的足迹比特征尺寸大时淡出：远处的细凹凸只会闪成麻点。
 */
const LIT_BUMP_MAIN = /* glsl */ `

	{
		float bh = bumpHeight( vWorldPos, N ) * BUMP_SCALE;
		vec3 sX = dFdx( vWorldPos );
		vec3 sY = dFdy( vWorldPos );
		vec3 r1 = cross( sY, N );
		vec3 r2 = cross( N, sX );
		float det = dot( sX, r1 ) * ( gl_FrontFacing ? 1.0 : -1.0 );
		float footprint = length( sX ) + length( sY );
		float fade = 1.0 - smoothstep( 0.25, 1.0, footprint / BUMP_FEATURE );
		vec3 grad = sign( det ) * ( dFdx( bh ) * r1 + dFdy( bh ) * r2 ) * fade;
		N = normalize( abs( det ) * N - grad );
	}
`;

export interface LitMaterialOptions {
  /** 顶点着色器额外声明（attribute / uniform / varying）。 */
  vertexPars?: string;
  /** 顶点着色器主体：把 `position` / `normal` 变换为 `pos` / `nrm`。 */
  vertexMain?: string;
  /** 片元着色器额外声明（uniform / varying）。 */
  fragmentPars?: string;
  /** `Surf surface( vec3 N, vec3 V )` 的函数体。 */
  surface: string;
  /** 可选的附加光照：`vec3 extraLight( vec3 N, vec3 V, Surf s )` 的函数体（透射、轮廓光、各向异性高光等）。 */
  extraLight?: string;
  uniforms?: Record<string, IUniform>;
  lighting: LightingUniforms;
  defines?: Record<string, string>;
  /** 不接收阴影贴图（默认 true，现有材质逐位不变）：前景海棠果这类不能被鸟尾 / 树枝的硬阴影盖住的小物件用。 */
  receiveShadow?: boolean;
  side?: Side;
  alphaToCoverage?: boolean;
  transparent?: boolean;
  depthWrite?: boolean;
  /**
   * 可选的程序化凹凸（零贴图）：`float bumpHeight( vec3 p, vec3 N )` 的函数体，返回世界空间高度（cm）；
   * dFdx / dFdy 把它转成受光法线的扰动。不传 = 着色器源码逐字节不变（小鸟 / 观鸟树枝材质零影响）。
   */
  bump?: { height: string; scale?: number; feature?: number };
}

/** 造一个带光照与阴影的自定义材质。 */
export function makeLitMaterial(opts: LitMaterialOptions): ShaderMaterial {
  const defines: Record<string, string> = { ...(opts.defines ?? {}) };
  if (opts.side === DoubleSide) defines.FLIP_BACKFACE = '';
  if (opts.alphaToCoverage) defines.USE_ALPHA = '';
  if (opts.extraLight) defines.EXTRA_LIGHT = '';
  if (opts.receiveShadow === false) defines.NO_RECEIVE_SHADOW = '';
  if (opts.bump) {
    defines.BUMP_SCALE = (opts.bump.scale ?? 1).toFixed(3);
    defines.BUMP_FEATURE = (opts.bump.feature ?? 4).toFixed(2);
  }
  const bumpMain = opts.bump ? LIT_BUMP_MAIN : '';
  const bumpDecl = opts.bump ? `float bumpHeight( vec3 p, vec3 N ) {\n${opts.bump.height}\n}\n` : '';

  const merged = UniformsUtils.merge([
    UniformsLib.lights,
    {
      uSunDir: { value: opts.lighting.uSunDir.value },
      uSunColor: { value: opts.lighting.uSunColor.value },
      uSkyColor: { value: opts.lighting.uSkyColor.value },
      uGroundColor: { value: opts.lighting.uGroundColor.value },
      ...opts.uniforms,
    },
  ]);
  // merge 会克隆取值，这里换回共享的灯光 uniform，保证全场同步。
  merged.uSunDir = opts.lighting.uSunDir;
  merged.uSunColor = opts.lighting.uSunColor;
  merged.uSkyColor = opts.lighting.uSkyColor;
  merged.uGroundColor = opts.lighting.uGroundColor;
  for (const key of Object.keys(opts.uniforms ?? {})) {
    merged[key] = opts.uniforms![key];
  }

  return new ShaderMaterial({
    vertexShader: `${LIT_VERTEX_PARS}${opts.vertexPars ?? ''}
void main() {
	vec3 pos = position;
	vec3 nrm = normal;
${opts.vertexMain ?? ''}
${LIT_VERTEX_TAIL}}
`,
    fragmentShader: `${LIT_FRAGMENT_PARS}${opts.fragmentPars ?? ''}
${opts.extraLight ? `vec3 extraLight( vec3 N, vec3 V, Surf s ) {\n${opts.extraLight}\n}\n` : ''}
${bumpDecl}Surf surface( vec3 N, vec3 V ) {
${opts.surface}
}
${LIT_FRAGMENT_MAIN(bumpMain)}
`,
    uniforms: merged,
    defines,
    lights: true,
    side: opts.side ?? FrontSide,
    alphaToCoverage: opts.alphaToCoverage ?? false,
    transparent: opts.transparent ?? false,
    depthWrite: opts.depthWrite ?? true,
  });
}

/** sRGB 十六进制颜色 → 线性空间的 Color（交给 ColorManagement 换算）。 */
export function rgb(hex: string): Color {
  return new Color(hex);
}
