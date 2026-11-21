import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Matrix4,
  Quaternion,
  SphereGeometry,
  Vector3,
  type IUniform,
  type ShaderMaterial,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeLitMaterial, rgb, type LightingUniforms } from '../glsl/lit';
import { TAU, clamp, lerp, smoothstep } from '../util/math';
import type { BodyParams } from './bodySdf';

/**
 * 喙、眼、眼睑、瞬膜、腿脚。喙眼全部直接在鸟的局部坐标里生成；
 * 上下喙和上下眼睑各自是独立的网格，挂在铰链/眼局部坐标系下由 Bird 驱动。
 * 腿脚要贴着世界里的栖枝抓握，先在世界坐标里按栖枝算好再转回鸟的局部坐标。
 */
const UP = new Vector3(0, 1, 0);
const X_AXIS = new Vector3(1, 0, 0);

// ---------------------------------------------------------------- 喙

/**
 * 上喙或下喙：尖巧的小三角锥放样——上喙脊带自然微下弯，截面是半椭圆，
 * 嘴缝处压出一道凹痕形成口角；嘴缝那一面用独立顶点封口，保留一条清晰的合缝线。
 * 两者都绕嘴根铰链张合（Bird.setJawOpen）。
 */
export function buildMandible(p: BodyParams, upper: boolean): BufferGeometry {
  const rings = 18;
  const radial = 14;
  const base = new Vector3(...p.beakBase);
  const dir = new Vector3(...p.beakDir).normalize();
  const up = new Vector3().crossVectors(dir, X_AXIS).normalize();
  // 上下喙的嘴缝面错开一点点，合拢时不共面
  const seamY = upper ? 0.002 : -0.002;

  const ringPoint = (i: number, j: number): [number, number, number] => {
    const s = i / rings;
    // 嘴短了，基部也相应收细一点，锥角和原来差不多（约 23°），仍是尖巧的小三角锥
    const w = 0.168 * Math.pow(1 - s, 0.72) + 0.0035;
    const hu = 0.15 * Math.pow(1 - s, 0.85) + 0.0035;
    const hl = 0.088 * (1 - s) * (1 - s) + 0.0025;
    const c = base.clone().addScaledVector(dir, s * p.beakLength).addScaledVector(up, -0.07 * s * s * p.beakLength);
    const th = upper ? (j / radial) * Math.PI : Math.PI + (j / radial) * Math.PI;
    const sy = Math.sin(th);
    const h = sy >= 0 ? hu : hl;
    const gape = 1 - 0.11 * Math.exp(-((sy / 0.16) ** 2));
    const x = w * Math.cos(th) * gape;
    const y = h * sy * gape + seamY;
    return [c.x + x, c.y + up.y * y, c.z + up.z * y];
  };

  const pos: number[] = [];
  const seam: number[] = [];
  const idx: number[] = [];
  // 外壳：一节节半椭圆截面放样
  for (let i = 0; i <= rings; i++) {
    for (let j = 0; j <= radial; j++) {
      pos.push(...ringPoint(i, j));
      seam.push(0);
      if (i < rings && j < radial) {
        const a = i * (radial + 1) + j;
        const b = a + 1;
        const cc = a + radial + 1;
        const d = cc + 1;
        idx.push(a, b, cc, b, d, cc);
      }
    }
  }
  // 嘴缝面：只复制每圈的两个边点，连成一条从嘴根到嘴尖的窄带
  const seamBase = pos.length / 3;
  for (let i = 0; i <= rings; i++) {
    pos.push(...ringPoint(i, 0), ...ringPoint(i, radial));
    seam.push(1, 1);
    if (i < rings) {
      const a = seamBase + i * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('aSeam', new Float32BufferAttribute(seam, 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * 喙壳材质。嘴根一段垫成绒羽色：四周的细短白绒搭在喙根上，壳面是半透明的毛丝，
 * 底下若是黑的，毛缝里就会透出黑底、看着像一圈锯齿；垫成白色后毛丝和底色融为一体，
 * 黑喙像是从白绒里长出来的。嘴缝面永远是暗的，张嘴时口腔里不会发白。
 */
export function makeBeakMaterial(lighting: LightingUniforms, p: BodyParams, upper: boolean): ShaderMaterial {
  const dir = new Vector3(...p.beakDir).normalize();
  const up = new Vector3().crossVectors(dir, X_AXIS).normalize();
  return makeLitMaterial({
    lighting,
    side: DoubleSide,
    uniforms: {
      uBeakCol: { value: rgb('#0d0c0d') },
      uBaseCol: { value: rgb('#e6e1d8') },
      uBeakDir: { value: dir },
      uBeakUp: { value: up },
      uBeakSide: { value: upper ? 1 : -1 },
    },
    fragmentPars: /* glsl */ `
uniform vec3 uBeakCol;
uniform vec3 uBaseCol;
uniform vec3 uBeakDir;
uniform vec3 uBeakUp;
uniform float uBeakSide;
varying vec3 vObj;
varying float vSeam;
`,
    vertexPars: /* glsl */ `
attribute float aSeam;
varying vec3 vObj;
varying float vSeam;
`,
    vertexMain: /* glsl */ `
	vObj = position;
	vSeam = aSeam;
`,
    surface: /* glsl */ `
	float along = dot( vObj, uBeakDir );
	float grain = snoise( vObj * 120.0 ) * 0.5 + 0.5;
	float base = 1.0 - smoothstep( 0.1, 0.2, along + ( snoise( vObj * 60.0 ) - 0.5 ) * 0.05 );
	// 绒羽色只垫在嘴根朝外的那一面（上颌的上侧、下颌的下侧，也就是合拢时被毛搭住的地方）；
	// 嘴缝面和靠近嘴缝的内侧永远是暗的：合缝是一条线，张嘴时口腔里也不发白
	base *= ( 1.0 - vSeam ) * smoothstep( 0.06, 0.12, uBeakSide * dot( vObj, uBeakUp ) );
	Surf s;
	s.albedo = mix( uBeakCol * ( 0.8 + 0.4 * grain ), uBaseCol * ( 0.92 + 0.12 * grain ), base );
	s.ao = 1.0;
	s.wrap = mix( 0.3, 0.55, base );
	s.specTint = vec3( 1.0 );
	s.gloss = mix( 0.62, 0.3, base );
	// 嘴缝面是平的、朝上对着天光，高光要压掉，不然张嘴时口腔里会泛出一块灰白
	s.specAmt = mix( 0.55 * ( 1.0 - 0.85 * vSeam ), 0.05, base );
	s.alpha = 1.0;
	return s;
`,
    extraLight: /* glsl */ `
	// 黑喙的轮廓边缘映一丝天光：上下颌的合缝和喙脊的立体感在正面、侧面才读得出来
	float dark = 1.0 - smoothstep( 0.05, 0.2, dot( s.albedo, vec3( 0.3, 0.5, 0.2 ) ) );
	float rim = pow( 1.0 - clamp( dot( N, V ), 0.0, 1.0 ), 3.0 );
	return uSkyColor * rim * 0.4 * dark;
`,
  });
}

// ---------------------------------------------------------------- 眼

/**
 * 眼睛局部坐标系：原点在眼球中心，+Z 为注视轴（指向体外），
 * +X 沿眼球表面指向嘴那一侧（前眼角），+Y 向上。眼角连线就是 +X 轴，眨眼时眼睑绕它转动。
 */
export interface EyeFrame {
  side: 1 | -1;
  center: Vector3;
  /** 眼睛局部 → 鸟局部。 */
  quat: Quaternion;
  /** “朝嘴方向”在眼睛局部坐标系里的方向（瞬膜从前眼角往后扫要用它，不能用局部 +X）。 */
  forwardLocal: Vector3;
}

/**
 * 眼睛局部坐标系：原点在眼球中心，+Z 为注视轴（指向体外），+Y 永远朝头顶。
 * +X = +Y × +Z 保持右手系，于是右眼的 +X 指向后眼角、左眼的 +X 指向前眼角——
 * 凡是“朝嘴那边”的逻辑都用 forwardLocal，不能假设 +X 朝嘴。
 * （早先用 y = d × x 构造 +Y，右眼会整个上下颠倒。）
 */
export function eyeFrame(p: BodyParams, side: 1 | -1): EyeFrame {
  const d = new Vector3(side * p.eyeDir[0], p.eyeDir[1], p.eyeDir[2]).normalize();
  const center = new Vector3(p.head.c[0], p.head.c[1], p.head.c[2]).addScaledVector(d, p.eyeOffset);
  // 头顶方向投到眼球的切平面上
  const y = new Vector3(0, 1, 0).addScaledVector(d, -d.y).normalize();
  const x = new Vector3().crossVectors(y, d).normalize();
  const quat = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x, y, d));
  const forward = new Vector3(0, p.beakDir[1], p.beakDir[2]).normalize();
  forward.addScaledVector(d, -forward.dot(d)).normalize();
  const forwardLocal = new Vector3(forward.dot(x), forward.dot(y), forward.dot(d));
  return { side, center, quat, forwardLocal };
}

/** 眼球：带“相对注视轴方向”属性，虹膜和眼神光据此绘制。 */
export function buildEyeball(p: BodyParams): BufferGeometry {
  const g = new SphereGeometry(p.eyeRadius, 48, 32);
  g.setAttribute('aEye', new BufferAttribute(new Float32Array(g.attributes.position.array as Float32Array), 3));
  // aEye 要的是单位方向
  const a = g.attributes.aEye as BufferAttribute;
  for (let i = 0; i < a.count; i++) {
    a.setXYZ(i, a.getX(i) / p.eyeRadius, a.getY(i) / p.eyeRadius, a.getZ(i) / p.eyeRadius);
  }
  return g;
}

/** 眼角离注视轴的夹角（前后眼角就在这里交汇收尖）。 */
const CORNER = (30 * Math.PI) / 180;
/**
 * 睑裂开度（单位：眼球半径）：黑豆眼圆润饱满，只是略呈横置杏仁——宽高比约 1.15 : 1，
 * 上缘略平缓（+23.6°），下缘圆润托起（−28.7°）。
 */
const UPPER_MARGIN_Y = 0.4;
const LOWER_MARGIN_Y = -0.48;
/** 上、下睑缘在正中剖面里离注视轴的极角（弧度），合拢时各转这么多就在中线相遇。 */
export const LID_GAP_UPPER = Math.asin(UPPER_MARGIN_Y);
export const LID_GAP_LOWER = Math.asin(-LOWER_MARGIN_Y);

/**
 * 上下眼睑球冠壳。覆盖的是球面上一个平面切割出来的那一半：
 * 平面都过“前后眼角连成的水平线”，上睑切割线在眼面上缘、下睑在下缘，于是围出的睑裂前后收尖、
 * 上缘略平、下缘圆润。壳半径略大于眼球；睑缘那一圈向眼球收拢，形成一点肉质厚度。
 * 静止睁开时露在外面的只有紧贴眼球的一圈深色细睑缘（aLidR ≲ 0.7r），再往外的壳面埋在眼周白绒毛底下。
 * 几何在眼睛局部坐标系里（原点 = 眼球中心），绕局部 X 轴转动即开合。
 */
export function buildEyelid(p: BodyParams, upper: boolean): BufferGeometry {
  const r = p.eyeRadius;
  const zc = Math.cos(CORNER) * r;
  const marginY = (upper ? UPPER_MARGIN_Y : LOWER_MARGIN_Y) * r;
  // 切割平面 y = a (z − zc)，过两眼角和眼面正中偏上/偏下的睑缘点
  const a = marginY / (Math.sqrt(r * r - marginY * marginY) - zc);
  const k = (-a * zc) / r;
  const segs = 48;
  const rings = 9;
  const phiMax = 2.3;

  const pos: number[] = [];
  const lid: number[] = [];
  const idx: number[] = [];
  for (let j = 0; j <= segs; j++) {
    const psi = (j / segs) * TAU;
    const sp = Math.sin(psi);
    const R = Math.hypot(sp, a);
    const delta = Math.atan2(a, sp);
    const s = clamp(k / R, -1, 1);
    const c1 = delta + Math.asin(s);
    const c2 = delta + Math.PI - Math.asin(s);
    // 取落在 [0, π] 里、最靠前（最小）的那个解
    const phiB = c1 >= 0 && c1 <= Math.PI ? c1 : clamp(c2, 0, Math.PI);
    // 眼睑壳半径：紧贴眼球（露出来的眼圈才窄），上下睑错开一点，合拢时两圈睑缘略有交叠，
    // 下睑在上睑外面，不会共面闪烁
    const rMargin = upper ? 1.006 : 1.01;
    const rShell = 1.018;
    for (let i = 0; i <= rings; i++) {
      // 第一圈贴着眼球（睑缘内沿），第二圈起到壳半径；间距在睑缘附近更密
      const phi = i === 0 ? phiB : phiB + 0.05 + (phiMax - phiB - 0.05) * ((i - 1) / (rings - 1));
      const rr = r * (i === 0 ? rMargin : rShell);
      pos.push(rr * Math.sin(phi) * Math.cos(psi), rr * Math.sin(phi) * Math.sin(psi), rr * Math.cos(phi));
      // 离眼中轴的距离（单位：眼球半径）：0 在睑裂正中，睑缘处约 0.4~0.5，材质据此只给紧贴眼球的一圈染深色睑缘
      lid.push((rr * Math.sin(phi)) / r);
      if (i < rings && j < segs) {
        const A = j * (rings + 1) + i;
        const B = A + 1;
        const C = A + rings + 1;
        const D = C + 1;
        idx.push(A, C, B, B, C, D);
      }
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('aLidR', new Float32BufferAttribute(lid, 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** 瞬膜：夹在眼球和眼睑之间的薄球壳。前眼角以外的部分在片元里裁掉，由 uNictX 驱动横向扫过。 */
export function buildNictitating(p: BodyParams): BufferGeometry {
  return new SphereGeometry(p.eyeRadius * 1.002, 48, 32);
}

export function makeEyeMaterial(lighting: LightingUniforms): ShaderMaterial {
  return makeLitMaterial({
    lighting,
    uniforms: {
      uPupil: { value: rgb('#040303') },
      // 极暗的深褐，只在露出眼面的外缘隐约透出一线
      uIris: { value: rgb('#241610') },
      uIrisDark: { value: rgb('#0e0806') },
    },
    vertexPars: /* glsl */ `
attribute vec3 aEye;
varying vec3 vEye;
varying vec3 vSparkW;
varying vec3 vUpW;
`,
    vertexMain: /* glsl */ `
	vEye = aEye;
	// 天光反射点的方向：在眼睛局部坐标里贴着露出眼面的上缘（注视轴上方约 17°，上睑缘在 23.6°）
	vSparkW = normalize( mat3( modelMatrix ) * vec3( 0.0, 0.3, 1.0 ) );
	vUpW = normalize( mat3( modelMatrix ) * vec3( 0.0, 1.0, 0.0 ) );
`,
    fragmentPars: /* glsl */ `
uniform vec3 uPupil;
uniform vec3 uIris;
uniform vec3 uIrisDark;
varying vec3 vEye;
varying vec3 vSparkW;
varying vec3 vUpW;
`,
    surface: /* glsl */ `
	float r = length( vEye.xy );
	float ang = atan( vEye.y, vEye.x );
	float streak = snoise( vec3( cos( ang ) * 6.0, sin( ang ) * 6.0, r * 5.0 ) ) * 0.5 + 0.5;
	vec3 iris = mix( uIris * 0.8, uIris * 1.2, streak );
	// 露出睑裂的只是球冠（|xy| < 0.5），正中是黑曜石般的纯黑，外缘才隐约透出深褐
	vec3 alb = mix( uPupil, iris, smoothstep( 0.52, 0.8, r ) );
	alb = mix( alb, uIrisDark, smoothstep( 0.88, 0.98, r ) );
	Surf s;
	s.albedo = alb;
	s.ao = 1.0;
	s.wrap = 0.2;
	s.specTint = vec3( 1.0 );
	// 太阳的镜面反射只留一点很弱的润泽感，眼神光由下面那粒固定的天光反射点负责
	s.gloss = 0.72;
	s.specAmt = 0.22;
	s.alpha = 1.0;
	return s;
`,
    extraLight: /* glsl */ `
		// 角膜只在球缘映出一点环境（上方天光、下方雪地），正视中心保持漆黑
	vec3 R = reflect( -V, N );
	vec3 env = mix( uGroundColor, uSkyColor * 1.5, smoothstep( -0.2, 0.5, R.y ) );
	float fres = 0.5 * pow( 1.0 - clamp( dot( N, V ), 0.0, 1.0 ), 5.0 );
	// 天光反射点：极小、锐利的一粒，贴在露出眼面的上缘，不依赖太阳阴影
	float nh = max( dot( N, normalize( vSparkW ) ), 0.0 );
	vec3 spark = uSkyColor * 1.6 * ( pow( nh, 800.0 ) * 2.0 + pow( nh, 120.0 ) * 0.04 );
	// 上缘一丝极弱的天光弧（紧贴上睑缘下方，眼角处淡出）
	float upW =
		smoothstep( 0.3, 0.36, vEye.y ) * ( 1.0 - smoothstep( 0.36, 0.39, vEye.y ) ) *
		( 1.0 - smoothstep( 0.3, 0.45, abs( vEye.x ) ) );
	vec3 arc = uSkyColor * 0.12 * upW;
	return env * fres + spark + arc;
`,
  });
}

/**
 * 眼睑壳材质：紧贴眼球的一圈是肉质睑缘——上睑缘一丝暗赭黄、下睑缘深黑褐，往外 0.55r~0.7r 内过渡到
 * 面部绒羽的白（眼睑上长着细短绒羽，和眼周白毛无缝衔接）；这一圈白壳面埋在眼周绒毛底下，只在眨眼合拢时露出来。
 */
export function makeLidMaterial(lighting: LightingUniforms, upper: boolean): ShaderMaterial {
  return makeLitMaterial({
    lighting,
    side: DoubleSide,
    uniforms: {
      uLidWhite: { value: rgb('#ebe6de') },
      uLidEdge: { value: rgb(upper ? '#3a2e22' : '#241c1a') },
    },
    vertexPars: /* glsl */ `
attribute float aLidR;
varying float vLidR;
`,
    vertexMain: /* glsl */ `
	vLidR = aLidR;
`,
    fragmentPars: /* glsl */ `
uniform vec3 uLidWhite;
uniform vec3 uLidEdge;
varying float vLidR;
`,
    surface: /* glsl */ `
	float band = 1.0 - smoothstep( 0.52, 0.68, vLidR );
	// 绒羽白带一点细碎的明暗，和旁边壳层绒毛的质感接得上
	vec3 dome = uLidWhite * ( 0.94 + 0.12 * ( snoise( vWorldPos * 90.0 ) * 0.5 + 0.5 ) );
	Surf s;
	s.albedo = mix( dome, uLidEdge, band );
	s.ao = mix( 1.0, 0.7, band );
	s.wrap = 0.55;
	s.specTint = vec3( 1.0 );
	s.gloss = 0.3;
	s.specAmt = 0.0;
	s.alpha = 1.0;
	return s;
`,
  });
}

/**
 * 瞬膜材质：半透明乳灰薄壳，uNictX 之前（前眼角一侧）的部分透明掉，由前眼角往后眼角扫过。
 * “前”由 uFwd（朝嘴方向在眼睛局部坐标系里的方向）给出，左右眼都用同一套逻辑。
 */
export function makeNictMaterial(lighting: LightingUniforms, forwardLocal: Vector3): ShaderMaterial {
  return makeLitMaterial({
    lighting,
    side: DoubleSide,
    transparent: true,
    depthWrite: false,
    uniforms: {
      uNictX: { value: 1 },
      uNictCol: { value: rgb('#d4d6d6') },
      uFwd: { value: forwardLocal.clone() },
    },
    vertexPars: /* glsl */ `
varying vec3 vLocal;
`,
    vertexMain: /* glsl */ `
	vLocal = position;
`,
    fragmentPars: /* glsl */ `
uniform float uNictX;
uniform vec3 uNictCol;
uniform vec3 uFwd;
varying vec3 vLocal;
`,
    surface: /* glsl */ `
	Surf s;
	s.albedo = uNictCol;
	s.ao = 1.0;
	s.wrap = 0.5;
	s.specTint = vec3( 1.0 );
	s.gloss = 0.5;
	s.specAmt = 0.15;
	// 沿“朝嘴方向”的坐标；扫过的前缘微微向前拱起（两眼角处被拖住，落后一点）
	float fwd = dot( vLocal, uFwd ) - 0.35 * abs( vLocal.x );
	s.alpha = 0.55 * smoothstep( uNictX, uNictX + 0.012, fwd );
	return s;
`,
  });
}

// ---------------------------------------------------------------- 腿脚

/**
 * 栖枝在落点处的抓握几何（世界坐标），由 Branches.perchAt 提供。
 * 鸟的局部 +Z 平行于枝轴（鸟顺着枝站立），所以绕枝抓握的圆在鸟局部的 (X, Y) 横截面里；
 * 脚爪的全部路径点都从 surfaceRadius 查真实表面（树皮鼓包 + 积雪帽），贴的就是画出来的那个面。
 */
export interface Perch {
  /** 落点处枝条中心（世界坐标）。 */
  center: Vector3;
  /** 枝轴切线（主枝上指向世界 +X）。 */
  tangent: Vector3;
  /** 顶面方向：垂直于切线、尽量朝上。 */
  up: Vector3;
  /** 侧向：切线 × 顶面，主枝上指向鸟的右侧（世界 +Z）。 */
  side: Vector3;
  /** 落点处枝条的基础半径（不含树皮鼓包和积雪）。 */
  radius: number;
  /**
   * 从顶面起算、朝 side 为正的环向角 alpha（弧度）处、沿枝轴偏移 along（厘米，正 = 切线方向）处的
   * 真实外表面半径：树皮鼓包和朝上一面的积雪帽都算进去。
   */
  surfaceRadius(alpha: number, along: number): number;
}

/** 沿折线放样的变径管（平行传输标架），用于跗跖、脚趾和爪。extra 是逐点标量（爪标记），烘成 aClaw。 */
function taperedTube(points: Vector3[], radii: number[], radial = 8, extra?: number[]): BufferGeometry {
  const n = points.length;
  const tangents: Vector3[] = [];
  for (let i = 0; i < n; i++) {
    const a = points[Math.max(i - 1, 0)];
    const b = points[Math.min(i + 1, n - 1)];
    tangents.push(new Vector3().subVectors(b, a).normalize());
  }
  let normal = new Vector3()
    .crossVectors(tangents[0], Math.abs(tangents[0].y) < 0.9 ? UP : X_AXIS)
    .normalize();
  const pos: number[] = [];
  const claw: number[] = [];
  const idx: number[] = [];
  const q = new Quaternion();
  const axis = new Vector3();
  const bin = new Vector3();
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      axis.crossVectors(tangents[i - 1], tangents[i]);
      const s = axis.length();
      const c = clamp(tangents[i - 1].dot(tangents[i]), -1, 1);
      if (s > 1e-7) {
        q.setFromAxisAngle(axis.multiplyScalar(1 / s), Math.atan2(s, c));
        normal.applyQuaternion(q);
      }
      normal.addScaledVector(tangents[i], -normal.dot(tangents[i])).normalize();
    }
    bin.crossVectors(tangents[i], normal).normalize();
    for (let j = 0; j <= radial; j++) {
      const th = (j / radial) * TAU;
      const r = radii[i];
      const cn = Math.cos(th) * r;
      const sn = Math.sin(th) * r;
      pos.push(
        points[i].x + normal.x * cn + bin.x * sn,
        points[i].y + normal.y * cn + bin.y * sn,
        points[i].z + normal.z * cn + bin.z * sn,
      );
      claw.push(extra?.[i] ?? 0);
      if (i < n - 1 && j < radial) {
        const a = i * (radial + 1) + j;
        const b = a + 1;
        const c = a + radial + 1;
        const d = c + 1;
        idx.push(a, b, c, b, d, c);
      }
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('aClaw', new Float32BufferAttribute(claw, 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * 一根脚趾的走向。方向角都在脚掌处的切平面里量：0 = 顺着枝朝头的方向，正值朝脚的外侧（两脚各自的外侧）。
 * psi0 是趾根出发的方向，curl 是绕到后面时转到的方向——真鸟的趾不是测地线，是先顺着枝再往下卷过去的钩子。
 */
interface ToeSpec {
  psi0: number;
  curl: number;
  /** 沿表面的趾长（厘米，不含爪）。 */
  length: number;
  thick: number;
}

const DEG = Math.PI / 180;
/** 三前一后。前趾都往脚的外侧卷、包住外侧弧面；后趾朝后内方反扣。 */
const TOES: ToeSpec[] = [
  { psi0: -40 * DEG, curl: 85 * DEG, length: 0.5, thick: 0.03 },
  { psi0: 0, curl: 100 * DEG, length: 0.62, thick: 0.032 },
  { psi0: 40 * DEG, curl: 105 * DEG, length: 0.52, thick: 0.03 },
  { psi0: 180 * DEG, curl: 265 * DEG, length: 0.46, thick: 0.028 },
];
/** 脚掌整体朝外侧斜偏的角度。 */
const FOOT_YAW = 48 * DEG;

/**
 * 两只脚在栖枝上的落点：枝顶前后微错开、各略偏自己一侧（世界 x 与环向角，朝 side 为正）。
 * 跗跖落在这里，积雪也在这里被踩出小凹——脚趾贴的就是那个凹下去的雪面。
 */
export const FOOT_SPOTS: { worldX: number; alpha: number }[] = [
  { worldX: -0.11, alpha: 0.26 },
  { worldX: 0.13, alpha: -0.26 },
];

interface Foot {
  /** 脚掌在枝条横截面上的环向角（朝 side 为正）。 */
  alpha: number;
  /** 脚掌沿枝轴的偏移（厘米，正 = 切线方向）。 */
  along: number;
  /** 右脚 1、左脚 -1：决定“外侧”是 +alpha 还是 -alpha。 */
  side: 1 | -1;
}

/**
 * 脚趾贴着枝条真实表面走：把表面当成圆柱面，趾在切平面里的方向 (cos ψ, sin ψ) 决定每一步沿枝轴前进多少、
 * 绕枝转过多少，所以趾只会在表面上绕过去——不会顺着枝轴扎进木头，也不会悬空飞出枝外。
 * 趾身压在表面上（管心抬离表面 0.85 倍管径，底面微微压进雪里），趾节处微微鼓起；
 * 最后 22% 是爪：急剧收尖，并向表面内钩，爪尖抠进树皮/雪面一点点。
 */
function toePath(perch: Perch, foot: Foot, spec: ToeSpec): { points: Vector3[]; radii: number[]; claw: number[] } {
  const steps = 18;
  const points: Vector3[] = [];
  const radii: number[] = [];
  const claw: number[] = [];
  const n = new Vector3();
  let alpha = foot.alpha;
  let along = foot.along;
  const dL = spec.length / steps;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const psi = lerp(spec.psi0 + FOOT_YAW, spec.curl, smoothstep(0.1, 0.7, t));
    // 趾身：从根到爪基缓慢收细，两个趾节处微微鼓起；爪：从爪基急剧收尖
    const knuckle = 1 + 0.13 * (Math.exp(-(((t - 0.36) / 0.09) ** 2)) + 0.75 * Math.exp(-(((t - 0.66) / 0.09) ** 2)));
    const body = lerp(spec.thick, spec.thick * 0.55, t) * knuckle;
    const isClaw = smoothstep(0.78, 0.82, t);
    const r = lerp(body, 0.004, Math.pow(smoothstep(0.78, 1.0, t), 0.8));
    // 爪尖越靠末端越往表面里钩（最多抠进 0.014 cm）
    const dig = isClaw * clamp((t - 0.78) / 0.22, 0, 1);
    const lift = r * 0.85 - 0.014 * dig;
    n.copy(perch.up).multiplyScalar(Math.cos(alpha)).addScaledVector(perch.side, Math.sin(alpha));
    const rr = perch.surfaceRadius(alpha, along) + lift;
    points.push(perch.center.clone().addScaledVector(perch.tangent, along).addScaledVector(n, rr));
    radii.push(r);
    claw.push(isClaw);
    along += Math.cos(psi) * dL;
    alpha += (foot.side * Math.sin(psi) * dL) / Math.max(rr, 0.05);
  }
  return { points, radii, claw };
}

/**
 * 腿脚：跗跖从腹羽里伸下来落在枝顶，两只脚在枝顶前后微错开、各略偏自己一侧，脚掌朝外侧斜偏约 48°；
 * 三根前趾贴着枝条真实表面包绕外侧弧面，后趾从内后侧反扣，每根趾末端一小段内钩的角质爪尖。
 * 路径先在世界坐标里按栖枝算好，再用 worldToLocal（鸟群的逆矩阵）转回鸟的局部坐标。
 */
export function buildLegs(perch: Perch, worldToLocal: Matrix4): BufferGeometry {
  const parts: BufferGeometry[] = [];
  for (const s of [1, -1] as const) {
    const spot = FOOT_SPOTS[s === 1 ? 0 : 1];
    const foot: Foot = { alpha: spot.alpha, along: (spot.worldX - perch.center.x) / perch.tangent.x, side: s };
    const normal = perch.up
      .clone()
      .multiplyScalar(Math.cos(foot.alpha))
      .addScaledVector(perch.side, Math.sin(foot.alpha));
    const ankle = perch.center
      .clone()
      .addScaledVector(perch.tangent, foot.along)
      .addScaledVector(normal, perch.surfaceRadius(foot.alpha, foot.along) + 0.03);
    // 跗跖：从腹羽里伸出来，略向前倾、微微弓着
    const hip = new Vector3(-0.44, 0.62, 0.22 * s);
    parts.push(
      taperedTube(
        [
          hip,
          hip.clone().lerp(ankle, 0.4).add(new Vector3(-0.04, 0, 0.01 * s)),
          hip.clone().lerp(ankle, 0.75).add(new Vector3(-0.02, 0, 0.005 * s)),
          ankle,
        ],
        [0.052, 0.046, 0.041, 0.04],
        9,
      ),
    );
    for (const spec of TOES) {
      const toe = toePath(perch, foot, spec);
      parts.push(taperedTube(toe.points, toe.radii, 7, toe.claw));
    }
  }
  const merged = mergeGeometries(parts)!;
  for (const g of parts) g.dispose();
  merged.applyMatrix4(worldToLocal);
  return merged;
}

export function makeLegMaterial(lighting: LightingUniforms): ShaderMaterial {
  const uniforms: Record<string, IUniform> = {
    uLegCol: { value: rgb('#231d20') },
    uClawCol: { value: rgb('#0d0a0c') },
  };
  return makeLitMaterial({
    lighting,
    side: DoubleSide,
    uniforms,
    fragmentPars: /* glsl */ `
uniform vec3 uLegCol;
uniform vec3 uClawCol;
varying vec3 vObj;
varying float vClaw;
`,
    vertexPars: /* glsl */ `
attribute float aClaw;
varying vec3 vObj;
varying float vClaw;
`,
    vertexMain: /* glsl */ `
	vObj = position;
	vClaw = aClaw;
`,
    surface: /* glsl */ `
	Surf s;
	// 皮肤上细碎的鳞片
	float scale = snoise( vObj * 150.0 ) * 0.5 + 0.5;
	// 爪尖是深黑色角质，带一点润泽的高光
	s.albedo = mix( uLegCol * ( 0.8 + 0.4 * scale ), uClawCol, vClaw );
	s.ao = 1.0;
	s.wrap = 0.4;
	s.specTint = vec3( 1.0 );
	s.gloss = mix( 0.35, 0.72, vClaw );
	s.specAmt = mix( 0.14, 0.42, vClaw );
	s.alpha = 1.0;
	return s;
`,
  });
}
