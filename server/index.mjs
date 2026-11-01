/**
 * fanqie-bridge — SillyTavern 服务端插件
 *
 * 给「小说阅读器」的找书页 → 番茄小说 做同源桥接：
 *   浏览器（酒馆）直连本地番茄下载器会被跨域拦下 —— 下载器不带 CORS 头，OPTIONS 预检直接 405。
 *   这里在酒馆同源下转发一遍：
 *
 *     GET  /api/plugins/fanqie-bridge/health            桥接 + 下载器是否活着
 *     GET  /api/plugins/fanqie-bridge/search?q=         下载器 /api/search
 *     GET  /api/plugins/fanqie-bridge/preview/:bookId   下载器 /api/preview/:bookId
 *     POST /api/plugins/fanqie-bridge/jobs              建下载任务（book_id / range_start / range_end）
 *     GET  /api/plugins/fanqie-bridge/jobs[?id=N]       任务详情 / 列表
 *     POST /api/plugins/fanqie-bridge/jobs/:id/cancel   取消任务
 *     GET  /api/plugins/fanqie-bridge/book-text?book_id=&title=
 *                                                       在下载器保存目录里按 book_id 找到整本 txt 并回传
 *
 * 上游只允许本机回环（防 SSRF）：默认 http://127.0.0.1:18423，
 * 可用环境变量 FANQIE_BRIDGE_UPSTREAM，或前端带 X-Fanqie-Upstream 头（同样只允许回环）逐次覆盖。
 *
 * **自动托管下载器**：默认会自己找本机的 TomatoNovelDownloader 可执行文件，需要时（/health?ensure=1）
 * 把它复制到可执行目录并 spawn 起来，酒馆退出时一并关掉 —— 这样只用启动酒馆，不用手动另起下载器。
 * 可执行文件路径 / 数据目录 / 是否自动启动，都可用 plugins/fanqie-bridge/config.json 或环境变量覆盖：
 *   FANQIE_BRIDGE_DOWNLOADER=...   FANQIE_BRIDGE_AUTOSTART=0   FANQIE_BRIDGE_PORT=18423
 *   FANQIE_BRIDGE_DATA_DIR=...
 *
 * 安装：把本目录放到 <SillyTavern>/plugins/fanqie-bridge/，config.yaml 里 enableServerPlugins: true，
 * 重启酒馆；日志出现 “Initializing plugin from .../plugins/fanqie-bridge/index.mjs” 即生效。
 */

import { spawn } from 'node:child_process';
import { fetchSourceText, summarizeCollection, isAllowedSourceUrl, describeSourceFetchFailure, MAX_IMPORT_LIMIT } from './source-fetch.mjs';
import {
    clearCookies,
    dumpCookies,
    fetchUrl,
    getCookieHeader,
    getLoginHeader,
    isAllowedTarget,
    putLoginHeader,
    setCookieRaw,
} from './http.mjs';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '1.3.0';
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = process.cwd();
/** 托管进程句柄（只在「桥接自己拉起的」情况下非空） */
let managedChild = null;
let managedBinary = '';
let startingPromise = null;
let lastStartError = '';
/** 最近一次实际启动的二进制路径（只用于回报文件名） */
let lastBinary = '';
/** ensureRunnableCopy 生成的临时目录，退出时删掉（9MB 的二进制副本别一直堆在 /tmp） */
let tempDir = '';
const DEFAULT_UPSTREAM = 'http://127.0.0.1:18423';
const UPSTREAM = normalizeUpstream(process.env.FANQIE_BRIDGE_UPSTREAM) || DEFAULT_UPSTREAM;
/** 单次转发超时（毫秒）；整本正文可能几 MB，给宽一点 */
const REQUEST_TIMEOUT_MS = 120_000;
/** /book-text 最多回传多少字节 */
const MAX_TEXT_BYTES = 64 * 1024 * 1024;
/** 找 txt 时只读文件头，用来匹配 book_id=… */
const HEAD_BYTES = 4096;

export const info = {
    id: 'fanqie-bridge',
    name: 'Fanqie Novel Bridge',
    description: 'Same-origin bridge between the Novel Reader extension and a local Tomato Novel Downloader (search / preview / download jobs / book text).',
};

/** 规范上游地址：只接受 http(s)，去掉尾部斜杠；不合法返回空串 */
function normalizeUpstream(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
        const url = new URL(raw);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
        return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
    } catch {
        return '';
    }
}

