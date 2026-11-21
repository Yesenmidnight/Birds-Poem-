import {
  Color,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  ShaderMaterial,
} from 'three';
import { TAU, lerp, makeRng } from '../util/math';

/**
 * 远景虚化层：一圈朝向相机的柔和色斑，模拟浅景深照片里化开树林与雪地的感觉。
 * 每个色斑的边缘和亮度都在片元着色器里现算。
 */
export class Backdrop {
  readonly mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;

  constructor(seed = 7, count = 130) {
    const rng = makeRng(seed);
    const base = new InstancedBufferGeometry();
    base.setAttribute('position', new Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    base.setIndex([0, 1, 2, 0, 2, 3]);

    // 调色：深色枝影、灰褐、雪白、冷光、少量暖色光斑
    const palette: { c: Color; a: [number, number]; w: number }[] = [
      { c: new Color('#1d1b18'), a: [0.3, 0.55], w: 38 },
      { c: new Color('#45403b'), a: [0.24, 0.42], w: 28 },
      { c: new Color('#dcd9d2'), a: [0.22, 0.42], w: 12 },
      { c: new Color('#8f9bab'), a: [0.22, 0.42], w: 16 },
      { c: new Color('#e8d2a8'), a: [0.14, 0.3], w: 6 },
    ];
    const total = palette.reduce((s, p) => s + p.w, 0);

    const center = new Float32Array(count * 3);
    const size = new Float32Array(count * 2);
    const color = new Float32Array(count * 3);
    const misc = new Float32Array(count * 2);

    for (let i = 0; i < count; i++) {
      const az = rng() * TAU;
      const dist = lerp(75, 240, Math.pow(rng(), 0.75));
      // 一部分压到地平线以下，俯视时充当雪地与灌丛的虚影
      const y = rng() < 0.62 ? lerp(-28, 62, rng()) : lerp(-80, -24, rng());
      center.set([Math.sin(az) * dist, y, Math.cos(az) * dist], i * 3);

      const w = 5 + 24 * Math.pow(rng(), 1.4);
      size.set([w, w * (0.45 + 1.9 * rng())], i * 2);

      let pick = rng() * total;
      let entry = palette[0];
      for (const p of palette) {
        pick -= p.w;
        if (pick <= 0) {
          entry = p;
          break;
        }
      }
      color.set([entry.c.r, entry.c.g, entry.c.b], i * 3);
      misc.set([0.72 + 0.24 * rng(), lerp(entry.a[0], entry.a[1], rng())], i * 2);
    }
    base.setAttribute('aCenter', new InstancedBufferAttribute(center, 3));
    base.setAttribute('aSize', new InstancedBufferAttribute(size, 2));
    base.setAttribute('aColor', new InstancedBufferAttribute(color, 3));
    base.setAttribute('aMisc', new InstancedBufferAttribute(misc, 2));
    base.instanceCount = count;

    const material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      vertexShader: /* glsl */ `
attribute vec3 aCenter;
attribute vec2 aSize;
attribute vec3 aColor;
attribute vec2 aMisc;
varying vec2 vUv;
varying vec3 vColor;
varying vec2 vMisc;
void main() {
	vec4 mv = viewMatrix * vec4( aCenter, 1.0 );
	mv.xy += position.xy * aSize;
	vUv = position.xy;
	vColor = aColor;
	vMisc = aMisc;
	gl_Position = projectionMatrix * mv;
}
`,
      fragmentShader: /* glsl */ `
varying vec2 vUv;
varying vec3 vColor;
varying vec2 vMisc;
void main() {
	float r = length( vUv );
	float a = ( 1.0 - smoothstep( 1.0 - vMisc.x, 1.0, r ) ) * vMisc.y;
	if ( a < 0.003 ) discard;
	// 真实焦外光斑边缘略亮
	float rim = ( smoothstep( 1.0 - vMisc.x, 0.72, r ) - smoothstep( 0.86, 1.0, r ) ) * 0.18;
	gl_FragColor = vec4( vColor * ( 1.0 + rim ), a );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}
`,
    });

    this.mesh = new Mesh(base, material);
    this.mesh.frustumCulled = false;
  }
}
