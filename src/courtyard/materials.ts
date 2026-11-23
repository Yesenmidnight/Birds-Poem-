/**
 * 庭院共享材质：全部走 makeLitMaterial（自研解析光照 + three 阴影），同类材质只建一份、配 Batch 合批。
 * 颜色 / 纹理全在片元着色器里按世界坐标现算（拉毛灰泥、木纹、砖、人字拼砖地、陶盆、石头、雪）。
 * 阳光房里的东西（砖地 / 木架 / 花盆 / 植物）和院里的雪地、路灯一起叠加两盏"假灯"（见 CourtyardLighting.WARM_LIGHT_GLSL）。
 */
import { Color, DoubleSide, ShaderMaterial, Vector4, type IUniform } from 'three';
import { makeLitMaterial, rgb, type LightingUniforms } from '../glsl/lit';
import { LAMP_GLOW, WARM_LIGHT_GLSL } from './CourtyardLighting';
import { BRICK_GLSL, HERRING_GLSL, SEAM_GLSL, SOIL_BUMP, VORONOI_GLSL, ashlarMaterial, pathStoneMaterial } from './procedural';
import { SNOW_PRINTS, SNOW_PRINT_GLSL, SNOW_PRINT_VERTEX, type SnowPrints } from './SnowPrints';
import { AWNING, BALCONY, HOUSE, PORCH, TERRACE, WINDOWS } from '../pcg/courtyard';

export const PALETTE = {
  snow: '#f4f6fa',
  stucco: '#e6dcc8',
  walnut: '#4a3426',
  cedar: '#7a5a3a',
  pine: '#b08a5c',
  fence: '#8f8070',
  brick: '#a8563a',
  mortar: '#cfc6b8',
  iron: '#2a2a2e',
  terracotta: '#b9603b',
  stone: '#8a8d93',
  glow: '#ffb765',
} as const;

const warmUniforms = (): Record<string, IUniform> => ({ uLampPos: { value: LAMP_GLOW } });

/** 雪：细颗粒 + 稀疏闪光 + 逆光次表面（和 world/Branch.ts 的雪帽同一套观感）。haze = 远野随距离化进天光的雾化。
 *  prints = 院里全部雪面共用的雪印 uniform（SnowPrints）：顶点沿法线下压 + 片元碗状 bump + 坑内冷蓝 AO / 高光减弱。 */
export function snowMaterial(lighting: LightingUniforms, opts: { prints: { value: Vector4[] }; warm?: boolean; sparkle?: number; haze?: boolean }): ReturnType<typeof makeLitMaterial> {
  const sparkle = opts.sparkle ?? 0.14;
  return makeLitMaterial({
    lighting,
    uniforms: { uSnowCol: { value: rgb(PALETTE.snow) }, uHaze: { value: rgb('#c9d2dc').multiplyScalar(0.9) }, uSnowPrints: opts.prints, ...(opts.warm ? warmUniforms() : {}) },
    vertexPars: /* glsl */ `
uniform vec4 uSnowPrints[${SNOW_PRINTS}];
`,
    vertexMain: SNOW_PRINT_VERTEX,
    fragmentPars: /* glsl */ `
uniform vec3 uSnowCol;
uniform vec3 uHaze;
${SNOW_PRINT_GLSL}
${opts.warm ? WARM_LIGHT_GLSL : ''}
`,
    // 雪印的碗状凹凸：dFdx / dFdy 转法线扰动，像素足迹超过 3 cm 淡出（远处的坑只剩顶点下压那点起伏）
    bump: { height: 'return snowPrintField( p ).x;', scale: 1, feature: 3 },
    surface: /* glsl */ `
	float g = snoise( vWorldPos * 9.0 ) * 0.5 + 0.5;
	float fine = snoise( vWorldPos * 55.0 ) * 0.5 + 0.5;
	float sp = step( 0.985, hash13( floor( vWorldPos * 70.0 ) ) );
	// 雪印：坑里冷蓝 AO 压暗 15%、高光减弱（坑底的雪被压实又背光）
	float occ = snowPrintField( vWorldPos ).y;
	Surf s;
	s.albedo = uSnowCol * ( 0.93 + 0.05 * g + 0.02 * fine ) * mix( vec3( 1.0 ), vec3( 0.84, 0.90, 1.06 ), occ );
	s.ao = 0.96 * ( 1.0 - 0.15 * occ );
	s.wrap = 0.6;
	s.specTint = vec3( 1.0 );
	s.gloss = max( 0.55, sp * 0.92 );
	s.specAmt = ( ${sparkle.toFixed(3)} + sp * 0.7 ) * ( 1.0 - 0.55 * occ );
	s.alpha = 1.0;
	${opts.haze ? /* glsl */ `
	float h = smoothstep( 1800.0, 4600.0, distance( vWorldPos, cameraPosition ) );
	s.albedo *= 1.0 - 0.85 * h;
	s.specAmt *= 1.0 - h;
	` : ''}
	return s;
`,
    extraLight: /* glsl */ `
	float back = pow( max( dot( -V, uSunDir ), 0.0 ), 2.0 );
	vec3 tint = mix( vec3( 0.85, 0.92, 1.0 ), vec3( 1.0, 0.96, 0.9 ), back );
	vec3 c = ( uSunColor * 0.25 * back * tint + uSkyColor * 0.12 * ( 1.0 - 0.5 * N.y ) ) * sunShadow() + uSunColor * 0.03 * tint;
	${opts.warm ? 'c += warmLights( vWorldPos, s );' : ''}
	${opts.haze ? 'c += uHaze * ( 0.55 + 0.45 * uSkyColor ) * smoothstep( 1800.0, 4600.0, distance( vWorldPos, cameraPosition ) );' : ''}
	return c;
`,
  });
}

