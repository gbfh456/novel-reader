/**
 * 小说阅读器 - 文件解析与章节切分
 *
 * 支持：TXT / Markdown / HTML / EPUB / DOCX
 * 说明：PDF 需要完整的排版解析引擎，本插件不内置；可以先用其它工具转成 TXT/EPUB。
 */

import { countChars } from './util.js';

const MAX_FILE_BYTES = 160 * 1024 * 1024;

const BLOCK_TAGS = new Set([
    'p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside',
    'li', 'ul', 'ol', 'tr', 'table', 'blockquote', 'pre', 'figure', 'figcaption',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr',
]);

const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'svg', 'iframe', 'canvas', 'template']);

/* ------------------------------------------------------------------ */
/* 文本解码                                                            */
/* ------------------------------------------------------------------ */

function scoreDecodedText(text) {
    let bad = 0;
    let cjk = 0;
    let control = 0;
    for (const ch of text) {
        const cp = ch.codePointAt(0);
        if (cp === 0xfffd) bad += 200;
        else if (cp < 32 && cp !== 9 && cp !== 10 && cp !== 13) control++;
        else if (cp >= 0x4e00 && cp <= 0x9fff) cjk++;
        else if (cp >= 0xe000 && cp <= 0xf8ff) bad += 30;
    }
    bad += control * 20;
    bad += (text.match(/锟斤拷|烫烫|ï¿½|Ã¤|Ã©|Â»/g) || []).length * 80;
    // 轻微偏向包含中文的结果
    return bad - Math.min(cjk, 5000) * 0.001;
}

function decodeWith(bytes, encoding, fatal = false) {
    return new TextDecoder(encoding, { fatal }).decode(bytes);
}

/** 自动识别编码并解码 */
export function decodeBookBytes(buffer) {
    const bytes = new Uint8Array(buffer);
    if (bytes.length === 0) return { text: '', encoding: 'utf-8' };

    // BOM
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8-bom' };
    }
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
        return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le' };
    }
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
        return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be' };
    }

    // UTF-16 无 BOM 的粗略判断：大量偶数位为 0
    if (bytes.length > 8) {
        let zeroEven = 0;
        let zeroOdd = 0;
        const sample = Math.min(bytes.length, 4096);
        for (let i = 0; i < sample; i += 2) {
            if (bytes[i] === 0) zeroEven++;
            if (bytes[i + 1] === 0) zeroOdd++;
        }
        const half = Math.floor(sample / 2);
        if (zeroEven > half * 0.35 || zeroOdd > half * 0.35) {
            const encoding = zeroEven > zeroOdd ? 'utf-16be' : 'utf-16le';
            try {
                return { text: new TextDecoder(encoding).decode(bytes), encoding };
            } catch {
                // 继续走普通流程
            }
        }
    }

    try {
        const text = decodeWith(bytes, 'utf-8', true);
        return { text, encoding: 'utf-8' };
    } catch {
        // 不是合法 UTF-8，尝试常见中文编码
    }

    const candidates = [];
    for (const encoding of ['gb18030', 'gbk', 'big5', 'utf-16le', 'utf-16be']) {
        try {
            const text = decodeWith(bytes, encoding);
            candidates.push({ encoding, text, score: scoreDecodedText(text) });
        } catch {
            // 浏览器不支持该编码，跳过
        }
    }
    candidates.sort((a, b) => a.score - b.score);
    if (candidates.length === 0) {
        // 最后兜底：替换非法字节
        return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'utf-8-lossy' };
    }
    return { text: candidates[0].text, encoding: candidates[0].encoding };
}

/* ------------------------------------------------------------------ */
/* 文本规范化                                                          */
/* ------------------------------------------------------------------ */

/** 统一换行、去零宽字符、压缩空行 */
export function normalizeText(input) {
    let text = String(input ?? '');
    text = text.replace(/^\uFEFF/, '');
    text = text.replace(/\r\n?/g, '\n');
    text = text.replace(/\u0000/g, '');
    text = text.replace(/\u00a0/g, ' ');
    text = text.replace(/[\u200b-\u200f\u202a-\u202e]/g, '');
    text = text.replace(/[ \t]+\n/g, '\n');
    text = text.replace(/\n[ \t]+\n/g, '\n\n');
    text = text.replace(/\n{3,}/g, '\n\n');
    return text.trim();
}

