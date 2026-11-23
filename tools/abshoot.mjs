// 成对截图：同一个页面里，对每个视角先后套用两段状态（A / B）各截一张，专做“改动前 vs 改动后”的对照。
// 两段状态在同一页面里切换、中间不重载页面；页面要是被热更新重载了（冻结状态、相机会回出厂），这一组自动重拍。
// MEASURE=1 时不存图，换成纯黑背景读回像素，量鸟的剪影面积和平均亮度（看绒毛体积感、明暗有没有变）。
// 用法：node tools/abshoot.mjs <输出目录> <视角,逗号分隔>
// 环境变量：URL（默认 http://localhost:5173/）、EVAL（两边共用的准备状态，比如冻结动作）、
//           EVAL_A / EVAL_B（各自的状态）、WAIT（切视角后等待 ms，默认 1200）、
//           SETTLE（切换状态后等待 ms，默认 700）、MEASURE、CHROME_PATH
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

const [, , outDir = 'shots', views = 'threequarter'] = process.argv;
const base = process.env.URL ?? 'http://localhost:5173/';
const measure = process.env.MEASURE === '1';

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? chromium.executablePath(),
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
// 页面每被（热更新）重载一次 +1：有人同时改源码时会发生，一组 A / B 中途被重载就得重拍
let loads = 0;
page.on('load', () => loads++);

await page.goto(`${base}?ui=0&hud=0&${process.env.EXTRA ?? ''}`, { waitUntil: 'load' });
const ready = () => page.waitForFunction(() => window.__birds !== undefined, null, { timeout: 120000 });
await ready();
loads = 0;

// 两边共用的准备状态：每次开拍前重新套一遍，页面被重载过也能恢复
const prepare = async () => {
  if (process.env.EVAL) await page.evaluate(process.env.EVAL);
  if (!measure) return;
  await page.evaluate(() => {
    const a = window.__birds;
    // 纯黑背景 + 藏掉天空、树枝、虚化层、飘雪：画面里只剩鸟，非黑像素就是剪影
    a.scene.background = a.sky.mesh.material.uniforms.uZenith.value.clone().setRGB(0, 0, 0);
    a.sky.mesh.visible = false;
    a.branches.visible = false;
    a.snowfall.mesh.visible = false;
    // 城市漫游入口每帧按相机距离重设虚化层的可见性，要从它的开关上关
    a.backdropOn = false;
    a.backdrop.mesh.visible = false;
  });
};

// 渲一帧后直接读回画布：剪影面积（亮度 > 10 的像素数）、平均亮度、外接框，以及这一帧的绘制统计
const probe = () =>
  page.evaluate(() => {
    const a = window.__birds;
    a.renderer.render(a.scene, a.camera);
    const gl = a.renderer.getContext();
    const w = a.renderer.domElement.width;
    const h = a.renderer.domElement.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let area = 0;
    let sum = 0;
    let minX = w;
    let maxX = -1;
    let minY = h;
    let maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (Math.max(px[i], px[i + 1], px[i + 2]) <= 10) continue;
        area++;
        sum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    const center = a.camera.position.clone().set(0, 2.5, -0.6);
    a.bird.group.localToWorld(center);
    return {
      shells: a.bird.fur.shellCount,
      calls: a.renderer.info.render.calls,
      triangles: a.renderer.info.render.triangles,
      camDist: a.camera.position.distanceTo(center),
      motionOn: a.motion.enabled,
      area,
      meanLum: area ? sum / area : 0,
      bbox: [minX, minY, maxX, maxY],
    };
  });

const results = [];
for (const view of views.split(',')) {
  let row = null;
  let redone = 0;
  for (let attempt = 0; attempt < 4 && !row; attempt++) {
    if (attempt > 0) {
      redone++;
      // 重载后入口对象要重新建好
      await ready().catch(() => {});
    }
    const start = loads;
    try {
      await prepare();
      await page.evaluate((v) => window.__birds.setView(v), view);
      await page.waitForTimeout(Number(process.env.WAIT ?? 1200));
      const r = { view };
      for (const side of ['A', 'B']) {
        const patch = process.env[`EVAL_${side}`];
        if (patch) await page.evaluate(patch);
        await page.waitForTimeout(Number(process.env.SETTLE ?? 700));
        if (!measure) {
          const dir = resolve(outDir, side);
          mkdirSync(dir, { recursive: true });
          await page.screenshot({ path: resolve(dir, `${view.replace(/[@:]/g, '_')}.png`) });
        }
        r[side] = await probe();
      }
      // 这一组拍到一半被重载了：冻结状态、相机都回出厂，两边不可比，重来
      if (loads === start) row = r;
    } catch {
      // 重载正好撞上注入 / 截图 / 读像素：页面上下文被销毁，同样重来
    }
  }
  if (!row) row = { view, failed: true };
  if (redone) row.redone = redone;
  results.push(row);
}

console.log(
  JSON.stringify({ outDir: measure ? null : resolve(outDir), reloaded: loads > 0, measure, results, logs: [...new Set(logs)].slice(0, 8) }, null, 2),
);
await browser.close();
