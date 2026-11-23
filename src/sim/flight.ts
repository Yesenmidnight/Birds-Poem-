/**
 * 飞行（阶段 4）。纯数学、零 three 依赖，Node 直接跑。
 *
 * 模型 = 点质量 + 姿态（航向 / 俯仰 / 坡度）：速度沿机体前向——鸟往哪指就往哪飞，速度大小按能量走
 *   dV/dt = 推力 − 阻力 − g·sin(俯仰)       爬升掉速、俯冲提速、松杆滑翔靠低头换速度
 * 失速：V < 失速速度时升不住——机头被压下、转向迟钝，直到速度回到失速速度以上（松杆俯冲就恢复了）。
 * 扑翼-收翼波浪（山雀的 flap-bounding）：按住扑翼时推力按 burst（扑翼）/ bound（收翼）交替；收翼时阻力小、身体略低头，
 * 一冲一沉就是标志性的波浪。滑翔 = 松开扑翼：翅膀张开不扑，身体自动略低头。
 * 转弯：压坡度（bank）→ 航向角速度 = g·tan(bank)/V（协调转弯），bank > 0 = 往左。
 * 着陆（2026-11-23 第二版：不用死按滑翔）：只要不在冲刺、不在起飞头 0.35 s、没主动拉满爬升，巡航 / 刹车靠近时每帧都探测——
 * 脚下当前点 + 前方短前瞻点各查一次（转弯时单点远前瞻会漏掉脚下的电线 / 细枝）；细枝 / 电线（CurvePerch）有 9 cm 的软磁吸：
 * 掠过它上方 / 前下方 9 cm 以内、下降角不陡就捕获。滑翔 / 刹车沿用原来更远的前瞻包络（captureBase + V·captureLead）。
 * 进 Landing Flare：展翅展尾刹车，位置从捕获点沿直线减速滑到刹停点（刹停点顺着切向动量前移 v_t/ω，时长 = 2 × 路径 / 空速、≤ 0.6 s，不提速），
 * 根离面够近（平面 1.5 cm / 枝 0.5 cm）就当帧落定交给 Locomotion；细枝 / 电线滑到点上站稳。
 * 平面（雪地 / 屋顶 / 汀步）飞行中碰到就当帧落定，切向余速交给步态急刹——不等 Flare（2026-11-23）。
 * 落点洁不洁只看躯干：刹停点上方躯干中心（沿法线抬高 bodyLift）有没有嵌进侧面竖墙 / 顶棚底面（ny < 0.35 且 dist < 0）；
 * 相邻的朝上可站立面（屋顶接缝的另一块板）、母子分叉枝、长椅下面的支撑盒一律放行（第一版 1 cm 内见到第二个面就拒落，
 * 屋顶接缝 / 树杈 / 栏杆全落不上）。
 * 碰撞：根（两脚之间那点）是 0 半径的质点，撞侧面会半个鸟身插进墙里——所以障碍物侧面 / 底面按躯干球算（bodyLift 上方、半径 bodyRadius；
 * 盒体 / 雪面 / 半径 ≥ bodyPerchMin 的粗枝树干；细枝 / 电线仍只按根算，不然庭院里飞一圈成了弹珠台）：
 * 躯干球进了面就把根推出来；子步推进跨过薄壁（躯干中心从一侧进到另一侧 / 埋进面里）时沿进入前那一侧的法线推回。
 * 法线朝上的面（平面即落、细枝当场捕获）仍按根算，不会被躯干球推开。
 * 撞侧面 / 底面：推出去、去掉法向速度，并且航向 / 俯仰一起脱困（escape）：斜擦顺着面的切线滑走；迎头按法线反射弹开回旋
 * （保底空速 + 短暂防失速，反射方向要是又怼进另一面墙就换开阔的切向——墙角 / 屋檐死角不能靠 grace 屏蔽掉头）；顶到底面低头掉出来。
 * 场地：逆风软边界（homeRadius 之外压坡带回 + 朝场地中心的边界风）+ 虚空兜底（掉出世界放回场上空）。
 * 每帧不分配：全部向量常驻。
 */
import { GRAVITY, lerpTo, Vec3 } from './math.ts';
import { clamp, smoothstep } from '../util/math.ts';
import { makeContact, type Contact } from './surface.ts';
import { CurvePerch, makeCurveFrame } from './curvePerch.ts';
import type { SimWorld } from './world.ts';

export interface FlightParams {
  /** 失速速度（厘米 / 秒）：8 g、翼面积 37 cm² 的山雀按 1.6 倍翼载荷的"悠闲档"取 240（2026-11-23 第二版：原 560 在庭院 / 花房里太快）。 */
  stallSpeed: number;
  /** 巡航速度：推力从这个速度开始收敛（thrustBand 内归零），到 maxSpeed 是俯冲硬上限。日常 390 cm/s（3.9 m/s）；平飞稳态的波浪落在 408~417（均衡点在带宽中点，见 thrustBand）。 */
  cruiseSpeed: number;
  /** 冲刺（boost = 1）时的巡航速度：700 cm/s（原来的一速档）；推力收敛的起点按 boost 在 cruiseSpeed ~ boostSpeed 之间插值。 */
  boostSpeed: number;
  /** 俯冲硬上限（厘米 / 秒）：超过就钳住（原来只拿它当推力归零点，垂直俯冲能冲到 1200）。 */
  maxSpeed: number;
  /**
   * 推力收敛的带宽（厘米 / 秒）：fade = 1 − smoothstep(cruise, cruise + band, V)，均衡空速 ≈ cruise + band / 2。
   * 80 → 平飞 428~438（比目标的 390 快一成）；20 → 398~406 但限速太硬，自动驾驶避障时撞 10 次、边界刹车回场段掉到 368；40 两头都好。
   */
  thrustBand: number;
  /** 扑翼冲刺的推力加速度（厘米 / 秒²），和起跳后发射阶段的推力。 */
  thrust: number;
  /** 冲刺推力加成：满冲刺时推力 × (1 + boostThrust)。 */
  boostThrust: number;
  launchThrust: number;
  /** 发射阶段时长（秒）：跃离栖面后这一段推力全额、不失速，把速度从一跳的 ~100 拉到失速速度以上。 */
  launchTime: number;
  /** 阻力加速度 = dragK·V² + inducedK / max(V, 0.7·Vs)²；收翼时乘 boundDragScale；刹车（展翅展尾）时乘 brakeDragScale。 */
  dragK: number;
  inducedK: number;
  boundDragScale: number;
  brakeDragScale: number;
  /** 扑翼 / 收翼一个周期的两段时长（秒）：连扑约 4 下（14 Hz × 0.3 s）再收翼滑跃一下，按两段时长配平波浪（净爬升为零）。 */
  burstTime: number;
  boundTime: number;
  /** 扑翼抬头、收翼低头的波浪幅度（弧度）：0.30 s × sin0.07 ≈ 0.13 s × sin0.16；滑翔时的自动低头角。 */
  burstPitch: number;
  boundPitch: number;
  glidePitch: number;
  /** 坡度上限（弧度）、滚转速率（弧度 / 秒）。 */
  maxBank: number;
  bankRate: number;
  /** 俯仰上限（弧度，拉杆 / 推杆）和速率（弧度 / 秒）。 */
  pitchUp: number;
  pitchDown: number;
  pitchRate: number;
  /** 失速时机头下沉的速率（弧度 / 秒，失速度 1 时）。 */
  stallDropRate: number;
  /**
   * 着陆捕获（滑翔 / 刹车）：探测点在前方 lookAhead 秒航程、再往下 lookDown cm 处；它离可落的面 ≤ captureBase + V·captureLead 才捕获，
   * 且速度 ≤ captureSpeed（俯冲要先拉杆减下来）。进了 Flare 后按捕获那一刻的路径长度定时（见 flareTime）。
   */
  captureBase: number;
  captureLead: number;
  flareOmega: number;
  captureSpeed: number;
  lookAhead: number;
  lookDown: number;
  /**
   * 巡航（扑翼中）的着陆探测：脚下点 + 前方 cruiseLookAhead 秒航程的点，离可落的平面 ≤ cruiseCapture、离细枝 / 电线（CurvePerch）
   * ≤ perchCapture 就捕获；细枝还要求下降角 < perchDiveMax（弧度）。冲刺 / 起飞头 0.35 s / 拉满爬升时不探。
   */
  cruiseLookAhead: number;
  cruiseCapture: number;
  perchCapture: number;
  perchDiveMax: number;
  /** 起飞后这么久（秒）内不做着陆探测：刚离地时栖面就在脚下。 */
  probeDelay: number;
  /** 冲刺量超过它就不做着陆探测（0..1）。 */
  probeBoostMax: number;
  /**
   * Flare 时长（秒）：= 2 × 路径长度 / 捕获空速，夹在 [flareTimeMin, flareTime]——这样减速滑的第一帧速度正好等于当前空速，
   * 到刹停点速度归零，不管捕获得多远都是干脆的一下（第一版用临界阻尼弹簧，最后几厘米要衰减 1 s 多，鸟张着翅膀在地上僵立）。
   * flareTime 上限 0.6 s（原 0.4）：慢飞时滑翔的前瞻捕获点在 100 多厘米外，0.4 s 滑完要第一帧就加速到 500 多、比捕获前还快；
   * 0.6 s 内 2L/V 都落得上，Flare 不会提速。flareTimeout 是硬超时（刹停点一直在动的兜底），与时长上限相同。
   */
  flareTimeMin: number;
  flareTime: number;
  flareTimeout: number;
  /** 落定门限（厘米）：Flare 里根离目标面这么近就当帧落定——平面 1.5、细枝 / 电线 0.5。 */
  touchDownFlat: number;
  touchDownPerch: number;
  /** 触地后根离面的余量（厘米）。 */
  landingClear: number;
  /** 扑翼频率（赫兹，表现层用；冲刺时平滑升到 boostFlapHz）和翅膀张开的平滑速率。 */
  flapHz: number;
  boostFlapHz: number;
  /** 躯干球：根上方 bodyLift 厘米处、半径 bodyRadius 厘米——障碍物侧面 / 底面的安全包络（法线朝上的可落面不按它推）。 */
  bodyLift: number;
  bodyRadius: number;
  /**
   * 躯干球只管半径 ≥ 这么粗的曲线栖木（粗枝 / 树干）和盒体 / 雪面；细枝 / 电线（0.05~0.5 cm）仍只按根算：
   * 从上方碰到就捕获，侧面擦到按根推出来顺面滑走。2.3 cm 的包络套在 0.5 cm 的电线上，庭院里飞一圈成了弹珠台，
   * 自动驾驶（按设计不躲细枝）90 s 里要撞十几次（2026-11-23）。
   */
  bodyPerchMin: number;
  /** 冲刺量 0..1 的平滑速率（1 / 秒）：按下 / 松开。 */
  boostRateUp: number;
  boostRateDown: number;
}