/* ------------------------------------------------------------------ */
/* 章节识别                                                            */
/* ------------------------------------------------------------------ */

const CHAPTER_PATTERNS = [
    /^第\s*[0-9０-９零〇一二三四五六七八九十百千万两]{1,12}\s*[章节回卷集部篇幕话折]/,
    /^(?:序章|序言|楔子|引子|前言|后记|尾声|终章|大结局|番外(?:篇)?|外传|内容简介|作者的话|正文)(?:\s*[0-9０-９零〇一二三四五六七八九十百]+)?(?:\s|$|[：:、.．·\-—（(])/,
    /^(?:Chapter|CHAPTER)\s+[0-9IVXLCivxlc]+(?:\s|$|[：:.\-—])/,
    /^#{1,3}\s+\S/,
];

const VOLUME_PATTERN = /^第\s*[0-9０-９零〇一二三四五六七八九十百千万两]{1,12}\s*[卷部]/;

function stripHeadingMarks(line) {
    let title = String(line || '').trim();
    title = title.replace(/^#{1,6}\s*/, '');
    title = title.replace(/#+\s*$/, '');
    title = title.replace(/^[-=*_\s]+|[-=*_\s]+$/g, '');
    title = title.replace(/\*\*|__|`/g, '');
    title = title.replace(/\s+/g, ' ').trim();
    return title.slice(0, 80);
}

/** 判断一行是否像章节标题 */
export function isChapterHeading(line) {
    const text = String(line || '').trim();
    if (!text || text.length > 80) return false;
    if (/[。！？，、；：,;]$/.test(text)) return false;
    // 纯数字 / 纯符号不算
    if (!/[\u4e00-\u9fffA-Za-z0-9０-９]/.test(text)) return false;
    return CHAPTER_PATTERNS.some(pattern => pattern.test(text));
}

/** 用段落切分超长文本（没有章节标题时的兜底） */
export function chunkText(text, maxChars = 9000) {
    const source = String(text || '');
    if (countChars(source) <= maxChars) return [source];

    const paragraphs = source.split(/\n+/);
    const chunks = [];
    let current = '';

    const pushCurrent = () => {
        if (current.trim()) chunks.push(current.trim());
        current = '';
    };

    for (const raw of paragraphs) {
        const paragraph = raw.trim();
        if (!paragraph) continue;
        if (paragraph.length > maxChars) {
            pushCurrent();
            // 先按句号切，再硬切
            const sentences = paragraph.split(/(?<=[。！？!?；;])/);
            let buffer = '';
            for (const sentence of sentences) {
                if (sentence.length > maxChars) {
                    if (buffer) {
                        chunks.push(buffer.trim());
                        buffer = '';
                    }
                    for (let i = 0; i < sentence.length; i += maxChars) {
                        chunks.push(sentence.slice(i, i + maxChars));
                    }
                    continue;
                }
                if (countChars(buffer) + countChars(sentence) > maxChars) {
                    if (buffer.trim()) chunks.push(buffer.trim());
                    buffer = sentence;
                } else {
                    buffer += sentence;
                }
            }
            if (buffer.trim()) chunks.push(buffer.trim());
            continue;
        }
        if (countChars(current) + countChars(paragraph) + 1 > maxChars) {
            pushCurrent();
            current = paragraph;
        } else {
            current += (current ? '\n' : '') + paragraph;
        }
    }
    pushCurrent();
    return chunks.length ? chunks : [source];
}

/**
 * 把全文切分成章节。
 * @param {string} text 已规范化的全文
 * @param {{maxChars?: number}} options
 * @returns {{title: string, content: string}[]}
 */
export function splitChapters(text, options = {}) {
    const source = normalizeText(text);
    if (!source) return [];
    const maxChars = Math.max(2000, Number(options.maxChars) || 9000);

    const lines = source.split('\n');
    const headings = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        if (isChapterHeading(line)) {
            headings.push({ line: i, title: stripHeadingMarks(line) || `第 ${headings.length + 1} 章` });
        }
    }

    if (headings.length === 0) {
        const chunks = chunkText(source, maxChars);
        if (chunks.length === 1) return [{ title: '全文', content: source }];
        return chunks.map((content, index) => ({
            title: `第 ${index + 1} 节`,
            content,
        }));
    }

    const preface = lines.slice(0, headings[0].line).join('\n').trim();
    const raw = [];
    if (preface.length >= 120) {
        raw.push({ title: '开篇', content: preface, volume: false });
    }

    for (let i = 0; i < headings.length; i++) {
        const heading = headings[i];
        const nextLine = headings[i + 1]?.line ?? lines.length;
        const content = lines.slice(heading.line + 1, nextLine).join('\n').trim();
        raw.push({
            title: heading.title,
            content,
            volume: VOLUME_PATTERN.test(heading.title),
        });
    }

    const chapters = [];
    let pendingPrefix = '';
    let pendingText = '';

    for (const section of raw) {
        // 卷标题通常只有标题没有正文，作为下一章的标题前缀
        if (section.volume && section.content.length < 500) {
            pendingPrefix = pendingPrefix ? `${pendingPrefix} · ${section.title}` : section.title;
            if (section.content) pendingText += (pendingText ? '\n' : '') + section.content;
            continue;
        }

        if (section.content.length < 20) {
            if (section.title) {
                pendingPrefix = pendingPrefix ? `${pendingPrefix} · ${section.title}` : section.title;
            }
            if (section.content) pendingText += (pendingText ? '\n' : '') + section.content;
            continue;
        }

        let title = section.title;
        if (pendingPrefix) {
            title = `${pendingPrefix} · ${title}`;
            pendingPrefix = '';
        }
        let content = section.content;
        if (pendingText) {
            content = `${pendingText}\n${content}`;
            pendingText = '';
        }
        chapters.push({ title, content });
    }

    if (pendingPrefix && chapters.length > 0) {
        chapters[chapters.length - 1].title += ` · ${pendingPrefix}`;
    }
    if (pendingText && chapters.length > 0) {
        chapters[chapters.length - 1].content += `\n${pendingText}`;
    }

    // 全是短章节（例如只有卷标题）时，退化为整本/等分
    if (chapters.length === 0) {
        const chunks = chunkText(source, maxChars);
        return chunks.map((content, index) => ({
            title: chunks.length === 1 ? '全文' : `第 ${index + 1} 节`,
            content,
        }));
    }

    return chapters;
}

/* ------------------------------------------------------------------ */
/* HTML / EPUB / DOCX                                                  */
/* ------------------------------------------------------------------ */

function parseHTML(html) {
    return new DOMParser().parseFromString(String(html ?? ''), 'text/html');
}

function parseXML(xml) {
    return new DOMParser().parseFromString(String(xml ?? ''), 'application/xml');
}

function textOf(node) {
    return String(node?.textContent || '').replace(/\s+/g, ' ').trim();
}

/** 把 DOM 节点转成保留段落的纯文本 */
function domToText(root) {
    if (!root) return '';
    const parts = [];

    const walk = (node) => {
        if (!node) return;
        if (node.nodeType === Node.TEXT_NODE) {
            parts.push(node.nodeValue || '');
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const tag = node.tagName.toLowerCase();
        if (SKIP_TAGS.has(tag)) return;
        if (tag === 'br') {
            parts.push('\n');
            return;
        }
        const isBlock = BLOCK_TAGS.has(tag);
        if (isBlock) parts.push('\n');
        for (const child of node.childNodes) walk(child);
        if (isBlock) parts.push('\n');
    };

    walk(root);
    return normalizeText(parts.join(''));
}

/** 从 HTML 提取标题与文本；有多个 h1/h2/h3 时按标题切章 */
export function htmlToChapters(html, fallbackTitle = '') {
    const doc = parseHTML(html);
    doc.querySelectorAll('script,style,noscript,svg,iframe').forEach(node => node.remove());

    const pageTitle = textOf(doc.querySelector('title')) || textOf(doc.querySelector('h1')) || fallbackTitle;
    const body = doc.body || doc.documentElement;
    if (!body) return { title: pageTitle, chapters: [] };

    const sections = [];
    let current = { title: '', parts: [] };
    let headingCount = 0;

    const walk = (node) => {
        if (!node) return;
        if (node.nodeType === Node.TEXT_NODE) {
            current.parts.push(node.nodeValue || '');
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const tag = node.tagName.toLowerCase();
        if (SKIP_TAGS.has(tag)) return;

        if (/^h[1-3]$/.test(tag)) {
            const title = textOf(node);
            if (title) {
                if (current.parts.join('').trim()) sections.push(current);
                current = { title, parts: [] };
                headingCount++;
                return;
            }
        }

        if (tag === 'br') {
            current.parts.push('\n');
            return;
        }
        const isBlock = BLOCK_TAGS.has(tag);
        if (isBlock) current.parts.push('\n');
        for (const child of node.childNodes) walk(child);
        if (isBlock) current.parts.push('\n');
    };

    walk(body);
    if (current.parts.join('').trim()) sections.push(current);

    const valid = sections
        .map(section => ({ title: stripHeadingMarks(section.title), content: normalizeText(section.parts.join('')) }))
        .filter(section => section.content.length >= 30);

    if (headingCount >= 2 && valid.length >= 2) {
        // 如果正文里还有明显的章节标题（有些网站每个 h1 是一卷），继续细分
        const merged = [];
        for (const section of valid) {
            const sub = splitChapters(section.content, { maxChars: 12000 });
            if (sub.length > 1 && !isChapterHeading(section.title)) {
                for (const child of sub) {
                    merged.push({
                        title: child.title === '全文' ? section.title : `${section.title} · ${child.title}`,
                        content: child.content,
                    });
                }
            } else {
                merged.push(section);
            }
        }
        return { title: pageTitle, chapters: merged };
    }

    const flatText = normalizeText(valid.map(section => `${section.title ? `${section.title}\n` : ''}${section.content}`).join('\n\n'));
    return { title: pageTitle, chapters: splitChapters(flatText, { maxChars: 12000 }) };
}

async function ensureJSZip() {
    if (globalThis.JSZip) return globalThis.JSZip;
    try {
        await import('/lib/jszip.min.js');
    } catch (error) {
        throw new Error(`解压组件加载失败：${error?.message || error}`);
    }
    if (!globalThis.JSZip) throw new Error('解压组件不可用，请确认酒馆版本包含 lib/jszip.min.js');
    return globalThis.JSZip;
}

function decodeURIComponentSafe(value) {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function joinZipPath(baseDir, href) {
    const cleanHref = decodeURIComponentSafe(String(href || '').split('#')[0]);
    if (/^(?:[a-z]+:)?\/\//i.test(cleanHref)) return cleanHref;
    const parts = `${baseDir ? `${baseDir}/` : ''}${cleanHref}`.split('/');
    const output = [];
    for (const part of parts) {
        if (!part || part === '.') continue;
        if (part === '..') output.pop();
        else output.push(part);
    }
    return output.join('/');
}

function dirName(path) {
    const index = String(path || '').lastIndexOf('/');
    return index === -1 ? '' : path.slice(0, index);
}

function findZipEntry(zip, path) {
    if (!path) return null;
    const direct = zip.file(path);
    if (direct) return direct;
    const decoded = decodeURIComponentSafe(path);
    const directDecoded = zip.file(decoded);
    if (directDecoded) return directDecoded;
    const target = decoded.toLowerCase();
    return zip.file((name) => name.toLowerCase() === target) || null;
}

async function readZipText(zip, path) {
    const entry = findZipEntry(zip, path);
    if (!entry) return '';
    try {
        return await entry.async('string');
    } catch {
        const buffer = await entry.async('uint8array');
        return decodeBookBytes(buffer.buffer).text;
    }
}

function xmlElements(root, localName) {
    if (!root) return [];
    const byNs = root.getElementsByTagNameNS('*', localName);
    if (byNs && byNs.length) return Array.from(byNs);
    return Array.from(root.getElementsByTagName(localName));
}

function xmlAttr(element, name) {
    if (!element) return '';
    return element.getAttribute(name) || element.getAttribute(`w:${name}`) || element.getAttribute(`xml:${name}`) || '';
}

/** EPUB 解析 */
async function parseEpub(buffer, fileName) {
    const JSZip = await ensureJSZip();
    let zip;
    try {
        zip = await JSZip.loadAsync(buffer);
    } catch (error) {
        throw new Error(`EPUB 解压失败：${error?.message || error}`);
    }

    const containerXml = await readZipText(zip, 'META-INF/container.xml');
    if (!containerXml) throw new Error('不是有效的 EPUB：缺少 META-INF/container.xml');

    const container = parseXML(containerXml);
    const rootfile = xmlElements(container, 'rootfile')[0];
    const opfPath = rootfile?.getAttribute('full-path') || '';
    if (!opfPath) throw new Error('不是有效的 EPUB：找不到 OPF 文件');

    const opfXml = await readZipText(zip, opfPath);
    if (!opfXml) throw new Error('不是有效的 EPUB：OPF 文件为空');
    const opf = parseXML(opfXml);
    const opfDir = dirName(opfPath);

    const manifest = new Map();
    for (const item of xmlElements(opf, 'item')) {
        const id = item.getAttribute('id');
        if (!id) continue;
        manifest.set(id, {
            href: item.getAttribute('href') || '',
            mediaType: item.getAttribute('media-type') || '',
            properties: item.getAttribute('properties') || '',
        });
    }

    let title = '';
    for (const element of xmlElements(opf, 'title')) {
        const candidate = textOf(element);
        if (candidate) {
            title = candidate;
            break;
        }
    }
    let author = '';
    for (const element of xmlElements(opf, 'creator')) {
        const candidate = textOf(element);
        if (candidate) {
            author = candidate;
            break;
        }
    }

    const spineIds = xmlElements(opf, 'itemref')
        .map(itemref => itemref.getAttribute('idref'))
        .filter(Boolean);

    const ordered = [];
    const seen = new Set();
    for (const id of spineIds) {
        const item = manifest.get(id);
        if (!item) continue;
        if (!/html|xml/i.test(item.mediaType) && !/\.x?html?$/i.test(item.href)) continue;
        const path = joinZipPath(opfDir, item.href);
        if (seen.has(path)) continue;
        seen.add(path);
        ordered.push({ path, title: '' });
    }

    // 有些 EPUB 的 spine 为空，退化为按文件名排序的 xhtml
    if (ordered.length === 0) {
        const names = Object.keys(zip.files)
            .filter(name => /\.x?html?$/i.test(name) && !/^META-INF\//i.test(name))
            .sort((a, b) => a.localeCompare(b, 'zh-CN'));
        for (const path of names) ordered.push({ path, title: '' });
    }

    const chapters = [];
    for (const entry of ordered) {
        const html = await readZipText(zip, entry.path);
        if (!html) continue;
        const doc = parseHTML(html);
        doc.querySelectorAll('script,style,noscript,svg,iframe').forEach(node => node.remove());

        const heading = doc.querySelector('h1,h2,h3');
        let chapterTitle = textOf(heading) || textOf(doc.querySelector('title')) || entry.title || '';
        chapterTitle = stripHeadingMarks(chapterTitle);
        if (!chapterTitle || /^(目录|contents?|cover|版权|copyright)$/i.test(chapterTitle)) {
            chapterTitle = `第 ${chapters.length + 1} 章`;
        }

        let content = domToText(doc.body || doc.documentElement);
        if (content.length < 50) continue;

        // 有些文件正文第一行就是标题，去掉避免重复
        const firstLine = content.split('\n').find(line => line.trim());
        if (firstLine && chapterTitle && firstLine.trim() === chapterTitle) {
            content = content.split('\n').filter((line, index) => !(index === 0 && line.trim() === chapterTitle)).join('\n');
        }

        chapters.push({ title: chapterTitle, content: normalizeText(content) });
    }

    if (chapters.length === 0) throw new Error('EPUB 中没有找到可读的正文');
    if (chapters.length === 1) {
        const expanded = splitChapters(chapters[0].content, { maxChars: 12000 });
        if (expanded.length > 1) return { title: title || fileName, author, chapters: expanded };
    }
    return { title: title || fileName, author, chapters };
}

function docxParagraphText(paragraph) {
    const parts = [];
    const walk = (node) => {
        if (!node) return;
        if (node.nodeType === Node.TEXT_NODE) {
            parts.push(node.nodeValue || '');
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const local = (node.localName || node.nodeName || '').toLowerCase();
        if (local === 't') {
            parts.push(node.textContent || '');
            return;
        }
        if (local === 'tab') {
            parts.push('\t');
            return;
        }
        if (local === 'br' || local === 'cr') {
            parts.push('\n');
            return;
        }
        for (const child of node.childNodes) walk(child);
    };
    walk(paragraph);
    return parts.join('').replace(/\s+$/g, '');
}

function docxParagraphStyle(paragraph) {
    for (const element of xmlElements(paragraph, 'pStyle')) {
        const value = xmlAttr(element, 'val');
        if (value) return value;
    }
    return '';
}

async function parseDocx(buffer, fileName) {
    const JSZip = await ensureJSZip();
    let zip;
    try {
        zip = await JSZip.loadAsync(buffer);
    } catch (error) {
        throw new Error(`DOCX 解压失败：${error?.message || error}`);
    }

    const documentXml = await readZipText(zip, 'word/document.xml');
    if (!documentXml) throw new Error('不是有效的 DOCX：缺少 word/document.xml');
    const doc = parseXML(documentXml);

    let title = fileName;
    let author = '';
    try {
        const coreXml = await readZipText(zip, 'docProps/core.xml');
        if (coreXml) {
            const core = parseXML(coreXml);
            title = textOf(xmlElements(core, 'title')[0]) || title;
            author = textOf(xmlElements(core, 'creator')[0]) || '';
        }
    } catch {
        // ignore
    }

    const paragraphs = [];
    for (const paragraph of xmlElements(doc, 'p')) {
        const text = docxParagraphText(paragraph).trim();
        const style = docxParagraphStyle(paragraph);
        if (!text) {
            paragraphs.push({ text: '', heading: false });
            continue;
        }
        const heading = /^(?:heading|title|subtitle|标题)/i.test(style) || isChapterHeading(text);
        paragraphs.push({ text, heading });
    }

    const chapters = [];
    let current = { title: '', parts: [] };
    let sawHeading = false;

    const flush = () => {
        const content = normalizeText(current.parts.join('\n'));
        if (content.length >= 20) {
            chapters.push({ title: stripHeadingMarks(current.title) || `第 ${chapters.length + 1} 章`, content });
        }
        current = { title: '', parts: [] };
    };

    for (const paragraph of paragraphs) {
        if (!paragraph.text) continue;
        if (paragraph.heading) {
            sawHeading = true;
            flush();
            current.title = paragraph.text;
            continue;
        }
        current.parts.push(paragraph.text);
    }
    flush();

    if (!sawHeading || chapters.length <= 1) {
        const flat = normalizeText(paragraphs.map(paragraph => paragraph.text).filter(Boolean).join('\n'));
        const split = splitChapters(flat, { maxChars: 12000 });
        if (split.length > 1) return { title, author, chapters: split };
    }

    if (chapters.length === 0) throw new Error('DOCX 中没有找到可读的正文');
    return { title, author, chapters };
}

/* ------------------------------------------------------------------ */
/* 对外入口                                                            */
/* ------------------------------------------------------------------ */

function cleanBookTitle(name) {
    return String(name || '')
        .replace(/\.[^.]+$/, '')
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim() || '未命名小说';
}

function isZip(buffer) {
    const bytes = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));
    return bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 3 || bytes[2] === 5 || bytes[2] === 7);
}

/**
 * 解析小说文件。
 * @param {File|Blob} file
 * @param {{onProgress?: (message: string) => void}} options
 * @returns {Promise<{title: string, author: string, format: string, encoding: string, chapters: {title: string, content: string}[], charCount: number}>}
 */
export async function parseNovelFile(file, options = {}) {
    if (!file) throw new Error('没有选择文件');
    if (file.size > MAX_FILE_BYTES) {
        throw new Error(`文件过大（${(file.size / 1024 / 1024).toFixed(0)} MB），请拆分后再导入`);
    }
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};

    const fileName = file.name || '未命名小说';
    const extension = (fileName.split('.').pop() || '').toLowerCase();
    const baseTitle = cleanBookTitle(fileName);
    const buffer = await file.arrayBuffer();

    if (buffer.byteLength === 0) throw new Error('文件是空的');

    onProgress('正在读取文件…');

    if (extension === 'pdf') {
        throw new Error('暂不支持 PDF：请先用 Calibre 等工具转换为 TXT 或 EPUB');
    }
    if (['mobi', 'azw', 'azw3', 'cbr', 'cbz', 'rar', 'zip', '7z'].includes(extension)) {
        throw new Error(`暂不支持 .${extension}：请先转换为 TXT / EPUB / DOCX`);
    }

    if (extension === 'epub' || (extension === 'zip' && isZip(buffer))) {
        onProgress('正在解析 EPUB…');
        const result = await parseEpub(buffer, baseTitle);
        return finalizeResult(result, 'EPUB', 'utf-8');
    }

    if (extension === 'docx' || isZip(buffer)) {
        // 先按 EPUB 试一次，再按 DOCX
        onProgress('正在解析文档…');
        try {
            const result = await parseEpub(buffer, baseTitle);
            return finalizeResult(result, 'EPUB', 'utf-8');
        } catch {
            const result = await parseDocx(buffer, baseTitle);
            return finalizeResult(result, 'DOCX', 'utf-8');
        }
    }

    if (extension === 'html' || extension === 'htm' || extension === 'xhtml') {
        onProgress('正在解析 HTML…');
        const { text, encoding } = decodeBookBytes(buffer);
        const { title, chapters } = htmlToChapters(text, baseTitle);
        return finalizeResult({ title, author: '', chapters }, 'HTML', encoding);
    }

    if (extension === 'md' || extension === 'markdown') {
        onProgress('正在解析 Markdown…');
        const { text, encoding } = decodeBookBytes(buffer);
        const normalized = normalizeText(text);
        const chapters = splitChapters(normalized, { maxChars: 9000 }).map(chapter => ({
            title: chapter.title,
            content: stripMarkdown(chapter.content),
        }));
        return finalizeResult({ title: baseTitle, author: '', chapters }, 'Markdown', encoding);
    }

    // 默认按纯文本处理
    onProgress('正在识别编码…');
    const { text, encoding } = decodeBookBytes(buffer);
    const normalized = normalizeText(text);
    const chapters = splitChapters(normalized, { maxChars: 9000 });
    return finalizeResult({ title: baseTitle, author: '', chapters }, extension === 'txt' ? 'TXT' : (extension || 'TXT').toUpperCase(), encoding);
}

function finalizeResult(result, format, encoding) {
    const chapters = (result.chapters || [])
        .map((chapter, index) => {
            const content = normalizeText(chapter.content);
            return {
                title: (stripHeadingMarks(chapter.title) || `第 ${index + 1} 章`).slice(0, 100),
                content,
            };
        })
        .filter(chapter => chapter.content.length > 0);

    if (chapters.length === 0) throw new Error('没有解析到正文内容，请检查文件格式');

    // 章节标题去重
    const seen = new Map();
    for (const chapter of chapters) {
        const count = seen.get(chapter.title) || 0;
        seen.set(chapter.title, count + 1);
        if (count > 0) chapter.title = `${chapter.title} (${count + 1})`;
    }

    const charCount = chapters.reduce((sum, chapter) => sum + countChars(chapter.content), 0);
    return {
        title: (result.title || '未命名小说').slice(0, 120),
        author: (result.author || '').slice(0, 80),
        format,
        encoding: encoding || 'utf-8',
        chapters,
        charCount,
    };
}

/** 去掉常见 Markdown 标记，保留可读正文 */
export function stripMarkdown(input) {
    let text = String(input ?? '');
    text = text.replace(/^---\n[\s\S]*?\n---\n/, '');
    text = text.replace(/```[\s\S]*?```/g, '');
    text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
    text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
    text = text.replace(/^>\s?/gm, '');
    text = text.replace(/^\s*[-*+]\s+/gm, '');
    text = text.replace(/^\s*\d+[.)]\s+/gm, '');
    text = text.replace(/<[^>]+>/g, '');
    text = text.replace(/[*_~`]{1,3}/g, '');
    return normalizeText(text);
}
