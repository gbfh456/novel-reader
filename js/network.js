/**
 * 小说阅读器 - 网络找书
 *
 * 这个模块只做三件事：
 *   1. 把小说站的搜索页 / 书籍页 / 章节页 HTML 解析成结构化数据
 *      （自带极简 HTML 解析器，浏览器和 Node 下行为一致，不依赖 DOMParser）；
 *   2. 通过可切换的抓取通道取回 HTML
 *      （酒馆 /api/search/visit → 自定义 CORS 代理 → 浏览器直连）；
 *   3. 把抓到的章节拼成可以直接导入书架的纯文本。
 *
 * 不依赖第三方库，不发任何遥测；请求只会发往用户自己填的地址。
 */

import { DEFAULT_ONLINE_SETTINGS } from './settings.js';
import {
    FanqieClient,
    fanqieBookIdFromUrl,
    isFanqieUrl,
    normalizeFanqieBridge,
} from './fanqie.js';
import { mapLimit } from './util.js';
import { normalizeSource } from './source/model.js';
import {
    buildSourceSearchUrl,
    parseSourceBookPage,
    parseSourceChapterPage,
    parseSourceSearchPage,
    pickSource,
    sourceMatchesUrl,
} from './source.js';

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

/** 解析正文时的候选容器，按可靠性从高到低 */
const CONTENT_SELECTORS = [
    '#content',
    '#chaptercontent',
    '#booktxt',
    '#txtContent',
    '#nr_content',
    '#htmlContent',
    '#content1',
    '#chapter_content',
    '.read-content',
    '.readcontent',
    '.article-content',
    '.chapter-content',
    '.entry-content',
    '.post-content',
    '.showtxt',
    '.txtnav',
    '.Readarea',
    '#nr1',
    'article',
];

/** 章节标题：第 X 章 / 第 X 节 / 序章 / 番外 / Chapter N / 纯数字编号 */
const CHAPTER_TITLE_RE = /^(?:第\s*[0-9０-９零〇一二三四五六七八九十百千万两]{1,12}\s*[章节回卷集话篇]|序章|序言|楔子|引子|前言|后记|尾声|终章|番外|外传|Chapter\s*\d+|Prologue|Epilogue)/i;
const CHAPTER_NUMBER_RE = /^(?:\d{1,5}\s*[、.．,，:：]|（\d{1,5}）|\(\d{1,5}\))/;

/** 正文里的广告 / 导航行：只在「整行很短」时才丢，避免误伤正文 */
const AD_LINE_RULES = [
    { max: 40, re: /请记住本[站书]|记住本站|本站域名|最新网址|收藏本站|加入书签|手机阅读|手机版|下载\s*APP|app下载|扫码阅读/i },
    { max: 40, re: /^(?:上一章|下一章|返回目录|章节目录|目录|章节报错|内容举报|投推荐票|求月票|求推荐|求收藏|推荐票|月票|打赏|返回书页|加入书架)[:：]?$/i },
    { max: 40, re: /本章未完|点击下一页|请点击下一页|继续阅读|后面更精彩|精彩继续/i },
    { max: 80, re: /^(?:https?:\/\/|www\.)[^\s]+$/i },
    { max: 40, re: /一秒记住|精彩小说|无弹窗|全文阅读|免费阅读|笔趣阁|新书推荐|热门推荐|相关推荐/i },
    { max: 30, re: /^[（(]?(?:未完待续|本章完|全文完)[)）]?[。.]?$/ },
];

const VOID_TAGS = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/** 内容不参与正文的标签：整段跳过 */
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'canvas', 'select', 'button']);

const BLOCK_TAGS = new Set([
    'address', 'article', 'aside', 'blockquote', 'center', 'dd', 'div', 'dl', 'dt',
    'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4',
    'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section',
    'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);

/** 隐式闭合：HTML 里 `<p>` / `<li>` 经常不写结束标签，这里按常见规则兜住 */
const IMPLICIT_CLOSE = {
    p: new Set(['p', 'div', 'ul', 'ol', 'li', 'dl', 'table', 'section', 'article', 'header', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'form', 'pre']),
    li: new Set(['li']),
    td: new Set(['td', 'th', 'tr']),
    th: new Set(['td', 'th', 'tr']),
    tr: new Set(['tr']),
    option: new Set(['option']),
    dt: new Set(['dt', 'dd']),
    dd: new Set(['dt', 'dd']),
};

const ENTITY_MAP = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', hellip: '…',
    mdash: '—', ndash: '–', middot: '·', times: '×', divide: '÷',
    copy: '©', reg: '®', trade: '™', deg: '°', plusmn: '±',
    emsp: ' ', ensp: ' ', thinsp: ' ', zwnj: '', zwj: '',
};

/* ------------------------------------------------------------------ */
/* 设置                                                                */
/* ------------------------------------------------------------------ */

/** 书源规范化缓存：设置里的数组没换就直接复用，几百个源时少一次全量转换 */
const sourceNormalizeCache = new WeakMap();

/** 把外部传入的设置补全成完整的一份，数值做夹取 */
export function normalizeOnlineSettings(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const settings = { ...DEFAULT_ONLINE_SETTINGS };
    for (const [key, value] of Object.entries(source)) {
        if (value === undefined || value === null) continue;
        if (key in settings && typeof settings[key] === 'number') {
            const num = Number(value);
            if (Number.isFinite(num)) settings[key] = num;
            continue;
        }
        settings[key] = value;
    }
    // 抓取通道只有三条：auto / tavern / proxy。「浏览器直连」不再是可选项（普通小说站必然被 CORS
    // 拦下，单独选它只会每次失败），旧设置里的 direct 退回 auto；direct 仍作为 auto 链的最后一档兜底，
    // 见 channelOrder()。
    settings.channel = ['auto', 'tavern', 'proxy'].includes(settings.channel) ? settings.channel : 'auto';
    // 网页搜索那条通道已经删掉（价值不大、还容易被搜索引擎按地区 / 风控拒）：
    // 老设置里的 web / bing / searxng / site / none 一律落到「书源」，番茄保留；
    // 顺手把不再用的引擎设置清掉，别让它们继续躺在 settings 里。
    settings.searchEngine = settings.searchEngine === 'fanqie' ? 'fanqie' : 'source';
    delete settings.webEngine;
    delete settings.searchUrlTemplate;
    delete settings.keywordSuffix;
    delete settings.searxngUrl;
    settings.concurrency = Math.min(8, Math.max(1, Math.round(Number(settings.concurrency) || 3)));
    settings.timeoutMs = Math.min(120000, Math.max(3000, Math.round(Number(settings.timeoutMs) || 15000)));
    settings.downloadLimit = Math.max(0, Math.round(Number(settings.downloadLimit) || 0));
    settings.pageSize = Math.min(50, Math.max(1, Math.round(Number(settings.pageSize) || DEFAULT_ONLINE_SETTINGS.pageSize)));
    settings.exactMatch = settings.exactMatch === true || settings.exactMatch === 'true';
    settings.proxyTemplate = String(settings.proxyTemplate || '').trim();
    settings.sourceSort = ['source', 'title', 'arrival'].includes(settings.sourceSort)
        ? settings.sourceSort
        : 'source';
    settings.fanqieBridge = normalizeFanqieBridge(settings.fanqieBridge);
    settings.fanqieUpstream = String(settings.fanqieUpstream || '').trim();
    // 书源统一成新模型（Legado 字段）；旧插件的 search/book/chapter 格式会在 normalizeSource 里自动转换
    if (Array.isArray(settings.sources)) {
        const rawSources = settings.sources;
        if (sourceNormalizeCache.has(rawSources)) {
            settings.sources = sourceNormalizeCache.get(rawSources);
        } else {
            const normalized = rawSources
                .filter(source => source && typeof source === 'object')
                .map(source => normalizeSource(source))
                .filter(Boolean);
            sourceNormalizeCache.set(rawSources, normalized);
            settings.sources = normalized;
        }
    } else {
        settings.sources = [];
    }
    // 已下线的渠道字段：直接从设置里清掉，别跟着下一版继续传
    // sourceSubscriptions 是已下线的「书源订阅」，跟着清掉，别留在设置里占地方
    for (const deadKey of ['siteUrl', 'siteSearchTemplate', 'f2bBase', 'sourceSubscriptions']) delete settings[deadKey];
    return settings;
}

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

/** 解码 HTML 实体（含十进制 / 十六进制数字实体） */
export function decodeEntities(input) {
    const text = String(input ?? '');
    if (!text.includes('&')) return text;
    return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{0,31});?/g, (match, body) => {
        if (body[0] === '#') {
            const hex = body[1] === 'x' || body[1] === 'X';
            const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
            if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
            try {
                return String.fromCodePoint(code);
            } catch {
                return match;
            }
        }
        const known = ENTITY_MAP[body] ?? ENTITY_MAP[body.toLowerCase()];
        return known === undefined ? match : known;
    });
}

