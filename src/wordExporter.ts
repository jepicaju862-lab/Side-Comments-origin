// Word (.docx) exporter for SideNote.
// Converts a note's markdown + its SideNote comments into a .docx file that
// carries **native Word comments (批注)** anchored to the exact commented text.
//
// Design notes:
// - Anchoring is offset-faithful. Each rendered character keeps a mapping back
//   to its raw offset in the source markdown, so a comment's span (selectedText /
//   absoluteFrom..absoluteTo) lands on exactly the same characters Word-side.
// - Inline markdown (**bold**, *italic*, ==highlight==, ~~strike~~, `code`,
//   [links](url)) is stripped for display while offsets stay correct, because a
//   "token" is always a contiguous run of literal characters with no syntax
//   inside it (offset math within a token is 1:1).
// - Comment ranges may span multiple paragraphs; open/close markers are tracked
//   across block boundaries, which Word supports.

import {
    Document,
    Packer,
    Paragraph,
    TextRun,
    HeadingLevel,
    CommentRangeStart,
    CommentRangeEnd,
    CommentReference,
    IRunOptions,
    ISectionOptions,
    ParagraphChild,
} from "docx";
import type { Comment } from "./commentManager";

// ----------------------------------------------------------------------------
// Inline tokenization
// ----------------------------------------------------------------------------

interface InlineStyle {
    bold?: boolean;
    italic?: boolean;
    highlight?: boolean;
    strike?: boolean;
    code?: boolean;
}

interface InlineToken {
    text: string;
    rawStart: number; // global offset (into full markdown) of the first char
    rawEnd: number; // exclusive; rawEnd - rawStart === text.length
    style: InlineStyle;
}

interface CharEntry {
    ch: string;
    offset: number;
    style: InlineStyle;
}

function styleEquals(a: InlineStyle, b: InlineStyle): boolean {
    return (
        !!a.bold === !!b.bold &&
        !!a.italic === !!b.italic &&
        !!a.highlight === !!b.highlight &&
        !!a.strike === !!b.strike &&
        !!a.code === !!b.code
    );
}

// Scan a run of inline markdown starting at global offset `base`.
// Returns literal characters (syntax markers consumed) with their raw offsets.
function scanInline(text: string, base: number): CharEntry[] {
    const chars: CharEntry[] = [];
    const style: InlineStyle = {};
    let i = 0;
    while (i < text.length) {
        const c = text[i];
        const two = text.slice(i, i + 2);

        if (style.code) {
            if (c === "`") {
                style.code = false;
                i += 1;
            } else {
                chars.push({ ch: c, offset: base + i, style: { ...style } });
                i += 1;
            }
            continue;
        }

        if (c === "\\" && i + 1 < text.length) {
            // Escaped character: emit the next char literally.
            chars.push({ ch: text[i + 1], offset: base + i + 1, style: { ...style } });
            i += 2;
            continue;
        }
        if (c === "`") {
            style.code = true;
            i += 1;
            continue;
        }
        if (two === "**" || two === "__") {
            style.bold = !style.bold;
            i += 2;
            continue;
        }
        if (two === "==") {
            style.highlight = !style.highlight;
            i += 2;
            continue;
        }
        if (two === "~~") {
            style.strike = !style.strike;
            i += 2;
            continue;
        }
        if (c === "*" || c === "_") {
            style.italic = !style.italic;
            i += 1;
            continue;
        }
        if (c === "[") {
            // Link: [text](url) -> keep text, preserving each char's raw offset.
            const linkMatch = /^\[([^\]]*)\]\(([^)]*)\)/.exec(text.slice(i));
            if (linkMatch) {
                const label = linkMatch[1];
                const labelStart = i + 1; // char after '['
                for (let k = 0; k < label.length; k++) {
                    chars.push({ ch: label[k], offset: base + labelStart + k, style: { ...style } });
                }
                i += linkMatch[0].length;
                continue;
            }
        }
        if (c === "!" && text[i + 1] === "[") {
            // Image ![alt](url): skip entirely (rare to be commented).
            const imgMatch = /^!\[([^\]]*)\]\(([^)]*)\)/.exec(text.slice(i));
            if (imgMatch) {
                i += imgMatch[0].length;
                continue;
            }
        }

        chars.push({ ch: c, offset: base + i, style: { ...style } });
        i += 1;
    }
    return chars;
}

// Group per-char entries into tokens: same style AND contiguous raw offsets.
function charsToTokens(chars: CharEntry[]): InlineToken[] {
    const tokens: InlineToken[] = [];
    let cur: InlineToken | null = null;
    for (const entry of chars) {
        if (cur && styleEquals(cur.style, entry.style) && cur.rawEnd === entry.offset) {
            cur.text += entry.ch;
            cur.rawEnd = entry.offset + 1;
        } else {
            cur = { text: entry.ch, rawStart: entry.offset, rawEnd: entry.offset + 1, style: entry.style };
            tokens.push(cur);
        }
    }
    return tokens;
}

