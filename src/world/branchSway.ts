import { Vector2, Vector3, Vector4, type IUniform } from 'three';
import { clamp } from '../util/math';

/**
 * 悬臂梁弹性树枝（GPU 侧在顶点着色器里按模态位移，CPU 侧只推进几个模态坐标）。
 *
 * 主栖枝在画外（粗的那头）固定，按悬臂梁的两阶弯曲模态振动：一阶是整根枝上下点头（梢端最大）、二阶是中段颤动，
 * 另有一阶侧向微摆。受小鸟体重时静态微垂（鸟站上去枝先沉一下再回弹两下），起跳 / 落地的冲击按冲量注入。
 * 右侧海棠嫩梢挂一个二阶振子：driven by 主枝在它根部的加速度（主枝颤完嫩梢慢半拍点头），鼠标快速划过也能拨动它。
 * 果柄再挂一个单摆振子（uSwayFruit）：由果台处的加速度驱动，欠阻尼 3.1 Hz——小鸟蹬枝 / 落枝、鼠标拨枝都会让红果串
 * 轻盈地晃荡一会儿。位移在枝条自己的坐标系里：竖直 y、侧向 z（观鸟入口转了 90° 之后就是世界的前后）。
 */
export const SWAY_GLSL = /* glsl */ `
// 枝条附着物的弯曲：aSway.x = 沿主枝的归一化弧长 s（固定端 0、梢 1），y = 自己这根枝里离根的归一化距离，z = 自己也弯的标志
attribute vec3 aSway;
uniform vec4 uSwayMain;
uniform vec4 uSwayTwig;
vec3 swayBend( vec3 p ) {
	float s = aSway.x;
	float phi1 = pow( s, 1.7 );
	float phi2 = sin( s * 3.14159265 ) * s;
	p.y += uSwayMain.x * phi1 + uSwayMain.y * phi2;
	p.z += uSwayMain.z * phi1;
	if ( aSway.z > 0.5 ) p.yz += uSwayTwig.xy * aSway.y;
	return p;
}
`;

/** 果柄单摆的顶点位移（果柄 / 果实 / 萼片 / 果顶雪帽的材质专用）：aSwing = 果柄弧长权重（根部 0 → 果实 1）。 */
export const FRUIT_SWAY_GLSL = /* glsl */ `
attribute float aSwing;
uniform vec4 uSwayFruit;
vec3 fruitSwing( vec3 p ) {
	p.x += uSwayFruit.x * aSwing;
	p.y += uSwayFruit.y * aSwing;
	return p;
}
`;

/** 活跃颤动枝的槽位数：每棵树一份 uActiveLimbs，每帧从仿真世界挑正在晃的几根写进来。 */
export const LIMB_SLOTS = 6;

/**
 * 焊合树的枝条随动（2026-11-23，庭院老海棠 + 温室春树）：碰撞层的 CurvePerch 带悬臂弹簧（根部焊在母枝上不动、梢端最大），
 * 画面层的合并网格不重建——每个顶点带 aLimb = (自己的枝号 + 1, 沿枝归一化弧长 s) 和 aLimbP = (母枝号 + 1, 焊口在母枝上的归一化弧长)，
 * 0 = 无。uActiveLimbs[i] = (枝号 + 1, 梢端位移 cm)，竖直位移 = 梢端位移 × s²（悬臂振型，和 CurvePerch.shapeAt 同一个公式，
 * 所以鸟根跟着 offsetAt 走 = 跟着画面上的枝走）：自己弯的那一份 + 母枝在焊口处带过来的那一份（母枝弯了多少，子枝 / 果 / 叶整根刚性跟着走，焊口不裂）。
 * 没有这两个属性的几何（主角枝一套、主干苔藓）WebGL 读到 0 → 不动。
 */
export const LIMB_GLSL = /* glsl */ `
attribute vec2 aLimb;
attribute vec2 aLimbP;
uniform vec2 uActiveLimbs[ ${LIMB_SLOTS} ];
float limbDrop( vec2 a ) {
	if ( a.x < 0.5 ) return 0.0;
	float k = a.y * a.y;
	for ( int i = 0; i < ${LIMB_SLOTS}; i ++ ) {
		if ( abs( uActiveLimbs[ i ].x - a.x ) < 0.5 ) return uActiveLimbs[ i ].y * k;
	}
	return 0.0;
}
vec3 limbBend( vec3 p ) {
	p.y += limbDrop( aLimb ) + limbDrop( aLimbP );
	return p;
}
`;

/** 一棵树的活跃枝槽位 uniform（树皮 / 雪 / 芽 / 果 / 叶 / 花几种材质共享同一个对象）。 */
export function makeLimbUniforms(): Record<string, IUniform> {
  return { uActiveLimbs: { value: Array.from({ length: LIMB_SLOTS }, () => new Vector2(0, 0)) } };
}

