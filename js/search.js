/**
 * 小说阅读器 - 全文搜索的纯函数
 *
 * 只负责文本匹配、摘要和页码定位，方便在 Node 下测试；
 * 真正的章节读取、界面渲染在 js/ui.js。
 */

/** 规范化搜索词：去首尾空白、压掉连续空白 */
export function normalizeSearchQuery(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * 在 text 中查找 query 的所有出现位置（不区分大小写）。
 * @returns {{offset:number, length:number}[]}
 */
export function findOccurrences(text, query, options = {}) {
    const source = String(text ?? '');
    const needle = normalizeSearchQuery(query).toLowerCase();
    if (!needle) return [];
    const limit = Math.max(1, Number(options.limit) || 50);
    const start = Math.max(0, Number(options.from) || 0);
    const haystack = source.toLowerCase();
    const matches = [];
    let cursor = start;
    while (matches.length < limit) {
        const at = haystack.indexOf(needle, cursor);
        if (at < 0) break;
        matches.push({ offset: at, length: needle.length });
        cursor = at + needle.length;
    }
    return matches;
}

/**
 * 截取命中位置附近的一段文字，供结果列表展示。
 * prefix/suffix 中的换行与连续空白会压成单个空格。
 * @returns {{prefix:string, match:string, suffix:string, truncatedStart:boolean, truncatedEnd:boolean}}
 */
export function buildSnippet(text, offset, length, options = {}) {
    const source = String(text ?? '');
    const before = Math.max(0, Number(options.before) || 30);
    const after = Math.max(0, Number(options.after) || 60);
    const start = Math.max(0, Number(offset) || 0);
    const end = Math.min(source.length, start + Math.max(0, Number(length) || 0));
    const prefixStart = Math.max(0, start - before);
    const suffixEnd = Math.min(source.length, end + after);
    const squish = value => value.replace(/\s+/g, ' ');
    return {
        // 只清理截断处的空白，保留紧挨命中词的边界空格，避免英文单词粘连
        prefix: squish(source.slice(prefixStart, start)).replace(/^\s+/, ''),
        match: source.slice(start, end),
        suffix: squish(source.slice(end, suffixEnd)).replace(/\s+$/, ''),
        truncatedStart: prefixStart > 0,
        truncatedEnd: suffixEnd < source.length,
    };
}

/**
 * 在分页结果里定位第 occurrence（从 0 开始）次命中所在的页。
 * 找不到时返回 0。
 */
export function findPageForOccurrence(pages, query, occurrence = 0) {
    const list = Array.isArray(pages) ? pages : [];
    const target = Math.max(0, Number(occurrence) || 0);
    let seen = 0;
    for (let page = 0; page < list.length; page++) {
        const found = findOccurrences(list[page], query, { limit: 10000 }).length;
        if (seen + found > target) return page;
        seen += found;
    }
    return 0;
}

/**
 * 把文本切成「普通片段 / 命中片段」，方便界面安全地构建 <mark>。
 * @returns {{text:string, match:boolean}[]}
 */
export function splitHighlight(text, query) {
    const source = String(text ?? '');
    const matches = findOccurrences(source, query, { limit: 10000 });
    if (!matches.length) return source ? [{ text: source, match: false }] : [];
    const parts = [];
    let cursor = 0;
    for (const item of matches) {
        if (item.offset > cursor) parts.push({ text: source.slice(cursor, item.offset), match: false });
        parts.push({ text: source.slice(item.offset, item.offset + item.length), match: true });
        cursor = item.offset + item.length;
    }
    if (cursor < source.length) parts.push({ text: source.slice(cursor), match: false });
    return parts;
}
