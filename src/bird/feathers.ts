import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Matrix4,
  Quaternion,
  Vector3,
  ShaderMaterial,
} from 'three';
import { makeLitMaterial, rgb, type LightingUniforms } from '../glsl/lit';

/**
 * 正羽（飞羽、覆羽、尾羽）：一片羽毛是一张带弧度、带扭转的窄带网格，
 * 宽度沿羽轴按“基部收窄 → 中段最宽 → 端部收尖”的剖面变化，两缘不对称（飞羽的外缘更窄）。
 * 羽小枝的斜纹、羽轴、羽缘磨损全部在片元着色器里按物理坐标现算。
 *
 * 可展翅：每片羽带一份 FeatherRig——从收拢态到满展态绕自己羽根转多少、平移到哪。
 * 变形全在顶点着色器里做（绕羽根旋转 + 平移，按 open 插值），open = 0 时全部是恒等变换，收拢态逐顶点不变。
 */
export type FeatherColorFn = (across: number, along: number) => Color;

/** 羽毛类别：翼下腹面配色、羽轴处理按它区分。 */
export const FEATHER_KIND = { primary: 0, secondary: 1, covert: 2, other: 3 } as const;

export interface FeatherSpec {
  length: number;
  /** 羽片全宽。 */
  width: number;
  /** 前缘一侧占全宽的比例，0.5 为左右对称。 */
  asym: number;
  /** 基部裸露羽轴所占长度比例。 */
  bare: number;
  /** 最宽处位置（0..1）。 */
  tipPos: number;
  /** 端部收尖的指数，越大越尖，小于 1 则偏圆。 */
  tipPow: number;
  /** 横向凹弧深度。 */
  cup: number;
  /** 沿长度方向的弯曲。 */
  bow: number;
  /** 沿长度方向的扭转（弧度）。 */
  twist: number;
  color: FeatherColorFn;
  /** 羽缘柔度：0 为清晰的羽片，1 为边缘过渡变宽、磨损缺口变浅（肩羽用，让它像从绒毛里长出来）。 */
  edgeSoft?: number;
  /**
   * 顺向叠瓦的羽片被前一片压住的位置（沿羽轴 0..1，收拢翅的覆羽/次级飞羽用）：
   * 叠压 AO 从这里往羽尖过渡，露在外面的那一截才有“从叠缝里暗、到羽尖亮”的层次。
   * 0（默认）= 按羽根到羽尖过渡（尾羽这类侧缘相压的羽片）。
   */
  expose?: number;
  /** 扇开信息（尾羽用）：[左右侧 ±1, 第几对 0..1]。配合材质的 uSpread 绕羽根竖直轴转动。 */
  fan?: [number, number];
}

/**
 * 可展翅羽片的绑定信息（收拢翅用；尾羽不传）。
 * root / fanAxis 都在最终几何的坐标系里（建翅时几何会减去翅枢轴，这里也要用减过枢轴的坐标）。
 */
/**
 * 一片羽的展翅绑定：收拢态 → 满展态是绕羽根的一次刚体旋转 + 平移，open 在两个姿态之间按羽片连续插值
 * （旋转角按 open 缩放、位移按 open 线性），open = 0 时逐顶点恒等。
 * 满展态的布局由 wingTail.ts 的三段骨骼链（肩 → 肘 → 腕 → 腕掌）在翼平面里生成，再换算成
 * "收拢态羽片标架（羽轴 d、背侧法线 n）→ 展开态羽片标架"的旋转。
 */
export interface FeatherRig {
  kind: number;
  /** 收拢态羽根（翅枢轴坐标系）：旋转中心。 */
  root: Vector3;
  /** 收拢态 → 展开态的旋转：单位轴 + 角度（弧度）。 */
  axis: Vector3;
  angle: number;
  /** 展开态羽根 − 收拢态羽根。 */
  trans: Vector3;
  /** 满展时沿羽长的缩放：修圆翼尖，或把收拢时为了翼面而偏短的次级飞羽放到真实比例。 */
  lenScale: number;
  /** 满展时白翈（羽轴局部 +x 一侧）的宽度缩放：收拢时是细白边，展开后按真鸟折扇的宽窄调。 */
  whiteScale: number;
  /** 跟随权重：羽片 1；翼内底壳按部位 0~0.9 渐变（后段留在体表上）。 */
  weight: number;
}

