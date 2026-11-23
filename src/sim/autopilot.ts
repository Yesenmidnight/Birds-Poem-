/**
 * 自由巡飞的自动驾驶（阶段 5 观赏模式）。纯数学、零 three 依赖，Node 直接跑。
 *
 * 在一组"景点"之间轮换着飞：树冠上方、电线上方、小楼屋顶、雪地上空、长椅旁……高一座低一座地起伏，
 * 到了一个就换下一个（每个点带点随机偏移，同一个景点每次飞的路线都不一样）。
 * 转向 / 俯仰都是朝目标点的"视线"：航向偏差 → 压坡，路径角和当前机体俯仰的差 → 拉杆 / 推杆。
 * 扑翼节奏：爬升 / 离地太近 / 空速掉到失速速度附近就一直扑，否则扑 2.5~4 s、滑 0.8~1.4 s 地交替（山雀的波浪）；
 * 俯冲下景点的时候顺势滑翔，就是"俯冲掠飞"（Flight 滑翔时每帧探前下方的着陆点，探测点离地 / 离屋顶不够高就不滑——一滑就落）。
 * 空速管理：扑翼的平均推力只够 8° 的可持续爬升，所以巡航（390）上下平飞攒速、失速速度 1.3 倍以上才爬；硬底线（离地 < 35）里一截一截地拉起来。
 * 着陆探测：Flight 2026-11-23 起巡航中也每帧探着陆点（脚下 + 前方，电线 9 cm / 平面 10 cm 包络），自动驾驶给的是 noLand 意图——
 * 它没有"想落"的概念，树冠里飞来飞去探测点老是从细枝旁边过，不关掉的话 90 s 要被电线 / 树梢抓下去二十多次；撞到面 / 卡死探测照常落。
 * 避障：仿真层的 closest 只有 32 cm 余量看不远，所以沿航向一步一步往前扫（40 → 600 cm，步长递增），第一个离面不到 28 cm 的
 * 采样点决定躲的力度——朝上 / 朝下的面拉杆 / 推杆离开，墙 / 树干往左右探哪边空就往哪边转；挡路的东西不到 BRAKE_AHEAD 先刹车
 * （停扑 + 拉杆 = Flight 的 brake，转弯半径随空速缩小）再绕。转弯时机身侧前方的东西几帧内就扫进航线，左右各加一条偏 31° 的短线。
 * 矩形风墙也算一个障碍扫进去（法线朝场地中心），靠外圈时优先挑靠里的景点。起飞朝向由 launchAzimuth 挑（前方有墙就换最空的方向）。
 * 失速了先低头换回速度再拉。场地边界（逆风软边界 / 风墙 / 虚空兜底）本身由 Flight 管，这里只是不让它撞上去。
 * 每帧不分配：目标点、探测点、联络点都是常驻对象。
 */
import { Vec3 } from './math.ts';
import { clamp } from '../util/math.ts';
import { makeRng } from '../util/math.ts';
import { makeContact, type Contact } from './surface.ts';
import { CurvePerch, makeCurveFrame } from './curvePerch.ts';
import type { SimWorld } from './world.ts';
import type { Flight, FlightIntent } from './flight.ts';

/** 一个景点：世界坐标 + 到这么近就算到了（厘米）。 */
export interface FlySpot {
  x: number;
  y: number;
  z: number;
  r: number;
}

