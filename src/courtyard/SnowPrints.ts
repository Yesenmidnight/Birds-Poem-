/**
 * 雪印：鸟在覆雪面落地 / 蹬地起飞时在双脚中心踩出的坑（2026-11-23 第三轮「雪痕微交互」的落地版）。
 *
 * 32 槽环形缓冲 uniform uSnowPrints[32] = vec4(x, y, z, strength)（世界坐标 cm；strength ≤ 0 = 空槽），
 * 雪材质（materials.ts snowMaterial，院里全部雪面共用）读同一份 uniform：
 *   - 顶点着色器沿法线下压一个半径 7 cm 的浅陷坑（给 15~35 cm 的粗网格一点真实的几何起伏）；
 *   - 片元 bumpHeight 画碗状爪印（中心下陷 PRINT_DEPTH、边缘微隆 PRINT_RIM，glsl 见 SNOW_PRINT_GLSL）；
 *   - 坑里冷蓝 AO 压暗 15%、高光减弱（surface() 里做）。
 * 槽位按时间衰减（PRINT_LIFE 秒后被雪填平），写新印时挑 strength 最低（空 / 最旧）的槽。
 */
import { Vector4 } from 'three';

export const SNOW_PRINTS = 32;
/** 一个印从踩下到被雪填平的时间（秒）。 */
export const PRINT_LIFE = 110;
/** 碗状印的半径 / 中心下陷 / 边缘微隆（cm）。 */
export const PRINT_RADIUS = 3.2;
export const PRINT_DEPTH = 1.2;
export const PRINT_RIM = 0.25;

const f = (v: number): string => v.toFixed(2);

/** 雪印场：p = 世界坐标；返回 (高度 cm，带符号；坑内遮蔽 0..1)。雪材质的顶点 / 片元着色器共用。 */
export const SNOW_PRINT_GLSL = /* glsl */ `
uniform vec4 uSnowPrints[${SNOW_PRINTS}];
vec2 snowPrintField( vec3 p ) {
	float h = 0.0;
	float occ = 0.0;
	for ( int i = 0; i < ${SNOW_PRINTS}; i++ ) {
		vec4 pr = uSnowPrints[ i ];
		if ( pr.w <= 0.002 ) continue;
		float r = length( p - pr.xyz );
		if ( r > 4.4 ) continue;
		float bowl = 1.0 - smoothstep( 0.9, ${f(PRINT_RADIUS)}, r );
		float rim = smoothstep( ${f(PRINT_RADIUS - 0.3)}, ${f(PRINT_RADIUS + 0.4)}, r ) * ( 1.0 - smoothstep( ${f(PRINT_RADIUS + 0.4)}, 4.2, r ) );
		h += pr.w * ( ${f(-PRINT_DEPTH)} * bowl + ${f(PRINT_RIM)} * rim );
		occ = max( occ, pr.w * ( 1.0 - smoothstep( 0.0, ${f(PRINT_RADIUS)}, r ) ) );
	}
	return vec2( h, occ );
}
`;

/** 顶点着色器段（makeLitMaterial 的 vertexMain）：pos 沿物体法线下压，粗网格上给雪印一点真实的起伏。 */
export const SNOW_PRINT_VERTEX = /* glsl */ `
	{
		vec3 wp = ( modelMatrix * vec4( pos, 1.0 ) ).xyz;
		float dip = 0.0;
		for ( int i = 0; i < ${SNOW_PRINTS}; i++ ) {
			vec4 pr = uSnowPrints[ i ];
			if ( pr.w <= 0.002 ) continue;
			float d = distance( wp, pr.xyz );
			if ( d > 7.0 ) continue;
			dip += pr.w * 0.6 * ( 1.0 - smoothstep( 1.5, 7.0, d ) );
		}
		pos = pos - normal * dip;
	}
`;

export class SnowPrints {
  readonly uniform = { value: Array.from({ length: SNOW_PRINTS }, () => new Vector4(0, 0, 0, 0)) };
  private readonly age = new Float32Array(SNOW_PRINTS).fill(Infinity);
  /** 一共踩过多少个印（自检 / HUD）。 */
  count = 0;

  /** 在 (x, y, z) 踩一个印；2 cm 内已有的印只刷新（落地紧接着蹬地，是同一个坑）。 */
  stamp(x: number, y: number, z: number): void {
    const slots = this.uniform.value;
    let pick = 0;
    for (let i = 0; i < SNOW_PRINTS; i++) {
      const s = slots[i];
      if (s.w > 0 && Math.abs(s.x - x) < 2 && Math.abs(s.y - y) < 1.5 && Math.abs(s.z - z) < 2) {
        this.age[i] = 0;
        s.w = 1;
        return;
      }
      if (s.w < slots[pick].w) pick = i;
    }
    slots[pick].set(x, y, z, 1);
    this.age[pick] = 0;
    this.count++;
  }

  /** 每帧：strength 1 → 0 线性衰减，到期的槽位清零。 */
  update(dt: number): void {
    const slots = this.uniform.value;
    for (let i = 0; i < SNOW_PRINTS; i++) {
      if (slots[i].w <= 0) continue;
      this.age[i] += dt;
      const k = 1 - this.age[i] / PRINT_LIFE;
      slots[i].w = k > 0 ? k : 0;
    }
  }

  /** 当前还有效的印数。 */
  active(): number {
    return this.uniform.value.reduce((a, s) => a + (s.w > 0 ? 1 : 0), 0);
  }
}
