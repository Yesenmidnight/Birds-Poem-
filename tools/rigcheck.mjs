// 仿真调试台的浏览器内自检：画面层和碰撞层是不是同一份几何。
// 用法：CHROME_PATH=... node tools/rigcheck.mjs   （需要先 npm run dev）
// 检查三件事，任何一项不达标进程以非零码退出：
//   1. 观鸟主枝的树皮网格顶点到碰撞体的 |距离| / 当地半径 ≤ 15%（碰撞体是光滑圆柱，树皮的鼓包 6% + 细噪 4.5% + 枝节微膨环 7% + 木疤都在这之外；2026-11-23 实测 13.1%）
//   2. 雪面网格的顶点数 = 碰撞体高度场的节点数（画面就是那张高度场）
//   3. 电线 / 细枝管子的顶点都落在对应碰撞面上（偏差 < 1e-3 cm）
// 顺带撒一把小球跑 3 秒：全部落定、电线上方的 12 颗都留在电线上、静止表面最大压入 ≤ 半个球半径
// 然后再开观鸟入口 index.html（有海棠果枝装饰的那一页）检查母子枝焊合契约：
//   4. 每根子枝 / 果台的起点到母枝中心曲线的距离 = 0、r0 < 母枝半径、树皮第一圈整圈埋在母枝木质里（离轴 < 0.9 × 母枝半径）
//   5. 每根果梗的根与果台尖：aSway 逐位相同，大振幅摇晃状态（主枝两阶模态 + 嫩梢弯曲 + 果柄单摆同时非零）下的间距变化 = 0；
//      果梗根部的单摆权重 = 0；果梗曲线 y 单调下垂；impulse(1) 后单摆先被激起再衰减
import { chromium } from 'playwright-core';

const base = process.env.URL ?? 'http://localhost:5173/city.html';
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? chromium.executablePath(),
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(`[error] ${m.text()}`);
});
await page.goto(`${base}?ui=0&hud=0`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__roam !== undefined, null, { timeout: 120000 });

