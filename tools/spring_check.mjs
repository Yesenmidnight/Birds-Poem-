// 冬日庭院弹性微交互的无头实测（2026-11-23 合流返工）：garden.html?play=1 里逐项验证——
//   ① 跨院电线：excite 后厘米级下沉 + 阻尼振动、DynamicWires 顶点 = offsetAt、鸟站在线上脚和线零脱节；
//   ② 老海棠细枝 / 春树花枝：落上去激发 → 梢端下沉回弹、活跃枝槽位写入、网格带 aLimb、脚零脱节、震落雪粉；
//   ③ 主角枝：操控态蓄力预压 / 顺枝跳回落回枝上 / 雪粉；④ 斜屋顶站立、观鸟 ↔ 漫游散景过渡、控制台无报错。
// 用法：CHROME_PATH="C:/Program Files/Google/Chrome/Application/chrome.exe" node tools/spring_check.mjs（需要先 npm run dev；截图进 shots/spring-verify/）
// 环境变量：URL（默认 http://localhost:5173/garden.html）
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '..', 'shots', 'spring-verify');
import { mkdirSync } from 'node:fs';
mkdirSync(out, { recursive: true });

const base = process.env.URL ?? 'http://localhost:5173/garden.html';
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? chromium.executablePath(),
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text().slice(0, 300)}`);
});
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(`${base}?ui=0&play=1&`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__birds !== undefined, null, { timeout: 180000 });
await page.waitForTimeout(2500);

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name} — ${detail}`);
};

// ───────── ① 电线 ─────────
const wire = await page.evaluate(async () => {
  const app = window.__birds;
  const world = app.stage.world;
  const wires = world.surfaces.filter((s) => app.tagOf(s) === 'wire');
  const w = wires[0];
  const before = w.offset;
  // 把鸟放到电线中点正上方 2 cm，再用开关操控让它落上去（setEnabled(true) = place + onLanded）
  const f = w.frameAt(w.length * 0.5, { cx: 0, cy: 0, cz: 0, tx: 0, ty: 0, tz: 0, ux: 0, uy: 0, uz: 0, sx: 0, sy: 0, sz: 0, radius: 0 });
  app.ctrl.setEnabled(false);
  app.bird.group.position.set(f.cx, f.cy + 2, f.cz);
  app.ctrl.setEnabled(true);
  const loco = app.ctrl.player.loco;
  const onWire = loco.surface === w;
  const u = loco.u;
  // 落地那一帧已经 excite 过（Player.onFlightLanded 不走这里；setEnabled 走 place → 没有 excite）——再蹬一下线
  w.excite(u / w.length, 260, 1);
  const mesh = app.wires.group.children.find((c) => c.name === 'dyn:wire');
  const attr = mesh.geometry.attributes.position;
  const rows = w.segments + 1;
  const cols = 9;
  const base = app.wires; // base 坐标在 DynamicWires 的私有字段里；用"两端行（s=0 / s=L 位移恒 0）"做基准：中点行相对端点行
  const yAt = (i) => attr.getY(i * cols + 2);
  const endY = yAt(0);
  const midRest = yAt(Math.floor(rows / 2)) - endY; // 静止时中点相对起点的 y（垂度）
  const samples = [];
  const surfY = (uu) => {
    const fr = w.frameAt(uu, { cx: 0, cy: 0, cz: 0, tx: 0, ty: 0, tz: 0, ux: 0, uy: 0, uz: 0, sx: 0, sy: 0, sz: 0, radius: 0 });
    return fr.cy + fr.radius;
  };
  const root0 = app.bird.group.position.y;
  const surf0 = surfY(loco.u);
  let maxAbs = 0;
  let meshErr = 0;
  let footErr = 0;
  let signs = 0;
  let prev = 0;
  for (let i = 0; i < 150; i++) {
    await new Promise((r) => requestAnimationFrame(() => r()));
    const off = w.offset;
    maxAbs = Math.max(maxAbs, Math.abs(off));
    if (Math.sign(off) !== Math.sign(prev) && prev !== 0) signs++;
    prev = off;
    // 画面：中点行相对起点行的 y 减去静止垂度 = 这一刻的位移；应等于 offsetAt(中点)
    const mid = Math.floor(rows / 2);
    const drawn = yAt(mid) - endY - midRest;
    meshErr = Math.max(meshErr, Math.abs(drawn - w.offsetAt((mid / (rows - 1)) * w.length)));
    // 脚：鸟根相对线面的高度恒定（都跟着线走）
    footErr = Math.max(footErr, Math.abs(app.bird.group.position.y - surfY(loco.u) - (root0 - surf0)));
  }
  const after = w.offset;
  return { before, maxAbs, signs, after, onWire, meshErr, footErr, wires: wires.length, dyn: app.wires.group.children.length, locoU: u };
});
check('电线：落上去激发后厘米级下沉 + 阻尼振动', wire.onWire && wire.maxAbs > 0.8 && wire.signs >= 2, `落在线上 ${wire.onWire}，|offset| 最大 ${wire.maxAbs.toFixed(2)} cm，过零 ${wire.signs} 次，1.5 s 后 ${wire.after.toFixed(3)}`);
check('电线：动态网格顶点 = offsetAt（画面和物理同一个位移）', wire.meshErr < 1e-4, `中点行顶点位移和 offsetAt 最大差 ${wire.meshErr.toExponential(1)} cm；动态网格 ${wire.dyn} 块（电线管 + 雪条 + 拉杆 ×N）`);
check('电线：鸟脚和线零脱节', wire.footErr < 0.01, `150 帧里鸟根相对线面的高度漂移最大 ${wire.footErr.toExponential(1)} cm`);

