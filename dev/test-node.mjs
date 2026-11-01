/**
 * 无浏览器环境下可运行的核心逻辑测试。
 * 运行：node dev/test-node.mjs
 */
import assert from 'node:assert/strict';
import iconv from 'iconv-lite';
import {
    decodeBookBytes,
    isChapterHeading,
    normalizeText,
    parseNovelFile,
    splitChapters,
    stripMarkdown,
} from '../js/parse.js';
import { buildPlan, runSummary } from '../js/summary.js';
import { DEFAULT_SETTINGS, computeBudget, maxTargetChars, resolveStrategy } from '../js/settings.js';
import { countChars, estimateTokens, sleep, trimToLimit } from '../js/util.js';
import {
    WORLDBOOK_CATEGORIES,
    assembleMergedEntries,
    buildPlotRanges,
    entryCharLimit,
    estimateWorldbookUsage,
    generateWorldbook,
    mergeWorldbookEntries,
    parseWorldbookResponse,
    toCharacterCard,
    toSillyTavernWorldbook,
    worldbookOutputPlan,
} from '../js/worldbook.js';
import {
    analyzeSampleStyle,
    analyzeStyleFormat,
    buildStyleSkeleton,
    buildStyleAdaptPrompt,
    buildStylePlan,
    checkStyleOutput,
    defaultStyleEntry,
    detectPov,
    extractStyleSample,
    fitStyleOutput,
    groupStyleEntries,
    isUsableStyleContent,
    parseStyleAdaptOutput,
    scoreStyleEntry,
    stylePasteHint,
} from '../js/style.js';
import {
    importCharacterCardToTavern,
    installEmbeddedWorldbookAutoImport,
    installPresetChangeWatcher,
    readSelectedChatPreset,
    tavernCharacterNames,
    uniqueName,
    worldbookExists,
} from '../js/tavern.js';
import {
    buildOrganizePrompt,
    dedupeKeywords,
    entryNameKey,
    findDuplicateGroups,
    mergeDuplicateGroups,
    mergeEntries,
    normalizeEntryName,
    organizeEntryContent,
    organizeWorldbookEntries,
    parseDuplicateJudgement,
    parseOrganizeResponse,
    pickMainName,
} from '../js/organize.js';
import {
    buildSnippet,
    findOccurrences,
    findPageForOccurrence,
    normalizeSearchQuery,
    splitHighlight,
} from '../js/search.js';
import {
    MEMO_MAX_CHARS,
    buildMemoExportMarkdown,
    countMemosByChapter,
    filterMemos,
    memoAnchorLabel,
    memoChapterLabel,
    memoClipboardText,
    memoTitle,
    memoTitleFromContent,
    memosInScope,
    sanitizeMemoInput,
    sortMemoGroups,
    sortMemos,
} from '../js/memo.js';
import {
    FanqieClient,
    fanqieBookIdFromUrl,
    fanqieBookSummary,
    fanqieBookUrl,
    formatFanqieNumber,
    isFanqieBook,
    isFanqieUrl,
    mapFanqiePreview,
    mapFanqieSearchItems,
    normalizeFanqieBridge,
    parseFanqieBookText,
    summarizeFanqieJob,
} from '../js/fanqie.js';
import {
    buildSourceSearchUrl,
    convertLegadoRule,
    importSources,
    mergeSources,
    normalizeSource,
    parseRule,
    parseSourceBookPage,
    parseSourceChapterPage,
    parseSourceSearchPage,
    pickSource,
    requestSourceCollection,
    sourceMatchesUrl,
} from '../js/source.js';
import {
    buildShelfView,
    countByGroup,
    moveInList,
    nextGroupOrder,
    normalizeShelfSort,
    orderMapFromIds,
    relativeTime,
    sortShelfGroups,
    sortShelfNovels,
} from '../js/shelf.js';
import { mergeSourceResults } from '../js/network.js';
import {
    NovelFetcher,
    bookIdFromUrl,
    buildBookText,
    buildProxyUrl,
    cleanBookTitle,
    cleanChapterLines,
    decodeEntities,
    decodeHtmlBytes,
    detectCharset,
    isChapterTitle,
    normalizeOnlineSettings,
    normalizeUrl,
    parseBookPage,
    parseChapterPage,
    parseHtml,
    parseSearchPage,
    querySelector,
    querySelectorAll,
    textOf,
    toLines,
} from '../js/network.js';

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

await test('normalizeText 统一换行与空白', () => {
    assert.equal(normalizeText('a\r\n b \r\n\r\n\r\nc'), 'a\n b\n\nc');
});

await test('isChapterHeading 识别常见章节标题', () => {
    for (const title of ['第一章 雨夜', '第12回 归来', '序章', '楔子', '番外一', 'Chapter 3', '# 第一卷']) {
        assert.equal(isChapterHeading(title), true, title);
    }
    assert.equal(isChapterHeading('他推开门，看见雨还在下。'), false);
});

await test('splitChapters 按标题切章并保留标题', () => {
    const body = '这是一段长度足够的正文，用来验证章节切分不会把正常章节当成空章节合并。';
    const text = ['第一章 开始', body, '第二章 继续', body, '第三章 结束', body].join('\n');
    const chapters = splitChapters(text);
    assert.equal(chapters.length, 3);
    assert.equal(chapters[0].title, '第一章 开始');
    assert.equal(chapters[1].title, '第二章 继续');
    assert.match(chapters[1].content, /长度足够的正文/);
});

await test('splitChapters 无标题时按长度切分', () => {
    const text = '甲'.repeat(20000);
    const chapters = splitChapters(text, { maxChars: 5000 });
    assert.ok(chapters.length >= 4);
    assert.ok(chapters.every(chapter => countChars(chapter.content) <= 5200));
});

await test('decodeBookBytes 识别 GBK', () => {
    const source = '第一章 雨夜\n\n这是一段 GBK 编码的中文正文。';
    const decoded = decodeBookBytes(iconv.encode(source, 'gbk'));
    assert.equal(decoded.text, source);
    assert.match(decoded.encoding, /gb/i);
});

await test('stripMarkdown 去掉常见标记', () => {
    const plain = stripMarkdown('# 标题\n\n**粗体** 与 [链接](https://example.com)\n\n- 列表');
    assert.match(plain, /标题/);
    assert.match(plain, /粗体/);
    assert.match(plain, /链接/);
    assert.doesNotMatch(plain, /https:\/\/example\.com/);
});

await test('trimToLimit 不超过上限', () => {
    const source = '第一句话。第二句话。第三句话。';
    for (const limit of [5, 10, 20]) {
        const result = trimToLimit(source, limit);
        assert.ok(result.length <= limit, `${result.length} > ${limit}`);
    }
});

await test('estimateTokens 对中文保守且随长度增长', () => {
    assert.ok(estimateTokens('中'.repeat(1000)) >= 1000);
    assert.ok(estimateTokens('中'.repeat(2000)) > estimateTokens('中'.repeat(1000)));
});

await test('computeBudget 保持输入预算为正且小于总预算', () => {
    const budget = computeBudget({ ...DEFAULT_SETTINGS, contextTokens: 8192, contextRatio: 0.7, outputReserve: 1024 });
    assert.equal(budget.ctxTokens, 8192);
    assert.equal(budget.totalBudget, Math.floor(8192 * 0.7));
    assert.ok(budget.inputBudget > 0);
    assert.ok(budget.inputBudget < budget.totalBudget);
});

await test('buildPlan 短文本走 direct，长文本走 mapreduce', () => {
    const budget = computeBudget({ ...DEFAULT_SETTINGS, contextTokens: 8192 });
    const short = buildPlan({
        chapters: [{ index: 0, title: '第一章', text: '短文本'.repeat(100) }],
        targetChars: 800,
        budget,
    });
    assert.equal(short.mode, 'direct');

    const long = buildPlan({
        chapters: Array.from({ length: 20 }, (_, index) => ({
            index,
            title: `第${index + 1}章`,
            text: '这是一段用于测试上下文预算的长文本。'.repeat(400),
        })),
        targetChars: 2000,
        budget,
    });
    assert.equal(long.mode, 'mapreduce');
    assert.ok(long.groups.length > 1);
    assert.ok(long.estimatedCalls > 2);
});

await test('buildPlan 目标字数受上下文与原文体量双重限制', () => {
    const budget = computeBudget({ ...DEFAULT_SETTINGS, contextTokens: 4096 });
    const plan = buildPlan({
        chapters: [{ index: 0, title: '第一章', text: '字'.repeat(300) }],
        targetChars: 5000,
        budget,
        maxTarget: maxTargetChars({ ...DEFAULT_SETTINGS, contextTokens: 4096 }),
    });
    assert.ok(plan.effectiveTarget < 5000);
    assert.ok(plan.effectiveTarget <= Math.ceil(300 * 0.9));
});

await test('parseNovelFile 拒绝 CBZ', async () => {
    const file = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], 'book.cbz', { type: 'application/zip' });
    await assert.rejects(() => parseNovelFile(file), /暂不支持 \.cbz/);
});

await test('parseNovelFile 解析 TXT 并识别章节', async () => {
    const body = '。这是一段长度足够的正文内容，用于确保章节不会被当作空章节合并。';
    const file = new File([iconv.encode(`第一章 一\n${body}\n第二章 二\n${body}`, 'gbk')], 'book.txt', { type: 'text/plain' });
    const parsed = await parseNovelFile(file);
    assert.equal(parsed.chapters.length, 2);
    assert.equal(parsed.title, 'book');
    assert.match(parsed.encoding, /gb/i);
});

await test('极速模式使用更大的分段预算和并发，减少请求数', () => {
    const budget = computeBudget({ ...DEFAULT_SETTINGS, contextTokens: 8192 });
    const chapters = Array.from({ length: 40 }, (_, index) => ({
        index,
        title: `第${index + 1}章`,
        text: '这是一段用于测试分段预算的正文。'.repeat(120),
    }));
    const fast = buildPlan({
        chapters,
        targetChars: 800,
        budget,
        strategy: resolveStrategy({ ...DEFAULT_SETTINGS, summaryMode: 'fast' }),
    });
    const quality = buildPlan({
        chapters,
        targetChars: 800,
        budget,
        strategy: resolveStrategy({ ...DEFAULT_SETTINGS, summaryMode: 'quality' }),
    });
    assert.ok(fast.segmentTokenBudget > quality.segmentTokenBudget);
    assert.ok(fast.estimatedCalls <= quality.estimatedCalls);
    assert.equal(resolveStrategy({ ...DEFAULT_SETTINGS, summaryMode: 'fast' }).concurrency, 4);
    assert.equal(resolveStrategy({ ...DEFAULT_SETTINGS, summaryMode: 'quality' }).concurrency, 1);
});

await test('runSummary 单段失败会跳过并继续，缓存成功后只补失败段', async () => {
    const chapters = Array.from({ length: 10 }, (_, index) => ({
        index,
        title: `第${index + 1}章`,
        text: `第${index + 1}章正文。` + '人物在雨夜推开门，发现线索并继续追查。'.repeat(240),
    }));
    const settings = {
        ...DEFAULT_SETTINGS,
        contextTokens: 8192,
        contextRatio: 0.7,
        outputReserve: 1024,
        maxAttempts: 2,
        summaryMode: 'fast',
        mapConcurrency: 3,
        reuseParts: true,
        autoCalibrate: false,
    };
    const cache = new Map();
    const adapter = {
        get: async key => cache.get(key),
        put: async part => cache.set(part.key, part),
    };
    let failGroup = true;
    let calls = 0;
    let failedGroupAttempts = 0;
    const makeContext = () => ({
        mainApi: 'openai',
        maxContext: 8192,
        extensionSettings: {},
        generateRaw: async ({ prompt }) => {
            calls += 1;
            const text = Array.isArray(prompt) ? prompt.map(item => item.content).join('\n') : String(prompt);
            if (text.includes('【位置】第 2 /')) {
                failedGroupAttempts += 1;
                if (failGroup) throw new Error('HTTP 500 server error');
            }
            if (text.includes('【位置】')) return '关键事件：人物发现线索，追查真相，冲突升级，最终揭开秘密。';
            return '整本总结：人物在雨夜追查线索，经历冲突与转折，最终揭开秘密并作出选择。';
        },
    });
    globalThis.SillyTavern = { getContext: makeContext };

    const first = await runSummary({
        novelTitle: '测试小说',
        chapters,
        targetChars: 300,
        styleKey: 'plot',
        scopeLabel: '全书',
        settings,
        cache: adapter,
    });
    assert.equal(first.incomplete, true);
    assert.equal(first.failedLabels.length, 1);
    assert.ok(first.text.length > 0);
    assert.ok(first.stats.failedGroups === 1);
    assert.ok(failedGroupAttempts >= 2, `失败分段应重试，实际尝试 ${failedGroupAttempts} 次`);
    assert.ok(cache.size >= 2, '成功分段应写入缓存');

    failGroup = false;
    const callsBefore = calls;
    const second = await runSummary({
        novelTitle: '测试小说',
        chapters,
        targetChars: 300,
        styleKey: 'plot',
        scopeLabel: '全书',
        settings,
        cache: adapter,
    });
    assert.equal(second.incomplete, false);
    assert.ok(second.stats.cacheHits >= 1, '第二次应复用成功分段');
    assert.ok(calls - callsBefore <= 2, `补充失败段后请求应很少，实际 ${calls - callsBefore}`);

    const callsBeforeThird = calls;
    const third = await runSummary({
        novelTitle: '测试小说',
        chapters,
        targetChars: 300,
        styleKey: 'plot',
        scopeLabel: '全书',
        settings,
        cache: adapter,
    });
    assert.equal(third.cached, true);
    assert.equal(third.stats.calls, 0);
    assert.equal(calls, callsBeforeThird, '最终总结命中缓存时不应再请求模型');
});

await test('runSummary 空回复（No message generated）会增大输出预算重试', async () => {
    const chapters = Array.from({ length: 8 }, (_, index) => ({
        index,
        title: `第${index + 1}章`,
        text: `第${index + 1}章正文。` + '人物在雨夜推开门，发现线索并继续追查。'.repeat(220),
    }));
    const settings = {
        ...DEFAULT_SETTINGS,
        contextTokens: 8192,
        contextRatio: 0.7,
        outputReserve: 1024,
        maxAttempts: 3,
        summaryMode: 'fast',
        mapConcurrency: 2,
        reuseParts: false,
        autoCalibrate: false,
    };
    let emptyOnce = true;
    let emptyAttempts = 0;
    const lengths = [];
    globalThis.SillyTavern = {
        getContext: () => ({
            mainApi: 'openai',
            maxContext: 8192,
            extensionSettings: {},
            generateRaw: async ({ prompt, responseLength }) => {
                const text = Array.isArray(prompt) ? prompt.map(item => item.content).join('\n') : String(prompt);
                if (text.includes('【位置】第 2 /') && emptyOnce) {
                    emptyOnce = false;
                    emptyAttempts += 1;
                    lengths.push(responseLength);
                    throw new Error('No message generated');
                }
                if (text.includes('【位置】')) {
                    if (text.includes('【位置】第 2 /')) emptyAttempts += 1;
                    if (text.includes('【位置】第 2 /')) lengths.push(responseLength);
                    return '关键事件：人物发现线索，追查真相，冲突升级，最终揭开秘密。';
                }
                return '整本总结：人物追查线索，经历冲突与转折，最终揭开秘密。';
            },
        }),
    };

    const result = await runSummary({
        novelTitle: '测试小说',
        chapters,
        targetChars: 300,
        styleKey: 'plot',
        scopeLabel: '全书',
        settings,
    });
    assert.equal(result.incomplete, false);
    assert.equal(result.failedLabels.length, 0);
    assert.ok(emptyAttempts >= 2, `空回复后应重试，实际 ${emptyAttempts} 次`);
    assert.ok(lengths.length >= 2 && lengths[1] > lengths[0], `重试应增大输出预算：${lengths.join(' -> ')}`);
});

