/**
 * 绒毛壳层数的自动 LOD（纯数学，不依赖 three，Node 里可以直接跑）。
 *
 * 壳层法绒毛的采样密度该由什么决定：相邻两层壳在屏幕上的间距。壳间距 = 绒毛厚度 / 层数，
 * 间距超过约半个像素就能看出“一层层洋葱皮”，远低于一个像素则纯属浪费——层数应正比于
 * “鸟身上每厘米有多少像素”。所以这里不直接看相机距离，而是看鸟所在处的像素密度（厘米 / 像素），
 * 再换算成参考密度下的等效距离：参考密度取观鸟相机的截图基准——竖直视场角 28°、视口高 900 px。
 * 视场角更宽或窗口更小时，同样的距离像素更粗，层数自动再往下走；长焦、高分辨率时自动补回来。
 *
 * 层数随等效距离分三段：近景段保持满层数（定稿观感一个像素都不变），中段平滑降到第三人称距离的层数，
 * 远段再缓降到最低层数。时间上：加层立即跟上，减层做一小段指数平滑，推拉镜头、切预设视角时都不跳变。
 *
 * 层数降下来后绒毛会略微变暗、变瘦，而且幅度和 1 / 层数 成正比（同页成对实测：72 层亮度 −0.35%、
 * 47 层 −1.0%、24 层 −2.6%、16 层 −3.8%；剪影面积 24 层 −1.2%、16 层 −2.9%）。原因是数值积分的系统性偏差：
 * 每层壳的颜色取在该层上，而绒毛越往外越亮，层数越少、每层越厚，取值点整体偏内。
 * 补偿办法是把毛密度的阈值按同样的 1 / 层数 规律压低一点（densityBias），实测 −0.09 让 24 层的
 * 亮度 / 面积回到 1.002 / 0.998，−0.15 让 16 层回到 1.009 / 0.999。low 就是按 1 / 层数 量出来的
 * “降层程度”（0 = 满层，1 = 最低层），补偿量 = 满额 × low，近景恒为 0。
 */
export interface FurLodState {
  /** 参考像素密度下的等效距离（厘米）。 */
  distEq: number;
  /** 时间平滑后的层数（浮点）。 */
  level: number;
  /** 实际生效的层数（取整）。 */
  shells: number;
  /** 0 = 满层，1 = 最低层，按 1 / 层数 量（见文件头）。 */
  low: number;
}

/** 参考像素密度（厘米 / 像素）：28° 竖直视场角、900 px 高的视口，在 1 cm 处一个像素的边长。 */
export const LOD_REF_PIXEL = (2 * Math.tan((14 * Math.PI) / 180)) / 900;

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export class FurLod {
  enabled = true;
  // 三个锚点（等效距离 cm → 壳层数）
  nearDist = 14;
  nearShells = 96;
  midDist = 35;
  midShells = 24;
  farDist = 180;
  farShells = 16;
  /** 减层时的时间平滑常数（秒）；加层不平滑。 */
  smoothTime = 0.15;
  /**
   * 低壳层补偿：降到最低层时毛密度阈值、毛长各自的相对偏移（按 low 过渡，近景恒为 0）。
   * 密度 −0.14 是同页成对扫描出来的：24 层的亮度 / 剪影面积回到 1.000 / 0.997，16 层回到 1.007 / 0.997。
   * 毛长补偿默认 0：它对体积的贡献很小（+0.04 才 +0.5% 面积），却会真的把毛拉长——
   * 翼下短绒离黑羽片只差一点点，拉长有从羽片上冒出白斑的风险。
   */
  lenBoost = 0;
  densityBias = -0.14;

  distEq = 0;
  level = 0;
  shells = 0;
  low = 0;

  /** 像素密度（厘米 / 像素）→ 参考密度下的等效距离。 */
  static equivalentDistance(pixelSize: number): number {
    return pixelSize / LOD_REF_PIXEL;
  }

  /** 目标层数（未平滑）：等效距离 → 层数。maxShells 是几何的层数上限。 */
  target(distEq: number, maxShells = Infinity): number {
    const top = Math.min(this.nearShells, maxShells);
    if (distEq <= this.nearDist) return top;
    if (distEq >= this.farDist) return this.farShells;
    if (distEq <= this.midDist) return top + (this.midShells - top) * smooth(this.nearDist, this.midDist, distEq);
    return this.midShells + (this.farShells - this.midShells) * smooth(this.midDist, this.farDist, distEq);
  }

  /** 下一次 update 直接吸附到目标，不从旧层数慢慢爬（切换开关、重置镜头用）。 */
  reset(): void {
    this.level = -1;
  }

  /** 推进一帧：pixelSize 是鸟所在处的厘米 / 像素，dt 是秒。状态就地更新，不分配。 */
  update(pixelSize: number, dt: number, maxShells = Infinity): FurLodState {
    const goal = this.target((this.distEq = FurLod.equivalentDistance(pixelSize)), maxShells);
    // 不对称平滑：加层立即跟上（层数多只会更接近定稿观感，推近镜头时不能等它慢慢爬回来，
    // 否则中距离上会有一瞬间显出分层）；减层才缓动，切预设视角时不一步跳到位
    if (this.level < 0 || goal >= this.level || dt <= 0) this.level = goal;
    else this.level += (goal - this.level) * (1 - Math.exp(-dt / Math.max(this.smoothTime, 1e-3)));
    this.shells = Math.round(this.level);
    // 降层程度按 1 / 层数 量：变暗、变瘦的幅度和每层壳的厚度成正比，而不是和“少了几层”成正比
    const top = Math.min(this.nearShells, maxShells);
    const invNear = 1 / Math.max(top, 1);
    const invFar = 1 / Math.max(this.farShells, 1);
    this.low = invFar > invNear ? Math.min(1, Math.max(0, (1 / Math.max(this.level, 1) - invNear) / (invFar - invNear))) : 0;
    return this;
  }
}