/**
 * 把羽片标架 (羽轴 d0、背侧法线 n0) 转到 (d1, n1) 的旋转，返回单位轴 + 角度（≤ π）。
 * 两个标架都是右手系（第三轴 = d × n），所以这总是一个纯旋转。
 */
export function frameRotation(d0: Vector3, n0: Vector3, d1: Vector3, n1: Vector3): { axis: Vector3; angle: number } {
  // 法线先对羽轴正交化（排里的法线是插值出来的，和羽轴差几度）
  const n0o = n0.clone().addScaledVector(d0, -n0.dot(d0)).normalize();
  const n1o = n1.clone().addScaledVector(d1, -n1.dot(d1)).normalize();
  const t0 = new Vector3().crossVectors(d0, n0o);
  const t1 = new Vector3().crossVectors(d1, n1o);
  const r = new Matrix4().makeBasis(d1, n1o, t1).multiply(new Matrix4().makeBasis(d0, n0o, t0).transpose());
  const q = new Quaternion().setFromRotationMatrix(r);
  if (q.w < 0) q.set(-q.x, -q.y, -q.z, -q.w);
  const s = Math.sqrt(Math.max(1 - q.w * q.w, 0));
  return {
    axis: s > 1e-6 ? new Vector3(q.x / s, q.y / s, q.z / s) : new Vector3(0, 1, 0),
    angle: 2 * Math.acos(Math.min(1, Math.max(-1, q.w))),
  };
}

/** 横向 9 列（中线两侧各 4 列），靠外缘更密一些以便弯出弧度。 */
const COLS = [1, 0.75, 0.5, 0.25, 0, 0.25, 0.5, 0.75, 1];
const ROWS = 18;

function widthProfile(v: number, tipPos: number, tipPow: number): number {
  const w =
    v < tipPos
      ? Math.pow(Math.sin((v / tipPos) * Math.PI * 0.5), 0.6)
      : Math.pow(Math.cos(((v - tipPos) / (1 - tipPos)) * Math.PI * 0.5), tipPow);
  return Math.max(w, 0.012);
}

/**
 * 可展翅的顶点变形（羽片材质、翼内底壳材质、阴影深度材质共用同一套）：
 * 1. 贴体压弯随 open 释放：顶点 x 从贴体值过渡到未贴体的直羽值；
 * 2. 每片羽绕收拢态的羽根转 open × 角度（Rodrigues），再按 open 平移到展开态的羽根；
 * 3. 满展时沿羽长、白翈宽度各有一个缩放，按 open 渐变（收拢态完全不受影响）；
 * 4. 跟随权重 < 1 的顶点（翼内底壳）在原位和变形结果之间混合。
 * 顶点属性槽只有 16 个，绑定数据打包成三个 vec4 + 一个 vec4 杂项。
 */
export const WING_SKIN_PARS = /* glsl */ `
// 收拢态羽根 xyz、跟随权重
attribute vec4 aRigA;
// 展开态位移 xyz（展开羽根 − 收拢羽根）、满展时沿羽长的缩放
attribute vec4 aRigB;
// 收拢 → 展开的旋转轴 xyz（单位）、角度（弧度）
attribute vec4 aRigC;
// 未贴体的 x、满展时白翈宽度缩放、羽类别
attribute vec4 aMisc;
uniform float uOpen;

vec3 wingRot( vec3 v, vec3 ax, float ang ) {
	float c = cos( ang ), s = sin( ang );
	return v * c + cross( ax, v ) * s + ax * dot( ax, v ) * ( 1.0 - c );
}
vec3 wingSkinDir( vec3 d ) {
	if ( uOpen < 1e-5 || aRigA.w < 1e-4 ) return d;
	return mix( d, wingRot( d, aRigC.xyz, aRigC.w * uOpen ), aRigA.w );
}
// axis 是这片羽的羽轴方向（收拢态），调用后换成变形后的方向
vec3 wingSkinPoint( vec3 p, vec3 nrm, inout vec3 axis ) {
	if ( uOpen < 1e-5 ) return p;
	float w = aRigA.w;
	p.x = mix( p.x, aMisc.x, smoothstep( 0.0, 0.5, uOpen ) * w );
	if ( w < 1e-4 ) return p;
	vec3 rel = p - aRigA.xyz;
	float along = dot( rel, axis );
	vec3 across = rel - along * axis;
	// 白翈在羽轴局部 +x 一侧（= axis × nrm）
	vec3 xDir = cross( axis, nrm );
	float xl = length( xDir );
	float sgn = xl > 1e-5 ? step( 0.0, dot( across, xDir / xl ) ) : 1.0;
	float wScale = mix( 1.0, aMisc.y, uOpen * sgn );
	float lScale = mix( 1.0, aRigB.w, uOpen );
	rel = axis * ( along * lScale ) + across * wScale;
	float ang = aRigC.w * uOpen;
	axis = wingRot( axis, aRigC.xyz, ang );
	vec3 q = wingRot( rel, aRigC.xyz, ang ) + aRigA.xyz + uOpen * aRigB.xyz;
	return mix( p, q, w );
}
`;