// 截图：电线特写（鸟在线上，线在沉）
await page.evaluate(() => {
  const app = window.__birds;
  app.ctrl.setEnabled(false);
  const g = app.bird.group.position;
  app.setView(`wire@${g.x - 14};${g.y + 6};${g.z + 22}@${g.x};${g.y - 1};${g.z}@30`);
});
await page.evaluate(() => {
  const app = window.__birds;
  const w = app.stage.world.surfaces.find((s) => app.tagOf(s) === 'wire');
  w.excite(0.5, 260, 1);
});
await page.waitForTimeout(220);
await page.screenshot({ path: path.join(out, '1-wire-sink.png') });
await page.waitForTimeout(1500);
await page.screenshot({ path: path.join(out, '1-wire-rest.png') });

// ───────── ② 老海棠细枝 ─────────
const twig = await page.evaluate(async () => {
  const app = window.__birds;
  const world = app.stage.world;
  // 挑一根焊在二级枝上的冠梢，离地高、朝上的面干净
  const twigs = world.dynamicSurfaces.filter((s) => s.cantilever && s.parentPerch !== null && app.tagOf(s)?.startsWith('tree:'));
  let tw = null;
  let fr = null;
  for (const s of twigs) {
    for (const t of [0.5, 0.4, 0.6]) {
      const f = s.frameAt(s.length * t, { cx: 0, cy: 0, cz: 0, tx: 0, ty: 0, tz: 0, ux: 0, uy: 0, uz: 0, sx: 0, sy: 0, sz: 0, radius: 0 });
      if (f.uy > 0.9 && f.cy > 100) {
        tw = s;
        fr = f;
        break;
      }
    }
    if (tw) break;
  }
  if (!tw) return { none: true };
  app.ctrl.setEnabled(false);
  app.bird.group.position.set(fr.cx, fr.cy + 0.5, fr.cz);
  app.ctrl.setEnabled(true);
  const loco = app.ctrl.player.loco;
  const onTwig = loco.surface === tw;
  const idx = Number(app.tagOf(tw).slice(5));
  tw.excite(loco.u / tw.length, 90, 1);
  let maxAbs = 0;
  let slotOk = false;
  let slotVal = 0;
  let footErr = 0;
  let liftErr = 0;
  const rootLift0 = app.bird.group.position.y - loco.pos.y;
  const barkAttrs = [];
  app.tree.courtyardTreeGroup.traverse((o) => {
    if (o.isMesh && o.geometry.attributes.aBark) barkAttrs.push({ aLimb: !!o.geometry.attributes.aLimb, aLimbP: !!o.geometry.attributes.aLimbP });
  });
  await new Promise((r) => setTimeout(r, 60));
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyS' }));
  await new Promise((r) => setTimeout(r, 300));
  window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyS' }));
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => requestAnimationFrame(() => r()));
    maxAbs = Math.max(maxAbs, Math.abs(tw.ownOffset));
    const slots = app.tree.branches.limbUniforms.uActiveLimbs.value;
    const hit = slots.find((v) => Math.abs(v.x - (idx + 1)) < 0.5);
    if (hit) {
      slotOk = true;
      slotVal = hit.y;
    }
    if (loco.phase !== 'air' && loco.surface === tw) {
      const cc = { surface: null, px: 0, py: 0, pz: 0, nx: 0, ny: 1, nz: 0, dist: 0, svel: 0, u: 0, v: 0, face: -1 };
      app.stage.world.closest(loco.pos.x, loco.pos.y, loco.pos.z, cc);
      // 步态的根贴着位移后的枝面（脚钉在根上），鸟根 = 根 + 落地时的高度差
      footErr = Math.max(footErr, Math.abs(cc.dist));
      liftErr = Math.max(liftErr, Math.abs(app.bird.group.position.y - loco.pos.y - rootLift0));
    }
  }
  // 雪粉：aBirth.w ≥ 现在的时间 − 3 s 的粒子数
  const births = app.puff.mesh.geometry.attributes.aBirth.array;
  const now = app.puff.uniforms.uTime.value;
  let puffs = 0;
  for (let i = 0; i < births.length; i += 4) if (births[i + 3] > now - 3) puffs++;
  return { none: false, onTwig, idx, maxAbs, slotOk, slotVal, footErr, liftErr, puffs, barkAttrs, pos: [fr.cx, fr.cy, fr.cz], sag: tw.eq };
});
if (twig.none) check('老海棠细枝：找不到可落的冠梢', false, '');
else {
  check('老海棠细枝：落上去激发 → 梢端厘米级下沉回弹', twig.onTwig && twig.maxAbs > 0.25, `落在 tree:${twig.idx} ${twig.onTwig}，|ownOffset| 最大 ${twig.maxAbs.toFixed(2)} cm`);
  check('老海棠细枝：活跃枝槽位写入（枝号 + 1，梢端位移）', twig.slotOk, `槽位 ${twig.slotOk ? '命中，位移 ' + twig.slotVal.toFixed(3) : '没命中'}`);
  check('老海棠细枝：树皮网格带 aLimb / aLimbP', twig.barkAttrs.length > 0 && twig.barkAttrs.every((a) => a.aLimb && a.aLimbP), `${JSON.stringify(twig.barkAttrs)}`);
  check('老海棠细枝：鸟脚和枝零脱节', twig.footErr < 1e-6 && twig.liftErr < 0.03, `120 帧里步态根离（位移后的）枝面最大 ${twig.footErr.toExponential(1)} cm；鸟根相对根的高度差在重新落地时变化 ${twig.liftErr.toExponential(1)} cm（落地按画面栖面重绑，雪帽厚度差）`);
  check('老海棠细枝：落地震落雪粉', twig.puffs > 0, `最近 3 s 内出生的雪粉粒子 ${twig.puffs} 粒`);
  await page.evaluate((p) => {
    const app = window.__birds;
    app.ctrl.setEnabled(false);
    app.setView(`twig@${p[0] - 10};${p[1] + 7};${p[2] + 18}@${p[0]};${p[1]};${p[2]}@32`);
  }, twig.pos);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(out, '2-twig-rest.png') });
  await page.evaluate(() => {
    const app = window.__birds;
    const w = app.ctrl.player.loco.surface;
    w.excite(0.6, 120, 1);
  });
  await page.waitForTimeout(120);
  await page.screenshot({ path: path.join(out, '2-twig-dip.png') });
}