/** 上游必须落在本机回环 */
function isLoopback(upstream) {
    try {
        const { hostname } = new URL(upstream);
        const host = hostname.replace(/^\[|\]$/g, '');
        return host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1' || /^127\./.test(host);
    } catch {
        return false;
    }
}

function fail(response, status, message, code = '') {
    return response.status(status).json({ ok: false, error: message, code });
}

/** 取本次请求要用的上游地址 */
function upstreamFor(request) {
    const header = normalizeUpstream(request.get('x-fanqie-upstream'));
    if (!header) return UPSTREAM;
    if (!isLoopback(header)) return '';
    return header;
}

async function upstreamFetch(upstream, pathAndQuery, { method = 'GET', body } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('上游超时')), REQUEST_TIMEOUT_MS);
    try {
        const init = {
            method,
            signal: controller.signal,
            headers: { Accept: 'application/json,text/plain,*/*' },
        };
        if (body !== undefined) {
            init.headers['Content-Type'] = 'application/json';
            init.body = JSON.stringify(body);
        }
        const response = await fetch(`${upstream}${pathAndQuery}`, init);
        const text = await response.text();
        return { ok: response.ok, status: response.status, text };
    } finally {
        clearTimeout(timer);
    }
}

/** 把上游 JSON 原样回给浏览器；4xx 保留状态码，其余包成 502 */
function relayJson(response, result, what) {
    if (!result.ok) {
        let message = `下载器返回 ${result.status}`;
        try {
            const parsed = JSON.parse(result.text);
            if (parsed && typeof parsed.error === 'string' && parsed.error) message = parsed.error;
        } catch {
            // 不是 JSON，保持状态码文案
        }
        if (result.status === 404) return fail(response, 404, `${what}：下载器没有这个对象`, 'UPSTREAM_NOT_FOUND');
        if (result.status >= 400 && result.status < 500) {
            return fail(response, result.status, `${what}：${message}`, 'UPSTREAM_REJECTED');
        }
        return fail(response, 502, `${what}：${message}`, 'UPSTREAM_ERROR');
    }
    try {
        return response.status(200).json(JSON.parse(result.text));
    } catch {
        return fail(response, 502, `${what}：下载器返回的不是 JSON（确认上游地址是下载器的 Web 服务）`, 'UPSTREAM_BAD_BODY');
    }
}

function relayError(response, error, what) {
    const message = error?.message || String(error || '');
    if (error?.name === 'AbortError' || /超时|aborted/i.test(message)) {
        return fail(response, 504, `${what}：下载器没在 ${Math.round(REQUEST_TIMEOUT_MS / 1000)} 秒内回应`, 'UPSTREAM_TIMEOUT');
    }
    return fail(response, 502, `${what}：连不上下载器（${message}）`, 'UPSTREAM_UNREACHABLE');
}

/** 只保留下载目录内的相对路径，挡住 ../ 之类的穿越 */
function safeJoin(root, relPath) {
    const resolvedRoot = path.resolve(root);
    const target = path.resolve(resolvedRoot, relPath);
    if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) return '';
    return target;
}