/** 拉毛灰泥外墙：细颗粒 + 大块雨痕色斑 + 墙根溅脏，朝上的窄面挂雪。 */
export function stuccoMaterial(lighting: LightingUniforms, color = PALETTE.stucco): ReturnType<typeof makeLitMaterial> {
  const boxes = WINDOWS.filter((w) => w.box && w.face === 'south');
  return makeLitMaterial({
    lighting,
    uniforms: {
      uColor: { value: rgb(color) },
      uSnowCol: { value: rgb(PALETTE.snow) },
      uEave: { value: HOUSE.yEave },
      uRidge: { value: [HOUSE.yRidge, HOUSE.zRidge, Math.abs(HOUSE.z1 - HOUSE.zRidge)] },
      uBal: { value: [BALCONY.x0, BALCONY.x1, BALCONY.yFloor] },
      uAwn: { value: [AWNING.x0, AWNING.x1, AWNING.yWall] },
      uTer: { value: [TERRACE.x0, TERRACE.x1, TERRACE.yFloor] },
      uPorch: { value: [PORCH.x0, PORCH.x1, PORCH.yWall] },
      uGroundY: { value: HOUSE.floors[0] },
      uBoxes: { value: boxes.map((w) => new Vector4(w.x0, w.x1, w.y0, 0)) },
    },
    fragmentPars: /* glsl */ `
uniform vec3 uColor;
uniform vec3 uSnowCol;
uniform float uEave;
uniform vec3 uRidge;
uniform vec3 uBal;
uniform vec3 uAwn;
uniform vec3 uTer;
uniform vec3 uPorch;
uniform float uGroundY;
uniform vec4 uBoxes[ ${boxes.length} ];
`,
    surface: /* glsl */ `
	float g = snoise( vWorldPos * 3.2 ) * 0.5 + 0.5;
	float fine = snoise( vWorldPos * 24.0 ) * 0.5 + 0.5;
	float stain = fbm3( vWorldPos * 0.35 + vec3( 2.7, 1.3, 5.1 ) );
	float dirt = 1.0 - smoothstep( uGroundY, uGroundY + 65.0, vWorldPos.y );
	vec3 alb = uColor * ( 0.92 + 0.08 * g ) * ( 0.95 + 0.08 * fine ) * ( 0.93 + 0.1 * stain );
	alb = mix( alb, alb * vec3( 0.78, 0.76, 0.74 ), dirt * 0.5 );
	float sn = smoothstep( 0.6, 0.85, N.y + ( g - 0.5 ) * 0.2 );
	// 建筑接触 AO：檐下（山墙顺着屋面斜线）、阳台板底 / 雨棚下 / 露台板底 / 门廊雨棚下、窗台花箱下、墙根
	float ao = 1.0;
	float eaveY = abs( N.x ) > 0.6 ? uRidge.x - ( uRidge.x - uEave ) * min( abs( vWorldPos.z - uRidge.y ) / uRidge.z, 1.0 ) : uEave;
	ao *= 1.0 - 0.3 * exp( - max( eaveY - vWorldPos.y, 0.0 ) / 60.0 );
	if ( N.z > 0.5 ) {
		float inBal = step( uBal.x, vWorldPos.x ) * step( vWorldPos.x, uBal.y );
		ao *= 1.0 - 0.3 * inBal * exp( - max( uBal.z - vWorldPos.y, 0.0 ) / 80.0 );
		ao *= 1.0 - 0.22 * inBal * step( vWorldPos.y, uAwn.z ) * exp( - max( uAwn.z - vWorldPos.y, 0.0 ) / 90.0 );
		float inTer = step( uTer.x, vWorldPos.x ) * step( vWorldPos.x, uTer.y );
		ao *= 1.0 - 0.3 * inTer * exp( - max( uTer.z - vWorldPos.y, 0.0 ) / 80.0 );
		float inPorch = step( uPorch.x, vWorldPos.x ) * step( vWorldPos.x, uPorch.y );
		ao *= 1.0 - 0.25 * inPorch * exp( - max( uPorch.z - vWorldPos.y, 0.0 ) / 60.0 );
		for ( int i = 0; i < ${boxes.length}; i ++ ) {
			vec4 b = uBoxes[ i ];
			float inx = step( b.x, vWorldPos.x ) * step( vWorldPos.x, b.y ) * step( vWorldPos.y, b.z - 24.0 );
			ao *= 1.0 - 0.22 * inx * exp( - max( b.z - 24.0 - vWorldPos.y, 0.0 ) / 22.0 );
		}
	}
	ao *= 1.0 - 0.3 * ( 1.0 - smoothstep( 0.0, 40.0, vWorldPos.y - uGroundY ) );
	Surf s;
	s.albedo = mix( alb, uSnowCol, sn );
	s.ao = ao * ( 1.0 - 0.12 * dirt );
	s.wrap = 0.25;
	s.specTint = vec3( 1.0 );
	s.gloss = 0.2;
	s.specAmt = 0.04;
	s.alpha = 1.0;
	return s;
`,
    bump: { height: 'return snoise( p * 7.5 ) * 0.06 + snoise( p * 1.3 ) * 0.22 + snoise( p * 28.0 ) * 0.015;', scale: 1, feature: 2.5 },
  });
}
/** 木料：沿竖向拉长的木纹 + 细颗粒；a / b 是深浅两色。 */
export function woodMaterial(lighting: LightingUniforms, a: string, b: string, opts: { warm?: boolean; grain?: number; seams?: { axis: 'y' | 'u'; spacing: number } } = {}): ReturnType<typeof makeLitMaterial> {
  const gs = (opts.grain ?? 1).toFixed(2);
  const seams = opts.seams;
  return makeLitMaterial({
    lighting,
    defines: seams ? { SEAM_S: seams.spacing.toFixed(1), SEAM_AXIS: seams.axis === 'y' ? '0.0' : '1.0' } : {},
    uniforms: { uA: { value: rgb(a) }, uB: { value: rgb(b) }, ...(opts.warm ? warmUniforms() : {}) },
    fragmentPars: /* glsl */ `
${VORONOI_GLSL}
${SEAM_GLSL}
uniform vec3 uA;
uniform vec3 uB;
${opts.warm ? WARM_LIGHT_GLSL : ''}
`,
    surface: /* glsl */ `
	vec3 p = vWorldPos * ${gs};
	float streak = fbm3( vec3( p.x * 2.6, p.y * 0.35, p.z * 2.6 ) );
	float fine = snoise( vec3( p.x * 14.0, p.y * 1.6, p.z * 14.0 ) ) * 0.5 + 0.5;
	float m = clamp( 0.5 + ( streak - 0.5 ) * 0.9 + ( fine - 0.5 ) * 0.25, 0.0, 1.0 );
	// 木板拼接缝：一道窄的暗缝（凹凸法线里是真的凹槽）
	float seam = 0.0;
	${seams ? /* glsl */ `seam = 1.0 - smoothstep( 0.0, 0.45, plankSeam( vWorldPos, N, SEAM_S, SEAM_AXIS ) );` : ''}
	Surf s;
	s.albedo = mix( uA, uB, m ) * ( 1.0 - 0.5 * seam );
	s.ao = 1.0 - 0.55 * seam;
	s.wrap = 0.2;
	s.specTint = vec3( 1.0 );
	s.gloss = 0.35;
	s.specAmt = 0.08 * ( 1.0 - seam );
	s.alpha = 1.0;
	return s;
`,
    extraLight: opts.warm
      ? /* glsl */ `
	return warmLights( vWorldPos, s );
`
      : undefined,
    bump: {
      height: /* glsl */ `
	vec3 q = p * ${gs};
	float grain = ( fbm3( vec3( q.x * 2.6, q.y * 0.35, q.z * 2.6 ) ) - 0.5 ) * 0.09 + snoise( vec3( q.x * 14.0, q.y * 1.6, q.z * 14.0 ) ) * 0.015;
	${seams ? 'float sm = 1.0 - smoothstep( 0.0, 0.45, plankSeam( p, N, SEAM_S, SEAM_AXIS ) );' : 'float sm = 0.0;'}
	return grain - 0.5 * sm;
`,
      scale: 1,
      feature: 1.2,
    },
  });
}
/** 砖墙 / 烟囱：按法线主轴投影的错缝砖 + 灰缝，每块砖颜色带确定性变化。 */
export function brickMaterial(lighting: LightingUniforms, brick: string = PALETTE.brick, mortar: string = PALETTE.mortar, opts: { warm?: boolean; size?: [number, number]; snow?: boolean } = {}): ReturnType<typeof makeLitMaterial> {
  const [BL, BH] = opts.size ?? [21, 7];
  return makeLitMaterial({
    lighting,
    defines: { BRICK_L: BL.toFixed(1), BRICK_H: BH.toFixed(1) },
    uniforms: { uBrick: { value: rgb(brick) }, uMortar: { value: rgb(mortar) }, uSnowCol: { value: rgb(PALETTE.snow) }, ...(opts.warm ? warmUniforms() : {}) },
    fragmentPars: /* glsl */ `
${VORONOI_GLSL}
${BRICK_GLSL}
uniform vec3 uBrick;
uniform vec3 uMortar;
uniform vec3 uSnowCol;
${opts.warm ? WARM_LIGHT_GLSL : ''}
`,
    surface: /* glsl */ `
	// 灰缝真正凹进去吃光（凹凸法线 + 缝里压 AO），砖面带烧制色差和砂砾
	vec3 bp = brickPattern( faceUV( vWorldPos, N ) );
	float m = bp.y;
	float h = bp.z;
	vec3 alb = uBrick * ( 0.78 + 0.4 * h );
	alb = mix( alb, alb * vec3( 1.15, 0.95, 0.85 ), step( 0.8, h ) );
	alb = mix( alb, alb * vec3( 0.9, 0.86, 0.84 ), step( 0.93, hash13( vec3( h * 53.0, 0.0, 1.0 ) ) ) );
	alb = mix( alb, uMortar * ( 0.9 + 0.1 * h ), m );
	float grain = snoise( vWorldPos * 20.0 ) * 0.5 + 0.5;
	alb *= ( 0.94 + 0.08 * grain ) * ( 1.0 - 0.25 * m );
	float sn = smoothstep( 0.62, 0.86, N.y + ( grain - 0.5 ) * 0.25 );
	Surf s;
	s.albedo = mix( alb, uSnowCol, ${opts.snow === false ? '0.0' : 'sn'} );
	s.ao = 1.0 - 0.45 * m;
	s.wrap = 0.25;
	s.specTint = vec3( 1.0 );
	s.gloss = 0.15;
	s.specAmt = 0.03;
	s.alpha = 1.0;
	return s;
`,
    bump: { height: 'return brickPattern( faceUV( p, N ) ).x;', scale: 1, feature: 1.5 },
    extraLight: opts.warm
      ? /* glsl */ `
	return warmLights( vWorldPos, s );
`
      : undefined,
  });
}

