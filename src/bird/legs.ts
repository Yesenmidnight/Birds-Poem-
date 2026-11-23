/**
 * 动态腿架（阶段 2）。两只腿各是一条两段链：髋（在躯干里，随呼吸和躯干姿态动）→ 膝（藏在腹羽里，朝头的方向顶）
 * → 踝（脚掌）。看得见的只有跗跖（膝 → 踝）和脚趾。鸟腿是“反曲”的：膝往前顶、踝在躯干下方偏后。
 *
 * 静止栖息时链正好伸直，膝落在原来静态腿（parts.ts 的 buildLegs）的跗跖起点上——几何就是 buildLegs 的输出，
 * 逐位一致，观鸟页面不受影响。蹲下时髋靠近踝，膝往前顶得多、跗跖前倾；站起时链拉直；
 * 髋再高就把脚拉离枝面（起跳——那时调用方把脚切成抬起态）。
 * 脚趾三态由 grip 控制：1 包握（现状）、0 张开、中间插值；抬脚时脚趾绕一根随脚掌走的虚拟圆柱长。
 *
 * 几何按静态腿的布局预分配（每脚：跗跖 28 环 × 12 段 + 四趾 46 环 × 10 段，横截面和鳞片脊见 parts.ts 的 tubeRings），
 * 每帧只改需要改的那一段的顶点；脚钉在枝上且包握着时脚趾一个字节都不动。
 */
import { BufferGeometry, Matrix4, Quaternion, Vector3 } from 'three';
import { lerp } from '../util/math';
import {
  BEAK_LOCAL,
  FOOT_SPOTS,
  TOES,
  TOE_FRAME,
  TOE_RADIAL,
  TOE_STEPS,
  TARSUS_FRAME,
  TARSUS_RADIAL,
  TARSUS_RINGS,
  buildLegs,
  tarsusPath,
  tubeRings,
  type Foot,
  type Perch,
  type ToeSurface,
  type TubeFrame,
  type TubePath,
  toePath,
} from './parts';

/** 隐藏段（股骨 + 胫跗骨，整段藏在腹羽里）的长度（厘米）。 */
const HIDDEN_LEN = 0.3;
/** 每段几何的顶点数：跗跖 TARSUS_RINGS 环、每趾 TOE_STEPS + 1 环，每环各自 radial + 1 个。 */
const PER_TARSUS = TARSUS_RINGS * (TARSUS_RADIAL + 1);
const PER_TOE = (TOE_STEPS + 1) * (TOE_RADIAL + 1);
/** 抬脚时脚趾完全张开（grip 0）所绕的虚拟圆柱半径：这么大差不多就是一个平面。 */
const VIRTUAL_FLAT = 2.5;

export interface FootState {
  /** 包握程度 0..1：1 绕枝卷住，0 张开。 */
  grip: number;
  /** 脚踝在鸟群局部坐标里的位置；null = 钉在枝上的落点。 */
  ankle: Vector3 | null;
  /** 抬脚时脚掌的朝向（局部坐标）：虚拟圆柱的切线与顶面。不填用栖枝切线的方向 / 世界 +Y。 */
  tangent?: Vector3;
  up?: Vector3;
}

/** 脚在枝上包握着：默认状态。 */
export function gripping(): FootState {
  return { grip: 1, ankle: null };
}

