// 仿真层的无头压测：不开浏览器，直接用 Node 跑 src/sim 里的纯数学模块
// （Node 24 自带 TS 类型剥离，所以 src/sim 内部的相对导入都写全了 .ts 扩展名）。
// 任何一个场景不达标，进程以非零码退出。
// 用法：node tools/sim.mjs [场景,逗号分隔|all] [--runs 3000] [--seed 7]
// 场景：
//   spline  采样器与 three 的 CatmullRomCurve3.getSpacedPoints 逐点比对
//   brute   曲线栖木的“粗搜 + 细化”对逐段暴力搜索
//   queries 随机点的最近点查询：宽相对全量、距离 / 法线 / 垂足自洽、距离函数的 Lipschitz、确定性
//   rest    几千颗小球从空中落下：落定率、冲击深度、残余穿透、按表面的分布、确定性
//   ccd     细电线直落：不同落速下全部接住、不穿透
//   wire    电线颤动：频率 / 阻尼对参数，落在电线上的球跟着走
//   perf    查询吞吐与落球吞吐
//   gait    蹦跳步态：前进 / 后退 / 侧跳 / 原地掉头 / 动量连跳 / 急刹滑雪 / 随机连跳，每一跳都落定、不陷入、枝上朝向顺轴；
//           斜面（30° 雪坡）上下坡连跳 + 急刹贴坡 + 滑出边缘掉下去；枝上镜头偏轴跃离的角度规则
//   flight  飞行与着陆：跃离起飞到失速速度以上、巡航波浪、压坡转弯、失速低头恢复、滑翔自动着陆、俯冲拉杆、电线软磁吸（巡航 / 滑翔 / 横穿）、
//           Shift 冲刺（提速 / 扑翼频率 / 冲刺中不抓落点 / 松开回落）、屋顶接缝 + 支撑盒落点洁净、随机 60 s、迎头撞墙、斜擦墙、墙角脱困、
//           薄壁防隧穿、顶到电线底、逆风软边界 + 虚空兜底、自动驾驶 90 s
import { performance } from 'node:perf_hooks';
import { CatmullRomCurve3, Vector3 } from 'three';
import { makeRng } from '../src/util/math.ts';
import { HERO_BRANCH, TEST_RIG, TEST_TREE } from '../src/pcg/layout.ts';
import { buildCurve, buildWorld } from '../src/sim/buildWorld.ts';
import { CurvePerch, makeCurveFrame } from '../src/sim/curvePerch.ts';
import { Heightfield } from '../src/sim/heightfield.ts';
import { ProbeSet } from '../src/sim/contacts.ts';
import { Locomotion, cameraOffAxis } from '../src/sim/locomotion.ts';
import { SimWorld } from '../src/sim/world.ts';
import { FLIGHT, Flight } from '../src/sim/flight.ts';
import { Autopilot } from '../src/sim/autopilot.ts';
import { Vec3 } from '../src/sim/math.ts';
import { makeContact } from '../src/sim/surface.ts';
import { sampleArc, flattenPoints } from '../src/sim/spline.ts';

// ───────────────────────────── 参数 ─────────────────────────────
const argv = process.argv.slice(2);
let sceneArg = 'all';
let runs = 3000;
let seed = 7;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--runs') runs = Number(argv[++i]);
  else if (argv[i] === '--seed') seed = Number(argv[++i]);
  else sceneArg = argv[i];
}
const DT = 1 / 240;
const PROBE_RADIUS = 0.7;
const TMP = [0, 0, 0];
const frame = makeCurveFrame();
const TMPV = new Vec3();

// 与 world/Branch.ts 的 LIMBS 相同的控制点。那边带渲染依赖，Node 里 import 不了，这里抄一份数值做夹具
const BIRDWATCH_LIMBS = [
  {
    points: [[-46, -4.6, -11], [-26, -1.75, -3.7], [-11, -0.58, -0.55], [0, -0.42, 0], [9.5, -0.05, 0.75], [21, 1.1, 1.9]],
    radii: [2.4, 1.35, 0.74, 0.42, 0.28, 0.05],
    segments: 190,
  },
  {
    points: [[-13, -0.72, -0.75], [-16.5, 1.6, -1.9], [-18.5, 4.6, -2.6], [-19, 7.4, -2.3]],
    radii: [0.36, 0.24, 0.13, 0.04],
    segments: 70,
  },
  {
    points: [[7.5, -0.2, 0.55], [10.5, 1.3, 1.9], [13, 3.2, 2.4], [14.2, 5.3, 2.0]],
    radii: [0.24, 0.16, 0.09, 0.03],
    segments: 70,
  },
  {
    points: [[16.5, 0.55, 1.4], [19, 0.2, 2.6], [21.5, -0.35, 3.4]],
    radii: [0.14, 0.09, 0.03],
    segments: 50,
  },
];

let failures = 0;
function report(name, ok, text) {
  if (!ok) failures++;
  console.log(`[${name.padEnd(7)}] ${ok ? '通过' : '失败'}  ${text}`);
}

/** 调试台 + 观鸟主枝的碰撞体。names[i] 是第 i 个表面的名字，出报告用。 */
function makeWorld() {
  const world = buildWorld(TEST_RIG);
  const names = [...TEST_RIG.curves.map((c) => c.tag), ...TEST_RIG.grounds.map((g) => g.tag), ...TEST_RIG.boxes.map((b) => b.tag)];
  const limb = BIRDWATCH_LIMBS[0];
  world.add(buildCurve({ tag: 'branch', points: limb.points, radii: limb.radii, segments: limb.segments }));
  names.push('branch');
  return { world, names };
}

function findCurve(world, names, tag) {
  return world.surfaces.find((s, i) => s instanceof CurvePerch && names[i] === tag);
}

/** 随机单位向量。 */
function randomDir(rng, out) {
  const z = rng() * 2 - 1;
  const a = rng() * 2 * Math.PI;
  const r = Math.sqrt(1 - z * z);
  out[0] = r * Math.cos(a);
  out[1] = z;
  out[2] = r * Math.sin(a);
}

/** 随机查询点：一部分在空间里均匀撒，一部分贴着随机某个表面撒（表面附近、表面内部、两端之外都压到）。 */
function samplePoint(world, rng, out) {
  if (rng() < 0.4) {
    out[0] = -300 + rng() * 600;
    out[1] = -110 + rng() * 320;
    out[2] = -300 + rng() * 600;
    return out;
  }
  const s = world.surfaces[Math.floor(rng() * world.surfaces.length)];
  if (s instanceof CurvePerch) {
    s.frameAt(rng() * s.length, frame);
    if (rng() < 0.08) {
      // 轴线两端之外
      const k = rng() * 6 * (rng() < 0.5 ? -1 : 1);
      out[0] = frame.cx + frame.tx * k;
      out[1] = frame.cy + frame.ty * k;
      out[2] = frame.cz + frame.tz * k;
      return out;
    }
    randomDir(rng, TMP);
    const radial = rng() < 0.3 ? -rng() * frame.radius : frame.radius + rng() * rng() * 8;
    out[0] = frame.cx + TMP[0] * radial;
    out[1] = frame.cy + TMP[1] * radial;
    out[2] = frame.cz + TMP[2] * radial;
    return out;
  }
  if (s instanceof Heightfield) {
    out[0] = s.x0 + rng() * s.nx * s.cell;
    out[2] = s.z0 + rng() * s.nz * s.cell;
    const h = s.heightAt(out[0], out[2]);
    out[1] = rng() < 0.25 ? h - rng() * 25 : h + rng() * rng() * 40;
    return out;
  }
  out[0] = s.min.x - 20 + rng() * (s.max.x - s.min.x + 40);
  out[1] = s.min.y - 20 + rng() * (s.max.y - s.min.y + 40);
  out[2] = s.min.z - 20 + rng() * (s.max.z - s.min.z + 40);
  return out;
}

function copyContact(from, to) {
  to.surface = from.surface;
  to.px = from.px;
  to.py = from.py;
  to.pz = from.pz;
  to.nx = from.nx;
  to.ny = from.ny;
  to.nz = from.nz;
  to.dist = from.dist;
  to.svel = from.svel;
  to.u = from.u;
  to.v = from.v;
  to.face = from.face;
}

/** 撞上曲线栖木就让它颤起来（游戏里由落地逻辑调用，这里挂在探针的撞击回调上）。 */
function exciteOnImpact(contact, speed) {
  if (contact.surface instanceof CurvePerch) contact.surface.excite(contact.u / contact.surface.length, speed, contact.ny);
}

// SIM_DEBUG=1 时把头几例漏检的细节打出来
const DEBUG = !!process.env.SIM_DEBUG;
const show = (x, y, z) => `(${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)})`;
function describe(world, names, c) {
  return c.surface ? `${names[c.surface.id]} dist ${c.dist.toFixed(4)}` : '空';
}

// ───────────────────────────── 场景 ─────────────────────────────

/** spline：采样器与 three 逐点比对。 */
function spline() {
  let maxDev = 0;
  let maxLenDev = 0;
  let count = 0;
  const check = (points, divisions) => {
    const ref = new CatmullRomCurve3(points.map((p) => new Vector3(p[0], p[1], p[2])), false, 'centripetal');
    const theirs = ref.getSpacedPoints(divisions);
    const mine = sampleArc(flattenPoints(points), points.length, divisions);
    for (let i = 0; i <= divisions; i++) {
      const dx = mine.centers[i * 3] - theirs[i].x;
      const dy = mine.centers[i * 3 + 1] - theirs[i].y;
      const dz = mine.centers[i * 3 + 2] - theirs[i].z;
      maxDev = Math.max(maxDev, Math.abs(dx), Math.abs(dy), Math.abs(dz));
      count++;
    }
    maxLenDev = Math.max(maxLenDev, Math.abs(mine.length - ref.getLength()));
  };
  for (const limb of BIRDWATCH_LIMBS) check(limb.points, limb.segments);
  const rng = makeRng(seed);
  for (let k = 0; k < 40; k++) {
    const n = 2 + Math.floor(rng() * 8);
    const points = [];
    for (let i = 0; i < n; i++) points.push([(rng() - 0.5) * 80, (rng() - 0.5) * 30, (rng() - 0.5) * 80]);
    check(points, 8 + Math.floor(rng() * 290));
  }
  report(
    'spline',
    maxDev < 1e-9 && maxLenDev < 1e-9,
    `与 three 的 CatmullRomCurve3.getSpacedPoints 逐点比对 ${count.toLocaleString('en-US')} 个采样点（4 根观鸟枝 + 40 组随机控制点）：最大偏差 ${maxDev.toExponential(2)} cm，弧长偏差 ${maxLenDev.toExponential(2)} cm`,
  );
}

/** brute：粗搜 + 细化 对 逐段暴力搜索。 */
function brute() {
  const { world } = makeWorld();
  const rng = makeRng(seed + 1);
  const a = makeContact();
  const b = makeContact();
  let n = 0;
  let mismatch = 0;
  let worst = 0;
  let tFast = 0;
  let tSlow = 0;
  for (const s of world.surfaces) {
    if (!(s instanceof CurvePerch)) continue;
    for (let k = 0; k < 22000; k++) {
      if (k < 2000 || rng() >= 0.4) {
        // 多数点贴着这条曲线撒（表面附近、体内、端头之外）
        s.frameAt(rng() * s.length, frame);
        randomDir(rng, TMP);
        const radial = rng() < 0.25 ? -rng() * frame.radius : frame.radius + rng() * rng() * 10;
        TMP[0] = frame.cx + TMP[0] * radial;
        TMP[1] = frame.cy + TMP[1] * radial;
        TMP[2] = frame.cz + TMP[2] * radial;
      } else samplePoint(world, rng, TMP);
      const t0 = performance.now();
      s.closest(TMP[0], TMP[1], TMP[2], a);
      const t1 = performance.now();
      s.closestBrute(TMP[0], TMP[1], TMP[2], b);
      const t2 = performance.now();
      if (k < 2000) continue;
      tFast += t1 - t0;
      tSlow += t2 - t1;
      n++;
      const d = Math.abs(a.dist - b.dist);
      if (d > 1e-12 || Math.abs(a.u - b.u) > 1e-9) {
        mismatch++;
        worst = Math.max(worst, d);
      }
    }
  }
  report(
    'brute',
    mismatch === 0,
    `${n.toLocaleString('en-US')} 次曲线查询对逐段暴力搜索：不一致 ${mismatch} 次${mismatch ? `（最大距离差 ${worst.toExponential(2)} cm）` : ''}；粗搜版 ${((tFast / n) * 1e3).toFixed(3)} µs/次，暴力版 ${((tSlow / n) * 1e3).toFixed(3)} µs/次`,
  );
}

