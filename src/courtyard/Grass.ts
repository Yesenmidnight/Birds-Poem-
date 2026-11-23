/**
 * 院外积雪枯草地（微距质感）：一次 InstancedBufferGeometry 画 2.2 万根枯草叶，另一次画狗尾草穗 + 墙角枯苇。
 * 位置 / 朝向 / 高度 / 色调全是实例属性，弯曲、风摇、小鸟让位（uBirdPos）都在顶点着色器里算，CPU 每帧只推 uTime。
 * 草根读 snowHeight（= 碰撞体同一张高度场）扎在雪面以下 2 cm；密度按 pcg/courtyard.ts 的 grassDensity 拒绝采样。
 * 颜色从埋雪基部的冷霜白渐变到梢端的浅麦秆黄 / 银灰白；逆光透射金边；复用 three 的阴影贴图（洋房影子里的草不假亮）。
 */
import { BufferAttribute, BufferGeometry, DoubleSide, Group, InstancedBufferAttribute, InstancedBufferGeometry, Mesh, ShaderMaterial, UniformsLib, UniformsUtils, type IUniform } from 'three';
import { GRASS, REED_CLUMPS, YARD, grassDensity, snowAt } from '../pcg/courtyard';
import { makeRng } from '../util/math';
import type { LightingUniforms } from '../glsl/lit';
import { NOISE_GLSL } from '../glsl/noise';

export interface GrassBuild {
  group: Group;
  uniforms: Record<string, IUniform>;
  /** 设小鸟世界坐标（周围枯草让位）。 */
  setBirdPos(x: number, y: number, z: number): void;
}

/** 单位草叶：y 0..1，x ±0.5 逐段收窄到尖。 */
function bladeGeometry(): BufferGeometry {
  const rows = [0, 0.5, 1];
  const widths = [1, 0.62, 0.03];
  const pos: number[] = [];
  const head: number[] = [];
  const uv: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    pos.push(-0.5 * widths[i], rows[i], 0, 0.5 * widths[i], rows[i], 0);
    head.push(0, 0);
    uv.push(0, rows[i], 1, rows[i]);
  }
  const idx: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    const a = (i - 1) * 2;
    idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('aHead', new BufferAttribute(new Float32Array(head), 1));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
  g.setIndex(idx);
  return g;
}

/** 草穗 / 芦苇：细茎（y 0..0.78）+ 顶端 3 片交叉的毛穗面片（y 0.78..1）。 */
function headGeometry(): BufferGeometry {
  const pos: number[] = [];
  const head: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const stemW = 0.06;
  for (const t of [0, 0.78]) {
    pos.push(-stemW / 2, t, 0, stemW / 2, t, 0);
    head.push(0, 0);
    uv.push(0, t, 1, t);
  }
  idx.push(0, 2, 1, 1, 2, 3);
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI;
    const c = Math.cos(a) * 0.5;
    const s = Math.sin(a) * 0.5;
    const base = pos.length / 3;
    pos.push(-c, 0.78, -s, c, 0.78, s, c, 1, s, -c, 1, -s);
    head.push(1, 1, 1, 1);
    uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('aHead', new BufferAttribute(new Float32Array(head), 1));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
  g.setIndex(idx);
  return g;
}

