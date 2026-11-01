/**
 * 小说阅读器 - 备忘的纯函数
 *
 * 备忘本身存在 IndexedDB（js/db.js），这里只处理输入校验、筛选、排序、
 * 展示文本和导出，方便在 Node 下单独测试。
 */

export const MEMO_MAX_CHARS = 20000;
export const MEMO_TITLE_CHARS = 80;

export const MEMO_SORTS = new Set(['updated', 'created', 'title', 'chapter']);

const memoTitleCollator = (() => {
    try {
        return new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
    } catch {
        return null;
    }
})();

function compareMemoTitles(a, b) {
    const left = memoTitle(a);
    const right = memoTitle(b);
    if (memoTitleCollator) return memoTitleCollator.compare(left, right);
    return left.localeCompare(right);
}

/** 清理输入：统一换行、去掉空字符、压缩标题空白，并按上限截断 */
export function sanitizeMemoInput({ title = '', content = '' } = {}) {
    const normalizedContent = String(content ?? '')
        .replace(/\r\n?/g, '\n')
        .replace(/\u0000/g, '')
        .trim();
    const normalizedTitle = String(title ?? '').replace(/\s+/g, ' ').trim();
    const contentChars = Array.from(normalizedContent);
    return {
        title: Array.from(normalizedTitle).slice(0, MEMO_TITLE_CHARS).join(''),
        content: contentChars.slice(0, MEMO_MAX_CHARS).join(''),
        truncated: contentChars.length > MEMO_MAX_CHARS,
    };
}

/** 列表里显示的标题：没写标题就取正文第一行 */
export function memoTitle(memo) {
    const title = String(memo?.title ?? '').replace(/\s+/g, ' ').trim();
    if (title) return title;
    const firstLine = String(memo?.content ?? '')
        .split('\n')
        .map(line => line.trim())
        .find(Boolean) || '';
    if (!firstLine) return '未命名备忘';
    const chars = Array.from(firstLine);
    return chars.length > 24 ? `${chars.slice(0, 24).join('')}…` : firstLine;
}

/** 没写标题时，用正文第一行自动生成一个标题并落盘 */
export function memoTitleFromContent(content, maxChars = MEMO_TITLE_CHARS) {
    const firstLine = String(content ?? '')
        .split('\n')
        .map(line => line.trim())
        .find(Boolean) || '';
    const chars = Array.from(firstLine);
    return chars.length > maxChars ? chars.slice(0, maxChars).join('') : firstLine;
}

