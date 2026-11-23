// 冬日庭院布局的无头自检：不开浏览器，直接用 Node 跑纯数据布局 + src/sim 碰撞层。
// 检查项：
//   1. buildWorld 零报错，统计各类表面数量与构建耗时；
//   2. 所有栖木（Layout.curves）不被盒体吞没（两端 10% 允许埋进母体 / 盆土）；
//   3. 进出通道沿途每个采样点离任何碰撞体 ≥ CLEARANCE（落点周围 8 cm 除外），落点本身干净；
//   4. 小球探针：从天窗正上方落下、从草坪朝门洞平射，最终都必须停在阳光房 / 大植物园室内且落在允许的面上；
//   5. 枯草密度：阳光房室内与门前走廊必须为 0 / 稀疏；
//   6. 全场景落脚点覆盖：屋顶斜坡多点采样、烟囱、阳台 / 露台栏杆、电线、电线杆横担与瓷瓶、路灯弯臂与灯顶、长椅座面与靠背、
//      栅栏、院心海棠与温室春树每根枝……每个落点按飞行器 landingClean 的同一规则检查（法线朝上 + 1 cm 内没有别的面）；
//   7. 屋面无洞：三座建筑从上方 / 下方投射，除天窗开口外每一格都被屋面接住；屋面之间 / 屋面和墙顶之间没有缝；
//   8. 玻璃碰撞盒 ≥ 10 cm 厚；阳光房和大植物园之间的夹缝除拱门洞外填实、拱门洞畅通；
//   9. 树：院心老海棠 + 温室春树每根 ≥ 0.22 cm 的枝都注册成了 CurvePerch；春树梢头不穿拱面顶梁；
//  10. 屋顶上真蹦：用步态 Locomotion 在洋房 / 阳光房 / 植物园的斜板上朝上坡连跳，必须走上屋脊 / 越过折线节点，全程不陷入；
//  11. 覆雪面的碰撞顶面 = 视觉积雪的真实外表面（屋顶 / 雨棚 / 门廊雪板顶面线、雪卷半径、全部平顶雪面的高度）；山墙分级盒的每个顶角
//      都在对应屋面斜板之下 ≥ 3 cm（100% 藏在 SlopeSurface 里）。
// 任何一项不达标，进程以非零码退出。
// 用法：node tools/courtyard_check.mjs [--debug]
import { performance } from 'node:perf_hooks';
import {
  BALCONY,
  CLEARANCE,
  CONSV,
  CONSV_DOOR,
  CONSV_VENT,
  GH_DOOR,
  TERRACE,
  TROUGH,
  consRoofY,
  ghRoofY,
  houseRoofY,
  CORRIDORS,
  GH,
  GH_ARCH,
  GH_VENT,
  HOUSE,
  ROOF_SNOW,
  AWNING_SNOW,
  PORCH_SNOW,
  AWNING,
  PORCH,
  CHIMNEY,
  AC_UNIT,
  BENCH,
  FENCE,
  POLE,
  slabLift,
  lineY,
  buildCourtyardLayout,
  buildCourtyardWorld,
  buildSpringGround,
  courtyardStats,
  grassDensity,
  insideGreenhouse,
  limbClear,
  pointInBox,
  springHeight,
  springTreeLimbs,
  isPerchLimb,
} from '../src/pcg/courtyard.ts';
import { CurvePerch } from '../src/sim/curvePerch.ts';
import { makeContact } from '../src/sim/surface.ts';
import { SlopeSurface } from '../src/sim/slopeSurface.ts';
import { Locomotion } from '../src/sim/locomotion.ts';
// 院心那棵老海棠（观鸟管线的生成器，依赖 three，Node 里也能直接 import）：和页面里 Branches 建的是同一棵树（同种子、同禁入区）
import { growCrabappleTree, crabapplePerchCurves } from '../src/world/crabappleTree.ts';

const debug = process.argv.includes('--debug');
let failures = 0;
const fail = (msg) => {
  failures++;
  console.log(`  ✗ ${msg}`);
};
const ok = (msg) => console.log(`  ✓ ${msg}`);

// 和 src/sim/flight.ts 同一套落点规则（那边是模块私有常量，这里照抄）：法线朝上门限、落点周围多少 cm 内不能贴着别的面
const MIN_NY = 0.4;
const CAPTURE_CLEAR = 1;

// ───────────────────────── 1. 构建 ─────────────────────────
console.log('① 构建布局与碰撞体');
const tree = growCrabappleTree(2024, 7, { avoid: limbClear, rootMound: false });
const treeCurves = crabapplePerchCurves(tree);
const t0 = performance.now();
const layout = buildCourtyardLayout(treeCurves);
const tLayout = performance.now() - t0;
const t1 = performance.now();
const world = buildCourtyardWorld(layout);
const tWorld = performance.now() - t1;
const stats = courtyardStats(layout);
console.log(`  布局 ${tLayout.toFixed(0)} ms · buildWorld ${tWorld.toFixed(0)} ms · ${world.surfaces.length} 个表面`);
console.log(`  ${stats.curves} 条曲线 / ${stats.grounds} 片雪面 / ${stats.boxes} 个盒体 / ${stats.slopes} 块斜板`);
console.log(`  院心老海棠（观鸟管线那棵）${tree.specs.length} 根枝，其中 ${treeCurves.length} 根可落（板根 / 果台不算）`);
console.log(`  按标签：${Object.entries(stats.byTag).map(([k, v]) => `${k}×${v}`).join(' ')}`);
if (layout.curves[0] !== (await import('../src/pcg/layout.ts')).HERO_BRANCH) fail('第一条曲线不是 HERO_BRANCH');
else ok('HERO_BRANCH 原位在 curves[0]');

// 表面 → 标签（登记顺序：曲线 → 雪面 → 盒体 → 斜板 → 春日地形，见 buildWorld）
const tagOf = new Map();
let cursor = 0;
layout.curves.forEach((c) => tagOf.set(world.surfaces[cursor++], c.tag));
layout.grounds.forEach((g) => tagOf.set(world.surfaces[cursor++], g.tag));
layout.boxes.forEach((b) => tagOf.set(world.surfaces[cursor++], b.tag));
layout.slopes.forEach((s) => tagOf.set(world.surfaces[cursor++], s.tag));
tagOf.set(world.surfaces[cursor], 'spring');
if (cursor + 1 !== world.surfaces.length) fail(`表面数对不上：登记了 ${cursor + 1} 个，世界里有 ${world.surfaces.length} 个`);
const tag = (s) => (s ? tagOf.get(s) ?? s.constructor.name : '空');
{
  const field = buildSpringGround();
  let worst = 0;
  for (let iz = 0; iz <= field.nz; iz++)
    for (let ix = 0; ix <= field.nx; ix++) {
      const x = field.x0 + ix * field.cell;
      const z = field.z0 + iz * field.cell;
      worst = Math.max(worst, Math.abs(field.heights[iz * (field.nx + 1) + ix] - springHeight(x, z)));
    }
  if (worst < 1e-9) ok(`春日微地形高度场 ${field.nx + 1}×${field.nz + 1} 节点 = springHeight（最大偏差 ${worst.toExponential(1)}）`);
  else fail(`春日微地形高度场与 springHeight 偏差 ${worst}`);
}

// ───────────────────────── 2. 栖木不被盒体吞没 ─────────────────────────
console.log('② 栖木 vs 盒体');
const contact = makeContact();
const frame = { cx: 0, cy: 0, cz: 0, ux: 0, uy: 0, uz: 0, sx: 0, sy: 0, sz: 0, tx: 0, ty: 0, tz: 0, radius: 0 };
let swallowedCurves = 0;
let checked = 0;
layout.curves.forEach((c, ci) => {
  const perch = world.surfaces[ci];
  if (!(perch instanceof CurvePerch)) return;
  const n = perch.segments;
  let covered = 0;
  let total = 0;
  let first = null;
  for (let i = 0; i <= n; i++) {
    const s = i / n;
    if (s < 0.1 || s > 0.9) continue;
    perch.frameAt(s * perch.length, frame);
    total++;
    for (const b of layout.boxes) {
      // 雪卷穿过撑着它的构件是正常结构（横担雪条穿过瓷瓶）
      if (c.tag === 'pole-snow' && b.tag === 'pole') continue;
      if (!pointInBox(frame.cx, frame.cy, frame.cz, b.min, b.max)) continue;
      // 栖木顶点 (中心 + 半径朝上) 还严格在盒里 = 这一段被盖住；横杆穿过栅栏柱 / 立柱是正常结构：只有超过 25% 的采样段被盖住才算吞没
      if (!(frame.cx > b.min[0] && frame.cx < b.max[0] && frame.cy + frame.radius < b.max[1] && frame.cz > b.min[2] && frame.cz < b.max[2])) continue;
      covered++;
      if (!first) first = `${c.tag} @(${frame.cx.toFixed(1)}, ${frame.cy.toFixed(1)}, ${frame.cz.toFixed(1)}) 进 ${b.tag}`;
      break;
    }
  }
  checked += total;
  if (total > 0 && covered / total > 0.25) {
    swallowedCurves++;
    console.log(`    ✗ ${c.tag}：${covered}/${total} 段被盒体盖住，首次 ${first}`);
  }
});
if (swallowedCurves === 0) ok(`${checked} 个栖木采样点，没有栖木被盒体吞没`);
else fail(`${swallowedCurves} 条栖木被盒体吞没`);