/**
 * 小型山雀的一套（2026-11-23 第二版：日常悠闲巡航 390、失速 240；Shift 冲刺回原来的 700，俯冲硬上限 1000 cm/s）。
 * 配平：dragK 0.0004 + inducedK 1.5e6 让平飞阻力在 240~700 之间单调上升（诱导阻力压到不足以在低速形成"推力墙"——
 * 第一版 inducedK 3.9e7 在 390 cm/s 时诱导阻力 256 cm/s²，推力 450 永远追不上，平飞均衡点被推到 700 以上）；
 * 推力 236 × 扑翼占空比 0.7 ≈ 165 cm/s²：平飞均衡点 ≈ 390~420（推力在 390~470 内收敛归零），300 cm/s 时余量 136 ≈ 8° 的持续爬升角。
 * 一跳 (~100 cm/s) 发射 0.6 s 到失速速度 240 以上。
 */
export const FLIGHT: FlightParams = {
  stallSpeed: 240,
  cruiseSpeed: 390,
  boostSpeed: 700,
  maxSpeed: 1000,
  thrustBand: 40,
  thrust: 236,
  boostThrust: 0.5,
  launchThrust: 1200,
  launchTime: 0.6,
  dragK: 0.0004,
  inducedK: 1.5e6,
  boundDragScale: 0.45,
  brakeDragScale: 3,
  burstTime: 0.3,
  boundTime: 0.13,
  burstPitch: 0.07,
  boundPitch: -0.16,
  glidePitch: -0.08,
  maxBank: 0.9,
  bankRate: 3,
  pitchUp: 0.45,
  pitchDown: 1,
  pitchRate: 2.5,
  stallDropRate: 2.2,
  captureBase: 4,
  captureLead: 0.06,
  flareOmega: 6,
  captureSpeed: 700,
  lookAhead: 0.3,
  lookDown: 1,
  cruiseLookAhead: 0.18,
  cruiseCapture: 10,
  perchCapture: 9,
  perchDiveMax: 0.9,
  probeDelay: 0.35,
  probeBoostMax: 0.3,
  flareTimeMin: 0.22,
  flareTime: 0.6,
  flareTimeout: 0.6,
  touchDownFlat: 1.5,
  touchDownPerch: 0.5,
  landingClear: 0.02,
  flapHz: 14,
  boostFlapHz: 18,
  bodyLift: 2.6,
  bodyRadius: 2.3,
  bodyPerchMin: 1.5,
  boostRateUp: 5,
  boostRateDown: 3,
};

/** 玩家意图：turn −1..1（+ = 往左压坡）、pitch −1..1（+ = 拉杆爬升）、flap = 按着扑翼（否则滑翔）、land = 主动要求着陆、
 *  boost = 冲刺（巡航速度 / 推力 / 扑翼频率升档，不做着陆探测）、climb = 玩家主动爬升（按住 W / 空格：不做着陆探测，靠近屋顶时拉起不会被抓下去）、
 *  noLand = 不做着陆探测（自动驾驶的巡航：它没有"想落"的概念，树冠里飞来飞去每帧探到脚下的细枝就会抓上去；撞到面 / 卡死探测照常落）。 */
export interface FlightIntent {
  turn: number;
  pitch: number;
  flap: boolean;
  land?: boolean;
  boost?: boolean;
  climb?: boolean;
  noLand?: boolean;
}

export type FlightPhase = 'fly' | 'flare' | 'landed';

/** 抛体子步上限（秒）：1000 cm/s 时每步 1.67 cm——躯干球包络 2 × 2.3 cm 厚，一步跨不过去，薄壁也不会被根（0 半径）一步穿过中心线。 */
const MAX_SUBSTEP = 1 / 600;
/** 落地面法线的最低朝上分量（和 Locomotion 一致）。 */
const MIN_NY = 0.4;
/**
 * 落点洁不洁：刹停点上方躯干中心（沿法线抬高 bodyLift）嵌进了"侧面竖墙 / 顶棚底面"（法线朝上分量 < BODY_BLOCK_NY、且离面 < BODY_EMBED）
 * 才算不能落。第一版是 1 cm 内见到任何第二个面就拒落——屋顶接缝的另一块板、树杈的母枝、长椅下面的支撑盒全落不上。
 * 朝上的面（另一块屋顶板）和细枝（母枝 / 分叉）不算：脚踩在哪块板上无所谓，躯干在它们上方。
 */
const BODY_BLOCK_NY = 0.35;
const BODY_EMBED = 0.5;
/** 撞侧面的门槛：法向撞击速度超过它才算撞（厘米 / 秒），贴着面滑过去的不算、也不掉速。 */
const SIDE_HIT_V = 60;
/** 放弃一次捕获后的冷却（秒）。 */
const RECAPTURE_DELAY = 0.35;
/**
 * 迎头撞的门槛：水平航向和法线水平分量（单位向量）的点积低于它（夹角 > 57°）算迎头——航向按法线反射弹开；
 * 否则算斜擦——航向顺着面的水平切线偏过去贴着滑走。
 */
const HEAD_ON_COS = -0.55;
/** 迎头弹开后的保底脱离空速（厘米 / 秒）：再低升不住、也飞不出墙角。 */
const ESCAPE_SPEED = 360;
/** 撞击后的防失速保护（秒）：弹开那一瞬空速掉到失速速度以下，这期间不失速（机头不被压下、舵效不减）；
 *  1.0 s 够扑翼从 360 加回失速速度 240 以上（推力 236 × 0.7 − 阻力 ~30 → +135 cm/s²）。 */
const BUMP_PROTECT = 1.0;
/**
 * 撞后宽限（秒）：碰过面之后这么久内再碰面只免掉速和计数（斜擦不掉速、迎头不累计 bumps），航向的脱困（斜擦顺切线 / 迎头反射）
 * 不受它屏蔽——第一版宽限期内连迎头反射也屏蔽，撞进双墙夹角 / 屋檐死角就在两面之间来回顶、掉速卡死。
 */
