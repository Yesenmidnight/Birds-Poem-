// 背景音乐接入的无头实测（2026-11-23）：garden.html 里两首 lo-fi 姊妹曲（观鸟 watch / 小院 yard）——
//   ① 两个 mp3 都能取到（200 / audio/mpeg / 体积 < 3.5 MB）；
//   ② 页面加载后、没有任何手势时：不建 AudioContext（控制台没有 "AudioContext was not allowed to start"）、不出声；
//   ③ 真实鼠标点一下画布 → 解锁、起当前该放的那首（观鸟态 = watch），淡入后总线电平 > 0；
//   ④ enterRoam() → 切到 yard（交叉淡化、电平不掉到 0）；enterBirdwatch() → 切回 watch；
//   ⑤ 面板"背景音乐"开关 → 静音（总线 → 0、电平归零）→ 取消静音恢复；音量滑块 → 总线跟着走；刷新后记住音量 / 静音；
//   ⑥ 循环点：loopEnd 落在尾部静音里（离文件末尾 0.5~3 s）；
//   ⑦ ?music=0：整个不建，一个音频请求都不发；
//   ⑧ 控制台零报错。
// 用法：CHROME_PATH="C:/Program Files/Google/Chrome/Application/chrome.exe" node tools/music_check.mjs（需要先 npm run dev）
import { chromium } from 'playwright-core';

const base = process.env.URL ?? 'http://localhost:5173/garden.html';
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? chromium.executablePath(),
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
// 不放开自动播放策略：Playwright 的鼠标点击是真实输入（isTrusted），正好像用户一样解锁；要是 unlock 逻辑写错（手势前就建 AudioContext），
// Chrome 会照常报 "AudioContext was not allowed to start"，② 才有意义

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name} — ${detail}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ① 文件
for (const f of ['watch', 'yard']) {
  const res = await fetch(new URL(`/audio/${f}.mp3`, base));
  const buf = await res.arrayBuffer();
  check(`mp3 ${f} 可取`, res.ok && /audio\/mpeg/.test(res.headers.get('content-type') ?? '') && buf.byteLength > 1e6 && buf.byteLength < 3.5e6, `${res.status} ${res.headers.get('content-type')} ${(buf.byteLength / 1e6).toFixed(2)} MB`);
}

