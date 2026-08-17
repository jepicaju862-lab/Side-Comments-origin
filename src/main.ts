import { ItemView, WorkspaceLeaf, TFile, App, MarkdownView, Notice, ViewStateResult, Plugin, Setting, PluginSettingTab, MarkdownRenderer, setIcon, Component, normalizePath, Platform, Editor } from "obsidian";
import { Comment, CommentManager } from "./commentManager";
import { MarkdownPostProcessorContext, MarkdownRenderChild } from "obsidian";
import { exportNoteToDocx } from "./wordExporter";
import { EditorView, Decoration, DecorationSet, ViewPlugin, ViewUpdate, hoverTooltip } from "@codemirror/view";
import { RangeSetBuilder, SelectionRange, StateEffect } from "@codemirror/state";
import { generateBinaryHash, generateHash } from "./hash";

// --- Helper Functions ---

const forceUpdateEffect = StateEffect.define<null>();
type CommentMarkType = NonNullable<Comment['markType']>;

interface CustomViewState extends Record<string, unknown> {
    filePath: string | null;
}

interface SideNoteSettings {
    commentSortOrder: "timestamp" | "position";
    showHighlights: boolean;
    markdownFolder: string;
    attachmentFolder: string;
    highlightColor: string;
    highlightOpacity: number;
    enableSelectionToolbar: boolean;
    commentsDataFolder: string;
}

interface PluginData extends SideNoteSettings {
    comments?: Comment[];
    imageHashes: Record<string, string>;
}

interface GlobalSearchPlugin {
    openGlobalSearch(query: string): void;
}

interface InternalPlugins {
    getPluginById(id: string): { instance?: GlobalSearchPlugin } | undefined;
}

type AppWithInternalPlugins = App & { internalPlugins: InternalPlugins };

interface SettingsController {
    open(): void;
    openTabById?(id: string): void;
}

type AppWithSettings = App & { setting?: SettingsController };

interface PreviewSectionState {
    rendered?: boolean;
}

interface PreviewModeState {
    rerender(force: boolean): void;
    renderer?: {
        sections?: PreviewSectionState[];
        onRender?(): void;
    };
}

type EditorWithCodeMirror = Editor & { cm?: EditorView };

interface TableCellRange {
    start: number;
    end: number;
    contentStart: number;
    contentEnd: number;
}

interface TableBlock {
    startLine: number;
    endLine: number;
}

interface ReadingViewSectionState {
    sourcePath: string;
    sourceText: string;
    lineStart: number;
    lineEnd: number;
}

interface ReadingTextNodeRange {
    node: Text;
    start: number;
    end: number;
}

interface ReadingTextModel {
    text: string;
    nodes: ReadingTextNodeRange[];
}

class ReadingViewSectionChild extends MarkdownRenderChild {
    constructor(containerEl: HTMLElement, private readonly dispose: () => void) {
        super(containerEl);
    }

    onunload() {
        this.dispose();
    }
}

const DEFAULT_SETTINGS: SideNoteSettings = {
    commentSortOrder: "position",
    showHighlights: true,
    markdownFolder: "side-note-comments",
    attachmentFolder: "side-note-attachments",
    highlightColor: "#FFC800",
    highlightOpacity: 0.2,
    enableSelectionToolbar: true,
    commentsDataFolder: "side-note-data",
};

const SHORTCUT_COMMANDS = [
    { label: "加粗", commandName: "为选中内容添加加粗" },
    { label: "高亮", commandName: "为选中内容添加高亮" },
    { label: "批注", commandName: "为选中内容添加批注 (弹出输入框)" },
    { label: "下划线", commandName: "为选中内容添加下划线" },
    { label: "删除线", commandName: "为选中内容添加删除线" },
];

const MARK_TYPE_OPTIONS: Array<{ value: CommentMarkType; label: string; icon: string }> = [
    { value: "highlight", label: "高亮", icon: "highlighter" },
    { value: "underline", label: "下划线", icon: "underline" },
    { value: "strikethrough", label: "删除线", icon: "strikethrough" },
    { value: "bold", label: "加粗", icon: "bold" }
];

const COLOR_PRESETS = [
    { name: "紫色", value: "#8b5cf6" },
    { name: "粉色", value: "#ec4899" },
    { name: "蓝色", value: "#3b82f6" },
    { name: "绿色", value: "#10b981" },
    { name: "黄色", value: "#f59e0b" }
] as const;

const ACTIVE_COMMENT_MODAL_KEY = '__sidenoteActiveCommentModal';
type SideNoteWindow = Window & { [ACTIVE_COMMENT_MODAL_KEY]?: CommentModal };

function getMarkTypeOption(markType?: Comment['markType']) {
    return MARK_TYPE_OPTIONS.find(option => option.value === (markType || "highlight")) || MARK_TYPE_OPTIONS[0];
}

// --- View Class ---


class SideNoteView extends ItemView {
    private file: TFile | null = null;
    private plugin: SideNote;
    private activeCommentTimestamp: number | null = null;
    private searchQuery: string = "";
    private allCollapsed: boolean = false;
    // 新增：用于记录重绘前的滚动位置
    private lastScrollTop: number = 0;
    private activeActionMenu: HTMLElement | null = null;
    private activeActionMenuButton: HTMLElement | null = null;

    constructor(leaf: WorkspaceLeaf, plugin: SideNote, file: TFile | null = null) {
        super(leaf);
        this.plugin = plugin;
        this.file = file;
    }

    getViewType() { return "sidenote-view"; }
    getDisplayText() { return "Side note"; }
    getIcon() { return "message-square"; }

    async onOpen() {
        await Promise.resolve();
        if (!this.file) {
            this.file = this.app.workspace.getActiveFile();
        }
        this.registerDomEvent(document, 'pointerdown', (event) => {
            const target = event.target as Node;
            if (this.activeActionMenu?.contains(target) || this.activeActionMenuButton?.contains(target)) return;
            this.closeActionMenu();
        }, { capture: true });
        this.registerDomEvent(document, 'scroll', () => this.closeActionMenu(), { capture: true });
        this.registerDomEvent(window, 'resize', () => this.closeActionMenu());
        this.renderView();
    }

    private closeActionMenu() {
        this.activeActionMenuButton?.setAttribute('aria-expanded', 'false');
        if (this.activeActionMenu) this.activeActionMenu.onkeydown = null;
        this.activeActionMenu?.remove();
        this.activeActionMenu = null;
        this.activeActionMenuButton = null;
    }

    private openActionMenu(menu: HTMLElement, button: HTMLElement) {
        if (this.activeActionMenu === menu) {
            this.closeActionMenu();
            return;
        }

        this.closeActionMenu();
        document.body.appendChild(menu);
        menu.addClass('visible', 'sidenote-action-menu-portal');
        this.activeActionMenu = menu;
        this.activeActionMenuButton = button;
        button.setAttribute('aria-expanded', 'true');
        menu.setAttribute('role', 'menu');

        const menuItems = Array.from(menu.querySelectorAll<HTMLButtonElement>('.sidenote-menu-option'));
        menuItems.forEach(item => item.setAttribute('role', 'menuitem'));
        menu.onkeydown = (event: KeyboardEvent) => {
            const currentIndex = menuItems.indexOf(document.activeElement as HTMLButtonElement);
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                const trigger = this.activeActionMenuButton;
                this.closeActionMenu();
                window.requestAnimationFrame(() => trigger?.focus({ preventScroll: true }));
                return;
            }
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            event.stopPropagation();
            let nextIndex = currentIndex;
            if (event.key === 'Home') nextIndex = 0;
            else if (event.key === 'End') nextIndex = menuItems.length - 1;
            else if (event.key === 'ArrowDown') nextIndex = (Math.max(currentIndex, -1) + 1) % menuItems.length;
            else nextIndex = (currentIndex <= 0 ? menuItems.length : currentIndex) - 1;
            menuItems[nextIndex]?.focus({ preventScroll: true });
        };

