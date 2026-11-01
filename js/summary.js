/**
 * 小说阅读器 - 分层总结策略
 *
 * 为什么不能把整本书直接塞给模型？
 *   一本 100 万字的小说约 100 万 token，远超常见 8k/32k/128k 的上下文窗口。
 *
 * 本模块采用 map-reduce（分段总结 -> 多层合并 -> 最终成稿）：
 *   1. 按章节 / 段落切成不超过输入预算的片段；
 *   2. 每个片段单独生成「中间摘要」，并把上一段摘要作为前情提要，保持衔接；
 *   3. 如果中间摘要加起来仍超过上下文，就继续两两/多路合并，直到能一次放下；
 *   4. 最后一轮按用户设置的字数上限生成最终总结，并在超长时自动压缩/句末截断。
 *
 * 所有 token 预算都按「上下文窗口 × 占用比例 - 输出预留」计算，且 token 估算偏保守。
 */

import {
    clamp,
    countChars,
    createAbortError,
    estimateTokens,
    isAbortError,
    sleep,
    trimToLimit,
} from './util.js';
import { computeBudget, getSettings, maxTargetChars, resolveStrategy, STYLE_PRESETS } from './settings.js';

const PROMPT_OVERHEAD_TOKENS = 320;

/** 轻量字符串哈希，用于给分段摘要做缓存键（不需要密码学强度） */
function hashText(text) {
    let hash = 5381;
    const source = String(text || '');
    for (let i = 0; i < source.length; i++) {
        hash = ((hash << 5) + hash + source.charCodeAt(i)) | 0;
    }
    return `${source.length}:${(hash >>> 0).toString(36)}`;
}

/* ------------------------------------------------------------------ */
/* 提示词                                                              */
/* ------------------------------------------------------------------ */

function buildSystemPrompt(styleKey, customStyle, extraInstruction) {
    const style = STYLE_PRESETS[styleKey] || STYLE_PRESETS.plot;
    const directive = styleKey === 'custom'
        ? (customStyle || '按用户要求总结。')
        : style.directive;

    return [
        '你是一位资深的中文小说编辑，擅长在有限篇幅内提炼复杂的长篇剧情。',
        '你的任务是为用户提供忠实、紧凑、可读性强的剧情总结。',
        '',
        '【写作要求】',
        '1. 严格依据原文，不编造原文没有的人物、事件或设定。',
        '2. 按时间顺序组织内容，保留关键人物、核心事件、因果链、冲突转折、重要伏笔与结局。',
        '3. 合并重复信息，删除无关的景物、日常与重复对话，不要逐句复述。',
        '4. 使用简体中文，语言紧凑、信息密度高，避免空泛评价。',
        '5. 只输出总结正文，不要输出“好的”“以下是总结”之类的前言，不要使用代码块。',
        '',
        `【本次风格】${directive}`,
        extraInstruction ? `【用户附加要求】${extraInstruction}` : '',
    ].filter(Boolean).join('\n');
}

function buildMapPrompt({ novelTitle, group, index, total, previousSummary, targetChars, ledger = false, previousChars = 0 }) {
    const previous = previousSummary && previousChars > 0
        ? `\n【前情提要（只用于衔接，不要重复）】\n${trimToLimit(previousSummary, previousChars)}\n`
        : '';

    const task = ledger
        ? [
            `请把本段压缩成一份「剧情事件账本」，总字数不超过 ${targetChars} 字。`,
            '每行一条关键事件，格式：人物/势力｜发生了什么｜结果或影响。',
            '只保留推动主线的行动、冲突、转折、约定、伏笔与结局；',
            '人名、地名、关键物件和数字必须保留；删掉景物、心理、对话原文和文笔评价。',
            '不要写前言、标题或总结性评价，直接输出账本。',
        ]
        : [
            `请写一段约 ${targetChars} 字的剧情摘要。`,
            '要求：按事件发生顺序叙述；保留人物姓名与关键关系；写清事件之间的因果关系；',
            '不要写阅读感受、不要评价文笔、不要复述原文句子。',
            '直接输出摘要正文，不要加标题或前言。',
        ];

    return [
        `【作品】《${novelTitle}》`,
        `【位置】第 ${index + 1} / ${total} 部分 · ${group.label}`,
        previous,
        '【原文】',
        group.text,
        '',
        ...task,
    ].join('\n');
}

function buildReducePrompt({ novelTitle, summaries, targetChars, label, ledger = false }) {
    const task = ledger
        ? [
            `请把上面的账本合并成不超过 ${targetChars} 字的连续账本。`,
            '保持“人物/势力｜事件｜结果”的行格式；按时间排序；合并重复事件；',
            '保留关键人物、因果、转折与伏笔；不要添加原文没有的信息。',
        ]
        : [
            `请把上面的分段摘要合并成一段约 ${targetChars} 字的连续剧情摘要。`,
            '要求：按时间顺序重新组织；去掉重复内容；保留关键人物、事件、因果与转折；',
            '不要简单地把各段拼接起来，也不要添加原文没有的信息。',
            '直接输出摘要正文。',
        ];
    return [
        `【作品】《${novelTitle}》`,
        `【任务】合并以下${ledger ? '事件账本' : '分段摘要'}（${label}）`,
        '',
        ledger ? '【事件账本】' : '【分段摘要】',
        summaries.map((summary, index) => `${index + 1}. ${summary.text}`).join('\n\n'),
        '',
        ...task,
    ].join('\n');
}