/** 一只翅的展翅 uniform：羽片材质、底壳材质、阴影深度材质共用同一份，改一次全同步。 */
export interface WingRigUniforms {
  uOpen: { value: number };
}

/** 把一批羽毛合并进一张网格，一次绘制。 */
export class FeatherBatch {
  private readonly pos: number[] = [];
  private readonly nrm: number[] = [];
  private readonly frag: number[] = [];
  private readonly col: number[] = [];
  private readonly phy: number[] = [];
  private readonly size: number[] = [];
  private readonly soft: number[] = [];
  private readonly fan: number[] = [];
  private readonly axis: number[] = [];
  private readonly exp: number[] = [];
  private readonly idx: number[] = [];
  /** 可展翅绑定：羽根 + 权重、位移 + 羽长缩放、旋转轴角、未贴体的 x、白翈缩放、类别 */
  private readonly rigA: number[] = [];
  private readonly rigB: number[] = [];
  private readonly rigC: number[] = [];
  private readonly openX: number[] = [];
  private readonly white: number[] = [];
  private readonly kind: number[] = [];
  /** 每片羽的羽根、羽轴方向、长度和它在合并网格里的起始顶点，贴体弯曲时按羽长参数分段用。 */
  private readonly frames: { root: Vector3; dir: Vector3; len: number; base: number }[] = [];
  private base = 0;
  private conformed = false;
  count = 0;

  add(spec: FeatherSpec, m: Matrix4, rig?: FeatherRig): void {
    const verts = (ROWS + 1) * 9;
    const local = new Float32Array(verts * 3);
    const frag = new Float32Array(verts * 2);
    const phy = new Float32Array(verts * 2);
    const col = new Float32Array(verts * 3);
    const halfLead = spec.width * spec.asym;
    const halfTrail = spec.width * (1 - spec.asym);

    for (let i = 0; i <= ROWS; i++) {
      const u = spec.bare + (1 - spec.bare) * (i / ROWS);
      const w = widthProfile((u - spec.bare) / (1 - spec.bare), spec.tipPos, spec.tipPow);
      for (let c = 0; c < 9; c++) {
        const side = c < 4 ? -1 : c > 4 ? 1 : 0;
        const f = COLS[c];
        const half = side < 0 ? halfLead : halfTrail;
        const x = side * half * w * f;
        const y = u * spec.length;
        const z0 = spec.cup * f * f * half * w + spec.bow * spec.length * u * u;
        const a = spec.twist * u;
        const k = (i * 9 + c) * 3;
        local[k] = x * Math.cos(a) - z0 * Math.sin(a);
        local[k + 1] = y;
        local[k + 2] = x * Math.sin(a) + z0 * Math.cos(a);
        frag.set([side * f, u], (i * 9 + c) * 2);
        phy.set([x, y], (i * 9 + c) * 2);
        const color = spec.color(side * f, u);
        col.set([color.r, color.g, color.b], k);
      }
    }

    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(local, 3));
    const index: number[] = [];
    for (let i = 0; i < ROWS; i++) {
      for (let c = 0; c < 8; c++) {
        const a = i * 9 + c;
        const b = a + 1;
        const d = a + 9;
        const e = d + 1;
        index.push(a, b, d, b, e, d);
      }
    }
    // 镜像矩阵（行列式为负）会翻转绕序：三角形反过来，左翅贴体后重算的法线才和右翅一样朝背侧
    if (m.determinant() < 0) {
      for (let t = 0; t < index.length; t += 3) {
        const tmp = index[t + 1];
        index[t + 1] = index[t + 2];
        index[t + 2] = tmp;
      }
    }
    g.setIndex(index);
    g.computeVertexNormals();
    g.applyMatrix4(m);

