/**
 * 场景布局的纯数据。后面的程序化生成器和现在手写的调试台都产出这一种结构：
 * 仿真层用 buildWorld 把它变成碰撞体，画面层用同一份数据建网格——一份布局，两种消费者，
 * 谁都不手填几何。全部是世界坐标、厘米。
 *
 * 这里不 import 任何带渲染依赖的模块，tools/sim.mjs 在 Node 里直接读。
 */
import type { SpringParams } from '../sim/curvePerch.ts';
import type { SlopeAxis } from '../sim/slopeSurface.ts';
import { growTree } from './tree.ts';

/** 曲线栖木：控制点 + 关键点半径（沿弧长等分），和 world/Branch.ts 的 LimbSpec 是同一套参数。 */
export interface CurveLayout {
  /** 画面按它选做法：wire 电线、twig 细枝、branch 主角枝（Branches 自己画）、tree / tree-twig 整棵树…… */
  tag: string;
  points: [number, number, number][];
  radii: number[];
  /** 弧长等距的采样段数（碰撞体和画面网格共用）。 */
  segments?: number;
  /** 落上会颤的参数；不填就是刚性的。 */
  spring?: SpringParams;
  /**
   * 悬臂枝（spring.mode = 'cantilever'）焊在哪根母枝上：母枝曲线在 layout.curves 里的序号，和焊口在母枝上的归一化弧长。
   * buildWorld 按它把子枝挂到母枝的振子上——母枝弯了多少，子枝的根就跟着走多少，焊口不裂。母枝刚性时不填也行。
   */
  springParent?: number;
  springAt?: number;
  // ── 以下是画面层的提示，碰撞层不读 ──
  /** 管子的径向段数（默认 28）。 */
  radial?: number;
  /** 是否生成积雪帽网格。 */
  snow?: boolean;
  /** 在这些弧长比例处长芽。 */
  buds?: number[];
  /** 树皮噪声种子。 */
  seed?: number;
}

/** 整棵树里的一根枝条：多了“长在哪根父枝的什么位置”。 */
export interface TreeLimb extends CurveLayout {
  /** 父枝在树里的下标（树干为 −1）。 */
  parent: number;
  /** 附着点在父枝上的弧长比例。 */
  attach: number;
}

/** 一棵树：主角枝之外的全部枝条，以及树干根部（雪面在那里堆一个雪丘）。 */
export interface TreeLayout {
  limbs: TreeLimb[];
  trunk: number;
  base: [number, number, number];
}

/** 雪面：一片起伏的厚雪（地面、屋顶雪被）。 */
export interface GroundLayout {
  tag: string;
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** 高度网格的单元边长（厘米）。 */
  cell: number;
  /** 雪面的基准高度。 */
  base: number;
  /** 雪垄起伏的幅度（厘米）。 */
  drift: number;
  seed: number;
  /** 雪丘：树干根部、墙角被风堆起来的雪。 */
  mounds?: { x: number; z: number; height: number; radius: number }[];
}

/** 轴对齐盒体：楼体、电线杆、长椅、空调外机。 */
export interface BoxLayout {
  tag: string;
  min: [number, number, number];
  max: [number, number, number];
}

/**
 * 斜板：沿 X 或沿 Z 倾斜的连续有厚板（双坡屋面、雨棚、玻璃斜顶、折线拱面的一段、天窗随坡 curb）。
 * 碰撞层建成 SlopeSurface（一块真正的平行六面体，顶面是倾斜平面），不再用阶梯薄盒逼近。
 */
export interface SlopeLayout {
  tag: string;
  /** 倾斜方向：'z' = 顶面高度随 z 变化（脊沿 X 的双坡顶）；'x' = 随 x 变化（植物园折线拱面）。 */
  axis: SlopeAxis;
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  /** 倾斜轴起点 / 终点处的顶面高度（axis = 'z' 时是 z0 / z1 处，axis = 'x' 时是 x0 / x1 处）。 */
  yA: number;
  yB: number;
  /** 竖直厚度（厘米）：底面 = 顶面下移 thick。 */
  thick: number;
}

export interface Layout {
  curves: CurveLayout[];
  grounds: GroundLayout[];
  boxes: BoxLayout[];
  /** 斜板（可省略：没有斜面的调试台 / 旧调用方）。 */
  slopes?: SlopeLayout[];
}