const GRACE_TIME = 0.35;
/** 迎头反射后的方向要是又怼进别的面（墙角）：探测前方 OPEN_PROBE 厘米处的离面距离，取反射方向 / 两个切向里最开阔的。 */
const OPEN_PROBE = 24;
/** 空速近零持续这么久（秒）算卡死：主动探测着陆。 */
const STUCK_TIME = 0.3;
/** 迎头弹开 / 斜擦蹭到的掉速系数。 */
const BOUNCE_SCALE = 0.6;
const GRAZE_SCALE = 0.85;
/** 法线朝下分量低于它算底面（屋檐下沿 / 枝底）：撞上就把机头压回负俯仰往下脱离。 */
const UNDERSIDE_NY = -0.3;
/** 矩形风墙的半边长 = homeRadius × 这个倍数（调试台 170 × 1.5 = 255：在雪地 ±280 之内，把楼 / 电线杆 / 长椅全围在里面，不和任何几何相交）。 */
const WALL_K = 1.5;
/** 贴墙偏置：碰着风墙的每一帧，航向额外朝场地中心偏这么多弧度。要盖过每帧墙的切线随鸟转动的量（520 cm/s 在 238 cm 墙上约 0.037），
 *  不然净内向分量被直线弦的外向分量抵消，鸟贴着墙滑着绕圈（0.05 时就是这样）。 */
const WALL_BIAS = 0.05;
/** 风墙上航向往墙里偏超过它才投影回切线（弧度）；近乎切线时不动航向，让偏置累积。 */
const WALL_PROJECT = 0.25;
/** 逆风阻力（厘米 / 秒²，满幅）：靠外圈朝外飞时按超出量和朝外程度加到阻力上。
 *  从 homeRadius 的 HEADWIND_FROM 倍起吃、到风墙（WALL_K 倍）吃满。第一版从 1.2 倍起：调试台 170 的场地 204 cm 以外就逆风，
 *  自动驾驶的环上景点（r 120~200）和大转弯全在这个圈里，空速常年 400~500、爬不动也转不动（2026-11-23）。 */
const HEADWIND_DRAG = 1500;
const HEADWIND_FROM = 1.35;
/** 根越出风墙这么多厘米以内才算撞墙（再远的 = 重置 / 传送出去的，不硬拽回来）。 */
const WALL_TOLERANCE = 25;

export class Flight {
  phase: FlightPhase = 'landed';
  /** 根（两脚之间的栖点）的位置和速度（世界）。 */
  readonly pos = new Vec3();
  readonly vel = new Vec3();
  /** 空速（厘米 / 秒）。 */
  speed = 0;
  /** 航向（水平单位向量）、俯仰（机头抬起为正，弧度）、坡度（往左压为正，弧度）。 */
  readonly heading = new Vec3(0, 0, -1);
  pitch = 0;
  bank = 0;
  /** 这一帧的实际俯仰（含扑翼 / 收翼的波浪起伏），表现层摆机体用。 */
  bodyPitch = 0;
  /** 冲刺量 0..1（按住 boost 平滑升、松开平滑降）：巡航速度 / 推力 / 扑翼频率按它插值；表现层拿去叠 FOV。 */
  boost = 0;
  /** 时间（秒）、发射阶段剩余 0..1、扑翼 / 收翼周期里的时间。 */
  t = 0;
  launch = 0;
  flapping = false;
  /** 失速度 0..1。 */
  stall = 0;
  /** 这一刻在刹车（滑翔时拉杆：展翅展尾猛减速，表现层摆刹车姿势用）。 */
  brake = false;
  /** 表现层：扑翼相位（弧度，按 flapHz 推进）、翅膀张开 0..1（收翼时合上，平滑）、尾羽扇开 0..1、腿伸出 0..1。 */
  flapPhase = 0;
  wingOpen = 0;
  tailSpread = 0;
  legsExtend = 0;
  /** Flare：捕获点（跟着面动）、进度 0..1。 */
  readonly target: Contact = makeContact();
  flareK = 0;
  /**
   * 本帧事件：捕获着陆完成（pos 停在面上）。landedSpeed = 触地时朝面里的法向速度；touchVel = 触地时的速度（平面触地即落时
   * 里面是剩下的切向余速，表现层拿去交给步态急刹 / 缓冲；Flare 滑到刹停点落定的接近零）。
   */
  landed = false;
  landedSpeed = 0;
  /** 这次落定是不是经过 Flare（false = 飞行中直接撞到平面上落的，触地速度可能大）。 */
  landedFlare = false;
  readonly touchVel = new Vec3();
  /** 统计：飞行中最深穿入（厘米）、碰撞次数。 */
  maxPen = 0;
  bumps = 0;
  /** 上一次撞到东西距今多久（秒；表现层拿来做镜头的小震动）。 */
  bumpT = 10;
  /**
   * 活动场地（逆风软边界）：离场地中心 (homeX, homeZ) 的水平距离超过 homeRadius 就被柔和地压坡带回场内，
   * 最外圈 WALL_K 倍半径是一圈按碰撞处理的风墙（谁也飞不出去）。0 = 关。
   */
  homeX = 0;
  homeZ = 0;
  homeRadius = 0;
  /**
   * 场地的 z 向半边长（厘米）：长方形的场地（庭院 27 m × 24 m）两轴各按各的半边长算超出比例；0 = 和 homeRadius 一样（正方形，调试台）。
   */
  homeRadiusZ = 0;
  /** 虚空兜底：掉到 voidY 以下，回到 (homeX, homeY, homeZ − 80) 重新平飞（发射期推力拉起来）。 */
  homeY = 100;
  voidY = -1e9;
  /** 本帧事件：被虚空兜底送回场上；统计：次数。 */
  respawned = false;
  respawns = 0;

  /** 参数公开：自动驾驶 / 表现层按同一套失速速度、巡航速度、躯干球尺寸算，不各抄一份常数。 */
  readonly params: FlightParams;
  private readonly contact: Contact = makeContact();
  private readonly lead: Contact = makeContact();
  /** 躯干球的接触（障碍物侧面 / 底面）和这一帧它有没有顶到东西。 */
  private readonly body: Contact = makeContact();
  /** settle 里反复推躯干球用的暂存（this.body 留着这一帧第一次顶到的那个面，escape 按它算）。 */
  private readonly bodyScratch: Contact = makeContact();
  private readonly bodyFrame = makeCurveFrame();
  private readonly wallC: Contact = makeContact();
  /** 风墙压回的点落在哪个面里（专用联络点）。 */
  private readonly wallProbe: Contact = makeContact();
  private readonly fwd = new Vec3();
  private readonly rest = new Vec3();
  private readonly tmp = new Vec3();
  private readonly tangent = new Vec3();
  /** 这一步走之前的位置：推不出面时就退回这里。 */
  private readonly prev = new Vec3();
  private readonly intent: FlightIntent = { turn: 0, pitch: 0, flap: false };
  private cycleT = 0;
  /** Flare 已经进行了多久（秒）：硬超时的兜底（刹停点一直在动的情况）。 */
  private flareT = 0;
  /** Flare 的起点（捕获那一刻的根位置）和时长（秒）：位置从起点沿直线减速滑到刹停点。 */
  private readonly flareFrom = new Vec3();
  private flareDur = 0.4;
  /** 放弃一次捕获后的冷却（秒）：期间不再捕获——不然贴着墙根的雪地会"捕获 → 撞墙放弃 → 再捕获"原地打转。 */
  private noCapture = 0;
  /** 撞击后的防失速保护剩余（秒）、撞后宽限剩余（秒）、空速近零的累计（秒）。 */
  private protect = 0;
  private grace = 0;
  private stuckT = 0;
  /** 起飞后着陆探测的等待剩余（秒）：从栖面跃出的起飞等 probeDelay（栖面就在脚下），半空里开始的直接探。 */
  private probeWait = 0;
  /** 这一帧已经做过贴墙偏置了。 */
  private wallBiased = false;

  constructor(params: FlightParams = FLIGHT) {
    this.params = params;
  }

  /** 从栖面跃出的那一跳接着起飞：pos / vel 是 Locomotion 离地时的，heading 是当时的水平朝向；launching = 走发射阶段（半空里接着飞就关掉）。 */
  start(pos: Vec3, vel: Vec3, headingX: number, headingZ: number, launching = true): void {
    this.pos.copy(pos);
    this.vel.copy(vel);
    this.speed = Math.max(vel.length(), 60);
    this.heading.set(headingX, 0, headingZ).normalize();
    // 起飞时的俯仰 = 这一跳的速度方向（斜向上）；发射阶段不许低头（跃离 0.1 s 后速度已经朝下，但起飞该是拉起来的样子）
    const h = Math.hypot(vel.x, vel.z);
    this.pitch = h > 1e-6 ? clamp(Math.atan2(vel.y, h), launching ? 0 : -0.3, 0.5) : 0.2;
    this.bank = 0;
    this.bodyPitch = this.pitch;
    this.boost = 0;
    this.phase = 'fly';
    this.t = 0;
    this.launch = launching ? 1 : 0;
    this.cycleT = 0;
    this.flapping = true;
    this.stall = 0;
    this.brake = false;
    this.flapPhase = 0;
    this.wingOpen = 1;
    this.tailSpread = 0.15;
    this.legsExtend = 0;
    this.flareK = 0;
    this.flareT = 0;
    this.noCapture = 0;
    this.protect = 0;
    this.grace = 0;
    this.stuckT = 0;
    this.probeWait = launching ? this.params.probeDelay : 0;
    this.wallBiased = false;
    this.bumpT = 10;
    this.landed = false;
    this.landedSpeed = 0;
    this.landedFlare = false;
    this.touchVel.set(0, 0, 0);
    this.maxPen = 0;
    this.bumps = 0;
  }

