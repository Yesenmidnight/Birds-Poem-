/**
 * 温室春树的实例化叶 / 花（接 Airflow.ts 的统一气流场）：
 *   叶片——一片带短柄的卵形叶（5 个三角形），实例属性给枝上的锚点、朝向、大小、相位；顶点着色器里叶柄根钉在锚点上，
 *          叶身按离柄根的距离加权地随微风和小鸟气流翻飞（掠过枝头时叶子和花簇跟着翻）；
 *          细枝每个叶节两片互生叶，枝梢再发一束 5~7 片的叶簇团（bouquet），果台尖一丛嫩叶——树冠内外分层铺满；
 *   树冠 AO——每个实例按锚点到本棵树冠球心的深度带一个 aAO：内膛压到深翡翠绿、只吃一半天光，外层叶子受光 + 半透逆光；
 *   垂丝海棠花——一根下垂的紫红花梗 + 5 片粉白渐变、瓣尖带缺口的花瓣 + 黄色花心（22 个三角形），主树盛放：
 *          每根果台 9~12 朵、当年生枝条每个叶节 4~5 朵，粉白花云挂满枝；第二棵开得稀一些。
 *   花团卡——树冠包络内部的远景花云：三张朝向各异的四边形上各画 6 朵五瓣花（4 个三角形），近处枝头上的细节花仍是真几何；
 * 全部 2~3 棵树的叶 / 细节花 / 花团卡各合成一个 InstancedBufferGeometry：三次绘制。
 */
import { BufferAttribute, BufferGeometry, DoubleSide, Group, InstancedBufferAttribute, InstancedBufferGeometry, Mesh, ShaderMaterial, UniformsLib, UniformsUtils, type IUniform } from 'three';
import { SPRING_TREES, springTreeLimbs, type CrabLimb } from '../pcg/courtyard';
import { flattenPoints, sampleArc } from '../sim/spline';
import { makeRng } from '../util/math';
import type { LightingUniforms } from '../glsl/lit';
import { NOISE_GLSL } from '../glsl/noise';
import { LIMB_GLSL, makeLimbUniforms } from '../world/branchSway';
import { AIRFLOW_GLSL, type AirflowField } from './Airflow';

type V3 = [number, number, number];

/** 叶片：叶柄 0..0.22 沿 +Z，叶身卵形 0.22..1（尖在 +Z），叶面在 XZ 平面略向上抱。aW = 离柄根的归一化距离（摆动权重）。 */
function leafGeometry(): BufferGeometry {
  const b = 0.22;
  const v: V3[] = [
    [0, 0, 0],
    [0, 0, b],
    [-0.3, 0.04, b + 0.22],
    [-0.22, 0.07, b + 0.55],
    [0, 0.1, 1],
    [0.22, 0.07, b + 0.55],
    [0.3, 0.04, b + 0.22],
  ];
  const idx = [0, 2, 1, 1, 3, 2, 1, 4, 3, 1, 5, 4, 1, 6, 5];
  const pos = new Float32Array(v.length * 3);
  const uv = new Float32Array(v.length * 2);
  const aw = new Float32Array(v.length);
  v.forEach((p, i) => {
    pos.set(p, i * 3);
    uv.set([(p[0] + 0.3) / 0.6, p[2]]);
    aw[i] = p[2];
  });
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('uv', new BufferAttribute(uv, 2));
  g.setAttribute('aW', new BufferAttribute(aw, 1));
  g.setIndex(idx);
  return g;
}

/** 垂丝海棠花：花梗从原点沿 +Z 伸出并下垂（归一化长度 1），末端 5 片花瓣（22 个三角形：梗 1 段 2 + 瓣 5×4，瓣尖带缺口）；
 *  花心的黄在片元里按花瓣基部的 uv 染出来，不另建面。aPart 0 梗 / 1 瓣。 */
