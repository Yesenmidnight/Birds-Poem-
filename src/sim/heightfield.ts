/**
 * 雪面：一张节点高度网格（起伏的积雪地面、屋顶雪被）。
 *
 * 高度存在网格上而不是每次现算噪声，是因为雪要被踩变形——爪印、雪槽都是往网格上盖章（stamp），
 * 画面网格和物理查询读的是同一份高度，踩下去的坑才对得上。
 * 表面是双线性插值的，法线用中心差分求；最近点从竖直投影起步、沿切向投影向真实垂足迭代，
 * 平面一步到位，缓坡上两三步收敛到 1e-4 cm 以内。
 * 实心部分是网格范围内、最低节点以上、雪面以下的一整块；范围外的点离得最近的是板的边缘。
 */
import { Vec3 } from './math.ts';
import { SURFACE_GROUND, type Contact, type Surface } from './surface.ts';

export class Heightfield implements Surface {
  readonly kind = SURFACE_GROUND;
  readonly dynamic = false;
  id = -1;
  readonly min = new Vec3();
  readonly max = new Vec3();
  /** 原点（第一个节点）与单元数、单元边长（厘米）。 */
  readonly x0: number;
  readonly z0: number;
  readonly nx: number;
  readonly nz: number;
  readonly cell: number;
  /** 节点高度：(nx + 1) × (nz + 1)，index = iz * (nx + 1) + ix。 */
  readonly heights: Float64Array;
  private readonly eps: number;

  constructor(x0: number, z0: number, x1: number, z1: number, cell: number) {
    this.x0 = x0;
    this.z0 = z0;
    this.cell = cell;
    this.nx = Math.max(1, Math.ceil((x1 - x0) / cell));
    this.nz = Math.max(1, Math.ceil((z1 - z0) / cell));
    this.heights = new Float64Array((this.nx + 1) * (this.nz + 1));
    this.eps = Math.max(0.25, cell * 0.5);
    this.min.set(x0, 0, z0);
    this.max.set(x0 + this.nx * cell, 0, z0 + this.nz * cell);
  }

  /** 用高度函数填满所有节点，并更新包围盒的竖直范围。 */
  fill(height: (x: number, z: number) => number): void {
    const w = this.nx + 1;
    let lo = Infinity;
    let hi = -Infinity;
    for (let iz = 0; iz <= this.nz; iz++) {
      for (let ix = 0; ix <= this.nx; ix++) {
        const h = height(this.x0 + ix * this.cell, this.z0 + iz * this.cell);
        this.heights[iz * w + ix] = h;
        if (h < lo) lo = h;
        if (h > hi) hi = h;
      }
    }
    this.min.y = lo;
    this.max.y = hi;
  }

  /** (x, z) 处的雪面高度；范围外钳制到边缘（只用于采样取值；碰撞体本身到边缘为止）。 */
  heightAt(x: number, z: number): number {
    let fx = (x - this.x0) / this.cell;
    let fz = (z - this.z0) / this.cell;
    fx = fx < 0 ? 0 : fx > this.nx ? this.nx : fx;
    fz = fz < 0 ? 0 : fz > this.nz ? this.nz : fz;
    const ix = Math.min(Math.floor(fx), this.nx - 1);
    const iz = Math.min(Math.floor(fz), this.nz - 1);
    const tx = fx - ix;
    const tz = fz - iz;
    const h = this.heights;
    const w = this.nx + 1;
    const k = iz * w + ix;
    return (h[k] * (1 - tx) + h[k + 1] * tx) * (1 - tz) + (h[k + w] * (1 - tx) + h[k + w + 1] * tx) * tz;
  }

