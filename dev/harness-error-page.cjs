/**
 * 站点拿「转码失败 / 请换源」的错误页冒充正文时：
 *   1) 不能当成正文存进书架；
 *   2) 连着几章都不是正文就提前收手，不要跑完几百章；
 *   3) 报错信息要能看懂。
 *
 * 运行：NODE_PATH=/tmp/pwtest/node_modules node dev/harness-error-page.cjs
 */
const { chromium } = require('playwright');
const EXE = '/root/.cache/ms-playwright/chromium-1248/chrome-linux-arm64/chrome';
const LIB = '/tmp/chromedeps/root/usr/lib/aarch64-linux-gnu';
const ERROR_PAGE = '<div id="content">转码失败！请您使用右上换源切换源站阅读或者直接前往源网站进行阅读！</div>';
const results = [];
const check = (n, ok, x = '') => { results.push({ n, ok }); console.log(ok ? '✓' : '✗', n, x); };

(async () => {
    const browser = await chromium.launch({
        executablePath: EXE,
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader'],
        env: { ...process.env, LD_LIBRARY_PATH: LIB, FONTCONFIG_FILE: '/tmp/fontconf/fonts.conf' },
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    const logs = [];
    page.on('pageerror', e => errors.push(e.message.slice(0, 200)));
    page.on('console', m => logs.push(m.text()));

    let chapterHits = 0;
    const chapterHtml = url => {
        chapterHits++;
        return ERROR_PAGE;
    };
    const pageHtml = url => url.includes('/s?')
        ? '<div class="result"><h3><a href="https://f.test/b/1">坏源书</a></h3></div>'
        : url.includes('/toc')
            ? `<ul class="list">${Array.from({ length: 200 }, (_, i) => `<li><a href="https://f.test/c/${i + 1}">第${i + 1}章</a></li>`).join('')}</ul>`
            : url.includes('/c/')
                ? chapterHtml(url)
                : '<h1>坏源书</h1><a class="toc" href="https://f.test/b/1/toc">目录</a>';

    await page.route('**/api/plugins/fanqie-bridge/fetch-batch', async route => {
        const body = route.request().postDataJSON();
        await new Promise(r => setTimeout(r, 60));
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                ok: true,
                results: (body.requests || []).map(r => ({
                    ok: true, status: 200, finalUrl: r.url, headers: {}, charset: 'utf-8', text: pageHtml(r.url),
                })),
            }),
        });
    });
    await page.route('**/api/plugins/fanqie-bridge/fetch', async route => {
        const body = route.request().postDataJSON();
        await new Promise(r => setTimeout(r, 60));
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
        window.NovelReader.setOnlineSettings({ searchEngine: 'source', channel: 'auto', concurrency: 2, respectRateLimit: false, downloadLimit: 0 });
        window.NovelReader.importSourcesJson(JSON.stringify([{
            bookSourceName: '坏源', bookSourceUrl: 'https://f.test',
            searchUrl: 'https://f.test/s?q={{key}}',
            ruleSearch: { bookList: 'class.result', name: 'tag.a@text', bookUrl: 'tag.a@href' },
            ruleBookInfo: { name: 'tag.h1@text', tocUrl: 'class.toc@href' },
            ruleToc: { chapterList: 'class.list@tag.li', chapterName: 'tag.a@text', chapterUrl: 'tag.a@href' },
            ruleContent: { content: '#content@html' },
        }]));
    });
    await page.evaluate(async () => {
        await window.NovelReader.searchOnline('x');
        await window.NovelReader.openOnlineUrl('https://f.test/b/1');
    });
    const before = await page.evaluate(async () => (await window.NovelReader.getState()).novels.length);

    const t0 = Date.now();
    const meta = await page.evaluate(() => window.NovelReader.downloadOnline());
    const elapsed = Date.now() - t0;

    check('错误页没有入库（返回 null）', meta === null, JSON.stringify(meta));
    const after = await page.evaluate(async () => (await window.NovelReader.getState()).novels.length);
    check('书架里没多出这本书', after === before, `${before} → ${after}`);
    check('报错说清了「不是正文」', logs.some(line => /不是正文|转码失败/.test(line)), (logs.find(line => /下载失败|不是正文/.test(line)) || '').slice(0, 80));
    check('连着几章不对就收手（请求数 < 40）', chapterHits > 0 && chapterHits < 40, `chapterHits=${chapterHits}`);
    check('提前结束得够快（< 5 秒）', elapsed < 5000, `elapsed=${elapsed}ms`);
    check('无页面错误', errors.length === 0, errors.slice(0, 2).join(' | '));

    await browser.close();
    const failed = results.filter(r => !r.ok);
    console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
    if (failed.length) process.exit(1);
})().catch(e => { console.error('FAIL', e.message.slice(0, 400)); process.exit(1); });
