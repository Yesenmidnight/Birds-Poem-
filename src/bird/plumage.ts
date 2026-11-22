/**
 * 北长尾山雀的羽色分区（白头型）。输入是鸟自身的局部坐标、体表法线和离眼中轴线的距离，
 * 输出基础反照率。分区只看位置和朝向，不看躯体由哪块椭球构成，边界再用噪声打散，
 * 这样黑带、粉晕都是连续的一整片，而不是跟着建模骨骼走的花斑。
 * 所有色区都画在同一层绒毛上：白头、炭黑鞍背、玫瑰粉棕的肩胁是同一身毛的不同颜色。
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

export const PLUMAGE_PARS = /* glsl */ `
uniform vec3 uColWhite;
uniform vec3 uColPink;
uniform vec3 uColRose;
uniform vec3 uColBlack;
uniform vec3 uColCrown;
uniform vec3 uColSkin;

vec3 plumage( vec3 p, vec3 n, float eyeD ) {
	vec3 col = uColWhite;
	float side = smoothstep( 0.25, 0.75, abs( n.x ) );

	// 楔形黑鞍背：后枕白毛下方一道深炭黑横贯两肩之间的整个背宽，往下（往尾基）自然收束成上宽下窄的楔形，
	// 到尾上覆羽前收成细尖停住——不是"一横 + 一根等宽直棍"的丁字尺。
	// 前缘在中线处紧贴后枕（z≈0.15），到肩侧退到翅膀前缘以后（z≈-0.15），不会绕到肩膀前面；
	// 两缘用两层噪声打散成丝缕，边界柔和不发白
	float up = smoothstep( 0.15, 0.6, n.y );
	float zFront = 0.15 - 0.3 * smoothstep( 0.3, 0.9, abs( p.x ) );
	float behindNape = 1.0 - smoothstep( zFront - 0.15, zFront, p.z );
	float wedge = 0.84 * pow( clamp( ( p.z + 2.55 ) / 2.7, 0.0, 1.0 ), 0.72 );
	float inWedge = 1.0 - smoothstep( wedge - 0.12, wedge + 0.14, abs( p.x ) );
	float mantle = up * behindNape * inWedge;
	float fray = ( snoise( p * 9.0 ) - 0.5 ) * 0.26 + ( snoise( p * 26.0 + 3.0 ) - 0.5 ) * 0.14;
	mantle = smoothstep( 0.28, 0.66, mantle + fray );
	// 鞍背内部不是一块实心黑板：顺着羽毛方向（z）拉长的丝缕噪声，黑里透出一缕缕暗栗粉
	float streak = smoothstep( 0.5, 0.84, snoise( vec3( p.x * 14.0, p.y * 14.0, p.z * 3.5 ) ) * 0.5 + 0.5 );
	vec3 saddle = mix( uColBlack * 0.75, uColRose * 0.24, streak * 0.22 );

	// 两胁、下腹到尾下覆羽的葡萄酒粉晕，越靠后越浓
	float low = 1.0 - smoothstep( 1.1, 2.8, p.y );
	float rear = 1.0 - smoothstep( -2.6, 0.4, p.z );
	float pink = smoothstep( 0.05, 0.8, abs( n.x ) ) * low * ( 0.25 + 0.75 * rear ) * 0.7;
	pink = smoothstep( 0.2, 0.8, pink + ( snoise( p * 7.0 ) - 0.5 ) * 0.25 );
	col = mix( col, uColPink, pink );

	// 肩背到两胁上段的玫瑰粉棕：和粉晕长在同一层绒毛里的绒羽色，不是贴在翅膀上的羽片。
	// 肩上最浓，往下揉进粉晕，往前淡出到白胸；上缘被黑带压住
	float rose =
		side *
		smoothstep( 1.8, 2.6, p.y ) *
		( 1.0 - smoothstep( ${f(head.c[1] - 0.55)}, ${f(head.c[1] - 0.2)}, p.y ) ) *
		( 1.0 - smoothstep( -0.3, 0.9, p.z ) );
	rose = smoothstep( 0.2, 0.7, rose + ( snoise( p * 6.0 ) - 0.5 ) * 0.3 );
	rose *= 0.7 + 0.3 * smoothstep( 2.5, 3.1, p.y );

	// 披肩：脊柱黑带两侧、收拢翅上方两团玫瑰粉→白的蓬松肩羽绒毛，像披肩一样搭在翅上缘；
	// 离中线越远、越靠近翅上缘越粉，往上被横带压住，往后淡出到粉晕
	float capeSide = smoothstep( 0.12, 0.5, abs( p.x ) ) * ( 1.0 - smoothstep( 1.0, 1.35, abs( p.x ) ) );
	float capeZ = smoothstep( -2.5, -1.7, p.z ) * ( 1.0 - smoothstep( -0.7, 0.0, p.z ) );
	float capeY = smoothstep( 2.3, 2.8, p.y );
	float cape = capeSide * capeZ * capeY * ( 0.45 + 0.55 * ( 1.0 - up ) );
	cape = smoothstep( 0.15, 0.65, cape + ( snoise( p * 5.0 + 7.0 ) - 0.5 ) * 0.3 );
	rose = max( rose, cape );

	col = mix( col, mix( uColRose, uColWhite, 0.2 ), rose * ( 1.0 - mantle ) );
	col = mix( col, saddle, mantle );

	// 收拢的翼面底下的体表不再垫深色：正羽底下有自己的深色底板，羽片之间不透体表；
	// 抬翅时露出来的这一块就是正常的白/粉皮肤，不是一块灰秃斑

	// 头顶一层极淡的暖粉
	// 只在头顶（后枕以前）：不加这道 z 下限，整片背都会被这层暖粉罩成灰扑扑的，鞍背永远黑不下来
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
	// 只有上下颌之间真正露出来的口腔内部才是暗暖的珊瑚粉棕（线性色）
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
