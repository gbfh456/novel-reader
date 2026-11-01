/**
 * 阅读器增强测试：替换规则、分卷目录、朗读设置等纯逻辑。
 * 运行：node dev/test-reader.mjs
 */
import assert from 'node:assert/strict';
import { applyReplaceRules, exportReplaceRules, importReplaceRules, normalizeReplaceRules } from '../js/replace.js';
import { SourceRuntime } from '../js/source/runtime.js';
import { extractImages } from '../js/book/text.js';
import { BookPipeline } from '../js/book/pipeline.js';
import { normalizeSource } from '../js/source/model.js';
import { DEFAULT_SETTINGS } from '../js/settings.js';

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

await test('替换规则：正则 / 字面量 / 作用范围 / 启用开关', () => {
    const rules = normalizeReplaceRules([
        { name: '去广告', pattern: '广告\\d+', replacement: '', isRegex: true, scope: 'content' },
        { name: '改书名', pattern: '（精校版）', replacement: '', isRegex: false, scope: 'title' },
        { name: '停用', pattern: 'abc', replacement: 'x', enabled: false },
    ]);
    assert.equal(rules.length, 3);
    assert.equal(applyReplaceRules('正文广告123广告456', rules, 'content'), '正文');
    assert.equal(applyReplaceRules('书名（精校版）', rules, 'title'), '书名');
    assert.equal(applyReplaceRules('abc', rules, 'content'), 'abc', '停用规则不生效');
});

await test('替换规则：导入 / 导出 / 非法正则提示', () => {
    const { rules, warnings } = importReplaceRules(JSON.stringify([
        { name: 'A', pattern: 'a', replacement: 'b', isRegex: true },
    ]));
    assert.equal(rules.length, 1);
    assert.deepEqual(warnings, []);
    const exported = exportReplaceRules(rules);
    assert.equal(exported[0].pattern, 'a');
    const bad = importReplaceRules([{ name: '坏', pattern: '([', replacement: '' }]);
    assert.equal(bad.warnings.length, 1);
    assert.equal(applyReplaceRules('([', bad.rules, 'content'), '([', '非法正则被跳过');
});

await test('图片：从正文 HTML 提取图片地址', () => {
    const images = extractImages(
        '<div><img src="/a.jpg"><img data-src="https://cdn.test/b.jpg"><img src="data:image/png;base64,AAA"></div>',
        'https://site.test/chapter/1',
    );
    assert.deepEqual(images, ['https://site.test/a.jpg', 'https://cdn.test/b.jpg', 'data:image/png;base64,AAA']);
    assert.deepEqual(extractImages('<p>没有图片</p>', 'https://x.test'), []);
});

await test('设置默认值：章节顺序 / 替换规则 / 朗读语速', () => {
    assert.equal(DEFAULT_SETTINGS.chapterOrder, 'asc');
    assert.deepEqual(DEFAULT_SETTINGS.replaceRules, []);
    assert.equal(DEFAULT_SETTINGS.ttsRate, 1);
    assert.deepEqual(DEFAULT_SETTINGS.onlineHistory, []);
});

/* ------------------------------------------------------------------ */
/* 分卷目录 + 替换规则在运行时生效                                      */
/* ------------------------------------------------------------------ */

const PAGES = new Map([
    ['https://v.test/book/1', '<div class="info"><h1>分卷书</h1><a class="toc" href="/book/1/toc">目录</a></div>'],
    ['https://v.test/book/1/toc', `<ul class="chapters">
        <li data-volume="true"><a>第一卷 风起</a></li>
        <li><a href="/book/1/1">第1章 开始</a></li>
        <li><a href="/book/1/2">第2章 继续</a></li>
    </ul>`],
    ['https://v.test/book/1/1', '<div id="content"><p>正文广告123</p></div>'],
]);

function fakeClient() {
    return {
        setRateLimit() {},
        requestWithRetry: async request => {
            const text = PAGES.get(request.url);
            if (text == null) throw new Error(`没有页面 ${request.url}`);
            return { text, finalUrl: request.url, status: 200, headers: {} };
        },
    };
}

const VOLUME_SOURCE = normalizeSource({
    bookSourceName: '分卷源',
    bookSourceUrl: 'https://v.test',
    ruleBookInfo: { name: 'class.info@tag.h1@text', tocUrl: 'class.toc@href' },
    ruleToc: {
        chapterList: 'class.chapters@tag.li',
        chapterName: 'tag.a@text',
        chapterUrl: 'tag.a@href',
        isVolume: '@data-volume',
    },
    ruleContent: { content: '#content@text' },
});

await test('图片章：正文规则返回 HTML 时带上图片', async () => {
    const pages = new Map([
        ['https://i.test/book/1', '<div class="info"><h1>图册</h1><a class="toc" href="/book/1/toc">目录</a></div>'],
        ['https://i.test/book/1/toc', '<ul class="chapters"><li><a href="/book/1/1">第1话</a></li></ul>'],
        ['https://i.test/book/1/1', '<div id="content"><img src="/img/1.jpg"><img data-src="/img/2.jpg"></div>'],
    ]);
    const client = {
        setRateLimit() {},
        requestWithRetry: async request => ({ text: pages.get(request.url) || '', finalUrl: request.url, status: 200, headers: {} }),
    };
    const source = normalizeSource({
        bookSourceName: '图源',
        bookSourceUrl: 'https://i.test',
        ruleBookInfo: { name: 'class.info@tag.h1@text', tocUrl: 'class.toc@href' },
        ruleToc: { chapterList: 'class.chapters@tag.li', chapterName: 'tag.a@text', chapterUrl: 'tag.a@href' },
        ruleContent: { content: '#content@html' },
    });
    const pipeline = new BookPipeline({ client, onWarning: () => {} });
    const book = await pipeline.info(source, { bookUrl: 'https://i.test/book/1' });
    const toc = await pipeline.toc(source, book);
    const content = await pipeline.content(source, book, toc.chapters[0]);
    assert.deepEqual(content.images, ['https://i.test/img/1.jpg', 'https://i.test/img/2.jpg']);
});

await test('运行时：分卷保留在目录里，正文替换规则生效', async () => {
    const runtime = new SourceRuntime({
        client: fakeClient(),
        settings: {
            sources: [VOLUME_SOURCE],
            replaceRules: [{ name: '去广告', pattern: '广告\\d+', replacement: '', isRegex: true, scope: 'content' }],
        },
    });
    const book = await runtime.openBook('https://v.test/book/1');
    assert.equal(book.chapters.length, 3);
    assert.equal(book.chapters[0].isVolume, true);
    assert.match(book.chapters[0].url, /^volume:/);
    const content = await runtime.fetchChapter({ title: '第1章 开始', url: 'https://v.test/book/1/1' }, { sourceId: book.sourceId });
    assert.equal(content.text, '正文');
});

console.log(`\n阅读器增强测试全部通过：${passed} 项`);
