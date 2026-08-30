# 微影 V-ing · 企划官网

> 我们——正在进行时

纪实向视频创作账号「微影 V-ing」的企划官网，纯静态、单目录、无构建依赖。

## 页面

| 文件 | 说明 |
| --- | --- |
| `index.html` | 账号企划官网：定位、企划、装备、工作流、平台、关于、合作 |
| `ep01.html` | EP.01《南日岛：海风吹过的地方，我们正在进行时》完整拍摄企划案 |

## 本地预览

```bash
python3 -m http.server 8080
# 打开 http://localhost:8080
```

## 技术

- 纯 HTML / CSS / JavaScript，单文件页面，无外部依赖图片
- 暗色「剪辑房 / 取景器」视觉系统：琥珀点缀、REC 红点、等宽时码
- 响应式布局，支持 `prefers-reduced-motion`

## 上线前替换占位内容

在 `index.html` 中搜索并替换：

- `PROFILE_URL_BILIBILI` / `PROFILE_URL_DOUYIN` → 真实主页链接
- `hi@ving.media` → 真实商务邮箱