// ───────── ③ 春树花枝 ─────────
const spring = await page.evaluate(async () => {
  const app = window.__birds;
  const world = app.stage.world;
  const twigs = world.dynamicSurfaces.filter((s) => s.cantilever && app.tagOf(s) === 'spring-tree-twig');
  let tw = null;
  let fr = null;
  for (const s of twigs) {
    const f = s.frameAt(s.length * 0.5, { cx: 0, cy: 0, cz: 0, tx: 0, ty: 0, tz: 0, ux: 0, uy: 0, uz: 0, sx: 0, sy: 0, sz: 0, radius: 0 });
    if (f.uy > 0.9) {
      tw = s;
      fr = f;
      break;
    }
  }
  if (!tw) return { none: true };
  app.ctrl.setEnabled(false);
  app.bird.group.position.set(fr.cx, fr.cy + 0.5, fr.cz);
  app.ctrl.setEnabled(true);
  const loco = app.ctrl.player.loco;
  const onTwig = loco.surface === tw;
  const limbIdx = app.tree.springLimbs.indexOf(app.stage.perches.limbOf(tw));
  tw.excite(loco.u / tw.length, 90, 1);
  let slotOk = false;
  let maxAbs = 0;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => requestAnimationFrame(() => r()));
    maxAbs = Math.max(maxAbs, Math.abs(tw.ownOffset));
    const slots = app.tree.springBranches.limbUniforms.uActiveLimbs.value;
    if (slots.some((v) => Math.abs(v.x - (limbIdx + 1)) < 0.5)) slotOk = true;
  }
  let leafLimb = false;
  app.foliage.group.traverse((o) => {
    if (o.isMesh && o.geometry.attributes.aLimb && o.geometry.attributes.aLimb.count > 1000) leafLimb = true;
  });
  return { none: false, onTwig, limbIdx, slotOk, maxAbs, leafLimb, pos: [fr.cx, fr.cy, fr.cz] };
});
if (spring.none) check('春树花枝：找不到可落的细枝', false, '');
else {
  check('春树花枝：落上去 → 枝下沉 + 春树槽位写入 + 叶花实例带 aLimb', spring.onTwig && spring.slotOk && spring.leafLimb && spring.maxAbs > 0.3, `落在枝 ${spring.limbIdx} ${spring.onTwig}，槽位 ${spring.slotOk}，|位移| 最大 ${spring.maxAbs.toFixed(2)} cm，叶花实例属性 ${spring.leafLimb}`);
  await page.evaluate((p) => {
    const app = window.__birds;
    app.ctrl.setEnabled(false);
    app.setView(`spring@${p[0] - 12};${p[1] + 8};${p[2] + 22}@${p[0]};${p[1]};${p[2]}@34`);
  }, spring.pos);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(out, '3-spring-twig.png') });
}