function buildFinalPrompt({ novelTitle, summaries, targetChars, scopeLabel, styleKey, missingLabels = [] }) {
    const style = STYLE_PRESETS[styleKey] || STYLE_PRESETS.plot;
    return [
        `【作品】《${novelTitle}》`,
        `【总结范围】${scopeLabel}`,
        `【字数上限】${targetChars} 字（硬性上限，请勿超过）`,
        `【风格】${style.label}`,
        '',
        missingLabels.length
            ? `【缺失分段】${missingLabels.join('；')}\n这些分段因请求失败没有材料，请不要编造其内容，并在总结中自然说明“部分段落缺失”。`
            : '',
        '【已有分段摘要】',
        summaries.map((summary, index) => `${index + 1}. ${summary.text}`).join('\n\n'),
        '',
        '请基于以上材料撰写最终总结。',
        `总字数控制在 ${Math.max(80, Math.floor(targetChars * 0.9))} 字以内，绝对不要超过 ${targetChars} 字。`,
        '可以按“主线脉络 / 关键人物 / 重要转折 / 结局”分小节，但不要为了分节牺牲信息量。',
        '直接输出总结正文，不要写“以下是总结”之类的话。',
    ].join('\n');
}

function buildDirectPrompt({ novelTitle, text, targetChars, scopeLabel, styleKey }) {
    const style = STYLE_PRESETS[styleKey] || STYLE_PRESETS.plot;
    return [
        `【作品】《${novelTitle}》`,
        `【总结范围】${scopeLabel || '全书'}`,
        `【字数上限】${targetChars} 字（硬性上限，请勿超过）`,
        `【风格】${style.label}`,
        '',
        '【原文】',
        text,
        '',
        `请阅读以上原文，写一段不超过 ${targetChars} 字的总结。`,
        '要求：按时间顺序概括主线；保留关键人物、核心事件、因果链、冲突转折与结局；',
        '不要逐句复述，不要写阅读感受，不要添加原文没有的内容。',
        '直接输出总结正文。',
    ].join('\n');
}

function buildCompressPrompt({ novelTitle, text, targetChars }) {
    return [
        `【作品】《${novelTitle}》`,
        `【任务】把下面的总结压缩到不超过 ${targetChars} 字。`,
        '',
        '【原总结】',
        text,
        '',
        '要求：保留主线剧情、关键人物、重要转折与结局；删除重复和次要细节；',
        '不要添加原文没有的内容；直接输出压缩后的正文。',
    ].join('\n');
}

/* ------------------------------------------------------------------ */
/* 计划与切分                                                          */
/* ------------------------------------------------------------------ */

function splitTextToTokenChunks(text, maxTokens) {
    const source = String(text || '').trim();
    if (!source) return [];
    if (estimateTokens(source) <= maxTokens) return [source];

    const paragraphs = source.split(/\n+/).filter(Boolean);
    const chunks = [];
    let buffer = '';
    let bufferTokens = 0;

    const flush = () => {
        if (buffer.trim()) chunks.push(buffer.trim());
        buffer = '';
        bufferTokens = 0;
    };

    const pushSentenceParts = (paragraph) => {
        const sentences = paragraph.split(/(?<=[。！？!?；;])/);
        for (const sentence of sentences) {
            const tokens = estimateTokens(sentence);
            if (tokens > maxTokens) {
                flush();
                const charBudget = Math.max(200, Math.floor((maxTokens / 1.15) * 0.9));
                for (let i = 0; i < sentence.length; i += charBudget) {
                    const piece = sentence.slice(i, i + charBudget).trim();
                    if (piece) chunks.push(piece);
                }
                continue;
            }
            if (bufferTokens + tokens > maxTokens) flush();
            buffer += sentence;
            bufferTokens += tokens;
        }
    };

    for (const paragraph of paragraphs) {
        const trimmed = paragraph.trim();
        if (!trimmed) continue;
        const tokens = estimateTokens(trimmed);
        if (tokens > maxTokens) {
            flush();
            pushSentenceParts(trimmed);
            continue;
        }
        if (bufferTokens + tokens > maxTokens) flush();
        buffer += (buffer ? '\n' : '') + trimmed;
        bufferTokens += tokens;
    }
    flush();
    return chunks.length ? chunks : [source];
}

function makeSegments(units, segmentTokenBudget) {
    const segments = [];
    for (const unit of units) {
        if (unit.tokens <= segmentTokenBudget) {
            segments.push({
                title: unit.title,
                text: unit.text,
                tokens: unit.tokens,
                chars: unit.chars,
                index: unit.index,
                part: 1,
                parts: 1,
            });
            continue;
        }
        const pieces = splitTextToTokenChunks(unit.text, segmentTokenBudget);
        pieces.forEach((piece, partIndex) => {
            const tokens = estimateTokens(piece);
            segments.push({
                title: `${unit.title}（${partIndex + 1}/${pieces.length}）`,
                text: piece,
                tokens,
                chars: countChars(piece),
                index: unit.index,
                part: partIndex + 1,
                parts: pieces.length,
            });
        });
    }
    return segments;
}

