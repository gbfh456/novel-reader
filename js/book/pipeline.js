/**
 * 书源 - 书籍流水线
 *
 * 把「书源 + 规则引擎 + 网络」串成 Legado 的四段流程：
 *   搜索 / 发现 → 详情 → 目录（可翻页）→ 正文（可翻页、替换净化）
 *
 * 不直接碰界面和数据库：输入书源，输出结构化数据，方便 Node 测试与后面接书架。
 */

import { createRuleContext, getElementsAsync, getStringAsync, replaceText } from '../rule/execute.js';
import { nodeAttr, nodeText, parseDocument, selectAll } from '../rule/dom.js';
import { buildRequest } from '../net/url.js';
import { extractImages, htmlToText, normalizeParagraphs, rebuildParagraphs } from './text.js';

/** 识别「正文其实是错误 JSON」的情况，返回可读的提示 */
export function describeApiError(text) {
    const source = String(text ?? '').trim();
    if (!source || source.length > 600) return '';
    if (!source.startsWith('{') && !source.startsWith('[')) return '';
    let data = null;
    try {
        data = JSON.parse(source);
    } catch {
        return '';
    }
    const message = String(data?.message || data?.msg || data?.error || data?.errmsg || '').trim();
    const code = data?.code ?? data?.status ?? data?.ret ?? '';
    if (!message && code === '') return '';
    const detail = [message, code !== '' ? `code=${code}` : ''].filter(Boolean).join(' / ');
    if (/转码失败|参数错误|登录|未登录|授权|invalid|forbidden|无权限|token/i.test(detail)) {
        return `站点返回错误：${detail}（这个源可能需要登录 / Cookie，或已失效）`;
    }
    return `站点返回的不是正文：${detail || source.slice(0, 80)}`;
}

/** 站点拿「错误页 / 反爬页」冒充正文时，这些词一定会出现在很短的一段文字里 */
const CONTENT_ERROR_MARKERS = [
    /转码失败/,
    /换源切换源站/,
    /前往源网站(进行)?阅读/,
    /访问(过于|太)频繁/,
    /请求(过于|太)频繁/,
    /请(先)?开启\s*JavaScript/i,
    /人机验证/,
    /(本章|该章|章节)(内容)?(已被|已)屏蔽/,
    /(内容|章节)正在审核/,
    /(章节|内容)(不存在|已删除|已下架)/,
    /403\s*Forbidden/i,
    /404\s*Not\s*Found/i,
];

/**
 * 识别「抓到的不是正文，而是站点的错误页 / 反爬页」。
 * 只在文字很短时判定，避免把正常小说里偶然出现的词当成错误。
 */
export function describeContentError(text, { pageText = '' } = {}) {
    const body = normalizeParagraphs(String(text ?? '')).trim();
    const page = String(pageText ?? '');
    const sample = body || page;
    if (!sample) return '';
    const shortBody = body.length < 600;
    for (const pattern of CONTENT_ERROR_MARKERS) {
        const inBody = pattern.test(body);
        const inPage = !body && pattern.test(page);
        if (!inBody && !inPage) continue;
        if (inBody && !shortBody) continue;
        const hit = (sample.match(pattern) || [pattern.source])[0];
        return `站点返回的不是正文（命中「${hit}」）：这个源在拒绝抓取，换源、或先手动登录 / 补 Cookie 再试`;
    }
    return '';
}

export class BookPipeline {
    constructor({ client, onWarning = null, jsRunner = null, onTrace = null, fetchBase = '' } = {}) {
        if (!client) throw new Error('BookPipeline 需要 NetClient');
        this.client = client;
        this.onWarning = onWarning;
        /** 浏览器端 JS 沙箱执行器；Node 测试可以不传 */
        this.jsRunner = jsRunner;
        /** 规则调试：每次字段 / 列表求值后回调 */
        this.onTrace = onTrace;
        /** JS 沙箱同步取数用的桥接地址 */
        this.fetchBase = fetchBase || '/api/plugins/fanqie-bridge';
    }

    warn(message) {
        if (!message) return;
        if (typeof this.onWarning === 'function') this.onWarning(message);
        else console.warn('[书源]', message);
    }

