import {
  BufferGeometry,
  CatmullRomCurve3,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Mesh,
  Quaternion,
  SphereGeometry,
  Vector3,
  type IUniform,
} from 'three';
import { makeLitMaterial, rgb, type LightingUniforms } from '../glsl/lit';
import type { Perch } from '../bird/parts';
import { TAU, clamp, interpKeys, lerp, noise1, noise3 } from '../util/math';

/**
 * 程序化树枝：沿样条曲线放平行标架，半径由关键点插值再叠加噪声起伏；
 * 树皮、地衣、积雪全在片元着色器里按“沿枝长度 × 环向角”现算。
 */
export interface LimbSpec {
  points: [number, number, number][];
  radii: number[];
  segments?: number;
  radial?: number;
  seed?: number;
  snow?: boolean;
  /** 在这些弧长比例处长芽。 */
  buds?: number[];
}

interface Frame {
  c: Vector3;
  t: Vector3;
  n: Vector3;
  b: Vector3;
  r: number;
  along: number;
}

const UP = new Vector3(0, 1, 0);

/** 平行传输标架：法线沿曲线平滑旋转，不会像 Frenet 标架那样在拐点翻转。 */
function parallelFrames(points: Vector3[]): { t: Vector3; n: Vector3; b: Vector3 }[] {
  const count = points.length;
  const tangents: Vector3[] = [];
  for (let i = 0; i < count; i++) {
    const a = points[Math.max(i - 1, 0)];
    const b = points[Math.min(i + 1, count - 1)];
    tangents.push(new Vector3().subVectors(b, a).normalize());
  }
  const t0 = tangents[0];
  const ref = Math.abs(t0.y) < 0.9 ? UP : new Vector3(1, 0, 0);
  let n = new Vector3().crossVectors(t0, ref).normalize();
  const q = new Quaternion();
  const axis = new Vector3();
  const out: { t: Vector3; n: Vector3; b: Vector3 }[] = [];
  for (let i = 0; i < count; i++) {
    const t = tangents[i];
    if (i > 0) {
      axis.crossVectors(tangents[i - 1], t);
      const sin = axis.length();
      const cos = clamp(tangents[i - 1].dot(t), -1, 1);
      if (sin > 1e-7) {
        q.setFromAxisAngle(axis.multiplyScalar(1 / sin), Math.atan2(sin, cos));
        n.applyQuaternion(q);
      }
      n.addScaledVector(t, -n.dot(t)).normalize();
    }
    out.push({ t: t.clone(), n: n.clone(), b: new Vector3().crossVectors(t, n).normalize() });
  }
  return out;
}

/** 树皮表面半径：低频鼓包 + 细碎粗糙。 */
function ringRadius(r: number, along: number, cx: number, cz: number, seed: number): number {
  const lump = (noise3(along * 0.5 + seed * 13.7, cx * 1.6, cz * 1.6) - 0.5) * 2;
  const fine = (noise3(along * 3.5 + seed * 7.1, cx * 5.0, cz * 5.0) - 0.5) * 2;
  return r * (1 + 0.06 * lump + 0.025 * fine);
}

/** 枝条横截面的“顶面”方向与“侧向”（侧向 = 切线 × 顶面，主枝上指向世界 +Z）。 */
function limbAxes(t: Vector3, up: Vector3, side: Vector3): void {
  up.copy(UP).addScaledVector(t, -UP.dot(t)).normalize();
  side.crossVectors(t, up).normalize();
}

/**
 * 积雪帽在环向角 ph（从顶面起算，朝 side 为正）处的表面半径；这个角度上没有雪就返回 null。
 * 网格和脚爪的抓握查询都走这一个函数，脚趾贴的就是真正画出来的那个雪面。
 * press 是脚爪落点：雪在这些地方被踩得微微凹下去一点，凹不穿到树皮。
 */
