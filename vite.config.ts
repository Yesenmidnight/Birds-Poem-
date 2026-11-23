import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
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
