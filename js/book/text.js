/**
 * 书源 - 正文文本化
 *
 * 正文规则通常给的是 HTML（`@html`）或一段带换行的文本。
 * 这里把 HTML 变成阅读器能排版的多段文本：块级标签断段、去脚本样式、压缩空行。
 */

import { parseHtml, normalizeUrl } from '../network.js';
import { decodeEntities } from '../network.js';

const BLOCK_TAGS = new Set([
    'p', 'div', 'section', 'article', 'br', 'li', 'dd', 'dt', 'blockquote',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr', 'pre',
]);

const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'iframe', 'svg', 'canvas', 'button', 'select']);

function walk(node, out) {
    if (!node) return;
    if (node.type === 'text') {
        out.push(node.text);
        return;
    }
    if (node.tag === '#root') {
        for (const child of node.children || []) walk(child, out);
        return;
    }
    if (SKIP_TAGS.has(node.tag)) return;
    const block = BLOCK_TAGS.has(node.tag);
    if (block) out.push('\n\n');
    for (const child of node.children || []) walk(child, out);
    if (block) out.push('\n\n');
}

/** HTML → 多段纯文本 */
export function htmlToText(html) {
    const source = String(html ?? '');
    if (!source) return '';
    if (!/[<>]/.test(source)) return normalizeParagraphs(decodeEntities(source));
    const root = parseHtml(source);
    const parts = [];
    walk(root, parts);
    return normalizeParagraphs(decodeEntities(parts.join('')));
}

/** 从正文 HTML 里取图片地址（懒加载属性也认），去重并补全为绝对地址 */
export function extractImages(html, baseUrl = '') {
    const source = String(html ?? '');
    if (!source.includes('<img')) return [];
    const root = parseHtml(source);
    const out = [];
    const seen = new Set();
    const walk = node => {
        if (node?.type === 'element' && node.tag === 'img') {
            const attrs = node.attrs || {};
            const raw = attrs['data-src'] || attrs['data-original'] || attrs.src || attrs['data-lazy-src'] || '';
            const url = normalizeUrl(raw, baseUrl) || (String(raw).startsWith('data:image/') ? String(raw) : '');
            if (url && !seen.has(url) && out.length < 80) {
                seen.add(url);
                out.push(url);
            }
        }
        for (const child of node?.children || []) walk(child);
    };
    walk(root);
    return out;
}

/** 纯文本整理：统一换行、去行首尾空白、最多保留一个空行 */
export function normalizeParagraphs(text) {
    const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
    const output = [];
    for (const line of lines) {
        const clean = line.replace(/[ \t\f\v\u00a0\u3000]+/g, ' ').trim();
        if (!clean) {
            if (output.length && output[output.length - 1] !== '') output.push('');
            continue;
        }
        output.push(clean);
    }
    while (output.length && output[output.length - 1] === '') output.pop();
    return output.join('\n');
}

/**
 * 有些站把整章塞进一个 <p> 或直接一行，按句号补段落。
 * 只在「全文没有换行且长度超过 800」时启用，避免把正常分段拆坏。
 */
export function rebuildParagraphs(text) {
    const source = String(text ?? '');
    if (!source || source.includes('\n') || source.length < 800) return source;
    const sentences = source.match(/[^。！？!?…]+[。！？!?…]?/g) || [source];
    const chunks = [];
    let buffer = '';
    for (const sentence of sentences) {
        buffer += sentence;
        if (buffer.length >= 220) {
            chunks.push(buffer.trim());
            buffer = '';
        }
    }
    if (buffer.trim()) chunks.push(buffer.trim());
    return chunks.join('\n\n');
}
