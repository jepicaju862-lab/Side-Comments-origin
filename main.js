"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const obsidian_1 = require("obsidian");
const commentManager_1 = (() => {
    const exports = {};
    const module = { exports };
Object.defineProperty(exports, "__esModule", { value: true });
exports.CommentManager = void 0;
// Helper function to generate SHA256 hash (works on both desktop and mobile)
async function generateHash(text) {
    try {
        // Web Crypto API (works on mobile)
        const encoder = new TextEncoder();
        const data = encoder.encode(text);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }
    catch (error) {
        // Fallback to Node.js crypto for desktop
        try {
            const nodeCrypto = require('crypto');
            return nodeCrypto.createHash('sha256').update(text).digest('hex');
        }
        catch {
            // Simple fallback hash
            let hash = 0;
            for (let i = 0; i < text.length; i++) {
                const char = text.charCodeAt(i);
                hash = ((hash << 5) - hash) + char;
                hash = hash & hash;
            }
            return Math.abs(hash).toString(16);
        }
    }
}
class CommentManager {
    constructor(comments) {
        this.MIN_TEXT_LENGTH = 3;
        this.comments = comments;
    }
    getCommentsForFile(filePath) {
        return this.comments.filter(comment => comment.filePath === filePath);
    }
    async addComment(newComment) {
        // Generate hash if not present
        if (!newComment.selectedTextHash) {
            newComment.selectedTextHash = await generateHash(newComment.selectedText);
        }
        this.comments.push(newComment);
    }
    editComment(timestamp, newCommentText, newColor) {
        const commentToEdit = this.comments.find(comment => comment.timestamp === timestamp);
        if (commentToEdit) {
            commentToEdit.comment = newCommentText;
            if (newColor)
                commentToEdit.color = newColor;
        }
    }
    deleteComment(timestamp) {
        const indexToDelete = this.comments.findIndex(comment => comment.timestamp === timestamp);
        if (indexToDelete > -1) {
            this.comments.splice(indexToDelete, 1);
        }
    }
    deleteOrphanedComments() {
        const initialLength = this.comments.length;
        for (let i = this.comments.length - 1; i >= 0; i--) {
            if (this.comments[i].isOrphaned) {
                this.comments.splice(i, 1);
            }
        }
        return initialLength - this.comments.length;
    }
    getOrphanedComments() {
        return this.comments.filter(comment => comment.isOrphaned);
    }
    getOrphanedCommentCount() {
        return this.comments.filter(comment => comment.isOrphaned).length;
    }
    renameFile(oldPath, newPath) {
        this.comments.forEach(comment => {
            if (comment.filePath === oldPath) {
                comment.filePath = newPath;
            }
        });
    }
    updateComments(newComments) {
        this.comments = newComments;
    }
    getComments() {
        return this.comments;
    }
    // --- 核心定位逻辑重构 ---
    /**
     * 将绝对索引转换为行号和列号
     */
    getPositionFromIndex(content, index) {
        // 边界检查
        if (index < 0)
            return { line: 0, ch: 0 };
        if (index > content.length)
            index = content.length;
        const textBefore = content.substring(0, index);
        const lines = textBefore.split('\n');
        const line = lines.length - 1;
        const ch = lines[lines.length - 1].length;
        return { line, ch };
    }
    /**
     * 根据行号和列号估算在当前文档中的绝对索引位置
     * 用于在有多个匹配项时，找到离原位置最近的那个
     */
    getApproximateIndex(content, line, char) {
        const lines = content.split('\n');
        let index = 0;
        // 累加前 n 行的长度
        for (let i = 0; i < Math.min(line, lines.length); i++) {
            index += lines[i].length + 1; // +1 for newline character
        }
        return index + char;
    }
    /**
     * 更新评论坐标的核心方法
     * 新策略：
     * 1. 优先信任 absoluteFrom/absoluteTo，并校验当前位置文字。
     * 2. 在相同标题块内找候选，降低重复文字跨章节误匹配。
     * 3. 对所有候选做综合评分：文本、上下文、标题路径、旧位置、重复序号。
     * 4. 分数不足或第一、第二候选差距过小时，标记为孤儿，避免错误高亮。
     */
    async updateCommentCoordinatesForFile(fileContent, filePath) {
        const fileComments = this.comments.filter(comment => comment.filePath === filePath);
        for (const comment of fileComments) {
            const selectedText = comment.selectedText || "";
            if (!selectedText) {
                comment.isOrphaned = true;
                continue;
            }
            // 策略 1：绝对 offset 仍有效时，直接使用。
            if (this.isOffsetMatch(fileContent, comment)) {
                this.applyMatch(comment, fileContent, comment.absoluteFrom, selectedText);
                continue;
            }
            const estimatedOldIndex = typeof comment.absoluteFrom === "number"
                ? comment.absoluteFrom
                : this.getApproximateIndex(fileContent, comment.startLine, comment.startChar);
            const scope = this.getSearchScope(fileContent, comment);
            const candidates = this.collectCandidates(fileContent, comment, scope);
            if (candidates.length === 0) {
                comment.isOrphaned = true;
                continue;
            }
            const scored = candidates
                .map(candidate => ({
                ...candidate,
                score: this.scoreCandidate(fileContent, candidate.index, candidate.text, comment, estimatedOldIndex)
            }))
                .sort((a, b) => b.score - a.score);
            const best = scored[0];
            const second = scored[1];
            const hasRepeatedText = this.countOccurrences(fileContent, selectedText) > 1;
            const clearWinner = !second || best.score - second.score >= (hasRepeatedText ? 12 : 6);
            const scoreEnough = best.score >= (hasRepeatedText ? 82 : 62);
            if (scoreEnough && clearWinner) {
                this.applyMatch(comment, fileContent, best.index, best.text);
            }
            else {
                comment.isOrphaned = true;
            }
        }
    }
    isOffsetMatch(content, comment) {
        if (typeof comment.absoluteFrom !== "number" || typeof comment.absoluteTo !== "number")
            return false;
        if (comment.absoluteFrom < 0 || comment.absoluteTo > content.length || comment.absoluteFrom >= comment.absoluteTo)
            return false;
        return content.slice(comment.absoluteFrom, comment.absoluteTo) === comment.selectedText;
    }
    applyMatch(comment, content, index, text) {
        const newStart = this.getPositionFromIndex(content, index);
        const newEnd = this.getPositionFromIndex(content, index + text.length);
        comment.startLine = newStart.line;
        comment.startChar = newStart.ch;
        comment.endLine = newEnd.line;
        comment.endChar = newEnd.ch;
        comment.absoluteFrom = index;
        comment.absoluteTo = index + text.length;
        comment.selectedText = text;
        comment.isOrphaned = false;
        // Hash 在模糊上下文恢复后异步更新不方便，这里保留旧 hash；下一次 add/migrate 会补齐。
    }
    collectCandidates(content, comment, scope) {
        const candidates = new Map();
        const selectedText = comment.selectedText || "";
        // 1. 精确文本候选：优先且最安全。
        let searchPos = scope.start;
        while (selectedText && searchPos <= scope.end) {
            const found = content.indexOf(selectedText, searchPos);
            if (found === -1 || found + selectedText.length > scope.end)
                break;
            candidates.set(found, { index: found, text: selectedText, source: "exact" });
            searchPos = found + 1;
        }
        // 2. 上下文候选：用于选中文本轻微变化后的恢复，但限制最大跨度避免跨段误吸。
        if (comment.contextBefore && comment.contextAfter) {
            const beforeSnippet = comment.contextBefore.slice(-40);
            const afterSnippet = comment.contextAfter.slice(0, 40);
            if (beforeSnippet && afterSnippet) {
                const escapedBefore = this.escapeRegExp(beforeSnippet);
                const escapedAfter = this.escapeRegExp(afterSnippet);
                const maxMiddle = Math.max(selectedText.length + 120, 160);
                const regex = new RegExp(`${escapedBefore}([\\s\\S]{0,${maxMiddle}}?)${escapedAfter}`, "g");
                const scopedText = content.slice(scope.start, scope.end);
                for (const match of scopedText.matchAll(regex)) {
                    if (match.index === undefined || match[1] === undefined)
                        continue;
                    const whole = match[0];
                    const middle = match[1];
                    const localMiddleStart = match.index + whole.indexOf(middle);
                    const index = scope.start + localMiddleStart;
                    if (!candidates.has(index)) {
                        candidates.set(index, { index, text: middle, source: "context" });
                    }
                }
            }
        }
        return [...candidates.values()];
    }
    scoreCandidate(content, index, text, comment, estimatedOldIndex) {
        let score = 0;
        const selectedText = comment.selectedText || "";
        if (text === selectedText)
            score += 55;
        else
            score += this.similarity(text, selectedText) * 35;
        const beforeNow = content.slice(Math.max(0, index - 60), index);
        const afterNow = content.slice(index + text.length, Math.min(content.length, index + text.length + 60));
        if (comment.contextBefore) {
            score += this.similarity(comment.contextBefore.slice(-60), beforeNow) * 28;
        }
        if (comment.contextAfter) {
            score += this.similarity(comment.contextAfter.slice(0, 60), afterNow) * 28;
        }
        if (comment.headingPath?.length) {
            const position = this.getPositionFromIndex(content, index);
            const currentHeadingPath = this.getHeadingPath(content, position.line);
            if (this.sameStringArray(currentHeadingPath, comment.headingPath))
                score += 20;
            else
                score += this.headingPathSimilarity(currentHeadingPath, comment.headingPath) * 10;
        }
        if (typeof comment.occurrenceIndex === "number" && selectedText) {
            const occurrence = this.getOccurrenceIndex(content, selectedText, index);
            if (occurrence === comment.occurrenceIndex)
                score += 16;
            else if (occurrence >= 0)
                score += Math.max(0, 8 - Math.abs(occurrence - comment.occurrenceIndex) * 3);
        }
        const distance = Math.abs(index - estimatedOldIndex);
        score += Math.max(0, 18 - distance / 120);
        return score;
    }
    getSearchScope(content, comment) {
        if (!comment.headingPath?.length)
            return { start: 0, end: content.length };
        const range = this.findHeadingRange(content, comment.headingPath);
        return range || { start: 0, end: content.length };
    }
    findHeadingRange(content, headingPath) {
        const lines = content.split("\n");
        let offset = 0;
        let startLine = -1;
        let startOffset = -1;
        let level = -1;
        for (let i = 0; i < lines.length; i++) {
            const match = lines[i].match(/^(#{1,6})\s+(.*)$/);
            if (match) {
                const path = this.getHeadingPath(content, i);
                if (this.sameStringArray(path, headingPath)) {
                    startLine = i;
                    startOffset = offset;
                    level = match[1].length;
                    break;
                }
            }
            offset += lines[i].length + 1;
        }
        if (startLine < 0)
            return null;
        let endOffset = content.length;
        offset = 0;
        for (let i = 0; i < lines.length; i++) {
            if (i <= startLine) {
                offset += lines[i].length + 1;
                continue;
            }
            const match = lines[i].match(/^(#{1,6})\s+(.*)$/);
            if (match && match[1].length <= level) {
                endOffset = offset;
                break;
            }
            offset += lines[i].length + 1;
        }
        return { start: startOffset, end: endOffset };
    }
    getHeadingPath(content, line) {
        const lines = content.split("\n");
        const stack = [];
        for (let i = 0; i <= Math.min(line, lines.length - 1); i++) {
            const match = lines[i].match(/^(#{1,6})\s+(.*)$/);
            if (!match)
                continue;
            const level = match[1].length;
            const text = match[2].trim();
            while (stack.length && stack[stack.length - 1].level >= level)
                stack.pop();
            stack.push({ level, text });
        }
        return stack.map(item => item.text);
    }
    getOccurrenceIndex(content, selectedText, targetIndex) {
        if (!selectedText)
            return -1;
        let count = 0;
        let searchPos = 0;
        while (true) {
            const found = content.indexOf(selectedText, searchPos);
            if (found === -1)
                return -1;
            if (found === targetIndex)
                return count;
            count++;
            searchPos = found + 1;
        }
    }
    countOccurrences(content, selectedText) {
        if (!selectedText)
            return 0;
        let count = 0;
        let searchPos = 0;
        while (true) {
            const found = content.indexOf(selectedText, searchPos);
            if (found === -1)
                break;
            count++;
            searchPos = found + 1;
        }
        return count;
    }
    similarity(a, b) {
        if (a === b)
            return 1;
        if (!a || !b)
            return 0;
        const bigrams = (text) => {
            const normalized = text.replace(/\s+/g, " ").trim();
            const set = new Set();
            for (let i = 0; i < normalized.length - 1; i++)
                set.add(normalized.slice(i, i + 2));
            if (set.size === 0 && normalized)
                set.add(normalized);
            return set;
        };
        const aSet = bigrams(a);
        const bSet = bigrams(b);
        if (aSet.size === 0 || bSet.size === 0)
            return 0;
        let intersection = 0;
        aSet.forEach(item => { if (bSet.has(item))
            intersection++; });
        return (2 * intersection) / (aSet.size + bSet.size);
    }
    headingPathSimilarity(a, b) {
        if (this.sameStringArray(a, b))
            return 1;
        const max = Math.max(a.length, b.length);
        if (max === 0)
            return 0;
        let same = 0;
        for (let i = 0; i < Math.min(a.length, b.length); i++) {
            if (a[i] === b[i])
                same++;
        }
        return same / max;
    }
    sameStringArray(a, b) {
        return a.length === b.length && a.every((item, index) => item === b[index]);
    }
    escapeRegExp(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
}
exports.CommentManager = CommentManager;

    return module.exports;
})();
const view_1 = require("@codemirror/view");
const state_1 = require("@codemirror/state");
// --- Helper Functions ---
// Helper function to generate SHA256 hash
async function generateHash(text) {
    try {
        const encoder = new TextEncoder();
        const data = encoder.encode(text);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }
    catch (error) {
        try {
            const nodeCrypto = require('crypto');
            return nodeCrypto.createHash('sha256').update(text).digest('hex');
        }
        catch {
            let hash = 0;
            for (let i = 0; i < text.length; i++) {
                const char = text.charCodeAt(i);
                hash = ((hash << 5) - hash) + char;
                hash = hash & hash;
            }
            return Math.abs(hash).toString(16);
        }
    }
}
async function generateBinaryHash(buffer) {
    try {
        const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }
    catch (error) {
        const nodeCrypto = require('crypto');
        return nodeCrypto.createHash('sha256').update(Buffer.from(buffer)).digest('hex');
    }
}
const forceUpdateEffect = state_1.StateEffect.define();
const DEFAULT_SETTINGS = {
    commentSortOrder: "position",
    showHighlights: true,
    markdownFolder: "side-note-comments",
    attachmentFolder: "side-note-attachments",
    highlightColor: "#FFC800",
    highlightOpacity: 0.2,
    enableSelectionToolbar: true,
    commentsDataFolder: "side-note-data",
    annotationOutputFolder: "20_Notes/Annotations",
};
const DEFAULT_SOURCE_TYPE = "other";
const FALLBACK_CATEGORY = "待分类";
const CONTROLLED_BLOCK_START = "<!-- side-comments-sync:start -->";
const CONTROLLED_BLOCK_END = "<!-- side-comments-sync:end -->";
const BACKLINK_SECTION_HEADING = "## Side Comments 回链";
const COLOR_CATEGORY_MAP = {
    "#f59e0b": "背景和问题",
    "#ffc800": "背景和问题",
    "#ffd166": "背景和问题",
    "#10b981": "方法、技术及参数",
    "#06d6a0": "方法、技术及参数",
    "#3b82f6": "结果",
    "#118ab2": "结果",
    "#ec4899": "结论、创新与优点",
    "#ef476f": "结论、创新与优点",
    "#8b5cf6": "不足和展望",
    "#8d99ae": "不足和展望",
};
const SHORTCUT_COMMANDS = [
    { label: "加粗", commandName: "为选中内容添加加粗" },
    { label: "高亮", commandName: "为选中内容添加高亮" },
    { label: "批注", commandName: "为选中内容添加批注 (弹出输入框)" },
    { label: "下划线", commandName: "为选中内容添加下划线" },
];
// --- View Class ---
class SideNoteView extends obsidian_1.ItemView {
    constructor(leaf, plugin, file = null) {
        super(leaf);
        this.file = null;
        this.activeCommentTimestamp = null;
        this.searchQuery = "";
        this.allCollapsed = false;
        // 新增：用于记录重绘前的滚动位置
        this.lastScrollTop = 0;
        this.plugin = plugin;
        this.file = file;
    }
    getViewType() { return "sidenote-view"; }
    getDisplayText() { return "Side Note"; }
    getIcon() { return "message-square"; }
    async onOpen() {
        await Promise.resolve();
        if (!this.file) {
            this.file = this.app.workspace.getActiveFile();
        }
        this.renderView();
    }
    async setState(state, result) {
        if (state.filePath) {
            const file = this.app.vault.getAbstractFileByPath(state.filePath);
            if (file instanceof obsidian_1.TFile) {
                this.file = file;
                this.renderView();
            }
        }
        await super.setState(state, result);
    }
    updateActiveFile(file) {
        this.file = file;
        this.renderView();
    }
    highlightComment(timestamp) {
        this.activeCommentTimestamp = timestamp;
        this.renderView();
        setTimeout(() => {
            const commentEl = this.containerEl.querySelector(`[data-comment-timestamp="${timestamp}"]`);
            if (commentEl) {
                // 修改点 1：改为 'nearest'，避免强制跳到中间
                commentEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        }, 100);
    }
    renderView() {
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
            placeholder: "Search comments..."
        });
        searchInput.value = this.searchQuery;
        searchInput.oninput = (e) => {
            const target = e.target;
            this.searchQuery = target.value.toLowerCase();
            this.renderCommentsList(commentsContainer);
        };
        const exportBtn = toolbar.createEl("button", { cls: "clickable-icon" });
        exportBtn.setAttribute("aria-label", "Export to Markdown");
        (0, obsidian_1.setIcon)(exportBtn, "file-up");
        exportBtn.onclick = async () => { await this.exportCommentsToMarkdown(); };
        const syncBtn = toolbar.createEl("button", { cls: "clickable-icon" });
        syncBtn.setAttribute("aria-label", "Sync current file comments to annotations");
        (0, obsidian_1.setIcon)(syncBtn, "refresh-cw");
        syncBtn.onclick = async () => {
            if (!this.file) {
                new obsidian_1.Notice("No file selected.");
                return;
            }
            await this.plugin.syncCommentsToAnnotationsForFile(this.file);
        };
        const sortBtn = toolbar.createEl("button", { cls: "clickable-icon" });
        sortBtn.setAttribute("aria-label", this.plugin.settings.commentSortOrder === "position" ? "Sort by Time" : "Sort by Position");
        (0, obsidian_1.setIcon)(sortBtn, this.plugin.settings.commentSortOrder === "position" ? "arrow-down-narrow-wide" : "clock");
        sortBtn.onclick = async () => {
            this.plugin.settings.commentSortOrder = this.plugin.settings.commentSortOrder === "position" ? "timestamp" : "position";
            await this.plugin.saveData();
            (0, obsidian_1.setIcon)(sortBtn, this.plugin.settings.commentSortOrder === "position" ? "arrow-down-narrow-wide" : "clock");
            sortBtn.setAttribute("aria-label", this.plugin.settings.commentSortOrder === "position" ? "Sort by Time" : "Sort by Position");
            this.renderCommentsList(commentsContainer);
        };
        const collapseBtn = toolbar.createEl("button", { cls: "clickable-icon" });
        collapseBtn.setAttribute("aria-label", this.allCollapsed ? "Expand All" : "Collapse All");
        (0, obsidian_1.setIcon)(collapseBtn, this.allCollapsed ? "chevrons-up-down" : "chevrons-down-up");
        collapseBtn.onclick = () => {
            this.allCollapsed = !this.allCollapsed;
            (0, obsidian_1.setIcon)(collapseBtn, this.allCollapsed ? "chevrons-up-down" : "chevrons-down-up");
            collapseBtn.setAttribute("aria-label", this.allCollapsed ? "Expand All" : "Collapse All");
            const contentEls = this.containerEl.querySelectorAll(".sidenote-comment-content");
            contentEls.forEach(el => el.classList.toggle("collapsed", this.allCollapsed));
        };
        const commentsContainer = this.containerEl.createDiv("sidenote-comments-list-wrapper");
        this.renderCommentsList(commentsContainer);
        // 修改点 3：渲染后恢复滚动位置
        if (this.lastScrollTop > 0) {
            // 使用 setTimeout 确保 DOM 渲染完成
            setTimeout(() => {
                commentsContainer.scrollTop = this.lastScrollTop;
            }, 0);
        }
    }
    async exportCommentsToMarkdown() {
        // ... (保持不变) ...
        if (!this.file) {
            new obsidian_1.Notice("No file selected.");
            return;
        }
        const comments = this.plugin.commentManager.getCommentsForFile(this.file.path);
        if (comments.length === 0) {
            new obsidian_1.Notice("No comments to export.");
            return;
        }
        const sortedComments = [...comments].sort((a, b) => {
            if (a.startLine === b.startLine)
                return a.startChar - b.startChar;
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
            new obsidian_1.Notice(`Exported to ${filename}`);
        }
        catch (error) {
            new obsidian_1.Notice("Error exporting file.");
        }
    }
    renderCommentsList(container) {
        container.empty();
        if (!this.file) {
            container.createDiv("sidenote-empty-state").createEl("p", { text: "No file selected." });
            return;
        }
        let commentsForFile = this.plugin.commentManager.getCommentsForFile(this.file.path);
        if (this.searchQuery) {
            commentsForFile = commentsForFile.filter(c => (c.comment && c.comment.toLowerCase().includes(this.searchQuery)) ||
                (c.selectedText && c.selectedText.toLowerCase().includes(this.searchQuery)));
        }
        if (this.plugin.settings.commentSortOrder === "position") {
            commentsForFile.sort((a, b) => {
                if (a.startLine === b.startLine)
                    return a.startChar - b.startChar;
                return a.startLine - b.startLine;
            });
        }
        else {
            commentsForFile.sort((a, b) => a.timestamp - b.timestamp);
        }
        if (commentsForFile.length > 0) {
            const listEl = container.createDiv("sidenote-comments-container");
            commentsForFile.forEach(async (comment) => {
                const commentEl = listEl.createDiv("sidenote-comment-item");
                commentEl.setAttribute("data-comment-timestamp", comment.timestamp.toString());
                if (this.activeCommentTimestamp === comment.timestamp) {
                    commentEl.addClass("active");
                }
                if (comment.color) {
                    const rgb = this.plugin.hexToRgb(comment.color);
                    const opacity = this.plugin.settings.highlightOpacity;
                    commentEl.style.setProperty('--sidenote-highlight-color', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${opacity})`);
                    commentEl.style.setProperty('--sidenote-highlight-border', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${Math.min(opacity + 0.4, 1)})`);
                    commentEl.style.setProperty('--interactive-accent', comment.color);
                    commentEl.style.setProperty('--interactive-accent-translucent', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.3)`);
                }
                const headerEl = commentEl.createDiv("sidenote-comment-header");
                const textInfoEl = headerEl.createDiv("sidenote-comment-text-info");
                const selectedTextEl = textInfoEl.createDiv({ cls: "sidenote-selected-text markdown-rendered" });
                await this.plugin.renderCommentContent(comment.selectedText || "", selectedTextEl, comment.filePath);
                this.setupExpandableText(selectedTextEl);
                textInfoEl.createEl("small", { text: new Date(comment.timestamp).toLocaleString(), cls: "sidenote-timestamp" });
                const actionsEl = headerEl.createDiv("sidenote-comment-actions");
                commentEl.onclick = async () => {
                    this.activeCommentTimestamp = comment.timestamp;
                    const container = this.containerEl.querySelector('.sidenote-comments-list-wrapper');
                    if (!container)
                        return;
                    // 保存当前的滚动位置（防止点击导致的重绘让列表跳动）
                    this.lastScrollTop = container.parentElement?.scrollTop || 0;
                    container.querySelectorAll('.sidenote-comment-item').forEach(el => el.removeClass('active'));
                    commentEl.addClass('active');
                    await this.jumpToComment(comment);
                };
                commentEl.ondblclick = (e) => {
                    e.stopPropagation();
                    new CommentModal(this.plugin.app, this.plugin, { mode: 'edit', comment: comment }).open();
                };
                const contentWrapper = commentEl.createDiv({ cls: `sidenote-comment-content markdown-rendered${this.allCollapsed ? ' collapsed' : ''}` });
                await this.plugin.renderCommentContent(comment.comment || "", contentWrapper, comment.filePath);
                this.setupExpandableText(contentWrapper);
                const menuButton = actionsEl.createEl("button", { cls: "sidenote-menu-button clickable-icon" });
                (0, obsidian_1.setIcon)(menuButton, "more-vertical");
                const menuContainer = actionsEl.createDiv("sidenote-action-menu");
                const editOption = menuContainer.createEl("button", { text: "编辑批注", cls: "sidenote-menu-option" });
                editOption.onclick = (e) => {
                    e.stopPropagation();
                    menuContainer.classList.remove("visible");
                    new CommentModal(this.app, this.plugin, { mode: 'edit', comment: comment }).open();
                };
                const copyOption = menuContainer.createEl("button", { text: "复制回链", cls: "sidenote-menu-option" });
                copyOption.onclick = (e) => {
                    e.stopPropagation();
                    menuContainer.classList.remove("visible");
                    this.plugin.copyBacklink(comment);
                };
                const searchOption = menuContainer.createEl("button", { text: "在库中搜索", cls: "sidenote-menu-option" });
                searchOption.onclick = (e) => {
                    e.stopPropagation();
                    menuContainer.classList.remove("visible");
                    this.app.internalPlugins.getPluginById('global-search').instance.openGlobalSearch(comment.selectedText);
                };
                const deleteOption = menuContainer.createEl("button", { text: "删除批注", cls: "sidenote-menu-option sidenote-menu-delete" });
                deleteOption.onclick = (e) => {
                    e.stopPropagation();
                    menuContainer.classList.remove("visible");
                    this.plugin.deleteComment(comment.timestamp);
                };
                menuButton.onclick = (e) => {
                    e.stopPropagation();
                    document.querySelectorAll('.sidenote-action-menu.visible').forEach(el => {
                        if (el !== menuContainer)
                            el.classList.remove('visible');
                    });
                    menuContainer.classList.toggle("visible");
                };
                document.addEventListener("click", (e) => {
                    if (!menuButton.contains(e.target))
                        menuContainer.classList.remove("visible");
                }, { once: true, capture: true });
            });
        }
        else {
            const emptyStateEl = container.createDiv("sidenote-empty-state");
            emptyStateEl.createEl("p", { text: this.searchQuery ? "No comments match your search." : "No comments for this file yet." });
        }
    }
    setupExpandableText(el) {
        setTimeout(() => {
            if (el.scrollHeight > el.clientHeight + 2) {
                el.addClass('is-truncated');
                el.onclick = (e) => {
                    e.stopPropagation();
                    if (el.hasClass('expanded')) {
                        el.removeClass('expanded');
                        el.addClass('is-truncated');
                    }
                    else {
                        el.addClass('expanded');
                        el.removeClass('is-truncated');
                    }
                };
            }
        }, 50);
    }
    renderComments() { this.renderView(); }
    async jumpToComment(comment) {
        // ... (保持不变) ...
        let targetLeaf = null;
        this.app.workspace.iterateAllLeaves((leaf) => {
            if (leaf.view instanceof obsidian_1.MarkdownView && leaf.view.file?.path === comment.filePath) {
                targetLeaf = leaf;
                return false;
            }
        });
        if (!targetLeaf) {
            const file = this.app.vault.getAbstractFileByPath(comment.filePath);
            if (file instanceof obsidian_1.TFile) {
                const newLeaf = this.app.workspace.getLeaf(true);
                await newLeaf.openFile(file);
                targetLeaf = newLeaf;
            }
        }
        if (targetLeaf && targetLeaf.view instanceof obsidian_1.MarkdownView) {
            this.app.workspace.setActiveLeaf(targetLeaf, { focus: true });
            if (obsidian_1.Platform.isMobile) {
                // @ts-ignore
                this.app.workspace.leftSplit?.collapse();
                // @ts-ignore
                this.app.workspace.rightSplit?.collapse();
                await new Promise(resolve => setTimeout(resolve, 350));
            }
            const editor = targetLeaf.view.editor;
            const fileContent = editor.getValue();
            await this.plugin.commentManager.updateCommentCoordinatesForFile(fileContent, comment.filePath);
            await this.plugin.saveCommentsForSingleFile(comment.filePath);
            const updatedComment = this.plugin.comments.find(c => c.timestamp === comment.timestamp);
            if (!updatedComment || updatedComment.isOrphaned) {
                new obsidian_1.Notice("Comment text not found in document.");
                return;
            }
            editor.focus();
            editor.setSelection({ line: updatedComment.startLine, ch: updatedComment.startChar }, { line: updatedComment.endLine, ch: updatedComment.endChar });
            editor.scrollIntoView({ from: { line: updatedComment.startLine, ch: 0 }, to: { line: updatedComment.endLine, ch: 0 } }, true);
        }
    }
    getState() { return { filePath: this.file ? this.file.path : null }; }
    onunload() { }
}
async function switchToSideNoteView(app) {
    const activeFile = app.workspace.getActiveFile();
    if (!activeFile) {
        new obsidian_1.Notice("No active Markdown file found.");
        return;
    }
    let leaf = app.workspace.getLeaf('split', 'vertical');
    if (leaf) {
        await leaf.setViewState({ type: "sidenote-view", state: { filePath: activeFile.path }, active: true });
        void app.workspace.revealLeaf(leaf);
    }
}
// --- Comment Modal ---
class CommentModal extends obsidian_1.Modal {
    constructor(app, plugin, options) {
        super(app);
        this.textareaEl = null;
        this.plugin = plugin;
        this.mode = options.mode;
        if (this.mode === 'edit' && options.comment) {
            this.comment = options.comment;
            this.selectedText = this.comment.selectedText || "";
            this.filePath = this.comment.filePath;
            this.colorInput = this.comment.color || plugin.settings.highlightColor || "#FFC800";
            this.commentText = this.comment.comment || "";
        }
        else {
            this.comment = null;
            this.selectedText = options.selectedText || "";
            this.filePath = options.filePath || "";
            this.colorInput = options.initialColor || plugin.settings.highlightColor || "#FFC800";
            this.commentText = "";
            this.onSubmitAdd = options.onSubmitAdd;
        }
    }
    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass("sidenote-edit-modal");
        const header = contentEl.createDiv("sidenote-edit-modal-header");
        header.createEl("h2", { text: this.mode === 'edit' ? "原文批注" : "添加批注" });
        header.createEl("p", { text: this.mode === 'edit' ? "编辑批注内容，并同步高亮与卡片" : "写下你的想法，支持粘贴图片", cls: "sidenote-edit-modal-subtitle" });
        const selectedBox = contentEl.createDiv("sidenote-edit-modal-selected");
        this.plugin.renderCommentContent(this.selectedText, selectedBox, this.filePath);
        const textareaBox = contentEl.createDiv("sidenote-edit-modal-textarea-box");
        const textarea = textareaBox.createEl("textarea", { cls: "sidenote-edit-modal-textarea" });
        textarea.placeholder = "写下批注、理解或疑问... (支持粘贴图片)";
        textarea.value = this.commentText;
        this.textareaEl = textarea;
        textarea.oninput = (e) => {
            this.commentText = e.target.value;
        };
        textarea.addEventListener('paste', this.handlePaste.bind(this));
        textarea.addEventListener('keydown', (e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                this.submitForm();
            }
        });
        const footer = contentEl.createDiv("sidenote-edit-modal-footer");
        // Colors
        const colorsWrapper = footer.createDiv("sidenote-edit-modal-colors");
        const presetColors = [
            { name: 'Purple', value: '#8b5cf6' },
            { name: 'Pink', value: '#ec4899' },
            { name: 'Blue', value: '#3b82f6' },
            { name: 'Green', value: '#10b981' },
            { name: 'Yellow', value: '#f59e0b' }
        ];
        let activeCircle = null;
        const updateActiveCircle = (circle) => {
            if (activeCircle)
                activeCircle.classList.remove('active');
            if (circle)
                circle.classList.add('active');
            activeCircle = circle;
        };
        const colorPicker = document.createElement('input');
        colorPicker.type = 'color';
        colorPicker.className = 'sidenote-toolbar-color-picker';
        colorPicker.value = this.colorInput;
        presetColors.forEach(color => {
            const circle = document.createElement('div');
            circle.className = 'sidenote-color-circle';
            circle.style.setProperty('--circle-color', color.value);
            circle.title = color.name;
            if (colorPicker.value.toLowerCase() === color.value.toLowerCase()) {
                updateActiveCircle(circle);
            }
            circle.onclick = () => {
                colorPicker.value = color.value;
                this.colorInput = color.value;
                updateActiveCircle(circle);
            };
            colorsWrapper.appendChild(circle);
        });
        const customColorWrapper = document.createElement('div');
        customColorWrapper.className = 'sidenote-color-circle custom-color';
        customColorWrapper.title = 'Custom Color';
        colorPicker.onchange = () => {
            this.colorInput = colorPicker.value;
            const matchedPreset = Array.from(colorsWrapper.querySelectorAll('.sidenote-color-circle:not(.custom-color)')).find(c => {
                return c.style.getPropertyValue('--circle-color').toLowerCase() === colorPicker.value.toLowerCase();
            });
            if (matchedPreset) {
                updateActiveCircle(matchedPreset);
            }
            else {
                updateActiveCircle(customColorWrapper);
            }
        };
        customColorWrapper.appendChild(colorPicker);
        colorsWrapper.appendChild(customColorWrapper);
        // Actions
        const actionsWrapper = footer.createDiv("sidenote-edit-modal-actions");
        if (this.mode === 'edit' && this.comment) {
            const copyBtn = actionsWrapper.createEl("button", { cls: "sidenote-icon-btn", title: "复制回链" });
            (0, obsidian_1.setIcon)(copyBtn, "copy");
            copyBtn.onclick = () => {
                this.plugin.copyBacklink(this.comment);
            };
            const deleteBtn = actionsWrapper.createEl("button", { cls: "sidenote-icon-btn sidenote-btn-danger", title: "删除" });
            (0, obsidian_1.setIcon)(deleteBtn, "trash");
            deleteBtn.onclick = async () => {
                if (this.comment) {
                    this.plugin.commentManager.deleteComment(this.comment.timestamp);
                    await this.plugin.saveData();
                    this.plugin.refreshViews();
                    this.close();
                    new obsidian_1.Notice("批注已删除");
                }
            };
        }
        const updateBtn = actionsWrapper.createEl("button", { text: this.mode === 'edit' ? "更新" : "添加", cls: "sidenote-update-btn" });
        updateBtn.onclick = () => this.submitForm();
        this.onClose = () => {
            document.querySelectorAll('.sidenote-selection-toolbar').forEach(el => el.remove());
        };
        setTimeout(() => textarea.focus(), 50);
    }
    async submitForm() {
        if (this.mode === 'edit' && this.comment) {
            await this.plugin.editComment(this.comment.timestamp, this.commentText, this.colorInput);
        }
        else if (this.mode === 'add' && this.onSubmitAdd) {
            await this.onSubmitAdd(this.commentText, this.colorInput);
        }
        document.querySelectorAll('.sidenote-selection-toolbar').forEach(el => el.remove());
        this.close();
    }
    async handlePaste(e) {
        if (!e.clipboardData)
            return;
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
    async saveImageAndInsertLink(file) {
        if (!this.textareaEl)
            return;
        try {
            const arrayBuffer = await file.arrayBuffer();
            // @ts-ignore
            const binaryHash = await generateBinaryHash(arrayBuffer);
            let availablePath;
            if (this.plugin.imageHashes && this.plugin.imageHashes[binaryHash]) {
                const existingPath = this.plugin.imageHashes[binaryHash];
                const existingFile = this.app.vault.getAbstractFileByPath(existingPath);
                if (existingFile instanceof obsidian_1.TFile) {
                    availablePath = existingPath;
                    new obsidian_1.Notice("Reused existing image.");
                }
                else {
                    availablePath = await this.createNewImage(arrayBuffer, file.name);
                    this.plugin.imageHashes[binaryHash] = availablePath;
                    await this.plugin.saveData();
                }
            }
            else {
                availablePath = await this.createNewImage(arrayBuffer, file.name);
                if (!this.plugin.imageHashes)
                    this.plugin.imageHashes = {};
                this.plugin.imageHashes[binaryHash] = availablePath;
                await this.plugin.saveData();
            }
            const savedFile = this.app.vault.getAbstractFileByPath(availablePath);
            if (savedFile instanceof obsidian_1.TFile) {
                const sourcePath = this.filePath || '/';
                let markdownLink = this.app.fileManager.generateMarkdownLink(savedFile, sourcePath);
                if (!markdownLink.startsWith('!'))
                    markdownLink = '!' + markdownLink;
                const startPos = this.textareaEl.selectionStart;
                const endPos = this.textareaEl.selectionEnd;
                const text = this.textareaEl.value;
                this.textareaEl.value = text.substring(0, startPos) + markdownLink + text.substring(endPos);
                this.commentText = this.textareaEl.value;
                const newCursorPos = startPos + markdownLink.length;
                this.textareaEl.setSelectionRange(newCursorPos, newCursorPos);
                this.textareaEl.dispatchEvent(new Event('input'));
            }
        }
        catch (error) {
            console.error(error);
            new obsidian_1.Notice('Failed to save image.');
        }
    }
    async createNewImage(arrayBuffer, originalName) {
        const folderSetting = this.plugin.settings.attachmentFolder.trim() || "side-note-attachments";
        const folderPath = (0, obsidian_1.normalizePath)(folderSetting);
        const folder = this.app.vault.getAbstractFileByPath(folderPath);
        if (!folder)
            await this.app.vault.createFolder(folderPath);
        // @ts-ignore
        const dateStr = window.moment().format('YYYYMMDDHHmmss');
        const extension = originalName.split('.').pop() || 'png';
        const fileName = `Pasted image ${dateStr}.${extension}`;
        const targetPath = `${folderPath}/${fileName}`;
        const fileOrPath = await this.app.vault.createBinary(targetPath, arrayBuffer).catch(async () => {
            // @ts-ignore
            return await this.app.fileManager.getAvailablePathForAttachment(fileName, folderPath);
        });
        return fileOrPath instanceof obsidian_1.TFile ? fileOrPath.path : fileOrPath;
    }
}
// --- Setting Tab ---
class SideNoteSettingTab extends obsidian_1.PluginSettingTab {
    constructor(app, plugin) { super(app, plugin); }
    display() {
        const { containerEl } = this;
        containerEl.empty();
        new obsidian_1.Setting(containerEl).setName("Comment sort order").setDesc("Choose how comments are sorted.")
            .addDropdown((dropdown) => dropdown.addOption("timestamp", "By timestamp").addOption("position", "By position in file")
            .setValue(this.plugin.settings.commentSortOrder).onChange(async (value) => {
            this.plugin.settings.commentSortOrder = value;
            await this.plugin.saveData();
            this.plugin.refreshViews();
        }));
        new obsidian_1.Setting(containerEl).setName("Show highlights in editor").setDesc("Display highlights for commented text.")
            .addToggle((toggle) => toggle.setValue(this.plugin.settings.showHighlights).onChange(async (value) => {
            this.plugin.settings.showHighlights = value;
            await this.plugin.saveData();
            this.plugin.refreshEditorDecorations();
        }));
        new obsidian_1.Setting(containerEl).setName("Enable selection toolbar").setDesc("Show a quick action toolbar when text is selected.")
            .addToggle((toggle) => toggle.setValue(this.plugin.settings.enableSelectionToolbar).onChange(async (value) => {
            this.plugin.settings.enableSelectionToolbar = value;
            await this.plugin.saveData();
        }));
        containerEl.createEl("h3", { text: "快捷键设置" });
        containerEl.createEl("p", {
            text: "加粗、高亮、批注、下划线都已注册为 Obsidian 命令，可在 Obsidian 快捷键设置中自定义绑定。",
            cls: "setting-item-description"
        });
        SHORTCUT_COMMANDS.forEach((command) => {
            new obsidian_1.Setting(containerEl)
                .setName(command.label)
                .setDesc(`打开 Obsidian 快捷键设置并搜索：${command.commandName}`)
                .addButton((button) => button
                .setButtonText("设置快捷键")
                .onClick(() => this.plugin.openHotkeySettings(command.commandName)));
        });
        new obsidian_1.Setting(containerEl).setName("Highlight color").addColorPicker((colorPicker) => colorPicker.setValue(this.plugin.settings.highlightColor || "#FFC800").onChange(async (value) => {
            this.plugin.settings.highlightColor = value;
            await this.plugin.saveData();
            this.plugin.applyHighlightColor();
        }));
        new obsidian_1.Setting(containerEl).setName("Highlight opacity").addSlider((slider) => slider.setLimits(0, 1, 0.1).setValue(this.plugin.settings.highlightOpacity || 0.2).onChange(async (value) => {
            this.plugin.settings.highlightOpacity = value;
            await this.plugin.saveData();
            this.plugin.applyHighlightColor();
        }));
        new obsidian_1.Setting(containerEl).setName("Markdown comments folder").addText((text) => text.setPlaceholder("side-note-comments").setValue(this.plugin.settings.markdownFolder || "").onChange(async (value) => {
            this.plugin.settings.markdownFolder = value.trim() || "side-note-comments";
            await this.plugin.saveData();
        }));
        new obsidian_1.Setting(containerEl).setName("Attachments folder").addText((text) => text.setPlaceholder("side-note-attachments").setValue(this.plugin.settings.attachmentFolder || "").onChange(async (value) => {
            this.plugin.settings.attachmentFolder = value.trim() || "side-note-attachments";
            await this.plugin.saveData();
        }));
        new obsidian_1.Setting(containerEl).setName("Comments data folder").setDesc("Per-file comment data storage folder. Restart plugin after changing.").addText((text) => text.setPlaceholder("side-note-data").setValue(this.plugin.settings.commentsDataFolder || "").onChange(async (value) => {
            this.plugin.settings.commentsDataFolder = value.trim() || "side-note-data";
            await this.plugin.saveData();
        }));
        new obsidian_1.Setting(containerEl).setName("Annotation output folder").setDesc("Vault folder for annotation notes generated from Side Comments.").addText((text) => text.setPlaceholder("20_Notes/Annotations").setValue(this.plugin.settings.annotationOutputFolder || "").onChange(async (value) => {
            this.plugin.settings.annotationOutputFolder = value.trim() || DEFAULT_SETTINGS.annotationOutputFolder;
            await this.plugin.saveData();
        }));
        new obsidian_1.Setting(containerEl).setName("Create Markdown Backup").addButton((button) => button.setButtonText("Create Backup").onClick(async () => {
            await this.plugin.migrateInlineCommentsToMarkdown();
            new obsidian_1.Notice("Markdown backup created successfully!");
        }));
        new obsidian_1.Setting(containerEl).setName("Sync current file to annotations").addButton((button) => button.setButtonText("Sync Now").onClick(async () => {
            const activeFile = this.app.workspace.getActiveFile();
            if (!(activeFile instanceof obsidian_1.TFile) || activeFile.extension !== "md") {
                new obsidian_1.Notice("No active Markdown file found.");
                return;
            }
            await this.plugin.syncCommentsToAnnotationsForFile(activeFile);
        }));
        const orphanedCount = this.plugin.commentManager.getOrphanedCommentCount();
        new obsidian_1.Setting(containerEl).setName("Orphaned comments").setDesc(`There are ${orphanedCount} orphaned comment(s).`);
        new obsidian_1.Setting(containerEl).addButton((button) => button.setButtonText(`Delete ${orphanedCount} orphaned comment(s)`).setWarning().onClick(async () => {
            const deleted = this.plugin.commentManager.deleteOrphanedComments();
            await this.plugin.saveData();
            this.plugin.refreshViews();
            new obsidian_1.Notice(`Deleted ${deleted} orphaned comment(s)!`);
            this.display();
        }).setDisabled(orphanedCount === 0));
    }
}
// --- Main Plugin Class ---
class SideNote extends obsidian_1.Plugin {
    constructor() {
        super(...arguments);
        this.comments = [];
        this.imageHashes = {};
        this.orphanNoticeTimer = null;
        this.pendingOrphans = [];
        this.isSaving = false;
        this.editorViews = new Set();
        this.renderedTableHighlightTimers = [];
    }
    async renderCommentContent(markdown, container, sourcePath) {
        const component = new obsidian_1.Component();
        component.load();
        await obsidian_1.MarkdownRenderer.renderMarkdown(markdown, container, sourcePath, component);
        container.addEventListener("click", (e) => {
            const target = e.target;
            const link = target.closest("a");
            if (link) {
                e.stopPropagation();
                if (link.classList.contains("internal-link")) {
                    e.preventDefault();
                    const href = link.getAttribute("data-href");
                    if (href) {
                        const newLeaf = e.metaKey || e.ctrlKey;
                        this.app.workspace.openLinkText(href, sourcePath, newLeaf);
                    }
                }
            }
        });
        const embedRegex = /!\[\[([^\]|]+?)(\|[^\]]+?)?\]\]/g;
        let match;
        while ((match = embedRegex.exec(markdown)) !== null) {
            const filename = match[1];
            const file = this.app.metadataCache.getFirstLinkpathDest(filename, sourcePath);
            if (file instanceof obsidian_1.TFile) {
                const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
                let textNode;
                while ((textNode = walker.nextNode())) {
                    if (textNode.textContent?.includes(match[0])) {
                        const embedSpan = document.createElement('span');
                        embedSpan.className = 'internal-embed';
                        const img = document.createElement('img');
                        img.src = this.app.vault.getResourcePath(file);
                        img.alt = file.basename;
                        img.style.maxWidth = '100%';
                        img.style.display = 'block';
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
            if (embed instanceof HTMLElement && !embed.querySelector('img')) {
                const src = embed.getAttribute('src') || embed.getAttribute('alt') || embed.textContent?.replace(/^\[\[|\]\]$/g, '');
                if (src) {
                    const file = this.app.metadataCache.getFirstLinkpathDest(src, sourcePath);
                    if (file instanceof obsidian_1.TFile) {
                        embed.empty();
                        const img = embed.createEl('img');
                        img.src = this.app.vault.getResourcePath(file);
                        img.alt = file.basename;
                        img.style.maxWidth = '100%';
                        img.style.display = 'block';
                    }
                }
            }
        });
    }
    openHotkeySettings(searchText) {
        const setting = this.app.setting;
        if (!setting?.open) {
            new obsidian_1.Notice(`请在 Obsidian 设置 → 快捷键 中搜索“${searchText}”并绑定快捷键。`);
            return;
        }
        setting.open();
        setting.openTabById?.("hotkeys");
        window.setTimeout(() => {
            const searchInput = document.querySelector(".modal.mod-settings input[type='search'], " +
                ".modal.mod-settings input[placeholder*='Search'], " +
                ".modal.mod-settings input[placeholder*='搜索'], " +
                ".modal.mod-settings input");
            if (!searchInput) {
                new obsidian_1.Notice(`请搜索“${searchText}”并绑定快捷键。`);
                return;
            }
            searchInput.value = searchText;
            searchInput.dispatchEvent(new Event("input", { bubbles: true }));
            searchInput.focus();
        }, 120);
    }
    getFilePathForEditorView(view) {
        let containingFilePath = null;
        this.app.workspace.iterateAllLeaves((leaf) => {
            if (!(leaf.view instanceof obsidian_1.MarkdownView) || !leaf.view.file)
                return;
            const editor = leaf.view.editor;
            if (editor && editor.cm === view) {
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
    getSelectionContextFromOffsets(docText, from, to) {
        return {
            before: docText.substring(Math.max(0, from - 50), from),
            after: docText.substring(to, Math.min(docText.length, to + 50))
        };
    }
    getOccurrenceIndex(content, selectedText, targetIndex) {
        if (!selectedText)
            return -1;
        let count = 0;
        let searchPos = 0;
        while (true) {
            const found = content.indexOf(selectedText, searchPos);
            if (found === -1)
                return -1;
            if (found === targetIndex)
                return count;
            count++;
            searchPos = found + 1;
        }
    }
    getHeadingPath(content, line) {
        const lines = content.split("\n");
        const stack = [];
        for (let i = 0; i <= Math.min(line, lines.length - 1); i++) {
            const match = lines[i].match(/^(#{1,6})\s+(.*)$/);
            if (!match)
                continue;
            const level = match[1].length;
            const text = match[2].trim();
            while (stack.length && stack[stack.length - 1].level >= level)
                stack.pop();
            stack.push({ level, text });
        }
        return stack.map(item => item.text);
    }
    updateLineCharsFromOffsets(comment, doc, from, to) {
        const startLine = doc.lineAt(from);
        const endLine = doc.lineAt(to);
        comment.startLine = startLine.number - 1;
        comment.startChar = from - startLine.from;
        comment.endLine = endLine.number - 1;
        comment.endChar = to - endLine.from;
        comment.absoluteFrom = from;
        comment.absoluteTo = to;
    }
    mapCommentPositionsFromView(update) {
        const filePath = this.getFilePathForEditorView(update.view);
        if (!filePath || !update.docChanged)
            return;
        const comments = this.commentManager.getCommentsForFile(filePath);
        comments.forEach(comment => {
            if (typeof comment.absoluteFrom !== "number" || typeof comment.absoluteTo !== "number")
                return;
            const mappedFrom = update.changes.mapPos(comment.absoluteFrom, -1);
            const mappedTo = update.changes.mapPos(comment.absoluteTo, 1);
            if (mappedFrom < 0 || mappedTo > update.state.doc.length || mappedFrom >= mappedTo)
                return;
            const actualText = update.state.doc.sliceString(mappedFrom, mappedTo);
            if (actualText === comment.selectedText) {
                this.updateLineCharsFromOffsets(comment, update.state.doc, mappedFrom, mappedTo);
                comment.isOrphaned = false;
            }
        });
    }
    async handleAddCommentFromEditorView(editorView, markType, initialColor, skipModal = false) {
        const selection = editorView.state.selection.main;
        if (selection.empty || selection.to <= selection.from) {
            new obsidian_1.Notice("Please select some text to add a comment.");
            return;
        }
        const filePath = this.getFilePathForEditorView(editorView);
        if (!filePath) {
            new obsidian_1.Notice("No active Markdown file found.");
            return;
        }
        const doc = editorView.state.doc;
        const selectedText = doc.sliceString(selection.from, selection.to);
        if (!selectedText.trim()) {
            new obsidian_1.Notice("Please select some text to add a comment.");
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
        const createComment = async (commentText, color) => {
            const newComment = {
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
                color
            };
            await this.addComment(newComment);
            editorView.dispatch({ effects: [forceUpdateEffect.of(null)] });
            document.querySelectorAll('.sidenote-selection-toolbar').forEach(el => el.remove());
        };
        if (skipModal) {
            await createComment("", initialColor || "");
            return;
        }
        new CommentModal(this.app, this, {
            mode: 'add',
            selectedText,
            filePath,
            initialColor: initialColor || "",
            onSubmitAdd: async (commentText, color) => {
                await createComment(commentText, color);
            }
        }).open();
    }
    getEditorTextForFile(filePath) {
        let text = null;
        this.app.workspace.iterateAllLeaves((leaf) => {
            if (leaf.view instanceof obsidian_1.MarkdownView && leaf.view.file?.path === filePath) {
                text = leaf.view.editor.getValue();
                return false;
            }
        });
        return text;
    }
    isMarkdownTableDelimiter(line) {
        const trimmed = line.trim();
        if (!trimmed.includes("|"))
            return false;
        return /^:?-{3,}:?$/.test(trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|")[0]?.trim() || "") &&
            trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|").every(part => /^:?-{3,}:?$/.test(part.trim()));
    }
    getMarkdownTableBlocks(docText) {
        const lines = docText.split("\n");
        const blocks = [];
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
    parseMarkdownTableRow(line) {
        const cells = [];
        let cellStart = line.startsWith("|") ? 1 : 0;
        for (let i = cellStart; i <= line.length; i++) {
            const isDelimiter = i === line.length || (line[i] === "|" && line[i - 1] !== "\\");
            if (!isDelimiter)
                continue;
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
        if (line.endsWith("|"))
            cells.pop();
        return cells;
    }
    getSourceLineForTableRow(block, renderedRowIndex) {
        return renderedRowIndex === 0 ? block.startLine : block.startLine + renderedRowIndex + 1;
    }
    getRenderedRowIndexForSourceLine(block, sourceLine) {
        if (sourceLine === block.startLine)
            return 0;
        if (sourceLine >= block.startLine + 2 && sourceLine <= block.endLine) {
            return sourceLine - block.startLine - 1;
        }
        return null;
    }
    getTableBlockForWidget(filePath, widget) {
        const docText = this.getEditorTextForFile(filePath);
        if (!docText)
            return null;
        const blocks = this.getMarkdownTableBlocks(docText);
        let widgetIndex = -1;
        this.app.workspace.iterateAllLeaves((leaf) => {
            if (!(leaf.view instanceof obsidian_1.MarkdownView) || leaf.view.file?.path !== filePath)
                return;
            const cm = leaf.view.editor.cm;
            const widgets = Array.from(cm?.dom.querySelectorAll(".cm-table-widget") || []);
            const index = widgets.indexOf(widget);
            if (index !== -1) {
                widgetIndex = index;
                return false;
            }
        });
        return widgetIndex >= 0 ? blocks[widgetIndex] || null : null;
    }
    getTableCellContextForEditorView(view, filePath) {
        const widget = view.dom.closest(".cm-table-widget");
        const domCell = view.dom.closest("td, th");
        if (!widget || !domCell)
            return null;
        const block = this.getTableBlockForWidget(filePath, widget);
        const row = domCell.closest("tr");
        const table = widget.querySelector("table");
        if (!block || !row || !table)
            return null;
        const rows = Array.from(table.querySelectorAll("tr"));
        const renderedRowIndex = rows.indexOf(row);
        const cells = Array.from(row.children).filter((el) => el.matches("td, th"));
        const renderedCellIndex = cells.indexOf(domCell);
        if (renderedRowIndex < 0 || renderedCellIndex < 0)
            return null;
        const sourceLine = this.getSourceLineForTableRow(block, renderedRowIndex);
        const lineText = this.getEditorTextForFile(filePath)?.split("\n")[sourceLine];
        if (lineText === undefined)
            return null;
        const cell = this.parseMarkdownTableRow(lineText)[renderedCellIndex];
        return cell ? { block, sourceLine, cell } : null;
    }
    getCommentHighlightPresentation(comment) {
        let style;
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
    unwrapRenderedTableHighlights(root) {
        root.querySelectorAll(".sidenote-table-highlight").forEach((highlight) => {
            const parent = highlight.parentNode;
            if (!parent)
                return;
            while (highlight.firstChild)
                parent.insertBefore(highlight.firstChild, highlight);
            parent.removeChild(highlight);
            parent.normalize();
        });
    }
    wrapTextRange(root, start, end, comment) {
        if (start < 0 || end <= start)
            return;
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
        const nodes = [];
        let current;
        while ((current = walker.nextNode()))
            nodes.push(current);
        for (const node of nodes) {
            const text = node.nodeValue || "";
            const nodeStart = offset;
            const nodeEnd = offset + text.length;
            offset = nodeEnd;
            const sliceStart = Math.max(start, nodeStart);
            const sliceEnd = Math.min(end, nodeEnd);
            if (sliceStart >= sliceEnd)
                continue;
            const localStart = sliceStart - nodeStart;
            const localEnd = sliceEnd - nodeStart;
            const before = text.slice(0, localStart);
            const middle = text.slice(localStart, localEnd);
            const after = text.slice(localEnd);
            const span = document.createElement("span");
            span.className = presentation.className;
            span.setAttribute("data-comment-timestamp", comment.timestamp.toString());
            if (presentation.style)
                span.setAttribute("style", presentation.style);
            span.textContent = middle;
            const fragment = document.createDocumentFragment();
            if (before)
                fragment.appendChild(document.createTextNode(before));
            fragment.appendChild(span);
            if (after)
                fragment.appendChild(document.createTextNode(after));
            node.parentNode?.replaceChild(fragment, node);
        }
    }
    applyRenderedTableHighlights(view) {
        if (!this.commentManager)
            return;
        const filePath = this.getFilePathForEditorView(view);
        if (!filePath || !this.settings.showHighlights)
            return;
        const docText = view.state.doc.toString();
        const blocks = this.getMarkdownTableBlocks(docText);
        const widgets = Array.from(view.dom.querySelectorAll(".cm-table-widget"));
        widgets.forEach(widget => this.unwrapRenderedTableHighlights(widget));
        if (blocks.length === 0 || widgets.length === 0)
            return;
        const comments = this.commentManager.getCommentsForFile(filePath).filter(comment => !comment.isOrphaned);
        const lines = docText.split("\n");
        comments.forEach((comment) => {
            const blockIndex = blocks.findIndex(block => comment.startLine >= block.startLine && comment.startLine <= block.endLine);
            if (blockIndex < 0)
                return;
            const block = blocks[blockIndex];
            const rowIndex = this.getRenderedRowIndexForSourceLine(block, comment.startLine);
            if (rowIndex === null)
                return;
            const widget = widgets[blockIndex];
            const table = widget?.querySelector("table");
            const row = table ? Array.from(table.querySelectorAll("tr"))[rowIndex] : null;
            if (!row)
                return;
            const lineText = lines[comment.startLine] || "";
            const cellRanges = this.parseMarkdownTableRow(lineText);
            const cellIndex = cellRanges.findIndex(cell => comment.startChar >= cell.contentStart && comment.startChar <= cell.contentEnd);
            const cell = cellIndex >= 0 ? cellRanges[cellIndex] : null;
            if (!cell)
                return;
            const domCell = Array.from(row.children).filter(el => el.matches("td, th"))[cellIndex];
            if (!domCell || domCell.querySelector(".cm-editor"))
                return;
            const wrappers = Array.from(domCell.children).filter(el => el.classList.contains("table-cell-wrapper"));
            const target = wrappers.find(wrapper => getComputedStyle(wrapper).display !== "none") || wrappers[0];
            if (!target)
                return;
            const expectedStart = Math.max(0, comment.startChar - cell.contentStart);
            let start = target.textContent?.indexOf(comment.selectedText) ?? -1;
            if (start < 0)
                return;
            const matches = [];
            let search = 0;
            while (true) {
                const found = target.textContent?.indexOf(comment.selectedText, search) ?? -1;
                if (found === -1)
                    break;
                matches.push(found);
                search = found + 1;
            }
            if (matches.length === 0)
                return;
            start = matches.sort((a, b) => Math.abs(a - expectedStart) - Math.abs(b - expectedStart))[0];
            this.wrapTextRange(target, start, start + comment.selectedText.length, comment);
        });
    }
    applyRenderedTableHighlightsToAllEditors() {
        this.editorViews.forEach((view) => {
            try {
                this.applyRenderedTableHighlights(view);
            }
            catch (e) {
                this.editorViews.delete(view);
            }
        });
        this.app.workspace.iterateAllLeaves((leaf) => {
            if (leaf.view instanceof obsidian_1.MarkdownView) {
                const cm = leaf.view.editor.cm;
                if (cm)
                    this.applyRenderedTableHighlights(cm);
            }
        });
    }
    scheduleRenderedTableHighlights() {
        this.renderedTableHighlightTimers.forEach(timer => window.clearTimeout(timer));
        this.renderedTableHighlightTimers = [0, 50, 150, 400, 900].map(delay => window.setTimeout(() => this.applyRenderedTableHighlightsToAllEditors(), delay));
    }
    refreshViews() {
        this.app.workspace.getLeavesOfType("sidenote-view").forEach(leaf => {
            if (leaf.view instanceof SideNoteView)
                leaf.view.renderComments();
        });
    }
    async ensureCommentFolder() {
        const folder = this.settings.markdownFolder.trim() || DEFAULT_SETTINGS.markdownFolder;
        const normalized = folder.replace(/^\/+|\/+$/g, "");
        if (!(await this.app.vault.adapter.exists(normalized)))
            await this.app.vault.createFolder(normalized);
        return normalized;
    }
    getSideNoteFilePath(notePath) {
        const folder = this.settings.markdownFolder.trim() || DEFAULT_SETTINGS.markdownFolder;
        const normalized = folder.replace(/^\/+|\/+$/g, "");
        const base = notePath.replace(/\.md$/i, "").replace(/\//g, "__");
        return `${normalized}/${base}-sidenote.md`;
    }
    buildMarkdownBlock(excerpt, body, timestamp) {
        const safeExcerpt = excerpt || "(no excerpt)";
        return `## ${safeExcerpt}\n\n${body}\n\n---`;
    }
    async writeCommentToMarkdown(notePath, excerpt, body, timestamp) {
        const folder = await this.ensureCommentFolder();
        const filePath = this.getSideNoteFilePath(notePath);
        const block = this.buildMarkdownBlock(excerpt, body, timestamp);
        const existing = this.app.vault.getAbstractFileByPath(filePath);
        if (existing instanceof obsidian_1.TFile) {
            const content = await this.app.vault.read(existing);
            const updated = content.trim().length === 0 ? block : `${content}\n\n${block}`;
            await this.app.vault.modify(existing, updated);
        }
        else {
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
        if (changed)
            await this.saveData();
    }
    normalizeCommentForHash(commentText) {
        return commentText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    }
    async generateCommentHash(commentText) {
        return generateHash(this.normalizeCommentForHash(commentText));
    }
    getLocalDateString(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, "0");
        const day = String(date.getDate()).padStart(2, "0");
        return `${year}-${month}-${day}`;
    }
    getLocalIsoString(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, "0");
        const day = String(date.getDate()).padStart(2, "0");
        const hours = String(date.getHours()).padStart(2, "0");
        const minutes = String(date.getMinutes()).padStart(2, "0");
        const seconds = String(date.getSeconds()).padStart(2, "0");
        const offsetMinutes = -date.getTimezoneOffset();
        const sign = offsetMinutes >= 0 ? "+" : "-";
        const offsetHours = String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(2, "0");
        const offsetRemainder = String(Math.abs(offsetMinutes) % 60).padStart(2, "0");
        return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${sign}${offsetHours}:${offsetRemainder}`;
    }
    escapeRegExp(text) {
        return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    async ensureFolderPath(folderPath) {
        const normalized = (0, obsidian_1.normalizePath)(folderPath);
        if (normalized === "." || normalized === "")
            return;
        if (await this.app.vault.adapter.exists(normalized))
            return;
        const segments = normalized.split("/").filter(Boolean);
        let current = "";
        for (const segment of segments) {
            current = current ? `${current}/${segment}` : segment;
            if (!(await this.app.vault.adapter.exists(current))) {
                await this.app.vault.createFolder(current);
            }
        }
    }
    getCategoryForColor(color) {
        if (!color)
            return FALLBACK_CATEGORY;
        return COLOR_CATEGORY_MAP[color.toLowerCase()] || FALLBACK_CATEGORY;
    }
    getSourceKey(file) {
        return file.basename;
    }
    getAnnotationFolderPath(file) {
        const root = (0, obsidian_1.normalizePath)(this.settings.annotationOutputFolder?.trim() || DEFAULT_SETTINGS.annotationOutputFolder);
        return `${root}/${this.getSourceKey(file)}`;
    }
    getExpectedAnnotationPath(file, timestamp) {
        const sourceKey = this.getSourceKey(file);
        return `${this.getAnnotationFolderPath(file)}/${sourceKey}_ann_${timestamp}.md`;
    }
    buildBacklinkCallout(comment) {
        const quoteText = (text, prefix) => {
            return text.split("\n").map((line) => prefix + line).join("\n");
        };
        const link = `[点击跳转至原文位置](obsidian://sidenote?timestamp=${comment.timestamp})`;
        return `${CONTROLLED_BLOCK_START}\n` +
            `> [!quote] 批注回链 - ${link}\n` +
            `> **原文**：\n` +
            `${quoteText(comment.selectedText || "", "> > ")}\n` +
            `> \n` +
            `> **批注**：\n` +
            `${quoteText(comment.comment || "（无）", "> ")}\n` +
            `${CONTROLLED_BLOCK_END}`;
    }
    buildBacklinkSection(comment) {
        return `${BACKLINK_SECTION_HEADING}\n\n${this.buildBacklinkCallout(comment)}`;
    }
    buildNewAnnotationBody(comment) {
        return `${this.buildBacklinkSection(comment)}\n\n## 解释与扩展\n\n## 关联\n\n## 后续动作\n`;
    }
    replaceBacklinkSection(content, comment) {
        const section = this.buildBacklinkSection(comment);
        const headingRegex = new RegExp(`^${this.escapeRegExp(BACKLINK_SECTION_HEADING)}\\s*$\\r?\\n?`, "gm");
        const controlledBlockRegex = new RegExp(`${this.escapeRegExp(CONTROLLED_BLOCK_START)}[\\s\\S]*?${this.escapeRegExp(CONTROLLED_BLOCK_END)}\\s*`, "g");
        const stripManagedSection = (text) => {
            return text
                .replace(controlledBlockRegex, "")
                .replace(headingRegex, "")
                .trimStart();
        };
        const frontmatterMatch = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
        if (frontmatterMatch) {
            const body = stripManagedSection(content.slice(frontmatterMatch[0].length));
            return `${frontmatterMatch[0]}${section}\n\n${body}`;
        }
        return `${section}\n\n${stripManagedSection(content)}`;
    }
    async findExistingAnnotationFile(annotationId, expectedPath) {
        const expected = this.app.vault.getAbstractFileByPath(expectedPath);
        if (expected instanceof obsidian_1.TFile)
            return expected;
        const annotationRoot = (0, obsidian_1.normalizePath)(this.settings.annotationOutputFolder?.trim() || DEFAULT_SETTINGS.annotationOutputFolder);
        const candidates = this.app.vault.getMarkdownFiles().filter((file) => file.path.startsWith(`${annotationRoot}/`));
        for (const candidate of candidates) {
            const frontmatter = this.app.metadataCache.getFileCache(candidate)?.frontmatter;
            if (frontmatter?.annotation_id === annotationId)
                return candidate;
        }
        return null;
    }
    getComparableManagedFrontmatter(frontmatter) {
        const locator = (frontmatter?.locator || {});
        const sideComments = (frontmatter?.side_comments || {});
        const comparable = {
            type: frontmatter?.type,
            status: frontmatter?.status,
            annotation_status: frontmatter?.annotation_status,
            source: frontmatter?.source,
            source_key: frontmatter?.source_key,
            source_type: frontmatter?.source_type,
            category_major: frontmatter?.category_major,
            category_minor: frontmatter?.category_minor,
            stage: frontmatter?.stage,
            targets: Array.isArray(frontmatter?.targets) ? frontmatter.targets : [],
            locator: {
                filePath: locator.filePath,
                headingPath: Array.isArray(locator.headingPath) ? locator.headingPath : [],
                startLine: locator.startLine,
                startChar: locator.startChar,
                endLine: locator.endLine,
                endChar: locator.endChar,
            },
            quote_hash: frontmatter?.quote_hash,
            annotation_id: frontmatter?.annotation_id,
            side_comments: {
                timestamp: sideComments.timestamp,
                source_json: sideComments.source_json,
                occurrenceIndex: sideComments.occurrenceIndex,
                markType: sideComments.markType,
                color: sideComments.color,
                isOrphaned: Boolean(sideComments.isOrphaned),
                comment_hash_at_sync: sideComments.comment_hash_at_sync,
            },
            created: frontmatter?.created,
        };
        if (frontmatter && Object.prototype.hasOwnProperty.call(frontmatter, "page") && frontmatter.page != null) {
            comparable.page = frontmatter.page;
        }
        return comparable;
    }
    hasManagedFrontmatterChange(existingFrontmatter, nextFrontmatter) {
        return this.needsManagedFrontmatterCleanup(existingFrontmatter)
            || JSON.stringify(this.getComparableManagedFrontmatter(existingFrontmatter)) !== JSON.stringify(this.getComparableManagedFrontmatter(nextFrontmatter));
    }
    needsManagedFrontmatterCleanup(frontmatter) {
        if (!frontmatter)
            return false;
        if (Object.prototype.hasOwnProperty.call(frontmatter, "page") && frontmatter.page == null) {
            return true;
        }
        const sideComments = (frontmatter.side_comments || {});
        return Object.prototype.hasOwnProperty.call(sideComments, "filePath")
            || Object.prototype.hasOwnProperty.call(sideComments, "selectedTextHash");
    }
    async buildManagedAnnotationFrontmatter(file, comment, existingFrontmatter, options) {
        const now = new Date();
        const commentCreatedAt = new Date(comment.timestamp);
        const sourceKey = this.getSourceKey(file);
        const mappedCategory = this.getCategoryForColor(comment.color);
        const existingCategory = existingFrontmatter?.category_major;
        const preserveManualCategory = typeof existingCategory === "string" && existingCategory.length > 0 && existingCategory !== FALLBACK_CATEGORY;
        const annotationStatus = comment.isOrphaned ? "orphaned" : (mappedCategory === FALLBACK_CATEGORY ? "needs_review" : "active");
        const noteStatus = comment.isOrphaned ? "review" : "active";
        const selectedTextHash = comment.selectedTextHash || await generateHash(comment.selectedText || "");
        const commentHash = await this.generateCommentHash(comment.comment || "");
        const refreshSyncMetadata = options?.refreshSyncMetadata ?? true;
        const frontmatter = {
            type: "annotation",
            status: noteStatus,
            annotation_status: annotationStatus,
            source: existingFrontmatter?.source || `[[${sourceKey}]]`,
            source_key: sourceKey,
            source_type: existingFrontmatter?.source_type || DEFAULT_SOURCE_TYPE,
            category_major: preserveManualCategory ? existingCategory : mappedCategory,
            category_minor: existingFrontmatter?.category_minor ?? "",
            stage: existingFrontmatter?.stage || "captured",
            targets: Array.isArray(existingFrontmatter?.targets) ? existingFrontmatter.targets : [],
            locator: {
                filePath: comment.filePath,
                headingPath: comment.headingPath || [],
                startLine: comment.startLine,
                startChar: comment.startChar,
                endLine: comment.endLine,
                endChar: comment.endChar,
            },
            quote_hash: selectedTextHash,
            annotation_id: `side-comments:${comment.timestamp}`,
            side_comments: {
                timestamp: comment.timestamp,
                source_json: this.getCommentsJsonPath(comment.filePath),
                occurrenceIndex: typeof comment.occurrenceIndex === "number" ? comment.occurrenceIndex : 0,
                markType: comment.markType || "highlight",
                color: comment.color || "",
                isOrphaned: Boolean(comment.isOrphaned),
                comment_hash_at_sync: commentHash,
            },
            created: this.getLocalDateString(commentCreatedAt),
        };
        if (existingFrontmatter && Object.prototype.hasOwnProperty.call(existingFrontmatter, "page") && existingFrontmatter.page != null) {
            frontmatter.page = existingFrontmatter.page;
        }
        if (refreshSyncMetadata) {
            frontmatter.side_comments.synced_at = this.getLocalIsoString(now);
            frontmatter.updated = this.getLocalDateString(now);
        }
        else {
            frontmatter.side_comments.synced_at = existingFrontmatter?.side_comments?.synced_at || this.getLocalIsoString(now);
            frontmatter.updated = existingFrontmatter?.updated || this.getLocalDateString(now);
        }
        return frontmatter;
    }
    buildAnnotationNoteContent(frontmatter, comment) {
        return `---\n${(0, obsidian_1.stringifyYaml)(frontmatter)}---\n\n${this.buildNewAnnotationBody(comment)}`;
    }
    async upsertAnnotationNoteForComment(file, comment) {
        const annotationId = `side-comments:${comment.timestamp}`;
        const expectedPath = this.getExpectedAnnotationPath(file, comment.timestamp);
        const existingFile = await this.findExistingAnnotationFile(annotationId, expectedPath);
        if (!existingFile) {
            await this.ensureFolderPath(this.getAnnotationFolderPath(file));
            const frontmatter = await this.buildManagedAnnotationFrontmatter(file, comment);
            const content = this.buildAnnotationNoteContent(frontmatter, comment);
            await this.app.vault.create(expectedPath, content);
            return "created";
        }
        const currentContent = await this.app.vault.read(existingFile);
        const existingFrontmatter = (this.app.metadataCache.getFileCache(existingFile)?.frontmatter || {});
        const draftFrontmatter = await this.buildManagedAnnotationFrontmatter(file, comment, existingFrontmatter, { refreshSyncMetadata: false });
        const contentDraft = this.replaceBacklinkSection(currentContent, comment);
        const managedChanged = this.hasManagedFrontmatterChange(existingFrontmatter, draftFrontmatter);
        const contentChanged = contentDraft !== currentContent;
        if (!managedChanged && !contentChanged) {
            return "noop";
        }
        const next = await this.buildManagedAnnotationFrontmatter(file, comment, existingFrontmatter, { refreshSyncMetadata: true });
        const managedKeys = new Set([
            "type",
            "status",
            "annotation_status",
            "source",
            "source_key",
            "source_type",
            "category_major",
            "category_minor",
            "stage",
            "targets",
            "page",
            "locator",
            "quote_hash",
            "annotation_id",
            "side_comments",
            "created",
            "updated",
        ]);
        await this.app.fileManager.processFrontMatter(existingFile, (frontmatter) => {
            for (const key of managedKeys) {
                if (Object.prototype.hasOwnProperty.call(next, key)) {
                    frontmatter[key] = next[key];
                }
                else {
                    delete frontmatter[key];
                }
            }
        });
        const updatedContent = this.replaceBacklinkSection(currentContent, comment);
        if (contentChanged) {
            await this.app.vault.modify(existingFile, updatedContent);
        }
        return "updated";
    }
    async syncCommentsToAnnotationsForFile(file) {
        if (!(file instanceof obsidian_1.TFile) || file.extension !== "md") {
            new obsidian_1.Notice("No active Markdown file found.");
            return;
        }
        const commentsForFile = this.commentManager.getCommentsForFile(file.path);
        if (commentsForFile.length === 0) {
            new obsidian_1.Notice("No comments for this file yet.");
            return;
        }
        let created = 0;
        let updated = 0;
        let unchanged = 0;
        for (const comment of commentsForFile) {
            if (!comment.selectedTextHash && comment.selectedText) {
                comment.selectedTextHash = await generateHash(comment.selectedText);
            }
            const result = await this.upsertAnnotationNoteForComment(file, comment);
            if (result === "created")
                created++;
            else if (result === "updated")
                updated++;
            else
                unchanged++;
        }
        new obsidian_1.Notice(`Annotation sync complete: ${created} created, ${updated} updated, ${unchanged} unchanged.`);
    }
    // --- Per-file comment storage ---
    getCommentsJsonPath(notePath) {
        const folder = this.settings.commentsDataFolder?.trim() || DEFAULT_SETTINGS.commentsDataFolder;
        const normalized = (0, obsidian_1.normalizePath)(folder);
        const base = notePath.replace(/\.md$/i, "").replace(/\//g, "__");
        return `${normalized}/${base}.json`;
    }
    async ensureCommentsDataFolder() {
        const folder = this.settings.commentsDataFolder?.trim() || DEFAULT_SETTINGS.commentsDataFolder;
        const normalized = (0, obsidian_1.normalizePath)(folder);
        if (!(await this.app.vault.adapter.exists(normalized))) {
            await this.app.vault.createFolder(normalized);
        }
        return normalized;
    }
    async loadAllCommentsFromFiles() {
        const folder = this.settings.commentsDataFolder?.trim() || DEFAULT_SETTINGS.commentsDataFolder;
        const normalized = (0, obsidian_1.normalizePath)(folder);
        const allComments = [];
        if (await this.app.vault.adapter.exists(normalized)) {
            const listing = await this.app.vault.adapter.list(normalized);
            for (const filePath of listing.files) {
                if (filePath.endsWith('.json')) {
                    try {
                        const content = await this.app.vault.adapter.read(filePath);
                        const comments = JSON.parse(content);
                        allComments.push(...comments);
                    }
                    catch (e) {
                        console.error(`Error loading comments from ${filePath}:`, e);
                    }
                }
            }
        }
        return allComments;
    }
    async saveAllCommentFiles() {
        const normalized = await this.ensureCommentsDataFolder();
        const grouped = {};
        for (const comment of this.comments) {
            if (!grouped[comment.filePath])
                grouped[comment.filePath] = [];
            grouped[comment.filePath].push(comment);
        }
        const writtenPaths = new Set();
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
        }
        catch (e) {
            console.error("Error cleaning up comment files:", e);
        }
    }
    async saveCommentsForSingleFile(filePath) {
        await this.ensureCommentsDataFolder();
        const commentsForFile = this.comments.filter(c => c.filePath === filePath);
        const jsonPath = this.getCommentsJsonPath(filePath);
        if (commentsForFile.length === 0) {
            if (await this.app.vault.adapter.exists(jsonPath)) {
                await this.app.vault.adapter.remove(jsonPath);
            }
        }
        else {
            await this.app.vault.adapter.write(jsonPath, JSON.stringify(commentsForFile, null, 2));
        }
    }
    showOrphanDeletionNotice(orphans) {
        if (orphans.length === 0)
            return;
        const fragment = document.createDocumentFragment();
        const span = document.createElement('span');
        span.textContent = `${orphans.length} 条批注已失去原文，是否删除？`;
        fragment.appendChild(span);
        fragment.appendChild(document.createElement('br'));
        const btnContainer = document.createElement('div');
        btnContainer.style.display = 'flex';
        btnContainer.style.gap = '8px';
        btnContainer.style.marginTop = '8px';
        const deleteBtn = document.createElement('button');
        deleteBtn.textContent = '删除';
        deleteBtn.className = 'mod-warning';
        const keepBtn = document.createElement('button');
        keepBtn.textContent = '保留';
        btnContainer.appendChild(deleteBtn);
        btnContainer.appendChild(keepBtn);
        fragment.appendChild(btnContainer);
        const notice = new obsidian_1.Notice(fragment, 0);
        deleteBtn.onclick = async () => {
            for (const oc of orphans) {
                this.commentManager.deleteComment(oc.timestamp);
            }
            await this.saveData();
            this.refreshViews();
            notice.hide();
            new obsidian_1.Notice(`已删除 ${orphans.length} 条孤立批注。`);
        };
        keepBtn.onclick = () => {
            notice.hide();
        };
    }
    // --- 捕获上下文的辅助函数 ---
    getSelectionContext(editor) {
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
    async handleAddComment(editor, view, markType, initialColor, skipModal = false) {
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
            // @ts-ignore
            const cm = editor.cm;
            // @ts-ignore
            const coords = cm.coordsAtPos(editor.posToOffset(editor.getCursor("to")));
            if (skipModal) {
                const selectedTextHash = await generateHash(selection);
                const newComment = {
                    filePath: filePath, startLine: cursorStart.line, startChar: cursorStart.ch,
                    endLine: cursorEnd.line, endChar: cursorEnd.ch,
                    absoluteFrom, absoluteTo, occurrenceIndex, headingPath,
                    selectedText: selection,
                    selectedTextHash: selectedTextHash, comment: "", timestamp: Date.now(), isOrphaned: false,
                    contextBefore: before,
                    contextAfter: after,
                    markType: markType,
                    color: initialColor || ""
                };
                await this.addComment(newComment);
                document.querySelectorAll('.sidenote-selection-toolbar').forEach(el => el.remove());
                return;
            }
            new CommentModal(this.app, this, {
                mode: 'add',
                selectedText: selection,
                filePath: filePath,
                initialColor: initialColor || "",
                onSubmitAdd: async (commentText, color) => {
                    const selectedTextHash = await generateHash(selection);
                    const newComment = {
                        filePath: filePath, startLine: cursorStart.line, startChar: cursorStart.ch,
                        endLine: cursorEnd.line, endChar: cursorEnd.ch,
                        absoluteFrom, absoluteTo, occurrenceIndex, headingPath,
                        selectedText: selection,
                        selectedTextHash: selectedTextHash, comment: commentText, timestamp: Date.now(), isOrphaned: false,
                        // 保存上下文
                        contextBefore: before,
                        contextAfter: after,
                        markType: markType,
                        color: color
                    };
                    this.addComment(newComment);
                }
            }).open();
        }
        else {
            new obsidian_1.Notice("Please select some text to add a comment.");
        }
    }
    async onload() {
        this.injectStyles(); // 只注入动态变量
        await this.loadPluginData();
        this.commentManager = new commentManager_1.CommentManager(this.comments);
        await this.migrateComments();
        this.registerEditorExtension([this.createSelectionToolbarPlugin(), ...this.createHighlightPlugin()]);
        this.scheduleRenderedTableHighlights();
        this.registerEvent(this.app.workspace.on('active-leaf-change', () => {
            document.querySelectorAll('.sidenote-selection-toolbar').forEach(el => {
                el.remove();
            });
        }));
        this.addSettingTab(new SideNoteSettingTab(this.app, this));
        this.registerView("sidenote-view", (leaf) => new SideNoteView(leaf, this));
        this.registerObsidianProtocolHandler("sidenote", async (params) => {
            const timestamp = parseInt(params.timestamp);
            if (timestamp) {
                const comment = this.comments.find(c => c.timestamp === timestamp);
                if (comment) {
                    let sideNoteView = null;
                    const leaves = this.app.workspace.getLeavesOfType("sidenote-view");
                    if (leaves.length > 0)
                        sideNoteView = leaves[0].view;
                    if (!sideNoteView) {
                        await this.activateView();
                        const newLeaves = this.app.workspace.getLeavesOfType("sidenote-view");
                        if (newLeaves.length > 0)
                            sideNoteView = newLeaves[0].view;
                    }
                    if (sideNoteView)
                        sideNoteView.jumpToComment(comment);
                }
            }
        });
        this.addCommand({ id: "open-comment-view", name: "在分屏中打开批注视图", callback: () => void switchToSideNoteView(this.app) });
        this.addCommand({ id: "activate-view", name: "在侧边栏打开批注视图", callback: () => this.activateView() });
        this.addCommand({
            id: "sync-current-file-comments-to-annotations",
            name: "同步当前笔记批注到 Annotations",
            icon: "refresh-cw",
            callback: async () => {
                const activeFile = this.app.workspace.getActiveFile();
                if (!(activeFile instanceof obsidian_1.TFile) || activeFile.extension !== "md") {
                    new obsidian_1.Notice("No active Markdown file found.");
                    return;
                }
                await this.syncCommentsToAnnotationsForFile(activeFile);
            }
        });
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
        }));
        this.addRibbonIcon("message-square", "Side Note: Open in Sidebar", () => this.activateView());
        this.registerEvent(this.app.workspace.on('active-leaf-change', (leaf) => {
            if (leaf && leaf.view instanceof obsidian_1.MarkdownView) {
                const file = leaf.view.file;
                this.app.workspace.getLeavesOfType("sidenote-view").forEach(sideNoteLeaf => {
                    if (sideNoteLeaf.view instanceof SideNoteView)
                        sideNoteLeaf.view.updateActiveFile(file);
                });
                this.refreshEditorDecorations();
                this.scheduleRenderedTableHighlights();
            }
        }));
        this.registerEvent(this.app.vault.on('rename', async (file, oldPath) => {
            if (file instanceof obsidian_1.TFile && file.extension === 'md') {
                this.commentManager.renameFile(oldPath, file.path);
                await this.saveData();
                this.refreshViews();
            }
        }));
        this.registerEvent(this.app.vault.on('modify', async (file) => {
            if (this.isSaving)
                return;
            // Ignore our own comment data files
            const dataFolder = (0, obsidian_1.normalizePath)(this.settings.commentsDataFolder?.trim() || DEFAULT_SETTINGS.commentsDataFolder);
            if (file.path.startsWith(dataFolder + '/'))
                return;
            if (file.path === '.obsidian/plugins/side-note/data.json' || (file instanceof obsidian_1.TFile && file.name === 'data.json' && file.parent?.name === 'side-note')) {
                try {
                    await this.loadPluginData();
                    this.commentManager.updateComments(this.comments);
                    this.refreshViews();
                    this.refreshEditorDecorations();
                    this.scheduleRenderedTableHighlights();
                }
                catch (error) {
                    console.error("Error reloading plugin data:", error);
                }
            }
            else if (file instanceof obsidian_1.TFile && file.extension === 'md') {
                try {
                    // Track orphans before update
                    const beforeOrphanTimestamps = new Set(this.commentManager.getCommentsForFile(file.path)
                        .filter(c => c.isOrphaned)
                        .map(c => c.timestamp));
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
                        if (this.orphanNoticeTimer)
                            clearTimeout(this.orphanNoticeTimer);
                        this.orphanNoticeTimer = setTimeout(() => {
                            const uniqueOrphans = [...new Map(this.pendingOrphans.map(o => [o.timestamp, o])).values()];
                            this.showOrphanDeletionNotice(uniqueOrphans);
                            this.pendingOrphans = [];
                        }, 2000);
                    }
                }
                catch (error) {
                    console.error("Error updating comment coordinates:", error);
                }
            }
        }));
    }
    injectStyles() {
        const styleId = "sidenote-dynamic-styles";
        let styleTag = document.getElementById(styleId);
        if (!styleTag) {
            styleTag = document.createElement("style");
            styleTag.id = styleId;
            document.head.appendChild(styleTag);
        }
        // 仅保留需要 JavaScript 动态计算的颜色变量
        // 具体的 CSS 样式规则现在由 styles.css 文件接管
        styleTag.innerHTML = `
            :root {
                --sidenote-highlight-color: rgba(255, 208, 0, 0.2);
                --sidenote-highlight-hover: rgba(255, 208, 0, 0.4);
                --sidenote-highlight-border: rgba(255, 208, 0, 0.6);
                --sidenote-orphaned-color: rgba(255, 80, 80, 0.2);
                --sidenote-orphaned-hover: rgba(255, 80, 80, 0.3);
                --sidenote-orphaned-border: rgba(255, 80, 80, 0.6);
            }
        `;
    }
    async activateViewAndHighlightComment(timestamp) {
        await this.activateView();
        const leaves = this.app.workspace.getLeavesOfType("sidenote-view");
        leaves.forEach(leaf => { if (leaf.view instanceof SideNoteView)
            leaf.view.highlightComment(timestamp); });
    }
    async activateView() {
        const { workspace } = this.app;
        let leaf = null;
        const leaves = workspace.getLeavesOfType("sidenote-view");
        if (leaves.length > 0)
            leaf = leaves[0];
        else {
            const rightLeaf = workspace.getRightLeaf(false);
            if (rightLeaf) {
                leaf = rightLeaf;
                await leaf.setViewState({ type: "sidenote-view", active: true });
            }
        }
        if (leaf) {
            workspace.revealLeaf(leaf);
            if (leaf.view instanceof SideNoteView) {
                const activeFile = workspace.getActiveFile();
                leaf.view.updateActiveFile(activeFile);
            }
        }
    }
    async onCommentsChanged(message) {
        await this.saveData();
        this.refreshViews();
        this.refreshEditorDecorations();
        this.scheduleRenderedTableHighlights();
        new obsidian_1.Notice(message);
    }
    async addComment(newComment) {
        await this.commentManager.addComment(newComment);
        await this.onCommentsChanged("Comment added!");
    }
    async editComment(timestamp, newCommentText, newColor) {
        this.commentManager.editComment(timestamp, newCommentText, newColor);
        await this.onCommentsChanged("Comment updated!");
    }
    async deleteComment(timestamp) {
        this.commentManager.deleteComment(timestamp);
        await this.onCommentsChanged("Comment deleted!");
    }
    async copyBacklink(comment) {
        const quoteText = (text, prefix) => {
            return text.split('\n').map(line => prefix + line).join('\n');
        };
        const link = `[点击跳转至原文位置](obsidian://sidenote?timestamp=${comment.timestamp})`;
        const callout = `> [!quote] 批注回链 - ${link}\n` +
            `> **原文**：\n` +
            `${quoteText(comment.selectedText || "", "> > ")}\n` +
            `> \n` +
            `> **批注**：\n` +
            `${quoteText(comment.comment || "（无）", "> ")}`;
        navigator.clipboard.writeText(callout);
        new obsidian_1.Notice("已复制精确回链 (无污染防漂移)");
    }
    async loadPluginData() {
        const rawData = Object.assign({}, { imageHashes: {} }, DEFAULT_SETTINGS, await this.loadData());
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
                new obsidian_1.Notice(`已迁移 ${migratedCount} 条批注到独立文件存储。`);
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
        }
        if (needsSave)
            await this.saveData();
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
    hexToRgb(hex) {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result ? { r: parseInt(result[1], 16), g: parseInt(result[2], 16), b: parseInt(result[3], 16) } : { r: 255, g: 200, b: 0 };
    }
    async saveData() {
        this.isSaving = true;
        try {
            const dataToSave = { ...this.settings, imageHashes: this.imageHashes };
            await super.saveData(dataToSave);
            await this.saveAllCommentFiles();
        }
        finally {
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
            }
            catch (e) {
                this.editorViews.delete(view);
            }
        });
        this.app.workspace.iterateAllLeaves((leaf) => {
            if (leaf.view instanceof obsidian_1.MarkdownView) {
                const editor = leaf.view.editor;
                if (editor && editor.cm) {
                    const cm = editor.cm;
                    if (cm.dispatch)
                        cm.dispatch({ effects: [forceUpdateEffect.of(null)] });
                    this.applyRenderedTableHighlights(cm);
                }
            }
        });
        this.scheduleRenderedTableHighlights();
    }
    createSelectionToolbarPlugin() {
        const plugin = this;
        let activeToolbarController = null;
        return view_1.ViewPlugin.fromClass(class {
            constructor(view) {
                this.toolbar = null;
                this.view = view;
            }
            update(update) {
                if (update.selectionSet || update.viewportChanged) {
                    setTimeout(() => this.checkSelection(), 10);
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
            showToolbar(selection) {
                if (activeToolbarController && activeToolbarController.view !== this.view) {
                    activeToolbarController.hideToolbar();
                }
                document.querySelectorAll('.sidenote-selection-toolbar').forEach((toolbar) => {
                    if (toolbar !== this.toolbar)
                        toolbar.remove();
                });
                if (!this.toolbar) {
                    this.toolbar = document.createElement("div");
                    this.toolbar.className = "sidenote-selection-toolbar";
                    document.body.appendChild(this.toolbar);
                    this.buildToolbarUI();
                    this.toolbar.addEventListener('mousedown', (e) => {
                        e.preventDefault();
                    });
                }
                activeToolbarController = { view: this.view, hideToolbar: () => this.hideToolbar() };
                this.toolbar.style.display = 'flex';
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
                    }
                    else if (leftCenter + toolbarWidth / 2 > editorRect.right - padding) {
                        leftCenter = editorRect.right - toolbarWidth / 2 - padding;
                    }
                    if (topEdge - toolbarHeight < editorRect.top + padding) {
                        this.toolbar.classList.add('sidenote-toolbar-bottom');
                        topEdge = bottomEdge;
                    }
                    else {
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
                this.hideToolbar();
            }
            buildToolbarUI() {
                if (!this.toolbar)
                    return;
                const createBtn = (iconName, tooltip, markType, skipModal = false) => {
                    const btn = document.createElement('button');
                    btn.className = 'sidenote-toolbar-btn';
                    btn.title = tooltip;
                    (0, obsidian_1.setIcon)(btn, iconName);
                    btn.onclick = async () => {
                        const color = this.toolbar?.querySelector('.sidenote-toolbar-color-picker')?.value || plugin.settings.highlightColor || "#FFC800";
                        await plugin.handleAddCommentFromEditorView(this.view, markType, color, skipModal);
                    };
                    return btn;
                };
                const boldBtn = createBtn('bold', 'Bold', 'bold', true);
                const highlighterBtn = createBtn('highlighter', 'Highlight', 'highlight', true);
                const underlineBtn = createBtn('underline', 'Underline', 'underline', true);
                const commentBtn = createBtn('message-square-plus', 'Comment', 'highlight', false);
                this.toolbar.appendChild(boldBtn);
                this.toolbar.appendChild(highlighterBtn);
                this.toolbar.appendChild(underlineBtn);
                this.toolbar.appendChild(commentBtn);
                const divider = document.createElement('div');
                divider.className = 'sidenote-toolbar-divider';
                this.toolbar.appendChild(divider);
                const presetColors = [
                    { name: 'Purple', value: '#8b5cf6' },
                    { name: 'Pink', value: '#ec4899' },
                    { name: 'Blue', value: '#3b82f6' },
                    { name: 'Green', value: '#10b981' },
                    { name: 'Yellow', value: '#f59e0b' }
                ];
                const colorPicker = document.createElement('input');
                colorPicker.type = 'color';
                colorPicker.className = 'sidenote-toolbar-color-picker';
                colorPicker.value = plugin.settings.highlightColor || "#FFC800";
                let activeCircle = null;
                const updateActiveCircle = (circle) => {
                    if (activeCircle)
                        activeCircle.classList.remove('active');
                    if (circle)
                        circle.classList.add('active');
                    activeCircle = circle;
                };
                presetColors.forEach(color => {
                    const circle = document.createElement('div');
                    circle.className = 'sidenote-color-circle';
                    circle.style.setProperty('--circle-color', color.value);
                    circle.title = color.name;
                    if (colorPicker.value.toLowerCase() === color.value.toLowerCase()) {
                        updateActiveCircle(circle);
                    }
                    circle.onclick = () => {
                        colorPicker.value = color.value;
                        updateActiveCircle(circle);
                    };
                    this.toolbar?.appendChild(circle);
                });
                const customColorWrapper = document.createElement('div');
                customColorWrapper.className = 'sidenote-color-circle custom-color';
                customColorWrapper.title = 'Custom Color';
                colorPicker.onchange = () => {
                    const matchedPreset = Array.from(this.toolbar?.querySelectorAll('.sidenote-color-circle:not(.custom-color)') || []).find(c => {
                        return c.style.getPropertyValue('--circle-color').toLowerCase() === colorPicker.value.toLowerCase();
                    });
                    if (matchedPreset) {
                        updateActiveCircle(matchedPreset);
                    }
                    else {
                        updateActiveCircle(customColorWrapper);
                    }
                };
                customColorWrapper.appendChild(colorPicker);
                this.toolbar.appendChild(customColorWrapper);
            }
        });
    }
    createHighlightPlugin() {
        const plugin = this;
        const commentTooltip = (0, view_1.hoverTooltip)((view, pos, side) => {
            const filePath = plugin.getFilePathForEditorView(view);
            if (!filePath)
                return null;
            const comments = plugin.commentManager.getCommentsForFile(filePath);
            const { doc } = view.state;
            const hoveredComment = comments.find(comment => {
                if (comment.isOrphaned)
                    return false;
                try {
                    const startLineObj = doc.line(comment.startLine + 1);
                    const from = startLineObj.from + comment.startChar;
                    let to = from;
                    if (comment.isOrphaned) {
                        to = Math.min(from + 1, startLineObj.to);
                    }
                    else {
                        const endLineObj = doc.line(comment.endLine + 1);
                        to = endLineObj.from + comment.endChar;
                    }
                    return pos >= from && pos <= to;
                }
                catch {
                    return false;
                }
            });
            if (!hoveredComment)
                return null;
            return {
                pos, above: true, arrow: false, offset: { x: 0, y: 14 },
                create(view) {
                    const dom = document.createElement("div");
                    dom.className = "sidenote-tooltip";
                    const content = dom.createDiv("sidenote-tooltip-content markdown-rendered");
                    (async () => {
                        await plugin.renderCommentContent(hoveredComment.comment || "", content, hoveredComment.filePath);
                    })();
                    return { dom };
                }
            };
        });
        const highlightPlugin = view_1.ViewPlugin.fromClass(class {
            constructor(view) {
                this.view = view;
                plugin.editorViews.add(view);
                this.decorations = this.buildDecorations(view);
                window.setTimeout(() => plugin.applyRenderedTableHighlights(view), 0);
                this.view.dom.addEventListener('click', this.handleClick.bind(this));
                this.view.dom.addEventListener('dblclick', this.handleDoubleClick.bind(this));
            }
            destroy() {
                plugin.editorViews.delete(this.view);
                this.view.dom.removeEventListener('click', this.handleClick.bind(this));
                this.view.dom.removeEventListener('dblclick', this.handleDoubleClick.bind(this));
            }
            handleClick(event) {
                const target = event.target;
                const highlight = target.closest('.sidenote-highlight');
                if (highlight) {
                    const timestampStr = highlight.getAttribute('data-comment-timestamp');
                    if (timestampStr) {
                        const timestamp = parseInt(timestampStr, 10);
                        plugin.activateViewAndHighlightComment(timestamp);
                    }
                }
            }
            handleDoubleClick(event) {
                const target = event.target;
                const highlight = target.closest('.sidenote-highlight');
                if (highlight) {
                    const timestampStr = highlight.getAttribute('data-comment-timestamp');
                    if (timestampStr) {
                        const timestamp = parseInt(timestampStr, 10);
                        const comment = plugin.comments.find(c => c.timestamp === timestamp);
                        if (comment) {
                            new CommentModal(plugin.app, plugin, { mode: 'edit', comment: comment }).open();
                        }
                    }
                }
            }
            update(update) {
                if (update.docChanged)
                    plugin.mapCommentPositionsFromView(update);
                if (update.docChanged || update.viewportChanged || update.transactions.some(tr => tr.effects.some(e => e.is(forceUpdateEffect)))) {
                    this.decorations = this.buildDecorations(update.view);
                    window.setTimeout(() => plugin.applyRenderedTableHighlights(update.view), 0);
                }
            }
            buildDecorations(view) {
                const builder = new state_1.RangeSetBuilder();
                if (!plugin.settings.showHighlights)
                    return builder.finish();
                const filePath = plugin.getFilePathForEditorView(view);
                if (!filePath)
                    return builder.finish();
                const comments = plugin.commentManager.getCommentsForFile(filePath);
                const doc = view.state.doc;
                const decorationsArray = [];
                const tableCellContext = plugin.getTableCellContextForEditorView(view, filePath);
                if (tableCellContext) {
                    const cellText = doc.toString();
                    comments.forEach(comment => {
                        if (comment.isOrphaned || comment.startLine !== tableCellContext.sourceLine)
                            return;
                        if (comment.startChar < tableCellContext.cell.contentStart || comment.startChar > tableCellContext.cell.contentEnd)
                            return;
                        const expectedFrom = Math.max(0, comment.startChar - tableCellContext.cell.contentStart);
                        const matches = [];
                        let search = 0;
                        while (comment.selectedText) {
                            const found = cellText.indexOf(comment.selectedText, search);
                            if (found === -1)
                                break;
                            matches.push(found);
                            search = found + 1;
                        }
                        if (matches.length === 0)
                            return;
                        const from = matches.sort((a, b) => Math.abs(a - expectedFrom) - Math.abs(b - expectedFrom))[0];
                        const to = from + comment.selectedText.length;
                        if (from >= 0 && to <= doc.length && from < to && doc.sliceString(from, to) === comment.selectedText) {
                            const presentation = plugin.getCommentHighlightPresentation(comment);
                            const attributes = { 'data-comment-timestamp': comment.timestamp.toString() };
                            if (presentation.style)
                                attributes.style = presentation.style;
                            decorationsArray.push({
                                from,
                                to,
                                decoration: view_1.Decoration.mark({
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
                        }
                        else {
                            try {
                                const endLineObj = doc.line(comment.endLine + 1);
                                to = endLineObj.from + comment.endChar;
                            }
                            catch (e) {
                                to = doc.length;
                            }
                        }
                        if (!comment.isOrphaned && doc.sliceString(from, to) !== comment.selectedText)
                            return;
                        if (from >= 0 && to <= doc.length && from < to) {
                            const attributes = { 'data-comment-timestamp': comment.timestamp.toString() };
                            if (comment.color) {
                                const rgb = plugin.hexToRgb(comment.color);
                                const opacity = plugin.settings.highlightOpacity;
                                attributes.style = `--sidenote-highlight-color: rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${opacity}); ` +
                                    `--sidenote-highlight-hover: rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${Math.min(opacity + 0.15, 1)}); ` +
                                    `--sidenote-highlight-border: rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${Math.min(opacity + 0.4, 1)});`;
                            }
                            decorationsArray.push({
                                from, to,
                                decoration: view_1.Decoration.mark({
                                    class: `sidenote-highlight${comment.isOrphaned ? ' orphaned' : ''} sidenote-mark-${comment.markType || 'highlight'}`,
                                    attributes: attributes
                                })
                            });
                        }
                    }
                    catch (e) { }
                });
                decorationsArray.sort((a, b) => a.from - b.from);
                decorationsArray.forEach(({ from, to, decoration }) => builder.add(from, to, decoration));
                return builder.finish();
            }
        }, { decorations: (v) => v.decorations });
        return [highlightPlugin, commentTooltip];
    }
}
exports.default = SideNote;
module.exports = SideNote;
