/**
 * 规则引擎 - 规则编译
 *
 * 把 Legado / 阅读 的规则字符串拆成可执行的步骤：
 *
 *   @put:{k:rule}            → 先保存变量
 *   @@ / @css: / @XPath: / @Json: / $ / //   → 选择器类型
 *   class.a@tag.li@text      → 链式选择 + 取文本
 *   ##正则##替换###           → 正则替换（### 只替换第一个）
 *   {{js}} / @js: / <js>    → JS 步骤（P0 只支持不联网的纯 JS）
 *   @get:{key}               → 取变量
 *   a&&b / a||b / a%%b       → 并集 / 第一个非空 / 逐项交叉
 *
 * 编译只做语法层，不碰网络和 DOM；执行在 js/rule/execute.js。
 */

const ATTR_KEYWORDS = new Set(['text', 'textNodes', 'ownText', 'html', 'all']);

/** 在顶层（忽略引号 / 括号）按分隔符切分 */
export function splitTopLevel(text, separators = ['&&', '||', '%%']) {
    const source = String(text ?? '');
    const parts = [];
    let current = '';
    let quote = '';
    let depth = 0;
    let operator = '';
    const trySeparator = index => {
        for (const separator of separators) {
            if (source.startsWith(separator, index)) return separator;
        }
        return '';
    };
    for (let index = 0; index < source.length; index++) {
        const char = source[index];
        if (quote) {
            current += char;
            if (char === '\\' && index + 1 < source.length) {
                current += source[++index];
                continue;
            }
            if (char === quote) quote = '';
            continue;
        }
        if (char === '\'' || char === '"') {
            quote = char;
            current += char;
            continue;
        }
        if (char === '(' || char === '[' || char === '{') depth++;
        if (char === ')' || char === ']' || char === '}') depth = Math.max(0, depth - 1);
        if (depth === 0) {
            const separator = trySeparator(index);
            if (separator) {
                if (!operator) operator = separator;
                if (operator !== separator) {
                    // 不同分隔符混用：按先出现的那个为准，后面的留给子规则
                    current += separator;
                    index += separator.length - 1;
                    continue;
                }
                parts.push(current.trim());
                current = '';
                index += separator.length - 1;
                continue;
            }
        }
        current += char;
    }
    parts.push(current.trim());
    return { parts: parts.filter(Boolean), operator: operator || '&&' };
}