/** 前方扫到面不到这么近就开始躲（厘米，采样点离面的距离）。 */
const AVOID_CLEAR = 28;
/** 挡路的东西不到这么远（厘米）：先刹车（停扑 + 拉杆）再绕，转弯半径随空速缩小（2026-11-23 第二版：巡航 390 时转弯半径 123，500 是 700 时代的距离）。 */
const BRAKE_AHEAD = 300;
/** 竖直面不到这么远（≈ 已经碰上）才算贴墙：顺着墙朝目标那一侧滑。40 cm 外就按贴墙处理的话，机头还指着墙、离墙又远，escape 够不着，直接撞上去（2026-11-23）。 */
const HUG_AHEAD = 15;
/** 往左右探的方向偏离航向的角度：正对着楼面时 ±40° 还在楼里，得探到 ±63° 才看得到楼的两头。 */
const SIDE_PROBE = 1.1;
/** 离地（离脚下最近的面）不到这么多：必须扑翼、不能滑翔（厘米）。 */
/** 离地不到这么多：不能滑翔（厘米；滑翔会触发着陆探测落下去）。 */
const LOW_CLEAR = 80;
/** 离地不到这么多：硬底线，必须拉起扑翼、任何规则都不能推杆（厘米）。 */
const HARD_CLEAR = 35;
/** 扑翼 / 滑翔的时长范围（秒）。 */
const FLAP_MIN = 2.5;
const FLAP_VAR = 1.5;
const GLIDE_MIN = 0.8;
const GLIDE_VAR = 0.6;
/** 一个景点最多追这么久（秒）就换（被楼挡住绕不过去之类）。 */
const GIVE_UP = 20;
/** 俯仰输出的低通速率（1 / 秒）：规则之间打架时别一帧一换（见 update 末尾）。 */
const PITCH_RATE = 8;
/** 可持续爬升的路径角上限（弧度，约 11°）：推力只有 70% 的时间有，再陡就要掉到失速速度。 */
const CLIMB_PATH = 0.2;
const DIVE_PATH = -0.55;
/** 离场地边超过 homeRadius 的这个比例（按矩形两轴里超得多的那个算）就开始往里转、目标比鸟还靠外时换靠里的景点。
 *  和 Flight 的逆风软边界同一起点（1.0）：早于它的话环上的景点（r 120~200）全被当成"靠外"，AI 自己的提示和目标转向打架、每 0.5 s 换一次目标。 */
const EDGE_K = 1.0;
/** 硬底线内攒到这个空速（失速速度的倍数）才满杆拉起（掉回失速速度就改平飞再攒）：失速速度上下拉杆只会把空速拖回失速。 */
const CLIMB_OUT_K = 1.3;
/** 挡路的是楼 / 盒体、目标在楼上头：离楼不到这么远（秒 × 空速，再加 150 cm）才敢抬头越顶——慢飞时爬升率只有 60 cm/s 上下，更近只能绕。 */
const OVER_BOX_AHEAD_T = 0.7;
const OVER_BOX_AHEAD_MIN = 200;
/** 前视扇形：转弯时机身侧前方的东西几帧内就会扫进航线，左右各加一条偏这么多弧度的短线（和 Flight.lookAhead 无关）。 */
const FAN_ANGLE = 0.55;
/** 扇形侧线最远扫到这么多（厘米）：再远的侧前方东西是转弯才碰得到的，交给目标转向去躲。 */
const FAN_REACH = 120;
/** 自动起飞挑方向：以目标方向为中心前后各 4 档、每档 LAUNCH_FAN 弧度；前方 LAUNCH_REACH 厘米内按 LAUNCH_CLIMB 的爬升斜率探过去。 */
const LAUNCH_FAN = 0.45;
const LAUNCH_REACH = 260;
const LAUNCH_CLIMB = 0.17;
/** 比这细的枝 / 电线不算挡路（厘米）：躲它们只会让航线抖成麻花，真擦上了 Flight 也会顺面滑走。 */
const THIN_RADIUS = 1.5;

/**
 * 仿真调试台的景点（tools/sim.mjs 和城市漫游的 TestRig 共用这一份；城市生成器出来后由布局给）。
 * 高低交替：树冠侧上方 → 雪地上空 → 屋顶上方 → 主角枝后上方 → 电线上方 → 长椅上方 → 细树梢上方 → 电线东段下方。
 * 全部摆在离场地中心 120~200 cm 的环上：调试台风墙半径 238，而山雀失速速度 560 满舵的最小转弯半径 254——
 * 贴着场边的鸟物理上转不进中心（第一版把树冠顶 (−45,365,−20) 当景点，AI 绕着它转了 20 s 都到不了）。
 * 2026-11-23 第二版：巡航 390 后飞行中也会自动抓落点（电线 9 cm / 平面 10 cm 包络），电线上方 / 长椅上方 / 细树梢上方的景点抬高到离面 ≥ 55 cm。
 */
