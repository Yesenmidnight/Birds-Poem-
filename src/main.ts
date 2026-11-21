import './style.css';
import { App } from './core/App';

const root = document.getElementById('app');
if (!root) throw new Error('缺少 #app 容器');

const params = new URLSearchParams(location.search);
const dprParam = parseFloat(params.get('dpr') ?? '');
const app = new App(root, {
  ui: params.get('ui') !== '0',
  dprCap: Number.isFinite(dprParam) && dprParam > 0 ? dprParam : 2,
});
app.start(params.get('view') ?? 'threequarter');

// 供自动化截图脚本与浏览器控制台调试用
Object.assign(window, { __birds: app });