// ───────── ④ 主角枝：操控态蓄力 / 起跳 / 落地 ─────────
const hero = await page.evaluate(async () => {
  const app = window.__birds;
  app.ctrl.setEnabled(true);
  app.resetToPerch();
  await new Promise((r) => requestAnimationFrame(() => r()));
  const sw = app.tree.branches.sway;
  const births0 = Array.from(app.puff.mesh.geometry.attributes.aBirth.array);
  const t0 = app.puff.uniforms.uTime.value;
  return { births0, t0, swayLoaded: sw.loaded };
});
await page.keyboard.down('KeyS');
// 蓄力相位只有 0.09 s（≈ 5 帧）：逐帧采样 250 ms 取 preload 峰值（单次定时采样会被一帧抖动带到 push 相位，2026-11-23 抖过一次）
const crouch = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const app = window.__birds;
      const out = { maxPreload: 0, phaseAtMax: '', phases: new Set() };
      const t0 = performance.now();
      const step = () => {
        const pre = app.tree.branches.sway.preload;
        if (pre > out.maxPreload) {
          out.maxPreload = pre;
          out.phaseAtMax = app.ctrl.player.loco.phase;
        }
        out.phases.add(app.ctrl.player.loco.phase);
        if (performance.now() - t0 < 250) requestAnimationFrame(step);
        else resolve({ ...out, phases: [...out.phases] });
      };
      requestAnimationFrame(step);
    }),
);
await page.waitForTimeout(90);
await page.keyboard.up('KeyS');
await page.waitForTimeout(900);
const heroAfter = await page.evaluate((h) => {
  const app = window.__birds;
  const births = app.puff.mesh.geometry.attributes.aBirth.array;
  const now = app.puff.uniforms.uTime.value;
  let puffs = 0;
  for (let i = 0; i < births.length; i += 4) if (births[i + 3] > h.t0 && births[i + 3] <= now) puffs++;
  return { preloadNow: app.tree.branches.sway.preload, loaded: app.tree.branches.sway.loaded, puffs, phase: app.ctrl.player.loco.phase, onBranch: app.tagOf(app.ctrl.player.loco.surface) === 'branch' };
}, hero);
check('主角枝：蓄力按蹲伏量预压、起跳后放开、顺枝跳回落回枝上', crouch.maxPreload > 0 && (crouch.phases.includes('crouch') || crouch.phases.includes('push')) && heroAfter.preloadNow === 0 && heroAfter.loaded, `蓄力时 preload 峰值 ${crouch.maxPreload.toFixed(3)}（峰值出现在相位 ${crouch.phaseAtMax}，经历过 ${crouch.phases.join('/')}），落定后 preload ${heroAfter.preloadNow}、体重 ${heroAfter.loaded}、在主角枝上 ${heroAfter.onBranch}`);
check('主角枝：起跳 / 落地震落雪粉', heroAfter.puffs > 0, `这次跳跃期间出生的雪粉 ${heroAfter.puffs} 粒`);