/** 抽出 @put:{...}，返回剩余规则与变量表 */
function extractPuts(text) {
    const put = {};
    const pattern = /@put:\{(.+?)\}/gi;
    const rest = String(text ?? '').replace(pattern, (_, body) => {
        const raw = String(body).trim();
        let parsed = null;
        try {
            parsed = JSON.parse(`{${raw}}`);
        } catch {
            parsed = null;
        }
        if (parsed && typeof parsed === 'object') {
            for (const [key, value] of Object.entries(parsed)) {
                if (typeof value === 'string') put[key] = value;
            }
            return '';
        }
        // 非标准 JSON（值里有逗号 / 没加引号）：按第一个冒号切开
        for (const entry of raw.split(/[,;]/)) {
            const index = entry.indexOf(':');
            if (index < 0) continue;
            const key = entry.slice(0, index).trim().replace(/^['"]|['"]$/g, '');
            const value = entry.slice(index + 1).trim().replace(/^['"]|['"]$/g, '');
            if (key && value) put[key] = value;
        }
        return '';
    });
    return { put, rest: rest.trim() };
}

/** 把 @js: / <js> / @webjs: 切成独立段；@js 会吃掉剩余部分（与 Legado 一致） */
function splitJsSegments(text) {
    const source = String(text ?? '');
    const segments = [];
    const pattern = /<js>([\s\S]*?)<\/js>|@webjs:([\s\S]*)|@js:([\s\S]*)/gi;
    let cursor = 0;
    let match;
    while ((match = pattern.exec(source))) {
        if (match.index > cursor) {
            const chunk = source.slice(cursor, match.index).trim();
            if (chunk) segments.push({ type: 'text', value: chunk });
        }
        if (match[2] !== undefined) segments.push({ type: 'js', code: match[2], web: true });
        else segments.push({ type: 'js', code: match[1] ?? match[3] ?? '' });
        cursor = match.index + match[0].length;
        if (match[2] !== undefined || match[3] !== undefined) break;
    }
    if (cursor < source.length) {
        const chunk = source.slice(cursor).trim();
        if (chunk) segments.push({ type: 'text', value: chunk });
    }
    return segments;
}

/** 把 {{js}} / @get:{key} 切成独立段 */
function splitEvalSegments(text) {
    const source = String(text ?? '');
    const segments = [];
    const pattern = /\{\{([\s\S]*?)\}\}|@get:\{([^}]+?)\}/g;
    let cursor = 0;
    let match;
    while ((match = pattern.exec(source))) {
        if (match.index > cursor) {
            const chunk = source.slice(cursor, match.index).trim();
            if (chunk) segments.push({ type: 'text', value: chunk });
        }
        if (match[2] !== undefined) segments.push({ type: 'get', key: match[2].trim() });
        else segments.push({ type: 'js', code: match[1] });
        cursor = match.index + match[0].length;
    }
    if (cursor < source.length) {
        const chunk = source.slice(cursor).trim();
        if (chunk) segments.push({ type: 'text', value: chunk });
    }
    return segments;
}

/** 解析索引：`[0,2,-1]`、`[0:3:2]`、`[!0]`；老写法 `.0` / `!0` / `.0:3` */
function parseIndexSpec(text) {
    let body = String(text || '').trim();
    if (!body) return null;
    let exclude = false;
    if (body.startsWith('!')) {
        exclude = true;
        body = body.slice(1);
    }
    const values = [];
    for (const token of body.split(',')) {
        const part = token.trim();
        if (!part) continue;
        if (part.includes(':')) {
            const [start, end, step] = part.split(':').map(value => (value.trim() === '' ? null : Number(value)));
            values.push({ range: true, start, end, step });
        } else {
            const number = Number(part);
            if (Number.isFinite(number)) values.push({ range: false, index: number });
        }
    }
    return values.length ? { values, exclude } : null;
}

const LEGACY_INDEX = /^(.*?)([.!])(-?\d+(?::-?\d+){0,2})$/;

/** 解析一个选择器片段：class.x / tag.x / id.x / text.x / children / 普通 CSS */
export function parseStep(segment) {
    let body = String(segment ?? '').trim();
    let index = null;
    const bracket = body.match(/\[([^\]]*)\]\s*$/);
    if (bracket) {
        index = parseIndexSpec(bracket[1]);
        body = body.slice(0, bracket.index).trim();
    } else {
        const legacy = body.match(LEGACY_INDEX);
        if (legacy && legacy[1]) {
            index = parseIndexSpec(`${legacy[2] === '!' ? '!' : ''}${legacy[3]}`);
            body = legacy[1].trim();
        }
    }
    let step;
    if (!body) step = { kind: 'children' };
    else if (body === 'children') step = { kind: 'children' };
    else if (/^class\./.test(body)) step = { kind: 'class', value: body.slice(6) };
    else if (/^tag\./.test(body)) step = { kind: 'tag', value: body.slice(4) };
    else if (/^id\./.test(body)) step = { kind: 'id', value: body.slice(3) };
    else if (/^text\./.test(body)) step = { kind: 'text', value: body.slice(5) };
    else step = { kind: 'css', selector: body };
    if (index) step.index = index;
    return step;
}

/** 把链式规则切成步骤，并取出最后一段的属性 */
function parseChain(text, { list, defaultAttr }) {
    const { parts } = splitTopLevel(text, ['@']);
    const chain = [];
    let attr = '';
    let working = [...parts];
    // 以 @ 开头表示「取当前节点自己的属性」：@href / @class / @data-volume
    const leadingAttr = !list && /^@(?!@|css:|xpath:|json:|js:|webjs:|get:|put:)/i.test(String(text).trim());
    if (leadingAttr) {
        return { chain: [], attr: working[0] || '' };
    }
    if (!list && working.length > 1) {
        attr = working[working.length - 1];
        working = working.slice(0, -1);
    } else if (!list && working.length === 1 && ATTR_KEYWORDS.has(working[0])) {
        attr = working[0];
        working = [];
    } else if (!list && working.length === 1) {
        attr = defaultAttr || '';
    }
    for (const part of working) {
        if (!part.trim()) continue;
        chain.push(parseStep(part));
    }
    return { chain, attr };
}

/** 解析一段纯文本规则（不含 JS / get / 顶层操作符） */
function parseTextRule(text, options) {
    let body = String(text ?? '').trim();
    if (!body) return null;
    let mode = 'default';
    if (body.startsWith('@@')) {
        body = body.slice(2).trim();
    } else if (/^@css:/i.test(body)) {
        mode = 'css';
        body = body.slice(5).trim();
    } else if (/^@xpath:/i.test(body)) {
        mode = 'xpath';
        body = body.slice(7).trim();
    } else if (/^@json:/i.test(body)) {
        mode = 'json';
        body = body.slice(6).trim();
    } else if (/^\$/.test(body)) {
        mode = 'json';
    } else if (/^\//.test(body)) {
        mode = 'xpath';
    }

    let replace = null;
    const segments = body.split('##');
    if (segments.length > 1) {
        body = segments[0].trim();
        replace = {
            regex: segments[1],
            replacement: segments[2] ?? '',
            first: segments.length > 3,
        };
        if (!body) return [{ kind: 'passthrough', replace }];
    }

    if (mode === 'json') {
        if (!body) return null;
        return [{ kind: 'json', path: body, replace }];
    }
    if (mode === 'xpath') {
        if (!body) return null;
        return [{ kind: 'xpath', expr: body, replace }];
    }
    if (mode === 'css') {
        // @css: 也是「选择器@属性」
        const { chain, attr } = parseChain(body, { list: options.list, defaultAttr: options.defaultAttr ?? null });
        if (!chain.length && !attr) return null;
        return [{ kind: 'select', chain, attr: attr || '', replace }];
    }
    if (options.list && body.startsWith(':')) {
        return [{ kind: 'regex', pattern: body.slice(1), replace }];
    }
    const { chain, attr } = parseChain(body, options);
    if (!chain.length && !attr) return null;
    return [{
        kind: 'select',
        chain,
        attr: attr || '',
        replace,
        fallbackText: !attr && options.defaultAttr === 'text',
    }];
}

/**
 * 编译一条完整规则。
 * @param {string} raw
 * @param {{list?:boolean, defaultAttr?:'text'|null}} options
 * @returns {{raw:string, steps:object[], put:object, empty:boolean}}
 */
export function compileRule(raw, options = {}) {
    const settings = { list: Boolean(options.list), defaultAttr: options.defaultAttr ?? null };
    const text = String(raw ?? '').trim();
    const { put, rest } = extractPuts(text);
    if (!rest) return { raw: text, steps: [], put, empty: true };

    const steps = [];
    for (const segment of splitJsSegments(rest)) {
        if (segment.type === 'js') {
            steps.push({ kind: 'js', code: segment.code, web: Boolean(segment.web) });
            continue;
        }
        for (const evalSegment of splitEvalSegments(segment.value)) {
            if (evalSegment.type === 'js') {
                steps.push({ kind: 'js', code: evalSegment.code });
                continue;
            }
            if (evalSegment.type === 'get') {
                steps.push({ kind: 'get', key: evalSegment.key });
                continue;
            }
            const split = splitTopLevel(evalSegment.value);
            if (split.parts.length > 1) {
                const rules = [];
                for (const part of split.parts) {
                    const compiled = parseTextRule(part, settings);
                    if (compiled) rules.push({ steps: compiled });
                }
                if (rules.length) {
                    steps.push({ kind: 'alternatives', operator: split.operator, rules });
                }
                continue;
            }
            const compiled = parseTextRule(split.parts[0], settings);
            if (compiled) steps.push(...compiled);
        }
    }
    return { raw: text, steps, put, empty: steps.length === 0 };
}

/** 方便测试 / 调试：把编译结果还原成可读结构 */
export function describeRule(raw, options) {
    const compiled = compileRule(raw, options);
    return JSON.stringify(compiled, null, 2);
}