interface LegData {
  foot: Foot;
  /** 钉在枝上时的脚踝（局部）。 */
  ankle0: Vector3;
  /** 静止时跗跖从腹羽里出来的点（= 原静态腿的起点，局部）和它上方的髋。 */
  exit: Vector3;
  hip: Vector3;
  /** 跗跖长度。 */
  tarsus: number;
  /** 跗跖的微弓偏移（局部），和原静态腿一样。 */
  bowA: Vector3;
  bowB: Vector3;
  /** 膝顶出去的方向（局部）：静止时让解精确落在出肉点上，蹲下时膝往这个方向顶。 */
  poleDir: Vector3;
  /** 几何里跗跖 / 四根趾的起始顶点号。 */
  tarsusStart: number;
  toeStart: number[];
  /** 真实栖枝的标架转到局部坐标：松脚（grip < 1）时脚趾还贴着它张开。 */
  perchLocal: ToeSurface;
  /** 落点处栖枝的半径：抬脚包握时虚拟圆柱取这个粗细，卷出来的拳头和抓枝时一样。 */
  perchRadius: number;
  /** 脚趾顶点的静态副本（包握态），从抬起 / 张开恢复时直接拷回。 */
  toeRest: Float32Array;
  toesDirty: boolean;
  /** 上次写脚趾时的 grip：钉着松脚（雪地上摊开）时 grip 不变就不重算。 */
  lastGrip: number;
  /** 鳞片随机种（两脚不同）。 */
  seed: number;
}

const UP = new Vector3(0, 1, 0);
/**
 * 抬脚时虚拟圆柱的默认切线：和栖枝切线同一个方向（局部 -Z，枝梢那头）——toePath 的走向约定是 psi≈0 逆着切线朝喙，
 * 这样抬起的脚和钉在枝上的脚是同一套脚趾布局。
 */
const LIFT_TANGENT = new Vector3(0, 0, -1);

export class LegRig {
  readonly geometry: BufferGeometry;
  /** 两踝的中点（局部）：躯干姿态绕它转，脚才始终抓牢。 */
  readonly gripCenter: Vector3;
  /** 某只脚钉在栖面上时的踝位置（局部）：腾空时脚趾伸向它。 */
  ankleRest(i: 0 | 1, out: Vector3): Vector3 {
    return out.copy(this.legs[i].ankle0);
  }
  private readonly legs: LegData[] = [];
  private readonly positions: Float32Array;
  private lastBody = new Matrix4();
  /** 每条腿每帧复用的草稿（IK 向量 / 控制点 / 虚拟栖面 / 脚位）。 */
  private readonly scratch: LegScratch[] = [1, -1].map(() => ({
    hip: new Vector3(),
    ankle: new Vector3(),
    toAnkle: new Vector3(),
    pole: new Vector3(),
    ctrl: [new Vector3(), new Vector3(), new Vector3(), new Vector3()],
    foot: { alpha: 0, along: 0, side: 1, heading: 0 },
    virtual: makeVirtualScratch(),
  }));
  /** 重绑之后置位：下一帧不管躯干动没动都要重写跗跖。 */
  private forceUpdate = false;

