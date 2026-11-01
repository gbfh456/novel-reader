/**
 * 小说阅读器 - 书源（导入的站点规则）
 *
 * 网络找书默认靠搜索引擎 + 通用启发式解析。书源是「给某个站点写死一套规则」：
 * 搜索地址怎么拼、结果列表在哪个容器里、目录和正文怎么取。导入后可以精确命中版式奇怪的站。
 *
 * 支持两种输入：
 *   1. 本插件格式（见 README）；
 *   2. Legado / 阅读 的 书源 JSON 的一个子集：只认简单的 CSS 选择器与 `class.` / `tag.` / `id.` 链，
 *      碰到 @js:、$.、XPath、正则替换这类高级规则会记一条 warning，并退回通用启发式解析。
 *
 * 规则写法：`选择器` 或 `选择器@属性`，属性取 text（默认）/ href / src / html。
 * 例：`h3 a`、`h3 a@href`、`#content`、`.book-info p@text`。
 */

import {
    cleanChapterLines,
    normalizeUrl,
    parseBookPage,
    parseChapterPage,
    parseHtml,
    parseSearchPage,
    querySelector,
    querySelectorAll,
    textOf,
    toLines,
} from './network.js';

/** 规则里出现这些记号就当「高级规则」，不做转换 */
const ADVANCED_RULE_RE = /@js:|@put:|@get:|@rule:|\$\.|\/\/|##{1,2}[^#]|@css:.*@js:/;

/** Legado 的搜索地址里常见的占位符 */
const KEY_PLACEHOLDERS = ['{{key}}', '{{keyword}}', '{{searchKey}}', '{{searchKey}}', '{key}', '{keyword}', '%s'];
const PAGE_PLACEHOLDERS = ['{{page}}', '{{searchPage}}', '{page}'];

function hash(input) {
    let value = 0;
    const source = String(input || '');
    for (let index = 0; index < source.length; index++) {
        value = ((value << 5) + value + source.charCodeAt(index)) | 0;
    }
    return Math.abs(value).toString(36);
}

function hostOf(url) {
    try {
        return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    } catch {
        return '';
    }
}

/** 规则是不是用了本插件不认识的 DSL */
export function isAdvancedRule(rule) {
    const raw = String(rule ?? '').trim();
    if (!raw) return false;
    return ADVANCED_RULE_RE.test(raw);
}

/**
 * 把一条规则拆成 { selector, attr }。
 * 认：`css`、`css@text`、`css@href`、`@css:css`、`css##正则`（忽略正则，只用选择器）。
 * @returns {{selector:string, attr:string, advanced:boolean}}
 */
export function parseRule(rule) {
    const raw = String(rule ?? '').trim();
    if (!raw) return { selector: '', attr: '', advanced: false };
    if (isAdvancedRule(raw)) return { selector: '', attr: '', advanced: true };
    let body = raw;
    if (body.startsWith('@css:')) body = body.slice('@css:'.length);
    // `##正则##替换` 这类只取选择器部分
    const hashIndex = body.indexOf('##');
    if (hashIndex >= 0) body = body.slice(0, hashIndex);
    const at = body.lastIndexOf('@');
    if (at < 0) return { selector: body.trim(), attr: '', advanced: false };
    const selector = body.slice(0, at).trim();
    const attr = body.slice(at + 1).trim().toLowerCase();
    if (!selector) return { selector: '', attr: '', advanced: false };
    if (['text', 'textnodes', 'owntext'].includes(attr)) return { selector, attr: '', advanced: false };
    if (['href', 'src', 'html', 'value', 'title', 'alt'].includes(attr)) return { selector, attr, advanced: false };
    // 不认识的尾巴按「整条当选择器」处理，别把规则吞掉
    return { selector: body.trim(), attr: '', advanced: false };
}

/**
 * 把 Legado 的链式规则转成 CSS：`class.list@tag.a@href` → `.list a` + href。
 * 不认识的段返回 advanced，交给调用方退回通用解析。
 * @returns {{rule:string, advanced:boolean}}
 */
