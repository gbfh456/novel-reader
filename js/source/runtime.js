/**
 * 书源 - 运行时
 *
 * 把「设置里的书源 + 网络客户端 + 规则流水线」组装成界面能直接用的服务：
 *   - 多源并发搜索（边搜边出）
 *   - 打开书籍：详情 → 目录
 *   - 抓正文
 *   - 书源校验（搜索 / 详情 / 目录 / 正文 四段）
 *   - 发现页地址解析
 */

import { NetClient } from '../net/client.js';
import { BookPipeline } from '../book/pipeline.js';
import { buildRequest, urlMatchesSource } from '../net/url.js';
import { normalizeSource } from './model.js';
import { mapLimit } from '../util.js';
import { applyReplaceRules } from '../replace.js';
import { JsSandbox } from '../rule/sandbox.js';
import { createRuleContext } from '../rule/execute.js';

function hostOf(value) {
    try {
        return new URL(value).hostname.replace(/^www\./, '');
    } catch {
        return '';
    }
}

export class SourceRuntime {
    constructor({ settings = null, getRequestHeaders = null, fetchImpl = null, client = null } = {}) {
        this.settings = settings || { sources: [], channel: 'auto', proxyTemplate: '', timeoutMs: 15000 };
        this.getRequestHeaders = getRequestHeaders;
        this.fetchImpl = fetchImpl;
        this.client = client || this.createClient();
        this.sandbox = (typeof Worker === 'function' && !client)
            ? new JsSandbox({ getRequestHeaders: this.getRequestHeaders })
            : null;
        this.pipeline = this.createPipeline();
        this.warnings = [];
    }

    createClient() {
        return new NetClient({
            bridgeBase: this.settings.bridgeBase || this.settings.fanqieBridge || '/api/plugins/fanqie-bridge',
            channel: this.settings.channel || 'auto',
            proxyTemplate: this.settings.proxyTemplate || '',
            timeoutMs: this.settings.timeoutMs || 15000,
            getRequestHeaders: this.getRequestHeaders,
            fetchImpl: this.fetchImpl,
            respectRateLimit: this.settings.respectRateLimit === true,
        });
    }

    createPipeline(extra = {}) {
        return new BookPipeline({
            client: this.client,
            jsRunner: this.sandbox ? request => this.sandbox.evaluate(request) : null,
            onWarning: message => this.warnings.push(message),
            fetchBase: this.settings.bridgeBase || this.settings.fanqieBridge || '/api/plugins/fanqie-bridge',
            ...extra,
        });
    }

    update(settings) {
        // 只传 online 子集时不要把 replaceRules 等顶层字段冲掉
        this.settings = settings ? { ...this.settings, ...settings } : this.settings;
        if (!this.client) {
            this.client = this.createClient();
        } else {
            // 桥接地址 / 通道 / 代理 / 超时可能被用户改过，客户端跟着更新
            this.client.bridgeBase = String(
                this.settings.bridgeBase || this.settings.fanqieBridge || '/api/plugins/fanqie-bridge',
            ).replace(/\/+$/, '');
            this.client.channel = this.settings.channel || 'auto';
            this.client.proxyTemplate = this.settings.proxyTemplate || '';
            this.client.timeoutMs = Math.min(120000, Math.max(3000, Number(this.settings.timeoutMs) || 15000));
            this.client.respectRateLimit = this.settings.respectRateLimit === true;
        }
        this.pipeline = this.createPipeline();
    }

    /** 全部书源（补全字段，容错旧格式） */
    sources() {
        const list = Array.isArray(this.settings?.sources) ? this.settings.sources : [];
        return list.map(source => (source?.bookSourceUrl ? source : normalizeSource(source))).filter(Boolean);
    }

    enabledSources() {
        return this.sources().filter(source => source.enabled !== false);
    }

    findSource(url) {
        const target = String(url || '').trim();
        if (!target) return null;
        const list = this.enabledSources();
        const exact = list.filter(source => urlMatchesSource(source, target));
        if (exact.length) {
            // 同域多个源时优先 bookUrlPattern 命中的
            return exact.find(source => {
                if (!source.bookUrlPattern) return false;
                try {
                    return new RegExp(source.bookUrlPattern).test(target);
                } catch {
                    return false;
                }
            }) || exact[0];
        }
        const host = hostOf(target);
        return list.find(source => hostOf(source.bookSourceUrl) === host) || null;
    }