  constructor(perch: Perch, worldToLocal: Matrix4) {
    // 几何直接拿静态腿的输出：静止态逐位一致，这里只记住各段的顶点位置，之后按需覆盖
    this.geometry = buildLegs(perch, worldToLocal);
    const attr = this.geometry.getAttribute('position') as { array: Float32Array; count: number };
    this.positions = attr.array;
    const perTarsus = PER_TARSUS;
    const perToe = PER_TOE;
    const expected = 2 * (perTarsus + TOES.length * perToe);
    if (attr.count !== expected) throw new Error(`腿几何顶点数 ${attr.count} 与布局 ${expected} 不符`);

    // 原静态腿的微弓偏移是世界坐标的，转成局部
    const rot = new Quaternion();
    worldToLocal.decompose(new Vector3(), rot, new Vector3());
    const toLocal = (x: number, y: number, z: number): Vector3 => new Vector3(x, y, z).applyQuaternion(rot);
    const perchLocal: ToeSurface = {
      center: perch.center.clone().applyMatrix4(worldToLocal),
      tangent: toLocal(perch.tangent.x, perch.tangent.y, perch.tangent.z),
      up: toLocal(perch.up.x, perch.up.y, perch.up.z),
      side: toLocal(perch.side.x, perch.side.y, perch.side.z),
      surfaceRadius: perch.surfaceRadius,
    };

    let cursor = 0;
    for (const s of [1, -1] as const) {
      const spot = FOOT_SPOTS[s === 1 ? 0 : 1];
      const exit = new Vector3(-0.44, 0.62, 0.22 * s).applyMatrix4(worldToLocal);
      const toeStart: number[] = [];
      for (let k = 0; k < TOES.length; k++) toeStart.push(cursor + perTarsus + k * perToe);
      const toeRest = this.positions.slice((cursor + perTarsus) * 3, (cursor + perTarsus + TOES.length * perToe) * 3);
      this.legs.push({
        foot: { alpha: spot.alpha, along: (spot.worldX - perch.center.x) / perch.tangent.x, side: s },
        ankle0: new Vector3(),
        exit,
        // 髋在出肉点正上方（隐藏段竖直藏在腹羽里），膝的长度 = 隐藏段、踝的长度 = 出肉点到踝：
        // 静止时反向运动学解出的膝正好落在出肉点上，而链没完全伸直（留一点余量，躯干微姿态不会拽脚）
        hip: exit.clone().add(new Vector3(0, HIDDEN_LEN, 0)),
        tarsus: 0,
        bowA: toLocal(-0.04, 0, 0.01 * s),
        bowB: toLocal(-0.02, 0, 0.005 * s),
        poleDir: new Vector3(),
        tarsusStart: cursor,
        toeStart,
        perchLocal,
        perchRadius: 0,
        toeRest,
        toesDirty: false,
        lastGrip: 1,
        seed: s,
      });
      cursor += perTarsus + TOES.length * perToe;
    }
    this.gripCenter = new Vector3();
    this.bind(perchLocal, [this.legs[0].foot, this.legs[1].foot]);
  }

  /**
   * 把两只脚重新绑到一个栖面（换落点 / 落地）。perchLocal 是栖面在鸟群局部坐标里的标架（鸟群要先摆进落点标架），
   * feet 是两只脚在这个标架里的落点。重算踝、跗跖长度、膝的顶出方向和包握态的脚趾（写进几何并存成 toeRest）。
   */
  bind(perchLocal: ToeSurface, feet: readonly [Foot, Foot]): void {
    for (const [i, leg] of this.legs.entries()) {
      const foot = feet[i];
      leg.foot.alpha = foot.alpha;
      leg.foot.along = foot.along;
      // 横枝站的脚掌朝向（parts.ts 的 Foot.heading）；沿枝站为 undefined，公式不变
      leg.foot.heading = foot.heading;
      const n = perchLocal.up.clone().multiplyScalar(Math.cos(foot.alpha)).addScaledVector(perchLocal.side, Math.sin(foot.alpha));
      leg.ankle0
        .copy(perchLocal.center)
        .addScaledVector(perchLocal.tangent, foot.along)
        .addScaledVector(n, perchLocal.surfaceRadius(foot.alpha, foot.along) + 0.03);
      leg.tarsus = leg.exit.distanceTo(leg.ankle0);
      // 膝顶出去的方向：取"髋—踝—出肉点"所在平面里朝前的那一侧，这样静止解精确落在出肉点上
      const toExit = leg.exit.clone().sub(leg.hip);
      const dir0 = leg.ankle0.clone().sub(leg.hip).normalize();
      leg.poleDir.copy(toExit).addScaledVector(dir0, -toExit.dot(dir0)).normalize();
      leg.perchLocal = perchLocal;
      leg.perchRadius = perchLocal.surfaceRadius(foot.alpha, foot.along);
      for (const [k, spec] of TOES.entries()) {
        writeTube(this.positions, leg.toeStart[k], toePath(perchLocal, leg.foot, spec), TOE_RADIAL, { ...TOE_FRAME, seed: k + leg.seed });
      }
      leg.toeRest.set(this.positions.subarray(leg.toeStart[0] * 3, (leg.toeStart[0] + TOES.length * PER_TOE) * 3));
      leg.toesDirty = false;
      leg.lastGrip = 1;
    }
    this.gripCenter.copy(this.legs[0].ankle0).add(this.legs[1].ankle0).multiplyScalar(0.5);
    // 链变了：下一帧不管躯干动没动都要重写跗跖
    this.forceUpdate = true;
  }

