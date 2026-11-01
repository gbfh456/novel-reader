/**
 * 书源 - 数据模型
 *
 * 字段与 Legado Max 的 BookSource 对齐（能用多少用多少，未实现的字段也保留，导出时不丢）：
 *   bookSourceUrl / Name / Group / Type / Enabled / EnabledExplore / CustomOrder / Weight
 *   ConcurrentRate / Header / LoginUrl / LoginUi / LoginCheckJs / JsLib / BookUrlPattern
 *   SearchUrl / ExploreUrl / ExploreScreen / RuleSearch / RuleExplore / RuleBookInfo
 *   RuleToc / RuleContent / RuleReview / CoverDecodeJs / VariableComment
 *
 * 规则字段既接受对象，也接受 JSON 字符串（导入的 Legado 备份常见）。
 */

export const SOURCE_TYPES = [0, 1, 2, 3, 4];

export const EMPTY_SEARCH_RULE = {
    checkKeyWord: '',
    bookList: '',
    name: '',
    author: '',
    intro: '',
    kind: '',
    lastChapter: '',
    updateTime: '',
    bookUrl: '',
    coverUrl: '',
    wordCount: '',
};

export const EMPTY_EXPLORE_RULE = {
    bookList: '',
    name: '',
    author: '',
    intro: '',
    kind: '',
    lastChapter: '',
    updateTime: '',
    bookUrl: '',
    coverUrl: '',
    wordCount: '',
};

export const EMPTY_BOOK_INFO_RULE = {
    init: '',
    name: '',
    author: '',
    intro: '',
    kind: '',
    lastChapter: '',
    updateTime: '',
    coverUrl: '',
    tocUrl: '',
    wordCount: '',
    canReName: '',
    downloadUrls: '',
};

export const EMPTY_TOC_RULE = {
    preUpdateJs: '',
    chapterList: '',
    chapterName: '',
    chapterUrl: '',
    formatJs: '',
    isVolume: '',
    isVip: '',
    isPay: '',
    updateTime: '',
    nextTocUrl: '',
};

export const EMPTY_CONTENT_RULE = {
    content: '',
    subContent: '',
    title: '',
    nextContentUrl: '',
    webJs: '',
    sourceRegex: '',
    replaceRegex: '',
    imageStyle: '',
    imageDecode: '',
    payAction: '',
    callBackJs: '',
};

export const EMPTY_REVIEW_RULE = {
    reviewList: '',
    avatar: '',
    content: '',
    postTime: '',
    title: '',
};

function asString(value, fallback = '') {
    if (value == null) return fallback;
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

function asBool(value, fallback) {
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'boolean') return value;
    const text = String(value).trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(text)) return true;
    if (['false', '0', 'no', 'off'].includes(text)) return false;
    return fallback;
}

function asNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

/** 规则既可能是对象，也可能是字符串；统一成对象并补全字段 */
export function normalizeRule(raw, template) {
    let value = raw;
    if (typeof value === 'string') {
        const text = value.trim();
        if (!text) value = {};
        else if (text.startsWith('{')) {
            try {
                value = JSON.parse(text);
            } catch {
                value = { bookList: text };
            }
        } else {
            value = { bookList: text };
        }
    }
    if (!value || typeof value !== 'object') value = {};
    const rule = { ...template };
    for (const key of Object.keys(template)) {
        if (value[key] !== undefined && value[key] !== null) rule[key] = asString(value[key]);
    }
    // Legado 的 ruleReview 字段名和这里不同，单独兜一层
    if (value.reviewList !== undefined) rule.reviewList = asString(value.reviewList);
    return rule;
}

/** 书源分组：Legado 支持多个分组，用逗号分隔 */
export function splitSourceGroups(value) {
    return String(value ?? '')
        .split(/[,，;；|]/)
        .map(item => item.trim())
        .filter(Boolean);
}

