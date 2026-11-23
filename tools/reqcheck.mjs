// 列出页面加载失败的请求（404 等）。用法：CHROME_PATH=... URL=http://localhost:5173/ node tools/reqcheck.mjs
import { chromium } from 'playwright-core';
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? chromium.executablePath(),
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
page.on('response', (r) => { if (r.status() >= 400) console.log(r.status(), r.url()); });
page.on('requestfailed', (r) => console.log('FAILED', r.url(), r.failure()?.errorText));
await page.goto(process.env.URL ?? 'http://localhost:5173/', { waitUntil: 'load' });
await page.waitForTimeout(3000);
await browser.close();
