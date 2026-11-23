/**
 * 零贴图的程序化表面图样（GLSL）：砌石 / 错缝砖 / 人字拼 / 鹅卵石小径 / 木板接缝——每个图样一个"高度 + 灰缝 + 随机数"的函数，
 * 材质的 surface() 用它配色和压 AO，lit.ts 的程序化凹凸钩子用同一个函数的高度做 dFdx / dFdy 法线扰动（两边必须是同一个场）。
 * 高度全部是世界坐标的连续函数（Voronoi 的 F1/F2、到格边的距离），格边才是刻意的沟——否则屏幕空间偏导在格边会炸出亮点。
 */
import { makeLitMaterial, rgb, type LightingUniforms } from '../glsl/lit';

export const VORONOI_GLSL = /* glsl */ `
vec2 hash22( vec2 p ) {
	return vec2( hash13( vec3( p, 7.0 ) ), hash13( vec3( p, 19.0 ) ) );
}
// 平面 Voronoi：x 已经除以格尺寸。返回 (F1, F2, 格号 x, 格号 y)；jitter = 特征点在格内的散布（0 = 格心，0.9 = 乱石）
vec4 voronoi2( vec2 x, float jitter ) {
	vec2 n = floor( x );
	vec2 f = fract( x );
	float f1 = 8.0;
	float f2 = 8.0;
	vec2 id = vec2( 0.0 );
	for ( int j = -1; j <= 1; j ++ ) {
		for ( int i = -1; i <= 1; i ++ ) {
			vec2 g = vec2( float( i ), float( j ) );
			vec2 o = vec2( 0.5 ) + ( hash22( n + g ) - 0.5 ) * jitter;
			vec2 r = g + o - f;
			float d = dot( r, r );
			if ( d < f1 ) { f2 = f1; f1 = d; id = n + g; } else if ( d < f2 ) { f2 = d; }
		}
	}
	return vec4( sqrt( f1 ), sqrt( f2 ), id );
}
// 竖直面的"沿墙 / 高"坐标（cm）：按法线主轴投影；朝上 / 朝下的面用 x + z
vec2 faceUV( vec3 p, vec3 N ) {
	if ( abs( N.y ) > 0.6 ) return p.xz;
	return abs( N.x ) > abs( N.z ) ? vec2( p.z, p.y ) : vec2( p.x, p.y );
}
`;

/** 错缝砌石（ASHLAR_L × ASHLAR_H cm 的石块，由材质 defines 给）：返回 (高度 cm, 灰缝 0..1, 石块随机数, 到缝中心距离 cm)。 */
export const ASHLAR_GLSL = /* glsl */ `
vec4 ashlarPattern( vec3 p, vec3 N ) {
	vec2 uv = faceUV( p, N );
	// 手工修边：缝线不是绝对直线（低频摆动 ±0.8 cm）
	vec2 wob = vec2( snoise( vec3( uv * 0.05, 1.3 ) ), snoise( vec3( uv * 0.05, 7.7 ) ) ) * 0.8;
	vec2 q = ( uv + wob ) / vec2( ASHLAR_L, ASHLAR_H );
	float row = floor( q.y );
	q.x += mod( row, 2.0 ) * 0.5;
	vec2 cell = floor( q );
	vec2 fr = fract( q );
	vec2 e = min( fr, 1.0 - fr ) * vec2( ASHLAR_L, ASHLAR_H );
	float d = min( e.x, e.y );
	float h = hash13( vec3( cell, 3.1 ) );
	// 缝宽约 3 cm（中心 1.2 cm 全深、两侧倒角）；石面：逐石微倾 + 凿面起伏 + 砂砾
	float mortar = 1.0 - smoothstep( 0.6, 1.5, d );
	float face = snoise( vec3( uv * 0.35, h * 9.0 ) ) * 0.22 + 0.15 * ( h - 0.5 ) + snoise( vec3( uv * 2.5, 2.0 ) ) * 0.08 + snoise( vec3( uv * 12.0, 5.0 ) ) * 0.02;
	float height = -1.0 * mortar + ( 1.0 - mortar ) * face;
	return vec4( height, mortar, h, d );
}
`;

