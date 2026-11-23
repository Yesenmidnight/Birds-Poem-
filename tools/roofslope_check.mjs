// 斜屋顶上的落脚一致性（浏览器内自检，2026-11-23 实机 Bug 的回归）：鸟落在 20°~50° 的 SlopeSurface 上时
//   1. 鸟群原点 bird.group.position 的 x / z 与步态落点 loco.pos 的水平偏差 < 0.3 cm（原来拷了半径 50 圆柱近似的 center，
//      斜坡上偏出 50·sin(坡角) = 17~38 cm，身体飞到半空、IK 把腿拉成长棍）；
//   2. 两只踝到栖面的距离 = ANKLE_CLEAR 0.03 cm ± 0.2（脚贴着雪面，不悬空不陷进去）；
//   3. 跗跖长（出肉点到踝）和静止栖息态相差 < 2 cm（没有拉伸）；
//   4. 在坡上朝上坡连跳 1.2 s（蓄力 / 腾空 / 落地 / 急刹全程），每一帧的 xz 偏差都 < 0.3 cm、踝始终贴面；
//   5. 落在覆雪面上写出雪印（uSnowPrints 槽位 = 落点），雪材质的顶点 / 片元着色器零编译错误。
// 顺带拍三张图：洋房屋顶雪被上的鸟（3/4 微距）、阳光房玻璃斜顶边缘、屋顶雪印俯视微距。
// 用法：CHROME_PATH="C:/Program Files/Google/Chrome/Application/chrome.exe" node tools/roofslope_check.mjs（需要先 npm run dev）
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const base = process.env.URL ?? 'http://localhost:5173/garden.html';
const outDir = 'shots/roofslope';
mkdirSync(outDir, { recursive: true });
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
await page.waitForFunction(() => window.__birds !== undefined && window.__birds.stage !== undefined, null, { timeout: 120000 });