export const TEST_SPOTS: FlySpot[] = [
  { x: -120, y: 340, z: -120, r: 90 },
  { x: -130, y: -10, z: 110, r: 70 },
  { x: 150, y: 115, z: -120, r: 80 },
  { x: -20, y: 150, z: 150, r: 70 },
  { x: -120, y: 178, z: 52, r: 60 },
  { x: -100, y: 35, z: 100, r: 60 },
  { x: 45, y: 115, z: 110, r: 60 },
  { x: 120, y: 40, z: 150, r: 60 },
];

export class Autopilot {
  readonly spots: FlySpot[];
  /** 当前目标点（世界坐标）和它的到达半径；到过几个景点。 */
  readonly target = new Vec3();
  targetR = 60;
  spotsVisited = 0;
  private next = 0;
  private hasTarget = false;
  private holdT = 0;
  /** 扑翼 / 滑翔节奏：现在在滑翔吗、这一段已经多久、这一段打算多久。 */
  private gliding = false;
  private cycleT = 0;
  private cycleDur = 3;
  /** 目标落在最小转弯圆里、正在直飞等它转到前方（带迟滞，见 update）。 */
  private orbiting = false;
  /** 最近一次 clearance 命中的是风墙（联络点里 surface = null 的还有雪地，不能拿它当风墙的标记）。 */
  private wallBlock = false;
  /** 这一帧避障要求刹车（停扑 + 拉杆）：节奏那段按它强制进滑翔态。 */
  private braking = false;
  /** 硬底线内正在满杆拉起（带迟滞，见 update）。 */
  private climbOut = false;
  /** 上一次"哪边更空"的判断（±1，0 = 还没判过）：freerSide 的迟滞。 */
  private sideKeep: 1 | -1 | 0 = 0;
  /** 低通后的俯仰输出。 */
  private pitchNow = 0;
  private readonly rng: () => number;
  private readonly c: Contact = makeContact();
  private readonly frame = makeCurveFrame();

  /** 雪面基准高度（世界 y，厘米）：离地高度按它算；取雪垄最高处（TEST_RIG：base −80 + drift 7）。 */
  groundY = -73;

  constructor(spots: FlySpot[] = TEST_SPOTS, seed = 7) {
    this.spots = spots;
    this.rng = makeRng(seed);
  }

  /** 重新开始（换了景点表 / 重置）：下一个景点从头来。 */
  reset(): void {
    this.hasTarget = false;
    this.next = 0;
    this.holdT = 0;
    this.gliding = false;
    this.cycleT = 0;
    this.orbiting = false;
    this.climbOut = false;
    this.sideKeep = 0;
    this.pitchNow = 0;
  }

  /** 目标点相对鸟的方位偏差（弧度，正 = 目标在航向左侧）：给面板 / 截图标注用。 */
  targetError(f: Flight): number {
    if (!this.hasTarget) return 0;
    return wrapAngle(Math.atan2(this.target.x - f.pos.x, this.target.z - f.pos.z) - Math.atan2(f.heading.x, f.heading.z));
  }

