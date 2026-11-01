/**
 * 小说阅读器 - 设置管理
 * 设置保存在 SillyTavern 的 extension_settings.novelReader 中，随 ST 设置一起持久化。
 */

import { normalizeReplaceRules } from './replace.js';

export const SETTINGS_KEY = 'novelReader';

export const STYLE_PRESETS = {
    plot: {
        label: '剧情梗概',
        directive: '以剧情主线为核心，按时间顺序概括起因、发展、转折、高潮与结局，突出关键人物、因果关系和重要伏笔，略去无关的景物与日常描写。',
    },
    detailed: {
        label: '详细梳理',
        directive: '在主线之外保留重要支线、人物动机、关键冲突与伏笔，按情节推进顺序叙述，信息密度要高，但不要逐句复述原文。',
    },
    characters: {
        label: '人物与关系',
        directive: '以人物为中心，梳理主要人物的身份、目标、动机、关系变化与成长弧线；剧情只作为支撑人物变化的证据。',
    },
    analysis: {
        label: '文学分析',
        directive: '在概括剧情的基础上，分析作品的主题、结构、叙事视角、语言风格与象征意象；所有观点都必须有文本依据，不要空泛发挥。',
    },
    custom: {
        label: '自定义',
        directive: '',
    },
};

export const SUMMARY_MODE_PRESETS = {
    fast: {
        label: '极速（并行 + 事件账本）',
        description: '多段并行请求，分段只记事件账本；速度最快、token 最省，细节略少。',
        concurrency: 4,
        ledger: true,
        continuity: false,
        minMidChars: 80,
        packRatio: 0.96,
        previousChars: 0,
    },
    balanced: {
        label: '均衡（并行 + 简短摘要）',
        description: '默认。并行 2 路，分段写短摘要，速度与连贯性折中。',
        concurrency: 2,
        ledger: false,
        continuity: false,
        minMidChars: 120,
        packRatio: 0.94,
        previousChars: 0,
    },
    quality: {
        label: '质量（串行 + 完整摘要）',
        description: '逐段串行、带完整前情，最连贯但最慢、token 消耗最高。',
        concurrency: 1,
        ledger: false,
        continuity: true,
        minMidChars: 180,
        packRatio: 0.9,
        previousChars: 260,
    },
};

/**
 * 网络找书：抓取通道（怎么把 HTML 取回来）
 * 只剩三条。「浏览器直连」删掉了：普通小说站不允许跨域，单选它必然失败；
 * 它仍作为「自动」链的最后一档兜底（酒馆网页通道被策略拒绝时才会用到），见 network.js 的 channelOrder()。
 */
export const ONLINE_CHANNEL_OPTIONS = [
    { value: 'auto', label: '自动（酒馆通道 → 代理 → 直连兜底）' },
    { value: 'tavern', label: '酒馆网页通道（不用管跨域）' },
    { value: 'proxy', label: '自定义 CORS 代理' },
];

/** 网络找书：搜索通道（书源 / 番茄；后者是可选的） */
export const SEARCH_ENGINE_OPTIONS = [
    { value: 'source', label: '书源（导入的站点规则）' },
    { value: 'fanqie', label: '番茄小说（可选）' },
];

/** 网络找书的默认设置；实际值存在 extension_settings.novelReader.online */
export const DEFAULT_ONLINE_SETTINGS = {
    /** auto / tavern / direct / proxy */
    channel: 'auto',
    /** 自定义 CORS 代理模板，支持 {url} 或 {raw} 占位；留空表示不用 */
    proxyTemplate: '',
    /** source / fanqie（网页搜索那条通道已经删掉） */
    searchEngine: 'source',
    /** 搜索结果每页显示几条 */
    pageSize: 5,
    /** 精准搜索：只看书名（去掉括号 / 标点后）和关键词完全一致的 */
    exactMatch: false,
    /** 下载 / 批量抓取 / 多书源搜索的并发数 */
    concurrency: 4,
    /** 单次抓取超时（毫秒）；书源多、站点慢时可调小 */
    timeoutMs: 15000,
    /** 下载章节上限，0 = 不限 */
    downloadLimit: 0,
    /** 是否遵守书源自己声明的 concurrentRate（默认不遵守，否则「并发抓取」会被压到 1 秒 1 章） */
    respectRateLimit: false,
    /** 单章抓取看门狗（毫秒）：超时就当失败，避免整本卡在某一章 */
    chapterTimeoutMs: 20000,
    /** 导入的书源（结构见 js/source.js）；搜索会打所有启用的源 */
    sources: [],
    /** 书源搜索结果的排序：source（按书源顺序，默认）/ title（按书名）/ arrival（按到达顺序） */
    sourceSort: 'source',
    /** 番茄小说：同源桥接路由（服务端插件 plugins/fanqie-bridge） */
    fanqieBridge: '/api/plugins/fanqie-bridge',
    /** 番茄小说：下载器地址，留空由桥接用默认 http://127.0.0.1:18423 */
    fanqieUpstream: '',
};

