/**
 * 小说阅读器 - 世界书条目整理与合并
 *
 * 这里只放不依赖酒馆环境的纯函数：
 * - 条目名 / 关键词归一化；
 * - 正文整理：合并同名 Markdown 小标题、去掉重复段落；
 * - 疑似重复条目检测（同分类内按名称、关键词、尾名判断）；
 * - 手动合并多个条目；
 * - AI 整理 / 查重复核的提示词与响应解析。
 *
 * js/ui.js 负责界面与模型调用，js/worldbook.js 负责提取与生成。
 * 这些函数都可以直接在 Node 下测试（见 dev/test-node.mjs）。
 */

import { clamp, cleanModelOutput, countChars, trimToLimit } from './util.js';

/** 普通条目的关键词上限 */
export const ENTRY_KEYWORD_LIMIT = 12;
/** 一次查重最多返回多少组，避免超大世界书卡住界面 */
export const DUPLICATE_GROUP_LIMIT = 200;
/** AI 复核一组重复条目时最多塞几条 */
export const DUPLICATE_JUDGE_LIMIT = 6;

/** 判定重复时忽略的通用词：几乎每个条目都会带，用它们判断会把整本书并成一条 */
const GENERIC_KEYWORDS = new Set([
    '主角',
    '女主',
    '男主',
    '配角',
    '反派',
    '人物',
    '角色',
    '我',
    '他',
    '她',
    '它',
    '小说',
    '世界',
    '设定',
    '故事',
    '剧情',
    '身份',
    '能力',
    '关系',
    '经历',
]);

