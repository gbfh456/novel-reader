/**
 * 规则引擎 - 规则执行
 *
 * 输入编译好的规则（js/rule/compile.js），按步骤在 DOM / JSON / 文本上求值。
 * P0 支持：CSS / 阅读链式选择器 / JSONPath / XPath（浏览器）/ 正则列表 / 纯 JS / 变量 / 正则替换。
 * `java.ajax` 需要同步网络（P4 的 Worker 沙箱），这里先明确报错。
 */

import { normalizeUrl } from '../network.js';
import {
    childElements,
    descendantElements,
    isDocument,
    isNode,
    joinNodeText,
    nodeAttr,
    nodeInnerHtml,
    nodeOuterHtml,
    nodeOwnText,
    nodeTag,
    nodeText,
    nodeTextNodes,
    parseDocument,
    selectWithin,
} from './dom.js';
import { parseJsonLoose, queryJsonPath } from './jsonpath.js';
import { compileRule as compileRuleLocal } from './compile.js';

export class RuleError extends Error {
    constructor(message, { rule = '', step = null } = {}) {
        super(message);
        this.name = 'RuleError';
        this.rule = rule;
        this.step = step;
    }
}

/** 规则执行上下文：对应 Legado 的 AnalyzeRule + RuleData */
export function createRuleContext(init = {}) {
    return {
        source: init.source || null,
        book: init.book || null,
        chapter: init.chapter || null,
        baseUrl: init.baseUrl || '',
        redirectUrl: init.redirectUrl || init.baseUrl || '',
        vars: new Map(Object.entries(init.vars || {})),
        key: init.key ?? '',
        page: init.page ?? 1,
        nextChapterUrl: init.nextChapterUrl ?? '',
        logs: [],
        trace: [],
        /** 当前规则名（搜索/目录/正文），只用于日志 */
        ruleName: init.ruleName || '',
        /** 纯 JS 规则里可用的额外绑定 */
        extra: init.extra || {},
        /** 异步 JS 执行器（浏览器 Worker）；没有时退回同步纯 JS */
        jsRunner: init.jsRunner || null,
        /** 执行追踪（规则调试器用） */
        traceLimit: Number(init.traceLimit) || 400,
    };
}

function remember(ctx, entry) {
    ctx.trace.push({ time: Date.now(), ...entry });
    if (ctx.trace.length > (ctx.traceLimit || 400)) ctx.trace.splice(0, ctx.trace.length - (ctx.traceLimit || 400));
}

function toDocument(value, ctx, baseUrl) {
    if (isDocument(value)) return value;
    if (isNode({ kind: 'dom' }, value)) {
        const doc = value.ownerDocument || document;
        return { kind: 'dom', root: value, doc, url: baseUrl || ctx.redirectUrl || '', html: value.outerHTML || '' };
    }
    if (value && value.type === 'element') {
        return { kind: 'lite', root: value, url: baseUrl || ctx.redirectUrl || '', html: '' };
    }
    return parseDocument(String(value ?? ''), baseUrl || ctx.redirectUrl || ctx.baseUrl || '');
}

function cssEscape(value) {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(String(value));
    return String(value).replace(/[^\w-]/g, char => `\\${char}`);
}

function uniqueNodes(nodes) {
    const seen = new Set();
    const out = [];
    for (const node of nodes) {
        if (!node || seen.has(node)) continue;
        seen.add(node);
        out.push(node);
    }
    return out;
}

