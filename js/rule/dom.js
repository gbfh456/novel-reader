/**
 * 规则引擎 - DOM 适配层
 *
 * 浏览器里用 DOMParser + 原生 querySelectorAll（完整 CSS）；
 * Node 测试环境没有 DOM，退回 js/network.js 里的轻量解析器（支持 tag / #id / .class / [attr] / 后代）。
 *
 * 上层（js/rule/execute.js）只认这里导出的函数，不直接碰 DOM 形状。
 */

import { parseHtml, querySelectorAll, textOf } from '../network.js';

const SKIP_TEXT_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'canvas']);

const VOID_TAGS = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

function hasBrowserDom() {
    return typeof DOMParser === 'function' && typeof document !== 'undefined';
}

/** 规整文本：Jsoup 的 text() 语义——连续空白压成一个空格并去首尾 */
export function normalizeSpace(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function escapeHtmlText(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function escapeAttr(value) {
    return escapeHtmlText(value).replace(/"/g, '&quot;');
}

function serialize(node, { inner = false } = {}) {
    if (!node) return '';
    if (node.type === 'text') return escapeHtmlText(node.text);
    if (node.tag === '#root') return (node.children || []).map(child => serialize(child)).join('');
    const attrs = Object.entries(node.attrs || {})
        .map(([key, value]) => (value === '' || value === true ? ` ${key}` : ` ${key}="${escapeAttr(value)}"`))
        .join('');
    const open = `<${node.tag}${attrs}>`;
    if (VOID_TAGS.has(node.tag)) return open;
    const body = (node.children || []).map(child => serialize(child)).join('');
    return inner ? body : `${open}${body}</${node.tag}>`;
}

/**
 * 把 HTML 解析成规则引擎可用的文档。
 * @returns {{kind:'dom'|'lite', root:any, url:string, html:string}}
 */
export function parseDocument(html, url = '') {
    const source = String(html ?? '');
    if (hasBrowserDom()) {
        const doc = new DOMParser().parseFromString(source, 'text/html');
        return {
            kind: 'dom',
            root: doc.body || doc.documentElement,
            doc,
            url,
            html: source,
        };
    }
    return { kind: 'lite', root: parseHtml(source), url, html: source };
}

export function isDocument(value) {
    return Boolean(value && (value.kind === 'dom' || value.kind === 'lite') && value.root);
}

export function isNode(scope, value) {
    if (!value) return false;
    if (scope?.kind === 'dom') return typeof Element !== 'undefined' && value instanceof Element;
    return value.type === 'element';
}

/** 文档内选择（搜索 root 的后代） */
export function selectAll(scope, selector) {
    if (!scope?.root) return [];
    try {
        if (scope.kind === 'dom') return [...scope.root.querySelectorAll(selector)];
        return querySelectorAll(scope.root, selector);
    } catch {
        return [];
    }
}

/** 在某个元素内选择 */
export function selectWithin(scope, node, selector) {
    if (!node) return [];
    try {
        if (scope.kind === 'dom') return [...node.querySelectorAll(selector)];
        return querySelectorAll(node, selector);
    } catch {
        return [];
    }
}

/** 直接子元素 */
export function childElements(scope, node) {
    if (!node) return [];
    if (scope.kind === 'dom') return [...node.children];
    return (node.children || []).filter(child => child.type === 'element');
}

/** 全部后代元素 */
export function descendantElements(scope, node) {
    if (!node) return [];
    if (scope.kind === 'dom') return [...node.querySelectorAll('*')];
    const out = [];
    const walk = current => {
        for (const child of current.children || []) {
            if (child.type !== 'element') continue;
            out.push(child);
            walk(child);
        }
    };
    walk(node);
    return out;
}

export function nodeText(scope, node) {
    if (!node) return '';
    if (scope.kind === 'dom') {
        const parts = [];
        const walk = current => {
            for (const child of current.childNodes || []) {
                if (child.nodeType === 3) {
                    parts.push(child.nodeValue || '');
                    continue;
                }
                if (child.nodeType !== 1) continue;
                if (SKIP_TEXT_TAGS.has(String(child.tagName || '').toLowerCase())) continue;
                walk(child);
            }
        };
        walk(node);
        return normalizeSpace(parts.join(''));
    }
    // 轻量 DOM：跳过 script/style 等，避免把 CSS 当正文
    const parts = [];
    const walk = current => {
        for (const child of current.children || []) {
            if (child.type === 'text') {
                parts.push(child.text);
                continue;
            }
            if (child.type !== 'element' || SKIP_TEXT_TAGS.has(child.tag)) continue;
            walk(child);
        }
    };
    walk(node);
    return normalizeSpace(parts.join(''));
}

/** 只取元素自己的文本节点（不含子元素里的文字），对应 Jsoup 的 ownText */
export function nodeOwnText(scope, node) {
    if (!node) return '';
    if (scope.kind === 'dom') {
        const parts = [];
        for (const child of node.childNodes || []) {
            if (child.nodeType === 3) parts.push(child.nodeValue || '');
        }
        return normalizeSpace(parts.join(' '));
    }
    return normalizeSpace((node.children || [])
        .filter(child => child.type === 'text')
        .map(child => child.text)
        .join(' '));
}

/** 元素直接文本节点列表，用换行连接（对应 Jsoup 的 textNodes） */
export function nodeTextNodes(scope, node) {
    if (!node) return '';
    const list = [];
    if (scope.kind === 'dom') {
        for (const child of node.childNodes || []) {
            if (child.nodeType !== 3) continue;
            const text = String(child.nodeValue || '').trim();
            if (text) list.push(text);
        }
    } else {
        for (const child of node.children || []) {
            if (child.type !== 'text') continue;
            const text = String(child.text || '').trim();
            if (text) list.push(text);
        }
    }
    return list.join('\n');
}

export function nodeInnerHtml(scope, node) {
    if (!node) return '';
    if (scope.kind === 'dom') {
        const clone = node.cloneNode(true);
        for (const tag of ['script', 'style']) {
            clone.querySelectorAll?.(tag).forEach(item => item.remove());
        }
        return clone.innerHTML || '';
    }
    return (node.children || []).map(child => serialize(child)).join('');
}

export function nodeOuterHtml(scope, node) {
    if (!node) return '';
    if (scope.kind === 'dom') return node.outerHTML || '';
    return serialize(node);
}

export function nodeAttr(scope, node, name) {
    if (!node || !name) return '';
    if (scope.kind === 'dom') return String(node.getAttribute(name) ?? '');
    return String(node.attrs?.[name] ?? '');
}

export function nodeTag(scope, node) {
    if (!node) return '';
    if (scope.kind === 'dom') return String(node.tagName || '').toLowerCase();
    return String(node.tag || '').toLowerCase();
}

/** 把节点数组的文本拼成一段（去重） */
export function joinNodeText(scope, nodes) {
    return nodes.map(node => nodeText(scope, node)).filter(Boolean).join('\n');
}