/**
 * 把任意来源的书源对象补全成内部结构。
 * @param {object} raw
 * @param {{native?:boolean}} options native = 老插件格式（规则默认取文本）
 */
export function normalizeSource(raw, options = {}) {
    if (!raw || typeof raw !== 'object') return null;
    const warnings = [];
    const nativeShape = Boolean(raw.search || raw.book || raw.chapter);
    const normalizedRaw = nativeShape && !raw.ruleSearch ? { ...raw, ...fromNativeShape(raw) } : raw;
    const url = asString(normalizedRaw.bookSourceUrl || normalizedRaw.url || normalizedRaw.sourceUrl).trim();
    const name = asString(normalizedRaw.bookSourceName || normalizedRaw.name || normalizedRaw.sourceName).trim();
    if (!url || !name) return null;
    if (!/^https?:\/\//i.test(url)) {
        warnings.push(`书源地址不是 http/https：${url}`);
    }
    const legacyId = asString(raw.id || '').trim();
    const source = {
        // 旧插件的 id 带书名哈希；同站不同名的两个源不能共用一个 id（老路径按 id 去重）
        id: legacyId || url,
        bookSourceUrl: url,
        bookSourceName: name,
        bookSourceGroup: asString(normalizedRaw.bookSourceGroup || raw.group || raw.sourceGroup).trim(),
        bookSourceType: SOURCE_TYPES.includes(Number(normalizedRaw.bookSourceType)) ? Number(normalizedRaw.bookSourceType) : 0,
        bookSourceComment: asString(normalizedRaw.bookSourceComment || raw.sourceComment),
        variableComment: asString(normalizedRaw.variableComment),
        bookUrlPattern: asString(normalizedRaw.bookUrlPattern),
        customOrder: asNumber(normalizedRaw.customOrder, 0),
        weight: asNumber(normalizedRaw.weight, 0),
        respondTime: asNumber(normalizedRaw.respondTime, 180000),
        lastUpdateTime: asNumber(normalizedRaw.lastUpdateTime, 0),
        enabled: asBool(normalizedRaw.enabled, true),
        enabledExplore: asBool(normalizedRaw.enabledExplore, true),
        enabledCookieJar: asBool(normalizedRaw.enabledCookieJar, true),
        concurrentRate: asString(normalizedRaw.concurrentRate),
        header: asString(normalizedRaw.header),
        loginUrl: asString(normalizedRaw.loginUrl),
        loginUi: asString(normalizedRaw.loginUi),
        loginCheckJs: asString(normalizedRaw.loginCheckJs),
        jsLib: asString(normalizedRaw.jsLib),
        coverDecodeJs: asString(normalizedRaw.coverDecodeJs),
        exploreUrl: asString(normalizedRaw.exploreUrl),
        exploreScreen: asString(normalizedRaw.exploreScreen),
        searchUrl: asString(normalizedRaw.searchUrl),
        ruleSearch: normalizeRule(normalizedRaw.ruleSearch, EMPTY_SEARCH_RULE),
        ruleExplore: normalizeRule(normalizedRaw.ruleExplore, EMPTY_EXPLORE_RULE),
        ruleBookInfo: normalizeRule(normalizedRaw.ruleBookInfo, EMPTY_BOOK_INFO_RULE),
        ruleToc: normalizeRule(normalizedRaw.ruleToc, EMPTY_TOC_RULE),
        ruleContent: normalizeRule(normalizedRaw.ruleContent, EMPTY_CONTENT_RULE),
        ruleReview: normalizedRaw.ruleReview ? normalizeRule(normalizedRaw.ruleReview, EMPTY_REVIEW_RULE) : null,
        homepageModules: asString(normalizedRaw.homepageModules),
        eventListener: asBool(normalizedRaw.eventListener, false),
        customButton: asBool(normalizedRaw.customButton, false),
        nextPageLazyLoad: asBool(normalizedRaw.nextPageLazyLoad, false),
        raw,
        native: Boolean(options.native) || nativeShape,
        warnings,
    };
    if (!source.searchUrl && !source.exploreUrl) {
        warnings.push('没有搜索地址，也没有发现地址：这个源只能用详情页链接打开');
    }
    // 旧格式迁移过来的源保留一份兼容字段，老的 NovelFetcher 路径仍能用
    if (nativeShape) {
        source.name = source.bookSourceName;
        source.url = source.bookSourceUrl;
        source.group = source.bookSourceGroup;
        source.search = {
            url: source.searchUrl,
            list: source.ruleSearch.bookList,
            title: source.ruleSearch.name,
            link: source.ruleSearch.bookUrl,
            author: source.ruleSearch.author,
            intro: source.ruleSearch.intro,
        };
        source.book = {
            title: source.ruleBookInfo.name,
            author: source.ruleBookInfo.author,
            intro: source.ruleBookInfo.intro,
            cover: source.ruleBookInfo.coverUrl,
            tocList: source.ruleToc.chapterList,
            chapterTitle: source.ruleToc.chapterName,
            chapterUrl: source.ruleToc.chapterUrl,
        };
        source.chapter = {
            title: source.ruleContent.title,
            content: source.ruleContent.content,
        };
    }
    return source;
}

