import {
  BufferGeometry,
  Group,
  Matrix4,
  Mesh,
  Quaternion,
  Vector3,
  Euler,
  type IUniform,
  type Object3D,
} from 'three';
import type { LightingUniforms } from '../glsl/lit';
import { LONG_TAILED_TIT, type BodyParams } from './bodySdf';
import { buildBody } from './body';
import { Fur } from './fur';
import { makeFeatherMaterial } from './feathers';
import { WING_PIVOT, buildTail, buildWing, buildWingPanel, makeWingPanelMaterial } from './wingTail';
import {
  LID_GAP_LOWER,
  LID_GAP_UPPER,
  buildEyeball,
  buildEyelid,
  buildLegs,
  buildMandible,
  buildNictitating,
  eyeFrame,
  makeBeakMaterial,
  makeEyeMaterial,
  makeLegMaterial,
  makeLidMaterial,
  makeNictMaterial,
  type Perch,
} from './parts';
import { clamp, lerp } from '../util/math';
import { type BodyPose, type Pose } from './motion/Pose';

export type BirdPart = 'fur' | 'feathers' | 'beak' | 'eyes' | 'legs';

/** 呼吸时胸腹绕这个中心微膨胀（腹部中心），绒毛、喙眼、翅尾一起被顶起，腿不动。 */
const BREATH_CENTER = new Vector3(0, 1.85, -0.5);
/** 吸满气时的纵向膨胀比例。 */
const BREATH_SCALE = 0.015;
/** 躯干微姿态绕这个点转：双脚在枝上的抓握点，这样脚始终抓牢树枝、不悬空滑移。 */
const BODY_PIVOT = new Vector3(0, 0, 0.05);

/**
 * 眨眼：lidClose 为合拢程度 0..1（下睑上抬约 70%、上睑下压约 30%）；
 * nictClose 为瞬膜从前眼角向后眼角扫过的程度 0..1；squint 只抬下眼睑做出弯月眯眼 0..1。
 */
export interface BlinkPose {
  lidClose?: number;
  nictClose?: number;
  squint?: number;
}

/** 翅膀姿态（弧度）：lift 绕前后轴抬落，sweep 绕竖轴前后扫，twist 沿翅展方向翻转。 */
export interface WingPose {
  lift?: number;
  sweep?: number;
  twist?: number;
}

/** 尾羽姿态（弧度）：pitch 上翘为正，yaw 左右甩，roll 滚转，spread 为扇开角。 */
export interface TailPose {
  pitch?: number;
  yaw?: number;
  roll?: number;
  spread?: number;
}

interface EyeRig {
  upper: Mesh<BufferGeometry, ReturnType<typeof makeLidMaterial>>;
  lower: Mesh<BufferGeometry, ReturnType<typeof makeLidMaterial>>;
  nict: Mesh<BufferGeometry, ReturnType<typeof makeNictMaterial>>;
  nictX: IUniform<number>;
}

/**
 * 北长尾山雀：躯体（隐式曲面 + 绒毛）+ 翅尾正羽 + 分体上下喙 + 三层眼（眼球/眼睑/瞬膜）+ 腿脚。
 * 所有部件都在鸟的局部坐标里生成，整体再摆到栖枝上。
 * 可动部分各自挂在枢轴下：上下喙绕嘴根铰链、眼睑绕眼角横轴、双翅绕翅根、尾羽绕尾基。
 */
export class Bird {
  readonly group = new Group();
  readonly fur: Fur;
  readonly bodyGeometry: BufferGeometry;
  readonly params: BodyParams;

  private readonly parts: Record<BirdPart, { objs: Object3D[]; on: boolean }>;
  // 呼吸空间：绒毛、喙眼、翅、尾都挂在这里，跟着胸腹一起微膨胀、跟着躯干微姿态一起绕抓握点转（腿不动）
  private readonly breathSpace = new Group();
  private breathAmount = 0;
  private readonly bodyEuler = new Euler();
  // 喙和眼是刚体，整组跟着头部骨骼的矩阵走
  private readonly headParts = new Group();
  private readonly jawUpper = new Group();
  private readonly jawLower = new Group();
  private readonly eyes: EyeRig[] = [];
  private readonly wingPivots: Record<'left' | 'right', Group> = { left: new Group(), right: new Group() };
  private readonly tailPivot = new Group();
  private readonly tailSpread: IUniform<number>;
  private readonly neckPivot = new Vector3(0, 2.8, 0.4);
  private readonly headPivot = new Vector3(0, 3.15, 0.55);
  private readonly mNeck = new Matrix4();
  private readonly mHead = new Matrix4();
  private readonly shift = new Matrix4();
  private readonly rot = new Matrix4();
  private readonly quat = new Quaternion();
  private readonly euler = new Euler();