const r = await page.evaluate(async () => {
  const app = window.__roam;
  const rig = app.rig;
  const out = {};
  out.branch = rig.checkBranchMesh(app.branches.mainBark);

  // 树的枝条：栖面查询 Branches.limbPerch(limb, u) 必须就是网格上的面（偏差 ≤ 1e-4 cm：网格位置是 float32，300 cm 处 1 ULP = 3e-5）——
  // 树皮网格每列顶点的半径 = ringRadius(…)，雪帽网格每列 = snowSurface(…)，按环向角换算到 (up, side) 标架后逐一比对
  const Vec3 = app.camera.position.constructor;
  let limbWorst = 0;
  let limbSamples = 0;
  const tmpN = new Vec3();
  const tmpS = new Vec3();
  for (const [perch, limb] of rig.treeLimbs()) {
    const frames = limb.frames;
    const radial = limb.bark.attributes.aBark ? (limb.bark.attributes.position.count / frames.length - 1) : 0;
    const bpos = limb.bark.attributes.position.array;
    const cols = radial + 1;
    for (const i of [1, Math.floor(frames.length / 3), Math.floor(frames.length * 2 / 3), frames.length - 2]) {
      const f = frames[i];
      // 枝条截面的 (up, side) 标架和网格的 (n, b) 标架之间的夹角
      tmpN.set(0, 1, 0).addScaledVector(f.t, -f.t.y).normalize();
      tmpS.crossVectors(f.t, tmpN).normalize();
      const phi = Math.atan2(tmpN.dot(f.b), tmpN.dot(f.n));
      const perchAt = app.branches.limbPerch(limb, f.along);
      for (let j = 0; j < radial; j += Math.max(1, Math.floor(radial / 6))) {
        const th = (j / radial) * Math.PI * 2;
        const k = (i * cols + j) * 3;
        const meshR = Math.hypot(bpos[k] - f.c.x, bpos[k + 1] - f.c.y, bpos[k + 2] - f.c.z);
        const q = perchAt.surfaceRadius(th - phi, 0);
        // 查询取 max(树皮, 雪)：有雪的列查询值 ≥ 树皮顶点的半径（差的就是雪厚）；没雪的列必须相等
        if (q - meshR > 1e-6) continue;
        limbWorst = Math.max(limbWorst, Math.abs(q - meshR));
        limbSamples++;
      }
    }
  }
  out.limbs = { worst: limbWorst, samples: limbSamples, count: rig.treeLimbs().length };

  const field = rig.world.surfaces.find((s) => s.kind === 1);
  let groundVerts = -1;
  let tubeDev = 0;
  const c = { surface: null, px: 0, py: 0, pz: 0, nx: 0, ny: 1, nz: 0, dist: 0, svel: 0, u: 0, v: 0, face: -1 };
  for (const o of rig.group.children) {
    if (!o.geometry || o.isInstancedMesh) continue;
    const pos = o.geometry.attributes.position;
    if (pos.count === (field.nx + 1) * (field.nz + 1)) {
      groundVerts = pos.count;
      continue;
    }
    if (!o.name.startsWith('tube:')) continue;
    // 管子：每个顶点到最近的曲线碰撞面
    let worst = 0;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      let best = Infinity;
      for (const s of rig.world.surfaces) {
        if (s.kind !== 0) continue;
        s.closest(x, y, z, c);
        if (Math.abs(c.dist) < Math.abs(best)) best = c.dist;
      }
      if (Math.abs(best) > worst) worst = Math.abs(best);
    }
    tubeDev = Math.max(tubeDev, worst);
  }
  out.groundVerts = groundVerts;
  out.expectVerts = (field.nx + 1) * (field.nz + 1);
  out.tubeDev = tubeDev;
  out.surfaces = rig.world.surfaces.length;

  // ── 动态腿架：静止态 = 原静态腿（偏差 ≤ 1e-6 cm：位置是 float32，1 cm 处 1 ULP = 6e-8）；蹲下只动跗跖；抬脚只动那一只脚的趾；恢复后回到原样 ──
  const { LegRig, gripping } = await import('/src/bird/legs.ts');
  // three 的类从页面对象上拿（浏览器里不能 import 裸模块名）
  const Matrix4 = app.bird.group.matrix.constructor;
  const Vector3 = app.bird.group.position.constructor;
  const perch = app.branches.perchAt(0);
  const inv = app.bird.group.matrix.clone().invert();
  const legRig = new LegRig(perch, inv);
  const lp = legRig.geometry.getAttribute('position');
  const ref = lp.array.slice();
  // 顶点布局从腿架自己报的起始顶点号推（跗跖环数 / 趾环数改了也不用改这里）
  const perTarsus = legRig.legs[0].toeStart[0] - legRig.legs[0].tarsusStart;
  const perFoot = legRig.legs[1].tarsusStart - legRig.legs[0].tarsusStart;
  const feet = [gripping(), gripping()];
  const isTarsus = (i) => (i % perFoot) < perTarsus;
  const dev = (pred) => {
    let m = 0;
    for (let i = 0; i < lp.count; i++) {
      if (pred && !pred(i)) continue;
      m = Math.max(m, Math.abs(lp.array[i * 3] - ref[i * 3]), Math.abs(lp.array[i * 3 + 1] - ref[i * 3 + 1]), Math.abs(lp.array[i * 3 + 2] - ref[i * 3 + 2]));
    }
    return m;
  };
  const finite = () => {
    for (let i = 0; i < lp.array.length; i++) if (!Number.isFinite(lp.array[i])) return false;
    return true;
  };
  legRig.update(new Matrix4().makeTranslation(0, -0.1, 0), feet);
  const crouch = { tarsus: dev(isTarsus), toes: dev((i) => !isTarsus(i)) };
  legRig.update(new Matrix4(), feet);
  const restDev = dev();
  const target = legRig.gripCenter.clone().add(new Vector3(0.05, 0.35, 0));
  legRig.update(new Matrix4(), [{ grip: 0, ankle: target }, gripping()]);
  const lift = { rightToes: dev((i) => !isTarsus(i) && i < perFoot), leftToes: dev((i) => i >= perFoot && !isTarsus(i)), finite: finite() };
  legRig.update(new Matrix4(), feet);
  const restored = dev();
  out.legs = { crouch, restDev, lift, restored, live: finite.call(null) && app.bird.legs.geometry.getAttribute('position').array.every(Number.isFinite) };

  // 操控层（Player.bindPerch：栖面标架转进鸟群局部、脚位沿枝的真实切线、原点高度按两踝平均高度反推）落在主角枝上的脚
  // = 静态腿几何在同一个鸟群姿态下的样子：只比脚趾（跗跖跟着呼吸的躯干矩阵动）。上限 2e-2 cm 是因为静态腿的脚位公式
  // (worldX - center.x) / tangent.x 只在原点处和弧长严格相等，落在别处差一个 center.x（≤ 0.01 cm）
  const liveArr = app.bird.legs.geometry.getAttribute('position').array;
  const refRig = new LegRig(app.branches.perchAt(app.player.loco.pos.x), app.bird.group.matrixWorld.clone().invert());
  const refArr = refRig.geometry.getAttribute('position').array;
  let playerRest = 0;
  for (let i = 0; i < refArr.length; i++) {
    if (isTarsus(Math.floor(i / 3))) continue;
    playerRest = Math.max(playerRest, Math.abs(liveArr[i] - refArr[i]));
  }
  out.playerRest = { worst: playerRest, enabled: app.player.enabled, phase: app.player.loco.phase };

  // 撒球跑 3 秒（真实帧循环），再读状态
  rig.paused = false;
  rig.scatter(60);
  rig.scatterAlong(rig.curve('wire'), 12);
  await new Promise((res) => setTimeout(res, 3000));
  const p = rig.probes;
  let onWire = 0;
  let penetrating = 0;
  let maxGap = 0;
  let maxPen2 = 0;
  const wire = rig.curve('wire');
  for (let i = 0; i < p.count; i++) {
    if (p.state[i] !== 2) continue;
    rig.world.closest(p.px[i], p.py[i], p.pz[i], c);
    if (c.surface === wire) onWire++;
    if (c.dist < p.radius - 1e-3) penetrating++;
    maxPen2 = Math.max(maxPen2, p.radius - c.dist);
    maxGap = Math.max(maxGap, c.dist - p.radius);
  }
  out.probes = { alive: p.alive(), resting: p.resting(), onWire, penetrating, maxPen2, maxGap, maxPen: p.maxPenetration };
  return out;
});