// ───────── ⑤ 原有功能：斜屋顶站立 / 雪印 / 散景切换 ─────────
const roof = await page.evaluate(async () => {
  const app = window.__birds;
  // 洋房南坡：找 roof 斜板上一点
  const world = app.stage.world;
  const roofs = world.surfaces.filter((s) => app.tagOf(s) === 'roof-snow');
  const r = roofs[0];
  const mid = { x: (r.min.x + r.max.x) / 2, z: (r.min.z + r.max.z) / 2 };
  // 屋面上有一层层台阶状的雪盒（屋面碰撞抬高）：沿坡找一个脚下 3 cm 处干净（体外、法线朝上）的点
  const c = { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } };
  const probe = { surface: null, px: 0, py: 0, pz: 0, nx: 0, ny: 1, nz: 0, dist: 0, svel: 0, u: 0, v: 0, face: -1 };
  let found = false;
  for (let k = 1; k < 12 && !found; k++) {
    r.pointAt(mid.x, r.min.z + ((r.max.z - r.min.z) * k) / 12, 3.0, c);
    world.closest(c.x, c.y, c.z, probe);
    if (probe.surface !== null && probe.dist > 0 && probe.ny > 0.6) found = true;
  }
  app.ctrl.setEnabled(false);
  app.bird.group.position.set(c.x, c.y, c.z);
  app.ctrl.setEnabled(true);
  await new Promise((res) => requestAnimationFrame(() => res()));
  const loco = app.ctrl.player.loco;
  const onRoof = (app.tagOf(loco.surface) === 'roof' || app.tagOf(loco.surface) === 'roof-snow') && loco.up.y < 0.99;
  let probeNy = 0;
  const tag = app.tagOf(loco.surface);
  const foundTag = found ? app.tagOf(probe.surface) : null; probeNy = probe.ny;
  const upY = loco.up.y;
  // 连跳两下看会不会陷下去
  const y0 = loco.pos.y;
  const footY = [];
  for (let i = 0; i < 40; i++) {
    await new Promise((res) => requestAnimationFrame(() => res()));
  }
  const gaps = [];
  for (let i = 0; i < 30; i++) {
    await new Promise((res) => requestAnimationFrame(() => res()));
    const cc = { surface: null, dist: Infinity };
    world.closest(loco.pos.x, loco.pos.y, loco.pos.z, cc);
    gaps.push(Math.abs(cc.dist));
  }
  // 雪印：stamp 一下看槽位有没有写进去
  const printsBefore = app.prints.uniforms ? app.prints.uniforms.uSnowPrints.value.filter((v) => v.w > 0).length : -1;
  return { onRoof, tag, upY, gapMax: Math.max(...gaps), printsBefore, pos: [loco.pos.x, loco.pos.y, loco.pos.z], rmin: r.min, rmax: r.max, contactTag: foundTag, probeNy };
});
check('斜屋顶站立：落在屋面雪层斜板上、脚贴坡不陷（探测 ' + roof.contactTag + ' 法线 y ' + roof.probeNy.toFixed(2) + ' → 落在 ' + roof.tag + '）', roof.onRoof && roof.upY < 0.99 && roof.upY > 0.4 && roof.gapMax < 1e-6, `在 roof ${roof.onRoof}，法线 y ${roof.upY.toFixed(3)}，30 帧根离面最大 ${roof.gapMax.toExponential(1)} cm，雪印槽位 ${roof.printsBefore}`);
await page.evaluate((p) => {
  const app = window.__birds;
  app.ctrl.setEnabled(false);
  app.setView(`roof@${p[0] - 30};${p[1] + 25};${p[2] + 60}@${p[0]};${p[1]};${p[2]}@34`);
}, roof.pos);
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(out, '4-roof-stand.png') });