function parseInline(text: string, base: number): InlineToken[] {
    return charsToTokens(scanInline(text, base));
}

// ----------------------------------------------------------------------------
// Block parsing
// ----------------------------------------------------------------------------

type BlockType = "paragraph" | "heading" | "quote" | "list" | "code";

interface Block {
    type: BlockType;
    level?: number; // heading level 1-6
    tokens: InlineToken[];
}

const HEADING_LEVELS = [
    HeadingLevel.HEADING_1,
    HeadingLevel.HEADING_2,
    HeadingLevel.HEADING_3,
    HeadingLevel.HEADING_4,
    HeadingLevel.HEADING_5,
    HeadingLevel.HEADING_6,
];

function parseBlocks(markdown: string): Block[] {
    const blocks: Block[] = [];
    const lines = markdown.split("\n");
    let offset = 0;
    let inFence = false;

    for (const line of lines) {
        const lineStart = offset;
        offset += line.length + 1; // +1 for the '\n' we split on

        const fenceMatch = /^\s*(```|~~~)/.exec(line);
        if (fenceMatch) {
            inFence = !inFence;
            // Render the fence line itself verbatim as code (keeps offsets simple).
            blocks.push({ type: "code", tokens: literalTokens(line, lineStart) });
            continue;
        }
        if (inFence) {
            blocks.push({ type: "code", tokens: literalTokens(line, lineStart) });
            continue;
        }

        if (line.trim() === "") continue; // blank line -> paragraph break

        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        if (heading) {
            const level = heading[1].length;
            const textStart = lineStart + line.indexOf(heading[2]);
            blocks.push({ type: "heading", level, tokens: parseInline(heading[2], textStart) });
            continue;
        }

        const quote = /^>\s?(.*)$/.exec(line);
        if (quote) {
            const textStart = lineStart + line.length - quote[1].length;
            blocks.push({ type: "quote", tokens: parseInline(quote[1], textStart) });
            continue;
        }

        const list = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
        if (list) {
            const textStart = lineStart + line.length - list[3].length;
            blocks.push({ type: "list", tokens: parseInline(list[3], textStart) });
            continue;
        }

        if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
            continue; // horizontal rule -> skip
        }

        // Default: a normal paragraph line (also covers table rows, rendered as text).
        blocks.push({ type: "paragraph", tokens: parseInline(line, lineStart) });
    }

    return blocks;
}

function literalTokens(line: string, base: number): InlineToken[] {
    if (line.length === 0) return [];
    return [{ text: line, rawStart: base, rawEnd: base + line.length, style: { code: true } }];
}

// ----------------------------------------------------------------------------
// Comment resolution
// ----------------------------------------------------------------------------

interface ResolvedComment {
    id: number;
    from: number;
    to: number;
    comment: Comment;
}

// Locate each comment's [from, to) range in the raw markdown. Prefer the stored
// absolute offsets when they still match selectedText; otherwise fall back to a
// text search honouring occurrenceIndex.
function resolveComments(markdown: string, comments: Comment[]): ResolvedComment[] {
    const resolved: ResolvedComment[] = [];
    let id = 0;
    for (const comment of comments) {
        if (comment.isOrphaned) continue;
        const text = comment.selectedText || "";
        if (!text) continue;

        let from = -1;
        if (
            typeof comment.absoluteFrom === "number" &&
            typeof comment.absoluteTo === "number" &&
            comment.absoluteFrom >= 0 &&
            markdown.slice(comment.absoluteFrom, comment.absoluteTo) === text
        ) {
            from = comment.absoluteFrom;
        } else {
            const occurrence = typeof comment.occurrenceIndex === "number" ? comment.occurrenceIndex : 0;
            from = nthIndexOf(markdown, text, occurrence);
            if (from === -1) from = markdown.indexOf(text);
        }
        if (from === -1) continue; // text no longer present; skip

        resolved.push({ id: id++, from, to: from + text.length, comment });
    }
    return resolved;
}

function nthIndexOf(haystack: string, needle: string, n: number): number {
    let idx = -1;
    for (let count = 0; count <= n; count++) {
        idx = haystack.indexOf(needle, idx + 1);
        if (idx === -1) return -1;
    }
    return idx;
}

// ----------------------------------------------------------------------------
// Emission: interleave text runs with comment range markers
// ----------------------------------------------------------------------------

function runOptionsFor(style: InlineStyle, covering: ResolvedComment[]): IRunOptions {
    const opts: Record<string, unknown> = {};
    let bold = style.bold;
    let italics = style.italic;
    let strike = style.strike;
    let underline = false;
    let highlightColor: string | undefined = style.highlight ? "#FFF3B0" : undefined;

    // Fold in the visual marks of any comment covering this run, mirroring the
    // in-editor appearance (markType/color).
    for (const rc of covering) {
        switch (rc.comment.markType) {
            case "bold":
                bold = true;
                break;
            case "underline":
                underline = true;
                break;
            case "strikethrough":
                strike = true;
                break;
            case "highlight":
            default:
                highlightColor = rc.comment.color || highlightColor || "#FFC800";
                break;
        }
    }

    if (bold) opts.bold = true;
    if (italics) opts.italics = true;
    if (strike) opts.strike = true;
    if (underline) opts.underline = {};
    if (style.code) opts.font = "Consolas";
    if (highlightColor) opts.shading = { fill: normalizeHex(highlightColor) };
    return opts;
}

function normalizeHex(hex: string): string {
    return hex.replace(/^#/, "").toUpperCase();
}

interface EmitState {
    opened: Set<number>;
    comments: ResolvedComment[];
}

// Process comment open/close markers for everything up to raw offset `pos`,
// pushing markers into the current paragraph's children array.
function processBoundaries(state: EmitState, pos: number, children: ParagraphChild[]): void {
    // Close first, so an end that coincides with another's start closes before opening.
    for (const rc of state.comments) {
        if (state.opened.has(rc.id) && rc.to <= pos) {
            children.push(new CommentRangeEnd(rc.id));
            children.push(new TextRun({ children: [new CommentReference(rc.id)] }));
            state.opened.delete(rc.id);
        }
    }
    for (const rc of state.comments) {
        if (!state.opened.has(rc.id) && rc.from <= pos && rc.to > pos) {
            children.push(new CommentRangeStart(rc.id));
            state.opened.add(rc.id);
        }
    }
}

function coveringComments(state: EmitState): ResolvedComment[] {
    return state.comments.filter((rc) => state.opened.has(rc.id));
}

// Emit one token, splitting it at any comment boundary that falls inside it.
function emitToken(state: EmitState, token: InlineToken, children: ParagraphChild[]): void {
    const cuts: number[] = [];
    for (const rc of state.comments) {
        if (rc.from > token.rawStart && rc.from < token.rawEnd) cuts.push(rc.from);
        if (rc.to > token.rawStart && rc.to < token.rawEnd) cuts.push(rc.to);
    }
    cuts.sort((a, b) => a - b);

    const stops = [...new Set(cuts), token.rawEnd];
    let cursor = token.rawStart;
    for (const stop of stops) {
        processBoundaries(state, cursor, children);
        const segment = token.text.slice(cursor - token.rawStart, stop - token.rawStart);
        if (segment.length > 0) {
            const opts = runOptionsFor(token.style, coveringComments(state));
            children.push(new TextRun({ text: segment, ...opts }));
        }
        cursor = stop;
    }
}

// ----------------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------------

export interface WordExportOptions {
    markdown: string;
    comments: Comment[];
    title: string;
    author?: string;
}

export interface WordExportResult {
    blob: Blob;
    commentCount: number;
    skippedCount: number;
}

export async function exportNoteToDocx(options: WordExportOptions): Promise<WordExportResult> {
    const { markdown, comments, title } = options;
    const author = options.author || "SideNote";

    const resolved = resolveComments(markdown, comments);
    const activeCount = comments.filter((c) => !c.isOrphaned && c.selectedText).length;

    const blocks = parseBlocks(markdown);
    const state: EmitState = { opened: new Set(), comments: resolved };

    const paragraphs: Paragraph[] = [];

    // Title heading.
    paragraphs.push(
        new Paragraph({ text: title, heading: HeadingLevel.TITLE })
    );

    for (const block of blocks) {
        const children: ParagraphChild[] = [];
        for (const token of block.tokens) {
            emitToken(state, token, children);
        }

        if (block.type === "heading") {
            paragraphs.push(
                new Paragraph({ children, heading: HEADING_LEVELS[(block.level || 1) - 1] })
            );
        } else if (block.type === "list") {
            paragraphs.push(new Paragraph({ children, bullet: { level: 0 } }));
        } else if (block.type === "quote") {
            paragraphs.push(new Paragraph({ children, style: "IntenseQuote" }));
        } else if (block.type === "code") {
            paragraphs.push(
                new Paragraph({ children, shading: { fill: "F2F2F2" } })
            );
        } else {
            paragraphs.push(new Paragraph({ children }));
        }
    }

    // Close any comment ranges still open at end of document.
    if (state.opened.size > 0) {
        const tail: ParagraphChild[] = [];
        processBoundaries(state, Number.MAX_SAFE_INTEGER, tail);
        if (tail.length > 0) paragraphs.push(new Paragraph({ children: tail }));
    }

    const commentChildren = resolved.map((rc) => ({
        id: rc.id,
        author,
        date: new Date(rc.comment.timestamp || Date.now()),
        children: (rc.comment.comment || "").split("\n").map((line) => new Paragraph(line || "")),
    }));

    const section: ISectionOptions = { children: paragraphs, properties: {} };

    const doc = new Document({
        comments: { children: commentChildren },
        sections: [section],
    });

    const blob = await Packer.toBlob(doc);
    return {
        blob,
        commentCount: resolved.length,
        skippedCount: Math.max(0, activeCount - resolved.length),
    };
}