/** 归一化条目名时去掉的名字装饰 */
const NAME_TRIM_PATTERN = /^[\s"'“”‘’「」『』《》〈〉【】\[\]()（）]+|[\s"'“”‘’「」『』《》〈〉【】\[\]()（）]+$/g;

/** 比较名字 / 关键词时忽略的标点与空白 */
const KEY_STRIP_PATTERN = /[\s·・•‥…—–\-_.,，。!！?？:：;；'"“”‘’「」『』《》〈〉【】（）()\[\]{}<>/@#&*+~`^|\\]/g;

/**
 * 清理条目名：去掉首尾引号 / 括号，压掉多余空白。
 * 不会去掉名字中间的符号，所以「张三·捕快」会保留。
 */
export function normalizeEntryName(value) {
    const text = String(value ?? '')
        .replace(/\u3000/g, ' ')
        .replace(NAME_TRIM_PATTERN, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!text) return '';
    return Array.from(text).slice(0, 80).join('');
}

/** 全角 ASCII 折成半角，方便「ＡＢＣ」与「ABC」判为同名 */
function toHalfWidth(text) {
    return String(text || '')
        .replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
        .replace(/\u3000/g, ' ');
}

/** 用于比较的名字键：忽略大小写、空白和标点 */
export function entryNameKey(value) {
    return toHalfWidth(normalizeEntryName(value)).toLowerCase().replace(KEY_STRIP_PATTERN, '');
}

/** 统一换行、行尾空白与多余空行 */
export function normalizeContent(text) {
    return String(text || '')
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function contentKey(text) {
    return String(text || '').replace(/\s+/g, '').toLowerCase();
}

/* ------------------------------------------------------------------ */
/* 正文整理                                                            */
/* ------------------------------------------------------------------ */

/** 按 Markdown 标题切节，用于把多段同名小标题的内容拼到一起 */
export function splitHeadingSections(text) {
    const sections = [];
    let current = { title: '', body: [] };
    for (const line of normalizeContent(text).split('\n')) {
        const match = /^#{1,6}\s+(.+?)\s*$/.exec(line.trim());
        if (match) {
            if (current.title || current.body.some(item => item.trim())) sections.push(current);
            current = { title: match[1], body: [] };
        } else {
            current.body.push(line);
        }
    }
    if (current.title || current.body.some(item => item.trim())) sections.push(current);
    return sections;
}

/**
 * 合并多段内容：同名小标题归到一起，顺序保持首次出现的顺序。
 * maxChars > 0 时按上限截断。
 */
export function mergeHeadingSections(texts, maxChars = 0) {
    const order = [];
    const map = new Map();
    for (const text of texts || []) {
        for (const section of splitHeadingSections(text)) {
            const body = section.body.join('\n').trim();
            if (!body) continue;
            const key = section.title.toLowerCase();
            if (!map.has(key)) {
                map.set(key, { title: section.title, bodies: [] });
                order.push(key);
            }
            const slot = map.get(key);
            const existing = slot.bodies.join('\n');
            if (!existing) {
                slot.bodies.push(body);
            } else if (existing.includes(body)) {
                continue;
            } else if (body.includes(existing)) {
                slot.bodies = [body];
            } else {
                slot.bodies.push(body);
            }
        }
    }
    const merged = order
        .map(key => {
            const slot = map.get(key);
            const body = slot.bodies.join('\n\n').trim();
            if (!body) return '';
            return slot.title ? `## ${slot.title}\n${body}` : body;
        })
        .filter(Boolean);
    if (!merged.length) return '';
    const joined = merged.join('\n\n');
    return maxChars > 0 ? trimToLimit(joined, maxChars) : joined;
}

/** 整段是否都由列表行组成 */
function isListBlock(lines) {
    return lines.some(line => line.trim())
        && lines.every(line => !line.trim() || /^\s*(?:[-*+•]|\d+[.)、])\s+/.test(line));
}

/**
 * 去掉完全重复的段落 / 列表行。
 * 只做“归一化后完全相同”的去重，不做包含关系判断，避免把更详细的描述删掉。
 */
export function dedupeParagraphs(text) {
    const blocks = normalizeContent(text).split(/\n{2,}/);
    const seen = new Set();
    const output = [];
    for (let block of blocks) {
        block = block.replace(/[ \t]+$/gm, '').trim();
        if (!block) continue;
        const lines = block.split('\n');
        if (lines.length > 1 && isListBlock(lines)) {
            const seenLines = new Set();
            const kept = [];
            for (const line of lines) {
                const key = contentKey(line.replace(/^\s*(?:[-*+•]|\d+[.)、])\s+/, ''));
                if (!key || seenLines.has(key)) continue;
                seenLines.add(key);
                kept.push(line.trimEnd());
            }
            block = kept.join('\n').trim();
            if (!block) continue;
        }
        const key = contentKey(block);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        output.push(block);
    }
    return output.join('\n\n');
}

/**
 * 整理一条正文：去重段落 → 合并同名小标题 → 按上限截断。
 * 没有 Markdown 小标题时，等价于“去除重复段落 + 清理空行”。
 */
export function organizeEntryContent(text, options = {}) {
    const maxChars = Math.max(0, Number(options.maxChars) || 0);
    const normalized = dedupeParagraphs(normalizeContent(text));
    if (!normalized) return '';
    const merged = mergeHeadingSections([normalized], maxChars);
    const result = merged || (maxChars > 0 ? trimToLimit(normalized, maxChars) : normalized);
    return result.trim();
}

/** 去重关键词（忽略大小写与标点），并保证条目名排在最前 */
export function dedupeKeywords(keywords, fallbackName = '', max = ENTRY_KEYWORD_LIMIT) {
    const limit = clamp(Number(max) || ENTRY_KEYWORD_LIMIT, 1, 64);
    const words = [];
    const push = (value) => {
        const raw = String(value ?? '').trim();
        if (!raw) return;
        words.push(raw);
    };
    if (Array.isArray(keywords)) keywords.forEach(push);
    else if (typeof keywords === 'string') keywords.split(/[,，、;；|]/).forEach(push);
    else if (keywords) push(keywords);

    const name = normalizeEntryName(fallbackName);
    if (name) words.unshift(name);

    const seen = new Set();
    const output = [];
    for (const word of words) {
        const key = entryNameKey(word);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        output.push(word);
        if (output.length >= limit) break;
    }
    return output;
}

/**
 * 对一批条目做本地整理，返回新数组（不修改入参）。
 * @param {object[]} entries
 * @param {{indexes?: Iterable<number>, limitFor?: (category:string)=>number, maxChars?: number}} options
 */
export function organizeWorldbookEntries(entries, options = {}) {
    const source = Array.isArray(entries) ? entries : [];
    const picked = options.indexes ? new Set(Array.from(options.indexes, Number)) : null;
    const fallbackMax = Math.max(0, Number(options.maxChars) || 0);
    return source.map((entry, index) => {
        if (picked && !picked.has(index)) return entry;
        if (!entry || typeof entry !== 'object') return entry;
        const maxChars = typeof options.limitFor === 'function'
            ? Math.max(0, Number(options.limitFor(entry.category)) || fallbackMax)
            : fallbackMax;
        const name = normalizeEntryName(entry.name) || entry.name;
        return {
            ...entry,
            name,
            keywords: dedupeKeywords(entry.keywords, name),
            content: organizeEntryContent(entry.content, { maxChars }),
        };
    });
}

/* ------------------------------------------------------------------ */
/* 疑似重复检测                                                        */
/* ------------------------------------------------------------------ */

/** 一条条目的名字与有效关键词键集合 */
function entryKeys(entry) {
    const name = normalizeEntryName(entry?.name);
    const nameKey = entryNameKey(name);
    const keywordKeys = new Set();
    const keywords = Array.isArray(entry?.keywords) ? entry.keywords : [];
    for (const keyword of keywords) {
        const key = entryNameKey(keyword);
        if (!key || key === nameKey || GENERIC_KEYWORDS.has(key)) continue;
        keywordKeys.add(key);
    }
    return { name, nameKey, keywordKeys };
}

/**
 * 判断两条同分类条目是否疑似同一对象。
 * 名称包含、共享两个以上关键词才算，单字尾名相同不会单独触发，
 * 避免「张三 / 李三」这种只是名字像的条目被并掉。
 */
function compareEntryPair(a, b) {
    const left = entryKeys(a);
    const right = entryKeys(b);
    if (!left.nameKey || !right.nameKey) return null;
    if (left.nameKey === right.nameKey) return { score: 100, reason: '同名' };

    const shared = [];
    for (const key of left.keywordKeys) {
        if (right.keywordKeys.has(key)) shared.push(key);
    }
    const contains = left.nameKey.length >= 2
        && right.nameKey.length >= 2
        && (left.nameKey.includes(right.nameKey) || right.nameKey.includes(left.nameKey));
    const tailSame = left.nameKey.slice(-2) === right.nameKey.slice(-2)
        && Math.min(left.nameKey.length, right.nameKey.length) >= 2;

    if (contains && shared.length) return { score: 90, reason: '名称包含 + 共享关键词' };
    if (shared.length >= 2) return { score: 80, reason: `共享 ${shared.length} 个关键词` };
    if (contains) return { score: 70, reason: '名称包含' };
    if (shared.length === 1 && tailSame) return { score: 60, reason: '尾名相同 + 共享关键词' };
    return null;
}

/**
 * 选一个最适合当合并后的名字：
 * 如果有一个名字被这一组里所有名字包含，就用它；否则用正文最长的条目名。
 */
export function pickMainName(entries) {
    const list = (entries || []).filter(entry => normalizeEntryName(entry?.name));
    if (!list.length) return '';
    const names = list.map(entry => normalizeEntryName(entry.name));
    const keys = names.map(entryNameKey);
    const contained = names.find((name, index) => keys[index].length >= 2
        && keys.every((other, otherIndex) => otherIndex === index || other.includes(keys[index])));
    if (contained) return contained;
    let best = names[0];
    let bestChars = -1;
    for (const entry of list) {
        const chars = countChars(entry.content || '');
        if (chars > bestChars) {
            bestChars = chars;
            best = normalizeEntryName(entry.name);
        }
    }
    return best;
}

/**
 * 在同一分类内查找疑似重复条目，返回可直接展示/合并的分组。
 * @returns {{id:string, category:string, categoryLabel:string, indexes:number[], names:string[], reason:string, score:number, mainName:string}[]}
 */
export function findDuplicateGroups(entries, options = {}) {
    const source = Array.isArray(entries) ? entries : [];
    const maxGroups = clamp(Number(options.maxGroups) || DUPLICATE_GROUP_LIMIT, 1, 1000);
    const buckets = new Map();
    source.forEach((entry, index) => {
        if (!entry || !String(entry.content || '').trim()) return;
        const category = String(entry.category || entry.categoryLabel || 'other');
        if (!buckets.has(category)) buckets.set(category, []);
        buckets.get(category).push({ entry, index });
    });

    const groups = [];
    for (const [category, members] of buckets) {
        if (members.length < 2) continue;
        const parent = members.map((_, index) => index);
        const find = (value) => {
            let current = value;
            while (parent[current] !== current) {
                parent[current] = parent[parent[current]];
                current = parent[current];
            }
            return current;
        };
        const union = (a, b) => {
            const rootA = find(a);
            const rootB = find(b);
            if (rootA !== rootB) parent[rootB] = rootA;
        };
        const reasons = new Map();

        for (let i = 0; i < members.length; i++) {
            for (let j = i + 1; j < members.length; j++) {
                const verdict = compareEntryPair(members[i].entry, members[j].entry);
                if (!verdict) continue;
                union(i, j);
                reasons.set(`${i}:${j}`, verdict.reason);
            }
        }

        const components = new Map();
        members.forEach((member, localIndex) => {
            const root = find(localIndex);
            if (!components.has(root)) components.set(root, []);
            components.get(root).push({ ...member, localIndex });
        });

        for (const component of components.values()) {
            if (component.length < 2) continue;
            const indexes = component.map(item => item.index).sort((a, b) => a - b);
            const reasonList = [];
            for (let i = 0; i < component.length; i++) {
                for (let j = i + 1; j < component.length; j++) {
                    const reason = reasons.get(`${component[i].localIndex}:${component[j].localIndex}`)
                        || reasons.get(`${component[j].localIndex}:${component[i].localIndex}`);
                    if (!reason) continue;
                    reasonList.push(reason);
                }
            }
            const names = component
                .map(item => normalizeEntryName(item.entry.name))
                .filter(Boolean);
            groups.push({
                id: `${category}::${indexes.join('-')}`,
                category,
                categoryLabel: component[0].entry.categoryLabel || category,
                indexes,
                names,
                reason: Array.from(new Set(reasonList)).slice(0, 2).join('；') || '内容相似',
                score: reasonList.length,
                mainName: pickMainName(component.map(item => item.entry)),
            });
            if (groups.length >= maxGroups) return groups;
        }
    }
    return groups;
}

/* ------------------------------------------------------------------ */
/* 手动合并                                                            */
/* ------------------------------------------------------------------ */

/**
 * 把选中的多个条目合并成一条，返回新数组（不修改入参）。
 * 合并后的条目放在第一个选中条目原来的位置，其余被删除。
 *
 * @param {object[]} entries
 * @param {{
 *   indexes: number[],
 *   name?: string,
 *   category?: string,
 *   categoryLabels?: Record<string,string>,
 *   separator?: boolean,
 *   organize?: boolean,
 *   maxChars?: number,
 *   keywordLimit?: number,
 * }} options
 */
export function mergeEntries(entries, options = {}) {
    const source = Array.isArray(entries) ? entries : [];
    const picked = Array.from(new Set(Array.from(options.indexes || [], Number)))
        .filter(index => Number.isInteger(index) && index >= 0 && index < source.length)
        .sort((a, b) => a - b);
    if (picked.length < 2) throw new Error('至少需要选择 2 个条目才能合并');

    const firstIndex = picked[0];
    const first = source[firstIndex];
    const selected = picked.map(index => source[index]);
    const name = normalizeEntryName(options.name) || pickMainName(selected);
    if (!name) throw new Error('合并后的条目名不能为空');

    const category = String(options.category || first.category || '').trim();
    const labels = options.categoryLabels && typeof options.categoryLabels === 'object'
        ? options.categoryLabels
        : {};
    const categoryLabel = labels[category]
        || selected.find(entry => entry.category === category)?.categoryLabel
        || (category === first.category ? first.categoryLabel : '')
        || category
        || first.categoryLabel;

    const keywords = dedupeKeywords(
        selected.flatMap(entry => [...(Array.isArray(entry.keywords) ? entry.keywords : []), entry.name]),
        name,
        options.keywordLimit,
    );
    const blocks = selected.map(entry => normalizeContent(entry.content)).filter(Boolean);
    const separator = options.separator !== false;
    const joined = blocks.join(separator ? '\n\n---\n\n' : '\n\n');
    const content = options.organize === false
        ? (Number(options.maxChars) > 0 ? trimToLimit(joined, Number(options.maxChars)) : joined)
        : organizeEntryContent(joined, { maxChars: Number(options.maxChars) || 0 });

    const merged = {
        ...first,
        category,
        categoryLabel,
        name,
        keywords,
        content,
        enabled: selected.some(entry => entry.enabled !== false),
    };

    const pickedSet = new Set(picked);
    const next = [];
    source.forEach((entry, index) => {
        if (index === firstIndex) next.push(merged);
        else if (!pickedSet.has(index)) next.push(entry);
    });
    return { entries: next, merged, removed: picked.length - 1 };
}

/**
 * 按查重结果批量合并。索引会在每次合并后变化，所以按分类 + 条目名重新定位。
 * @param {object[]} entries
 * @param {{category?:string, names?:string[], mainName?:string}[]} groups
 */
export function mergeDuplicateGroups(entries, groups, options = {}) {
    let current = Array.isArray(entries) ? entries.slice() : [];
    let mergedGroups = 0;
    const labels = options.categoryLabels || {};
    for (const group of groups || []) {
        const keys = new Set((group?.names || []).map(entryNameKey).filter(Boolean));
        if (!keys.size) continue;
        const indexes = [];
        current.forEach((entry, index) => {
            if (group.category && entry.category !== group.category) return;
            if (keys.has(entryNameKey(entry.name))) indexes.push(index);
        });
        if (indexes.length < 2) continue;
        const maxChars = typeof options.maxChars === 'function'
            ? options.maxChars(group.category)
            : options.maxChars;
        const result = mergeEntries(current, {
            indexes,
            name: group.mainName,
            category: group.category,
            categoryLabels: labels,
            separator: options.separator !== false,
            organize: options.organize !== false,
            maxChars,
            keywordLimit: options.keywordLimit,
        });
        current = result.entries;
        mergedGroups++;
    }
    return { entries: current, mergedGroups };
}

/* ------------------------------------------------------------------ */
/* AI 整理提示词与响应解析                                              */
/* ------------------------------------------------------------------ */

export const ORGANIZE_SYSTEM_PROMPT = [
    '你是中文小说世界书条目的整理编辑。',
    '你的工作只是整理用户给出的条目正文：合并重复信息、合并同义小标题、删掉空话和重复段落、保留所有独特设定与细节。',
    '不要添加原文没有的信息，不要写文学评价，不要输出前言、结语、解释或代码块。',
    '直接输出整理后的条目正文，用 Markdown 小标题组织。',
].join('\n');

export const ORGANIZE_PROMPT_PRESETS = [
    {
        key: 'balanced',
        label: '均衡整理',
        text: [
            '请整理下面的世界书条目「{NAME}」（分类：{CATEGORY}）。',
            '',
            '要求：',
            '1. 合并重复的属性描述，同一件事只保留一条；',
            '2. 把同类信息归到同一个 Markdown 小标题下，小标题按重要程度排序；',
            '3. 去掉空话、重复表述和模型套话，保留所有独特细节与专有名词；',
            '4. 不补充原文没有的信息，不写评价；',
            '5. 直接输出整理后的正文，不要写“整理后”之类的前言。',
            '',
            '【原始内容】',
            '{CONTENT}',
        ].join('\n'),
    },
    {
        key: 'compact',
        label: '精简压缩',
        text: [
            '请精简压缩下面的世界书条目「{NAME}」（分类：{CATEGORY}），把篇幅压到原文的 50%～70%。',
            '',
            '要求：',
            '1. 只保留身份、能力、关系、关键经历等可检索事实；',
            '2. 合并重复描述，删除修饰性描写和重复举例；',
            '3. 保留专有名词、数字、称号和别名；',
            '4. 用 Markdown 小标题组织，直接输出正文，不要前言。',
            '',
            '【原始内容】',
            '{CONTENT}',
        ].join('\n'),
    },
    {
        key: 'detail',
        label: '保留细节',
        text: [
            '请整理下面的世界书条目「{NAME}」（分类：{CATEGORY}），重点是保留细节而不是压缩。',
            '',
            '要求：',
            '1. 按「身份 / 外貌 / 能力 / 关系 / 经历」这类结构重新归类，同类信息放一起；',
            '2. 合并重复表述，但不要删除任何独特设定、数字、称号、伏笔；',
            '3. 如果同一条目里有互相矛盾的描述，保留更具体的那一条；',
            '4. 直接输出整理后的正文，不要前言和解释。',
            '',
            '【原始内容】',
            '{CONTENT}',
        ].join('\n'),
    },
];

export function defaultOrganizePrompt() {
    return ORGANIZE_PROMPT_PRESETS[0].text;
}

/** 把 {CONTENT} / {NAME} / {CATEGORY} 替换进整理提示词 */
export function buildOrganizePrompt(template, entry) {
    const tpl = String(template || '').trim() || defaultOrganizePrompt();
    const content = normalizeContent(entry?.content);
    const filled = tpl.includes('{CONTENT}')
        ? tpl.split('{CONTENT}').join(content)
        : `${tpl}\n\n【原始内容】\n${content}`;
    return filled
        .split('{NAME}').join(normalizeEntryName(entry?.name))
        .split('{CATEGORY}').join(String(entry?.categoryLabel || entry?.category || ''));
}

const ERROR_RESPONSE_PATTERNS = [
    /proxy queue error/i,
    /too many concurrent requests/i,
    /another request in the queue/i,
    /your ip or user token/i,
    /resource[_\s-]?exhausted/i,
    /rate limit(?:ed)?/i,
    /\b429\b/,
    /overloaded/i,
    /temporarily unavailable/i,
    /service unavailable/i,
    /bad gateway/i,
    /internal server error/i,
    /请求过于频繁/,
    /请求太频繁/,
    /限流/,
    /请稍后重试/,
];

/** 模型有时会把限流 / 排队提示当正文返回，这种结果不能覆盖原条目 */
export function isOrganizeErrorResponse(text) {
    const value = String(text || '').trim();
    if (!value || value.length > 2000) return false;
    return ERROR_RESPONSE_PATTERNS.some(pattern => pattern.test(value));
}

function extractJsonContent(text) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return '';
    try {
        const parsed = JSON.parse(text.slice(start, end + 1));
        const content = parsed?.内容 ?? parsed?.content ?? parsed?.text;
        return typeof content === 'string' ? content.trim() : '';
    } catch {
        return '';
    }
}

