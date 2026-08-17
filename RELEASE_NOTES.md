
# Side Comments origin v1.0.10 Release Notes

- Release date: August 17, 2026
- Minimum Obsidian version: 0.15.0
- Supported platforms: desktop and Obsidian Mobile

## Release Review Fixes

- Removed four dynamic `<script>` creation paths and the related
  `new Function()` path inherited from the legacy JSZip scheduling fallbacks
  bundled by `docx`.
- Added an exact, fail-closed build transformation that removes only those
  obsolete Internet Explorer fallbacks. Native timers and `MessageChannel`
  remain available on supported Obsidian platforms.
- Added a post-build security gate that rejects any future bundle containing
  dynamic script creation, `eval()`, or `new Function()`.
- Verified Word export after the change by generating a DOCX with a native
  annotation and validating its ZIP signature and annotation count.
- Updated the release workflow to publish only Obsidian's three supported
  assets: `main.js`, `manifest.json`, and `styles.css`.
- Removed the unsupported ZIP archive from the v1.0.9 GitHub Release.

Clipboard access remains limited to explicit user actions: copying an
annotation backlink or pasting an image into the annotation editor. The plugin
does not perform clipboard access in the background.

This release does not add semantic annotation types or a resolved state, and it
does not change the stored annotation data format.

---

# Side Comments origin v1.0.9 Release Notes

- Release date: August 17, 2026
- Minimum Obsidian version: 0.15.0
- Supported platforms: desktop and Obsidian Mobile

## Automated Review Cleanup

- Resolved all source-code warnings and recommendations reported against
  v1.0.8 by the official Obsidian review rules.
- Added declarative setting definitions for Obsidian 1.13+ settings search
  while preserving the existing settings interface on older Obsidian releases.
- Replaced deprecated Markdown rendering, notice, and string APIs with their
  supported equivalents.
- Replaced generic DOM creation with Obsidian helpers and made DOM type checks
  safe across popout windows.
- Added explicit types for internal Obsidian integration boundaries, editor
  selections, preview rendering, plugin data, and CodeMirror access.
- Corrected asynchronous event handling so promises are awaited or explicitly
  detached, including sidebar rendering, navigation, clipboard, and tooltip
  work.
- Standardized timers on `window.setTimeout()` and `window.clearTimeout()` for
  popout-window compatibility.
- Removed unused values, unnecessary assertions, an empty catch block, and the
  obsolete selection-coordinate calculation.

The production build and official lint rules complete with zero errors and zero
warnings. This release does not add semantic annotation types or a resolved
state, and it does not change the stored annotation data format.

---

# Side Comments origin v1.0.8 Release Notes

- Release date: August 17, 2026
- Minimum Obsidian version: 0.15.0
- Supported platforms: desktop and Obsidian Mobile

## Review Compliance and Compatibility

- Replaced static inline style assignments with CSS classes or Obsidian's
  `setCssStyles` helper.
- Replaced the manual settings heading with `Setting.setHeading()`.
- Removed unsafe `innerHTML` entity decoding and runtime `<style>` injection.
- Moved default visual variables and loading/dragging states into `styles.css`.
- Replaced Node.js `crypto`, `require`, and `Buffer` fallbacks with Web Crypto
  and a browser-compatible fallback for mobile support.
- Replaced the hardcoded `.obsidian` plugin data path with `Vault.configDir`.
- Declared CodeMirror packages as direct dependencies and removed the obsolete
  `builtin-modules` package.
- Added the official `eslint-plugin-obsidianmd` rules and a release lint gate.
- Updated the build toolchain; dependency audit now reports zero known
  vulnerabilities.

This release changes implementation and review compliance only. It does not add
semantic annotation types or a resolved state, and it does not change the
stored annotation data format.

---

# Side Comments origin v1.0.5 Release Notes

Release date: August 10, 2026  
Minimum Obsidian version: 0.15.0  
Supported platforms: desktop and Obsidian Mobile

## Overview

Version 1.0.5 is a comprehensive upgrade focused on reading view, visual marks,
and annotation interaction. It unifies the annotation workflow across editing
view, reading view, and the sidebar; adds four visual styles, independent colors
for each annotation, Word export, mobile support, and keyboard accessibility;
and resolves stability issues caused by plugin hot reloads and duplicate event
listeners.

This release expands visual styling only. It does not add semantic categories
such as note, question, task, or warning, and it does not add a resolved state.

## New Features

### Reading View Annotations

- Annotation marks are now displayed directly in reading view.
- Hover over a mark to see the annotation body, creation time, and quick actions.
- Click a mark to locate it in the annotation sidebar.
- Double-click a mark to open the annotation editor.
- `Ctrl`-, `Cmd`-, `Shift`-, or `Alt`-clicking links preserves Obsidian's
  normal link behavior.
- Locating a reading-view annotation from the sidebar scrolls it into view and
  shows brief visual feedback.

