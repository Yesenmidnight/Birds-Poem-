/**
 * 仿真调试台（阶段 1）：把 src/pcg/layout.ts 的纯数据布局同时变成“碰撞体”（SimWorld）和“画面”
 * （雪面网格、电线 / 细枝的管子、盒体），再加一把能撒出去的小球探针。
 *
 * 画面只读仿真层的同一份数据建网格，不手填几何——碰撞体对不对，眼睛一看就知道：
 * 小球该停在面上就停在面上，电线颤起来球跟着走，叠加的碰撞线框和管子严丝合缝。
 * 鸟还站在观鸟那根主枝上；主枝的碰撞体从同一份控制点建，画面仍是 world/Branch.ts 画的。
 */
import {
  BoxGeometry,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  EdgesGeometry,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  ShaderMaterial,
  SphereGeometry,
  Uint32BufferAttribute,
  type IUniform,
} from 'three';
import { makeLitMaterial, rgb, type LightingUniforms } from '../glsl/lit';
import { makeRng } from '../util/math';
import { TEST_RIG, type BoxLayout, type CurveLayout, type GroundLayout, type Layout } from '../pcg/layout';
import { buildWorld } from '../sim/buildWorld';
import { ProbeSet } from '../sim/contacts';
import { CurvePerch, makeCurveFrame, type CurveFrame } from '../sim/curvePerch';
import { Heightfield } from '../sim/heightfield';
import { makeContact } from '../sim/surface';
import type { SimWorld } from '../sim/world';
import type { Surface } from '../sim/surface';
import type { Branches, Limb } from '../world/Branch';

const PROBE_MAX = 400;
const PROBE_RADIUS = 0.7;
const SNOW = '#eef1f4';
/** 各类表面的颜色：管子 / 盒体用它上色，碰撞线框用同色系更亮的版本。 */
const TAG_STYLE: Record<string, { color: string; line: string }> = {
  wire: { color: '#3b3a40', line: '#ff5a4a' },
  twig: { color: '#5b4a3a', line: '#ffa23a' },
  branch: { color: '#5b4a3a', line: '#ffe24a' },
  tree: { color: '#5b4a3a', line: '#9dff3a' },
  'tree-twig': { color: '#5b4a3a', line: '#ffb03a' },
  pole: { color: '#77716a', line: '#ff6ad5' },
  building: { color: '#d8cbb6', line: '#c07bff' },
  bench: { color: '#7b5a3a', line: '#b0ff5a' },
  snow: { color: SNOW, line: '#5ad0ff' },
};
const style = (tag: string) => TAG_STYLE[tag] ?? TAG_STYLE.pole;

interface Tube {
  perch: CurvePerch;
  mesh: Mesh;
  /** 没有振动位移的顶点坐标，颤动时在它上面加 offsetAt。 */
  base: Float32Array;
  cols: number;
  lastOffset: number;
  /** 叠加显示用的中心线，跟管子一起随振动更新。 */
  line: LineSegments;
  lineBase: Float32Array;
}

/** 小球探针的材质：带 instancing 的最简光照（太阳直射 + 天空 / 雪地半球光），读的是同一组灯光 uniform。 */
function probeMaterial(lighting: LightingUniforms): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uSunDir: lighting.uSunDir,
      uSunColor: lighting.uSunColor,
      uSkyColor: lighting.uSkyColor,
      uGroundColor: lighting.uGroundColor,
      uColor: { value: rgb('#ff7a1a') },
    },
    vertexShader: /* glsl */ `
varying vec3 vN;
void main() {
	mat4 m = modelMatrix * instanceMatrix;
	vN = normalize( mat3( m ) * normal );
	gl_Position = projectionMatrix * viewMatrix * m * vec4( position, 1.0 );
}
`,
    fragmentShader: /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform vec3 uColor;
varying vec3 vN;
void main() {
	vec3 n = normalize( vN );
	vec3 col = uColor * ( uSunColor * clamp( dot( n, uSunDir ), 0.0, 1.0 ) + mix( uGroundColor, uSkyColor, n.y * 0.5 + 0.5 ) );
	gl_FragColor = vec4( col, 1.0 );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}
