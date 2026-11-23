/**
 * 雪地网格：以 (300, 0) 为中心（东翼盖了大植物园后院子重心东移）——内圈密（±700 cm，15 cm 格）+ 中圈（到 ±1500，50 cm 格）
 * + 远圈（到 ±5000，200 cm 格，带距离雾化和缓缓起伏的远野），高度全部读同一个 Heightfield（和碰撞体一字不差）。
 * 法线按"低通后的高度"中心差分求（内 / 中圈同一套）：院内雪垄比院外粗糙，若按各自格子的原始高度求法线，内圈 12 cm 格会把
 * 碎坡完整采出来、中圈 50 cm 格线性插值抹平，低角度太阳的宽镜面高光对粗糙法线是凸响应——俯视时圈界就显出一块发亮的方块。
 * 粗圈的內边界上垂一圈"裙边"，盖住粗细两圈之间的 T 形接缝。
 * 近 / 中圈合成一个网格，远圈单独一个（材质多了雾化）。
 */
import { BufferAttribute, BufferGeometry, Group, Mesh, type Material } from 'three';
import type { Heightfield } from '../sim/heightfield';
import { noise3, smoothstep } from '../util/math';

const CX = 300;
const CZ = 0;
const INNER = 700;
const MID = 1500;
const OUTER = 5000;
const CELL_IN = 15;
const CELL_MID = 50;
const CELL_OUT = 200;

/** 低通高度：±30 cm 的 3×3 平均（两个圈共用，法线在圈界处连续）。 */
function smoothHeight(field: Heightfield, x: number, z: number): number {
  let s = 0;
  for (let ix = -1; ix <= 1; ix++) for (let iz = -1; iz <= 1; iz++) s += field.heightAt(x + ix * 30, z + iz * 30);
  return s / 9;
}

function normalAt(field: Heightfield, x: number, z: number, extra: ((x: number, z: number) => number) | undefined, out: number[], k: number): void {
  const h = (px: number, pz: number): number => smoothHeight(field, px, pz) + (extra ? extra(px, pz) : 0);
  const eps = 15;
  const gx = (h(x + eps, z) - h(x - eps, z)) / (2 * eps);
  const gz = (h(x, z + eps) - h(x, z - eps)) / (2 * eps);
  const inv = 1 / Math.sqrt(gx * gx + 1 + gz * gz);
  out[k] = -gx * inv;
  out[k + 1] = inv;
  out[k + 2] = -gz * inv;
}

/** 远野的起伏：出了中圈（离中心 1450 以外）平滑淡入，接缝处仍是连续的。 */
export function farHills(x: number, z: number): number {
  const w = smoothstep(MID - 50, MID + 500, Math.max(Math.abs(x - CX), Math.abs(z - CZ)));
  return w * (70 * (noise3(x / 1100, z / 1100, 1.3) - 0.5) + 25 * (noise3(x / 380 + 5, z / 380 + 2, 4.1) - 0.5));
}

interface Grid {
  index: (ix: number, iz: number) => number;
  nx: number;
  nz: number;
  cell: number;
  x0: number;
  z0: number;
}

/** 一个网格环的构建器：顶点 / 法线 / uv / 索引，支持多圈叠加与裙边。 */
class Builder {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  idx: number[] = [];

  constructor(private readonly field: Heightfield) {}

  grid(x0: number, z0: number, nx: number, nz: number, cell: number, extra?: (x: number, z: number) => number): Grid {
    const map = new Int32Array((nx + 1) * (nz + 1)).fill(-1);
    for (let iz = 0; iz <= nz; iz++) {
      for (let ix = 0; ix <= nx; ix++) {
        const x = x0 + ix * cell;
        const z = z0 + iz * cell;
        const y = this.field.heightAt(x, z) + (extra ? extra(x, z) : 0);
        this.pos.push(x, y, z);
        normalAt(this.field, x, z, extra, this.nrm, this.pos.length - 3);
        this.uv.push(x / 40, z / 40);
        map[iz * (nx + 1) + ix] = this.pos.length / 3 - 1;
      }
    }
    return { index: (ix, iz) => map[iz * (nx + 1) + ix], nx, nz, cell, x0, z0 };
  }

