// 蹦跳序列定格截图：关掉动画循环，手动按固定 dt 步进 tick，在蓄力 / 蹬伸 / 腾空 / 触地 / 缓冲各相位定格拍照。
// 用法：CHROME_PATH=... node tools/hopseq.mjs   （需要先 npm run dev；页面 URL 参数 play=1）
// 输出 shots/hopseq/<机位>_<相位>.png，并打印每帧根的位置 / 相位 / 下沉量，核对动作连续。
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const base = process.env.URL ?? 'http://localhost:5173/city.html';
const OUT = process.env.OUT ?? 'shots/hopseq';
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
await page.goto(`${base}?ui=0&hud=0&rig=${process.env.RIG ?? "0"}`, { waitUntil: "load" });
await page.waitForFunction(() => window.__roam !== undefined, null, { timeout: 120000 });
mkdirSync(OUT, { recursive: true });

const DT = 1 / 60;
/** 机位：名字@距离:方位角:仰角:目标高度 */
const views = (process.env.VIEWS ?? 'side@7:0:0.1:2.6,tq@8:-0.62:0.16:2.6').split(',').map((v) => {
  const [name, rest] = v.split('@');
  const [dist, az, el, ty] = rest.split(':').map(Number);
  return { name, dist, az, el, ty };
});
/** 定格点：名字 + 条件（相位内的进度）。 */
const SNOW = process.env.SCRIPT === 'snow';
const shots = SNOW ? [['snowstand', (p) => p.phase === 'stand' && p.hops >= 1 && p.ground === true]] : [
  ['crouch', (p) => p.phase === 'crouch' && p.t > 0.05],
  ['push', (p) => p.phase === 'push' && p.t > 0.025],
  ['air30', (p) => p.phase === 'air' && p.airK > 0.3],
  ['air60', (p) => p.phase === 'air' && p.airK > 0.6],
  ['air90', (p) => p.phase === 'air' && p.airK > 0.9],
  ['settle', (p) => p.phase === 'settle' && p.t > 0.05],
  ['stand', (p) => p.phase === 'stand' && p.hops >= 1],
];

await page.evaluate((DT) => {
  const app = window.__roam;
  app.renderer.setAnimationLoop(null);
  window.__now = performance.now();
  window.__step = () => {
    window.__now += DT * 1000;
    app.tick(window.__now);
    const p = app.player.loco;
    return { phase: p.phase, t: p.t, airK: p.airK, hops: p.hops, crouch: p.crouch, x: p.pos.x, y: p.pos.y, z: p.pos.z, ground: app.player.perchKind === 'ground' };
  };
}, DT);

for (const view of views) {
  await page.evaluate(({ view, SNOW }) => {
    const app = window.__roam;
    app.controls.target.set(0, view.ty, 0);
    const c = Math.cos(view.el);
    app.camera.position.set(view.dist * c * Math.sin(view.az), view.ty + view.dist * Math.sin(view.el), view.dist * c * Math.cos(view.az));
    app.controls.update();
    app.followInit = false;
    app.player.reset();
    app.player.keys.clear();
    for (let i = 0; i < 6; i++) window.__step();
    // 相机在 +z 侧看（side）：屏幕右 = +x → 按 D 往枝梢跳；空格按着
    if (SNOW) {
      // 往枝梢（+x）跳到掉下去：相机在 +z 侧时 D = +x
      app.player.keys.add('KeyD');
    } else {
      app.player.keys.add('KeyD');
    }
    app.player.keys.add('Space');
  }, { view, SNOW });
  const todo = shots.map(([name, when]) => ({ name, when, done: false }));
  for (let i = 0; i < 240 && todo.some((s) => !s.done); i++) {
    const st = await page.evaluate(() => window.__step());
    for (const s of todo) {
      if (s.done || !s.when(st)) continue;
      s.done = true;
      await page.screenshot({ path: `${OUT}/${view.name}_${s.name}.png` });
      console.log(`${view.name}/${s.name}: ${st.phase} t=${st.t.toFixed(3)} airK=${st.airK.toFixed(2)} root=(${st.x.toFixed(2)}, ${st.y.toFixed(2)}, ${st.z.toFixed(2)}) crouch=${st.crouch.toFixed(2)}`);
    }
    if (!SNOW && st.phase === 'stand' && st.hops >= 1) break;
  }
  const end = await page.evaluate(() => {
    const p = window.__roam.player.loco;
    window.__roam.player.keys.clear();
    return `${p.phase} @ (${p.pos.x.toFixed(2)}, ${p.pos.y.toFixed(2)}, ${p.pos.z.toFixed(2)})，共 ${p.hops} 跳`;
  });
  console.log(`${view.name}: 末态 ${end}`);
}
console.log(errors.length ? errors.join('\n') : 'no page errors');
await browser.close();