/**
 * 人字拼红砖地（阳光房室内，无雪）：平面按 (cx+cy) mod 4 决定格子属于横砖还是竖砖以及砖的原点，
 * 砖 40 × 20、灰缝 1 cm，每块砖带色差与磨损。
 */
export function herringboneMaterial(lighting: LightingUniforms): ReturnType<typeof makeLitMaterial> {
  return makeLitMaterial({
    lighting,
    uniforms: { uBrick: { value: rgb('#a6513a') }, uBrick2: { value: rgb('#8d3f2e') }, uMortar: { value: rgb('#b9ad98') }, ...warmUniforms() },
    fragmentPars: /* glsl */ `
${VORONOI_GLSL}
${HERRING_GLSL}
uniform vec3 uBrick;
uniform vec3 uBrick2;
uniform vec3 uMortar;
${WARM_LIGHT_GLSL}
`,
    surface: /* glsl */ `
	vec3 hp = herringPattern( vWorldPos.xz );
	float m = hp.y;
	float h = hp.z;
	vec3 alb = mix( uBrick, uBrick2, h );
	alb *= 0.9 + 0.2 * hash13( vec3( floor( vWorldPos.xz / 20.0 ), 1.3 ) );
	float wear = fbm3( vec3( vWorldPos.xz * 0.12, 3.0 ) );
	alb = mix( alb, alb * vec3( 1.12, 1.08, 1.0 ), wear * 0.5 );
	alb = mix( alb, uMortar * ( 0.85 + 0.15 * h ), m );
	Surf s;
	s.albedo = alb * ( 1.0 - 0.2 * m );
	s.ao = 1.0 - 0.4 * m;
	s.wrap = 0.3;
	s.specTint = vec3( 1.0 );
	s.gloss = 0.3;
	s.specAmt = 0.06;
	s.alpha = 1.0;
	return s;
`,
    bump: { height: 'return herringPattern( p.xz ).x;', scale: 1, feature: 1.5 },
    extraLight: /* glsl */ `
	return warmLights( vWorldPos, s );
`,
  });
}

/** 铁艺 / 金属：深铁灰，高光硬。 */
export function metalMaterial(lighting: LightingUniforms, color = PALETTE.iron): ReturnType<typeof makeLitMaterial> {
  return makeLitMaterial({
    lighting,
    uniforms: { uColor: { value: rgb(color) } },
    fragmentPars: /* glsl */ `
uniform vec3 uColor;
`,
    surface: /* glsl */ `
	float g = snoise( vWorldPos * 12.0 ) * 0.5 + 0.5;
	Surf s;
	s.albedo = uColor * ( 0.9 + 0.2 * g );
	s.ao = 1.0;
	s.wrap = 0.1;
	s.specTint = vec3( 1.0 );
	s.gloss = 0.75;
	s.specAmt = 0.35;
	s.alpha = 1.0;
	return s;
`,
  });
}