/** 按索引规则筛选元素（对应 ElementsSingle 的索引处理） */
function applyIndex(nodes, spec) {
    if (!spec || !spec.values?.length) return nodes;
    const length = nodes.length;
    const picked = new Set();
    for (const item of spec.values) {
        if (!item.range) {
            let index = item.index < 0 ? length + item.index : item.index;
            if (index >= 0 && index < length) picked.add(index);
            continue;
        }
        let start = item.start == null ? 0 : item.start;
        let end = item.end == null ? length - 1 : item.end;
        if (start < 0) start += length;
        if (end < 0) end += length;
        start = Math.max(0, Math.min(length - 1, start));
        end = Math.max(0, Math.min(length - 1, end));
        const stride = item.step == null ? 1 : item.step;
        if (!stride) continue;
        if (stride > 0) {
            for (let index = start; index <= end; index += stride) picked.add(index);
        } else {
            for (let index = start; index >= end; index += stride) picked.add(index);
        }
    }
    if (spec.exclude) return nodes.filter((_, index) => !picked.has(index));
    return [...picked].sort((a, b) => a - b).map(index => nodes[index]).filter(Boolean);
}

function selectOnce(scope, node, step) {
    let found = [];
    if (step.kind === 'class') found = selectWithin(scope, node, `.${cssEscape(step.value)}`);
    else if (step.kind === 'tag') found = selectWithin(scope, node, step.value);
    else if (step.kind === 'id') found = selectWithin(scope, node, `#${cssEscape(step.value)}`);
    else if (step.kind === 'children') found = childElements(scope, node);
    else if (step.kind === 'text') {
        found = descendantElements(scope, node).filter(item => nodeOwnText(scope, item).includes(step.value));
    } else found = selectWithin(scope, node, step.selector);
    return applyIndex(found, step.index);
}

function selectChain(scope, nodes, chain) {
    let current = nodes;
    for (const step of chain) {
        const next = [];
        for (const node of current) next.push(...selectOnce(scope, node, step));
        current = uniqueNodes(next);
        if (!current.length) break;
    }
    return current;
}

function extractValue(scope, node, attr) {
    if (!node) return '';
    switch (attr) {
        case '':
        case 'text':
            return nodeText(scope, node);
        case 'textNodes':
            return nodeTextNodes(scope, node);
        case 'ownText':
            return nodeOwnText(scope, node);
        case 'html':
            return nodeInnerHtml(scope, node);
        case 'all':
            return nodeOuterHtml(scope, node);
        default:
            return nodeAttr(scope, node, attr);
    }
}

function resolveUrl(value, ctx) {
    const text = String(value ?? '').trim();
    if (!text) return '';
    const base = ctx.redirectUrl || ctx.baseUrl || '';
    return normalizeUrl(text, base) || text;
}

function applyReplace(value, replace) {
    if (!replace || !replace.regex) return value;
    const single = Array.isArray(value) ? null : value;
    const list = single == null ? value : [value];
    const output = [];
    for (const item of list) {
        const text = String(item ?? '');
        try {
            if (replace.first) {
                const matcher = new RegExp(replace.regex);
                const found = text.match(matcher);
                output.push(found ? found[0].replace(new RegExp(replace.regex), replace.replacement) : replace.replacement);
            } else {
                output.push(text.replace(new RegExp(replace.regex, 'g'), replace.replacement));
            }
        } catch (error) {
            throw new RuleError(`替换规则不是合法正则：${replace.regex}（${error.message}）`, { rule: replace.regex });
        }
    }
    return single == null ? output : output[0];
}

