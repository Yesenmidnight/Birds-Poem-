/**
 * 斜板：沿 X 或沿 Z 倾斜的连续有厚板——双坡屋面、雨棚、玻璃斜顶、折线拱面的每一段、天窗的随坡 curb。
 *
 * 以前用一排阶梯薄盒逼近斜面：每级台阶是一道 7~35 cm 的竖直立面（山雀一跳只有 2~4 cm 高，落在屋顶上根本走不动），
 * 相邻薄盒之间还会留缝。这里换成一块真正的平行六面体：顶面是倾斜平面（法线 ny > 0）、底面与它平行、
 * 四个侧面是竖直矩形或跟坡面平行的平行四边形；任何位置都问得出精确的最近点、有符号距离和面号。
 *
 * 种类号沿用 SURFACE_BOX：对飞行 / 巡航 / 步态来说它就是一块实心板——平面触地即落、能踩着急刹滑雪、
 * 挡路时按“楼”越过屋顶（autopilot 看 kind === 2）。Contact.face 沿用盒体编号（0 顶 1 底 2 −x 3 +x 4 −z 5 +z），
 * u / v 在所有面上都是世界 x / z（和盒体顶面一致）。
 *
 * 厚度按竖直量（底面 = 顶面下移 thick），和画面层 slab 的 roofThick 同一定义。
 * 最近点：体内时离哪张面的平面最近就选它（凸多面体内点到边界的最近点一定是这张面上的垂足）；
 * 体外时只可能在“有符号距离 ≥ 0”的面上——逐面把点投到面上，垂足落在面内就是它，否则取面四条边上线段的最近点。
 */
import { Vec3 } from './math.ts';
import { SURFACE_BOX, type Contact, type Surface } from './surface.ts';

/** 倾斜方向：'z' = 顶面高度随 z 变化（脊沿 X 的双坡顶）；'x' = 随 x 变化。 */
export type SlopeAxis = 'x' | 'z';

export class SlopeSurface implements Surface {
  readonly kind = SURFACE_BOX;
  readonly dynamic = false;
  id = -1;
  readonly min = new Vec3();
  readonly max = new Vec3();
  readonly tag: string;
  readonly axis: SlopeAxis;
  readonly x0: number;
  readonly x1: number;
  readonly z0: number;
  readonly z1: number;
  /** 倾斜轴起点 / 终点处的顶面高度（axis = 'z' 时是 z0 / z1 处；'x' 时是 x0 / x1 处）。 */
  readonly yA: number;
  readonly yB: number;
  readonly thick: number;

  /** 顶面单位外法线。 */
  private readonly nx: number;
  private readonly ny: number;
  private readonly nz: number;
  /** 六张面：单位外法线 (18) + 平面常数 (6) + 每面四个顶点按从外侧看逆时针 (72)。面号顺序同盒体。 */
  private readonly fn = new Float64Array(18);
  private readonly fd = new Float64Array(6);
  private readonly fv = new Float64Array(72);

  constructor(tag: string, axis: SlopeAxis, x0: number, x1: number, z0: number, z1: number, yA: number, yB: number, thick: number) {
    this.tag = tag;
    this.axis = axis;
    // 范围按从小到大整理；斜轴方向反了就连同两端的高度一起对调
    if (x0 > x1) {
      const t = x0;
      x0 = x1;
      x1 = t;
      if (axis === 'x') {
        const ty = yA;
        yA = yB;
        yB = ty;
      }
    }
    if (z0 > z1) {
      const t = z0;
      z0 = z1;
      z1 = t;
      if (axis === 'z') {
        const ty = yA;
        yA = yB;
        yB = ty;
      }
    }
    this.x0 = x0;
    this.x1 = x1;
    this.z0 = z0;
    this.z1 = z1;
    this.yA = yA;
    this.yB = yB;
    this.thick = thick;
    const k = axis === 'z' ? (yB - yA) / (z1 - z0) : (yB - yA) / (x1 - x0);
    const inv = 1 / Math.sqrt(1 + k * k);
    // 顶面外法线：板面朝低的一侧翘起
    if (axis === 'z') {
      this.nx = 0;
      this.ny = inv;
      this.nz = -k * inv;
    } else {
      this.nx = -k * inv;
      this.ny = inv;
      this.nz = 0;
    }
    this.min.set(x0, Math.min(yA, yB) - thick, z0);
    this.max.set(x1, Math.max(yA, yB), z1);
    this.buildFaces();
  }

