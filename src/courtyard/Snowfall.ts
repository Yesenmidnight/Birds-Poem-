/**
 * 庭院飘雪：位置全在顶点着色器里按时间算，CPU 每帧只推一个 uTime。
 * 以相机为中心环绕：雪片坐标在 xz 上对相机取模回绕，相机走到哪儿都置身雪中；
 * 落进洋房 / 阳光房 / 大植物园拱顶以下、离相机太近（糊成大团）的雪片都淡出（大植物园只有敞开的天窗口飘进几片）。
 */
import { Float32BufferAttribute, InstancedBufferAttribute, InstancedBufferGeometry, Mesh, ShaderMaterial, type IUniform } from 'three';
import { CONSV, CONSV_VENT, GH, HOUSE, ghRoofY } from '../pcg/courtyard';
import { lerp, makeRng } from '../util/math';

/** 阳光房脊高 + 余量：这片范围里低于它的雪片不画（室内不下雪）。 */
const GH_TOP = ghRoofY((GH.z0 + GH.z1) / 2) + 40;

export class CourtyardSnowfall {
  readonly mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  readonly uniforms: Record<string, IUniform> = {
    uTime: { value: 0 },
    uRange: { value: 1700 },
    uHeight: { value: 1150 },
    uBase: { value: -150 },
    /**
     * 散景分层用（BokehStage 每趟渲染前写）：0 = 虚化层那趟，只画离镜头 uNearSplit 以外的雪片；1 = 锐利层那趟，只画以内的；
     * 2 = 不分层全画（清晰漫游态 / 没接散景时）。近处的雪片跟着小鸟一起留在硬件 MSAA 的锐利层里。
     */
    uPass: { value: 2 },
    uNearSplit: { value: 60 },
  };

  constructor(seed = 19, count = 3600) {
    const rng = makeRng(seed);
    const base = new InstancedBufferGeometry();
    base.setAttribute('position', new Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    base.setIndex([0, 1, 2, 0, 2, 3]);
    const seed4 = new Float32Array(count * 4); // x, y, z, 下落速度
    const misc = new Float32Array(count * 2); // 尺寸, 相位
    for (let i = 0; i < count; i++) {
      seed4.set([lerp(-850, 850, rng()), rng() * 1150, lerp(-850, 850, rng()), lerp(55, 150, rng())], i * 4);
      misc.set([0.7 + 2.2 * Math.pow(rng(), 2.4), rng()], i * 2);
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
uniform float uRange;
uniform float uHeight;
uniform float uBase;
uniform float uPass;
uniform float uNearSplit;
varying vec2 vUv;
varying float vFade;
void main() {
	float y = mod( aSeed.y - uTime * aSeed.w, uHeight ) + uBase;
	float ph = aMisc.y * 6.2831853;
	vec3 wp = vec3( aSeed.x + sin( uTime * 0.35 + ph ) * 22.0 + uTime * 18.0, y, aSeed.z + cos( uTime * 0.27 + ph * 1.7 ) * 16.0 );
	float hr = uRange * 0.5;
	// 以相机为中心回绕
	wp.x = cameraPosition.x + mod( wp.x - cameraPosition.x + hr, uRange ) - hr;
	wp.z = cameraPosition.z + mod( wp.z - cameraPosition.z + hr, uRange ) - hr;
	vFade = smoothstep( uBase, uBase + 60.0, y ) * ( 1.0 - smoothstep( uBase + uHeight - 80.0, uBase + uHeight, y ) );
	// 屋顶以下不下雪
	if ( wp.x > ${GH.x0.toFixed(1)} && wp.x < ${GH.x1.toFixed(1)} && wp.z > ${GH.z0.toFixed(1)} && wp.z < ${GH.z1.toFixed(1)} && y < ${GH_TOP.toFixed(1)} ) vFade = 0.0;
	if ( wp.x > ${HOUSE.x0.toFixed(1)} && wp.x < ${HOUSE.x1.toFixed(1)} && wp.z > ${HOUSE.z0.toFixed(1)} && wp.z < ${HOUSE.z1.toFixed(1)} && y < 900.0 ) vFade = 0.0;
	// 大植物园拱顶以下不下雪；敞开的天窗（x ${CONSV_VENT.x0}..${CONSV_VENT.x1}）是一道露天的口子，雪从那儿飘进来、落到半空就化了
	{
		float cx = ${CONSV.xRidge.toFixed(1)} - abs( wp.x - ${CONSV.xRidge.toFixed(1)} );
		float roofY = ${CONSV.yEave.toFixed(1)} + ${(CONSV.yRidge - CONSV.yEave).toFixed(1)} * sin( clamp( cx / ${(CONSV.xRidge - CONSV.x0).toFixed(1)}, 0.0, 1.0 ) * 1.5707963 );
		if ( wp.x > ${CONSV.x0.toFixed(1)} && wp.x < ${CONSV.x1.toFixed(1)} && wp.z > ${CONSV.z0.toFixed(1)} && wp.z < ${CONSV.z1.toFixed(1)} && y < roofY - 6.0 ) {
			bool vent = wp.x > ${CONSV_VENT.x0.toFixed(1)} && wp.x < ${CONSV_VENT.x1.toFixed(1)} && wp.z > ${CONSV_VENT.z0.toFixed(1)} && wp.z < ${CONSV_VENT.z1.toFixed(1)};
			vFade *= vent ? smoothstep( 120.0, 420.0, y ) : 0.0;
		}
	}
	vUv = position.xy;
	vec4 mv = viewMatrix * vec4( wp, 1.0 );
	float dist = max( -mv.z, 1.0 );
	vFade *= smoothstep( 25.0, 120.0, dist ) * ( 1.0 - 0.55 * smoothstep( 800.0, 4000.0, dist ) );
	// 散景分层：近处（uNearSplit 以内）的雪片只在锐利层那趟画，远处的只在虚化层那趟画；uPass = 2 不分层
	float nearK = smoothstep( uNearSplit * 0.6, uNearSplit, dist );
	if ( uPass < 0.5 ) vFade *= nearK;
	else if ( uPass < 1.5 ) vFade *= 1.0 - nearK;
	mv.xy += position.xy * aMisc.x * ( 1.0 + dist * 0.0006 );
	gl_Position = projectionMatrix * mv;
}
`,
      fragmentShader: /* glsl */ `
varying vec2 vUv;
varying float vFade;
void main() {
	float r = length( vUv );
	float a = 1.0 - smoothstep( 0.2, 1.0, r );
	a = ( 0.25 + 0.75 * a ) * 0.55 * vFade;
	if ( a < 0.004 ) discard;
	gl_FragColor = vec4( 0.93, 0.96, 1.0, a );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}
`,
    });
    this.mesh = new Mesh(base, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20;
    // 两个图层都在：散景的两趟渲染按 uPass 各画一半（近处锐利、远处虚化）
    this.mesh.layers.enable(1);
  }

  update(time: number): void {
    this.uniforms.uTime.value = time;
  }
}