const VERT = /* glsl */ `
attribute vec3 aRoot;
attribute vec4 aDir;
attribute vec4 aParams;
attribute vec3 aColor;
attribute float aHead;
uniform float uTime;
uniform vec3 uBirdPos;
uniform float uBirdPush;
varying vec3 vWorldPos;
varying vec3 vWorldN;
varying float vT;
varying vec3 vCol;
varying float vHead;
varying vec2 vUv;
#include <common>
#include <shadowmap_pars_vertex>
void main() {
	float h = aParams.x;
	// 草穗段（t > 0.78）按实例的穗长重新映射高度，芦苇 / 狗尾草共用一份几何
	float t = position.y;
	if ( t > 0.78 && aDir.w > 0.0 ) t = 0.78 + ( t - 0.78 ) * ( aDir.w / ( 0.22 * h ) );
	float w = aParams.y;
	float bend = aParams.z;
	vec3 p = vec3( position.x * w, t * h, 0.0 );
	// 沿高度二次方弯曲（草叶自重的弧）
	float a = bend * t * t;
	p.z += sin( a ) * h * 0.55 * t;
	p.y *= cos( a * 0.55 );
	// 风：两个频率叠加，相位按实例 + 位置错开
	float ph = aDir.z * 6.2831853;
	float sway = sin( uTime * 1.3 + ph + aRoot.x * 0.03 ) * 0.085 + sin( uTime * 2.9 + ph * 1.7 + aRoot.z * 0.05 ) * 0.03;
	// 小鸟让位：uBirdPush 半径内向外压弯、压矮
	vec2 d = aRoot.xz - uBirdPos.xz;
	float r = length( d );
	float push = smoothstep( uBirdPush, uBirdPush * 0.1, r ) * ( 1.0 - smoothstep( 25.0, 45.0, abs( aRoot.y + h * 0.5 - uBirdPos.y ) ) );
	vec2 pd = r > 0.001 ? d / r : vec2( 1.0, 0.0 );
	float c = cos( aDir.x );
	float s = sin( aDir.x );
	vec3 q = vec3( p.x * c - p.z * s, p.y, p.x * s + p.z * c );
	// 倾斜：整根往外倒一点
	q.xz += vec2( c, s ) * t * h * aParams.w;
	q.xz += pd * push * 7.5 * t;
	q.y *= 1.0 - 0.4 * push * t;
	q.xz += vec2( 0.8, 0.6 ) * sway * t * t * h;
	vec3 wp = aRoot + q;
	vWorldPos = wp;
	vWorldN = normalize( vec3( s, 0.35, c ) );
	vT = t;
	vCol = aColor;
	vHead = aHead;
	vUv = uv;
	vec4 worldPosition = vec4( wp, 1.0 );
	vec4 mvPosition = viewMatrix * worldPosition;
	gl_Position = projectionMatrix * mvPosition;
	vec3 transformedNormal = normalize( normalMatrix * vec3( 0.0, 1.0, 0.0 ) );
	#include <shadowmap_vertex>
}
`;

const FRAG = /* glsl */ `
${NOISE_GLSL}
#include <common>
#include <packing>
#include <lights_pars_begin>
#include <shadowmap_pars_fragment>
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
varying vec3 vWorldPos;
varying vec3 vWorldN;
varying float vT;
varying vec3 vCol;
varying float vHead;
varying vec2 vUv;
float sunShadow() {
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
	DirectionalLightShadow s = directionalLightShadows[ 0 ];
	return getShadow( directionalShadowMap[ 0 ], s.shadowMapSize, s.shadowIntensity, s.shadowBias, s.shadowRadius, vDirectionalShadowCoord[ 0 ] );
#else
	return 1.0;
#endif
}
void main() {
	// 离镜头太近的草叶让位（第三人称在草地上蹦跳时，贴地的机位会整帧糊在一片草叶上）：3 cm 内整片丢弃、3~8 cm 抖动渐隐（材质不透明，不走 alpha）
	float camD = distance( cameraPosition, vWorldPos );
	float nearK = smoothstep( 3.0, 8.0, camD );
	if ( nearK < 1.0 && fract( sin( dot( gl_FragCoord.xy, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ) > nearK ) discard;
	if ( vHead > 0.5 ) {
		// 毛穗：椭圆软边 + 细碎缺口感
		float ax = abs( vUv.x - 0.5 ) * 2.0;
		float ay = abs( vUv.y - 0.5 ) * 2.0;
		float shape = ( 1.0 - pow( ax, 1.6 ) ) * ( 1.0 - pow( ay, 3.0 ) );
		float n = snoise( vec3( vUv * vec2( 40.0, 18.0 ), vCol.r * 31.0 ) ) * 0.5 + 0.5;
		if ( shape * ( 0.6 + 0.6 * n ) < 0.42 ) discard;
	}
	vec3 N = normalize( vWorldN );
	if ( ! gl_FrontFacing ) N = - N;
	vec3 V = normalize( cameraPosition - vWorldPos );
	float t = vT;
	// 埋雪基部冷霜白 → 梢端浅麦秆黄 / 银灰白
	vec3 base = vec3( 0.86, 0.9, 0.96 );
	vec3 alb = mix( base, vCol, smoothstep( 0.04, 0.5, t ) );
	if ( vHead > 0.5 ) alb = vCol * 1.05;
	float sh = sunShadow();
	float ndl = dot( N, uSunDir );
	float diff = clamp( ( ndl + 0.65 ) / 1.65, 0.0, 1.0 );
	vec3 hemi = mix( uGroundColor, uSkyColor, 0.5 ) * vec3( 1.0, 0.96, 0.88 );
	vec3 col = alb * ( uSunColor * diff * sh + hemi * 0.95 );
	// 逆光透射：草叶半透，逆光时透出金边，梢端更强
	float back = pow( max( dot( -V, uSunDir ), 0.0 ), 3.0 );
	col += alb * uSunColor * back * 0.95 * sh * ( 0.25 + 0.75 * t );
	gl_FragColor = vec4( col, 1.0 );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}
`;

