/**
 * 纯数学 PCG 气流场（GPU 顶点着色器，CPU 每帧只推几个 uniform，零逐草开销）：
 *   输入：小鸟位置 uBirdPos、速度 uBirdVel、扑翼相位 uWingPhase，以及一个 10 点的尾流环形缓冲 uWake[]（xyz = 轨迹点，w = 衰减年龄，< 0 空槽）。
 *   三个分量：
 *     breeze()   温室微风——两个尺度的阵风（世界坐标噪声 × 时间）+ 每株相位的小抖；
 *     翼下气柱   小鸟正下方（离地 0~140 cm）半径随高度张开的气柱，把草叶向两侧推开的位移 + 压矮，带扑翼相位的微颤；
 *     尾流涟漪   每个轨迹点一圈向外扩散的环波（半径 6 + 52·age），随年龄衰减、位移方向来回摆（弹性回弹）；
 *     近场风球   鸟周围 45 cm 内的叶 / 花簇 / 草被翼风掀开（随扑翼相位起伏）——穿过树冠时枝头跟着翻飞摇曳。
 *   airFlow(p, energy) 返回世界位移（cm），energy = 该点局部扰动强度（叶片 / 花簇用它翻飞摇曳）。
 * 春草 / 野花 / 室内树的叶片 / 海棠花簇的全部顶点着色器都 include 这一段；CPU 侧 AirflowField 维护尾流环形缓冲。
 */
import { Vector3, Vector4, type IUniform } from 'three';

export const WAKE_SLOTS = 10;
export const WAKE_LIFE = 2.6;

export const AIRFLOW_GLSL = /* glsl */ `
uniform vec3 uBirdPos;
uniform vec3 uBirdVel;
uniform float uWingPhase;
uniform float uWingOpen;
uniform float uFlowOn;
uniform vec4 uWake[ ${WAKE_SLOTS} ];
uniform float uTime;

// 温室微风：慢阵风 + 快一点的小风，phase 给每株 / 每片自己的小抖
vec3 breeze( vec3 p, float phase ) {
	float t = uTime;
	float a = snoise( vec3( p.x * 0.004 + t * 0.11, p.z * 0.004, 1.7 ) );
	float b = snoise( vec3( p.x * 0.013 + 3.0, p.z * 0.013 - t * 0.23, 4.2 ) );
	float c = snoise( vec3( p.x * 0.05 + phase, p.z * 0.05 + t * 0.9, 9.1 ) );
	float gust = 0.55 + 0.45 * sin( t * 0.37 + p.x * 0.0021 + p.z * 0.0017 );
	return vec3( 0.8, 0.0, 0.45 ) * ( a * 0.9 + b * 0.5 ) * gust + vec3( c * 0.35, 0.0, c * 0.2 );
}

// 小鸟的翼下气流 + 尾流涟漪：返回位移（cm），energy = 局部扰动强度 0..1+（翻飞 / 颤动用）
vec3 airFlow( vec3 p, out float energy ) {
	energy = 0.0;
	vec3 d = vec3( 0.0 );
	if ( uFlowOn < 0.001 ) return d;
	// 1) 翼下气柱：正下方、离地 0..140 cm，半径随高度张开，越靠正下方越强；扑翼微颤
	vec2 dxz = p.xz - uBirdPos.xz;
	float r = length( dxz );
	float below = uBirdPos.y - p.y;
	if ( below > 0.0 && below < 140.0 ) {
		float R = 9.0 + 0.24 * below;
		float k = pow( max( 1.0 - r / R, 0.0 ), 1.6 ) * ( 1.0 - below / 140.0 );
		vec2 dir = r > 0.5 ? dxz / r : vec2( 0.707, 0.707 );
		float flap = 0.78 + 0.22 * sin( uWingPhase * 6.2831853 * 2.0 + r * 0.55 );
		d.xz += dir * 13.0 * k * flap;
		d.y  -= 6.0 * k * flap;
		energy += k;
	}
	// 2) 尾流涟漪：每个轨迹点一圈向外扩散的环波，随年龄衰减、方向来回摆（弹性回弹）
	for ( int i = 0; i < ${WAKE_SLOTS}; i ++ ) {
		vec4 w = uWake[ i ];
		if ( w.w < 0.0 ) continue;
		float age = w.w;
		float ring = 6.0 + 52.0 * age;
		vec2 dw = p.xz - w.xz;
		float rw = length( dw );
		float q = ( rw - ring ) / 11.0;
		float band = exp( - q * q );
		float fade = exp( - age * 1.15 ) * ( 1.0 - smoothstep( 50.0, 90.0, abs( p.y - w.y ) ) );
		vec2 dir = rw > 0.5 ? dw / rw : vec2( 0.707, 0.707 );
		float osc = cos( age * 8.5 );
		d.xz += dir * 10.0 * band * fade * osc;
		d.y  -= 3.5 * band * fade * max( osc, 0.0 );
		energy += band * fade;
	}
	// 3) 近场风球：鸟周围 45 cm 内的叶 / 花簇 / 草被翼风掀开（随扑翼相位起伏），离鸟越近越强
	vec3 db = p - uBirdPos;
	float rb = length( db );
	if ( rb < 45.0 ) {
		float kb = pow( 1.0 - rb / 45.0, 1.5 ) * ( 0.7 + 0.3 * sin( uWingPhase * 6.2831853 * 2.0 + rb * 0.3 ) );
		d += ( db / max( rb, 0.5 ) ) * 9.0 * kb + vec3( 0.0, -3.0 * kb, 0.0 );
		energy += kb;
	}
	// 4) 拨草尾流（2026-11-23 合流后找回）：地面蹦跳穿过长草 / 三叶草 / 蒲公英丛时，身体两侧 30 cm 内的草顺着运动方向被带倒再弹回，
	//    速度越大越明显，只在近地 25 cm 内；乘 uWingOpen 的开合（蹬伸 / 腾空 0.4、站着不动 0）让它一跳一跳地涌，站着不吹
	vec2 hv = uBirdVel.xz;
	float hs = length( hv );
	if ( hs > 15.0 && uWingOpen > 0.01 && abs( db.y ) < 25.0 && rb < 30.0 ) {
		float kv = 1.0 - rb / 30.0;
		kv *= kv * uWingOpen;
		vec2 dir = hv / hs;
		vec2 side = vec2( -dir.y, dir.x );
		float sgn = ( db.x * side.x + db.z * side.y ) >= 0.0 ? 1.0 : -1.0;
		d.xz += ( dir * 0.05 * hs + side * sgn * 0.035 * hs ) * kv;
		energy += kv;
	}
	return d;
}
`;