`,
  });
}

/** 盒体 / 管子的材质：纯色 + 细碎颗粒，朝上的面自动盖一层雪。 */
function solidMaterial(lighting: LightingUniforms, color: string): ReturnType<typeof makeLitMaterial> {
  const uniforms: Record<string, IUniform> = { uColor: { value: rgb(color) }, uSnowCol: { value: rgb(SNOW) } };
  return makeLitMaterial({
    lighting,
    uniforms,
    fragmentPars: /* glsl */ `
uniform vec3 uColor;
uniform vec3 uSnowCol;
`,
    surface: /* glsl */ `
	float grain = snoise( vWorldPos * 9.0 ) * 0.5 + 0.5;
	float snow = smoothstep( 0.55, 0.85, N.y + ( grain - 0.5 ) * 0.2 );
	Surf s;
	s.albedo = mix( uColor * ( 0.86 + 0.14 * grain ), uSnowCol * ( 0.93 + 0.07 * grain ), snow );
	s.ao = 1.0;
	s.wrap = mix( 0.2, 0.5, snow );
	s.specTint = vec3( 1.0 );
	s.gloss = mix( 0.4, 0.5, snow );
	s.specAmt = mix( 0.05, 0.14, snow );
	s.alpha = 1.0;
	return s;
`,
  });
}

/** 雪面：和 world/Branch.ts 的积雪帽同一套颗粒与闪光。 */
function snowMaterial(lighting: LightingUniforms): ReturnType<typeof makeLitMaterial> {
  return makeLitMaterial({
    lighting,
    uniforms: { uSnowCol: { value: rgb(SNOW) } },
    fragmentPars: /* glsl */ `
uniform vec3 uSnowCol;
`,
    surface: /* glsl */ `
	Surf s;
	float grain = snoise( vWorldPos * 14.0 ) * 0.5 + 0.5;
	s.albedo = uSnowCol * ( 0.93 + 0.07 * grain );
	s.ao = 0.92;
	s.wrap = 0.5;
	float sp = step( 0.986, hash13( floor( vWorldPos * 70.0 ) ) );
	s.specTint = vec3( 1.0 );
	s.gloss = max( 0.5, sp * 0.92 );
	s.specAmt = 0.14 + sp * 0.7;
	s.alpha = 1.0;
	return s;