  constructor(lighting: LightingUniforms, perch: Perch, params: BodyParams = LONG_TAILED_TIT) {
    this.params = params;
    const t0 = performance.now();

    const body = buildBody(params);
    this.bodyGeometry = body.geometry;
    this.fur = new Fur(body.geometry, lighting);
    this.breathSpace.matrixAutoUpdate = false;

    // ---------- 双翅与尾：各自一个枢轴 ----------
    const wingMat = makeFeatherMaterial(lighting);
    const tailMat = makeFeatherMaterial(lighting);
    const panelMat = makeWingPanelMaterial(lighting);
    this.tailSpread = tailMat.uniforms.uSpread!;
    let featherCount = 0;
    for (const side of ['right', 'left'] as const) {
      const s = side === 'right' ? 1 : -1;
      const wing = buildWing(params, 5, s);
      featherCount += wing.count;
      const mesh = new Mesh(wing.geometry, wingMat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // 翼内遮光底壳：藏在正羽轮廓以内，羽片根部之间的缝不透体表
      const panel = new Mesh(buildWingPanel(params, s, wing.placements), panelMat);
      panel.receiveShadow = true;
      const pivot = this.wingPivots[side];
      pivot.position.set(s * WING_PIVOT.x, WING_PIVOT.y, WING_PIVOT.z);
      pivot.add(panel, mesh);
      this.breathSpace.add(pivot);
    }
    const tail = buildTail(params);
    featherCount += tail.count;
    const tailMesh = new Mesh(tail.geometry, tailMat);
    tailMesh.castShadow = true;
    tailMesh.receiveShadow = true;
    this.tailPivot.position.set(params.tailBase[0], params.tailBase[1], params.tailBase[2]);
    this.tailPivot.add(tailMesh);
    this.breathSpace.add(this.tailPivot);

    // ---------- 上下喙：绕嘴根铰链张合 ----------
    const beakBase = new Vector3(...params.beakBase);
    const upper = new Mesh(buildMandible(params, true), makeBeakMaterial(lighting, params, true));
    const lower = new Mesh(buildMandible(params, false), makeBeakMaterial(lighting, params, false));
    for (const [grp, mesh] of [
      [this.jawUpper, upper],
      [this.jawLower, lower],
    ] as const) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.position.copy(beakBase).negate();
      grp.position.copy(beakBase);
      grp.add(mesh);
    }
    this.headParts.add(this.jawUpper, this.jawLower);

    // ---------- 眼：眼球 + 上下眼睑壳 + 瞬膜，都在眼睛局部坐标系里 ----------
    const eyeMat = makeEyeMaterial(lighting);
    const lidUpperMat = makeLidMaterial(lighting, true);
    const lidLowerMat = makeLidMaterial(lighting, false);
    for (const side of [1, -1] as const) {
      const frame = eyeFrame(params, side);
      const g = new Group();
      g.position.copy(frame.center);
      g.quaternion.copy(frame.quat);

      const eyeball = new Mesh(buildEyeball(params), eyeMat);
      eyeball.castShadow = true;
      eyeball.receiveShadow = true;
      const upperLid = new Mesh(buildEyelid(params, true), lidUpperMat);
      const lowerLid = new Mesh(buildEyelid(params, false), lidLowerMat);
      const nictMat = makeNictMaterial(lighting, frame.forwardLocal);
      const nict = new Mesh(buildNictitating(params), nictMat);
      nict.visible = false;
      nict.renderOrder = 2;
      g.add(eyeball, upperLid, lowerLid, nict);
      this.headParts.add(g);
      this.eyes.push({ upper: upperLid, lower: lowerLid, nict, nictX: nictMat.uniforms.uNictX! });
    }
    this.headParts.matrixAutoUpdate = false;

    const legs = new Mesh(buildLegs(perch), makeLegMaterial(lighting));
    legs.castShadow = true;
    legs.receiveShadow = true;

    this.parts = {
      fur: { objs: [this.fur.group], on: true },
      feathers: { objs: [this.wingPivots.right, this.wingPivots.left, this.tailPivot], on: true },
      beak: { objs: [this.jawUpper, this.jawLower], on: true },
      eyes: { objs: [...this.headParts.children.filter((c) => c !== this.jawUpper && c !== this.jawLower)], on: true },
      legs: { objs: [legs], on: true },
    };
    this.breathSpace.add(this.headParts, this.fur.group);
    this.group.add(this.breathSpace, legs);

    // 落在枝上：沿枝条站立，面朝 -X
    this.group.rotation.y = -Math.PI / 2;
    this.setHeadPose(0, 0, 0);

    console.info(
      `[bird] 正羽 ${featherCount} 片；组装耗时 ${(performance.now() - t0).toFixed(0)} ms`,
    );
  }