    findSourceById(id) {
        return this.sources().find(source => source.bookSourceUrl === id || source.id === id) || null;
    }

    /**
     * 多源并发搜索。
     * @returns {Promise<{books:object[], perSource:object[], warnings:string[]}>}
     */
    async searchAll(keyword, { signal = null, concurrency = 3, onProgress = null, onSourceDone = null } = {}) {
        const sources = this.enabledSources();
        if (!sources.length) throw new Error('还没有启用的书源：先在「书源管理」里导入');
        const limit = Math.max(1, Math.min(8, Math.floor(Number(concurrency) || 3)));
        const perSource = sources.map(source => ({
            id: source.bookSourceUrl,
            name: source.bookSourceName,
            count: 0,
            error: '',
            done: false,
            ms: 0,
        }));
        const collected = [];
        let finished = 0;
        const startedAll = Date.now();
        await mapLimit(sources, limit, async (source, index) => {
            const entry = perSource[index];
            const started = Date.now();
            let items = [];
            if (signal?.aborted) {
                entry.error = '已停止';
                entry.done = true;
                return;
            }
            try {
                this.client.setRateLimit(source.bookSourceUrl, source.concurrentRate);
                const result = await this.pipeline.search(source, keyword, { signal });
                entry.count = result.books.length;
                entry.ms = Date.now() - started;
                items = result.books.map(book => ({
                    ...book,
                    sourceId: source.bookSourceUrl,
                    sourceName: source.bookSourceName,
                    sourceOrder: index,
                }));
                collected.push(...items);
            } catch (error) {
                entry.error = signal?.aborted ? '已停止' : (error?.message || '搜索失败');
            } finally {
                entry.done = true;
                finished++;
                onSourceDone?.({ source: entry, items });
                onProgress?.({
                    finished,
                    total: sources.length,
                    source: entry,
                    perSource,
                    count: collected.length,
                    ms: Date.now() - startedAll,
                });
            }
        });
        return { books: collected, perSource, warnings: this.warnings.slice(-5) };
    }

    /**
     * 书源调试：搜索 → 详情 → 目录 → 正文，返回每一步的结果与规则追踪。
     */
    async debug(source, { keyword = '', url = '', signal = null } = {}) {
        const traces = [];
        const steps = [];
        const pipeline = this.createPipeline({ onTrace: trace => traces.push(trace) });
        const record = async (name, run, summary) => {
            const started = Date.now();
            const before = traces.length;
            try {
                const detail = await run();
                steps.push({ name, ok: true, ms: Date.now() - started, summary: summary(detail), traces: traces.slice(before) });
                return detail;
            } catch (error) {
                steps.push({ name, ok: false, ms: Date.now() - started, error: error.message, traces: traces.slice(before) });
                return null;
            }
        };
        const target = String(url || '').trim();
        let info = null;
        let fallbackBook = null;
        if (target) {
            fallbackBook = { bookUrl: target, tocUrl: target, name: '', author: '' };
            info = await record('详情', () => pipeline.info(source, fallbackBook, { signal }), book => book.name || '（无书名）');
        } else {
            const searchKey = String(keyword || source?.ruleSearch?.checkKeyWord || '我的').trim() || '我的';
            const search = await record('搜索', () => pipeline.search(source, searchKey, { signal }), result => `${result.books.length} 条结果`);
            const first = search?.books?.[0] || null;
            if (first) {
                fallbackBook = first;
                info = await record('详情', () => pipeline.info(source, first, { signal }), book => book.name || '（无书名）');
            }
        }
        const book = info || fallbackBook;
        const toc = book
            ? await record('目录', () => pipeline.toc(source, book, { signal }), result => `${result.chapters.length} 章 / ${result.pages} 页`)
            : null;
        if (toc?.chapters?.length) {
            const chapter = toc.chapters.find(item => !item.isVolume) || toc.chapters[0];
            await record('正文', () => pipeline.content(source, book, chapter, { signal }), content => `${content.text.length} 字 / ${content.images?.length || 0} 图`);
        }
        return {
            ok: steps.every(step => step.ok),
            steps,
            warnings: this.warnings.slice(-10),
            jsSandbox: Boolean(this.sandbox),
        };
    }

