/**
 * 盒体：轴对齐的实心长方体——楼体、屋顶、护栏、栏杆、空调外机这些。
 * 日式街角的建筑基本都是正交的，轴对齐盒体够用；斜雨棚、铁楼梯到时再加带旋转的版本。
 */
import { Vec3 } from './math.ts';
import { SURFACE_BOX, type Contact, type Surface } from './surface.ts';

export class BoxSurface implements Surface {
  readonly kind = SURFACE_BOX;
  readonly dynamic = false;
  id = -1;
  readonly min = new Vec3();
  readonly max = new Vec3();

  constructor(min: readonly [number, number, number], max: readonly [number, number, number]) {
    this.min.set(min[0], min[1], min[2]);
    this.max.set(max[0], max[1], max[2]);
  }

  closest(px: number, py: number, pz: number, out: Contact): Contact {
    const mn = this.min;
    const mx = this.max;
    const cx = px < mn.x ? mn.x : px > mx.x ? mx.x : px;
    const cy = py < mn.y ? mn.y : py > mx.y ? mx.y : py;
    const cz = pz < mn.z ? mn.z : pz > mx.z ? mx.z : pz;
    const dx = px - cx;
    const dy = py - cy;
    const dz = pz - cz;
    const d2 = dx * dx + dy * dy + dz * dz;
    // 只有落在顶面 / 底面的范围内，(x, z) 这对参数才有意义
    const onXZ = px > mn.x && px < mx.x && pz > mn.z && pz < mx.z;
    out.surface = this;
    out.svel = 0;
    out.u = px;
    out.v = pz;
    if (d2 > 1e-18) {
      // 体外：先按各轴夹到盒子上，再看是不是正好贴着某一个面
      const d = Math.sqrt(d2);
      const inv = 1 / d;
      out.px = cx;
      out.py = cy;
      out.pz = cz;
      out.nx = dx * inv;
      out.ny = dy * inv;
      out.nz = dz * inv;
      out.dist = d;
      if (onXZ) {
        if (py > mx.y) out.face = 0;
        else if (py < mn.y) out.face = 1;
        else out.face = -1;
      } else out.face = -1;
      return out;
    }
    // 体内：离哪个面最近就选哪个面
    let best = py - mn.y;
    let face = 1;
    if (mx.y - py < best) {
      best = mx.y - py;
      face = 0;
    }
    if (px - mn.x < best) {
      best = px - mn.x;
      face = 2;
    }
    if (mx.x - px < best) {
      best = mx.x - px;
      face = 3;
    }
    if (pz - mn.z < best) {
      best = pz - mn.z;
      face = 4;
    }
    if (mx.z - pz < best) {
      best = mx.z - pz;
      face = 5;
    }
    out.px = px;
    out.py = py;
    out.pz = pz;
    out.nx = 0;
    out.ny = 1;
    out.nz = 0;
    if (face === 0) out.py = mx.y;
    else if (face === 1) {
      out.py = mn.y;
      out.ny = -1;
    } else if (face === 2) {
      out.px = mn.x;
      out.ny = 0;
      out.nx = -1;
    } else if (face === 3) {
      out.px = mx.x;
      out.ny = 0;
      out.nx = 1;
    } else if (face === 4) {
      out.pz = mn.z;
      out.ny = 0;
      out.nz = -1;
    } else {
      out.pz = mx.z;
      out.ny = 0;
      out.nz = 1;
    }
    out.dist = -best;
    out.face = face;
    return out;
  }

  /** 只支持顶面：(u = x, v = z) 处的顶面点，沿 +Y 抬高 offset。 */
  pointAt(u: number, v: number, offset: number, out: Vec3): Vec3 {
    const mn = this.min;
    const mx = this.max;
    out.set(u < mn.x ? mn.x : u > mx.x ? mx.x : u, mx.y + offset, v < mn.z ? mn.z : v > mx.z ? mx.z : v);
    return out;
  }
}