const result = await page.evaluate(async () => {
  const app = window.__birds;
  const { SlopeSurface } = await import('/src/sim/slopeSurface.ts');
  app.enterRoam(true);
  const player = app.ctrl.player;
  const bird = app.bird;
  const g = bird.group;
  const world = app.stage.world;
  const out = { slopes: [], hop: null, prints: null, baseline: null };
  // 手动步进：接管循环里操控层的更新（相机 / 玩家），鸟本身仍由页面循环更新几何
  app.ctrl.update = () => {};
  const step = (n, dt = 1 / 60) => {
    for (let i = 0; i < n; i++) player.update(dt, null);
  };
  const measure = () => {
    g.updateMatrixWorld(true);
    const r = { dxz: Math.hypot(g.position.x - player.loco.pos.x, g.position.z - player.loco.pos.z), dy: g.position.y - player.loco.pos.y, ankle: [], tarsus: [], phase: player.loco.phase, surface: app.tagOf(player.loco.surface), surfaceId: player.loco.surface?.id, pos: [player.loco.pos.x, player.loco.pos.y, player.loco.pos.z], up: [player.loco.up.x, player.loco.up.y, player.loco.up.z] };
    const V = g.position.constructor;
    for (const leg of bird.legRig.legs) {
      const w = new V().copy(leg.ankle0).applyMatrix4(g.matrixWorld);
      const c = world.closest(w.x, w.y, w.z, { px: 0, py: 0, pz: 0, nx: 0, ny: 0, nz: 0, dist: 0, svel: 0, u: 0, v: 0, face: 0, surface: null });
      r.ankle.push({ dist: c.dist, same: c.surface === player.loco.surface, tag: c.surface ? app.tagOf(c.surface) : null });
      r.tarsus.push(leg.tarsus);
    }
    return r;
  };
  // 落到 (x, y, z)：先回栖点，再把鸟群摆过去、开关操控（setEnabled(true) 走 loco.place + onLanded）
  const land = (x, y, z, hx, hz) => {
    player.setEnabled(false);
    g.position.set(x, y, z);
    g.rotation.set(0, Math.atan2(hx, hz), 0);
    g.updateMatrixWorld(true);
    player.setEnabled(true);
    step(4);
    return measure();
  };
  // 静息基线：主角枝上的跗跖长
  player.setEnabled(false);
  g.updateMatrixWorld(true);
  out.baseline = bird.legRig.legs.map((l) => +l.tarsus.toFixed(3));

  // 某种 tag 的斜板在 (x, z) 处的碰撞顶面高度
  const topAt = (tag, x, z) => {
    for (const s of world.surfaces) {
      if (!(s instanceof SlopeSurface) || app.tagOf(s) !== tag) continue;
      if (s.x0 <= x && x <= s.x1 && s.z0 <= z && z <= s.z1) return s.topY(s.axis === 'z' ? z : x);
    }
    return NaN;
  };
  // 注入一块 50° 的测试斜板（南草坪上空，离地 25 cm 起、朝 +z 上坡）
  const sy0 = -100;
  const sy1 = sy0 + 100 * Math.tan((50 * Math.PI) / 180);
  world.add(new SlopeSurface('test50', 'z', -150, 150, 900, 1000, sy0, sy1, 30));
  const cases = [
    { name: '洋房屋顶雪被（南坡 19.9°，顺坡朝上）', tag: 'roof-snow', x: -200, z: -650, hx: 0, hz: -1 },
    { name: '洋房屋顶雪被（南坡 19.9°，横着坡站）', tag: 'roof-snow', x: -200, z: -700, hx: 1, hz: 0 },
    { name: '洋房屋脊坡（38.5°，朝屋脊）', tag: 'roof-snow', x: -200, z: -860, hx: 0, hz: -1 },
    { name: '阳光房玻璃南坡（28.8°，朝屋脊）', tag: 'gh-roof', x: 100, z: -200, hx: 0, hz: -1 },
    { name: '植物园西坡第一段（35.8°，朝上坡）', tag: 'cv-roof', x: 380, z: 420, hx: 1, hz: 0 },
    // 注入的斜板不在布局 tag 表里，顶面高度直接按三角函数给
    { name: '注入测试斜板（50°，朝上坡）', tag: null, y: sy0 + 50 * Math.tan((50 * Math.PI) / 180), x: 0, z: 950, hx: 0, hz: 1 },
  ];
  for (const c of cases) {
    const y = (c.y ?? topAt(c.tag, c.x, c.z)) + 0.3;
    const m = land(c.x, y, c.z, c.hx, c.hz);
    out.slopes.push({ name: c.name, ...m });
  }
  // 坡上连跳：回到洋房南坡，朝上坡按住 W 1.2 s
  land(-200, topAt('roof-snow', -200, -650) + 0.3, -650, 0, -1);
  player.camDirX = 0;
  player.camDirZ = -1;
  const key = new KeyboardEvent('keydown', { code: 'KeyW' });
  window.dispatchEvent(key);
  let maxDxz = 0;
  let maxAnkleErr = 0;
  let airFrames = 0;
  let skidFrames = 0;
  let hops0 = player.loco.hops;
  const phases = new Set();
  for (let i = 0; i < 72; i++) {
    player.update(1 / 60, null);
    const m = measure();
    phases.add(m.phase);
    if (m.phase === 'air') airFrames++;
    if (m.phase === 'skid') skidFrames++;
    maxDxz = Math.max(maxDxz, m.dxz);
    // 腾空时脚是收起来的（不贴面），只在脚踩在坡上的相位（站 / 蓄力 / 落地 / 急刹）量踝到雪面的距离
    if (m.phase !== 'air') for (const a of m.ankle) if (a.same) maxAnkleErr = Math.max(maxAnkleErr, Math.abs(a.dist - 0.03));
  }
  window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
  step(30);
  out.hop = { maxDxz, maxAnkleErr, airFrames, skidFrames, hops: player.loco.hops - hops0, phases: [...phases], end: measure() };
  // 雪印：屋顶上落地 + 连跳之后应有一串印，最后一个在落点上
  const slots = app.prints.uniform.value.map((v) => [v.x, v.y, v.z, v.w]).filter((v) => v[3] > 0);
  out.prints = { active: app.prints.active(), count: app.prints.count, last: slots[slots.length - 1], loco: [player.loco.pos.x, player.loco.pos.y, player.loco.pos.z] };
  out.printSlots = slots;
  return out;
});

