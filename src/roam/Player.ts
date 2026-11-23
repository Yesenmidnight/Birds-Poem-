/**
 * 第三人称操控（阶段 3 蹦跳 + 阶段 4 飞行）。键盘 → 相对鸟身的意图 → Locomotion（纯数学步态）→ 摆放鸟群、驱动腿架和脚。
 * 相机（RoamApp）在按键 / 转身 / 飞行时自动绕到鸟背后，不需要拖鼠标转视角来定方向；鼠标只在站着不动时临时拖开看。
 *
 * 鸟群原点 = 步态的"根"（两脚之间的栖点），局部 +Z = 喙的方向、+Y = 世界竖直（鸟不随枝的坡度歪，脚位沿枝的真实切线排）。
 * 落地那一刻按落点的视觉栖面重算栖面标架、把脚重新绑上去：主角枝走舞台的 perchAt、树的子枝走 limbPerch（Stage 接口，控制器不认识具体舞台）
 * （树皮鼓包 + 雪帽 + 脚下的雪坑，脚爪贴的是画面上那个面）；雪地 / 盒顶是平面（半径 50 的圆柱近似，脚趾摊开）；
 * 电线等其他枝条用碰撞体的光滑圆柱。电线 / 细枝会颤：落地、蹬离激发它，站着时鸟跟着线的位移走。
 * 脚：站着 / 蓄力 / 蹬伸 / 缓冲 / 滑雪 → 钉在栖面上（枝上包握、雪地摊开）；腾空 → 收到腹下，临落地前伸向落点、脚趾合拢。
 * 躯干：蓄力 / 缓冲按步态给的 crouch 下沉，起跳微仰、落地微俯，掉头蹦往转向那边压肩；连跳攒了动量时蹬伸那一下双翅一抖
 * （扑翼助推）；急刹滑雪前倾 + 尾羽扇开压低。翅 / 尾都是在动作系统（MotionController）这一帧的 Pose 上叠加，不是覆盖。
 * 跳视先导：一决定起跳，头先转向要去的地方（掉头蹦往转向那边转头，其余朝目标方向略低头看落点）。
 * 飞行（阶段 4，2026-11-23 第二版）：进了飞行态默认自动巡航扑翼（单靠鼠标镜头就能巡航转向）；W / 空格 = 拉杆爬升、C / 鼠标右键 = 收力滑翔
 * （靠近可落的面就自动进着陆 Flare，≤ 0.6 s 滑到刹停点；平面触地即落，切向余速交给步态急刹 / 缓冲）、
 * S = 展翅展尾空中急刹；A/D 压坡转弯；Shift = 冲刺（巡航 390 → 700、扑翼 14 → 18 Hz，冲刺中不做着陆探测，镜头叠 +5° FOV）。
 * 着陆探测不用死按滑翔：巡航 / 刹车靠近屋顶 / 电线 / 树枝 / 路灯 / 长椅都自动抓落点（按住 W / 空格爬升越过时不抓）。落地后双翅在 FOLD_TIME 内柔和收拢。
 * 地面相机相对操控（Stage 外的相机控制器每帧写 camDirX/Z）：W / 斜前 = 转身朝镜头方向跳，S = 不转身直接后撤跳（背对镜头方向），
 * A/D = 不转身侧跳；纯第一人称站着时身体跟转镜头方向（faceYaw）；枝上镜头偏离枝轴超过 45° 时按 W = 朝镜头方向跃离（看哪走哪）。
 * 机体姿态 = 偏航 → 俯仰 → 滚转摆在鸟群上；扑翼角跟 Flight 的扑翼相位，收翼时翅膀合上，刹车 / 着陆时展翅展尾前兜、伸腿。
 * 落定后交回 Locomotion（place 到落点、重新绑脚）。
 * 每帧不分配：意图、脚状态、翅尾姿态、IK 草稿向量都是常驻对象。
 */
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import type { Bird, TailPose, WingPose } from '../bird/Bird';
import type { FootState } from '../bird/legs';
import type { MotionController } from '../bird/motion/MotionController';
import type { Pose } from '../bird/motion/Pose';
import { FOOT_SPOTS, type Foot, type Perch } from '../bird/parts';
import { smoothstep } from '../util/math';
import { Locomotion, cameraOffAxis, type Intent } from '../sim/locomotion';
import { Flight, type FlightIntent } from '../sim/flight';
import { Autopilot } from '../sim/autopilot';
import { CurvePerch, makeCurveFrame } from '../sim/curvePerch';
import type { Surface } from '../sim/surface';
import { Vec3 } from '../sim/math';
import type { Stage } from './stage';

/** 两脚在平地上的横向半距（厘米）= 主枝落点处半径 × sin(FOOT_SPOTS 的 alpha)。 */
const FOOT_LATERAL = 0.108;
/** 平地栖面的圆柱半径：这么大差不多就是一个平面。 */
const FLAT_RADIUS = 50;
/** 雪地上脚趾摊开的程度（grip）；急刹时摊得更开（刹车）。 */
const GROUND_GRIP = 0.25;
const SKID_GRIP = 0.12;
/** 相机跟随的点在鸟群局部坐标里的位置（躯干中心附近）。 */
const FOLLOW_LOCAL = new Vector3(0, 2.6, 0);
const UP = new Vector3(0, 1, 0);
/** 踝离栖面的高度（parts.ts buildLegs 的 +0.03）和原版两踝离鸟群原点的平均高度：落地换栖面时按后者反推原点高度。 */
const ANKLE_CLEAR = 0.03;
const ANKLE_HEIGHT = 0.0445;
/** 腾空时脚踝收到腹下：比静态落点抬高多少（厘米）。 */
const TUCK_LIFT = 0.4;
/** 动量超过这个值，蹬伸时翅膀开始抖（连跳第 3 下起，越连越大）。 */
const FLICK_MOMENTUM = 0.3;
/** 掉头蹦往转向那边压肩的幅度（弧度）。 */
const TURN_ROLL = 0.18;
/** 急刹滑雪：躯干前倾量、尾羽压低的角度（弧度，负 = 尾往下压）、尾羽扇开量（和动作系统的扇开叠加后封顶 0.5，面板设计上限 0.6）。 */
const SKID_PITCH = 0.22;
const SKID_TAIL_PITCH = -0.3;
const SKID_TAIL_SPREAD = 0.5;
const TAIL_SPREAD_MAX = 0.5;
/** 跳视先导：掉头蹦头先转过去的角度（头颈上限 100°）、其余跳视低头看落点的俯角。 */
const GAZE_TURN = 1.4;
const GAZE_LEAD_PITCH = 0.15;
/** 跃离后空格还要按多久才起飞（秒）：轻点空格仍是一跳，按住才飞。 */
const TAKEOFF_HOLD = 0.12;
/** 落地后双翅 / 尾扇从飞行态收拢回体侧的时长（秒）。 */
const FOLD_TIME = 0.11;
/** 站着时身体跟转镜头方向的平滑系数（1 / 秒）。 */
const FACE_RATE = 6;
/**
 * 翅的刚体角（弧度）。flap 正 = 翼尖往上（右翅在局部 +x，rotation.z = +flap 把翼尖抬起来）、下扑为负；
 * **sweep 正 = 往尾侧后扫**（rotation.y 正转把 +x 的翼尖推向 −Z，对照观鸟面板的"翅后扫"滑块）、负 = 前扫；
 * twist 正 = 翼面法线朝喙那边翻（前缘往下）。扑翼：略偏上扬 + 对称摆幅（下扑是发力程，相位和动作系统展翅扑翼演示同源），
 * 下扑时略前扫、上扬时略后扫（翼尖走 8 字）；滑翔微上反；刹车（S）双翅上扬后掠、前缘略上翻加大迎角；
 * 着陆 Flare 双翅前伸、略低于体平面兜风，前缘略上翻——翻转幅度都收着（大了翼根会切进脸颊 / 胸前的绒毛）。
 */
