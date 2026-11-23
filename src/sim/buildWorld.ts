/**
 * 布局 → 碰撞体。纯数据进去，SimWorld 出来；画面层不经过这里（它读同一份布局建网格）。
 */
import { interpKeys, noise3 } from '../util/math.ts';
import type { Layout } from '../pcg/layout.ts';
import { BoxSurface } from './boxSurface.ts';
import { CurvePerch } from './curvePerch.ts';
import { Heightfield } from './heightfield.ts';
import { SlopeSurface } from './slopeSurface.ts';
import { flattenPoints, sampleArc } from './spline.ts';
import { SimWorld, type SimWorldOptions } from './world.ts';

/** 一条曲线栖木：弧长等距采样（和画面网格同一段数、同一套采样），半径按采样点序号插值。 */
export function buildCurve(spec: Layout['curves'][number]): CurvePerch {
  const segments = Math.max(1, spec.segments ?? 96);
  const samples = sampleArc(flattenPoints(spec.points), spec.points.length, segments);
  const radii = new Float64Array(samples.count);
  for (let i = 0; i < samples.count; i++) radii[i] = interpKeys(spec.radii, i / segments);
  return new CurvePerch(samples.centers, radii, samples.count, spec.spring ?? null);
}

/** 雪面的高度函数：三个尺度的雪垄叠起来（大起伏、路缘雪堆、风纹），总幅度约等于 drift。 */
export function snowHeight(g: Layout['grounds'][number]): (x: number, z: number) => number {
  const s = g.seed * 7.31;
  return (x, z) => {
    const a = noise3(x / 150, z / 150, s) - 0.5;
    const b = noise3(x / 52 + 7.3, z / 52 + 3.1, s + 1.7) - 0.5;
    const c = noise3(x / 21 + 13.1, z / 21 + 5.7, s + 4.2) - 0.5;
    return g.base + g.drift * (1.15 * a + 0.6 * b + 0.25 * c);
  };
}

export function buildGround(g: Layout['grounds'][number]): Heightfield {
  const field = new Heightfield(g.x0, g.z0, g.x1, g.z1, g.cell);
  field.fill(snowHeight(g));
  for (const m of g.mounds ?? []) field.mound(m.x, m.z, m.height, m.radius);
  return field;
}

/**
 * 表面登记顺序：曲线栖木 → 雪面 → 盒体 → 斜板（调用方按 Layout 的数组下标对回表面时依赖这个顺序）。
 * 曲线先全部建好、悬臂枝（springParent）挂到母枝的振子上，再登记——包围盒要按母枝那一路的振幅一起撑开。
 */
export function buildWorld(layout: Layout, opts?: SimWorldOptions): SimWorld {
  const world = new SimWorld(opts);
  const curves: CurvePerch[] = [];
  for (const c of layout.curves) {
    const perch = buildCurve(c);
    // 悬臂枝焊到母枝上（母枝排在子枝前面，这时已经建好）
    if (c.springParent !== undefined && curves[c.springParent]) perch.linkParent(curves[c.springParent], c.springAt ?? 0);
    curves.push(perch);
  }
  for (const perch of curves) world.add(perch);
  for (const g of layout.grounds) world.add(buildGround(g));
  for (const b of layout.boxes) world.add(new BoxSurface(b.min, b.max));
  for (const s of layout.slopes ?? []) world.add(new SlopeSurface(s.tag, s.axis, s.x0, s.x1, s.z0, s.z1, s.yA, s.yB, s.thick));
  return world;
}