function groupSegments(segments, inputBudget) {
    const groups = [];
    let current = { segments: [], tokens: 0, chars: 0 };
    const overheadPerSegment = 40;

    const flush = () => {
        if (current.segments.length === 0) return;
        const first = current.segments[0];
        const last = current.segments[current.segments.length - 1];
        const label = first.title === last.title
            ? first.title
            : `${first.title} ～ ${last.title}`;
        groups.push({
            segments: current.segments,
            tokens: current.tokens,
            chars: current.chars,
            label,
            text: current.segments.map(segment => `【${segment.title}】\n${segment.text}`).join('\n\n'),
        });
        current = { segments: [], tokens: 0, chars: 0 };
    };

    for (const segment of segments) {
        const cost = segment.tokens + estimateTokens(segment.title) + overheadPerSegment;
        if (current.segments.length > 0 && current.tokens + cost > inputBudget) flush();
        current.segments.push(segment);
        current.tokens += cost;
        current.chars += segment.chars;
    }
    flush();
    return groups;
}

function groupSummaries(summaries, inputBudget) {
    const groups = [];
    let current = { summaries: [], tokens: 0 };
    const flush = () => {
        if (!current.summaries.length) return;
        groups.push({
            summaries: current.summaries,
            tokens: current.tokens,
            label: current.summaries.length === 1
                ? current.summaries[0].label
                : `${current.summaries[0].label} ～ ${current.summaries[current.summaries.length - 1].label}`,
        });
        current = { summaries: [], tokens: 0 };
    };
    for (const summary of summaries) {
        const cost = summary.tokens + 40;
        if (current.summaries.length && current.tokens + cost > inputBudget) flush();
        current.summaries.push(summary);
        current.tokens += cost;
    }
    flush();
    return groups;
}

function estimateReduceCalls(nodeCount) {
    let nodes = nodeCount;
    let calls = 0;
    let guard = 0;
    while (nodes > 1 && guard++ < 12) {
        const next = Math.max(1, Math.ceil(nodes / 3));
        calls += next;
        nodes = next;
    }
    return calls;
}

/**
 * 生成总结计划（纯函数，方便 UI 预估和单元测试）。
 * @param {{chapters: {index:number,title:string,text:string}[], targetChars:number, budget: ReturnType<typeof computeBudget>, minMidChars?: number, maxTarget?: number}} params
 */
export function buildPlan({ chapters, targetChars, budget, minMidChars = 180, maxTarget = Infinity, strategy = null }) {
    const units = (chapters || []).map((chapter, position) => {
        const text = String(chapter.text || '');
        return {
            index: chapter.index ?? position,
            title: chapter.title || `第 ${position + 1} 章`,
            text,
            chars: countChars(text),
            tokens: estimateTokens(text),
        };
    });

    const totalTokens = units.reduce((sum, unit) => sum + unit.tokens, 0);
    const totalChars = units.reduce((sum, unit) => sum + unit.chars, 0);
    const requestedTarget = Math.max(80, Math.floor(Number(targetChars) || 800));
    const effectiveTarget = Math.max(
        60,
        Math.min(
            requestedTarget,
            Math.floor(maxTarget),
            Math.max(60, Math.ceil(totalChars * 0.9)),
        ),
    );

    const packRatio = strategy?.packRatio || 0.94;
    const direct = totalTokens + PROMPT_OVERHEAD_TOKENS <= budget.inputBudget * 0.97;
    if (direct) {
        return {
            mode: 'direct',
            units,
            segments: [{
                title: units.map(unit => unit.title).join(' / '),
                text: units.map(unit => `【${unit.title}】\n${unit.text}`).join('\n\n'),
                tokens: totalTokens,
                chars: totalChars,
            }],
            groups: [],
            totalTokens,
            totalChars,
            requestedTarget,
            effectiveTarget,
            estimatedCalls: 1,
            segmentTokenBudget: totalTokens,
            reason: 'all-in-one',
        };
    }

    // 尽量把输入预算用满：段越大，请求数越少，固定提示词与请求开销占比越低。
    const segmentTokenBudget = Math.max(
        300,
        Math.floor((budget.inputBudget - PROMPT_OVERHEAD_TOKENS) * packRatio),
    );
    const segments = makeSegments(units, segmentTokenBudget);
    const groups = groupSegments(segments, Math.max(400, budget.inputBudget - PROMPT_OVERHEAD_TOKENS));
    const estimatedCalls = groups.length + estimateReduceCalls(groups.length) + 1;

    return {
        mode: 'mapreduce',
        units,
        segments,
        groups,
        totalTokens,
        totalChars,
        requestedTarget,
        effectiveTarget,
        estimatedCalls,
        segmentTokenBudget,
        minMidChars,
        reason: 'context-limit',
    };
}

