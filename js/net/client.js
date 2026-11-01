/**
 * 书源 - 网络客户端
 *
 * 优先级：
 *   1. 酒馆服务端桥接 /api/plugins/fanqie-bridge/fetch（支持 POST / 请求头 / Cookie / 编码）
 *   2. 酒馆网页通道 /api/search/visit（只能 GET HTML）
 *   3. 自定义 CORS 代理
 *   4. 浏览器直连（多数站点会被 CORS 拦下，只作兜底）
 *
 * 书源的 `concurrentRate`（"3/1000" 或 "1500"）在客户端做节流。
 */

import { buildProxyUrl, decodeHtmlBytes } from '../network.js';
import { buildRequest } from './url.js';

const DEFAULT_BRIDGE = '/api/plugins/fanqie-bridge';

function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, Math.max(0, ms));
        signal?.addEventListener?.('abort', () => {
            clearTimeout(timer);
            const error = new Error('已停止');
            error.name = 'AbortError';
            reject(error);
        }, { once: true });
    });
}

/** "3/1000" → 3 次 / 1000ms；"1500" → 1 次 / 1500ms */
export function parseConcurrentRate(value) {
    const text = String(value ?? '').trim();
    if (!text) return null;
    const match = text.match(/^(\d+)(?:\/(\d+))?$/);
    if (!match) return null;
    const limit = Number(match[1]);
    const interval = match[2] == null ? limit : Number(match[2]);
    if (!limit || !interval) return null;
    return { limit, interval };
}

export class NetClient {
    constructor({
        bridgeBase = DEFAULT_BRIDGE,
        getRequestHeaders = null,
        fetchImpl = null,
        timeoutMs = 15000,
        proxyTemplate = '',
        channel = 'auto',
    } = {}) {
        this.bridgeBase = String(bridgeBase || DEFAULT_BRIDGE).replace(/\/+$/, '');
        this.getRequestHeaders = getRequestHeaders;
        this.fetchImpl = fetchImpl || globalThis.fetch?.bind(globalThis);
        this.timeoutMs = Math.min(120000, Math.max(3000, Number(timeoutMs) || 15000));
        this.proxyTemplate = proxyTemplate;
        this.channel = channel;
        this.bridgeAvailable = null;
        this.batchUnavailable = false;
        /** 为 true 时才按书源 concurrentRate 节流；否则用全局并发数 */
        this.respectRateLimit = false;
        this.rateLimits = new Map();
        this.rateState = new Map();
        this.cookies = new Map();
        this.lastVia = '';
        this.warnings = [];
    }

    setRateLimit(sourceKey, rate) {
        if (!this.respectRateLimit) {
            if (sourceKey) this.rateLimits.delete(sourceKey);
            return;
        }
        const parsed = parseConcurrentRate(rate);
        if (sourceKey && parsed) this.rateLimits.set(sourceKey, parsed);
        else if (sourceKey) this.rateLimits.delete(sourceKey);
    }

    async waitRate(sourceKey, signal) {
        const limit = this.rateLimits.get(sourceKey);
        if (!limit) return;
        const state = this.rateState.get(sourceKey) || { times: [] };
        const now = Date.now();
        state.times = state.times.filter(time => now - time < limit.interval);
        if (state.times.length >= limit.limit) {
            const wait = limit.interval - (now - state.times[0]);
            await sleep(wait, signal);
        }
        state.times.push(Date.now());
        this.rateState.set(sourceKey, state);
    }

