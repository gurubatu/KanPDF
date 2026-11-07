# 乱翻书（KanPDF / luanpdf）

本地 PDF 阅读器，追求「像读书」的沉浸感。提供**网页版（Docker / 局域网自托管）**和 **Tauri 桌面版**（Windows / Linux）。

技术栈：PDF.js（渲染）+ 原生 HTML/CSS/JS（界面）+ Tauri 2（桌面壳）。

> ⚠️ **本项目不包含任何图书。** 请自行准备 PDF，并确保你拥有合法使用权（自己购买、公版书、自己的文档等）。

## 特色

- **竖屏翻转阅读**：按 `R`，画面旋转 90° 并全屏，把笔记本立起来读，A4 页面占满竖屏。
- **双页对开**：按 `D`，封面单独，其后成对并排。
- 局部放大、书签、目录、翻页动画（平移 / 卷页）、记住每本书的阅读进度。

## 局域网 / Docker 部署（网页版）

网页版是纯静态页面，无需后端。

```bash
git clone <本仓库>
cd KanPDF
# 把你自己的 PDF 放进 books/ 目录
docker compose up -d --build
```

- 局域网内任意设备访问 `http://<本机IP>:8080/library.html` 选书，或 `http://<本机IP>:8080/` 打开设备上的本地文件。
- 不用 Docker：任意静态服务器托管 `web/` 目录即可（如 `python -m http.server 8123`，打开 `http://localhost:8123/web/`）。
- `books/` 以只读方式挂载到容器；可用 `?file=books/xxx.pdf` 直接打开某本书。
- 阅读进度、书签保存在**各浏览器自己的 localStorage**，不同设备之间不同步。
- 服务本身**没有认证**，请仅在可信局域网使用；暴露到公网请自行加反向代理与认证。

## 桌面版

```bash
npm install
npm run build:win        # Windows：产物在 src-tauri/target/release/bundle/nsis/
# Linux（Debian/Ubuntu）需先装依赖：
#   sudo apt install -y libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
#     librsvg2-dev patchelf build-essential curl wget file libssl-dev pkg-config
# 然后：npx tauri build
```

桌面版数据在 Tauri `app_data_dir()/data.json`。

## 操作

| 操作 | 方式 |
|---|---|
| 翻页 | `←` `→` `↑` `↓` `Space` `PgUp` `PgDn`，或点击窗口左 / 右 1/3 |
| 局部放大 | 点击页面上/中/下 1/3，或 `U` / `M` / `L`（`Esc` 恢复） |
| 双页对开 | `D`（竖屏下不可用） |
| 书签 | `B` 收藏当前页；顶栏「书签」面板 |
| 竖屏翻转 | `R`（0° → 90° → 270° → 回正） |
| 首页 / 末页 / 跳页 | `Home` / `End` / `Ctrl+G` |
| 打开文件 | `Ctrl+O` 或拖入窗口 |
| 缩放 | `Ctrl` + 滚轮，`Ctrl+0` 重置 |
| 全屏 | `F11` |

## 目录结构

```
web/                阅读器本体（零构建）
web/vendor/pdfjs/   PDF.js 构建 + CJK cmaps + 标准字体
src-tauri/          Tauri 2 桌面壳
books/              你的 PDF（Docker 挂载，不随仓库分发）
samples/            测试用 PDF（PDF.js 官方样例 + 自生成）
```

## 已知边界

- 300MB 以上文件拒绝打开；加密 PDF 不支持
- 不做：文本选择复制、批注、云同步

## 许可证

版权所有 © 2026 Gao Hongyan。以 [GNU AGPL-3.0-or-later](./LICENSE) 发布。
内置 PDF.js 为 Mozilla 的 Apache-2.0 项目，字体与解码器许可证见 `web/vendor/pdfjs/` 下各 LICENSE 文件。