/** 读文件头，判断这份 txt 是不是这本书（下载器会在头部写 book_id=…） */
async function textBelongsTo(filePath, bookId) {
    let handle = null;
    try {
        handle = await fs.open(filePath, 'r');
        const buffer = Buffer.alloc(HEAD_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
        const head = buffer.subarray(0, bytesRead).toString('utf8');
        if (!bookId) return head.includes('书名：') || head.includes('书名:');
        return head.includes(`book_id=${bookId}`);
    } catch {
        return false;
    } finally {
        await handle?.close().catch(() => {});
    }
}

/**
 * 在下载器的保存目录里找到这本书的整本 txt。
 * 下载器有两种落盘位置：单文件写在 save_dir 根目录，缓存/散装模式在 <save_dir>/<book_id>/。
 */
async function findBookFile({ root, bookId, title }) {
    const dirs = [root, safeJoin(root, bookId)].filter(Boolean);
    const files = [];
    for (const dir of dirs) {
        const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            if (!entry.isFile()) continue;
            if (!/\.(txt|TXT)$/.test(entry.name)) continue;
            const full = safeJoin(dir, entry.name);
            if (!full) continue;
            if (files.some(file => file.full === full)) continue;
            const stat = await fs.stat(full).catch(() => null);
            if (!stat) continue;
            files.push({ name: entry.name, full, size: stat.size, mtime: stat.mtimeMs });
        }
    }
    files.sort((left, right) => right.mtime - left.mtime);

    for (const file of files) {
        if (await textBelongsTo(file.full, bookId)) return file;
    }
    if (title) {
        const cleaned = String(title).replace(/[\\/:*?"<>|]/g, '').trim();
        const hit = files.find(file => path.basename(file.name, path.extname(file.name)) === cleaned)
            || files.find(file => file.name.includes(cleaned.slice(0, 12)));
        if (hit) return hit;
    }
    return null;
}

/* ------------------------------------------------------------------ */
/* 托管下载器                                                          */
/* ------------------------------------------------------------------ */

/** 插件配置：config.json 打底，环境变量覆盖 */
async function loadConfig() {
    const defaults = {
        autostart: true,
        port: 18423,
        dataDir: path.join(SERVER_ROOT, 'data', 'fanqie-bridge'),
        downloader: '',
    };
    let fileConfig = {};
    try {
        const raw = await fs.readFile(path.join(MODULE_DIR, 'config.json'), 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') fileConfig = parsed;
    } catch {
        fileConfig = {};
    }
    const env = process.env;
    const config = {
        autostart: String(env.FANQIE_BRIDGE_AUTOSTART ?? fileConfig.autostart ?? defaults.autostart) !== '0'
            && String(env.FANQIE_BRIDGE_AUTOSTART ?? fileConfig.autostart ?? defaults.autostart) !== 'false',
        port: Math.max(1, Math.min(65535, Number(env.FANQIE_BRIDGE_PORT || fileConfig.port || defaults.port) || defaults.port)),
        dataDir: String(env.FANQIE_BRIDGE_DATA_DIR || fileConfig.dataDir || defaults.dataDir),
        downloader: String(env.FANQIE_BRIDGE_DOWNLOADER || fileConfig.downloader || defaults.downloader),
    };
    if (!path.isAbsolute(config.dataDir)) config.dataDir = path.join(SERVER_ROOT, config.dataDir);
    return config;
}

/** 常见位置里找 TomatoNovelDownloader 可执行文件 */
async function findDownloader(config) {
    const explicit = String(config.downloader || '').trim();
    if (explicit) return fsSync.existsSync(explicit) ? explicit : '';
    // 只认「随扩展/插件一起装」的位置，不再去 ~/fanqie 之类的老文件夹里翻
    const moduleParent = path.dirname(MODULE_DIR);
    const dirs = [
        // 服务端实现就在 <仓库>/server/ 里，二进制在 <仓库>/tools/ 或 <仓库>/bin/
        path.join(moduleParent, 'tools'),
        path.join(moduleParent, 'bin'),
        path.join(MODULE_DIR, 'tools'),
        path.join(MODULE_DIR, 'bin'),
        // 装在酒馆里的扩展目录（全局装 / 按用户装）
        path.join(SERVER_ROOT, 'public', 'scripts', 'extensions', 'third-party', 'novel-reader', 'tools'),
        path.join(SERVER_ROOT, 'data', 'default-user', 'extensions', 'novel-reader', 'tools'),
    ];
    for (const dir of dirs) {
        let entries = [];
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (!entry.isFile() && !entry.isSymbolicLink()) continue;
            if (!/TomatoNovelDownloader/i.test(entry.name)) continue;
            const full = path.join(dir, entry.name);
            try {
                await fs.access(full, fsSync.constants.R_OK);
                return full;
            } catch {
                // 下一个
            }
        }
    }
    return '';
}

/**
 * 托管实例的数据目录里确保「输出单文件 txt」：
 * /book-text 是按 txt 找书的，下载器默认可能是 epub。
 * 只改 novel_format / bulk_files 两行，其它配置原样保留。
 */
async function ensureDownloaderConfig(dataDir) {
    const configPath = path.join(dataDir, 'config.yml');
    let text = '';
    try {
        text = await fs.readFile(configPath, 'utf8');
    } catch {
        text = '';
    }
    if (!text.trim()) {
        await fs.writeFile(configPath, 'old_cli: false\nnovel_format: txt\nbulk_files: false\n', 'utf8');
        return;
    }
    const patchLine = (source, key, value) => {
        const re = new RegExp(`^(${key}\\s*:).*$`, 'm');
        if (re.test(source)) return source.replace(re, `$1 ${value}`);
        return `${source.replace(/\s*$/, '')}\n${key}: ${value}\n`;
    };
    let next = patchLine(text, 'novel_format', 'txt');
    next = patchLine(next, 'bulk_files', 'false');
    if (next !== text) {
        await fs.writeFile(configPath, next, 'utf8');
        console.log('[fanqie-bridge] 已把下载器输出改成单文件 txt（novel_format / bulk_files）');
    }
}

/**
 * 把二进制复制到可执行目录：sdcard 之类的挂载点通常 noexec，
 * 直接 spawn 会 EACCES，所以先复制到 tmp 再执行。
 */
async function ensureRunnableCopy(binaryPath) {
    if (managedBinary && fsSync.existsSync(managedBinary)) return managedBinary;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fanqie-bridge-'));
    tempDir = dir;
    const target = path.join(dir, path.basename(binaryPath) || 'TomatoNovelDownloader');
    await fs.copyFile(binaryPath, target);
    await fs.chmod(target, 0o755);
    managedBinary = target;
    return target;
}

/** 探一下下载器的 /api/status */
async function probeDownloader(upstream, timeoutMs = 1500) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('探测超时')), Math.max(300, timeoutMs));
    try {
        const response = await fetch(`${upstream}/api/status`, { signal: controller.signal });
        if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
        return { ok: true, status: await response.json() };
    } catch (error) {
        return { ok: false, error: error?.message || '连不上' };
    } finally {
        clearTimeout(timer);
    }
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** 拉起下载器并等它响应 */
async function startDownloader({ upstream, config }) {
    const binary = await findDownloader(config);
    if (!binary) {
        throw new Error('没找到 TomatoNovelDownloader：把可执行文件放进 novel-reader/tools/ 或 plugins/fanqie-bridge/bin/，或在 plugins/fanqie-bridge/config.json 里写 downloader 路径');
    }
    lastBinary = binary;
    const runnable = await ensureRunnableCopy(binary);
    console.log(`[fanqie-bridge] 启动下载器：${binary}`);
    await fs.mkdir(config.dataDir, { recursive: true });
    await ensureDownloaderConfig(config.dataDir);
    const port = new URL(upstream).port || String(config.port);
    const child = spawn(runnable, ['--server', '--data-dir', config.dataDir], {
        // cwd 决定下载器的默认保存目录（save_path 为空时就是它），别让它把书吐到酒馆根目录
        cwd: config.dataDir,
        env: { ...process.env, TOMATO_WEB_ADDR: `127.0.0.1:${port}` },
        detached: true,
        stdio: 'ignore',
    });
    child.on('error', error => {
        lastStartError = error?.message || String(error);
        console.error(`[fanqie-bridge] 启动下载器失败：${lastStartError}`);
    });
    child.on('exit', () => {
        if (managedChild === child) managedChild = null;
    });
    child.unref();
    managedChild = child;

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        const probe = await probeDownloader(upstream, 1200);
        if (probe.ok) return probe.status;
        await wait(300);
    }
    throw new Error(`下载器起来了但 ${Math.round(port)} 端口 15 秒内没响应${lastStartError ? `（${lastStartError}）` : ''}`);
}

