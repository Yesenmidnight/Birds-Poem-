import {
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  DoubleSide,
  Float32BufferAttribute,
  Matrix4,
  Quaternion,
  SphereGeometry,
  Vector2,
  Vector3,
  type IUniform,
  type ShaderMaterial,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeLitMaterial, rgb, type LightingUniforms } from '../glsl/lit';
import { TAU, clamp, lerp, smoothstep } from '../util/math';
import type { BodyParams } from './bodySdf';
import {
  BEAK_DROOP,
  BEAK_HINGE_DEPTH,
  BEAK_NOTCH,
  BEAK_PROFILE_GLSL,
  BEAK_REF_LEN,
  beakHalfWidth,
  beakLowerHeight,
  beakUpperHeight,
} from './beakProfile';

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
 * 嘴缝处压出一道凹痕形成口角；嘴缝那一面用独立顶点封口，是口腔的顶 / 底。
 * 两者都绕铰链（params.beakBase，前脸皮层正下方）张合（Bird.setJawOpen）。
 * 放样从铰链后方 BEAK_HINGE_DEPTH 的剖面原点起（埋在脸皮下的原始嘴根），铰链平面处没有开口的颌根环；
 * 剖面按"距喙尖的距离"取（beakProfile），所以铰链位置怎么调，露在绒毛外的喙形都不变。
 * 下颌带一枚小舌：顶点存实际高度 aTongue，着色器按张嘴度把它压平 / 立起。
 */
