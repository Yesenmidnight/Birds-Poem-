/**
 * 均匀网格宽相。
 *
 * 每个表面登记进它的包围盒外扩 margin 之后盖到的所有格子；查询只看查询点所在的那一个格子。
 * 只要查询半径不超过 margin，“半径内的表面”的包围盒一定盖到了查询点，也就一定登记在这个格里，
 * 所以一次查表就是完备的候选集，不用遍历邻格。
 * 格子键是三轴格子坐标各 10 位的精确打包：±512 格以内不可能撞键；更远的格子会和 65 m 外的格子
 * 共用一张表，撞了只会多给候选（精确查询会把它筛掉）、不会漏。
 * （别用 imul 常数异或那种散列：对小整数几乎没有混合，负坐标成对相撞，大表面会在一个格子里重复登记。）
 */

/** 每轴的格子数上限（10 位 = 1024 格，偏移后半边各 512 格）。 */
const AXIS_BITS = 10;
const AXIS_HALF = 1 << (AXIS_BITS - 1);
const AXIS_MASK = (1 << AXIS_BITS) - 1;

function cellKey(ix: number, iy: number, iz: number): number {
  return (((ix + AXIS_HALF) & AXIS_MASK) | (((iy + AXIS_HALF) & AXIS_MASK) << AXIS_BITS) | (((iz + AXIS_HALF) & AXIS_MASK) << (2 * AXIS_BITS))) >>> 0;
}

export class Broadphase {
  private readonly cell: number;
  private readonly cells = new Map<number, number[]>();

  constructor(cell: number) {
    this.cell = cell;
  }

  clear(): void {
    this.cells.clear();
  }

  /** 登记一个表面（编号 id），范围是已经外扩过的包围盒。 */
  insert(id: number, minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): void {
    const inv = 1 / this.cell;
    const ix0 = Math.floor(minX * inv);
    const ix1 = Math.floor(maxX * inv);
    const iy0 = Math.floor(minY * inv);
    const iy1 = Math.floor(maxY * inv);
    const iz0 = Math.floor(minZ * inv);
    const iz1 = Math.floor(maxZ * inv);
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iy = iy0; iy <= iy1; iy++) {
        for (let iz = iz0; iz <= iz1; iz++) {
          const key = cellKey(ix, iy, iz);
          let list = this.cells.get(key);
          if (!list) {
            list = [];
            this.cells.set(key, list);
          }
          list.push(id);
        }
      }
    }
  }

  /** 查询点所在格子里的表面编号；空格子返回 null。 */
  cellAt(x: number, y: number, z: number): readonly number[] | null {
    const inv = 1 / this.cell;
    return this.cells.get(cellKey(Math.floor(x * inv), Math.floor(y * inv), Math.floor(z * inv))) ?? null;
  }
}
