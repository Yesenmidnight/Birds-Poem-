import {
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  ShaderMaterial,
  Vector3,
  type IUniform,
} from 'three';
import { makeRng } from '../util/math';

/**
 * 震落的雪粉：小鸟蹬枝起跳 / 落枝的一瞬，从落点枝头震落的一小撮细碎雪粒，受重力和微风飘散。
 * 位置全在顶点着色器里按"出生时刻 + 初速"解析地算出来（带空气阻力的抛物线 + 风吹 + 打旋），CPU 只在触发时写一批实例；
 * 容量固定、环形复用，平时没有任何 CPU 开销。
 */
export class SnowPuff {
  readonly mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  readonly uniforms: Record<string, IUniform> = {
    uTime: { value: 0 },
    /** 微风（厘米 / 秒，世界坐标） */
    uWind: { value: new Vector3(7, 0, -4) },
  };
  private readonly birth: Float32Array;
  private readonly vel: Float32Array;
  private readonly misc: Float32Array;
  private cursor = 0;
  private readonly rng = makeRng(20261123);

  constructor(readonly cap = 360) {
    const g = new InstancedBufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.birth = new Float32Array(cap * 4); // x, y, z, 出生时刻（秒；负数 = 还没出生）
    this.vel = new Float32Array(cap * 4); // 初速 xyz（厘米 / 秒），寿命（秒）
    this.misc = new Float32Array(cap * 2); // 尺寸（厘米），随机相位
    for (let i = 0; i < cap; i++) this.birth[i * 4 + 3] = -1e3;
    g.setAttribute('aBirth', new InstancedBufferAttribute(this.birth, 4));
    g.setAttribute('aVel', new InstancedBufferAttribute(this.vel, 4));
    g.setAttribute('aMisc', new InstancedBufferAttribute(this.misc, 2));
    g.instanceCount = cap;

    const material = new ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      vertexShader: /* glsl */ `
attribute vec4 aBirth;
attribute vec4 aVel;
attribute vec2 aMisc;
uniform float uTime;
uniform vec3 uWind;
varying vec2 vUv;
varying float vFade;
varying float vPh;
void main() {
	float age = uTime - aBirth.w;
	float life = aVel.w;
	float on = step( 0.0, age ) * step( age, life );
	// 带空气阻力的抛物线：速度 v = v0·e^(-kt) + (风 + 末速下落)·(1 - e^(-kt))，位移是它的积分
	float k = 4.5;
	float e = exp( -k * age );
	vec3 drift = uWind + vec3( 0.0, -5.0, 0.0 );
	vec3 p = aBirth.xyz + aVel.xyz * ( 1.0 - e ) / k + drift * ( age - ( 1.0 - e ) / k );
	// 打旋：越飘越散
	float ph = aMisc.y * 6.2831853;
	p += vec3( sin( age * 9.0 + ph ), 0.5 * sin( age * 6.0 + ph * 1.7 ), cos( age * 7.0 + ph * 2.3 ) ) * 0.045 * age;
	vFade = on * ( 1.0 - smoothstep( 0.45 * life, life, age ) ) * smoothstep( 0.0, 0.02, age );
	vPh = ph;
	vUv = position.xy;
	vec4 mv = viewMatrix * vec4( p, 1.0 );
	mv.xy += position.xy * aMisc.x * ( 1.0 - 0.5 * smoothstep( 0.5 * life, life, age ) ) * on;
	gl_Position = projectionMatrix * mv;
}
`,
      fragmentShader: /* glsl */ `
uniform float uTime;
varying vec2 vUv;
varying float vFade;
varying float vPh;
void main() {
	float r = length( vUv );
	// 径向渐隐到方块四角（r ≥ 1 处恒为 0）：以前 0.25 的底色让整个方块都带着 alpha，微距下成了一片白方块
	float edge = 1.0 - smoothstep( 0.0, 1.0, r );
	float core = 1.0 - smoothstep( 0.0, 0.35, r );
	// 细碎雪粒的微闪
	float twinkle = 0.75 + 0.25 * sin( uTime * 26.0 + vPh * 9.0 );
	float a = edge * edge * ( 0.3 + 0.7 * core ) * 0.85 * vFade * twinkle;
	if ( a < 0.003 ) discard;
	gl_FragColor = vec4( 0.95, 0.97, 1.0, a );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}
`,
    });
    this.mesh = new Mesh(g, material);
    this.mesh.frustumCulled = false;
  }

  /** 在 center（世界坐标）震落 count 粒：以侧向四散为主、略微上扬（被蹬下来的一小撮雪粉是从枝两侧往下飘的），speed 厘米 / 秒。 */
  burst(center: Vector3, count: number, speed = 9): void {
    const t = this.uniforms.uTime.value as number;
    const rng = this.rng;
    for (let k = 0; k < count; k++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.cap;
      const a = rng() * Math.PI * 2;
      const up = 0.1 + 0.45 * rng();
      const sp = speed * (0.4 + 0.6 * rng());
      const s = Math.sqrt(1 - up * up);
      this.birth.set([center.x + (rng() - 0.5) * 0.5, center.y + (rng() - 0.5) * 0.12, center.z + (rng() - 0.5) * 0.5, t + rng() * 0.05], i * 4);
      this.vel.set([Math.cos(a) * s * sp, up * sp, Math.sin(a) * s * sp, 0.9 + 0.9 * rng()], i * 4);
      this.misc.set([0.03 + 0.045 * rng() * rng(), rng()], i * 2);
    }
    for (const a of Object.values(this.mesh.geometry.attributes)) a.needsUpdate = true;
  }

  update(time: number): void {
    this.uniforms.uTime.value = time;
  }
}
