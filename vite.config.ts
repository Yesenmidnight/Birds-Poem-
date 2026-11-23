import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

// 部署路径：GitHub Pages 在仓库子路径下（https://yesenmidnight.github.io/Birds-Poem-/），由 .github/workflows/pages.yml 传 VITE_BASE；
// 本地开发不设 = 根路径（http://localhost:5173/）。页面里的音乐 / 链接都是相对路径，两种路径都成立。
const base = process.env.VITE_BASE || '/';

export default defineConfig({
  base,
  server: {
    host: true,
    port: 5173,
  },
  build: {
    target: 'es2022',
    // 三个入口都打包：index.html 观鸟、city.html 城市漫游、garden.html 冬日庭院（不写的话只打 index.html，别的入口访问不到）
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        city: fileURLToPath(new URL('./city.html', import.meta.url)),
        garden: fileURLToPath(new URL('./garden.html', import.meta.url)),
      },
    },
  },
});
