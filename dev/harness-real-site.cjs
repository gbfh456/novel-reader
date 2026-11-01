/**
 * 真站点回归：http://www.gdbzkz.la/guimizhizhu/（诡秘之主）
 *
 * 这个站的目录是 `<dl><dt>卷名</dt><dd><a href ="...">第X章</a></dd>`，
 * 注意 `href =` 等号前有空格 —— 用「规则对不上」的书源打开它时，
 * 插件必须靠页面结构猜出目录，而不是报「没解析到章节」。
 *
 * 运行：NODE_PATH=/tmp/pwtest/node_modules node dev/harness-real-site.cjs
 * 没网时自动跳过（退出码 0），不会把离线当成失败。
 */
const { chromium } = require('playwright');
const EXE = '/root/.cache/ms-playwright/chromium-1248/chrome-linux-arm64/chrome';
const LIB = '/tmp/chromedeps/root/usr/lib/aarch64-linux-gnu';
const TARGET = 'http://www.gdbzkz.la/guimizhizhu/';
const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';
const results = [];
const check = (n, ok, x = '') => { results.push({ n, ok }); console.log(ok ? '✓' : '✗', n, x); };

async function fetchReal(url) {
    const response = await fetch(url, { headers: { 'User-Agent': UA, Referer: TARGET } });
    const text = await response.text();
    return { status: response.status, text };
}

(async () => {
    let probe;
    try {
        probe = await fetchReal(TARGET);
    } catch (error) {
        console.log(`跳过：连不上 ${TARGET}（${error.message}）`);
        process.exit(0);
    }
    if (!probe.text.includes('listmain')) {
        console.log('跳过：站点返回的不是书籍页（可能被反爬拦了）');
        process.exit(0);
    }
    console.log(`站点可达：${(probe.text.length / 1024).toFixed(0)} KB`);

    const browser = await chromium.launch({
        executablePath: EXE,
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader'],
        env: { ...process.env, LD_LIBRARY_PATH: LIB, FONTCONFIG_FILE: '/tmp/fontconf/fonts.conf' },
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message.slice(0, 200)));

    await page.route('**/api/plugins/fanqie-bridge/fetch**', async route => {
        const request = route.request();
        if (request.url().endsWith('/ping')) {
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, version: '1.3.0', features: ['fetch', 'fetch-batch'] }) });
        }
        const body = request.postDataJSON();
        const targets = body.requests ? body.requests : [{ url: body.url }];
        const items = [];
        for (const item of targets) {
            try {
                const real = await fetchReal(item.url);
                items.push({ ok: true, status: real.status, finalUrl: item.url, headers: {}, charset: 'utf-8', text: real.text });
            } catch (error) {
                items.push({ ok: false, url: item.url, error: error.message });
            }
        }
        const payload = body.requests ? { ok: true, results: items } : { ok: true, ...items[0] };
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
    });

    await page.goto('http://127.0.0.1:8899/dev/harness-browser.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__harnessReady === true);
    await page.click('#nr-orb');
    await page.waitForSelector('#nr-panel.nr-open');
    await page.evaluate(() => {
        window.NovelReader.setOnlineSettings({ searchEngine: 'source', channel: 'auto', concurrency: 2 });
        // 故意用一条「目录规则对不上」的书源
        window.NovelReader.importSourcesJson(JSON.stringify([{
            bookSourceName: 'gdbzkz（规则不对）', bookSourceUrl: 'http://www.gdbzkz.la',
            searchUrl: 'http://www.gdbzkz.la/s?q={{key}}',
            ruleSearch: { bookList: 'class.result', name: 'tag.a@text', bookUrl: 'tag.a@href' },
            ruleBookInfo: { name: 'tag.h1@text', intro: 'class.intro@text' },
            ruleToc: { chapterList: '#list dd', chapterName: 'tag.a@text', chapterUrl: 'tag.a@href' },
            ruleContent: { content: '#content@html' },
        }]));
    });

    const opened = await page.evaluate(url => window.NovelReader.openOnlineUrl(url), TARGET);
    check('真站点能打开（不再报「没解析到章节」）', Boolean(opened && opened.chapters > 1000), JSON.stringify(opened));
    const state = await page.evaluate(async () => {
        const info = await window.NovelReader.getState();
        return { chapters: info.online.book?.chapters ?? 0, title: info.online.book?.title || '' };
    });
    check('猜出上千章目录', state.chapters > 1000, JSON.stringify(state));
    check('书名解析正确', /诡秘之主/.test(state.title), state.title);

    // 猜出来的目录要能真的抓正文：抽第一章验证
    const firstChapter = await page.evaluate(() => window.NovelReader.readOnline());
    void firstChapter;
    const article = await page.evaluate(() => (document.querySelector('#nr-article')?.textContent || '').slice(0, 200));
    check('在线阅读能抓到正文（不是错误页）', article.length > 40 && !/转码失败|不是正文/.test(article), article.replace(/\s+/g, ' ').slice(0, 70));
    check('无页面错误', errors.length === 0, errors.slice(0, 2).join(' | '));

    await browser.close();
    const failed = results.filter(r => !r.ok);
    console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
    if (failed.length) process.exit(1);
})().catch(e => { console.error('FAIL', e.message.slice(0, 400)); process.exit(1); });
