/**
 * 碰撞调试叠加：把 Layout 的盒体棱边、曲线栖木中心线、两条进出通道画成线框，永远画在最前面。
 * ?debug=1 打开。核对"画面 vs 碰撞体"用。
 */
import { BufferGeometry, Color, Float32BufferAttribute, Group, LineBasicMaterial, LineSegments, type Material } from 'three';
import { CORRIDORS } from '../pcg/courtyard';
import type { Layout, SlopeLayout } from '../pcg/layout';

const TAG_COLOR: Record<string, number> = {
  house: 0xc07bff,
  roof: 0x9d5bff,
  // 覆雪面的碰撞体（顶面 = 视觉雪面）：统一用雪青色
  'roof-snow': 0xdfe9ff,
  'awning-snow': 0xdfe9ff,
  'porch-snow': 0xdfe9ff,
  'balcony-snow': 0xdfe9ff,
  'terrace-snow': 0xdfe9ff,
  'rail-snow': 0xdfe9ff,
  'fence-snow': 0xdfe9ff,
  'gate-snow': 0xdfe9ff,
  'pole-snow': 0xdfe9ff,
  'bench-snow': 0xdfe9ff,
  'step-snow': 0xdfe9ff,
  'gh-snow': 0xdfe9ff,
  'lantern-snow': 0xdfe9ff,
  gable: 0x9d5bff,
  'gh-gable': 0x5ad0ff,
  'chimney-pot': 0xff6a6a,
  sill: 0x7bff5a,
  step: 0xffa23a,
  chimney: 0xff6a6a,
  balcony: 0xffd23a,
  rail: 0xffe24a,
  awning: 0xffa23a,
  porch: 0xffa23a,
  terrace: 0xffd23a,
  flowerbox: 0x7bff5a,
  ac: 0x5ad0ff,
  'gh-floor': 0xff5a4a,
  'gh-wall': 0xff5a4a,
  'gh-glass': 0x5ad0ff,
  'gh-post': 0xffb03a,
  'gh-beam': 0xffb03a,
  'gh-roof': 0x5ad0ff,
  'cv-roof': 0x5ad0ff,
  'cv-gable': 0x5ad0ff,
  'cv-vent': 0xffffff,
  'cv-lid': 0xd0d0d0,
  'cv-wall': 0xff5a4a,
  'cv-glass': 0x5ad0ff,
  'cv-post': 0xffb03a,
  'cv-beam': 0xffb03a,
  'cv-door': 0xff6ad5,
  'cv-rail': 0xffe24a,
  'cv-tie': 0xffb03a,
  'cv-rod': 0xffe24a,
  'trough': 0x5ad0ff,
  'gh-vent': 0xffffff,
  'gh-lid': 0xd0d0d0,
  'gh-door': 0xff6ad5,
  'gh-joint': 0xff6ad5,
  'gh-tie': 0xffb03a,
  'gh-shelf': 0xb0ff5a,
  'gh-stand': 0xb0ff5a,
  'gh-table': 0xb0ff5a,
  'gh-dish': 0xb0ff5a,
  'gh-basket': 0xffe24a,
  pot: 0xff8a3a,
  fence: 0x9dff3a,
  'fence-post': 0x9dff3a,
  gate: 0x9dff3a,
  stone: 0x5ad0ff,
  bench: 0xb0ff5a,
  lamp: 0xffe24a,
  lantern: 0xffe24a,
  pole: 0xff6ad5,
  wire: 0xff5a4a,
  branch: 0xffe24a,
  tree: 0x9dff3a,
  'tree-twig': 0xffb03a,
};

function edgesGeometry(min: readonly number[], max: readonly number[]): number[] {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const c = [
    [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1],
    [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1],
  ];
  const e = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
  const out: number[] = [];
  for (const [a, b] of e) out.push(...c[a], ...c[b]);
  return out;
}