// ───────────────────────── 3. 通道净空 ─────────────────────────
console.log(`③ 进出通道净空（半径 ≥ ${CLEARANCE} cm）+ 落点干净`);
const near = [];
for (const cor of CORRIDORS) {
  let worst = Infinity;
  let worstAt = null;
  let worstTag = null;
  const pts = [...cor.points, cor.landing];
  let samples = 0;
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1];
    const b = pts[k];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const steps = Math.max(2, Math.ceil(len / 1));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = a[0] + (b[0] - a[0]) * t;
      const y = a[1] + (b[1] - a[1]) * t;
      const z = a[2] + (b[2] - a[2]) * t;
      // 落点按“落点上方”检查：落点本身离栖面 2 cm 是故意的
      const c = world.closest(x, y, z, contact);
      samples++;
      const d = c.surface ? c.dist : Infinity;
      if (d < worst) {
        worst = d;
        worstAt = [x, y, z];
        worstTag = c.surface ? tag(c.surface) : null;
      }
    }
  }
  // 落点本身离栖面 2 cm 是故意的：落点周围 8 cm 内的采样点不要求净空（鸟最后是收翅落下去的）
  const isLanding = worstAt && Math.hypot(worstAt[0] - cor.landing[0], worstAt[1] - cor.landing[1], worstAt[2] - cor.landing[2]) < 8;
  if (worst >= CLEARANCE || isLanding) ok(`通道 ${cor.name}：${samples} 个采样点，最小净空 ${worst === Infinity ? '∞' : worst.toFixed(1)} cm（${worstTag ?? '空'}）`);
  else fail(`通道 ${cor.name}：在 (${worstAt.map((v) => v.toFixed(1)).join(', ')}) 只有 ${worst.toFixed(1)} cm，撞上 ${worstTag}`);
}

// 室内自由空间抽查：几个明显该空的位置附近 10 cm 内不该有东西
const openSpots = [
  [0, 60, -300],
  [160, 120, -450],
  [-40, 30, -480],
  [260, 110, -250],
  [60, 0, -250],
  [600, 0, 600],
  [1100, 100, 300],
  [800, 250, -700],
  [1300, 50, -800],
  [500, 150, 900],
];
for (const s of openSpots) {
  const c = world.closest(s[0], s[1], s[2], contact);
  const d = c.surface ? c.dist : Infinity;
  if (d < 10) fail(`室内 (${s.join(', ')}) 净空只有 ${d.toFixed(1)} cm（${tag(c.surface)}）`);
}
ok(`室内 ${openSpots.length} 个抽查点净空 ≥ 10 cm`);

// ───────────────────────── 4. 小球探针 ─────────────────────────
console.log('④ 小球探针（r = 3 cm，重力 981，240 Hz）');
const G = 981;
const R = 3;
function launch(p0, v0, label) {
  const p = [...p0];
  const v = [...v0];
  const dt = 1 / 240;
  let rest = 0;
  let hits = 0;
  for (let t = 0; t < 8; t += dt) {
    v[1] -= G * dt;
    p[0] += v[0] * dt;
    p[1] += v[1] * dt;
    p[2] += v[2] * dt;
    const c = world.closest(p[0], p[1], p[2], contact);
    if (c.surface && c.dist < R) {
      const push = R - c.dist;
      p[0] += c.nx * push;
      p[1] += c.ny * push;
      p[2] += c.nz * push;
      const vn = v[0] * c.nx + v[1] * c.ny + v[2] * c.nz;
      if (vn < 0) {
        v[0] -= c.nx * vn * 1.25;
        v[1] -= c.ny * vn * 1.25;
        v[2] -= c.nz * vn * 1.25;
        hits++;
      }
      v[0] *= 0.75;
      v[1] *= 0.9;
      v[2] *= 0.75;
    }
    const speed = Math.hypot(v[0], v[1], v[2]);
    if (speed < 12) rest += dt;
    else rest = 0;
    if (rest > 0.4) break;
  }
  const c = world.closest(p[0], p[1], p[2], contact);
  const on = c.surface ? tag(c.surface) : 'nothing';
  const inside = insideGreenhouse(p[0], p[1], p[2]);
  const pS = p.map((q) => q.toFixed(1)).join(', ');
  if (!inside) {
    fail(`${label}：停在 (${pS})，不在阳光房室内（落在 ${on} 上）`);
    return;
  }
  const good = /^(gh-stand|gh-shelf|pot|gh-tie|gh-rail|gh-table|gh-floor|gh-dish|stem)$/.test(on);
  if (!good) fail(`${label}：停在室内 (${pS})，但落在 ${on} 上`);
  else ok(`${label}：${hits} 次碰撞后停在 (${pS})，落在 ${on} 上`);
}
launch([(GH_VENT.x0 + GH_VENT.x1) / 2 + 10, 400, (GH_VENT.z0 + GH_VENT.z1) / 2], [0, -30, 0], '天窗直落');
// 门洞平射走 y = 10 的航线：院心老海棠的冠梢探到门前 y ≥ 20 的空间（航线上方 10 cm 以上），从高处平射会先撞到树
launch([96, 10, 80], [0, -10, -600], '门洞平射');
// 大植物园：天窗直落 / 西门平射 / 拱门平射都必须停在温室里（地形 / 汀步 / 石槽 / 春树枝上）
const insideConsv = (x, y, z) => x > CONSV.x0 + CONSV.wallT && x < CONSV.x1 - CONSV.wallT && z > CONSV.z0 + CONSV.wallT && z < CONSV.z1 - CONSV.wallT && y > springHeight(x, z) - 6 && y < consRoofY(x) - 8;
function launchConsv(p0, v0, label) {
  const p = [...p0];
  const v = [...v0];
  const dt = 1 / 240;
  let rest = 0;
  let hits = 0;
  for (let t = 0; t < 8; t += dt) {
    v[1] -= G * dt;
    p[0] += v[0] * dt;
    p[1] += v[1] * dt;
    p[2] += v[2] * dt;
    const c = world.closest(p[0], p[1], p[2], contact);
    if (c.surface && c.dist < R) {
      const push = R - c.dist;
      p[0] += c.nx * push;
      p[1] += c.ny * push;
      p[2] += c.nz * push;
      const vn = v[0] * c.nx + v[1] * c.ny + v[2] * c.nz;
      if (vn < 0) {
        v[0] -= c.nx * vn * 1.25;
        v[1] -= c.ny * vn * 1.25;
        v[2] -= c.nz * vn * 1.25;
        hits++;
      }
      v[0] *= 0.75;
      v[1] *= 0.9;
      v[2] *= 0.75;
    }
    const speed = Math.hypot(v[0], v[1], v[2]);
    if (speed < 12) rest += dt;
    else rest = 0;
    if (rest > 0.4) break;
  }
  const c = world.closest(p[0], p[1], p[2], contact);
  const on = c.surface ? tag(c.surface) : 'nothing';
  const pS = p.map((q) => q.toFixed(1)).join(', ');
  if (!insideConsv(p[0], p[1], p[2])) {
    fail(`${label}：停在 (${pS})，不在大植物园室内（落在 ${on} 上）`);
    return;
  }
  const good = /^(spring|spring-tree|spring-tree-twig|gravel|trough|cv-.*)$/.test(on);
  if (!good) fail(`${label}：停在室内 (${pS})，但落在 ${on} 上`);
  else ok(`${label}：${hits} 次碰撞后停在 (${pS})，落在 ${on} 上`);
}
launchConsv([795, 700, 100], [0, -30, 0], '大植物园天窗直落');
launchConsv([250, -70, 320], [520, 0, 0], '大植物园西门平射');
launchConsv([250, -20, -480], [420, 0, 0], '小花房拱门平射');