/** 把任意 href 补成绝对地址；过滤 javascript:/mailto:/纯锚点 */
export function normalizeUrl(href, base) {
    const raw = String(href ?? '').trim();
    if (!raw) return '';
    if (/^(?:javascript|mailto|tel|data|about):/i.test(raw)) return '';
    if (raw.startsWith('#')) return '';
    try {
        const url = new URL(raw, base || undefined);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
        url.hash = '';
        return url.toString();
    } catch {
        return '';
    }
}

/** 取地址里最后一串数字，用于判断章节顺序 */
function lastNumber(value) {
    const matches = String(value || '').match(/\d+/g);
    if (!matches || !matches.length) return Number.NaN;
    return Number(matches[matches.length - 1]);
}

/** 去掉 html / head 之前的杂音，只保留可读行 */
export function toLines(text) {
    return String(text ?? '')
        .replace(/\r\n?/g, '\n')
        .replace(/[\u00a0\u3000]/g, ' ')
        .split('\n')
        .map(line => line.replace(/[ \t\f\v]+/g, ' ').trim())
        .filter(Boolean);
}

/** 单行是否像章节标题 */
export function isChapterTitle(line) {
    const text = String(line || '').trim();
    if (!text || text.length > 60) return false;
    return CHAPTER_TITLE_RE.test(text) || CHAPTER_NUMBER_RE.test(text);
}

/* ------------------------------------------------------------------ */
/* 极简 HTML 解析器                                                    */
/* ------------------------------------------------------------------ */

/**
 * 把 HTML 解析成一棵轻量 DOM 树。
 * 节点形如 { type: 'element', tag, attrs, children, parent } 或 { type: 'text', text }。
 * 只保留结构信息，不处理样式与脚本。
 */
export function parseHtml(html) {
    const root = { type: 'element', tag: '#root', attrs: {}, children: [], parent: null };
    const source = String(html ?? '');
    let index = 0;
    let current = root;

    const pushText = text => {
        if (!text) return;
        const last = current.children[current.children.length - 1];
        if (last && last.type === 'text') last.text += text;
        else current.children.push({ type: 'text', text, parent: current });
    };

    const closeImplicit = tag => {
        let node = current;
        while (node && node.type === 'element' && node.parent) {
            const rule = IMPLICIT_CLOSE[node.tag];
            if (rule && rule.has(tag)) {
                node = node.parent;
                current = node;
                continue;
            }
            break;
        }
    };

    while (index < source.length) {
        const lt = source.indexOf('<', index);
        if (lt === -1) {
            pushText(source.slice(index));
            break;
        }
        if (lt > index) pushText(source.slice(index, lt));

        if (source.startsWith('<!--', lt)) {
            const end = source.indexOf('-->', lt + 4);
            index = end === -1 ? source.length : end + 3;
            continue;
        }
        if (source.startsWith('<!', lt) || source.startsWith('<?', lt)) {
            const end = source.indexOf('>', lt);
            index = end === -1 ? source.length : end + 1;
            continue;
        }

        const gt = source.indexOf('>', lt);
        if (gt === -1) {
            pushText(source.slice(lt));
            break;
        }
        let inner = source.slice(lt + 1, gt);
        index = gt + 1;
        if (!inner.trim()) continue;

        if (inner[0] === '/') {
            const name = inner.slice(1).trim().toLowerCase();
            if (!name) continue;
            let node = current;
            while (node && node.tag !== name) node = node.parent;
            if (node && node.parent) current = node.parent;
            continue;
        }

        const selfClosing = inner.endsWith('/');
        if (selfClosing) inner = inner.slice(0, -1);
        const nameMatch = inner.match(/^([a-zA-Z][a-zA-Z0-9:_-]*)/);
        if (!nameMatch) continue;
        const tag = nameMatch[1].toLowerCase();
        const attrs = parseAttributes(inner.slice(nameMatch[1].length));

        closeImplicit(tag);

        const element = { type: 'element', tag, attrs, children: [], parent: current };
        current.children.push(element);

        if (SKIP_TAGS.has(tag)) {
            // script / style 之类：整段跳过，找配对的结束标签
            const closeRe = new RegExp(`</${tag}\\s*>`, 'i');
            const rest = source.slice(index);
            const matched = rest.match(closeRe);
            index = matched ? index + matched.index + matched[0].length : source.length;
            continue;
        }
        if (!VOID_TAGS.has(tag) && !selfClosing) current = element;
    }

    return root;
}