const FLAP_BIAS = 0.12;
const FLAP_AMP = 0.5;
const FLAP_SWEEP = 0.06;
const GLIDE_FLAP = 0.15;
const BRAKE_FLAP = 0.5;
const BRAKE_SWEEP = 0.2;
const BRAKE_TWIST = -0.18;
const FLARE_FLAP = 0.12;
const FLARE_SWEEP = -0.35;
const FLARE_TWIST = -0.15;
/** 着陆 Flare 里柔和的减速小扑棱：幅度（弧度）随 flareK 衰减，频率从 7 Hz 放慢到 4 Hz（真山雀落枝前兜风扑翼刹车的那两三下）。 */
const FLARE_FLUTTER = 0.3;
const FLARE_FLUTTER_HZ = 7;
const FLARE_FLUTTER_HZ_END = 4;
/**
 * W / 空格的拉杆幅度（0..1，乘 Flight 的 pitchUp 0.45）。扑翼-收翼周期里只有 70% 的时间有推力，巡航速度下能长期撑住的爬升角
 * 约 8°（压测：pitch 0.135 按住 3 s 稳定在 8°、空速 365 上下、不失速），按住不松手稳定微爬升、速度稳在失速速度 240 的 1.5 倍附近不失速。
 */
const W_CRUISE_PULL = 0.3;
/** 尾羽：滑翔略抬、着陆抬起扇开、跟着坡度微微压（弧度）。 */
const TAIL_FLARE_PITCH = 0.3;
const TAIL_BANK = 0.25;
/** 落到电线 / 细枝上激发颤动的最小撞击速度（厘米 / 秒）：Flare 落得很轻，但鸟落上去线总要沉一下。 */
const LAND_EXCITE = 35;
/** 自动巡飞落定后在原地站这么久再起飞（歇一下脚，顺便让镜头跟上）。 */
const AUTO_WAIT = 1.2;
/** 按下这些键 = 从自动巡飞接管回手动（V / G / H 是视角和模式键，不算操控，也不进按键集）。 */
const TAKEOVER_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ShiftRight', 'KeyC', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
const UI_KEYS = new Set(['KeyV', 'KeyG', 'KeyH']);
/** 落点的面法线朝上分量 ≥ 它就当平面（世界竖直铺栖面），低于它（雪垄 / 斜屋顶 / 雨棚）按法线斜着铺——脚贴坡不悬空。 */
const SLOPE_FLAT_NY = 0.99;

type PerchKind = 'branch' | 'limb' | 'curve' | 'ground';

const PHASE_TEXT: Record<string, string> = {
  stand: '站着',
  crouch: '蓄力',
  push: '蹬伸',
  air: '腾空',
  settle: '落地缓冲',
  skid: '急刹',
};

export class Player {
  readonly loco = new Locomotion();
  /** 飞行（阶段 4）：flying 为 true 时每帧推进它，步态停着；落定后交回步态。 */
  readonly flight = new Flight();
  /** 自由巡飞（阶段 5 观赏模式）的自动驾驶：auto 为 true 时飞行意图由它给，落定后歇 AUTO_WAIT 秒自动再起飞。景点表来自舞台。 */
  readonly autopilot: Autopilot;
  auto = false;
  flying = false;
  /** 操控开关：关着时鸟停在枝上不动（静态机位 / 调试台用）。 */
  enabled = false;
  /** 自动巡飞落定后已经站了多久（秒）。 */
  private autoWait = 0;
  /**
   * 脚印回调（庭院雪印等微交互）：鸟落地（kind = 'land'：每一步落定、飞行着陆、开关操控落定）或从站着的面蹬地腾空
   * （'push'：起跳 / 走出边缘）时调用。p = 双脚中心的触点（世界）、n = 面法线、surface = 落的那个碰撞面——
   * 是不是覆雪面由调用方按 surface 的 tag 判。
   */
  onFootprint: ((p: Vector3, n: Vector3, surface: Surface, kind: 'land' | 'push') => void) | null = null;
  private readonly footP = new Vector3();
  private readonly footN = new Vector3();
  private footSurface: Surface | null = null;

  private readonly bird: Bird;
  private readonly stage: Stage;
  private readonly motion: MotionController;
  private readonly keys = new Set<string>();
  private readonly intent: Intent = { x: 0, z: 0, hop: false, leap: false, steer: false };
  /** 镜头的水平视线方向（相机控制器每帧写）：地面上的 WASD 按它换算。 */
  camDirX = 0;
  camDirZ = -1;
  private readonly flightIntent: FlightIntent = { turn: 0, pitch: 0, flap: false };
  /** 飞行中按着鼠标右键（相机控制器写）：和 C 键一样是收力滑翔。 */
  glideHold = false;
  /** 腾空后空格按了多久（秒）：够了就起飞（轻点空格还是一跳）。 */
  private airSpace = 0;
  /** 着陆 Flare 里小扑棱的相位（弧度）。 */
  private flarePh = 0;
  /** 飞行中航向 / 俯仰跟鼠标镜头（相机控制器每帧写 lookYaw / lookPitch，−1..1，已经去过死区）；关着就只用键盘。 */
  camSteer = true;
  lookYaw = 0;
  lookPitch = 0;
  /** 站在平地上时身体跟转的方位（世界，atan2(x, z) 约定；相机控制器每帧写，null = 不跟转）。 */
  faceYaw: number | null = null;
  /** 落地收翅的进度（秒；≥ FOLD_TIME = 收完了）：从飞行态最后一天的翅 / 尾姿态收拢回体侧。 */
  private foldT = 1;
  private readonly foldWing: Required<WingPose> = { open: 0, flap: 0, sweep: 0, twist: 0 };
  private foldTailSpread = 0;
  private foldTailPitch = 0;
  private readonly euler = new Euler(0, 0, 0, 'YXZ');
  private readonly relaunch = new Vec3();
  /** 落点的视觉标架：鸟群原点；朝向跟 loco.heading，顶面恒为世界竖直。 */
  private readonly rootPos = new Vector3();
  private readonly landPos = new Vector3();
  private readonly landHeading = new Vector3();
  /** 自动巡飞起飞时的朝向（自动驾驶挑的，和落定时的身体朝向可以不同）。 */
  private readonly launchHeading = new Vector3();
  /** 鸟群原点比步态的根（落点）高多少（厘米，沿竖直）。 */
  private rootLift = 0;
  /** 落地那一刻弹性栖面在根处的位移（跟着线走时每帧只加差量）。 */
  private perchOff = 0;
  private perchKind: PerchKind = 'branch';
  private readonly quat = new Quaternion();
  private readonly invQ = new Quaternion();
  private readonly basis = new Matrix4();
  private readonly xAxis = new Vector3();
  private readonly yAxis = new Vector3();
  private readonly zAxis = new Vector3();
  private readonly tan = new Vector3();
  private readonly pUp = new Vector3();
  private readonly pSide = new Vector3();
  private readonly feet: [FootState, FootState] = [
    { grip: 1, ankle: null },
    { grip: 1, ankle: null },
  ];
  /** 腾空时脚踝的目标（常驻， feet[i].ankle 在 null 和这两个之间切换）。 */
  private readonly ankleAir: [Vector3, Vector3] = [new Vector3(), new Vector3()];
  private readonly tuck = new Vector3();
  private readonly ankle = new Vector3();
  private readonly frame = makeCurveFrame();
  private readonly frame2 = makeCurveFrame();
  /** 翅 / 尾的覆盖还开着：关掉时还原一次（动作系统关着时也不会留着上一帧的覆盖）。 */
  private wingOn = false;
  private tailOn = false;
  /** 叠加用的翅 / 尾姿态（常驻）。 */
  private readonly wingR: Required<WingPose> = { open: 0, flap: 0, sweep: 0, twist: 0 };
  private readonly wingL: Required<WingPose> = { open: 0, flap: 0, sweep: 0, twist: 0 };
  private readonly tail: Required<TailPose> = { pitch: 0, yaw: 0, roll: 0, spread: 0 };