/**
 * 解析 AI 整理结果：允许纯文本、代码块、{"内容": "..."} 三种形状。
 * 空结果、限流提示、过短结果一律抛错，调用方据此保留原条目。
 */
export function parseOrganizeResponse(text) {
    let output = String(text ?? '').trim();
    if (!output) throw new Error('模型返回了空内容');
    if (isOrganizeErrorResponse(output)) {
        throw new Error('模型返回了限流或排队提示，已保留原条目内容');
    }
    const fromJson = extractJsonContent(output);
    if (fromJson) output = fromJson;
    else output = cleanModelOutput(output);
    if (/请(?:整理|精简压缩)下面的世界书条目/.test(output)) {
        throw new Error('模型返回了提示词复述，已保留原条目内容');
    }
    output = output.replace(/^(?:整理后的内容|整理结果|结果|以下是整理后的内容)[:：]\s*/i, '').trim();
    if (countChars(output) < 2) throw new Error('模型返回的整理结果过短，已保留原条目内容');
    return output;
}

/* ------------------------------------------------------------------ */
/* AI 查重复核                                                         */
/* ------------------------------------------------------------------ */

export const DUPLICATE_JUDGE_SYSTEM_PROMPT = [
    '你是中文小说世界书的条目去重助手。',
    '你会收到同一分类下的若干条目，需要判断它们是否指同一个对象。',
    '只输出严格 JSON，不要输出解释、代码块或 JSON 以外的任何文字。',
].join('\n');

