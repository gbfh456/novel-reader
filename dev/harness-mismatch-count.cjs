/**
 * 两件真实站点上会碰到的事：
 *   1) 书源的目录规则和站点对不上 —— 不能直接报「没解析到章节」，要按页面结构猜出来并说清楚；
 *   2) 多个结果其实是同一本书 —— 卡片合并成一行，状态栏要说「几本书 / 原始几条」，
 *      别出现「已找到 572 条」却只看到一行的困惑。
 *
 * 运行：NODE_PATH=/tmp/pwtest/node_modules node dev/harness-mismatch-count.cjs
 */
const { chromium } = require('playwright');
const EXE = '/root/.cache/ms-playwright/chromium-1248/chrome-linux-arm64/chrome';
const LIB = '/tmp/chromedeps/root/usr/lib/aarch64-linux-gnu';
const results = [];
const check = (n, ok, x = '') => { results.push({ n, ok }); console.log(ok ? '✓' : '✗', n, x); };

// 搜索页：三行都是《诡秘之主》（作者相同），地址不同 → 应该合并成一行
const SEARCH_HTML = [1, 2, 3].map(id =>
    `<div class="result"><h3><a href="https://g.test/b/${id}">诡秘之主</a></h3><span>作者：爱潜水的乌贼</span></div>`).join('');

// 书籍页：真站点的样子 —— <dl><dt>卷名</dt><dd><a href ="...">（等号前有空格）
const BOOK_HTML = (() => {
    const nav = '<div class="nav"><a href="https://g.test/">首页</a><a href="https://g.test/fenlei/1/1.html">玄幻小说</a><a href="https://g.test/paihangbang/">排行榜</a></div>';
    const chapters = Array.from({ length: 40 }, (_, i) => `<dd><a href ="/guimizhizhu/${100 + i}.html">第${i + 1}章 标题</a></dd>`).join('');
    return `<html><head><title>诡秘之主</title></head><body>${nav}
        <div class="info"><h1>诡秘之主</h1><p class="intro">这是一段简介</p></div>
        <div class="listmain"><dl><dt>《诡秘之主》正文卷</dt>${chapters}</dl></div></body></html>`;
})();

function pageHtml(url) {
    if (url.includes('/s?')) return SEARCH_HTML;
    if (url.includes('/c/')) return '<div id="content"><p>正文内容，够长够正常。</p></div>';
    return BOOK_HTML;
}

(async () => {
    const browser = await chromium.launch({
        executablePath: EXE,
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader'],
        env: { ...process.env, LD_LIBRARY_PATH: LIB, FONTCONFIG_FILE: '/tmp/fontconf/fonts.conf' },
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message.slice(0, 200)));

    await page.route('**/api/plugins/fanqie-bridge/fetch-batch', async route => {
        const body = route.request().postDataJSON();
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                ok: true,
                results: (body.requests || []).map(r => ({ ok: true, status: 200, finalUrl: r.url, headers: {}, charset: 'utf-8', text: pageHtml(r.url) })),
            }),
        });
    });
    await page.route('**/api/plugins/fanqie-bridge/fetch', async route => {
        const body = route.request().postDataJSON();
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ ok: true, status: 200, finalUrl: body.url, headers: {}, text: pageHtml(body.url), charset: 'utf-8', elapsed: 1 }),
        });
    });
    await page.route('**/api/plugins/fanqie-bridge/ping', route => route.fulfill({
        status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, version: '1.3.0', features: ['fetch', 'fetch-batch'] }),
    }));

    await page.goto('http://127.0.0.1:8899/dev/harness-browser.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__harnessReady === true);
    await page.click('#nr-orb');
    await page.waitForSelector('#nr-panel.nr-open');
    await page.evaluate(() => {
        window.NovelReader.setOnlineSettings({ searchEngine: 'source', channel: 'auto', concurrency: 2, exactMatch: false, pageSize: 10 });
        window.NovelReader.importSourcesJson(JSON.stringify([{
            bookSourceName: '歪源', bookSourceUrl: 'https://g.test',
            searchUrl: 'https://g.test/s?q={{key}}',
            ruleSearch: { bookList: 'class.result', name: 'tag.a@text', author: 'span@text', bookUrl: 'tag.a@href' },
            ruleBookInfo: { name: 'tag.h1@text', intro: 'class.intro@text' },
            // 故意写错的目录规则：真站点上很常见
            ruleToc: { chapterList: '#no-such-list', chapterName: 'tag.a@text', chapterUrl: 'tag.a@href' },
            ruleContent: { content: '#content@html' },
        }]));
    });

    const searched = await page.evaluate(() => window.NovelReader.searchOnline('诡秘之主'));
    // searchOnline 返回的是展示用的列表（已按书名+作者合并），3 条同书 → 1 行
    check('3 条原始结果合并成 1 行', searched.length === 1, `${searched.length}`);

    const countText = await page.evaluate(() => document.querySelector('#nr-ol-results-count')?.textContent || '');
    check('结果头说清是「几本书」+ 原始条数', /共\s*1\s*本书/.test(countText) && /原始\s*3\s*条/.test(countText), countText);

    const statusText = await page.evaluate(() => document.querySelector('#nr-ol-status')?.textContent || '');
    check('状态栏不再只说「找到 3 条」', /找到\s*1\s*本书/.test(statusText) && !/找到\s*3\s*条结果/.test(statusText), statusText.slice(0, 90));

    const rows = await page.evaluate(() => document.querySelectorAll('#nr-ol-results .nr-online-result').length);
    check('合并后只占一行', rows === 1, `${rows}`);

    // 目录规则不匹配：应该靠猜目录打开，而不是报错
    const opened = await page.evaluate(() => window.NovelReader.openOnlineUrl('https://g.test/b/1'));
    check('规则不匹配也能打开（不再报「没解析到章节」）', Boolean(opened && opened.chapters === 40), JSON.stringify(opened));

    const guessed = await page.evaluate(async () => {
        const state = await window.NovelReader.getState();
        return { chapters: state.online.book?.chapters ?? 0 };
    });
    check('目录确实是猜出来的 40 章', guessed.chapters === 40, JSON.stringify(guessed));

    const cardText = await page.evaluate(() => (document.querySelector('#nr-ol-book')?.textContent || '').replace(/\s+/g, ' '));
    check('卡片上显示 40 章', /40\s*章/.test(cardText), cardText.slice(0, 80));
    check('无页面错误', errors.length === 0, errors.slice(0, 2).join(' | '));

    await browser.close();
    const failed = results.filter(r => !r.ok);
    console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
    if (failed.length) process.exit(1);
})().catch(e => { console.error('FAIL', e.message.slice(0, 400)); process.exit(1); });