    /** 发起一个已经编译好的请求 */
    async request(request, { signal } = {}) {
        if (!request?.url) throw new Error('请求地址为空');
        const sourceKey = request.sourceKey || '';
        await this.waitRate(sourceKey, signal);
        if (this.channel !== 'tavern' && this.channel !== 'proxy' && this.bridgeAvailable !== false) {
            try {
                const result = await this.viaBridge(request, signal);
                this.lastVia = 'bridge';
                return result;
            } catch (error) {
                if (error?.code === 'BRIDGE_MISSING') {
                    this.bridgeAvailable = false;
                    this.warnings.push('书源抓取桥接没装：POST / 请求头 / Cookie 都用不了，已退回酒馆网页通道（只能 GET HTML）');
                } else if (error?.code === 'BRIDGE_UPSTREAM' || error?.code === 'BRIDGE_HTTP' || (request.method && request.method !== 'GET')) {
                    // 桥接明确报错时不要再退回酒馆通道，否则真实原因会被「网页通道 500」盖掉
                    const wrapped = new Error(`桥接抓取失败（${request.url}）：${error.message}`);
                    wrapped.code = error.code || 'BRIDGE_ERROR';
                    throw wrapped;
                } else {
                    this.warnings.push(`桥接抓取失败：${error.message}`);
                }
            }
        }
        if (request.method && request.method !== 'GET') {
            throw new Error('POST 请求需要书源抓取桥接：在酒馆根目录执行 install-server.sh 并重启');
        }
        const channels = this.channel === 'proxy' ? ['proxy'] : (this.channel === 'tavern' ? ['tavern'] : ['tavern', 'proxy', 'direct']);
        let lastError = null;
        for (const channel of channels) {
            try {
                const text = await this.viaChannel(channel, request, signal);
                if (!text || text.length < 30) throw new Error('返回内容过短，可能被站点拒绝');
                this.lastVia = channel;
                return {
                    text,
                    finalUrl: request.url,
                    status: 200,
                    headers: {},
                    via: channel,
                };
            } catch (error) {
                if (error?.name === 'AbortError') throw error;
                lastError = error;
            }
        }
        if (lastError?.name === 'AbortError') throw lastError;
        throw new Error(`抓取失败（${request.url}）：${lastError?.message || '所有通道都不可用'}`);
    }

