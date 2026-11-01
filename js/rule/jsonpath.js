/**
 * 规则引擎 - JSONPath 子集
 *
 * Legado 用 jayway JsonPath；这里实现书源里最常见的写法：
 *   $  .key  ..key  ['key']  [0]  [-1]  [*]  [start:end(:step)]
 *   [?( @.field == 'x' )]  [?( @.field =~ /re/ )]  [?( @.n > 3 )]
 *
 * 注意：`&&` / `||` 属于阅读的规则分隔符，由 js/rule/execute.js 在解析外层先切开，
 * 所以过滤器里不支持布尔组合（真实书源也很少用）。
 */

function parsePath(path) {
    const source = String(path ?? '').trim();
    if (!source.startsWith('$')) throw new Error(`JSONPath 必须以 $ 开头：${path}`);
    const steps = [];
    let index = 1;
    const length = source.length;

    const readQuoted = quote => {
        let out = '';
        index++;
        while (index < length) {
            const char = source[index];
            if (char === '\\' && index + 1 < length) {
                out += source[index + 1];
                index += 2;
                continue;
            }
            if (char === quote) {
                index++;
                return out;
            }
            out += char;
            index++;
        }
        throw new Error(`JSONPath 引号没有闭合：${path}`);
    };

    while (index < length) {
        const char = source[index];
        if (char === '.') {
            if (source[index + 1] === '.') {
                index += 2;
                let name = '';
                while (index < length && /[\w$*-]/.test(source[index])) {
                    name += source[index];
                    index++;
                }
                if (!name) throw new Error(`JSONPath 递归写法缺少字段：${path}`);
                steps.push({ type: 'deep', name: name === '*' ? '*' : name });
                continue;
            }
            index++;
            if (source[index] === '*') {
                steps.push({ type: 'wildcard' });
                index++;
                continue;
            }
            let name = '';
            while (index < length && /[^.[\]]/.test(source[index])) {
                name += source[index];
                index++;
            }
            if (!name) throw new Error(`JSONPath 缺少字段名：${path}`);
            steps.push({ type: 'key', name });
            continue;
        }
        if (char === '[') {
            index++;
            while (source[index] === ' ') index++;
            if (source[index] === '*') {
                steps.push({ type: 'wildcard' });
                index++;
                while (source[index] === ' ') index++;
                if (source[index] !== ']') throw new Error(`JSONPath 通配没有闭合：${path}`);
                index++;
                continue;
            }
            if (source[index] === '?' && source[index + 1] === '(') {
                index += 2;
                let depth = 1;
                let expression = '';
                let quote = '';
                while (index < length && depth > 0) {
                    const current = source[index];
                    if (quote) {
                        expression += current;
                        if (current === quote && source[index - 1] !== '\\') quote = '';
                        index++;
                        continue;
                    }
                    if (current === '\'' || current === '"') {
                        quote = current;
                        expression += current;
                        index++;
                        continue;
                    }
                    if (current === '(') depth++;
                    else if (current === ')') {
                        depth--;
                        if (depth === 0) {
                            index++;
                            break;
                        }
                    }
                    expression += current;
                    index++;
                }
                while (source[index] === ' ') index++;
                if (source[index] !== ']') throw new Error(`JSONPath 过滤器没有闭合：${path}`);
                index++;
                steps.push({ type: 'filter', expression: expression.trim() });
                continue;
            }
            if (source[index] === '\'' || source[index] === '"') {
                const quote = source[index];
                const name = readQuoted(quote);
                while (source[index] === ' ') index++;
                if (source[index] !== ']') throw new Error(`JSONPath 下标没有闭合：${path}`);
                index++;
                steps.push({ type: 'key', name });
                continue;
            }
            let body = '';
            while (index < length && source[index] !== ']') {
                body += source[index];
                index++;
            }
            if (source[index] !== ']') throw new Error(`JSONPath 下标没有闭合：${path}`);
            index++;
            const token = body.trim();
            if (token.includes(':')) {
                const [start, end, step] = token.split(':').map(part => (part.trim() === '' ? null : Number(part)));
                steps.push({ type: 'slice', start, end, step });
            } else {
                const number = Number(token);
                if (!Number.isFinite(number)) throw new Error(`JSONPath 下标不是数字：${token}`);
                steps.push({ type: 'index', index: number });
            }
            continue;
        }
        if (char === ' ') {
            index++;
            continue;
        }
        // 容错：`$.data[*].name` 之类已经覆盖；其它字符直接当字段名读掉
        let name = '';
        while (index < length && /[^.[\]]/.test(source[index])) {
            name += source[index];
            index++;
        }
        if (name) steps.push({ type: 'key', name });
        else throw new Error(`JSONPath 无法解析：${path}（位置 ${index}）`);
    }
    return steps;
}