let failures = 0;
const check = (ok, text) => {
  if (!ok) failures++;
  console.log(`${ok ? '通过' : '失败'}  ${text}`);
};
check(r.branch.maxRatio <= 0.15, `主枝树皮网格对碰撞体：|距离| / 半径 最大 ${(r.branch.maxRatio * 100).toFixed(2)}%（上限 15% = 鼓包 6% + 细噪 4.5% + 枝节环 7% 之外再留木疤的量），最差点 (${r.branch.worst.map((v) => v.toFixed(2)).join(', ')})`);
check(r.groundVerts === r.expectVerts, `雪面网格顶点 ${r.groundVerts} = 高度场节点 ${r.expectVerts}`);
check(r.tubeDev < 1e-3, `电线 / 细枝管子顶点到碰撞面最大偏差 ${r.tubeDev.toExponential(2)} cm`);
check(r.limbs.worst < 1e-4 && r.limbs.samples > 200, `${r.limbs.count} 根树枝始终面查询对网格：${r.limbs.samples} 个无雪列顶点半径最大偏差 ${r.limbs.worst.toExponential(1)} cm`);
check(
  r.legs.restDev < 1e-6 &&
    r.legs.crouch.tarsus > 0.01 &&
    r.legs.crouch.toes === 0 &&
    r.legs.lift.rightToes > 0.01 &&
    r.legs.lift.leftToes === 0 &&
    r.legs.lift.finite &&
    r.legs.restored < 1e-6 &&
    r.legs.live,
  `动态腿架：蹲 0.1 cm 后回到静止态与原静态腿顶点最大偏差 ${r.legs.restDev.toExponential(1)} cm；蹲下时跗跖动了 ${r.legs.crouch.tarsus.toFixed(3)} cm、脚趾动了 ${r.legs.crouch.toes} cm；抬右脚张爪：右趾变了 ${r.legs.lift.rightToes.toFixed(2)} cm、左趾变了 ${r.legs.lift.leftToes} cm、数值全有限：${r.legs.lift.finite}；恢复包握后偏差 ${r.legs.restored.toExponential(1)} cm；页面上的鸟腿几何全有限：${r.legs.live}`,
);
check(
  r.playerRest.enabled && r.playerRest.phase === 'stand' && r.playerRest.worst < 2e-2,
  `操控层落在主角枝上的脚位对静态腿几何（同一个鸟群姿态、只比脚趾）：最大偏差 ${r.playerRest.worst.toExponential(1)} cm（操控${r.playerRest.enabled ? '开着' : '关着'}，相位 ${r.playerRest.phase}）`,
);
check(
  r.probes.resting === r.probes.alive && r.probes.maxPen <= 0.35 + 1e-9 && r.probes.penetrating === 0 && r.probes.onWire >= 12,
  `撒球 72 颗（空中 60 + 电线正上方 12）跑 3 s：活 ${r.probes.alive} 落定 ${r.probes.resting}，电线上 ${r.probes.onWire}/12，静止表面最大压入 ${r.probes.maxPen.toFixed(3)} cm，落定后残余穿透最大 ${r.probes.maxPen2.toExponential(1)} cm（超过 1e-3 的 ${r.probes.penetrating} 颗），最大离面间隙 ${r.probes.maxGap.toExponential(1)} cm`,
);
// ── 观鸟入口 index.html：母子枝焊合契约 + 果柄摇晃零脱节 ──
const page2 = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
page2.on('pageerror', (e) => errors.push(`[index pageerror] ${e.message}`));
page2.on('console', (m) => {
  // index.html 没声明 favicon，浏览器自动请求 /favicon.ico 的 404 不算页面错误
  const url = m.location()?.url ?? '';
  if (m.type() === 'error' && !m.text().includes('favicon') && !url.includes('favicon')) errors.push(`[index error] ${m.text()}`);
});
await page2.goto(`${process.env.INDEX_URL ?? 'http://localhost:5173/'}?ui=0`, { waitUntil: 'load' });
await page2.waitForFunction(() => window.__birds !== undefined, null, { timeout: 120000 });
await page2.waitForTimeout(300);
const r2 = await page2.evaluate(() => {
  const b = window.__birds.branches;
  const sway = b.sway;
  const u = sway.uniforms;
  const Vec3 = b.limbs[0].curve.getPointAt(0).constructor;
  const out = { joints: [], berry: {}, pendulum: {}, ringChecked: 0 };
  // 母枝曲线上离点 p 最近的距离（在 s0 附近三分搜索，曲线局部光滑，精度远高于 1e-4）
  const closestDist = (curve, p, s0, span) => {
    let lo = Math.max(0, s0 - span);
    let hi = Math.min(1, s0 + span);
    const q = new Vec3();
    const d = (t) => curve.getPointAt(t, q).distanceTo(p);
    for (let i = 0; i < 60; i++) {
      const m1 = lo + (hi - lo) / 3;
      const m2 = hi - (hi - lo) / 3;
      if (d(m1) < d(m2)) hi = m2;
      else lo = m1;
    }
    return d((lo + hi) / 2);
  };
  // 母枝在弧长比例 s 处的半径：和建枝时同一个 interpKeys（键间按 Perlin fade 插值），不是帧间线性插值——
  // 焊合契约钳的是 0.72 × 这个值，帧间线性插值在键中段能差出 1.5%，比值会假超
  const parentRadiusAt = (parent, s) => {
    const keys = parent.radii;
    const n = keys.length;
    if (n === 1) return keys[0];
    const x = Math.min(Math.max(s, 0), 1) * (n - 1);
    const i = Math.min(Math.floor(x), n - 2);
    const t = x - i;
    const f = t * t * t * (t * (t * 6 - 15) + 10);
    return keys[i] + (keys[i + 1] - keys[i]) * f;
  };
  const pc = new Vec3();
  const audit = (list, limbsOf, out) => {
    for (const j of list) {
      const child = limbsOf(j)[j.child];
      const parent = limbsOf(j)[j.parent];
      const start = child.curve.getPointAt(0);
      const gap = start.distanceTo(parent.curve.getPointAt(j.sAttach, pc));
      const parentR = parentRadiusAt(parent, j.sAttach);
      const r0 = child.frames[0].r;
      // 子枝树皮第一圈：网格每环 cols 个顶点，第一圈 = 前 cols 个顶点
      const pos = child.bark.attributes.position;
      const cols = Math.round(pos.count / child.frames.length);
      let ringMax = NaN;
      if (Math.abs(pos.count / child.frames.length - cols) < 1e-6) {
        const v = new Vec3();
        ringMax = 0;
        for (let i = 0; i < cols; i++) {
          v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
          ringMax = Math.max(ringMax, closestDist(parent.curve, v, j.sAttach, 0.12));
        }
        out.ringChecked++;
      }
      out.joints.push({ child: j.child, parent: j.parent, s: j.sAttach, gap, ratio: r0 / parentR, ringRatio: ringMax / parentR, start: [start.x, start.y, start.z] });
    }
  };
  audit(b.joints, () => b.limbs, out);
  // 海棠大树：addWeldedLimbs 的全部母子枝（不进 b.limbs，焊合记录在 weldedJoints，每条自带那棵树的枝条表）
  out.tree = { joints: [], ringChecked: 0 };
  audit(b.weldedJoints ?? [], (j) => j.tree, out.tree);
  // 果柄摇晃零脱节：静止间距 vs 大振幅摇晃状态（主枝两阶模态 + 嫩梢弯曲 + 果柄单摆同时非零）下的间距
  const save = { m: u.uSwayMain.value.clone(), t: u.uSwayTwig.value.clone(), f: u.uSwayFruit.value.clone() };
  const a = new Vec3();
  const c = new Vec3();
  const p0 = new Vec3();
  const p1 = new Vec3();
  const v = new Vec3();
  let swayMismatch = 0;
  let nonMono = 0;
  let staticGapMax = 0;
  let swayGapMax = 0;
  let rootSwingMax = 0;
  let rootMeshDev = 0;
  let rootMeshVerts = 0;
  u.uSwayMain.value.set(0.4, 0.15, 0.2, 0);
  u.uSwayTwig.value.set(0.3, -0.15, 0, 0);
  u.uSwayFruit.value.set(0.1, 0.08, 0, 0);
  for (const j of b.berryJoints) {
    // 果台尖的 aSway 是从 float32 网格属性读回来的，果梗根的是 float64 原值：比到 1e-6（两者写进网格后逐位相同）
    if (j.spurSway.some((q, i) => Math.abs(q - j.rootSway[i]) > 1e-6)) swayMismatch++;
    const g0 = j.spurTip.distanceTo(j.root);
    staticGapMax = Math.max(staticGapMax, g0);
    sway.displace(j.spurTip, j.spurSway, 0, a);
    sway.displace(j.root, j.rootSway, 0, c);
    swayGapMax = Math.max(swayGapMax, Math.abs(a.distanceTo(c) - g0));
    for (let i = 1; i <= 200; i++) {
      j.curve.getPointAt(i / 200, p1);
      j.curve.getPointAt((i - 1) / 200, p0);
      if (p1.y > p0.y + 1e-6) nonMono++;
    }
  }
  // 页面上果簇网格里的果梗根圈（aPart = 0 且 aT = 0）：单摆权重必须 = 0，摇晃后每个顶点仍贴在果台尖的根上（≤ 果梗半径）
  let berryMesh = null;
  // 合流后主角枝一套在 heroGroup 子组里（散景按图层拆的前景容器）：连子孙一起找
  b.traverse((o) => { if (!berryMesh && o.isMesh && o.geometry.attributes.aSwing && o.geometry.attributes.aPart) berryMesh = o; });
  if (berryMesh) {
    const g = berryMesh.geometry;
    const part = g.attributes.aPart;
    const tt = g.attributes.aT;
    const sw = g.attributes.aSwing;
    const pos = g.attributes.position;
    const sw3 = g.attributes.aSway;
    for (let i = 0; i < part.count; i++) {
      if (part.getX(i) > 0.5 || tt.getX(i) > 1e-6) continue;
      rootMeshVerts++;
      rootSwingMax = Math.max(rootSwingMax, Math.abs(sw.getX(i)));
      const rec = b.berryJoints.find((q) => q.rootSway[0] === sw3.getX(i) && q.rootSway[1] === sw3.getY(i));
      if (!rec) continue;
      v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
      sway.displace(v, [sw3.getX(i), sw3.getY(i), sw3.getZ(i)], sw.getX(i), a);
      sway.displace(rec.root, rec.rootSway, 0, c);
      rootMeshDev = Math.max(rootMeshDev, a.distanceTo(c));
    }
  }
  u.uSwayMain.value.copy(save.m);
  u.uSwayTwig.value.copy(save.t);
  u.uSwayFruit.value.copy(save.f);
  // 单摆：impulse(1) 后先被激起、2.5 秒后衰减到峰值的 1/4 以下
  const amp = () => Math.hypot(u.uSwayFruit.value.x, u.uSwayFruit.value.y);
  sway.update(1 / 60);
  const base = amp();
  sway.impulse(1, 0.7);
  let peak = 0;
  let early = 0;
  let mid = 0;
  for (let i = 0; i < 150; i++) {
    sway.update(1 / 60);
    const q = amp();
    peak = Math.max(peak, q);
    if (i === 20) early = q;
    if (i === 80) mid = q;
  }
  out.pendulum = { base, peak, early, mid, late: amp() };
  out.berry = { count: b.berryJoints.length, swayMismatch, nonMono, staticGapMax, swayGapMax, rootSwingMax, rootMeshDev, rootMeshVerts };
  return out;
});