  /** 倾斜轴上某处（axis = 'z' 传 z，'x' 传 x）的顶面高度。 */
  topY(at: number): number {
    if (this.axis === 'z') return this.yA + ((this.yB - this.yA) * (at - this.z0)) / (this.z1 - this.z0);
    return this.yA + ((this.yB - this.yA) * (at - this.x0)) / (this.x1 - this.x0);
  }

  /** 底面在倾斜轴上某处的高度。 */
  bottomY(at: number): number {
    return this.topY(at) - this.thick;
  }

  /**
   * 八个角点 + 六张面。角点顺序两种倾斜轴都一样：(x0,z0) (x1,z0) (x1,z1) (x0,z1)，0..3 底面、4..7 顶面；
   * 沿 z 倾斜时 z1 端两个角是 yB，沿 x 倾斜时 x1 端两个角是 yB。面顶点顺序再按解析法线校准一次。
   */
  private buildFaces(): void {
    const { x0, x1, z0, z1, yA, yB, thick } = this;
    const bA = yA - thick;
    const bB = yB - thick;
    const hB = this.axis === 'z' ? [bA, bA, bB, bB] : [bA, bB, bB, bA];
    const hT = this.axis === 'z' ? [yA, yA, yB, yB] : [yA, yB, yB, yA];
    const c = [x0, hB[0], z0, x1, hB[1], z0, x1, hB[2], z1, x0, hB[3], z1, x0, hT[0], z0, x1, hT[1], z0, x1, hT[2], z1, x0, hT[3], z1];
    // 面顶点（角点下标）：顶 / 底 / −x / +x / −z / +z
    const faces: [number, number, number, number][] = [
      [4, 7, 6, 5],
      [0, 1, 2, 3],
      [0, 3, 7, 4],
      [1, 5, 6, 2],
      [0, 4, 5, 1],
      [3, 2, 6, 7],
    ];
    const fn = this.fn;
    const fd = this.fd;
    const fv = this.fv;
    for (let f = 0; f < 6; f++) {
      let nx = 0;
      let ny = 0;
      let nz = 0;
      if (f === 0) {
        nx = this.nx;
        ny = this.ny;
        nz = this.nz;
      } else if (f === 1) {
        nx = -this.nx;
        ny = -this.ny;
        nz = -this.nz;
      } else if (f === 2) nx = -1;
      else if (f === 3) nx = 1;
      else if (f === 4) nz = -1;
      else nz = 1;
      const v = faces[f];
      const ax = c[v[1] * 3] - c[v[0] * 3];
      const ay = c[v[1] * 3 + 1] - c[v[0] * 3 + 1];
      const az = c[v[1] * 3 + 2] - c[v[0] * 3 + 2];
      const bx = c[v[2] * 3] - c[v[0] * 3];
      const by = c[v[2] * 3 + 1] - c[v[0] * 3 + 1];
      const bz = c[v[2] * 3 + 2] - c[v[0] * 3 + 2];
      const gx = ay * bz - az * by;
      const gy = az * bx - ax * bz;
      const gz = ax * by - ay * bx;
      const flip = gx * nx + gy * ny + gz * nz < 0;
      for (let i = 0; i < 4; i++) {
        const vi = v[flip ? 3 - i : i];
        fv[f * 12 + i * 3] = c[vi * 3];
        fv[f * 12 + i * 3 + 1] = c[vi * 3 + 1];
        fv[f * 12 + i * 3 + 2] = c[vi * 3 + 2];
      }
      fn[f * 3] = nx;
      fn[f * 3 + 1] = ny;
      fn[f * 3 + 2] = nz;
      fd[f] = nx * fv[f * 12] + ny * fv[f * 12 + 1] + nz * fv[f * 12 + 2];
    }
  }