  update(dt: number, intent: FlightIntent, world: SimWorld): void {
    this.landed = false;
    this.respawned = false;
    if (this.phase === 'landed') return;
    const p = this.params;
    this.t += dt;
    this.bumpT += dt;
    this.protect = Math.max(0, this.protect - dt);
    this.grace = Math.max(0, this.grace - dt);
    this.wallBiased = false;
    this.intent.turn = clamp(intent.turn, -1, 1);
    this.intent.pitch = clamp(intent.pitch, -1, 1);
    this.intent.flap = intent.flap;
    this.intent.boost = intent.boost === true;
    this.intent.climb = intent.climb === true;
    this.intent.noLand = intent.noLand === true;
    this.noCapture = Math.max(0, this.noCapture - dt);
    if (this.phase === 'flare') {
      this.updateFlare(dt, world);
      return;
    }
    // 冲刺量平滑（按下快、松开慢一点，推背感和回落都不突兀）
    this.boost += ((this.intent.boost ? 1 : 0) - this.boost) * (1 - Math.exp(-(this.intent.boost ? p.boostRateUp : p.boostRateDown) * dt));
    if (this.boost < 1e-3) this.boost = 0;
    this.launch = Math.max(0, this.launch - dt / p.launchTime);
    const launching = this.launch > 0;
    // 刹车：滑翔时拉杆（展翅展尾猛减速，为着陆 / 抓枝用）；刹车时不掉失速低头
    this.brake = !this.intent.flap && !launching && this.intent.pitch > 0.3;

    // 扑翼 / 收翼周期：按着扑翼才有；发射阶段全程扑；松开 = 滑翔（翅膀张着不扑）
    const wantFlap = this.intent.flap || launching;
    if (wantFlap) {
      this.cycleT += dt;
      const period = p.burstTime + p.boundTime;
      this.cycleT %= period;
      this.flapping = this.cycleT < p.burstTime || launching;
    } else {
      this.cycleT = 0;
      this.flapping = false;
    }
    // 逆风软边界：离场地中心超过 homeRadius 就按超出量朝场地中心压坡（最多九成舵，玩家硬顶也只能顶回一小截）；
    // 最外圈 WALL_K 倍半径是一圈风墙，按碰撞处理（hit 里：永远顺墙滑走 + 每帧朝中心偏一点航向）。
    // 试过"朝中心的位置漂移当风"：风速和空速同量级时地面轨迹被风主导，鸟贴着风墙冲浪打转、不往回飞（2026-11-23）
    let turn = clamp(this.intent.turn + this.boundaryTurn(), -1, 1);
    // 虚空兜底：掉出世界，放回场上空
    if (this.homeRadius > 0 && this.pos.y < this.voidY) this.respawn();
    // 姿态：坡度、俯仰朝目标过渡；失速时舵效减半、机头被压下（撞击后的保护期内不失速）
    const authority = 1 - 0.7 * this.stall;
    const bankTarget = turn * p.maxBank;
    this.bank += clamp(bankTarget - this.bank, -p.bankRate * dt * authority, p.bankRate * dt * authority);
    let pitchTarget = this.intent.pitch >= 0 ? this.intent.pitch * p.pitchUp : this.intent.pitch * p.pitchDown;
    if (!wantFlap && Math.abs(this.intent.pitch) < 0.1) pitchTarget = p.glidePitch;
    if (launching) pitchTarget = Math.min(pitchTarget, 0.3);
    this.pitch += clamp(pitchTarget - this.pitch, -p.pitchRate * dt * authority, p.pitchRate * dt * authority);
    if (!this.brake) this.pitch -= p.stallDropRate * this.stall * dt;
    // 波浪：扑翼抬头、收翼低头（平滑过渡，别硬跳）
    const wave = this.flapping ? p.burstPitch : wantFlap ? p.boundPitch : 0;
    this.bodyPitch += (this.pitch + wave - this.bodyPitch) * (1 - Math.exp(-18 * dt));

    // 航向：协调转弯，航向角速度 = g·tan(bank)/V
    const yawRate = (GRAVITY * Math.tan(this.bank)) / Math.max(this.speed, 0.5 * p.stallSpeed) * authority;
    if (yawRate !== 0) {
      const th = yawRate * dt;
      const c = Math.cos(th);
      const s = Math.sin(th);
      const hx = this.heading.x;
      const hz = this.heading.z;
      this.heading.set(hx * c + hz * s, 0, -hx * s + hz * c).normalize();
    }

    // 能量：推力（发射全额；巡航以上 thrustBand 内收敛归零——冲刺把收敛起点推到 boostSpeed、推力再加成）− 阻力（收翼小、刹车大）− 重力沿路径的分量
    const cruise = p.cruiseSpeed + (p.boostSpeed - p.cruiseSpeed) * this.boost;
    const fade = 1 - smoothstep(cruise, cruise + p.thrustBand, this.speed);
    let thrust = this.flapping ? p.thrust * (1 + p.boostThrust * this.boost) * fade : 0;
    if (launching) thrust = p.launchThrust * (0.5 + 0.5 * fade);
    const vInd = Math.max(this.speed, 0.7 * p.stallSpeed);
    const dragScale = this.brake ? p.brakeDragScale : wantFlap && !this.flapping ? p.boundDragScale : 1;
    let drag = (p.dragK * this.speed * this.speed + p.inducedK / (vInd * vInd)) * dragScale;
    // 逆风：靠外圈（homeRadius 的 HEADWIND_FROM 倍以外）又朝外飞时额外吃阻力——空速掉下来，转弯角速度才追得上风墙的曲率，
    // 不然满舵也只能贴着墙滑（墙推着走、航向拗不回来）；朝里飞不吃
    if (this.homeRadius > 0) {
      const rx = this.pos.x - this.homeX;
      const rz = this.pos.z - this.homeZ;
      const r = Math.hypot(rx, rz);
      const over = this.boundaryOver();
      if (over > HEADWIND_FROM && r > 1e-6) {
        const k = Math.min(1, (over - HEADWIND_FROM) / (WALL_K - HEADWIND_FROM));
        drag += HEADWIND_DRAG * k * Math.max(0, (this.heading.x * rx + this.heading.z * rz) / r);
      }
    }
    this.speed = clamp(this.speed + (thrust - drag - GRAVITY * Math.sin(this.bodyPitch)) * dt, 0, p.maxSpeed);
    this.stall = launching || this.protect > 0 ? 0 : 1 - smoothstep(0.75 * p.stallSpeed, 0.9 * p.stallSpeed, this.speed);

    // 位置：沿机体前向走，子步查碰撞
    const cp = Math.cos(this.bodyPitch);
    this.fwd.set(this.heading.x * cp, Math.sin(this.bodyPitch), this.heading.z * cp);
    this.vel.copy(this.fwd).scale(this.speed);
    let remaining = dt;
    while (remaining > 1e-9) {
      const h = Math.min(remaining, MAX_SUBSTEP);
      remaining -= h;
      this.prev.copy(this.pos);
      this.pos.addScaled(this.vel, h);
      if (this.hit(world)) break;
    }

    if (this.phase !== 'fly') return;
    // 表现量：扑翼相位（冲刺 14 → 18 Hz）、翅膀开合、尾扇、腿
    if (this.flapping) this.flapPhase += (p.flapHz + (p.boostFlapHz - p.flapHz) * this.boost) * Math.PI * 2 * dt;
    const openTarget = this.flapping || !wantFlap ? 1 : 0;
    this.wingOpen += (openTarget - this.wingOpen) * (1 - Math.exp(-30 * dt));
    const tailTarget = this.brake ? 0.5 : 0.15;
    this.tailSpread += (tailTarget - this.tailSpread) * (1 - Math.exp(-20 * dt));

    const stuck = this.stuckT > STUCK_TIME;
    // 着陆探测（2026-11-23 第二版）：巡航 / 刹车 / 滑翔靠近时每帧都探（脚下 + 前方短前瞻），不再只在手动滑翔时探——
    // 平时正常飞向电线 / 树枝 / 路灯 / 屋顶也能抓住落点。不探的四种情况：冲刺中（probeBoostMax）、起飞头 probeDelay 秒（栖面就在脚下）、
    // 玩家主动拉满爬升（climb：按住 W / 空格想越过屋顶时不被抓下去）、自动驾驶（noLand：它没有想落的概念）
    // 卡死探测：空速几乎为零还在飞（撞完贴在墙根 / 楼角，推力抵不过阻力、永远加速不起来）超过 STUCK_TIME 秒就主动探测着陆，
    // 落得下去就落（地面 / 屋顶），不然会悬在那儿一动不动
    this.stuckT = this.speed < 40 ? this.stuckT + dt : 0;
    this.probeWait = Math.max(0, this.probeWait - dt);
    const probing = !this.intent.noLand && !this.intent.boost && this.boost < p.probeBoostMax && this.probeWait <= 0 && !this.intent.climb;
    if (this.intent.land || stuck || probing) this.probeLanding(world);
  }

