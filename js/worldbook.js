/**
 * 小说阅读器 - 世界书生成
 *
 * 把已导入的小说（TXT / Markdown / HTML / EPUB / DOCX 都走同一套章节数据）
 * 按上下文预算切块，让模型提取角色、地点、组织、道具、剧情等条目，
 * 再合并重复项并转换为 SillyTavern 世界书格式。
 */

import {
    clamp,
    countChars,
    createAbortError,
    estimateTokens,
    isAbortError,
    trimToLimit,
} from './util.js';
import { chunkText } from './parse.js';
import { computeBudget, getSettings } from './settings.js';
import { callWithRetry } from './summary.js';
import { entryNameKey, mergeHeadingSections, normalizeContent, normalizeEntryName, organizeEntryContent } from './organize.js';

const PROMPT_VERSION = 'worldbook-v4';
const PROMPT_OVERHEAD_TOKENS = 700;

/** 合并类条目的字数上限：设定只留一条、剧情按章节区间合并，都要比普通条目宽 */
export const MERGED_ENTRY_CHARS = 3000;
export const MERGED_KEYWORD_LIMIT = 24;

/** 设定条目的固定名字 */
export const CONCEPT_ENTRY_NAME = '世界观设定';
/** 剧情条目的名字前缀 */
const PLOT_ENTRY_PREFIX = '剧情·';

/**
 * 提取分类。order 决定世界书里的条目顺序，也就是折叠分组的先后。
 * single: true 的分类不按小条目输出，而是整本书合并成一条长条目。
 * 小说改写成角色扮演时，除了角色 / 地点 / 组织，最缺的是「怎么称呼人」「能做什么」
 * 「事情发生的先后」和「埋了什么没填」，所以额外准备了关系、能力、时间线、伏笔几类。
 */
export const WORLDBOOK_CATEGORIES = [
    {
        key: 'character',
        label: '角色',
        order: 100,
        enabled: true,
        guide: '姓名、别名、性别/年龄、身份、外貌、性格、能力、目标、人物关系、关键经历。',
        fields: '## 身份\\n...\\n## 外貌与性格\\n...\\n## 能力\\n...\\n## 关系\\n...\\n## 经历\\n...',
    },
    {
        key: 'location',
        label: '地点',
        order: 200,
        enabled: true,
        guide: '名称、别名、位置、环境特征、势力归属、发生过的重要事件。',
        fields: '## 概况\\n...\\n## 位置与环境\\n...\\n## 关联事件\\n...',
    },
    {
        key: 'organization',
        label: '组织',
        order: 300,
        enabled: true,
        guide: '名称、别名、性质、目标、成员、势力范围、与其他势力的关系。门派、家族、国家、帮会都算组织。',
        fields: '## 性质\\n...\\n## 目标\\n...\\n## 成员与势力\\n...\\n## 关系\\n...',
    },
    {
        key: 'race',
        label: '种族',
        order: 350,
        enabled: false,
        guide: '名称、别名、外貌与寿命、天赋能力、社会结构与习俗、与其他种族的关系。',
        fields: '## 特征\\n...\\n## 天赋与能力\\n...\\n## 社会与习俗\\n...\\n## 关系\\n...',
    },
    {
        key: 'item',
        label: '道具',
        order: 400,
        enabled: false,
        guide: '名称、别名、外观、能力/用途、来历、持有者、相关事件。法宝、兵器、信物、药物都算道具。',
        fields: '## 外观\\n...\\n## 能力与用途\\n...\\n## 来历\\n...',
    },
    {
        key: 'skill',
        label: '能力',
        order: 450,
        enabled: false,
        guide: '名称、别名、类型（功法/法术/异能/武技/天赋）、效果与代价、修行阶段、掌握者、首次出现的场合。',
        fields: '## 效果\\n...\\n## 代价与限制\\n...\\n## 掌握者\\n...\\n## 来历\\n...',
    },
    {
        key: 'event',
        label: '剧情',
        order: 500,
        enabled: false,
        single: true,
        singleName: '本段剧情',
        guide: '按时间顺序记录本段发生的关键事件：谁做了什么、结果如何、留下什么伏笔；写成一段连贯的剧情纪要，覆盖本段全部章节，不要拆成多个小条目。',
        fields: '## 剧情纪要\n...',
    },
    {
        key: 'concept',
        label: '设定',
        order: 600,
        enabled: false,
        single: true,
        singleName: '世界观设定',
        guide: '把本段的世界观规则、力量体系、历史与地理、习俗禁忌、专有名词合并成一条完整设定，不要拆成多个小条目。',
        fields: '## 世界观\n...\n## 力量体系\n...\n## 历史与地理\n...\n## 习俗与禁忌\n...',
    },
    {
        key: 'relation',
        label: '关系',
        order: 700,
        enabled: false,
        single: true,
        singleName: '人物关系',
        guide: '把本段人物之间的关系、相互称呼（师徒/主仆/尊称/昵称/自称）与态度变化合并成一条关系网，不要拆成多个小条目。',
        fields: '## 关系网\n...\n## 称谓与称呼\n...\n## 态度变化\n...',
    },
    {
        key: 'timeline',
        label: '时间线',
        order: 800,
        enabled: false,
        single: true,
        singleName: '时间线',
        guide: '按时间顺序记录本段的年代、季节、人物年龄与关键节点，写成一条连贯的大事记，不要拆成多个小条目。',
        fields: '## 大事记\n...\n## 时间设定\n...',
    },
    {
        key: 'clue',
        label: '伏笔',
        order: 900,
        enabled: false,
        single: true,
        singleName: '伏笔与悬念',
        guide: '整理本段埋下或推进的伏笔、悬念、承诺与未解之谜：谁提到、指向什么、目前是什么状态，合成一条。',
        fields: '## 伏笔\n...\n## 悬念\n...',
    },
];

/** 这些分类不再按小条目输出，而是合并成长条目（剧情有额外的按章节区间分条逻辑） */
export const MERGED_CATEGORY_KEYS = WORLDBOOK_CATEGORIES.filter(category => category.single).map(category => category.key);

const CATEGORY_BY_KEY = new Map(WORLDBOOK_CATEGORIES.map(category => [category.key, category]));
const CATEGORY_BY_LABEL = new Map(WORLDBOOK_CATEGORIES.flatMap(category => [
    [category.label, category],
    [category.key, category],
    [category.key.toLowerCase(), category],
]));

function hashText(text) {
    let hash = 5381;
    const source = String(text || '');
    for (let i = 0; i < source.length; i++) {
        hash = ((hash << 5) + hash + source.charCodeAt(i)) | 0;
    }
    return `${source.length}:${(hash >>> 0).toString(36)}`;
}

export function enabledCategories(settings = getSettings()) {
    const flags = settings.worldbookCategories && typeof settings.worldbookCategories === 'object'
        ? settings.worldbookCategories
        : {};
    return WORLDBOOK_CATEGORIES.filter(category => flags[category.key] !== false && (flags[category.key] === true || category.enabled));
}

