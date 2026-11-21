/**
 * 北长尾山雀的羽色分区（白头型）。输入是鸟自身的局部坐标、体表法线和眼周裸区遮罩，
 * 输出基础反照率。分区只看位置和朝向，不看躯体由哪块椭球构成，边界再用噪声打散，
 * 这样黑带、粉晕都是连续的一整片，而不是跟着建模骨骼走的花斑。
 */
export const PLUMAGE_PARS = /* glsl */ `
uniform vec3 uColWhite;
uniform vec3 uColPink;
uniform vec3 uColRose;
uniform vec3 uColBlack;
uniform vec3 uColCrown;
uniform vec3 uColSkin;

vec3 plumage( vec3 p, vec3 n, float eyeMask ) {
	vec3 col = uColWhite;

	// 两胁、下腹到尾下覆羽的葡萄酒粉晕，越靠后越浓
	float side = smoothstep( 0.05, 0.8, abs( n.x ) );
	float low = 1.0 - smoothstep( 1.1, 2.8, p.y );
	float rear = 1.0 - smoothstep( -2.6, 0.4, p.z );
	float pink = side * low * ( 0.25 + 0.75 * rear ) * 0.7;
	pink = smoothstep( 0.2, 0.8, pink + ( snoise( p * 7.0 ) - 0.5 ) * 0.25 );
	col = mix( col, uColPink, pink );

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
	col = mix( col, uColBlack, mantle );

	// 肩部在正羽底下垫一层玫瑰褐，免得羽片之间漏出白底
	float scap =
		smoothstep( 0.35, 0.8, abs( n.x ) ) *
		smoothstep( 2.3, 2.7, p.y ) *
		( 1.0 - smoothstep( 3.0, 3.35, p.y ) ) *
		( 1.0 - smoothstep( 0.3, 0.7, p.z ) ) *
		smoothstep( -2.2, -1.5, p.z );
	col = mix( col, uColRose, scap * 0.85 * ( 1.0 - mantle ) );

	// 头顶一层极淡的暖粉
	float crown = smoothstep( 0.5, 0.95, n.y ) * smoothstep( 2.8, 3.3, p.y ) * ( 1.0 - smoothstep( 1.0, 1.7, p.z ) );
	col = mix( col, uColCrown, crown * 0.3 );

	// 眼周裸露的深色皮肤
	col = mix( col, uColSkin, eyeMask );
	return col;
}
`;
