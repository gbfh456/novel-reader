/**
 * 「找书」页的四件事：
 *   1) 精准搜索勾选框（书名归一化后完全一致，可选、能回退）；
 *   2) 解析完不再把章节铺在卡片里；
 *   3) 结果列表自己有滚动条；
 *   4) 分页条和书籍简介固定在下面，不随结果滚走。
 *
 * 运行：NODE_PATH=/tmp/pwtest/node_modules node dev/harness-search-ui.cjs
 */
const { chromium } = require('playwright');
const EXE = '/root/.cache/ms-playwright/chromium-1248/chrome-linux-arm64/chrome';
const LIB = '/tmp/chromedeps/root/usr/lib/aarch64-linux-gnu';
const results = [];
const check = (n, ok, x = '') => { results.push({ n, ok }); console.log(ok ? '✓' : '✗', n, x); };

const BOOKS = [
    { id: 1, title: '诡秘之主' },
    { id: 2, title: '诡秘之主（精校版）' },
    { id: 3, title: '诡秘之主的同人' },
    { id: 4, title: '别的书' },
    { id: 5, title: '另一个别的书' },
];

function pageHtml(url) {
    if (url.includes('/s?')) {
        return BOOKS.map(b => `<div class="result"><h3><a href="https://f.test/b/${b.id}">${b.title}</a></h3><span>作者：某某</span></div>`).join('');
    }
    if (url.includes('/toc')) {
        return `<ul class="list">${Array.from({ length: 60 }, (_, i) => `<li><a href="https://f.test/c/${i + 1}">第${i + 1}章</a></li>`).join('')}</ul>`;
    }
    if (url.includes('/c/')) {
        return `<div id="content"><p>第${url.split('/').pop()}章的正文，够长够正常。</p></div>`;
    }
    const id = url.split('/').pop();
    const intro = '这是一段很长的简介。'.repeat(40);
    return `<h1>诡秘之主</h1><span class="author">某某</span><p class="intro">${intro}</p><a class="toc" href="https://f.test/b/${id}/toc">目录</a>`;
}