/** 把活跃枝写进槽位：entries 按显著程度排好（枝号从 0 起，offset = 梢端位移 cm）；多余的槽位清零。 */
export function writeLimbSlots(uniforms: Record<string, IUniform>, entries: readonly { limb: number; offset: number }[]): void {
  const slots = uniforms.uActiveLimbs.value as Vector2[];
  for (let i = 0; i < LIMB_SLOTS; i++) {
    const e = entries[i];
    if (e && e.offset !== 0) slots[i].set(e.limb + 1, e.offset);
    else slots[i].set(0, 0);
  }
}

/** 一阶模态形状（固定端 0、梢端 1），CPU / GPU 同一个公式。 */
export function swayMode1(s: number): number {
  return Math.pow(clamp(s, 0, 1), 1.7);
}

export class BranchSway {
  /**
   * uSwayMain = (一阶竖直 cm, 二阶竖直 cm, 一阶侧向 cm, 0)；uSwayTwig = (嫩梢竖直, 侧向, 0)，都是枝梢处的位移；
   * uSwayFruit = (果实处沿枝水平 cm, 竖直 cm, 0, 0)。
   */
  readonly uniforms: Record<string, IUniform> = {
    uSwayMain: { value: new Vector4() },
    uSwayTwig: { value: new Vector4() },
    uSwayFruit: { value: new Vector4() },
  };
  /** 小鸟站在枝上时枝在鸟脚处的静态下垂量（厘米）。 */
  weight = 0.08;
  /** 蹲伏蓄力时额外往下预压的量（厘米，鸟脚处）。 */
  preload = 0;
  private q1 = 0;
  private v1 = 0;
  private q2 = 0;
  private v2 = 0;
  private q3 = 0;
  private v3 = 0;
  /** 海棠嫩梢：自己的竖直 / 侧向振子 */
  private t1 = 0;
  private tv1 = 0;
  private t2 = 0;
  private tv2 = 0;
  /** 果柄单摆：竖直 / 水平两个分量 */
  private f1 = 0;
  private fv1 = 0;
  private f2 = 0;
  private fv2 = 0;
  /** 鸟在枝上（静态下垂的平衡点非零）与它的归一化弧长 */
  private loaded = true;
  private birdS = 0.69;
  /** 海棠嫩梢根部在主枝上的归一化弧长 */
  twigS = 0.74;
  /** 果台在嫩梢上的归一化弧长（单摆按这一点的加速度驱动；建果簇时由 Branches 写入） */
  fruitS = 0.5;
  // 频率（弧度 / 秒）与阻尼比
  private readonly w1 = 2 * Math.PI * 2.7;
  private readonly w2 = 2 * Math.PI * 8.5;
  private readonly w3 = 2 * Math.PI * 2.2;
  private readonly wt = 2 * Math.PI * 1.9;
  /** 果柄单摆：3.1 Hz、阻尼比 0.09（晃十几下才停） */
  private readonly wf = 2 * Math.PI * 3.1;
  private readonly zf = 0.09;
  private readonly z1 = 0.09;
  private readonly z2 = 0.2;
  private readonly z3 = 0.12;
  private readonly zt = 0.14;

  /** 小鸟落脚 / 起跳：沿枝位置 s（归一化）与是否在枝上；换位时静态下垂的平衡点跟着挪。 */
  setBird(onBranch: boolean, s: number): void {
    this.loaded = onBranch;
    this.birdS = s;
  }

  /** 落地 / 蹬枝的冲击：strength 是冲量强度（1 ≈ 落地），把枝往下蹬（一阶整根点头 + 二阶中段快颤 + 一点侧向）。 */
  impulse(strength: number, s = this.birdS): void {
    const m = swayMode1(s);
    this.v1 -= strength * 11 * m;
    this.v2 -= strength * 3.8 * m;
    this.v3 += strength * 0.7 * m;
  }

  /** 鼠标拨动海棠嫩梢：side 的正负决定往哪边甩；果柄单摆也跟着被激起。 */
  kickTwig(strength: number, side: number): void {
    this.tv1 += strength * 2.2;
    this.tv2 += strength * 1.6 * side;
    this.fv1 += strength * 0.5;
    this.fv2 += strength * 0.35 * side;
  }