export function convertLegadoRule(rule) {
    const raw = String(rule ?? '').trim();
    if (!raw) return { rule: '', advanced: false };
    if (isAdvancedRule(raw)) return { rule: '', advanced: true };
    if (raw.startsWith('@css:')) return { rule: raw.slice('@css:'.length), advanced: false };
    // Legado 的链式规则以 class./tag./id./text. 开头；其它没有 @ 的直接当 CSS
    const chainLike = /^(?:class|tag|id|text|textNodes|ownText|children|parent|nextSibling|previousSibling)(?:\.|$)/.test(raw);
    if (!raw.includes('@') && !chainLike) return { rule: raw, advanced: false };

    const parts = raw.split('@').map(part => part.trim()).filter(Boolean);
    const css = [];
    let attr = '';
    for (const part of parts) {
        const dot = part.indexOf('.');
        const kind = dot < 0 ? part : part.slice(0, dot);
        const value = dot < 0 ? '' : part.slice(dot + 1);
        if (kind === 'class' && value) css.push(`.${value}`);
        else if (kind === 'tag' && value) css.push(value);
        else if (kind === 'id' && value) css.push(`#${value}`);
        else if (['text', 'textNodes', 'ownText'].includes(kind)) attr = '';
        else if (['href', 'src', 'html', 'value', 'title', 'alt'].includes(kind)) attr = kind;
        else return { rule: '', advanced: true };
    }
    if (!css.length) return { rule: '', advanced: true };
    return { rule: attr ? `${css.join(' ')}@${attr}` : css.join(' '), advanced: false };
}

function normalizeRule(rule, warnings, label) {
    const raw = String(rule ?? '').trim();
    if (!raw) return '';
    const parsed = parseRule(raw);
    if (parsed.advanced) {
        warnings.push(`${label}：规则「${raw}」用了脚本 / XPath 之类的写法，已跳过（该字段退回通用解析）`);
        return '';
    }
    return parsed.selector ? `${parsed.selector}${parsed.attr ? `@${parsed.attr}` : ''}` : '';
}

/**
 * 把任意输入补全成一份可用的书源。
 * @returns {object|null} 不合法时返回 null
 */
export function normalizeSource(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const warnings = [];
    const name = String(raw.name || raw.bookSourceName || '').trim().slice(0, 60);
    const url = normalizeUrl(String(raw.url || raw.bookSourceUrl || '').trim());
    if (!name) return null;
    if (!url) return null;
    const search = raw.search && typeof raw.search === 'object' ? raw.search : {};
    const book = raw.book && typeof raw.book === 'object' ? raw.book : {};
    const chapter = raw.chapter && typeof raw.chapter === 'object' ? raw.chapter : {};
    const source = {
        id: String(raw.id || '').trim() || `src_${hash(`${name}|${url}`)}`,
        name,
        url,
        site: hostOf(url) || name,
        /** 书源分组（Legado 的 bookSourceGroup）；导入时可以统一归到某个组 */
        group: String(raw.group || raw.bookSourceGroup || '').trim().slice(0, 120),
        charset: String(raw.charset || 'auto').toLowerCase(),
        enabled: raw.enabled !== false,
        type: raw.type === 'legado' ? 'legado' : 'native',
        search: {
            url: String(search.url || '').trim(),
            list: normalizeRule(search.list, warnings, '搜索列表'),
            title: normalizeRule(search.title, warnings, '搜索结果标题'),
            link: normalizeRule(search.link, warnings, '搜索结果链接'),
            author: normalizeRule(search.author, warnings, '搜索结果作者'),
            intro: normalizeRule(search.intro, warnings, '搜索结果简介'),
        },
        book: {
            title: normalizeRule(book.title, warnings, '书名'),
            author: normalizeRule(book.author, warnings, '作者'),
            intro: normalizeRule(book.intro, warnings, '简介'),
            cover: normalizeRule(book.cover, warnings, '封面'),
            tocList: normalizeRule(book.tocList, warnings, '目录列表'),
            chapterTitle: normalizeRule(book.chapterTitle, warnings, '章节标题'),
            chapterUrl: normalizeRule(book.chapterUrl, warnings, '章节链接'),
        },
        chapter: {
            title: normalizeRule(chapter.title, warnings, '章节页标题'),
            content: normalizeRule(chapter.content, warnings, '正文'),
        },
    };
    if (!source.search.url) warnings.push('没写搜索地址：只能粘贴书籍页 / 章节页链接来用它');
    return { ...source, warnings };
}