  update(dt: number, f: Flight, world: SimWorld, out: FlightIntent): void {
    const homeR = f.homeRadius;
    const rx = f.pos.x - f.homeX;
    const rz = f.pos.z - f.homeZ;
    // 到矩形场边的超出比例（Flight.boundaryOver，两轴各按各的半边长）；1 = 正好在场边上
    const edge = f.boundaryOver();
    if (!this.hasTarget || this.holdT > GIVE_UP || this.near(f)) this.pick(f, false);
    // 已经靠外圈了、目标还比鸟更靠外：换一个靠里的，别朝着风墙飞
    // （刚换过目标 0.5 s 内不再换：不然一个比一个靠外的目标会在几帧内连换一整圈）
    const targetOut = f.boundaryOver(this.target.x, this.target.z);
    if (homeR > 0 && edge > EDGE_K && this.holdT > 0.5 && targetOut > edge - 0.1) this.pick(f, true);
    this.holdT += dt;

    // 朝目标的视线：航向偏差 → 压坡
    const dx = this.target.x - f.pos.x;
    const dy = this.target.y - f.pos.y;
    const dz = this.target.z - f.pos.z;
    const distH = Math.hypot(dx, dz);
    // 目标落在最小转弯圆里（满舵也兜不到它）：先直飞，等目标转到前方再压坡——不然会绕着目标永远转圈。
    // 带迟滞锁存（偏离机头 > 57° 进、< 29° 出），不然一松舵坡度还没回零标志就翻回去、接着绕圈。
    // 这个状态下"朝场地中心转"的边界提示 / 风墙躲避 / Flight 自己的逆风软边界都要让路（目标就在圆心附近，朝中心转 = 继续绕圈）
    const rt = (f.speed * f.speed) / (980 * Math.tan(0.9));
    const terr = Math.abs(this.targetError(f));
    const tdist = Math.hypot(dx, dy, dz);
    if (this.orbiting) {
      // 出锁存：目标转到前方了，或者已经飞离转弯圆（直飞把它甩开了）——只看方位的话直飞中永远出不来
      if (terr < 0.5 || tdist >= rt * 1.1) this.orbiting = false;
    } else if (tdist < rt * 1.1 && terr > 1.0) this.orbiting = true;
    let turn = this.orbiting ? 0 : clamp(this.targetError(f) * 1.6, -1, 1);
    // 靠外圈：往场地中心压坡（和 Flight 的逆风软边界同向叠加，满舵）
    if (!this.orbiting && homeR > 0 && edge > EDGE_K) {
      const k = Math.min(1, (edge - EDGE_K) / 0.3);
      const ew = wrapAngle(Math.atan2(-rx, -rz) - Math.atan2(f.heading.x, f.heading.z));
      if (Math.abs(ew) > 0.15) turn = clamp(turn + Math.sign(ew) * k * 1.2, -1, 1);
    }
    // 路径角 → 俯仰（爬升压在不失速的范围里，俯冲别太陡）
    const path = clamp(Math.atan2(dy, Math.max(distH, 1)), DIVE_PATH, CLIMB_PATH);
    let pitch = clamp((path - f.bodyPitch) * 3, -1, 1);

    // 离地高度按布局给的雪面基准高度直接算（雪层碰撞体只有几厘米厚，探到它下面时 closest 回的是底面、法线朝下，
    // 第一版拿它当"脚下有多远"结果把雪层底当成屋檐推杆扎进雪里）。
    // 速度阈值全按 Flight 的参数走（失速 240 / 巡航 390 / 冲刺 700），不各抄一份常数
    const stall = f.params.stallSpeed;
    const cruise = f.params.cruiseSpeed;
    const climbOutV = stall * CLIMB_OUT_K;
    // 软底线：离地不到 LOW_CLEAR 不滑翔（滑翔的前瞻更远、更容易被抓下去）；硬底线：不到 HARD_CLEAR 必须拉起扑翼，任何规则都不能推杆
    const agl = f.pos.y - this.groundY;
    const low = agl < LOW_CLEAR;
    const hardLow = agl < HARD_CLEAR;
    // 着陆探测：自动驾驶给 Flight 的意图带 noLand（它没有"想落"的概念——2026-11-23 起 Flight 巡航中也每帧探着陆点，
    // 树冠里飞来飞去探测点老是从细枝旁边过，不关掉的话 90 s 要被电线 / 树梢抓下去二十多次）；撞到面 / 卡死探测照常落
    const mustFlap = low || path > 0.05 || f.speed < 0.88 * stall || f.stall > 0.05;
    // 离地近又在掉：拉起来——但空速还没到失速速度以上时不拉（失速速度下拉杆只会把速度耗光、原地 stall，
    // 第一版在墙根 388 cm/s 拉满杆直接掉到 0 空速卡死）
    if (low && f.vel.y < -60 && f.speed > stall) pitch = Math.max(pitch, 0.4);
    // 空速没攒够不爬：扑翼的平均推力只够 8° 的可持续爬升，11° 的路径角拉几秒就掉进失速，Flight 的失速低头是 −50° 的俯冲
    // （2026-11-23 的 trace：370 cm/s 失速 → 0.4 s 掉 130 cm → 贴地刹车 → flare 落地）。巡航上下攒速，失速速度 1.3 倍以上再爬
    if (f.speed < climbOutV && !hardLow) pitch = Math.min(pitch, 0);
    if (hardLow) {
      // 硬底线：拉起来。但失速速度上下满杆爬升会把空速拖回失速、舵效只剩三成（第一版"失速速度以下改平飞"在一帧一换，
      // 原地贴地飞了 30 s）——攒到 climbOutV 再满杆拉一截，掉回失速速度就改平飞再攒：一截一截地离开地面
      if (f.speed > climbOutV) this.climbOut = true;
      else if (f.speed < stall) this.climbOut = false;
      pitch = this.climbOut ? 1 : 0;
      turn *= 0.5;
    } else {
      this.climbOut = false;
    }
    // （试过"空速超过 760 就拉杆放速度"：航线全变，90 s 里迎头撞 5 → 15 次，撤了）
    // 失速了先低头换回速度（拉杆只会一直失速），离地太近除外
    if (f.stall > 0.2 && !low) pitch = Math.min(pitch, -0.2);
    // 空速快没了（撞完贴在墙上）：离地够高就先低头攒速度，拉杆在 0 空速下推力还抵不过诱导阻力；贴地时改平飞（见上）
    if (f.speed < stall * 1.25 && !low) pitch = -0.5;

    // 避障：沿速度往前扫，第一个贴面的采样点决定躲的力度；远就偏一点绕，近了满舵 + 先刹车（转弯半径随空速缩小）
    const blockD = this.blockedAhead(f, world);
    if (blockD < Infinity) {
      // 先记下挡路那个面的朝向（freerSide 的探测会覆盖 this.c）；surface = null 的是风墙
      const ny = this.c.ny;
      const py = this.c.py;
      const isWall = this.wallBlock;
      // 挡路的是楼 / 盒体：目标在楼的上方就抬头越过屋顶（左右探都探在楼里时"哪边空"没有意义，第一版往目标侧转 = 转进楼里）
      const box = this.c.surface !== null && this.c.surface.kind === 2;
      const overBox = Math.max(OVER_BOX_AHEAD_MIN, f.speed * OVER_BOX_AHEAD_T);
      if (box && dy > 0 && !isWall && f.speed > cruise * 0.85 && f.bodyPitch > -0.1 && blockD > overBox) {
        // 只有速度够、本来就在爬、离楼还远才敢抬头越顶：慢飞时拉杆爬不了多快，100 cm 外拉杆 0.15 s 后还是撞在楼角上
        pitch = 1;
        turn *= 0.3;
      } else
      if (isWall) {
        // 矩形风墙：朝场地中心转（圆墙时代这里不能转——中心永远在正侧方 90°，鸟会绕着场地中心转圈；矩形墙朝中心转就是 90° 掉头）
        const ew = wrapAngle(Math.atan2(-rx, -rz) - Math.atan2(f.heading.x, f.heading.z));
        turn = clamp(ew * 2, -1, 1);
      } else if (blockD < HUG_AHEAD && Math.abs(ny) < 0.4) {
        // 已经贴着楼 / 粗枝的竖直面：顺着面朝目标那一侧滑（再把机头往面里压，Flight 每帧都得把它拗回切线，永远绕不出去）
        turn = clamp(this.wallTangent(f) * 2, -1, 1);
      } else {
        const side = this.freerSide(f, world, Math.max(120, blockD));
        // 躲避的权重：挡路的越近越压过目标转向（300 cm 外只偏三成，150 cm 内全听躲避的）
        const w = clamp(1.2 - blockD / 500, 0.3, 1);
        if (ny >= 0.4 && f.bodyPitch < 0.3) pitch = Math.max(pitch, w);
        else if (ny <= -0.4 && py > f.pos.y) pitch = Math.min(pitch, -w);
        else turn = clamp(turn * (1 - w) + side * w, -1, 1);
      }
      // 挡路的东西不到 BRAKE_AHEAD、空速在巡航以上才刹（停扑 + 拉杆，Flight 里 brake 要 flap = false、pitch > 0.3）：刹到巡航以下就停，
      // 别刹进失速；已经在失速里更不能刹（拉杆和失速低头会一帧一个来回，2026-11-23 的 trace 里 0.45 / −0.71 逐帧翻）；
      // 硬底线内不刹（贴地刹车 = 失速坠地）
      if (blockD < BRAKE_AHEAD && !low && !hardLow && f.stall < 0.2 && f.speed > (isWall ? cruise - 40 : cruise)) {
        this.braking = true;
        pitch = Math.max(pitch, 0.45);
      }
    }
    // 硬底线最后再压一遍：避障的"底面 → 推杆"也不能把鸟按进雪里（拉不拉看 climbOut，见上）
    if (hardLow) pitch = this.climbOut ? 1 : 0;

    // 扑翼 / 滑翔节奏（刹车那几帧强制滑翔态 = 展翅减速）：按空速走——扑到巡航 +40 以上就滑翔，滑到巡航 −20 以下再扑，
    // 再各封一个时长上限 / 下限，平均正好在巡航速度附近一波一波地飞
    // （试过把波段压到 540~620 好让转弯半径小一点：滑翔掉到 700 以下就进了 Flight 的着陆探测范围，90 s 落了 21 次、
    // 每次重新起飞都要从失速里爬出来，撞墙和失速反而翻倍——2026-11-23）
    this.cycleT += dt;
    if (this.gliding) {
      if (mustFlap || f.speed < cruise - 20 || this.cycleT > this.cycleDur) {
        this.gliding = false;
        this.cycleT = 0;
        this.cycleDur = FLAP_MIN + this.rng() * FLAP_VAR;
      }
    } else if ((this.braking || (!mustFlap && (f.speed > cruise + 40 || this.cycleT > this.cycleDur))) && !low) {
      this.gliding = true;
      this.cycleT = 0;
      this.cycleDur = this.braking ? 0.5 : GLIDE_MIN + this.rng() * GLIDE_VAR;
    }
    this.braking = false;

    // 绕圈直飞时把 Flight 自己的逆风软边界加成减掉（它朝中心转 = 带着继续绕圈），风墙本身还有贴墙偏置兜着
    // 只在场地内部才抵消 Flight 的逆风软边界：靠外圈时听它的（满舵 U 弯穿过场地中部，比直飞贴墙滑强）
    out.turn = this.orbiting && edge < 0.9 ? clamp(turn - f.boundaryTurn(), -1, 1) : turn;
    // 俯仰低通：规则之间会打架——目标在下方要俯冲（−1）、俯冲射线探到前方的雪地要拉起（+1），一帧一换；
    // 700 时代飞得快看不出，慢飞时航线抖成 ±9°，擦着树枝就撞（2026-11-23 的 trace 里 90 s 撞 9 次）。τ = 1 / PITCH_RATE
    this.pitchNow += (pitch - this.pitchNow) * (1 - Math.exp(-PITCH_RATE * dt));
    out.pitch = this.pitchNow;
    out.flap = !this.gliding;
    out.land = false;
    out.noLand = true;
  }