  /** 飞行中碰到面：法线朝上且落点干净 → 平面（雪地 / 屋顶 / 汀步）触地即落、细枝 / 电线当场捕获（进 Flare）；
   * 否则推出去、去掉法向速度——真撞上侧面才掉一截速度。返回 true = 本帧不再走位置。
   *  根（0 半径）只管"法线朝上的面碰到就落"；障碍物的侧面 / 底面按躯干球算（pushBody），半个鸟身不会插进墙里。 */
  private hit(world: SimWorld): boolean {
    const p = this.params;
    const c = this.contact;
    world.closest(this.pos.x, this.pos.y, this.pos.z, c);
    let rootIn = c.surface !== null && c.dist < 0;
    if (rootIn) {
      this.maxPen = Math.max(this.maxPen, -c.dist);
      const up = c.ny >= MIN_NY && this.speed <= p.captureSpeed * 1.6 && this.noCapture <= 0;
      if (up && !(c.surface instanceof CurvePerch)) {
        // 平面触地即落（2026-11-23 用户要求：巡飞中压低机头撞地，原来要进 Flare 张着翅膀等弹簧衰减）：
        // 根推回面上、切向余速留给步态急刹 / 缓冲；推不干净（面和面叠在一起）就按下面的老路走。
        // 落点不干净（躯干嵌在墙里 / 顶棚里）也不当场落：步态的 place 会查到墙的侧面、落不住又原地再起飞，来回打转——
        // 交给下面 Flare 的同一套洁净检查去拒绝，鸟蹭一下接着飞
        if (this.landingClean(world, c) && this.landNow(world)) return true;
      } else if (up) {
        if (this.beginFlare(c, world)) {
          // 当场捕获：先把根推回面上方（不然 Flare 从面里起步，下一帧的穿入统计就是它）；墙根处还要再推出墙
          this.pos.addScaled(this.tmp.set(c.nx, c.ny, c.nz), -c.dist + p.landingClear);
          if (this.settle(world, false)) return true;
          // 推不出去（面和面叠在一起）：放弃这次捕获，按障碍物处理（下面会按 c 的法线抬头）
          this.abortFlare();
        }
      }
      // 冲刺 / 冷却中撞上细枝（up = false）：不当场捕获，根已经埋进枝里——下面按障碍物推出来（细枝的 ny 朝上，escape 会抬头）
    }
    // 障碍物：躯干球顶到侧面 / 底面 / 细枝，或者根埋在面里（落点不干净的朝上面、冷却中的细枝、躯干球够不着的矮台阶）
    const bodyHit = this.pushBody(world, this.body);
    world.closest(this.pos.x, this.pos.y, this.pos.z, c);
    rootIn = c.surface !== null && c.dist < 0;
    if (!bodyHit && !rootIn) {
      // 没碰着世界的面，再看风墙（两个都查：贴着地面滑到风墙上时，地面的穿入要先处理）
      if (this.homeRadius > 0) this.hitWindWall(world);
      return false;
    }
    const hitC = bodyHit ? this.body : c;
    const vn = this.vel.x * hitC.nx + this.vel.y * hitC.ny + this.vel.z * hitC.nz;
    if (rootIn) this.pushOut(c);
    // 推不干净（楔进两面交界）= 退回这一步之前：这时不管航向是不是明显朝面里，都按迎头处理（强制转向开阔方向 + 保底空速）
    const wedged = !this.settle(world, true);
    // 航向 / 俯仰也要脱困：光推开位置，下一帧还按旧航向怼回墙里（卡死在面上的根因）。
    // 撞后宽限只免掉速和计数，航向的脱困（斜擦顺切线 / 迎头反射）不受它屏蔽——墙角靠它出来
    this.escape(hitC, vn, world, wedged);
    this.grace = GRACE_TIME;
    return false;
  }

  /**
   * 躯干球（根上方 bodyLift、半径 bodyRadius）顶到了障碍物（侧面 / 底面 / 细枝 / 树干）：把根推到躯干球脱离为止，去掉朝面里的速度分量。
   * 返回 true = 顶到了（接触写进 out）。躯干中心埋在面里时（一步跨过薄壁的中心线 / 多面交界），closest 给的可能是进入侧对面那一面、
   * 按它推会把鸟推到墙的另一头——改按这一步之前的躯干中心问同一个面，之前在体外就沿进入侧的法线推回进入侧。
   */
  private pushBody(world: SimWorld, out: Contact): boolean {
    const p = this.params;
    const r = p.bodyRadius;
    const bx = this.pos.x;
    const by = this.pos.y + p.bodyLift;
    const bz = this.pos.z;
    world.closest(bx, by, bz, out);
    if (out.surface === null || out.dist >= r) return false;
    // 细枝 / 电线不按躯干球算（见 bodyPerchMin）：交给根（从上方碰到 = 捕获，侧面 = 推出来顺面滑走）
    if (out.surface instanceof CurvePerch && out.surface.frameAt(out.u, this.bodyFrame).radius < p.bodyPerchMin) return false;
    // 推到 r + ε 外：刚好推到 r 的话下一次 closest 可能回 2.2999999，又被当成顶到、settle 推四轮都"不干净"误判成楔住
    let nx = out.nx;
    let ny = out.ny;
    let nz = out.nz;
    if (out.dist < 0) {
      const l = this.lead;
      out.surface.closest(this.prev.x, this.prev.y + p.bodyLift, this.prev.z, l);
      if (l.dist >= 0) {
        // 进入侧的面外 r 处
        this.pos.x += l.px + l.nx * (r + 1e-4) - bx;
        this.pos.y += l.py + l.ny * (r + 1e-4) - by;
        this.pos.z += l.pz + l.nz * (r + 1e-4) - bz;
        nx = l.nx;
        ny = l.ny;
        nz = l.nz;
        this.copyContact(l, out);
      } else {
        const push = r - out.dist + 1e-4;
        this.pos.x += nx * push;
        this.pos.y += ny * push;
        this.pos.z += nz * push;
      }
    } else {
      const push = r - out.dist + 1e-4;
      this.pos.x += nx * push;
      this.pos.y += ny * push;
      this.pos.z += nz * push;
    }
    const vn = this.vel.x * nx + this.vel.y * ny + this.vel.z * nz;
    if (vn < 0) {
      this.vel.x -= nx * vn;
      this.vel.y -= ny * vn;
      this.vel.z -= nz * vn;
    }
    return true;
  }

