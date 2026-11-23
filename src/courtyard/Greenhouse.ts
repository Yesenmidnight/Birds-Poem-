/**
 * 玻璃阳光房（视觉层）：红砖矮墙 + 石压顶、雪松（cedar）立柱 / 檐梁 / 脊梁 / 椽条 / 檩条 / 横梁、
 * 结霜玻璃（墙 / 山墙 / 双坡屋面，南坡留天窗口）、半推开的外开玻璃门、铰链在下沿向上撑起的天窗 + 铁杆、
 * 人字拼红砖地、双层阶梯原木花架、三级阶梯花架、工作木桌 + 清水陶盘、铁艺吊篮 + 链条、脊梁下一串暖光灯泡、
 * 脊 / 檐 / 压顶上的积雪。全部尺寸读 src/pcg/courtyard.ts（GH / GH_DOOR / GH_VENT / GH_FIXTURES）。
 */
import { BoxGeometry, Matrix4, SphereGeometry } from 'three';
import { CONSV, GH, GH_ARCH, GH_DOOR, GH_FIXTURES, GH_POSTS_EAST_Z, GH_VENT, doorLeaf, ghRoofY, ventLid } from '../pcg/courtyard';
import { Batch } from './batch';
import { greenhouseGlassMaterial, paneHash } from './glass';
import type { CourtyardMaterials } from './materials';
import type { LightingUniforms } from '../glsl/lit';

type V3 = [number, number, number];
type Mat = CourtyardMaterials[keyof CourtyardMaterials];

export interface GreenhouseBuild {
  /** 玻璃材质（uTime 给冷凝水痕用）。 */
  glass: ReturnType<typeof greenhouseGlassMaterial>;
}

