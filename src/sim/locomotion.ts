/**
 * 蹦跳步态（阶段 3）。雀形目不走步：地面和枝上的移动全是双足蹦跳。纯数学、零 three 依赖，Node 直接跑。
 *
 * 相位：stand（站着）→ crouch（蓄力：躯干下沉）→ push（蹬伸：躯干回弹，结束瞬间离地）→ air（抛体）
 * → settle（落地缓冲：躯干下沉再回弹）→ stand。按住方向键就连着跳。
 * "根"是两脚之间的栖点：站着时贴在表面（记下表面和表面参数），腾空时沿抛体走。落地判定 = 根碰到某个表面，
 * 且法线朝上（minLandingNy）；撞到侧面的不算落脚——顺着面滑开继续掉（撞到树干、枝的侧面会滑到地上）。
 *
 * 四种跳（hopKind）：
 * - forward 前进跳：枝上意图投影到枝轴取符号，落点朝向 = 枝轴方向；地面上朝意图方向转。连跳累积动量（momentum），
 *   速度 / 高度随之加成——扑翼助推快跑；松手后落地动量还大就进 skid（急刹滑雪）。
 * - back 后退小步：意图和朝向相反，不转身、朝后挪 2~3 cm。
 * - side 侧跳挪步：地面上的横向意图，不转身。
 * - turn 原地掉头蹦：枝上横向意图不可行，竖着跳一下在空中转 180°（往哪边转由 intent.turn 定）。
 * 枝是弯的，前进跳的方向不是起跳点的切线，而是瞄准枝上前方一点（按同高滞空估的落点）。落点在离地那一刻就按
 * 同一条抛体预测出来（airDuration / land*），表现层拿去伸爪、转朝向。
 * 斜面（2026-11-23）：雪垄 / 斜屋顶 / 雨棚（0.4 ≤ ny < 0.99）上也能连跳——起跳方向投到斜面里（上坡跳不会一跳就扎进坡里），
 * 急刹时根按面上 (x, z) 处的高度贴着坡走，滑出面的边缘就带着余速掉下去。表现层（Player）落地时按法线斜着铺栖面，脚贴坡不悬空。
 */
import { GRAVITY, Vec3, lerpTo } from './math.ts';
import { clamp, lerp, smoothstep } from '../util/math.ts';
import { makeContact, type Contact, type Surface } from './surface.ts';
import { CurvePerch, makeCurveFrame } from './curvePerch.ts';
import type { SimWorld } from './world.ts';

export interface HopParams {
  /** 蓄力 / 蹬伸时长（秒）。 */
  crouchTime: number;
  pushTime: number;
  /** 前进跳的高度（厘米）：意图轻 → 低，意图满 → 高。 */
  minHeight: number;
  maxHeight: number;
  /** 前进跳的水平速度（厘米 / 秒）：意图轻 → 慢，意图满 → 快。 */
  minSpeed: number;
  maxSpeed: number;
  /** 后退小步的高度 / 速度。 */
  backHeight: number;
  backSpeed: number;
  /** 侧跳挪步的高度 / 速度。 */
  sideHeight: number;
  sideSpeed: number;
  /** 原地掉头蹦的高度 / 微小的漂移速度。 */
  turnHeight: number;
  turnSpeed: number;
  /** 枝上显式跃离（方向 + 空格）：在满幅前进跳之上再加的高度 / 速度倍率。 */
  leapHeight: number;
  leapSpeed: number;
  /** 蹬离弹性栖面（电线 / 细枝）时，起跳的竖直速度有多少拿去激发颤动（落地按落点法向速度全额激发，和落球一样）。 */
  pushExcite: number;
  /** 扑翼助推：动量每跳加多少、站着每秒衰减多少、对速度 / 高度的最大加成。 */
  momentumGain: number;
  momentumDecay: number;
  momentumSpeed: number;
  momentumHeight: number;
  /** 急刹滑雪：触发所需的动量、时长（秒）、满动量的滑距（厘米）。 */
  skidMomentum: number;
  skidTime: number;
  skidDist: number;
  /** 落地缓冲时长（秒）。 */
  settleTime: number;
  /**
   * 地面（雪地 / 汀步 / 屋顶等非曲线面）连跳手感：蓄力 / 蹬伸 / 松手时的缓冲时长、前进跳的水平速度范围、动量对速度 / 高度的加成。
   * 按住方向键连跳时落地缓冲直接接下一跳的蓄力（land 里），周期 = 蓄力 + 蹬伸 + 滞空 ≈ 0.24~0.28 s → 3.6~4.2 跳 / 秒；
   * 细枝 / 电线（CurvePerch）上保持原来的精细小步（枝头一跳 3~9 cm，一跳大了就飞出去）。
   */
  groundCrouchTime: number;
  groundPushTime: number;
  groundSettleTime: number;
  groundMinSpeed: number;
  groundMaxSpeed: number;
  groundMomentumSpeed: number;
  groundMomentumHeight: number;
  /**
   * 地面（雪地 / 汀步 / 屋顶）相机相对操控的后撤跳 / 侧跳：S 不转身直接往后撤、A/D 不转身侧跳（2026-11-23 用户要求，
   * 原来按 S 先 180° 掉头再跳很笨拙）。高 2.4 cm → 滞空 0.14 s，72 cm/s ≈ 10 cm/跳，蓄力 + 蹬伸 + 滞空 ≈ 0.22 s → 4.5 跳/秒。
   */
  groundBackHeight: number;
  groundBackSpeed: number;
  groundSideHeight: number;
  groundSideSpeed: number;
  /** 落地时接触法线的最低朝上分量（撞到侧面的不算落脚）。 */
  minLandingNy: number;
  /** 意图投影到可行方向上的最低幅度，低于它不起跳。 */
  minIntent: number;
  /** 掉出世界的兜底：根低于这个高度（厘米）就瞬移回上一次落点站着（场景有边界，正常到不了这里）。 */
  voidY: number;
}