/** 红陶花盆：陶土色带环向色差和白色水渍。 */
export function terracottaMaterial(lighting: LightingUniforms): ReturnType<typeof makeLitMaterial> {
  return makeLitMaterial({
    lighting,
    uniforms: { uColor: { value: rgb(PALETTE.terracotta) }, ...warmUniforms() },
    fragmentPars: /* glsl */ `
uniform vec3 uColor;
${WARM_LIGHT_GLSL}
`,
    bump: { height: 'return snoise( p * 11.0 ) * 0.04 + snoise( p * 40.0 ) * 0.012;', scale: 1, feature: 1.2 },
    surface: /* glsl */ `
	float g = snoise( vWorldPos * 6.0 ) * 0.5 + 0.5;
	float ring = snoise( vec3( vWorldPos.y * 3.0, 1.7, 2.3 ) ) * 0.5 + 0.5;
	float lime = smoothstep( 0.62, 0.8, fbm3( vWorldPos * 0.9 + 9.0 ) ) * smoothstep( 0.2, 0.9, N.y );
	Surf s;
	s.albedo = mix( uColor * ( 0.85 + 0.25 * g ) * ( 0.95 + 0.08 * ring ), vec3( 0.86, 0.83, 0.76 ), lime * 0.5 );
	s.ao = 1.0;
	s.wrap = 0.25;
	s.specTint = vec3( 1.0 );
	s.gloss = 0.25;
	s.specAmt = 0.06;
	s.alpha = 1.0;
	return s;
`,
    extraLight: /* glsl */ `
	return warmLights( vWorldPos, s );
`,
  });
}

/** 汀步石板：青灰花岗岩，顶面积雪、侧面露石头。 */
export function stoneMaterial(lighting: LightingUniforms): ReturnType<typeof makeLitMaterial> {
  return makeLitMaterial({
    lighting,
    uniforms: { uColor: { value: rgb(PALETTE.stone) }, uSnowCol: { value: rgb(PALETTE.snow) } },
    fragmentPars: /* glsl */ `
uniform vec3 uColor;
uniform vec3 uSnowCol;
`,
    bump: { height: 'return ( fbm3( p * 1.8 ) - 0.5 ) * 0.35 + snoise( p * 22.0 ) * 0.04;', scale: 1, feature: 3 },
    surface: /* glsl */ `
	float g = fbm3( vWorldPos * 1.8 );
	float sp = step( 0.9, hash13( floor( vWorldPos * 30.0 ) ) );
	vec3 alb = uColor * ( 0.82 + 0.3 * g ) + vec3( 0.12 ) * sp;
	float sn = smoothstep( 0.45, 0.75, N.y + ( g - 0.5 ) * 0.5 );
	Surf s;
	s.albedo = mix( alb, uSnowCol, sn );
	s.ao = 1.0;
	s.wrap = 0.3;
	s.specTint = vec3( 1.0 );
	s.gloss = mix( 0.35, 0.55, sn );
	s.specAmt = mix( 0.08, 0.14, sn );
	s.alpha = 1.0;
	return s;
`,
  });
}

/** 洋房窗玻璃：不透视（屋内另有生活），深蓝灰反光 + aLit 控制的暖光窗（窗帘条纹）。 */
/** 洋房窗玻璃：室内暖光分层（窗根最亮 / 帘褶 / 没亮的窗是深蓝黑的房间）+ 天空的斜向反光（掠射越亮、每扇窗一道斜亮带）。 */
export function windowGlassMaterial(lighting: LightingUniforms): ReturnType<typeof makeLitMaterial> {
  return makeLitMaterial({
    lighting,
    side: DoubleSide,
    uniforms: { uWarm: { value: rgb('#ffc17a') }, uSkyHi: { value: rgb('#9fb4d6') }, uSkyLo: { value: rgb('#dfe6ee') } },
    vertexPars: /* glsl */ `
attribute float aLit;
attribute vec3 aWin;
varying float vLit;
varying vec3 vWin;
varying vec2 vUv;
`,
    vertexMain: /* glsl */ `
	vLit = aLit;
	vWin = aWin;
	vUv = uv;
`,
    fragmentPars: /* glsl */ `
uniform vec3 uWarm;
uniform vec3 uSkyHi;
uniform vec3 uSkyLo;
varying float vLit;
varying vec3 vWin;
varying vec2 vUv;
float windowCurtain( vec3 p ) { return 0.75 + 0.25 * snoise( vec3( p.x * 0.35, p.y * 0.35, 1.0 ) ); }
`,
    surface: /* glsl */ `
	// v：0 窗根 → 1 窗顶；帘褶按窗面横向坐标一道道
	float v = clamp( ( vWorldPos.y - vWin.x ) / max( vWin.y - vWin.x, 1.0 ), 0.0, 1.0 );
	float folds = 0.5 + 0.5 * sin( ( vWorldPos.x + vWorldPos.z ) * 0.9 + vWin.z * 6.2831853 );
	float curtain = windowCurtain( vWorldPos );
	// 屋里的灯在下面：窗根最亮、往窗顶淡；帘褶一道道明暗；没亮的窗是深蓝黑的房间，只留一点帘子的起伏
	vec3 room = uWarm * vLit * ( 0.4 + 0.6 * pow( 1.0 - v, 1.6 ) ) * ( 0.7 + 0.3 * curtain ) * ( 0.78 + 0.22 * folds );
	// 没亮的窗是深蓝黑的房间（留着帘子的起伏），亮灯的窗在它上面叠暖光——按 vLit 混，不能写死 1.0
	vec3 dark = vec3( 0.05, 0.07, 0.1 ) * ( 0.8 + 0.2 * curtain );
	// 窗洞内凹：玻璃离窗框 4 cm，框在玻璃四周压一圈暗影
	float edge = min( min( vUv.x, 1.0 - vUv.x ) * 110.0, min( vUv.y, 1.0 - vUv.y ) * 150.0 );
	float reveal = 0.45 + 0.55 * smoothstep( 0.0, 9.0, edge );
	Surf s;
	s.albedo = ( dark + room ) * reveal;
	s.ao = 1.0;
	s.wrap = 0.0;
	s.specTint = vec3( 1.0 );
	s.gloss = 0.88;
	s.specAmt = 0.55;
	s.alpha = 1.0;
	return s;
`,
    extraLight: /* glsl */ `
	// 天空斜向反光：视线越掠越亮；玻璃面上斜着一道天光的亮带（和窗框约 30°），每扇窗相位不同
	vec3 R = reflect( -V, N );
	float fres = 0.06 + 0.6 * pow( 1.0 - max( dot( N, V ), 0.0 ), 3.0 );
	vec3 sky = mix( uSkyLo, uSkyHi, clamp( R.y, 0.0, 1.0 ) );
	float diag = dot( vec2( vWorldPos.x + vWorldPos.z, vWorldPos.y ), vec2( 0.86, 0.5 ) ) * 0.07 + vWin.z * 6.2831853;
	float band = smoothstep( 0.55, 1.0, sin( diag ) ) * 0.35;
	return sky * ( fres * 0.9 + band * ( 0.35 + 0.65 * fres ) ) + uWarm * vLit * 0.35 * ( 0.8 + 0.2 * windowCurtain( vWorldPos ) );
`,
  });
}