/**
 * 确保下载器可用：先探活；需要且允许自动启动时，把下载器拉起来。
 * @returns {Promise<{reachable:boolean,status?:object,managed:boolean,hint?:string}>}
 */
async function ensureDownloader({ upstream, timeoutMs = 12_000, allowStart = false }) {
    const config = await loadConfig();
    const quick = await probeDownloader(upstream, 1200);
    if (quick.ok) return { reachable: true, status: quick.status, managed: Boolean(managedChild), config };

    if (!allowStart) {
        return {
            reachable: false,
            managed: Boolean(managedChild),
            config,
            hint: config.autostart
                ? '下载器没在跑：打开找书页搜一次（或点「启动下载器」）会自动拉起'
                : '下载器没在跑，而且配置里关掉了自动启动（autostart=false）',
        };
    }
    if (!config.autostart) {
        return { reachable: false, managed: Boolean(managedChild), config, hint: '下载器没在跑，而且配置里关掉了自动启动（autostart=false）' };
    }

    if (!startingPromise) {
        startingPromise = startDownloader({ upstream, config }).finally(() => {
            startingPromise = null;
        });
    }
    const deadline = Date.now() + Math.max(1000, timeoutMs);
    try {
        await startingPromise;
    } catch (error) {
        return { reachable: false, managed: Boolean(managedChild), config, hint: error?.message || '下载器启动失败' };
    }
    while (Date.now() < deadline) {
        const probe = await probeDownloader(upstream, 1200);
        if (probe.ok) return { reachable: true, status: probe.status, managed: Boolean(managedChild), config };
        await wait(250);
    }
    return { reachable: false, managed: Boolean(managedChild), config, hint: '下载器启动后没响应' };
}