function snowSurface(
  f: Frame,
  seed: number,
  ph: number,
  along: number,
  up: Vector3,
  side: Vector3,
  press: readonly SnowPress[] = PRESS_NONE,
): number | null {
  // 越平的枝条积雪越宽，越陡越窄；细梢只挂一条窄边
  const half =
    1.62 *
    (1 - 0.5 * Math.abs(f.t.y)) *
    (0.86 + 0.28 * (noise1(f.along * 0.45 + seed, 3) - 0.5) * 2) *
    clamp(f.r / 0.3, 0.35, 1);
  if (Math.abs(ph) > half) return null;
  const depthAmt = 0.15 * clamp(f.r / 0.55, 0.4, 1.25);
  const cx = up.x * Math.cos(ph) + side.x * Math.sin(ph);
  const cy = up.y * Math.cos(ph) + side.y * Math.sin(ph);
  const cz = up.z * Math.cos(ph) + side.z * Math.sin(ph);
  const prof = Math.pow(Math.cos((ph / Math.max(half, 1e-3)) * Math.PI * 0.5), 0.7);
  const lumps = 0.55 + 0.45 * noise3(along * 2.0, ph * 2.2 + seed, 5.5);
  const depth = depthAmt * prof * lumps;
  const bark = ringRadius(f.r, along, cx * f.n.x + cy * f.n.y + cz * f.n.z, cx * f.b.x + cy * f.b.y + cz * f.b.z, seed);
  // 脚爪落点处雪被踩出的小凹：沿枝和环向各一个高斯
  let dent = 0;
  for (const p of press) {
    const da = f.c.x + along * f.t.x - p.worldX;
    const dl = (ph - p.alpha) * f.r;
    dent += PRESS_DEPTH * Math.exp(-(da * da + dl * dl) / (PRESS_RADIUS * PRESS_RADIUS));
  }
  return Math.max(bark, bark + depth + 0.004 - dent);
}

/** 脚爪落点（世界 x 与环向角）：积雪在这里被踩得微微凹下去。 */
export interface SnowPress {
  worldX: number;
  alpha: number;
}
const PRESS_NONE: readonly SnowPress[] = [];
/** 踩凹的深度和半径（厘米）。 */
const PRESS_DEPTH = 0.035;
const PRESS_RADIUS = 0.16;

interface Limb {
  bark: BufferGeometry;
  snow: BufferGeometry | null;
  curve: CatmullRomCurve3;
  radii: number[];
  seed: number;
  frames: Frame[];
}