// ───────────────────────── 5. 枯草密度 ─────────────────────────
console.log('⑤ 枯草密度');
let n = 0;
let sum = 0;
let insideGh = 0;
let inDoorLane = 0;
for (let x = -1090; x <= 1630; x += 7) {
  for (let z = -1190; z <= 1190; z += 7) {
    const d = grassDensity(x, z);
    n++;
    sum += d;
    if (pointInBox(x, 0, z, [GH.x0, 0, GH.z0], [GH.x1, 0, GH.z1]) && d > 0) insideGh++;
    if (x > 40 && x < 160 && z > -160 && z < 260 && d > 0.2) inDoorLane++;
    if (x > 220 && x < 360 && z > 190 && z < 450 && d > 0.2) inDoorLane++;
  }
}
const mean = sum / n;
console.log(`  平均密度 ${(mean * 100).toFixed(1)}% · 室内非零 ${insideGh} · 门前走廊 >20% 的 ${inDoorLane}`);
if (insideGh === 0) ok('阳光房范围内不长枯草');
else fail(`${insideGh} 个采样点在阳光房里长草`);
if (inDoorLane === 0) ok('门前进出走廊保持稀疏');
else fail(`门前走廊有 ${inDoorLane} 个采样点草太密`);

// ───────────────────────── 6. 全场景落脚点覆盖 ─────────────────────────
console.log('⑥ 全场景落脚点覆盖（飞行器 landingClean 同一规则：法线 ny ≥ 0.4、落点 1 cm 内没有别的面）');
/**
 * 落点检查：把探针放在表面外 0.02 cm 处（飞行器的 landingClear），最近的必须是目标面、法线朝上，
 * 且 1 cm 内贴着的任何别的面都会让飞行器拒绝落在这里。want = 期望的表面（null = 不限）。
 */
const probe = (x, y, z, want, tol = 0.5) => {
  const c = world.closest(x, y, z, contact);
  if (!c.surface) return { ok: false, why: '周围没有表面' };
  if (want && c.surface !== want) return { ok: false, why: `最近的是 ${tag(c.surface)}（dist ${c.dist.toFixed(2)}）` };
  if (c.ny < MIN_NY) return { ok: false, why: `法线 ny ${c.ny.toFixed(2)}（${tag(c.surface)}）` };
  if (Math.abs(c.dist) > tol) return { ok: false, why: `离目标面 ${c.dist.toFixed(2)} cm` };
  const k = world.query(x, y, z, CAPTURE_CLEAR, near);
  for (let i = 0; i < k; i++) {
    const q = near[i];
    if (q.surface !== c.surface) return { ok: false, why: `1 cm 内贴着 ${tag(q.surface)}（dist ${q.dist.toFixed(2)} @(${q.px.toFixed(1)}, ${q.py.toFixed(1)}, ${q.pz.toFixed(1)})）` };
  }
  return { ok: true };
};
/** 一个目标面（盒顶 / 斜板顶 / 曲线顶）的多个采样点里至少要有 minClean 个干净落点；返回干净率。 */
const spots = [];
const testGroup = (name, list, { minClean = 1, all = false } = {}) => {
  let clean = 0;
  const bad = [];
  for (const s of list) {
    const r = probe(s[0], s[1], s[2], s[3] ?? null);
    if (r.ok) clean++;
    else bad.push({ at: s.slice(0, 3).map((v) => +v.toFixed(1)), why: r.why });
  }
  spots.push({ name, total: list.length, clean });
  const ratio = list.length ? clean / list.length : 1;
  if (list.length === 0) {
    fail(`${name}：布局里找不到这种表面`);
    return;
  }
  if (clean < minClean || (all && clean !== list.length)) {
    fail(`${name}：${list.length} 个落点只有 ${clean} 个干净${all ? '（要求全部）' : `（要求 ≥ ${minClean}）`}；${bad
      .slice(0, 3)
      .map((b) => `(${b.at.join(', ')}) ${b.why}`)
      .join('；')}`);
  } else ok(`${name}：${list.length} 个落点，${clean} 个干净${ratio < 1 ? `（${(ratio * 100).toFixed(0)}%${debug ? '；' + bad.slice(0, 2).map((b) => `(${b.at.join(', ')}) ${b.why}`).join('；') : ''}）` : ''}`);
};

// 6a. 盒顶：每个盒子的顶面铺一张内缩 2 cm 的网格（大面最多 7×7），要求至少一个干净落点
const boxSpotsOf = (pred) => {
  const out = [];
  layout.boxes.forEach((b, i) => {
    if (!pred(b)) return;
    const s = world.surfaces[layout.curves.length + layout.grounds.length + i];
    const sx = b.max[0] - b.min[0] - 4;
    const sz = b.max[2] - b.min[2] - 4;
    const nx = sx < 0.5 ? 1 : Math.min(7, Math.max(3, Math.ceil(sx / 25)));
    const nz = sz < 0.5 ? 1 : Math.min(7, Math.max(3, Math.ceil(sz / 25)));
    for (let a = 0; a < nx; a++)
      for (let c = 0; c < nz; c++) {
        const x = nx === 1 ? (b.min[0] + b.max[0]) / 2 : b.min[0] + 2 + (sx * (a + 0.5)) / nx;
        const z = nz === 1 ? (b.min[2] + b.max[2]) / 2 : b.min[2] + 2 + (sz * (c + 0.5)) / nz;
        out.push([x, b.max[1] + 0.02, z, s]);
      }
  });
  return out;
};
const boxOf = (tagName) => (b) => b.tag === tagName;
testGroup('烟囱帽顶积雪（顶面 = 雪面 1003）', boxSpotsOf(boxOf('chimney')), { minClean: 3 });
testGroup('两个陶烟囱管口', boxSpotsOf(boxOf('chimney-pot')), { minClean: 2 });
testGroup('二楼阳台楼板', boxSpotsOf(boxOf('balcony')), { minClean: 4 });
testGroup('三楼露台楼板', boxSpotsOf(boxOf('terrace')), { minClean: 2 });
testGroup('阳台 / 露台台面积雪（顶面 = 雪面）', boxSpotsOf((b) => b.tag === 'balcony-snow' || b.tag === 'terrace-snow'), { minClean: 4 });
testGroup('露台侧面铁扶手 + 后角立柱雪帽（前沿扶手和它的雪卷另测）', boxSpotsOf((b) => b.tag === 'rail' && b.max[1] > 500 && b.max[2] - b.min[2] < 100), { minClean: 2 });
testGroup('窗台积雪（木挑板 + 3.5 cm 雪）', boxSpotsOf(boxOf('sill')), { minClean: 10 });
testGroup('窗下木花箱（积雪高出箱口 1 cm）', boxSpotsOf(boxOf('flowerbox')), { minClean: 6 });
testGroup('空调外机顶积雪', boxSpotsOf(boxOf('ac')), { minClean: 1 });
testGroup('正门石阶积雪', boxSpotsOf(boxOf('step-snow')), { minClean: 1 });
testGroup('院门顶积雪（顶面 = 雪面 −29）', boxSpotsOf(boxOf('gate-snow')), { minClean: 1 });
testGroup('栅栏横杆（上杆 / 下杆都是木杆本身）', boxSpotsOf(boxOf('fence')), { minClean: 30 });
testGroup('栅栏柱头雪团（顶面 = yTop + 8）', boxSpotsOf(boxOf('fence-snow')), { minClean: 30 });
testGroup('长椅座面雪座（顶面 = 雪面 −71.5）', boxSpotsOf(boxOf('bench-snow')), { minClean: 2 });
testGroup('路灯灯柱顶', boxSpotsOf(boxOf('lamp')), { minClean: 1 });
testGroup('路灯灯笼顶盘 + 雪锥尖', boxSpotsOf((b) => b.tag === 'lantern' || b.tag === 'lantern-snow'), { minClean: 2 });
testGroup('电线杆顶 + 四个瓷瓶（横担顶在雪条里，另测）', boxSpotsOf((b) => b.tag === 'pole' && b.max[2] - b.min[2] < 20), { minClean: 5 });
testGroup('阳光房横梁 / 工作桌 / 陶盘', boxSpotsOf((b) => b.tag === 'gh-tie' || b.tag === 'gh-table' || b.tag === 'gh-dish'), { minClean: 4 });
testGroup('阳光房阶梯花架各层木板', boxSpotsOf(boxOf('gh-stand')), { minClean: 3 });
testGroup('阳光房双层花架各层木板', boxSpotsOf((b) => b.tag === 'gh-shelf' && b.max[1] - b.min[1] < 10), { minClean: 2 });
testGroup('吊篮碗土面', boxSpotsOf(boxOf('gh-basket')), { minClean: 2 });
testGroup('花盆（小盆口 / 大盆土面）', boxSpotsOf(boxOf('pot')), { minClean: 10 });
testGroup('石槽压顶石四面 + 水面', boxSpotsOf(boxOf('trough')), { minClean: 6 });
testGroup('汀步石板（石面 + 0.6 cm 雪盖合成一个盒顶）', boxSpotsOf(boxOf('stone')), { minClean: 40 });
testGroup('阳光房 / 大植物园夹缝过梁顶', boxSpotsOf(boxOf('gh-joint')), { minClean: 1 });
{
  const ledge = [];
  layout.boxes.forEach((b, i) => {
    if (b.tag !== 'cv-wall' || b.max[1] !== CONSV.yLowWall) return;
    const surf = world.surfaces[layout.curves.length + layout.grounds.length + i];
    const west = Math.abs(b.min[0] - CONSV.x0) < 0.01;
    const east = Math.abs(b.max[0] - CONSV.x1) < 0.01;
    if (!west && !east) return; // 端墙玻璃整厚，没有窗台
    const x = west ? CONSV.x0 + 14 : CONSV.x1 - 14;
    const n = Math.max(2, Math.min(12, Math.round((b.max[2] - b.min[2] - 8) / 60)));
    for (let k = 0; k < n; k++) ledge.push([x, b.max[1] + 0.02, b.min[2] + 4 + (b.max[2] - b.min[2] - 8) * ((k + 0.5) / n), surf]);
  });
  testGroup('植物园矮墙内皮窗台（4 cm 宽）', ledge, { minClean: 4 });
}

