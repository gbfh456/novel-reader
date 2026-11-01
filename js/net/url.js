/**
 * 书源 - URL 解析
 *
 * 对应 AnalyzeUrl 的「规则字符串 → 请求」这一段：
 *   - 关键词 / 页码占位符：{{key}}、{{page}}、{{searchKey}}、{{searchPage}}
 *   - 页码列表：<1,2,3>
 *   - 尾部请求选项：,{"method":"POST","body":"...","headers":{...},"charset":"gbk","retry":1,"js":"..."}
 *   - 相对地址按书源地址补全
 */

const OPTION_SPLIT = /\s*,\s*(?=\s*\{)/;

/** 把模板里的 {{...}} 换成实际值；复杂 JS 只支持不联网的纯表达式 */
export function applyUrlTemplate(template, vars = {}) {
    let output = String(template ?? '');
    // 页码列表 <1,2,3>
    output = output.replace(/<([^<>]*)>/g, (match, body) => {
        const pages = String(body).split(',').map(item => item.trim());
        if (!pages.length) return '';
        const page = Math.max(1, Math.floor(Number(vars.page) || 1));
        return page < pages.length ? pages[page - 1] : pages[pages.length - 1];
    });
    // 本插件旧格式的单花括号占位符（{key} / {page} / %s）
    // 用前置字符判断，避免把 {{key}} 里的内层也换成单花括号
    output = output.replace(/(^|[^{])\{(key|keyword|page)\}(?!\})/gi, (match, prefix, name) => {
        const lower = String(name).toLowerCase();
        if (lower === 'page') return prefix + String(Math.max(1, Math.floor(Number(vars.page) || 1)));
        return prefix + encodeURIComponent(String(vars.key ?? ''));
    });
    output = output.replace(/%s/g, encodeURIComponent(String(vars.key ?? '')));
    // {{...}}
    output = output.replace(/\{\{([\s\S]*?)\}\}/g, (match, code) => {
        const expression = String(code).trim();
        if (!expression) return '';
        if (/^[a-zA-Z_$][\w$]*$/.test(expression) && expression in vars) {
            return String(vars[expression] ?? '');
        }
        try {
            return String(evaluateUrlJs(expression, vars) ?? '');
        } catch {
            return '';
        }
    });
    return output;
}

function evaluateUrlJs(code, vars) {
    const sandbox = {
        key: vars.key ?? '',
        page: vars.page ?? 1,
        searchKey: vars.key ?? '',
        searchPage: vars.page ?? 1,
        baseUrl: vars.baseUrl ?? '',
        source: vars.source ?? null,
        book: vars.book ?? null,
        java: {
            encodeURI: value => encodeURIComponent(String(value ?? '')),
            base64Encode: value => {
                try {
                    return btoa(unescape(encodeURIComponent(String(value ?? ''))));
                } catch {
                    return '';
                }
            },
            timeFormat: value => new Date(Number(value) || Date.now()).toISOString(),
        },
    };
    // eslint-disable-next-line no-new-func
    const runner = new Function('__scope', '__code', 'with (__scope) { return eval(__code); }');
    return runner(sandbox, String(code));
}

/** 拆开「地址 + 选项 JSON」，选项解析失败时保留原样并给出提示 */
export function splitUrlOption(template) {
    const source = String(template ?? '');
    const match = source.match(OPTION_SPLIT);
    if (!match || match.index == null) return { url: source.trim(), option: null, warning: '' };
    const url = source.slice(0, match.index).trim();
    const optionText = source.slice(match.index + match[0].length).trim();
    try {
        return { url, option: JSON.parse(optionText), warning: '' };
    } catch (error) {
        return { url, option: null, warning: `URL 选项不是合法 JSON：${error.message}` };
    }
}

function encodeForm(body, charset) {
    const text = String(body ?? '');
    if (!text || /^[\[{]/.test(text.trim())) return text;
    const encoder = value => {
        if (charset === 'escape') return escape(value);
        return encodeURIComponent(value);
    };
    return text.split('&').map(pair => {
        const index = pair.indexOf('=');
        if (index < 0) return encoder(pair);
        return `${encoder(pair.slice(0, index))}=${encoder(pair.slice(index + 1))}`;
    }).join('&');
}

function resolveAbsolute(url, baseUrl) {
    const target = String(url ?? '').trim();
    if (!target) return '';
    try {
        return new URL(target, baseUrl || undefined).toString();
    } catch {
        return target;
    }
}

/**
 * 把书源里的地址规则编译成请求对象。
 * @returns {{url:string, method:string, headers:object, body:string, charset:string,
 *            retry:number, sourceKey:string, warning:string}}
 */
export function buildRequest(template, {
    source = null,
    key = '',
    page = 1,
    baseUrl = '',
    book = null,
} = {}) {
    const raw = String(template ?? '').trim();
    if (!raw) throw new Error('书源没有填地址规则');
    if (raw.startsWith('@js:') || raw.startsWith('<js>')) {
        throw new Error('这个地址用了 JS 规则：需要 JS 沙箱（P4）');
    }
    const vars = {
        key,
        page: Math.max(1, Math.floor(Number(page) || 1)),
        baseUrl: baseUrl || source?.bookSourceUrl || '',
        source,
        book,
    };
    const filled = applyUrlTemplate(raw, vars);
    const { url, option, warning } = splitUrlOption(filled);
    const base = baseUrl || source?.bookSourceUrl || '';
    const request = {
        url: resolveAbsolute(url, base),
        method: 'GET',
        headers: {},
        body: '',
        charset: '',
        retry: 0,
        sourceKey: source?.bookSourceUrl || '',
        warning,
    };
    if (!request.url) throw new Error('地址规则是空的');
    if (!option) return request;

    if (option.method) {
        const method = String(option.method).toUpperCase();
        request.method = ['GET', 'POST', 'HEAD'].includes(method) ? method : 'GET';
    }
    if (option.headers && typeof option.headers === 'object') {
        for (const [name, value] of Object.entries(option.headers)) {
            if (value == null) continue;
            request.headers[name] = String(value);
        }
    }
    if (option.body != null) {
        request.body = String(option.body);
        if (request.method === 'GET') request.method = 'POST';
    }
    if (option.charset) request.charset = String(option.charset);
    if (Number(option.retry) > 0) request.retry = Math.min(3, Math.floor(Number(option.retry)));
    if (option.js) {
        try {
            const next = evaluateUrlJs(option.js, { ...vars, url: request.url });
            if (next) request.url = String(next);
        } catch (error) {
            request.warning = `${request.warning ? `${request.warning}；` : ''}URL 选项里的 js 执行失败：${error.message}`;
        }
    }
    if (request.method === 'POST') {
        if (!request.headers['Content-Type'] && !request.headers['content-type']) {
            const body = String(request.body);
            request.headers['Content-Type'] = /^\s*[[{]/.test(body)
                ? 'application/json; charset=utf-8'
                : 'application/x-www-form-urlencoded; charset=utf-8';
        }
        request.body = encodeForm(request.body, request.charset);
    }
    return request;
}

/** 判断地址是否属于某个书源（按主机名 + bookUrlPattern） */
export function urlMatchesSource(source, url) {
    const target = String(url ?? '').trim();
    if (!target) return false;
    const pattern = source?.bookUrlPattern;
    if (pattern) {
        try {
            if (new RegExp(pattern).test(target)) return true;
        } catch {
            // 规则写错了就退回主机名判断
        }
    }
    try {
        const host = new URL(target).hostname.replace(/^www\./, '').toLowerCase();
        const sourceHost = new URL(source?.bookSourceUrl || '').hostname.replace(/^www\./, '').toLowerCase();
        if (!host || !sourceHost) return false;
        return host === sourceHost || host.endsWith(`.${sourceHost}`) || sourceHost.endsWith(`.${host}`);
    } catch {
        return false;
    }
}

export { resolveAbsolute };
