/**
 * 喙的剖面（上下颌共用、body.ts 的嘴根压毛、plumage.ts 的口腔色也用同一组公式）。
 * 自变量是"距喙尖的距离 dTip"，和铰链在哪无关：铰链前移时只要 dTip 的范围跟着变，
 * 露在绒毛外的喙形、喙长逐点不变。数值是 M1 定稿的尖巧小三角锥。
 */
export type Vec3 = [number, number, number];

/** 剖面参考长度：原始"嘴根→喙尖"长度，所有幂函数以它归一（喙短了基部也跟着收细，锥角约 23°）。 */
export const BEAK_REF_LEN = 0.39;
/** 铰链（params.beakBase）到脸皮下的剖面原点的距离：放样从原点起、经过铰链一直到喙尖，铰链平面处没有开口的颌根环。 */
export const BEAK_HINGE_DEPTH = 0.13;
/** 喙脊微下弯：喙尖相对喙轴下沉 BEAK_DROOP × 参考长度。 */
export const BEAK_DROOP = 0.07;
/** 嘴缝处的口角凹痕：嘴缝那一圈壳往里收的比例。 */
export const BEAK_NOTCH = 0.11;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export const beakHalfWidth = (dTip: number): number => 0.168 * Math.pow(clamp01(dTip / BEAK_REF_LEN), 0.72) + 0.0035;
export const beakUpperHeight = (dTip: number): number => 0.15 * Math.pow(clamp01(dTip / BEAK_REF_LEN), 0.85) + 0.0035;
/** 下颌厚度约为上颌的 70%（真鸟 65%~75%），前端仍收成尖；原来 (1-s)² 的二次曲线太薄，张嘴时整片缩进下巴里。 */
export const beakLowerHeight = (dTip: number): number => 0.105 * Math.pow(clamp01(dTip / BEAK_REF_LEN), 0.85) + 0.0025;

/** 同一组剖面的 GLSL 版本（参数 dTip 单位 cm），给 plumage.ts 内联。 */
export const BEAK_PROFILE_GLSL = /* glsl */ `
float beakW( float dTip ) { return 0.168 * pow( clamp( dTip / ${BEAK_REF_LEN.toFixed(4)}, 0.0, 1.0 ), 0.72 ) + 0.0035; }
float beakHu( float dTip ) { return 0.15 * pow( clamp( dTip / ${BEAK_REF_LEN.toFixed(4)}, 0.0, 1.0 ), 0.85 ) + 0.0035; }
float beakHl( float dTip ) { return 0.105 * pow( clamp( dTip / ${BEAK_REF_LEN.toFixed(4)}, 0.0, 1.0 ), 0.85 ) + 0.0025; }
`;

/** 喙轴 / 喙的"上"方向（单位向量，鸟局部坐标）。 */
export function beakAxes(dir: Vec3): { d: Vec3; up: Vec3 } {
  const l = Math.hypot(dir[0], dir[1], dir[2]);
  const d: Vec3 = [dir[0] / l, dir[1] / l, dir[2] / l];
  // up = dir × X（喙轴在 yz 平面里）：(0, dz, -dy)
  const ul = Math.hypot(d[2], d[1]);
  return { d, up: [0, d[2] / ul, -d[1] / ul] };
}