  setPartVisible(part: BirdPart, visible: boolean): void {
    const p = this.parts[part];
    p.on = visible;
    for (const obj of p.objs) obj.visible = visible;
  }

  /**
   * 头部姿态（弧度）。颈部先转一部分，头部在颈部之上补足其余角度，
   * 两根骨骼线性混合，脖颈处是渐变形变而不是生硬的折弯。
   */
  setHeadPose(yaw: number, pitch: number, roll: number): void {
    const share = 0.45;
    const apply = (pivot: Vector3, x: number, y: number, z: number, out: Matrix4, base?: Matrix4): void => {
      this.quat.setFromEuler(this.euler.set(x, y, z, 'YXZ'));
      this.rot.makeRotationFromQuaternion(this.quat);
      out.identity();
      if (base) out.multiply(base);
      out.multiply(this.shift.makeTranslation(pivot.x, pivot.y, pivot.z));
      out.multiply(this.rot);
      out.multiply(this.shift.makeTranslation(-pivot.x, -pivot.y, -pivot.z));
    };
    apply(this.neckPivot, pitch * share, yaw * share, roll * share, this.mNeck);
    apply(this.headPivot, pitch * (1 - share), yaw * (1 - share), roll * (1 - share), this.mHead, this.mNeck);
    this.fur.setBone(0, this.mNeck);
    this.fur.setBone(1, this.mHead);
    this.headParts.matrix.copy(this.mHead);
    this.headParts.matrixWorldNeedsUpdate = true;
  }

  /**
   * 呼吸膨胀（0..1 吸气量）：呼吸空间绕腹部中心做非等比微缩放（纵向满幅、宽 0.6 倍、长 0.3 倍），
   * 绒毛、喙眼和翅尾一起被顶起，腿不受影响。
   */
  setBreath(amount: number): void {
    this.breathAmount = amount;
    this.updateBodySpace();
  }

  /**
   * 躯干微姿态（弧度）：整副身体绕脚踝抓握点前俯 / 顺扭 / 侧倾，腿不跟着动，双脚始终抓牢树枝。
   * 大角度转头时身体顺着方向慢半拍跟一点，甩尾弹翅时前俯反冲再回稳。
   */
  setBodyPose(pose: BodyPose): void {
    this.bodyEuler.set(pose.pitch, pose.yaw, pose.roll, 'YXZ');
    this.updateBodySpace();
  }

  /** 呼吸缩放 × 躯干微姿态合成到呼吸空间的矩阵上：先绕腹中心膨胀，再绕抓握点转。 */
  private updateBodySpace(): void {
    const s = BREATH_SCALE * clamp(this.breathAmount, 0, 1.5);
    const m = this.breathSpace.matrix;
    m.makeScale(1 + 0.6 * s, 1 + s, 1 + 0.3 * s);
    m.setPosition(BREATH_CENTER.x * -0.6 * s, BREATH_CENTER.y * -s, BREATH_CENTER.z * -0.3 * s);
    this.quat.setFromEuler(this.bodyEuler);
    this.rot.makeRotationFromQuaternion(this.quat);
    this.rot.setPosition(BODY_PIVOT.x, BODY_PIVOT.y, BODY_PIVOT.z);
    this.rot.multiply(this.shift.makeTranslation(-BODY_PIVOT.x, -BODY_PIVOT.y, -BODY_PIVOT.z));
    m.premultiply(this.rot);
    this.breathSpace.matrixWorldNeedsUpdate = true;
  }