export function buildMandible(p: BodyParams, upper: boolean): BufferGeometry {
  const rings = 18;
  const radial = 14;
  const hinge = new Vector3(...p.beakBase);
  const dir = new Vector3(...p.beakDir).normalize();
  const up = new Vector3().crossVectors(dir, X_AXIS).normalize();
  const L = p.beakLength;
  const s0 = -BEAK_HINGE_DEPTH / L;
  // 上下喙的嘴缝面错开一点点，合拢时不共面
  const seamY = upper ? 0.002 : -0.002;
  // 放样参数 s（铰链处 0、喙尖 1）→ 该圈截面中心和半宽 / 半高
  const section = (s: number) => {
    const dTip = (1 - s) * L;
    const tRoot = BEAK_REF_LEN - dTip;
    const c = hinge.clone().addScaledVector(dir, s * L).addScaledVector(up, (-BEAK_DROOP * tRoot * tRoot) / BEAK_REF_LEN);
    return { c, w: beakHalfWidth(dTip), hu: beakUpperHeight(dTip), hl: beakLowerHeight(dTip) };
  };

  const ringPoint = (i: number, j: number): [number, number, number] => {
    const { c, w, hu, hl } = section(s0 + (i / rings) * (1 - s0));
    const th = upper ? (j / radial) * Math.PI : Math.PI + (j / radial) * Math.PI;
    const sy = Math.sin(th);
    const h = sy >= 0 ? hu : hl;
    const gape = 1 - BEAK_NOTCH * Math.exp(-((sy / 0.16) ** 2));
    const x = w * Math.cos(th) * gape;
    const y = h * sy * gape + seamY;
    return [c.x + x, c.y + up.y * y, c.z + up.z * y];
  };

  const pos: number[] = [];
  const seam: number[] = [];
  const tongue: number[] = [];
  const idx: number[] = [];
  // 外壳：一节节半椭圆截面放样
  for (let i = 0; i <= rings; i++) {
    for (let j = 0; j <= radial; j++) {
      pos.push(...ringPoint(i, j));
      seam.push(0);
      tongue.push(0);
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
    tongue.push(0, 0);
    if (i < rings) {
      const a = seamBase + i * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  // 小舌（只有下颌）：下颌内槽前部一枚小巧圆润的舌尖，铰链前方 0.07 起长 0.08，最宽 0.026、最高 0.015
  if (!upper) {
    const NU = 8;
    const NV = 8;
    const tBase = pos.length / 3;
    for (let i = 0; i <= NU; i++) {
      const u = i / NU;
      const d = 0.07 + u * 0.08;
      const { c } = section(d / L);
      const bell = Math.sin(Math.PI * u);
      const hw = 0.026 * Math.sqrt(bell) + 0.0012;
      const hMax = 0.015 * Math.pow(bell, 0.6);
      for (let j = 0; j <= NV; j++) {
        const v = (j / NV) * 2 - 1;
        const h = hMax * Math.pow(1 - v * v, 0.6);
        const y = seamY + 0.0006 + h;
        pos.push(c.x + v * hw, c.y + up.y * y, c.z + up.z * y);
        seam.push(2);
        tongue.push(h);
      }
    }
    for (let i = 0; i < NU; i++) {
      for (let j = 0; j < NV; j++) {
        const a = tBase + i * (NV + 1) + j;
        idx.push(a, a + 1, a + NV + 1, a + 1, a + NV + 2, a + NV + 1);
      }
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('aSeam', new Float32BufferAttribute(seam, 1));
  g.setAttribute('aTongue', new Float32BufferAttribute(tongue, 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * 喙壳 + 口腔内壁材质。嘴根垫色只垫在脸皮层底下那一段（铰链前方 0.04 以内）的 outer 面：
 * 四周的细短白绒是半透明毛丝，搭在上面的壳面若是黑的，毛缝里会透出黑底、看着像一圈锯齿。
 * 嘴缝面是口腔的顶 / 底：颌根深暗、往前渐亮成暖珊瑚粉棕，小舌更粉嫩；合拢时严丝合缝藏在上下颌之间。
 * vObj 是铰链坐标系的（position 是鸟局部坐标，原来漏减 beakBase，along 恒 ≥ 1.5，垫色从未生效过）。
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
      uBeakBase: { value: new Vector3(...p.beakBase) },
      uBeakLen: { value: p.beakLength },
      uBeakSide: { value: upper ? 1 : -1 },
      // 小舌鼓起的比例：合拢时 0（平贴在嘴缝里），张嘴后到 1
      uTongueLift: { value: 0 },
      // 下颌张角：合拢时嘴缝面 / 小舌是深色缝，张开 0.02~0.1 rad 内才变成口腔色
      uJawOpen: { value: 0 },
    },
    fragmentPars: /* glsl */ `
uniform vec3 uBeakCol;
uniform vec3 uBaseCol;
uniform vec3 uBeakDir;
uniform vec3 uBeakUp;
uniform float uBeakSide;
uniform float uBeakLen;
uniform float uJawOpen;
varying vec3 vObj;
varying float vSeam;
varying float vTongue;
${BEAK_PROFILE_GLSL}`,
    vertexPars: /* glsl */ `
attribute float aSeam;
attribute float aTongue;
uniform vec3 uBeakBase;
uniform vec3 uBeakUp;
uniform float uTongueLift;
varying vec3 vObj;
varying float vSeam;
varying float vTongue;
`,
    vertexMain: /* glsl */ `
	vObj = position - uBeakBase;
	vSeam = aSeam;
	vTongue = aTongue;
	pos -= uBeakUp * aTongue * ( 1.0 - uTongueLift );
`,
    surface: /* glsl */ `
	float along = dot( vObj, uBeakDir );
	float grain = snoise( vObj * 120.0 ) * 0.5 + 0.5;
	float base = 1.0 - smoothstep( 0.0, 0.04, along + ( snoise( vObj * 60.0 ) - 0.5 ) * 0.02 );
	// 绒羽色只垫在嘴根朝外的那一面（上颌的上侧、下颌的下侧，也就是合拢时被毛搭住的地方）；
	// 嘴缝面和靠近嘴缝的内侧永远是口腔色 / 暗的
	base *= ( 1.0 - step( 0.5, vSeam ) ) * smoothstep( 0.06, 0.12, uBeakSide * dot( vObj, uBeakUp ) );
	float mouth = step( 0.5, vSeam );
	float tongue = step( 1.5, vSeam );
	float t = clamp( along / uBeakLen, 0.0, 1.0 );
	// 越往嘴根深处越暗（喉部环境光遮蔽），不是平涂亮粉
	vec3 mouthCol = mix( vec3( 0.10, 0.03, 0.025 ), vec3( 0.45, 0.14, 0.105 ), smoothstep( 0.0, 0.55, t ) );
	// 下颌内槽不是一整片粉：角质喙的内面是暗的，只有嘴根那一截黏膜透出暖珊瑚粉、往前 0.45 喙长内沉进暗角质——
	// 槽里只靠小舌露一枚粉舌尖（上一版整条下颌内槽都是亮粉，斜前看像张着一嘴粉纸）
	vec3 trough = mix( vec3( 0.34, 0.12, 0.095 ), vec3( 0.075, 0.045, 0.04 ), smoothstep( 0.08, 0.45, t ) );
	mouthCol = mix( mouthCol, trough, step( uBeakSide, 0.0 ) );
	mouthCol = mix( mouthCol, vec3( 0.66, 0.24, 0.18 ), tongue * 0.85 );
	// 嘴缝边（tomium）是黑的：口腔色从缝边往里 0.015 才亮起来；合拢时整条缝是深色缝，张开后才是粉口腔
	float rim = smoothstep( 0.0, 0.015, beakW( uBeakLen - along ) * ${(1 - BEAK_NOTCH).toFixed(4)} - abs( vObj.x ) );
	mouthCol = mix( vec3( 0.02, 0.015, 0.015 ), mouthCol, rim * smoothstep( 0.02, 0.1, uJawOpen ) );
	Surf s;
	s.albedo = mix( uBeakCol * ( 0.8 + 0.4 * grain ), uBaseCol * ( 0.92 + 0.12 * grain ), base );
	s.albedo = mix( s.albedo, mouthCol, mouth );
	s.ao = mix( 1.0, 0.4 + 0.6 * t, mouth );
	s.wrap = mix( mix( 0.3, 0.55, base ), 0.7, mouth );
	s.specTint = vec3( 1.0 );
	s.gloss = mix( mix( 0.62, 0.3, base ), 0.5, mouth );
	// 嘴缝面是平的，高光要压掉，不然张嘴时口腔里泛出一块灰白；小舌留一点湿润的高光
	s.specAmt = mix( 0.55 * ( 1.0 - 0.85 * mouth ), 0.05, base );
	s.specAmt = mix( s.specAmt, 0.08 + 0.2 * tongue, mouth );
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

/**
 * 口角膜（嘴角的 flesh）：连接上下颌嘴缝边的一小片，只占嘴角根部最深处 25% 的喙长，中段往口腔中线收进去
 * 微微凹陷（像真鸟嘴角往咽喉里陷的漏斗）；合拢时上下缘重合是零面积，张开时顶点着色器把下缘跟下颌转
 * （含下颌前推 uPush）、上缘跟上颌转、中间按 aBlend 插值。再往前 75% 的上下喙之间是透空的 V 字口，
 * 不是一面粉墙。几何在铰链坐标系里（原点 = 铰链）。
 */
export function buildMouthCorners(p: BodyParams): BufferGeometry {
  const N = 8;
  const M = 4;
  const dir = new Vector3(...p.beakDir).normalize();
  const up = new Vector3().crossVectors(dir, X_AXIS).normalize();
  const L = p.beakLength;
  const pos: number[] = [];
  const blend: number[] = [];
  const side: number[] = [];
  const along: number[] = [];
  const fold: number[] = [];
  const idx: number[] = [];
  for (const sd of [1, -1]) {
    const b0 = pos.length / 3;
    for (let i = 0; i <= N; i++) {
      const s = (i / N) * 0.25;
      const tRoot = BEAK_REF_LEN - (1 - s) * L;
      const w = beakHalfWidth((1 - s) * L) * (1 - BEAK_NOTCH);
      const droop = (-BEAK_DROOP * tRoot * tRoot) / BEAK_REF_LEN;
      const y = dir.y * s * L + up.y * droop;
      const z = dir.z * s * L + up.z * droop;
      for (let j = 0; j <= M; j++) {
        const bl = j / M;
        const dent = Math.sin(Math.PI * bl);
        pos.push(sd * w * (1 - 0.45 * dent), y, z);
        blend.push(bl);
        side.push(sd);
        along.push(s);
        fold.push(dent);
      }
    }
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < M; j++) {
        const a = b0 + i * (M + 1) + j;
        idx.push(a, a + M + 1, a + 1, a + 1, a + M + 1, a + M + 2);
      }
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('aBlend', new Float32BufferAttribute(blend, 1));
  g.setAttribute('aSide', new Float32BufferAttribute(side, 1));
  g.setAttribute('aT', new Float32BufferAttribute(along, 1));
  g.setAttribute('aFold', new Float32BufferAttribute(fold, 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** 口腔侧壁材质：暖珊瑚粉棕，颌根更深。uJaw = (下颌角, 上颌角)，由 Bird.setJawOpen 写入。 */
export function makeMouthMaterial(lighting: LightingUniforms, p: BodyParams): ShaderMaterial {
  const dir = new Vector3(...p.beakDir).normalize();
  return makeLitMaterial({
    lighting,
    side: DoubleSide,
    uniforms: { uJaw: { value: new Vector2(0, 0) }, uPush: { value: 0 }, uBeakDir: { value: dir } },
    vertexPars: /* glsl */ `
attribute float aBlend;
attribute float aSide;
attribute float aT;
attribute float aFold;
uniform vec2 uJaw;
uniform float uPush;
uniform vec3 uBeakDir;
varying float vT;
varying float vFold;
`,
    vertexMain: /* glsl */ `
	float cl = cos( uJaw.x ), sl = sin( uJaw.x ), cu = cos( uJaw.y ), su = sin( uJaw.y );
	vec3 pl = vec3( position.x, position.y * cl - position.z * sl, position.y * sl + position.z * cl ) + uBeakDir * uPush;
	vec3 pu = vec3( position.x, position.y * cu - position.z * su, position.y * su + position.z * cu );
	pos = mix( pl, pu, aBlend );
	nrm = vec3( aSide, 0.0, 0.0 );
	vT = aT;
	vFold = aFold;
`,
    fragmentPars: /* glsl */ `
varying float vT;
varying float vFold;
`,
    surface: /* glsl */ `
	Surf s;
	// 越靠嘴根越暗、凹陷里更暗：喉部环境光遮蔽，不是平涂亮粉
	float depth = smoothstep( 0.0, 0.6, vT );
	vec3 c = mix( vec3( 0.09, 0.025, 0.02 ), vec3( 0.42, 0.13, 0.10 ), depth );
	c = mix( c, c * 0.45, vFold * 0.6 );
	s.albedo = c;
	s.ao = 0.3 + 0.55 * depth * ( 1.0 - 0.6 * vFold );
	s.wrap = 0.7;
	s.specTint = vec3( 1.0 );
	s.gloss = 0.5;
	s.specAmt = 0.12;
	s.alpha = 1.0;
	return s;
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

/** 一条放样路径：路径点、半径、每点处的背面方向（鳞片长在这面）、爪标记（0 / 1）。 */
export interface TubePath {
  points: Vector3[];
  radii: number[];
  dorsal: Vector3[];
  claw: number[];
}

/**
 * 横截面参数：背面半轴 r·tall、侧面半轴 r·wide（鸟趾比高更宽、贴地那面是平的），
 * 背面半边叠 scutes 片叠瓦状鳞片脊，脊高 = r·scuteAmp·背面余弦^1.5。
 */
export interface TubeFrame {
  wide: number;
  tall: number;
  scutes: number;
  scuteAmp: number;
  /** 鳞片随机种的偏移（各根趾不同）。 */
  seed?: number;
}

/**
 * 沿路径逐环逐顶点回调 cb(顶点号, x, y, z, 爪标记, 鳞片坐标, 背面余弦)。
 * 每环以该点的背面方向为极轴建椭圆横截面（不再用平行传输标架——鳞片脊要按背面算角度）；
 * 鳞片从根端向游离缘抬升、到下一片根端陡落（fract 的锯齿），只长在背面半边、到侧面归零，爪上没有。
 * 顶点顺序：每环 radial + 1 个（首尾重合一个，环向接缝连续）。静态腿（taperedTube）和动态腿架（legs.ts 的 writeTube）
 * 都走这一个函数，两边逐位一致。
 */
export function tubeRings(
  path: TubePath,
  radial: number,
  frame: TubeFrame,
  cb: (vertex: number, x: number, y: number, z: number, claw: number, scute: number, dorsal: number) => void,
): void {
  const { points, radii, dorsal, claw } = path;
  const n = points.length;
  const tangent = new Vector3();
  const d = new Vector3();
  const lat = new Vector3();
  for (let i = 0; i < n; i++) {
    tangent.subVectors(points[Math.min(i + 1, n - 1)], points[Math.max(i - 1, 0)]).normalize();
    d.copy(dorsal[i]).addScaledVector(tangent, -dorsal[i].dot(tangent));
    if (d.lengthSq() < 1e-12) {
      const ref = Math.abs(tangent.y) < 0.9 ? UP : X_AXIS;
      d.copy(ref).addScaledVector(tangent, -ref.dot(tangent));
    }
    d.normalize();
    lat.crossVectors(tangent, d).normalize();
    const r = radii[i];
    // 鳞片坐标：片与片等距会像一环环的箍，按正弦把边界挪得不整齐（宽度 ±40%，映射仍单调）
    const s = i / (n - 1);
    const scute = frame.scutes * (s + 0.03 * Math.sin(13 * s + 1.3));
    // 每片脊高再随机 ±25%（seed 区分各根趾，同一根趾每次算出来一样）
    const plate = Math.floor(scute);
    const hj = Math.sin(plate * 12.9898 + 4.1 + (frame.seed ?? 0) * 1.7) * 43758.5453;
    const jitter = 0.75 + 0.5 * (hj - Math.floor(hj));
    const ridge = frame.scuteAmp * jitter * Math.pow(scute - plate, 0.7) * (1 - claw[i]);
    for (let j = 0; j <= radial; j++) {
      const ph = (j / radial) * TAU;
      const c = Math.cos(ph);
      const top = Math.max(0, c);
      const h = r * frame.tall * (1 + ridge * top * Math.sqrt(top));
      const w = r * frame.wide;
      cb(
        i * (radial + 1) + j,
        points[i].x + d.x * c * h + lat.x * Math.sin(ph) * w,
        points[i].y + d.y * c * h + lat.y * Math.sin(ph) * w,
        points[i].z + d.z * c * h + lat.z * Math.sin(ph) * w,
        claw[i],
        scute,
        c,
      );
    }
  }
}

/** 沿路径放样的管子（taperedTube 的替代）：位置 + aClaw + aSc（鳞片坐标）+ aDorsal（背面余弦）。 */
function taperedTube(path: TubePath, radial: number, frame: TubeFrame): BufferGeometry {
  const rings = path.points.length;
  const pos: number[] = [];
  const claw: number[] = [];
  const sc: number[] = [];
  const dor: number[] = [];
  const idx: number[] = [];
  tubeRings(path, radial, frame, (v, x, y, z, c, s, d) => {
    pos.push(x, y, z);
    claw.push(c);
    sc.push(s);
    dor.push(d);
    const i = Math.floor(v / (radial + 1));
    const j = v % (radial + 1);
    if (i < rings - 1 && j < radial) {
      const a = v;
      const b = a + 1;
      const c2 = a + radial + 1;
      const d2 = c2 + 1;
      idx.push(a, b, c2, b, d2, c2);
    }
  });
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('aClaw', new Float32BufferAttribute(claw, 1));
  g.setAttribute('aSc', new Float32BufferAttribute(sc, 1));
  g.setAttribute('aDorsal', new Float32BufferAttribute(dor, 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** 全 0 的爪标记。 */
const NO_CLAW = (n: number): number[] => new Array<number>(n).fill(0);

/**
 * 一根脚趾的走向。方向角都在脚掌处的切平面里量：0 = 顺着枝朝头的方向，正值朝脚的外侧（两脚各自的外侧）。
 * psi0 是趾根出发的方向，curl 是绕到后面时转到的方向——真鸟的趾不是测地线，是先顺着枝再往下卷过去的钩子。
 */
export interface ToeSpec {
  psi0: number;
  curl: number;
  /** 沿表面的趾长（厘米，不含爪）。 */
  length: number;
  thick: number;
}

const DEG = Math.PI / 180;
/**
 * 三前一后。前趾都往脚的外侧卷、包住外侧弧面；后趾朝后内方反扣。
 * thick 是趾根半径（厘米）：真鸟的趾粗而几乎不等粗，中趾直径约 0.9 mm。
 */
export const TOES: ToeSpec[] = [
  { psi0: -40 * DEG, curl: 85 * DEG, length: 0.5, thick: 0.044 },
  { psi0: 0, curl: 100 * DEG, length: 0.62, thick: 0.048 },
  { psi0: 40 * DEG, curl: 105 * DEG, length: 0.52, thick: 0.044 },
  { psi0: 180 * DEG, curl: 265 * DEG, length: 0.46, thick: 0.04 },
];
/** 脚掌整体朝外侧斜偏的角度。 */
export const FOOT_YAW = 48 * DEG;

/** 环数 = 步数 + 1。一片鳞片脊要 5 个采样才描得出来，所以趾身采得比旧版密。 */
export const TOE_STEPS = 45;
export const TOE_RADIAL = 10;
export const TARSUS_RINGS = 28;
export const TARSUS_RADIAL = 12;
/** 趾身横截面：比高更宽、贴地那面平；背面 9 片鳞片脊。 */
export const TOE_FRAME: TubeFrame = { wide: 1.12, tall: 0.86, scutes: 9, scuteAmp: 0.14 };
/** 跗跖横截面：近圆，朝喙那面 7 片大的跗跖鳞。 */
export const TARSUS_FRAME: TubeFrame = { wide: 1.0, tall: 1.0, scutes: 7, scuteAmp: 0.1 };
/** 爪从趾长的这个比例开始（前面是趾身）。 */
const CLAW_AT = 0.8;

/**
 * 两只脚在栖枝上的落点：枝顶前后微错开、各略偏自己一侧（世界 x 与环向角，朝 side 为正）。
 * 跗跖落在这里，积雪也在这里被踩出小凹——脚趾贴的就是那个凹下去的雪面。
 */
export const FOOT_SPOTS: { worldX: number; alpha: number }[] = [
  { worldX: -0.11, alpha: 0.26 },
  { worldX: 0.13, alpha: -0.26 },
];

export interface Foot {
  /** 脚掌在枝条横截面上的环向角（朝 side 为正）。 */
  alpha: number;
  /** 脚掌沿枝轴的偏移（厘米，正 = 切线方向）。 */
  along: number;
  /** 右脚 1、左脚 -1：决定“外侧”是 +alpha 还是 -alpha。 */
  side: 1 | -1;
  /**
   * 横枝站（鸟站在枝的侧面、身体垂直于枝轴）时脚掌的朝向：脚趾展开的“正前方”在枝的切平面里相对 −切线 的角度（弧度）。
   * 不填 = 沿枝站（朝头，原公式：脚掌外撇 48°、前趾包外侧、后趾扣内侧）。填了之后三根前趾从正前方 ±40° 扇开包住枝的前侧、
   * 后趾朝正后方扣住后侧，两只脚都朝同一个方向卷（不再按 side 分内外）。
   */
  heading?: number;
}

/**
 * 脚趾贴着枝条真实表面走：把表面当成圆柱面，趾在切平面里的方向 (cos ψ, sin ψ) 决定每一步沿枝轴前进多少、
 * 绕枝转过多少，所以趾只会在表面上绕过去——不会顺着枝轴扎进木头，也不会悬空飞出枝外。
 * 趾身压在表面上（管心抬离表面 0.85 倍管径，底面微微压进雪里），趾节处微微鼓起；
 * 最后 22% 是爪：急剧收尖，并向表面内钩，爪尖抠进树皮/雪面一点点。
 * grip 是包握程度：1 = 绕枝卷住（默认，公式与原来逐位一致），0 = 顺着出发方向伸直（松脚 / 空中张爪）。
 */
export function toePath(
  surface: ToeSurface,
  foot: Foot,
  spec: ToeSpec,
  grip = 1,
): TubePath {
  const points: Vector3[] = [];
  const radii: number[] = [];
  const claw: number[] = [];
  const dorsal: Vector3[] = [];
  const n = new Vector3();
  let alpha = foot.alpha;
  let along = foot.along;
  const dL = spec.length / TOE_STEPS;
  const clawBase = spec.thick * 0.78;
  // 横枝站（foot.heading 给了）：脚掌正前方 = heading（切平面里相对 −切线 的角度）。前趾从正前方 ±40° 扇开、包住枝的前侧，
  // 包握时扇角收到六成；后趾朝正后方扣住后侧。两只脚都朝前卷，不按 side 分内外（沿枝站的公式不动，漫游入口逐位一致）
  const cross = foot.heading;
  for (let i = 0; i <= TOE_STEPS; i++) {
    const t = i / TOE_STEPS;
    const g = grip * smoothstep(0.1, 0.7, t);
    const psi =
      cross === undefined
        ? lerp(spec.psi0 + FOOT_YAW, spec.curl, g)
        : Math.abs(spec.psi0) > 1
          ? cross + Math.PI
          : cross + spec.psi0 * (1 - 0.4 * g);
    const u = clamp((t - CLAW_AT) / (1 - CLAW_AT), 0, 1);
    // 趾身：几乎不等粗（根 1.0 → 爪基 0.78），两个趾节处鼓起、节前略收，读起来是一节一节的
    const knuckle =
      1 +
      0.2 * (Math.exp(-(((t - 0.38) / 0.05) ** 2)) + Math.exp(-(((t - 0.68) / 0.05) ** 2))) -
      0.09 * (Math.exp(-(((t - 0.31) / 0.035) ** 2)) + Math.exp(-(((t - 0.61) / 0.035) ** 2)));
    const body = spec.thick * lerp(1, 0.78, clamp(t / CLAW_AT, 0, 1)) * knuckle;
    // 爪：接上趾身末端的角质锥，前半截几乎不收、往尖急剧收尖（不是一根针）
    const r = t < CLAW_AT ? body : Math.max(0.004, clawBase * Math.pow(1 - u, 0.75));
    // 爪是一条弯钩：中心线前半截翘离表面，尖上扎进树皮约 0.9 个爪根半径
    const hook = t < CLAW_AT ? 0 : clawBase * (0.7 * Math.sin(Math.PI * Math.min(u * 1.25, 1)) - 0.9 * u * u);
    const lift = r * TOE_FRAME.tall + hook;
    n.copy(surface.up).multiplyScalar(Math.cos(alpha)).addScaledVector(surface.side, Math.sin(alpha));
    const rr = surface.surfaceRadius(alpha, along) + lift;
    points.push(surface.center.clone().addScaledVector(surface.tangent, along).addScaledVector(n, rr));
    dorsal.push(n.clone());
    radii.push(r);
    claw.push(smoothstep(CLAW_AT, CLAW_AT + 0.04, t));
    // psi = 0 朝头：栖枝切线是枝的生长方向（朝枝梢 = 朝尾），所以沿 -tangent 走；alpha 仍朝脚的外侧卷（横枝站两只脚都朝前卷）
    along -= Math.cos(psi) * dL;
    alpha += ((cross === undefined ? foot.side : 1) * Math.sin(psi) * dL) / Math.max(rr, 0.05);
  }
  return { points, radii, dorsal, claw };
}

/** 跗跖的半径剖面（根 → 踝，厘米）：比趾粗，踝关节处略鼓。 */
export const TARSUS_RADII = [0.062, 0.054, 0.05, 0.052];
/** 鸟喙在鸟群局部坐标里的方向（+Z）：动态腿架在局部坐标里建，跗跖鳞长在朝喙的那面。 */
export const BEAK_LOCAL = new Vector3(0, 0, 1);

/**
 * 跗跖的放样路径：过 4 个控制点（膝、两个弓形偏移点、踝）的 Catmull-Rom 曲线采 TARSUS_RINGS 环，
 * 每环的背面 = 喙的方向投到与切线垂直的平面里（跗跖鳞长在朝喙的那面）。
 */
export function tarsusPath(ctrl: Vector3[], beakDir: Vector3): TubePath {
  // 均匀参数采样而不用弧长采样：getSpacedPoints 的弧长反查是 200 格的线性扫描，控制点差 1e-16（世界 / 局部坐标各算一遍）
  // 就可能落到相邻一格、输出差一整格（0.003 cm），静止态就复现不出逐位一致；跗跖几乎是直的，均匀采样看不出区别
  const points = new CatmullRomCurve3(ctrl, false, "centripetal").getPoints(TARSUS_RINGS - 1);
  const radii: number[] = [];
  const dorsal: Vector3[] = [];
  const tangent = new Vector3();
  const d = new Vector3();
  for (let i = 0; i < points.length; i++) {
    const s = i / (points.length - 1);
    const k = s * (TARSUS_RADII.length - 1);
    const k0 = Math.min(Math.floor(k), TARSUS_RADII.length - 2);
    radii.push(lerp(TARSUS_RADII[k0], TARSUS_RADII[k0 + 1], k - k0) * (1 + 0.1 * Math.exp(-(((s - 0.94) / 0.05) ** 2))));
    tangent.subVectors(points[Math.min(i + 1, points.length - 1)], points[Math.max(i - 1, 0)]).normalize();
    dorsal.push(d.copy(beakDir).addScaledVector(tangent, -beakDir.dot(tangent)).normalize().clone());
  }
  return { points, radii, dorsal, claw: NO_CLAW(points.length) };
}

/** 脚趾能贴着走的任何一个圆柱面：真实的栖枝（Perch）或抬脚时随脚掌走的虚拟圆柱。 */
export interface ToeSurface {
  center: Vector3;
  tangent: Vector3;
  up: Vector3;
  side: Vector3;
  surfaceRadius(alpha: number, along: number): number;
}

/**
 * 静态腿脚（阶段 1 之前的样子）：跗跖从腹羽里伸下来落在枝顶，两只脚在枝顶前后微错开、各略偏自己一侧，
 * 脚掌朝外侧斜偏约 48°；三根前趾贴着枝条真实表面包绕外侧弧面，后趾从内后侧反扣，每根趾末端一小段内钩的角质爪尖。
 * 路径先在世界坐标里按栖枝算好，再用 worldToLocal（鸟群的逆矩阵）转回鸟的局部坐标。
 * 现在鸟用的是 legs.ts 的动态腿架（LegRig），静止栖息态与这里逐位一致；这个函数留着当比对的基准。
 */
export function buildLegs(perch: Perch, worldToLocal: Matrix4): BufferGeometry {
  const parts: BufferGeometry[] = [];
  // 喙的方向按鸟群的实际朝向从 worldToLocal 反推（动态腿架重写跗跖时用的是局部 +Z，两边必须是同一个方向，
  // 否则鸟一转身跗跖鳞片就绕轴错开一个角度）
  const groupRot = new Quaternion();
  worldToLocal.decompose(new Vector3(), groupRot, new Vector3());
  const beakWorld = new Vector3(0, 0, 1).applyQuaternion(groupRot.invert());
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
    // 跗跖：从腹羽里伸出来，略向前倾、微微弓着（过 4 个控制点的样条，朝喙那面长跗跖鳞）
    const hip = new Vector3(-0.44, 0.62, 0.22 * s);
    parts.push(
      taperedTube(
        tarsusPath(
          [
            hip,
            hip.clone().lerp(ankle, 0.4).add(new Vector3(-0.04, 0, 0.01 * s)),
            hip.clone().lerp(ankle, 0.75).add(new Vector3(-0.02, 0, 0.005 * s)),
            ankle,
          ],
          beakWorld,
        ),
        TARSUS_RADIAL,
        TARSUS_FRAME,
      ),
    );
    for (const [k, spec] of TOES.entries()) {
      parts.push(taperedTube(toePath(perch, foot, spec), TOE_RADIAL, { ...TOE_FRAME, seed: k + s }));
    }
  }
  const merged = mergeGeometries(parts)!;
  for (const g of parts) g.dispose();
  merged.applyMatrix4(worldToLocal);
  return merged;
}

export function makeLegMaterial(lighting: LightingUniforms): ShaderMaterial {
  const uniforms: Record<string, IUniform> = {
    // 深琥珀暖黑褐的角质（2026-11-23 用户定色：不发冷蓝灰）：趾身暖黑褐、暗部（趾垫 / 鳞缝）#181213、
    // 受光的鳞片脊微透暖棕 #3d2720，爪是带润泽高光的暖黑角质
    uLegCol: { value: rgb('#2a1c19') },
    uScuteCol: { value: rgb('#3d2720') },
    uPadCol: { value: rgb('#181213') },
    uClawCol: { value: rgb('#14100e') },
  };
  return makeLitMaterial({
    lighting,
    side: DoubleSide,
    uniforms,
    fragmentPars: /* glsl */ `
uniform vec3 uLegCol;
uniform vec3 uScuteCol;
uniform vec3 uPadCol;
uniform vec3 uClawCol;
varying vec3 vObj;
varying float vClaw;
varying float vSc;
varying float vDorsal;
`,
    vertexPars: /* glsl */ `
attribute float aClaw;
attribute float aSc;
attribute float aDorsal;
varying vec3 vObj;
varying float vClaw;
varying float vSc;
varying float vDorsal;
`,
    vertexMain: /* glsl */ `
	vObj = position;
	vClaw = aClaw;
	vSc = aSc;
	vDorsal = aDorsal;
`,
    surface: /* glsl */ `
	Surf s;
	// 背面（鳞片面）：叠瓦状鳞片——每片根端一道暗缝、游离缘一条浅灰亮边（几何上还有对应的脊）；侧面归趾身色，只有腹面是趾垫
	float dorsal = smoothstep( -0.45, 0.1, vDorsal );
	float plate = fract( vSc );
	float seam = 1.0 - smoothstep( 0.0, 0.16, plate );
	float lip = smoothstep( 0.68, 0.95, plate ) * ( 1.0 - smoothstep( 0.95, 1.0, plate ) );
	// 每片的缝深 / 亮边强弱不一样，免得像一环环的箍
	float ph = fract( sin( floor( vSc ) * 12.9898 + 4.1 ) * 43758.5453 );
	float grain = snoise( vObj * 150.0 ) * 0.5 + 0.5;
	vec3 skin = mix( uPadCol, uLegCol, dorsal );
	skin *= 0.88 + 0.24 * grain;
	skin = mix( skin, uScuteCol, lip * dorsal * ( 0.45 + 0.6 * ( 1.0 - ph ) ) );
	skin *= 1.0 - 0.55 * seam * dorsal * ( 0.6 + 0.8 * ph );
	// 爪：深黑角质，带润泽的高光，越往尖越深
	s.albedo = mix( skin, uClawCol * ( 1.0 - 0.35 * vClaw ), vClaw );
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
