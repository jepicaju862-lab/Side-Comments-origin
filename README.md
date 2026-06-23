[![English](https://img.shields.io/badge/Language-English-blue)](README.md)
[![简体中文](https://img.shields.io/badge/Language-简体中文-red)](README.zh-CN.md)

# Side-Comments-origin

A sidebar annotation and commenting plugin for Obsidian. Side Comments allows you to highlight any text in your notes and attach standalone comments with Markdown support, image embedding, hover preview, and centralized sidebar management.

## 🌟 Features

### ✍️ Text Annotation

* Select any text in a Markdown note and attach comments instantly.
* Highlighted text is visually marked inside the editor.

### 🛠️ Selection Toolbar

* Floating toolbar automatically appears after text selection.
* Quickly add comments or change highlight colors.

### 💬 Hover Preview

* Hover over highlighted text to preview comment content in a tooltip.
* Supports Markdown rendering, links, and images.

### 📑 Sidebar Comment Management

* Dedicated **Side Comments View** for managing all comments in the current document.
* Quickly jump to the original annotated text.
* Supports:

  * Sorting by timestamp or document position
  * Global search
  * Edit / Delete actions

### 🖼️ Markdown & Image Support

* Full Markdown rendering inside comments.
* Paste or drag images directly into the comment editor.
* Images are automatically stored in a configurable attachments folder.

### 📤 Export & Backup

* Export all comments into a beautifully formatted Markdown file.
* Create standalone Markdown backups for long-term storage and synchronization.

### 🔄 Annotation Sync

* Manually sync the current file's comments into editable annotation notes.
* Generated annotation notes include a controlled backlink block with exact jump URI.
* Supports minimal reverse sync from annotation note comment body back into JSON comment data.
* Built-in conflict blocking prevents overwriting when both JSON and annotation note changed after the last sync.

### 🗂️ Settings-Driven Annotation Organization

* Configure a dedicated annotation output folder.
* Choose between:

  * `group_by_source_key`
  * `mirror_source_tree`

* Customize category-to-color mappings used for generated annotation metadata.
* The same configured mapping order is reused by the comment modal and selection toolbar color presets.

### 🧹 Orphaned Comment Detection

* Automatically detects comments whose original text has been removed.
* Orphaned comments are displayed with red dashed highlights.
* One-click cleanup available in settings.

---

## 📥 Installation

### Option 1: Community Plugins (Recommended)

*Once the plugin is available in the official community plugin directory:*

1. Open Obsidian **Settings** → **Community Plugins**.
2. Disable **Safe Mode**.
3. Click **Browse** and search for **"Side Comments"**.
4. Click **Install**, then **Enable** the plugin.

### Option 2: Manual Installation

1. Download the latest release from the [GitHub Releases Page](https://github.com/jepicaju862-lab/Side-Comments-origin/releases).
2. Extract the plugin folder into your vault:

```bash
<vault>/.obsidian/plugins/side-comments-origin/
```

3. Reload Obsidian.
4. Enable **Side Comments** in **Settings → Community Plugins**.

---

## 🧪 Development

This repository now includes a minimal local build setup for contributors.

### Prerequisites

* Node.js 22+
* npm 10+

### Local Setup

1. Install dependencies:

```bash
npm install
```

2. Run a type check:

```bash
npm run check
```

3. Build the plugin bundle:

```bash
npm run build
```

4. During active development, run watch mode:

```bash
npm run dev
```

### Notes

* `src/` contains the TypeScript source files.
* `main.js` is the generated plugin bundle committed for distribution.
* `manifest.json` remains the source of truth for the plugin version.
* `npm run version-sync` updates `package.json` to match `manifest.json`.

---

## 🖊️ Usage

### Add a Comment

1. Select any text in a Markdown note.
2. The **Selection Toolbar** will appear automatically.
3. Click the **Add Comment** button.
4. Enter your comment in the popup editor.
5. Optionally choose a custom highlight color.
6. Press `Ctrl+Enter` (`Cmd+Enter` on macOS) or click **Save**.

### Open Side Comments View

Use the command palette and run:

```text
Open Side Comments View
```

Inside the sidebar:

* View all comments as cards
* Click cards to jump to original text
* Sort comments by time or position
* Edit or delete comments from the `...` menu

### Sync Comments And Annotation Notes

Use any of the following entry points:

* Command palette: `Sync current file comments and annotations`
* Sidebar toolbar sync button
* Settings button: `Sync current file comments and annotations`

Current sync behavior:

* `source note -> annotation notes`
* `annotation note controlled comment -> JSON comment`
* no background auto-sync
* conflict cases are blocked instead of silently overwriting

### Paste Images into Comments

* Paste screenshots directly with `Ctrl+V` / `Cmd+V`
* Or drag and drop images into the editor
* Images are automatically saved and linked using Markdown syntax

### Export Comments

Click the **Export** button in the sidebar toolbar to generate a standalone Markdown summary file containing:

* Original quoted text
* Related annotations
* Structured callout formatting

---

## ⚙️ Settings

| Option                        | Description                                     |
| :---------------------------- | :---------------------------------------------- |
| **Comment sort order**        | Sort comments by timestamp or document position |
| **Show highlights in editor** | Toggle inline highlight rendering               |
| **Enable selection toolbar**  | Enable/disable floating selection toolbar       |
| **Highlight color**           | Default highlight color                         |
| **Highlight opacity**         | Adjust highlight transparency                   |
| **Markdown comments folder**  | Folder used for Markdown backups                |
| **Attachments folder**        | Folder for pasted image attachments             |
| **Comments data folder**      | Folder used for per-file JSON comment sidecars  |
| **Annotation output folder**  | Root folder for generated annotation notes      |
| **Annotation path strategy**  | `group_by_source_key` or `mirror_source_tree`   |
| **Annotation category mappings** | Category/color mapping for annotation sync   |
| **Orphaned comments**         | Manage and clean orphaned comments              |

---

## ❓ FAQ

### Are annotation notes synchronized automatically?

No. Annotation sync is currently manual by design. You trigger it from the command palette, sidebar, or settings.

### What happens if I edit both the JSON comment and the annotation note?

The plugin uses a sync baseline (`comment_hash_at_sync`) to detect drift. If both sides changed after the last sync, reverse sync is blocked and you must resolve it manually.

### Why do comments remain after deleting the original text?

Comments are linked using text anchors. If the original content is removed, the comment becomes an orphaned comment. You can remove them manually or use the cleanup option in settings.

### Can I change the color of a comment?

Yes. Edit the comment from the sidebar or use the color picker in the selection toolbar.

### Why was the popup menu hidden or clipped?

This issue was fixed in `v1.0.3` by improving CSS stacking order and overflow handling. Please update to the latest version.

---

## 🤝 Support & Feedback

If you encounter issues or have feature requests, please open an issue on the repository:

[Side Comments GitHub Repository](https://github.com/jepicaju862-lab/Side-Comments-origin)

---

## 📄 License

MIT License

---
## 🙏 Acknowledgements

This project was inspired by and references ideas from several excellent open-source annotation and commenting plugins.

Special thanks to the following projects and their contributors:

- https://github.com/catmuse/HiNote  
  For inspiration on inline annotation interactions, document highlighting workflows, and reading-note experiences.

- https://github.com/mofukuru/SideNote  
  For ideas related to sidebar-based annotation management, comment organization, and user interaction design.

We sincerely appreciate the open-source community for sharing ideas, implementations, and user experience explorations that helped shape this project.
---
## 📬 Contact

Feel free to join the community for discussions, updates, and bug reports:

* **QQ Group**: `1094620986`
