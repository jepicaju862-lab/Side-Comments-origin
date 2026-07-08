// Helper function to generate SHA256 hash (works on both desktop and mobile)
async function generateHash(text: string): Promise<string> {
    try {
        // Web Crypto API (works on mobile)
        const encoder = new TextEncoder();
        const data = encoder.encode(text);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (error) {
        // Fallback to Node.js crypto for desktop
        try {
            const nodeCrypto = require('crypto');
            return nodeCrypto.createHash('sha256').update(text).digest('hex');
        } catch {
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

export interface Comment {
    filePath: string;
    startLine: number;
    startChar: number;
    endLine: number;
    endChar: number;

    // 绝对偏移量：比行列更适合在文档变动后追踪位置
    absoluteFrom?: number;
    absoluteTo?: number;

    selectedText: string;
    selectedTextHash: string;
    comment: string;
    timestamp: number;
    isOrphaned?: boolean;
    commentPath?: string; // Path to markdown-stored comment (optional)
    
    // --- 新增：结构与重复文本锚点 ---
    // occurrenceIndex 用于记录同一 selectedText 在原文中第几次出现
    // headingPath 用于优先在相同标题层级内恢复批注
    occurrenceIndex?: number;
    headingPath?: string[];
    blockHash?: string;

    // --- 新增：上下文锚点 ---
    // 用于在行号失效或文本微调后重新定位
    contextBefore?: string; 
    contextAfter?: string;

    // --- 新增：批注形式 ---
    markType?: 'highlight' | 'underline' | 'strikethrough' | 'bold';
    
    // --- 新增：批注颜色 ---
    color?: string;
}

export class CommentManager {
    private comments: Comment[];
    private readonly MIN_TEXT_LENGTH = 3; 

    constructor(comments: Comment[]) {
        this.comments = comments;
    }

    getCommentsForFile(filePath: string): Comment[] {
        return this.comments.filter(comment => comment.filePath === filePath);
    }

    async addComment(newComment: Comment): Promise<void> {
        // Generate hash if not present
        if (!newComment.selectedTextHash) {
            newComment.selectedTextHash = await generateHash(newComment.selectedText);
        }
        this.comments.push(newComment);
    }

    editComment(timestamp: number, newCommentText: string, newColor?: string): void {
        const commentToEdit = this.comments.find(comment => comment.timestamp === timestamp);
        if (commentToEdit) {
            commentToEdit.comment = newCommentText;
            if (newColor) commentToEdit.color = newColor;
        }
    }

    deleteComment(timestamp: number): void {
        const indexToDelete = this.comments.findIndex(comment => comment.timestamp === timestamp);
        if (indexToDelete > -1) {
            this.comments.splice(indexToDelete, 1);
        }
    }

    deleteOrphanedComments(): number {
        const initialLength = this.comments.length;
        for (let i = this.comments.length - 1; i >= 0; i--) {
            if (this.comments[i].isOrphaned) {
                this.comments.splice(i, 1);
            }
        }
        return initialLength - this.comments.length;
    }

    getOrphanedComments(): Comment[] {
        return this.comments.filter(comment => comment.isOrphaned);
    }

    getOrphanedCommentCount(): number {
        return this.comments.filter(comment => comment.isOrphaned).length;
    }

    renameFile(oldPath: string, newPath: string): void {
        this.comments.forEach(comment => {
            if (comment.filePath === oldPath) {
                comment.filePath = newPath;
            }
        });
    }

    updateComments(newComments: Comment[]): void {
        this.comments = newComments;
    }

    getComments(): Comment[] {
        return this.comments;
    }

    // --- 核心定位逻辑重构 ---

    /**
     * 将绝对索引转换为行号和列号
     */
    private getPositionFromIndex(content: string, index: number): { line: number; ch: number } {
        // 边界检查
        if (index < 0) return { line: 0, ch: 0 };
        if (index > content.length) index = content.length;

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
    private getApproximateIndex(content: string, line: number, char: number): number {
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
    async updateCommentCoordinatesForFile(fileContent: string, filePath: string): Promise<void> {
        const fileComments = this.comments.filter(comment => comment.filePath === filePath);

        for (const comment of fileComments) {
            const selectedText = comment.selectedText || "";
            if (!selectedText) {
                comment.isOrphaned = true;
                continue;
            }

            // 策略 1：绝对 offset 仍有效时，直接使用。
            if (this.isOffsetMatch(fileContent, comment)) {
                this.applyMatch(comment, fileContent, comment.absoluteFrom!, selectedText);
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
            } else {
                comment.isOrphaned = true;
            }
        }
    }

    private isOffsetMatch(content: string, comment: Comment): boolean {
        if (typeof comment.absoluteFrom !== "number" || typeof comment.absoluteTo !== "number") return false;
        if (comment.absoluteFrom < 0 || comment.absoluteTo > content.length || comment.absoluteFrom >= comment.absoluteTo) return false;
        return content.slice(comment.absoluteFrom, comment.absoluteTo) === comment.selectedText;
    }

    private applyMatch(comment: Comment, content: string, index: number, text: string): void {
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

    private collectCandidates(content: string, comment: Comment, scope: { start: number; end: number }): Array<{ index: number; text: string; source: "exact" | "context" }> {
        const candidates = new Map<number, { index: number; text: string; source: "exact" | "context" }>();
        const selectedText = comment.selectedText || "";

        // 1. 精确文本候选：优先且最安全。
        let searchPos = scope.start;
        while (selectedText && searchPos <= scope.end) {
            const found = content.indexOf(selectedText, searchPos);
            if (found === -1 || found + selectedText.length > scope.end) break;
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
                    if (match.index === undefined || match[1] === undefined) continue;
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

    private scoreCandidate(content: string, index: number, text: string, comment: Comment, estimatedOldIndex: number): number {
        let score = 0;
        const selectedText = comment.selectedText || "";

        if (text === selectedText) score += 55;
        else score += this.similarity(text, selectedText) * 35;

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
            if (this.sameStringArray(currentHeadingPath, comment.headingPath)) score += 20;
            else score += this.headingPathSimilarity(currentHeadingPath, comment.headingPath) * 10;
        }

        if (typeof comment.occurrenceIndex === "number" && selectedText) {
            const occurrence = this.getOccurrenceIndex(content, selectedText, index);
            if (occurrence === comment.occurrenceIndex) score += 16;
            else if (occurrence >= 0) score += Math.max(0, 8 - Math.abs(occurrence - comment.occurrenceIndex) * 3);
        }

        const distance = Math.abs(index - estimatedOldIndex);
        score += Math.max(0, 18 - distance / 120);

        return score;
    }

    private getSearchScope(content: string, comment: Comment): { start: number; end: number } {
        if (!comment.headingPath?.length) return { start: 0, end: content.length };

        const range = this.findHeadingRange(content, comment.headingPath);
        return range || { start: 0, end: content.length };
    }

    private findHeadingRange(content: string, headingPath: string[]): { start: number; end: number } | null {
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

        if (startLine < 0) return null;

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

    private countOccurrences(content: string, selectedText: string): number {
        if (!selectedText) return 0;
        let count = 0;
        let searchPos = 0;
        while (true) {
            const found = content.indexOf(selectedText, searchPos);
            if (found === -1) break;
            count++;
            searchPos = found + 1;
        }
        return count;
    }

    private similarity(a: string, b: string): number {
        if (a === b) return 1;
        if (!a || !b) return 0;
        const bigrams = (text: string) => {
            const normalized = text.replace(/\s+/g, " ").trim();
            const set = new Set<string>();
            for (let i = 0; i < normalized.length - 1; i++) set.add(normalized.slice(i, i + 2));
            if (set.size === 0 && normalized) set.add(normalized);
            return set;
        };
        const aSet = bigrams(a);
        const bSet = bigrams(b);
        if (aSet.size === 0 || bSet.size === 0) return 0;
        let intersection = 0;
        aSet.forEach(item => { if (bSet.has(item)) intersection++; });
        return (2 * intersection) / (aSet.size + bSet.size);
    }

    private headingPathSimilarity(a: string[], b: string[]): number {
        if (this.sameStringArray(a, b)) return 1;
        const max = Math.max(a.length, b.length);
        if (max === 0) return 0;
        let same = 0;
        for (let i = 0; i < Math.min(a.length, b.length); i++) {
            if (a[i] === b[i]) same++;
        }
        return same / max;
    }

    private sameStringArray(a: string[], b: string[]): boolean {
        return a.length === b.length && a.every((item, index) => item === b[index]);
    }

    private escapeRegExp(str: string): string {
        return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

}