function buildJavaStub(ctx) {
    const requireRule = (rule, content) => getString(rule, content, ctx);
    return {
        ajax() {
            throw new RuleError('这条规则用了 java.ajax：同步网络要等 JS 沙箱（P4）接入，当前先跳过这条源');
        },
        get(url) {
            throw new RuleError(`规则调用了 java.get(${url})：需要 JS 沙箱（P4）`);
        },
        post(url) {
            throw new RuleError(`规则调用了 java.post(${url})：需要 JS 沙箱（P4）`);
        },
        connect(url) {
            throw new RuleError(`规则调用了 java.connect(${url})：需要 JS 沙箱（P4）`);
        },
        getString(rule, content) {
            return requireRule(rule, content ?? ctx.content ?? '');
        },
        getStringList(rule, content) {
            return getStringList(rule, content ?? ctx.content ?? '', ctx);
        },
        put(key, value) {
            ctx.vars.set(String(key), String(value));
            return String(value);
        },
        get(key) {
            return ctx.vars.get(String(key)) ?? '';
        },
        base64Encode(text) {
            try {
                return btoa(unescape(encodeURIComponent(String(text))));
            } catch {
                return '';
            }
        },
        base64Decode(text) {
            try {
                return decodeURIComponent(escape(atob(String(text))));
            } catch {
                return '';
            }
        },
        md5Encode(text) {
            // 规则里常用 java.md5Encode；P0 不引第三方库，返回空串让规则显式失败
            void text;
            throw new RuleError('java.md5Encode 需要加密库，P4 再补');
        },
        timeFormat(value) {
            return new Date(Number(value) || Date.now()).toISOString();
        },
        encodeURI(text) {
            return encodeURIComponent(String(text));
        },
        htmlFormat(text) {
            return String(text ?? '').replace(/<[^>]+>/g, '');
        },
        log(...args) {
            ctx.logs.push(args.map(String).join(' '));
        },
        toast(...args) {
            ctx.logs.push(args.map(String).join(' '));
        },
        longToast(...args) {
            ctx.logs.push(args.map(String).join(' '));
        },
    };
}

function runJs(code, ctx, result) {
    const sandbox = {
        java: buildJavaStub(ctx),
        source: ctx.source,
        book: ctx.book,
        chapter: ctx.chapter,
        baseUrl: ctx.baseUrl,
        redirectUrl: ctx.redirectUrl,
        result,
        title: ctx.chapter?.title ?? '',
        src: typeof result === 'string' ? result : (ctx.content ?? ''),
        nextChapterUrl: ctx.nextChapterUrl ?? '',
        key: ctx.key,
        page: ctx.page,
        cookie: { getCookie: () => '', putCookie: () => {}, replaceCookie: () => {} },
        cache: {
            get: key => ctx.vars.get(String(key)) ?? '',
            put: (key, value) => {
                ctx.vars.set(String(key), String(value));
                return value;
            },
            delete: key => ctx.vars.delete(String(key)),
        },
        ...ctx.extra,
    };
    try {
        // eval 返回最后一条语句的值，和 Rhino 的 completion value 语义一致
        const runner = new Function('__scope', '__code', 'with (__scope) { return eval(__code); }');
        return runner(sandbox, String(code ?? ''));
    } catch (error) {
        if (error instanceof RuleError) throw error;
        throw new RuleError(`JS 规则执行失败：${error.message}`, { rule: String(code).slice(0, 120) });
    }
}

function toNodeList(scope, value) {
    if (Array.isArray(value)) return value;
    if (isNode(scope, value)) return [value];
    return [];
}

function evaluateStep(step, value, ctx, options) {
    if (step.kind === 'passthrough') {
        return applyReplace(value, step.replace);
    }
    if (step.kind === 'get') {
        return ctx.vars.get(step.key) ?? '';
    }
    if (step.kind === 'js') {
        return runJs(step.code, ctx, value);
    }
    if (step.kind === 'alternatives') {
        return evaluateAlternatives(step, value, ctx, options);
    }
    if (step.kind === 'regex') {
        const text = String(value ?? '');
        const flags = 'g';
        let regex;
        try {
            regex = new RegExp(step.pattern, flags);
        } catch (error) {
            throw new RuleError(`正则规则不合法：${step.pattern}（${error.message}）`, { rule: step.pattern });
        }
        const matches = [];
        let match;
        while ((match = regex.exec(text)) && matches.length < 2000) {
            matches.push(match.slice());
            if (match[0] === '') regex.lastIndex++;
        }
        const replaced = applyReplace(matches, step.replace);
        return replaced;
    }
    if (step.kind === 'json') {
        const data = typeof value === 'string' ? parseJsonLoose(value) : value;
        if (data === undefined || data === null) return options.list ? [] : '';
        const values = queryJsonPath(data, step.path);
        const replaced = applyReplace(values, step.replace);
        if (options.list) return replaced;
        return (Array.isArray(replaced) ? replaced : [replaced])
            .map(item => (item && typeof item === 'object' ? JSON.stringify(item) : String(item ?? '')))
            .join('\n');
    }
    if (step.kind === 'xpath') {
        return evaluateXPath(step, value, ctx, options);
    }
    if (step.kind === 'select') {
        const scope = toDocument(value, ctx);
        const nodes = selectChain(scope, [scope.root], step.chain);
        const replaced = step.replace;
        if ((options.list || options.isUrl) && !step.attr) {
            return applyReplace(nodes, replaced);
        }
        const values = nodes
            .map(node => extractValue(scope, node, step.attr || 'text'))
            .filter(item => item !== '');
        const output = applyReplace(values, replaced);
        if (options.list || options.isUrl) return output;
        return (Array.isArray(output) ? output : [output]).join('\n');
    }
    return value;
}