function grassMaterial(lighting: LightingUniforms, uniforms: Record<string, IUniform>): ShaderMaterial {
  const merged = UniformsUtils.merge([
    UniformsLib.lights,
    {
      uTime: uniforms.uTime,
      uBirdPos: uniforms.uBirdPos,
      uBirdPush: uniforms.uBirdPush,
      uSunDir: lighting.uSunDir,
      uSunColor: lighting.uSunColor,
      uSkyColor: lighting.uSkyColor,
      uGroundColor: lighting.uGroundColor,
    },
  ]);
  merged.uTime = uniforms.uTime;
  merged.uBirdPos = uniforms.uBirdPos;
  merged.uBirdPush = uniforms.uBirdPush;
  merged.uSunDir = lighting.uSunDir;
  merged.uSunColor = lighting.uSunColor;
  merged.uSkyColor = lighting.uSkyColor;
  merged.uGroundColor = lighting.uGroundColor;
  return new ShaderMaterial({ uniforms: merged, lights: true, side: DoubleSide, vertexShader: VERT, fragmentShader: FRAG });
}

/** 色调：浅麦秆黄 / 银灰白 / 暖枯黄，带确定性变化。 */
function strawTint(rng: () => number, out: number[], k: number): void {
  const pick = rng();
  let r: number;
  let g: number;
  let b: number;
  if (pick < 0.45) {
    r = 0.8 + rng() * 0.1;
    g = 0.66 + rng() * 0.1;
    b = 0.4 + rng() * 0.1;
  } else if (pick < 0.8) {
    r = 0.82 + rng() * 0.08;
    g = 0.8 + rng() * 0.08;
    b = 0.74 + rng() * 0.08;
  } else {
    r = 0.76 + rng() * 0.1;
    g = 0.62 + rng() * 0.1;
    b = 0.4 + rng() * 0.1;
  }
  out[k] = r;
  out[k + 1] = g;
  out[k + 2] = b;
}

/** 实例属性集合。 */
interface Instances {
  root: number[];
  dir: number[];
  params: number[];
  color: number[];
}

function instanced(base: BufferGeometry, inst: Instances, mat: ShaderMaterial, name: string): Mesh {
  const count = inst.root.length / 3;
  const geo = new InstancedBufferGeometry();
  geo.index = base.index;
  geo.setAttribute('position', base.attributes.position);
  geo.setAttribute('uv', base.attributes.uv);
  geo.setAttribute('aHead', base.attributes.aHead);
  geo.setAttribute('aRoot', new InstancedBufferAttribute(new Float32Array(inst.root), 3));
  geo.setAttribute('aDir', new InstancedBufferAttribute(new Float32Array(inst.dir), 4));
  geo.setAttribute('aParams', new InstancedBufferAttribute(new Float32Array(inst.params), 4));
  geo.setAttribute('aColor', new InstancedBufferAttribute(new Float32Array(inst.color), 3));
  geo.instanceCount = count;
  const mesh = new Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.name = `${name}:${count}`;
  return mesh;
}

