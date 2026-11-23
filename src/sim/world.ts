/**
 * 仿真世界：所有表面的集合 + 宽相。物理和落脚只通过这里问“哪儿有东西”，不认识任何渲染网格。
 */
import { GRAVITY } from './math.ts';
import { Broadphase } from './broadphase.ts';
import { CurvePerch } from './curvePerch.ts';
import { makeContact, type Contact, type Surface } from './surface.ts';

export interface SimWorldOptions {
  /**
   * 查询半径上限（厘米）：表面登记进宽相时包围盒外扩这么多，query 的半径不能超过它，closest 超过它返回空。
   * 鸟的碰撞球、脚爪落点都在 32 cm 以内；更远的栖点搜索另走按布局建的索引，不走碰撞宽相。
   * 越大候选越多：树冠里每个点都离几十根枝条的包围盒不远，查询时间近似随它线性涨。
   */
  margin?: number;
  /** 重力加速度（厘米 / 秒²）。 */
  gravity?: number;
}

function copyContact(from: Contact, to: Contact): void {
  to.surface = from.surface;
  to.px = from.px;
  to.py = from.py;
  to.pz = from.pz;
  to.nx = from.nx;
  to.ny = from.ny;
  to.nz = from.nz;
  to.dist = from.dist;
  to.svel = from.svel;
  to.u = from.u;
  to.v = from.v;
  to.face = from.face;
}

/** 点到轴对齐包围盒的距离的平方（在盒内为 0）。到表面的距离一定不小于它。 */
function boxDistanceSq(s: Surface, px: number, py: number, pz: number): number {
  const dx = Math.max(0, s.min.x - px, px - s.max.x);
  const dy = Math.max(0, s.min.y - py, py - s.max.y);
  const dz = Math.max(0, s.min.z - pz, pz - s.max.z);
  return dx * dx + dy * dy + dz * dz;
}

export class SimWorld {
  readonly surfaces: Surface[] = [];
  readonly gravity: number;
  /** 查询半径上限（厘米）：表面登记进宽相时包围盒外扩这么多，离所有表面都比它远的点 closest 查不到东西。 */
  readonly margin: number;
  private readonly grid: Broadphase;
  private readonly dynamic: CurvePerch[] = [];
  // 两个轮换的暂存：a 里始终放着目前最近的那个接触
  private readonly hitA = makeContact();
  private readonly hitB = makeContact();
  // closest 的候选筛选暂存：每个候选到包围盒的距离平方
  private bounds = new Float64Array(64);

  constructor(opts: SimWorldOptions = {}) {
    this.margin = opts.margin ?? 32;
    this.gravity = opts.gravity ?? GRAVITY;
    this.grid = new Broadphase(this.margin * 2);
  }

  add<T extends Surface>(surface: T): T {
    surface.id = this.surfaces.length;
    this.surfaces.push(surface);
    const m = this.margin;
    const a = surface.min;
    const b = surface.max;
    this.grid.insert(surface.id, a.x - m, a.y - m, a.z - m, b.x + m, b.y + m, b.z + m);
    if (surface instanceof CurvePerch && surface.dynamic) this.dynamic.push(surface);
    return surface;
  }

  /**
   * 离 (px, py, pz) 最近的表面。离所有表面都超过 margin 时 surface = null、dist = Infinity——
   * 调用方只看 surface 就知道“够不着”。点在实心体内时 dist < 0，一定返回。
   */
  closest(px: number, py: number, pz: number, out: Contact = makeContact()): Contact {
    const ids = this.grid.cellAt(px, py, pz);
    out.surface = null;
    out.dist = Infinity;
    if (!ids) return out;
    const surfaces = this.surfaces;
    const n = ids.length;
    if (this.bounds.length < n) this.bounds = new Float64Array(n * 2);
    const bounds = this.bounds;
    // 候选先用“到包围盒的距离”筛：它是到表面距离的下界，超过目前最近的所有表面都不可能更近，不用精确查询。
    // 先对下界最小的那个做精确查询，拿到一个尽量紧的上界
    let lo = 0;
    let loD = Infinity;
    for (let i = 0; i < n; i++) {
      const d = boxDistanceSq(surfaces[ids[i]], px, py, pz);
      bounds[i] = d;
      if (d < loD) {
        loD = d;
        lo = i;
      }
    }
    let a = this.hitA;
    let b = this.hitB;
    a.dist = Infinity;
    surfaces[ids[lo]].closest(px, py, pz, a);
    for (let i = 0; i < n; i++) {
      if (i === lo || bounds[i] > a.dist * a.dist) continue;
      const s = surfaces[ids[i]];
      s.closest(px, py, pz, b);
      if (b.dist < a.dist) {
        const t = a;
        a = b;
        b = t;
      }
    }
    // 会动的表面包围盒被振幅撑大了，格子里的候选可能有比 margin 还远的：那种等于没有
    if (a.surface && a.dist > this.margin) return out;
    if (a.surface) copyContact(a, out);
    return out;
  }

  /**
   * 表面离 (px, py, pz) 不超过 radius（厘米，不超过 margin）的所有接触，写进 out（按距离从近到远），返回个数。
   * “不超过”按 |dist| 算：点在实心体内 20 cm 深也算表面在 20 cm 外。要把点推出体外用 closest。
   * out 里不够的位置会就地新建，调用方可以一直复用同一个数组。
   */
  query(px: number, py: number, pz: number, radius: number, out: Contact[]): number {
    const ids = this.grid.cellAt(px, py, pz);
    if (!ids) return 0;
    const limit = Math.min(radius, this.margin);
    const limitSq = limit * limit;
    let n = 0;
    for (let i = 0; i < ids.length; i++) {
      const s = this.surfaces[ids[i]];
      // 先用包围盒粗筛（到包围盒的距离 ≤ 到表面的距离），省掉绝大多数精确查询
      if (boxDistanceSq(s, px, py, pz) > limitSq) continue;
      const slot = out[n] ?? (out[n] = makeContact());
      s.closest(px, py, pz, slot);
      if (Math.abs(slot.dist) <= limit) n++;
    }
    // 候选很少（个位数），插入排序就够
    for (let i = 1; i < n; i++) {
      const c = out[i];
      let j = i - 1;
      while (j >= 0 && out[j].dist > c.dist) {
        out[j + 1] = out[j];
        j--;
      }
      out[j + 1] = c;
    }
    return n;
  }

  /** 推进会动的表面（电线、细枝的颤动）。有 ProbeSet 时由它的 step 代劳，和球同一个节拍。 */
  advance(dt: number): void {
    for (let i = 0; i < this.dynamic.length; i++) this.dynamic[i].advance(dt);
  }

  /** 带弹簧的曲线栖木（按登记顺序：母枝在前、子枝在后）：画面层每帧从里面挑正在晃的几根写进顶点着色器的活跃枝槽位。 */
  get dynamicSurfaces(): readonly CurvePerch[] {
    return this.dynamic;
  }
}
