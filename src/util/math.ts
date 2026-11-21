/** 数学小工具：钳制、插值、平滑、确定性噪声。世界单位统一为厘米。 */

export const TAU = Math.PI * 2;

export const clamp = (x: number, a: number, b: number): number => Math.min(b, Math.max(a, x));

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** 与 GLSL 的 smoothstep 同义：e0 < e1 时单调递增，传入反序边界则单调递减。 */
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** mulberry32：小而快的确定性随机数。 */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash3i(x: number, y: number, z: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** 三维值噪声，输出 0..1。 */
export function noise3(x: number, y: number, z: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = fade(x - ix), fy = fade(y - iy), fz = fade(z - iz);
  let s = 0;
  for (let k = 0; k < 2; k++) {
    const wz = k === 0 ? 1 - fz : fz;
    for (let j = 0; j < 2; j++) {
      const wy = (j === 0 ? 1 - fy : fy) * wz;
      for (let i = 0; i < 2; i++) {
        const wx = (i === 0 ? 1 - fx : fx) * wy;
        s += wx * hash3i(ix + i, iy + j, iz + k);
      }
    }
  }
  return s;
}

/** 一维值噪声（内部走三维噪声的一条线）。 */
export function noise1(x: number, seed = 0): number {
  return noise3(x, seed * 7.31 + 0.5, seed * 3.17 + 11.5);
}

/** 把若干控制点按 t ∈ [0,1] 等距分段线性插值（两端平滑）。 */
export function interpKeys(keys: number[], t: number): number {
  const n = keys.length;
  if (n === 1) return keys[0];
  const x = clamp(t, 0, 1) * (n - 1);
  const i = Math.min(Math.floor(x), n - 2);
  const f = fade(x - i);
  return keys[i] + (keys[i + 1] - keys[i]) * f;
}
