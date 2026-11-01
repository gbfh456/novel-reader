/**
 * 小说阅读器 - 文风适配
 *
 * 这里不再生成整份预设。酒馆里已经有一份作者自己选用的对话补全预设，
 * 插件只做三件事：
 *   1. 读出「当前选用」的那份预设，找出里面的文风条目（含自定义位）；
 *   2. 分析这条目的排版：包裹标签、小节标题、条目符号、缩进、篇幅、角色；
 *   3. 用当前小说的原文样本写出「怎么写」，严格套回同一种排版，交给用户复制进预设。
 *
 * 因为每次生成都从酒馆实时读取预设，换了预设，文风格式自然跟着换；
 * 生成结果里记下预设名与条目名，UI 便能判断结果是不是已经过期。
 *
 * 本模块不接触 DOM / 网络，所有函数都能在 Node 里直接测。
 */

import { countChars, trimToLimit } from './util.js';

/** 默认文风样本长度（字符） */
export const STYLE_SAMPLE_CHARS = 1500;

/** 生成文风时的输出上限（token）；实际预算按目标条目长度折算 */
export const STYLE_OUTPUT_TOKEN_LIMIT = 9000;

/** 名字带这些词，且内容不是空的，才算候选文风条目 */
const STYLE_KEYWORD_RE = /文风|文笔|行文|写作风格|风格|style|writing/i;
/** 预设留给用户自己填的位置 */
const CUSTOM_SLOT_RE = /自定义|自行填入|自己填|自己改|手填|待填|🔧/;
/** 这些名字多半是分隔条 / 使用说明，不该当格式样本 */
const GUIDE_NAME_RE = /指导|说明|目录|导航|开始|结束|分隔|切换|开关/;
/** 只写了占位话术的条目 */
const PLACEHOLDER_RE = /^(?:标签和内容自己改改就可以了|自行填入|留空|待补充|待填写|无|（空）)$/;
/** 整段只有一对括号（（放文风）（在此填写）……） */
const PLACEHOLDER_WRAP_RE = /^[（(][^（）()]{0,16}[）)]$/;
/** 酒馆里用 {{// … }} 写的注释，不是正文 */
const NOTE_COMMENT_RE = /^\{\{\s*\/\//;

/* ------------------------------------------------------------------ */
/* 一、原文样本                                                        */
/* ------------------------------------------------------------------ */

/**
 * 从原文里取一段干净、可用的文风样本。
 * 去掉开头的章节标题，压缩空行，在句末/段末安全截断。
 * @param {string} text
 * @param {number} [maxChars]
 * @returns {string}
 */
export function extractStyleSample(text, maxChars = STYLE_SAMPLE_CHARS) {
    const limit = Math.max(200, Math.floor(Number(maxChars) || STYLE_SAMPLE_CHARS));
    let clean = String(text || '')
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    if (!clean) return '';

    // 去掉样本开头单独成行的章节标题，避免模型模仿标题格式
    clean = clean.replace(/^第[一二三四五六七八九十百千0-9]+[章节回卷][^\n]{0,40}\n+/, '').trim();
    clean = clean.replace(/^(?:序章|楔子|番外[一二三四五六七八九十0-9]*|Chapter\s+\d+)[^\n]{0,40}\n+/i, '').trim();

    if (countChars(clean) > limit) clean = trimToLimit(clean, limit);
    return clean;
}

/** 引号里的内容通常是对白，人称判断要先把它们剔掉 */
const QUOTED_RE = /“[^”]*”|"[^"]*"|「[^」]*」|『[^』]*』|（[^）]*）|\([^)]*\)/g;

/**
 * 从文风样本里猜原文用的是第几人称。
 * 只数叙述部分的人称代词：对白里的「我 / 你」不计，否则任何小说都会被判成第一人称。
 *
 * @param {string} text
 * @returns {'first'|'second'|'third'|null} 猜不出来时返回 null，交给调用方兜底
 */
export function detectPov(text) {
    const narration = String(text || '').replace(QUOTED_RE, ' ');
    const tally = (pattern) => (narration.match(pattern) || []).length;
    const first = tally(/我/g) + tally(/咱/g);
    const second = tally(/你/g) + tally(/您/g);
    const third = tally(/他/g) + tally(/她/g);

    const total = first + second + third;
    if (total < 5) return null;

    // 第二人称：叙述里几乎每句都有「你／您」，且明显多于「我」
    if (second >= 4 && second >= first * 1.1) return 'second';
    // 第一人称：叙述主语是「我」，多于「你」
    if (first >= 4 && first > second) return 'first';
    // 第三人称：叙述里主要是「他／她」，第一人称只在零星回忆里出现
    if (third >= 4 && third > first) return 'third';
    return null;
}

/** 人称的中文说明，给提示词和界面用 */
export function povLabel(pov) {
    return {
        first: '第一人称',
        second: '第二人称',
        third: '第三人称',
    }[pov] || '未判断';
}

/**
 * 从原文样本里量出可验证的硬指标，交给提示词校准。
 * 这不是文风分析本身，只是防止模型只写「文笔细腻」这类空话。
 *
 * @param {string} text
 * @returns {{chars:number, paragraphs:number, sentences:number, avgParagraphChars:number, avgSentenceChars:number, dialogueRatio:number, dashes:number, ellipses:number, semicolons:number}|null}
 */
export function analyzeSampleStyle(text) {
    const clean = String(text || '').replace(/\r\n?/g, '\n').trim();
    if (!clean) return null;

    const chars = countChars(clean);
    const paragraphs = clean.split(/\n{2,}/).map(part => part.trim()).filter(Boolean);
    const sentences = clean.split(/[。！？!?…]+/).map(part => part.trim()).filter(Boolean);
    const paragraphChars = paragraphs.reduce((sum, part) => sum + countChars(part), 0);

    let dialogueChars = 0;
    for (const match of clean.matchAll(new RegExp(QUOTED_RE.source, 'g'))) {
        dialogueChars += countChars(match[0]);
    }

    return {
        chars,
        paragraphs: paragraphs.length,
        sentences: sentences.length,
        avgParagraphChars: paragraphs.length ? Math.round(paragraphChars / paragraphs.length) : 0,
        avgSentenceChars: sentences.length ? Math.round(chars / sentences.length) : 0,
        dialogueRatio: chars ? Math.round((dialogueChars / chars) * 100) : 0,
        dashes: (clean.match(/—{1,2}/g) || []).length,
        ellipses: (clean.match(/……|\.{3,}/g) || []).length,
        semicolons: (clean.match(/[；;]/g) || []).length,
    };
}

/* ------------------------------------------------------------------ */
/* 二、预设里的文风条目                                                */
/* ------------------------------------------------------------------ */

/** 去掉名字开头的 emoji / 符号，用来判断「文风」是不是标题词 */
function stripNameDecor(name) {
    return String(name || '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
}

/** 这条提示词是不是文风条目（名字带文风 / 风格，或带自定义位标记） */
export function isStyleEntry(entry) {
    const name = String(entry?.name || '');
    const identifier = String(entry?.identifier || '');
    return STYLE_KEYWORD_RE.test(`${name} ${identifier}`) || CUSTOM_SLOT_RE.test(name);
}

/** 预设留给用户自己填的位置 */
export function isCustomStyleSlot(entry) {
    return CUSTOM_SLOT_RE.test(String(entry?.name || ''));
}

/**
 * 这条内容能不能当文风模板用：
 * 空、只有开标签 / 闭标签、只有占位话术、只有 {{// 注释 }} 的都算「占位」，不能拿来分析格式。
 *
 * @param {string} content
 * @returns {boolean}
 */
export function isUsableStyleContent(content) {
    const text = String(content || '').trim();
    if (!text) return false;
    if (NOTE_COMMENT_RE.test(text)) return false;
    const plain = text.replace(/<\/?[^>\n]+>/g, '').trim();
    if (!plain) return false;
    if (PLACEHOLDER_RE.test(plain)) return false;
    if (PLACEHOLDER_WRAP_RE.test(plain)) return false;
    // 剥掉标签后不到 8 个字，撑不起一种写法
    return countChars(plain) >= 8;
}

/** 正文为空或只有占位话术（isUsableStyleContent 的反面） */
export function isEmptyStyleContent(content) {
    return !isUsableStyleContent(content);
}

/**
 * 给文风条目打分，分数越高越像「这份预设真正在用的文风」。
 * 只看名字与篇幅，不看内容措辞，避免把「文风说明」当成文风本身。
 * @param {object} entry
 * @returns {number}
 */
export function scoreStyleEntry(entry) {
    const rawName = String(entry?.name || '');
    const name = stripNameDecor(rawName);
    if (!name) return 0;
    let score = 0;

    const index = name.indexOf('文风');
    if (index === 0) score += 4;
    else if (index > 0 && index <= 6) score += 3;
    else if (index > 0) score += 2;
    else if (/文笔|行文|写作风格|风格/.test(name)) score += 1;
    else if (/style|writing/i.test(name)) score += 2;

    if (CUSTOM_SLOT_RE.test(rawName)) score += 1;
    if (countChars(entry?.content) >= 200) score += 1;
    if (GUIDE_NAME_RE.test(name)) score -= 2;
    if (!isUsableStyleContent(entry?.content)) score -= 1;
    return score;
}

/**
 * 把预设里的条目分成界面要用的几组，全部按预设顺序排列。
 * @param {object} preset readSelectedChatPreset() 的结果
 * @returns {{style: object[], enabledStyle: object[], custom: object[], empty: object[], rest: object[]}}
 */
export function groupStyleEntries(preset) {
    const entries = (Array.isArray(preset?.prompts) ? preset.prompts : [])
        .filter(entry => entry && entry.identifier)
        .slice()
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    const style = entries.filter(entry => isStyleEntry(entry) && isUsableStyleContent(entry.content));
    const empty = entries.filter(entry => isStyleEntry(entry) && !isUsableStyleContent(entry.content));
    const custom = style.filter(isCustomStyleSlot);
    const enabledStyle = style.filter(entry => entry.enabled);
    const styleIds = new Set([...style, ...empty].map(entry => entry.identifier));
    const rest = entries.filter(entry => !styleIds.has(entry.identifier) && String(entry.content || '').trim());
    return { style, enabledStyle, custom, empty, rest };
}

/**
 * 默认选哪一条：先看已启用且像文风的，再退到「名字像文风」的，最后退到第一个有内容的条目。
 * @param {object} preset
 * @returns {object|null}
 */
export function defaultStyleEntry(preset) {
    const { style, empty, enabledStyle } = groupStyleEntries(preset);
    // 带包裹标签的空自定义位也算候选：预设留这个位置就是让人填的
    const slots = empty.filter(entry => analyzeStyleFormat(entry.content).wrapper || isCustomStyleSlot(entry));
    const ranked = [...style, ...slots].sort((a, b) => {
        const diff = scoreStyleEntry(b) - scoreStyleEntry(a);
        return diff !== 0 ? diff : (a.order ?? 0) - (b.order ?? 0);
    });
    const positive = ranked.filter(entry => scoreStyleEntry(entry) > 0);

    // 名字里没有「文风」的条目一个都不猜：写错位置比不写更糟，交给用户在界面上手选
    return positive.find(entry => entry.enabled)
        || positive[0]
        || enabledStyle[0]
        || style[0]
        || null;
}

/* ------------------------------------------------------------------ */
/* 三、格式分析                                                        */
/* ------------------------------------------------------------------ */

/** {{setvar::name::…}} 包裹 */
const SETVAR_WRAPPER_RE = /^\{\{setvar::([^:\n]+)::([\s\S]*)\}\}$/;
/** <标签>…</标签> 包裹，标签可以是中文 */
const TAG_WRAPPER_RE = /^<([A-Za-z_\u3400-\u9fff][\w\u3400-\u9fff·-]*)(?:\s[^>\n]*)?>([\s\S]*)<\/\1>$/;

function detectWrapper(text) {
    const trimmed = String(text || '').trim();
    const setvar = trimmed.match(SETVAR_WRAPPER_RE);
    if (setvar) {
        return {
            kind: 'setvar',
            name: setvar[1].trim(),
            inner: setvar[2],
            open: `{{setvar::${setvar[1]}::`,
            close: '}}',
            label: `{{setvar::${setvar[1]}:: … }}`,
        };
    }
    const tag = trimmed.match(TAG_WRAPPER_RE);
    if (tag) {
        return {
            kind: 'tag',
            name: tag[1],
            inner: tag[2],
            open: `<${tag[1]}>`,
            close: `</${tag[1]}>`,
            label: `<${tag[1]}> … </${tag[1]}>`,
        };
    }
    return null;
}

/** 是不是一行小节标题（Markdown / 【】/ 一、/ 1.） */
function headingOf(line) {
    const trimmed = String(line || '').trim();
    if (!trimmed) return null;
    const markdown = trimmed.match(/^(#{1,6})\s+\S/);
    if (markdown) return { level: markdown[1].length, text: trimmed, kind: 'markdown' };
    if (/^【[^】\n]{1,50}】$/.test(trimmed)) return { level: 1, text: trimmed, kind: 'bracket' };
    if (/^[一二三四五六七八九十]+、\s*\S{1,40}$/.test(trimmed)) return { level: 1, text: trimmed, kind: 'enum' };
    if (/^\d+[.、]\s*\S{1,40}$/.test(trimmed)) return { level: 2, text: trimmed, kind: 'number' };
    return null;
}

/**
 * 分析一条文风条目的排版。
 *
 * @param {string} content 条目正文
 * @param {string} [role] system / user / assistant
 * @returns {object} 格式描述（可直接序列化，也能交给提示词）
 */
export function analyzeStyleFormat(content, role = 'system') {
    const raw = String(content || '').replace(/\r\n?/g, '\n').trim();
    const wrapper = detectWrapper(raw);
    const body = wrapper ? wrapper.inner : raw;

    const headings = [];
    const bullets = new Map();
    let bulletIndent = null;
    let labelLines = 0;
    const labels = [];
    let colonCjk = 0;
    let colonAscii = 0;
    let lineCount = 0;
    let bold = false;
    let example = false;
    let firstContentLine = '';

    const lines = body.split('\n');
    for (const line of lines) {
        if (!line.trim()) continue;
        lineCount++;
        if (!firstContentLine) firstContentLine = line.trim();
        if (!bold && /\*\*[^*\n]+\*\*/.test(line)) bold = true;
        if (!example && /(?:正确示例|错误示例|示例|Example|例如|反例|病句)/i.test(line)) example = true;

        const heading = headingOf(line);
        if (heading) {
            headings.push({ ...heading, indent: line.match(/^\s*/)[0].length });
            continue;
        }

        const bullet = line.match(/^(\s*)([-*·•+])\s+\S/);
        if (bullet) {
            const mark = bullet[2];
            bullets.set(mark, (bullets.get(mark) || 0) + 1);
            if (bulletIndent === null) bulletIndent = bullet[1].length;
            continue;
        }

        // 允许「WRITING STYLE: …」这种带空格的英文标签
        const label = line.match(/^(\s*)([^\s：:][^\n：:]{0,24}?)([：:])\s*\S/);
        if (label) {
            labelLines++;
            const labelName = label[2].trim();
            if (labelName && labels.length < 6 && !labels.includes(labelName)) labels.push(labelName);
            if (label[3] === '：') colonCjk++;
            else colonAscii++;
        }
    }

    let bullet = null;
    if (bullets.size) {
        const [mark] = [...bullets.entries()].sort((a, b) => b[1] - a[1])[0];
        bullet = { mark, indent: bulletIndent || 0 };
    }
    const bulletCount = [...bullets.values()].reduce((sum, count) => sum + count, 0);

    return {
        raw,
        wrapper,
        body,
        role,
        headings,
        bullet,
        bulletCount,
        labelLines,
        labels,
        colon: colonCjk >= colonAscii ? '：' : ':',
        bold,
        example,
        lineCount,
        charCount: countChars(raw),
        empty: !body.trim(),
        firstLine: firstContentLine,
    };
}

/** 这条格式里有没有可循的结构，还是只有一句占位话 */
export function hasStyleStructure(spec) {
    if (!spec) return false;
    return spec.headings.length > 0
        || Boolean(spec.bullet)
        || spec.labelLines >= 2
        || (!spec.empty && spec.lineCount >= 3);
}

/** 包裹标签的可读写法 */
export function wrapperLabel(wrapper) {
    return wrapper ? wrapper.label : '（无）';
}

/** 一句话概括格式，放在界面上 */
export function describeStyleFormat(spec) {
    if (!spec) return '还没有读到格式';
    const parts = [];
    parts.push(`包裹：${wrapperLabel(spec.wrapper)}`);
    if (spec.headings.length) {
        const names = spec.headings.slice(0, 3).map(heading => heading.text).join('、');
        parts.push(`小节 ${spec.headings.length} 个（${names}${spec.headings.length > 3 ? '…' : ''}）`);
    }
    if (spec.bullet) parts.push(`条目以「${spec.bullet.mark}」开头`);
    if (spec.labelLines) parts.push(`${spec.labelLines} 处${spec.colon}标签`);
    parts.push(`原长 ${spec.charCount} 字`);
    parts.push(spec.role);
    return parts.join(' · ');
}

/** 格式细节，界面卡片里逐行显示 */
export function styleFormatLines(spec) {
    if (!spec) return [];
    const lines = [];
    lines.push(`包裹标签：${wrapperLabel(spec.wrapper)}`);
    if (spec.headings.length) {
        lines.push(`小节标题（必须原样保留）：${spec.headings.map(heading => heading.text).join(' ｜ ')}`);
    } else {
        lines.push('小节标题：无（整段平铺）');
    }
    lines.push(spec.bullet
        ? `条目符号：每行以「${spec.bullet.mark}」开头，缩进 ${spec.bullet.indent} 格`
        : '条目符号：无（用句子或小节成段）');
    if (spec.labelLines) {
        const names = spec.labels?.length ? `（${spec.labels.join('、')}）` : '';
        lines.push(`标签行：${spec.labelLines} 处「标签${spec.colon}内容」${names}`);
    }
    lines.push(`其它：${spec.bold ? '有加粗' : '无加粗'} · ${spec.example ? '带示例段' : '无示例段'} · ${spec.lineCount} 行`);
    lines.push(`篇幅参考：${spec.charCount} 字 · 角色：${spec.role}`);
    return lines;
}

/**
 * 生成「只保留排版」的骨架：保留包裹标签、小节标题、标签名和列表符号，
 * 其余旧文风正文一律换成占位符。这样模型能看到格式，但不会照抄预设里的旧文风。
 *
 * @param {object} spec analyzeStyleFormat() 的结果
 * @returns {string}
 */
export function buildStyleSkeleton(spec) {
    if (!spec) return '';
    const lines = [];
    const wrapper = spec.wrapper;
    if (wrapper) lines.push(wrapper.open);

    const bulletMark = spec.bullet?.mark || '';
    const indent = ' '.repeat(spec.bullet?.indent || 0);
    const headings = spec.headings || [];
    if (headings.length) {
        const bulletTotal = Math.max(spec.bulletCount || 0, headings.length);
        const perHeading = bulletMark
            ? Math.max(1, Math.min(4, Math.round(bulletTotal / headings.length)))
            : 0;
        for (const heading of headings) {
            lines.push(`${' '.repeat(heading.indent || 0)}${heading.text}`);
            if (bulletMark) {
                for (let index = 0; index < perHeading; index++) lines.push(`${indent}${bulletMark} …`);
            } else if (spec.labelLines && spec.labels?.length) {
                for (const label of spec.labels) lines.push(`${label}${spec.colon} …`);
            }
            lines.push('');
        }
    } else if (bulletMark) {
        const rows = Math.max(2, Math.min(8, spec.bulletCount || 4));
        for (let index = 0; index < rows; index++) lines.push(`${indent}${bulletMark} …`);
    } else if (spec.labels?.length) {
        for (const label of spec.labels) lines.push(`${label}${spec.colon} …`);
    } else if (!spec.empty) {
        const rows = Math.max(2, Math.min(6, spec.lineCount || 3));
        for (let index = 0; index < rows; index++) lines.push('…');
    }

    if (wrapper) lines.push(wrapper.close);
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/* ------------------------------------------------------------------ */
/* 四、决定「按哪条写、写到哪条」                                      */
/* ------------------------------------------------------------------ */

/**
 * 选中的条目如果只是自定义空位（只有包裹标签），结构参考自动退到预设里像文风、
 * 已启用、篇幅够长的那一条；包裹标签仍用选中条目的，保证复制回去格式对得上。
 *
 * @param {object} preset readSelectedChatPreset() 的结果
 * @param {string} [selectedId]
 * @returns {{entry:object, structureRef:object, spec:object, entrySpec:object, targetChars:number, borrowedStructure:boolean}|null}
 */
export function buildStylePlan(preset, selectedId = '') {
    const entries = (Array.isArray(preset?.prompts) ? preset.prompts : []).filter(entry => entry?.identifier);
    if (!entries.length) return null;

    const { style } = groupStyleEntries(preset);
    const ranked = style
        .filter(entry => hasStyleStructure(analyzeStyleFormat(entry.content)))
        .sort((a, b) => {
            const diff = scoreStyleEntry(b) - scoreStyleEntry(a);
            return diff !== 0 ? diff : (a.order ?? 0) - (b.order ?? 0);
        });
    const fallback = ranked.find(entry => entry.enabled) || ranked[0] || null;

    const pinned = selectedId ? entries.find(entry => entry.identifier === selectedId) : null;
    const entry = pinned || defaultStyleEntry(preset);
    if (!entry) return null;

    const entrySpec = analyzeStyleFormat(entry.content, entry.role);
    const borrowedStructure = !hasStyleStructure(entrySpec)
        && Boolean(fallback)
        && fallback.identifier !== entry.identifier;
    const structureRef = borrowedStructure ? fallback : entry;
    const baseSpec = borrowedStructure ? analyzeStyleFormat(structureRef.content, structureRef.role) : entrySpec;

    const spec = {
        ...baseSpec,
        // 包裹标签只认目标条目自己的：选了空白位而它没有包裹时，不要凭空套上参考条目的标签
        wrapper: entrySpec.wrapper || null,
        role: entry.role || baseSpec.role,
    };

    const targetChars = baseSpec.charCount >= 80 && !baseSpec.empty ? baseSpec.charCount : 900;
    return { entry, structureRef, spec, entrySpec, targetChars, borrowedStructure };
}

/* ------------------------------------------------------------------ */
/* 五、提示词                                                          */
/* ------------------------------------------------------------------ */

export const STYLE_ADAPT_SYSTEM_PROMPT = `你是中文小说的文风分析师，同时熟悉酒馆（SillyTavern）预设的写法。用户会给你一段小说原文，以及一份预设文风条目的排版骨架。你的任务是：先从原文里提炼出这本书真实的写法，再把它们套进骨架的排版里，写出一份适用于这部小说的新文风。

只输出条目正文，不要分析过程，不要寒暄，不要 Markdown 代码块，不要用 --- 分隔。

硬性要求：
1. 包裹标签必须原样保留：{{setvar::...:: … }} 或 <标签>…</标签> 的标签名、开闭符号、换行位置都不许改。
2. 小节标题必须原样保留：文字、顺序、层级、编号都不许改；小节内部沿用原来的条目符号（- / * / ·）与缩进。
3. 只写「怎么写」：句长与断句、段落节奏、视角与感官、意象来源、标点习惯、情绪怎么外化、对白怎么处理、转场怎么切、明确禁止的写法。不写剧情、人物名、世界观设定。
4. 每一条都要能被检验，例如「一段一到两句」「情绪写手和呼吸，不写情绪名」；不要「文笔优美」「富有张力」这类空话。
5. 不要沿用排版骨架里的旧文风内容与措辞——骨架里的「…」只是占位符。你要写的是本次原文样本的写法；只有排版结构照抄。
6. 不要提到「样本」「原文」「上面」「预设」「条目」「本任务」。
7. 篇幅与原条目相当（约 ±25%），条目数量也可以增减，但层级与标题不能变。
8. 条目里至少 4 条（骨架条目不足 4 条时则每条）必须是从本次原文样本得出的具体写法（句长、断句、标点、对白、感官、意象、转场等），不能只写通用文风评价。
9. 输出时把所有「…」占位符替换成实际写法，不能保留省略号。`;

/**
 * 拼出生成文风的 user 消息。
 *
 * @param {object} input
 * @param {string} input.novelTitle
 * @param {string} input.sample 原文样本
 * @param {'first'|'second'|'third'|null} [input.pov]
 * @param {string} [input.presetName]
 * @param {object} input.plan buildStylePlan() 的结果
 * @param {string} [input.instruction] 这次想要的调整
 * @returns {string}
 */
export function buildStyleAdaptPrompt({
    novelTitle = '小说',
    sample = '',
    pov = null,
    presetName = '',
    plan,
    instruction = '',
} = {}) {
    const spec = plan?.spec || analyzeStyleFormat('');
    const target = plan?.entry || null;
    const ref = plan?.structureRef || target;
    const targetChars = Math.max(80, Math.round(plan?.targetChars || spec.charCount || 900));

    const parts = [];
    parts.push(`【小说】《${String(novelTitle || '小说').trim() || '小说'}》`);
    parts.push(`【原文人称】${povLabel(pov)}（叙述部分的人称，输出里不要写人称说明，只按它来定视角要求）`);
    parts.push('【原文样本】（只用于分析写法，不要复述剧情）');
    parts.push(String(sample || '').trim() || '（没有取到样本：只按下面的格式要求写通用规则，不要编造具体句子。）');
    const stats = analyzeSampleStyle(sample);
    if (stats) {
        parts.push('');
        parts.push('【原文文风观察】（从样本量出的硬指标，用来校准；不要写成统计报告）');
        parts.push(`- 样本 ${stats.chars} 字，${stats.paragraphs} 段，平均段长 ${stats.avgParagraphChars} 字，平均句长约 ${stats.avgSentenceChars} 字。`);
        parts.push(`- 对白约占 ${stats.dialogueRatio}%；破折号 ${stats.dashes} 次，省略号 ${stats.ellipses} 次，分号 ${stats.semicolons} 次。`);
    }
    parts.push('');

    parts.push(`【酒馆预设】《${String(presetName || '当前预设').trim() || '当前预设'}》`);
    parts.push(`【要写入的条目】「${target?.name || '文风条目'}」（role: ${spec.role || 'system'}，原长 ${countChars(target?.content)} 字）`);
    if (plan?.borrowedStructure && ref && ref.identifier !== target?.identifier) {
        parts.push(`【排版参考】这一条还是空的，按同一预设里「${ref.name}」的排版写，但包裹标签用目标条目自己的。`);
    }
    parts.push('');

    const skeleton = buildStyleSkeleton(spec);
    parts.push('【格式骨架】（只给排版；「…」处要换成从原文提炼的写法，不要保留占位符）');
    parts.push('<<<');
    parts.push(skeleton || '（空）');
    parts.push('>>>');
    parts.push('');

    parts.push('【排版要求】');
    parts.push(`1. 包裹标签：${wrapperLabel(spec.wrapper)}——原样保留，不许改标签名。`);
    if (spec.headings.length) {
        parts.push(`2. 小节标题：${spec.headings.map(heading => heading.text).join(' ｜ ')}——文字、顺序、层级都不许改。`);
    } else {
        parts.push('2. 小节标题：原条目没有小节，就别自己加标题。');
    }
    parts.push(spec.bullet
        ? `3. 条目符号：每行以「${spec.bullet.mark}」开头，缩进 ${spec.bullet.indent} 格，与格式骨架一致。`
        : '3. 条目符号：原条目没有用列表符号，就别改成列表。');
    parts.push(spec.labelLines
        ? `4. 标签行：保留${(spec.labels || []).map(name => `「${name}」`).join('、') || '标签'}的写法，标签文字不变，冒号后面换成这部小说的内容。`
        : '4. 标签行：原条目没有标签行，就不要新造。');
    parts.push(`5. 篇幅：约 ${targetChars} 字（±25%）；行数与原来接近；角色是 ${spec.role}。`);
    parts.push('6. 不要输出包裹标签之外的解释、标题或分隔线。');

    const extra = String(instruction || '').trim();
    if (extra) {
        parts.push('');
        parts.push('【这次想要的调整】');
        parts.push(extra);
    }

    parts.push('');
    parts.push('现在直接输出整段新的条目内容（从包裹标签开始，到包裹标签结束）。');
    return parts.join('\n');
}

/* ------------------------------------------------------------------ */
/* 六、清洗与校验                                                      */
/* ------------------------------------------------------------------ */

/**
 * 清洗模型返回的条目正文：去代码块、去开头客套。
 * @param {string} text
 * @returns {string}
 */
export function parseStyleAdaptOutput(text) {
    let clean = String(text || '')
        .replace(/\r\n?/g, '\n')
        .replace(/```[a-zA-Z]*\s*/g, '')
        .replace(/```/g, '')
        .trim();
    clean = clean.replace(/^(?:好的|明白|收到|了解|没问题|以下是|下面是|这是)[^\n]{0,60}[：:]\s*\n+/, '').trim();
    clean = clean.replace(/^<<<\s*\n?/, '').replace(/\n?>>>$/, '').trim();
    return clean;
}

/** 去掉模型自带的包裹标签，交给 fitStyleOutput 重新套 */
function stripWrapper(text) {
    let body = String(text || '').trim();
    const setvar = body.match(SETVAR_WRAPPER_RE);
    if (setvar) return setvar[2].trim();
    const tag = body.match(TAG_WRAPPER_RE);
    if (tag) return tag[2].trim();
    if (body.startsWith('{{setvar::') && body.endsWith('}}')) {
        const inner = body.slice('{{setvar::'.length, -2);
        const separator = inner.indexOf('::');
        if (separator >= 0) return inner.slice(separator + 2).trim();
    }
    return body;
}

/**
 * 把模型输出套回目标条目的包裹标签。
 * 模型漏了标签就补上，多了别的标签就换成目标的。
 *
 * @param {string} text parseStyleAdaptOutput() 的结果
 * @param {object|null} wrapper 目标条目的包裹标签（analysis.wrapper）
 * @returns {string}
 */
export function fitStyleOutput(text, wrapper) {
    const inner = stripWrapper(text).trim();
    if (!wrapper) return inner;
    return `${wrapper.open}\n${inner}\n${wrapper.close}`;
}

/**
 * 检查输出有没有守住格式，返回人话警告。
 *
 * @param {string} text 套好包裹之后的正文
 * @param {object} spec buildStylePlan().spec
 * @returns {{ok:boolean, warnings:string[]}}
 */
export function checkStyleOutput(text, spec) {
    const warnings = [];
    const body = String(text || '').trim();
    if (!body) return { ok: false, warnings: ['模型没有返回内容'] };

    if (spec?.wrapper) {
        if (!body.startsWith(spec.wrapper.open) || !body.endsWith(spec.wrapper.close)) {
            warnings.push(`包裹标签没守住（应为 ${spec.wrapper.label}）`);
        }
    }

    const missing = (spec?.headings || [])
        .filter(heading => !body.includes(heading.text))
        .map(heading => heading.text);
    if (missing.length) {
        warnings.push(`少了 ${missing.length} 个小节：${missing.slice(0, 3).join('、')}${missing.length > 3 ? ' 等' : ''}`);
    }

    if (spec?.bullet) {
        const prefixed = body.split('\n').some(line => line.trim().startsWith(`${spec.bullet.mark} `));
        if (!prefixed) warnings.push(`条目符号不是「${spec.bullet.mark}」`);
    }
    if (/^\s*[-*·•+]\s*…\s*$/m.test(body)) {
        warnings.push('还有「- …」占位符没有替换');
    }

    // 太短的条目没法比篇幅：原条目只有一两行时，长短本来就随便
    const baseChars = Number(spec?.charCount) || 0;
    if (baseChars >= 120) {
        const ratio = countChars(body) / baseChars;
        if (ratio < 0.55 || ratio > 1.9) {
            warnings.push(`篇幅和原条目差得多（原 ${baseChars} 字，现在 ${countChars(body)} 字）`);
        }
    }

    return { ok: warnings.length === 0, warnings };
}

/**
 * 生成结果里的说明文字：告诉用户具体粘到哪里、用哪个角色。
 * @param {{presetName?:string, entryName?:string, role?:string}} info
 * @returns {string}
 */
export function stylePasteHint({ presetName = '', entryName = '', role = 'system' } = {}) {
    const preset = String(presetName || '当前预设').trim();
    const entry = String(entryName || '文风条目').trim();
    return `复制后打开酒馆「扩展 → 提示词管理器」，确认顶部预设是《${preset}》，找到条目「${entry}」，`
        + `把内容整段替换（角色 ${role}）。这一步只改你手里的预设，插件不会代写。`;
}