  private near(f: Flight): boolean {
    const dx = this.target.x - f.pos.x;
    const dy = this.target.y - f.pos.y;
    const dz = this.target.z - f.pos.z;
    return Math.hypot(dx, dy, dz) < this.targetR;
  }

  /**
   * 换下一个景点：按表顺序（高低交替），位置带 ±30% 到达半径的随机偏移。inward = 只要离场地中心比鸟现在近的
   * （从下一个开始找一个，找不到就照常顺序取）。
   */
  private pick(f: Flight, inward: boolean): void {
    let idx = this.next % this.spots.length;
    if (inward && f.homeRadius > 0) {
      for (let k = 0; k < this.spots.length; k++) {
        const j = (this.next + k) % this.spots.length;
        const s = this.spots[j];
        // 按到场边的比例比（约 3% 个半边长 ≈ 40 cm 以内才算明显靠里）
        if (f.boundaryOver(s.x, s.z) < f.boundaryOver() - 0.03) {
          idx = j;
          break;
        }
      }
    }
    const s = this.spots[idx];
    this.next = idx + 1;
    this.hasTarget = true;
    this.holdT = 0;
    this.spotsVisited++;
    this.targetR = s.r;
    this.target.set(
      s.x + (this.rng() * 2 - 1) * s.r * 0.3,
      Math.max(s.y + (this.rng() * 2 - 1) * s.r * 0.3, -30),
      s.z + (this.rng() * 2 - 1) * s.r * 0.3,
    );
    // 新目标和现在飞的方向差得太多（在身后）：这一段先扑翼，别在急转弯里掉速
    if (Math.abs(this.targetError(f)) > 1.2) {
      this.gliding = false;
      this.cycleT = 0;
      this.cycleDur = FLAP_MIN;
    }
  }