/** 小型山雀的一跳：前进跳高 2.0~3.6 cm、水平 20~52 cm/s，滞空 0.13~0.17 s、跳 3~9 cm；动量满时再快 60%、高 1.2 cm。
 *  地面连跳：90~125 cm/s（满幅单跳约 21 cm），动量满时 ×1.45、高 +0.8 cm（28~38 cm/跳），蓄力 0.05 + 蹬伸 0.03 + 滞空 0.15~0.19 s。 */
export const HOP: HopParams = {
  crouchTime: 0.09,
  pushTime: 0.05,
  minHeight: 2.0,
  maxHeight: 3.6,
  minSpeed: 20,
  maxSpeed: 52,
  backHeight: 1.6,
  backSpeed: 13,
  sideHeight: 1.7,
  sideSpeed: 16,
  turnHeight: 2.2,
  turnSpeed: 3,
  leapHeight: 0.4,
  leapSpeed: 1.1,
  pushExcite: 0.6,
  momentumGain: 0.25,
  momentumDecay: 0.8,
  momentumSpeed: 0.6,
  momentumHeight: 1.2,
  skidMomentum: 0.6,
  skidTime: 0.28,
  skidDist: 1.6,
  settleTime: 0.16,
  groundCrouchTime: 0.05,
  groundPushTime: 0.03,
  groundSettleTime: 0.1,
  groundMinSpeed: 90,
  groundMaxSpeed: 125,
  groundMomentumSpeed: 0.45,
  groundMomentumHeight: 0.8,
  groundBackHeight: 2.4,
  groundBackSpeed: 72,
  groundSideHeight: 2.4,
  groundSideSpeed: 72,
  minLandingNy: 0.4,
  minIntent: 0.15,
  voidY: -200,
};

/** 抛体推进的最大子步（秒）：980 cm/s² 下每步最多落 0.4 cm，细枝（半径 0.1）也不会穿。 */
const MAX_SUBSTEP = 1 / 240;
/** 落点预测的最长前瞻（秒）。 */
const MAX_AIR = 3;
/** 飞行落定时的切向余速超过它（厘米 / 秒）就交给急刹滑步，否则落地缓冲。 */
const FLIGHT_SKID_V = 60;
/** 急刹滑距 = 余速 × 这个系数（厘米），封顶 12 cm（一只鸟的长度）。 */
const FLIGHT_SKID_K = 0.02;
const FLIGHT_SKID_MAX = 12;

/** 玩家意图：世界水平方向（已按相机换算），模长 0..1；hop = 要跳（方向键按着 = 朝那边连跳；只按空格 = 朝前小跳一下）；
 * leap = 方向键 + 空格一起按（枝上显式跃离：朝意图方向跳出去，不顺枝轴——阶段 4 从枝头起飞的前身）；
 * steer + move = 地面相机相对操控（按键类别，表现层按 W/S/A/D 给）：forward = 转身朝意图方向前进跳（含斜前），
 * back = 不转身沿意图方向后撤跳、side = 不转身侧跳；不设 move 就按意图和朝向的夹角分（旧步态，前向以外都是 1.5~2 cm 的小挪步，压测保留）。 */
export interface Intent {
  x: number;
  z: number;
  hop: boolean;
  leap?: boolean;
  steer?: boolean;
  move?: 'forward' | 'back' | 'side';
}

export type LocoPhase = 'stand' | 'crouch' | 'push' | 'air' | 'settle' | 'skid';
export type HopKind = 'forward' | 'back' | 'side' | 'turn';

/**
 * 抛体走一步：返回 true = 这一步碰到了可以落脚的面（结果写进 out，p 停在入点）。
 * 进入体内后先在"上一步 → 这一步"之间二分求出表面入点，再按入点处的法线判定：滞空末段俯角陡（70°）、
 * 一个子步能落 0.4 cm，细枝顶上"法线朝上"的落区只有 0.15 cm 高，不找回入点会一步跨到枝的远侧被当成撞侧面。
 */