`,
  });
}

function lineMaterial(color: string, opacity: number): LineBasicMaterial {
  const m = new LineBasicMaterial({ color: new Color(color), transparent: true, opacity, depthTest: false });
  return m;
}

export class TestRig {
  readonly group = new Group();
  /** 碰撞线框：曲线中心线、雪面网格、盒体棱边。不写深度，永远画在最前面。 */
  readonly overlay = new Group();
  readonly world: SimWorld;
  readonly probes = new ProbeSet(PROBE_MAX, PROBE_RADIUS);
  /** 主角枝的碰撞体（布局里 tag 为 branch 的那条，控制点 / 半径取自画面上的主枝），画面由 Branches 画。 */
  branch!: CurvePerch;
  paused = false;

  private readonly tubes: Tube[] = [];
  private readonly tags = new Map<CurvePerch, string>();
  /** 树的枝条：碰撞体 → 画面的那根枝（落地时查精确的栖面用）。 */
  private readonly limbs = new Map<CurvePerch, Limb>();
  private readonly probeMesh: InstancedMesh;
  private readonly frame: CurveFrame = makeCurveFrame();
  private readonly mat = new Matrix4();
  private readonly rng = makeRng(11);
  private readonly contact = makeContact();

  /**
   * @param branches 观鸟的树枝组：整棵树的其余枝条用它的树皮 / 积雪 / 芽点材质画（addLimbs）
   */
  constructor(lighting: LightingUniforms, branches: Branches, layout: Layout = TEST_RIG) {
    this.group.name = 'test-rig';
    this.overlay.name = 'test-rig-overlay';
    this.overlay.visible = false;
    this.overlay.renderOrder = 10;
    // 主角枝的碰撞体按画面上那根枝的样条建（Branches.mainSpec）：Branch.ts 的 LIMBS 一改这边自动跟着，不用再手抄一份
    const hero = branches.mainSpec();
    const worldLayout: Layout = { ...layout, curves: layout.curves.map((c) => (c.tag === 'branch' ? { ...c, points: hero.points, radii: hero.radii } : c)) };
    this.world = buildWorld(worldLayout);
    this.probes.onImpact = (c, speed) => {
      const s = c.surface;
      if (s instanceof CurvePerch) s.excite(c.u / s.length, speed, c.ny);
    };

    // buildWorld 按曲线 → 雪面 → 盒体的顺序登记表面，这里按同样的顺序取回碰撞体建画面
    const surfaces = this.world.surfaces;
    const treeSpecs: CurveLayout[] = [];
    const treePerches: CurvePerch[] = [];
    let branchIdx = -1;
    layout.curves.forEach((c, i) => {
      const perch = surfaces[i] as CurvePerch;
      this.tags.set(perch, c.tag);
      if (c.tag === 'branch') branchIdx = i;
      else if (c.tag.startsWith('tree')) {
        treeSpecs.push(c);
        treePerches.push(perch);
      }
      else this.addTube(perch, c, lighting);
      if (c.tag === 'branch' || c.tag.startsWith('tree')) this.overlay.add(this.curveLine(perch, style(c.tag).line));
    });
    if (branchIdx >= 0) this.branch = surfaces[branchIdx] as CurvePerch;
    else throw new Error('布局里需要一条 tag 为 branch 的主角枝');
    // 整棵树：所有枝条合成 3 次绘制，用的就是主枝那套材质
    if (treeSpecs.length > 0) {
      const limbs = branches.addLimbs(treeSpecs);
      treePerches.forEach((perch, i) => this.limbs.set(perch, limbs[i]));
    }
    let k = layout.curves.length;
    for (const g of layout.grounds) this.group.add(this.buildGround(surfaces[k++] as Heightfield, g, lighting));
    for (const b of layout.boxes) this.group.add(this.buildBox(b, lighting));

    this.probeMesh = new InstancedMesh(new SphereGeometry(PROBE_RADIUS, 12, 9), probeMaterial(lighting), PROBE_MAX);
    this.probeMesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.probeMesh.frustumCulled = false;
    this.probeMesh.count = 0;
    this.group.add(this.probeMesh);
  }

  /** 撒 n 颗小球（从电线上方的空中落下），返回实际放出的颗数（探针池满了就少放）。 */
  scatter(n: number): number {
    let spawned = 0;
    for (let i = 0; i < n; i++) {
      if (
        this.probes.spawn(-170 + this.rng() * 330, 150 + this.rng() * 40, -140 + this.rng() * 250, (this.rng() - 0.5) * 20, 0, (this.rng() - 0.5) * 20) < 0
      )
        break;
      spawned++;
    }
    return spawned;
  }

  /**
   * 沿某条曲线栖木（弧长 10%~90% 一段）正上方 40 cm 撒 n 颗小球，专门看落线 / 落枝和颤动。
   * 零横速、正对轴线：球才会稳稳落在顶上。带一点横速小球就会从圆柱侧面滚下去——那是真实的物理。
   */
  scatterAlong(perch: CurvePerch, n: number): number {
    let spawned = 0;
    for (let i = 0; i < n; i++) {
      perch.frameAt((0.1 + 0.8 * this.rng()) * perch.length, this.frame);
      if (this.probes.spawn(this.frame.cx, this.frame.cy + 40, this.frame.cz) < 0) break;
      spawned++;
    }
    return spawned;
  }

  /** 布局里第一条带指定标签的曲线栖木（wire 电线、twig 细枝、branch 主枝）。 */
  curve(tag: string): CurvePerch | null {
    if (tag === 'branch') return this.branch;
    for (const [perch, t] of this.tags) if (t === tag) return perch;
    return null;
  }

  /** 树的全部枝条：[碰撞体, 画面上的枝]（tools/rigcheck.mjs 拿去核对栖面查询和网格是同一个面）。 */
  treeLimbs(): [CurvePerch, Limb][] {
    return [...this.limbs.entries()];
  }

  /** 树的枝条的碰撞体对应画面的哪根枝（落地时查精确栖面）；不是树的枝条返回 null。 */
  limbOf(surface: CurvePerch): Limb | null {
    return this.limbs.get(surface) ?? null;
  }

  /** 某个曲线栖木在布局里的标签（branch 主枝、tree* 树的枝、wire 电线、twig 细枝）；不是调试台里的曲线返回 null。 */
  tagOf(surface: Surface): string | null {
    return this.tags.get(surface as CurvePerch) ?? null;
  }

  clearProbes(): void {
    this.probes.clear();
  }

  /** 推进仿真并同步画面。 */
  update(dt: number): void {
    if (!this.paused) this.probes.step(this.world, dt);
    for (const t of this.tubes) {
      const off = t.perch.offset;
      if (off === t.lastOffset) continue;
      t.lastOffset = off;
      const rows = t.base.length / 3 / t.cols;
      const pos = t.mesh.geometry.attributes.position;
      const arr = pos.array as Float32Array;
      const lpos = t.line.geometry.attributes.position;
      const larr = lpos.array as Float32Array;
      for (let i = 0; i < rows; i++) {
        const d = t.perch.offsetAt((i / (rows - 1)) * t.perch.length);
        for (let j = 0; j < t.cols; j++) {
          const idx = (i * t.cols + j) * 3 + 1;
          arr[idx] = t.base[idx] + d;
        }
        // 中心线第 i−1 段的终点、第 i 段的起点都是第 i 行
        if (i > 0) larr[(i - 1) * 6 + 4] = t.lineBase[(i - 1) * 6 + 4] + d;
        if (i < rows - 1) larr[i * 6 + 1] = t.lineBase[i * 6 + 1] + d;
      }
      pos.needsUpdate = true;
      lpos.needsUpdate = true;
    }
    // 小球实例矩阵：只写活着的那些
    const p = this.probes;
    let n = 0;
    for (let i = 0; i < p.count; i++) {
      if (p.state[i] === 0) continue;
      this.mat.makeTranslation(p.px[i], p.py[i], p.pz[i]);
      this.probeMesh.setMatrixAt(n++, this.mat);
    }
    this.probeMesh.count = n;
    this.probeMesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * 用主枝树皮网格的顶点核对碰撞体：每个顶点问一次最近点，返回 |距离| / 当地半径 的最大值。
   * 树皮鼓包最多让真实表面偏出基础半径 8.5%，所以这个值不该超过 0.085。
   */
  checkBranchMesh(bark: BufferGeometry): { maxRatio: number; worst: [number, number, number] } {
    const pos = bark.attributes.position;
    let maxRatio = 0;
    let worst: [number, number, number] = [0, 0, 0];
    const c = this.contact;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      this.branch.closest(x, y, z, c);
      this.branch.frameAt(c.u, this.frame);
      const ratio = Math.abs(c.dist) / this.frame.radius;
      if (ratio > maxRatio) {
        maxRatio = ratio;
        worst = [x, y, z];
      }
    }
    return { maxRatio, worst };
  }

  private addTube(perch: CurvePerch, spec: CurveLayout, lighting: LightingUniforms): void {
    const radial = spec.tag === 'wire' ? 10 : 14;
    const rows = perch.segments + 1;
    const cols = radial + 1;
    const pos = new Float32Array(rows * cols * 3);
    const idx: number[] = [];
    const f = this.frame;
    for (let i = 0; i < rows; i++) {
      perch.frameAt((i / perch.segments) * perch.length, f);
      for (let j = 0; j < cols; j++) {
        const th = (j / radial) * Math.PI * 2;
        const cv = Math.cos(th);
        const sv = Math.sin(th);
        const k = (i * cols + j) * 3;
        pos[k] = f.cx + (f.ux * cv + f.sx * sv) * f.radius;
        pos[k + 1] = f.cy + (f.uy * cv + f.sy * sv) * f.radius;
        pos[k + 2] = f.cz + (f.uz * cv + f.sz * sv) * f.radius;
      }
      if (i === 0) continue;
      for (let j = 0; j < radial; j++) {
        const a = (i - 1) * cols + j;
        idx.push(a, a + 1, a + cols, a + 1, a + cols + 1, a + cols);
      }
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new Mesh(geo, solidMaterial(lighting, style(spec.tag).color));
    mesh.name = `tube:${spec.tag}`;
    this.group.add(mesh);
    const line = this.curveLine(perch, style(spec.tag).line);
    this.overlay.add(line);
    this.tags.set(perch, spec.tag);
    this.tubes.push({ perch, mesh, base: pos.slice(), cols, lastOffset: 0, line, lineBase: (line.geometry.attributes.position.array as Float32Array).slice() });
  }

  /** 曲线中心线（叠加显示用）。 */
  private curveLine(perch: CurvePerch, color: string): LineSegments {
    const rows = perch.segments + 1;
    const pos = new Float32Array((rows - 1) * 6);
    const f = this.frame;
    let px = 0;
    let py = 0;
    let pz = 0;
    for (let i = 0; i < rows; i++) {
      perch.frameAt((i / perch.segments) * perch.length, f);
      if (i > 0) {
        const k = (i - 1) * 6;
        pos[k] = px;
        pos[k + 1] = py;
        pos[k + 2] = pz;
        pos[k + 3] = f.cx;
        pos[k + 4] = f.cy;
        pos[k + 5] = f.cz;
      }
      px = f.cx;
      py = f.cy;
      pz = f.cz;
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
    const lines = new LineSegments(geo, lineMaterial(color, 0.9));
    lines.frustumCulled = false;
    return lines;
  }

  private buildGround(field: Heightfield, g: GroundLayout, lighting: LightingUniforms): Mesh {
    const w = field.nx + 1;
    const pos = new Float32Array(w * (field.nz + 1) * 3);
    for (let iz = 0; iz <= field.nz; iz++) {
      for (let ix = 0; ix <= field.nx; ix++) {
        const k = iz * w + ix;
        pos[k * 3] = field.x0 + ix * field.cell;
        pos[k * 3 + 1] = field.heights[k];
        pos[k * 3 + 2] = field.z0 + iz * field.cell;
      }
    }
    const idx = new Uint32Array(field.nx * field.nz * 6);
    let n = 0;
    for (let iz = 0; iz < field.nz; iz++) {
      for (let ix = 0; ix < field.nx; ix++) {
        const a = iz * w + ix;
        const b = a + 1;
        const c = a + w;
        const d = c + 1;
        idx[n++] = a;
        idx[n++] = c;
        idx[n++] = b;
        idx[n++] = b;
        idx[n++] = c;
        idx[n++] = d;
      }
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
    geo.setIndex(new Uint32BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    const mesh = new Mesh(geo, snowMaterial(lighting));
    mesh.receiveShadow = false;
    // 叠加：每 10 个节点画一条网格线
    const step = 10;
    const pts: number[] = [];
    for (let iz = 0; iz <= field.nz; iz += step) {
      for (let ix = 0; ix < field.nx; ix += step) {
        const a = (iz * w + ix) * 3;
        const b = (iz * w + Math.min(ix + step, field.nx)) * 3;
        pts.push(pos[a], pos[a + 1], pos[a + 2], pos[b], pos[b + 1], pos[b + 2]);
      }
    }
    for (let ix = 0; ix <= field.nx; ix += step) {
      for (let iz = 0; iz < field.nz; iz += step) {
        const a = (iz * w + ix) * 3;
        const b = (Math.min(iz + step, field.nz) * w + ix) * 3;
        pts.push(pos[a], pos[a + 1], pos[a + 2], pos[b], pos[b + 1], pos[b + 2]);
      }
    }
    const lgeo = new BufferGeometry();
    lgeo.setAttribute('position', new Float32BufferAttribute(pts, 3));
    const lines = new LineSegments(lgeo, lineMaterial(style(g.tag).line, 0.35));
    lines.frustumCulled = false;
    this.overlay.add(lines);
    return mesh;
  }

  private buildBox(b: BoxLayout, lighting: LightingUniforms): Mesh {
    const w = b.max[0] - b.min[0];
    const h = b.max[1] - b.min[1];
    const d = b.max[2] - b.min[2];
    const geo = new BoxGeometry(w, h, d);
    const mesh = new Mesh(geo, solidMaterial(lighting, style(b.tag).color));
    mesh.position.set(b.min[0] + w / 2, b.min[1] + h / 2, b.min[2] + d / 2);
    const edges = new EdgesGeometry(geo);
    const lines = new LineSegments(edges, lineMaterial(style(b.tag).line, 0.8));
    lines.position.copy(mesh.position);
    lines.frustumCulled = false;
    this.overlay.add(lines);
    return mesh;
  }
}