export function normalizeCategories(flags = {}) {
    const result = {};
    for (const category of WORLDBOOK_CATEGORIES) {
        result[category.key] = flags[category.key] === true;
    }
    return result;
}

function categoryInfo(value) {
    if (!value) return null;
    const raw = String(value).trim();
    if (CATEGORY_BY_KEY.has(raw)) return CATEGORY_BY_KEY.get(raw);
    if (CATEGORY_BY_LABEL.has(raw)) return CATEGORY_BY_LABEL.get(raw);
    if (CATEGORY_BY_LABEL.has(raw.toLowerCase())) return CATEGORY_BY_LABEL.get(raw.toLowerCase());
    return null;
}

/* ------------------------------------------------------------------ */
/* 提示词                                                              */
/* ------------------------------------------------------------------ */

function buildWorldbookSystemPrompt() {
    return [
        '你是一位资深的中文小说设定编辑，负责把小说正文整理成可供角色扮演检索的世界书条目。',
        '只依据给定原文提取信息，不编造原文没有的人物、地点、组织或设定。',
        '只输出严格 JSON，不要输出解释、前言、Markdown 代码块或 JSON 以外的任何文字。',
        '所有字符串必须使用双引号；内容里的换行写成 \\n，不要输出未转义的控制字符。',
    ].join('\n');
}

function buildJsonTemplate(categories) {
    const template = {};
    for (const category of categories) {
        const entryName = category.single ? category.singleName : '示例条目名';
        template[category.label] = {
            [entryName]: {
                关键词: ['条目名', '别名'],
                内容: category.fields.replace(/\\n/g, '\n'),
            },
        };
    }
    return JSON.stringify(template, null, 2);
}

function buildWorldbookPrompt({ novelTitle, chunk, categories, extraInstruction = '', maxEntries = 4, entryGuide = 400, singleGuide = 0 }) {
    const guides = categories
        .map(category => (category.single
            ? `- ${category.label}：只输出 1 个条目，键名固定为「${category.singleName}」。${category.guide}`
            : `- ${category.label}：${category.guide}`))
        .join('\n');
    const singles = categories.filter(category => category.single);
    const hasMany = categories.some(category => !category.single);
    const rules = [
        '只输出 JSON，不要代码块，不要“好的”“以下是”等前言。',
        '只提取本段原文中实际出现或明确提到的内容；没有把握的不要写。',
        hasMany ? `每个分类最多 ${maxEntries} 个主要条目，优先保留推动剧情、反复出现或与主角关系密切的。` : '',
        '“关键词”放 1～6 个能触发该条目的称呼、别名、称号或关键物件；条目名本身也要放进去。',
        hasMany ? `“内容”用简洁的 Markdown 小标题组织，只写事实，不写文学评价；每条控制在 ${entryGuide} 字以内。` : '',
        '同一人物/地点在本段有多个称呼时合并成一个条目，把别名放进关键词。',
        singles.length
            ? `以下分类只能有一个条目，键名必须完全一致：${singles.map(category => `「${category.label}」→「${category.singleName}」`).join('；')}。内容要连贯完整地覆盖本段，不要再拆成小条目${singleGuide ? `，单条可以写到 ${singleGuide} 字以内` : ''}。`
            : '',
        '如果某个分类本段没有内容，输出空对象 {}，不要省略分类键。',
        extraInstruction ? `用户附加要求：${extraInstruction}` : '',
    ].filter(Boolean).map((rule, index) => `${index + 1}. ${rule}`);

    return [
        `【作品】《${novelTitle}》`,
        `【本段位置】${chunk.label}`,
        '',
        '【提取分类与重点】',
        guides,
        '',
        '【输出格式】',
        '一个 JSON 对象，顶层键必须是下面列出的分类名；分类下以“条目名”为键：',
        buildJsonTemplate(categories),
        '',
        '【硬性要求】',
        ...rules,
        '',
        '【原文】',
        chunk.text,
    ].join('\n');
}

/* ------------------------------------------------------------------ */
/* 响应解析                                                            */
/* ------------------------------------------------------------------ */

function stripModelNoise(text) {
    let output = String(text ?? '').trim();
    output = output.replace(/^[\s\S]*?<\/think>/i, '');
    output = output.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
    const fenced = output.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
    if (fenced) output = fenced[1];
    return output.trim();
}

function repairUnescapedQuotes(json) {
    let result = '';
    let inString = false;
    let i = 0;
    while (i < json.length) {
        const char = json[i];
        if (inString && char === '\\') {
            result += char;
            if (i + 1 < json.length) result += json[i + 1];
            i += 2;
            continue;
        }
        if (char !== '"') {
            result += char;
            i++;
            continue;
        }
        if (!inString) {
            inString = true;
            result += char;
            i++;
            continue;
        }
        let j = i + 1;
        while (j < json.length && /[\s\r\n]/.test(json[j])) j++;
        const next = json[j];
        if (next === ':' || next === ',' || next === '}' || next === ']' || next === undefined) {
            inString = false;
            result += char;
        } else {
            result += '\\"';
        }
        i++;
    }
    return result;
}

function missingClosers(text) {
    const stack = [];
    let inString = false;
    let escaped = false;
    for (const char of text) {
        if (inString) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') inString = false;
            continue;
        }
        if (char === '"') inString = true;
        else if (char === '{') stack.push('}');
        else if (char === '[') stack.push(']');
        else if ((char === '}' || char === ']') && stack[stack.length - 1] === char) stack.pop();
    }
    return stack.reverse().join('');
}

function normalizeJsonLike(text) {
    return String(text || '')
        .replace(/^\uFEFF/, '')
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, "'")
        .replace(/,\s*([}\]])/g, '$1')
        .trim();
}

function jsonCandidates(text) {
    const cleaned = normalizeJsonLike(stripModelNoise(text));
    const firstObject = cleaned.indexOf('{');
    const firstArray = cleaned.indexOf('[');
    let first = -1;
    if (firstObject !== -1 && firstArray !== -1) first = Math.min(firstObject, firstArray);
    else first = Math.max(firstObject, firstArray);
    const lastObject = cleaned.lastIndexOf('}');
    const lastArray = cleaned.lastIndexOf(']');
    const last = Math.max(lastObject, lastArray);
    const base = first !== -1 && last > first ? cleaned.slice(first, last + 1) : cleaned;
    const closers = missingClosers(base);
    return [
        base,
        repairUnescapedQuotes(base),
        base + closers,
        repairUnescapedQuotes(base + closers),
    ].filter(Boolean);
}

function parseJsonLenient(text) {
    let lastError = null;
    for (const candidate of jsonCandidates(text)) {
        try {
            return JSON.parse(candidate);
        } catch (error) {
            lastError = error;
        }
    }
    throw new Error(`模型没有返回可解析的世界书 JSON：${lastError?.message || '格式错误'}`);
}

