# 北长尾山雀 · 雪精灵的冬日庭院（3DBirds）

> 一只全程序化生成的北长尾山雀：先是雪枝上的微距观鸟，点一下「展翅漫游小院 ➔」镜头一镜到底收清整座冬日小院，接着就能扮演它在雪院里蹦跳、起飞、滑翔、落枝。

**在线玩：<https://yesenmidnight.github.io/Birds-Poem-/>**（桌面浏览器 + 键盘鼠标体验最佳；页面第一次点击 / 按键后才会有背景音乐，这是浏览器的自动播放规则）

Three.js + WebGL，没有任何贴图和模型文件：鸟（身体 SDF、多壳层绒毛、逐羽片翅膀、动态腿爪）、老海棠、雪院、洋房、玻璃温室、春草与花、飘雪、散景，全部是代码生成的。

## 操作

| 按键 | 作用 |
| --- | --- |
| `W A S D` | 蹦跳 / 转向（飞行中压坡转向） |
| `空格` | 起跳；腾空 / 掉落时按住 = 展翅起飞；飞行中爬升 |
| `Shift` | 飞行冲刺 |
| `右键` / `C` | 收翼滑翔、自动落枝（电线 / 细枝有软磁吸） |
| `S`（空中） | 减速急刹 |
| `V` | 切换视角：追尾 / 过肩 / 第一人称 / 自由环绕 |
| `G` | 自由巡飞（自动驾驶） |
| `R` | 回到院心栖枝 |
| `M` | 开关"鼠标划过拨动果枝 / 草" |
| `F` | 开关掠飞巡游演示 |
| `H` | 隐藏 / 显示右侧面板 |
| `← 返回观鸟` | 右上角按钮，回到微距观鸟 |

右侧面板可以调绒毛、头部姿态、光线、背景虚化度、音乐音量。

## 三个入口

- `/`（`index.html`）—— 完整体验：观鸟 → 一镜到底 → 漫游。`?play=1` 直接进漫游态。
- `/garden.html` —— 同一个应用的直达链接。
- `/city.html` —— 早期的「城市街角」调试舞台（PCG 冬日街角 + 仿真调试台），开发用。

## 开发

```bash
npm install
npm run dev          # http://localhost:5173
npm run typecheck
npm run build        # 三个入口一起打包到 dist/
```

无头自检（需要本机 Chrome，`CHROME_PATH` 指到 chrome.exe；浏览器类脚本还要先 `npm i -D playwright-core` 和 `npm run dev`）：

```bash
node tools/sim.mjs                 # 纯数学仿真层：样条 / 碰撞 / 电线弹簧 / 步态 / 飞行 / 自动驾驶
node tools/courtyard_check.mjs     # 小院布局：通道净空 / 栖木 / 屋面 / 斜板 / 悬臂弹簧
node tools/rigcheck.mjs            # 画面网格 vs 碰撞体一致性
node tools/spring_check.mjs        # 电线下沉 / 树枝颤动 / 主角枝联动 / 雪粉 / 散景切换
node tools/roofslope_check.mjs     # 斜屋顶站立 / 雪印
node tools/music_check.mjs         # 背景音乐：手势解锁 / 切曲 / 静音 / 循环点
```

## 目录

```
src/bird/        鸟：SDF 身体、绒毛壳层、羽片、眼喙、动态腿爪、动作系统
src/world/       枝 / 果 / 雪帽 / 树皮、天空、背景、老海棠、雪粉、大气透视
src/sim/         纯数学仿真层（Node 可直接跑）：曲线栖木弹簧、碰撞、步态、飞行、自动驾驶
src/pcg/         程序化布局数据：小院 / 温室 / 城市街角 / 调试台
src/courtyard/   小院舞台：房屋、温室、植物、散景、电线、雪印、音乐、合流入口 CourtyardApp
src/roam/        第三人称操控、相机、舞台接口、城市漫游入口
src/glsl/        光照 / 程序化材质 GLSL
public/audio/    背景音乐（Suno 生成的两首 lo-fi 姊妹曲，F 大调）
tools/           无头自检与基准脚本
```

## 音乐

两首 lo-fi 姊妹曲由 Suno 生成：观鸟（lo-fi ambient lullaby）与小院（lo-fi chillhop），同为 F 大调，观鸟 ↔ 漫游切换时交叉淡化。

## 许可

[MIT](LICENSE)