  /** 这一点离最近的面（或风墙）多远；命中时 this.c 是那个联络点（风墙的 surface = null、法线朝场地中心）。细枝 / 电线不算挡路。
   *  ignoreGround：不拿雪地基准高度当挡路（起飞挑方向时鸟就站在地上，采样点贴着地面起步，按地面算哪个方向都是 0）。 */
  private clearance(f: Flight, world: SimWorld, x: number, y: number, z: number, ignoreGround = false): number {
    if (f.homeRadius > 0) {
      // 矩形风墙（和 Flight.hitWindWall 同一面）：离哪面墙不到 AVOID_CLEAR 就算挡路，法线朝场地中心
      const rx = x - f.homeX;
      const rz = z - f.homeZ;
      const ex = f.wallHalfX - Math.abs(rx);
      const ez = f.wallHalfZ - Math.abs(rz);
      const clear = Math.min(ex, ez);
      if (clear < AVOID_CLEAR) {
        const c = this.c;
        c.surface = null;
        c.nx = ex < ez ? -Math.sign(rx) : 0;
        c.ny = 0;
        c.nz = ex < ez ? 0 : -Math.sign(rz);
        c.dist = clear;
        this.wallBlock = true;
        return clear;
      }
    }
    const agl = y - this.groundY;
    if (!ignoreGround && agl < AVOID_CLEAR) {
      // 雪地：按基准高度算（closest 从雪层下面探到的是底面、法线朝下，会被当成屋檐推杆）
      this.c.surface = null;
      this.c.nx = 0;
      this.c.ny = 1;
      this.c.nz = 0;
      this.c.dist = agl;
      this.wallBlock = false;
      return agl;
    }
    this.wallBlock = false;
    world.closest(x, y, z, this.c);
    const c = this.c;
    if (c.surface === null) return 99;
    if (c.surface.kind === 1) return 99;
    if (c.surface instanceof CurvePerch && c.surface.frameAt(c.u, this.frame).radius < THIN_RADIUS) return 99;
    // 采样点在面内部（楼里 / 树干里）时 closest 给的是最近的面，点在楼的下半部就是底面（法线朝下）——
    // 第一版把它当"屋檐底面"推杆，25 cm 高度拉不起来直接扎进雪里。内部的一律按"挡路、往空侧转"处理
    if (c.dist < 0) c.ny = 0;
    return c.dist;
  }