/** 从损坏的 JSON 文本里按分类/条目结构兜底提取 */
function extractWorldbookByRegex(text, categories) {
    const source = normalizeJsonLike(stripModelNoise(text));
    const result = {};
    for (const category of categories) {
        const categoryPattern = new RegExp(`"${category.label}"\\s*:\\s*\\{`, 'g');
        const categoryMatch = categoryPattern.exec(source);
        if (!categoryMatch) continue;
        const start = categoryMatch.index + categoryMatch[0].length;
        let depth = 1;
        let end = start;
        while (depth > 0 && end < source.length) {
            if (source[end] === '{') depth++;
            if (source[end] === '}') depth--;
            end++;
        }
        if (depth !== 0) continue;
        const body = source.slice(start, end - 1);
        const entries = {};
        const entryPattern = /"([^"\\]{1,80})"\s*:\s*\{/g;
        let entryMatch;
        while ((entryMatch = entryPattern.exec(body)) !== null) {
            const name = entryMatch[1].trim();
            const entryStart = entryMatch.index + entryMatch[0].length;
            let entryDepth = 1;
            let entryEnd = entryStart;
            while (entryDepth > 0 && entryEnd < body.length) {
                if (body[entryEnd] === '{') entryDepth++;
                if (body[entryEnd] === '}') entryDepth--;
                entryEnd++;
            }
            if (entryDepth !== 0) continue;
            const inner = body.slice(entryStart, entryEnd - 1);
            const keywordMatch = inner.match(/"关键词"\s*:\s*\[([\s\S]*?)\]/);
            const keywords = keywordMatch
                ? Array.from(keywordMatch[1].matchAll(/"([^"]+)"/g)).map(match => match[1])
                : [];
            const contentMatch = inner.match(/"内容"\s*:\s*"([\s\S]*?)"\s*(?:,|$)/);
            const content = contentMatch ? contentMatch[1] : '';
            if (name && (content || keywords.length)) {
                entries[name] = { 关键词: keywords, 内容: content };
            }
        }
        if (Object.keys(entries).length) result[category.label] = entries;
    }
    return result;
}

