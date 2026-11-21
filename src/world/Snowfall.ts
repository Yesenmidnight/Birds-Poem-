import {
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  ShaderMaterial,
  type IUniform,
} from 'three';
import { lerp, makeRng } from '../util/math';

/** 飘雪：位置完全由时间与每个雪片的种子在顶点着色器里算出来，CPU 每帧只推进一个时间。 */
export class Snowfall {
  readonly mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  readonly uniforms: Record<string, IUniform> = {
    uTime: { value: 0 },
    uHeight: { value: 62 },
    uBase: { value: -14 },
  };

  constructor(seed = 11, count = 900, range = 48) {
    const rng = makeRng(seed);
    const base = new InstancedBufferGeometry();
    base.setAttribute('position', new Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    base.setIndex([0, 1, 2, 0, 2, 3]);

    const seed4 = new Float32Array(count * 4); // x, y, z, 下落速度
    const misc = new Float32Array(count * 2); // 尺寸, 相位
    for (let i = 0; i < count; i++) {
      seed4.set([lerp(-range, range, rng()), rng() * 62, lerp(-range, range, rng()), lerp(1.4, 4.2, rng())], i * 4);
      misc.set([0.028 + 0.075 * Math.pow(rng(), 2.2), rng()], i * 2);
    }
    base.setAttribute('aSeed', new InstancedBufferAttribute(seed4, 4));
    base.setAttribute('aMisc', new InstancedBufferAttribute(misc, 2));
    base.instanceCount = count;

    const material = new ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      vertexShader: /* glsl */ `
attribute vec4 aSeed;
attribute vec2 aMisc;
uniform float uTime;
uniform float uHeight;
uniform float uBase;
varying vec2 vUv;
varying float vFade;
void main() {
	float y = mod( aSeed.y - uTime * aSeed.w, uHeight ) + uBase;
	float ph = aMisc.y * 6.2831853;
	vec3 wp = vec3(
		aSeed.x + sin( uTime * 0.9 + ph ) * 0.7,
		y,
		aSeed.z + cos( uTime * 0.63 + ph * 1.7 ) * 0.5 );
	vFade = smoothstep( uBase, uBase + 5.0, y ) * ( 1.0 - smoothstep( uBase + uHeight - 6.0, uBase + uHeight, y ) );
	vUv = position.xy;
	vec4 mv = viewMatrix * vec4( wp, 1.0 );
	mv.xy += position.xy * aMisc.x;
	gl_Position = projectionMatrix * mv;
}
`,
      fragmentShader: /* glsl */ `
varying vec2 vUv;
varying float vFade;
void main() {
	float r = length( vUv );
	float a = 1.0 - smoothstep( 0.25, 1.0, r );
	a = ( 0.18 + 0.82 * a ) * 0.62 * vFade;
	gl_FragColor = vec4( 0.92, 0.95, 1.0, a );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}
`,
    });

    this.mesh = new Mesh(base, material);
    this.mesh.frustumCulled = false;
  }

  update(time: number): void {
    this.uniforms.uTime.value = time;
  }
}