    /** 执行书源的登录 JS（loginUrl），登录头 / Cookie 由 worker 写进桥接 */
    async loginSource(source, { signal = null } = {}) {
        if (!this.sandbox) throw new Error('JS 沙箱不可用：登录脚本需要浏览器 Worker + 服务端桥接');
        const raw = String(source?.loginUrl || '').trim();
        if (!raw) throw new Error('这个书源没有登录地址（loginUrl）');
        const context = createRuleContext({
            source,
            baseUrl: source.bookSourceUrl,
            key: '',
            page: 1,
        });
        context.content = '';
        // 交给 worker 的 source.login：会执行 loginUrl 并自动调用脚本里定义的 login()
        await this.sandbox.evaluate({ code: 'source.login()', result: null, ctx: context, source });
        return true;
    }

    /**
     * 详情 → 目录。已入库的书也用这个刷新。
     * @returns {Promise<{source:object, book:object, chapters:object[]}>}
     */
    async refreshBook(book, { signal = null, onProgress = null, withInfo = true } = {}) {
        const source = this.findSourceById(book.sourceId) || this.findSource(book.bookUrl);
        if (!source) throw new Error('找不到这本书对应的书源（可能被停用了）');
        this.client.setRateLimit(source.bookSourceUrl, source.concurrentRate);
        let current = {
            bookUrl: book.bookUrl || book.url || '',
            tocUrl: book.tocUrl || '',
            name: book.name || book.title || '',
            author: book.author || '',
            intro: book.intro || '',
            kind: book.kind || '',
            coverUrl: book.coverUrl || book.cover || '',
            latestChapterTitle: book.latestChapterTitle || '',
            wordCount: book.wordCount || '',
            origin: source.bookSourceUrl,
            originName: source.bookSourceName,
            type: source.bookSourceType || 0,
        };
        if (!current.bookUrl) throw new Error('这本书没有书源地址');
        if (withInfo) {
            onProgress?.(`正在用「${source.bookSourceName}」解析详情页…`);
            try {
                current = await this.pipeline.info(source, current, { signal });
            } catch (error) {
                if (signal?.aborted) throw error;
                this.warnings.push(`详情页解析失败，直接用目录页：${error.message}`);
            }
        }
        onProgress?.('正在解析目录…');
        let tocError = null;
        let tocResult = { chapters: [], tocUrl: '', pages: 0 };
        try {
            tocResult = await this.pipeline.toc(source, {
                ...current,
                tocUrl: current.tocUrl || current.bookUrl,
            }, { signal });
        } catch (error) {
            if (signal?.aborted) throw error;
            // 规则缺字段 / 执行报错也先记下：后面还能靠「猜目录」救回来
            tocError = error;
            this.warnings.push(`目录规则执行失败：${error.message}`);
        }
        // 详情页给的目录地址不对（常见：抓到的是最新章节页）时，回到书籍页再试一次
        if (!tocResult.chapters.length && !tocError && current.tocUrl && current.tocUrl !== current.bookUrl) {
            this.warnings.push(`目录页 ${current.tocUrl} 没解析到章节，改用书籍页再试`);
            try {
                tocResult = await this.pipeline.toc(source, { ...current, tocUrl: current.bookUrl }, { signal });
            } catch (error) {
                if (signal?.aborted) throw error;
                tocError = tocError || error;
            }
        }
        // 规则还是没命中：用「成批出现的链接」猜目录（规则写错 / 换站也能打开）
        let tocGuessed = false;
        if (!tocResult.chapters.length && typeof this.pipeline.tocGuess === 'function') {
            onProgress?.('规则没解析到章节，正在按页面结构推断目录…');
            const guess = await this.pipeline.tocGuess(source, { ...current, tocUrl: current.tocUrl || current.bookUrl }, { signal });
            if (guess.chapters.length) {
                tocGuessed = true;
                tocResult = guess;
                this.warnings.push(`目录规则没命中，已按页面结构推断出 ${guess.chapters.length} 章（模板 ${guess.pattern}），建议检查这个书源的「目录列表」规则`);
                if (guess.reordered) this.warnings.push(`推断出的目录顺序不对（${guess.reason || '页面倒序 / 页首「最新章节」重复'}），已按章节序号重排`);
            } else {
                const why = tocError ? `规则报错：${tocError.message}` : (guess.reason || '页面里没有成批的章节链接');
                throw new Error(`没解析到章节：书源规则可能不匹配这个站点（${why}）`);
            }
        }
        if (!tocResult.chapters.length) throw new Error('没解析到章节：书源规则可能不匹配这个站点');
        const rules = this.settings.replaceRules || [];
        const chapters = tocResult.chapters.map(chapter => ({
            // 卷标题保留下来给目录显示，正文抓取时会跳过
            title: applyReplaceRules(chapter.title, rules, 'title'),
            url: chapter.url || (chapter.isVolume ? `volume:${chapter.title}` : ''),
            isVolume: Boolean(chapter.isVolume),
            isVip: Boolean(chapter.isVip),
            isPay: Boolean(chapter.isPay),
            tag: chapter.tag || '',
        }));
        return {
            source,
            book: {
                ...current,
                name: applyReplaceRules(current.name, rules, 'title'),
                tocGuessed: Boolean(tocGuessed),
                tocReordered: Boolean(tocResult.reordered),
            },
            chapters,
        };
    }

