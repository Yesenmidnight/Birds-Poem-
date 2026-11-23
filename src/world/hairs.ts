import {
  DoubleSide,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  type IUniform,
  type ShaderMaterial,
  type Vector3,
} from 'three';
import { makeLitMaterial, rgb, type LightingUniforms } from '../glsl/lit';
import { SWAY_GLSL } from './branchSway';

/**
 * 单三角形的微型附着物场（实例化、一次绘制）：嫩枝表面的植物表皮细绒毛，雪帽边缘迎风段的雾凇晶簇。
 * 每根 = 一个细三角形：底边贴在表面上（宽 width），尖端顺 dir 伸出 len；顶点着色器按实例属性现搭。
 * 两样都做得极克制：绒毛 0.2~0.4 mm、贴着枝面倒伏、alpha 0.28（正面几乎隐形，只在逆光掠射边缘泛一层绒光）；
 * 霜针 0.22~0.55 mm、顺着风向、只聚在迎风段的晶簇里、alpha 0.44（只靠高光微闪点缀）。
 * 坐标和 aSway 都在枝条坐标系里（和树枝同一个组），随枝一起弯。
 */
const HAIR_PARS = /* glsl */ `
${SWAY_GLSL}
attribute vec3 aBase;
attribute vec3 aDir;
attribute vec3 aNrm;
attribute vec2 aLW;
attribute vec2 aRnd;
varying float vT;
varying float vRnd;
`;

const HAIR_MAIN = /* glsl */ `
	float t = position.y;
	vec3 side = cross( aDir, aNrm );
	side = length( side ) > 1e-6 ? normalize( side ) : vec3( 1.0, 0.0, 0.0 );
	pos = aBase + side * ( position.x * aLW.y * ( 1.0 - t ) ) + ( aDir * aLW.x + aNrm * ( aLW.x * 0.06 ) ) * t;
	// 每根毛自己的小晶面朝向（霜针的闪点）：法线按实例随机数偏一偏
	vec3 facet = normalize( vec3( sin( aRnd.x * 61.0 ), sin( aRnd.x * 97.0 + 1.3 ), sin( aRnd.y * 83.0 + 2.1 ) ) );
	nrm = normalize( aNrm + facet * FACET * ( 0.4 + 0.6 * t ) );
	vT = t;
	vRnd = aRnd.x;
	pos = swayBend( pos );
`;

function hairMaterial(lighting: LightingUniforms, sway: Record<string, IUniform>): ShaderMaterial {
  return makeLitMaterial({
    lighting,
    side: DoubleSide,
    alphaToCoverage: true,
    defines: { FACET: '0.0' },
    uniforms: {
      ...sway,
      uHairCol: { value: rgb('#cdbfa8') },
      uHairGlow: { value: rgb('#f4d9a6') },
    },
    vertexPars: HAIR_PARS,
    vertexMain: HAIR_MAIN,
    fragmentPars: /* glsl */ `
uniform vec3 uHairCol;
uniform vec3 uHairGlow;
varying float vT;
varying float vRnd;
`,
    surface: /* glsl */ `
	Surf s;
	// 毛尖淡出，轮廓不成硬刺；长短不一（实例随机数）
	s.albedo = uHairCol * ( 0.85 + 0.3 * vRnd );
	s.ao = 1.0;
	s.wrap = 0.85;
	s.specTint = vec3( 1.0 );
	s.gloss = 0.35;
	s.specAmt = 0.03;
	s.alpha = ( 1.0 - smoothstep( 0.45, 1.0, vT ) ) * 0.28;
	return s;
`,
    extraLight: /* glsl */ `
	// 逆光透射：太阳在毛的背面时，细毛透出一圈柔和的暖金色毛边（越靠毛尖越亮，掠射角最强）
	float back = pow( max( dot( -V, uSunDir ), 0.0 ), 2.2 );
	float rim = 1.0 - abs( dot( N, V ) );
	return uSunColor * back * ( 0.25 + 0.75 * rim ) * vT * 0.9 * uHairGlow * sunShadow() * mix( 0.5, 1.0, vRnd ) + uSkyColor * 0.06 * vT;
`,
  });
}

