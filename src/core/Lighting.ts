import { Color, DirectionalLight, Scene, Vector3 } from 'three';
import type { LightingUniforms } from '../glsl/lit';

/**
 * 场景光照：一盏低角度的冬日暖阳（负责投影）+ 天空与雪地的半球环境光。
 * 自定义材质不读 three 的灯光对象，只读这里导出的 uniform；DirectionalLight 仅用于生成阴影贴图。
 */
export class Lighting {
  readonly uniforms: LightingUniforms;
  readonly sun: DirectionalLight;
  /** 当前太阳方位角与高度角（度），面板和预设共用。 */
  azimuth = -100;
  elevation = 38;

  constructor(scene: Scene) {
    this.uniforms = {
      uSunDir: { value: new Vector3(0, 1, 0) },
      uSunColor: { value: new Color(1.0, 0.955, 0.9).multiplyScalar(1.5) },
      uSkyColor: { value: new Color(0.6, 0.7, 0.86).multiplyScalar(0.85) },
      uGroundColor: { value: new Color(0.86, 0.88, 0.94).multiplyScalar(1.0) },
    };
    this.setSun(this.azimuth, this.elevation);

    this.sun = new DirectionalLight(0xffffff, 1);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    const cam = this.sun.shadow.camera;
    // 世界单位是厘米，阴影相机只需罩住鸟和附近的树枝，分辨率才够高。
    cam.left = -10;
    cam.right = 10;
    cam.top = 10;
    cam.bottom = -10;
    cam.near = 1;
    cam.far = 130;
    cam.updateProjectionMatrix();
    this.sun.shadow.bias = -0.00002;
    this.sun.shadow.normalBias = 0.03;
    this.sun.shadow.radius = 3.5;

    // 阴影相机对准鸟身中后段，连尾巴尖也罩进来
    this.sun.target.position.set(1.5, 2.2, 0);
    this.setSun(this.azimuth, this.elevation);
    scene.add(this.sun, this.sun.target);
  }

  /** 方位角以前方 (+Z) 为 0、向左 (−X) 为负；高度角以地平线为 0。单位：度。 */
  setSun(azimuthDeg: number, elevationDeg: number): void {
    this.azimuth = azimuthDeg;
    this.elevation = elevationDeg;
    const az = (azimuthDeg * Math.PI) / 180;
    const el = (elevationDeg * Math.PI) / 180;
    const dir = this.uniforms.uSunDir.value.set(
      Math.sin(az) * Math.cos(el),
      Math.sin(el),
      Math.cos(az) * Math.cos(el),
    );
    if (this.sun) this.sun.position.copy(this.sun.target.position).addScaledVector(dir, 60);
  }
}