    /** 打开一本书（详情 + 目录），返回界面用的书籍对象 */
    async openBook(url, { signal = null, onProgress = null } = {}) {
        const source = this.findSource(url);
        if (!source) throw new Error('这个地址不属于任何已启用的书源');
        const result = await this.refreshBook({ bookUrl: url, sourceId: source.bookSourceUrl }, { signal, onProgress });
        return {
            url: result.book.bookUrl,
            title: result.book.name || '未命名小说',
            author: result.book.author || '',
            intro: result.book.intro || '',
            cover: result.book.coverUrl || '',
            kind: result.book.kind || '',
            latestChapterTitle: result.book.latestChapterTitle || '',
            wordCount: result.book.wordCount || '',
            sourceId: source.bookSourceUrl,
            sourceName: source.bookSourceName,
            tocUrl: result.book.tocUrl || result.book.bookUrl,
            tocGuessed: Boolean(result.book.tocGuessed),
            tocReordered: Boolean(result.book.tocReordered),
            chapters: result.chapters.map(chapter => ({
                title: chapter.title,
                url: chapter.url,
                isVolume: Boolean(chapter.isVolume),
                isVip: Boolean(chapter.isVip),
                isPay: Boolean(chapter.isPay),
            })),
        };
    }

    /**
     * 只搜一个书源：换源弹窗里「指定源现场再搜一次」用。
     * @param {object|string} sourceOrId 书源对象，或 bookSourceUrl
     * @returns {Promise<object[]>} 这个源搜到的书（带 sourceId / sourceName）
     */
    async searchInSource(sourceOrId, keyword, { signal = null } = {}) {
        const source = typeof sourceOrId === 'string'
            ? (this.findSourceById(sourceOrId) || this.findSource(sourceOrId))
            : sourceOrId;
        if (!source) throw new Error('找不到这个书源（可能已被删除或停用）');
        const key = String(keyword || '').trim();
        if (!key) return [];
        const result = await this.pipeline.search(source, key, { signal });
        return (result.books || []).map(book => ({
            ...book,
            sourceId: source.bookSourceUrl,
            sourceName: source.bookSourceName,
        }));
    }

