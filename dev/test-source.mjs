/**
 * 书源内核测试（P0）：规则编译 / 执行 / JSONPath / URL / 书源模型 / 流水线。
 * 运行：node dev/test-source.mjs
 */

import assert from 'node:assert/strict';
import { compileRule, splitTopLevel, parseStep } from '../js/rule/compile.js';
import { createRuleContext, getElements, getString, getStringList, replaceText } from '../js/rule/execute.js';
import { queryJsonPath } from '../js/rule/jsonpath.js';
import { buildRequest, applyUrlTemplate, splitUrlOption } from '../js/net/url.js';
import { importSources, exportSource, normalizeSource, validateSource, splitSourceGroups, sourceNeedsJs } from '../js/source/model.js';
import { BookPipeline } from '../js/book/pipeline.js';
import { htmlToText, normalizeParagraphs, rebuildParagraphs } from '../js/book/text.js';
import { parseConcurrentRate } from '../js/net/client.js';
import { SourceRuntime, alignChapterIndex, normalizeBookName } from '../js/source/runtime.js';
import { normalizeOnlineSettings } from '../js/network.js';
import {
    absorbSetCookie,
    clearCookies,
    decodeBody,
    getCookieHeader,
    isAllowedTarget,
    putLoginHeader,
} from '../server/http.mjs';

let passed = 0;
async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`✓ ${name}`);
    } catch (error) {
        console.error(`✗ ${name}`);
        throw error;
    }
}

/* ------------------------------------------------------------------ */
/* 规则编译                                                            */
/* ------------------------------------------------------------------ */

await test('规则编译：链式选择器与属性', () => {
    const rule = compileRule('class.book-list@tag.li@tag.a@text');
    assert.equal(rule.steps.length, 1);
    const step = rule.steps[0];
    assert.equal(step.kind, 'select');
    assert.equal(step.attr, 'text');
    assert.deepEqual(step.chain.map(item => item.kind), ['class', 'tag', 'tag']);
    assert.deepEqual(step.chain.map(item => item.value), ['book-list', 'li', 'a']);
});

await test('规则编译：前缀 @@ / @css: / @Json / $ / //', () => {
    assert.equal(compileRule('@@class.a@text').steps[0].chain[0].kind, 'class');
    assert.equal(compileRule('@css:.book@href').steps[0].chain[0].selector, '.book');
    assert.equal(compileRule('@Json:$.data[*].name').steps[0].kind, 'json');
    assert.equal(compileRule('$.data[0].name').steps[0].kind, 'json');
    assert.equal(compileRule('//div[@class="x"]').steps[0].kind, 'xpath');
});

await test('规则编译：索引写法', () => {
    assert.deepEqual(parseStep('tag.li[-1]').index.values, [{ range: false, index: -1 }]);
    assert.deepEqual(parseStep('tag.li[0:3:2]').index.values, [{ range: true, start: 0, end: 3, step: 2 }]);
    assert.equal(parseStep('tag.li!0').index.exclude, true);
    assert.deepEqual(parseStep('tag.li.1').index.values, [{ range: false, index: 1 }]);
});

await test('规则编译：替换与 JS / 变量段', () => {
    const rule = compileRule('class.a@href##^//##https://');
    assert.equal(rule.steps[0].replace.regex, '^//');
    assert.equal(rule.steps[0].replace.replacement, 'https://');
    const first = compileRule('class.a@text##广告##');
    assert.equal(first.steps[0].replace.first, false);
    const withJs = compileRule('{{1+2}}');
    assert.equal(withJs.steps[0].kind, 'js');
    const withGet = compileRule('@put:{x:class.a@text}@get:{x}');
    assert.equal(withGet.put.x, 'class.a@text');
    assert.equal(withGet.steps[0].kind, 'get');
});

await test('规则编译：@put 值里带逗号 / 方括号不被切坏', () => {
    const rule = compileRule('@put:{"a":"class.x@tag.li[0,1]","b":"class.y@text"}class.z@text');
    assert.equal(rule.put.a, 'class.x@tag.li[0,1]');
    assert.equal(rule.put.b, 'class.y@text');
});

await test('规则编译：&& / || / %% 与列表正则', () => {
    const split = splitTopLevel('class.a&&class.b');
    assert.deepEqual(split.parts, ['class.a', 'class.b']);
    assert.equal(split.operator, '&&');
    const rule = compileRule('class.a@text||class.b@text');
    assert.equal(rule.steps[0].kind, 'alternatives');
    assert.equal(rule.steps[0].operator, '||');
    assert.equal(compileRule(':第(\\d+)章', { list: true }).steps[0].kind, 'regex');
});

/* ------------------------------------------------------------------ */
/* 规则执行                                                            */
/* ------------------------------------------------------------------ */

const SEARCH_HTML = `
<div class="result">
  <ul>
    <li><h3><a href="/book/1">书一</a></h3><span class="author">作者一</span><p class="intro">简介一</p><img class="cover" src="/cover/1.jpg"></li>
    <li><h3><a href="/book/2">书二</a></h3><span class="author">作者二</span><p class="intro">简介二</p><img class="cover" src="/cover/2.jpg"></li>
    <li><h3><a href="/book/3">书三</a></h3><span class="author">作者三</span><p class="intro">简介三</p><img class="cover" src="/cover/3.jpg"></li>
  </ul>
</div>`;