  /**
   * 撞侧面 / 底面之后的脱困（表现上就是真鸟的"擦着滑走 / 碰壁弹开回旋 / 顶到屋檐低头掉出来"）：
   *  - 迎头（水平航向和法线的水平分量夹角 > 57°，或楔住了）：航向按法线反射弹开，反射方向又怼进别的面（双墙夹角 / 屋檐死角）
   *    就换成开阔的切向；速度掉一截但保底 ESCAPE_SPEED，并给 BUMP_PROTECT 秒防失速保护（弹开那一瞬空速多半在失速速度以下，不让机头被压下去）；
   *  - 斜擦：航向顺着面的水平切线偏过去，贴着面滑走（法向撞击够快才掉一点速）；
   *  - 底面（屋檐下沿 / 枝底）：机头压回负俯仰往下脱离；朝上却没捕获的面（墙根 / 冷却中）：弹起来一点。
   * world = null 是风墙：永远顺着墙滑走（风墙是软的，迎头弹开会掉到失速速度），也不给反射 / 换方向。
   */
  private escape(c: Contact, vn: number, world: SimWorld | null, forced = false): void {
    this.bumpT = 0;
    const hx = this.heading.x;
    const hz = this.heading.z;
    const nh = Math.hypot(c.nx, c.nz);
    const wall = world === null;
    if (nh > 1e-6) {
      const ux = c.nx / nh;
      const uz = c.nz / nh;
      const d = hx * ux + hz * uz;
      if (!wall && (d < HEAD_ON_COS || (forced && d < 0))) {
        let rx = hx - 2 * d * ux;
        let rz = hz - 2 * d * uz;
        const rl = Math.hypot(rx, rz);
        if (rl > 1e-6) {
          rx /= rl;
          rz /= rl;
        } else {
          rx = ux;
          rz = uz;
        }
        if (world !== null) {
          const open = this.openHeading(rx, rz, ux, uz, world);
          rx = open[0];
          rz = open[1];
        }
        this.heading.set(rx, 0, rz);
        this.speed = Math.max(this.speed * (this.grace > 0 ? 1 : BOUNCE_SCALE), ESCAPE_SPEED);
        this.protect = BUMP_PROTECT;
        this.bumps++;
      } else if (d < (wall ? -WALL_PROJECT : 0)) {
        // 风墙上近乎切线时不投影：只推位置，让贴墙偏置逐帧累积把鸟带离墙（每帧都投回切线的话净内向分量是零，鸟跟着墙绕圈）
        this.heading.set(hx - d * ux, 0, hz - d * uz).normalize();
        if (!wall && vn < -SIDE_HIT_V && this.grace <= 0) this.speed *= GRAZE_SCALE;
      }
    }
    if (c.ny < UNDERSIDE_NY) {
      this.pitch = Math.min(this.pitch, -0.2);
      this.bodyPitch = Math.min(this.bodyPitch, -0.08);
      this.protect = Math.max(this.protect, 0.3);
    } else if (c.ny >= MIN_NY) {
      this.pitch = Math.max(this.pitch, 0.15);
      this.bodyPitch = Math.max(this.bodyPitch, 0.1);
    }
  }

  private readonly openV: [number, number] = [0, 0];
  /**
   * 迎头反射后的方向 (rx, rz) 要是又怼进别的面（撞进双墙夹角 / 屋檐死角，下一帧又得弹回来、在两面之间来回顶）：
   * 在"反射方向 / 这面墙的两条水平切向"里挑前方 OPEN_PROBE 厘米处离面最远的那个（朝这面墙里去的不要）。
   */
  private openHeading(rx: number, rz: number, ux: number, uz: number, world: SimWorld): [number, number] {
    const q = this.lead;
    let best = -Infinity;
    let bx = rx;
    let bz = rz;
    for (let k = 0; k < 3; k++) {
      const dx = k === 0 ? rx : k === 1 ? -uz : uz;
      const dz = k === 0 ? rz : k === 1 ? ux : -ux;
      if (dx * ux + dz * uz < -0.05) continue;
      world.closest(this.pos.x + dx * OPEN_PROBE, this.pos.y, this.pos.z + dz * OPEN_PROBE, q);
      const clear = (q.surface === null ? 99 : q.dist) - k * 1e-3;
      if (clear > best) {
        best = clear;
        bx = dx;
        bz = dz;
      }
    }
    this.openV[0] = bx;
    this.openV[1] = bz;
    return this.openV;
  }

  /** 虚空兜底：放回场上空、朝着场地中心平飞（发射期推力拉起来，不让它从失速里起步）。 */
  private respawn(): void {
    const dx = this.homeX - this.pos.x;
    const dz = this.homeZ - this.pos.z;
    const r = Math.hypot(dx, dz);
    const v = this.params.cruiseSpeed;
    this.pos.set(this.homeX, this.homeY, this.homeZ - 80);
    if (r > 1e-6) this.heading.set(dx / r, 0, dz / r);
    this.speed = v;
    this.pitch = 0.15;
    this.bodyPitch = 0.15;
    this.bank = 0;
    this.launch = 1;
    this.protect = 0.5;
    this.noCapture = 0;
    this.vel.set(this.heading.x * v, 0, this.heading.z * v);
    this.respawns++;
    this.respawned = true;
  }

  /**
   * 逆风软边界这一帧会给玩家意图加多少舵（−1..1）：离场地中心超过 homeRadius 就按超出量朝场地中心压坡，1.3 倍处满舵。
   * 公开给自动驾驶：它想直飞时把这份加成减掉，不然会被边界带着转圈。
   */
  boundaryTurn(): number {
    if (this.homeRadius <= 0) return 0;
    const dx = this.pos.x - this.homeX;
    const dz = this.pos.z - this.homeZ;
    // 到矩形场边的"超出比例"：两个轴里大的那个（1 = 正好在 homeRadius 的边上）
    const over = this.boundaryOver();
    if (over <= 1) return 0;
    const k = Math.min(1, (over - 1) / 0.3);
    let e = Math.atan2(-dx, -dz) - Math.atan2(this.heading.x, this.heading.z);
    e = Math.atan2(Math.sin(e), Math.cos(e));
    // 满舵（不是九成）：515 cm/s 时坡度 0.81 的转弯角速度 2.0 rad/s 追不上场边的曲率，满舵 0.9 才追得上
    return Math.abs(e) > 0.1 ? Math.sign(e) * k : 0;
  }

  /** 场地两轴的半边长（厘米）：x = homeRadius，z = homeRadiusZ（0 = 和 x 一样）。 */
  get halfX(): number {
    return this.homeRadius;
  }
  get halfZ(): number {
    return this.homeRadiusZ > 0 ? this.homeRadiusZ : this.homeRadius;
  }
  /** 到矩形场边的超出比例（两轴里大的那个；1 = 正好在边上；homeRadius = 0 时恒为 0）。公开给自动驾驶用同一口径。 */
  boundaryOver(x = this.pos.x, z = this.pos.z): number {
    if (this.homeRadius <= 0) return 0;
    return Math.max(Math.abs(x - this.homeX) / this.halfX, Math.abs(z - this.homeZ) / this.halfZ);
  }

  /** 矩形风墙的半边长（厘米）：homeRadius × WALL_K；homeRadius = 0 时为 0。 */
  get wallHalf(): number {
    return this.homeRadius * WALL_K;
  }
  /** 矩形风墙两轴各自的半边长（z 向按 homeRadiusZ）。 */
  get wallHalfX(): number {
    return this.halfX * WALL_K;
  }
  get wallHalfZ(): number {
    return this.halfZ * WALL_K;
  }

  /**
   * 场地最外圈的风墙（homeRadius·WALL_K 的圆柱面，法线朝场地中心）：根越过去就压回墙上、去掉朝外的速度，
   * 航向按 escape 脱困——永远顺着墙滑走（风墙是软的，迎头弹开会掉到失速速度）。返回 true = 撞上了。
   * 风墙会穿过场地里的大东西（调试台的小楼、雪地边缘、树冠外围）：压回墙上的点要是埋在别的面里，就不挪位置、只消朝外的速度
   * （挪进去再推出来会被两个面夹住钉死）。在墙外超过 WALL_TOLERANCE 的不算撞墙（重置 / 传送出去的），不硬拽。
   */
  private hitWindWall(world: SimWorld): boolean {
    if (this.homeRadius <= 0) return false;
    const dx = this.pos.x - this.homeX;
    const dz = this.pos.z - this.homeZ;
    const wallX = this.wallHalfX;
    const wallZ = this.wallHalfZ;
    // 哪一面越界了（两个轴都越了取超得多的那个）
    const ox = Math.abs(dx) - wallX;
    const oz = Math.abs(dz) - wallZ;
    if (ox <= 0 && oz <= 0) return false;
    const useX = ox >= oz;
    if ((useX ? ox : oz) > WALL_TOLERANCE) return false;
    // 用 wallC 这份联络点存风墙的法线（contact 会被别的查询覆盖）：朝场地中心
    const c = this.wallC;
    c.nx = useX ? -Math.sign(dx) : 0;
    c.ny = 0;
    c.nz = useX ? 0 : -Math.sign(dz);
    c.dist = useX ? -ox : -oz;
    // 压回墙上的点要是埋在楼 / 树枝里：不挪位置，只消掉朝外的速度——挪进去再被那个面推出来，鸟会被两个面夹住钉死
    const px = useX ? this.homeX + Math.sign(dx) * wallX : this.pos.x;
    const pz = useX ? this.pos.z : this.homeZ + Math.sign(dz) * wallZ;
    world.closest(px, this.pos.y, pz, this.wallProbe);
    if (!(this.wallProbe.surface !== null && this.wallProbe.dist < 0)) {
      this.pos.x = px;
      this.pos.z = pz;
    }
    const vn = this.vel.x * c.nx + this.vel.z * c.nz;
    if (vn < 0) {
      this.vel.x -= c.nx * vn;
      this.vel.z -= c.nz * vn;
    }
    this.escape(c, vn, null);
    // 贴墙偏置（每帧一次）：航向再朝场地中心偏一点（圆墙时代是为了追上墙的曲率；矩形墙上它是顺墙滑走时的柔和回正）
    if (!this.wallBiased) {
      this.wallBiased = true;
      let e = Math.atan2(c.nx, c.nz) - Math.atan2(this.heading.x, this.heading.z);
      e = Math.atan2(Math.sin(e), Math.cos(e));
      const th = clamp(e, -WALL_BIAS, WALL_BIAS);
      const cs = Math.cos(th);
      const sn = Math.sin(th);
      const hx = this.heading.x;
      const hz = this.heading.z;
      this.heading.set(hx * cs + hz * sn, 0, -hx * sn + hz * cs).normalize();
    }
    return true;
  }