await test('并发分段固定输出预算，结束后恢复酒馆 max_tokens', async () => {
    const chapters = Array.from({ length: 10 }, (_, index) => ({
        index,
        title: `第${index + 1}章`,
        text: `第${index + 1}章正文。` + '人物在雨夜推开门，发现线索并继续追查。'.repeat(240),
    }));
    const settings = {
        ...DEFAULT_SETTINGS,
        contextTokens: 8192,
        contextRatio: 0.7,
        outputReserve: 1024,
        maxAttempts: 2,
        summaryMode: 'fast',
        mapConcurrency: 3,
        reuseParts: false,
        autoCalibrate: false,
    };
    const completionSettings = { openai_max_tokens: 300 };
    const mapResponseLengths = [];
    globalThis.SillyTavern = {
        getContext: () => ({
            mainApi: 'openai',
            maxContext: 8192,
            extensionSettings: {},
            chatCompletionSettings: completionSettings,
            generateRaw: async ({ prompt, responseLength }) => {
                const text = Array.isArray(prompt) ? prompt.map(item => item.content).join('\n') : String(prompt);
                if (text.includes('【位置】')) {
                    mapResponseLengths.push(responseLength);
                    return '关键事件：人物发现线索，追查真相，冲突升级，最终揭开秘密。';
                }
                return '整本总结：人物追查线索，经历冲突与转折，最终揭开秘密。';
            },
        }),
    };

    const result = await runSummary({
        novelTitle: '测试小说',
        chapters,
        targetChars: 300,
        styleKey: 'plot',
        scopeLabel: '全书',
        settings,
    });
    assert.equal(result.incomplete, false);
    assert.equal(completionSettings.openai_max_tokens, 300, '并发 map 结束后应恢复原 max_tokens');
    assert.ok(mapResponseLengths.length > 1);
    assert.ok(mapResponseLengths.every(value => value === undefined), '并发 map 不应逐个修改全局 responseLength');
});

await test('parseWorldbookResponse 兼容代码块、轻微转义错误和扁平数组', () => {
    const fenced = `好的：\n\`\`\`json\n{"角色":{"张三":{"关键词":["张三","老张"],"内容":"他说："走吧"。"}},"地点":{"旧港":{"关键词":["旧港"],"内容":"雨夜港口。"}}}\n\`\`\``;
    const entries = parseWorldbookResponse(fenced);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].name, '张三');
    assert.ok(entries[0].content.includes('走吧'));

    const flat = parseWorldbookResponse('{"角色":[{"名称":"李四","关键词":["李四"],"内容":"一个角色。"}]}');
    assert.equal(flat.length, 1);
    assert.equal(flat[0].category, 'character');
    assert.equal(flat[0].name, '李四');
});

await test('parseWorldbookResponse 只保留启用的分类', () => {
    const text = '{"角色":{"张三":{"关键词":["张三"],"内容":"捕快。"}},"地点":{"旧港":{"关键词":["旧港"],"内容":"港口。"}}}';
    const entries = parseWorldbookResponse(text, { categories: [{ key: 'character', label: '角色' }] });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].category, 'character');
});

await test('mergeWorldbookEntries 合并同名条目与关键词并遵守字数上限', () => {
    const merged = mergeWorldbookEntries([
        { category: 'character', name: '张三', keywords: ['张三'], content: '## 身份\n捕快。' },
        { category: 'character', name: '张三', keywords: ['老张'], content: '## 关系\n与李四是旧识。' },
        { category: 'location', name: '旧港', keywords: ['旧港', '码头'], content: '雨夜的港口。' },
    ], { entryChars: 30 });
    assert.equal(merged.length, 2);
    const zhang = merged.find(entry => entry.name === '张三');
    assert.ok(zhang.keywords.includes('老张'));
    assert.ok(zhang.content.length <= 30);
});

await test('parseWorldbookResponse 不会把设定/剧情条目截到普通条目上限', () => {
    const long = '设定正文。'.repeat(200);
    const text = JSON.stringify({ 设定: { 世界观设定: { 关键词: ['世界观'], 内容: long } } });
    const entries = parseWorldbookResponse(text, { entryChars: 600, categories: [{ key: 'concept', label: '设定' }] });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].category, 'concept');
    assert.ok(entries[0].content.length > 600, `设定被截断到 ${entries[0].content.length}`);
});

await test('buildPlotRanges 按条目数把章节切成连续区间', () => {
    assert.deepEqual(
        buildPlotRanges(Array.from({ length: 10 }, (_, i) => ({ title: `第${i + 1}章` })), 3),
        [{ start: 0, end: 3, index: 0 }, { start: 4, end: 6, index: 1 }, { start: 7, end: 9, index: 2 }],
    );
    assert.deepEqual(buildPlotRanges([{ title: 'a' }, { title: 'b' }], 8), [
        { start: 0, end: 0, index: 0 },
        { start: 1, end: 1, index: 1 },
    ]);
    assert.deepEqual(buildPlotRanges([], 4), []);
});

await test('assembleMergedEntries 设定并成 1 条、剧情按章节区间分条', () => {
    const chapters = Array.from({ length: 8 }, (_, i) => ({ title: `第${i + 1}章` }));
    const items = [];
    for (let i = 0; i < 8; i++) {
        items.push({
            chapterStart: i,
            chapterEnd: i,
            entry: {
                category: 'event',
                name: '本段剧情',
                keywords: [`角色${i}`, '旧港'],
                content: `## 剧情纪要\n第${i + 1}章：角色${i}登场。`,
            },
        });
        items.push({
            chapterStart: i,
            chapterEnd: i,
            entry: {
                category: 'concept',
                name: '世界观设定',
                keywords: ['世界观', '灵根'],
                content: `## 力量体系\n第${i + 1}段的设定。`,
            },
        });
    }
    items.push({ chapterStart: 0, chapterEnd: 0, entry: { category: 'character', name: '张三', keywords: ['张三'], content: '捕快。' } });

    const merged = assembleMergedEntries(items, { chapters, plotEntries: 2, limits: { concept: 3000, event: 3000 } });
    const concepts = merged.filter(entry => entry.category === 'concept');
    const events = merged.filter(entry => entry.category === 'event');
    assert.equal(concepts.length, 1);
    assert.equal(concepts[0].name, '世界观设定');
    assert.match(concepts[0].content, /第1段的设定/);
    assert.match(concepts[0].content, /第8段的设定/);
    assert.ok(concepts[0].keywords.includes('灵根'));

    assert.equal(events.length, 2);
    assert.equal(events[0].name, '剧情·第1章～第4章');
    assert.equal(events[1].name, '剧情·第5章～第8章');
    assert.match(events[0].content, /第1章：角色0登场/);
    assert.match(events[0].content, /第4章：角色3登场/);
    assert.ok(!events[0].content.includes('第5章：角色4登场'));
    assert.ok(events[0].keywords.includes('角色0') && events[0].keywords.includes('角色3'));
    assert.equal(merged.filter(entry => entry.category === 'character').length, 1);
});

await test('entryCharLimit 对设定/剧情放宽、对普通条目保持原值', () => {
    assert.equal(entryCharLimit('character', { worldbookEntryChars: 600 }), 600);
    assert.ok(entryCharLimit('concept', { worldbookEntryChars: 600 }) > 600);
    assert.ok(entryCharLimit('event', { worldbookEntryChars: 600 }) > 600);
});

await test('toSillyTavernWorldbook 生成可导入的 entries 结构', () => {
    const data = toSillyTavernWorldbook([
        { category: 'character', name: '张三', keywords: ['张三', '老张'], content: '捕快。', enabled: true },
        { category: 'location', name: '旧港', keywords: ['旧港'], content: '港口。', enabled: false },
    ]);
    assert.equal(Object.keys(data.entries).length, 1);
    assert.equal(data.entries[0].comment, '角色·张三');
    assert.deepEqual(data.entries[0].key, ['张三', '老张']);
    assert.equal(data.entries[0].content, '捕快。');
    assert.equal(data.entries[0].selective, true);
    assert.equal(data.entries[0].position, 0);
});

await test('toCharacterCard 生成 V2 角色卡并内嵌世界书与文风样本', () => {
    const card = toCharacterCard([
        { category: 'character', name: '张三', keywords: ['张三', '老张'], content: '捕快。', enabled: true },
        { category: 'location', name: '旧港', keywords: ['旧港'], content: '港口。', enabled: false },
    ], {
        novelTitle: '测试小说',
        worldbookName: '测试小说 · 世界书',
        styleSample: '雨落在铁皮上。\n\n她没有回头。',
    });

    assert.equal(card.spec, 'chara_card_v2');
    assert.equal(card.spec_version, '2.0');
    assert.equal(card.data.name, '测试小说');
    assert.equal(card.data.character_book.name, '测试小说 · 世界书');
    assert.equal(card.data.character_book.entries.length, 1);
    assert.deepEqual(card.data.character_book.entries[0].keys, ['张三', '老张']);
    assert.equal(card.data.character_book.entries[0].content, '捕快。');
    assert.match(card.data.description, /文风样本/);
    assert.match(card.data.description, /雨落在铁皮上/);
    assert.equal(card.data.extensions.world, '');
});

await test('toCharacterCard 不内嵌世界书时描述改成「已绑定」', () => {
    const card = toCharacterCard([
        { category: 'character', name: '张三', keywords: ['张三'], content: '捕快。', enabled: true },
    ], {
        name: '测试小说（2）',
        worldbookName: '测试小说 · 世界书（2）',
        embeddedWorldbook: false,
    });
    assert.match(card.data.description, /已绑定/);
    assert.doesNotMatch(card.data.description, /随卡内嵌/);
    assert.match(card.data.creator_notes, /单独导入/);
    assert.equal(card.data.name, '测试小说（2）');
});

await test('assembleMergedEntries 把关系 / 时间线 / 伏笔等合并类分类各自并成一条', () => {
    const items = [
        { entry: { category: 'relation', name: '人物关系', keywords: ['师姐'], content: '## 关系网\n张三与李四是同门。' } },
        { entry: { category: 'relation', name: '人物关系', keywords: ['师父'], content: '## 称谓与称呼\n李四称张三为师兄。' } },
        { entry: { category: 'timeline', name: '时间线', keywords: ['三年前'], content: '## 大事记\n三年前山门被毁。' } },
        { entry: { category: 'timeline', name: '时间线', keywords: ['今年'], content: '## 大事记\n今年张三下山。' } },
        { entry: { category: 'clue', name: '伏笔与悬念', keywords: ['玉佩'], content: '## 伏笔\n玉佩的来历未明。' } },
        { entry: { category: 'skill', name: '影步', keywords: ['影步'], content: '## 效果\n瞬移三丈。' } },
        { entry: { category: 'race', name: '妖族', keywords: ['妖族'], content: '## 特征\n可化形。' } },
    ];
    const merged = assembleMergedEntries(items, { limits: {} });

    const relation = merged.filter(entry => entry.category === 'relation');
    assert.equal(relation.length, 1);
    assert.equal(relation[0].name, '人物关系');
    assert.match(relation[0].content, /张三与李四是同门/);
    assert.match(relation[0].content, /李四称张三为师兄/);
    assert.ok(relation[0].keywords.includes('师姐'));
    assert.ok(relation[0].keywords.includes('关系'));

    const timeline = merged.filter(entry => entry.category === 'timeline');
    assert.equal(timeline.length, 1);
    assert.equal(timeline[0].name, '时间线');
    assert.match(timeline[0].content, /三年前山门被毁/);
    assert.match(timeline[0].content, /今年张三下山/);

    assert.equal(merged.filter(entry => entry.category === 'clue').length, 1);
    // 没标 single 的分类仍然是按条目走的
    assert.equal(merged.filter(entry => entry.category === 'skill').length, 1);
    assert.equal(merged.find(entry => entry.category === 'skill').content, '## 效果\n瞬移三丈。');
    assert.equal(merged.filter(entry => entry.category === 'race').length, 1);
});

await test('parseWorldbookResponse 认识新增的种族 / 能力分类', () => {
    const race = WORLDBOOK_CATEGORIES.find(category => category.key === 'race');
    const skill = WORLDBOOK_CATEGORIES.find(category => category.key === 'skill');
    const entries = parseWorldbookResponse(JSON.stringify({
        种族: { 妖族: { 关键词: ['妖族', '化形'], 内容: '可化形为人。' } },
        能力: { 影步: { 关键词: ['影步'], 内容: '瞬移三丈。' } },
    }), { categories: [race, skill] });
    assert.equal(entries.length, 2);
    assert.deepEqual(entries.map(entry => entry.category).sort(), ['race', 'skill']);
    assert.equal(entries.find(entry => entry.name === '妖族').categoryLabel, '种族');
});

await test('新分类参与排序与世界书 order 编号', () => {
    const merged = mergeWorldbookEntries([
        { category: 'skill', name: '影步', keywords: ['影步'], content: '瞬移。' },
        { category: 'race', name: '妖族', keywords: ['妖族'], content: '化形。' },
        { category: 'character', name: '张三', keywords: ['张三'], content: '捕快。' },
    ], { entryChars: 600 });
    assert.deepEqual(merged.map(entry => entry.categoryLabel), ['角色', '种族', '能力']);

    const data = toSillyTavernWorldbook(merged);
    const entries = Object.values(data.entries);
    assert.deepEqual(entries.map(entry => entry.comment), ['角色·张三', '种族·妖族', '能力·影步']);
    assert.ok(entries[1].order < entries[2].order);
});

await test('extractStyleSample 去掉章节标题并在句末截断', () => {
    const sample = extractStyleSample('第一章 雨夜\n\n雨落在铁皮上。\n\n\n她没有回头。');
    assert.equal(sample, '雨落在铁皮上。\n\n她没有回头。');

    const long = extractStyleSample(`${'雨。'.repeat(200)}`, 240);
    assert.ok(countChars(long) <= 240);
});

/** 造一份精简过的“酒馆预设”，字段与 readSelectedChatPreset() 的输出一致 */
function mockPreset(name, prompts) {
    return {
        name,
        prompts: prompts.map((prompt, index) => ({
            identifier: prompt.identifier,
            name: prompt.name,
            role: prompt.role || 'system',
            content: prompt.content || '',
            marker: false,
            enabled: prompt.enabled !== false,
            order: prompt.order ?? index,
        })),
    };
}

const SETVAR_STYLE = `{{setvar::wenfeng::

## 视角
- 全程第二人称「你」，贴着主角的身体写。
- 不写「你」不可能知道的事，别人的情绪只从动作和语气里露出来。

## 分段与句长
- 一段一到两句；能一句成段就一句成段。
- 叙述句短，主谓宾清楚。紧张时一句只推一个动作。

## 标点与声音
- 破折号写中断、拖长；省略号写迟疑，可以多用但不能每句都用。
- 拟声词独立成行，具体到材质和方向。

## 禁止
- 不堆比喻和排比，不用「仿佛」连续造景。
- 不写情绪名，不写章末升华。

}}`;

const TAG_STYLE = `<附加风格_轻小说>
- 像日本轻小说家一样创作。
- 大量创作主角的内心戏。
</附加风格_轻小说>`;

const EMPTY_TAG_SLOT = '<文风指导_拓展>\n\n\n</文风指导_拓展>';

await test('analyzeStyleFormat 认得出 setvar 包裹、小节、条目符号与角色', () => {
    const spec = analyzeStyleFormat(SETVAR_STYLE, 'system');
    assert.equal(spec.wrapper.kind, 'setvar');
    assert.equal(spec.wrapper.name, 'wenfeng');
    assert.equal(spec.wrapper.open, '{{setvar::wenfeng::');
    assert.equal(spec.wrapper.close, '}}');
    assert.deepEqual(spec.headings.map(heading => heading.text), ['## 视角', '## 分段与句长', '## 标点与声音', '## 禁止']);
    assert.equal(spec.bullet.mark, '-');
    assert.equal(spec.bullet.indent, 0);
    assert.equal(spec.role, 'system');
    assert.ok(spec.charCount >= SETVAR_STYLE.trim().length - 4);
    assert.equal(spec.empty, false);

    // 带空格的英文标签行也要认出来（预设里常见「WRITING STYLE: …」）
    const labelled = analyzeStyleFormat('{{setvar::x::\nWRITING STYLE: 第二人称·冷硬\n\n## 视角\n- 贴着身体写。\n}}');
    assert.equal(labelled.labelLines, 1);
    assert.deepEqual(labelled.labels, ['WRITING STYLE']);
});