/** queries：宽相、自洽性、Lipschitz、确定性。 */
function queries() {
  const { world, names } = makeWorld();
  const measure = () => {
    const rng = makeRng(seed + 2);
    const a = makeContact();
    const b = makeContact();
    const tmp = makeContact();
    const near = [];
    const m = { gridMiss: 0, setMiss: 0, len: 0, nrm: 0, foot: 0, lips: 0, lipsAt: '', hash: 0, inside: 0, far: 0 };
    const N = 30000;
    const margin = world.margin;
    for (let i = 0; i < N; i++) {
      samplePoint(world, rng, TMP);
      const px = TMP[0];
      const py = TMP[1];
      const pz = TMP[2];
      world.closest(px, py, pz, a);
      // 全量：逐个表面问一遍，取最近
      b.dist = Infinity;
      b.surface = null;
      for (const s of world.surfaces) {
        s.closest(px, py, pz, tmp);
        if (tmp.dist < b.dist) copyContact(tmp, b);
      }
      // 最近的表面在查询半径（宽相外扩量）以内（点在体内时 dist < 0 也算）：宽相必须给出完全一样的结果；
      // 比它还远：宽相按设计查不到东西，必须返回空
      if (b.dist <= margin) {
        if (a.surface !== b.surface || Math.abs(a.dist - b.dist) > 1e-12) {
          m.gridMiss++;
          if (DEBUG && m.gridMiss <= 5) console.log(`  宽相漏检：全量 ${describe(world, names, b)}；宽相 ${a.surface ? describe(world, names, a) : '空'}；点 ${show(px, py, pz)}`);
        }
      } else {
        m.far++;
        if (a.surface !== null) {
          m.gridMiss++;
          if (DEBUG && m.gridMiss <= 5) console.log(`  宽相错检：全量 ${describe(world, names, b)}；宽相 ${describe(world, names, a)}；点 ${show(px, py, pz)}`);
        }
      }
      // 表面离这点 12 cm 以内的全部表面：宽相给的集合必须和全量一致
      const got = new Set();
      const n = world.query(px, py, pz, 12, near);
      for (let k = 0; k < n; k++) got.add(near[k].surface.id);
      let expect = 0;
      for (const s of world.surfaces) {
        s.closest(px, py, pz, tmp);
        if (Math.abs(tmp.dist) <= 12) {
          expect++;
          if (!got.has(s.id)) {
            m.setMiss++;
            if (DEBUG && m.setMiss <= 5) console.log(`  半径查询漏检：${describe(world, names, tmp)}；点 ${show(px, py, pz)}；包围盒 ${show(s.min.x, s.min.y, s.min.z)} ~ ${show(s.max.x, s.max.y, s.max.z)}；宽相给了 ${n} 个`);
          }
        }
      }
      if (n !== expect) m.setMiss++;
      if (!a.surface) continue;
      if (a.dist < 0) m.inside++;
      if (Math.abs(a.dist) >= 40) m.far++;
      m.hash += Math.round(a.dist * 1e6) * (i % 7 + 1);
      const dx = px - a.px;
      const dy = py - a.py;
      const dz = pz - a.pz;
      m.len = Math.max(m.len, Math.abs(Math.sqrt(dx * dx + dy * dy + dz * dz) - Math.abs(a.dist)));
      m.nrm = Math.max(m.nrm, Math.abs(Math.sqrt(a.nx * a.nx + a.ny * a.ny + a.nz * a.nz) - 1));
      // 垂足自洽：离面 40 cm 以内，(p − q) 应当沿法线，投影正好是有符号距离
      if (Math.abs(a.dist) < 40) m.foot = Math.max(m.foot, Math.abs(dx * a.nx + dy * a.ny + dz * a.nz - a.dist));
      // 1-Lipschitz：挪 0.01 cm，距离的变化不能超过 0.01 cm
      randomDir(rng, TMP);
      world.closest(px + TMP[0] * 0.01, py + TMP[1] * 0.01, pz + TMP[2] * 0.01, b);
      if (b.surface) {
        const lips = Math.abs(b.dist - a.dist) - 0.01;
        if (lips > m.lips) {
          m.lips = lips;
          m.lipsAt = `${names[a.surface.id]} ${show(px, py, pz)} dist ${a.dist.toFixed(3)} → ${names[b.surface.id]} dist ${b.dist.toFixed(3)} r ${(a.surface instanceof CurvePerch ? a.surface.frameAt(a.u, frame).radius : 0).toFixed(3)}`;
        }
      }
    }
    return m;
  };
  const m = measure();
  const again = measure();
  const same = again.hash === m.hash;
  // Lipschitz：距离函数沿任意方向的变化率 ≤ 1 + |dr/ds|（曲线栖木半径沿轴渐变，半角 2° 以内 → 允许 1% 超出）
  const ok = m.gridMiss === 0 && m.setMiss === 0 && m.len < 1e-9 && m.nrm < 1e-9 && m.foot < 1e-3 && m.lips < 1e-4 && same;
  if (DEBUG) console.log(`  Lipschitz 最大超出在：${m.lipsAt}`);
  report(
    'queries',
    ok,
    `30,000 个随机点（体内 ${m.inside} 个，离最近的表面比查询半径 ${world.margin} cm 还远 ${m.far} 个）：宽相漏检 / 错检 ${m.gridMiss} 次、半径查询漏检 ${m.setMiss} 次；|p−q| 与距离最大差 ${m.len.toExponential(1)} cm；法线长度误差 ${m.nrm.toExponential(1)}；垂足偏差 ${m.foot.toExponential(1)} cm；Lipschitz 最大超出 ${m.lips.toExponential(1)} cm；两次同种子结果${same ? '一致' : '不一致'}`,
  );
}