function evaluateXPath(step, value, ctx, options) {
    const scope = toDocument(value, ctx);
    if (scope.kind !== 'dom' || typeof document === 'undefined' || typeof XPathResult === 'undefined') {
        throw new RuleError('这条规则用了 XPath：当前环境没有原生 XPath（Node 测试环境），请在浏览器里跑');
    }
    const doc = scope.doc || document;
    const roots = isNode(scope, value) || scope.root ? [scope.root] : [doc];
    const output = [];
    for (const root of roots) {
        let result;
        try {
            result = doc.evaluate(step.expr, root, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        } catch (error) {
            throw new RuleError(`XPath 不合法：${step.expr}（${error.message}）`, { rule: step.expr });
        }
        if (result.snapshotLength != null) {
            for (let index = 0; index < result.snapshotLength; index++) {
                const node = result.snapshotItem(index);
                if (node.nodeType === 2) output.push(node.nodeValue ?? '');
                else if (node.nodeType === 3) output.push(node.nodeValue ?? '');
                else output.push(String(node.textContent ?? '').replace(/\s+/g, ' ').trim());
            }
        } else {
            output.push(String(result.stringValue ?? ''));
        }
    }
    const replaced = applyReplace(output, step.replace);
    return options.list ? replaced : (Array.isArray(replaced) ? replaced : [replaced]).join('\n');
}

function evaluateAlternatives(step, value, ctx, options) {
    const results = [];
    for (const rule of step.rules) {
        const result = evaluateSteps(rule.steps, value, ctx, options);
        const empty = result == null || result === '' || (Array.isArray(result) && result.length === 0);
        if (empty) continue;
        results.push(result);
        if (step.operator === '||') break;
    }
    if (!results.length) return options.list ? [] : '';
    if (results.length === 1) return results[0];
    if (step.operator === '%%') {
        const length = Math.max(...results.map(item => (Array.isArray(item) ? item.length : 1)));
        const mixed = [];
        for (let index = 0; index < length; index++) {
            for (const item of results) {
                if (!Array.isArray(item)) {
                    if (index === 0) mixed.push(item);
                    continue;
                }
                if (index < item.length) mixed.push(item[index]);
            }
        }
        return mixed;
    }
    const flattened = [];
    for (const item of results) {
        if (Array.isArray(item)) flattened.push(...item);
        else flattened.push(item);
    }
    return flattened;
}

function evaluateSteps(steps, content, ctx, options) {
    let current = content;
    for (const step of steps) {
        if (current == null) break;
        current = evaluateStep(step, current, ctx, options);
        if (current == null) break;
    }
    return current;
}

/** 应用编译结果里的 @put 变量 */
export function applyPuts(compiled, ctx) {
    if (!compiled?.put) return;
    for (const [key, rule] of Object.entries(compiled.put)) {
        try {
            ctx.vars.set(key, getString(rule, ctx.content ?? '', ctx));
        } catch {
            ctx.vars.set(key, '');
        }
    }
}

/** 执行编译好的规则 */
export function evaluateCompiled(compiled, content, ctx, options = {}) {
    if (!compiled || compiled.empty) return options.list ? [] : '';
    ctx.content = content;
    applyPuts(compiled, ctx);
    const started = Date.now();
    const result = evaluateSteps(compiled.steps, content, ctx, {
        list: Boolean(options.list),
        isUrl: Boolean(options.isUrl),
    });
    remember(ctx, {
        rule: compiled.raw,
        ms: Date.now() - started,
        list: Boolean(options.list),
        count: Array.isArray(result) ? result.length : (result ? 1 : 0),
    });
    return result;
}

function finishString(value, ctx, isUrl) {
    if (Array.isArray(value)) {
        const list = value.map(item => (item && typeof item === 'object' ? JSON.stringify(item) : String(item ?? '')));
        if (isUrl) {
            const urls = list.map(item => resolveUrl(item, ctx)).filter(Boolean);
            return urls[0] || '';
        }
        return list.join('\n');
    }
    if (value && typeof value === 'object') return JSON.stringify(value);
    const text = String(value ?? '');
    return isUrl ? resolveUrl(text, ctx) : text;
}

/**
 * 规则 → 字符串（多个结果用 \n 连接）
 * @param {string|object} rule 规则字符串或编译结果
 */
export function getString(rule, content, ctx, options = {}) {
    const compiled = typeof rule === 'string' ? compileCached(rule, { defaultAttr: options.defaultAttr ?? null }) : rule;
    const result = evaluateCompiled(compiled, content, ctx, { list: false, isUrl: Boolean(options.isUrl) });
    return finishString(result, ctx, Boolean(options.isUrl));
}

/** 规则 → 字符串数组 */
export function getStringList(rule, content, ctx, options = {}) {
    const compiled = typeof rule === 'string' ? compileCached(rule, { defaultAttr: options.defaultAttr ?? null }) : rule;
    const result = evaluateCompiled(compiled, content, ctx, { list: true });
    const list = Array.isArray(result) ? result : (result == null || result === '' ? [] : [result]);
    return list
        .map(item => (item && typeof item === 'object' ? JSON.stringify(item) : String(item ?? '')))
        .filter(item => item !== '')
        .map(item => (options.isUrl ? resolveUrl(item, ctx) : item));
}

/** 规则 → DOM 节点 / JSON 对象数组（书籍列表、目录列表用） */
export function getElements(rule, content, ctx, options = {}) {
    const compiled = typeof rule === 'string' ? compileCached(rule, { list: true }) : rule;
    const result = evaluateCompiled(compiled, content, ctx, { list: true });
    return Array.isArray(result) ? result : (result == null || result === '' ? [] : [result]);
}

/** 把一条「替换规则」应用到纯文本（正文净化用） */
export function replaceText(ruleText, text, ctx) {
    const compiled = compileCached(ruleText, {});
    if (!compiled.steps.length) return String(text ?? '');
    const step = compiled.steps[0];
    if (step.replace) return String(applyReplace(String(text ?? ''), step.replace));
    const value = evaluateCompiled(compiled, String(text ?? ''), ctx, { list: false });
    return finishString(value, ctx, false);
}

function shouldUseAsyncJs(step, ctx) {
    return step?.kind === 'js' && !step.web && typeof ctx.jsRunner === 'function';
}

async function evaluateStepAsync(step, value, ctx, options) {
    if (step.kind === 'js') {
        if (step.web) throw new RuleError('@webjs 需要 WebView，插件不支持');
        if (typeof ctx.jsRunner === 'function') {
            const started = Date.now();
            try {
                const result = await ctx.jsRunner({ code: step.code, result: value, ctx });
                remember(ctx, { rule: `@js:${String(step.code).slice(0, 60)}`, ms: Date.now() - started, list: false, count: result == null ? 0 : 1 });
                return result;
            } catch (error) {
                // 沙箱不可用时退回同步纯 JS（联网规则会在 runJs 里明确报错）
                if (error?.code !== 'SANDBOX_UNAVAILABLE') throw error;
            }
        }
        return runJs(step.code, ctx, value);
    }
    if (step.kind === 'alternatives') {
        const results = [];
        for (const rule of step.rules) {
            const result = await evaluateStepsAsync(rule.steps, value, ctx, options);
            const empty = result == null || result === '' || (Array.isArray(result) && result.length === 0);
            if (empty) continue;
            results.push(result);
            if (step.operator === '||') break;
        }
        if (!results.length) return options.list ? [] : '';
        if (results.length === 1) return results[0];
        if (step.operator === '%%') {
            const length = Math.max(...results.map(item => (Array.isArray(item) ? item.length : 1)));
            const mixed = [];
            for (let index = 0; index < length; index++) {
                for (const item of results) {
                    if (!Array.isArray(item)) {
                        if (index === 0) mixed.push(item);
                        continue;
                    }
                    if (index < item.length) mixed.push(item[index]);
                }
            }
            return mixed;
        }
        const flattened = [];
        for (const item of results) {
            if (Array.isArray(item)) flattened.push(...item);
            else flattened.push(item);
        }
        return flattened;
    }
    return evaluateStep(step, value, ctx, options);
}

async function evaluateStepsAsync(steps, content, ctx, options) {
    let current = content;
    for (const step of steps) {
        if (current == null) break;
        current = await evaluateStepAsync(step, current, ctx, options);
        if (current == null) break;
    }
    return current;
}

async function applyPutsAsync(compiled, ctx) {
    if (!compiled?.put) return;
    for (const [key, rule] of Object.entries(compiled.put)) {
        try {
            ctx.vars.set(key, await getStringAsync(rule, ctx.content ?? '', ctx));
        } catch {
            ctx.vars.set(key, '');
        }
    }
}

/** 异步执行（含 JS 沙箱） */
export async function evaluateCompiledAsync(compiled, content, ctx, options = {}) {
    if (!compiled || compiled.empty) return options.list ? [] : '';
    ctx.content = content;
    await applyPutsAsync(compiled, ctx);
    const started = Date.now();
    const result = await evaluateStepsAsync(compiled.steps, content, ctx, {
        list: Boolean(options.list),
        isUrl: Boolean(options.isUrl),
    });
    remember(ctx, {
        rule: compiled.raw,
        ms: Date.now() - started,
        list: Boolean(options.list),
        count: Array.isArray(result) ? result.length : (result ? 1 : 0),
    });
    return result;
}

export async function getStringAsync(rule, content, ctx, options = {}) {
    const compiled = typeof rule === 'string' ? compileCached(rule, { defaultAttr: options.defaultAttr ?? null }) : rule;
    const result = await evaluateCompiledAsync(compiled, content, ctx, { list: false, isUrl: Boolean(options.isUrl) });
    return finishString(result, ctx, Boolean(options.isUrl));
}

export async function getStringListAsync(rule, content, ctx, options = {}) {
    const compiled = typeof rule === 'string' ? compileCached(rule, { defaultAttr: options.defaultAttr ?? null }) : rule;
    const result = await evaluateCompiledAsync(compiled, content, ctx, { list: true });
    const list = Array.isArray(result) ? result : (result == null || result === '' ? [] : [result]);
    return list
        .map(item => (item && typeof item === 'object' ? JSON.stringify(item) : String(item ?? '')))
        .filter(item => item !== '')
        .map(item => (options.isUrl ? resolveUrl(item, ctx) : item));
}

export async function getElementsAsync(rule, content, ctx, options = {}) {
    const compiled = typeof rule === 'string' ? compileCached(rule, { list: true }) : rule;
    const result = await evaluateCompiledAsync(compiled, content, ctx, { list: true });
    return Array.isArray(result) ? result : (result == null || result === '' ? [] : [result]);
}

const compileCache = new Map();

function compileCached(rule, options) {
    const key = `${options.list ? 'L' : 'S'}|${options.defaultAttr || ''}\u0000${rule}`;
    if (compileCache.has(key)) return compileCache.get(key);
    const compiled = compileRuleLocal(rule, options);
    if (compileCache.size > 200) compileCache.clear();
    compileCache.set(key, compiled);
    return compiled;
}