await test('analyzeStyleFormat 认得出尖括号包裹、user 角色与无小节写法', () => {
    const spec = analyzeStyleFormat(TAG_STYLE, 'user');
    assert.equal(spec.wrapper.kind, 'tag');
    assert.equal(spec.wrapper.name, '附加风格_轻小说');
    assert.equal(spec.headings.length, 0);
    assert.equal(spec.bullet.mark, '-');
    assert.equal(spec.role, 'user');

    const empty = analyzeStyleFormat(EMPTY_TAG_SLOT, 'user');
    assert.equal(empty.wrapper.name, '文风指导_拓展');
    assert.equal(empty.empty, true);
    assert.equal(empty.lineCount, 0);
});

await test('buildStyleSkeleton 只保留预设排版，不带旧文风正文', () => {
    const spec = analyzeStyleFormat(SETVAR_STYLE);
    const skeleton = buildStyleSkeleton(spec);
    assert.ok(skeleton.startsWith('{{setvar::wenfeng::'));
    assert.ok(skeleton.includes('## 视角'));
    assert.ok(skeleton.includes('## 分段与句长'));
    assert.ok(skeleton.includes('- …'));
    assert.ok(!skeleton.includes('贴着主角的身体写'));
    assert.ok(!skeleton.includes('一段一到两句'));
    assert.ok(!skeleton.includes('不写情绪名'));
});

await test('analyzeSampleStyle 量出段落、句长、对白与标点', () => {
    const stats = analyzeSampleStyle('雨落在铁皮上。她没有回头。\n\n“走吧。”他说。');
    assert.equal(stats.paragraphs, 2);
    assert.ok(stats.sentences >= 3);
    assert.ok(stats.avgSentenceChars > 0);
    assert.ok(stats.dialogueRatio > 0);

    const punct = analyzeSampleStyle('他停了一下——然后说……“好。”');
    assert.ok(punct.dashes >= 1);
    assert.ok(punct.ellipses >= 1);
    assert.equal(analyzeSampleStyle(''), null);
});

await test('isUsableStyleContent 把注释、纯标签、占位话术排除在外', () => {
    assert.equal(isUsableStyleContent(''), false);
    assert.equal(isUsableStyleContent('{{//默认单选,想多开可以将文风开头的 setvar 改成 addvar}}'), false);
    assert.equal(isUsableStyleContent('<文风指导>'), false);
    assert.equal(isUsableStyleContent('</文风指导>'), false);
    assert.equal(isUsableStyleContent('<文风指导_拓展>\n\n</文风指导_拓展>'), false);
    assert.equal(isUsableStyleContent('<自定义标签>\n标签和内容自己改改就可以了\n</自定义标签>'), false);
    assert.equal(isUsableStyleContent('<文风指导_拓展>\n（放文风）\n</文风指导_拓展>'), false);
    assert.equal(isUsableStyleContent('<附加风格_轻小说>\n- 像日本轻小说家一样创作。\n</附加风格_轻小说>'), true);
    assert.equal(isUsableStyleContent('<风格>\n- 短句。\n- 不写情绪名。\n</风格>'), true);
    assert.equal(isUsableStyleContent('<风格>\n（在此填写文风）\n</风格>'), false);
    assert.equal(isUsableStyleContent(SETVAR_STYLE), true);
});

await test('scoreStyleEntry / groupStyleEntries 把「写作指导」排在真正的文风后面', () => {
    const preset = mockPreset('主预设', [
        { identifier: 'main', name: '核心设定', content: '你是写手。' },
        { identifier: 'nsfw', name: '❤️nsfw风格|很黄(选一)', content: '露骨描写。'.repeat(30), enabled: true },
        { identifier: 'style', name: '📝文风|自定义🔧', content: SETVAR_STYLE, enabled: true },
        { identifier: 'guide', name: '⚠️自定义文风撰写指导', content: '', enabled: false },
        { identifier: 'light', name: '📝文风|轻小说', content: TAG_STYLE, enabled: false },
    ]);
    assert.ok(scoreStyleEntry(preset.prompts[2]) > scoreStyleEntry(preset.prompts[4]));
    assert.ok(scoreStyleEntry(preset.prompts[2]) > scoreStyleEntry(preset.prompts[3]));

    const groups = groupStyleEntries(preset);
    // 内容是空的「撰写指导」只算占位，不当格式模板
    assert.deepEqual(groups.style.map(entry => entry.identifier), ['nsfw', 'style', 'light']);
    assert.deepEqual(groups.empty.map(entry => entry.identifier), ['guide']);
    assert.equal(groups.enabledStyle.length, 2);
    assert.equal(defaultStyleEntry(preset).identifier, 'style');
    assert.deepEqual(groups.rest.map(entry => entry.identifier), ['main']);
});

await test('buildStylePlan 默认选中启用的文风条目，格式跟着条目走', () => {
    const preset = mockPreset('主预设', [
        { identifier: 'style', name: '📝文风|自定义🔧', content: SETVAR_STYLE, enabled: true },
    ]);
    const plan = buildStylePlan(preset);
    assert.equal(plan.entry.identifier, 'style');
    assert.equal(plan.structureRef.identifier, 'style');
    assert.equal(plan.borrowedStructure, false);
    assert.equal(plan.spec.wrapper.name, 'wenfeng');
    assert.equal(plan.targetChars, plan.spec.charCount);
    assert.ok(plan.spec.charCount >= 120);
});

await test('buildStylePlan 遇到空白自定义位时借结构、留包裹', () => {
    const baseStyle = '<通用写作规范>\n- 不用欧化句式。\n- 不用右分支比喻。\n- 五字以内对白删掉或并入。\n</通用写作规范>';
    const preset = mockPreset('夏瑾', [
        { identifier: 'base', name: '✅基础文风', content: baseStyle, enabled: false },
        { identifier: 'custom', name: '🌸自定义文风（自行填入内容）', content: EMPTY_TAG_SLOT, enabled: true },
        { identifier: 'light', name: '📖 轻小说（文风）', content: TAG_STYLE, enabled: false },
    ]);
    assert.equal(defaultStyleEntry(preset).identifier, 'custom');

    const plan = buildStylePlan(preset);
    assert.equal(plan.entry.identifier, 'custom');
    assert.equal(plan.borrowedStructure, true);
    assert.equal(plan.structureRef.identifier, 'base');
    assert.equal(plan.spec.wrapper.name, '文风指导_拓展');
    assert.equal(plan.spec.bullet.mark, '-');
    assert.ok(plan.targetChars > 0);

    const manual = buildStylePlan(preset, 'light');
    assert.equal(manual.structureRef.identifier, 'light');
    assert.equal(manual.spec.wrapper.name, '附加风格_轻小说');
});

await test('选用的预设不同，默认条目与格式跟着变', () => {
    const presetA = mockPreset('主预设', [
        { identifier: 'style', name: '📝文风|自定义🔧', content: SETVAR_STYLE, enabled: true },
    ]);
    const presetB = mockPreset('双人成行', [
        { identifier: 'locked', name: '🔒丨文风', content: TAG_STYLE, enabled: true },
    ]);
    const planA = buildStylePlan(presetA);
    const planB = buildStylePlan(presetB);
    assert.notEqual(planA.spec.wrapper.name, planB.spec.wrapper.name);
    assert.equal(planA.spec.wrapper.kind, 'setvar');
    assert.equal(planB.spec.wrapper.kind, 'tag');
    assert.ok(planA.spec.headings.length > planB.spec.headings.length);
});

await test('buildStyleAdaptPrompt 带上预设名、条目格式、样本与调整要求', () => {
    const preset = mockPreset('主预设', [
        { identifier: 'style', name: '📝文风|自定义🔧', content: SETVAR_STYLE, enabled: true },
    ]);
    const plan = buildStylePlan(preset);
    const prompt = buildStyleAdaptPrompt({
        novelTitle: '测试小说',
        sample: '雨落在铁皮上，她没有回头。',
        pov: 'third',
        presetName: '主预设',
        plan,
        instruction: '更冷硬，少比喻',
    });
    assert.ok(prompt.includes('《测试小说》'));
    assert.ok(prompt.includes('《主预设》'));
    assert.ok(prompt.includes('📝文风|自定义🔧'));
    assert.ok(prompt.includes('{{setvar::wenfeng:: … }}'));
    assert.ok(prompt.includes('## 视角 ｜ ## 分段与句长'));
    assert.ok(prompt.includes('【格式骨架】'));
    assert.ok(prompt.includes('【原文文风观察】'));
    assert.ok(prompt.includes('- …'));
    assert.ok(prompt.includes('雨落在铁皮上'));
    assert.ok(prompt.includes('第三人称'));
    assert.ok(prompt.includes('更冷硬，少比喻'));
    assert.ok(prompt.includes('现在直接输出整段新的条目内容'));
    // 预设里的旧文风正文不能再进提示词，只保留排版骨架
    assert.ok(!prompt.includes('贴着主角的身体写'));
    assert.ok(!prompt.includes('一段一到两句'));
    assert.ok(!prompt.includes('不写情绪名'));
});

await test('parseStyleAdaptOutput + fitStyleOutput 守住包裹标签', () => {
    const wrapper = analyzeStyleFormat(SETVAR_STYLE).wrapper;
    const cleaned = parseStyleAdaptOutput('```\n好的，这是你要的条目：\n\n## 视角\n- 句子要短。\n```');
    assert.ok(!cleaned.includes('```'));
    assert.ok(!cleaned.startsWith('好的'));
    assert.ok(cleaned.startsWith('## 视角'));

    const fitted = fitStyleOutput(cleaned, wrapper);
    assert.ok(fitted.startsWith('{{setvar::wenfeng::'));
    assert.ok(fitted.endsWith('}}'));
    assert.ok(fitted.includes('## 视角'));

    // 模型自带了另一层包裹时换成目标条目的
    const other = fitStyleOutput('<别的标签>\n- 短句。\n</别的标签>', wrapper);
    assert.ok(other.startsWith('{{setvar::wenfeng::'));
    assert.ok(!other.includes('<别的标签>'));

    assert.equal(fitStyleOutput('纯文本', null), '纯文本');
});

await test('checkStyleOutput 抓出漏小节、漏包裹与篇幅差得多', () => {
    const spec = analyzeStyleFormat('## 视角\n- 贴身体写。\n\n## 分段\n- 一段两句。');
    const ok = checkStyleOutput('## 视角\n- 贴身体写。\n\n## 分段\n- 一段两句。', spec);
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.warnings, []);

    const broken = checkStyleOutput('写了一大段没有小节的文风说明。'.repeat(6), spec);
    assert.equal(broken.ok, false);
    assert.ok(broken.warnings.some(text => text.includes('小节')));
    assert.ok(broken.warnings.some(text => text.includes('条目符号')));

    // 篇幅只对够长的条目才比
    const longSpec = analyzeStyleFormat(SETVAR_STYLE);
    const short = checkStyleOutput('## 视角\n- 短。\n\n## 分段与句长\n- 短。', longSpec);
    assert.ok(short.warnings.some(text => text.includes('篇幅')));
    const missingWrapper = checkStyleOutput('## 视角\n- 短。', longSpec);
    assert.ok(missingWrapper.warnings.some(text => text.includes('包裹标签')));

    const placeholder = checkStyleOutput('{{setvar::wenfeng::\n## 视角\n- …\n}}', longSpec);
    assert.ok(placeholder.warnings.some(text => text.includes('占位符')));

    const wrapped = checkStyleOutput('{{setvar::wenfeng::\n## 视角\n- 短。\n}}', analyzeStyleFormat(SETVAR_STYLE));
    assert.ok(!wrapped.warnings.some(text => text.includes('包裹标签')));
});

await test('stylePasteHint 指明预设、条目与复制位置', () => {
    const hint = stylePasteHint({ presetName: '主预设', entryName: '📝文风|自定义🔧', role: 'system' });
    assert.ok(hint.includes('主预设'));
    assert.ok(hint.includes('📝文风|自定义🔧'));
    assert.ok(hint.includes('提示词管理器'));
    assert.ok(hint.includes('system'));
});

await test('detectPov 忽略对白后按叙述代词判断人称', () => {
    assert.equal(detectPov(''), null);
    assert.equal(detectPov('雨落下来。'), null);

    const second = '你推开门，你把外套挂起来，你听见楼上有人走动。\n'.repeat(4);
    const first = '我推开门，我把外套挂起来，我听见楼上有人走动。\n'.repeat(4);
    const third = '他推开门，他把外套挂起来，他听见楼上有人走动。\n'.repeat(4);
    assert.equal(detectPov(second), 'second');
    assert.equal(detectPov(first), 'first');
    assert.equal(detectPov(third), 'third');

    // 对白里的「我 / 你」不算叙述，剥掉引号后没有足够代词就判断不出来
    assert.equal(detectPov('“我明天就带你去。”我说。“好。”你说。'.repeat(3)), null);
    // 中英文引号都要能剥掉
    assert.equal(detectPov('「你走。」\n「我不走。」\n'.repeat(3)), null);
});

await test('generateWorldbook 失败块跳过、缓存后只补失败块', async () => {
    const settings = {
        ...DEFAULT_SETTINGS,
        contextTokens: 4096,
        outputReserve: 512,
        maxAttempts: 1,
        worldbookCategories: { character: true, location: true, organization: false, item: false, event: false, concept: false },
        worldbookChunkChars: 1800,
        worldbookConcurrency: 2,
        worldbookEntryChars: 600,
        autoCalibrate: false,
    };
    const chapters = Array.from({ length: 3 }, (_, index) => ({ index, title: `第${index + 1}章` }));
    const cache = new Map();
    const adapter = { getMany: async keys => keys.map(key => cache.get(key)), put: async part => cache.set(part.key, part) };
    let failChapter = true;
    let calls = 0;
    globalThis.SillyTavern = {
        getContext: () => ({
            maxContext: 4096,
            mainApi: 'openai',
            extensionSettings: { novelReader: settings },
            generateRaw: async ({ prompt }) => {
                calls++;
                const text = typeof prompt === 'string' ? prompt : prompt.map(item => item.content).join('\n');
                if (failChapter && text.includes('【第2章')) throw new Error('No message generated');
                const name = text.includes('【第1章') ? '角色一' : text.includes('【第2章') ? '角色二' : '角色三';
                return JSON.stringify({
                    角色: { [name]: { 关键词: [name], 内容: '## 身份\n测试角色。' } },
                    地点: { 旧港: { 关键词: ['旧港'], 内容: '## 概况\n港口。' } },
                });
            },
        }),
    };
    const first = await generateWorldbook({
        novelId: 'wb-test',
        novelTitle: '测试小说',
        chapters,
        loadChapter: async () => '正文'.repeat(1000),
        settings,
        cache: adapter,
    });
    assert.equal(first.incomplete, true);
    assert.ok(first.failedLabels.length > 0);
    assert.ok(first.entries.length > 0);

    failChapter = false;
    const before = calls;
    const second = await generateWorldbook({
        novelId: 'wb-test',
        novelTitle: '测试小说',
        chapters,
        loadChapter: async () => '正文'.repeat(1000),
        settings,
        cache: adapter,
    });
    assert.equal(second.incomplete, false);
    assert.ok(second.stats.cacheHits > 0);
    assert.ok(calls - before <= second.stats.chunks - second.stats.cacheHits, `只应补失败块，实际新增 ${calls - before} 次`);
});

