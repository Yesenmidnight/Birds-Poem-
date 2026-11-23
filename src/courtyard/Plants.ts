/**
 * 温室植物（视觉层，全部程序化、零外部模型）：裂叶龟背竹、羽状蕨类、山茶 / 仙客来 / 雏菊 / 天竺葵四类盆花、
 * 从吊篮与盆沿垂下的常春藤。叶片 / 花瓣都是带 uv 和顶点色（aColor）的小网格，叶脉 / 蜡质高光 / 逆光透光在着色器里算。
 * 花盆读 src/pcg/courtyard.ts 的 POTS（和碰撞盒、口沿栖木同一份）。
 */
import { BufferAttribute, BufferGeometry, Color, CylinderGeometry, Matrix4 } from 'three';
import { GH_FIXTURES, POTS, type PotSpec } from '../pcg/courtyard';
import { makeRng } from '../util/math';
import { Batch, type BatchOptions } from './batch';
import type { CourtyardMaterials } from './materials';

type V3 = [number, number, number];
const DEG = Math.PI / 180;

/** 颜色插值（线性空间）。 */
function mixc(a: Color, b: Color, t: number, out = new Color()): Color {
  return out.copy(a).lerp(b, Math.max(0, Math.min(1, t)));
}

/**
 * 参数曲面网格：pos(u, v) 返回点、col(u, v) 返回颜色（u、v 都在 0..1）。nu × nv 个顶点，双面材质。
 */
