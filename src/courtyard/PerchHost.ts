/**
 * 观鸟态的栖枝宿主（蹦跳层 HopHost 驱动的外部世界）：鸟根跟着枝条的弯曲位移走、落地按新落点重绑横站的两脚、
 * 树枝冲击 / 蹲伏预压 / 震落雪粉、踩雪印。逻辑和数值从观鸟入口 core/App.ts 原样搬过来（那边由入口自己实现 HopHost），
 * 庭院里操控关着（观鸟态）时用它；操控开着后鸟交给 BirdController / Player，这个宿主只在"回到栖枝"时重绑一次。
 */
import { Matrix4, Quaternion, Vector2, Vector3 } from 'three';
import type { Bird } from '../bird/Bird';
import type { FootState } from '../bird/legs';
import type { HopLayer } from '../bird/motion/hopLayer';
import type { HopHost } from '../bird/motion/hopLayer';
import type { Foot, ToeSurface } from '../bird/parts';
import type { Branches, SnowPress } from '../world/Branch';
import type { SnowPuff } from '../world/snowPuff';

const UP = new Vector3(0, 1, 0);
/** 横站的两个落点：沿枝左右分开（厘米，枝条坐标系里主枝的 +X 方向）、都在枝顶；积雪在这里被踩出小凹。 */
export const CROSS_ALONG = 0.34;

export class PerchHost implements HopHost {
  /** 允许蹦跳的落点范围（枝条坐标 x）：再远就出了苔藓减薄的抓握区、往右会一头撞进前景的海棠果枝（枝根在 x ≈ 2.65）。 */
  readonly range: readonly [number, number] = [-3.0, 2.0];
  private perchX = 0;
  private facing: number;
  /** 正在抓枝的两只脚里 legs[0]（局部 +x 侧）落在枝条坐标的哪一侧（±1），由 standAcross 按朝向定。 */
  private footSign = 1;
  private readonly swayOff = new Vector2();
  private readonly rootPos = new Vector3();
  private readonly swayVec = new Vector3();
  private readonly ankleLift = new Vector3();
  private readonly puffPos = new Vector3();
  private readonly footState: FootState = { grip: 1, ankle: null };
  // 绑脚用的临时量（落地 / 重绑时才用，不在每帧路径上）
  private readonly inv = new Matrix4();
  private readonly rot = new Quaternion();
  private readonly rotInv = new Quaternion();
  private readonly scale = new Vector3();
  private readonly pos = new Vector3();
  private readonly fwd = new Vector3();
  private readonly hop: HopLayer;

  constructor(
    private readonly bird: Bird,
    private readonly branches: Branches,
    private readonly puff: SnowPuff,
    hop: HopLayer,
    facing: number,
  ) {
    this.hop = hop;
    this.facing = facing;
    this.bindFeet(0, facing);
  }

  get birdX(): number {
    return this.perchX;
  }

  get heading(): number {
    return this.facing;
  }

  /**
   * 横站：两脚沿枝左右分开站在枝顶，脚掌朝前（Foot.heading），三根前趾包住枝的前侧、后趾扣住后侧——正面看两只小爪子
   * 左右分开稳稳抱住枝条。栖面按枝条当前的世界标架换到鸟的局部坐标，再交给腿架重绑（重算踝、跗跖长和包握的脚趾）。
   * x 是落点（枝条坐标）：默认 0，蹦跳落地后是新落点。
   */
  standAcross(x: number): void {
    const g = this.bird.group;
    g.updateMatrix();
    const inv = this.inv.copy(g.matrix).invert();
    g.matrix.decompose(this.pos, this.rot, this.scale);
    const rotInv = this.rotInv.copy(this.rot).invert();
    const perch = this.branches.perchAt(x);
    const surface: ToeSurface = {
      center: perch.center.clone().applyMatrix4(inv),
      tangent: perch.tangent.clone().applyQuaternion(rotInv),
      up: perch.up.clone().applyQuaternion(rotInv),
      side: perch.side.clone().applyQuaternion(rotInv),
      surfaceRadius: perch.surfaceRadius,
    };
    // 脚掌朝向 = 鸟的前方（局部 +Z，喙的方向）在栖枝切平面里相对 −切线 的角度
    const fwd = this.fwd.set(0, 0, 1).applyQuaternion(this.rot);
    const heading = Math.atan2(fwd.dot(perch.side), -fwd.dot(perch.tangent));
    // 左右落点按鸟的局部 +X 轴在栖枝切线上的投影定：正站时局部 +x 顺着切线，转身 180° 后逆着切线——
    // 写死 ±CROSS_ALONG 会让两条腿交叉去抓对面的落点（X 形）。legs[0] = 局部 +x 侧的髋，始终抓 +sgn 那一边
    const sgn = surface.tangent.x >= 0 ? 1 : -1;
    this.footSign = sgn;
    const feet: [Foot, Foot] = [
      { alpha: 0.03, along: sgn * CROSS_ALONG, side: 1, heading },
      { alpha: -0.02, along: -sgn * CROSS_ALONG, side: -1, heading },
    ];
    this.bird.legRig.bind(surface, feet);
  }