  /**
   * 沿速度往前扫：返回第一个离面不到 AVOID_CLEAR 的采样点有多远（厘米），没挡路返回 Infinity。
   * 巡航 390 满舵掉头要 ~390 cm（冲刺 700 要 ~1250，扫不到的那段靠 Flight 的脱困兜着），所以最远扫到 max(200, 0.9 s 航程) 且不超过 600；前 150 cm 步长 30，树干（半径 8）也漏不掉。
   */
  private blockedAhead(f: Flight, world: SimWorld): number {
    const reach = Math.min(600, Math.max(200, f.speed * 0.9));
    let best = this.scanRay(f, world, 0, reach);
    // 转弯时侧前方的东西几帧内就扫进航线，单线前视要等机头指上去才看得见（750 cm/s 下 600 cm 的前瞻只剩 0.1 s，
    // 2026-11-23 的撞楼 trace 里楼面是 70 cm 外才"出现"的）：左右各加一条偏 FAN_ANGLE 的短线，取三条里最近的
    if (best > FAN_REACH) {
      const sideReach = Math.min(reach, FAN_REACH);
      const l = this.scanRay(f, world, FAN_ANGLE, sideReach);
      const r = this.scanRay(f, world, -FAN_ANGLE, sideReach);
      if (l < best) best = l;
      if (r < best) best = r;
    }
    return best;
  }