function ctxFor(baseUrl = 'https://example.com/search') {
    return createRuleContext({ baseUrl });
}

await test('规则执行：链式选择 / 列表 / 属性 / URL 补全', () => {
    const ctx = ctxFor();
    assert.deepEqual(getStringList('class.result@tag.li@tag.a@text', SEARCH_HTML, ctx), ['书一', '书二', '书三']);
    assert.equal(getString('class.result@tag.li@tag.a@href', SEARCH_HTML, ctx, { isUrl: true }), 'https://example.com/book/1');
    assert.equal(getString('class.result@tag.li[1]@tag.a@text', SEARCH_HTML, ctx), '书二');
    assert.equal(getString('class.result@tag.li[-1]@tag.a@text', SEARCH_HTML, ctx), '书三');
    assert.equal(getElements('class.result@tag.li', SEARCH_HTML, ctx).length, 3);
    assert.equal(getString('class.result@tag.li!0@tag.a@text', SEARCH_HTML, ctx), '书二\n书三');
});

await test('规则执行：text / ownText / html / all / 属性', () => {
    const ctx = ctxFor();
    const html = '<div class="box">外层<span class="in">内层</span></div>';
    assert.equal(getString('class.box@text', html, ctx), '外层内层');
    assert.equal(getString('class.box@ownText', html, ctx), '外层');
    assert.equal(getString('class.box@html', html, ctx), '外层<span class="in">内层</span>');
    assert.equal(getString('class.in@all', html, ctx), '<span class="in">内层</span>');
    assert.equal(getString('class.box@data-x', '<div class="box" data-x="42">x</div>', ctx), '42');
});

await test('规则执行：替换 / 并集 / 纯 JS / put-get / 文本替换', () => {
    const ctx = ctxFor();
    assert.equal(getString('class.result@tag.li[0]@tag.a@text##书##《书》', SEARCH_HTML, ctx), '《书》一');
    assert.equal(getString('class.none@text||class.result@tag.li[0]@tag.a@text', SEARCH_HTML, ctx), '书一');
    assert.equal(getString('{{1+2}}', SEARCH_HTML, ctx), '3');
    assert.equal(getString('{{java.base64Encode("a")}}', SEARCH_HTML, ctx), 'YQ==');
    assert.equal(getString('@put:{name:class.result@tag.li[0]@tag.a@text}@get:{name}', SEARCH_HTML, ctx), '书一');
    assert.equal(replaceText('##广告##', '正文广告内容', ctx), '正文内容');
});

await test('规则执行：正文不夹带 script / style 内容', () => {
    const ctx = ctxFor();
    const html = `<div id="content"><p>第一段。</p><style>.a{color:red}</style><script>var x="<b>";</script><p>第二段。</p></div>`;
    const text = getString('#content@text', html, ctx);
    assert.equal(text, '第一段。第二段。');
    assert.ok(!text.includes('color:red'), '不能把 CSS 当正文');
    assert.ok(!text.includes('var x'), '不能把脚本当正文');
});

await test('规则执行：JSONPath 取对象 / 列表 / 过滤', () => {
    const ctx = ctxFor();
    const json = JSON.stringify({ data: [{ name: '甲', n: 2, url: 'https://a.com/1' }, { name: '乙', n: 5, url: 'https://a.com/2' }] });
    assert.equal(getString('$.data[*].name', json, ctx), '甲\n乙');
    assert.deepEqual(getStringList('$.data[*].name', json, ctx), ['甲', '乙']);
    assert.equal(getString('$.data[?(@.n > 3)].name', json, ctx), '乙');
    assert.equal(getString('$..name', json, ctx), '甲\n乙');
    assert.equal(getElements('$.data[*]', json, ctx).length, 2);
    assert.equal(queryJsonPath({ a: { b: [{ c: 1 }, { c: 2 }] } }, '$.a.b[*].c').join(','), '1,2');
});

/* ------------------------------------------------------------------ */
/* URL / 网络参数                                                       */
/* ------------------------------------------------------------------ */

await test('URL：关键词 / 页码 / 页码列表', () => {
    assert.equal(applyUrlTemplate('https://a.com/s?q={{key}}&p={{page}}', { key: '诡 秘', page: 2 }), 'https://a.com/s?q=诡 秘&p=2');
    assert.equal(applyUrlTemplate('https://a.com/{{page}}.html', { page: 3 }), 'https://a.com/3.html');
    assert.equal(applyUrlTemplate('https://a.com/list/<1,2,3>.html', { page: 9 }), 'https://a.com/list/3.html');
    assert.equal(applyUrlTemplate('https://a.com/?p={{page-1}}', { page: 3 }), 'https://a.com/?p=2');
    assert.equal(applyUrlTemplate('https://a.com/?q={{java.encodeURI(key)}}', { key: 'a b' }), 'https://a.com/?q=a%20b');
});

await test('URL：旧格式单花括号 / %s 占位符', () => {
    assert.equal(applyUrlTemplate('https://a.com/s?q={key}&p={page}', { key: '甲 乙', page: 2 }), 'https://a.com/s?q=%E7%94%B2%20%E4%B9%99&p=2');
    assert.equal(applyUrlTemplate('https://a.com/s?q=%s', { key: '甲' }), 'https://a.com/s?q=%E7%94%B2');
});

