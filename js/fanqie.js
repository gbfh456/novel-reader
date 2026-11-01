/**
 * 小说阅读器 - 番茄小说来源
 *
 * 番茄的搜索 / 详情 / 正文都在本地「番茄小说下载器」（Tomato Novel Downloader）里：
 *   - 搜索：GET /api/search?q=关键词
 *   - 详情：GET /api/preview/:book_id
 *   - 正文：只有整本下载产物（txt），没有单章接口
 * 浏览器直连下载器会被跨域拦下（下载器不带 CORS 头，OPTIONS 预检 405），
 * 所以默认走酒馆同源的桥接路由 `/api/plugins/fanqie-bridge`（服务端插件 plugins/fanqie-bridge）。
 *
 * 这个模块只做纯数据转换和请求封装，不碰界面，方便在 Node 下测试。
 */

export const FANQIE_SITE = '番茄小说';
export const FANQIE_URL_PREFIX = 'fanqie://';
export const DEFAULT_FANQIE_BRIDGE = '/api/plugins/fanqie-bridge';

/** 番茄章节标题：第 12 章 / 第两百回 / 番外 …（下载器导出的 txt 里就是这种行） */
const FANQIE_CHAPTER_RE = /^第\s*[0-9０-９零〇一二三四五六七八九十百千万两]{1,12}\s*[章节回卷集话篇](?:[\s\u3000]|$|[、.．:：,，])/;
/** 下载器 txt 头部的元信息行：书名：xxx / book_id=xxx */
const FANQIE_HEAD_RE = /^(书名|作者|book_id|状态|评分|字数|章节|分类|标签|在读)\s*[：=]\s*(.*)$/i;