  quads(g: Grid, keep: (ix: number, iz: number) => boolean): void {
    for (let iz = 0; iz < g.nz; iz++) {
      for (let ix = 0; ix < g.nx; ix++) {
        if (!keep(ix, iz)) continue;
        const a = g.index(ix, iz);
        const b = g.index(ix + 1, iz);
        const c = g.index(ix, iz + 1);
        const d = g.index(ix + 1, iz + 1);
        this.idx.push(a, c, b, b, c, d);
      }
    }
  }

  /** 在网格 g 的 (ix, iz) 沿 (dx, dz) 方向的边上，向下垂 drop cm 的裙边。 */
  skirt(g: Grid, ix: number, iz: number, dx: number, dz: number, drop: number): void {
    const top = g.index(ix, iz);
    const next = g.index(ix + dx, iz + dz);
    const base = this.pos.length / 3;
    this.pos.push(this.pos[top * 3], this.pos[top * 3 + 1] - drop, this.pos[top * 3 + 2]);
    this.pos.push(this.pos[next * 3], this.pos[next * 3 + 1] - drop, this.pos[next * 3 + 2]);
    // 看不见的面（被细圈盖着）：给个朝上的法线避免黑边；正反两种绕序都发，从哪边看都不被剔除
    this.nrm.push(0, 1, 0, 0, 1, 0);
    this.uv.push(0, 0, 1, 0);
    this.idx.push(top, base, next, next, base, base + 1);
    this.idx.push(top, next, base, next, base + 1, base);
  }

  geometry(): BufferGeometry {
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    geo.setAttribute('normal', new BufferAttribute(new Float32Array(this.nrm), 3));
    geo.setAttribute('uv', new BufferAttribute(new Float32Array(this.uv), 2));
    geo.setIndex(this.idx);
    geo.computeBoundingSphere();
    return geo;
  }
}

export function buildSnowGround(field: Heightfield, matNear: Material, matFar: Material): Group {
  const group = new Group();
  group.name = 'snow-ground';

  // 近 + 中圈
  const near = new Builder(field);
  const nIn = Math.round((INNER * 2) / CELL_IN);
  const inner = near.grid(CX - INNER, CZ - INNER, nIn, nIn, CELL_IN);
  near.quads(inner, () => true);
  const nMid = Math.round((MID * 2) / CELL_MID);
  const k0 = Math.round((MID - INNER) / CELL_MID);
  const k1 = nMid - k0;
  const mid = near.grid(CX - MID, CZ - MID, nMid, nMid, CELL_MID);
  near.quads(mid, (ix, iz) => ix < k0 || ix >= k1 || iz < k0 || iz >= k1);
  for (let i = k0; i < k1; i++) {
    near.skirt(mid, i, k0, 1, 0, 6);
    near.skirt(mid, i, k1, 1, 0, 6);
    near.skirt(mid, k0, i, 0, 1, 6);
    near.skirt(mid, k1, i, 0, 1, 6);
  }
  const nearMesh = new Mesh(near.geometry(), matNear);
  nearMesh.receiveShadow = true;
  group.add(nearMesh);

  // 远圈：出了院子以后雪野缓缓起伏
  const far = new Builder(field);
  const nOut = Math.round((OUTER * 2) / CELL_OUT);
  const f0 = Math.round((OUTER - MID) / CELL_OUT);
  const f1 = nOut - f0;
  const outer = far.grid(CX - OUTER, CZ - OUTER, nOut, nOut, CELL_OUT, farHills);
  far.quads(outer, (ix, iz) => ix < f0 || ix >= f1 || iz < f0 || iz >= f1);
  for (let i = f0; i < f1; i++) {
    far.skirt(outer, i, f0, 1, 0, 40);
    far.skirt(outer, i, f1, 1, 0, 40);
    far.skirt(outer, f0, i, 0, 1, 40);
    far.skirt(outer, f1, i, 0, 1, 40);
  }
  const farMesh = new Mesh(far.geometry(), matFar);
  farMesh.receiveShadow = false;
  group.add(farMesh);
  return group;
}

/** 远处雪野的地面高度（院墙外的松柏林踩在上面）：高度场边缘以外钳到边缘，再加远野起伏。 */
export function farSnowHeight(field: Heightfield, x: number, z: number): number {
  return field.heightAt(x, z) + farHills(x, z);
}