await test('URL：选项 JSON（方法 / 头 / body / 编码 / 重试）', () => {
    const split = splitUrlOption('https://a.com/search,{"method":"POST","body":"k=1"}');
    assert.equal(split.url, 'https://a.com/search');
    assert.equal(split.option.method, 'POST');
    const request = buildRequest('https://a.com/search?q={{key}},{"method":"POST","body":"q={{key}}","headers":{"Referer":"https://a.com"},"charset":"gbk","retry":2}', {
        key: '中文',
        page: 1,
        source: { bookSourceUrl: 'https://a.com' },
    });
    assert.equal(request.method, 'POST');
    assert.equal(request.retry, 2);
    assert.equal(request.charset, 'gbk');
    assert.equal(request.headers.Referer, 'https://a.com');
    assert.match(request.body, /%E4%B8%AD%E6%96%87|%D6%D0%CE%C4/);
    assert.equal(request.sourceKey, 'https://a.com');
});

/* ------------------------------------------------------------------ */
/* 书源模型                                                            */
/* ------------------------------------------------------------------ */

const LEGADO_SOURCE = {
    bookSourceName: '测试源',
    bookSourceUrl: 'https://example.com',
    bookSourceGroup: '玄幻,都市',
    bookSourceType: 0,
    enabled: true,
    enabledExplore: false,
    customOrder: 3,
    concurrentRate: '2/1000',
    searchUrl: 'https://example.com/search?q={{key}}&page={{page}}',
    ruleSearch: {
        bookList: 'class.result@tag.li',
        name: 'tag.a@text',
        author: 'class.author@text',
        bookUrl: 'tag.a@href',
        coverUrl: 'tag.img@src',
    },
    ruleBookInfo: '{"name":"class.info h1@text","tocUrl":"class.toc@href"}',
    ruleToc: { chapterList: 'class.chapters@tag.li', chapterName: 'tag.a@text', chapterUrl: 'tag.a@href', nextTocUrl: 'class.next@href' },
    ruleContent: { content: '#content@html', nextContentUrl: 'class.next@href', replaceRegex: '##广告##' },
};

await test('书源模型：导入 Legado 书源（规则对象 / JSON 字符串）', () => {
    const { sources, warnings } = importSources([LEGADO_SOURCE]);
    assert.equal(sources.length, 1);
    assert.equal(warnings.length, 0);
    const source = sources[0];
    assert.equal(source.bookSourceName, '测试源');
    assert.equal(source.enabledExplore, false);
    assert.equal(source.customOrder, 3);
    assert.equal(source.concurrentRate, '2/1000');
    assert.equal(source.ruleBookInfo.name, 'class.info h1@text');
    assert.equal(source.ruleBookInfo.tocUrl, 'class.toc@href');
    assert.equal(source.ruleContent.content, '#content@html');
    assert.deepEqual(splitSourceGroups(source.bookSourceGroup), ['玄幻', '都市']);
});

await test('设置：同一份书源数组走缓存，不重复转换', () => {
    const raw = [{ bookSourceName: '缓存源', bookSourceUrl: 'https://cache.test', searchUrl: 'https://cache.test/s?q={{key}}' }];
    const first = normalizeOnlineSettings({ sources: raw });
    const second = normalizeOnlineSettings({ sources: raw });
    assert.equal(first.sources.length, 1);
    assert.equal(first.sources[0].bookSourceName, '缓存源');
    assert.equal(first.sources, second.sources, '同一个数组引用应复用规范化结果');
    const third = normalizeOnlineSettings({ sources: [...raw] });
    assert.notEqual(first.sources, third.sources);
});

await test('书源模型：导出回 Legado 结构 / 校验提示', () => {
    const source = importSources([LEGADO_SOURCE]).sources[0];
    const exported = exportSource(source);
    assert.equal(exported.bookSourceName, '测试源');
    assert.equal(exported.ruleSearch.name, 'tag.a@text');
    assert.equal(exported.ruleBookInfo.tocUrl, 'class.toc@href');
    const issues = validateSource(source);
    assert.deepEqual(issues, []);
    const broken = normalizeSource({ bookSourceName: '坏源', bookSourceUrl: 'https://x.com', searchUrl: '', ruleToc: {}, ruleContent: {} });
    assert.ok(validateSource(broken).length >= 2);
});

await test('书源模型：识别是否用到 JS 规则', () => {
    assert.equal(sourceNeedsJs({ ruleSearch: { name: '{{1+2}}' } }), true);
    assert.equal(sourceNeedsJs({ ruleContent: { content: '@js:result' } }), true);
    assert.equal(sourceNeedsJs({ header: '<js>return 1</js>' }), true);
    assert.equal(sourceNeedsJs({ ruleSearch: { name: 'tag.a@text' }, ruleContent: { content: '#content@html' } }), false);
});

await test('书源模型：非 Legado 字段（本插件旧格式）也能收', () => {
    const { sources } = importSources([{ name: '旧源', url: 'https://old.com', search: { url: '/s?q={key}' } }]);
    assert.equal(sources[0].bookSourceName, '旧源');
    assert.equal(sources[0].searchUrl, '/s?q={key}');
    assert.equal(sources[0].native, true);
});

