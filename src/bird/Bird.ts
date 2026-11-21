import {
  BufferGeometry,
  Group,
  Matrix4,
  Mesh,
  Quaternion,
  Vector3,
  Euler,
  type IUniform,
} from 'three';
import type { LightingUniforms } from '../glsl/lit';
import { LONG_TAILED_TIT, type BodyParams } from './bodySdf';
import { buildBody } from './body';
import { Fur } from './fur';
import { makeFeatherMaterial } from './feathers';
import { buildWingAndTail } from './wingTail';
import {
  buildBeak,
  buildEyes,
  buildLegs,
  makeBeakMaterial,
  makeEyeMaterial,
  makeLegMaterial,
  makeRingMaterial,
  type Perch,
} from './parts';

export type BirdPart = 'fur' | 'feathers' | 'beak' | 'eyes' | 'legs';

/**
 * 北长尾山雀：躯体（隐式曲面 + 绒毛）+ 翅尾正羽 + 喙眼腿脚。
 * 所有部件都在鸟的局部坐标里生成，整体再摆到栖枝上。
 */
export class Bird {
  readonly group = new Group();
  readonly fur: Fur;
  readonly feathers: Mesh<BufferGeometry, ReturnType<typeof makeFeatherMaterial>>;
  readonly bodyGeometry: BufferGeometry;
  readonly params: BodyParams;

  private readonly parts: Record<BirdPart, { obj: Group | Mesh; on: boolean }>;
  // 喙和眼是刚体，整组跟着头部骨骼的矩阵走
  private readonly headParts = new Group();
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

    const wingTail = buildWingAndTail(params);
    this.feathers = new Mesh(wingTail.geometry, makeFeatherMaterial(lighting));
    this.feathers.castShadow = true;
    this.feathers.receiveShadow = true;

    const beak = new Mesh(buildBeak(params), makeBeakMaterial(lighting));
    beak.castShadow = true;
    beak.receiveShadow = true;

    const eyes = buildEyes(params);
    const eyeMesh = new Mesh(eyes.eyes, makeEyeMaterial(lighting, eyes.radius));
    eyeMesh.castShadow = true;
    eyeMesh.receiveShadow = true;
    const ringMesh = new Mesh(eyes.rings, makeRingMaterial(lighting));
    ringMesh.receiveShadow = true;
    const eyeGroup = new Group();
    eyeGroup.add(eyeMesh, ringMesh);
    this.headParts.add(beak, eyeGroup);
    this.headParts.matrixAutoUpdate = false;

    const legs = new Mesh(buildLegs(perch), makeLegMaterial(lighting));
    legs.castShadow = true;
    legs.receiveShadow = true;

    this.parts = {
      fur: { obj: this.fur.group, on: true },
      feathers: { obj: this.feathers, on: true },
      beak: { obj: beak, on: true },
      eyes: { obj: eyeGroup, on: true },
      legs: { obj: legs, on: true },
    };
    this.group.add(this.headParts);
    for (const part of Object.values(this.parts)) {
      if (part.obj !== beak && part.obj !== eyeGroup) this.group.add(part.obj);
    }

    // 落在枝上：沿枝条站立，面朝 -X
    this.group.rotation.y = -Math.PI / 2;
    this.setHeadPose(0, 0, 0);

    console.info(
      `[bird] 正羽 ${wingTail.count} 片；组装耗时 ${(performance.now() - t0).toFixed(0)} ms`,
    );
  }

  setPartVisible(part: BirdPart, visible: boolean): void {
    const p = this.parts[part];
    p.on = visible;
    p.obj.visible = visible;
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

  /** 绒毛参数的 uniform，调试面板直接改。 */
  get furUniforms(): Record<string, IUniform> {
    return this.fur.uniforms;
  }

  update(dt: number): void {
    this.fur.decayStrokes(dt);
  }
}