// 6b. 斜板顶面：每块铺内缩 3 cm 的网格（间距 ≤ 30 cm），要求全部干净（屋面是连成一体的，不该有落不上的格子）
const slopeSpotsOf = (pred) => {
  const out = [];
  layout.slopes.forEach((s, i) => {
    if (!pred(s)) return;
    const surf = world.surfaces[layout.curves.length + layout.grounds.length + layout.boxes.length + i];
    if (surf instanceof SlopeSurface && surf.ny < MIN_NY) return;
    const ax = s.axis === 'x';
    const along = ax ? s.x1 - s.x0 : s.z1 - s.z0;
    const across = ax ? s.z1 - s.z0 : s.x1 - s.x0;
    const na = Math.max(2, Math.min(9, Math.ceil((along - 6) / 30)));
    const nc = Math.max(1, Math.min(5, Math.ceil((across - 6) / 60)));
    for (let a = 0; a < na; a++)
      for (let c = 0; c < nc; c++) {
        const t = 3 + ((along - 6) * (a + 0.5)) / na;
        const u = 3 + ((across - 6) * (c + 0.5)) / nc;
        const at = (ax ? s.x0 : s.z0) + t;
        const other = (ax ? s.z0 : s.x0) + u;
        const y = surf.topY(at);
        out.push([ax ? at : other, y + surf.ny * 0.02, ax ? other : at, surf]);
      }
  });
  return out;
};
testGroup('洋房屋顶雪被（南坡 / 北坡雪板 + 屋脊坡，顶面 = 视觉雪板顶面线）', slopeSpotsOf((s) => s.tag === 'roof-snow'), { all: true, minClean: 20 });
testGroup('二楼雨棚 + 正门小雨棚雪被', slopeSpotsOf((s) => s.tag === 'awning-snow' || s.tag === 'porch-snow'), { all: true, minClean: 4 });
testGroup('阳光房双坡玻璃顶（天窗留口四周；北坡被二楼阳台穿过的那片除外）', slopeSpotsOf((s) => s.tag === 'gh-roof').filter((p) => !(p[0] > BALCONY.x0 && p[0] < BALCONY.x1 && p[2] > HOUSE.z1 && p[2] < BALCONY.z1 + 6)), { all: true, minClean: 12 });
testGroup('阳光房天窗随坡 curb', slopeSpotsOf((s) => s.tag === 'gh-vent'), { all: true, minClean: 4 });
testGroup('大植物园折线拱面（13 块）', slopeSpotsOf((s) => s.tag === 'cv-roof'), { all: true, minClean: 30 });
testGroup('大植物园天窗随窗 curb（三根撑杆脚下除外）', slopeSpotsOf((s) => s.tag === 'cv-vent'), { minClean: 24 });
// 天窗盖子是陡板：顶面法线必须 < 0.4（落不住、只会把鸟顺势挡开），不能伪装成能落的平台
{
  let bad = 0;
  layout.slopes.forEach((s, i) => {
    if (s.tag !== 'gh-lid' && s.tag !== 'cv-lid') return;
    const surf = world.surfaces[layout.curves.length + layout.grounds.length + layout.boxes.length + i];
    if (!(surf instanceof SlopeSurface) || surf.ny >= MIN_NY) bad++;
  });
  if (bad === 0) ok('天窗盖子 4 块陡板 ny < 0.4（不是能落的平台）');
  else fail(`${bad} 块天窗盖子的顶面能落`);
}

// 6c. 曲线栖木：沿弧长采样，探针放在顶面外 0.02 cm
const curveSpotsOf = (pred, ts) => {
  const out = [];
  layout.curves.forEach((c, i) => {
    if (!pred(c)) return;
    const perch = world.surfaces[i];
    for (const t of ts) {
      perch.frameAt(t * perch.length, frame);
      // 顶面方向 = 世界 +Y 投到和切线垂直的平面上：枝越陡顶面越偏，uy < 0.4 的段没有朝上的面可落
      if (frame.uy < MIN_NY) continue;
      out.push([frame.cx + frame.ux * (frame.radius + 0.02), frame.cy + frame.uy * (frame.radius + 0.02), frame.cz + frame.uz * (frame.radius + 0.02), perch]);
    }
  });
  return out;
};
testGroup('两根跨院电线', curveSpotsOf((c) => c.tag === 'wire', [0.03, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.97]), { all: true, minClean: 10 });
// 弯臂：两端分别插在灯柱顶和灯笼尖顶里，只测中段
// 弯臂末梢插在灯笼雪锥里（画面上也是如此），只测到进雪锥之前
testGroup('路灯弯臂', curveSpotsOf((c) => c.tag === 'lamp-arm', [0.3, 0.38, 0.46, 0.54, 0.62, 0.7, 0.78]), { all: true, minClean: 5 });
// 雪卷 / 雪条都是圆杆栖木（半径 = 画面上雪卷的半径）
const rollTs = [0.02, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.98];
testGroup('洋房屋顶檐口雪卷 ×2（r 17）', curveSpotsOf((c) => c.tag === 'roof-snow', rollTs), { all: true, minClean: 10 });
testGroup('雨棚 / 门廊檐口雪卷 + 阳台 / 露台扶手雪卷 + 长椅靠背雪卷', curveSpotsOf((c) => /^(awning|porch|rail|bench)-snow$/.test(c.tag), rollTs), { minClean: 30 });
testGroup('栅栏上杆雪条', curveSpotsOf((c) => c.tag === 'fence-snow', rollTs), { minClean: 20 });
testGroup('电线杆横担雪条 + 阳光房屋脊雪卷', curveSpotsOf((c) => c.tag === 'pole-snow' || c.tag === 'gh-snow', rollTs), { minClean: 12 });
testGroup('门扇顶框圆杆（阳光房门 / 植物园双开门）', curveSpotsOf((c) => c.tag === 'gh-door' || c.tag === 'cv-rail', [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.92]), { minClean: 20 });
testGroup('花架前沿圆杆 + 吊篮沿', curveSpotsOf((c) => c.tag === 'gh-rail', [0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95]), { minClean: 20 });
testGroup('花盆口沿', curveSpotsOf((c) => c.tag === 'pot-rim', [0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95]), { minClean: 20 });
testGroup('山茶花枝', curveSpotsOf((c) => c.tag === 'stem', [0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85]), { minClean: 4 });
testGroup('植物园拱架拉杆', curveSpotsOf((c) => c.tag === 'cv-tie', [0.02, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.98]), { minClean: 40 });
testGroup('天窗撑杆（细铁杆）', curveSpotsOf((c) => c.tag === 'cv-rod' || c.tag === 'gh-rod', [0.2, 0.35, 0.5, 0.65, 0.8]), { minClean: 6 });