    const axisW = new Vector3(0, 1, 0).transformDirection(m);
    this.frames.push({
      root: new Vector3().setFromMatrixPosition(m),
      dir: axisW.clone(),
      len: spec.length,
      base: this.base,
    });
    const p = g.attributes.position.array as Float32Array;
    const n = g.attributes.normal.array as Float32Array;
    for (let i = 0; i < verts; i++) {
      this.pos.push(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
      this.openX.push(p[i * 3]);
      this.nrm.push(n[i * 3], n[i * 3 + 1], n[i * 3 + 2]);
      this.frag.push(frag[i * 2], frag[i * 2 + 1]);
      this.col.push(col[i * 3], col[i * 3 + 1], col[i * 3 + 2]);
      this.phy.push(phy[i * 2], phy[i * 2 + 1]);
      this.size.push(spec.length, spec.width);
      this.soft.push(spec.edgeSoft ?? 0);
      this.fan.push(spec.fan?.[0] ?? 0, spec.fan?.[1] ?? 0);
      this.axis.push(axisW.x, axisW.y, axisW.z);
      this.exp.push(spec.expose ?? 0);
      if (rig) {
        this.rigA.push(rig.root.x, rig.root.y, rig.root.z, rig.weight);
        this.rigB.push(rig.trans.x, rig.trans.y, rig.trans.z, rig.lenScale);
        this.rigC.push(rig.axis.x, rig.axis.y, rig.axis.z, rig.angle);
        this.white.push(rig.whiteScale);
        this.kind.push(rig.kind);
      } else {
        this.rigA.push(0, 0, 0, 0);
        this.rigB.push(0, 0, 0, 1);
        this.rigC.push(0, 1, 0, 0);
        this.white.push(1);
        this.kind.push(FEATHER_KIND.other);
      }
    }
    for (const i of index) this.idx.push(this.base + i);
    this.base += verts;
    this.count++;
    g.dispose();
  }

  /**
   * 让每片羽顺着体表弯曲贴合（收拢翅用）：沿羽长按参数 u 取横截面，把整段横截面沿 x 平移到
   * "体表半宽 + 羽根离面偏移"上——离面偏移沿羽长保持羽根的设计值，所以羽片自身的杯度、弓度、叠压关系
   * 全都保留，只是不再是一根悬空的直尺弦线；身体往后收窄时翅尖会跟着体表往中线收拢（V 字抱拢）。
   * 未贴体前的 x 存进 openX，展翅时顶点着色器按 open 把压弯释放回直羽（自然的气动拱度）。
   * 体表按每个顶点自己的 (y, z) 取，而不是按羽轴中心线取：叠在一起的两片羽在同一点拿到的是同一个
   * 体表值，彼此只差设计偏移（0.003~0.005 cm），叠压顺序才不会被体表曲率的微小差别打乱。
   * surface 为 (y, z) 处的体表半宽；左右翅都按 |x| 处理。
   */
  conformToBody(surface: (y: number, z: number) => number): void {
    for (const f of this.frames) {
      const verts = (ROWS + 1) * 9;
      const sign = f.root.x >= 0 ? 1 : -1;
      const offRoot = Math.abs(f.root.x) - surface(f.root.y, f.root.z);
      for (let v = f.base; v < f.base + verts; v++) {
        const px = this.pos[v * 3];
        const py = this.pos[v * 3 + 1];
        const pz = this.pos[v * 3 + 2];
        const u = Math.min(
          1,
          Math.max(0, ((px - f.root.x) * f.dir.x + (py - f.root.y) * f.dir.y + (pz - f.root.z) * f.dir.z) / f.len),
        );
        // 顶点相对这一行弦线中心的横向偏差（杯度、弓度、羽面横向），原样保留
        const cx = Math.abs(f.root.x + f.dir.x * f.len * u);
        const local = sign * px - cx;
        this.pos[v * 3] = sign * (surface(py, pz) + offRoot + local);
      }
    }
    this.conformed = true;
  }

