/**
 * 书源集合抓取 / 解析（服务端那一半）
 *
 * 为什么放在服务端：书源订阅地址常常在 Cloudflare 后面，
 *   - 浏览器直连会被 CORS 拦（这类站点通常不发 Access-Control-Allow-Origin）；
 *   - 酒馆的 /api/search/visit 只接 text/html，JSON 会被它自己拒掉；
 *   - Node 自带的 fetch（undici）TLS 指纹会被 CF 直接断连。
 * 所以这里先试 fetch，失败再退到系统 curl（curl 的 TLS 指纹 + 浏览器 UA 通常能过）。
 *
 * 还有一个现实约束：订阅集合动辄几十 MB（实测一个 1.6 万条书源 ≈ 80 MB），
 * 全量灌进插件的设置里必炸（extension_settings 存在 localStorage 里），
 * 所以这里只做「统计 + 按关键词/数量筛选后返回」，前端拿到的是精简子集。
 */
import { execFile } from 'node:child_process';

const BROWSER_UA = 'Mozilla/5.0 (Linux; Android 13; SMK-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
/** 单次下载上限：160 MB（实测最大的集合约 85 MB） */
export const MAX_SOURCE_BYTES = 160 * 1024 * 1024;
/** 抓取超时 */
const FETCH_TIMEOUT_MS = 120_000;
/** 单次最多取多少条：只作内存兜底，够装下最大的已知集合（1.6 万条）；0 = 不限 */
export const MAX_IMPORT_LIMIT = 20000;

/** 只接受公网 http(s)：挡掉 file://、内网地址、IP 字面量，降低被当跳板的风险 */
export function isAllowedSourceUrl(value) {
    const raw = String(value ?? '').trim();
    if (!/^https?:\/\//i.test(raw)) return false;
    let parsed;
    try {
        parsed = new URL(raw);
    } catch {
        return false;
    }
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost')) return false;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;      // 任何 IP 字面量都不要
    if (host.startsWith('[') || host.includes('::')) return false;  // IPv6 字面量
    return true;
}

function isHttpOk(status) {
    return status >= 200 && status < 300;
}

/** curl 回退：借用系统 curl 的 TLS/HTTP2 指纹，CF 站点通常认这个 */
function viaCurl(url) {
    return new Promise((resolve, reject) => {
        const args = [
            '-sS', '-L',
            '--max-time', String(Math.round(FETCH_TIMEOUT_MS / 1000)),
            '--max-filesize', String(MAX_SOURCE_BYTES),
            '--compressed',
            '-A', BROWSER_UA,
            '-H', 'Accept: application/json,text/plain,*/*',
            '-H', 'Accept-Language: zh-CN,zh;q=0.9',
            url,
        ];
        execFile('curl', args, { maxBuffer: MAX_SOURCE_BYTES, timeout: FETCH_TIMEOUT_MS + 5_000 }, (error, stdout, stderr) => {
            if (error) {
                const detail = String(stderr || error.message || '').trim().slice(0, 200);
                return reject(new Error(detail || 'curl 抓取失败'));
            }
            const text = String(stdout || '');
            if (!text.trim()) return reject(new Error('抓回来是空内容'));
            resolve(text);
        });
    });
}

/**
 * 抓书源文本：先 fetch，失败（网络/TLS/非 2xx）再试 curl。
 * 返回原始文本（通常是 JSON）。
 */
export async function fetchSourceText(url, { fetchImpl } = {}) {
    if (!isAllowedSourceUrl(url)) throw new Error('只接受公网 http(s) 的书源链接');
    const doFetch = fetchImpl || globalThis.fetch;
    let firstError = null;
    if (typeof doFetch === 'function') {
        try {
            const response = await doFetch(url, {
                redirect: 'follow',
                headers: {
                    'User-Agent': BROWSER_UA,
                    Accept: 'application/json,text/plain,*/*',
                    'Accept-Language': 'zh-CN,zh;q=0.9',
                },
                signal: AbortSignal.timeout ? AbortSignal.timeout(FETCH_TIMEOUT_MS) : undefined,
            });
            if (isHttpOk(response.status)) {
                const buffer = Buffer.from(await response.arrayBuffer());
                if (buffer.length > MAX_SOURCE_BYTES) {
                    throw new Error(`书源集合有 ${(buffer.length / 1048576).toFixed(0)} MB，超过 ${MAX_SOURCE_BYTES / 1048576} MB 上限`);
                }
                return buffer.toString('utf8');
            }
            firstError = new Error(`直接抓取返回 ${response.status}`);
        } catch (error) {
            firstError = error;
        }
    }
    try {
        return await viaCurl(url);
    } catch (curlError) {
        const reason = firstError ? `${firstError.message}；curl 回退也失败：${curlError.message}` : curlError.message;
        throw new Error(reason);
    }
}

/**
 * 把「抓不到」翻译成能照着做的说明。
 * 实测这个 yiove 订阅站：带浏览器 UA 的 curl 能拿到 80 MB JSON，但连着拉几次之后
 * 会被 Cloudflare 掐成 TLS EOF —— 所以这里把「人机验证」和「被限流」分开说。
 */
export function describeSourceFetchFailure(error) {
    const message = String(error?.message || error || '').trim();
    if (/\b403\b|challenge|Just a moment|Attention Required|cf-mitigated/i.test(message)) {
        return {
            code: 'SOURCE_FETCH_BLOCKED',
            message: '站点要求人机验证（Cloudflare），程序抓不到这份集合：换个直链，或在浏览器里打开后复制内容贴到上面的框',
        };
    }
    if (/TLS|handshake|eof while reading|socket disconnected/i.test(message)) {
        return {
            code: 'SOURCE_FETCH_THROTTLED',
            message: '到站点的 TLS 连接被断开（这类站点常按出口 IP 限流，大集合拉一次几十 MB）：等几分钟再试，或换一个链接',
        };
    }
    if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) {
        return { code: 'SOURCE_FETCH_UNREACHABLE', message: `连不上这个域名：${message}` };
    }
    if (/curl/i.test(message) && /not found|ENOENT/i.test(message)) {
        return { code: 'SOURCE_FETCH_NO_CURL', message: '宿主机没有 curl，无法走回退通道；装一个 curl 或直接用 JSON 直链粘贴' };
    }
    return { code: 'SOURCE_FETCH_FAILED', message: message || '抓取失败' };
}