### Four Visual Styles and Independent Colors

- Added four visual mark styles: highlight, underline, strikethrough, and bold.
- Each annotation can have its own style and color.
- Added five preset colors—purple, pink, blue, green, and yellow—plus the system
  color picker for custom colors.
- The custom-color button displays the actual selected color.
- Word export preserves the Obsidian visual style where possible.

### Unified Annotation Editor

- New and existing annotations now use the same floating editor.
- The annotation body, visual style, and color can be changed in one window.
- Images can be pasted and saved to the configured attachment folder.
- The editor supports dragging, automatic textarea growth,
  `Ctrl/Cmd + Enter` to save, and `Esc` to close.
- Style buttons support the arrow keys, `Home`, and `End`.
- Keyboard focus returns to the previous element when the editor closes.

### Selection Toolbar

- Apply any of the four visual styles immediately after selecting text.
- Choose a preset or custom color directly from the toolbar.
- Selecting the exact range of an existing annotation displays an
  **Already annotated** state.
- The toolbar restores the existing annotation's style and color.
- Running another style command on an existing range updates the annotation
  instead of creating a duplicate.

### Sidebar Interaction

- Annotation cards display the corresponding style icon and colored border.
- Search quoted text and annotation content.
- Sort by document position or creation time.
- Collapse or expand all annotation bodies.
- Edit, copy a precise backlink, search the vault, or delete an annotation.
- Restore a deleted annotation for seven seconds.
- Menus support the arrow keys, `Home`, `End`, `Esc`, and focus restoration.
- Cards support `Tab`, `Enter`, `Space`, and `F2`.

### Export, Backlinks, and Backups

- Added the **Export current note to Word (with annotations)** command.
- Word export uses native comment structures and reports how many unlocatable
  annotations were skipped.
- The sidebar can export all annotations for the current note to Markdown.
- Precise backlinks use `obsidian://sidenote?timestamp=...` to locate a specific
  annotation.
- Settings can create a standalone Markdown backup of annotation data.

### Mobile and Accessibility

- The editor adapts to narrow screens and Obsidian mobile application classes.
- Primary touch targets use 32–36 px interaction sizes.
- The selection toolbar supports horizontal scrolling.
- Added button titles, ARIA labels, pressed states, and keyboard focus styles.
- `Ctrl/Cmd + Enter` does not submit while a Chinese IME composition is active.

## Stability Fixes

### Fixed Multiple Annotation Editors Opening on Double-Click

The previous implementation used different `bind(this)` results when adding and
removing editor double-click listeners. Because the original listener could not
be removed, plugin reloads or editor rebuilds accumulated stale handlers and a
single double-click could be processed several times.

Version 1.0.5 fixes this by:

- Using stable function references when adding and removing editor listeners.
- Handling editing-view and reading-view double-clicks consistently during the
  capture phase.
- Using a global editor singleton that survives plugin hot reloads.
- Closing the previous editor and removing orphaned editor nodes before opening
  a new one.
- Cleaning up leftover editor windows when the plugin loads or unloads.

### Other Fixes

- Fixed reading view sometimes becoming blank after a plugin hot reload.
- Fixed old floating editor windows remaining after a plugin reload.
- Fixed preset color buttons appearing white because of Obsidian's default
  button styles.
- Fixed the custom color control not displaying its active state correctly.
- Fixed unreliable navigation from a sidebar card to a reading-view annotation.
- Fixed duplicate annotations being created after selecting an existing range.
- Fixed the annotation save action being triggered repeatedly in quick
  succession.
- Fixed editor click listeners not being removed correctly.

## Data Compatibility

- Existing annotation data requires no manual migration.
- Older annotations without `markType` are displayed as highlights.
- Older annotations without an independent color continue to use the plugin
  default.
- Legacy annotations stored in the plugin's `data.json` continue to migrate to
  per-note JSON files.
- This release does not add semantic type or processing-status fields.

Before upgrading, back up:

- `.obsidian/plugins/side-comments-origin/data.json`
- The configured annotation data folder, `side-note-data` by default
- The configured attachment folder, `side-note-attachments` by default

## Upgrade Instructions

1. Close any annotation editor that is currently open.
2. Replace these files in the plugin directory with the new release:
   - `main.js`
   - `manifest.json`
   - `styles.css`
3. Reload **Side Comments origin** in Obsidian.
4. Open a note containing annotations and verify both editing view and reading
   view.

When the plugin starts, it automatically removes orphaned floating editor
windows left by older versions.

## Release Files

A release package should contain at least:

```text
main.js
manifest.json
styles.css
```

Build from source:

```bash
npm install
npm run build
```

## Known Limitations

- Very short or heavily repeated text can still produce ambiguous matches.
- Large deletions, splits, or rewrites of the source text can orphan annotations.
- Word export includes only annotations that can still be located precisely in
  the current document.
- Changing the annotation data folder requires a plugin reload.