/** Legado 书源 → 本插件书源 */
export function convertLegadoSource(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const warnings = [];
    const rules = raw.ruleSearch || {};
    const info = raw.ruleBookInfo || {};
    const toc = raw.ruleToc || {};
    const content = raw.ruleContent || {};
    const convert = (rule, label) => {
        const result = convertLegadoRule(rule);
        if (result.advanced) {
            warnings.push(`${label}：${String(rule).slice(0, 40)} 用了高级规则，已跳过`);
            return '';
        }
        return result.rule;
    };
    const draft = {
        type: 'legado',
        name: raw.bookSourceName || raw.bookSourceGroup || '未命名书源',
        url: raw.bookSourceUrl || '',
        group: raw.bookSourceGroup || '',
        enabled: raw.enabled !== false,
        search: {
            url: String(raw.searchUrl || '').trim(),
            list: convert(rules.bookList, '搜索列表'),
            title: convert(rules.name, '结果标题'),
            link: convert(rules.bookUrl, '结果链接'),
            author: convert(rules.author, '结果作者'),
            intro: convert(rules.intro, '结果简介'),
        },
        book: {
            title: convert(info.name, '书名'),
            author: convert(info.author, '作者'),
            intro: convert(info.intro, '简介'),
            cover: convert(info.coverUrl, '封面'),
            tocList: convert(toc.chapterList, '目录列表'),
            chapterTitle: convert(toc.chapterName, '章节标题'),
            chapterUrl: convert(toc.chapterUrl, '章节链接'),
        },
        chapter: {
            title: '',
            content: convert(content.content, '正文'),
        },
    };
    const source = normalizeSource(draft);
    if (!source) return null;
    return { ...source, warnings: [...source.warnings, ...warnings] };
}

/**
 * 从一段文本 / 一个对象里读出书源列表（兼容单条、数组、{ sources: [...] }）。
 * defaultGroup 给了就统一覆盖每条的分组（从链接导入时用它把一批书源归到同一个组）。
 */
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
        : Array.isArray(data?.sources) ? data.sources : [data];
    const sources = [];
    const warnings = [];
    for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const isLegado = 'bookSourceName' in item || 'bookSourceUrl' in item || 'ruleSearch' in item;
        const source = isLegado ? convertLegadoSource(item) : normalizeSource(item);
        if (!source) {
            warnings.push(`跳过一条书源：缺少名称或站点地址（${String(item.bookSourceName || item.name || '未命名')}）`);
            continue;
        }
        const group = String(defaultGroup || '').trim();
        sources.push(group ? { ...source, group } : source);
        for (const warning of source.warnings) warnings.push(`${source.name}：${warning}`);
    }
    if (!sources.length) throw new Error('没有可导入的书源：需要 name / url（或 bookSourceName / bookSourceUrl）');
    return { sources, warnings };
}

/** 书源集合抓取用的桥接路由（服务端那一半：先 fetch 再退 curl，能过 Cloudflare） */
export const SOURCE_FETCH_ROUTE = '/api/plugins/fanqie-bridge/source-fetch';

