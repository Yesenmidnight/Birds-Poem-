/**
 * 北长尾山雀的羽色分区（白头型）。输入是鸟自身的局部坐标、体表法线和离眼中轴线的距离，
 * 输出基础反照率。分区只看位置和朝向，不看躯体由哪块椭球构成，边界再用噪声打散，
 * 这样黑领、粉晕都是连续的一整片，而不是跟着建模骨骼走的花斑。
 * 所有色区都画在同一层绒毛上：白头、炭黑鞍领、焦糖肉桂的肩羽是同一身毛的不同颜色。
 * 口腔、口角的位置从 bodySdf 的 params（嘴根、喙轴）派生，头部移动时自动跟随，不留旧常数。
 */
import { LONG_TAILED_TIT } from './bodySdf';

const { beakBase, beakDir, head } = LONG_TAILED_TIT;
const bl = Math.hypot(beakDir[0], beakDir[1], beakDir[2]);
// 喙轴在 yz 平面里的方向，和垂直于它的"上"方向
const dy = beakDir[1] / bl;
const dz = beakDir[2] / bl;
const uy = dz;
const uz = -dy;
const f = (v: number): string => v.toFixed(4);
/** 口角线两端：相对嘴根的偏移与 body.ts 的 GAPE_A / GAPE_B 完全一致 */
const GAPE_A = [beakBase[0] + 0.15, beakBase[1] - 0.01, beakBase[2] + 0.105];
const GAPE_B = [beakBase[0] + 0.31, beakBase[1] - 0.09, beakBase[2] + 0.04];

/** sRGB 十六进制 → 线性色：只在这里用、不值得再开一个 uniform 的颜色。 */
const lin = (hex: string): [number, number, number] => {
  const c = parseInt(hex.slice(1), 16);
  const ch = (v: number): number => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return [ch((c >> 16) & 255), ch((c >> 8) & 255), ch(c & 255)];
};
/** 短尖黑鞍领：带丝缕微光的暖炭黑褐，不是死黑（死黑压在绒毛上会糊成一块没有层次的黑板）。 */
const SADDLE = lin('#282326');