    /**
     * 换源用：按书名在各书源里搜，返回候选（排除当前源）。
     *
     * 和主搜索一样支持边搜边交：`onSourceDone` 每回来一个源就把它的候选交出去，
     * 换源弹窗才不用干等着 100 多个源全部跑完 —— 否则慢的时候看着就是「点了没内容」。
     * 同时把每个源的成败原样带回去，弹窗才能在「一个候选都没有」时说清是没搜到还是搜挂了。
     * @returns {Promise<{items: object[], perSource: object[], keyword: string}>} 候选 + 每源成败
     */
    async searchAlternatives(novel, { signal = null, keyword: customKeyword = '', onSourceDone = null, onProgress = null } = {}) {
        const keyword = String(customKeyword || novel?.title || '').trim();
        if (!keyword) return { items: [], perSource: [], keyword };
        const wanted = normalizeBookName(keyword);
        const pick = books => books
            .filter(book => book.sourceId !== novel.sourceId)
            .map(book => ({ ...book, nameScore: scoreBookName(book.name, wanted, book.author, novel.author) }))
            .filter(book => book.nameScore > 0);
        const result = await this.searchAll(keyword, {
            signal,
            concurrency: 3,
            onProgress,
            onSourceDone: info => {
                const items = pick(info.items || []);
                if (items.length) onSourceDone?.({ ...info, items });
            },
        });
        const items = pick(result.books)
            .sort((a, b) => b.nameScore - a.nameScore)
            .slice(0, 30);
        return { items, perSource: result.perSource || [], keyword };
    }

    /** 桥接存活检查（不依赖番茄下载器） */
    async bridgePing() {
        const base = String(this.settings.bridgeBase || this.settings.fanqieBridge || '/api/plugins/fanqie-bridge').replace(/\/+$/, '');
        try {
            const response = await (this.fetchImpl || globalThis.fetch)(`${base}/ping`, {
                headers: typeof this.getRequestHeaders === 'function' ? (this.getRequestHeaders() || {}) : {},
            });
            if (!response.ok) return { ok: false, status: response.status, base };
            const data = await response.json().catch(() => ({}));
            return { ok: Boolean(data?.ok), version: data?.version || '', base };
        } catch (error) {
            return { ok: false, error: error.message, base };
        }
    }

    /** 抓一章正文 */
    /**
     * 批量预取章节 HTML（走桥接 /fetch-batch），返回与输入同序的 [{html,url,error}]。
     * 站点不支持批量或桥接太旧时返回 null，调用方逐章抓。
     */
    async prefetchChapters(chapters, { signal = null, sourceId = '', concurrency = 6 } = {}) {
        const list = Array.isArray(chapters) ? chapters : [];
        if (!list.length) return null;
        const source = this.findSourceById(sourceId) || this.findSource(list[0]?.url);
        if (!source) return null;
        // 有 nextContentUrl 的源一页拿不全，交给逐章逻辑处理
        if (String(source?.ruleContent?.nextContentUrl || '').trim()) return null;
        const headers = this.pipeline.headersOf(source);
        const requests = [];
        const indexes = [];
        list.forEach((chapter, index) => {
            if (!chapter?.url || String(chapter.url).startsWith('volume:')) return;
            let request;
            try {
                request = buildRequest(chapter.url, { source, book: { bookUrl: chapter.url } });
            } catch {
                return;
            }
            if (request.method && request.method !== 'GET') return;
            if (Object.keys(request.headers || {}).length || Object.keys(headers).length) {
                request.headers = { ...headers, ...request.headers };
            }
            requests.push(request);
            indexes.push(index);
        });
        if (!requests.length) return null;
        const results = await this.client.requestBatch(requests, { signal, concurrency });
        if (!results) return null;
        const output = new Array(list.length).fill(null);
        results.forEach((result, position) => {
            const index = indexes[position];
            if (!result?.ok) {
                output[index] = { error: result?.error || '抓取失败', url: requests[position]?.url || '' };
                return;
            }
            output[index] = { html: result.text, url: result.finalUrl || requests[position]?.url || '' };
        });
        return output;
    }

    async fetchChapter(chapter, { signal = null, sourceId = '', timeoutMs = 0, prefetched = null } = {}) {
        const source = this.findSourceById(sourceId) || this.findSource(chapter?.url);
        if (!source) throw new Error('找不到这一章对应的书源（可能被停用了）');
        this.client.setRateLimit(source.bookSourceUrl, source.concurrentRate);
        // 单章看门狗：站点不回包时不要拖住整本下载
        const guard = Number(timeoutMs) > 0 ? Number(timeoutMs) : 0;
        const controller = new AbortController();
        const outer = signal || null;
        let timer = null;
        if (guard) {
            timer = setTimeout(() => controller.abort(new Error(`抓取超时（${Math.round(guard / 1000)} 秒）`)), guard);
        }
        const onOuterAbort = () => controller.abort(outer.reason);
        if (outer) {
            if (outer.aborted) onOuterAbort();
            else outer.addEventListener('abort', onOuterAbort, { once: true });
        }
        try {
            return await this.fetchChapterInner(source, chapter, controller.signal, prefetched);
        } finally {
            if (timer) clearTimeout(timer);
            outer?.removeEventListener?.('abort', onOuterAbort);
        }
    }

