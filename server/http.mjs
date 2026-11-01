/**
 * 书源抓取 - 服务端 HTTP
 *
 * 浏览器受 CORS 限制，书源的 POST / 自定义请求头 / Cookie / 非 UTF-8 编码都拿不到；
 * 这里在酒馆同源下代抓一次，返回解码后的文本。
 *
 * 只允许公网 http(s)：默认拦截 localhost / 内网段 / 链路本地地址，
 * 需要访问局域网时设 NOVEL_BRIDGE_ALLOW_PRIVATE=1（自行承担风险）。
 */

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_POST_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT = 15000;

/** Cookie 罐：sourceKey → hostname → Map(name → value) */
const cookieJar = new Map();

const PRIVATE_HOST = /^(?:localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|::1$|\[::1\]$|.*\.local$)/i;

export function isPrivateHost(hostname) {
    const host = String(hostname || '').toLowerCase();
    if (!host) return true;
    if (PRIVATE_HOST.test(host)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
    if (host === 'metadata.google.internal') return true;
    return false;
}

export function isAllowedTarget(value) {
    let url;
    try {
        url = new URL(String(value || ''));
    } catch {
        return false;
    }
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    if (process.env.NOVEL_BRIDGE_ALLOW_PRIVATE === '1') return true;
    return !isPrivateHost(url.hostname);
}

function normalizeCharset(value) {
    const text = String(value || '').trim().toLowerCase();
    if (!text) return '';
    if (text === 'gb2312' || text === 'gbk' || text === 'gb18030') return 'gb18030';
    if (text === 'big5' || text === 'big-5') return 'big5';
    if (text === 'utf8') return 'utf-8';
    return text;
}

function charsetFromContentType(contentType) {
    const match = String(contentType || '').match(/charset\s*=\s*["']?([\w-]+)/i);
    return match ? normalizeCharset(match[1]) : '';
}

function charsetFromMeta(bytes) {
    const sample = Buffer.from(bytes.slice(0, 4096)).toString('latin1').toLowerCase();
    const match = sample.match(/charset\s*=\s*["']?\s*([\w-]+)/);
    return match ? normalizeCharset(match[1]) : '';
}

export function decodeBody(bytes, contentType = '', charset = '') {
    const target = normalizeCharset(charset) || charsetFromContentType(contentType) || charsetFromMeta(bytes) || 'utf-8';
    try {
        return { text: new TextDecoder(target, { fatal: false }).decode(bytes), charset: target };
    } catch {
        try {
            return { text: new TextDecoder('utf-8', { fatal: false }).decode(bytes), charset: 'utf-8' };
        } catch {
            return { text: Buffer.from(bytes).toString('latin1'), charset: 'latin1' };
        }
    }
}

function hostOf(value) {
    try {
        return new URL(value).hostname.toLowerCase();
    } catch {
        return '';
    }
}

function jarFor(sourceKey) {
    const key = String(sourceKey || '');
    if (!cookieJar.has(key)) cookieJar.set(key, new Map());
    return cookieJar.get(key);
}

/** 把 Set-Cookie 头合并进对应域 */
export function absorbSetCookie(sourceKey, url, setCookieValues) {
    const host = hostOf(url);
    if (!host) return;
    const jar = jarFor(sourceKey);
    if (!jar.has(host)) jar.set(host, new Map());
    const cookies = jar.get(host);
    for (const value of setCookieValues || []) {
        const first = String(value || '').split(';')[0];
        const index = first.indexOf('=');
        if (index <= 0) continue;
        const name = first.slice(0, index).trim();
        const content = first.slice(index + 1).trim();
        if (!name) continue;
        if (/max-age=0|expires=thu, 01 jan 1970/i.test(String(value))) cookies.delete(name);
        else cookies.set(name, content);
    }
}

/** 取某个源的 Cookie 请求头（会优先用登录头里存的整串） */
export function getCookieHeader(sourceKey, url = '') {
    const key = String(sourceKey || '');
    if (!key) return '';
    const loginHeader = loginHeaderStore.get(key);
    if (loginHeader) {
        try {
            const parsed = JSON.parse(loginHeader);
            const cookie = parsed?.Cookie || parsed?.cookie;
            if (cookie) return String(cookie);
        } catch {
            // 不是 JSON 就当成整串 Cookie
            return loginHeader;
        }
    }
    const host = hostOf(url);
    const jar = jarFor(key);
    const pairs = [];
    for (const [cookieHost, cookies] of jar) {
        if (host && cookieHost !== host && !host.endsWith(`.${cookieHost}`)) continue;
        for (const [name, value] of cookies) pairs.push(`${name}=${value}`);
    }
    return pairs.join('; ');
}

/** 登录头（source.putLoginHeader 写入的整串 Cookie / Header） */
const loginHeaderStore = new Map();

export function putLoginHeader(sourceKey, headerText) {
    const key = String(sourceKey || '');
    const text = String(headerText || '').trim();
    if (!key) return false;
    if (!text) loginHeaderStore.delete(key);
    else loginHeaderStore.set(key, text);
    return true;
}

export function getLoginHeader(sourceKey) {
    return loginHeaderStore.get(String(sourceKey || '')) || '';
}

/** 手动设置整串 Cookie（登录后从浏览器复制过来的那种） */
export function setCookieRaw(sourceKey, cookieText, url = '') {
    const key = String(sourceKey || '');
    if (!key) return false;
    const text = String(cookieText || '').trim();
    if (!text) return false;
    const host = hostOf(url) || 'manual';
    const jar = jarFor(key);
    if (!jar.has(host)) jar.set(host, new Map());
    const cookies = jar.get(host);
    for (const pair of text.split(';')) {
        const index = pair.indexOf('=');
        if (index <= 0) continue;
        cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    }
    return true;
}

export function clearCookies(sourceKey) {
    cookieJar.delete(String(sourceKey || ''));
    loginHeaderStore.delete(String(sourceKey || ''));
}

/** 当前某个源的 Cookie（给界面显示 / 导出） */
export function dumpCookies(sourceKey) {
    const jar = jarFor(sourceKey);
    const list = [];
    for (const [host, cookies] of jar) {
        for (const [name, value] of cookies) list.push({ host, name, value });
    }
    return list;
}

/**
 * 代抓一个地址。
 * @returns {Promise<{status:number, finalUrl:string, headers:object, text:string, charset:string, elapsed:number}>}
 */
export async function fetchUrl({
    url,
    method = 'GET',
    headers = {},
    body = '',
    timeout = DEFAULT_TIMEOUT,
    charset = '',
    sourceKey = '',
    useCookie = true,
} = {}) {
    const target = String(url || '').trim();
    if (!isAllowedTarget(target)) throw new Error('只接受公网 http(s) 地址');
    const verb = ['GET', 'POST', 'HEAD'].includes(String(method).toUpperCase()) ? String(method).toUpperCase() : 'GET';
    const postBody = String(body || '');
    if (postBody.length > MAX_POST_BYTES) throw new Error('POST 内容过大');
    const headerMap = {};
    for (const [name, value] of Object.entries(headers || {})) {
        if (Object.keys(headerMap).length >= 32) break;
        if (value == null) continue;
        const clean = String(value);
        if (clean.length > 2048) continue;
        headerMap[name] = clean;
    }
    if (useCookie && sourceKey) {
        const cookie = getCookieHeader(sourceKey, target);
        if (cookie && !Object.keys(headerMap).some(name => name.toLowerCase() === 'cookie')) {
            headerMap.Cookie = cookie;
        }
    }
    if (!Object.keys(headerMap).some(name => name.toLowerCase() === 'user-agent')) {
        headerMap['User-Agent'] = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';
    }
    if (verb === 'POST' && !Object.keys(headerMap).some(name => name.toLowerCase() === 'content-type')) {
        headerMap['Content-Type'] = /^\s*[[{]/.test(postBody)
            ? 'application/json; charset=utf-8'
            : 'application/x-www-form-urlencoded; charset=utf-8';
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('抓取超时')), Math.min(120000, Math.max(3000, Number(timeout) || DEFAULT_TIMEOUT)));
    const started = Date.now();
    try {
        const response = await fetch(target, {
            method: verb,
            headers: headerMap,
            body: verb === 'GET' || verb === 'HEAD' ? undefined : postBody,
            redirect: 'follow',
            signal: controller.signal,
        });
        const buffer = verb === 'HEAD' ? new Uint8Array(0) : new Uint8Array(await response.arrayBuffer());
        if (buffer.byteLength > MAX_BODY_BYTES) throw new Error('响应超过 8MB，已拒绝');
        if (useCookie && sourceKey) {
            const setCookies = typeof response.headers.getSetCookie === 'function'
                ? response.headers.getSetCookie()
                : (response.headers.get('set-cookie') ? [response.headers.get('set-cookie')] : []);
            absorbSetCookie(sourceKey, response.url || target, setCookies);
        }
        const contentType = response.headers.get('content-type') || '';
        const decoded = decodeBody(buffer, contentType, charset);
        return {
            status: response.status,
            finalUrl: response.url || target,
            headers: {
                'content-type': contentType,
                'content-length': response.headers.get('content-length') || '',
            },
            text: decoded.text,
            charset: decoded.charset,
            elapsed: Date.now() - started,
        };
    } finally {
        clearTimeout(timer);
    }
}