// 6d. 树：院心老海棠 + 温室三棵春树，每根枝沿弧长 4 个点，要求每根枝至少一个干净落点
const treeLanding = (pred, label) => {
  let limbs = 0;
  let limbOk = 0;
  let total = 0;
  let clean = 0;
  const dead = [];
  layout.curves.forEach((c, i) => {
    if (!pred(c)) return;
    const perch = world.surfaces[i];
    let any = false;
    let valid = 0;
    for (const t of [0.3, 0.5, 0.7, 0.9]) {
      perch.frameAt(t * perch.length, frame);
      if (frame.uy < MIN_NY) continue; // 竖直的树干没有朝上的面
      valid++;
      total++;
      const r = probe(frame.cx + frame.ux * (frame.radius + 0.02), frame.cy + frame.uy * (frame.radius + 0.02), frame.cz + frame.uz * (frame.radius + 0.02), perch);
      if (r.ok) {
        clean++;
        any = true;
      }
    }
    if (valid === 0) return; // 整根都没有朝上的面（竖直树干），不算落脚枝
    limbs++;
    if (any) limbOk++;
    else dead.push(c.tag);
  });
  if (limbOk === limbs) ok(`${label}：${limbs} 根枝每根都有干净落点（${total} 个采样点 ${clean} 个干净，${((clean / total) * 100).toFixed(0)}%）`);
  else fail(`${label}：${limbs - limbOk}/${limbs} 根枝找不到干净落点，例如 ${dead.slice(0, 5).join(' ')}`);
};
treeLanding((c) => c.tag.startsWith('tree:'), '院心老海棠');
treeLanding((c) => c.tag === 'spring-tree' || c.tag === 'spring-tree-twig', '温室三棵春树');

// 6e. 通道落点本身必须干净
for (const cor of CORRIDORS) {
  const r = probe(cor.landing[0], cor.landing[1], cor.landing[2], null, 2.5);
  if (r.ok) ok(`通道落点 ${cor.name} 干净`);
  else fail(`通道落点 ${cor.name}：${r.why}`);
}

// ───────────────────────── 7. 屋面无洞、墙顶封严 ─────────────────────────
console.log('⑦ 屋面无洞（从上方 / 下方逐格投射）');
const ROOF_TAGS = /^(roof|roof-snow|gable|chimney|chimney-pot|awning-snow|porch-snow|rail-snow|balcony-snow|terrace-snow|gh-roof|gh-vent|gh-lid|gh-glass|gh-gable|gh-snow|cv-roof|cv-vent|cv-lid|cv-gable|cv-beam|gh-joint|gh-beam)$/;
/** 从 (x, y, z) 竖直投射：返回第一个碰到的表面（步长 1 cm）。 */
const castDown = (x, y, z, stopY) => {
  for (; y > stopY; y -= 1) {
    const c = world.closest(x, y, z, contact);
    if (c.surface && c.dist <= 0) return c.surface;
  }
  return null;
};
const castUp = (x, y, z, stopY) => {
  for (; y < stopY; y += 1) {
    const c = world.closest(x, y, z, contact);
    if (c.surface && c.dist <= 0) return c.surface;
  }
  return null;
};
const inRect = (x, z, x0, z0, x1, z1) => x > x0 && x < x1 && z > z0 && z < z1;
{
  let holes = 0;
  let cells = 0;
  const first = [];
  // 洋房：从屋脊上方 950 往下投，每一格都该先碰到屋面 / 山墙 / 烟囱（屋面之下是实心楼体，从室内往上投没有意义）
  for (let x = HOUSE.x0 - HOUSE.overhang + 5; x < HOUSE.x1 + HOUSE.overhang; x += 10)
    for (let z = HOUSE.z0 - HOUSE.overhang + 5; z < HOUSE.z1 + HOUSE.overhang; z += 10) {
      cells++;
      const s = castDown(x, HOUSE.yRidge + 60, z, HOUSE.yEave - 20);
      if (!s || !ROOF_TAGS.test(tag(s))) {
        holes++;
        if (first.length < 3) first.push(`(${x}, ${z}) → ${s ? tag(s) : '穿到檐口以下'}`);
      }
    }
  // 阳光房：从上方 320 投到檐口 140；再从室内地面往上投到 260——屋面之下每一格都该被屋面 / 脊梁接住
  for (let x = GH.x0 + 5; x < GH.x1; x += 10)
    for (let z = GH.z0 + 5; z < GH.z1; z += 10) {
      const vent = inRect(x, z, GH_VENT.x0, GH_VENT.z0, GH_VENT.x1, GH_VENT.z1);
      // 二楼阳台 x −470..150 伸到 z −450，东段压在阳光房北坡上方（楼板 155~170、栏杆到 294 穿过板面）：既有布局，这片格子跳过
      if (x > BALCONY.x0 && x < BALCONY.x1 && z > HOUSE.z1 && z < BALCONY.z1 + 6) continue;
      cells++;
      const s = castDown(x, GH.yRidge + 60, z, GH.yEave - 1);
      if (vent ? s !== null && !/lid$/.test(tag(s)) : !s || !ROOF_TAGS.test(tag(s))) {
        holes++;
        if (first.length < 3) first.push(`阳光房上方 (${x}, ${z}) → ${s ? tag(s) : vent ? '天窗口畅通' : '穿进室内'}`);
      }
      if (vent || (x > BALCONY.x0 && x < BALCONY.x1 && z > HOUSE.z1 && z < BALCONY.z1 + 6)) continue;
      cells++;
      // 先碰到桌 / 花架 / 横梁也算接住（它们本来就在屋里）；只有一路穿到屋脊上方才是屋面有洞
      const u = castUp(x, GH.yFloor + 2, z, GH.yRidge + 1);
      if (!u) {
        holes++;
        if (first.length < 3) first.push(`阳光房下方 (${x}, ${z}) → ${u ? tag(u) : '穿出屋面'}`);
      }
    }
  // 大植物园：从上方 680 投到檐口 330；天窗口必须畅通；再从地形上方 2 cm 往上投到 601（先碰到树枝 / 陈设也算接住）
  for (let x = CONSV.x0 + 5; x < CONSV.x1; x += 15)
    for (let z = CONSV.z0 + 5; z < CONSV.z1; z += 15) {
      const vent = inRect(x, z, CONSV_VENT.x0, CONSV_VENT.z0, CONSV_VENT.x1, CONSV_VENT.z1);
      cells++;
      const s = castDown(x, CONSV.yRidge + 60, z, CONSV.yEave - 1);
      if (vent ? s !== null && !/lid$/.test(tag(s)) : !s || !ROOF_TAGS.test(tag(s))) {
        holes++;
        if (first.length < 3) first.push(`植物园上方 (${x}, ${z}) → ${s ? tag(s) : vent ? '天窗口畅通' : '穿进室内'}`);
      }
      if (vent) continue;
      cells++;
      const u = castUp(x, springHeight(x, z) + 2, z, CONSV.yRidge + 1);
      if (!u) {
        holes++;
        if (first.length < 3) first.push(`植物园下方 (${x}, ${z}) → ${u ? tag(u) : '穿出屋面'}`);
      }
    }
  if (holes === 0) ok(`洋房 / 阳光房 / 大植物园 ${cells} 格全部被屋面接住（天窗口畅通）`);
  else fail(`屋面有 ${holes}/${cells} 格漏了：${first.join('；')}`);
}
// 墙顶封严：沿每堵玻璃墙的墙顶（yEave）每隔 20 cm 从墙里 1 cm 处往上一格格查，墙顶以上到屋面板之间不能有空气层
{
  let gaps = 0;
  let cells = 0;
  const first = [];
  const sealUp = (x, z, yWallTop, yRoofTop, label) => {
    cells++;
    // 从墙顶下方 1 cm 出发往上走到屋面板顶面下 0.3 cm：中途任何一格不在实心里 = 墙顶和屋面板之间有空气夹层
    for (let y = yWallTop - 1; y < yRoofTop - 0.3; y += 0.5) {
      const c = world.closest(x, y, z, contact);
      if (!(c.surface !== null && c.dist <= 0)) {
        gaps++;
        if (first.length < 4) first.push(`${label} (${x.toFixed(0)}, ${y.toFixed(1)}, ${z.toFixed(0)}) 离 ${tag(c.surface)} ${c.dist.toFixed(1)} cm`);
        return;
      }
    }
  };
  for (let x = GH.x0 + 10; x < GH.x1; x += 20) {
    if (x > GH_DOOR.x0 && x < GH_DOOR.x1) continue;
    sealUp(x, GH.z1 - 6, GH.yEave, ghRoofY(GH.z1 - 6), '阳光房南墙顶');
  }
  for (let z = GH.z0 + 10; z < GH.z1; z += 20) sealUp(GH.x0 + 6, z, GH.yEave, ghRoofY(z), '阳光房西墙顶');
  for (let z = CONSV.z0 + 10; z < CONSV.z1; z += 20) {
    if (z > GH_ARCH.z0 && z < GH_ARCH.z1) continue;
    if (z > CONSV_DOOR.z0 && z < CONSV_DOOR.z1) continue;
    sealUp(CONSV.x0 + 6, z, CONSV.yEave, consRoofY(CONSV.x0 + 6), '植物园西墙顶');
    sealUp(CONSV.x1 - 6, z, CONSV.yEave, consRoofY(CONSV.x1 - 6), '植物园东墙顶');
  }
  for (let x = CONSV.x0 + 10; x < CONSV.x1; x += 20) {
    sealUp(x, CONSV.z0 + 6, CONSV.yEave, consRoofY(x), '植物园北墙顶');
    sealUp(x, CONSV.z1 - 6, CONSV.yEave, consRoofY(x), '植物园南墙顶');
  }
  for (let x = HOUSE.x0 + 10; x < HOUSE.x1; x += 20) {
    sealUp(x, HOUSE.z1 - 6, HOUSE.yEave, houseRoofY(HOUSE.z1 - 6), '洋房南墙顶');
    sealUp(x, HOUSE.z0 + 6, HOUSE.yEave, houseRoofY(HOUSE.z0 + 6), '洋房北墙顶');
  }
  if (gaps === 0) ok(`${cells} 处墙顶 → 屋面板之间是连续实心（没有能把鸟夹住的空气夹层）`);
  else fail(`墙顶和屋面板之间有 ${gaps}/${cells} 处空气夹层，例如 ${first.join('；')}`);
}