/** 把本插件旧格式（search/book/chapter 三段）转成 Legado 规则字段 */
function fromNativeShape(raw) {
    const search = raw.search && typeof raw.search === 'object' ? raw.search : {};
    const book = raw.book && typeof raw.book === 'object' ? raw.book : {};
    const chapter = raw.chapter && typeof raw.chapter === 'object' ? raw.chapter : {};
    return {
        searchUrl: search.url || '',
        ruleSearch: {
            bookList: search.list || '',
            name: search.title || '',
            author: search.author || '',
            intro: search.intro || '',
            bookUrl: search.link || search.title || '',
        },
        ruleBookInfo: {
            name: book.title || '',
            author: book.author || '',
            intro: book.intro || '',
            coverUrl: book.cover || '',
        },
        ruleToc: {
            chapterList: book.tocList || '',
            chapterName: book.chapterTitle || '',
            chapterUrl: book.chapterUrl || book.chapterTitle || '',
        },
        ruleContent: {
            title: chapter.title || '',
            content: chapter.content || '',
        },
    };
}

function isLegadoShape(item) {
    return item && typeof item === 'object'
        && ('bookSourceUrl' in item || 'bookSourceName' in item || 'ruleSearch' in item);
}

/** 从文本 / 单个对象 / 数组 / {sources:[]} 中导入书源 */
export function importSources(input, { defaultGroup = '' } = {}) {
    let data = input;
    if (typeof data === 'string') {
        const text = data.trim();
        if (!text) throw new Error('先粘贴书源 JSON，或选一个书源文件');
        try {
            data = JSON.parse(text);
        } catch (error) {
            throw new Error(`书源不是合法 JSON：${error.message}`);
        }
    }
    const list = Array.isArray(data)
        ? data
        : (Array.isArray(data?.sources) ? data.sources : [data]);
    const sources = [];
    const warnings = [];
    for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const source = normalizeSource(item, { native: !isLegadoShape(item) });
        if (!source) {
            warnings.push(`跳过一条书源：缺少名称或地址（${asString(item.bookSourceName || item.name) || '未命名'}）`);
            continue;
        }
        if (defaultGroup) source.bookSourceGroup = defaultGroup;
        sources.push(source);
        warnings.push(...source.warnings.map(warning => `${source.bookSourceName}：${warning}`));
    }
    if (!sources.length) throw new Error('没有可导入的书源：需要 bookSourceName / bookSourceUrl（或 name / url）');
    return { sources, warnings };
}

