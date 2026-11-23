// 诊断：LegRig 重写后的静止态和 buildLegs 输出到底哪一段有偏差（跗跖 / 各趾），以及控制点是否逐位一致。
import { chromium } from 'playwright-core';
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? chromium.executablePath(),
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
await page.goto('http://localhost:5173/city.html?ui=0&hud=0', { waitUntil: 'load' });
await page.waitForFunction(() => window.__roam !== undefined, null, { timeout: 120000 });
const r = await page.evaluate(async () => {
  const app = window.__roam;
  const { LegRig, gripping } = await import('/src/bird/legs.ts');
  const parts = await import('/src/bird/parts.ts');
  const Matrix4 = app.bird.group.matrix.constructor;
  const Vector3 = app.bird.group.position.constructor;
  const perch = app.branches.perchAt(0);
  const inv = app.bird.group.matrix.clone().invert();
  const rig = new LegRig(perch, inv);
  const lp = rig.geometry.getAttribute('position');
  const ref = lp.array.slice();
  const leg = rig.legs[0];
  const perTarsus = leg.toeStart[0] - leg.tarsusStart;
  const seg = (i) => (i < perTarsus ? 'tarsus' : i < 2 * perTarsus + 0 ? 'x' : 'toe');
  const dev = (pred) => {
    let m = 0;
    let worst = -1;
    for (let i = 0; i < lp.count; i++) {
      if (pred && !pred(i)) continue;
      const d = Math.max(Math.abs(lp.array[i * 3] - ref[i * 3]), Math.abs(lp.array[i * 3 + 1] - ref[i * 3 + 1]), Math.abs(lp.array[i * 3 + 2] - ref[i * 3 + 2]));
      if (d > m) { m = d; worst = i; }
    }
    return [m, worst];
  };
  const feet = [gripping(), gripping()];
  rig.update(new Matrix4().makeTranslation(0, -0.1, 0), feet);
  rig.update(new Matrix4(), feet);
  const perFoot = rig.legs[1].tarsusStart;
  const isTarsus = (i) => (i % perFoot) < perTarsus;
  const out = {
    tarsusDev: dev(isTarsus),
    toesDev: dev((i) => !isTarsus(i)),
    ankle0: [leg.ankle0.x, leg.ankle0.y, leg.ankle0.z],
    exit: [leg.exit.x, leg.exit.y, leg.exit.z],
    tarsusLen: leg.tarsus,
    // 构造后立刻再 update 一次（幂等性）
    again: dev(),
  };
  // 每条腿：重写后跗跖的偏差、IK 解出的膝和出肉点的距离、髋—踝距离和臂长
  out.legs = rig.legs.map((leg, li) => {
    const isT = (i) => i >= leg.tarsusStart && i < leg.toeStart[0];
    const [m, w] = dev(isT);
    return { side: leg.foot.side, dev: m, worstRing: w >= 0 ? Math.floor((w - leg.tarsusStart) / (12 + 1)) : -1, hipAnkle: leg.hip.distanceTo(leg.ankle0), reach: 0.3 + leg.tarsus, poleLen: leg.poleDir.length(), bowA: [leg.bowA.x, leg.bowA.y, leg.bowA.z] };
  });
  // IK 自检：按腿架自己的公式重解一遍静止态，看膝离出肉点多远；踝和 buildLegs 的踝（世界 → 局部）比
  out.ik = rig.legs.map((leg) => {
    const hip = leg.hip;
    const toAnkle = leg.ankle0.clone().sub(hip);
    const d = toAnkle.length();
    const dir = toAnkle.clone().multiplyScalar(1 / d);
    const a = Math.min(d, Math.max(0, (0.3 * 0.3 - leg.tarsus * leg.tarsus + d * d) / (2 * d)));
    const h = Math.sqrt(Math.max(0, 0.3 * 0.3 - a * a));
    const pole = leg.poleDir.clone().addScaledVector(dir, -leg.poleDir.dot(dir)).normalize();
    const knee = hip.clone().addScaledVector(dir, a).addScaledVector(pole, h);
    const spot = parts.FOOT_SPOTS[leg.foot.side === 1 ? 0 : 1];
    const perch = app.branches.perchAt(0);
    const n = perch.up.clone().multiplyScalar(Math.cos(leg.foot.alpha)).addScaledVector(perch.side, Math.sin(leg.foot.alpha));
    const ankleWorld = perch.center.clone().addScaledVector(perch.tangent, leg.foot.along).addScaledVector(n, perch.surfaceRadius(leg.foot.alpha, leg.foot.along) + 0.03);
    const ankleLocal = ankleWorld.applyMatrix4(inv);
    return { side: leg.foot.side, kneeToExit: knee.distanceTo(leg.exit), tarsus: leg.tarsus, exitAnkle: leg.exit.distanceTo(leg.ankle0), ankleDiff: ankleLocal.distanceTo(leg.ankle0), poleLen: leg.poleDir.length(), h };
  });
  // 和 buildLegs 的新输出逐环比跗跖，看偏差沿环的形状
  const g2 = parts.buildLegs(perch, inv);
  const p2 = g2.geometry ? g2.geometry.getAttribute("position").array : g2.getAttribute("position").array;
  out.ringProfile = rig.legs.map((leg) => {
    const prof = [];
    for (let ring = 0; ring < 28; ring++) {
      let m = 0;
      for (let j = 0; j <= 12; j++) {
        const v = leg.tarsusStart + ring * 13 + j;
        m = Math.max(m, Math.hypot(lp.array[v * 3] - p2[v * 3], lp.array[v * 3 + 1] - p2[v * 3 + 1], lp.array[v * 3 + 2] - p2[v * 3 + 2]));
      }
      prof.push(Number(m.toFixed(5)));
    }
    return prof;
  });
  out.groupQuat = [app.bird.group.quaternion.x, app.bird.group.quaternion.y, app.bird.group.quaternion.z, app.bird.group.quaternion.w];
  out.groupPos = [app.bird.group.position.x, app.bird.group.position.y, app.bird.group.position.z];
  // 直接比较：buildLegs 的踝（世界）转局部 vs bind 算的踝
  const foot = leg.foot;
  out.foot = { alpha: foot.alpha, along: foot.along };
  return out;
});
console.log(JSON.stringify(r, null, 1));
await browser.close();