/* ------------------------------------------------------------------ */
/* 文本工具                                                            */
/* ------------------------------------------------------------------ */

await test('正文文本化：HTML → 多段文本', () => {
    const text = htmlToText('<div id="content"><p>第一段。</p><p>第二段<br>换行</p><script>alert(1)</script></div>');
    assert.equal(text, '第一段。\n\n第二段\n\n换行');
    assert.equal(normalizeParagraphs('a\r\n\r\n\r\n b '), 'a\n\nb');
    const rebuilt = rebuildParagraphs('这是一个很长的句子。'.repeat(120));
    assert.ok(rebuilt.includes('\n\n'));
});

/* ------------------------------------------------------------------ */
/* 流水线                                                              */
/* ------------------------------------------------------------------ */

const PAGES = new Map([
    ['https://example.com/search?q=%E4%B9%A6&page=1', SEARCH_HTML],
    ['https://example.com/book/1', '<div class="info"><h1>书一（详情）</h1><span class="author">作者一</span><div class="intro">详情简介</div><a class="toc" href="/book/1/toc">目录</a></div>'],
    ['https://example.com/book/1/toc', '<ul class="chapters"><li><a href="/book/1/1">第1章</a></li><li><a href="/book/1/2">第2章</a></li></ul><a class="next" href="/book/1/toc?p=2">下一页</a>'],
    ['https://example.com/book/1/toc?p=2', '<ul class="chapters"><li><a href="/book/1/3">第3章</a></li><li><a href="/book/1/4">第4章</a></li></ul>'],
    ['https://example.com/book/1/1', '<div id="content"><p>第一段。</p><p>第二段。</p><p>广告</p></div><a class="next" href="/book/1/1?p=2">下一页</a>'],
    ['https://example.com/book/1/1?p=2', '<div id="content"><p>第三段。</p></div>'],
    ['https://api.example.com/search?q=A&page=1', JSON.stringify({ data: [{ name: 'API书', author: 'API作者', url: 'https://api.example.com/book/9', kind: '科幻', intro: 'API简介' }] })],
]);

function fakeClient() {
    return {
        requestWithRetry: async request => {
            const text = PAGES.get(request.url);
            if (text == null) throw new Error(`没有这个页面：${request.url}`);
            return { text, finalUrl: request.url, status: 200, headers: {}, via: 'fake' };
        },
    };
}

const PIPELINE_SOURCE = normalizeSource({
    bookSourceName: '测试源',
    bookSourceUrl: 'https://example.com',
    searchUrl: 'https://example.com/search?q={{key}}&page={{page}}',
    ruleSearch: {
        bookList: 'class.result@tag.li',
        name: 'tag.a@text',
        author: 'class.author@text',
        intro: 'class.intro@text',
        bookUrl: 'tag.a@href',
        coverUrl: 'tag.img@src',
    },
    ruleBookInfo: {
        name: 'class.info@tag.h1@text',
        author: 'class.author@text',
        intro: 'class.intro@text',
        tocUrl: 'class.toc@href',
    },
    ruleToc: {
        chapterList: 'class.chapters@tag.li',
        chapterName: 'tag.a@text',
        chapterUrl: 'tag.a@href',
        nextTocUrl: 'class.next@href',
    },
    ruleContent: {
        content: '#content@html',
        nextContentUrl: 'class.next@href',
        replaceRegex: '##广告##',
    },
});

await test('流水线：搜索 → 详情 → 目录（两页）→ 正文（两页 + 替换）', async () => {
    const pipeline = new BookPipeline({ client: fakeClient(), onWarning: () => {} });
    const searched = await pipeline.search(PIPELINE_SOURCE, '书');
    assert.equal(searched.books.length, 3);
    assert.equal(searched.books[0].name, '书一');
    assert.equal(searched.books[0].author, '作者一');
    assert.equal(searched.books[0].bookUrl, 'https://example.com/book/1');
    assert.equal(searched.books[0].coverUrl, 'https://example.com/cover/1.jpg');

    const info = await pipeline.info(PIPELINE_SOURCE, searched.books[0]);
    assert.equal(info.name, '书一（详情）');
    assert.equal(info.intro, '详情简介');
    assert.equal(info.tocUrl, 'https://example.com/book/1/toc');

    const toc = await pipeline.toc(PIPELINE_SOURCE, info);
    assert.equal(toc.pages, 2);
    assert.deepEqual(toc.chapters.map(chapter => chapter.title), ['第1章', '第2章', '第3章', '第4章']);
    assert.equal(toc.chapters[2].url, 'https://example.com/book/1/3');

    const content = await pipeline.content(PIPELINE_SOURCE, info, toc.chapters[0]);
    assert.equal(content.title, '第1章');
    assert.match(content.text, /第一段/);
    assert.match(content.text, /第三段/);
    assert.ok(!content.text.includes('广告'), '替换规则应清掉广告');
    assert.equal(content.pages, 2);
});

