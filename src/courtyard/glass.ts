/**
 * 阳光房玻璃：菲涅尔微反射（正对时通透、掠射时反天光）+ 斜射太阳高光 + 边角冰霜结晶 + 内壁暖雾 / 冷凝水痕。
 * 透明、双面、不写深度；所有玻璃合成一个网格一次绘制（三角形内部不排序，薄玻璃看不出）。
 * 每块玻璃带常量属性：aSize（玻璃尺寸 cm，算离边的真实距离）、aPane（每块的随机数）、aFace（0 墙玻璃 / 1 屋面玻璃）。
 */
import { Color, DoubleSide, ShaderMaterial, type IUniform } from 'three';
import { NOISE_GLSL } from '../glsl/noise';
import type { LightingUniforms } from '../glsl/lit';

export function greenhouseGlassMaterial(lighting: LightingUniforms, opts: { lit?: number } = {}): ShaderMaterial {
  const uniforms: Record<string, IUniform> = {
    uSunDir: lighting.uSunDir,
    uSunColor: lighting.uSunColor,
    uSkyColor: lighting.uSkyColor,
    uGroundColor: lighting.uGroundColor,
    uZenith: { value: new Color(0.3, 0.42, 0.62) },
    uHorizon: { value: new Color(0.62, 0.68, 0.76) },
    uWarm: { value: new Color(1.0, 0.72, 0.42) },
    uTime: { value: 0 },
  };
  return new ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    vertexShader: /* glsl */ `
attribute vec2 aSize;
attribute float aPane;
attribute float aFace;
varying vec3 vWorldPos;
varying vec3 vWorldN;
varying vec2 vUv;
varying vec2 vSize;
varying float vPane;
varying float vFace;
void main() {
	vec4 wp = modelMatrix * vec4( position, 1.0 );
	vWorldPos = wp.xyz;
	vWorldN = normalize( mat3( modelMatrix ) * normal );
	vUv = uv;
	vSize = aSize;
	vPane = aPane;
	vFace = aFace;
	gl_Position = projectionMatrix * viewMatrix * wp;
}
`,
    fragmentShader: /* glsl */ `
${NOISE_GLSL}
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uWarm;
uniform float uTime;
varying vec3 vWorldPos;
varying vec3 vWorldN;
varying vec2 vUv;
varying vec2 vSize;
varying float vPane;
varying float vFace;

void main() {
	vec3 N = normalize( vWorldN );
	if ( ! gl_FrontFacing ) N = - N;
	vec3 V = normalize( cameraPosition - vWorldPos );
	float ndv = clamp( dot( N, V ), 0.0, 1.0 );
	// 菲涅尔：正对 4% 反射，掠射接近全反射
	float fres = 0.04 + 0.96 * pow( 1.0 - ndv, 5.0 );
	// 反射的是天光：按反射向量的仰角在天顶 / 地平线之间取色
	vec3 R = reflect( -V, N );
	vec3 refl = mix( uHorizon, uZenith, pow( clamp( R.y, 0.0, 1.0 ), 0.6 ) );
	if ( R.y < 0.0 ) refl = mix( uHorizon, uGroundColor * 0.9, clamp( -R.y * 3.0, 0.0, 1.0 ) );
	// 斜射太阳的高光（一道细亮的光带）
	vec3 H = normalize( uSunDir + V );
	float spec = pow( max( dot( N, H ), 0.0 ), 900.0 ) * 2.6 + pow( max( dot( N, H ), 0.0 ), 60.0 ) * 0.18;

	// 离边角的真实距离（cm）：霜结晶从边角往里长，越靠角落越厚
	vec2 e = min( vUv, 1.0 - vUv ) * vSize;
	float edge = min( e.x, e.y );
	float corner = sqrt( e.x * e.y );
	float n1 = fbm3( vec3( vUv * vSize * 1.1, vPane * 7.0 ) );
	float n2 = snoise( vec3( vUv * vSize * 1.3, vPane * 3.0 + 11.0 ) ) * 0.5 + 0.5;
	float frost = ( 1.0 - smoothstep( 0.0, 5.0 + 7.0 * n1, edge ) ) * ( 0.3 + 0.45 * n1 );
	frost += ( 1.0 - smoothstep( 0.0, 14.0 + 16.0 * n1, corner ) ) * 0.3 * n2 * n1;
	// 枝状冰晶：细碎的针状结晶只在霜层里显现——接进霜的厚度和亮度（以前算了没用上）
	float needles = smoothstep( 0.6, 0.9, snoise( vec3( vUv * vSize * 3.2, vPane ) ) * 0.5 + 0.5 ) * frost;
	// 屋面玻璃上沿（靠脊）挂一条薄霜 / 薄雪边
	if ( vFace > 0.5 ) frost += ( 1.0 - smoothstep( 0.0, 6.0, e.y ) ) * step( vUv.y, 0.5 ) * 0.35 * n2;
	frost = clamp( frost + needles * 0.35, 0.0, 0.95 );
	// 内壁冷凝：竖向水流痕 + 一层极淡的暖雾（温室内外温差）
	float streak = fbm3( vec3( vWorldPos.x * 0.9, vWorldPos.y * 0.12, vWorldPos.z * 0.9 + vPane ) );
	float mist = 0.035 + 0.05 * smoothstep( 0.35, 0.75, streak );
	vec3 col = refl * fres + uSunColor * spec;
	col += uWarm * mist * 1.6 * ( 0.8 + 0.4 * n1 );
	col = mix( col, vec3( 0.93, 0.96, 1.0 ) * ( 0.7 + 0.3 * n2 + 0.3 * needles ) + uSkyColor * 0.25, frost );
	float alpha = clamp( 0.08 + fres * 0.72 + frost * 0.6 + mist, 0.0, 0.94 );
	gl_FragColor = vec4( col, alpha * ${ (opts.lit ?? 1).toFixed(2) } );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}
`,
  });
}

/** 每块玻璃的随机数（确定性）。 */
export function paneHash(i: number): number {
  const s = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
}

