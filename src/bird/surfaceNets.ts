/**
 * Naive Surface Nets：把有符号距离场多边形化。
 * 每个穿过等值面的网格单元取一个顶点（各棱交点的平均），
 * 每条符号变化的网格棱把周围四个单元的顶点连成一个四边形。
 * 相比 Marching Cubes，三角面更均匀、细长三角形更少，法线也更平滑。
 */

export interface SurfaceNetsResult {
  positions: Float32Array;
  indices: Uint32Array;
  cellCount: number;
}

const // 立方体八个角
  CX = [0, 1, 0, 1, 0, 1, 0, 1],
  CY = [0, 0, 1, 1, 0, 0, 1, 1],
  CZ = [0, 0, 0, 0, 1, 1, 1, 1];
const // 十二条棱（角编号）
  EA = [0, 1, 2, 3, 4, 5, 6, 7, 0, 1, 2, 3],
  EB = [1, 3, 3, 7, 5, 7, 7, 6, 2, 6, 4, 5];

export function surfaceNets(
  sdf: (x: number, y: number, z: number) => number,
  min: [number, number, number],
  max: [number, number, number],
  cell: number,
): SurfaceNetsResult {
  const nx = Math.ceil((max[0] - min[0]) / cell);
  const ny = Math.ceil((max[1] - min[1]) / cell);
  const nz = Math.ceil((max[2] - min[2]) / cell);
  const sx = nx + 1;
  const sy = ny + 1;
  const sz = nz + 1;

  // 采样所有格点，x 方向最快
  const values = new Float32Array(sx * sy * sz);
  let w = 0;
  for (let k = 0; k < sz; k++) {
    const z = min[2] + k * cell;
    for (let j = 0; j < sy; j++) {
      const y = min[1] + j * cell;
      for (let i = 0; i < sx; i++, w++) {
        values[w] = sdf(min[0] + i * cell, y, z);
      }
    }
  }

  const cellVert = new Int32Array(nx * ny * nz).fill(-1);
  const positions: number[] = [];
  const indices: number[] = [];
  const v = new Float64Array(8);

  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const val = values[(k + CZ[c]) * sy * sx + (j + CY[c]) * sx + i + CX[c]];
          v[c] = val;
          if (val < 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;

        let ax = 0;
        let ay = 0;
        let az = 0;
        let count = 0;
        for (let e = 0; e < 12; e++) {
          const a = EA[e];
          const b = EB[e];
          if (v[a] < 0 === v[b] < 0) continue;
          const t = v[a] / (v[a] - v[b]);
          ax += CX[a] + (CX[b] - CX[a]) * t;
          ay += CY[a] + (CY[b] - CY[a]) * t;
          az += CZ[a] + (CZ[b] - CZ[a]) * t;
          count++;
        }
        const inv = 1 / count;
        cellVert[(k * ny + j) * nx + i] = positions.length / 3;
        positions.push(min[0] + (i + ax * inv) * cell, min[1] + (j + ay * inv) * cell, min[2] + (k + az * inv) * cell);
      }
    }
  }

  const cellAt = (i: number, j: number, k: number): number => cellVert[(k * ny + j) * nx + i];
  const quad = (a: number, b: number, c: number, d: number): void => {
    indices.push(a, b, c, a, c, d);
  };

  // 沿 x 的棱：周围四个单元在 (y, z) 上围一圈
  for (let k = 1; k < nz; k++) {
    for (let j = 1; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const a = values[k * sy * sx + j * sx + i];
        const b = values[k * sy * sx + j * sx + i + 1];
        if (a < 0 === b < 0) continue;
        const q = [
          cellAt(i, j - 1, k - 1),
          cellAt(i, j, k - 1),
          cellAt(i, j, k),
          cellAt(i, j - 1, k),
        ];
        if (a < 0) quad(q[0], q[1], q[2], q[3]);
        else quad(q[3], q[2], q[1], q[0]);
      }
    }
  }

  // 沿 y 的棱
  for (let k = 1; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 1; i < nx; i++) {
        const a = values[k * sy * sx + j * sx + i];
        const b = values[k * sy * sx + (j + 1) * sx + i];
        if (a < 0 === b < 0) continue;
        const q = [
          cellAt(i - 1, j, k - 1),
          cellAt(i - 1, j, k),
          cellAt(i, j, k),
          cellAt(i, j, k - 1),
        ];
        if (a < 0) quad(q[0], q[1], q[2], q[3]);
        else quad(q[3], q[2], q[1], q[0]);
      }
    }
  }

  // 沿 z 的棱
  for (let k = 0; k < nz; k++) {
    for (let j = 1; j < ny; j++) {
      for (let i = 1; i < nx; i++) {
        const a = values[k * sy * sx + j * sx + i];
        const b = values[(k + 1) * sy * sx + j * sx + i];
        if (a < 0 === b < 0) continue;
        const q = [
          cellAt(i - 1, j - 1, k),
          cellAt(i, j - 1, k),
          cellAt(i, j, k),
          cellAt(i - 1, j, k),
        ];
        if (a < 0) quad(q[0], q[1], q[2], q[3]);
        else quad(q[3], q[2], q[1], q[0]);
      }
    }
  }

  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    cellCount: nx * ny * nz,
  };
}