/** 下载目录里这本书的其它格式（epub/pdf），用来给出更准确的提示 */
async function listOtherFormats(root, bookId) {
    const dirs = [root, safeJoin(root, bookId)].filter(Boolean);
    const found = [];
    for (const dir of dirs) {
        const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            if (!entry.isFile()) continue;
            const match = entry.name.match(/\.(epub|pdf|mobi|azw3?)$/i);
            if (!match) continue;
            const full = safeJoin(dir, entry.name);
            if (!full) continue;
            if (bookId) {
                const head = await fs.readFile(full).then(buffer => buffer.subarray(0, 4096).toString('utf8')).catch(() => '');
                const named = entry.name.includes(bookId);
                if (!named && !head.includes(`book_id=${bookId}`) && !head.includes(bookId)) continue;
            }
            found.push(match[1].toLowerCase());
        }
    }
    return [...new Set(found)];
}

/** 扩展目录 = server/ 的上一级；给面板显示安装/卸载命令用 */
function installInfo(config) {
    const extensionDir = path.resolve(MODULE_DIR, '..');
    const quote = value => `"${String(value).replace(/"/g, '\\"')}"`;
    return {
        serverRoot: SERVER_ROOT,
        extensionDir,
        dataDir: config?.dataDir || '',
        paths: {
            installServer: path.join(extensionDir, 'install-server.sh'),
            uninstall: path.join(extensionDir, 'uninstall.sh'),
            setup: path.join(extensionDir, 'setup.mjs'),
        },
        commands: {
            // 绝对路径命令：复制到宿主机终端即可用
            installServer: `bash ${quote(path.join(extensionDir, 'install-server.sh'))} ${quote(SERVER_ROOT)}`,
            uninstall: `bash ${quote(path.join(extensionDir, 'uninstall.sh'))} ${quote(SERVER_ROOT)}`,
        },
    };
}

/**
 * 收尾：杀掉自己拉起来的下载器 + 删掉临时目录。
 * 用户数据（<酒馆>/data/fanqie-bridge/）不在这里，永远不动。
 */
export async function exit() {
    if (managedChild) {
        try {
            managedChild.kill('SIGTERM');
        } catch {
            // 忽略
        }
        managedChild = null;
    }
    if (tempDir) {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
        tempDir = '';
    }
}

/** 启动时清掉上次没删干净的临时副本（超过 1 天的 fanqie-bridge-*） */
async function pruneStaleTempDirs() {
    const root = os.tmpdir();
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    const deadline = Date.now() - 24 * 60 * 60 * 1000;
    for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith('fanqie-bridge-')) continue;
        const full = path.join(root, entry.name);
        const stat = await fs.stat(full).catch(() => null);
        if (!stat || stat.mtimeMs > deadline) continue;
        await fs.rm(full, { recursive: true, force: true }).catch(() => {});
    }
}