  /** 沿航向偏 ang 弧度（正 = 左）的方向往前扫到 reach 厘米：第一个离面不到 AVOID_CLEAR 的采样点有多远，没挡路返回 Infinity。
   *  竖直斜率用平滑的 pitch、不用 vel.y：vel.y 带着扑翼的波浪（±9°），400 cm 外的采样点上下晃 60 cm，树干一帧探到一帧探不到。 */
  private scanRay(f: Flight, world: SimWorld, ang: number, reach: number): number {
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    const tx = f.heading.x * c + f.heading.z * s;
    const tz = -f.heading.x * s + f.heading.z * c;
    const slope = Math.sin(f.pitch);
    for (let d = 40; d <= reach; d += d < 150 ? 30 : d < 300 ? 70 : 100) {
      const clear = this.clearance(f, world, f.pos.x + tx * d, f.pos.y + slope * d, f.pos.z + tz * d);
      if (clear < AVOID_CLEAR) return d;
    }
    return Infinity;
  }

  /**
   * 自动起飞的朝向（弧度，atan2(x, z) 口径，正 = 左）：优先朝目标；但发射期 0.6 s 只有 500 cm/s 上下、舵效只有三成转不动，
   * 前方有楼 / 墙就换一个前方最空的方向——歇脚时面朝墙，第一版起飞就一头扎进墙里（撞完掉到失速速度，连着撞）。
   * 每档按前方 LAUNCH_REACH 厘米内最近的面打分，偏离目标一档扣一点：目标方向够空就一定朝目标。
   */
  launchAzimuth(f: Flight, world: SimWorld): number {
    const want = this.hasTarget
      ? Math.atan2(this.target.x - f.pos.x, this.target.z - f.pos.z)
      : Math.atan2(f.heading.x, f.heading.z);
    let bestA = want;
    let bestScore = -Infinity;
    for (let k = -4; k <= 4; k++) {
      const a = want + k * LAUNCH_FAN;
      const tx = Math.sin(a);
      const tz = Math.cos(a);
      let clear = 150;
      for (let d = 40; d <= LAUNCH_REACH && clear > 0; d += 44) {
        clear = Math.min(clear, this.clearance(f, world, f.pos.x + tx * d, f.pos.y + d * LAUNCH_CLIMB, f.pos.z + tz * d, true));
      }
      const score = clear - Math.abs(k) * 14;
      if (score > bestScore) {
        bestScore = score;
        bestA = a;
      }
    }
    return bestA;
  }

  /**
   * 左右各探一侧（偏离航向 SIDE_PROBE 弧度、reach 厘米远处），哪边离面更远 / 没有面就往哪边躲。
   * 返回 +1 / −1；两边差不多（15 cm 内）就沿用上一帧的判断（没有就往目标那一侧）——采样点一帧一晃，
   * 按"哪边空"逐帧重新判会左右一帧一换，鸟直挺挺撞上去（2026-11-23 慢飞版 90 s 撞树干 11 次的 trace）。
   */
  private freerSide(f: Flight, world: SimWorld, reach: number): 1 | -1 {
    const hx = f.heading.x;
    const hz = f.heading.z;
    const slope = Math.sin(f.pitch);
    const clear = (ang: number): number => {
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      const tx = hx * c + hz * s;
      const tz = -hx * s + hz * c;
      return this.clearance(f, world, f.pos.x + tx * reach, f.pos.y + slope * reach, f.pos.z + tz * reach);
    };
    const left = clear(SIDE_PROBE);
    const right = clear(-SIDE_PROBE);
    if (Math.abs(left - right) < 15) {
      if (this.sideKeep !== 0) return this.sideKeep;
      return this.targetError(f) >= 0 ? 1 : -1;
    }
    this.sideKeep = left > right ? 1 : -1;
    return this.sideKeep;
  }

  /** 贴墙时的转向：this.c 是墙的联络点（法线朝外）。沿墙的两条切线里取朝目标的那条，返回当前航向到它的偏差（弧度）。 */
  private wallTangent(f: Flight): number {
    let tx = -this.c.nz;
    let tz = this.c.nx;
    if (tx * (this.target.x - f.pos.x) + tz * (this.target.z - f.pos.z) < 0) {
      tx = -tx;
      tz = -tz;
    }
    return wrapAngle(Math.atan2(tx, tz) - Math.atan2(f.heading.x, f.heading.z));
  }
}

function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