  closest(px: number, py: number, pz: number, out: Contact): Contact {
    const fn = this.fn;
    const fd = this.fd;
    // 1. 六张面的有符号距离（体外为正）：最大值 ≤ 0 就在体内
    let best = -Infinity;
    let bi = 0;
    for (let f = 0; f < 6; f++) {
      const s = fn[f * 3] * px + fn[f * 3 + 1] * py + fn[f * 3 + 2] * pz - fd[f];
      if (s > best) {
        best = s;
        bi = f;
      }
    }
    out.surface = this;
    out.svel = 0;
    if (best <= 0) {
      const nx = fn[bi * 3];
      const ny = fn[bi * 3 + 1];
      const nz = fn[bi * 3 + 2];
      out.px = px - best * nx;
      out.py = py - best * ny;
      out.pz = pz - best * nz;
      out.nx = nx;
      out.ny = ny;
      out.nz = nz;
      out.dist = best;
      out.u = out.px;
      out.v = out.pz;
      out.face = bi;
      return out;
    }
    // 2. 体外：候选面只可能是有符号距离 ≥ 0 的那些
    const fv = this.fv;
    let bestD2 = Infinity;
    let bqx = 0;
    let bqy = 0;
    let bqz = 0;
    let bface = 0;
    for (let f = 0; f < 6; f++) {
      const nx = fn[f * 3];
      const ny = fn[f * 3 + 1];
      const nz = fn[f * 3 + 2];
      const s = nx * px + ny * py + nz * pz - fd[f];
      if (s < 0) continue;
      // 投到面上
      const qx = px - s * nx;
      const qy = py - s * ny;
      const qz = pz - s * nz;
      let inside = true;
      for (let e = 0; e < 4; e++) {
        const a = f * 12 + e * 3;
        const b = f * 12 + ((e + 1) & 3) * 3;
        // (b − a) × (q − a) · n ≥ 0：从外侧看顶点逆时针，垂足在左侧就是在面内
        const ex = fv[b] - fv[a];
        const ey = fv[b + 1] - fv[a + 1];
        const ez = fv[b + 2] - fv[a + 2];
        const wx = qx - fv[a];
        const wy = qy - fv[a + 1];
        const wz = qz - fv[a + 2];
        const cx = ey * wz - ez * wy;
        const cy = ez * wx - ex * wz;
        const cz = ex * wy - ey * wx;
        if (cx * nx + cy * ny + cz * nz < -1e-9) {
          inside = false;
          break;
        }
      }
      if (inside) {
        const d2 = s * s;
        if (d2 < bestD2) {
          bestD2 = d2;
          bqx = qx;
          bqy = qy;
          bqz = qz;
          bface = f;
        }
        continue;
      }
      // 垂足在面外：取四条边上线段的最近点
      for (let e = 0; e < 4; e++) {
        const a = f * 12 + e * 3;
        const b = f * 12 + ((e + 1) & 3) * 3;
        const ex = fv[b] - fv[a];
        const ey = fv[b + 1] - fv[a + 1];
        const ez = fv[b + 2] - fv[a + 2];
        const len2 = ex * ex + ey * ey + ez * ez;
        let t = len2 > 1e-18 ? ((px - fv[a]) * ex + (py - fv[a + 1]) * ey + (pz - fv[a + 2]) * ez) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx2 = fv[a] + ex * t;
        const qy2 = fv[a + 1] + ey * t;
        const qz2 = fv[a + 2] + ez * t;
        const dx = px - qx2;
        const dy = py - qy2;
        const dz = pz - qz2;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < bestD2) {
          bestD2 = d2;
          bqx = qx2;
          bqy = qy2;
          bqz = qz2;
          bface = f;
        }
      }
    }
    const d = Math.sqrt(bestD2);
    const inv = d > 1e-9 ? 1 / d : 0;
    out.px = bqx;
    out.py = bqy;
    out.pz = bqz;
    out.nx = (px - bqx) * inv;
    out.ny = (py - bqy) * inv;
    out.nz = (pz - bqz) * inv;
    if (inv === 0) out.ny = 1;
    out.dist = d;
    out.u = bqx;
    out.v = bqz;
    out.face = bface;
    return out;
  }

  /**
   * 顶面上 (u = x, v = z) 处的点（范围外钳到板边），再沿顶面法线偏移 offset（厘米）。
   * 和盒体的差别：盒体沿 +Y 抬，这里沿倾斜的外法线抬——落在斜坡上的东西是顺着法线离开面的。
   */
  pointAt(u: number, v: number, offset: number, out: Vec3): Vec3 {
    const x = u < this.x0 ? this.x0 : u > this.x1 ? this.x1 : u;
    const z = v < this.z0 ? this.z0 : v > this.z1 ? this.z1 : v;
    const y = this.topY(this.axis === 'z' ? z : x);
    out.set(x + this.nx * offset, y + this.ny * offset, z + this.nz * offset);
    return out;
  }
}