for (const j of r2.joints) {
  console.log(`  子枝 ${j.child} ← 母枝 ${j.parent} @ s=${j.s.toFixed(4)}：起点 (${j.start.map((q) => q.toFixed(4)).join(', ')}) 到母枝中心曲线距离 = ${j.gap.toExponential(1)} cm，r0 / 母枝半径 = ${j.ratio.toFixed(3)}，第一圈顶点最大离轴 / 母枝半径 = ${j.ringRatio.toFixed(3)}`);
}
check(
  r2.joints.length >= 7 &&
    r2.joints.every((j) => j.gap < 1e-3 && j.ratio < 1 && Number.isFinite(j.ringRatio) && j.ringRatio < 0.9) &&
    r2.ringChecked === r2.joints.length,
  `index.html 母子枝焊合：${r2.joints.length} 根子枝 / 果台起点到母枝中心曲线距离 = 0（最大 ${Math.max(...r2.joints.map((j) => j.gap)).toExponential(1)} cm < 1e-3），r0 全部小于母枝半径（最大比值 ${Math.max(...r2.joints.map((j) => j.ratio)).toFixed(3)}），树皮第一圈整圈埋在母枝木质里（最大离轴 / 母枝半径 ${Math.max(...r2.joints.map((j) => j.ringRatio)).toFixed(3)} < 0.9）`,
);
// 海棠大树：一百多根只打印离上限最近的三根（按第一圈离轴比值排）
const tj = r2.tree?.joints ?? [];
for (const j of [...tj].sort((a, b) => b.ringRatio - a.ringRatio).slice(0, 3)) {
  console.log(`  [树] 子枝 ${j.child} ← 母枝 ${j.parent} @ s=${j.s.toFixed(4)}：起点到母枝中心曲线距离 = ${j.gap.toExponential(1)} cm，r0 / 母枝半径 = ${j.ratio.toFixed(3)}，第一圈顶点最大离轴 / 母枝半径 = ${j.ringRatio.toFixed(3)}`);
}
check(
  tj.length >= 100 &&
    tj.every((j) => j.gap < 1e-3 && j.ratio <= 0.72 + 1e-6 && Number.isFinite(j.ringRatio) && j.ringRatio < 0.9) &&
    r2.tree.ringChecked === tj.length,
  `index.html 海棠大树焊合：${tj.length} 根母子枝起点到母枝中心曲线距离 = 0（最大 ${Math.max(...tj.map((j) => j.gap)).toExponential(1)} cm < 1e-3），r0 全部 ≤ 0.72 × 母枝半径（最大比值 ${Math.max(...tj.map((j) => j.ratio)).toFixed(3)}），树皮第一圈整圈埋在母枝木质里（最大离轴 / 母枝半径 ${Math.max(...tj.map((j) => j.ringRatio)).toFixed(3)} < 0.9）`,
);
check(
  r2.berry.count >= 7 &&
    r2.berry.swayMismatch === 0 &&
    r2.berry.swayGapMax < 1e-6 &&
    r2.berry.rootSwingMax === 0 &&
    r2.berry.rootMeshVerts > 0 &&
    r2.berry.rootMeshDev < 0.012 &&
    r2.berry.nonMono === 0,
  `index.html 果柄摇晃连接：${r2.berry.count} 根果梗根与果台尖 aSway 逐位相同（不一致 ${r2.berry.swayMismatch} 根），静止间距 ${r2.berry.staticGapMax.toFixed(4)} cm，大振幅摇晃状态下的间距变化 = ${r2.berry.swayGapMax.toExponential(1)} cm（< 1e-6，只是 float32 属性舍入，GPU 上两者逐位相同），网格果梗根圈 ${r2.berry.rootMeshVerts} 个顶点单摆权重最大 ${r2.berry.rootSwingMax}、摇晃后离果台尖根最大 ${r2.berry.rootMeshDev.toFixed(4)} cm（≤ 果梗半径 0.012），果梗 y 非单调下垂数 ${r2.berry.nonMono}`,
);
check(
  r2.pendulum.peak > 0.01 && r2.pendulum.late < r2.pendulum.peak * 0.25 && r2.pendulum.mid < r2.pendulum.early + 1e-9,
  `index.html 果柄单摆：impulse(1) 前幅值 ${r2.pendulum.base.toExponential(1)}，激起后峰值 ${r2.pendulum.peak.toFixed(3)} cm，0.35 s ${r2.pendulum.early.toFixed(3)} → 1.35 s ${r2.pendulum.mid.toFixed(3)} → 2.5 s ${r2.pendulum.late.toFixed(4)}（衰减到峰值的 ${(r2.pendulum.late / r2.pendulum.peak * 100).toFixed(1)}%）`,
);
check(errors.length === 0, `页面报错 ${errors.length} 条${errors.length ? `：${errors.slice(0, 3).join(' | ')}` : ''}`);
await browser.close();
if (failures > 0) process.exitCode = 1;
