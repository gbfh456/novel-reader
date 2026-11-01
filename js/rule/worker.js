/**
 * 规则 JS 沙箱 - Worker 侧
 *
 * 在 Worker 里执行书源的 @js / {{}} 规则：
 *   - java.ajax/get/post/connect 用「同步 XHR」打酒馆的 /fetch，保留 Legado 的同步语义
 *   - java.getString / getStringList / getElements 用本文件里的轻量 DOM 引擎
 *   - source.login / putLoginHeader / cookie.* 走 /cookie 路由
 *   - jsLib / importScript 在每次执行前拼接进作用域
 *
 * Worker 里没有 DOMParser，HTML 解析用 js/network.js 的轻量解析器（够规则用）。
 */

import { buildRequest } from '../net/url.js';
import { createRuleContext, getElements, getString, getStringList } from './execute.js';

const libCache = new Map();
const importedScripts = new Map();

function sourceKeyOf(source) {
    return String(source?.bookSourceUrl || source?.sourceUrl || source?.getKey?.() || '');
}

function requestSync(request, env) {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${env.fetchBase}/fetch`, false);
    xhr.setRequestHeader('Content-Type', 'application/json');
    for (const [name, value] of Object.entries(env.headers || {})) {
        try {
            xhr.setRequestHeader(name, value);
        } catch {
            // 浏览器不允许的头直接跳过
        }
    }
    const payload = {
        url: request.url,
        method: request.method || 'GET',
        headers: request.headers || {},
        body: request.body || '',
        charset: request.charset || '',
        timeout: env.timeout || 15000,
        sourceKey: env.sourceKey || '',
        useCookie: true,
    };
    xhr.send(JSON.stringify(payload));
    if (xhr.status === 0) throw new Error('书源抓取桥接不可达（同步请求失败）');
    if (xhr.status === 404) throw new Error('书源抓取桥接没装：需要 /fetch 路由');
    let data;
    try {
        data = JSON.parse(xhr.responseText || '{}');
    } catch {
        throw new Error(`桥接返回的不是 JSON（HTTP ${xhr.status}）`);
    }
    if (!data.ok) throw new Error(data.error || `抓取失败（HTTP ${xhr.status}）`);
    return data;
}

function cookieSync(env, { method = 'GET', body = null, query = '' } = {}) {
    const xhr = new XMLHttpRequest();
    const url = `${env.fetchBase}/cookie${query}`;
    xhr.open(method, url, false);
    xhr.setRequestHeader('Content-Type', 'application/json');
    for (const [name, value] of Object.entries(env.headers || {})) {
        try {
            xhr.setRequestHeader(name, value);
        } catch {
            // ignore
        }
    }
    xhr.send(body ? JSON.stringify(body) : undefined);
    if (xhr.status === 0) return null;
    try {
        return JSON.parse(xhr.responseText || '{}');
    } catch {
        return null;
    }
}

function toSerializable(value) {
    if (value == null) return null;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.map(toSerializable);
    if (value?.type === 'element') {
        const text = value.text ?? '';
        const attrs = value.attrs || {};
        return { text, href: attrs.href || '', src: attrs.src || '' };
    }
    if (typeof value === 'object') {
        const plain = {};
        for (const [key, item] of Object.entries(value)) {
            if (typeof item === 'function') continue;
            plain[key] = toSerializable(item);
        }
        return plain;
    }
    return String(value);
}

/** 把轻量 DOM 节点包成接近 JXNode 的对象（text()/attr()/html()/select()） */
function wrapNode(node) {
    if (!node || typeof node !== 'object') return null;
    const element = node;
    const textOf = () => String(element.text ?? '').trim();
    return {
        text: textOf,
        ownText: () => String((element.children || []).filter(child => child.type === 'text').map(child => child.text).join(' ')).trim(),
        html: () => {
            const serialize = current => {
                if (current.type === 'text') return current.text;
                const attrs = Object.entries(current.attrs || {}).map(([key, value]) => ` ${key}="${value}"`).join('');
                return `<${current.tag}${attrs}>${(current.children || []).map(serialize).join('')}</${current.tag}>`;
            };
            return (element.children || []).map(serialize).join('');
        },
        attr: name => String(element.attrs?.[name] ?? ''),
        select: selector => {
            const list = getElements(selector, element);
            return list.map(item => wrapNode(item)).filter(Boolean);
        },
        node: element,
    };
}

/** headers 可能是对象、JSON 字符串或 null */
function normalizeHeaders(headers) {
    if (!headers) return {};
    if (typeof headers === 'string') {
        try {
            const parsed = JSON.parse(headers);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch {
            return {};
        }
    }
    return typeof headers === 'object' ? headers : {};
}

function buildResponse(data) {
    return {
        body: () => data.text,
        text: () => data.text,
        url: data.finalUrl,
        statusCode: () => data.status,
        header: name => {
            const key = String(name || '').toLowerCase();
            for (const [header, value] of Object.entries(data.headers || {})) {
                if (header.toLowerCase() === key) return value;
            }
            return '';
        },
        headers: data.headers || {},
    };
}

function buildSandbox(payload, context, logs) {
    const env = {
        fetchBase: payload.settings?.fetchBase || '/api/plugins/fanqie-bridge',
        headers: payload.settings?.headers || {},
        timeout: payload.settings?.timeout || 15000,
        sourceKey: sourceKeyOf(payload.source),
    };
    const source = payload.source || {};
    const sourceKey = env.sourceKey;
    let loginHeaderCache = null;
    const vars = context.vars;

    const runCode = (code, extra = {}) => {
        const scope = { ...sandbox, ...extra };
        // eslint-disable-next-line no-new-func
        const runner = new Function('__scope', '__code', 'with (__scope) { return eval(__code); }');
        return runner(scope, String(code ?? ''));
    };

    const doRequest = (ruleUrl, { method = null, body = null, headers = null } = {}) => {
        const request = buildRequest(String(ruleUrl), {
            source,
            key: context.key,
            page: context.page,
            baseUrl: context.baseUrl,
            book: context.book,
        });
        if (method) request.method = method;
        if (body != null) request.body = String(body);
        if (headers) request.headers = { ...request.headers, ...headers };
        return requestSync(request, env);
    };

    const java = {
        ajax(url) {
            const target = Array.isArray(url) ? url[0] : url;
            try {
                return doRequest(target).text;
            } catch (error) {
                logs.push(`ajax 失败：${error.message}`);
                return '';
            }
        },
        get(url, headers = {}) {
            return buildResponse(doRequest(Array.isArray(url) ? url[0] : url, { method: 'GET', headers: normalizeHeaders(headers) }));
        },
        post(url, body = '', headers = {}) {
            return buildResponse(doRequest(Array.isArray(url) ? url[0] : url, { method: 'POST', body, headers: normalizeHeaders(headers) }));
        },
        connect(url, headers = {}) {
            return buildResponse(doRequest(Array.isArray(url) ? url[0] : url, { headers: normalizeHeaders(headers) }));
        },
        getString(rule, content) {
            return getString(rule, content ?? payload.content, context);
        },
        getStringList(rule, content) {
            return getStringList(rule, content ?? payload.content, context);
        },
        getElement(rule) {
            const list = getElements(rule, payload.content, context);
            return wrapNode(list[0]);
        },
        getElements(rule) {
            const list = getElements(rule, payload.content, context).map(item => wrapNode(item)).filter(Boolean);
            list.size = () => list.length;
            list.get = index => list[index];
            return list;
        },
        put(key, value) {
            vars.set(String(key), String(value));
            return String(value);
        },
        get(key) {
            return vars.get(String(key)) ?? '';
        },
        base64Encode(text) {
            try {
                return btoa(unescape(encodeURIComponent(String(text ?? ''))));
            } catch {
                return '';
            }
        },
        base64Decode(text) {
            try {
                return decodeURIComponent(escape(atob(String(text ?? ''))));
            } catch {
                return '';
            }
        },
        timeFormat(value) {
            return new Date(Number(value) || Date.now()).toISOString();
        },
        htmlFormat(text) {
            return String(text ?? '').replace(/<[^>]+>/g, '');
        },
        encodeURI(text) {
            return encodeURIComponent(String(text ?? ''));
        },
        importScript(path) {
            try {
                const data = doRequest(path);
                const list = importedScripts.get(sourceKey) || [];
                list.push(data.text);
                importedScripts.set(sourceKey, list);
                runCode(data.text);
            } catch (error) {
                logs.push(`importScript 失败：${error.message}`);
            }
            return '';
        },
        log(...args) {
            logs.push(args.map(String).join(' '));
        },
        toast(...args) {
            logs.push(args.map(String).join(' '));
        },
        longToast(...args) {
            logs.push(args.map(String).join(' '));
        },
        queryTTF() {
            throw new Error('字体反爬（queryTTF）插件不支持');
        },
        replaceFont() {
            throw new Error('字体反爬（replaceFont）插件不支持');
        },
    };

    const sourceApi = {
        getKey: () => sourceKey,
        getTag: () => source.bookSourceName || sourceKey,
        getVariable: () => vars.get('__sourceVariable__') || '',
        putVariable: value => {
            vars.set('__sourceVariable__', String(value ?? ''));
        },
        setVariable: value => {
            vars.set('__sourceVariable__', String(value ?? ''));
        },
        getLoginHeader: () => {
            if (loginHeaderCache != null) return loginHeaderCache;
            const data = cookieSync(env, { query: `?sourceKey=${encodeURIComponent(sourceKey)}` });
            loginHeaderCache = data?.loginHeader || '';
            return loginHeaderCache;
        },
        putLoginHeader: header => {
            loginHeaderCache = String(header || '');
            cookieSync(env, { method: 'POST', body: { sourceKey, loginHeader: String(header || '') } });
            return true;
        },
        removeLoginHeader: () => {
            loginHeaderCache = '';
            cookieSync(env, { method: 'POST', body: { sourceKey, action: 'clear' } });
        },
        getHeaderMap: hasLoginHeader => {
            const map = {};
            try {
                Object.assign(map, JSON.parse(String(source.header || '{}')));
            } catch {
                // ignore
            }
            if (hasLoginHeader) {
                const header = sourceApi.getLoginHeader();
                try {
                    const parsed = JSON.parse(header);
                    for (const [name, value] of Object.entries(parsed || {})) map[name] = value;
                } catch {
                    const cookie = String(header || '');
                    if (cookie.includes('=')) map.Cookie = cookie;
                }
            }
            return map;
        },
        login: () => {
            const raw = String(source.loginUrl || '');
            if (!raw) return;
            const code = raw.startsWith('@js:') ? raw.slice(4) : raw.replace(/^<js>/, '').replace(/<\/js>$/, '');
            // Legado 的约定：登录脚本里定义 login() 后自动调用
            runCode(`${code}\n; if (typeof login === 'function') { login(); }`);
        },
        evalJS: code => runCode(code),
        put: (key, value) => {
            vars.set(String(key), String(value));
            return String(value);
        },
        get: key => vars.get(String(key)) ?? '',
    };

    const cookie = {
        getCookie: (tag, key = '') => {
            const data = cookieSync(env, { query: `?sourceKey=${encodeURIComponent(tag || sourceKey)}` });
            if (!data) return '';
            if (key) {
                const hit = (data.items || []).find(item => item.name === key);
                return hit ? hit.value : '';
            }
            return data.cookie || '';
        },
        putCookie: (tag, key, value) => {
            cookieSync(env, { method: 'POST', body: { sourceKey: tag || sourceKey, cookie: `${key}=${value}` } });
        },
        replaceCookie: (tag, cookieText) => {
            cookieSync(env, { method: 'POST', body: { sourceKey: tag || sourceKey, action: 'clear' } });
            cookieSync(env, { method: 'POST', body: { sourceKey: tag || sourceKey, cookie: String(cookieText || '') } });
        },
    };

    const cache = {
        get: key => vars.get(String(key)) ?? '',
        put: (key, value) => {
            vars.set(String(key), String(value));
            return value;
        },
        delete: key => {
            vars.delete(String(key));
        },
    };

    const sandbox = {
        java,
        source: sourceApi,
        cookie,
        cache,
        book: payload.book || null,
        chapter: payload.chapter || null,
        baseUrl: payload.baseUrl || '',
        result: payload.result ?? null,
        title: payload.title || '',
        src: payload.content || '',
        nextChapterUrl: payload.nextChapterUrl || '',
        key: payload.key ?? '',
        page: payload.page ?? 1,
    };
    return sandbox;
}

self.onmessage = event => {
    const payload = event.data || {};
    const logs = [];
    try {
        const context = createRuleContext({
            source: payload.source,
            book: payload.book,
            chapter: payload.chapter,
            baseUrl: payload.baseUrl,
            key: payload.key,
            page: payload.page,
            nextChapterUrl: payload.nextChapterUrl,
            vars: Object.fromEntries(payload.vars || []),
        });
        context.content = payload.content || '';
        let sandbox = null;
        const execute = () => {
            sandbox = buildSandbox(payload, context, logs);
            const key = sourceKeyOf(payload.source);
            if (payload.source?.jsLib && !libCache.has(key)) libCache.set(key, String(payload.source.jsLib));
            const prelude = `${libCache.get(key) || ''}\n${(importedScripts.get(key) || []).join('\n')}`;
            const code = `${prelude}\n${payload.code || ''}`;
            // eslint-disable-next-line no-new-func
            const runner = new Function('__scope', '__code', 'with (__scope) { return eval(__code); }');
            return runner(sandbox, code);
        };
        const value = execute();
        self.postMessage({ id: payload.id, ok: true, value: toSerializable(value), logs });
    } catch (error) {
        self.postMessage({
            id: payload.id,
            ok: false,
            error: error?.message || String(error),
            stack: error?.stack || '',
            logs,
        });
    }
};