function buildLimb(spec: LimbSpec, press: readonly SnowPress[] = PRESS_NONE): Limb {
  const seed = spec.seed ?? 0;
  const segs = spec.segments ?? 150;
  const radial = spec.radial ?? 28;
  const curve = new CatmullRomCurve3(
    spec.points.map((p) => new Vector3(p[0], p[1], p[2])),
    false,
    'centripetal',
  );
  const length = curve.getLength();
  const centers = curve.getSpacedPoints(segs);
  const pf = parallelFrames(centers);

  const frames: Frame[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    frames.push({
      c: centers[i],
      t: pf[i].t,
      n: pf[i].n,
      b: pf[i].b,
      r: interpKeys(spec.radii, t),
      along: t * length,
    });
  }

  // ---------- 树皮网格 ----------
  const cols = radial + 1;
  const pos = new Float32Array((segs + 1) * cols * 3);
  const bark = new Float32Array((segs + 1) * cols * 2);
  const idx: number[] = [];
  const tmp = new Vector3();
  for (let i = 0; i <= segs; i++) {
    const f = frames[i];
    for (let j = 0; j <= radial; j++) {
      const th = (j / radial) * TAU;
      const cx = Math.cos(th);
      const cz = Math.sin(th);
      const rr = ringRadius(f.r, f.along, cx, cz, seed);
      tmp.copy(f.c).addScaledVector(f.n, cx * rr).addScaledVector(f.b, cz * rr);
      const k = i * cols + j;
      pos.set([tmp.x, tmp.y, tmp.z], k * 3);
      bark.set([f.along, th], k * 2);
      if (i < segs && j < radial) {
        const a = k;
        const b = k + 1;
        const c = k + cols;
        const d = c + 1;
        idx.push(a, b, c, b, d, c);
      }
    }
  }
  const barkGeo = new BufferGeometry();
  barkGeo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  barkGeo.setAttribute('aBark', new Float32BufferAttribute(bark, 2));
  barkGeo.setIndex(idx);
  barkGeo.computeVertexNormals();

  // ---------- 积雪帽：只在朝上的一面生成一条有厚度的弧面 ----------
  let snowGeo: BufferGeometry | null = null;
  if (spec.snow) {
    const K = 10;
    const scols = K + 1;
    const spos = new Float32Array((segs + 1) * scols * 3);
    const sidx: number[] = [];
    const up = new Vector3();
    const side = new Vector3();
    const dir = new Vector3();
    for (let i = 0; i <= segs; i++) {
      const f = frames[i];
      limbAxes(f.t, up, side);
      // 越平的枝条积雪越宽，越陡越窄；细梢只挂一条窄边
      const half =
        1.62 *
        (1 - 0.5 * Math.abs(f.t.y)) *
        (0.86 + 0.28 * (noise1(f.along * 0.45 + seed, 3) - 0.5) * 2) *
        clamp(f.r / 0.3, 0.35, 1);
      for (let j = 0; j <= K; j++) {
        const ph = ((j / K) * 2 - 1) * half;
        dir.copy(up).multiplyScalar(Math.cos(ph)).addScaledVector(side, Math.sin(ph));
        const rr = snowSurface(f, seed, ph, f.along, up, side, press)!;
        tmp.copy(f.c).addScaledVector(dir, rr);
        const k = i * scols + j;
        spos.set([tmp.x, tmp.y, tmp.z], k * 3);
        if (i < segs && j < K) {
          const a = k;
          const b = k + 1;
          const c = k + scols;
          const d = c + 1;
          sidx.push(a, b, c, b, d, c);
        }
      }
    }
    snowGeo = new BufferGeometry();
    snowGeo.setAttribute('position', new Float32BufferAttribute(spos, 3));
    snowGeo.setIndex(sidx);
    snowGeo.computeVertexNormals();
  }

  return { bark: barkGeo, snow: snowGeo, curve, radii: spec.radii, seed, frames };
}

/** 主枝 + 几根带芽的细枝，鸟停在主枝 x≈0 处（枝面高度约 y=0）。 */
const LIMBS: LimbSpec[] = [
  {
    points: [
      [-46, -4.6, -11],
      [-26, -1.75, -3.7],
      [-11, -0.58, -0.55],
      [0, -0.42, 0],
      [9.5, -0.05, 0.75],
      [21, 1.1, 1.9],
    ],
    radii: [2.4, 1.35, 0.74, 0.42, 0.28, 0.05],
    segments: 190,
    radial: 34,
    seed: 1,
    snow: true,
    buds: [0.86, 0.93],
  },
  {
    points: [
      [-13, -0.72, -0.75],
      [-16.5, 1.6, -1.9],
      [-18.5, 4.6, -2.6],
      [-19, 7.4, -2.3],
    ],
    radii: [0.36, 0.24, 0.13, 0.04],
    segments: 70,
    radial: 16,
    seed: 2,
    snow: true,
    buds: [0.35, 0.62, 0.88],
  },
  {
    points: [
      [7.5, -0.2, 0.55],
      [10.5, 1.3, 1.9],
      [13, 3.2, 2.4],
      [14.2, 5.3, 2.0],
    ],
    radii: [0.24, 0.16, 0.09, 0.03],
    segments: 70,
    radial: 16,
    seed: 3,
    snow: true,
    buds: [0.4, 0.72, 0.95],
  },
  {
    points: [
      [16.5, 0.55, 1.4],
      [19, 0.2, 2.6],
      [21.5, -0.35, 3.4],
    ],
    radii: [0.14, 0.09, 0.03],
    segments: 50,
    radial: 14,
    seed: 4,
    snow: true,
    buds: [0.55, 0.9],
  },
];

export class Branches extends Group {
  readonly barkUniforms: Record<string, IUniform>;
  /** 主枝（鸟停的那一根）：抓握查询用它的平行标架。 */
  private readonly main: Limb;
  private readonly press: readonly SnowPress[];