    /** 取一页并建好规则上下文 */
    async openPage(template, { source = null, key = '', page = 1, baseUrl = '', signal = null, book = null, chapter = null } = {}) {
        const request = buildRequest(template, { source, key, page, baseUrl, book });
        if (request.warning) this.warn(request.warning);
        const sourceHeaders = this.headersOf(source);
        if (Object.keys(sourceHeaders).length) {
            request.headers = { ...sourceHeaders, ...request.headers };
        }
        const response = await this.client.requestWithRetry(request, { signal });
        const context = createRuleContext({
            source,
            book,
            chapter,
            baseUrl: response.finalUrl || request.url,
            redirectUrl: response.finalUrl || request.url,
            key,
            page,
            jsRunner: this.jsRunner,
            fetchBase: this.fetchBase,
        });
        return { ...response, request, context };
    }

    /** 用已经抓好的 HTML 建页面上下文（批量预取后本地解析用） */
    pageFromHtml(html, url, { source = null, book = null, chapter = null, key = '', page = 1 } = {}) {
        const context = createRuleContext({
            source,
            book,
            chapter,
            baseUrl: url,
            redirectUrl: url,
            key,
            page,
            jsRunner: this.jsRunner,
            fetchBase: this.fetchBase,
        });
        return { text: String(html ?? ''), finalUrl: url, url, status: 200, headers: {}, via: 'prefetch', context };
    }

    /** 书源的 header 规则（JSON；@js 需要 P4 沙箱） */
    headersOf(source) {
        const raw = String(source?.header || '').trim();
        if (!raw) return {};
        if (raw.startsWith('@js:') || raw.startsWith('<js>')) {
            this.warn('请求头规则用了 JS：P4 沙箱接入前先跳过');
            return {};
        }
        try {
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
            const headers = {};
            for (const [name, value] of Object.entries(parsed)) {
                if (value == null) continue;
                headers[String(name)] = String(value);
            }
            return headers;
        } catch {
            this.warn('请求头规则不是合法 JSON，已忽略');
            return {};
        }
    }

    /** 安全取字段：单条规则失败不影响整页 */
    async field(rule, content, context, { isUrl = false, fallback = '' } = {}) {
        if (!rule) return fallback;
        try {
            const value = await getStringAsync(rule, content, context, { isUrl });
            this.onTrace?.({ kind: 'field', rule: String(rule).slice(0, 200), count: value ? 1 : 0, trace: context.trace.slice(-2) });
            return value || fallback;
        } catch (error) {
            this.warn(`字段规则失败：${error.message}`);
            return fallback;
        }
    }

    /** 安全取列表 */
    async elements(rule, content, context) {
        if (!rule) return [];
        try {
            const list = await getElementsAsync(rule, content, context);
            this.onTrace?.({ kind: 'list', rule: String(rule).slice(0, 200), count: list.length, trace: context.trace.slice(-2) });
            return list;
        } catch (error) {
            this.warn(`列表规则失败：${error.message}`);
            return [];
        }
    }

    /**
     * 搜索一个书源。
     * @returns {Promise<{books:object[], ms:number, warnings:string[]}>}
     */
    async search(source, keyword, { page = 1, signal = null } = {}) {
        if (!source?.searchUrl) throw new Error(`书源「${source?.bookSourceName || '未命名'}」没有搜索地址`);
        const key = String(keyword ?? '').trim();
        if (!key) throw new Error('搜索关键词为空');
        const warnings = [];
        const collect = message => {
            warnings.push(message);
            this.warn(message);
        };
        const started = Date.now();
        const pageData = await this.openPage(source.searchUrl, { source, key, page, signal });
        const rule = source.ruleSearch || {};
        const items = await this.elements(rule.bookList, pageData.text, pageData.context);
        const books = [];
        const seen = new Set();
        for (const item of items) {
            let name = '';
            let bookUrl = '';
            try {
                name = await this.field(rule.name, item, pageData.context);
                bookUrl = await this.field(rule.bookUrl, item, pageData.context, { isUrl: true });
            } catch (error) {
                collect(`搜索条目解析失败：${error.message}`);
                continue;
            }
            if (!name || !bookUrl) continue;
            if (seen.has(bookUrl)) continue;
            seen.add(bookUrl);
            const author = await this.field(rule.author, item, pageData.context);
            const intro = await this.field(rule.intro, item, pageData.context);
            books.push({
                bookUrl,
                origin: source.bookSourceUrl,
                originName: source.bookSourceName,
                type: source.bookSourceType || 0,
                name: name.slice(0, 120),
                author: author.slice(0, 80),
                kind: (await this.field(rule.kind, item, pageData.context)).slice(0, 120),
                coverUrl: await this.field(rule.coverUrl, item, pageData.context, { isUrl: true }),
                intro: /[<>]/.test(intro) ? htmlToText(intro) : intro,
                wordCount: await this.field(rule.wordCount, item, pageData.context),
                latestChapterTitle: (await this.field(rule.lastChapter, item, pageData.context)).slice(0, 120),
                updateTime: (await this.field(rule.updateTime, item, pageData.context)),
                tocUrl: '',
                page,
                respondTime: Date.now() - started,
            });
        }
        return { books, ms: Date.now() - started, warnings };
    }