  build(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('aFrag', new BufferAttribute(new Float32Array(this.frag), 2));
    g.setAttribute('aCol', new BufferAttribute(new Float32Array(this.col), 3));
    g.setAttribute('aPhy', new BufferAttribute(new Float32Array(this.phy), 2));
    g.setAttribute('aSize', new BufferAttribute(new Float32Array(this.size), 2));
    g.setAttribute('aSoft', new BufferAttribute(new Float32Array(this.soft), 1));
    g.setAttribute('aFan', new BufferAttribute(new Float32Array(this.fan), 2));
    g.setAttribute('aAxis', new BufferAttribute(new Float32Array(this.axis), 3));
    g.setAttribute('aExp', new BufferAttribute(new Float32Array(this.exp), 1));
    g.setAttribute('aRigA', new BufferAttribute(new Float32Array(this.rigA), 4));
    g.setAttribute('aRigB', new BufferAttribute(new Float32Array(this.rigB), 4));
    g.setAttribute('aRigC', new BufferAttribute(new Float32Array(this.rigC), 4));
    const n = this.kind.length;
    const misc = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) misc.set([this.openX[i], this.white[i], this.kind[i], 0], i * 4);
    g.setAttribute('aMisc', new BufferAttribute(misc, 4));
    g.setIndex(this.idx);
    if (this.conformed) {
      // 弯曲过，法线按弯曲后的网格重算
      g.computeVertexNormals();
    } else {
      g.setAttribute('normal', new BufferAttribute(new Float32Array(this.nrm), 3));
    }
    g.computeBoundingSphere();
    return g;
  }
}

/** 由羽根、指向羽尖的方向、羽片朝向构造一片羽毛的局部坐标系（羽轴 = +Y，羽片法线 = +Z）。 */
export function featherMatrix(root: Vector3, tipDir: Vector3, vaneNormal: Vector3): Matrix4 {
  const y = tipDir.clone().normalize();
  const z = vaneNormal.clone().addScaledVector(y, -vaneNormal.dot(y)).normalize();
  const x = new Vector3().crossVectors(y, z).normalize();
  z.crossVectors(x, y).normalize();
  return new Matrix4().makeBasis(x, y, z).setPosition(root);
}

/** 左右镜像一片已经放在右半身的羽毛：世界和局部坐标同时关于 x=0 翻转，羽色分区才会正确。 */
export function mirrorMatrix(m: Matrix4): Matrix4 {
  const out = m.clone();
  const e = out.elements;
  for (const i of [0, 4, 8, 12]) e[i] = -e[i];
  return out;
}

const FEATHER_VERTEX_PARS = /* glsl */ `
${WING_SKIN_PARS}
attribute vec2 aFrag;
attribute vec3 aCol;
attribute vec2 aPhy;
attribute vec2 aSize;
attribute float aSoft;
attribute vec2 aFan;
attribute vec3 aAxis;
// 顺向叠瓦的羽片：被前一片压住的位置（沿羽轴 0..1），0 表示不启用
attribute float aExp;
// 羽类别（aRigB.z：0 初级 / 1 次级三级 / 2 覆羽 / 3 其它）：腹面配色用
// 尾羽扇开角（弧度）：每片羽绕羽根所在的竖直轴转动，外侧的羽转得更多
uniform float uSpread;
varying vec2 vFrag;
varying vec3 vCol;
varying vec2 vPhy;
varying vec2 vSize;
varying float vSoft;
varying vec3 vAxisW;
varying float vExp;
varying float vKind;
`;

const FEATHER_VERTEX_MAIN = /* glsl */ `
	vFrag = aFrag;
	vCol = aCol;
	vPhy = aPhy;
	vSize = aSize;
	vSoft = aSoft;
	vExp = aExp;
	vKind = aMisc.z;
	vec3 axis = aAxis;
	// 可展翅：绕羽根旋转 + 平移到展开态的羽根（open = 0 时恒等；尾羽没有绑定信息、uOpen 为 0）
	pos = wingSkinPoint( pos, nrm, axis );
	nrm = wingSkinDir( nrm );
	// 几何原点就是羽根（尾基），直接绕局部 Y 轴转
	float fan = -uSpread * aFan.x * ( 0.2 + 0.8 * aFan.y );
	float fc = cos( fan );
	float fs = sin( fan );
	pos = vec3( pos.x * fc + pos.z * fs, pos.y, -pos.x * fs + pos.z * fc );
	nrm = vec3( nrm.x * fc + nrm.z * fs, nrm.y, -nrm.x * fs + nrm.z * fc );
	axis = vec3( axis.x * fc + axis.z * fs, axis.y, -axis.x * fs + axis.z * fc );
	vAxisW = normalize( mat3( modelMatrix ) * axis );
`;

