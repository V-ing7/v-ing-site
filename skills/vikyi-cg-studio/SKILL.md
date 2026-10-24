---
name: vikyi-cg-studio
description: Generate transparent CG overlay layers for Vikyi's V-ing site with Remotion in his liquid-glass style, and manage the v-ing CG library. Use when asked for 透明图层, 视频包装, CG素材, or 液态玻璃素材.
---

# Vikyi 的 CG 工作台

Vikyi 要的是**干净、能直接叠在实拍上**的透明图层，不是炫技动效。默认动作是「按基线做一条、验两种背景、入库、问下一条」，不是「自由发挥」。

## 硬规则（不要自作主张改）

1. **不要顶部镜面高光带**。用户明确取消过，不要再加回来。
2. **不要扫光**。任何横穿画面的光带、光束、亮扫过一律不加。
3. **不要背后柔光（halo）**。叠在实拍上会发灰，默认 `0`。
4. **白字配深色烟熏玻璃**。导出前必须在亮背景（`#E9E9EE`）和深色背景上各渲一张验收，亮底看不清就压深玻璃。
5. **一次只做一条素材**。做完先把分类定好（标题条 / 数据卡 / 角标 / 转场 / 其他），再问下一条要做什么。
6. **默认 4K 交付**：`3840x2160` / `30fps`。本体按设计单位写（1180×232、圆角 44），靠组件的 `scale: 2` 等比放大；不要手写 2360×464 这类派生值。
7. **改版换文件名**（`xxx-v3.webm` → `xxx-v4.webm`）。`/assets/*` 缓存一天，覆盖同名文件页面不会更新。
8. **提示词存他的中文原话**，不要翻译、不要「优化」成英文 prompt。
9. **改了参数就同步写回 D1 的 `style`**。页面展示的提示词与样式必须和实际文件一致，不能一个说「有扫光」另一个没有。
10. **每次交付完往 `operationLog` 追加一条**（`date` / `time` / `action` / `status`），走 `PUT /api/v-ing-data`。
11. **不确定就问**。他明确说过「不懂可反复询问，确保按照我的想法」。

## 素材库事实

| 项 | 值 |
| --- | --- |
| 站点 | https://v-ing-site.pages.dev/#cg |
| 仓库 | https://github.com/V-ing7/v-ing-site |
| 读 | `GET https://v-ing-site.pages.dev/api/v-ing-cg`（公开） |
| 写 | `PUT` 同上，头 `X-Password: <工作台密码>`，体 `{"asset":{...}}`（按 id upsert） |
| 删 | `DELETE /api/v-ing-cg?id=<id>`，同样需要 `X-Password` |
| 文件 | 放 `assets/cg/`；记录里只能写 `assets/cg/<文件名>` 或 `https://` 链接 |
| 表 | D1 `cg_assets` |
| 密码 | 问 Vikyi 要，不要猜、不要写进仓库 |

记录字段：`id`（必填，`[A-Za-z0-9_-]`，≤64）、`title`、`category`、`size`、`duration`（秒）、`webm`、`frames`、`mov`、`poster`、`tags`（逗号分隔）、`prompt`（≤4000）、`style`（JSON 字符串，≤4000）、`sort`。
字段细节见 `references/library-api.md`。

## 生成一条新素材

1. 把 `assets/` 三个文件复制到一个空目录，`npm i`（Remotion 4.x + React 19）。
2. 改 `src/index.jsx` 里 `defaultProps` 的文案：`eyebrow`（英文小字，字距 9、大写）、`title`（主标题）、`tag`（右下角胶囊）。中文用 PingFang SC / 微软雅黑。
3. 先渲静帧验收，再渲成片：

```bash
# 静帧。--props 只认 JSON 文件路径，内联字符串会被 shell 吃掉引号
npx remotion still src/index.jsx TitleBarGlass out/f100.png --image-format=png --frame=100
npx remotion still src/index.jsx TitleBarPreview out/onlight.png --frame=100 --props="props/bright-dark.json"

# 透明 WebM（VP9 + alpha）
npx remotion render src/index.jsx TitleBarGlass out/asset.webm \
  --codec=vp9 --pixel-format=yuva420p --image-format=png

# 海报帧
npx remotion still src/index.jsx TitleBarGlass out/poster.png --frame=100 --image-format=png
```