    /** 发现页：规则与搜索类似，地址由 exploreUrl 提供 */
    async explore(source, url, { page = 1, signal = null } = {}) {
        const target = url || source?.exploreUrl;
        if (!target) throw new Error('这个书源没有发现地址');
        const pageData = await this.openPage(target, { source, page, signal });
        const rule = source.ruleExplore || {};
        const items = await this.elements(rule.bookList, pageData.text, pageData.context);
        const books = [];
        for (const item of items) {
            const name = await this.field(rule.name, item, pageData.context);
            const bookUrl = await this.field(rule.bookUrl, item, pageData.context, { isUrl: true });
            if (!name || !bookUrl) continue;
            books.push({
                bookUrl,
                origin: source.bookSourceUrl,
                originName: source.bookSourceName,
                type: source.bookSourceType || 0,
                name,
                author: await this.field(rule.author, item, pageData.context),
                kind: await this.field(rule.kind, item, pageData.context),
                coverUrl: await this.field(rule.coverUrl, item, pageData.context, { isUrl: true }),
                intro: await this.field(rule.intro, item, pageData.context),
                wordCount: await this.field(rule.wordCount, item, pageData.context),
                latestChapterTitle: await this.field(rule.lastChapter, item, pageData.context),
                tocUrl: '',
                page,
            });
        }
        return { books, page: pageData };
    }