    async fetchChapterInner(source, chapter, signal, prefetched = null) {
        const book = { bookUrl: chapter?.bookUrl || chapter?.url || '', name: chapter?.bookName || '' };
        const result = await this.pipeline.content(source, book, {
            title: chapter?.title || '',
            url: chapter?.url || '',
        }, { signal, prefetched });
        const rules = this.settings.replaceRules || [];
        const text = applyReplaceRules(result.text, rules, 'content');
        return {
            title: applyReplaceRules(result.title || chapter?.title || '', rules, 'title'),
            text,
            charCount: text.length,
            html: result.html,
            images: Array.isArray(result.images) ? result.images : [],
        };
    }

    /**
     * 书源校验：搜索 → 详情 → 目录 → 正文。
     * @returns {Promise<{ok:boolean, steps:object[], book:object|null}>}
     */
    async validate(source, { keyword = '', signal = null, maxChapters = 3 } = {}) {
        const steps = [];
        const step = async (name, run) => {
            const started = Date.now();
            try {
                const detail = await run();
                steps.push({ name, ok: true, ms: Date.now() - started, detail });
                return detail;
            } catch (error) {
                steps.push({ name, ok: false, ms: Date.now() - started, error: error?.message || '失败' });
                return null;
            }
        };
        const searchKey = String(keyword || source?.ruleSearch?.checkKeyWord || '我的').trim() || '我的';
        const search = await step('搜索', async () => {
            const result = await this.pipeline.search(source, searchKey, { signal });
            if (!result.books.length) throw new Error(`搜「${searchKey}」没有结果`);
            return result.books;
        });
        const first = search?.[0] || null;
        const info = first ? await step('详情', async () => {
            const book = await this.pipeline.info(source, first, { signal });
            if (!book.name) throw new Error('详情页没有解析到书名');
            return book;
        }) : null;
        const toc = info ? await step('目录', async () => {
            const result = await this.pipeline.toc(source, info, { signal });
            if (!result.chapters.length) throw new Error('目录为空');
            return result.chapters;
        }) : null;
        if (toc?.length) {
            const targets = toc.filter(chapter => !chapter.isVolume).slice(0, Math.max(1, maxChapters));
            await step('正文', async () => {
                const chapter = targets[0];
                const content = await this.pipeline.content(source, info, chapter, { signal });
                if (!content.text || content.text.length < 10) throw new Error('正文为空或过短');
                return { title: content.title, length: content.text.length };
            });
        }
        return { ok: steps.every(item => item.ok), steps, book: info };
    }

    /**
     * 发现页分类：exploreUrl 支持 @js（走 Worker 沙箱）与普通 JSON / 行文本。
     * @returns {Promise<{title:string,url:string}[]>}
     */
    async exploreEntries(source) {
        const raw = String(source?.exploreUrl || '').trim();
        if (!raw) return [];
        if (raw.startsWith('@js:') || raw.startsWith('<js>')) {
            if (!this.sandbox) throw new Error('这个发现地址用了 JS 规则：需要浏览器 Worker（且联网时还需要桥接）');
            const code = raw.startsWith('@js:') ? raw.slice(4) : raw.replace(/^<js>/, '').replace(/<\/js>$/, '');
            const context = createRuleContext({ source, baseUrl: source.bookSourceUrl, key: '', page: 1 });
            context.content = '';
            const value = await this.sandbox.evaluate({ code, result: null, ctx: context, source });
            const list = typeof value === 'string' ? parseExploreText(value) : value;
            return normalizeExploreEntries(list);
        }
        return this.parseExplore(source);
    }