/** 一组新的气流 uniform（一个场景一份，所有植物材质共享同一个对象）。 */
export function airflowUniforms(): Record<string, IUniform> {
  return {
    uBirdPos: { value: new Vector3(0, -9999, 0) },
    uBirdVel: { value: new Vector3() },
    uWingPhase: { value: 0 },
    uWingOpen: { value: 0 },
    uFlowOn: { value: 1 },
    uTime: { value: 0 },
    uWake: { value: Array.from({ length: WAKE_SLOTS }, () => new Vector4(0, 0, 0, -1)) },
  };
}

/** 轨迹点推进的最小间距（cm）：小鸟每飞过这么远就在尾流里落一个点。 */
const PUSH_DIST = 14;

/**
 * CPU 侧的尾流环形缓冲：setBirdWake(pos, vel, wingPhase) 由可控飞行的小鸟每帧调用（garden.html 的掠飞演示也走它），
 * 鸟每飞过 14 cm 落一个轨迹点；update(dt) 给所有轨迹点长年龄，超过 WAKE_LIFE 的清空。
 */
export class AirflowField {
  readonly uniforms: Record<string, IUniform>;
  private readonly wake: Vector4[];
  private readonly lastPush = new Vector3(1e9, 0, 0);
  private head = 0;
  private hasBird = false;

  constructor(uniforms: Record<string, IUniform>) {
    this.uniforms = uniforms;
    this.wake = uniforms.uWake.value as Vector4[];
  }

  /** 小鸟当前位置 / 速度（cm/s）/ 扑翼相位（0..1 一个扑翼周期）/ 展翅度（默认 1 = 飞行中）。 */
  setBirdWake(pos: { x: number; y: number; z: number }, vel: { x: number; y: number; z: number }, wingPhase: number, wingOpen = 1): void {
    (this.uniforms.uBirdPos.value as Vector3).set(pos.x, pos.y, pos.z);
    (this.uniforms.uBirdVel.value as Vector3).set(vel.x, vel.y, vel.z);
    this.uniforms.uWingPhase.value = wingPhase;
    // 翅的展开度 0..1（地面蹦跳：蹬伸 / 腾空 0.4、站着 0）：拨草尾流乘它，站着不动不吹
    this.uniforms.uWingOpen.value = wingOpen;
    this.hasBird = true;
    if (this.lastPush.distanceToSquared(this.uniforms.uBirdPos.value as Vector3) > PUSH_DIST * PUSH_DIST) {
      this.lastPush.copy(this.uniforms.uBirdPos.value as Vector3);
      this.wake[this.head].set(pos.x, pos.y, pos.z, 0);
      this.head = (this.head + 1) % this.wake.length;
    }
  }

  /** 小鸟不在场（演示关掉）：翼下气柱消失，尾流自然衰减。 */
  setBirdAbsent(): void {
    if (!this.hasBird) return;
    this.hasBird = false;
    (this.uniforms.uBirdPos.value as Vector3).set(0, -9999, 0);
    (this.uniforms.uBirdVel.value as Vector3).set(0, 0, 0);
    this.lastPush.set(1e9, 0, 0);
  }

  update(dt: number): void {
    for (const w of this.wake) {
      if (w.w < 0) continue;
      w.w += dt;
      if (w.w > WAKE_LIFE) w.w = -1;
    }
  }

  /** 演示开关：0 = 没有鸟（只剩微风）。 */
  set enabled(v: boolean) {
    this.uniforms.uFlowOn.value = v ? 1 : 0;
    if (!v) this.setBirdAbsent();
    else this.lastPush.set(1e9, 0, 0);
  }

  get enabled(): boolean {
    return this.uniforms.uFlowOn.value === 1;
  }
}