// ② ~ ⑥ 主流程
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const logs = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text().slice(0, 200)}`); });
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message.slice(0, 200)}`));
  await page.goto(`${base}?ui=1&`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__birds !== undefined, null, { timeout: 180000 });
  await page.evaluate(() => localStorage.removeItem('birds.music'));
  await page.waitForFunction(() => window.__birds.music.state().loaded.includes('watch'), null, { timeout: 60000 });
  const s0 = await page.evaluate(() => window.__birds.music.state());
  check('加载后没有手势：不建 AudioContext、不出声', !s0.unlocked && s0.current === null && s0.desired === 'watch' && s0.loaded.includes('watch'), `unlocked ${s0.unlocked}，desired ${s0.desired}，已解码 ${s0.loaded.join(',')}`);
  const ctxWarn = logs.filter((l) => /AudioContext|autoplay/i.test(l));
  check('加载后控制台没有 AudioContext 自动播放警告', ctxWarn.length === 0, ctxWarn.length ? ctxWarn.join(' | ') : '0 条');
  const level0 = await page.evaluate(() => window.__birds.music.level());
  check('加载后总线电平 0', level0 === 0, `level ${level0}`);

  // ③ 真实点击画布（trusted pointerdown）
  await page.mouse.click(640, 420);
  await page.waitForFunction(() => window.__birds.music.state().unlocked, null, { timeout: 10000 });
  await sleep(3500); // 淡入 2.5 s 之后
  const s1 = await page.evaluate(() => ({ ...window.__birds.music.state(), level: window.__birds.music.level() }));
  check('真实点击后解锁并起观鸟那首', s1.unlocked && s1.current === 'watch' && s1.master > 0.7, `running ${s1.running}，current ${s1.current}，总线 ${s1.master.toFixed(3)}`);
  let lvl = 0;
  for (let i = 0; i < 10; i++) { lvl = Math.max(lvl, await page.evaluate(() => window.__birds.music.level())); await sleep(200); }
  check('淡入后总线真的在出声（电平 > 0.01）', lvl > 0.01, `2 s 内峰值电平 ${lvl.toFixed(4)}`);

  // ④ 切曲
  await page.waitForFunction(() => window.__birds.music.state().loaded.includes('yard'), null, { timeout: 60000 });
  await page.evaluate(() => window.__birds.enterRoam());
  await page.waitForFunction(() => window.__birds.music.state().current === 'yard', null, { timeout: 10000 });
  let minDuring = 1, maxAfter = 0;
  for (let i = 0; i < 20; i++) { const v = await page.evaluate(() => window.__birds.music.level()); if (i < 8) minDuring = Math.min(minDuring, v); else maxAfter = Math.max(maxAfter, v); await sleep(200); }
  const s2 = await page.evaluate(() => window.__birds.music.state());
  check('enterRoam → 切到小院那首', s2.current === 'yard' && s2.desired === 'yard', `current ${s2.current}`);
  check('交叉淡化中电平没有掉到 0', minDuring > 0.001 && maxAfter > 0.01, `切换头 1.6 s 最低 ${minDuring.toFixed(4)}，之后峰值 ${maxAfter.toFixed(4)}`);
  await page.evaluate(() => window.__birds.enterBirdwatch());
  await page.waitForFunction(() => window.__birds.music.state().current === 'watch', null, { timeout: 10000 });
  const trackText = await page.evaluate(() => [...document.querySelectorAll('.panel .stat')].map((e) => e.textContent).find((t) => /曲目/.test(t ?? '')));
  check('enterBirdwatch → 切回观鸟那首，面板"曲目"行同步', /观鸟/.test(trackText ?? ''), trackText ?? '(没找到行)');

  // ⑤ 静音 / 音量 / 记忆
  const toggleRow = async () => page.evaluate(() => {
    const row = [...document.querySelectorAll('.panel .row')].find((r) => /背景音乐/.test(r.querySelector('.row__label')?.textContent ?? ''));
    const input = row?.querySelector('input[type=checkbox]');
    if (input) input.click();
    return !!input;
  });
  await toggleRow();
  await sleep(500);
  let mutedLevel = 0;
  for (let i = 0; i < 6; i++) { mutedLevel = Math.max(mutedLevel, await page.evaluate(() => window.__birds.music.level())); await sleep(100); }
  const s3 = await page.evaluate(() => window.__birds.music.state());
  check('面板"背景音乐"关 → 静音', s3.muted && Math.abs(s3.master) < 1e-6 && mutedLevel < 1e-4, `muted ${s3.muted}，总线 ${s3.master.toExponential(1)}，电平 ${mutedLevel.toExponential(1)}`);
  await toggleRow();
  await sleep(500);
  const s4 = await page.evaluate(() => window.__birds.music.state());
  check('再开 → 恢复', !s4.muted && Math.abs(s4.master - s4.volume) < 1e-6, `总线 ${s4.master.toFixed(3)} = 音量 ${s4.volume.toFixed(3)}`);
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('.panel .row')].find((r) => /^音量$/.test(r.querySelector('.row__label')?.textContent ?? ''));
    const input = row?.querySelector('input[type=range]');
    if (input) { input.value = '40'; input.dispatchEvent(new Event('input', { bubbles: true })); }
  });
  await sleep(400);
  const s5 = await page.evaluate(() => window.__birds.music.state());
  check('音量滑块 40% → 总线 0.4', Math.abs(s5.volume - 0.4) < 1e-6 && Math.abs(s5.master - 0.4) < 1e-6, `音量 ${s5.volume.toFixed(3)}，总线 ${s5.master.toFixed(3)}`);

  // ⑥ 循环点（从解码后的 buffer 算）
  const loop = await page.evaluate(() => {
    const st = window.__birds.music.state();
    return st.loopEnd;
  });
  check('循环点落在尾部静音里', Object.keys(loop).length === 2 && Object.values(loop).every((v) => v > 180 && v < 189), Object.entries(loop).map(([k, v]) => `${k} loopEnd ${v.toFixed(2)} s`).join('，'));

  // 记忆：刷新后音量 / 静音状态还在
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.__birds !== undefined, null, { timeout: 180000 });
  const s6 = await page.evaluate(() => window.__birds.music.state());
  check('刷新后记住音量 40%', Math.abs(s6.volume - 0.4) < 1e-6 && !s6.muted, `音量 ${s6.volume.toFixed(3)}，muted ${s6.muted}`);
  await page.evaluate(() => localStorage.removeItem('birds.music'));

  const errors = logs.filter((l) => /^\[error\]|\[pageerror\]/.test(l) && !/X4000|f_surface/.test(l));
  check('控制台零报错', errors.length === 0, `${logs.length} 条日志（含既有 X4000 着色器警告），${errors.length} 条错误`);
  await page.close();
}

// ⑦ ?music=0
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const audioReqs = [];
  page.on('request', (r) => { if (/\/audio\//.test(r.url())) audioReqs.push(r.url()); });
  await page.goto(`${base}?ui=1&music=0&`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__birds !== undefined, null, { timeout: 180000 });
  await page.mouse.click(640, 420);
  await sleep(1500);
  const s = await page.evaluate(() => window.__birds.music.state());
  check('?music=0：整个不建、一个音频请求都不发', !s.enabled && !s.unlocked && audioReqs.length === 0, `enabled ${s.enabled}，音频请求 ${audioReqs.length}`);
  await page.close();
}

await browser.close();
const bad = results.filter((r) => !r.ok).length;
console.log(bad ? `\n${bad} 项失败` : `\n全部通过（${results.length} 项）`);
process.exit(bad ? 1 : 0);