/* ------------------------------------------------------------------ */
/* 模型调用                                                            */
/* ------------------------------------------------------------------ */

function getContext() {
    const context = globalThis.SillyTavern?.getContext?.();
    if (!context) throw new Error('无法获取 SillyTavern 上下文，请刷新页面');
    return context;
}

function normalizeModelResponse(response) {
    if (response == null) return '';
    if (typeof response === 'string') return response;
    if (typeof response === 'object') {
        if (typeof response.content === 'string') return response.content;
        if (typeof response.text === 'string') return response.text;
        if (typeof response.message === 'string') return response.message;
        if (typeof response.response === 'string') return response.response;
    }
    return String(response);
}

async function callModel({ system, user, maxTokens, settings, signal, omitResponseLength = false }) {
    if (signal?.aborted) throw createAbortError();
    const context = getContext();

    if (settings.provider === 'profile' && settings.profileId) {
        const service = context.ConnectionManagerRequestService;
        if (!service?.sendRequest) throw new Error('连接管理不可用，请在设置中改用“当前连接”');
        const result = await service.sendRequest(
            settings.profileId,
            [
                { role: 'system', content: system },
                { role: 'user', content: user },
            ],
            maxTokens,
            { stream: false, extractData: true, signal },
        );
        return normalizeModelResponse(result);
    }

    const api = context.mainApi;
    const prompt = api === 'openai'
        ? [{ role: 'user', content: user }]
        : user;

    const response = await context.generateRaw({
        prompt,
        systemPrompt: system,
        ...(omitResponseLength ? {} : { responseLength: maxTokens }),
        api,
        // 不让 ST 按角色名/用户名误删正文；总结里出现“某人：”很常见。
        trimNames: false,
    });
    return normalizeModelResponse(response);
}

function isFatalApiError(error) {
    const message = String(error?.message || error || '');
    if (/401|403|unauthorized|invalid api key|invalid_api_key|authentication|余额不足|quota/i.test(message)) return true;
    const status = Number(error?.status || error?.httpStatus || 0);
    return [400, 404, 405, 422].includes(status);
}

function isRetryableApiError(error) {
    if (isFatalApiError(error)) return false;
    const message = String(error?.message || error || '').toLowerCase();
    const status = Number(error?.status || error?.httpStatus || 0);
    if ([408, 409, 425, 429, 500, 502, 503, 504, 529].includes(status)) return true;
    if (/\b(408|409|425|429|500|502|503|504|529)\b/.test(message)) return true;
    return /rate limit|resource_exhausted|overloaded|temporarily unavailable|timeout|timed out|econnreset|network|fetch failed|bad gateway|service unavailable|server error|internal server error|no message generated|empty response|no content|超时|网络错误|empty|为空|过短/.test(message);
}

function isEmptyModelError(error) {
    return /no message generated|empty response|no content|模型返回内容为空|为空|过短/i.test(String(error?.message || error || ''));
}

