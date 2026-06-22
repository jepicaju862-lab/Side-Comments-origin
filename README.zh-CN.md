
[![English](https://img.shields.io/badge/Language-English-blue)](README.md)
[![简体中文](https://img.shields.io/badge/Language-简体中文-red)](README.zh-CN.md)

# Side-Comments-origin
一款专为 Obsidian 打造的侧边栏批注与评论插件。你可以对 Markdown 文档中的任意文本进行高亮批注，并通过侧边栏统一管理所有评论，支持 Markdown 渲染、图片插入、悬浮预览、导出与备份等功能。

---

## 🌟 功能特性

### ✍️ 文本批注
- 支持对任意文本进行划词评论
- 被批注内容将在编辑器中高亮显示

### 🛠️ 划词快捷工具栏
- 选中文本后自动弹出悬浮工具栏
- 快速添加评论与切换高亮颜色

### 💬 悬浮预览
- 鼠标悬停在高亮文本上即可预览评论内容
- 支持 Markdown 渲染、链接与图片显示

### 📑 侧边栏评论管理
- 提供专属的 Side Comments View
- 集中展示当前文档中的所有评论
- 支持：
  - 按时间排序
  - 按文档位置排序
  - 全局搜索
  - 编辑 / 删除评论

### 🖼️ Markdown 与图片支持
- 评论内容完全支持 Markdown 语法
- 支持直接粘贴或拖拽图片
- 图片会自动保存至附件文件夹并生成 Markdown 链接

### 📤 导出与备份
- 一键导出当前文档所有评论为 Markdown 文件
- 支持独立 Markdown 文件备份与同步

### 🧹 孤立评论检测
- 自动检测原文已删除的评论
- 孤立评论会显示为红色虚线高亮
- 支持一键清理

---

## 📥 安装方式

### 方式一：社区插件（推荐）
*插件上架 Obsidian 社区后可使用此方式：*

1. 打开 Obsidian → **设置** → **第三方插件**
2. 关闭安全模式
3. 点击 **浏览**
4. 搜索 **"Side Comments"**
5. 点击 **安装** 并启用插件

### 方式二：手动安装
1. 从 GitHub Releases 页面下载最新版本：
   https://github.com/jepicaju862-lab/Side-Comments-origin/releases

2. 解压插件文件夹至：

```bash
<vault>/.obsidian/plugins/side-comments/
````

3. 重启 Obsidian
4. 在 **设置 → 第三方插件** 中启用插件

---

## 🧪 本地开发

仓库现已补齐最小可用的本地构建环境，便于继续二次开发。

### 环境要求

- Node.js 22+
- npm 10+

### 初始化

1. 安装依赖：

```bash
npm install
```

2. 执行类型检查：

```bash
npm run check
```

3. 构建插件产物：

```bash
npm run build
```

4. 开发时使用监听模式：

```bash
npm run dev
```

### 说明

- `src/` 为 TypeScript 源码目录
- `main.js` 为提交到仓库的构建产物
- `manifest.json` 仍然是插件版本号的事实来源
- `npm run version-sync` 可将 `package.json` 版本同步到 `manifest.json`

---

## 🖊️ 使用方法

### 添加评论

1. 在 Markdown 文档中选中任意文本
2. 自动弹出划词工具栏
3. 点击“添加评论”
4. 输入评论内容
5. 可选择高亮颜色
6. 使用 `Ctrl+Enter`（macOS 为 `Cmd+Enter`）保存

### 打开 Side Comments View

通过命令面板执行：

```text
Open Side Comments View
```

在侧边栏中你可以：

* 查看所有评论卡片
* 点击评论快速跳转原文
* 切换排序方式
* 编辑或删除评论

### 插入图片

* 使用 `Ctrl+V` / `Cmd+V` 直接粘贴图片
* 或拖拽图片到评论输入框
* 插件会自动保存附件并生成 Markdown 引用

### 导出评论

点击侧边栏顶部的 **Export** 按钮，即可生成当前文档的评论汇总 Markdown 文件。

---

## ⚙️ 设置选项

| 选项                        | 描述            |
| :------------------------ | :------------ |
| Comment sort order        | 评论排序方式        |
| Show highlights in editor | 是否显示文本高亮      |
| Enable selection toolbar  | 是否启用划词工具栏     |
| Highlight color           | 默认高亮颜色        |
| Highlight opacity         | 高亮透明度         |
| Markdown comments folder  | Markdown 备份目录 |
| Attachments folder        | 图片附件目录        |
| Orphaned comments         | 管理孤立评论        |

---

## ❓ 常见问题

### 为什么删除原文后评论还存在？

评论通过文本锚点进行定位。当原文被删除后，评论会变成“孤立评论”。你可以在设置中一键清理。

### 如何修改评论颜色？

可在侧边栏编辑评论时修改颜色，或直接使用划词工具栏中的颜色选择器。

### 为什么菜单会被遮挡？

该问题已在 `v1.0.3` 中修复。请确保插件已更新至最新版本。

---

## 🤝 反馈与支持

如果你遇到问题或有功能建议，欢迎提交 Issue：

[https://github.com/jepicaju862-lab/Side-Comments](https://github.com/jepicaju862-lab/Side-Comments-origin)

---

## 📄 License

MIT License

---
## 🙏 致谢

本项目在开发过程中参考并借鉴了多个优秀的开源批注与注释插件项目的设计思路与交互体验。

特别感谢以下项目及其贡献者：

- https://github.com/catmuse/HiNote  
  为文档内联批注交互、高亮标注流程以及阅读笔记体验提供了灵感。

- https://github.com/mofukuru/SideNote  
  为侧边栏批注管理、评论组织方式以及用户交互设计提供了参考。

感谢开源社区分享的优秀想法、实现方案与用户体验探索，这些都对本项目的完善与成长提供了重要帮助。

---
## 📬 联系方式

欢迎交流、反馈 Bug 与获取更新：

* QQ群：`1094620986`