await test('generateWorldbook 把设定并成一条、剧情按章节区间分成指定条数', async () => {
    const settings = {
        ...DEFAULT_SETTINGS,
        contextTokens: 8192,
        outputReserve: 512,
        maxAttempts: 1,
        worldbookCategories: { character: false, location: false, organization: false, item: false, event: true, concept: true },
        worldbookChunkChars: 1200,
        worldbookConcurrency: 1,
        worldbookEntryChars: 600,
        worldbookPlotEntries: 2,
        autoCalibrate: false,
    };
    const chapters = Array.from({ length: 4 }, (_, index) => ({ index, title: `第${index + 1}章 测试` }));
    globalThis.SillyTavern = {
        getContext: () => ({
            maxContext: 8192,
            mainApi: 'openai',
            extensionSettings: { novelReader: settings },
            generateRaw: async ({ prompt }) => {
                const text = typeof prompt === 'string' ? prompt : prompt.map(item => item.content).join('\n');
                const marker = (text.match(/【第(\d)章[^】]*】/g) || []).join('');
                return JSON.stringify({
                    剧情: { 本段剧情: { 关键词: ['主角', '旧港'], 内容: `## 剧情纪要\\n${marker || '本段'}：主角赶到旧港。` } },
                    设定: { 世界观设定: { 关键词: ['灵根', '灵气'], 内容: `## 力量体系\\n${marker || '本段'}：灵气按灵根分级。` } },
                });
            },
        }),
    };
    const result = await generateWorldbook({
        novelId: 'wb-merge',
        novelTitle: '合并测试',
        chapters,
        loadChapter: async () => '正文'.repeat(400),
        settings,
    });
    const concepts = result.entries.filter(entry => entry.category === 'concept');
    const plots = result.entries.filter(entry => entry.category === 'event');
    assert.equal(concepts.length, 1, `设定应只有 1 条，实际 ${concepts.length}`);
    assert.equal(concepts[0].name, '世界观设定');
    assert.match(concepts[0].content, /力量体系/);
    assert.equal(plots.length, 2, `剧情应有 2 条，实际 ${plots.length}`);
    assert.equal(plots[0].name, '剧情·第1章 测试～第2章 测试');
    assert.equal(plots[1].name, '剧情·第3章 测试～第4章 测试');
    assert.equal(result.plotEntries, 2);
});

await test('角色卡内嵌世界书时自动写入并绑定（不依赖酒馆的提示开关）', async () => {
    const saved = [];
    const linked = [];
    const names = [];
    let importedInfo = null;
    const handlers = {};
    const character = {
        name: '妖妹',
        avatar: '妖妹.png',
        data: {
            character_book: { name: '妖妹 · 世界书', entries: [{ keys: ['妖妹'], content: '内嵌条目' }] },
            extensions: {},
        },
    };
    const context = {
        characters: [character],
        characterId: 0,
        eventSource: {
            on(event, handler) { (handlers[event] = handlers[event] || []).push(handler); },
            removeListener() {},
        },
        eventTypes: { CHARACTER_EDITOR_OPENED: 'character_editor_opened' },
        getWorldInfoNames: () => [...names],
        convertCharacterBook: book => ({ entries: { 0: { key: book.entries[0].keys, content: book.entries[0].content } } }),
        saveWorldInfo: async (name, data, immediate) => { saved.push({ name, data, immediate }); names.push(name); },
        updateWorldInfoList: async () => {},
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
    };
    globalThis.SillyTavern = { getContext: () => context };
    globalThis.document = { querySelectorAll: () => [] };
    globalThis.$ = undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
        linked.push({ url, body: JSON.parse(options.body) });
        return { ok: true, status: 200 };
    };

    const stop = installEmbeddedWorldbookAutoImport({
        isEnabled: () => true,
        onImported: info => { importedInfo = info; },
    });
    for (const handler of handlers.character_editor_opened || []) await handler(0);

    assert.equal(saved.length, 1, `应写入 1 本世界书，实际 ${saved.length}`);
    assert.equal(saved[0].name, '妖妹 · 世界书');
    assert.equal(saved[0].data.entries[0].content, '内嵌条目');
    assert.equal(linked.length, 1);
    assert.equal(linked[0].body.avatar, '妖妹.png');
    assert.equal(linked[0].body.data.extensions.world, '妖妹 · 世界书');
    assert.equal(character.data.extensions.world, '妖妹 · 世界书');
    assert.equal(importedInfo?.existed, false);
    assert.equal(worldbookExists('妖妹 · 世界书'), true);

    // 已经绑定过，再次打开不应重复写入
    for (const handler of handlers.character_editor_opened || []) await handler(0);
    assert.equal(saved.length, 1);
    stop();
    globalThis.fetch = originalFetch;
    globalThis.document = undefined;
});

await test('uniqueName 重名往后找备用名，导入角色卡走酒馆接口', async () => {
    assert.equal(uniqueName('妖妹', () => false), '妖妹');
    assert.equal(uniqueName('妖妹', name => name === '妖妹'), '妖妹（2）');
    assert.equal(uniqueName('妖妹', name => name === '妖妹' || name === '妖妹（2）'), '妖妹（3）');
    assert.equal(uniqueName('', () => false), '');
    assert.ok(uniqueName('很长'.repeat(40), () => true).length <= 80);

    const requests = [];
    const context = {
        characters: [{ name: '妖妹' }, { name: '张三' }],
        name1: '旅人',
        getRequestHeaders: options => (options?.omitContentType ? { 'X-Omit': '1' } : { 'Content-Type': 'application/json' }),
        getCharacters: async () => {},
    };
    globalThis.SillyTavern = { getContext: () => context };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
        requests.push({ url, options });
        if (url === '/api/characters/import') {
            return { ok: true, status: 200, json: async () => ({ file_name: '妖妹2' }) };
        }
        return { ok: true, status: 200, json: async () => ({}) };
    };

    assert.deepEqual(tavernCharacterNames(), ['妖妹', '张三']);

    const imported = await importCharacterCardToTavern({ data: { name: '妖妹' } });
    assert.equal(imported.avatar, '妖妹2.png');
    const form = requests[0].options.body;
    assert.equal(requests[0].url, '/api/characters/import');
    assert.equal(form.get('file_type'), 'json');
    assert.equal(form.get('user_name'), '旅人');
    assert.equal(form.get('avatar').name, '妖妹.json');

    globalThis.fetch = originalFetch;
});

await test('readSelectedChatPreset 读当前选用预设：名称、条目顺序、启用状态与角色', () => {
    const prompts = [
        { identifier: 'main', name: '核心设定', role: 'system', content: '你是写手。' },
        { identifier: 'style', name: '📝文风|自定义🔧', role: 'user', content: SETVAR_STYLE },
    ];
    const promptOrder = [{
        character_id: 100001,
        order: [
            { identifier: 'main', enabled: true },
            { identifier: 'style', enabled: false },
        ],
    }];
    const context = {
        chatCompletionSettings: {
            preset_settings_openai: '主预设',
            chat_completion_source: 'openai',
            prompts,
            prompt_order: promptOrder,
        },
    };
    globalThis.SillyTavern = { getContext: () => context };

    const preset = readSelectedChatPreset();
    assert.equal(preset.name, '主预设');
    assert.equal(preset.prompts.length, 2);
    const style = preset.prompts.find(entry => entry.identifier === 'style');
    assert.equal(style.enabled, false);
    assert.equal(style.role, 'user');
    assert.equal(style.order, 1);
    assert.equal(style.content, SETVAR_STYLE);

    // 运行中数据缺失时退回预设管理器里的存档
    const saved = {
        prompts: [{ identifier: 'only', name: '🔒丨文风', role: 'system', content: TAG_STYLE }],
        prompt_order: [],
    };
    globalThis.SillyTavern = {
        getContext: () => ({
            chatCompletionSettings: { prompts: [] },
            getPresetManager: () => ({
                getSelectedPresetName: () => '旧预设',
                getCompletionPresetByName: name => (name === '旧预设' ? saved : undefined),
            }),
        }),
    };
    const fallback = readSelectedChatPreset();
    assert.equal(fallback.name, '旧预设');
    assert.equal(fallback.prompts[0].identifier, 'only');
    assert.equal(fallback.prompts[0].enabled, true);

    globalThis.SillyTavern = { getContext: () => ({}) };
    assert.equal(readSelectedChatPreset(), null);
    delete globalThis.SillyTavern;
});

await test('installPresetChangeWatcher 只触发一次，取消监听后不再回调', async () => {
    const handlers = new Map();
    const context = {
        eventSource: {
            on: (name, fn) => handlers.set(name, fn),
            removeListener: name => handlers.delete(name),
        },
        eventTypes: {
            OAI_PRESET_CHANGED_AFTER: 'after',
            PRESET_CHANGED: 'changed',
            CHATCOMPLETION_SOURCE_CHANGED: 'source',
        },
    };
    globalThis.SillyTavern = { getContext: () => context };

    let count = 0;
    const off = installPresetChangeWatcher(() => { count += 1; });
    assert.equal(handlers.size, 3);
    handlers.get('after')();
    handlers.get('changed')();
    await sleep(140);
    assert.equal(count, 1);

    off();
    assert.equal(handlers.size, 0);
    delete globalThis.SillyTavern;
});

await test('normalizeEntryName 去掉名字装饰、entryNameKey 忽略标点空白', () => {
    assert.equal(normalizeEntryName('  「张三·捕快」 '), '张三·捕快');
    assert.equal(normalizeEntryName('“旧港”'), '旧港');
    assert.equal(entryNameKey('张 三'), entryNameKey('张三'));
    assert.equal(entryNameKey('ＡＢＣ'), entryNameKey('abc'));
});