/**
 * 从链接抓书源集合（走服务端）。
 *
 * 为什么不让浏览器自己抓：这类订阅地址常挂在 Cloudflare 后面 —— 站点不发
 * Access-Control-Allow-Origin（浏览器读不到），酒馆 /api/search/visit 只接 text/html（JSON 直接被拒），
 * Node fetch 的 TLS 指纹又会被 CF 断连。服务端那一半用 curl 回退才拿得到。
 *
 * @param {object} options
 * @param {string} options.url 书源 JSON 直链
 * @param {string} [options.keyword] 名称 / 分组 / 地址关键词
 * @param {string} [options.group] 按分组精确取（服务端按分隔符拆分后逐段比对）
 * @param {number} [options.limit] 最多取多少条；0 或负数 = 全部
 * @param {number} [options.offset] 从第几条开始取（分批导入用）
 * @param {string} [options.defaultGroup] 导入后统一归到这个分组
 * @param {boolean} [options.summary] true 只要统计（总数 / 分组），不带 sources
 * @param {string} [options.route] 桥接路由，默认 SOURCE_FETCH_ROUTE
 * @param {Function} [options.getRequestHeaders] 酒馆的请求头（CSRF）
 */
export async function requestSourceCollection({
    url,
    keyword = '',
    group = '',
    limit = 50,
    offset = 0,
    summary = false,
    route = SOURCE_FETCH_ROUTE,
    getRequestHeaders,
    fetchImpl,
} = {}) {
    const rawTarget = String(url ?? '').trim();
    if (!/^https?:\/\//i.test(rawTarget)) throw new Error('书源链接要以 http:// 或 https:// 开头');
    // 合集页面地址 → 真正的 JSON 直链（yiove 这类站点给的是网页地址）
    const target = normalizeSourceLink(rawTarget);
    const doFetch = fetchImpl || globalThis.fetch?.bind(globalThis);
    if (typeof doFetch !== 'function') throw new Error('当前环境没有可用的 fetch');
    const headers = {
        ...(typeof getRequestHeaders === 'function' ? (getRequestHeaders() || {}) : {}),
        'Content-Type': 'application/json',
        Accept: 'application/json',
    };
    let response;
    try {
        response = await doFetch(route, {
            method: 'POST',
            headers,
            credentials: 'same-origin',
            body: JSON.stringify({
                url: target,
                keyword: String(keyword ?? ''),
                group: String(group ?? ''),
                // limit <= 0 表示「全部」；上限由服务端兜着
                limit: Number(limit) > 0 ? Math.round(Number(limit)) : 0,
                offset: Math.max(0, Math.round(Number(offset) || 0)),
                summary: summary === true,
            }),
        });
    } catch (error) {
        throw new Error(`连不上书源抓取服务（${route}）：确认酒馆装了服务端桥接插件并重启过（${error.message}）`);
    }
    if (!response.ok) {
        let raw = '';
        try {
            raw = await response.text();
        } catch {
            raw = '';
        }
        let message = '';
        try {
            const data = JSON.parse(raw);
            message = String(data?.error || data?.message || '');
        } catch {
            message = '';
        }
        if (response.status === 404 && !message) {
            throw new Error('书源抓取服务没装：在酒馆根目录执行面板里那条 node 命令（setup.mjs install-server），然后重启酒馆');
        }
        if (response.status === 403 && !message) {
            throw new Error('酒馆拒绝了请求（403）：先刷新页面重试；仍失败就重启酒馆，确认桥接插件已加载');
        }
        throw new Error(message || `书源抓取服务返回 ${response.status}`);
    }
    try {
        return await response.json();
    } catch {
        throw new Error('书源抓取服务返回的不是合法 JSON');
    }
}

/**
 * 把「合集页面地址」换成真正的书源 JSON 直链。
 *
 * 目前适配 Yiove 书源仓库（shuyuan.yiove.com）：
 *   https://shuyuan.yiove.com/book-source-collection/<id>        ← 网页（合集详情）
 *   https://shuyuan-api.yiove.com/import/book-source-collection/<id>  ← 真正的 JSON（动辄几十 MB）
 * 用户在网站里拿到的几乎都是前者，直接粘进插件会抓到一坨 HTML，所以在这里换掉。
 * 列表页没有 id，没法猜，直接给出可操作的提示。
 */
export function normalizeSourceLink(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return '';
    let parsed;
    try {
        parsed = new URL(raw);
    } catch {
        return raw;
    }
    const host = parsed.hostname.toLowerCase();
    if (host === 'shuyuan.yiove.com' && /^\/book-source-collections?(\/|$)/i.test(parsed.pathname)) {
        const id = parsed.pathname.match(/\/book-source-collection\/([0-9a-f-]{16,})/i)?.[1];
        if (!id) throw new Error('这是「书源合集」列表页：点进你要的那一个合集，用它详情页的链接再订阅');
        return `https://shuyuan-api.yiove.com/import/book-source-collection/${id}`;
    }
    const apiId = host === 'shuyuan-api.yiove.com'
        ? parsed.pathname.match(/\/import\/book-source-collection\/([0-9a-f-]{16,})/i)?.[1]
        : null;
    if (apiId) return `https://shuyuan-api.yiove.com/import/book-source-collection/${apiId}`;
    return raw;
}

/** 同一站点 + 同名视为同一个书源，用来覆盖导入 */
export function mergeSources(current, incoming) {
    const list = Array.isArray(current) ? [...current] : [];
    let added = 0;
    let replaced = 0;
    for (const source of incoming) {
        const index = list.findIndex(item => item.id === source.id || (item.url === source.url && item.name === source.name));
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

/** 搜索地址：支持 {{key}} / {key} / %s 与 {{page}} / {page}} */
export function buildSourceSearchUrl(source, keyword, page = 1) {
    const query = String(keyword || '').trim();
    if (!query) return '';
    const template = String(source?.search?.url || '').trim();
    if (!template) return '';
    const pageNo = Math.max(1, Math.floor(Number(page) || 1));
    const encoded = encodeURIComponent(query);
    let url = template;
    let hasKey = false;
    for (const placeholder of KEY_PLACEHOLDERS) {
        if (!url.includes(placeholder)) continue;
        url = url.split(placeholder).join(encoded);
        hasKey = true;
    }
    if (!hasKey) url += `${url.includes('?') ? '&' : '?'}q=${encoded}`;
    let hasPage = false;
    for (const placeholder of PAGE_PLACEHOLDERS) {
        if (!url.includes(placeholder)) continue;
        url = url.split(placeholder).join(String(pageNo));
        hasPage = true;
    }
    if (!hasPage && pageNo > 1) url += `${url.includes('?') ? '&' : '?'}page=${pageNo}`;
    const absolute = normalizeUrl(url, source?.url);
    return absolute || '';
}

/** 这个地址属不属于这个书源（按主机名判断） */
export function sourceMatchesUrl(source, url) {
    const host = hostOf(url);
    if (!host) return false;
    const sourceHost = hostOf(source?.url);
    if (!sourceHost) return false;
    return host === sourceHost || host.endsWith(`.${sourceHost}`) || sourceHost.endsWith(`.${host}`);
}

/** 从书源列表里挑出当前要用的那个 */
export function pickSource(sources, sourceId) {
    const list = (Array.isArray(sources) ? sources : []).filter(source => source?.enabled !== false);
    if (!list.length) return null;
    const wanted = String(sourceId || '').trim();
    if (wanted) {
        const hit = list.find(source => source.id === wanted);
        if (hit) return hit;
    }
    return list[0];
}

/** 按规则取一个节点的文本 / 属性 */
function readRule(node, rule) {
    const parsed = parseRule(rule);
    if (!parsed.selector) return '';
    const target = querySelector(node, parsed.selector);
    if (!target) return '';
    if (!parsed.attr) return toLines(textOf(target)).join(' ').trim();
    if (parsed.attr === 'html') return String(textOf(target) || '').trim();
    return String(target.attrs?.[parsed.attr] || '').trim();
}

/** 按规则取节点里第一个链接（给了 link 规则就用它，否则找 a） */
function readLink(node, rule, base) {
    const parsed = parseRule(rule);
    const container = parsed.selector ? (querySelector(node, parsed.selector) || node) : node;
    const attr = parsed.attr && parsed.attr !== 'text' ? parsed.attr : 'href';
    const direct = String(container.attrs?.[attr] || '').trim();
    if (direct) {
        const url = normalizeUrl(direct, base);
        if (url) return url;
    }
    const anchor = querySelector(container, 'a') || querySelector(node, 'a');
    return normalizeUrl(anchor?.attrs?.href, base);
}

/**
 * 用书源的搜索规则解析搜索结果页。
 * 规则没写或没命中时，退回通用解析（parseSearchPage）。
 */
export function parseSourceSearchPage(html, pageUrl, source) {
    const root = parseHtml(html);
    const listRule = parseRule(source?.search?.list);
    const name = source?.name || '书源';
    const results = [];
    if (listRule.selector) {
        for (const node of querySelectorAll(root, listRule.selector)) {
            const title = readRule(node, source.search.title) || toLines(textOf(node)).join(' ').slice(0, 80);
            const url = readLink(node, source.search.link || source.search.title, pageUrl);
            if (!title || !url) continue;
            const author = readRule(node, source.search.author);
            const intro = readRule(node, source.search.intro);
            results.push({
                title: title.slice(0, 120),
                url,
                site: name,
                snippet: [author ? `作者：${author}` : '', intro].filter(Boolean).join(' · ').slice(0, 160),
            });
        }
    }
    const seen = new Set();
    const deduped = results.filter(item => {
        if (seen.has(item.url)) return false;
        seen.add(item.url);
        return true;
    });
    if (deduped.length) return deduped.slice(0, 100);
    // 规则没命中：通用解析兜底，至少别让搜索空手而归
    return parseSearchPage(html, pageUrl);
}

/**
 * 用书源的目录规则解析书籍页。
 * 章节少于 2 条时退回通用解析（很多站的目录结构和搜索规则写在同一页）。
 */
export function parseSourceBookPage(html, pageUrl, source) {
    const root = parseHtml(html);
    const base = pageUrl || source?.url || '';
    const chapters = [];
    const listRule = parseRule(source?.book?.tocList);
    if (listRule.selector) {
        for (const node of querySelectorAll(root, listRule.selector)) {
            const title = readRule(node, source.book.chapterTitle) || toLines(textOf(node)).join(' ').trim();
            const url = readLink(node, source.book.chapterUrl || source.book.chapterTitle, base);
            if (!title || !url) continue;
            chapters.push({ title: title.slice(0, 120), url });
        }
    }
    // 通用解析永远跑一遍：书源只写了目录规则时，书名 / 作者 / 简介还能从页面元信息里补上
    const generic = parseBookPage(html, base);
    return {
        ...generic,
        url: base,
        title: readRule(root, source?.book?.title) || generic.title,
        author: readRule(root, source?.book?.author) || generic.author,
        intro: readRule(root, source?.book?.intro) || generic.intro,
        cover: readRule(root, source?.book?.cover) || generic.cover,
        chapters: chapters.length >= 2 ? chapters : generic.chapters,
        isChapterPage: chapters.length >= 2 ? false : generic.isChapterPage,
        sourceId: source?.id || '',
        sourceName: source?.name || '',
    };
}

/** 用书源的正文规则解析章节页；规则没命中时退回通用解析 */
export function parseSourceChapterPage(html, pageUrl, source) {
    const root = parseHtml(html);
    const rule = parseRule(source?.chapter?.content);
    let text = '';
    if (rule.selector) {
        const node = querySelector(root, rule.selector);
        if (node) {
            const lines = cleanChapterLines(toLines(textOf(node)));
            text = lines.join('\n\n').trim();
        }
    }
    const title = readRule(root, source?.chapter?.title) || '';
    if (text.length >= 20) {
        return { title, text, url: pageUrl, nextUrl: '', prevUrl: '', charCount: text.length };
    }
    const generic = parseChapterPage(html, pageUrl);
    return {
        ...generic,
        title: title || generic.title,
        text: generic.text || text,
        charCount: (generic.text || text).length,
    };
}
