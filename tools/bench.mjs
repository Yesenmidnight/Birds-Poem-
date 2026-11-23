// 开发用帧耗基准：无头 Chromium 打开本地页面，对每个视角测“单帧真实渲染耗时”。
// 做法是停掉动画循环后显式连渲 N 帧再 gl.finish()，量的是 GPU 实际耗时，不受垂直同步 60 fps 限帧影响，
// 所以“本来就锁 60 fps”的场景优化前后差多少也量得出来。
// 用法：node tools/bench.mjs <视角,逗号分隔> [每个视角帧数，默认 60]
// 环境变量：URL（默认 http://localhost:5173/）、EVAL（测量前在页面里注入）、CHROME_PATH、WIDTH / HEIGHT（默认 1400×900）
import { chromium } from 'playwright-core';

const [, , views = 'threequarter', frameArg = '60'] = process.argv;
const frames = Number(frameArg);
const base = process.env.URL ?? 'http://localhost:5173/';

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? chromium.executablePath(),
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});

const page = await browser.newPage({
  viewport: { width: Number(process.env.WIDTH ?? 1400), height: Number(process.env.HEIGHT ?? 900) },
  deviceScaleFactor: 1,
});
const logs = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

await page.goto(`${base}?${process.env.UI ? '' : 'ui=0&'}${process.env.EXTRA ?? ''}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__birds !== undefined, null, { timeout: 120000 });
if (process.env.EVAL) await page.evaluate(process.env.EVAL);

const gpu = await page.evaluate(() => {
  const gl = document.querySelector('canvas')?.getContext('webgl2');
  if (!gl) return 'no webgl2';
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
});

const results = [];
for (const view of views.split(',')) {
  // 等阻尼把相机送到位，阴影也要稳定
  await page.evaluate((v) => window.__birds.setView(v), view);
  await page.waitForTimeout(1500);
  const r = await page.evaluate(
    ({ n, v }) =>
      new Promise((resolve) => {
        const a = window.__birds;
        const { renderer, scene, camera } = a;
        const name = v;
        const gl = renderer.getContext();
        // 强制等 GPU 把之前的命令全部跑完。ANGLE / D3D11 下 gl.finish() 并不阻塞（实测 420 万面“只要”0.07 ms），
        // 读回一个像素才真的会等
        const probe = new Uint8Array(4);
        const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, probe);
        // 停掉动画循环，计时窗口里只剩下面这些显式的渲染
        renderer.setAnimationLoop(null);
        requestAnimationFrame(() => {
          for (let i = 0; i < 8; i++) renderer.render(scene, camera);
          sync();
          const t0 = performance.now();
          for (let i = 0; i < n; i++) renderer.render(scene, camera);
          sync();
          const ms = (performance.now() - t0) / n;
          const info = renderer.info.render;
          const center = camera.position.clone().set(0, 2.5, -0.6);
          a.bird.group.localToWorld(center);
          const out = {
            ms,
            calls: info.calls,
            triangles: info.triangles,
            shells: a.bird.fur.shellCount,
            camDist: camera.position.distanceTo(center),
          };
          // 恢复动画循环（start 会重新挂上 tick）
          a.start(a.view ?? name);
          resolve(out);
        });
      }),
    { n: frames, v: view },
  );
  results.push({ view, ...r, fps: +(1000 / r.ms).toFixed(1) });
}

console.log(
  JSON.stringify(
    {
      gpu,
      viewport: `${process.env.WIDTH ?? 1400}x${process.env.HEIGHT ?? 900}`,
      results,
      logs: [...new Set(logs.filter((l) => !l.includes('favicon')))].slice(0, 8),
    },
    null,
    2,
  ),
);
await browser.close();