const stepNormal = new Vec3();
const stepPrev = new Vec3();
function ballisticStep(
  p: Vec3,
  v: Vec3,
  h: number,
  world: SimWorld,
  out: Contact,
  minNy: number,
): boolean {
  v.y -= GRAVITY * h;
  stepPrev.copy(p);
  p.addScaled(v, h);
  world.closest(p.x, p.y, p.z, out);
  if (out.surface === null || out.dist > 0) return false;
  // 二分找回入点（8 次：0.4 cm / 256）
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 8; i++) {
    const mid = (lo + hi) * 0.5;
    p.copy(stepPrev).addScaled(v, h * mid);
    world.closest(p.x, p.y, p.z, out);
    if (out.surface !== null && out.dist <= 0) hi = mid;
    else lo = mid;
  }
  p.copy(stepPrev).addScaled(v, h * hi);
  world.closest(p.x, p.y, p.z, out);
  if (out.surface === null) return false;
  if (out.ny >= minNy) {
    p.set(out.px, out.py, out.pz);
    return true;
  }
  // 撞到侧面：推到面上、去掉指向面内的速度分量，继续掉
  stepNormal.set(out.nx, out.ny, out.nz);
  p.addScaled(stepNormal, -out.dist + 1e-4);
  const vn = v.dot(stepNormal);
  if (vn < 0) v.addScaled(stepNormal, -vn);
  return false;
}

const aimPoint = new Vec3();
const aimDir = new Vec3();
/** 枝上某弧长处的水平轴向单位向量（朝弧长增加的方向）。 */
const axisFrame = makeCurveFrame();
function curveAxis(curve: CurvePerch, u: number, out: Vec3): Vec3 {
  const f = curve.frameAt(u, axisFrame);
  out.set(f.tx, 0, f.tz);
  if (out.lengthSq() < 1e-12) out.set(1, 0, 0);
  out.normalize();
  return out;
}

/** 镜头方向和枝轴（都取水平）夹角超过 45°：枝上按 W 不再顺枝，而是朝镜头方向跃离（看哪走哪，和地面 / 屋顶统一；2026-11-23）。 */
export const OFF_AXIS_COS = Math.SQRT1_2;
export function cameraOffAxis(camX: number, camZ: number, tangentX: number, tangentZ: number): boolean {
  const l = Math.hypot(tangentX, tangentZ);
  if (l < 1e-9) return true;
  return Math.abs((camX * tangentX + camZ * tangentZ) / l) < OFF_AXIS_COS;
}

export class Locomotion {
  phase: LocoPhase = 'stand';
  /** 根的位置（两脚之间的栖点，世界坐标）。 */
  readonly pos = new Vec3();
  readonly vel = new Vec3();
  /** 躯干朝向：喙的水平方向（单位向量）与栖面顶面方向（站着 = 表面法线）。 */
  readonly heading = new Vec3(-1, 0, 0);
  readonly up = new Vec3(0, 1, 0);
  /** 站着时脚下的表面和表面参数；腾空时 surface = null。 */
  surface: Surface | null = null;
  u = 0;
  v = 0;
  /** 相位内的时间（秒）。 */
  t = 0;
  /** 这一跳的种类、高度、水平速度。 */
  hopKind: HopKind = 'forward';
  hopHeight = 0;
  hopSpeed = 0;
  /** 动量 0..1：连着前进跳累积，站着衰减；加成速度 / 高度，落地时够大就急刹滑雪。 */
  momentum = 0;
  /** 蓄力 / 缓冲的躯干下沉量 0..1（表现层拿去压低躯干）。 */
  crouch = 0;
  /** 这一跳蓄力的起点下沉量：普通 0；地面连跳落地时方向键还按着 = 0.55（落地缓冲的那一下沉直接接着往蓄力深处走）。 */
  private crouchFrom = 0;
  /** 蹦跳计数。 */
  hops = 0;
  /** 腾空进度 0..1（airTime / airDuration）。 */
  airK = 0;
  /** 落点预测（离地那一刻算出）：hasLanding = 预测到了落脚面。 */
  hasLanding = false;
  readonly landPos = new Vec3();
  readonly landUp = new Vec3(0, 1, 0);
  /** 落地时的朝向与顶面（蓄力 → 腾空之间朝它转）。 */
  readonly targetHeading = new Vec3();
  readonly targetUp = new Vec3(0, 1, 0);
  landSurface: Surface | null = null;
  landU = 0;
  landV = 0;
  /** 落地那一刻的接触（表现层拿去查落点的视觉表面）。 */
  readonly landContact: Contact = makeContact();
  /** 急刹滑雪：这一下的滑距（厘米）和已经滑过的量；进度 0..1。 */
  skidDist = 0;
  skidK = 0;
  /** 本帧事件。 */
  tookOff = false;
  landed = false;
  /** 本帧落地那一刻的法向冲击速度（厘米 / 秒，≥ 0；没落地 = 0）：表现层按它给树枝冲量、震雪粉。 */
  impactSpeed = 0;
  /** 本帧蹬离弹性栖面用的等效蹬速（厘米 / 秒；没起跳 = 0）：表现层给主角枝冲量用同一个数。 */
  pushSpeed = 0;
  /** 本帧掉出世界被送回了上一次落点。 */
  respawned = false;
  /** 上一次落点（世界坐标）：掉出世界的兜底用。 */
  readonly lastLandPos = new Vec3();
  /** 根的 pos.y 里已经含着的弹性栖面位移（落地 / 放上去那一刻的 offsetAt(u)）。 */
  private off0 = 0;