/** 绿叶（双面）：aColor 顶点色 + 叶脉（uv：u 横向 0..1、v 沿叶长）+ 蜡质高光 + 逆光透光。 */
export function leafMaterial(lighting: LightingUniforms, opts: { warm?: boolean; translucent?: number } = {}): ReturnType<typeof makeLitMaterial> {
  return makeLitMaterial({
    lighting,
    side: DoubleSide,
    uniforms: { ...warmUniforms() },
    vertexPars: /* glsl */ `
attribute vec3 aColor;
varying vec3 vCol;
varying vec2 vUv;
`,
    vertexMain: /* glsl */ `
	vCol = aColor;
	vUv = uv;
`,
    fragmentPars: /* glsl */ `
varying vec3 vCol;
varying vec2 vUv;
${opts.warm ? WARM_LIGHT_GLSL : ''}
`,
    surface: /* glsl */ `
	float mid = exp( -abs( vUv.x - 0.5 ) * 28.0 );
	float lat = 1.0 - smoothstep( 0.0, 0.045, abs( fract( vUv.y * 7.0 + abs( vUv.x - 0.5 ) * 1.6 ) - 0.5 ) - 0.4 );
	float vein = max( mid, lat * 0.6 ) * smoothstep( 0.0, 0.15, vUv.y );
	float g = snoise( vWorldPos * 25.0 ) * 0.5 + 0.5;
	Surf s;
	s.albedo = mix( vCol * ( 0.9 + 0.12 * g ), vCol * 1.35 + vec3( 0.04 ), vein * 0.7 );
	s.ao = 1.0;
	s.wrap = 0.45;
	s.specTint = vec3( 1.0 );
	s.gloss = 0.6;
	s.specAmt = 0.28;
	s.alpha = 1.0;
	return s;
`,
    extraLight: /* glsl */ `
	float back = pow( max( dot( -V, uSunDir ), 0.0 ), 1.5 );
	vec3 c = vCol * uSunColor * back * ${((opts.translucent ?? 0.35)).toFixed(2)} * sunShadow();
	c += vCol * uSkyColor * 0.15 * ( 1.0 - 0.5 * abs( N.y ) );
	${opts.warm ? 'c += warmLights( vWorldPos, s );' : ''}
	return c;
`,
  });
}

/** 花瓣（双面）：aColor 顶点色，柔和次表面透光。 */
export function petalMaterial(lighting: LightingUniforms): ReturnType<typeof makeLitMaterial> {
  return makeLitMaterial({
    lighting,
    side: DoubleSide,
    uniforms: { ...warmUniforms() },
    vertexPars: /* glsl */ `
attribute vec3 aColor;
varying vec3 vCol;
varying vec2 vUv;
`,
    vertexMain: /* glsl */ `
	vCol = aColor;
	vUv = uv;
`,
    fragmentPars: /* glsl */ `
varying vec3 vCol;
varying vec2 vUv;
${WARM_LIGHT_GLSL}
`,
    surface: /* glsl */ `
	Surf s;
	s.albedo = mix( vCol * 0.9, vCol * 1.1, smoothstep( 0.2, 0.9, vUv.y ) );
	s.ao = 1.0;
	s.wrap = 0.6;
	s.specTint = vec3( 1.0 );
	s.gloss = 0.35;
	s.specAmt = 0.1;
	s.alpha = 1.0;
	return s;
`,
    extraLight: /* glsl */ `
	float back = pow( max( dot( -V, uSunDir ), 0.0 ), 1.2 );
	vec3 c = vCol * uSunColor * back * 0.3 * sunShadow();
	c += warmLights( vWorldPos, s );
	return c;
`,
  });
}

/** 茎 / 花梗（深绿到褐）。 */
export function stemMaterial(lighting: LightingUniforms, color = '#4f6a2c'): ReturnType<typeof makeLitMaterial> {
  return makeLitMaterial({
    lighting,
    uniforms: { uColor: { value: rgb(color) }, ...warmUniforms() },
    fragmentPars: /* glsl */ `
uniform vec3 uColor;
${WARM_LIGHT_GLSL}
`,
    surface: /* glsl */ `
	Surf s;
	s.albedo = uColor * ( 0.9 + 0.2 * ( snoise( vWorldPos * 30.0 ) * 0.5 + 0.5 ) );
	s.ao = 1.0;
	s.wrap = 0.4;
	s.specTint = vec3( 1.0 );
	s.gloss = 0.4;
	s.specAmt = 0.1;
	s.alpha = 1.0;
	return s;
`,
    extraLight: /* glsl */ `
	return warmLights( vWorldPos, s );
`,
  });
}

/** 盆土：深褐颗粒。 */
export function soilMaterial(lighting: LightingUniforms): ReturnType<typeof makeLitMaterial> {
  return makeLitMaterial({
    lighting,
    uniforms: { ...warmUniforms() },
    fragmentPars: WARM_LIGHT_GLSL,
    surface: /* glsl */ `
	float g = fbm3( vWorldPos * 18.0 );
	Surf s;
	s.albedo = vec3( 0.16, 0.11, 0.07 ) * ( 0.7 + 0.6 * g );
	s.ao = 1.0;
	s.wrap = 0.3;
	s.specTint = vec3( 1.0 );
	s.gloss = 0.1;
	s.specAmt = 0.02;
	s.alpha = 1.0;
	return s;
`,
    extraLight: /* glsl */ `
	return warmLights( vWorldPos, s );
`,
  });
}

