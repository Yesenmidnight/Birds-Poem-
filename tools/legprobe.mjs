// 动态腿爪的数值探针：抬起 / 张开的脚在鸟群局部坐标里到底落在哪、有多少被腹羽挡住。
// 用法：CHROME_PATH=... node tools/legprobe.mjs   （需要先 npm run dev）
// 打印两条腿的髋 / 出肉点 / 静止踝，以及当前演示设置下踝和四根趾尖的局部 + 世界坐标；
// 再从胸前下方拍一张仰视特写 shots/<LEGS_OUT>/{side,top,under}.png
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const base = process.env.URL ?? 'http://localhost:5173/city.html';
// 环境变量：LEGS_OUT 截图目录（默认 shots/legs_probe）、LEGS_LIFT 0/1 是否抬右脚（默认 1）、LEGS_OPEN 脚趾张开 0..1（默认 0.7）
const OUT = process.env.LEGS_OUT ?? 'shots/legs_probe';
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? chromium.executablePath(),
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
await page.goto(`${base}?ui=0&hud=0`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__roam !== undefined, null, { timeout: 120000 });

const DEMO = { lift: process.env.LEGS_LIFT !== '0', open: parseFloat(process.env.LEGS_OPEN ?? '0.7') };
const r = await page.evaluate(async (DEMO) => {
  const app = window.__roam;
  app.motion.enabled = false;
  app.player.setEnabled(false);
  app.legDemo.liftRight = DEMO.lift;
  app.legDemo.open = DEMO.open;
  const rig = app.bird.legRig;
  const f = (v) => `(${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)})`;
  const out = { gripCenter: f(rig.gripCenter), legs: [] };
  // 等两帧让腿架更新
  await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
  const pos = rig.geometry.getAttribute('position');
  const V = rig.gripCenter.constructor;
  const P = (k) => new V(pos.array[k], pos.array[k + 1], pos.array[k + 2]);
  for (const [i, leg] of rig.legs.entries()) {
    const toes = leg.toeStart.map((s) => {
      // 趾尖 = 该趾最后一个环的第一个顶点
      const k = (s + 18 * 8) * 3;
      return f(P(k));
    });
    const tarsus = [];
    for (let ring = 0; ring < 4; ring++) {
      const k = (leg.tarsusStart + ring * 10) * 3;
      tarsus.push(f(P(k)));
    }
    out["perchLocal" + i] = { tangent: f(leg.perchLocal.tangent), side: f(leg.perchLocal.side), up: f(leg.perchLocal.up), along: leg.foot.along, alpha: leg.foot.alpha };
    out.legs.push({
      side: leg.foot.side,
      hip: f(leg.hip),
      exit: f(leg.exit),
      ankle0: f(leg.ankle0),
      tarsus: tarsus,
      toes: toes,
    });
  }
  return out;
}, DEMO);
console.log(JSON.stringify(r, null, 1));

// 三个特写：侧面（喙在画面左）、胸前下方仰视、俯视（喙在画面左）
mkdirSync(OUT, { recursive: true });
const CAMS = { side: [[0, 0.35, 2.6], [0, 0.15, 0]], under: [[-1.4, -0.5, 1.2], [0, 0.4, 0.2]], top: [[0, 2.5, 1.0], [0, 0, 0]] };
for (const [name, [pos, target]] of Object.entries(CAMS)) {
  await page.evaluate(({ pos, target }) => {
    const app = window.__roam;
    app.controls.target.set(target[0], target[1], target[2]);
    app.camera.position.set(pos[0], pos[1], pos[2]);
    app.controls.update();
  }, { pos, target });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: OUT + '/' + name + '.png' });
}
console.log(errors.length ? errors.join('\n') : 'no page errors');
await browser.close();