/** 搜索词规范化：不区分大小写、连续空白压成一个 */
export function normalizeMemoQuery(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** 标题或正文是否包含搜索词 */
export function memoMatchesQuery(memo, query) {
    const needle = normalizeMemoQuery(query);
    if (!needle) return true;
    const haystack = `${memo?.title || ''}\n${memo?.content || ''}`.toLowerCase();
    return haystack.includes(needle);
}

/** 按关键词和「只看置顶」筛选，保持原顺序 */
export function filterMemos(memos, { query = '', pinnedOnly = false } = {}) {
    return (Array.isArray(memos) ? memos : []).filter(memo => {
        if (pinnedOnly && memo?.pinned !== true) return false;
        return memoMatchesQuery(memo, query);
    });
}

/** 按章节范围筛选：all / loose（未绑定位置）/ 具体章节下标 */
export function memosInScope(memos, scope = 'all') {
    const list = Array.isArray(memos) ? memos : [];
    if (scope === 'loose') return list.filter(memo => !Number.isInteger(memo?.chapterIndex));
    if (scope === 'all' || scope == null) return list.slice();
    const index = Number(scope);
    if (!Number.isFinite(index)) return list.slice();
    return list.filter(memo => memo.chapterIndex === index);
}

/**
 * 排序：置顶永远在最前；其余按最近更新 / 最近创建 / 章节顺序。
 * 不修改传入数组。
 */
export function sortMemos(memos, mode = 'updated') {
    const sortMode = MEMO_SORTS.has(mode) ? mode : 'updated';
    return [...(Array.isArray(memos) ? memos : [])].sort((a, b) => {
        const pinned = Number(Boolean(b?.pinned)) - Number(Boolean(a?.pinned));
        if (pinned) return pinned;

        if (sortMode === 'title') {
            const byTitle = compareMemoTitles(a, b);
            if (byTitle) return byTitle;
        }

        if (sortMode === 'chapter') {
            const aChapter = Number.isInteger(a?.chapterIndex) ? a.chapterIndex : Number.POSITIVE_INFINITY;
            const bChapter = Number.isInteger(b?.chapterIndex) ? b.chapterIndex : Number.POSITIVE_INFINITY;
            if (aChapter !== bChapter) return aChapter - bChapter;
            const aPage = Number.isInteger(a?.page) ? a.page : -1;
            const bPage = Number.isInteger(b?.page) ? b.page : -1;
            if (aPage !== bPage) return aPage - bPage;
        }

        if (sortMode === 'created') {
            const created = (b?.createdAt || 0) - (a?.createdAt || 0);
            if (created) return created;
        }

        const updated = (b?.updatedAt || 0) - (a?.updatedAt || 0);
        if (updated) return updated;
        return String(a?.id || '').localeCompare(String(b?.id || ''));
    });
}

/** 分组按 order、创建时间排序，界面和导出共用 */
export function sortMemoGroups(groups) {
    return [...(Array.isArray(groups) ? groups : [])].sort((a, b) => {
        const order = (a?.order || 0) - (b?.order || 0);
        if (order) return order;
        const created = (a?.createdAt || 0) - (b?.createdAt || 0);
        if (created) return created;
        return String(a?.name || '').localeCompare(String(b?.name || ''));
    });
}

/** 每个章节有多少条备忘；未绑定位置的记在 null 上 */
export function countMemosByChapter(memos) {
    const counts = new Map();
    for (const memo of Array.isArray(memos) ? memos : []) {
        const key = Number.isInteger(memo?.chapterIndex) ? memo.chapterIndex : null;
        counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
}

/** 章节标题本身已经带「第 X 章 / Chapter X」时，不要再重复加序号 */
const CHAPTER_NUMBER_PATTERN = /^\s*(?:第\s*[0-9０-９一二三四五六七八九十百千万零两]+\s*[章回节卷篇]|chapter\s*\d+)/i;

/** 「第 3 章 雾港」这样的章节标签，自带的编号不会重复 */
export function memoChapterLabel(chapter, ordinal) {
    const title = String(chapter?.title || '').trim();
    const position = Number.isFinite(Number(ordinal)) && Number(ordinal) > 0
        ? Number(ordinal)
        : 1;
    if (!title) return `第 ${position} 章`;
    if (CHAPTER_NUMBER_PATTERN.test(title)) return title;
    return `第 ${position} 章 ${title}`;
}

/** 「第 3 章 雾港 · 第 2 页」这样的位置文案；没有绑定位置时返回空串 */
export function memoAnchorLabel(anchor, chapters = []) {
    if (!anchor || !Number.isInteger(anchor.chapterIndex)) return '';
    const list = Array.isArray(chapters) ? chapters : [];
    const chapter = list.find(item => item?.index === anchor.chapterIndex);
    const ordinal = chapter ? list.indexOf(chapter) + 1 : anchor.chapterIndex + 1;
    const page = Number.isInteger(anchor.page) ? ` · 第 ${anchor.page + 1} 页` : '';
    return `${memoChapterLabel(chapter, ordinal)}${page}`;
}

/** 复制备忘时只取正文，不包含标题 */
export function memoClipboardText(memo) {
    return String(memo?.content ?? '');
}

function memoChapterOrder(memo) {
    return Number.isInteger(memo?.chapterIndex) ? memo.chapterIndex : Number.POSITIVE_INFINITY;
}

function memoPageOrder(memo) {
    return Number.isInteger(memo?.page) ? memo.page : -1;
}

/** 按章节、页码、创建时间排好序，供导出使用（不改变原数组，也不按置顶分组） */
export function sortMemosForExport(memos) {
    return [...(Array.isArray(memos) ? memos : [])].sort((a, b) => {
        const chapter = memoChapterOrder(a) - memoChapterOrder(b);
        if (chapter) return chapter;
        const page = memoPageOrder(a) - memoPageOrder(b);
        if (page) return page;
        return (a?.createdAt || 0) - (b?.createdAt || 0);
    });
}

/** 导出为 Markdown：本书备忘按章节分组；分组备忘不显示章节，直接按条列出 */
export function buildMemoExportMarkdown({
    novelTitle = '',
    memos = [],
    chapters = [],
    exportedAt = Date.now(),
    groupMode = false,
} = {}) {
    const list = sortMemosForExport(memos);
    const chapterList = Array.isArray(chapters) ? chapters : [];
    const lines = [
        `# ${String(novelTitle || '未命名小说').trim()} · 备忘录`,
        '',
        `导出时间：${new Date(exportedAt).toLocaleString('zh-CN', { hour12: false })}`,
        `共 ${list.length} 条`,
        '',
    ];
    let currentKey;
    for (const memo of list) {
        if (!groupMode) {
            const key = Number.isInteger(memo?.chapterIndex) ? memo.chapterIndex : null;
            if (key !== currentKey) {
                currentKey = key;
                if (key === null) {
                    lines.push('## 未绑定位置', '');
                } else {
                    const chapter = chapterList.find(item => item?.index === key);
                    const ordinal = chapter ? chapterList.indexOf(chapter) + 1 : key + 1;
                    lines.push(`## ${memoChapterLabel(chapter, ordinal)}`, '');
                }
            }
        }
        lines.push(`### ${memoTitle(memo)}`);
        const meta = [];
        if (!groupMode && Number.isInteger(memo?.page)) meta.push(`第 ${memo.page + 1} 页`);
        if (memo?.pinned) meta.push('置顶');
        if (Number.isFinite(memo?.updatedAt)) {
            meta.push(`更新于 ${new Date(memo.updatedAt).toLocaleString('zh-CN', { hour12: false })}`);
        }
        if (meta.length) lines.push(`_${meta.join(' · ')}_`);
        lines.push('', String(memo?.content ?? '').trim(), '');
    }
    return `${lines.join('\n').trim()}\n`;
}