  private readonly params: HopParams;
  private readonly contact: Contact = makeContact();
  private readonly startHeading = new Vec3();
  private readonly startUp = new Vec3();
  /** 这一跳的水平位移方向（后退 / 侧跳时和朝向不同）。 */
  private readonly hopDir = new Vec3();
  /** 转向的累积进度：蓄力 + 蹬伸只转 15%，腾空前 75% 转完。 */
  private turnDone = 0;
  /** 掉头蹦往哪边转：+1 往左（绕 +Y 的正角）、−1 往右（表现层拿去做侧倾）。 */
  turnSign = -1;
  private skidMoved = 0;
  private airTime = 0;
  private airDuration = 1;
  private readonly axis = new Vec3();
  /** 急刹时平面类表面在 (x, z) 处的点（常驻）。 */
  private readonly planePt = new Vec3();

  constructor(params: HopParams = HOP) {
    this.params = params;
  }

  /** 放到某个表面上站着（初始 / 重置）：(x, y, z) 附近最近的表面，喙朝 (headingX, 0, headingZ)。 */
  place(world: SimWorld, x: number, y: number, z: number, headingX: number, headingZ: number): boolean {
    world.closest(x, y, z, this.contact);
    const c = this.contact;
    if (c.surface === null || c.ny < this.params.minLandingNy) return false;
    this.releasePerch();
    this.pos.set(c.px, c.py, c.pz);
    this.lastLandPos.copy(this.pos);
    this.hops = 0;
    this.surface = c.surface;
    this.u = c.u;
    this.v = c.v;
    if (c.surface instanceof CurvePerch) c.surface.load(c.u / c.surface.length, true);
    this.off0 = this.perchOffset();
    this.up.set(c.nx, c.ny, c.nz).normalize();
    this.heading.set(headingX, 0, headingZ).normalize();
    this.snapHeadingToSurface();
    this.targetHeading.copy(this.heading);
    this.targetUp.copy(this.up);
    this.phase = 'stand';
    this.t = 0;
    this.crouch = 0;
    this.crouchFrom = 0;
    this.momentum = 0;
    this.vel.set(0, 0, 0);
    this.hasLanding = false;
    this.landSurface = null;
    return true;
  }

  /** 脚下是地面（雪地 / 汀步 / 屋顶等非曲线面）：连跳走提速手感；细枝 / 电线上保持精细小步。 */
  get onGround(): boolean {
    return this.surface !== null && !(this.surface instanceof CurvePerch);
  }

  /** 当前表面的蓄力 / 蹬伸 / 缓冲时长（秒），表现层按相位进度换算用。 */
  get crouchTime(): number {
    return this.onGround ? this.params.groundCrouchTime : this.params.crouchTime;
  }

  get pushTime(): number {
    return this.onGround ? this.params.groundPushTime : this.params.pushTime;
  }

  get settleTime(): number {
    return this.onGround ? this.params.groundSettleTime : this.params.settleTime;
  }

  /** 枝上朝向必须顺着枝轴（取和当前朝向同侧的那一头）。 */
  private snapHeadingToSurface(): void {
    const s = this.surface;
    if (!(s instanceof CurvePerch)) return;
    curveAxis(s, this.u, this.axis);
    if (this.heading.x * this.axis.x + this.heading.z * this.axis.z < 0) this.axis.scale(-1);
    this.heading.copy(this.axis);
  }

  /** 弹性栖面（电线 / 细枝）在根处的当前竖直位移（厘米）；不是曲线或没有弹簧就是 0。 */
  private perchOffset(): number {
    const s = this.surface;
    return s instanceof CurvePerch ? s.offsetAt(this.u) : 0;
  }

  /** 离开当前栖面（换面 / 腾空 / 掉下去）：悬臂枝的静态下垂解除，枝回弹。 */
  private releasePerch(): void {
    const s = this.surface;
    if (s instanceof CurvePerch) s.load(this.u / s.length, false);
  }