const FEATHER_FRAGMENT_PARS = /* glsl */ `
uniform vec3 uVentPrim;
uniform vec3 uVentSec;
uniform vec3 uVentShaft;
uniform float uTrans;
varying vec2 vFrag;
varying vec3 vCol;
varying vec2 vPhy;
varying vec2 vSize;
varying float vSoft;
varying vec3 vAxisW;
varying float vExp;
varying float vKind;
`;

const FEATHER_SURFACE = /* glsl */ `
	float edge = abs( vFrag.x );
	float along = vFrag.y;
	// 羽小枝：与羽轴成约 50° 的细纹；细节小于一个像素时淡出，避免摩尔纹
	float phase = ( vPhy.y - 1.15 * abs( vPhy.x ) ) * 62.0;
	float fw = fwidth( phase );
	float stripe = 0.5 + 0.5 * sin( phase * 6.2831853 );
	float atten = 1.0 - smoothstep( 0.1, 0.35, fw );
	float lum = dot( vCol, vec3( 0.3, 0.5, 0.2 ) );
	vec3 alb = vCol * ( 1.0 + ( stripe - 0.5 ) * 0.16 * atten );
	alb *= mix( 0.6, 1.0, smoothstep( 0.0, 0.35, along ) );
	// 羽小枝成束形成的纵向细纹；靠近后缘（被上一片压住的一侧）略暗
	float streak = snoise( vec3( vPhy.x * 70.0, vPhy.y * 16.0, vSize.x * 53.0 ) ) * 0.5 + 0.5;
	float sAtten = 1.0 - smoothstep( 0.15, 0.5, fwidth( vPhy.y * 16.0 ) );
	alb *= 1.0 + ( streak - 0.5 ) * 0.12 * sAtten;
	alb *= 1.0 - 0.12 * smoothstep( 0.55, 1.0, vFrag.x );
	// 羽轴：一条细而有光泽的中线（初级飞羽的羽轴反而更深更清晰）
	float rachis = exp( - pow( vPhy.x / 0.013, 2.0 ) ) * ( 1.0 - smoothstep( 0.85, 1.0, along ) );
	float primShaft = 1.0 - step( 0.5, vKind );
	alb = mix( alb, mix( alb * 1.4 + 0.015, alb * 0.45, primShaft ), rachis * 0.6 );
	// 正反面：翼下（腹面）是银灰白的珍珠质感，深色羽轴清晰可读；翼上按羽色函数。
	// 几何法线两翅都朝背侧（左翅连法线一起镜像），但镜像会翻转绕序，gl_FrontFacing 左右相反，
	// 所以用未被翻转的世界法线和视线点积判；尾羽两面色相同
	float dorsal = step( 0.0, dot( normalize( vWorldN ), V ) );
	dorsal = max( dorsal, step( 2.5, vKind ) );
	vec3 vent = mix( uVentPrim, uVentSec, step( 0.5, vKind ) );
	// 腹面内翈（靠身体一侧）略暗一点，羽轴一条深色细线
	vent *= 1.0 - 0.18 * smoothstep( 0.1, -0.9, vFrag.x );
	vent = mix( vent, uVentShaft, rachis * 0.85 );
	alb = mix( vent, alb, dorsal );
	// 羽缘不规则的磨损缺口：细碎而浅，白边保持连续，不会啃成锯齿；柔度高的羽毛缺口更浅
	float fray = snoise( vec3( vPhy.y * 55.0, vSize.x * 37.0, 3.0 ) ) * 0.5 + 0.5;
	float fray2 = snoise( vec3( vPhy.y * 150.0, vSize.x * 91.0, 7.0 ) ) * 0.5 + 0.5;
	float wear = fray * 0.6 + fray2 * 0.4;
	float lim = mix( 0.965 + 0.035 * wear, 0.975 + 0.025 * wear, vSoft );
	float aa = fwidth( edge ) * ( 1.0 + 2.5 * vSoft ) + 1e-5;
	float alpha = 1.0 - smoothstep( lim - aa, lim + aa, edge );
	Surf s;
	s.alpha = alpha;
	s.albedo = alb;
	// 羽根被上一片羽毛压住：环境光遮蔽向羽尖过渡，叠压才有层次。
	// 顺向叠瓦的羽片（aExp > 0）露在外面的只有羽尖那一截，暗影要从叠缝处（aExp）才开始往羽尖过渡，
	// 不然露出来的整截都是亮的，一片片叠压读不出来
	float aoRoot = smoothstep( 0.0, 0.55, along );
	float aoShingle = smoothstep( vExp - 0.06, vExp + 0.22, along );
	s.ao = mix( mix( 0.55, 1.0, aoRoot ), mix( 0.62, 1.0, aoShingle ), step( 0.01, vExp ) );
	s.wrap = 0.35;
	s.specTint = mix( vec3( 1.0 ), vec3( 0.8, 0.85, 1.0 ), 1.0 - dorsal );
	s.gloss = mix( 0.68, 0.5, 1.0 - dorsal );
	s.specAmt = mix( mix( 0.04, 0.05, 1.0 - smoothstep( 0.05, 0.25, lum ) ), 0.07, 1.0 - dorsal );
	return s;
`;