export async function callWithRetry({ system, user, maxTokens, maxTokenLimit = maxTokens, omitResponseLength = false, settings, signal, label, onProgress, stats }) {
    const attempts = clamp(settings.maxAttempts || 3, 1, 5);
    let lastError = null;
    let currentMaxTokens = maxTokens;

    for (let attempt = 1; attempt <= attempts; attempt++) {
        if (signal?.aborted) throw createAbortError();
        onProgress?.({ type: 'call', label, attempt, maxAttempts: attempts });
        try {
            stats.calls += 1;
            const raw = await callModel({
                system,
                user,
                maxTokens: currentMaxTokens,
                settings,
                signal,
                omitResponseLength,
            });
            const text = String(raw || '').trim();
            if (text.length >= 10) return text;
            lastError = new Error('模型返回内容为空或过短');
        } catch (error) {
            if (error?.name === 'AbortError' || isAbortError(error)) throw createAbortError();
            lastError = error;
            if (!isRetryableApiError(error) && !isEmptyModelError(error)) break;
        }

        if (isEmptyModelError(lastError)) {
            // 推理模型/小输出预算时，思考过程可能把 max_tokens 全部吃掉，
            // 最终正文为空。下一次提高输出预算，而不是原样重试。
            const next = Math.min(maxTokenLimit, Math.max(currentMaxTokens + 256, Math.ceil(currentMaxTokens * 1.8)));
            if (next > currentMaxTokens) {
                onProgress?.({
                    type: 'stage',
                    stage: 'retry-empty',
                    text: `${label}未返回正文，增大输出预算到 ${next} tokens 后重试（第 ${attempt + 1}/${attempts} 次）`,
                });
                currentMaxTokens = next;
            }
        }

        if (attempt < attempts) {
            const wait = Math.min(8000, 700 * (2 ** (attempt - 1))) + Math.floor(Math.random() * 300);
            await sleep(wait);
        }
    }

    const rawReason = lastError?.message || '未知错误';
    const reason = isEmptyModelError(lastError)
        ? `模型未返回正文（${rawReason}）`
        : rawReason;
    const error = new Error(`${label}失败：${reason}`);
    error.cause = lastError;
    throw error;
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

/**
 * 执行分层总结。
 * @param {object} options
 * @param {string} options.novelTitle
 * @param {{index:number,title:string,text:string}[]} options.chapters
 * @param {number} options.targetChars
 * @param {string} options.styleKey
 * @param {string} [options.customStyle]
 * @param {string} [options.scopeLabel]
 * @param {AbortSignal} [options.signal]
 * @param {(event: object) => void} [options.onProgress]
 * @param {object} [options.settings]
 */
export async function runSummary(options) {
    const {
        novelTitle,
        chapters,
        targetChars,
        styleKey = 'plot',
        customStyle = '',
        extraInstruction = '',
        scopeLabel = '',
        signal,
        onProgress = () => {},
        settings: providedSettings,
    } = options;

    if (!Array.isArray(chapters) || chapters.length === 0) throw new Error('没有可总结的章节');
    const settings = providedSettings || getSettings();
    const strategy = resolveStrategy(settings);
    const budget = computeBudget(settings);
    const plan = buildPlan({
        chapters,
        targetChars,
        budget,
        minMidChars: strategy.minMidChars,
        maxTarget: maxTargetChars(settings),
        strategy,
    });

    if (signal?.aborted) throw createAbortError();

    const stats = {
        calls: 0,
        mapCalls: 0,
        reduceCalls: 0,
        finalCalls: 1,
        levels: 0,
        inputChars: plan.totalChars,
        outputChars: 0,
        cacheHits: 0,
        successGroups: 0,
        failedGroups: 0,
        concurrency: strategy.concurrency,
        startedAt: Date.now(),
    };

    onProgress({ type: 'plan', plan, budget, stats });
    onProgress({
        type: 'stage',
        stage: plan.mode === 'direct' ? 'direct' : 'map',
        text: plan.mode === 'direct'
            ? `原文约 ${Math.round(plan.totalTokens / 1000)}k token，可一次放入上下文，直接总结`
            : `原文约 ${Math.round(plan.totalTokens / 1000)}k token，超过单次上下文，拆为 ${plan.groups.length} 段分段总结`,
    });

    const system = buildSystemPrompt(styleKey, customStyle, extraInstruction);
    // 分段阶段只需要忠实提取事实，用短提示词能显著减少每次请求的固定开销。
    const compactSystem = [
        '你是一位严谨的中文小说编辑，只依据给定原文提取事实。',
        '按时间顺序记录关键人物、事件、因果、转折与伏笔；不编造、不评价、不复述原文。',
        '直接输出结果，不要前言或标题。',
    ].join('\n');
    const effectiveTarget = plan.effectiveTarget;
    const cache = options.cache || null;
    const useCache = Boolean(cache && settings.reuseParts);
    let summaries = [];
    let failedLabels = [];
    let finalFallback = false;
    const finalCacheKey = cache
        ? hashText([
            'final',
            novelTitle,
            settings.provider || 'current',
            settings.profileId || '',
            styleKey,
            customStyle,
            extraInstruction,
            effectiveTarget,
            scopeLabel || '全书',
            strategy.mode,
            plan.mode,
            ...(plan.mode === 'direct'
                ? plan.segments.map(segment => hashText(segment.text))
                : plan.groups.map(group => `${group.label}:${hashText(group.text)}`)),
        ].join('|'))
        : '';

    if (useCache && finalCacheKey) {
        try {
            const cachedFinal = await cache.get(finalCacheKey);
            if (cachedFinal && typeof cachedFinal.text === 'string' && cachedFinal.text.trim()) {
                stats.cacheHits = plan.mode === 'mapreduce' ? plan.groups.length : 1;
                stats.outputChars = countChars(cachedFinal.text);
                stats.elapsedMs = Date.now() - stats.startedAt;
                onProgress({
                    type: 'stage',
                    stage: 'cache',
                    text: '命中上次完成的总结，直接复用，0 次模型请求',
                });
                const result = {
                    text: cachedFinal.text,
                    truncated: false,
                    plan,
                    stats,
                    budget,
                    targetChars: effectiveTarget,
                    requestedTarget: plan.requestedTarget,
                    capped: effectiveTarget < plan.requestedTarget,
                    mode: plan.mode,
                    incomplete: false,
                    failedLabels: [],
                    finalFallback: false,
                    cached: true,
                };
                onProgress({ type: 'done', result, stats });
                return result;
            }
        } catch (error) {
            console.warn('[小说阅读器] 读取最终总结缓存失败', error);
        }
    }

    if (plan.mode === 'direct') {
        const finalText = await callWithRetry({
            system,
            user: buildDirectPrompt({
                novelTitle,
                text: plan.segments[0].text,
                targetChars: effectiveTarget,
                scopeLabel: scopeLabel || '全书',
                styleKey,
            }),
            maxTokens: Math.min(
                Math.floor(budget.ctxTokens * 0.55),
                Math.max(900, Math.ceil(effectiveTarget * 1.6) + 220),
            ),
            maxTokenLimit: Math.max(320, Math.floor(budget.ctxTokens * 0.55)),
            settings,
            signal,
            label: '生成总结',
            onProgress,
            stats,
        });
        summaries = [{ text: finalText, tokens: estimateTokens(finalText), label: scopeLabel || '全书' }];
    } else {
        // ---------- Map ----------
        const groups = plan.groups;
        const totalGroups = groups.length;
        const serial = strategy.concurrency <= 1 || strategy.previousChars > 0;
        const concurrency = serial ? 1 : Math.min(strategy.concurrency, totalGroups);
        const jobs = groups.map((group, index) => {
            const share = plan.totalTokens > 0 ? group.tokens / plan.totalTokens : 0;
            const groupChars = group.chars || (group.segments || []).reduce((sum, item) => sum + (item.chars || 0), 0);
            const midTarget = strategy.ledger
                ? clamp(Math.round(groupChars * 0.04), 70, 260)
                : clamp(
                    Math.round(effectiveTarget * 1.2 * share),
                    Math.max(60, strategy.minMidChars),
                    Math.max(260, effectiveTarget),
                );
            const key = cache
                ? hashText([
                    novelTitle,
                    settings.provider || 'current',
                    settings.profileId || '',
                    effectiveTarget,
                    strategy.ledger ? 'ledger' : 'prose',
                    group.label,
                    group.text,
                ].join('|'))
                : '';
            const maxTokens = Math.min(
                Math.floor(budget.ctxTokens * 0.4),
                Math.max(640, Math.ceil(midTarget * 1.8) + 160),
            );
            return { group, index, midTarget, key, maxTokens, text: '', fromCache: false, error: null };
        });

        let finished = 0;
        const report = () => {
            onProgress({
                type: 'progress',
                stage: 'map',
                current: finished,
                total: totalGroups,
                percent: 10 + Math.round((finished / Math.max(1, totalGroups)) * 70),
                stats,
            });
        };

        if (useCache && typeof cache.get === 'function') {
            const rows = typeof cache.getMany === 'function'
                ? await Promise.resolve(cache.getMany(jobs.map(job => job.key))).catch(() => [])
                : await Promise.all(jobs.map(job => Promise.resolve(cache.get(job.key)).catch(() => null)));
            rows.forEach((row, index) => {
                if (row && typeof row.text === 'string' && row.text.trim().length >= 10) {
                    jobs[index].text = row.text;
                    jobs[index].fromCache = true;
                    finished += 1;
                }
            });
            stats.cacheHits = finished;
            if (finished > 0) {
                onProgress({
                    type: 'stage',
                    stage: 'cache',
                    text: `复用 ${finished}/${totalGroups} 段已完成的摘要，跳过 ${finished} 次请求`,
                });
                report();
            }
        }

        const runJob = async (job) => {
            if (job.text) return;
            if (signal?.aborted) throw createAbortError();
            const previousSummary = serial && job.index > 0 ? (jobs[job.index - 1].text || '') : '';
            onProgress({
                type: 'stage',
                stage: 'map',
                text: `分段总结 ${job.index + 1}/${totalGroups} · ${job.group.label}${concurrency > 1 ? `（并发 ${concurrency}）` : ''}`,
                current: job.index + 1,
                total: totalGroups,
            });

            try {
                const text = await callWithRetry({
                    system: compactSystem,
                    user: buildMapPrompt({
                        novelTitle,
                        group: job.group,
                        index: job.index,
                        total: totalGroups,
                        previousSummary,
                        targetChars: job.midTarget,
                        ledger: strategy.ledger,
                        previousChars: strategy.previousChars,
                    }),
                    maxTokens: job.maxTokens,
                    maxTokenLimit: omitResponseLength ? job.maxTokens : Math.max(240, Math.floor(budget.ctxTokens * 0.4)),
                    omitResponseLength,
                    settings,
                    signal,
                    label: `分段总结 ${job.index + 1}/${totalGroups}`,
                    onProgress,
                    stats,
                });
                job.text = text;
                stats.mapCalls += 1;
                if (useCache && typeof cache.put === 'function') {
                    try {
                        await cache.put({
                            key: job.key,
                            novelId: options.novelId || '',
                            label: job.group.label,
                            text,
                            tokens: estimateTokens(text),
                            createdAt: Date.now(),
                        });
                    } catch (cacheError) {
                        console.warn('[小说阅读器] 分段摘要缓存写入失败', cacheError);
                    }
                }
            } catch (error) {
                if (error?.name === 'AbortError' || isAbortError(error)) throw createAbortError();
                // 认证/余额/参数错误继续跑只会把每个分段都撞一遍，直接中止。
                if (isFatalApiError(error.cause || error)) throw error;
                job.error = error?.message || String(error);
                failedLabels.push(job.group.label);
                onProgress({
                    type: 'stage',
                    stage: 'group-failed',
                    text: `分段失败，跳过并继续：${job.group.label}（${job.error}）`,
                    error: job.error,
                    failedCount: failedLabels.length,
                    remainingGroups: totalGroups - finished,
                });
            } finally {
                finished += 1;
                report();
            }
        };

        let omitResponseLength = false;
        let savedOpenAiMaxTokens = null;
        const stContext = getContext();
        if (!serial && concurrency > 1 && settings.provider !== 'profile' && stContext.mainApi === 'openai') {
            const outputSettings = stContext.chatCompletionSettings;
            if (outputSettings && Number.isFinite(Number(outputSettings.openai_max_tokens))) {
                // generateRaw 的 responseLength 是全局设置；并发调用时多个请求会互相
                // 覆盖/恢复 max_tokens，导致个别分段只拿到 300 tokens 甚至空回复。
                // 并发 map 阶段固定一次输出预算，并让每个请求不再单独改全局值。
                savedOpenAiMaxTokens = Number(outputSettings.openai_max_tokens);
                const stable = Math.max(1024, ...jobs.map(job => job.maxTokens));
                outputSettings.openai_max_tokens = Math.min(Math.floor(budget.ctxTokens * 0.4), stable);
                omitResponseLength = true;
            }
        }

        try {
            if (serial) {
                for (const job of jobs) await runJob(job);
            } else {
                let cursor = 0;
                const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
                    while (true) {
                        const index = cursor++;
                        if (index >= jobs.length) return;
                        await runJob(jobs[index]);
                    }
                });
                await Promise.all(workers);
            }
        } finally {
            if (omitResponseLength && savedOpenAiMaxTokens !== null) {
                stContext.chatCompletionSettings.openai_max_tokens = savedOpenAiMaxTokens;
            }
        }

        summaries = jobs
            .filter(job => job.text)
            .sort((a, b) => a.index - b.index)
            .map(job => ({
                text: job.text,
                tokens: estimateTokens(job.text),
                label: job.group.label,
            }));
        failedLabels = jobs
            .filter(job => job.error)
            .sort((a, b) => a.index - b.index)
            .map(job => job.group.label);
        stats.successGroups = summaries.length;
        stats.failedGroups = failedLabels.length;

        if (summaries.length === 0) {
            const reason = failedLabels.length ? `首个错误：${jobs.find(job => job.error)?.error || '未知错误'}` : '模型没有返回可用内容';
            throw new Error(`所有分段都总结失败：${reason}`);
        }
        if (failedLabels.length > 0) {
            onProgress({
                type: 'stage',
                stage: 'partial',
                text: `有 ${failedLabels.length}/${totalGroups} 段失败，继续用其余 ${summaries.length} 段生成总结；失败分段已跳过，不会中断整本`,
                failedLabels,
            });
        }

        // ---------- Reduce ----------
        let level = 0;
        while (summaries.length > 1) {
            if (signal?.aborted) throw createAbortError();
            const combinedTokens = summaries.reduce((sum, summary) => sum + summary.tokens, 0) + PROMPT_OVERHEAD_TOKENS;
            if (combinedTokens <= budget.inputBudget * 0.95) break;
            if (level >= 8) break;

            const groups = groupSummaries(summaries, Math.max(500, budget.inputBudget - PROMPT_OVERHEAD_TOKENS));
            if (groups.length >= summaries.length) {
                // 单条摘要本身过大，先按比例裁剪，避免死循环
                summaries = summaries.map(summary => {
                    const fitted = trimToLimit(summary.text, Math.floor(budget.inputBudget / 1.2));
                    return { ...summary, text: fitted, tokens: estimateTokens(fitted) };
                });
                break;
            }

            onProgress({
                type: 'stage',
                stage: 'reduce',
                text: `第 ${level + 1} 层合并：${summaries.length} 段 -> ${groups.length} 段`,
            });

            const totalTokens = summaries.reduce((sum, summary) => sum + summary.tokens, 0);
            const nextSummaries = [];
            for (let index = 0; index < groups.length; index++) {
                if (signal?.aborted) throw createAbortError();
                const group = groups[index];
                const share = totalTokens > 0 ? group.tokens / totalTokens : 0;
                const reduceTarget = clamp(
                    Math.round(effectiveTarget * 1.4 * share),
                    clamp(settings.minMidChars || 180, 60, 600),
                    Math.max(320, Math.round(effectiveTarget * 1.2)),
                );

                try {
                    const text = await callWithRetry({
                        system: compactSystem,
                        user: buildReducePrompt({
                            novelTitle,
                            summaries: group.summaries,
                            targetChars: reduceTarget,
                            label: group.label,
                            ledger: strategy.ledger,
                        }),
                        maxTokens: Math.min(
                            Math.floor(budget.ctxTokens * 0.4),
                            Math.max(640, Math.ceil(reduceTarget * 1.7) + 180),
                        ),
                        maxTokenLimit: Math.max(256, Math.floor(budget.ctxTokens * 0.4)),
                        settings,
                        signal,
                        label: `合并第 ${level + 1} 层 (${index + 1}/${groups.length})`,
                        onProgress,
                        stats,
                    });
                    stats.reduceCalls += 1;
                    nextSummaries.push({
                        text,
                        tokens: estimateTokens(text),
                        label: group.label,
                    });
                } catch (error) {
                    if (error?.name === 'AbortError' || isAbortError(error)) throw createAbortError();
                    // 合并失败时保留原始分段摘要，避免整轮总结中断。
                    const fallback = group.summaries.map(summary => summary.text).join('\n').slice(0, Math.max(400, reduceTarget * 2));
                    nextSummaries.push({
                        text: fallback,
                        tokens: estimateTokens(fallback),
                        label: group.label,
                    });
                    onProgress({
                        type: 'stage',
                        stage: 'reduce-failed',
                        text: `合并失败，保留原始分段：${error.message}`,
                    });
                }
            }
            summaries = nextSummaries;
            level += 1;
            stats.levels = level;
            onProgress({
                type: 'progress',
                stage: 'reduce',
                current: level,
                total: Math.max(level, 1),
                percent: Math.min(92, 80 + level * 3),
                stats,
            });
        }

        // 最后一道保险：合并后的材料仍然超预算时按比例裁剪
        const finalTokens = summaries.reduce((sum, summary) => sum + summary.tokens, 0);
        if (finalTokens + PROMPT_OVERHEAD_TOKENS > budget.inputBudget) {
            const available = Math.max(400, budget.inputBudget - PROMPT_OVERHEAD_TOKENS);
            const ratio = available / finalTokens;
            summaries = summaries.map(summary => {
                const text = trimToLimit(summary.text, Math.max(120, Math.floor(summary.text.length * ratio)));
                return { ...summary, text, tokens: estimateTokens(text) };
            });
        }

        // ---------- Final ----------
        onProgress({ type: 'stage', stage: 'final', text: '生成最终总结…' });
        let finalText;
        try {
            finalText = await callWithRetry({
                system,
                user: buildFinalPrompt({
                    novelTitle,
                    summaries,
                    targetChars: effectiveTarget,
                    scopeLabel: scopeLabel || '全书',
                    styleKey,
                    missingLabels: failedLabels,
                }),
                maxTokens: Math.min(
                    Math.floor(budget.ctxTokens * 0.55),
                    Math.max(900, Math.ceil(effectiveTarget * 1.6) + 220),
                ),
                maxTokenLimit: Math.max(320, Math.floor(budget.ctxTokens * 0.55)),
                settings,
                signal,
                label: '最终成稿',
                onProgress,
                stats,
            });
            stats.finalCalls = 1;
        } catch (error) {
            if (error?.name === 'AbortError' || isAbortError(error)) throw createAbortError();
            // 最终成稿失败时保留已经拿到的分段摘要，不让整轮白跑。
            finalText = summaries.map(summary => summary.text).join('\n\n');
            finalFallback = true;
            onProgress({
                type: 'stage',
                stage: 'fallback',
                text: `最终成稿失败，已回退为分段摘要拼接：${error.message}`,
            });
            stats.finalCalls = 0;
        }
        summaries = [{ text: finalText || '', tokens: estimateTokens(finalText || ''), label: scopeLabel || '全书' }];
        if (useCache && finalCacheKey && !failedLabels.length && !finalFallback && finalText) {
            try {
                await cache.put({
                    key: finalCacheKey,
                    novelId: options.novelId || '',
                    label: '最终总结',
                    text: finalText,
                    tokens: estimateTokens(finalText),
                    createdAt: Date.now(),
                });
            } catch (error) {
                console.warn('[小说阅读器] 最终总结缓存写入失败', error);
            }
        }
    }

    let finalText = summaries[0]?.text || '';
    let truncated = false;

    // 超长时自动压缩一次
    if (settings.autoCalibrate && countChars(finalText) > effectiveTarget * 1.15) {
        onProgress({ type: 'stage', stage: 'compress', text: '总结超过字数上限，正在压缩…' });
        try {
            const compressed = await callWithRetry({
                system,
                user: buildCompressPrompt({
                    novelTitle,
                    text: trimToLimit(finalText, Math.max(effectiveTarget * 3, 2000)),
                    targetChars: Math.floor(effectiveTarget * 0.9),
                }),
                maxTokens: Math.min(
                    Math.ceil(effectiveTarget * 1.4) + 180,
                    Math.max(300, Math.floor(budget.ctxTokens * 0.5)),
                ),
                settings,
                signal,
                label: '压缩到字数上限',
                onProgress,
                stats,
            });
            if (compressed) finalText = compressed;
        } catch (error) {
            if (isAbortError(error)) throw error;
            console.warn('[小说阅读器] 自动压缩失败，将使用句末截断', error);
        }
    }

    if (countChars(finalText) > effectiveTarget) {
        finalText = trimToLimit(finalText, effectiveTarget);
        truncated = true;
    }

    stats.outputChars = countChars(finalText);
    stats.elapsedMs = Date.now() - stats.startedAt;

    const result = {
        text: finalText,
        truncated,
        plan,
        stats,
        budget,
        targetChars: effectiveTarget,
        requestedTarget: plan.requestedTarget,
        capped: effectiveTarget < plan.requestedTarget,
        mode: plan.mode,
        incomplete: failedLabels.length > 0 || finalFallback,
        failedLabels,
        finalFallback,
    };

    onProgress({ type: 'done', result, stats });
    return result;
}
