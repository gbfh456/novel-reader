/**
 * 小说阅读器 - 通用工具
 * 无第三方依赖，所有函数均可直接在浏览器 / Node 中运行。
 */

/** 数值夹取 */
export function clamp(value, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, n));
}

/** 按 Unicode 码位统计字符数（中文 1 个汉字 = 1） */
export function countChars(text) {
    if (!text) return 0;
    let count = 0;
    for (const _ of text) count++;
    return count;
}

/**
 * 保守估算 token 数。
 * 中文按 1.15 token/字，英文按 0.28 token/字符，其它按 0.8。
 * 故意略高估，给上下文预算留安全余量。
 */
export function estimateTokens(text) {
    if (!text) return 0;
    let cjk = 0;
    let ascii = 0;
    let other = 0;
    for (const ch of text) {
        const cp = ch.codePointAt(0);
        if (cp < 128) {
            if (cp === 32 || cp === 9 || cp === 10 || cp === 13) continue;
            ascii++;
        } else if (
            (cp >= 0x4e00 && cp <= 0x9fff) ||
            (cp >= 0x3400 && cp <= 0x4dbf) ||
            (cp >= 0xf900 && cp <= 0xfaff) ||
            (cp >= 0x3040 && cp <= 0x30ff) ||
            (cp >= 0xac00 && cp <= 0xd7af)
        ) {
            cjk++;
        } else if ((cp >= 0x3000 && cp <= 0x303f) || (cp >= 0xff00 && cp <= 0xffef)) {
            other++;
        } else {
            other++;
        }
    }
    return Math.ceil(cjk * 1.15 + ascii * 0.28 + other * 0.8) + 4;
}

/** HTML 转义 */
export function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** 生成唯一 id */
export function uuid() {
    try {
        if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    } catch {
        // ignore
    }
    return `nr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 等待若干毫秒 */
export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 让出主线程，避免大文件解析 / 批量读写时页面假死。
 * 使用 MessageChannel 而不是 setTimeout：后台标签页里定时器会被节流到 1 秒，
 * 而 MessageChannel 的宏任务不受该节流影响。
 */
export function yieldToUI() {
    if (typeof MessageChannel === 'function') {
        return new Promise(resolve => {
            const channel = new MessageChannel();
            channel.port1.onmessage = () => {
                channel.port1.close();
                resolve();
            };
            channel.port2.postMessage(null);
        });
    }
    return new Promise(resolve => setTimeout(resolve, 0));
}

/**
 * 以固定并发跑一组任务；不抛出 worker 的错误（由 worker 自己记录），
 * 返回每个任务的结果数组。用于世界书整理、查重复核这类可失败隔离的批处理。
 */
export async function mapLimit(items, limit, worker) {
    const list = Array.from(items || []);
    const size = Math.max(1, Math.min(Math.floor(Number(limit) || 1), Math.max(1, list.length)));
    const results = new Array(list.length);
    let cursor = 0;
    const runners = Array.from({ length: size }, async () => {
        while (true) {
            const index = cursor++;
            if (index >= list.length) return;
            results[index] = await worker(list[index], index);
        }
    });
    await Promise.all(runners);
    return results;
}

/** 防抖 */
export function debounce(fn, wait = 300) {
    let timer = null;
    const wrapped = (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), wait);
    };
    wrapped.cancel = () => clearTimeout(timer);
    return wrapped;
}

/** 数字显示：12345 -> 1.2 万 */
export function formatCount(num) {
    const n = Number(num) || 0;
    if (n >= 100000000) return `${(n / 100000000).toFixed(2)} 亿`;
    if (n >= 10000) return `${(n / 10000).toFixed(n >= 100000 ? 0 : 1)} 万`;
    return String(n);
}

/** 格式化为本地时间 */
export function formatTime(ts) {
    try {
        return new Date(ts).toLocaleString('zh-CN', { hour12: false });
    } catch {
        return '';
    }
}

/**
 * 在句末 / 段落边界处安全截断，保证不超过 maxChars。
 * 返回的文本长度一定 <= maxChars（含省略号）。
 */
export function trimToLimit(text, maxChars) {
    const source = String(text ?? '');
    const max = Math.max(1, Math.floor(maxChars));
    if (countChars(source) <= max) return source;
    const chars = Array.from(source).slice(0, max);
    const sliced = chars.join('');
    const boundary = Math.max(
        sliced.lastIndexOf('。'),
        sliced.lastIndexOf('！'),
        sliced.lastIndexOf('？'),
        sliced.lastIndexOf('!'),
        sliced.lastIndexOf('?'),
        sliced.lastIndexOf('.'),
        sliced.lastIndexOf('\n'),
    );
    let body = boundary >= Math.floor(max * 0.55) ? sliced.slice(0, boundary + 1) : sliced;
    body = body.trimEnd();
    if (countChars(body) >= max) body = Array.from(body).slice(0, max - 1).join('');
    return `${body}…`;
}

/** 清理模型输出中的前言、思考块、代码围栏等 */
export function cleanModelOutput(input) {
    let out = String(input ?? '').replace(/\r\n?/g, '\n').trim();
    if (!out) return '';

    // 思考块（不同推理模型的常见标签）
    out = out.replace(/<(think|thinking|reasoning|analysis)\b[^>]*>[\s\S]*?<\/\1>/gi, '');

    // Markdown 代码围栏
    out = out.replace(/^\s*```[^\n]*\n?/gm, '').replace(/^\s*```\s*$/gm, '');

    // 开头客套话
    out = out.replace(
        /^\s*(?:好的|当然|没问题|可以的|以下是|这是|根据要求|遵命)[^\n]{0,40}[：:，,。]\s*\n*/,
        '',
    );

    // 开头的小标题
    out = out.replace(/^\s*【?(?:剧情|内容|小说)?(?:摘要|总结|概要|概括)】?\s*[：:]?\s*\n*/, '');

    // 结尾的“希望以上内容对你有帮助”之类
    out = out.replace(/\n*\s*(?:希望|以上).{0,40}(?:有帮助|满意)[。！!]?\s*$/, '');

    out = out.replace(/\n{3,}/g, '\n\n');
    return out.trim();
}

/** 复制文本到剪贴板；剪贴板 API 不可用时退回 execCommand */
export async function copyText(text) {
    const value = String(text ?? '');
    if (!value) return false;
    try {
        if (globalThis.navigator?.clipboard?.writeText) {
            await globalThis.navigator.clipboard.writeText(value);
            return true;
        }
    } catch {
        // 退回下面的隐藏输入框
    }
    try {
        const helper = document.createElement('textarea');
        helper.value = value;
        helper.setAttribute('readonly', 'readonly');
        helper.style.position = 'fixed';
        helper.style.opacity = '0';
        document.body.appendChild(helper);
        helper.select();
        const ok = document.execCommand('copy');
        helper.remove();
        return ok;
    } catch {
        return false;
    }
}

/** 下载文本文件 */
export function downloadText(filename, text) {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** 文件名安全化 */
export function safeFileName(name) {
    return String(name || '小说总结')
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80) || '小说总结';
}

/** 是否是“取消”异常 */
export function isAbortError(error) {
    return error?.name === 'AbortError' || /已取消|cancelled|aborted/i.test(String(error?.message || ''));
}

/** 构造取消异常 */
export function createAbortError() {
    const error = new Error('已取消');
    error.name = 'AbortError';
    return error;
}
