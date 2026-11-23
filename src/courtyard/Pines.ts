/**
 * 院墙外的覆雪松柏林剪影（纯静态、无碰撞、不投影，一次绘制）：围着院子一圈，离院心 3800~5000 cm（墙外 25~38 m 的雪坡上），
 * 踩在远雪野的起伏上（farSnowHeight），高 4~9 m，五层锥叠出云杉式的尖塔轮廓（每树 35 个三角形）；
 * 两排错落（深浅各一排、间距和高度都带抖动），不成一行篱笆。雪挂在每层锥的上半截（按锥的 uv 高度），
 * 明暗噪声只用整棵树 / 针叶团两种低频（远处的厘米级噪声只会闪成麻点），材质随距离化进天光。
 * 总览机位（西南）附近留出一片空档：剪影只出现在画面深处。
 */
import { ConeGeometry } from 'three';
import type { Heightfield } from '../sim/heightfield';
import { makeRng } from '../util/math';
import { Batch } from './batch';
import { farSnowHeight } from './SnowGround';
import type { CourtyardMaterials } from './materials';

export function buildPines(batch: Batch, m: CourtyardMaterials, field: Heightfield): number {
  const rng = makeRng(505);
  let n = 0;
  const count = 230;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + (rng() - 0.5) * 0.05;
    const r = 3800 + rng() * 1200;
    const x = 300 + Math.cos(a) * r * 1.08;
    const z = Math.sin(a) * r;
    // 院门正前方（南边 x −300..−200 那段）留出视线的缺口，别把院门口堵死
    if (Math.abs(z) < 1700 && x > -520 && x < 40) continue;
    // 总览机位（西南 (−1900, 3000)）22 m 以内不种：剪影不该贴在镜头边上
    if (Math.hypot(x + 1900, z - 3000) < 2200) continue;
    const y = farSnowHeight(field, x, z) - 40;
    const h = 400 + rng() * 500;
    const yaw = rng() * Math.PI * 2;
    for (let k = 0; k < 5; k++) {
      const rk = h * 0.21 * Math.pow(1 - k / 5, 1.1) * (1 + (rng() - 0.5) * 0.2);
      const hk = h * 0.4;
      const g = new ConeGeometry(rk, hk, 7, 1, true);
      g.rotateY(yaw + k * 0.4);
      g.translate(x + (rng() - 0.5) * 6, y + h * 0.15 * k + hk * 0.5, z + (rng() - 0.5) * 6);
      batch.add('pineFar', m.pineFar, g, undefined, { cast: false, receive: false });
    }
    n++;
  }
  return n;
}