/** 水（陶盘里的清水）：深色强反光。 */
export function waterMaterial(lighting: LightingUniforms): ReturnType<typeof makeLitMaterial> {
  return makeLitMaterial({
    lighting,
    uniforms: { ...warmUniforms() },
    fragmentPars: WARM_LIGHT_GLSL,
    surface: /* glsl */ `
	Surf s;
	s.albedo = vec3( 0.1, 0.13, 0.14 );
	s.ao = 1.0;
	s.wrap = 0.0;
	s.specTint = vec3( 1.0 );
	s.gloss = 0.95;
	s.specAmt = 0.8;
	s.alpha = 1.0;
	return s;
`,
    extraLight: /* glsl */ `
	return warmLights( vWorldPos, s );
`,
  });
}

/** 自己发光的东西（灯笼玻璃、灯泡串、壁灯）：不参与光照，直接输出暖色。 */
export function glowMaterial(color = PALETTE.glow, intensity = 2.2): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { uColor: { value: new Color(color).multiplyScalar(intensity) } },
    vertexShader: /* glsl */ `
varying vec3 vN;
varying vec3 vV;
void main() {
	vec4 wp = modelMatrix * vec4( position, 1.0 );
	vN = normalize( mat3( modelMatrix ) * normal );
	vV = normalize( cameraPosition - wp.xyz );
	gl_Position = projectionMatrix * viewMatrix * wp;
}
`,
    fragmentShader: /* glsl */ `
uniform vec3 uColor;
varying vec3 vN;
varying vec3 vV;
void main() {
	float f = pow( 1.0 - abs( dot( normalize( vN ), normalize( vV ) ) ), 1.5 );
	gl_FragColor = vec4( uColor * ( 0.75 + 0.6 * f ), 1.0 );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}
`,
  });
}

/** 电线：深色橡胶皮，朝上一面挂一层薄雪（真电线的雪线）。 */
export function wireMaterial(lighting: LightingUniforms): ReturnType<typeof makeLitMaterial> {
  return makeLitMaterial({
    lighting,
    side: DoubleSide,
    uniforms: { uSnowCol: { value: rgb(PALETTE.snow) } },
    fragmentPars: /* glsl */ `
uniform vec3 uSnowCol;
`,
    surface: /* glsl */ `
	Surf s;
	float sn = smoothstep( 0.35, 0.7, N.y + ( snoise( vWorldPos * 2.0 ) - 0.5 ) * 0.3 );
	s.albedo = mix( vec3( 0.05, 0.05, 0.06 ), uSnowCol, sn );
	s.ao = 1.0;
	s.wrap = 0.3;
	s.specTint = vec3( 1.0 );
	s.gloss = 0.4;
	s.specAmt = 0.08;
	s.alpha = 1.0;
	return s;
`,
  });
}

/** 越冬红浆果：深红半透的小果子，顶上一顶薄雪帽。 */
export function berryMaterial(lighting: LightingUniforms): ReturnType<typeof makeLitMaterial> {
  return makeLitMaterial({
    lighting,
    uniforms: { uSnowCol: { value: rgb(PALETTE.snow) } },
    fragmentPars: /* glsl */ `
uniform vec3 uSnowCol;
`,
    surface: /* glsl */ `
	Surf s;
	float sn = smoothstep( 0.55, 0.8, N.y );
	s.albedo = mix( vec3( 0.42, 0.04, 0.05 ), uSnowCol, sn );
	s.ao = 1.0;
	s.wrap = 0.35;
	s.specTint = vec3( 1.0 );
	s.gloss = 0.7;
	s.specAmt = 0.3;
	s.alpha = 1.0;
	return s;
`,
    extraLight: /* glsl */ `
	float back = pow( max( dot( -V, uSunDir ), 0.0 ), 1.5 );
	return vec3( 0.6, 0.08, 0.06 ) * uSunColor * back * 0.35 * sunShadow();
`,
  });
}

/** 铸铁珐琅白漆（大植物园的柱 / 拱架 / 檩条）：奶白漆面带一点暖灰的积尘和窗下的雨痕，漆面高光柔。 */
export function enamelMaterial(lighting: LightingUniforms, opts: { warm?: boolean } = {}): ReturnType<typeof makeLitMaterial> {
  return makeLitMaterial({
    lighting,
    uniforms: { uPaint: { value: rgb('#ece8df') }, uDirt: { value: rgb('#b9b2a3') }, uSnowCol: { value: rgb(PALETTE.snow) }, ...(opts.warm ? warmUniforms() : {}) },
    fragmentPars: /* glsl */ `
uniform vec3 uPaint;
uniform vec3 uDirt;
uniform vec3 uSnowCol;
${opts.warm ? WARM_LIGHT_GLSL : ''}
`,
    surface: /* glsl */ `
	float g = snoise( vWorldPos * 1.7 ) * 0.5 + 0.5;
	float fine = snoise( vWorldPos * 38.0 ) * 0.5 + 0.5;
	float dirt = smoothstep( 0.55, 0.9, fbm3( vWorldPos * 0.9 + vec3( 3.1, 1.7, 0.4 ) ) ) * 0.35;
	// 朝上的面挂一层薄雪 / 霜
	float sn = smoothstep( 0.72, 0.9, N.y + ( g - 0.5 ) * 0.25 ) * 0.55;
	Surf s;
	s.albedo = mix( mix( uPaint, uDirt, dirt ) * ( 0.95 + 0.05 * fine ), uSnowCol, sn );
	s.ao = 1.0 - 0.12 * dirt;
	s.wrap = 0.3;
	s.specTint = vec3( 1.0 );
	s.gloss = mix( 0.55, 0.4, sn );
	s.specAmt = mix( 0.16, 0.1, sn );
	s.alpha = 1.0;
	return s;
`,
    extraLight: opts.warm
      ? /* glsl */ `
	return warmLights( vWorldPos, s );`
      : undefined,
  });
}

/**
 * 温室里的春日泥土草坪微地形：平缓处是嫩绿的草坪底色（草叶本身是实例化的），坡面 / 汀步边露出深褐的湿土，
 * 低洼处一圈深色的腐殖土，表面带细颗粒和苔藓斑。
 */