/** 斜板的十二条棱：按 SlopeSurface 同一套角点顺序（底面 0..3、顶面 4..7，范围先整理成从小到大）。 */
function slopeEdges(s: SlopeLayout): number[] {
  let { x0, x1, z0, z1, yA, yB } = s;
  if (x0 > x1) {
    [x0, x1] = [x1, x0];
    if (s.axis === 'x') [yA, yB] = [yB, yA];
  }
  if (z0 > z1) {
    [z0, z1] = [z1, z0];
    if (s.axis === 'z') [yA, yB] = [yB, yA];
  }
  const t = s.thick;
  const hT = s.axis === 'z' ? [yA, yA, yB, yB] : [yA, yB, yB, yA];
  const xs = [x0, x1, x1, x0];
  const zs = [z0, z0, z1, z1];
  const c: number[] = [];
  for (let i = 0; i < 4; i++) c.push(xs[i], hT[i] - t, zs[i]);
  for (let i = 0; i < 4; i++) c.push(xs[i], hT[i], zs[i]);
  const e = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
  const out: number[] = [];
  for (const [a, b] of e) out.push(c[a * 3], c[a * 3 + 1], c[a * 3 + 2], c[b * 3], c[b * 3 + 1], c[b * 3 + 2]);
  return out;
}

export class Overlay {
  readonly group = new Group();

  /**
   * @param skip 这些 tag 的曲线中心线不画进静态线框（电线 / 拉杆：DynamicWires 自己画一条跟着振动的实时中心线，挂进这个组）
   */
  constructor(layout: Layout, skip?: (tag: string) => boolean) {
    this.group.name = 'overlay';
    this.group.visible = false;
    this.group.renderOrder = 50;
    const pos: number[] = [];
    const col: number[] = [];
    for (const b of layout.boxes) {
      const c = new Color(TAG_COLOR[b.tag] ?? 0xffffff);
      const e = edgesGeometry(b.min, b.max);
      for (let i = 0; i < e.length; i += 3) {
        pos.push(e[i], e[i + 1], e[i + 2]);
        col.push(c.r, c.g, c.b);
      }
    }
    // 斜板（屋面 / 雨棚 / 拱面）：按倾斜后的平行六面体画棱
    for (const s of layout.slopes ?? []) {
      const c = new Color(TAG_COLOR[s.tag] ?? 0xffffff);
      const e = slopeEdges(s);
      for (let i = 0; i < e.length; i += 3) {
        pos.push(e[i], e[i + 1], e[i + 2]);
        col.push(c.r, c.g, c.b);
      }
    }
    for (const cu of layout.curves) {
      if (skip?.(cu.tag)) continue;
      const c = new Color(TAG_COLOR[cu.tag] ?? 0xffffff);
      for (let i = 1; i < cu.points.length; i++) {
        pos.push(...cu.points[i - 1], ...cu.points[i]);
        col.push(c.r, c.g, c.b, c.r, c.g, c.b);
      }
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new Float32BufferAttribute(col, 3));
    const mat: Material = new LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85, depthTest: false });
    const lines = new LineSegments(geo, mat);
    lines.renderOrder = 50;
    this.group.add(lines);

    // 通道：粗一点的亮青色 + 落点
    const cp: number[] = [];
    for (const cor of CORRIDORS) {
      const pts = [...cor.points, cor.landing];
      for (let i = 1; i < pts.length; i++) cp.push(...pts[i - 1], ...pts[i]);
      const l = cor.landing;
      for (const d of [[6, 0, 0], [0, 6, 0], [0, 0, 6]]) {
        cp.push(l[0] - d[0], l[1] - d[1], l[2] - d[2], l[0] + d[0], l[1] + d[1], l[2] + d[2]);
      }
    }
    const cgeo = new BufferGeometry();
    cgeo.setAttribute('position', new Float32BufferAttribute(cp, 3));
    const corridorLines = new LineSegments(cgeo, new LineBasicMaterial({ color: 0x40ffff, depthTest: false }));
    corridorLines.renderOrder = 50;
    this.group.add(corridorLines);
    this.group.traverse((o) => {
      o.frustumCulled = false;
    });
  }

  set visible(v: boolean) {
    this.group.visible = v;
  }
}
