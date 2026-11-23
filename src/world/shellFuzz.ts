import {
  DoubleSide,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  type BufferGeometry,
  type IUniform,
  type ShaderMaterial,
} from 'three';
import { HAZE_GLSL, makeHazeUniforms } from './haze';

/** 没开大气透视时共用的一组雾 uniform（长度 0 = 关闭，画面逐位不变）。 */
const NO_HAZE = makeHazeUniforms();
import { makeLitMaterial, rgb, type LightingUniforms } from '../glsl/lit';
import { NOISE_GLSL } from '../glsl/noise';
import { SWAY_GLSL } from './branchSway';

/**
 * 轻量的多壳层绒垫（alphaToCoverage）：一张贴在树皮上的底面网格叠几层壳，每层在片元里用噪声裁掉一部分，裁出来的就是
 * 一根根 / 一片片的苔藓和地衣。比躯干绒毛轻得多（层数少、长度短、没有蒙皮和抚摸），用来给老树皮和分叉窝加一层
 * 立体冬苔藓与灰绿叶状地衣。底面网格带：aLen（这一点的长度系数，贴边和抓握区减薄到 0）、aFlow（倒伏方向）、aSway（随枝弯曲）。
 */
const SHELL_PARS = /* glsl */ `
${SWAY_GLSL}
${NOISE_GLSL}
attribute float aLen;
attribute vec3 aFlow;
attribute float aLayer;
uniform float uLayers;
uniform float uLen;
uniform float uSeed;
varying float vT;
varying float vLen;
varying vec3 vObj;
`;

const SHELL_MAIN = /* glsl */ `
	float t = aLayer / max( uLayers - 1.0, 1.0 );
	vT = t;
	vLen = aLen;
	vObj = position;
`;

