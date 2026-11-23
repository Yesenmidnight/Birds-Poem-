/**
 * 温室里的春日草坪与花境（微距质感，全部实例化 + 顶点着色器，零外部贴图）：
 *   草——4 段渐窄的弧形叶（5 排顶点），簇生（每簇 6~10 根向四周放射拱出弯垂）；多尺度噪声划分修剪较短的开阔草坪
 *       （6~11 cm）与蓬松高挑的长草区（14~26 cm，混生狗尾草穗）；根部环境光遮蔽压到深墨绿、中段森林绿、
 *       只有叶尖在逆光下透出金黄嫩绿的次表面；
 *   三叶草——三片心形小叶组成的水平叶簇（真的三片，各带一道浅色水痕）；
 *   野花——蒲公英（金黄舌状花盘）/ 蒲公英白绒球（半透明逆光绒球）/ 微拱花瓣的小雏菊 / 薰衣草紫色花穗，共用一套"茎 + 花头"几何，
 *       实例类型决定留哪几个部件；
 *   常绿小灌木球——密集朝外的小叶簇拼成半球，内膛压暗；宽叶蕨类——放射的羽状叶；主海棠树下散落一层粉白落瓣。
 * 草簇密度按 springGrassDensity 拒绝采样，再按离小径的远近加权（游客沿小径走，近处 2 倍密）；路缘砖花境沿小径两侧和矮墙内沿布置。
 * 全部接入 Airflow.ts 的统一气流场（微风 / 翼下气柱 / 尾流涟漪 / 近场风球）。
 */
import { BufferAttribute, BufferGeometry, DoubleSide, Group, InstancedBufferAttribute, InstancedBufferGeometry, Mesh, ShaderMaterial, UniformsLib, UniformsUtils, type IUniform } from 'three';
import { GRAVEL_PATHS, PATH_HALF, SPRING, SPRING_TREES, samplePath, springGrassDensity } from '../pcg/courtyard';
import type { Heightfield } from '../sim/heightfield';
import { makeRng, noise3 } from '../util/math';
import type { LightingUniforms } from '../glsl/lit';
import { NOISE_GLSL } from '../glsl/noise';
import { AIRFLOW_GLSL, type AirflowField } from './Airflow';

type V3 = [number, number, number];

/** tufts = 草簇数（每簇 6~10 根，共约 6 万根叶）；lavender = 小径之外随机补的薰衣草丛数。 */
export const SPRING_GRASS = { tufts: 8000, seed: 71, clover: 1300, flowers: 2000, clocks: 380, lavender: 60, shrubs: 18, ferns: 56, petals: 2600 } as const;

// ────────────────────────────── 几何 ──────────────────────────────

/**
 * 单位草叶：4 段 5 排，y 0..1，x 按行渐窄（基部 ±0.5 → 尖 ±0.075）。
 * withHead：狗尾草——叶尖之上两片交叉的竖片（y 1..1.14，宽 ±0.28），单独一张网格，普通草叶不带（省 8 个顶点 / 4 个退化三角形）。
 */
