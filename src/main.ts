import './style.css';
import { App } from './core/App';

const root = document.getElementById('app');
if (!root) throw new Error('缺少 #app 容器');

const params = new URLSearchParams(location.search);
const dprParam = parseFloat(params.get('dpr') ?? '');
const ui = params.get('ui') !== '0';
const app = new App(root, {
  ui,
  dprCap: Number.isFinite(dprParam) && dprParam > 0 ? dprParam : 2,
});
app.start(params.get('view') ?? 'threequarter');

// 画面底部正中的主入口：面板关着（截图 / 调试）时一并藏掉
const cta = document.querySelector<HTMLElement>('.stage-cta');
if (cta) cta.hidden = !ui;
// 两帧之后（setAnimationLoop 的第一帧已经画出去）再揭开进场淡入，不然遮罩退了画布还是黑的
requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.add('is-ready')));

// 带 data-fade 的链接（底部主入口 / 面板里的入口）：0.25 s 柔和淡出到深色遮罩，过渡结束再跳转
const FADE_MS = 250;
document.addEventListener('click', (e) => {
  const a = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>('a[data-fade]') : null;
  if (!a) return;
  e.preventDefault();
  document.getElementById('fade')?.classList.add('is-leaving');
  setTimeout(() => location.assign(a.href), FADE_MS);
});

// 供自动化截图脚本与浏览器控制台调试用
Object.assign(window, { __birds: app });