/** 把底面网格叠成 layers 层壳（实例化，一次绘制）。 */
export function shellStack(base: BufferGeometry, layers: number, material: ShaderMaterial): Mesh<InstancedBufferGeometry, ShaderMaterial> {
  const g = new InstancedBufferGeometry();
  g.index = base.index;
  for (const [name, attr] of Object.entries(base.attributes)) g.setAttribute(name, attr);
  const a = new Float32Array(layers);
  for (let i = 0; i < layers; i++) a[i] = i;
  g.setAttribute('aLayer', new InstancedBufferAttribute(a, 1));
  g.instanceCount = layers;
  if (base.boundingSphere) g.boundingSphere = base.boundingSphere.clone();
  const mesh = new Mesh(g, material);
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * 冬苔藓：贴在雪线边缘和分叉窝里的深橄榄暗绿小绒团。毛根立起来撑住厚度、中后段顺着枝面往外倒；
 * 底面网格的 aLen 已按低频岛状遮罩打碎成几簇断续错落的小团，这里再按静止坐标的噪声裁成一根根细丝。
 */
export function makeMossMaterial(lighting: LightingUniforms, layers: number, len: number, sway: Record<string, IUniform>, seed: number, haze: Record<string, IUniform> = NO_HAZE, scale = 1): ShaderMaterial {
  return makeLitMaterial({
    lighting,
    side: DoubleSide,
    alphaToCoverage: true,
    uniforms: {
      ...sway,
      ...haze,
      uLayers: { value: layers },
      uLen: { value: len },
      uSeed: { value: seed },
      // 噪声采样尺度的倒数：细枝 1；大树主干远看用 0.25（否则每根毛都是亚像素噪点）
      uMossScale: { value: scale },
      uMossRoot: { value: rgb('#18200f') },
      uMossTip: { value: rgb('#465424') },
      uMossDry: { value: rgb('#665b33') },
    },
    vertexPars: `${SHELL_PARS}\nuniform float uMossScale;\n`,
    vertexMain: /* glsl */ `
${SHELL_MAIN}
	float h = uLen * aLen * ( 0.5 + 0.9 * ( snoise( position * ( 11.0 * uMossScale ) + uSeed ) * 0.5 + 0.5 ) );
	float lean = t * t;
	pos += nrm * ( h * t * ( 1.0 - 0.3 * lean ) ) + aFlow * ( h * 0.6 * lean );
	// 毛越靠外越朝着生长方向受光（苔藓丛的顶面亮、根部暗）
	nrm = normalize( nrm + aFlow * ( 0.8 * t ) );
	pos = swayBend( pos );
`,
    fragmentPars: /* glsl */ `
uniform vec3 uMossRoot;
uniform vec3 uMossTip;
uniform vec3 uMossDry;
uniform float uMossScale;
varying float vT;
varying float vLen;
varying vec3 vObj;
${HAZE_GLSL}
`,
    surface: /* glsl */ `
	// 噪声按底面的静止坐标采样，裁出一根根细丝：毛尖阈值高，只有最密的丝长到外层；底层也被裁开，不成一块实心板
	vec3 q = vObj * ( 110.0 * uMossScale );
	float d = fbm3( q ) * 0.65 + ( snoise( q * 2.6 + 7.0 ) * 0.5 + 0.5 ) * 0.35;
	float thr = mix( 0.22, 0.6, pow( vT, 0.8 ) );
	float aa = fwidth( d ) + 1e-4;
	float alpha = clamp( ( d - thr ) / aa + 0.5, 0.0, 1.0 );
	// 长度系数被减薄的地方（贴边、抓握区、岛状遮罩的缝）不长毛；毛尖淡出
	alpha *= smoothstep( 0.03, 0.3, vLen );
	alpha *= 1.0 - smoothstep( 0.75, 1.0, vT ) * 0.6;
	// 根暗尖亮；一丛一丛里有的偏黄绿、有的偏枯黄褐
	float strand = snoise( q * 0.12 ) * 0.5 + 0.5;
	vec3 tip = mix( uMossTip, uMossDry, smoothstep( 0.55, 0.9, strand ) * 0.5 );
	Surf s;
	s.albedo = mix( uMossRoot, tip, pow( vT, 1.1 ) * ( 0.5 + 0.5 * ( snoise( q * 0.4 ) * 0.5 + 0.5 ) ) );
	s.ao = mix( 0.4, 1.0, pow( vT, 0.6 ) );
	s.wrap = 0.75;
	s.specTint = vec3( 1.0 );
	s.gloss = 0.25;
	s.specAmt = 0.03;
	s.alpha = alpha;
	return s;
`,
    extraLight: /* glsl */ `
	float back = pow( max( dot( -V, uSunDir ), 0.0 ), 2.5 );
	return hazeComposite( N, V, s, uSunColor * back * 0.22 * vT * mix( vec3( 0.6, 0.8, 0.2 ), vec3( 1.0, 0.95, 0.45 ), vT ) * sunShadow() );
`,
  });
}

/**
 * 灰绿叶状地衣：片元里用双尺度域扭曲（domain-warped）的 fbm3 裁出大小不一、连片的叶状体——边缘一圈自然圆裂片、
 * 中间留出深色树皮缝隙；顶点着色器算同一个场，叶状体边缘往上翘（壳层之间只隔一点点厚度）。
 */
export function makeLichenMaterial(lighting: LightingUniforms, layers: number, sway: Record<string, IUniform>, haze: Record<string, IUniform> = NO_HAZE, scale = 1): ShaderMaterial {
  return makeLitMaterial({
    lighting,
    side: DoubleSide,
    alphaToCoverage: true,
    uniforms: {
      ...sway,
      ...haze,
      uLayers: { value: layers },
      uLen: { value: 0.028 },
      uSeed: { value: 0 },
      // 叶状体场的采样尺度的倒数：细枝 1；大树主干远看用 0.25（叶状体放大到几厘米，粗网格也解析得出）
      uLichenScale: { value: scale },
      uLichenCol: { value: rgb('#76836e') },
      uLichenRim: { value: rgb('#bac0b0') },
    },
    vertexPars: `${SHELL_PARS}\nuniform float uLichenScale;\n`,
    vertexMain: /* glsl */ `
${SHELL_MAIN}
	// 叶状体的场（和片元里同一个公式）：只在叶状体范围内有厚度，越靠边越翘起
	vec3 q = vObj * ( 16.0 * uLichenScale );
	vec3 w = vec3( fbm3( q * 0.6 + 3.1 ), fbm3( q * 0.6 + 7.7 ), fbm3( q * 0.6 + 11.3 ) );
	float dv = fbm3( q + w * 2.2 ) * 0.6 + fbm3( q * 4.0 + w * 1.0 ) * 0.4;
	float inside = smoothstep( 0.53, 0.62, dv );
	float rim = 1.0 - smoothstep( 0.0, 0.05, dv - 0.53 );
	float lift = uLen * aLen * inside * ( 0.2 + 0.8 * rim );
	pos += nrm * ( lift * t );
	pos = swayBend( pos );
`,
    fragmentPars: /* glsl */ `
uniform vec3 uLichenCol;
uniform vec3 uLichenRim;
uniform float uLichenScale;
varying float vT;
varying float vLen;
varying vec3 vObj;
${HAZE_GLSL}
`,
    surface: /* glsl */ `
	// 双尺度域扭曲：大尺度把群落揉成不规则的大片，小尺度在边缘上啃出圆裂片；阈值附近一圈是翘起的粉霜色边
	vec3 q = vObj * ( 16.0 * uLichenScale );
	vec3 w = vec3( fbm3( q * 0.6 + 3.1 ), fbm3( q * 0.6 + 7.7 ), fbm3( q * 0.6 + 11.3 ) );
	float d = fbm3( q + w * 2.2 ) * 0.6 + fbm3( q * 4.0 + w * 1.0 ) * 0.4;
	// fbm3 的值域实际集中在 [0.15, 0.85]（均值 0.5），阈值必须落在均值之上：以前写 0.12 → alpha 恒为 1，整块成了实心板
	float aa = fwidth( d ) + 1e-4;
	float above = d - 0.53;
	float alpha = smoothstep( -aa, aa, above );
	alpha *= smoothstep( 0.02, 0.25, vLen ) * ( 0.85 + 0.15 * vT );
	// 三层粉霜：边缘一圈浅色的生长缘 → 往里略偏褐灰的老叶状体 → 中央再撒一层细密的粉霜颗粒团
	float rim = 1.0 - smoothstep( 0.0, 0.05, above );
	float heart = smoothstep( 0.07, 0.14, above );
	float grain = snoise( vObj * 160.0 ) * 0.5 + 0.5;
	float bloom = smoothstep( 0.5, 0.8, fbm3( vObj * 55.0 + 9.0 ) ) * heart;
	vec3 body = mix( uLichenCol, uLichenCol * vec3( 0.8, 0.72, 0.62 ), heart );
	Surf s;
	s.albedo = mix( body, uLichenRim, max( rim * 0.55, bloom * 0.3 ) ) * ( 0.9 + 0.2 * grain );
	s.ao = mix( 1.0, 0.85, vT );
	s.wrap = 0.5;
	s.specTint = vec3( 1.0 );
	s.gloss = 0.3;
	s.specAmt = 0.08;
	s.alpha = alpha;
	return s;
`,
    extraLight: /* glsl */ `
	return hazeComposite( N, V, s, vec3( 0.0 ) );
`,
  });
}