function grid(nu: number, nv: number, pos: (u: number, v: number) => V3, col: (u: number, v: number) => Color): BufferGeometry {
  const p: number[] = [];
  const c: number[] = [];
  const uv: number[] = [];
  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++) {
      const u = i / nu;
      const v = j / nv;
      p.push(...pos(u, v));
      const k = col(u, v);
      c.push(k.r, k.g, k.b);
      uv.push(u, v);
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = j * (nu + 1) + i;
      idx.push(a, a + nu + 1, a + 1, a + 1, a + nu + 1, a + nu + 2);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(p), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
  g.setAttribute('aColor', new BufferAttribute(new Float32Array(c), 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** 把局部坐标的网格摆到世界：绕 X 仰俯（tilt）、绕 Y 朝向（yaw），再平移到 origin。 */
function place(g: BufferGeometry, origin: V3, tilt: number, yaw: number, roll = 0): BufferGeometry {
  const m = new Matrix4().makeRotationY(yaw).multiply(new Matrix4().makeRotationX(-tilt)).multiply(new Matrix4().makeRotationZ(roll));
  m.setPosition(origin[0], origin[1], origin[2]);
  g.applyMatrix4(m);
  return g;
}

/** 花盆：收口陶盆 + 盆沿 + 盆土。 */
function addPot(batch: Batch, m: CourtyardMaterials, p: PotSpec): void {
  const body = new CylinderGeometry(p.r, p.r * 0.72, p.h * 0.9, 16, 1);
  body.translate(p.x, p.y + p.h * 0.45, p.z);
  batch.add('terracotta', m.terracotta, body);
  const rim = new CylinderGeometry(p.r * 1.08, p.r * 1.06, p.h * 0.14, 16, 1);
  rim.translate(p.x, p.y + p.h * 0.93, p.z);
  batch.add('terracotta', m.terracotta, rim);
  const soil = new CylinderGeometry(p.r * 0.95, p.r * 0.9, 1.2, 14, 1);
  soil.translate(p.x, p.y + p.h - 1.6, p.z);
  batch.add('soil', m.soil, soil);
}

/** 茎：从 a 到 b 的几段折线（带弯曲）。 */
function stem(batch: Batch, m: CourtyardMaterials, pts: V3[], r: number, opts: BatchOptions = {}): void {
  for (let i = 1; i < pts.length; i++) batch.tube('stem', m.stem, pts[i - 1], pts[i], r * (1 - (i - 1) / (pts.length + 1)), 5, opts);
}

// ───────────────────────────── 龟背竹 ─────────────────────────────

const MONSTERA_A = new Color('#1d4a22');
const MONSTERA_B = new Color('#3f8436');
const MONSTERA_RIB = new Color('#6fa85a');

function addMonstera(batch: Batch, m: CourtyardMaterials, p: PotSpec, rng: () => number): void {
  const top: V3 = [p.x, p.y + p.h - 1, p.z];
  const s = p.scale;
  const n = 5 + Math.floor(rng() * 3);
  for (let k = 0; k < n; k++) {
    const yaw = (k / n) * Math.PI * 2 + rng() * 0.6;
    const lean = (18 + rng() * 22) * DEG;
    const pet = (42 + rng() * 36) * s;
    const dir: V3 = [Math.cos(yaw), 0, Math.sin(yaw)];
    // 叶柄：先直后弯，向叶尖方向倾
    const mid: V3 = [top[0] + dir[0] * pet * 0.25 * Math.sin(lean) * 2, top[1] + pet * 0.7, top[2] + dir[2] * pet * 0.25 * Math.sin(lean) * 2];
    const end: V3 = [top[0] + dir[0] * pet * 0.7 * Math.sin(lean), top[1] + pet * 0.95, top[2] + dir[2] * pet * 0.7 * Math.sin(lean)];
    stem(batch, m, [top, mid, end], 0.9 * s, { cast: false, receive: true });
    // 叶片：长 28~44、宽 0.78 倍，边缘深裂（v 向 17 段，裂口在 0.32 / 0.52 / 0.72）
    const L = (46 + rng() * 20) * s;
    const W = L * 0.42;
    const tilt = (12 + rng() * 30) * DEG;
    const droop = (20 + rng() * 25) * DEG;
    const geo = grid(6, 14, (u, v) => {
      const uu = u * 2 - 1;
      // 半宽轮廓：基部心形、中段最宽、向尖收窄；裂口处半宽收成窄条
      let half = Math.pow(Math.sin(Math.PI * Math.min(1, v * 1.08)), 0.55) * (0.78 + 0.22 * Math.sin(v * Math.PI));
      for (const cut of [0.3, 0.5, 0.7]) {
        const d = Math.abs(v - cut);
        if (d < 0.045) half *= 0.18 + 0.82 * (d / 0.045);
      }
      // 基部两裂（心形凹口）
      if (v < 0.12) half *= 0.55 + 0.45 * (v / 0.12);
      const x = uu * half * W;
      const z = v * L;
      // 沿中脉折起 + 向下弯垂
      const fold = 0.22 * W * uu * uu * (1 - v * 0.6);
      const y = fold - Math.pow(v, 1.8) * L * Math.tan(droop) * 0.55;
      return [x, y, z];
    }, (u, v) => {
      const c = mixc(MONSTERA_A, MONSTERA_B, v * 0.9 + 0.1 * Math.sin(u * Math.PI));
      if (Math.abs(u - 0.5) < 0.04) c.lerp(MONSTERA_RIB, 0.5);
      return c;
    });
    place(geo, end, tilt, yaw);
    batch.add('leaf', m.leaf, geo, undefined, { cast: false, receive: true });
  }
}

// ───────────────────────────── 蕨类 ─────────────────────────────

const FERN_A = new Color('#24512a');
const FERN_B = new Color('#5a9a44');

function addFern(batch: Batch, m: CourtyardMaterials, p: PotSpec, rng: () => number): void {
  const top: V3 = [p.x, p.y + p.h - 1.5, p.z];
  const s = p.scale;
  const fronds = 9 + Math.floor(rng() * 4);
  for (let k = 0; k < fronds; k++) {
    const yaw = (k / fronds) * Math.PI * 2 + rng() * 0.5;
    const dir: V3 = [Math.cos(yaw), 0, Math.sin(yaw)];
    const L = (26 + rng() * 16) * s;
    const rise = (30 + rng() * 20) * DEG;
    // 叶轴：先扬后垂的弧
    const rachis = (t: number): V3 => {
      const r = L * t;
      const y = top[1] + r * Math.tan(rise) * (1 - t * 0.9) - r * r * 0.012;
      return [top[0] + dir[0] * r * 0.92, y, top[2] + dir[2] * r * 0.92];
    };
    const pts: V3[] = [];
    for (let i = 0; i <= 6; i++) pts.push(rachis(i / 6));
    stem(batch, m, pts, 0.55 * s, { cast: false, receive: true });
    // 羽片：沿叶轴两侧交错，越靠尖端越短
    const pairs = 11 + Math.floor(rng() * 3);
    for (let i = 0; i < pairs; i++) {
      const t = 0.18 + (i / pairs) * 0.78;
      const len = (8.5 - i * 0.35) * s * (1 - t * 0.3);
      for (const sgn of [-1, 1] as const) {
        const t2 = t + (sgn > 0 ? 0.02 : 0);
        const cc = rachis(t2);
        const geo = grid(2, 2, (u, v) => {
          // 小羽片：细长、略向下垂
          const w = Math.sin(Math.PI * v) * len * 0.34;
          return [sgn * v * len, -v * v * len * 0.35, (u - 0.5) * 2 * w];
        }, (_u, v) => mixc(FERN_A, FERN_B, v * 0.8 + 0.2 * (1 - t)));
        const m2 = new Matrix4().makeRotationY(Math.atan2(dir[2], dir[0]));
        m2.setPosition(cc[0], cc[1], cc[2]);
        geo.applyMatrix4(m2);
        batch.add('leaf', m.leaf, geo, undefined, { cast: false, receive: true });
      }
    }
  }
}

// ───────────────────────────── 山茶（灌木 + 大花） ─────────────────────────────

const CAMELLIA_LEAF = new Color('#173a1c');
const CAMELLIA_LEAF_B = new Color('#2f6a2c');

function camelliaColor(hue: number): Color {
  if (hue > 0.9) return new Color('#f3eee6'); // 白
  if (hue > 0.8) return new Color('#e878a8'); // 粉
  return new Color('#c21c2e'); // 红
}

function addCamellia(batch: Batch, m: CourtyardMaterials, p: PotSpec, rng: () => number): void {
  const top: V3 = [p.x, p.y + p.h - 1.5, p.z];
  const s = p.scale;
  const col = camelliaColor(p.hue);
  // 主干（和碰撞的 stem 曲线一致）+ 4~5 根分枝
  const trunkPts: V3[] = [top, [p.x + 3 * s, top[1] + 16 * s, p.z - 2 * s], [p.x - 2 * s, top[1] + 32 * s, p.z + 2 * s], [p.x + 4 * s, top[1] + 46 * s, p.z - 1 * s]];
  stem(batch, m, trunkPts, 1.4 * s);
  const tips: V3[] = [];
  const nb = 4 + Math.floor(rng() * 2);
  for (let k = 0; k < nb; k++) {
    const yaw = (k / nb) * Math.PI * 2 + rng();
    const base = trunkPts[1 + Math.floor(rng() * 2)];
    const len = (16 + rng() * 14) * s;
    const tip: V3 = [base[0] + Math.cos(yaw) * len, base[1] + len * 0.7, base[2] + Math.sin(yaw) * len];
    stem(batch, m, [base, [(base[0] + tip[0]) / 2, (base[1] + tip[1]) / 2 + 3, (base[2] + tip[2]) / 2], tip], 0.7 * s);
    tips.push(tip);
  }
  // 叶：椭圆圆头、革质有光，沿枝条和顶端轮生
  const leaves = 18 + Math.floor(rng() * 8);
  for (let k = 0; k < leaves; k++) {
    const t = tips[k % tips.length];
    const yaw = rng() * Math.PI * 2;
    const tilt = (15 + rng() * 45) * DEG;
    const L = (7 + rng() * 4) * s;
    const geo = grid(3, 5, (u, v) => {
      const uu = u * 2 - 1;
      const half = Math.sin(Math.PI * Math.pow(v, 0.8)) * 0.36;
      return [uu * half * L, 0.08 * L * uu * uu - 0.12 * L * v * v, v * L];
    }, (u, v) => mixc(CAMELLIA_LEAF, CAMELLIA_LEAF_B, 0.35 + 0.5 * Math.abs(u - 0.5) * 2 + 0.1 * Math.sin(v * 9)));
    const origin: V3 = [t[0] + (rng() - 0.5) * 8 * s, t[1] + (rng() - 0.5) * 10 * s, t[2] + (rng() - 0.5) * 8 * s];
    place(geo, origin, tilt, yaw, (rng() - 0.5) * 0.6);
    batch.add('leaf', m.leaf, geo, undefined, { cast: false, receive: true });
  }
  // 花：2~3 朵，顶生；两层花瓣（外 5 内 5）+ 黄色花蕊
  const blooms = 2 + Math.floor(rng() * 2);
  for (let k = 0; k < blooms; k++) {
    const t = tips[k % tips.length];
    const c: V3 = [t[0] + (rng() - 0.5) * 4, t[1] + 2 + rng() * 3, t[2] + (rng() - 0.5) * 4];
    const R = (5.5 + rng() * 2) * s;
    const yaw0 = rng() * Math.PI * 2;
    for (let ring = 0; ring < 2; ring++) {
      const n = 5;
      for (let i = 0; i < n; i++) {
        const a = yaw0 + (i / n) * Math.PI * 2 + ring * 0.6;
        const tilt = (ring === 0 ? 28 : 52) * DEG;
        const petal = grid(3, 4, (u, v) => {
          const uu = u * 2 - 1;
          const w = Math.sin(Math.PI * Math.pow(v, 0.7)) * 0.55;
          return [uu * w * R, 0.2 * R * uu * uu + 0.15 * R * v * v, v * R];
        }, (_u, v) => col.clone().multiplyScalar(0.85 + 0.25 * v).lerp(new Color('#ffffff'), 0.1 * v));
        const origin: V3 = [c[0], c[1] + ring * 1.2, c[2]];
        place(petal, origin, tilt, a);
        batch.add('petal', m.petal, petal, undefined, { cast: false, receive: true });
      }
    }
    const core = new CylinderGeometry(R * 0.28, R * 0.22, R * 0.35, 10, 1);
    core.translate(c[0], c[1] + 2.2, c[2]);
    const yc = new Color('#e9b52a');
    batch.add('petal', m.petal, core, undefined, { cast: false, receive: true, attrs: { aColor: [yc.r, yc.g, yc.b] } });
  }
}

// ───────────────────────────── 仙客来 ─────────────────────────────

const CYC_LEAF = new Color('#1c3a22');
const CYC_LEAF_B = new Color('#6f9a6a');

function cyclamenColor(hue: number): Color {
  if (hue > 0.88) return new Color('#f2ecf1');
  if (hue > 0.7) return new Color('#e05a9a');
  return new Color('#c6285a');
}

function addCyclamen(batch: Batch, m: CourtyardMaterials, p: PotSpec, rng: () => number): void {
  const top: V3 = [p.x, p.y + p.h - 1.5, p.z];
  const s = p.scale;
  const col = cyclamenColor(p.hue);
  // 心形叶一圈（银斑靠顶点色变化）
  const leaves = 7 + Math.floor(rng() * 4);
  for (let k = 0; k < leaves; k++) {
    const yaw = (k / leaves) * Math.PI * 2 + rng() * 0.5;
    const tilt = (10 + rng() * 25) * DEG;
    const L = (7 + rng() * 3) * s;
    const pet: V3 = [top[0] + Math.cos(yaw) * 2, top[1] + 6 * s, top[2] + Math.sin(yaw) * 2];
    stem(batch, m, [top, pet], 0.5 * s, { cast: false, receive: true });
    const geo = grid(4, 5, (u, v) => {
      const uu = u * 2 - 1;
      const half = Math.sin(Math.PI * Math.pow(v, 0.6)) * 0.6 * (1 - v * 0.25);
      return [uu * half * L, -0.1 * L * uu * uu - 0.18 * L * v * v + 0.05 * L * (1 - v), v * L];
    }, (u, v) => {
      const marbling = Math.sin(u * 13 + v * 9) * 0.5 + 0.5;
      return mixc(CYC_LEAF, CYC_LEAF_B, 0.3 + 0.5 * marbling * (1 - Math.abs(u - 0.5) * 1.4));
    });
    place(geo, pet, tilt, yaw);
    batch.add('leaf', m.leaf, geo, undefined, { cast: false, receive: true });
  }
  // 花：细长花梗顶端下垂，5 片向后反卷的花瓣
  const flowers = 5 + Math.floor(rng() * 3);
  for (let k = 0; k < flowers; k++) {
    const yaw = rng() * Math.PI * 2;
    const hgt = (14 + rng() * 10) * s;
    const lean = (4 + rng() * 8) * s;
    const end: V3 = [top[0] + Math.cos(yaw) * lean, top[1] + hgt, top[2] + Math.sin(yaw) * lean];
    stem(batch, m, [top, [top[0] + Math.cos(yaw) * lean * 0.4, top[1] + hgt * 0.6, top[2] + Math.sin(yaw) * lean * 0.4], end], 0.45 * s, { cast: false, receive: true });
    const R = (2.6 + rng() * 1) * s;
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + rng() * 0.3;
      // 花瓣：从花心向上再向后翻（tilt 负值 = 朝上翻）
      const petal = grid(2, 4, (u, v) => {
        const uu = u * 2 - 1;
        const w = Math.sin(Math.PI * v) * 0.42;
        return [uu * w * R, v * v * R * 0.9, -v * R * 0.95];
      }, (_u, v) => col.clone().multiplyScalar(0.9 + 0.2 * v));
      place(petal, end, (-50 - rng() * 15) * DEG, a);
      batch.add('petal', m.petal, petal, undefined, { cast: false, receive: true });
    }
  }
}

// ───────────────────────────── 雏菊 / 天竺葵 ─────────────────────────────

const DAISY_WHITE = new Color('#f5f2ea');
const DAISY_LEAF = new Color('#3a6b2a');

function addDaisy(batch: Batch, m: CourtyardMaterials, p: PotSpec, rng: () => number): void {
  const top: V3 = [p.x, p.y + p.h - 1.5, p.z];
  const s = p.scale;
  // 勺形小叶一丛
  for (let k = 0; k < 9; k++) {
    const yaw = rng() * Math.PI * 2;
    const L = (5 + rng() * 3) * s;
    const geo = grid(3, 4, (u, v) => {
      const uu = u * 2 - 1;
      return [uu * Math.sin(Math.PI * Math.pow(v, 0.7)) * 0.3 * L, 0.1 * L * uu * uu, v * L];
    }, (_u, v) => mixc(DAISY_LEAF, DAISY_LEAF_B, v));
    place(geo, [top[0], top[1] + 1, top[2]], (20 + rng() * 30) * DEG, yaw);
    batch.add('leaf', m.leaf, geo, undefined, { cast: false, receive: true });
  }
  // 花：4~6 朵，白瓣黄心
  const flowers = 4 + Math.floor(rng() * 3);
  for (let k = 0; k < flowers; k++) {
    const yaw = rng() * Math.PI * 2;
    const hgt = (11 + rng() * 9) * s;
    const lean = (2 + rng() * 6) * s;
    const end: V3 = [top[0] + Math.cos(yaw) * lean, top[1] + hgt, top[2] + Math.sin(yaw) * lean];
    stem(batch, m, [top, [(top[0] + end[0]) / 2, (top[1] + end[1]) / 2 + 2, (top[2] + end[2]) / 2], end], 0.4 * s, { cast: false, receive: true });
    const R = (2.8 + rng() * 1.2) * s;
    const n = 14;
    const head = grid(n * 2, 2, (u, v) => {
      const a = u * Math.PI * 2;
      const r = v * R;
      const petalIdx = Math.floor(u * n);
      const inPetal = Math.abs(u * n - petalIdx - 0.5) < 0.42;
      return [Math.cos(a) * r * (inPetal ? 1 : 0.3), 0.3 * R * (1 - v) * 0.4, Math.sin(a) * r * (inPetal ? 1 : 0.3)];
    }, (_u, v) => (v > 0.35 ? DAISY_WHITE : new Color('#e9bb2a')));
    place(head, end, (rng() - 0.5) * 0.5, 0);
    batch.add('petal', m.petal, head, undefined, { cast: false, receive: true });
  }
}

const DAISY_LEAF_B = new Color('#6a9a44');
const GERANIUM_LEAF = new Color('#2f5a26');
const GERANIUM_LEAF_B = new Color('#5a8a3a');

function addGeranium(batch: Batch, m: CourtyardMaterials, p: PotSpec, rng: () => number): void {
  const top: V3 = [p.x, p.y + p.h - 1.5, p.z];
  const s = p.scale;
  const col = p.hue > 0.5 ? new Color('#e2468a') : new Color('#e0362c');
  // 圆形带浅裂的叶子
  const leaves = 8 + Math.floor(rng() * 4);
  for (let k = 0; k < leaves; k++) {
    const yaw = (k / leaves) * Math.PI * 2 + rng() * 0.5;
    const L = (6 + rng() * 3) * s;
    const pet: V3 = [top[0] + Math.cos(yaw) * 3 * s, top[1] + (5 + rng() * 6) * s, top[2] + Math.sin(yaw) * 3 * s];
    stem(batch, m, [top, pet], 0.55 * s, { cast: false, receive: true });
    const geo = grid(5, 5, (u, v) => {
      const a = u * Math.PI * 2;
      const r = v * L * (0.82 + 0.18 * Math.abs(Math.sin(a * 7)));
      return [Math.cos(a) * r, -0.12 * L * v * v, Math.sin(a) * r];
    }, (_u, v) => {
      const zone = Math.sin(v * 9) * 0.5 + 0.5;
      return mixc(GERANIUM_LEAF, GERANIUM_LEAF_B, 0.35 + 0.45 * zone);
    });
    place(geo, pet, (25 + rng() * 20) * DEG, yaw);
    batch.add('leaf', m.leaf, geo, undefined, { cast: false, receive: true });
  }
  // 花序：2~3 个紧密的伞形小球
  const umbels = 2 + Math.floor(rng() * 2);
  for (let k = 0; k < umbels; k++) {
    const yaw = rng() * Math.PI * 2;
    const hgt = (14 + rng() * 10) * s;
    const end: V3 = [top[0] + Math.cos(yaw) * 3 * s, top[1] + hgt, top[2] + Math.sin(yaw) * 3 * s];
    stem(batch, m, [top, end], 0.5 * s, { cast: false, receive: true });
    const R = (3.2 + rng() * 1.2) * s;
    const nf = 12;
    const head = grid(nf * 2, 2, (u, v) => {
      const a = u * Math.PI * 2;
      const fi = Math.floor(u * nf);
      const inF = Math.abs(u * nf - fi - 0.5) < 0.4;
      const r = v * R;
      return [Math.cos(a) * r * (inF ? 1 : 0.25), 0.6 * R * Math.sin(v * Math.PI) * (inF ? 1 : 0.3), Math.sin(a) * r * (inF ? 1 : 0.25)];
    }, (_u, v) => col.clone().multiplyScalar(0.85 + 0.3 * v));
    place(head, end, 0, 0);
    batch.add('petal', m.petal, head, undefined, { cast: false, receive: true });
  }
}

// ───────────────────────────── 常春藤 ─────────────────────────────

const IVY_A = new Color('#1f4d22');
const IVY_B = new Color('#4a8c3c');

/**
 * 一条垂蔓：从 start 出发往下垂（带横向摆动），每 6~8 cm 一片 3 裂叶。outward = 从盆 / 篮轴心指向外的水平方向：
 * 蔓先往外走、再往下垂，叶尖一律朝外半边张开——不然叶子会从侧面捅回盆壁 / 篮碗里。
 */
function addIvyVine(batch: Batch, m: CourtyardMaterials, start: V3, len: number, yaw: number, rng: () => number, spread = 0.5, outward?: V3): void {
  const n = Math.max(3, Math.round(len / 9));
  let p: V3 = [...start];
  const dir: V3 = outward ? [outward[0], 0, outward[2]] : [Math.cos(yaw), 0, Math.sin(yaw)];
  const ol = Math.hypot(dir[0], dir[2]) || 1;
  dir[0] /= ol;
  dir[2] /= ol;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    // 头两节往外探 3.5 cm 离开盆沿，之后每节往外 1.8 cm 并下垂
    const out = i < 2 ? 3.5 : 1.8 * (1 - t * 0.4);
    const q: V3 = [p[0] + dir[0] * out + (rng() - 0.5) * spread, p[1] - (i === 0 ? 2.5 : 7 - t * 2.2), p[2] + dir[2] * out + (rng() - 0.5) * spread];
    batch.tube('stem', m.stem, p, q, 0.45, 3, { cast: false, receive: true });
    // 叶：3 浅裂的常春藤叶，交替左右，叶尖朝外 ±55°
    const side = i % 2 === 0 ? 1 : -1;
    const L = (4.5 + rng() * 2) * (1 - t * 0.25);
    const leaf = grid(6, 5, (u, v) => {
      const a = (u - 0.5) * Math.PI * 1.25 * side + Math.PI / 2;
      const r = v * L * (0.8 + 0.2 * Math.abs(Math.sin(a * 3)));
      return [Math.cos(a) * r, -v * L * 0.25, Math.sin(a) * r];
    }, (u, v) => mixc(IVY_A, IVY_B, 0.3 + 0.5 * Math.abs(u - 0.5) * 2 + 0.15 * Math.sin(v * 11)));
    // 叶片的局部 +Z 是叶尖方向：转到"朝外 ±55°"（rotationY(yaw) 把局部 +Z 转到 (sin yaw, 0, cos yaw)）
    const leafYaw = Math.atan2(dir[0], dir[2]) + side * (20 + rng() * 35) * DEG;
    const m2 = new Matrix4().makeRotationY(leafYaw);
    m2.setPosition(q[0], q[1], q[2]);
    leaf.applyMatrix4(m2);
    batch.add('leaf', m.leaf, leaf, undefined, { cast: false, receive: true });
    p = q;
  }
}

function addIvyPot(batch: Batch, m: CourtyardMaterials, p: PotSpec, rng: () => number): void {
  const top: V3 = [p.x, p.y + p.h - 1, p.z];
  // 盆上一丛叶 + 2~3 条垂蔓
  for (let k = 0; k < 7; k++) {
    const yaw = rng() * Math.PI * 2;
    const L = 4 + rng() * 2.5;
    const leaf = grid(6, 5, (u, v) => {
      const a = (u - 0.5) * Math.PI * 1.25 + Math.PI / 2;
      const r = v * L * (0.8 + 0.2 * Math.abs(Math.sin(a * 3)));
      return [Math.cos(a) * r, -v * L * 0.2, Math.sin(a) * r];
    }, (u, v) => mixc(IVY_A, IVY_B, 0.3 + 0.5 * Math.abs(u - 0.5) * 2 + 0.15 * Math.sin(v * 11)));
    place(leaf, [top[0] + (rng() - 0.5) * 6, top[1] + 1 + rng() * 3, top[2] + (rng() - 0.5) * 6], (25 + rng() * 30) * DEG, yaw);
    batch.add('leaf', m.leaf, leaf, undefined, { cast: false, receive: true });
  }
  const vines = 2 + Math.floor(rng() * 2);
  for (let k = 0; k < vines; k++) {
    const a = rng() * Math.PI * 2;
    // 从盆沿外侧起蔓（盆口半径 1.08 r），不再从盆里穿盆壁出来
    addIvyVine(batch, m, [p.x + Math.cos(a) * p.r * 1.1, p.y + p.h - 1, p.z + Math.sin(a) * p.r * 1.1], (30 + rng() * 40) * p.scale, a, rng, 1.2, [Math.cos(a), 0, Math.sin(a)]);
  }
}

/** 吊篮里的常春藤：从篮沿四周垂下 60~110 cm。 */
function addBasketIvy(batch: Batch, m: CourtyardMaterials, bk: { x: number; z: number; y: number; r: number }, rng: () => number): void {
  for (let k = 0; k < 7; k++) {
    const a = (k / 7) * Math.PI * 2 + rng() * 0.5;
    addIvyVine(batch, m, [bk.x + Math.cos(a) * (bk.r + 1), bk.y + 1, bk.z + Math.sin(a) * (bk.r + 1)], 50 + rng() * 60, a, rng, 1.5, [Math.cos(a), 0, Math.sin(a)]);
  }
  // 篮顶一丛叶
  for (let k = 0; k < 9; k++) {
    const yaw = rng() * Math.PI * 2;
    const L = 5 + rng() * 3;
    const leaf = grid(6, 5, (u, v) => {
      const a = (u - 0.5) * Math.PI * 1.25 + Math.PI / 2;
      const r = v * L * (0.8 + 0.2 * Math.abs(Math.sin(a * 3)));
      return [Math.cos(a) * r, -v * L * 0.15, Math.sin(a) * r];
    }, (u, v) => mixc(IVY_A, IVY_B, 0.3 + 0.5 * Math.abs(u - 0.5) * 2 + 0.15 * Math.sin(v * 11)));
    place(leaf, [bk.x + (rng() - 0.5) * 16, bk.y + 1 + rng() * 4, bk.z + (rng() - 0.5) * 16], (30 + rng() * 35) * DEG, yaw);
    batch.add('leaf', m.leaf, leaf, undefined, { cast: false, receive: true });
  }
}

export function buildPlants(m: CourtyardMaterials, batch: Batch): void {
  for (const p of POTS) {
    const rng = makeRng(p.seed * 131 + 7);
    addPot(batch, m, p);
    switch (p.kind) {
      case 'monstera':
        addMonstera(batch, m, p, rng);
        break;
      case 'fern':
        addFern(batch, m, p, rng);
        break;
      case 'camellia':
        addCamellia(batch, m, p, rng);
        break;
      case 'cyclamen':
        addCyclamen(batch, m, p, rng);
        break;
      case 'daisy':
        addDaisy(batch, m, p, rng);
        break;
      case 'geranium':
        addGeranium(batch, m, p, rng);
        break;
      case 'ivy':
        addIvyPot(batch, m, p, rng);
        break;
    }
  }
  for (const bk of GH_FIXTURES.baskets) addBasketIvy(batch, m, bk, makeRng(900 + bk.x));
}