    async requestWithRetry(request, { signal } = {}) {
        const retries = Math.max(0, Number(request.retry) || 0);
        let lastError;
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                return await this.request(request, { signal });
            } catch (error) {
                if (error?.name === 'AbortError') throw error;
                lastError = error;
                if (attempt < retries) await sleep(400 * (attempt + 1), signal);
            }
        }
        throw lastError;
    }

    /**
     * 批量取页面：一次 POST 换 N 个页面，下载整本时能省掉大量往返。
     * 桥接不支持（老版本 / 没装）时返回 null，调用方回退到逐章请求。
     */
    async requestBatch(requests, { signal = null, concurrency = 6 } = {}) {
        const list = Array.isArray(requests) ? requests : [];
        if (!list.length) return [];
        // 批量接口是后加的：老桥接 404 正常，别因此把整个桥接判死
        if (this.bridgeAvailable === false || this.batchUnavailable) return null;
        const headers = {
            ...(typeof this.getRequestHeaders === 'function' ? (this.getRequestHeaders() || {}) : {}),
            'Content-Type': 'application/json',
        };
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error('批量请求超时')), this.timeoutMs * 4 + 10000);
        const onAbort = () => controller.abort(signal?.reason);
        if (signal) {
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
        }
        try {
            const response = await this.fetchImpl(`${this.bridgeBase}/fetch-batch`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    concurrency: Math.max(1, Math.min(16, Number(concurrency) || 6)),
                    requests: list.map(request => ({
                        url: request.url,
                        method: request.method || 'GET',
                        headers: request.headers || {},
                        body: request.body || '',
                        charset: request.charset || '',
                        timeout: this.timeoutMs,
                        sourceKey: request.sourceKey || '',
                    })),
                }),
                signal: controller.signal,
                credentials: 'same-origin',
            });
            if (response.status === 404) {
                this.batchUnavailable = true;
                this.warnings.push('桥接没有 /fetch-batch：下载会退化成逐章请求，装新版桥接能快很多');
                return null;
            }
            if (!response.ok) return null;
            const payload = await response.json().catch(() => null);
            if (!payload?.ok || !Array.isArray(payload.results)) return null;
            const failed = payload.results.filter(item => !item?.ok).length;
            if (failed === payload.results.length) return null;
            return payload.results;
        } catch (error) {
            if (error?.name === 'AbortError') throw error;
            return null;
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener?.('abort', onAbort);
        }
    }

    async fetchTemplate(template, options = {}) {
        const request = buildRequest(template, options);
        if (request.warning) this.warnings.push(request.warning);
        const result = await this.requestWithRetry(request, { signal: options.signal });
        return { ...result, request };
    }

    async viaBridge(request, signal) {
        const headers = {
            ...(typeof this.getRequestHeaders === 'function' ? (this.getRequestHeaders() || {}) : {}),
            'Content-Type': 'application/json',
        };
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error('桥接请求超时')), this.timeoutMs + 5000);
        const onAbort = () => controller.abort(signal?.reason);
        if (signal) {
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
        }
        try {
            const response = await this.fetchImpl(`${this.bridgeBase}/fetch`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    url: request.url,
                    method: request.method || 'GET',
                    headers: request.headers || {},
                    body: request.body || '',
                    charset: request.charset || '',
                    timeout: this.timeoutMs,
                    sourceKey: request.sourceKey || '',
                    useCookie: true,
                }),
                signal: controller.signal,
                credentials: 'same-origin',
            });
            if (response.status === 404) {
                const error = new Error('桥接没有 /fetch 路由');
                error.code = 'BRIDGE_MISSING';
                throw error;
            }
            if (response.status === 403) {
                const error = new Error('酒馆拒绝了桥接请求（403，CSRF）：刷新页面后重试；仍失败就重启酒馆');
                error.code = 'BRIDGE_HTTP';
                throw error;
            }
            let payload = null;
            try {
                payload = await response.json();
            } catch {
                const error = new Error(`桥接返回的不是 JSON（HTTP ${response.status}）`);
                error.code = 'BRIDGE_HTTP';
                throw error;
            }
            if (!payload?.ok) {
                const error = new Error(payload?.error || `桥接抓取失败（HTTP ${response.status}）`);
                error.code = 'BRIDGE_UPSTREAM';
                throw error;
            }
            return {
                text: String(payload.text ?? ''),
                finalUrl: String(payload.finalUrl || request.url),
                status: Number(payload.status) || 200,
                headers: payload.headers || {},
                via: 'bridge',
            };
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener?.('abort', onAbort);
        }
    }

    async viaChannel(channel, request, signal) {
        if (channel === 'tavern') return await this.viaTavern(request.url, signal);
        if (channel === 'proxy') return await this.viaProxy(request.url, signal);
        return await this.viaDirect(request.url, signal);
    }

    async viaTavern(url, signal) {
        if (typeof this.getRequestHeaders !== 'function') throw new Error('酒馆网页通道不可用');
        const headers = { ...(this.getRequestHeaders() || {}), 'Content-Type': 'application/json' };
        const response = await this.fetchImpl('/api/search/visit', {
            method: 'POST',
            headers,
            body: JSON.stringify({ url, html: true }),
            signal,
        });
        if (!response.ok) {
            throw new Error(`酒馆网页通道返回 ${response.status}（这条通道只能转发 GET HTML；POST / 请求头 / Cookie 需要桥接插件）`);
        }
        return await response.text();
    }

    async viaProxy(url, signal) {
        if (!this.proxyTemplate) throw new Error('没有配置 CORS 代理');
        const target = buildProxyUrl(this.proxyTemplate, url);
        const response = await this.fetchImpl(target, { signal });
        if (!response.ok) throw new Error(`代理返回 ${response.status}`);
        return decodeHtmlBytes(new Uint8Array(await response.arrayBuffer()));
    }

    async viaDirect(url, signal) {
        const response = await this.fetchImpl(url, {
            method: 'GET',
            credentials: 'omit',
            redirect: 'follow',
            signal,
            headers: {
                Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
            },
        });
        if (!response.ok) throw new Error(`站点返回 ${response.status}`);
        return decodeHtmlBytes(new Uint8Array(await response.arrayBuffer()));
    }

    /* ------------------------------ Cookie ------------------------------ */

    async loadCookie(sourceKey) {
        if (!sourceKey) return '';
        if (this.cookies.has(sourceKey)) return this.cookies.get(sourceKey);
        try {
            const response = await this.fetchImpl(
                `${this.bridgeBase}/cookie?sourceKey=${encodeURIComponent(sourceKey)}`,
                { headers: this.getRequestHeaders?.() || {} },
            );
            if (!response.ok) return '';
            const payload = await response.json();
            const value = String(payload?.cookie || '');
            this.cookies.set(sourceKey, value);
            return value;
        } catch {
            return '';
        }
    }

    async saveCookie(sourceKey, cookie) {
        if (!sourceKey) return false;
        this.cookies.set(sourceKey, String(cookie || ''));
        try {
            const response = await this.fetchImpl(`${this.bridgeBase}/cookie`, {
                method: 'POST',
                headers: {
                    ...(typeof this.getRequestHeaders === 'function' ? (this.getRequestHeaders() || {}) : {}),
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ sourceKey, cookie }),
            });
            return response.ok;
        } catch {
            return false;
        }
    }
}