  update(dt: number, intent: Intent, world: SimWorld): void {
    this.tookOff = false;
    this.landed = false;
    this.respawned = false;
    this.impactSpeed = 0;
    this.pushSpeed = 0;
    const p = this.params;
    // 弹性栖面（电线 / 细枝）在晃：站着 / 蓄力 / 蹬伸 / 缓冲时根跟着表面走（落地那一刻的位移记在 off0 里，每帧只加差量）
    if (this.phase !== 'air') {
      const off = this.perchOffset();
      this.pos.y += off - this.off0;
      this.off0 = off;
    }
    switch (this.phase) {
      case 'stand': {
        this.crouch = 0;
        if (this.momentum > 0) this.momentum = Math.max(0, this.momentum - p.momentumDecay * dt);
        if (!intent.hop) break;
        if (!this.planHop(intent)) break;
        this.beginHop();
        break;
      }
      case 'crouch': {
        this.t += dt;
        const k = Math.min(1, this.t / this.crouchTime);
        // 地面连跳从落地缓冲的 0.55 接着往蓄力深处走（弹性衔接），普通一跳从 0 蹲下去
        this.crouch = this.crouchFrom + (1 - this.crouchFrom) * smoothstep(0, 1, k);
        this.turn(k * 0.08);
        if (k >= 1) {
          this.phase = 'push';
          this.t = 0;
        }
        break;
      }
      case 'push': {
        this.t += dt;
        const k = Math.min(1, this.t / this.pushTime);
        this.crouch = 1 - smoothstep(0, 1, k);
        this.turn(0.08 + k * 0.07);
        if (k >= 1) this.takeOff(world);
        break;
      }
      case 'air': {
        let remaining = dt;
        while (remaining > 1e-9) {
          const h = Math.min(remaining, MAX_SUBSTEP);
          remaining -= h;
          this.airTime += h;
          if (ballisticStep(this.pos, this.vel, h, world, this.contact, p.minLandingNy)) {
            this.land(intent);
            break;
          }
          // 掉出世界（高度场边缘之外）：回上一次落点
          if (this.pos.y < p.voidY) {
            this.respawned = true;
            this.place(world, this.lastLandPos.x, this.lastLandPos.y + 0.5, this.lastLandPos.z, this.heading.x, this.heading.z);
            break;
          }
        }
        // 落地了（缓冲 / 急刹 / 地面连跳直接进蓄力）：腾空剩下的转向不再做——连跳的 beginHop 已把转向进度归零，再做会一步转满
        if (this.phase !== 'air') break;
        this.airK = clamp(this.airTime / this.airDuration, 0, 1);
        // 剩下的转向在腾空前 75% 完成（原地掉头蹦：起跳时还朝着原方向，空中转过去）
        this.turn(0.15 + 0.85 * smoothstep(0, 0.75, this.airK));
        break;
      }
      case 'settle': {
        this.t += dt;
        const k = Math.min(1, this.t / this.settleTime);
        // 落地缓冲：先沉到 0.55 再回弹到 0
        this.crouch = 0.55 * (1 - smoothstep(0, 1, k));
        if (k >= 1) {
          this.phase = 'stand';
          this.t = 0;
          this.crouch = 0;
        }
        break;
      }
      case 'skid': {
        // 急刹滑雪：脚钉着雪、躯干前倾，沿朝向滑一段（先快后停），然后站定、动量清零；滑的过程中根贴着面走
        this.t += dt;
        const k = Math.min(1, this.t / p.skidTime);
        const moved = this.skidDist * (1 - (1 - k) * (1 - k));
        this.pos.addScaled(this.heading, moved - this.skidMoved);
        this.skidMoved = moved;
        this.skidK = k;
        this.crouch = 0.55 * (1 - smoothstep(0, 1, k));
        // 滑的过程中根贴着面走。平面类（雪地 / 盒顶）：按 (x, z) 取面上这一点的高度——斜坡上最近点会顺着坡往旁边偏，不能整个照搬，
        // 第一版只在 |dist| < 1 时才贴 y，雪垄 / 斜屋顶上滑出去一步就悬空（2026-11-23）；细枝 / 电线：只取最近表面点的高度
        world.closest(this.pos.x, this.pos.y, this.pos.z, this.contact);
        const c = this.contact;
        const s = this.surface;
        if (s === null || c.surface !== s || c.ny < p.minLandingNy) {
          // 滑出了面的边缘（屋顶 / 雪板 / 枝梢）：带着剩下的滑速掉下去
          this.fallOff(world, (this.skidDist * 2 * (1 - k)) / p.skidTime);
          break;
        }
        if (s.kind !== 0) {
          s.pointAt(this.pos.x, this.pos.z, 0, this.planePt);
          // 取到的点得还在这个面上：雪板 / 盒顶范围外 pointAt 钳到边缘，离根有一段水平距离 = 已经滑出去了
          world.closest(this.pos.x, this.planePt.y, this.pos.z, this.contact);
          if (this.contact.surface !== s || Math.abs(this.contact.dist) > 0.5) {
            this.fallOff(world, (this.skidDist * 2 * (1 - k)) / p.skidTime);
            break;
          }
          this.pos.y = this.planePt.y;
          this.u = this.pos.x;
          this.v = this.pos.z;
        } else if (Math.abs(c.dist) < 1) {
          this.pos.y = c.py;
          this.u = c.u;
          this.v = c.v;
        }
        this.lastLandPos.copy(this.pos);
        if (k >= 1) {
          this.phase = 'stand';
          this.t = 0;
          this.crouch = 0;
          this.momentum = 0;
          this.skidK = 0;
        }
        break;
      }
    }
  }

  /** 急刹滑出了面的边缘（屋顶 / 雪板 / 枝梢）：带着剩下的滑速掉下去——腾空 → 抛体 → 落到下面的面上（或掉出世界兜底）。 */
  private fallOff(world: SimWorld, speed: number): void {
    this.releasePerch();
    this.surface = null;
    this.phase = 'air';
    this.t = 0;
    this.airTime = 0;
    this.airK = 0;
    this.crouch = 0;
    this.crouchFrom = 0;
    this.skidK = 0;
    this.vel.set(this.heading.x * speed, 0, this.heading.z * speed);
    this.predictLanding(world);
  }

