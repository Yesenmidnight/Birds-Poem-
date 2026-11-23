// 冬日庭院的帧耗与预算基准：无头 Chromium 打开 garden.html，对每个视角停掉动画循环后显式连渲 N 帧再读回一个像素同步 GPU。
// 回报单帧真实耗时、Draw Call（含阴影通道）、三角面数，并对照预算：calls ≤ 65；triangles ≤ 850000
// （第一版小院 45 万面；大植物园升级后仅春草 4.5 万根就 9 万面 + 叶 / 花 / 野花 16 万面，预算相应上调，帧耗仍以 ≤ 8 ms 为准）。
// 用法：node tools/courtyard_bench.mjs [视角,逗号分隔] [帧数]
// 环境变量：URL（默认 http://localhost:5173/garden.html）、CHROME_PATH、WIDTH / HEIGHT（默认 1400×900）
import { chromium } from 'playwright-core';

const [, , views = 'overview,consv,consvIn,consvIn2,consvMacro,consvTree,consvVent,consvDoor,fruits,west,yardtop,threequarter', frameArg = '40'] = process.argv;
const frames = Number(frameArg);
const base = process.env.URL ?? 'http://localhost:5173/garden.html';
// 2026-11-23 视觉品质重构后：簇生草 7.2 万叶 + 海棠花云（1.7 万细节花 + 3.9 千花团卡）+ 6.2 万叶，三角面 201 万；CPU 帧耗仍 ~1.3 ms
// 同日三条管线合流后：+ 小鸟（微距 96 壳层 440 万面，远景 LOD 16 层）+ 观鸟管线那棵老海棠全套（~25 次绘制），绘制 91~94 次；
// 预算随之放到 100 次 / 700 万面（微距），帧耗仍是 8 ms（实测微距 6.7 ms、1 m 外 1.2 ms、全景 0.9 ms）
const BUDGET = { calls: 100, triangles: 7000000, ms: 8 };

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? chromium.executablePath(),
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: Number(process.env.WIDTH ?? 1400), height: Number(process.env.HEIGHT ?? 900) }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text().slice(0, 200)}`);
});
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

await page.goto(`${base}?ui=0&`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__birds !== undefined, null, { timeout: 120000 });
await page.waitForTimeout(1500);

const gpu = await page.evaluate(() => {
  const gl = document.querySelector('canvas')?.getContext('webgl2');
  if (!gl) return 'no webgl2';
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
});

// 各批次的三角形数（按网格统计，便于看谁最费）
const meshes = await page.evaluate(() => {
  const a = window.__birds;
  const out = [];
  a.scene.traverse((o) => {
    const g = o.geometry;
    if (!g || !o.isMesh) return;
    const tris = (g.index ? g.index.count : g.attributes.position.count) / 3;
    out.push({ name: o.name || o.parent?.name || '?', tris: Math.round(tris * (g.isInstancedBufferGeometry ? g.instanceCount : 1)), inst: g.isInstancedBufferGeometry ? g.instanceCount : 1 });
  });
  return out.sort((x, y) => y.tris - x.tris);
});

const results = [];
for (const view of views.split(',')) {
  await page.evaluate((v) => window.__birds.setView(v), view);
  await page.waitForTimeout(1500);
  const r = await page.evaluate(
    ({ n }) =>
      new Promise((resolve) => {
        const a = window.__birds;
        const { renderer, scene, camera } = a;
        // 合流后一帧走应用自己的渲染路径（观鸟微距 = 散景两趟：背景离屏 + 散景全屏 + 前景直绘；展示机位 / 漫游态 = 单趟直绘）
        const draw = () => a.bokeh.render(scene, camera, a.bokehMix);
        const gl = renderer.getContext();
        const probe = new Uint8Array(4);
        const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, probe);
        renderer.setAnimationLoop(null);
        requestAnimationFrame(() => {
          for (let i = 0; i < 6; i++) draw();
          sync();
          const t0 = performance.now();
          for (let i = 0; i < n; i++) draw();
          sync();
          const ms = (performance.now() - t0) / n;
          // 绘制统计按单帧读（应用把 info.autoReset 关了、两趟累加，自己 reset）
          renderer.info.reset();
          draw();
          const info = renderer.info.render;
          const out = { ms, calls: info.calls, triangles: info.triangles, bokeh: +a.bokehMix.toFixed(2) };
          renderer.setAnimationLoop(a.tick);
          resolve(out);
        });
      }),
    { n: frames },
  );
  results.push({ view, ...r, fps: +(1000 / r.ms).toFixed(0) });
}

const worstCalls = Math.max(...results.map((r) => r.calls));
const worstTris = Math.max(...results.map((r) => r.triangles));
const worstMs = Math.max(...results.map((r) => r.ms));
console.log(
  JSON.stringify(
    {
      gpu,
      viewport: `${process.env.WIDTH ?? 1400}x${process.env.HEIGHT ?? 900}`,
      results,
      budget: {
        calls: `${worstCalls} / ${BUDGET.calls} ${worstCalls <= BUDGET.calls ? '✓' : '✗'}`,
        triangles: `${worstTris.toLocaleString('en-US')} / ${BUDGET.triangles.toLocaleString('en-US')} ${worstTris <= BUDGET.triangles ? '✓' : '✗'}`,
        frameMs: `${worstMs.toFixed(2)} / ${BUDGET.ms} ${worstMs <= BUDGET.ms ? '✓' : '✗'}`,
      },
      meshes: meshes.slice(0, 14),
      totalMeshes: meshes.length,
      logs: [...new Set(logs.filter((l) => !l.includes('favicon')))].slice(0, 6),
    },
    null,
    2,
  ),
);
await browser.close();
