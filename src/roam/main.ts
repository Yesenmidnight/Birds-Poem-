import '../style.css';
import './roam.css';
import { RoamApp } from './RoamApp';

// 城市漫游入口，与观鸟入口（index.html → src/main.ts → core/App）完全分开：
// 只共用鸟（src/bird）、世界部件（src/world）、光照与面板这些模块，不碰对方的入口文件。
const root = document.getElementById('app');
if (!root) throw new Error('缺少 #app 容器');

const params = new URLSearchParams(location.search);
const num = (key: string): number => {
  const v = parseFloat(params.get(key) ?? '');
  return Number.isFinite(v) ? v : NaN;
};
const dpr = num('dpr');
const app = new RoamApp(root, {
  ui: params.get('ui') !== '0',
  hud: params.get('hud') !== '0',
  dprCap: dpr > 0 ? dpr : 2,
  autoLod: params.get('lod') !== '0',
  rig: params.get('rig') !== '0',
  play: params.get('play') !== '0',
  fov: num('fov'),
});
app.start(params.get('view') ?? 'tp35');

// 供自动化截图 / 基准脚本与浏览器控制台调试用。__birds 是 tools/shoot.mjs、tools/bench.mjs 约定的名字
Object.assign(window, { __roam: app, __birds: app });