    /**
     * 详情页：补全书名、作者、简介、封面、目录地址。
     * 没什么可解析的（没有详情规则）时直接返回原书。
     */
    /**
     * 详情页兜底：规则没命中时，用页面自己的元信息补书名 / 作者 / 简介 / 最新章。
     * 很多站的 h1 是站名，真正的书名在 og:novel:* 里。
     */
    metaFallback(html, book = {}) {
        const source = String(html || '');
        if (!source) return { ...book };
        const pickMeta = pattern => {
            const match = source.match(pattern);
            return match ? match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim() : '';
        };
        const ogName = pickMeta(/<meta[^>]+property=["']og:novel:book_name["'][^>]+content=["']([^"']+)["']/i)
            || pickMeta(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:novel:book_name["']/i);
        let pageTitle = pickMeta(/<title>([^<]+)<\/title>/i);
        // 「诡秘之主_最新章节_诡秘之主全文在线阅读」→「诡秘之主」
        const cleanTitle = pageTitle.split(/[_|\-—]/)[0].replace(/《|》/g, '').trim();
        const name = book.name || ogName || cleanTitle;
        return {
            ...book,
            name: name || book.name || '',
            author: book.author || pickMeta(/<meta[^>]+property=["']og:novel:author["'][^>]+content=["']([^"']+)["']/i),
            intro: book.intro || pickMeta(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i),
            coverUrl: book.coverUrl || pickMeta(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i),
            latestChapterTitle: book.latestChapterTitle || pickMeta(/<meta[^>]+property=["']og:novel:latest_chapter_name["'][^>]+content=["']([^"']+)["']/i),
        };
    }

    async info(source, book, { signal = null } = {}) {
        const rule = source?.ruleBookInfo || {};
        const hasRule = Object.values(rule).some(value => String(value || '').trim());
        if (!hasRule || !book?.bookUrl) return { ...book };
        const pageData = await this.openPage(book.bookUrl, { source, book, signal });
        const context = pageData.context;
        const name = await this.field(rule.name, pageData.text, context) || book.name;
        const tocUrl = await this.field(rule.tocUrl, pageData.text, context, { isUrl: true }) || book.tocUrl || book.bookUrl;
        const merged = {
            ...book,
            name,
            author: await this.field(rule.author, pageData.text, context) || book.author,
            intro: await this.field(rule.intro, pageData.text, context) || book.intro,
            kind: await this.field(rule.kind, pageData.text, context) || book.kind,
            coverUrl: await this.field(rule.coverUrl, pageData.text, context, { isUrl: true }) || book.coverUrl,
            latestChapterTitle: await this.field(rule.lastChapter, pageData.text, context) || book.latestChapterTitle,
            wordCount: await this.field(rule.wordCount, pageData.text, context) || book.wordCount,
            tocUrl,
            infoHtml: pageData.text,
        };
        // 规则没给到的字段用 <meta property="og:novel:*"> 补上（书名尤其常见）
        const fallback = this.metaFallback(pageData.text, merged);
        return { ...fallback, tocUrl, infoHtml: pageData.text };
    }

    /**
     * 目录：支持 nextTocUrl 翻页，最多 5 页；分卷章节保留 isVolume 标记。
     */
    async toc(source, book, { signal = null, maxPages = 5 } = {}) {
        const rule = source?.ruleToc || {};
        if (!rule.chapterList) throw new Error('书源没有目录列表规则');
        const startUrl = book.tocUrl || book.bookUrl;
        if (!startUrl) throw new Error('没有目录地址');
        const chapters = [];
        const seen = new Set();
        let currentUrl = startUrl;
        let pages = 0;
        while (currentUrl && pages < Math.max(1, maxPages)) {
            const pageData = await this.openPage(currentUrl, { source, book, signal });
            const context = pageData.context;
            const items = await this.elements(rule.chapterList, pageData.text, context);
            for (const item of items) {
                const title = await this.field(rule.chapterName, item, context);
                if (!title) continue;
                const isVolume = /^(?:true|1|是)$/i.test((await this.field(rule.isVolume, item, context)).trim());
                const href = await this.field(rule.chapterUrl, item, context, { isUrl: true });
                // 卷标题通常没有链接，保留下来给目录用
                if (!href && !isVolume) continue;
                const key = href || `volume:${title}`;
                if (seen.has(key)) continue;
                seen.add(key);
                chapters.push({
                    title: title.slice(0, 160),
                    url: href || key,
                    isVolume,
                    isVip: /^(?:true|1|是)$/i.test((await this.field(rule.isVip, item, context)).trim()),
                    isPay: /^(?:true|1|是)$/i.test((await this.field(rule.isPay, item, context)).trim()),
                    tag: (await this.field(rule.updateTime, item, context)).slice(0, 60),
                });
            }
            const next = await this.field(rule.nextTocUrl, pageData.text, context, { isUrl: true });
            pages++;
            currentUrl = next && next !== currentUrl && !seen.has(next) ? next : '';
        }
        chapters.forEach((chapter, index) => {
            chapter.index = index;
        });
        return { chapters, tocUrl: startUrl, pages };
    }

    /**
     * 目录兜底：规则一条都没命中时，直接从页面上「成批出现」的链接里把章节捞出来。
     *
     * 做法：把所有 <a href> 的地址里的数字换成 #（`/book/123.html` → `/book/#.html`），
     * 数一数哪种模板出现得最多 —— 章节列表一定是「同一模板、几百条」，
     * 而导航、推荐位、分页条都只有零星几条。
     *
     * @returns {{chapters:object[], tocUrl:string, pages:number, guessed:true,
     *            pattern:string, linkCount:number, reason:string}}
     */
    async tocGuess(source, book, { signal = null, minCount = 20, url = '' } = {}) {
        const target = url || book?.tocUrl || book?.bookUrl;
        const empty = { chapters: [], tocUrl: '', pages: 0, guessed: true, pattern: '', linkCount: 0, reason: '没有可用的目录地址' };
        if (!target) return empty;
        const pageData = await this.openPage(target, { source, book, signal });
        const base = pageData.finalUrl || target;
        const doc = parseDocument(pageData.text || '', base);
        const anchors = selectAll(doc, 'a[href]');
        const NAV = /^(首页|目录|章节目录|全部章节|查看全部|上一页|下一页|上一章|下一章|返回|返回书架|书架|加入书架|推荐本书|投票|开始阅读|最新章节|更多)$/;
        const candidates = [];
        const pagePath = (() => {
            try { return new URL(base); } catch { return null; }
        })();
        for (const anchor of anchors) {
            const href = nodeAttr(doc, anchor, 'href').trim();
            if (!href || href.startsWith('#') || /^(javascript|mailto|tel):/i.test(href)) continue;
            let absolute = '';
            try { absolute = new URL(href, base).toString(); } catch { continue; }
            if (!/^https?:/i.test(absolute)) continue;
            if (pagePath && absolute.split('#')[0] === pagePath.toString().split('#')[0]) continue;
            const title = nodeText(doc, anchor).replace(/\s+/g, ' ').trim();
            if (!title || title.length > 80 || NAV.test(title)) continue;
            let parsed = null;
            try { parsed = new URL(absolute); } catch { continue; }
            // 只认同站的链接，别把友情链接、广告带进来
            if (pagePath && parsed.hostname !== pagePath.hostname) continue;
            const pattern = `${parsed.host}${parsed.pathname.replace(/\d+/g, '#')}${parsed.search.replace(/\d+/g, '#')}`;
            candidates.push({ title, url: absolute, pattern });
        }
        if (!candidates.length) {
            return { ...empty, tocUrl: target, linkCount: anchors.length };
        }
        const counts = new Map();
        for (const item of candidates) counts.set(item.pattern, (counts.get(item.pattern) || 0) + 1);
        let best = '';
        let bestCount = 0;
        for (const [pattern, count] of counts) {
            if (count > bestCount) { best = pattern; bestCount = count; }
        }
        if (bestCount < Math.max(2, Math.min(minCount, candidates.length))) {
            return {
                ...empty,
                tocUrl: target,
                linkCount: anchors.length,
                pattern: best,
                reason: `页面里有 ${anchors.length} 个链接，但最多只有 ${bestCount} 个是同一类章节地址`,
            };
        }
        const seen = new Set();
        const chapters = [];
        for (const item of candidates) {
            if (item.pattern !== best) continue;
            const key = item.url;
            if (seen.has(key)) continue;
            seen.add(key);
            chapters.push({ title: item.title.slice(0, 160), url: item.url, isVolume: false, isVip: false, isPay: false, tag: '', index: chapters.length });
        }
        return {
            chapters,
            tocUrl: target,
            pages: 1,
            guessed: true,
            pattern: best,
            linkCount: anchors.length,
            reason: '',
        };
    }

    /**
     * 正文：支持 nextContentUrl 翻页、replaceRegex 替换，HTML 统一转成多段文本。
     */
    async content(source, book, chapter, { signal = null, maxPages = 3, prefetched = null } = {}) {
        const rule = source?.ruleContent || {};
        if (!rule.content) throw new Error('书源没有正文规则');
        if (!chapter?.url) throw new Error('章节没有地址');
        const texts = [];
        const htmlParts = [];
        let firstPage = null;
        let currentUrl = chapter.url;
        let pages = 0;
        while (currentUrl && pages < Math.max(1, maxPages)) {
            const usePrefetched = prefetched && pages === 0 && String(prefetched.html || '').length > 0;
            const pageData = usePrefetched
                ? this.pageFromHtml(prefetched.html, prefetched.url || currentUrl, { source, book, chapter })
                : await this.openPage(currentUrl, { source, book, chapter, signal });
            if (!firstPage) firstPage = pageData;
            const context = pageData.context;
            const raw = await this.field(rule.content, pageData.text, context);
            if (raw) {
                if (/[<>]/.test(raw)) {
                    htmlParts.push(raw);
                    texts.push(htmlToText(raw));
                } else {
                    texts.push(raw);
                }
            }
            const next = rule.nextContentUrl
                ? await this.field(rule.nextContentUrl, pageData.text, context, { isUrl: true })
                : '';
            pages++;
            currentUrl = next && next !== currentUrl ? next : '';
        }

        let text = normalizeParagraphs(texts.join('\n\n'));
        if (rule.replaceRegex) {
            try {
                const context = firstPage?.context || createRuleContext({ source, book, chapter });
                text = normalizeParagraphs(replaceText(rule.replaceRegex, text, context));
            } catch (error) {
                this.warn(`正文替换失败：${error.message}`);
            }
        }
        text = rebuildParagraphs(text);
        // 有些站（番茄系 API、需要登录的源）会回一坨错误 JSON，别把错误当正文存进书架
        const apiError = describeApiError(text);
        if (apiError) throw new Error(apiError);
        // 有些站直接把「转码失败 / 请换源 / 请前往源网站」这种错误页当正文返回
        const contentError = describeContentError(text, { pageText: firstPage?.text || '' });
        if (contentError) throw new Error(contentError);
        const title = firstPage
            ? await this.field(rule.title, firstPage.text, firstPage.context) || chapter.title
            : chapter.title;
        const html = htmlParts.join('');
        return {
            title,
            text,
            html,
            images: extractImages(html, chapter.url || ''),
            charCount: text.length,
            pages,
            url: chapter.url,
        };
    }
}