export async function init(router) {
    pruneStaleTempDirs().catch(() => {});
    // 轻量存活探测：不依赖番茄下载器，用来确认「插件是否加载 / 是否是新版」
    router.get('/ping', async (request, response) => {
        return response.json({
            ok: true,
            version: VERSION,
            features: ['fetch', 'fetch-batch', 'cookie', 'source-fetch'],
        });
    });

    router.get('/health', async (request, response) => {
        const upstream = upstreamFor(request);
        if (!upstream) return fail(response, 400, '下载器地址必须是本机回环地址', 'BAD_UPSTREAM');
        const ensure = String(request.query.ensure || '') === '1';
        const timeout = Math.max(1000, Math.min(30_000, Number(request.query.timeout) || 12_000));
        try {
            const result = await ensureDownloader({ upstream, timeoutMs: timeout, allowStart: ensure });
            const info = installInfo(result.config);
            if (!result.reachable) {
                return response.status(503).json({
                    ok: false,
                    error: result.hint || '下载器没在跑',
                    code: 'DOWNLOADER_DOWN',
                    autostart: Boolean(result.config?.autostart),
                    managed: Boolean(result.managed),
                    dataDir: info.dataDir,
                    serverRoot: info.serverRoot,
                    extensionDir: info.extensionDir,
                    paths: info.paths,
                    commands: info.commands,
                });
            }
            const status = result.status || {};
            return response.json({
                ok: true,
                version: VERSION,
                upstream,
                binary: lastBinary ? path.basename(lastBinary) : '',
                dataDir: info.dataDir,
                serverRoot: info.serverRoot,
                extensionDir: info.extensionDir,
                managed: Boolean(result.managed),
                autostart: Boolean(result.config?.autostart),
                paths: info.paths,
                commands: info.commands,
                downloader: {
                    version: status.version || '',
                    saveDir: status.save_dir || '',
                    locked: Boolean(status.locked),
                    reachable: true,
                },
            });
        } catch (error) {
            return relayError(response, error, '健康检查失败');
        }
    });

    // 手动「启动下载器」：和 /health?ensure=1 等价，方便排查
    router.post('/start', async (request, response) => {
        const upstream = upstreamFor(request);
        if (!upstream) return fail(response, 400, '下载器地址必须是本机回环地址', 'BAD_UPSTREAM');
        const result = await ensureDownloader({ upstream, timeoutMs: 15_000, allowStart: true });
        if (!result.reachable) return fail(response, 503, result.hint || '下载器启动失败', 'DOWNLOADER_DOWN');
        return response.json({ ok: true, managed: Boolean(result.managed), upstream });
    });

    router.get('/search', async (request, response) => {
        const query = String(request.query.q || '').trim();
        if (!query) return fail(response, 400, '缺少搜索关键词 q', 'BAD_REQUEST');
        const upstream = upstreamFor(request);
        if (!upstream) return fail(response, 400, '下载器地址必须是本机回环地址', 'BAD_UPSTREAM');
        try {
            const result = await upstreamFetch(upstream, `/api/search?q=${encodeURIComponent(query)}`);
            return relayJson(response, result, '番茄搜索');
        } catch (error) {
            return relayError(response, error, '番茄搜索失败');
        }
    });

    router.get('/preview/:bookId', async (request, response) => {
        const bookId = String(request.params.bookId || '').trim();
        if (!/^\d{6,}$/.test(bookId)) return fail(response, 400, 'book_id 不合法', 'BAD_REQUEST');
        const upstream = upstreamFor(request);
        if (!upstream) return fail(response, 400, '下载器地址必须是本机回环地址', 'BAD_UPSTREAM');
        try {
            const result = await upstreamFetch(upstream, `/api/preview/${encodeURIComponent(bookId)}`);
            return relayJson(response, result, '番茄书目');
        } catch (error) {
            return relayError(response, error, '番茄书目获取失败');
        }
    });

    router.post('/jobs', async (request, response) => {
        const body = request.body && typeof request.body === 'object' ? request.body : {};
        const bookId = String(body.book_id || '').trim();
        if (!/^\d{6,}$/.test(bookId)) return fail(response, 400, 'book_id 不合法', 'BAD_REQUEST');
        const payload = { book_id: bookId };
        for (const key of ['range_start', 'range_end']) {
            const value = Number(body[key]);
            if (Number.isFinite(value) && value > 0) payload[key] = Math.floor(value);
        }
        const upstream = upstreamFor(request);
        if (!upstream) return fail(response, 400, '下载器地址必须是本机回环地址', 'BAD_UPSTREAM');
        try {
            const result = await upstreamFetch(upstream, '/api/jobs', { method: 'POST', body: payload });
            return relayJson(response, result, '创建番茄下载任务');
        } catch (error) {
            return relayError(response, error, '创建番茄下载任务失败');
        }
    });

    router.get('/jobs', async (request, response) => {
        const upstream = upstreamFor(request);
        if (!upstream) return fail(response, 400, '下载器地址必须是本机回环地址', 'BAD_UPSTREAM');
        const id = String(request.query.id || '').trim();
        const suffix = id ? `?id=${encodeURIComponent(id)}` : '';
        try {
            const result = await upstreamFetch(upstream, `/api/jobs${suffix}`);
            return relayJson(response, result, '番茄任务');
        } catch (error) {
            return relayError(response, error, '番茄任务查询失败');
        }
    });

    router.post('/jobs/:id/cancel', async (request, response) => {
        const id = String(request.params.id || '').trim();
        if (!/^\d+$/.test(id)) return fail(response, 400, '任务号不合法', 'BAD_REQUEST');
        const upstream = upstreamFor(request);
        if (!upstream) return fail(response, 400, '下载器地址必须是本机回环地址', 'BAD_UPSTREAM');
        try {
            const result = await upstreamFetch(upstream, `/api/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
            if (result.status === 200) return response.json({ ok: true });
            return relayJson(response, result, '取消番茄任务');
        } catch (error) {
            return relayError(response, error, '取消番茄任务失败');
        }
    });

    router.get('/book-text', async (request, response) => {
        const bookId = String(request.query.book_id || '').trim();
        const title = String(request.query.title || '').trim();
        if (!/^\d{6,}$/.test(bookId)) return fail(response, 400, 'book_id 不合法', 'BAD_REQUEST');
        const upstream = upstreamFor(request);
        if (!upstream) return fail(response, 400, '下载器地址必须是本机回环地址', 'BAD_UPSTREAM');
        try {
            const statusResult = await upstreamFetch(upstream, '/api/status');
            if (!statusResult.ok) return fail(response, 502, `下载器返回 ${statusResult.status}`, 'UPSTREAM_ERROR');
            const status = JSON.parse(statusResult.text);
            const root = String(status?.save_dir || '').trim();
            if (!root) return fail(response, 502, '下载器没报保存目录', 'NO_SAVE_DIR');

            const file = await findBookFile({ root, bookId, title });
            if (!file) {
                const others = await listOtherFormats(root, bookId);
                if (others.length) {
                    return fail(
                        response,
                        409,
                        `下载器输出的是 ${others.join(' / ')}，不是 txt：把数据目录 config.yml 的 novel_format 改成 txt、bulk_files 改成 false（桥接托管的实例会自动改）`,
                        'TEXT_NOT_TXT',
                    );
                }
                return fail(response, 404, '下载目录里还没这本书的 txt：等任务跑完，或先在下载器里下载一次', 'TEXT_NOT_FOUND');
            }
            if (file.size > MAX_TEXT_BYTES) {
                return fail(response, 413, `这本书的 txt 有 ${(file.size / 1024 / 1024).toFixed(0)} MB，太大，先分段下载`, 'TEXT_TOO_LARGE');
            }
            const text = await fs.readFile(file.full, 'utf8');
            response.set('Content-Type', 'text/plain; charset=utf-8');
            response.set('Content-Length', String(Buffer.byteLength(text)));
            return response.status(200).send(text);
        } catch (error) {
            return relayError(response, error, '取回番茄正文失败');
        }
    });

    /**
     * 书源集合抓取（订阅直链 / 书源 JSON 链接）
     *   POST { url, keyword?, group?, limit?, offset?, summary? }
     * 为什么放服务端：这类订阅地址多在 Cloudflare 后面，浏览器跨域读不到、酒馆 /api/search/visit 只接 HTML、
     * Node fetch 的 TLS 指纹又会被 CF 断连 —— 这里先 fetch 再退 curl，才拿得到 JSON。
     * summary=true 只回统计（总数 / 分组），否则附上按 keyword+limit 筛出来的 sources。
     */
    /* ---------------------- 书源抓取（通用） ---------------------- */

    router.post('/fetch', async (request, response) => {
        const body = request.body && typeof request.body === 'object' ? request.body : {};
        const url = String(body.url || '').trim();
        if (!isAllowedTarget(url)) return fail(response, 400, '只接受公网 http(s) 地址', 'BAD_URL');
        const method = String(body.method || 'GET').toUpperCase();
        if (!['GET', 'POST', 'HEAD'].includes(method)) return fail(response, 400, '不支持的请求方法', 'BAD_METHOD');
        try {
            const result = await fetchUrl({
                url,
                method,
                headers: body.headers && typeof body.headers === 'object' ? body.headers : {},
                body: body.body || '',
                timeout: body.timeout,
                charset: body.charset,
                sourceKey: body.sourceKey || '',
                useCookie: body.useCookie !== false,
            });
            return response.json({ ok: true, ...result });
        } catch (error) {
            const message = error?.name === 'AbortError' ? '抓取超时' : (error?.message || '抓取失败');
            return fail(response, 502, message, 'FETCH_FAILED');
        }
    });

    /**
     * 批量代抓：一次请求取多个页面，浏览器只需要一个往返。
     * 下载整本时用得上——单个 /fetch 的浏览器↔服务器开销比站点本身还大。
     */
    router.post('/fetch-batch', async (request, response) => {
        const body = request.body && typeof request.body === 'object' ? request.body : {};
        const list = Array.isArray(body.requests) ? body.requests.slice(0, 40) : [];
        if (!list.length) return fail(response, 400, '缺少 requests', 'BAD_REQUEST');
        const limit = Math.max(1, Math.min(16, Number(body.concurrency) || 6));
        const results = new Array(list.length);
        let cursor = 0;
        const worker = async () => {
            while (cursor < list.length) {
                const index = cursor++;
                const item = list[index] || {};
                const url = String(item.url || '').trim();
                if (!isAllowedTarget(url)) {
                    results[index] = { ok: false, error: '只接受公网 http(s) 地址', url };
                    continue;
                }
                try {
                    const result = await fetchUrl({
                        url,
                        method: String(item.method || 'GET').toUpperCase(),
                        headers: item.headers && typeof item.headers === 'object' ? item.headers : {},
                        body: item.body || '',
                        timeout: item.timeout,
                        charset: item.charset,
                        sourceKey: item.sourceKey || body.sourceKey || '',
                        useCookie: item.useCookie !== false,
                    });
                    results[index] = { ok: true, ...result };
                } catch (error) {
                    results[index] = { ok: false, url, error: error?.message || '抓取失败' };
                }
            }
        };
        try {
            await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
            return response.json({ ok: true, results });
        } catch (error) {
            return fail(response, 502, error?.message || '批量抓取失败', 'FETCH_FAILED');
        }
    });

    router.get('/cookie', async (request, response) => {
        const sourceKey = String(request.query.sourceKey || '').trim();
        if (!sourceKey) return fail(response, 400, '缺少 sourceKey', 'BAD_REQUEST');
        return response.json({
            ok: true,
            sourceKey,
            cookie: getCookieHeader(sourceKey, String(request.query.url || '')),
            loginHeader: getLoginHeader(sourceKey),
            items: dumpCookies(sourceKey),
        });
    });

    router.post('/cookie', async (request, response) => {
        const body = request.body && typeof request.body === 'object' ? request.body : {};
        const sourceKey = String(body.sourceKey || '').trim();
        if (!sourceKey) return fail(response, 400, '缺少 sourceKey', 'BAD_REQUEST');
        if (body.action === 'clear') {
            clearCookies(sourceKey);
            return response.json({ ok: true, cleared: true });
        }
        if (body.loginHeader != null) putLoginHeader(sourceKey, body.loginHeader);
        if (body.cookie != null && !setCookieRaw(sourceKey, body.cookie, body.url || sourceKey)) {
            return fail(response, 400, 'Cookie 内容为空', 'BAD_REQUEST');
        }
        return response.json({ ok: true, cookie: getCookieHeader(sourceKey) });
    });

    router.post('/source-fetch', async (request, response) => {
        const url = String(request.body?.url || '').trim();
        if (!isAllowedSourceUrl(url)) return fail(response, 400, '只接受公网 http(s) 的书源链接', 'BAD_URL');
        try {
            const text = await fetchSourceText(url);
            const summaryOnly = request.body?.summary === true;
            const result = summarizeCollection(text, {
                keyword: String(request.body?.keyword || ''),
                group: String(request.body?.group || ''),
                limit: request.body?.limit ?? 50,
                offset: request.body?.offset,
                withSources: !summaryOnly,
            });
            const payload = {
                ok: true,
                url,
                total: result.total,
                groupCount: result.groupCount,
                groups: result.groups,
                matched: result.matched,
                limit: result.limit,
                all: result.all,
                offset: result.offset,
                maxImport: MAX_IMPORT_LIMIT,
            };
            if (!summaryOnly) payload.sources = result.sources;
            return response.json(payload);
        } catch (error) {
            const hint = describeSourceFetchFailure(error);
            return fail(response, 502, hint.message, hint.code);
        }
    });
}