function frostMaterial(lighting: LightingUniforms, sway: Record<string, IUniform>): ShaderMaterial {
  return makeLitMaterial({
    lighting,
    side: DoubleSide,
    alphaToCoverage: true,
    defines: { FACET: '1.1' },
    uniforms: {
      ...sway,
      uHairCol: { value: rgb('#e9f3ff') },
      uHairGlow: { value: rgb('#cfe6ff') },
    },
    vertexPars: HAIR_PARS,
    vertexMain: HAIR_MAIN,
    fragmentPars: /* glsl */ `
uniform vec3 uHairCol;
uniform vec3 uHairGlow;
varying float vT;
varying float vRnd;
`,
    surface: /* glsl */ `
	Surf s;
	s.albedo = uHairCol * ( 0.9 + 0.15 * vRnd );
	s.ao = 1.0;
	s.wrap = 0.9;
	// 霜针的闪光：每根针自己的晶面朝向（顶点着色器按随机数偏过），高光极锐，只有正好的那几根对着太阳闪
	s.specTint = vec3( 1.0 );
	s.gloss = 0.96;
	s.specAmt = 1.2;
	s.alpha = ( 1.0 - smoothstep( 0.6, 1.0, vT ) ) * 0.44;
	return s;
`,
    extraLight: /* glsl */ `
	float back = pow( max( dot( -V, uSunDir ), 0.0 ), 3.0 );
	return uSunColor * back * 0.35 * ( 0.3 + 0.7 * vT ) * uHairGlow * sunShadow() + uSkyColor * 0.2 * vT;
`,
  });
}

export class HairField {
  readonly mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  private readonly base: Float32Array;
  private readonly dir: Float32Array;
  private readonly nrm: Float32Array;
  private readonly lw: Float32Array;
  private readonly rnd: Float32Array;
  private readonly sway: Float32Array;
  private n = 0;

  constructor(lighting: LightingUniforms, readonly cap: number, kind: 'hair' | 'frost', sway: Record<string, IUniform>) {
    const g = new InstancedBufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0, 1, 0], 3));
    g.setIndex([0, 1, 2]);
    this.base = new Float32Array(cap * 3);
    this.dir = new Float32Array(cap * 3);
    this.nrm = new Float32Array(cap * 3);
    this.lw = new Float32Array(cap * 2);
    this.rnd = new Float32Array(cap * 2);
    this.sway = new Float32Array(cap * 3);
    g.setAttribute('aBase', new InstancedBufferAttribute(this.base, 3));
    g.setAttribute('aDir', new InstancedBufferAttribute(this.dir, 3));
    g.setAttribute('aNrm', new InstancedBufferAttribute(this.nrm, 3));
    g.setAttribute('aLW', new InstancedBufferAttribute(this.lw, 2));
    g.setAttribute('aRnd', new InstancedBufferAttribute(this.rnd, 2));
    g.setAttribute('aSway', new InstancedBufferAttribute(this.sway, 3));
    g.instanceCount = 0;
    this.mesh = new Mesh(g, kind === 'hair' ? hairMaterial(lighting, sway) : frostMaterial(lighting, sway));
    this.mesh.frustumCulled = false;
  }

  /** 加一根：base 贴表面的点，dir 伸出的方向（已归一化），nrm 表面法线，len / width 厘米，sway = (沿主枝 s, 自己枝内距离, 标志)。 */
  add(base: Vector3, dir: Vector3, nrm: Vector3, len: number, width: number, rnd: number, sway: [number, number, number]): void {
    if (this.n >= this.cap) return;
    const i = this.n++;
    this.base.set([base.x, base.y, base.z], i * 3);
    this.dir.set([dir.x, dir.y, dir.z], i * 3);
    this.nrm.set([nrm.x, nrm.y, nrm.z], i * 3);
    this.lw.set([len, width], i * 2);
    this.rnd.set([rnd, rnd * 0.618], i * 2);
    this.sway.set(sway, i * 3);
  }

  commit(): void {
    const g = this.mesh.geometry;
    g.instanceCount = this.n;
    for (const a of Object.values(g.attributes)) a.needsUpdate = true;
  }
}