export function springGroundMaterial(lighting: LightingUniforms, petalCenter: [number, number, number] = [1050, -350, 420]): ReturnType<typeof makeLitMaterial> {
  return makeLitMaterial({
    lighting,
    uniforms: { ...warmUniforms(), uPetalC: { value: petalCenter } },
    fragmentPars: /* glsl */ `
${VORONOI_GLSL}
${SOIL_BUMP}
uniform vec3 uPetalC;
${WARM_LIGHT_GLSL}
`,
    surface: /* glsl */ `
	vec2 xz = vWorldPos.xz;
	float g = snoise( vec3( xz * 0.012, 1.7 ) ) * 0.5 + 0.5;
	float patches = fbm3( vec3( xz * 0.05, 3.0 ) );
	float fine = snoise( vec3( xz * 0.5, 7.0 ) ) * 0.5 + 0.5;
	float slope = 1.0 - N.y;
	// 腐殖土：深褐、湿处发黑、细颗粒
	vec3 humus = mix( vec3( 0.105, 0.066, 0.038 ), vec3( 0.05, 0.032, 0.018 ), smoothstep( 0.45, 0.75, fbm3( vec3( xz * 0.02, 9.0 ) ) ) ) * ( 0.7 + 0.55 * fine );
	// 苔藓斑：暗绿带一点黄，只在平缓处成片
	vec3 moss = mix( vec3( 0.085, 0.16, 0.045 ), vec3( 0.13, 0.21, 0.055 ), g ) * ( 0.85 + 0.3 * fine );
	float mossK = smoothstep( 0.42, 0.6, patches ) * ( 1.0 - smoothstep( 0.04, 0.14, slope ) );
	vec3 alb = mix( humus, moss, mossK );
	// 散落的枯叶：7 cm 的小格里少数几格躺一片椭圆的叶子（朝向 / 长短按格随机）
	vec4 lf = voronoi2( xz / 7.0, 0.9 );
	vec2 lr = fract( xz / 7.0 ) - 0.5 - ( hash22( lf.zw ) - 0.5 ) * 0.9;
	float la = hash13( vec3( lf.zw, 4.0 ) ) * 6.2831853;
	vec2 ld = vec2( dot( lr, vec2( cos( la ), sin( la ) ) ), dot( lr, vec2( -sin( la ), cos( la ) ) ) ) * vec2( 1.0, 0.5 );
	float leaf = step( 0.8, hash13( vec3( lf.zw, 2.0 ) ) ) * ( 1.0 - smoothstep( 0.3, 0.36, length( ld ) ) );
	vec3 leafCol = mix( vec3( 0.32, 0.17, 0.06 ), vec3( 0.45, 0.28, 0.1 ), hash13( vec3( lf.zw, 6.0 ) ) );
	// 落瓣：主海棠脚下一圈粉白花瓣（uPetalC = 树根 x, z, 散落半径）
	float pd = length( xz - uPetalC.xy );
	float petalZone = 1.0 - smoothstep( uPetalC.z * 0.35, uPetalC.z, pd );
	float petal = step( 0.55, hash13( vec3( lf.zw, 8.0 ) ) ) * petalZone * ( 1.0 - smoothstep( 0.26, 0.32, length( ld * vec2( 0.75, 1.0 ) ) ) );
	vec3 petalCol = mix( vec3( 0.86, 0.56, 0.6 ), vec3( 0.95, 0.86, 0.88 ), hash13( vec3( lf.zw, 9.0 ) ) );
	alb = mix( alb, leafCol, leaf );
	alb = mix( alb, petalCol, petal );
	alb = mix( alb, humus * 0.9, smoothstep( 0.05, 0.15, slope ) );
	Surf s;
	s.albedo = alb;
	s.ao = 1.0 - 0.25 * mossK - 0.1 * smoothstep( 0.04, 0.14, slope );
	s.wrap = 0.5;
	s.specTint = vec3( 1.0 );
	s.gloss = 0.2;
	s.specAmt = 0.04 + 0.05 * smoothstep( 0.45, 0.75, fbm3( vec3( xz * 0.02, 9.0 ) ) );
	s.alpha = 1.0;
	return s;
`,
    extraLight: /* glsl */ `
	return warmLights( vWorldPos, s );
`,
    bump: { height: 'return soilHeight( p );', scale: 1, feature: 2.5 },
  });
}
/** 冰柱（屋檐下）：半透的青白冰，里面一道气泡的浊心，尖端更透。 */
export function iceMaterial(lighting: LightingUniforms): ReturnType<typeof makeLitMaterial> {
  return makeLitMaterial({
    lighting,
    side: DoubleSide,
    transparent: true,
    depthWrite: false,
    uniforms: { uIce: { value: rgb('#dfeaf5') } },
    vertexPars: /* glsl */ `
attribute float aTip;
varying float vTip;
`,
    vertexMain: /* glsl */ `
	vTip = aTip;
`,
    fragmentPars: /* glsl */ `
uniform vec3 uIce;
varying float vTip;
`,
    surface: /* glsl */ `
	float n = snoise( vWorldPos * 18.0 ) * 0.5 + 0.5;
	Surf s;
	s.albedo = uIce * ( 0.85 + 0.15 * n );
	s.ao = 0.9;
	s.wrap = 0.6;
	s.specTint = vec3( 1.0 );
	s.gloss = 0.75;
	s.specAmt = 0.5;
	s.alpha = mix( 0.72, 0.35, vTip );
	return s;
`,
    extraLight: /* glsl */ `
	// 逆光透出的青白
	float back = pow( max( dot( -V, uSunDir ), 0.0 ), 2.0 );
	return vec3( 0.75, 0.88, 1.0 ) * uSunColor * back * 0.45 * ( 0.5 + 0.5 * vTip ) * sunShadow();
`,
  });
}

/** 远景覆雪松柏剪影：墨绿的针叶团 + 挂在每层锥上半截的雪，随距离化进天光（和远雪野同一套雾化）。
 *  噪声只用整棵树 / 针叶团两种低频：远处 20~40 m 的厘米级噪声只会闪成麻点。 */
