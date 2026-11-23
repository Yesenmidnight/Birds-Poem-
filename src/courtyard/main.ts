import '../style.css';
import './garden.css';
import { CourtyardApp } from './CourtyardApp';

// 合流后的唯一入口（index.html 和 garden.html 都指向这里）：进场 = 小院内微距观鸟（长焦浅景深、右侧观鸟面板、底部「展翅漫游小院 ➔」），
// 点按钮一镜到底收小光圈对焦整座小院、镜头接到追尾视角进漫游；右上角「← 返回观鸟」再回来。
// ?play=1 直接以清晰漫游态启动；?play=0&view=xxx 观鸟微距 / 小院展示机位截图（非微距机位自动清晰）；?ui=0 不建面板和按钮。
const root = document.getElementById('app');
if (!root) throw new Error('缺少 #app 容器');

const params = new URLSearchParams(location.search);
const dpr = parseFloat(params.get('dpr') ?? '');
const ui = params.get('ui') !== '0';
const app = new CourtyardApp(root, {
  ui,
  debug: params.get('debug') === '1',
  dprCap: Number.isFinite(dpr) && dpr > 0 ? dpr : 2,
  // 掠飞巡游演示默认关（画面里有一只真鸟了），?tour=1 才开
  tour: params.get('tour') === '1',
  // 默认观鸟微距态；?play=1 = 清晰漫游态
  play: params.get('play') === '1',
  // 背景音乐默认开（第一次点击 / 按键才出声）；?music=0 关
  music: params.get('music') !== '0',
});
// 开场机位 = 观鸟微距 threequarter；?view=overview 等展示机位照旧可用（清晰全画）
app.start(params.get('view') ?? 'threequarter');

// 两帧之后（setAnimationLoop 的第一帧已经画出去）再揭开进场淡入，不然遮罩退了画布还是黑的
requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.add('is-ready')));

// 供 tools/shoot.mjs 多机位截图、tools/rigcheck.mjs（读 __birds.branches）与浏览器控制台调试：__birds 是 shoot.mjs 约定的名字
Object.assign(window, { __birds: app, __garden: app });