/** 错缝砖（BRICK_L × BRICK_H，缝 1.2 cm）：返回 (高度 cm, 灰缝 0..1, 砖的随机数)。 */
export const BRICK_GLSL = /* glsl */ `
vec3 brickPattern( vec2 bc ) {
	vec2 b = bc / vec2( BRICK_L, BRICK_H );
	float row = floor( b.y );
	b.x += mod( row, 2.0 ) * 0.5;
	vec2 cell = floor( b );
	vec2 fr = fract( b );
	vec2 e = vec2( min( fr.x, 1.0 - fr.x ) * BRICK_L, min( fr.y, 1.0 - fr.y ) * BRICK_H );
	float d = min( e.x, e.y );
	float h = hash13( vec3( cell, 4.2 ) );
	float mortar = 1.0 - smoothstep( 0.5, 1.3, d );
	// 砖面：逐砖微倾 + 砂砾
	float face = 0.1 * ( h - 0.5 ) + snoise( vec3( bc * 1.6, 3.0 ) ) * 0.04 + snoise( vec3( bc * 9.0, 5.0 ) ) * 0.012;
	float height = -0.8 * mortar + ( 1.0 - mortar ) * face;
	return vec3( height, mortar, h );
}
`;

/** 人字拼砖地（砖 40 × 20、缝 1 cm，(cx+cy) mod 4 决定横竖）：返回 (高度 cm, 灰缝 0..1, 砖的随机数)。 */
export const HERRING_GLSL = /* glsl */ `
vec3 herringPattern( vec2 xz ) {
	vec2 p = xz / 20.0;
	vec2 cell = floor( p );
	float sc = mod( cell.x + cell.y, 4.0 );
	vec2 org = cell;
	vec2 size = vec2( 2.0, 1.0 );
	if ( sc < 0.5 ) { org = cell; size = vec2( 2.0, 1.0 ); }
	else if ( sc < 1.5 ) { org = cell - vec2( 1.0, 0.0 ); size = vec2( 2.0, 1.0 ); }
	else if ( sc < 2.5 ) { org = cell; size = vec2( 1.0, 2.0 ); }
	else { org = cell - vec2( 0.0, 1.0 ); size = vec2( 1.0, 2.0 ); }
	vec2 l = p - org;
	float wob = ( snoise( vec3( org, 2.9 ) ) * 0.5 + 0.5 ) * 0.015;
	float d = min( min( l.x, size.x - l.x ), min( l.y, size.y - l.y ) ) * 20.0 - wob * 20.0;
	float h = hash13( vec3( org, 7.7 ) );
	float mortar = 1.0 - smoothstep( 0.4, 1.1, d );
	float face = 0.08 * ( hash13( vec3( org, 1.3 ) ) - 0.5 ) + snoise( vec3( xz * 1.4, 4.0 ) ) * 0.03;
	float height = -0.7 * mortar + ( 1.0 - mortar ) * face;
	return vec3( height, mortar, h );
}
`;

/** 木板接缝：到最近一条接缝线的距离（cm）。axis 0 = 水平缝（沿 y 每隔 spacing 一道），1 = 竖直缝（沿墙轴每隔 spacing 一道）。 */
export const SEAM_GLSL = /* glsl */ `
float plankSeam( vec3 p, vec3 N, float spacing, float axis ) {
	float c = axis < 0.5 ? p.y : faceUV( p, N ).x;
	return abs( fract( c / spacing + 0.5 ) - 0.5 ) * spacing;
}
`;

/**
 * 鹅卵石碎石小径 + 嵌入式青石板（xz 平面）：大格（44 cm）按格号决定是石板区还是卵石区，
 * 石板区是平顶 + 3 cm 宽的深色板缝，卵石区是小格（6 cm）的球冠鹅卵石 + 泥缝。返回 (高度 cm, 缝 0..1, 是否石板, 随机数)。
 */