        const buttonRect = button.getBoundingClientRect();
        const statusBar = document.querySelector('.status-bar');
        const statusBarRect = statusBar?.getBoundingClientRect();
        const safeBottom = statusBarRect && statusBarRect.height > 0
            ? Math.min(window.innerHeight - 8, statusBarRect.top - 8)
            : window.innerHeight - 8;
        const gap = 6;
        const menuWidth = menu.offsetWidth;
        const menuHeight = menu.offsetHeight;
        const left = Math.max(8, Math.min(buttonRect.right - menuWidth, window.innerWidth - menuWidth - 8));
        const belowTop = buttonRect.bottom + gap;
        const aboveTop = buttonRect.top - menuHeight - gap;
        const top = belowTop + menuHeight <= safeBottom
            ? belowTop
            : Math.max(8, Math.min(aboveTop, safeBottom - menuHeight));

        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;
        window.requestAnimationFrame(() => menuItems[0]?.focus({ preventScroll: true }));
    }

    async setState(state: CustomViewState, result: ViewStateResult): Promise<void> {
        if (state.filePath) {
            const file = this.app.vault.getAbstractFileByPath(state.filePath);
            if (file instanceof TFile) {
                this.file = file;
                this.renderView();
            }
        }
        await super.setState(state, result);
    }

    public updateActiveFile(file: TFile | null) {
        this.file = file;
        this.renderView();
    }

    public highlightComment(timestamp: number) {
        this.activeCommentTimestamp = timestamp;
        this.renderView();
        
        window.setTimeout(() => {
            const commentEl = this.containerEl.querySelector(`[data-comment-timestamp="${timestamp}"]`);
            if (commentEl) {
                // 修改点 1：改为 'nearest'，避免强制跳到中间
                commentEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        }, 100);
    }

    public renderView() {
        this.closeActionMenu();
        // 修改点 2：在清空前保存滚动位置
        const currentContainer = this.containerEl.querySelector(".sidenote-comments-list-wrapper");
        if (currentContainer) {
            this.lastScrollTop = currentContainer.scrollTop;
        }

        this.containerEl.empty();
        this.containerEl.addClass("sidenote-view-container");

        // Toolbar
        const toolbar = this.containerEl.createDiv("sidenote-toolbar");
        
        const searchInput = toolbar.createEl("input", {
            type: "text",
            placeholder: "搜索批注…"
        });
        searchInput.setAttribute('aria-label', '搜索批注');
        searchInput.value = this.searchQuery;
        
        searchInput.oninput = (e) => {
            const target = e.target as HTMLInputElement;
            this.searchQuery = target.value.toLowerCase();
            void this.renderCommentsList(commentsContainer);
        };

        const exportBtn = toolbar.createEl("button", { cls: "clickable-icon" });
        exportBtn.setAttribute("aria-label", "导出为 Markdown");
        setIcon(exportBtn, "file-up");
        exportBtn.onclick = async () => { await this.exportCommentsToMarkdown(); };

        const sortBtn = toolbar.createEl("button", { cls: "clickable-icon" });
        sortBtn.setAttribute("aria-label", this.plugin.settings.commentSortOrder === "position" ? "改为按创建时间排序" : "改为按正文位置排序");
        setIcon(sortBtn, this.plugin.settings.commentSortOrder === "position" ? "arrow-down-narrow-wide" : "clock");
        
        sortBtn.onclick = async () => {
            this.plugin.settings.commentSortOrder = this.plugin.settings.commentSortOrder === "position" ? "timestamp" : "position";
            await this.plugin.saveData();
            setIcon(sortBtn, this.plugin.settings.commentSortOrder === "position" ? "arrow-down-narrow-wide" : "clock");
            sortBtn.setAttribute("aria-label", this.plugin.settings.commentSortOrder === "position" ? "改为按创建时间排序" : "改为按正文位置排序");
            await this.renderCommentsList(commentsContainer);
        };

        const collapseBtn = toolbar.createEl("button", { cls: "clickable-icon" });
        collapseBtn.setAttribute("aria-label", this.allCollapsed ? "展开全部批注" : "折叠全部批注");
        setIcon(collapseBtn, this.allCollapsed ? "chevrons-up-down" : "chevrons-down-up");
        collapseBtn.onclick = () => {
            this.allCollapsed = !this.allCollapsed;
            setIcon(collapseBtn, this.allCollapsed ? "chevrons-up-down" : "chevrons-down-up");
            collapseBtn.setAttribute("aria-label", this.allCollapsed ? "展开全部批注" : "折叠全部批注");
            const contentEls = this.containerEl.querySelectorAll(".sidenote-comment-content");
            contentEls.forEach(el => el.classList.toggle("collapsed", this.allCollapsed));
        };

        const commentsContainer = this.containerEl.createDiv("sidenote-comments-list-wrapper");

        void this.renderCommentsList(commentsContainer);

        // 修改点 3：渲染后恢复滚动位置
        if (this.lastScrollTop > 0) {
            // 使用 setTimeout 确保 DOM 渲染完成
            window.setTimeout(() => {
                commentsContainer.scrollTop = this.lastScrollTop;
            }, 0);
        }
    }

    private async exportCommentsToMarkdown() {
        // ... (保持不变) ...
        if (!this.file) { new Notice("No file selected."); return; }
        const comments = this.plugin.commentManager.getCommentsForFile(this.file.path);
        if (comments.length === 0) { new Notice("No comments to export."); return; }

        const sortedComments = [...comments].sort((a, b) => {
            if (a.startLine === b.startLine) return a.startChar - b.startChar;
            return a.startLine - b.startLine;
        });

        let content = `Source: [[${this.file.path}|${this.file.basename}]]\n\n`;
        sortedComments.forEach(c => {
            const quoteText = c.selectedText.replace(/\n/g, "\n> ");
            const commentBody = c.comment.replace(/\n/g, "\n>> ");
            // @ts-ignore
            const dateStr = window.moment(c.timestamp).format('YYYY-MM-DD HH:mm:ss');
            content += `> [!quote] sidenote\n> ${quoteText}\n>> [!note]+ ${dateStr}\n>> ${commentBody}\n\n`;
        });
        // @ts-ignore
        const filename = `${this.file.basename} - SideNote ${window.moment().format('YYYYMMDDHHmmss')}.md`;
        
        try {
            const file = await this.app.vault.create(filename, content);
            await this.app.workspace.getLeaf(true).openFile(file);
            new Notice(`Exported to ${filename}`);
        } catch { new Notice("Error exporting file."); }
    }

    public async renderCommentsList(container: HTMLElement) {
        this.closeActionMenu();
        container.empty();
        
        if (!this.file) {
            container.createDiv("sidenote-empty-state").createEl("p", { text: "尚未选择笔记。" });
            return;
        }

        let commentsForFile = this.plugin.commentManager.getCommentsForFile(this.file.path);

        if (this.searchQuery) {
            commentsForFile = commentsForFile.filter(c => 
                (c.comment && c.comment.toLowerCase().includes(this.searchQuery)) || 
                (c.selectedText && c.selectedText.toLowerCase().includes(this.searchQuery))
            );
        }

        if (this.plugin.settings.commentSortOrder === "position") {
            commentsForFile.sort((a, b) => {
                if (a.startLine === b.startLine) return a.startChar - b.startChar;
                return a.startLine - b.startLine;
            });
        } else {
            commentsForFile.sort((a, b) => a.timestamp - b.timestamp);
        }

        if (commentsForFile.length > 0) {
            const listEl = container.createDiv("sidenote-comments-container");
            
            for (const comment of commentsForFile) {
                const commentEl = listEl.createDiv("sidenote-comment-item");
                commentEl.setAttribute("data-comment-timestamp", comment.timestamp.toString());
                commentEl.tabIndex = 0;
                commentEl.setAttribute('role', 'button');
                const accessibleQuote = (comment.selectedText || '无引用文本').replace(/\s+/g, ' ').trim();
                commentEl.setAttribute('aria-label', `批注：${accessibleQuote}。回车定位，F2 编辑`);
                
                if (this.activeCommentTimestamp === comment.timestamp) {
                    commentEl.addClass("active");
                }

                const commentColor = comment.color || this.plugin.settings.highlightColor || DEFAULT_SETTINGS.highlightColor;
                const rgb = this.plugin.hexToRgb(commentColor);
                const opacity = this.plugin.settings.highlightOpacity;
                commentEl.style.setProperty('--sidenote-highlight-color', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${opacity})`);
                commentEl.style.setProperty('--sidenote-highlight-border', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${Math.min(opacity + 0.4, 1)})`);
                commentEl.style.setProperty('--interactive-accent', commentColor);
                commentEl.style.setProperty('--interactive-accent-translucent', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.3)`);

                const headerEl = commentEl.createDiv("sidenote-comment-header");
                const textInfoEl = headerEl.createDiv("sidenote-comment-text-info");
                const selectedTextEl = textInfoEl.createDiv({ cls: "sidenote-selected-text markdown-rendered" });
                await this.plugin.renderCommentContent(comment.selectedText || "", selectedTextEl, comment.filePath);
                this.setupExpandableText(selectedTextEl);
                textInfoEl.createEl("small", { text: new Date(comment.timestamp).toLocaleString(), cls: "sidenote-timestamp" });

                const actionsEl = headerEl.createDiv("sidenote-comment-actions");
                const markOption = getMarkTypeOption(comment.markType);
                const markBadge = actionsEl.createSpan({ cls: "sidenote-mark-badge" });
                markBadge.title = `标记样式：${markOption.label}`;
                markBadge.setAttribute("aria-label", `标记样式：${markOption.label}`);
                setIcon(markBadge, markOption.icon);
                
                const jumpToComment = async () => {
                    this.activeCommentTimestamp = comment.timestamp;
                    const container = this.containerEl.querySelector('.sidenote-comments-list-wrapper');
                    if (!container) return;
                    // 保存当前的滚动位置（防止点击导致的重绘让列表跳动）
                    this.lastScrollTop = container.parentElement?.scrollTop || 0;
                    
                    container.querySelectorAll('.sidenote-comment-item').forEach(el => el.removeClass('active'));
                    commentEl.addClass('active');
                    await this.jumpToComment(comment); 
                };
                commentEl.onclick = () => void jumpToComment();

                commentEl.ondblclick = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                    new CommentModal(this.plugin.app, this.plugin, { mode: 'edit', comment: comment }).open();
                };
                commentEl.onkeydown = (event: KeyboardEvent) => {
                    if ((event.target as HTMLElement).closest('button, input, textarea')) return;
                    if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        void jumpToComment();
                    } else if (event.key === 'F2') {
                        event.preventDefault();
                        new CommentModal(this.plugin.app, this.plugin, { mode: 'edit', comment }).open();
                    }
                };

                const contentWrapper = commentEl.createDiv({ cls: `sidenote-comment-content markdown-rendered${this.allCollapsed ? ' collapsed' : ''}` });
                await this.plugin.renderCommentContent(comment.comment || "", contentWrapper, comment.filePath);
                this.setupExpandableText(contentWrapper);

                const menuButton = actionsEl.createEl("button", { cls: "sidenote-menu-button clickable-icon" });
                menuButton.type = 'button';
                menuButton.title = '更多操作';
                menuButton.setAttribute('aria-label', '更多批注操作');
                menuButton.setAttribute('aria-haspopup', 'menu');
                menuButton.setAttribute('aria-expanded', 'false');
                setIcon(menuButton, "more-vertical");
                const menuContainer = actionsEl.createDiv("sidenote-action-menu");

                const editOption = menuContainer.createEl("button", { text: "编辑批注", cls: "sidenote-menu-option" });
                editOption.onclick = (e) => {
                    e.stopPropagation();
                    this.closeActionMenu();
                    new CommentModal(this.app, this.plugin, { mode: 'edit', comment: comment }).open();
                };

                const copyOption = menuContainer.createEl("button", { text: "复制回链", cls: "sidenote-menu-option" });
                copyOption.onclick = (e) => {
                    e.stopPropagation();
                    this.closeActionMenu();
                    void this.plugin.copyBacklink(comment);
                };

                const searchOption = menuContainer.createEl("button", { text: "在库中搜索", cls: "sidenote-menu-option" });
                searchOption.onclick = (e) => {
                    e.stopPropagation();
                    this.closeActionMenu();
                    const searchPlugin = (this.app as AppWithInternalPlugins).internalPlugins
                        .getPluginById('global-search')?.instance;
                    searchPlugin?.openGlobalSearch(comment.selectedText);
                };

                const deleteOption = menuContainer.createEl("button", { text: "删除批注", cls: "sidenote-menu-option sidenote-menu-delete" });
                deleteOption.onclick = async (e) => {
                    e.stopPropagation();
                    this.closeActionMenu();
                    await this.plugin.deleteComment(comment.timestamp);
                };

                menuButton.onclick = (e) => {
                    e.stopPropagation();
                    this.openActionMenu(menuContainer, menuButton);
                };
            }
        } else {
            const emptyStateEl = container.createDiv("sidenote-empty-state");
            emptyStateEl.createEl("p", { text: this.searchQuery ? "没有匹配的批注。" : "当前笔记还没有批注。" });
        }
    }
    
    private setupExpandableText(el: HTMLElement) {
        window.setTimeout(() => {
            if (el.scrollHeight > el.clientHeight + 2) {
                el.addClass('is-truncated');
                el.onclick = (e) => {
                    e.stopPropagation();
                    if (el.hasClass('expanded')) {
                        el.removeClass('expanded');
                        el.addClass('is-truncated');
                    } else {
                        el.addClass('expanded');
                        el.removeClass('is-truncated');
                    }
                };
            }
        }, 50);
    }

    public renderComments() { this.renderView(); }

    public async jumpToComment(comment: Comment) {
        // ... (保持不变) ...
        let targetLeaf: WorkspaceLeaf | null = null;
       this.app.workspace.iterateAllLeaves((leaf: WorkspaceLeaf) => {
           if (leaf.view instanceof MarkdownView && leaf.view.file?.path === comment.filePath) {
               targetLeaf = leaf;
               return false;
           }
       });

       if (!targetLeaf) {
           const file = this.app.vault.getAbstractFileByPath(comment.filePath);
           if (file instanceof TFile) {
               const newLeaf = this.app.workspace.getLeaf(true);
               await newLeaf.openFile(file);
               targetLeaf = newLeaf;
           }
       }

       if (targetLeaf && targetLeaf.view instanceof MarkdownView) {
           this.app.workspace.setActiveLeaf(targetLeaf, { focus: true });
           if (Platform.isMobile) {
               // @ts-ignore
               this.app.workspace.leftSplit?.collapse();
               // @ts-ignore
               this.app.workspace.rightSplit?.collapse();
               await new Promise(resolve => window.setTimeout(resolve, 350));
           }

            const editor = targetLeaf.view.editor;
            const fileContent = editor.getValue();
            await this.plugin.commentManager.updateCommentCoordinatesForFile(fileContent, comment.filePath);
            await this.plugin.saveCommentsForSingleFile(comment.filePath);

            const updatedComment = this.plugin.comments.find(c => c.timestamp === comment.timestamp);
            if (!updatedComment || updatedComment.isOrphaned) {
                new Notice("在正文中找不到这条批注的原文。");
                return;
            }

            if (targetLeaf.view.getMode() === 'preview') {
                this.plugin.refreshReadingViewHighlights();
                await new Promise(resolve => window.requestAnimationFrame(resolve));
                const readingHighlight = targetLeaf.view.containerEl.querySelector(
                    `.sidenote-reading-highlight[data-comment-timestamp="${updatedComment.timestamp}"]`
                );
                if (readingHighlight) {
                    readingHighlight.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
                    readingHighlight.addClass('sidenote-jump-target');
                    window.setTimeout(() => readingHighlight.removeClass('sidenote-jump-target'), 1400);
                    return;
                }
            }

            editor.focus();
            editor.setSelection(
                { line: updatedComment.startLine, ch: updatedComment.startChar }, 
                { line: updatedComment.endLine, ch: updatedComment.endChar }
            );
            editor.scrollIntoView({ from: { line: updatedComment.startLine, ch: 0 }, to: { line: updatedComment.endLine, ch: 0 } }, true);
        }
    }

    getState(): CustomViewState { return { filePath: this.file ? this.file.path : null }; }
    onunload() {}
}

async function switchToSideNoteView(app: App) {
    const activeFile = app.workspace.getActiveFile();
    if (!activeFile) { new Notice("No active Markdown file found."); return; }
    let leaf = app.workspace.getLeaf('split', 'vertical');
    if (leaf) {
        await leaf.setViewState({ type: "sidenote-view", state: { filePath: activeFile.path }, active: true });
        void app.workspace.revealLeaf(leaf);
    }
}

// --- Comment Modal (Floating Popover — no Obsidian Modal backdrop) ---

class CommentModal {
    private static activeModal: CommentModal | null = null;

    static closeActive() {
        const sideNoteWindow = window as SideNoteWindow;
        const globalActive = sideNoteWindow[ACTIVE_COMMENT_MODAL_KEY];
        globalActive?.close?.();
        if (CommentModal.activeModal && CommentModal.activeModal !== globalActive) {
            CommentModal.activeModal.close();
        }
        document.querySelectorAll('.sidenote-modal-floating').forEach(element => element.remove());
        CommentModal.activeModal = null;
        delete sideNoteWindow[ACTIVE_COMMENT_MODAL_KEY];
    }

    app: App;
    plugin: SideNote;
    comment: Comment | null = null;
    mode: 'add' | 'edit';
    colorInput: string;
    markType: CommentMarkType;
    commentText: string;
    selectedText: string;
    filePath: string;
    onSubmitAdd?: (comment: string, color: string, markType: CommentMarkType) => Promise<void> | void;
    textareaEl: HTMLTextAreaElement | null = null;

    private floatingEl: HTMLElement | null = null;
    private _keydownHandler: ((e: KeyboardEvent) => void) | null = null;
    private isSubmitting = false;
    private previousFocusEl: HTMLElement | null = null;

    constructor(app: App, plugin: SideNote, options: {
        comment?: Comment,
        mode: 'add' | 'edit',
        selectedText?: string,
        filePath?: string,
        initialColor?: string,
        initialMarkType?: CommentMarkType,
        onSubmitAdd?: (comment: string, color: string, markType: CommentMarkType) => Promise<void> | void
    }) {
        this.app = app;
        this.plugin = plugin;
        this.mode = options.mode;

        if (this.mode === 'edit' && options.comment) {
            this.comment = options.comment;
            this.selectedText = this.comment.selectedText || "";
            this.filePath = this.comment.filePath;
            this.colorInput = this.comment.color || plugin.settings.highlightColor || "#FFC800";
            this.markType = this.comment.markType || "highlight";
            this.commentText = this.comment.comment || "";
        } else {
            this.comment = null;
            this.selectedText = options.selectedText || "";
            this.filePath = options.filePath || "";
            this.colorInput = options.initialColor || plugin.settings.highlightColor || "#FFC800";
            this.markType = options.initialMarkType || "highlight";
            this.commentText = "";
            this.onSubmitAdd = options.onSubmitAdd;
        }
    }

    open() {
        this.close();
        const sideNoteWindow = window as SideNoteWindow;
        const globalActive = sideNoteWindow[ACTIVE_COMMENT_MODAL_KEY];
        if (globalActive && globalActive !== this) globalActive.close?.();
        if (CommentModal.activeModal && CommentModal.activeModal !== this && CommentModal.activeModal !== globalActive) {
            CommentModal.activeModal.close();
        }
        // Remove any orphaned windows left behind by older plugin builds. The global
        // reference above handles current builds; this DOM guard also heals existing sessions.
        document.querySelectorAll('.sidenote-modal-floating').forEach(element => element.remove());
        CommentModal.activeModal = this;
        sideNoteWindow[ACTIVE_COMMENT_MODAL_KEY] = this;
        this.previousFocusEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;

        // 创建浮动容器，直接挂到 document.body，无任何遮罩
        const floating = document.body.createDiv('sidenote-modal-floating');
        this.floatingEl = floating;
        floating.setAttribute('role', 'dialog');
        floating.setAttribute('aria-label', this.mode === 'edit' ? '编辑批注' : '添加批注');
        if (this.comment) floating.dataset.commentTimestamp = this.comment.timestamp.toString();

        // ── 顶部栏：引用 chip + 关闭按钮 ──────────────────────────────
        const topBar = floating.createDiv('sidenote-modal-topbar');

        if (this.selectedText) {
            const quoteEl = topBar.createDiv('sidenote-modal-quote');
            quoteEl.setAttribute('title', this.selectedText);
            quoteEl.createSpan({ cls: 'sidenote-modal-quote-label', text: '引用' });
            const quoteLine = this.selectedText.replace(/\n+/g, ' · ').trim();
            quoteEl.createSpan({ cls: 'sidenote-modal-quote-text', text: quoteLine });
        } else {
            topBar.createSpan({ cls: 'sidenote-modal-title', text: this.mode === 'edit' ? '编辑批注' : '添加批注' });
        }

        const closeBtn = topBar.createEl('button', { cls: 'sidenote-modal-close-btn' });
        closeBtn.type = 'button';
        closeBtn.title = '关闭';
        closeBtn.setAttribute('aria-label', '关闭批注窗口');
        setIcon(closeBtn, 'x');
        closeBtn.onclick = () => this.close();

        const markTypesEl = floating.createDiv('sidenote-modal-mark-types');
        markTypesEl.createSpan({ cls: 'sidenote-modal-mark-label', text: '标记样式' });
        const markButtons = new Map<CommentMarkType, HTMLButtonElement>();
        const updateMarkButtons = () => {
            markButtons.forEach((button, value) => {
                const active = value === this.markType;
                button.classList.toggle('active', active);
                button.setAttribute('aria-pressed', active ? 'true' : 'false');
            });
        };
        MARK_TYPE_OPTIONS.forEach(option => {
            const button = markTypesEl.createEl('button', { cls: 'sidenote-modal-mark-button' });
            button.type = 'button';
            button.title = option.label;
            button.setAttribute('aria-label', option.label);
            button.setAttribute('data-mark-type', option.value);
            setIcon(button, option.icon);
            button.createSpan({ text: option.label });
            button.onclick = () => {
                this.markType = option.value;
                updateMarkButtons();
            };
            button.onkeydown = (event: KeyboardEvent) => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                const currentIndex = MARK_TYPE_OPTIONS.findIndex(item => item.value === option.value);
                let nextIndex = currentIndex;
                if (event.key === 'Home') nextIndex = 0;
                else if (event.key === 'End') nextIndex = MARK_TYPE_OPTIONS.length - 1;
                else if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % MARK_TYPE_OPTIONS.length;
                else nextIndex = (currentIndex - 1 + MARK_TYPE_OPTIONS.length) % MARK_TYPE_OPTIONS.length;
                markButtons.get(MARK_TYPE_OPTIONS[nextIndex].value)?.focus();
                markButtons.get(MARK_TYPE_OPTIONS[nextIndex].value)?.click();
            };
            markButtons.set(option.value, button);
        });
        updateMarkButtons();

        // ── 批注输入框 ────────────────────────────────────────────────
        const textarea = floating.createEl('textarea', { cls: 'sidenote-modal-textarea' });
        textarea.placeholder = this.mode === 'edit' ? '编辑批注...' : '写下批注...';
        textarea.value = this.commentText;
        this.textareaEl = textarea;

        const autoResize = () => {
            textarea.setCssStyles({ height: 'auto' });
            textarea.setCssStyles({ height: `${Math.min(textarea.scrollHeight, 260)}px` });
        };

        textarea.oninput = (e: Event) => {
            this.commentText = (e.target as HTMLTextAreaElement).value;
            autoResize();
        };
        textarea.addEventListener('paste', (event) => { void this.handlePaste(event); });
        textarea.addEventListener('keydown', (e: KeyboardEvent) => {
            if (!e.isComposing && (e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                void this.submitForm();
            }
        });

        // ── 底部操作栏 ────────────────────────────────────────────────
        const actionBar = floating.createDiv('sidenote-modal-actionbar');

        const colorsWrapper = actionBar.createDiv('sidenote-modal-colors');

        let activeCircle: HTMLElement | null = null;
        const updateActiveCircle = (circle: HTMLElement | null) => {
            activeCircle?.classList.remove('active');
            activeCircle?.setAttribute('aria-pressed', 'false');
            circle?.classList.add('active');
            circle?.setAttribute('aria-pressed', 'true');
            activeCircle = circle;
        };

        const colorPicker = createEl('input');
        colorPicker.type = 'color';
        colorPicker.className = 'sidenote-toolbar-color-picker';
        colorPicker.value = this.colorInput;

        COLOR_PRESETS.forEach(color => {
            const circle = createEl('button');
            circle.type = 'button';
            circle.className = 'sidenote-color-circle';
            circle.style.setProperty('--circle-color', color.value);
            circle.title = color.name;
            circle.setAttribute('aria-label', color.name);
            circle.setAttribute('aria-pressed', 'false');
            if (colorPicker.value.toLowerCase() === color.value.toLowerCase()) updateActiveCircle(circle);
            circle.onclick = () => {
                colorPicker.value = color.value;
                this.colorInput = color.value;
                updateActiveCircle(circle);
            };
            colorsWrapper.appendChild(circle);
        });

        const customColorWrapper = createEl('label');
        customColorWrapper.className = 'sidenote-color-circle custom-color';
        customColorWrapper.title = '自定义颜色';
        customColorWrapper.setAttribute('aria-label', '自定义颜色');
        customColorWrapper.setAttribute('role', 'button');
        customColorWrapper.setAttribute('aria-pressed', 'false');
        customColorWrapper.tabIndex = 0;
        customColorWrapper.style.setProperty('--sidenote-custom-color', colorPicker.value);
        const updateCustomColor = () => {
            this.colorInput = colorPicker.value;
            customColorWrapper.style.setProperty('--sidenote-custom-color', colorPicker.value);
            const matched = Array.from(colorsWrapper.querySelectorAll('.sidenote-color-circle:not(.custom-color)'))
                .find(c => (c as HTMLElement).style.getPropertyValue('--circle-color').toLowerCase() === colorPicker.value.toLowerCase());
            updateActiveCircle(matched ? matched as HTMLElement : customColorWrapper);
        };
        colorPicker.setAttribute('aria-label', '选择自定义颜色');
        colorPicker.oninput = updateCustomColor;
        colorPicker.onchange = updateCustomColor;
        customColorWrapper.onkeydown = (event: KeyboardEvent) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            colorPicker.click();
        };
        customColorWrapper.appendChild(colorPicker);
        colorsWrapper.appendChild(customColorWrapper);
        if (!activeCircle) updateActiveCircle(customColorWrapper);

        const actionsWrapper = actionBar.createDiv('sidenote-modal-actions');
        actionsWrapper.createSpan({ cls: 'sidenote-modal-hint', text: Platform.isMacOS ? '⌘↵' : 'Ctrl↵' });

        if (this.mode === 'edit' && this.comment) {
            const copyBtn = actionsWrapper.createEl('button', { cls: 'sidenote-icon-btn', title: '复制回链' });
            copyBtn.type = 'button';
            copyBtn.setAttribute('aria-label', '复制回链');
            setIcon(copyBtn, 'copy');
            copyBtn.onclick = () => {
                if (this.comment) void this.plugin.copyBacklink(this.comment);
            };

            const deleteBtn = actionsWrapper.createEl('button', { cls: 'sidenote-icon-btn sidenote-btn-danger', title: '删除批注' });
            deleteBtn.type = 'button';
            deleteBtn.setAttribute('aria-label', '删除批注');
            setIcon(deleteBtn, 'trash-2');
            deleteBtn.onclick = async () => {
                if (this.comment) {
                    await this.plugin.deleteComment(this.comment.timestamp);
                    this.close();
                }
            };
        }

        const submitBtn = actionsWrapper.createEl('button', {
            text: this.mode === 'edit' ? '更新' : '添加',
            cls: 'sidenote-update-btn'
        });
        submitBtn.type = 'button';
        submitBtn.onclick = () => { void this.submitForm(); };

        // 拖拽支持：拖动顶部栏移动窗口
        this.makeDraggable(floating, topBar);

        // Esc 关闭
        this._keydownHandler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') this.close();
        };
        document.addEventListener('keydown', this._keydownHandler);

        window.setTimeout(() => {
            textarea.focus();
            if (this.commentText) autoResize();
        }, 50);
    }

    close() {
        const previousFocus = this.previousFocusEl;
        if (this._keydownHandler) {
            document.removeEventListener('keydown', this._keydownHandler);
            this._keydownHandler = null;
        }
        this.floatingEl?.remove();
        this.floatingEl = null;
        this.previousFocusEl = null;
        this.isSubmitting = false;
        if (CommentModal.activeModal === this) CommentModal.activeModal = null;
        const sideNoteWindow = window as SideNoteWindow;
        if (sideNoteWindow[ACTIVE_COMMENT_MODAL_KEY] === this) {
            delete sideNoteWindow[ACTIVE_COMMENT_MODAL_KEY];
        }
        this.plugin.hideSelectionToolbars();
        if (previousFocus?.isConnected) window.requestAnimationFrame(() => previousFocus.focus());
    }

    private makeDraggable(el: HTMLElement, handle: HTMLElement) {
        let isDragging = false;
        let startX = 0, startY = 0, origLeft = 0, origTop = 0;

        handle.classList.add('sidenote-modal-drag-handle');

        handle.addEventListener('pointerdown', (e: PointerEvent) => {
            const target = e.target as HTMLElement;
            if (target.closest('button, input, textarea')) return;
            isDragging = true;
            handle.classList.add('is-dragging');
            startX = e.clientX;
            startY = e.clientY;
            const rect = el.getBoundingClientRect();
            origLeft = rect.left;
            origTop = rect.top;
            el.classList.add('sidenote-modal-drag-positioned');
            el.style.left = origLeft + 'px';
            el.style.top = origTop + 'px';

            const onMove = (ev: PointerEvent) => {
                if (!isDragging) return;
                const newLeft = Math.max(0, Math.min(window.innerWidth - el.offsetWidth, origLeft + ev.clientX - startX));
                const newTop = Math.max(0, Math.min(window.innerHeight - el.offsetHeight, origTop + ev.clientY - startY));
                el.style.left = newLeft + 'px';
                el.style.top = newTop + 'px';
            };
            const onUp = () => {
                isDragging = false;
                handle.classList.remove('is-dragging');
                document.removeEventListener('pointermove', onMove);
                document.removeEventListener('pointerup', onUp);
                document.removeEventListener('pointercancel', onUp);
            };
            document.addEventListener('pointermove', onMove);
            document.addEventListener('pointerup', onUp);
            document.addEventListener('pointercancel', onUp);
            e.preventDefault();
        });
    }

    async submitForm() {
        if (this.isSubmitting) return;
        this.isSubmitting = true;
        const submitButton = this.floatingEl?.querySelector('.sidenote-update-btn') as HTMLButtonElement | null;
        if (submitButton) submitButton.disabled = true;
        try {
            if (this.mode === 'edit' && this.comment) {
                await this.plugin.editComment(this.comment.timestamp, this.commentText, this.colorInput, this.markType);
            } else if (this.mode === 'add' && this.onSubmitAdd) {
                await this.onSubmitAdd(this.commentText, this.colorInput, this.markType);
            }
            this.close();
        } catch (error) {
            console.error('[SideNote] 保存批注失败', error);
            new Notice('保存批注失败，请重试');
            this.isSubmitting = false;
            if (submitButton) submitButton.disabled = false;
        }
    }

    async handlePaste(e: ClipboardEvent) {
        if (!e.clipboardData) return;
        const files = e.clipboardData.files;
        if (files.length > 0) {
            e.preventDefault();
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                if (file.type.startsWith('image/')) {
                    await this.saveImageAndInsertLink(file);
                }
            }
        }
    }

    async saveImageAndInsertLink(file: File) {
        if (!this.textareaEl) return;
        try {
            const arrayBuffer = await file.arrayBuffer();
            // @ts-ignore
            const binaryHash = await generateBinaryHash(arrayBuffer);
            let availablePath: string;

            if (this.plugin.imageHashes && this.plugin.imageHashes[binaryHash]) {
                const existingPath = this.plugin.imageHashes[binaryHash];
                const existingFile = this.app.vault.getAbstractFileByPath(existingPath);
                if (existingFile instanceof TFile) {
                    availablePath = existingPath;
                    new Notice("Reused existing image.");
                } else {
                    availablePath = await this.createNewImage(arrayBuffer, file.name);
                    this.plugin.imageHashes[binaryHash] = availablePath;
                    await this.plugin.saveData();
                }
            } else {
                availablePath = await this.createNewImage(arrayBuffer, file.name);
                if (!this.plugin.imageHashes) this.plugin.imageHashes = {};
                this.plugin.imageHashes[binaryHash] = availablePath;
                await this.plugin.saveData();
            }

            const savedFile = this.app.vault.getAbstractFileByPath(availablePath);
            if (savedFile instanceof TFile) {
                const sourcePath = this.filePath || '/';
                let markdownLink = this.app.fileManager.generateMarkdownLink(savedFile, sourcePath);
                if (!markdownLink.startsWith('!')) markdownLink = '!' + markdownLink;

                const startPos = this.textareaEl.selectionStart;
                const endPos = this.textareaEl.selectionEnd;
                const text = this.textareaEl.value;
                this.textareaEl.value = text.substring(0, startPos) + markdownLink + text.substring(endPos);
                this.commentText = this.textareaEl.value;
                const newCursorPos = startPos + markdownLink.length;
                this.textareaEl.setSelectionRange(newCursorPos, newCursorPos);
                this.textareaEl.dispatchEvent(new Event('input'));
            }
        } catch (error) { console.error(error); new Notice('Failed to save image.'); }
    }

    async createNewImage(arrayBuffer: ArrayBuffer, originalName: string): Promise<string> {
        const folderSetting = this.plugin.settings.attachmentFolder.trim() || "side-note-attachments";
        const folderPath = normalizePath(folderSetting);
        const folder = this.app.vault.getAbstractFileByPath(folderPath);
        if (!folder) await this.app.vault.createFolder(folderPath);

        // @ts-ignore
        const dateStr = window.moment().format('YYYYMMDDHHmmss');
        const extension = originalName.split('.').pop() || 'png';
        const fileName = `Pasted image ${dateStr}.${extension}`;
        const targetPath = `${folderPath}/${fileName}`;

        const fileOrPath = await this.app.vault.createBinary(targetPath, arrayBuffer).catch(async () => {
             // @ts-ignore
            return await this.app.fileManager.getAvailablePathForAttachment(fileName, folderPath);
        });
        return fileOrPath instanceof TFile ? fileOrPath.path : (fileOrPath);
    }
}

// --- Setting Tab ---

class SideNoteSettingTab extends PluginSettingTab {
    plugin: SideNote;
    constructor(app: App, plugin: SideNote) { super(app, plugin); }

    /**
     * Obsidian 1.13+ uses these definitions for rendering and settings search.
     * Older releases ignore this method and continue to use display().
     */
    getSettingDefinitions() {
        const orphanedCount = this.plugin.commentManager.getOrphanedCommentCount();
        return [
            {
                name: "批注排序",
                desc: "选择侧栏中批注的排列方式。",
                render: (setting: Setting) => setting.addDropdown((dropdown) => dropdown
                    .addOption("timestamp", "按创建时间")
                    .addOption("position", "按正文位置")
                    .setValue(this.plugin.settings.commentSortOrder)
                    .onChange(async (value: "timestamp" | "position") => {
                        this.plugin.settings.commentSortOrder = value;
                        await this.plugin.saveData();
                        this.plugin.refreshViews();
                    }))
            },
            {
                name: "显示批注标记",
                desc: "在编辑视图和阅读视图中显示批注的视觉标记。",
                render: (setting: Setting) => setting.addToggle((toggle) => toggle
                    .setValue(this.plugin.settings.showHighlights)
                    .onChange(async (value: boolean) => {
                        this.plugin.settings.showHighlights = value;
                        await this.plugin.saveData();
                        this.plugin.refreshEditorDecorations();
                    }))
            },
            {
                name: "启用选区工具栏",
                desc: "选中文字后显示快速批注工具栏。",
                render: (setting: Setting) => setting.addToggle((toggle) => toggle
                    .setValue(this.plugin.settings.enableSelectionToolbar)
                    .onChange(async (value: boolean) => {
                        this.plugin.settings.enableSelectionToolbar = value;
                        await this.plugin.saveData();
                    }))
            },
            {
                name: "快捷键设置",
                desc: "加粗、高亮、批注、下划线都已注册为 Obsidian 命令，可在 Obsidian 快捷键设置中自定义绑定。",
                render: (setting: Setting) => setting.setHeading()
            },
            ...SHORTCUT_COMMANDS.map((command) => ({
                name: command.label,
                desc: `打开 Obsidian 快捷键设置并搜索：${command.commandName}`,
                render: (setting: Setting) => setting.addButton((button) => button
                    .setButtonText("设置快捷键")
                    .onClick(() => this.plugin.openHotkeySettings(command.commandName)))
            })),
            {
                name: "新批注默认颜色",
                desc: "仅影响之后创建的批注。",
                render: (setting: Setting) => setting.addColorPicker((colorPicker) => colorPicker
                    .setValue(this.plugin.settings.highlightColor || "#FFC800")
                    .onChange(async (value: string) => {
                        this.plugin.settings.highlightColor = value;
                        await this.plugin.saveData();
                        this.plugin.applyHighlightColor();
                    }))
            },
            {
                name: "标记透明度",
                render: (setting: Setting) => setting.addSlider((slider) => slider
                    .setLimits(0, 1, 0.1)
                    .setValue(this.plugin.settings.highlightOpacity ?? 0.2)
                    .onChange(async (value: number) => {
                        this.plugin.settings.highlightOpacity = value;
                        await this.plugin.saveData();
                        this.plugin.applyHighlightColor();
                    }))
            },
            {
                name: "Markdown 批注备份文件夹",
                render: (setting: Setting) => setting.addText((text) => text
                    .setPlaceholder("Side-note-comments")
                    .setValue(this.plugin.settings.markdownFolder || "")
                    .onChange(async (value) => {
                        this.plugin.settings.markdownFolder = value.trim() || "side-note-comments";
                        await this.plugin.saveData();
                    }))
            },
            {
                name: "批注附件文件夹",
                render: (setting: Setting) => setting.addText((text) => text
                    .setPlaceholder("Side-note-attachments")
                    .setValue(this.plugin.settings.attachmentFolder || "")
                    .onChange(async (value) => {
                        this.plugin.settings.attachmentFolder = value.trim() || "side-note-attachments";
                        await this.plugin.saveData();
                    }))
            },
            {
                name: "批注数据文件夹",
                desc: "按笔记保存批注数据；修改后请重新加载插件。",
                render: (setting: Setting) => setting.addText((text) => text
                    .setPlaceholder("Side-note-data")
                    .setValue(this.plugin.settings.commentsDataFolder || "")
                    .onChange(async (value) => {
                        this.plugin.settings.commentsDataFolder = value.trim() || "side-note-data";
                        await this.plugin.saveData();
                    }))
            },
            {
                name: "创建 Markdown 备份",
                render: (setting: Setting) => setting.addButton((button) => button
                    .setButtonText("创建备份")
                    .onClick(async () => {
                        await this.plugin.migrateInlineCommentsToMarkdown();
                        new Notice("Markdown 备份已创建");
                    }))
            },
            {
                name: "孤立批注",
                desc: `当前有 ${orphanedCount} 条孤立批注。`
            },
            {
                name: "删除孤立批注",
                render: (setting: Setting) => setting.addButton((button) => button
                    .setButtonText(`删除 ${orphanedCount} 条孤立批注`)
                    .setWarning()
                    .setDisabled(orphanedCount === 0)
                    .onClick(async () => {
                        const deleted = this.plugin.commentManager.deleteOrphanedComments();
                        await this.plugin.saveData();
                        this.plugin.refreshViews();
                        new Notice(`已删除 ${deleted} 条孤立批注`);
                        (this as unknown as PluginSettingTab & { update(): void }).update();
                    }))
            }
        ];
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        new Setting(containerEl).setName("批注排序").setDesc("选择侧栏中批注的排列方式。")
            .addDropdown((dropdown) => dropdown.addOption("timestamp", "按创建时间").addOption("position", "按正文位置")
                .setValue(this.plugin.settings.commentSortOrder).onChange(async (value: "timestamp" | "position") => {
                    this.plugin.settings.commentSortOrder = value;
                    await this.plugin.saveData();
                    this.plugin.refreshViews();
                }));
        new Setting(containerEl).setName("显示批注标记").setDesc("在编辑视图和阅读视图中显示批注的视觉标记。")
            .addToggle((toggle) => toggle.setValue(this.plugin.settings.showHighlights).onChange(async (value: boolean) => {
                    this.plugin.settings.showHighlights = value;
                    await this.plugin.saveData();
                    this.plugin.refreshEditorDecorations();
                }));
        new Setting(containerEl).setName("启用选区工具栏").setDesc("选中文字后显示快速批注工具栏。")
            .addToggle((toggle) => toggle.setValue(this.plugin.settings.enableSelectionToolbar).onChange(async (value: boolean) => {
                    this.plugin.settings.enableSelectionToolbar = value;
                    await this.plugin.saveData();
                }));
        new Setting(containerEl)
            .setName("快捷键设置")
            .setDesc("加粗、高亮、批注、下划线都已注册为 Obsidian 命令，可在 Obsidian 快捷键设置中自定义绑定。")
            .setHeading();
        SHORTCUT_COMMANDS.forEach((command) => {
            new Setting(containerEl)
                .setName(command.label)
                .setDesc(`打开 Obsidian 快捷键设置并搜索：${command.commandName}`)
                .addButton((button) => button
                    .setButtonText("设置快捷键")
                    .onClick(() => this.plugin.openHotkeySettings(command.commandName)));
        });
        new Setting(containerEl).setName("新批注默认颜色").setDesc("仅影响之后创建的批注。") .addColorPicker((colorPicker) =>
                colorPicker.setValue(this.plugin.settings.highlightColor || "#FFC800").onChange(async (value: string) => {
                    this.plugin.settings.highlightColor = value;
                    await this.plugin.saveData();
                    this.plugin.applyHighlightColor();
                }));
        new Setting(containerEl).setName("标记透明度").addSlider((slider) =>
                slider.setLimits(0, 1, 0.1).setValue(this.plugin.settings.highlightOpacity ?? 0.2).onChange(async (value: number) => {
                    this.plugin.settings.highlightOpacity = value;
                    await this.plugin.saveData();
                    this.plugin.applyHighlightColor();
                }));
        new Setting(containerEl).setName("Markdown 批注备份文件夹").addText((text) =>
                text.setPlaceholder("Side-note-comments").setValue(this.plugin.settings.markdownFolder || "").onChange(async (value) => {
                    this.plugin.settings.markdownFolder = value.trim() || "side-note-comments";
                    await this.plugin.saveData();
                }));
        new Setting(containerEl).setName("批注附件文件夹").addText((text) =>
                text.setPlaceholder("Side-note-attachments").setValue(this.plugin.settings.attachmentFolder || "").onChange(async (value) => {
                    this.plugin.settings.attachmentFolder = value.trim() || "side-note-attachments";
                    await this.plugin.saveData();
                }));
        new Setting(containerEl).setName("批注数据文件夹").setDesc("按笔记保存批注数据；修改后请重新加载插件。") .addText((text) =>
                text.setPlaceholder("Side-note-data").setValue(this.plugin.settings.commentsDataFolder || "").onChange(async (value) => {
                    this.plugin.settings.commentsDataFolder = value.trim() || "side-note-data";
                    await this.plugin.saveData();
                }));
        new Setting(containerEl).setName("创建 Markdown 备份").addButton((button) =>
                button.setButtonText("创建备份").onClick(async () => {
                    await this.plugin.migrateInlineCommentsToMarkdown();
                    new Notice("Markdown 备份已创建");
                }));
        const orphanedCount = this.plugin.commentManager.getOrphanedCommentCount();
        new Setting(containerEl).setName("孤立批注").setDesc(`当前有 ${orphanedCount} 条孤立批注。`);
        new Setting(containerEl).addButton((button) =>
                button.setButtonText(`删除 ${orphanedCount} 条孤立批注`).setWarning().onClick(async () => {
                    const deleted = this.plugin.commentManager.deleteOrphanedComments();
                    await this.plugin.saveData();
                    this.plugin.refreshViews();
                    new Notice(`已删除 ${deleted} 条孤立批注`);
                    this.display();
                }).setDisabled(orphanedCount === 0));
    }
}

// --- Main Plugin Class ---

export default class SideNote extends Plugin {
    commentManager: CommentManager;
    settings: SideNoteSettings;
    comments: Comment[] = [];
    imageHashes: Record<string, string> = {};
    private orphanNoticeTimer: number | null = null;
    private pendingOrphans: Comment[] = [];
    private isSaving: boolean = false;
    private editorViews: Set<EditorView> = new Set();
    private renderedTableHighlightTimers: number[] = [];
    private selectionToolbarObserver: MutationObserver | null = null;
    private readingViewSections: Map<HTMLElement, ReadingViewSectionState> = new Map();
    private readingTooltipEl: HTMLElement | null = null;
    private readingTooltipComponent: Component | null = null;
    private readingTooltipHideTimer: number | null = null;

    public hideSelectionToolbars() {
        document.dispatchEvent(new CustomEvent("sidenote-hide-selection-toolbar"));
        document.querySelectorAll('.sidenote-selection-toolbar').forEach(el => el.remove());
    }

    private registerSelectionToolbarDismissal() {
        this.registerDomEvent(document, 'pointerdown', (event) => {
            const target = event.target as HTMLElement | null;
            if (!target?.closest('.sidenote-selection-toolbar')) {
                this.hideSelectionToolbars();
            }
        }, { capture: true });

        this.registerDomEvent(document, 'focusin', (event) => {
            const target = event.target as HTMLElement | null;
            if (target && !target.closest('.sidenote-selection-toolbar, .cm-editor')) {
                this.hideSelectionToolbars();
            }
        }, { capture: true });

        this.registerDomEvent(document, 'keydown', (event) => {
            if (event.key === 'Escape') this.hideSelectionToolbars();
        }, { capture: true });

        this.registerDomEvent(window, 'blur', () => this.hideSelectionToolbars());

        this.selectionToolbarObserver = new MutationObserver((mutations) => {
            const overlaySelector = '.modal-container, .menu, .popover, .suggestion-container, .prompt';
            const overlayAdded = mutations.some(mutation =>
                Array.from(mutation.addedNodes).some(node =>
                    node.instanceOf(HTMLElement) &&
                    (node.matches(overlaySelector) || Boolean(node.querySelector(overlaySelector)))
                )
            );
            if (overlayAdded) this.hideSelectionToolbars();
        });
        this.selectionToolbarObserver.observe(document.body, { childList: true, subtree: true });
        this.register(() => {
            this.selectionToolbarObserver?.disconnect();
            this.selectionToolbarObserver = null;
            this.hideSelectionToolbars();
        });
    }

    public async renderCommentContent(markdown: string, container: HTMLElement, sourcePath: string) {
        const component = new Component();
        component.load();
        await MarkdownRenderer.render(this.app, markdown, container, sourcePath, component);
        container.addEventListener("click", (e) => {
            const target = e.target as HTMLElement;
            const link = target.closest("a");
            if (link) {
                e.stopPropagation();
                if (link.classList.contains("internal-link")) {
                    e.preventDefault();
                    const href = link.getAttribute("data-href");
                    if (href) {
                        const newLeaf = e.metaKey || e.ctrlKey;
                        void this.app.workspace.openLinkText(href, sourcePath, newLeaf);
                    }
                }
            }
        });
        const embedRegex = /!\[\[([^\]|]+?)(\|[^\]]+?)?\]\]/g;
        let match;
        while ((match = embedRegex.exec(markdown)) !== null) {
            const filename = match[1];
            const file = this.app.metadataCache.getFirstLinkpathDest(filename, sourcePath);
            if (file instanceof TFile) {
                const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
                let textNode;
                while ((textNode = walker.nextNode())) {
                    if (textNode.textContent?.includes(match[0])) {
                        const embedSpan = createSpan();
                        embedSpan.className = 'internal-embed';
                        const img = createEl('img');
                        img.src = this.app.vault.getResourcePath(file);
                        img.alt = file.basename;
                        img.classList.add('sidenote-embedded-image');
                        embedSpan.appendChild(img);
                        const parent = textNode.parentNode;
                        if (parent) {
                            const parts = textNode.textContent.split(match[0]);
                            parent.insertBefore(document.createTextNode(parts[0]), textNode);
                            parent.insertBefore(embedSpan, textNode);
                            textNode.textContent = parts.slice(1).join(match[0]);
                        }
                        break; 
                    }
                }
            }
        }
        container.querySelectorAll('.internal-embed').forEach((embed) => {
            if (embed.instanceOf(HTMLElement) && !embed.querySelector('img')) {
                const src = embed.getAttribute('src') || embed.getAttribute('alt') || embed.textContent?.replace(/^\[\[|\]\]$/g, '');
                 if (src) {
                    const file = this.app.metadataCache.getFirstLinkpathDest(src, sourcePath);
                    if (file instanceof TFile) {
                        embed.empty();
                        const img = embed.createEl('img');
                        img.src = this.app.vault.getResourcePath(file);
                        img.alt = file.basename;
                        img.classList.add('sidenote-embedded-image');
                    }
                 }
            }
        });
    }

    private registerReadingViewSection(el: HTMLElement, ctx: MarkdownPostProcessorContext) {
        if (el.closest(".sidenote-view-container, .sidenote-tooltip, .sidenote-comment-modal")) return;

        const sectionInfo = ctx.getSectionInfo(el);
        if (!sectionInfo) return;

        const state: ReadingViewSectionState = {
            sourcePath: ctx.sourcePath,
            sourceText: sectionInfo.text,
            lineStart: sectionInfo.lineStart,
            lineEnd: sectionInfo.lineEnd
        };
        this.readingViewSections.set(el, state);
        ctx.addChild(new ReadingViewSectionChild(el, () => {
            this.readingViewSections.delete(el);
        }));

        this.applyReadingViewHighlightsToSection(el, state);
        window.requestAnimationFrame(() => {
            if (el.isConnected && this.readingViewSections.get(el) === state) {
                this.applyReadingViewHighlightsToSection(el, state);
            }
        });
    }

    private unwrapReadingViewHighlights(root: HTMLElement) {
        root.querySelectorAll(".sidenote-reading-highlight").forEach((highlight) => {
            const parent = highlight.parentNode;
            if (!parent) return;
            while (highlight.firstChild) parent.insertBefore(highlight.firstChild, highlight);
            parent.removeChild(highlight);
            parent.normalize();
        });
    }

    private getReadingBlock(root: HTMLElement, node: Text): Element {
        const parent = node.parentElement;
        if (!parent) return root;
        const block = parent.closest(
            "p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, td, th, dt, dd, figcaption, " +
            ".callout-title, .callout-content"
        );
        return block && root.contains(block) ? block : root;
    }

    private getReadingTextModel(root: HTMLElement): ReadingTextModel {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                const text = node.nodeValue || "";
                const parent = node.parentElement;
                if (!text || !parent) return NodeFilter.FILTER_REJECT;
                if (parent.closest(
                    "script, style, svg, canvas, button, textarea, mjx-container, [aria-hidden='true'], " +
                    ".copy-code-button, .collapse-indicator, .heading-collapse-indicator, .list-collapse-indicator, " +
                    ".sidenote-tooltip"
                )) return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
            }
        });

        const nodes: ReadingTextNodeRange[] = [];
        let text = "";
        let previousBlock: Element | null = null;
        let current: Node | null;
        while ((current = walker.nextNode())) {
            const node = current as Text;
            const value = node.nodeValue || "";
            const block = this.getReadingBlock(root, node);
            if (
                text && previousBlock && block !== previousBlock &&
                !previousBlock.contains(block) && !block.contains(previousBlock) &&
                !text.endsWith("\n") && !value.startsWith("\n")
            ) {
                text += "\n";
            }

            const start = text.length;
            text += value;
            nodes.push({ node, start, end: text.length });
            previousBlock = block;
        }

        return { text, nodes };
    }

    private getReadingSectionSourceText(state: ReadingViewSectionState): string {
        const lines = state.sourceText.split("\n");
        const sectionLineCount = Math.max(1, state.lineEnd - state.lineStart + 1);
        if (lines.length > sectionLineCount + 1) {
            return lines.slice(state.lineStart, state.lineEnd + 1).join("\n");
        }
        return state.sourceText;
    }

    private getOffsetInReadingSection(state: ReadingViewSectionState, sectionText: string, line: number, ch: number): number {
        if (line < state.lineStart) return 0;
        const lines = sectionText.split("\n");
        const relativeLine = line - state.lineStart;
        if (relativeLine >= lines.length) return sectionText.length;

        let offset = 0;
        for (let i = 0; i < relativeLine; i++) offset += lines[i].length + 1;
        return Math.min(sectionText.length, offset + Math.max(0, Math.min(ch, lines[relativeLine].length)));
    }

    private decodeHtmlEntities(text: string): string {
        const parsed = new DOMParser().parseFromString(text, "text/html");
        return parsed.documentElement.textContent ?? text;
    }

    private stripMarkdownForReading(text: string): string {
        const stripped = text
            .replace(/!\[\[([^\]]+)\]\]/g, "")
            .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
            .replace(/\[\[([^\]]+)\]\]/g, (_match, target: string) => {
                const withoutHeading = target.replace(/^#/, "").split("#").pop() || target;
                return withoutHeading.split("/").pop() || withoutHeading;
            })
            .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
            .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
            .replace(/(^|\n)\s{0,3}(?:#{1,6}\s+|>\s?|(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)/g, "$1")
            .replace(/```[^\n]*\n?/g, "")
            .replace(/<[^>]+>/g, "")
            .replace(/(?:\*\*|__|~~|==|`+)/g, "")
            .replace(/\\([\\`*{}[\]()#+\-.!_>])/g, "$1");
        return this.decodeHtmlEntities(stripped);
    }

    private getReadingSearchVariants(...sources: string[]): string[] {
        const variants: string[] = [];
        sources.forEach((source) => {
            const normalized = source.replace(/\r\n?/g, "\n");
            const stripped = this.stripMarkdownForReading(normalized);
            [normalized, stripped].forEach((candidate) => {
                if (candidate && !variants.includes(candidate)) variants.push(candidate);
            });
        });
        return variants;
    }

    private normalizeReadingTextWithMap(text: string): { text: string; starts: number[]; ends: number[] } {
        let normalized = "";
        const starts: number[] = [];
        const ends: number[] = [];
        let whitespaceIndex = -1;

        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            if (char === "\u200b" || char === "\ufeff") continue;
            if (/\s/.test(char) || char === "\u00a0") {
                if (whitespaceIndex < 0) {
                    normalized += " ";
                    starts.push(i);
                    ends.push(i + 1);
                    whitespaceIndex = normalized.length - 1;
                } else {
                    ends[whitespaceIndex] = i + 1;
                }
                continue;
            }

            whitespaceIndex = -1;
            normalized += char;
            starts.push(i);
            ends.push(i + 1);
        }

        return { text: normalized, starts, ends };
    }

    private findAllTextMatches(text: string, candidate: string): number[] {
        const matches: number[] = [];
        let searchFrom = 0;
        while (candidate && searchFrom <= text.length - candidate.length) {
            const found = text.indexOf(candidate, searchFrom);
            if (found < 0) break;
            matches.push(found);
            searchFrom = found + 1;
        }
        return matches;
    }

    private chooseClosestReadingMatch(matches: number[], length: number, expectedStart: number): { start: number; end: number } | null {
        if (matches.length === 0) return null;
        const start = matches.reduce((best, current) =>
            Math.abs(current - expectedStart) < Math.abs(best - expectedStart) ? current : best
        );
        return { start, end: start + length };
    }

    private findReadingTextMatch(modelText: string, candidates: string[], expectedStart: number): { start: number; end: number } | null {
        for (const candidate of candidates) {
            const exact = this.chooseClosestReadingMatch(
                this.findAllTextMatches(modelText, candidate),
                candidate.length,
                expectedStart
            );
            if (exact) return exact;
        }

        const normalizedModel = this.normalizeReadingTextWithMap(modelText);
        const expectedNormalizedStart = normalizedModel.starts.reduce((closest, originalStart, index) =>
            Math.abs(originalStart - expectedStart) < Math.abs(normalizedModel.starts[closest] - expectedStart) ? index : closest,
            0
        );

        for (const candidate of candidates) {
            const normalizedCandidate = this.normalizeReadingTextWithMap(candidate).text.trim();
            if (!normalizedCandidate) continue;
            const normalizedMatch = this.chooseClosestReadingMatch(
                this.findAllTextMatches(normalizedModel.text, normalizedCandidate),
                normalizedCandidate.length,
                expectedNormalizedStart
            );
            if (!normalizedMatch) continue;

            const first = normalizedModel.starts[normalizedMatch.start];
            const last = normalizedModel.ends[normalizedMatch.end - 1];
            if (first !== undefined && last !== undefined) return { start: first, end: last };
        }

        return null;
    }

    private wrapReadingTextRange(root: HTMLElement, start: number, end: number, comment: Comment) {
        if (start < 0 || end <= start) return;
        const model = this.getReadingTextModel(root);
        const presentation = this.getCommentHighlightPresentation(comment);
        const className = presentation.className.replace("sidenote-table-highlight", "sidenote-reading-highlight");

        model.nodes.forEach(({ node, start: nodeStart, end: nodeEnd }) => {
            const sliceStart = Math.max(start, nodeStart);
            const sliceEnd = Math.min(end, nodeEnd);
            if (sliceStart >= sliceEnd) return;

            const text = node.nodeValue || "";
            const localStart = sliceStart - nodeStart;
            const localEnd = sliceEnd - nodeStart;
            const fragment = createFragment();
            if (localStart > 0) fragment.appendChild(document.createTextNode(text.slice(0, localStart)));

            const span = createSpan();
            span.className = className;
            span.setAttribute("data-comment-timestamp", comment.timestamp.toString());
            span.setAttribute("aria-label", comment.comment ? `批注：${comment.comment}` : "批注标记");
            span.setAttribute("role", "button");
            if (presentation.style) span.setAttribute("style", presentation.style);
            span.textContent = text.slice(localStart, localEnd);
            fragment.appendChild(span);

            if (localEnd < text.length) fragment.appendChild(document.createTextNode(text.slice(localEnd)));
            node.parentNode?.replaceChild(fragment, node);
        });
    }

    private applyReadingViewHighlightsToSection(root: HTMLElement, state: ReadingViewSectionState) {
        this.unwrapReadingViewHighlights(root);
        if (!this.commentManager || !this.settings.showHighlights) return;

        const lineDriftTolerance = 3;
        const comments = this.commentManager.getCommentsForFile(state.sourcePath)
            .filter(comment =>
                !comment.isOrphaned &&
                comment.startLine <= state.lineEnd + lineDriftTolerance &&
                comment.endLine >= state.lineStart - lineDriftTolerance
            )
            .sort((a, b) => a.startLine - b.startLine || a.startChar - b.startChar);
        const sectionText = this.getReadingSectionSourceText(state);

        comments.forEach((comment) => {
            const model = this.getReadingTextModel(root);
            if (!model.text) return;

            const localFrom = comment.startLine < state.lineStart
                ? 0
                : this.getOffsetInReadingSection(state, sectionText, comment.startLine, comment.startChar);
            const localTo = comment.endLine > state.lineEnd
                ? sectionText.length
                : this.getOffsetInReadingSection(state, sectionText, comment.endLine, comment.endChar);
            const sourceFragment = sectionText.slice(localFrom, Math.max(localFrom, localTo));
            const candidates = this.getReadingSearchVariants(comment.selectedText, sourceFragment);
            const expectedStart = sectionText.length > 0
                ? Math.round((localFrom / sectionText.length) * model.text.length)
                : 0;
            const match = this.findReadingTextMatch(model.text, candidates, expectedStart);
            if (match) this.wrapReadingTextRange(root, match.start, match.end, comment);
        });
    }

    public refreshReadingViewHighlights() {
        this.readingViewSections.forEach((state, el) => {
            if (!el.isConnected) {
                this.readingViewSections.delete(el);
                return;
            }
            this.applyReadingViewHighlightsToSection(el, state);
        });
    }

    private rerenderReadingViews() {
        this.app.workspace.iterateAllLeaves((leaf) => {
            if (!(leaf.view instanceof MarkdownView) || leaf.view.getMode() !== "preview") return;

            const previewMode = leaf.view.previewMode as unknown as PreviewModeState;
            previewMode.rerender(true);
            const nudgePendingRenderer = () => {
                const renderer = previewMode.renderer;
                const hasPendingSection = renderer?.sections?.some((section) => !section.rendered);
                // During a plugin hot reload Obsidian can retain a stale queued render.
                // Only nudge the existing renderer when its sections are still pending.
                if (hasPendingSection) renderer?.onRender?.();
            };
            [50, 250, 750].forEach((delay) => {
                const timer = window.setTimeout(nudgePendingRenderer, delay);
                this.register(() => window.clearTimeout(timer));
            });
        });
    }

    private getReadingHighlight(target: EventTarget | null): HTMLElement | null {
        return target instanceof HTMLElement ? target.closest(".sidenote-reading-highlight") : null;
    }

    private getAnyCommentHighlight(target: EventTarget | null): HTMLElement | null {
        return target instanceof HTMLElement
            ? target.closest('.sidenote-highlight[data-comment-timestamp]')
            : null;
    }

    private getCommentForReadingHighlight(highlight: HTMLElement): Comment | null {
        const timestamp = Number(highlight.getAttribute("data-comment-timestamp"));
        if (!Number.isFinite(timestamp)) return null;
        return this.comments.find(comment => comment.timestamp === timestamp) || null;
    }

    private hideReadingTooltip() {
        if (this.readingTooltipHideTimer !== null) {
            window.clearTimeout(this.readingTooltipHideTimer);
            this.readingTooltipHideTimer = null;
        }
        this.readingTooltipComponent?.unload();
        this.readingTooltipComponent = null;
        this.readingTooltipEl?.remove();
        this.readingTooltipEl = null;
    }

    private scheduleReadingTooltipHide() {
        if (this.readingTooltipHideTimer !== null) window.clearTimeout(this.readingTooltipHideTimer);
        this.readingTooltipHideTimer = window.setTimeout(() => this.hideReadingTooltip(), 180);
    }

    private positionReadingTooltip(anchor: HTMLElement, tooltip: HTMLElement) {
        const anchorRect = anchor.getBoundingClientRect();
        const tooltipRect = tooltip.getBoundingClientRect();
        const gap = 8;
        const margin = 8;
        let left = anchorRect.left + (anchorRect.width - tooltipRect.width) / 2;
        left = Math.max(margin, Math.min(left, window.innerWidth - tooltipRect.width - margin));
        let top = anchorRect.top - tooltipRect.height - gap;
        if (top < margin) top = Math.min(window.innerHeight - tooltipRect.height - margin, anchorRect.bottom + gap);
        tooltip.style.left = `${left}px`;
        tooltip.style.top = `${Math.max(margin, top)}px`;
    }

    private async showReadingTooltip(comment: Comment, anchor: HTMLElement) {
        if (!comment.comment?.trim()) return;
        this.hideReadingTooltip();

        const tooltip = createDiv();
        tooltip.className = "sidenote-tooltip sidenote-reading-tooltip";
        tooltip.setAttribute("role", "tooltip");
        tooltip.classList.add("is-loading");

        const accentBar = tooltip.createDiv("sidenote-tooltip-accent");
        accentBar.style.background = comment.color || this.settings.highlightColor || "#FFC800";
        const body = tooltip.createDiv("sidenote-tooltip-body");
        const content = body.createDiv("sidenote-tooltip-content markdown-rendered");
        const metaRow = body.createDiv("sidenote-tooltip-meta");
        const dateSpan = metaRow.createSpan("sidenote-tooltip-date");
        const date = new Date(comment.timestamp);
        dateSpan.textContent = `${date.getMonth() + 1}/${date.getDate()} ${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;
        const tooltipActions = metaRow.createDiv('sidenote-tooltip-actions');
        const revealButton = tooltipActions.createEl('button', { title: '在侧栏中查看' });
        revealButton.type = 'button';
        revealButton.setAttribute('aria-label', '在侧栏中查看');
        setIcon(revealButton, 'panel-right-open');
        revealButton.onclick = (event) => {
            event.preventDefault();
            event.stopPropagation();
            this.hideReadingTooltip();
            void this.activateViewAndHighlightComment(comment.timestamp);
        };
        const editButton = tooltipActions.createEl('button', { title: '编辑批注' });
        editButton.type = 'button';
        editButton.setAttribute('aria-label', '编辑批注');
        setIcon(editButton, 'pencil');
        editButton.onclick = (event) => {
            event.preventDefault();
            event.stopPropagation();
            this.hideReadingTooltip();
            new CommentModal(this.app, this, { mode: 'edit', comment }).open();
        };

        tooltip.addEventListener('pointerenter', () => {
            if (this.readingTooltipHideTimer !== null) {
                window.clearTimeout(this.readingTooltipHideTimer);
                this.readingTooltipHideTimer = null;
            }
        });
        tooltip.addEventListener('pointerleave', () => this.scheduleReadingTooltipHide());

        const component = new Component();
        component.load();
        this.readingTooltipEl = tooltip;
        this.readingTooltipComponent = component;
        document.body.appendChild(tooltip);

        await MarkdownRenderer.render(this.app, comment.comment, content, comment.filePath, component);
        if (this.readingTooltipEl !== tooltip || !anchor.isConnected) {
            component.unload();
            tooltip.remove();
            return;
        }

        tooltip.classList.remove("is-loading");
        this.positionReadingTooltip(anchor, tooltip);
    }

    private registerReadingViewInteractions() {
        this.registerDomEvent(document, "click", (event) => {
            const highlight = this.getReadingHighlight(event.target);
            if (!highlight) return;
            if (highlight.closest('a') && (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) return;
            const comment = this.getCommentForReadingHighlight(highlight);
            if (!comment) return;
            event.preventDefault();
            event.stopPropagation();
            this.hideReadingTooltip();
            void this.activateViewAndHighlightComment(comment.timestamp);
        }, { capture: true });

        this.registerDomEvent(document, "dblclick", (event) => {
            // Handle both editor and reading-view highlights before legacy target-level
            // listeners can run. stopImmediatePropagation also neutralizes listeners leaked
            // by older builds that could not remove their bound callbacks on hot reload.
            const highlight = this.getAnyCommentHighlight(event.target);
            if (!highlight) return;
            const comment = this.getCommentForReadingHighlight(highlight);
            if (!comment) return;
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            this.hideReadingTooltip();
            new CommentModal(this.app, this, { mode: "edit", comment }).open();
        }, { capture: true });

        this.registerDomEvent(document, "pointerover", (event) => {
            const highlight = this.getReadingHighlight(event.target);
            if (!highlight) return;
            const related = event.relatedTarget;
            if (related instanceof Node && highlight.contains(related)) return;
            if (this.readingTooltipHideTimer !== null) {
                window.clearTimeout(this.readingTooltipHideTimer);
                this.readingTooltipHideTimer = null;
            }
            const comment = this.getCommentForReadingHighlight(highlight);
            if (comment) void this.showReadingTooltip(comment, highlight);
        });

        this.registerDomEvent(document, "pointerout", (event) => {
            const highlight = this.getReadingHighlight(event.target);
            if (!highlight) return;
            const related = event.relatedTarget;
            if (related instanceof Node && highlight.contains(related)) return;
            if (related instanceof Node && this.readingTooltipEl?.contains(related)) return;
            this.scheduleReadingTooltipHide();
        });

        this.registerDomEvent(document, "scroll", () => this.hideReadingTooltip(), { capture: true });
        this.registerDomEvent(window, "resize", () => this.hideReadingTooltip());
        this.register(() => {
            this.hideReadingTooltip();
            this.readingViewSections.clear();
        });
    }

    public openHotkeySettings(searchText: string) {
        const setting = (this.app as AppWithSettings).setting;
        if (!setting?.open) {
            new Notice(`请在 Obsidian 设置 → 快捷键 中搜索“${searchText}”并绑定快捷键。`);
            return;
        }

        setting.open();
        setting.openTabById?.("hotkeys");

        window.setTimeout(() => {
            const searchInput = document.querySelector<HTMLInputElement>(
                ".modal.mod-settings input[type='search'], " +
                ".modal.mod-settings input[placeholder*='Search'], " +
                ".modal.mod-settings input[placeholder*='搜索'], " +
                ".modal.mod-settings input"
            );

            if (!searchInput) {
                new Notice(`请搜索“${searchText}”并绑定快捷键。`);
                return;
            }

            searchInput.value = searchText;
            searchInput.dispatchEvent(new Event("input", { bubbles: true }));
            searchInput.focus();
        }, 120);
    }

    public getFilePathForEditorView(view: EditorView): string | null {
        let containingFilePath: string | null = null;

        this.app.workspace.iterateAllLeaves((leaf) => {
            if (!(leaf.view instanceof MarkdownView) || !leaf.view.file) return;

            const editor = leaf.view.editor;
            if ((editor as EditorWithCodeMirror).cm === view) {
                containingFilePath = leaf.view.file.path;
                return false;
            }

            const containerEl = leaf.view.containerEl;
            if (!containingFilePath && containerEl?.contains(view.dom)) {
                containingFilePath = leaf.view.file.path;
            }
        });

        return containingFilePath || this.app.workspace.getActiveFile()?.path || null;
    }

    private getSelectionContextFromOffsets(docText: string, from: number, to: number): { before: string, after: string } {
        return {
            before: docText.substring(Math.max(0, from - 50), from),
            after: docText.substring(to, Math.min(docText.length, to + 50))
        };
    }


    private getOccurrenceIndex(content: string, selectedText: string, targetIndex: number): number {
        if (!selectedText) return -1;
        let count = 0;
        let searchPos = 0;
        while (true) {
            const found = content.indexOf(selectedText, searchPos);
            if (found === -1) return -1;
            if (found === targetIndex) return count;
            count++;
            searchPos = found + 1;
        }
    }

    private getHeadingPath(content: string, line: number): string[] {
        const lines = content.split("\n");
        const stack: Array<{ level: number; text: string }> = [];
        for (let i = 0; i <= Math.min(line, lines.length - 1); i++) {
            const match = lines[i].match(/^(#{1,6})\s+(.*)$/);
            if (!match) continue;
            const level = match[1].length;
            const text = match[2].trim();
            while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
            stack.push({ level, text });
        }
        return stack.map(item => item.text);
    }

    private updateLineCharsFromOffsets(comment: Comment, doc: { lineAt(pos: number): { number: number; from: number } }, from: number, to: number) {
        const startLine = doc.lineAt(from);
        const endLine = doc.lineAt(to);
        comment.startLine = startLine.number - 1;
        comment.startChar = from - startLine.from;
        comment.endLine = endLine.number - 1;
        comment.endChar = to - endLine.from;
        comment.absoluteFrom = from;
        comment.absoluteTo = to;
    }

    private findCommentForRange(
        filePath: string,
        selectedText: string,
        absoluteFrom: number,
        absoluteTo: number,
        startLine: number,
        startChar: number,
        endLine: number,
        endChar: number
    ): Comment | undefined {
        return this.commentManager.getCommentsForFile(filePath).find(comment => {
            if (comment.isOrphaned || comment.selectedText !== selectedText) return false;
            const sameAbsoluteRange =
                typeof comment.absoluteFrom === 'number' &&
                typeof comment.absoluteTo === 'number' &&
                comment.absoluteFrom === absoluteFrom &&
                comment.absoluteTo === absoluteTo;
            const sameLineRange =
                comment.startLine === startLine &&
                comment.startChar === startChar &&
                comment.endLine === endLine &&
                comment.endChar === endChar;
            return sameAbsoluteRange || sameLineRange;
        });
    }

    public mapCommentPositionsFromView(update: ViewUpdate) {
        const filePath = this.getFilePathForEditorView(update.view);
        if (!filePath || !update.docChanged) return;

        const comments = this.commentManager.getCommentsForFile(filePath);
        comments.forEach(comment => {
            if (typeof comment.absoluteFrom !== "number" || typeof comment.absoluteTo !== "number") return;
            const mappedFrom = update.changes.mapPos(comment.absoluteFrom, -1);
            const mappedTo = update.changes.mapPos(comment.absoluteTo, 1);
            if (mappedFrom < 0 || mappedTo > update.state.doc.length || mappedFrom >= mappedTo) return;
            const actualText = update.state.doc.sliceString(mappedFrom, mappedTo);
            if (actualText === comment.selectedText) {
                this.updateLineCharsFromOffsets(comment, update.state.doc, mappedFrom, mappedTo);
                comment.isOrphaned = false;
            }
        });
    }

    public async handleAddCommentFromEditorView(editorView: EditorView, markType: CommentMarkType, initialColor?: string, skipModal: boolean = false) {
        const resolvedColor = initialColor || this.settings.highlightColor || DEFAULT_SETTINGS.highlightColor;
        const selection = editorView.state.selection.main;
        if (selection.empty || selection.to <= selection.from) {
            new Notice("请先选择要批注的文字。");
            return;
        }

        const filePath = this.getFilePathForEditorView(editorView);
        if (!filePath) {
            new Notice("当前没有可用的 Markdown 笔记。");
            return;
        }

        const doc = editorView.state.doc;
        const selectedText = doc.sliceString(selection.from, selection.to);
        if (!selectedText.trim()) {
            new Notice("请先选择要批注的文字。");
            return;
        }

        const startLine = doc.lineAt(selection.from);
        const endLine = doc.lineAt(selection.to);
        const docText = doc.toString();
        
        let globalStartLine = startLine.number - 1;
        let globalStartChar = selection.from - startLine.from;
        let globalEndLine = endLine.number - 1;
        let globalEndChar = selection.to - endLine.from;
        let globalAbsoluteFrom = selection.from;
        let globalAbsoluteTo = selection.to;
        
        let finalContext = this.getSelectionContextFromOffsets(docText, selection.from, selection.to);
        let finalOccurrenceIndex = this.getOccurrenceIndex(docText, selectedText, selection.from);
        let finalHeadingPath = this.getHeadingPath(docText, globalStartLine);

        const tableCellContext = this.getTableCellContextForEditorView(editorView, filePath);
        const fullDocText = this.getEditorTextForFile(filePath);

        if (tableCellContext && fullDocText) {
            const lines = fullDocText.split('\n');
            let lineOffset = 0;
            for (let i = 0; i < tableCellContext.sourceLine; i++) {
                lineOffset += lines[i].length + 1;
            }
            
            globalStartLine = tableCellContext.sourceLine;
            globalEndLine = tableCellContext.sourceLine;
            globalStartChar = tableCellContext.cell.contentStart + selection.from;
            globalEndChar = tableCellContext.cell.contentStart + selection.to;
            globalAbsoluteFrom = lineOffset + globalStartChar;
            globalAbsoluteTo = lineOffset + globalEndChar;
            
            finalContext = this.getSelectionContextFromOffsets(fullDocText, globalAbsoluteFrom, globalAbsoluteTo);
            finalOccurrenceIndex = this.getOccurrenceIndex(fullDocText, selectedText, globalAbsoluteFrom);
            finalHeadingPath = this.getHeadingPath(fullDocText, globalStartLine);
        }

        const existingComment = this.findCommentForRange(
            filePath,
            selectedText,
            globalAbsoluteFrom,
            globalAbsoluteTo,
            globalStartLine,
            globalStartChar,
            globalEndLine,
            globalEndChar
        );
        if (existingComment) {
            this.hideSelectionToolbars();
            if (skipModal) {
                await this.editComment(existingComment.timestamp, existingComment.comment, resolvedColor, markType, '批注样式已更新');
            } else {
                new CommentModal(this.app, this, { mode: 'edit', comment: existingComment }).open();
            }
            return;
        }

        const createComment = async (commentText: string, color: string) => {
            const newComment: Comment = {
                filePath,
                startLine: globalStartLine,
                startChar: globalStartChar,
                endLine: globalEndLine,
                endChar: globalEndChar,
                absoluteFrom: globalAbsoluteFrom,
                absoluteTo: globalAbsoluteTo,
                occurrenceIndex: finalOccurrenceIndex,
                headingPath: finalHeadingPath,
                selectedText,
                selectedTextHash: await generateHash(selectedText),
                comment: commentText,
                timestamp: Date.now(),
                isOrphaned: false,
                contextBefore: finalContext.before,
                contextAfter: finalContext.after,
                markType,
                color: color || resolvedColor
            };
            await this.addComment(newComment);
            editorView.dispatch({ effects: [forceUpdateEffect.of(null)] });
            this.hideSelectionToolbars();
        };

        if (skipModal) {
            await createComment("", resolvedColor);
            return;
        }

        new CommentModal(this.app, this, {
            mode: 'add',
            selectedText,
            filePath,
            initialColor: resolvedColor,
            initialMarkType: markType,
            onSubmitAdd: async (commentText, color, selectedMarkType) => {
                markType = selectedMarkType;
                await createComment(commentText, color);
            }
        }).open();
    }

    private getEditorTextForFile(filePath: string): string | null {
        let text: string | null = null;
        this.app.workspace.iterateAllLeaves((leaf) => {
            if (leaf.view instanceof MarkdownView && leaf.view.file?.path === filePath) {
                text = leaf.view.editor.getValue();
                return false;
            }
        });
        return text;
    }

    private isMarkdownTableDelimiter(line: string): boolean {
        const trimmed = line.trim();
        if (!trimmed.includes("|")) return false;
        return /^:?-{3,}:?$/.test(trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|")[0]?.trim() || "") &&
            trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|").every(part => /^:?-{3,}:?$/.test(part.trim()));
    }

    private getMarkdownTableBlocks(docText: string): TableBlock[] {
        const lines = docText.split("\n");
        const blocks: TableBlock[] = [];
        let line = 0;

        while (line < lines.length - 1) {
            if (lines[line].includes("|") && this.isMarkdownTableDelimiter(lines[line + 1])) {
                const startLine = line;
                line += 2;
                while (line < lines.length && lines[line].includes("|") && lines[line].trim().length > 0) {
                    line++;
                }
                blocks.push({ startLine, endLine: line - 1 });
                continue;
            }
            line++;
        }

        return blocks;
    }

    private parseMarkdownTableRow(line: string): TableCellRange[] {
        const cells: TableCellRange[] = [];
        let cellStart = line.startsWith("|") ? 1 : 0;

        for (let i = cellStart; i <= line.length; i++) {
            const isDelimiter = i === line.length || (line[i] === "|" && line[i - 1] !== "\\");
            if (!isDelimiter) continue;

            const start = cellStart;
            const end = i;
            const raw = line.slice(start, end);
            const leading = raw.match(/^\s*/)?.[0].length || 0;
            const trailing = raw.match(/\s*$/)?.[0].length || 0;
            cells.push({
                start,
                end,
                contentStart: start + leading,
                contentEnd: Math.max(start + leading, end - trailing)
            });
            cellStart = i + 1;
        }

        if (line.endsWith("|")) cells.pop();
        return cells;
    }

    private getSourceLineForTableRow(block: TableBlock, renderedRowIndex: number): number {
        return renderedRowIndex === 0 ? block.startLine : block.startLine + renderedRowIndex + 1;
    }

    private getRenderedRowIndexForSourceLine(block: TableBlock, sourceLine: number): number | null {
        if (sourceLine === block.startLine) return 0;
        if (sourceLine >= block.startLine + 2 && sourceLine <= block.endLine) {
            return sourceLine - block.startLine - 1;
        }
        return null;
    }

    private getTableBlockForWidget(filePath: string, widget: Element): TableBlock | null {
        const docText = this.getEditorTextForFile(filePath);
        if (!docText) return null;

        const blocks = this.getMarkdownTableBlocks(docText);
        let widgetIndex = -1;

        this.app.workspace.iterateAllLeaves((leaf) => {
            if (!(leaf.view instanceof MarkdownView) || leaf.view.file?.path !== filePath) return;
            const cm = (leaf.view.editor as EditorWithCodeMirror).cm;
            const widgets = Array.from(cm?.dom.querySelectorAll(".cm-table-widget") || []);
            const index = widgets.indexOf(widget);
            if (index !== -1) {
                widgetIndex = index;
                return false;
            }
        });

        return widgetIndex >= 0 ? blocks[widgetIndex] || null : null;
    }

    public getTableCellContextForEditorView(view: EditorView, filePath: string): { block: TableBlock, sourceLine: number, cell: TableCellRange } | null {
        const widget = view.dom.closest(".cm-table-widget");
        const domCell = view.dom.closest("td, th");
        if (!widget || !domCell) return null;

        const block = this.getTableBlockForWidget(filePath, widget);
        const row = domCell.closest("tr");
        const table = widget.querySelector("table");
        if (!block || !row || !table) return null;

        const rows = Array.from(table.querySelectorAll("tr"));
        const renderedRowIndex = rows.indexOf(row);
        const cells = Array.from(row.children).filter((el) => el.matches("td, th"));
        const renderedCellIndex = cells.indexOf(domCell);
        if (renderedRowIndex < 0 || renderedCellIndex < 0) return null;

        const sourceLine = this.getSourceLineForTableRow(block, renderedRowIndex);
        const lineText = this.getEditorTextForFile(filePath)?.split("\n")[sourceLine];
        if (lineText === undefined) return null;

        const cell = this.parseMarkdownTableRow(lineText)[renderedCellIndex];
        return cell ? { block, sourceLine, cell } : null;
    }

    public getCommentHighlightPresentation(comment: Comment): { className: string, style?: string } {
        let style: string | undefined;
        if (comment.color) {
            const rgb = this.hexToRgb(comment.color);
            const opacity = this.settings.highlightOpacity;
            style = `--sidenote-highlight-color: rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${opacity}); ` +
                    `--sidenote-highlight-hover: rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${Math.min(opacity + 0.15, 1)}); ` +
                    `--sidenote-highlight-border: rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${Math.min(opacity + 0.4, 1)});`;
        }

        return {
            className: `sidenote-highlight sidenote-table-highlight${comment.isOrphaned ? ' orphaned' : ''} sidenote-mark-${comment.markType || 'highlight'}`,
            style
        };
    }

    private unwrapRenderedTableHighlights(root: HTMLElement) {
        root.querySelectorAll(".sidenote-table-highlight").forEach((highlight) => {
            const parent = highlight.parentNode;
            if (!parent) return;
            while (highlight.firstChild) parent.insertBefore(highlight.firstChild, highlight);
            parent.removeChild(highlight);
            parent.normalize();
        });
    }

    private wrapTextRange(root: HTMLElement, start: number, end: number, comment: Comment) {
        if (start < 0 || end <= start) return;

        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                const parent = node.parentElement;
                if (!node.textContent || parent?.closest(".sidenote-table-highlight, svg, .table-col-drag-handle, .table-row-drag-handle")) {
                    return NodeFilter.FILTER_REJECT;
                }
                return NodeFilter.FILTER_ACCEPT;
            }
        });

        const presentation = this.getCommentHighlightPresentation(comment);
        let offset = 0;
        const nodes: Text[] = [];
        let current: Node | null;
        while ((current = walker.nextNode())) nodes.push(current as Text);

        for (const node of nodes) {
            const text = node.nodeValue || "";
            const nodeStart = offset;
            const nodeEnd = offset + text.length;
            offset = nodeEnd;

            const sliceStart = Math.max(start, nodeStart);
            const sliceEnd = Math.min(end, nodeEnd);
            if (sliceStart >= sliceEnd) continue;

            const localStart = sliceStart - nodeStart;
            const localEnd = sliceEnd - nodeStart;
            const before = text.slice(0, localStart);
            const middle = text.slice(localStart, localEnd);
            const after = text.slice(localEnd);
            const span = createSpan();
            span.className = presentation.className;
            span.setAttribute("data-comment-timestamp", comment.timestamp.toString());
            if (presentation.style) span.setAttribute("style", presentation.style);
            span.textContent = middle;

            const fragment = createFragment();
            if (before) fragment.appendChild(document.createTextNode(before));
            fragment.appendChild(span);
            if (after) fragment.appendChild(document.createTextNode(after));
            node.parentNode?.replaceChild(fragment, node);
        }
    }

    public applyRenderedTableHighlights(view: EditorView) {
        if (!this.commentManager) return;
        const filePath = this.getFilePathForEditorView(view);
        if (!filePath || !this.settings.showHighlights) return;

        const docText = view.state.doc.toString();
        const blocks = this.getMarkdownTableBlocks(docText);
        const widgets = Array.from(view.dom.querySelectorAll<HTMLElement>(".cm-table-widget"));
        widgets.forEach(widget => this.unwrapRenderedTableHighlights(widget));
        if (blocks.length === 0 || widgets.length === 0) return;

        const comments = this.commentManager.getCommentsForFile(filePath).filter(comment => !comment.isOrphaned);
        const lines = docText.split("\n");

        comments.forEach((comment) => {
            const blockIndex = blocks.findIndex(block => comment.startLine >= block.startLine && comment.startLine <= block.endLine);
            if (blockIndex < 0) return;

            const block = blocks[blockIndex];
            const rowIndex = this.getRenderedRowIndexForSourceLine(block, comment.startLine);
            if (rowIndex === null) return;

            const widget = widgets[blockIndex];
            const table = widget?.querySelector("table");
            const row = table ? Array.from(table.querySelectorAll("tr"))[rowIndex] : null;
            if (!row) return;

            const lineText = lines[comment.startLine] || "";
            const cellRanges = this.parseMarkdownTableRow(lineText);
            const cellIndex = cellRanges.findIndex(cell => comment.startChar >= cell.contentStart && comment.startChar <= cell.contentEnd);
            const cell = cellIndex >= 0 ? cellRanges[cellIndex] : null;
            if (!cell) return;

            const domCell = Array.from(row.children).filter(el => el.matches("td, th"))[cellIndex] as HTMLElement | undefined;
            if (!domCell || domCell.querySelector(".cm-editor")) return;

            const wrappers = Array.from(domCell.children).filter(el => el.classList.contains("table-cell-wrapper")) as HTMLElement[];
            const target = wrappers.find(wrapper => getComputedStyle(wrapper).display !== "none") || wrappers[0];
            if (!target) return;

            const expectedStart = Math.max(0, comment.startChar - cell.contentStart);
            let start = target.textContent?.indexOf(comment.selectedText) ?? -1;
            if (start < 0) return;

            const matches: number[] = [];
            let search = 0;
            while (true) {
                const found = target.textContent?.indexOf(comment.selectedText, search) ?? -1;
                if (found === -1) break;
                matches.push(found);
                search = found + 1;
            }
            if (matches.length === 0) return;
            start = matches.sort((a, b) => Math.abs(a - expectedStart) - Math.abs(b - expectedStart))[0];

            this.wrapTextRange(target, start, start + comment.selectedText.length, comment);
        });
    }

    public applyRenderedTableHighlightsToAllEditors() {
        this.editorViews.forEach((view) => {
            try {
                this.applyRenderedTableHighlights(view);
            } catch {
                this.editorViews.delete(view);
            }
        });

        this.app.workspace.iterateAllLeaves((leaf) => {
            if (leaf.view instanceof MarkdownView) {
                const cm = (leaf.view.editor as EditorWithCodeMirror).cm;
                if (cm) this.applyRenderedTableHighlights(cm);
            }
        });
    }

    public scheduleRenderedTableHighlights() {
        this.renderedTableHighlightTimers.forEach(timer => window.clearTimeout(timer));
        this.renderedTableHighlightTimers = [0, 50, 150, 400, 900].map(delay =>
            window.setTimeout(() => this.applyRenderedTableHighlightsToAllEditors(), delay)
        );
    }

    public refreshViews() {
        this.app.workspace.getLeavesOfType("sidenote-view").forEach(leaf => {
            if (leaf.view instanceof SideNoteView) leaf.view.renderComments();
        });
    }

    private async ensureCommentFolder(): Promise<string> {
        const folder = this.settings.markdownFolder.trim() || DEFAULT_SETTINGS.markdownFolder;
        const normalized = folder.replace(/^\/+|\/+$/g, "");
        if (!(await this.app.vault.adapter.exists(normalized))) await this.app.vault.createFolder(normalized);
        return normalized;
    }

    private getSideNoteFilePath(notePath: string): string {
        const folder = this.settings.markdownFolder.trim() || DEFAULT_SETTINGS.markdownFolder;
        const normalized = folder.replace(/^\/+|\/+$/g, "");
        const base = notePath.replace(/\.md$/i, "").replace(/\//g, "__");
        return `${normalized}/${base}-sidenote.md`;
    }

    private buildMarkdownBlock(excerpt: string, body: string, timestamp: number): string {
        const safeExcerpt = excerpt || "(no excerpt)";
        return `## ${safeExcerpt}\n\n${body}\n\n---`;
    }

    private async writeCommentToMarkdown(notePath: string, excerpt: string, body: string, timestamp: number): Promise<string> {
        await this.ensureCommentFolder();
        const filePath = this.getSideNoteFilePath(notePath);
        const block = this.buildMarkdownBlock(excerpt, body, timestamp);
        const existing = this.app.vault.getAbstractFileByPath(filePath);
        if (existing instanceof TFile) {
            const content = await this.app.vault.read(existing);
            const updated = content.trim().length === 0 ? block : `${content}\n\n${block}`;
            await this.app.vault.modify(existing, updated);
        } else {
            const header = `# Side Notes for ${notePath}\n\n`;
            await this.app.vault.create(filePath, `${header}${block}`);
        }
        return filePath;
    }

    async migrateInlineCommentsToMarkdown() {
        let changed = false;
        for (const comment of this.comments) {
            if (!comment.commentPath) {
                const path = await this.writeCommentToMarkdown(comment.filePath, comment.selectedText, comment.comment, comment.timestamp);
                comment.commentPath = path;
                changed = true;
            }
        }
        if (changed) await this.saveData();
    }

    // --- Per-file comment storage ---

    private getCommentsJsonPath(notePath: string): string {
        const folder = this.settings.commentsDataFolder?.trim() || DEFAULT_SETTINGS.commentsDataFolder;
        const normalized = normalizePath(folder);
        const base = notePath.replace(/\.md$/i, "").replace(/\//g, "__");
        return `${normalized}/${base}.json`;
    }

    private async ensureCommentsDataFolder(): Promise<string> {
        const folder = this.settings.commentsDataFolder?.trim() || DEFAULT_SETTINGS.commentsDataFolder;
        const normalized = normalizePath(folder);
        if (!(await this.app.vault.adapter.exists(normalized))) {
            await this.app.vault.createFolder(normalized);
        }
        return normalized;
    }

    async loadAllCommentsFromFiles(): Promise<Comment[]> {
        const folder = this.settings.commentsDataFolder?.trim() || DEFAULT_SETTINGS.commentsDataFolder;
        const normalized = normalizePath(folder);
        const allComments: Comment[] = [];
        if (await this.app.vault.adapter.exists(normalized)) {
            const listing = await this.app.vault.adapter.list(normalized);
            for (const filePath of listing.files) {
                if (filePath.endsWith('.json')) {
                    try {
                        const content = await this.app.vault.adapter.read(filePath);
                        const comments = JSON.parse(content) as Comment[];
                        allComments.push(...comments);
                    } catch (e) {
                        console.error(`Error loading comments from ${filePath}:`, e);
                    }
                }
            }
        }
        return allComments;
    }

    async saveAllCommentFiles(): Promise<void> {
        const normalized = await this.ensureCommentsDataFolder();
        const grouped: Record<string, Comment[]> = {};
        for (const comment of this.comments) {
            if (!grouped[comment.filePath]) grouped[comment.filePath] = [];
            grouped[comment.filePath].push(comment);
        }
        const writtenPaths = new Set<string>();
        for (const [filePath, comments] of Object.entries(grouped)) {
            const jsonPath = this.getCommentsJsonPath(filePath);
            await this.app.vault.adapter.write(jsonPath, JSON.stringify(comments, null, 2));
            writtenPaths.add(jsonPath);
        }
        try {
            const listing = await this.app.vault.adapter.list(normalized);
            for (const existing of listing.files) {
                if (existing.endsWith('.json') && !writtenPaths.has(existing)) {
                    await this.app.vault.adapter.remove(existing);
                }
            }
        } catch (e) {
            console.error("Error cleaning up comment files:", e);
        }
    }

    async saveCommentsForSingleFile(filePath: string): Promise<void> {
        await this.ensureCommentsDataFolder();
        const commentsForFile = this.comments.filter(c => c.filePath === filePath);
        const jsonPath = this.getCommentsJsonPath(filePath);
        if (commentsForFile.length === 0) {
            if (await this.app.vault.adapter.exists(jsonPath)) {
                await this.app.vault.adapter.remove(jsonPath);
            }
        } else {
            await this.app.vault.adapter.write(jsonPath, JSON.stringify(commentsForFile, null, 2));
        }
    }

    private showOrphanDeletionNotice(orphans: Comment[]) {
        if (orphans.length === 0) return;
        const fragment = createFragment();
        const span = createSpan();
        span.textContent = `${orphans.length} 条批注已失去原文，是否删除？`;
        fragment.appendChild(span);
        fragment.appendChild(createEl('br'));
        const btnContainer = createDiv();
        btnContainer.className = 'sidenote-notice-actions';
        const deleteBtn = createEl('button');
        deleteBtn.textContent = '删除';
        deleteBtn.className = 'mod-warning';
        const keepBtn = createEl('button');
        keepBtn.textContent = '保留';
        btnContainer.appendChild(deleteBtn);
        btnContainer.appendChild(keepBtn);
        fragment.appendChild(btnContainer);
        const notice = new Notice(fragment, 0);
        deleteBtn.onclick = async () => {
            for (const oc of orphans) {
                this.commentManager.deleteComment(oc.timestamp);
            }
            await this.saveData();
            this.refreshViews();
            notice.hide();
            new Notice(`已删除 ${orphans.length} 条孤立批注。`);
        };
        keepBtn.onclick = () => {
            notice.hide();
        };
    }

    // --- 捕获上下文的辅助函数 ---
    private getSelectionContext(editor: Editor): { before: string, after: string } {
        const doc = editor.getValue();
        const cursorFrom = editor.posToOffset(editor.getCursor("from"));
        const cursorTo = editor.posToOffset(editor.getCursor("to"));
        
        // 获取前文锚点 (最多50字符)
        const start = Math.max(0, cursorFrom - 50);
        const contextBefore = doc.substring(start, cursorFrom);
        
        // 获取后文锚点 (最多50字符)
        const end = Math.min(doc.length, cursorTo + 50);
        const contextAfter = doc.substring(cursorTo, end);

        return { before: contextBefore, after: contextAfter };
    }

    public async handleAddComment(editor: Editor, view: MarkdownView | import("obsidian").MarkdownFileInfo, markType: CommentMarkType, initialColor?: string, skipModal: boolean = false) {
        const resolvedColor = initialColor || this.settings.highlightColor || DEFAULT_SETTINGS.highlightColor;
        const selection = editor.getSelection();
        const filePath = view.file?.path;
        if (selection && selection.trim().length > 0 && filePath) {
            const cursorStart = editor.getCursor("from");
            const cursorEnd = editor.getCursor("to");
            const docText = editor.getValue();
            const absoluteFrom = editor.posToOffset(cursorStart);
            const absoluteTo = editor.posToOffset(cursorEnd);
            const occurrenceIndex = this.getOccurrenceIndex(docText, selection, absoluteFrom);
            const headingPath = this.getHeadingPath(docText, cursorStart.line);
            
            // 获取上下文锚点
            const { before, after } = this.getSelectionContext(editor);

            const existingComment = this.findCommentForRange(
                filePath,
                selection,
                absoluteFrom,
                absoluteTo,
                cursorStart.line,
                cursorStart.ch,
                cursorEnd.line,
                cursorEnd.ch
            );
            if (existingComment) {
                this.hideSelectionToolbars();
                if (skipModal) {
                    await this.editComment(existingComment.timestamp, existingComment.comment, resolvedColor, markType, '批注样式已更新');
                } else {
                    new CommentModal(this.app, this, { mode: 'edit', comment: existingComment }).open();
                }
                return;
            }
            
            if (skipModal) {
                const selectedTextHash = await generateHash(selection);
                const newComment: Comment = {
                    filePath: filePath, startLine: cursorStart.line, startChar: cursorStart.ch,
                    endLine: cursorEnd.line, endChar: cursorEnd.ch,
                    absoluteFrom, absoluteTo, occurrenceIndex, headingPath,
                    selectedText: selection,
                    selectedTextHash: selectedTextHash, comment: "", timestamp: Date.now(), isOrphaned: false,
                    contextBefore: before,
                    contextAfter: after,
                    markType: markType,
                    color: resolvedColor
                };
                await this.addComment(newComment);
                this.hideSelectionToolbars();
                return;
            }

            new CommentModal(this.app, this, {
                mode: 'add',
                selectedText: selection,
                filePath: filePath,
                initialColor: resolvedColor,
                initialMarkType: markType,
                onSubmitAdd: async (commentText, color, selectedMarkType) => {
                    const selectedTextHash = await generateHash(selection);
                    const newComment: Comment = {
                        filePath: filePath, startLine: cursorStart.line, startChar: cursorStart.ch,
                        endLine: cursorEnd.line, endChar: cursorEnd.ch,
                        absoluteFrom, absoluteTo, occurrenceIndex, headingPath,
                        selectedText: selection,
                        selectedTextHash: selectedTextHash, comment: commentText, timestamp: Date.now(), isOrphaned: false,
                        // 保存上下文
                        contextBefore: before,
                        contextAfter: after,
                        markType: selectedMarkType,
                        color: color || resolvedColor
                    };
                    await this.addComment(newComment);
                }
            }).open();
        } else {
            new Notice("请先选择要批注的文字。");
        }
    }

    async onload() {
        // Heal orphaned floating windows and stale cross-reload modal references first.
        CommentModal.closeActive();
        await this.loadPluginData();
        this.commentManager = new CommentManager(this.comments);
        await this.migrateComments();
        this.registerEditorExtension([this.createSelectionToolbarPlugin(), ...this.createHighlightPlugin()]);
        this.registerMarkdownPostProcessor((el, ctx) => this.registerReadingViewSection(el, ctx), 100);
        this.registerReadingViewInteractions();
        this.app.workspace.onLayoutReady(() => this.rerenderReadingViews());
        this.registerSelectionToolbarDismissal();
        this.scheduleRenderedTableHighlights();
        
        this.registerEvent(
            this.app.workspace.on('active-leaf-change', () => {
                this.hideSelectionToolbars();
            })
        );
        
        this.addSettingTab(new SideNoteSettingTab(this.app, this));
        this.registerView("sidenote-view", (leaf) => new SideNoteView(leaf, this));

        this.registerObsidianProtocolHandler("sidenote", async (params) => {
            const timestamp = parseInt(params.timestamp);
            if (timestamp) {
                const comment = this.comments.find(c => c.timestamp === timestamp);
                if (comment) {
                    let sideNoteView = null;
                    const leaves = this.app.workspace.getLeavesOfType("sidenote-view");
                    if (leaves.length > 0) sideNoteView = leaves[0].view as SideNoteView;
                    if (!sideNoteView) {
                        await this.activateView();
                        const newLeaves = this.app.workspace.getLeavesOfType("sidenote-view");
                        if (newLeaves.length > 0) sideNoteView = newLeaves[0].view as SideNoteView;
                    }
                    if (sideNoteView) void sideNoteView.jumpToComment(comment);
                }
            }
        });

        this.addCommand({ id: "open-comment-view", name: "在分屏中打开批注视图", callback: () => void switchToSideNoteView(this.app) });
        this.addCommand({ id: "activate-view", name: "在侧边栏打开批注视图", callback: () => this.activateView() });
        
        this.addCommand({
            id: "add-comment-to-selection", name: "为选中内容添加高亮", icon: "message-square",
            editorCallback: async (editor, view) => this.handleAddComment(editor, view, 'highlight', undefined, true)
        });
        this.addCommand({
            id: "add-underline-comment-to-selection", name: "为选中内容添加下划线", icon: "message-square",
            editorCallback: async (editor, view) => this.handleAddComment(editor, view, 'underline', undefined, true)
        });
        this.addCommand({
            id: "add-strikethrough-comment-to-selection", name: "为选中内容添加删除线", icon: "message-square",
            editorCallback: async (editor, view) => this.handleAddComment(editor, view, 'strikethrough', undefined, true)
        });
        this.addCommand({
            id: "add-bold-comment-to-selection", name: "为选中内容添加加粗", icon: "message-square",
            editorCallback: async (editor, view) => this.handleAddComment(editor, view, 'bold', undefined, true)
        });
        this.addCommand({
            id: "add-pure-comment-to-selection", name: "为选中内容添加批注 (弹出输入框)", icon: "message-square-plus",
            editorCallback: async (editor, view) => this.handleAddComment(editor, view, 'highlight', undefined, false)
        });
        this.addCommand({
            id: "export-note-to-word", name: "导出当前笔记为 word (含批注)", icon: "file-down",
            checkCallback: (checking) => {
                const file = this.app.workspace.getActiveFile();
                const canRun = !!(file && file.extension === "md");
                if (canRun && !checking) void this.exportActiveNoteToWord();
                return canRun;
            }
        });

        this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor, view) => {
            if (editor.somethingSelected()) {
                menu.addItem((item) => {
                    item.setTitle("添加高亮").setIcon("message-square").onClick(() => this.handleAddComment(editor, view, 'highlight', undefined, true));
                });
                menu.addItem((item) => {
                    item.setTitle("添加下划线").setIcon("message-square").onClick(() => this.handleAddComment(editor, view, 'underline', undefined, true));
                });
                menu.addItem((item) => {
                    item.setTitle("添加删除线").setIcon("message-square").onClick(() => this.handleAddComment(editor, view, 'strikethrough', undefined, true));
                });
                menu.addItem((item) => {
                    item.setTitle("添加加粗").setIcon("message-square").onClick(() => this.handleAddComment(editor, view, 'bold', undefined, true));
                });
                menu.addItem((item) => {
                    item.setTitle("添加批注").setIcon("message-square-plus").onClick(() => this.handleAddComment(editor, view, 'highlight', undefined, false));
                });
            }
            menu.addItem((item) => {
                item.setTitle("导出为 word (含批注)").setIcon("file-down").onClick(() => void this.exportActiveNoteToWord(view.file ?? undefined));
            });
        }));

        this.addRibbonIcon("message-square", "Side note: Open in sidebar", () => { void this.activateView(); });
        this.registerEvent(this.app.workspace.on('active-leaf-change', (leaf) => {
            if (leaf && leaf.view instanceof MarkdownView) {
                const file = leaf.view.file;
                this.app.workspace.getLeavesOfType("sidenote-view").forEach(sideNoteLeaf => {
                    if (sideNoteLeaf.view instanceof SideNoteView) sideNoteLeaf.view.updateActiveFile(file);
                });
                this.refreshEditorDecorations();
                this.scheduleRenderedTableHighlights();
            }
        }));
        this.registerEvent(this.app.vault.on('rename', async (file, oldPath) => {
            if (file instanceof TFile && file.extension === 'md') {
                this.commentManager.renameFile(oldPath, file.path);
                await this.saveData();
                this.refreshViews();
            }
        }));
        this.registerEvent(this.app.vault.on('modify', async (file) => {
            if (this.isSaving) return;
            // Ignore our own comment data files
            const dataFolder = normalizePath(this.settings.commentsDataFolder?.trim() || DEFAULT_SETTINGS.commentsDataFolder);
            if (file.path.startsWith(dataFolder + '/')) return;

            const pluginDataPath = normalizePath(`${this.app.vault.configDir}/plugins/${this.manifest.id}/data.json`);
            if (file.path === pluginDataPath || (file instanceof TFile && file.name === 'data.json' && file.parent?.name === this.manifest.id)) {
                try {
                    await this.loadPluginData();
                    this.commentManager.updateComments(this.comments);
                    this.refreshViews();
                    this.refreshEditorDecorations();
                    this.scheduleRenderedTableHighlights();
                } catch (error) { console.error("Error reloading plugin data:", error); }
            } else if (file instanceof TFile && file.extension === 'md') {
                try {
                    // Track orphans before update
                    const beforeOrphanTimestamps = new Set(
                        this.commentManager.getCommentsForFile(file.path)
                            .filter(c => c.isOrphaned)
                            .map(c => c.timestamp)
                    );

                    const fileContent = await this.app.vault.read(file);
                    await this.commentManager.updateCommentCoordinatesForFile(fileContent, file.path);
                    await this.saveCommentsForSingleFile(file.path);
                    this.refreshViews();
                    this.refreshEditorDecorations();
                    this.scheduleRenderedTableHighlights();

                    // Detect newly orphaned comments
                    const newOrphans = this.commentManager.getCommentsForFile(file.path)
                        .filter(c => c.isOrphaned && !beforeOrphanTimestamps.has(c.timestamp));
                    if (newOrphans.length > 0) {
                        this.pendingOrphans.push(...newOrphans);
                        if (this.orphanNoticeTimer) window.clearTimeout(this.orphanNoticeTimer);
                        this.orphanNoticeTimer = window.setTimeout(() => {
                            const uniqueOrphans = [...new Map(this.pendingOrphans.map(o => [o.timestamp, o])).values()];
                            this.showOrphanDeletionNotice(uniqueOrphans);
                            this.pendingOrphans = [];
                        }, 2000);
                    }
                } catch (error) { console.error("Error updating comment coordinates:", error); }
            }
        }));
    }

    onunload() {
        CommentModal.closeActive();
        this.hideSelectionToolbars();
        this.hideReadingTooltip();
        if (this.orphanNoticeTimer) {
            window.clearTimeout(this.orphanNoticeTimer);
            this.orphanNoticeTimer = null;
        }
    }

    async activateViewAndHighlightComment(timestamp: number) {
        const comment = this.comments.find(item => item.timestamp === timestamp);
        const target = comment ? this.app.vault.getAbstractFileByPath(comment.filePath) : null;
        await this.activateView(target instanceof TFile ? target : undefined);
        const leaves = this.app.workspace.getLeavesOfType("sidenote-view");
        leaves.forEach(leaf => { if (leaf.view instanceof SideNoteView) leaf.view.highlightComment(timestamp); });
    }

    async activateView(targetFile?: TFile) {
        const { workspace } = this.app;
        let leaf: WorkspaceLeaf | null = null;
        const leaves = workspace.getLeavesOfType("sidenote-view");
        if (leaves.length > 0) leaf = leaves[0];
        else {
            const rightLeaf = workspace.getRightLeaf(false);
            if (rightLeaf) { leaf = rightLeaf; await leaf.setViewState({ type: "sidenote-view", active: true }); }
        }
        if (leaf) {
            await workspace.revealLeaf(leaf);
            if (leaf.view instanceof SideNoteView) {
                const activeFile = targetFile || workspace.getActiveFile();
                leaf.view.updateActiveFile(activeFile);
            }
        }
    }

    async onCommentsChanged(message: string) {
        await this.saveData();
        this.refreshViews();
        this.refreshEditorDecorations();
        this.scheduleRenderedTableHighlights();
        new Notice(message);
    }

    async addComment(newComment: Comment) {
        await this.commentManager.addComment(newComment);
        await this.onCommentsChanged("批注已添加");
    }

    async editComment(timestamp: number, newCommentText: string, newColor?: string, newMarkType?: CommentMarkType, message: string = "批注已更新") {
        this.commentManager.editComment(timestamp, newCommentText, newColor, newMarkType);
        await this.onCommentsChanged(message);
    }

    async deleteComment(timestamp: number) {
        const deletedComment = this.comments.find(comment => comment.timestamp === timestamp);
        if (!deletedComment) return;
        this.commentManager.deleteComment(timestamp);
        await this.saveData();
        this.refreshViews();
        this.refreshEditorDecorations();

        const notice = new Notice('', 7000);
        notice.messageEl.empty();
        const row = notice.messageEl.createDiv('sidenote-undo-notice');
        row.createSpan({ text: '批注已删除' });
        const undoButton = row.createEl('button', { text: '撤销' });
        undoButton.onclick = async () => {
            if (!this.comments.some(comment => comment.timestamp === deletedComment.timestamp)) {
                await this.commentManager.addComment(deletedComment);
                await this.saveData();
                this.refreshViews();
                this.refreshEditorDecorations();
                new Notice('已恢复批注');
            }
            notice.hide();
        };
    }

    async copyBacklink(comment: Comment) {
        const quoteText = (text: string, prefix: string) => {
            return text.split('\n').map(line => prefix + line).join('\n');
        };
        const link = `[点击跳转至原文位置](obsidian://sidenote?timestamp=${comment.timestamp})`;
        const callout = `> [!quote] 批注回链 - ${link}\n` +
                        `> **原文**：\n` +
                        `${quoteText(comment.selectedText || "", "> > ")}\n` +
                        `> \n` +
                        `> **批注**：\n` +
                        `${quoteText(comment.comment || "（无）", "> ")}`;
        await navigator.clipboard.writeText(callout);
        new Notice("已复制精确回链 (无污染防漂移)");
    }

    async exportActiveNoteToWord(target?: TFile) {
        const file = target ?? this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") {
            new Notice("请先打开一个 Markdown 笔记再导出。");
            return;
        }
        try {
            const markdown = await this.app.vault.read(file);
            const comments = this.commentManager.getCommentsForFile(file.path);
            const result = await exportNoteToDocx({ markdown, comments, title: file.basename });
            const buffer = await result.blob.arrayBuffer();
            const outPath = normalizePath(file.path.replace(/\.md$/i, "") + ".docx");
            await this.app.vault.adapter.writeBinary(outPath, buffer);
            let msg = `已导出 Word：${outPath}（${result.commentCount} 条批注）`;
            if (result.skippedCount > 0) msg += `；${result.skippedCount} 条批注因原文变动无法定位，已跳过`;
            new Notice(msg);
        } catch (e) {
            console.error("[SideNote] Word 导出失败", e);
            new Notice("导出 Word 失败：" + (e instanceof Error ? e.message : String(e)));
        }
    }

    async loadPluginData() {
        const loadedData = (await this.loadData()) as unknown as Partial<PluginData> | null;
        const rawData: PluginData = {
            ...DEFAULT_SETTINGS,
            ...(loadedData ?? {}),
            imageHashes: loadedData?.imageHashes ?? {}
        };
        this.settings = { ...DEFAULT_SETTINGS, ...rawData };
        this.imageHashes = rawData.imageHashes || {};

        // Load comments from per-file storage
        this.comments = await this.loadAllCommentsFromFiles();

        // Migration: if data.json still has comments, migrate them
        if (rawData.comments && rawData.comments.length > 0) {
            const oldComments = rawData.comments;
            const existingTimestamps = new Set(this.comments.map(c => c.timestamp));
            let migratedCount = 0;
            for (const oc of oldComments) {
                if (!existingTimestamps.has(oc.timestamp)) {
                    this.comments.push(oc);
                    migratedCount++;
                }
            }
            if (migratedCount > 0) {
                await this.saveAllCommentFiles();
                new Notice(`已迁移 ${migratedCount} 条批注到独立文件存储。`);
            }
            // Save data.json without comments
            const cleanData = { ...this.settings, imageHashes: this.imageHashes };
            await super.saveData(cleanData);
        }

        this.applyHighlightColor();
    }

    async migrateComments() {
        let needsSave = false;
        for (const comment of this.comments) {
            if (!comment.selectedTextHash && comment.selectedText) {
                comment.selectedTextHash = await generateHash(comment.selectedText);
                needsSave = true;
            }
            if (comment.isOrphaned === undefined) {
                comment.isOrphaned = false;
                needsSave = true;
            }
            if (!comment.color) {
                comment.color = this.settings.highlightColor || DEFAULT_SETTINGS.highlightColor;
                needsSave = true;
            }
        }
        if (needsSave) await this.saveData();
    }

    applyHighlightColor() {
        const root = document.documentElement;
        const rgb = this.hexToRgb(this.settings.highlightColor);
        const opacity = this.settings.highlightOpacity;
        root.style.setProperty('--sidenote-highlight-color', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${opacity})`);
        root.style.setProperty('--sidenote-highlight-hover', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${Math.min(opacity + 0.15, 1)})`);
        root.style.setProperty('--sidenote-highlight-border', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${Math.min(opacity + 0.4, 1)})`);
        root.style.setProperty('--sidenote-orphaned-color', `rgba(255, 100, 100, ${opacity})`);
        root.style.setProperty('--sidenote-orphaned-hover', `rgba(255, 100, 100, ${Math.min(opacity + 0.15, 1)})`);
        root.style.setProperty('--sidenote-orphaned-border', `rgba(255, 100, 100, ${Math.min(opacity + 0.35, 1)})`);
        this.refreshEditorDecorations();
    }

    hexToRgb(hex: string): { r: number; g: number; b: number } {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result ? { r: parseInt(result[1], 16), g: parseInt(result[2], 16), b: parseInt(result[3], 16) } : { r: 255, g: 200, b: 0 };
    }

    async saveData() {
        this.isSaving = true;
        try {
            const dataToSave = { ...this.settings, imageHashes: this.imageHashes };
            await super.saveData(dataToSave);
            await this.saveAllCommentFiles();
        } finally {
            this.isSaving = false;
        }
        this.refreshEditorDecorations();
        this.scheduleRenderedTableHighlights();
    }

    refreshEditorDecorations() {
        this.editorViews.forEach((view) => {
            try {
                view.dispatch({ effects: [forceUpdateEffect.of(null)] });
                this.applyRenderedTableHighlights(view);
            } catch {
                this.editorViews.delete(view);
            }
        });

        this.app.workspace.iterateAllLeaves((leaf) => {
            if (leaf.view instanceof MarkdownView) {
                const editor = leaf.view.editor;
                const cm = (editor as EditorWithCodeMirror).cm;
                if (cm) {
                    cm.dispatch({ effects: [forceUpdateEffect.of(null)] });
                    this.applyRenderedTableHighlights(cm);
                }
            }
        });
        this.refreshReadingViewHighlights();
        this.scheduleRenderedTableHighlights();
    }

    private createSelectionToolbarPlugin() {
        // eslint-disable-next-line @typescript-eslint/no-this-alias -- Nested CodeMirror classes need the owning plugin instance.
        const plugin = this;
        let activeToolbarController: { view: EditorView, hideToolbar: () => void } | null = null;

        return ViewPlugin.fromClass(class {
            toolbar: HTMLElement | null = null;
            view: EditorView;
            hideToolbarEvent: () => void;
            
            constructor(view: EditorView) {
                this.view = view;
                this.hideToolbarEvent = () => this.hideToolbar();
                document.addEventListener('sidenote-hide-selection-toolbar', this.hideToolbarEvent);
            }

            update(update: ViewUpdate) {
                if (update.selectionSet || update.viewportChanged) {
                    window.setTimeout(() => this.checkSelection(), 10);
                }
            }

            checkSelection() {
                if (!plugin.settings.enableSelectionToolbar) {
                    this.hideToolbar();
                    return;
                }
                
                // Avoid showing toolbar if a modal is open to prevent overlapping
                if (document.querySelector('.sidenote-edit-modal')) {
                    this.hideToolbar();
                    return;
                }

                const focusedEditors = Array.from(document.querySelectorAll('.cm-editor.cm-focused'));
                const focusedEditor = focusedEditors[focusedEditors.length - 1];
                if (focusedEditor && focusedEditor !== this.view.dom) {
                    this.hideToolbar();
                    return;
                }
                
                const selection = this.view.state.selection.main;
                if (!selection.empty && selection.to - selection.from > 0) {
                    const text = this.view.state.sliceDoc(selection.from, selection.to);
                    if (text.trim().length > 0) {
                        this.showToolbar(selection);
                        return;
                    }
                }
                this.hideToolbar();
            }

            showToolbar(selection: SelectionRange) {
                if (this.toolbar && !this.toolbar.isConnected) {
                    this.toolbar = null;
                }
                if (activeToolbarController && activeToolbarController.view !== this.view) {
                    activeToolbarController.hideToolbar();
                }
                document.querySelectorAll('.sidenote-selection-toolbar').forEach((toolbar) => {
                    if (toolbar !== this.toolbar) toolbar.remove();
                });

                if (!this.toolbar) {
                    this.toolbar = createDiv();
                    this.toolbar.className = "sidenote-selection-toolbar";
                    document.body.appendChild(this.toolbar);
                    this.buildToolbarUI();
                    
                    this.toolbar.addEventListener('mousedown', (e) => {
                        e.preventDefault();
                    });
                }
                
                activeToolbarController = { view: this.view, hideToolbar: () => this.hideToolbar() };
                const selectedText = this.view.state.sliceDoc(selection.from, selection.to);
                const startLine = this.view.state.doc.lineAt(selection.from);
                const endLine = this.view.state.doc.lineAt(selection.to);
                const filePath = plugin.getFilePathForEditorView(this.view);
                const existingComment = filePath ? plugin.findCommentForRange(
                    filePath,
                    selectedText,
                    selection.from,
                    selection.to,
                    startLine.number - 1,
                    selection.from - startLine.from,
                    endLine.number - 1,
                    selection.to - endLine.from
                ) : undefined;
                const existingIndicator = this.toolbar.querySelector<HTMLElement>('.sidenote-existing-indicator');
                if (existingIndicator) existingIndicator.toggleAttribute('hidden', !existingComment);
                this.toolbar.classList.toggle('sidenote-toolbar-existing', Boolean(existingComment));
                const commentButton = this.toolbar.querySelector<HTMLButtonElement>('[data-sidenote-action="comment"]');
                if (commentButton) {
                    commentButton.title = existingComment ? '编辑批注' : '添加批注';
                    commentButton.setAttribute('aria-label', commentButton.title);
                }

                const activeMarkType = existingComment?.markType || 'highlight';
                this.toolbar.querySelectorAll<HTMLButtonElement>('.sidenote-toolbar-btn[data-mark-type]:not([data-sidenote-action="comment"])')
                    .forEach((button) => {
                        const active = Boolean(existingComment) && button.dataset.markType === activeMarkType;
                        button.classList.toggle('active', active);
                        button.setAttribute('aria-pressed', active ? 'true' : 'false');
                    });

                const activeColor = existingComment?.color || plugin.settings.highlightColor || DEFAULT_SETTINGS.highlightColor;
                const toolbarColorPicker = this.toolbar.querySelector<HTMLInputElement>('.sidenote-toolbar-color-picker');
                if (toolbarColorPicker && /^#[0-9a-f]{6}$/i.test(activeColor)) toolbarColorPicker.value = activeColor;
                const colorCircles = Array.from(this.toolbar.querySelectorAll<HTMLElement>('.sidenote-color-circle'));
                colorCircles.forEach(circle => {
                    circle.classList.remove('active');
                    circle.setAttribute('aria-pressed', 'false');
                });
                const matchingPreset = colorCircles.find(circle =>
                    !circle.classList.contains('custom-color') &&
                    circle.style.getPropertyValue('--circle-color').toLowerCase() === activeColor.toLowerCase()
                );
                const customCircle = this.toolbar.querySelector<HTMLElement>('.sidenote-color-circle.custom-color');
                customCircle?.style.setProperty('--sidenote-custom-color', activeColor);
                const activeColorCircle = matchingPreset || customCircle;
                activeColorCircle?.classList.add('active');
                activeColorCircle?.setAttribute('aria-pressed', 'true');
                
                const coords = this.view.coordsAtPos(selection.to);
                const fromCoords = this.view.coordsAtPos(selection.from);
                if (coords && fromCoords) {
                    const toolbarWidth = this.toolbar.offsetWidth || 320;
                    const toolbarHeight = this.toolbar.offsetHeight || 50;

                    let leftCenter = (coords.left + fromCoords.left) / 2;
                    let topEdge = Math.min(coords.top, fromCoords.top);
                    const bottomEdge = Math.max(coords.bottom, fromCoords.bottom);
                    
                    const editorRect = this.view.dom.getBoundingClientRect();
                    
                    const padding = 10;
                    if (leftCenter - toolbarWidth / 2 < editorRect.left + padding) {
                        leftCenter = editorRect.left + toolbarWidth / 2 + padding;
                    } else if (leftCenter + toolbarWidth / 2 > editorRect.right - padding) {
                        leftCenter = editorRect.right - toolbarWidth / 2 - padding;
                    }
                    
                    if (topEdge - toolbarHeight < editorRect.top + padding) {
                        this.toolbar.classList.add('sidenote-toolbar-bottom');
                        topEdge = bottomEdge;
                    } else {
                        this.toolbar.classList.remove('sidenote-toolbar-bottom');
                    }
                    
                    this.toolbar.style.left = `${leftCenter}px`;
                    this.toolbar.style.top = `${topEdge}px`;
                }
            }

            hideToolbar() {
                if (this.toolbar) {
                    this.toolbar.remove();
                    this.toolbar = null;
                }
                if (activeToolbarController?.view === this.view) {
                    activeToolbarController = null;
                }
            }

            destroy() {
                document.removeEventListener('sidenote-hide-selection-toolbar', this.hideToolbarEvent);
                this.hideToolbar();
            }

            buildToolbarUI() {
                if (!this.toolbar) return;
                
                const createBtn = (iconName: string, tooltip: string, markType: CommentMarkType, skipModal: boolean = false) => {
                    const btn = createEl('button');
                    btn.type = 'button';
                    btn.className = 'sidenote-toolbar-btn';
                    btn.title = tooltip;
                    btn.setAttribute('aria-label', tooltip);
                    btn.setAttribute('data-mark-type', markType);
                    btn.setAttribute('aria-pressed', 'false');
                    setIcon(btn, iconName);
                    btn.onclick = async () => {
                        const color = (this.toolbar?.querySelector('.sidenote-toolbar-color-picker') as HTMLInputElement)?.value || plugin.settings.highlightColor || "#FFC800";
                        await plugin.handleAddCommentFromEditorView(this.view, markType, color, skipModal);
                    };
                    return btn;
                };

                const boldBtn = createBtn('bold', '加粗', 'bold', true);
                const highlighterBtn = createBtn('highlighter', '高亮', 'highlight', true);
                const underlineBtn = createBtn('underline', '下划线', 'underline', true);
                const strikethroughBtn = createBtn('strikethrough', '删除线', 'strikethrough', true);
                const commentBtn = createBtn('message-square-plus', '添加批注', 'highlight', false);
                commentBtn.setAttribute('data-sidenote-action', 'comment');

                this.toolbar.appendChild(boldBtn);
                this.toolbar.appendChild(highlighterBtn);
                this.toolbar.appendChild(underlineBtn);
                this.toolbar.appendChild(strikethroughBtn);
                this.toolbar.appendChild(commentBtn);

                const existingIndicator = createSpan();
                existingIndicator.className = 'sidenote-existing-indicator';
                existingIndicator.textContent = '已批注';
                existingIndicator.hidden = true;
                this.toolbar.appendChild(existingIndicator);

                const divider = createDiv();
                divider.className = 'sidenote-toolbar-divider';
                this.toolbar.appendChild(divider);

                const colorPicker = createEl('input');
                colorPicker.type = 'color';
                colorPicker.className = 'sidenote-toolbar-color-picker';
                colorPicker.value = plugin.settings.highlightColor || "#FFC800";

                let activeCircle: HTMLElement | null = null;
                const updateActiveCircle = (circle: HTMLElement | null) => {
                    if (activeCircle) {
                        activeCircle.classList.remove('active');
                        activeCircle.setAttribute('aria-pressed', 'false');
                    }
                    if (circle) {
                        circle.classList.add('active');
                        circle.setAttribute('aria-pressed', 'true');
                    }
                    activeCircle = circle;
                };

                COLOR_PRESETS.forEach(color => {
                    const circle = createEl('button');
                    circle.type = 'button';
                    circle.className = 'sidenote-color-circle';
                    circle.style.setProperty('--circle-color', color.value);
                    circle.title = color.name;
                    circle.setAttribute('aria-label', color.name);
                    circle.setAttribute('aria-pressed', 'false');
                    if (colorPicker.value.toLowerCase() === color.value.toLowerCase()) {
                        updateActiveCircle(circle);
                    }
                    circle.onclick = () => {
                        colorPicker.value = color.value;
                        updateActiveCircle(circle);
                    };
                    this.toolbar?.appendChild(circle);
                });

                const customColorWrapper = createEl('label');
                customColorWrapper.className = 'sidenote-color-circle custom-color';
                customColorWrapper.title = '自定义颜色';
                customColorWrapper.setAttribute('aria-label', '自定义颜色');
                customColorWrapper.setAttribute('role', 'button');
                customColorWrapper.setAttribute('aria-pressed', 'false');
                customColorWrapper.tabIndex = 0;
                customColorWrapper.style.setProperty('--sidenote-custom-color', colorPicker.value);
                
                const updateCustomColor = () => {
                    customColorWrapper.style.setProperty('--sidenote-custom-color', colorPicker.value);
                    const matchedPreset = Array.from(this.toolbar?.querySelectorAll('.sidenote-color-circle:not(.custom-color)') || []).find(c => {
                        return (c as HTMLElement).style.getPropertyValue('--circle-color').toLowerCase() === colorPicker.value.toLowerCase();
                    });
                    if (matchedPreset) {
                        updateActiveCircle(matchedPreset as HTMLElement);
                    } else {
                        updateActiveCircle(customColorWrapper);
                    }
                };
                colorPicker.setAttribute('aria-label', '选择自定义颜色');
                colorPicker.oninput = updateCustomColor;
                colorPicker.onchange = updateCustomColor;
                customColorWrapper.onkeydown = (event: KeyboardEvent) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    colorPicker.click();
                };

                customColorWrapper.appendChild(colorPicker);
                this.toolbar.appendChild(customColorWrapper);
                if (!activeCircle) updateActiveCircle(customColorWrapper);
            }
        });
    }

    private createHighlightPlugin() {
        // eslint-disable-next-line @typescript-eslint/no-this-alias -- Nested CodeMirror classes need the owning plugin instance.
        const plugin = this;
        const commentTooltip = hoverTooltip((view, pos, side) => {
            const filePath = plugin.getFilePathForEditorView(view);
            if (!filePath) return null;

            const comments = plugin.commentManager.getCommentsForFile(filePath);
            const { doc } = view.state;
            const hoveredComment = comments.find(comment => {
                if (comment.isOrphaned) return false;
                try {
                    const startLineObj = doc.line(comment.startLine + 1);
                    const from = startLineObj.from + comment.startChar;
                    let to = from;
                    if (comment.isOrphaned) {
                        to = Math.min(from + 1, startLineObj.to);
                    } else {
                        const endLineObj = doc.line(comment.endLine + 1);
                        to = endLineObj.from + comment.endChar;
                    }
                    return pos >= from && pos <= to;
                } catch { return false; }
            });

            if (!hoveredComment) return null;
            // 没有批注内容时不显示 tooltip
            if (!hoveredComment.comment || !hoveredComment.comment.trim()) return null;

            return {
                pos, above: true, arrow: false, offset: { x: 0, y: 10 },
                create(view) {
                    const dom = createDiv();
                    dom.className = "sidenote-tooltip";
                    dom.classList.add("is-loading");

                    // 左侧颜色 accent bar
                    const accentBar = dom.createDiv("sidenote-tooltip-accent");
                    accentBar.style.background = hoveredComment.color || "#FFC800";

                    // 右侧主体区
                    const body = dom.createDiv("sidenote-tooltip-body");

                    // 正文内容区
                    const content = body.createDiv("sidenote-tooltip-content markdown-rendered");

                    // 底部 meta：日期
                    const metaRow = body.createDiv("sidenote-tooltip-meta");
                    const dateSpan = metaRow.createSpan("sidenote-tooltip-date");
                    const d = new Date(hoveredComment.timestamp);
                    dateSpan.textContent = `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2,"0")}:${d.getMinutes().toString().padStart(2,"0")}`;

                    void (async () => {
                        await plugin.renderCommentContent(hoveredComment.comment || "", content, hoveredComment.filePath);
                        dom.classList.remove("is-loading");
                    })();
                    let tooltipHost: HTMLElement | null = null;
                    return {
                        dom,
                        mount() {
                            tooltipHost = dom.closest<HTMLElement>('.cm-tooltip');
                            tooltipHost?.classList.add('sidenote-tooltip-host');
                        },
                        destroy() {
                            tooltipHost?.classList.remove('sidenote-tooltip-host');
                            tooltipHost = null;
                        }
                    };
                }
            };
        });

        const highlightPlugin = ViewPlugin.fromClass(class {
            decorations: DecorationSet;
            view: EditorView;
            constructor(view: EditorView) {
                this.view = view;
                plugin.editorViews.add(view);
                this.decorations = this.buildDecorations(view);
                window.setTimeout(() => plugin.applyRenderedTableHighlights(view), 0);
                this.view.dom.addEventListener('click', this.handleClick);
            }
            destroy() { 
                plugin.editorViews.delete(this.view);
                this.view.dom.removeEventListener('click', this.handleClick);
            }
            private readonly handleClick = (event: MouseEvent) => {
                const target = event.target as HTMLElement;
                const highlight = target.closest('.sidenote-highlight');
                if (highlight) {
                    const timestampStr = highlight.getAttribute('data-comment-timestamp');
                    if (timestampStr) {
                        const timestamp = parseInt(timestampStr, 10);
                        void plugin.activateViewAndHighlightComment(timestamp);
                    }
                }
            };
            update(update: ViewUpdate) {
                if (update.docChanged) plugin.mapCommentPositionsFromView(update);
                if (update.docChanged || update.viewportChanged || update.transactions.some(tr => tr.effects.some(e => e.is(forceUpdateEffect)))) {
                    this.decorations = this.buildDecorations(update.view);
                    window.setTimeout(() => plugin.applyRenderedTableHighlights(update.view), 0);
                }
            }
            buildDecorations(view: EditorView): DecorationSet {
                const builder = new RangeSetBuilder<Decoration>();
                if (!plugin.settings.showHighlights) return builder.finish();
                
                const filePath = plugin.getFilePathForEditorView(view);
                if (!filePath) return builder.finish();

                const comments = plugin.commentManager.getCommentsForFile(filePath);
                const doc = view.state.doc;
                const decorationsArray: Array<{from: number, to: number, decoration: Decoration}> = [];
                const tableCellContext = plugin.getTableCellContextForEditorView(view, filePath);

                if (tableCellContext) {
                    const cellText = doc.toString();
                    comments.forEach(comment => {
                        if (comment.isOrphaned || comment.startLine !== tableCellContext.sourceLine) return;
                        if (comment.startChar < tableCellContext.cell.contentStart || comment.startChar > tableCellContext.cell.contentEnd) return;

                        const expectedFrom = Math.max(0, comment.startChar - tableCellContext.cell.contentStart);
                        const matches: number[] = [];
                        let search = 0;
                        while (comment.selectedText) {
                            const found = cellText.indexOf(comment.selectedText, search);
                            if (found === -1) break;
                            matches.push(found);
                            search = found + 1;
                        }

                        if (matches.length === 0) return;
                        const from = matches.sort((a, b) => Math.abs(a - expectedFrom) - Math.abs(b - expectedFrom))[0];
                        const to = from + comment.selectedText.length;

                        if (from >= 0 && to <= doc.length && from < to && doc.sliceString(from, to) === comment.selectedText) {
                            const presentation = plugin.getCommentHighlightPresentation(comment);
                            const attributes: Record<string, string> = { 'data-comment-timestamp': comment.timestamp.toString() };
                            if (presentation.style) attributes.style = presentation.style;
                            decorationsArray.push({
                                from,
                                to,
                                decoration: Decoration.mark({
                                    class: presentation.className,
                                    attributes
                                })
                            });
                        }
                    });

                    decorationsArray.sort((a, b) => a.from - b.from);
                    decorationsArray.forEach(({ from, to, decoration }) => builder.add(from, to, decoration));
                    return builder.finish();
                }

                comments.forEach(comment => {
                    try {
                        const startLineObj = doc.line(comment.startLine + 1);
                        const from = startLineObj.from + comment.startChar;
                        let to = from;
                        if (comment.isOrphaned) {
                            to = Math.min(from + 1, startLineObj.to);
                        } else {
                            try {
                                const endLineObj = doc.line(comment.endLine + 1);
                                to = endLineObj.from + comment.endChar;
                            } catch {
                                to = doc.length;
                            }
                        }
                        
                        if (!comment.isOrphaned && doc.sliceString(from, to) !== comment.selectedText) return;
                        if (from >= 0 && to <= doc.length && from < to) {
                            const attributes: Record<string, string> = { 'data-comment-timestamp': comment.timestamp.toString() };
                            if (comment.color) {
                                const rgb = plugin.hexToRgb(comment.color);
                                const opacity = plugin.settings.highlightOpacity;
                                attributes.style = `--sidenote-highlight-color: rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${opacity}); ` +
                                                   `--sidenote-highlight-hover: rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${Math.min(opacity + 0.15, 1)}); ` +
                                                   `--sidenote-highlight-border: rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${Math.min(opacity + 0.4, 1)});`;
                            }
                            decorationsArray.push({
                                from, to,
                                decoration: Decoration.mark({
                                    class: `sidenote-highlight${comment.isOrphaned ? ' orphaned' : ''} sidenote-mark-${comment.markType || 'highlight'}`,
                                    attributes: attributes
                                })
                            });
                        }
                    } catch {
                        return;
                    }
                });
                decorationsArray.sort((a, b) => a.from - b.from);
                decorationsArray.forEach(({ from, to, decoration }) => builder.add(from, to, decoration));
                return builder.finish();
            }
        }, { decorations: (value) => value.decorations });

        return [highlightPlugin, commentTooltip];
    }
}