/** 桥接地址：留空用默认；补上开头的 /，去掉尾部斜杠 */
export function normalizeFanqieBridge(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return DEFAULT_FANQIE_BRIDGE;
    const trimmed = raw.replace(/\/+$/, '');
    if (/^[a-z]+:\/\//i.test(trimmed)) return trimmed;
    return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

/** 书目地址：fanqie://<book_id> */
export function fanqieBookUrl(bookId) {
    const id = String(bookId ?? '').trim();
    return id ? `${FANQIE_URL_PREFIX}${id}` : '';
}

/** 从用户粘的链接里认出番茄书目：fanqie://123 / fanqienovel.com/page/123 / 分享页 ?bookId=123 */
export function fanqieBookIdFromUrl(url) {
    const raw = String(url ?? '').trim();
    if (!raw) return '';
    if (raw.toLowerCase().startsWith(FANQIE_URL_PREFIX)) {
        return raw.slice(FANQIE_URL_PREFIX.length).split(/[/?#]/)[0].trim();
    }
    let parsed = null;
    try {
        parsed = new URL(raw);
    } catch {
        return '';
    }
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    if (!/(?:^|\.)(fanqienovel\.com|changdunovel\.com|fqnovel\.com)$/.test(host)) return '';
    const byQuery = parsed.searchParams.get('bookId') || parsed.searchParams.get('book_id');
    if (byQuery && /^\d{6,}$/.test(byQuery)) return byQuery.trim();
    const segments = parsed.pathname.split('/').filter(Boolean);
    for (let index = segments.length - 1; index >= 0; index--) {
        if (/^\d{6,}$/.test(segments[index])) return segments[index];
    }
    return '';
}

/** 这个地址是不是番茄书 */
export function isFanqieUrl(url) {
    return Boolean(fanqieBookIdFromUrl(url));
}

/** 这本书是不是番茄下载器里的书 */
export function isFanqieBook(book) {
    if (!book) return false;
    return book.source === 'fanqie' || isFanqieUrl(book.url);
}

/** 数字转「12.3 万」这种写法 */
export function formatFanqieNumber(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return '';
    if (number >= 100000000) return `${(number / 100000000).toFixed(1)} 亿`;
    if (number >= 10000) return `${(number / 10000).toFixed(1)} 万`;
    return String(Math.round(number));
}

function joinMeta(parts) {
    return parts.filter(Boolean).join(' · ');
}

/** /api/search 的返回 → 找书页的结果列表 */
export function mapFanqieSearchItems(payload) {
    const items = Array.isArray(payload?.items) ? payload.items : [];
    const results = [];
    const seen = new Set();
    for (const item of items) {
        const raw = item?.raw && typeof item.raw === 'object' ? item.raw : {};
        const bookId = String(item?.book_id ?? raw.book_id ?? '').trim();
        const title = String(item?.title ?? raw.book_name ?? '').trim();
        if (!bookId || !title || seen.has(bookId)) continue;
        seen.add(bookId);
        const author = String(item?.author ?? raw.author ?? '').trim();
        const words = formatFanqieNumber(raw.word_number);
        const readText = String(raw.read_cnt_text || raw.read_count_text || '').trim();
        const score = Number(raw.score);
        const snippet = joinMeta([
            author ? `作者：${author}` : '',
            String(raw.category || '').trim(),
            words ? `${words}字` : '',
            readText,
            Number.isFinite(score) && score > 0 ? `${score.toFixed(1)} 分` : '',
        ]);
        results.push({
            title: title.slice(0, 120),
            url: fanqieBookUrl(bookId),
            site: FANQIE_SITE,
            snippet: snippet.slice(0, 160),
            bookId,
            author,
        });
    }
    return results;
}

/** /api/preview/:book_id 的返回 → 找书页的书目对象（chapters 留空：番茄只能整本下载） */
export function mapFanqiePreview(preview, { bookId = '' } = {}) {
    const data = preview && typeof preview === 'object' ? preview : {};
    const id = String(data.book_id || bookId || '').trim();
    const tags = Array.isArray(data.tags) ? data.tags.map(tag => String(tag).trim()).filter(Boolean) : [];
    const wordCount = Number(data.word_count) || 0;
    const chapterCount = Number(data.chapter_count) || 0;
    const finished = data.finished === true;
    const score = Number(data.score);
    const readText = String(data.read_count_text || data.read_count || '').trim();
    return {
        source: 'fanqie',
        bookId: id,
        url: fanqieBookUrl(id),
        title: String(data.book_name || data.original_book_name || '').trim() || FANQIE_SITE,
        author: String(data.author || '').trim(),
        intro: String(data.description || '').trim().slice(0, 600),
        cover: '',
        chapters: [],
        chapterCount,
        downloadOnly: true,
        meta: {
            tags,
            finished,
            wordCount,
            score: Number.isFinite(score) ? score : 0,
            readText,
            category: String(data.category || '').trim(),
            firstChapterTitle: String(data.first_chapter_title || '').trim(),
            lastChapterTitle: String(data.last_chapter_title || '').trim(),
            originalBookName: String(data.original_book_name || '').trim(),
        },
    };
}

/** 书目摘要行：作者 · 玄幻脑洞 · 620 章 · 159.8 万字 · 9.0 分 · 1.2万人在读 · 连载中 */
export function fanqieBookSummary(book) {
    const meta = book?.meta || {};
    return joinMeta([
        book?.author ? `作者：${book.author}` : '',
        meta.category,
        book?.chapterCount ? `${book.chapterCount} 章` : '',
        meta.wordCount ? `${formatFanqieNumber(meta.wordCount)}字` : '',
        meta.score ? `${meta.score.toFixed(1)} 分` : '',
        meta.readText,
        meta.finished ? '已完结' : '连载中',
    ]);
}

/** 下载任务可读进度：{ percent, done, total, finished, failed, label } */
export function summarizeFanqieJob(job) {
    const data = job && typeof job === 'object' ? job : {};
    const progress = data.progress && typeof data.progress === 'object' ? data.progress : {};
    const total = Number(progress.chapter_total) || 0;
    const done = Number(progress.saved_chapters) || 0;
    const state = String(data.state || '').toLowerCase();
    const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    const finished = state === 'done' || state === 'finished' || state === 'completed';
    const failed = state === 'failed' || state === 'cancelled' || state === 'canceled';
    let label = '排队中…';
    if (finished) label = `下载完成：${done || total} 章`;
    else if (failed) {
        label = state === 'cancelled' || state === 'canceled'
            ? '任务已取消'
            : `任务失败${data.message ? `：${data.message}` : ''}`;
    } else if (state === 'running') label = total > 0 ? `正在下载 ${done} / ${total} 章` : '正在准备目录…';
    return { state, done, total, percent, finished, failed, label, message: data.message || '' };
}

/**
 * 把下载器导出的整本 txt 切成章节。
 * 头部是「书名：/作者：/book_id=/…/简介：」，章节行是「第N章 标题」。
 */
export function parseFanqieBookText(text) {
    const source = String(text ?? '').replace(/\r\n?/g, '\n');
    if (!source.trim()) throw new Error('下载器返回的是空文件');
    const lines = source.split('\n');
    const header = {};
    let cursor = 0;
    for (; cursor < lines.length; cursor++) {
        const line = lines[cursor].trim();
        if (!line) {
            if (Object.keys(header).length) {
                cursor++;
                break;
            }
            continue;
        }
        const match = line.match(FANQIE_HEAD_RE);
        if (!match) break;
        header[match[1].toLowerCase()] = match[2].trim();
    }

    let introStart = -1;
    for (let index = cursor; index < lines.length; index++) {
        const line = lines[index].trim();
        if (FANQIE_CHAPTER_RE.test(line)) break;
        if (/^简\s*介\s*[：:]/.test(line)) {
            introStart = index;
            break;
        }
    }
    let chapterStart = -1;
    for (let index = Math.max(cursor, introStart); index < lines.length; index++) {
        if (FANQIE_CHAPTER_RE.test(lines[index].trim())) {
            chapterStart = index;
            break;
        }
    }
    let intro = '';
    if (introStart >= 0) {
        const end = chapterStart > introStart ? chapterStart : lines.length;
        intro = lines
            .slice(introStart, end)
            .map(line => line.trim())
            .filter(Boolean)
            .map((line, index) => (index === 0 ? line.replace(/^简\s*介\s*[：:]\s*/, '') : line))
            .filter(Boolean)
            .join('\n')
            .trim()
            .slice(0, 600);
    }

    const chapters = [];
    if (chapterStart >= 0) {
        let current = null;
        const buffer = [];
        const flush = () => {
            if (!current) return;
            const content = buffer.join('\n').replace(/\n{3,}/g, '\n\n').trim();
            if (content) chapters.push({ title: current.slice(0, 100), content });
            buffer.length = 0;
        };
        for (let index = chapterStart; index < lines.length; index++) {
            const line = lines[index];
            const trimmed = line.trim();
            if (FANQIE_CHAPTER_RE.test(trimmed)) {
                flush();
                current = trimmed;
                continue;
            }
            buffer.push(line);
        }
        flush();
    }

    if (!chapters.length) {
        const rest = lines.slice(Math.max(0, cursor)).join('\n').trim();
        if (!rest) throw new Error('下载器返回的内容里没有正文');
        chapters.push({ title: header['书名'] || '正文', content: rest });
    }

    return {
        bookId: String(header.book_id || '').trim(),
        title: String(header['书名'] || '').trim(),
        author: String(header['作者'] || '').trim(),
        intro,
        chapters,
    };
}

function describeBridgeError(error, base) {
    const reason = error?.message || String(error || '');
    if (/Failed to fetch|fetch failed|NetworkError|Load failed|CORS/i.test(reason)) {
        return new Error(`连不上番茄桥接（${base}）：番茄小说是可选的 —— 想用就确认番茄下载器在跑、酒馆装了 plugins/fanqie-bridge 并重启过；不想装就把搜索通道换成「书源」，照样能找书`);
    }
    return new Error(`番茄桥接请求失败：${reason || '未知错误'}`);
}

function extractBridgeMessage(body) {
    const text = String(body || '').trim();
    if (!text) return '';
    try {
        const data = JSON.parse(text);
        const message = data?.error || data?.message;
        if (typeof message === 'string' && message) return message;
    } catch {
        // 不是 JSON：多半是反代 / 酒馆的 HTML 错误页
    }
    if (/^\s*<(!doctype|html)/i.test(text)) return '';
    return text.slice(0, 200);
}

/** 番茄桥接客户端：所有请求都发往同源桥接，绝不把下载器地址交给浏览器 */
export class FanqieClient {
    constructor({ base, upstream = '', fetchImpl, getRequestHeaders } = {}) {
        this.base = normalizeFanqieBridge(base);
        this.upstream = String(upstream || '').trim();
        this.fetchImpl = fetchImpl || globalThis.fetch?.bind(globalThis);
        this.getRequestHeaders = getRequestHeaders || null;
    }

    update({ base, upstream } = {}) {
        if (base !== undefined) this.base = normalizeFanqieBridge(base);
        if (upstream !== undefined) this.upstream = String(upstream || '').trim();
        return this;
    }

    async _request(path, { method = 'GET', body, signal, expectText = false } = {}) {
        if (typeof this.fetchImpl !== 'function') throw new Error('当前环境没有可用的 fetch');
        const headers = { Accept: expectText ? 'text/plain,*/*' : 'application/json' };
        if (this.upstream) headers['X-Fanqie-Upstream'] = this.upstream;
        if (typeof this.getRequestHeaders === 'function') {
            Object.assign(headers, this.getRequestHeaders() || {});
        }
        const init = { method, headers, signal, credentials: 'same-origin', redirect: 'follow' };
        if (body !== undefined) {
            headers['Content-Type'] = 'application/json';
            init.body = JSON.stringify(body);
        }
        let response;
        try {
            response = await this.fetchImpl(`${this.base}${path}`, init);
        } catch (error) {
            if (error?.name === 'AbortError') throw error;
            throw describeBridgeError(error, this.base);
        }
        if (!response.ok) {
            let raw = '';
            try {
                raw = await response.text();
            } catch {
                raw = '';
            }
            const message = extractBridgeMessage(raw);
            let detail = null;
            try {
                detail = JSON.parse(raw);
            } catch {
                detail = null;
            }
            const missing = response.status === 404 && !message;
            const error = new Error(missing
                ? '番茄桥接没装（番茄小说是可选的）：要番茄通道就把「找书」页桥接块里那条 node 命令在酒馆根目录执行一次，再重启酒馆；不想装就换个搜索通道——「书源」照样能搜到书'
                : (message || `番茄桥接返回 ${response.status}`));
            error.status = response.status;
            error.missingBridge = missing;
            // 桥接自己的错误里带 paths / commands（503 下载器没跑时也能拿来显示）
            error.detail = detail;
            throw error;
        }
        if (expectText) return await response.text();
        try {
            return await response.json();
        } catch {
            throw new Error('番茄桥接返回的不是合法 JSON（检查桥接地址是否指到了酒馆的其它页面）');
        }
    }

    /** 桥接与下载器是否都活着 */
    async health({ signal } = {}) {
        return await this._request('/health', { signal });
    }

    /**
     * 确保下载器可用：桥接会自动把下载器拉起来（需要时），这里等它就绪。
     * 只用启动酒馆时，这一步就是「自动启下载器」的入口。
     */
    async ensureReady({ signal, timeoutMs = 12000 } = {}) {
        const wait = Math.max(1000, Math.min(30000, Math.floor(Number(timeoutMs) || 12000)));
        const payload = await this._request(`/health?ensure=1&timeout=${wait}`, { signal });
        if (!payload?.downloader?.reachable) {
            throw new Error('番茄下载器没起来：检查 plugins/fanqie-bridge 的自动启动配置（或手动跑一次下载器）');
        }
        return payload;
    }

    /** 搜索：返回找书页用的结果列表 */
    async search(keyword, { signal } = {}) {
        const query = String(keyword || '').trim();
        if (!query) throw new Error('请输入书名或作者');
        await this.ensureReady({ signal });
        const payload = await this._request(`/search?q=${encodeURIComponent(query)}`, { signal });
        const results = mapFanqieSearchItems(payload);
        if (!results.length) throw new Error('番茄这边没搜到：换个关键词，或书名写全一点');
        return results;
    }

    /** 书目详情 */
    async preview(bookId, { signal } = {}) {
        const id = String(bookId || '').trim();
        if (!id) throw new Error('缺少番茄 book_id');
        await this.ensureReady({ signal });
        const payload = await this._request(`/preview/${encodeURIComponent(id)}`, { signal });
        return mapFanqiePreview(payload, { bookId: id });
    }

    /** 建下载任务：{ bookId, rangeEnd }（只给结束章节时从第 1 章开始） */
    async createJob({ bookId, rangeStart = null, rangeEnd = null } = {}, { signal } = {}) {
        const id = String(bookId || '').trim();
        if (!id) throw new Error('缺少番茄 book_id');
        await this.ensureReady({ signal });
        const payload = { book_id: id };
        const end = Math.floor(Number(rangeEnd) || 0);
        if (end > 0) {
            payload.range_start = Math.max(1, Math.floor(Number(rangeStart) || 1));
            payload.range_end = end;
        }
        const job = await this._request('/jobs', { method: 'POST', body: payload, signal });
        if (!job || job.id === undefined) throw new Error('下载器没返回任务号');
        return job;
    }

    /** 查任务；不传 id 时返回最近的任务列表 */
    async job(id, { signal } = {}) {
        const suffix = id === undefined || id === null || id === '' ? '' : `?id=${encodeURIComponent(id)}`;
        return await this._request(`/jobs${suffix}`, { signal });
    }

    /** 取消任务（用户点「停止」时用；失败不影响主流程） */
    async cancelJob(id, { signal } = {}) {
        return await this._request(`/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST', signal });
    }

    /** 取整本 txt（下载完成后由桥接在下载目录里按 book_id 找） */
    async bookText({ bookId, title = '' } = {}, { signal } = {}) {
        const id = String(bookId || '').trim();
        if (!id) throw new Error('缺少番茄 book_id');
        const query = `?book_id=${encodeURIComponent(id)}${title ? `&title=${encodeURIComponent(title)}` : ''}`;
        return await this._request(`/book-text${query}`, { signal, expectText: true });
    }
}