export const PATH_GLSL = /* glsl */ `
vec4 pathPattern( vec2 xz ) {
	// 38 cm 的大格里约 36% 嵌一块不规则青石板，其余是卵石
	vec4 big = voronoi2( xz / 38.0, 0.6 );
	float isSlab = step( 0.64, hash13( vec3( big.zw, 1.0 ) ) );
	float edge = big.y - big.x;
	// 石板：板缝处先落下去，板面平（带一点凿面起伏），逐板 0.3 cm 的高低差
	// 板边倒角宽一些（不是干裂泥的锐边），板面略带凿面起伏，逐板 0.3 cm 的高低差
	float slabH = 0.5 + 1.1 * smoothstep( 0.02, 0.16, edge ) + snoise( vec3( xz * 0.6, 2.0 ) ) * 0.06 + ( hash13( vec3( big.zw, 3.0 ) ) - 0.5 ) * 0.3 * smoothstep( 0.02, 0.16, edge );
	float slabGap = 1.0 - smoothstep( 0.02, 0.09, edge );
	// 卵石：球冠
	vec4 sm = voronoi2( xz / 6.0, 0.85 );
	float dome = sqrt( max( 1.0 - ( sm.x / 0.62 ) * ( sm.x / 0.62 ), 0.0 ) );
	float pebH = 0.25 + 0.9 * dome * smoothstep( 0.015, 0.05, sm.y - sm.x ) + ( hash13( vec3( sm.zw, 5.0 ) ) - 0.5 ) * 0.15 * dome;
	float pebGap = 1.0 - smoothstep( 0.015, 0.05, sm.y - sm.x );
	float k = smoothstep( 0.0, 0.08, edge );
	return vec4( mix( slabH, pebH, isSlab * k ), mix( slabGap, pebGap, isSlab * k ), isSlab * k, isSlab > 0.5 ? hash13( vec3( big.zw, 3.0 ) ) : hash13( vec3( sm.zw, 5.0 ) ) );
}
`;

/** 砌石材质（大植物园矮墙 / 石槽 / 洋房台基 / 隅石）：错缝石块、圆角边缘、深凹灰缝、逐石冷暖色差、墙根青苔 / 霜迹。 */
export function ashlarMaterial(lighting: LightingUniforms, opts: { moss?: boolean; block?: [number, number]; baseY?: number; color?: string; warm?: boolean } = {}): ReturnType<typeof makeLitMaterial> {
  const [L, H] = opts.block ?? [46, 22];
  return makeLitMaterial({
    lighting,
    defines: { ASHLAR_L: L.toFixed(1), ASHLAR_H: H.toFixed(1) },
    uniforms: {
      uStone: { value: rgb(opts.color ?? '#8e8b82') },
      uMortar: { value: rgb('#7a746a') },
      uMoss: { value: rgb('#3f5c2c') },
      uFrost: { value: rgb('#d9dde3') },
      uBaseY: { value: opts.baseY ?? -70 },
      uMossK: { value: opts.moss ? 1 : 0.3 },
    },
    fragmentPars: /* glsl */ `
${VORONOI_GLSL}
${ASHLAR_GLSL}
uniform vec3 uStone;
uniform vec3 uMortar;
uniform vec3 uMoss;
uniform vec3 uFrost;
uniform float uBaseY;
uniform float uMossK;
`,
    surface: /* glsl */ `
	vec4 a = ashlarPattern( vWorldPos, N );
	float h = a.z;
	// 逐石冷暖：偏暖的米灰 / 偏冷的青灰各半，亮度 ±14%，再加砂粒
	vec3 tint = mix( vec3( 1.05, 0.99, 0.92 ), vec3( 0.93, 0.98, 1.05 ), step( 0.5, hash13( vec3( h * 97.0, 2.0, 1.0 ) ) ) );
	vec3 alb = uStone * tint * ( 0.86 + 0.28 * h ) * ( 0.93 + 0.12 * ( snoise( vWorldPos * 5.0 ) * 0.5 + 0.5 ) );
	alb = mix( alb, uMortar * ( 0.9 + 0.2 * h ), a.y );
	// 墙根：温室里是青苔（往上 30 cm 渐淡、成斑），室外是霜 / 盐析的白迹
	float up = vWorldPos.y - uBaseY;
	float spots = smoothstep( 0.35, 0.7, fbm3( vWorldPos * 0.09 + vec3( 1.7, 0.0, 4.2 ) ) );
	float moss = uMossK * ( 1.0 - smoothstep( 0.0, 34.0, up ) ) * spots;
	float frost = ( 1.0 - uMossK ) * ( 1.0 - smoothstep( 0.0, 26.0, up ) ) * ( 0.4 + 0.6 * spots );
	alb = mix( alb, uMoss * ( 0.8 + 0.4 * h ), moss * 0.85 );
	alb = mix( alb, uFrost, frost * 0.5 );
	Surf s;
	s.albedo = alb;
	s.ao = 1.0 - 0.32 * a.y - 0.15 * moss;
	s.wrap = 0.3;
	s.specTint = vec3( 1.0 );
	s.gloss = 0.25;
	s.specAmt = 0.05 + 0.04 * frost;
	s.alpha = 1.0;
	return s;
`,
    bump: { height: 'return ashlarPattern( p, N ).x;', scale: 1, feature: 3 },
  });
}

