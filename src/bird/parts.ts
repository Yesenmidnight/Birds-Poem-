import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  type IUniform,
  type ShaderMaterial,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeLitMaterial, rgb, type LightingUniforms } from '../glsl/lit';
import { TAU, clamp, lerp } from '../util/math';
import type { BodyParams } from './bodySdf';

/**
 * 喙、眼、眼圈、腿脚。全部直接在鸟的局部坐标里生成，网格不需要额外的变换。
 */
const UP = new Vector3(0, 1, 0);
const X_AXIS = new Vector3(1, 0, 0);
const FWD = new Vector3(0, 0, 1);

// ---------------------------------------------------------------- 喙

/** 短而尖的黑色小喙：一节节变窄的截面放样，上嘴拱起、下嘴较浅，嘴缝处压出一道凹痕。 */
export function buildBeak(p: BodyParams): BufferGeometry {
  const rings = 18;
  const radial = 24;
  const base = new Vector3(...p.beakBase);
  const dir = new Vector3(...p.beakDir).normalize();
  const up = new Vector3().crossVectors(dir, X_AXIS).normalize();

  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= rings; i++) {
    const s = i / rings;
    const w = 0.19 * Math.pow(1 - s, 0.72) + 0.004;
    const hu = 0.17 * Math.pow(1 - s, 0.85) + 0.004;
    const hl = 0.1 * (1 - s) * (1 - s) + 0.003;
    // 嘴峰到尖端略微下弯
    const c = base.clone().addScaledVector(dir, s * p.beakLength).addScaledVector(up, -0.07 * s * s * p.beakLength);
    for (let j = 0; j <= radial; j++) {
      const th = (j / radial) * TAU;
      const sy = Math.sin(th);
      const h = sy >= 0 ? hu : hl;
      const gape = 1 - 0.11 * Math.exp(-((sy / 0.16) ** 2));
      const x = w * Math.cos(th) * gape;
      const y = h * sy * gape;
      pos.push(c.x + x, c.y + up.y * y, c.z + up.z * y);
      if (i < rings && j < radial) {
        const a = i * (radial + 1) + j;
        const b = a + 1;
        const cc = a + radial + 1;
        const d = cc + 1;
        idx.push(a, b, cc, b, d, cc);
      }
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export function makeBeakMaterial(lighting: LightingUniforms): ShaderMaterial {
  return makeLitMaterial({
    lighting,
    side: DoubleSide,
    uniforms: { uBeakCol: { value: rgb('#0d0c0d') } },
    fragmentPars: /* glsl */ `
uniform vec3 uBeakCol;
varying vec3 vObj;
`,
    vertexPars: /* glsl */ `
varying vec3 vObj;
`,
    vertexMain: /* glsl */ `
	vObj = position;
`,
    surface: /* glsl */ `
	Surf s;
	float grain = snoise( vObj * 120.0 ) * 0.5 + 0.5;
	s.albedo = uBeakCol * ( 0.8 + 0.4 * grain );
	s.ao = 1.0;
	s.wrap = 0.3;
	s.specTint = vec3( 1.0 );
	s.gloss = 0.62;
	s.specAmt = 0.55;
	s.alpha = 1.0;
	return s;
`,
  });
}

// ---------------------------------------------------------------- 眼

export interface EyeBuild {
  eyes: BufferGeometry;
  rings: BufferGeometry;
  radius: number;
}

/** 两颗眼球 + 浅色眼圈。眼球自带“相对注视轴的方向”属性，虹膜纹理据此绘制。 */
export function buildEyes(p: BodyParams): EyeBuild {
  const r = p.eyeRadius;
  const unit = new SphereGeometry(1, 36, 24);
  unit.setAttribute('aEye', new BufferAttribute(new Float32Array(unit.attributes.position.array as Float32Array), 3));

  const eyes: BufferGeometry[] = [];
  const rings: BufferGeometry[] = [];
  for (const side of [1, -1]) {
    const d = new Vector3(side * p.eyeDir[0], p.eyeDir[1], p.eyeDir[2]).normalize();
    const c = new Vector3(p.head.c[0], p.head.c[1], p.head.c[2]).addScaledVector(d, 0.66);
    const q = new Quaternion().setFromUnitVectors(FWD, d);

    const eye = unit.clone();
    eye.applyQuaternion(q).scale(r, r, r).translate(c.x, c.y, c.z);
    eyes.push(eye);

    const ring = new TorusGeometry(1, 0.062, 10, 48);
    ring.applyQuaternion(q).scale(r, r, r).translate(c.x - d.x * 0.06, c.y - d.y * 0.06, c.z - d.z * 0.06);
    rings.push(ring);
  }
  unit.dispose();
  return {
    eyes: mergeGeometries(eyes)!,
    rings: mergeGeometries(rings)!,
    radius: r,
  };
}

export function makeEyeMaterial(lighting: LightingUniforms, radius: number): ShaderMaterial {
  return makeLitMaterial({
    lighting,
    uniforms: {
      uPupil: { value: rgb('#050303') },
      uIris: { value: rgb('#3a2114') },
      uIrisDark: { value: rgb('#150a06') },
      uEyeR: { value: radius },
    },
    vertexPars: /* glsl */ `
attribute vec3 aEye;
varying vec3 vEye;
`,
    vertexMain: /* glsl */ `
	vEye = aEye;
`,
    fragmentPars: /* glsl */ `
uniform vec3 uPupil;
uniform vec3 uIris;
uniform vec3 uIrisDark;
uniform float uEyeR;
varying vec3 vEye;
`,
    surface: /* glsl */ `
	float r = length( vEye.xy );
	float ang = atan( vEye.y, vEye.x );
	float streak = snoise( vec3( cos( ang ) * 6.0, sin( ang ) * 6.0, r * 5.0 ) ) * 0.5 + 0.5;
	vec3 iris = mix( uIris * 0.75, uIris * 1.3, streak );
	vec3 alb = mix( uPupil, iris, smoothstep( 0.5, 0.6, r ) );
	alb = mix( alb, uIrisDark, smoothstep( 0.8, 0.97, r ) );
	Surf s;
	s.albedo = alb * 0.9;
	s.ao = 1.0;
	s.wrap = 0.2;
	s.specTint = vec3( 1.0 );
	s.gloss = 0.82;
	s.specAmt = 2.2;
	s.alpha = 1.0;
	return s;
`,
    extraLight: /* glsl */ `
	// 角膜映出周围环境：上方是天空，下方是雪地
	vec3 R = reflect( -V, N );
	vec3 env = mix( uGroundColor, uSkyColor * 1.5, smoothstep( -0.2, 0.5, R.y ) );
	float fres = 0.06 + 0.5 * pow( 1.0 - clamp( dot( N, V ), 0.0, 1.0 ), 4.0 );
	return env * fres;
`,
  });
}

export function makeRingMaterial(lighting: LightingUniforms): ShaderMaterial {
  return makeLitMaterial({
    lighting,
    side: DoubleSide,
    uniforms: { uRingCol: { value: rgb('#b3a888') } },
    fragmentPars: /* glsl */ `
uniform vec3 uRingCol;
`,
    surface: /* glsl */ `
	Surf s;
	s.albedo = uRingCol;
	s.ao = 1.0;
	s.wrap = 0.4;
	s.specTint = vec3( 1.0 );
	s.gloss = 0.4;
	s.specAmt = 0.1;
	s.alpha = 1.0;
	return s;
`,
  });
}

// ---------------------------------------------------------------- 腿脚

export interface Perch {
  /** 栖枝半径。 */
  radius: number;
  /** 栖枝轴线高度。 */
  axisY: number;
  /** 栖枝轴线在落点处的 z。 */
  axisZ: number;
}

/** 沿折线放样的变径管（平行传输标架），用于跗跖、脚趾和爪。 */
function taperedTube(points: Vector3[], radii: number[], radial = 8): BufferGeometry {
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
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** 脚趾贴着圆柱形枝条绕过去，末端是抠进树皮的爪尖。 */
function toePath(
  side: number,
  perch: Perch,
  footX: number,
  wrap: number, // 绕枝角度（弧度），正值朝前
  spread: number, // 向身体外侧撇开的角度
  thick: number,
  steps: number,
): { points: Vector3[]; radii: number[] } {
  const points: Vector3[] = [];
  const radii: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const phi = wrap * t;
    let r = perch.radius + thick * 0.7;
    // 最后一小段是爪：往树皮里抠
    const claw = clamp((t - 0.72) / 0.28, 0, 1);
    r -= 0.035 * claw * claw;
    const lat = Math.tan(spread) * phi * perch.radius * side;
    points.push(
      new Vector3(
        footX + lat,
        perch.axisY + Math.cos(phi) * r,
        perch.axisZ + Math.sin(phi) * r * Math.sign(wrap) + 0.02,
      ),
    );
    radii.push(lerp(thick, 0.004, Math.pow(t, 1.6)));
  }
  return { points, radii };
}

export function buildLegs(perch: Perch): BufferGeometry {
  const parts: BufferGeometry[] = [];
  for (const side of [1, -1]) {
    const footX = 0.3 * side;
    const ankle = new Vector3(footX, perch.axisY + perch.radius + 0.025, perch.axisZ + 0.09);
    // 跗跖：从腹羽里伸出来，略向前倾
    parts.push(
      taperedTube(
        [
          new Vector3(footX * 1.02, 0.66, 0.46),
          new Vector3(footX * 1.02, 0.36, 0.3),
          new Vector3(footX, 0.14, 0.13),
          ankle,
        ],
        [0.056, 0.048, 0.042, 0.04],
        9,
      ),
    );
    // 三前一后：前趾绕过枝顶抓向枝的前下方
    const front: [number, number][] = [
      [-0.5, 1.95],
      [-0.02, 2.2],
      [0.46, 1.9],
    ];
    for (const [spread, wrap] of front) {
      const toe = toePath(side, perch, footX, wrap, spread, 0.034, 14);
      parts.push(taperedTube(toe.points, toe.radii, 7));
    }
    const hallux = toePath(side, perch, footX, -1.5, 0.12, 0.03, 12);
    parts.push(taperedTube(hallux.points, hallux.radii, 7));
  }
  const merged = mergeGeometries(parts)!;
  for (const g of parts) g.dispose();
  return merged;
}

export function makeLegMaterial(lighting: LightingUniforms): ShaderMaterial {
  const uniforms: Record<string, IUniform> = { uLegCol: { value: rgb('#43353a') } };
  return makeLitMaterial({
    lighting,
    side: DoubleSide,
    uniforms,
    fragmentPars: /* glsl */ `
uniform vec3 uLegCol;
varying vec3 vObj;
`,
    vertexPars: /* glsl */ `
varying vec3 vObj;
`,
    vertexMain: /* glsl */ `
	vObj = position;
`,
    surface: /* glsl */ `
	Surf s;
	// 皮肤上细碎的鳞片
	float scale = snoise( vObj * 150.0 ) * 0.5 + 0.5;
	s.albedo = uLegCol * ( 0.8 + 0.4 * scale );
	s.ao = 1.0;
	s.wrap = 0.4;
	s.specTint = vec3( 1.0 );
	s.gloss = 0.35;
	s.specAmt = 0.14;
	s.alpha = 1.0;
	return s;
`,
  });
}