  /**
   * 按躯干当前的变换和两只脚的状态更新几何。bodyToGroup 是呼吸空间的矩阵（身体坐标 → 鸟群局部坐标）。
   * feet[0] 右脚、feet[1] 左脚。每帧复用 LegScratch 里的向量 / 虚拟栖面 / 控制点数组，不分配。
   */
  update(bodyToGroup: Matrix4, feet: readonly [FootState, FootState]): void {
    // 躯干没动、两只脚都钉在枝上包握着、脚趾也没被改过：什么都不用做（静止栖息态零开销、逐位不变）
    const idle =
      !this.forceUpdate &&
      bodyToGroup.equals(this.lastBody) &&
      feet[0].ankle === null &&
      feet[1].ankle === null &&
      feet[0].grip >= 1 &&
      feet[1].grip >= 1 &&
      !this.legs[0].toesDirty &&
      !this.legs[1].toesDirty;
    if (idle) return;
    this.forceUpdate = false;
    this.lastBody.copy(bodyToGroup);
    const pos = this.positions;
    for (const [i, leg] of this.legs.entries()) {
      const st = feet[i];
      const sc = this.scratch[i];
      const hip = sc.hip.copy(leg.hip).applyMatrix4(bodyToGroup);
      let ankle: Vector3 = st.ankle ?? leg.ankle0;
      // 两段链的反向运动学：在“髋—踝”和前方所成的平面里解膝的位置；够不着时链伸直、脚被拉到极限处
      // （调用方应当已把脚切成抬起态，这里兜底）
      const toAnkle = sc.toAnkle.copy(ankle).sub(hip);
      let d = toAnkle.length();
      const dir = d > 1e-9 ? toAnkle.multiplyScalar(1 / d) : toAnkle.set(0, -1, 0);
      const reach = HIDDEN_LEN + leg.tarsus;
      if (d > reach) {
        d = reach;
        ankle = sc.ankle.copy(hip).addScaledVector(dir, reach);
      }
      const a = Math.min(d, Math.max(0, (HIDDEN_LEN * HIDDEN_LEN - leg.tarsus * leg.tarsus + d * d) / (2 * d)));
      const h = Math.sqrt(Math.max(0, HIDDEN_LEN * HIDDEN_LEN - a * a));
      const pole = sc.pole.copy(leg.poleDir).addScaledVector(dir, -leg.poleDir.dot(dir));
      if (pole.lengthSq() < 1e-8) pole.copy(UP).addScaledVector(dir, -UP.dot(dir));
      pole.normalize();
      const knee = hip.addScaledVector(dir, a).addScaledVector(pole, h);

      // 跗跖：膝 → 踝，带原来的微弓（和静态腿同一条样条、同一套跗跖鳞）
      const ctrl = sc.ctrl;
      ctrl[0].copy(knee);
      ctrl[1].copy(knee).lerp(ankle, 0.4).add(leg.bowA);
      ctrl[2].copy(knee).lerp(ankle, 0.75).add(leg.bowB);
      ctrl[3].copy(ankle);
      writeTube(pos, leg.tarsusStart, tarsusPath(ctrl, BEAK_LOCAL), TARSUS_RADIAL, TARSUS_FRAME);

      // 钉在枝上：包握着 → 不动（脏了就拷回静态副本）；松脚但 grip 没变 → 脚趾和躯干无关，也不用重算
      const planted = st.ankle === null;
      if (planted) {
        if (st.grip >= 1) {
          if (leg.toesDirty) {
            pos.set(leg.toeRest, leg.toeStart[0] * 3);
            leg.toesDirty = false;
            leg.lastGrip = 1;
          }
          continue;
        }
        if (!leg.toesDirty && Math.abs(st.grip - leg.lastGrip) < 1e-4) continue;
      }
      leg.toesDirty = true;
      leg.lastGrip = st.grip;
      let surface = leg.perchLocal;
      let foot = leg.foot;
      if (!planted) {
        surface = virtualSurfaceInto(sc.virtual, ankle, st.tangent, st.up, lerp(VIRTUAL_FLAT, leg.perchRadius, st.grip)).surface;
        foot = sc.foot;
        foot.alpha = 0;
        foot.along = 0;
        foot.side = leg.foot.side;
        foot.heading = leg.foot.heading;
      }
      const frames = leg.seed > 0 ? TOE_FRAMES_R : TOE_FRAMES_L;
      for (const [k, spec] of TOES.entries()) {
        writeTube(pos, leg.toeStart[k], toePath(surface, foot, spec, st.grip), TOE_RADIAL, frames[k]);
      }
    }
    this.geometry.getAttribute('position').needsUpdate = true;
    this.geometry.computeVertexNormals();
  }
}