function blossomGeometry(): BufferGeometry {
  const pos: number[] = [];
  const w: number[] = [];
  const part: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  // 花梗：两段的细带（宽 0.03），从 (0,0,0) 弯到 (0, -0.5, 0.78)
  const seg = 1;
  const spine: V3[] = [];
  for (let i = 0; i <= seg; i++) {
    const t = i / seg;
    spine.push([0, -0.5 * t * t, 0.78 * t]);
  }
  for (let i = 0; i < seg; i++) {
    const a = spine[i];
    const b = spine[i + 1];
    const base = pos.length / 3;
    pos.push(a[0] - 0.03, a[1], a[2], a[0] + 0.03, a[1], a[2], b[0] - 0.03, b[1], b[2], b[0] + 0.03, b[1], b[2]);
    uv.push(0, i / seg, 1, i / seg, 0, (i + 1) / seg, 1, (i + 1) / seg);
    for (let k = 0; k < 4; k++) {
      w.push(i / seg + (k >= 2 ? 1 / seg : 0));
      part.push(0);
    }
    idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
  }
  // 花瓣：5 片，从花梗末端 (0,-0.5,0.78) 向四周张开并朝下（俯视是花口朝下的钟形）；每瓣 3 个三角形，瓣尖带一道浅缺口；
  // 花面直径 ≈ 1 × scale
  const end: V3 = spine[seg];
  const dir: V3 = [0, -0.55, 0.835];
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2 + 0.3;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const base = pos.length / 3;
    const L = 0.5;
    const spread = 0.85;
    // 局部标架：沿瓣长 u、横向 v
    const u: V3 = [ca * spread * 0.5 + dir[0] * L, dir[1] * L, sa * spread * 0.5 + dir[2] * L];
    // 瓣的横向半宽 0.21（× scale 3.6 ≈ 0.75 cm，一片瓣 1.5 cm 宽）
    const v: V3 = [-sa * 0.42, 0, ca * 0.42];
    const P = (uu: number, vv: number, dy: number): V3 => [end[0] + u[0] * uu + v[0] * vv + dir[2] * 0.05, end[1] + u[1] * uu + v[1] * vv + dir[1] * 0.05 + dy, end[2] + u[2] * uu + v[2] * vv + dir[2] * 0.05];
    pos.push(...P(0.1, 0, 0), ...P(0.55, -0.5, -0.05), ...P(1.0, -0.28, -0.1), ...P(0.92, 0, -0.09), ...P(1.0, 0.28, -0.1), ...P(0.55, 0.5, -0.05));
    uv.push(0.5, 0.1, 0, 0.55, 0, 1, 0.5, 0.92, 1, 1, 1, 0.55);
    for (let q = 0; q < 6; q++) {
      w.push(1);
      part.push(1);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3, base, base + 3, base + 4, base, base + 4, base + 5);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
  g.setAttribute('aW', new BufferAttribute(new Float32Array(w), 1));
  g.setAttribute('aPart', new BufferAttribute(new Float32Array(part), 1));
  g.setIndex(idx);
  return g;
}