await test('流水线：书源请求头会合并进请求', async () => {
    let captured = null;
    const client = {
        requestWithRetry: async request => {
            captured = request;
            return { text: SEARCH_HTML, finalUrl: request.url, status: 200, headers: {} };
        },
    };
    const source = normalizeSource({
        bookSourceName: '带头源',
        bookSourceUrl: 'https://example.com',
        header: '{"Referer":"https://example.com/","X-Test":"1"}',
        searchUrl: 'https://example.com/search?q={{key}}',
        ruleSearch: { bookList: 'class.result@tag.li', name: 'tag.a@text', bookUrl: 'tag.a@href' },
    });
    const pipeline = new BookPipeline({ client, onWarning: () => {} });
    await pipeline.search(source, '书');
    assert.equal(captured.headers.Referer, 'https://example.com/');
    assert.equal(captured.headers['X-Test'], '1');
});

await test('流水线：JSON API 源', async () => {
    const source = normalizeSource({
        bookSourceName: 'API源',
        bookSourceUrl: 'https://api.example.com',
        searchUrl: 'https://api.example.com/search?q={{key}}&page={{page}}',
        ruleSearch: {
            bookList: '$.data[*]',
            name: '$.name',
            author: '$.author',
            bookUrl: '$.url',
            kind: '$.kind',
            intro: '$.intro',
        },
    });
    const pipeline = new BookPipeline({ client: fakeClient(), onWarning: () => {} });
    const result = await pipeline.search(source, 'A');
    assert.equal(result.books.length, 1);
    assert.equal(result.books[0].name, 'API书');
    assert.equal(result.books[0].author, 'API作者');
    assert.equal(result.books[0].kind, '科幻');
});

await test('JS 沙箱：{{java.ajax}} 走异步执行器', async () => {
    const client = {
        requestWithRetry: async request => ({ text: '<html></html>', finalUrl: request.url, status: 200, headers: {} }),
    };
    const jsRunner = async ({ code, result }) => {
        const sandbox = {
            result,
            java: { ajax: () => JSON.stringify({ data: [{ name: 'AJAX书', url: 'https://js.test/1' }] }) },
        };
        // eslint-disable-next-line no-new-func
        return new Function('__scope', '__code', 'with (__scope) { return eval(__code); }')(sandbox, code);
    };
    const source = normalizeSource({
        bookSourceName: 'JS源',
        bookSourceUrl: 'https://js.test',
        searchUrl: 'https://js.test/search?q={{key}}',
        ruleSearch: {
            bookList: '{{java.ajax("https://js.test/api")}}@Json:$.data[*]',
            name: '$.name',
            bookUrl: '$.url',
        },
    });
    const pipeline = new BookPipeline({ client, jsRunner, onWarning: () => {} });
    const result = await pipeline.search(source, '书');
    assert.equal(result.books.length, 1);
    assert.equal(result.books[0].name, 'AJAX书');
    assert.equal(result.books[0].bookUrl, 'https://js.test/1');
});

await test('网络：并发率解析', () => {
    assert.deepEqual(parseConcurrentRate('3/1000'), { limit: 3, interval: 1000 });
    assert.deepEqual(parseConcurrentRate('1500'), { limit: 1500, interval: 1500 });
    assert.equal(parseConcurrentRate('abc'), null);
    assert.equal(parseConcurrentRate(''), null);
});


/* ------------------------------------------------------------------ */
/* 服务端抓取（纯函数）                                                 */
/* ------------------------------------------------------------------ */

await test('服务端：只放行公网 http(s)', () => {
    assert.equal(isAllowedTarget('https://example.com/a'), true);
    assert.equal(isAllowedTarget('http://example.com/a'), true);
    assert.equal(isAllowedTarget('http://127.0.0.1/a'), false);
    assert.equal(isAllowedTarget('http://192.168.1.2/a'), false);
    assert.equal(isAllowedTarget('http://10.0.0.8/a'), false);
    assert.equal(isAllowedTarget('file:///etc/passwd'), false);
    assert.equal(isAllowedTarget('not a url'), false);
});

await test('服务端：GBK / UTF-8 解码', () => {
    const gbk = Uint8Array.from([0xB9, 0xC5, 0xC3, 0xD8, 0xD6, 0xAE, 0xD6, 0xF7]);
    const decoded = decodeBody(gbk, 'text/html; charset=gbk');
    assert.equal(decoded.charset, 'gb18030');
    assert.equal(decoded.text, '古秘之主');
    const utf8 = new TextEncoder().encode('诡秘之主');
    assert.equal(decodeBody(utf8, 'text/html').text, '诡秘之主');
});

await test('服务端：Cookie 罐按源 / 域隔离', () => {
    clearCookies('src-a');
    clearCookies('src-b');
    absorbSetCookie('src-a', 'https://a.com/1', ['uid=1; Path=/', 'token=t1; Path=/']);
    absorbSetCookie('src-a', 'https://b.com/1', ['uid=2; Path=/']);
    absorbSetCookie('src-b', 'https://a.com/1', ['uid=9; Path=/']);
    assert.equal(getCookieHeader('src-a', 'https://a.com/2'), 'uid=1; token=t1');
    assert.equal(getCookieHeader('src-a', 'https://b.com/2'), 'uid=2');
    assert.equal(getCookieHeader('src-b', 'https://a.com/2'), 'uid=9');
    clearCookies('src-a');
    assert.equal(getCookieHeader('src-a', 'https://a.com/2'), '');
});