function bladeGeometry(withHead: boolean): BufferGeometry {
  const rows = [0, 0.25, 0.5, 0.75, 1];
  const pos: number[] = [];
  const uv: number[] = [];
  for (const t of rows) {
    const w = 0.5 * (1 - 0.85 * Math.pow(t, 1.2));
    pos.push(-w, t, 0, w, t, 0);
    uv.push(0, t, 1, t);
  }
  const idx: number[] = [];
  for (let r = 0; r < rows.length - 1; r++) {
    const a = r * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  if (withHead) {
    for (const a of [0, Math.PI / 3, (2 * Math.PI) / 3]) {
      const c = Math.cos(a) * 0.34;
      const s = Math.sin(a) * 0.34;
      const b = pos.length / 3;
      pos.push(-c, 1.0, -s, c, 1.0, s, c * 0.7, 1.16, s * 0.7, -c * 0.7, 1.16, -s * 0.7);
      uv.push(0, 0, 1, 0, 1, 1, 0, 1);
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
  g.setIndex(idx);
  return g;
}

/** 狗尾草穗所在的那两片竖片从叶尖 (y 1) 起：着色器里按 position.y / vT > 1.0 识别穗（必须是 GLSL 浮点字面量，JS 的 1.0 会印成整型 1）。 */
const HEAD_Y = '1.0';

/** 三叶草：一根短柄（0..0.45）顶上三片心形小叶各 5 个三角形，近水平、相隔 120°。uv：u 沿小叶 0..1、v 横向 −1..1。 */
function cloverGeometry(): BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  // 叶柄（细带，略前倾）
  pos.push(-0.03, 0, 0, 0.03, 0, 0, 0.03, 0.45, 0.05, -0.03, 0.45, 0.05);
  uv.push(0, 0, 1, 0, 1, 1, 0, 1);
  idx.push(0, 1, 2, 0, 2, 3);
  const top: V3 = [0, 0.45, 0.05];
  // 心形轮廓（从小叶基部出发绕一圈：两侧鼓、尖上带缺口）
  const rim: [number, number][] = [
    [0.2, 0.42],
    [0.7, 0.5],
    [0.95, 0.0],
    [0.7, -0.5],
    [0.2, -0.42],
  ];
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2 + 0.4;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const tilt = 0.22; // 小叶朝上抬 12°
    const c = pos.length / 3;
    pos.push(top[0], top[1], top[2]);
    uv.push(0, 0);
    for (const [u, v] of rim) {
      const L = 0.5;
      pos.push(top[0] + (ca * u - sa * v) * L, top[1] + u * tilt * L, top[2] + (sa * u + ca * v) * L);
      uv.push(u, v * 2);
    }
    for (let i = 0; i < rim.length - 1; i++) idx.push(c, c + 1 + i, c + 2 + i);
    idx.push(c, c + rim.length, c + 1);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
  g.setIndex(idx);
  return g;
}

/**
 * "茎 + 花头"家族（归一化）：aPart 0 茎（y 0..1）/ 1 水平花盘（两片交叉四边形，±1，略拱）/ 2 绒球（八面体，半径 1）/ 3 花穗（两片交叉竖片，y 0.62..1，宽 ±1）。
 * 实例的 aType 决定留哪几个部件：0 蒲公英花（茎 + 盘）/ 1 白绒球（茎 + 球）/ 2 雏菊（茎 + 盘）/ 3 薰衣草（茎只到 0.78 + 穗占 0.78..1）。
 */
function stemmyGeometry(): BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const part: number[] = [];
  const idx: number[] = [];
  for (const y of [0, 0.5, 1]) {
    pos.push(-0.012, y, 0, 0.012, y, 0);
    uv.push(0, y, 1, y);
    part.push(0, 0);
  }
  idx.push(0, 1, 2, 1, 3, 2, 2, 3, 4, 3, 5, 4);
  for (const a of [0, Math.PI / 2]) {
    const c = Math.cos(a);
    const s = Math.sin(a);
    const b = pos.length / 3;
    pos.push(-c, 1, -s, c, 1, s, s, 1.12, -c, -s, 1.12, c);
    uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    part.push(1, 1, 1, 1);
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  // 绒球：xy / yz / xz 三片交叉的单位四边形（中心 y 1.05），片元裁成带放射绒毛的圆
  for (const [U, W] of [[[1, 0, 0], [0, 1, 0]], [[0, 0, 1], [0, 1, 0]], [[1, 0, 0], [0, 0, 1]]] as [V3, V3][]) {
    const b = pos.length / 3;
    for (const [cu, cv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      pos.push(U[0] * cu + W[0] * cv, 1.05 + U[1] * cu + W[1] * cv, U[2] * cu + W[2] * cv);
      uv.push((cu + 1) / 2, (cv + 1) / 2);
      part.push(2);
    }
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  for (const a of [0, Math.PI / 2]) {
    const c = Math.cos(a);
    const s = Math.sin(a);
    const b = pos.length / 3;
    pos.push(-c, 0.78, -s, c, 0.78, s, c * 0.75, 1.0, s * 0.75, -c * 0.75, 1.0, -s * 0.75);
    uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    part.push(3, 3, 3, 3);
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
  g.setAttribute('aPart', new BufferAttribute(new Float32Array(part), 1));
  g.setIndex(idx);
  return g;
}

/** 常绿小灌木球：半球壳上密集朝外的小叶簇（四边形，叶形在片元里裁）+ 内膛一个压暗的实心穹顶。aW = 叶簇在球壳上的高度（−0.3..1），aPart 1 = 内膛。 */
function shrubGeometry(): BufferGeometry {
  const rng = makeRng(909);
  const pos: number[] = [];
  const uv: number[] = [];
  const aw: number[] = [];
  const part: number[] = [];
  const idx: number[] = [];
  const N = 64;
  for (let i = 0; i < N; i++) {
    // 余弦加权半球，再往下伸一点（球体的赤道以下还有一圈叶子）
    const y = Math.pow(rng(), 0.8) * 1.25 - 0.3;
    const a = rng() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const d: V3 = [Math.cos(a) * r, y, Math.sin(a) * r];
    // 叶簇的切面标架：法线 = d，切向随机
    const up: V3 = Math.abs(d[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    const t1: V3 = [up[1] * d[2] - up[2] * d[1], up[2] * d[0] - up[0] * d[2], up[0] * d[1] - up[1] * d[0]];
    const L1 = Math.hypot(...t1) || 1;
    const tt: V3 = [t1[0] / L1, t1[1] / L1, t1[2] / L1];
    const bt: V3 = [d[1] * tt[2] - d[2] * tt[1], d[2] * tt[0] - d[0] * tt[2], d[0] * tt[1] - d[1] * tt[0]];
    const rot = rng() * Math.PI * 2;
    const u1: V3 = [tt[0] * Math.cos(rot) + bt[0] * Math.sin(rot), tt[1] * Math.cos(rot) + bt[1] * Math.sin(rot), tt[2] * Math.cos(rot) + bt[2] * Math.sin(rot)];
    const u2: V3 = [d[1] * u1[2] - d[2] * u1[1], d[2] * u1[0] - d[0] * u1[2], d[0] * u1[1] - d[1] * u1[0]];
    const sz = 0.16 + rng() * 0.08;
    const b = pos.length / 3;
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      pos.push(d[0] + u1[0] * su * sz + u2[0] * sv * sz, d[1] + u1[1] * su * sz + u2[1] * sv * sz, d[2] + u1[2] * su * sz + u2[2] * sv * sz);
      uv.push((su + 1) / 2, (sv + 1) / 2);
      aw.push(y);
      part.push(0);
    }
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  // 内膛穹顶（8 段 × 2 环 + 顶点）：暗绿，从叶缝里透出来就是"内膛压暗"
  const core = (p: V3): number => {
    const i = pos.length / 3;
    pos.push(p[0], p[1], p[2]);
    uv.push(0.5, 0.5);
    aw.push(0);
    part.push(1);
    return i;
  };
  const ring0: number[] = [];
  const ring1: number[] = [];
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    ring0.push(core([Math.cos(a) * 0.82, -0.05, Math.sin(a) * 0.82]));
    ring1.push(core([Math.cos(a) * 0.5, 0.6, Math.sin(a) * 0.5]));
  }
  const topIdx = core([0, 0.85, 0]);
  for (let k = 0; k < 8; k++) {
    const n = (k + 1) % 8;
    idx.push(ring0[k], ring0[n], ring1[n], ring0[k], ring1[n], ring1[k]);
    idx.push(ring1[k], ring1[n], topIdx);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
  g.setAttribute('aW', new BufferAttribute(new Float32Array(aw), 1));
  g.setAttribute('aPart', new BufferAttribute(new Float32Array(part), 1));
  g.setIndex(idx);
  return g;
}

/** 宽叶蕨类：7 片羽状叶从根部放射，每片一条 4 段的弧形带（先仰 62° 再往外弯），宽度中间宽两头窄；叶形在片元里裁。 */
function fernGeometry(): BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const fronds = 7;
  for (let f = 0; f < fronds; f++) {
    const a = (f / fronds) * Math.PI * 2 + 0.3;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const rows = 5;
    const b = pos.length / 3;
    for (let r = 0; r < rows; r++) {
      const t = r / (rows - 1);
      // 弧：仰角从 62° 渐减到 10°
      const elev = (62 - 52 * t) * (Math.PI / 180);
      const dist = 0.25 + 0.75 * t;
      const w = 0.22 * Math.sin(Math.min(1, t * 1.15) * Math.PI) * (1 - 0.3 * t) + 0.02;
      const cxp = ca * dist * Math.cos(elev);
      const czp = sa * dist * Math.cos(elev);
      const cy = dist * Math.sin(elev) + 0.05;
      pos.push(cxp - sa * w, cy, czp + ca * w, cxp + sa * w, cy, czp - ca * w);
      uv.push(0, t, 1, t);
    }
    for (let r = 0; r < rows - 1; r++) {
      const i0 = b + r * 2;
      idx.push(i0, i0 + 1, i0 + 2, i0 + 1, i0 + 3, i0 + 2);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
  g.setIndex(idx);
  return g;
}

/** 落瓣：一片平躺的花瓣（单位四边形 ±1，瓣形在片元里裁）。 */
function petalGeometry(): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1]), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

// ────────────────────────────── 着色器 ──────────────────────────────

const VERT_HEAD = /* glsl */ `
attribute vec3 aRoot;
attribute vec4 aDir;
attribute vec4 aParams;
attribute vec3 aColor;
attribute float aType;
attribute float aPart;
attribute float aW;
varying vec3 vWorldPos;
varying vec3 vWorldN;
varying float vT;
varying vec3 vCol;
varying vec2 vUv;
varying float vType;
varying float vPart;
varying float vEnergy;
varying float vW;
#include <common>
#include <shadowmap_pars_vertex>
`;

const FRAG_HEAD = /* glsl */ `
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
varying vec2 vUv;
varying float vType;
varying float vPart;
varying float vEnergy;
varying float vW;
float sunShadow() {
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
	DirectionalLightShadow s = directionalLightShadows[ 0 ];
	return getShadow( directionalShadowMap[ 0 ], s.shadowMapSize, s.shadowIntensity, s.shadowBias, s.shadowRadius, vDirectionalShadowCoord[ 0 ] );
#else
	return 1.0;
#endif
}
vec3 hemiLight( vec3 N, float k ) { return mix( uGroundColor, uSkyColor, 0.5 ) * vec3( 1.0, 0.97, 0.9 ) * k; }
float sunDiff( vec3 N, float wrap ) { return clamp( ( dot( N, uSunDir ) + wrap ) / ( 1.0 + wrap ), 0.0, 1.0 ); }
float backlight( vec3 V, float pw ) { return pow( max( dot( -V, uSunDir ), 0.0 ), pw ); }
`;

/** 实例属性集 → InstancedBufferGeometry。 */
interface Instances {
  root: number[];
  dir: number[];
  params: number[];
  color: number[];
  type: number[];
}

function instanced(base: BufferGeometry, inst: Instances, mat: ShaderMaterial, name: string): Mesh {
  const count = inst.root.length / 3;
  const geo = new InstancedBufferGeometry();
  geo.index = base.index;
  for (const k of Object.keys(base.attributes)) geo.setAttribute(k, base.attributes[k]);
  geo.setAttribute('aRoot', new InstancedBufferAttribute(new Float32Array(inst.root), 3));
  geo.setAttribute('aDir', new InstancedBufferAttribute(new Float32Array(inst.dir), 4));
  geo.setAttribute('aParams', new InstancedBufferAttribute(new Float32Array(inst.params), 4));
  geo.setAttribute('aColor', new InstancedBufferAttribute(new Float32Array(inst.color), 3));
  geo.setAttribute('aType', new InstancedBufferAttribute(new Float32Array(inst.type), 1));
  geo.instanceCount = count;
  const mesh = new Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.name = `${name}:${count}`;
  return mesh;
}

function lit(uniforms: Record<string, IUniform>, lighting: LightingUniforms, vert: string, frag: string): ShaderMaterial {
  const merged = UniformsUtils.merge([UniformsLib.lights, {}]);
  for (const [k, v] of Object.entries({ ...uniforms, uSunDir: lighting.uSunDir, uSunColor: lighting.uSunColor, uSkyColor: lighting.uSkyColor, uGroundColor: lighting.uGroundColor })) merged[k] = v;
  return new ShaderMaterial({ uniforms: merged, lights: true, side: DoubleSide, vertexShader: vert, fragmentShader: frag });
}

/** 草（含狗尾草）：根固定；叶身按 t² 跟随自重垂弧 / 微风 / 气流；aDir = (yaw, phase, bend, lean)，aParams = (h, w, 0, 0)。 */
const GRASS_VERT = /* glsl */ `
${VERT_HEAD}
${NOISE_GLSL}
${AIRFLOW_GLSL}
void main() {
	float h = aParams.x;
	float w = aParams.y;
	float bend = aDir.z;
	float lean = aDir.w;
	float yaw = aDir.x;
	float phase = aDir.y;
	float t = clamp( position.y, 0.0, 1.0 );
	float c = cos( yaw );
	float s = sin( yaw );
	// 渐窄由几何自带；梢端先往外倾（lean）再弯下去（bend），弯下去时梢端也略降低（弧长近似守恒）
	float arc = lean * t + bend * t * t;
	vec3 q = vec3( position.x * w, position.y * h, 0.0 );
	q.xz += vec2( c, s ) * h * arc;
	q.y -= h * bend * 0.35 * t * t;
	// 狗尾草的穗（position.y > 1）：接在叶尖上，随叶尖一起倾
	if ( position.y > ${HEAD_Y} ) {
		q = vec3( position.x * w * 3.0, position.y * h, position.z * w * 3.0 );
		q.xz += vec2( c, s ) * h * ( lean + bend );
		q.y -= h * bend * 0.35;
	}
	// 微风 + 小鸟气流（根不动，梢端全跟上）
	vec3 wp0 = aRoot + q;
	float energy;
	vec3 flow = breeze( wp0, phase ) + airFlow( wp0, energy );
	float wgt = t * t;
	q += ( flow * 0.9 + vec3( sin( uTime * 3.1 + phase * 6.2831853 ) * 0.25 * wgt ) ) * wgt;
	q.xz += energy * 1.4 * sin( uTime * 42.0 + phase * 9.0 ) * wgt;
	vec3 wp = aRoot + q;
	vWorldPos = wp;
	// 叶面带一道浅折：法线从叶脉向两侧翻，一根叶子有横向明暗渐变
	vWorldN = normalize( vec3( -s, 1.1, c ) + vec3( c, 0.0, s ) * ( uv.x - 0.5 ) * 1.4 );
	vT = position.y;
	vCol = aColor;
	vUv = uv;
	vType = aType;
	vPart = aPart;
	vEnergy = energy;
	vW = 0.0;
	vec4 worldPosition = vec4( wp, 1.0 );
	vec4 mvPosition = viewMatrix * worldPosition;
	gl_Position = projectionMatrix * mvPosition;
	vec3 transformedNormal = normalize( normalMatrix * vec3( 0.0, 1.0, 0.0 ) );
	#include <shadowmap_vertex>
}
`;

const GRASS_FRAG = /* glsl */ `
${FRAG_HEAD}
void main() {
	vec3 N = normalize( vWorldN );
	if ( ! gl_FrontFacing ) N = - N;
	vec3 V = normalize( cameraPosition - vWorldPos );
	float sh = sunShadow();
	if ( vT > ${HEAD_Y} ) {
		// 狗尾草的穗：毛茸茸的米色小柱，边缘用噪声打散
		// 刚毛：沿穗轴一列列细齿（相位随高度略扭），越靠边缘越透
		float side = abs( vUv.x - 0.5 ) * 2.0;
		float bristle = 0.5 + 0.5 * sin( vUv.y * 150.0 + side * 6.0 );
		float fz = snoise( vec3( vUv * vec2( 9.0, 26.0 ), 2.0 ) );
		if ( side > 0.45 + 0.4 * bristle * ( 0.7 + 0.3 * fz ) ) discard;
		vec3 alb = vec3( 0.66, 0.56, 0.33 ) * ( 0.8 + 0.35 * fz + 0.15 * bristle );
		vec3 col = alb * ( uSunColor * sunDiff( N, 0.6 ) * sh + hemiLight( N, 0.8 ) );
		col += alb * uSunColor * backlight( V, 2.0 ) * ( 0.6 + 1.2 * side ) * sh * vec3( 1.0, 0.9, 0.6 );
		col += alb * 0.3 * vEnergy;
		gl_FragColor = vec4( col, 1.0 );
		#include <tonemapping_fragment>
		#include <colorspace_fragment>
		return;
	}
	float t = clamp( vT, 0.0, 1.0 );
	// 根部环境光遮蔽：根压到深墨绿 / 暗橄榄，中段才升到森林绿 / 草绿
	float rootAO = mix( 0.2, 1.0, smoothstep( 0.0, 0.6, t ) );
	vec3 deep = vec3( 0.03, 0.06, 0.02 );
	vec3 alb = mix( deep, vCol, smoothstep( 0.08, 0.65, t ) ) * rootAO;
	float edge = abs( vUv.x - 0.5 );
	alb *= 0.93 + 0.09 * smoothstep( 0.1, 0.0, edge ) - 0.1 * smoothstep( 0.3, 0.5, edge );
	float diff = sunDiff( N, 0.6 );
	vec3 col = alb * ( uSunColor * diff * sh + hemiLight( N, 0.75 ) );
	// 只有叶尖在逆光下透出温暖柔和的金黄嫩绿（次表面）
	float back = backlight( V, 2.0 );
	col += vec3( 0.8, 0.66, 0.2 ) * uSunColor * back * 0.9 * pow( t, 2.5 ) * sh;
	col += alb * 0.3 * vEnergy * ( 0.4 + 0.6 * t );
	gl_FragColor = vec4( col, 1.0 );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}
`;

/** 茎状植物（野花 / 绒球 / 雏菊 / 薰衣草）：aParams = (h 茎高, headR 花头半径, 0, 0)，部件按 aType 取舍。 */
const STEM_VERT = /* glsl */ `
${VERT_HEAD}
${NOISE_GLSL}
${AIRFLOW_GLSL}
void main() {
	float h = aParams.x;
	float headR = aParams.y;
	float yaw = aDir.x;
	float phase = aDir.y;
	float bend = aDir.z;
	float c = cos( yaw );
	float s = sin( yaw );
	float part = aPart;
	// 0 蒲公英花 / 1 白绒球 / 2 雏菊 / 3 薰衣草：按类型留部件（不留的缩到根上，零面积）
	float keep = 1.0;
	if ( part > 0.5 && part < 1.5 && ( aType > 0.5 ) ) keep = 0.0;
	if ( part > 1.5 && part < 2.5 && ( aType < 0.5 || aType > 1.5 ) ) keep = 0.0;
	if ( part > 2.5 && aType < 2.5 ) keep = 0.0;
	float t = clamp( part < 0.5 ? position.y : 1.0, 0.0, 1.0 );
	float stemW = 12.5 + h * 0.125; // 茎的半宽 0.15~0.2 cm
	vec3 p;
	if ( part < 0.5 ) {
		// 薰衣草的茎只画到 0.78（上面那截由花穗片承担）
		float yy = ( aType > 2.5 && position.y > 0.5 ) ? 0.78 : position.y;
		p = vec3( position.x * stemW, yy * h, position.z * stemW );
	} else if ( part < 1.5 ) {
		p = vec3( position.x * headR, h + ( position.y - 1.0 ) * headR, position.z * headR );
	} else if ( part < 2.5 ) {
		p = vec3( position.x * headR, h + ( position.y - 1.05 ) * headR, position.z * headR );
	} else {
		p = vec3( position.x * headR, position.y * h, position.z * headR );
	}
	p *= keep;
	// 茎的弯曲：越靠顶越顺着 yaw 方向倒
	p.xz += vec2( c, s ) * bend * h * t * t;
	p = vec3( p.x * c - p.z * s, p.y, p.x * s + p.z * c );
	vec3 wp0 = aRoot + p;
	float energy;
	vec3 flow = breeze( wp0, phase ) + airFlow( wp0, energy );
	float wgt = t * t;
	p += ( flow * 1.1 + vec3( sin( uTime * 2.7 + phase * 6.2831853 ) * 0.3 * wgt ) ) * wgt;
	p.xz += energy * 1.6 * sin( uTime * 38.0 + phase * 7.0 ) * wgt;
	vec3 wp = aRoot + p;
	vWorldPos = wp;
	vWorldN = normalize( vec3( s * 0.3, 1.0, c * 0.3 ) );
	vT = t;
	vCol = aColor;
	vUv = uv;
	vType = aType;
	vPart = part;
	vEnergy = energy;
	vW = 0.0;
	vec4 worldPosition = vec4( wp, 1.0 );
	vec4 mvPosition = viewMatrix * worldPosition;
	gl_Position = projectionMatrix * mvPosition;
	vec3 transformedNormal = normalize( normalMatrix * vec3( 0.0, 1.0, 0.0 ) );
	#include <shadowmap_vertex>
}
`;

const STEM_FRAG = /* glsl */ `
${FRAG_HEAD}
void main() {
	vec3 N = normalize( vWorldN );
	if ( ! gl_FrontFacing ) N = - N;
	vec3 V = normalize( cameraPosition - vWorldPos );
	float sh = sunShadow();
	vec3 alb;
	float spec = 0.08;
	float wrap = 0.5;
	float backK = 0.6;
	if ( vPart < 0.5 ) {
		// 茎：青绿，根部更深
		alb = mix( vec3( 0.12, 0.24, 0.08 ), vec3( 0.32, 0.55, 0.18 ), smoothstep( 0.0, 0.7, vT ) );
	} else if ( vPart > 2.5 ) {
		// 薰衣草花穗：一柱紫色小苞，用噪声在片元里打出一颗颗苞片，其余透空
		// 薰衣草花穗：两列交错的小苞片（椭圆），苞片之间透空，穗的轮廓是一节节的锯齿
		vec2 cell = vec2( vUv.x * 2.0, vUv.y * 18.0 );
		float row = floor( cell.y );
		float side = floor( cell.x );
		vec2 loc = fract( cell ) - 0.5;
		loc.x += mod( row, 2.0 ) * 0.5 - 0.25;
		float budR = length( loc * vec2( 1.0, 0.75 ) );
		if ( budR > 0.44 ) discard;
		float lit = 0.8 + 0.3 * hash13( vec3( row, side, 7.0 ) );
		alb = mix( vec3( 0.34, 0.15, 0.6 ), vec3( 0.7, 0.5, 0.95 ), lit * ( 1.0 - budR ) );
		wrap = 0.6;
		backK = 0.9;
	} else if ( vPart > 1.5 ) {
		// 白绒球：每片裁成带绒毛边的圆——绒毛从种子盘向外放射（两组不同频率的角向正弦相乘出细丝），
		// 中心是浅黄的种子盘，外圈纯白，逆光透亮
		vec2 d = vUv * 2.0 - 1.0;
		float r = length( d );
		float ang = atan( d.y, d.x );
		float hair = 0.5 + 0.5 * sin( ang * 44.0 + r * 5.0 );
		float hair2 = 0.5 + 0.5 * sin( ang * 29.0 - r * 9.0 + 1.7 );
		float reach = 0.72 + 0.28 * hair * hair2;
		if ( r > reach ) discard;
		float strands = smoothstep( 0.3, 0.85, hair * hair2 );
		alb = mix( vec3( 0.88, 0.88, 0.92 ), vec3( 1.0 ), strands );
		alb = mix( vec3( 0.86, 0.78, 0.5 ), alb, smoothstep( 0.08, 0.3, r ) );
		wrap = 0.9;
		spec = 0.02;
		backK = 1.6;
	} else {
		// 花盘（极坐标）：蒲公英金黄的舌状花边缘；雏菊黄心 + 微拱的奶白瓣
		vec2 d = vUv * 2.0 - 1.0;
		float r = length( d );
		float ang = atan( d.y, d.x );
		if ( vType < 0.5 ) {
			float petal = 0.5 + 0.5 * sin( ang * 24.0 );
			if ( r > 0.82 + 0.16 * petal ) discard;
			if ( r < 0.2 && snoise( vec3( d * 40.0, 1.0 ) ) > 0.5 ) discard;
			alb = mix( vec3( 0.97, 0.62, 0.05 ), vec3( 1.0, 0.84, 0.2 ), smoothstep( 0.45, 0.95, r ) );
		} else {
			float petal = smoothstep( 0.25, 0.6, sin( ang * 16.0 ) );
			if ( r > 0.38 + 0.6 * petal ) discard;
			alb = mix( vec3( 1.0, 0.78, 0.14 ), vec3( 0.97, 0.94, 0.88 ), smoothstep( 0.3, 0.42, r ) );
			// 瓣尖微微泛一点玫瑰色
			alb = mix( alb, vec3( 0.96, 0.78, 0.8 ), smoothstep( 0.8, 1.0, r ) * 0.5 * petal );
		}
		wrap = 0.8;
		spec = 0.05;
		backK = 0.9;
	}
	float diff = sunDiff( N, wrap );
	vec3 col = alb * ( uSunColor * diff * sh + hemiLight( N, 0.8 ) );
	col += alb * uSunColor * backlight( V, 1.6 ) * backK * sh;
	col += alb * 0.3 * vEnergy;
	col += vec3( 1.0 ) * pow( max( dot( N, normalize( uSunDir + V ) ), 0.0 ), 24.0 ) * spec * sh * step( 0.0, dot( N, uSunDir ) );
	gl_FragColor = vec4( col, 1.0 );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}
`;

/** 叶面家族，aType：0 三叶草 / 1 灌木球 / 2 蕨类 / 3 落瓣。aDir = (yaw, phase, bend, 0)，aParams = (scale, tiltX, 0, 0)。 */
const LEAF_VERT = /* glsl */ `
${VERT_HEAD}
${NOISE_GLSL}
${AIRFLOW_GLSL}
mat3 rotY( float a ) { float c = cos( a ), s = sin( a ); return mat3( c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c ); }
mat3 rotX( float a ) { float c = cos( a ), s = sin( a ); return mat3( 1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c ); }
void main() {
	float scale = aParams.x;
	float yaw = aDir.x;
	float phase = aDir.y;
	float bend = aDir.z;
	float kind = aType;
	vec3 p = position * scale;
	// 蕨类的叶往回垂一点
	if ( kind > 1.5 && kind < 2.5 ) p.y -= bend * scale * clamp( position.y, 0.0, 1.0 ) * 0.18;
	mat3 R = rotY( yaw ) * rotX( aParams.y );
	p = R * p;
	// 气流权重：三叶草按叶柄高度、灌木球整株当刚体摇、蕨类 0.6、落瓣贴地不动
	float wgt = kind < 0.5 ? clamp( position.y / 0.45, 0.0, 1.0 ) : ( kind > 0.5 && kind < 1.5 ? 1.0 : ( kind > 1.5 && kind < 2.5 ? 0.6 : 0.0 ) );
	wgt *= wgt;
	vec3 wp0 = aRoot + p;
	float energy;
	vec3 flow = breeze( wp0, phase ) + airFlow( wp0, energy );
	p += ( flow * ( kind > 0.5 && kind < 1.5 ? 0.5 : 0.9 ) + vec3( sin( uTime * 2.9 + phase * 6.2831853 ) * 0.12 * wgt ) ) * wgt;
	p.xz += energy * ( kind > 0.5 && kind < 1.5 ? 0.9 : 1.2 ) * sin( uTime * 36.0 + phase * 6.0 ) * wgt;
	vec3 wp = aRoot + p;
	vWorldPos = wp;
	vWorldN = normalize( R * vec3( 0.0, 1.0, 0.0 ) );
	vT = 0.0;
	vCol = aColor;
	vUv = uv;
	vType = kind;
	vPart = aPart;
	vEnergy = energy;
	vW = aW;
	vec4 worldPosition = vec4( wp, 1.0 );
	vec4 mvPosition = viewMatrix * worldPosition;
	gl_Position = projectionMatrix * mvPosition;
	vec3 transformedNormal = normalize( normalMatrix * vec3( 0.0, 1.0, 0.0 ) );
	#include <shadowmap_vertex>
}
`;

const LEAF_FRAG = /* glsl */ `
${FRAG_HEAD}
void main() {
	vec3 N = normalize( vWorldN );
	if ( ! gl_FrontFacing ) N = - N;
	vec3 V = normalize( cameraPosition - vWorldPos );
	float sh = sunShadow();
	vec3 alb;
	float wrap = 0.5;
	float spec = 0.12;
	float ao = 1.0;
	float backK = 0.7;
	if ( vType < 0.5 ) {
		// 三叶草的小叶：翠绿，一道浅色水痕横过小叶中段，小叶边缘略深
		float mark = smoothstep( 0.42, 0.5, vUv.x ) * ( 1.0 - smoothstep( 0.66, 0.76, vUv.x ) ) * ( 1.0 - 0.5 * abs( vUv.y ) );
		alb = vCol * ( 0.9 + 0.1 * smoothstep( 0.0, 0.3, vUv.x ) );
		alb = mix( alb, alb * 1.5 + vec3( 0.06 ), mark * 0.6 );
		alb *= 1.0 - 0.15 * smoothstep( 0.6, 0.95, abs( vUv.y ) );
	} else if ( vType > 2.5 ) {
		// 落瓣：粉白花瓣（椭圆带缺口），贴地略带枯边的暖粉
		float r = length( vUv * 2.0 - 1.0 );
		float notch = 0.25 * max( 0.0, vUv.y * 2.0 - 0.6 ) * ( 1.0 - abs( vUv.x * 2.0 - 1.0 ) );
		if ( r > 1.0 - notch ) discard;
		alb = mix( vCol, vCol * 1.12, smoothstep( 0.2, 0.9, vUv.y ) );
		wrap = 0.7;
		spec = 0.05;
		backK = 0.5;
	} else if ( vType > 1.5 ) {
		// 蕨类：羽状——中脉保留，两侧一片片小叶，叶形中间宽两头尖
		float u = vUv.y;
		float v = vUv.x * 2.0 - 1.0;
		float width = sin( clamp( u * 1.12, 0.0, 1.0 ) * 3.14159265 ) * ( 1.0 - 0.35 * u );
		if ( abs( v ) > width + 0.02 ) discard;
		float pinna = abs( fract( u * 11.0 ) - 0.5 );
		if ( abs( v ) > 0.08 && pinna > 0.36 * ( 1.0 - abs( v ) * 0.5 ) ) discard;
		alb = vCol * ( 0.85 + 0.3 * smoothstep( 0.0, 0.4, pinna ) );
		alb = mix( alb, alb * 1.35, 1.0 - smoothstep( 0.0, 0.06, abs( v ) ) );
		wrap = 0.6;
		backK = 0.9;
	} else {
		// 灌木球的叶簇：椭圆小叶，叶面深翠、叶缘亮一点；内膛（aPart 1）和球壳下部的叶子压暗
		if ( vPart < 0.5 ) {
			vec2 d = vUv * 2.0 - 1.0;
			if ( d.x * d.x + d.y * d.y > 1.0 ) discard;
			alb = vCol * ( 0.9 + 0.2 * smoothstep( 0.4, 1.0, d.y ) );
			alb *= 0.95 + 0.1 * smoothstep( 0.6, 1.0, length( d ) );
		} else {
			alb = vCol * 0.45;
		}
		ao = vPart < 0.5 ? mix( 0.35, 1.0, smoothstep( -0.3, 0.75, vW ) ) : 0.35;
		wrap = 0.55;
		spec = 0.2;
	}
	float diff = sunDiff( N, wrap );
	vec3 col = alb * ( uSunColor * diff * sh + hemiLight( N, 0.8 ) ) * ao;
	col += alb * uSunColor * backlight( V, 1.8 ) * backK * sh * ao;
	col += alb * 0.3 * vEnergy;
	gl_FragColor = vec4( col, 1.0 );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}
`;

// ────────────────────────────── 布置 ──────────────────────────────

export interface SpringLawnBuild {
  group: Group;
  uniforms: Record<string, IUniform>;
}

export function buildSpringLawn(lighting: LightingUniforms, field: Heightfield, airflow: AirflowField): SpringLawnBuild {
  const group = new Group();
  group.name = 'spring-lawn';
  const rng = makeRng(SPRING_GRASS.seed);
  const uniforms: Record<string, IUniform> = { uTime: { value: 0 } };
  const shared = { ...uniforms, ...airflow.uniforms };
  const grassMat = lit(shared, lighting, GRASS_VERT, GRASS_FRAG);
  const stemMat = lit(shared, lighting, STEM_VERT, STEM_FRAG);
  const leafMat = lit(shared, lighting, LEAF_VERT, LEAF_FRAG);
  const s = SPRING;

  /** 草坪分区：修剪短草（< 0.12）/ 长草区（> 0.12），5 m 与 1.6 m 两个尺度的噪声叠加。 */
  const zone = (x: number, z: number): number => noise3(x / 520 + 3.1, z / 520, 4.4) * 0.65 + noise3(x / 160, z / 160 + 7.7, 1.9) * 0.35;
  /** 离最近小径中线的距离（cm，按控制折线算，种植用足够准）。 */
  const pathDist = (x: number, z: number): number => {
    let best = 1e9;
    for (const path of GRAVEL_PATHS) {
      for (let i = 1; i < path.length; i++) {
        const ax = path[i - 1][0];
        const az = path[i - 1][2];
        const abx = path[i][0] - ax;
        const abz = path[i][2] - az;
        const len2 = abx * abx + abz * abz || 1;
        const t = Math.max(0, Math.min(1, ((x - ax) * abx + (z - az) * abz) / len2));
        best = Math.min(best, Math.hypot(x - ax - abx * t, z - az - abz * t));
      }
    }
    return best;
  };
  /** 游客沿小径走：近处（1.5 m 内）草簇权重 1，4.5 m 外 0.35（远处略疏，近处经得起微距）。 */
  const nearK = (x: number, z: number): number => {
    const k = 1 - Math.min(1, Math.max(0, (pathDist(x, z) - 150) / 300));
    return 0.35 + 0.65 * k * k * (3 - 2 * k);
  };
  const sample = (margin = 16, weighted = true): [number, number] | null => {
    for (let k = 0; k < 24; k++) {
      const x = s.x0 + margin + rng() * (s.x1 - s.x0 - 2 * margin);
      const z = s.z0 + margin + rng() * (s.z1 - s.z0 - 2 * margin);
      const dens = springGrassDensity(x, z);
      if (rng() < dens * (weighted ? nearK(x, z) : 1)) return [x, z];
    }
    return null;
  };
  const ground = (x: number, z: number): number => field.heightAt(x, z);

  // ── 草：簇生 ──
  const blades: Instances = { root: [], dir: [], params: [], color: [], type: [] };
  const tails: Instances = { root: [], dir: [], params: [], color: [], type: [] };
  const newTuft = (): void => {
    const c = sample();
    if (!c) return;
    const tall = zone(c[0], c[1]) > 0.12;
    const n = tall ? 8 + Math.floor(rng() * 3) : 6 + Math.floor(rng() * 2);
    // 整簇一个色相，每根再带一点明暗差
    const hue = rng();
    const spread = 2.5 + rng() * 3;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rng() * 0.9;
      const r = rng() * spread;
      const x = c[0] + Math.cos(a) * r;
      const z = c[1] + Math.sin(a) * r;
      const yaw = a + (rng() - 0.5) * 1.2;
      const h = tall ? 14 + rng() * 12 : 6 + rng() * 5;
      blades.root.push(x, ground(x, z) - 0.8, z);
      blades.dir.push(yaw, rng(), (0.12 + rng() * 0.18) * (rng() < 0.15 ? -0.6 : 1), 0.08 + rng() * 0.14);
      blades.params.push(h, (tall ? 0.8 : 0.5) + rng() * (tall ? 0.5 : 0.3), 0, 0);
      // 森林绿 / 草绿（线性空间，乘上日照后是自然的草色，不发荧光）
      blades.color.push(0.06 + hue * 0.09 + rng() * 0.02, 0.19 + rng() * 0.09, 0.04 + hue * 0.04);
      blades.type.push(0);
    }
    // 长草区混生狗尾草：细高的叶 + 穗
    if (tall && rng() < 0.22) {
      const a = rng() * Math.PI * 2;
      const h = 24 + rng() * 12;
      tails.root.push(c[0] + Math.cos(a) * 1.5, ground(c[0], c[1]) - 0.8, c[1] + Math.sin(a) * 1.5);
      tails.dir.push(a, rng(), 0.12 + rng() * 0.16, 0.06 + rng() * 0.1);
      tails.params.push(h, 0.6 + rng() * 0.3, 0, 0);
      tails.color.push(0.09, 0.24, 0.06);
      tails.type.push(1);
    }
  };
  for (let i = 0; i < SPRING_GRASS.tufts; i++) newTuft();
  group.add(instanced(bladeGeometry(false), blades, grassMat, 'spring-grass'));
  group.add(instanced(bladeGeometry(true), tails, grassMat, 'spring-foxtail'));

  // ── 叶面家族：三叶草 / 蕨类 / 灌木球 / 落瓣共用一个材质 ──
  const clovers: Instances = { root: [], dir: [], params: [], color: [], type: [] };
  const fernsI: Instances = { root: [], dir: [], params: [], color: [], type: [] };
  const shrubs: Instances = { root: [], dir: [], params: [], color: [], type: [] };
  const petals: Instances = { root: [], dir: [], params: [], color: [], type: [] };

  // 三叶草：短草区成片（每片 3~5 簇）
  for (let i = 0; i < SPRING_GRASS.clover; i++) {
    const p = sample(20, false);
    if (!p) continue;
    if (zone(p[0], p[1]) > 0.3 && rng() < 0.6) continue;
    const n = 3 + Math.floor(rng() * 3);
    for (let k = 0; k < n; k++) {
      const a = rng() * Math.PI * 2;
      const r = rng() * 14;
      const x = p[0] + Math.cos(a) * r;
      const z = p[1] + Math.sin(a) * r;
      if (springGrassDensity(x, z) <= 0) continue;
      clovers.root.push(x, ground(x, z) - 0.3, z);
      clovers.dir.push(rng() * Math.PI * 2, rng(), 0, 0);
      clovers.params.push(3.4 + rng() * 1.8, (rng() - 0.5) * 0.3, 0, 0);
      clovers.color.push(0.08 + rng() * 0.04, 0.25 + rng() * 0.07, 0.055 + rng() * 0.03);
      clovers.type.push(0);
    }
  }

  // ── 野花：蒲公英 / 雏菊成簇（短草区），白绒球（长草区），薰衣草沿路缘砖 ──
  const stems: Instances = { root: [], dir: [], params: [], color: [], type: [] };
  const stem = (x: number, z: number, type: number, h: number, headR: number): void => {
    stems.root.push(x, ground(x, z) - 0.5, z);
    stems.dir.push(rng() * Math.PI * 2, rng(), 0.08 + rng() * 0.22, 0);
    stems.params.push(h, headR, 0, 0);
    stems.color.push(1, 1, 1);
    stems.type.push(type);
  };
  let placed = 0;
  let guard = 0;
  while (placed < SPRING_GRASS.flowers && guard++ < 4000) {
    const c = sample(20, false);
    if (!c) continue;
    if (zone(c[0], c[1]) > 0.3) continue;
    const n = Math.min(SPRING_GRASS.flowers - placed, 6 + Math.floor(rng() * 14));
    const kind = rng() < 0.68 ? 0 : 2;
    for (let i = 0; i < n; i++) {
      const a = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * (16 + rng() * 20);
      const x = c[0] + Math.cos(a) * r;
      const z = c[1] + Math.sin(a) * r;
      if (springGrassDensity(x, z) <= 0) continue;
      stem(x, z, kind, 9 + rng() * 7, kind === 0 ? 2.0 + rng() * 0.6 : 1.6 + rng() * 0.4);
      placed++;
    }
  }
  for (let i = 0; i < SPRING_GRASS.clocks; i++) {
    const p = sample(20, false);
    if (!p) continue;
    if (zone(p[0], p[1]) < 0.05 && rng() < 0.5) continue;
    stem(p[0], p[1], 1, 12 + rng() * 8, 2.3 + rng() * 0.8);
  }
  // 薰衣草：小径两侧 85~115 cm 每 60 cm 有 55% 的概率长一丛，每丛 5~9 穗
  const lavenderClump = (x: number, z: number): void => {
    const n = 5 + Math.floor(rng() * 5);
    for (let k = 0; k < n; k++) {
      const a = rng() * Math.PI * 2;
      const r = rng() * 16;
      const px = x + Math.cos(a) * r;
      const pz = z + Math.sin(a) * r;
      if (springGrassDensity(px, pz) <= 0 || pathDist(px, pz) < PATH_HALF + 14) continue;
      stem(px, pz, 3, 40 + rng() * 20, 0.7 + rng() * 0.25);
    }
  };
  for (const path of GRAVEL_PATHS) {
    const smp = samplePath(path, 60);
    for (let i = 1; i < smp.length - 1; i++) {
      const q = smp[i];
      for (const side of [1, -1]) {
        if (rng() < 0.45) continue;
        const off = (PATH_HALF + 28 + rng() * 30) * side;
        lavenderClump(q.x - q.tz * off, q.z + q.tx * off);
      }
    }
  }
  for (let i = 0; i < SPRING_GRASS.lavender; i++) {
    const p = sample(24);
    if (p) lavenderClump(p[0], p[1]);
  }

  // ── 常绿小灌木球：矮墙内沿 / 小径拐弯处 ──
  const shrub = (x: number, z: number, R: number): void => {
    shrubs.root.push(x, ground(x, z) - 1.5, z);
    shrubs.dir.push(rng() * Math.PI * 2, rng(), 0, 0);
    shrubs.params.push(R, (rng() - 0.5) * 0.1, 0, 0);
    shrubs.color.push(0.07 + rng() * 0.04, 0.2 + rng() * 0.06, 0.05 + rng() * 0.03);
    shrubs.type.push(1);
  };
  for (let i = 0; i < SPRING_GRASS.shrubs; i++) {
    const p = sample(40, false);
    if (!p) continue;
    const dWall = Math.min(p[0] - s.x0, s.x1 - p[0], p[1] - s.z0, s.z1 - p[1]);
    const dPath = pathDist(p[0], p[1]);
    if (dWall > 120 && dPath > 150 && rng() < 0.7) continue;
    if (dPath < PATH_HALF + 60) continue;
    shrub(p[0], p[1], 26 + rng() * 18);
  }

  // ── 宽叶蕨类：矮墙内沿的阴处 + 树脚下 ──
  for (let i = 0; i < SPRING_GRASS.ferns; i++) {
    const p = sample(24, false);
    if (!p) continue;
    const dWall = Math.min(p[0] - s.x0, s.x1 - p[0], p[1] - s.z0, s.z1 - p[1]);
    let underTree = false;
    for (const t of SPRING_TREES) if ((p[0] - t.base[0]) ** 2 + (p[1] - t.base[2]) ** 2 < 90 * 90) underTree = true;
    if (dWall > 110 && !underTree && rng() < 0.75) continue;
    fernsI.root.push(p[0], ground(p[0], p[1]) - 0.5, p[1]);
    fernsI.dir.push(rng() * Math.PI * 2, rng(), 0.6 + rng() * 0.6, 0);
    fernsI.params.push(28 + rng() * 16, 0, 0, 0);
    fernsI.color.push(0.09 + rng() * 0.04, 0.26 + rng() * 0.07, 0.06 + rng() * 0.03);
    fernsI.type.push(2);
  }

  // ── 主海棠树下的落瓣：高斯散落 + 小径边（路面上略抬高）；第二棵海棠脚下也撒一圈 ──
  const petal = (x: number, z: number, size: number): void => {
    if (x < s.x0 + 10 || x > s.x1 - 10 || z < s.z0 + 10 || z > s.z1 - 10) return;
    const onPath = pathDist(x, z) < PATH_HALF;
    petals.root.push(x, ground(x, z) + (onPath ? 2.2 : 0.5), z);
    petals.dir.push(rng() * Math.PI * 2, 0, 0, 0);
    petals.params.push(size, (rng() - 0.5) * 0.25, 0, 0);
    const k = rng();
    petals.color.push(0.86 + k * 0.06, 0.46 + k * 0.24, 0.54 + k * 0.24);
    petals.type.push(3);
  };
  const main = SPRING_TREES[0].base;
  for (let i = 0; i < SPRING_GRASS.petals; i++) {
    const a = rng() * Math.PI * 2;
    const r = Math.abs(rng() + rng() - 1) * 260 + 20;
    petal(main[0] + Math.cos(a) * r * 1.15, main[2] + Math.sin(a) * r, 1.1 + rng() * 0.8);
  }
  for (let i = 0; i < 400; i++) {
    const path = GRAVEL_PATHS[Math.floor(rng() * GRAVEL_PATHS.length)];
    const smp = samplePath(path, 40);
    const q = smp[Math.floor(rng() * smp.length)];
    const off = (PATH_HALF - 10 + rng() * 50) * (rng() < 0.5 ? 1 : -1);
    petal(q.x - q.tz * off, q.z + q.tx * off, 1.0 + rng() * 0.7);
  }
  const second = SPRING_TREES[1].base;
  for (let i = 0; i < 500; i++) {
    const a = rng() * Math.PI * 2;
    const r = Math.abs(rng() + rng() - 1) * 150 + 15;
    petal(second[0] + Math.cos(a) * r, second[2] + Math.sin(a) * r, 1.0 + rng() * 0.7);
  }

  group.add(instanced(stemmyGeometry(), stems, stemMat, 'spring-stems'));
  group.add(instanced(shrubGeometry(), shrubs, leafMat, 'spring-shrubs'));
  group.add(instanced(cloverGeometry(), clovers, leafMat, 'spring-clover'));
  group.add(instanced(fernGeometry(), fernsI, leafMat, 'spring-ferns'));
  group.add(instanced(petalGeometry(), petals, leafMat, 'spring-petals'));
  return { group, uniforms };
}