export function buildGrass(lighting: LightingUniforms): GrassBuild {
  const group = new Group();
  group.name = 'grass';
  const rng = makeRng(GRASS.seed);
  const uniforms: Record<string, IUniform> = {
    uTime: { value: 0 },
    uBirdPos: { value: [0, -9999, 0] },
    uBirdPush: { value: 12 },
  };
  const mat = grassMaterial(lighting, uniforms);

  // ── 草叶：拒绝采样 ──
  const blades: Instances = { root: [], dir: [], params: [], color: [] };
  let tries = 0;
  while (blades.root.length / 3 < GRASS.count && tries < GRASS.count * 60) {
    tries++;
    const x = YARD.x0 + 20 + rng() * (YARD.x1 - YARD.x0 - 40);
    const z = YARD.z0 + 20 + rng() * (YARD.z1 - YARD.z0 - 40);
    const d = grassDensity(x, z);
    if (rng() > d) continue;
    blades.root.push(x, snowAt(x, z) - 2, z);
    blades.dir.push(rng() * Math.PI * 2, 0, rng(), 0);
    const h = GRASS.hMin + (GRASS.hMax - GRASS.hMin) * Math.pow(rng(), 1.4) * (0.65 + 0.7 * d);
    blades.params.push(h, 1.2 + rng() * 1.2, (0.5 + rng() * 0.9) * (rng() < 0.15 ? -1 : 1), 0.08 + rng() * 0.25);
    strawTint(rng, blades.color, blades.color.length);
  }
  group.add(instanced(bladeGeometry(), blades, mat, 'grass-blades'));

  // ── 狗尾草穗：和草叶同一套密度，但更高更稀 ──
  const heads: Instances = { root: [], dir: [], params: [], color: [] };
  tries = 0;
  while (heads.root.length / 3 < GRASS.heads && tries < GRASS.heads * 60) {
    tries++;
    const x = YARD.x0 + 20 + rng() * (YARD.x1 - YARD.x0 - 40);
    const z = YARD.z0 + 20 + rng() * (YARD.z1 - YARD.z0 - 40);
    const d = grassDensity(x, z);
    if (rng() > d * 0.8) continue;
    heads.root.push(x, snowAt(x, z) - 2, z);
    heads.dir.push(rng() * Math.PI * 2, 0, rng(), 3.5 + rng() * 2.5);
    const h = GRASS.headHMin + (GRASS.headHMax - GRASS.headHMin) * Math.pow(rng(), 1.2) * (0.7 + 0.6 * d);
    // 穗宽 1.1~1.6 cm，穗长 = 宽 × 5.5（几何里穗段高 0.22 × h 太长，这里用 bend 压低）
    heads.params.push(h, 1.1 + rng() * 0.5, 0.35 + rng() * 0.4, 0.12 + rng() * 0.2);
    const pick = rng();
    if (pick < 0.6) heads.color.push(0.86 + rng() * 0.06, 0.78 + rng() * 0.06, 0.6 + rng() * 0.08);
    else heads.color.push(0.84 + rng() * 0.06, 0.76 + rng() * 0.06, 0.72 + rng() * 0.08);
  }
  group.add(instanced(headGeometry(), heads, mat, 'grass-heads'));

  // ── 墙角枯苇：成丛，高 150~200 ──
  const reeds: Instances = { root: [], dir: [], params: [], color: [] };
  for (const c of REED_CLUMPS) {
    for (let i = 0; i < c.count; i++) {
      const a = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * c.r;
      const x = c.x + Math.cos(a) * r;
      const z = c.z + Math.sin(a) * r;
      reeds.root.push(x, snowAt(x, z) - 2, z);
      reeds.dir.push(rng() * Math.PI * 2, 0, rng(), 18 + rng() * 12);
      reeds.params.push(150 + rng() * 55, 2.6 + rng() * 1.4, 0.25 + rng() * 0.3, 0.06 + rng() * 0.12);
      reeds.color.push(0.8 + rng() * 0.08, 0.7 + rng() * 0.08, 0.56 + rng() * 0.08);
    }
  }
  group.add(instanced(headGeometry(), reeds, mat, 'grass-reeds'));

  const bird = uniforms.uBirdPos.value as number[];
  return {
    group,
    uniforms,
    setBirdPos: (x, y, z) => {
      bird[0] = x;
      bird[1] = y;
      bird[2] = z;
    },
  };
}