await test('服务端：登录头优先作为 Cookie', () => {
    clearCookies('src-login');
    putLoginHeader('src-login', JSON.stringify({ Cookie: 'sid=abc; theme=dark' }));
    assert.equal(getCookieHeader('src-login', 'https://x.com'), 'sid=abc; theme=dark');
    putLoginHeader('src-login', 'raw=1');
    assert.equal(getCookieHeader('src-login', 'https://x.com'), 'raw=1');
    clearCookies('src-login');
    assert.equal(getCookieHeader('src-login', 'https://x.com'), '');
});

await test('设置迁移：旧书源自动转成新模型', () => {
    const legacy = {
        name: '旧源',
        url: 'https://old.com',
        group: '老分组',
        enabled: true,
        search: { url: '/s?q={key}', list: 'class.x@tag.li', title: 'tag.a@text', link: 'tag.a@href' },
        book: { tocList: 'class.list@tag.li', chapterTitle: 'tag.a@text', chapterUrl: 'tag.a@href' },
        chapter: { content: '#content@html' },
    };
    const settings = normalizeOnlineSettings({ sources: [legacy] });
    const source = settings.sources[0];
    assert.equal(source.bookSourceName, '旧源');
    assert.equal(source.searchUrl, '/s?q={key}');
    assert.equal(source.ruleSearch.bookList, 'class.x@tag.li');
    assert.equal(source.ruleToc.chapterList, 'class.list@tag.li');
    assert.equal(source.ruleContent.content, '#content@html');
    assert.equal(source.bookSourceGroup, '老分组');
    const again = normalizeOnlineSettings({ sources: settings.sources });
    assert.equal(again.sources[0].bookSourceName, '旧源');
});

/* ------------------------------------------------------------------ */
/* 运行时：多源搜索 / 打开书 / 校验 / 发现                              */
/* ------------------------------------------------------------------ */

function fakeClientWithRate() {
    const client = fakeClient();
    client.setRateLimit = () => {};
    return client;
}

const RUNTIME_SOURCE = normalizeSource({
    bookSourceName: '测试源',
    bookSourceUrl: 'https://example.com',
    searchUrl: 'https://example.com/search?q={{key}}&page={{page}}',
    ruleSearch: { bookList: 'class.result@tag.li', name: 'tag.a@text', author: 'class.author@text', bookUrl: 'tag.a@href' },
    ruleBookInfo: { name: 'class.info@tag.h1@text', tocUrl: 'class.toc@href' },
    ruleToc: { chapterList: 'class.chapters@tag.li', chapterName: 'tag.a@text', chapterUrl: 'tag.a@href', nextTocUrl: 'class.next@href' },
    ruleContent: { content: '#content@html', nextContentUrl: 'class.next@href' },
    exploreUrl: '玄幻::https://example.com/list?type=1\n都市::https://example.com/list?type=2',
});

await test('运行时：多源搜索返回逐源状态', async () => {
    const runtime = new SourceRuntime({
        client: fakeClientWithRate(),
        settings: { sources: [RUNTIME_SOURCE], channel: 'auto', timeoutMs: 15000 },
    });
    const result = await runtime.searchAll('书', { concurrency: 2 });
    assert.equal(result.books.length, 3);
    assert.equal(result.perSource.length, 1);
    assert.equal(result.perSource[0].count, 3);
    assert.equal(result.perSource[0].error, '');
    assert.equal(result.books[0].sourceName, '测试源');
    assert.equal(result.books[0].sourceOrder, 0);
});

await test('运行时：打开书（详情 + 目录）与抓正文', async () => {
    const runtime = new SourceRuntime({
        client: fakeClientWithRate(),
        settings: { sources: [RUNTIME_SOURCE] },
    });
    const book = await runtime.openBook('https://example.com/book/1');
    assert.equal(book.title, '书一（详情）');
    assert.equal(book.sourceId, 'https://example.com');
    assert.equal(book.chapters.length, 4);
    const content = await runtime.fetchChapter({ url: 'https://example.com/book/1/1', title: '第1章' }, { sourceId: book.sourceId });
    assert.match(content.text, /第一段/);
    assert.match(content.text, /第三段/);
});

await test('运行时：书源校验四段', async () => {
    const runtime = new SourceRuntime({
        client: fakeClientWithRate(),
        settings: { sources: [RUNTIME_SOURCE] },
    });
    const check = await runtime.validate(RUNTIME_SOURCE, { keyword: '书' });
    assert.equal(check.ok, true);
    assert.deepEqual(check.steps.map(step => step.name), ['搜索', '详情', '目录', '正文']);
    assert.ok(check.steps.every(step => step.ok));
});

await test('运行时：刷新已入库的书', async () => {
    const runtime = new SourceRuntime({
        client: fakeClientWithRate(),
        settings: { sources: [RUNTIME_SOURCE] },
    });
    const result = await runtime.refreshBook({ sourceId: 'https://example.com', bookUrl: 'https://example.com/book/1', title: '书一' });
    assert.equal(result.book.name, '书一（详情）');
    assert.equal(result.chapters.length, 4);
    assert.equal(result.source.bookSourceName, '测试源');
});

