import {
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  ShaderMaterial,
  Vector3,
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
    /** 雪箱跟着谁包裹（城市漫游里 = 相机位置；观鸟页保持 (0,0,0)，位置公式退化成原来的）。 */
    uCenter: { value: new Vector3() },
    uRange: { value: 48 },
    /** 雪片大小的倍率：观鸟页按相机距离放大（近景 1，画面不变），漫游页不碰 = 1。 */
    uSizeK: { value: 1 },
  };

  constructor(seed = 11, count = 900, range = 48) {
    this.uniforms.uRange.value = range;
    const rng = makeRng(seed);
    const base = new InstancedBufferGeometry();
    base.setAttribute('position', new Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    base.setIndex([0, 1, 2, 0, 2, 3]);

    const seed4 = new Float32Array(count * 4); // x, y, z, 下落速度
    const misc = new Float32Array(count * 2); // 尺寸, 相位
    for (let i = 0; i < count; i++) {
      // 垂直种子铺满最大的雪箱高度（观鸟页拉远看整棵树时 650）：箱子矮时顶点着色器按 uHeight 取模折叠，密度不变；
      // 以前固定铺 62，箱子拉高后雪只落在最底下 62 cm 的一条带里，要等它们自己飘满（~150 s）
      seed4.set([lerp(-range, range, rng()), rng() * 650, lerp(-range, range, rng()), lerp(1.4, 4.2, rng())], i * 4);
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
uniform vec3 uCenter;
uniform float uRange;
uniform float uSizeK;
varying vec2 vUv;
varying float vFade;
void main() {
	// 雪箱围绕 uCenter 包裹：雪片的世界坐标不变，飘出箱子（半径 uRange）才从对面绕回来；uCenter = 0 时和原来逐像素一致
	float r = uRange;
	float fall = aSeed.y - uTime * aSeed.w;
	float y = mod( fall - uCenter.y, uHeight ) + uBase + uCenter.y;
	float ph = aMisc.y * 6.2831853;
	vec3 wp = vec3(
		uCenter.x + mod( aSeed.x - uCenter.x + r, 2.0 * r ) - r + sin( uTime * 0.9 + ph ) * 0.7,
		y,
		uCenter.z + mod( aSeed.z - uCenter.z + r, 2.0 * r ) - r + cos( uTime * 0.63 + ph * 1.7 ) * 0.5 );
	vFade = smoothstep( uBase, uBase + 5.0, y - uCenter.y ) * ( 1.0 - smoothstep( uBase + uHeight - 6.0, uBase + uHeight, y - uCenter.y ) );
	vUv = position.xy;
	vec4 mv = viewMatrix * vec4( wp, 1.0 );
	// 贴着镜头（视深 0.8~2.5 cm）的雪片平滑淡出：微距时一粒贴脸的雪就是一块糊满画面的半透明白斑
	vFade *= smoothstep( 0.8, 2.5, - mv.z );
	mv.xy += position.xy * aMisc.x * uSizeK;
	gl_Position = projectionMatrix * mv;
}
`,
      fragmentShader: /* glsl */ `
varying vec2 vUv;
varying float vFade;
void main() {
	float r = length( vUv );
	// 片元外缘在 r = 1 处严格归零（以前留 0.18 的底数，四边形的角上是一圈半透明白方块）
	float a = ( 1.0 - smoothstep( 0.25, 1.0, r ) ) * 0.62 * vFade;
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