export function pineFarMaterial(lighting: LightingUniforms): ReturnType<typeof makeLitMaterial> {
  return makeLitMaterial({
    lighting,
    uniforms: { uNeedle: { value: rgb('#1b3129') }, uNeedleLit: { value: rgb('#2e4a3e') }, uSnowCol: { value: rgb(PALETTE.snow) }, uHaze: { value: rgb('#c9d2dc').multiplyScalar(0.9) } },
    vertexPars: /* glsl */ `
varying float vTier;
`,
    vertexMain: /* glsl */ `
	vTier = uv.y;
`,
    fragmentPars: /* glsl */ `
uniform vec3 uNeedle;
uniform vec3 uNeedleLit;
uniform vec3 uSnowCol;
uniform vec3 uHaze;
varying float vTier;
`,
    surface: /* glsl */ `
	float g = snoise( vWorldPos * 0.025 ) * 0.5 + 0.5;
	float fine = snoise( vWorldPos * 0.11 ) * 0.5 + 0.5;
	// 雪：挂在每层锥的上半截，整棵树尺度的噪声决定哪几层雪厚
	float sn = smoothstep( 0.4, 0.8, vTier * 0.72 + 0.22 * g );
	Surf s;
	s.albedo = mix( mix( uNeedle, uNeedleLit, g ) * ( 0.88 + 0.12 * fine ), mix( uSnowCol, uHaze, 0.25 ), sn * 0.85 );
	s.ao = 0.9;
	s.wrap = 0.5;
	s.specTint = vec3( 1.0 );
	s.gloss = 0.2;
	s.specAmt = 0.03;
	float h = smoothstep( 2500.0, 7000.0, distance( vWorldPos, cameraPosition ) );
	s.albedo *= 1.0 - 0.7 * h;
	s.alpha = 1.0;
	return s;
`,
    extraLight: /* glsl */ `
	float h = smoothstep( 2500.0, 7000.0, distance( vWorldPos, cameraPosition ) );
	return uHaze * ( 0.55 + 0.45 * uSkyColor ) * h;
`,
  });
}

/** 全部庭院材质一次建齐（同类只建一份 → 同类零碎几何全部合批成一次绘制）。 */
export class CourtyardMaterials {
  readonly snow: ReturnType<typeof makeLitMaterial>;
  readonly snowFar: ReturnType<typeof makeLitMaterial>;
  readonly snowWarm: ReturnType<typeof makeLitMaterial>;
  readonly wire: ReturnType<typeof makeLitMaterial>;
  readonly berry: ReturnType<typeof makeLitMaterial>;
  readonly stucco: ReturnType<typeof makeLitMaterial>;
  readonly walnut: ReturnType<typeof makeLitMaterial>;
  readonly cedar: ReturnType<typeof makeLitMaterial>;
  readonly cedarWarm: ReturnType<typeof makeLitMaterial>;
  readonly pine: ReturnType<typeof makeLitMaterial>;
  readonly fence: ReturnType<typeof makeLitMaterial>;
  readonly brick: ReturnType<typeof makeLitMaterial>;
  readonly brickWarm: ReturnType<typeof makeLitMaterial>;
  readonly herringbone: ReturnType<typeof makeLitMaterial>;
  readonly metal: ReturnType<typeof makeLitMaterial>;
  readonly terracotta: ReturnType<typeof makeLitMaterial>;
  readonly stone: ReturnType<typeof makeLitMaterial>;
  readonly windowGlass: ReturnType<typeof makeLitMaterial>;
  readonly leaf: ReturnType<typeof makeLitMaterial>;
  readonly petal: ReturnType<typeof makeLitMaterial>;
  readonly stem: ReturnType<typeof makeLitMaterial>;
  readonly soil: ReturnType<typeof makeLitMaterial>;
  readonly water: ReturnType<typeof makeLitMaterial>;
  readonly glow: ShaderMaterial;
  readonly enamel: ReturnType<typeof makeLitMaterial>;
  readonly enamelWarm: ReturnType<typeof makeLitMaterial>;
  readonly springGround: ReturnType<typeof makeLitMaterial>;
  readonly ice: ReturnType<typeof makeLitMaterial>;
  readonly pineFar: ReturnType<typeof makeLitMaterial>;
  /** 错缝砌石（大植物园矮墙 / 石槽：墙根青苔）。 */
  readonly ashlar: ReturnType<typeof makeLitMaterial>;
  /** 洋房台基 / 隅石 / 门口台阶的砌石（室外：墙根霜迹）。 */
  readonly ashlarOut: ReturnType<typeof makeLitMaterial>;
  /** 鹅卵石碎石 + 嵌入青石板的小径面。 */
  readonly path: ReturnType<typeof makeLitMaterial>;
  /** 赤陶路缘砖。 */
  readonly edging: ReturnType<typeof makeLitMaterial>;

  /** prints = 全院雪面共用的雪印管理器（三种雪材质读同一份 uniform）。 */
  constructor(lighting: LightingUniforms, prints: SnowPrints) {
    this.snow = snowMaterial(lighting, { prints: prints.uniform });
    this.snowFar = snowMaterial(lighting, { prints: prints.uniform, haze: true, sparkle: 0.05 });
    this.snowWarm = snowMaterial(lighting, { prints: prints.uniform, warm: true });
    this.wire = wireMaterial(lighting);
    this.berry = berryMaterial(lighting);
    this.stucco = stuccoMaterial(lighting);
    this.walnut = woodMaterial(lighting, '#2e1f16', '#5a3f2c', { seams: { axis: 'u', spacing: 13 } });
    this.cedar = woodMaterial(lighting, '#5a3f26', '#8a653f', { seams: { axis: 'y', spacing: 15 } });
    this.cedarWarm = woodMaterial(lighting, '#5a3f26', '#8a653f', { warm: true });
    this.pine = woodMaterial(lighting, '#8a6a44', '#c09a66', { warm: true });
    this.fence = woodMaterial(lighting, '#6e6254', '#a89a86');
    this.brick = brickMaterial(lighting);
    this.brickWarm = brickMaterial(lighting, PALETTE.brick, PALETTE.mortar, { warm: true });
    this.herringbone = herringboneMaterial(lighting);
    this.metal = metalMaterial(lighting);
    this.terracotta = terracottaMaterial(lighting);
    this.stone = stoneMaterial(lighting);
    this.windowGlass = windowGlassMaterial(lighting);
    this.leaf = leafMaterial(lighting, { warm: true });
    this.petal = petalMaterial(lighting);
    this.stem = stemMaterial(lighting);
    this.soil = soilMaterial(lighting);
    this.water = waterMaterial(lighting);
    this.glow = glowMaterial();
    this.enamel = enamelMaterial(lighting);
    this.enamelWarm = enamelMaterial(lighting, { warm: true });
    this.springGround = springGroundMaterial(lighting);
    this.ice = iceMaterial(lighting);
    this.pineFar = pineFarMaterial(lighting);
    this.ashlar = ashlarMaterial(lighting, { moss: true, baseY: -72 });
    this.ashlarOut = ashlarMaterial(lighting, { moss: false, baseY: HOUSE.floors[0], block: [40, 20], color: '#87888b' });
    this.path = pathStoneMaterial(lighting);
    // 路缘砖：一盒 20 × 7 × 10 就是一块砖（砖纹按 20 × 10 划分，砖缝只落在盒与盒之间）
    this.edging = brickMaterial(lighting, '#a85a3a', '#8c5a42', { size: [20, 10], snow: false });
  }
}