  constructor(bird: Bird, stage: Stage, motion: MotionController) {
    this.bird = bird;
    this.stage = stage;
    this.motion = motion;
    this.autopilot = new Autopilot(stage.flySpots);
    this.autopilot.groundY = stage.groundY;
    this.flight.homeRadius = stage.bounds.radius;
    this.flight.homeRadiusZ = stage.bounds.radiusZ ?? 0;
    this.flight.voidY = stage.bounds.voidY;
    this.flight.homeX = stage.bounds.x;
    this.flight.homeY = stage.bounds.y;
    this.flight.homeZ = stage.bounds.z;
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
  }

  /** 自由巡飞开关：开 = 飞行交给自动驾驶（在枝上就歇一下自动起飞）；关 = 回手动。按任意操控键也会接管回手动。 */
  setAuto(on: boolean): void {
    if (on === this.auto) return;
    this.auto = on;
    this.autoWait = 0;
    if (on) this.autopilot.reset();
  }

  /** 玩家正在输入（按着键，或步态不在站着）：相机该跟到鸟背后。 */
  get inputActive(): boolean {
    return this.keys.size > 0 || (!this.flying && this.loco.phase !== 'stand');
  }

  /** 按着 A/D（或左右方向键）：相机控制器用它判断"这一帧的航向变化是键盘转的"——键盘转弯要拖着视角一起走。 */
  get keyTurnHeld(): boolean {
    const k = this.keys;
    return k.has('KeyA') || k.has('ArrowLeft') || k.has('KeyD') || k.has('ArrowRight');
  }

  /** 此刻实际摆着的翅膀展开度（地面连跳的助推抖动 + 落地收翅；飞行 = Flight 的 wingOpen）：气流尾迹用。 */
  get wingOpenNow(): number {
    return this.flying ? this.flight.wingOpen : this.wingR.open;
  }

  /** 鸟此刻的水平朝向（飞行 = Flight 的航向，否则步态的朝向）：相机跟着它绕到背后。 */
  get headingX(): number {
    return (this.flying ? this.flight.heading : this.loco.heading).x;
  }

  get headingZ(): number {
    return (this.flying ? this.flight.heading : this.loco.heading).z;
  }