await test('换源：书名归一化与进度对齐', () => {
    assert.equal(normalizeBookName('《诡秘之主》 第一部！'), '诡秘之主第一部');
    const oldChapters = [{ title: '第1章 开端' }, { title: '第2章 风起' }, { title: '第3章 落幕' }];
    const same = alignChapterIndex(oldChapters, [{ title: '第1章 开端' }, { title: '第2章 风起' }, { title: '第3章 落幕' }], 1);
    assert.deepEqual(same, { index: 1, matched: true });
    const renamed = alignChapterIndex(oldChapters, [{ title: '第一章 开端' }, { title: '第二章 风起' }, { title: '第三章 落幕' }], 2);
    assert.equal(renamed.matched, false);
    assert.equal(renamed.index, 2);
    const shorter = alignChapterIndex(oldChapters, [{ title: '第1章 开端' }, { title: '第2章 风起' }], 2);
    assert.equal(shorter.index, 1);
});

await test('运行时：发现地址解析', async () => {
    const runtime = new SourceRuntime({ client: fakeClientWithRate(), settings: { sources: [RUNTIME_SOURCE] } });
    const entries = runtime.parseExplore(RUNTIME_SOURCE);
    assert.deepEqual(entries.map(entry => entry.title), ['玄幻', '都市']);
    assert.equal(entries[0].url, 'https://example.com/list?type=1');
    const json = runtime.parseExplore({ exploreUrl: '[{"title":"全部","url":"/all"}]' });
    assert.equal(json[0].url, '/all');
    // @js 的发现地址走 exploreEntries（需要沙箱）；没有沙箱时给出明确错误
    await assert.rejects(runtime.exploreEntries({ exploreUrl: '@js:[]' }), /Worker/);
    // 沙箱可用时，JS 返回的 JSON 数组也能解析
    runtime.sandbox = { evaluate: async () => JSON.stringify([{ title: '玄幻', url: '/x?t=1' }]) };
    const jsEntries = await runtime.exploreEntries({ bookSourceUrl: 'https://example.com', exploreUrl: '@js:[]' });
    assert.deepEqual(jsEntries, [{ title: '玄幻', url: '/x?t=1' }]);
});
await test('网络：respectRateLimit 开关决定是否按书源并发率节流', async () => {
    const { NetClient } = await import('../js/net/client.js');
    const client = new NetClient({ fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, text: '<html></html>', status: 200, finalUrl: 'https://x.test', headers: {} }) }) });
    // 默认不遵守：即使源写了 1/1000，也不该限速
    client.setRateLimit('https://x.test', '1/1000');
    assert.equal(client.rateLimits.size, 0);
    // 打开开关才登记限速
    client.respectRateLimit = true;
    client.setRateLimit('https://x.test', '1/1000');
    assert.deepEqual(client.rateLimits.get('https://x.test'), { limit: 1, interval: 1000 });
    // 关掉开关要把残留的限制清掉
    client.respectRateLimit = false;
    client.setRateLimit('https://x.test', '1/1000');
    assert.equal(client.rateLimits.has('https://x.test'), false);
});

await test('正文：站点回错误 JSON 时不当正文', async () => {
    const { describeApiError } = await import('../js/book/pipeline.js');
    assert.match(describeApiError('{"code":1001,"message":"转码失败"}'), /转码失败/);
    assert.match(describeApiError('{"code":1001,"message":"转码失败"}'), /登录|Cookie|失效/);
    assert.equal(describeApiError('正常正文内容'), '');
    assert.equal(describeApiError('{"data":{"content":"x"}}'), '');
});

await test('正文：站点用错误页冒充正文时判失败', async () => {
    const { describeContentError } = await import('../js/book/pipeline.js');
    const page = '转码失败！请您使用右上换源切换源站阅读或者直接前往源网站进行阅读！';
    assert.match(describeContentError(page), /不是正文/);
    assert.match(describeContentError(page), /转码失败/);
    assert.match(describeContentError('访问过于频繁，请稍后再试'), /不是正文/);
    assert.match(describeContentError('', { pageText: page }), /不是正文/);
    // 正常正文里出现这些词不算错误（正文够长）
    const long = ('他看了一眼屏幕上的验证码，随手输进去。' + '这一段是正常的小说正文，用来把长度撑开。'.repeat(40));
    assert.equal(describeContentError(long), '');
    assert.equal(describeContentError('第一章 他开始修道'), '');
});

await test('正文：流水线拿到错误页直接抛错，不写进书架', async () => {
    const source = {
        bookSourceUrl: 'https://err.test',
        ruleContent: { content: '#content@text' },
    };
    const client = {
        async requestWithRetry() {
            return {
                status: 200,
                finalUrl: 'https://err.test/1.html',
                text: '<html><div id="content">转码失败！请您使用右上换源切换源站阅读或者直接前往源网站进行阅读！</div></html>',
                headers: {},
            };
        },
    };
    const pipeline = new BookPipeline({ client });
    let message = '';
    try {
        await pipeline.content(source, { name: '书' }, { title: '第1章', url: 'https://err.test/1.html' });
    } catch (error) {
        message = error.message;
    }
    assert.match(message, /不是正文/);
});