/** 每条腿每帧复用的草稿：IK 向量、跗跖样条的 4 个控制点、抬脚时的虚拟栖面和脚位。 */
interface LegScratch {
  hip: Vector3;
  ankle: Vector3;
  toAnkle: Vector3;
  pole: Vector3;
  ctrl: Vector3[];
  foot: Foot;
  virtual: ReturnType<typeof makeVirtualScratch>;
}

/** 抬脚时脚趾绕的虚拟圆柱（见 virtualSurfaceInto）：半径放在一个盒子里，surfaceRadius 闭包读它，对象本身常驻。 */
function makeVirtualScratch() {
  const radius = { v: 0 };
  const center = new Vector3();
  const tangent = new Vector3();
  const up = new Vector3();
  const side = new Vector3();
  const surface: ToeSurface = { center, tangent, up, side, surfaceRadius: () => radius.v };
  return { surface, radius, center, tangent, up, side };
}

/**
 * 抬脚时脚趾绕的虚拟圆柱：包握着（grip 1）时和真枝一样粗，脚趾卷成抓枝时一样的拳头；
 * 张开（grip 0）时接近一个平面，脚趾摊平只带一点自然的弯。
 * 圆柱顶面过脚踝（轴线在脚踝下方一个半径处），和钉在枝上时踝在枝顶一样。写进 v（不改传入的 tangent / up）。
 */
function virtualSurfaceInto(v: ReturnType<typeof makeVirtualScratch>, center: Vector3, tangent: Vector3 | undefined, up: Vector3 | undefined, radius: number): ReturnType<typeof makeVirtualScratch> {
  const u = v.up.copy(up ?? UP).normalize();
  const t = v.tangent.copy(tangent ?? LIFT_TANGENT);
  t.addScaledVector(u, -t.dot(u));
  if (t.lengthSq() < 1e-8) t.set(1, 0, 0).addScaledVector(u, -u.x);
  t.normalize();
  v.side.crossVectors(t, u).normalize();
  v.center.copy(center).addScaledVector(u, -radius);
  v.radius.v = radius;
  return v;
}

/** 每根趾的放样参数（鳞片脊按趾和左右脚取不同随机种），预先合成，每帧不分配。 */
const TOE_FRAMES_R: TubeFrame[] = TOES.map((_, k) => ({ ...TOE_FRAME, seed: k + 1 }));
const TOE_FRAMES_L: TubeFrame[] = TOES.map((_, k) => ({ ...TOE_FRAME, seed: k - 1 }));

/**
 * 把一条路径的管子写进顶点数组（起点顶点号 start）：和 parts.ts 的 taperedTube 走同一个 tubeRings，
 * 所以抬脚 / 蹲下时重写的跗跖、脚趾和静态腿是同一套横截面与鳞片脊。
 */
function writeTube(pos: Float32Array, start: number, path: TubePath, radial: number, frame: TubeFrame): void {
  tubeRings(path, radial, frame, (v, x, y, z) => {
    const o = (start + v) * 3;
    pos[o] = x;
    pos[o + 1] = y;
    pos[o + 2] = z;
  });
}