  /** 开关操控。开：从鸟现在站的地方接着控制；关：回到初始栖枝。 */
  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    this.keys.clear();
    if (on) {
      const g = this.bird.group;
      const h = this.zAxis.set(0, 0, 1).applyQuaternion(g.quaternion);
      this.loco.place(this.stage.world, g.position.x, g.position.y + 0.3, g.position.z, h.x, h.z);
      this.onLanded();
    } else {
      this.reset();
    }
  }

  /** 回到舞台的栖点（调试台 = 观鸟的初始栖枝：主角枝 x = 0，面朝世界 -X），步态、脚、躯干全部归零。 */
  reset(): void {
    const g = this.bird.group;
    const home = this.stage.home;
    this.flying = false;
    this.flight.phase = 'landed';
    this.airSpace = 0;
    this.auto = false;
    this.autoWait = 0;
    this.autopilot.reset();
    g.position.set(home.root.x, home.root.y, home.root.z);
    g.rotation.set(0, home.root.yaw, 0);
    this.loco.place(this.stage.world, home.query.x, home.query.y, home.query.z, home.query.hx, home.query.hz);
    this.rootPos.set(home.root.x, home.root.y, home.root.z);
    this.perchKind = 'branch';
    // 初始栖点保持原版：鸟群原点就在给定的位置（栖面标架按真实的枝轴，和静态腿一样），腾空时带着它和步态的根之间的高度差走
    this.invQ.copy(g.quaternion).invert();
    this.bindPerch(this.stage.perches.perchAt(home.perchX), false, this.rootPos, false);
    this.rootLift = -this.loco.pos.y;
    this.perchOff = 0;
    // 回栖点也算一次"落定"（没有冲击）：舞台的主角枝重新接上体重 / 爪印
    if (this.loco.surface !== null) this.stage.perches.interact?.land(this.loco.surface, home.perchX, 0);
    this.feet[0].grip = 1;
    this.feet[0].ankle = null;
    this.feet[1].grip = 1;
    this.feet[1].ankle = null;
    this.bird.setFootPose('right', this.feet[0]);
    this.bird.setFootPose('left', this.feet[1]);
    this.bird.setHopPose(0, 0, 0);
    this.bird.setWingPose('both', {});
    this.bird.setTailPose({});
    this.wingOn = false;
    this.tailOn = false;
    this.foldT = 1;
    this.foldWing.open = 0;
    this.foldWing.flap = 0;
    this.foldWing.sweep = 0;
    this.foldWing.twist = 0;
    this.foldTailSpread = 0;
    this.foldTailPitch = 0;
  }

  /** 相位的中文名（面板 / HUD 用）。 */
  phaseText(): string {
    return PHASE_TEXT[this.loco.phase] ?? this.loco.phase;
  }

  /** 面板 / HUD 的状态行：飞行中写飞行的状态和空速，否则写步态相位和跳数；自动巡飞加前缀。 */
  statusText(): string {
    const tag = this.auto ? (this.flying ? '自动巡飞 · ' : '自动巡飞 · 歇脚 ') : '';
    if (this.flying) {
      const f = this.flight;
      const m = f.phase === 'flare' ? '着陆' : f.launch > 0 ? '起飞' : f.boost > 0.5 ? '冲刺' : f.flapping ? '扑翼' : f.brake ? '刹车' : f.stall > 0.5 ? '失速' : '滑翔';
      return `${tag}${m} · ${(f.speed / 100).toFixed(1)} m/s`;
    }
    return `${tag}${this.phaseText()} · 第 ${this.loco.hops} 跳`;
  }

  /** base = 动作系统这一帧的 Pose（动作系统关着时为 null）：翅 / 尾在它上面叠加。 */
  update(dt: number, base: Pose | null): void {
    if (!this.enabled) return;
    if (this.flying) {
      this.updateFlight(dt, base);
      return;
    }
    // 自动巡飞：在枝上 / 雪地上歇 AUTO_WAIT 秒就从原地起飞（发射期全力扑翼），不读键盘
    if (this.auto) {
      this.autoWait += dt;
      if (this.autoWait >= AUTO_WAIT && this.loco.phase === 'stand') {
        this.takeOff();
        this.updateFlight(dt, base);
        return;
      }
    }
    this.readIntent();
    const was = this.loco.phase;
    const hook = this.stage.perches.interact;
    this.loco.update(dt, this.intent, this.stage.world);
    if (this.loco.respawned || this.loco.landed) this.onLanded();
    // 纯第一人称站在平地上：身体平顺跟转镜头方向（枝上脚爪钉着枝轴不转；跳 / 缓冲 / 急刹中不转，转身交给跳本身）
    if (this.faceYaw !== null && this.loco.phase === 'stand' && !(this.loco.surface instanceof CurvePerch)) {
      const h = this.loco.heading;
      let e = this.faceYaw - Math.atan2(h.x, h.z);
      e = Math.atan2(Math.sin(e), Math.cos(e));
      if (Math.abs(e) > 0.004) {
        const th = e * (1 - Math.exp(-FACE_RATE * dt));
        const cs = Math.cos(th);
        const sn = Math.sin(th);
        this.loco.heading.set(h.x * cs + h.z * sn, 0, -h.x * sn + h.z * cs).normalize();
        this.loco.targetHeading.copy(this.loco.heading);
      }
    }
    // 跳视先导：一决定起跳（进蓄力）头就先转过去
    if (this.loco.phase === 'crouch' && was === 'stand') this.gazeLead();
    // 任何腾空 / 下落（跃离、从枝梢 / 屋檐掉下去、原地按着空格的小跳）按着空格满 TAKEOFF_HOLD 秒就展翅切入飞行；轻点空格还是一跳
    const airNow = this.loco.phase === 'air';
    if (airNow && was !== 'air') {
      this.airSpace = 0;
      // 从站着的面蹬地腾空（起跳 / 走出边缘）：脚印留在起跳点
      if (this.footSurface !== null) this.onFootprint?.(this.footP, this.footN, this.footSurface, 'push');
      // 舞台的主角枝：蹬离 / 走出边缘时把静态下垂放开、按蹬速给冲量（枝回弹，果梗单摆跟着晃）
      if (hook !== undefined && this.footSurface !== null) hook.leave(this.footSurface, this.footP.x, this.loco.pushSpeed);
    }
    // 蹲伏蓄力：按步态的下沉量实时预压主角枝
    if (hook !== undefined && this.loco.phase === 'crouch' && this.loco.surface !== null) hook.crouch(this.loco.surface, this.loco.pos.x, this.loco.crouch);
    if (airNow && this.keys.has('Space')) {
      this.airSpace += dt;
      if (this.airSpace >= TAKEOFF_HOLD) {
        this.takeOff();
        return;
      }
    }

    // 根：腾空 / 急刹时跟着步态的根走（腾空带着落地那一刻的高度差）；站在弹性栖面（电线 / 细枝）上时跟着线的竖直位移走；
    // 其余钉在落地那一刻算好的视觉栖面顶点。舞台给了栖面交互钩子（主角枝：弯曲由画面层算）时同样跟着它的位移走
    const phase = this.loco.phase;
    const air = phase === 'air';
    if (air || phase === 'skid') this.rootPos.set(this.loco.pos.x, this.loco.pos.y + this.rootLift, this.loco.pos.z);
    else if (hook !== undefined || this.loco.surface instanceof CurvePerch) {
      const s = this.loco.surface;
      const off = (s instanceof CurvePerch ? s.offsetAt(this.loco.u) : 0) + (hook && s !== null ? hook.lift(s, this.loco.pos.x) : 0);
      this.rootPos.y += off - this.perchOff;
      this.perchOff = off;
    }
    this.placeGroup();

    // 躯干：蓄力 / 缓冲按步态的下沉量；起跳微仰、落地微俯；掉头蹦往转向那边压肩；急刹前倾
    const k = this.loco.airK;
    let pitch = 0;
    let roll = 0;
    if (air) {
      pitch = -0.1 * Math.sin(Math.PI * k);
      if (this.loco.hopKind === 'turn') roll = -this.loco.turnSign * TURN_ROLL * Math.sin(Math.PI * k);
    } else if (phase === 'settle') pitch = 0.12 * this.loco.crouch;
    else if (phase === 'push') pitch = -0.06;
    else if (phase === 'skid') pitch = SKID_PITCH * (1 - this.loco.skidK);
    this.bird.setHopPose(this.loco.crouch, pitch, roll);

    // 翅 / 尾：在动作系统这一帧的 Pose 上叠加——连跳攒了动量，蹬伸那一下双翅抖开（扑翼助推），腾空前半程收回；
    // 急刹时尾羽扇开、往下压当刹车（扇开量和动作系统的叠加后封顶 TAIL_SPREAD_MAX：扇面靠补宽保持连续，但角度大了还是太夸张）
    const skid = phase === 'skid' ? 1 - this.loco.skidK : 0;
    const flick = this.wingFlick();
    // 落地收翅：飞行态最后的翅 / 尾姿态在 FOLD_TIME 内柔和收拢（不是落地那一帧瞬间合上）
    const fold = this.foldT < FOLD_TIME ? 1 - smoothstep(0, 1, this.foldT / FOLD_TIME) : 0;
    if (this.foldT < FOLD_TIME) this.foldT = Math.min(FOLD_TIME, this.foldT + dt);
    const fw = this.foldWing;
    const bw = base?.wing;
    const wr = this.wingR;
    const wl = this.wingL;
    wr.open = (bw?.right.open ?? 0) + 0.4 * flick + fw.open * fold;
    wr.flap = (bw?.right.flap ?? 0) + 0.6 * flick + fw.flap * fold;
    wr.sweep = (bw?.right.sweep ?? 0) + fw.sweep * fold;
    wr.twist = (bw?.right.twist ?? 0) + fw.twist * fold;
    wl.open = (bw?.left.open ?? 0) + 0.4 * flick + fw.open * fold;
    wl.flap = (bw?.left.flap ?? 0) + 0.6 * flick + fw.flap * fold;
    wl.sweep = (bw?.left.sweep ?? 0) + fw.sweep * fold;
    wl.twist = (bw?.left.twist ?? 0) + fw.twist * fold;
    const wingAct = flick > 0.001 || fold > 0;
    if (wingAct || this.wingOn) {
      this.bird.setWingPose('right', wr);
      this.bird.setWingPose('left', wl);
    }
    this.wingOn = wingAct;
    const bt = base?.tail;
    const tl = this.tail;
    tl.pitch = (bt?.pitch ?? 0) + SKID_TAIL_PITCH * skid + this.foldTailPitch * fold;
    tl.yaw = bt?.yaw ?? 0;
    tl.roll = bt?.roll ?? 0;
    tl.spread = Math.min(TAIL_SPREAD_MAX, (bt?.spread ?? 0) + SKID_TAIL_SPREAD * skid + this.foldTailSpread * fold);
    const tailAct = skid > 0 || fold > 0;
    if (tailAct || this.tailOn) this.bird.setTailPose(tl);
    this.tailOn = tailAct;

    // 脚：钉着 → 包握（雪地摊开，急刹摊得更开），落地缓冲的前 40% 从半开合到包握；腾空 → 收到腹下，临落地前伸向落点、脚趾合拢
    const grip = this.perchKind === 'ground' ? (phase === 'skid' ? SKID_GRIP : GROUND_GRIP) : 1;
    if (air) {
      const extend = smoothstep(0.55, 1, k);
      const g = 0.35 + 0.6 * smoothstep(0.5, 1, k);
      for (const i of [0, 1] as const) {
        this.bird.legRig.ankleRest(i, this.ankle);
        this.tuck.set(this.ankle.x * 0.6, this.ankle.y + TUCK_LIFT, this.ankle.z - 0.06).lerp(this.ankle, extend);
        this.ankleAir[i].copy(this.tuck);
        this.feet[i].grip = g;
        this.feet[i].ankle = this.ankleAir[i];
      }
    } else {
      const g = phase === 'settle' ? 0.5 + (grip - 0.5) * smoothstep(0, 0.4, this.loco.t / this.loco.settleTime) : grip;
      this.feet[0].grip = g;
      this.feet[0].ankle = null;
      this.feet[1].grip = g;
      this.feet[1].ankle = null;
    }
    this.bird.setFootPose('right', this.feet[0]);
    this.bird.setFootPose('left', this.feet[1]);
  }

  /** 展翅切入飞行：把此刻的位置、速度、朝向交给 Flight。速度还没到失速速度（刚跳起来 / 掉下去不久）走发射期全力拉起来；
   *  下落已经比失速速度还快就直接按现在的速度方向进滑翔 / 俯冲，不强制走发射期。 */
  private takeOff(): void {
    const p = this.loco.pos;
    const v = this.loco.vel;
    // 自动巡飞：朝向交给自动驾驶挑（歇脚时面朝墙，发射期舵效只有三成转不动，得朝前方最空的方向起飞）
    const a = this.auto ? this.autopilot.launchAzimuth(this.flight, this.stage.world) : Math.atan2(this.loco.heading.x, this.loco.heading.z);
    const h = this.launchHeading.set(Math.sin(a), 0, Math.cos(a));
    // 腾空时速度超过失速速度就直接进滑翔 / 俯冲（不走发射期）：高处掉下去半空按空格展翅
    this.flight.start(p, v, h.x, h.z, v.length() < this.flight.params.stallSpeed);
    this.flying = true;
    this.airSpace = 0;
    this.flarePh = 0;
    // 头看向前方略往下（找落点）
    this.motion.gaze.cueSaccade(0, 0.1, this.motion.events);
  }

  /**
   * 开场起飞（庭院入口的蓄力条蓄满）：鸟保持此刻面朝的方向直接展翅切入飞行——带上一个小跳的竖直初速走发射期
   * （和"原地按住空格起飞"同一套姿态）。观鸟态是横站在枝上、朝向和枝轴垂直，setEnabled 的枝轴吸附会把它拧到枝轴上，
   * 所以这里按传入的朝向重新摆正鸟群再起飞：面朝哪就往哪飞。
   */
  launch(headingX: number, headingZ: number): void {
    if (this.flying) return;
    const h = this.loco.heading.set(headingX, 0, headingZ);
    h.normalize();
    this.loco.targetHeading.copy(h);
    this.orientGroup();
    this.loco.vel.set(h.x * 40, 110, h.z * 40);
    this.takeOff();
  }

  /**
   * 开操控后保持观鸟态的横站朝向（面朝的方向和枝轴垂直）：setEnabled 的枝轴吸附会把鸟拧成顺着枝站，
   * 这里按传入的朝向重新摆正鸟群并按新朝向重绑两脚（脚位沿枝左右分开、趾包着枝）——一镜到底的交接里鸟不会原地转 90°。
   */
  perchFacing(headingX: number, headingZ: number): void {
    if (this.flying) return;
    const h = this.loco.heading.set(headingX, 0, headingZ);
    h.normalize();
    this.loco.targetHeading.copy(h);
    this.onLanded();
  }

  /**
   * 飞行中每帧。键位（相对鸟身）：A/D 压坡转弯；进了飞行态默认自动巡航扑翼；W / 空格 = 稳定的微爬升（拉杆幅度压在不失速的范围里，
   * 按住不松手也不会仰头失速；爬升中不做着陆探测，靠近屋顶拉起不会被抓下去）；S = 拉起减速刹车（停扑、仰身、阻力 ×3，准备落枝）；
   * C / 右键 = 滑翔；Shift = 冲刺（巡航 700、推力 +50%、18 Hz，不做着陆探测）。
   * 没按 A/D、W/S 时航向和俯仰跟镜头：相机控制器把"镜头方位 − 航向方位"（最短角差）和镜头仰角写成 lookYaw / lookPitch。
   * 机体姿态按偏航 → 俯仰 → 滚转摆在鸟群上；落定就交回步态。
   */
  private updateFlight(dt: number, base: Pose | null): void {
    const k = this.keys;
    const f = this.flight;
    const it = this.flightIntent;
    if (this.auto) {
      // 自动巡飞：意图全部来自自动驾驶（景点轮换 + 前瞻避障 + 扑翼滑翔节奏），键盘只负责接管（onKeyDown 里关 auto）
      this.autopilot.update(dt, f, this.stage.world, it);
    } else {
      const keyTurn = (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0) - (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0);
      const keyPitch = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
      it.turn = keyTurn !== 0 ? keyTurn : this.camSteer ? this.lookYaw : 0;
      // 进了飞行态默认自动维持巡航波浪扑翼（单靠鼠标就能巡航转向，不用死按空格）；W / 空格 = 拉杆爬升（W_CRUISE_PULL 不失速）；
      // S = 满幅拉杆 + 停扑的空中急刹；C / 鼠标右键 = 收力滑翔；Shift = 冲刺
      const glide = k.has('KeyC') || this.glideHold;
      const climb = keyPitch > 0 || k.has('Space');
      it.boost = k.has('ShiftLeft') || k.has('ShiftRight');
      it.climb = climb;
      it.pitch = keyPitch < 0 ? 1 : climb ? W_CRUISE_PULL : this.camSteer ? this.lookPitch : 0;
      it.flap = keyPitch >= 0 && !glide;
      it.land = false;
    }
    const flaring = f.phase === 'flare';
    f.update(dt, it, this.stage.world);
    if (f.landed) {
      this.onFlightLanded();
      // 落地这一帧动作系统已经把翅 / 尾摆回基础姿态：补写飞行态最后的姿态，收翅从下一帧开始
      //（不然这一帧先合上、下一帧又张开来收，闪一帧）；落点踩不住重新起飞了就不管
      if (!this.flying) {
        this.bird.setWingPose('right', this.wingR);
        this.bird.setWingPose('left', this.wingL);
        this.bird.setTailPose(this.tail);
        this.wingOn = true;
        this.tailOn = true;
      }
      return;
    }
    // 根 = Flight 的根（两脚之间那点，和步态的根同一个点，腾空时的 rootLift 接着用）；机体：偏航 → 俯仰 → 滚转
    this.rootPos.set(f.pos.x, f.pos.y + this.rootLift, f.pos.z);
    this.bird.group.position.copy(this.rootPos);
    this.bird.group.quaternion.setFromEuler(this.euler.set(-f.bodyPitch, Math.atan2(f.heading.x, f.heading.z), -f.bank));
    this.bird.setHopPose(0, 0, 0);
    // 进着陆 Flare 那一刻低头看落点
    if (!flaring && f.phase === 'flare') {
      this.motion.gaze.cueSaccade(0, 0.3, this.motion.events);
      this.flarePh = 0;
    }

    // 翅：扑翼角跟 Flight 的扑翼相位（收翼时翅膀合上）；滑翔微上反；刹车双翅上扬后掠；着陆 Flare 前伸略低兜风，
    // 叠一个幅度随 flareK 衰减、频率放慢的小扑棱（减速刹车那两三下），别僵硬地端死
    const open = f.wingOpen;
    const wr = this.wingR;
    const wl = this.wingL;
    let flap: number;
    let sweep: number;
    let twist: number;
    if (f.phase === 'flare') {
      const q = f.flareK;
      const hz = FLARE_FLUTTER_HZ + (FLARE_FLUTTER_HZ_END - FLARE_FLUTTER_HZ) * q;
      this.flarePh += hz * Math.PI * 2 * dt;
      flap = FLARE_FLAP * q + FLARE_FLUTTER * (1 - q) * (1 - q) * Math.sin(this.flarePh);
      sweep = FLARE_SWEEP * q;
      twist = FLARE_TWIST * q;
    } else if (f.flapping) {
      flap = (FLAP_BIAS + FLAP_AMP * Math.sin(f.flapPhase)) * open;
      sweep = FLAP_SWEEP * Math.cos(f.flapPhase) * open;
      twist = 0.1 * Math.sin(f.flapPhase - 0.9) * open;
    } else if (f.brake) {
      flap = BRAKE_FLAP * open;
      sweep = BRAKE_SWEEP * open;
      twist = BRAKE_TWIST * open;
    } else {
      flap = (GLIDE_FLAP + 0.04 * Math.sin(f.t * 3)) * open;
      sweep = 0;
      twist = 0;
    }
    wr.open = open;
    wr.flap = flap;
    wr.sweep = sweep;
    wr.twist = twist;
    wl.open = open;
    wl.flap = flap;
    wl.sweep = sweep;
    wl.twist = twist;
    this.bird.setWingPose('right', wr);
    this.bird.setWingPose('left', wl);
    this.wingOn = true;

    // 尾：扇开量跟 Flight（巡航微展、刹车 / 着陆扇到 0.5），着陆时抬起当刹车，跟着坡度微微压
    const tl = this.tail;
    const bt = base?.tail;
    tl.pitch = (bt?.pitch ?? 0) + 0.1 * open + TAIL_FLARE_PITCH * f.flareK;
    tl.yaw = bt?.yaw ?? 0;
    tl.roll = (bt?.roll ?? 0) - TAIL_BANK * f.bank;
    tl.spread = Math.min(TAIL_SPREAD_MAX, (bt?.spread ?? 0) + f.tailSpread);
    this.bird.setTailPose(tl);
    this.tailOn = true;

    // 脚：收到腹下，着陆 Flare 里伸向落点、脚趾合拢
    const extend = f.legsExtend;
    const g = 0.35 + 0.6 * extend;
    for (const i of [0, 1] as const) {
      this.bird.legRig.ankleRest(i, this.ankle);
      this.tuck.set(this.ankle.x * 0.6, this.ankle.y + TUCK_LIFT, this.ankle.z - 0.06).lerp(this.ankle, extend);
      this.ankleAir[i].copy(this.tuck);
      this.feet[i].grip = g;
      this.feet[i].ankle = this.ankleAir[i];
    }
    this.bird.setFootPose('right', this.feet[0]);
    this.bird.setFootPose('left', this.feet[1]);
  }

  /** 飞行落定：步态 place 到落点（绑栖面、绑脚），弹性栖面激发一下颤动。 */
  private onFlightLanded(): void {
    const f = this.flight;
    const p = f.pos;
    const h = f.heading;
    this.flying = false;
    if (!this.loco.place(this.stage.world, p.x, p.y, p.z, h.x, h.z)) {
      // 落点踩不住（法线太斜之类，Flare 已经筛过，基本不会）：原地再蹬一下接着飞
      this.relaunch.set(h.x * 100, 80, h.z * 100);
      f.start(p, this.relaunch, h.x, h.z, true);
      this.flying = true;
      return;
    }
    const s = this.loco.surface;
    // 悬臂细枝（老海棠 / 春树）：Flare 落得很轻，但一只鸟的体重砸在细枝上枝要沉一下——激发的等效速度抬到 110 cm/s
    if (s instanceof CurvePerch) s.excite(this.loco.u / s.length, Math.max(f.landedSpeed, s.cantilever ? 110 : LAND_EXCITE), 1);
    // 触地时的切向余速交给步态：够快就顺着朝向滑一小段急刹，否则落地缓冲；不让鸟张着翅膀在原地等
    this.loco.landFromFlight(Math.hypot(f.touchVel.x, f.touchVel.z));
    // 法向触地速度记进步态的 impactSpeed（步态落地是它自己写的；飞行落定在这里补），栖面交互钩子按它给冲量 / 震雪粉
    this.loco.impactSpeed = f.landedSpeed;
    // 收翅：从飞行态最后的翅 / 尾姿态开始，FOLD_TIME 内收拢
    this.foldT = 0;
    this.foldWing.open = f.wingOpen;
    this.foldWing.flap = this.wingR.flap;
    this.foldWing.sweep = this.wingR.sweep;
    this.foldWing.twist = this.wingR.twist;
    this.foldTailSpread = f.tailSpread;
    this.foldTailPitch = TAIL_FLARE_PITCH * f.flareK;
    this.autoWait = 0;
    this.onLanded();
  }

  /** 相机跟随的点（世界坐标）：鸟群局部 FOLLOW_LOCAL 处。 */
  followTarget(out: Vector3): Vector3 {
    return this.bird.group.localToWorld(out.copy(FOLLOW_LOCAL));
  }

  /** 扑翼助推的翅膀抖动量 0..1：动量越大越大；蹬伸期张开、腾空前半程收回，每一跳抖一下。 */
  private wingFlick(): number {
    const m = smoothstep(FLICK_MOMENTUM, 1, this.loco.momentum);
    if (m <= 0) return 0;
    if (this.loco.phase === 'push') return m * smoothstep(0, 0.6, this.loco.t / this.loco.pushTime);
    if (this.loco.phase === 'air') return m * (1 - smoothstep(0.05, 0.5, this.loco.airK));
    return 0;
  }

  /**
   * 跳视先导：起跳那一刻头先转向要去的地方。掉头蹦朝转向那边转头（头颈上限 100°，转体时头不会焊死在胸口）；
   * 其余朝目标方向、略低头看落点。角度按动作系统 lookAngles 同一套约定：yaw 朝鸟身局部 +X 为正、pitch 低头为正。
   */
  private gazeLead(): void {
    const h = this.loco.heading;
    const t = this.loco.targetHeading;
    const yaw = this.loco.hopKind === 'turn' ? this.loco.turnSign * GAZE_TURN : Math.atan2(h.z * t.x - h.x * t.z, h.x * t.x + h.z * t.z);
    this.motion.gaze.cueSaccade(yaw, this.loco.hopKind === 'turn' ? 0 : GAZE_LEAD_PITCH, this.motion.events);
  }

  /**
   * 键盘 → 水平意图（模长 ≤ 1）+ 蹦跳键。地面（雪地 / 盒顶，不在枝上）= 标准的相机相对 WASD：W（含斜前）转身朝镜头方向跳过去，
   * S 不转身直接后撤、纯 A/D 不转身侧跳（steer + move）；枝上（CurvePerch）= 相对鸟身：W/S 顺枝、A/D 原地掉头，保持顺枝的手感；
   * 但镜头偏离枝轴超过 45° 时按 W = 朝镜头方向跃离（leapOff，看哪走哪，和地面 / 屋顶统一——2026-11-23 用户要求）。
   * 方向键按着 = 朝那边连跳；只按空格 = 朝前小跳一下；方向键 + 空格 = 显式跃离（枝上不顺枝轴、朝意图方向跳出去）。
   * camDir 是 RoamApp 每帧写进来的镜头水平视线方向。
   */
  private readIntent(): void {
    const k = this.keys;
    const f = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    const r = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    let fx: number;
    let fz: number;
    const surface = this.loco.surface;
    const ground = !(surface instanceof CurvePerch);
    const leapOff = !ground && f > 0 && this.viewOffAxis(surface);
    if (ground || leapOff) {
      // 镜头视线（水平）：W = 看的方向；右 = 视线 × 上 = (−vz, 0, vx)
      fx = this.camDirX;
      fz = this.camDirZ;
    } else {
      // 鸟身朝向：W = 朝喙；右 = 朝向 × 上 = (−hz, 0, hx)
      fx = this.loco.heading.x;
      fz = this.loco.heading.z;
    }
    const rx = -fz;
    const rz = fx;
    let x = fx * f + rx * r;
    let z = fz * f + rz * r;
    const len = Math.hypot(x, z);
    if (len > 1) {
      x /= len;
      z /= len;
    }
    const it = this.intent;
    it.x = x;
    it.z = z;
    it.hop = k.has('Space') || f !== 0 || r !== 0;
    it.leap = leapOff || (k.has('Space') && (f !== 0 || r !== 0));
    it.steer = ground;
    // 地面按键类别：W（含斜前）= 转身朝镜头方向前进跳、S = 不转身后撤、纯 A/D = 不转身侧跳（枝上不用，枝上按枝轴 / 掉头 / 跃离）
    it.move = !ground || (f === 0 && r === 0) ? undefined : f > 0 ? 'forward' : f < 0 ? 'back' : 'side';
  }

  /** 枝上镜头方向和枝轴（水平）的夹角超过 45°（locomotion.cameraOffAxis）：这时按 W 该朝镜头方向跃离。 */
  private viewOffAxis(curve: CurvePerch): boolean {
    const fr = curve.frameAt(this.loco.u, this.frame);
    return cameraOffAxis(this.camDirX, this.camDirZ, fr.tx, fr.tz);
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (!this.enabled) return;
    // 视角 / 模式键（RoamApp 处理）不进按键集，不然 inputActive 会一直为真、相机老往鸟背后拉
    if (UI_KEYS.has(e.code)) return;
    if (this.auto && TAKEOVER_KEYS.has(e.code)) this.setAuto(false);
    if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    this.keys.add(e.code);
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  private readonly onBlur = (): void => {
    this.keys.clear();
  };

  /**
   * 按 loco 当前的落点（loco.pos / u / surface，落地、开关操控、掉出世界送回之后都一样）重算栖面标架、
   * 摆放鸟群、把脚重新绑到新栖面。
   */
  private onLanded(): void {
    const s = this.loco.surface;
    if (s === null) return;
    const p = this.loco.pos;
    const perch = this.landingPerch(s, this.landPos.set(p.x, p.y, p.z), this.landHeading.set(this.loco.heading.x, 0, this.loco.heading.z));
    this.orientGroup();
    this.invQ.copy(this.bird.group.quaternion).invert();
    // 根放在枝轴 / 平面中心的正上方，高度按"两踝离原点的平均高度 = ANKLE_HEIGHT"反推（bindPerch 解 y）。
    // 雪地 / 盒顶 / 斜面：栖面是半径 50 的圆柱近似，center = 落点 p 沿 −n 退了 50 cm——斜面上 n 不是竖直的，center 的 x / z 比 p
    // 水平偏出 50·sin(坡角)（20°~50° 就是 17~38 cm）。脚是按 center + 面内偏移摆的，仍在 p 上；鸟群原点如果拷了 center.x / z，
    // 身体就飞到斜坡外侧半空、IK 把两条腿拉成几十厘米的长棍（2026-11-23 实机：洋房屋顶）。所以平面的水平原点严格钉在触地点 p 上。
    if (s instanceof CurvePerch) this.rootPos.copy(perch.center);
    else this.rootPos.set(p.x, perch.center.y, p.z);
    this.bindPerch(perch, this.perchKind === 'ground', this.rootPos, true);
    this.perchOff = s instanceof CurvePerch ? s.offsetAt(this.loco.u) : 0;
    // 腾空 / 急刹时根 = 步态的根 + 这个高度差：平地 / 斜面都只有 0.03·n.y − ANKLE_HEIGHT（−0.02 cm 上下），不会再是 −50·n.y
    this.rootLift = this.rootPos.y - p.y;
    this.placeGroup();
    // 记下落脚点 / 法线（蹬地起飞的脚印落在同一处），再通知脚印回调
    this.footP.copy(p);
    this.footN.copy(perch.up);
    this.footSurface = s;
    this.onFootprint?.(this.footP, this.footN, s, 'land');
    // 舞台的主角枝：落地冲量（impactSpeed = 步态落地那一刻的法向冲击速度；飞行落定是 Flare 的触地速度，onFlightLanded 写进去的）
    this.stage.perches.interact?.land(s, p.x, this.loco.impactSpeed);
  }

  /** 落点的视觉栖面（世界坐标）：主枝 / 树的子枝查画面上的那个面，雪地是平面，电线等其他枝条用碰撞体的光滑圆柱。 */
  private landingPerch(s: Surface, p: Vector3, h: Vector3): Perch {
    if (s instanceof CurvePerch) {
      const limb = this.stage.perches.limbOf(s);
      if (this.stage.perches.tagOf(s) === 'branch') {
        this.perchKind = 'branch';
        return this.stage.perches.perchAt(p.x);
      }
      if (limb !== null) {
        this.perchKind = 'limb';
        return this.stage.perches.limbPerch(limb, this.loco.u);
      }
      this.perchKind = 'curve';
      const curve = s;
      const u = this.loco.u;
      const frame2 = this.frame2;
      const f = curve.frameAt(u, this.frame);
      const perch: Perch = {
        center: new Vector3(f.cx, f.cy, f.cz),
        tangent: new Vector3(f.tx, f.ty, f.tz).normalize(),
        up: new Vector3(),
        side: new Vector3(),
        radius: f.radius,
        surfaceRadius: (_alpha: number, along: number): number => curve.frameAt(u + along, frame2).radius,
      };
      perch.up.copy(UP).addScaledVector(perch.tangent, -UP.dot(perch.tangent)).normalize();
      perch.side.crossVectors(perch.tangent, perch.up).normalize();
      return perch;
    }
    // 雪地 / 盒顶：平面（步态的落点就是画面上的面）。切线取朝向的反方向，和原版平地脚位的标架一致。
    // 斜面（法线朝上分量 < SLOPE_FLAT_NY：雪垄 / 斜屋顶 / 雨棚）按法线斜着铺这块平面：两脚落在斜面上、落地 / 急刹时脚贴着坡不悬空；
    // 鸟本身仍世界竖直（orientGroup），只是两条腿一长一短。第一版恒按世界竖直铺，斜屋顶上一脚悬空一脚埋进去
    this.perchKind = 'ground';
    const un = this.loco.up;
    const n = un.y < SLOPE_FLAT_NY ? new Vector3(un.x, un.y, un.z).normalize() : UP.clone();
    const t = new Vector3(-h.x, 0, -h.z);
    t.addScaledVector(n, -t.dot(n)).normalize();
    return {
      center: p.clone().addScaledVector(n, -FLAT_RADIUS),
      tangent: t,
      up: n,
      side: new Vector3().crossVectors(t, n).normalize(),
      radius: FLAT_RADIUS,
      surfaceRadius: () => FLAT_RADIUS,
    };
  }

  /** 鸟群的朝向：局部 +Y = 世界竖直、+Z = 朝向（投到水平面里）。 */
  private orientGroup(): void {
    this.yAxis.copy(UP);
    this.zAxis.set(this.loco.heading.x, 0, this.loco.heading.z);
    if (this.zAxis.lengthSq() < 1e-8) this.zAxis.set(1, 0, 0);
    this.zAxis.normalize();
    this.xAxis.crossVectors(this.yAxis, this.zAxis).normalize();
    this.basis.makeBasis(this.xAxis, this.yAxis, this.zAxis);
    this.bird.group.quaternion.copy(this.quat.setFromRotationMatrix(this.basis));
  }

  private placeGroup(): void {
    this.orientGroup();
    this.bird.group.position.copy(this.rootPos);
  }

  /**
   * 把栖面的世界标架转进鸟群局部坐标、把脚绑上去。place = 落地：枝上原点放到枝轴的正上方、平面 / 斜面上原点钉在触点 p 的正上方
   * （x / z 由 onLanded 给定，这里只解 y），高度让两踝离原点的平均高度 = ANKLE_HEIGHT（躯干离脚的高度 = 已验收的样子；
   * 两脚之间那点雪是踩凹的，不能用落点正上方的表面高度）；否则（初始栖点）原点不动，栖面按真实的枝轴绑（和静态腿一样）。
   * 脚位沿枝的真实切线排（斜枝上两脚一高一低），鸟本身仍世界竖直。flat = 平地：环向角按横向半距换算（不是 FOOT_SPOTS 的枝上角度）。
   * 只在落地 / 重置时调用，这里的小对象分配不在每帧路径上（腿架会一直持有这份栖面标架）。
   */
  private bindPerch(perch: Perch, flat: boolean, rootPos: Vector3, place: boolean): void {
    const inv = this.invQ;
    const t = this.tan.copy(perch.tangent).applyQuaternion(inv);
    const up = this.pUp.copy(perch.up).applyQuaternion(inv);
    const side = this.pSide.copy(perch.side).applyQuaternion(inv);
    // dir = +1：枝轴朝局部 -Z（尾那头）；朝向反过来时 alpha / along 一起反号，脚的布局相对鸟不变
    const dir = (t.z > 0 ? -1 : 1) as 1 | -1;
    const base = perch.radius;
    const feet = [1, -1].map((s): Foot => {
      const spot = FOOT_SPOTS[s === 1 ? 0 : 1];
      return {
        alpha: flat ? dir * Math.sign(spot.alpha) * Math.asin(Math.min(0.99, FOOT_LATERAL / base)) : dir * spot.alpha,
        along: dir * spot.worldX,
        side: s as 1 | -1,
      };
    }) as [Foot, Foot];
    // 两踝离栖面中心的平均高度（沿世界竖直；标架是纯偏航，局部 y 分量 = 世界 y 分量）。
    // 脚在栖面标架里的位置和鸟群原点无关：center + T·along + (U·cosα + S·sinα)·r——斜面上 center 沿 −n 退到 50 cm 外，
    // 这一项正好把它沿面内拉回触点 p 再抬 ANKLE_CLEAR；原点的 x / z 已经由 onLanded 钉在 p 上，这里只解 y。
    let hAvg = 0;
    for (const foot of feet) {
      const r = perch.surfaceRadius(foot.alpha, foot.along) + ANKLE_CLEAR;
      hAvg += t.y * foot.along + (up.y * Math.cos(foot.alpha) + side.y * Math.sin(foot.alpha)) * r;
    }
    if (place) rootPos.y = perch.center.y + hAvg / 2 - ANKLE_HEIGHT;
    const center = perch.center.clone().sub(rootPos).applyQuaternion(inv);
    this.bird.legRig.bind({ center, tangent: t.clone(), up: up.clone(), side: side.clone(), surfaceRadius: perch.surfaceRadius }, feet);
  }
}