await test('organizeEntryContent 合并同名小标题并去掉重复段落 / 列表行', () => {
    const messy = [
        '## 身份',
        '捕快。',
        '',
        '## 关系',
        '与李四是旧识。',
        '',
        '## 身份',
        '捕快。',
        '',
        '负责城南治安。',
        '',
        '- 老张',
        '- 老张',
        '- 张三',
    ].join('\n');
    const clean = organizeEntryContent(messy);
    assert.equal((clean.match(/## 身份/g) || []).length, 1);
    assert.equal((clean.match(/捕快。/g) || []).length, 1);
    assert.match(clean, /负责城南治安/);
    assert.equal((clean.match(/- 老张/g) || []).length, 1);
    assert.match(clean, /## 关系\n与李四是旧识/);

    const long = organizeEntryContent(`## 身份\n${'很长的正文。'.repeat(100)}`, { maxChars: 40 });
    assert.ok(long.length <= 40, `应受上限约束，实际 ${long.length}`);
});

await test('dedupeKeywords 保证条目名在首位并忽略大小写', () => {
    const keywords = dedupeKeywords(['主角', '张三', '主角', '  ', 'ZHANG'], '张三');
    assert.equal(keywords[0], '张三');
    assert.equal(keywords.filter(item => item === '主角').length, 1);
    assert.ok(keywords.includes('ZHANG'));
});

await test('findDuplicateGroups 只合并同分类里的名称包含 / 关键词重叠', () => {
    const entries = [
        { category: 'character', categoryLabel: '角色', name: '张三', keywords: ['张三', '老张'], content: '捕快。' },
        { category: 'character', categoryLabel: '角色', name: '张三·捕快', keywords: ['老张', '捕快'], content: '城南捕快。' },
        { category: 'character', categoryLabel: '角色', name: '李三', keywords: ['李三'], content: '另一名捕快。' },
        { category: 'location', categoryLabel: '地点', name: '旧港', keywords: ['旧港', '码头'], content: '港口。' },
        { category: 'location', categoryLabel: '地点', name: '旧港口', keywords: ['码头'], content: '更大的港口。' },
    ];
    const groups = findDuplicateGroups(entries);
    assert.equal(groups.length, 2);
    const character = groups.find(group => group.category === 'character');
    assert.deepEqual(character.indexes, [0, 1]);
    assert.equal(character.mainName, '张三');
    assert.ok(!groups.some(group => group.names.includes('李三')), '尾名相同但无关键词重叠不应自动成组');
    assert.equal(pickMainName([entries[0], entries[1]]), '张三');
});

await test('mergeEntries 跨分类合并、去重关键词并同步删除原条目', () => {
    const entries = [
        { category: 'character', categoryLabel: '角色', name: '张三', keywords: ['张三'], content: '## 身份\n捕快。' },
        { category: 'character', categoryLabel: '角色', name: '老张', keywords: ['老张', '捕快'], content: '## 关系\n与李四旧识。' },
        { category: 'location', categoryLabel: '地点', name: '旧港', keywords: ['旧港'], content: '港口。' },
    ];
    const result = mergeEntries(entries, {
        indexes: [0, 1],
        name: '张三',
        category: 'character',
        categoryLabels: { character: '角色', location: '地点' },
    });
    assert.equal(result.entries.length, 2);
    assert.equal(result.merged.name, '张三');
    assert.deepEqual(new Set(result.merged.keywords), new Set(['张三', '老张', '捕快']));
    assert.match(result.merged.content, /捕快/);
    assert.match(result.merged.content, /与李四旧识/);
    assert.equal(result.entries[0].name, '张三');
    assert.equal(result.entries[1].name, '旧港');
    assert.throws(() => mergeEntries(entries, { indexes: [0] }), /至少需要选择 2 个条目/);
});

await test('mergeDuplicateGroups 按名字重新定位并依次合并多组', () => {
    const entries = [
        { category: 'character', categoryLabel: '角色', name: '张三', keywords: ['张三'], content: '捕快。' },
        { category: 'character', categoryLabel: '角色', name: '张三·捕快', keywords: ['捕快'], content: '城南捕快。' },
        { category: 'location', categoryLabel: '地点', name: '旧港', keywords: ['旧港'], content: '港口。' },
        { category: 'location', categoryLabel: '地点', name: '旧港口', keywords: ['旧港'], content: '更大的港口。' },
    ];
    const groups = findDuplicateGroups(entries);
    const { entries: merged, mergedGroups } = mergeDuplicateGroups(entries, groups, {
        categoryLabels: { character: '角色', location: '地点' },
    });
    assert.equal(mergedGroups, 2);
    assert.equal(merged.length, 2);
    assert.ok(merged.find(entry => entry.category === 'character').content.includes('城南捕快'));
    assert.ok(merged.find(entry => entry.category === 'location').content.includes('更大的港口'));
});

await test('organizeWorldbookEntries 只整理选中的条目并遵守分类上限', () => {
    const entries = [
        { category: 'character', categoryLabel: '角色', name: ' 张三 ', keywords: ['张三', '张三'], content: '## 身份\n捕快。\n\n## 身份\n捕快。\n\n负责城南治安。' },
        { category: 'character', categoryLabel: '角色', name: '李四', keywords: ['李四'], content: '## 身份\n商人。\n\n## 身份\n商人。' },
    ];
    const next = organizeWorldbookEntries(entries, { indexes: [0], limitFor: () => 600 });
    assert.equal(next[0].name, '张三');
    assert.equal((next[0].content.match(/## 身份/g) || []).length, 1);
    assert.equal(next[1], entries[1], '未选中的条目应原样返回');
});

await test('parseOrganizeResponse 兼容纯文本 / 代码块 / JSON，并拒绝限流提示', () => {
    assert.equal(parseOrganizeResponse('整理后的内容：\n## 身份\n捕快。'), '## 身份\n捕快。');
    assert.equal(parseOrganizeResponse('```json\n{"内容":"## 身份\\n捕快。"}\n```'), '## 身份\n捕快。');
    assert.equal(parseOrganizeResponse('{"content":"捕快。"}'), '捕快。');
    assert.throws(() => parseOrganizeResponse('Proxy queue error, please retry'), /限流或排队/);
    assert.throws(() => parseOrganizeResponse('  '), /空内容/);
    assert.throws(() => parseOrganizeResponse('请整理下面的世界书条目「张三」。\n【原始内容】\n捕快。'), /提示词复述/);
    const prompt = buildOrganizePrompt('整理「{NAME}」（{CATEGORY}）：\n{CONTENT}', {
        name: '张三',
        categoryLabel: '角色',
        content: '捕快。',
    });
    assert.match(prompt, /整理「张三」（角色）/);
    assert.match(prompt, /捕快。/);
});

await test('parseDuplicateJudgement 解析布尔 / 中文字段，无法解析时返回 null', () => {
    assert.deepEqual(
        parseDuplicateJudgement('```json\n{"same":true,"mainName":"张三","reason":"同一人"}\n```'),
        { same: true, mainName: '张三', reason: '同一人' },
    );
    assert.equal(parseDuplicateJudgement('{"isSame":false,"reason":"不同"}')?.same, false);
    assert.equal(parseDuplicateJudgement('{"判定":"同一"}'), null);
    assert.equal(parseDuplicateJudgement('模型不知道'), null);
});

await test('normalizeSearchQuery 合并空白，findOccurrences 不区分大小写并计数', () => {
    assert.equal(normalizeSearchQuery('  旧 港\n雨  '), '旧 港 雨');
    const text = '旧港的雨。Old Harbor，旧港的灯。old harbor';
    assert.deepEqual(findOccurrences(text, '旧港'), [
        { offset: 0, length: 2 },
        { offset: 16, length: 2 },
    ]);
    assert.equal(findOccurrences(text, 'old harbor').length, 2);
    assert.equal(findOccurrences(text, 'old harbor', { limit: 1 }).length, 1);
    assert.deepEqual(findOccurrences(text, ''), []);
});

await test('buildSnippet 只截取命中附近并压掉换行', () => {
    const text = `开头\n\n${'铺垫'.repeat(20)}旧港${'后续'.repeat(20)}`;
    const offset = text.indexOf('旧港');
    const snippet = buildSnippet(text, offset, 2, { before: 4, after: 6 });
    assert.equal(snippet.match, '旧港');
    assert.equal(snippet.prefix, '铺垫铺垫');
    assert.equal(snippet.suffix, '后续后续后续');
    assert.equal(snippet.truncatedStart, true);
    assert.equal(snippet.truncatedEnd, true);
    const short = buildSnippet('旧港', 0, 2);
    assert.equal(short.prefix, '');
    assert.equal(short.truncatedStart, false);
});

await test('findPageForOccurrence 把章节内的第 N 次命中定位到对应页', () => {
    const pages = ['旧港的雨。', '旧港的灯。', '别处。', '旧港的船。'];
    assert.equal(findPageForOccurrence(pages, '旧港', 0), 0);
    assert.equal(findPageForOccurrence(pages, '旧港', 1), 1);
    assert.equal(findPageForOccurrence(pages, '旧港', 2), 3);
    assert.equal(findPageForOccurrence(pages, '旧港', 9), 0, '超出范围时回退到第一页');
});

await test('splitHighlight 把命中词切成可安全构建 <mark> 的片段', () => {
    assert.deepEqual(splitHighlight('旧港的旧港', '旧港'), [
        { text: '旧港', match: true },
        { text: '的', match: false },
        { text: '旧港', match: true },
    ]);
    assert.deepEqual(splitHighlight('没有命中', '旧港'), [{ text: '没有命中', match: false }]);
    assert.deepEqual(splitHighlight('', '旧港'), []);
});

await test('sanitizeMemoInput 统一换行、压缩标题并按上限截断', () => {
    const clean = sanitizeMemoInput({
        title: '  旧港   的雨  ',
        content: '第一行\r\n第二行\u0000\r第三行\n\n',
    });
    assert.equal(clean.title, '旧港 的雨');
    assert.equal(clean.content, '第一行\n第二行\n第三行');
    assert.equal(clean.truncated, false);

    const long = sanitizeMemoInput({ title: '题'.repeat(100), content: '字'.repeat(MEMO_MAX_CHARS + 20) });
    assert.equal(Array.from(long.title).length, 80);
    assert.equal(Array.from(long.content).length, MEMO_MAX_CHARS);
    assert.equal(long.truncated, true);
});

await test('memoTitle 没写标题时取正文第一行，过长时省略', () => {
    assert.equal(memoTitle({ title: ' 伏笔 ', content: '正文' }), '伏笔');
    assert.equal(memoTitle({ title: '', content: '\n\n  第一行内容  \n第二行' }), '第一行内容');
    assert.equal(memoTitle({ title: '', content: '' }), '未命名备忘');
    const long = memoTitle({ content: '长'.repeat(40) });
    assert.equal(Array.from(long).length, 25);
    assert.ok(long.endsWith('…'));
});

await test('filterMemos 支持标题 / 正文关键词与只看置顶', () => {
    const memos = [
        { id: 'a', title: '旧港的钥匙', content: '铜钥匙放在木箱上。', pinned: true },
        { id: 'b', title: '人物', content: '林默把湿围巾往上拉了拉。', pinned: false },
        { id: 'c', title: '', content: '旧港的档案被重写过。', pinned: false },
    ];
    assert.deepEqual(filterMemos(memos).map(memo => memo.id), ['a', 'b', 'c']);
    assert.deepEqual(filterMemos(memos, { query: '旧港' }).map(memo => memo.id), ['a', 'c']);
    assert.deepEqual(filterMemos(memos, { query: '林默' }).map(memo => memo.id), ['b']);
    assert.deepEqual(filterMemos(memos, { pinnedOnly: true }).map(memo => memo.id), ['a']);
    assert.deepEqual(filterMemos(memos, { query: '不存在的词' }), []);
});

await test('memosInScope 按章节 / 未绑定位置筛选', () => {
    const memos = [
        { id: 'a', chapterIndex: 0 },
        { id: 'b', chapterIndex: 2 },
        { id: 'c', chapterIndex: null },
        { id: 'd' },
    ];
    assert.deepEqual(memosInScope(memos, 'all').map(memo => memo.id), ['a', 'b', 'c', 'd']);
    assert.deepEqual(memosInScope(memos, 'loose').map(memo => memo.id), ['c', 'd']);
    assert.deepEqual(memosInScope(memos, 2).map(memo => memo.id), ['b']);
    assert.deepEqual(memosInScope(memos, '2').map(memo => memo.id), ['b']);
    assert.deepEqual(memosInScope(memos, 9), []);
});

await test('sortMemos 置顶优先，并按更新 / 创建 / 标题 / 章节排序', () => {
    const memos = [
        { id: 'old', title: 'C 旧', chapterIndex: 2, page: 1, pinned: false, createdAt: 10, updatedAt: 30 },
        { id: 'new', title: 'A 新', chapterIndex: 0, page: 3, pinned: false, createdAt: 30, updatedAt: 10 },
        { id: 'pin', title: 'Z 置顶', chapterIndex: 1, page: 2, pinned: true, createdAt: 1, updatedAt: 1 },
        { id: 'loose', title: 'B 散', chapterIndex: null, page: null, pinned: false, createdAt: 5, updatedAt: 20 },
    ];
    assert.deepEqual(sortMemos(memos, 'updated').map(memo => memo.id), ['pin', 'old', 'loose', 'new']);
    assert.deepEqual(sortMemos(memos, 'created').map(memo => memo.id), ['pin', 'new', 'old', 'loose']);
    assert.deepEqual(sortMemos(memos, 'chapter').map(memo => memo.id), ['pin', 'new', 'old', 'loose']);
    assert.deepEqual(sortMemos(memos, 'title').map(memo => memo.id), ['pin', 'new', 'loose', 'old']);
    // 不修改原数组
    assert.equal(memos[0].id, 'old');
});

await test('sortMemoGroups 按 order、创建时间排序', () => {
    const groups = [
        { id: 'c', name: '丙', order: 3, createdAt: 1 },
        { id: 'a', name: '甲', order: 1, createdAt: 2 },
        { id: 'b', name: '乙', order: 2, createdAt: 3 },
    ];
    assert.deepEqual(sortMemoGroups(groups).map(group => group.id), ['a', 'b', 'c']);
    assert.deepEqual(sortMemoGroups([{ id: 'x', name: 'X', createdAt: 2 }, { id: 'y', name: 'Y', createdAt: 1 }])
        .map(group => group.id), ['y', 'x']);
});

await test('countMemosByChapter 把未绑定位置的记到 null 上', () => {
    const counts = countMemosByChapter([
        { chapterIndex: 0 },
        { chapterIndex: 0 },
        { chapterIndex: 2 },
        { chapterIndex: null },
        {},
    ]);
    assert.equal(counts.get(0), 2);
    assert.equal(counts.get(2), 1);
    assert.equal(counts.get(null), 2);
    assert.equal(counts.get(1), undefined);
});

await test('memoChapterLabel / memoAnchorLabel 显示章节与页码且不重复编号', () => {
    const chapters = [
        { index: 0, title: '第一章 雨夜' },
        { index: 1, title: '旧港' },
        { index: 2, title: '第2章 雾' },
        { index: 3, title: 'Chapter 3 归来' },
        { index: 4, title: '' },
    ];
    assert.equal(memoChapterLabel({ title: '第2章 旧港的钥匙' }, 2), '第2章 旧港的钥匙');
    assert.equal(memoChapterLabel({ title: 'Chapter 3 归来' }, 3), 'Chapter 3 归来');
    assert.equal(memoChapterLabel({ title: '雾中的旧友' }, 7), '第 7 章 雾中的旧友');
    assert.equal(memoChapterLabel({ title: '' }, 4), '第 4 章');

    assert.equal(memoAnchorLabel({ chapterIndex: 0, page: 2 }, chapters), '第一章 雨夜 · 第 3 页');
    assert.equal(memoAnchorLabel({ chapterIndex: 1 }, chapters), '第 2 章 旧港');
    assert.equal(memoAnchorLabel({ chapterIndex: 2, page: 0 }, chapters), '第2章 雾 · 第 1 页');
    assert.equal(memoAnchorLabel({ chapterIndex: 3 }, chapters), 'Chapter 3 归来');
    assert.equal(memoAnchorLabel({ chapterIndex: 4 }, chapters), '第 5 章');
    assert.equal(memoAnchorLabel({ chapterIndex: null, page: 2 }, chapters), '');
    assert.equal(memoAnchorLabel({ chapterIndex: 9 }, chapters), '第 10 章');
});

await test('memoClipboardText 只复制正文，memoTitleFromContent 自动取第一行做标题', () => {
    assert.equal(memoClipboardText({ title: '伏笔', content: '玉佩未回收。' }), '玉佩未回收。');
    assert.equal(memoClipboardText({ title: '', content: '只有正文。' }), '只有正文。');
    assert.equal(memoTitleFromContent('\n\n  第一行作为标题  \n正文'), '第一行作为标题');
    assert.equal(memoTitleFromContent(''), '');
    assert.equal(Array.from(memoTitleFromContent('题'.repeat(100))).length, 80);
});

await test('buildMemoExportMarkdown 按章节分组，未绑定位置放最后', () => {
    const chapters = [
        { index: 0, title: '第一章 雨夜' },
        { index: 1, title: '第二章 旧港' },
    ];
    const text = buildMemoExportMarkdown({
        novelTitle: '雾港十二夜',
        exportedAt: Date.UTC(2024, 0, 2, 3, 4, 5),
        chapters,
        memos: [
            { title: '全书设定', content: '港口常年有雾。', chapterIndex: null, page: null, pinned: false, createdAt: 1, updatedAt: 2 },
            { title: '钥匙', content: '铜钥匙。', chapterIndex: 1, page: 0, pinned: true, createdAt: 2, updatedAt: 3 },
            { title: '', content: '雨点砸在铁皮上。', chapterIndex: 0, page: 0, pinned: false, createdAt: 3, updatedAt: 4 },
        ],
    });
    assert.match(text, /^# 雾港十二夜 · 备忘录/);
    assert.match(text, /共 3 条/);
    assert.match(text, /## 第一章 雨夜/);
    assert.match(text, /### 雨点砸在铁皮上。/);
    assert.match(text, /## 第二章 旧港/);
    assert.match(text, /### 钥匙/);
    assert.match(text, /## 未绑定位置/);
    assert.match(text, /### 全书设定/);
    assert.ok(text.indexOf('## 第一章 雨夜') < text.indexOf('## 第二章 旧港'));
    assert.ok(text.indexOf('## 第二章 旧港') < text.indexOf('## 未绑定位置'));
});

await test('buildMemoExportMarkdown 分组模式不输出章节和未绑定位置', () => {
    const text = buildMemoExportMarkdown({
        novelTitle: '伏笔整理',
        exportedAt: Date.UTC(2024, 0, 2, 3, 4, 5),
        groupMode: true,
        memos: [
            { title: '旧港的钥匙', content: '铜钥匙放在木箱上。', groupId: 'g1', novelId: null, chapterIndex: null, page: null, pinned: false, createdAt: 1, updatedAt: 2 },
            { title: '十二年前的火灾', content: '档案被重写过。', groupId: 'g1', novelId: null, chapterIndex: null, page: null, pinned: true, createdAt: 2, updatedAt: 3 },
        ],
    });
    assert.match(text, /^# 伏笔整理 · 备忘录/);
    assert.match(text, /共 2 条/);
    assert.match(text, /### 旧港的钥匙/);
    assert.match(text, /### 十二年前的火灾/);
    assert.doesNotMatch(text, /未绑定位置/);
    assert.doesNotMatch(text, /^## 第/m);
});

/* ------------------------------------------------------------------ */
/* 网络找书                                                            */
/* ------------------------------------------------------------------ */

await test('decodeEntities 解码常见与数字实体', () => {
    assert.equal(decodeEntities('&amp;&lt;&gt;&quot;&#39;'), '&<>"\'');
    assert.equal(decodeEntities('&#20320;&#x597d;'), '你好');
    assert.equal(decodeEntities('&nbsp;x'), ' x');
    assert.equal(decodeEntities('原样 &unknown; 保留'), '原样 &unknown; 保留');
});

await test('parseHtml 建树、取文本、支持 br 换行与隐式闭合', () => {
    const root = parseHtml('<div id="a" class="box"><p>第一段<br>第二行<p>第三段</div>');
    const box = querySelector(root, 'div#a.box');
    assert.ok(box);
    assert.deepEqual(toLines(textOf(box)), ['第一段', '第二行', '第三段']);
    assert.equal(querySelectorAll(root, '#a p').length, 2);
    assert.equal(querySelectorAll(root, '#a').length, 1);
});

await test('parseHtml 跳过 script / style / 注释', () => {
    const root = parseHtml('<div><script>var a = "<p>假的</p>";</script><!-- 注释 --><style>.a{}</style><p>真文本</p></div>');
    assert.equal(toLines(textOf(root)).join(''), '真文本');
});

await test('querySelectorAll 支持 tag / #id / .class / 后代与属性', () => {
    const root = parseHtml('<ul><li class="x"><a href="/1">一</a></li><li class="x"><a href="/2" rel="next">二</a></li></ul>');
    assert.equal(querySelectorAll(root, 'li').length, 2);
    assert.equal(querySelectorAll(root, 'li.x a').length, 2);
    assert.equal(querySelectorAll(root, 'a[rel="next"]').length, 1);
    assert.equal(querySelectorAll(root, 'a[href^="/1"]').length, 1);
});

await test('normalizeUrl 补全相对地址并过滤危险协议', () => {
    assert.equal(normalizeUrl('/book/1', 'https://a.test/x/y'), 'https://a.test/book/1');
    assert.equal(normalizeUrl('https://b.test/p?q=1#frag'), 'https://b.test/p?q=1');
    assert.equal(normalizeUrl('javascript:alert(1)', 'https://a.test/'), '');
    assert.equal(normalizeUrl('#top', 'https://a.test/'), '');
    assert.equal(normalizeUrl('ftp://a.test/f', 'https://a.test/'), '');
});

await test('isChapterTitle 识别章节标题并排除普通句子', () => {
    for (const title of ['第1章 雨夜', '第 12 回 归来', '序章', '番外一', 'Chapter 3', '3、开端']) {
        assert.equal(isChapterTitle(title), true, title);
    }
    assert.equal(isChapterTitle('他推开门，看见雨还在下。'), false);
});

await test('cleanBookTitle 去掉站点后缀', () => {
    assert.equal(cleanBookTitle('雾港测试_最新章节_雾港小说网'), '雾港测试');
    assert.equal(cleanBookTitle('《诡秘之主》'), '诡秘之主');
});

await test('cleanChapterLines 过滤广告行与连续重复行', () => {
    const lines = ['正文第一段。', '请记住本站域名 www.mock.test', '正文第一段。', '下一章', '正文第二段。'];
    assert.deepEqual(cleanChapterLines(lines), ['正文第一段。', '正文第二段。']);
});

await test('parseBookPage 解析目录、元信息与章节顺序', () => {
    const html = `<html><head>
<meta property="og:novel:book_name" content="雾港测试">
<meta property="og:novel:author" content="测试作者">
<title>雾港测试_最新章节_雾港小说网</title>
</head><body>
<div class="hot"><a href="/book/1024/900.html">最新：第99章</a><a href="/book/1024/901.html">最新：第98章</a></div>
<div id="list"><dl>
<dd><a href="/book/1024/100.html">第1章 开始</a></dd>
<dd><a href="/book/1024/101.html">第2章 继续</a></dd>
<dd><a href="/book/1024/102.html">第3章 结束</a></dd>
<dd><a href="/book/1024/103.html">第4章 归途</a></dd>
</dl></div>
</body></html>`;
    const book = parseBookPage(html, 'https://mock.test/book/1024/');
    assert.equal(book.title, '雾港测试');
    assert.equal(book.author, '测试作者');
    assert.equal(book.isChapterPage, false);
    assert.equal(book.chapters.length, 4);
    assert.equal(book.chapters[0].title, '第1章 开始');
    assert.equal(book.chapters[0].url, 'https://mock.test/book/1024/100.html');
});

await test('parseBookPage 把倒序目录翻回正序', () => {
    const html = `<div id="list">
<a href="/x/5.html">第5章 e</a><a href="/x/4.html">第4章 d</a><a href="/x/3.html">第3章 c</a>
<a href="/x/2.html">第2章 b</a><a href="/x/1.html">第1章 a</a></div>`;
    const book = parseBookPage(html, 'https://mock.test/book/1/');
    assert.equal(book.chapters.length, 5);
    assert.equal(book.chapters[0].title, '第1章 a');
    assert.equal(book.chapters[4].title, '第5章 e');
});

await test('parseBookPage 识别章节页并给出目录链接', () => {
    const body = '这是一段正文，'.repeat(60);
    const html = `<html><body><h1>第3章 结束</h1>
<div id="content">${body}</div>
<a href="/book/1024/">返回目录</a></body></html>`;
    const page = parseBookPage(html, 'https://mock.test/book/1024/103.html');
    assert.equal(page.isChapterPage, true);
    assert.equal(page.tocUrl, 'https://mock.test/book/1024/');
});

await test('parseChapterPage 提取正文、清广告、找上下章', () => {
    const paragraph = index => `<p>第 ${index} 段正文，港口在雨里亮着灯，铁皮棚上全是水声，远处的汽笛一遍遍响。</p>`;
    const body = Array.from({ length: 8 }, (_, index) => paragraph(index + 1)).join('');
    const html = `<html><body><h1>第3章 结束</h1>
<div id="content">${body}<p>请记住本站域名 www.mock.test</p><p>上一章</p></div>
<div class="nav"><a href="/book/1024/102.html">上一章</a><a href="/book/1024/104.html">下一章</a></div>
</body></html>`;
    const chapter = parseChapterPage(html, 'https://mock.test/book/1024/103.html');
    assert.equal(chapter.title, '第3章 结束');
    assert.match(chapter.text, /第 1 段正文/);
    assert.match(chapter.text, /第 8 段正文/);
    assert.doesNotMatch(chapter.text, /请记住本站/);
    assert.doesNotMatch(chapter.text, /^上一章$/m);
    assert.equal(chapter.nextUrl, 'https://mock.test/book/1024/104.html');
    assert.equal(chapter.prevUrl, 'https://mock.test/book/1024/102.html');
    assert.ok(chapter.charCount > 100);
});

await test('parseChapterPage 短章节走 body 兜底', () => {
    const html = '<html><body><h1>第1章 短</h1><p>只有一句话的短诗，但这句话写得长一点，用来确保整页文本超过兜底的最小长度。</p></body></html>';
    const chapter = parseChapterPage(html, 'https://mock.test/book/1/1.html');
    assert.match(chapter.text, /只有一句话的短诗/);
});

await test('parseSearchPage 通用兜底能捡出外链', () => {
    const html = `<div class="list">
<a href="/book/1">第1章 开始</a>
<a href="https://other.test/book/2">另一本书 · 雾港往事</a>
<a href="https://other.test/book/2">另一本书 · 雾港往事</a>
</div>`;
    const results = parseSearchPage(html, 'https://mock.test/search?q=x');
    const urls = results.map(item => item.url);
    assert.equal(new Set(urls).size, urls.length);
    assert.ok(urls.includes('https://other.test/book/2'));
    assert.ok(urls.includes('https://mock.test/book/1'));
});

await test('parseSearchPage 认通用结果块（.result / article）', () => {
    const html = `<html><body><div class="result"><h3><a href="https://a.test/1">甲书</a></h3><p>简介甲</p></div>
<div class="result"><h3><a href="https://a.test/2">乙书</a></h3></div></body></html>`;
    const results = parseSearchPage(html, 'https://a.test/search?q=x');
    assert.equal(results.length, 2);
    assert.equal(results[0].title, '甲书');
    assert.equal(results[0].url, 'https://a.test/1');
});

await test('旧网页搜索设置迁移到「书源」并清掉引擎字段', () => {
    for (const legacy of ['web', 'bing', 'searxng', 'site', 'none', '乱填']) {
        assert.equal(normalizeOnlineSettings({ searchEngine: legacy }).searchEngine, 'source', legacy);
    }
    assert.equal(normalizeOnlineSettings({ searchEngine: 'fanqie' }).searchEngine, 'fanqie');
    const cleaned = normalizeOnlineSettings({
        searchEngine: 'web',
        webEngine: 'google',
        searchUrlTemplate: 'https://x/?q={q}',
        keywordSuffix: ' 小说',
        searxngUrl: 'https://sx.test',
        siteUrl: 'https://x',
        siteSearchTemplate: '/s',
        f2bBase: '/x',
    });
    for (const gone of ['webEngine', 'searchUrlTemplate', 'keywordSuffix', 'searxngUrl', 'siteUrl', 'siteSearchTemplate', 'f2bBase']) {
        assert.equal(gone in cleaned, false, gone);
    }
});

await test('normalizeOnlineSettings 夹取 pageSize', () => {
    assert.equal(normalizeOnlineSettings({ pageSize: 0 }).pageSize, 5);
    assert.equal(normalizeOnlineSettings({ pageSize: 999 }).pageSize, 50);
    assert.equal(normalizeOnlineSettings({ pageSize: 10 }).pageSize, 10);
});

await test('normalizeOnlineSettings 夹取数值并兜住非法枚举', () => {
    const settings = normalizeOnlineSettings({ concurrency: 99, timeoutMs: 1, downloadLimit: -3, channel: 'bogus', searchEngine: 'bogus' });
    assert.equal(settings.concurrency, 8);
    assert.equal(settings.timeoutMs, 3000);
    assert.equal(settings.downloadLimit, 0);
    assert.equal(settings.channel, 'auto');
    assert.equal(settings.searchEngine, 'source');
});

await test('buildProxyUrl 支持 {url} / {raw} / 直接拼接', () => {
    assert.equal(buildProxyUrl('https://p.test/?url={url}', 'https://a.test/b?c=1'), 'https://p.test/?url=https%3A%2F%2Fa.test%2Fb%3Fc%3D1');
    assert.equal(buildProxyUrl('https://p.test/{raw}', 'https://a.test/b'), 'https://p.test/https://a.test/b');
    assert.equal(buildProxyUrl('https://p.test/raw', 'https://a.test/b'), 'https://p.test/raw?url=https%3A%2F%2Fa.test%2Fb');
    assert.equal(buildProxyUrl('', 'https://a.test/'), '');
});

await test('detectCharset / decodeHtmlBytes 处理 GBK 页面', () => {
    const bytes = iconv.encode('<html><head><meta charset="gb2312"></head><body>中文正文</body></html>', 'gbk');
    assert.equal(detectCharset(bytes), 'gb18030');
    assert.match(decodeHtmlBytes(bytes), /中文正文/);
    const utf8 = new TextEncoder().encode('<html><meta charset="utf-8">你好</html>');
    assert.equal(detectCharset(utf8), 'utf-8');
    assert.match(decodeHtmlBytes(utf8), /你好/);
});

await test('buildBookText 按章节拼出可导入的 TXT', () => {
    const text = buildBookText(
        { title: '雾港测试', author: '测试作者', url: 'https://mock.test/book/1024/' },
        [{ title: '第1章 开始', content: '正文一' }, { title: '第2章 空', content: '' }],
    );
    assert.match(text, /^雾港测试/);
    assert.match(text, /作者：测试作者/);
    assert.match(text, /第1章 开始\n\n正文一/);
    assert.doesNotMatch(text, /第2章 空/);
});

await test('bookIdFromUrl 生成稳定且区分的临时 id', () => {
    const first = bookIdFromUrl('https://mock.test/book/1024/');
    assert.equal(first, bookIdFromUrl('https://mock.test/book/1024/'));
    assert.notEqual(first, bookIdFromUrl('https://mock.test/book/2048/'));
    assert.match(first, /^mock\.test-/);
});

await test('NovelFetcher 依次试桥接 → 酒馆通道 → 直连', async () => {
    const visited = [];
    const page = `<html><body>${'内容'.repeat(80)}</body></html>`;
    const fetcher = new NovelFetcher({
        settings: { channel: 'auto' },
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        fetchImpl: async (url, options = {}) => {
            visited.push(String(url));
            if (String(url) === '/api/search/visit') {
                return { ok: false, status: 500, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) };
            }
            return {
                ok: true,
                status: 200,
                text: async () => page,
                arrayBuffer: async () => new TextEncoder().encode(page).buffer,
            };
        },
    });
    const html = await fetcher.fetchHtml('https://mock.test/book/1');
    assert.ok(html.includes('内容'));
    // 桥接优先（它的 /fetch 回的不是 JSON，这里当成“这次桥接不行”），再依次退酒馆通道、直连
    assert.deepEqual(visited, ['/api/plugins/fanqie-bridge/fetch', '/api/search/visit', 'https://mock.test/book/1']);
    assert.equal(fetcher.lastChannel, 'direct');
    assert.ok(html.length > 60);
});

await test('NovelFetcher 按设置只走指定通道', async () => {
    const fetcher = new NovelFetcher({
        settings: { channel: 'tavern' },
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        fetchImpl: async () => ({ ok: false, status: 502, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) }),
    });
    await assert.rejects(() => fetcher.fetchHtml('https://mock.test/book/1'), /酒馆网页通道|抓取失败/);
});

await test('NovelFetcher.openBook 从章节页找到目录', async () => {
    const bookHtml = `<html><body><h1>雾港测试</h1><div id="list"><dl>
<dd><a href="/book/1024/1001.html">第1章 开始</a></dd>
<dd><a href="/book/1024/1002.html">第2章 继续</a></dd>
<dd><a href="/book/1024/1003.html">第3章 结束</a></dd>
</dl></div></body></html>`;
    const chapterHtml = `<html><body><h1>第1章 开始</h1><div id="content">${'正文一句。'.repeat(40)}</div>
<a href="/book/1024/">返回目录</a></body></html>`;
    const fetcher = new NovelFetcher({
        settings: { channel: 'direct' },
        fetchImpl: async url => {
            const body = String(url).endsWith('.html') ? chapterHtml : bookHtml;
            return {
                ok: true,
                status: 200,
                text: async () => body,
                arrayBuffer: async () => new TextEncoder().encode(body).buffer,
            };
        },
    });
    const book = await fetcher.openBook('https://mock.test/book/1024/1001.html');
    assert.equal(book.chapters.length, 3);
    assert.equal(book.title, '雾港测试');
    assert.equal(book.chapters[1].url, 'https://mock.test/book/1024/1002.html');
});



/* ------------------------------------------------------------------ */
/* 书源（导入的站点规则）                                               */
/* ------------------------------------------------------------------ */

const SOURCE_FIXTURE = {
    name: '雾港书源',
    url: 'https://novel.example.com',
    search: {
        url: '/search?q={key}&page={page}',
        list: '.result',
        title: 'h3 a',
        link: 'h3 a@href',
        author: '.author',
        intro: '.intro',
    },
    book: {
        title: 'h1',
        author: '.info .author',
        intro: '#intro',
        tocList: '#list dd',
        chapterTitle: 'a',
        chapterUrl: 'a@href',
    },
    chapter: { title: 'h1', content: '#content' },
};

const SOURCE_SEARCH_HTML = `<html><body>
<div class="result"><h3><a href="/book/1/">甲书</a></h3>
<span class="author">作者甲</span><p class="intro">甲书的简介</p></div>
<div class="result"><h3><a href="/book/2/">乙书</a></h3>
<span class="author">作者乙</span><p class="intro">乙书的简介</p></div>
</body></html>`;

const SOURCE_BOOK_HTML = `<html><body>
<h1>甲书</h1>
<div class="info"><span class="author">作者甲</span></div>
<div id="intro">这是甲书的简介，长度够长可以当简介用了。</div>
<div id="list"><dl>
<dd><a href="/book/1/1001.html">第1章 开始</a></dd>
<dd><a href="/book/1/1002.html">第2章 继续</a></dd>
</dl></div>
</body></html>`;

const SOURCE_CHAPTER_HTML = `<html><body>
<h1>第1章 开始</h1>
<div id="content"><p>正文第一段，长度足够触发正文解析。</p><p>正文第二段。</p></div>
</body></html>`;

await test('parseRule 拆选择器与属性', () => {
    assert.deepEqual(parseRule('h3 a'), { selector: 'h3 a', attr: '', advanced: false });
    assert.deepEqual(parseRule('h3 a@href'), { selector: 'h3 a', attr: 'href', advanced: false });
    assert.deepEqual(parseRule('@css:#list dd@text'), { selector: '#list dd', attr: '', advanced: false });
    assert.equal(parseRule('@js:result').advanced, true);
    assert.equal(parseRule('$.name').advanced, true);
    assert.equal(parseRule('//div[@id="x"]').advanced, true);
});

await test('convertLegadoRule 转链式规则，高级规则标记跳过', () => {
    assert.equal(convertLegadoRule('class.result@tag.h3@tag.a@href').rule, '.result h3 a@href');
    assert.equal(convertLegadoRule('id.list@tag.dd@tag.a').rule, '#list dd a');
    assert.equal(convertLegadoRule('@css:#content').rule, '#content');
    assert.equal(convertLegadoRule('$.data.list').advanced, true);
    assert.equal(convertLegadoRule('class.x@js:java.getString("a")').advanced, true);
});

await test('normalizeSource 校验必填项并生成稳定 id', () => {
    const source = normalizeSource(SOURCE_FIXTURE);
    assert.equal(source.name, '雾港书源');
    assert.equal(source.type, 'native');
    assert.equal(source.enabled, true);
    assert.match(source.id, /^src_/);
    assert.equal(normalizeSource({ ...SOURCE_FIXTURE }).id, source.id);
    assert.equal(normalizeSource({ name: '只有名字' }), null);
    assert.equal(normalizeSource({ url: 'https://x.test' }), null);
});

await test('importSources 认单条 / 数组 / {sources} 与 Legado 书源', () => {
    const single = importSources(JSON.stringify(SOURCE_FIXTURE));
    assert.equal(single.sources.length, 1);
    assert.equal(single.warnings.length, 0);

    const many = importSources({ sources: [SOURCE_FIXTURE, { ...SOURCE_FIXTURE, name: '第二源', url: 'https://two.test' }] });
    assert.equal(many.sources.length, 2);

    const legado = importSources({
        bookSourceName: '阅读源',
        bookSourceUrl: 'https://legado.example.com',
        searchUrl: '/s?q={{key}}&page={{page}}',
        ruleSearch: { bookList: 'class.result', name: 'tag.h3@tag.a', bookUrl: 'tag.a@href' },
        ruleBookInfo: { name: 'tag.h1', author: 'class.author' },
        ruleToc: { chapterList: 'id.list@tag.dd', chapterName: 'tag.a', chapterUrl: 'tag.a@href' },
        ruleContent: { content: 'id.content' },
    });
    const source = legado.sources[0];
    assert.equal(source.type, 'legado');
    assert.equal(source.search.list, '.result');
    assert.equal(source.search.title, 'h3 a');
    assert.equal(source.book.chapterUrl, 'a@href');
    assert.equal(source.chapter.content, '#content');

    const withAdvanced = importSources({
        bookSourceName: '脚本源',
        bookSourceUrl: 'https://js.example.com',
        searchUrl: '/s?q={{key}}',
        ruleSearch: { bookList: '@js:java.getElements()', name: 'tag.a' },
    });
    assert.equal(withAdvanced.sources[0].search.list, '');
    assert.ok(withAdvanced.warnings.some(line => line.includes('高级规则')));

    assert.throws(() => importSources('{ 不是 JSON'), /不是合法 JSON/);
});

await test('requestSourceCollection 带上酒馆 CSRF 头', async () => {
    let captured = null;
    const result = await requestSourceCollection({
        url: 'https://example.com/sources.json',
        getRequestHeaders: () => ({ 'X-CSRF-Token': 'test-token' }),
        fetchImpl: async (route, options) => {
            captured = { route, options };
            return { ok: true, json: async () => ({ ok: true, total: 0 }) };
        },
    });
    assert.equal(result.ok, true);
    assert.equal(captured.options.headers['X-CSRF-Token'], 'test-token');
    assert.equal(captured.options.method, 'POST');
});

await test('mergeSources 同站同名覆盖、其余追加', () => {
    const first = importSources(SOURCE_FIXTURE).sources;
    const again = importSources({ ...SOURCE_FIXTURE, search: { ...SOURCE_FIXTURE.search, list: '.item' } }).sources;
    const merged = mergeSources(first, again);
    assert.equal(merged.sources.length, 1);
    assert.equal(merged.replaced, 1);
    assert.equal(merged.sources[0].search.list, '.item');
    const added = mergeSources(first, importSources({ ...SOURCE_FIXTURE, name: '别的源' }).sources);
    assert.equal(added.sources.length, 2);
    assert.equal(added.added, 1);
});

await test('buildSourceSearchUrl 处理占位符与分页', () => {
    const source = normalizeSource(SOURCE_FIXTURE);
    assert.equal(buildSourceSearchUrl(source, '雾港', 1), 'https://novel.example.com/search?q=%E9%9B%BE%E6%B8%AF&page=1');
    assert.equal(buildSourceSearchUrl(source, '雾港', 3), 'https://novel.example.com/search?q=%E9%9B%BE%E6%B8%AF&page=3');
    const legado = normalizeSource({ ...SOURCE_FIXTURE, search: { ...SOURCE_FIXTURE.search, url: 'https://search.example.com/s?kw={{key}}' } });
    assert.equal(buildSourceSearchUrl(legado, 'ab', 2), 'https://search.example.com/s?kw=ab&page=2');
    const noKey = normalizeSource({ ...SOURCE_FIXTURE, search: { ...SOURCE_FIXTURE.search, url: '/find' } });
    assert.equal(buildSourceSearchUrl(noKey, 'ab', 1), 'https://novel.example.com/find?q=ab');
    assert.equal(buildSourceSearchUrl(normalizeSource({ ...SOURCE_FIXTURE, search: { url: '' } }), 'ab'), '');
});

await test('sourceMatchesUrl 与 pickSource', () => {
    const source = normalizeSource(SOURCE_FIXTURE);
    assert.equal(sourceMatchesUrl(source, 'https://novel.example.com/book/1/'), true);
    assert.equal(sourceMatchesUrl(source, 'https://www.novel.example.com/book/1/'), true);
    assert.equal(sourceMatchesUrl(source, 'https://other.test/book/1/'), false);
    const disabled = [{ ...source, enabled: false }];
    assert.equal(pickSource(disabled, ''), null);
    const second = normalizeSource({ ...SOURCE_FIXTURE, name: '第二源', url: 'https://two.test' });
    assert.equal(pickSource([source, second], second.id).name, '第二源');
    assert.equal(pickSource([source, second], '不存在').name, '雾港书源');
});

await test('parseSourceSearchPage 用书源规则解析搜索结果', () => {
    const source = normalizeSource(SOURCE_FIXTURE);
    const results = parseSourceSearchPage(SOURCE_SEARCH_HTML, 'https://novel.example.com/search?q=x', source);
    assert.equal(results.length, 2);
    assert.equal(results[0].title, '甲书');
    assert.equal(results[0].url, 'https://novel.example.com/book/1/');
    assert.equal(results[0].site, '雾港书源');
    assert.match(results[0].snippet, /作者甲/);
});

await test('parseSourceSearchPage 规则没命中时退回通用解析', () => {
    const source = normalizeSource({ ...SOURCE_FIXTURE, search: { ...SOURCE_FIXTURE.search, list: '.nope' } });
    const bingHtml = `<html><body><ol><li class="b_algo"><h2><a href="https://site.test/b/1">某书 小说在线阅读</a></h2></li></ol></body></html>`;
    const results = parseSourceSearchPage(bingHtml, 'https://novel.example.com/search', source);
    assert.equal(results.length, 1);
    assert.equal(results[0].url, 'https://site.test/b/1');
});

await test('parseSourceBookPage 用书源规则取目录', () => {
    const source = normalizeSource(SOURCE_FIXTURE);
    const book = parseSourceBookPage(SOURCE_BOOK_HTML, 'https://novel.example.com/book/1/', source);
    assert.equal(book.title, '甲书');
    assert.equal(book.author, '作者甲');
    assert.match(book.intro, /甲书的简介/);
    assert.equal(book.chapters.length, 2);
    assert.equal(book.chapters[0].title, '第1章 开始');
    assert.equal(book.chapters[0].url, 'https://novel.example.com/book/1/1001.html');
    assert.equal(book.sourceId, source.id);
});

await test('parseSourceBookPage 目录规则失效时退回通用解析', () => {
    const source = normalizeSource({ ...SOURCE_FIXTURE, book: { ...SOURCE_FIXTURE.book, tocList: '#nope' } });
    const html = `<html><body><h1>甲书</h1><div id="list"><dl>
<dt>正文</dt><dd><a href="/b/1.html">第1章 一</a></dd><dd><a href="/b/2.html">第2章 二</a></dd><dd><a href="/b/3.html">第3章 三</a></dd>
</dl></div></body></html>`;
    const book = parseSourceBookPage(html, 'https://novel.example.com/b/', source);
    assert.ok(book.chapters.length >= 2);
    assert.equal(book.title, '甲书');
});

await test('parseSourceChapterPage 用书源规则取正文', () => {
    const source = normalizeSource(SOURCE_FIXTURE);
    const chapter = parseSourceChapterPage(SOURCE_CHAPTER_HTML, 'https://novel.example.com/book/1/1001.html', source);
    assert.equal(chapter.title, '第1章 开始');
    assert.match(chapter.text, /正文第一段/);
    assert.match(chapter.text, /正文第二段/);
    assert.equal(chapter.charCount, chapter.text.length);
});

await test('parseSourceChapterPage 正文规则失效时退回通用解析', () => {
    const source = normalizeSource({ ...SOURCE_FIXTURE, chapter: { ...SOURCE_FIXTURE.chapter, content: '#nope' } });
    const chapter = parseSourceChapterPage(SOURCE_CHAPTER_HTML, 'https://novel.example.com/book/1/1001.html', source);
    assert.match(chapter.text, /正文第一段/);
});

await test('NovelFetcher 用书源搜索：拼地址、解析、按主机找源取正文', async () => {
    const source = normalizeSource(SOURCE_FIXTURE);
    const calls = [];
    const fetcher = new NovelFetcher({
        settings: { channel: 'direct', searchEngine: 'source', sources: [source] },
        fetchImpl: async url => {
            calls.push(String(url));
            const body = String(url).includes('/search') ? SOURCE_SEARCH_HTML : SOURCE_CHAPTER_HTML;
            return {
                ok: true,
                status: 200,
                text: async () => body,
                arrayBuffer: async () => new TextEncoder().encode(body).buffer,
            };
        },
    });
    // 这个用例只想验「书源规则 + 直连」，把桥接当成没装，免得先撞一次 /fetch
    fetcher.bridgeAvailable = false;
    const results = await fetcher.searchBooks('雾港');
    assert.equal(calls[0], 'https://novel.example.com/search?q=%E9%9B%BE%E6%B8%AF&page=1');
    assert.equal(results.length, 2);

    const chapter = await fetcher.fetchChapter('https://novel.example.com/book/1/1001.html');
    assert.match(chapter.text, /正文第一段/);
});

await test('NovelFetcher 没有书源时给出可操作提示', async () => {
    const fetcher = new NovelFetcher({
        settings: { searchEngine: 'source' },
        fetchImpl: async () => ({ ok: true, status: 200, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) }),
    });
    await assert.rejects(() => fetcher.searchBooks('雾港'), /书源/);
});


/* ------------------------------------------------------------------ */
/* 书源聚合搜索                                                        */
/* ------------------------------------------------------------------ */

await test('mergeSourceResults 把不同书源的同一本书并成一条', () => {
    const merged = mergeSourceResults([
        { title: '《甲书》', author: '作者甲', url: 'https://a.test/1', site: '源A', sourceId: 'a', sourceName: '源A' },
        { title: '甲书', author: '作者甲 ', url: 'https://b.test/1', site: '源B', sourceId: 'b', sourceName: '源B' },
        { title: '甲书', author: '作者甲', url: 'https://a.test/1', site: '源A', sourceId: 'a', sourceName: '源A' },
        { title: '乙书', author: '', url: 'https://c.test/2', site: '源C', sourceId: 'c', sourceName: '源C' },
        // 不同书源指向同一个地址：都保留
        { title: '甲书', author: '作者甲', url: 'https://a.test/1', site: '源B2', sourceId: 'b2', sourceName: '源B2' },
    ]);
    assert.equal(merged.length, 2);
    assert.equal(merged[0].title, '《甲书》');
    assert.equal(merged[0].url, 'https://a.test/1');
    assert.equal(merged[0].sources.length, 3);
    assert.deepEqual(merged[0].sources.map(entry => entry.sourceName), ['源A', '源B', '源B2']);
    assert.equal(merged[1].sources.length, 1);
});

await test('auto 通道按 酒馆 → 直连 回退，并记住成功的通道', async () => {
    const tries = [];
    const fetcher = new NovelFetcher({
        settings: { channel: 'auto' },
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        fetchImpl: async (url) => {
            tries.push(String(url));
            if (String(url) === '/api/search/visit') {
                return { ok: false, status: 500, text: async () => 'fail', arrayBuffer: async () => new ArrayBuffer(0) };
            }
            const html = '<html><body>' + '直连拿到的正文'.repeat(20) + '</body></html>';
            return { ok: true, status: 200, text: async () => html, arrayBuffer: async () => new TextEncoder().encode(html).buffer };
        },
    });
    const html = await fetcher.fetchHtml('https://novel.example.com/a');
    assert.deepEqual(tries, [
        '/api/plugins/fanqie-bridge/fetch',
        '/api/search/visit',
        'https://novel.example.com/a',
    ]);
    assert.equal(fetcher.lastChannel, 'direct');
    assert.match(html, /直连拿到的正文/);

    tries.length = 0;
    await fetcher.fetchHtml('https://novel.example.com/b');
    assert.deepEqual(tries, ['https://novel.example.com/b'], '第二次直接用上次成功的直连');
});

await test('searchAllSources 并发搜所有启用的书源并汇总成败', async () => {
    const sources = [
        normalizeSource({ ...SOURCE_FIXTURE, name: '源A', url: 'https://a.test' }),
        normalizeSource({ ...SOURCE_FIXTURE, name: '源B', url: 'https://b.test' }),
        normalizeSource({ ...SOURCE_FIXTURE, name: '源C', url: 'https://c.test' }),
        normalizeSource({ ...SOURCE_FIXTURE, name: '源D', url: 'https://d.test', enabled: false }),
    ];
    const progress = [];
    const fetcher = new NovelFetcher({
        settings: { channel: 'direct', searchEngine: 'source', concurrency: 2, sources },
        fetchImpl: async url => {
            const target = String(url);
            if (target.includes('c.test')) throw new TypeError('Failed to fetch');
            const html = SOURCE_SEARCH_HTML;
            return { ok: true, status: 200, text: async () => html, arrayBuffer: async () => new TextEncoder().encode(html).buffer };
        },
    });
    const { results, perSource } = await fetcher.searchAllSources('雾港', {
        onProgress: info => progress.push(info.finished),
    });
    assert.equal(perSource.length, 3, '停用的书源不参与搜索');
    assert.equal(progress.length, 3);
    const c = perSource.find(item => item.name === '源C');
    assert.match(c.error, /抓取失败|跨域|Failed to fetch/i);
    assert.equal(perSource.filter(item => !item.error).length, 2);
    // 两个成功源返回同样的两本书 → 合并成 2 条，每条挂 2 个来源
    assert.equal(results.length, 2);
    assert.equal(results[0].sources.length, 2);
    assert.deepEqual(results[0].sources.map(item => item.sourceName).sort(), ['源A', '源B']);
});

await test('searchAllSources 每完成一个源就回调，同一搜索地址只抓一次', async () => {
    const sources = [
        normalizeSource({ ...SOURCE_FIXTURE, name: '源A', url: 'https://a.test' }),
        normalizeSource({ ...SOURCE_FIXTURE, name: '源B', url: 'https://a.test' }),
        normalizeSource({ ...SOURCE_FIXTURE, name: '源C', url: 'https://c.test' }),
    ];
    const fetched = [];
    const done = [];
    const fetcher = new NovelFetcher({
        settings: { channel: 'direct', searchEngine: 'source', concurrency: 1, sources },
        fetchImpl: async url => {
            fetched.push(String(url));
            const html = SOURCE_SEARCH_HTML;
            return {
                ok: true,
                status: 200,
                text: async () => html,
                arrayBuffer: async () => new TextEncoder().encode(html).buffer,
            };
        },
    });
    // 本用例验的是「同一地址只抓一次」，把桥接当成没装，别让 /fetch 混进 fetched
    fetcher.bridgeAvailable = false;
    const { results, perSource } = await fetcher.searchAllSources('雾港', {
        onSourceDone: info => done.push({ name: info.source.name, count: info.items.length }),
    });
    assert.equal(done.length, 3);
    assert.deepEqual(done.map(item => item.name), ['源A', '源B', '源C']);
    assert.equal(done[0].count, 2, '每个源先把自己搜到的 2 条交出去');
    // 源 A 与源 B 搜索地址相同 → 只抓一次
    assert.equal(fetched.length, 2);
    assert.equal(perSource.length, 3);
    assert.equal(results.length, 2);
    assert.equal(results[0].sources.length, 3);
});

await test('mergeSourceResults 默认按书源顺序，可切书名 / 到达顺序', () => {
    const items = [
        { title: '乙书', author: '', url: 'https://b.test/2', site: '源B', sourceId: 'b', sourceName: '源B', sourceOrder: 1 },
        { title: '甲书', author: '', url: 'https://a.test/1', site: '源A', sourceId: 'a', sourceName: '源A', sourceOrder: 0 },
    ];
    assert.deepEqual(mergeSourceResults(items).map(item => item.title), ['甲书', '乙书']);
    assert.deepEqual(mergeSourceResults(items, 'arrival').map(item => item.title), ['乙书', '甲书']);
    assert.deepEqual(mergeSourceResults(items, 'title').map(item => item.title), ['甲书', '乙书']);
    assert.equal(normalizeOnlineSettings({}).sourceSort, 'source');
    assert.equal(normalizeOnlineSettings({ sourceSort: '乱填' }).sourceSort, 'source');
    assert.equal(normalizeOnlineSettings({ sourceSort: 'title' }).sourceSort, 'title');
});

await test('searchAllSources 排序按书源顺序，不受返回快慢影响', async () => {
    const sources = [
        normalizeSource({ ...SOURCE_FIXTURE, name: '慢源', url: 'https://slow.test' }),
        normalizeSource({ ...SOURCE_FIXTURE, name: '快源', url: 'https://fast.test' }),
    ];
    const htmlFor = name => `<html><body><div class="result"><h3><a href="/book/1/">${name}</a></h3>
<span class="author">作者</span><p class="intro">简介</p></div></body></html>`;
    let fastSawFirst = false;
    const fetcher = new NovelFetcher({
        settings: { channel: 'direct', searchEngine: 'source', concurrency: 2, sources },
        fetchImpl: async url => {
            const target = String(url);
            if (target.includes('slow.test')) {
                await new Promise(resolve => setTimeout(resolve, 40));
                return { ok: true, status: 200, text: async () => htmlFor('慢源书'), arrayBuffer: async () => new TextEncoder().encode(htmlFor('慢源书')).buffer };
            }
            fastSawFirst = true;
            return { ok: true, status: 200, text: async () => htmlFor('快源书'), arrayBuffer: async () => new TextEncoder().encode(htmlFor('快源书')).buffer };
        },
    });
    const { results } = await fetcher.searchAllSources('书名');
    assert.equal(fastSawFirst, true, '快源先返回');
    // 但结果仍按书源顺序：慢源（第 1 个书源）在前
    assert.deepEqual(results.map(item => item.title), ['慢源书', '快源书']);
    const arrival = await new NovelFetcher({
        settings: { channel: 'direct', searchEngine: 'source', concurrency: 2, sources, sourceSort: 'arrival' },
        fetchImpl: async url => {
            const target = String(url);
            if (target.includes('slow.test')) {
                await new Promise(resolve => setTimeout(resolve, 40));
                return { ok: true, status: 200, text: async () => htmlFor('慢源书'), arrayBuffer: async () => new TextEncoder().encode(htmlFor('慢源书')).buffer };
            }
            return { ok: true, status: 200, text: async () => htmlFor('快源书'), arrayBuffer: async () => new TextEncoder().encode(htmlFor('快源书')).buffer };
        },
    }).searchAllSources('书名');
    assert.deepEqual(arrival.results.map(item => item.title), ['快源书', '慢源书']);
});

await test('searchAllSources 没有启用书源时直接报错', async () => {
    const fetcher = new NovelFetcher({
        settings: { channel: 'direct', searchEngine: 'source', sources: [{ ...normalizeSource(SOURCE_FIXTURE), enabled: false }] },
        fetchImpl: async () => ({ ok: true, status: 200, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) }),
    });
    await assert.rejects(() => fetcher.searchAllSources('雾港'), /启用的书源/);
});


/* ------------------------------------------------------------------ */
/* 番茄小说（本地下载器）                                               */
/* ------------------------------------------------------------------ */

const FANQIE_TXT_FIXTURE = `书名：测试之书
作者：测试作者
book_id=7000000000000000001
状态：连载
评分：8.5
字数：123456
章节：2
分类：玄幻
标签：玄幻|系统
在读：1.2万人在读

简介：
这是简介里的第一句。
这是简介里的第二句。

第1章 开始
第一段正文。
第二段正文。

第2章 继续
第二章正文。
`;

await test('parseFanqieBookText 按下载器 txt 的头部与章节切分', () => {
    const parsed = parseFanqieBookText(FANQIE_TXT_FIXTURE);
    assert.equal(parsed.title, '测试之书');
    assert.equal(parsed.author, '测试作者');
    assert.equal(parsed.bookId, '7000000000000000001');
    assert.match(parsed.intro, /这是简介里的第一句/);
    assert.equal(parsed.chapters.length, 2);
    assert.equal(parsed.chapters[0].title, '第1章 开始');
    assert.equal(parsed.chapters[1].title, '第2章 继续');
    assert.ok(!parsed.chapters[0].content.includes('书名：'));
    assert.ok(parsed.chapters[0].content.includes('第二段正文。'));
    assert.ok(!parsed.chapters[0].content.includes('第二章正文。'));
});

await test('parseFanqieBookText 没有章节标题时整本当一章', () => {
    const parsed = parseFanqieBookText('书名：无章节\n\n只有一段正文。');
    assert.equal(parsed.chapters.length, 1);
    assert.equal(parsed.chapters[0].content, '只有一段正文。');
});

await test('番茄书目地址与识别', () => {
    assert.equal(fanqieBookUrl('7510094191217609753'), 'fanqie://7510094191217609753');
    assert.equal(fanqieBookIdFromUrl('fanqie://7510094191217609753'), '7510094191217609753');
    assert.equal(fanqieBookIdFromUrl('https://fanqienovel.com/page/7510094191217609753'), '7510094191217609753');
    assert.equal(fanqieBookIdFromUrl('https://changdunovel.com/wap/share-v2.html?bookId=7510094191217609753'), '7510094191217609753');
    assert.equal(fanqieBookIdFromUrl('https://example.com/book/7510094191217609753'), '');
    assert.equal(isFanqieUrl('fanqie://7510094191217609753'), true);
    assert.equal(isFanqieUrl('https://example.com/book/1'), false);
    assert.equal(isFanqieBook({ source: 'fanqie', url: 'fanqie://1' }), true);
    assert.equal(isFanqieBook({ source: 'web', url: 'https://example.com' }), false);
});

await test('normalizeFanqieBridge 补斜杠去尾斜杠', () => {
    assert.equal(normalizeFanqieBridge(''), '/api/plugins/fanqie-bridge');
    assert.equal(normalizeFanqieBridge('api/plugins/fanqie-bridge/'), '/api/plugins/fanqie-bridge');
    assert.equal(normalizeFanqieBridge('http://127.0.0.1:18423/'), 'http://127.0.0.1:18423');
});

await test('formatFanqieNumber 与 fanqieBookSummary', () => {
    assert.equal(formatFanqieNumber(1598406), '159.8 万');
    assert.equal(formatFanqieNumber(9800), '9800');
    assert.equal(formatFanqieNumber(0), '');
    const summary = fanqieBookSummary({
        author: '某作者',
        chapterCount: 620,
        meta: { wordCount: 1598406, score: 9, readText: '1.2万人在读', finished: false, category: '玄幻' },
    });
    assert.match(summary, /作者：某作者/);
    assert.match(summary, /620 章/);
    assert.match(summary, /159\.8 万字/);
    assert.match(summary, /连载中/);
});

await test('mapFanqieSearchItems 映射并去重', () => {
    const results = mapFanqieSearchItems({
        items: [
            { book_id: '111111111111', title: '甲书', author: '作者甲', raw: { category: '玄幻', word_number: 123456, score: 9.1, read_cnt_text: '2万人在读' } },
            { book_id: '111111111111', title: '甲书重复', author: '作者甲', raw: {} },
            { book_id: '222222222222', title: '乙书', raw: { book_name: '乙书', author: '作者乙' } },
            { title: '没有 book_id', raw: {} },
        ],
    });
    assert.equal(results.length, 2);
    assert.equal(results[0].url, 'fanqie://111111111111');
    assert.equal(results[0].site, '番茄小说');
    assert.match(results[0].snippet, /作者：作者甲/);
    assert.match(results[0].snippet, /12\.3 万字/);
    assert.equal(results[1].author, '作者乙');
});

await test('mapFanqiePreview 生成只能整本下载的书目', () => {
    const book = mapFanqiePreview({
        book_id: '7510094191217609753',
        book_name: '开局暴露灵根',
        author: '飞鸢惊泛月',
        description: '简介'.repeat(400),
        chapter_count: 620,
        word_count: 1598406,
        score: 9,
        read_count_text: '1.2万人在读',
        finished: false,
        tags: ['玄幻', '穿越'],
        category: '玄幻脑洞',
    });
    assert.equal(book.source, 'fanqie');
    assert.equal(book.url, 'fanqie://7510094191217609753');
    assert.equal(book.chapters.length, 0);
    assert.equal(book.downloadOnly, true);
    assert.equal(book.chapterCount, 620);
    assert.deepEqual(book.meta.tags, ['玄幻', '穿越']);
    assert.ok(book.intro.length <= 600);
});

await test('summarizeFanqieJob 描述任务进度', () => {
    const running = summarizeFanqieJob({ state: 'running', progress: { saved_chapters: 12, chapter_total: 620 } });
    assert.equal(running.percent, 2);
    assert.match(running.label, /12 \/ 620/);
    const done = summarizeFanqieJob({ state: 'done', progress: { saved_chapters: 620, chapter_total: 620 } });
    assert.equal(done.finished, true);
    assert.equal(done.percent, 100);
    const failed = summarizeFanqieJob({ state: 'failed', message: '网络错误', progress: {} });
    assert.equal(failed.failed, true);
    assert.match(failed.label, /网络错误/);
});

await test('normalizeOnlineSettings 接受 fanqie 并补全桥接设置', () => {
    const settings = normalizeOnlineSettings({ searchEngine: 'fanqie' });
    assert.equal(settings.searchEngine, 'fanqie');
    assert.equal(settings.fanqieBridge, '/api/plugins/fanqie-bridge');
    assert.equal(settings.fanqieUpstream, '');
    const custom = normalizeOnlineSettings({ searchEngine: 'fanqie', fanqieBridge: 'api/x/', fanqieUpstream: ' http://127.0.0.1:19000 ' });
    assert.equal(custom.fanqieBridge, '/api/x');
    assert.equal(custom.fanqieUpstream, 'http://127.0.0.1:19000');
});

await test('NovelFetcher 搜番茄走桥接、不拼搜索引擎地址', async () => {
    const calls = [];
    const fetcher = new NovelFetcher({
        settings: { searchEngine: 'fanqie' },
        fetchImpl: async (url) => {
            const target = String(url);
            calls.push(target);
            if (target.includes('/health')) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({ ok: true, downloader: { reachable: true, version: 'mock' } }),
                    text: async () => '',
                };
            }
            return {
                ok: true,
                status: 200,
                json: async () => ({ items: [{ book_id: '333333333333', title: '丙书', author: '作者丙', raw: {} }] }),
                text: async () => '',
            };
        },
    });
    const results = await fetcher.searchBooks('丙书');
    // 先确保下载器可用（桥接会自动拉起），再搜索
    assert.equal(calls.length, 2);
    assert.equal(calls[0], '/api/plugins/fanqie-bridge/health?ensure=1&timeout=12000');
    assert.equal(calls[1], '/api/plugins/fanqie-bridge/search?q=%E4%B8%99%E4%B9%A6');
    assert.equal(results.length, 1);
    assert.equal(results[0].url, 'fanqie://333333333333');
    assert.deepEqual(await fetcher.searchBooks('丙书', { page: 2 }), []);
});

await test('ensureReady 在桥接说下载器没起来时把提示带出来', async () => {
    const client = new FanqieClient({
        base: '/api/plugins/fanqie-bridge',
        fetchImpl: async () => ({
            ok: false,
            status: 503,
            text: async () => JSON.stringify({ ok: false, error: '下载器没在跑，而且配置里关掉了自动启动（autostart=false）', code: 'DOWNLOADER_DOWN' }),
        }),
    });
    await assert.rejects(() => client.ensureReady(), /自动启动/);
});

await test('FanqieClient 遇到连不上桥接时把错误说清楚', async () => {
    const client = new FanqieClient({
        base: 'http://127.0.0.1:18423',
        fetchImpl: async () => {
            throw new TypeError('Failed to fetch');
        },
    });
    await assert.rejects(() => client.search('测试'), /桥接/);
});


/* ------------------------------------------------------------------ */
/* 书架：分组 / 排序 / 置顶 / 最近阅读                                  */
/* ------------------------------------------------------------------ */

const shelfNovels = () => ([
    { id: 'a', title: '乙书', author: '甲', chapterCount: 10, lastReadAt: 0, updatedAt: 100, createdAt: 100, groupId: 'g1' },
    { id: 'b', title: '甲书', author: '乙', chapterCount: 20, lastReadAt: 300, updatedAt: 200, createdAt: 200, groupId: 'g1' },
    { id: 'c', title: '丙书', author: '丙', chapterCount: 30, lastReadAt: 200, updatedAt: 300, createdAt: 300, groupId: 'g2' },
    { id: 'd', title: '丁书', author: '丁', chapterCount: 40, lastReadAt: 0, updatedAt: 400, createdAt: 400, groupId: '' },
    { id: 'e', title: '戊书', author: '戊', chapterCount: 50, lastReadAt: 0, updatedAt: 500, createdAt: 500, groupId: 'gone' },
]);

await test('书架排序：置顶永远在最前，其余按阅读时间倒序', () => {
    const novels = shelfNovels();
    novels[0].pinnedAt = 123;
    const sorted = sortShelfNovels(novels, 'readTime', true);
    assert.equal(sorted[0].id, 'a', '置顶的书排第一');
    assert.deepEqual(sorted.slice(1).map(novel => novel.id), ['b', 'c', 'd', 'e']);
});

await test('书架排序：正序 / 书名 / 更新时间', () => {
    const novels = shelfNovels();
    // 从来没读过的书 lastReadAt 是 0，正序时排在最前面，并列的保持原顺序
    assert.deepEqual(sortShelfNovels(novels, 'readTime', false).map(n => n.id), ['a', 'd', 'e', 'c', 'b']);
    assert.equal(normalizeShelfSort('what', 'title'), 'title');
    assert.deepEqual(
        sortShelfNovels(novels, 'title', false).map(n => n.title),
        ['丙书', '丁书', '甲书', '戊书', '乙书'],
        '书名列按中文拼音排',
    );
});

await test('书架分组：计数把已删分组的书算成未分组', () => {
    const novels = shelfNovels();
    const groups = [{ id: 'g1', name: '玄幻' }, { id: 'g2', name: '都市' }];
    const counts = countByGroup(novels, groups);
    assert.equal(counts.all, 5);
    assert.equal(counts.groups.get('g1'), 2);
    assert.equal(counts.groups.get('g2'), 1);
    assert.equal(counts.ungrouped, 2, '空分组 + 分组已被删的书');
});

await test('书架筛选：全部 / 未分组 / 指定分组 / 关键字', () => {
    const novels = shelfNovels();
    const groups = [{ id: 'g1', name: '玄幻' }, { id: 'g2', name: '都市' }];
    const all = buildShelfView(novels, { groups, groupId: '', keyword: '', sort: 'readTime', desc: true });
    assert.equal(all.shown, 5);
    const ungrouped = buildShelfView(novels, { groups, groupId: '__ungrouped__', sort: 'readTime', desc: true });
    assert.deepEqual(ungrouped.items.map(n => n.id).sort(), ['d', 'e']);
    const g1 = buildShelfView(novels, { groups, groupId: 'g1', sort: 'readTime', desc: true });
    assert.deepEqual(g1.items.map(n => n.id), ['b', 'a']);
    const keyword = buildShelfView(novels, { groups, groupId: '', keyword: '甲', sort: 'title', desc: true });
    assert.deepEqual(keyword.items.map(n => n.id).sort(), ['a', 'b']);
});

await test('书架：最近阅读挑出读得最晚的那本', () => {
    const view = buildShelfView(shelfNovels(), { groups: [], sort: 'readTime', desc: true });
    assert.equal(view.resume?.id, 'b');
    view.resume = null;
    assert.equal(buildShelfView(shelfNovels().map(n => ({ ...n, lastReadAt: 0 })), { groups: [] }).resume, null);
});

await test('书架：手动排序工具函数', () => {
    const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    assert.deepEqual(moveInList(list, 'b', -1), ['b', 'a', 'c']);
    assert.deepEqual(moveInList(list, 'a', -1), null, '已经在最前面就不动');
    const map = orderMapFromIds(['c', 'a', 'b']);
    assert.equal(map.get('c'), 1);
    assert.equal(map.get('b'), 3);
    const groups = [{ id: 'x', name: '乙', order: 2 }, { id: 'y', name: '甲', order: 1 }];
    assert.deepEqual(sortShelfGroups(groups).map(g => g.id), ['y', 'x']);
    assert.equal(nextGroupOrder(groups), 3);
});

await test('书架：相对时间与未读标记', () => {
    const now = Date.UTC(2026, 9, 31, 8, 0, 0);
    assert.equal(relativeTime(0, now), '未读');
    assert.equal(relativeTime(now - 30 * 1000, now), '刚刚');
    assert.equal(relativeTime(now - 5 * 60 * 1000, now), '5 分钟前');
    assert.equal(relativeTime(now - 3 * 3600 * 1000, now), '3 小时前');
    assert.equal(relativeTime(now - 26 * 3600 * 1000, now), '昨天');
    assert.equal(relativeTime(now - 10 * 24 * 3600 * 1000, now), '10 天前');
});

console.log(`\n全部通过：${passed} 项`);
