# 素材库 API 参考

## 读取

```bash
curl -s https://v-ing-site.pages.dev/api/v-ing-cg
```

```json
{ "assets": [ { "id": "...", "title": "...", "...": "..." } ], "source": "d1" }
```

按 `sort` 升序、`created_at` 降序返回。公开接口，无需密码。

## 新增 / 更新（upsert）

```bash
curl -X PUT https://v-ing-site.pages.dev/api/v-ing-cg \
  -H "X-Password: <工作台密码>" \
  -H "Content-Type: application/json; charset=utf-8" \
  -d '{"asset":{"id":"titlebar-glass","title":"液态玻璃标题条 · 片头","category":"标题条","size":"1920x1080","duration":4,"webm":"assets/cg/titlebar-glass-v2.webm","poster":"assets/cg/titlebar-glass-v2.png","tags":"透明底, 液态玻璃","prompt":"...","style":"{\"rev\":2}","sort":10}}'
```

- `id` 相同即覆盖。`created_at` 保留首次写入值。
- 密码错误返回 `403 Forbidden`；一分钟内超过 30 次写请求返回 `429`。
- `webm` / `poster` / `frames` / `mov` 只接受 `assets/cg/<文件>` 或 `https://` 链接，其它值会被清空。

## 删除

```bash
curl -X DELETE "https://v-ing-site.pages.dev/api/v-ing-cg?id=titlebar-glass" -H "X-Password: <工作台密码>"
```

只删数据库记录，不会删 `assets/cg/` 里的文件。

## 字段约束

| 字段 | 约束 |
| --- | --- |
| `id` | `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` |
| `title` | 必填，≤120 |
| `category` | 不在 `标题条/数据卡/角标/转场/其他` 内会被强制改成 `其他` |
| `duration` | 数字，0–600 |
| `tags` / `size` | `size` ≤40，`tags` ≤200 |
| `prompt` / `style` | ≤4000 字符 |

## 前端如何消费

`js/app.js` 末尾的 CG 模块：

- 打开 `#cg` 视口时 `GET` 一次并缓存，分类筛选纯前端。
- 卡片预览优先用 `<video autoplay loop muted playsinline>` 播 `webm`，回退到 `poster` 图。
- 管理入口「管理素材」用工作台密码（`POST /api/v-ing-verify`）放行，之后写操作带 `X-Password`。