/** 构造一组重复条目的复核提示词 */
export function buildDuplicateJudgePrompt(group) {
    const entries = (group?.entries || []).slice(0, DUPLICATE_JUDGE_LIMIT);
    const categoryLabel = String(group?.categoryLabel || '条目');
    const blocks = entries.map((entry, index) => {
        const keywords = Array.isArray(entry.keywords) ? entry.keywords.slice(0, 8).join('、') : '';
        const content = String(entry.content || '').replace(/\s+/g, ' ').slice(0, 300);
        return [
            `条目 ${index + 1}`,
            `名称：${entry.name || ''}`,
            `关键词：${keywords || '无'}`,
            `内容摘要：${content}${content.length >= 300 ? '…' : ''}`,
        ].join('\n');
    });
    return [
        `请判断下面这些「${categoryLabel}」条目是否指同一个对象。`,
        '',
        blocks.join('\n\n'),
        '',
        '判断要求：',
        '1. 全名、简称、别名、称号、代号可能指向同一对象；',
        '2. 即使名称相似，如果身份、经历等核心特征明显不同，也要判定为不同；',
        '3. 如果相同，从给出的条目名里选一个最常用、最完整的作为合并后的名称；',
        '4. 只输出 JSON，不要解释。',
        '',
        '输出格式：',
        '{"same": true, "mainName": "合并后的名称", "reason": "一句话依据"}',
    ].join('\n');
}