/** 小径面：鹅卵石 + 嵌入青石板（贴在地形上的带状网格，xz 平面）。 */
export function pathStoneMaterial(lighting: LightingUniforms): ReturnType<typeof makeLitMaterial> {
  return makeLitMaterial({
    lighting,
    uniforms: { uSlab: { value: rgb('#5b626c') }, uPebble: { value: rgb('#9c958a') }, uJoint: { value: rgb('#6e5d4b') }, uJointW: { value: rgb('#56483a') } },
    fragmentPars: /* glsl */ `
${VORONOI_GLSL}
${PATH_GLSL}
uniform vec3 uSlab;
uniform vec3 uPebble;
uniform vec3 uJoint;
uniform vec3 uJointW;
`,
    surface: /* glsl */ `
	vec4 pp = pathPattern( vWorldPos.xz );
	float h = pp.w;
	// 青石板：青灰偏冷、逐板深浅、板面带浅色石纹
	vec3 slab = uSlab * ( 0.82 + 0.36 * h ) * ( 0.94 + 0.1 * ( snoise( vec3( vWorldPos.xz * 0.8, 3.0 ) ) * 0.5 + 0.5 ) );
	slab = mix( slab, slab * 1.25 + vec3( 0.05 ), smoothstep( 0.55, 0.9, snoise( vec3( vWorldPos.xz * 0.25, 8.0 ) ) ) * 0.5 );
	// 鹅卵石：暖灰 / 米黄 / 青灰三种，逐颗随机
	vec3 p0 = uPebble;
	float k1 = step( 0.5, hash13( vec3( h * 61.0, 0.0, 3.0 ) ) );
	float k2 = step( 0.8, h );
	vec3 peb = mix( mix( p0 * vec3( 1.08, 1.0, 0.9 ), p0 * vec3( 0.9, 0.95, 1.05 ), k1 ), p0 * vec3( 1.1, 1.02, 0.86 ), k2 ) * ( 0.78 + 0.4 * h );
	vec3 alb = mix( peb, slab, pp.z );
	// 缝里是湿泥：石板缝深褐、卵石缝更深
	vec3 joint = mix( uJointW, uJoint, pp.z );
	alb = mix( alb, joint, pp.y );
	Surf s;
	s.albedo = alb;
	s.ao = 1.0 - 0.42 * pp.y;
	s.wrap = 0.35;
	s.specTint = vec3( 1.0 );
	s.gloss = mix( 0.45, 0.3, pp.y );
	s.specAmt = mix( 0.12, 0.03, pp.y );
	s.alpha = 1.0;
	return s;
`,
    bump: { height: 'return pathPattern( p.xz ).x;', scale: 1, feature: 2.5 },
  });
}

/** 土壤 / 腐殖土的颗粒凹凸（春日地底用）。 */
export const SOIL_BUMP = /* glsl */ `
float soilHeight( vec3 p ) {
	return fbm3( p * 1.6 ) * 0.45 + snoise( p * 9.0 ) * 0.08 + snoise( p * 30.0 ) * 0.02;
}
`;