  /**
   * 在雪面上盖章（爪印、雪槽）：以 (x, z) 为中心压下一个边缘平滑的坑。
   * 返回这一下实际压到的最大深度（厘米）；坑是往下加的，反复踩会越踩越深，由调用方控制。
   */
  stamp(x: number, z: number, depth: number, radius: number): number {
    const w = this.nx + 1;
    const ix0 = Math.max(0, Math.floor((x - radius - this.x0) / this.cell));
    const ix1 = Math.min(this.nx, Math.ceil((x + radius - this.x0) / this.cell));
    const iz0 = Math.max(0, Math.floor((z - radius - this.z0) / this.cell));
    const iz1 = Math.min(this.nz, Math.ceil((z + radius - this.z0) / this.cell));
    const invR2 = 1 / (radius * radius);
    let applied = 0;
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const dx = this.x0 + ix * this.cell - x;
        const dz = this.z0 + iz * this.cell - z;
        const q = (dx * dx + dz * dz) * invR2;
        if (q >= 1) continue;
        const k = depth * (1 - q) * (1 - q);
        this.heights[iz * w + ix] -= k;
        if (k > applied) applied = k;
        if (this.heights[iz * w + ix] < this.min.y) this.min.y = this.heights[iz * w + ix];
      }
    }
    return applied;
  }

  /**
   * 在雪面上堆一个雪丘（树干根部、墙角被风堆起来的雪）：以 (x, z) 为中心、边缘平滑地抬高 height（厘米）。
   * 和 stamp 对称：stamp 踩下去，mound 堆起来。
   */
  mound(x: number, z: number, height: number, radius: number): void {
    const w = this.nx + 1;
    const ix0 = Math.max(0, Math.floor((x - radius - this.x0) / this.cell));
    const ix1 = Math.min(this.nx, Math.ceil((x + radius - this.x0) / this.cell));
    const iz0 = Math.max(0, Math.floor((z - radius - this.z0) / this.cell));
    const iz1 = Math.min(this.nz, Math.ceil((z + radius - this.z0) / this.cell));
    const invR2 = 1 / (radius * radius);
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const dx = this.x0 + ix * this.cell - x;
        const dz = this.z0 + iz * this.cell - z;
        const q = (dx * dx + dz * dz) * invR2;
        if (q >= 1) continue;
        const k = iz * w + ix;
        this.heights[k] += height * (1 - q) * (1 - q);
        if (this.heights[k] > this.max.y) this.max.y = this.heights[k];
      }
    }
  }

  closest(px: number, py: number, pz: number, out: Contact): Contact {
    // 雪面是一块有限的板：垂足始终钳在网格范围内，范围外的点看到的是板的边缘，不是无限延长的虚拟雪面——
    // 这样包围盒才是这块板的诚实下界，宽相预筛才成立
    const maxX = this.x0 + this.nx * this.cell;
    const maxZ = this.z0 + this.nz * this.cell;
    const clampX = (v: number) => (v < this.x0 ? this.x0 : v > maxX ? maxX : v);
    const clampZ = (v: number) => (v < this.z0 ? this.z0 : v > maxZ ? maxZ : v);
    let qx = clampX(px);
    let qz = clampZ(pz);
    let qy = this.heightAt(qx, qz);
    let nx = 0;
    let ny = 1;
    let nz = 0;
    // 每步在曲面上的水平位移封顶：离面很远的点一步要挪出很远（远超雪垄的曲率半径），
    // 不封顶会跳到别的雪垄上、距离函数出现跳变。近处的点一步就到位，不受影响；
    // 离面 40 cm 的点要五六步，所以上限放到 16 步
    const cap = 8 * this.eps;
    for (let k = 0; k < 16; k++) {
      const e = this.eps;
      const gx = (this.heightAt(qx + e, qz) - this.heightAt(qx - e, qz)) / (2 * e);
      const gz = (this.heightAt(qx, qz + e) - this.heightAt(qx, qz - e)) / (2 * e);
      const inv = 1 / Math.sqrt(gx * gx + 1 + gz * gz);
      nx = -gx * inv;
      ny = inv;
      nz = -gz * inv;
      // 垂足条件：(p − q) 沿法线，切向分量为零。每步把 q 沿切向分量的水平部分挪过去再贴回曲面，
      // 平面一步到位。点在雪里时切向分量指向下坡，挪的正是该去的方向
      const rx = px - qx;
      const ry = py - qy;
      const rz = pz - qz;
      const rn = rx * nx + ry * ny + rz * nz;
      let sx = rx - rn * nx;
      let sz = rz - rn * nz;
      const sl = Math.sqrt(sx * sx + sz * sz);
      if (sl < 1e-7) break;
      if (sl > cap) {
        sx *= cap / sl;
        sz *= cap / sl;
      }
      qx = clampX(qx + sx);
      qz = clampZ(qz + sz);
      qy = this.heightAt(qx, qz); // 重新贴回曲面
    }
    let dx = px - qx;
    let dy = py - qy;
    let dz = pz - qz;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    // 板是实心的：网格范围内、不低于最低的节点、且低于查询点正下方的雪面，才算在体内。
    // 实心部分必须完全落在包围盒里（最低节点以下算板外），SimWorld.closest 用包围盒距离当下界剪枝才成立
    const inside = px >= this.x0 && px <= maxX && pz >= this.z0 && pz <= maxZ && py >= this.min.y && py < this.heightAt(px, pz);
    if (len > 1e-9 && Math.abs((dx * nx + dy * ny + dz * nz) / len - 1) > 1e-6) {
      // (p − q) 不沿曲面法线：垂足卡在板的边缘（或者离得太远没走到），像盒体的棱角一样取 (p − q) 的方向当法线
      // （体内则反向），保证 |p − q| = |dist|、(p − q) 沿法线
      const inv = (inside ? -1 : 1) / len;
      nx = dx * inv;
      ny = dy * inv;
      nz = dz * inv;
    }
    out.surface = this;
    out.svel = 0;
    out.px = qx;
    out.py = qy;
    out.pz = qz;
    out.nx = nx;
    out.ny = ny;
    out.nz = nz;
    out.dist = inside ? -len : len;
    out.u = qx;
    out.v = qz;
    out.face = -1;
    return out;
  }

  /** (u = x, v = z) 处的雪面点，竖直抬高 offset（厘米）。 */
  pointAt(u: number, v: number, offset: number, out: Vec3): Vec3 {
    out.set(u, this.heightAt(u, v) + offset, v);
    return out;
  }
}
