/**
 * 替换净化规则
 *
 * 对齐「阅读」的替换规则：一组正则替换，可限定作用范围（正文 / 标题），
 * 可导入 Legado 的替换规则 JSON。书源自带的 `ruleContent.replaceRegex` 仍然先执行，
 * 这里的规则在它之后、入库之前应用。
 */

export const REPLACE_SCOPES = ['content', 'title', 'both'];

export function normalizeReplaceRule(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const pattern = String(raw.pattern ?? raw.regex ?? '').trim();
    if (!pattern) return null;
    const name = String(raw.name || pattern).trim().slice(0, 60);
    return {
        id: String(raw.id || '').trim() || `rule_${hash(name + pattern)}`,
        name,
        pattern,
        replacement: String(raw.replacement ?? ''),
        isRegex: raw.isRegex !== false,
        scope: REPLACE_SCOPES.includes(raw.scope) ? raw.scope : 'content',
        enabled: raw.enabled !== false,
    };
}

export function normalizeReplaceRules(list) {
    return (Array.isArray(list) ? list : [])
        .map(normalizeReplaceRule)
        .filter(Boolean);
}

function hash(input) {
    let value = 0;
    const source = String(input || '');
    for (let index = 0; index < source.length; index++) {
        value = ((value << 5) + value + source.charCodeAt(index)) | 0;
    }
    return Math.abs(value).toString(36);
}

/** 应用一组规则；非法正则会被跳过（不影响其它规则） */
export function applyReplaceRules(text, rules, scope = 'content') {
    let output = String(text ?? '');
    const active = normalizeReplaceRules(rules).filter(rule => (
        rule.enabled && (rule.scope === 'both' || rule.scope === scope)
    ));
    for (const rule of active) {
        try {
            if (rule.isRegex) {
                output = output.replace(new RegExp(rule.pattern, 'g'), rule.replacement);
            } else {
                output = output.split(rule.pattern).join(rule.replacement);
            }
        } catch {
            // 单条正则写错不影响其它规则
        }
    }
    return output;
}

/** 导入：数组 / {rules:[]} / JSON 字符串 */
export function importReplaceRules(input) {
    let data = input;
    if (typeof data === 'string') {
        const text = data.trim();
        if (!text) throw new Error('先粘贴替换规则 JSON');
        try {
            data = JSON.parse(text);
        } catch (error) {
            throw new Error(`替换规则不是合法 JSON：${error.message}`);
        }
    }
    const list = Array.isArray(data) ? data : (Array.isArray(data?.rules) ? data.rules : [data]);
    const rules = normalizeReplaceRules(list);
    if (!rules.length) throw new Error('没有可导入的替换规则（需要 pattern / regex）');
    const warnings = [];
    for (const rule of rules) {
        if (rule.isRegex) {
            try {
                new RegExp(rule.pattern);
            } catch (error) {
                warnings.push(`「${rule.name}」正则不合法：${error.message}`);
            }
        }
    }
    return { rules, warnings };
}

export function exportReplaceRules(rules) {
    return normalizeReplaceRules(rules).map(rule => ({
        name: rule.name,
        pattern: rule.pattern,
        replacement: rule.replacement,
        isRegex: rule.isRegex,
        scope: rule.scope,
        enabled: rule.enabled,
    }));
}