function collectDeep(value, name, out) {
    if (Array.isArray(value)) {
        for (const item of value) collectDeep(item, name, out);
        return;
    }
    if (!value || typeof value !== 'object') return;
    if (name === '*') {
        for (const item of Object.values(value)) {
            out.push(item);
            collectDeep(item, name, out);
        }
        return;
    }
    if (Object.prototype.hasOwnProperty.call(value, name)) out.push(value[name]);
    for (const item of Object.values(value)) collectDeep(item, name, out);
}

function readField(value, path) {
    let current = value;
    for (const key of String(path).split('.').filter(Boolean)) {
        if (current == null) return undefined;
        current = current[key];
    }
    return current;
}

function parseLiteral(text) {
    const value = text.trim();
    if ((value.startsWith('\'') && value.endsWith('\'')) || (value.startsWith('"') && value.endsWith('"'))) {
        return value.slice(1, -1);
    }
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (value === 'null') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : value;
}

function matchFilter(item, expression) {
    const text = String(expression || '').trim();
    const match = text.match(/^@\.?([\w.$]*)\s*(==|!=|=~|>=|<=|>|<)\s*(.+)$/);
    if (!match) return Boolean(item);
    const [, path, operator, rawValue] = match;
    const actual = path ? readField(item, path) : item;
    if (operator === '=~') {
        const literal = rawValue.trim().match(/^\/(.*)\/([a-z]*)$/i);
        const regex = literal ? new RegExp(literal[1], literal[2]) : new RegExp(String(parseLiteral(rawValue)));
        return regex.test(String(actual ?? ''));
    }
    const expected = parseLiteral(rawValue);
    switch (operator) {
        case '==': return actual === expected || String(actual) === String(expected);
        case '!=': return !(actual === expected || String(actual) === String(expected));
        case '>': return Number(actual) > Number(expected);
        case '>=': return Number(actual) >= Number(expected);
        case '<': return Number(actual) < Number(expected);
        case '<=': return Number(actual) <= Number(expected);
        default: return false;
    }
}

function applyStep(values, step) {
    const out = [];
    for (const value of values) {
        if (step.type === 'key') {
            if (value && typeof value === 'object' && step.name in value) out.push(value[step.name]);
            continue;
        }
        if (step.type === 'deep') {
            collectDeep(value, step.name, out);
            continue;
        }
        if (step.type === 'wildcard') {
            if (Array.isArray(value)) out.push(...value);
            else if (value && typeof value === 'object') out.push(...Object.values(value));
            continue;
        }
        if (step.type === 'index') {
            if (!Array.isArray(value)) continue;
            const index = step.index < 0 ? value.length + step.index : step.index;
            if (index >= 0 && index < value.length) out.push(value[index]);
            continue;
        }
        if (step.type === 'slice') {
            if (!Array.isArray(value)) continue;
            const { start, end, step: stride } = step;
            const length = value.length;
            const from = start == null ? 0 : (start < 0 ? length + start : start);
            const to = end == null ? length : (end < 0 ? length + end : end);
            const stepSize = stride == null ? 1 : stride;
            if (stepSize === 0) continue;
            if (stepSize > 0) {
                for (let i = Math.max(0, from); i < Math.min(length, to); i += stepSize) out.push(value[i]);
            } else {
                for (let i = Math.min(length - 1, from); i > Math.max(-1, to); i += stepSize) out.push(value[i]);
            }
            continue;
        }
        if (step.type === 'filter') {
            const list = Array.isArray(value) ? value : [value];
            for (const item of list) {
                if (matchFilter(item, step.expression)) out.push(item);
            }
        }
    }
    return out;
}

/** 解析 JSON 文本；失败时返回 undefined，交给上层报错 */
export function parseJsonLoose(text) {
    const source = String(text ?? '').trim();
    if (!source) return undefined;
    try {
        return JSON.parse(source);
    } catch {
        const start = source.indexOf('{');
        const arrayStart = source.indexOf('[');
        const from = start < 0 ? arrayStart : (arrayStart < 0 ? start : Math.min(start, arrayStart));
        if (from < 0) return undefined;
        try {
            return JSON.parse(source.slice(from));
        } catch {
            return undefined;
        }
    }
}

/** 执行 JSONPath，返回命中数组 */
export function queryJsonPath(data, path) {
    const steps = parsePath(path);
    let values = [data];
    for (const step of steps) values = applyStep(values, step);
    return values;
}

/** 取第一个命中值 */
export function readJsonPath(data, path) {
    return queryJsonPath(data, path)[0];
}

export { parsePath as parseJsonPath };
