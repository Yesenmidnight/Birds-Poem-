/**
 * 庭院灯光：一盏低角度冬日暖阳（负责投影）+ 冷蓝天光 / 雪地反光的半球环境光。
 * 自定义材质只读这里的 uniform；DirectionalLight 只用来生成阴影贴图，阴影相机罩住整座院子。
 * 另外给片元着色器两组"假点光"的参数：路灯灯笼、阳光房室内的暖黄补光（解析光照模型里没有点光源，
 * 用世界空间衰减项叠加，室内植物 / 砖地 / 木架从院外风雪里望进去才温暖通透）。
 */
import { Color, DirectionalLight, Scene, Vector3 } from 'three';
import type { LightingUniforms } from '../glsl/lit';
import { LAMP } from '../pcg/courtyard';

export interface CourtyardLightingOptions {
  shadowSize?: number;
}

export class CourtyardLighting {
  readonly uniforms: LightingUniforms;
  readonly sun: DirectionalLight;
  /** 当前太阳方位角与高度角（度）。方位角：+Z（南）为 0，向 −X（西）为负。 */
  azimuth = -42;
  elevation = 21;

  constructor(scene: Scene, opts: CourtyardLightingOptions = {}) {
    this.uniforms = {
      uSunDir: { value: new Vector3(0, 1, 0) },
      // 低角度冬日暖阳：偏橙，强度给足（雪面靠它撑亮）
      uSunColor: { value: new Color(1.0, 0.86, 0.7).multiplyScalar(1.45) },
      // 冷蓝的天光 + 偏蓝白的雪地反光
      uSkyColor: { value: new Color(0.5, 0.64, 0.86).multiplyScalar(0.8) },
      uGroundColor: { value: new Color(0.84, 0.9, 1.0).multiplyScalar(0.92) },
    };

    this.sun = new DirectionalLight(0xffffff, 1);
    this.sun.castShadow = true;
    const size = opts.shadowSize ?? 4096;
    this.sun.shadow.mapSize.set(size, size);
    const cam = this.sun.shadow.camera;
    // 世界单位是厘米：罩住整座院子——西栅栏 −1100 到大植物园东墙 1520（东栅栏 1640），以 (270, 0) 为中心 ±1750
    cam.left = -1750;
    cam.right = 1750;
    cam.top = 1750;
    cam.bottom = -1750;
    cam.near = 10;
    cam.far = 7000;
    cam.updateProjectionMatrix();
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 2.2;
    this.sun.shadow.radius = 2.5;
    this.sun.target.position.set(270, 150, 0);
    scene.add(this.sun, this.sun.target);
    this.setSun(this.azimuth, this.elevation);
  }

  setSun(azimuthDeg: number, elevationDeg: number): void {
    this.azimuth = azimuthDeg;
    this.elevation = elevationDeg;
    const az = (azimuthDeg * Math.PI) / 180;
    const el = (elevationDeg * Math.PI) / 180;
    const dir = this.uniforms.uSunDir.value.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
    this.sun.position.copy(this.sun.target.position).addScaledVector(dir, 3500);
  }
}

/** 路灯灯笼中心（片元暖光的源点）。 */
export const LAMP_GLOW = new Vector3(LAMP.lantern.x, LAMP.lantern.y + LAMP.lantern.h * 0.5, LAMP.lantern.z);

/**
 * 片元着色器共用的两盏"假灯"：
 *   ghWarm —— 阳光房室内暖黄补光（在温室盒子里才有，离屋脊越近越亮，边界 12 cm 柔化）；
 *   lampWarm —— 路灯灯笼的暖橙光（1/r² 衰减，400 cm 外为 0）。
 * 都以 extraLight 的形式叠加到 s.albedo 上（不投影、不高光）。
 */
export const WARM_LIGHT_GLSL = /* glsl */ `
uniform vec3 uLampPos;
vec3 ghWarm( vec3 p ) {
	vec3 lo = vec3( -140.0, -90.0, -560.0 );
	vec3 hi = vec3( 340.0, 250.0, -160.0 );
	vec3 t = smoothstep( lo - 14.0, lo + 14.0, p ) * ( 1.0 - smoothstep( hi - 14.0, hi + 14.0, p ) );
	float inside = t.x * t.y * t.z;
	float up = smoothstep( -60.0, 220.0, p.y );
	float flick = 0.97 + 0.03 * snoise( vec3( p.xz * 0.05, 3.1 ) );
	// 暖黄补光 + 抵掉一部分冷蓝天光（温室内是恒温翠绿暖调）
	return inside * ( vec3( 1.0, 0.64, 0.3 ) * ( 1.25 + 0.75 * up ) * flick - uSkyColor * 0.5 );
}
vec3 lampWarm( vec3 p ) {
	vec3 d = p - uLampPos;
	float r2 = dot( d, d );
	float f = 26000.0 / ( r2 + 900.0 ) * ( 1.0 - smoothstep( 250.0, 420.0, sqrt( r2 ) ) );
	return vec3( 1.0, 0.62, 0.28 ) * f;
}
// 大植物园温室：加温 + 湿热的春日室内——一层偏暖的环境光，扣掉一部分冷蓝天光，靠脊越亮（透过玻璃的天光多）
vec3 cvWarm( vec3 p ) {
	vec3 lo = vec3( 376.0, -104.0, -1164.0 );
	vec3 hi = vec3( 1504.0, 600.0, 1164.0 );
	vec3 t = smoothstep( lo - 20.0, lo + 20.0, p ) * ( 1.0 - smoothstep( hi - 20.0, hi + 20.0, p ) );
	float inside = t.x * t.y * t.z;
	float up = smoothstep( -100.0, 500.0, p.y );
	float flick = 0.97 + 0.03 * snoise( vec3( p.xz * 0.03, 7.7 ) );
	return inside * ( vec3( 1.0, 0.78, 0.52 ) * ( 0.3 + 0.25 * up ) * flick - uSkyColor * 0.3 );
}
vec3 warmLights( vec3 p, Surf s ) {
	return s.albedo * ( ghWarm( p ) + cvWarm( p ) + lampWarm( p ) );
}
`;