/** 解析集合文本：支持裸数组 / {sources:[]} / {bookSources:[]} */
export function parseSourceCollection(text) {
    const raw = String(text ?? '').trim();
    if (!raw) throw new Error('书源集合是空的');
    let data;
    try {
        data = JSON.parse(raw);
    } catch (error) {
        throw new Error(`不是合法的 JSON（${error.message}）：确认链接给的是 .json 直链，不是网页`);
    }
    const list = Array.isArray(data)
        ? data
        : (Array.isArray(data?.sources) ? data.sources
            : (Array.isArray(data?.bookSources) ? data.bookSources : null));
    if (!list) throw new Error('JSON 里没找到书源数组（应当是一个数组，或 { sources: [...] }）');
    return list;
}

function groupOf(source) {
    const raw = String(source?.bookSourceGroup ?? source?.group ?? '').trim();
    return raw || '（未分组）';
}

/** 分组名匹配：Legado 的分组常用逗号 / 顿号分隔，这里按段比对，整串相等也算命中 */
function groupMatches(source, wanted) {
    if (!wanted) return true;
    const whole = String(source?.bookSourceGroup ?? source?.group ?? '').trim();
    if (!whole) return false;
    if (whole === wanted) return true;
    return whole.split(/[,，、|]/).map(part => part.trim()).some(part => part === wanted);
}

/**
 * 统计 + 筛选。
 * keyword 同时匹配 名称 / 分组 / 站点地址；group 是分组精确匹配；limit <= 0 表示全部（受 MAX_IMPORT_LIMIT 兜底）。
 */
export function summarizeCollection(text, {
    keyword = '', group = '', limit = 50, offset = 0, withSources = true,
} = {}) {
    const list = parseSourceCollection(text);
    const total = list.length;
    const groupMap = new Map();
    for (const source of list) {
        const name = groupOf(source);
        groupMap.set(name, (groupMap.get(name) || 0) + 1);
    }
    const groups = [...groupMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 80)
        .map(([name, count]) => ({ name, count }));

    const wantedGroup = String(group ?? '').trim();
    const key = String(keyword ?? '').trim().toLowerCase();
    let matched = list;
    if (wantedGroup) matched = matched.filter(source => groupMatches(source, wantedGroup));
    if (key) {
        matched = matched.filter(source => (
            String(source?.bookSourceName ?? source?.name ?? '').toLowerCase().includes(key)
            || String(source?.bookSourceUrl ?? source?.url ?? '').toLowerCase().includes(key)
            || groupOf(source).toLowerCase().includes(key)
        ));
    }

    const start = Math.max(0, Math.round(Number(offset) || 0));
    const requested = Number(limit);
    // 0 / 负数 = 全部；正数就按它，但不超过内存兜底
    const take = requested > 0 ? Math.min(MAX_IMPORT_LIMIT, Math.round(requested)) : matched.length;

    const result = {
        total,
        groupCount: groupMap.size,
        groups,
        matched: matched.length,
        limit: requested > 0 ? take : 0,
        all: requested <= 0,
        offset: start,
    };
    if (withSources) result.sources = matched.slice(start, start + take);
    return result;
}