  /** 两只脚的踩雪印落点（枝条坐标 x），跟着 standAcross 定下的左右走。 */
  private pressSpots(x: number): SnowPress[] {
    const s = this.footSign;
    return [
      { worldX: x + s * CROSS_ALONG, alpha: 0.03 },
      { worldX: x - s * CROSS_ALONG, alpha: -0.02 },
    ];
  }

  placeRoot(x: number, heading: number, lift: number): void {
    this.perchX = x;
    this.facing = heading;
    const g = this.bird.group;
    g.rotation.y = heading;
    // 根的位置 = 枝上 x 处相对默认落点的位移（枝条本身有起伏）+ 枝条在脚处的弯曲位移（枝条坐标系的 y/z 换到世界）
    this.rootPos.copy(this.branches.perchAt(x).center).sub(this.branches.perchAt(0).center);
    const o = this.branches.swayOffsetAtBird(this.swayOff);
    this.rootPos.add(this.swayVec.set(0, o.x, o.y).applyAxisAngle(UP, this.branches.rotation.y));
    g.position.copy(this.rootPos);
    g.position.y += lift;
  }

  bindFeet(x: number, heading: number): void {
    this.branches.setBird(x, true);
    this.placeRoot(x, heading, 0);
    this.standAcross(x);
    this.branches.setPress(this.pressSpots(x));
  }

  takeOff(): void {
    this.branches.setBird(this.perchX, false);
    this.branches.preload(0);
  }

  impact(strength: number, puff: number): void {
    this.branches.impulse(strength);
    // 雪粉从两只脚之间、枝顶略偏下的位置震落（枝顶正中被肚子挡着）
    const perch = this.branches.perchAt(this.perchX);
    this.puffPos.copy(perch.center).addScaledVector(perch.up, perch.surfaceRadius(0, 0) - 0.08);
    this.puff.burst(this.puffPos, puff, 8 + 5 * strength);
  }

  preload(sag: number): void {
    this.branches.preload(sag);
  }

  /** 蹦跳层这一帧的输出：鸟根（含跟随枝条弯曲）、蹲伏 / 前俯、两只脚（抓握度 + 抬起量）。 */
  applyHop(): void {
    const hop = this.hop;
    this.placeRoot(hop.rootX, hop.rootHeading, hop.rootLift);
    this.bird.setHopPose(hop.crouch, hop.pitch, hop.roll);
    for (const i of [0, 1] as const) {
      const f = hop.feet[i];
      if (f.lift > 1e-4) {
        // 抬起的脚：踝相对静止位置微微上收、往前甩一点，脚趾半握成微弯钩
        this.bird.legRig.ankleRest(i, this.ankleLift);
        this.ankleLift.y += f.lift;
        this.ankleLift.z += f.lift * 1.4;
        this.footState.ankle = this.ankleLift;
      } else this.footState.ankle = null;
      this.footState.grip = f.grip;
      this.bird.setFootPose(i === 0 ? 'right' : 'left', this.footState);
    }
  }
}