  /**
   * 决定这一跳：种类、位移方向、落地朝向、高度、速度。返回 false = 这一下不跳（意图太小或方向不可行）。
   */
  private planHop(intent: Intent): boolean {
    const p = this.params;
    const s = this.surface;
    this.hopKind = 'forward';
    if (s instanceof CurvePerch) {
      curveAxis(s, this.u, this.axis);
      const along = intent.x * this.axis.x + intent.z * this.axis.z;
      // 意图在鸟身侧向的分量（right = heading × up）：往哪一侧 dominates 就往哪边掉头
      const lateral = intent.x * -this.heading.z + intent.z * this.heading.x;
      if (Math.hypot(intent.x, intent.z) < p.minIntent) {
        // 只按空格：朝前小跳一下（到枝尖就是跳下去）
        if (!intent.hop) return false;
        const facing = this.heading.x * this.axis.x + this.heading.z * this.axis.z;
        this.planForward(Math.max(0.3, Math.abs(along)), facing >= 0 ? 1 : -1, s);
        return true;
      }
      if (intent.leap) {
        // 方向键 + 空格：显式跃离——朝意图方向跳出去，不管枝轴朝哪（跳去旁边的分叉枝、主动跳下树枝、以后从枝头起飞），
        // 落地朝向 = 跃出的方向；比满幅前进跳再高一点、快一点
        const len = Math.hypot(intent.x, intent.z);
        const mag = Math.min(1, len);
        this.hopDir.set(intent.x / len, 0, intent.z / len);
        this.targetHeading.copy(this.hopDir);
        this.hopHeight = lerp(p.minHeight, p.maxHeight, mag) + p.leapHeight + p.momentumHeight * this.momentum;
        this.hopSpeed = lerp(p.minSpeed, p.maxSpeed, mag) * p.leapSpeed * (1 + p.momentumSpeed * this.momentum);
        return true;
      }
      if (Math.abs(lateral) > Math.abs(along)) {
        // 枝上横向挪不动：原地掉头蹦。th > 0 是往左转（绕 +Y），所以往右掉头要取负
        this.hopKind = 'turn';
        this.turnSign = lateral > 0 ? -1 : 1;
        this.hopDir.copy(this.heading);
        this.targetHeading.copy(this.heading).scale(-1);
        this.hopHeight = p.turnHeight;
        this.hopSpeed = p.turnSpeed;
        return true;
      }
      const sign = along < 0 ? -1 : 1;
      // 和朝向同侧 → 前进跳（瞄准枝上前方一点）；反侧 → 后退小步（不转身）
      const facing = this.heading.x * this.axis.x + this.heading.z * this.axis.z;
      const forward = sign * facing >= 0;
      this.hopKind = forward ? 'forward' : 'back';
      if (forward) {
        this.planForward(Math.min(1, Math.abs(along)), sign, s);
        return true;
      }
      this.hopDir.copy(this.axis).scale(sign);
      this.targetHeading.copy(this.heading);
      this.hopHeight = p.backHeight;
      this.hopSpeed = p.backSpeed;
      return true;
    }
    // 地面：任意方向；和朝向的夹角决定前进 / 后退 / 侧跳。方向键的前进跳用地面连跳的速度段（90~135 cm/s，动量满再 ×1.45），只按空格仍是小跳
    let len = Math.hypot(intent.x, intent.z);
    if (len < p.minIntent) {
      // 只按空格：朝前小跳一下
      if (!intent.hop) return false;
      this.hopKind = 'forward';
      this.hopDir.copy(this.heading);
      this.targetHeading.copy(this.heading);
      this.hopHeight = lerp(p.minHeight, p.maxHeight, 0.3) + p.momentumHeight * this.momentum;
      this.hopSpeed = lerp(p.minSpeed, p.maxSpeed, 0.3) * (1 + p.momentumSpeed * this.momentum);
      return true;
    }
    const dx = intent.x / len;
    const dz = intent.z / len;
    const cos = dx * this.heading.x + dz * this.heading.z;
    this.hopDir.set(dx, 0, dz);
    // 按键类别优先（相机相对操控：W 永远是转身前进跳，哪怕镜头在鸟的侧面 / 背后）；没给就按夹角分
    const move = intent.move ?? (cos > 0.35 ? 'forward' : cos < -0.35 ? 'back' : 'side');
    if (move === 'forward') {
      // 前向（含斜前，和朝向夹角 ≤ 70°）：转身跳过去，掉头越多步子越小（70° 时 71%）
      const boost = 1 + p.groundMomentumSpeed * this.momentum;
      this.hopKind = 'forward';
      this.targetHeading.copy(this.hopDir);
      const mag = intent.steer ? Math.min(1, len) * (0.55 + 0.45 * Math.max(0, cos)) : Math.min(1, len);
      this.turnSign = 1;
      this.hopHeight = lerp(p.minHeight, p.maxHeight, mag) + p.groundMomentumHeight * this.momentum;
      this.hopSpeed = lerp(p.groundMinSpeed, p.groundMaxSpeed, mag) * boost;
    } else {
      // 后撤 / 侧跳：不转身，沿意图方向挪一步——相机相对操控下 S 是背对镜头方向直接后撤、A/D 侧跳。
      // steer 在地面上用后撤跳 / 侧跳的速度段（≈ 10 cm/跳、按住能连跳）；旧步态仍是 1.5~2 cm 的小挪步
      this.hopKind = move;
      this.targetHeading.copy(this.heading);
      const back = move === 'back';
      const g = intent.steer === true && this.onGround;
      this.hopHeight = back ? (g ? p.groundBackHeight : p.backHeight) : g ? p.groundSideHeight : p.sideHeight;
      this.hopSpeed = back ? (g ? p.groundBackSpeed : p.backSpeed) : g ? p.groundSideSpeed : p.sideSpeed;
    }
    return true;
  }