/** 导出成 Legado 能直接导入的 JSON 对象 */
export function exportSource(source) {
    return {
        bookSourceUrl: source.bookSourceUrl,
        bookSourceName: source.bookSourceName,
        bookSourceGroup: source.bookSourceGroup || '',
        bookSourceType: source.bookSourceType,
        bookSourceComment: source.bookSourceComment || '',
        variableComment: source.variableComment || '',
        bookUrlPattern: source.bookUrlPattern || '',
        customOrder: source.customOrder || 0,
        weight: source.weight || 0,
        enabled: source.enabled !== false,
        enabledExplore: source.enabledExplore !== false,
        enabledCookieJar: source.enabledCookieJar !== false,
        concurrentRate: source.concurrentRate || '',
        header: source.header || '',
        loginUrl: source.loginUrl || '',
        loginUi: source.loginUi || '',
        loginCheckJs: source.loginCheckJs || '',
        jsLib: source.jsLib || '',
        coverDecodeJs: source.coverDecodeJs || '',
        exploreUrl: source.exploreUrl || '',
        exploreScreen: source.exploreScreen || '',
        searchUrl: source.searchUrl || '',
        ruleSearch: source.ruleSearch,
        ruleExplore: source.ruleExplore,
        ruleBookInfo: source.ruleBookInfo,
        ruleToc: source.ruleToc,
        ruleContent: source.ruleContent,
        ruleReview: source.ruleReview || undefined,
    };
}

/** 简单自检：给书源管理界面显示问题 */
export function validateSource(source) {
    const issues = [];
    if (!source?.bookSourceName) issues.push('缺少名称');
    if (!/^https?:\/\//i.test(source?.bookSourceUrl || '')) issues.push('地址不是 http/https');
    if (!source?.searchUrl && !source?.exploreUrl) issues.push('没有搜索 / 发现地址');
    if (!source?.ruleSearch?.bookList) issues.push('搜索列表规则为空');
    if (source?.ruleSearch?.bookList && !source?.ruleSearch?.name) issues.push('书名规则为空');
    if (source?.ruleSearch?.bookList && !source?.ruleSearch?.bookUrl) issues.push('书籍链接规则为空');
    if (!source?.ruleToc?.chapterList) issues.push('目录列表规则为空');
    if (!source?.ruleContent?.content) issues.push('正文规则为空');
    return issues;
}

/** 合并导入：同一地址（或同名同地址）覆盖，其余追加 */
export function mergeSources(current, incoming) {
    const list = Array.isArray(current) ? [...current] : [];
    let added = 0;
    let replaced = 0;
    for (const source of Array.isArray(incoming) ? incoming : []) {
        const index = list.findIndex(item => item.bookSourceUrl === source.bookSourceUrl
            || (item.bookSourceName === source.bookSourceName && item.bookSourceUrl === source.bookSourceUrl));
        if (index >= 0) {
            list[index] = source;
            replaced++;
        } else {
            list.push(source);
            added++;
        }
    }
    return { sources: list, added, replaced };
}

/** 书源是否用到 JS 规则（@js / <js> / {{}}），用于界面提示需要沙箱 */
export function sourceNeedsJs(source) {
    const visit = value => {
        if (typeof value === 'string') return /@js:|<js>|\{\{/i.test(value);
        if (Array.isArray(value)) return value.some(visit);
        if (value && typeof value === 'object') return Object.values(value).some(visit);
        return false;
    };
    return [
        source?.searchUrl,
        source?.exploreUrl,
        source?.header,
        source?.loginUrl,
        source?.loginCheckJs,
        source?.jsLib,
        source?.ruleSearch,
        source?.ruleBookInfo,
        source?.ruleToc,
        source?.ruleContent,
    ].some(visit);
}

/** 按分组统计 */
export function countSourcesByGroup(sources) {
    const counts = new Map();
    for (const source of sources || []) {
        for (const group of splitSourceGroups(source.bookSourceGroup)) {
            counts.set(group, (counts.get(group) || 0) + 1);
        }
    }
    return counts;
}