4. 验证 alpha 真的在（这一步最容易被跳过）：

```bash
npx remotion ffprobe -v error -show_entries stream=pix_fmt:stream_tags -of default out/asset.webm
# 成功标志：TAG:ALPHA_MODE=1。看到 pix_fmt=yuv420p 是正常的，不代表失败

# 硬验证：解码到 RGBA 再看像素
npx remotion ffmpeg -y -v error -ss 3.3 -c:v libvpx-vp9 -i out/asset.webm -pix_fmt rgba -frames:v 1 out/probe.png
# 条子外 alpha = 0；条子内半透明（约 120~180）
```

5. 上传到 `assets/cg/`（新文件名带版本号），再 `PUT` 一条记录：`prompt` 填 Vikyi 的中文原话，`style` 填实际参数 JSON。
6. 上线后打开 `https://v-ing-site.pages.dev/#cg` 确认卡片能播、提示词能展开。

## 风格基线（v4，2026-10-24 · 4K）

不要每次重新发明。只在用户要求变化时改，改完写回 `style`。

- 画布 `3840x2160` / `30fps` / 120 帧（4 秒）；`scale: 2`
- 本体设计单位 `1180x232`、圆角 `44`（实际 2360×464 / 圆角 88）
- 玻璃：`linear-gradient(180deg, rgba(255,255,255,0.13) 0%, rgba(26,26,32,0.34) 16%, rgba(14,14,20,0.46) 52%, rgba(6,6,10,0.58) 100%)`
- 描边 `1px solid rgba(255,255,255,0.58)` + `inset 0 1px 0 rgba(255,255,255,0.85)`、`inset 0 -1px 0 rgba(255,255,255,0.22)`、`inset 0 0 42px rgba(255,255,255,0.10)`、外阴影 `0 18px 60px rgba(0,0,0,0.28)`（以上均为设计单位，实际 ×2）
- 底部内发光：2px 白线，left/right 各内缩 8%，两端渐隐，opacity 0.7
- 颗粒：`feTurbulence baseFrequency 0.85 numOctaves 3 seed 7`，opacity 0.055，overlay
- **没有高光带、没有扫光、没有 halo**
- 入场：`spring(damping 200, mass 0.9, stiffness 110)`，scale 0.965→1、y 30→0，f0–8 淡入
- 文字（设计单位，实际 ×2）：eyebrow 21px / 字距 9 / 白 82% / f10–24 上浮；标题 74px / 600 / 纯白 / 字距 14→3（f14–40）；分隔线 f22–48 展开到 168px；胶囊 f38–54 弹出
- `tone`：`dark`（默认，烟熏）/ `light`（通透，只配深色画面）

**缩放规则**：组件里所有尺寸走 `u(n) = n * scale`，`width/height/radius` 传设计单位。要出 1080p 就把 composition 改成 1920×1080 且 `scale: 1`，其它分辨率同理，不要手改派生像素。

完整取值与理由见 `references/style-tokens.md`。

## 当前资产

| id | 文件 | 说明 |
| --- | --- | --- |
| `titlebar-glass` | `assets/cg/titlebar-glass-v4.webm` + `-v4.png` | 液态玻璃标题条，4K / 30fps / 4 秒，深色烟熏，无高光无扫光 |

## 坑

- `--props` 只接受 JSON **文件路径**。
- 1080p 4 秒无损 PNG 序列约 70MB，不要进仓库；要交付序列走 GitHub Release。
- 颗粒只占条内面积，但让 PNG 单帧从 ~230KB 涨到 ~580KB。
- 透明画布上 `backdrop-filter` 无效（背后没有内容），玻璃质感必须靠多层半透明 + 描边模拟。
- 改完素材别忘同步 `style` 与 `prompt`，否则技能下次会照着过时参数做。