  /** 进入蓄力（planHop 已经定好这一跳）：记下起跳时的朝向 / 顶面，转向进度归零。 */
  private beginHop(): void {
    this.startHeading.copy(this.heading);
    this.startUp.copy(this.up);
    this.turnDone = 0;
    this.phase = 'crouch';
    this.t = 0;
  }

  /** 枝上的前进跳：沿枝轴 sign 那一头，瞄准按同高滞空估出来的枝上前方一点（枝是弯的，切线不等于位移方向）。 */
  private planForward(mag: number, sign: 1 | -1, s: CurvePerch): void {
    const p = this.params;
    const boost = 1 + p.momentumSpeed * this.momentum;
    const height = lerp(p.minHeight, p.maxHeight, mag) + p.momentumHeight * this.momentum;
    const speed = lerp(p.minSpeed, p.maxSpeed, mag) * boost;
    const look = Math.min(s.length, Math.max(0, this.u + sign * speed * 2 * Math.sqrt(2 * height / GRAVITY)));
    s.pointAt(look, 0, 0, aimPoint);
    this.hopDir.set(aimPoint.x - this.pos.x, 0, aimPoint.z - this.pos.z);
    if (this.hopDir.lengthSq() < 1e-12) this.hopDir.copy(curveAxis(s, this.u, aimDir));
    this.hopDir.normalize();
    this.targetHeading.copy(this.hopDir);
    this.hopHeight = height;
    this.hopSpeed = speed;
  }

  private takeOff(world: SimWorld): void {
    this.tookOff = true;
    this.hops++;
    // 蹬离弹性栖面：腿把它往下蹬（和落球砸上去同向），电线 / 细枝跟着颤；悬臂枝的静态下垂同时解除（枝从下沉回弹）
    const from = this.surface;
    this.pushSpeed = Math.sqrt(2 * GRAVITY * this.hopHeight) * this.params.pushExcite;
    if (from instanceof CurvePerch) {
      from.excite(this.u / from.length, this.pushSpeed, 1);
      from.load(this.u / from.length, false);
    }
    if (this.hopKind === 'forward') this.momentum = Math.min(1, this.momentum + this.params.momentumGain);
    // 斜面（雪垄 / 斜屋顶 / 雨棚，0.4 ≤ ny < 0.99）上：起跳方向投到斜面里，水平速度分量顺着坡抬起来——
    // 不投的话上坡一跳就扎进坡里（抛物线升得比坡慢），落地立刻被吸收，上不去坡。
    // 枝上不投：枝是斜的圆柱，根落在它的侧面上时法线往一边歪，按法线起跳会横着漂出枝外（第一版这样，第三跳就掉下枝梢）
    const up = this.up;
    const vy = Math.sqrt(2 * GRAVITY * this.hopHeight);
    if (from !== null && from.kind !== 0 && up.y < 0.995) {
      const dn = this.hopDir.x * up.x + this.hopDir.z * up.z;
      this.hopDir.set(this.hopDir.x - up.x * dn, -up.y * dn, this.hopDir.z - up.z * dn).normalize();
      this.vel.set(
        this.hopDir.x * this.hopSpeed + up.x * vy,
        this.hopDir.y * this.hopSpeed + up.y * vy,
        this.hopDir.z * this.hopSpeed + up.z * vy,
      );
    } else {
      this.vel.set(this.hopDir.x * this.hopSpeed, vy, this.hopDir.z * this.hopSpeed);
    }
    this.surface = null;
    this.phase = 'air';
    this.t = 0;
    this.airTime = 0;
    this.crouch = 0;
    this.crouchFrom = 0;
    this.predictLanding(world);
  }

  /** 离地那一刻按同一条抛体预测落点（不改真实的 pos / vel）。 */
  private predictLanding(world: SimWorld): void {
    const p = this.params;
    this.hasLanding = false;
    this.landSurface = null;
    this.landUp.copy(this.up);
    const pp = this.pos.clone();
    const vv = this.vel.clone();
    let time = 0;
    while (time < MAX_AIR) {
      time += MAX_SUBSTEP;
      if (ballisticStep(pp, vv, MAX_SUBSTEP, world, this.contact, p.minLandingNy)) {
        this.hasLanding = true;
        this.landPos.copy(pp);
        this.landUp.set(this.contact.nx, this.contact.ny, this.contact.nz).normalize();
        this.landSurface = this.contact.surface;
        this.landU = this.contact.u;
        this.landV = this.contact.v;
        break;
      }
    }
    this.airDuration = Math.max(time, 0.05);
    this.airK = 0;
  }

