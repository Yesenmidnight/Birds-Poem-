import { Color, Vector2, type IUniform } from 'three';

/**
 * 大气透视（观鸟入口那棵 6 米海棠老树用）：按"相机到顶点的距离"把材质往雾色里推——近景（鸟和它脚下那一段栖枝）完全不受影响，
 * 几十厘米外的老树干 / 树冠逐渐融进浅雾背景，远景整棵树读成一抹淡淡的水墨剪影。
 * lit.ts 是观鸟 / 漫游 / 庭院三条管线共用的（也是锁死的小鸟光照着色器），不在这里加雾：各材质自己 fragmentPars 拼上这段，
 * 再在 extraLight 里把自己的附加光照包进 hazeComposite —— 雾混在光照**之后**的结果上，k = 1 时正好等于天空色。
 * （第一版混在反照率里：雪地场景的日光 + 天光 + 雪地反照有 ~1.7 倍，雾色被再乘一遍后老树干反而比天空还亮，成了发白的剪影。）
 * uHazeK.x = 衰减长度（厘米，0 = 关闭）；uHazeK.y = 起算距离（厘米，以内完全不变）；uHazeMax = 远景雾化的上限
 * （老树要留六成本色，树皮才看得出苍劲、海棠果才是绛红而不是灰点）；uHazeGate = 远景门（0 = 微距机位，1 = 远景机位）：
 * 微距时几十厘米外的老树干要化成一抹融进天空的虚影（雾化不设上限），远景时才收回到 uHazeMax。
 * uHazeCol 是和天空球同一线性空间的显示色（天空球也走同一套 tonemapping），不是反照率。
 */
export const HAZE_GLSL = /* glsl */ `
uniform vec3 uHazeCol;
uniform vec2 uHazeK;
uniform float uHazeMax;
uniform float uHazeGate;
float hazeK() {
	if ( uHazeK.x <= 0.0 ) return 0.0;
	float d = distance( cameraPosition, vWorldPos ) - uHazeK.y;
	return mix( 1.0, uHazeMax, uHazeGate ) * ( 1.0 - exp( - max( d, 0.0 ) / uHazeK.x ) );
}
// 放在 extraLight 的 return 里：extraLight 是加在 shadeLit 结果上的，这里返回 mix(extra, 雾色 − 光照色, k)，
// 加上去正好是 mix(光照 + extra, 雾色, k)
vec3 hazeComposite( vec3 N, vec3 V, Surf s, vec3 extra ) {
	return mix( extra, uHazeCol - shadeLit( N, V, s ), hazeK() );
}
`;

/** 一组可共享的雾 uniform（按引用传给多个材质，App 改一次全场景同步）。默认关闭（长度 0）。 */
export function makeHazeUniforms(color = '#d3dae2', length = 0, start = 30, max = 1): Record<string, IUniform> {
  return {
    uHazeCol: { value: new Color(color) },
    uHazeK: { value: new Vector2(length, start) },
    uHazeMax: { value: max },
    uHazeGate: { value: 1 },
  };
}