  /** 把动作系统叠加好的姿态一次性应用到头颈、眼睑、喙、双翅、尾、呼吸和躯干。 */
  applyPose(pose: Pose): void {
    this.setHeadPose(pose.head.yaw, pose.head.pitch, pose.head.roll);
    this.setBlink({ lidClose: pose.eye.lidClose, squint: pose.eye.squint, nictClose: pose.eye.nict });
    this.setJawOpen(pose.jaw);
    this.setWingPose('left', pose.wing.left);
    this.setWingPose('right', pose.wing.right);
    this.setTailPose(pose.tail);
    this.setBreath(pose.breath);
    this.setBodyPose(pose.body);
  }

  /** 眼睛高度处的头部世界坐标，动作系统换算注视角用。 */
  headWorldPosition(out: Vector3): Vector3 {
    return this.headParts.localToWorld(out.set(0, 3.45, 0.8));
  }

  /** 躯干当前朝向（世界）：头颈姿态是相对躯干定义的，注视角要按这个坐标系反算。 */
  bodyWorldQuaternion(out: Quaternion): Quaternion {
    return this.breathSpace.getWorldQuaternion(out);
  }

  /**
   * 眨眼。眼睑绕眼角横轴转动：下睑上抬约 70%（略微越过中线）、上睑下压约 30%（停在离中线一步处），
   * 合拢后两圈睑缘之间留下一条极细的合缝暗线；squint 只抬下睑，做成弯月眯眼。
   * 瞬膜平时收在前眼角，nictClose 让它从前眼角向后眼角横向扫过眼球表面。
   */
  setBlink(pose: BlinkPose): void {
    const close = clamp(pose.lidClose ?? 0, 0, 1);
    const squint = clamp(pose.squint ?? 0, 0, 1);
    const nict = clamp(pose.nictClose ?? 0, 0, 1);
    const r = this.params.eyeRadius;
    for (const eye of this.eyes) {
      eye.upper.rotation.x = 0.8 * LID_GAP_UPPER * close;
      eye.lower.rotation.x = -(LID_GAP_LOWER + 0.15 * LID_GAP_UPPER) * close - 0.5 * LID_GAP_LOWER * squint;
      eye.nict.visible = nict > 0.001;
      // 前后眼角在 ±0.5r 处：收起时前缘停在前眼角之外，扫过时一直推到后眼角
      eye.nictX.value = lerp(0.62 * r, -0.62 * r, nict);
    }
  }

  /** 张嘴（弧度）：下颌绕嘴根下垂，上颌跟着微微抬起。 */
  setJawOpen(angle: number): void {
    const a = Math.max(0, angle);
    this.jawLower.rotation.x = a;
    this.jawUpper.rotation.x = -0.25 * a;
  }

  /** 翅膀姿态：side 为 'left' / 'right' / 'both'。收拢的翅是刚体，抬落、前后扫、翻转用于弹翅。 */
  setWingPose(side: 'left' | 'right' | 'both', pose: WingPose): void {
    const sides = side === 'both' ? (['left', 'right'] as const) : ([side] as const);
    for (const s of sides) {
      const sign = s === 'right' ? 1 : -1;
      const g = this.wingPivots[s];
      g.rotation.set(pose.twist ?? 0, sign * (pose.sweep ?? 0), sign * (pose.lift ?? 0));
    }
  }

  /** 尾羽姿态：绕尾基的俯仰/偏摆/滚转，以及扇开角。 */
  setTailPose(pose: TailPose): void {
    this.tailPivot.rotation.set(pose.pitch ?? 0, pose.yaw ?? 0, pose.roll ?? 0);
    this.tailSpread.value = pose.spread ?? 0;
  }

  /** 绒毛参数的 uniform，调试面板直接改。 */
  get furUniforms(): Record<string, IUniform> {
    return this.fur.uniforms;
  }

  update(dt: number): void {
    this.fur.decayStrokes(dt);
  }
}
