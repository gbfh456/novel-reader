/**
 * 小说阅读器 - 界面与交互
 * 悬浮球 + 书架 / 找书 / 阅读 / 备忘录 / 总结 / 世界书 / 文风 / 设置。
 */

import {
    clamp,
    copyText,
    countChars,
    debounce,
    downloadText,
    escapeHtml,
    formatCount,
    formatTime,
    isAbortError,
    mapLimit,
    safeFileName,
    sleep,
    trimToLimit,
    uuid,
    yieldToUI,
} from './util.js';
import {
    DEFAULT_SETTINGS,
    ONLINE_CHANNEL_OPTIONS,
    SEARCH_ENGINE_OPTIONS,
    STYLE_PRESETS,
    SUMMARY_MODE_PRESETS,
    computeBudget,
    getContextTokens,
    getSettings,
    maxTargetChars,
    resetSettings,
    resolveStrategy,
    saveSettings,
} from './settings.js';
import {
    appendChapters,
    clearAll,
    deleteMemo,
    deleteMemoGroup,
    deleteMemos,
    deleteNovel,
    deleteChapterContents,
    deleteNovels,
    deleteShelfGroup,
    deleteSummary,
    deleteWorldbook,
    deleteWorldbookPartsForNovel,
    getChapterContent,
    getChapterImages,
    getChapterList,
    getNovel,
    getSummaryPart,
    getSummaryParts,
    getWorldbook,
    getWorldbookParts,
    deleteBookmark,
    listBookmarks,
    listGroupMemos,
    listMemoGroups,
    listMemos,
    listNovels,
    listShelfGroups,
    listSummaries,
    markNovelRead,
    patchNovels,
    replaceChapters,
    putSummaryPart,
    putWorldbookPart,
    replaceSummary,
    replaceWorldbook,
    saveMemo,
    saveMemoGroup,
    saveBookmark,
    saveChapterContent,
    saveNovel,
    saveShelfGroup,
    setNovelOrders,
    updateNovel,
} from './db.js';
import {
    SHELF_GROUP_UNGROUPED,
    buildShelfView,
    countByGroup,
    groupOf,
    isPinned,
    nextGroupOrder,
    normalizeShelfSort,
    orderMapFromIds,
    readTimeOf,
    relativeTime,
    sortShelfGroups,
    unreadOf,
    updateTimeOf,
} from './shelf.js';
import { exportReplaceRules, importReplaceRules, normalizeReplaceRules } from './replace.js';
import { normalizeText, parseNovelFile, splitChapters } from './parse.js';
import { callWithRetry, runSummary } from './summary.js';
import {
    MEMO_MAX_CHARS,
    MEMO_SORTS,
    buildMemoExportMarkdown,
    countMemosByChapter,
    filterMemos,
    memoAnchorLabel,
    memoChapterLabel,
    memoClipboardText,
    memoTitle,
    memoTitleFromContent,
    memosInScope,
    sanitizeMemoInput,
    sortMemoGroups,
    sortMemos,
} from './memo.js';
import {
    STYLE_ADAPT_SYSTEM_PROMPT,
    STYLE_OUTPUT_TOKEN_LIMIT,
    STYLE_SAMPLE_CHARS,
    buildStyleAdaptPrompt,
    buildStylePlan,
    checkStyleOutput,
    describeStyleFormat,
    detectPov,
    extractStyleSample,
    fitStyleOutput,
    groupStyleEntries,
    parseStyleAdaptOutput,
    styleFormatLines,
    stylePasteHint,
} from './style.js';
import {
    WORLDBOOK_CATEGORIES,
    entryCharLimit,
    estimateWorldbookUsage,
    generateWorldbook,
    mergeWorldbookEntries,
    toCharacterCard,
    toSillyTavernWorldbook,
    worldbookStats,
} from './worldbook.js';
import {
    DUPLICATE_JUDGE_SYSTEM_PROMPT,
    ORGANIZE_PROMPT_PRESETS,
    ORGANIZE_SYSTEM_PROMPT,
    buildDuplicateJudgePrompt,
    buildOrganizePrompt,
    defaultOrganizePrompt,
    findDuplicateGroups,
    mergeDuplicateGroups,
    mergeEntries,
    normalizeEntryName,
    organizeWorldbookEntries,
    parseDuplicateJudgement,
    parseOrganizeResponse,
    pickMainName,
} from './organize.js';
import {
    buildSnippet,
    findOccurrences,
    findPageForOccurrence,
    normalizeSearchQuery,
    splitHighlight,
} from './search.js';
import { requestSourceCollection } from './source.js';
import {
    exportSource,
    importSources,
    mergeSources,
    normalizeSource,
    sourceNeedsJs,
    splitSourceGroups,
    validateSource,
} from './source/model.js';
import { SourceRuntime, alignChapterIndex, normalizeBookName, scoreBookName } from './source/runtime.js';
import {
    NovelFetcher,
    bookIdFromUrl,
    buildBookText,
    mergeSourceResults,
    normalizeOnlineSettings,
    sortSourceResults,
} from './network.js';
import {
    FANQIE_SITE,
    fanqieBookSummary,
    isFanqieBook,
    parseFanqieBookText,
    summarizeFanqieJob,
} from './fanqie.js';
import {
    importCharacterCardToTavern,
    installEmbeddedWorldbookAutoImport,
    installPresetChangeWatcher,
    isInTavern,
    linkWorldToCharacter,
    readSelectedChatPreset,
    saveWorldbookToTavern,
    selectedCharacter,
    selectedCharacterId,
    tavernCharacterNames,
    uniqueName,
    worldbookExists,
} from './tavern.js';

const CHARS_PER_PAGE = 4600;
const READER_FONTS = {
    system: 'inherit',
    serif: 'Georgia, "Songti SC", "SimSun", "Noto Serif CJK SC", serif',
    sans: 'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
    kai: '"Kaiti SC", "KaiTi", "STKaiti", "Noto Serif CJK SC", serif',
};
const PAGE_TURN_MODES = new Set(['none', 'fade', 'slide', 'cover', 'flip']);
const LIBRARY_VIEWS = new Set(['list', 'grid']);
/** 书封配色：按书名哈希取一组，保证同一本书每次打开颜色一致 */
const BOOK_TONES = [
    ['#3d5a80', '#22344a'],
    ['#8a4b3b', '#552a20'],
    ['#3f6b52', '#213c2e'],
    ['#66507d', '#382a48'],
    ['#9a6a34', '#5d3d19'],
    ['#2f6b70', '#193e42'],
    ['#7a3f52', '#45222f'],
    ['#4a5570', '#272d40'],
    ['#5f6b3a', '#353d1f'],
    ['#8a6a3b', '#513b20'],
    ['#7d4b39', '#47281c'],
    ['#4b6a8a', '#293d52'],
];
const READER_PREF_KEYS = [
    'fontSize',
    'readerTheme',
    'readerFont',
    'readerLineHeight',
    'readerParaGap',
    'readerWidth',
    'readerIndent',
    'readerAlign',
    'readerLetterSpacing',
    'readerPageChars',
    'pageTurn',
];
const READER_PREF_STORAGE = 'novel-reader:reader-prefs';
/** 扩展自己的 URL 相对路径（用于桥接没装时显示安装命令） */
const EXT_REL_PATH = (() => {
    try {
        return decodeURIComponent(new URL('../', import.meta.url).pathname).replace(/^\/+/, '');
    } catch {
        return 'scripts/extensions/third-party/novel-reader/';
    }
})();
const MEMO_COLLAPSED_NODES_STORAGE = 'novel-reader:memo-collapsed-nodes';

/**
 * 生成桥接的安装 / 卸载命令。
 *
 * 统一给 node 版本：酒馆本身就必须装 Node，所以不管 Windows / Linux / macOS 都能直接跑；
 * `install-server.sh` / `uninstall.sh` 只是这两个 node 命令的壳，不再在面板里露出。
 * 路径统一用 `/`：cmd / PowerShell / bash 都认（Windows 想写成 `\` 也一样能跑）。
 * @param {'install'|'uninstall'} kind 装还是卸
 * @param {string} dir 相对酒馆根目录的扩展目录
 * @returns {string} 命令（路径为空时返回空串）
 */
function bridgeCommandOf(kind, dir) {
    const clean = String(dir || '').trim().replace(/[\\/]+$/, '');
    if (!clean) return '';
    return `node ${clean}/setup.mjs ${kind === 'install' ? 'install-server' : 'uninstall'}`;
}

const state = {
    novels: [],
    /** 书架：分组、管理模式与勾选（对齐「阅读」的书架管理） */
    shelf: {
        groups: [],
        /** 正在多选管理 */
        managing: false,
        selected: new Set(),
        keyword: '',
        /** 顶部工具条是否因为滚动而收起 */
        barHidden: false,
    },
    novelId: null,
    novel: null,
    chapters: [],
    chapterCache: new Map(),
    chapterImageCache: new Map(),
    bookmarks: [],
    reader: { index: 0, page: 0, pages: [''], loaded: false },
    /** 全文搜索状态 */
    search: {
        query: '',
        highlight: '',
        running: false,
        abort: null,
        results: [],
        scanned: 0,
        total: 0,
        truncated: false,
    },
    /** 备忘录：本书备忘 + 独立分组备忘，都存在 IndexedDB */
    memo: {
        /** 当前小说的本书备忘 */
        novelMemos: [],
        /** 全部分组备忘（跨小说，一直保留） */
        groupMemos: [],
        /** 备忘分组 */
        groups: [],
        groupsLoaded: false,
        /** 左侧折叠的树节点：book / chapter:N / loose / group:ID */
        collapsedNodes: new Set(),
        loadedNovelId: null,
        loading: false,
        saving: false,
        /** 右侧当前查看的备忘（只读）；编辑时也保持指向被编辑的备忘 */
        viewingId: null,
        /** 正在编辑已有备忘的 id；null 表示没有编辑已有备忘 */
        editingId: null,
        /** 正在编辑一条尚未保存的新备忘 */
        composing: false,
        /** 新备忘关联的阅读位置 { chapterIndex, page }，null = 不绑定 */
        anchor: null,
        /** 编辑器当前归属：null = 本书备忘，否则是分组 id */
        targetGroupId: null,
        query: '',
        pinnedOnly: false,
        sort: 'updated',
        /** 批量删除模式与已选条目 */
        batchMode: false,
        batchSelection: new Set(),
    },
    selection: new Set(),
    selectionAnchor: null,
    /** 网络找书：搜索结果、当前书目、在线阅读与下载状态 */
    online: {
        /** 搜索结果 [{ title, url, site, snippet }]；跨「加载更多」累积（已按「精准搜索」过滤） */
        results: [],
        /** 未过滤的原始搜索结果：勾选框来回切换时用它重算 results */
        rawResults: [],
        /** 合并前搜索引擎 / 书源返回的原始条数（卡片按书名+作者合并，条数和行数对不上时用它解释） */
        rawCount: 0,
        /** 上一次精准过滤的统计 { dropped, relaxed } */
        exactInfo: { dropped: 0, relaxed: false },
        query: '',
        searching: false,
        /** 结果列表的当前页（从 1 开始） */
        page: 1,
        /** 每页显示几条（跟设置同步） */
        pageSize: 5,
        /** 当前选中的网络书 { title, author, intro, cover, url, chapters } */
        book: null,
        loadingBook: false,
        abort: null,
        /** 打开书籍单独用一个 AbortController，避免和搜索互相清空 */
        bookAbort: null,
        /** 搜索期间打开书成功后的提示，等搜索结束再显示 */
        pendingBookNotice: '',
        /** NovelFetcher 实例，随设置重建 */
        fetcher: null,
        /** 正在在线阅读的网络书；null 表示当前读的是书架里的书 */
        reading: null,
        /** 下载到书架的进度 */
        download: {
            running: false,
            abort: null,
            done: 0,
            total: 0,
            failed: [],
            /** 番茄任务：进度文案、任务号、阶段（job / text / parse） */
            label: '',
            jobId: null,
            phase: '',
        },
        /** 书源聚合搜索：每个源的成败、当前启用的书源数量 */
        sourceReport: null,
        sourceCount: 0,
        /** 规则引擎运行时（书源搜索 / 详情 / 目录 / 正文 / 校验） */
        runtime: null,
        /**
         * 抓取桥接的状态：{ state: 'unknown' | 'ready' | 'missing' | 'error', version, downloader, error }
         * 番茄与书源共用同一个桥接，两边都要靠它判断「装没装、要不要提示」。
         */
        bridge: { state: 'unknown', version: '', downloader: '', error: '' },
        /** 桥接块上一次是为哪条通道刷新的（切换通道时要重新检查一次） */
        bridgeShownFor: '',
        /** 书源校验进度 */
        checking: false,
        checkAbort: null,
    },
    tab: 'library',
    importing: false,
    loadingNovel: false,
    summary: {
        running: false,
        abort: null,
        result: null,
        addingMemo: false,
    },
    /** 文风页：跟随酒馆当前选用的预设，只生成文风，不写预设 */
    style: {
        preset: null,
        entryId: '',
        plan: null,
        result: null,
        running: false,
        abort: null,
        lastReadAt: 0,
    },
    wbSelection: new Set(),
    wbSelectionAnchor: null,
    worldbook: {
        running: false,
        abort: null,
        result: null,
        loadedNovelId: null,
        loading: false,
        editingIndex: null,
        /** 已展开的分类折叠块（默认全部折叠，只存在内存里） */
        expanded: new Set(),
        /** 最近一次整理 / 合并前的条目快照，用于撤销 */
        undo: null,
        /** 整理、查重复核等批处理的状态 */
        ops: { running: false, abort: null, failed: [] },
    },
    styleSample: {
        novelId: null,
        chars: 0,
        text: '',
    },
    /** 角色卡的两条开局：小说开头 / 小说结尾的原文节选 */
    cardGreetings: {
        novelId: null,
        start: '',
        end: '',
    },
};

let orb = null;
let panel = null;
let elements = {};
let dragState = null;
let suppressOrbClick = false;

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function getContext() {
    return globalThis.SillyTavern?.getContext?.();
}

function toast(message, type = 'info') {
    const toastr = globalThis.toastr;
    const title = '小说阅读器';
    if (toastr?.[type]) {
        toastr[type](message, title);
        return;
    }
    if (type === 'error') console.error(`[小说阅读器] ${message}`);
    else console.log(`[小说阅读器] ${message}`);
}

function setStatus(text) {
    if (elements.headerStatus) elements.headerStatus.textContent = text;
}

function createElement(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

/** 带图标的按钮：图标用 innerHTML，避免把 <i> 当成文字显示出来 */
function createIconButton(tag, className, iconHtml, title = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (title) {
        node.title = title;
        node.setAttribute('aria-label', title);
    }
    node.innerHTML = iconHtml;
    return node;
}

function getSelectedMeta() {
    return state.chapters.filter(chapter => state.selection.has(chapter.index));
}

function getScope() {
    return panel?.querySelector('input[name="nr-scope"]:checked')?.value || 'selected';
}

function getTargetChars() {
    const settings = getSettings();
    const input = Number(elements.target?.value);
    return clamp(Number.isFinite(input) ? input : settings.targetChars, 100, 50000);
}

function makeUniqueTitle(title) {
    const existing = new Set(state.novels.map(novel => novel.title));
    if (!existing.has(title)) return title;
    let index = 2;
    while (existing.has(`${title} (${index})`)) index++;
    return `${title} (${index})`;
}

function formatPercent(value) {
    return `${clamp(Math.round(value), 0, 100)}%`;
}

/* ------------------------------------------------------------------ */
/* 初始化                                                              */
/* ------------------------------------------------------------------ */

function readReaderPrefs() {
    try {
        const raw = globalThis.localStorage?.getItem(READER_PREF_STORAGE);
        if (!raw) return null;
        const value = JSON.parse(raw);
        return value && typeof value === 'object' ? value : null;
    } catch {
        return null;
    }
}

function readMemoCollapsedNodes() {
    try {
        const raw = globalThis.localStorage?.getItem(MEMO_COLLAPSED_NODES_STORAGE);
        if (!raw) return new Set();
        const parsed = JSON.parse(raw);
        return new Set(Array.isArray(parsed) ? parsed.filter(key => typeof key === 'string') : []);
    } catch {
        return new Set();
    }
}

function persistMemoCollapsedNodes() {
    try {
        globalThis.localStorage?.setItem(
            MEMO_COLLAPSED_NODES_STORAGE,
            JSON.stringify([...state.memo.collapsedNodes]),
        );
    } catch (error) {
        console.warn('[小说阅读器] 保存备忘折叠状态失败', error);
    }
}

function restoreReaderPrefs() {
    const saved = readReaderPrefs();
    if (!saved) return;
    const settings = getSettings();
    for (const key of READER_PREF_KEYS) {
        if (!(key in saved)) continue;
        const value = saved[key];
        if (typeof value === 'number' && Number.isFinite(value)) {
            settings[key] = value;
        } else if (typeof value === 'string') {
            settings[key] = value;
        }
    }
}

function persistReaderPrefs() {
    try {
        const settings = getSettings();
        const value = {};
        for (const key of READER_PREF_KEYS) value[key] = settings[key];
        globalThis.localStorage?.setItem(READER_PREF_STORAGE, JSON.stringify(value));
    } catch (error) {
        console.warn('[小说阅读器] 保存阅读设置失败', error);
    }
}

/**
 * 角色卡内嵌世界书时自动导入并绑定（见 js/tavern.js）。
 */
function setupLorebookAutoImport() {
    try {
        installEmbeddedWorldbookAutoImport({
            isEnabled: () => getSettings().autoImportLorebook !== false,
            onImported: ({ character, name, existed }) => {
                const who = character?.name || '当前角色';
                toast(
                    existed
                        ? `世界书《${name}》已经存在，已直接绑定到「${who}」`
                        : `已自动导入世界书《${name}》并绑定到「${who}」`,
                    'success',
                );
            },
            onError: (error, info) => {
                console.warn('[小说阅读器] 自动导入内嵌世界书失败', error);
                toast(`自动导入「${info?.name || '内嵌世界书'}」失败：${error.message}`, 'warning');
            },
        });
    } catch (error) {
        console.warn('[小说阅读器] 注册内嵌世界书自动导入失败', error);
    }
}

export async function initUI() {
    if (globalThis.__novelReaderInited) return;
    const context = getContext();
    if (!context) {
        console.warn('[小说阅读器] 等待 SillyTavern 上下文…');
        setTimeout(initUI, 500);
        return;
    }
    globalThis.__novelReaderInited = true;
    getSettings();
    restoreReaderPrefs();
    state.memo.collapsedNodes = readMemoCollapsedNodes();

    buildOrb();
    buildPanel();
    bindEvents();
    bindOnlineEvents();
    renderOnlineSettings();
    restoreOrbPosition();
    setupLorebookAutoImport();
    setupPresetWatcher();

    state.tab = getSettings().lastTab || 'library';
    showTab(state.tab, { persist: false });
    renderSettings();
    await refreshLibrary();
    await loadMemoGroups();
    await restoreLastNovel();
    updateHeader();

    exposeDevApi();
    console.info('[小说阅读器] 已加载');
}

function buildOrb() {
    orb = document.createElement('button');
    orb.type = 'button';
    orb.id = 'nr-orb';
    orb.className = 'nr-orb';
    orb.title = '小说阅读器（Ctrl+Shift+N）';
    orb.setAttribute('aria-label', '打开小说阅读器');
    orb.innerHTML = '<i class="fa-solid fa-book-open"></i><span class="nr-orb-dot"></span>';
    document.body.prepend(orb);

    orb.addEventListener('click', event => {
        if (suppressOrbClick) {
            suppressOrbClick = false;
            event.preventDefault();
            return;
        }
        togglePanel();
    });

    orb.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        dragState = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            left: orb.offsetLeft,
            top: orb.offsetTop,
            moved: false,
        };
        orb.setPointerCapture?.(event.pointerId);
    });

    orb.addEventListener('pointermove', event => {
        if (!dragState || dragState.pointerId !== event.pointerId) return;
        const dx = event.clientX - dragState.startX;
        const dy = event.clientY - dragState.startY;
        if (!dragState.moved && Math.hypot(dx, dy) < 5) return;
        dragState.moved = true;
        const left = clamp(dragState.left + dx, 4, window.innerWidth - orb.offsetWidth - 4);
        const top = clamp(dragState.top + dy, 4, window.innerHeight - orb.offsetHeight - 4);
        orb.style.left = `${left}px`;
        orb.style.top = `${top}px`;
        orb.style.right = 'auto';
        orb.style.bottom = 'auto';
    });

    const endDrag = event => {
        if (!dragState || dragState.pointerId !== event.pointerId) return;
        const moved = dragState.moved;
        dragState = null;
        orb.releasePointerCapture?.(event.pointerId);
        if (moved) {
            suppressOrbClick = true;
            setTimeout(() => { suppressOrbClick = false; }, 60);
            saveOrbPosition();
        }
    };
    orb.addEventListener('pointerup', endDrag);
    orb.addEventListener('pointercancel', endDrag);
}

function restoreOrbPosition() {
    const settings = getSettings();
    const position = settings.orbPosition;
    if (position && Number.isFinite(position.left) && Number.isFinite(position.top)) {
        orb.style.left = `${clamp(position.left, 4, window.innerWidth - 60)}px`;
        orb.style.top = `${clamp(position.top, 4, window.innerHeight - 60)}px`;
        orb.style.right = 'auto';
        orb.style.bottom = 'auto';
    }
}

function saveOrbPosition() {
    const settings = getSettings();
    settings.orbPosition = { left: orb.offsetLeft, top: orb.offsetTop };
    saveSettings();
}

function buildPanel() {
    panel = document.createElement('div');
    panel.id = 'nr-panel';
    panel.className = 'nr-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', '小说阅读器');
    panel.setAttribute('aria-hidden', 'true');

    panel.innerHTML = `
        <header class="nr-header">
            <div class="nr-brand">
                <i class="fa-solid fa-book-open"></i>
                <span>小说阅读器</span>
                <span class="nr-header-status" id="nr-header-status">就绪</span>
            </div>
            <div class="nr-header-actions">
                <button type="button" class="nr-icon-btn" id="nr-refresh" title="刷新书架">
                    <i class="fa-solid fa-rotate"></i>
                </button>
                <button type="button" class="nr-icon-btn" id="nr-close" title="关闭（Esc）">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>
        </header>

        <nav class="nr-tabs" role="tablist">
            <button type="button" class="nr-tab is-active" data-tab="library" role="tab">
                <i class="fa-solid fa-book"></i><span>书架</span>
            </button>
            <button type="button" class="nr-tab" data-tab="online" role="tab">
                <i class="fa-solid fa-globe"></i><span>找书</span>
            </button>
            <button type="button" class="nr-tab" data-tab="reader" role="tab">
                <i class="fa-solid fa-book-open"></i><span>阅读</span>
            </button>
            <button type="button" class="nr-tab" data-tab="memo" role="tab">
                <i class="fa-solid fa-note-sticky"></i><span>备忘录</span>
                <span class="nr-tab-badge" id="nr-memo-tab-badge" hidden></span>
            </button>
            <button type="button" class="nr-tab" data-tab="summary" role="tab">
                <i class="fa-solid fa-wand-magic-sparkles"></i><span>总结</span>
            </button>
            <button type="button" class="nr-tab" data-tab="worldbook" role="tab">
                <i class="fa-solid fa-book-atlas"></i><span>世界书</span>
            </button>
            <button type="button" class="nr-tab" data-tab="style" role="tab">
                <i class="fa-solid fa-pen-nib"></i><span>文风</span>
            </button>
            <button type="button" class="nr-tab" data-tab="settings" role="tab">
                <i class="fa-solid fa-gear"></i><span>设置</span>
            </button>
        </nav>

        <div class="nr-body">
            <section class="nr-tabpane is-active" data-pane="library">
                <div class="nr-pane-pad">
                    <div class="nr-drop" id="nr-drop">
                        <i class="fa-solid fa-file-import"></i>
                        <div class="nr-drop-title">拖入小说文件，或 <button type="button" class="nr-link" id="nr-pick">选择文件</button></div>
                        <div class="nr-drop-hint">TXT / Markdown / HTML / EPUB / DOCX · 自动识别 GBK / UTF-8 编码与章节</div>
                        <input type="file" id="nr-file" multiple hidden
                            accept=".txt,.md,.markdown,.html,.htm,.xhtml,.epub,.docx,text/plain,text/markdown,text/html,application/epub+zip">
                    </div>
                    <div class="nr-inline-status" id="nr-import-status" hidden></div>
                    <div class="nr-shelf" id="nr-shelf">
                        <div class="nr-shelf-bar" id="nr-shelf-bar">
                            <div class="nr-shelf-top">
                                <h3>我的书架 <span class="nr-muted" id="nr-lib-count"></span></h3>
                                <div class="nr-shelf-top-actions">
                                    <button type="button" class="nr-btn nr-btn-sm" id="nr-shelf-manage">管理</button>
                                    <div class="nr-view-switch" role="group" aria-label="书架显示方式">
                                        <button type="button" data-view="list" title="列表视图" aria-pressed="false">
                                            <i class="fa-solid fa-list"></i><span>列表</span>
                                        </button>
                                        <button type="button" data-view="grid" class="is-active" title="书封视图" aria-pressed="true">
                                            <i class="fa-solid fa-table-cells-large"></i><span>书封</span>
                                        </button>
                                    </div>
                                </div>
                            </div>
                            <div class="nr-shelf-filters">
                                <label class="nr-shelf-field">
                                    <i class="fa-solid fa-layer-group" aria-hidden="true"></i>
                                    <select id="nr-shelf-group" class="nr-select nr-select-sm" aria-label="按分组筛选书架"></select>
                                </label>
                                <label class="nr-shelf-field">
                                    <i class="fa-solid fa-arrow-down-wide-short" aria-hidden="true"></i>
                                    <select id="nr-shelf-sort" class="nr-select nr-select-sm" aria-label="书架排序">
                                        <option value="readTime">按阅读时间</option>
                                        <option value="updateTime">按更新时间</option>
                                        <option value="title">按书名</option>
                                        <option value="manual">手动排序</option>
                                    </select>
                                </label>
                                <button type="button" class="nr-icon-btn nr-shelf-order" id="nr-shelf-order" title="切换正序 / 倒序"></button>
                                <div class="nr-shelf-search">
                                    <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
                                    <input id="nr-shelf-search" class="nr-input nr-input-sm" type="search"
                                        placeholder="搜索书架…" aria-label="搜索书架" autocomplete="off">
                                </div>
                                <button type="button" class="nr-link nr-shelf-groups-btn" id="nr-shelf-record">阅读记录</button>
                                <button type="button" class="nr-link nr-shelf-groups-btn" id="nr-shelf-groups">分组管理</button>
                            </div>
                            <div class="nr-shelf-bulk" id="nr-shelf-bulk" hidden>
                                <label class="nr-shelf-check">
                                    <input type="checkbox" id="nr-shelf-select-all">
                                    <span>全选</span>
                                </label>
                                <span class="nr-muted" id="nr-shelf-selected">已选 0 本</span>
                                <span class="nr-spacer"></span>
                                <button type="button" class="nr-btn nr-btn-sm" data-bulk="move">移入分组</button>
                                <button type="button" class="nr-btn nr-btn-sm" data-bulk="pin">置顶</button>
                                <button type="button" class="nr-btn nr-btn-sm" data-bulk="unpin">取消置顶</button>
                                <button type="button" class="nr-btn nr-btn-sm" data-bulk="update">更新章节</button>
                                <button type="button" class="nr-btn nr-btn-sm" data-bulk="up" data-manual-only hidden>上移</button>
                                <button type="button" class="nr-btn nr-btn-sm" data-bulk="down" data-manual-only hidden>下移</button>
                                <button type="button" class="nr-btn nr-btn-sm nr-danger" data-bulk="delete">删除</button>
                                <button type="button" class="nr-btn nr-btn-sm" data-bulk="cancel">完成</button>
                            </div>
                        </div>
                        <div class="nr-shelf-resume" id="nr-shelf-resume" hidden></div>
                        <div class="nr-novels" id="nr-novels"></div>
                    </div>
                </div>
            </section>

            <section class="nr-tabpane" data-pane="online">
                <div class="nr-pane-pad nr-online">
                    <!-- 上半部分（搜索栏 / 状态 / 结果列表）跟着一起滚；分页条和书籍卡片钉在下面 -->
                    <div class="nr-online-scroll" id="nr-ol-scroll">
                    <div class="nr-online-search">
                        <div class="nr-online-inputrow">
                            <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
                            <input id="nr-ol-query" class="nr-input" type="search" enterkeyhint="search"
                                placeholder="输入书名或作者，例如：诡秘之主" aria-label="搜索网络小说" autocomplete="off">
                            <button type="button" class="nr-btn nr-primary" id="nr-ol-search">搜索</button>
                            <button type="button" class="nr-btn" id="nr-ol-stop" hidden>停止</button>
                        </div>
                        <div class="nr-online-engines">
                            <label class="nr-field nr-field-inline">
                                <span>搜索通道</span>
                                <select id="nr-ol-engine" class="nr-select nr-select-sm"></select>
                            </label>
                            <label class="nr-field nr-field-inline">
                                <span>抓取通道</span>
                                <select id="nr-ol-channel" class="nr-select nr-select-sm"></select>
                            </label>
                            <label class="nr-online-exact" id="nr-ol-exact-field"
                                title="只看书名和关键词完全一致的（自动忽略「（精校版）」「[完结]」这类括号后缀和标点）">
                                <input type="checkbox" id="nr-ol-exact">
                                <span>精准搜索</span>
                            </label>
                        </div>
                        <div class="nr-online-hint" id="nr-ol-engine-hint" hidden>
                            <i class="fa-solid fa-circle-info" aria-hidden="true"></i>
                            <span class="nr-online-hint-body">
                                <span id="nr-ol-engine-hint-text"></span>
                            </span>
                        </div>
                        <div class="nr-online-history" id="nr-ol-history" hidden></div>
                        <div class="nr-online-tools">
                            <button type="button" class="nr-link" id="nr-ol-source-manage">书源管理</button>
                            <button type="button" class="nr-link" id="nr-ol-explore">发现</button>
                            <span class="nr-online-source-summary" id="nr-ol-source-summary" hidden></span>
                            <button type="button" class="nr-link" id="nr-ol-settings-toggle" aria-expanded="false">抓取设置</button>
                        </div>
                        <div class="nr-online-install" id="nr-ol-bridge" hidden>
                            <div class="nr-online-install-head">
                                <strong id="nr-ol-bridge-title">番茄桥接 · 安装 / 卸载</strong>
                                <button type="button" class="nr-link" id="nr-ol-bridge-check">刷新</button>
                            </div>
                            <div class="nr-muted" id="nr-ol-bridge-status">正在检查番茄桥接…</div>
                            <div class="nr-online-install-list" id="nr-ol-install-list"></div>
                            <div class="nr-muted" id="nr-ol-install-note"></div>
                        </div>
                        <div class="nr-online-settings" id="nr-ol-settings" hidden>
                            <label class="nr-field">
                                <span>抓取桥接地址（番茄 / 书源共用；同源路由，别填下载器地址）</span>
                                <input id="nr-ol-fanqie-bridge" class="nr-input" placeholder="/api/plugins/fanqie-bridge">
                            </label>
                            <label class="nr-field">
                                <span>番茄下载器地址（留空 = 桥接默认 127.0.0.1:18423）</span>
                                <input id="nr-ol-fanqie-upstream" class="nr-input" placeholder="http://127.0.0.1:18423">
                            </label>
                            <label class="nr-field">
                                <span>CORS 代理地址（支持 {url} / {raw} 占位）</span>
                                <input id="nr-ol-proxy" class="nr-input" placeholder="https://your-proxy.example/?url={url}">
                            </label>
                            <label class="nr-field">
                                <span>并发抓取</span>
                                <input id="nr-ol-concurrency" class="nr-input" type="number" min="1" max="16" step="1">
                            </label>
                            <label class="nr-field">
                                <span>单章超时（毫秒）</span>
                                <input id="nr-ol-chapter-timeout" class="nr-input" type="number" min="5000" max="120000" step="1000">
                            </label>
                            <label class="nr-field nr-field-inline" id="nr-ol-respect-rate-field">
                                <span>遵守书源的并发率</span>
                                <input id="nr-ol-respect-rate" type="checkbox">
                                <span class="nr-muted">关掉才能吃满上面的并发数（书源常写 1/1000，等于一秒一章）</span>
                            </label>
                            <label class="nr-field">
                                <span>单次超时（毫秒）</span>
                                <input id="nr-ol-timeout" class="nr-input" type="number" min="3000" max="120000" step="1000">
                            </label>
                            <label class="nr-field" id="nr-ol-sort-field">
                                <span>书源结果排序</span>
                                <select id="nr-ol-sort" class="nr-select">
                                    <option value="source">按书源顺序（阅读的做法）</option>
                                    <option value="title">按书名</option>
                                    <option value="arrival">按搜到的先后</option>
                                </select>
                            </label>
                            <label class="nr-field">
                                <span>下载章节上限（0 = 全部）</span>
                                <input id="nr-ol-limit" class="nr-input" type="number" min="0" step="1">
                            </label>
                            <div class="nr-online-settings-hint">
                                抓取默认走酒馆自带的网页通道，不用配置；只有当酒馆通道取不到时，才会退到代理和直连兜底。
                            </div>
                        </div>
                        <div class="nr-online-urlrow">
                            <input id="nr-ol-url" class="nr-input" type="url" placeholder="也可以直接粘贴书籍页 / 章节页链接">
                            <button type="button" class="nr-btn" id="nr-ol-open">打开链接</button>
                        </div>
                    </div>
                    <div class="nr-inline-status" id="nr-ol-status" hidden></div>
                    <div class="nr-online-results-head" id="nr-ol-results-head" hidden>
                        <span class="nr-online-results-count" id="nr-ol-results-count">0 条结果</span>
                        <label class="nr-online-pagesize">
                            <span>每页</span>
                            <select id="nr-ol-page-size" class="nr-select nr-select-sm" aria-label="每页显示几条结果">
                                <option value="5">5 条</option>
                                <option value="10">10 条</option>
                                <option value="20">20 条</option>
                                <option value="50">50 条</option>
                            </select>
                        </label>
                    </div>
                    <div class="nr-online-results" id="nr-ol-results"></div>
                    </div>
                    <nav class="nr-online-pager" id="nr-ol-pager" aria-label="搜索结果分页" hidden></nav>
                    <div class="nr-online-book" id="nr-ol-book" hidden></div>
                </div>
            </section>

            <section class="nr-tabpane" data-pane="reader">
                <div class="nr-reader" id="nr-reader">
                    <aside class="nr-side">
                        <div class="nr-side-top">
                            <select id="nr-reader-select" class="nr-select" aria-label="选择小说"></select>
                            <div class="nr-chapter-tools">
                                <input id="nr-chapter-filter" class="nr-input" placeholder="搜索章节…">
                                <button type="button" class="nr-icon-btn" id="nr-chapter-order" title="切换正序 / 倒序"></button>
                            </div>
                        </div>
                        <div class="nr-chapter-list" id="nr-chapter-list"></div>
                    </aside>
                    <main class="nr-read-main">
                        <div class="nr-read-toolbar">
                            <div class="nr-read-search">
                                <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
                                <input id="nr-read-search" class="nr-input nr-input-sm" type="search" enterkeyhint="search"
                                    placeholder="搜索整本小说…" aria-label="搜索整本小说内容" autocomplete="off">
                                <button type="button" class="nr-btn nr-btn-sm" id="nr-read-search-btn">搜索</button>
                            </div>
                            <span class="nr-spacer"></span>
                            <button type="button" class="nr-btn nr-btn-sm" id="nr-font-minus" title="减小字号">A-</button>
                            <button type="button" class="nr-btn nr-btn-sm" id="nr-font-plus" title="增大字号">A+</button>
                            <button type="button" class="nr-btn nr-btn-sm nr-memo-quick" id="nr-memo-quick" title="为当前阅读位置记一条备忘">
                                <i class="fa-solid fa-note-sticky"></i> 备忘
                                <span class="nr-memo-quick-count" id="nr-memo-quick-count" hidden></span>
                            </button>
                            <button type="button" class="nr-btn nr-btn-sm" id="nr-reader-change-source" hidden title="这本书读不下去了？换一个书源的同名书">
                                <i class="fa-solid fa-right-left"></i> 换源
                            </button>
                            <button type="button" class="nr-btn nr-btn-sm" id="nr-bookmark-btn" title="书签：添加当前页 / 查看书签">
                                <i class="fa-solid fa-bookmark"></i> 书签
                            </button>
                            <button type="button" class="nr-btn nr-btn-sm" id="nr-tts-btn" title="朗读当前页">
                                <i class="fa-solid fa-volume-high"></i> 朗读
                            </button>
                            <button type="button" class="nr-btn nr-btn-sm" id="nr-reader-settings-btn" title="阅读设置" aria-expanded="false">
                                <i class="fa-solid fa-sliders"></i> 阅读设置
                            </button>
                            <span class="nr-online-badge" id="nr-reader-online-badge" title="这本书正在边读边抓，还没存进书架" hidden>
                                <i class="fa-solid fa-globe"></i> 在线阅读
                            </span>
                            <button type="button" class="nr-btn nr-btn-sm nr-accent" id="nr-reader-download" title="把这本网络小说抓全并保存到书架" hidden>
                                <i class="fa-solid fa-download"></i> 下载本书
                            </button>
                            <button type="button" class="nr-btn nr-btn-sm nr-accent" id="nr-sum-this">总结本章</button>
                        </div>

                        <div class="nr-search-panel" id="nr-search-panel" hidden>
                            <div class="nr-search-head">
                                <span id="nr-search-status">输入关键词，搜索整本小说</span>
                                <div class="nr-search-actions">
                                    <button type="button" class="nr-link" id="nr-search-clear" hidden>清空</button>
                                    <button type="button" class="nr-icon-btn" id="nr-search-close" title="关闭搜索结果">
                                        <i class="fa-solid fa-xmark"></i>
                                    </button>
                                </div>
                            </div>
                            <div class="nr-search-results" id="nr-search-results"></div>
                        </div>

                        <div class="nr-reader-settings" id="nr-reader-settings" hidden>
                            <div class="nr-reader-settings-head">
                                <strong>阅读设置</strong>
                                <button type="button" class="nr-icon-btn" id="nr-reader-settings-close" title="关闭阅读设置">
                                    <i class="fa-solid fa-xmark"></i>
                                </button>
                            </div>
                            <div class="nr-reader-settings-grid">
                                <label class="nr-field">
                                    <span>主题</span>
                                    <select id="nr-reader-theme" class="nr-select">
                                        <option value="auto">跟随酒馆</option>
                                        <option value="paper">米白</option>
                                        <option value="sepia">羊皮纸</option>
                                        <option value="green">护眼绿</option>
                                        <option value="dark">夜间</option>
                                    </select>
                                </label>
                                <label class="nr-field">
                                    <span>字体</span>
                                    <select id="nr-reader-font" class="nr-select">
                                        <option value="system">系统默认</option>
                                        <option value="serif">宋体 / 衬线</option>
                                        <option value="sans">黑体 / 无衬线</option>
                                        <option value="kai">楷体</option>
                                    </select>
                                </label>
                                <label class="nr-field">
                                    <span>字号 <output id="nr-reader-size-value">17</output> px</span>
                                    <input id="nr-reader-size" type="range" min="12" max="32" step="1">
                                </label>
                                <label class="nr-field">
                                    <span>行距 <output id="nr-reader-line-height-value">2.0</output></span>
                                    <input id="nr-reader-line-height" type="range" min="1.4" max="2.8" step="0.1">
                                </label>
                                <label class="nr-field">
                                    <span>段间距 <output id="nr-reader-para-gap-value">0.9</output> em</span>
                                    <input id="nr-reader-para-gap" type="range" min="0" max="2" step="0.1">
                                </label>
                                <label class="nr-field">
                                    <span>版心宽度 <output id="nr-reader-width-value">820</output> px</span>
                                    <input id="nr-reader-width" type="range" min="560" max="1100" step="20">
                                </label>
                                <label class="nr-field">
                                    <span>首行缩进 <output id="nr-reader-indent-value">2</output> 字</span>
                                    <input id="nr-reader-indent" type="range" min="0" max="3" step="0.5">
                                </label>
                                <label class="nr-field">
                                    <span>字间距 <output id="nr-reader-letter-spacing-value">0.01</output> em</span>
                                    <input id="nr-reader-letter-spacing" type="range" min="0" max="0.08" step="0.01">
                                </label>
                                <label class="nr-field">
                                    <span>正文对齐</span>
                                    <select id="nr-reader-align" class="nr-select">
                                        <option value="justify">两端对齐</option>
                                        <option value="left">左对齐</option>
                                    </select>
                                </label>
                                <label class="nr-field">
                                    <span>每页字数</span>
                                    <select id="nr-reader-page-chars" class="nr-select">
                                        <option value="1200">1200（手机）</option>
                                        <option value="2400">2400（小屏）</option>
                                        <option value="3400">3400</option>
                                        <option value="4600">4600（默认）</option>
                                        <option value="6500">6500（大屏）</option>
                                        <option value="8000">8000</option>
                                    </select>
                                </label>
                                <label class="nr-field">
                                    <span>翻页动画</span>
                                    <select id="nr-reader-page-turn" class="nr-select">
                                        <option value="none">无动画</option>
                                        <option value="fade">淡入淡出</option>
                                        <option value="slide">横向滑动</option>
                                        <option value="cover">覆盖翻页</option>
                                        <option value="flip">仿真翻页</option>
                                    </select>
                                </label>
                                <label class="nr-field">
                                    <span>朗读语速</span>
                                    <select id="nr-reader-tts-rate" class="nr-select">
                                        <option value="0.75">0.75×</option>
                                        <option value="1">1×</option>
                                        <option value="1.25">1.25×</option>
                                        <option value="1.5">1.5×</option>
                                        <option value="2">2×</option>
                                    </select>
                                </label>
                                <div class="nr-field">
                                    <span>替换净化</span>
                                    <button type="button" class="nr-btn nr-btn-sm" id="nr-reader-replace-rules">管理规则</button>
                                </div>
                            </div>
                            <div class="nr-reader-settings-foot">
                                <span class="nr-muted" id="nr-reader-settings-status">修改后立即预览，并自动保存</span>
                                <button type="button" class="nr-btn nr-btn-sm" id="nr-reader-reset">恢复默认</button>
                            </div>
                        </div>

                        <div class="nr-read-scroll" id="nr-read-scroll">
                            <div class="nr-empty" id="nr-reader-empty">
                                <i class="fa-solid fa-book-open"></i>
                                <p>从书架打开一本小说开始阅读</p>
                            </div>
                            <article class="nr-article" id="nr-article" hidden>
                                <div class="nr-article-meta" id="nr-article-meta"></div>
                                <h2 id="nr-article-title"></h2>
                                <div class="nr-article-images" id="nr-article-images" hidden></div>
                                <div class="nr-article-text" id="nr-article-text"></div>
                            </article>
                        </div>
                        <div class="nr-read-footer">
                            <button type="button" class="nr-btn nr-btn-sm" id="nr-chapter-prev">上一章</button>
                            <button type="button" class="nr-btn nr-btn-sm" id="nr-page-prev">上一页</button>
                            <span id="nr-page-info" class="nr-page-info">—</span>
                            <button type="button" class="nr-btn nr-btn-sm" id="nr-page-next">下一页</button>
                            <button type="button" class="nr-btn nr-btn-sm" id="nr-chapter-next">下一章</button>
                        </div>
                    </main>
                </div>
            </section>

            <section class="nr-tabpane" data-pane="memo">
                <div class="nr-memo">
                    <aside class="nr-side">
                        <div class="nr-side-top">
                            <select id="nr-memo-select" class="nr-select" aria-label="选择小说"></select>
                            <input id="nr-memo-filter" class="nr-input nr-input-sm" type="search" enterkeyhint="search"
                                placeholder="搜索标题或正文…" aria-label="搜索备忘" autocomplete="off">
                            <div class="nr-memo-tools">
                                <label class="nr-check nr-check-sm">
                                    <input id="nr-memo-pinned" type="checkbox">
                                    <span>只看置顶</span>
                                </label>
                                <select id="nr-memo-sort" class="nr-select nr-select-sm" aria-label="备忘排序">
                                    <option value="updated">最近更新</option>
                                    <option value="created">最近创建</option>
                                    <option value="title">按标题</option>
                                    <option value="chapter">按章节</option>
                                </select>
                            </div>
                        </div>

                        <div class="nr-memo-list-head">
                            <span class="nr-memo-list-title" id="nr-memo-list-title">备忘录</span>
                            <span class="nr-muted" id="nr-memo-list-count"></span>
                            <button type="button" class="nr-link" id="nr-memo-batch">批量删除</button>
                        </div>
                        <div class="nr-memo-tree" id="nr-memo-tree"></div>
                        <div class="nr-memo-batch-foot" id="nr-memo-list-foot" hidden>
                            <span id="nr-memo-batch-count">已选 0 条</span>
                            <button type="button" class="nr-link" id="nr-memo-batch-all">全选</button>
                            <button type="button" class="nr-btn nr-btn-sm nr-danger" id="nr-memo-batch-delete" disabled>删除所选</button>
                            <button type="button" class="nr-link" id="nr-memo-batch-cancel">取消</button>
                        </div>
                        <div class="nr-memo-count" id="nr-memo-count">0 条备忘</div>
                    </aside>

                    <main class="nr-memo-main" id="nr-memo-main">
                        <div class="nr-memo-head">
                            <div class="nr-memo-head-title">
                                <strong>备忘录</strong>
                                <span class="nr-muted" id="nr-memo-head-meta">只保存在本机</span>
                            </div>
                            <div class="nr-memo-head-actions">
                                <button type="button" class="nr-btn nr-btn-sm" id="nr-memo-new">新建</button>
                                <button type="button" class="nr-btn nr-btn-sm" id="nr-memo-back-reader">回到阅读</button>
                                <button type="button" class="nr-btn nr-btn-sm" id="nr-memo-export">导出</button>
                            </div>
                        </div>

                        <div class="nr-memo-view" id="nr-memo-view" hidden>
                            <div class="nr-memo-view-head">
                                <div class="nr-memo-view-title">
                                    <strong id="nr-memo-view-title"></strong>
                                    <i class="fa-solid fa-thumbtack nr-memo-pin-icon" id="nr-memo-view-pin-icon" hidden></i>
                                    <span class="nr-badge" id="nr-memo-view-group" hidden></span>
                                </div>
                                <div class="nr-memo-view-actions">
                                    <button type="button" class="nr-btn nr-btn-sm" id="nr-memo-view-jump" hidden>跳到原文</button>
                                    <button type="button" class="nr-btn nr-btn-sm" id="nr-memo-view-pin">置顶</button>
                                    <button type="button" class="nr-btn nr-btn-sm" id="nr-memo-view-copy">复制内容</button>
                                    <button type="button" class="nr-btn nr-btn-sm nr-primary" id="nr-memo-view-edit">编辑</button>
                                    <button type="button" class="nr-btn nr-btn-sm nr-danger" id="nr-memo-view-delete">删除</button>
                                </div>
                            </div>
                            <div class="nr-memo-view-meta" id="nr-memo-view-meta"></div>
                            <div class="nr-memo-view-body" id="nr-memo-view-body"></div>
                        </div>

                        <div class="nr-memo-editor" id="nr-memo-editor">
                            <div class="nr-memo-editor-head">
                                <strong id="nr-memo-editor-title">写一条备忘</strong>
                                <span class="nr-muted" id="nr-memo-editor-hint">不会发送给模型</span>
                            </div>
                            <input id="nr-memo-title" class="nr-input" maxlength="80" placeholder="标题（留空时取正文第一行）" aria-label="备忘标题">
                            <div class="nr-memo-target-row">
                                <label class="nr-field nr-field-inline" for="nr-memo-group">
                                    <span>归属</span>
                                    <select id="nr-memo-group" class="nr-select"></select>
                                </label>
                                <span class="nr-muted" id="nr-memo-target-hint"></span>
                            </div>
                            <textarea id="nr-memo-content" class="nr-input nr-memo-input" maxlength="20000"
                                placeholder="记下人物、伏笔、疑问，或写给自己的一句话…（Ctrl / ⌘ + Enter 保存）"
                                aria-label="备忘内容"></textarea>
                            <div class="nr-memo-editor-foot">
                                <div class="nr-memo-anchor">
                                    <i class="fa-solid fa-location-dot" aria-hidden="true"></i>
                                    <span class="nr-memo-anchor-label" id="nr-memo-anchor-label">不绑定阅读位置</span>
                                    <button type="button" class="nr-link" id="nr-memo-use-position">关联当前阅读位置</button>
                                    <button type="button" class="nr-link" id="nr-memo-clear-anchor" hidden>清除位置</button>
                                </div>
                                <span class="nr-spacer"></span>
                                <button type="button" class="nr-btn nr-btn-sm" id="nr-memo-cancel">取消</button>
                                <button type="button" class="nr-btn nr-btn-sm nr-primary" id="nr-memo-save">保存备忘</button>
                            </div>
                        </div>

                        <div class="nr-empty nr-memo-empty" id="nr-memo-empty" hidden>
                            <i class="fa-solid fa-note-sticky"></i>
                            <p id="nr-memo-empty-text">先在书架打开一本小说，或新建一个分组</p>
                        </div>
                    </main>
                </div>
            </section>

            <section class="nr-tabpane" data-pane="summary">
                <div class="nr-summary">
                    <aside class="nr-side">
                        <div class="nr-side-top">
                            <select id="nr-summary-select" class="nr-select" aria-label="选择小说"></select>
                            <div class="nr-scope" role="radiogroup" aria-label="总结范围">
                                <label><input type="radio" name="nr-scope" value="all" checked> 整本</label>
                                <label><input type="radio" name="nr-scope" value="selected"> 选中章节</label>
                            </div>
                            <div class="nr-mini-tools">
                                <button type="button" class="nr-link" data-scope-act="all">全选</button>
                                <button type="button" class="nr-link" data-scope-act="invert">反选</button>
                                <button type="button" class="nr-link" data-scope-act="none">清空</button>
                            </div>
                            <input id="nr-summary-filter" class="nr-input nr-input-sm" placeholder="筛选章节…">
                        </div>
                        <div class="nr-chapter-list nr-check-list" id="nr-summary-chapters"></div>
                        <div class="nr-select-count" id="nr-select-count">已选 0 章</div>
                    </aside>
                    <main class="nr-sum-main">
                        <div class="nr-sum-config">
                            <div class="nr-field">
                                <label for="nr-target">总结字数上限</label>
                                <div class="nr-input-row">
                                    <input id="nr-target" type="number" min="100" max="50000" step="50" class="nr-input">
                                    <span class="nr-unit">字</span>
                                </div>
                                <div class="nr-presets">
                                    <button type="button" data-target="300">300</button>
                                    <button type="button" data-target="500">500</button>
                                    <button type="button" data-target="800">800</button>
                                    <button type="button" data-target="1200">1200</button>
                                    <button type="button" data-target="2000">2000</button>
                                </div>
                            </div>
                            <div class="nr-field">
                                <label for="nr-style">总结风格</label>
                                <select id="nr-style" class="nr-select"></select>
                            </div>
                            <div class="nr-field nr-field-wide">
                                <label for="nr-extra">附加要求（可选）</label>
                                <input id="nr-extra" class="nr-input" placeholder="例如：重点写主角的成长，保留结局反转">
                            </div>
                            <div class="nr-budget" id="nr-budget"></div>
                            <div class="nr-run-row">
                                <button type="button" class="nr-btn nr-primary" id="nr-run">开始总结</button>
                                <button type="button" class="nr-btn nr-danger" id="nr-stop" hidden>停止</button>
                            </div>
                        </div>

                        <div class="nr-progress" id="nr-progress" hidden>
                            <div class="nr-progress-head">
                                <span id="nr-progress-text">准备中…</span>
                                <span id="nr-progress-pct"></span>
                            </div>
                            <div class="nr-progress-track"><div class="nr-progress-bar" id="nr-progress-bar"></div></div>
                            <details class="nr-log-wrap" open>
                                <summary>运行日志</summary>
                                <div class="nr-log" id="nr-log"></div>
                            </details>
                        </div>

                        <div class="nr-result" id="nr-result" hidden>
                            <div class="nr-result-head">
                                <strong>总结结果</strong>
                                <span id="nr-result-meta" class="nr-muted"></span>
                                <div class="nr-result-actions">
                                    <button type="button" class="nr-btn nr-btn-sm" id="nr-result-memo" title="把总结内容加入对应小说的备忘">添加到备忘</button>
                                    <button type="button" class="nr-btn nr-btn-sm" id="nr-copy" title="复制到剪贴板">复制</button>
                                    <button type="button" class="nr-btn nr-btn-sm" id="nr-download" title="下载为 TXT">下载</button>
                                    <button type="button" class="nr-btn nr-btn-sm" id="nr-insert" title="插入酒馆输入框">插入输入框</button>
                                    <button type="button" class="nr-btn nr-btn-sm" id="nr-result-close" title="关闭总结结果">关闭</button>
                                </div>
                            </div>
                            <div class="nr-result-text" id="nr-result-text"></div>
                        </div>

                        <details class="nr-history" id="nr-history">
                            <summary>历史总结 <span id="nr-history-count" class="nr-muted"></span></summary>
                            <div id="nr-history-list" class="nr-history-list"></div>
                        </details>
                    </main>
                </div>
            </section>

            <section class="nr-tabpane" data-pane="worldbook">
                <div class="nr-worldbook">
                    <aside class="nr-side">
                        <div class="nr-side-top">
                            <select id="nr-wb-select" class="nr-select" aria-label="选择小说"></select>
                            <div class="nr-scope" role="radiogroup" aria-label="世界书提取范围">
                                <label><input type="radio" name="nr-wb-scope" value="all" checked> 整本</label>
                                <label><input type="radio" name="nr-wb-scope" value="selected"> 选中章节</label>
                            </div>
                            <div class="nr-mini-tools">
                                <button type="button" class="nr-link" data-wb-scope-act="all">全选</button>
                                <button type="button" class="nr-link" data-wb-scope-act="invert">反选</button>
                                <button type="button" class="nr-link" data-wb-scope-act="none">清空</button>
                            </div>
                            <input id="nr-wb-filter" class="nr-input nr-input-sm" placeholder="筛选章节…">
                        </div>
                        <div class="nr-chapter-list nr-check-list" id="nr-wb-chapters"></div>
                        <div class="nr-select-count" id="nr-wb-select-count">已选 0 章</div>
                    </aside>

                    <main class="nr-wb-main">
                        <div class="nr-wb-config">
                            <div class="nr-wb-config-head">
                                <div>
                                    <strong><i class="fa-solid fa-book-atlas"></i> 从小说提取世界书</strong>
                                    <p class="nr-help">支持书架中所有格式：TXT / Markdown / HTML / EPUB / DOCX。选定章节后，AI 会按块提取角色、地点、组织等条目，再合并为 SillyTavern 世界书。除默认三类外，还可以按需打开种族、道具、能力、剧情、设定、关系、时间线、伏笔。</p>
                                </div>
                                <div class="nr-wb-import-row">
                                    <button type="button" class="nr-btn nr-btn-sm" id="nr-wb-import">导入新文件</button>
                                    <input type="file" id="nr-wb-file" multiple hidden
                                        accept=".txt,.md,.markdown,.html,.htm,.xhtml,.epub,.docx,text/plain,text/markdown,text/html,application/epub+zip">
                                </div>
                            </div>

                            <div class="nr-wb-cats" id="nr-wb-cats"></div>
                            <div class="nr-wb-options">
                                <label class="nr-field">
                                    <span>每块原文字数</span>
                                    <input id="nr-wb-chunk-chars" type="number" min="1200" max="30000" step="500" class="nr-input">
                                </label>
                                <label class="nr-field">
                                    <span>并发块数</span>
                                    <select id="nr-wb-concurrency" class="nr-select">
                                        <option value="1">1（串行，最稳）</option>
                                        <option value="2">2</option>
                                        <option value="3">3</option>
                                        <option value="4">4（最快）</option>
                                    </select>
                                </label>
                                <label class="nr-field">
                                    <span>单条字数上限</span>
                                    <input id="nr-wb-entry-chars" type="number" min="120" max="2000" step="50" class="nr-input">
                                </label>
                                <label class="nr-field">
                                    <span>剧情条目数</span>
                                    <select id="nr-wb-plot-entries" class="nr-select"></select>
                                </label>
                                <label class="nr-field nr-field-wide">
                                    <span>附加提取要求（可选）</span>
                                    <input id="nr-wb-extra" class="nr-input" placeholder="例如：只提取与主角有关的人物；保留所有称号和别名">
                                </label>
                            </div>
                            <div class="nr-budget" id="nr-wb-budget"></div>
                            <div class="nr-run-row">
                                <button type="button" class="nr-btn nr-primary" id="nr-wb-run">生成世界书</button>
                                <button type="button" class="nr-btn nr-danger" id="nr-wb-stop" hidden>停止</button>
                            </div>
                        </div>

                        <div class="nr-progress" id="nr-wb-progress" hidden>
                            <div class="nr-progress-head">
                                <span id="nr-wb-progress-text">准备中…</span>
                                <span id="nr-wb-progress-pct"></span>
                            </div>
                            <div class="nr-progress-track"><div class="nr-progress-bar" id="nr-wb-progress-bar"></div></div>
                            <details class="nr-log-wrap" open>
                                <summary>运行日志</summary>
                                <div class="nr-log" id="nr-wb-log"></div>
                            </details>
                        </div>

                        <div class="nr-wb-result" id="nr-wb-result" hidden>
                            <div class="nr-wb-result-head">
                                <div>
                                    <strong>世界书结果</strong>
                                    <span id="nr-wb-result-meta" class="nr-muted"></span>
                                </div>
                                <div class="nr-wb-result-actions">
                                    <button type="button" class="nr-btn nr-btn-sm nr-primary" id="nr-wb-import-tavern">导入到酒馆</button>
                                    <button type="button" class="nr-btn nr-btn-sm" id="nr-wb-download-card">下载角色卡</button>
                                    <button type="button" class="nr-btn nr-btn-sm" id="nr-wb-download">下载世界书</button>
                                    <button type="button" class="nr-btn nr-btn-sm" id="nr-wb-to-style">生成文风</button>
                                    <button type="button" class="nr-btn nr-btn-sm nr-danger" id="nr-wb-clear">清空</button>
                                </div>
                            </div>
                            <div class="nr-help nr-wb-download-hint">「导入到酒馆」会把当前条目写进酒馆世界书列表，并同时导入一张绑定这本世界书的角色卡；名字重复时自动加「（2）」「（3）」共存，不会覆盖已有内容。「下载」只保存文件，需要你手动导入。下载角色卡时会附带两条初始消息：「故事开始」和「故事结尾」，分别取小说开头与结尾的原文。想要贴合原著的文风，去「文风」页按酒馆当前选用的预设生成。</div>
                            <div class="nr-wb-name-row">
                                <label for="nr-wb-name">世界书名</label>
                                <input id="nr-wb-name" class="nr-input" maxlength="80">
                                <span class="nr-muted">下载世界书 / 角色卡时使用这个名称。</span>
                            </div>
                            <div class="nr-wb-toolbar">
                                <button type="button" class="nr-link" id="nr-wb-select-all">全选</button>
                                <button type="button" class="nr-link" id="nr-wb-select-none">全不选</button>
                                <button type="button" class="nr-link" id="nr-wb-add-entry">＋ 新增条目</button>
                                <span class="nr-muted" id="nr-wb-entry-count"></span>
                            </div>
                            <div class="nr-wb-organize-bar">
                                <span class="nr-wb-organize-label">整理与合并</span>
                                <button type="button" class="nr-btn nr-btn-sm" id="nr-wb-organize">整理条目</button>
                                <button type="button" class="nr-btn nr-btn-sm" id="nr-wb-merge">合并条目</button>
                                <button type="button" class="nr-btn nr-btn-sm" id="nr-wb-dedupe">查重合并</button>
                                <button type="button" class="nr-btn nr-btn-sm" id="nr-wb-undo" disabled>撤销</button>
                                <span class="nr-wb-dedupe-hint" id="nr-wb-dedupe-hint" hidden></span>
                            </div>
                            <div class="nr-wb-entries" id="nr-wb-entries"></div>
                        </div>
                    </main>
                </div>
            </section>

            <section class="nr-tabpane" data-pane="style">
                <div class="nr-style">
                    <aside class="nr-side">
                        <div class="nr-side-top">
                            <select id="nr-st-novel" class="nr-select" aria-label="选择小说"></select>
                            <div class="nr-st-preset" id="nr-st-preset"></div>
                        </div>
                        <div class="nr-st-tips">
                            <p><i class="fa-solid fa-circle-info"></i> 排版、包裹标签、条目符号都跟着上面这份预设走；换了预设会重新读一遍。</p>
                            <p>生成时只把排版骨架发给模型，预设条目里的旧文风正文不会发送；正文写法只从当前小说原文里提炼。</p>
                            <p>插件只生成「怎么写」，不会写进你的预设。生成后自己复制进预设对应条目。</p>
                        </div>
                    </aside>
                    <main class="nr-st-main">
                        <div class="nr-st-config">
                            <div class="nr-field nr-field-wide">
                                <label for="nr-st-entry">文风条目（只取排版 + 粘贴位置）</label>
                                <select id="nr-st-entry" class="nr-select"></select>
                                <p class="nr-help" id="nr-st-entry-help"></p>
                            </div>
                            <div class="nr-field nr-field-wide">
                                <label for="nr-st-extra">这次想要的调整（可选）</label>
                                <input id="nr-st-extra" class="nr-input" placeholder="例如：更冷硬、少比喻、对白更多">
                            </div>
                            <div class="nr-st-format" id="nr-st-format"></div>
                            <div class="nr-st-status" id="nr-st-status"></div>
                            <div class="nr-run-row">
                                <button type="button" class="nr-btn nr-primary" id="nr-st-run">生成文风</button>
                                <button type="button" class="nr-btn nr-danger" id="nr-st-stop" hidden>停止</button>
                                <button type="button" class="nr-btn" id="nr-st-refresh">重新读取预设</button>
                            </div>
                        </div>

                        <div class="nr-st-stale" id="nr-st-stale" hidden></div>

                        <div class="nr-st-result" id="nr-st-result" hidden>
                            <div class="nr-st-result-head">
                                <div>
                                    <strong>生成结果</strong>
                                    <span class="nr-muted" id="nr-st-result-meta"></span>
                                </div>
                                <div class="nr-st-result-actions">
                                    <button type="button" class="nr-btn nr-btn-sm nr-primary" id="nr-st-copy">复制</button>
                                    <button type="button" class="nr-btn nr-btn-sm" id="nr-st-again">重新生成</button>
                                </div>
                            </div>
                            <textarea id="nr-st-output" class="nr-input nr-st-output" spellcheck="false"></textarea>
                            <div class="nr-st-check" id="nr-st-check"></div>
                            <div class="nr-help" id="nr-st-paste"></div>
                        </div>
                    </main>
                </div>
            </section>

            <section class="nr-tabpane" data-pane="settings">
                <div class="nr-settings">
                    <div class="nr-settings-grid">
                        <fieldset>
                            <legend>生成连接</legend>
                            <label class="nr-field">
                                <span>使用哪条连接</span>
                                <select id="nr-provider" class="nr-select">
                                    <option value="current">当前酒馆连接（推荐）</option>
                                    <option value="profile">连接管理中的配置</option>
                                </select>
                            </label>
                            <label class="nr-field">
                                <span>连接配置</span>
                                <select id="nr-profile" class="nr-select"></select>
                            </label>
                            <p class="nr-help">总结会调用你在酒馆里配置的模型；使用连接管理可以给总结单独指定一个便宜/长上下文的模型。</p>
                        </fieldset>

                        <fieldset>
                            <legend>上下文与预算</legend>
                            <label class="nr-field">
                                <span>上下文 token 上限</span>
                                <input id="nr-context-tokens" type="number" min="0" step="512" class="nr-input">
                            </label>
                            <p class="nr-help" id="nr-context-help">0 = 自动跟随酒馆上下文设置</p>
                            <label class="nr-field">
                                <span>上下文占用比例</span>
                                <input id="nr-context-ratio" type="number" min="30" max="92" step="5" class="nr-input">
                            </label>
                            <p class="nr-help">建议 60%～75%，给提示词和输出留出余量。</p>
                            <label class="nr-field">
                                <span>输出预留 token</span>
                                <input id="nr-output-reserve" type="number" min="128" step="128" class="nr-input">
                            </label>
                        </fieldset>

                        <fieldset>
                            <legend>总结策略</legend>
                            <label class="nr-field">
                                <span>速度 / 质量</span>
                                <select id="nr-summary-mode" class="nr-select"></select>
                            </label>
                            <p class="nr-help" id="nr-mode-help"></p>
                            <label class="nr-field">
                                <span>分段并发数</span>
                                <select id="nr-map-concurrency" class="nr-select">
                                    <option value="0">自动（跟随模式）</option>
                                    <option value="1">1（串行，最稳）</option>
                                    <option value="2">2</option>
                                    <option value="3">3</option>
                                    <option value="4">4</option>
                                    <option value="5">5</option>
                                    <option value="6">6（最快，注意限流）</option>
                                </select>
                            </label>
                            <label class="nr-check">
                                <input id="nr-reuse-parts" type="checkbox">
                                <span>复用已成功的分段（失败/中断后只补缺失部分）</span>
                            </label>
                            <label class="nr-field">
                                <span>中间摘要最小字数（0=跟随模式）</span>
                                <input id="nr-min-mid" type="number" min="0" step="20" class="nr-input">
                            </label>
                            <label class="nr-field">
                                <span>单段失败重试次数</span>
                                <input id="nr-attempts" type="number" min="1" max="5" step="1" class="nr-input">
                            </label>
                            <label class="nr-check">
                                <input id="nr-auto-calibrate" type="checkbox">
                                <span>结果超长时自动压缩校准</span>
                            </label>
                            <label class="nr-check">
                                <input id="nr-keep-summaries" type="checkbox">
                                <span>自动保存总结历史</span>
                            </label>
                        </fieldset>

                        <fieldset>
                            <legend>阅读</legend>
                            <label class="nr-field">
                                <span>正文字号</span>
                                <input id="nr-font-size" type="number" min="12" max="32" step="1" class="nr-input">
                            </label>
                            <label class="nr-field">
                                <span>默认总结字数上限</span>
                                <input id="nr-default-target" type="number" min="100" max="50000" step="50" class="nr-input">
                            </label>
                        </fieldset>

                        <fieldset>
                            <legend>世界书与角色卡</legend>
                            <label class="nr-check">
                                <input id="nr-import-card" type="checkbox">
                                <span>「导入到酒馆」时一并导入角色卡</span>
                            </label>
                            <p class="nr-help">世界书和角色卡一次写好，角色卡直接绑定这本世界书；重名会自动加「（2）」共存。关掉后，「导入到酒馆」只写世界书并绑定角色面板里当前打开的角色。</p>
                            <label class="nr-check">
                                <input id="nr-auto-import-lorebook" type="checkbox">
                                <span>角色卡内嵌世界书时自动导入并绑定</span>
                            </label>
                            <p class="nr-help">导入角色卡后，如果这张卡内嵌世界书、而角色还没有绑定世界书，就自动写入世界书列表并绑定，省掉「更多… → 导入角色卡的世界书」。酒馆自己正弹出「导入内嵌世界书」询问框时，会交给酒馆处理。</p>
                            <p class="nr-help">酒馆的「导入角色卡时询问是否导入世界书」关掉时只会提示一次，同一个头像之后不再提示；这个开关不受它影响。</p>
                        </fieldset>
                    </div>

                    <div class="nr-strategy">
                        <h4>总结策略说明</h4>
                        <p>整本书会按「原文 → 分段摘要 → 多层合并 → 最终成稿」处理：每段都控制在上下文预算内，分段尽量装满预算以减少请求数；「极速」模式并行处理且只记事件账本，「均衡」并行 2 路，「质量」串行并带前情。某一段失败只会跳过该段，不会中断整本；已成功的分段会缓存，再次开始只补失败部分。</p>
                        <p>token 数为保守估算；如果模型仍然报“上下文超限”，可以调低占用比例或调大上下文上限。最终结果超过上限时会自动压缩，必要时在句末截断。</p>
                    </div>

                    <div class="nr-settings-actions">
                        <button type="button" class="nr-btn" id="nr-reset-settings">恢复默认设置</button>
                        <button type="button" class="nr-btn nr-danger" id="nr-clear-data">清空全部小说数据</button>
                    </div>
                </div>
            </section>
        </div>

        <div class="nr-dialog" id="nr-dialog" hidden>
            <div class="nr-dialog-card" role="dialog" aria-modal="true" aria-labelledby="nr-dialog-title">
                <div class="nr-dialog-head">
                    <strong id="nr-dialog-title"></strong>
                    <button type="button" class="nr-icon-btn" id="nr-dialog-close" title="关闭">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
                <div class="nr-dialog-body" id="nr-dialog-body"></div>
                <div class="nr-dialog-foot" id="nr-dialog-foot"></div>
                <div class="nr-dialog-preview" id="nr-dialog-preview" hidden>
                    <div class="nr-dialog-preview-head">
                        <div>
                            <strong id="nr-preview-title"></strong>
                            <div class="nr-dialog-preview-meta" id="nr-preview-meta"></div>
                        </div>
                        <button type="button" class="nr-btn nr-btn-sm" id="nr-preview-back">返回</button>
                    </div>
                    <div class="nr-dialog-preview-body" id="nr-preview-body"></div>
                </div>
            </div>
        </div>
    `;

    document.body.prepend(panel);

    elements = {
        headerStatus: panel.querySelector('#nr-header-status'),
        tabButtons: Array.from(panel.querySelectorAll('.nr-tab')),
        panes: Array.from(panel.querySelectorAll('.nr-tabpane')),
        drop: panel.querySelector('#nr-drop'),
        pick: panel.querySelector('#nr-pick'),
        fileInput: panel.querySelector('#nr-file'),
        importStatus: panel.querySelector('#nr-import-status'),
        libCount: panel.querySelector('#nr-lib-count'),
        novels: panel.querySelector('#nr-novels'),
        libraryViewButtons: Array.from(panel.querySelectorAll('[data-view]')),
        shelf: panel.querySelector('#nr-shelf'),
        shelfBar: panel.querySelector('#nr-shelf-bar'),
        shelfPane: panel.querySelector('[data-pane="library"] .nr-pane-pad'),
        shelfManage: panel.querySelector('#nr-shelf-manage'),
        shelfGroup: panel.querySelector('#nr-shelf-group'),
        shelfSort: panel.querySelector('#nr-shelf-sort'),
        shelfOrder: panel.querySelector('#nr-shelf-order'),
        shelfSearch: panel.querySelector('#nr-shelf-search'),
        shelfGroupsButton: panel.querySelector('#nr-shelf-groups'),
        shelfBulk: panel.querySelector('#nr-shelf-bulk'),
        shelfSelectAll: panel.querySelector('#nr-shelf-select-all'),
        shelfSelected: panel.querySelector('#nr-shelf-selected'),
        shelfResume: panel.querySelector('#nr-shelf-resume'),
        onlineQuery: panel.querySelector('#nr-ol-query'),
        onlineSearch: panel.querySelector('#nr-ol-search'),
        onlineStop: panel.querySelector('#nr-ol-stop'),
        onlineEngine: panel.querySelector('#nr-ol-engine'),
        onlineChannel: panel.querySelector('#nr-ol-channel'),
        onlineExact: panel.querySelector('#nr-ol-exact'),
        onlineExactField: panel.querySelector('#nr-ol-exact-field'),
        onlineEngineHint: panel.querySelector('#nr-ol-engine-hint'),
        onlineEngineHintText: panel.querySelector('#nr-ol-engine-hint-text'),
        onlineSourceManage: panel.querySelector('#nr-ol-source-manage'),
        onlineExplore: panel.querySelector('#nr-ol-explore'),
        onlineRespectRateField: panel.querySelector('#nr-ol-respect-rate-field'),
        onlineSortField: panel.querySelector('#nr-ol-sort-field'),
        onlineSourceSummary: panel.querySelector('#nr-ol-source-summary'),
        onlineHistory: panel.querySelector('#nr-ol-history'),
        onlineSettingsToggle: panel.querySelector('#nr-ol-settings-toggle'),
        onlineSettings: panel.querySelector('#nr-ol-settings'),
        onlineProxy: panel.querySelector('#nr-ol-proxy'),
        onlineFanqieBridge: panel.querySelector('#nr-ol-fanqie-bridge'),
        onlineFanqieUpstream: panel.querySelector('#nr-ol-fanqie-upstream'),
        onlineConcurrency: panel.querySelector('#nr-ol-concurrency'),
        onlineChapterTimeout: panel.querySelector('#nr-ol-chapter-timeout'),
        onlineRespectRate: panel.querySelector('#nr-ol-respect-rate'),
        onlineTimeout: panel.querySelector('#nr-ol-timeout'),
        onlineLimit: panel.querySelector('#nr-ol-limit'),
        onlineSort: panel.querySelector('#nr-ol-sort'),
        onlineBridge: panel.querySelector('#nr-ol-bridge'),
        onlineBridgeTitle: panel.querySelector('#nr-ol-bridge-title'),
        onlineBridgeCheck: panel.querySelector('#nr-ol-bridge-check'),
        onlineBridgeStatus: panel.querySelector('#nr-ol-bridge-status'),
        onlineInstallList: panel.querySelector('#nr-ol-install-list'),
        onlineInstallNote: panel.querySelector('#nr-ol-install-note'),
        onlineUrl: panel.querySelector('#nr-ol-url'),
        onlineOpen: panel.querySelector('#nr-ol-open'),
        onlineStatus: panel.querySelector('#nr-ol-status'),
        onlineResultsHead: panel.querySelector('#nr-ol-results-head'),
        onlineResultsCount: panel.querySelector('#nr-ol-results-count'),
        onlinePageSize: panel.querySelector('#nr-ol-page-size'),
        onlineScroll: panel.querySelector('#nr-ol-scroll'),
        onlineResults: panel.querySelector('#nr-ol-results'),
        onlinePager: panel.querySelector('#nr-ol-pager'),
        onlineBook: panel.querySelector('#nr-ol-book'),
        readerOnlineBadge: panel.querySelector('#nr-reader-online-badge'),
        readerDownload: panel.querySelector('#nr-reader-download'),
        readerSelect: panel.querySelector('#nr-reader-select'),
        chapterFilter: panel.querySelector('#nr-chapter-filter'),
        chapterOrder: panel.querySelector('#nr-chapter-order'),
        bookmarkBtn: panel.querySelector('#nr-bookmark-btn'),
        readerChangeSource: panel.querySelector('#nr-reader-change-source'),
        readerTtsRate: panel.querySelector('#nr-reader-tts-rate'),
        readerReplaceRules: panel.querySelector('#nr-reader-replace-rules'),
        ttsBtn: panel.querySelector('#nr-tts-btn'),
        shelfRecord: panel.querySelector('#nr-shelf-record'),
        chapterList: panel.querySelector('#nr-chapter-list'),
        readerEmpty: panel.querySelector('#nr-reader-empty'),
        article: panel.querySelector('#nr-article'),
        articleTitle: panel.querySelector('#nr-article-title'),
        articleMeta: panel.querySelector('#nr-article-meta'),
        articleText: panel.querySelector('#nr-article-text'),
        articleImages: panel.querySelector('#nr-article-images'),
        readScroll: panel.querySelector('#nr-read-scroll'),
        readMain: panel.querySelector('.nr-read-main'),
        reader: panel.querySelector('#nr-reader'),
        readerSettings: panel.querySelector('#nr-reader-settings'),
        readerSettingsBtn: panel.querySelector('#nr-reader-settings-btn'),
        readerSettingsClose: panel.querySelector('#nr-reader-settings-close'),
        readerTheme: panel.querySelector('#nr-reader-theme'),
        readerFont: panel.querySelector('#nr-reader-font'),
        readerSize: panel.querySelector('#nr-reader-size'),
        readerSizeValue: panel.querySelector('#nr-reader-size-value'),
        readerLineHeight: panel.querySelector('#nr-reader-line-height'),
        readerLineHeightValue: panel.querySelector('#nr-reader-line-height-value'),
        readerParaGap: panel.querySelector('#nr-reader-para-gap'),
        readerParaGapValue: panel.querySelector('#nr-reader-para-gap-value'),
        readerWidth: panel.querySelector('#nr-reader-width'),
        readerWidthValue: panel.querySelector('#nr-reader-width-value'),
        readerIndent: panel.querySelector('#nr-reader-indent'),
        readerIndentValue: panel.querySelector('#nr-reader-indent-value'),
        readerLetterSpacing: panel.querySelector('#nr-reader-letter-spacing'),
        readerLetterSpacingValue: panel.querySelector('#nr-reader-letter-spacing-value'),
        readerAlign: panel.querySelector('#nr-reader-align'),
        readerPageChars: panel.querySelector('#nr-reader-page-chars'),
        readerPageTurn: panel.querySelector('#nr-reader-page-turn'),
        readerReset: panel.querySelector('#nr-reader-reset'),
        readerSettingsStatus: panel.querySelector('#nr-reader-settings-status'),
        pageInfo: panel.querySelector('#nr-page-info'),
        readerSearch: panel.querySelector('#nr-read-search'),
        readerSearchBtn: panel.querySelector('#nr-read-search-btn'),
        searchPanel: panel.querySelector('#nr-search-panel'),
        searchStatus: panel.querySelector('#nr-search-status'),
        searchResults: panel.querySelector('#nr-search-results'),
        searchClear: panel.querySelector('#nr-search-clear'),
        searchClose: panel.querySelector('#nr-search-close'),
        memoSelect: panel.querySelector('#nr-memo-select'),
        memoFilter: panel.querySelector('#nr-memo-filter'),
        memoPinned: panel.querySelector('#nr-memo-pinned'),
        memoSort: panel.querySelector('#nr-memo-sort'),
        memoCount: panel.querySelector('#nr-memo-count'),
        memoMain: panel.querySelector('#nr-memo-main'),
        memoHeadMeta: panel.querySelector('#nr-memo-head-meta'),
        memoTree: panel.querySelector('#nr-memo-tree'),
        memoListTitle: panel.querySelector('#nr-memo-list-title'),
        memoListCount: panel.querySelector('#nr-memo-list-count'),
        memoBatch: panel.querySelector('#nr-memo-batch'),
        memoBatchFoot: panel.querySelector('#nr-memo-list-foot'),
        memoBatchCount: panel.querySelector('#nr-memo-batch-count'),
        memoBatchAll: panel.querySelector('#nr-memo-batch-all'),
        memoBatchDelete: panel.querySelector('#nr-memo-batch-delete'),
        memoBatchCancel: panel.querySelector('#nr-memo-batch-cancel'),
        memoView: panel.querySelector('#nr-memo-view'),
        memoViewTitle: panel.querySelector('#nr-memo-view-title'),
        memoViewGroup: panel.querySelector('#nr-memo-view-group'),
        memoViewPinIcon: panel.querySelector('#nr-memo-view-pin-icon'),
        memoViewMeta: panel.querySelector('#nr-memo-view-meta'),
        memoViewBody: panel.querySelector('#nr-memo-view-body'),
        memoViewJump: panel.querySelector('#nr-memo-view-jump'),
        memoViewPin: panel.querySelector('#nr-memo-view-pin'),
        memoViewCopy: panel.querySelector('#nr-memo-view-copy'),
        memoViewEdit: panel.querySelector('#nr-memo-view-edit'),
        memoViewDelete: panel.querySelector('#nr-memo-view-delete'),
        memoEditor: panel.querySelector('#nr-memo-editor'),
        memoEmpty: panel.querySelector('#nr-memo-empty'),
        memoEmptyText: panel.querySelector('#nr-memo-empty-text'),
        memoEditorTitle: panel.querySelector('#nr-memo-editor-title'),
        memoEditorHint: panel.querySelector('#nr-memo-editor-hint'),
        memoTitle: panel.querySelector('#nr-memo-title'),
        memoGroup: panel.querySelector('#nr-memo-group'),
        memoTargetHint: panel.querySelector('#nr-memo-target-hint'),
        memoContent: panel.querySelector('#nr-memo-content'),
        memoAnchorLabel: panel.querySelector('#nr-memo-anchor-label'),
        memoUsePosition: panel.querySelector('#nr-memo-use-position'),
        memoClearAnchor: panel.querySelector('#nr-memo-clear-anchor'),
        memoNew: panel.querySelector('#nr-memo-new'),
        memoCancel: panel.querySelector('#nr-memo-cancel'),
        memoSave: panel.querySelector('#nr-memo-save'),
        memoBackReader: panel.querySelector('#nr-memo-back-reader'),
        memoExport: panel.querySelector('#nr-memo-export'),
        memoQuick: panel.querySelector('#nr-memo-quick'),
        memoQuickCount: panel.querySelector('#nr-memo-quick-count'),
        memoTabBadge: panel.querySelector('#nr-memo-tab-badge'),
        summarySelect: panel.querySelector('#nr-summary-select'),
        summaryChapters: panel.querySelector('#nr-summary-chapters'),
        summaryFilter: panel.querySelector('#nr-summary-filter'),
        selectCount: panel.querySelector('#nr-select-count'),
        target: panel.querySelector('#nr-target'),
        style: panel.querySelector('#nr-style'),
        extra: panel.querySelector('#nr-extra'),
        budget: panel.querySelector('#nr-budget'),
        run: panel.querySelector('#nr-run'),
        stop: panel.querySelector('#nr-stop'),
        progress: panel.querySelector('#nr-progress'),
        progressText: panel.querySelector('#nr-progress-text'),
        progressPct: panel.querySelector('#nr-progress-pct'),
        progressBar: panel.querySelector('#nr-progress-bar'),
        log: panel.querySelector('#nr-log'),
        result: panel.querySelector('#nr-result'),
        resultMeta: panel.querySelector('#nr-result-meta'),
        resultText: panel.querySelector('#nr-result-text'),
        resultMemo: panel.querySelector('#nr-result-memo'),
        resultClose: panel.querySelector('#nr-result-close'),
        history: panel.querySelector('#nr-history'),
        historyCount: panel.querySelector('#nr-history-count'),
        historyList: panel.querySelector('#nr-history-list'),
        wbSelect: panel.querySelector('#nr-wb-select'),
        wbChapters: panel.querySelector('#nr-wb-chapters'),
        wbFilter: panel.querySelector('#nr-wb-filter'),
        wbSelectCount: panel.querySelector('#nr-wb-select-count'),
        wbCats: panel.querySelector('#nr-wb-cats'),
        wbChunkChars: panel.querySelector('#nr-wb-chunk-chars'),
        wbConcurrency: panel.querySelector('#nr-wb-concurrency'),
        wbEntryChars: panel.querySelector('#nr-wb-entry-chars'),
        wbPlotEntries: panel.querySelector('#nr-wb-plot-entries'),
        wbImportTavern: panel.querySelector('#nr-wb-import-tavern'),
        wbExtra: panel.querySelector('#nr-wb-extra'),
        wbBudget: panel.querySelector('#nr-wb-budget'),
        wbRun: panel.querySelector('#nr-wb-run'),
        wbStop: panel.querySelector('#nr-wb-stop'),
        wbProgress: panel.querySelector('#nr-wb-progress'),
        wbProgressText: panel.querySelector('#nr-wb-progress-text'),
        wbProgressPct: panel.querySelector('#nr-wb-progress-pct'),
        wbProgressBar: panel.querySelector('#nr-wb-progress-bar'),
        wbLog: panel.querySelector('#nr-wb-log'),
        wbResult: panel.querySelector('#nr-wb-result'),
        wbResultMeta: panel.querySelector('#nr-wb-result-meta'),
        wbName: panel.querySelector('#nr-wb-name'),
        wbEntries: panel.querySelector('#nr-wb-entries'),
        wbEntryCount: panel.querySelector('#nr-wb-entry-count'),
        wbOrganize: panel.querySelector('#nr-wb-organize'),
        wbMerge: panel.querySelector('#nr-wb-merge'),
        wbDedupe: panel.querySelector('#nr-wb-dedupe'),
        wbUndo: panel.querySelector('#nr-wb-undo'),
        wbDedupeHint: panel.querySelector('#nr-wb-dedupe-hint'),
        wbToStyle: panel.querySelector('#nr-wb-to-style'),
        styleSelect: panel.querySelector('#nr-st-novel'),
        stylePreset: panel.querySelector('#nr-st-preset'),
        styleEntry: panel.querySelector('#nr-st-entry'),
        styleEntryHelp: panel.querySelector('#nr-st-entry-help'),
        styleExtra: panel.querySelector('#nr-st-extra'),
        styleFormat: panel.querySelector('#nr-st-format'),
        styleStatus: panel.querySelector('#nr-st-status'),
        styleRun: panel.querySelector('#nr-st-run'),
        styleStop: panel.querySelector('#nr-st-stop'),
        styleRefresh: panel.querySelector('#nr-st-refresh'),
        styleStale: panel.querySelector('#nr-st-stale'),
        styleResult: panel.querySelector('#nr-st-result'),
        styleResultMeta: panel.querySelector('#nr-st-result-meta'),
        styleOutput: panel.querySelector('#nr-st-output'),
        styleCopy: panel.querySelector('#nr-st-copy'),
        styleAgain: panel.querySelector('#nr-st-again'),
        styleCheck: panel.querySelector('#nr-st-check'),
        stylePaste: panel.querySelector('#nr-st-paste'),
        dialog: panel.querySelector('#nr-dialog'),
        dialogTitle: panel.querySelector('#nr-dialog-title'),
        dialogClose: panel.querySelector('#nr-dialog-close'),
        dialogBody: panel.querySelector('#nr-dialog-body'),
        dialogFoot: panel.querySelector('#nr-dialog-foot'),
        dialogPreview: panel.querySelector('#nr-dialog-preview'),
        previewTitle: panel.querySelector('#nr-preview-title'),
        previewMeta: panel.querySelector('#nr-preview-meta'),
        previewBody: panel.querySelector('#nr-preview-body'),
        previewBack: panel.querySelector('#nr-preview-back'),
        wbImport: panel.querySelector('#nr-wb-import'),
        wbFile: panel.querySelector('#nr-wb-file'),
        provider: panel.querySelector('#nr-provider'),
        profile: panel.querySelector('#nr-profile'),
        contextTokens: panel.querySelector('#nr-context-tokens'),
        contextRatio: panel.querySelector('#nr-context-ratio'),
        outputReserve: panel.querySelector('#nr-output-reserve'),
        minMid: panel.querySelector('#nr-min-mid'),
        attempts: panel.querySelector('#nr-attempts'),
        summaryMode: panel.querySelector('#nr-summary-mode'),
        mapConcurrency: panel.querySelector('#nr-map-concurrency'),
        reuseParts: panel.querySelector('#nr-reuse-parts'),
        modeHelp: panel.querySelector('#nr-mode-help'),
        autoCalibrate: panel.querySelector('#nr-auto-calibrate'),
        keepSummaries: panel.querySelector('#nr-keep-summaries'),
        autoImportLorebook: panel.querySelector('#nr-auto-import-lorebook'),
        importCard: panel.querySelector('#nr-import-card'),
        fontSize: panel.querySelector('#nr-font-size'),
        defaultTarget: panel.querySelector('#nr-default-target'),
        contextHelp: panel.querySelector('#nr-context-help'),
    };

    // 填充风格选项
    for (const [key, preset] of Object.entries(STYLE_PRESETS)) {
        const option = document.createElement('option');
        option.value = key;
        option.textContent = preset.label;
        elements.style.appendChild(option);
    }

    for (const [key, preset] of Object.entries(SUMMARY_MODE_PRESETS)) {
        const option = document.createElement('option');
        option.value = key;
        option.textContent = preset.label;
        elements.summaryMode.appendChild(option);
    }

    if (elements.wbPlotEntries) {
        elements.wbPlotEntries.replaceChildren();
        for (let count = 1; count <= 12; count++) {
            const option = document.createElement('option');
            option.value = String(count);
            option.textContent = `${count} 条`;
            elements.wbPlotEntries.appendChild(option);
        }
    }

    renderWorldbookCategories();
    renderWorldbookConfig();
    if (elements.memoSort) elements.memoSort.value = state.memo.sort;
    renderMemoPanel();
}

/* ------------------------------------------------------------------ */
/* 面板开关与标签                                                      */
/* ------------------------------------------------------------------ */

export function togglePanel(force) {
    if (!panel) return;
    const shouldOpen = typeof force === 'boolean' ? force : !panel.classList.contains('nr-open');
    panel.classList.toggle('nr-open', shouldOpen);
    panel.setAttribute('aria-hidden', shouldOpen ? 'false' : 'true');
    document.body.classList.toggle('nr-panel-open', shouldOpen);
    if (shouldOpen) {
        applyReaderSettings();
        if (state.tab === 'memo') {
            if (!state.memo.groupsLoaded) loadMemoGroups().catch(() => {});
            if (state.novelId && state.memo.loadedNovelId !== state.novelId) {
                loadMemosForNovel(state.novelId).catch(() => {});
            } else {
                renderMemoPanel();
            }
        }
        if (state.tab === 'reader' && state.novelId && !state.reader.loaded) {
            openChapter(state.reader.index).catch(error => toast(`打开章节失败：${error.message}`, 'error'));
        }
        setTimeout(() => elements.target?.focus?.({ preventScroll: true }), 50);
    } else {
        if (elements.readerSettings && !elements.readerSettings.hidden) {
            commitReaderControls();
            elements.readerSettings.hidden = true;
            elements.readerSettingsBtn?.setAttribute('aria-expanded', 'false');
        }
        orb?.focus?.({ preventScroll: true });
    }
}

export function closePanel() {
    togglePanel(false);
}

export function isPanelOpen() {
    return !!panel?.classList.contains('nr-open');
}

function showTab(tab, { persist = true } = {}) {
    if (state.online.reading && (tab === 'summary' || tab === 'worldbook' || tab === 'style')) {
        toast('在线阅读的书还没有完整存到本机，先点阅读页的「下载本书」再总结 / 生成世界书 / 文风', 'warning');
        return;
    }
    if (state.tab === 'reader' && tab !== 'reader' && elements.readerSettings && !elements.readerSettings.hidden) {
        commitReaderControls();
        elements.readerSettings.hidden = true;
        elements.readerSettingsBtn?.setAttribute('aria-expanded', 'false');
    }
    state.tab = tab;
    for (const button of elements.tabButtons || []) {
        button.classList.toggle('is-active', button.dataset.tab === tab);
    }
    for (const pane of elements.panes || []) {
        pane.classList.toggle('is-active', pane.dataset.pane === tab);
    }
    if (persist) {
        const settings = getSettings();
        settings.lastTab = tab;
        saveSettings();
    }
    if (tab === 'summary') {
        updateBudgetInfo();
        refreshHistory().catch(() => {});
    }
    if (tab === 'library') {
        // 重新渲染一次，让书封上的阅读进度跟上刚看过的地方
        elements.shelfBar?.classList.remove('is-hidden');
        renderLibrary();
    }
    if (tab === 'online') {
        renderOnlinePanel();
    }
    if (tab === 'worldbook') {
        renderWorldbookChapters();
        updateWorldbookBudget();
        if (state.novelId) loadWorldbookForNovel(state.novelId).catch(() => {});
    }
    if (tab === 'memo') {
        if (!state.memo.groupsLoaded) loadMemoGroups().catch(() => {});
        if (state.novelId && state.memo.loadedNovelId !== state.novelId) {
            loadMemosForNovel(state.novelId).catch(error => {
                toast(`读取备忘失败：${error.message}`, 'error');
            });
        } else {
            renderMemoPanel();
        }
    }
    if (tab === 'style') {
        renderStyleSelect();
        refreshStylePreset({ silent: true });
    }
    if (tab === 'reader' && state.novelId && !state.reader.loaded) {
        openChapter(state.reader.index).catch(error => toast(`打开章节失败：${error.message}`, 'error'));
    }
}

/* ------------------------------------------------------------------ */
/* 事件绑定                                                            */
/* ------------------------------------------------------------------ */

function bindEvents() {
    elements.tabButtons.forEach(button => {
        button.addEventListener('click', () => showTab(button.dataset.tab));
    });

    for (const button of elements.libraryViewButtons || []) {
        button.addEventListener('click', () => {
            const settings = getSettings();
            settings.libraryView = button.dataset.view === 'list' ? 'list' : 'grid';
            saveSettings();
            renderLibrary();
        });
    }

    /* ---- 书架：分组 / 排序 / 管理 ---- */
    elements.shelfManage?.addEventListener('click', () => setShelfManaging(!state.shelf.managing));
    elements.shelfGroup?.addEventListener('change', () => {
        const settings = getSettings();
        settings.shelfGroup = elements.shelfGroup.value || '';
        saveSettings();
        state.shelf.selected.clear();
        renderLibrary();
    });
    elements.shelfSort?.addEventListener('change', async () => {
        const settings = getSettings();
        settings.shelfSort = normalizeShelfSort(elements.shelfSort.value);
        saveSettings();
        if (settings.shelfSort === 'manual') await ensureManualOrder();
        renderLibrary();
    });
    elements.shelfOrder?.addEventListener('click', () => {
        const settings = getSettings();
        settings.shelfSortDesc = settings.shelfSortDesc === false;
        saveSettings();
        renderLibrary();
    });
    const onShelfSearch = debounce(() => {
        state.shelf.keyword = String(elements.shelfSearch?.value || '').trim();
        state.shelf.selected.clear();
        renderLibrary();
    }, 120);
    elements.shelfSearch?.addEventListener('input', onShelfSearch);
    elements.shelfGroupsButton?.addEventListener('click', () => openShelfGroupManager());
    elements.shelfSelectAll?.addEventListener('change', () => {
        const filter = currentShelfFilter();
        const view = buildShelfView(state.novels, filter);
        if (elements.shelfSelectAll.checked) {
            for (const novel of view.items) state.shelf.selected.add(novel.id);
        } else {
            for (const novel of view.items) state.shelf.selected.delete(novel.id);
        }
        renderLibrary();
    });
    elements.shelfBulk?.addEventListener('click', async event => {
        const action = event.target.closest('[data-bulk]')?.dataset.bulk;
        if (!action) return;
        try {
            if (action === 'cancel') setShelfManaging(false);
            else if (action === 'move') openMoveToGroupDialog(shelfSelectedIds());
            else if (action === 'pin') await setNovelsPinned(shelfSelectedIds(), true);
            else if (action === 'unpin') await setNovelsPinned(shelfSelectedIds(), false);
            else if (action === 'update') await updateSelectedBooks();
            else if (action === 'delete') await deleteShelfSelection();
            else if (action === 'up') await moveShelfSelection(-1);
            else if (action === 'down') await moveShelfSelection(1);
        } catch (error) {
            toast(`操作失败：${error.message}`, 'error');
        }
    });
    // 滚动书架时收起工具条（对应「阅读」的书架 ToolBar 自动隐藏）
    let lastShelfScrollTop = 0;
    elements.shelfPane?.addEventListener('scroll', () => {
        const bar = elements.shelfBar;
        if (!bar) return;
        const top = elements.shelfPane.scrollTop;
        if (!getSettings().shelfAutoHideBar) {
            bar.classList.remove('is-hidden');
            lastShelfScrollTop = top;
            return;
        }
        if (top < 24) bar.classList.remove('is-hidden');
        else if (top > lastShelfScrollTop + 6 && top > 48) bar.classList.add('is-hidden');
        else if (top < lastShelfScrollTop - 6) bar.classList.remove('is-hidden');
        lastShelfScrollTop = top;
    });

    panel.querySelector('#nr-close').addEventListener('click', closePanel);
    panel.querySelector('#nr-refresh').addEventListener('click', async () => {
        await refreshLibrary();
        await restoreLastNovel(true);
        toast('书架已刷新');
    });

    // 导入
    elements.pick.addEventListener('click', () => elements.fileInput.click());
    elements.fileInput.addEventListener('change', async () => {
        const files = Array.from(elements.fileInput.files || []);
        elements.fileInput.value = '';
        if (files.length) await importFiles(files);
    });
    elements.drop.addEventListener('dragover', event => {
        event.preventDefault();
        elements.drop.classList.add('is-dragover');
    });
    elements.drop.addEventListener('dragleave', () => elements.drop.classList.remove('is-dragover'));
    elements.drop.addEventListener('drop', async event => {
        event.preventDefault();
        elements.drop.classList.remove('is-dragover');
        const files = Array.from(event.dataTransfer?.files || []);
        if (files.length) await importFiles(files);
    });

    // 阅读
    elements.readerSelect.addEventListener('change', () => openNovel(elements.readerSelect.value, 'reader'));
    elements.readerSettingsBtn.addEventListener('click', () => toggleReaderSettings());
    elements.bookmarkBtn?.addEventListener('click', openBookmarkDialog);
    elements.readerChangeSource?.addEventListener('click', () => {
        if (state.online.reading) {
            toast('在线阅读的书还没入库：先点「加入书架」再换源', 'warning');
            return;
        }
        if (!state.novel) {
            toast('先打开一本书', 'warning');
            return;
        }
        if (!isSourceBook(state.novel)) {
            toast('这本是本地导入的书，没有书源可换', 'warning');
            return;
        }
        openChangeSourceDialog(state.novel);
    });
    elements.ttsBtn?.addEventListener('click', toggleReadAloud);
    elements.shelfRecord?.addEventListener('click', openReadingRecordDialog);
    elements.readerReplaceRules?.addEventListener('click', openReplaceRulesDialog);
    elements.readerSettingsClose.addEventListener('click', () => toggleReaderSettings(false));
    elements.readerSearchBtn.addEventListener('click', () => {
        runNovelSearch().catch(error => toast(`搜索失败：${error.message}`, 'error'));
    });
    elements.readerSearch.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            runNovelSearch().catch(error => toast(`搜索失败：${error.message}`, 'error'));
        } else if (event.key === 'Escape') {
            event.stopPropagation();
            clearNovelSearch();
        }
    });
    elements.readerSearch.addEventListener('input', () => {
        const value = normalizeSearchQuery(elements.readerSearch.value);
        if (!value) {
            clearNovelSearch({ keepFocus: true });
            return;
        }
        // 改了关键词但还没重新搜索时，撤掉正文里旧词的高亮
        if (state.search.highlight && value !== state.search.query) {
            state.search.highlight = '';
            if (state.reader.loaded) {
                const scrollTop = elements.readScroll.scrollTop;
                renderArticle();
                elements.readScroll.scrollTop = scrollTop;
            }
        }
    });
    elements.searchClose.addEventListener('click', () => closeSearchPanel());
    elements.searchClear.addEventListener('click', () => clearNovelSearch());
    elements.searchResults.addEventListener('click', event => {
        const hit = event.target.closest('[data-search-hit]');
        if (!hit) return;
        jumpToSearchHit(Number(hit.dataset.searchHit))
            .catch(error => toast(`跳转失败：${error.message}`, 'error'));
    });
    elements.previewBack.addEventListener('click', () => closeEntryPreview());
    elements.chapterFilter.addEventListener('input', debounce(renderChapterList, 150));
    elements.chapterOrder?.addEventListener('click', () => {
        const settings = getSettings();
        settings.chapterOrder = settings.chapterOrder === 'desc' ? 'asc' : 'desc';
        saveSettings();
        renderChapterList();
    });
    elements.chapterList.addEventListener('click', event => {
        const item = event.target.closest('[data-chapter-index]');
        if (!item) return;
        openChapter(Number(item.dataset.chapterIndex)).catch(error => toast(`打开章节失败：${error.message}`, 'error'));
    });
    panel.querySelector('#nr-chapter-prev').addEventListener('click', () => {
        const target = neighborChapterIndex(state.reader.index, -1);
        if (target >= 0) openChapter(target, 0, { animateTurn: true, direction: -1 });
        else toast('已经是第一章了', 'info');
    });
    panel.querySelector('#nr-chapter-next').addEventListener('click', () => {
        const target = neighborChapterIndex(state.reader.index, 1);
        if (target >= 0) openChapter(target, 0, { animateTurn: true, direction: 1 });
        else toast('已经是最后一章了', 'info');
    });
    panel.querySelector('#nr-page-prev').addEventListener('click', () => changePage(-1));
    panel.querySelector('#nr-page-next').addEventListener('click', () => changePage(1));
    // 触屏滑动：左右翻页；上下在滑到顶 / 底之后继续滑也翻页或跨章
    elements.readScroll.addEventListener('touchstart', handleReaderTouchStart, { passive: true });
    elements.readScroll.addEventListener('touchmove', handleReaderTouchMove, { passive: false });
    elements.readScroll.addEventListener('touchend', handleReaderTouchEnd);
    elements.readScroll.addEventListener('touchcancel', () => { readerSwipe = null; });
    // 桌面滚轮：滚到本章末尾后继续滚，直接进入下一章
    elements.readScroll.addEventListener('wheel', handleReaderWheel, { passive: true });
    elements.articleText.addEventListener('click', event => {
        if (event.target.closest('.nr-chapter-end')) changePage(1);
    });
    panel.querySelector('#nr-font-minus').addEventListener('click', () => changeFontSize(-1));
    panel.querySelector('#nr-font-plus').addEventListener('click', () => changeFontSize(1));
    panel.querySelector('#nr-sum-this').addEventListener('click', () => {
        if (!state.novelId || !state.chapters.length) return;
        state.selection = new Set([state.reader.index]);
        panel.querySelector('input[name="nr-scope"][value="selected"]').checked = true;
        renderSummaryChapters();
        updateBudgetInfo();
        showTab('summary');
    });

    // 总结范围
    panel.querySelectorAll('input[name="nr-scope"]').forEach(input => {
        input.addEventListener('change', () => {
            renderSummaryChapters();
            updateBudgetInfo();
        });
    });
    elements.summarySelect.addEventListener('change', () => openNovel(elements.summarySelect.value, 'summary'));
    elements.summaryFilter.addEventListener('input', debounce(renderSummaryChapters, 150));
    panel.querySelectorAll('[data-scope-act]').forEach(button => {
        button.addEventListener('click', () => {
            const action = button.dataset.scopeAct;
            if (action === 'all') state.selection = new Set(state.chapters.map(chapter => chapter.index));
            else if (action === 'none') state.selection.clear();
            else if (action === 'invert') {
                const next = new Set();
                for (const chapter of state.chapters) {
                    if (!state.selection.has(chapter.index)) next.add(chapter.index);
                }
                state.selection = next;
            }
            renderSummaryChapters();
            updateBudgetInfo();
        });
    });

    elements.summaryChapters.addEventListener('click', event => {
        const label = event.target.closest('[data-chapter-index]');
        if (!label) return;
        const index = Number(label.dataset.chapterIndex);
        const checkbox = label.querySelector('input[type="checkbox"]');
        if (event.target === checkbox && event.shiftKey && state.selectionAnchor != null) {
            const start = Math.min(state.selectionAnchor, index);
            const end = Math.max(state.selectionAnchor, index);
            const checked = checkbox.checked;
            for (const chapter of state.chapters) {
                if (chapter.index >= start && chapter.index <= end) {
                    if (checked) state.selection.add(chapter.index);
                    else state.selection.delete(chapter.index);
                }
            }
            renderSummaryChapters();
            updateBudgetInfo();
        }
        state.selectionAnchor = index;
    });
    elements.summaryChapters.addEventListener('change', event => {
        const checkbox = event.target.closest('input[type="checkbox"]');
        if (!checkbox) return;
        const index = Number(checkbox.dataset.index);
        if (checkbox.checked) state.selection.add(index);
        else state.selection.delete(index);
        elements.selectCount.textContent = `已选 ${state.selection.size} 章`;
        updateBudgetInfo();
    });

    // 总结参数
    elements.target.addEventListener('change', () => {
        const settings = getSettings();
        settings.targetChars = getTargetChars();
        elements.target.value = settings.targetChars;
        saveSettings();
        updateBudgetInfo();
    });
    panel.querySelectorAll('[data-target]').forEach(button => {
        button.addEventListener('click', () => {
            elements.target.value = button.dataset.target;
            elements.target.dispatchEvent(new Event('change'));
        });
    });
    elements.style.addEventListener('change', () => {
        const settings = getSettings();
        settings.style = elements.style.value;
        if (settings.style === 'custom') {
            elements.extra.placeholder = '自定义风格要求，例如：用评书的口吻概括，突出江湖恩怨';
            elements.extra.value = settings.customStyle || '';
        } else {
            elements.extra.placeholder = '例如：重点写主角的成长，保留结局反转';
            elements.extra.value = settings.extraInstruction || '';
        }
        saveSettings();
        updateBudgetInfo();
    });
    elements.extra.addEventListener('change', () => {
        const settings = getSettings();
        if (settings.style === 'custom') settings.customStyle = elements.extra.value;
        else settings.extraInstruction = elements.extra.value;
        saveSettings();
    });
    elements.run.addEventListener('click', () => startSummary());
    elements.stop.addEventListener('click', stopSummary);
    bindWorldbookEvents();
    bindMemoEvents();

    // 结果操作
    panel.querySelector('#nr-result-memo').addEventListener('click', () => {
        addSummaryToMemo().catch(error => toast(`添加到备忘失败：${error.message}`, 'error'));
    });
    panel.querySelector('#nr-copy').addEventListener('click', copyResult);
    panel.querySelector('#nr-download').addEventListener('click', downloadResult);
    panel.querySelector('#nr-insert').addEventListener('click', insertResult);
    elements.resultClose.addEventListener('click', closeResult);

    // 设置
    bindSettingsEvents();
    bindReaderSettingsEvents();
    panel.querySelector('#nr-reset-settings').addEventListener('click', async () => {
        resetSettings();
        persistReaderPrefs();
        renderSettings();
        renderSummaryChapters();
        updateBudgetInfo();
        renderWorldbookCategories();
        renderWorldbookConfig();
        updateWorldbookBudget();
        toast('已恢复默认设置');
    });
    panel.querySelector('#nr-clear-data').addEventListener('click', async () => {
        if (!(await confirmAction('确定清空全部小说、章节、总结和本书备忘？分组备忘会保留，此操作不可恢复。'))) return;
        await clearAll();
        state.novel = null;
        state.novelId = null;
        state.chapters = [];
        state.selection.clear();
        state.wbSelection.clear();
        state.chapterCache.clear();
        clearNovelSearch({ render: false, keepFocus: true });
        state.worldbook.result = null;
        state.worldbook.loadedNovelId = null;
        state.worldbook.editingIndex = null;
        state.worldbook.expanded = new Set();
        state.reader = { index: 0, page: 0, pages: [''], images: [], loaded: false };
        resetMemoState();
        await refreshLibrary();
        renderReaderSelect();
        renderSummarySelect();
        renderWorldbookSelect();
        renderStyleSelect();
        renderMemoSelect();
        renderChapterList();
        renderSummaryChapters();
        renderWorldbookChapters();
        updateWorldbookBudget();
        renderWorldbookResult();
        renderArticle();
        renderMemoPanel();
        refreshHistory();
        toast('已清空全部数据');
    });

    // 全局快捷键
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && isPanelOpen()) {
            if (elements.readerSettings && !elements.readerSettings.hidden) {
                toggleReaderSettings(false);
                return;
            }
            const openDialog = document.querySelector('dialog[open], .popup[open]');
            if (!openDialog) closePanel();
        }
        if (event.ctrlKey && event.shiftKey && !event.altKey && String(event.key).toLowerCase() === 'n') {
            event.preventDefault();
            togglePanel();
        }
    });
}

function bindReaderSettingsEvents() {
    if (!elements.readerSettings) return;
    const handler = () => commitReaderControls();
    const controls = [
        elements.readerTheme,
        elements.readerFont,
        elements.readerSize,
        elements.readerLineHeight,
        elements.readerParaGap,
        elements.readerWidth,
        elements.readerIndent,
        elements.readerLetterSpacing,
        elements.readerAlign,
        elements.readerPageChars,
        elements.readerPageTurn,
        elements.readerTtsRate,
    ];
    for (const control of controls) {
        if (!control) continue;
        control.addEventListener('input', handler);
        control.addEventListener('change', handler);
    }

    elements.readerReset.addEventListener('click', () => {
        const settings = getSettings();
        const keys = [
            'fontSize',
            'readerTheme',
            'readerFont',
            'readerLineHeight',
            'readerParaGap',
            'readerWidth',
            'readerIndent',
            'readerAlign',
            'readerLetterSpacing',
            'readerPageChars',
            'pageTurn',
        ];
        for (const key of keys) settings[key] = DEFAULT_SETTINGS[key];
        persistReaderPrefs();
        saveSettings();
        applyReaderSettings();
        renderReaderSettings();
        repaginateCurrentChapter();
        toast('阅读设置已恢复默认');
    });
}

function bindSettingsEvents() {
    const bind = (element, key, transform = value => value) => {
        element.addEventListener('change', () => {
            const settings = getSettings();
            settings[key] = transform(element.type === 'checkbox' ? element.checked : element.value);
            saveSettings();
            updateBudgetInfo();
        });
    };

    bind(elements.contextTokens, 'contextTokens', value => clamp(Number(value) || 0, 0, 2000000));
    bind(elements.contextRatio, 'contextRatio', value => clamp((Number(value) || 70) / 100, 0.3, 0.92));
    bind(elements.outputReserve, 'outputReserve', value => clamp(Number(value) || 1024, 128, 32768));
    bind(elements.minMid, 'minMidChars', value => clamp(Number(value) || 0, 0, 1000));
    bind(elements.attempts, 'maxAttempts', value => clamp(Number(value) || 3, 1, 5));
    bind(elements.summaryMode, 'summaryMode');
    bind(elements.mapConcurrency, 'mapConcurrency', value => clamp(Number(value) || 0, 0, 6));
    bind(elements.reuseParts, 'reuseParts');
    elements.summaryMode.addEventListener('change', renderSettings);
    bind(elements.autoCalibrate, 'autoCalibrate');
    bind(elements.keepSummaries, 'keepSummaries');
    bind(elements.fontSize, 'fontSize', value => clamp(Number(value) || 17, 12, 32));
    bind(elements.defaultTarget, 'targetChars', value => clamp(Number(value) || 800, 100, 50000));

    elements.contextRatio.addEventListener('change', renderSettings);
    elements.fontSize.addEventListener('change', () => {
        persistReaderPrefs();
        applyFontSize();
        renderReaderSettings();
    });
    elements.defaultTarget.addEventListener('change', () => {
        elements.target.value = getSettings().targetChars;
        updateBudgetInfo();
    });

    elements.provider.addEventListener('change', () => {
        const settings = getSettings();
        settings.provider = elements.provider.value;
        saveSettings();
        renderSettings();
    });
    elements.profile.addEventListener('change', () => {
        const settings = getSettings();
        settings.profileId = elements.profile.value;
        saveSettings();
    });
}

/* ------------------------------------------------------------------ */
/* 备忘录事件                                                          */
/* ------------------------------------------------------------------ */

function bindMemoEvents() {
    if (!elements.memoSelect) return;

    elements.memoSelect.addEventListener('change', () => {
        openNovel(elements.memoSelect.value, 'memo')
            .catch(error => toast(`打开小说失败：${error.message}`, 'error'));
    });

    elements.memoFilter.addEventListener('input', debounceMemoSearch);
    elements.memoFilter.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || (!elements.memoFilter.value && !state.memo.query)) return;
        // 有搜索词时先清搜索，别把整个面板关掉
        event.preventDefault();
        event.stopPropagation();
        elements.memoFilter.value = '';
        state.memo.query = '';
        exitMemoBatch();
        renderMemoPanel();
    });
    elements.memoPinned.addEventListener('change', () => {
        state.memo.pinnedOnly = elements.memoPinned.checked;
        exitMemoBatch();
        renderMemoPanel();
    });
    elements.memoSort.addEventListener('change', () => {
        state.memo.sort = MEMO_SORTS.has(elements.memoSort.value) ? elements.memoSort.value : 'updated';
        renderMemoPanel();
    });

    elements.memoTree.addEventListener('click', event => {
        const action = event.target.closest('[data-memo-act]')?.dataset.memoAct;
        if (action === 'toggle-node') {
            const key = event.target.closest('[data-memo-node-key]')?.dataset.memoNodeKey;
            toggleMemoNode(key);
            return;
        }
        if (action === 'add-group') {
            openMemoGroupDialog();
            return;
        }
        if (action === 'rename-group' || action === 'delete-group') {
            const node = event.target.closest('[data-memo-group-id]');
            const group = node ? memoGroupById(node.dataset.memoGroupId) : null;
            if (!group) return;
            if (action === 'rename-group') openMemoGroupDialog(group);
            else deleteMemoGroupItem(group).catch(error => toast(`删除分组失败：${error.message}`, 'error'));
            return;
        }
        if (event.target.closest('[data-memo-pick]')) return;
        const row = event.target.closest('[data-memo-id]');
        if (!row) return;
        if (state.memo.batchMode) toggleMemoSelection(row.dataset.memoId);
        else viewMemo(row.dataset.memoId).catch(error => toast(`查看备忘失败：${error.message}`, 'error'));
    });
    elements.memoTree.addEventListener('change', event => {
        const checkbox = event.target.closest('[data-memo-pick]');
        if (!checkbox) return;
        setMemoSelection(checkbox.dataset.memoPick, checkbox.checked);
    });

    elements.memoBatch.addEventListener('click', () => toggleMemoBatch());
    elements.memoBatchAll.addEventListener('click', () => {
        const matching = getMemoMatchingList();
        state.memo.batchSelection = new Set(matching.map(memo => memo.id));
        renderMemoPanel();
    });
    elements.memoBatchDelete.addEventListener('click', () => {
        deleteSelectedMemos().catch(error => toast(`批量删除失败：${error.message}`, 'error'));
    });
    elements.memoBatchCancel.addEventListener('click', () => {
        exitMemoBatch();
        renderMemoPanel();
    });

    elements.memoNew.addEventListener('click', () => {
        newMemoDraft().catch(error => toast(`新建备忘失败：${error.message}`, 'error'));
    });
    elements.memoSave.addEventListener('click', () => {
        persistMemoEditor().catch(error => toast(`保存备忘失败：${error.message}`, 'error'));
    });
    elements.memoCancel.addEventListener('click', () => cancelMemoEdit());
    elements.memoUsePosition.addEventListener('click', () => attachMemoToCurrentPosition());
    elements.memoClearAnchor.addEventListener('click', () => {
        state.memo.anchor = null;
        renderMemoAnchor();
    });
    elements.memoGroup.addEventListener('change', () => {
        state.memo.targetGroupId = elements.memoGroup.value || null;
        if (state.memo.targetGroupId) state.memo.anchor = null;
        renderMemoPanel();
    });
    elements.memoViewEdit.addEventListener('click', () => {
        if (state.memo.viewingId) {
            editMemo(state.memo.viewingId).catch(error => toast(`进入编辑失败：${error.message}`, 'error'));
        }
    });
    elements.memoViewPin.addEventListener('click', () => {
        if (state.memo.viewingId) {
            toggleMemoPin(state.memo.viewingId).catch(error => toast(`置顶失败：${error.message}`, 'error'));
        }
    });
    elements.memoViewCopy.addEventListener('click', () => {
        if (state.memo.viewingId) {
            copyMemo(state.memo.viewingId).catch(error => toast(`复制失败：${error.message}`, 'error'));
        }
    });
    elements.memoViewDelete.addEventListener('click', () => {
        if (state.memo.viewingId) {
            deleteMemoItem(state.memo.viewingId).catch(error => toast(`删除备忘失败：${error.message}`, 'error'));
        }
    });
    elements.memoViewJump.addEventListener('click', () => {
        if (state.memo.viewingId) {
            jumpToMemo(state.memo.viewingId).catch(error => toast(`跳转失败：${error.message}`, 'error'));
        }
    });
    for (const input of [elements.memoTitle, elements.memoContent]) {
        input.addEventListener('keydown', event => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault();
                persistMemoEditor().catch(error => toast(`保存备忘失败：${error.message}`, 'error'));
            }
        });
    }

    elements.memoBackReader.addEventListener('click', () => {
        backToReaderFromMemo().catch(error => toast(`打开阅读页失败：${error.message}`, 'error'));
    });
    elements.memoExport.addEventListener('click', exportMemos);
    elements.memoQuick.addEventListener('click', () => {
        startMemoFromReader().catch(error => toast(`打开备忘失败：${error.message}`, 'error'));
    });
}

const debounceMemoSearch = debounce(() => {
    if (state.memo.batchMode) exitMemoBatch();
    state.memo.query = elements.memoFilter.value;
    renderMemoPanel();
}, 120);

function confirmAction(message) {
    const context = getContext();
    try {
        if (context?.callGenericPopup && context.POPUP_TYPE?.CONFIRM !== undefined) {
            return context.callGenericPopup(message, context.POPUP_TYPE.CONFIRM)
                .then(result => result === context.POPUP_RESULT?.AFFIRMATIVE);
        }
    } catch (error) {
        console.warn('[小说阅读器] 弹窗调用失败', error);
    }
    return Promise.resolve(globalThis.confirm ? globalThis.confirm(message) : true);
}


/* ------------------------------------------------------------------ */
/* 阅读器增强：书签 / 朗读 / 替换净化 / 阅读记录                        */
/* ------------------------------------------------------------------ */

async function reloadBookmarks() {
    if (!state.novelId || state.online.reading) {
        state.bookmarks = [];
        return state.bookmarks;
    }
    try {
        state.bookmarks = await listBookmarks(state.novelId);
    } catch {
        state.bookmarks = [];
    }
    return state.bookmarks;
}

function currentPageText() {
    const pages = state.reader.pages || [];
    return String(pages[state.reader.page] || '');
}

function currentPageExcerpt() {
    return currentPageText().replace(/\s+/g, ' ').trim().slice(0, 60);
}

async function addBookmarkAtCurrentPage() {
    if (!state.novelId || state.online.reading) {
        throw new Error('在线阅读的书还没有入库，先点「加入书架」再记书签');
    }
    if (!state.reader.loaded) throw new Error('先打开一章');
    const chapter = state.chapters[state.reader.index];
    const page = state.reader.page;
    const existing = state.bookmarks.find(bookmark => bookmark.chapterIndex === state.reader.index && bookmark.page === page);
    if (existing) {
        toast('这一页已经有书签了', 'info');
        return existing;
    }
    const bookmark = {
        id: uuid(),
        novelId: state.novelId,
        chapterIndex: state.reader.index,
        page,
        chapterTitle: chapter?.title || '',
        excerpt: currentPageExcerpt(),
        createdAt: Date.now(),
    };
    await saveBookmark(bookmark);
    await reloadBookmarks();
    toast('已添加书签', 'success');
    return bookmark;
}

function openBookmarkDialog() {
    if (!state.novelId || state.online.reading) {
        toast('在线阅读的书还没有入库，先点「加入书架」再记书签', 'warning');
        return;
    }
    openWorldbookDialog({
        title: `书签 · ${state.novel?.title || ''}`,
        kind: 'shelf',
        wide: true,
        body: `
            <div class="nr-bookmark-add">
                <button type="button" class="nr-btn nr-btn-sm nr-primary" id="nr-bookmark-add">添加当前页书签</button>
                <span class="nr-muted" id="nr-bookmark-hint"></span>
            </div>
            <div class="nr-bookmark-list" id="nr-bookmark-list"></div>`,
        footer: '<button type="button" class="nr-btn nr-btn-sm" id="nr-bookmark-close">关闭</button>',
        onMount: ctx => {
            const listBox = ctx.body.querySelector('#nr-bookmark-list');
            const hint = ctx.body.querySelector('#nr-bookmark-hint');
            ctx.foot.querySelector('#nr-bookmark-close')?.addEventListener('click', ctx.close);

            const renderList = () => {
                listBox.replaceChildren();
                if (!state.bookmarks.length) {
                    listBox.appendChild(createElement('div', 'nr-list-empty', '还没有书签。翻到想记住的一页，点上面的按钮。'));
                    return;
                }
                for (const bookmark of state.bookmarks) {
                    const row = createElement('div', 'nr-bookmark-item');
                    const main = createElement('div', 'nr-bookmark-main');
                    main.appendChild(createElement('strong', null, bookmark.chapterTitle || `第 ${bookmark.chapterIndex + 1} 章`));
                    main.appendChild(createElement('span', 'nr-bookmark-meta', `第 ${bookmark.page + 1} 页 · ${relativeTime(bookmark.createdAt)}`));
                    if (bookmark.excerpt) main.appendChild(createElement('p', 'nr-bookmark-excerpt', bookmark.excerpt));
                    const jump = createElement('button', 'nr-btn nr-btn-sm', '跳转');
                    jump.type = 'button';
                    jump.addEventListener('click', async () => {
                        ctx.close();
                        await openChapter(bookmark.chapterIndex, bookmark.page);
                    });
                    const remove = createIconButton('button', 'nr-icon-btn nr-danger-text', '<i class="fa-solid fa-trash-can"></i>');
                    remove.type = 'button';
                    remove.title = '删除书签';
                    remove.addEventListener('click', async () => {
                        await deleteBookmark(bookmark.id);
                        await reloadBookmarks();
                        renderList();
                    });
                    row.append(main, jump, remove);
                    listBox.appendChild(row);
                }
            };
            ctx.body.querySelector('#nr-bookmark-add')?.addEventListener('click', async () => {
                try {
                    await addBookmarkAtCurrentPage();
                    hint.textContent = '';
                    renderList();
                } catch (error) {
                    hint.textContent = error.message;
                }
            });
            renderList();
        },
    });
}

/* 朗读（Web Speech） */
let readAloudUtterance = null;

function updateTtsButton() {
    if (!elements.ttsBtn) return;
    elements.ttsBtn.innerHTML = readAloudUtterance
        ? '<i class="fa-solid fa-stop"></i> 停止朗读'
        : '<i class="fa-solid fa-volume-high"></i> 朗读';
}

function stopReadAloud() {
    try {
        globalThis.speechSynthesis?.cancel?.();
    } catch {
        // ignore
    }
    readAloudUtterance = null;
    updateTtsButton();
}

function toggleReadAloud() {
    if (typeof globalThis.SpeechSynthesisUtterance !== 'function' || !globalThis.speechSynthesis) {
        toast('当前浏览器不支持朗读', 'warning');
        return;
    }
    if (readAloudUtterance) {
        stopReadAloud();
        return;
    }
    const text = currentPageText().trim();
    if (!text) {
        toast('这一页没有可朗读的内容', 'warning');
        return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'zh-CN';
    utterance.rate = getSettings().ttsRate || 1;
    utterance.onend = () => {
        readAloudUtterance = null;
        updateTtsButton();
    };
    utterance.onerror = () => {
        readAloudUtterance = null;
        updateTtsButton();
    };
    readAloudUtterance = utterance;
    updateTtsButton();
    globalThis.speechSynthesis.speak(utterance);
}

/* 替换净化规则 */
function openReplaceRulesDialog() {
    const settings = getSettings();
    const rules = normalizeReplaceRules(settings.replaceRules);
    openWorldbookDialog({
        title: '替换净化规则',
        kind: 'shelf',
        wide: true,
        body: `
            <div class="nr-dialog-hint">规则按顺序执行：书源自带的 replaceRegex 先跑，这里的规则在入库前再跑一遍。支持正则与字面量。</div>
            <div class="nr-replace-list" id="nr-replace-list"></div>
            <div class="nr-replace-actions">
                <button type="button" class="nr-btn nr-btn-sm" id="nr-replace-add">添加规则</button>
                <button type="button" class="nr-btn nr-btn-sm" id="nr-replace-export">导出</button>
                <span class="nr-muted">导入：粘贴 Legado 替换规则 JSON</span>
            </div>
            <textarea id="nr-replace-import" class="nr-input nr-source-json" rows="3" placeholder='[{"name":"去广告","pattern":"广告\\d+","replacement":"","isRegex":true}]'></textarea>
            <div class="nr-replace-actions">
                <button type="button" class="nr-btn nr-btn-sm" id="nr-replace-import-btn">导入这段 JSON</button>
                <span class="nr-muted" id="nr-replace-hint"></span>
            </div>`,
        footer: '<button type="button" class="nr-btn nr-btn-sm" id="nr-replace-cancel">取消</button><button type="button" class="nr-btn nr-btn-sm nr-primary" id="nr-replace-save">保存</button>',
        onMount: ctx => {
            const list = ctx.body.querySelector('#nr-replace-list');
            const hint = ctx.body.querySelector('#nr-replace-hint');
            let working = [...rules];

            const render = () => {
                list.replaceChildren();
                if (!working.length) {
                    list.appendChild(createElement('div', 'nr-list-empty', '还没有规则'));
                    return;
                }
                working.forEach((rule, index) => {
                    const row = createElement('div', 'nr-replace-row');
                    const enabled = document.createElement('input');
                    enabled.type = 'checkbox';
                    enabled.checked = rule.enabled;
                    enabled.title = '启用';
                    enabled.addEventListener('change', () => {
                        working[index] = { ...working[index], enabled: enabled.checked };
                    });
                    const name = document.createElement('input');
                    name.className = 'nr-input nr-input-sm';
                    name.value = rule.name;
                    name.placeholder = '名称';
                    name.addEventListener('input', () => {
                        working[index] = { ...working[index], name: name.value };
                    });
                    const pattern = document.createElement('input');
                    pattern.className = 'nr-input nr-input-sm nr-replace-pattern';
                    pattern.value = rule.pattern;
                    pattern.placeholder = '正则 / 文本';
                    pattern.addEventListener('input', () => {
                        working[index] = { ...working[index], pattern: pattern.value };
                    });
                    const replacement = document.createElement('input');
                    replacement.className = 'nr-input nr-input-sm';
                    replacement.value = rule.replacement;
                    replacement.placeholder = '替换为';
                    replacement.addEventListener('input', () => {
                        working[index] = { ...working[index], replacement: replacement.value };
                    });
                    const regex = document.createElement('label');
                    regex.className = 'nr-shelf-check';
                    const regexBox = document.createElement('input');
                    regexBox.type = 'checkbox';
                    regexBox.checked = rule.isRegex;
                    regexBox.addEventListener('change', () => {
                        working[index] = { ...working[index], isRegex: regexBox.checked };
                    });
                    regex.append(regexBox, document.createTextNode('正则'));
                    const scope = document.createElement('select');
                    scope.className = 'nr-select nr-select-sm';
                    for (const [value, label] of [['content', '正文'], ['title', '标题'], ['both', '都要']]) {
                        const option = document.createElement('option');
                        option.value = value;
                        option.textContent = label;
                        scope.appendChild(option);
                    }
                    scope.value = rule.scope;
                    scope.addEventListener('change', () => {
                        working[index] = { ...working[index], scope: scope.value };
                    });
                    const remove = createIconButton('button', 'nr-icon-btn nr-danger-text', '<i class="fa-solid fa-trash-can"></i>');
                    remove.type = 'button';
                    remove.title = '删除规则';
                    remove.addEventListener('click', () => {
                        working.splice(index, 1);
                        render();
                    });
                    row.append(enabled, name, pattern, replacement, regex, scope, remove);
                    list.appendChild(row);
                });
            };

            ctx.body.querySelector('#nr-replace-add')?.addEventListener('click', () => {
                working.push({ id: uuid(), name: '新规则', pattern: '', replacement: '', isRegex: true, scope: 'content', enabled: true });
                render();
            });
            ctx.body.querySelector('#nr-replace-import-btn')?.addEventListener('click', () => {
                try {
                    const { rules: imported, warnings } = importReplaceRules(ctx.body.querySelector('#nr-replace-import').value);
                    working = normalizeReplaceRules([...working, ...imported]);
                    render();
                    hint.textContent = `已导入 ${imported.length} 条${warnings.length ? `；${warnings[0]}` : ''}`;
                } catch (error) {
                    hint.textContent = error.message;
                }
            });
            ctx.body.querySelector('#nr-replace-export')?.addEventListener('click', () => {
                downloadText(`replace-rules-${Date.now()}.json`, JSON.stringify(exportReplaceRules(working), null, 2));
            });
            ctx.foot.querySelector('#nr-replace-cancel')?.addEventListener('click', ctx.close);
            ctx.foot.querySelector('#nr-replace-save')?.addEventListener('click', () => {
                const next = normalizeReplaceRules(working).filter(rule => rule.pattern.trim());
                const current = getSettings();
                current.replaceRules = next;
                saveSettings();
                ctx.close();
                toast(`已保存 ${next.length} 条替换规则`);
            });
            render();
        },
    });
}

/* 阅读记录 */
function openReadingRecordDialog() {
    const records = state.novels
        .filter(novel => readTimeOf(novel) > 0)
        .sort((left, right) => readTimeOf(right) - readTimeOf(left));
    openWorldbookDialog({
        title: '阅读记录',
        kind: 'shelf',
        wide: true,
        body: '<div class="nr-source-list" id="nr-record-list"></div>',
        footer: '<button type="button" class="nr-btn nr-btn-sm" id="nr-record-close">关闭</button>',
        onMount: ctx => {
            const list = ctx.body.querySelector('#nr-record-list');
            ctx.foot.querySelector('#nr-record-close')?.addEventListener('click', ctx.close);
            if (!records.length) {
                list.appendChild(createElement('div', 'nr-list-empty', '还没有阅读记录，打开一本书读一章就会出现在这里。'));
                return;
            }
            for (const novel of records) {
                const row = createElement('div', 'nr-source-item');
                const main = createElement('div', 'nr-source-item-main');
                main.appendChild(createElement('strong', null, novel.title));
                const progress = getNovelProgress(novel);
                main.appendChild(createElement('span', 'nr-muted', [
                    progress ? `读至 ${progress.chapter} / ${progress.total} 章` : '',
                    relativeTime(readTimeOf(novel)),
                    novel.sourceName && novel.format === 'NET' ? novel.sourceName : '',
                ].filter(Boolean).join(' · ')));
                const open = createElement('button', 'nr-btn nr-btn-sm nr-primary', '继续阅读');
                open.type = 'button';
                open.addEventListener('click', async () => {
                    ctx.close();
                    await openNovel(novel.id, 'reader');
                });
                row.append(main, open);
                list.appendChild(row);
            }
        },
    });
}

/* ------------------------------------------------------------------ */
/* 书架                                                                */
/* ------------------------------------------------------------------ */

async function refreshLibrary() {
    try {
        const [novels, groups] = await Promise.all([listNovels(), listShelfGroups()]);
        state.novels = novels;
        state.shelf.groups = sortShelfGroups(groups);
    } catch (error) {
        toast(`读取书架失败：${error.message}`, 'error');
        state.novels = [];
    }
    // 勾选里可能留着已经删掉的书
    const known = new Set(state.novels.map(novel => novel.id));
    for (const id of [...state.shelf.selected]) {
        if (!known.has(id)) state.shelf.selected.delete(id);
    }
    renderLibrary();
    renderWorldbookSelect();
    renderMemoSelect();
}

function getLibraryView() {
    const settings = getSettings();
    return LIBRARY_VIEWS.has(settings.libraryView) ? settings.libraryView : 'grid';
}

function syncLibraryViewSwitch(view) {
    for (const button of elements.libraryViewButtons || []) {
        const active = button.dataset.view === view;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
}

/** 当前书架筛选条件（设置里只存分组 / 排序，关键字只在内存里） */
function currentShelfFilter() {
    const settings = getSettings();
    const groups = state.shelf.groups;
    const known = new Set(groups.map(group => group.id));
    let groupId = String(settings.shelfGroup || '');
    if (groupId && groupId !== SHELF_GROUP_UNGROUPED && !known.has(groupId)) groupId = '';
    return {
        groupId,
        keyword: state.shelf.keyword,
        sort: normalizeShelfSort(settings.shelfSort),
        desc: settings.shelfSortDesc !== false,
        groups,
    };
}

function shelfGroupName(groupId) {
    if (!groupId) return '';
    return state.shelf.groups.find(group => group.id === groupId)?.name || '';
}

/** 书架：分组下拉 + 排序 + 管理模式工具条 */
function renderShelfBar(view, filter) {
    const counts = view.counts;

    if (elements.shelfGroup) {
        const options = [
            { value: '', label: `全部（${counts.all}）` },
            { value: SHELF_GROUP_UNGROUPED, label: `未分组（${counts.ungrouped}）` },
            ...state.shelf.groups.map(group => ({
                value: group.id,
                label: `${group.name}（${counts.groups.get(group.id) || 0}）`,
            })),
        ];
        const signature = options.map(option => `${option.value}\u0000${option.label}`).join('\u0001');
        if (elements.shelfGroup.dataset.signature !== signature) {
            elements.shelfGroup.replaceChildren();
            for (const option of options) {
                const node = document.createElement('option');
                node.value = option.value;
                node.textContent = option.label;
                elements.shelfGroup.appendChild(node);
            }
            elements.shelfGroup.dataset.signature = signature;
        }
        elements.shelfGroup.value = filter.groupId || '';
        if (elements.shelfGroup.selectedIndex < 0) elements.shelfGroup.value = '';
    }

    if (elements.shelfSort) elements.shelfSort.value = filter.sort;

    if (elements.shelfOrder) {
        const manual = filter.sort === 'manual';
        elements.shelfOrder.disabled = manual;
        elements.shelfOrder.innerHTML = filter.desc
            ? '<i class="fa-solid fa-arrow-down-long"></i>'
            : '<i class="fa-solid fa-arrow-up-long"></i>';
        elements.shelfOrder.title = manual
            ? '手动排序按自己排的顺序，没有正倒序'
            : (filter.desc ? '当前倒序，点一下改成正序' : '当前正序，点一下改成倒序');
        elements.shelfOrder.classList.toggle('is-active', !manual && !filter.desc);
    }

    if (elements.shelfSearch && elements.shelfSearch.value !== state.shelf.keyword) {
        elements.shelfSearch.value = state.shelf.keyword;
    }

    if (elements.shelfManage) {
        elements.shelfManage.textContent = state.shelf.managing ? '完成' : '管理';
        elements.shelfManage.classList.toggle('is-active', state.shelf.managing);
        elements.shelfManage.setAttribute('aria-pressed', state.shelf.managing ? 'true' : 'false');
    }

    if (elements.shelfBulk) {
        elements.shelfBulk.hidden = !state.shelf.managing;
    }
    const selectedCount = state.shelf.selected.size;
    if (elements.shelfSelected) {
        elements.shelfSelected.textContent = selectedCount ? `已选 ${selectedCount} 本` : '已选 0 本';
    }
    const visibleIds = view.items.map(novel => novel.id);
    const allSelected = visibleIds.length > 0 && visibleIds.every(id => state.shelf.selected.has(id));
    if (elements.shelfSelectAll) {
        elements.shelfSelectAll.checked = allSelected;
        elements.shelfSelectAll.indeterminate = selectedCount > 0 && !allSelected;
        elements.shelfSelectAll.disabled = visibleIds.length === 0;
    }
    for (const button of elements.shelfBulk?.querySelectorAll('[data-bulk]') || []) {
        const action = button.dataset.bulk;
        if (button.dataset.manualOnly !== undefined) {
            button.hidden = filter.sort !== 'manual';
        }
        if (action === 'cancel') continue;
        if (action === 'up' || action === 'down') {
            button.disabled = selectedCount !== 1 || filter.sort !== 'manual';
            continue;
        }
        button.disabled = selectedCount === 0;
    }

    const total = state.novels.length;
    if (elements.libCount) {
        if (!total) {
            elements.libCount.textContent = '';
        } else if (view.shown !== total || filter.groupId || filter.keyword) {
            elements.libCount.textContent = `（${view.shown} / ${total} 本）`;
        } else {
            elements.libCount.textContent = `（${total} 本）`;
        }
    }
}

/** 「继续阅读」卡片：最近读过的那本 */
function renderShelfResume(novel) {
    const box = elements.shelfResume;
    if (!box) return;
    if (!novel || state.shelf.managing) {
        box.hidden = true;
        box.replaceChildren();
        return;
    }
    const progress = getNovelProgress(novel);
    box.replaceChildren();
    const card = createElement('div', 'nr-resume-card');
    const tone = BOOK_TONES[hashString(`${novel.title}|${novel.id}`) % BOOK_TONES.length];
    const cover = createElement('span', 'nr-resume-cover');
    cover.style.setProperty('--nr-cover-a', tone[0]);
    cover.style.setProperty('--nr-cover-b', tone[1]);
    cover.textContent = String(novel.title || '书').slice(0, 1);
    const body = createElement('div', 'nr-resume-body');
    body.appendChild(createElement('span', 'nr-resume-label', '上次读到'));
    body.appendChild(createElement('strong', 'nr-resume-title', novel.title || '未命名'));
    const meta = [
        progress ? `第 ${progress.chapter} / ${progress.total} 章` : `${novel.chapterCount || 0} 章`,
        relativeTime(readTimeOf(novel)),
    ].filter(Boolean).join(' · ');
    body.appendChild(createElement('span', 'nr-resume-meta', meta));
    const button = createElement('button', 'nr-btn nr-btn-sm nr-primary', '继续阅读');
    button.type = 'button';
    button.dataset.act = 'resume';
    card.append(cover, body, button);
    card.addEventListener('click', () => {
        openNovel(novel.id, 'reader').catch(error => toast(`打开失败：${error.message}`, 'error'));
    });
    box.appendChild(card);
    box.hidden = false;
}

function renderLibrary() {
    if (!elements.novels) return;
    const view = getLibraryView();
    elements.novels.dataset.view = view;
    syncLibraryViewSwitch(view);

    if (!state.novels.length && state.shelf.managing) {
        // 书全删光了就退出管理，别留着一条对空书架的多选工具条
        state.shelf.managing = false;
        state.shelf.selected.clear();
    }
    const filter = currentShelfFilter();
    const shelfView = buildShelfView(state.novels, {
        ...filter,
        includeResume: true,
    });
    renderShelfBar(shelfView, filter);
    // 「继续阅读」只在没筛选时出现，免得用户以为筛选没生效
    renderShelfResume(!filter.groupId && !filter.keyword ? shelfView.resume : null);

    elements.novels.replaceChildren();

    if (state.novels.length === 0) {
        const empty = createElement('div', 'nr-empty');
        empty.innerHTML = `
            <i class="fa-solid fa-book-open"></i>
            <p>书架还空着，先去「找书」搜一本，或者拖个文件进来</p>
            <div class="nr-empty-actions">
                <button type="button" class="nr-btn nr-btn-sm nr-primary" data-empty="search">去「找书」</button>
                <button type="button" class="nr-btn nr-btn-sm" data-empty="import">导入文件</button>
            </div>`;
        empty.querySelector('[data-empty="search"]')?.addEventListener('click', () => showTab('online'));
        empty.querySelector('[data-empty="import"]')?.addEventListener('click', () => elements.fileInput?.click());
        elements.novels.appendChild(empty);
        return;
    }

    if (shelfView.shown === 0) {
        const empty = createElement('div', 'nr-empty');
        empty.innerHTML = `
            <i class="fa-solid fa-filter-circle-xmark"></i>
            <p>这个筛选下没有书</p>
            <div class="nr-empty-actions">
                <button type="button" class="nr-btn nr-btn-sm" data-empty="reset">清空筛选</button>
            </div>`;
        empty.querySelector('[data-empty="reset"]')?.addEventListener('click', () => {
            state.shelf.keyword = '';
            const settings = getSettings();
            settings.shelfGroup = '';
            saveSettings();
            renderLibrary();
        });
        elements.novels.appendChild(empty);
        return;
    }

    for (const novel of shelfView.items) {
        elements.novels.appendChild(view === 'grid' ? buildBookCard(novel) : buildNovelRow(novel));
    }
}

/** 按书名取一个稳定的书封配色下标 */
function hashString(text) {
    let hash = 0;
    const source = String(text || '');
    for (let i = 0; i < source.length; i++) {
        hash = ((hash << 5) + hash + source.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
}

function getNovelProgress(novel) {
    const progress = getSettings().progress?.[novel.id];
    const total = Number(novel.chapterCount) || 0;
    if (!progress || !total) return null;
    const chapter = clamp((Number(progress.chapterIndex) || 0) + 1, 1, total);
    const ratio = clamp(chapter / total, 0, 1);
    return { chapter, total, ratio };
}

/** 书架卡片上的「移到分组」：单选也走批量那条路 */
function openShelfCardMenu(novel) {
    if (!novel) return;
    openMoveToGroupDialog([novel.id]);
}

function bindNovelCard(card, novel) {
    card.addEventListener('click', async event => {
        const action = event.target.closest('[data-act]')?.dataset.act;
        if (action === 'select') {
            event.stopPropagation();
            toggleShelfSelection(novel.id);
            return;
        }
        if (state.shelf.managing) {
            if (!action) toggleShelfSelection(novel.id);
            return;
        }
        if (action === 'more') {
            event.stopPropagation();
            openBookActionsDialog(novel);
            return;
        }
        if (action === 'delete') {
            event.stopPropagation();
            await handleDeleteNovel(novel);
            return;
        }
        if (action === 'pin' || action === 'unpin') {
            event.stopPropagation();
            await setNovelsPinned([novel.id], action === 'pin');
            return;
        }
        if (action === 'group') {
            event.stopPropagation();
            openShelfCardMenu(novel);
            return;
        }
        await openNovel(novel.id, action === 'summary' ? 'summary' : 'reader');
        if (!isPanelOpen()) togglePanel(true);
    });
}

/** 勾选 / 取消一本 */
function toggleShelfSelection(novelId) {
    if (!state.shelf.managing) return;
    if (state.shelf.selected.has(novelId)) state.shelf.selected.delete(novelId);
    else state.shelf.selected.add(novelId);
    renderLibrary();
}

/** 列表视图：一行一本书 */
function buildNovelRow(novel) {
    const card = createElement('div', 'nr-novel-card');
    card.dataset.novelId = novel.id;
    if (state.shelf.selected.has(novel.id)) card.classList.add('is-selected');

    if (state.shelf.managing) {
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.className = 'nr-shelf-row-check';
        check.dataset.act = 'select';
        check.checked = state.shelf.selected.has(novel.id);
        check.setAttribute('aria-label', `选择《${novel.title}》`);
        card.appendChild(check);
    }

    const info = createElement('div', 'nr-novel-info');
    const titleRow = createElement('div', 'nr-novel-title-row');
    if (isPinned(novel)) {
        const pin = createElement('span', 'nr-shelf-pin');
        pin.innerHTML = '<i class="fa-solid fa-thumbtack"></i>';
        pin.title = '已置顶';
        titleRow.appendChild(pin);
    }
    titleRow.appendChild(createElement('h3', null, novel.title));
    const formatBadge = createElement('span', 'nr-badge', novel.format || 'TXT');
    titleRow.appendChild(formatBadge);
    if (unreadOf(novel)) {
        titleRow.appendChild(createElement('span', 'nr-shelf-unread', `${unreadOf(novel)} 章未读`));
    }
    info.appendChild(titleRow);

    const progress = getNovelProgress(novel);
    const groupName = novel.groupName || shelfGroupName(groupOf(novel));
    const meta = createElement('div', 'nr-novel-meta');
    meta.textContent = [
        `${novel.chapterCount || 0} 章`,
        formatCount(novel.charCount || 0) + ' 字',
        progress ? `读至 ${progress.chapter} / ${progress.total} 章` : '尚未开始',
        novel.sourceName && novel.format === 'NET' ? `来源：${novel.sourceName}` : '',
        readTimeOf(novel) ? `上次阅读 ${relativeTime(readTimeOf(novel))}` : '',
        groupName ? `分组：${groupName}` : '',
    ].filter(Boolean).join(' · ');
    info.appendChild(meta);
    if (novel.author) {
        info.appendChild(createElement('div', 'nr-novel-author', `作者：${novel.author}`));
    }

    if (!state.shelf.managing) {
        const actions = createElement('div', 'nr-novel-actions');
        const readButton = createElement('button', 'nr-btn nr-btn-sm', '阅读');
        readButton.type = 'button';
        readButton.dataset.act = 'read';
        const sumButton = createElement('button', 'nr-btn nr-btn-sm nr-accent', '总结');
        sumButton.type = 'button';
        sumButton.dataset.act = 'summary';
        const pinButton = createElement('button', 'nr-icon-btn', '');
        pinButton.type = 'button';
        pinButton.dataset.act = isPinned(novel) ? 'unpin' : 'pin';
        pinButton.title = isPinned(novel) ? '取消置顶' : '置顶';
        pinButton.setAttribute('aria-label', pinButton.title);
        pinButton.innerHTML = '<i class="fa-solid fa-thumbtack"></i>';
        const groupButton = createElement('button', 'nr-icon-btn', '');
        groupButton.type = 'button';
        groupButton.dataset.act = 'group';
        groupButton.title = '移到分组';
        groupButton.setAttribute('aria-label', '移到分组');
        groupButton.innerHTML = '<i class="fa-solid fa-folder-tree"></i>';
        const moreButton = createElement('button', 'nr-icon-btn', '');
        moreButton.type = 'button';
        moreButton.dataset.act = 'more';
        moreButton.title = '更多操作（更新 / 缓存 / 换源 / 编辑 / 删除）';
        moreButton.setAttribute('aria-label', moreButton.title);
        moreButton.innerHTML = '<i class="fa-solid fa-ellipsis"></i>';
        actions.append(readButton, sumButton, pinButton, groupButton, moreButton);
        card.appendChild(info);
        card.appendChild(actions);
    } else {
        card.appendChild(info);
    }

    bindNovelCard(card, novel);
    return card;
}

/** 书封视图：番茄 / 起点式的封面网格 */
function buildBookCard(novel) {
    const settings = getSettings();
    const progress = getNovelProgress(novel);
    const card = createElement('article', 'nr-book-card');
    card.dataset.novelId = novel.id;
    if (state.shelf.selected.has(novel.id)) card.classList.add('is-selected');

    const tone = BOOK_TONES[hashString(`${novel.title}|${novel.id}`) % BOOK_TONES.length];
    const cover = createElement('div', 'nr-book-cover');
    cover.style.setProperty('--nr-cover-a', tone[0]);
    cover.style.setProperty('--nr-cover-b', tone[1]);

    const coverUrl = String(novel.cover || novel.coverUrl || '').trim();
    if (coverUrl && !settings.shelfDefaultCover) {
        const image = document.createElement('img');
        image.className = 'nr-book-cover-img';
        image.src = coverUrl;
        image.alt = '';
        image.loading = 'lazy';
        image.addEventListener('error', () => image.remove());
        cover.appendChild(image);
    }

    const spine = createElement('span', 'nr-book-spine');
    const sheen = createElement('span', 'nr-book-sheen');
    const format = createElement('span', 'nr-book-format', novel.format || 'TXT');
    cover.append(spine, sheen, format);
    if (settings.shelfCoverTitle !== false) {
        cover.appendChild(createElement('span', 'nr-book-cover-title', novel.title));
    }
    if (settings.shelfCoverAuthor !== false) {
        cover.appendChild(createElement('span', 'nr-book-cover-author', novel.author || '未署名'));
    }

    if (isPinned(novel)) {
        const pin = createElement('span', 'nr-book-pin');
        pin.innerHTML = '<i class="fa-solid fa-thumbtack"></i>';
        pin.title = '已置顶';
        cover.appendChild(pin);
    }
    if (unreadOf(novel)) {
        const badge = createElement('span', 'nr-book-unread', String(unreadOf(novel)));
        badge.title = `${unreadOf(novel)} 章未读`;
        cover.appendChild(badge);
    }

    if (progress) {
        const bar = createElement('span', 'nr-book-bar');
        const fill = createElement('span', 'nr-book-bar-fill');
        fill.style.width = `${Math.round(progress.ratio * 100)}%`;
        bar.appendChild(fill);
        bar.title = `已读 ${Math.round(progress.ratio * 100)}%`;
        cover.appendChild(bar);
    }

    if (state.shelf.managing) {
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.className = 'nr-book-select';
        check.dataset.act = 'select';
        check.checked = state.shelf.selected.has(novel.id);
        check.setAttribute('aria-label', `选择《${novel.title}》`);
        cover.appendChild(check);
        const veil = createElement('span', 'nr-book-veil');
        veil.innerHTML = '<i class="fa-solid fa-check"></i>';
        cover.appendChild(veil);
    } else {
        const actions = createElement('div', 'nr-book-actions');
        const pinButton = createElement('button', 'nr-book-action');
        pinButton.type = 'button';
        pinButton.dataset.act = isPinned(novel) ? 'unpin' : 'pin';
        pinButton.title = isPinned(novel) ? '取消置顶' : '置顶';
        pinButton.setAttribute('aria-label', pinButton.title);
        pinButton.innerHTML = '<i class="fa-solid fa-thumbtack"></i>';
        const groupButton = createElement('button', 'nr-book-action');
        groupButton.type = 'button';
        groupButton.dataset.act = 'group';
        groupButton.title = '移到分组';
        groupButton.setAttribute('aria-label', '移到分组');
        groupButton.innerHTML = '<i class="fa-solid fa-folder-tree"></i>';
        const sumButton = createElement('button', 'nr-book-action');
        sumButton.type = 'button';
        sumButton.dataset.act = 'summary';
        sumButton.title = '总结这本书';
        sumButton.setAttribute('aria-label', `总结《${novel.title}》`);
        sumButton.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i>';
        const moreButton = createElement('button', 'nr-book-action');
        moreButton.type = 'button';
        moreButton.dataset.act = 'more';
        moreButton.title = '更多操作';
        moreButton.setAttribute('aria-label', `更多操作：${novel.title}`);
        moreButton.innerHTML = '<i class="fa-solid fa-ellipsis"></i>';
        actions.append(pinButton, groupButton, sumButton, moreButton);
        cover.appendChild(actions);
    }

    const info = createElement('div', 'nr-book-info');
    const name = createElement('div', 'nr-book-name', novel.title);
    name.title = novel.title;
    const meta = createElement('div', 'nr-book-meta');
    meta.textContent = `${novel.chapterCount || 0} 章 · ${formatCount(novel.charCount || 0)} 字`;
    const status = createElement('div', 'nr-book-status');
    if (progress) {
        status.classList.add('is-reading');
        status.textContent = `读至 ${progress.chapter} / ${progress.total} 章`;
    } else {
        status.textContent = '尚未开始';
    }
    info.append(name, meta, status);

    card.append(cover, info);
    bindNovelCard(card, novel);
    return card;
}

/** 被删掉的书正好是当前打开的那本：把阅读 / 总结 / 备忘的状态一起清掉 */
function clearCurrentNovelIfDeleted(ids) {
    const removed = new Set((Array.isArray(ids) ? ids : []).filter(Boolean));
    if (!state.novelId || !removed.has(state.novelId)) return;
    state.novel = null;
    state.novelId = null;
    state.chapters = [];
    state.selection.clear();
    state.chapterCache.clear();
    state.chapterImageCache.clear();
    clearNovelSearch({ render: false, keepFocus: true });
    state.reader = { index: 0, page: 0, pages: [''], images: [], loaded: false };
    resetMemoState();
    renderReaderSelect();
    renderSummarySelect();
    renderMemoSelect();
    renderStyleSelect();
    renderChapterList();
    renderSummaryChapters();
    renderArticle();
    renderMemoPanel();
}

async function handleDeleteNovel(novel) {
    if (!(await confirmAction(`确定删除《${novel.title}》及其总结和本书备忘？分组备忘会保留。`))) return;
    await deleteNovel(novel.id);
    state.shelf.selected.delete(novel.id);
    clearCurrentNovelIfDeleted([novel.id]);
    await refreshLibrary();
    toast('已删除');
}


/* ------------------------------------------------------------------ */
/* 书源书进书架：加入 / 更新 / 缓存 / 换源 / 编辑信息                   */
/* ------------------------------------------------------------------ */

function isSourceBook(novel) {
    // sourceUrl 是旧的下载路径留下的：书是从哪个源抓的，那它就是有源的书（能换源 / 能定位来源）
    return Boolean(novel?.sourceId || novel?.bookUrl || novel?.sourceUrl);
}

function findShelfBookByUrl(url) {
    const target = String(url || '').trim();
    if (!target) return null;
    return state.novels.find(novel => novel.bookUrl === target || novel.sourceUrl === target) || null;
}

/** 把「找书」里的书按章节元数据加入书架（正文阅读时再抓） */
async function addSourceBookToShelf(book) {
    if (!book?.sourceId || !book?.url) {
        toast('这本书没有书源信息，先下载再入库', 'warning');
        return null;
    }
    const existing = findShelfBookByUrl(book.url);
    if (existing) {
        toast(`《${existing.title}》已经在书架里了`, 'info');
        await openNovel(existing.id, 'reader');
        return existing;
    }
    const now = Date.now();
    const meta = {
        id: uuid(),
        title: makeUniqueTitle(book.title || '网络小说'),
        author: book.author || '',
        format: 'NET',
        encoding: 'utf-8',
        charCount: 0,
        chapterCount: book.chapters.length,
        sourceName: book.sourceName || book.originName || book.url,
        sourceUrl: book.url,
        sourceId: book.sourceId,
        bookUrl: book.url,
        tocUrl: book.tocUrl || book.url,
        origin: book.sourceId,
        originName: book.sourceName || book.originName || '',
        intro: book.intro || '',
        cover: book.cover || '',
        kind: book.kind || '',
        latestChapterTitle: book.chapters[book.chapters.length - 1]?.title || '',
        totalChapterNum: book.chapters.length,
        unreadCount: 0,
        canUpdate: true,
        lastCheckTime: now,
        createdAt: now,
        updatedAt: now,
    };
    await saveNovel(meta, book.chapters.map(chapter => ({
        title: chapter.title,
        url: chapter.url,
        isVolume: Boolean(chapter.isVolume),
        isVip: Boolean(chapter.isVip),
        isPay: Boolean(chapter.isPay),
    })));
    await refreshLibrary();
    toast(`已加入书架：《${meta.title}》${meta.chapterCount} 章 · 正文按章抓取`, 'success');
    await openNovel(meta.id, 'reader', { force: true });
    showTab('reader');
    return meta;
}

/** 更新书源书：拉最新目录，按章节 URL 比对，追加新章节并写未读数 */
async function updateShelfBook(novel, { silent = false, signal = null } = {}) {
    if (!isSourceBook(novel)) {
        if (!silent) toast('这本不是书源书，没有可更新的目录', 'warning');
        return { added: 0, total: Number(novel?.chapterCount) || 0 };
    }
    const runtime = getRuntime();
    try {
        if (!silent) setHeaderStatus(`正在更新《${novel.title}》…`);
        const result = await runtime.refreshBook({
            sourceId: novel.sourceId,
            bookUrl: novel.bookUrl || novel.sourceUrl,
            tocUrl: novel.tocUrl,
            title: novel.title,
            author: novel.author,
        }, {
            signal,
            onProgress: message => {
                if (!silent) setHeaderStatus(message);
            },
        });
        const existing = await getChapterList(novel.id);
        const known = new Set(existing.map(chapter => chapter.url).filter(Boolean));
        const fresh = existing.length
            ? result.chapters.filter(chapter => !known.has(chapter.url))
            : result.chapters;
        if (fresh.length) await appendChapters(novel.id, fresh, existing.length);
        const total = existing.length + fresh.length;
        const patch = {
            chapterCount: total,
            totalChapterNum: total,
            latestChapterTitle: result.chapters[result.chapters.length - 1]?.title || novel.latestChapterTitle || '',
            lastCheckTime: Date.now(),
            unreadCount: (Number(novel.unreadCount) || 0) + fresh.length,
            tocUrl: result.book.tocUrl || novel.tocUrl || '',
        };
        if (!novel.title && result.book.name) patch.title = result.book.name;
        if (!novel.author && result.book.author) patch.author = result.book.author;
        if (!novel.cover && result.book.coverUrl) patch.cover = result.book.coverUrl;
        if (!novel.intro && result.book.intro) patch.intro = result.book.intro;
        await updateNovel(novel.id, patch);
        if (state.novelId === novel.id && !state.online.reading) {
            state.chapters = await getChapterList(novel.id);
            state.novel = { ...state.novel, ...patch };
            renderChapterList();
            renderSummaryChapters();
            renderWorldbookSelect();
            renderMemoSelect();
            updateHeader();
        }
        await refreshLibrary();
        if (!silent) {
            toast(fresh.length ? `《${novel.title}》新增 ${fresh.length} 章，共 ${total} 章` : `《${novel.title}》没有新章节`,
                fresh.length ? 'success' : 'info');
        }
        return { added: fresh.length, total };
    } catch (error) {
        if (!silent) {
            toast(`更新失败：${error.message}`, 'error');
            setHeaderStatus('');
        }
        return { added: 0, total: Number(novel.chapterCount) || 0, error: error.message };
    }
}

/** 批量更新选中的书源书 */
async function updateSelectedBooks() {
    const ids = [...state.shelf.selected];
    const targets = state.novels.filter(novel => ids.includes(novel.id) && isSourceBook(novel));
    if (!targets.length) {
        toast('选中的书里没有可更新的书源书', 'warning');
        return;
    }
    let added = 0;
    let failed = 0;
    for (let index = 0; index < targets.length; index++) {
        setHeaderStatus(`正在更新 ${index + 1} / ${targets.length}：${targets[index].title}`);
        const result = await updateShelfBook(targets[index], { silent: true });
        added += result.added || 0;
        if (result.error) failed++;
    }
    setHeaderStatus('');
    setShelfManaging(false);
    toast(`更新完成：新增 ${added} 章${failed ? `，${failed} 本失败` : ''}`, failed ? 'warning' : 'success');
}

/** 书架卡片「更多」：更新 / 缓存 / 换源 / 编辑 / 删除 */
function openBookActionsDialog(novel) {
    const sourceBook = isSourceBook(novel);
    openWorldbookDialog({
        title: `《${novel.title}》`,
        kind: 'shelf',
        body: `
            <div class="nr-dialog-hint">${sourceBook
                ? `书源：${escapeHtml(novel.sourceName || novel.originName || '未知')} · ${novel.chapterCount || 0} 章${novel.unreadCount ? ` · ${novel.unreadCount} 章未读` : ''}`
                : '本地书籍：只能编辑信息 / 阅读 / 删除'}</div>
            <div class="nr-book-action-list">
                ${sourceBook ? '<button type="button" class="nr-btn nr-btn-sm" data-book-act="update">更新章节</button>' : ''}
                ${sourceBook ? '<button type="button" class="nr-btn nr-btn-sm" data-book-act="cache">缓存管理</button>' : ''}
                ${sourceBook ? '<button type="button" class="nr-btn nr-btn-sm" data-book-act="change">更换书源</button>' : ''}
                <button type="button" class="nr-btn nr-btn-sm" data-book-act="info">编辑书籍信息</button>
                <button type="button" class="nr-btn nr-btn-sm nr-danger" data-book-act="delete">删除这本书</button>
            </div>`,
        footer: '<button type="button" class="nr-btn nr-btn-sm" id="nr-book-actions-close">关闭</button>',
        onMount: ctx => {
            ctx.foot.querySelector('#nr-book-actions-close')?.addEventListener('click', ctx.close);
            ctx.body.addEventListener('click', async event => {
                const action = event.target.closest('[data-book-act]')?.dataset.bookAct;
                if (!action) return;
                ctx.close();
                if (action === 'update') await updateShelfBook(novel);
                else if (action === 'cache') openCacheDialog(novel);
                else if (action === 'change') openChangeSourceDialog(novel);
                else if (action === 'info') openBookInfoDialog(novel);
                else if (action === 'delete') await handleDeleteNovel(novel);
            });
        },
    });
}

/** 编辑书名 / 作者 / 封面 / 简介 / 分类 */
function openBookInfoDialog(novel) {
    openWorldbookDialog({
        title: '书籍信息',
        kind: 'shelf',
        body: `
            <div class="nr-source-editor-grid">
                <label class="nr-field"><span>书名</span><input id="nr-book-title" class="nr-input" value="${escapeHtml(novel.title || '')}"></label>
                <label class="nr-field"><span>作者</span><input id="nr-book-author" class="nr-input" value="${escapeHtml(novel.author || '')}"></label>
                <label class="nr-field"><span>分类</span><input id="nr-book-kind" class="nr-input" value="${escapeHtml(novel.kind || '')}" placeholder="玄幻 / 都市…"></label>
                <label class="nr-field"><span>封面地址</span><input id="nr-book-cover" class="nr-input" value="${escapeHtml(novel.cover || '')}"></label>
            </div>
            <label class="nr-field"><span>简介</span><textarea id="nr-book-intro" class="nr-input" rows="4">${escapeHtml(novel.intro || '')}</textarea></label>`,
        footer: '<button type="button" class="nr-btn nr-btn-sm" id="nr-book-info-cancel">取消</button><button type="button" class="nr-btn nr-btn-sm nr-primary" id="nr-book-info-save">保存</button>',
        onMount: ctx => {
            ctx.foot.querySelector('#nr-book-info-cancel')?.addEventListener('click', ctx.close);
            ctx.foot.querySelector('#nr-book-info-save')?.addEventListener('click', async () => {
                const patch = {
                    title: String(ctx.body.querySelector('#nr-book-title').value || '').trim() || novel.title,
                    author: String(ctx.body.querySelector('#nr-book-author').value || '').trim(),
                    kind: String(ctx.body.querySelector('#nr-book-kind').value || '').trim(),
                    cover: String(ctx.body.querySelector('#nr-book-cover').value || '').trim(),
                    intro: String(ctx.body.querySelector('#nr-book-intro').value || '').trim(),
                };
                await updateNovel(novel.id, patch);
                if (state.novelId === novel.id) {
                    state.novel = { ...state.novel, ...patch };
                    updateHeader();
                    renderReaderSelect();
                }
                await refreshLibrary();
                ctx.close();
                toast('书籍信息已保存');
            });
        },
    });
}

/** 缓存管理：预下载 / 清理 */
function openCacheDialog(novel) {
    if (!isSourceBook(novel)) {
        toast('本地书不需要缓存', 'warning');
        return;
    }
    let abort = null;
    openWorldbookDialog({
        title: `缓存 · ${novel.title}`,
        kind: 'shelf',
        wide: true,
        body: `
            <div class="nr-dialog-hint">缓存后的章节离线可读；换源会清空缓存。</div>
            <div class="nr-cache-row">
                <label class="nr-field nr-field-inline"><span>缓存前</span><input id="nr-cache-count" class="nr-input nr-input-sm" type="number" min="1" value="20"><span>章</span></label>
                <button type="button" class="nr-btn nr-btn-sm nr-primary" data-cache-act="first">缓存前 N 章</button>
                <button type="button" class="nr-btn nr-btn-sm" data-cache-act="all">缓存全部未缓存</button>
                <button type="button" class="nr-btn nr-btn-sm nr-danger" data-cache-act="clear">清空缓存</button>
                <button type="button" class="nr-btn nr-btn-sm" data-cache-act="stop" hidden>停止</button>
            </div>
            <div class="nr-inline-status" id="nr-cache-status">正在读取缓存情况…</div>`,
        footer: '<button type="button" class="nr-btn nr-btn-sm" id="nr-cache-close">关闭</button>',
        onMount: ctx => {
            const status = ctx.body.querySelector('#nr-cache-status');
            const stopButton = ctx.body.querySelector('[data-cache-act="stop"]');
            const setStatus = (text, error = false) => {
                status.hidden = !text;
                status.textContent = text || '';
                status.classList.toggle('is-error', error);
            };
            const refreshStats = async () => {
                const chapters = await getChapterList(novel.id);
                const cached = chapters.filter(chapter => chapter.cached).length;
                setStatus(`共 ${chapters.length} 章，已缓存 ${cached} 章`);
                return chapters;
            };
            const runCache = async (scope) => {
                if (abort) {
                    abort.abort(new Error('已停止'));
                    return;
                }
                const chapters = await getChapterList(novel.id);
                const limit = Math.max(1, Number(ctx.body.querySelector('#nr-cache-count').value) || 20);
                const targets = (scope === 'first' ? chapters.slice(0, limit) : chapters)
                    .filter(chapter => !chapter.cached && chapter.url);
                if (!targets.length) {
                    setStatus('没有需要缓存的章节');
                    return;
                }
                abort = new AbortController();
                stopButton.hidden = false;
                for (const button of ctx.body.querySelectorAll('[data-cache-act]')) {
                    if (button !== stopButton) button.disabled = true;
                }
                const runtime = getRuntime();
                let done = 0;
                let failed = 0;
                await mapLimit(targets, 3, async chapter => {
                    if (abort?.signal.aborted) return;
                    try {
                        const parsed = await runtime.fetchChapter({
                            title: chapter.title,
                            url: chapter.url,
                            bookUrl: novel.bookUrl || novel.sourceUrl,
                        }, { sourceId: novel.sourceId, signal: abort.signal });
                        await saveChapterContent(novel.id, chapter.index, parsed.text);
                        done++;
                    } catch (error) {
                        if (error?.name !== 'AbortError') failed++;
                    }
                    setStatus(`正在缓存：${done + failed} / ${targets.length}（成功 ${done}${failed ? `，失败 ${failed}` : ''}）`);
                });
                const aborted = Boolean(abort?.signal.aborted);
                abort = null;
                stopButton.hidden = true;
                for (const button of ctx.body.querySelectorAll('[data-cache-act]')) button.disabled = false;
                await refreshStats();
                if (state.novelId === novel.id) {
                    state.chapters = await getChapterList(novel.id);
                    renderChapterList();
                }
                setStatus(`${aborted ? '已停止：' : ''}缓存完成，成功 ${done} 章${failed ? `，失败 ${failed} 章` : ''}`, failed > 0);
            };
            ctx.foot.querySelector('#nr-cache-close')?.addEventListener('click', () => {
                abort?.abort(new Error('已停止'));
                ctx.close();
            });
            ctx.body.addEventListener('click', async event => {
                const action = event.target.closest('[data-cache-act]')?.dataset.cacheAct;
                if (!action) return;
                if (action === 'stop') {
                    abort?.abort(new Error('已停止'));
                    return;
                }
                if (action === 'clear') {
                    if (!(await confirmAction('清空这本书的全部正文缓存？'))) return;
                    await deleteChapterContents(novel.id, null);
                    if (state.novelId === novel.id) {
                        state.chapters = await getChapterList(novel.id);
                        state.chapterCache.clear();
                        renderChapterList();
                    }
                    await refreshStats();
                    return;
                }
                await runCache(action);
            });
            refreshStats().catch(error => setStatus(`读取失败：${error.message}`, true));
        },
    });
}

/**
 * 换源：把**所有其它书源**列出来，挑一个切过去；抓不到目录就再换下一个（和阅读 app 一样）。
 *
 * 打开时先并行搜一遍同名书，给每个源标状态；没搜到同名书的源点「切换」时会**只搜这一个源**，
 * 连同名书都没有就把这个源搜到的几本列出来让人挑 —— 不再出现「列表空白、不知道为什么」。
 */
function openChangeSourceDialog(novel) {
    if (!isSourceBook(novel)) {
        toast('本地书没有书源可换', 'warning');
        return;
    }
    let running = false;
    openWorldbookDialog({
        title: `更换书源 · ${novel.title}`,
        kind: 'shelf',
        wide: true,
        body: `
            <div class="nr-dialog-hint">下面是**全部其它书源**。点「切换」就用它抓一遍目录：抓到就换过去，抓不到可以再点别的源；
            正文缓存会清空，阅读进度尽量按章节标题对齐。</div>
            <div class="nr-debug-form">
                <input id="nr-change-keyword" class="nr-input nr-input-sm" placeholder="搜索关键词（默认用书名）">
                <button type="button" class="nr-btn nr-btn-sm nr-primary" id="nr-change-search">重新搜索</button>
            </div>
            <div class="nr-inline-status" id="nr-change-status" hidden></div>
            <div class="nr-source-list" id="nr-change-list"></div>`,
        footer: '<button type="button" class="nr-btn nr-btn-sm" id="nr-change-close">关闭</button>',
        onMount: ctx => {
            const statusEl = ctx.body.querySelector('#nr-change-status');
            const listBox = ctx.body.querySelector('#nr-change-list');
            const keywordInput = ctx.body.querySelector('#nr-change-keyword');
            ctx.foot.querySelector('#nr-change-close')?.addEventListener('click', ctx.close);
            const setStatus = (text, error = false) => {
                statusEl.hidden = !text;
                statusEl.textContent = text || '';
                statusEl.classList.toggle('is-error', Boolean(error));
            };
            const runtime = getRuntime();
            const keywordOf = () => String(keywordInput?.value || '').trim() || novel.title;
            const others = runtime.enabledSources().filter(source => source.bookSourceUrl !== novel.sourceId);
            /** url → { source, state, candidates, picks, message } */
            const rows = new Map();
            for (const source of others) {
                rows.set(source.bookSourceUrl, { source, state: 'idle', candidates: [], picks: [], message: '' });
            }
            const foundCount = () => [...rows.values()].filter(row => row.candidates.length).length;

            const renderRows = () => {
                listBox.replaceChildren();
                if (!others.length) {
                    listBox.appendChild(createElement('div', 'nr-empty', '还没有其它书源：先去「书源管理」导入 / 启用'));
                    return;
                }
                for (const row of rows.values()) {
                    const item = createElement('div', 'nr-source-item');
                    const main = createElement('div', 'nr-source-item-main');
                    main.appendChild(createElement('strong', null, row.source.bookSourceName));
                    const meta = [];
                    if (row.state === 'trying') meta.push('正在抓目录…');
                    else if (row.state === 'searching') meta.push('搜索中…');
                    else if (row.state === 'done') meta.push('已切换');
                    else if (row.state === 'error') meta.push(row.message || '搜索失败');
                    else if (row.candidates.length) meta.push(row.candidates[0]?.name ? `同名书：${row.candidates[0].name}` : '找到同名书');
                    else if (row.state === 'none') meta.push('没搜到同名书');
                    else if (row.state === 'idle') meta.push('待搜索');
                    if (row.message && row.state !== 'error' && row.state !== 'trying') meta.push(row.message);
                    main.appendChild(createElement('span', 'nr-muted', meta.join(' · ')));
                    if (row.candidates.length > 1) {
                        main.appendChild(createElement('span', 'nr-muted', `另有 ${row.candidates.length - 1} 本同名书，切换时用第一本`));
                    }
                    const button = createElement('button', 'nr-btn nr-btn-sm nr-primary', row.state === 'trying' ? '切换中…' : '切换');
                    button.type = 'button';
                    button.disabled = running || row.state === 'trying';
                    button.addEventListener('click', () => {
                        attempt(row).catch(error => setStatus(`切换失败：${error.message}`, true));
                    });
                    item.append(main, button);
                    // 这个源搜到了书、但没有同名书：列出来让用户自己挑一本试
                    if (row.picks.length) {
                        const pickBox = createElement('div', 'nr-change-picks');
                        pickBox.appendChild(createElement('span', 'nr-muted', '这个源搜到这些，点一本试试：'));
                        for (const book of row.picks) {
                            const pick = createElement('button', 'nr-link', `${book.name}${book.author ? `（${book.author}）` : ''}`);
                            pick.type = 'button';
                            pick.disabled = running;
                            pick.addEventListener('click', () => {
                                if (running) return;
                                running = true;
                                switchTo(book, row).finally(() => { running = false; renderRows(); });
                            });
                            pickBox.appendChild(pick);
                        }
                        item.appendChild(pickBox);
                    }
                    listBox.appendChild(item);
                }
            };

            /** 用一个候选书替换目录（抓到目录才算换成功） */
            const switchTo = async (book, row) => {
                row.state = 'trying';
                renderRows();
                setStatus(`正在用「${row.source.bookSourceName}」抓目录…`);
                try {
                    const result = await runtime.refreshBook({
                        sourceId: book.sourceId || row.source.bookSourceUrl,
                        bookUrl: book.bookUrl,
                        title: book.name,
                        author: book.author,
                    });
                    const oldChapters = await getChapterList(novel.id);
                    const progress = getSettings().progress?.[novel.id] || {};
                    const aligned = alignChapterIndex(oldChapters, result.chapters, progress.chapterIndex || 0);
                    await replaceChapters(novel.id, result.chapters);
                    await updateNovel(novel.id, {
                        sourceId: book.sourceId || row.source.bookSourceUrl,
                        origin: book.sourceId || row.source.bookSourceUrl,
                        sourceName: row.source.bookSourceName,
                        originName: row.source.bookSourceName,
                        sourceUrl: book.bookUrl,
                        bookUrl: book.bookUrl,
                        tocUrl: result.book.tocUrl || book.bookUrl,
                        chapterCount: result.chapters.length,
                        totalChapterNum: result.chapters.length,
                        latestChapterTitle: result.chapters[result.chapters.length - 1]?.title || '',
                        unreadCount: 0,
                        canUpdate: true,
                        lastCheckTime: Date.now(),
                    });
                    const settings = getSettings();
                    settings.progress = settings.progress || {};
                    settings.progress[novel.id] = {
                        chapterIndex: aligned.index,
                        page: 0,
                        updatedAt: Date.now(),
                    };
                    saveSettings();
                    if (state.novelId === novel.id) {
                        state.novel = await getNovel(novel.id);
                        state.chapters = await getChapterList(novel.id);
                        state.chapterCache.clear();
                        renderChapterList();
                        renderSummaryChapters();
                        await openChapter(aligned.index, 0, { silent: true });
                    }
                    await refreshLibrary();
                    row.state = 'done';
                    row.message = `${result.chapters.length} 章`;
                    setStatus(`已换到「${row.source.bookSourceName}」：${result.chapters.length} 章${aligned.matched ? '，进度已按章节标题对齐' : '，进度按比例估算'}`);
                    toast(`换源完成：${row.source.bookSourceName}`, 'success');
                } catch (error) {
                    row.state = 'error';
                    row.message = `抓目录失败：${error.message}`;
                    setStatus(`「${row.source.bookSourceName}」抓目录失败：${error.message}；可以再换别的源`, true);
                }
            };

            /** 点某个源的「切换」：有同名候选直接用，没有就只搜这个源再挑 */
            const attempt = async row => {
                if (running) return;
                running = true;
                try {
                    let book = row.candidates[0];
                    row.picks = [];
                    if (!book) {
                        row.state = 'trying';
                        renderRows();
                        setStatus(`正在用「${row.source.bookSourceName}」找《${keywordOf()}》…`);
                        const results = await runtime.searchInSource(row.source, keywordOf());
                        if (!results.length) {
                            row.state = 'error';
                            row.message = '这个源搜不到这本书';
                            setStatus(`「${row.source.bookSourceName}」搜不到《${keywordOf()}》；可以再换别的源`, true);
                            return;
                        }
                        const wanted = normalizeBookName(keywordOf());
                        const scored = results
                            .map(item => ({ ...item, nameScore: scoreBookName(item.name, wanted, item.author, novel.author) }))
                            .sort((left, right) => right.nameScore - left.nameScore);
                        book = scored.find(item => item.nameScore > 0);
                        if (!book) {
                            row.state = 'none';
                            row.message = '这个源没有同名书，下面列了它搜到的书';
                            row.picks = scored.slice(0, 5);
                            setStatus(`「${row.source.bookSourceName}」没有同名书，下面是它搜到的 ${row.picks.length} 本，点一本试试`);
                            return;
                        }
                    }
                    await switchTo(book, row);
                } catch (error) {
                    row.state = 'error';
                    row.message = `搜索失败：${error.message}`;
                    setStatus(`「${row.source.bookSourceName}」搜索失败：${error.message}`, true);
                } finally {
                    running = false;
                    renderRows();
                }
            };

            /** 打开时先并行搜一遍同名书，给每个源标状态（不挡「切换」按钮） */
            const searchAll = async () => {
                for (const row of rows.values()) {
                    row.state = 'searching';
                    row.candidates = [];
                    row.picks = [];
                    row.message = '';
                }
                renderRows();
                setStatus(`正在用 ${others.length} 个书源搜索「${keywordOf()}」…`);
                try {
                    const { items, perSource } = await runtime.searchAlternatives(novel, {
                        keyword: keywordOf(),
                        onProgress: ({ finished, total }) => {
                            if (!listBox.isConnected) return;
                            setStatus(`正在用 ${total} 个书源搜索…（${finished} / ${total} 完成，${foundCount()} 个源有同名书）`);
                        },
                        onSourceDone: ({ source, items: fresh }) => {
                            if (!listBox.isConnected) return;
                            const row = rows.get(source?.id);
                            if (!row) return;
                            row.candidates = fresh;
                            row.state = fresh.length ? 'found' : 'none';
                            renderRows();
                        },
                    });
                    for (const item of items || []) {
                        const row = rows.get(item.sourceId);
                        if (row && !row.candidates.some(existing => existing.bookUrl === item.bookUrl)) row.candidates.push(item);
                    }
                    for (const entry of perSource || []) {
                        const row = rows.get(entry.id);
                        if (!row) continue;
                        if (entry.error && entry.error !== '已停止') {
                            row.state = 'error';
                            row.message = `搜索失败：${entry.error}`;
                        } else if (!row.candidates.length && row.state !== 'error') {
                            row.state = 'none';
                            row.message = '';
                        } else if (row.candidates.length) {
                            row.state = 'found';
                            row.message = '';
                        }
                    }
                    if (!listBox.isConnected) return;
                    renderRows();
                    const found = foundCount();
                    if (!found) {
                        setStatus('其它书源里都没搜到同名书：直接点某个源的「切换」会现场只搜这个源，也可以换个关键词', true);
                    } else {
                        setStatus(`搜索完成：${found} 个源有同名书；没搜到的源也能点「切换」现场再搜`);
                    }
                } catch (error) {
                    setStatus(`搜索失败：${error.message}`, true);
                }
            };

            ctx.body.querySelector('#nr-change-search')?.addEventListener('click', () => { searchAll(); });
            keywordInput?.addEventListener('keydown', event => {
                if (event.key === 'Enter') searchAll();
            });
            if (!others.length) {
                renderRows();
                setStatus('书架里只有当前这一个书源：先去「书源管理」导入 / 启用别的源，才有得换', true);
                return;
            }
            searchAll();
        },
    });
}

/* ------------------------------------------------------------------ */
/* 书架管理：多选 / 分组 / 置顶 / 手动排序                             */
/* ------------------------------------------------------------------ */

function setShelfManaging(managing) {
    state.shelf.managing = Boolean(managing);
    if (!state.shelf.managing) state.shelf.selected.clear();
    renderLibrary();
}

function shelfSelectedIds() {
    return [...state.shelf.selected];
}

/** 置顶 / 取消置顶（单本和批量共用） */
async function setNovelsPinned(ids, pinned) {
    const list = (Array.isArray(ids) ? ids : []).filter(Boolean);
    if (!list.length) return;
    await patchNovels(list, { pinnedAt: pinned ? Date.now() : 0 });
    await refreshLibrary();
    toast(pinned ? `已置顶 ${list.length} 本` : `已取消置顶 ${list.length} 本`);
}

/** 新建一个书架分组；重名直接报错，不悄悄合并 */
async function createShelfGroup(name) {
    const clean = String(name || '').trim().slice(0, 24);
    if (!clean) throw new Error('先填分组名称');
    if (state.shelf.groups.some(group => group.name === clean)) throw new Error(`已经有「${clean}」这个分组了`);
    const group = {
        id: uuid(),
        name: clean,
        order: nextGroupOrder(state.shelf.groups),
        createdAt: Date.now(),
    };
    await saveShelfGroup(group);
    state.shelf.groups = sortShelfGroups([...state.shelf.groups, group]);
    return group;
}

/** 把书移到某个分组；groupId 为空 = 移出分组 */
async function moveNovelsToGroup(ids, groupId) {
    const list = (Array.isArray(ids) ? ids : []).filter(Boolean);
    if (!list.length) return;
    const name = groupId ? shelfGroupName(groupId) : '';
    await patchNovels(list, { groupId: groupId || '', groupName: name });
    await refreshLibrary();
    toast(groupId ? `已移到「${name}」` : '已移出分组');
}

/** 「移入分组」弹窗：选已有分组，或现场新建一个 */
function openMoveToGroupDialog(ids) {
    const list = (Array.isArray(ids) ? ids : []).filter(Boolean);
    if (!list.length) {
        toast('先选几本书', 'warning');
        return;
    }
    const commonGroup = list
        .map(id => state.novels.find(novel => novel.id === id)?.groupId || '')
        .reduce((acc, value, index) => (index === 0 ? value : (acc === value ? acc : null)), '');
    const options = state.shelf.groups
        .map(group => `<option value="${escapeHtml(group.id)}">${escapeHtml(group.name)}</option>`)
        .join('');
    const keepOption = commonGroup === null
        ? '<option value="__keep__" selected>（这些书现在不在同一个分组，保持不动）</option>'
        : '';
    openWorldbookDialog({
        title: `移动 ${list.length} 本书`,
        kind: 'shelf',
        body: `
            <div class="nr-dialog-hint">分组只影响书架的显示，不会改动书的正文，也不会影响总结和备忘。</div>
            <label class="nr-field">
                <span>目标分组</span>
                <select id="nr-move-group" class="nr-select">
                    ${keepOption}
                    <option value="">未分组</option>
                    ${options}
                    <option value="__new__">＋ 新建分组…</option>
                </select>
            </label>
            <label class="nr-field" id="nr-move-new-field" hidden>
                <span>新分组名称</span>
                <input id="nr-move-new-name" class="nr-input" maxlength="24" placeholder="例如：玄幻 / 同人 / 待读">
            </label>`,
        footer: `
            <button type="button" class="nr-btn nr-btn-sm" id="nr-move-cancel">取消</button>
            <button type="button" class="nr-btn nr-btn-sm nr-primary" id="nr-move-ok">移动</button>`,
        onMount: ctx => {
            const select = ctx.body.querySelector('#nr-move-group');
            const field = ctx.body.querySelector('#nr-move-new-field');
            const nameInput = ctx.body.querySelector('#nr-move-new-name');
            if (commonGroup !== null) select.value = commonGroup;
            select.addEventListener('change', () => {
                const creating = select.value === '__new__';
                field.hidden = !creating;
                if (creating) nameInput?.focus();
            });
            ctx.foot.querySelector('#nr-move-cancel')?.addEventListener('click', ctx.close);
            ctx.foot.querySelector('#nr-move-ok')?.addEventListener('click', async () => {
                try {
                    let groupId = select.value;
                    if (groupId === '__keep__') {
                        ctx.close();
                        return;
                    }
                    if (groupId === '__new__') {
                        groupId = (await createShelfGroup(nameInput?.value)).id;
                    }
                    const idsToMove = [...list];
                    ctx.close();
                    await moveNovelsToGroup(idsToMove, groupId);
                    if (state.shelf.managing) setShelfManaging(false);
                } catch (error) {
                    toast(error.message, 'error');
                }
            });
        },
    });
}

/** 分组管理弹窗：改名、排序、删除 */
function openShelfGroupManager() {
    openWorldbookDialog({
        title: '分组管理',
        kind: 'shelf',
        wide: true,
        body: `
            <div class="nr-dialog-hint">分组只用来整理书架。删分组不会删书，里面的书会回到「未分组」。</div>
            <div class="nr-shelf-group-new">
                <input id="nr-shelf-group-new-name" class="nr-input nr-input-sm" maxlength="24" placeholder="新分组名称">
                <button type="button" class="nr-btn nr-btn-sm nr-primary" id="nr-shelf-group-create">新建分组</button>
            </div>
            <div class="nr-shelf-group-list" id="nr-shelf-group-list"></div>`,
        footer: '<button type="button" class="nr-btn nr-btn-sm" id="nr-shelf-group-close">关闭</button>',
        onMount: ctx => {
            ctx.foot.querySelector('#nr-shelf-group-close')?.addEventListener('click', ctx.close);
            const newName = ctx.body.querySelector('#nr-shelf-group-new-name');
            const create = async () => {
                try {
                    await createShelfGroup(newName?.value);
                    if (newName) newName.value = '';
                    await refreshLibrary();
                    renderGroupList();
                } catch (error) {
                    toast(error.message, 'error');
                }
            };
            ctx.body.querySelector('#nr-shelf-group-create')?.addEventListener('click', create);
            newName?.addEventListener('keydown', event => {
                if (event.key === 'Enter') create();
            });

            const renderGroupList = () => {
                const box = ctx.body.querySelector('#nr-shelf-group-list');
                if (!box) return;
                const counts = countByGroup(state.novels, state.shelf.groups);
                box.replaceChildren();
                if (!state.shelf.groups.length) {
                    box.appendChild(createElement('div', 'nr-list-empty', '还没有分组。上面输入名字就能建一个。'));
                    return;
                }
                state.shelf.groups.forEach((group, index) => {
                    const row = createElement('div', 'nr-shelf-group-row');
                    const order = createElement('span', 'nr-shelf-group-order', String(index + 1));
                    const input = document.createElement('input');
                    input.className = 'nr-input nr-input-sm';
                    input.value = group.name;
                    input.maxLength = 24;
                    input.dataset.groupId = group.id;
                    const count = createElement('span', 'nr-muted', `${counts.groups.get(group.id) || 0} 本`);
                    const up = createIconButton('button', 'nr-icon-btn', '<i class="fa-solid fa-chevron-up"></i>');
                    up.type = 'button';
                    up.title = '上移';
                    up.disabled = index === 0;
                    const down = createIconButton('button', 'nr-icon-btn', '<i class="fa-solid fa-chevron-down"></i>');
                    down.type = 'button';
                    down.title = '下移';
                    down.disabled = index === state.shelf.groups.length - 1;
                    const remove = createIconButton('button', 'nr-icon-btn nr-danger-text', '<i class="fa-solid fa-trash-can"></i>');
                    remove.type = 'button';
                    remove.title = '删除分组（书回到未分组）';
                    row.append(order, input, count, up, down, remove);
                    box.appendChild(row);

                    const commitName = async () => {
                        const next = String(input.value || '').trim().slice(0, 24);
                        if (!next || next === group.name) {
                            input.value = group.name;
                            return;
                        }
                        if (state.shelf.groups.some(item => item.id !== group.id && item.name === next)) {
                            toast(`已经有「${next}」这个分组了`, 'warning');
                            input.value = group.name;
                            return;
                        }
                        await saveShelfGroup({ ...group, name: next });
                        state.shelf.groups = sortShelfGroups(state.shelf.groups.map(item => (
                            item.id === group.id ? { ...item, name: next } : item
                        )));
                        // 书里缓存的分组名跟着改，书架卡片不用再查一次
                        const movedIds = state.novels.filter(novel => novel.groupId === group.id).map(novel => novel.id);
                        if (movedIds.length) await patchNovels(movedIds, { groupName: next });
                        await refreshLibrary();
                        renderGroupList();
                    };
                    input.addEventListener('change', commitName);

                    const swap = async delta => {
                        const target = index + delta;
                        if (target < 0 || target >= state.shelf.groups.length) return;
                        const current = state.shelf.groups[index];
                        const other = state.shelf.groups[target];
                        await saveShelfGroup({ ...current, order: other.order ?? target + 1 });
                        await saveShelfGroup({ ...other, order: current.order ?? index + 1 });
                        state.shelf.groups = sortShelfGroups(state.shelf.groups.map(item => {
                            if (item.id === current.id) return { ...item, order: other.order ?? target + 1 };
                            if (item.id === other.id) return { ...item, order: current.order ?? index + 1 };
                            return item;
                        }));
                        await refreshLibrary();
                        renderGroupList();
                    };
                    up.addEventListener('click', () => swap(-1));
                    down.addEventListener('click', () => swap(1));

                    remove.addEventListener('click', async () => {
                        if (!(await confirmAction(`删除分组「${group.name}」？里面的书会回到「未分组」，不会被删。`))) return;
                        const moved = await deleteShelfGroup(group.id);
                        state.shelf.groups = state.shelf.groups.filter(item => item.id !== group.id);
                        const settings = getSettings();
                        if (settings.shelfGroup === group.id) {
                            settings.shelfGroup = '';
                            saveSettings();
                        }
                        await refreshLibrary();
                        renderGroupList();
                        toast(moved ? `分组已删除，${moved} 本书回到未分组` : '分组已删除');
                    });
                });
            };
            renderGroupList();
        },
    });
}

/** 手动排序还没初始化时，按更新时间先排一份，落成 manualOrder */
async function ensureManualOrder() {
    const missing = state.novels.filter(novel => !(Number(novel.manualOrder) > 0));
    if (!missing.length) return;
    const ordered = [...state.novels].sort((left, right) => updateTimeOf(right) - updateTimeOf(left));
    const orders = new Map(ordered.map((novel, index) => [novel.id, index + 1]));
    await setNovelOrders(orders);
    await refreshLibrary();
}

/** 手动排序：选中的那本和可见列表里的上 / 下一本交换位置 */
async function moveShelfSelection(delta) {
    const ids = shelfSelectedIds();
    if (ids.length !== 1) {
        toast('上移 / 下移一次只能动一本', 'warning');
        return;
    }
    const filter = currentShelfFilter();
    const view = buildShelfView(state.novels, filter);
    const visible = view.items;
    const id = ids[0];
    const position = visible.findIndex(novel => novel.id === id);
    const neighbor = visible[position + Math.sign(delta)];
    if (position < 0 || !neighbor) {
        toast(delta < 0 ? '已经是第一个了' : '已经是最后一个了', 'warning');
        return;
    }
    const full = [...state.novels].sort((left, right) => (
        (Number(left.manualOrder) || 0) - (Number(right.manualOrder) || 0)
        || updateTimeOf(right) - updateTimeOf(left)
    ));
    const a = full.findIndex(novel => novel.id === id);
    const b = full.findIndex(novel => novel.id === neighbor.id);
    if (a < 0 || b < 0) return;
    [full[a], full[b]] = [full[b], full[a]];
    await setNovelOrders(orderMapFromIds(full.map(novel => novel.id)));
    await refreshLibrary();
}

/** 批量删除选中的书 */
async function deleteShelfSelection() {
    const ids = shelfSelectedIds();
    if (!ids.length) return;
    if (!(await confirmAction(`确定删除选中的 ${ids.length} 本书？总结和本书备忘会一起删掉，分组备忘保留。`))) return;
    await deleteNovels(ids);
    clearCurrentNovelIfDeleted(ids);
    setShelfManaging(false);
    await refreshLibrary();
    toast(`已删除 ${ids.length} 本`);
}


async function restoreLastNovel(force = false) {
    const settings = getSettings();
    const id = settings.lastNovelId;
    if (!id || !state.novels.some(novel => novel.id === id)) {
        renderReaderSelect();
        renderSummarySelect();
        renderStyleSelect();
        renderMemoSelect();
        return;
    }
    if (state.novelId === id && !force) {
        renderReaderSelect();
        renderSummarySelect();
        renderStyleSelect();
        renderMemoSelect();
        return;
    }
    await openNovel(id, state.tab === 'summary' ? 'summary' : 'reader', { silent: true, noTab: true });
}

/* ------------------------------------------------------------------ */
/* 打开小说                                                            */
/* ------------------------------------------------------------------ */

async function openNovel(novelId, tab = 'reader', options = {}) {
    if (!novelId || state.loadingNovel) return;
    if (String(novelId).startsWith('online:')) {
        // 在线阅读的临时书不在 IndexedDB 里，点回它只是切标签
        if (state.online.reading?.id === novelId) showTab('reader');
        return;
    }
    if (state.novelId === novelId && state.chapters.length && !options.force) {
        showTab(tab);
        return;
    }
    const willResetMemo = Boolean(state.novelId !== novelId || options.force);
    if (willResetMemo && memoEditorHasUnsavedChanges()) {
        const ok = await confirmAction('当前备忘还有未保存的修改，切换小说会丢失。要继续吗？');
        if (!ok) return;
    }
    if (state.online.reading) {
        // 确认过备忘之后才退出在线阅读模式：用户取消时状态保持原样
        state.online.reading = null;
        syncOnlineReaderUi();
    }
    if (state.worldbook.running) stopWorldbook();
    state.loadingNovel = true;
    try {
        const novel = await getNovel(novelId);
        if (!novel) throw new Error('这本书已经不存在了');
        const chapters = await getChapterList(novelId);
        if (!chapters.length) throw new Error('这本书没有章节数据');

        state.novel = novel;
        state.novelId = novelId;
        state.chapters = chapters;
        state.chapterCache.clear();
        state.chapterImageCache.clear();
        await reloadBookmarks();
        clearNovelSearch({ render: false, keepFocus: true });
        state.styleSample = { novelId: null, chars: 0, text: '' };
        state.cardGreetings = { novelId: null, start: '', end: '' };
        state.selection = new Set(chapters.filter(chapter => !chapter.isVolume).map(chapter => chapter.index));
        state.selectionAnchor = null;
        state.wbSelection = new Set(chapters.filter(chapter => !chapter.isVolume).map(chapter => chapter.index));
        state.wbSelectionAnchor = null;
        state.worldbook.loadedNovelId = null;
        state.worldbook.result = null;
        state.worldbook.editingIndex = null;
        state.worldbook.expanded = new Set();
        resetMemoState();

        const settings = getSettings();
        settings.lastNovelId = novelId;
        saveSettings();
        if (Number(novel.unreadCount) > 0) {
            novel.unreadCount = 0;
            updateNovel(novelId, { unreadCount: 0 }).catch(() => {});
            const index = state.novels.findIndex(item => item.id === novelId);
            if (index >= 0) state.novels[index] = { ...state.novels[index], unreadCount: 0 };
        }

        renderReaderSelect();
        renderSummarySelect();
        renderWorldbookSelect();
        renderMemoSelect();
        renderStyleSelect();
        renderChapterList();
        renderSummaryChapters();
        renderWorldbookConfig();
        renderWorldbookChapters();
        updateBudgetInfo();
        updateWorldbookBudget();
        refreshHistory().catch(() => {});
        await loadWorldbookForNovel(novelId);
        await loadMemosForNovel(novelId);
        updateHeader();
        syncOnlineReaderUi();

        const progress = settings.progress?.[novelId];
        const chapterIndex = clamp(Number(progress?.chapterIndex) || 0, 0, chapters.length - 1);
        const page = Math.max(0, Number(progress?.page) || 0);
        await openChapter(chapterIndex, page, { silent: true });

        // 记一次「读过」：书架按阅读时间排序、显示「上次阅读」都靠它
        markNovelRead(novelId).then(updated => {
            if (!updated) return;
            const index = state.novels.findIndex(item => item.id === novelId);
            if (index >= 0) {
                state.novels[index] = { ...state.novels[index], lastReadAt: updated.lastReadAt };
            }
            if (state.tab === 'library') renderLibrary();
        }).catch(() => {});

        if (!options.noTab) showTab(tab);
    } catch (error) {
        console.error('[小说阅读器] 打开小说失败', error);
        toast(`打开失败：${error.message}`, 'error');
    } finally {
        state.loadingNovel = false;
    }
}

function setHeaderStatus(text) {
    if (elements.headerStatus) elements.headerStatus.textContent = text;
}

function updateHeader() {
    if (!state.novel) {
        setStatus('就绪');
        return;
    }
    const tag = state.online.reading ? ' · 在线阅读' : '';
    setStatus(`${state.novel.title} · ${state.chapters.length} 章${tag}`);
}

function renderReaderSelect() {
    renderNovelSelect(elements.readerSelect, '选择小说…');
}

function renderSummarySelect() {
    renderNovelSelect(elements.summarySelect, '选择小说…');
}

function renderWorldbookSelect() {
    renderNovelSelect(elements.wbSelect, '选择小说…');
}

function renderMemoSelect() {
    renderNovelSelect(elements.memoSelect, '选择小说…');
}

function renderNovelSelect(select, placeholder) {
    if (!select) return;
    select.replaceChildren();
    const online = state.online.reading;
    if (state.novels.length === 0 && !online) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = '书架为空';
        option.disabled = true;
        select.appendChild(option);
        select.value = '';
        return;
    }
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = placeholder;
    empty.disabled = true;
    select.appendChild(empty);
    if (online) {
        const option = document.createElement('option');
        option.value = online.id;
        option.textContent = `${online.title}（在线阅读）`;
        select.appendChild(option);
    }
    for (const novel of state.novels) {
        const option = document.createElement('option');
        option.value = novel.id;
        option.textContent = novel.title;
        select.appendChild(option);
    }
    if (state.novelId) select.value = state.novelId;
    else select.value = '';
}

/* ------------------------------------------------------------------ */
/* 网络找书                                                            */
/* ------------------------------------------------------------------ */

function getOnlineSettings() {
    return normalizeOnlineSettings(getSettings().online);
}

/** 抓取器是懒加载的：第一次用到时才建，之后跟着设置更新 */
function getFetcher() {
    const settings = getOnlineSettings();
    if (!state.online.fetcher) {
        state.online.fetcher = new NovelFetcher({
            settings,
            getRequestHeaders: () => getContext()?.getRequestHeaders?.() || null,
        });
    } else {
        state.online.fetcher.update(settings);
    }
    return state.online.fetcher;
}

/** 规则引擎运行时：书源搜索 / 详情 / 目录 / 正文都走它 */
function getRuntime() {
    const settings = {
        ...getOnlineSettings(),
        // 替换规则存在顶层设置里，运行时也要拿到
        replaceRules: getSettings().replaceRules || [],
    };
    if (!state.online.runtime) {
        state.online.runtime = new SourceRuntime({
            settings,
            getRequestHeaders: () => getContext()?.getRequestHeaders?.() || null,
        });
    } else {
        state.online.runtime.update(settings);
    }
    return state.online.runtime;
}

function setOnlineStatus(text, isError = false) {
    if (!elements.onlineStatus) return;
    if (!text) {
        elements.onlineStatus.hidden = true;
        elements.onlineStatus.textContent = '';
        elements.onlineStatus.classList.remove('is-error');
        return;
    }
    elements.onlineStatus.hidden = false;
    elements.onlineStatus.textContent = text;
    elements.onlineStatus.classList.toggle('is-error', isError);
}

/** 搜索 / 打开链接期间：主按钮禁用；停止按钮由 syncOnlineStopButton 统一控制 */
function setOnlineBusy(busy) {
    if (elements.onlineSearch) elements.onlineSearch.disabled = busy;
    if (elements.onlineOpen) elements.onlineOpen.disabled = busy;
    if (elements.onlineQuery) elements.onlineQuery.disabled = busy;
    syncOnlineStopButton();
}

/** 搜索、解析、批量抓取时都要能点「停止」 */
function syncOnlineStopButton() {
    // 下载有自己的停止按钮（在进度条上），这里只管搜索 / 打开书
    const busy = state.online.searching || state.online.loadingBook;
    if (elements.onlineStop) elements.onlineStop.hidden = !busy;
}

/** 只停「搜索」：不动正在解析的书，也不动下载 */
function stopOnlineSearch() {
    const hadSearch = Boolean(state.online.abort);
    const hadBook = Boolean(state.online.bookAbort);
    if (state.online.abort) {
        state.online.abort.abort(new Error('已停止搜索'));
        state.online.abort = null;
    }
    if (state.online.bookAbort) {
        state.online.bookAbort.abort(new Error('已停止'));
        state.online.bookAbort = null;
    }
    state.online.searching = false;
    setOnlineBusy(false);
    if (hadSearch || hadBook) setOnlineStatus('已停止搜索');
}

/** 只停「下载」：进度条旁边的按钮走这里 */
function stopOnlineDownload() {
    if (!state.online.download.abort) return;
    state.online.download.abort.abort(new Error('已停止下载'));
    setOnlineStatus('正在停止下载…已抓到的章节会保留');
}

function fillOnlineSelect(select, options) {
    if (!select || select.dataset.ready === '1') return;
    select.replaceChildren();
    for (const option of options) {
        const node = document.createElement('option');
        node.value = option.value;
        node.textContent = option.label;
        select.appendChild(node);
    }
    select.dataset.ready = '1';
}

/** 把设置同步到控件 / 把控件值写回设置 */
function renderOnlineSettings() {
    const settings = getOnlineSettings();
    fillOnlineSelect(elements.onlineEngine, SEARCH_ENGINE_OPTIONS);
    fillOnlineSelect(elements.onlineChannel, ONLINE_CHANNEL_OPTIONS);
    if (elements.onlineEngine) elements.onlineEngine.value = settings.searchEngine;
    if (elements.onlineChannel) elements.onlineChannel.value = settings.channel;
    if (elements.onlineProxy) elements.onlineProxy.value = settings.proxyTemplate;
    if (elements.onlineFanqieBridge) elements.onlineFanqieBridge.value = settings.fanqieBridge;
    if (elements.onlineFanqieUpstream) elements.onlineFanqieUpstream.value = settings.fanqieUpstream;
    if (elements.onlineConcurrency) elements.onlineConcurrency.value = String(settings.concurrency);
    if (elements.onlineChapterTimeout) elements.onlineChapterTimeout.value = String(settings.chapterTimeoutMs || 20000);
    if (elements.onlineRespectRate) elements.onlineRespectRate.checked = settings.respectRateLimit === true;
    if (elements.onlineExact) elements.onlineExact.checked = settings.exactMatch === true;
    if (elements.onlineTimeout) elements.onlineTimeout.value = String(settings.timeoutMs);
    if (elements.onlineLimit) elements.onlineLimit.value = String(settings.downloadLimit);
    if (elements.onlineSort) elements.onlineSort.value = settings.sourceSort;
    syncOnlinePageSizeSelect(settings.pageSize);
    if (elements.onlineQuery && !elements.onlineQuery.value) {
        elements.onlineQuery.value = getSettings().onlineQuery || '';
    }
    renderOnlineSources();
}

/* -------------------------- 书源 -------------------------- */

/** 当前导入的书源 */
function getOnlineSources() {
    return getOnlineSettings().sources;
}

/**
 * 这条通道要不要桥接：番茄和书源都要。
 * 番茄靠它跟下载器说话；书源靠它发 POST / 带 Cookie / 批量抓页面 ——
 * 所以「装没装、装完怎么装」这件事两条通道都得讲，不能只在番茄那边提示。
 * @returns {boolean} 需要桥接返回 true
 */
function bridgeEngineApplies() {
    const engine = getOnlineSettings().searchEngine;
    return engine === 'fanqie' || engine === 'source';
}

/** 桥接在这种通道下叫什么：书源里它就是「抓取桥接」（和番茄共用一个服务端插件） */
function bridgeLabel() {
    return getOnlineSettings().searchEngine === 'source' ? '抓取桥接' : '番茄桥接';
}

/**
 * 把桥接块直接摆出来并重新检查一次。
 * 书源报错里带「桥接」时用它 —— 安装命令就在眼前，比只丢一句 fetch failed 有用。
 * @returns {void}
 */
function revealBridgeBlock() {
    if (!elements.onlineBridge) return;
    elements.onlineBridge.hidden = false;
    state.online.bridgeShownFor = getOnlineSettings().searchEngine;
    refreshBridgeInstallInfo().catch(() => {});
}

/**
 * 搜索通道提示。
 * - 番茄：三条通道里只有它自己依赖桥接，所以常驻一句「不装也能用别的通道」；
 * - 书源：桥接就绪时不必打扰；没装 / 连不上时才提示 —— 但要说清「不用它也能用」：
 *   导入、搜索、阅读、下载都照常，只是走酒馆网页通道（只能 GET、逐页抓）慢很多；
 *   必须有桥接的只有 POST / 自定义请求头 / Cookie 这类书源。
 */
function renderOnlineEngineHint() {
    const hint = elements.onlineEngineHint;
    const textEl = elements.onlineEngineHintText;
    if (!hint || !textEl) return;
    const settings = getOnlineSettings();
    if (!bridgeEngineApplies()) {
        hint.hidden = true;
        return;
    }
    if (settings.searchEngine === 'fanqie') {
        hint.hidden = false;
        textEl.textContent = '番茄小说是可选的：不装桥接也能用「书源」找书，读、总结都不受影响。';
        return;
    }
    const bridge = state.online.bridge || { state: 'unknown' };
    if (bridge.state === 'ready') {
        hint.hidden = true;
        return;
    }
    hint.hidden = false;
    if (bridge.state === 'unknown') {
        textEl.textContent = '书源不用桥接也能用（导入、搜索、下载都照常，只是慢）：正在检查抓取桥接…';
        return;
    }
    if (bridge.state === 'missing') {
        textEl.textContent = '书源不装桥接也能用：导入、搜索、加入书架后阅读、下载到书架都照常，只是走酒馆网页通道'
            + '（只能 GET、一页一页抓），会明显慢很多。桥接能让 POST / 自定义请求头 / Cookie 的书源也可用，'
            + '并且批量抓页面快很多 —— 想装就在酒馆根目录执行下面的命令，然后重启酒馆。';
        return;
    }
    textEl.textContent = `抓取桥接连不上（${bridge.error || '未知错误'}）：书源照常能导入、搜索、下载，只是慢`
        + '（只能 GET）；POST / Cookie 的书源会失败。装过就检查扩展设置里的桥接地址，没装过就执行下面的命令。';
}

/**
 * 书源概况：搜索永远打「所有启用的书源」，所以这里不需要下拉选源，
 * 只在「书源」通道下显示一行「共 N 个书源 · M 个启用」。
 */
function renderOnlineSources() {
    const settings = getOnlineSettings();
    const sources = settings.sources;
    const enabled = sources.filter(source => source.enabled !== false).length;
    const sourceMode = settings.searchEngine === 'source';
    state.online.sourceCount = enabled;
    renderOnlineEngineHint();
    // 书源专属的入口和设置：番茄通道下藏起来，免得「书源管理 / 发现」和书源规则混在番茄里
    if (elements.onlineSourceManage) elements.onlineSourceManage.hidden = !sourceMode;
    if (elements.onlineExplore) elements.onlineExplore.hidden = !sourceMode;
    // 精准搜索是给「书源模糊匹配」用的：番茄那边书名由下载器给，不存在同站异名，藏起来
    if (elements.onlineExactField) elements.onlineExactField.hidden = !sourceMode;
    if (elements.onlineRespectRateField) elements.onlineRespectRateField.hidden = !sourceMode;
    if (elements.onlineSortField) elements.onlineSortField.hidden = !sourceMode;
    if (elements.onlineSearch) {
        elements.onlineSearch.textContent = settings.searchEngine === 'source'
            ? `搜索（共 ${enabled} 个书源）`
            : '搜索';
    }
    if (elements.onlineBridge) {
        // 番茄和书源都显示这块：书源通道下它是「抓取桥接 · 安装 / 卸载」
        const showBridge = bridgeEngineApplies();
        elements.onlineBridge.hidden = !showBridge;
        if (elements.onlineBridgeTitle) {
            elements.onlineBridgeTitle.textContent = `${bridgeLabel()} · 安装 / 卸载`;
        }
        if (showBridge && state.online.bridgeShownFor !== settings.searchEngine) {
            // 换过通道（或第一次显示）：重新检查一次，文案才会跟着通道走
            state.online.bridgeShownFor = settings.searchEngine;
            refreshBridgeInstallInfo().catch(() => {});
        } else if (!showBridge) {
            state.online.bridgeShownFor = '';
        }
    }
    if (!elements.onlineSourceSummary) return;
    elements.onlineSourceSummary.hidden = !sourceMode;
    if (!sourceMode) return;
    const groupCount = new Set(sources.flatMap(source => splitSourceGroups(source.bookSourceGroup))).size;
    elements.onlineSourceSummary.textContent = sources.length
        ? `共 ${sources.length} 个书源 · ${enabled} 个启用${groupCount ? ` · ${groupCount} 个分组` : ''}`
        : '还没有书源，点「书源管理」导入';
}

/** 当前启用的书源列表 */
function enabledSources() {
    return getOnlineSettings().sources.filter(source => source.enabled !== false);
}

/** 保存书源列表 */
function commitOnlineSources({ sources } = {}) {
    const settings = getSettings();
    const patch = { ...settings.online };
    if (Array.isArray(sources)) patch.sources = sources;
    settings.online = normalizeOnlineSettings(patch);
    saveSettings();
    state.online.fetcher?.update(settings.online);
    state.online.runtime?.update({
        ...getOnlineSettings(),
        replaceRules: getSettings().replaceRules || [],
    });
    renderOnlineSources();
    renderOnlineResults();
    return settings.online;
}

/** 导出 / 编辑时用：转回 Legado 结构，运行时字段不写进 JSON */
function serializeSource(source) {
    return exportSource(source);
}

/** 书源管理弹窗：贴 JSON / 选文件 → 解析 → 列表里启用停用编辑删除 */

/** 发现：选书源 → 选分类 → 结果进搜索列表 */
function openExploreDialog() {
    const runtime = getRuntime();
    const sources = runtime.enabledSources().filter(source => String(source.exploreUrl || '').trim());
    if (!sources.length) {
        toast('没有带「发现地址」的启用书源：先去书源管理导入/编辑', 'warning');
        return;
    }
    const options = sources
        .map(source => `<option value="${escapeHtml(source.bookSourceUrl)}">${escapeHtml(source.bookSourceName)}</option>`)
        .join('');
    openWorldbookDialog({
        title: '发现',
        kind: 'shelf',
        wide: true,
        body: `
            <div class="nr-explore-head">
                <label class="nr-field nr-field-inline">
                    <span>书源</span>
                    <select id="nr-explore-source" class="nr-select">${options}</select>
                </label>
                <span class="nr-muted" id="nr-explore-hint"></span>
            </div>
            <div class="nr-explore-list" id="nr-explore-list"></div>`,
        footer: '<button type="button" class="nr-btn nr-btn-sm" id="nr-explore-close">关闭</button>',
        onMount: ctx => {
            const select = ctx.body.querySelector('#nr-explore-source');
            const list = ctx.body.querySelector('#nr-explore-list');
            const hint = ctx.body.querySelector('#nr-explore-hint');
            ctx.foot.querySelector('#nr-explore-close')?.addEventListener('click', ctx.close);
            let current = null;
            let running = false;

            const renderEntries = () => {
                current = sources.find(source => source.bookSourceUrl === select.value) || sources[0];
                list.replaceChildren();
                if (!current) return;
                let entries = [];
                try {
                    entries = runtime.parseExplore(current);
                } catch (error) {
                    hint.textContent = error.message;
                    return;
                }
                if (!entries.length && String(current.exploreUrl || '').trim().startsWith('@js:')) {
                    hint.textContent = '正在执行发现的 JS 规则…';
                    runtime.exploreEntries(current).then(list => {
                        if (!list.length) {
                            hint.textContent = '这个书源的 JS 发现规则没有返回分类';
                            return;
                        }
                        renderEntriesFromList(list);
                    }).catch(error => {
                        hint.textContent = `解析发现地址失败：${error.message}`;
                    });
                    return;
                }
                renderEntriesFromList(entries);
            };

            const renderEntriesFromList = entries => {
                hint.textContent = entries.length ? `共 ${entries.length} 个分类` : '这个书源的发现地址解析不出分类';
                for (const entry of entries) {
                    const button = createElement('button', 'nr-explore-item');
                    button.type = 'button';
                    button.textContent = entry.title;
                    button.addEventListener('click', async () => {
                        if (running) return;
                        running = true;
                        for (const item of list.querySelectorAll('button')) item.disabled = true;
                        hint.textContent = `正在打开「${entry.title}」…`;
                        try {
                            const books = await runtime.explore(current, entry);
                            state.online.query = `${current.bookSourceName} · ${entry.title}`;
                            // 分类浏览是按书源的「发现」列表来的，不是关键词搜索，别让精准搜索把它清空
                            state.online.rawResults = mergeSourceResults(books.map(ruleBookToResult), getOnlineSettings().sourceSort);
                            state.online.results = state.online.rawResults;
                            state.online.page = 1;
                            renderOnlineResults();
                            setOnlineStatus(`「${current.bookSourceName} · ${entry.title}」找到 ${books.length} 条`);
                            ctx.close();
                            if (!isPanelOpen()) togglePanel(true);
                        } catch (error) {
                            hint.textContent = `打开失败：${error.message}`;
                        } finally {
                            running = false;
                            for (const item of list.querySelectorAll('button')) item.disabled = false;
                        }
                    });
                    list.appendChild(button);
                }
            };
            select.addEventListener('change', renderEntries);
            renderEntries();
        },
    });
}


/** 书源调试：搜索 / 详情 / 目录 / 正文，显示每步耗时、规则命中与错误 */
function openSourceDebugDialog(source) {
    openWorldbookDialog({
        title: `调试 · ${source.bookSourceName}`,
        kind: 'shelf',
        wide: true,
        body: `
            <div class="nr-dialog-hint">
                搜索关键词留空时用书源的「校验关键字」。也可以直接填书籍页 URL 跳过搜索。
                ${sourceNeedsJs(source) ? '<br><b>这个书源用了 JS 规则：</b>需要浏览器 Worker 与服务端桥接（/fetch、/cookie）。' : ''}
            </div>
            <div class="nr-debug-form">
                <input id="nr-debug-keyword" class="nr-input nr-input-sm" placeholder="搜索关键词（可留空）" value="${escapeHtml(source.ruleSearch?.checkKeyWord || '')}">
                <input id="nr-debug-url" class="nr-input nr-input-sm" placeholder="或书籍页 URL">
                <button type="button" class="nr-btn nr-btn-sm nr-primary" id="nr-debug-run">开始调试</button>
                <button type="button" class="nr-btn nr-btn-sm" id="nr-debug-login">执行登录 JS</button>
            </div>
            <div class="nr-inline-status" id="nr-debug-status" hidden></div>
            <pre class="nr-debug-output" id="nr-debug-output"></pre>`,
        footer: '<button type="button" class="nr-btn nr-btn-sm" id="nr-debug-close">关闭</button>',
        onMount: ctx => {
            const status = ctx.body.querySelector('#nr-debug-status');
            const output = ctx.body.querySelector('#nr-debug-output');
            const keywordInput = ctx.body.querySelector('#nr-debug-keyword');
            const urlInput = ctx.body.querySelector('#nr-debug-url');
            ctx.foot.querySelector('#nr-debug-close')?.addEventListener('click', ctx.close);
            getRuntime().bridgePing().then(ping => {
                if (ping.ok) setStatus(`桥接可用（v${ping.version || '?'}）`);
                else if (ping.status) setStatus(`桥接未加载（HTTP ${ping.status}）：重启酒馆后再试`, true);
                else setStatus(`桥接连不上：${ping.error || '未知错误'}`, true);
            }).catch(() => {});
            const setStatus = (text, error = false) => {
                status.hidden = !text;
                status.textContent = text || '';
                status.classList.toggle('is-error', Boolean(error));
            };
            const formatStep = (step, index) => {
                const mark = step.ok ? '✓' : '✗';
                const line = `${index + 1}. ${mark} ${step.name} (${step.ms}ms) ${step.ok ? step.summary : step.error}`;
                const traces = (step.traces || []).slice(0, 12).map(trace => {
                    const detail = trace.trace?.[0];
                    return `    · ${trace.kind} ${trace.rule} → ${trace.count}${detail ? `（${detail.ms}ms）` : ''}`;
                });
                return [line, ...traces].join('\n');
            };
            ctx.body.querySelector('#nr-debug-run')?.addEventListener('click', async () => {
                setStatus('正在调试…');
                output.textContent = '';
                try {
                    const runtime = getRuntime();
                    const result = await runtime.debug(source, {
                        keyword: keywordInput?.value || '',
                        url: urlInput?.value || '',
                    });
                    const lines = [
                        `结果：${result.ok ? '全部通过' : '有失败步骤'} · JS 沙箱：${result.jsSandbox ? '可用' : '不可用'}`,
                        '',
                        ...result.steps.map(formatStep),
                    ];
                    if (result.warnings?.length) lines.push('', '提示：', ...result.warnings.map(item => `  · ${item}`));
                    output.textContent = lines.join('\n');
                    setStatus(result.ok ? '调试完成' : '调试完成，有失败步骤', !result.ok);
                } catch (error) {
                    setStatus(`调试失败：${error.message}`, true);
                }
            });
            ctx.body.querySelector('#nr-debug-login')?.addEventListener('click', async () => {
                setStatus('正在执行登录脚本…');
                try {
                    await getRuntime().loginSource(source);
                    setStatus('登录脚本已执行：Cookie / 登录头已写入桥接', false);
                } catch (error) {
                    setStatus(`登录失败：${error.message}`, true);
                }
            });
        },
    });
}

/** 书源管理：新模型（Legado 字段）+ 导入导出 + 四段校验 + JSON 编辑 */
function openSourceManager() {
    const body = `
        <div class="nr-dialog-hint">
            书源支持 Legado / 阅读 的字段（含 jsLib、并发率、登录头等）。导入后可以逐个启用、编辑 JSON、
            或做「搜索 → 详情 → 目录 → 正文」四段校验。校验只验证当前网络与站点，失败不代表书源永久失效。
        </div>
        <div class="nr-source-editor" id="nr-source-editor" hidden>
            <div class="nr-source-editor-grid">
                <label class="nr-field"><span>名称</span><input id="nr-src-name" class="nr-input" maxlength="60"></label>
                <label class="nr-field"><span>地址</span><input id="nr-src-url" class="nr-input" placeholder="https://example.com"></label>
                <label class="nr-field"><span>分组</span><input id="nr-src-group" class="nr-input" placeholder="玄幻,都市"></label>
                <label class="nr-field"><span>类型</span>
                    <select id="nr-src-type" class="nr-select">
                        <option value="0">0 文本</option>
                        <option value="1">1 音频</option>
                        <option value="2">2 图片</option>
                        <option value="3">3 文件</option>
                        <option value="4">4 视频</option>
                    </select>
                </label>
                <label class="nr-field"><span>并发率</span><input id="nr-src-rate" class="nr-input" placeholder="3/1000 或留空"></label>
                <label class="nr-field"><span>搜索地址</span><input id="nr-src-search" class="nr-input" placeholder="https://example.com/search?q={{key}}"></label>
                <label class="nr-field"><span>发现地址</span><input id="nr-src-explore" class="nr-input" placeholder="标题::地址，一行一个"></label>
            </div>
            <label class="nr-field"><span>请求头 / 登录（JSON 字符串，可留空）</span>
                <textarea id="nr-src-header" class="nr-input" rows="2" spellcheck="false"></textarea></label>
            <label class="nr-field"><span>规则 JSON（ruleSearch / ruleBookInfo / ruleToc / ruleContent）</span>
                <textarea id="nr-src-rules" class="nr-input nr-source-json" rows="9" spellcheck="false"></textarea></label>
            <div class="nr-source-editor-actions">
                <button type="button" class="nr-btn nr-btn-sm nr-primary" id="nr-src-save">保存书源</button>
                <button type="button" class="nr-btn nr-btn-sm" id="nr-src-cancel">取消</button>
                <span class="nr-muted" id="nr-src-editor-hint"></span>
            </div>
        </div>
        <div class="nr-source-import">
            <textarea id="nr-source-json" class="nr-input nr-source-json" rows="5" spellcheck="false"
                placeholder='粘贴书源 JSON（数组 / 单条 / {"sources":[...]} 都行）'></textarea>
            <div class="nr-source-import-actions">
                <button type="button" class="nr-btn nr-btn-sm nr-primary" id="nr-source-import">导入这段 JSON</button>
                <button type="button" class="nr-btn nr-btn-sm" id="nr-source-new">新建书源</button>
                <button type="button" class="nr-btn nr-btn-sm" id="nr-source-pick">本地文件</button>
                <button type="button" class="nr-btn nr-btn-sm" id="nr-source-clipboard">从剪贴板导入</button>
                <input type="file" id="nr-source-file" accept=".json,.txt,application/json,text/plain" hidden>
                <input id="nr-source-url" class="nr-input nr-input-sm" type="url" placeholder="书源 JSON 直链 / 合集页地址">
                <button type="button" class="nr-btn nr-btn-sm" id="nr-source-url-import">从链接导入</button>
            </div>
            <div class="nr-muted" id="nr-source-import-hint">「从链接导入」走酒馆服务端抓取；书源合集站（如 Yiove）粘合集详情页即可。</div>
        </div>
        <div class="nr-source-toolbar">
            <select id="nr-source-group-filter" class="nr-select nr-select-sm" aria-label="按分组筛选书源"></select>
            <input id="nr-source-filter" class="nr-input nr-input-sm" type="search" placeholder="搜索名称 / 地址 / 分组">
            <button type="button" class="nr-btn nr-btn-sm" id="nr-source-check">校验所选</button>
            <button type="button" class="nr-btn nr-btn-sm" id="nr-source-enable">启用所选</button>
            <button type="button" class="nr-btn nr-btn-sm" id="nr-source-disable">停用所选</button>
            <button type="button" class="nr-btn nr-btn-sm" id="nr-source-export">导出</button>
            <button type="button" class="nr-btn nr-btn-sm" id="nr-source-copy">复制 JSON</button>
            <button type="button" class="nr-btn nr-btn-sm nr-danger" id="nr-source-delete">删除所选</button>
            <label class="nr-shelf-check"><input type="checkbox" id="nr-source-select-all"><span>全选</span></label>
            <span class="nr-muted" id="nr-source-count"></span>
        </div>
        <div class="nr-inline-status" id="nr-source-status" hidden></div>
        <div class="nr-source-list" id="nr-source-list"></div>
    `;
    openWorldbookDialog({
        title: '书源管理',
        body,
        wide: true,
        kind: 'shelf',
        footer: '<button type="button" class="nr-btn nr-btn-sm" id="nr-source-close">关闭</button>',
        onMount: ctx => {
            const query = id => ctx.body.querySelector(id);
            const listBox = query('#nr-source-list');
            const statusEl = query('#nr-source-status');
            const countEl = query('#nr-source-count');
            const groupFilter = query('#nr-source-group-filter');
            const keywordInput = query('#nr-source-filter');
            const selectAll = query('#nr-source-select-all');
            const importHint = query('#nr-source-import-hint');
            const editor = query('#nr-source-editor');
            const editorHint = query('#nr-src-editor-hint');
            const rawInput = query('#nr-source-json');
            const fileInput = query('#nr-source-file');
            const urlInput = query('#nr-source-url');

            /** 勾选 + 筛选 + 校验结果都只存在弹窗里 */
            const selected = new Set();
            const checks = new Map();
            let keyword = '';
            let groupScope = '';
            let editingId = '';
            let checkAbort = null;
            let renderLimit = 60;

            const sources = () => getOnlineSettings().sources;
            const findById = id => sources().find(source => source.bookSourceUrl === id) || null;

            const setStatus = (text, isError = false) => {
                if (!statusEl) return;
                statusEl.hidden = !text;
                statusEl.textContent = text || '';
                statusEl.classList.toggle('is-error', Boolean(isError));
            };

            const sourceIssues = source => {
                try {
                    return validateSource(source);
                } catch {
                    return ['书源结构异常'];
                }
            };

            const renderGroupOptions = () => {
                if (!groupFilter) return;
                const groups = new Set();
                for (const source of sources()) {
                    for (const group of splitSourceGroups(source.bookSourceGroup)) groups.add(group);
                }
                const wanted = groupScope;
                groupFilter.replaceChildren();
                const all = document.createElement('option');
                all.value = '';
                all.textContent = `全部分组（${sources().length}）`;
                groupFilter.appendChild(all);
                const none = document.createElement('option');
                none.value = '__none__';
                none.textContent = `未分组（${sources().filter(source => !splitSourceGroups(source.bookSourceGroup).length).length}）`;
                groupFilter.appendChild(none);
                for (const group of [...groups].sort((a, b) => a.localeCompare(b, 'zh'))) {
                    const option = document.createElement('option');
                    option.value = group;
                    option.textContent = `${group}（${sources().filter(source => splitSourceGroups(source.bookSourceGroup).includes(group)).length}）`;
                    groupFilter.appendChild(option);
                }
                groupFilter.value = [...groupFilter.options].some(option => option.value === wanted) ? wanted : '';
            };

            const matchesFilter = source => {
                const groups = splitSourceGroups(source.bookSourceGroup);
                if (groupScope === '__none__' && groups.length) return false;
                if (groupScope && groupScope !== '__none__' && !groups.includes(groupScope)) return false;
                if (!keyword) return true;
                const haystack = `${source.bookSourceName} ${source.bookSourceUrl} ${source.bookSourceGroup}`.toLowerCase();
                return haystack.includes(keyword);
            };

            const syncToolbar = visible => {
                const selectedVisible = visible.filter(source => selected.has(source.bookSourceUrl)).length;
                if (countEl) {
                    countEl.textContent = sources().length
                        ? `${visible.length} / ${sources().length} 个书源${selected.size ? ` · 已选 ${selected.size}` : ''}`
                        : '还没有书源';
                }
                if (selectAll) {
                    selectAll.checked = visible.length > 0 && selectedVisible === visible.length;
                    selectAll.indeterminate = selectedVisible > 0 && selectedVisible < visible.length;
                    selectAll.disabled = visible.length === 0;
                }
                for (const button of ctx.body.querySelectorAll('.nr-source-toolbar .nr-btn')) {
                    if (button.id === 'nr-source-check') continue;
                    button.disabled = selected.size === 0 && button.id !== 'nr-source-export';
                }
            };

            const checkBadge = source => {
                const check = checks.get(source.bookSourceUrl);
                if (!check) return null;
                const badge = createElement('span', check.ok ? 'nr-source-check-ok' : 'nr-source-check-fail',
                    check.ok ? '校验通过' : '校验失败');
                badge.title = check.steps
                    .map(step => `${step.ok ? '✓' : '✗'} ${step.name}${step.error ? `：${step.error}` : ''}（${step.ms}ms）`)
                    .join('\n');
                return badge;
            };

            const renderList = () => {
                const all = sources();
                const visible = all.filter(matchesFilter);
                const shown = visible.slice(0, renderLimit);
                listBox.replaceChildren();
                if (!all.length) {
                    listBox.appendChild(createElement('div', 'nr-list-empty', '还没有书源：上面贴 JSON 导入，或点「新建书源」。'));
                    syncToolbar(visible);
                    return;
                }
                if (!visible.length) {
                    listBox.appendChild(createElement('div', 'nr-list-empty', '没有匹配的书源'));
                    syncToolbar(visible);
                    return;
                }
                for (const source of shown) {
                    const row = createElement('div', 'nr-source-item');
                    row.dataset.id = source.bookSourceUrl;

                    const check = document.createElement('input');
                    check.type = 'checkbox';
                    check.className = 'nr-source-check';
                    check.checked = selected.has(source.bookSourceUrl);
                    check.title = '选中后可批量操作';
                    check.addEventListener('change', () => {
                        if (check.checked) selected.add(source.bookSourceUrl);
                        else selected.delete(source.bookSourceUrl);
                        syncToolbar(visible);
                    });
                    row.appendChild(check);

                    const main = createElement('div', 'nr-source-item-main');
                    const titleRow = createElement('div', 'nr-source-item-title');
                    titleRow.appendChild(createElement('strong', null, source.bookSourceName));
                    titleRow.appendChild(createElement('span', 'nr-badge', ['文本', '音频', '图片', '文件', '视频'][source.bookSourceType] || '文本'));
                    if (sourceNeedsJs(source)) {
                        const jsBadge = createElement('span', 'nr-source-js-badge', 'JS');
                        jsBadge.title = '这个书源用了 @js / {{}} 规则，需要浏览器 Worker 沙箱';
                        titleRow.appendChild(jsBadge);
                    }
                    for (const group of splitSourceGroups(source.bookSourceGroup)) {
                        titleRow.appendChild(createElement('span', 'nr-source-group-tag', group));
                    }
                    const badge = checkBadge(source);
                    if (badge) titleRow.appendChild(badge);
                    main.appendChild(titleRow);

                    const meta = createElement('div', 'nr-muted nr-source-item-meta');
                    const issues = sourceIssues(source);
                    meta.textContent = [
                        source.bookSourceUrl,
                        source.searchUrl ? '有搜索' : '无搜索',
                        source.exploreUrl ? '有发现' : '无发现',
                        issues.length ? `${issues.length} 个提示` : '',
                    ].filter(Boolean).join(' · ');
                    if (issues.length) {
                        meta.title = issues.join('\n');
                        meta.classList.add('is-warn');
                    }
                    main.appendChild(meta);
                    row.appendChild(main);

                    const toggle = createElement('button', 'nr-btn nr-btn-sm', source.enabled === false ? '启用' : '停用');
                    toggle.type = 'button';
                    toggle.addEventListener('click', () => {
                        const next = all.map(item => (item.bookSourceUrl === source.bookSourceUrl
                            ? { ...item, enabled: source.enabled === false }
                            : item));
                        commitOnlineSources({ sources: next });
                        renderList();
                    });

                    const checkButton = createElement('button', 'nr-btn nr-btn-sm', '校验');
                    checkButton.type = 'button';
                    checkButton.addEventListener('click', () => runCheck([source]));

                    const debugButton = createElement('button', 'nr-btn nr-btn-sm', '调试');
                    debugButton.type = 'button';
                    debugButton.addEventListener('click', () => openSourceDebugDialog(source));

                    const editButton = createElement('button', 'nr-btn nr-btn-sm', '编辑');
                    editButton.type = 'button';
                    editButton.addEventListener('click', () => openEditor(source));

                    const remove = createIconButton('button', 'nr-icon-btn nr-danger-text', '<i class="fa-solid fa-trash-can"></i>');
                    remove.type = 'button';
                    remove.title = '删除这个书源';
                    remove.addEventListener('click', async () => {
                        if (!(await confirmAction(`删除书源「${source.bookSourceName}」？`))) return;
                        commitOnlineSources({ sources: all.filter(item => item.bookSourceUrl !== source.bookSourceUrl) });
                        selected.delete(source.bookSourceUrl);
                        renderGroupOptions();
                        renderList();
                    });

                    row.append(toggle, checkButton, debugButton, editButton, remove);
                    listBox.appendChild(row);
                }
                if (visible.length > shown.length) {
                    const more = createElement('button', 'nr-btn nr-btn-sm nr-source-more',
                        `显示更多（剩余 ${visible.length - shown.length}）`);
                    more.type = 'button';
                    more.addEventListener('click', () => {
                        renderLimit += 60;
                        renderList();
                    });
                    listBox.appendChild(more);
                }
                syncToolbar(visible);
            };

            const openEditor = source => {
                editingId = source?.bookSourceUrl || '';
                editor.hidden = false;
                query('#nr-src-name').value = source?.bookSourceName || '';
                query('#nr-src-url').value = source?.bookSourceUrl || '';
                query('#nr-src-group').value = source?.bookSourceGroup || '';
                query('#nr-src-type').value = String(source?.bookSourceType ?? 0);
                query('#nr-src-rate').value = source?.concurrentRate || '';
                query('#nr-src-search').value = source?.searchUrl || '';
                query('#nr-src-explore').value = source?.exploreUrl || '';
                query('#nr-src-header').value = source?.header || '';
                query('#nr-src-rules').value = JSON.stringify({
                    ruleSearch: source?.ruleSearch || {},
                    ruleBookInfo: source?.ruleBookInfo || {},
                    ruleToc: source?.ruleToc || {},
                    ruleContent: source?.ruleContent || {},
                }, null, 2);
                editorHint.textContent = editingId ? '编辑已有书源（地址改掉会当成新书源）' : '新建书源';
                editor.scrollIntoView({ block: 'nearest' });
            };

            const closeEditor = () => {
                editor.hidden = true;
                editingId = '';
                editorHint.textContent = '';
            };

            const saveEditor = () => {
                try {
                    const rules = JSON.parse(query('#nr-src-rules').value || '{}');
                    const draft = {
                        bookSourceName: query('#nr-src-name').value.trim(),
                        bookSourceUrl: query('#nr-src-url').value.trim(),
                        bookSourceGroup: query('#nr-src-group').value.trim(),
                        bookSourceType: Number(query('#nr-src-type').value) || 0,
                        concurrentRate: query('#nr-src-rate').value.trim(),
                        searchUrl: query('#nr-src-search').value.trim(),
                        exploreUrl: query('#nr-src-explore').value.trim(),
                        header: query('#nr-src-header').value.trim(),
                        ...rules,
                    };
                    const source = normalizeSource(draft);
                    if (!source) throw new Error('名称和地址不能为空');
                    const all = sources();
                    const next = all.filter(item => item.bookSourceUrl !== editingId && item.bookSourceUrl !== source.bookSourceUrl);
                    next.push(source);
                    commitOnlineSources({ sources: next });
                    selected.delete(editingId);
                    closeEditor();
                    renderGroupOptions();
                    renderList();
                    setStatus(`已保存「${source.bookSourceName}」`);
                } catch (error) {
                    editorHint.textContent = error.message;
                }
            };

            const importFrom = input => {
                try {
                    const { sources: imported, warnings } = importSources(input);
                    const merged = mergeSources(sources(), imported);
                    commitOnlineSources({ sources: merged.sources });
                    renderGroupOptions();
                    renderList();
                    importHint.textContent = `导入完成：新增 ${merged.added} 个，覆盖 ${merged.replaced} 个${warnings.length ? ` · ${warnings.slice(0, 2).join('；')}` : ''}`;
                    if (rawInput) rawInput.value = '';
                } catch (error) {
                    importHint.textContent = error.message;
                }
            };

            const runCheck = async targets => {
                if (checkAbort) {
                    checkAbort.abort(new Error('已停止'));
                    return;
                }
                const list = (targets && targets.length ? targets : sources().filter(source => selected.has(source.bookSourceUrl)))
                    .filter(Boolean);
                if (!list.length) {
                    setStatus('先勾选要校验的书源', true);
                    return;
                }
                checkAbort = new AbortController();
                const runtime = getRuntime();
                let ok = 0;
                let failed = 0;
                for (let index = 0; index < list.length; index++) {
                    if (checkAbort.signal.aborted) break;
                    const source = list[index];
                    setStatus(`正在校验 ${index + 1} / ${list.length}：${source.bookSourceName}…`);
                    try {
                        const result = await runtime.validate(source, { signal: checkAbort.signal });
                        checks.set(source.bookSourceUrl, result);
                        if (result.ok) ok++;
                        else failed++;
                    } catch (error) {
                        checks.set(source.bookSourceUrl, {
                            ok: false,
                            steps: [{ name: '校验', ok: false, ms: 0, error: error.message }],
                        });
                        failed++;
                    }
                    renderList();
                }
                checkAbort = null;
                setStatus(`校验结束：通过 ${ok} 个，失败 ${failed} 个`, failed > 0);
            };

            /* 绑定 */
            query('#nr-source-import')?.addEventListener('click', () => importFrom(rawInput?.value || ''));
            query('#nr-source-new')?.addEventListener('click', () => openEditor(null));
            query('#nr-source-pick')?.addEventListener('click', () => fileInput?.click());
            query('#nr-source-clipboard')?.addEventListener('click', async () => {
                try {
                    const text = await navigator.clipboard?.readText?.();
                    if (!text) throw new Error('剪贴板是空的，或浏览器不允许读取');
                    importFrom(text);
                } catch (error) {
                    importHint.textContent = `从剪贴板导入失败：${error.message}`;
                }
            });
            fileInput?.addEventListener('change', async () => {
                const file = fileInput.files?.[0];
                if (!file) return;
                try {
                    importFrom(await file.text());
                } catch (error) {
                    importHint.textContent = error.message;
                }
                fileInput.value = '';
            });
            query('#nr-source-url-import')?.addEventListener('click', async () => {
                const url = String(urlInput?.value || '').trim();
                if (!url) {
                    importHint.textContent = '先填一个书源 JSON 链接';
                    return;
                }
                importHint.textContent = '正在从链接读取书源集合…';
                try {
                    const payload = await requestSourceCollection({
                        url,
                        limit: 0,
                        getRequestHeaders: () => getContext()?.getRequestHeaders?.() || null,
                    });
                    if (!payload?.sources?.length) throw new Error(payload?.error || '这个链接里没有书源');
                    importFrom(payload.sources);
                } catch (error) {
                    importHint.textContent = `从链接导入失败：${error.message}`;
                }
            });
            query('#nr-src-save')?.addEventListener('click', saveEditor);
            query('#nr-src-cancel')?.addEventListener('click', closeEditor);
            query('#nr-source-check')?.addEventListener('click', () => runCheck());
            query('#nr-source-enable')?.addEventListener('click', () => {
                const next = sources().map(source => (selected.has(source.bookSourceUrl) ? { ...source, enabled: true } : source));
                commitOnlineSources({ sources: next });
                renderList();
            });
            query('#nr-source-disable')?.addEventListener('click', () => {
                const next = sources().map(source => (selected.has(source.bookSourceUrl) ? { ...source, enabled: false } : source));
                commitOnlineSources({ sources: next });
                renderList();
            });
            query('#nr-source-delete')?.addEventListener('click', async () => {
                if (!selected.size) return;
                if (!(await confirmAction(`删除选中的 ${selected.size} 个书源？`))) return;
                const next = sources().filter(source => !selected.has(source.bookSourceUrl));
                selected.clear();
                commitOnlineSources({ sources: next });
                renderGroupOptions();
                renderList();
            });
            const exportSources = () => {
                const all = sources();
                const visible = all.filter(matchesFilter);
                const list = selected.size
                    ? all.filter(source => selected.has(source.bookSourceUrl))
                    : (visible.length ? visible : all);
                downloadText(`novel-sources-${Date.now()}.json`, JSON.stringify(list.map(serializeSource), null, 2));
                setStatus(`已导出 ${list.length} 个书源`);
            };
            query('#nr-source-export')?.addEventListener('click', exportSources);
            query('#nr-source-copy')?.addEventListener('click', async () => {
                const all = sources();
                const visible = all.filter(matchesFilter);
                const list = selected.size
                    ? all.filter(source => selected.has(source.bookSourceUrl))
                    : (visible.length ? visible : all);
                const ok = await copyText(JSON.stringify(list.map(serializeSource), null, 2));
                setStatus(ok ? `已复制 ${list.length} 个书源 JSON 到剪贴板` : '复制失败，请用「导出」下载 JSON', !ok);
            });
            selectAll?.addEventListener('change', () => {
                const visible = sources().filter(matchesFilter);
                if (selectAll.checked) visible.forEach(source => selected.add(source.bookSourceUrl));
                else visible.forEach(source => selected.delete(source.bookSourceUrl));
                renderList();
            });
            groupFilter?.addEventListener('change', () => {
                groupScope = groupFilter.value;
                renderLimit = 60;
                renderList();
            });
            keywordInput?.addEventListener('input', debounce(() => {
                keyword = keywordInput.value.trim().toLowerCase();
                renderLimit = 60;
                renderList();
            }, 120));
            // 关闭按钮在 footer 里，不能拿 body 去查
            ctx.foot.querySelector('#nr-source-close')?.addEventListener('click', () => {
                checkAbort?.abort(new Error('已停止'));
                ctx.close();
            });

            renderGroupOptions();
            renderList();
        },
    });
}

function commitOnlineSettings() {
    const settings = getSettings();
    settings.online = normalizeOnlineSettings({
        ...settings.online,
        searchEngine: elements.onlineEngine?.value || settings.online.searchEngine,
        channel: elements.onlineChannel?.value || settings.online.channel,
        proxyTemplate: elements.onlineProxy?.value ?? settings.online.proxyTemplate,
        fanqieBridge: elements.onlineFanqieBridge?.value ?? settings.online.fanqieBridge,
        fanqieUpstream: elements.onlineFanqieUpstream?.value ?? settings.online.fanqieUpstream,
        concurrency: elements.onlineConcurrency?.value ?? settings.online.concurrency,
        chapterTimeoutMs: elements.onlineChapterTimeout?.value ?? settings.online.chapterTimeoutMs,
        respectRateLimit: elements.onlineRespectRate ? elements.onlineRespectRate.checked : settings.online.respectRateLimit,
        timeoutMs: elements.onlineTimeout?.value ?? settings.online.timeoutMs,
        downloadLimit: elements.onlineLimit?.value ?? settings.online.downloadLimit,
        sourceSort: elements.onlineSort?.value ?? settings.online.sourceSort,
        exactMatch: elements.onlineExact ? elements.onlineExact.checked : settings.online.exactMatch,
    });
    saveSettings();
    state.online.fetcher?.update(settings.online);
}

/** 绝对路径 → 相对酒馆根目录（装不动时返回空串） */
function relativeToServerRoot(target, root) {
    if (!target || !root) return '';
    const norm = value => String(value).replace(/\\/g, '/').replace(/\/+$/, '');
    const full = norm(target);
    const base = norm(root);
    if (!base || full === base || !full.startsWith(`${base}/`)) return '';
    return full.slice(base.length + 1);
}

/** 在这台机器上执行安装/卸载桥接的命令（桥接装了就用绝对路径，没装就按扩展 URL 推） */
async function refreshBridgeInstallInfo() {
    const statusEl = elements.onlineBridgeStatus;
    const listEl = elements.onlineInstallList;
    const noteEl = elements.onlineInstallNote;
    if (!statusEl || !listEl) return;
    const label = bridgeLabel();
    const forSource = getOnlineSettings().searchEngine === 'source';
    if (elements.onlineBridgeTitle) elements.onlineBridgeTitle.textContent = `${label} · 安装 / 卸载`;
    const previous = state.online.bridge?.state || 'unknown';
    statusEl.textContent = `正在检查${label}…`;
    listEl.replaceChildren();
    if (noteEl) noteEl.textContent = '';

    /**
     * 记下结果，顺手把「书源能不能走桥接」一起校正：
     * 桥接从没就绪变回就绪时，NetClient 上那句 bridgeAvailable=false 还挂着，会继续只走酒馆通道。
     */
    const setBridgeState = (next) => {
        state.online.bridge = next;
        // 只负责「救活」：探测到桥接在，就把 NetClient 上可能挂着的 bridgeAvailable=false 清掉，
        // 否则装好桥接后它还会一直只走酒馆通道。
        // 探测不到时**不要**替它判死 —— 老版本桥接没有 /health，直接请求照样能用。
        const net = state.online.runtime?.client;
        if (net && next.state === 'ready') {
            net.bridgeAvailable = true;
            if (previous !== 'ready') net.batchUnavailable = false;
        }
        // 抓取器（粘链接打开书籍页时用）也记着「桥接没装」：装好点刷新后要让它重新试一次
        if (next.state === 'ready' && state.online.fetcher) state.online.fetcher.bridgeAvailable = null;
        renderOnlineEngineHint();
    };

    const renderRows = (rows, note = '') => {
        listEl.replaceChildren();
        for (const [rowLabel, command] of rows) {
            if (!command) continue;
            const row = createElement('div', 'nr-online-install-row');
            row.appendChild(createElement('span', 'nr-online-install-label', rowLabel));
            row.appendChild(createElement('code', 'nr-online-install-cmd', command));
            const copy = createElement('button', 'nr-btn nr-btn-sm', '复制');
            copy.type = 'button';
            copy.addEventListener('click', async () => {
                const ok = await copyText(command);
                toast(ok ? '命令已复制' : '复制失败，请手动选中复制', ok ? 'success' : 'warning');
            });
            row.appendChild(copy);
            listEl.appendChild(row);
        }
        if (noteEl) noteEl.textContent = note;
    };

    const client = getFetcher().fanqie();
    /** 已安装时只保留卸载命令；未安装时才给安装命令 */
    const renderInstalled = (payload, note, statusText) => {
        const commands = payload?.commands || {};
        // 命令统一给 node 版：能算成相对酒馆根目录就用相对路径，算不出来再退回绝对路径；
        // 都没有时退回服务端给的那条（兼容老桥接的 commands.uninstall）
        const relative = relativeToServerRoot(payload?.extensionDir, payload?.serverRoot);
        const dir = relative || payload?.extensionDir || '';
        const uninstall = bridgeCommandOf('uninstall', dir) || commands.uninstall || '';
        statusEl.textContent = statusText;
        renderRows([['卸载（保留数据）', uninstall]], note);
    };
    try {
        const payload = await client.health();
        const version = payload?.version || '?';
        const downloader = payload?.downloader?.version || '未启动';
        setBridgeState({
            state: 'ready',
            version,
            downloader: payload?.downloader?.version || '',
            error: '',
        });
        renderInstalled(
            payload,
            payload?.dataDir ? `用户数据目录：${payload.dataDir}（卸载不会动它）` : '',
            // 书源只需要桥接本身；下载器起没起不影响书源搜索
            forSource
                ? `${label}已安装（v${version}）· 书源可以走桥接抓页面了`
                : `${label}已安装（v${version}）· 下载器 ${downloader}`,
        );
    } catch (error) {
        const detail = error?.detail || null;
        if (detail?.commands) {
            // 桥接在，但下载器没跑起来（503）：仍按「已安装」处理，只给卸载命令
            setBridgeState({
                state: 'ready',
                version: detail?.version || '?',
                downloader: '',
                error: error.message,
            });
            renderInstalled(
                detail,
                detail.dataDir ? `用户数据目录：${detail.dataDir}（卸载不会动它）` : '',
                forSource
                    ? `${label}已安装（v${detail?.version || '?'}）· 下载器没就绪（书源搜索不受影响）`
                    : `${label}已安装，但下载器没就绪：${error.message}`,
            );
            return;
        }
        // 404 基本就是「这个路由不存在」= 桥接没装（酒馆对未装插件的路径就是 404）；
        // 其余错误（连接被拒 / 超时 / 地址指错）按「连不上」处理
        const missing = error?.missingBridge === true || Number(error?.status) === 404;
        setBridgeState({
            state: missing ? 'missing' : 'error',
            version: '',
            downloader: '',
            error: error?.message || String(error),
        });
        // 桥接没装：按扩展的 URL 路径推一个相对酒馆根目录的命令
        // 全局装的 URL 是 /scripts/extensions/...，服务器上对应 public/scripts/...
        // 有的部署会把 public 也带进 URL（比如自测台直接从酒馆根目录起服务），这时别再重复加一层
        const guess = EXT_REL_PATH.startsWith('public/')
            ? EXT_REL_PATH
            : `public/${EXT_REL_PATH}`;
        const installCommand = bridgeCommandOf('install', guess);
        statusEl.textContent = forSource
            ? (missing
                ? '抓取桥接未安装（书源不装也能用）：导入书源、搜索、加入书架后阅读、下载到书架都照常，'
                    + '只是走酒馆网页通道（只能 GET、逐页抓）会慢很多；只有 POST / 自定义请求头 / Cookie 的书源必须有它，'
                    + '装了还能批量抓页面提速。想装就在酒馆根目录执行下面的命令，然后重启酒馆'
                : `抓取桥接连不上（${error?.message || '未知错误'}）：书源照常能导入、搜索、下载，只是慢（只能 GET）；`
                    + 'POST / Cookie 的书源会失败。没装过就执行下面的命令，装过就检查扩展设置里的桥接地址与酒馆是否正常')
            : (missing
                ? '番茄桥接未安装（番茄小说是可选的）：要番茄通道就在酒馆根目录执行下面的命令，然后重启酒馆；'
                    + '不想装就把搜索通道换成「书源」，照样能找书'
                : `番茄桥接连不上（${error?.message || '未知错误'}）：装过桥接就检查扩展设置里的桥接地址与酒馆；`
                    + '没装过就执行下面的命令，或把通道换成「书源」');
        renderRows([
            ['安装桥接', installCommand],
        ], `在酒馆根目录执行（Windows / Linux / macOS 通用，酒馆本身就要装 Node）· 扩展目录（按 URL 推断）：`
            + `${new URL('../', import.meta.url).pathname}`
            + ' · 脚本会按自身位置找到酒馆根目录；按用户安装时把 public/… 换成 data/<用户名>/extensions/novel-reader/ 并补上酒馆目录参数');
    }
}

function toggleOnlineSettings(force) {
    if (!elements.onlineSettings) return;
    const open = typeof force === 'boolean' ? force : elements.onlineSettings.hidden;
    elements.onlineSettings.hidden = !open;
    elements.onlineSettingsToggle?.setAttribute('aria-expanded', open ? 'true' : 'false');
}

/** 最近搜索：找书页的搜索历史 */
function renderOnlineHistory() {
    const box = elements.onlineHistory;
    if (!box) return;
    const list = getSettings().onlineHistory || [];
    box.hidden = !list.length;
    box.replaceChildren();
    if (!list.length) return;
    box.appendChild(createElement('span', 'nr-online-history-label', '最近搜索'));
    for (const item of list.slice(0, 12)) {
        const chip = createElement('button', 'nr-online-history-chip', item.keyword);
        chip.type = 'button';
        chip.title = `再搜一次：${item.keyword}`;
        chip.addEventListener('click', () => {
            if (elements.onlineQuery) elements.onlineQuery.value = item.keyword;
            runOnlineSearch().catch(error => setOnlineStatus(error.message, true));
        });
        box.appendChild(chip);
    }
    const clear = createElement('button', 'nr-link', '清空');
    clear.type = 'button';
    clear.addEventListener('click', () => {
        const settings = getSettings();
        settings.onlineHistory = [];
        saveSettings();
        renderOnlineHistory();
    });
    box.appendChild(clear);
}

/** 记一条搜索历史（去重、最多 30 条） */
function recordOnlineSearch(keyword) {
    const text = String(keyword || '').trim();
    if (!text) return;
    const settings = getSettings();
    const list = (Array.isArray(settings.onlineHistory) ? settings.onlineHistory : [])
        .filter(item => item.keyword !== text);
    list.unshift({ keyword: text, time: Date.now() });
    settings.onlineHistory = list.slice(0, 30);
    saveSettings();
    renderOnlineHistory();
}

function renderOnlinePanel() {
    renderOnlineSettings();
    renderOnlineHistory();
    renderOnlineResults();
    renderOnlineBook();
    setOnlineBusy(state.online.searching || state.online.loadingBook);
}

/** 「每页 N 条」下拉框：设置里存了个不在选项里的条数时，补一个选项，别让下拉框显示空白 */
function syncOnlinePageSizeSelect(size) {
    if (!elements.onlinePageSize) return;
    const value = String(size);
    const exists = [...elements.onlinePageSize.options].some(option => option.value === value);
    if (!exists) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = `${size} 条`;
        elements.onlinePageSize.appendChild(option);
    }
    elements.onlinePageSize.value = value;
}

/**
 * 精准搜索：把书名里的装饰去掉再比 ——
 * 「诡秘之主（精校版）」和「诡秘之主」算同一个书名，「诡秘之主的同人」不算。
 */
function normalizeExactTitle(text) {
    return String(text ?? '')
        .replace(/[（(【\[〔《<][^）)】\]〕》>]*[）)】\]〕》>]/g, '')
        .replace(/[\s\u3000]+/g, '')
        .replace(/[·・~～\-—_=+:：;；,，.。!！?？'"“”‘’`^&*#@/\\|]/g, '')
        .toLowerCase();
}

/**
 * 按「精准搜索」过滤搜索结果。
 * 先要求书名完全一致；一条都没有时才放宽成「书名以关键词开头」，并说明放宽了。
 * @returns {{list:object[], dropped:number, relaxed:boolean}}
 */
function filterExactResults(list, keyword) {
    const all = Array.isArray(list) ? list : [];
    // 精准搜索只服务书源：番茄的结果是下载器按书名给的，不做这层筛选
    if (getOnlineSettings().searchEngine !== 'source') return { list: all, dropped: 0, relaxed: false };
    if (!getOnlineSettings().exactMatch) return { list: all, dropped: 0, relaxed: false };
    const wanted = normalizeExactTitle(keyword);
    if (!wanted) return { list: all, dropped: 0, relaxed: false };
    const exact = all.filter(item => normalizeExactTitle(item?.title) === wanted);
    if (exact.length) return { list: exact, dropped: all.length - exact.length, relaxed: false };
    const prefix = all.filter(item => normalizeExactTitle(item?.title).startsWith(wanted));
    if (prefix.length) return { list: prefix, dropped: all.length - prefix.length, relaxed: true };
    return { list: [], dropped: all.length, relaxed: false };
}

/** 过滤结果的一句话说明，挂在状态栏后面 */
function exactMatchNote(info) {
    if (!info || getOnlineSettings().searchEngine !== 'source' || !getOnlineSettings().exactMatch) return '';
    if (info.relaxed) return `（没有书名完全一致的，已放宽为「书名以关键词开头」，过滤掉 ${info.dropped} 条）`;
    return info.dropped > 0 ? `（精准匹配，过滤掉 ${info.dropped} 条名称不符的）` : '（精准匹配）';
}

/**
 * 书源搜索的最终文案。
 *
 * 「找到 337 本书」说的是**同一本书合并之后**有几本，屏幕上的行数是**精准匹配之后**剩下的 ——
 * 两个数直接摞进一句话，就成了「找到 337 本」却只看到一张卡片。
 * 这里把「合并后多少本 / 过滤后显示多少本 / 过滤掉多少条」拆开讲清楚，
 * 并说明想看到全部该怎么做（取消勾选「精准搜索」）。
 * @param {string} report describeSourceReport 拼出的主干文案
 * @param {{list:object[], dropped:number, relaxed:boolean}} info 精准匹配结果
 * @param {number} total 合并后的本数
 * @returns {string} 状态栏文案
 */
function sourceResultText(report, info, total) {
    if (!getOnlineSettings().exactMatch) return report;
    if (info.relaxed) {
        return `${report} · 没有书名完全一致的，放宽为「书名以关键词开头」后显示 ${info.list.length} / ${total} 本`;
    }
    if (!info.list.length) {
        return `${report} · 精准匹配后一本都不剩（${total} 本书名都不符）：去掉「精准搜索」勾选框就能看到它们`;
    }
    const dropped = info.dropped ? `（过滤掉 ${info.dropped} 条名称不符的）` : '';
    return `${report} · 精准匹配后显示 ${info.list.length} / ${total} 本${dropped}`;
}

/**
 * 书源搜索的失败清单里凡是「桥接」相关的，都要把话说清楚 —— 别让人以为是书源本身坏了：
 * 桥接没就绪 → 去装；桥接在、替我们去连站点时连不上 → 是站点的问题，换源更实际。
 * @param {Array<{name:string,error:string}>} perSource 每个书源的成败
 * @returns {string} 要追加在状态栏后面的一句话
 */
function sourceBridgeNote(perSource) {
    if (getOnlineSettings().searchEngine !== 'source') return '';
    const list = (Array.isArray(perSource) ? perSource : []).filter(item => /桥接/.test(String(item.error || '')));
    if (!list.length) return '';
    if (state.online.bridge?.state === 'ready') {
        // 桥接在、还报「桥接抓取失败」：那是桥接替我们去连站点时连不上（站点换了域名 / 挂了 / 被墙），
        // 不是没装，别让人白折腾安装命令
        return ` · 其中 ${list.length} 个失败是${bridgeLabel()}去抓页面时连不上站点（站点挂了或换了域名），不是没装`;
    }
    return ` · 其中 ${list.length} 个书源用到了桥接（POST / 自定义请求头 / Cookie），没装就抓不了；`
        + '纯 GET 的书源照常能搜能下，只是慢（装桥接的命令在上方）';
}

/** 保存原始搜索结果，再按「精准搜索」算出要显示的列表 */
function setOnlineResultsRaw(list, { append = false } = {}) {
    const raw = Array.isArray(list) ? list : [];
    state.online.rawResults = append ? [...(state.online.rawResults || []), ...raw] : raw;
    return syncOnlineResultsView();
}

/** 勾选框变化时重新过滤一遍，不用重新搜索 */
function syncOnlineResultsView() {
    const info = filterExactResults(state.online.rawResults || state.online.results || [], state.online.query);
    state.online.results = info.list;
    state.online.exactInfo = info;
    return info;
}

/** 每页条数：跟设置同步，非法值按 5 处理 */
function getOnlinePageSize() {
    const size = Math.round(Number(getOnlineSettings().pageSize) || 5);
    return Math.min(50, Math.max(1, size));
}

function getOnlinePageCount() {
    return Math.max(1, Math.ceil(state.online.results.length / getOnlinePageSize()));
}

function clampOnlinePage() {
    state.online.page = Math.min(getOnlinePageCount(), Math.max(1, Number(state.online.page) || 1));
    return state.online.page;
}

/** 页码列表：页数多时用「…」折叠，只留首尾和当前页附近 */
function onlinePageNumbers(current, total) {
    if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);
    const picked = new Set([1, total, current, current - 1, current + 1, current - 2, current + 2]);
    const sorted = [...picked].filter(page => page >= 1 && page <= total).sort((a, b) => a - b);
    const result = [];
    let previous = 0;
    for (const page of sorted) {
        if (previous && page - previous > 1) result.push('…');
        result.push(page);
        previous = page;
    }
    return result;
}

function renderOnlinePager() {
    if (!elements.onlinePager) return;
    const total = state.online.results.length;
    const pageCount = getOnlinePageCount();
    const page = clampOnlinePage();
    elements.onlinePager.replaceChildren();
    if (!total || pageCount <= 1) {
        elements.onlinePager.hidden = true;
        return;
    }
    elements.onlinePager.hidden = false;

    const makeButton = (label, target, { disabled = false, active = false } = {}) => {
        const button = createElement('button', 'nr-page-btn');
        button.type = 'button';
        button.textContent = label;
        button.disabled = disabled;
        if (active) button.classList.add('is-active');
        if (target) button.dataset.page = String(target);
        return button;
    };

    elements.onlinePager.appendChild(makeButton('上一页', page - 1, { disabled: page <= 1 }));
    for (const item of onlinePageNumbers(page, pageCount)) {
        if (item === '…') {
            elements.onlinePager.appendChild(createElement('span', 'nr-page-gap', '…'));
            continue;
        }
        elements.onlinePager.appendChild(makeButton(String(item), item, { active: item === page }));
    }
    elements.onlinePager.appendChild(makeButton('下一页', page + 1, { disabled: page >= pageCount }));
}

function renderOnlineResults() {
    if (!elements.onlineResults) return;
    state.online.pageSize = getOnlinePageSize();
    syncOnlinePageSizeSelect(state.online.pageSize);
    elements.onlineResults.replaceChildren();

    const total = state.online.results.length;
    const page = clampOnlinePage();
    const pageCount = getOnlinePageCount();
    if (elements.onlineResultsHead) elements.onlineResultsHead.hidden = total === 0;
    if (elements.onlineResultsCount) {
        // 卡片是按「书名 + 作者」合并过的：显示「几本书」，原始条数单独标出来。
        // 开了精准搜索时再补一句「从几本里筛出来的」—— 否则会出现
        // 「共 1 本书（原始 567 条）」这种看着像丢了结果的抬头。
        const merged = (state.online.rawResults || []).length;
        const raw = Math.max(Number(state.online.rawCount) || 0, merged);
        const exactOn = getOnlineSettings().exactMatch;
        const rawNote = exactOn && merged > total
            ? `（精准匹配自 ${merged} 本，原始 ${raw} 条）`
            : raw > total ? `（原始 ${raw} 条）` : '';
        elements.onlineResultsCount.textContent = total
            ? `共 ${total} 本书${rawNote} · 第 ${page} / ${pageCount} 页`
            : '';
    }
    if (!total) {
        if (!state.online.query) {
            const empty = createElement('div', 'nr-online-empty');
            empty.innerHTML = '<i class="fa-solid fa-globe"></i><p>输入书名搜一下，或者直接在下面粘书籍页链接</p>';
            elements.onlineResults.appendChild(empty);
        }
        renderOnlinePager();
        return;
    }

    const start = (page - 1) * state.online.pageSize;
    const slice = state.online.results.slice(start, start + state.online.pageSize);
    const fragment = document.createDocumentFragment();
    slice.forEach((item, offset) => {
        const card = createElement('button', 'nr-online-result');
        card.type = 'button';
        card.dataset.url = item.url;
        const layout = createElement('div', 'nr-online-result-layout');
        if (item.cover) {
            const image = document.createElement('img');
            image.className = 'nr-online-result-cover';
            image.src = item.cover;
            image.alt = '';
            image.loading = 'lazy';
            image.referrerPolicy = 'no-referrer';
            image.addEventListener('error', () => image.remove());
            layout.appendChild(image);
        }
        const main = createElement('div', 'nr-online-result-main');
        const head = createElement('div', 'nr-online-result-head');
        head.appendChild(createElement('span', 'nr-online-result-index', String(start + offset + 1)));
        head.appendChild(createElement('strong', null, item.title));
        head.appendChild(createElement('span', 'nr-badge', item.site || '网页'));
        main.appendChild(head);
        if (item.kind) head.appendChild(createElement('span', 'nr-badge nr-badge-soft', item.kind));
        const metaText = [
            item.author ? `作者：${item.author}` : '',
            !item.kind && item.kindText ? item.kindText : '',
            item.latestChapterTitle ? `最新：${item.latestChapterTitle}` : '',
        ].filter(Boolean).join(' · ');
        if (metaText) main.appendChild(createElement('div', 'nr-online-result-meta', metaText));
        if (Array.isArray(item.sources) && item.sources.length > 1) {
            const chips = createElement('div', 'nr-online-result-sources');
            chips.appendChild(createElement('span', 'nr-muted', `${item.sources.length} 个来源：`));
            for (const source of item.sources.slice(0, 6)) {
                const chip = createElement('span', 'nr-source-chip', source.sourceName || source.site || '书源');
                chip.dataset.url = source.url;
                chip.title = source.url;
                chips.appendChild(chip);
            }
            if (item.sources.length > 6) {
                chips.appendChild(createElement('span', 'nr-muted', `+${item.sources.length - 6}`));
            }
            main.appendChild(chips);
        }
        if (item.snippet) main.appendChild(createElement('p', 'nr-online-result-desc', item.snippet));
        main.appendChild(createElement('span', 'nr-online-result-url', item.url));
        layout.appendChild(main);
        card.appendChild(layout);
        fragment.appendChild(card);
    });
    elements.onlineResults.appendChild(fragment);
    renderOnlinePager();
}

function gotoOnlinePage(page) {
    state.online.page = Math.min(getOnlinePageCount(), Math.max(1, Number(page) || 1));
    renderOnlineResults();
    elements.onlineResultsHead?.scrollIntoView({ block: 'nearest' });
}

function setOnlinePageSize(size) {
    const settings = getSettings();
    settings.online = normalizeOnlineSettings({ ...settings.online, pageSize: size });
    saveSettings();
    state.online.fetcher?.update(settings.online);
    state.online.page = 1;
    renderOnlineResults();
}

function bookFromReading() {
    const reading = state.online.reading;
    if (!reading) return null;
    return {
        title: reading.title,
        author: reading.author,
        url: reading.url,
        intro: reading.intro,
        sourceId: reading.sourceId || '',
        sourceName: reading.sourceName || '',
        chapters: state.chapters.map(chapter => ({ title: chapter.title, url: chapter.url })),
    };
}

function renderOnlineBook() {
    if (!elements.onlineBook) return;
    const book = state.online.book;
    if (!book) {
        elements.onlineBook.hidden = true;
        elements.onlineBook.replaceChildren();
        return;
    }
    elements.onlineBook.hidden = false;
    elements.onlineBook.replaceChildren();

    if (isFanqieBook(book)) {
        renderFanqieBookCard(book);
        return;
    }

    const head = createElement('div', 'nr-online-book-head');
    const titleBox = createElement('div', 'nr-online-book-title');
    titleBox.appendChild(createElement('strong', null, book.title || '未命名小说'));
    const meta = createElement('div', 'nr-muted');
    meta.textContent = [
        book.author ? `作者：${book.author}` : '作者未知',
        `${book.chapters.length} 章`,
        book.url,
    ].filter(Boolean).join(' · ');
    titleBox.appendChild(meta);
    head.appendChild(titleBox);

    const actions = createElement('div', 'nr-online-book-actions');
    if (book.sourceId) {
        // 和阅读一样：找书结果先「加入书架」，之后都在书架里读（换源也只在书架书上有意义）
        const shelfButton = createElement('button', 'nr-btn nr-btn-sm nr-primary', '加入书架');
        shelfButton.type = 'button';
        shelfButton.dataset.act = 'shelf';
        shelfButton.title = '只存目录和书源信息，正文读到哪抓到哪；加入后直接在阅读页读，可随时换源';
        actions.appendChild(shelfButton);
    }
    const downloadButton = createElement('button', 'nr-btn nr-btn-sm', '下载到书架');
    downloadButton.type = 'button';
    downloadButton.dataset.act = 'download';
    downloadButton.disabled = state.online.download.running;
    const exportButton = createElement('button', 'nr-btn nr-btn-sm', '导出 TXT');
    exportButton.type = 'button';
    exportButton.dataset.act = 'export';
    exportButton.disabled = state.online.download.running;
    const closeButton = createElement('button', 'nr-btn nr-btn-sm', '关闭');
    closeButton.type = 'button';
    closeButton.dataset.act = 'close';
    actions.append(downloadButton, exportButton, closeButton);
    head.appendChild(actions);
    elements.onlineBook.appendChild(head);

    if (book.intro) {
        const intro = createElement('p', 'nr-online-book-intro', book.intro.slice(0, 400));
        elements.onlineBook.appendChild(intro);
    }

    if (state.online.download.running) {
        const progress = createElement('div', 'nr-online-progress');
        const bar = createElement('div', 'nr-online-progress-bar');
        const fill = createElement('i', 'nr-online-progress-fill');
        bar.appendChild(fill);
        const label = createElement('span', 'nr-online-progress-text', '准备抓取…');
        const stopButton = createElement('button', 'nr-btn nr-btn-sm nr-danger', '停止下载');
        stopButton.type = 'button';
        stopButton.dataset.act = 'stop';
        stopButton.title = '停下并保留已经抓到的章节';
        progress.append(bar, label, stopButton);
        elements.onlineBook.appendChild(progress);
    }

    // 目录不再铺在卡片里：解析完只留一个「N 章」的总数，正文和章节去阅读页看
}

let downloadUiTimer = 0;
let downloadLastPaint = 0;

/** 把「现在到底走哪条通道」说清楚：慢的时候一眼能看出是不是桥接没加载 */
function describeFetchChannel(client) {
    if (!client) return '';
    if (client.bridgeAvailable === false) return '酒馆网页通道（没装 / 没加载桥接时只能这样：只能 GET、慢很多，装桥接会快很多）';
    switch (client.lastVia) {
        case 'bridge': return '桥接';
        case 'tavern': return '酒馆网页通道（只能 GET，偏慢）';
        case 'proxy': return '代理';
        case 'direct': return '浏览器直连';
        default: return '';
    }
}

/** 下载进度：带速度 / 预计剩余；高频调用时按 250ms 节流，避免每章都刷 DOM */
function updateOnlineDownloadProgress({ force = false } = {}) {
    const { running, done, total, label } = state.online.download;
    const conc = state.online.download.concurrency || 0;
    const failed = Array.isArray(state.online.download.failed) ? state.online.download.failed.length : 0;
    const tail = failed ? `，失败 ${failed} 章` : '';
    const started = state.online.download.startedAt || 0;
    const elapsedSec = started ? Math.max(0.5, (Date.now() - started) / 1000) : 0;
    const rate = elapsedSec && done ? done / elapsedSec : 0;
    const speed = running && rate
        ? ` · ${rate.toFixed(2)} 章/秒`
        : '';
    const eta = running && rate && total > done
        ? ` · 约剩 ${Math.max(1, Math.round((total - done) / rate))} 秒`
        : '';
    const batchHint = state.online.runtime?.client?.batchUnavailable ? ' · 桥接旧，逐章抓（更新桥接能快很多）' : '';
    const channel = describeFetchChannel(state.online.runtime?.client);
    const channelHint = channel ? ` · 走${channel}` : '';
    const message = label || (running
        ? `正在抓取 ${done} / ${total} 章…${conc ? `（并发 ${conc}）` : ''}${speed}${eta}${tail}${channelHint}${batchHint}`
        : `抓取完成 ${done} / ${total} 章${tail}`);

    const paint = () => {
        downloadLastPaint = Date.now();
        if (elements.onlineBook) {
            const fill = elements.onlineBook.querySelector('.nr-online-progress-fill');
            const text = elements.onlineBook.querySelector('.nr-online-progress-text');
            if (fill && total) fill.style.width = `${Math.round((done / total) * 100)}%`;
            if (text) text.textContent = message;
        }
        setHeaderStatus(message);
        if (running) setOnlineStatus(message);
    };

    if (force) {
        if (downloadUiTimer) {
            clearTimeout(downloadUiTimer);
            downloadUiTimer = 0;
        }
        paint();
        return;
    }
    if (downloadUiTimer) return;
    const wait = Math.max(0, 250 - (Date.now() - downloadLastPaint));
    downloadUiTimer = setTimeout(() => {
        downloadUiTimer = 0;
        paint();
    }, wait);
}

/** 当前通道是不是番茄（本地下载器） */
function isFanqieEngine() {
    return getOnlineSettings().searchEngine === 'fanqie';
}

/** 切到番茄通道时先在后台把下载器拉起来（失败只提示，不挡操作） */
function warmFanqieDownloader() {
    if (!isFanqieEngine()) return;
    const client = getFetcher().fanqie();
    setOnlineStatus('正在检查番茄下载器…');
    client.ensureReady()
        .then(payload => {
            const version = payload?.downloader?.version;
            setOnlineStatus(version ? `番茄下载器已就绪（${version}）` : '番茄下载器已就绪');
        })
        .catch(error => setOnlineStatus(error.message, true));
}

/** 当前通道是不是书源 */
function isSourceEngine() {
    return getOnlineSettings().searchEngine === 'source';
}

/**
 * 切离番茄通道时，把「正在检查番茄下载器 / 番茄下载器已就绪」这类状态行一起清掉 ——
 * 那条状态是番茄这一路专属的，切回书源之后还挂在下面，看着像提示没消失。
 * 搜索/下载进行中不清，免得把正在跑的进度文案抹掉。
 */
function clearFanqieStatus() {
    if (state.online.searching || state.online.loadingBook) return;
    const text = String(elements.onlineStatus?.textContent || '').trim();
    if (text && /番茄/.test(text)) setOnlineStatus('');
}

/** 书源聚合搜索的结果文案：成功几个、失败哪几个 */
function describeSourceReport(perSource, bookCount, rawCount = 0) {
    const list = Array.isArray(perSource) ? perSource : [];
    const failed = list.filter(item => item.error && item.error !== '已停止');
    const stopped = list.filter(item => item.error === '已停止');
    const ok = list.filter(item => !item.error);
    if (!bookCount && !ok.length) {
        if (!failed.length) return '这些书源都没搜到结果：换个关键词，或检查书源的搜索规则';
        return `所有书源都没搜到：${failed.slice(0, 3).map(item => `${item.name}（${item.error}）`).join('；')}`;
    }
    // 卡片是按「书名 + 作者」合并过的，说「几本书」才对得上屏幕上的行数；
    // 原始条数单独说明，免得出现「已找到 572 条」却只看到一行的困惑
    const mergeNote = rawCount > bookCount ? `（原始 ${rawCount} 条，同一本书的多条结果已合并）` : '';
    const parts = [`用 ${list.length} 个书源找到 ${bookCount} 本书${mergeNote}`];
    if (failed.length) {
        parts.push(`${failed.length} 个失败：${failed.slice(0, 2).map(item => `${item.name}（${item.error}）`).join('；')}`);
    }
    if (stopped.length) parts.push('其余书源已停止');
    return parts.join(' · ');
}

/** 规则引擎返回的书籍 → 搜索结果卡片 */
function ruleBookToResult(book) {
    const snippet = [
        book.author ? `作者：${book.author}` : '',
        book.kind || '',
        book.latestChapterTitle ? `最新：${book.latestChapterTitle}` : '',
    ].filter(Boolean).join(' · ');
    return {
        title: book.name || '未命名',
        url: book.bookUrl,
        site: book.originName || book.sourceName || '',
        author: book.author || '',
        kind: book.kind || '',
        latestChapterTitle: book.latestChapterTitle || '',
        cover: book.coverUrl || '',
        snippet,
        sourceId: book.sourceId || book.origin || '',
        sourceName: book.sourceName || book.originName || '',
        sourceOrder: Number(book.sourceOrder) || 0,
        book,
    };
}

async function runOnlineSearch() {
    // 从别处触发搜索时先切到找书页，否则用户看不到进度和「停止」
    if (state.tab !== 'online') showTab('online');
    if (state.online.searching || state.online.loadingBook) return;
    const keyword = (elements.onlineQuery?.value || '').trim();
    if (!keyword) {
        elements.onlineQuery?.focus();
        setOnlineStatus('先输入书名或作者', true);
        return;
    }
    commitOnlineSettings();
    recordOnlineSearch(keyword);
    const settings = getSettings();
    settings.onlineQuery = keyword;
    saveSettings();

    const fetcher = getFetcher();
    const abort = new AbortController();
    state.online.abort = abort;
    state.online.searching = true;
    state.online.query = keyword;
    state.online.results = [];
    state.online.rawResults = [];
    state.online.rawCount = 0;
    state.online.exactInfo = { dropped: 0, relaxed: false };
    state.online.page = 1;
    state.online.book = null;
    setOnlineBusy(true);
    syncOnlineStopButton();
    const sourceMode = isSourceEngine();
    state.online.sourceReport = null;
    setOnlineStatus(sourceMode
        ? `正在用 ${enabledSources().length} 个书源搜索…`
        : `正在向${FANQIE_SITE}下载器搜索…`);
    renderOnlineResults();
    renderOnlineBook();
    try {
        if (sourceMode) {
            // 流式：哪个书源先回来就先显示它搜到的书，不用等最慢的那个
            const runtime = getRuntime();
            const collected = [];
            const { books, perSource } = await runtime.searchAll(keyword, {
                signal: abort.signal,
                concurrency: getOnlineSettings().concurrency,
                onProgress: ({ finished, total }) => {
                    if (abort.signal.aborted) return;
                    const mergedCount = (state.online.rawResults || []).length;
                    const rawNote = collected.length > mergedCount ? `（原始 ${collected.length} 条已合并）` : '';
                    const exactNote = getOnlineSettings().exactMatch ? '，精准搜索只显示书名一致的' : '';
                    setOnlineStatus(`正在用 ${total} 个书源搜索…（${finished} / ${total} 完成，已合并 ${mergedCount} 本${rawNote}${exactNote}）`);
                },
                onSourceDone: ({ source, items }) => {
                    if (abort.signal.aborted || !items.length) return;
                    collected.push(...items);
                    state.online.rawCount = collected.length;
                    setOnlineResultsRaw(mergeSourceResults(collected.map(ruleBookToResult), getOnlineSettings().sourceSort));
                    state.online.page = 1;
                    renderOnlineResults();
                    if (source?.error) setOnlineStatus(`「${source.name}」没搜到：${source.error}`, true);
                },
            });
            state.online.sourceReport = perSource;
            // 用户点了停止：别再用「没搜到结果」盖掉「已停止搜索」
            if (abort.signal.aborted) return;
            const merged = mergeSourceResults(books.map(ruleBookToResult), getOnlineSettings().sourceSort);
            state.online.rawCount = books.length;
            const info = setOnlineResultsRaw(merged);
            const report = describeSourceReport(perSource, merged.length, books.length);
            setOnlineStatus(sourceResultText(report, info, merged.length) + sourceBridgeNote(perSource),
                !books.length || (!info.list.length && merged.length > 0));
        } else {
            const results = await fetcher.searchBooks(keyword, { signal: abort.signal });
            if (abort.signal.aborted) return;
            state.online.rawCount = results.length;
            const info = setOnlineResultsRaw(results);
            const pageSize = getOnlinePageSize();
            if (results.length && !info.list.length) {
                setOnlineStatus(`精准搜索没找到书名一致的：去掉「精准搜索」勾选框再搜一次`, true);
            } else if (!results.length) {
                setOnlineStatus('番茄那边没搜到：换个关键词；一直是空的就检查下载器与桥接插件是否在跑', true);
            } else if (info.list.length > pageSize) {
                setOnlineStatus(
                    `找到 ${info.list.length} 个结果${exactMatchNote(info)}，每页 ${pageSize} 条 · 点一个打开`,
                );
            } else {
                setOnlineStatus(`找到 ${info.list.length} 个结果${exactMatchNote(info)}`);
            }
        }
    } catch (error) {
        if (isAbortError(error)) {
            setOnlineStatus('已停止搜索');
        } else {
            // 报错里提到桥接（POST 要桥接 / 桥接抓取失败…）就把安装块摆出来，别让人只看到一句 fetch failed
            if (/桥接/.test(String(error?.message || ''))) revealBridgeBlock();
            setOnlineStatus(error.message, true);
        }
    } finally {
        state.online.searching = false;
        state.online.abort = null;
        setOnlineBusy(false);
        renderOnlineResults();
        if (state.online.pendingBookNotice) {
            const notice = state.online.pendingBookNotice;
            state.online.pendingBookNotice = '';
            setOnlineStatus(notice);
        }
    }
}

async function openOnlineBookUrl(url) {
    const target = String(url || '').trim();
    if (!target) {
        setOnlineStatus('先粘一个书籍页 / 章节页链接', true);
        return;
    }
    if (state.online.loadingBook) return;
    // 搜索还在跑时点结果：解析这本书，同时让剩余书源继续搜（互不干扰）
    const searching = state.online.searching;
    if (searching) setOnlineStatus('正在解析这本书…（其余书源继续搜索）');
    const fetcher = getFetcher();
    const abort = new AbortController();
    state.online.bookAbort = abort;
    state.online.loadingBook = true;
    setOnlineBusy(true);
    setOnlineStatus('正在打开页面…');
    try {
        const runtime = getRuntime();
        const ruleSource = runtime.findSource(target);
        let book;
        if (ruleSource) {
            book = await runtime.openBook(target, {
                signal: abort.signal,
                onProgress: message => setOnlineStatus(message),
            });
        } else {
            book = await fetcher.openBook(target, {
                signal: abort.signal,
                onProgress: message => setOnlineStatus(message),
            });
        }
        if (!book.chapters.length && !book.downloadOnly) {
            throw new Error('这个页面没找到章节列表：可能不是书籍页，或者站点换了版式');
        }
        state.online.book = book;
        if (elements.onlineUrl) elements.onlineUrl.value = book.url;
        const openedText = isFanqieBook(book)
            ? `《${book.title}》· ${FANQIE_SITE} ${book.chapterCount} 章 · 点「下载并导入书架」整本取回后就能读`
            : book.sourceId
                ? `《${book.title}》· ${book.chapters.length} 章 · 点「加入书架」就能读（正文边读边抓），也可以「下载到书架」离线读`
                : `《${book.title}》· ${book.chapters.length} 章 · 这个链接没匹配到书源：点「下载到书架」抓全后就能读`;
        // 目录规则没命中、靠页面结构猜出来的：说清楚，免得以为是规则跑通了
        if (book.tocGuessed) {
            const order = book.tocReordered ? '（页面是倒序 / 页首「最新章节」和目录重复，已按章节序号重排）' : '';
            toast(`这个站点的目录规则没命中，已按页面结构推断出 ${book.chapters.length} 章${order}；如果章节顺序不对，去书源管理改「目录列表」规则`, 'warning');
        }
        // 搜索仍在继续时，状态栏继续报告搜索进度，别把「还在搜」的提示冲掉
        if (state.online.searching) {
            state.online.pendingBookNotice = openedText;
        } else {
            setOnlineStatus(openedText);
        }
        renderOnlineBook();
    } catch (error) {
        if (isAbortError(error)) setOnlineStatus('已停止');
        else {
            setOnlineStatus(error.message, true);
            toast(error.message, 'error');
        }
    } finally {
        state.online.loadingBook = false;
        if (state.online.bookAbort === abort) state.online.bookAbort = null;
        // 搜索还在跑时不要把搜索按钮解锁，否则会并发出第二次搜索
        setOnlineBusy(state.online.searching);
    }
}

/** 在线阅读：把网络书装进阅读器，正文在翻到那一章时才抓 */
async function openOnlineBookInReader(book) {
    if (!book?.chapters?.length) {
        toast('这本书还没解析到章节', 'warning');
        return;
    }
    if (state.online.download.running) {
        toast('正在抓取，等抓完再切换', 'warning');
        return;
    }
    if (memoEditorHasUnsavedChanges()) {
        const ok = await confirmAction('当前备忘还有未保存的修改，切换小说会丢失。要继续吗？');
        if (!ok) return;
    }
    if (state.worldbook.running) stopWorldbook();
    if (state.summary.running) stopSummary();

    const id = `online:${bookIdFromUrl(book.url)}`;
    const now = Date.now();
    state.online.reading = {
        id,
        title: book.title || '在线小说',
        author: book.author || '',
        url: book.url,
        intro: book.intro || '',
        sourceId: book.sourceId || '',
        sourceName: book.sourceName || book.originName || '',
    };
    state.novel = {
        id,
        title: state.online.reading.title,
        author: state.online.reading.author,
        format: '在线',
        encoding: 'utf-8',
        charCount: 0,
        chapterCount: book.chapters.length,
        sourceName: book.sourceName || book.originName || book.url,
        sourceUrl: book.url,
        online: true,
        createdAt: now,
        updatedAt: now,
    };
    state.novelId = id;
    state.chapters = book.chapters.map((chapter, index) => ({
        index,
        title: chapter.title || `第 ${index + 1} 章`,
        url: chapter.url,
        isVolume: Boolean(chapter.isVolume),
        sourceId: book.sourceId || '',
        charCount: 0,
    }));
    state.chapterCache.clear();
    clearNovelSearch({ render: false, keepFocus: true });
    state.reader = { index: 0, page: 0, pages: [''], images: [], loaded: false };
    state.styleSample = { novelId: null, chars: 0, text: '' };
    state.cardGreetings = { novelId: null, start: '', end: '' };
    state.selection = new Set(state.chapters.map(chapter => chapter.index));
    state.selectionAnchor = null;
    state.wbSelection = new Set(state.chapters.map(chapter => chapter.index));
    state.wbSelectionAnchor = null;
    state.worldbook.loadedNovelId = null;
    state.worldbook.result = null;
    state.worldbook.editingIndex = null;
    state.worldbook.expanded = new Set();
    resetMemoState();

    renderReaderSelect();
    renderSummarySelect();
    renderWorldbookSelect();
    renderMemoSelect();
    renderStyleSelect();
    renderChapterList();
    renderSummaryChapters();
    renderWorldbookChapters();
    syncOnlineReaderUi();
    updateHeader();
    // 先抓第一章，再切标签：showTab 看到 reader.loaded 为 true 就不会重复抓
    await openChapter(0, 0, { silent: true });
    showTab('reader');
    toast(`正在在线阅读《${state.novel.title}》，正文会边读边抓`, 'info');
}

/** 抓一章：有书源就走规则引擎，否则走通用抓取 */
async function fetchOnlineChapter(chapter, { signal = null, sourceId = '', timeoutMs = 0, prefetched = null } = {}) {
    const id = sourceId || chapter?.sourceId || state.online.reading?.sourceId || '';
    if (id) {
        const runtime = getRuntime();
        return await runtime.fetchChapter({
            ...chapter,
            bookUrl: state.online.reading?.url || chapter?.bookUrl || '',
        }, { signal, sourceId: id, timeoutMs, prefetched });
    }
    return await getFetcher().fetchChapter(chapter.url, { signal });
}

/** 在线阅读时，openChapter 走这里：抓当前章并缓存 */
async function loadChapterText(index) {
    if (!state.online.reading) {
        const cached = await getChapterContent(state.novelId, index);
        const cachedImages = await getChapterImages(state.novelId, index);
        if (cached || cachedImages.length) return { text: cached, images: cachedImages };
        const chapter = state.chapters[index];
        const sourceId = state.novel?.sourceId;
        if (!sourceId || !chapter?.url) return { text: cached, images: cachedImages };
        // 书源书：本地没有正文，按章节地址现抓并写回缓存
        setHeaderStatus(`正在抓取第 ${index + 1} 章…`);
        if (elements.articleMeta) elements.articleMeta.textContent = `正在抓取第 ${index + 1} 章正文…`;
        try {
            const parsed = await getRuntime().fetchChapter({
                title: chapter.title,
                url: chapter.url,
                bookUrl: state.novel.bookUrl || state.novel.sourceUrl || '',
            }, { sourceId });
            const text = String(parsed.text || '');
            const images = Array.isArray(parsed.images) ? parsed.images : [];
            if (text || images.length) await saveChapterContent(state.novelId, index, text, images);
            chapter.cached = Boolean(text || images.length);
            chapter.charCount = countChars(text);
            if (parsed.title && (!chapter.title || /^第\s*\d+\s*章$/.test(chapter.title))) {
                chapter.title = parsed.title;
                renderChapterList();
            }
            return { text, images };
        } catch (error) {
            throw new Error(`第 ${index + 1} 章抓取失败：${error.message}`);
        } finally {
            updateHeader();
        }
    }
    const chapter = state.chapters[index];
    if (!chapter?.url) return { text: '', images: [] };
    setHeaderStatus(`正在抓取第 ${index + 1} 章…`);
    if (elements.articleMeta) elements.articleMeta.textContent = `正在抓取第 ${index + 1} 章正文…`;
    try {
        const parsed = await fetchOnlineChapter(chapter);
        chapter.charCount = countChars(parsed.text);
        if (parsed.title && (!chapter.title || /^第\s*\d+\s*章$/.test(chapter.title))) {
            chapter.title = parsed.title;
            renderChapterList();
        }
        return { text: parsed.text, images: Array.isArray(parsed.images) ? parsed.images : [] };
    } catch (error) {
        throw new Error(`第 ${index + 1} 章抓取失败：${error.message}`);
    } finally {
        updateHeader();
    }
}

/** 按并发抓一批章节；进度写进 state.online.download */
async function grabOnlineChapters(book, { signal, useCache = false } = {}) {
    const settings = getOnlineSettings();
    const limit = settings.downloadLimit > 0
        ? Math.min(settings.downloadLimit, book.chapters.length)
        : book.chapters.length;
    const targets = book.chapters.slice(0, limit);
    const contents = new Array(targets.length).fill(null);
    const failed = [];
    let done = 0;

    const concurrency = Math.max(1, Math.min(16, Number(settings.concurrency) || 4));
    const chapterTimeout = Math.max(5000, Number(settings.chapterTimeoutMs) || 20000);
    // 一组 6 个 URL；同时开 concurrency 组 → 在途请求约 concurrency×6
    const groupSize = 6;
    const parallelGroups = concurrency;
    state.online.download.done = 0;
    state.online.download.total = targets.length;
    state.online.download.concurrency = concurrency * groupSize;
    state.online.download.startedAt = Date.now();
    state.online.download.failed = failed;
    updateOnlineDownloadProgress({ force: true });

    const runtime = getRuntime();
    // 抓之前先探一下通道：桥接没加载就只能一页一页走酒馆通道，慢十倍以上
    let ping = { ok: true };
    try {
        ping = await runtime.bridgePing();
    } catch {
        ping = { ok: true };
    }
    if (!ping.ok) {
        const why = ping.status ? `HTTP ${ping.status}` : (ping.error || '连不上');
        const guessDir = EXT_REL_PATH.startsWith('public/') ? EXT_REL_PATH : `public/${EXT_REL_PATH}`;
        const installHint = bridgeCommandOf('install', guessDir);
        setOnlineStatus(`没连上抓取桥接（${why}）：照样能下，只是走酒馆网页通道一章一页、会明显更慢；`
            + `装桥接后能批量抓（酒馆根目录执行 ${installHint} 再重启酒馆）`, true);
    }
    const sourceId = book.sourceId || '';
    const source = sourceId ? runtime.findSourceById(sourceId) : null;
    const canBatch = Boolean(source) && !String(source?.ruleContent?.nextContentUrl || '').trim();

    // 站点拿错误页冒充正文时，前几章就能看出来：连着 3 章都不是正文就提前收手，别把几百章都跑完
    let stopEarly = false;
    let earlyReason = '';
    let consecutiveBad = 0;
    const looksLikeErrorPage = message => /不是正文|转码失败|请?换源|错误页|错误 JSON|站点返回错误/.test(String(message || ''));

    const markDone = entry => {
        if (entry) {
            if (entry.error) {
                failed.push(entry);
                if (looksLikeErrorPage(entry.error)) {
                    consecutiveBad++;
                    if (consecutiveBad >= 3 && !earlyReason) {
                        stopEarly = true;
                        earlyReason = entry.error;
                    }
                } else {
                    consecutiveBad = 0;
                }
            } else {
                consecutiveBad = 0;
                contents[entry.index] = { title: entry.title, content: entry.content };
            }
        }
        done++;
        state.online.download.done = done;
        updateOnlineDownloadProgress();
    };

    const parseOne = async (index, prefetched = null) => {
        if (signal?.aborted || stopEarly) return;
        const chapter = targets[index];
        const cached = useCache ? state.chapterCache.get(index) : undefined;
        if (typeof cached === 'string' && cached) {
            markDone({ index, title: chapter.title, content: cached });
            return;
        }
        try {
            const parsed = await fetchOnlineChapter(chapter, { signal, sourceId, timeoutMs: chapterTimeout, prefetched });
            markDone({ index, title: chapter.title || parsed.title, content: parsed.text });
        } catch (error) {
            markDone({ index, title: chapter.title, error: signal?.aborted ? '已停止' : error.message });
        }
    };

    const groups = [];
    for (let start = 0; start < targets.length; start += groupSize) {
        groups.push(targets.slice(start, start + groupSize).map((chapter, offset) => ({
            chapter,
            index: start + offset,
        })));
    }

    await mapLimit(groups, parallelGroups, async group => {
        if (signal?.aborted || stopEarly) return;
        let prefetchedList = null;
        if (canBatch) {
            try {
                prefetchedList = await runtime.prefetchChapters(
                    group.map(item => ({ ...item.chapter, index: item.index })),
                    { signal, sourceId, concurrency: group.length },
                );
            } catch (error) {
                if (error?.name === 'AbortError') return;
                prefetchedList = null;
            }
        }
        // 组内并发解析（本地解析不吃网络）；没有批量结果就逐章抓
        await mapLimit(group, Math.min(group.length, concurrency), async (item, position) => {
            if (signal?.aborted || stopEarly) return;
            const prefetched = prefetchedList ? prefetchedList[position] : null;
            if (prefetched && prefetched.error) {
                if (useCache) return parseOne(item.index);
                markDone({ index: item.index, title: item.chapter.title, error: prefetched.error });
                return;
            }
            await parseOne(item.index, prefetched);
        });
        updateOnlineDownloadProgress();
    });

    updateOnlineDownloadProgress({ force: true });
    return { contents, failed, targets, aborted: Boolean(signal?.aborted), earlyReason };
}

/** 章节很多时先问一句：每章一个请求，几百章会等挺久 */
async function confirmLargeGrab(book) {
    const limit = getOnlineSettings().downloadLimit;
    const total = limit > 0 ? Math.min(limit, book.chapters.length) : book.chapters.length;
    if (total <= 200) return true;
    return confirmAction(`按当前设置要抓 ${total} 章，会发 ${total} 个请求，可能要等一会儿。继续吗？`);
}

/* ---- 番茄小说：整本下载 → 切章入库 ---------------------------------- */

/** 番茄书目卡片：只有「下载并导入书架」，没有在线阅读 / 导出 */
function renderFanqieBookCard(book) {
    const head = createElement('div', 'nr-online-book-head');
    const titleBox = createElement('div', 'nr-online-book-title');
    titleBox.appendChild(createElement('strong', null, book.title || FANQIE_SITE));
    const meta = createElement('div', 'nr-muted');
    meta.textContent = fanqieBookSummary(book) || `${FANQIE_SITE} · 没取到书目信息`;
    titleBox.appendChild(meta);
    head.appendChild(titleBox);

    const actions = createElement('div', 'nr-online-book-actions');
    const downloadButton = createElement('button', 'nr-btn nr-btn-sm nr-primary', '下载并导入书架');
    downloadButton.type = 'button';
    downloadButton.dataset.act = 'download';
    downloadButton.disabled = state.online.download.running;
    const closeButton = createElement('button', 'nr-btn nr-btn-sm', '关闭');
    closeButton.type = 'button';
    closeButton.dataset.act = 'close';
    actions.append(downloadButton, closeButton);
    head.appendChild(actions);
    elements.onlineBook.appendChild(head);

    if (book.intro) {
        elements.onlineBook.appendChild(createElement('p', 'nr-online-book-intro', book.intro.slice(0, 400)));
    }

    const tags = Array.isArray(book.meta?.tags) ? book.meta.tags : [];
    if (tags.length) {
        const tagBox = createElement('div', 'nr-online-book-tags');
        for (const tag of tags.slice(0, 10)) tagBox.appendChild(createElement('span', 'nr-badge', tag));
        elements.onlineBook.appendChild(tagBox);
    }

    elements.onlineBook.appendChild(createElement(
        'p',
        'nr-online-book-note',
        `${FANQIE_SITE}只提供整本下载：点「下载并导入书架」后由本地下载器抓全 ${book.chapterCount || ''} 章，`
        + '切好章节存进书架；之后就是普通本地书，能总结、能做世界书。',
    ));

    if (state.online.download.running) {
        const progress = createElement('div', 'nr-online-progress');
        const bar = createElement('div', 'nr-online-progress-bar');
        bar.appendChild(createElement('i', 'nr-online-progress-fill'));
        progress.append(bar, createElement('span', 'nr-online-progress-text', state.online.download.label || '准备下载…'));
        elements.onlineBook.appendChild(progress);
    }
}

/** 从任务列表 / 任务详情里挑出当前任务 */
function pickFanqieJob(payload, jobId) {
    if (!payload) return null;
    const list = Array.isArray(payload)
        ? payload
        : (Array.isArray(payload.items) ? payload.items : [payload]);
    if (!list.length) return null;
    const wanted = String(jobId);
    return list.find(item => String(item?.id) === wanted) || list[0];
}

/** 轮询下载器任务直到结束：done 返回进度摘要，failed 抛错 */
async function pollFanqieJob(client, jobId, { signal, onProgress, intervalMs = 1500 } = {}) {
    const deadline = Date.now() + 6 * 60 * 60 * 1000;
    for (;;) {
        if (signal?.aborted) {
            const error = new Error('已停止');
            error.name = 'AbortError';
            throw error;
        }
        const payload = await client.job(jobId, { signal });
        const item = pickFanqieJob(payload, jobId);
        if (!item) throw new Error('下载器里找不到这个任务了（可能被手动删掉）');
        const summary = summarizeFanqieJob(item);
        onProgress?.(summary);
        if (summary.finished || summary.failed) return summary;
        if (Date.now() > deadline) throw new Error('等太久了：任务还在下载器里跑，先去下载器页看看进度');
        await sleep(intervalMs);
    }
}

/** 把整本 txt 切成章节存进书架 */
async function saveFanqieText(text, book, { openAfter = true } = {}) {
    const parsed = parseFanqieBookText(text);
    const rows = parsed.chapters
        .map(chapter => ({
            title: chapter.title || '未命名章节',
            content: chapter.content,
            charCount: countChars(chapter.content),
        }))
        .filter(row => row.content && row.content.trim());
    if (!rows.length) throw new Error('下载回来的正文是空的');
    const now = Date.now();
    const meta = {
        id: uuid(),
        title: makeUniqueTitle(parsed.title || book.title || FANQIE_SITE),
        author: parsed.author || book.author || '',
        format: 'TXT',
        encoding: 'utf-8',
        charCount: rows.reduce((sum, row) => sum + row.charCount, 0),
        chapterCount: rows.length,
        sourceName: `${FANQIE_SITE} · ${book.bookId || parsed.bookId || ''}`.trim(),
        sourceUrl: book.url || '',
        createdAt: now,
        updatedAt: now,
    };
    await saveNovel(meta, rows);
    await refreshLibrary();
    toast(`已从${FANQIE_SITE}导入《${meta.title}》：${rows.length} 章 / ${formatCount(meta.charCount)} 字`, 'success');
    if (openAfter) {
        await openNovel(meta.id, 'reader', { force: true });
        showTab('reader');
    }
    return meta;
}

/** 番茄下载：建任务 → 轮询 → 取回 txt → 切章入库 */
async function downloadFanqieBook(book, { openAfter = true } = {}) {
    if (!book?.bookId) {
        toast('先选一本番茄书再下载', 'warning');
        return null;
    }
    if (state.online.download.running) {
        toast('正在抓取，请稍候', 'warning');
        return null;
    }
    const client = getFetcher().fanqie();
    const abort = new AbortController();
    const limit = getOnlineSettings().downloadLimit;
    const total = limit > 0 ? Math.min(limit, book.chapterCount || limit) : (book.chapterCount || 0);
    state.online.download = {
        running: true,
        abort,
        done: 0,
        total,
        failed: [],
        label: '正在提交下载任务…',
        jobId: null,
        phase: 'job',
    };
    renderOnlineBook();
    syncOnlineStopButton();
    setOnlineStatus('正在向番茄下载器提交任务…');
    try {
        const job = await client.createJob(
            { bookId: book.bookId, rangeEnd: limit > 0 ? total : null },
            { signal: abort.signal },
        );
        state.online.download.jobId = job.id;
        const finished = await pollFanqieJob(client, job.id, {
            signal: abort.signal,
            onProgress: summary => {
                if (summary.total) state.online.download.total = summary.total;
                state.online.download.done = summary.done;
                state.online.download.label = summary.label;
                updateOnlineDownloadProgress();
            },
        });
        if (finished.failed) throw new Error(finished.label || '番茄下载任务失败');

        state.online.download.phase = 'text';
        state.online.download.label = '正在取回正文…';
        updateOnlineDownloadProgress();
        const text = await client.bookText(
            { bookId: book.bookId, title: book.title },
            { signal: abort.signal },
        );

        state.online.download.phase = 'parse';
        state.online.download.label = '正在切章入库…';
        updateOnlineDownloadProgress();
        const meta = await saveFanqieText(text, book, { openAfter });
        setOnlineStatus(`已从${FANQIE_SITE}导入《${meta.title}》：${meta.chapterCount} 章 / ${formatCount(meta.charCount)} 字`);
        return meta;
    } catch (error) {
        if (isAbortError(error)) {
            const jobId = state.online.download.jobId;
            if (jobId) client.cancelJob(jobId).catch(() => {});
            setOnlineStatus('已停止番茄下载');
            return null;
        }
        throw error;
    } finally {
        state.online.download.running = false;
        state.online.download.abort = null;
        state.online.download.jobId = null;
        state.online.download.phase = '';
        state.online.download.label = '';
        renderOnlineBook();
        syncOnlineStopButton();
        updateHeader();
    }
}

async function downloadOnlineBook(book, { openAfter = true } = {}) {
    // 番茄没有单章接口：交给下载器整本抓，再切章入库
    if (isFanqieBook(book)) return await downloadFanqieBook(book, { openAfter });
    if (state.online.download.running) {
        toast('正在抓取，请稍候', 'warning');
        return null;
    }
    if (!book?.chapters?.length) {
        toast('这本书没有可下载的章节', 'warning');
        return null;
    }
    if (!(await confirmLargeGrab(book))) return null;
    const abort = new AbortController();
    state.online.download = { running: true, abort, done: 0, total: book.chapters.length, failed: [], startedAt: Date.now() };
    renderOnlineBook();
    syncOnlineStopButton();
    try {
        const useCache = Boolean(state.online.reading && state.online.reading.url === book.url);
        const result = await grabOnlineChapters(book, { signal: abort.signal, useCache });
        const rows = result.contents.filter(item => item && item.content && item.content.trim());
        state.online.download.failed = result.failed;
        if (!rows.length && result.earlyReason) {
            // 连着几章都不是正文：这个源在拒绝抓取，别再说「一章都没抓到」
            throw new Error(`这个源返回的不是正文，已停下：${result.earlyReason}`);
        }
        if (!rows.length && result.failed.length) {
            // 全失败时把第一条真实原因带出来，别只说「一章都没抓到」
            throw new Error(`一章都没抓到：${result.failed[0].error}`);
        }
        if (!rows.length) {
            throw new Error(result.aborted ? '已停止，还没抓到任何一章' : '一章都没抓到：换个抓取通道或换个站点试试');
        }
        if (result.earlyReason) {
            toast(`这个源后半段开始返回错误页，已提前停下：${result.earlyReason}`, 'warning');
        }
        const now = Date.now();
        const meta = {
            id: uuid(),
            title: makeUniqueTitle(book.title || '网络小说'),
            author: book.author || '',
            format: 'NET',
            encoding: 'utf-8',
            charCount: rows.reduce((sum, row) => sum + countChars(row.content), 0),
            chapterCount: rows.length,
            sourceName: book.sourceName || book.originName || book.url || '',
            sourceUrl: book.url || '',
            bookUrl: book.url || '',
            sourceId: book.sourceId || book.origin || '',
            origin: book.sourceId || book.origin || '',
            tocUrl: book.tocUrl || book.url || '',
            totalChapterNum: book.chapters.length,
            latestChapterTitle: book.chapters[book.chapters.length - 1]?.title || '',
            canUpdate: Boolean(book.sourceId || book.origin),
            createdAt: now,
            updatedAt: now,
        };
        await saveNovel(meta, rows.map(row => ({
            title: row.title || '未命名章节',
            content: row.content,
            charCount: countChars(row.content),
        })));
        await refreshLibrary();
        if (result.failed.length) {
            toast(`已保存《${meta.title}》${rows.length} 章，另有 ${result.failed.length} 章没抓到（可在阅读页重试）`, 'warning');
            setOnlineStatus(`已保存《${meta.title}》${rows.length} 章，${result.failed.length} 章失败`, true);
        } else {
            toast(`已保存《${meta.title}》：${rows.length} 章 / ${formatCount(meta.charCount)} 字`, 'success');
            setOnlineStatus(`已保存《${meta.title}》：${rows.length} 章 / ${formatCount(meta.charCount)} 字`);
        }
        if (openAfter) {
            state.online.reading = null;
            syncOnlineReaderUi();
            await openNovel(meta.id, 'reader', { force: true });
        }
        return meta;
    } catch (error) {
        toast(`下载失败：${error.message}`, 'error');
        return null;
    } finally {
        state.online.download.running = false;
        state.online.download.abort = null;
        updateOnlineDownloadProgress({ force: true });
        renderOnlineBook();
        syncOnlineStopButton();
        updateHeader();
    }
}

async function exportOnlineBook(book) {
    if (state.online.download.running) {
        toast('正在抓取，请稍候', 'warning');
        return;
    }
    if (!book?.chapters?.length) {
        toast('这本书没有可导出的章节', 'warning');
        return;
    }
    if (!(await confirmLargeGrab(book))) return;
    const abort = new AbortController();
    state.online.download = { running: true, abort, done: 0, total: book.chapters.length, failed: [] };
    renderOnlineBook();
    syncOnlineStopButton();
    try {
        const useCache = Boolean(state.online.reading && state.online.reading.url === book.url);
        const result = await grabOnlineChapters(book, { signal: abort.signal, useCache });
        const rows = result.contents.filter(item => item && item.content && item.content.trim());
        if (!rows.length && result.earlyReason) throw new Error(`这个源返回的不是正文，已停下：${result.earlyReason}`);
        if (!rows.length) throw new Error('一章都没抓到');
        const text = buildBookText(book, rows);
        downloadText(`${safeFileName(book.title || '网络小说')}.txt`, text);
        toast(`已导出 ${rows.length} 章 / ${formatCount(text.length)} 字`, 'success');
    } catch (error) {
        toast(`导出失败：${error.message}`, 'error');
    } finally {
        state.online.download.running = false;
        state.online.download.abort = null;
        renderOnlineBook();
        syncOnlineStopButton();
        updateHeader();
    }
}

/** 阅读页里按「下载本书」：把当前在线书抓全存进书架 */
async function downloadCurrentOnlineBook() {
    const book = bookFromReading();
    if (!book) {
        toast('当前不是在线阅读的书', 'info');
        return;
    }
    await downloadOnlineBook(book);
}

/** 同步阅读页里跟「在线」有关的按钮状态 */
function syncOnlineReaderUi() {
    const online = Boolean(state.online.reading);
    if (elements.readerOnlineBadge) elements.readerOnlineBadge.hidden = !online;
    if (elements.readerDownload) elements.readerDownload.hidden = !online;
    updateReaderButtons();
}

function bindOnlineEvents() {
    elements.onlineSearch?.addEventListener('click', () => {
        runOnlineSearch().catch(error => setOnlineStatus(error.message, true));
    });
    elements.onlineQuery?.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            runOnlineSearch().catch(error => setOnlineStatus(error.message, true));
        }
    });
    elements.onlineStop?.addEventListener('click', stopOnlineSearch);
    elements.onlineOpen?.addEventListener('click', () => {
        openOnlineBookUrl(elements.onlineUrl?.value || '').catch(error => setOnlineStatus(error.message, true));
    });
    elements.onlineUrl?.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            openOnlineBookUrl(elements.onlineUrl.value).catch(error => setOnlineStatus(error.message, true));
        }
    });
    elements.onlineResults?.addEventListener('click', event => {
        const card = event.target.closest('[data-url]');
        if (!card) return;
        openOnlineBookUrl(card.dataset.url).catch(error => setOnlineStatus(error.message, true));
    });
    elements.onlinePager?.addEventListener('click', event => {
        const button = event.target.closest('[data-page]');
        if (!button || button.disabled) return;
        gotoOnlinePage(button.dataset.page);
    });
    elements.onlinePageSize?.addEventListener('change', () => {
        setOnlinePageSize(elements.onlinePageSize.value);
    });
    elements.onlineSettingsToggle?.addEventListener('click', () => toggleOnlineSettings());
    elements.onlineBridgeCheck?.addEventListener('click', () => {
        refreshBridgeInstallInfo().catch(() => {});
    });
    elements.onlineSort?.addEventListener('change', () => {
        commitOnlineSettings();
        state.online.rawResults = sortSourceResults(state.online.rawResults || [], getOnlineSettings().sourceSort);
        syncOnlineResultsView();
        state.online.page = 1;
        renderOnlineResults();
    });
    elements.onlineExact?.addEventListener('change', () => {
        commitOnlineSettings();
        const info = syncOnlineResultsView();
        state.online.page = 1;
        renderOnlineResults();
        const total = (state.online.rawResults || []).length;
        if (!total) {
            setOnlineStatus(getOnlineSettings().exactMatch
                ? '精准搜索已打开：下次搜索只看书名和关键词一致的'
                : '精准搜索已关闭：会显示所有搜到的结果');
            return;
        }
        setOnlineStatus(getOnlineSettings().exactMatch
            ? `精准搜索：${state.online.results.length} / ${total} 条${exactMatchNote(info)}`
            : `精准搜索已关闭：恢复全部 ${total} 条结果`);
    });
    elements.onlineSourceManage?.addEventListener('click', () => openSourceManager());
    elements.onlineExplore?.addEventListener('click', () => openExploreDialog());
    for (const input of [
        elements.onlineProxy,
        elements.onlineFanqieBridge,
        elements.onlineFanqieUpstream,
        elements.onlineConcurrency,
        elements.onlineChapterTimeout,
        elements.onlineTimeout,
        elements.onlineLimit,
    ]) {
        input?.addEventListener('change', commitOnlineSettings);
    }
    elements.onlineRespectRate?.addEventListener('change', () => {
        commitOnlineSettings();
        const on = getOnlineSettings().respectRateLimit === true;
        setOnlineStatus(on ? '已按书源并发率限速（慢，但更不容易被封）' : '已忽略书源并发率，按「并发抓取」数发请求');
    });
    elements.onlineEngine?.addEventListener('change', () => {
        commitOnlineSettings();
        renderOnlineSettings();
        renderOnlineResults();
        if (isFanqieEngine()) warmFanqieDownloader();
        else clearFanqieStatus();
    });
    elements.onlineChannel?.addEventListener('change', () => {
        commitOnlineSettings();
        renderOnlineSettings();
    });
    elements.onlineBook?.addEventListener('click', event => {
        const action = event.target.closest('[data-act]')?.dataset.act;
        if (!action) return;
        const book = state.online.book;
        if (action === 'shelf') {
            addSourceBookToShelf(book).catch(error => toast(`加入书架失败：${error.message}`, 'error'));
        } else if (action === 'download') {
            downloadOnlineBook(book).catch(error => toast(`下载失败：${error.message}`, 'error'));
        } else if (action === 'export') {
            exportOnlineBook(book).catch(error => toast(`导出失败：${error.message}`, 'error'));
        } else if (action === 'stop') {
            stopOnlineDownload();
        } else if (action === 'close') {
            state.online.book = null;
            renderOnlineBook();
            setOnlineStatus('');
        }
    });
    elements.readerDownload?.addEventListener('click', () => {
        downloadCurrentOnlineBook().catch(error => toast(`下载失败：${error.message}`, 'error'));
    });
}

/* ------------------------------------------------------------------ */
/* 阅读                                                                */
/* ------------------------------------------------------------------ */

function isVolumeChapter(chapter) {
    return Boolean(chapter?.isVolume);
}

/** 从 index 出发找最近的可读章节（跳过卷标题） */
function readableIndexAt(index, direction = 1) {
    const chapters = state.chapters;
    if (!chapters.length) return 0;
    const start = clamp(Number(index) || 0, 0, chapters.length - 1);
    if (!isVolumeChapter(chapters[start])) return start;
    for (let step = 1; step < chapters.length; step++) {
        const next = start + direction * step;
        if (next < 0 || next >= chapters.length) break;
        if (!isVolumeChapter(chapters[next])) return next;
    }
    for (let step = 1; step < chapters.length; step++) {
        const next = start - direction * step;
        if (next < 0 || next >= chapters.length) break;
        if (!isVolumeChapter(chapters[next])) return next;
    }
    return start;
}

/** 上一章 / 下一章（跳过卷标题），没有时返回 -1 */
function neighborChapterIndex(index, direction) {
    const chapters = state.chapters;
    for (let next = index + direction; next >= 0 && next < chapters.length; next += direction) {
        if (!isVolumeChapter(chapters[next])) return next;
    }
    return -1;
}

function renderChapterList() {
    if (!elements.chapterList) return;
    const settings = getSettings();
    const descending = settings.chapterOrder === 'desc';
    if (elements.chapterOrder) {
        elements.chapterOrder.innerHTML = descending
            ? '<i class="fa-solid fa-arrow-down-9-1"></i>'
            : '<i class="fa-solid fa-arrow-down-1-9"></i>';
        elements.chapterOrder.title = descending ? '当前倒序，点一下改正序' : '当前正序，点一下改倒序';
    }
    const filter = (elements.chapterFilter?.value || '').trim().toLowerCase();
    elements.chapterList.replaceChildren();

    if (!state.chapters.length) {
        elements.chapterList.appendChild(createElement('div', 'nr-list-empty', '暂无章节'));
        return;
    }

    const ordered = descending ? [...state.chapters].reverse() : state.chapters;
    const fragment = document.createDocumentFragment();
    const memoCounts = countMemosByChapter(state.memo.novelMemos);
    let count = 0;
    for (const chapter of ordered) {
        if (filter && !chapter.title.toLowerCase().includes(filter)) continue;
        if (chapter.isVolume) {
            const volume = createElement('div', 'nr-chapter-volume', chapter.title);
            volume.title = chapter.title;
            fragment.appendChild(volume);
            count++;
            continue;
        }
        const item = createElement('button', 'nr-chapter-item');
        item.type = 'button';
        item.dataset.chapterIndex = String(chapter.index);
        if (chapter.index === state.reader.index && state.reader.loaded) item.classList.add('is-active');
        const title = createElement('span', 'nr-chapter-title', chapter.title);
        title.title = chapter.title;
        item.appendChild(title);
        const memoCount = memoCounts.get(chapter.index) || 0;
        if (memoCount) {
            const memoBadge = createElement('span', 'nr-chapter-memo');
            memoBadge.title = `本章有 ${memoCount} 条备忘`;
            memoBadge.innerHTML = '<i class="fa-solid fa-note-sticky"></i>';
            memoBadge.appendChild(document.createTextNode(String(memoCount)));
            item.appendChild(memoBadge);
        }
        if (chapter.cached) {
            const cachedBadge = createElement('span', 'nr-chapter-cached');
            cachedBadge.title = '已缓存，离线可读';
            cachedBadge.innerHTML = '<i class="fa-solid fa-circle-check"></i>';
            item.appendChild(cachedBadge);
        }
        item.appendChild(createElement('span', 'nr-chapter-count', `${formatCount(chapter.charCount)} 字`));
        fragment.appendChild(item);
        count++;
    }
    if (count === 0) {
        elements.chapterList.appendChild(createElement('div', 'nr-list-empty', '没有匹配的章节'));
    } else {
        elements.chapterList.appendChild(fragment);
    }
    scrollActiveChapterIntoView();
}

function scrollActiveChapterIntoView() {
    const active = elements.chapterList?.querySelector('.nr-chapter-item.is-active');
    active?.scrollIntoView({ block: 'nearest' });
}

async function openChapter(index, page = 0, options = {}) {
    if (!state.novelId || !state.chapters.length) return;
    if (!options.keepTts) stopReadAloud();
    const safeIndex = readableIndexAt(clamp(Number(index) || 0, 0, state.chapters.length - 1));
    let content = state.chapterCache.get(safeIndex);
    let images = state.chapterImageCache.get(safeIndex) || [];
    if (content === undefined) {
        let failed = false;
        try {
            const loaded = await loadChapterText(safeIndex);
            content = loaded.text;
            images = loaded.images || [];
        } catch (error) {
            content = '';
            failed = true;
            toast(error.message, 'error');
        }
        if (!failed) {
            state.chapterCache.set(safeIndex, content);
            state.chapterImageCache.set(safeIndex, images);
            if (state.chapterCache.size > 6) {
                const first = state.chapterCache.keys().next().value;
                if (first !== safeIndex) {
                    state.chapterCache.delete(first);
                    state.chapterImageCache.delete(first);
                }
            }
        }
    }

    const pages = paginate(content, getSettings().readerPageChars);
    const targetPage = options.toLastPage ? Math.max(0, pages.length - 1) : page;
    state.reader = {
        index: safeIndex,
        page: clamp(Number(targetPage) || 0, 0, Math.max(0, pages.length - 1)),
        pages,
        images: Array.isArray(images) ? images : [],
        loaded: true,
    };

    renderArticle({ animate: options.animateTurn === true, direction: options.direction || 1 });
    updateActiveChapter();
    saveProgress();
    if (!options.silent) {
        elements.readScroll.scrollTop = options.scrollToBottom ? elements.readScroll.scrollHeight : 0;
    }
}

function paginate(text, charsPerPage = CHARS_PER_PAGE) {
    const source = String(text || '').replace(/\r\n?/g, '\n').trim();
    if (!source) return [''];
    const pageChars = clamp(Number(charsPerPage) || CHARS_PER_PAGE, 800, 12000);
    const paragraphs = source.split(/\n+/).filter(paragraph => paragraph.trim());
    const pages = [];
    let current = '';

    const flush = () => {
        if (current.trim()) pages.push(current.trim());
        current = '';
    };

    for (const paragraph of paragraphs) {
        if (paragraph.length > pageChars) {
            flush();
            for (let i = 0; i < paragraph.length; i += pageChars) {
                pages.push(paragraph.slice(i, i + pageChars));
            }
            continue;
        }
        if (current.length + paragraph.length + 1 > pageChars && current) flush();
        current += (current ? '\n' : '') + paragraph;
    }
    flush();
    return pages.length ? pages : [source];
}

/** 把一页正文渲染成段落，并在搜索时高亮命中词 */
function renderPageParagraphs(container, text) {
    const query = state.search.highlight;
    const fragment = document.createDocumentFragment();
    for (const paragraph of String(text || '').split(/\n+/)) {
        if (!paragraph.trim()) continue;
        const node = document.createElement('p');
        const value = paragraph.trim();
        if (!query) {
            node.textContent = value;
        } else {
            for (const part of splitHighlight(value, query)) {
                if (!part.text) continue;
                if (part.match) {
                    const mark = document.createElement('mark');
                    mark.className = 'nr-search-mark';
                    mark.textContent = part.text;
                    node.appendChild(mark);
                } else {
                    node.appendChild(document.createTextNode(part.text));
                }
            }
            if (!node.childNodes.length) node.textContent = value;
        }
        fragment.appendChild(node);
    }
    container.replaceChildren(fragment);
}

/* ------------------------------------------------------------------ */
/* 全文搜索                                                            */
/* ------------------------------------------------------------------ */

const SEARCH_MAX_RESULTS = 300;
const SEARCH_PER_CHAPTER = 12;

function setSearchStatus(text) {
    if (elements.searchStatus) elements.searchStatus.textContent = text;
}

function closeSearchPanel() {
    if (!elements.searchPanel) return;
    elements.searchPanel.hidden = true;
}

function clearNovelSearch({ keepFocus = false, render = true } = {}) {
    state.search.abort?.abort();
    state.search = {
        query: '',
        highlight: '',
        running: false,
        abort: null,
        results: [],
        scanned: 0,
        total: 0,
        truncated: false,
    };
    if (elements.readerSearch) elements.readerSearch.value = '';
    if (elements.readerSearchBtn) elements.readerSearchBtn.textContent = '搜索';
    if (elements.searchPanel) elements.searchPanel.hidden = true;
    if (elements.searchResults) elements.searchResults.replaceChildren();
    if (elements.searchClear) elements.searchClear.hidden = true;
    setSearchStatus('输入关键词，搜索整本小说');
    if (!keepFocus) elements.readerSearch?.blur();
    if (render && state.reader.loaded) renderArticle();
}

async function runNovelSearch() {
    if (state.search.running) {
        state.search.abort?.abort();
        if (elements.readerSearchBtn) elements.readerSearchBtn.textContent = '正在停止…';
        return;
    }
    const query = normalizeSearchQuery(elements.readerSearch?.value);
    if (!query) {
        toast('先输入要搜索的内容', 'warning');
        elements.readerSearch?.focus();
        return;
    }
    if (state.online.reading) {
        // 在线书的正文没落库，全文搜索扫不到未读章节，先引导用户下载
        toast('在线阅读的书还没存到本机：想搜整本请先点工具栏的「下载本书」', 'warning');
        return;
    }
    if (!state.novelId || !state.chapters.length) {
        toast('先打开一本小说再搜索', 'warning');
        return;
    }

    const novelId = state.novelId;
    const controller = new AbortController();
    const results = [];
    let truncated = false;
    state.search = {
        query,
        highlight: '',
        running: true,
        abort: controller,
        results: [],
        scanned: 0,
        total: state.chapters.length,
        truncated: false,
    };
    elements.searchPanel.hidden = false;
    elements.searchClear.hidden = false;
    elements.readerSearchBtn.textContent = '停止';
    setSearchStatus(`正在搜索「${query}」… 0 / ${state.chapters.length} 章`);
    elements.searchResults.replaceChildren();

    try {
        for (let i = 0; i < state.chapters.length; i++) {
            if (controller.signal.aborted || state.novelId !== novelId) break;
            const chapter = state.chapters[i];
            let text = state.chapterCache.get(chapter.index);
            if (text === undefined) {
                text = await getChapterContent(novelId, chapter.index);
            }
            if (controller.signal.aborted || state.novelId !== novelId) break;

            const matches = findOccurrences(text, query, {
                limit: Math.min(SEARCH_PER_CHAPTER, SEARCH_MAX_RESULTS - results.length),
            });
            matches.forEach((match, occurrence) => {
                results.push({
                    chapterIndex: chapter.index,
                    occurrence,
                    snippet: buildSnippet(text, match.offset, match.length),
                });
            });
            state.search.scanned = i + 1;
            if (results.length >= SEARCH_MAX_RESULTS) {
                truncated = true;
                break;
            }
            if (i % 3 === 0 || i === state.chapters.length - 1) {
                setSearchStatus(`正在搜索「${query}」… ${i + 1} / ${state.chapters.length} 章 · 已找到 ${results.length} 处`);
                await yieldToUI();
            }
        }
    } finally {
        // 被「清空」或切换小说重置过时，不要把旧结果写回去
        if (state.novelId === novelId && state.search.abort === controller) {
            const aborted = controller.signal.aborted;
            state.search.running = false;
            state.search.abort = null;
            state.search.results = results;
            state.search.highlight = query;
            state.search.truncated = truncated;
            elements.readerSearchBtn.textContent = '搜索';
            const countText = `找到 ${results.length} 处${truncated ? `（已达到 ${SEARCH_MAX_RESULTS} 条上限）` : ''}`;
            const prefix = aborted ? '已停止' : '搜索完成';
            setSearchStatus(results.length
                ? `${prefix}：${countText} · 已搜索 ${state.search.scanned} / ${state.chapters.length} 章 · 点击结果跳转`
                : `${prefix}：没有找到「${query}」`);
            renderSearchResults();
            elements.searchPanel.hidden = false;
            if (state.reader.loaded) renderArticle();
        }
    }
}

function renderSearchResults() {
    if (!elements.searchResults) return;
    elements.searchResults.replaceChildren();
    const results = state.search.results;
    if (!results.length) {
        elements.searchResults.appendChild(createElement('div', 'nr-list-empty', '没有找到匹配内容'));
        return;
    }
    const fragment = document.createDocumentFragment();
    const chapterCount = state.chapters.length;
    results.forEach((hit, index) => {
        const chapter = state.chapters.find(item => item.index === hit.chapterIndex);
        const ordinal = chapter ? state.chapters.indexOf(chapter) + 1 : hit.chapterIndex + 1;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'nr-search-hit';
        button.dataset.searchHit = String(index);

        const head = document.createElement('span');
        head.className = 'nr-search-hit-head';
        const title = document.createElement('strong');
        title.textContent = `第 ${ordinal} / ${chapterCount} 章 · ${chapter?.title || '未命名章节'}`;
        const meta = document.createElement('em');
        meta.textContent = `第 ${hit.occurrence + 1} 处`;
        head.appendChild(title);
        head.appendChild(meta);

        const snippet = document.createElement('span');
        snippet.className = 'nr-search-hit-snippet';
        if (hit.snippet.truncatedStart) snippet.appendChild(document.createTextNode('…'));
        snippet.appendChild(document.createTextNode(hit.snippet.prefix));
        const mark = document.createElement('mark');
        mark.textContent = hit.snippet.match;
        snippet.appendChild(mark);
        snippet.appendChild(document.createTextNode(hit.snippet.suffix));
        if (hit.snippet.truncatedEnd) snippet.appendChild(document.createTextNode('…'));

        button.appendChild(head);
        button.appendChild(snippet);
        fragment.appendChild(button);
    });
    elements.searchResults.appendChild(fragment);
}

async function jumpToSearchHit(index) {
    const hit = state.search.results[index];
    if (!hit) return;
    const query = state.search.query;
    await openChapter(hit.chapterIndex, 0, { silent: true });
    const page = findPageForOccurrence(state.reader.pages, query, hit.occurrence);
    state.reader.page = page;
    state.search.highlight = query;
    renderArticle();
    elements.readScroll.scrollTop = 0;
    closeSearchPanel();
    saveProgress();
}

function getPageTurnMode() {
    const value = getSettings().pageTurn;
    return PAGE_TURN_MODES.has(value) ? value : 'slide';
}

function prefersReducedMotion() {
    try {
        return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
    } catch {
        return false;
    }
}

let pageGhost = null;
let pageGhostAnimation = null;

function clearPageGhost() {
    try {
        pageGhostAnimation?.cancel();
    } catch {
        // 忽略取消失败
    }
    pageGhostAnimation = null;
    pageGhost?.remove();
    pageGhost = null;
}

/**
 * 把当前这一页复制成一张浮在正文上方的「纸页」，用于覆盖 / 仿真翻页时
 * 让旧的一页先原地停留、再翻走；新的一页此时已经渲染在下面。
 */
function snapshotArticlePage() {
    const main = elements.readMain;
    const article = elements.article;
    if (!main || !article || article.hidden) return null;
    clearPageGhost();

    const mainRect = main.getBoundingClientRect();
    const rect = article.getBoundingClientRect();
    const scrollRect = elements.readScroll?.getBoundingClientRect();
    // 正文可能比阅读区更高：纸页只保留可见那一段，避免翻页时盖住顶部工具栏和底栏
    const top = scrollRect ? Math.max(rect.top, scrollRect.top) : rect.top;
    const bottom = scrollRect ? Math.min(rect.bottom, scrollRect.bottom) : rect.bottom;
    const height = bottom - top;
    if (!rect.width || height <= 0) return null;

    const ghost = document.createElement('div');
    ghost.className = 'nr-page-ghost';
    ghost.setAttribute('aria-hidden', 'true');
    ghost.style.left = `${rect.left - mainRect.left}px`;
    ghost.style.top = `${top - mainRect.top}px`;
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${height}px`;

    const clone = article.cloneNode(true);
    clone.removeAttribute('id');
    clone.hidden = false;
    clone.classList.add('nr-article-clone');
    for (const node of clone.querySelectorAll('[id]')) node.removeAttribute('id');
    // 如果正文已经被滚动过，让纸页内容也停在同样的位置
    const scrolled = scrollRect ? Math.max(0, scrollRect.top - rect.top) : 0;
    if (scrolled > 0) {
        clone.style.transform = `translateY(-${scrolled}px)`;
    }
    ghost.appendChild(clone);

    main.appendChild(ghost);
    pageGhost = ghost;
    return ghost;
}

function cleanupPageGhost(animation, ghost) {
    if (pageGhost === ghost) pageGhost = null;
    if (pageGhostAnimation === animation) pageGhostAnimation = null;
    ghost.remove();
}

function playPageTurn(direction, ghost) {
    const mode = getPageTurnMode();
    if (mode === 'none') {
        ghost?.remove();
        return;
    }
    const amp = direction >= 0 ? 1 : -1;
    const article = elements.article;
    const supportsAnimation = typeof article?.animate === 'function';

    if (mode === 'fade') {
        ghost?.remove();
        if (supportsAnimation) {
            article.animate(
                [{ opacity: 0.12 }, { opacity: 1 }],
                { duration: 190, easing: 'ease-out' },
            );
        }
        return;
    }

    if (mode === 'slide') {
        // 滑动：旧页整张滑出、新页从另一侧滑入，和「阅读」的横向翻页一致
        if (!ghost || typeof ghost.animate !== 'function') {
            ghost?.remove();
            if (supportsAnimation) {
                article.animate(
                    [{ transform: `translateX(${28 * amp}px)`, opacity: 0.3 }, { transform: 'translateX(0)', opacity: 1 }],
                    { duration: 200, easing: 'cubic-bezier(.22,.61,.36,1)' },
                );
            }
            return;
        }
        ghost.classList.add(amp > 0 ? 'nr-forward' : 'nr-backward');
        const out = ghost.animate(
            [
                { transform: 'translateX(0)', opacity: 1 },
                { transform: `translateX(${-100 * amp}%)`, opacity: 1 },
            ],
            { duration: 260, easing: 'cubic-bezier(.25,.8,.35,1)' },
        );
        pageGhostAnimation = out;
        const cleanup = () => cleanupPageGhost(out, ghost);
        out.addEventListener('finish', cleanup, { once: true });
        out.addEventListener('cancel', cleanup, { once: true });
        if (supportsAnimation) {
            article.animate(
                [
                    { transform: `translateX(${100 * amp}%)` },
                    { transform: 'translateX(0)' },
                ],
                { duration: 260, easing: 'cubic-bezier(.25,.8,.35,1)' },
            );
        }
        setTimeout(cleanup, 1200);
        return;
    }

    if (!ghost) return;
    if (typeof ghost.animate !== 'function') {
        ghost.remove();
        return;
    }

    let animation;
    ghost.classList.add(amp > 0 ? 'nr-forward' : 'nr-backward');
    if (mode === 'cover') {
        // 旧的一页整张滑走，露出下面新的一页
        // 覆盖：旧页压在新页上面横向滑走，不旋转
        animation = ghost.animate(
            [
                { transform: 'translateX(0)', filter: 'brightness(1)' },
                { transform: `translateX(${12 * amp}px)`, filter: 'brightness(.96)', offset: 0.16 },
                { transform: `translateX(${104 * amp}%)`, filter: 'brightness(.78)' },
            ],
            { duration: 300, easing: 'cubic-bezier(.3,.7,.35,1)' },
        );
    } else {
        // 仿真翻页：以书页一侧为轴做 3D 旋转
        // 仿真：绕书脊 3D 翻过去（浏览器里做不到原生书页卷曲，用透视 + 阴影近似）
        ghost.style.transformOrigin = amp > 0 ? 'left center' : 'right center';
        animation = ghost.animate(
            [
                { transform: 'perspective(1400px) rotateY(0deg)', filter: 'brightness(1)' },
                { transform: `perspective(1400px) rotateY(${38 * amp}deg)`, filter: 'brightness(.92)', offset: 0.45 },
                { transform: `perspective(1400px) rotateY(${96 * amp}deg)`, filter: 'brightness(.7)' },
            ],
            { duration: 480, easing: 'cubic-bezier(.32,.06,.25,1)' },
        );
    }

    pageGhostAnimation = animation;
    const cleanup = () => cleanupPageGhost(animation, ghost);
    animation.addEventListener('finish', cleanup, { once: true });
    animation.addEventListener('cancel', cleanup, { once: true });
    // 兜底：标签页切到后台时动画事件可能不派发，不能让幽灵页留在界面上
    setTimeout(cleanup, 1400);
}

/** 渲染当前页正文；翻页 / 换章时由调用方传入动画参数 */
/** 图片章节：正文第一页上方显示本章图片 */
function renderArticleImages() {
    const box = elements.articleImages;
    if (!box) return;
    const images = Array.isArray(state.reader.images) ? state.reader.images : [];
    const visible = images.length > 0 && state.reader.page === 0;
    box.hidden = !visible;
    box.replaceChildren();
    if (!visible) return;
    for (const src of images.slice(0, 20)) {
        const image = document.createElement('img');
        image.className = 'nr-article-image';
        image.src = src;
        image.alt = '';
        image.loading = 'lazy';
        image.referrerPolicy = 'no-referrer';
        image.addEventListener('error', () => image.remove());
        box.appendChild(image);
    }
}

function renderPageContent({ animate = false, direction = 1 } = {}) {
    const chapter = state.chapters[state.reader.index];
    const pages = state.reader.pages;
    const page = pages[state.reader.page] ?? '';
    const mode = getPageTurnMode();
    const withAnimation = animate && mode !== 'none' && !prefersReducedMotion();
    const ghost = withAnimation && (mode === 'cover' || mode === 'flip' || mode === 'slide') ? snapshotArticlePage() : null;

    elements.articleTitle.textContent = chapter?.title || '';
    elements.articleMeta.textContent = `第 ${state.reader.index + 1} / ${state.chapters.length} 章 · 本章 ${formatCount(chapter?.charCount || 0)} 字 · 第 ${state.reader.page + 1} / ${pages.length} 页`;
    renderPageParagraphs(elements.articleText, page);
    renderArticleImages();
    if (!page && state.online.reading) {
        elements.articleText.appendChild(
            createElement('div', 'nr-chapter-end', '这一章没抓到正文：点一下左侧章节名重试，或在「找书 → 抓取设置」里换个通道'),
        );
    } else if (!page && Array.isArray(state.reader.images) && state.reader.images.length) {
        elements.articleText.appendChild(
            createElement('div', 'nr-chapter-end', '本章是图片章节，正文见上方图片。'),
        );
    }
    // 本章最后一页加一条「继续」提示，配合滑动 / 滚动跨章，避免读到底后卡住
    if (state.reader.page >= pages.length - 1) {
        const hasNextChapter = state.reader.index < state.chapters.length - 1;
        const end = createElement(
            'div',
            'nr-chapter-end',
            hasNextChapter
                ? '已到本章末尾 · 继续上滑或点「下一页」进入下一章'
                : '已经是最后一章了',
        );
        elements.articleText.appendChild(end);
    }
    elements.pageInfo.textContent = `第 ${state.reader.page + 1} / ${pages.length} 页`;
    elements.readScroll.scrollTop = 0;
    updateReaderButtons();
    saveProgress();
    if (withAnimation) playPageTurn(direction, ghost);
    else ghost?.remove();
}

function renderArticle({ animate = false, direction = 1 } = {}) {
    if (!elements.article) return;
    const hasNovel = !!state.novel && state.chapters.length > 0 && state.reader.loaded;
    elements.article.hidden = !hasNovel;
    elements.readerEmpty.hidden = hasNovel;

    if (!hasNovel) {
        clearPageGhost();
        elements.articleTitle.textContent = '';
        elements.articleText.replaceChildren();
        if (elements.articleImages) {
            elements.articleImages.replaceChildren();
            elements.articleImages.hidden = true;
        }
        elements.articleMeta.textContent = '';
        elements.pageInfo.textContent = '—';
        updateReaderButtons();
        return;
    }

    updateActiveChapter();
    applyFontSize();
    renderPageContent({ animate, direction });
}

function updateActiveChapter() {
    for (const item of elements.chapterList.querySelectorAll('[data-chapter-index]')) {
        item.classList.toggle('is-active', Number(item.dataset.chapterIndex) === state.reader.index);
    }
}

function updateReaderButtons() {
    if (elements.readerChangeSource) {
        // 和阅读一样：换源是「书架里的书源书」才有的操作。
        // 本地导入的书没有源可换；在线阅读的临时书还没入库、换了也留不住，直接不显示。
        const usable = Boolean(state.novel) && !state.online.reading && isSourceBook(state.novel);
        elements.readerChangeSource.hidden = !usable;
        elements.readerChangeSource.disabled = !usable;
        elements.readerChangeSource.title = usable
            ? '换一个书源（按书名 / 作者搜同名书）'
            : '只有加入书架的书源书才能换源';
    }
    const prevChapter = panel.querySelector('#nr-chapter-prev');
    const nextChapter = panel.querySelector('#nr-chapter-next');
    const prevPage = panel.querySelector('#nr-page-prev');
    const nextPage = panel.querySelector('#nr-page-next');
    const sumThis = panel.querySelector('#nr-sum-this');
    if (!prevChapter) return;

    const chapterCount = state.chapters.length;
    const pageCount = state.reader.pages.length;
    const atFirstPage = state.reader.page <= 0;
    const atLastPage = state.reader.page >= pageCount - 1;
    const hasPrevChapter = state.reader.index > 0;
    const hasNextChapter = state.reader.index < chapterCount - 1;
    prevChapter.disabled = !hasPrevChapter;
    nextChapter.disabled = !hasNextChapter;
    // 到了本章第一页 / 最后一页，翻页按钮继续往前走就是上一章 / 下一章
    prevPage.disabled = atFirstPage && !hasPrevChapter;
    nextPage.disabled = atLastPage && !hasNextChapter;
    prevPage.title = atFirstPage && hasPrevChapter ? '上一章·最后一页' : '上一页';
    nextPage.title = atLastPage && hasNextChapter ? '进入下一章' : '下一页';
    sumThis.disabled = !state.novelId || Boolean(state.online.reading);
    sumThis.title = state.online.reading ? '在线阅读的书要先把整本下载到书架才能总结' : '总结当前章节';
    syncMemoQuickCount();
}

function changePage(delta) {
    if (!state.reader.loaded || !state.reader.pages.length) return;
    const next = state.reader.page + delta;
    if (next >= 0 && next < state.reader.pages.length) {
        state.reader.page = next;
        renderPageContent({ animate: true, direction: delta });
        return;
    }
    // 跨章：最后一页继续往后翻进下一章，第一页继续往前翻回上一章最后一页
    if (delta > 0) {
        const target = neighborChapterIndex(state.reader.index, 1);
        if (target >= 0) {
            openChapter(target, 0, { animateTurn: true, direction: 1 })
                .catch(error => toast(`打开下一章失败：${error.message}`, 'error'));
        } else {
            toast('已经是最后一章了', 'info');
        }
        return;
    }
    const previous = neighborChapterIndex(state.reader.index, -1);
    if (previous >= 0) {
        openChapter(previous, 0, {
            animateTurn: true,
            direction: -1,
            toLastPage: true,
            scrollToBottom: true,
        }).catch(error => toast(`打开上一章失败：${error.message}`, 'error'));
    } else {
        toast('已经是第一章了', 'info');
    }
}

/* ------------------------------------------------------------------ */
/* 阅读手势：左右 / 上下滑动翻页，读完一章继续滑就进下一章              */
/* ------------------------------------------------------------------ */

const SWIPE_TURN_MIN = 46;     // 水平翻页的最小位移（px）
const SWIPE_CHAPTER_MIN = 60;  // 滚到顶 / 底之后再滑，跨章的最小位移（px）

let readerSwipe = null;
let wheelTurn = { last: 0, armed: false, firedAt: 0 };

function readerScrollEdge() {
    const scroll = elements.readScroll;
    if (!scroll) return { top: true, bottom: true, scrollable: false };
    const max = scroll.scrollHeight - scroll.clientHeight;
    return {
        top: scroll.scrollTop <= 1,
        bottom: scroll.scrollTop >= max - 1,
        scrollable: max > 2,
    };
}

function handleReaderTouchStart(event) {
    if (!state.reader.loaded || event.touches.length !== 1) {
        readerSwipe = null;
        return;
    }
    // 正文里的按钮 / 输入框不参与滑动翻页
    if (event.target?.closest?.('button, a, select, input, textarea, label')) {
        readerSwipe = null;
        return;
    }
    const touch = event.touches[0];
    const edge = readerScrollEdge();
    readerSwipe = {
        x: touch.clientX,
        y: touch.clientY,
        axis: null,
        moved: false,
        scrollable: edge.scrollable,
        startAtTop: edge.top,
        startAtBottom: edge.bottom,
    };
}

function handleReaderTouchMove(event) {
    const gesture = readerSwipe;
    if (!gesture || event.touches.length !== 1) return;
    const touch = event.touches[0];
    const dx = touch.clientX - gesture.x;
    const dy = touch.clientY - gesture.y;
    const absX = Math.abs(dx);
    const absY = Math.abs(dy);
    if (!gesture.axis) {
        if (Math.max(absX, absY) < 10) return;
        gesture.axis = absX > absY * 1.2 ? 'x' : 'y';
    }
    gesture.moved = true;
    // 横向手势交给翻页；纵向优先让浏览器滚动，只有整页一屏放得下时才接管
    if (gesture.axis === 'x' || !gesture.scrollable) {
        if (event.cancelable) event.preventDefault();
    }
}

function handleReaderTouchEnd(event) {
    const gesture = readerSwipe;
    readerSwipe = null;
    if (!gesture || !gesture.moved) return;
    const touch = event.changedTouches?.[0];
    if (!touch) return;
    const dx = touch.clientX - gesture.x;
    const dy = touch.clientY - gesture.y;
    const absX = Math.abs(dx);
    const absY = Math.abs(dy);

    if (gesture.axis === 'x' || (absX > absY * 1.2 && absX >= SWIPE_TURN_MIN)) {
        if (absX >= SWIPE_TURN_MIN) changePage(dx < 0 ? 1 : -1);
        return;
    }
    if (absY < SWIPE_CHAPTER_MIN) return;
    if (!gesture.scrollable) {
        changePage(dy < 0 ? 1 : -1);
        return;
    }
    // 已经是「滑到头」的那一次手势才跨章，避免一次长滑连跳两章
    const edge = readerScrollEdge();
    if (dy < 0 && gesture.startAtBottom && edge.bottom) changePage(1);
    else if (dy > 0 && gesture.startAtTop && edge.top) changePage(-1);
}

function handleReaderWheel(event) {
    if (!state.reader.loaded) return;
    const edge = readerScrollEdge();
    const forward = event.deltaY > 0;
    const atEdge = forward ? edge.bottom : edge.top;
    const now = Date.now();
    // 一次滚轮连续滚动只在「一开始就到底 / 到顶」时才跨章，防止冲过头
    if (now - wheelTurn.last > 260) wheelTurn.armed = atEdge;
    wheelTurn.last = now;
    if (!atEdge || !wheelTurn.armed) return;
    if (now - wheelTurn.firedAt < 900) return;
    wheelTurn.firedAt = now;
    wheelTurn.armed = false;
    changePage(forward ? 1 : -1);
}

function changeFontSize(delta) {
    const settings = getSettings();
    settings.fontSize = clamp((settings.fontSize || 17) + delta, 12, 32);
    persistReaderPrefs();
    saveSettings();
    applyReaderSettings();
    renderReaderSettings();
}

function applyFontSize() {
    applyReaderSettings();
}

function applyReaderSettings() {
    if (!panel) return;
    const settings = getSettings();
    const size = clamp(Number(settings.fontSize) || 17, 12, 32);
    const lineHeight = clamp(Number(settings.readerLineHeight) || 2, 1.4, 2.8);
    const paraGap = clamp(Number(settings.readerParaGap) || 0, 0, 2);
    const width = clamp(Number(settings.readerWidth) || 820, 560, 1100);
    const indent = clamp(Number(settings.readerIndent) || 0, 0, 3);
    const letterSpacing = clamp(Number(settings.readerLetterSpacing) || 0, 0, 0.08);
    const theme = ['auto', 'paper', 'sepia', 'green', 'dark'].includes(settings.readerTheme)
        ? settings.readerTheme
        : 'auto';
    const font = READER_FONTS[settings.readerFont] || READER_FONTS.system;
    const align = settings.readerAlign === 'left' ? 'left' : 'justify';

    panel.style.setProperty('--nr-font-size', `${size}px`);
    panel.style.setProperty('--nr-read-font', font);
    panel.style.setProperty('--nr-read-line-height', String(lineHeight));
    panel.style.setProperty('--nr-read-para-gap', `${paraGap}em`);
    panel.style.setProperty('--nr-read-width', `${width}px`);
    panel.style.setProperty('--nr-read-indent', `${indent}em`);
    panel.style.setProperty('--nr-read-letter-spacing', `${letterSpacing}em`);
    panel.style.setProperty('--nr-read-align', align);
    if (elements.reader) elements.reader.dataset.theme = theme;
}

function syncReaderOutputs() {
    if (!elements.readerSettings) return;
    const settings = getSettings();
    const size = clamp(Number(settings.fontSize) || 17, 12, 32);
    const lineHeight = clamp(Number(settings.readerLineHeight) || 2, 1.4, 2.8);
    const paraGap = clamp(Number(settings.readerParaGap) || 0, 0, 2);
    const width = clamp(Number(settings.readerWidth) || 820, 560, 1100);
    const indent = clamp(Number(settings.readerIndent) || 0, 0, 3);
    const letterSpacing = clamp(Number(settings.readerLetterSpacing) || 0, 0, 0.08);

    elements.readerSizeValue.textContent = size;
    elements.readerLineHeightValue.textContent = lineHeight.toFixed(1);
    elements.readerParaGapValue.textContent = paraGap.toFixed(1);
    elements.readerWidthValue.textContent = width;
    elements.readerIndentValue.textContent = indent;
    elements.readerLetterSpacingValue.textContent = letterSpacing.toFixed(2);
    if (elements.fontSize) elements.fontSize.value = size;
    if (elements.readerSettingsStatus) elements.readerSettingsStatus.textContent = '已保存';
}

function readReaderControls() {
    const settings = getSettings();
    const theme = ['auto', 'paper', 'sepia', 'green', 'dark'].includes(elements.readerTheme.value)
        ? elements.readerTheme.value
        : 'auto';
    const font = READER_FONTS[elements.readerFont.value] ? elements.readerFont.value : 'system';
    settings.fontSize = clamp(Number(elements.readerSize.value) || 17, 12, 32);
    settings.readerTheme = theme;
    settings.readerFont = font;
    settings.readerLineHeight = clamp(Number(elements.readerLineHeight.value) || 2, 1.4, 2.8);
    settings.readerParaGap = clamp(Number(elements.readerParaGap.value) || 0, 0, 2);
    settings.readerWidth = clamp(Number(elements.readerWidth.value) || 820, 560, 1100);
    settings.readerIndent = clamp(Number(elements.readerIndent.value) || 0, 0, 3);
    settings.readerAlign = elements.readerAlign.value === 'left' ? 'left' : 'justify';
    settings.readerLetterSpacing = clamp(Number(elements.readerLetterSpacing.value) || 0, 0, 0.08);
    settings.readerPageChars = clamp(Number(elements.readerPageChars.value) || CHARS_PER_PAGE, 800, 12000);
    settings.pageTurn = PAGE_TURN_MODES.has(elements.readerPageTurn?.value) ? elements.readerPageTurn.value : 'slide';
    if (elements.readerTtsRate) {
        settings.ttsRate = Math.min(2, Math.max(0.75, Number(elements.readerTtsRate.value) || 1));
    }
    return settings;
}

function commitReaderControls({ repaginate = true } = {}) {
    if (!elements.readerSettings) return;
    const before = clamp(Number(getSettings().readerPageChars) || CHARS_PER_PAGE, 800, 12000);
    const beforeTurn = getPageTurnMode();
    const settings = readReaderControls();
    persistReaderPrefs();
    saveSettings();
    applyReaderSettings();
    syncReaderOutputs();
    if (repaginate && settings.readerPageChars !== before) repaginateCurrentChapter();
    // 选中翻页动画时立刻用当前页演示一次
    if (settings.pageTurn !== beforeTurn && settings.pageTurn !== 'none'
        && state.reader.loaded && elements.readerSettings && !elements.readerSettings.hidden) {
        renderPageContent({ animate: true, direction: 1 });
    }
}

function renderReaderSettings() {
    if (!elements.readerSettings) return;
    const settings = getSettings();
    elements.readerSize.value = clamp(Number(settings.fontSize) || 17, 12, 32);
    elements.readerTheme.value = ['auto', 'paper', 'sepia', 'green', 'dark'].includes(settings.readerTheme)
        ? settings.readerTheme
        : 'auto';
    elements.readerFont.value = READER_FONTS[settings.readerFont] ? settings.readerFont : 'system';
    elements.readerLineHeight.value = clamp(Number(settings.readerLineHeight) || 2, 1.4, 2.8);
    elements.readerParaGap.value = clamp(Number(settings.readerParaGap) || 0, 0, 2);
    elements.readerWidth.value = clamp(Number(settings.readerWidth) || 820, 560, 1100);
    elements.readerIndent.value = clamp(Number(settings.readerIndent) || 0, 0, 3);
    elements.readerAlign.value = settings.readerAlign === 'left' ? 'left' : 'justify';
    if (elements.readerTtsRate) elements.readerTtsRate.value = String(Math.min(2, Math.max(0.75, Number(settings.ttsRate) || 1)));
    elements.readerLetterSpacing.value = clamp(Number(settings.readerLetterSpacing) || 0, 0, 0.08);
    elements.readerPageChars.value = String(clamp(Number(settings.readerPageChars) || CHARS_PER_PAGE, 800, 12000));
    if (elements.readerPageTurn) {
        elements.readerPageTurn.value = PAGE_TURN_MODES.has(settings.pageTurn) ? settings.pageTurn : 'slide';
    }
    if (elements.readerSettingsStatus) elements.readerSettingsStatus.textContent = '修改后立即预览，并自动保存';
    syncReaderOutputs();
}

function toggleReaderSettings(force) {
    if (!elements.readerSettings) return;
    const shouldOpen = typeof force === 'boolean' ? force : elements.readerSettings.hidden;
    if (!shouldOpen) {
        commitReaderControls();
        elements.readerSettings.hidden = true;
        elements.readerSettingsBtn?.setAttribute('aria-expanded', 'false');
        return;
    }
    applyReaderSettings();
    renderReaderSettings();
    elements.readerSettings.hidden = false;
    elements.readerSettingsBtn?.setAttribute('aria-expanded', 'true');
}

function repaginateCurrentChapter() {
    if (!state.reader.loaded || !state.chapters.length) return;
    const content = state.chapterCache.get(state.reader.index);
    if (typeof content !== 'string') return;
    const settings = getSettings();
    const oldCount = Math.max(1, state.reader.pages.length);
    const ratio = oldCount > 1 ? state.reader.page / (oldCount - 1) : 0;
    const pages = paginate(content, settings.readerPageChars);
    state.reader.pages = pages;
    state.reader.page = clamp(Math.round(ratio * (pages.length - 1)), 0, pages.length - 1);
    renderArticle();
    saveProgress();
}

function saveProgress() {
    if (!state.novelId || !state.reader.loaded) return;
    const settings = getSettings();
    if (!settings.progress) settings.progress = {};
    settings.progress[state.novelId] = {
        chapterIndex: state.reader.index,
        page: state.reader.page,
        updatedAt: Date.now(),
    };
    saveSettings();
}

/* ------------------------------------------------------------------ */
/* 备忘录                                                              */
/* ------------------------------------------------------------------ */

function normalizeMemoRecord(memo) {
    return {
        ...memo,
        novelId: memo?.novelId || null,
        groupId: memo?.groupId || null,
        chapterIndex: Number.isInteger(memo?.chapterIndex) ? memo.chapterIndex : null,
        page: Number.isInteger(memo?.page) ? memo.page : null,
        pinned: memo?.pinned === true,
    };
}

function memoGroupById(id) {
    return state.memo.groups.find(group => group.id === id) || null;
}

function memoGroupMemoCount(groupId) {
    return state.memo.groupMemos.filter(memo => memo.groupId === groupId).length;
}

function getMemoById(id) {
    return state.memo.novelMemos.find(memo => memo.id === id)
        || state.memo.groupMemos.find(memo => memo.id === id)
        || null;
}

function resetMemoState() {
    state.memo.novelMemos = [];
    state.memo.loadedNovelId = null;
    state.memo.loading = false;
    state.memo.saving = false;
    state.memo.viewingId = null;
    state.memo.editingId = null;
    state.memo.composing = false;
    state.memo.anchor = null;
    state.memo.targetGroupId = null;
    state.memo.query = '';
    state.memo.pinnedOnly = false;
    state.memo.batchMode = false;
    state.memo.batchSelection = new Set();
    for (const key of [...state.memo.collapsedNodes]) {
        if (key === 'book' || key === 'loose' || key.startsWith('chapter:')) {
            state.memo.collapsedNodes.delete(key);
        }
    }
    persistMemoCollapsedNodes();
    if (elements.memoFilter) elements.memoFilter.value = '';
    if (elements.memoPinned) elements.memoPinned.checked = false;
    if (elements.memoTitle) elements.memoTitle.value = '';
    if (elements.memoContent) elements.memoContent.value = '';
    renderMemoPanel();
    syncMemoIndicators();
}

/** 读取当前小说的本书备忘；分组数据由 loadMemoGroups 单独维护 */
async function loadMemosForNovel(novelId, { force = false } = {}) {
    if (!novelId) return;
    if (!force && state.memo.loadedNovelId === novelId) return;
    const requested = novelId;
    state.memo.loading = true;
    try {
        const memos = await listMemos(novelId);
        if (state.novelId !== requested) return;
        state.memo.novelMemos = memos.map(normalizeMemoRecord);
        state.memo.loadedNovelId = novelId;
        renderMemoPanel();
        renderChapterList();
    } finally {
        state.memo.loading = false;
    }
}

async function loadMemoGroups() {
    if (state.memo.groupsLoaded) return;
    try {
        const [groups, memos] = await Promise.all([listMemoGroups(), listGroupMemos()]);
        state.memo.groups = sortMemoGroups(groups);
        state.memo.groupMemos = memos.map(normalizeMemoRecord);
        state.memo.groupsLoaded = true;
        renderMemoPanel();
        syncMemoIndicators();
    } catch (error) {
        console.warn('[小说阅读器] 读取备忘分组失败', error);
    }
}

/** 当前搜索 / 置顶筛选条件下所有可见备忘（含已折叠的块） */
function getMemoMatchingList() {
    const options = { query: state.memo.query, pinnedOnly: state.memo.pinnedOnly };
    const book = filterMemos(state.memo.novelMemos, options);
    const groups = filterMemos(state.memo.groupMemos, options)
        .filter(memo => Boolean(memoGroupById(memo.groupId)));
    return [...book, ...groups];
}

function memoNodeKeyForMemo(memo) {
    if (memo.groupId) return `group:${memo.groupId}`;
    return Number.isInteger(memo.chapterIndex) ? `chapter:${memo.chapterIndex}` : 'loose';
}

/** 展开某条备忘所在的块，保证保存 / 跳转后能看到它 */
function ensureMemoNodeExpanded(memo) {
    if (!memo) return;
    if (memo.groupId) {
        state.memo.collapsedNodes.delete(`group:${memo.groupId}`);
    } else {
        state.memo.collapsedNodes.delete('book');
        state.memo.collapsedNodes.delete(memoNodeKeyForMemo(memo));
    }
    persistMemoCollapsedNodes();
}

function toggleMemoNode(key) {
    if (!key) return;
    if (state.memo.collapsedNodes.has(key)) state.memo.collapsedNodes.delete(key);
    else state.memo.collapsedNodes.add(key);
    persistMemoCollapsedNodes();
    renderMemoPanel();
}

function updateMemoBatchBar() {
    if (elements.memoBatchFoot) elements.memoBatchFoot.hidden = !state.memo.batchMode;
    if (elements.memoBatch) {
        elements.memoBatch.textContent = state.memo.batchMode ? '退出批量' : '批量删除';
        elements.memoBatch.setAttribute('aria-pressed', state.memo.batchMode ? 'true' : 'false');
    }
    if (elements.memoBatchCount) {
        elements.memoBatchCount.textContent = `已选 ${state.memo.batchSelection.size} 条`;
    }
    if (elements.memoBatchDelete) {
        elements.memoBatchDelete.disabled = state.memo.batchSelection.size === 0;
    }
}

function renderMemoPanel() {
    if (!elements.memoTree) return;
    const options = { query: state.memo.query, pinnedOnly: state.memo.pinnedOnly };
    const bookMatching = filterMemos(state.memo.novelMemos, options);
    const groupMatching = filterMemos(state.memo.groupMemos, options)
        .filter(memo => Boolean(memoGroupById(memo.groupId)));
    const groupMatches = new Map();
    for (const group of state.memo.groups) groupMatches.set(group.id, []);
    for (const memo of groupMatching) {
        if (groupMatches.has(memo.groupId)) groupMatches.get(memo.groupId).push(memo);
    }
    const allMatching = [...bookMatching, ...groupMatching];

    if (state.memo.batchMode) {
        const matchingIds = new Set(allMatching.map(memo => memo.id));
        state.memo.batchSelection = new Set(
            [...state.memo.batchSelection].filter(id => matchingIds.has(id)),
        );
    }

    renderMemoTree({ bookMatching, groupMatches });
    renderMemoEditorState();
    syncMemoIndicators();
    updateMemoBatchBar();

    const total = state.memo.novelMemos.length + state.memo.groupMemos.length;
    const filtered = allMatching.length !== total;
    if (elements.memoListTitle) elements.memoListTitle.textContent = '备忘录';
    if (elements.memoListCount) {
        elements.memoListCount.textContent = total ? `${allMatching.length} / ${total}` : '';
    }
    if (elements.memoHeadMeta) {
        if (!state.novelId && !state.memo.groups.length) {
            elements.memoHeadMeta.textContent = '先在书架打开一本小说，或新建一个分组';
        } else if (state.novelId) {
            const parts = [
                state.novel?.title || '当前小说',
                `本书 ${state.memo.novelMemos.length} 条`,
                `分组 ${state.memo.groups.length} 个 / ${state.memo.groupMemos.length} 条`,
            ];
            if (filtered) parts.push(`筛选出 ${allMatching.length} 条`);
            elements.memoHeadMeta.textContent = parts.join(' · ');
        } else {
            const parts = [`分组 ${state.memo.groups.length} 个`, `${state.memo.groupMemos.length} 条`];
            if (filtered) parts.push(`筛选出 ${allMatching.length} 条`);
            elements.memoHeadMeta.textContent = parts.join(' · ');
        }
    }
    if (elements.memoCount) {
        elements.memoCount.textContent = total
            ? `匹配 ${allMatching.length} 条 · 共 ${total} 条`
            : '0 条备忘';
    }
    if (elements.memoSort && elements.memoSort.value !== state.memo.sort) {
        elements.memoSort.value = state.memo.sort;
    }
}

function renderMemoTree({ bookMatching, groupMatches }) {
    if (!elements.memoTree) return;
    elements.memoTree.replaceChildren();
    const fragment = document.createDocumentFragment();
    const filtering = Boolean(state.memo.query.trim() || state.memo.pinnedOnly);

    if (state.novelId) {
        const bookKey = 'book';
        const expanded = !state.memo.collapsedNodes.has(bookKey);
        const children = [];
        if (expanded) {
            const byChapter = new Map();
            for (const memo of bookMatching) {
                const key = Number.isInteger(memo.chapterIndex) ? memo.chapterIndex : null;
                if (!byChapter.has(key)) byChapter.set(key, []);
                byChapter.get(key).push(memo);
            }
            const chapterKeys = [...byChapter.keys()]
                .filter(key => key !== null)
                .sort((a, b) => a - b);
            if (byChapter.has(null)) chapterKeys.push(null);
            for (const key of chapterKeys) {
                const memos = byChapter.get(key);
                const nodeKey = key === null ? 'loose' : `chapter:${key}`;
                const chapter = key === null ? null : state.chapters.find(item => item.index === key);
                const ordinal = chapter ? state.chapters.indexOf(chapter) + 1 : Number(key) + 1;
                children.push(buildMemoTreeNode({
                    key: nodeKey,
                    level: 1,
                    label: key === null
                        ? '未绑定位置'
                        : memoChapterLabel(chapter || { index: key, title: '' }, ordinal),
                    icon: key === null ? 'fa-location-dot' : 'fa-file-lines',
                    count: memos.length,
                    memos,
                    memoDepth: 2,
                    expanded: !state.memo.collapsedNodes.has(nodeKey),
                }));
            }
        }
        fragment.appendChild(buildMemoTreeNode({
            key: bookKey,
            level: 0,
            label: `本书 · ${state.novel?.title || '当前小说'}`,
            icon: 'fa-book-open',
            count: bookMatching.length,
            children,
            expanded,
        }));
    }

    for (const group of state.memo.groups) {
        const memos = groupMatches.get(group.id) || [];
        if (filtering && !memos.length) continue;
        fragment.appendChild(buildMemoTreeNode({
            key: `group:${group.id}`,
            level: 0,
            label: group.name,
            icon: 'fa-folder',
            count: memos.length,
            group,
            memos,
            memoDepth: 1,
            expanded: !state.memo.collapsedNodes.has(`group:${group.id}`),
        }));
    }

    if (!state.novelId && !state.memo.groups.length) {
        fragment.appendChild(createElement('div', 'nr-memo-tree-empty', '先打开一本小说，或新建一个分组'));
    } else if (!state.novelId && filtering
        && ![...groupMatches.values()].some(list => list.length)) {
        fragment.appendChild(createElement('div', 'nr-memo-tree-empty', '没有匹配的备忘'));
    }
    const addGroup = createElement('button', 'nr-link nr-memo-tree-add', '＋ 新建分组');
    addGroup.type = 'button';
    addGroup.dataset.memoAct = 'add-group';
    fragment.appendChild(addGroup);
    elements.memoTree.appendChild(fragment);
}

function buildMemoTreeNode({
    key,
    level = 0,
    label,
    icon = '',
    count = 0,
    group = null,
    memos = null,
    children = null,
    expanded = true,
    memoDepth = 1,
}) {
    const node = createElement('div', 'nr-memo-tree-node');
    node.dataset.nodeKey = key;
    node.dataset.level = String(level);
    if (group) node.dataset.memoGroupId = group.id;

    const head = createElement('div', 'nr-memo-tree-head');
    const toggle = createElement('button', 'nr-memo-tree-toggle');
    toggle.type = 'button';
    toggle.dataset.memoAct = 'toggle-node';
    toggle.dataset.memoNodeKey = key;
    toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    toggle.title = expanded ? `折叠「${label}」` : `展开「${label}」`;
    toggle.appendChild(createElement(
        'i',
        `fa-solid ${expanded ? 'fa-chevron-down' : 'fa-chevron-right'} nr-memo-tree-chevron`,
    ));
    if (icon) toggle.appendChild(createElement('i', `fa-solid ${icon} nr-memo-tree-icon`));
    const labelEl = createElement('span', 'nr-memo-tree-label', label);
    labelEl.title = label;
    const countEl = createElement('em', 'nr-memo-tree-count', String(count));
    countEl.title = `${count} 条备忘`;
    toggle.append(labelEl, countEl);
    head.appendChild(toggle);

    if (group) {
        const actions = createElement('div', 'nr-memo-tree-actions');
        const rename = createElement('button', 'nr-link', '改名');
        rename.type = 'button';
        rename.dataset.memoAct = 'rename-group';
        rename.title = `重命名分组「${group.name}」`;
        const remove = createElement('button', 'nr-link nr-danger-text', '删除');
        remove.type = 'button';
        remove.dataset.memoAct = 'delete-group';
        remove.title = `删除分组「${group.name}」`;
        actions.append(rename, remove);
        head.appendChild(actions);
    }
    node.appendChild(head);

    if (expanded) {
        const body = createElement('div', 'nr-memo-tree-body');
        if (Array.isArray(children)) {
            if (children.length) body.append(...children);
            else body.appendChild(createElement('div', 'nr-memo-tree-empty', '还没有匹配的备忘'));
        } else if (Array.isArray(memos)) {
            const sorted = sortMemos(memos, state.memo.sort);
            if (!sorted.length) body.appendChild(createElement('div', 'nr-memo-tree-empty', '还没有匹配的备忘'));
            else for (const memo of sorted) body.appendChild(buildMemoRow(memo, { depth: memoDepth }));
        }
        node.appendChild(body);
    }
    return node;
}

function buildMemoRow(memo, { depth = 1 } = {}) {
    const row = createElement('div', 'nr-memo-row-wrap nr-memo-tree-memo');
    row.dataset.memoId = memo.id;
    row.dataset.depth = String(depth);
    if (state.memo.batchMode) row.classList.add('is-batch');
    if (state.memo.batchSelection.has(memo.id)) row.classList.add('is-picked');
    if (!state.memo.batchMode && (state.memo.viewingId === memo.id || state.memo.editingId === memo.id)) {
        row.classList.add('is-active');
    }

    const pick = document.createElement('input');
    pick.type = 'checkbox';
    pick.className = 'nr-memo-pick';
    pick.dataset.memoPick = memo.id;
    pick.checked = state.memo.batchSelection.has(memo.id);
    pick.title = '选择这条备忘';
    row.appendChild(pick);

    const button = createElement('button', 'nr-memo-row');
    button.type = 'button';
    const titleRow = createElement('div', 'nr-memo-row-title');
    if (memo.pinned) {
        const pin = createElement('i', 'fa-solid fa-thumbtack nr-memo-pin-icon');
        pin.title = '已置顶';
        titleRow.appendChild(pin);
    }
    titleRow.appendChild(createElement('strong', null, memoTitle(memo)));
    button.appendChild(titleRow);

    const metaParts = [];
    if (Number.isInteger(memo.page)) metaParts.push(`第 ${memo.page + 1} 页`);
    const updated = Number.isFinite(memo.updatedAt) ? memo.updatedAt : memo.createdAt;
    if (Number.isFinite(updated)) metaParts.push(formatTime(updated));
    if (metaParts.length) button.appendChild(createElement('div', 'nr-memo-row-meta', metaParts.join(' · ')));

    row.appendChild(button);
    return row;
}

function renderMemoGroupOptions() {
    if (!elements.memoGroup) return;
    const current = state.memo.targetGroupId || '';
    elements.memoGroup.replaceChildren();

    const book = document.createElement('option');
    book.value = '';
    book.textContent = state.novelId ? `本书备忘（${state.novel?.title || '当前小说'}）` : '本书备忘（未打开小说）';
    book.disabled = !state.novelId;
    elements.memoGroup.appendChild(book);

    for (const group of state.memo.groups) {
        const option = document.createElement('option');
        option.value = group.id;
        option.textContent = `${group.name}（${memoGroupMemoCount(group.id)}）`;
        elements.memoGroup.appendChild(option);
    }
    if (current && !memoGroupById(current)) {
        state.memo.targetGroupId = null;
        elements.memoGroup.value = '';
    } else {
        elements.memoGroup.value = current;
    }
    elements.memoGroup.disabled = !state.novelId && !state.memo.groups.length;
}

function renderMemoEditorState() {
    if (!elements.memoEditor) return;
    if (state.memo.viewingId && !getMemoById(state.memo.viewingId)) {
        state.memo.viewingId = null;
    }
    if (state.memo.editingId && !getMemoById(state.memo.editingId)) {
        state.memo.editingId = null;
        state.memo.composing = false;
        state.memo.anchor = null;
    }
    if (state.memo.targetGroupId && !memoGroupById(state.memo.targetGroupId)) {
        state.memo.targetGroupId = null;
    }

    const editing = Boolean(state.memo.composing || state.memo.editingId);
    const viewingMemo = state.memo.viewingId ? getMemoById(state.memo.viewingId) : null;
    const targetGroup = memoGroupById(state.memo.targetGroupId);
    const hasTarget = Boolean(targetGroup || state.novelId);

    if (editing) {
        if (elements.memoView) elements.memoView.hidden = true;
        elements.memoEditor.hidden = false;
        if (elements.memoEmpty) elements.memoEmpty.hidden = true;

        renderMemoGroupOptions();
        if (elements.memoTitle) elements.memoTitle.disabled = !hasTarget;
        if (elements.memoContent) elements.memoContent.disabled = !hasTarget;
        if (elements.memoGroup) elements.memoGroup.disabled = !hasTarget && !state.memo.groups.length;

        if (elements.memoEditorTitle) {
            elements.memoEditorTitle.textContent = state.memo.composing ? '写一条备忘' : '编辑备忘';
        }
        if (elements.memoEditorHint) {
            if (targetGroup) {
                elements.memoEditorHint.textContent = `保存在分组「${targetGroup.name}」· 不随小说删除`;
            } else if (state.novelId) {
                elements.memoEditorHint.textContent = `保存在《${state.novel?.title || '当前小说'}》· 随小说删除`;
            } else {
                elements.memoEditorHint.textContent = '先打开一本小说或创建分组';
            }
        }
        if (elements.memoTargetHint) {
            elements.memoTargetHint.textContent = hasTarget
                ? targetGroup ? '全局保存' : '跟随本书'
                : '';
        }
        if (elements.memoSave) {
            elements.memoSave.disabled = !hasTarget || state.memo.saving;
            elements.memoSave.textContent = state.memo.saving
                ? '保存中…'
                : state.memo.composing ? '保存备忘' : '保存修改';
        }
        if (elements.memoCancel) elements.memoCancel.disabled = state.memo.saving;
        renderMemoAnchor();
        return;
    }

    // 非编辑状态：有选中的备忘就显示只读详情，否则显示空态
    elements.memoEditor.hidden = true;
    if (viewingMemo) {
        if (elements.memoView) elements.memoView.hidden = false;
        if (elements.memoEmpty) elements.memoEmpty.hidden = true;
        renderMemoView(viewingMemo);
        return;
    }
    if (elements.memoView) elements.memoView.hidden = true;
    if (elements.memoEmpty) elements.memoEmpty.hidden = false;
    if (elements.memoEmptyText) {
        elements.memoEmptyText.textContent = (state.novelId || state.memo.groups.length)
            ? '选择左侧的备忘查看，或点右上角「新建」写一条'
            : '先在书架打开一本小说，或新建一个分组';
    }
}

function renderMemoView(memo) {
    if (!elements.memoView) return;
    const group = memo.groupId ? memoGroupById(memo.groupId) : null;
    elements.memoViewTitle.textContent = memoTitle(memo);
    elements.memoViewGroup.hidden = !group;
    elements.memoViewGroup.textContent = group ? group.name : '';
    elements.memoViewPinIcon.hidden = !memo.pinned;

    const meta = [];
    if (group) {
        meta.push('分组备忘');
    } else if (Number.isInteger(memo.chapterIndex)) {
        meta.push(memoAnchorLabel(memo, state.chapters));
    } else {
        meta.push('本书备忘 · 未绑定位置');
    }
    if (memo.pinned) meta.push('已置顶');
    const updated = Number.isFinite(memo.updatedAt) ? memo.updatedAt : memo.createdAt;
    if (Number.isFinite(updated)) meta.push(`更新于 ${formatTime(updated)}`);
    elements.memoViewMeta.textContent = meta.join(' · ');
    elements.memoViewBody.textContent = memo.content || '（空）';
    elements.memoViewPin.textContent = memo.pinned ? '取消置顶' : '置顶';
    elements.memoViewJump.hidden = Boolean(group) || !Number.isInteger(memo.chapterIndex);
}

function renderMemoAnchor() {
    if (!elements.memoAnchorLabel) return;
    const groupMode = Boolean(memoGroupById(state.memo.targetGroupId));
    const anchor = state.memo.anchor;
    const valid = Boolean(!groupMode && state.novelId && anchor && Number.isInteger(anchor.chapterIndex));
    const label = groupMode
        ? '分组备忘不绑定阅读位置'
        : valid ? memoAnchorLabel(anchor, state.chapters) : '不绑定阅读位置';
    elements.memoAnchorLabel.textContent = label;
    elements.memoAnchorLabel.title = label;
    if (elements.memoClearAnchor) elements.memoClearAnchor.hidden = !valid;
    if (elements.memoUsePosition) {
        elements.memoUsePosition.hidden = groupMode || !state.reader.loaded || valid;
        elements.memoUsePosition.disabled = !state.novelId;
    }
}

/** 编辑器里是否有未保存的修改（用于切换备忘 / 小说、快速记前确认） */
function clearMemoForm() {
    if (elements.memoTitle) elements.memoTitle.value = '';
    if (elements.memoContent) elements.memoContent.value = '';
}

function memoEditorHasUnsavedChanges() {
    if (!state.memo.editingId && !state.memo.composing) return false;
    const title = elements.memoTitle?.value ?? '';
    const content = elements.memoContent?.value ?? '';
    if (!state.memo.editingId) return Boolean(title.trim() || content.trim());
    const memo = getMemoById(state.memo.editingId);
    if (!memo) return true;
    if (content !== (memo.content || '')) return true;
    if (title.trim() !== (memo.title || '').trim()) return true;
    if ((state.memo.targetGroupId || null) !== (memo.groupId || null)) return true;
    const savedAnchor = !memo.groupId && Number.isInteger(memo.chapterIndex)
        ? `${memo.chapterIndex}:${Number.isInteger(memo.page) ? memo.page : 0}`
        : '';
    const currentAnchor = state.memo.anchor && Number.isInteger(state.memo.anchor.chapterIndex)
        ? `${state.memo.anchor.chapterIndex}:${Number.isInteger(state.memo.anchor.page) ? state.memo.anchor.page : 0}`
        : '';
    return savedAnchor !== currentAnchor;
}

function cancelMemoEdit() {
    if (!state.memo.editingId && !state.memo.composing) return;
    state.memo.editingId = null;
    state.memo.composing = false;
    state.memo.anchor = null;
    clearMemoForm();
    renderMemoEditorState();
}

/** 清空右侧选择（删除当前备忘 / 分组后使用） */
function clearMemoSelection() {
    state.memo.viewingId = null;
    state.memo.editingId = null;
    state.memo.composing = false;
    state.memo.anchor = null;
    clearMemoForm();
    renderMemoEditorState();
}

async function newMemoDraft() {
    if (memoEditorHasUnsavedChanges()) {
        const ok = await confirmAction('当前备忘还有未保存的修改，要新建一条吗？');
        if (!ok) return;
    }
    const viewed = state.memo.viewingId ? getMemoById(state.memo.viewingId) : null;
    let targetGroupId = viewed ? (viewed.groupId || null) : null;
    if (!viewed) {
        if (state.memo.targetGroupId && memoGroupById(state.memo.targetGroupId)) {
            targetGroupId = state.memo.targetGroupId;
        } else if (!state.novelId) {
            targetGroupId = state.memo.groups[0]?.id || null;
        }
    }
    if (!state.novelId && !targetGroupId) {
        toast('先打开一本小说或新建一个分组', 'warning');
        return;
    }
    state.memo.viewingId = null;
    state.memo.editingId = null;
    state.memo.composing = true;
    state.memo.targetGroupId = targetGroupId;
    state.memo.anchor = null;
    clearMemoForm();
    renderMemoPanel();
    elements.memoTitle?.focus();
}

async function viewMemo(id) {
    const memo = getMemoById(id);
    if (!memo) return;
    if (state.memo.editingId === memo.id) {
        elements.memoContent?.focus({ preventScroll: true });
        return;
    }
    if (memoEditorHasUnsavedChanges()) {
        const ok = await confirmAction('当前备忘还有未保存的修改，要放弃并查看另一条吗？');
        if (!ok) return;
    }
    state.memo.viewingId = memo.id;
    state.memo.editingId = null;
    state.memo.composing = false;
    state.memo.anchor = null;
    ensureMemoNodeExpanded(memo);
    renderMemoPanel();
    elements.memoView?.scrollIntoView({ block: 'nearest' });
}

async function editMemo(id) {
    const memo = getMemoById(id);
    if (!memo) return;
    if (state.memo.editingId === memo.id) return;
    if (memoEditorHasUnsavedChanges()) {
        const ok = await confirmAction('当前备忘还有未保存的修改，要编辑另一条吗？');
        if (!ok) return;
    }
    state.memo.viewingId = memo.id;
    state.memo.editingId = memo.id;
    state.memo.composing = false;
    state.memo.targetGroupId = memo.groupId || null;
    state.memo.anchor = !memo.groupId && Number.isInteger(memo.chapterIndex)
        ? { chapterIndex: memo.chapterIndex, page: Number.isInteger(memo.page) ? memo.page : 0 }
        : null;
    ensureMemoNodeExpanded(memo);
    if (elements.memoTitle) elements.memoTitle.value = memo.title || '';
    if (elements.memoContent) elements.memoContent.value = memo.content || '';
    renderMemoPanel();
    elements.memoEditor?.scrollIntoView({ block: 'nearest' });
    elements.memoContent?.focus({ preventScroll: true });
}

function attachMemoToCurrentPosition() {
    if (!state.novelId) {
        toast('先打开一本小说', 'warning');
        return;
    }
    if (memoGroupById(state.memo.targetGroupId)) {
        toast('分组备忘不绑定阅读位置', 'warning');
        return;
    }
    if (!state.reader.loaded || !state.chapters.length) {
        toast('先在阅读页打开一章，再关联位置', 'warning');
        return;
    }
    state.memo.anchor = { chapterIndex: state.reader.index, page: state.reader.page };
    renderMemoEditorState();
    toast('已关联当前阅读位置');
}

function syncMemoIndicators() {
    const total = state.memo.novelMemos.length + state.memo.groupMemos.length;
    if (elements.memoTabBadge) {
        elements.memoTabBadge.textContent = total > 99 ? '99+' : String(total);
        elements.memoTabBadge.hidden = total === 0;
    }
    syncMemoQuickCount();
}

function syncMemoQuickCount() {
    if (!elements.memoQuickCount) return;
    let count = 0;
    if (state.novelId && state.reader.loaded) {
        count = state.memo.novelMemos.filter(memo => memo.chapterIndex === state.reader.index).length;
    }
    elements.memoQuickCount.textContent = count > 99 ? '99+' : String(count);
    elements.memoQuickCount.hidden = count === 0;
    if (elements.memoQuick) {
        elements.memoQuick.title = count
            ? `本章有 ${count} 条备忘，点这里记一条`
            : '为当前阅读位置记一条备忘';
    }
}

/** 阅读页工具栏「备忘」：切到备忘页，并带上当前章节 / 页码 */
async function startMemoFromReader() {
    if (!state.novelId || !state.chapters.length) {
        toast('先打开一本小说', 'warning');
        return;
    }
    if (!state.reader.loaded) {
        toast('先打开一章再记备忘', 'warning');
        return;
    }
    const dirty = memoEditorHasUnsavedChanges();
    if (dirty) {
        const ok = await confirmAction('当前备忘还有未保存的修改，要清空并记到当前位置吗？');
        if (!ok) return;
    }

    state.memo.targetGroupId = null;
    state.memo.viewingId = null;
    state.memo.editingId = null;
    state.memo.composing = true;
    state.memo.anchor = { chapterIndex: state.reader.index, page: state.reader.page };
    state.memo.query = '';
    state.memo.pinnedOnly = false;
    exitMemoBatch();
    elements.memoFilter.value = '';
    elements.memoPinned.checked = false;
    clearMemoForm();
    showTab('memo');
    renderMemoPanel();
    setTimeout(() => {
        elements.memoEditor?.scrollIntoView({ block: 'nearest' });
        elements.memoContent?.focus({ preventScroll: true });
    }, 40);
    toast('已记下当前阅读位置，写下要留的话吧', 'info');
}

async function persistMemoEditor() {
    if (!state.memo.editingId && !state.memo.composing) return;
    const targetGroup = memoGroupById(state.memo.targetGroupId);
    if (!targetGroup && !state.novelId) {
        toast('先打开一本小说或创建分组', 'warning');
        return;
    }
    if (state.memo.saving) return;
    const sanitized = sanitizeMemoInput({
        title: elements.memoTitle?.value || '',
        content: elements.memoContent?.value || '',
    });
    if (!sanitized.content) {
        toast('先写点内容再保存', 'warning');
        elements.memoContent?.focus();
        return;
    }
    if (sanitized.truncated) {
        toast(`正文超过 ${MEMO_MAX_CHARS} 字，已按上限截断`, 'warning');
    }

    const title = sanitized.title || memoTitleFromContent(sanitized.content) || '未命名备忘';
    const groupId = targetGroup ? targetGroup.id : null;
    const novelId = groupId ? null : state.novelId;
    const anchor = state.memo.anchor;
    const chapterIndex = groupId || !anchor || !Number.isInteger(anchor.chapterIndex) ? null : anchor.chapterIndex;
    const page = chapterIndex === null ? null : (Number.isInteger(anchor.page) ? anchor.page : 0);
    const now = Date.now();
    const editing = Boolean(state.memo.editingId);
    let record;
    if (editing) {
        const current = getMemoById(state.memo.editingId);
        if (!current) {
            clearMemoSelection();
            toast('这条备忘已经不存在了', 'error');
            return;
        }
        record = {
            ...current,
            novelId,
            groupId,
            title,
            content: sanitized.content,
            chapterIndex,
            page,
            updatedAt: now,
        };
    } else {
        record = {
            id: uuid(),
            novelId,
            groupId,
            title,
            content: sanitized.content,
            chapterIndex,
            page,
            pinned: false,
            createdAt: now,
            updatedAt: now,
        };
    }

    state.memo.saving = true;
    renderMemoEditorState();
    try {
        await saveMemo(record);
        state.memo.novelMemos = state.memo.novelMemos.filter(memo => memo.id !== record.id);
        state.memo.groupMemos = state.memo.groupMemos.filter(memo => memo.id !== record.id);
        if (record.groupId) state.memo.groupMemos = [record, ...state.memo.groupMemos];
        else state.memo.novelMemos = [record, ...state.memo.novelMemos];
    } catch (error) {
        state.memo.saving = false;
        renderMemoEditorState();
        throw error;
    }
    state.memo.saving = false;
    state.memo.viewingId = record.id;
    state.memo.editingId = null;
    state.memo.composing = false;
    state.memo.anchor = null;
    state.memo.targetGroupId = record.groupId;
    ensureMemoNodeExpanded(record);
    clearMemoForm();
    renderMemoPanel();
    renderChapterList();
    toast(editing ? '备忘已更新' : '备忘已保存', 'success');
}

async function deleteMemoItem(id) {
    const memo = getMemoById(id);
    if (!memo) return;
    if (!(await confirmAction(`确定删除备忘「${memoTitle(memo)}」？`))) return;
    await deleteMemo(id);
    state.memo.novelMemos = state.memo.novelMemos.filter(item => item.id !== id);
    state.memo.groupMemos = state.memo.groupMemos.filter(item => item.id !== id);
    state.memo.batchSelection.delete(id);
    if (state.memo.viewingId === id || state.memo.editingId === id) clearMemoSelection();
    renderMemoPanel();
    renderChapterList();
    toast('备忘已删除');
}

async function toggleMemoPin(id) {
    const memo = getMemoById(id);
    if (!memo) return;
    const next = { ...memo, pinned: !memo.pinned };
    await saveMemo(next);
    state.memo.novelMemos = state.memo.novelMemos.map(item => item.id === id ? next : item);
    state.memo.groupMemos = state.memo.groupMemos.map(item => item.id === id ? next : item);
    renderMemoPanel();
    toast(next.pinned ? '已置顶' : '已取消置顶');
}

async function copyMemo(id) {
    const memo = getMemoById(id);
    if (!memo) return;
    const ok = await copyText(memoClipboardText(memo));
    toast(ok ? '已复制备忘内容（不含标题）' : '复制失败，请手动选择文本', ok ? 'success' : 'error');
}


function toggleMemoBatch() {
    if (state.memo.batchMode) {
        exitMemoBatch();
        renderMemoPanel();
        return;
    }
    const matching = getMemoMatchingList();
    if (!matching.length) {
        toast('当前没有可删除的备忘', 'info');
        return;
    }
    state.memo.batchMode = true;
    state.memo.batchSelection = new Set();
    state.memo.collapsedNodes.clear();
    persistMemoCollapsedNodes();
    renderMemoPanel();
}

function exitMemoBatch() {
    state.memo.batchMode = false;
    state.memo.batchSelection = new Set();
}

function toggleMemoSelection(id) {
    if (!state.memo.batchSelection.has(id)) {
        state.memo.batchSelection.add(id);
    } else {
        state.memo.batchSelection.delete(id);
    }
    renderMemoPanel();
}

function setMemoSelection(id, checked) {
    if (checked) state.memo.batchSelection.add(id);
    else state.memo.batchSelection.delete(id);
    renderMemoPanel();
}

async function deleteSelectedMemos() {
    const ids = [...state.memo.batchSelection];
    if (!ids.length) return;
    if (!(await confirmAction(`确定删除选中的 ${ids.length} 条备忘？此操作不可恢复。`))) return;
    await deleteMemos(ids);
    state.memo.novelMemos = state.memo.novelMemos.filter(memo => !state.memo.batchSelection.has(memo.id));
    state.memo.groupMemos = state.memo.groupMemos.filter(memo => !state.memo.batchSelection.has(memo.id));
    if ((state.memo.viewingId && state.memo.batchSelection.has(state.memo.viewingId))
        || (state.memo.editingId && state.memo.batchSelection.has(state.memo.editingId))) {
        clearMemoSelection();
    }
    const count = ids.length;
    exitMemoBatch();
    renderMemoPanel();
    renderChapterList();
    toast(`已删除 ${count} 条备忘`, 'success');
}

async function jumpToMemo(id) {
    const memo = getMemoById(id);
    if (!memo) return;
    if (memo.groupId) {
        toast('分组备忘不绑定阅读位置', 'info');
        return;
    }
    if (memo.novelId && memo.novelId !== state.novelId) {
        toast('这条备忘属于另一本小说', 'warning');
        return;
    }
    if (!Number.isInteger(memo.chapterIndex)) {
        toast('这条备忘没有关联章节', 'info');
        return;
    }
    if (!state.chapters.some(chapter => chapter.index === memo.chapterIndex)) {
        toast('这条备忘关联的章节已经不存在了', 'warning');
        return;
    }
    await openChapter(memo.chapterIndex, Number.isInteger(memo.page) ? memo.page : 0);
    showTab('reader');
}

async function backToReaderFromMemo() {
    if (!state.novelId) return;
    const editing = Boolean(state.memo.editingId || state.memo.composing);
    const viewed = state.memo.viewingId ? getMemoById(state.memo.viewingId) : null;
    const anchor = editing
        ? state.memo.anchor
        : viewed && !viewed.groupId && Number.isInteger(viewed.chapterIndex)
            ? { chapterIndex: viewed.chapterIndex, page: viewed.page }
            : null;
    if (anchor && Number.isInteger(anchor.chapterIndex)
        && state.chapters.some(chapter => chapter.index === anchor.chapterIndex)) {
        await openChapter(anchor.chapterIndex, Number.isInteger(anchor.page) ? anchor.page : 0);
    }
    showTab('reader');
}

function exportMemos() {
    const current = state.memo.viewingId ? getMemoById(state.memo.viewingId) : null;
    let group = current?.groupId ? memoGroupById(current.groupId) : null;
    if (!group && !current && state.memo.groups.length && !state.novelId) {
        group = state.memo.groups[0];
    }
    const memos = group
        ? state.memo.groupMemos.filter(memo => memo.groupId === group.id)
        : state.memo.novelMemos;
    if (!memos.length) {
        toast('当前范围没有备忘可以导出', 'warning');
        return;
    }
    const text = buildMemoExportMarkdown({
        novelTitle: group ? group.name : (state.novel?.title || '小说'),
        memos,
        chapters: group ? [] : state.chapters,
        groupMode: Boolean(group),
    });
    const baseName = group ? group.name : (state.novel?.title || '小说');
    downloadText(`${safeFileName(baseName)}-备忘.md`, text);
    toast(`已导出 ${memos.length} 条备忘`, 'success');
}

/* -------------------------- 分组管理 -------------------------- */

function openMemoGroupDialog(group = null) {
    const editingGroup = group && memoGroupById(group.id) ? group : null;
    const title = editingGroup ? `重命名分组「${editingGroup.name}」` : '新建备忘分组';
    const body = `
        <label class="nr-field">
            <span>分组名称</span>
            <input id="nr-memo-group-name" class="nr-input" maxlength="40"
                placeholder="例如：伏笔、人物设定、待查线索" value="${escapeHtml(editingGroup?.name || '')}">
        </label>
        <p class="nr-help">分组备忘保存在本机，不跟随小说；删除小说或清空小说数据都不会删除分组。</p>
    `;
    const footer = `
        <button type="button" class="nr-btn" data-memo-group-act="cancel">取消</button>
        <button type="button" class="nr-btn nr-primary" data-memo-group-act="save">${editingGroup ? '保存' : '创建'}</button>
    `;
    openWorldbookDialog({
        title,
        body,
        footer,
        kind: 'memo',
        onMount: ctx => {
            const input = ctx.body.querySelector('#nr-memo-group-name');
            const saveButton = ctx.foot.querySelector('[data-memo-group-act="save"]');
            const close = () => ctx.close();
            const save = async () => {
                if (saveButton.disabled) return;
                const name = String(input?.value || '').replace(/\s+/g, ' ').trim().slice(0, 40);
                if (!name) {
                    toast('先输入分组名称', 'warning');
                    input?.focus();
                    return;
                }
                const duplicate = state.memo.groups.some(item =>
                    item.id !== editingGroup?.id && item.name.toLowerCase() === name.toLowerCase());
                if (duplicate) {
                    toast(`已经有同名分组「${name}」了`, 'warning');
                    input?.focus();
                    return;
                }
                const now = Date.now();
                let record;
                if (editingGroup) {
                    record = { ...editingGroup, name, updatedAt: now };
                } else {
                    const maxOrder = state.memo.groups.reduce((max, item) => Math.max(max, item.order || 0), 0);
                    record = {
                        id: uuid(),
                        name,
                        order: maxOrder + 1,
                        createdAt: now,
                        updatedAt: now,
                    };
                }
                saveButton.disabled = true;
                try {
                    await saveMemoGroup(record);
                } catch (error) {
                    saveButton.disabled = false;
                    toast(`保存分组失败：${error.message}`, 'error');
                    return;
                }
                if (editingGroup) {
                    state.memo.groups = sortMemoGroups(state.memo.groups.map(item => item.id === record.id ? record : item));
                } else {
                    state.memo.groups = sortMemoGroups([...state.memo.groups, record]);
                    if (!state.memo.editingId && !state.memo.composing) {
                        state.memo.targetGroupId = record.id;
                    }
                }
                close();
                renderMemoPanel();
                toast(editingGroup ? '分组已重命名' : `已创建分组「${record.name}」`, 'success');
            };
            ctx.foot.querySelector('[data-memo-group-act="cancel"]').addEventListener('click', close);
            saveButton.addEventListener('click', save);
            input?.addEventListener('keydown', event => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    save();
                }
            });
            setTimeout(() => {
                input?.focus();
                input?.select();
            }, 30);
        },
    });
}

async function deleteMemoGroupItem(group) {
    if (!group) return;
    const count = memoGroupMemoCount(group.id);
    const message = count
        ? `删除分组「${group.name}」以及其中的 ${count} 条备忘？此操作不可恢复。`
        : `删除分组「${group.name}」？`;
    if (!(await confirmAction(message))) return;
    await deleteMemoGroup(group.id);
    state.memo.groups = state.memo.groups.filter(item => item.id !== group.id);
    state.memo.groupMemos = state.memo.groupMemos.filter(memo => memo.groupId !== group.id);
    state.memo.collapsedNodes.delete(`group:${group.id}`);
    persistMemoCollapsedNodes();
    if (state.memo.targetGroupId === group.id) {
        state.memo.targetGroupId = state.novelId ? null : (state.memo.groups[0]?.id || null);
    }
    if ((state.memo.viewingId && !getMemoById(state.memo.viewingId))
        || (state.memo.editingId && !getMemoById(state.memo.editingId))) {
        clearMemoSelection();
    }
    if (state.memo.composing && !state.memo.targetGroupId && !state.novelId) {
        state.memo.composing = false;
        clearMemoForm();
    }
    renderMemoPanel();
    renderChapterList();
    toast('分组已删除');
}

/* ------------------------------------------------------------------ */
/* 总结：章节选择                                                      */
/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/* 总结：章节选择                                                      */
/* ------------------------------------------------------------------ */

function renderSummaryChapters() {
    if (!elements.summaryChapters) return;
    const filter = (elements.summaryFilter.value || '').trim().toLowerCase();
    const scope = getScope();
    const isAllScope = scope === 'all';

    elements.summaryChapters.replaceChildren();
    if (!state.chapters.length) {
        elements.summaryChapters.appendChild(createElement('div', 'nr-list-empty', '暂无章节'));
        elements.selectCount.textContent = '已选 0 章';
        return;
    }

    const fragment = document.createDocumentFragment();
    let count = 0;
    for (const chapter of state.chapters) {
        if (chapter.isVolume) continue;
        if (filter && !chapter.title.toLowerCase().includes(filter)) continue;
        const label = createElement('label', 'nr-check-item');
        label.dataset.chapterIndex = String(chapter.index);
        if (isAllScope) label.classList.add('is-ignored');

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.dataset.index = String(chapter.index);
        checkbox.checked = state.selection.has(chapter.index);
        checkbox.disabled = isAllScope;

        const title = createElement('span', 'nr-check-title', chapter.title);
        title.title = chapter.title;
        const countText = createElement('em', 'nr-check-count', `${formatCount(chapter.charCount)} 字`);
        label.append(checkbox, title, countText);
        fragment.appendChild(label);
        count++;
    }
    if (count === 0) {
        elements.summaryChapters.appendChild(createElement('div', 'nr-list-empty', '没有匹配的章节'));
    } else {
        elements.summaryChapters.appendChild(fragment);
    }
    elements.selectCount.textContent = isAllScope
        ? `整本 · ${state.chapters.length} 章`
        : `已选 ${state.selection.size} 章`;
}

function updateBudgetInfo() {
    if (!elements.budget) return;
    if (!state.novelId || !state.chapters.length) {
        elements.budget.textContent = '请先在书架中打开一本小说。';
        elements.run.disabled = true;
        return;
    }

    const settings = getSettings();
    const scope = getScope();
    const selected = scope === 'all' ? state.chapters : getSelectedMeta();
    const totalChars = selected.reduce((sum, chapter) => sum + (chapter.charCount || 0), 0);
    const totalTokens = Math.ceil(totalChars * 1.15);
    const budget = computeBudget(settings);
    const requested = getTargetChars();
    const maxTarget = maxTargetChars(settings);
    const effectiveTarget = Math.max(60, Math.min(requested, maxTarget, Math.ceil(totalChars * 0.9)));

    const strategy = resolveStrategy(settings);
    const direct = totalTokens + 320 <= budget.inputBudget * 0.97;
    const segmentBudget = Math.max(300, Math.floor((budget.inputBudget - 320) * strategy.packRatio));
    const estimatedCalls = direct
        ? 1
        : Math.ceil(totalTokens / Math.max(300, segmentBudget)) + 2;

    const parts = [
        `已选 ${selected.length} 章 · 约 ${formatCount(totalChars)} 字`,
        `上下文 ${formatCount(budget.ctxTokens)} tokens · 输入预算 ${formatCount(budget.inputBudget)}`,
        `目标上限 ${formatCount(effectiveTarget)} 字`,
        `模式：${SUMMARY_MODE_PRESETS[settings.summaryMode]?.label || '均衡'}`,
        direct ? '策略：单次直接总结' : `策略：分段总结（预计约 ${estimatedCalls} 次请求）`,
    ];
    if (requested > maxTarget) {
        parts.push(`⚠ 目标超过当前上下文可输出范围，实际将限制为 ${formatCount(maxTarget)} 字`);
    }
    if (effectiveTarget < requested && effectiveTarget === Math.ceil(totalChars * 0.9)) {
        parts.push('ℹ 原文较短，目标已按原文体量自动收缩');
    }
    elements.budget.textContent = parts.join(' · ');

    elements.run.disabled = state.summary.running || selected.length === 0;
    if (state.summary.running) elements.run.disabled = true;
}

/* ------------------------------------------------------------------ */
/* 总结：执行                                                          */
/* ------------------------------------------------------------------ */

async function startSummary({ retrySummary = null } = {}) {
    if (state.summary.running) return;
    if (state.worldbook.running) {
        toast('世界书正在生成，请等它结束或先停止', 'warning');
        return;
    }
    if (!state.novelId || !state.chapters.length) {
        toast('请先打开一本小说', 'warning');
        return;
    }
    const retryRun = retrySummary?.runOptions || null;
    const baseSettings = getSettings();
    const settings = retryRun?.settings
        ? { ...baseSettings, ...retryRun.settings, reuseParts: true }
        : baseSettings;
    const scope = retrySummary?.scope || getScope();
    const scopeIndices = Array.isArray(retrySummary?.chapterIndices) ? retrySummary.chapterIndices : null;
    const metaByIndex = new Map(state.chapters.map(chapter => [chapter.index, chapter]));
    const selected = retrySummary && scopeIndices?.length
        ? scopeIndices.map(index => metaByIndex.get(index)).filter(Boolean)
        : scope === 'all' ? state.chapters : getSelectedMeta();
    if (selected.length === 0) {
        toast(retrySummary ? '这本书的章节已变化，无法补全旧总结' : '请至少选择一章', 'warning');
        return;
    }

    // 总结期间即使切了书，也要把结果和备忘写回开始总结时的那一本
    const summaryNovelId = state.novelId;
    const summaryNovelTitle = state.novel?.title || '未命名小说';
    const targetChars = Number(retryRun?.targetChars || retrySummary?.requestedTarget || retrySummary?.targetChars || 0) || getTargetChars();
    const styleKey = retryRun?.styleKey || retrySummary?.style || elements.style.value || settings.style || 'plot';
    const extraValue = (elements.extra.value || '').trim();
    const customStyle = retryRun?.customStyle ?? (styleKey === 'custom' ? extraValue : '');
    const extraInstruction = retryRun?.extraInstruction ?? (styleKey === 'custom' ? '' : extraValue);

    // 成本预警：请求数较多时让用户确认；补失败段通常只补几段，不重复确认
    const totalChars = selected.reduce((sum, chapter) => sum + (chapter.charCount || 0), 0);
    const budget = computeBudget(settings);
    const direct = Math.ceil(totalChars * 1.15) + 320 <= budget.inputBudget * 0.95;
    const estimatedCalls = direct ? 1 : Math.ceil((totalChars * 1.15) / Math.max(400, budget.inputBudget * 0.8)) + 2;
    if (!retrySummary && estimatedCalls > 40) {
        const ok = await confirmAction(
            `这次总结预计需要约 ${estimatedCalls} 次模型请求（原文约 ${formatCount(totalChars)} 字）。继续吗？`,
        );
        if (!ok) return;
    }

    state.summary.running = true;
    state.summary.abort = new AbortController();
    state.summary.result = null;
    elements.run.disabled = true;
    elements.stop.hidden = false;
    elements.result.hidden = true;
    elements.progress.hidden = false;
    elements.progressBar.style.width = '0%';
    elements.progressPct.textContent = '0%';
    elements.progressText.textContent = '正在准备…';
    elements.log.replaceChildren();
    setHeaderStatus('总结中…');
    orb.classList.add('nr-orb-busy');

    const log = (message) => {
        const line = createElement('div', 'nr-log-line', `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${message}`);
        elements.log.appendChild(line);
        elements.log.scrollTop = elements.log.scrollHeight;
    };

    try {
        log(retrySummary
            ? `补全失败段：${retrySummary.novelTitle || state.novel?.title || ''}，共 ${selected.length} 章；字数上限 ${targetChars} 字`
            : `范围：${scope === 'all' ? '整本' : '选中章节'}，共 ${selected.length} 章；字数上限 ${targetChars} 字`);

        // 读取所选章节正文
        const indices = selected.map(chapter => chapter.index);
        const metaByIndex = new Map(state.chapters.map(chapter => [chapter.index, chapter]));
        const chapters = [];
        for (let i = 0; i < indices.length; i++) {
            const index = indices[i];
            const meta = metaByIndex.get(index);
            const text = await getChapterContent(summaryNovelId, index);
            if (text) chapters.push({ index, title: meta?.title || `第 ${index + 1} 章`, text });
            if (i % 3 === 0 || i === indices.length - 1) {
                const percent = Math.round(((i + 1) / indices.length) * 8);
                elements.progressBar.style.width = `${percent}%`;
                elements.progressPct.textContent = `${percent}%`;
                elements.progressText.textContent = `正在读取章节 ${i + 1}/${indices.length}…`;
            }
            await yieldToUI();
        }
        if (chapters.length === 0) throw new Error('所选章节没有正文内容');

        const scopeLabel = retryRun?.scopeLabel || (scope === 'all'
            ? `整本（第 1～${state.chapters.length} 章）`
            : `选中章节（${chapters.length} 章，第 ${chapters[0].index + 1}～${chapters[chapters.length - 1].index + 1} 章）`);

        const result = await runSummary({
            novelId: summaryNovelId,
            novelTitle: summaryNovelTitle,
            chapters,
            targetChars,
            styleKey,
            customStyle,
            extraInstruction,
            scopeLabel,
            settings,
            cache: settings.reuseParts
                ? {
                    get: key => getSummaryPart(key),
                    getMany: keys => getSummaryParts(keys),
                    put: part => putSummaryPart(part),
                }
                : null,
            signal: state.summary.abort.signal,
            onProgress: event => {
                if (!event || typeof event !== 'object') return;
                switch (event.type) {
                    case 'plan': {
                        log(`策略：${event.plan.mode === 'direct' ? '单次直接总结' : `分段总结（${event.plan.groups.length} 段，并发 ${event.stats.concurrency}）`}；预计 ${event.plan.estimatedCalls} 次请求`);
                        log(`输入预算 ${event.budget.inputBudget} tokens，原文约 ${event.plan.totalTokens} tokens`);
                        elements.progressBar.style.width = '8%';
                        elements.progressPct.textContent = '8%';
                        break;
                    }
                    case 'stage':
                        elements.progressText.textContent = event.text || '处理中…';
                        log(event.text || '');
                        if (event.stage === 'group-failed') {
                            const failedCount = Number(event.failedCount) || 0;
                            const remaining = Number(event.remainingGroups) || 0;
                            log(`（已失败 ${failedCount} 段，还有 ${remaining} 段待处理；完成后可在历史总结里点「补充失败段」）`);
                            if (remaining > 0) {
                                elements.progressText.textContent = `分段失败，跳过并继续：已失败 ${failedCount} 段，剩余 ${remaining} 段`;
                            }
                        }
                        break;
                    case 'call':
                        elements.progressText.textContent = `正在请求：${event.label}${event.maxAttempts > 1 ? `（第 ${event.attempt} 次尝试）` : ''}`;
                        break;
                    case 'progress': {
                        const percent = clamp(event.percent || 0, 0, 99);
                        elements.progressBar.style.width = `${percent}%`;
                        elements.progressPct.textContent = `${percent}%`;
                        break;
                    }
                    case 'done': {
                        elements.progressBar.style.width = '100%';
                        elements.progressPct.textContent = '100%';
                        elements.progressText.textContent = '完成';
                        break;
                    }
                    default:
                        break;
                }
            },
        });

        const summaryChapterIndices = chapters.map(chapter => chapter.index);
        state.summary.result = {
            ...result,
            novelId: summaryNovelId,
            novelTitle: summaryNovelTitle,
            chapterIndices: summaryChapterIndices,
            chapterCount: summaryChapterIndices.length,
            scopeLabel,
            memoAddedId: null,
        };
        renderResult(state.summary.result);
        elements.result.hidden = false;
        elements.progress.hidden = true;
        elements.progressBar.style.width = '100%';
        log(`完成：${result.stats.outputChars} 字，${result.stats.calls} 次请求（复用 ${result.stats.cacheHits || 0} 段），用时 ${(result.stats.elapsedMs / 1000).toFixed(1)} 秒`);
        if (result.truncated) log('结果超过字数上限，已在句末截断。');
        if (result.capped) log(`目标字数超过可输出范围，实际上限为 ${result.targetChars} 字。`);
        if (result.incomplete) {
            log(`注意：${result.failedLabels.length} 段失败被跳过（${result.failedLabels.join('；')}）。结果不完整；历史总结里已保留这条记录，点「补充失败段」即可复用成功段、只补失败段。`);
        }
        if (result.finalFallback) log('最终成稿请求失败，当前结果是分段摘要拼接；可在历史总结里点「重试成稿」。');

        if (retrySummary || (baseSettings.keepSummaries && !result.cached)) {
            const now = Date.now();
            const summary = {
                id: retrySummary?.id || uuid(),
                novelId: summaryNovelId,
                novelTitle: summaryNovelTitle,
                scope,
                chapterIndices: summaryChapterIndices,
                chapterCount: summaryChapterIndices.length,
                targetChars: result.targetChars,
                requestedTarget: result.requestedTarget,
                style: styleKey,
                mode: result.mode,
                text: result.text,
                truncated: result.truncated,
                incomplete: result.incomplete,
                failedLabels: result.failedLabels,
                finalFallback: result.finalFallback,
                stats: result.stats,
                createdAt: retrySummary?.createdAt || now,
                updatedAt: now,
                runOptions: {
                    targetChars: result.requestedTarget,
                    styleKey,
                    customStyle,
                    extraInstruction,
                    scopeLabel,
                    settings: {
                        provider: settings.provider,
                        profileId: settings.profileId,
                        contextTokens: settings.contextTokens,
                        contextRatio: settings.contextRatio,
                        outputReserve: settings.outputReserve,
                        minMidChars: settings.minMidChars,
                        maxAttempts: settings.maxAttempts,
                        summaryMode: settings.summaryMode,
                        mapConcurrency: settings.mapConcurrency,
                        reuseParts: settings.reuseParts,
                    },
                },
            };
            try {
                await replaceSummary(summary);
                await refreshHistory();
            } catch (error) {
                console.warn('[小说阅读器] 保存总结失败', error);
            }
        }

        if (result.incomplete) {
            const reason = result.finalFallback
                ? '最终成稿失败，已回退为分段摘要'
                : `${result.failedLabels.length} 段失败，已用其余内容生成`;
            toast(`总结部分完成：${reason}`, 'warning');
            setHeaderStatus(result.failedLabels.length ? `部分完成 · ${result.failedLabels.length} 段失败` : '部分完成');
        } else {
            toast(`总结完成：${result.stats.outputChars} 字`, 'success');
            setHeaderStatus('完成');
        }
    } catch (error) {
        if (error?.name === 'AbortError' || /已取消|cancelled|aborted/i.test(String(error?.message))) {
            elements.progressText.textContent = '已停止';
            log('用户停止了本次总结。');
            toast('已停止总结', 'info');
        } else {
            console.error('[小说阅读器] 总结失败', error);
            elements.progressText.textContent = `失败：${error.message}`;
            log(`失败：${error.message}`);
            toast(`总结失败：${error.message}`, 'error');
        }
        setHeaderStatus('失败');
    } finally {
        state.summary.running = false;
        state.summary.abort = null;
        elements.run.disabled = false;
        elements.stop.hidden = true;
        orb.classList.remove('nr-orb-busy');
        updateBudgetInfo();
        updateSummaryMemoButton();
    }
}

function stopSummary() {
    if (!state.summary.running) return;
    elements.stop.disabled = true;
    elements.progressText.textContent = '正在停止（等待当前请求结束）…';
    state.summary.abort?.abort();
    try {
        getContext()?.stopGeneration?.();
    } catch (error) {
        console.warn('[小说阅读器] 停止生成失败', error);
    }
    setTimeout(() => { elements.stop.disabled = false; }, 1500);
}

/* ------------------------------------------------------------------ */
/* 总结结果                                                            */
/* ------------------------------------------------------------------ */

function closeResult() {
    elements.result.hidden = true;
    elements.progress.hidden = true;
}

function summaryChapterRangeLabel(result) {
    const raw = Array.isArray(result?.chapterIndices) ? result.chapterIndices : [];
    const indices = [...new Set(raw.map(Number).filter(Number.isInteger))].sort((a, b) => a - b);
    if (indices.length === 1) return `第 ${indices[0] + 1} 章`;
    if (indices.length > 1) {
        const contiguous = indices.every((value, index) => index === 0 || value === indices[index - 1] + 1);
        if (contiguous) return `第 ${indices[0] + 1}～${indices[indices.length - 1] + 1} 章`;
        if (indices.length <= 5) return `第 ${indices.map(index => index + 1).join('、')} 章`;
        return `第 ${indices[0] + 1}～${indices[indices.length - 1] + 1} 章（选中 ${indices.length} 章）`;
    }

    const scope = String(result?.scopeLabel || '');
    const range = scope.match(/第\s*(\d+)\s*[-～~至—]\s*(\d+)\s*章/);
    if (range) return `第 ${range[1]}～${range[2]} 章`;
    const single = scope.match(/第\s*(\d+)\s*章/);
    if (single) return `第 ${single[1]} 章`;
    const count = Number(result?.chapterCount);
    if (Number.isFinite(count) && count > 0) return `共 ${count} 章`;
    return '总结';
}

/** 从总结正文开头提取一句短概述，作为备忘标题的后半段 */
function summaryOverview(text, maxChars = 40) {
    const clean = String(text || '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/\*\*/g, '')
        .replace(/^#{1,6}\s*/gm, '')
        .replace(/^\s*[-*+]\s+/gm, '')
        .replace(/^\s*>\s?/gm, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!clean) return '总结';

    const firstSentence = (clean.match(/^.*?[。！？!?]/) || [clean])[0].trim();
    let overview = firstSentence
        .replace(/^(?:总结|概述|故事梗概|内容概要|摘要)[：:\s]+/, '')
        .trim();
    if (!overview) overview = firstSentence;
    if (countChars(overview) > maxChars) {
        overview = `${trimToLimit(overview, maxChars).replace(/[，、；：,;:。！？!?…]+$/, '')}…`;
    }
    return overview || '总结';
}

function buildSummaryMemoTitle(result) {
    const range = summaryChapterRangeLabel(result);
    const overview = summaryOverview(result?.text);
    const title = range === '总结' ? overview : `${range} · ${overview}`;
    return sanitizeMemoInput({ title, content: '' }).title || '总结';
}

function updateSummaryMemoButton(result = state.summary.result) {
    const button = elements.resultMemo;
    if (!button) return;
    const hasText = Boolean(String(result?.text || '').trim());
    const novelId = result?.novelId || state.novelId;
    const added = Boolean(result?.memoAddedId);
    const busy = state.summary.addingMemo || state.summary.running;
    button.disabled = busy || !hasText || !novelId || added;
    button.textContent = added ? '已添加到备忘' : busy ? '添加中…' : '添加到备忘';
    button.title = added ? '这段总结已经加过备忘' : '把总结内容加入对应小说的备忘';
}

/** 把当前总结写进对应小说的「本书备忘」：标题=章节区间+开头概述，正文=完整总结 */
async function addSummaryToMemo() {
    const result = state.summary.result;
    if (!result || state.summary.addingMemo) return;
    if (result.memoAddedId) {
        toast('这段总结已经添加到备忘', 'info');
        return;
    }
    const novelId = result.novelId || state.novelId;
    if (!novelId) {
        toast('这段总结没有对应的小说', 'warning');
        return;
    }
    const sanitized = sanitizeMemoInput({
        title: buildSummaryMemoTitle(result),
        content: result.text || '',
    });
    if (!sanitized.content) {
        toast('总结内容为空，无法添加', 'warning');
        return;
    }

    state.summary.addingMemo = true;
    updateSummaryMemoButton(result);
    try {
        const now = Date.now();
        const record = normalizeMemoRecord({
            id: uuid(),
            novelId,
            groupId: null,
            title: sanitized.title || '总结',
            content: sanitized.content,
            chapterIndex: null,
            page: null,
            pinned: false,
            createdAt: now,
            updatedAt: now,
        });
        await saveMemo(record);
        result.memoAddedId = record.id;

        try {
            if (state.novelId === novelId) {
                if (state.memo.loadedNovelId === novelId) {
                    state.memo.novelMemos = [
                        record,
                        ...state.memo.novelMemos.filter(memo => memo.id !== record.id),
                    ];
                    renderMemoPanel();
                    renderChapterList();
                } else {
                    await loadMemosForNovel(novelId, { force: true });
                    renderChapterList();
                }
                syncMemoIndicators();
            }
        } catch (error) {
            console.warn('[小说阅读器] 备忘已保存，但刷新备忘页失败', error);
        }

        toast(`已添加到《${result.novelTitle || state.novel?.title || '当前小说'}》的备忘`, 'success');
        if (sanitized.truncated) {
            toast(`总结超过 ${MEMO_MAX_CHARS} 字，已截断后保存`, 'warning');
        }
    } finally {
        state.summary.addingMemo = false;
        updateSummaryMemoButton(result);
    }
}

function renderResult(result) {
    if (!elements.resultText) return;
    elements.resultText.textContent = result.text || '';
    const stats = result.stats || {};
    const modeLabel = result.mode === 'direct' ? '单次' : '分段合并';
    const truncated = result.truncated ? ' · 已截断' : '';
    const failedCount = result.failedLabels?.length || 0;
    const incompleteParts = [];
    if (result.incomplete) {
        incompleteParts.push('部分完成');
        if (failedCount) incompleteParts.push(`还有 ${failedCount} 段失败`);
        if (result.finalFallback) incompleteParts.push('最终成稿回退');
    }
    const incomplete = incompleteParts.length ? ` · ${incompleteParts.join(' · ')}` : '';
    const cached = stats.cacheHits ? ` · 复用 ${stats.cacheHits} 段` : '';
    elements.resultMeta.textContent = `${formatCount(stats.outputChars || countChars(result.text || ''))} 字 · ${modeLabel} · ${stats.calls || 0} 次请求${cached} · ${((stats.elapsedMs || 0) / 1000).toFixed(1)} 秒${truncated}${incomplete}`;
    updateSummaryMemoButton(result);
}

async function copyResult() {
    const text = state.summary.result?.text;
    if (!text) return;
    try {
        await navigator.clipboard.writeText(text);
        toast('已复制到剪贴板', 'success');
    } catch {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        textarea.remove();
        toast('已复制到剪贴板', 'success');
    }
}

function downloadResult() {
    const text = state.summary.result?.text;
    if (!text) return;
    const title = state.novel?.title || '小说总结';
    downloadText(`${safeFileName(title)}-总结.txt`, text);
}

function insertResult() {
    const text = state.summary.result?.text;
    if (!text) return;
    const textarea = document.querySelector('#send_textarea');
    if (!textarea) {
        copyResult();
        toast('没有找到酒馆输入框，已复制到剪贴板', 'warning');
        return;
    }
    const prefix = textarea.value.trim() ? `${textarea.value.trim()}\n\n` : '';
    textarea.value = `${prefix}${text}`;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.focus();
    toast('已插入输入框', 'success');
}

/* ------------------------------------------------------------------ */
/* 历史总结                                                            */
/* ------------------------------------------------------------------ */

async function retryFailedSegments(summary) {
    if (state.summary.running) return;
    if (summary.novelId !== state.novelId) {
        toast('请先在书架打开这本小说，再补全它的总结', 'warning');
        return;
    }
    await startSummary({ retrySummary: summary });
}

async function refreshHistory() {
    if (!elements.historyList) return;
    elements.historyList.replaceChildren();
    if (!state.novelId) {
        elements.historyCount.textContent = '';
        return;
    }
    let items = [];
    try {
        const all = await listSummaries(state.novelId);
        // 旧版本可能给同一本书留下多条记录：只保留最新一条，其余清理掉。
        items = all.slice(0, 1);
        for (const extra of all.slice(1)) {
            try {
                await deleteSummary(extra.id);
            } catch (error) {
                console.warn('[小说阅读器] 清理重复总结失败', error);
            }
        }
    } catch (error) {
        console.warn('[小说阅读器] 读取历史总结失败', error);
        return;
    }
    elements.historyCount.textContent = items.length ? '（1 条）' : '';
    if (items.length === 0) {
        elements.historyList.appendChild(createElement('div', 'nr-list-empty', '还没有总结记录'));
        return;
    }
    for (const summary of items) {
        const item = createElement('div', 'nr-history-item');
        const info = createElement('div', 'nr-history-info');
        const head = createElement('div', 'nr-history-head');
        head.appendChild(createElement('strong', null, `${formatCount(summary.targetChars)} 字`));
        const scopeText = summary.scope === 'all' ? '整本' : `${summary.chapterCount || 0} 章`;
        const failedCount = summary.failedLabels?.length || 0;
        const statusParts = [];
        if (summary.incomplete) {
            statusParts.push('部分完成');
            if (failedCount) statusParts.push(`还有 ${failedCount} 段失败`);
            if (summary.finalFallback) statusParts.push('最终成稿回退');
        }
        const statusText = statusParts.length ? ` · ${statusParts.join(' · ')}` : '';
        head.appendChild(createElement('span', 'nr-muted', `${scopeText}${statusText} · ${formatTime(summary.updatedAt || summary.createdAt)}`));
        info.appendChild(head);
        info.appendChild(createElement('div', 'nr-history-snippet', (summary.text || '').slice(0, 110) + ((summary.text || '').length > 110 ? '…' : '')));

        const actions = createElement('div', 'nr-history-actions');
        const view = createElement('button', 'nr-btn nr-btn-sm', '查看');
        view.type = 'button';
        view.addEventListener('click', () => {
            const chapterIndices = Array.isArray(summary.chapterIndices)
                ? summary.chapterIndices
                : summary.scope === 'all'
                    ? state.chapters.map(chapter => chapter.index)
                    : [];
            state.summary.result = {
                text: summary.text,
                truncated: summary.truncated,
                stats: summary.stats || {},
                mode: summary.mode || 'mapreduce',
                targetChars: summary.targetChars,
                incomplete: Boolean(summary.incomplete),
                failedLabels: summary.failedLabels || [],
                finalFallback: Boolean(summary.finalFallback),
                novelId: summary.novelId || state.novelId,
                novelTitle: summary.novelTitle || state.novel?.title || '',
                chapterIndices,
                chapterCount: summary.chapterCount || chapterIndices.length,
                scopeLabel: summary.runOptions?.scopeLabel
                    || (summary.scope === 'all' ? `整本（第 1～${state.chapters.length} 章）` : ''),
                memoAddedId: null,
            };
            renderResult(state.summary.result);
            elements.result.hidden = false;
            elements.result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            elements.progress.hidden = true;
        });
        if (summary.incomplete || summary.finalFallback) {
            const needsParts = (summary.failedLabels?.length || 0) > 0;
            const failedCount = summary.failedLabels?.length || 0;
            const retryLabel = needsParts
                ? `补充失败段（${failedCount}）`
                : summary.incomplete ? '补充失败段' : '重试成稿';
            const retry = createElement('button', 'nr-btn nr-btn-sm', retryLabel);
            retry.type = 'button';
            retry.setAttribute('aria-label', retryLabel);
            retry.title = needsParts
                ? '复用已成功的分段，只重新请求失败部分'
                : '复用已成功的分段，只重新生成最终成稿';
            retry.addEventListener('click', () => retryFailedSegments(summary));
            actions.append(retry);
        }
        const remove = createElement('button', 'nr-icon-btn nr-danger-text', '');
        remove.type = 'button';
        remove.title = '删除这条总结';
        remove.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
        remove.addEventListener('click', async () => {
            if (!(await confirmAction('删除这条总结记录？'))) return;
            await deleteSummary(summary.id);
            await refreshHistory();
        });
        actions.append(view, remove);
        item.append(info, actions);
        elements.historyList.appendChild(item);
    }
}

/* ------------------------------------------------------------------ */
/* 设置                                                                */
/* ------------------------------------------------------------------ */

function renderSettings() {
    const settings = getSettings();
    const ctxTokens = getContextTokens();

    elements.contextTokens.value = settings.contextTokens || 0;
    elements.contextRatio.value = Math.round((Number(settings.contextRatio) || 0.7) * 100);
    elements.outputReserve.value = settings.outputReserve || 1024;
    elements.minMid.value = settings.minMidChars || 0;
    elements.attempts.value = settings.maxAttempts || 3;
    elements.summaryMode.value = settings.summaryMode || 'balanced';
    elements.mapConcurrency.value = String(settings.mapConcurrency || 0);
    elements.reuseParts.checked = settings.reuseParts !== false;
    elements.modeHelp.textContent = SUMMARY_MODE_PRESETS[settings.summaryMode]?.description || '';
    elements.autoCalibrate.checked = settings.autoCalibrate !== false;
    elements.keepSummaries.checked = settings.keepSummaries !== false;
    if (elements.autoImportLorebook) elements.autoImportLorebook.checked = settings.autoImportLorebook !== false;
    if (elements.importCard) elements.importCard.checked = settings.importCard !== false;
    elements.fontSize.value = settings.fontSize || 17;
    elements.defaultTarget.value = settings.targetChars || 800;
    elements.target.value = settings.targetChars || 800;
    elements.style.value = settings.style || 'plot';
    elements.extra.value = settings.style === 'custom' ? (settings.customStyle || '') : (settings.extraInstruction || '');
    elements.provider.value = settings.provider || 'current';

    elements.contextHelp.textContent = `0 = 自动跟随酒馆上下文设置（当前 ${formatCount(ctxTokens)} tokens）`;

    populateProfiles();

    const profileDisabled = elements.provider.value !== 'profile';
    elements.profile.disabled = profileDisabled;
    if (settings.style === 'custom') {
        elements.extra.value = settings.customStyle || '';
        elements.extra.placeholder = '自定义风格要求，例如：用评书的口吻概括，突出江湖恩怨';
    }

    applyFontSize();
    renderReaderSettings();
}

function populateProfiles() {
    if (!elements.profile) return;
    const settings = getSettings();
    elements.profile.replaceChildren();
    let profiles = [];
    try {
        profiles = getContext()?.ConnectionManagerRequestService?.getSupportedProfiles?.() || [];
    } catch {
        profiles = [];
    }
    if (profiles.length === 0) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = '未找到连接配置';
        elements.profile.appendChild(option);
        elements.profile.value = '';
        return;
    }
    for (const profile of profiles) {
        const option = document.createElement('option');
        option.value = profile.id;
        option.textContent = `${profile.name || profile.id}${profile.model ? `（${profile.model}）` : ''}`;
        elements.profile.appendChild(option);
    }
    if (settings.profileId && profiles.some(profile => profile.id === settings.profileId)) {
        elements.profile.value = settings.profileId;
    } else {
        elements.profile.value = profiles[0].id;
        if (!settings.profileId) {
            settings.profileId = profiles[0].id;
            saveSettings();
        }
    }
}

/* ------------------------------------------------------------------ */
/* 导入                                                                */
/* ------------------------------------------------------------------ */

function setImportStatus(text, isError = false) {
    if (!elements.importStatus) return;
    if (!text) {
        elements.importStatus.hidden = true;
        elements.importStatus.textContent = '';
        return;
    }
    elements.importStatus.hidden = false;
    elements.importStatus.textContent = text;
    elements.importStatus.classList.toggle('is-error', isError);
}

async function importFiles(files, { tab = 'reader' } = {}) {
    if (state.importing) {
        toast('正在导入中，请稍候', 'warning');
        return;
    }
    state.importing = true;
    setHeaderStatus('导入中…');
    let imported = null;
    try {
        for (const file of files) {
            setImportStatus(`正在解析 ${file.name}…`);
            try {
                const parsed = await parseNovelFile(file, {
                    onProgress: message => setImportStatus(`${file.name}：${message}`),
                });
                const title = makeUniqueTitle(parsed.title);
                const now = Date.now();
                const meta = {
                    id: uuid(),
                    title,
                    author: parsed.author || '',
                    format: parsed.format || 'TXT',
                    encoding: parsed.encoding || '',
                    charCount: parsed.charCount,
                    chapterCount: parsed.chapters.length,
                    sourceName: file.name,
                    createdAt: now,
                    updatedAt: now,
                };
                const chapters = parsed.chapters.map(chapter => ({
                    ...chapter,
                    charCount: countChars(chapter.content),
                }));
                setImportStatus(`正在保存《${title}》（${chapters.length} 章）…`);
                await saveNovel(meta, chapters);
                imported = meta;
                toast(`已导入《${title}》：${chapters.length} 章 / ${formatCount(parsed.charCount)} 字`, 'success');
            } catch (error) {
                console.error('[小说阅读器] 导入失败', file.name, error);
                setImportStatus(`${file.name} 导入失败：${error.message}`, true);
                toast(`${file.name} 导入失败：${error.message}`, 'error');
            }
            await yieldToUI();
        }

        await refreshLibrary();
        if (imported) {
            await openNovel(imported.id, tab, { force: true });
            showTab(tab);
            setImportStatus('');
        }
    } finally {
        state.importing = false;
        setHeaderStatus(state.novel ? `${state.novel.title} · ${state.chapters.length} 章` : '就绪');
    }
}

/* ------------------------------------------------------------------ */
/* 世界书                                                              */
/* ------------------------------------------------------------------ */

function getWorldbookScope() {
    return panel?.querySelector('input[name="nr-wb-scope"]:checked')?.value || 'all';
}

function getWorldbookSelectedMeta() {
    const scope = getWorldbookScope();
    return scope === 'all' ? state.chapters : state.chapters.filter(chapter => state.wbSelection.has(chapter.index));
}

function defaultWorldbookName() {
    const title = state.novel?.title || '小说';
    return `${title} · 世界书`.slice(0, 80);
}

function worldbookCategoryFlags() {
    const settings = getSettings();
    const flags = settings.worldbookCategories && typeof settings.worldbookCategories === 'object'
        ? settings.worldbookCategories
        : {};
    const result = {};
    for (const category of WORLDBOOK_CATEGORIES) {
        result[category.key] = flags[category.key] === undefined ? category.enabled : flags[category.key] === true;
    }
    return result;
}

function renderWorldbookCategories() {
    if (!elements.wbCats) return;
    const flags = worldbookCategoryFlags();
    elements.wbCats.replaceChildren();
    for (const category of WORLDBOOK_CATEGORIES) {
        const label = createElement('label', 'nr-wb-cat');
        label.title = category.guide;
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.dataset.wbCat = category.key;
        checkbox.checked = Boolean(flags[category.key]);
        const name = createElement('span', 'nr-wb-cat-name', category.label);
        const hint = createElement('em', 'nr-wb-cat-hint', category.guide.slice(0, 18));
        label.append(checkbox, name, hint);
        elements.wbCats.appendChild(label);
    }
}

function renderWorldbookConfig() {
    if (!state.novelId) return;
    const settings = getSettings();
    if (elements.wbChunkChars) elements.wbChunkChars.value = String(clamp(Number(settings.worldbookChunkChars) || 9000, 1200, 30000));
    if (elements.wbConcurrency) elements.wbConcurrency.value = String(clamp(Number(settings.worldbookConcurrency) || 2, 1, 4));
    if (elements.wbEntryChars) elements.wbEntryChars.value = String(clamp(Number(settings.worldbookEntryChars) || 600, 120, 2000));
    if (elements.wbPlotEntries) elements.wbPlotEntries.value = String(clamp(Number(settings.worldbookPlotEntries) || 4, 1, 12));
    if (elements.wbExtra) elements.wbExtra.value = settings.worldbookExtraInstruction || '';
    renderWorldbookCategories();
    updateWorldbookBudget();
}

function renderWorldbookChapters() {
    if (!elements.wbChapters) return;
    const filter = (elements.wbFilter?.value || '').trim().toLowerCase();
    const scope = getWorldbookScope();
    const isAllScope = scope === 'all';

    elements.wbChapters.replaceChildren();
    if (!state.chapters.length) {
        elements.wbChapters.appendChild(createElement('div', 'nr-list-empty', '暂无章节'));
        if (elements.wbSelectCount) elements.wbSelectCount.textContent = '已选 0 章';
        return;
    }

    const fragment = document.createDocumentFragment();
    let count = 0;
    for (const chapter of state.chapters) {
        if (chapter.isVolume) continue;
        if (filter && !chapter.title.toLowerCase().includes(filter)) continue;
        const label = createElement('label', 'nr-check-item');
        label.dataset.chapterIndex = String(chapter.index);
        if (isAllScope) label.classList.add('is-ignored');

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.dataset.index = String(chapter.index);
        checkbox.checked = state.wbSelection.has(chapter.index);
        checkbox.disabled = isAllScope;

        const title = createElement('span', 'nr-check-title', chapter.title);
        title.title = chapter.title;
        const countText = createElement('em', 'nr-check-count', `${formatCount(chapter.charCount)} 字`);
        label.append(checkbox, title, countText);
        fragment.appendChild(label);
        count++;
    }
    if (count === 0) {
        elements.wbChapters.appendChild(createElement('div', 'nr-list-empty', '没有匹配的章节'));
    } else {
        elements.wbChapters.appendChild(fragment);
    }
    if (elements.wbSelectCount) {
        elements.wbSelectCount.textContent = isAllScope
            ? `整本 · ${state.chapters.length} 章`
            : `已选 ${state.wbSelection.size} 章`;
    }
}

function updateWorldbookBudget() {
    if (!elements.wbBudget) return;
    if (!state.novelId || !state.chapters.length) {
        elements.wbBudget.textContent = '请先在书架中打开一本小说，或直接导入新文件。';
        if (elements.wbRun) elements.wbRun.disabled = true;
        return;
    }
    const settings = getSettings();
    const selected = getWorldbookSelectedMeta();
    const budget = computeBudget(settings);
    const usage = estimateWorldbookUsage({ chapters: selected, settings });
    const totalChars = usage.totalChars;
    const effectiveChunk = usage.effectiveChunk;
    const chunks = usage.chunks;
    const requestedChunk = clamp(Number(settings.worldbookChunkChars) || 9000, 1200, 30000);
    const flags = worldbookCategoryFlags();
    const categoryCount = WORLDBOOK_CATEGORIES.filter(category => flags[category.key]).length;

    const parts = [
        `已选 ${selected.length} 章 · 约 ${formatCount(totalChars)} 字`,
        `实际块大小 ${formatCount(effectiveChunk)} 字 · 预计至少 ${chunks} 块`,
    ];
    if (chunks) {
        parts.push(`预计消耗约 ${formatCount(usage.totalTokens)} tokens（输入 ${formatCount(usage.inputTokens)} + 输出上限 ${formatCount(usage.outputTokens)}）`);
    }
    parts.push(`上下文 ${formatCount(budget.ctxTokens)} tokens`);
    parts.push(`分类 ${categoryCount} 个`);
    if (flags.event) {
        parts.push(`剧情按章节区间分 ${clamp(Number(settings.worldbookPlotEntries) || 4, 1, 12)} 条`);
    }
    const singleLabels = WORLDBOOK_CATEGORIES
        .filter(category => category.single && category.key !== 'event' && flags[category.key])
        .map(category => category.label);
    if (singleLabels.length) parts.push(`${singleLabels.join('/')}各合并为 1 条`);
    if (requestedChunk > effectiveChunk) parts.push(`⚠ 受上下文限制，每块已从 ${formatCount(requestedChunk)} 收到 ${formatCount(effectiveChunk)} 字`);
    if (!categoryCount) parts.push('⚠ 至少启用一个分类');
    elements.wbBudget.textContent = parts.join(' · ');
    if (elements.wbRun) {
        elements.wbRun.disabled = state.worldbook.running || selected.length === 0 || categoryCount === 0;
        elements.wbRun.textContent = state.worldbook.result ? '重新生成' : '生成世界书';
    }
}

function renderWorldbookResult() {
    if (!elements.wbResult) return;
    const result = state.worldbook.result;
    if (!result) {
        elements.wbResult.hidden = true;
        elements.wbEntries.replaceChildren();
        if (elements.wbName) elements.wbName.value = defaultWorldbookName();
        updateWorldbookUndoButton();
        renderWorldbookDuplicateHint();
        return;
    }
    elements.wbResult.hidden = false;
    const stats = worldbookStats(result.entries);
    const categoryText = Object.entries(stats.categories)
        .map(([label, count]) => `${label} ${count}`)
        .join(' · ');
    const parts = [`${stats.total} 条（启用 ${stats.enabled}）`, categoryText, `${formatCount(stats.chars)} 字`];
    if (result.incomplete) parts.push(`部分完成：还有 ${result.failedLabels?.length || 0} 块失败`);
    if (stats.enabled === 0) parts.push('没有启用条目，下载会被阻止');
    elements.wbResultMeta.textContent = parts.filter(Boolean).join(' · ');
    if (elements.wbName) elements.wbName.value = result.name || defaultWorldbookName();
    elements.wbEntryCount.textContent = `启用 ${stats.enabled} / ${stats.total} 条`;
    updateWorldbookUndoButton();
    renderWorldbookDuplicateHint();

    if (state.worldbook.editingIndex != null && state.worldbook.editingIndex >= result.entries.length) {
        state.worldbook.editingIndex = null;
    }

    elements.wbEntries.replaceChildren();
    if (!result.entries?.length) {
        elements.wbEntries.appendChild(createElement('div', 'nr-list-empty', '还没有条目，点“＋ 新增条目”手动添加，或重新生成。'));
        elements.wbEntryCount.textContent = '启用 0 / 0 条';
        return;
    }

    // 正在编辑的条目要把它所在的分类展开，否则编辑器看不见
    const editingEntry = state.worldbook.editingIndex != null ? result.entries[state.worldbook.editingIndex] : null;
    const editingCategory = editingEntry ? worldbookCategoryOf(editingEntry) : null;
    if (editingCategory) state.worldbook.expanded.add(editingCategory.key);

    for (const group of groupWorldbookEntries(result.entries)) {
        elements.wbEntries.appendChild(renderWorldbookGroup(group));
    }
}

/** 分类 key / 标签 → 分类定义；老数据只有 categoryLabel 时也能归类 */
function worldbookCategoryOf(entry) {
    const key = String(entry?.category || '').trim();
    const label = String(entry?.categoryLabel || '').trim();
    return WORLDBOOK_CATEGORIES.find(category => category.key === key)
        || WORLDBOOK_CATEGORIES.find(category => category.label === label)
        || null;
}

/** 把条目按分类分组，顺序与 WORLDBOOK_CATEGORIES 一致，未知分类排在最后 */
function groupWorldbookEntries(entries) {
    const groups = new Map();
    (entries || []).forEach((entry, index) => {
        const category = worldbookCategoryOf(entry);
        const key = category?.key || `other:${entry.categoryLabel || '其他'}`;
        if (!groups.has(key)) {
            groups.set(key, {
                key,
                label: category?.label || entry.categoryLabel || '其他',
                order: category?.order ?? 999,
                rows: [],
            });
        }
        groups.get(key).rows.push({ entry, index });
    });
    return [...groups.values()].sort((a, b) => (a.order - b.order) || a.label.localeCompare(b.label, 'zh-CN'));
}

/** 一个分类 = 一个默认折叠的折叠块 */
function renderWorldbookGroup(group) {
    const details = document.createElement('details');
    details.className = 'nr-wb-group';
    details.dataset.wbGroup = group.key;
    details.open = state.worldbook.expanded.has(group.key);

    const enabled = group.rows.filter(row => row.entry.enabled !== false).length;
    const summary = document.createElement('summary');
    summary.className = 'nr-wb-group-head';
    const arrow = createElement('span', 'nr-wb-group-arrow');
    arrow.setAttribute('aria-hidden', 'true');
    const name = createElement('span', 'nr-wb-group-name', group.label);
    const count = createElement('span', 'nr-wb-group-count', `启用 ${enabled} / ${group.rows.length}`);
    count.title = `启用 ${enabled} 条 / 共 ${group.rows.length} 条`;
    summary.append(arrow, name, count);
    details.appendChild(summary);

    const tools = createElement('div', 'nr-wb-group-tools');
    for (const [action, text] of [['select', '全选本组'], ['none', '全不选本组']]) {
        const button = createElement('button', 'nr-link', text);
        button.type = 'button';
        button.dataset.wbGroupAct = action;
        button.dataset.wbGroupKey = group.key;
        tools.appendChild(button);
    }
    details.appendChild(tools);

    const body = createElement('div', 'nr-wb-group-body');
    for (const row of group.rows) body.appendChild(renderWorldbookEntryCard(row.entry, row.index));
    details.appendChild(body);

    // details 的 toggle 事件不冒泡，直接挂在元素上
    details.addEventListener('toggle', () => {
        if (details.open) state.worldbook.expanded.add(group.key);
        else state.worldbook.expanded.delete(group.key);
    });
    return details;
}

/** 单条条目卡片（编辑器按需展开） */
function renderWorldbookEntryCard(entry, index) {
    const card = createElement('div', 'nr-wb-entry');
    if (entry.enabled === false) card.classList.add('is-disabled');
    card.dataset.wbEntryIndex = String(index);

    const head = createElement('div', 'nr-wb-entry-head');
    const left = createElement('div', 'nr-wb-entry-title');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.wbToggle = String(index);
    checkbox.checked = entry.enabled !== false;
    checkbox.title = '是否包含这一条';
    const name = createElement('strong', null, entry.name);
    const badge = createElement('span', 'nr-badge', entry.categoryLabel || '条目');
    left.append(checkbox, name, badge);
    head.appendChild(left);

    const actions = createElement('div', 'nr-wb-entry-actions');
    const edit = createElement('button', 'nr-link', '编辑');
    edit.type = 'button';
    edit.dataset.wbAct = 'edit';
    edit.dataset.wbIndex = String(index);
    const remove = createElement('button', 'nr-link nr-danger-text', '删除');
    remove.type = 'button';
    remove.dataset.wbAct = 'delete';
    remove.dataset.wbIndex = String(index);
    actions.append(edit, remove);
    head.appendChild(actions);
    card.appendChild(head);

    const keywords = createElement('div', 'nr-wb-keywords', `关键词：${(entry.keywords || []).join('、') || '（无）'}`);
    card.appendChild(keywords);

    if (state.worldbook.editingIndex === index) {
        const editor = createElement('div', 'nr-wb-editor');
        const categorySelect = document.createElement('select');
        categorySelect.className = 'nr-select';
        categorySelect.dataset.wbEditCategory = '1';
        for (const category of WORLDBOOK_CATEGORIES) {
            const option = document.createElement('option');
            option.value = category.key;
            option.textContent = category.label;
            if (category.key === entry.category) option.selected = true;
            categorySelect.appendChild(option);
        }
        const nameInput = document.createElement('input');
        nameInput.className = 'nr-input';
        nameInput.dataset.wbEditName = '1';
        nameInput.value = entry.name;
        nameInput.placeholder = '条目名';
        const keywordInput = document.createElement('input');
        keywordInput.className = 'nr-input';
        keywordInput.dataset.wbEditKeywords = '1';
        keywordInput.value = (entry.keywords || []).join('、');
        keywordInput.placeholder = '关键词，用、或逗号分隔';
        const contentArea = document.createElement('textarea');
        contentArea.className = 'nr-input nr-wb-textarea';
        contentArea.dataset.wbEditContent = '1';
        contentArea.value = entry.content || '';
        const editorActions = createElement('div', 'nr-wb-editor-actions');
        const save = createElement('button', 'nr-btn nr-btn-sm nr-primary', '保存');
        save.type = 'button';
        save.dataset.wbAct = 'save-edit';
        save.dataset.wbIndex = String(index);
        const cancel = createElement('button', 'nr-btn nr-btn-sm', '取消');
        cancel.type = 'button';
        cancel.dataset.wbAct = 'cancel-edit';
        cancel.dataset.wbIndex = String(index);
        editorActions.append(save, cancel);
        editor.append(categorySelect, nameInput, keywordInput, contentArea, editorActions);
        card.appendChild(editor);
    } else {
        const body = createElement('div', 'nr-wb-entry-body', entry.content || '（空）');
        card.appendChild(body);
    }
    return card;
}

async function persistWorldbookResult() {
    const result = state.worldbook.result;
    if (!result || !state.novelId) return;
    try {
        await replaceWorldbook({
            id: state.novelId,
            novelId: state.novelId,
            name: result.name || defaultWorldbookName(),
            entries: result.entries,
            incomplete: Boolean(result.incomplete),
            failedLabels: result.failedLabels || [],
            categories: result.categories || [],
            stats: result.stats || null,
            createdAt: result.createdAt || Date.now(),
            updatedAt: Date.now(),
        });
    } catch (error) {
        console.warn('[小说阅读器] 保存世界书失败', error);
        toast(`保存世界书失败：${error.message}`, 'error');
    }
}

async function loadWorldbookForNovel(novelId, { force = false } = {}) {
    if (!novelId || !elements.wbResult) return;
    if (!force && state.worldbook.loadedNovelId === novelId) return;
    state.worldbook.loading = true;
    try {
        const record = await getWorldbook(novelId);
        if (state.novelId !== novelId) return;
        state.worldbook.result = record
            ? { ...record, name: record.name || defaultWorldbookName() }
            : null;
        state.worldbook.loadedNovelId = novelId;
        state.worldbook.editingIndex = null;
        state.worldbook.expanded = new Set();
        state.worldbook.undo = null;
        state.worldbook.ops.failed = [];
        if (record?.name) {
            const settings = getSettings();
            settings.worldbookName = record.name;
            saveSettings();
        }
        renderWorldbookResult();
        if (!record && elements.wbName) elements.wbName.value = defaultWorldbookName();
        updateWorldbookBudget();
    } catch (error) {
        console.warn('[小说阅读器] 读取世界书失败', error);
        state.worldbook.result = null;
        renderWorldbookResult();
    } finally {
        state.worldbook.loading = false;
    }
}

function readKeywords(value) {
    return Array.from(new Set(String(value || '')
        .split(/[,，、;；|]/)
        .map(item => item.trim())
        .filter(Boolean)))
        .slice(0, 12);
}

function renderWorldbookEntryEditor(index) {
    state.worldbook.editingIndex = index;
    const entry = state.worldbook.result?.entries?.[index];
    const category = entry ? worldbookCategoryOf(entry) : null;
    if (category) state.worldbook.expanded.add(category.key);
    renderWorldbookResult();
    const card = elements.wbEntries.querySelector(`[data-wb-entry-index="${index}"]`);
    card?.querySelector('[data-wb-edit-name="1"]')?.focus();
}

async function saveWorldbookEntry(index) {
    const result = state.worldbook.result;
    const entry = result?.entries?.[index];
    const card = elements.wbEntries.querySelector(`[data-wb-entry-index="${index}"]`);
    if (!entry || !card) return;
    const name = String(card.querySelector('[data-wb-edit-name="1"]')?.value || '').trim();
    const categoryKey = String(card.querySelector('[data-wb-edit-category="1"]')?.value || entry.category);
    const category = WORLDBOOK_CATEGORIES.find(item => item.key === categoryKey) || { key: entry.category, label: entry.categoryLabel };
    if (!name) {
        toast('条目名不能为空', 'warning');
        return;
    }
    entry.name = name;
    entry.category = category.key;
    entry.categoryLabel = category.label;
    entry.keywords = readKeywords(card.querySelector('[data-wb-edit-keywords="1"]')?.value) || [name];
    entry.content = String(card.querySelector('[data-wb-edit-content="1"]')?.value || '').trim();
    state.worldbook.editingIndex = null;
    state.worldbook.expanded.add(category.key);
    const entrySettings = getSettings();
    const limits = {};
    for (const category of WORLDBOOK_CATEGORIES) limits[category.key] = entryCharLimit(category.key, entrySettings);
    state.worldbook.result.entries = mergeWorldbookEntries(result.entries, {
        entryChars: entrySettings.worldbookEntryChars,
        limits,
    });
    await persistWorldbookResult();
    renderWorldbookResult();
    updateWorldbookBudget();
}

async function deleteWorldbookEntry(index) {
    const result = state.worldbook.result;
    if (!result?.entries?.[index]) return;
    if (!(await confirmAction(`删除条目「${result.entries[index].name}」？`))) return;
    result.entries.splice(index, 1);
    state.worldbook.editingIndex = null;
    await persistWorldbookResult();
    renderWorldbookResult();
}

function worldbookData() {
    const result = state.worldbook.result;
    if (!result?.entries?.length) throw new Error('还没有可下载的世界书');
    const data = toSillyTavernWorldbook(result.entries);
    if (!Object.keys(data.entries).length) {
        throw new Error('没有启用任何条目，请先点「全选」或勾选条目');
    }
    return data;
}

function downloadWorldbook() {
    try {
        const data = worldbookData();
        const name = (elements.wbName?.value || state.worldbook.result?.name || defaultWorldbookName()).trim();
        const fileName = `${safeFileName(name)}.json`;
        const count = Object.keys(data.entries).length;
        downloadText(fileName, JSON.stringify(data, null, 2));
        toast(`已下载世界书：${fileName}（${count} 条）`, 'success');
    } catch (error) {
        toast(`下载世界书失败：${error.message}`, 'error');
    }
}

/**
 * 「导入到酒馆」：世界书写进酒馆的世界书列表，同时导入一张绑定这本世界书的角色卡。
 * 新角色卡直接绑定这本世界书。名字冲突时自动改名（《X（2）》）共存，不覆盖已有的东西。
 * 设置里关掉「一并导入角色卡」后，退回只写世界书并绑定当前角色。
 *
 * 预设不在导入范围内：文风由「文风」页按酒馆当前选用的预设生成，用户自己复制进预设。
 */
async function importWorldbookToTavern() {
    let data;
    try {
        data = worldbookData();
    } catch (error) {
        toast(error.message, 'warning');
        return;
    }
    if (!isInTavern()) {
        toast('没有找到酒馆上下文，无法写入世界书', 'error');
        return;
    }

    const result = state.worldbook.result;
    const baseBookName = currentWorldbookName();
    const bookName = uniqueName(baseBookName, worldbookExists) || baseBookName;
    const withCard = getSettings().importCard !== false;
    const title = worldbookExportTitle();
    const cardName = withCard
        ? uniqueName(title, name => tavernCharacterNames().some(item => item.toLowerCase() === name.toLowerCase()), { limit: 60 }) || title
        : '';

    const plans = [`世界书《${bookName}》（${Object.keys(data.entries).length} 条）`];
    if (withCard) plans.push(`角色卡《${cardName}》并自动绑定这本世界书`);
    const renamed = [
        bookName !== baseBookName ? `世界书改名为《${bookName}》` : '',
        withCard && cardName !== title ? `角色卡改名为《${cardName}》` : '',
    ].filter(Boolean);
    const message = `将导入到酒馆：${plans.join('；')}。`
        + (renamed.length ? `因为重名，${renamed.join('，')}，免得覆盖原有的东西。` : '')
        + '继续吗？';
    if (!(await confirmAction(message))) return;

    const done = [];
    const failed = [];
    try {
        await saveWorldbookToTavern(bookName, data);
        done.push(`世界书《${bookName}》`);
    } catch (error) {
        console.error('[小说阅读器] 写入酒馆世界书失败', error);
        toast(`写入酒馆世界书失败：${error.message}`, 'error');
        return;
    }

    if (withCard) {
        try {
            const styleSample = await getNovelStyleSample();
            const greetings = await getNovelCardGreetings();
            const alternate = greetings.end && greetings.end !== greetings.start ? [greetings.end] : [];
            const card = toCharacterCard(result.entries, {
                name: cardName,
                novelTitle: cardName,
                worldbookName: bookName,
                styleSample,
                firstMes: greetings.start,
                alternateGreetings: alternate,
                embeddedWorldbook: false,
            });
            // 世界书已经单独写进酒馆并绑定，卡里不再带内嵌书，免得导入时再弹一次询问
            delete card.data.character_book;
            card.data.extensions.world = bookName;
            const imported = await importCharacterCardToTavern(card, { fileName: cardName });
            done.push(`角色卡《${cardName}》${imported.avatar ? '（已绑定世界书）' : ''}`);
        } catch (error) {
            console.error('[小说阅读器] 导入角色卡失败', error);
            failed.push(`角色卡没导入：${error.message}`);
        }
    } else {
        const chid = selectedCharacterId();
        if (chid >= 0) {
            try {
                const character = selectedCharacter();
                await linkWorldToCharacter(chid, bookName);
                done.push(`已绑定到「${character?.name || '当前角色'}」`);
            } catch (error) {
                failed.push(`绑定当前角色失败：${error.message}`);
            }
        }
    }

    if (failed.length) {
        toast(`已导入 ${done.join('、')}；${failed.join('；')}`, 'warning');
    } else {
        toast(`已导入到酒馆：${done.join('、')}。${withCard ? '在角色列表里就能选到。' : ''}`, 'success');
    }
}

/**
 * 读取一本小说开头几章，整理成一段文风样本。
 * 角色卡会把它写进描述，文风页会拿它分析写法；不参与世界书生成。
 */
async function getNovelStyleSample(maxChars = STYLE_SAMPLE_CHARS, novelId = state.novelId) {
    if (!novelId || state.novelId !== novelId) return '';
    if (state.styleSample.novelId === novelId && state.styleSample.chars === maxChars) {
        return state.styleSample.text;
    }

    const chapters = state.chapters || [];
    if (!chapters.length) return '';
    const picked = [];
    const addChapter = (position) => {
        const chapter = chapters[position];
        if (!chapter || picked.some(item => item.index === chapter.index)) return;
        picked.push(chapter);
    };
    addChapter(0);
    if (chapters.length > 2) addChapter(Math.floor((chapters.length - 1) / 2));
    if (chapters.length > 1) addChapter(chapters.length - 1);

    const perChapter = Math.max(350, Math.ceil((maxChars * 1.5) / Math.max(1, picked.length)));
    let text = '';
    for (const chapter of picked) {
        try {
            const content = await getChapterContent(novelId, chapter.index);
            if (!content) continue;
            const piece = extractStyleSample(content, perChapter);
            if (!piece) continue;
            text += `${text ? '\n\n' : ''}${piece}`;
        } catch (error) {
            console.warn('[小说阅读器] 读取文风样本失败', error);
        }
    }
    const sample = extractStyleSample(text, maxChars);
    state.styleSample = { novelId, chars: maxChars, text: sample };
    return sample;
}

const CARD_GREETING_MAX_CHARS = 700;

/**
 * 把一段章节原文整理成角色卡的开场白：
 * 首段开头从前往后取，结尾段从后往前取，保留原文段落。
 */
function buildCardGreeting(text, label, fromEnd = false) {
    const paragraphs = String(text || '')
        .replace(/\r\n?/g, '\n')
        .split(/\n+/)
        .map(paragraph => paragraph.trim())
        .filter(Boolean);
    if (!paragraphs.length) return '';

    const ordered = fromEnd ? [...paragraphs].reverse() : paragraphs;
    const picked = [];
    let size = 0;
    for (const paragraph of ordered) {
        if (picked.length && size + paragraph.length > CARD_GREETING_MAX_CHARS) break;
        picked.push(paragraph);
        size += paragraph.length;
        if (size >= CARD_GREETING_MAX_CHARS) break;
    }
    if (fromEnd) picked.reverse();

    let body = picked.join('\n\n');
    if (body.length > CARD_GREETING_MAX_CHARS + 200) {
        body = fromEnd
            ? `……${body.slice(-CARD_GREETING_MAX_CHARS).trimStart()}`
            : `${body.slice(0, CARD_GREETING_MAX_CHARS).trimEnd()}……`;
    }
    return `*${label}*\n\n${body}`;
}

/**
 * 角色卡的两条初始消息：小说开头、小说结尾。
 * 直接取原文首尾章节，不额外调用模型，下载时即可用。
 */
async function getNovelCardGreetings() {
    const novelId = state.novelId;
    if (!novelId || !state.chapters.length) return { start: '', end: '' };
    if (state.cardGreetings.novelId === novelId) return state.cardGreetings;

    const readChapter = async (index) => {
        try {
            return await getChapterContent(novelId, index);
        } catch (error) {
            console.warn('[小说阅读器] 读取开局原文失败', error);
            return '';
        }
    };
    const first = await readChapter(0);
    const last = state.chapters.length > 1
        ? await readChapter(state.chapters.length - 1)
        : first;
    const greetings = {
        novelId,
        start: buildCardGreeting(first, '故事开始'),
        end: buildCardGreeting(last, '故事结尾', true),
    };
    state.cardGreetings = greetings;
    return greetings;
}

function worldbookExportTitle() {
    const fromNovel = String(state.novel?.title || '').trim();
    const fromName = String(elements.wbName?.value || state.worldbook.result?.name || '').trim();
    return fromNovel || fromName || '小说';
}

function currentWorldbookName() {
    return String(elements.wbName?.value || state.worldbook.result?.name || '').trim()
        || `${worldbookExportTitle()} · 世界书`;
}

async function downloadWorldbookCharacterCard() {
    const result = state.worldbook.result;
    if (!result?.entries?.length) {
        toast('还没有可下载的世界书', 'warning');
        return;
    }
    try {
        const title = worldbookExportTitle();
        const worldbookName = currentWorldbookName();
        const styleSample = await getNovelStyleSample();
        const greetings = await getNovelCardGreetings();
        const alternate = greetings.end && greetings.end !== greetings.start ? [greetings.end] : [];
        const card = toCharacterCard(result.entries, {
            name: title,
            novelTitle: title,
            worldbookName,
            styleSample,
            firstMes: greetings.start,
            alternateGreetings: alternate,
        });
        const entryCount = card.data.character_book.entries.length;
        if (!entryCount) {
            toast('没有启用任何条目，请先点「全选」或勾选条目', 'warning');
            return;
        }
        downloadText(`${safeFileName(title)}-角色卡.json`, JSON.stringify(card, null, 2));
        const greetingCount = 1 + alternate.length;
        toast(
            `已下载角色卡：内嵌 ${entryCount} 条世界书${styleSample ? '，并附文风样本' : ''}，`
            + `${greetingCount > 1 ? '含「故事开始 / 故事结尾」两条初始消息' : '含一条初始消息'}。导入角色卡后会自动导入并绑定世界书。`,
            'success',
        );
    } catch (error) {
        console.error('[小说阅读器] 下载角色卡失败', error);
        toast(`下载角色卡失败：${error.message}`, 'error');
    }
}

/* ------------------------------------------------------------------ */
/* 文风：跟随酒馆当前选用的预设，只生成文风，不写预设                     */
/* ------------------------------------------------------------------ */

function renderStyleSelect() {
    renderNovelSelect(elements.styleSelect, '选择小说…');
}

function currentStyleNovelId() {
    const value = String(elements.styleSelect?.value || '').trim();
    return value || state.novelId || '';
}

function setStyleStatus(text) {
    if (elements.styleStatus) elements.styleStatus.textContent = String(text || '');
}

/**
 * 重新读一次酒馆当前选用的预设：条目列表、格式卡片、旧结果的有效性都跟着换。
 * 预设名变化时把旧结果标成过期，提醒用户按新预设重生成。
 *
 * @param {{silent?: boolean}} [options]
 * @returns {{preset: object|null, changed: boolean}}
 */
function refreshStylePreset({ silent = false } = {}) {
    const previous = state.style.preset;
    let preset = null;
    try {
        preset = readSelectedChatPreset();
    } catch (error) {
        console.warn('[小说阅读器] 读取当前预设失败', error);
    }

    state.style.preset = preset;
    state.style.lastReadAt = Date.now();

    if (preset) {
        const identifiers = new Set(preset.prompts.map(entry => entry.identifier));
        if (!state.style.entryId || !identifiers.has(state.style.entryId)) {
            const fallback = buildStylePlan(preset, '');
            state.style.entryId = fallback ? fallback.entry.identifier : '';
        }
        if (state.style.result && state.style.result.presetName !== preset.name) {
            state.style.result.stale = true;
        }
    } else {
        state.style.entryId = '';
        state.style.plan = null;
    }

    const changed = Boolean(previous && preset && previous.name !== preset.name);
    renderStylePanel();

    if (changed && !silent) {
        toast(`酒馆预设已切到《${preset.name}》，文风格式跟着换了`, 'info');
    }
    return { preset, changed };
}

function renderStylePanel() {
    if (!elements.stylePreset) return;
    renderStylePresetCard();
    renderStyleEntryOptions();
    renderStyleFormat();
    renderStyleResult();
    updateStyleControls();
}

function renderStylePresetCard() {
    const box = elements.stylePreset;
    if (!box) return;
    const preset = state.style.preset;
    box.replaceChildren();
    box.classList.toggle('is-missing', !preset);

    if (!preset) {
        box.append(createElement('div', 'nr-st-preset-name', '没有读到酒馆的预设'));
        box.append(createElement('div', 'nr-st-preset-meta', '请确认酒馆用的是「对话补全」接口，并且在顶部选好一份预设。'));
        return;
    }

    const groups = groupStyleEntries(preset);
    const head = createElement('div', 'nr-st-preset-head');
    head.append(createElement('span', 'nr-st-preset-badge', '跟随中'));
    head.append(createElement('strong', 'nr-st-preset-name', preset.name || '（未命名预设）'));

    const meta = [
        `${preset.prompts.length} 条提示词`,
        `文风条目 ${groups.style.length} 条（启用 ${groups.enabledStyle.length}）`,
        groups.empty.length ? `占位 / 分隔 ${groups.empty.length} 条` : '',
        preset.isGroup ? '群聊' : '',
    ].filter(Boolean).join(' · ');

    box.append(head, createElement('div', 'nr-st-preset-meta', meta));
    if (preset.api && preset.api !== 'openai') {
        box.append(createElement(
            'div',
            'nr-st-preset-warn',
            `酒馆当前接口是 ${preset.api}，不是「对话补全」；这份预设可能不会参与生成，格式仍会照它来写。`,
        ));
    }
}

function renderStyleEntryOptions() {
    const select = elements.styleEntry;
    if (!select) return;
    const preset = state.style.preset;
    select.replaceChildren();

    if (!preset) {
        select.disabled = true;
        state.style.plan = null;
        if (elements.styleEntryHelp) elements.styleEntryHelp.textContent = '先让酒馆用上对话补全预设。';
        return;
    }

    const groups = groupStyleEntries(preset);
    const addGroup = (label, list) => {
        if (!list.length) return;
        const group = document.createElement('optgroup');
        group.label = label;
        for (const entry of list) {
            const option = document.createElement('option');
            option.value = entry.identifier;
            const chars = countChars(entry.content);
            option.textContent = `${entry.enabled ? '✓ ' : '　'}${entry.name}${chars ? ` · ${chars} 字` : ' · 空白'}`;
            group.appendChild(option);
        }
        select.appendChild(group);
    };

    if (!state.style.entryId) {
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = groups.style.length ? '选择一条文风条目…' : '没有文风条目，请从下面「全部条目」里选';
        placeholder.disabled = true;
        placeholder.selected = true;
        select.appendChild(placeholder);
    }

    addGroup('已启用的文风条目', groups.enabledStyle);
    addGroup('其它文风条目', groups.style.filter(entry => !entry.enabled));
    addGroup('自定义位 / 占位条目', groups.empty);
    addGroup('全部条目', groups.rest);

    select.disabled = false;
    if (state.style.entryId) select.value = state.style.entryId;
    renderStyleEntryHelp();
}

function renderStyleEntryHelp() {
    if (!elements.styleEntryHelp) return;
    const plan = buildStylePlan(state.style.preset, state.style.entryId);
    state.style.plan = plan;
    if (!plan) {
        const groups = groupStyleEntries(state.style.preset);
        elements.styleEntryHelp.textContent = groups.style.length
            ? '选一条文风条目，格式按它的排版走。'
            : '这份预设里没有名字带「文风」的条目。可以从「全部条目」里选一条要粘贴的位置，或先在酒馆的提示词管理器里加一条文风条目。';
        return;
    }
    const parts = [describeStyleFormat(plan.spec)];
    if (plan.borrowedStructure) {
        parts.push(`这一条还是空的，排版参考「${plan.structureRef.name}」`);
    }
    elements.styleEntryHelp.textContent = `当前：${parts.join('；')}`;
}

function renderStyleFormat() {
    const box = elements.styleFormat;
    if (!box) return;
    box.replaceChildren();
    const plan = state.style.plan;
    if (!plan) {
        box.textContent = '还没有选中条目：选一条后，这里会显示它的包裹标签、小节和条目符号。';
        return;
    }

    const head = createElement('div', 'nr-st-format-head');
    head.append(createElement('strong', '', `格式跟随「${plan.structureRef.name}」`));
    if (plan.entry.identifier !== plan.structureRef.identifier) {
        head.append(createElement('span', 'nr-muted', `粘贴位置「${plan.entry.name}」`));
    }

    const list = document.createElement('ul');
    list.className = 'nr-st-format-list';
    for (const line of styleFormatLines(plan.spec)) {
        list.appendChild(createElement('li', '', line));
    }
    box.append(head, list);

    const details = document.createElement('details');
    details.className = 'nr-st-ref';
    details.append(
        createElement('summary', '', `查看预设条目原文（只供预览，不发送；《${plan.structureRef.name}》 · ${countChars(plan.structureRef.content)} 字）`),
        createElement('pre', 'nr-st-ref-text', plan.structureRef.content || '（空）'),
    );
    box.appendChild(details);

    if (plan.entry.identifier !== plan.structureRef.identifier) {
        const targetDetails = document.createElement('details');
        targetDetails.className = 'nr-st-ref';
        targetDetails.append(
            createElement('summary', '', `查看粘贴位置原文（只供预览，不发送；《${plan.entry.name}》 · ${countChars(plan.entry.content)} 字）`),
            createElement('pre', 'nr-st-ref-text', plan.entry.content || '（空）'),
        );
        box.appendChild(targetDetails);
    }
}

function renderStyleResult() {
    const box = elements.styleResult;
    if (!box) return;
    const result = state.style.result;
    box.hidden = !result;
    if (!result) {
        if (elements.styleStale) elements.styleStale.hidden = true;
        return;
    }

    if (elements.styleOutput && elements.styleOutput.value !== result.text) {
        elements.styleOutput.value = result.text;
    }
    if (elements.styleResultMeta) {
        const time = new Date(result.generatedAt).toLocaleTimeString('zh-CN', { hour12: false });
        elements.styleResultMeta.textContent = `按《${result.presetName || '当前预设'}》·「${result.entryName}」· ${countChars(result.text)} 字 · ${time}`;
    }

    if (elements.styleCheck) {
        const check = elements.styleCheck;
        check.replaceChildren();
        check.className = 'nr-st-check';
        if (result.checks?.ok) {
            check.classList.add('is-ok');
            check.textContent = '格式检查：包裹标签、小节标题、条目符号都对上了';
        } else {
            check.classList.add('is-warn');
            const warnings = result.checks?.warnings || [];
            check.append(createElement('strong', '', `格式检查：有 ${warnings.length} 处要看一下`));
            const list = document.createElement('ul');
            for (const warning of warnings) list.appendChild(createElement('li', '', warning));
            check.appendChild(list);
        }
    }

    if (elements.stylePaste) {
        elements.stylePaste.textContent = stylePasteHint({
            presetName: result.presetName,
            entryName: result.entryName,
            role: result.role,
        });
    }

    // 以当前读到的预设名为准：生成过程中被切走也能立刻标出来
    const currentName = state.style.preset?.name || '';
    const stale = Boolean(currentName) && Boolean(result.presetName) && currentName !== result.presetName;
    result.stale = stale;

    const staleBox = elements.styleStale;
    if (staleBox) {
        staleBox.hidden = !stale;
        if (stale) {
            staleBox.textContent = `这段是按《${result.presetName}》生成的，现在酒馆用的是《${currentName}》。`
                + '格式可能已经对不上，点「重新生成」按当前预设置写。';
        }
    }
}

function updateStyleControls() {
    const plan = state.style.plan;
    const ready = Boolean(state.style.preset && plan && currentStyleNovelId());
    if (elements.styleRun) elements.styleRun.disabled = state.style.running || !ready;
    if (elements.styleStop) elements.styleStop.hidden = !state.style.running;
    if (elements.styleRefresh) elements.styleRefresh.disabled = state.style.running;
    if (elements.styleEntry) elements.styleEntry.disabled = state.style.running || !state.style.preset;
}

function handleStyleProgress(event) {
    if (!event) return;
    if (typeof event === 'string') {
        setStyleStatus(event);
        return;
    }
    if (event.text) {
        setStyleStatus(event.text);
        return;
    }
    if (event.type === 'call') {
        setStyleStatus(`第 ${event.attempt}/${event.maxAttempts} 次请求…`);
    }
}

/**
 * 生成一份贴合当前小说、排版跟随当前预设的文风。
 * 只写进 state，不上传、不写预设；用户自己复制到酒馆里。
 */
async function startStyleGeneration() {
    if (state.style.running) return;

    let preset = null;
    try {
        preset = readSelectedChatPreset();
    } catch (error) {
        console.warn('[小说阅读器] 读取当前预设失败', error);
    }
    if (!preset) {
        toast('没有读到酒馆当前选用的预设，请确认接口是「对话补全」', 'warning');
        return;
    }
    state.style.preset = preset;

    const plan = buildStylePlan(preset, state.style.entryId);
    if (!plan) {
        toast('这份预设里没有可用的条目', 'warning');
        return;
    }
    state.style.entryId = plan.entry.identifier;

    const novelId = currentStyleNovelId();
    if (!novelId) {
        toast('请先选择一本小说', 'warning');
        return;
    }
    if (novelId !== state.novelId || !state.chapters.length) {
        await openNovel(novelId, 'style');
    }
    if (novelId !== state.novelId) {
        toast('小说没有打开成功', 'error');
        return;
    }

    const sample = await getNovelStyleSample(2400, novelId);
    if (!sample) {
        toast('读不到这本小说的原文样本', 'warning');
        return;
    }

    // 输出预算跟着目标篇幅走：短条目别浪费上限，长条目别被截断
    const expectedChars = Math.max(120, Math.round(Number(plan.targetChars) || STYLE_SAMPLE_CHARS));
    const styleMaxTokens = clamp(Math.round(expectedChars * 1.8), 1200, STYLE_OUTPUT_TOKEN_LIMIT);
    const styleTokenLimit = Math.min(STYLE_OUTPUT_TOKEN_LIMIT, styleMaxTokens + 1500);

    const controller = new AbortController();
    state.style.running = true;
    state.style.abort = controller;
    updateStyleControls();
    orb?.classList.add('nr-orb-busy');
    setStyleStatus(`正在分析原文，并按「${plan.structureRef.name}」的格式重写…`);

    try {
        const text = await callWithRetry({
            system: STYLE_ADAPT_SYSTEM_PROMPT,
            user: buildStyleAdaptPrompt({
                novelTitle: state.novel?.title || '小说',
                sample,
                pov: detectPov(sample),
                presetName: preset.name,
                plan,
                instruction: String(elements.styleExtra?.value || '').trim(),
            }),
            maxTokens: styleMaxTokens,
            maxTokenLimit: styleTokenLimit,
            settings: getSettings(),
            signal: controller.signal,
            label: '生成文风',
            onProgress: handleStyleProgress,
            stats: { calls: 0 },
        });

        const fitted = fitStyleOutput(parseStyleAdaptOutput(text), plan.spec.wrapper);
        const checks = checkStyleOutput(fitted, plan.spec);
        state.style.result = {
            text: fitted,
            presetName: preset.name,
            entryId: plan.entry.identifier,
            entryName: plan.entry.name,
            structureName: plan.structureRef.name,
            role: plan.spec.role,
            novelId,
            novelTitle: state.novel?.title || '小说',
            generatedAt: Date.now(),
            checks,
            stale: false,
        };
        setStyleStatus(checks.ok
            ? '生成完成：格式检查通过'
            : `生成完成：有 ${checks.warnings.length} 处格式要看一下`);
        toast('文风已生成，复制后粘到预设里对应条目即可', 'success');
        renderStylePanel();
    } catch (error) {
        if (isAbortError(error)) {
            setStyleStatus('已停止');
        } else {
            console.error('[小说阅读器] 生成文风失败', error);
            setStyleStatus(`生成失败：${error.message}`);
            toast(`生成文风失败：${error.message}`, 'error');
        }
    } finally {
        state.style.running = false;
        state.style.abort = null;
        orb?.classList.remove('nr-orb-busy');
        updateStyleControls();
    }
}

function stopStyleGeneration() {
    if (!state.style.running || !state.style.abort) return;
    state.style.abort.abort();
    setStyleStatus('正在停止…');
}

/** 复制结果（用输入框里的内容，用户改过也复制改后的） */
async function copyStyleOutput() {
    const text = String(elements.styleOutput?.value || state.style.result?.text || '');
    if (!text.trim()) return;
    if (state.style.result) state.style.result.text = text;
    try {
        await navigator.clipboard.writeText(text);
        toast('已复制，去酒馆预设里整段替换那条内容', 'success');
    } catch {
        const helper = document.createElement('textarea');
        helper.value = text;
        helper.style.position = 'fixed';
        helper.style.opacity = '0';
        document.body.appendChild(helper);
        helper.select();
        document.execCommand('copy');
        helper.remove();
        toast('已复制，去酒馆预设里整段替换那条内容', 'success');
    }
}

/** 酒馆换了预设：重新读条目与格式，旧结果标成过期 */
function setupPresetWatcher() {
    try {
        installPresetChangeWatcher(() => {
            if (!state.style.preset && !isPanelOpen()) return;
            refreshStylePreset({ silent: !isPanelOpen() });
        });
    } catch (error) {
        console.warn('[小说阅读器] 监听预设切换失败', error);
    }
}

async function clearWorldbookResult() {
    const result = state.worldbook.result;
    if (!result) return;
    if (!(await confirmAction('清空当前世界书结果和这本书的分块缓存？此操作不可恢复。'))) return;
    try {
        await deleteWorldbook(state.novelId);
        await deleteWorldbookPartsForNovel(state.novelId);
    } catch (error) {
        console.warn('[小说阅读器] 清空世界书失败', error);
    }
    state.worldbook.result = null;
    state.worldbook.loadedNovelId = null;
    state.worldbook.editingIndex = null;
    state.worldbook.expanded = new Set();
    state.worldbook.undo = null;
    state.worldbook.ops.failed = [];
    renderWorldbookResult();
    updateWorldbookBudget();
    toast('世界书结果已清空');
}

function commitWorldbookOptions() {
    const settings = getSettings();
    settings.worldbookChunkChars = clamp(Number(elements.wbChunkChars?.value) || settings.worldbookChunkChars || 9000, 1200, 30000);
    settings.worldbookConcurrency = clamp(Number(elements.wbConcurrency?.value) || settings.worldbookConcurrency || 2, 1, 4);
    settings.worldbookEntryChars = clamp(Number(elements.wbEntryChars?.value) || settings.worldbookEntryChars || 600, 120, 2000);
    settings.worldbookPlotEntries = clamp(Number(elements.wbPlotEntries?.value) || settings.worldbookPlotEntries || 4, 1, 12);
    settings.worldbookExtraInstruction = String(elements.wbExtra?.value || '').trim();
    if (elements.wbChunkChars) elements.wbChunkChars.value = String(settings.worldbookChunkChars);
    if (elements.wbConcurrency) elements.wbConcurrency.value = String(settings.worldbookConcurrency);
    if (elements.wbEntryChars) elements.wbEntryChars.value = String(settings.worldbookEntryChars);
    if (elements.wbPlotEntries) elements.wbPlotEntries.value = String(settings.worldbookPlotEntries);
    saveSettings();
    return settings;
}

function appendWorldbookLog(message) {
    if (!elements.wbLog) return;
    const line = createElement('div', 'nr-log-line', `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${message}`);
    elements.wbLog.appendChild(line);
    elements.wbLog.scrollTop = elements.wbLog.scrollHeight;
}

function setWorldbookProgress(text, percent) {
    if (elements.wbProgressText) elements.wbProgressText.textContent = text;
    if (elements.wbProgressPct) elements.wbProgressPct.textContent = `${clamp(Math.round(percent), 0, 100)}%`;
    if (elements.wbProgressBar) elements.wbProgressBar.style.width = `${clamp(Math.round(percent), 0, 100)}%`;
}

async function startWorldbook() {
    if (state.worldbook.running) return;
    if (state.summary.running) {
        toast('总结正在生成，请等它结束或先停止', 'warning');
        return;
    }
    if (!state.novelId || !state.chapters.length) {
        toast('请先打开一本小说，或在世界书面板导入文件', 'warning');
        return;
    }
    const selected = getWorldbookSelectedMeta();
    if (!selected.length) {
        toast('请至少选择一章', 'warning');
        return;
    }
    const novelId = state.novelId;
    const settings = commitWorldbookOptions();
    const flags = worldbookCategoryFlags();
    if (!WORLDBOOK_CATEGORIES.some(category => flags[category.key])) {
        toast('请至少启用一个提取分类', 'warning');
        return;
    }

    const usage = estimateWorldbookUsage({ chapters: selected, settings });
    const effectiveChunk = usage.effectiveChunk;
    const estimatedCalls = usage.chunks;
    if (estimatedCalls > 30) {
        const ok = await confirmAction(
            `本次世界书预计至少 ${estimatedCalls} 次模型请求（约 ${formatCount(usage.totalChars)} 字，`
            + `预计消耗约 ${formatCount(usage.totalTokens)} tokens）。继续吗？`,
        );
        if (!ok) return;
        if (state.novelId !== novelId) return;
    }

    state.worldbook.running = true;
    state.worldbook.abort = new AbortController();
    elements.wbRun.disabled = true;
    elements.wbStop.hidden = false;
    elements.wbProgress.hidden = false;
    elements.wbLog?.replaceChildren();
    setWorldbookProgress('正在准备…', 0);
    setHeaderStatus('提取世界书…');
    orb?.classList.add('nr-orb-busy');

    appendWorldbookLog(`范围：${getWorldbookScope() === 'all' ? '整本' : '选中章节'}，${selected.length} 章；每块约 ${effectiveChunk} 字；并发 ${settings.worldbookConcurrency}`);
    appendWorldbookLog(`预计消耗约 ${formatCount(usage.totalTokens)} tokens（输入 ${formatCount(usage.inputTokens)} + 输出上限 ${formatCount(usage.outputTokens)}，未扣除缓存）`);
    appendWorldbookLog(`分类：${WORLDBOOK_CATEGORIES.filter(category => flags[category.key]).map(category => category.label).join('、')}`);

    const chapterCache = new Map();
    const loadChapter = async (index) => {
        if (chapterCache.has(index)) return chapterCache.get(index);
        const text = await getChapterContent(novelId, index);
        chapterCache.set(index, text);
        await yieldToUI();
        return text;
    };

    try {
        const result = await generateWorldbook({
            novelId,
            novelTitle: state.novel?.title || '未命名小说',
            chapters: selected,
            loadChapter,
            settings,
            signal: state.worldbook.abort.signal,
            cache: {
                getMany: keys => getWorldbookParts(keys),
                put: part => putWorldbookPart(part),
            },
            onProgress: event => {
                if (event.type === 'split') {
                    setWorldbookProgress(`正在读取章节 ${event.current}/${event.total}…`, 2 + (event.current / Math.max(1, event.total)) * 8);
                } else if (event.type === 'plan') {
                    appendWorldbookLog(`切分为 ${event.chunks.length} 块，共约 ${formatCount(event.stats.inputChars)} 字`);
                } else if (event.type === 'cache') {
                    appendWorldbookLog(event.text);
                } else if (event.type === 'chunk-start') {
                    setWorldbookProgress(`正在提取第 ${event.index + 1}/${event.total} 块：${event.label}`, 10 + (event.index / Math.max(1, event.total)) * 80);
                    appendWorldbookLog(`开始：${event.label}`);
                } else if (event.type === 'chunk-done') {
                    appendWorldbookLog(`完成：${event.label}，${event.entries} 条`);
                } else if (event.type === 'chunk-failed') {
                    appendWorldbookLog(`失败：${event.label}：${event.error}`);
                } else if (event.type === 'stage') {
                    appendWorldbookLog(event.text);
                } else if (event.type === 'progress') {
                    setWorldbookProgress(`已完成 ${event.current}/${event.total} 块…`, 10 + (event.percent || 0) * 0.85);
                } else if (event.type === 'call') {
                    appendWorldbookLog(`请求：${event.label}（第 ${event.attempt}/${event.maxAttempts} 次）`);
                } else if (event.type === 'done') {
                    appendWorldbookLog(`生成完成：${event.result.entries.length} 条`);
                }
            },
        });

        if (state.novelId !== novelId) return;
        const name = String(elements.wbName?.value || settings.worldbookName || defaultWorldbookName()).trim() || defaultWorldbookName();
        state.worldbook.result = {
            ...result,
            name,
            createdAt: Date.now(),
        };
        state.worldbook.loadedNovelId = novelId;
        state.worldbook.editingIndex = null;
        state.worldbook.expanded = new Set();
        state.worldbook.undo = null;
        state.worldbook.ops.failed = [];
        await persistWorldbookResult();
        if (state.novelId !== novelId) return;
        renderWorldbookResult();
        setWorldbookProgress(result.incomplete ? `部分完成，${result.failedLabels.length} 块失败` : '完成', 100);
        setHeaderStatus('世界书已生成');
        if (result.incomplete) {
            toast(`世界书部分完成：${result.entries.length} 条，${result.failedLabels.length} 块失败；再次生成只补失败块`, 'warning');
        } else {
            toast(`世界书已生成：${result.entries.length} 条`, 'success');
        }
    } catch (error) {
        if (error?.name === 'AbortError' || isAbortError(error)) {
            setWorldbookProgress('已停止', 0);
            appendWorldbookLog('已停止');
            toast('已停止生成世界书');
        } else {
            console.error('[小说阅读器] 生成世界书失败', error);
            setWorldbookProgress(`失败：${error.message}`, 0);
            appendWorldbookLog(`失败：${error.message}`);
            toast(`生成世界书失败：${error.message}`, 'error');
        }
    } finally {
        state.worldbook.running = false;
        state.worldbook.abort = null;
        elements.wbStop.hidden = true;
        updateWorldbookBudget();
        if (!state.summary.running) orb?.classList.remove('nr-orb-busy');
        updateHeader();
    }
}

function stopWorldbook() {
    if (!state.worldbook.running || !state.worldbook.abort) return;
    state.worldbook.abort.abort();
    setWorldbookProgress('正在停止（等待当前请求结束）…', 0);
    appendWorldbookLog('正在停止…');
}

/* ------------------------------------------------------------------ */
/* 世界书条目整理与合并                                                */
/* ------------------------------------------------------------------ */

function worldbookCategoryLabels() {
    const labels = {};
    for (const category of WORLDBOOK_CATEGORIES) labels[category.key] = category.label;
    return labels;
}

function worldbookLimits(settings = getSettings()) {
    const limits = {};
    for (const category of WORLDBOOK_CATEGORIES) limits[category.key] = entryCharLimit(category.key, settings);
    return limits;
}

/** 在改动条目之前保存一份内存快照，用于「撤销」 */
function snapshotWorldbook(label) {
    const result = state.worldbook.result;
    if (!result?.entries) return;
    state.worldbook.undo = {
        entries: JSON.parse(JSON.stringify(result.entries)),
        name: result.name,
        label,
        at: Date.now(),
    };
    updateWorldbookUndoButton();
}

function updateWorldbookUndoButton() {
    if (!elements.wbUndo) return;
    const undo = state.worldbook.undo;
    elements.wbUndo.disabled = !undo || state.worldbook.ops.running;
    elements.wbUndo.title = undo ? `撤销：${undo.label}` : '没有可撤销的整理 / 合并操作';
}

async function undoWorldbookAction() {
    const undo = state.worldbook.undo;
    const result = state.worldbook.result;
    if (!undo || !result) return;
    if (state.worldbook.ops.running) {
        toast('请先等待当前整理完成或停止', 'warning');
        return;
    }
    result.entries = undo.entries;
    state.worldbook.undo = null;
    state.worldbook.ops.failed = [];
    state.worldbook.editingIndex = null;
    await persistWorldbookResult();
    renderWorldbookResult();
    updateWorldbookBudget();
    toast(`已撤销：${undo.label}`, 'success');
}

/** 结果区自动提示疑似重复条目 */
function renderWorldbookDuplicateHint() {
    if (!elements.wbDedupeHint) return;
    const entries = state.worldbook.result?.entries || [];
    if (entries.length < 2 || entries.length > 400) {
        elements.wbDedupeHint.hidden = true;
        return;
    }
    const groups = findDuplicateGroups(entries);
    if (!groups.length) {
        elements.wbDedupeHint.hidden = true;
        return;
    }
    elements.wbDedupeHint.hidden = false;
    elements.wbDedupeHint.textContent = `发现 ${groups.length} 组疑似重复条目`;
}

async function applyWorldbookEntries(entries, { toastMessage = '' } = {}) {
    const result = state.worldbook.result;
    if (!result) return;
    result.entries = entries;
    // 条目结构变化后，旧的失败记录（按索引定位）不再可信
    state.worldbook.ops.failed = [];
    state.worldbook.editingIndex = null;
    await persistWorldbookResult();
    renderWorldbookResult();
    updateWorldbookBudget();
    if (toastMessage) toast(toastMessage, 'success');
}

/* -------------------------- 通用弹窗 -------------------------- */

let dialogEscHandler = null;
let dialogCloseHandler = null;
/** 当前弹窗归属：worldbook 的弹窗关闭时才需要中止世界书任务 */
let dialogKind = 'worldbook';

function openWorldbookDialog({ title, body, footer = '', onMount = null, onClose = null, wide = false, kind = 'worldbook' }) {
    if (!elements.dialog) return null;
    dialogKind = kind;
    elements.dialog.querySelector('.nr-dialog-card')?.classList.toggle('is-wide', Boolean(wide));
    elements.dialogTitle.textContent = title;
    elements.dialogBody.innerHTML = body;
    elements.dialogFoot.innerHTML = footer;
    elements.dialogBody.scrollTop = 0;
    elements.dialogPreview.hidden = true;
    elements.previewBody.replaceChildren();
    elements.dialog.hidden = false;

    if (dialogEscHandler) {
        document.removeEventListener('keydown', dialogEscHandler, true);
        dialogEscHandler = null;
    }
    dialogCloseHandler = onClose;

    const close = () => closeWorldbookDialog();
    elements.dialogClose.onclick = close;
    elements.dialog.onclick = event => {
        if (event.target === elements.dialog) close();
    };
    dialogEscHandler = event => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        if (!elements.dialogPreview.hidden) {
            closeEntryPreview();
            return;
        }
        close();
    };
    document.addEventListener('keydown', dialogEscHandler, true);

    const ctx = {
        root: elements.dialog,
        body: elements.dialogBody,
        foot: elements.dialogFoot,
        close,
    };
    onMount?.(ctx);
    return ctx;
}

function closeWorldbookDialog() {
    if (!elements.dialog || elements.dialog.hidden) return;
    if (dialogKind === 'worldbook' && state.worldbook.ops.running) state.worldbook.ops.abort?.abort();
    dialogKind = 'worldbook';
    elements.dialog.hidden = true;
    elements.dialogPreview.hidden = true;
    elements.dialogBody.replaceChildren();
    elements.dialogFoot.replaceChildren();
    if (dialogEscHandler) {
        document.removeEventListener('keydown', dialogEscHandler, true);
        dialogEscHandler = null;
    }
    const handler = dialogCloseHandler;
    dialogCloseHandler = null;
    handler?.();
}

/** 在弹窗内打开条目详情（只读），不打断当前的勾选状态 */
function openEntryPreview(entry) {
    if (!entry || !elements.dialogPreview) return;
    const name = normalizeEntryName(entry.name) || '（未命名条目）';
    const meta = [];
    if (entry.categoryLabel) meta.push(entry.categoryLabel);
    else if (entry.category) meta.push(worldbookCategoryLabels()[entry.category] || entry.category);
    if (Array.isArray(entry.keywords) && entry.keywords.length) {
        meta.push(`关键词：${entry.keywords.join('、')}`);
    } else {
        meta.push('无关键词');
    }
    meta.push(`${formatCount(countChars(entry.content || ''))} 字`);
    meta.push(entry.enabled === false ? '未启用' : '启用');

    elements.previewTitle.textContent = name;
    elements.previewMeta.textContent = meta.join(' · ');
    elements.previewBody.textContent = String(entry.content || '').trim() || '（正文为空）';
    elements.previewBody.scrollTop = 0;
    elements.dialogPreview.hidden = false;
}

function closeEntryPreview() {
    if (elements.dialogPreview) elements.dialogPreview.hidden = true;
}

/** 生成「分类 → 条目多选」列表的 HTML */
function buildEntryPickerHtml(entries, options = {}) {
    const checked = typeof options.checked === 'function' ? options.checked : () => false;
    const groups = new Map();
    (entries || []).forEach((entry, index) => {
        const key = entry.category || entry.categoryLabel || 'other';
        if (!groups.has(key)) {
            groups.set(key, {
                label: entry.categoryLabel || worldbookCategoryLabels()[key] || key,
                items: [],
            });
        }
        groups.get(key).items.push({ entry, index });
    });

    if (!groups.size) return '<div class="nr-list-empty">没有可选的条目</div>';

    const parts = [];
    for (const [key, group] of groups) {
        parts.push(`<details class="nr-pick-group" open data-pick-group="${escapeHtml(key)}">`);
        parts.push(`<summary><span>${escapeHtml(group.label)}</span><em>${group.items.length} 条</em></summary>`);
        parts.push('<div class="nr-pick-group-body">');
        for (const { entry, index } of group.items) {
            const name = normalizeEntryName(entry.name) || `条目 ${index + 1}`;
            const keywords = Array.isArray(entry.keywords) ? entry.keywords.slice(0, 6).join('、') : '';
            const hint = `${keywords || '无关键词'} · ${formatCount(countChars(entry.content || ''))} 字`;
            parts.push('<label class="nr-pick-item"'
                + ` data-pick-name="${escapeHtml(name.toLowerCase())}"`
                + ` data-pick-keywords="${escapeHtml(keywords.toLowerCase())}">`
                + `<input type="checkbox" data-pick-index="${index}"${checked(entry, index) ? ' checked' : ''}>`
                + `<span class="nr-pick-name">${escapeHtml(name)}</span>`
                + `<em class="nr-pick-hint">${escapeHtml(hint)}</em>`
                + `<button type="button" class="nr-pick-view" data-pick-view="${index}" title="查看条目完整内容">查看</button>`
                + '</label>');
        }
        parts.push('</div></details>');
    }
    return parts.join('');
}

/** 绑定条目多选列表：筛选、全选、读取勾选 */
function bindEntryPicker(ctx, { onChange = () => {}, onView = null } = {}) {
    const body = ctx.body;
    // 弹窗主体是复用的同一个元素，用 onchange / onclick 覆盖而不是 addEventListener，避免弹窗切换后回调叠加
    body.onchange = event => {
        if (!event.target.closest('[data-pick-index]')) return;
        onChange();
    };
    body.onclick = event => {
        const button = event.target.closest('[data-pick-view]');
        if (!button) return;
        event.preventDefault();
        event.stopPropagation();
        onView?.(Number(button.dataset.pickView));
    };

    const filter = body.querySelector('[data-pick-filter]');
    filter?.addEventListener('input', () => {
        const query = filter.value.trim().toLowerCase();
        body.querySelectorAll('.nr-pick-group').forEach(group => {
            let visible = 0;
            group.querySelectorAll('.nr-pick-item').forEach(item => {
                const match = !query
                    || item.dataset.pickName.includes(query)
                    || item.dataset.pickKeywords.includes(query);
                item.hidden = !match;
                if (match) visible++;
            });
            group.hidden = visible === 0;
            if (query && visible) group.open = true;
        });
    });

    return {
        checkedIndexes() {
            return Array.from(body.querySelectorAll('[data-pick-index]:checked'))
                .map(input => Number(input.dataset.pickIndex))
                .filter(Number.isInteger);
        },
        setAll(checked) {
            body.querySelectorAll('[data-pick-index]').forEach(input => {
                input.checked = Boolean(checked);
            });
            onChange();
        },
        setOnly(predicate) {
            body.querySelectorAll('[data-pick-index]').forEach(input => {
                input.checked = Boolean(predicate(Number(input.dataset.pickIndex)));
            });
            onChange();
        },
    };
}

/* -------------------------- 整理条目 -------------------------- */

function openWorldbookOrganizeDialog() {
    if (state.worldbook.running) {
        toast('世界书正在生成，等完成后再整理', 'warning');
        return;
    }
    const result = state.worldbook.result;
    if (!result?.entries?.length) {
        toast('还没有世界书条目，先生成或新增条目', 'warning');
        return;
    }
    const settings = getSettings();
    let failed = (state.worldbook.ops.failed || []).reduce((list, item) => {
        const entry = result.entries[item.index];
        if (!entry || entry.category !== item.category) return list;
        list.push({ ...item, name: entry.name });
        return list;
    }, []);
    state.worldbook.ops.failed = failed;
    const failedIndexes = new Set(failed.map(item => item.index));
    const presets = ORGANIZE_PROMPT_PRESETS
        .map(preset => `<button type="button" class="nr-link" data-org-preset="${preset.key}">${escapeHtml(preset.label)}</button>`)
        .join('');

    const body = `
        <div class="nr-dialog-hint">本地整理会合并同名小标题、删除重复段落，不消耗模型请求；AI 整理会把每条正文发给模型重写，按条目消耗请求。整理前会自动保存快照，可用「撤销」回退。</div>
        <div class="nr-dialog-section">
            <div class="nr-dialog-sec-head">
                <strong>整理方式</strong>
                <div class="nr-radio-row">
                    <label><input type="radio" name="nr-org-mode" value="local" checked> 本地整理</label>
                    <label><input type="radio" name="nr-org-mode" value="ai"> AI 整理（消耗请求）</label>
                </div>
            </div>
            <div class="nr-org-prompt-wrap" hidden>
                <div class="nr-dialog-sec-head">
                    <strong>整理提示词</strong>
                    <div class="nr-mini-tools">${presets}</div>
                </div>
                <textarea id="nr-org-prompt" class="nr-input nr-wb-textarea" rows="6"></textarea>
                <p class="nr-help"><code>{CONTENT}</code> 会替换成条目原文，也可以用 <code>{NAME}</code> 和 <code>{CATEGORY}</code>。</p>
            </div>
        </div>
        <div class="nr-dialog-section">
            <div class="nr-dialog-sec-head">
                <strong>选择条目</strong>
                <span class="nr-muted" id="nr-org-count">已选 0 条</span>
                <div class="nr-mini-tools">
                    <button type="button" class="nr-link" data-org-pick="all">全选</button>
                    <button type="button" class="nr-link" data-org-pick="none">全不选</button>
                    ${failed.length ? '<button type="button" class="nr-link" data-org-pick="failed">只选失败项</button>' : ''}
                </div>
            </div>
            <div class="nr-dialog-note" id="nr-org-failed-note" hidden></div>
            <input id="nr-org-filter" class="nr-input nr-input-sm" data-pick-filter="1" placeholder="筛选条目名 / 关键词…">
            <div class="nr-pick-list">${buildEntryPickerHtml(result.entries, {
                checked: (entry, index) => failedIndexes.has(index),
            })}</div>
        </div>
        <div class="nr-dialog-status" id="nr-org-status"></div>
        <div class="nr-org-failed" id="nr-org-failed" hidden></div>
    `;
    const footer = '<button type="button" class="nr-btn" data-org-act="cancel">取消</button>'
        + '<button type="button" class="nr-btn" data-org-act="retry" hidden>重试失败</button>'
        + '<button type="button" class="nr-btn nr-primary" data-org-act="start" disabled>开始整理</button>';

    const ctx = openWorldbookDialog({ title: '整理世界书条目', body, footer });
    if (!ctx) return;

    const countLabel = ctx.body.querySelector('#nr-org-count');
    const status = ctx.body.querySelector('#nr-org-status');
    const promptWrap = ctx.body.querySelector('.nr-org-prompt-wrap');
    const promptInput = ctx.body.querySelector('#nr-org-prompt');
    const startBtn = ctx.foot.querySelector('[data-org-act="start"]');
    const retryBtn = ctx.foot.querySelector('[data-org-act="retry"]');
    const failedNote = ctx.body.querySelector('#nr-org-failed-note');
    promptInput.value = settings.worldbookOrganizePrompt || defaultOrganizePrompt();

    const picker = bindEntryPicker(ctx, {
        onChange: updateState,
        onView: index => openEntryPreview(result.entries[index]),
    });
    const currentMode = () => (ctx.body.querySelector('input[name="nr-org-mode"]:checked')?.value === 'ai' ? 'ai' : 'local');

    function updateState() {
        const total = picker.checkedIndexes().length;
        countLabel.textContent = `已选 ${total} 条`;
        retryBtn.disabled = state.worldbook.ops.running;
        if (state.worldbook.ops.running) return;
        startBtn.disabled = total === 0;
        if (total === 0) startBtn.textContent = '开始整理';
        else startBtn.textContent = currentMode() === 'ai' ? `AI 整理 ${total} 条` : `开始整理 ${total} 条`;
    }

    function syncFailures() {
        state.worldbook.ops.failed = failed;
        failedNote.hidden = failed.length === 0;
        failedNote.textContent = failed.length
            ? `上次有 ${failed.length} 个条目整理失败，失败条目已保留原内容，可在下方直接重试。`
            : '';
        retryBtn.hidden = failed.length === 0;
        retryBtn.textContent = `重试失败 ${failed.length} 条`;
        retryBtn.disabled = state.worldbook.ops.running;

        const box = ctx.body.querySelector('#nr-org-failed');
        if (!box) return;
        box.hidden = failed.length === 0;
        box.replaceChildren();
        if (!failed.length) return;
        box.appendChild(createElement('div', 'nr-org-failed-head', '失败条目（点「重试」只重跑这一条）'));
        failed.forEach(item => {
            const row = createElement('div', 'nr-org-fail-row');
            row.appendChild(createElement('span', 'nr-org-fail-name', item.name || '未命名条目'));
            row.appendChild(createElement('em', null, item.error || '未知错误'));
            const view = createElement('button', 'nr-link', '查看');
            view.type = 'button';
            view.addEventListener('click', () => openEntryPreview(result.entries[item.index]));
            const retry = createElement('button', 'nr-link', '重试');
            retry.type = 'button';
            retry.disabled = state.worldbook.ops.running;
            retry.addEventListener('click', () => { startAi([item.index]); });
            row.appendChild(view);
            row.appendChild(retry);
            box.appendChild(row);
        });
    }

    function setFailed(next) {
        failed = (next || []).reduce((list, item) => {
            const entry = result.entries[item.index];
            if (!entry || entry.category !== item.category) return list;
            list.push({ ...item, name: entry.name });
            return list;
        }, []);
        syncFailures();
        updateState();
    }

    async function startAi(indexes) {
        if (!indexes.length || state.worldbook.ops.running) return;
        retryBtn.hidden = true;
        try {
            const outcome = await runAiOrganize({
                ctx,
                indexes,
                template: promptInput.value,
                result,
                startBtn,
                status,
                updateState,
            });
            setFailed(outcome?.failed || []);
        } catch (error) {
            toast(`AI 整理失败：${error.message}`, 'error');
            setFailed(state.worldbook.ops.failed || failed);
        }
    }

    ctx.body.querySelectorAll('input[name="nr-org-mode"]').forEach(radio => {
        radio.addEventListener('change', () => {
            promptWrap.hidden = currentMode() !== 'ai';
            updateState();
        });
    });
    ctx.body.querySelectorAll('[data-org-preset]').forEach(button => {
        button.addEventListener('click', () => {
            const preset = ORGANIZE_PROMPT_PRESETS.find(item => item.key === button.dataset.orgPreset);
            if (preset) promptInput.value = preset.text;
        });
    });
    ctx.body.querySelectorAll('[data-org-pick]').forEach(button => {
        button.addEventListener('click', () => {
            const action = button.dataset.orgPick;
            if (action === 'all') picker.setAll(true);
            else if (action === 'none') picker.setAll(false);
            else if (action === 'failed') {
                const indexes = new Set(failed.map(item => item.index));
                picker.setOnly(index => indexes.has(index));
            }
        });
    });
    ctx.foot.querySelector('[data-org-act="cancel"]').addEventListener('click', () => ctx.close());
    retryBtn.addEventListener('click', () => {
        startAi(failed.map(item => item.index));
    });

    startBtn.addEventListener('click', async () => {
        if (state.worldbook.ops.running) {
            state.worldbook.ops.abort?.abort();
            startBtn.disabled = true;
            startBtn.textContent = '正在停止…';
            return;
        }
        const indexes = picker.checkedIndexes();
        if (!indexes.length) {
            toast('先勾选要整理的条目', 'warning');
            return;
        }

        if (currentMode() === 'local') {
            snapshotWorldbook('本地整理');
            const limits = worldbookLimits();
            const next = organizeWorldbookEntries(result.entries, {
                indexes,
                limitFor: category => limits[category] || 0,
            });
            await applyWorldbookEntries(next, { toastMessage: `已本地整理 ${indexes.length} 条` });
            ctx.close();
            return;
        }

        await startAi(indexes);
    });

    syncFailures();
    updateState();
}

async function runAiOrganize({ ctx, indexes, template, result, startBtn, status, updateState }) {
    const settings = getSettings();
    const budget = computeBudget(settings);
    const limits = worldbookLimits(settings);
    const concurrency = clamp(Number(settings.worldbookConcurrency) || 2, 1, 4);
    const custom = String(template || '').trim();
    settings.worldbookOrganizePrompt = custom === defaultOrganizePrompt() ? '' : custom;
    saveSettings();

    snapshotWorldbook('AI 整理');
    state.worldbook.ops.running = true;
    state.worldbook.ops.abort = new AbortController();
    state.worldbook.ops.failed = [];
    updateWorldbookUndoButton();
    const signal = state.worldbook.ops.abort.signal;
    const failed = [];
    let done = 0;

    startBtn.textContent = '停止整理';
    startBtn.classList.remove('nr-primary');
    startBtn.disabled = false;
    const setStatus = (text) => {
        if (elements.dialog.hidden) return;
        status.textContent = text ?? `AI 整理中：成功 ${done} / ${indexes.length}，失败 ${failed.length}`;
    };
    setStatus();

    try {
        await mapLimit(indexes, concurrency, async (index) => {
            if (signal.aborted) return;
            const entry = result.entries[index];
            if (!entry) return;
            try {
                const chars = countChars(entry.content || '');
                const desired = clamp(Math.ceil(chars * 1.8) + 240, 600, 8192);
                const maxTokens = Math.min(desired, Math.max(600, Math.floor(budget.ctxTokens * 0.45)));
                const text = await callWithRetry({
                    system: ORGANIZE_SYSTEM_PROMPT,
                    user: buildOrganizePrompt(template, entry),
                    maxTokens,
                    maxTokenLimit: Math.max(800, Math.floor(budget.ctxTokens * 0.5)),
                    settings,
                    signal,
                    label: `整理「${entry.name}」`,
                    onProgress: () => {},
                    stats: { calls: 0 },
                });
                if (signal.aborted) return;
                const parsed = parseOrganizeResponse(text);
                entry.content = trimToLimit(parsed, limits[entry.category] || limits.character || 600);
                done++;
            } catch (error) {
                if (isAbortError(error) || signal.aborted) return;
                failed.push({
                    index,
                    category: entry.category,
                    name: entry.name,
                    error: error.message,
                });
            }
            setStatus();
        });
    } finally {
        const aborted = signal.aborted;
        state.worldbook.ops.running = false;
        state.worldbook.ops.abort = null;
        state.worldbook.ops.failed = failed;
        startBtn.textContent = '开始整理';
        startBtn.classList.add('nr-primary');
        updateState();
        await persistWorldbookResult();
        renderWorldbookResult();
        updateWorldbookBudget();
        updateWorldbookUndoButton();
        const summary = `成功 ${done} 条，失败 ${failed.length} 条`;
        setStatus(aborted ? `已停止：${summary}（失败条目保留原内容）` : `整理完成：${summary}${failed.length ? '（失败条目保留原内容）' : ''}`);
        toast(aborted ? `已停止整理：${summary}` : `整理完成：${summary}`, failed.length ? 'warning' : 'success');
        void ctx;
    }
    return { done, failed, aborted: signal.aborted };
}

/* -------------------------- 合并条目 -------------------------- */

function openWorldbookMergeDialog() {
    if (state.worldbook.running) {
        toast('世界书正在生成，等完成后再合并', 'warning');
        return;
    }
    const result = state.worldbook.result;
    if (!result?.entries?.length) {
        toast('还没有世界书条目，先生成或新增条目', 'warning');
        return;
    }
    if (result.entries.length < 2) {
        toast('至少需要 2 个条目才能合并', 'warning');
        return;
    }
    const labels = worldbookCategoryLabels();
    const categoryOptions = WORLDBOOK_CATEGORIES
        .map(category => `<option value="${category.key}">${escapeHtml(category.label)}</option>`)
        .join('');
    const body = `
        <div class="nr-dialog-hint">勾选 2 个及以上条目，把它们合并成一条。支持跨分类合并，合并后归入你选择的分类；合并前会自动保存快照，可用「撤销」回退。</div>
        <div class="nr-dialog-section">
            <div class="nr-dialog-sec-head">
                <strong>选择条目</strong>
                <span class="nr-muted" id="nr-merge-count">已选 0 条</span>
                <div class="nr-mini-tools">
                    <button type="button" class="nr-link" data-merge-pick="all">全选</button>
                    <button type="button" class="nr-link" data-merge-pick="none">全不选</button>
                </div>
            </div>
            <input id="nr-merge-filter" class="nr-input nr-input-sm" data-pick-filter="1" placeholder="筛选条目名 / 关键词…">
            <div class="nr-pick-list">${buildEntryPickerHtml(result.entries)}</div>
        </div>
        <div class="nr-dialog-section">
            <div class="nr-dialog-sec-head"><strong>合并设置</strong></div>
            <div class="nr-merge-config">
                <label class="nr-field"><span>合并后的条目名</span><input id="nr-merge-name" class="nr-input" placeholder="留空时自动选择最合适的名字"></label>
                <label class="nr-field"><span>归入分类</span><select id="nr-merge-category" class="nr-select">${categoryOptions}</select></label>
                <label class="nr-check"><input type="checkbox" id="nr-merge-separator" checked><span>用分隔线分开各段正文</span></label>
                <label class="nr-check"><input type="checkbox" id="nr-merge-organize" checked><span>合并后自动整理正文（合并同名小标题、去重段落）</span></label>
            </div>
        </div>
    `;
    const footer = '<button type="button" class="nr-btn" data-merge-act="cancel">取消</button>'
        + '<button type="button" class="nr-btn nr-primary" data-merge-act="start" disabled>合并选中</button>';

    const ctx = openWorldbookDialog({ title: '合并世界书条目', body, footer });
    if (!ctx) return;

    const countLabel = ctx.body.querySelector('#nr-merge-count');
    const nameInput = ctx.body.querySelector('#nr-merge-name');
    const categorySelect = ctx.body.querySelector('#nr-merge-category');
    const separatorInput = ctx.body.querySelector('#nr-merge-separator');
    const organizeInput = ctx.body.querySelector('#nr-merge-organize');
    const startBtn = ctx.foot.querySelector('[data-merge-act="start"]');
    let nameTouched = false;
    let categoryTouched = false;

    const picker = bindEntryPicker(ctx, {
        onChange: updateState,
        onView: index => openEntryPreview(result.entries[index]),
    });

    function updateState() {
        const indexes = picker.checkedIndexes();
        countLabel.textContent = `已选 ${indexes.length} 条`;
        startBtn.disabled = indexes.length < 2;
        startBtn.textContent = indexes.length >= 2 ? `合并 ${indexes.length} 条` : '合并选中';
        if (!indexes.length) return;
        if (!nameTouched) {
            nameInput.value = pickMainName(indexes.map(index => result.entries[index]).filter(Boolean));
        }
        if (!categoryTouched) {
            categorySelect.value = result.entries[indexes[0]]?.category || categorySelect.value;
        }
    }

    nameInput.addEventListener('input', () => { nameTouched = true; });
    categorySelect.addEventListener('change', () => { categoryTouched = true; });
    ctx.body.querySelectorAll('[data-merge-pick]').forEach(button => {
        button.addEventListener('click', () => picker.setAll(button.dataset.mergePick === 'all'));
    });
    ctx.foot.querySelector('[data-merge-act="cancel"]').addEventListener('click', () => ctx.close());

    startBtn.addEventListener('click', async () => {
        const indexes = picker.checkedIndexes();
        if (indexes.length < 2) return;
        const name = normalizeEntryName(nameInput.value);
        const ok = await confirmAction(`把选中的 ${indexes.length} 个条目合并为「${name || '自动命名'}」？原条目会被删除，可用「撤销」回退。`);
        if (!ok) return;

        snapshotWorldbook('合并条目');
        try {
            const settings = getSettings();
            const limits = worldbookLimits(settings);
            const merged = mergeEntries(result.entries, {
                indexes,
                name,
                category: categorySelect.value,
                categoryLabels: labels,
                separator: separatorInput.checked,
                organize: organizeInput.checked,
                keywordLimit: 24,
            });
            const next = mergeWorldbookEntries(merged.entries, {
                entryChars: settings.worldbookEntryChars,
                limits,
            });
            await applyWorldbookEntries(next, { toastMessage: `已合并 ${indexes.length} 个条目为「${merged.merged.name}」` });
            ctx.close();
        } catch (error) {
            toast(`合并失败：${error.message}`, 'error');
        }
    });

    updateState();
}

/* -------------------------- 查重合并 -------------------------- */

function openWorldbookDuplicateDialog() {
    if (state.worldbook.running) {
        toast('世界书正在生成，等完成后再查重', 'warning');
        return;
    }
    const result = state.worldbook.result;
    if (!result?.entries?.length) {
        toast('还没有世界书条目，先生成或新增条目', 'warning');
        return;
    }
    const groups = findDuplicateGroups(result.entries);
    const checkedIds = new Set(groups.map(group => group.id));

    const body = `
        <div class="nr-dialog-hint">按「名称包含 / 共享关键词 / 尾名相同」找出同一分类里的疑似重复条目。可以先让 AI 复核每一组是否指同一对象，再勾选要合并的组；合并前会自动保存快照。</div>
        <div class="nr-dialog-section">
            <div class="nr-dialog-sec-head">
                <strong>疑似重复</strong>
                <span class="nr-muted" id="nr-dup-count"></span>
                <div class="nr-mini-tools">
                    <button type="button" class="nr-link" data-dup-pick="all">全选</button>
                    <button type="button" class="nr-link" data-dup-pick="none">全不选</button>
                </div>
            </div>
            <div class="nr-dup-list" id="nr-dup-list"></div>
        </div>
        <div class="nr-dialog-status" id="nr-dup-status"></div>
    `;
    const footer = '<button type="button" class="nr-btn" data-dup-act="cancel">取消</button>'
        + '<button type="button" class="nr-btn" data-dup-act="verify">AI 复核</button>'
        + '<button type="button" class="nr-btn nr-primary" data-dup-act="start" disabled>合并勾选</button>';

    const ctx = openWorldbookDialog({ title: '查重合并', body, footer });
    if (!ctx) return;

    const list = ctx.body.querySelector('#nr-dup-list');
    const countLabel = ctx.body.querySelector('#nr-dup-count');
    const status = ctx.body.querySelector('#nr-dup-status');
    const verifyBtn = ctx.foot.querySelector('[data-dup-act="verify"]');
    const startBtn = ctx.foot.querySelector('[data-dup-act="start"]');

    function groupEntries(group) {
        return group.indexes.map(index => result.entries[index]).filter(Boolean);
    }

    function updateState() {
        countLabel.textContent = groups.length ? `${groups.length} 组，已勾选 ${checkedIds.size} 组` : '没有发现疑似重复';
        startBtn.disabled = checkedIds.size === 0 || state.worldbook.ops.running;
        startBtn.textContent = checkedIds.size ? `合并 ${checkedIds.size} 组` : '合并勾选';
        verifyBtn.disabled = groups.length === 0 || state.worldbook.ops.running;
    }

    function renderGroups() {
        if (!groups.length) {
            list.innerHTML = '<div class="nr-list-empty">没有发现疑似重复条目。也可以回到列表用「合并条目」手动选择。</div>';
            updateState();
            return;
        }
        list.innerHTML = groups.map(group => {
            const entries = groupEntries(group);
            const label = group.categoryLabel || worldbookCategoryLabels()[group.category] || group.category;
            const verdict = group.judgement;
            let badge = '';
            if (verdict?.same === true) badge = '<span class="nr-dup-verdict is-same">AI：同一对象</span>';
            else if (verdict?.same === false) badge = '<span class="nr-dup-verdict is-diff">AI：不是同一对象</span>';
            else if (verdict) badge = '<span class="nr-dup-verdict">复核失败</span>';
            const entryLines = group.indexes.map(index => {
                const entry = result.entries[index];
                if (!entry) return '';
                const keywords = Array.isArray(entry.keywords) ? entry.keywords.slice(0, 5).join('、') : '';
                const snippet = String(entry.content || '').replace(/\s+/g, ' ').slice(0, 90);
                return `<div class="nr-dup-entry"><strong>${escapeHtml(normalizeEntryName(entry.name))}</strong>`
                    + `<span>${escapeHtml(keywords || '无关键词')}</span>`
                    + `<em>${escapeHtml(snippet)}${snippet.length >= 90 ? '…' : ''}</em>`
                    + `<button type="button" class="nr-link nr-dup-view" data-dup-view="${index}" title="查看条目完整内容">查看</button>`
                    + '</div>';
            }).join('');
            const reason = verdict?.reason
                ? `<div class="nr-dup-reason">${escapeHtml(verdict.reason)}</div>`
                : '';
            return `<label class="nr-dup-group">
                <input type="checkbox" data-dup-id="${escapeHtml(group.id)}"${checkedIds.has(group.id) ? ' checked' : ''}>
                <div class="nr-dup-main">
                    <div class="nr-dup-head">
                        <span class="nr-badge">${escapeHtml(label)}</span>
                        <span class="nr-muted">${entries.length} 条</span>
                        <em>${escapeHtml(group.reason)}</em>
                        ${badge}
                    </div>
                    <div class="nr-dup-entries">${entryLines}</div>
                    ${reason}
                    <div class="nr-dup-name">合并后名称：<strong>${escapeHtml(group.mainName || '（自动）')}</strong></div>
                </div>
            </label>`;
        }).join('');
        updateState();
    }

    list.addEventListener('change', event => {
        const checkbox = event.target.closest('[data-dup-id]');
        if (!checkbox) return;
        if (checkbox.checked) checkedIds.add(checkbox.dataset.dupId);
        else checkedIds.delete(checkbox.dataset.dupId);
        updateState();
    });

    list.addEventListener('click', event => {
        const button = event.target.closest('[data-dup-view]');
        if (!button) return;
        event.preventDefault();
        event.stopPropagation();
        openEntryPreview(result.entries[Number(button.dataset.dupView)]);
    });

    ctx.body.querySelectorAll('[data-dup-pick]').forEach(button => {
        button.addEventListener('click', () => {
            if (button.dataset.dupPick === 'all') groups.forEach(group => checkedIds.add(group.id));
            else checkedIds.clear();
            renderGroups();
        });
    });
    ctx.foot.querySelector('[data-dup-act="cancel"]').addEventListener('click', () => ctx.close());

    verifyBtn.addEventListener('click', async () => {
        if (state.worldbook.ops.running) {
            state.worldbook.ops.abort?.abort();
            return;
        }
        if (!groups.length) return;
        const settings = getSettings();
        const budget = computeBudget(settings);
        const concurrency = clamp(Number(settings.worldbookConcurrency) || 2, 1, 3);
        state.worldbook.ops.running = true;
        state.worldbook.ops.abort = new AbortController();
        updateWorldbookUndoButton();
        const signal = state.worldbook.ops.abort.signal;
        let checkedCount = 0;
        verifyBtn.textContent = '停止复核';
        startBtn.disabled = true;
        if (!elements.dialog.hidden) status.textContent = `AI 复核中：0 / ${groups.length} 组`;

        try {
            await mapLimit(groups, concurrency, async (group) => {
                if (signal.aborted) return;
                const entries = groupEntries(group);
                if (!entries.length) return;
                try {
                    const text = await callWithRetry({
                        system: DUPLICATE_JUDGE_SYSTEM_PROMPT,
                        user: buildDuplicateJudgePrompt({
                            categoryLabel: group.categoryLabel,
                            entries,
                        }),
                        maxTokens: 400,
                        maxTokenLimit: Math.max(600, Math.floor(budget.ctxTokens * 0.3)),
                        settings,
                        signal,
                        label: `复核「${(group.names || []).join(' / ')}」`,
                        onProgress: () => {},
                        stats: { calls: 0 },
                    });
                    if (signal.aborted) return;
                    const parsed = parseDuplicateJudgement(text);
                    if (!parsed) {
                        group.judgement = { same: null, reason: '模型没有返回可解析的判断，已保留勾选，请手动确认' };
                    } else {
                        group.judgement = parsed;
                        if (parsed.same && parsed.mainName) group.mainName = parsed.mainName;
                        if (parsed.same) checkedIds.add(group.id);
                        else checkedIds.delete(group.id);
                    }
                } catch (error) {
                    if (isAbortError(error) || signal.aborted) return;
                    group.judgement = { same: null, reason: `复核失败：${error.message}` };
                }
                checkedCount++;
                if (!elements.dialog.hidden) status.textContent = `AI 复核中：${checkedCount} / ${groups.length} 组`;
            });
        } finally {
            const aborted = signal.aborted;
            state.worldbook.ops.running = false;
            state.worldbook.ops.abort = null;
            updateWorldbookUndoButton();
            verifyBtn.textContent = 'AI 复核';
            if (!elements.dialog.hidden) {
                status.textContent = aborted
                    ? '已停止复核，未完成的组保持原勾选。'
                    : `复核完成：${groups.length} 组，已按判断更新勾选。`;
            }
            renderGroups();
        }
    });

    startBtn.addEventListener('click', async () => {
        const selected = groups.filter(group => checkedIds.has(group.id));
        if (!selected.length) return;
        const ok = await confirmAction(`合并选中的 ${selected.length} 组疑似重复条目？原条目会被删除，可用「撤销」回退。`);
        if (!ok) return;

        snapshotWorldbook('查重合并');
        try {
            const settings = getSettings();
            const limits = worldbookLimits(settings);
            const planned = mergeDuplicateGroups(result.entries, selected, {
                categoryLabels: worldbookCategoryLabels(),
                separator: true,
                organize: true,
                maxChars: category => limits[category] || 0,
            });
            const next = mergeWorldbookEntries(planned.entries, {
                entryChars: settings.worldbookEntryChars,
                limits,
            });
            await applyWorldbookEntries(next, { toastMessage: `已合并 ${planned.mergedGroups} 组重复条目` });
            ctx.close();
        } catch (error) {
            toast(`合并失败：${error.message}`, 'error');
        }
    });

    renderGroups();
}

function bindWorldbookEvents() {
    if (!panel || !elements.wbSelect) return;
    elements.wbSelect.addEventListener('change', () => openNovel(elements.wbSelect.value, 'worldbook'));

    panel.querySelectorAll('input[name="nr-wb-scope"]').forEach(input => {
        input.addEventListener('change', () => {
            renderWorldbookChapters();
            updateWorldbookBudget();
        });
    });
    panel.querySelectorAll('[data-wb-scope-act]').forEach(button => {
        button.addEventListener('click', () => {
            const action = button.dataset.wbScopeAct;
            if (getWorldbookScope() === 'all') {
                const selectedRadio = panel.querySelector('input[name="nr-wb-scope"][value="selected"]');
                if (selectedRadio) {
                    selectedRadio.checked = true;
                    selectedRadio.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }
            if (action === 'all') state.wbSelection = new Set(state.chapters.map(chapter => chapter.index));
            else if (action === 'none') state.wbSelection.clear();
            else if (action === 'invert') {
                state.wbSelection = new Set(state.chapters
                    .filter(chapter => !state.wbSelection.has(chapter.index))
                    .map(chapter => chapter.index));
            }
            renderWorldbookChapters();
            updateWorldbookBudget();
        });
    });
    elements.wbFilter.addEventListener('input', debounce(renderWorldbookChapters, 150));
    elements.wbChapters.addEventListener('click', event => {
        const label = event.target.closest('[data-chapter-index]');
        if (!label) return;
        const index = Number(label.dataset.chapterIndex);
        const checkbox = label.querySelector('input[type="checkbox"]');
        if (event.target === checkbox && event.shiftKey && state.wbSelectionAnchor != null) {
            const start = Math.min(state.wbSelectionAnchor, index);
            const end = Math.max(state.wbSelectionAnchor, index);
            for (const chapter of state.chapters) {
                if (chapter.index < start || chapter.index > end) continue;
                if (checkbox.checked) state.wbSelection.add(chapter.index);
                else state.wbSelection.delete(chapter.index);
            }
            renderWorldbookChapters();
            updateWorldbookBudget();
        }
        state.wbSelectionAnchor = index;
    });
    elements.wbChapters.addEventListener('change', event => {
        const checkbox = event.target.closest('input[type="checkbox"]');
        if (!checkbox) return;
        const index = Number(checkbox.dataset.index);
        if (checkbox.checked) state.wbSelection.add(index);
        else state.wbSelection.delete(index);
        renderWorldbookChapters();
        updateWorldbookBudget();
    });

    elements.wbCats.addEventListener('change', event => {
        const checkbox = event.target.closest('[data-wb-cat]');
        if (!checkbox) return;
        const settings = getSettings();
        settings.worldbookCategories = {
            ...worldbookCategoryFlags(),
            [checkbox.dataset.wbCat]: checkbox.checked,
        };
        saveSettings();
        updateWorldbookBudget();
    });
    elements.wbChunkChars.addEventListener('change', () => {
        const settings = getSettings();
        settings.worldbookChunkChars = clamp(Number(elements.wbChunkChars.value) || 9000, 1200, 30000);
        elements.wbChunkChars.value = String(settings.worldbookChunkChars);
        saveSettings();
        updateWorldbookBudget();
    });
    elements.wbConcurrency.addEventListener('change', () => {
        const settings = getSettings();
        settings.worldbookConcurrency = clamp(Number(elements.wbConcurrency.value) || 2, 1, 4);
        saveSettings();
        updateWorldbookBudget();
    });
    elements.wbEntryChars.addEventListener('change', () => {
        const settings = getSettings();
        settings.worldbookEntryChars = clamp(Number(elements.wbEntryChars.value) || 600, 120, 2000);
        elements.wbEntryChars.value = String(settings.worldbookEntryChars);
        saveSettings();
    });
    elements.wbPlotEntries?.addEventListener('change', () => {
        const settings = getSettings();
        settings.worldbookPlotEntries = clamp(Number(elements.wbPlotEntries.value) || 4, 1, 12);
        elements.wbPlotEntries.value = String(settings.worldbookPlotEntries);
        saveSettings();
        updateWorldbookBudget();
    });
    elements.styleSelect?.addEventListener('change', () => {
        const novelId = elements.styleSelect.value;
        if (novelId) openNovel(novelId, 'style');
        updateStyleControls();
    });
    elements.styleEntry?.addEventListener('change', () => {
        state.style.entryId = elements.styleEntry.value || '';
        renderStyleEntryHelp();
        renderStyleFormat();
        updateStyleControls();
    });
    elements.styleRefresh?.addEventListener('click', () => {
        refreshStylePreset({ silent: true });
        toast('已重新读取酒馆当前选用的预设', 'info');
    });
    elements.styleRun?.addEventListener('click', () => {
        startStyleGeneration().catch(error => {
            console.error('[小说阅读器] 生成文风失败', error);
            toast(`生成文风失败：${error.message}`, 'error');
        });
    });
    elements.styleAgain?.addEventListener('click', () => {
        startStyleGeneration().catch(error => {
            console.error('[小说阅读器] 生成文风失败', error);
            toast(`生成文风失败：${error.message}`, 'error');
        });
    });
    elements.styleStop?.addEventListener('click', stopStyleGeneration);
    elements.styleCopy?.addEventListener('click', () => {
        copyStyleOutput().catch(error => toast(`复制失败：${error.message}`, 'error'));
    });
    elements.styleOutput?.addEventListener('input', () => {
        if (state.style.result) state.style.result.text = elements.styleOutput.value;
    });

    elements.importCard?.addEventListener('change', () => {
        const settings = getSettings();
        settings.importCard = Boolean(elements.importCard.checked);
        saveSettings();
    });
    elements.autoImportLorebook?.addEventListener('change', () => {
        const settings = getSettings();
        settings.autoImportLorebook = Boolean(elements.autoImportLorebook.checked);
        saveSettings();
    });
    elements.wbExtra.addEventListener('change', () => {
        const settings = getSettings();
        settings.worldbookExtraInstruction = elements.wbExtra.value.trim();
        saveSettings();
    });

    elements.wbImport.addEventListener('click', () => elements.wbFile.click());
    elements.wbFile.addEventListener('change', async () => {
        const files = Array.from(elements.wbFile.files || []);
        elements.wbFile.value = '';
        if (files.length) await importFiles(files, { tab: 'worldbook' });
    });

    elements.wbRun.addEventListener('click', () => startWorldbook());
    elements.wbStop.addEventListener('click', stopWorldbook);
    elements.wbName.addEventListener('input', () => {
        const result = state.worldbook.result;
        if (!result) return;
        result.name = String(elements.wbName.value || '').trim() || defaultWorldbookName();
    });
    elements.wbName.addEventListener('change', () => {
        const result = state.worldbook.result;
        if (!result) return;
        result.name = String(elements.wbName.value || '').trim() || defaultWorldbookName();
        const settings = getSettings();
        settings.worldbookName = result.name;
        saveSettings();
        persistWorldbookResult();
    });

    panel.querySelector('#nr-wb-import-tavern')?.addEventListener('click', importWorldbookToTavern);
    panel.querySelector('#nr-wb-download-card').addEventListener('click', downloadWorldbookCharacterCard);
    panel.querySelector('#nr-wb-download').addEventListener('click', downloadWorldbook);
    elements.wbToStyle?.addEventListener('click', () => {
        showTab('style');
        refreshStylePreset({ silent: true });
    });
    panel.querySelector('#nr-wb-clear').addEventListener('click', clearWorldbookResult);
    elements.wbOrganize?.addEventListener('click', openWorldbookOrganizeDialog);
    elements.wbMerge?.addEventListener('click', openWorldbookMergeDialog);
    elements.wbDedupe?.addEventListener('click', openWorldbookDuplicateDialog);
    elements.wbUndo?.addEventListener('click', undoWorldbookAction);
    panel.querySelector('#nr-wb-select-all').addEventListener('click', () => {
        for (const entry of state.worldbook.result?.entries || []) entry.enabled = true;
        persistWorldbookResult();
        renderWorldbookResult();
    });
    panel.querySelector('#nr-wb-select-none').addEventListener('click', () => {
        for (const entry of state.worldbook.result?.entries || []) entry.enabled = false;
        persistWorldbookResult();
        renderWorldbookResult();
    });
    panel.querySelector('#nr-wb-add-entry').addEventListener('click', () => {
        const result = state.worldbook.result;
        if (!result) return;
        const first = WORLDBOOK_CATEGORIES.find(category => worldbookCategoryFlags()[category.key]) || WORLDBOOK_CATEGORIES[0];
        result.entries.push({
            category: first.key,
            categoryLabel: first.label,
            name: '新条目',
            keywords: ['新条目'],
            content: '',
            enabled: true,
        });
        renderWorldbookEntryEditor(result.entries.length - 1);
    });

    elements.wbEntries.addEventListener('change', event => {
        const checkbox = event.target.closest('[data-wb-toggle]');
        if (!checkbox) return;
        const entry = state.worldbook.result?.entries?.[Number(checkbox.dataset.wbToggle)];
        if (!entry) return;
        entry.enabled = checkbox.checked;
        persistWorldbookResult();
        renderWorldbookResult();
    });
    elements.wbEntries.addEventListener('click', async event => {
        const groupAction = event.target.closest('[data-wb-group-act]');
        if (groupAction) {
            const key = groupAction.dataset.wbGroupKey;
            const nextEnabled = groupAction.dataset.wbGroupAct === 'select';
            let changed = false;
            for (const entry of state.worldbook.result?.entries || []) {
                const category = worldbookCategoryOf(entry);
                const entryKey = category?.key || `other:${entry.categoryLabel || '其他'}`;
                if (entryKey !== key) continue;
                if ((entry.enabled !== false) !== nextEnabled) {
                    entry.enabled = nextEnabled;
                    changed = true;
                }
            }
            if (changed) {
                await persistWorldbookResult();
                renderWorldbookResult();
            }
            return;
        }
        const action = event.target.closest('[data-wb-act]');
        if (!action) return;
        const index = Number(action.dataset.wbIndex);
        if (action.dataset.wbAct === 'edit') {
            renderWorldbookEntryEditor(index);
        } else if (action.dataset.wbAct === 'save-edit') {
            await saveWorldbookEntry(index);
        } else if (action.dataset.wbAct === 'cancel-edit') {
            state.worldbook.editingIndex = null;
            renderWorldbookResult();
        } else if (action.dataset.wbAct === 'delete') {
            await deleteWorldbookEntry(index);
        }
    });
}

/* ------------------------------------------------------------------ */
/* 开发 / 自动化测试接口                                                */
/* ------------------------------------------------------------------ */

function exposeDevApi() {
    globalThis.NovelReader = {
        open: () => togglePanel(true),
        close: closePanel,
        toggle: togglePanel,
        importText: async (title, text, format = 'TXT') => {
            const normalized = normalizeText(text);
            const chapters = splitChapters(normalized, { maxChars: 9000 });
            const now = Date.now();
            const meta = {
                id: uuid(),
                title: makeUniqueTitle(title || '测试小说'),
                author: '',
                format,
                encoding: 'utf-8',
                charCount: chapters.reduce((sum, chapter) => sum + countChars(chapter.content), 0),
                chapterCount: chapters.length,
                sourceName: `${title}.txt`,
                createdAt: now,
                updatedAt: now,
            };
            await saveNovel(meta, chapters.map(chapter => ({ ...chapter, charCount: countChars(chapter.content) })));
            await refreshLibrary();
            await openNovel(meta.id, 'reader', { force: true });
            return meta;
        },
        importFile: async file => {
            await importFiles([file]);
        },
        runSummary: startSummary,
        stopSummary,
        openTab: tab => showTab(tab),
        /** 网络找书：开发自检入口 */
        searchOnline: async keyword => {
            if (keyword != null && elements.onlineQuery) elements.onlineQuery.value = keyword;
            await runOnlineSearch();
            return state.online.results.map(item => ({
                title: item.title,
                url: item.url,
                site: item.site,
                sources: (item.sources || []).map(source => ({ sourceName: source.sourceName, url: source.url })),
            }));
        },
        openOnlineUrl: async url => {
            await openOnlineBookUrl(url);
            return state.online.book
                ? { title: state.online.book.title, chapters: state.online.book.chapters.length }
                : null;
        },
        readOnline: () => openOnlineBookInReader(state.online.book),
        gotoOnlinePage: page => gotoOnlinePage(page),
        setOnlinePageSize: size => setOnlinePageSize(size),
        downloadOnline: () => downloadOnlineBook(state.online.book || bookFromReading()),
        exportOnline: () => exportOnlineBook(state.online.book || bookFromReading()),
        /** 番茄小说：任务式整本下载（自检台用 mock 桥接跑同一条路径） */
        downloadFanqie: () => downloadFanqieBook(state.online.book),
        /** 书源：自检入口 */
        importSourcesJson: text => {
            const { sources, warnings } = importSources(text);
            const merged = mergeSources(getOnlineSources(), sources);
            commitOnlineSources({ sources: merged.sources });
            return {
                sources: getOnlineSources().map(item => ({
                    id: item.bookSourceUrl,
                    name: item.bookSourceName,
                    enabled: item.enabled !== false,
                })),
                warnings,
                added: merged.added,
                replaced: merged.replaced,
            };
        },
        getSources: () => getOnlineSources().map(item => ({ ...item })),
        openSourceManager: () => openSourceManager(),
        getOnlineSettings: () => ({ ...getOnlineSettings() }),
        getRuntimeInfo: () => ({
            hasRuntime: Boolean(state.online.runtime),
            sandbox: Boolean(state.online.runtime?.sandbox),
            replaceRules: state.online.runtime?.settings?.replaceRules || [],
        }),
        setOnlineSettings: patch => {
            const settings = getSettings();
            settings.online = normalizeOnlineSettings({ ...settings.online, ...patch });
            saveSettings();
            state.online.fetcher?.update(settings.online);
            state.online.runtime?.update({
                ...getOnlineSettings(),
                replaceRules: getSettings().replaceRules || [],
            });
            renderOnlineSettings();
            renderOnlineHistory();
            return { ...settings.online };
        },
        getMemos: () => [...state.memo.novelMemos, ...state.memo.groupMemos].map(memo => ({ ...memo })),
        addMemo: async ({ title = '', content = '', chapterIndex = null, page = null, groupId = null } = {}) => {
            const group = groupId ? memoGroupById(groupId) : null;
            if (groupId && !group) throw new Error('分组不存在');
            if (!group && !state.novelId) throw new Error('先打开一本小说或指定分组');
            const sanitized = sanitizeMemoInput({ title, content });
            if (!sanitized.content) throw new Error('备忘内容不能为空');
            const now = Date.now();
            const record = {
                id: uuid(),
                novelId: group ? null : state.novelId,
                groupId: group?.id || null,
                title: sanitized.title || memoTitleFromContent(sanitized.content) || '未命名备忘',
                content: sanitized.content,
                chapterIndex: group || !Number.isInteger(chapterIndex) ? null : chapterIndex,
                page: group || !Number.isInteger(page) ? null : page,
                pinned: false,
                createdAt: now,
                updatedAt: now,
            };
            await saveMemo(record);
            if (record.groupId) state.memo.groupMemos = [record, ...state.memo.groupMemos];
            else state.memo.novelMemos = [record, ...state.memo.novelMemos];
            renderMemoPanel();
            renderChapterList();
            return { ...record };
        },
        getState: () => ({
            novels: state.novels.map(novel => ({ id: novel.id, title: novel.title, chapterCount: novel.chapterCount, charCount: novel.charCount })),
            novelId: state.novelId,
            chapters: state.chapters.length,
            selection: state.selection.size,
            tab: state.tab,
            online: {
                query: state.online.query,
                searching: state.online.searching,
                page: state.online.page,
                pageSize: state.online.pageSize,
                pageCount: getOnlinePageCount(),
                sourceReport: (state.online.sourceReport || []).map(item => ({
                    name: item.name,
                    count: item.count,
                    error: item.error,
                    ms: item.ms,
                })),
                sourceCount: state.online.sourceCount,
                results: state.online.results.map(item => ({
                    title: item.title,
                    url: item.url,
                    site: item.site,
                    snippet: item.snippet,
                    sources: (item.sources || []).map(source => ({ sourceName: source.sourceName, url: source.url })),
                })),
                book: state.online.book ? {
                    title: state.online.book.title,
                    author: state.online.book.author,
                    url: state.online.book.url,
                    chapters: state.online.book.chapters.length,
                    chapterCount: state.online.book.chapterCount || state.online.book.chapters.length,
                    downloadOnly: Boolean(state.online.book.downloadOnly),
                } : null,
                reading: state.online.reading ? { ...state.online.reading } : null,
                downloading: state.online.download.running,
                download: {
                    done: state.online.download.done,
                    total: state.online.download.total,
                    failed: state.online.download.failed.length,
                },
            },
            reader: { ...state.reader, pages: state.reader.pages.length },
            summary: {
                running: state.summary.running,
                result: state.summary.result ? {
                    text: state.summary.result.text,
                    mode: state.summary.result.mode,
                    targetChars: state.summary.result.targetChars,
                    truncated: state.summary.result.truncated,
                    stats: state.summary.result.stats,
                    novelId: state.summary.result.novelId || null,
                    novelTitle: state.summary.result.novelTitle || '',
                    chapterIndices: state.summary.result.chapterIndices || [],
                    chapterCount: state.summary.result.chapterCount || 0,
                    scopeLabel: state.summary.result.scopeLabel || '',
                    memoAddedId: state.summary.result.memoAddedId || null,
                } : null,
            },
            worldbook: {
                hasResult: Boolean(state.worldbook.result),
                entries: state.worldbook.result?.entries?.length || 0,
            },
            memo: {
                total: state.memo.novelMemos.length + state.memo.groupMemos.length,
                novelTotal: state.memo.novelMemos.length,
                groupTotal: state.memo.groupMemos.length,
                groups: state.memo.groups.map(group => ({
                    id: group.id,
                    name: group.name,
                    count: memoGroupMemoCount(group.id),
                })),
                loadedNovelId: state.memo.loadedNovelId,
                viewingId: state.memo.viewingId,
                editingId: state.memo.editingId,
                composing: state.memo.composing,
                anchor: state.memo.anchor,
                targetGroupId: state.memo.targetGroupId,
                collapsedNodes: [...state.memo.collapsedNodes],
                query: state.memo.query,
                pinnedOnly: state.memo.pinnedOnly,
                sort: state.memo.sort,
                batchMode: state.memo.batchMode,
                batchSelection: state.memo.batchSelection.size,
                items: [...state.memo.novelMemos, ...state.memo.groupMemos].map(memo => ({
                    id: memo.id,
                    novelId: memo.novelId,
                    groupId: memo.groupId,
                    title: memo.title,
                    chapterIndex: memo.chapterIndex,
                    page: memo.page,
                    pinned: Boolean(memo.pinned),
                    chars: countChars(memo.content),
                })),
            },
            style: {
                presetName: state.style.preset?.name || '',
                entryId: state.style.entryId,
                entryName: state.style.plan?.entry?.name || '',
                structureName: state.style.plan?.structureRef?.name || '',
                entries: state.style.preset ? groupStyleEntries(state.style.preset).style.length : 0,
                running: state.style.running,
                result: state.style.result
                    ? {
                        text: state.style.result.text,
                        chars: countChars(state.style.result.text),
                        presetName: state.style.result.presetName,
                        entryName: state.style.result.entryName,
                        stale: Boolean(state.style.result.stale),
                        checks: state.style.result.checks,
                    }
                    : null,
            },
        }),
        /** 调试 / 自检用：重新读取酒馆当前选用的预设，返回条目与默认选择 */
        refreshStylePreset: () => {
            const { preset } = refreshStylePreset({ silent: true });
            return {
                presetName: preset?.name || '',
                entryId: state.style.entryId,
                entries: preset
                    ? groupStyleEntries(preset).style.map(entry => ({
                        identifier: entry.identifier,
                        name: entry.name,
                        enabled: entry.enabled,
                        chars: countChars(entry.content),
                    }))
                    : [],
            };
        },
        generateStyle: () => startStyleGeneration(),
        getPlan: () => {
            const budget = computeBudget(getSettings());
            const totalChars = getSelectedMeta().reduce((sum, chapter) => sum + (chapter.charCount || 0), 0);
            return {
                budget,
                totalChars,
                estimatedCalls: Math.ceil((totalChars * 1.15) / Math.max(400, budget.inputBudget * 0.8)) + 2,
            };
        },
        clearAll,
    };
    globalThis.__novelReader = globalThis.NovelReader;
}