// ───────────────────────── 8. 玻璃厚度、夹缝 ─────────────────────────
console.log('⑧ 玻璃厚度 / 两馆夹缝');
{
  let thin = 0;
  let count = 0;
  for (const b of layout.boxes) {
    if (b.tag !== 'gh-glass' && b.tag !== 'cv-glass') continue;
    count++;
    const t = Math.min(b.max[0] - b.min[0], b.max[2] - b.min[2]);
    if (t < 10) thin++;
  }
  if (thin === 0) ok(`${count} 块玻璃碰撞盒厚度都 ≥ 10 cm`);
  else fail(`${thin}/${count} 块玻璃碰撞盒不到 10 cm`);
}
{
  // 夹缝 x ∈ (GH.x1, CONSV.x0)、z ∈ (GH.z0, GH.z1)、y ∈ (雪面, 檐口)：拱门洞（中心 ±56、半圆顶）以内必须畅通，其余必须实心
  let freeInSolid = 0;
  let solidInDoor = 0;
  let cells = 0;
  const first = [];
  const zc = (GH_ARCH.z0 + GH_ARCH.z1) / 2;
  // 夹缝里的开口 = 拱门洞整块矩形 z ∈ (z0, z1) × y < yTop + r（半圆拱形只存在于阳光房东墙的门框里，缝本身是上下贯通的矩形洞）；
  // 按矩形开口收缩 6 cm 必须畅通、外扩 4 cm 之外必须实心，中间一圈不计
  for (let y = -95; y < CONSV.yEave - 1; y += 4)
    for (let z = GH.z0 + 2; z < GH.z1 - 2; z += 4) {
      const x = (GH.x1 + CONSV.x0) / 2;
      const c = world.closest(x, y, z, contact);
      const isIn = c.surface !== null && c.dist <= 0;
      const ad = Math.min(GH_ARCH.r - Math.abs(z - zc), GH_ARCH.yTop + GH_ARCH.r - y); // 到矩形开口边界的距离（内正外负）
      if (ad > -4 && ad < 6) continue;
      const inDoor = ad >= 6;
      cells++;
      if (inDoor && isIn) {
        solidInDoor++;
        if (first.length < 3) first.push(`拱门洞里 (${y.toFixed(0)}, ${z.toFixed(0)}) 是实心（${tag(c.surface)}）`);
      }
      if (!inDoor && !isIn) {
        freeInSolid++;
        if (first.length < 3) first.push(`夹缝里 (${y.toFixed(0)}, ${z.toFixed(0)}) 是空的`);
      }
    }
  if (solidInDoor === 0 && freeInSolid === 0) ok(`${cells} 格：拱门洞畅通、夹缝其余部分填实`);
  else fail(`拱门洞里 ${solidInDoor} 格实心 / 夹缝里 ${freeInSolid} 格空：${first.join('；')}`);
}

// ───────────────────────── 9. 树：枝条注册 + 不穿顶梁 ─────────────────────────
console.log('⑨ 树：枝条注册 / 温室春树不穿拱面顶梁');
{
  // 院心老海棠：crabapplePerchCurves 的数量 = specs 里 perch !== false 的数量；每条曲线的 segments ≥ 14（冠梢）/ 24（二级枝）
  const perchSpecs = tree.specs.filter((s) => s.perch !== false);
  if (perchSpecs.length === treeCurves.length) ok(`院心老海棠：${perchSpecs.length} 根可落枝全部注册（${tree.specs.length - perchSpecs.length} 根板根 / 果台不注册）`);
  else fail(`院心老海棠：${perchSpecs.length} 根可落枝只注册了 ${treeCurves.length} 根`);
  const segOf = (radii) => (radii.length === 4 && radii[0] < 2 ? 'twig' : radii.length === 3 ? 'crown' : radii.length === 4 ? 'sec' : 'other');
  let coarse = 0;
  for (const c of treeCurves) {
    const k = segOf(c.radii);
    if (k === 'sec' && (c.segments < 24 || c.radial < 8)) coarse++;
    if (k === 'twig' && (c.segments < 14 || c.radial < 6)) coarse++;
  }
  if (coarse === 0) ok('二级枝 24×8、冠梢 14×6 的细分全部到位');
  else fail(`${coarse} 根二级枝 / 冠梢细分不够`);
  // 温室春树：isPerchLimb 为真的枝（树干 / 主冠枝 / 二级枝 / 细枝）每根都在 curves 里，细枝基部半径 ≥ 0.22
  const springCurves = layout.curves.filter((c) => c.tag === 'spring-tree' || c.tag === 'spring-tree-twig');
  let expected = 0;
  let thin = 0;
  let minTwigR = Infinity;
  for (const limbs of springTreeLimbs())
    for (const l of limbs) {
      if (!isPerchLimb(l)) continue;
      expected++;
      if (l.tag === 'tree-twig') {
        minTwigR = Math.min(minTwigR, l.radii[0]);
        if (l.radii[0] < 0.22) thin++;
      }
    }
  if (springCurves.length === expected && thin === 0) ok(`温室三棵春树：${expected} 根可落枝全部注册（细枝基部半径最小 ${minTwigR.toFixed(2)} cm ≥ 0.22）`);
  else fail(`温室春树：应有 ${expected} 根，注册了 ${springCurves.length} 根，细枝半径 < 0.22 的 ${thin} 根`);
  // 不穿顶梁：对注册好的曲线沿样条每 4 cm 取一点，梢头（含半径）离拱面板底 consRoofY(x) − 8 至少 1 cm
  let worst = Infinity;
  let worstAt = null;
  for (const c of springCurves) {
    const perch = world.surfaces[layout.curves.indexOf(c)];
    const steps = Math.max(8, Math.round(perch.length / 4));
    for (let i = 0; i <= steps; i++) {
      perch.frameAt((i / steps) * perch.length, frame);
      const gap = consRoofY(frame.cx) - 8 - (frame.cy + frame.radius);
      if (gap < worst) {
        worst = gap;
        worstAt = [frame.cx, frame.cy, frame.cz];
      }
    }
  }
  if (worst >= 1) ok(`春树梢头离拱面板底最近 ${worst.toFixed(1)} cm（${worstAt.map((v) => v.toFixed(0)).join(', ')}），不穿顶梁`);
  else fail(`春树有枝梢穿进拱面板（离板底 ${worst.toFixed(1)} cm，在 ${worstAt.map((v) => v.toFixed(0)).join(', ')}）`);
  // 悬臂弹簧（2026-11-23 找回的弹性微交互）：老海棠二级枝 / 冠梢、春树二级枝 / 细枝都带 cantilever 弹簧（2.4 / 4.5 Hz），
  // 主干和一级主枝刚性；细枝挂到母枝曲线上（springParent 指向的曲线必须更早登记、自己也会动——母枝弯了细枝的根跟着走，焊口不裂）；
  // 跨院电线两根是两端固定的 wire 模式 2.4 Hz；推进 2 s 后所有振子归零（没有 NaN / 自激）
  {
    let secN = 0;
    let twigN = 0;
    let rigidN = 0;
    let bad = 0;
    layout.curves.forEach((c, i) => {
      if (!(c.tag.startsWith('tree:') || c.tag.startsWith('spring-'))) return;
      const s = world.surfaces[i];
      if (!s.dynamic) {
        rigidN++;
        return;
      }
      if (c.spring?.mode !== 'cantilever') bad++;
      else if (c.spring.freq === 2.4) secN++;
      else twigN++;
      if (c.springParent !== undefined) {
        const p = world.surfaces[c.springParent];
        if (!(p instanceof CurvePerch) || !p.dynamic || c.springParent >= i) bad++;
      }
    });
    const wires = layout.curves.filter((c) => c.tag === 'wire' && c.spring?.mode !== 'cantilever' && c.spring.freq === 2.4);
    for (const s of world.dynamicSurfaces) s.excite(0.7, 80, 1);
    for (let i = 0; i < 2000; i++) world.advance(1 / 200);
    const restless = world.dynamicSurfaces.filter((s) => s.cantilever && (s.ownOffset !== 0 || Number.isNaN(s.ownOffset))).length;
    const springOk = bad === 0 && rigidN > 0 && secN > 0 && twigN > 0 && wires.length === 2 && restless === 0;
    if (springOk) ok(`悬臂弹簧：二级枝 ${secN} 根 2.4 Hz、细枝 / 冠梢 ${twigN} 根 4.5 Hz、主干 / 主枝 ${rigidN} 根刚性、母枝挂接全部有效、电线 ${wires.length} 根 2.4 Hz（阻尼比 0.02，本来就晃得久）；枝条全部激发后 10 s 归零`);
    else fail(`悬臂弹簧：异常 ${bad}（模式 / 母枝挂接）、二级枝 ${secN}、细枝 ${twigN}、刚性 ${rigidN}、电线 ${wires.length}、10 s 后还在动 / NaN 的 ${restless}`);
  }
}