export function buildGreenhouse(mats: CourtyardMaterials, batch: Batch, lighting: LightingUniforms): GreenhouseBuild {
  const glass = greenhouseGlassMaterial(lighting);
  const nc = { cast: false } as const;
  const { x0, x1, z0, z1, yFloor, yLowWall, yEave, zRidge, wallT, postT } = GH;
  let paneIndex = 0;

  /** 一块玻璃：a→b 沿 u，b→c 沿 v。size = (u 长, v 长) cm。face 0 墙 / 1 屋面。 */
  const pane = (a: V3, b: V3, c: V3, d: V3, size: [number, number], face: number): void => {
    batch.quad('glass', glass, a, b, c, d, { attrs: { aSize: [size[0], size[1]], aPane: [paneHash(paneIndex++)], aFace: [face] }, cast: false, receive: false });
  };
  /** 竖直面上的玻璃：给 u 轴向量、v 轴向量（都是世界向量）和起点。 */
  const paneAxes = (o: V3, u: V3, v: V3, su: number, sv: number, face = 0): void => {
    const p = (fu: number, fv: number): V3 => [o[0] + u[0] * su * fu + v[0] * sv * fv, o[1] + u[1] * su * fu + v[1] * sv * fv, o[2] + u[2] * su * fu + v[2] * sv * fv];
    pane(p(0, 0), p(1, 0), p(1, 1), p(0, 1), [su, sv], face);
  };

  // ── 地板：人字拼红砖（着色器按世界坐标算）+ 门槛石 ──
  batch.quad('floor', mats.herringbone, [x0, yFloor, z0], [x0, yFloor, z1], [x1, yFloor, z1], [x1, yFloor, z0], { cast: false, receive: true, edge: false });
  batch.box('stone', mats.stone, [GH_DOOR.x0 - 5, yFloor - 20, z1 - wallT - 2], [GH_DOOR.x1 + 5, yFloor - 2, z1 + 2], nc);

  // ── 红砖矮墙（南墙留门洞）+ 石压顶 + 薄雪 ──
  const wallSeg = (xa: number, xb: number, za: number, zb: number): void => {
    batch.box('brick', mats.brickWarm, [xa, yFloor - 20, za], [xb, yLowWall, zb]);
    batch.box('stone', mats.stone, [Math.min(xa, xb) - 2, yLowWall, Math.min(za, zb) - 2], [Math.max(xa, xb) + 2, yLowWall + 4, Math.max(za, zb) + 2], nc);
    batch.box('snow', mats.snow, [Math.min(xa, xb) - 1, yLowWall + 4, Math.min(za, zb) - 1], [Math.max(xa, xb) + 1, yLowWall + 5.5, Math.max(za, zb) + 1], { cast: false, receive: false });
  };
  wallSeg(x0, GH_DOOR.x0 - 6, z1 - wallT, z1);
  wallSeg(GH_DOOR.x1 + 6, x1, z1 - wallT, z1);
  wallSeg(x1 - wallT, x1, z0, GH_ARCH.z0 - GH_ARCH.frameT);
  wallSeg(x1 - wallT, x1, GH_ARCH.z1 + GH_ARCH.frameT, z1);
  wallSeg(x0, x0 + wallT, z0, z1);

  // ── 立柱（南墙柱列避开门洞 / 东西山墙柱列）+ 门框柱 ──
  const half = postT / 2;
  for (const px of GH.postsSouthX) {
    const cx = Math.min(x1 - half, Math.max(x0 + half, px));
    batch.box('cedar', mats.cedar, [cx - half, yLowWall, z1 - wallT], [cx + half, yEave, z1 - wallT + postT]);
  }
  for (const pz of GH.baysZ) {
    const cz = Math.min(z1 - half, Math.max(z0 + half, pz));
    batch.box('cedar', mats.cedar, [x0 + wallT - postT, yLowWall, cz - half], [x0 + wallT, yEave, cz + half]);
  }
  for (const pz of GH_POSTS_EAST_Z) {
    const cz = Math.min(z1 - half, Math.max(z0 + half, pz));
    batch.box('cedar', mats.cedar, [x1 - wallT, yLowWall, cz - half], [x1 - wallT + postT, yEave, cz + half]);
  }
  for (const px of [GH_DOOR.x0 - 5, GH_DOOR.x1]) batch.box('cedar', mats.cedar, [px, yLowWall, z1 - wallT], [px + 5, yEave, z1 - wallT + postT]);
  batch.box('cedar', mats.cedar, [GH_DOOR.x0 - 5, GH_DOOR.y1, z1 - wallT], [GH_DOOR.x1 + 5, GH_DOOR.y1 + 8, z1 - wallT + postT]);
  batch.box('cedar', mats.cedar, [GH_DOOR.x0 - 5, yLowWall, z1 - wallT], [GH_DOOR.x0, GH_DOOR.y1 + 8, z1 - wallT + postT]);
  batch.box('cedar', mats.cedar, [GH_DOOR.x1, yLowWall, z1 - wallT], [GH_DOOR.x1 + 5, GH_DOOR.y1 + 8, z1 - wallT + postT]);

  // ── 檐梁 / 脊梁 / 檩条 / 椽条 / 山墙封檐 ──
  batch.box('cedar', mats.cedar, [x0, yEave - 12, z1 - wallT - 2], [x1, yEave, z1 - wallT + 6]);
  batch.box('cedar', mats.cedar, [x0, yEave - 12, z0], [x1, yEave, z0 + wallT + 2]);
  batch.box('cedar', mats.cedar, [x0, GH.yRidge - 14, zRidge - 7], [x1, GH.yRidge, zRidge + 7]);
  for (const pz of [z1 - 100, z0 + 100]) {
    const y = ghRoofY(pz);
    batch.box('cedar', mats.cedar, [x0, y - 10, pz - 3], [x1, y - 4, pz + 3], nc);
  }
  for (const px of GH.baysX) {
    batch.sloped('cedar', mats.cedar, px, yEave - 6, z1, GH.yRidge - 6, zRidge, 6, 8, nc);
    batch.sloped('cedar', mats.cedar, px, yEave - 6, z0, GH.yRidge - 6, zRidge, 6, 8, nc);
  }
  for (const px of [x1 - 7, x0 + 7]) {
    batch.sloped('cedar', mats.cedar, px, yEave - 2, z1, GH.yRidge - 2, zRidge, 8, 10, nc);
    batch.sloped('cedar', mats.cedar, px, yEave - 2, z0, GH.yRidge - 2, zRidge, 8, 10, nc);
  }
  // 横梁（沿 Z）
  for (const tx of GH_FIXTURES.ties) batch.box('cedar', mats.cedar, [tx - 6, GH_FIXTURES.tieY0, z0 + 6], [tx + 6, GH_FIXTURES.tieY1, z1 - 6]);

  // ── 墙玻璃：南墙（门洞 + 亮子）/ 东西山墙（矩形 + 随屋面的梯形）──
  const zg = z1 - 9;
  const rowSplit = 52;
  const southBays: [number, number][] = [[x0, -20], [-20, 20], [20, 30], [116, 125], [125, 220], [220, x1]];
  for (const [a, b] of southBays) {
    if (b - a < 6) continue;
    const xa = a + (a === x0 ? 3 : postT / 2 + 0.5);
    const xb = b - (b === x1 ? 3 : postT / 2 + 0.5);
    for (const [ya, yb] of [
      [yLowWall, rowSplit],
      [rowSplit, yEave],
    ] as const) {
      // 门洞那段只有亮子
      if (a === 20 && ya < GH_DOOR.y1) continue;
      paneAxes([xa, ya + 2, zg], [1, 0, 0], [0, 1, 0], xb - xa, yb - ya - 4);
    }
  }
  // 门洞亮子
  paneAxes([GH_DOOR.x0 + 2, GH_DOOR.y1 + 2, zg], [1, 0, 0], [0, 1, 0], GH_DOOR.x1 - GH_DOOR.x0 - 4, yEave - GH_DOOR.y1 - 4);
  // 东西山墙（东墙中间是通往大植物园的拱门：矮墙 / 玻璃让开，拱顶以上留亮子）
  const gableBays = (east: boolean): [number, number][] => {
    if (!east) return GH.baysZ.slice(0, -1).map((za, i) => [za + (i === 0 ? 3 : half + 0.5), GH.baysZ[i + 1] - (i === GH.baysZ.length - 2 ? 3 : half + 0.5)]);
    const out: [number, number][] = [];
    for (let i = 0; i < GH_POSTS_EAST_Z.length - 1; i++) {
      const za = GH_POSTS_EAST_Z[i] + half + 0.5;
      const zb = GH_POSTS_EAST_Z[i + 1] - half - 0.5;
      if (zb - za < 4) continue;
      out.push([za, zb]);
    }
    return out;
  };
  for (const east of [false, true]) {
    const gx = east ? x1 - 9 : x0 + 9;
    for (const [za0, zb0] of gableBays(east)) {
      // 拱门那一段：下半让开，只留拱顶以上的亮子
      const inArch = east && za0 >= GH_ARCH.z0 - 1 && zb0 <= GH_ARCH.z1 + 1;
      if (inArch) {
        paneAxes([gx, GH_ARCH.yTop + GH_ARCH.r + 3, za0 + 1], [0, 0, 1], [0, 1, 0], zb0 - za0 - 2, yEave - GH_ARCH.yTop - GH_ARCH.r - 5);
        continue;
      }
      const za = za0;
      const zb = zb0;
      for (const [ya, yb] of [
        [yLowWall, rowSplit],
        [rowSplit, yEave],
      ] as const) paneAxes([gx, ya + 2, za], [0, 0, 1], [0, 1, 0], zb - za, yb - ya - 4);
      // 山墙三角：梯形随屋面
      const ha = ghRoofY(za) - 3;
      const hb = ghRoofY(zb) - 3;
      pane([gx, yEave + 1, za], [gx, yEave + 1, zb], [gx, hb, zb], [gx, ha, za], [zb - za, ha - yEave], 0);
    }
  }
  // 拱门框：衬在两墙之间 20 cm 的缝里——两根门帮 + 半圆拱（12 段短木料）+ 石阶
  {
    const ax0 = x1 - wallT - 4;
    const ax1 = CONSV.x0 + CONSV.wallT + 2;
    const zc = (GH_ARCH.z0 + GH_ARCH.z1) / 2;
    for (const az of [GH_ARCH.z0 - GH_ARCH.frameT, GH_ARCH.z1]) batch.box('cedar', mats.cedarWarm, [ax0, yFloor, az], [ax1, GH_ARCH.yTop, az + GH_ARCH.frameT], nc);
    const segs = 12;
    const rMid = GH_ARCH.r + GH_ARCH.frameT / 2;
    for (let i = 0; i < segs; i++) {
      const a = Math.PI + (Math.PI * (i + 0.5)) / segs;
      const mz = Math.cos(a) * rMid;
      const my = GH_ARCH.yTop + Math.sin(a) * rMid;
      const len = 2 * rMid * Math.sin(Math.PI / segs / 2) + 1.5;
      // 盒子的长边沿拱的切向（z-y 平面里），绕 X 轴转
      const m = new Matrix4().makeRotationX(-a - Math.PI / 2);
      m.setPosition((ax0 + ax1) / 2, my, zc + mz);
      batch.geo('cedar', mats.cedarWarm, new BoxGeometry(ax1 - ax0, GH_ARCH.frameT, len), m, nc);
    }
    batch.box('stone', mats.stone, [x1 - 14, yFloor - 18, GH_ARCH.z0], [ax1, yFloor - 8, GH_ARCH.z1], nc);
  }

  // ── 屋面玻璃（南坡留天窗口 / 北坡）──
  const roofRow = (xa: number, xb: number, za: number, zb: number): void => {
    const ya = ghRoofY(za) + 0.5;
    const yb = ghRoofY(zb) + 0.5;
    const len = Math.hypot(zb - za, yb - ya);
    // a→b 沿 x，b→c 沿坡（朝 −z）；uv.y 越大越靠脊
    pane([xa, ya, za], [xb, ya, za], [xb, yb, zb], [xa, yb, zb], [xb - xa, len], 1);
  };
  const bays = GH.baysX;
  for (let i = 0; i < bays.length - 1; i++) {
    const xa = bays[i] + (i === 0 ? 3 : 4);
    const xb = bays[i + 1] - (i === bays.length - 2 ? 3 : 4);
    const isVentBay = bays[i] === GH_VENT.x0 - 30 && bays[i + 1] === GH_VENT.x1 + 30;
    if (isVentBay) {
      roofRow(xa, xb, z1 - 2, GH_VENT.z1 - 5);
      roofRow(xa, GH_VENT.x0 - 4, GH_VENT.z1 - 5, GH_VENT.z0 + 5);
      roofRow(GH_VENT.x1 + 4, xb, GH_VENT.z1 - 5, GH_VENT.z0 + 5);
      roofRow(xa, xb, GH_VENT.z0 + 5, zRidge);
    } else {
      roofRow(xa, xb, z1 - 2, (z1 + zRidge) / 2);
      roofRow(xa, xb, (z1 + zRidge) / 2, zRidge);
    }
    // 北坡
    roofRow(xa, xb, zRidge, (z0 + zRidge) / 2);
    roofRow(xa, xb, (z0 + zRidge) / 2, z0 + 2);
  }

  // ── 天窗：洞口 curb（随坡）+ 盖子（铰链在下沿、向上撑）+ 铁杆 ──
  const v = GH_VENT;
  for (const cx of [v.x0 - 4.5, v.x1 + 4.5]) batch.sloped('cedar', mats.cedar, cx, ghRoofY(v.z1) + 5, v.z1 + 4, ghRoofY(v.z0) + 5, v.z0 - 4, 9, 10, nc);
  batch.sloped('cedar', mats.cedar, (v.x0 + v.x1) / 2, ghRoofY(v.z1 + 4) + 5, v.z1 + 4, ghRoofY(v.z1 - 4) + 5, v.z1 - 4, v.x1 - v.x0 + 18, 10, nc);
  batch.sloped('cedar', mats.cedar, (v.x0 + v.x1) / 2, ghRoofY(v.z0 + 4) + 5, v.z0 + 4, ghRoofY(v.z0 - 4) + 5, v.z0 - 4, v.x1 - v.x0 + 18, 10, nc);
  const lid = ventLid();
  {
    const theta = Math.atan2(lid.dir[1], -lid.dir[2]);
    const len = lid.len;
    const n: V3 = [0, Math.cos(theta), -Math.sin(theta)];
    /** 盖子局部坐标 → 世界：x 沿 X、z 沿盖长（+z 指向自由边）、y 厚度；绕 X 转 theta 后平移到铰链。 */
    const local = (yOff: number, sOff: number): Matrix4 => {
      const m = new Matrix4().makeRotationX(-theta);
      m.setPosition(lid.hinge[0], lid.hinge[1] + lid.dir[1] * sOff + n[1] * yOff, lid.hinge[2] + lid.dir[2] * sOff + n[2] * yOff);
      return m;
    };
    const add = (g: BoxGeometry, yOff: number, sOff: number, key: string, mat: Mat, attrs?: Record<string, number[]>, edge = false): void => batch.geo(key, mat, g, local(yOff, sOff), { ...nc, attrs, edgeFromUv: edge });
    const mk = (w: number, h: number, l: number, x: number, z: number): BoxGeometry => {
      const g = new BoxGeometry(w, h, l);
      g.translate(x, 0, z);
      return g;
    };
    add(mk(5, 5, len, -(v.x1 - v.x0) / 2 + 2.5, len / 2), 0, 0, 'cedar', mats.cedar);
    add(mk(5, 5, len, (v.x1 - v.x0) / 2 - 2.5, len / 2), 0, 0, 'cedar', mats.cedar);
    add(mk(v.x1 - v.x0, 5, 5, 0, len - 2.5), 0, 0, 'cedar', mats.cedar);
    add(mk(v.x1 - v.x0, 5, 5, 0, 2.5), 0, 0, 'cedar', mats.cedar);
    add(mk(3, 4, len, 0, len / 2), 0, 0, 'cedar', mats.cedar);
    add(mk(v.x1 - v.x0 - 8, 1.2, len - 8, 0, len / 2), 0, 0, 'glass', glass, { aSize: [v.x1 - v.x0 - 8, len - 8], aPane: [paneHash(paneIndex++)], aFace: [1] }, true);
    // 盖子上的薄雪（自由边一窄条）
    add(mk(v.x1 - v.x0 - 4, 3, 9, 0, len - 6), 3, 0, 'snow', mats.snow);
  }
  batch.tube('metal', mats.metal, [v.x1 + 4, ghRoofY(v.z1 - 4) + v.curbH + 1, v.z1 - 4], [v.x1 + 4, lid.free[1] - 2, lid.free[2] - 4], 0.7, 6, nc);

  // ── 半推开的外开玻璃门（铰链在西侧门框）──
  {
    const leaf = doorLeaf();
    const a = (GH_DOOR.openDeg * Math.PI) / 180;
    const m = new Matrix4().makeRotationY(-a);
    m.setPosition(leaf.hinge[0], 0, leaf.hinge[2]);
    const L = leaf.len;
    const H = GH_DOOR.y1 - GH_DOOR.y0;
    const mk = (w: number, h: number, d: number, x: number, y: number, z: number, key: string, mat: Mat, attrs?: Record<string, number[]>, edge = false): void => {
      const g = new BoxGeometry(w, h, d);
      g.translate(x + w / 2, GH_DOOR.y0 + y + h / 2, z);
      batch.geo(key, mat, g, m, { cast: true, attrs, edgeFromUv: edge });
    };
    mk(7, H, 4.5, 0, 0, 0, 'cedar', mats.cedar);
    mk(7, H, 4.5, L - 7, 0, 0, 'cedar', mats.cedar);
    mk(L, 14, 4.5, 0, 0, 0, 'cedar', mats.cedar);
    mk(L, 7, 4.5, 0, H - 7, 0, 'cedar', mats.cedar);
    mk(L, 5, 4.5, 0, 46, 0, 'cedar', mats.cedar);
    // 上下两块玻璃：下块 y 14..46、上块 y 51..H − 7（原来把厚度 1.2 写成了高度，门扇只剩两条玻璃薄片）
    mk(L - 14, 32, 1.2, 7, 14, 0, 'glass', glass, { aSize: [L - 14, 32], aPane: [paneHash(paneIndex++)], aFace: [0] }, true);
    mk(L - 14, H - 58, 1.2, 7, 51, 0, 'glass', glass, { aSize: [L - 14, H - 58], aPane: [paneHash(paneIndex++)], aFace: [0] }, true);
    // 把手
    mk(3, 16, 3, L - 14, 58, 3.5, 'metal', mats.metal);
  }

  // ── 双层阶梯原木花架 ──
  const sh = GH_FIXTURES.shelf;
  for (const pz of [sh.z0, (sh.z0 + sh.z1) / 2, sh.z1]) {
    batch.box('pine', mats.pine, [sh.xBack - 6, yFloor, pz - 3], [sh.xBack, sh.tiers[1].y1 + 10, pz + 3], nc);
    batch.box('pine', mats.pine, [sh.tiers[0].x0, yFloor, pz - 3], [sh.tiers[0].x0 + 6, sh.tiers[0].y1, pz + 3], nc);
  }
  for (const tier of sh.tiers) {
    batch.box('pine', mats.pine, [tier.x0, tier.y0, sh.z0], [sh.xBack, tier.y1, sh.z1], nc);
    batch.cyl('pine', mats.pine, tier.x0 + 2, tier.y1 + sh.railR, (sh.z0 + sh.z1) / 2, sh.railR, sh.z1 - sh.z0 - 8, 7, Math.PI / 2, 0, nc);
    batch.box('pine', mats.pine, [tier.x0, tier.y1 + 1, sh.z0 + 4], [tier.x0 + 2, tier.y1 + 5, sh.z1 - 4], nc);
  }
  // ── 三级阶梯花架（天窗正下方）──
  const st = GH_FIXTURES.stand;
  for (const tier of st.tiers) {
    // 每级一块 4 cm 厚的 cedar 板 + 四条 pine 方腿（腿顶进板底 0.5 cm），板与板之间透空——
    // 原来的实心 pine 箱顶面和盖在上面的 cedar 板顶面共面，俯视是一道黑白斑马纹（Z-fighting）
    batch.box('cedar', mats.cedar, [tier.x0, tier.y1 - 4, st.z0], [tier.x1, tier.y1, st.z1], { cast: true });
    for (const [lx, lz] of [
      [tier.x0 + 3, st.z0 + 3],
      [tier.x0 + 3, st.z1 - 3],
      [tier.x1 - 3, st.z0 + 3],
      [tier.x1 - 3, st.z1 - 3],
    ] as const) batch.box('pine', mats.pine, [lx - 2.5, yFloor, lz - 2.5], [lx + 2.5, tier.y1 - 3.5, lz + 2.5], nc);
    batch.box('pine', mats.pine, [tier.x0 + 3, yFloor + 20, st.z0 + 1], [tier.x1 - 3, yFloor + 24, st.z0 + 5], nc);
    batch.box('pine', mats.pine, [tier.x0 + 3, yFloor + 20, st.z1 - 5], [tier.x1 - 3, yFloor + 24, st.z1 - 1], nc);
  }
  // ── 工作木桌 + 清水陶盘 ──
  const tb = GH_FIXTURES.table;
  batch.box('pine', mats.pine, [tb.x0, tb.y0, tb.z0], [tb.x1, tb.y1, tb.z1], { cast: true });
  for (const [lx, lz] of [
    [tb.x0 + 3, tb.z0 + 3],
    [tb.x0 + 3, tb.z1 - 3],
    [tb.x1 - 3, tb.z0 + 3],
    [tb.x1 - 3, tb.z1 - 3],
  ] as const) batch.box('pine', mats.pine, [lx - 2.5, yFloor, lz - 2.5], [lx + 2.5, tb.y0, lz + 2.5], nc);
  batch.box('pine', mats.pine, [tb.x0 + 3, yFloor + 30, tb.z0 + 3], [tb.x1 - 3, yFloor + 34, tb.z1 - 3], nc);
  const d = GH_FIXTURES.dish;
  batch.cyl('terracotta', mats.terracotta, d.x, d.y + 1.5, d.z, d.r, 3, 14, 0, 0, nc);
  batch.cyl('water', mats.water, d.x, d.y + 3.2, d.z, d.r - 2.5, 0.6, 14, 0, 0, { cast: false, receive: false });

  // ── 铁艺吊篮 + 链条 + 脊梁下的暖光灯泡串 ──
  for (const bk of GH_FIXTURES.baskets) {
    const bowl = new SphereGeometry(bk.r, 14, 7, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
    bowl.translate(bk.x, bk.y, bk.z);
    batch.add('cedarWarm', mats.cedarWarm, bowl, undefined, { cast: true });
    batch.cyl('cedarWarm', mats.cedarWarm, bk.x, bk.y + 1, bk.z, bk.r + 1, 2.5, 16, 0, 0, nc);
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2 + 0.4;
      batch.tube('metal', mats.metal, [bk.x + Math.cos(a) * bk.r, bk.y + 2, bk.z + Math.sin(a) * bk.r], [bk.x, GH.yRidge - 14, bk.z], 0.6, 5, nc);
    }
    batch.cyl('metal', mats.metal, bk.x, GH.yRidge - 16, bk.z, 3, 4, 8, 0, 0, nc);
  }
  batch.tube('metal', mats.metal, [x0 + 30, GH.yRidge - 18, zRidge], [x1 - 30, GH.yRidge - 18, zRidge], 0.5, 5, nc);
  for (let i = 0; i < 8; i++) {
    const x = x0 + 50 + i * 48;
    const bulb = new SphereGeometry(2.4, 8, 6);
    bulb.translate(x, GH.yRidge - 23, zRidge);
    batch.add('glow', mats.glow, bulb, undefined, { cast: false, receive: false });
  }

  // ── 积雪：脊 / 南北檐梁 ──
  batch.cyl('snow', mats.snow, (x0 + x1) / 2, GH.yRidge + 4, zRidge, 7, x1 - x0 + 6, 10, 0, Math.PI / 2, { cast: true });
  batch.cyl('snow', mats.snow, (x0 + x1) / 2, yEave + 2, z1 - wallT + 2, 5, x1 - x0 + 4, 8, 0, Math.PI / 2, { cast: true });
  batch.cyl('snow', mats.snow, (x0 + x1) / 2, yEave + 2, z0 + wallT - 2, 5, x1 - x0 + 4, 8, 0, Math.PI / 2, { cast: true });

  return { glass };
}
