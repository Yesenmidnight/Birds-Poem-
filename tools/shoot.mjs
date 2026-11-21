// 开发用截图工具：无头 Chromium 打开本地页面，按预设视角截图，并回报渲染器信息与控制台报错。
// 用法：node tools/shoot.mjs <输出目录> <视角,逗号分隔|all> [附加查询串] [宽] [高]
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const [, , outDir = 'shots', views = 'threequarter', extraQuery = '', width = '1400', height = '900'] = process.argv;
const base = process.env.URL ?? 'http://localhost:5173/';

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? chromium.executablePath(),
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});

const page = await browser.newPage({ viewport: { width: Number(width), height: Number(height) }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => {
  const text = m.text();
  if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${text}`);
  else if (m.type() === 'log' || m.type() === 'info') {
    if (text.startsWith('[bird]')) logs.push(`[info] ${text}`);
  }
});
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
page.on('requestfailed', (r) => logs.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText ?? ''}`));

const t0 = Date.now();
await page.goto(`${base}?ui=0&${extraQuery}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__birds !== undefined, null, { timeout: 120000 });
const loadMs = Date.now() - t0;

const gpu = await page.evaluate(() => {
  const gl = document.querySelector('canvas')?.getContext('webgl2');
  if (!gl) return 'no webgl2';
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
});

const list =
  views === 'all' ? ['threequarter', 'side', 'front', 'back', 'head', 'tail', 'wide'] : views.split(',');

// 可选：截图前在页面里执行一段表达式（调试姿态、参数用）
if (process.env.EVAL) await page.evaluate(process.env.EVAL);

const results = [];
for (const view of list) {
  const file = resolve(outDir, `${view}.png`);
  await page.evaluate((v) => window.__birds.setView(v), view);
  // 等若干帧，让阻尼和阴影稳定下来
  await page.waitForTimeout(Number(process.env.WAIT ?? 1200));
  mkdirSync(dirname(file), { recursive: true });
  await page.screenshot({ path: file });
  results.push(file);
}
// 相同的告警只留一条，并记下次数；Vite 热更新引起的请求中止不算问题，除非显式要求全部输出
const kept = process.env.VERBOSE ? logs : logs.filter((l) => !l.includes('ERR_ABORTED') && !l.includes('favicon'));
const dedup = new Map();
for (const line of kept) dedup.set(line, (dedup.get(line) ?? 0) + 1);
const compact = [...dedup.entries()].map(([text, n]) => (n > 1 ? `${text}  ×${n}` : text));
console.log(JSON.stringify({ gpu, loadMs, results, logs: compact.slice(0, 12) }, null, 2));
await browser.close();