  update(dt: number): void {
    // 半隐式欧拉（先更新速度、再用新速度推位置；显式欧拉对振荡器是无条件不稳定的，振幅每步涨 √(1+(ωh)²)）。
    // 每帧最多两个子步：二阶模态 ω = 53 rad/s，子步 1/60 s 时 ωh = 0.9，积分误差足够小
    const n = 2;
    const h = Math.min(dt, 1 / 30) / n;
    // 静态下垂：鸟在枝上时一阶模态的平衡点让鸟脚处下垂 weight 厘米（蹲伏时再加预压；枝条坐标系 +Y 朝上，所以取负），
    // 离枝后回到 0
    const sag = (this.loaded ? this.weight : 0) + this.preload;
    const eq = -sag / Math.max(swayMode1(this.birdS), 0.05);
    const step = (q: number, v: number, w: number, z: number, target: number, f: number): [number, number] => {
      const nv = v + (w * w * (target - q) - 2 * z * w * v + f) * h;
      return [q + nv * h, nv];
    };
    for (let i = 0; i < n; i++) {
      [this.q1, this.v1] = step(this.q1, this.v1, this.w1, this.z1, eq, 0);
      [this.q2, this.v2] = step(this.q2, this.v2, this.w2, this.z2, 0, 0);
      [this.q3, this.v3] = step(this.q3, this.v3, this.w3, this.z3, 0, 0);
      // 嫩梢：主枝在它根部的加速度（一阶 + 二阶模态在该处的叠加）作为惯性力驱动它自己的振子——相位自然滞后，
      // 主枝颤完嫩梢慢半拍点头；鼠标拨动的冲量直接加在它的速度上
      const a1 = this.w1 * this.w1 * (eq - this.q1) - 2 * this.z1 * this.w1 * this.v1;
      const a2 = -this.w2 * this.w2 * this.q2 - 2 * this.z2 * this.w2 * this.v2;
      const a3 = -this.w3 * this.w3 * this.q3 - 2 * this.z3 * this.w3 * this.v3;
      const baseAcc = a1 * swayMode1(this.twigS) + a2 * Math.sin(Math.PI * this.twigS) * this.twigS;
      [this.t1, this.tv1] = step(this.t1, this.tv1, this.wt, this.zt, 0, -baseAcc * 0.9);
      [this.t2, this.tv2] = step(this.t2, this.tv2, this.wt, this.zt, 0, 0);
      // 果柄单摆：果台那一点（主枝 + 嫩梢振子在该处的叠加）的加速度作为惯性力，相位再滞后一截——
      // 鸟跳 → 主枝弹颤 → 嫩梢点头 → 红果串轻盈晃荡
      const twigAccY = -this.wt * this.wt * this.t1 - 2 * this.zt * this.wt * this.tv1;
      const twigAccZ = -this.wt * this.wt * this.t2 - 2 * this.zt * this.wt * this.tv2;
      const accY = baseAcc + twigAccY * this.fruitS;
      const accX = a3 * swayMode1(this.twigS) + twigAccZ * this.fruitS;
      // 竖向分量只是"微幅"：果梗沿长度方向近似不可伸长，纯竖直的枝条加速度不该把果实整段弹起来，耦合收到水平分量的六成
      [this.f1, this.fv1] = step(this.f1, this.fv1, this.wf, this.zf, 0, -accY * 0.33);
      [this.f2, this.fv2] = step(this.f2, this.fv2, this.wf, this.zf, 0, -accX * 0.55);
    }
    const m = this.uniforms.uSwayMain.value as Vector4;
    m.set(this.q1, this.q2, this.q3, 0);
    (this.uniforms.uSwayTwig.value as Vector4).set(this.t1, this.t2, 0, 0);
    (this.uniforms.uSwayFruit.value as Vector4).set(this.f2, this.f1, 0, 0);
  }

  /** 枝条坐标系里沿主枝归一化弧长 s 处的位移（竖直、侧向，厘米）：鸟的根、落点查询都跟着它走。 */
  offsetAt(s: number, out: Vector2): Vector2 {
    const m = this.uniforms.uSwayMain.value as Vector4;
    return out.set(m.x * swayMode1(s) + m.y * Math.sin(Math.PI * s) * s, m.z * swayMode1(s));
  }

  /** 海棠嫩梢上离根归一化距离 d 处的额外位移（竖直、侧向）。 */
  twigOffsetAt(d: number, out: Vector2): Vector2 {
    const t = this.uniforms.uSwayTwig.value as Vector4;
    return out.set(t.x * d, t.y * d);
  }

  /**
   * swayBend + fruitSwing 的 CPU 镜像（顶点着色器里同一个公式）：tools/rigcheck.mjs 拿它验果台尖和果柄根在任意摇晃状态下
   * 零脱节。p 是枝条坐标系里的静止位置，sway = aSway，swing = aSwing。
   */
  displace(p: Vector3, sway: readonly [number, number, number], swing: number, out: Vector3): Vector3 {
    const m = this.uniforms.uSwayMain.value as Vector4;
    const t = this.uniforms.uSwayTwig.value as Vector4;
    const f = this.uniforms.uSwayFruit.value as Vector4;
    const s = sway[0];
    const phi1 = swayMode1(s);
    const phi2 = Math.sin(Math.PI * s) * s;
    out.set(p.x, p.y, p.z);
    out.y += m.x * phi1 + m.y * phi2;
    out.z += m.z * phi1;
    if (sway[2] > 0.5) {
      out.y += t.x * sway[1];
      out.z += t.y * sway[1];
    }
    out.x += f.x * swing;
    out.y += f.y * swing;
    return out;
  }
}