// ───────────────────────── 10. 屋顶上真蹦 ─────────────────────────
console.log('⑩ 屋顶上真蹦（Locomotion 连跳：地面连跳速度段 90~125 cm/s，一跳 2~3.6 cm 高）');
{
  const dt = 1 / 120;
  const climb = (label, x, y, z, hx, hz, seconds, goal) => {
    const loco = new Locomotion();
    if (!loco.place(world, x, y, z, hx, hz)) {
      fail(`${label}：起点 (${x}, ${y.toFixed(1)}, ${z}) 放不上去`);
      return;
    }
    let maxPen = 0;
    let offRoof = null;
    for (let t = 0; t < seconds; t += dt) {
      loco.update(dt, { x: hx, z: hz, hop: true, steer: true, move: 'forward' }, world);
      const c = world.closest(loco.pos.x, loco.pos.y, loco.pos.z, contact);
      if (c.surface) maxPen = Math.max(maxPen, -c.dist);
      if (!offRoof && !(c.surface instanceof SlopeSurface) && goal(loco.pos.x, loco.pos.y, loco.pos.z) === false && c.surface && c.dist < 0.5 && /Heightfield|BoxSurface/.test(tag(c.surface)) && !/roof|vent/.test(tag(c.surface))) {
        // 还没走到目标就落到了屋面以外的面（地面 / 盒顶）上
        offRoof = `t=${t.toFixed(1)} (${loco.pos.x.toFixed(0)}, ${loco.pos.y.toFixed(0)}, ${loco.pos.z.toFixed(0)}) 落在 ${tag(c.surface)}`;
      }
    }
    const reached = goal(loco.pos.x, loco.pos.y, loco.pos.z);
    const p = `(${loco.pos.x.toFixed(0)}, ${loco.pos.y.toFixed(0)}, ${loco.pos.z.toFixed(0)})`;
    if (!reached) fail(`${label}：${loco.hops} 跳后到 ${p}，没走到目标${offRoof ? `；${offRoof}` : ''}`);
    else if (maxPen > 1e-3) fail(`${label}：走到了 ${p}，但途中陷入屋面 ${maxPen.toFixed(3)} cm`);
    else ok(`${label}：${loco.hops} 跳到 ${p}，最大陷入 ${maxPen.toExponential(1)} cm`);
  };
  // 洋房南坡：从雪被上起步，翻过屋脊雪卷顶 (918) 走到北坡雪被——起点取碰撞的雪面顶
  const snowTop = (x, z) => {
    let best = null;
    layout.slopes.forEach((s, i) => {
      if (s.tag !== 'roof-snow') return;
      const surf = world.surfaces[layout.curves.length + layout.grounds.length + layout.boxes.length + i];
      if (surf.z0 <= z && z <= surf.z1 && surf.x0 <= x && x <= surf.x1) best = surf;
    });
    return best.topY(z);
  };
  climb('洋房南坡雪被 → 屋脊雪卷顶 → 北坡雪被', 0, snowTop(0, -540) + 0.5, -540, 0, -1, 7, (x, y, z) => z < -880);
  // 阳光房南坡：檐口起步走到屋脊雪卷脚下 (r 7 的雪卷横在屋脊上，蹦是翻不过去的，画面上也翻不过去)
  climb('阳光房南坡 → 屋脊雪卷脚下', 60, ghRoofY(-180) + 0.5, -180, 0, -1, 3.2, (x, y, z) => z < -352);
  // 植物园西坡：檐口起步，翻过最陡的第一段（35.8°）和后面三段折线，到天窗 curb 脚下 (x 740)
  climb('植物园西坡 → 四段折线 → 天窗 curb 脚下', 372, consRoofY(372) + 0.5, 420, 1, 0, 7, (x, y, z) => x > 735);
}