/** 花团卡：三张朝向各异的单位四边形（aPart 2，aW 1），片元里按伪随机位置画 6 朵五瓣花——树冠包络内部的远景填充花云。 */
function clusterGeometry(): BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const w: number[] = [];
  const part: number[] = [];
  const idx: number[] = [];
  for (const [U, W] of [[[1, 0, 0], [0, 0, 1]], [[0, 1, 0], [0, 0, 1]], [[1, 0, 0], [0, 1, 0]]] as [V3, V3][]) {
    const b = pos.length / 3;
    for (const [cu, cv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      pos.push(U[0] * cu + W[0] * cv, U[1] * cu + W[1] * cv, U[2] * cu + W[2] * cv);
      uv.push((cu + 1) / 2, (cv + 1) / 2);
      w.push(1);
      part.push(2);
    }
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
  g.setAttribute('aW', new BufferAttribute(new Float32Array(w), 1));
  g.setAttribute('aPart', new BufferAttribute(new Float32Array(part), 1));
  g.setIndex(idx);
  return g;
}

const VERT = /* glsl */ `
attribute vec3 aAnchor;
attribute vec3 aRot;
attribute vec3 aMisc;
attribute vec3 aColor;
attribute float aAO;
attribute float aW;
attribute float aPart;
varying vec3 vWorldPos;
varying vec3 vWorldN;
varying vec2 vUv;
varying vec3 vCol;
varying float vW;
varying float vPart;
varying float vEnergy;
varying float vSeed;
varying float vAO;
#include <common>
#include <shadowmap_pars_vertex>
${NOISE_GLSL}
${AIRFLOW_GLSL}
${LIMB_GLSL}
mat3 rotY( float a ) { float c = cos( a ), s = sin( a ); return mat3( c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c ); }
mat3 rotX( float a ) { float c = cos( a ), s = sin( a ); return mat3( 1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c ); }
mat3 rotZ( float a ) { float c = cos( a ), s = sin( a ); return mat3( c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0 ); }
void main() {
	float scale = aMisc.x;
	float phase = aMisc.y;
	float kind = aMisc.z;
	// 锚点处的气流（叶柄根 / 花梗根钉在枝上，叶身 / 花朵按 aW 加权地翻飞）：微风约半厘米的摇曳，鸟的翼风最大掀到 8 cm
	float energy;
	vec3 flow = breeze( aAnchor, phase ) * 1.2 + airFlow( aAnchor, energy );
	float wgt = pow( clamp( aW, 0.0, 1.0 ), 1.2 );
	vec3 p = position * scale;
	p = rotY( aRot.x ) * rotX( aRot.y ) * rotZ( aRot.z ) * p;
	// 自由态的轻颤 + 气流掀起的翻飞：绕锚点抬起来（叶面翻过去 / 花像单摆往外甩）
	float flut = 0.1 * sin( uTime * 4.3 + phase * 6.2831853 ) + energy * ( 0.9 * sin( uTime * 30.0 + phase * 12.0 ) + 0.6 );
	p.y += flut * wgt * scale * ( kind > 0.5 ? 0.9 : 0.55 );
	// 气流位移（cm）直接加在世界方向上（flow 是世界空间的 cm，不再乘叶长——乘了会整片叶子飞离枝条）
	p += flow * wgt * ( kind > 0.5 ? 0.5 : 0.4 );
	vec3 wp = aAnchor + p;
	// 枝条随动：锚点钉在枝上，枝弯了多少（自己这根的 (s/L)² + 母枝在焊口处的刚性位移）整片叶 / 整朵花跟着走
	wp = limbBend( wp );
	vWorldPos = wp;
	vWorldN = normalize( rotY( aRot.x ) * rotX( aRot.y ) * rotZ( aRot.z ) * vec3( 0.0, 1.0, 0.0 ) );
	vUv = uv;
	vCol = aColor;
	vW = aW;
	vPart = aPart;
	vEnergy = energy;
	vSeed = phase;
	vAO = aAO;
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
varying vec2 vUv;
varying vec3 vCol;
varying float vW;
varying float vPart;
varying float vEnergy;
varying float vSeed;
varying float vAO;
float sunShadow() {
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
	DirectionalLightShadow s = directionalLightShadows[ 0 ];
	return getShadow( directionalShadowMap[ 0 ], s.shadowMapSize, s.shadowIntensity, s.shadowBias, s.shadowRadius, vDirectionalShadowCoord[ 0 ] );
#else
	return 1.0;
#endif
}
void main() {
	vec3 N = normalize( vWorldN );
	if ( ! gl_FrontFacing ) N = - N;
	vec3 V = normalize( cameraPosition - vWorldPos );
	vec3 alb = vCol;
	float translucent = 0.5;
	if ( vPart > 1.5 ) {
		// 花团卡：一张卡上按伪随机位置画 6 朵五瓣花（取离像素最近的中心定花瓣轮廓）；
		// 远处是花云的填充，近处枝头上的细节花是真正的几何体
		float bestD = 9.0;
		vec2 bestC = vec2( 0.5 );
		float bestR = 0.14;
		float bestRot = 0.0;
		float bestK = 0.0;
		for ( int i = 0; i < 6; i++ ) {
			float fi = float( i ) + vSeed * 11.0;
			vec2 c = vec2( hash13( vec3( fi, 1.0, 1.0 ) ), hash13( vec3( fi, 2.0, 1.0 ) ) ) * 0.7 + 0.15;
			float r = 0.11 + 0.06 * hash13( vec3( fi, 3.0, 1.0 ) );
			float d = length( vUv - c ) / r;
			if ( d < bestD ) {
				bestD = d;
				bestC = c;
				bestR = r;
				bestRot = hash13( vec3( fi, 4.0, 1.0 ) ) * 6.2831853;
				bestK = hash13( vec3( fi, 5.0, 1.0 ) );
			}
		}
		vec2 q = ( vUv - bestC ) / bestR;
		float rr = length( q );
		float ang = atan( q.y, q.x ) + bestRot;
		float petal = 0.6 + 0.4 * pow( abs( cos( ang * 2.5 ) ), 0.6 );
		if ( rr > petal ) discard;
		vec3 pink = mix( vCol, vec3( 1.0, 0.94, 0.96 ), smoothstep( 0.25, 1.0, rr ) ) * ( 0.92 + 0.12 * bestK );
		alb = mix( vec3( 0.97, 0.78, 0.3 ), pink, smoothstep( 0.05, 0.3, rr ) );
		translucent = 0.9;
		alb *= mix( 0.55, 1.0, vAO );
	} else if ( vPart > 0.5 ) {
		// 花瓣：基部深一点的玫粉 → 边缘近白（vUv.y 越大越靠瓣尖），带一丝细脉；最基部一撮暖黄当花心（不另建面）
		alb = mix( vCol, vec3( 1.0, 0.94, 0.96 ), smoothstep( 0.3, 0.95, vUv.y ) );
		alb *= 0.95 + 0.05 * sin( vUv.x * 28.0 );
		alb = mix( vec3( 0.97, 0.78, 0.26 ), alb, smoothstep( 0.03, 0.22, vUv.y ) );
		translucent = 0.9;
		// 内膛的花也压暗一点（在树冠阴影里），但花云的轮廓（外层）保持亮
		alb *= mix( 0.55, 1.0, vAO );
	} else if ( vPart < 0.5 ) {
		if ( vW < 0.2 ) alb = vec3( 0.55, 0.18, 0.25 );
		else alb *= 0.9 + 0.1 * smoothstep( 0.02, 0.0, abs( vUv.x - 0.5 ) ) + 0.05 * snoise( vWorldPos * 8.0 );
		translucent = 0.7;
	}
	// 树冠 AO：按锚点到树冠球心的深度——内膛叶子压到深翡翠绿（红色通道压得更多）、只吃一半天光，外层受光 + 半透逆光
	float depth = 1.0 - vAO;
	vec3 emerald = alb * vec3( 0.45, 0.85, 0.7 );
	alb = mix( alb, emerald, depth * 0.8 ) * mix( 1.0, 0.5, depth );
	float sh = sunShadow();
	float diff = clamp( ( dot( N, uSunDir ) + 0.55 ) / 1.55, 0.0, 1.0 );
	vec3 col = alb * ( uSunColor * diff * sh + mix( uGroundColor, uSkyColor, 0.55 ) * mix( 0.55, 0.95, vAO ) );
	// 逆光透射：花瓣 / 嫩叶都是半透的，逆光透出粉 / 嫩绿的光；只有外层叶子透
	float back = pow( max( dot( -V, uSunDir ), 0.0 ), 2.0 );
	col += alb * uSunColor * back * translucent * sh * vec3( 1.0, 0.9, 0.85 ) * mix( 0.25, 1.0, vAO );
	// 被气流掀起时略亮（翻出浅色的叶背）
	col += alb * 0.3 * vEnergy;
	gl_FragColor = vec4( col, 1.0 );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}
`;

interface Instances {
  anchor: number[];
  rot: number[];
  misc: number[];
  color: number[];
  ao: number[];
  /** 枝条随动标签（每实例 vec2 × 2）：aLimb = (自己那根枝的号 + 1, 沿枝归一化弧长)，aLimbP = (母枝号 + 1, 焊口弧长)；0 = 无。 */
  limb: number[];
  limbP: number[];
}

function instanced(base: BufferGeometry, inst: Instances, mat: ShaderMaterial, name: string): Mesh {
  const count = inst.anchor.length / 3;
  const geo = new InstancedBufferGeometry();
  geo.index = base.index;
  for (const k of ['position', 'uv', 'aW', 'aPart']) if (base.attributes[k]) geo.setAttribute(k, base.attributes[k]);
  geo.setAttribute('aAnchor', new InstancedBufferAttribute(new Float32Array(inst.anchor), 3));
  geo.setAttribute('aRot', new InstancedBufferAttribute(new Float32Array(inst.rot), 3));
  geo.setAttribute('aMisc', new InstancedBufferAttribute(new Float32Array(inst.misc), 3));
  geo.setAttribute('aColor', new InstancedBufferAttribute(new Float32Array(inst.color), 3));
  geo.setAttribute('aAO', new InstancedBufferAttribute(new Float32Array(inst.ao), 1));
  geo.setAttribute('aLimb', new InstancedBufferAttribute(new Float32Array(inst.limb), 2));
  geo.setAttribute('aLimbP', new InstancedBufferAttribute(new Float32Array(inst.limbP), 2));
  geo.instanceCount = count;
  const mesh = new Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.name = `${name}:${count}`;
  return mesh;
}

function foliageMaterial(uniforms: Record<string, IUniform>, lighting: LightingUniforms): ShaderMaterial {
  const merged = UniformsUtils.merge([UniformsLib.lights, {}]);
  for (const [k, v] of Object.entries({ ...uniforms, uSunDir: lighting.uSunDir, uSunColor: lighting.uSunColor, uSkyColor: lighting.uSkyColor, uGroundColor: lighting.uGroundColor })) merged[k] = v;
  return new ShaderMaterial({ uniforms: merged, lights: true, side: DoubleSide, vertexShader: VERT, fragmentShader: FRAG });
}

/** 枝上的一串锚点：沿弧长 t0..t1 每隔约 step cm 一个（切向按相邻采样点的差分）。 */
function anchorsAlong(limb: CrabLimb, t0: number, t1: number, step: number): { p: V3; t: V3; tAlong: number }[] {
  const n = 24;
  const arc = sampleArc(flattenPoints(limb.points), limb.points.length, n);
  const seg = arc.length / n;
  const stride = Math.max(1, Math.round(step / Math.max(seg, 0.01)));
  const out: { p: V3; t: V3; tAlong: number }[] = [];
  for (let i = Math.ceil(t0 * n); i <= Math.floor(t1 * n); i += stride) {
    const k = i * 3;
    const a = Math.max(0, i - 1) * 3;
    const b = Math.min(n, i + 1) * 3;
    const dx = arc.centers[b] - arc.centers[a];
    const dy = arc.centers[b + 1] - arc.centers[a + 1];
    const dz = arc.centers[b + 2] - arc.centers[a + 2];
    const len = Math.hypot(dx, dy, dz) || 1;
    out.push({ p: [arc.centers[k], arc.centers[k + 1], arc.centers[k + 2]], t: [dx / len, dy / len, dz / len], tAlong: i / n });
  }
  return out;
}

/** 树冠球：(球心, 半径)。海棠 / 阔叶树的冠都在树高 0.55~1.0 之间，球心取 0.72 h、半径取 0.42 h（再按枝条实际包络微调）。 */
function crownOf(tree: { base: V3; height: number }): { c: V3; r: number } {
  return { c: [tree.base[0], tree.base[1] + tree.height * 0.72, tree.base[2]], r: tree.height * 0.42 };
}

export interface FoliageBuild {
  group: Group;
  uniforms: Record<string, IUniform>;
}

export function buildFoliage(lighting: LightingUniforms, airflow: AirflowField, limbUniforms: Record<string, IUniform> = makeLimbUniforms()): FoliageBuild {
  const group = new Group();
  group.name = 'spring-foliage';
  const rng = makeRng(313);
  const uniforms: Record<string, IUniform> = { uTime: { value: 0 } };
  const mat = foliageMaterial({ ...uniforms, ...airflow.uniforms, ...limbUniforms }, lighting);
  const leaves: Instances = { anchor: [], rot: [], misc: [], color: [], ao: [], limb: [], limbP: [] };
  const blossoms: Instances = { anchor: [], rot: [], misc: [], color: [], ao: [], limb: [], limbP: [] };
  const clusters: Instances = { anchor: [], rot: [], misc: [], color: [], ao: [], limb: [], limbP: [] };
  const trees = springTreeLimbs();
  const crowns = SPRING_TREES.map(crownOf);
  /** 树冠 AO：锚点到球心的距离 / 半径 → 0（球心）..1（冠表）；冠表以外（枝梢伸出包络）记 1。 */
  const aoAt = (ti: number, p: V3): number => {
    const { c, r } = crowns[ti];
    const d = Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]) / r;
    return Math.max(0, Math.min(1, (d - 0.15) / 0.85));
  };
  const leafBase = (ti: number, p: V3): number => aoAt(ti, p);
  /** 枝条随动标签：own = (自己那根枝的号 + 1, 沿枝归一化弧长) 或 0（果台尖的附着物），parent = (母枝号 + 1, 焊口弧长)。 */
  const tag = (inst: Instances, own: number, ownS: number, parent: number, parentS: number): void => {
    inst.limb.push(own, ownS);
    inst.limbP.push(parent, parentS);
  };
  /** 这棵树的第一根枝在合并枝条表（springLimbs，和碰撞曲线同一个编号空间）里的序号。 */
  let base = 0;
  for (const [ti, limbs] of trees.entries()) {
    const broadleaf = ti === 2;
    // 主树（第一棵海棠）盛放：当年生枝条上每个叶节挂一簇 4~5 朵；第二棵海棠开得稀一些（隔一节 3 朵）
    // twigBloom：0 = 每个叶节都开（主树），2 = 隔一节开（第二棵）
    const twigBloom = ti === 0 ? 0 : ti === 1 ? 2 : -1;
    const bloomN = 3;
    /** 一朵垂丝海棠花：从 anchor 沿 yaw 伸出再下垂（scale = 花梗 + 花的整体尺寸 cm）。 */
    /** 一张花团卡（≈ 6 朵花的远景印象）：中心在枝旁，三张面朝向各异，随气流轻摆。 */
    const cluster = (anchor: V3, own: number, ownS: number, parent: number, parentS: number): void => {
      const k2 = rng();
      clusters.anchor.push(anchor[0], anchor[1], anchor[2]);
      clusters.rot.push(rng() * Math.PI * 2, (rng() - 0.5) * 1.2, (rng() - 0.5) * 1.0);
      clusters.misc.push(5.5 + rng() * 3.5, rng(), 1);
      clusters.color.push(0.95 + k2 * 0.04, 0.4 + k2 * 0.22, 0.56 + k2 * 0.18);
      clusters.ao.push(aoAt(ti, anchor));
      tag(clusters, own, ownS, parent, parentS);
    };
    const flower = (anchor: V3, own: number, ownS: number, parent: number, parentS: number, yaw: number, L: number): void => {
      const bud = rng() < 0.15;
      blossoms.anchor.push(anchor[0], anchor[1], anchor[2]);
      // pitch：花梗先往外再下垂（rotX 负 = 往下）
      // 花口朝外下方（不是正下方）：平视时也能看见花面
      blossoms.rot.push(yaw, -(0.12 + rng() * 0.32), (rng() - 0.5) * 0.4);
      blossoms.misc.push(bud ? L * 0.55 : L, rng(), 1);
      const k2 = rng();
      blossoms.color.push(0.95 + k2 * 0.04, 0.38 + k2 * 0.22, 0.55 + k2 * 0.18);
      blossoms.ao.push(aoAt(ti, anchor));
      tag(blossoms, own, ownS, parent, parentS);
    };
    for (const [li, limb] of limbs.entries()) {
      // 枝号（合并枝条表里的序号 + 1）和母枝在焊口处的弧长：叶 / 花的锚点钉在枝上，枝弯了整片跟着走
      const ownId = base + li + 1;
      const parentId = limb.parent > 0 ? base + limb.parent + 1 : 0;
      const parentS = limb.attach;
      const isSpur = limb.tag === 'spur';
      if (isSpur) {
        if (!limb.blossom) continue;
        const tip = limb.points[limb.points.length - 1];
        const prev = limb.points[limb.points.length - 2];
        const az0 = Math.atan2(tip[2] - prev[2], tip[0] - prev[0]);
        // 果台是一朵花簇：主树 9~12 朵从果台尖向四周垂下，第二棵 6~8 朵（果台自己没有弹簧：整簇花刚性跟着母枝在焊口处的位移走）
        const n = (ti === 0 ? 11 : 7) + Math.floor(rng() * 3);
        for (let k = 0; k < n; k++) {
          flower(tip, 0, 0, parentId, parentS, az0 + (k / n) * Math.PI * 2 + rng() * 0.6, 3.8 + rng() * 1.0);
        }
        // 果台尖四五片刚展开的嫩叶（偏红）——花后的叶丛
        for (let k = 0; k < 4; k++) {
          const yaw = az0 + (rng() - 0.5) * 2.4;
          leaves.anchor.push(tip[0], tip[1], tip[2]);
          leaves.rot.push(yaw, 0.3 + rng() * 0.4, (rng() - 0.5) * 0.6);
          leaves.misc.push(3.4 + rng() * 1.4, rng(), 0);
          leaves.color.push(0.55 + rng() * 0.1, 0.5 + rng() * 0.1, 0.2);
          leaves.ao.push(leafBase(ti, tip));
          tag(leaves, 0, 0, parentId, parentS);
        }
        continue;
      }
      if (limb.tag === 'tree-twig' || (limb.tag === 'tree' && li > 0)) {
        const twig = limb.tag === 'tree-twig';
        const pts = anchorsAlong(limb, twig ? 0.08 : 0.4, twig ? 0.97 : 0.95, twig ? 2.6 : 4.5);
        /** 一片叶：锚点（枝上弧长比例 s）、方位、俯仰、尺寸、颜色（外层嫩叶偏黄绿，内膛老叶偏深绿）。 */
        const leaf = (p: V3, s: number, yaw: number, L: number, pitchLo: number, pitchHi: number): void => {
          const ao = leafBase(ti, p);
          leaves.anchor.push(p[0], p[1], p[2]);
          leaves.rot.push(yaw, pitchLo + rng() * (pitchHi - pitchLo), (rng() - 0.5) * 1.4);
          leaves.misc.push(L * (0.85 + rng() * 0.3), rng(), 0);
          const k = rng();
          // 叶色：黄绿嫩叶 ↔ 深绿老叶，外层更嫩
          const young = 0.35 + 0.65 * ao;
          leaves.color.push(0.1 + k * 0.1 + young * 0.08, 0.34 + rng() * 0.12 + young * 0.04, 0.08 + rng() * 0.06);
          leaves.ao.push(ao);
          tag(leaves, ownId, s, parentId, parentS);
        };
        pts.forEach((a, i) => {
          // 二级枝的粗段（靠近基部，树冠内膛）只留一半叶子；外侧 40% 是细枝的着生区，叶子密
          if (!twig && a.tAlong < 0.55 && rng() < 0.5) return;
          const az = Math.atan2(a.t[2], a.t[0]);
          const side = i % 2 === 0 ? 1 : -1;
          // 真实叶幅：海棠叶 6~9 cm（垂丝海棠叶长 5~9 cm，取偏大一端才压得住 6 m 的树冠）、阔叶树 9~13 cm（含柄），靠枝梢略小
          const L = (broadleaf ? 9 + rng() * 4 : 6 + rng() * 3) * (0.8 + 0.2 * (1 - a.tAlong));
          // 细枝每个叶节三片叶（左右互生 + 一片朝上），俯仰范围拉宽给树冠体积；二级枝外侧每个节也三片、内侧一片
          leaf(a.p, a.tAlong, az + side * (0.7 + rng() * 0.9), L, -0.2, 0.8);
          if (twig || a.tAlong >= 0.55) {
            leaf(a.p, a.tAlong, az - side * (0.7 + rng() * 0.9), L, -0.2, 0.8);
            leaf(a.p, a.tAlong, az + (rng() - 0.5) * 2.5, L * 0.9, 0.3, 1.1);
          }
          // 枝梢的叶簇团：最后三个叶节各再发 4~6 片朝各个方向摊开的叶（树冠外层的"花束"）
          if (a.tAlong > 0.8) {
            const m = 3 + Math.floor(rng() * 2);
            for (let q = 0; q < m; q++) leaf(a.p, a.tAlong, az + (rng() - 0.5) * 4.2, L * (0.7 + rng() * 0.35), -0.3, 1.0);
          }
          // 当年生枝条的叶腋花（盛放的海棠：花簇与叶同节）；二年生枝上隔一节一簇 3 朵，内膛也有花
          if (twigBloom === 0 || (twigBloom > 0 && i % twigBloom === 1)) {
            for (let q = 0; q < bloomN; q++) flower(a.p, ownId, a.tAlong, parentId, parentS, az + (rng() - 0.5) * 3.0, 3.6 + rng() * 1.1);
          } else if (!broadleaf && !twig && i % 2 === 0) {
            for (let q = 0; q < 3; q++) flower(a.p, ownId, a.tAlong, parentId, parentS, az + (rng() - 0.5) * 3.0, 3.4 + rng() * 0.9);
          }
        });
        // 树冠包络内的填充叶团 / 花团：枝条骨架是水平的层状，叶和花只贴在细枝上就成了一层层薄板；
        // 沿细枝每个叶节在枝旁 4~14 cm（含上下 ±6 cm）再挂 3 片叶、隔一节再挂 1~2 张花团卡，把细枝之间的空隙填满——
        // 树冠是一团有体积的叶 / 花云，内膛那层是暗翡翠绿
        if (twig) {
          for (let i = 1; i < pts.length - 1; i++) {
            const a = pts[i];
            for (let q = 0; q < 3; q++) {
              const ang = rng() * Math.PI * 2;
              const r = 4 + rng() * 10;
              const p: V3 = [a.p[0] + Math.cos(ang) * r, a.p[1] + (rng() - 0.5) * 12, a.p[2] + Math.sin(ang) * r];
              leaf(p, a.tAlong, ang, (broadleaf ? 9 : 6) + rng() * 2.5, -0.5, 1.0);
            }
            // 隔一节挂 1~2 张花团卡（每张 ≈ 6 朵花）：树冠包络内部的远景花云
            if (i % 2 === 0 && ti < 2) {
              const m = rng() < 0.45 ? 2 : 1;
              for (let q = 0; q < m; q++) {
                const ang = rng() * Math.PI * 2;
                const r = 4 + rng() * 10;
                const p: V3 = [a.p[0] + Math.cos(ang) * r, a.p[1] + (rng() - 0.5) * 10, a.p[2] + Math.sin(ang) * r];
                cluster(p, ownId, a.tAlong, parentId, parentS);
              }
            }
          }
        }
      }
    }
    base += limbs.length;
  }
  group.add(instanced(leafGeometry(), leaves, mat, 'spring-leaves'));
  group.add(instanced(blossomGeometry(), blossoms, mat, 'spring-blossoms'));
  group.add(instanced(clusterGeometry(), clusters, mat, 'spring-clusters'));
  return { group, uniforms };
}