export const DEFAULT_SETTINGS = {
    /** 总结字数上限（字符数） */
    targetChars: 800,
    /** 0 表示自动跟随酒馆上下文设置 */
    contextTokens: 0,
    /** 上下文占用比例：0.7 表示最多使用上下文窗口的 70% */
    contextRatio: 0.7,
    /** 为模型输出预留的 token 数 */
    outputReserve: 1024,
    /** 中间摘要的最小字数；0 = 跟随总结模式 */
    minMidChars: 0,
    /** 单次请求失败后的总尝试次数 */
    maxAttempts: 3,
    /** 总结模式：fast / balanced / quality */
    summaryMode: 'balanced',
    /** 分段并发数；0 表示跟随总结模式 */
    mapConcurrency: 0,
    /** 复用上次已成功的分段摘要，失败或中断后只补缺失部分 */
    reuseParts: true,
    /** current = 当前连接；profile = 连接管理中的配置 */
    provider: 'current',
    profileId: '',
    /** 总结风格 */
    style: 'plot',
    /** 自定义风格要求 */
    customStyle: '',
    /** 附加要求（对所有风格生效） */
    extraInstruction: '',
    /** 最终结果超过上限时自动压缩/截断校准 */
    autoCalibrate: true,
    /** 自动保存总结历史 */
    keepSummaries: true,
    /** 世界书提取分类开关 */
    worldbookCategories: {
        character: true,
        location: true,
        organization: true,
        race: false,
        item: false,
        skill: false,
        event: false,
        concept: false,
        relation: false,
        timeline: false,
        clue: false,
    },
    /** 世界书每块原文字符数 */
    worldbookChunkChars: 9000,
    /** 世界书分段并发数 */
    worldbookConcurrency: 2,
    /** 世界书单条内容字数上限 */
    worldbookEntryChars: 600,
    /** 剧情按章节区间合并成几条（1～12） */
    worldbookPlotEntries: 4,
    /** 世界书附加提取要求 */
    worldbookExtraInstruction: '',
    /** 自定义 AI 整理提示词；空 = 使用内置默认模板 */
    worldbookOrganizePrompt: '',
    /** 角色卡内嵌世界书时自动导入并绑定到角色 */
    autoImportLorebook: true,
    /** 「导入到酒馆」时一并导入角色卡（预设不再由插件生成） */
    importCard: true,
    /** 上次保存的世界书名 */
    worldbookName: '',
    /** 阅读字号 */
    fontSize: 17,
    /** 阅读主题：auto / paper / sepia / green / dark */
    readerTheme: 'auto',
    /** 阅读字体：system / serif / sans / kai */
    readerFont: 'system',
    /** 正文行高 */
    readerLineHeight: 2,
    /** 段落间距（em） */
    readerParaGap: 0.9,
    /** 版心最大宽度（px） */
    readerWidth: 820,
    /** 首行缩进（em），0 = 不缩进 */
    readerIndent: 2,
    /** 正文对齐：justify / left */
    readerAlign: 'justify',
    /** 字间距（em） */
    readerLetterSpacing: 0.01,
    /** 每页字数，用于本地分页 */
    readerPageChars: 4600,
    /** 翻页动画：none / fade / slide / cover / flip */
    pageTurn: 'slide',
    /** 章节列表顺序：asc = 正序，desc = 倒序 */
    chapterOrder: 'asc',
    /** 替换净化规则（正文 / 标题） */
    replaceRules: [],
    /** 朗读语速（Web Speech） */
    ttsRate: 1,
    /** 书架显示方式：list = 列表，grid = 书封网格 */
    libraryView: 'grid',
    /** 书架当前分组：'' = 全部，'__ungrouped__' = 未分组，其它是分组 id */
    shelfGroup: '',
    /** 书架排序：readTime / updateTime / title / manual */
    shelfSort: 'readTime',
    /** 书架排序方向：true = 倒序（最近读的在前） */
    shelfSortDesc: true,
    /** 滚动书架时自动收起顶部工具条 */
    shelfAutoHideBar: true,
    /** 封面上显示书名 / 作者（对应「阅读」的封面设置） */
    shelfCoverTitle: true,
    shelfCoverAuthor: true,
    /** 总是使用本地生成的封面，不加载网络封面 */
    shelfDefaultCover: false,
    /** 上次所在标签 */
    lastTab: 'library',
    /** 上次打开的小说 */
    lastNovelId: '',
    /** 每本小说的阅读进度 { [novelId]: { chapterIndex, page } } */
    progress: {},
    /** 悬浮球位置 { left, top } 或 null */
    orbPosition: null,
    /** 网络找书：搜索与抓取通道 */
    online: { ...DEFAULT_ONLINE_SETTINGS },
    /** 找书页最近一次搜索关键词 */
    onlineQuery: '',
    /** 搜索历史 [{ keyword, time }]，最多 30 条 */
    onlineHistory: [],
};