    /** 发现页：解析 exploreUrl（JSON 数组 / 标题::地址 行 / 单地址） */
    parseExplore(source) {
        const raw = String(source?.exploreUrl || '').trim();
        if (!raw) return [];
        return parseExploreText(raw);
    }

    async explore(source, entry, { page = 1, signal = null } = {}) {
        const target = typeof entry === 'string' ? entry : entry?.url;
        if (!target) throw new Error('发现地址为空');
        this.client.setRateLimit(source.bookSourceUrl, source.concurrentRate);
        const result = await this.pipeline.explore(source, target, { page, signal });
        return result.books.map(book => ({
            ...book,
            sourceId: source.bookSourceUrl,
            sourceName: source.bookSourceName,
        }));
    }
}

/** 书名归一化：去掉标点空白，方便跨书源对齐 */
export function normalizeBookName(value) {
    return String(value || '')
        .replace(/[\s《》<>【】()（）\[\]·.,，。!！?？:：;；'"“”‘’—\-_/\\|]/g, '')
        .toLowerCase();
}

export function scoreBookName(name, wanted, author, wantedAuthor) {
    const normalized = normalizeBookName(name);
    if (!normalized || !wanted) return 0;
    let score = 0;
    if (normalized === wanted) score += 100;
    else if (normalized.includes(wanted) || wanted.includes(normalized)) score += 60;
    else return 0;
    const authorA = normalizeBookName(author);
    const authorB = normalizeBookName(wantedAuthor);
    if (authorA && authorB && (authorA.includes(authorB) || authorB.includes(authorA))) score += 30;
    return score;
}

/**
 * 换源后把阅读进度对齐到新目录：优先按章节标题精确匹配，其次按百分比。
 * @returns {{index:number, matched:boolean}}
 */
export function alignChapterIndex(oldChapters, newChapters, currentIndex) {
    const oldList = Array.isArray(oldChapters) ? oldChapters : [];
    const newList = Array.isArray(newChapters) ? newChapters : [];
    if (!newList.length) return { index: 0, matched: false };
    const position = Math.max(0, Math.min(oldList.length - 1, Number(currentIndex) || 0));
    const wanted = normalizeBookName(oldList[position]?.title || '');
    if (wanted) {
        const exact = newList.findIndex(chapter => normalizeBookName(chapter.title) === wanted);
        if (exact >= 0) return { index: exact, matched: true };
        const loose = newList.findIndex(chapter => {
            const title = normalizeBookName(chapter.title);
            return title && (title.includes(wanted) || wanted.includes(title));
        });
        if (loose >= 0) return { index: loose, matched: true };
    }
    const ratio = oldList.length > 1 ? position / (oldList.length - 1) : 0;
    return { index: Math.min(newList.length - 1, Math.round(ratio * (newList.length - 1))), matched: false };
}

/** 把发现地址的文本形式解析成分类：JSON 数组 / 「标题::地址」行 / 单个地址 */
export function parseExploreText(value) {
    const text = String(value ?? '').trim();
    if (!text) return [];
    if (text.startsWith('[')) {
        try {
            return normalizeExploreEntries(JSON.parse(text));
        } catch {
            // 落到行解析
        }
    }
    const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
    if (lines.length === 1 && !lines[0].includes('::')) {
        return [{ title: '发现', url: lines[0] }];
    }
    return normalizeExploreEntries(lines.map(line => {
        const index = line.indexOf('::');
        if (index < 0) return null;
        return { title: line.slice(0, index).trim(), url: line.slice(index + 2).trim() };
    }).filter(Boolean));
}

/** 补全标题 / 地址，过滤空项（也接受 {name,url} 这类写法） */
export function normalizeExploreEntries(list) {
    return (Array.isArray(list) ? list : [])
        .map(item => {
            if (!item) return null;
            if (typeof item === 'string') {
                const index = item.indexOf('::');
                if (index < 0) return { title: '发现', url: item.trim() };
                return { title: item.slice(0, index).trim(), url: item.slice(index + 2).trim() };
            }
            return {
                title: String(item.title || item.name || '').trim(),
                url: String(item.url || item.link || '').trim(),
            };
        })
        .filter(item => item && item.title && item.url);
}
