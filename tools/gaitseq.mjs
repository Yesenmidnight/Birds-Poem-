// 阶段 3 新步态的定格截图：关掉动画循环，手动按固定 dt 步进 tick，用键盘集合驱动 Player（走真实的相机相对意图），
// 在后退小步 / 原地掉头 / 扑翼助推连跳 / 急刹滑雪 / 斜枝落地 / 相机避障各节点定格拍照。
// 用法：CHROME_PATH=... node tools/gaitseq.mjs [场景,逗号分隔]   （需要先 npm run dev）
// 场景：back turn flick skidside tailfan leap limb limbfeet wire camavoid looksteer groundsteer flight flightland follow fall standfly fpshoulder fpeye autofly chaseground chasefly touchdown look360   输出 shots/gaitseq/<场景>_<节点>.png，并打印每帧根的位置 / 相位 / 动量 / 翅尾
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const base = process.env.URL ?? 'http://localhost:5173/city.html';
const OUT = process.env.OUT ?? 'shots/gaitseq';
const want = new Set((process.argv[2] ?? 'back,turn,flick,skidside,tailfan,leap,limb,limbfeet,wire,camavoid').split(','));
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
await page.goto(`${base}?ui=0&hud=0&rig=${process.env.RIG ?? '0'}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__roam !== undefined, null, { timeout: 120000 });
mkdirSync(OUT, { recursive: true });

const DT = 1 / 60;
await page.evaluate(async (DT) => {
  const app = window.__roam;
  const { makeCurveFrame } = await import('/src/sim/curvePerch.ts');
  const { Vec3 } = await import('/src/sim/math.ts');
  app.renderer.setAnimationLoop(null);
  window.__now = performance.now();
  const st = () => {
    const p = app.player.loco;
    const g = app.bird.group;
    const wr = app.bird.wingPivots.right.rotation;
    return { phase: p.phase, t: p.t, airK: p.airK, skidK: p.skidK, hops: p.hops, kind: p.hopKind, mom: p.momentum, turnSign: p.turnSign, openR: app.bird.wingRigs.right.uniforms.uOpen.value, x: p.pos.x, y: p.pos.y, z: p.pos.z, hx: p.heading.x, hz: p.heading.z, wingFlap: wr.z, tail: app.bird.tailPivot.rotation.x, spread: app.bird.tailSpread.value, perch: app.player.perchKind, camPull: app.camPull, camDist: app.camera.position.distanceTo(g.position), camY: app.camera.position.y, orbit: app.controls.getDistance(), full: app.camFull.length(), tgt: app.controls.target.toArray(), blockKind: app.camContact.surface ? app.camContact.surface.kind : -1, blockDist: app.camContact.dist, blockAt: app.camContact.surface ? [app.camContact.px, app.camContact.py, app.camContact.pz] : null, cam: app.camera.position.toArray(), bird: [app.bird.group.position.x, app.bird.group.position.y, app.bird.group.position.z], flying: app.player.flying, fphase: app.player.flight.phase, fspeed: app.player.flight.speed, fpitch: app.player.flight.bodyPitch, fbank: app.player.flight.bank, fflap: app.player.flight.flapping, ft: app.player.flight.t, flareK: app.player.flight.flareK, legs: app.player.flight.legsExtend, rot: [g.rotation.x, g.rotation.y, g.rotation.z] };
  };
  window.__step = () => {
    window.__now += DT * 1000;
    app.tick(window.__now);
    return st();
  };
  /** 相机摆到鸟后面：az/el/dist 相对鸟群原点上方 ty 处（和 VIEWS 同一套角度约定）。 */
  window.__cam = (az, el, dist, ty) => {
    const g = app.bird.group.position;
    app.controls.target.set(g.x, g.y + ty, g.z);
    const c = Math.cos(el);
    app.camera.position.set(g.x + dist * c * Math.sin(az), g.y + ty + dist * Math.sin(el), g.z + dist * c * Math.cos(az));
    app.controls.update();
    // 记进 orbit 管线：下一帧 beforePlayer 会先把相机放回 orbitPos，不存的话这次摆位一帧就被还原（相机相对 WASD 的断言全被带偏）
    app.saveOrbit();
    app.followInit = false;
    app.camPull = 1;
  };
  const S = { name: '', i: 0, done: false, info: {} };
  window.__S = S;
  window.__dump = () => {
    const p = app.player;
    const f = p.flight;
    const parts = app.bird.parts ?? {};
    return `fly ${p.flying} ${f.phase} pos ${f.pos.x.toFixed(0)},${f.pos.y.toFixed(0)},${f.pos.z.toFixed(0)} v ${f.speed.toFixed(0)} pitch ${f.bodyPitch.toFixed(2)} open ${f.wingOpen.toFixed(2)} viewMode ${app.viewMode} now ${app.viewNow} blend ${app.viewBlend.toFixed(2)} hidden ${app.bodyHidden} fov ${app.camera.fov.toFixed(0)} parts ${Object.entries(parts).map(([n, q]) => n + ':' + (q.on ? 1 : 0)).join('')} camDist ${app.camera.position.distanceTo(app.bird.group.position).toFixed(1)} keys ${[...p.keys].join('|')} auto ${p.auto} cam ${app.camera.position.toArray().map((v) => v.toFixed(1)).join(',')} bird ${app.bird.group.position.toArray().map((v) => v.toFixed(1)).join(',')} fwd ${app.camera.getWorldDirection(new (app.camera.position.constructor)()).toArray().map((v) => v.toFixed(2)).join(',')} fov ${app.camera.fov.toFixed(0)}`;
  };
  window.__setup = (name) => {
    app.player.reset();
    app.setAuto(false);
    app.viewMode = 'follow';
    // 不做"追尾 → orbit"的 0.45 s 过渡：过渡中间相机方向是混合值，相机相对 WASD / 镜头视线引导的断言会被带偏
    app.snapView();
    app.player.flight.homeRadius = 170;
    // 相机自动跟到鸟背后：只有 flight / follow 场景开着（看真实的跟随机位），其余场景机位是摆好的、不能被拉走
    app.camFollow = name === 'flight' || name === 'follow' || name === 'standfly';
    app.flightDist = 70;
    // 飞行中"跟鼠标镜头指哪飞哪"：摆好的机位会把鸟带跑，只在 follow 场景开着
    app.player.camSteer = false;
    if (!window.__readIntent) window.__readIntent = app.player.readIntent;
    app.player.readIntent = window.__readIntent;
    app.player.keys.clear();
    S.name = name;
    S.i = 0;
    S.done = false;
    S.info = {};
    // 定格点标记每个场景重置（同名的定格点在 flick / skidside / tailfan 之间复用）
    S.flags = {};
    S.landI = 0;
    S.landY = 0;
    for (let i = 0; i < 4; i++) window.__step();
    const fam = { flick: 'flick', skidside: 'flick', tailfan: 'flick', limb: 'limb', limbfeet: 'limb', camavoid: 'limb', wire: 'wire' }[name] ?? name;
    if (fam === 'limb') {
      // 挑一根够粗、有坡度的子枝，把步态放上去落地（onLanded），相机摆到鸟后面顺着枝看
      const V = app.camera.position.constructor;
      const v = new V();
      const fr = makeCurveFrame();
      let pick = null;
      for (const [perch] of app.rig.treeLimbs()) {
        const f = perch.frameAt(perch.length * 0.5, fr);
        if (f.radius > 0.45 && Math.abs(f.ty) > 0.15 && Math.abs(f.ty) < 0.6) {
          perch.pointAt(perch.length * 0.5, 0, 0, v);
          pick = { perch, f };
          break;
        }
      }
      if (!pick) throw new Error('没有合适的子枝');
      app.player.loco.place(app.rig.world, v.x, v.y + 0.5, v.z, pick.f.tx, pick.f.tz);
      app.player.onLanded();
      S.info.limb = `半径 ${pick.f.radius.toFixed(2)} cm，切线 (${pick.f.tx.toFixed(2)}, ${pick.f.ty.toFixed(2)}, ${pick.f.tz.toFixed(2)})，落点 (${v.x.toFixed(1)}, ${v.y.toFixed(1)}, ${v.z.toFixed(1)})`;
      for (let i = 0; i < 6; i++) window.__step();
      const h = app.player.loco.heading;
      // limb：鸟后上方顺着枝看；limbfeet：贴着枝从侧前方看脚爪（枝有坡度，两脚该一高一低都贴着树皮）；camavoid：随便先摆一个
      if (name === 'limbfeet') window.__cam(Math.atan2(h.x, h.z) + 1.0, 0.02, 4, 0.3);
      else window.__cam(Math.atan2(-h.x, -h.z) + 0.6, 0.25, 10, 1.4);
    } else {
      // 鸟面朝 -x，相机在 +x 侧往后看：W = 前进（-x），S = 后退（+x），D = 鸟身右（-z）
      window.__cam(Math.PI / 2 + 0.45, 0.25, 15, 1.8);
    }
    if (name === 'skidside' || name === 'limbfeet' || name === 'tailfan' || name === 'wire') {
      // 相机在侧面拍照，键盘意图就成了横向的：这两个场景直接把意图设成朝向（window.__hold 控制按不按）
      app.player.readIntent = () => {
        const h = app.player.loco.heading;
        const on = window.__hold !== false;
        app.player.intent.x = on ? h.x : 0;
        app.player.intent.z = on ? h.z : 0;
        app.player.intent.hop = on;
      };
      window.__hold = false;
    }
    if (fam === 'flick') {
      // 从雪地上 x = 40 往 +x（远离树冠，低枝不挡镜头）跑
      app.player.loco.place(app.rig.world, 40, -79, 0, 1, 0);
      app.player.onLanded();
      for (let i = 0; i < 6; i++) window.__step();
      // flick：鸟后上方看翅膀抖；skidside：正侧面看急刹的前倾和尾羽
      if (name === 'skidside') window.__cam(Math.PI, 0.35, 18, 2.0);
      else if (name === 'tailfan') {
        // 尾扇俯视：鸟后上方 7 cm 往下看尾羽（扇面连不连续、中缝裂不裂）
        const h = app.player.loco.heading;
        window.__cam(Math.atan2(-h.x, -h.z), 0.42, 7, 0.9);
      } else window.__cam(-Math.PI / 2 + 0.45, 0.22, 16, 1.8);
    }
    if (name === 'wire') {
      // 放到电线中点：顺线跳一下，看落地激发颤动 + 站着时鸟跟着线走
      const perch = app.rig.curve('wire');
      const V = app.camera.position.constructor;
      const v = new V();
      perch.pointAt(perch.length * 0.5, 0, 0, v);
      app.player.loco.place(app.rig.world, v.x, v.y + 1, v.z, 1, 0);
      app.player.onLanded();
      S.info.wire = `落点 (${v.x.toFixed(1)}, ${v.y.toFixed(1)}, ${v.z.toFixed(1)})`;
      for (let i = 0; i < 6; i++) window.__step();
      const h = app.player.loco.heading;
      window.__cam(Math.atan2(h.x, h.z) + Math.PI / 2 + 0.3, 0.18, 12, 1.6);
    }
    if (name === 'flightland') {
      // 直接从半空进入飞行：雪地上方 100 cm、从 x = 220 朝 -x 以 400 cm/s 滑翔（离树冠远，先滑翔 ~0.5 s 再进 Flare）（测试雪板只有 560 cm 宽，从枝上起飞来不及落回来）
      app.player.flying = true;
      app.player.flight.start(new Vec3(220, 20, 0), new Vec3(-400, 0, 0), -1, 0, false);
      window.__cam(Math.PI / 2 + 0.45, 0.25, 40, 1.8);
    }
    if (name === 'follow') {
      // 第三人称跟随：相机故意摆在鸟的正前方 20 cm（看着鸟脸），之后按 D 掉头、按 W 前进，相机该自己绕到背后
      const h = app.player.loco.heading;
      window.__cam(Math.atan2(h.x, h.z), 0.1, 20, 1.8);
    }
    if (name === 'looksteer') {
      // 飞行中鼠标视线引导的方向断言：从半空起飞、自动巡航扑翼（不按空格——空格现在是爬升，会压掉镜头的俯仰引导；扑翼中不进着陆探测），
      // 相机不自动跟（摆哪是哪），鸟按镜头转向。场地半径放到无限大：650 cm/s 下 0.5 s 就飞出 170 的边界，边界"朝中心满舵"会接管航向
      app.player.flight.homeRadius = 1e5;
      app.player.flying = true;
      app.player.flight.start(new Vec3(150, 200, 0), new Vec3(-650, 0, 0), -1, 0, false);
      app.camFollow = false;
      app.player.camSteer = true;
    }
    if (name === 'groundsteer') {
      // 雪地相机相对 WASD：放到雪地 (120, −79, 0) 朝 +x（离树冠远，相机不会被低枝避障滑走），相机摆在 −z 侧看 +z（视线 +z）；相机不自动跟，按 W 该转身朝 +z 跳、按 D 朝视线右（−x）
      app.player.loco.place(app.rig.world, 120, -79, 0, 1, 0);
      app.player.onLanded();
      for (let i = 0; i < 6; i++) window.__step();
      app.camFollow = false;
      window.__cam(Math.PI, 0.3, 22, 1.8);
    }
    if (name === 'fall') {
      // 高处跃下：放到建筑顶边沿（顶面 y = 60，边沿 z = −70），朝 +z 面向屋檐；W + 空格朝前跃出屋檐往下掉，半空按空格展翅
      app.player.loco.place(app.rig.world, 100, 61, -76, 0, 1);
      app.player.onLanded();
      for (let i = 0; i < 6; i++) window.__step();
      window.__cam(Math.PI + 0.4, 0.2, 24, 1.8);
    }
    if (name === 'fpshoulder' || name === 'fpeye' || name === 'chasefly') {
      // 第一人称：雪地上空 240 cm 从场地东侧朝 −x 起步（离树冠远），按住空格扑翼再松开滑翔（fpeye 一直滑到落地站着）；
      // camSteer 开（视角 = 航向直飞；fpshoulder 中段把 viewYaw 拨 +0.45 模拟鼠标左指，鸟该压左坡转过去）
      app.player.flying = true;
      app.player.flight.start(new Vec3(150, 240, 0), new Vec3(-560, 0, 0), -1, 0, false);
      // 逆风软边界留着（170）：雪地只有 ±280，直飞 0.5 s 就飞出场地上空、滑翔到落地那几张拍不到——0.5 s 后到边界压坡，
      // 绕着场地滑下来（扑翼那几张正好是直飞，滑翔 / 转弯 / 落地是压坡）；配 RIG=1 拍，楼 / 树 / 雪地都在
      app.player.camSteer = true;
      app.viewMode = name === 'fpeye' ? 'eye' : name === 'chasefly' ? 'chase' : 'shoulder';
    }
    if (name === 'chaseground') {
      // 默认追尾机位的地面连跳：雪地上 x = 40 朝 +x（远离树冠），按住 W 连跳；相机锁定追尾，竖直只跟地形不跟每一跳
      // 从雪地西侧 (−200, 150) 往 +x 跑（远离树干和楼，440 cm 够连跳 2.5 s）
      app.player.loco.place(app.rig.world, -200, -79, 150, 1, 0);
      app.player.onLanded();
      app.viewMode = 'chase';
      // 预设机位 → 追尾的过渡要走完（0.45 s）再开跑
      for (let i = 0; i < 40; i++) window.__step();
    }
    if (name === 'autofly') {
      // 自由巡飞：在枝上开 AI，歇 1.2 s 自动起飞；相机是 orbit（不回正），到点摆到几个角度拍
      app.setAuto(true);
    }
    if (name === 'touchdown') {
      // 俯冲触地：雪地上空 140 cm 朝 −x、压低视角（俯仰 −1）扑翼俯冲撞雪地 → 当帧落定、余速急刹、0.11 s 收翅；
      // 第二段同高度滑翔（Shift）→ Flare ≤ 0.4 s 减速滑到刹停点落定。场地半径放到无限大（不压坡）
      app.player.flight.homeRadius = 1e5;
      app.player.flying = true;
      app.player.flight.start(new Vec3(150, 60, 0), new Vec3(-650, 0, 0), -1, 0, false);
      app.player.camSteer = true;
      app.viewPitch = -1;
      app.viewMode = 'chase';
    }
    if (name === 'look360') {
      // 三档视角各转一整圈再按 W（相机跟着视角转、鸟朝视角方向跳），再在飞行中甩 180°（镜头立刻转过去、鸟压坡追上）
      // 雪地板中心偏西南（−100, −100）：每档走完都放回这一点，三档加起来不会跑出 ±280 的雪地板
      app.player.loco.place(app.rig.world, -100, -79, -100, 1, 0);
      app.player.onLanded();
      app.player.camSteer = true;
      app.player.flight.homeRadius = 1e5;
      app.viewMode = 'chase';
      app.snapView();
      for (let i = 0; i < 10; i++) window.__step();
    }
    return { ...st(), info: S.info };
  };
  window.__run = () => {
    const k = app.player.keys;
    const s = window.__step();
    S.i++;
    let capture = null;
    const once = (name) => {
      if (S.flags[name]) return;
      S.flags[name] = true;
      capture = name;
    };
    const fam = { skidside: 'flick', tailfan: 'flick', limbfeet: 'limb', camavoid: 'limb' }[S.name] ?? S.name;
    switch (fam) {
      case 'back':
        if (S.i < 150) k.add('KeyS');
        else k.clear();
        if (s.phase === 'crouch' && s.hops === 0 && s.t > 0.05) once('back_crouch');
        if (s.phase === 'air' && s.hops === 1 && s.airK > 0.6) once('back_air');
        if (s.phase === 'stand' && s.hops === 3) {
          once('back_stand');
          S.done = true;
        }
        break;
      case 'leap':
        // 枝上 D + 空格 = 显式跃离（相机在 +x 侧往后看，D = 鸟身右 = -z）：朝 -z 跳出枝、掉到雪地；落地朝向 = 跃出方向
        // 腾空后就松开空格（按着空格会起飞，那是 flight 场景）
        if (s.hops === 0) {
          k.add('KeyD');
          k.add('Space');
        } else if (s.phase === 'air') {
          k.add('KeyD');
          k.delete('Space');
        } else k.clear();
        if (s.phase === 'push' && s.hops === 0 && s.t > 0.025) once('leap_push');
        if (s.phase === 'air' && s.hops === 1 && s.airK > 0.4) once('leap_air');
        if (s.phase === 'stand' && s.hops === 1) {
          once('leap_land');
          S.done = true;
        }
        break;
      case 'turn':
        // 第一跳落地缓冲时就松手（朝向已经反过来，再按就成了往回转）
        if (s.hops === 0 || s.phase === 'air') k.add('KeyD');
        else k.clear();
        if (s.phase === 'push' && s.hops === 0 && s.t > 0.025) once('turn_push');
        if (s.phase === 'air' && s.hops === 1 && s.airK > 0.3) once('turn_air30');
        if (s.phase === 'air' && s.hops === 1 && s.airK > 0.6) once('turn_air60');
        if (s.phase === 'air' && s.hops === 1 && s.airK > 0.9) once('turn_air90');
        if (s.phase === 'stand' && s.hops === 1) {
          once('turn_stand');
          S.done = true;
        }
        break;
      case 'flick':
        // 按住 W 连跳 5 下，第 5 下腾空过 40% 松手 → 落地急刹
        if (S.name === 'skidside' || S.name === 'tailfan') window.__hold = !(s.hops >= 5 && s.phase === 'air' && s.airK > 0.4);
        else if (!(s.hops >= 5 && s.phase === 'air' && s.airK > 0.4)) k.add('KeyW');
        else k.clear();
        if (s.phase === 'push' && s.hops === 4 && s.t > 0.03) once('flick_push5');
        if (s.phase === 'air' && s.hops === 5 && s.airK > 0.2) once('flick_air5');
        if (s.phase === 'skid' && s.skidK > 0.1) once('skid_early');
        if (s.phase === 'skid' && s.skidK > 0.5) once('skid_mid');
        if (s.phase === 'stand' && s.hops === 5 && S.flags.skid_early) {
          once('skid_end');
          S.done = true;
        }
        break;
      case 'wire': {
        // 顺线（朝向）跳一下：落地激发颤动，之后 20 帧线还在晃、鸟跟着走
        // 只按 10 帧（正好起一跳），落地后不再按：看落地激发的颤动和站着时跟着线走
        window.__hold = S.i > 20 && S.i < 30;
        const perch = app.rig.curve('wire');
        if (S.i === 18) once('wire_stand');
        if (s.phase === 'air' && s.hops === 1 && s.airK > 0.7) once('wire_air');
        if (s.phase === 'settle' && s.hops === 1 && !S.flags.wire_land) {
          once('wire_land');
          S.landI = S.i;
        }
        if (S.flags.wire_land && S.i === S.landI + 20) {
          S.info.offset = perch.offsetAt(app.player.loco.u);
          S.info.rootDy = app.bird.group.position.y - S.landY;
          once('wire_swing');
          S.done = true;
        }
        if (s.phase === 'stand' && s.hops === 0) S.landY = app.bird.group.position.y;
        break;
      }
      case 'follow': {
        // 第三人称跟随：相机先在鸟正前方；18 帧起按 D 一帧不掉头（到 40 帧松手，正好一跳），60 帧起按 W 往前连跳
        if (S.i === 18) once('follow_front');
        if (S.i > 18 && S.i < 40) k.add('KeyD');
        else if (S.i >= 60 && S.i < 110) k.add('KeyW');
        else k.clear();
        if (S.i === 60) once('follow_turned');
        if (S.i === 110) {
          once('follow_hop');
          S.done = true;
        }
        // 相机相对鸟身的位置：方位角（0 = 正前、π = 正后）和距离
        const g = app.bird.group.position;
        const t = app.controls.target;
        const dx = app.camera.position.x - t.x;
        const dz = app.camera.position.z - t.z;
        const h = app.player.loco.heading;
        let a = Math.atan2(dx, dz) - Math.atan2(h.x, h.z);
        a = Math.atan2(Math.sin(a), Math.cos(a));
        S.info.note = `相机离鸟身方位 ${(a * 57.3).toFixed(0)}°（0 = 正前、180 = 正后）距离 ${app.camera.position.distanceTo(g).toFixed(1)} cm`;
        break;
      }
      case 'looksteer': {
        // 三段各 40 帧（坡度从满左压到满右压要 0.5 s）、不按键（自动巡航扑翼）：① 相机摆到鸟的后右方（视线朝前左，lookYaw 正）→ 鸟该往左转（航向方位 atan2(hx,hz) 增大）；
        // ② 摆到后左方（视线朝前右，lookYaw 负）→ 往右转；③ 正后方但抬高 0.85 rad 往下看 → 俯冲（bodyPitch < 0）。不按方向键，全靠镜头
        const f = app.player.flight;
        k.clear();
        const h = f.heading;
        const behind = Math.atan2(-h.x, -h.z);
        const az = Math.atan2(h.x, h.z);
        const wrap = (v) => Math.atan2(Math.sin(v), Math.cos(v));
        if (S.i === 3) {
          window.__cam(behind + 0.8, 0.3, 30, 1.5);
          app.updateLookSteer();
          S.info.az0 = az;
          S.info.yaw0 = app.player.lookYaw;
          once('looksteer_leftview');
        }
        if (S.i === 43) {
          S.info.dLeft = wrap(az - S.info.az0);
          window.__cam(Math.atan2(-h.x, -h.z) - 0.8, 0.3, 30, 1.5);
          app.updateLookSteer();
          S.info.az0 = az;
          S.info.yaw1 = app.player.lookYaw;
          once('looksteer_rightview');
        }
        if (S.i === 83) {
          S.info.dRight = wrap(az - S.info.az0);
          window.__cam(Math.atan2(-h.x, -h.z), 0.85, 30, 1.5);
          S.info.pitch0 = f.bodyPitch;
          once('looksteer_highview');
        }
        if (S.i === 123) {
          S.info.dPitch = f.bodyPitch - S.info.pitch0;
          once('looksteer_end');
          S.done = true;
        }
        S.info.note = `① 后右方镜头（视线偏左，lookYaw ${(S.info.yaw0 ?? 0).toFixed(2)}）→ 航向转 ${((S.info.dLeft ?? 0) * 57.3).toFixed(0)}°；② 后左方（视线偏右，lookYaw ${(S.info.yaw1 ?? 0).toFixed(2)}）→ ${((S.info.dRight ?? 0) * 57.3).toFixed(0)}°；③ 抬高镜头 → 俯仰 ${(S.info.pitch0 ?? 0).toFixed(2)} → ${f.bodyPitch.toFixed(2)}，空速 ${f.speed.toFixed(0)}`;
        if (S.i === 123) {
          const ok = (S.info.yaw0 ?? 0) > 0.3 && (S.info.yaw1 ?? 0) < -0.3 && S.info.dLeft > 0.15 && S.info.dRight < -0.15 && f.bodyPitch < -0.1;
          if (!ok) throw new Error(`looksteer 方向断言失败：${S.info.note}（期望 lookYaw ① 正 ② 负、航向 ① 正转 ② 负转、③ bodyPitch < −0.1）`);
        }
        break;
      }
      case 'groundsteer': {
        // 不按键 18 帧 → W 到 60 帧 → D 到 110 帧 → S 到 160 帧（各段等落回站着再判）。断言（2026-11-23 用户要求）：
        // W 后朝向 ≈ 镜头视线 (+z) 且往 +z 挪了；D 后朝向不变、往视线右 (−x) 侧跳挪了；S 后朝向不变、背对视线 (−z) 后撤跳挪了
        const p = app.player.loco;
        k.clear();
        if (S.i >= 18 && S.i < 60) k.add('KeyW');
        else if (S.i >= 60 && S.i < 110) k.add('KeyD');
        else if (S.i >= 110 && S.i < 160) k.add('KeyS');
        if (S.i === 18) {
          S.info.x0 = p.pos.x;
          once('groundsteer_start');
        }
        if (S.i === 60) {
          S.info.h1 = [p.heading.x, p.heading.z];
          S.info.z1 = p.pos.z;
          once('groundsteer_afterW');
        }
        if (S.i === 110) {
          S.info.h2 = [p.heading.x, p.heading.z];
          S.info.x2 = p.pos.x;
          once('groundsteer_afterD');
        }
        if (S.i >= 160 && p.phase === 'stand') {
          S.info.h3 = [p.heading.x, p.heading.z];
          S.info.z3 = p.pos.z;
          once('groundsteer_afterS');
          S.done = true;
          const ok = S.info.h1[1] > 0.9 && S.info.z1 > 5 && Math.abs(S.info.h2[1] - 1) < 0.1 && S.info.x2 < S.info.x0 - 8 && Math.abs(S.info.h3[1] - 1) < 0.1 && S.info.z3 < S.info.z1 - 8;
          if (!ok) throw new Error(`groundsteer 断言失败：W 后朝向 (${S.info.h1.map((v) => v.toFixed(2))}) z ${S.info.z1.toFixed(1)}，D 后朝向 (${S.info.h2.map((v) => v.toFixed(2))}) x ${S.info.x2.toFixed(1)}（起点 ${S.info.x0.toFixed(1)}），S 后朝向 (${S.info.h3.map((v) => v.toFixed(2))}) z ${S.info.z3.toFixed(1)}（期望 W 后 ≈ +z 且 z > 5；D 后朝向不变且 x < −8；S 后朝向不变且 z 比 W 后少 8 以上）`);
        }
        S.info.note = S.info.h1 ? `视线 (${app.player.camDirX.toFixed(2)},${app.player.camDirZ.toFixed(2)}) W 后朝向 (${S.info.h1.map((v) => v.toFixed(2))}) z ${S.info.z1.toFixed(1)}${S.info.h2 ? `；D 后朝向 (${S.info.h2.map((v) => v.toFixed(2))}) x ${S.info.x2.toFixed(1)}` : ''}${S.info.h3 ? `；S 后朝向 (${S.info.h3.map((v) => v.toFixed(2))}) z ${S.info.z3.toFixed(1)}` : ''}` : '';
        break;
      }
      case 'fall': {
        // 屋檐边 W + 空格朝前跃出 → 腾空后松开空格往下掉 → 第 36 帧半空再按住空格展翅切入飞行
        const f = app.player.flight;
        if (S.i < 12) {
          k.add('KeyW');
          k.add('Space');
        } else if (S.i < 36) k.clear();
        else k.add('Space');
        if (S.i === 35) once('fall_drop');
        if (app.player.flying && f.wingOpen > 0.5) once('fall_open');
        if (app.player.flying && f.t > 0.6) {
          once('fall_fly');
          S.done = true;
        }
        if (capture) {
          const h = app.player.flying ? f.heading : app.player.loco.heading;
          window.__cam(Math.atan2(h.x, h.z) - Math.PI / 2 + 0.3, 0.1, 26, 1.5);
          app.renderer.render(app.scene, app.camera);
        }
        S.info.note = S.i >= 35 && !app.player.flying ? `下落中 根 y ${app.player.loco.pos.y.toFixed(1)} 速度 ${app.player.loco.vel.length().toFixed(0)} cm/s` : '';
        break;
      }
      case 'standfly': {
        // 原地长按空格：先是一下朝前小跳，腾空 0.12 s 后起飞
        const f = app.player.flight;
        if (S.i >= 18) k.add('Space');
        if (S.i === 17) once('standfly_stand');
        if (app.player.flying) once('standfly_takeoff');
        if (app.player.flying && f.t > 0.6) {
          once('standfly_air');
          S.done = true;
        }
        break;
      }
      case 'flightland': {
        // 半空滑翔 → 自动进 Flare → 落到雪地交回步态；不按键。滑翔 / Flare 各拍几个角度（侧面、前侧方、正面、后侧方）
        const f = app.player.flight;
        const az = Math.atan2(f.heading.x, f.heading.z);
        // 按住 Shift 滑翔（飞行态默认自动扑翼）
        k.clear();
        k.add('ShiftLeft');
        if (app.player.flying && f.phase === 'fly' && f.t > 0.08 && !f.flapping && f.wingOpen > 0.95) once('flightland_glide');
        if (S.flags.flightland_glide && app.player.flying && f.phase === 'fly' && f.t > 0.2) once('flightland_glide_top');
        if (app.player.flying && f.phase === 'flare' && f.flareK > 0.35) once('flight_flare_side');
        if (app.player.flying && f.phase === 'flare' && f.flareK > 0.55) once('flight_flare_front');
        if (app.player.flying && f.phase === 'flare' && f.flareK > 0.75) once('flight_flare_rear');
        if (app.player.flying && f.phase === 'flare' && f.legsExtend > 0.9) once('flight_flare2');
        if (!app.player.flying) {
          once('flight_land');
          S.done = true;
        }
        const cams = {
          flightland_glide: [az + 2.0, 0.15, 16, 1.5],
          flightland_glide_top: [az + Math.PI - 0.3, 0.6, 20, 1.5],
          flight_flare_side: [az + 1.0, 0.12, 16, 1.5],
          flight_flare_front: [az + 0.3, 0.15, 16, 1.5],
          flight_flare_rear: [az + 2.6, 0.3, 18, 1.5],
          flight_flare2: [az + 0.8, -0.1, 14, 1.5],
        };
        if (cams[capture]) window.__cam(...cams[capture]);
        if (capture && capture !== 'flight_land') app.renderer.render(app.scene, app.camera);
        break;
      }
      case 'flight': {
        // 枝上 W + 空格跃离 → 按住空格起飞 → 0.05 s 起 A + 空格压坡爬升到 1.3 s（低速时转得快，绕着起点盘旋留在测试雪板里）→ 松开空格滑翔 → 自动着陆
        const f = app.player.flight;
        const t = f.t;
        if (!app.player.flying) {
          k.add('KeyW');
          k.add('Space');
        } else if (t < 0.05) k.delete('KeyW');
        else if (t < 1.3) {
          k.add('KeyA');
          k.add('Space');
        } else {
          // 松开 = 收力滑翔（飞行态默认自动扑翼，滑翔要按 Shift）
          k.clear();
          k.add('ShiftLeft');
        }
        if (app.player.flying && t > 0.5 && t < 1.3 && f.flapping && Math.sin(f.flapPhase) > 0.95) once('flight_flapup');
        if (app.player.flying && t > 0.5 && t < 1.3 && f.flapping && Math.sin(f.flapPhase) < -0.95) once('flight_flapdown');
        // 滑翔抓拍要等翅膀真的舒展开（松手那一帧可能还在收翼态，wingOpen 要回到 0.95 以上）
        if (app.player.flying && t >= 1.3 && t < 2.6 && f.phase === 'fly' && !f.brake && !f.flapping && f.wingOpen > 0.95 && Math.abs(f.bank) < 0.35) once('flight_glide');
        if (app.player.flying && f.phase === 'flare' && f.flareK > 0.5) once('flight_flare');
        // 真实跟随机位的一帧：放在任何 __cam 之前拍（相机从枝上的 15 cm 一路退到 70 cm、绕到背后）
        if (app.player.flying && t > 0.3 && t < 0.45) once('flight_trail');
        if (app.player.flying) once('flight_takeoff');
        // 近景定格：侧后方 14 cm（扑翼 / 滑翔），着陆前侧方 16 cm；定格这一帧已经渲染过了，摆完相机再补渲染一帧
        if (capture === 'flight_flapup' || capture === 'flight_flapdown' || capture === 'flight_glide') window.__cam(Math.atan2(f.heading.x, f.heading.z) + 2.2, 0.18, 14, 2.0);
        if (capture === 'flight_flare') window.__cam(Math.atan2(f.heading.x, f.heading.z) + 1.0, 0.12, 16, 1.5);
        if (capture && capture !== 'flight_takeoff' && capture !== 'flight_land') app.renderer.render(app.scene, app.camera);
        if (!app.player.flying && S.flags.flight_takeoff) {
          once('flight_land');
          S.done = true;
        }
        break;
      }
      case 'fpshoulder':
      case 'fpeye':
      case 'chasefly': {
        // 0~100 帧扑翼（抓上扬 / 下扑），fpshoulder 100 帧起松开滑翔、170 帧把准星左拨 0.45 rad（215 帧拍压坡转向）、
        // 250 帧回正、300 帧收工；fpeye 一直滑翔到 Flare 落地、站着 30 帧后拍地面第一人称
        const f = app.player.flight;
        const eye = S.name === 'fpeye';
        const chase = S.name === 'chasefly';
        // 飞行自动巡航扑翼（不用按空格）；100 帧起按住 Shift 收力滑翔（fpeye 一直滑到落地），fpshoulder / chasefly 230 帧松开回扑翼
        k.clear();
        if (S.i >= 100 && S.i < (eye ? 1e9 : 230)) k.add('ShiftLeft');
        // 170 帧视角左拨 0.45 rad（模拟鼠标左指，镜头立刻转过去、鸟压左坡追），250 帧回看航向
        if (!eye && S.i === 170) app.viewYaw += 0.45;
        if (!eye && S.i === 250) app.viewYaw = Math.atan2(app.player.headingX, app.player.headingZ);
        const blendDone = S.i > 30;
        const pre = eye ? 'fpeye' : chase ? 'chase' : 'fp';
        if (S.i === 14) once(pre + '_blend');
        if (blendDone && S.i < 100 && f.flapping && Math.sin(f.flapPhase) > 0.95) once(pre + '_flapup');
        if (blendDone && S.i < 100 && f.flapping && Math.sin(f.flapPhase) < -0.95) once(pre + '_flapdown');
        const gliding = S.i >= 100 && !f.flapping && f.wingOpen > 0.95 && f.phase === 'fly';
        if (gliding && !S.flags[pre + '_glide']) {
          once(pre + '_glide');
          S.info.note = `机位 ${eye ? '纯第一人称' : `过肩 (${app.shoulderLocal.x.toFixed(1)}, ${app.shoulderLocal.y.toFixed(1)}, ${app.shoulderLocal.z.toFixed(1)}) 俯仰偏置 ${app.shoulderPitch}`} 视角 ${app.viewNow} blend ${app.viewBlend.toFixed(2)} fov ${app.camera.fov.toFixed(1)} near ${app.camera.near.toFixed(2)}`;
        }
        if (!eye && S.i === 215) once(chase ? 'chase_turn' : 'fp_turn');
        // 追尾：V 三档循环的两次切换各拍一张过渡帧（追尾 → 过肩 → 纯第一人称 → 回追尾）
        if (chase && S.i === 262) app.toggleView();
        if (chase && S.i === 274) once('chase_to_shoulder');
        if (chase && S.i === 280) app.toggleView();
        if (chase && S.i === 292) once('chase_to_eye');
        if (chase && S.i === 300) app.toggleView();
        if (chase && S.i === 312) once('chase_back');
        if (eye && f.phase === 'flare' && f.flareK > 0.6 && !S.flags.fpeye_flare) {
          const parts = app.bird.parts ?? {};
          S.info.note = ` flare: viewMode ${app.viewMode} now ${app.viewNow} hidden ${app.bodyHidden} flying ${app.player.flying} parts ${Object.entries(parts).map(([n, p]) => n + ':' + (p.on ? 1 : 0) + '/' + p.objs.filter((o) => o.visible).length).join(' ')} cam ${app.camera.position.toArray().map((v) => v.toFixed(1))} bird ${app.bird.group.position.toArray().map((v) => v.toFixed(1))}`;
          once('fpeye_flare');
        }
        if (eye && !app.player.flying && S.flags.fpeye_flare) {
          S.landI ??= S.i;
          if (S.i > S.landI + 30) {
            once('fpeye_ground');
            S.done = true;
          }
        }
        if (!eye && S.i === (chase ? 330 : 300)) S.done = true;
        S.info.note = `视角 ${app.viewNow} blend ${app.viewBlend.toFixed(2)} fov ${app.camera.fov.toFixed(1)} near ${app.camera.near.toFixed(2)} 视角方位 ${(app.viewYaw * 57.3).toFixed(0)}°`;
        break;
      }
      case 'chaseground': {
        // 默认追尾机位 + 地面连跳：按住 W（相机相对 = 朝前），拍起跳 / 腾空最高点 / 落地缓冲 / 连跳 2 s 后动量起来的一幕
        k.clear();
        k.add('KeyW');
        const l = app.player.loco;
        // 连跳数据：第一次离地记起点，之后每次落地（air → crouch / settle）记帧号和位置，收工断言（和 sim.mjs gait E 同一组数字）：
        // 频率 3.5~4.2 跳/秒、首跳 16~22 cm、第 4 跳 28~38 cm
        const gd = S.info.ground ?? (S.info.ground = { landFrame: [], landXZ: [], start: null, lastPhase: l.phase });
        const wasAir = gd.lastPhase === 'air';
        if (l.phase === 'air' && !wasAir && gd.start === null) gd.start = [l.pos.x, l.pos.z];
        if (l.phase !== 'air' && wasAir) {
          gd.landFrame.push(S.i);
          gd.landXZ.push([l.pos.x, l.pos.z]);
        }
        gd.lastPhase = l.phase;
        if (l.phase === 'air' && l.airK < 0.12 && l.hops >= 1) once('chaseg_takeoff');
        if (l.phase === 'air' && l.airK > 0.42 && l.airK < 0.58 && l.hops >= 2) once('chaseg_apex');
        if (l.phase === 'crouch' && l.t < 0.02 && l.hops >= 2 && S.flags.chaseg_apex) once('chaseg_land');
        if (l.hops >= 6 && l.phase === 'air' && l.airK > 0.4 && l.airK < 0.6 && S.flags.chaseg_land) once('chaseg_run');
        if (S.i === 160) {
          once('chaseg_late');
          S.done = true;
          const n = gd.landFrame.length;
          const dists = [];
          if (n > 0 && gd.start) dists.push(Math.hypot(gd.landXZ[0][0] - gd.start[0], gd.landXZ[0][1] - gd.start[1]));
          for (let i = 1; i < n; i++) dists.push(Math.hypot(gd.landXZ[i][0] - gd.landXZ[i - 1][0], gd.landXZ[i][1] - gd.landXZ[i - 1][1]));
          const rate = n >= 2 ? (n - 1) / ((gd.landFrame[n - 1] - gd.landFrame[0]) / 60) : 0;
          S.info.groundStats = `${rate.toFixed(2)} 跳/秒、落地 ${n} 次、步幅 ${dists.map((d) => d.toFixed(1)).join('/')} cm`;
          if (!(rate >= 3.5 && rate <= 4.2 && dists[0] >= 16 && dists[0] <= 22 && dists[3] >= 28 && dists[3] <= 38)) {
            throw new Error(`chaseground 地面连跳断言失败：${S.info.groundStats}（期望 3.5~4.2 跳/秒、首跳 16~22、第 4 跳 28~38 cm）`);
          }
        }
        S.info.note = `第 ${l.hops} 跳 ${app.player.phaseText()} 动量 ${l.momentum.toFixed(2)} 机位 ${app.viewNow} 相机离鸟 ${app.camera.position.distanceTo(app.bird.group.position).toFixed(1)} cm${S.info.groundStats && S.i === 160 ? ` · ${S.info.groundStats} ✓` : ''}`;
        break;
      }
      case 'touchdown': {
        const f = app.player.flight;
        const p = app.player;
        k.clear();
        const open = () => app.bird.wingRigs.right.uniforms.uOpen.value;
        const wrap = (v) => Math.atan2(Math.sin(v), Math.cos(v));
        if (!S.flags.td_phase2) {
          // 段 1：扑翼俯冲撞地 → 当帧落定（不经 Flare）、切向余速急刹、7 帧内翅基本收拢
          if (S.i === 6) once('td_dive');
          if (!p.flying && !S.flags.td_landed) {
            S.flags.td_landed = true;
            S.landI = S.i;
            S.info.landedFlare = f.landedFlare;
            S.info.touchV = Math.hypot(f.touchVel.x, f.touchVel.z);
            S.info.phase = p.loco.phase;
            S.info.open0 = open();
            once('td_touch');
          }
          if (S.flags.td_landed && S.i === S.landI + 7) {
            S.info.open7 = open();
            once('td_fold');
          }
          if (S.flags.td_landed && S.i === S.landI + 30) {
            S.info.open30 = open();
            once('td_stand');
            const ok = S.info.landedFlare === false && S.info.open7 < 0.05 && S.info.open30 < 0.01 && p.loco.phase === 'stand' && Math.abs(p.loco.pos.y + 79) < 3;
            if (!ok) throw new Error(`touchdown 段 1 断言失败：landedFlare ${S.info.landedFlare}（要求 false = 触地即落）、落地 7 帧后翅 open ${S.info.open7.toFixed(3)}（要求 < 0.05）、30 帧后 ${S.info.open30.toFixed(3)}、末态 ${p.loco.phase}`);
            // 段 2：同高度滑翔着陆 → Flare 减速滑到刹停点
            S.flags.td_phase2 = true;
            S.i2 = 0;
            app.viewPitch = 0;
            p.flying = true;
            // 雪地板只有 ±280：从东缘上方 39 cm 起步，一进门就进捕获范围（500 cm/s 滑 0.86 s 就出板了）
            p.flight.start(new Vec3(250, -40, 0), new Vec3(-500, 0, 0), -1, 0, false);
          }
          if (S.i > 150) throw new Error('touchdown 段 1：150 帧还没落地');
        } else {
          S.i2 = (S.i2 ?? 0) + 1;
          k.add('ShiftLeft');
          if (f.phase === 'flare' && !S.flags.td_flareOn) {
            S.flags.td_flareOn = true;
            S.flareI = S.i2;
            once('td_flare');
          }
          if (S.flags.td_flareOn && !p.flying && !S.flags.td_land2) {
            S.flags.td_land2 = true;
            S.info.flareFrames = S.i2 - S.flareI;
            S.info.landedFlare2 = f.landedFlare;
            S.info.landedSpeed2 = f.landedSpeed;
            S.land2I = S.i2;
            once('td_touch2');
          }
          if (S.flags.td_land2 && S.i2 === S.land2I + 7) {
            S.info.open7b = open();
            once('td_fold2');
          }
          if (S.flags.td_land2 && S.i2 === S.land2I + 30) {
            once('td_stand2');
            S.done = true;
            // Flare 硬上限 0.4 s = 24 帧，起止各带半帧检测余量 → ≤ 26 帧
            const ok = S.info.landedFlare2 === true && S.info.flareFrames <= 26 && S.info.landedSpeed2 <= 60 && S.info.open7b < 0.05;
            if (!ok) throw new Error(`touchdown 段 2 断言失败：landedFlare ${S.info.landedFlare2}、Flare ${S.info.flareFrames} 帧（要求 ≤ 26 = 0.4 s 硬超时 + 2 帧检测余量）、触地速度 ${S.info.landedSpeed2.toFixed(1)}（要求 ≤ 60）、7 帧后翅 open ${S.info.open7b.toFixed(3)}`);
          }
          if (S.i2 > 500) throw new Error('touchdown 段 2：500 帧还没落下来');
        }
        S.info.note = S.flags.td_phase2
          ? `滑翔着陆：Flare ${S.info.flareFrames ?? '?'} 帧、触地 ${(S.info.landedSpeed2 ?? 0).toFixed(1)} cm/s、7 帧后翅 open ${(S.info.open7b ?? open()).toFixed(2)}`
          : `俯冲触地：landedFlare ${S.info.landedFlare ?? '?'}、余速 ${(S.info.touchV ?? 0).toFixed(0)} cm/s → ${S.info.phase ?? '-'}、翅 open 落地 ${(S.info.open0 ?? 1).toFixed(2)} → 7 帧 ${(S.info.open7 ?? open()).toFixed(3)} → 30 帧 ${(S.info.open30 ?? open()).toFixed(3)}`;
        break;
      }
      case 'look360': {
        // 地面：chase → shoulder → eye 各转 7 rad（> 一圈）再按 W 两跳；飞行：三档各甩 180° 看 2.5 s 内追上（巡航速度满坡 180° 要 2 s 多）
        const p = app.player;
        const f = p.flight;
        const wrap = (v) => Math.atan2(Math.sin(v), Math.cos(v));
        const modes = ['chase', 'shoulder', 'eye'];
        const st = S.info.st ?? 'ground';
        S.info.st = st;
        const mi = S.info.mi ?? 0;
        S.info.mi = mi;
        k.clear();
        if (st === 'ground') {
          const sub = S.info.sub ?? 'turn';
          S.info.sub = sub;
          if (S.info.mode !== modes[mi]) {
            S.info.mode = modes[mi];
            app.viewMode = modes[mi];
            app.snapView();
            S.info.tI = 0;
          }
          S.info.tI = (S.info.tI ?? 0) + 1;
          const tI = S.info.tI;
          if (sub === 'turn') {
            app.viewYaw -= 0.1;
            if (tI === 1 || tI === 18 || tI === 36 || tI === 54) once(`l360_${modes[mi]}_q${tI === 1 ? 0 : tI === 18 ? 1 : tI === 36 ? 2 : 3}`);
            if (tI >= 70) {
              S.info.sub = 'walk';
              S.info.tI = 0;
              S.info.viewEnd = app.viewYaw;
              S.info.pos0 = [p.loco.pos.x, p.loco.pos.z];
              S.info.head0 = Math.atan2(p.loco.heading.x, p.loco.heading.z);
            }
          } else if (sub === 'walk') {
            // 按住 W 两跳（30 帧）再松手，等落回站着再量（按着的时候地面连跳不会回到站着）
            if (tI <= 30) k.add('KeyW');
            if (tI > 30 && p.loco.phase === 'stand') {
              const h = Math.atan2(p.loco.heading.x, p.loco.heading.z);
              const dx = p.loco.pos.x - S.info.pos0[0];
              const dz = p.loco.pos.z - S.info.pos0[1];
              const len = Math.hypot(dx, dz);
              const along = len > 1e-6 ? (dx * Math.sin(S.info.viewEnd) + dz * Math.cos(S.info.viewEnd)) / len : 0;
              once(`l360_${modes[mi]}_walk`);
              const ok = Math.abs(wrap(h - S.info.viewEnd)) < 0.2 && along > 0.9 && len > 10;
              if (!ok) throw new Error(`look360 ${modes[mi]} 断言失败：转一圈后按 W，朝向差 ${(wrap(h - S.info.viewEnd) * 57.3).toFixed(0)}°（要求 < 11°）、位移方向和视角的点积 ${along.toFixed(2)}（要求 > 0.9）、位移 ${len.toFixed(1)} cm`);
              S.info[`ok_${modes[mi]}`] = true;
              // 放回起点（朝向不变），下一档从同一点开始
              p.loco.place(app.rig.world, -100, -79, -100, p.loco.heading.x, p.loco.heading.z);
              p.onLanded();
              S.info.mi = mi + 1;
              S.info.tI = 0;
              S.info.mi = mi + 1;
              if (mi + 1 >= 3) {
                // 三档地面都过了：进飞行段（三档各甩 180°）
                S.info.st = 'fly';
                S.info.mi = 0;
                app.viewMode = 'chase';
                app.snapView();
                p.flying = true;
                f.start(new Vec3(150, 240, 0), new Vec3(-560, 0, 0), -1, 0, false);
                app.viewYaw = Math.atan2(f.heading.x, f.heading.z);
                app.viewPitch = 0;
              } else {
                S.info.sub = 'turn';
              }
            }
            if (tI > 200) throw new Error(`look360 ${modes[mi]}：按 W 200 帧没回到站着`);
          }
        } else {
          // 飞行：每档甩 180°（视角方位 +π），3 帧内镜头方位 = 视角方位，1.5 s 内航向角差 < 0.4 rad
          S.info.tI = (S.info.tI ?? 0) + 1;
          const tI = S.info.tI;
          const mode = modes[mi];
          S.info.mode = mode;
          if (tI === 1) {
            app.viewMode = mode;
            app.snapView();
            S.info.flicked = false;
          }
          if (tI === 12) {
            app.viewYaw += Math.PI;
            S.info.flicked = true;
            S.info.flickI = tI;
            S.info.headAtFlick = Math.atan2(f.heading.x, f.heading.z);
          }
          if (S.info.flicked && tI === S.info.flickI + 3 && !S.flags[`l360f_${mode}_cam`]) {
            const v = app.camera.getWorldDirection(new (app.camera.position.constructor)());
            const camAz = Math.atan2(v.x, v.z);
            S.flags[`l360f_${mode}_cam`] = true;
            S.info[`camErr_${mode}`] = Math.abs(wrap(camAz - app.viewYaw));
            once(`l360_fly_${mode}_flick`);
          }
          if (S.info.flicked && tI === S.info.flickI + 150) {
            const err = Math.abs(wrap(Math.atan2(f.heading.x, f.heading.z) - app.viewYaw));
            S.info[`headErr_${mode}`] = err;
            once(`l360_fly_${mode}_turned`);
            const ok = err < 0.35 && (S.info[`camErr_${mode}`] ?? 9) < 0.05;
            if (!ok) throw new Error(`look360 飞行 ${mode} 断言失败：甩 180° 后 2.5 s 航向角差 ${(err * 57.3).toFixed(0)}°（要求 < 20°）、3 帧后镜头方位差 ${((S.info[`camErr_${mode}`] ?? 9) * 57.3).toFixed(1)}°（要求 < 3°）`);
            S.info.mi = mi + 1;
            S.info.tI = 0;
            S.info.flicked = false;
            if (mi + 1 >= 3) S.done = true;
          }
          if (tI > 400) throw new Error(`look360 飞行 ${mode}：没追上`);
        }
        S.info.note = st === 'ground' ? `地面 ${modes[mi]}：${S.info.sub} 第 ${S.info.tI} 帧` : `飞行 ${S.info.mode}：镜头方位差 ${((S.info[`camErr_${S.info.mode}`] ?? 0) * 57.3).toFixed(1)}°、航向角差 ${((S.info[`headErr_${S.info.mode}`] ?? 0) * 57.3).toFixed(0)}°`;
        break;
      }
      case 'autofly': {
        k.clear();
        const f = app.player.flight;
        if (app.player.flying && !S.flags.auto_takeoff && S.i > 70) once('auto_takeoff');
        const orbitAt = (frame, name, dAz, el, dist) => {
          if (S.i !== frame || !app.player.flying) return;
          window.__cam(Math.atan2(f.heading.x, f.heading.z) + dAz, el, dist, 1.5);
          app.renderer.render(app.scene, app.camera);
          once(name);
        };
        orbitAt(200, 'auto_orbit_rear', 2.4, 0.25, 40);
        orbitAt(320, 'auto_orbit_side', 1.2, 0.1, 36);
        orbitAt(440, 'auto_orbit_front_high', 0.4, 0.5, 60);
        // 最后一张重新摆机位（不摆的话相机留在上一张的方位，鸟飞到树边时会被避障拉到 8.5 cm 贴着鸟头拍）
        orbitAt(540, 'auto_late', 2.0, 0.18, 38);
        if (S.i === 560) S.done = true;
        S.info.note = `${app.player.statusText()} · 到过 ${app.player.autopilot.spotsVisited} 个景点 · 相机离鸟 ${app.camera.position.distanceTo(app.bird.group.position).toFixed(0)} cm · 自动 ${app.player.auto}`;
        break;
      }
      case 'limb':
        if (S.name === 'camavoid') {
          if (S.i === 1) {
            // 绕鸟扫一圈（9 cm 远），挑离树干 / 枝条最近的那个方向摆相机：避障应该把相机拉到障碍外面
            const g = app.bird.group.position;
            const c = app.camContact;
            let best = null;
            for (let i = 0; i < 48; i++) {
              for (const el of [0.05, 0.22, 0.4]) {
                const az = (i / 48) * Math.PI * 2;
                const x = g.x + 9 * Math.cos(el) * Math.sin(az);
                const y = g.y + 1.4 + 9 * Math.sin(el);
                const z = g.z + 9 * Math.cos(el) * Math.cos(az);
                app.rig.world.closest(x, y, z, c);
                const d = Math.abs(c.dist);
                if (!best || d < best.d) best = { d, az, el };
              }
            }
            S.info.before = best.d;
            window.__cam(best.az, best.el, 9, 1.4);
          }
          if (S.i === 40) {
            const c = app.camContact;
            app.rig.world.closest(app.camera.position.x, app.camera.position.y, app.camera.position.z, c);
            S.info.clear = c.dist;
            // 视线：目标 → 相机 采 10 点的最小离面距离
            let sight = Infinity;
            const V = app.camera.position.constructor;
            const pr = new V();
            const t = app.controls.target;
            for (let i = 1; i <= 10; i++) {
              pr.copy(t).lerp(app.camera.position, i / 10);
              app.rig.world.closest(pr.x, pr.y, pr.z, c);
              sight = Math.min(sight, Math.abs(c.dist));
            }
            S.info.sight = sight;
            once('camavoid');
            S.done = true;
          }
          break;
        }
        if (S.name === 'limbfeet') window.__hold = S.i > 20 && S.i < 70;
        else if (S.i > 20 && S.i < 70) k.add('KeyW');
        else k.clear();
        if (S.i === 18) once(S.name === 'limbfeet' ? 'limbfeet_stand' : 'limb_stand');
        if (s.phase === 'air' && s.hops === 1 && s.airK > 0.7) once(S.name === 'limbfeet' ? 'limbfeet_air' : 'limb_air');
        if (s.phase === 'stand' && s.hops === 1) {
          once(S.name === 'limbfeet' ? 'limbfeet_land' : 'limb_land');
          S.done = true;
        }
        break;
    }
    return { capture, done: S.done, st: s, info: S.info };
  };
}, DT);

for (const name of want) {
  const first = await page.evaluate((n) => window.__setup(n), name);
  if (first.info?.limb) console.log(`${name}: 子枝 ${first.info.limb}`);
  console.log(`${name}: 起点 (${first.x.toFixed(2)}, ${first.y.toFixed(2)}, ${first.z.toFixed(2)}) 朝向 (${first.hx.toFixed(2)}, ${first.hz.toFixed(2)}) 栖面 ${first.perch}`);
  // 每个场景最多跑这么多帧（FRAMES 环境变量可调：look360 这种多段场景要 1000+）
  for (let i = 0; i < Number(process.env.FRAMES ?? 600); i++) {
    const r = await page.evaluate(() => window.__run());
    // DBG=<每几帧>：每几帧打印一行飞行 / 视角 / 部件可见性状态（调场景脚本用）
    const dbgFrom = Number(process.env.DBG_FROM ?? -1);
    const dbgTo = Number(process.env.DBG_TO ?? -1);
    if ((process.env.DBG && i % Number(process.env.DBG) === 0) || (dbgFrom >= 0 && i >= dbgFrom && i <= dbgTo)) console.log(`  #${i} ${await page.evaluate(() => window.__dump())}`);
    if (r.capture) {
      await page.screenshot({ path: `${OUT}/${name}_${r.capture}.png` });
      const s = r.st;
      console.log(`  ${r.capture}: ${s.phase} t=${s.t.toFixed(3)} airK=${s.airK.toFixed(2)} ${s.kind} 动量 ${s.mom.toFixed(2)} root=(${s.x.toFixed(2)}, ${s.y.toFixed(2)}, ${s.z.toFixed(2)}) 朝向 (${s.hx.toFixed(2)}, ${s.hz.toFixed(2)}) 翅 open ${s.openR.toFixed(2)} flap ${s.wingFlap.toFixed(2)} 尾 pitch ${s.tail.toFixed(2)} spread ${s.spread.toFixed(2)} camPull ${s.camPull.toFixed(2)} 相机离鸟 ${s.camDist.toFixed(1)} cm orbit ${s.orbit.toFixed(1)} full ${s.full.toFixed(1)} target (${s.tgt.map((v) => v.toFixed(1)).join(",")}) 最近查询面 kind ${s.blockKind} dist ${s.blockDist.toFixed(2)} @ ${s.blockAt ? s.blockAt.map((v) => v.toFixed(1)).join(",") : "-"} cam (${s.cam.map((v) => v.toFixed(1)).join(",")}) bird (${s.bird.map((v) => v.toFixed(1)).join(",")})${s.flying ? ` 飞行 ${s.fphase} t=${s.ft.toFixed(2)} 空速 ${s.fspeed.toFixed(0)} 俯仰 ${s.fpitch.toFixed(2)} 坡度 ${s.fbank.toFixed(2)} 扑翼 ${s.fflap} flareK ${s.flareK.toFixed(2)} 腿 ${s.legs.toFixed(2)} rot (${s.rot.map((v) => v.toFixed(2)).join(",")})` : ''}${r.info?.clear !== undefined ? ` 相机离最近表面：摆好后 ${r.info.before.toFixed(2)} cm → 40 帧后 ${r.info.clear.toFixed(2)} cm，视线上最小离面 ${r.info.sight.toFixed(2)} cm` : ""}${r.info?.offset !== undefined ? ` 电线位移 ${r.info.offset.toFixed(2)} cm、鸟群原点竖直跟着动了 ${r.info.rootDy.toFixed(2)} cm` : ""}${r.info?.note ? ` ${r.info.note}` : ""}`);
    }
    if (r.done) break;
  }
}
console.log(errors.length ? errors.join('\n') : 'no page errors');
await browser.close();