const FEATHER_EXTRA_LIGHT = /* glsl */ `
	// 沿羽轴方向的各向异性光泽：黑色飞羽那种丝缎般的反光（收敛一些，不然叠成一整片黑羽时像漆皮）
	vec3 T = normalize( vAxisW );
	vec3 H = normalize( uSunDir + V );
	float tdh = dot( T, H );
	float sinTH = sqrt( max( 1.0 - tdh * tdh, 0.0 ) );
	float lum = dot( vCol, vec3( 0.3, 0.5, 0.2 ) );
	float dark = 1.0 - smoothstep( 0.05, 0.25, lum );
	float amt = mix( 0.02, 0.08, dark );
	vec3 tint = mix( vec3( 1.0 ), vec3( 0.78, 0.84, 1.0 ), dark );
	vec3 spec = uSunColor * pow( sinTH, 110.0 ) * amt * sunShadow() * tint;
	// 逆光透射：太阳在羽片背面时，薄羽翈透出一层暖光（羽轴处厚、几乎不透），翼下不死黑
	float back = max( dot( -V, uSunDir ), 0.0 );
	float phase = ( vPhy.y - 1.15 * abs( vPhy.x ) ) * 62.0;
	float rachisT = exp( - pow( vPhy.x / 0.016, 2.0 ) );
	vec3 trans = mix( s.albedo, vec3( 0.62, 0.52, 0.44 ), 0.4 );
	vec3 glow = uSunColor * pow( back, 3.0 ) * uTrans * ( 1.0 - 0.85 * rachisT ) * trans * sunShadow();
	return spec + glow;
`;

export function makeFeatherMaterial(lighting: LightingUniforms, rig: WingRigUniforms): ShaderMaterial {
  return makeLitMaterial({
    lighting,
    side: DoubleSide,
    alphaToCoverage: true,
    uniforms: {
      uSpread: { value: 0 },
      uOpen: rig.uOpen,
      uVentPrim: { value: rgb('#c3c2c9') },
      uVentSec: { value: rgb('#ebe6dc') },
      uVentShaft: { value: rgb('#5c5153') },
      uTrans: { value: 0.55 },
    },
    vertexPars: FEATHER_VERTEX_PARS,
    vertexMain: FEATHER_VERTEX_MAIN,
    fragmentPars: FEATHER_FRAGMENT_PARS,
    surface: FEATHER_SURFACE,
    extraLight: FEATHER_EXTRA_LIGHT,
  });
}

/** 翅膀投影用的深度材质：和羽片材质同一套顶点变形，否则展开的翅投出去的还是收拢态的影子。 */
export function makeWingDepthMaterial(rig: WingRigUniforms): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { uOpen: rig.uOpen },
    vertexShader: /* glsl */ `
${WING_SKIN_PARS}
attribute vec3 aAxis;
void main() {
	vec3 axis = aAxis;
	vec3 pos = wingSkinPoint( position, normal, axis );
	gl_Position = projectionMatrix * modelViewMatrix * vec4( pos, 1.0 );
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
