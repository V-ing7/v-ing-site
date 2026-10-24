---
name: ving-cg-studio
description: Generate transparent CG overlay layers with Remotion in the V-ing liquid-glass style and manage them in the v-ing CG library. Use when asked for 透明图层, 视频包装, CG素材, or 液态玻璃标题条.
---

# V-ing CG Studio

用 Remotion 产出**透明底**的 CG 包装图层（WebM VP9 alpha + 海报帧），并把文件、提示词、样式参数写入微影 V-ing 的 CG 素材库（Cloudflare D1）。

## 素材库事实

| 项 | 值 |
| --- | --- |
| 站点 | https://v-ing-site.pages.dev/#cg |
| 仓库 | https://github.com/V-ing7/v-ing-site |
| 读 | `GET https://v-ing-site.pages.dev/api/v-ing-cg`（公开） |
| 写 | `PUT` 同上，头 `X-Password: <工作台密码>`，体 `{"asset":{...}}`（upsert） |
| 删 | `DELETE /api/v-ing-cg?id=<id>`，同样需要 `X-Password` |
| 文件位置 | `assets/cg/`，记录里只能写 `assets/cg/<文件名>` 或 `https://` 链接 |
| 表 | D1 `cg_assets` |

记录字段（`asset` 对象）：
`id`（必填，`[A-Za-z0-9_-]`，≤64）、`title`、`category`（仅 `标题条` / `数据卡` / `角标` / `转场` / `其他`）、`size`、`duration`（秒，数字）、`webm`、`frames`、`mov`、`poster`、`tags`（逗号分隔）、`prompt`（原始提示词，≤4000）、`style`（样式参数，JSON 字符串，≤4000）、`sort`（整数，越小越靠前）。

细节见 `references/library-api.md`。

## 生成一个新图层

1. 复制 `assets/` 里的三个文件到一个空目录，`npm i`（Remotion 4.x + React 19）。
2. 改 `src/index.jsx` 里的 `defaultProps`（文案、尺寸、`tone`）。
3. 先渲静帧验收，再渲成片：

```bash
# 静帧（改 props 必须走 JSON 文件，不能内联）
npx remotion still src/index.jsx TitleBarGlass out/frame100.png --frame=100 --image-format=png --props="props/check.json"

# 透明 WebM
npx remotion render src/index.jsx TitleBarGlass out/asset.webm \
  --codec=vp9 --pixel-format=yuva420p --image-format=png

# PNG 序列（给 AE / PR，体积大，不建议进仓库）
npx remotion render src/index.jsx TitleBarGlass out/frames --sequence --image-format=png
```

4. 验证 alpha 真的存在（很容易翻车）：

```bash
npx remotion ffprobe -v error -show_entries stream=pix_fmt:stream_tags -of default out/asset.webm
# 应看到 TAG:ALPHA_MODE=1

# 更硬的验证：解码到 RGBA PNG 再看像素 alpha
npx remotion ffmpeg -y -v error -ss 3.3 -c:v libvpx-vp9 -i out/asset.webm -pix_fmt rgba -frames:v 1 out/probe.png
# 条子外面 alpha 必须是 0，条子里面应是半透明（约 120~180）
```

5. 上传文件到 `assets/cg/`，然后 `PUT` 一条记录，`prompt` 存需求原文、`style` 存参数 JSON。

## 风格基线（液态玻璃）

不要每次重新发明。默认沿用这条基线，用户要求变化时才改，并把改动同步写进记录里的 `style`。

- 画布 `1920x1080` / `30fps` / 120 帧（4 秒），标题条本体 `1180x232`、圆角 `44`
- 玻璃：纵向渐变 `rgba(255,255,255,0.13)` → `rgba(26,26,32,0.34)` 16% → `rgba(14,14,20,0.46)` 52% → `rgba(6,6,10,0.58)` 100%
- **不要顶部镜面高光带**（用户明确取消过）；靠 1px 白描边 + 底部内发光撑起轮廓
- 描边 `1px solid rgba(255,255,255,0.58)`，加 `inset 0 1px 0 rgba(255,255,255,0.85)`、`inset 0 0 42px rgba(255,255,255,0.10)`、外阴影 `0 18px 60px rgba(0,0,0,0.28)`
- 颗粒：`feTurbulence` 5.5% overlay（防色带，代价是 PNG 体积翻倍）
- 扫光：18° 斜向白带 `blur(12px)`，f24–86 从左扫到右，峰值不透明度 0.85
- 入场：`spring(damping 200, mass 0.9, stiffness 110)`，缩放 0.965→1、上移 30→0，f0–8 淡入
- 文字：eyebrow 21px / 字距 9 / 大写 / 白 82%；标题 74px / 600 / 纯白 / 字距 14→3 收拢（f14–32）
- 分隔线 f22–48 从 0 展开到 168px；右下角胶囊标签 f38–54 弹出
- 两套 `tone`：`dark`（烟熏，白字在任何亮度上都稳，默认）/ `light`（通透磨砂，适合深色画面）
- 背后的白色柔光默认关闭（`halo: 0`）——叠在实拍画面上会发灰

完整参数表与取值理由见 `references/style-tokens.md`。

## 坑

- `--props` 只接受 JSON **文件路径**，内联字符串会被 PowerShell/bash 吃掉引号。
- `/assets/*` 缓存 `max-age=86400`。素材改版要换文件名（`xxx-v2.webm`）并同步更新记录，否则页面一天内还是旧图。
- 1080p 4 秒的无损 PNG 序列约 70MB，超出仓库承受范围；需要交付序列时走 GitHub Release，不要直接进 `assets/`。
- 一旦 `tone: dark`，白字在亮画面上才可读；`tone: light` 配白字在亮画面上会糊。导出前必须在 `#E9E9EE` 和深色两种背景上各渲一张验收。
- WebM 的 alpha 不会让 `ffprobe` 显示 `yuva420p`，只会显示 `yuv420p` + `TAG:ALPHA_MODE=1`，不要误判成失败。