  /** press：脚爪落点，积雪在那里被踩出小凹；和 Bird 的 FOOT_SPOTS 是同一组数。 */
  constructor(lighting: LightingUniforms, press: readonly SnowPress[] = PRESS_NONE) {
    super();
    this.barkUniforms = {
      uBarkDark: { value: rgb('#4a4038') },
      uBarkLight: { value: rgb('#8a7f70') },
      uLichen: { value: rgb('#9da38b') },
      uSnowCol: { value: rgb('#eef1f4') },
    };
    this.press = press;
    this.main = buildLimb(LIMBS[0], press);
    const common = {
      uSnowCol: this.barkUniforms.uSnowCol,
    };

    const barkMat = makeLitMaterial({
      lighting,
      side: DoubleSide,
      uniforms: this.barkUniforms,
      vertexPars: /* glsl */ `
attribute vec2 aBark;
varying vec2 vBark;
`,
      vertexMain: /* glsl */ `
	vBark = aBark;
`,
      fragmentPars: /* glsl */ `
uniform vec3 uBarkDark;
uniform vec3 uBarkLight;
uniform vec3 uLichen;
uniform vec3 uSnowCol;
varying vec2 vBark;
`,
      surface: /* glsl */ `
	// 环向用 (cos, sin) 采样，保证接缝两侧连续
	vec3 sp = vec3( cos( vBark.y ), sin( vBark.y ), 0.0 );
	float streak = fbm3( vec3( sp.x * 2.2, sp.y * 2.2, vBark.x * 0.5 ) );
	float fine = snoise( vec3( sp.x * 9.0, sp.y * 9.0, vBark.x * 5.0 ) ) * 0.5 + 0.5;
	vec3 bark = mix( uBarkDark, uBarkLight, streak * 0.75 + fine * 0.25 );
	float crack = 1.0 - smoothstep( 0.3, 0.42, streak );
	bark *= 1.0 - 0.5 * crack;
	float li = fbm3( vec3( sp.x * 5.0, sp.y * 5.0, vBark.x * 1.5 + 37.0 ) );
	float lichen = smoothstep( 0.55, 0.63, li );
	bark = mix( bark, uLichen, lichen * 0.5 );

	float up = N.y + ( fbm3( vWorldPos * 3.0 ) - 0.5 ) * 0.45;
	float sn = smoothstep( 0.45, 0.8, up );
	Surf s;
	s.albedo = mix( bark, uSnowCol, sn );
	s.ao = 1.0;
	s.wrap = 0.25;
	s.specTint = vec3( 1.0 );
	s.gloss = mix( 0.25, 0.45, sn );
	s.specAmt = mix( 0.04, 0.12, sn );
	s.alpha = 1.0;
	return s;
`,
    });

    const snowMat = makeLitMaterial({
      lighting,
      side: DoubleSide,
      uniforms: common,
      fragmentPars: /* glsl */ `
uniform vec3 uSnowCol;
`,
      surface: /* glsl */ `
	Surf s;
	float grain = snoise( vWorldPos * 14.0 ) * 0.5 + 0.5;
	s.albedo = uSnowCol * ( 0.93 + 0.07 * grain );
	s.ao = 0.92;
	s.wrap = 0.5;
	// 雪粒的细碎闪光
	float sp = step( 0.986, hash13( floor( vWorldPos * 70.0 ) ) );
	s.specTint = vec3( 1.0 );
	s.gloss = max( 0.5, sp * 0.92 );
	s.specAmt = 0.14 + sp * 0.7;
	s.alpha = 1.0;
	return s;
`,
    });

    const budMat = makeLitMaterial({
      lighting,
      uniforms: { uBudCol: { value: rgb('#5c352a') } },
      fragmentPars: /* glsl */ `
uniform vec3 uBudCol;
`,
      surface: /* glsl */ `
	Surf s;
	float m = fbm3( vWorldPos * 40.0 );
	s.albedo = uBudCol * ( 0.8 + 0.4 * m );
	s.ao = 1.0;
	s.wrap = 0.3;
	s.specTint = vec3( 1.0 );
	s.gloss = 0.55;
	s.specAmt = 0.22;
	s.alpha = 1.0;
	return s;
`,
    });

    const budGeo = new SphereGeometry(1, 14, 10);
    const tmpV = new Vector3();
    const tmpN = new Vector3();
    const tmpT = new Vector3();
    const tmpQ = new Quaternion();

    for (const [index, spec] of LIMBS.entries()) {
      const limb = index === 0 ? this.main : buildLimb(spec);
      const barkMesh = new Mesh(limb.bark, barkMat);
      barkMesh.castShadow = true;
      barkMesh.receiveShadow = true;
      this.add(barkMesh);

      if (limb.snow) {
        const snowMesh = new Mesh(limb.snow, snowMat);
        snowMesh.castShadow = true;
        snowMesh.receiveShadow = true;
        this.add(snowMesh);
      }

      for (const t of spec.buds ?? []) {
        const p = limb.curve.getPointAt(t);
        const r = interpKeys(limb.radii, t);
        const tangent = limb.curve.getTangentAt(t);
        if (Math.abs(tangent.y) > 0.95) {
          tmpN.set(1, 0, 0).addScaledVector(tangent, -tangent.x);
        } else {
          tmpN.set(0, 1, 0).addScaledVector(tangent, -tangent.y);
        }
        tmpN.normalize();
        tmpT.crossVectors(tangent, tmpN);
        const a = noise1(t * 40 + (spec.seed ?? 0), 9) * TAU;
        tmpV.copy(tmpN).multiplyScalar(Math.cos(a)).addScaledVector(tmpT, Math.sin(a));
        const bud = new Mesh(budGeo, budMat);
        const s = clamp(r / 0.22, 0.8, 1.5);
        bud.scale.set(0.12 * s, 0.2 * s, 0.12 * s);
        bud.position.copy(p).addScaledVector(tmpV, r * 0.92);
        tmpQ.setFromUnitVectors(UP, tmpV.multiplyScalar(0.7).addScaledVector(tangent, 0.55).normalize());
        bud.quaternion.copy(tmpQ);
        bud.castShadow = true;
        bud.receiveShadow = true;
        this.add(bud);
      }
    }
  }