  /**
   * 把根推到所有面之外（withBody 时躯干球也要脱离侧面 / 底面），返回 true = 推干净了。穿入检测一次只报最深的面，墙根的雪地和墙同时穿入时
   * 一轮只推得动一个；两个面叠在一起（建筑体的底和雪堆）推几次都会被推回另一个面里——那就退回这一步之前的位置（那里一定在外面）。
   * 落定 / Flare 里只推根（落点已经查过躯干不嵌墙；躯干球离旁边的墙近一点不该把落点推开）。
   */
  private settle(world: SimWorld, withBody: boolean): boolean {
    const scratch = this.bodyScratch;
    for (let i = 0; i < 4; i++) {
      const bodyHit = withBody && this.pushBody(world, scratch);
      const rootIn = this.penetrated(world);
      if (!bodyHit && !rootIn) return true;
      if (rootIn) this.pushOut(this.contact);
    }
    if (!(withBody && this.pushBody(world, scratch)) && !this.penetrated(world)) return true;
    this.pos.copy(this.prev);
    return false;
  }

  /** 根这一步穿进了哪个面：写进 contact、返回 true。closest 给的是有符号距离最小的面，只要在任何一个面里就一定 < 0（任何深度）。 */
  private penetrated(world: SimWorld): boolean {
    const c = this.contact;
    world.closest(this.pos.x, this.pos.y, this.pos.z, c);
    return c.surface !== null && c.dist < 0;
  }

  /** 推出面、去掉法向速度。掉速 / 改航向都在 escape 里（推干净之后按原来撞上的那个面算）。 */
  private pushOut(c: Contact): void {
    const nx = c.nx;
    const ny = c.ny;
    const nz = c.nz;
    this.pos.x += nx * (-c.dist + 1e-4);
    this.pos.y += ny * (-c.dist + 1e-4);
    this.pos.z += nz * (-c.dist + 1e-4);
    const vn = this.vel.x * nx + this.vel.y * ny + this.vel.z * nz;
    if (vn < 0) {
      this.vel.x -= nx * vn;
      this.vel.y -= ny * vn;
      this.vel.z -= nz * vn;
    }
  }

  /** 放弃这次捕获：回到飞行，冷却 RECAPTURE_DELAY 秒内不再捕获。 */
  private abortFlare(): void {
    this.phase = 'fly';
    this.launch = 0;
    this.noCapture = RECAPTURE_DELAY;
  }

  /**
   * 触地落定（平面触地即落 / Flare 滑到面旁）：contact 是根碰到 / 贴着的那个面——把根推回它上方 landingClear 处
   * （推不干净 = 面和面叠在一起，退回这一步之前，返回 false），朝面里的法向速度记为触地速度，
   * 剩下的切向速度留在 vel / touchVel 里交给步态（急刹 / 缓冲）。
   */
  private landNow(world: SimWorld): boolean {
    const p = this.params;
    const c = this.contact;
    const nx = c.nx;
    const ny = c.ny;
    const nz = c.nz;
    const vn = this.vel.x * nx + this.vel.y * ny + this.vel.z * nz;
    this.landedSpeed = Math.max(0, -vn);
    this.landedFlare = this.phase === 'flare';
    this.pos.x += nx * (-c.dist + p.landingClear);
    this.pos.y += ny * (-c.dist + p.landingClear);
    this.pos.z += nz * (-c.dist + p.landingClear);
    if (!this.settle(world, false)) return false;
    if (vn < 0) {
      this.vel.x -= nx * vn;
      this.vel.y -= ny * vn;
      this.vel.z -= nz * vn;
    }
    this.touchVel.copy(this.vel);
    this.speed = this.vel.length();
    this.phase = 'landed';
    this.landed = true;
    this.flareK = 1;
    return true;
  }

  /**
   * 探测可落的面（两点）：① 前方 lookAhead 秒航程（滑翔 / 刹车）或 cruiseLookAhead 秒航程（巡航扑翼）、再往下 lookDown cm 处；
   * ② 脚下当前点（再往下 lookDown 的一半）——转弯 / 侧向掠过时远前瞻点已经飞过电线了，脚下这点还在它上方，单点远前瞻会漏掉。
   * 捕获范围：平面 = 滑翔 / 刹车 captureBase + V·captureLead（原来的包络，想落的时候好落）、巡航 cruiseCapture；
   * 细枝 / 电线两种模式都是 perchCapture（9 cm 软磁吸——0 半径质点硬撞 0.6 cm 的电线太难了；滑翔时给到几十厘米的话
   * 一滑就被旁边的树梢吸走），巡航中还要求下降角 < perchDiveMax（俯冲太陡先拉杆减下来再抓）。速度 ≤ captureSpeed。
   */
  private probeLanding(world: SimWorld): void {
    const p = this.params;
    if (this.speed > p.captureSpeed || this.noCapture > 0) return;
    const glide = !this.intent.flap;
    const dive = Math.atan2(-this.vel.y, Math.hypot(this.vel.x, this.vel.z));
    for (let k = 0; k < 2; k++) {
      const c = this.contact;
      const ahead = k === 0 ? (glide ? p.lookAhead : p.cruiseLookAhead) : 0;
      const down = k === 0 ? p.lookDown : p.lookDown * 0.5;
      world.closest(this.pos.x + this.vel.x * ahead, this.pos.y + this.vel.y * ahead - down, this.pos.z + this.vel.z * ahead, c);
      // 探测点必须在体外：埋在楼里时 closest 给的是最近的那一面（往往是屋顶，法线朝上、距离为负），会被当成"屋顶就在脚下"抓上去
      if (c.surface === null || c.ny < MIN_NY || c.dist < 0) continue;
      const perch = c.surface instanceof CurvePerch;
      const limit = perch ? p.perchCapture : glide ? p.captureBase + this.speed * p.captureLead : p.cruiseCapture;
      if (perch && dive > p.perchDiveMax) continue;
      if (c.dist > limit) continue;
      if (this.beginFlare(c, world)) return;
    }
  }

  /**
   * 进 Landing Flare。捕获点是面上的一点；刹停点顺着切向动量往前送 |v_t|/ω（滑翔抓枝时顺着枝 / 线往前滑一段再停）。
   * 送出去的点贴回同一个面（细枝 / 电线送出末端就不送）。刹停点不干净（躯干嵌在墙里 / 顶棚里，见 landingClean）就不是能落的地方
   * （雪地贴着墙根：closest 只看见最近的雪面，软磁吸会把鸟拽进墙里）：返回 false，调用方按没捕获处理。
   * Flare 时长 = 2 × 路径长度 / 捕获空速（夹在 [flareTimeMin, flareTime]）：减速滑的第一帧速度正好等于当前空速。
   */
  private beginFlare(c: Contact, world: SimWorld): boolean {
    const p = this.params;
    this.copyContact(c, this.target);
    const surface = this.target.surface;
    if (surface === null) return false;
    // 捕获点在风墙外（滑翔中探测点越过风墙、落到了墙外的雪地上）：软磁吸不能把鸟拽过墙
    if (this.homeRadius > 0 && this.boundaryOver(c.px, c.pz) > WALL_K) return false;
    // 切向速度（去掉法向分量）→ 刹停点前移 v_t/ω
    const nx = c.nx;
    const ny = c.ny;
    const nz = c.nz;
    const vn = this.vel.x * nx + this.vel.y * ny + this.vel.z * nz;
    this.tangent.set(this.vel.x - nx * vn, this.vel.y - ny * vn, this.vel.z - nz * vn).scale(1 / p.flareOmega);
    if (this.tangent.length() > 0.3) {
      const l = this.lead;
      surface.closest(c.px + this.tangent.x, c.py + this.tangent.y, c.pz + this.tangent.z, l);
      if (l.surface === surface && l.ny >= MIN_NY) this.copyContact(l, this.target);
    }
    this.rest.set(this.target.px + this.target.nx * p.landingClear, this.target.py + this.target.ny * p.landingClear, this.target.pz + this.target.nz * p.landingClear);
    // 直线滑行的路径中途不能先扎进同一个面（脚下点捕获时刹停点顺着动量送出去几十厘米，中间隔着一道雪垄 / 屋顶的波峰）：
    // 采样路径上几点，第一个贴到目标面的点改当刹停点——不然 Flare 滑到一半穿进雪垄，只能按全速触地（随机压测里 400 cm/s 的"Flare 着陆"）
    for (let k = 1; k <= 4; k++) {
      const s = k * 0.2;
      const l = this.lead;
      surface.closest(this.pos.x + (this.rest.x - this.pos.x) * s, this.pos.y + (this.rest.y - this.pos.y) * s, this.pos.z + (this.rest.z - this.pos.z) * s, l);
      if (l.surface === surface && l.dist < 0.5) {
        this.copyContact(l, this.target);
        this.rest.set(l.px + l.nx * p.landingClear, l.py + l.ny * p.landingClear, l.pz + l.nz * p.landingClear);
        break;
      }
    }
    if (!this.landingClean(world, this.target)) return false;
    this.flareFrom.copy(this.pos);
    this.flareDur = clamp((2 * this.rest.distanceTo(this.pos)) / Math.max(this.speed, 1), p.flareTimeMin, p.flareTime);
    this.phase = 'flare';
    this.flareK = 0;
    this.flareT = 0;
    return true;
  }

