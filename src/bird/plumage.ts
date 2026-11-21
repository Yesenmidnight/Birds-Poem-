/**
 * 北长尾山雀的羽色分区（白头型）。输入是鸟自身的局部坐标、体表法线和离眼中轴线的距离，
 * 输出基础反照率。分区只看位置和朝向，不看躯体由哪块椭球构成，边界再用噪声打散，
 * 这样黑带、粉晕都是连续的一整片，而不是跟着建模骨骼走的花斑。
 * 所有色区都画在同一层绒毛上：白头、炭黑背带、玫瑰粉棕的肩胁是同一身毛的不同颜色。
 */
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

	// 上背黑带：从颈后横过背中段，两缘用噪声打散
	float up = smoothstep( 0.3, 0.8, n.y );
	float bandZ = ( 1.0 - smoothstep( 0.25, 0.7, p.z ) ) * smoothstep( -2.2, -1.4, p.z );
	float mantle = up * bandZ * ( 1.0 - smoothstep( 2.95, 3.3, p.y ) );
	// 颈侧的黑纹沿侧面往下连到翅根
	float nape =
		smoothstep( 0.45, 0.85, abs( n.x ) ) *
		( 1.0 - smoothstep( 0.0, 0.5, p.z ) ) *
		smoothstep( 2.6, 3.1, p.y ) *
		( 1.0 - smoothstep( 3.3, 3.65, p.y ) );
	mantle = max( mantle, nape * 0.8 );
	mantle = smoothstep( 0.35, 0.65, mantle + ( snoise( p * 9.0 ) - 0.5 ) * 0.16 );

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
		( 1.0 - smoothstep( 3.05, 3.4, p.y ) ) *
		( 1.0 - smoothstep( -0.3, 0.9, p.z ) );
	rose = smoothstep( 0.2, 0.7, rose + ( snoise( p * 6.0 ) - 0.5 ) * 0.3 );
	rose *= 0.7 + 0.3 * smoothstep( 2.5, 3.1, p.y );
	col = mix( col, mix( uColRose, uColWhite, 0.2 ), rose * ( 1.0 - mantle ) );

	col = mix( col, uColBlack, mantle );

	// 收拢的翼面底下的体表不再垫深色：正羽底下有自己的深色底板，羽片之间不透体表；
	// 抬翅时露出来的这一块就是正常的白/粉皮肤，不是一块灰秃斑

	// 头顶一层极淡的暖粉
	float crown = smoothstep( 0.5, 0.95, n.y ) * smoothstep( 2.8, 3.3, p.y ) * ( 1.0 - smoothstep( 1.0, 1.7, p.z ) );
	col = mix( col, uColCrown, crown * 0.3 );

	// 眼睑壳底下的体表是深色皮肤（露出来的只有眼圈以内，其余都被眼睑盖住）
	col = mix( col, uColSkin, 1.0 - smoothstep( 0.105, 0.15, eyeD ) );

	// 口腔：张嘴时从上下颌之间露出来的体表是深暗的口腔色（body.ts 已把这里的毛压到零）。
	// 范围严格收在合拢时被上下颌盖住的颌根截面之内（半宽 0.10、上 0.09、下 -0.02，往外 0.03 渐隐）：
	// 合拢时颌根四周露出的那一圈皮肤仍是浅色，张嘴时颌根之间露出来的才是暗的口腔。
	// 头的前脸比嘴根还鼓出约 0.1 cm，所以沿喙轴不设下限、只设上限
	float bUp = ( p.y - 3.56 ) * 0.995 + ( p.z - 1.44 ) * 0.0995;
	float bAl = -( p.y - 3.56 ) * 0.0995 + ( p.z - 1.44 ) * 0.995;
	float mouth =
		( 1.0 - smoothstep( 0.10, 0.135, abs( p.x ) ) ) *
		( 1.0 - smoothstep( 0.09, 0.12, bUp ) ) *
		smoothstep( -0.05, -0.02, bUp ) *
		( 1.0 - smoothstep( 0.14, 0.2, bAl ) );
	col = mix( col, uColSkin * 0.45, mouth );

	// 口角：从嘴角向后下方延伸进绒毛里的一道细微暗线
	vec3 ga = vec3( 0.15, 3.55, 1.545 );
	vec3 gd = vec3( 0.16, -0.08, -0.065 );
	vec3 gq = vec3( abs( p.x ), p.y, p.z ) - ga;
	float gt = clamp( dot( gq, gd ) / dot( gd, gd ), 0.0, 1.0 );
	float gape = 1.0 - smoothstep( 0.01, 0.03, length( gq - gd * gt ) );
	col *= 1.0 - 0.4 * gape * ( 1.0 - 0.6 * gt );
	return col;
}
`;