export const PLUMAGE_PARS = /* glsl */ `
uniform vec3 uColWhite;
uniform vec3 uColPink;
uniform vec3 uColRose;
uniform vec3 uColBlack;
uniform vec3 uColCrown;
uniform vec3 uColSkin;
const vec3 SADDLE = vec3( ${f(SADDLE[0])}, ${f(SADDLE[1])}, ${f(SADDLE[2])} );

// boneW = 头颈两根骨骼的权重和（fur.ts 顶点着色器传进来）：大于 0.05 的皮肤跟着头转，只能是白毛
vec3 plumage( vec3 p, vec3 n, float eyeD, float boneW ) {
	vec3 col = uColWhite;
	float af = abs( p.x );

	// ------------------------------------------------------------------ 短尖黑鞍领
	// 对照真鸟背面照：后脑白毛下缘一道横贯两肩的黑领，在肩前侧向下接到翅前根（侧面看和黑翅连成一片，
	// 不是夹在白毛中间的一根黑条）；往后只在背正中伸出一小撮短尖，到背长 40%~45% 处（z ≈ -1.45）就收束，
	// 绝不一路黑到下背和臀部——尾端之后 smoothstep 严格归零，不会在臀部中线留一道铅笔虚线。
	// 前缘退到头颈蒙皮区之后：头颈骨骼权重 > 0.05 的后颈窝 100% 是白毛，大角度转头时黑领留在静止的
	// 肩背上，不会跟着后枕的皮被拽出黑尖角
	float zFront = mix( -0.34, -0.12, smoothstep( 0.3, 0.9, af ) );
	float zBack = mix( -1.45, -0.62, smoothstep( 0.05, 0.46, af ) );
	// 顺毛流方向（z）拉长的噪声把前后缘打散：后脑的白毛丝一缕缕自然叠在黑领前缘上，不是刀切的直线。
	// 肩侧（黑领两端）的打散幅度减半：肩前的毛沿法线往上往前翘，黑毛尖往前戳进白胸毛里是一粒粒黑渣
	float fray = ( snoise( vec3( p.x * 14.0, p.y * 14.0, p.z * 3.5 ) ) - 0.5 ) * 0.2 + ( snoise( p * 9.0 ) - 0.5 ) * 0.08;
	fray *= 1.0 - 0.5 * smoothstep( 0.55, 0.85, af );
	// z 朝尾为负：在前缘之后（p.z < zFront）、在后缘之前（p.z > zBack）才是黑领里
	float collar = ( 1.0 - smoothstep( zFront - 0.05, zFront + 0.18, p.z + fray ) ) * smoothstep( zBack - 0.18, zBack + 0.05, p.z + fray );
	// 只在肩背以上：从背顶往两侧下到翅根上缘为止，不顺着两胁往下淌。例外是黑领两端（|x| > 0.6）：顺着肩侧
	// 一直向下延伸到收拢翅前缘根部（y ≈ 2.5），和黑翅前缘连通——侧面看黑领是"流进"黑翅里的，
	// 不是夹在白毛中间、下缘悬在翅前缘半腰的一根黑条（下缘悬空时黑毛尖朝下喷在白胸毛上，就是侧面那道夹缝）
	float lateral = smoothstep( 0.55, 0.85, af );
	collar *= mix( smoothstep( 0.05, 0.35, n.y ), smoothstep( -0.4, 0.0, n.y ) * smoothstep( 2.45, 2.6, p.y ), lateral );
	float mantle = collar * ( 1.0 - smoothstep( 0.02, 0.06, boneW ) );

	// 两胁、下腹到尾下覆羽的葡萄酒粉晕，越靠后越浓
	float low = 1.0 - smoothstep( 1.1, 2.8, p.y );
	float rear = 1.0 - smoothstep( -2.6, 0.4, p.z );
	float pink = smoothstep( 0.05, 0.8, abs( n.x ) ) * low * ( 0.25 + 0.75 * rear ) * 0.7;
	pink = smoothstep( 0.2, 0.8, pink + ( snoise( p * 7.0 ) - 0.5 ) * 0.25 );
	col = mix( col, uColPink, pink );

	// ------------------------------------------------------------------ 肩羽（Scapulars）：焦糖肉桂 → 奶白的 V 字
	// 两束肩羽从黑领两端的后下方（收拢翅根的上缘）顺着向后内倾的毛流斜向下：上半段是温暖浓郁的焦糖肉桂 /
	// 暖赤陶杏（uColRose），下半段渐变成干净蓬松的奶油白长绒毛；左右两束在黑色短尖的正后方、背中央汇合成 V 字，
	// 自然搭盖在收拢翅根部上方。中心线从翅根上缘 (|x| 0.80, z -0.62) 到背中央 (|x| 0.12, z -1.5)
	vec2 sq = vec2( af, p.z ) - vec2( 0.82, -0.62 );
	vec2 sd = vec2( -0.76, -0.8 );
	float st = clamp( dot( sq, sd ) / dot( sd, sd ), 0.0, 1.0 );
	float sdst = length( sq - sd * st );
	float scap = 1.0 - smoothstep( 0.2, 0.42, sdst + ( snoise( p * 7.0 + 2.0 ) - 0.5 ) * 0.16 );
	scap *= smoothstep( 0.1, 0.4, n.y ) * smoothstep( 2.8, 3.0, p.y );
	// 黑领压住肩羽的上缘
	scap *= 1.0 - mantle;
	// 焦糖肉桂占上半段，到背中央附近才化成奶油白——两束在黑色短尖正后方汇合
	col = mix( col, mix( uColRose, uColWhite, smoothstep( 0.45, 1.0, st ) ), scap );
	col = mix( col, SADDLE, mantle );

	// 抬起收拢的翅膀时露出来的翼下体表就是正常的白 / 粉皮肤，不垫深色：正羽底下有自己的深色底板

	// 头顶一层极淡的暖粉
	// 只在头顶（后枕以前）：不加这道 z 下限，整片背都会被这层暖粉罩成灰扑扑的，鞍领永远黑不下来
	float crown = smoothstep( 0.5, 0.95, n.y ) * smoothstep( ${f(head.c[1] - 0.6)}, ${f(head.c[1] - 0.1)}, p.y ) * ( 1.0 - smoothstep( 1.0, 1.7, p.z ) ) * smoothstep( -0.3, 0.05, p.z );
	col = mix( col, uColCrown, crown * 0.3 );

	// 眼睑壳底下的体表是深色皮肤（露出来的只有眼圈以内，其余都被眼睑盖住）
	col = mix( col, uColSkin, 1.0 - smoothstep( 0.105, 0.15, eyeD ) );

	// 口腔：张嘴时从上下颌之间露出来的体表是深暗的口腔色（body.ts 已把这里的毛压到零）。
	// 范围严格收在合拢时被上下颌盖住的颌根截面之内（半宽 0.10、上 0.09、下 -0.02，往外 0.03 渐隐）：
	// 合拢时颌根四周露出的那一圈皮肤仍是浅色，张嘴时颌根之间露出来的才是暗的口腔。
	// 头的前脸比嘴根还鼓出约 0.1 cm，所以沿喙轴的上限之外，下限只到颌根稍后（-0.22~-0.08）：
	// 不设下限这道圆柱会穿过脑壳从后枕钻出来，在背上剃出一块黑秃坑。
	// 坐标系沿喙轴：bUp 垂直于喙轴向上，bAl 沿喙轴向前，原点在嘴根（都从 params 派生）
	float bUp = ( p.y - ${f(beakBase[1])} ) * ${f(uy)} + ( p.z - ${f(beakBase[2])} ) * ${f(uz)};
	float bAl = ( p.y - ${f(beakBase[1])} ) * ${f(dy)} + ( p.z - ${f(beakBase[2])} ) * ${f(dz)};
	// 截面严格落在上下颌壳轮廓以内（和 body.ts 的压毛范围一致），合拢时嘴根两侧不露口腔色
	float mouth =
		( 1.0 - smoothstep( 0.08, 0.11, abs( p.x ) ) ) *
		( 1.0 - smoothstep( 0.07, 0.095, bUp ) ) *
		smoothstep( -0.03, -0.01, bUp ) *
		( 1.0 - smoothstep( 0.12, 0.17, bAl ) ) *
		smoothstep( -0.22, -0.08, bAl );
	// 颌根铰链后方那一小截合拢时露不出来、却盖不住的体表仍是深色皮肤（和嘴角阴影一致，不会在嘴根两侧漏红）；
	// 只有上下颌之间真正露出来的口腔内部才是暖珊瑚粉棕（线性色，在颌壳阴影里也读得出暖调）
	col = mix( col, uColSkin * 0.5, mouth );
	col = mix( col, vec3( 0.45, 0.14, 0.105 ), mouth * smoothstep( -0.04, 0.04, bAl ) );

	// 口角：从嘴角向后下方延伸进绒毛里的一道细微暗线
	vec3 ga = vec3( ${f(GAPE_A[0])}, ${f(GAPE_A[1])}, ${f(GAPE_A[2])} );
	vec3 gd = vec3( ${f(GAPE_B[0] - GAPE_A[0])}, ${f(GAPE_B[1] - GAPE_A[1])}, ${f(GAPE_B[2] - GAPE_A[2])} );
	vec3 gq = vec3( abs( p.x ), p.y, p.z ) - ga;
	float gt = clamp( dot( gq, gd ) / dot( gd, gd ), 0.0, 1.0 );
	float gape = 1.0 - smoothstep( 0.01, 0.03, length( gq - gd * gt ) );
	col *= 1.0 - 0.4 * gape * ( 1.0 - 0.6 * gt );
	return col;
}
`;