// 散景：回到观鸟态 → bokehMix 过渡到 1；再进漫游 → 0
await page.evaluate(() => window.__birds.enterBirdwatch());
await page.waitForFunction(() => window.__birds.bokehT >= 1, null, { timeout: 20000 });
const bw = await page.evaluate(() => ({ mix: window.__birds.bokehMix, mode: window.__birds.mode, amount: window.__birds.bokehAmount, view: window.__birds.view }));
await page.screenshot({ path: path.join(out, '5-watch-bokeh.png') });
await page.evaluate(() => window.__birds.enterRoam());
await page.waitForFunction(() => window.__birds.bokehT >= 1, null, { timeout: 20000 });
const rm = await page.evaluate(() => ({ mix: window.__birds.bokehMix, mode: window.__birds.mode }));
check('观鸟 ↔ 漫游：散景 1 ↔ 0 过渡完好', bw.mix > 0.95 && rm.mix < 0.05 && bw.mode === 'watch' && rm.mode === 'roam', `观鸟 mix ${bw.mix.toFixed(2)}，漫游 mix ${rm.mix.toFixed(2)}`);
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(out, '6-roam-chase.png') });

const errs = logs.filter((l) => !/Download the React DevTools|\[GPU\]|WebGL: INVALID|GroupMarkerNotSet|X4000/.test(l));
check('控制台无报错 / 着色器编译失败', errs.length === 0, errs.slice(0, 5).join(' | ') || `${logs.length} 条日志，0 条错误`);

const failed = results.filter((r) => !r.ok).length;
console.log(failed === 0 ? `\n全部通过（${results.length} 项）` : `\n${failed} 项不达标`);
await browser.close();
process.exit(failed === 0 ? 0 : 1);