/**
 * 两根电线杆之间垂下来的电线：带垂度的抛物线。悬链线在垂度 / 跨度很小的时候和抛物线只差
 * 零点几毫米（跨度 372 cm、垂度 22 cm 时约 0.2 mm），这里直接用抛物线。
 * 返回 divisions + 1 个点，两端正好是 a 和 b。
 */
export function saggingWire(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  sag: number,
  divisions: number,
): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let i = 0; i <= divisions; i++) {
    const u = i / divisions;
    out.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u - 4 * sag * u * (1 - u), a[2] + (b[2] - a[2]) * u]);
  }
  return out;
}

/**
 * 主角枝：鸟停的那一根。数值照抄 world/Branch.ts 的 LIMBS[0]（那边带渲染依赖，Node 里 import 不了），只给无头压测
 * （tools/sim.mjs）和树的生成用；页面里 TestRig 不用这一份，碰撞体按 Branches.mainSpec() 直接从画面上那根枝的样条建，
 * LIMBS 一改不会两边对不上（2026-11-23 就对不上过一次：落脚段变细 0.07 cm，树皮对碰撞体差到 35%）。
 */
export const HERO_BRANCH: CurveLayout = {
  tag: 'branch',
  points: [
    [-46, -4.6, -11],
    [-26, -1.75, -3.7],
    [-11, -0.58, -0.55],
    [0, -0.35, 0],
    [9.5, -0.05, 0.75],
    [21, 1.1, 1.9],
  ],
  radii: [2.4, 1.35, 0.7, 0.36, 0.24, 0.04],
  segments: 190,
};

/** 树的雪丘：树干从雪里长出来，根部被风堆起一圈雪。 */
const TREE_MOUND = { height: 9, radius: 26 };

/**
 * 仿真调试台：鸟还站在观鸟那根主枝上（原点、面朝 −X），主枝现在长在一棵树上；
 * 周围摆上每一样表面各几件——雪地、带雪的跨街电线、小楼屋顶、矮台、一根细树。
 * 城市生成器做出来之前，先用它把内核压透。
 * 电线走 +Z 一侧（从 (−150, 120, 40) 到 (150, 120, 160)）：树冠朝 −Z / ±X 伸展，和电线不打架；
 * 所有看鸟的机位相机也都在 +Z 半边，电线在相机背后。
 */
export const TEST_TREE: TreeLayout = growTree(5, HERO_BRANCH);

export const TEST_RIG: Layout = {
  curves: [
    HERO_BRANCH,
    ...TEST_TREE.limbs,
    {
      tag: 'wire',
      points: saggingWire([-150, 120, 40], [150, 120, 160], 22, 120),
      radii: [0.5, 0.5],
      segments: 120,
      // 电线很软：落上去晃得久。gain 0.35 = 落点每 100 cm/s 的法向速度给中点 35 cm/s 的初速
      spring: { freq: 2.6, damping: 0.02, gain: 0.35 },
    },
    {
      tag: 'twig',
      // 放在 +z 一侧偏 +x：所有看鸟的机位相机都在 +z 半边，它在相机背后不挡鸟
      points: [
        [60, -80, 120],
        [54, -40, 110],
        [46, 0, 96],
        [37, 30, 82],
        [30, 50, 72],
        [25, 62, 65],
      ],
      radii: [2.4, 1.8, 1.3, 0.85, 0.45, 0.1],
      segments: 90,
      spring: { freq: 3.2, damping: 0.05, gain: 0.08 },
    },
  ],
  grounds: [
    {
      tag: 'snow',
      x0: -280,
      z0: -280,
      x1: 280,
      z1: 280,
      cell: 2,
      base: -80,
      drift: 7,
      seed: 3,
      mounds: [{ x: TEST_TREE.base[0], z: TEST_TREE.base[2], ...TREE_MOUND }],
    },
  ],
  boxes: [
    { tag: 'pole', min: [-154, -80, 36], max: [-146, 123, 44] },
    { tag: 'pole', min: [146, -80, 156], max: [154, 123, 164] },
    { tag: 'building', min: [70, -80, -200], max: [240, 60, -70] },
    { tag: 'bench', min: [-130, -80, 70], max: [-70, -28, 110] },
  ],
};