function parseAttributes(source) {
    const attrs = {};
    const re = /([:@a-zA-Z_][-.:\w]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    let match;
    while ((match = re.exec(source))) {
        const name = match[1].toLowerCase();
        if (name in attrs) continue;
        const value = match[2] ?? match[3] ?? match[4] ?? '';
        attrs[name] = decodeEntities(value);
    }
    return attrs;
}

/* ------------------------------------------------------------------ */
/* 选择器（只支持小说站会用到的那些写法）                              */
/* ------------------------------------------------------------------ */

function parseSimpleSelector(token) {
    const simple = { tag: null, id: null, classes: [], attrs: [] };
    let rest = token;
    const tagMatch = rest.match(/^([a-zA-Z][\w-]*|\*)/);
    if (tagMatch) {
        if (tagMatch[1] !== '*') simple.tag = tagMatch[1].toLowerCase();
        rest = rest.slice(tagMatch[0].length);
    }
    while (rest) {
        let match;
        if ((match = rest.match(/^#([\w-]+)/))) {
            simple.id = match[1];
        } else if ((match = rest.match(/^\.([\w-]+)/))) {
            simple.classes.push(match[1]);
        } else if ((match = rest.match(/^\[([\w:-]+)(?:([~^$*|]?=)["']?([^"'\]]*)["']?)?\]/))) {
            simple.attrs.push({ name: match[1].toLowerCase(), op: match[2] || null, value: match[3] ?? '' });
        } else {
            break;
        }
        rest = rest.slice(match[0].length);
    }
    return simple;
}

function matchesSimple(element, simple) {
    if (element.type !== 'element') return false;
    if (simple.tag && element.tag !== simple.tag) return false;
    if (simple.id && element.attrs.id !== simple.id) return false;
    if (simple.classes.length) {
        const classes = String(element.attrs.class || '').split(/\s+/).filter(Boolean);
        for (const name of simple.classes) {
            if (!classes.includes(name)) return false;
        }
    }
    for (const attr of simple.attrs) {
        const value = element.attrs[attr.name];
        if (value === undefined) return false;
        if (!attr.op) continue;
        if (attr.op === '=' && value !== attr.value) return false;
        if (attr.op === '*=' && !value.includes(attr.value)) return false;
        if (attr.op === '^=' && !value.startsWith(attr.value)) return false;
        if (attr.op === '$=' && !value.endsWith(attr.value)) return false;
        if (attr.op === '~=' && !value.split(/\s+/).includes(attr.value)) return false;
    }
    return true;
}

function matchesChain(element, chain) {
    let node = element;
    let index = chain.length - 1;
    if (!matchesSimple(node, chain[index])) return false;
    index--;
    while (index >= 0) {
        node = node.parent;
        while (node && !matchesSimple(node, chain[index])) node = node.parent;
        if (!node) return false;
        index--;
    }
    return true;
}

/** 把逗号分隔的选择器串编译成若干条「简单选择器链」 */
function compileSelector(selector) {
    return String(selector || '')
        .split(',')
        .map(part => part.trim())
        .filter(Boolean)
        .map(part => part.split(/\s+/).map(parseSimpleSelector))
        .filter(chain => chain.length && chain.every(simple => simple.tag || simple.id || simple.classes.length || simple.attrs.length));
}

function* walk(node) {
    for (const child of node.children || []) {
        if (child.type !== 'element') continue;
        yield child;
        yield* walk(child);
    }
}

/** 取所有匹配元素（文档顺序） */
export function querySelectorAll(root, selector) {
    if (!root) return [];
    const chains = compileSelector(selector);
    if (!chains.length) return [];
    const result = [];
    for (const element of walk(root)) {
        if (chains.some(chain => matchesChain(element, chain))) result.push(element);
    }
    return result;
}

/** 取第一个匹配元素 */
export function querySelector(root, selector) {
    return querySelectorAll(root, selector)[0] || null;
}

/* ------------------------------------------------------------------ */
/* 文本提取                                                            */
/* ------------------------------------------------------------------ */

function collectText(node, out) {
    if (!node) return;
    if (node.type === 'text') {
        out.push(decodeEntities(node.text));
        return;
    }
    if (node.tag === 'br') {
        out.push('\n');
        return;
    }
    const block = BLOCK_TAGS.has(node.tag);
    if (block) out.push('\n');
    for (const child of node.children || []) collectText(child, out);
    if (block) out.push('\n');
}

/** 元素 / 文本节点的可读文本（块级标签之间自动换行） */
export function textOf(node) {
    const buffer = [];
    collectText(node, buffer);
    return buffer.join('').replace(/\r\n?/g, '\n');
}

function annotateLengths(node) {
    if (node.type === 'text') {
        node.len = node.text.length;
        return node.len;
    }
    let total = 0;
    for (const child of node.children || []) total += annotateLengths(child);
    node.len = total;
    return total;
}

function sumLinkChars(node) {
    let total = 0;
    for (const element of walk(node)) {
        if (element.tag === 'a') total += textOf(element).length;
    }
    return total;
}

/* ------------------------------------------------------------------ */
/* 章节链接提取                                                        */
/* ------------------------------------------------------------------ */

const CHAPTER_CONTAINER_TAGS = new Set(['ul', 'ol', 'div', 'dl', 'section', 'table', 'tbody', 'td', 'article', 'main', 'nav', 'aside']);

function dedupeLinks(links) {
    const seen = new Set();
    const result = [];
    for (const link of links) {
        const key = link.url;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(link);
    }
    return result;
}

/** 章节顺序修正：目录可能按倒序排，也可能把「最新章节」混进前面 */
function reorderChapters(links) {
    if (links.length < 3) return links;
    const values = links.map(link => lastNumber(link.url));
    const valid = values.filter(Number.isFinite);
    if (valid.length < links.length * 0.7) return links;
    if (new Set(values).size < links.length * 0.6) return links;

    let asc = 0;
    let desc = 0;
    for (let i = 1; i < values.length; i++) {
        if (!Number.isFinite(values[i]) || !Number.isFinite(values[i - 1])) continue;
        if (values[i] > values[i - 1]) asc++;
        else if (values[i] < values[i - 1]) desc++;
    }
    if (desc >= 3 && desc > asc * 2) return [...links].reverse();
    if (asc >= 3 && desc >= 3) {
        return [...links].sort((left, right) => {
            const a = lastNumber(left.url);
            const b = lastNumber(right.url);
            if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
            return a - b;
        });
    }
    return links;
}

function scoreChapterContainer(element, links) {
    const chapterLinks = links.filter(link => isChapterTitle(link.title));
    const ratio = links.length ? chapterLinks.length / links.length : 0;
    if (chapterLinks.length < 3 && !(chapterLinks.length >= 2 && ratio > 0.8)) return 0;
    let score = chapterLinks.length * 4 + Math.round(ratio * 20);
    score -= (links.length - chapterLinks.length) * 2;
    if (element.tag === 'ul' || element.tag === 'ol' || element.tag === 'dl') score += 8;
    if (element.attrs.id && /list|chapter|dir|catalog/i.test(element.attrs.id)) score += 12;
    if (element.attrs.class && /list|chapter|dir|catalog/i.test(element.attrs.class)) score += 12;
    return score;
}

function findChapterContainer(root, base) {
    // 先收全部链接，再按「它们在哪些容器里」分桶：
    // 每个链接只向祖先注册几层，避免对每个容器都重复遍历整棵子树。
    const buckets = new Map();
    let anchorCount = 0;

    for (const element of walk(root)) {
        if (element.tag !== 'a') continue;
        const url = normalizeUrl(element.attrs.href, base);
        if (!url) continue;
        const title = toLines(textOf(element)).join(' ').trim();
        if (!title) continue;
        anchorCount++;
        const link = { title, url };
        let node = element.parent;
        let depth = 0;
        while (node && depth < 7) {
            if (CHAPTER_CONTAINER_TAGS.has(node.tag)) {
                let bucket = buckets.get(node);
                if (!bucket) {
                    bucket = [];
                    buckets.set(node, bucket);
                }
                bucket.push(link);
            }
            node = node.parent;
            depth++;
        }
    }

    if (anchorCount < 3) return [];

    let best = null;
    let bestScore = 0;
    let bestLinks = [];
    for (const [node, links] of buckets) {
        if (links.length < 3) continue;
        const score = scoreChapterContainer(node, links);
        if (score > bestScore) {
            bestScore = score;
            best = node;
            bestLinks = links;
        }
    }

    if (!best) return [];
    let links = dedupeLinks(bestLinks).filter(link => link.title.length <= 80);
    // 容器里可能混着「最新章节」块和导航，按标题再筛一次
    const chapterOnly = links.filter(link => isChapterTitle(link.title));
    if (chapterOnly.length >= 3) links = chapterOnly;
    return reorderChapters(links);
}

/* ------------------------------------------------------------------ */
/* 元信息                                                              */
/* ------------------------------------------------------------------ */

function metaContent(root, keys) {
    for (const element of walk(root)) {
        if (element.tag !== 'meta') continue;
        const name = String(element.attrs.property || element.attrs.name || '').toLowerCase();
        if (!name) continue;
        if (keys.some(key => name === key)) {
            const content = String(element.attrs.content || '').trim();
            if (content) return content;
        }
    }
    return '';
}

const TITLE_NOISE_RE = /(最新章节|全文阅读|免费阅读|无弹窗|笔趣阁|小说网|文学网|阅读网|中文网|顶点小说|请记住|手机版|首页)/;

/** 把「书名_最新章节_某某小说网」这类标题洗成书名 */
export function cleanBookTitle(raw) {
    let text = String(raw || '').trim();
    if (!text) return '';
    text = text.replace(/[\s\u3000]+/g, ' ');
    // 常见分隔符切开，取第一段不是站点名的
    const parts = text.split(/\s*[_|｜\-–—·]\s*/).map(part => part.trim()).filter(Boolean);
    if (parts.length > 1) {
        const candidate = parts.find(part => !TITLE_NOISE_RE.test(part) && part.length >= 2);
        if (candidate) text = candidate;
        else text = parts[0];
    }
    text = text.replace(/^《(.+)》$/, '$1').trim();
    return text.slice(0, 80);
}

function findTitleNode(root) {
    for (const selector of ['h1', '.bookname h1', '#info h1', '.book-info h1', '.booktitle', '#bookname']) {
        const node = querySelector(root, selector);
        if (node) {
            const text = toLines(textOf(node)).join(' ').trim();
            if (text) return text;
        }
    }
    return '';
}

/* ------------------------------------------------------------------ */
/* 搜索页解析                                                          */
/* ------------------------------------------------------------------ */

function cleanSearchTitle(text) {
    return String(text || '')
        .replace(/<[^>]*>/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
}

/**
 * 解析「站内搜索结果页」—— 书源没写规则、或者规则没命中时的兜底解析。
 * （只做通用结构：结果块 → 标题链接 → 摘要；网页搜索那条通道已经删掉了）
 */
export function parseSearchPage(html, pageUrl) {
    const root = parseHtml(html);
    const results = [];
    const push = (title, url) => {
        const name = cleanSearchTitle(title);
        const href = normalizeUrl(url, pageUrl);
        if (!href || !name) return;
        if (name.length < 2) return;
        results.push({ title: name, url: href, site: hostOf(href), snippet: '' });
    };

    if (!results.length) {
        for (const item of querySelectorAll(root, 'article, .result, .search-result, .result-item')) {
            const anchor = querySelector(item, 'h3 a') || querySelector(item, 'h2 a') || querySelector(item, 'a');
            if (!anchor) continue;
            push(toLines(textOf(anchor)).join(' '), anchor.attrs.href);
        }
    }

    if (!results.length) {
        // 通用兜底：把页面里所有「看起来像标题的外链」都捡起来
        const skipRe = /^(?:首页|登录|注册|下一页|上一页|更多|查看更多|下载|客户端|关于我们|联系我们|意见反馈|广告服务)$/;
        for (const anchor of querySelectorAll(root, 'a')) {
            const title = toLines(textOf(anchor)).join(' ').trim();
            const href = normalizeUrl(anchor.attrs.href, pageUrl);
            if (!href || !title) continue;
            if (title.length < 4 || title.length > 90) continue;
            if (skipRe.test(title)) continue;
            push(title, href);
        }
    }

    // 去重 + 去掉纯导航链接，保留站点分组信息
    const seen = new Set();
    const filtered = [];
    for (const item of results) {
        if (seen.has(item.url)) continue;
        seen.add(item.url);
        filtered.push(item);
    }
    // 单个搜索结果页最多解析 200 条；真正的分页由 UI 负责
    return filtered.slice(0, 200);
}

function hostOf(url) {
    try {
        return new URL(url).hostname.replace(/^www\./, '');
    } catch {
        return '';
    }
}

/* ------------------------------------------------------------------ */
/* 书籍页解析                                                          */
/* ------------------------------------------------------------------ */

function findIntro(root) {
    const meta = metaContent(root, ['og:description', 'description']);
    if (meta && meta.length > 12) return meta.slice(0, 600);
    for (const selector of ['#intro', '.intro', '.book-intro', '.description', '.book-description', '.summary']) {
        const node = querySelector(root, selector);
        if (!node) continue;
        const text = toLines(textOf(node)).join('\n');
        if (text.length > 20) return text.slice(0, 600);
    }
    return '';
}

function findCover(root, base) {
    const meta = metaContent(root, ['og:image', 'twitter:image']);
    if (meta) return normalizeUrl(meta, base);
    for (const selector of ['.book-cover img', '.cover img', '#fmimg img', '.book-img img']) {
        const node = querySelector(root, selector);
        const src = node?.attrs['data-src'] || node?.attrs.src;
        const url = normalizeUrl(src, base);
        if (url) return url;
    }
    return '';
}

function findAuthor(root) {
    const meta = metaContent(root, ['og:novel:author', 'author']);
    if (meta) return cleanAuthor(meta);
    for (const selector of ['#info a', '.book-info .author', '.author', '.booktag a']) {
        const node = querySelector(root, selector);
        const text = toLines(textOf(node)).join(' ').trim();
        if (text && text.length <= 30) return cleanAuthor(text);
    }
    // 书籍信息区里常见的「作者：xxx」；只在有信息区时读，避免整页扫描
    const info = querySelector(root, '.book-info') || querySelector(root, '#info') || querySelector(root, '.booktag');
    if (!info) return '';
    const match = textOf(info).slice(0, 4000).match(/作\s*者[:：]\s*([^\s|，,。]{1,24})/);
    return match ? cleanAuthor(match[1]) : '';
}

function cleanAuthor(value) {
    return String(value || '')
        .replace(/^作者[:：]?\s*/, '')
        .replace(/[|｜].*$/, '')
        .trim()
        .slice(0, 30);
}

/** 找目录页链接（当前打开的是章节页时用） */
function findTocLink(root, base) {
    for (const anchor of querySelectorAll(root, 'a')) {
        const title = toLines(textOf(anchor)).join('').trim();
        if (!/^(?:目录|返回目录|章节目录|全部章节|查看目录|回目录|书目)$/.test(title)) continue;
        const url = normalizeUrl(anchor.attrs.href, base);
        if (url) return url;
    }
    return '';
}

/** 目录分页：index_2.html / page/2 这类 */
function findNextListLink(root, base) {
    for (const anchor of querySelectorAll(root, 'a')) {
        const title = toLines(textOf(anchor)).join('').trim();
        if (!/^(?:下一页|下页|Next|next)$/.test(title)) continue;
        const url = normalizeUrl(anchor.attrs.href, base);
        if (url && url !== base) return url;
    }
    return '';
}

/** 正文候选打分：文本长、链接少、段落多者胜 */
function pickContentNode(root) {
    annotateLengths(root);
    const candidates = [];
    for (const element of walk(root)) {
        if (!['div', 'article', 'section', 'main', 'td', 'p'].includes(element.tag)) continue;
        if (element.len < 120 || element.len > 400000) continue;
        candidates.push(element);
    }
    if (!candidates.length) return null;
    candidates.sort((left, right) => right.len - left.len);
    let best = null;
    let bestScore = 0;
    for (const element of candidates.slice(0, 40)) {
        const linkChars = sumLinkChars(element);
        let breaks = 0;
        for (const child of walk(element)) {
            if (child.tag === 'br' || child.tag === 'p') breaks++;
        }
        const score = element.len - linkChars * 4 + breaks * 40;
        if (score > bestScore) {
            bestScore = score;
            best = element;
        }
    }
    return best;
}

function contentNodeFromSelectors(root) {
    let best = null;
    let bestLen = 0;
    for (const selector of CONTENT_SELECTORS) {
        for (const node of querySelectorAll(root, selector)) {
            const length = textOf(node).length;
            if (length > bestLen) {
                bestLen = length;
                best = node;
            }
        }
    }
    return bestLen >= 80 ? best : null;
}

/** 广告行过滤 + 去掉连续重复行 */
export function cleanChapterLines(lines) {
    const result = [];
    let previous = '';
    for (const line of lines) {
        if (AD_LINE_RULES.some(rule => line.length <= rule.max && rule.re.test(line))) continue;
        if (line === previous) continue;
        previous = line;
        result.push(line);
    }
    return result;
}

/* ------------------------------------------------------------------ */
/* 章节页解析                                                          */
/* ------------------------------------------------------------------ */

/**
 * 解析章节正文页。
 * 返回 { title, text, url, nextUrl, prevUrl, charCount }
 */
export function parseChapterPage(html, pageUrl) {
    const root = parseHtml(html);
    const titleFromPage = (() => {
        const heading = querySelector(root, 'h1');
        const headingText = heading ? toLines(textOf(heading)).join(' ').trim() : '';
        if (headingText && headingText.length <= 60) return headingText;
        for (const selector of ['.bookname h1', '#chaptertitle', '.title', '.chapter-title', '.content h1']) {
            const node = querySelector(root, selector);
            const text = node ? toLines(textOf(node)).join(' ').trim() : '';
            if (text && text.length <= 60) return text;
        }
        const titleTag = querySelector(root, 'title');
        if (titleTag) {
            return cleanBookTitle(toLines(textOf(titleTag)).join(' '));
        }
        return '';
    })();

    let node = contentNodeFromSelectors(root);
    if (!node) node = pickContentNode(root);
    // 最后兜底：短章节（诗句、单段）整页都不到阈值时才读 body；
    // 页面太长说明多半是登录墙 / 验证页，宁可报错也不要把导航当正文
    if (!node) {
        const body = querySelector(root, 'body') || root;
        const bodyText = toLines(textOf(body)).join('\n');
        if (bodyText.length >= 20 && bodyText.length <= 6000) node = body;
    }

    let lines = node ? toLines(textOf(node)) : [];
    // 正文首行常常重复章节标题，去掉
    if (titleFromPage && lines.length && lines[0] === titleFromPage) lines = lines.slice(1);
    lines = cleanChapterLines(lines);
    const text = lines.join('\n\n').trim();

    let nextUrl = '';
    let prevUrl = '';
    for (const anchor of querySelectorAll(root, 'a')) {
        const label = toLines(textOf(anchor)).join('').trim();
        const href = normalizeUrl(anchor.attrs.href, pageUrl);
        if (!href) continue;
        if (!nextUrl && /^(?:下一[章页篇]|下页|下一页|next)$/i.test(label)) nextUrl = href;
        if (!prevUrl && /^(?:上一[章页篇]|上页|上一页|prev|previous)$/i.test(label)) prevUrl = href;
    }

    return {
        title: titleFromPage,
        text,
        url: pageUrl,
        nextUrl,
        prevUrl,
        charCount: text.length,
    };
}

/* ------------------------------------------------------------------ */
/* 书籍页解析（章节列表）                                              */
/* ------------------------------------------------------------------ */

/**
 * 解析书籍详情页 / 目录页。
 * 返回 { title, author, intro, cover, chapters, tocUrl, nextListUrl, isChapterPage }
 */
export function parseBookPage(html, pageUrl) {
    const root = parseHtml(html);
    annotateLengths(root);

    const chapters = findChapterContainer(root, pageUrl);
    const title = cleanBookTitle(metaContent(root, ['og:novel:book_name', 'og:title']) || findTitleNode(root));
    const author = findAuthor(root);
    const intro = findIntro(root);
    const cover = findCover(root, pageUrl);
    const tocUrl = findTocLink(root, pageUrl);
    const nextListUrl = chapters.length ? findNextListLink(root, pageUrl) : '';
    const bodyLength = root.len || 0;
    // 章节页：几乎没有章节链接但正文很长；或者标题本身就是「第 X 章」且链接很少
    const looksLikeChapter = CHAPTER_TITLE_RE.test(title) || CHAPTER_NUMBER_RE.test(title);
    const isChapterPage = (chapters.length < 2 && bodyLength > 400)
        || (looksLikeChapter && chapters.length < 5);

    return {
        url: pageUrl,
        title,
        author,
        intro,
        cover,
        chapters,
        tocUrl,
        nextListUrl,
        isChapterPage,
    };
}

/* ------------------------------------------------------------------ */
/* 抓取                                                                */
/* ------------------------------------------------------------------ */

/** 从 HTML 字节流里嗅探编码（中文小说站大量 GBK / GB2312） */
export function detectCharset(bytes) {
    const sample = bytes.slice(0, 4096);
    let head = '';
    try {
        head = new TextDecoder('latin1').decode(sample).toLowerCase();
    } catch {
        head = '';
    }
    const match = head.match(/charset\s*=\s*["']?\s*([\w-]+)/);
    if (match) {
        const name = match[1].toLowerCase();
        if (name === 'gb2312' || name === 'gbk' || name === 'gb18030') return 'gb18030';
        if (name === 'big5') return 'big5';
        if (name === 'utf-8' || name === 'utf8') return 'utf-8';
        return name;
    }
    if (head.includes('charset=gbk') || head.includes('charset=gb2312')) return 'gb18030';
    return 'utf-8';
}

/** 按嗅探到的编码解码 HTML 字节；解码失败退回 UTF-8 */
export function decodeHtmlBytes(bytes) {
    const charset = detectCharset(bytes);
    try {
        return new TextDecoder(charset, { fatal: false }).decode(bytes);
    } catch {
        try {
            return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        } catch {
            let text = '';
            for (const byte of bytes) text += String.fromCharCode(byte);
            return text;
        }
    }
}

/** 把目标地址塞进用户填的代理模板 */
export function buildProxyUrl(template, url) {
    const tpl = String(template || '').trim();
    if (!tpl) return '';
    if (tpl.includes('{url}')) return tpl.replace(/\{url\}/g, encodeURIComponent(url));
    if (tpl.includes('{raw}')) return tpl.replace(/\{raw\}/g, url);
    return `${tpl}${tpl.includes('?') ? '&' : '?'}url=${encodeURIComponent(url)}`;
}

/** 让「用户点了停止」以 AbortError 的形式传出去，UI 才能识别成取消而不是报错 */
function toAbortError(reason) {
    const error = new Error(reason?.message || '已停止');
    error.name = 'AbortError';
    return error;
}

function describeFetchError(error, channels) {
    const reason = error?.message || String(error || '');
    const tavernStatus = Number((reason.match(/酒馆网页通道返回 (\d+)/) || [])[1] || 0);
    if (channels.includes('tavern') && tavernStatus) {
        return new Error('酒馆网页通道没能取到这个页面（可能是站点拒绝或页面不是 HTML）：换个书源 / 站点，或直接粘贴章节页链接试试');
    }
    if (/Failed to fetch|NetworkError|Load failed|CORS/i.test(reason)) {
        return new Error('抓取被浏览器跨域限制拦下了：请在「抓取设置」里把通道改成「酒馆网页通道」，或填一个 CORS 代理地址');
    }
    return new Error(`抓取失败：${reason || '未知错误'}`);
}

/**
 * 抓取器：封装通道选择、超时、编码解码。
 * 所有网络请求都从这里出去，方便测试时注入假的 fetch。
 */
export class NovelFetcher {
    constructor({ settings, fetchImpl, getRequestHeaders } = {}) {
        this.settings = normalizeOnlineSettings(settings);
        this.fetchImpl = fetchImpl || globalThis.fetch?.bind(globalThis);
        this.getRequestHeaders = getRequestHeaders || null;
        this.lastChannel = '';
        this.fanqieClient = null;
        /** 抓取桥接能不能用：null = 还没试过；false = 试过 404/连不上，之后不再每页都撞一次 */
        this.bridgeAvailable = null;
    }

    update(settings) {
        const previousBridge = this.settings.fanqieBridge;
        this.settings = normalizeOnlineSettings({ ...this.settings, ...settings });
        // 桥接地址改过 = 换了一个桥接，之前「没装」的判断作废
        if (this.settings.fanqieBridge !== previousBridge) this.bridgeAvailable = null;
        if (this.fanqieClient) {
            this.fanqieClient.update({
                base: this.settings.fanqieBridge,
                upstream: this.settings.fanqieUpstream,
            });
        }
        return this.settings;
    }

    /** 番茄（本地下载器桥接）客户端，跟着设置懒建 */
    fanqie() {
        if (!this.fanqieClient) {
            this.fanqieClient = new FanqieClient({
                base: this.settings.fanqieBridge,
                upstream: this.settings.fanqieUpstream,
                fetchImpl: this.fetchImpl,
                getRequestHeaders: this.getRequestHeaders,
            });
        }
        return this.fanqieClient;
    }

    channelOrder() {
        const { channel, proxyTemplate } = this.settings;
        if (channel === 'tavern') return ['tavern'];
        if (channel === 'proxy') return ['proxy'];
        const order = [];
        // 桥接排第一：酒馆的 /api/search/visit 只接 text/html，还会被站点按地区 / UA 拒（Bing 就是典型）；
        // 桥接的 /fetch 不限 content-type、能带请求头、失败还能在服务端退 curl。
        // 没装时只会白试一次，之后 bridgeAvailable 记成 false 就不再撞了。
        if (this.bridgeAvailable !== false) order.push('bridge');
        if (typeof this.getRequestHeaders === 'function') order.push('tavern');
        if (proxyTemplate) order.push('proxy');
        // 最后一档兜底：酒馆网页通道被策略拒绝（非标准端口 / IP / 非 text-html）时，只有直连还有机会。
        // 它不作为可选项暴露给用户 —— 普通站点会直接被 CORS 拦掉。
        order.push('direct');
        // 记住上次成功的通道并提到最前：书源批量搜索时不用每个请求都先撞一遍失败通道
        const preferred = this.lastGoodChannel;
        if (preferred && order.includes(preferred)) {
            order.splice(order.indexOf(preferred), 1);
            order.unshift(preferred);
        }
        return order;
    }

    async fetchHtml(url, { signal } = {}) {
        if (typeof this.fetchImpl !== 'function') throw new Error('当前环境没有可用的 fetch');
        const target = normalizeUrl(url);
        if (!target) throw new Error('链接无效（只支持 http / https）');
        const channels = this.channelOrder();
        let lastError = null;
        /** 酒馆通道的 400/500 是最有信息量的那条（其余通道多半只会丢一句 CORS），留着优先报它 */
        let tavernError = null;
        for (const channel of channels) {
            try {
                const html = await this.fetchVia(channel, target, signal);
                if (!html || html.length < 60) throw new Error('返回内容过短，可能被站点拒绝');
                this.lastChannel = channel;
                if (this.settings.channel === 'auto') this.lastGoodChannel = channel;
                return html;
            } catch (error) {
                if (signal?.aborted) throw toAbortError(signal.reason);
                if (error?.name === 'AbortError') throw error;
                lastError = error;
                if (channel === 'tavern' && /酒馆网页通道返回\s*\d+/.test(String(error?.message))) tavernError = error;
            }
        }
        throw describeFetchError(tavernError || lastError, channels);
    }

    async fetchVia(channel, target, outerSignal) {
        const timeoutMs = this.settings.timeoutMs;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error('抓取超时')), timeoutMs);
        if (outerSignal) {
            if (outerSignal.aborted) controller.abort(outerSignal.reason);
            else outerSignal.addEventListener('abort', () => controller.abort(outerSignal.reason), { once: true });
        }
        try {
            if (channel === 'bridge') return await this.fetchViaBridge(target, controller.signal);
            if (channel === 'tavern') return await this.fetchViaTavern(target, controller.signal);
            if (channel === 'proxy') return await this.fetchViaProxy(target, controller.signal);
            return await this.fetchViaDirect(target, controller.signal);
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * 走服务端桥接的 /fetch：书源抓页、粘链接打开的书籍页都先从这儿过。
     * 比酒馆 /api/search/visit 宽松得多 —— 它只接 text/html，还会被搜索引擎按地区/UA 拒。
     */
    async fetchViaBridge(target, signal) {
        const base = String(this.settings.fanqieBridge || '/api/plugins/fanqie-bridge').replace(/\/+$/, '');
        const headers = { ...(this.getRequestHeaders?.() || {}), 'Content-Type': 'application/json' };
        let response;
        try {
            response = await this.fetchImpl(`${base}/fetch`, {
                method: 'POST',
                headers,
                signal,
                body: JSON.stringify({
                    url: target,
                    method: 'GET',
                    headers: {
                        Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
                        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
                    },
                }),
            });
        } catch (error) {
            if (error?.name === 'AbortError') throw error;
            // 超时只是「这次慢」，不代表桥接没装：别为它把整条通道关掉
            if (error?.message !== '抓取超时') this.bridgeAvailable = false;
            throw new Error(`桥接抓取失败：${error?.message || '连不上'}`);
        }
        if (response.status === 404) {
            // 路由不存在 = 桥接没装，后面别再试了
            this.bridgeAvailable = false;
            throw new Error('桥接抓取失败：桥接没装（404）');
        }
        let payload = null;
        try {
            payload = await response.json();
        } catch {
            payload = null;
        }
        if (!response.ok || !payload || payload.ok === false) {
            throw new Error(`桥接抓取失败：${payload?.error || `HTTP ${response.status}`}`);
        }
        const text = String(payload.text ?? '');
        if (!text) throw new Error('桥接抓取失败：返回为空');
        this.bridgeAvailable = true;
        return text;
    }

    async fetchViaTavern(target, signal) {
        if (typeof this.getRequestHeaders !== 'function') throw new Error('酒馆网页通道不可用');
        const headers = {
            ...(this.getRequestHeaders() || {}),
            'Content-Type': 'application/json',
        };
        const response = await this.fetchImpl('/api/search/visit', {
            method: 'POST',
            headers,
            body: JSON.stringify({ url: target, html: true }),
            signal,
        });
        if (!response.ok) throw new Error(`酒馆网页通道返回 ${response.status}`);
        return await response.text();
    }

    async fetchViaDirect(target, signal) {
        const response = await this.fetchImpl(target, {
            method: 'GET',
            credentials: 'omit',
            redirect: 'follow',
            signal,
            headers: {
                Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
            },
        });
        if (!response.ok) throw new Error(`站点返回 ${response.status}`);
        const buffer = await response.arrayBuffer();
        return decodeHtmlBytes(new Uint8Array(buffer));
    }

    async fetchViaProxy(target, signal) {
        const proxyUrl = buildProxyUrl(this.settings.proxyTemplate, target);
        if (!proxyUrl) throw new Error('没有填写 CORS 代理地址');
        const response = await this.fetchImpl(proxyUrl, {
            method: 'GET',
            redirect: 'follow',
            signal,
            headers: { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
        });
        if (!response.ok) throw new Error(`代理返回 ${response.status}`);
        const buffer = await response.arrayBuffer();
        return decodeHtmlBytes(new Uint8Array(buffer));
    }

    /** 搜索小说；page 从 1 开始，返回 [{ title, url, site, snippet }] */
    async searchBooks(keyword, { signal, page = 1 } = {}) {
        const query = String(keyword || '').trim();
        if (!query) throw new Error('请输入书名或作者');
        const settings = this.settings;
        const pageNo = Math.max(1, Math.floor(Number(page) || 1));
        // 番茄走本地下载器：返回结构化书目，不经过搜索引擎，也没有分页
        if (settings.searchEngine === 'fanqie') {
            if (pageNo > 1) return [];
            return await this.fanqie().search(query, { signal });
        }
        if (settings.searchEngine === 'source') {
            return await this.searchBySource(query, { signal, page: pageNo });
        }
        throw new Error(`未知的搜索通道：${settings.searchEngine}`);
    }

    /** 当前可用的书源（enabled !== false） */
    sourceList() {
        const list = Array.isArray(this.settings.sources) ? this.settings.sources : [];
        return list.filter(source => source && source.enabled !== false);
    }

    /** 找这个地址属于哪个书源：主机名对得上就认 */
    findSource(url) {
        const list = this.sourceList();
        const matched = list.filter(source => sourceMatchesUrl(source, url));
        return matched.length ? matched[0] : null;
    }

    /**
     * 在所有启用的书源上并发搜索。
     * @returns {{results: object[], perSource: {id:string,name:string,count:number,error:string,done:boolean,ms:number}[]}}
     */
    async searchAllSources(keyword, { signal, concurrency, onProgress, onSourceDone } = {}) {
        const sources = this.sourceList();
        if (!sources.length) throw new Error('还没有启用的书源：点「书源管理」导入，并至少启用一个');
        const limit = Math.max(1, Math.min(8, Math.floor(Number(concurrency) || Number(this.settings.concurrency) || 3)));
        const perSource = sources.map(source => ({ id: source.id, name: source.name, count: 0, error: '', done: false, ms: 0 }));
        const collected = [];
        // 同一个搜索地址（多个书源指向同一站）只抓一次，省一半请求
        const pageCache = new Map();
        let finished = 0;
        await mapLimit(sources, limit, async (source, index) => {
            const entry = perSource[index];
            const startedAt = Date.now();
            if (signal?.aborted) {
                entry.error = '已停止';
                entry.done = true;
                return;
            }
            let items = [];
            try {
                const url = buildSourceSearchUrl(source, keyword, 1);
                if (!url) throw new Error('书源没写搜索地址');
                if (!pageCache.has(url)) {
                    pageCache.set(url, this.fetchHtml(url, { signal }));
                }
                const html = await pageCache.get(url);
                const list = parseSourceSearchPage(html, url, source);
                items = list.map(item => ({ ...item, sourceId: source.id, sourceName: source.name, sourceOrder: index }));
                entry.count = items.length;
                collected.push(...items);
            } catch (error) {
                entry.error = signal?.aborted ? '已停止' : (error?.message || '搜索失败');
            } finally {
                entry.ms = Date.now() - startedAt;
                entry.done = true;
                finished++;
                // 先把这个源的结果交出去，界面可以立刻显示，不用等最慢的那个
                onSourceDone?.({ source: entry, items, perSource });
                onProgress?.({
                    finished,
                    total: sources.length,
                    source: entry,
                    perSource,
                    count: collected.length,
                });
            }
        });
        return { results: mergeSourceResults(collected, this.settings.sourceSort), perSource };
    }

    /** 用单个书源搜索（「只用某个源」的旧路径，保留给测试和调试） */
    async searchBySource(keyword, { signal, page = 1 } = {}) {
        const source = pickSource(this.settings.sources);
        if (!source) throw new Error('还没有可用的书源：在「找书」页点「书源管理」导入一份');
        if (!source.search?.url) {
            throw new Error(`书源「${source.name}」没写搜索地址：把它换成「只用链接」后直接粘书籍页链接`);
        }
        const url = buildSourceSearchUrl(source, keyword, page);
        if (!url) throw new Error(`书源「${source.name}」的搜索地址拼不出来：检查它有没有 {key} 占位`);
        const html = await this.fetchHtml(url, { signal });
        return parseSourceSearchPage(html, url, source);
    }

    /**
     * 打开一个书籍页，返回 { title, author, intro, cover, chapters, url }。
     * 如果用户粘的是章节页，会先找目录页；找不到就当成单章书。
     */
    async openBook(url, { signal, onProgress = null } = {}) {
        // 番茄书：只有下载器能给详情，而且没有单章接口，书目标记成 downloadOnly
        if (isFanqieUrl(url)) {
            onProgress?.('正在向番茄下载器要书目…');
            const book = await this.fanqie().preview(fanqieBookIdFromUrl(url), { signal });
            if (!book.chapterCount) throw new Error('这本书在番茄那边没有章节信息（可能已下架）');
            onProgress?.(`《${book.title}》共 ${book.chapterCount} 章，需要整本下载后阅读`);
            return book;
        }
        const target = normalizeUrl(url);
        if (!target) throw new Error('链接无效（只支持 http / https）');
        const source = this.findSource(target);
        onProgress?.(source ? `正在用书源「${source.name}」打开页面…` : '正在打开页面…');
        const html = await this.fetchHtml(target, { signal });
        if (source) {
            const sourced = parseSourceBookPage(html, target, source);
            if (sourced.chapters.length >= 2) {
                return { ...sourced, url: target, singleChapter: false };
            }
            onProgress?.(`书源「${source.name}」没解析出目录，改用通用解析…`);
        }
        let book = parseBookPage(html, target);

        if (book.isChapterPage) {
            onProgress?.('这是章节页，正在找目录…');
            const tocUrl = book.tocUrl || '';
            if (tocUrl) {
                try {
                    const tocHtml = await this.fetchHtml(tocUrl, { signal });
                    const tocBook = parseBookPage(tocHtml, tocUrl);
                    if (tocBook.chapters.length >= 2) {
                        book = tocBook;
                        if (!book.title) book.title = cleanBookTitle(findTitleNode(parseHtml(html)));
                    }
                } catch {
                    // 目录抓不到就退化成单章
                }
            }
            if (book.chapters.length < 2) {
                const chapter = parseChapterPage(html, target);
                book = {
                    ...book,
                    title: book.title || chapter.title || '在线章节',
                    chapters: [{ title: chapter.title || '正文', url: target }],
                };
                return { ...book, url: target, singleChapter: true };
            }
        }

        // 目录分页：最多跟 5 页，避免死循环
        let pages = 0;
        let nextUrl = book.nextListUrl;
        const collected = [...book.chapters];
        while (nextUrl && pages < 5 && !signal?.aborted) {
            pages++;
            onProgress?.(`正在读取目录第 ${pages + 1} 页…`);
            try {
                const nextHtml = await this.fetchHtml(nextUrl, { signal });
                const nextBook = parseBookPage(nextHtml, nextUrl);
                const merged = dedupeLinks([...collected, ...nextBook.chapters]);
                collected.length = 0;
                collected.push(...merged);
                nextUrl = nextBook.nextListUrl && nextBook.nextListUrl !== nextUrl ? nextBook.nextListUrl : '';
            } catch {
                break;
            }
        }

        if (collected.length > book.chapters.length) {
            book.chapters = reorderChapters(dedupeLinks(collected));
        }
        if (!book.title) book.title = '未命名小说';
        return { ...book, url: target, singleChapter: false };
    }

    /** 抓一章正文 */
    async fetchChapter(url, { signal } = {}) {
        if (isFanqieUrl(url)) {
            throw new Error('番茄书不支持单章抓取：请用「下载并导入书架」，正文会整本取回后再分章');
        }
        const html = await this.fetchHtml(url, { signal });
        const source = this.findSource(url);
        if (source) {
            const parsed = parseSourceChapterPage(html, url, source);
            if (parsed.text && parsed.text.length >= 10) return parsed;
        }
        const chapter = parseChapterPage(html, url);
        if (!chapter.text || chapter.text.length < 10) {
            throw new Error('这一章没解析到正文（站点可能要求登录或换了版式）');
        }
        return chapter;
    }
}

/* ------------------------------------------------------------------ */
/* 书源结果合并                                                        */
/* ------------------------------------------------------------------ */

/** 归一化书名 / 作者，用来判断「不同书源里的同一本书」 */
function resultKey(title, author) {
    const clean = value => String(value || '')
        .replace(/[\s《》<>【】()（）·.,，。!！?？:：;；'"“”]/g, '')
        .toLowerCase();
    return `${clean(title)}|${clean(author)}`;
}

/**
 * 合并多个书源的搜索结果：同一本书只留一条，其它来源挂在 sources 里。
 * 结果卡片上的「N 个来源」和切换按钮都用这个列表。
 */
/**
 * 合并后的排序：默认按「书源启用顺序」（阅读的做法：结果跟着书源来，不按热度/评分重排）。
 * - source：按主来源在启用列表里的次序，同次序保持站内原顺序
 * - title：按书名
 * - arrival：谁先搜到谁在前（并发下顺序会抖）
 */
export function sortSourceResults(groups, mode = 'source') {
    const list = Array.isArray(groups) ? [...groups] : [];
    if (mode === 'title') {
        return list.sort((left, right) => String(left.title || '').localeCompare(String(right.title || ''), 'zh-Hans-CN'));
    }
    if (mode === 'arrival') return list;
    return list.sort((left, right) => {
        const leftOrder = Number(left.sources?.[0]?.sourceOrder ?? 0);
        const rightOrder = Number(right.sources?.[0]?.sourceOrder ?? 0);
        return leftOrder - rightOrder;
    });
}

export function mergeSourceResults(results, sortMode = 'source') {
    const list = Array.isArray(results) ? results : [];
    const groups = new Map();
    for (const item of list) {
        if (!item?.title || !item?.url) continue;
        const key = resultKey(item.title, item.author || '');
        const sourceEntry = {
            sourceId: item.sourceId || '',
            sourceName: item.sourceName || item.site || '',
            url: item.url,
            site: item.site || '',
            sourceOrder: Number(item.sourceOrder) || 0,
        };
        const existing = groups.get(key);
        if (!existing) {
            groups.set(key, { ...item, sources: [sourceEntry] });
            continue;
        }
        // 同一个书源里的重复链接才合并；不同书源指向同一个地址仍然各算一个来源
        if (existing.sources.some(entry => entry.url === sourceEntry.url && entry.sourceId === sourceEntry.sourceId)) continue;
        existing.sources.push(sourceEntry);
        if (!existing.author && item.author) existing.author = item.author;
        if (!existing.snippet && item.snippet) existing.snippet = item.snippet;
    }
    return sortSourceResults([...groups.values()], sortMode);
}

/* ------------------------------------------------------------------ */
/* 导出                                                                */
/* ------------------------------------------------------------------ */

/** 把章节拼成一份可以导入书架的 TXT */
export function buildBookText(book, chapters) {
    const lines = [String(book?.title || '未命名小说').trim()];
    if (book?.author) lines.push(`作者：${book.author}`);
    if (book?.url) lines.push(`来源：${book.url}`);
    lines.push('');
    for (const chapter of chapters || []) {
        const text = String(chapter?.content || '').trim();
        if (!text) continue;
        lines.push('');
        lines.push(String(chapter.title || '').trim());
        lines.push('');
        lines.push(text);
    }
    return `${lines.join('\n').trim()}\n`;
}

/** 从地址生成一个稳定的书 id 片段，用于在线阅读时的临时 id */
export function bookIdFromUrl(url) {
    const host = hostOf(url) || 'online';
    let hash = 0;
    const source = String(url || '');
    for (let i = 0; i < source.length; i++) {
        hash = ((hash << 5) + hash + source.charCodeAt(i)) | 0;
    }
    return `${host}-${Math.abs(hash).toString(36)}`;
}
