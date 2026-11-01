/**
 * 规则 JS 沙箱 - 主线程侧
 *
 * Legado 的规则 JS 是同步的（java.ajax 会阻塞），浏览器主线程做不到；
 * 这里把 JS 丢进 module worker，worker 里用同步 XHR 打酒馆服务端的 /fetch，
 * 从而保留「同步取网页」的语义，规则本身不用改写。
 */

function toPlain(value, depth = 0) {
    if (value == null) return value;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
    if (depth > 4) return String(value);
    if (Array.isArray(value)) return value.map(item => toPlain(item, depth + 1));
    if (typeof Element !== 'undefined' && value instanceof Element) {
        return value.outerHTML || value.textContent || '';
    }
    if (value?.type === 'element') {
        // 轻量 DOM 节点：转成文本，避免 structured clone 失败
        return String(value.text ?? '') || String(value.attrs?.href ?? '');
    }
    if (typeof value === 'object') {
        try {
            structuredClone(value);
            return value;
        } catch {
            const plain = {};
            for (const [key, item] of Object.entries(value)) {
                if (typeof item === 'function') continue;
                plain[key] = toPlain(item, depth + 1);
            }
            return plain;
        }
    }
    return String(value);
}

export class JsSandbox {
    constructor({ getRequestHeaders = null, timeoutMs = 20000 } = {}) {
        this.getRequestHeaders = getRequestHeaders;
        this.timeoutMs = Math.min(60000, Math.max(3000, Number(timeoutMs) || 20000));
        this.worker = null;
        this.pending = new Map();
        this.nextId = 1;
        this.unavailable = false;
    }

    ensureWorker() {
        if (this.worker || this.unavailable) return this.worker;
        if (typeof Worker !== 'function') {
            this.unavailable = true;
            return null;
        }
        try {
            this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
            this.worker.onmessage = event => {
                const message = event.data || {};
                const pending = this.pending.get(message.id);
                if (!pending) return;
                this.pending.delete(message.id);
                clearTimeout(pending.timer);
                if (message.ok) pending.resolve(message);
                else pending.reject(new Error(message.error || 'JS 规则执行失败'));
            };
            this.worker.onerror = event => {
                console.warn('[小说阅读器] JS 沙箱出错', event.message || event);
                for (const [, pending] of this.pending) {
                    clearTimeout(pending.timer);
                    pending.reject(new Error('JS 沙箱线程出错'));
                }
                this.pending.clear();
                this.terminate();
            };
        } catch (error) {
            console.warn('[小说阅读器] JS 沙箱启动失败', error);
            this.unavailable = true;
            this.worker = null;
        }
        return this.worker;
    }

    terminate() {
        try {
            this.worker?.terminate?.();
        } catch {
            // ignore
        }
        this.worker = null;
    }

    /**
     * 执行一段规则 JS。
     * @param {{code:string, result:any, ctx:object, source?:object}} request
     */
    async evaluate({ code, result = null, ctx = null, source = null } = {}) {
        const worker = this.ensureWorker();
        if (!worker) {
            const error = new Error('当前环境不支持 Worker，JS 规则无法执行');
            error.code = 'SANDBOX_UNAVAILABLE';
            throw error;
        }
        const id = this.nextId++;
        const context = ctx || {};
        const payload = {
            id,
            code: String(code ?? ''),
            result: toPlain(result),
            content: typeof context.content === 'string' ? context.content : '',
            baseUrl: context.baseUrl || '',
            key: context.key ?? '',
            page: context.page ?? 1,
            title: context.chapter?.title || context.title || '',
            nextChapterUrl: context.nextChapterUrl || '',
            vars: context.vars instanceof Map ? [...context.vars.entries()] : [],
            source: source || context.source || null,
            book: context.book || null,
            chapter: context.chapter || null,
            settings: {
                fetchBase: context.fetchBase || '/api/plugins/fanqie-bridge',
                headers: typeof this.getRequestHeaders === 'function' ? (this.getRequestHeaders() || {}) : {},
                timeout: this.timeoutMs,
            },
        };
        return await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                this.terminate();
                reject(new Error(`JS 规则超时（${this.timeoutMs}ms），已重启沙箱`));
            }, this.timeoutMs + 3000);
            this.pending.set(id, {
                resolve: message => {
                    if (Array.isArray(message.logs) && ctx?.logs) ctx.logs.push(...message.logs);
                    resolve(message.value);
                },
                reject,
                timer,
            });
            try {
                worker.postMessage(payload);
            } catch (error) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(error);
            }
        });
    }
}