  /** 主枝上离给定世界 x 最近的那一帧（相邻两帧线性插值）。 */
  private frameAt(worldX: number): Frame {
    const frames = this.main.frames;
    let i = 0;
    while (i < frames.length - 2 && frames[i + 1].c.x < worldX) i++;
    const a = frames[i];
    const b = frames[i + 1];
    const u = clamp((worldX - a.c.x) / (b.c.x - a.c.x), 0, 1);
    return {
      c: a.c.clone().lerp(b.c, u),
      t: a.t.clone().lerp(b.t, u).normalize(),
      n: a.n.clone().lerp(b.n, u).normalize(),
      b: a.b.clone().lerp(b.b, u).normalize(),
      r: lerp(a.r, b.r, u),
      along: lerp(a.along, b.along, u),
    };
  }

  /**
   * 主枝在给定世界 x 处的抓握几何：中心、切线、顶面/侧向，以及任意环向角、任意轴向偏移处的真实外表面半径
   * （树皮鼓包 + 积雪帽都算进去）。脚爪的每个路径点都从这里查，贴的就是画出来的那个面。
   */
  perchAt(worldX: number): Perch {
    const f = this.frameAt(worldX);
    const up = new Vector3();
    const side = new Vector3();
    limbAxes(f.t, up, side);
    const seed = this.main.seed;
    const hasSnow = this.main.snow !== null;
    const dir = new Vector3();
    return {
      center: f.c,
      tangent: f.t,
      up,
      side,
      radius: f.r,
      surfaceRadius: (alpha: number, along: number): number => {
        const alongAbs = f.along + along;
        dir.copy(up).multiplyScalar(Math.cos(alpha)).addScaledVector(side, Math.sin(alpha));
        const bark = ringRadius(f.r, alongAbs, dir.dot(f.n), dir.dot(f.b), seed);
        const snow = hasSnow ? snowSurface(f, seed, alpha, alongAbs, up, side, this.press) : null;
        return snow === null ? bark : Math.max(bark, snow);
      },
    };
  }
}