function normalizeKeywords(value, fallback, max = 10) {
    let words = [];
    if (Array.isArray(value)) words = value;
    else if (typeof value === 'string') words = value.split(/[,，、;；|]/);
    words = words
        .map(word => String(word ?? '').replace(/^["'“”]+|["'“”]+$/g, '').trim())
        .filter(Boolean)
        .slice(0, Math.max(1, max));
    if (fallback && !words.some(word => word.toLowerCase() === fallback.toLowerCase())) {
        words.unshift(fallback);
    }
    return Array.from(new Set(words));
}

function normalizeEntryValue(name, value, category) {
    let content = '';
    let keywords = [];
    if (typeof value === 'string') {
        content = value;
    } else if (value && typeof value === 'object') {
        content = String(value.内容 ?? value.content ?? value.text ?? value.description ?? '');
        keywords = normalizeKeywords(value.关键词 ?? value.keywords ?? value.key ?? value.别名, name);
    }
    content = String(content || '')
        .replace(/\\n/g, '\n')
        .replace(/\\"/g, '"')
        .trim();
    if (!content) return null;
    return {
        category: category.key,
        categoryLabel: category.label,
        name: String(name || '').trim().slice(0, 80),
        keywords: keywords.length ? keywords : [String(name).trim()],
        content,
        enabled: true,
    };
}

function normalizeParsedWorldbook(parsed, categories, entryChars = 600) {
    const entries = [];
    if (!parsed || typeof parsed !== 'object') return entries;
    const allowed = new Set((categories || []).map(category => category.key));
    // 设定/剧情是合并类条目，解析阶段不能按普通条目上限截断，否则合并后只剩开头
    const limitFor = (categoryKey) => {
        const category = CATEGORY_BY_KEY.get(categoryKey);
        return category?.single ? Math.max(entryChars, MERGED_ENTRY_CHARS) : entryChars;
    };

    // 兼容 [{category,name,keywords,content}] 这种扁平结构
    if (Array.isArray(parsed)) {
        for (const item of parsed) {
            if (!item || typeof item !== 'object') continue;
            const category = categoryInfo(item.category ?? item.分类 ?? item.type);
            const name = item.name ?? item.名称 ?? item.title;
            if (!category || !allowed.has(category.key) || !name) continue;
            const entry = normalizeEntryValue(name, item, category);
            if (entry) entries.push(entry);
        }
        return entries.map(entry => ({ ...entry, content: trimToLimit(entry.content, limitFor(entry.category)) }));
    }

    const root = parsed.entries && typeof parsed.entries === 'object' && !Array.isArray(parsed.entries)
        ? parsed.entries
        : parsed;

    for (const [rawCategory, value] of Object.entries(root)) {
        const category = categoryInfo(rawCategory);
        if (!category || !allowed.has(category.key) || !value || typeof value !== 'object') continue;

        if (Array.isArray(value)) {
            for (const item of value) {
                if (!item || typeof item !== 'object') continue;
                const name = item.name ?? item.名称 ?? item.条目 ?? item.title;
                if (!name) continue;
                const entry = normalizeEntryValue(name, item, category);
                if (entry) entries.push(entry);
            }
            continue;
        }

        for (const [name, item] of Object.entries(value)) {
            const entry = normalizeEntryValue(name, item, category);
            if (entry) entries.push(entry);
        }
    }

    return entries.map(entry => ({ ...entry, content: trimToLimit(entry.content, limitFor(entry.category)) }));
}

/**
 * 解析模型返回的世界书 JSON，兼容代码块、前后废话、轻微转义错误和扁平数组。
 * @param {string} text
 * @param {{categories?: typeof WORLDBOOK_CATEGORIES, entryChars?: number}} options
 * @returns {{category:string, categoryLabel:string, name:string, keywords:string[], content:string, enabled:boolean}[]}
 */
export function parseWorldbookResponse(text, options = {}) {
    const categories = options.categories?.length ? options.categories : enabledCategories();
    const entryChars = clamp(Number(options.entryChars) || 600, 120, 2000);
    let parsed;
    try {
        parsed = parseJsonLenient(text);
    } catch (error) {
        const fallback = extractWorldbookByRegex(text, categories);
        if (!Object.keys(fallback).length) throw error;
        parsed = fallback;
    }
    const entries = normalizeParsedWorldbook(parsed, categories, entryChars);
    if (!entries.length) throw new Error('JSON 中没有可用的世界书条目');
    return entries;
}

/* ------------------------------------------------------------------ */
/* 合并与格式转换                                                      */
/* ------------------------------------------------------------------ */

function contentAlreadyContains(base, addition) {
    const left = normalizeContent(base).replace(/\s+/g, '');
    const right = normalizeContent(addition).replace(/\s+/g, '');
    if (!left || !right) return true;
    return left.includes(right) || right.includes(left);
}

/**
 * 合并同一分类下的同名条目：
 * - 名字按「忽略标点 / 空白 / 大小写」比较，避免「张三」「张 三」被拆成两条；
 * - 关键词去重后合并，条目名始终排在最前；
 * - 正文按 Markdown 小标题整理后再拼，不会出现两个「## 身份」。
 */
export function mergeWorldbookEntries(input, options = {}) {
    const entryChars = clamp(Number(options.entryChars) || 600, 120, 2000);
    const limits = options.limits && typeof options.limits === 'object' ? options.limits : {};
    const map = new Map();

    const isMerged = categoryKey => MERGED_CATEGORY_KEYS.includes(categoryKey);
    const keywordLimit = categoryKey => (isMerged(categoryKey) ? MERGED_KEYWORD_LIMIT : 10);
    const limitFor = categoryKey => clamp(
        Number(limits[categoryKey]) || (isMerged(categoryKey) ? Math.max(entryChars, MERGED_ENTRY_CHARS) : entryChars),
        120,
        8000,
    );

    for (const raw of input || []) {
        const category = categoryInfo(raw.category || raw.categoryLabel);
        const name = normalizeEntryName(raw.name);
        if (!category || !name) continue;
        const key = `${category.key}::${entryNameKey(name)}`;
        const existing = map.get(key);
        const keywords = normalizeKeywords(raw.keywords, name, keywordLimit(category.key));
        const content = normalizeContent(raw.content);
        if (!existing) {
            map.set(key, {
                category: category.key,
                categoryLabel: category.label,
                name,
                keywords,
                content,
                enabled: raw.enabled !== false,
            });
            continue;
        }
        existing.keywords = normalizeKeywords([...existing.keywords, ...keywords], existing.name, keywordLimit(category.key));
        if (content && !contentAlreadyContains(existing.content, content)) {
            // 同名条目的正文通常共享小标题，先整理再拼接，合并结果更干净。
            existing.content = organizeEntryContent(`${existing.content}\n\n${content}`);
        } else if (countChars(content) > countChars(existing.content)) {
            existing.content = content;
        }
        existing.enabled = existing.enabled !== false || raw.enabled !== false;
    }

    const entries = Array.from(map.values());
    for (const entry of entries) {
        entry.content = trimToLimit(entry.content, limitFor(entry.category));
    }
    const order = new Map(WORLDBOOK_CATEGORIES.map(category => [category.key, category.order]));
    return entries.sort((a, b) => {
        const diff = (order.get(a.category) || 999) - (order.get(b.category) || 999);
        return diff || a.name.localeCompare(b.name, 'zh-CN', { numeric: true });
    });
}

/* ------------------------------------------------------------------ */
/* 设定合并与剧情分段                                                  */
/* ------------------------------------------------------------------ */

/** 某分类的单条字数上限：设定、剧情这类合并条目比普通条目宽 */
export function entryCharLimit(categoryKey, settings = getSettings()) {
    const base = clamp(Number(settings.worldbookEntryChars) || 600, 120, 2000);
    return MERGED_CATEGORY_KEYS.includes(categoryKey) ? Math.max(base, MERGED_ENTRY_CHARS) : base;
}

/**
 * 根据分类和上下文预算，算出每次请求的输出预算与每条内容的引导字数。
 * 生成和 token 预估共用这一份计算，避免两处公式漂移。
 */
export function worldbookOutputPlan(categories, entryChars, ctxTokens) {
    const list = Array.isArray(categories) ? categories : [];
    const perEntry = clamp(Number(entryChars) || 600, 120, 2000);
    const ctx = Math.max(1024, Number(ctxTokens) || 0);
    const singleCount = list.filter(category => category.single).length;
    const multiCount = list.length - singleCount;
    const maxEntriesPerCategory = Math.min(4, Math.max(2, Math.floor(12 / Math.max(1, multiCount || 1))));
    const desiredOutputTokens = clamp(
        Math.ceil((
            multiCount * maxEntriesPerCategory * Math.min(perEntry, 600)
            + singleCount * Math.max(600, Math.min(perEntry, 600) * 2)
        ) * 1.05),
        1800,
        8192,
    );
    const maxTokens = Math.min(
        Math.floor(ctx * 0.5),
        desiredOutputTokens,
    );
    const entryGuide = clamp(
        Math.floor((maxTokens * 0.9) / Math.max(6, multiCount * maxEntriesPerCategory + singleCount * 3)),
        160,
        Math.min(perEntry, 600),
    );
    const singleGuide = singleCount
        ? clamp(Math.floor((maxTokens * 0.8) / singleCount), 300, MERGED_ENTRY_CHARS)
        : 0;
    const maxTokenLimit = Math.max(1200, Math.floor(ctx * 0.55));
    return { maxEntriesPerCategory, desiredOutputTokens, maxTokens, entryGuide, singleGuide, maxTokenLimit };
}

/**
 * 粗略预估一次世界书生成的 token 消耗（输入 + 输出上限）。
 * 只依赖章节字数，不读取正文；缓存命中部分无法在这里扣减，按全量估算。
 *
 * @param {{chapters?:{charCount?:number}[], settings?:object, chunkChars?:number}} [options]
 * @returns {{totalChars:number, effectiveChunk:number, chunks:number, inputTokens:number, outputTokens:number, totalTokens:number, maxTokens:number}}
 */
export function estimateWorldbookUsage(options = {}) {
    const settings = options.settings || getSettings();
    const chapters = Array.isArray(options.chapters) ? options.chapters : [];
    const totalChars = chapters.reduce((sum, chapter) => sum + Math.max(0, Number(chapter.charCount) || 0), 0);
    const budget = computeBudget(settings);
    const requestedChunk = clamp(Number(options.chunkChars ?? settings.worldbookChunkChars) || 9000, 1200, 30000);
    const effectiveChunk = Math.max(1200, Math.min(requestedChunk, Math.floor((budget.inputBudget - 700) / 1.3)));
    const chunks = totalChars > 0 ? Math.ceil(totalChars / effectiveChunk) : 0;
    const categories = enabledCategories(settings);
    const entryChars = clamp(Number(settings.worldbookEntryChars) || 600, 120, 2000);
    const plan = worldbookOutputPlan(categories, entryChars, budget.ctxTokens);
    // 中文按 1.15 token/字保守估算；每块再算上提示词骨架的固定开销。
    const inputTokens = Math.ceil(totalChars * 1.15) + chunks * PROMPT_OVERHEAD_TOKENS;
    const outputTokens = chunks * plan.maxTokens;
    return {
        totalChars,
        effectiveChunk,
        chunks,
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        maxTokens: plan.maxTokens,
    };
}

/** 把章节按顺序切成 count 个连续区间 */
export function buildPlotRanges(chapters, count = 4) {
    const total = Array.isArray(chapters) ? chapters.length : 0;
    if (!total) return [];
    const target = clamp(Math.floor(Number(count) || 4), 1, 12);
    const parts = Math.min(target, total);
    const base = Math.floor(total / parts);
    let remainder = total % parts;
    const ranges = [];
    let cursor = 0;
    for (let index = 0; index < parts; index++) {
        const size = base + (remainder > 0 ? 1 : 0);
        if (remainder > 0) remainder -= 1;
        const start = cursor;
        const end = Math.min(total, cursor + size) - 1;
        cursor = end + 1;
        if (end >= start) ranges.push({ start, end, index: ranges.length });
    }
    return ranges;
}

function shortChapterTitle(title) {
    const text = String(title || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    return text.length > 18 ? `${text.slice(0, 18)}…` : text;
}

function plotRangeName(chapters, range) {
    const first = shortChapterTitle(chapters[range.start]?.title || `第 ${range.start + 1} 章`);
    const last = shortChapterTitle(chapters[range.end]?.title || `第 ${range.end + 1} 章`);
    const span = first && last && first !== last ? `${first}～${last}` : (first || last || '全书');
    return `${PLOT_ENTRY_PREFIX}${span}`.slice(0, 80);
}

/** 分块横跨多个区间时，归到章节重叠最多的那个区间 */
function pickPlotRange(ranges, item) {
    if (!ranges.length) return null;
    const start = Number(item.chapterStart);
    const end = Number.isFinite(Number(item.chapterEnd)) ? Number(item.chapterEnd) : start;
    if (!Number.isFinite(start)) return ranges[0];
    let best = ranges[0];
    let bestOverlap = -Infinity;
    for (const range of ranges) {
        const overlap = Math.min(range.end, end) - Math.max(range.start, start) + 1;
        if (overlap > bestOverlap) {
            bestOverlap = overlap;
            best = range;
        }
    }
    return best;
}

/**
 * 把各分块提取到的条目整理成最终条目：
 * - 标了 single 的分类（设定 / 关系 / 时间线 / 伏笔）各自并成 1 条；
 * - 剧情（event）按章节区间并成 plotEntries 条；
 * - 其余分类原样返回，交给 mergeWorldbookEntries 按条目名合并。
 *
 * @param {{entry:object, chapterStart?:number, chapterEnd?:number}[]} items
 * @param {{chapters?:object[], plotEntries?:number, limits?:object}} options
 * @returns {object[]}
 */
export function assembleMergedEntries(items, options = {}) {
    const chapters = Array.isArray(options.chapters) ? options.chapters : [];
    const limits = options.limits && typeof options.limits === 'object' ? options.limits : {};
    const eventLimit = clamp(Number(limits.event) || MERGED_ENTRY_CHARS, 120, 8000);
    const plotEntries = clamp(Math.floor(Number(options.plotEntries) || 4), 1, 12);

    const passthrough = [];
    const events = [];
    /** categoryKey → { category, items } */
    const singles = new Map();
    for (const item of items || []) {
        const entry = item?.entry;
        if (!entry) continue;
        const category = categoryInfo(entry.category || entry.categoryLabel);
        if (entry.category === 'event' || category?.key === 'event') {
            events.push(item);
            continue;
        }
        if (category?.single) {
            if (!singles.has(category.key)) singles.set(category.key, { category, items: [] });
            singles.get(category.key).items.push(item);
            continue;
        }
        passthrough.push(entry);
    }

    const result = [...passthrough];

    for (const { category, items: group } of singles.values()) {
        const limit = clamp(Number(limits[category.key]) || MERGED_ENTRY_CHARS, 120, 8000);
        const content = mergeHeadingSections(group.map(item => item.entry.content), limit);
        if (!content) continue;
        const keywords = group.flatMap(item => item.entry.keywords || []);
        // 设定额外挂上「世界观 / 设定」，其余单条分类挂上分类名，方便被正文里的泛称触发。
        const extra = category.key === 'concept' ? ['世界观', '设定'] : [category.label];
        result.push({
            category: category.key,
            categoryLabel: category.label,
            name: category.singleName || CONCEPT_ENTRY_NAME,
            keywords: [...keywords, ...extra],
            content,
            enabled: true,
        });
    }

    if (events.length) {
        const ranges = buildPlotRanges(chapters, plotEntries);
        if (!ranges.length) {
            const content = mergeHeadingSections(events.map(item => item.entry.content), eventLimit);
            if (content) {
                result.push({
                    category: 'event',
                    categoryLabel: '剧情',
                    name: `${PLOT_ENTRY_PREFIX}全书`,
                    keywords: events.flatMap(item => item.entry.keywords || []),
                    content,
                    enabled: true,
                });
            }
        } else {
            const buckets = ranges.map(() => []);
            for (const item of events) {
                const range = pickPlotRange(ranges, item);
                if (range) buckets[range.index].push(item.entry);
            }
            ranges.forEach((range, index) => {
                const bucket = buckets[index];
                if (!bucket.length) return;
                const content = mergeHeadingSections(bucket.map(entry => entry.content), eventLimit);
                if (!content) return;
                result.push({
                    category: 'event',
                    categoryLabel: '剧情',
                    name: plotRangeName(chapters, range),
                    keywords: bucket.flatMap(entry => entry.keywords || []),
                    content,
                    enabled: true,
                });
            });
        }
    }

    return result;
}

/** 转换为 SillyTavern 世界书 JSON */
export function toSillyTavernWorldbook(entries, options = {}) {
    const selected = (entries || []).filter(entry => entry.enabled !== false && String(entry.content || '').trim());
    const output = { entries: {} };
    const orderBase = new Map(WORLDBOOK_CATEGORIES.map(category => [category.key, category.order]));
    selected.forEach((entry, index) => {
        const uid = index;
        const category = categoryInfo(entry.category || entry.categoryLabel);
        const name = String(entry.name || '').trim();
        const keywords = normalizeKeywords(entry.keywords, name);
        output.entries[uid] = {
            uid,
            displayIndex: index,
            key: keywords,
            keysecondary: [],
            comment: `${category?.label || '条目'}·${name}`.slice(0, 120),
            content: normalizeContent(entry.content),
            constant: false,
            vectorized: false,
            selective: true,
            selectiveLogic: 0,
            addMemo: false,
            order: (orderBase.get(category?.key) || 900) + index,
            position: 0,
            disable: false,
            ignoreBudget: false,
            excludeRecursion: false,
            preventRecursion: false,
            matchPersonaDescription: false,
            matchCharacterDescription: false,
            matchCharacterPersonality: false,
            matchCharacterDepthPrompt: false,
            matchScenario: false,
            matchCreatorNotes: false,
            delayUntilRecursion: 0,
            probability: 100,
            useProbability: true,
            depth: 4,
            outletName: '',
            group: '',
            groupOverride: false,
            groupWeight: 100,
            scanDepth: null,
            caseSensitive: null,
            matchWholeWords: null,
            useGroupScoring: null,
            automationId: '',
            role: 0,
            sticky: null,
            cooldown: null,
            delay: null,
            triggers: [],
        };
    });
    return output;
}

/* ------------------------------------------------------------------ */
/* 角色卡下载                                                          */
/* ------------------------------------------------------------------ */

/** 把 SillyTavern 世界书条目转换为角色卡 V2 的 character_book 条目 */
function toCardEntry(entry, index) {
    const keywords = Array.isArray(entry.key) ? entry.key : entry.key ? [entry.key] : [];
    return {
        id: index,
        keys: keywords,
        secondary_keys: Array.isArray(entry.keysecondary) ? entry.keysecondary : [],
        comment: entry.comment || '',
        content: entry.content || '',
        constant: !!entry.constant,
        selective: entry.selective !== false,
        insertion_order: Number(entry.order) || 100,
        enabled: entry.disable !== true,
        position: entry.position === 1 ? 'after_char' : 'before_char',
        case_sensitive: !!entry.caseSensitive,
        name: entry.comment || `条目${index + 1}`,
        priority: 10,
        extensions: {
            position: entry.position ?? 0,
            exclude_recursion: false,
            prevent_recursion: false,
            delay_until_recursion: false,
            depth: entry.depth ?? 4,
            selectiveLogic: entry.selectiveLogic ?? 0,
            group: entry.group || '',
            group_override: !!entry.groupOverride,
            group_weight: entry.groupWeight ?? 100,
            use_group_scoring: entry.useGroupScoring ?? null,
            automation_id: entry.automationId || '',
            role: entry.role ?? 0,
            vectorized: !!entry.vectorized,
            display_index: index,
            probability: entry.probability ?? 100,
            sticky: entry.sticky ?? null,
            cooldown: entry.cooldown ?? null,
            delay: entry.delay ?? null,
            addMemo: entry.addMemo !== false,
            scan_depth: entry.scanDepth ?? null,
            match_whole_words: entry.matchWholeWords ?? false,
        },
    };
}

/**
 * 生成 SillyTavern V2 角色卡 JSON，世界书直接内嵌到 character_book。
 * 结构与 novel-auto-generator 下载的角色卡保持一致，额外把文风样本写进 description，
 * 这样即使预设里没有专门写文风，模型也能从角色卡本身读到原作文风。
 *
 * @param {object[]} entries 世界书条目（与 toSillyTavernWorldbook 输入相同）
 * @param {object} [options]
 * @param {string} [options.name] 角色卡名
 * @param {string} [options.novelTitle] 小说名
 * @param {string} [options.worldbookName] 世界书名
 * @param {string} [options.styleSample] 文风样本
 * @param {string} [options.description] 额外角色描述
 * @param {string} [options.firstMes] 开场白
 * @param {string[]} [options.alternateGreetings] 其余初始消息（备用开场白）
 * @param {string[]} [options.tags]
 * @param {string} [options.creator]
 * @param {boolean} [options.embeddedWorldbook] 世界书是否内嵌在卡里；false 时描述改成「已绑定的世界书」
 * @returns {object}
 */
export function toCharacterCard(entries, options = {}) {
    const title = String(options.name || options.novelTitle || options.worldbookName || '小说角色卡')
        .trim()
        .slice(0, 60) || '小说角色卡';
    const bookName = String(options.worldbookName || `${title} · 世界书`).trim().slice(0, 80);
    const embedded = options.embeddedWorldbook !== false;
    const styleSample = String(options.styleSample || '').trim();
    const firstMes = String(options.firstMes || '').trim();
    const alternateGreetings = (Array.isArray(options.alternateGreetings) ? options.alternateGreetings : [])
        .map(text => String(text || '').trim())
        .filter(Boolean);
    const stWorldbook = toSillyTavernWorldbook(entries);
    const cardEntries = Object.values(stWorldbook.entries).map((entry, index) => toCardEntry(entry, index));

    const descriptionParts = [];
    const intro = String(options.description || '').trim();
    if (intro) descriptionParts.push(intro);
    descriptionParts.push(embedded
        ? `【世界书】人物、地点、势力、能力与设定见随卡内嵌的世界书《${bookName}》。`
        : `【世界书】人物、地点、势力、能力与设定见已绑定的世界书《${bookName}》。`);

    if (styleSample) {
        descriptionParts.push([
            '【文风样本 · 写正文时必须沿用】',
            `以下为《${title}》原文片段，只用于模仿叙述节奏、句长、意象密度与对话写法，不要照抄句子：`,
            '---',
            styleSample,
            '---',
        ].join('\n'));
    }

    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: title,
            description: descriptionParts.join('\n\n'),
            personality: '',
            scenario: '',
            first_mes: firstMes,
            mes_example: '',
            creator_notes: [
                `由「小说阅读器」从《${title}》提取的世界书生成。`,
                embedded
                    ? `世界书《${bookName}》已内嵌，共 ${cardEntries.length} 条。导入角色卡后，「小说阅读器」会自动导入并绑定；也可以手动在角色面板「更多…」里点「导入角色卡的世界书」。`
                    : `世界书《${bookName}》已单独导入酒馆并绑定到这张卡，共 ${cardEntries.length} 条。`,
                firstMes
                    ? `角色卡内置 ${alternateGreetings.length + 1} 条初始消息，分别是小说开头与小说结尾两个开局，聊天开始时可在开场白菜单里切换。`
                    : '',
                '文风样本已附在角色描述中；想进一步贴合原著，可在「小说阅读器 → 文风」页按酒馆当前选用的预设生成文风，再粘进预设。',
            ].join(''),
            system_prompt: '',
            post_history_instructions: '',
            alternate_greetings: alternateGreetings,
            character_book: {
                name: bookName,
                description: `由「小说阅读器」从《${title}》提取`,
                scan_depth: 2,
                token_budget: 2048,
                recursive_scanning: false,
                extensions: {},
                entries: cardEntries,
            },
            tags: Array.isArray(options.tags) && options.tags.length
                ? options.tags
                : ['小说阅读器', '世界书', '小说文风'],
            creator: String(options.creator || 'NovelReader'),
            character_version: '1.0',
            extensions: {
                talkativeness: '0.5',
                fav: false,
                // 不在卡里预绑定世界书名：避免导入时被链接到同名的空世界书，导致内嵌条目被忽略
                world: '',
                depth_prompt: {
                    prompt: '',
                    depth: 4,
                    role: 'system',
                },
                novel_reader: {
                    version: 2,
                    novel_title: title,
                    worldbook_name: bookName,
                    style_sample_chars: styleSample.length,
                    created_at: new Date().toISOString(),
                },
            },
        },
    };
}

export function worldbookStats(entries) {
    const categories = {};
    for (const entry of entries || []) {
        const label = categoryInfo(entry.category || entry.categoryLabel)?.label || '其他';
        categories[label] = (categories[label] || 0) + 1;
    }
    return {
        total: entries?.length || 0,
        enabled: (entries || []).filter(entry => entry.enabled !== false && String(entry.content || '').trim()).length,
        categories,
        chars: (entries || []).reduce((sum, entry) => sum + countChars(entry.content || ''), 0),
    };
}

/* ------------------------------------------------------------------ */
/* 切块与生成                                                          */
/* ------------------------------------------------------------------ */

function splitChapterText(text, maxChars) {
    const source = String(text || '').trim();
    if (!source) return [];
    if (source.length <= maxChars) return [source];
    return chunkText(source, maxChars).filter(Boolean);
}

function buildChunksFromSegments(segments, { chunkChars, inputBudget }) {
    const chunks = [];
    let current = null;
    const flush = () => {
        if (!current || !current.segments.length) return;
        const first = current.segments[0];
        const last = current.segments[current.segments.length - 1];
        const label = first.label === last.label ? first.label : `${first.label} ～ ${last.label}`;
        chunks.push({
            label,
            text: current.segments.map(segment => `【${segment.label}】\n${segment.text}`).join('\n\n'),
            chars: current.chars,
            tokens: current.tokens,
            chapterStart: first.chapterIndex,
            chapterEnd: last.chapterIndex,
        });
        current = null;
    };

    for (const segment of segments) {
        const cost = segment.chars + 80;
        const tokens = estimateTokens(segment.text) + 80;
        if (!current) current = { segments: [], chars: 0, tokens: 0 };
        if (current.segments.length > 0 && (
            current.chars + cost > chunkChars
            || current.tokens + tokens + PROMPT_OVERHEAD_TOKENS > inputBudget
        )) {
            flush();
            current = { segments: [], chars: 0, tokens: 0 };
        }
        current.segments.push(segment);
        current.chars += cost;
        current.tokens += tokens;
    }
    flush();
    return chunks;
}

/**
 * 把选中的章节按字数与 token 预算切块。
 * @param {{chapters:{index:number,title:string}[], loadChapter:(index:number)=>Promise<string>, chunkChars:number, inputBudget:number, onProgress?:Function}} options
 */
export async function buildWorldbookChunks({ chapters, loadChapter, chunkChars = 9000, inputBudget = 4000, onProgress = () => {}, signal }) {
    const tokenLimit = Math.max(1200, inputBudget - PROMPT_OVERHEAD_TOKENS);
    const maxCharsByTokens = Math.max(1200, Math.floor(tokenLimit / 1.3));
    const effectiveChars = Math.max(1200, Math.min(Number(chunkChars) || 9000, maxCharsByTokens));
    const segments = [];

    for (let position = 0; position < (chapters || []).length; position++) {
        if (signal?.aborted) throw createAbortError();
        const chapter = chapters[position];
        const text = String(await loadChapter(chapter.index) || '').trim();
        if (!text) continue;
        const pieces = splitChapterText(text, effectiveChars);
        pieces.forEach((piece, partIndex) => {
            segments.push({
                label: pieces.length > 1 ? `${chapter.title}（${partIndex + 1}/${pieces.length}）` : chapter.title,
                text: piece,
                chars: countChars(piece),
                chapterIndex: position,
            });
        });
        if (position % 5 === 0 || position === chapters.length - 1) {
            onProgress({ type: 'split', current: position + 1, total: chapters.length });
        }
    }

    return buildChunksFromSegments(segments, { chunkChars: effectiveChars, inputBudget });
}

function getContext() {
    return globalThis.SillyTavern?.getContext?.();
}

function stableOpenAiBudget(context, maxTokens) {
    if (!context || context.mainApi !== 'openai') return null;
    const outputSettings = context.chatCompletionSettings;
    if (!outputSettings || !Number.isFinite(Number(outputSettings.openai_max_tokens))) return null;
    const original = Number(outputSettings.openai_max_tokens);
    outputSettings.openai_max_tokens = Math.max(1024, Math.floor(maxTokens));
    return {
        restore() {
            outputSettings.openai_max_tokens = original;
        },
    };
}

async function mapLimit(items, limit, worker) {
    let cursor = 0;
    const runners = Array.from({ length: Math.min(Math.max(1, limit), Math.max(1, items.length)) }, async () => {
        while (true) {
            const index = cursor++;
            if (index >= items.length) return;
            await worker(items[index], index);
        }
    });
    await Promise.all(runners);
}

/**
 * 生成世界书。支持中断、并发、失败隔离和分块缓存。
 * @param {object} options
 * @param {string} options.novelId
 * @param {string} options.novelTitle
 * @param {{index:number,title:string}[]} options.chapters
 * @param {(index:number)=>Promise<string>} options.loadChapter
 * @param {object} [options.settings]
 * @param {AbortSignal} [options.signal]
 * @param {Function} [options.onProgress]
 * @param {{getMany?:Function,put?:Function}} [options.cache]
 */
export async function generateWorldbook(options) {
    const {
        novelId,
        novelTitle,
        chapters,
        loadChapter,
        settings: providedSettings,
        signal,
        onProgress = () => {},
        cache = null,
    } = options;

    if (!chapters?.length) throw new Error('没有选择要转换的章节');
    const settings = providedSettings || getSettings();
    const categories = enabledCategories(settings);
    if (!categories.length) throw new Error('至少选择一个提取分类');
    const budget = computeBudget(settings);
    const chunkChars = clamp(Number(settings.worldbookChunkChars) || 9000, 1200, 30000);
    const entryChars = clamp(Number(settings.worldbookEntryChars) || 600, 120, 2000);
    const concurrency = clamp(Number(settings.worldbookConcurrency) || 2, 1, 4);

    const chunks = await buildWorldbookChunks({
        chapters,
        loadChapter,
        chunkChars,
        inputBudget: budget.inputBudget,
        onProgress,
        signal,
    });
    if (!chunks.length) throw new Error('选中的章节没有正文');

    const stats = {
        calls: 0,
        chunks: chunks.length,
        cacheHits: 0,
        failedChunks: 0,
        entries: 0,
        inputChars: chunks.reduce((sum, chunk) => sum + chunk.chars, 0),
        startedAt: Date.now(),
    };
    onProgress({ type: 'plan', chunks, budget, stats });

    const providerKey = `${settings.provider || 'current'}:${settings.profileId || ''}`;
    const jobs = chunks.map((chunk, index) => ({
        chunk,
        index,
        key: hashText([
            PROMPT_VERSION,
            novelId || '',
            novelTitle,
            providerKey,
            categories.map(category => category.key).join(','),
            settings.worldbookExtraInstruction || '',
            entryChars,
            chunk.text,
        ].join('|')),
        entries: [],
        fromCache: false,
        error: null,
    }));

    if (cache?.getMany) {
        try {
            const rows = await Promise.resolve(cache.getMany(jobs.map(job => job.key)));
            rows.forEach((row, index) => {
                if (row && Array.isArray(row.entries) && row.entries.length) {
                    jobs[index].entries = row.entries;
                    jobs[index].fromCache = true;
                }
            });
            stats.cacheHits = jobs.filter(job => job.fromCache).length;
            if (stats.cacheHits) {
                onProgress({ type: 'cache', text: `复用 ${stats.cacheHits}/${jobs.length} 个已完成分块，跳过对应请求` });
            }
        } catch (error) {
            console.warn('[小说阅读器] 读取世界书分块缓存失败', error);
        }
    }

    // 每条内容都要占输出 token；按分类数和单条上限估算，避免 JSON 写到一半被截断。
    const {
        maxEntriesPerCategory,
        maxTokens,
        entryGuide,
        singleGuide,
        maxTokenLimit,
    } = worldbookOutputPlan(categories, entryChars, budget.ctxTokens);
    let stable = null;
    let omitResponseLength = false;
    const context = getContext();
    if (concurrency > 1 && settings.provider !== 'profile' && jobs.length > 1) {
        stable = stableOpenAiBudget(context, maxTokens);
        omitResponseLength = Boolean(stable);
    }

    const system = buildWorldbookSystemPrompt();
    let finished = 0;
    const report = () => {
        onProgress({
            type: 'progress',
            current: finished,
            total: jobs.length,
            percent: Math.round((finished / Math.max(1, jobs.length)) * 100),
            stats,
        });
    };
    for (const job of jobs) {
        if (job.fromCache) finished++;
    }
    if (finished) report();

    const runJob = async (job) => {
        if (job.entries.length) return;
        if (signal?.aborted) throw createAbortError();
        onProgress({
            type: 'chunk-start',
            index: job.index,
            total: jobs.length,
            label: job.chunk.label,
        });

        const user = buildWorldbookPrompt({
            novelTitle,
            chunk: job.chunk,
            categories,
            extraInstruction: settings.worldbookExtraInstruction || '',
            maxEntries: maxEntriesPerCategory,
            entryGuide,
            singleGuide,
        });

        let currentMax = maxTokens;
        let lastError = null;
        for (let parseAttempt = 0; parseAttempt < 2; parseAttempt++) {
            try {
                const text = await callWithRetry({
                    system,
                    user,
                    maxTokens: currentMax,
                    maxTokenLimit,
                    omitResponseLength,
                    settings,
                    signal,
                    label: `世界书 ${job.index + 1}/${jobs.length}`,
                    onProgress,
                    stats,
                });
                const entries = parseWorldbookResponse(text, { categories, entryChars });
                job.entries = entries;
                finished++;
                stats.entries += entries.length;
                if (cache?.put) {
                    try {
                        await cache.put({
                            key: job.key,
                            novelId: novelId || '',
                            label: job.chunk.label,
                            entries,
                            createdAt: Date.now(),
                        });
                    } catch (error) {
                        console.warn('[小说阅读器] 保存世界书分块缓存失败', error);
                    }
                }
                onProgress({
                    type: 'chunk-done',
                    index: job.index,
                    total: jobs.length,
                    label: job.chunk.label,
                    entries: entries.length,
                });
                report();
                return;
            } catch (error) {
                if (error?.name === 'AbortError' || isAbortError(error)) throw createAbortError();
                lastError = error;
                // JSON 被截断时，增大输出预算再解析一次
                if (parseAttempt === 0 && /JSON|解析|Unexpected|Unterminated/i.test(String(error.message || ''))) {
                    currentMax = Math.min(maxTokenLimit, Math.max(currentMax + 512, Math.ceil(currentMax * 1.5)));
                    onProgress({
                        type: 'stage',
                        stage: 'retry-parse',
                        text: `分块 ${job.index + 1} 的 JSON 不完整，增大输出预算到 ${currentMax} tokens 重试`,
                    });
                    continue;
                }
                break;
            }
        }

        job.error = lastError?.message || '未知错误';
        stats.failedChunks += 1;
        finished++;
        onProgress({
            type: 'chunk-failed',
            index: job.index,
            total: jobs.length,
            label: job.chunk.label,
            error: job.error,
        });
        report();
    };

    try {
        await mapLimit(jobs, concurrency, runJob);
    } finally {
        stable?.restore();
    }

    const failedLabels = jobs.filter(job => job.error).map(job => job.chunk.label);
    const limits = {};
    for (const category of categories) {
        limits[category.key] = entryCharLimit(category.key, settings);
    }
    const plotEntries = clamp(Math.floor(Number(settings.worldbookPlotEntries) || 4), 1, 12);
    const rawItems = jobs.flatMap(job => job.entries.map(entry => ({
        entry,
        chapterStart: job.chunk.chapterStart,
        chapterEnd: job.chunk.chapterEnd,
    })));
    const prepared = assembleMergedEntries(rawItems, { chapters, plotEntries, limits });
    const entries = mergeWorldbookEntries(prepared, { entryChars, limits });
    stats.entries = entries.length;
    stats.elapsedMs = Date.now() - stats.startedAt;
    if (!entries.length) {
        const first = jobs.find(job => job.error)?.error;
        throw new Error(`所有分块都失败了${first ? `：${first}` : ''}`);
    }

    const conceptCount = entries.filter(entry => entry.category === 'concept').length;
    const plotCount = entries.filter(entry => entry.category === 'event').length;
    const mergeNotes = [];
    if (conceptCount) mergeNotes.push(`设定合并为 ${conceptCount} 条`);
    if (plotCount) mergeNotes.push(`剧情按章节区间合并为 ${plotCount} 条`);
    if (mergeNotes.length) {
        onProgress({ type: 'stage', stage: 'merge', text: mergeNotes.join('，') });
    }
    const truncated = entries.filter(entry => MERGED_CATEGORY_KEYS.includes(entry.category)
        && String(entry.content || '').endsWith('…')
        && countChars(entry.content) >= MERGED_ENTRY_CHARS);
    if (truncated.length) {
        onProgress({
            type: 'stage',
            stage: 'truncate',
            text: `${truncated.length} 个合并条目达到 ${MERGED_ENTRY_CHARS} 字上限，超出部分已截断（${truncated.map(entry => entry.name).slice(0, 3).join('、')}${truncated.length > 3 ? ' 等' : ''}）`,
        });
    }

    const result = {
        entries,
        failedLabels,
        incomplete: failedLabels.length > 0,
        chunks: chunks.length,
        categories: categories.map(category => category.key),
        plotEntries,
        stats,
        budget,
    };
    onProgress({ type: 'done', result, stats });
    return result;
}
