/**
 * 换源：下载进书架的书必须认得自己的源，「右上角换源」要能点、能列出候选、能真的换过去。
 *
 * 运行：NODE_PATH=/tmp/pwtest/node_modules node dev/harness-change-source.cjs
 */
const { chromium } = require('playwright');
const EXE = '/root/.cache/ms-playwright/chromium-1248/chrome-linux-arm64/chrome';
const LIB = '/tmp/chromedeps/root/usr/lib/aarch64-linux-gnu';
const results = [];
const check = (n, ok, x = '') => { results.push({ n, ok }); console.log(ok ? '✓' : '✗', n, x); };

const SRC_A = 'https://f.test';
const SRC_B = 'https://g.test';

function pageHtml(url) {
    if (url.includes('/s?')) {
        const host = new URL(url).host.includes('f.test') ? 'f.test' : 'g.test';
        return `<div class="result"><h3><a href="https://${host}/b/1">好源书</a></h3><span>作者：某某</span></div>`;
    }
    if (url.includes('/toc')) {
        const isA = url.includes('f.test');
        const n = isA ? 200 : 150;
        const prefix = isA ? 'A' : 'B';
        return `<ul class="list">${Array.from({ length: n }, (_, i) => `<li><a href="https://${isA ? 'f' : 'g'}.test/c/${i + 1}">${prefix}-${i + 1}</a></li>`).join('')}</ul>`;
    }
    if (url.includes('/c/')) {
        const isA = url.includes('f.test');
        const id = url.split('/').pop();
        return `<div id="content"><p>${isA ? 'A' : 'B'}源第${id}章的正文，够长够正常。</p></div>`;
    }
    return '<h1>好源书</h1><span class="author">某某</span><a class="toc" href="https://x.test/toc">目录</a>'
        .replace('https://x.test/toc', url.includes('f.test') ? 'https://f.test/b/1/toc' : 'https://g.test/b/1/toc');
}

(async () => {
    const browser = await chromium.launch({
        executablePath: EXE,
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader'],
        env: { ...process.env, LD_LIBRARY_PATH: LIB, FONTCONFIG_FILE: '/tmp/fontconf/fonts.conf' },
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message.slice(0, 200)));

    const answer = list => ({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, results: list.map(r => ({ ok: true, status: 200, finalUrl: r.url, headers: {}, charset: 'utf-8', text: pageHtml(r.url) })) }),
    });
    await page.route('**/api/plugins/fanqie-bridge/fetch-batch', async route => {
        const body = route.request().postDataJSON();
        await new Promise(r => setTimeout(r, 20));
        await route.fulfill(answer(body.requests || []));
    });
    await page.route('**/api/plugins/fanqie-bridge/fetch', async route => {
        const body = route.request().postDataJSON();
        await new Promise(r => setTimeout(r, 20));
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
    await page.evaluate(([a, b]) => {
        window.NovelReader.setOnlineSettings({ searchEngine: 'source', channel: 'auto', concurrency: 4, respectRateLimit: false, downloadLimit: 0 });
        const make = (name, url) => ({
            bookSourceName: name, bookSourceUrl: url,
            searchUrl: `${url}/s?q={{key}}`,
            ruleSearch: { bookList: 'class.result', name: 'tag.a@text', bookUrl: 'tag.a@href' },
            ruleBookInfo: { name: 'tag.h1@text', tocUrl: 'class.toc@href' },
            ruleToc: { chapterList: 'class.list@tag.li', chapterName: 'tag.a@text', chapterUrl: 'tag.a@href' },
            ruleContent: { content: '#content@html' },
        });
        window.NovelReader.importSourcesJson(JSON.stringify([make('F源', a), make('G源', b)]));
    }, [SRC_A, SRC_B]);

    await page.evaluate(async () => {
        await window.NovelReader.searchOnline('好源书');
        await window.NovelReader.openOnlineUrl('https://f.test/b/1');
    });
    const meta = await page.evaluate(() => window.NovelReader.downloadOnline());
    check('先正常下载一本', Boolean(meta && meta.chapterCount), JSON.stringify(meta && { title: meta.title, count: meta.chapterCount }));

    const btn = await page.evaluate(() => {
        const node = document.querySelector('#nr-reader-change-source');
        return node ? { disabled: node.disabled, title: node.title } : null;
    });
    check('「换源」按钮可以点', Boolean(btn) && btn.disabled === false, JSON.stringify(btn));

    await page.click('#nr-reader-change-source');
    await page.waitForSelector('#nr-change-list .nr-source-item', { timeout: 15000 }).catch(() => {});
    const candidates = await page.evaluate(() => [...document.querySelectorAll('#nr-change-list .nr-source-item strong')].map(n => n.textContent));
    check('列出了其它源的候选', candidates.length >= 1, JSON.stringify(candidates));
    check('没把同一个源列进来', !candidates.includes('F源'), JSON.stringify(candidates));

    await page.evaluate(() => {
        const button = document.querySelector('#nr-change-list .nr-source-item button');
        if (button) button.click();
    });
    await page.waitForFunction(() => /已换到|换源完成/.test(document.querySelector('#nr-change-status')?.textContent || ''), { timeout: 20000 }).catch(() => {});
    const status = await page.evaluate(() => document.querySelector('#nr-change-status')?.textContent || '');
    check('换源成功', /已换到/.test(status), status.slice(0, 80));

    const chapters = await page.evaluate(() => [...document.querySelectorAll('#nr-chapter-list [data-chapter-index]')].slice(0, 3).map(n => n.textContent.trim()));
    check('目录换成了新源（B- 开头）', chapters.every(text => /^B-/.test(text)), JSON.stringify(chapters));
    const article = await page.evaluate(() => document.querySelector('#nr-article')?.textContent || '');
    check('正文来自新源', /B源第\d+章/.test(article), article.slice(0, 40));
    check('无页面错误', errors.length === 0, errors.slice(0, 2).join(' | '));

    await browser.close();
    const failed = results.filter(r => !r.ok);
    console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
    if (failed.length) process.exit(1);
})().catch(e => { console.error('FAIL', e.message.slice(0, 400)); process.exit(1); });
