/**
 * 仿真层里一切可以落脚、可以撞上的东西的公共接口。
 *
 * 表面是“实心体”的边界：任何一点都能问到“离我最近的表面点在哪、外法线朝哪、有符号距离是多少”。
 * 落脚、碰撞、穿模检查全都只靠这一个查询，不碰任何渲染网格——所以同一套代码能在 Node 里无头跑。
 */
import { Vec3 } from './math.ts';

/** 表面种类（不用 enum：Node 直接跑 .ts 时只认可擦除语法）。 */
export const SURFACE_CURVE = 0;
export const SURFACE_GROUND = 1;
export const SURFACE_BOX = 2;

/** 一次最近点查询的结果。 */
export interface Contact {
  /** 命中的表面；世界里没有表面时为 null。 */
  surface: Surface | null;
  /** 表面上的最近点。 */
  px: number;
  py: number;
  pz: number;
  /** 表面外法线（单位向量）；点在体内时同样指向体外。 */
  nx: number;
  ny: number;
  nz: number;
  /** 有符号距离（厘米）：体外为正、体内为负。 */
  dist: number;
  /**
   * 表面在最近点处沿法线的速度（厘米 / 秒，朝体外为正）：会颤的电线、细枝才有，静止表面为 0。
   * 接触求解按“球相对表面”的速度算反弹和落定，表面自己撞上来时球被正确弹开。
   */
  svel: number;
  /**
   * 表面参数。曲线栖木：u = 从起点起的弧长，v = 环向角（从顶面起算，朝 side 为正）；
   * 雪面：u = x、v = z；盒体：顶面 / 底面上 u = x、v = z，其余面不用。
   */
  u: number;
  v: number;
  /** 盒体的面号（0 顶 1 底 2 −x 3 +x 4 −z 5 +z）；落在棱角上或不是盒体时为 −1。 */
  face: number;
}

export function makeContact(): Contact {
  return { surface: null, px: 0, py: 0, pz: 0, nx: 0, ny: 1, nz: 0, dist: Infinity, svel: 0, u: 0, v: 0, face: -1 };
}

export interface Surface {
  readonly kind: number;
  /** 在 SimWorld 里的编号，add 时分配。 */
  id: number;
  /** 会动的表面（颤动的电线、细枝）：SimWorld 每帧推进它，落定的探针按表面参数跟着它走。 */
  readonly dynamic: boolean;
  /** 表面本身的轴对齐包围盒（不含查询半径）。 */
  readonly min: Vec3;
  readonly max: Vec3;
  /**
   * 点 (px, py, pz) 到表面的最近点。结果写进 out 并返回；没有表面可撞时 out.dist = Infinity。
   * 实现可以用内部暂存，所以不要在调用方递归查询同一个表面。
   * out 的每个字段每次都要写全（调用方复用同一个对象）。
   */
  closest(px: number, py: number, pz: number, out: Contact): Contact;
  /** 表面参数 → 世界坐标的点，再沿外法线偏移 offset（厘米）。盒体只支持顶面。 */
  pointAt(u: number, v: number, offset: number, out: Vec3): Vec3;
}
