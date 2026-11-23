/**
 * 院落设施（视觉层）：围院积雪木栅栏 + 院门、覆雪石板汀步、院落木长椅、弯头暖光路灯、木电线杆（跨院双层电线 2026-11-23 起归 DynamicWires.ts：会沉会弹）。
 * 尺寸全部读 src/pcg/courtyard.ts（FENCE / STONE_PATHS / BENCH / LAMP / POLE / WIRES / snowAt）。
 */
import { CylinderGeometry } from 'three';
import { BENCH, FENCE, HOUSE, LAMP, POLE, STONE_PATHS, WIRES, YARD, snowAt, stoneRadius } from '../pcg/courtyard';
import { makeRng } from '../util/math';
import { Batch } from './batch';
import type { CourtyardMaterials } from './materials';

/** 沿折线铺圆管（电线 / 灯臂）。 */
function polylineTube(batch: Batch, key: string, mat: CourtyardMaterials[keyof CourtyardMaterials], pts: readonly (readonly number[])[], r: number, seg: number): void {
  for (let i = 1; i < pts.length; i++) batch.tube(key, mat, pts[i - 1], pts[i], r, seg, { cast: false });
}

export function buildYard(m: CourtyardMaterials, batch: Batch): void {
  const rng = makeRng(41);
  const nc = { cast: false } as const;

  // ── 栅栏：柱（带雪帽）+ 两道横杆（上杆带雪）+ 院门 ──
  const f = FENCE;
  const postAt = (x: number, z: number): void => {
    const y0 = snowAt(x, z) - 12;
    batch.box('fence', m.fence, [x - f.postT / 2, y0, z - f.postT / 2], [x + f.postT / 2, f.yTop, z + f.postT / 2]);
    // 柱头：小方帽 + 雪团
    batch.box('fence', m.fence, [x - f.postT / 2 - 1.5, f.yTop, z - f.postT / 2 - 1.5], [x + f.postT / 2 + 1.5, f.yTop + 3, z + f.postT / 2 + 1.5], nc);
    batch.cyl('snow', m.snow, x, f.yTop + 5.5, z, 7.5, 5, 8, 0, 0, { cast: false, receive: false });
  };
  const railAlong = (along: 'x' | 'z', fixed: number, s0: number, s1: number): void => {
    for (const ry of f.rails) {
      const b = along === 'x' ? { min: [s0, ry, fixed - f.railT], max: [s1, ry + f.railH, fixed + f.railT] } : { min: [fixed - f.railT, ry, s0], max: [fixed + f.railT, ry + f.railH, s1] };
      batch.box('fence', m.fence, b.min, b.max, nc);
    }
    // 上杆顶面的积雪：略粗的雪条，边缘毛糙靠材质
    const ry = f.rails[0] + f.railH;
    const c = along === 'x' ? [(s0 + s1) / 2, ry + 2.5, fixed] : [fixed, ry + 2.5, (s0 + s1) / 2];
    batch.cyl('snow', m.snow, c[0], c[1], c[2], 5, s1 - s0 - 6, 7, along === 'z' ? Math.PI / 2 : 0, along === 'x' ? Math.PI / 2 : 0, { cast: false, receive: false });
  };
  const g = f.gate;
  railAlong('x', YARD.z1, YARD.x0, g.x0);
  railAlong('x', YARD.z1, g.x1, YARD.x1);
  railAlong('x', YARD.z0, YARD.x0, YARD.x1);
  railAlong('z', YARD.x0, YARD.z0, YARD.z1);
  railAlong('z', YARD.x1, YARD.z0, YARD.z1);
  for (let x = YARD.x0; x <= YARD.x1; x += f.spacing) {
    postAt(x, YARD.z1);
    postAt(x, YARD.z0);
  }
  for (let z = YARD.z0 + f.spacing; z < YARD.z1; z += f.spacing) {
    postAt(YARD.x0, z);
    postAt(YARD.x1, z);
  }
  // 院门：门框 + 5 块竖板 + 两道横带 + 雪（关着）
  for (const px of [g.x0, g.x1]) postAt(px, YARD.z1);
  for (let i = 0; i < 5; i++) {
    const x = g.x0 + 8 + i * ((g.x1 - g.x0 - 16) / 4.5);
    batch.box('fence', m.fence, [x - 6, snowAt(x, YARD.z1) - 4, YARD.z1 - 2.5], [x + 6, f.yTop - 18, YARD.z1 + 2.5], nc);
  }
  for (const ry of [f.yTop - 30, snowAt(0, YARD.z1) + 30]) batch.box('fence', m.fence, [g.x0 + 4, ry - 3, YARD.z1 - 3], [g.x1 - 4, ry + 3, YARD.z1 + 3], nc);
  batch.box('snow', m.snow, [g.x0 + 6, f.yTop - 18, YARD.z1 - 3], [g.x1 - 6, f.yTop - 14, YARD.z1 + 3], { cast: false, receive: false });

  // ── 汀步：覆雪的不规则石板 ──
  let si = 0;
  for (const path of STONE_PATHS) {
    for (const s of path) {
      const r = stoneRadius(si++);
      const y = snowAt(s[0], s[2]);
      const geo = new CylinderGeometry(r, r * 1.02, 7, 9, 1);
      geo.scale(1.0 + rng() * 0.14, 1, 0.92 + rng() * 0.16);
      geo.rotateY(rng() * Math.PI);
      geo.translate(s[0], y + 0.5, s[2]);
      batch.add('stone', m.stone, geo, undefined, { cast: false });
      // 顶面薄雪 + 四周雪沿
      const cap = new CylinderGeometry(r * 0.68, r * 0.74, 1.4, 9, 1);
      cap.rotateY(rng() * Math.PI);
      cap.translate(s[0], y + 3.9, s[2]);
      batch.add('snow', m.snow, cap, undefined, { cast: false, receive: false });
    }
  }

  // ── 长椅：松木座面 + 四腿 + 靠背三道板 + 雪座 ──
  const b = BENCH;
  const by = snowAt((b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2);
  batch.box('pine', m.pine, [b.x0, b.seatY - b.seatT, b.z0], [b.x1, b.seatY, b.z1], { cast: true });
  for (const [lx, lz] of [
    [b.x0 + 4, b.z0 + 6],
    [b.x0 + 4, b.z1 - 6],
    [b.x1 - 4, b.z0 + 6],
    [b.x1 - 4, b.z1 - 6],
  ] as const) batch.box('pine', m.pine, [lx - 3, by - 2, lz - 3], [lx + 3, b.seatY - b.seatT, lz + 3], nc);
  for (const pz of [b.z0 + 4, b.z1 - 4]) batch.box('pine', m.pine, [b.x0, by - 2, pz - 3], [b.x0 + b.backT, b.backTop, pz + 3], nc);
  for (const yy of [-58, -44, b.backTop - 6]) batch.box('pine', m.pine, [b.x0, yy, b.z0], [b.x0 + b.backT, yy + 8, b.z1], nc);
  batch.box('snow', m.snow, [b.x0 + 6, b.seatY, b.z0 + 4], [b.x1 - 3, b.seatY + 4.5, b.z1 - 4], { cast: false, receive: false });
  batch.cyl('snow', m.snow, b.x0 + b.backT / 2, b.backTop + 2.5, (b.z0 + b.z1) / 2, 5.5, b.z1 - b.z0 - 4, 8, Math.PI / 2, 0, { cast: false, receive: false });

  // ── 路灯：基座 + 灯柱 + 弯头 + 铁艺灯笼（暖光）+ 雪帽 ──
  const ly = snowAt(LAMP.x, LAMP.z);
  batch.cyl('metal', m.metal, LAMP.x, ly + 6, LAMP.z, 9, 14, 10, 0, 0);
  batch.cyl('metal', m.metal, LAMP.x, (ly + LAMP.yTop) / 2, LAMP.z, LAMP.postR, LAMP.yTop - ly, 10, 0, 0);
  const ln = LAMP.lantern;
  polylineTube(batch, 'metal', m.metal, [
    [LAMP.x, LAMP.yTop - 10, LAMP.z],
    [LAMP.x - 6, LAMP.yTop + 12, LAMP.z],
    [LAMP.x - 22, LAMP.yTop + 22, LAMP.z],
    [ln.x + 6, LAMP.yTop + 20, LAMP.z],
    [ln.x, LAMP.yTop + 10, LAMP.z],
  ], 2.2, 7);
  // 灯笼：上下铁盘 + 四根立柱 + 发光灯罩 + 顶盖雪
  batch.box('metal', m.metal, [ln.x - ln.w / 2 - 2, ln.y - 3, ln.z - ln.w / 2 - 2], [ln.x + ln.w / 2 + 2, ln.y + 1, ln.z + ln.w / 2 + 2], nc);
  batch.box('metal', m.metal, [ln.x - ln.w / 2 - 3, ln.y + ln.h - 1, ln.z - ln.w / 2 - 3], [ln.x + ln.w / 2 + 3, ln.y + ln.h + 5, ln.z + ln.w / 2 + 3], nc);
  for (const [dx, dz] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ] as const) batch.box('metal', m.metal, [ln.x + dx * ln.w / 2 - 1.2, ln.y, ln.z + dz * ln.w / 2 - 1.2], [ln.x + dx * ln.w / 2 + 1.2, ln.y + ln.h, ln.z + dz * ln.w / 2 + 1.2], nc);
  batch.box('glow', m.glow, [ln.x - ln.w / 2 + 1, ln.y + 1, ln.z - ln.w / 2 + 1], [ln.x + ln.w / 2 - 1, ln.y + ln.h - 1, ln.z + ln.w / 2 - 1], { cast: false, receive: false });
  const capGeo = new CylinderGeometry(2, ln.w / 2 + 4, 9, 4, 1);
  capGeo.rotateY(Math.PI / 4);
  capGeo.translate(ln.x, ln.y + ln.h + 9, ln.z);
  batch.add('metal', m.metal, capGeo, undefined, nc);
  const capSnow = new CylinderGeometry(1, ln.w / 2 + 3, 7, 4, 1);
  capSnow.rotateY(Math.PI / 4);
  capSnow.translate(ln.x, ln.y + ln.h + 14, ln.z);
  batch.add('snow', m.snow, capSnow, undefined, { cast: false, receive: false });

  // ── 电线杆（西南角）：木杆 + 沿 z 的横担 + 瓷瓶 + 雪 ──
  const py = snowAt((POLE.x0 + POLE.x1) / 2, (POLE.z0 + POLE.z1) / 2);
  const pcx = (POLE.x0 + POLE.x1) / 2;
  const pcz = (POLE.z0 + POLE.z1) / 2;
  batch.cyl('pole', m.fence, pcx, (py - 10 + POLE.y1) / 2, pcz, 8, POLE.y1 - py + 10, 12, 0, 0);
  for (const y of POLE.arms) {
    batch.box('pole', m.fence, [pcx - 4, y - 4, pcz - 24], [pcx + 4, y + 4, pcz + 24], nc);
    for (const z of [pcz - 20, pcz + 20]) {
      batch.cyl('metal', m.metal, pcx, y + 8, z, 2.6, 8, 8, 0, 0, nc);
      batch.cyl('snow', m.snow, pcx, y + 4.5, z, 4, 3, 8, 0, 0, { cast: false, receive: false });
    }
    batch.cyl('snow', m.snow, pcx, y + 6, pcz, 4.5, 44, 7, Math.PI / 2, 0, { cast: false, receive: false });
  }
  batch.cyl('snow', m.snow, pcx, POLE.y1 + 3, pcz, 9, 6, 10, 0, 0, { cast: false, receive: false });
  // 跨院双层电线（抛物线垂度，带雪线）：从木杆到洋房西檐口的进户线——2026-11-23 起不再塞进静态合批，
  // 由 DynamicWires.ts 按碰撞层 CurvePerch 的弹簧位移实时改顶点（落上去会沉会弹；以前物理在颤画面是死的）
  // 洋房西山墙檐下的接线钩（静态，连着电线的固定端）
  for (const w of [WIRES.a, WIRES.b]) batch.tube('metal', m.metal, [HOUSE.x0 - 2, w[1] + 6, w[2]], [w[0], w[1], w[2]], 2, 6, nc);
}
