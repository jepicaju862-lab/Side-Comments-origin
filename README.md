[![English](https://img.shields.io/badge/Language-English-blue)](README.md)
[![简体中文](https://img.shields.io/badge/Language-简体中文-red)](README.zh-CN.md)

# Side Comments origin

A local, non-intrusive sidebar annotation plugin for Obsidian. Select text in a
Markdown note, apply a visual mark, and attach standalone Markdown comments
without inserting extra syntax into the original note.

- **Website:** [peyote.info](https://peyote.info/)
- **Current release:** [v1.0.10](https://github.com/jepicaju862-lab/Side-Comments-origin/releases/tag/1.0.10)
- **Minimum Obsidian version:** 0.15.0
- **Platforms:** desktop and mobile

> **Interface language:** plugin commands, settings, and most interface text are
> currently in Simplified Chinese.

## 🌟 Features

### ✍️ Text Annotation and Visual Marks

- Select text in a Markdown note and attach a standalone comment.
- Choose from four visual styles: **highlight, underline, strikethrough, and
  bold**.
- Assign one of five preset colors or a custom color to each annotation.
- Existing annotated selections are recognized and edited instead of duplicated.
- Visual marks appear in both editing view and reading view.

The four styles are visual choices only. Version 1.0.4 does not add semantic
categories such as note, question, task, or warning, and it does not add a
resolved state.

### 🛠️ Selection Toolbar

- A floating toolbar appears after selecting text in editing view.
- Apply a visual style, choose a color, or open the annotation editor directly.
- The toolbar restores the style and color of an existing annotation.
- The feature can be disabled in Settings.

Comments can also be created from the context menu, command palette, or custom
hotkeys.

### 👁️ Editing and Reading Views

| Action | Editing view | Reading view |
| :--- | :--- | :--- |
| Click a mark | Locate its sidebar card | Locate its sidebar card |
| Double-click a mark | Open the annotation editor | Open the annotation editor |
| Hover a mark | Show a compact hint | Preview content and quick actions |
| Modifier-click a link | Preserve editor behavior | Preserve normal link opening |

Opening an annotation from any entry point reuses the same editor window.
Version 1.0.4 fixes the issue where a double-click could open editors for
multiple annotations at once.

### 💬 Hover Preview

- Hover over marked text in reading view to preview rendered comment content.
- Markdown, links, and embedded images are supported.
- Quick actions can open the sidebar or edit the annotation.

### 📑 Sidebar Comment Management

The dedicated **Side Comments View** follows the active Markdown note.

- View annotations as cards and jump to their original text.
- Search quoted text and annotation content in the current note.
- Sort by document position or creation time.
- Collapse or expand all annotation bodies.
- Edit, copy a precise backlink, search the vault, or delete an annotation.
- Restore a deleted annotation for seven seconds.
- Use style icons and colored borders to identify annotations quickly.

### 🖼️ Markdown and Image Support

- Write annotation content in Markdown.
- Paste images directly into the annotation editor.
- Images are stored in a configurable attachment folder inside the vault.
- The editor supports dragging, automatic textarea growth, and focus recovery.

### 📤 Export and Backup

- Export all annotations for the current note as a Markdown summary.
- Copy a precise Obsidian callout backlink containing the quote, annotation, and
  an `obsidian://sidenote` jump link.
- Export the current Markdown note to `.docx` with locatable annotations
  preserved as native Word comments.
- Create standalone Markdown backups for long-term storage and synchronization.

### 🧭 Text Tracking and Orphaned Comments

Annotations are relocated using document positions, absolute offsets, selected
text and its SHA-256 hash, heading paths, occurrence indexes, and surrounding
context.

- Moved text is matched again and its coordinates are updated when possible.
- An annotation becomes orphaned only when the original text can no longer be
  found reliably.
- Settings shows the orphan count and provides batch cleanup.

### ⌨️ Accessible and Mobile Interaction

- Sidebar cards and menus support keyboard navigation.
- Annotation editors stay inside the mobile viewport.
- Style, color, and menu buttons use touch-friendly sizes.
- The selection toolbar scrolls horizontally on narrow screens.
- Long-press text selection works with commands and the selection toolbar.

---

## 📥 Installation

### Option 1: Community Plugins

Once the plugin is available in the official Community Plugins directory:

1. Open Obsidian **Settings → Community plugins**.
2. Select **Browse** and search for **Side Comments origin**.
3. Select **Install**, then enable the plugin.

### Option 2: Manual Installation

1. Download the latest release from the
   [GitHub Releases page](https://github.com/jepicaju862-lab/Side-Comments-origin/releases).
2. Copy these files into the plugin directory:
   - `main.js`
   - `manifest.json`
   - `styles.css`
3. The final directory should be:

```text
<vault>/.obsidian/plugins/side-comments-origin/
```

4. Reload Obsidian.
5. Enable **Side Comments origin** in **Settings → Community plugins**.

---

## 🖊️ Usage

### Add a Comment

1. Select text in a Markdown editing view.
2. Choose a visual style and color from the selection toolbar.
3. Open the annotation editor when you want to add Markdown content.
4. Select **添加** (*Add*) or press `Ctrl/Cmd + Enter` to save.

### Open Side Comments View

Run one of these commands from the command palette:

- **在侧边栏打开批注视图** — open in the sidebar
- **在分屏中打开批注视图** — open in a split

Inside the view, click a card to locate its source text or double-click it to
edit. Additional actions are available from the card menu.

### Paste Images into Comments

Paste a screenshot or image with `Ctrl+V` / `Cmd+V` while the annotation editor
is focused. The image is saved to the configured attachment folder and linked
using Markdown syntax.

### Export Comments

Use the export action in the sidebar to generate a Markdown summary containing
the original quoted text, annotation content, and structured callouts.

---

## ⌨️ Keyboard Shortcuts

### Annotation Editor

| Key | Action |
| :--- | :--- |
| `Ctrl/Cmd + Enter` | Save the annotation |
| `Esc` | Close the editor |
| `←` / `→` | Move between visual styles |
| `Home` / `End` | Move to the first or last style |

### Sidebar

| Key | Action |
| :--- | :--- |
| `Tab` | Focus cards and action buttons |
| `Enter` / `Space` | Locate the focused annotation |
| `F2` | Edit the focused annotation |
| `↑` / `↓` | Move through an action menu |
| `Home` / `End` | Move to the first or last menu item |
| `Esc` | Close the menu and return focus |

---

## ⚙️ Settings

| Option | Description |
| :--- | :--- |
| **Comment sort order** | Sort by document position or creation time |
| **Show annotation marks** | Toggle marks in editing and reading views |
| **Enable selection toolbar** | Show quick actions after selecting text |
| **Default color** | Apply a color to newly created annotations |
| **Mark opacity** | Adjust visual mark opacity |
| **Markdown backup folder** | Defaults to `side-note-comments` |
| **Attachments folder** | Defaults to `side-note-attachments` |
| **Annotation data folder** | Defaults to `side-note-data`; reload after changing it |
| **Create Markdown backup** | Generate a manual annotation backup |
| **Orphaned annotations** | Inspect and remove annotations that cannot be located |

---

## 🔒 Data and Privacy

- Annotations are stored per note as JSON in `side-note-data` by default.
- Plugin settings and legacy migration state are stored in `data.json`.
- Pasted images are stored in `side-note-attachments` by default.
- Manual Markdown backups are stored in `side-note-comments` by default.
- Clipboard access occurs only when you explicitly paste an image or copy an
  annotation backlink; the plugin does not monitor the clipboard in the
  background.
- All folders are inside the vault and can be changed in Settings.
- Note renames update their annotation references.
- The plugin code makes no network requests.

### Backward Compatibility

- An older annotation without `markType` is displayed as a highlight.
- An older annotation without its own color uses the plugin default.
- Legacy annotations in `data.json` are migrated to per-note JSON files.
- Version 1.0.4 does not change the meaning of existing annotations.

Back up your vault, or at least the annotation data folder, before a major
upgrade.

---

## ❓ FAQ

### Can comments be displayed and edited in reading view?

Yes. Marks are rendered in reading view. Click a mark to locate its sidebar
card, double-click to edit, or hover to preview the annotation and quick actions.

### Can I change the style and color of an existing annotation?

Yes. Open the annotation editor from the text mark or sidebar card, then choose
another visual style, preset color, or custom color.

### Why does an annotation remain after deleting the original text?

Annotations are stored independently from Markdown. If the original text can no
longer be found, the annotation becomes orphaned and can be removed from
Settings.

### Why did double-clicking one annotation open many editor windows?

This was caused by duplicate event handling and is fixed in v1.0.4. The plugin
now keeps only one annotation editor open at a time.

### Where is annotation data stored?

By default, per-note JSON files are stored in `side-note-data` inside the vault.
The folder can be changed in Settings.

---

## 🧑‍💻 Development

```bash
npm install
npm run build
```

The production build runs a TypeScript check and writes `main.js` to the
repository root.

## 📋 Release Notes

Version 1.0.4 adds reading-view interaction, four visual mark styles, independent
colors, the selection toolbar, a unified editor, sidebar workflow improvements,
Word export, Markdown backups, attachments, precise backlinks, mobile and
accessibility fixes, and the multiple-editor fix.

See [RELEASE_NOTES.md](RELEASE_NOTES.md) for the full change list.

---

## 🤝 Support and Feedback

- **Bug reports — [this repository's issue tracker][issues].** Include your
  Obsidian version, operating system, a minimal Markdown note, and the related
  annotation JSON from `side-note-data` whenever possible.
- **Questions and discussion — QQ group `1094620986`.** The group communicates
  in Simplified Chinese.
- **Email — <jepicaju862@gmail.com>.** Use email for private reproduction files
  or anything you would rather not post publicly.
- **Official website — [peyote.info](https://peyote.info/).**

[issues]: ../../issues

---

## 📄 License

[GNU General Public License v3.0](LICENSE)

---

## 🙏 Acknowledgements

This project was inspired by and references ideas from excellent open-source
annotation and commenting plugins:

- [HiNote](https://github.com/catmuse/HiNote) — inline annotation interactions,
  document highlighting workflows, and reading-note experiences.
- [SideNote](https://github.com/mofukuru/SideNote) — sidebar annotation
  management, comment organization, and interaction design.

Thank you to the open-source community and every contributor who shared ideas,
implementations, and user experience explorations.

---

## 📬 Contact

- **QQ group:** `1094620986`
- **Email:** <jepicaju862@gmail.com>
- **Website:** [peyote.info](https://peyote.info/)
