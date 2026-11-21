import {
  BackSide,
  Color,
  Mesh,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  type IUniform,
} from 'three';
import { NOISE_GLSL } from '../glsl/noise';

/** 程序化冬日上午的天空：天顶到地平线的渐变 + 低角度太阳的光晕 + 极淡的云。 */
export class Sky {
  readonly mesh: Mesh<SphereGeometry, ShaderMaterial>;

  constructor(sunDir: Vector3) {
    const uniforms: Record<string, IUniform> = {
      uSunDir: { value: sunDir },
      uZenith: { value: new Color(0.25, 0.36, 0.56) },
      uHorizon: { value: new Color(0.5, 0.56, 0.64) },
      uGround: { value: new Color(0.42, 0.43, 0.45) },
      uSunGlow: { value: new Color(1.0, 0.86, 0.68) },
    };
    const material = new ShaderMaterial({
      uniforms,
      side: BackSide,
      depthWrite: false,
      vertexShader: /* glsl */ `
varying vec3 vDir;
void main() {
	vDir = normalize( position );
	gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`,
      fragmentShader: /* glsl */ `
${NOISE_GLSL}
uniform vec3 uSunDir;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uSunGlow;
varying vec3 vDir;
void main() {
	vec3 d = normalize( vDir );
	float h = d.y;
	float t = pow( 1.0 - clamp( h, 0.0, 1.0 ), 4.0 );
	vec3 col = mix( uZenith, uHorizon, t );
	col = mix( col, uGround, 1.0 - smoothstep( -0.22, 0.0, h ) );
	float s = max( dot( d, uSunDir ), 0.0 );
	col += uSunGlow * ( pow( s, 6.0 ) * 0.16 + pow( s, 80.0 ) * 0.4 + pow( s, 2500.0 ) * 5.0 );
	float cl = fbm3( d * 9.0 );
	col *= 1.0 + ( cl - 0.5 ) * 0.12 * smoothstep( -0.02, 0.35, h );
	gl_FragColor = vec4( col, 1.0 );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}
`,
    });
    this.mesh = new Mesh(new SphereGeometry(800, 48, 24), material);
    this.mesh.renderOrder = -100;
    this.mesh.frustumCulled = false;
  }
}