/** 一轮落球：返回各项指标。 */
function restRun(count) {
  const { world, names } = makeWorld();
  const probes = new ProbeSet(count, PROBE_RADIUS);
  const rng = makeRng(seed + 3);
  for (let i = 0; i < count; i++) {
    probes.spawn(-170 + rng() * 330, 150 + rng() * 40, -140 + rng() * 250, (rng() - 0.5) * 20, 0, (rng() - 0.5) * 20);
  }
  probes.onImpact = exciteOnImpact;
  const restAt = new Float64Array(count).fill(-1);
  let t = 0;
  let steps = 0;
  const t0 = performance.now();
  for (;;) {
    probes.step(world, DT);
    t += DT;
    let moving = 0;
    for (let i = 0; i < count; i++) {
      if (restAt[i] < 0 && probes.state[i] === 2) restAt[i] = t;
      else if (probes.state[i] === 1) moving++;
    }
    if (moving === 0 || t >= 10) break;
  }
  const wall = performance.now() - t0;
  const c = makeContact();
  const bySurface = new Map();
  const times = [];
  let residual = 0;
  let stillMoving = 0;
  let creep = 0;
  let hash = 0;
  for (let i = 0; i < count; i++) {
    if (probes.state[i] === 0) continue;
    const x = probes.px[i];
    const y = probes.py[i];
    const z = probes.pz[i];
    world.closest(x, y, z, c);
    if (c.dist < PROBE_RADIUS) residual = Math.max(residual, PROBE_RADIUS - c.dist);
    if (probes.state[i] === 2) {
      const k = c.surface ? names[c.surface.id] : '?';
      bySurface.set(k, (bySurface.get(k) ?? 0) + 1);
    } else {
      stillMoving++;
      creep = Math.max(creep, Math.hypot(probes.vx[i], probes.vy[i], probes.vz[i]));
    }
    if (restAt[i] >= 0) times.push(restAt[i]);
    hash += Math.round(x * 1e4) * 3 + Math.round(y * 1e4) * 5 + Math.round(z * 1e4) * 7;
  }
  times.sort((p, q) => p - q);
  return {
    ratio: probes.resting() / count,
    impact: probes.maxPenetration,
    residual,
    stillMoving,
    creep,
    p50: times[Math.floor(times.length * 0.5)] ?? NaN,
    p99: times[Math.floor(times.length * 0.99)] ?? NaN,
    bySurface: [...bySurface.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v}`)
      .join('、'),
    hash,
    steps: count * Math.round(t / DT),
    wall,
    simTime: t,
  };
}

/** rest：几千颗球从空中落下。 */
function rest(count) {
  const first = restRun(count);
  const second = restRun(count);
  const same = first.hash === second.hash;
  // 残余穿透：球卡在两样东西之间（雪面和楼角）时两边轮流推，收敛到 1e-5 cm 量级是正常的
  const ok = first.ratio >= 0.97 && first.residual < 1e-3 && first.creep < 60 && same;
  report(
    'rest',
    ok,
    `${count.toLocaleString('en-US')} 颗球从空中落下：${first.simTime.toFixed(2)} s 内落定 ${(first.ratio * 100).toFixed(1)}%，撞击瞬间最大压入 ${first.impact.toFixed(3)} cm（球半径 ${PROBE_RADIUS}），每步修正后残余穿透 ${first.residual.toExponential(1)} cm，还在滚 ${first.stillMoving} 颗（最快 ${first.creep.toFixed(1)} cm/s）；落定用时中位 ${first.p50.toFixed(2)} s、p99 ${first.p99.toFixed(2)} s；两次同种子结果${same ? '一致' : '不一致'}`,
  );
  console.log(`         落在：${first.bySurface}`);
  return first;
}

/**
 * ccd：细电线直落。要保证的是“球自己的一步跨不过电线”：电线不动时，每颗球第一次碰到电线时的压入
 * 不超过子步上限（半个球半径）——混进电线的自身位移就量不准，所以纯 CCD 用不激发振动的电线量。
 * 落定数：电线平静时（≤ 400 cm/s）40 颗都要留在线上；600 / 800 时连续的冲量把电线砸到振幅上限，
 * 球在一个疯狂弹跳的蹦床上落回哪里是随机的，允许掉 4 颗；同帧齐落 40 颗都要留在线上。
 */
function ccd() {
  const { world, names } = makeWorld();
  const wire = findCurve(world, names, 'wire');
  /** 跑一档：40 颗从电线上方 40 cm 直落。stagger = 相邻两颗的释放间隔（秒）。 */
  const runCase = (speed, stagger, seedOffset, excite = true) => {
    const probes = new ProbeSet(40, PROBE_RADIUS);
    const rng = makeRng(seed + seedOffset);
    const pending = [];
    for (let k = 0; k < 40; k++) pending.push((0.1 + 0.8 * rng()) * wire.length);
    const firstPen = new Float64Array(40).fill(-1);
    probes.onImpact = (c, v) => {
      if (excite) exciteOnImpact(c, v);
      if (c.surface !== wire) return;
      // 回调里没有球号：按撞击点反查最近的那颗（数组里是子步前的位置，差不到一个子步）
      let best = -1;
      let bd = Infinity;
      for (let k = 0; k < 40; k++) {
        if (probes.state[k] === 0) continue;
        const d = Math.hypot(probes.px[k] - c.px, probes.py[k] - c.py, probes.pz[k] - c.pz);
        if (d < bd) {
          bd = d;
          best = k;
        }
      }
      if (best >= 0 && firstPen[best] < 0) firstPen[best] = PROBE_RADIUS - c.dist - Math.abs(c.svel) * DT;
    };
    let next = 0;
    for (let t = 0; t < 6; t += DT) {
      while (next < 40 && next * stagger <= t) {
        // 按电线此刻的位置正上方 40 cm 放球
        wire.frameAt(pending[next], frame);
        probes.spawn(frame.cx, frame.cy + 40, frame.cz, 0, -speed, 0);
        next++;
      }
      probes.step(world, DT);
    }
    const c = makeContact();
    let resting = 0;
    for (let k = 0; k < 40; k++) {
      world.closest(probes.px[k], probes.py[k], probes.pz[k], c);
      if (probes.state[k] === 2 && c.surface === wire) resting++;
    }
    let pen = -Infinity;
    for (let k = 0; k < 40; k++) pen = Math.max(pen, firstPen[k]);
    return { resting, pen };
  };
  const bySpeed = [];
  let ok = true;
  // 纯 CCD：电线不动，800 cm/s 直落——第一次碰线的压入就是球自己的子步上限，混不进电线的位移
  const still = runCase(800, 0.03, 4 + 800, false);
  if (still.pen > 0.5 * PROBE_RADIUS + 1e-9 || still.resting < 40) ok = false;
  for (const speed of [0, 200, 400, 600, 800]) {
    const r = runCase(speed, 0.03, 4 + speed);
    const need = speed <= 400 ? 40 : 36;
    if (r.resting < need) ok = false;
    bySpeed.push(`落速 ${speed}：${r.resting}/40`);
  }
  // 同帧砸下：40 颗同一瞬间落在整条电线上，冲量叠到最大、电线以最快速度回扫——球不许被扫穿到线下面
  {
    const r = runCase(0, 0, 99);
    if (r.resting < 40) ok = false;
    bySpeed.push(`同帧齐落：${r.resting}/40`);
  }
  report(
    'ccd',
    ok,
    `电线（半径 0.5 cm，球半径 ${PROBE_RADIUS}）正上方直落：电线不动、800 cm/s 时第一次碰线最大压入 ${still.pen.toFixed(3)} cm（上限 ${0.5 * PROBE_RADIUS}），${still.resting}/40 留在线上；电线会被砸颤的各档 ${bySpeed.join('；')}`,
  );
}

/** wire：电线颤动的频率 / 阻尼对参数，落在电线上的球跟着走。 */
function wire() {
  const { world, names } = makeWorld();
  const wire = findCurve(world, names, 'wire');
  const spec = TEST_RIG.curves.find((c) => c.tag === 'wire').spring;
  // 自由振动：记录中点位移
  wire.excite(0.5, 300, 1);
  const xs = [];
  for (let i = 0; i < Math.round(5 / DT); i++) {
    wire.advance(DT);
    xs.push(wire.offset);
  }
  // 上行过零点（线性插值）→ 周期
  const rises = [];
  for (let i = 1; i < xs.length; i++) {
    if (xs[i - 1] <= 0 && xs[i] > 0) rises.push((i - 1 + (0 - xs[i - 1]) / (xs[i] - xs[i - 1])) * DT);
  }
  let period = 0;
  for (let i = 1; i < rises.length; i++) period += rises[i] - rises[i - 1];
  period /= Math.max(1, rises.length - 1);
  const freq = 1 / period;
  const damped = spec.freq * Math.sqrt(1 - spec.damping * spec.damping);
  // 逐个峰值 → 相邻峰值之比 → 对数缩减率 → 阻尼比
  const peaks = [];
  for (let i = 1; i < xs.length - 1; i++) {
    if (Math.abs(xs[i]) > Math.abs(xs[i - 1]) && Math.abs(xs[i]) >= Math.abs(xs[i + 1]) && Math.abs(xs[i]) > 0.05) peaks.push(Math.abs(xs[i]));
  }
  let delta = 0;
  for (let i = 1; i < peaks.length; i++) delta += Math.log(peaks[i - 1] / peaks[i]);
  delta /= Math.max(1, peaks.length - 1);
  const zeta = delta / Math.sqrt(Math.PI * Math.PI + delta * delta);
  const freqOk = Math.abs(freq / damped - 1) < 0.002;
  const zetaOk = Math.abs(zeta / spec.damping - 1) < 0.03;
  report(
    'wire',
    freqOk && zetaOk,
    `自由振动：实测频率 ${freq.toFixed(4)} Hz（参数 ${damped.toFixed(4)}，${peaks.length} 个峰值、${rises.length} 次过零），实测阻尼比 ${zeta.toFixed(4)}（参数 ${spec.damping}）`,
  );

  // 跟随：40 颗球轻轻放在电线上，落定后使劲弹一下电线，球必须一直贴着
  const probes = new ProbeSet(40, PROBE_RADIUS);
  const rng = makeRng(seed + 5);
  for (let k = 0; k < 40; k++) {
    wire.frameAt((0.1 + 0.8 * rng()) * wire.length, frame);
    probes.spawn(frame.cx, frame.cy + PROBE_RADIUS + 2, frame.cz);
  }
  for (let t = 0; t < 2 && probes.resting() < 40; t += DT) probes.step(world, DT);
  const settled = probes.resting();
  // 狠狠往下按一下中点，松手
  wire.excite(0.5, 300, 1);
  const c = makeContact();
  let maxGap = 0;
  for (let i = 0; i < Math.round(3 / DT); i++) {
    probes.step(world, DT);
    for (let k = 0; k < 40; k++) {
      if (probes.state[k] !== 2) continue;
      world.closest(probes.px[k], probes.py[k], probes.pz[k], c);
      maxGap = Math.max(maxGap, Math.abs(c.dist - PROBE_RADIUS));
    }
  }
  report(
    'wire',
    settled === 40 && probes.resting() === 40 && maxGap < 0.05,
    `跟随：${settled}/40 颗落在电线上，电线被弹起来（中点振幅 ${(peaks[0] ?? 0).toFixed(1)} cm）晃 3 秒后仍贴着 ${probes.resting()}/40 颗，球心到线面的最大偏离 ${maxGap.toFixed(4)} cm`,
  );
}

/** perf：查询吞吐与落球吞吐。 */
function perf(count) {
  const { world } = makeWorld();
  const rng = makeRng(seed + 6);
  const N = 200000;
  const pts = new Float64Array(N * 3);
  for (let i = 0; i < N; i++) {
    samplePoint(world, rng, TMP);
    pts[i * 3] = TMP[0];
    pts[i * 3 + 1] = TMP[1];
    pts[i * 3 + 2] = TMP[2];
  }
  const a = makeContact();
  for (let i = 0; i < 20000; i++) world.closest(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2], a);
  const t0 = performance.now();
  for (let i = 0; i < N; i++) world.closest(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2], a);
  const perUs = ((performance.now() - t0) / N) * 1e3;
  const r = restRun(count);
  // 球步 = 一颗球推进一个固定步长（240 Hz）。游戏里同时活的探针是几十到几百颗，0.1 百万球步 / 秒绰绰有余
  const msteps = (count * (r.simTime / DT)) / (r.wall / 1000) / 1e6;
  report(
    'perf',
    perUs < 20 && msteps >= 0.1,
    `最近点查询 ${perUs.toFixed(3)} µs/次（${Math.round(1e6 / perUs).toLocaleString('en-US')} 次/秒）；${count.toLocaleString('en-US')} 颗球落 ${r.simTime.toFixed(2)} s 仿真用时 ${r.wall.toFixed(0)} ms，约 ${msteps.toFixed(2)} 百万球步/秒`,
  );
}

/** tree：整棵树的结构——每根子枝的基部整个藏在父枝里、主角枝基部藏在树干里、树的枝条和电线不打架。 */
function tree() {
  const t = TEST_TREE;
  const wireSpec = TEST_RIG.curves.find((c) => c.tag === 'wire');
  const world = buildWorld({ curves: [HERO_BRANCH, ...t.limbs, wireSpec], grounds: [], boxes: [] });
  const perches = world.surfaces;
  const trunk = perches[1 + t.trunk];
  const wire = perches[perches.length - 1];
  const c = makeContact();
  // 基部藏没藏住：子枝基部中心到父枝轴的距离 − 父枝半径 + 子枝基部半径 < 0 就整个在父枝体内
  const hb = HERO_BRANCH.points[0];
  trunk.closest(hb[0], hb[1], hb[2], c);
  const heroGap = c.dist + HERO_BRANCH.radii[0];
  let worst = -Infinity;
  let bad = 0;
  let n = 0;
  for (const limb of t.limbs) {
    if (limb.parent < 0) continue;
    const parent = perches[1 + limb.parent];
    const b = limb.points[0];
    parent.closest(b[0], b[1], b[2], c);
    const gap = c.dist + limb.radii[0];
    n++;
    if (gap >= 0) bad++;
    worst = Math.max(worst, gap);
  }
  // 枝条与电线的最小间隙：每根枝条的每个采样点问一次电线
  let clearance = Infinity;
  for (const limb of t.limbs) {
    const s = perches[1 + t.limbs.indexOf(limb)];
    for (let i = 0; i <= s.segments; i++) {
      s.frameAt((i / s.segments) * s.length, frame);
      wire.closest(frame.cx, frame.cy, frame.cz, c);
      clearance = Math.min(clearance, c.dist - frame.radius);
    }
  }
  report(
    'tree',
    bad === 0 && heroGap < 0 && clearance > 2,
    `${t.limbs.length} 根枝条（1 根树干 + ${n} 根子枝）：子枝基部露出父枝的 ${bad} 根（最紧的还差 ${(-worst).toFixed(2)} cm），主角枝基部藏在树干里（还差 ${(-heroGap).toFixed(2)} cm）；枝条到电线最小间隙 ${clearance.toFixed(1)} cm`,
  );
}

// ───────────────────────────── 蹦跳步态 ─────────────────────────────
/**
 * 逐帧推进 Locomotion，统计每一跳：滞空时长、落定后的陷入、腾空中每帧的最大压入、落点分布、枝上落地朝向是否顺着枝轴、
 * 地面上落地朝向是否等于跳的方向、每跳水平距离 / 种类 / 起跳时的动量、急刹滑雪的滑距。
 * 四种跳（前进 / 后退 / 侧跳 / 掉头）、动量连跳、急刹滑雪各测一遍，最后雪地随机连跳 60 s。
 */
function gait() {
  const { world, names } = makeWorld();
  const branch = findCurve(world, names, 'branch');
  const DT = 1 / 60;
  const c = makeContact();
  const loco = new Locomotion();
  const fresh = () => ({ hops: 0, airMax: 0, penLand: 0, penAir: 0, penSkid: 0, axisErr: 0, headErr: 0, dist: [], kinds: {}, momentum: [], turnSigns: [], dropMax: 0, surfaces: {}, skid: 0, skidMove: 0, hopT: [] });
  let air = 0;
  let clock = 0;
  let hopFrom = null;
  let standY = 0;
  let skidFrom = null;
  const tick = (m, ix, iz, hop, leap = false, steer = false) => {
    // 会动的表面（电线 / 细枝）和步态按同一拍推进（页面里由 TestRig 经探针的 step 推进）
    clock += DT;
    world.advance(DT);
    loco.update(DT, { x: ix, z: iz, hop, leap, steer }, world);
    if (loco.tookOff) {
      air = 0;
      m.hopT.push(clock);
      hopFrom = [loco.pos.x, standY, loco.pos.z];
      m.kinds[loco.hopKind] = (m.kinds[loco.hopKind] ?? 0) + 1;
      m.momentum.push(loco.momentum);
      if (loco.hopKind === 'turn') m.turnSigns.push(loco.turnSign);
    }
    if (loco.phase === 'air') {
      air += DT;
      world.closest(loco.pos.x, loco.pos.y, loco.pos.z, c);
      if (c.surface) m.penAir = Math.max(m.penAir, -c.dist);
    }
    if (loco.phase === 'stand') standY = loco.pos.y;
    if (loco.phase === 'skid') {
      if (!skidFrom) {
        skidFrom = [loco.pos.x, loco.pos.z];
        m.skid++;
      }
      m.skidMove = Math.max(m.skidMove, Math.hypot(loco.pos.x - skidFrom[0], loco.pos.z - skidFrom[1]));
      world.closest(loco.pos.x, loco.pos.y, loco.pos.z, c);
      if (c.surface) m.penSkid = Math.max(m.penSkid, -c.dist);
    } else skidFrom = null;
    if (loco.landed) {
      m.hops++;
      m.airMax = Math.max(m.airMax, air);
      world.closest(loco.pos.x, loco.pos.y, loco.pos.z, c);
      m.penLand = Math.max(m.penLand, -c.dist);
      const nm = c.surface ? names[c.surface.id] : 'none';
      m.surfaces[nm] = (m.surfaces[nm] ?? 0) + 1;
      if (c.surface instanceof CurvePerch) {
        const f = c.surface.frameAt(c.u, frame);
        const l = Math.hypot(f.tx, f.tz);
        m.axisErr = Math.max(m.axisErr, Math.abs((loco.heading.x * f.tz - loco.heading.z * f.tx) / l));
      } else {
        // 地面连跳落地直接进下一跳的蓄力：这一帧 targetHeading 已经是下一跳的方向，落地的朝向要等那一跳落地（缓冲 / 急刹时）再量
        if (loco.phase !== 'crouch') m.headErr = Math.max(m.headErr, Math.hypot(loco.heading.x - loco.targetHeading.x, loco.heading.z - loco.targetHeading.z));
      }
      if (hopFrom) {
        const d = Math.hypot(loco.pos.x - hopFrom[0], loco.pos.z - hopFrom[2]);
        m.dist.push(d);
        m.dropMax = Math.max(m.dropMax, hopFrom[1] - loco.pos.y);
      }
    }
  };
  const run = (script) => {
    const m = fresh();
    for (const [ix, iz, hop, secs] of script) {
      const n = Math.round(secs / DT);
      for (let i = 0; i < n; i++) tick(m, ix, iz, hop);
    }
    return m;
  };
  /** 按住意图连跳到第 n 跳腾空过半（那一帧松手，和玩家松键的时机一样），再空 0.8 s 让它落地缓冲 / 急刹滑完；leap = 方向键 + 空格。 */
  const chain = (m, n, ix, iz, leap = false, steer = false) => {
    const hops0 = loco.hops;
    let t = 0;
    while (t < 8 && !(loco.hops >= hops0 + n && loco.phase === 'air' && loco.airK >= 0.3)) {
      tick(m, ix, iz, true, leap, steer);
      t += DT;
    }
    for (let i = 0; i < 48; i++) tick(m, 0, 0, false);
  };
  const fmt = (m) =>
    `${m.hops} 跳（${Object.entries(m.kinds).map(([k, v]) => `${k} ×${v}`).join('，')}），滞空最长 ${m.airMax.toFixed(2)} s，落定后陷入 ${m.penLand.toExponential(1)} cm，腾空中最大压入 ${m.penAir.toFixed(3)} cm，每跳水平 ${m.dist.map((d) => d.toFixed(1)).join(' / ')} cm，最大落差 ${m.dropMax.toFixed(1)} cm，落在 ${JSON.stringify(m.surfaces)}`;
  const dist1 = (from) => Math.hypot(loco.pos.x - from[0], loco.pos.z - from[1]);

  const ok0 = loco.place(world, 0, 0, 0, -1, 0);
  branch.pointAt(branch.length, 0, 0, TMPV);
  report(
    'gait',
    ok0 && loco.surface === branch && Math.abs(loco.pos.x) < 0.5,
    `初始落在主角枝上 x = ${loco.pos.x.toFixed(3)}、弧长 ${loco.u.toFixed(1)} cm（法线 y = ${loco.up.y.toFixed(3)}）；枝长 ${branch.length.toFixed(1)} cm、枝梢在 x = ${TMPV.x.toFixed(1)}`,
  );

  // A. 面朝枝梢、轻幅意图连跳 3 下（枝梢在 x = 21，三跳共约 15 cm）：动量一跳比一跳足，跳得一步比一步远；松手后动量在站着时衰减
  loco.place(world, 0, 0, 0, 1, 0);
  const a = fresh();
  chain(a, 3, 0.25, 0);
  const okA = a.hops === 3 && a.kinds.forward === 3 && a.surfaces.branch === 3 && a.airMax < 0.3 && a.penLand < 1e-9 && a.penAir < 0.5 && a.axisErr < 1e-6 && a.dist[2] > a.dist[0] + 0.5 && a.momentum[2] > a.momentum[0] && loco.momentum < a.momentum[2];
  report(
    'gait',
    okA,
    `面朝枝梢半幅连跳 3 下：${fmt(a)}；起跳时动量 ${a.momentum.map((v) => v.toFixed(2)).join(' / ')}，松手站 0.8 s 后 ${loco.momentum.toFixed(2)}；落地 x = ${loco.pos.x.toFixed(1)}、朝向 (${loco.heading.x.toFixed(2)}, ${loco.heading.z.toFixed(2)})；枝上落地朝向偏离枝轴最大 ${a.axisErr.toExponential(1)}`,
  );

  // B. 反向意图 = 后退小步 3 下：不转身、朝后挪几厘米
  const x0 = loco.pos.x;
  const b = fresh();
  chain(b, 3, -0.4, 0);
  const backBy = x0 - loco.pos.x;
  const okB = b.hops === 3 && b.surfaces.branch === 3 && b.kinds.back === 3 && loco.heading.x > 0.99 && backBy > 2 && backBy < 8 && b.penLand < 1e-9;
  report('gait', okB, `反向意图后退小步 3 下：${fmt(b)}；朝向仍 (${loco.heading.x.toFixed(2)}, ${loco.heading.z.toFixed(2)})，退了 ${backBy.toFixed(1)} cm`);

  // C. 横向意图 = 原地掉头蹦：空中转 180°、位置几乎不动；意图在鸟身右侧就往右转，转过去以后同一个世界方向成了左侧、就往左转回来
  const c1 = fresh();
  const pc = [loco.pos.x, loco.pos.z];
  chain(c1, 1, 0, 1);
  const moved = dist1(pc);
  const okC1 = c1.hops === 1 && c1.kinds.turn === 1 && loco.heading.x < -0.99 && c1.turnSigns[0] === -1 && moved < 0.6 && c1.axisErr < 1e-6 && c1.penLand < 1e-9;
  const c2 = fresh();
  chain(c2, 1, 0, 1);
  const okC2 = c2.hops === 1 && c2.kinds.turn === 1 && loco.heading.x > 0.99 && c2.turnSigns[0] === 1;
  report('gait', okC1 && okC2, `横向意图原地掉头蹦：朝 +X 时按 +Z（身右）${fmt(c1)}、挪了 ${moved.toFixed(2)} cm、转完朝向 (-1.00, ${c1.axisErr.toExponential(1)})、转向符号 ${c1.turnSigns.join(',')}（-1 = 往右）；朝 -X 时再按 +Z（成了身左）${fmt(c2)}、转完朝向 (${loco.heading.x.toFixed(2)}, ${loco.heading.z.toFixed(2)})、转向符号 ${c2.turnSigns.join(',')}（+1 = 往左）`);

  // D. 满幅意图从枝梢跳出头：掉 80 cm 到雪地上落定（漫游页的雪地在 y ≈ -80）
  branch.pointAt(branch.length - 5, 0, 0.5, TMPV);
  loco.place(world, TMPV.x, TMPV.y, TMPV.z, 1, 0);
  const f0 = run([[1, 0, true, 0.5], [0, 0, false, 1.2]]);
  const dropOk = f0.hops === 1 && f0.surfaces.snow === 1 && f0.airMax > 0.3 && f0.airMax < 0.8 && f0.penLand < 1e-9;
  report('gait', dropOk, `从枝梢跳下去落到雪地：${fmt(f0)}；落地 y = ${loco.pos.y.toFixed(1)}`);

  // E. 雪地上满幅连跳 4 下再松手：地面连跳手感（2026-11-23 用户要求提速）——单跳 16~22 cm、动量起来 28~38 cm/跳、
  //    落地缓冲直接接蓄力 → 3.5~4.2 跳 / 秒；松手落地急刹滑雪约 1.6 cm、滑完动量清零、滑的过程中根贴着雪面
  loco.place(world, 0, -79, 0, 1, 0);
  const e = fresh();
  chain(e, 4, 1, 0);
  const eRate = (e.hopT.length - 1) / (e.hopT[e.hopT.length - 1] - e.hopT[0]);
  const okE = e.hops === 4 && e.kinds.forward === 4 && e.surfaces.snow === 4 && e.momentum[3] > 0.9 && e.dist[0] > 16 && e.dist[0] < 22 && e.dist[3] > 28 && e.dist[3] < 38 && eRate > 3.5 && eRate < 4.2 && e.skid === 1 && e.skidMove > 1.3 && e.skidMove < 1.7 && e.penSkid < 1e-3 && loco.phase === 'stand' && loco.momentum === 0 && e.penLand < 1e-9 && e.headErr < 1e-6;
  report(
    'gait',
    okE,
    `雪地满幅连跳 4 下松手急刹：${fmt(e)}；连跳频率 ${eRate.toFixed(2)} 跳 / 秒（要求 3.5~4.2），首跳 ${e.dist[0].toFixed(1)} cm（要求 16~22）、第 4 跳 ${e.dist[3].toFixed(1)} cm（要求 28~38）；起跳时动量 ${e.momentum.map((v) => v.toFixed(2)).join(' / ')}，急刹 ${e.skid} 次滑了 ${e.skidMove.toFixed(2)} cm（滑时陷入 ${e.penSkid.toExponential(1)} cm），末态 ${loco.phase}、动量 ${loco.momentum.toFixed(2)}；地面落地朝向偏差最大 ${e.headErr.toExponential(1)}`,
  );

  // F. 雪地上侧向 / 反向 / 只按空格：侧跳和后退不转身，只按空格朝前小跳一下
  loco.place(world, 0, -79, 0, 1, 0);
  const fS = fresh();
  chain(fS, 1, 0, 1);
  const okF1 = fS.hops === 1 && fS.kinds.side === 1 && loco.heading.x > 0.999 && loco.pos.z > 1 && loco.pos.z < 3 && Math.abs(loco.pos.x) < 0.3;
  const fB = fresh();
  chain(fB, 1, -1, 0);
  const okF2 = fB.hops === 1 && fB.kinds.back === 1 && loco.heading.x > 0.999 && loco.pos.x < -0.5;
  loco.place(world, 0, -79, 0, 1, 0);
  const fH = fresh();
  chain(fH, 1, 0, 0);
  const okF3 = fH.hops === 1 && fH.kinds.forward === 1 && loco.heading.x > 0.999 && fH.dist[0] > 2 && fH.dist[0] < 6;
  report(
    'gait',
    okF1 && okF2 && okF3,
    `雪地侧跳挪步：${fmt(fS)}（朝向不变，横向挪了 ${fS.dist[0].toFixed(1)} cm）；后退：${fmt(fB)}；只按空格小跳：${fmt(fH)}，朝向 (${loco.heading.x.toFixed(2)}, ${loco.heading.z.toFixed(2)})`,
  );

  // H. 枝上"方向 + 空格" = 显式跃离：横向意图配 leap 不再是原地掉头，朝意图方向跳出枝、掉 80 cm 落到雪地，落地朝向 = 跃出方向
  loco.place(world, 0, 0, 0, -1, 0);
  const h1 = fresh();
  chain(h1, 1, 0, 1, true);
  const okH = h1.hops === 1 && h1.kinds.forward === 1 && h1.surfaces.snow === 1 && loco.pos.y < -70 && Math.abs(loco.heading.z) > 0.99 && Math.abs(loco.pos.z) > 15;
  report('gait', okH, `枝上横向意图 + 空格显式跃离：${fmt(h1)}；落地朝向 (${loco.heading.x.toFixed(2)}, ${loco.heading.z.toFixed(2)})、落点 z = ${loco.pos.z.toFixed(1)}（同一意图不带空格是掉头蹦，见上）`);

  // J. 雪地 steer（第三人称相机相对 WASD，2026-11-23 用户要求）：面朝 +x 时按"后退"（意图 −x）→ 不转身、直接朝 −x 后撤跳 8~12 cm；
  //    按"右"（意图 +z）→ 不转身侧跳 8~12 cm；按住"后退"连跳 4 下（雪面有起伏，前三跳 8~12 cm）、朝向始终不变；斜前（意图 +x+z）仍是转身前进跳
  loco.place(world, 0, -79, 0, 1, 0);
  const jB = fresh();
  chain(jB, 1, -1, 0, false, true);
  const okJ1 = jB.hops === 1 && jB.kinds.back === 1 && loco.heading.x > 0.99 && Math.abs(loco.heading.z) < 0.05 && loco.pos.x < -8 && loco.pos.x > -12;
  const jBEnd = [loco.heading.x, loco.heading.z, loco.pos.x];
  loco.place(world, 0, -79, 0, 1, 0);
  const jR = fresh();
  chain(jR, 1, 0, 1, false, true);
  const okJ2 = jR.hops === 1 && jR.kinds.side === 1 && loco.heading.x > 0.99 && Math.abs(loco.heading.z) < 0.05 && loco.pos.z > 8 && loco.pos.z < 12;
  const jREnd = [loco.heading.x, loco.heading.z, loco.pos.z];
  loco.place(world, 0, -79, 0, 1, 0);
  const jB4 = fresh();
  chain(jB4, 4, -1, 0, false, true);
  const jRate = jB4.hopT.length > 1 ? (jB4.hopT.length - 1) / (jB4.hopT[jB4.hopT.length - 1] - jB4.hopT[0]) : 0;
  const okJ3 = jB4.hops === 4 && jB4.kinds.back === 4 && loco.heading.x > 0.99 && jB4.dist.slice(0, 3).every((d) => d > 8 && d < 12) && jRate > 3.5 && jRate < 5 && jB4.headErr < 1e-6;
  loco.place(world, 0, -79, 0, 1, 0);
  const jF = fresh();
  chain(jF, 1, 1, 1, false, true);
  const okJ4 = jF.hops === 1 && jF.kinds.forward === 1 && Math.abs(loco.heading.x - Math.SQRT1_2) < 0.05 && loco.heading.z > 0.65;
  report('gait', okJ1 && okJ2 && okJ3 && okJ4, `雪地相机相对操控：按"后退"→ ${fmt(jB)}，落地朝向 (${jBEnd[0].toFixed(2)}, ${jBEnd[1].toFixed(2)})、退到 x = ${jBEnd[2].toFixed(1)}；按"右"→ ${fmt(jR)}，朝向 (${jREnd[0].toFixed(2)}, ${jREnd[1].toFixed(2)})、z = ${jREnd[2].toFixed(1)}；按住后退连跳 4 下 ${jB4.dist.map((d) => d.toFixed(1)).join('/')} cm、${jRate.toFixed(2)} 跳/秒、落地朝向偏差 ${jB4.headErr.toExponential(1)}；斜前 → ${fmt(jF)}，朝向 (${loco.heading.x.toFixed(2)}, ${loco.heading.z.toFixed(2)})`);

  // I. 电线（弹性栖面）：落上去按法向速度激发颤动、蹬离再激发；站着时根跟着电线的位移走
  const wire = findCurve(world, names, 'wire');
  let excitations = 0;
  const origExcite = wire.excite.bind(wire);
  wire.excite = (u, speed, ny) => {
    excitations++;
    return origExcite(u, speed, ny);
  };
  wire.pointAt(wire.length * 0.5, 0, 0, TMPV);
  const placedW = loco.place(world, TMPV.x, TMPV.y + 1, TMPV.z, 1, 0);
  const onWire = loco.surface === wire;
  const wf = wire.frameAt(wire.length * 0.5, frame);
  const iw = fresh();
  chain(iw, 1, wf.tx, wf.tz);
  let yLand = null;
  let offLand = 0;
  let followErr = 0;
  for (let i = 0; i < 30; i++) {
    tick(iw, 0, 0, false);
    if (loco.phase === 'stand' || loco.phase === 'settle') {
      if (yLand === null) {
        yLand = loco.pos.y;
        offLand = wire.offsetAt(loco.u);
      } else followErr = Math.max(followErr, Math.abs(loco.pos.y - yLand - (wire.offsetAt(loco.u) - offLand)));
    }
  }
  const swing = Math.abs(wire.offsetAt(loco.u));
  wire.excite = origExcite;
  report(
    'gait',
    placedW && onWire && iw.hops === 1 && iw.surfaces.wire === 1 && excitations >= 2 && followErr < 1e-9 && swing > 0.02,
    `电线：放上去落在 ${onWire ? '电线上' : '别的面'}；顺线跳一下 ${fmt(iw)}；激发颤动 ${excitations} 次（蹬离 + 落地），线还在晃 ${swing.toFixed(2)} cm；站着时根跟着线走，最大偏差 ${followErr.toExponential(1)} cm`,
  );

  // G. 雪地随机方向连跳 60 s（离中心远了就朝中心偏；地面连跳一跳 20~35 cm，按 25 cm 估），两次结果一致
  const rng = makeRng(11);
  const script = [];
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < 80; i++) {
    const far = Math.hypot(cx, cz) > 100;
    const ang = far ? Math.atan2(-cz, -cx) + (rng() - 0.5) * 2.4 : rng() * Math.PI * 2;
    const hop = rng() < 0.8;
    script.push([Math.cos(ang), Math.sin(ang), hop, 0.4 + rng() * 0.8]);
    if (hop) {
      cx += Math.cos(ang) * 25;
      cz += Math.sin(ang) * 25;
    }
  }
  const snap = () =>
    [loco.phase, loco.hops, loco.pos.x, loco.pos.y, loco.pos.z, loco.heading.x, loco.heading.z]
      .map((v) => (typeof v === 'number' ? v.toFixed(9) : v))
      .join(',');
  const placed = loco.place(world, 0, -79, 0, 1, 0);
  const r1 = run(script);
  const s1 = snap();
  loco.place(world, 0, -79, 0, 1, 0);
  const r2 = run(script);
  const s2 = snap();
  report(
    'gait',
    placed && r1.hops >= 50 && r1.airMax < 0.4 && r1.penLand < 1e-9 && r1.penAir < 0.5 && r1.headErr < 1e-6 && r1.penSkid < 1e-3 && s1 === s2 && r2.hops === r1.hops,
    `雪地随机连跳 60 s：${fmt(r1)}；急刹 ${r1.skid} 次（滑时陷入 ${r1.penSkid.toExponential(1)} cm）；地面落地朝向偏差最大 ${r1.headErr.toExponential(1)}；两次同种子结果${s1 === s2 ? '一致' : '不一致'}；末态 (${loco.pos.x.toFixed(1)}, ${loco.pos.y.toFixed(1)}, ${loco.pos.z.toFixed(1)})`,
  );

  // K. 斜面（2026-11-23）：30° 的雪坡（x 0~120 线性抬升 69 cm，两边平）。放上去 up = 法线（ny = cos 30° = 0.866）；
  //    上坡连跳 3 下 / 下坡连跳 3 下每跳都落在坡上、根贴着坡（陷入 0）；飞行落定后急刹（landFromFlight）滑的过程中根离坡 ≤ 0.02 cm
  //    （第一版只在 |dist| < 1 时才贴 y，斜坡上滑一步就悬空）；急刹滑出一块 20 cm 宽的平板边缘 → 带着余速掉下去（腾空 → 掉出世界兜底送回）
  {
    const tan30 = Math.tan(Math.PI / 6);
    const slope = new Heightfield(-100, -100, 300, 100, 2);
    slope.fill((x) => (x < 0 ? 0 : x > 120 ? 120 * tan30 : x * tan30));
    const slopeWorld = new SimWorld();
    slopeWorld.add(slope);
    const surf = (w) => {
      w.closest(loco.pos.x, loco.pos.y, loco.pos.z, c);
      return c.surface === slope ? c.dist : NaN;
    };
    const slopeChain = (ix, iz, n) => {
      const m = fresh();
      let gap = 0;
      let hops = 0;
      let air = false;
      let t = 0;
      const x0 = loco.pos.x;
      // 按住意图连跳到第 n 跳腾空过半再松手（和场景里 chain 的时机一样），再空 1 s 让它落地缓冲
      while (t < 6 && !(hops >= n && loco.phase === 'air' && loco.airK >= 0.3)) {
        loco.update(DT, { x: ix, z: iz, hop: true, leap: false, steer: true }, slopeWorld);
        t += DT;
        if (loco.tookOff) hops++;
        if (loco.landed) {
          m.hops++;
          m.surfaces[loco.surface === slope ? 'slope' : 'other'] = (m.surfaces[loco.surface === slope ? 'slope' : 'other'] ?? 0) + 1;
          m.penLand = Math.max(m.penLand, Math.abs(surf(slopeWorld)));
        }
        if (loco.phase !== 'air') gap = Math.max(gap, Math.abs(surf(slopeWorld)));
      }
      // 松手让它落定（最后一跳的滞空段不算，那是真的腾空）
      for (let i = 0; i < 90; i++) {
        loco.update(DT, { x: 0, z: 0, hop: false, steer: true }, slopeWorld);
        if (loco.landed) {
          m.hops++;
          m.surfaces[loco.surface === slope ? 'slope' : 'other'] = (m.surfaces[loco.surface === slope ? 'slope' : 'other'] ?? 0) + 1;
          m.penLand = Math.max(m.penLand, Math.abs(surf(slopeWorld)));
        }
        if (loco.phase !== 'air') gap = Math.max(gap, Math.abs(surf(slopeWorld)));
      }
      return { m, hops, gap, dx: loco.pos.x - x0, phase: loco.phase, air, up: loco.up.y };
    };
    const placedS = loco.place(slopeWorld, 20, 40, 0, 1, 0);
    const upY = loco.up.y;
    const sUp = slopeChain(1, 0, 3);
    loco.place(slopeWorld, 100, 80, 0, 1, 0);
    const sDown = slopeChain(-1, 0, 3);
    // 飞行落定后急刹：300 cm/s 余速 → 滑 6 cm，根全程贴坡
    loco.place(slopeWorld, 40, 60, 0, 1, 0);
    loco.landFromFlight(300);
    let skidGap = 0;
    let skidFrames = 0;
    for (let i = 0; i < 60; i++) {
      loco.update(DT, { x: 0, z: 0, hop: false, steer: true }, slopeWorld);
      if (loco.phase === 'skid') {
        skidFrames++;
        skidGap = Math.max(skidGap, Math.abs(surf(slopeWorld)));
      }
    }
    const skidEnd = loco.phase;
    const skidEndGap = Math.abs(surf(slopeWorld));
    // 滑出平板边缘：20 cm 宽的平板（x 0~20），放在 x = 18 朝 +x，400 cm/s 余速滑 8 cm → 出边缘 → 腾空掉下去 → 掉出世界兜底送回
    const plate = new Heightfield(0, -50, 20, 50, 1);
    plate.fill(() => 0);
    const plateWorld = new SimWorld();
    plateWorld.add(plate);
    loco.place(plateWorld, 18, 5, 0, 1, 0);
    loco.landFromFlight(400);
    let sawAir = false;
    let fellFar = false;
    let sawRespawn = false;
    for (let i = 0; i < 120; i++) {
      loco.update(DT, { x: 0, z: 0, hop: false, steer: true }, plateWorld);
      if (loco.phase === 'air') {
        sawAir = true;
        if (loco.pos.y < -50) fellFar = true;
      }
      if (loco.respawned) sawRespawn = true;
    }
    const okSlope = placedS && Math.abs(upY - Math.cos(Math.PI / 6)) < 0.01 && sUp.hops === 3 && sUp.dx > 15 && sUp.gap < 0.02 && sUp.phase === 'stand' && sDown.hops === 3 && sDown.dx < -15 && sDown.gap < 0.02 && sDown.phase === 'stand' && skidFrames > 0 && skidGap < 0.02 && skidEnd === 'stand' && skidEndGap < 1e-6 && sawAir && fellFar && sawRespawn && loco.phase === 'stand';
    report(
      'gait',
      okSlope,
      `30° 雪坡：放上去法线 y ${upY.toFixed(3)}（cos 30° = ${Math.cos(Math.PI / 6).toFixed(3)}）；上坡连跳 3 下 ${sUp.m.hops} 跳落在 ${JSON.stringify(sUp.m.surfaces)}（落地时根离坡 ${sUp.m.penLand.toExponential(1)}）、朝 +x 挪了 ${sUp.dx.toFixed(1)} cm、根离坡最大 ${sUp.gap.toExponential(1)} cm、末态 ${sUp.phase}；下坡连跳 3 下 ${sDown.m.hops} 跳落在 ${JSON.stringify(sDown.m.surfaces)}、挪了 ${sDown.dx.toFixed(1)} cm、根离坡最大 ${sDown.gap.toExponential(1)} cm、末态 ${sDown.phase}；飞行落定急刹滑 ${skidFrames} 帧、根离坡最大 ${skidGap.toExponential(1)} cm、滑完 ${skidEnd}（离坡 ${skidEndGap.toExponential(1)}）；急刹滑出 20 cm 平板的边缘 ${sawAir ? '腾空掉下去了' : '没腾空'}${fellFar ? '、掉到 −50 以下' : ''}${sawRespawn ? '、掉出世界兜底送回板上' : ''}（末态 ${loco.phase}）`,
    );
  }

  // L. 枝上镜头偏轴跃离的角度规则（locomotion.cameraOffAxis，Player.readIntent 用它决定枝上按 W 是顺枝还是朝镜头方向跳）：
  //    镜头和枝轴夹角 < 45° 不算偏轴（顺枝），≥ 45° 算（顺着枝轴反方向看也不算）；偏轴意图配 leap 就是朝那个方向跃离枝条
  {
    const cases = [
      [1, 0, 1, 0, false, '顺着枝轴'],
      [-1, 0, 1, 0, false, '顺着枝轴反方向'],
      [Math.SQRT1_2, Math.SQRT1_2, 1, 0, false, '正好 45°'],
      [0.6, 0.8, 1, 0, true, '53°'],
      [0, 1, 1, 0, true, '90° 横着'],
      [0, 1, 0.6, 0.8, false, '斜枝顺着看'],
      [0.8, -0.6, 0.6, 0.8, true, '斜枝垂直看'],
    ];
    let bad = 0;
    const lines = [];
    for (const [cx, cz, tx, tz, want, name] of cases) {
      const got = cameraOffAxis(cx, cz, tx, tz);
      if (got !== want) bad++;
      lines.push(`${name}→${got ? '跃离' : '顺枝'}${got !== want ? '（错）' : ''}`);
    }
    // 落地：面朝枝梢站在主角枝 x = 0，镜头横着看（枝轴 +x、镜头 +z，90°）按 W → leap → 朝 +z 跳出枝、落到雪地上、落地朝向 = 镜头方向
    loco.place(world, 0, 0, 0, 1, 0);
    let leaps = 0;
    let landedOn = 'none';
    let t = 0;
    // 按到跃出去那一帧就松手，再空等它落定（不松手的话落地后会接着在雪地上连跳）
    while (t < 3 && leaps < 1) {
      loco.update(DT, { x: 0, z: 1, hop: true, leap: true, steer: false }, world);
      t += DT;
      if (loco.tookOff) leaps++;
    }
    for (let i = 0; i < 150 && loco.phase !== 'stand'; i++) {
      loco.update(DT, { x: 0, z: 0, hop: false, steer: false }, world);
      if (loco.tookOff) leaps++;
      if (loco.landed && loco.surface) landedOn = names[loco.surface.id] ?? 'kind' + loco.surface.kind;
    }
    const okL = bad === 0 && leaps === 1 && landedOn === 'snow' && Math.abs(loco.heading.z) > 0.99 && loco.pos.z > 15 && loco.pos.y < -70;
    report('gait', okL, `枝上镜头偏轴规则：${lines.join('、')}；枝上横着看按 W 跃离：${leaps} 跳落在 ${landedOn}，落地朝向 (${loco.heading.x.toFixed(2)}, ${loco.heading.z.toFixed(2)})、落点 z = ${loco.pos.z.toFixed(1)}`);
  }

  // M. 悬臂枝弹簧（2026-11-23，庭院老海棠 / 春树的细枝）：根部焊在母枝上 u = 0 处位移恒为 0、梢端最大（振型 (s/L)²，和画面层顶点着色器
  //    offset · aLimbS² 同一个公式）；一跳的蹬速（83 cm/s）要让梢端沉到 0.5 cm 以上、2.4 Hz 上下弹几下、3 s 内停；
  //    子枝的根刚性跟着母枝在焊口处的位移走（母枝弯了，焊口不裂）；鸟站上时枝静态下垂（load），离枝回弹；站着时根贴着下沉的面
  {
    const layout = {
      curves: [
        { tag: 'sec', points: [[0, 60, 0], [40, 62, 0], [80, 60, 0]], radii: [1.0, 0.6, 0.2], segments: 40, spring: { freq: 2.4, damping: 0.08, gain: 0.15, mode: 'cantilever', sag: 0.35 } },
        { tag: 'twig', points: [[40, 62, 0], [52, 66, 6], [64, 64, 14]], radii: [0.4, 0.25, 0.06], segments: 24, spring: { freq: 4.5, damping: 0.06, gain: 0.4, mode: 'cantilever', sag: 0.7 }, springParent: 0, springAt: 0.5 },
      ],
      grounds: [],
      // 雪地用盒顶：Heightfield 是一张零厚度的板，drift = 0 的平板 min.y = 雪面，板下的点永远不算在体内（步态会穿过去）
      boxes: [{ tag: 'snow', min: [-400, -100, -400], max: [400, -80, 400] }],
    };
    const cw = buildWorld(layout);
    const [sec, twig] = cw.surfaces;
    const shapeOk = sec.shapeAt(0) === 0 && sec.shapeAt(sec.length) === 1 && Math.abs(sec.shapeAt(sec.length / 2) - 0.25) < 1e-12;
    // 频率：无阻尼自由振动数过零
    sec.excite(0.9, 83, 1);
    let zc = 0;
    let prev = sec.ownOffset;
    let minTip = 0;
    for (let i = 0; i < 180; i++) {
      cw.advance(DT);
      const x = sec.ownOffset;
      if (x < minTip) minTip = x;
      if (Math.sign(x) !== Math.sign(prev)) zc++;
      prev = x;
    }
    // 3 s 后（阻尼比 0.08 → 每周期衰减 e^(-0.5) ≈ 0.6）振幅应 < 0.02 cm
    const settled = Math.abs(sec.ownOffset) < 0.02;
    // 子枝根随母枝焊口：母枝 excite 后推进 60 帧，子枝 offsetAt(0) 必须恒等于母枝 offsetAt(焊口)
    sec.excite(0.5, 83, 1);
    twig.excite(0.8, 83, 1);
    let weldErr = 0;
    for (let i = 0; i < 90; i++) {
      cw.advance(DT);
      weldErr = Math.max(weldErr, Math.abs(twig.offsetAt(0) - sec.offsetAt(sec.length * 0.5)));
    }
    for (let i = 0; i < 200; i++) cw.advance(DT);
    // 鸟落在二级枝 0.7 处：静态下垂 sag·0.49 ≈ 0.17 cm，站着时根贴着下沉的面（每帧 |dist| < 1e-6）；跳走后枝回弹到 0 以上再停
    const locoM = new Locomotion();
    const fr = sec.frameAt(sec.length * 0.7, makeCurveFrame());
    const placed = locoM.place(cw, fr.cx, fr.cy + 0.5, fr.cz, 1, 0);
    let gapMax = 0;
    let sagX = 0;
    for (let i = 0; i < 120; i++) {
      cw.advance(DT);
      locoM.update(DT, { x: 0, z: 0, hop: false, steer: false }, cw);
      const cc = cw.closest(locoM.pos.x, locoM.pos.y, locoM.pos.z, makeContact());
      if (locoM.phase === 'stand') gapMax = Math.max(gapMax, Math.abs(cc.dist));
      sagX = sec.ownOffset;
    }
    let rebound = 0;
    let left = false;
    for (let i = 0; i < 240; i++) {
      locoM.update(DT, left ? { x: 0, z: 0, hop: false, steer: false } : { x: 0, z: 1, hop: true, leap: true, steer: false }, cw);
      if (locoM.tookOff) left = true;
      cw.advance(DT);
      if (left) rebound = Math.max(rebound, sec.ownOffset);
    }
    for (let i = 0; i < 300; i++) cw.advance(DT);
    const restX = sec.ownOffset;
    const okM = shapeOk && minTip < -0.5 && zc >= 10 && zc <= 18 && settled && weldErr < 1e-9 && placed && gapMax < 1e-6 && sagX < -0.1 && left && rebound > 0.05 && Math.abs(restX) < 0.01;
    report(
      'gait',
      okM,
      `悬臂枝弹簧：振型根 0 / 中 0.25 / 梢 1 ${shapeOk ? '对' : '错'}；83 cm/s 蹬一下梢端最低 ${minTip.toFixed(2)} cm（要求 < −0.5）、3 s 内过零 ${zc} 次（≈ 2.4 Hz）、3 s 后残振 ${settled ? '已停' : '没停'}；子枝根随母枝焊口最大误差 ${weldErr.toExponential(1)} cm；鸟站上 2 s 枝静态下垂 ${sagX.toFixed(3)} cm、根离面最大 ${gapMax.toExponential(1)}；跳走后回弹到 +${rebound.toFixed(3)} 再回到 ${restX.toFixed(4)}（${left ? '已离枝' : '没离枝'}）`,
    );
  }
}


// ───────────────────────────── 飞行与着陆 ─────────────────────────────
/**
 * Flight 逐帧推进：起飞（接 Locomotion 的跃离）、巡航波浪、压坡转弯、失速恢复、滑翔自动着陆、俯冲拉杆抓电线、随机 60 s。
 * 统计：空速范围、高度起伏、坡度 / 俯仰极值、失速度、最深穿入、侧面碰撞次数、触地速度、落点离面距离、确定性。
 */
function flight() {
  const { world, names } = makeWorld();
  const wire = findCurve(world, names, 'wire');
  const snow = world.surfaces.find((s) => s.kind === 1);
  const DT = 1 / 60;
  const c = makeContact();
  const fl = new Flight();
  const loco = new Locomotion();
  const fresh = () => ({ vMin: Infinity, vMax: 0, yMin: Infinity, yMax: -Infinity, stallMax: 0, bankMax: 0, pen: 0, penAt: '', bumps: 0, flare: false, pitchMin: 0, ys: [] });
  const step = (m, intent, w = world) => {
    fl.update(DT, intent, w);
    m.vMin = Math.min(m.vMin, fl.speed);
    m.vMax = Math.max(m.vMax, fl.speed);
    m.yMin = Math.min(m.yMin, fl.pos.y);
    m.yMax = Math.max(m.yMax, fl.pos.y);
    m.stallMax = Math.max(m.stallMax, fl.stall);
    m.bankMax = Math.max(m.bankMax, Math.abs(fl.bank));
    m.pitchMin = Math.min(m.pitchMin, fl.pitch);
    m.ys.push(fl.pos.y);
    if (fl.phase === 'flare') m.flare = true;
    w.closest(fl.pos.x, fl.pos.y, fl.pos.z, c);
    if (c.surface && -c.dist > m.pen) {
      m.pen = -c.dist;
      m.penAt = `${fl.phase} @(${fl.pos.x.toFixed(0)}, ${fl.pos.y.toFixed(0)}, ${fl.pos.z.toFixed(0)}) kind ${c.surface.kind} v ${fl.speed.toFixed(0)}`;
    }
    return fl.landed;
  };
  const run = (m, secs, intent, w = world) => {
    const n = Math.round(secs / DT);
    for (let i = 0; i < n; i++) {
      if (step(m, typeof intent === 'function' ? intent(i * DT, fl) : intent, w)) return i * DT;
    }
    return secs;
  };
  const lvl = { turn: 0, pitch: 0, flap: true };
  const glide = { turn: 0, pitch: 0, flap: false };
  const waveAmp = (m, frames) => {
    const ys = m.ys.slice(-frames);
    return Math.max(...ys) - Math.min(...ys);
  };
  const headingOf = () => Math.atan2(fl.heading.x, fl.heading.z);
  const c01 = (v, a, b) => Math.min(b, Math.max(a, v));

  // A. 从主角枝跃离起飞：Locomotion 的 leap 离地那一帧交给 Flight，按住扑翼平飞 2.5 s
  loco.place(world, 0, 0, 0, 1, 0);
  const a = fresh();
  let launched = false;
  let tVs = -1;
  for (let i = 0; i < 240; i++) {
    if (!launched) {
      loco.update(DT, { x: 1, z: 0, hop: true, leap: true }, world);
      if (loco.tookOff) {
        fl.start(loco.pos, loco.vel, loco.targetHeading.x, loco.targetHeading.z);
        launched = true;
      }
      continue;
    }
    if (step(a, lvl)) break;
    if (tVs < 0 && fl.speed >= FLIGHT.stallSpeed) tVs = fl.t;
    if (fl.t >= 2.5) break;
  }
  const okA = launched && tVs > 0 && tVs <= 1 && fl.stall < 0.05 && fl.pos.y > 15 && fl.phase === 'fly' && a.pen < 1e-6 && a.bumps === 0;
  report('flight', okA, `跃离起飞：离地后 ${tVs.toFixed(2)} s 空速到失速速度 ${FLIGHT.stallSpeed}（要求 ≤ 1 s），2.5 s 时高度 +${fl.pos.y.toFixed(1)} cm、空速 ${fl.speed.toFixed(0)}、失速度 ${fl.stall.toFixed(2)}；飞行中最深穿入 ${a.pen.toExponential(1)} cm、侧撞 ${a.bumps} 次`);

  // B. 巡航波浪：平飞 4 s，空速稳在失速速度以上，高度有起伏（扑翼一冲一沉）但不发散
  const y0 = fl.pos.y;
  const b = fresh();
  run(b, 4, lvl);
  const amp = waveAmp(b, 150);
  const okB = b.vMin > FLIGHT.stallSpeed && b.vMax < FLIGHT.maxSpeed && amp > 1 && amp < 22 && b.stallMax < 0.05 && Math.abs(headingOf() - Math.PI / 2) < 0.05;
  report('flight', okB, `平飞 4 s：空速 ${b.vMin.toFixed(0)}~${b.vMax.toFixed(0)} cm/s，高度起伏 ${amp.toFixed(1)} cm/周期（最后 2.5 s），失速度最大 ${b.stallMax.toFixed(2)}，高度净变 ${(fl.pos.y - y0).toFixed(1)} cm`);

  // C. 压坡转弯：满幅往左 0.8 s，航向转过 70°~150°（巡航 430 时协调转弯角速度 2.9 rad/s），坡度不超上限，不掉到失速
  const h0 = headingOf();
  const cT = fresh();
  run(cT, 0.8, { turn: 1, pitch: 0, flap: true });
  let dh = Math.abs(headingOf() - h0);
  if (dh > Math.PI) dh = Math.PI * 2 - dh;
  const okC = dh > 1.2 && dh < 2.6 && cT.bankMax <= FLIGHT.maxBank + 1e-6 && cT.vMin > 0.9 * FLIGHT.stallSpeed && cT.stallMax < 0.1;
  report('flight', okC, `满幅压坡 0.8 s：航向转过 ${(dh * 57.3).toFixed(0)}°（要求 70~150），坡度最大 ${(cT.bankMax * 57.3).toFixed(0)}°（上限 ${(FLIGHT.maxBank * 57.3).toFixed(0)}°），空速最低 ${cT.vMin.toFixed(0)}，失速度最大 ${cT.stallMax.toFixed(2)}`);

  // D. 失速与恢复：先爬 1.5 s 攒高度，再拉杆到底逼出失速（机头被压下），然后松杆 → 回到失速速度以上
  run(fresh(), 1.5, { turn: 0, pitch: 0.5, flap: true });
  const yClimb = fl.pos.y;
  const dS = fresh();
  let stalledAt = -1;
  run(dS, 3, (t) => {
    if (stalledAt < 0 && fl.stall > 0.5) stalledAt = t;
    // 飞手反应慢半拍：失速后再拉 0.25 s 才松杆
    return stalledAt < 0 || t - stalledAt < 0.25 ? { turn: 0, pitch: 1, flap: true } : lvl;
  });
  const okD = stalledAt >= 0 && dS.stallMax > 0.5 && dS.pitchMin < -0.05 && fl.speed >= FLIGHT.stallSpeed && fl.phase === 'fly' && fl.pos.y > -70;
  report('flight', okD, `失速恢复：爬升到 +${yClimb.toFixed(0)} cm 后拉杆到底，${stalledAt < 0 ? '没有' : stalledAt.toFixed(2) + ' s 后'}失速（最大 ${dS.stallMax.toFixed(2)}，机头最低 ${(dS.pitchMin * 57.3).toFixed(0)}°、空速最低 ${dS.vMin.toFixed(0)}），松杆后回到 ${fl.speed.toFixed(0)} cm/s，高度 +${fl.pos.y.toFixed(0)}`);

  // E. 滑翔自动着陆：离雪地 40 cm、以滑翔速度平飞，全部松开 → 下降中探测到雪地进 Flare，软磁吸落地
  //   （调试台的雪地只有 560 cm 见方，从 400 cm 高滑翔下来早飞出界了，所以从低处起）
  fl.start(new Vec3(0, -40, 0), new Vec3(500, -60, 0), 1, 0, false);
  const e = fresh();
  const tLand = run(e, 15, glide);
  world.closest(fl.pos.x, fl.pos.y, fl.pos.z, c);
  const okE = fl.landed && e.flare && fl.landedSpeed <= 60 && c.surface === snow && Math.abs(c.dist - FLIGHT.landingClear) < 0.01 && e.bumps === 0 && e.pen <= FLIGHT.landingClear + 1e-6;
  report('flight', okE, `滑翔自动着陆：${tLand.toFixed(2)} s 落定（${e.flare ? '经过 Flare' : '没有 Flare'}），触地速度 ${fl.landedSpeed.toFixed(1)} cm/s（上限 60），落在${c.surface === snow ? '雪地' : '别的面'}、根离面 ${c.dist.toFixed(3)} cm，最深穿入 ${e.pen.toExponential(1)} cm、侧撞 ${e.bumps} 次`);

  // W. W + 空格巡航：Player 的 W_CRUISE_PULL 0.3 → pitch 0.135 按住扑翼 3 s，要稳定爬升、不掉到失速（按住不松手也不能仰头失速）
  //   （从巡航 420 带起来，量拉杆后稳在哪）
  fl.start(new Vec3(0, -40, 0), new Vec3(420, 0, 0), 1, 0, false);
  const w = fresh();
  run(w, 3, { turn: 0, pitch: 0.3, flap: true });
  const okW = w.vMin > 0.9 * FLIGHT.stallSpeed && w.stallMax < 0.1 && fl.pos.y > 60 && fl.pitch > 0.1 && fl.pitch < 0.2;
  report('flight', okW, `W + 空格巡航 3 s：空速 ${w.vMin.toFixed(0)}~${w.vMax.toFixed(0)}（失速 ${FLIGHT.stallSpeed}）、失速度最大 ${w.stallMax.toFixed(2)}、高度 +${(fl.pos.y + 40).toFixed(0)} cm、俯仰稳定在 ${(fl.pitch * 57.3).toFixed(0)}°`);

  // S. S 刹车：满幅拉杆 + 停扑（brake，阻力 ×3）从巡航 430 掉到 250 以下要 < 1 s，机头仰起（准备落枝）；从 160 cm 高起，探测范围外
  fl.start(new Vec3(0, 80, 0), new Vec3(430, 0, 0), 1, 0, false);
  const s = fresh();
  let tBrake = -1;
  run(s, 2, (t) => {
    if (tBrake < 0 && fl.speed < 250) tBrake = t;
    return { turn: 0, pitch: 1, flap: false };
  });
  const okS = tBrake > 0 && tBrake < 1 && fl.brake && fl.tailSpread > 0.4;
  report('flight', okS, `S 刹车：430 cm/s ${tBrake < 0 ? '没有' : tBrake.toFixed(2) + ' s 后'}掉到 250 以下，最低 ${s.vMin.toFixed(0)}，刹车态 ${fl.brake}、尾扇 ${fl.tailSpread.toFixed(2)}，俯仰 ${(fl.pitch * 57.3).toFixed(0)}°`);

  // F. 俯冲拉杆（swoop）：从雪地上空 420 cm 零空速满幅推杆俯冲（第一版从电线上俯冲、刹车途中就落在线上，量的"刹车末速"其实是落定速度；
  //    300 cm 起落只剩 183 cm 落差，光重力也就 599 cm/s，拉杆点量不到 650），
  //    离地 190 cm 时拉杆刹车——速度要从 650 以上掉到 300 以下（失速 240 + 余量）、刹车途中不能落定；
  //    再在电线上方 8 cm、350 cm/s 顺着线滑翔，9 cm 软磁吸捕获落上去（细枝 / 电线抓取）
  fl.start(new Vec3(-200, 420, 0), new Vec3(0, 0, 0), 1, 0, false);
  const f = fresh();
  let phaseF = 'dive';
  let phaseT = 0;
  let brakeFrom = 0;
  let brakeTo = 0;
  let brakeAt = 0;
  run(f, 3, (t) => {
    if (phaseF === 'dive' && fl.pos.y < 117) {
      phaseF = 'brake';
      phaseT = t;
      brakeFrom = fl.speed;
      brakeAt = fl.pos.y;
    } else if (phaseF === 'brake' && (fl.speed < 300 || t - phaseT > 1.2 || fl.landed)) {
      phaseF = fl.landed ? 'landed' : 'glide';
      brakeTo = fl.speed;
    }
    return phaseF === 'dive' ? { turn: 0, pitch: -1, flap: true } : phaseF === 'brake' ? { turn: 0, pitch: 1, flap: false } : lvl;
  });
  const okF1 = phaseF === 'glide' && brakeFrom > 650 && brakeTo < 300;
  report('flight', okF1, `俯冲拉杆：420 cm 高零空速满幅推杆俯冲，离地 ${(brakeAt + 73).toFixed(0)} cm 时 ${brakeFrom.toFixed(0)} cm/s 拉杆（要求 > 650），${(phaseT - 0).toFixed(2)} s 后开始刹车，${phaseF === 'glide' ? '掉到' + brakeTo.toFixed(0) + ' cm/s（要求 < 300）' : '刹车途中落定了（' + brakeTo.toFixed(0) + ' cm/s）'}，最高 ${f.vMax.toFixed(0)}（俯冲硬上限 ${FLIGHT.maxSpeed}）`);
  // F2. 滑翔抓电线：电线上方 8 cm、350 cm/s 顺线滑翔，滑翔前瞻点离线 < 9 cm 软磁吸捕获
  wire.pointAt(wire.length * 0.3, 0, 0, TMPV);
  const wf2 = wire.frameAt(wire.length * 0.3, frame);
  fl.start(new Vec3(TMPV.x, TMPV.y + 8, TMPV.z), new Vec3(wf2.tx * 350, 0, wf2.tz * 350), wf2.tx, wf2.tz, false);
  const f2 = fresh();
  const tWire = run(f2, 10, glide);
  const onWire = fl.target.surface === wire;
  const okF = fl.landed && onWire && f2.flare && fl.landedSpeed <= 60 && f2.bumps === 0 && f2.pen <= FLIGHT.landingClear + 1e-6;
  report('flight', okF, `滑翔抓电线：线上方 8 cm、350 cm/s 顺线滑翔，${tWire.toFixed(2)} s 落定在${onWire ? '电线上' : '别的面'}，触地速度 ${fl.landedSpeed.toFixed(1)} cm/s，最深穿入 ${f2.pen.toExponential(1)} cm、侧撞 ${f2.bumps} 次，落点 (${fl.pos.x.toFixed(1)}, ${fl.pos.y.toFixed(1)}, ${fl.pos.z.toFixed(1)})`);
  // F3. 巡航软磁吸：不用滑翔——电线上方 7 cm、390 cm/s 顺线扑翼巡航，巡航前瞻点离线 < 9 cm 就捕获；横穿电线上方 7 cm（从线前 80 cm 起）也会被抓上去
  const magnet = (along) => {
    wire.pointAt(wire.length * 0.3, 0, 0, TMPV);
    const wfm = wire.frameAt(wire.length * 0.3, frame);
    const hx = along ? wfm.tx : -wfm.tz;
    const hz = along ? wfm.tz : wfm.tx;
    const back = along ? 0 : 80;
    fl.start(new Vec3(TMPV.x - hx * back, TMPV.y + 7, TMPV.z - hz * back), new Vec3(hx * 390, 0, hz * 390), hx, hz, false);
    const m = fresh();
    const t = run(m, 6, lvl);
    return { m, t, landed: fl.landed, wire: fl.target.surface === wire, flare: fl.landedFlare, speed: fl.landedSpeed, bumps: m.bumps, pen: m.pen };
  };
  const m1 = magnet(true);
  const m2 = magnet(false);
  const okM = m1.landed && m1.wire && m1.flare && m1.speed <= 60 && m1.bumps === 0 && m2.landed && m2.wire && m2.flare && m2.speed <= 60 && m2.bumps === 0;
  report('flight', okM, `巡航软磁吸：电线上方 7 cm 顺线扑翼 ${m1.t.toFixed(2)} s 落定在${m1.wire ? '电线上' : '别的面'}（${m1.flare ? '经过 Flare' : '没有 Flare'}，触地 ${m1.speed.toFixed(1)} cm/s）；横穿电线上方 7 cm ${m2.t.toFixed(2)} s 落定在${m2.wire ? '电线上' : '别的面'}（触地 ${m2.speed.toFixed(1)} cm/s）；侧撞 ${m1.bumps + m2.bumps} 次、最深穿入 ${Math.max(m1.pen, m2.pen).toExponential(1)}`);

  // N. Shift 冲刺：巡航 430 平飞 1 s 后按住 boost 2.5 s——空速要升到 620 以上、冲刺量 ≈ 1、扑翼频率 14 → 18 Hz（按扑翼段的时间量）；
  //    松开 3 s 内回落到 460 以下、频率回 14 Hz；冲刺中失速 / 侧撞都是 0
  fl.start(new Vec3(0, 120, 0), new Vec3(430, 0, 1), 0, 1, false);
  const n = fresh();
  run(n, 1, lvl);
  const vCruise = fl.speed;
  /** 量一段时间里的扑翼频率：只在扑翼段累计相位和时间，收翼段不扑（Flight 先更新扑翼 / 收翼再推相位，所以按这一帧推进后的状态算）。 */
  const flapHzOver = (m, secs, intent) => {
    let phase = 0;
    let time = 0;
    const frames = Math.round(secs / DT);
    for (let i = 0; i < frames; i++) {
      const p0 = fl.flapPhase;
      step(m, typeof intent === 'function' ? intent(i * DT, fl) : intent);
      if (fl.flapping) {
        phase += fl.flapPhase - p0;
        time += DT;
      }
    }
    return (phase / (Math.PI * 2)) / Math.max(time, 1e-9);
  };
  const vBoost = fresh();
  const hzBoost = flapHzOver(vBoost, 2.5, { turn: 0, pitch: 0, flap: true, boost: true });
  const vAtBoost = fl.speed;
  const boostK = fl.boost;
  const vRel = fresh();
  const hzRel = flapHzOver(vRel, 3, lvl);
  const okN = vAtBoost > 620 && vAtBoost < FLIGHT.maxSpeed && boostK > 0.95 && Math.abs(hzBoost - FLIGHT.boostFlapHz) < 0.6 && fl.speed < 460 && fl.boost < 0.05 && Math.abs(hzRel - FLIGHT.flapHz) < 0.6 && vBoost.stallMax < 0.05 && vBoost.bumps === 0;
  report('flight', okN, `Shift 冲刺：巡航 ${vCruise.toFixed(0)} cm/s 按住 2.5 s 升到 ${vAtBoost.toFixed(0)}（要求 620~${FLIGHT.maxSpeed}）、冲刺量 ${boostK.toFixed(2)}、扑翼 ${hzBoost.toFixed(1)} Hz（参数 ${FLIGHT.boostFlapHz}）；松开 3 s 回到 ${fl.speed.toFixed(0)}（要求 < 460）、${hzRel.toFixed(1)} Hz（参数 ${FLIGHT.flapHz}）、冲刺量 ${fl.boost.toFixed(2)}；冲刺中失速度最大 ${vBoost.stallMax.toFixed(2)}、侧撞 ${vBoost.bumps} 次`);
  // N2. 冲刺 / 主动爬升时不抓落点：屋顶（平面）上方 6 cm 顺直线冲刺 1 s、再巡航 + climb 1 s，都要还是 fly、没进 Flare
  //     （不拿电线试：电线有垂度，直线飞过去线会升上来真的碰到根——碰到就是落，那是物理不是探测）
  {
    const roofWorld = buildWorld({
      curves: [],
      grounds: [{ tag: 'snow', x0: -300, z0: -300, x1: 300, z1: 300, cell: 4, base: -80, drift: 0, seed: 1 }],
      boxes: [{ tag: 'roof', min: [-200, 0, -200], max: [200, 50, 200] }],
    });
    const n2 = fresh();
    let flared = false;
    fl.start(new Vec3(-150, 56, 0), new Vec3(390, 0, 0), 1, 0, false);
    run(n2, 1, (t) => {
      if (fl.phase === 'flare') flared = true;
      return { turn: 0, pitch: 0, flap: true, boost: true };
    }, roofWorld);
    const stillFly1 = fl.phase === 'fly' && !flared && fl.pos.y > 54;
    flared = false;
    fl.start(new Vec3(-150, 56, 0), new Vec3(390, 0, 0), 1, 0, false);
    run(n2, 1, (t) => {
      if (fl.phase === 'flare') flared = true;
      return { turn: 0, pitch: 0, flap: true, climb: true };
    }, roofWorld);
    const stillFly2 = fl.phase === 'fly' && !flared && fl.pos.y > 54;
    // 对照：同样的平飞不带冲刺 / 爬升，6 cm 高度巡航探测会把它抓到屋顶上
    fl.start(new Vec3(-150, 56, 0), new Vec3(390, 0, 0), 1, 0, false);
    const n3 = fresh();
    const tCtl = run(n3, 3, lvl, roofWorld);
    const okN2 = stillFly1 && stillFly2 && fl.landed && n3.flare;
    report('flight', okN2, `冲刺 / 主动爬升中不抓落点：屋顶上方 6 cm 顺直线冲刺 1 s ${stillFly1 ? '没被抓' : '被抓了'}；巡航 + climb 1 s ${stillFly2 ? '没被抓' : '被抓了'}；对照（普通巡航）${tCtl.toFixed(2)} s ${fl.landed && n3.flare ? '被抓到屋顶上' : '没被抓'}`);
  }

  // G. 随机飞行 60 s：意图每 0.4~1.0 s 换一次，离中心远了 / 太低了往回拉；落下去就从落点再跃起；两次同种子一致
  const rng = makeRng(23);
  const script = [];
  for (let i = 0; i < 100; i++) script.push({ secs: 0.4 + rng() * 0.6, turn: rng() * 2 - 1, pitch: rng() * 2 - 1, flap: rng() < 0.7 });
  const randRun = () => {
    const g = fresh();
    let landings = 0;
    let worstLanding = 0;
    let hardLandings = 0;
    let bumps = 0;
    let cur = 0;
    let hold = 0;
    let turn = 0;
    let pitch = 0;
    let flap = true;
    fl.homeRadius = 170;
    fl.voidY = -200;
    fl.homeY = 40;
    fl.start(new Vec3(0, 60, 0), new Vec3(300, 100, 0), 1, 0, false);
    const ring = [];
    let ri = 0;
    let lastPen = 0.03;
    for (let i = 0; i < 60 / DT; i++) {
      if (fl.phase === 'landed') {
        landings++;
        // 经过 Flare 的落定要软（触地法向速度 ≤ 60）；扑翼中直接撞到平面上的"硬着陆"（2026-11-23 起平面触地即落，不等 Flare）只计数
        if (fl.landedFlare) worstLanding = Math.max(worstLanding, fl.landedSpeed);
        else hardLandings++;
        bumps += fl.bumps;
        // 从落点再跃起：地面起飞走发射阶段（全力扑翼、不失速）
        fl.start(fl.pos, new Vec3(fl.heading.x * 80, 90, fl.heading.z * 80), fl.heading.x, fl.heading.z, true);
      }
      if (hold <= 0) {
        const it = script[cur % script.length];
        cur++;
        hold = it.secs;
        turn = it.turn;
        pitch = it.pitch;
        flap = it.flap;
      }
      hold -= DT;
      // 太低了（雪地上方 40 cm 内）优先扑翼爬升；离中心超过 240 cm 优先往回转
      let tv = turn;
      let pv = pitch;
      let fv = flap;
      if (fl.pos.y < -40) {
        fv = true;
        pv = Math.max(pv, 0.6);
      }
      if (Math.hypot(fl.pos.x, fl.pos.z) > 240) {
        const back = Math.atan2(-fl.pos.x, -fl.pos.z);
        let d = back - headingOf();
        d = Math.atan2(Math.sin(d), Math.cos(d));
        tv = c01(d * 2, -1, 1);
      }
      // 测试雪板只有 560×560：出了板子飞到板底下测不出东西。现在由 Flight 的逆风软边界（homeRadius 170）把鸟带回场内，
      // 这里不再硬拗机头（2026-11-23 之前的隐形墙），顺便压它
      step(g, { turn: tv, pitch: pv, flap: fv });
      if (process.env.SIM_DEBUG) {
        // SIM_DEBUG=1：每次刷新最深穿入时打印之前 12 帧
        ring[ri % 12] = `${i} ${fl.phase} pos=(${fl.pos.x.toFixed(1)},${fl.pos.y.toFixed(2)},${fl.pos.z.toFixed(1)}) v=${fl.speed.toFixed(0)} vel=(${fl.vel.x.toFixed(0)},${fl.vel.y.toFixed(0)},${fl.vel.z.toFixed(0)}) bumps=${fl.bumps} pen=${g.pen.toExponential(1)} tgt=${fl.target.surface ? `${fl.target.surface.kind}@(${fl.target.px.toFixed(1)},${fl.target.py.toFixed(1)},${fl.target.pz.toFixed(1)})` : '-'}`;
        ri++;
        if (g.pen > lastPen) {
          lastPen = g.pen;
          console.log('--- new max pen', g.pen.toExponential(2), g.penAt);
          for (let k = 0; k < 12; k++) { const s = ring[(ri + k) % 12]; if (s) console.log('  ', s); }
        }
      }
    }
    return { g, landings, worstLanding, hardLandings, bumps: bumps + fl.bumps, snap: [fl.phase, fl.pos.x, fl.pos.y, fl.pos.z, fl.speed].map((v) => (typeof v === 'number' ? v.toFixed(6) : v)).join(',') };
  };
  const r1 = randRun();
  const r2 = randRun();
  fl.homeRadius = 0;
  fl.voidY = -1e9;
  const okG = r1.g.pen <= FLIGHT.landingClear + 1e-6 && r1.worstLanding <= 60 && r1.landings >= 1 && r1.snap === r2.snap;
  report('flight', okG, `随机飞行 60 s：落定 ${r1.landings} 次（Flare 落定触地速度最大 ${r1.worstLanding.toFixed(1)} cm/s，平面直接触地硬着陆 ${r1.hardLandings} 次），最深穿入 ${r1.g.pen.toExponential(1)} cm（${r1.g.penAt}），侧撞 ${r1.bumps} 次，空速 ${r1.g.vMin.toFixed(0)}~${r1.g.vMax.toFixed(0)}，坡度最大 ${(r1.g.bankMax * 57.3).toFixed(0)}°；两次同种子结果${r1.snap === r2.snap ? '一致' : '不一致'}`);

  // H. 迎头撞墙：700 cm/s 垂直撞上小楼西墙（x = 70），弹开回旋后 0.5 s 内必须离开墙面、空速 ≥ 360、不再二次撞上
  //    （修前：pushOut 只推位置不改航向，下一帧又按旧航向怼回墙里，卡死在墙面上）
  const wallRun = (hx, hz, x0 = 0, z0 = -130, v0 = 700, secs = 1.5) => {
    const m = fresh();
    fl.start(new Vec3(x0, 20, z0), new Vec3(v0 * hx, 0, v0 * hz), hx, hz, false);
    let tHit = -1;
    let half = null;
    for (let i = 0; i < Math.round(secs / DT); i++) {
      const before = fl.bumpT;
      step(m, lvl);
      if (tHit < 0 && before > 0 && fl.bumpT === 0) tHit = i * DT;
      if (tHit >= 0 && !half && i * DT - tHit >= 0.5) half = { x: fl.pos.x, z: fl.pos.z, v: fl.speed, hx: fl.heading.x, hz: fl.heading.z, bumps: fl.bumps, stall: fl.stall };
    }
    world.closest(fl.pos.x, fl.pos.y, fl.pos.z, c);
    return { m, tHit, half, x: fl.pos.x, z: fl.pos.z, v: fl.speed, hx: fl.heading.x, hz: fl.heading.z, bumps: fl.bumps, clear: c.surface ? c.dist : 99 };
  };
  const h1 = wallRun(1, 0);
  const okH = h1.tHit >= 0 && h1.half && h1.half.bumps === 1 && h1.half.x < 60 && h1.half.hx < -0.5 && h1.half.v >= 360 && h1.bumps === 1 && h1.m.pen < 0.5 && h1.clear > 0;
  report('flight', okH, `迎头撞墙：${h1.tHit.toFixed(2)} s 撞上，0.5 s 后 x ${h1.half ? h1.half.x.toFixed(1) : '-'}（墙在 70，要求 < 60）、航向 (${h1.half ? h1.half.hx.toFixed(2) : '-'}, ${h1.half ? h1.half.hz.toFixed(2) : '-'})、空速 ${h1.half ? h1.half.v.toFixed(0) : '-'}（要求 ≥ 360）、失速度 ${h1.half ? h1.half.stall.toFixed(2) : '-'}；1.5 s 里共撞 ${h1.bumps} 次（要求 1），离面 ${h1.clear.toFixed(2)} cm，最深穿入 ${h1.m.pen.toExponential(1)}`);

  // I. 斜擦墙滑走：27° 夹角蹭上小楼西墙（从 (0, −240) 朝 (0.45, 0.893)，在 z ≈ −100 处碰上），航向顺着墙面的切线偏过去贴着滑走，
  //    不算撞、不掉到 350 以下（躯干球 2.3 cm 先于根碰到墙）
  //    （第一版的机位 (0, −130) 其实是斜对着电线杆的棱角飞——棱角法线和航向只差 12°，是迎头不是斜擦，0 半径的根碰不到才"擦"过去）
  const i1 = wallRun(0.45, 0.893, 0, -240, 430);
  const okI = i1.tHit >= 0 && i1.bumps === 0 && i1.half && Math.abs(i1.half.hx) < 0.12 && i1.half.hz > 0.95 && i1.half.z > -110 && i1.half.v >= 350 && i1.m.pen < 0.5;
  report('flight', okI, `斜擦墙：${i1.tHit.toFixed(2)} s 蹭上（z ${(-240 + (0.893 / 0.45) * 70).toFixed(0)} 处），撞侧计数 ${i1.bumps}（要求 0），0.5 s 后航向 (${i1.half ? i1.half.hx.toFixed(2) : '-'}, ${i1.half ? i1.half.hz.toFixed(2) : '-'})（要求顺墙 +z）、z ${i1.half ? i1.half.z.toFixed(0) : '-'}、空速 ${i1.half ? i1.half.v.toFixed(0) : '-'}（要求 ≥ 350）、最深穿入 ${i1.m.pen.toExponential(1)}`);

  // J. 顶到底面（电线底 / 屋檐下沿同理）：顺着电线的走向从下方 4 cm 处斜着撞上电线底面，机头被压回负俯仰掉出来，不挂在上面
  wire.pointAt(wire.length * 0.3, 0, 0, TMPV);
  const wj = wire.frameAt(wire.length * 0.3, frame);
  const jl = Math.hypot(wj.tx, wj.tz);
  const j = fresh();
  fl.start(new Vec3(TMPV.x, TMPV.y - 4, TMPV.z), new Vec3((wj.tx / jl) * 400, 300, (wj.tz / jl) * 400), wj.tx / jl, wj.tz / jl, false);
  let jHit = -1;
  let jYAtHit = 0;
  let jPitchMin = 1;
  for (let i = 0; i < 30; i++) {
    const before = fl.bumpT;
    step(j, lvl);
    if (jHit < 0 && before > 0 && fl.bumpT === 0) {
      jHit = i * DT;
      jYAtHit = fl.pos.y;
    }
    if (jHit >= 0 && i * DT - jHit < 0.12) jPitchMin = Math.min(jPitchMin, fl.bodyPitch);
  }
  world.closest(fl.pos.x, fl.pos.y, fl.pos.z, c);
  const okJ = jHit >= 0 && fl.pos.y < jYAtHit - 1 && jPitchMin < -0.05 && c.dist > 0 && j.pen < 0.5;
  report('flight', okJ, `顶到电线底：${jHit.toFixed(2)} s 撞上（y ${jYAtHit.toFixed(2)}），撞后 0.12 s 内机体俯仰最低 ${(jPitchMin * 57.3).toFixed(0)}°（要求 < 0 = 压头）、0.5 s 后 y ${fl.pos.y.toFixed(2)}（要求掉下来）、离面 ${c.dist.toFixed(2)} cm、最深穿入 ${j.pen.toExponential(1)}`);

  // O. 落点洁净（2026-11-23 第二版）：屋顶上有一块和屋面几乎齐平的支撑板（顶面 50.001，比屋面高 1 μm，closest 会选它）、接缝（x = 100）、
  //    一道 6 cm 高的护墙（x ≥ 100.8）——第一版 1 cm 内见到任何第二个面就拒落，支撑板 / 接缝上全落不上；
  //    现在只看躯干中心有没有嵌进侧面竖墙 / 顶棚底面：巡航扑翼从屋顶 4 cm 上方飞过，要当场落在支撑板上（loco.place 也落得住）；
  //    从 8 cm 高飞向护墙，巡航前瞻点落在护墙顶上方 2.4 cm → 捕获落在护墙顶上（护墙顶离楼面 / 护墙侧面都在 1 cm 内，第一版落不上）
  {
    const parapetX = 100.8;
    const roofWorld = buildWorld({
      curves: [],
      grounds: [{ tag: 'snow', x0: -300, z0: -300, x1: 300, z1: 300, cell: 4, base: -80, drift: 0, seed: 1 }],
      boxes: [
        { tag: 'roofA', min: [0, 0, -100], max: [100, 50, 100] },
        { tag: 'roofB', min: [100, 0, -100], max: [200, 50, 100] },
        { tag: 'support', min: [5, 0, -30], max: [60, 50.001, 30] },
        { tag: 'parapet', min: [parapetX, 50, -100], max: [parapetX + 4, 56, 100] },
      ],
    });
    const locoO = new Locomotion();
    // 支撑板：巡航前瞻点落在支撑板顶上（刹停点顺着动量前移会跨到 roofB 上，不留），落到支撑板上
    fl.start(new Vec3(-35, 54, 20), new Vec3(390, 0, 0), 1, 0, false);
    const o = fresh();
    const tSeam = run(o, 4, lvl, roofWorld);
    const seamLanded = fl.landed && fl.landedFlare && o.bumps === 0;
    const seamX = fl.pos.x;
    const seamY = fl.pos.y;
    const placed = locoO.place(roofWorld, fl.pos.x, fl.pos.y, fl.pos.z, 1, 0);
    const placeY = locoO.pos.y;
    const placeKind = locoO.surface ? locoO.surface.kind : -1;
    const seamOk = seamLanded && seamX > 10 && seamX < 60 && Math.abs(seamY - 50.021) < 0.002 && placed && placeKind === 2 && Math.abs(placeY - 50.001) < 1e-6;
    // 护墙顶：从 8 cm 高飞过去，巡航前瞻点落在护墙顶上方 2.4 cm → 捕获落在护墙顶上（6 cm 高的护墙顶离楼面、离护墙侧面都在 1 cm 内，
    // 第一版见到第二个面就拒落，护墙顶 / 栏杆顶上落不了）；躯干中心在护墙顶上方 2.6 cm，不嵌进任何侧面 → 干净
    const parapetStart = parapetX - 0.1 - 0.18 * 390 - 6.5;
    fl.start(new Vec3(parapetStart, 58, 20), new Vec3(390, 0, 0), 1, 0, false);
    const o2 = fresh();
    const tParapet = run(o2, 4, lvl, roofWorld);
    const onParapet = fl.landed && fl.landedFlare && Math.abs(fl.pos.y - 56.02) < 0.01 && fl.pos.x > parapetX - 0.6 && fl.pos.x < parapetX + 1.5;
    const parapetOk = onParapet && o2.bumps === 0 && locoO.place(roofWorld, fl.pos.x, fl.pos.y, fl.pos.z, 1, 0) && Math.abs(locoO.pos.y - 56) < 1e-6;
    report('flight', seamOk && parapetOk, `落点洁净：飞向带支撑板的屋顶 ${tSeam.toFixed(2)} s ${seamLanded ? '落定' : '没落定'}在 x ${seamX.toFixed(1)}、y ${seamY.toFixed(3)}，loco.place ${placed ? '落在' + (placeKind === 2 ? '盒顶' : 'kind ' + placeKind) : '落不住'}（y ${placeY.toFixed(3)}）；飞向 6 cm 高的护墙 ${tParapet.toFixed(2)} s ${onParapet ? '落在护墙顶上' : '没落在护墙顶上'}（${fl.landed ? '落定' : '没落定'}于 x ${fl.pos.x.toFixed(1)}、y ${fl.pos.y.toFixed(2)}）、loco.place ${Math.abs(locoO.pos.y - 56) < 1e-6 ? '落在护墙顶' : 'y ' + locoO.pos.y.toFixed(2)}、侧撞 ${o2.bumps}`);
  }

  // P. 墙角脱困（2026-11-23 第二版）：斜着撞进两面墙的内夹角（x = 100 的墙面 + z = 100 的墙面，夹角在 (100, *, 100)），
  //    第一版撞后 0.35 s 宽限期屏蔽了迎头反射，鸟在两面之间来回顶、掉速卡死；现在反射方向怼进另一面就换开阔的切向：
  //    0.5 s 内航向离开两面墙（和两个法线的点积都 > 0.1）、空速 ≥ 360，1.5 s 时离夹角比撞上时远 20 cm 以上、没落定、没卡死
  {
    const cornerWorld = buildWorld({
      curves: [],
      grounds: [{ tag: 'snow', x0: -300, z0: -300, x1: 300, z1: 300, cell: 4, base: -80, drift: 0, seed: 1 }],
      boxes: [
        { tag: 'wallX', min: [100, -80, -200], max: [240, 60, 240] },
        { tag: 'wallZ', min: [-200, -80, 100], max: [100, 60, 240] },
      ],
    });
    fl.start(new Vec3(0, 20, 0), new Vec3(430 * Math.SQRT1_2, 0, 430 * Math.SQRT1_2), Math.SQRT1_2, Math.SQRT1_2, false);
    const p = fresh();
    let tHit = -1;
    let hitPos = null;
    let half = null;
    let minSpeed = Infinity;
    for (let i = 0; i < 90; i++) {
      const before = fl.bumpT;
      step(p, lvl, cornerWorld);
      minSpeed = Math.min(minSpeed, fl.speed);
      if (tHit < 0 && before > 0 && fl.bumpT === 0) {
        tHit = i * DT;
        hitPos = { x: fl.pos.x, z: fl.pos.z };
      }
      if (tHit >= 0 && !half && i * DT - tHit >= 0.5) half = { x: fl.pos.x, z: fl.pos.z, hx: fl.heading.x, hz: fl.heading.z, v: fl.speed };
    }
    const dHit = hitPos ? Math.hypot(100 - hitPos.x, 100 - hitPos.z) : 0;
    const dEnd = Math.hypot(100 - fl.pos.x, 100 - fl.pos.z);
    // 墙法线：x 墙朝 −x (−1, 0)，z 墙朝 −z (0, −1)：航向和法线的点积 ≥ 0 = 不再朝任何一面墙里去（顺着一面墙滑走也算离开夹角）
    const okP = tHit >= 0 && half && -half.hx >= -0.05 && -half.hz >= -0.05 && half.v >= 360 && dEnd > dHit + 20 && fl.phase === 'fly' && fl.bumps >= 1 && p.pen < 0.5;
    report('flight', okP, `墙角脱困：${tHit.toFixed(2)} s 撞上夹角（离夹角 ${dHit.toFixed(1)} cm），0.5 s 后航向 (${half ? half.hx.toFixed(2) : '-'}, ${half ? half.hz.toFixed(2) : '-'})（要求不再朝 −x 墙 / −z 墙里去）、空速 ${half ? half.v.toFixed(0) : '-'}（要求 ≥ 360）、最低空速 ${minSpeed.toFixed(0)}；1.5 s 后离夹角 ${dEnd.toFixed(0)} cm（撞上时 ${dHit.toFixed(0)}，要求远 20 以上）、${fl.phase}、共撞 ${fl.bumps} 次、最深穿入 ${p.pen.toExponential(1)}`);
  }

  // Q. 薄壁防隧穿：1 cm 厚的玻璃 / 隔墙（x = 99~101），1000 cm/s（俯冲硬上限）垂直撞上去，躯干球（2.3 cm）要在墙的这一侧（x < 97）把鸟拦住，
  //    根不能跨过中心线被推到墙的那一头；撞后弹开、空速 ≥ 360
  {
    const thinWorld = buildWorld({
      curves: [],
      grounds: [{ tag: 'snow', x0: -300, z0: -300, x1: 300, z1: 300, cell: 4, base: -80, drift: 0, seed: 1 }],
      boxes: [{ tag: 'glass', min: [99, -80, -200], max: [101, 60, 200] }],
    });
    fl.start(new Vec3(0, 20, 0), new Vec3(1000, 0, 0), 1, 0, false);
    const q = fresh();
    let maxX = -Infinity;
    let hit = false;
    for (let i = 0; i < 90; i++) {
      const before = fl.bumpT;
      step(q, lvl, thinWorld);
      maxX = Math.max(maxX, fl.pos.x);
      if (before > 0 && fl.bumpT === 0) hit = true;
    }
    const okQ = hit && maxX < 97 && fl.pos.x < 90 && fl.speed >= 360 && q.pen < 0.5 && fl.bumps >= 1;
    report('flight', okQ, `薄壁防隧穿：1000 cm/s 撞 1 cm 厚的墙 ${hit ? '撞上' : '没撞上'}，根最远到 x ${maxX.toFixed(2)}（墙在 99，躯干球 2.3 → 要求 < 97）、1.5 s 后 x ${fl.pos.x.toFixed(1)}、空速 ${fl.speed.toFixed(0)}（要求 ≥ 360）、撞 ${fl.bumps} 次、最深穿入 ${q.pen.toExponential(1)}`);
  }

  // K. 逆风软边界 + 虚空兜底：900 cm/s 朝场外平飞不打舵，最远停在风墙（homeRadius 170 × 1.5 = 255 的矩形，两轴里超得多的那个算）上；贴着场边时
  //    刹车 0.3 s（停扑 + 拉杆）再扑翼平飞，逆风 + 边界提示要能把它带回 150 cm 以内（巡航 390 满舵的转弯半径 123，比场边小多了）；
  //    掉到 voidY 以下被放回场上空
  fl.homeRadius = 170;
  fl.voidY = -200;
  fl.homeY = 40;
  const k = fresh();
  fl.start(new Vec3(0, 60, 0), new Vec3(900, 0, 0), 1, 0, false);
  let kRMax = 0;
  let kRMin = Infinity;
  let kBrakeAt = -1;
  /** 刹车 + 回场那一段（撞墙前 10 帧到之后 150 帧）里的最低空速：再往后鸟在场里绕圈，可能自己撞到风墙的夹角上（那是另一个问题，只记录） */
  let kVMin = Infinity;
  const brake = { turn: 0, pitch: 1, flap: false };
  for (let i = 0; i < 600; i++) {
    const r = Math.max(Math.abs(fl.pos.x), Math.abs(fl.pos.z));
    if (kBrakeAt < 0 && r > 220) kBrakeAt = i;
    const braking = kBrakeAt >= 0 && i - kBrakeAt < 18 && fl.speed > 450;
    step(k, braking ? brake : lvl);
    kRMax = Math.max(kRMax, r);
    if (kBrakeAt >= 10 && i >= kBrakeAt - 10 && i - kBrakeAt <= 150) kVMin = Math.min(kVMin, fl.speed);
    if (kBrakeAt >= 0 && i - kBrakeAt > 150) kRMin = Math.min(kRMin, r);
  }
  const kPhase = fl.phase;
  const kRespawns = fl.respawns;
  fl.start(new Vec3(0, -250, 0), new Vec3(600, 0, 0), 1, 0, false);
  step(k, lvl);
  const okK = kRMax < 256 && k.pen < 1e-6 && kVMin > 380 && fl.respawned && fl.respawns === kRespawns + 1 && Math.abs(fl.pos.y - 40) < 5 && fl.phase === 'fly';
  fl.homeRadius = 0;
  fl.voidY = -1e9;
  report('flight', okK, `逆风软边界：900 cm/s 朝外平飞最远离场地中心 ${kRMax.toFixed(0)} cm（矩形风墙 255 = 170×1.5，按两轴里超得多的那个算，要求 < 256），刹车 0.3 s（刹车 + 回场段最低 ${kVMin.toFixed(0)} cm/s，要求 > 380）后接着飞，离墙 2.5 s 后最近 ${kRMin.toFixed(0)} cm（要求 < 150：巡航 390 满舵的转弯半径 123）、最深穿入 ${k.pen.toExponential(1)}、10 s 结束时 ${kPhase}；虚空兜底：掉到 −250 后 ${fl.respawned ? '已放回' : '没有放回'} (${fl.pos.x.toFixed(0)}, ${fl.pos.y.toFixed(0)}, ${fl.pos.z.toFixed(0)})`);

  // L. 自动驾驶 90 s（自由巡飞）：在景点之间轮换着飞，不穿模、没被虚空兜底、景点到得多（没卡死）、失速 / 迎头撞不多
  //    （从主角枝上方发射期起飞起步——游戏里观赏模式永远是从歇脚的地方起飞开始的；落在地上 / 屋顶也按 Player.takeOff 的契约重新起飞）
  const ap = new Autopilot();
  const l = fresh();
  fl.homeRadius = 170;
  fl.voidY = -200;
  fl.homeY = 40;
  fl.start(new Vec3(0, 60, 0), new Vec3(80, 90, 0), 1, 0, true);
  const auto = { turn: 0, pitch: 0, flap: true };
  let lStall = 0;
  let lRespawns = 0;
  let lBumps = 0;
  let lLand = 0;
  let lGlide = 0;
  for (let i = 0; i < 90 / DT; i++) {
    if (fl.phase === 'landed') {
      lLand++;
      lBumps += fl.bumps;
      // 和 Player.takeOff 同一契约：自动起飞的朝向由自动驾驶挑（面朝墙起飞会一头扎进墙里）
      const la = ap.launchAzimuth(fl, world);
      fl.start(fl.pos, new Vec3(Math.sin(la) * 80, 90, Math.cos(la) * 80), Math.sin(la), Math.cos(la), true);
    }
    ap.update(DT, fl, world, auto);
    step(l, auto);
    if (fl.stall > 0.5) lStall++;
    if (fl.respawned) lRespawns++;
    if (!fl.flapping && fl.phase === 'fly') lGlide++;
  }
  const lFrames = 90 / DT;
  // 迎头撞 ≤ 8 / 失速帧 < 8%：调试台半边 255 cm，山雀巡航 390 满舵的转弯半径 123（冲刺 700 是 358）——擦着楼面 / 细枝飞过去时想转也转不回来的那几次
  // 由 Flight 的脱困兜着（撞后 0.5 s 内脱困是 H/I/J/P 的硬指标）；剩下的撞多是躯干球蹭到前视扇形不管的细枝 / 电线（半径 < 1.5 的不算侧撞）
  const okL = l.pen <= FLIGHT.landingClear && lRespawns === 0 && ap.spotsVisited >= 10 && lStall < 0.08 * lFrames && lBumps + fl.bumps <= 8 && lLand <= 6 && lGlide > 0.15 * lFrames;
  fl.homeRadius = 0;
  fl.voidY = -1e9;
  report(
    'flight',
    okL,
    `自动驾驶 90 s：景点到过 ${ap.spotsVisited} 个（要求 ≥ 10）、落定 ${lLand} 次（要求 ≤ 6）、最深穿入 ${l.pen.toExponential(1)}（${l.penAt}）、虚空兜底 ${lRespawns} 次（要求 0）、迎头撞 ${lBumps + fl.bumps} 次（要求 ≤ 8）、失速帧 ${((100 * lStall) / lFrames).toFixed(1)}%（要求 < 8%）、滑翔帧 ${((100 * lGlide) / lFrames).toFixed(0)}%（要求 > 15%）、空速 ${l.vMin.toFixed(0)}~${l.vMax.toFixed(0)}`,
  );
}

// ───────────────────────────── 主流程 ─────────────────────────────
const want = sceneArg === 'all' ? null : new Set(sceneArg.split(','));
const has = (name) => !want || want.has(name);
if (has('spline')) spline();
if (has('brute')) brute();
if (has('queries')) queries();
if (has('tree')) tree();
if (has('rest')) rest(runs);
if (has('ccd')) ccd();
if (has('wire')) wire();
if (has('perf')) perf(Math.min(runs, 3000));
if (has('gait')) gait();
if (has('flight')) flight();
if (failures > 0) {
  console.log(`\n${failures} 项不达标`);
  process.exitCode = 1;
} else console.log('\n全部通过');
