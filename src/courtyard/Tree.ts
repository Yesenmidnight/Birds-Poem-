/**
 * 庭院的树（视觉层）：
 *   院心 = 观鸟管线那一整套（src/world/Branch.ts 的 decor 模式）：主角枝（鸟停的那一根，原位不动、沿 +X）+ 它的细枝 / 前景海棠果枝 /
 *   苔藓地衣 + 栖枝后方那棵 6 米的斜倚老海棠（crabappleTree.ts：满树越冬红果、雪脊、主干苔藓）。三条管线合流后这就是开场的观鸟界面，
 *   拉远就是整座院子。老海棠搬进院子要躲开阳光房（tree.avoid = pcg/courtyard.ts 的 limbClear，朝着暖房那一侧的枝被修剪得短一些）、
 *   不建树兜雪坡（院子里有真实的雪地，雪丘由 GROUND 的高度场堆）。
 *   同材质的普通网格在各组内合成一个（树皮 / 雪各 1 次绘制；苔藓 / 地衣壳层是 InstancedBufferGeometry，不动）；阴影只让树皮投。
 *   heroGroup / courtyardTreeGroup 分别放进散景的锐利层（图层 1）/ 虚化层（图层 0）——图层由 CourtyardApp 统一分配。
 *   温室里的三棵春树——同一个生成器（无雪），一个 bare 的 Branches 实例把三棵焊合进同一组网格（叶 / 花是 Foliage.ts 的实例化网格）。
 */
import { Group, InstancedBufferGeometry, Mesh, type Material } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { LightingUniforms } from '../glsl/lit';
import { limbClear, springTreeLimbs, type CrabLimb } from '../pcg/courtyard';
import { FOOT_SPOTS } from '../bird/parts';
import { Branches, type Limb, type LimbSpec } from '../world/Branch';

export interface TreeBuild {
  group: Group;
  /** 院心树（含主角枝）。treeSpecs / treeLimbs = 老海棠的枝条表和画面枝条（同序），舞台按序号把碰撞曲线对回画面上的枝。 */
  branches: Branches;
  /**
   * 前景锐利层（散景的图层 1）：主角枝一套 = 鸟脚下的精雕主角横枝 + 它的细枝 + 右前景越冬红果侧枝 + 积雪 / 苔藓地衣 / 绒毛壳层。
   * 同材质的普通网格已在组内合并。
   */
  heroGroup: Group;
  /** 背景虚化层（散景的图层 0）：6 米老海棠一套 = 主干 / 过渡枝 / 全部主枝侧枝冠梢 / 树冠红果 + 主干苔藓地衣。 */
  courtyardTreeGroup: Group;
  /** 温室春树（三棵合一个实例）。 */
  springBranches: Branches;
  /** 三棵春树的全部枝条（和下面 specs 同序）。 */
  springLimbs: Limb[];
  /** 三棵春树各自的 CrabLimb 表和它们在合并 specs 里的起始序号（碰撞曲线 ↔ 画面枝条对号用）。 */
  springTrees: { limbs: CrabLimb[]; offset: number }[];
}

function toLimbSpecs(limbs: CrabLimb[], parentBase = 0): LimbSpec[] {
  return limbs.map((l) => ({
    points: l.points,
    radii: l.radii,
    segments: l.segments,
    radial: l.radial,
    seed: l.seed,
    snow: l.snow,
    buds: l.buds,
    parent: l.parent >= 0 ? l.parent + parentBase : undefined,
    at: l.attach,
    nodePoints: l.nodePoints,
    young: l.young,
    berries: l.berries,
    berryScale: l.berryScale,
    // 果台 / 花台不是栖木：碰撞层不注册（画面照常画）
    perch: l.perch,
  }));
}

/** 把一个容器里同材质的普通网格合成一个（几何原样合并，画面逐位不变）。只合普通 BufferGeometry 的 Mesh：壳层是 InstancedBufferGeometry。 */
function mergeByMaterial(parent: Group): void {
  const byMat = new Map<Material, Mesh[]>();
  for (const c of parent.children) {
    if (!(c instanceof Mesh) || c.geometry instanceof InstancedBufferGeometry) continue;
    const list = byMat.get(c.material as Material);
    if (list) list.push(c);
    else byMat.set(c.material as Material, [c]);
  }
  for (const [mat, meshes] of byMat) {
    if (meshes.length < 2) continue;
    const merged = mergeGeometries(meshes.map((m) => m.geometry));
    if (!merged) continue;
    const mesh = new Mesh(merged, mat);
    mesh.castShadow = meshes.some((m) => m.castShadow);
    mesh.receiveShadow = true;
    for (const m of meshes) parent.remove(m);
    parent.add(mesh);
  }
}

export function buildTree(lighting: LightingUniforms): TreeBuild {
  const group = new Group();
  group.name = 'trees';
  // 院心：观鸟入口同一套 decor Branches（主角枝 + 细枝 + 前景果枝 + 苔藓地衣 + 老海棠），栖枝原位（沿 +X，鸟在原点）；
  // 老海棠躲开阳光房 / 洋房等禁入区、不建树兜雪坡（院子里雪丘是 GROUND 高度场的一部分，碰撞和画面同一张）；
  // split：主角枝一套和老海棠一套分装两个子 Group（散景按图层渲染：前景锐利、老海棠跟房屋一起虚化），同材质合并在各组内做
  const branches = new Branches(lighting, FOOT_SPOTS, true, { tree: { avoid: limbClear, rootMound: false }, split: true });
  mergeByMaterial(branches.heroGroup);
  mergeByMaterial(branches.treeGroup);
  // 阴影只让树皮投（雪帽 / 冬芽 / 果跟树皮轮廓几乎重合，省掉阴影通道的面数）
  for (const parent of [branches.heroGroup, branches.treeGroup]) {
    for (const c of parent.children) {
      if (c instanceof Mesh) c.castShadow = c.geometry.attributes.aBark !== undefined;
    }
  }
  group.add(branches);
  // 温室春树：不画主角枝，三棵树的母枝序号各自偏移后焊合进同一个实例；已萌芽展叶，不画冬芽
  const springBranches = new Branches(lighting, [], false, { bare: true });
  const specs: LimbSpec[] = [];
  const springTrees: TreeBuild['springTrees'] = [];
  for (const tree of springTreeLimbs()) {
    springTrees.push({ limbs: tree, offset: specs.length });
    specs.push(...toLimbSpecs(tree, specs.length));
  }
  const springLimbs = springBranches.addWeldedLimbs(specs, lighting, { noBuds: true });
  group.add(springBranches);
  return { group, branches, heroGroup: branches.heroGroup, courtyardTreeGroup: branches.treeGroup, springBranches, springLimbs, springTrees };
}