// ───────────────────────── 11. 覆雪面：碰撞顶面 = 视觉雪面；山墙盒藏进屋面 ─────────────────────────
console.log('⑪ 覆雪面碰撞高度 = 视觉雪面；山墙分级盒顶角在屋面下 ≥ 3 cm');
{
  const slopeByTag = (tg, pred) => {
    const out = [];
    layout.slopes.forEach((s, i) => {
      if (s.tag !== tg) return;
      const surf = world.surfaces[layout.curves.length + layout.grounds.length + layout.boxes.length + i];
      if (!pred(surf)) return;
      out.push(surf);
    });
    return out;
  };
  let worstSnow = 0;
  const bad = [];
  const checkPlane = (label, top, zFrom, zTo, surfOf) => {
    for (let z = zFrom; z >= zTo; z -= 1) {
      const surf = surfOf(z);
      if (!surf) continue;
      const d = Math.abs(surf.topY(z) - lineY(top, z));
      if (d > worstSnow) worstSnow = d;
      if (d > 0.05) bad.push(`${label} z ${z}: 碰撞 ${surf.topY(z).toFixed(2)} vs 视觉 ${lineY(top, z).toFixed(2)}`);
    }
  };
  // 洋房屋顶：视觉雪板顶面线（House.ts addRoof 的 slab 数学，同一份 ROOF_SNOW）
  const rs = ROOF_SNOW;
  const rx0 = HOUSE.x0 - HOUSE.overhang;
  const rx1 = HOUSE.x1 + HOUSE.overhang;
  for (const side of [1, -1]) {
    const zEave = side > 0 ? HOUSE.z1 + HOUSE.overhang : HOUSE.z0 - HOUSE.overhang;
    const zRoll = zEave + side * rs.eaveInset;
    const yRoll = houseRoofY(zEave) + rs.eaveRollRise;
    const top = slabLift(zRoll, houseRoofY(zEave) - rs.refDrop, HOUSE.zRidge, HOUSE.yRidge + rs.ridgeRise, rs.offset + rs.thick);
    const slabs = slopeByTag('roof-snow', (sf) => sf.z0 <= zRoll && zRoll <= sf.z1 + 20 && sf.x0 <= rx0);
    // 雪板段：从雪卷和雪板的等高交点（檐口那 15 cm 归雪卷管）到屋脊坡脚，每 1 cm 对一次
    checkPlane('屋顶雪板', top, zRoll - side * 20, HOUSE.zRidge + side * rs.ridgeFoot, (z) => slabs.find((sf) => sf.z0 <= z && z <= sf.z1));
    // 檐口雪卷：轴 (yRoll, zRoll)、半径 rs.eaveRollR——顶部探针必须落在圆杆上
    const roll = layout.curves.map((c, i) => [c, world.surfaces[i]]).find(([c, s]) => c.tag === 'roof-snow' && s !== null && !(s instanceof SlopeSurface) && Math.abs(c.points[0][2] - zRoll) < 0.01);
    if (!roll) bad.push(`z ${zRoll} 找不到檐口雪卷圆杆`);
    else {
      const cp = roll[1].closest(0, yRoll + rs.eaveRollR, zRoll, contact);
      const dd = Math.abs(contact.dist);
      if (dd > worstSnow) worstSnow = dd;
      if (contact.dist > 0.05 || contact.ny < 0.9) bad.push(`檐口雪卷 z ${zRoll}: 顶面探针离圆杆 ${contact.dist.toFixed(2)} cm`);
      if (Math.abs(roll[1].radius - rs.eaveRollR) > 1e-6) bad.push(`檐口雪卷半径 ${roll[1].radius} ≠ ${rs.eaveRollR}`);
    }
    // 屋脊坡顶点 = 屋脊雪卷顶
    const crest = HOUSE.yRidge + rs.ridgeRollY + rs.ridgeRollR;
    const atRidge = world.closest(0, crest + 0.02, HOUSE.zRidge, contact);
    if (!(contact.surface instanceof SlopeSurface) || Math.abs(contact.dist) > 0.1) bad.push(`屋脊 (z ${HOUSE.zRidge}) 顶面探针离坡顶 ${contact.dist.toFixed(2)}`);
    else if (Math.abs(crest - (HOUSE.yRidge + 24 + 14)) > 1e-6) bad.push('屋脊雪卷顶 ≠ 视觉 918');
  }
  // 雨棚 / 门廊：雪板顶面线 + 檐口雪卷
  for (const [sn, a, tg, rollLen] of [
    [AWNING_SNOW, AWNING, 'awning', 4],
    [PORCH_SNOW, PORCH, 'porch', 3],
  ]) {
    const top = slabLift(a.zOut - sn.rollInset, a.yOut, a.zWall, a.yWall, sn.offset + sn.thick);
    const yRoll = a.yOut + a.thick + sn.rollDrop;
    const zRoll = a.zOut - sn.rollInset;
    const slabs = slopeByTag(`${tg}-snow`, (sf) => sf.ny >= 0.4);
    checkPlane(`${tg} 雪板`, top, zRoll - 15, top.zB, (z) => slabs.find((sf) => sf.z0 <= z && z <= sf.z1));
    const roll = layout.curves.map((c, i) => [c, world.surfaces[i]]).find(([c, s]) => c.tag === `${tg}-snow` && s !== null && !(s instanceof SlopeSurface));
    if (!roll) bad.push(`${tg} 找不到檐口雪卷`);
    else {
      roll[1].closest((a.x0 + a.x1) / 2, yRoll + sn.rollR, zRoll, contact);
      if (Math.abs(contact.dist) > 0.05 || Math.abs(roll[1].radius - sn.rollR) > 1e-6) bad.push(`${tg} 檐口雪卷：探针离圆杆 ${contact.dist.toFixed(2)}，半径 ${roll[1].radius}`);
      const p0 = roll[0].points[0];
      const p1 = roll[0].points[1];
      if (Math.abs(p0[0] - (a.x0 - rollLen)) > 1e-6 || Math.abs(p1[0] - (a.x1 + rollLen)) > 1e-6) bad.push(`${tg} 檐口雪卷 x 范围 ${p0[0]}..${p1[0]} ≠ 视觉 ${a.x0 - rollLen}..${a.x1 + rollLen}`);
    }
  }
  // 平顶雪面：碰撞盒顶 = House.ts / Yard.ts / Conservatory.ts 里雪盒的顶
  const topOf = (pred) => {
    const b = layout.boxes.find(pred);
    return b ? b.max[1] : NaN;
  };
  const flat = [
    ['烟囱帽雪', topOf((b) => b.tag === 'chimney' && b.max[1] > 1000), CHIMNEY.y1 + CHIMNEY.capT + 8],
    ['阳台台面积雪', topOf((b) => b.tag === 'balcony-snow'), BALCONY.yFloor + 4],
    ['露台台面积雪', topOf((b) => b.tag === 'terrace-snow'), TERRACE.yFloor + 4],
    ['空调外机积雪', topOf((b) => b.tag === 'ac'), AC_UNIT.y1 + 5],
    ['院门顶积雪', topOf((b) => b.tag === 'gate-snow'), FENCE.yTop - 14],
    ['电线杆顶雪帽', topOf((b) => b.tag === 'pole' && b.max[2] - b.min[2] < 20 && b.max[2] - b.min[2] > 10), POLE.y1 + 6],
    ['长椅雪座', topOf((b) => b.tag === 'bench-snow'), BENCH.seatY + 4.5],
    ['花箱积雪', topOf((b) => b.tag === 'flowerbox'), 216],
    ['灯笼雪锥尖', Math.max(...layout.boxes.filter((b) => b.tag === 'lantern-snow').map((b) => b.max[1])), 161.5],
  ];
  for (const [label, got, want] of flat) if (Math.abs(got - want) > 1e-6) bad.push(`${label}：碰撞顶 ${got} ≠ 视觉 ${want}`);
  // 雪卷圆杆的半径 / 轴高 = 视觉（Yard.ts / House.ts 的 cyl 参数）
  const rollCheck = (tg, r, ys) => {
    layout.curves.forEach((c, i) => {
      if (c.tag !== tg) return;
      const s = world.surfaces[i];
      if (Math.abs(s.radius - r) > 1e-6) bad.push(`${tg} 半径 ${s.radius} ≠ ${r}`);
      if (!ys.some((y) => Math.abs(c.points[0][1] - y) < 1e-6)) bad.push(`${tg} 轴高 ${c.points[0][1]} 不在视觉值里`);
    });
  };
  rollCheck('fence-snow', 5, [FENCE.rails[0] + FENCE.railH + 2.5]);
  rollCheck('pole-snow', 4.5, POLE.arms.map((y) => y + 6));
  rollCheck('bench-snow', 5.5, [BENCH.backTop + 2.5]);
  // 扶手雪卷三种规格：阳台前沿 r 6 / 阳台两侧 r 5.5（轴 railTop + 3）/ 露台前沿 r 4（轴 railTop + 2）
  layout.curves.forEach((c, i) => {
    if (c.tag !== 'rail-snow') return;
    const s = world.surfaces[i];
    const y = c.points[0][1];
    const want = Math.abs(y - (BALCONY.railTop + 3)) < 1e-6 ? (c.points[0][2] < -452 && c.points[0][2] > -456 ? 6 : 5.5) : Math.abs(y - (TERRACE.railTop + 2)) < 1e-6 ? 4 : null;
    if (want === null || Math.abs(s.radius - want) > 1e-6) bad.push(`rail-snow 轴高 ${y} 半径 ${s.radius} ≠ 视觉`);
  });
  rollCheck('gh-snow', 7, [GH.yRidge + 4]);

  // 山墙：洋房 12 级盒每个顶角在屋面 houseRoofY 之下 ≥ 3 cm；GH / 植物园山墙斜板顶面 = 屋面 − 3
  let gableBoxes = 0;
  let gableMin = Infinity;
  layout.boxes.forEach((b) => {
    if (b.tag !== 'gable') return;
    gableBoxes++;
    for (const z of [b.min[2], b.max[2]]) gableMin = Math.min(gableMin, houseRoofY(z) - b.max[1]);
  });
  if (gableBoxes !== 22) bad.push(`洋房山墙盒 ${gableBoxes} 个 ≠ 22`);
  let gSlabMin = Infinity;
  let gSlabs = 0;
  layout.slopes.forEach((s, i) => {
    if (s.tag !== 'gh-gable' && s.tag !== 'cv-gable') return;
    gSlabs++;
    const surf = world.surfaces[layout.curves.length + layout.grounds.length + layout.boxes.length + i];
    for (let k = 0; k <= 10; k++) {
      const at = s.axis === 'z' ? s.z0 + ((s.z1 - s.z0) * k) / 10 : s.x0 + ((s.x1 - s.x0) * k) / 10;
      const roof = s.axis === 'z' ? ghRoofY(at) : consRoofY(at);
      gSlabMin = Math.min(gSlabMin, roof - surf.topY(at));
    }
  });
  if (gSlabs !== 28) bad.push(`GH / 植物园山墙斜板 ${gSlabs} 块 ≠ 28`);
  if (worstSnow > 0.05 || bad.length || gableMin < 3 - 1e-6 || gSlabMin < 3 - 1e-6) {
    fail(`覆雪面 / 山墙：最大偏差 ${worstSnow.toFixed(3)} cm，山墙盒顶角离屋面最小 ${gableMin.toFixed(2)} cm，山墙斜板离屋面最小 ${gSlabMin.toFixed(2)} cm；${bad.slice(0, 4).join('；')}`);
  } else {
    ok(`屋顶 / 雨棚 / 门廊雪板顶面线、6 类雪卷半径与轴高、${flat.length} 处平顶雪面全部 = 视觉雪面（最大偏差 ${worstSnow.toExponential(1)} cm）`);
    ok(`山墙：洋房 ${gableBoxes} 级盒顶角离屋面最小 ${gableMin.toFixed(2)} cm，GH / 植物园 ${gSlabs} 块山墙斜板顶面离屋面最小 ${gSlabMin.toFixed(2)} cm（都 ≥ 3 cm）`);
  }
}

console.log(`  落脚点合计：${spots.reduce((a, s) => a + s.total, 0)} 个采样，${spots.reduce((a, s) => a + s.clean, 0)} 个干净`);
console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项不达标`);
process.exit(failures === 0 ? 0 : 1);