function cloneDefaults() {
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
}

/** 取得设置对象（必要时补全缺失字段） */
export function getSettings() {
    const context = globalThis.SillyTavern?.getContext?.();
    if (!context) throw new Error('无法获取 SillyTavern 上下文');
    const store = context.extensionSettings;
    if (!store[SETTINGS_KEY] || typeof store[SETTINGS_KEY] !== 'object') {
        store[SETTINGS_KEY] = {};
    }
    const settings = store[SETTINGS_KEY];
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (!(key in settings) || settings[key] === undefined) {
            settings[key] = value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value;
        }
    }
    if (!settings.progress || typeof settings.progress !== 'object') settings.progress = {};
    settings.replaceRules = normalizeReplaceRules(settings.replaceRules);
    if (!Array.isArray(settings.onlineHistory)) settings.onlineHistory = [];
    settings.onlineHistory = settings.onlineHistory
        .filter(item => item && typeof item.keyword === 'string' && item.keyword.trim())
        .slice(0, 30);
    if (settings.chapterOrder !== 'desc') settings.chapterOrder = 'asc';
    settings.ttsRate = Math.min(2, Math.max(0.5, Number(settings.ttsRate) || 1));
    // 网络找书的设置是嵌套对象，旧版本没有这一块，这里逐项补全
    if (!settings.online || typeof settings.online !== 'object') {
        settings.online = { ...DEFAULT_ONLINE_SETTINGS };
    } else {
        for (const [key, value] of Object.entries(DEFAULT_ONLINE_SETTINGS)) {
            if (!(key in settings.online) || settings.online[key] === undefined) {
                settings.online[key] = value;
            }
        }
    }
    // v1.11 起不再生成预设：旧的「一并导入角色卡与预设」迁移成「一并导入角色卡」
    if ('importCardAndPreset' in settings) {
        settings.importCard = settings.importCardAndPreset !== false;
        delete settings.importCardAndPreset;
    }
    return settings;
}

/** 保存设置（防抖由 ST 负责） */
export function saveSettings() {
    try {
        globalThis.SillyTavern?.getContext?.().saveSettingsDebounced?.();
    } catch (error) {
        console.warn('[小说阅读器] 保存设置失败', error);
    }
}

/** 恢复默认设置（保留阅读进度与悬浮球位置） */
export function resetSettings() {
    const context = globalThis.SillyTavern?.getContext?.();
    if (!context) return;
    const current = getSettings();
    const keep = {
        progress: current.progress,
        orbPosition: current.orbPosition,
        lastNovelId: current.lastNovelId,
        lastTab: current.lastTab,
    };
    context.extensionSettings[SETTINGS_KEY] = { ...cloneDefaults(), ...keep };
    saveSettings();
}

/** 取出当前总结模式对应的策略参数 */
export function resolveStrategy(settings = getSettings()) {
    const preset = SUMMARY_MODE_PRESETS[settings.summaryMode] || SUMMARY_MODE_PRESETS.balanced;
    const explicit = Number(settings.mapConcurrency) || 0;
    return {
        ...preset,
        mode: settings.summaryMode in SUMMARY_MODE_PRESETS ? settings.summaryMode : 'balanced',
        concurrency: Math.min(6, Math.max(1, explicit || preset.concurrency)),
        minMidChars: Number(settings.minMidChars) > 0 ? Number(settings.minMidChars) : preset.minMidChars,
    };
}

/** 当前酒馆上下文窗口 */
export function getContextTokens() {
    const context = globalThis.SillyTavern?.getContext?.();
    const maxContext = Number(context?.maxContext) || 4096;
    return maxContext;
}

/**
 * 计算本次总结的 token 预算。
 * totalBudget = 上下文 * 占用比例
 * inputBudget = totalBudget - 输出预留
 */
export function computeBudget(settings = getSettings()) {
    const ctxTokens = Number(settings.contextTokens) > 0
        ? Number(settings.contextTokens)
        : getContextTokens();
    const ratio = Math.min(0.92, Math.max(0.3, Number(settings.contextRatio) || 0.7));
    const totalBudget = Math.max(768, Math.floor(ctxTokens * ratio));
    const reserve = Math.min(
        Math.max(128, Number(settings.outputReserve) || 1024),
        Math.max(256, Math.floor(totalBudget * 0.6)),
    );
    const inputBudget = Math.max(384, totalBudget - reserve);
    return { ctxTokens, ratio, totalBudget, reserve, inputBudget };
}

/** 单次输出上限（字符）——受上下文窗口约束，避免用户填 20000 字但模型根本写不出 */
export function maxTargetChars(settings = getSettings()) {
    const { ctxTokens } = computeBudget(settings);
    // 经验：中文输出约 1.4~1.6 token/字，给最终回答留一半上下文
    return Math.max(200, Math.floor((ctxTokens * 0.5) / 1.5));
}