let failures = 0;
const fail = (m) => {
  failures++;
  console.log(`  ✗ ${m}`);
};
const ok = (m) => console.log(`  ✓ ${m}`);
console.log('① 斜面上鸟群原点 / 脚位 / 腿长');
for (const s of result.slopes) {
  const ankleErr = Math.max(...s.ankle.map((a) => Math.abs(a.dist - 0.03)));
  const tarsusD = Math.max(...s.tarsus.map((t, i) => Math.abs(t - result.baseline[i])));
  const same = s.ankle.every((a) => a.same);
  const good = s.dxz < 0.3 && ankleErr < 0.2 && tarsusD < 2 && same;
  const msg = `${s.name}：xz 偏差 ${s.dxz.toFixed(3)} cm，踝离面 ${s.ankle.map((a) => a.dist.toFixed(3)).join(' / ')}（误差 ${ankleErr.toFixed(3)}，${same ? '同一斜面' : `最近的是 ${s.ankle.map((a) => a.tag).join('/')}！`}），跗跖 ${s.tarsus.map((t) => t.toFixed(2)).join(' / ')}（静止 ${result.baseline.join(' / ')}，相差 ${tarsusD.toFixed(2)}），面 ${s.surface}(id ${s.surfaceId})，落点 (${s.pos.map((v) => v.toFixed(2)).join(", ")})，up (${s.up.map((v) => v.toFixed(3)).join(", ")})`;
  if (good) ok(msg);
  else fail(msg);
}
console.log('② 坡上连跳 1.2 s（蓄力 / 腾空 / 落地 / 急刹全程）');
{
  const h = result.hop;
  const msg = `${h.hops} 跳，相位 ${h.phases.join('/')}，腾空 ${h.airFrames} 帧、急刹 ${h.skidFrames} 帧；全程 xz 偏差最大 ${h.maxDxz.toFixed(4)} cm，踝离面误差最大 ${h.maxAnkleErr.toFixed(3)} cm；结束 (${h.end.dxz.toFixed(3)} cm 偏差，${h.end.surface})`;
  if (h.maxDxz < 0.3 && h.maxAnkleErr < 0.2 && h.hops >= 2 && h.airFrames > 0) ok(msg);
  else fail(msg);
}
console.log('③ 雪印');
{
  const p = result.prints;
  const lastErr = p.last ? Math.hypot(p.last[0] - p.loco[0], p.last[1] - p.loco[1], p.last[2] - p.loco[2]) : NaN;
  const msg = `共踩 ${p.count} 个印、现存 ${p.active} 个；最后一个 (${p.last?.map((v) => v.toFixed(2)).join(', ')}) 离落点 (${p.loco.map((v) => v.toFixed(2)).join(', ')}) ${lastErr.toFixed(3)} cm`;
  // 落地后步态还会顺着坡滑定 1~2 cm（落点 = 踩下的那一刻），印心离最终的站位 < 印的半径 3.2 cm
  if (p.count >= 1 && p.active >= 1 && lastErr < 3.2) ok(msg);
  else fail(msg);
}
console.log('④ 着色器 / 页面错误');
if (errors.length === 0) ok('雪材质（顶点下压 + 碗状 bump）等全部程序零编译错误，页面零报错');
else fail(errors.slice(0, 5).join('\n    '));

// 截图：操控层已冻住（ctrl.update 空函数），自定义机位拍鸟在屋顶雪被上 / 雪印俯视微距 / 阳光房斜顶边缘
const shoot = async (name, view) => {
  await page.evaluate((v) => window.__birds.setView(v), view);
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${outDir}/${name}.png` });
};
const f1 = (v) => v.toFixed(1);
const birdPos = await page.evaluate(() => {
  const g = window.__birds.bird.group.position;
  return [g.x, g.y, g.z];
});
await shoot("roof_bird", `roof@${f1(birdPos[0] + 34)};${f1(birdPos[1] + 9)};${f1(birdPos[2] + 22)}@${f1(birdPos[0])};${f1(birdPos[1] - 1.5)};${f1(birdPos[2])}@28`);
// 雪印微距：在鸟旁边 10 cm 处再踩一个印（走同一条 stamp → uniform → 着色器的路），从上方 25 cm 俯视
const printAt = await page.evaluate(async () => {
  const app = window.__birds;
  const { SlopeSurface } = await import('/src/sim/slopeSurface.ts');
  const g = app.bird.group.position;
  const x = g.x - 10;
  const z = g.z + 5;
  let y = NaN;
  for (const s of app.stage.world.surfaces) {
    if (s instanceof SlopeSurface && app.tagOf(s) === 'roof-snow' && s.x0 <= x && x <= s.x1 && s.z0 <= z && z <= s.z1) y = s.topY(z);
  }
  app.prints.stamp(x, y, z);
  app.prints.stamp(x - 9, y + 9 * 0.3626, z - 9);
  return [x, y, z];
});
await shoot('roof_print', `print@${f1(printAt[0] - 4)};${f1(printAt[1] + 22)};${f1(printAt[2] + 16)}@${f1(printAt[0] - 4)};${f1(printAt[1] - 0.5)};${f1(printAt[2] - 4)}@24`);
// 阳光房玻璃斜顶边缘：鸟站在南坡檐口附近朝檐外
await page.evaluate(async () => {
  const app = window.__birds;
  const { SlopeSurface } = await import('/src/sim/slopeSurface.ts');
  const player = app.ctrl.player;
  const g = app.bird.group;
  let y = NaN;
  for (const s of app.stage.world.surfaces) {
    if (s instanceof SlopeSurface && app.tagOf(s) === 'gh-roof' && s.x0 <= 100 && 100 <= s.x1 && s.z0 <= -182 && -182 <= s.z1) y = s.topY(-182);
  }
  player.setEnabled(false);
  g.position.set(100, y + 0.3, -182);
  g.rotation.set(0, 0, 0);
  player.setEnabled(true);
  for (let i = 0; i < 4; i++) player.update(1 / 60, null);
});
await shoot('gh_edge', `gh@150;${f1(148 + 24)};-130@100;${f1(148)};-182@28`);

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项不达标`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