function normalizeSameFlag(value) {
    if (value === true || value === 1) return true;
    if (value === false || value === 0) return false;
    const text = String(value ?? '').trim().toLowerCase();
    if (['true', 'yes', 'y', 'same', '同一', '相同', '是'].includes(text)) return true;
    if (['false', 'no', 'n', 'different', '不同'].includes(text)) return false;
    return text.includes('同一') || text.includes('相同') || text.includes('same');
}

/**
 * 解析查重复核结果：{"same":true,"mainName":"...","reason":"..."}。
 * 无法解析时返回 null，界面会显示「无法判断」，不会自动合并。
 */
export function parseDuplicateJudgement(text) {
    const raw = cleanModelOutput(String(text ?? ''));
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    let parsed = null;
    if (start !== -1 && end > start) {
        try {
            parsed = JSON.parse(raw.slice(start, end + 1));
        } catch {
            parsed = null;
        }
    }
    if (!parsed || typeof parsed !== 'object') return null;
    const sameRaw = parsed.same ?? parsed.isSame ?? parsed.isSamePerson ?? parsed.samePerson ?? parsed.result;
    if (sameRaw === undefined) return null;
    const same = normalizeSameFlag(sameRaw);
    const mainName = normalizeEntryName(parsed.mainName ?? parsed.primaryName ?? parsed.keepName ?? parsed.name);
    return {
        same,
        mainName: same ? mainName : '',
        reason: String(parsed.reason ?? parsed.explanation ?? parsed.note ?? '').slice(0, 160),
    };
}