const GUESS_PAGE = (() => {
    const nav = '<div class="nav"><a href="https://g.test/">首页</a><a href="https://g.test/fenlei/1/1.html">玄幻小说</a>'
        + '<a href="https://g.test/paihangbang/">排行榜单</a><a href="javascript:addBookCase(410);">加入书架</a></div>';
    const chapters = Array.from({ length: 40 }, (_, i) => `<dd><a href ="/guimizhizhu/${100 + i}.html">第${i + 1}章 标题</a></dd>`).join('');
    return `<html><body>${nav}<div class="listmain"><dl><dt>《诡秘之主》正文卷</dt>${chapters}</dl></div></body></html>`;
})();

await test('详情兜底：规则没命中时用 og:novel:* 补书名 / 作者', async () => {
    const html = `<html><head><title>诡秘之主_最新章节_诡秘之主全文在线阅读</title>
        <meta property="og:novel:book_name" content="诡秘之主"/>
        <meta property="og:novel:author" content="爱潜水的乌贼"/>
        <meta property="og:description" content="蒸汽与机械的浪潮中"/>
        <meta property="og:image" content="http://g.test/410s.jpg"/>
        <meta property="og:novel:latest_chapter_name" content="完本感言"/>
        </head><body></body></html>`;
    const pipeline = new BookPipeline({ client: { requestWithRetry: async () => ({ text: html, finalUrl: 'https://g.test/b/1' }) } });
    const filled = pipeline.metaFallback(html, {});
    assert.equal(filled.name, '诡秘之主');
    assert.equal(filled.author, '爱潜水的乌贼');
    assert.match(filled.intro, /蒸汽与机械/);
    assert.equal(filled.coverUrl, 'http://g.test/410s.jpg');
    assert.equal(filled.latestChapterTitle, '完本感言');
    // 已经有书名就不覆盖
    assert.equal(pipeline.metaFallback(html, { name: '已知书名' }).name, '已知书名');
    // 没有 og 时退回 <title> 的第一段
    const plain = pipeline.metaFallback('<title>某本书_最新章节</title>', {});
    assert.equal(plain.name, '某本书');
});

await test('目录兜底：规则没命中时按页面结构猜出章节', async () => {
    const client = {
        requestWithRetry: async request => ({ text: GUESS_PAGE, finalUrl: request.url, status: 200, headers: {} }),
    };
    const pipeline = new BookPipeline({ client });
    const res = await pipeline.tocGuess({ bookSourceUrl: 'https://g.test', ruleToc: {} }, { bookUrl: 'https://g.test/guimizhizhu/' });
    assert.equal(res.guessed, true);
    assert.equal(res.chapters.length, 40);
    assert.equal(res.chapters[0].title, '第1章 标题');
    // href 写成 `href ="/x"`（等号前带空格）也要认
    assert.equal(res.chapters[0].url, 'https://g.test/guimizhizhu/100.html');
    assert.deepEqual(res.chapters.slice(-1).map(item => item.title), ['第40章 标题']);
    // 导航 / 分类 / 排行榜 / javascript: 都不该混进来
    assert.equal(res.chapters.some(item => /首页|玄幻|排行榜|加入书架/.test(item.title)), false);
});

await test('运行时：目录规则没命中时自动猜目录，并标记 tocGuessed', async () => {
    const client = {
        requestWithRetry: async request => ({ text: GUESS_PAGE, finalUrl: request.url, status: 200, headers: {} }),
        setRateLimit() {},
    };
    const source = normalizeSource({
        bookSourceName: '猜源',
        bookSourceUrl: 'https://g.test',
        ruleBookInfo: { name: 'tag.h1@text' },
        ruleToc: { chapterList: '#nope', chapterName: 'tag.a@text', chapterUrl: 'tag.a@href' },
        ruleContent: { content: '#content@html' },
    });
    const runtime = new SourceRuntime({ client, settings: { sources: [source], channel: 'auto', timeoutMs: 15000 } });
    const result = await runtime.refreshBook({ bookUrl: 'https://g.test/guimizhizhu/' }, { withInfo: false });
    assert.equal(result.chapters.length, 40);
    assert.equal(result.book.tocGuessed, true);
    assert.match(result.chapters[0].url, /100\.html$/);
});

await test('运行时：桥接 ping', async () => {
    const runtime = new SourceRuntime({ client: fakeClientWithRate(), settings: { sources: [], fanqieBridge: '/api/plugins/fanqie-bridge' } });
    runtime.fetchImpl = async url => ({ ok: true, json: async () => ({ ok: true, version: '1.2.0', url }) });
    const ping = await runtime.bridgePing();
    assert.equal(ping.ok, true);
    assert.equal(ping.version, '1.2.0');
    runtime.fetchImpl = async () => { throw new Error('refused'); };
    const failed = await runtime.bridgePing();
    assert.equal(failed.ok, false);
    assert.match(failed.error, /refused/);
});

await test('运行时：调试接口返回四段结果', async () => {
    const runtime = new SourceRuntime({ client: fakeClientWithRate(), settings: { sources: [RUNTIME_SOURCE] } });
    const debug = await runtime.debug(RUNTIME_SOURCE, { keyword: '书' });
    assert.equal(debug.ok, true);
    assert.deepEqual(debug.steps.map(step => step.name), ['搜索', '详情', '目录', '正文']);
    assert.ok(debug.steps[0].summary.includes('3'));
});

console.log(`\n书源内核测试全部通过：${passed} 项`);