  private land(intent: Intent): void {
    const c = this.contact;
    const p = this.params;
    this.landed = true;
    const impact = Math.abs(this.vel.y);
    this.impactSpeed = impact;
    this.lastLandPos.copy(this.pos);
    this.surface = c.surface;
    this.u = c.u;
    this.v = c.v;
    this.off0 = this.perchOffset();
    // 落到弹性栖面：按落点的法向速度激发颤动（从上方砸下电线先往下走，从下方顶到先往上走，和落球一致）；
    // 悬臂枝再进入"被鸟压着"的静态下垂（越靠梢端垂得越多），离枝时回弹
    if (this.surface instanceof CurvePerch) {
      this.surface.excite(this.u / this.surface.length, impact, c.ny);
      this.surface.load(this.u / this.surface.length, true);
    }
    this.up.set(c.nx, c.ny, c.nz).normalize();
    this.vel.set(0, 0, 0);
    this.heading.copy(this.targetHeading);
    this.snapHeadingToSurface();
    this.targetHeading.copy(this.heading);
    this.targetUp.copy(this.up);
    this.landContact.surface = c.surface;
    this.landContact.px = c.px;
    this.landContact.py = c.py;
    this.landContact.pz = c.pz;
    this.landContact.nx = c.nx;
    this.landContact.ny = c.ny;
    this.landContact.nz = c.nz;
    this.landContact.u = c.u;
    this.landContact.v = c.v;
    this.airK = 1;
    this.t = 0;
    // 松手时动量还大（刚才是前进跳、现在没有方向的意图）→ 急刹滑雪（只在雪地 / 盒顶上，枝上不打滑）；否则普通缓冲
    const released = Math.hypot(intent.x, intent.z) < p.minIntent;
    const ground = this.surface !== null && this.surface.kind !== 0;
    if (this.hopKind === 'forward' && released && ground && this.momentum >= p.skidMomentum) {
      this.phase = 'skid';
      this.skidDist = p.skidDist * this.momentum;
      this.skidMoved = 0;
      this.skidK = 0;
      return;
    }
    // 地面连跳：落地时方向键还按着 → 落地缓冲直接接下一跳的蓄力（下沉量从缓冲的 0.55 接着往蓄力深处走），
    // 不等缓冲结束再站一下；周期 = 蓄力 + 蹬伸 + 滞空 ≈ 0.25 s。枝上不连（枝头一跳大了就飞出去，保持原来的缓冲）
    if (ground && !released && this.planHop(intent)) {
      this.crouchFrom = 0.55;
      this.crouch = 0.55;
      this.beginHop();
      return;
    }
    this.phase = 'settle';
  }

  /**
   * 飞行落定后交回步态（place 之后调）：切向余速超过 FLIGHT_SKID_V 就顺着朝向滑一段急刹（滑距 ∝ 余速，封顶 12 cm），
   * 否则落地缓冲。表现层随后在 0.1 s 内把翅膀收拢。
   */
  landFromFlight(speed: number): void {
    this.t = 0;
    this.crouch = 0.55;
    this.momentum = 0;
    this.hasLanding = false;
    this.landSurface = null;
    this.airK = 1;
    if (speed > FLIGHT_SKID_V) {
      this.phase = 'skid';
      this.skidDist = clamp(speed * FLIGHT_SKID_K, 1.5, FLIGHT_SKID_MAX);
      this.skidMoved = 0;
      this.skidK = 0;
    } else {
      this.phase = 'settle';
    }
  }

  /** 朝目标转到一个总进度 k（0..1，单调）：水平朝向绕竖轴按最短方向转，顶面线性插值；正好 180° 时按 turnSign。 */
  private turn(k: number): void {
    if (k <= this.turnDone) return;
    this.turnDone = k;
    const a = this.startHeading;
    const b = this.targetHeading;
    const dot = clamp(a.x * b.x + a.z * b.z, -1, 1);
    const crossY = a.x * b.z - a.z * b.x;
    // a = (-1,0,0) 转到 b = (0,0,1) 时 crossY = -1、绕 +Y 转 +90° 正好到 b；所以 crossY < 0 取正角
    const th = (Math.abs(crossY) > 1e-6 ? (crossY < 0 ? 1 : -1) : this.turnSign) * Math.acos(dot) * k;
    const c = Math.cos(th);
    const s = Math.sin(th);
    this.heading.set(a.x * c + a.z * s, 0, -a.x * s + a.z * c).normalize();
    lerpTo(this.startUp, this.targetUp, smoothstep(0, 1, k), this.up);
    if (this.up.lengthSq() < 1e-12) this.up.set(0, 1, 0);
    this.up.normalize();
  }
}