(async () => {
    const browser = await chromium.launch({
        executablePath: EXE,
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader'],
        env: { ...process.env, LD_LIBRARY_PATH: LIB, FONTCONFIG_FILE: '/tmp/fontconf/fonts.conf' },
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
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
        window.NovelReader.setOnlineSettings({ searchEngine: 'source', channel: 'auto', concurrency: 2, exactMatch: false, pageSize: 5 });
        window.NovelReader.importSourcesJson(JSON.stringify([{
            bookSourceName: 'F源', bookSourceUrl: 'https://f.test',
            searchUrl: 'https://f.test/s?q={{key}}',
            ruleSearch: { bookList: 'class.result', name: 'tag.a@text', bookUrl: 'tag.a@href' },
            ruleBookInfo: { name: 'tag.h1@text', intro: 'class.intro@text', tocUrl: 'class.toc@href' },
            ruleToc: { chapterList: 'class.list@tag.li', chapterName: 'tag.a@text', chapterUrl: 'tag.a@href' },
            ruleContent: { content: '#content@html' },
        }]));
    });

    const searched = await page.evaluate(async () => (await window.NovelReader.searchOnline('诡秘之主')));
    check('默认（不勾精准）搜到全部 5 条', searched.length === 5, `${searched.length}`);

    const titles = await page.evaluate(() => [...document.querySelectorAll('#nr-ol-results .nr-online-result-head strong')].map(n => n.textContent));
    check('结果列表渲染出来了', titles.length === 5, JSON.stringify(titles));

    // 勾上精准搜索
    await page.click('#nr-ol-exact');
    await page.waitForTimeout(200);
    const exactTitles = await page.evaluate(() => [...document.querySelectorAll('#nr-ol-results .nr-online-result-head strong')].map(n => n.textContent));
    check('精准搜索只留书名一致的（含「（精校版）」）', exactTitles.length === 2, JSON.stringify(exactTitles));
    check('精准搜索干掉了「同人」和别的书', !exactTitles.includes('诡秘之主的同人') && !exactTitles.includes('别的书'), JSON.stringify(exactTitles));
    const checked = await page.evaluate(() => document.querySelector('#nr-ol-exact').checked);
    check('勾选框状态是勾上的', checked === true);

    // 取消勾选要能恢复
    await page.click('#nr-ol-exact');
    await page.waitForTimeout(200);
    const backTitles = await page.evaluate(() => [...document.querySelectorAll('#nr-ol-results .nr-online-result-head strong')].map(n => n.textContent));
    check('取消勾选恢复全部结果', backTitles.length === 5, `${backTitles.length}`);

    // 滚动条：上半区（搜索栏 + 结果）一起滚，容器是 .nr-online-scroll
    const scroll = await page.evaluate(() => {
        const box = document.querySelector('#nr-ol-scroll');
        const style = getComputedStyle(box);
        return {
            overflowY: style.overflowY,
            scrollHeight: box.scrollHeight,
            clientHeight: box.clientHeight,
            resultsScroll: getComputedStyle(document.querySelector('#nr-ol-results')).overflowY,
        };
    });
    check('上半区是滚动容器（overflow-y: auto）', scroll.overflowY === 'auto', JSON.stringify(scroll));
    check('结果列表自己不再单独滚（跟搜索栏同一个容器）', scroll.resultsScroll !== 'auto', JSON.stringify(scroll));

    // 固定分区：面板本身不滚
    const pane = await page.evaluate(() => {
        const pad = document.querySelector('#nr-panel .nr-pane-pad.nr-online');
        return { overflow: getComputedStyle(pad).overflow };
    });
    check('找书页整页不再整体滚动（固定分区）', pane.overflow === 'hidden', JSON.stringify(pane));

    // 搜索栏不固定：把上半区滚下去，搜索框应该跟着滚出可视区
    const searchScroll = await page.evaluate(async () => {
        const box = document.querySelector('#nr-ol-scroll');
        const query = document.querySelector('#nr-ol-query');
        const before = query.getBoundingClientRect().top;
        box.scrollTop = box.scrollHeight;
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        const after = query.getBoundingClientRect().top;
        const boxTop = box.getBoundingClientRect().top;
        return { before, after, boxTop, scrolled: box.scrollTop > 0 };
    });
    check('搜索栏跟着滚走（不再固定在顶上）', searchScroll.scrolled && searchScroll.after < searchScroll.boxTop, JSON.stringify(searchScroll));

    // 解析完不显示章节
    await page.evaluate(() => window.NovelReader.openOnlineUrl('https://f.test/b/1'));
    await page.waitForTimeout(300);
    const book = await page.evaluate(() => {
        const card = document.querySelector('#nr-ol-book');
        return {
            chapters: card.querySelectorAll('.nr-online-chapter, .nr-online-chapters').length,
            text: (card.textContent || '').replace(/\s+/g, ' ').slice(0, 120),
            hidden: card.hidden,
        };
    });
    check('解析完不再铺章节列表', book.chapters === 0, JSON.stringify(book.chapters));
    check('只保留「N 章」的总数', /60\s*章/.test(book.text), book.text);

    // 每页 2 条 → 分页条出现；再滚结果，分页条和简介都不该动
    await page.evaluate(() => window.NovelReader.setOnlinePageSize(2));
    await page.waitForTimeout(150);
    const fixed = await page.evaluate(() => {
        const results = document.querySelector('#nr-ol-scroll');
        const pager = document.querySelector('#nr-ol-pager');
        const book = document.querySelector('#nr-ol-book');
        const panel = document.querySelector('#nr-panel');
        const before = {
            pagerTop: pager.getBoundingClientRect().top,
            bookTop: book.getBoundingClientRect().top,
            pagerHidden: pager.hidden,
        };
        results.scrollTop = results.scrollHeight;
        const after = {
            pagerTop: pager.getBoundingClientRect().top,
            bookTop: book.getBoundingClientRect().top,
        };
        const br = panel.getBoundingClientRect();
        return {
            scrolled: results.scrollTop > 0,
            pagerHidden: before.pagerHidden,
            pagerStill: Math.abs(before.pagerTop - after.pagerTop) < 1,
            bookStill: Math.abs(before.bookTop - after.bookTop) < 1,
            pagerInPanel: pager.getBoundingClientRect().top >= br.top - 1 && pager.getBoundingClientRect().bottom <= br.bottom + 1,
            bookInPanel: book.getBoundingClientRect().bottom <= br.bottom + 1,
        };
    });
    check('分页条出现了（每页 2 条 → 3 页）', fixed.pagerHidden === false, JSON.stringify(fixed));
    const sizeSelect = await page.evaluate(() => {
        const node = document.querySelector('#nr-ol-page-size');
        return { value: node.value, label: node.selectedOptions[0]?.textContent || '' };
    });
    check('「每页」下拉框跟着设置显示（不空白）', sizeSelect.value === '2' && /2\s*条/.test(sizeSelect.label), JSON.stringify(sizeSelect));
    check('上半区确实滚动了', fixed.scrolled === true, JSON.stringify(fixed));
    check('滚结果时分页条不动', fixed.pagerStill === true, JSON.stringify(fixed));
    check('滚结果时书籍简介不动', fixed.bookStill === true, JSON.stringify(fixed));
    check('分页条与简介都在面板可视范围内', fixed.pagerInPanel && fixed.bookInPanel, JSON.stringify(fixed));

    check('无页面错误', errors.length === 0, errors.slice(0, 2).join(' | '));

    await browser.close();
    const failed = results.filter(r => !r.ok);
    console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
    if (failed.length) process.exit(1);
})().catch(e => { console.error('FAIL', e.message.slice(0, 400)); process.exit(1); });