  /**
   * 落点洁不洁（2026-11-23 第二版）。c 是落点那个面的接触（平面触地时的根接触 / Flare 的刹停点），刹停点 = c.p + n·landingClear：
   *  - 刹停点本身不能埋在别的面里（任何深度）；
   *  - 刹停点上方躯干中心（沿法线抬高 bodyLift）嵌进了"侧面竖墙 / 顶棚底面"（法线朝上分量 < BODY_BLOCK_NY、离面 < BODY_EMBED）= 不干净：
   *    closest 只看见最近的那个面，软磁吸 / 步态 place 会把鸟拽进旁边的面里（庭院的温室：矮墙顶紧挨着玻璃面，落在棱边上 place 查到的是玻璃的侧面）。
   *  相邻的朝上可站立面（屋顶接缝的另一块板）、母子分叉的枝条、长椅 / 栏杆下面的支撑盒一律放行——第一版 1 cm 内见到任何第二个面就拒落，
   *  屋顶接缝 / 树杈 / 栏杆全落不上。
   */
  private landingClean(world: SimWorld, c: Contact): boolean {
    const surface = c.surface;
    if (surface === null) return false;
    const clear = this.params.landingClear;
    const x = c.px + c.nx * clear;
    const y = c.py + c.ny * clear;
    const z = c.pz + c.nz * clear;
    const l = this.lead;
    world.closest(x, y, z, l);
    if (l.surface !== null && l.surface !== surface && l.dist < 0) return false;
    const lift = this.params.bodyLift;
    world.closest(x + c.nx * lift, y + c.ny * lift, z + c.nz * lift, l);
    if (l.surface !== null && l.surface !== surface && l.ny < BODY_BLOCK_NY && l.dist < BODY_EMBED) return false;
    return true;
  }

  private copyContact(from: Contact, to: Contact): void {
    to.surface = from.surface;
    to.px = from.px;
    to.py = from.py;
    to.pz = from.pz;
    to.nx = from.nx;
    to.ny = from.ny;
    to.nz = from.nz;
    to.dist = from.dist;
    to.u = from.u;
    to.v = from.v;
  }

  /**
   * Landing Flare：展翅展尾刹车，位置从捕获点沿直线减速滑到刹停点（二次 ease-out：第一帧速度 = 捕获空速，到点归零），
   * 刹停点只跟着弹性栖面（电线 / 细枝）动，面没了就放弃回到飞行。
   * 落定：滑完、根离目标面 < touchDown（平面 1.5 / 枝 0.5 cm）、或硬超时 → 当帧落定（landNow）；
   * 滑的途中穿进目标面也当帧落定（贴回面上），撞到别的面就放弃这次捕获。
   */
  private updateFlare(dt: number, world: SimWorld): void {
    const p = this.params;
    const c = this.contact;
    // 刹停点只会跟着弹性栖面动：只对它们重查；静态面（雪地 / 盒顶）保留原捕获点——
    // 落点旁边贴着别的面时重查会换成别的面，一次捕获就被误判成"面没了"放弃
    const tgt = this.target.surface;
    if (tgt instanceof CurvePerch) {
      world.closest(this.target.px, this.target.py, this.target.pz, c);
      if (c.surface !== tgt || c.ny < MIN_NY) {
        this.abortFlare();
        return;
      }
      this.copyContact(c, this.target);
    }
    this.rest.set(this.target.px + this.target.nx * p.landingClear, this.target.py + this.target.ny * p.landingClear, this.target.pz + this.target.nz * p.landingClear);
    // 磁吸途中撞到别的面（树干 / 粗枝）：推出去、放弃这次捕获回到飞行——软磁吸不能拉着鸟穿模
    if (this.penetrated(world) && this.contact.surface !== this.target.surface) {
      this.maxPen = Math.max(this.maxPen, -this.contact.dist);
      this.prev.copy(this.pos);
      this.pushOut(this.contact);
      this.settle(world, false);
      this.speed = this.vel.length();
      this.abortFlare();
      return;
    }
    // 减速滑：按子步推进，每步查碰撞——穿进目标面就当帧落定（根贴回面上方 landingClear），撞到别的面就放弃这次捕获
    const dur = this.flareDur;
    const touch = tgt instanceof CurvePerch ? p.touchDownPerch : p.touchDownFlat;
    let remaining = dt;
    while (remaining > 1e-9) {
      const h = Math.min(remaining, MAX_SUBSTEP);
      remaining -= h;
      this.flareT += h;
      const k = Math.min(1, this.flareT / dur);
      const e = 1 - (1 - k) * (1 - k);
      this.vel.copy(this.rest).sub(this.flareFrom).scale((2 * (1 - k)) / dur);
      this.prev.copy(this.pos);
      lerpTo(this.flareFrom, this.rest, e, this.pos);
      if (this.penetrated(world)) {
        const q = this.contact;
        this.maxPen = Math.max(this.maxPen, -q.dist);
        // 穿进的是目标面上能落的那一面才当帧落定（盒体的侧面也是"同一个表面"：滑到一半撞上楼的西墙不能算落在楼上）
        if (q.surface === tgt && q.ny >= MIN_NY && this.landNow(world)) return;
        this.pushOut(this.contact);
        this.settle(world, false);
        this.speed = this.vel.length();
        this.abortFlare();
        return;
      }
      if (k >= 1) break;
    }
    this.speed = Math.min(p.maxSpeed, this.vel.length());
    // 姿态：仰身减速，坡度回平
    this.bank += (0 - this.bank) * (1 - Math.exp(-8 * dt));
    this.pitch += (0.45 - this.pitch) * (1 - Math.exp(-10 * dt));
    this.bodyPitch += (this.pitch - this.bodyPitch) * (1 - Math.exp(-14 * dt));
    this.flapping = false;
    this.flapPhase += p.flapHz * Math.PI * 2 * dt * 0.5;
    this.wingOpen += (1 - this.wingOpen) * (1 - Math.exp(-30 * dt));
    this.tailSpread += (0.5 - this.tailSpread) * (1 - Math.exp(-20 * dt));
    this.legsExtend += (1 - this.legsExtend) * (1 - Math.exp(-12 * dt));
    const k = Math.min(1, this.flareT / dur);
    this.flareK = k;
    // 落定：根离目标面够近（平面 1.5 cm / 枝 0.5 cm）就当帧落；滑完或硬超时也在刹停点落
    world.closest(this.pos.x, this.pos.y, this.pos.z, c);
    if (c.surface === tgt && c.ny >= MIN_NY && c.dist < touch && this.landNow(world)) return;
    if (k >= 1 || this.flareT > p.flareTimeout) {
      // 滑完 / 硬超时：在刹停点落定；刹停点被别的面占了（墙根）就推出去回到飞行（卡死探测会接着找地方落）
      this.pos.copy(this.rest);
      this.vel.set(0, 0, 0);
      world.closest(this.pos.x, this.pos.y, this.pos.z, this.contact);
      if (!this.landNow(world)) {
        this.prev.copy(this.pos);
        this.pushOut(this.contact);
        this.settle(world, false);
        this.abortFlare();
      }
    }
  }
}
