#!/usr/bin/env node
/**
 * 小说阅读器安装/卸载脚本（Node 版，不依赖可执行位 —— 安卓 / sdcard 上 chmod +x 不生效时用这个）
 *
 *   node setup.mjs install-server [酒馆目录]
 *   node setup.mjs uninstall      [酒馆目录]
 *
 * 扩展本身从仓库下载时就已经在位了，所以这里只负责「补服务端桥接」和「卸载」。
 * 两个 .sh 只是一层壳：bash install-server.sh 等价于 node setup.mjs install-server
 * 酒馆目录默认：本仓库向上 5 层的酒馆根目录（扩展装在 public/scripts/extensions/third-party/novel-reader 时正好是它）
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [command = '', ...rest] = process.argv.slice(2);
const argDir = rest.find(item => !item.startsWith('-')) || process.env.SILLYTAVERN_DIR || '';
/** 从某个目录往上找酒馆根目录（认 config.yaml + server.js），最多 8 层 */
async function findServerRoot(from) {
    let dir = from;
    for (let i = 0; i < 8; i += 1) {
        const ok = await Promise.all(['config.yaml', 'server.js'].map(name =>
            fs.access(path.join(dir, name)).then(() => true).catch(() => false)));
        if (ok.every(Boolean)) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return '';
}
// 没给目录时先往上找酒馆根目录（按用户安装也能自动认出来），找不到再退回「向上 5 层」的老假设
const ST = path.resolve(argDir || (await findServerRoot(HERE)) || path.resolve(HERE, '../../../../..'));
const EXT = path.join(ST, 'public', 'scripts', 'extensions', 'third-party', 'novel-reader');
const PLUGIN = path.join(ST, 'plugins', 'novel-reader');
const LEGACY_PLUGIN = path.join(ST, 'plugins', 'fanqie-bridge');
const DATA = path.join(ST, 'data', 'fanqie-bridge');

const USAGE = `用法：
  node setup.mjs install-server [酒馆目录]   # 装服务端桥接（扩展已经在位）
  node setup.mjs uninstall      [酒馆目录]   # 卸载（保留用户数据）
也可以写成 bash install-server.sh / uninstall.sh（等价）。
`;

async function assertServerRoot() {
    for (const name of ['config.yaml', 'server.js']) {
        try {
            await fs.access(path.join(ST, name));
        } catch {
            throw new Error(`看起来不是酒馆根目录：${ST}\n${USAGE}`);
        }
    }
}

async function writeShim(baseExt) {
    const serverEntry = path.join(baseExt, 'server', 'index.mjs');
    const relative = path.relative(PLUGIN, serverEntry).split(path.sep).join('/');
    await fs.mkdir(PLUGIN, { recursive: true });
    const shim = [
        '// 由 setup.mjs / install-server.sh 生成：把酒馆插件加载器接到阅读器扩展自带的番茄桥接实现',
        `export * from '${relative}';`,
        '',
    ].join('\n');
    await fs.writeFile(path.join(PLUGIN, 'index.mjs'), shim, 'utf8');
    return { pluginDir: PLUGIN, serverEntry };
}

async function installServer() {
    await assertServerRoot();
    // 指向脚本所在的扩展目录本身：全局装在 public/…、按用户装在 data/<用户>/extensions/… 都能对上
    const result = await writeShim(HERE);
    console.log(`已创建：${path.join(result.pluginDir, 'index.mjs')}`);
    console.log(`  → 转发到 ${result.serverEntry}`);
    console.log('');
    console.log('下一步：重启酒馆。日志里应出现 Initializing plugin from '
        + `${path.join(result.pluginDir, 'index.mjs')}`);
    console.log('插件 id 是 fanqie-bridge，路由：/api/plugins/fanqie-bridge');
}

function runQuiet(file, args) {
    return new Promise(resolve => {
        execFile(file, args, { timeout: 5000 }, error => resolve(!error));
    });
}

async function uninstall() {
    await assertServerRoot();
    console.log('① 停掉桥接拉起的下载器进程');
    // 只杀本插件从临时目录拉起来的副本，不碰用户自己开的下载器
    await runQuiet('pkill', ['-f', 'fanqie-bridge-[A-Za-z0-9]*/TomatoNovelDownloader']);

    console.log('② 删除临时副本');
    const tmpRoot = os.tmpdir();
    const entries = await fs.readdir(tmpRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
        if (!entry.name.startsWith('fanqie-bridge-')) continue;
        await fs.rm(path.join(tmpRoot, entry.name), { recursive: true, force: true }).catch(() => {});
    }

    console.log('③ 删除服务端插件（含旧目录名）');
    await fs.rm(PLUGIN, { recursive: true, force: true });
    await fs.rm(LEGACY_PLUGIN, { recursive: true, force: true });

    console.log('④ 删除前端扩展');
    const targets = [EXT];
    // 按用户安装时，脚本自己就在 <酒馆>/data/<用户>/extensions/novel-reader 里，把那一个也删掉
    const dataPrefix = path.join(ST, 'data') + path.sep;
    if (path.resolve(HERE).startsWith(dataPrefix) && path.resolve(HERE) !== path.resolve(EXT)) {
        targets.push(HERE);
    }
    for (const target of targets) await fs.rm(target, { recursive: true, force: true });

    console.log('');
    console.log('已清理：扩展、服务端插件、临时副本');
    console.log(`保留的用户数据：${DATA}`);
    const exists = await fs.access(DATA).then(() => true).catch(() => false);
    console.log(exists
        ? '  （下载的书、config.yml、日志都在这里；不要就自己删掉）'
        : '  （还没有生成过）');
}

try {
    if (command === 'install-server') await installServer();
    else if (command === 'uninstall') await uninstall();
    else {
        console.log(USAGE);
        process.exitCode = command ? 1 : 0;
    }
} catch (error) {
    console.error(error?.message || String(error));
    process.exitCode = 1;
}
