/**
 * 小说阅读器 - 本地存储（IndexedDB）
 *
 * 小说正文可能很大，放在 localStorage 会很快超限，因此全部存 IndexedDB。
 * 章节元数据与正文分表存放，书架上渲染时不需要把整本书读进内存。
 * 备忘分为「本书备忘」和「分组备忘」：本书备忘随小说删除，分组备忘
 * 不绑定小说，删小说 / 清空小说数据时都会保留。
 */

const DB_NAME = 'sillytavern-novel-reader';
const DB_VERSION = 9;

const STORE_NOVELS = 'novels';
/** 书架分组：和备忘分组分开存，删小说不影响分组 */
const STORE_SHELF_GROUPS = 'shelfGroups';
const STORE_CHAPTERS = 'chapters';
const STORE_CONTENTS = 'contents';
const STORE_SUMMARIES = 'summaries';
const STORE_SUMMARY_PARTS = 'summaryParts';
const STORE_WORLDBOOKS = 'worldbooks';
const STORE_WORLDBOOK_PARTS = 'worldbookParts';
const STORE_MEMOS = 'memos';
const STORE_MEMO_GROUPS = 'memoGroups';
const STORE_BOOKMARKS = 'bookmarks';

let dbPromise = null;

function openDatabase() {
    if (dbPromise) return dbPromise;
    if (!globalThis.indexedDB) {
        return Promise.reject(new Error('当前浏览器不支持 IndexedDB，无法保存小说'));
    }
    dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_NOVELS)) {
                const store = db.createObjectStore(STORE_NOVELS, { keyPath: 'id' });
                store.createIndex('updatedAt', 'updatedAt');
            }
            if (!db.objectStoreNames.contains(STORE_SHELF_GROUPS)) {
                const store = db.createObjectStore(STORE_SHELF_GROUPS, { keyPath: 'id' });
                store.createIndex('order', 'order');
            }
            if (!db.objectStoreNames.contains(STORE_CHAPTERS)) {
                const store = db.createObjectStore(STORE_CHAPTERS, { keyPath: 'key' });
                store.createIndex('novelId', 'novelId');
            }
            if (!db.objectStoreNames.contains(STORE_CONTENTS)) {
                db.createObjectStore(STORE_CONTENTS, { keyPath: 'key' });
            }
            if (!db.objectStoreNames.contains(STORE_SUMMARIES)) {
                const store = db.createObjectStore(STORE_SUMMARIES, { keyPath: 'id' });
                store.createIndex('novelId', 'novelId');
            }
            if (!db.objectStoreNames.contains(STORE_SUMMARY_PARTS)) {
                const store = db.createObjectStore(STORE_SUMMARY_PARTS, { keyPath: 'key' });
                store.createIndex('novelId', 'novelId');
            }
            if (!db.objectStoreNames.contains(STORE_WORLDBOOKS)) {
                const store = db.createObjectStore(STORE_WORLDBOOKS, { keyPath: 'id' });
                store.createIndex('novelId', 'novelId');
            }
            if (!db.objectStoreNames.contains(STORE_WORLDBOOK_PARTS)) {
                const store = db.createObjectStore(STORE_WORLDBOOK_PARTS, { keyPath: 'key' });
                store.createIndex('novelId', 'novelId');
            }
            if (!db.objectStoreNames.contains(STORE_MEMOS)) {
                const store = db.createObjectStore(STORE_MEMOS, { keyPath: 'id' });
                store.createIndex('novelId', 'novelId');
                store.createIndex('groupId', 'groupId');
                store.createIndex('updatedAt', 'updatedAt');
            } else {
                // v6 已经有备忘表，但没有 groupId 索引
                const store = request.transaction.objectStore(STORE_MEMOS);
                if (!store.indexNames.contains('groupId')) {
                    store.createIndex('groupId', 'groupId');
                }
            }
            if (!db.objectStoreNames.contains(STORE_MEMO_GROUPS)) {
                const store = db.createObjectStore(STORE_MEMO_GROUPS, { keyPath: 'id' });
                store.createIndex('updatedAt', 'updatedAt');
            }
            if (!db.objectStoreNames.contains(STORE_BOOKMARKS)) {
                const store = db.createObjectStore(STORE_BOOKMARKS, { keyPath: 'id' });
                store.createIndex('novelId', 'novelId');
                store.createIndex('createdAt', 'createdAt');
            }
            // v4 的预设草稿已经不生成预设了，升级时直接丢掉
            if (db.objectStoreNames.contains('presetDrafts')) {
                db.deleteObjectStore('presetDrafts');
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('打开本地数据库失败'));
        request.onblocked = () => reject(new Error('本地数据库被其它页面占用，请关闭其它酒馆页面后重试'));
    });
    return dbPromise;
}

function requestToPromise(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function transactionDone(tx) {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('数据库事务已取消'));
    });
}

function chapterKey(novelId, index) {
    return `${novelId}:${String(index).padStart(6, '0')}`;
}

function buildChapterMeta(novelId, chapter, index) {
    const hasContent = typeof chapter.content === 'string' && chapter.content.length > 0;
    return {
        key: chapterKey(novelId, index),
        novelId,
        index,
        title: chapter.title || `第 ${index + 1} 章`,
        url: chapter.url || '',
        isVolume: Boolean(chapter.isVolume),
        isVip: Boolean(chapter.isVip),
        isPay: Boolean(chapter.isPay),
        tag: chapter.tag || '',
        charCount: chapter.charCount ?? chapter.content?.length ?? 0,
        imageCount: Array.isArray(chapter.images) ? chapter.images.length : 0,
        cached: hasContent || chapter.cached === true,
    };
}

/**
 * 保存一本新书（元数据 + 章节元数据 + 正文；书源书可以不带正文）。
 * 章节很多时分批写：一个超大事务会把页面卡死，看起来像「下载停住了」。
 */
export async function saveNovel(meta, chapters) {
    const list = Array.isArray(chapters) ? chapters : [];
    const db = await openDatabase();
    const CHUNK = 120;
    const metaTx = db.transaction([STORE_NOVELS], 'readwrite');
    metaTx.objectStore(STORE_NOVELS).put(meta);
    await transactionDone(metaTx);

    for (let start = 0; start < list.length; start += CHUNK) {
        const slice = list.slice(start, start + CHUNK);
        const tx = db.transaction([STORE_CHAPTERS, STORE_CONTENTS], 'readwrite');
        const chapterStore = tx.objectStore(STORE_CHAPTERS);
        const contentStore = tx.objectStore(STORE_CONTENTS);
        slice.forEach((chapter, offset) => {
            const row = buildChapterMeta(meta.id, chapter, start + offset);
            chapterStore.put(row);
            if (typeof chapter.content === 'string' && chapter.content) {
                contentStore.put({ key: row.key, text: chapter.content });
            }
        });
        await transactionDone(tx);
        await new Promise(resolve => setTimeout(resolve, 0));
    }
}

/**
 * 追加章节（更新书籍时用）：保留已有章节与正文，只写新章节的元数据。
 * @returns {Promise<number>} 实际写入几章
 */
export async function appendChapters(novelId, chapters, startIndex = null) {
    const list = Array.isArray(chapters) ? chapters : [];
    if (!list.length) return 0;
    const existing = await getChapterList(novelId);
    const offset = Number.isInteger(startIndex) ? startIndex : existing.length;
    const db = await openDatabase();
    const tx = db.transaction([STORE_CHAPTERS], 'readwrite');
    const store = tx.objectStore(STORE_CHAPTERS);
    list.forEach((chapter, index) => {
        store.put(buildChapterMeta(novelId, chapter, offset + index));
    });
    await transactionDone(tx);
    return list.length;
}

/**
 * 整本替换章节（换源时用）：章节元数据与正文缓存一起清空。
 */
export async function replaceChapters(novelId, chapters) {
    const list = Array.isArray(chapters) ? chapters : [];
    // 先把旧章节/正文的 key 读出来，再在同一个事务里按 key 删除。
    // 不能边删边用索引游标：新章节的 key 和旧章节是同一批序号，游标会把刚写入的又删掉。
    const existing = await getChapterList(novelId);
    const db = await openDatabase();
    const tx = db.transaction([STORE_CHAPTERS, STORE_CONTENTS], 'readwrite');
    const chapterStore = tx.objectStore(STORE_CHAPTERS);
    const contentStore = tx.objectStore(STORE_CONTENTS);
    for (const chapter of existing) {
        chapterStore.delete(chapter.key);
        contentStore.delete(chapter.key);
    }
    list.forEach((chapter, index) => {
        chapterStore.put(buildChapterMeta(novelId, chapter, index));
    });
    await transactionDone(tx);
    return list.length;
}

/** 写入一章正文，并把章节元数据标成已缓存 */
export async function saveChapterContent(novelId, index, text, images = []) {
    if (!novelId) return;
    const content = String(text ?? '');
    const imageList = Array.isArray(images) ? images.filter(Boolean).slice(0, 80) : [];
    const key = chapterKey(novelId, index);
    // 只读这一章的元数据：整本读一遍会让缓存几百章变成 O(n²)
    const db0 = await openDatabase();
    const readTx = db0.transaction(STORE_CHAPTERS, 'readonly');
    const meta = await requestToPromise(readTx.objectStore(STORE_CHAPTERS).get(key));
    const db = await openDatabase();
    const tx = db.transaction([STORE_CHAPTERS, STORE_CONTENTS], 'readwrite');
    tx.objectStore(STORE_CONTENTS).put({ key, text: content, images: imageList });
    if (meta) {
        tx.objectStore(STORE_CHAPTERS).put({
            ...meta,
            charCount: content.length,
            imageCount: imageList.length,
            cached: content.length > 0 || imageList.length > 0,
        });
    }
    await transactionDone(tx);
}

/**
 * 删除正文缓存（清理缓存用）。
 * @param {number[]|null} indices null = 清空整本
 */
export async function deleteChapterContents(novelId, indices = null) {
    if (!novelId) return;
    const wanted = Array.isArray(indices) ? new Set(indices) : null;
    const chapters = await getChapterList(novelId);
    const targets = wanted ? chapters.filter(chapter => wanted.has(chapter.index)) : chapters;
    if (!targets.length && wanted) return;
    const db = await openDatabase();
    const tx = db.transaction([STORE_CHAPTERS, STORE_CONTENTS], 'readwrite');
    const contentStore = tx.objectStore(STORE_CONTENTS);
    for (const chapter of targets) {
        contentStore.delete(chapterKey(novelId, chapter.index));
    }
    const chapterStore = tx.objectStore(STORE_CHAPTERS);
    const cursorRequest = chapterStore.index('novelId').openCursor(IDBKeyRange.only(novelId));
    cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        const value = cursor.value;
        if (value && (!wanted || wanted.has(value.index)) && value.cached) {
            cursor.update({ ...value, cached: false });
        }
        cursor.continue();
    };
    await transactionDone(tx);
}

/** 书架列表 */
export async function listNovels() {
    const db = await openDatabase();
    const tx = db.transaction(STORE_NOVELS, 'readonly');
    const novels = await requestToPromise(tx.objectStore(STORE_NOVELS).getAll());
    return novels.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

/** 单本元数据 */
export async function getNovel(id) {
    if (!id) return null;
    const db = await openDatabase();
    const tx = db.transaction(STORE_NOVELS, 'readonly');
    return requestToPromise(tx.objectStore(STORE_NOVELS).get(id));
}

/** 更新元数据 */
export async function updateNovel(id, patch) {
    const novel = await getNovel(id);
    if (!novel) return null;
    const next = { ...novel, ...patch, id, updatedAt: Date.now() };
    const db = await openDatabase();
    const tx = db.transaction(STORE_NOVELS, 'readwrite');
    tx.objectStore(STORE_NOVELS).put(next);
    await transactionDone(tx);
    return next;
}

/** 章节列表（仅元数据） */
export async function getChapterList(novelId) {
    const db = await openDatabase();
    const tx = db.transaction(STORE_CHAPTERS, 'readonly');
    const index = tx.objectStore(STORE_CHAPTERS).index('novelId');
    const rows = await requestToPromise(index.getAll(novelId));
    return rows.sort((a, b) => a.index - b.index);
}

/** 单章正文 */
export async function getChapterContent(novelId, index) {
    const db = await openDatabase();
    const tx = db.transaction(STORE_CONTENTS, 'readonly');
    const row = await requestToPromise(tx.objectStore(STORE_CONTENTS).get(chapterKey(novelId, index)));
    return row?.text ?? '';
}

/** 单章图片地址（图片书源用） */
export async function getChapterImages(novelId, index) {
    const db = await openDatabase();
    const tx = db.transaction(STORE_CONTENTS, 'readonly');
    const row = await requestToPromise(tx.objectStore(STORE_CONTENTS).get(chapterKey(novelId, index)));
    return Array.isArray(row?.images) ? row.images : [];
}

/** 批量读取章节正文（顺序读，避免一次开太多事务） */
export async function getChaptersContent(novelId, indices, onProgress = null) {
    const result = [];
    for (let i = 0; i < indices.length; i++) {
        const index = indices[i];
        result.push({ index, text: await getChapterContent(novelId, index) });
        if (onProgress && (i % 5 === 0 || i === indices.length - 1)) onProgress(i + 1, indices.length);
    }
    return result;
}

/** 删除一本书及其所有章节、总结、世界书和备忘 */
export async function deleteNovel(novelId) {
    const db = await openDatabase();
    const tx = db.transaction([STORE_NOVELS, STORE_CHAPTERS, STORE_CONTENTS, STORE_SUMMARIES, STORE_SUMMARY_PARTS, STORE_WORLDBOOKS, STORE_WORLDBOOK_PARTS, STORE_MEMOS, STORE_BOOKMARKS], 'readwrite');
    tx.objectStore(STORE_NOVELS).delete(novelId);

    const deleteByIndex = (storeName) => {
        const store = tx.objectStore(storeName);
        const index = store.index('novelId');
        const cursorRequest = index.openKeyCursor(IDBKeyRange.only(novelId));
        cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) return;
            store.delete(cursor.primaryKey);
            cursor.continue();
        };
    };

    deleteByIndex(STORE_CHAPTERS);
    deleteByIndex(STORE_SUMMARIES);
    deleteByIndex(STORE_SUMMARY_PARTS);
    deleteByIndex(STORE_WORLDBOOKS);
    deleteByIndex(STORE_WORLDBOOK_PARTS);
    deleteByIndex(STORE_MEMOS);
    deleteByIndex(STORE_BOOKMARKS);

    // 正文表没有 novelId 索引，按 key 前缀清理
    const contentStore = tx.objectStore(STORE_CONTENTS);
    const contentCursor = contentStore.openCursor();
    contentCursor.onsuccess = () => {
        const cursor = contentCursor.result;
        if (!cursor) return;
        if (String(cursor.primaryKey).startsWith(`${novelId}:`)) cursor.delete();
        cursor.continue();
    };

    await transactionDone(tx);
}

/** 保存一条总结（底层方法；界面层应使用 replaceSummary，保证每本书只有一条） */
export async function saveSummary(summary) {
    const db = await openDatabase();
    const tx = db.transaction(STORE_SUMMARIES, 'readwrite');
    tx.objectStore(STORE_SUMMARIES).put(summary);
    await transactionDone(tx);
}

/** 写入该书的最新总结，并删除该书所有旧总结，保证每本小说只有一条历史记录 */
export async function replaceSummary(summary) {
    const db = await openDatabase();
    const tx = db.transaction(STORE_SUMMARIES, 'readwrite');
    const store = tx.objectStore(STORE_SUMMARIES);
    store.put(summary);

    const cursorRequest = store.index('novelId').openKeyCursor(IDBKeyRange.only(summary.novelId));
    cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        if (cursor.primaryKey !== summary.id) store.delete(cursor.primaryKey);
        cursor.continue();
    };

    await transactionDone(tx);
}

/** 某本书的总结历史 */
export async function listSummaries(novelId) {
    const db = await openDatabase();
    const tx = db.transaction(STORE_SUMMARIES, 'readonly');
    const index = tx.objectStore(STORE_SUMMARIES).index('novelId');
    const rows = await requestToPromise(index.getAll(novelId));
    return rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

/** 删除一条总结 */
export async function deleteSummary(id) {
    const db = await openDatabase();
    const tx = db.transaction(STORE_SUMMARIES, 'readwrite');
    tx.objectStore(STORE_SUMMARIES).delete(id);
    await transactionDone(tx);
}

/** 读取一段已缓存的中间摘要 */
export async function getSummaryPart(key) {
    if (!key) return null;
    const db = await openDatabase();
    const tx = db.transaction(STORE_SUMMARY_PARTS, 'readonly');
    return requestToPromise(tx.objectStore(STORE_SUMMARY_PARTS).get(key));
}

/** 读取一批已缓存的中间摘要（用于失败续跑） */
export async function getSummaryParts(keys) {
    if (!Array.isArray(keys) || keys.length === 0) return [];
    const db = await openDatabase();
    const tx = db.transaction(STORE_SUMMARY_PARTS, 'readonly');
    const store = tx.objectStore(STORE_SUMMARY_PARTS);
    return Promise.all(keys.map(key => requestToPromise(store.get(key))));
}

/** 保存一段中间摘要；每完成一段立即落盘，页面刷新也不丢 */
export async function putSummaryPart(part) {
    const db = await openDatabase();
    const tx = db.transaction(STORE_SUMMARY_PARTS, 'readwrite');
    tx.objectStore(STORE_SUMMARY_PARTS).put(part);
    await transactionDone(tx);
}

/** 清空某本书的中间摘要缓存 */
export async function deleteSummaryPartsForNovel(novelId) {
    const db = await openDatabase();
    const tx = db.transaction(STORE_SUMMARY_PARTS, 'readwrite');
    const store = tx.objectStore(STORE_SUMMARY_PARTS);
    const cursorRequest = store.index('novelId').openKeyCursor(IDBKeyRange.only(novelId));
    cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        store.delete(cursor.primaryKey);
        cursor.continue();
    };
    await transactionDone(tx);
}

/** 保存/覆盖某本小说的世界书（每本只保留最新一份） */
export async function replaceWorldbook(worldbook) {
    const db = await openDatabase();
    const tx = db.transaction(STORE_WORLDBOOKS, 'readwrite');
    const store = tx.objectStore(STORE_WORLDBOOKS);
    store.put(worldbook);

    const cursorRequest = store.index('novelId').openKeyCursor(IDBKeyRange.only(worldbook.novelId));
    cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        if (cursor.primaryKey !== worldbook.id) store.delete(cursor.primaryKey);
        cursor.continue();
    };

    await transactionDone(tx);
}

/** 某本小说最近一次生成的世界书 */
export async function getWorldbook(novelId) {
    if (!novelId) return null;
    const db = await openDatabase();
    const tx = db.transaction(STORE_WORLDBOOKS, 'readonly');
    const index = tx.objectStore(STORE_WORLDBOOKS).index('novelId');
    const rows = await requestToPromise(index.getAll(novelId));
    return rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0] || null;
}

export async function deleteWorldbook(novelId) {
    const db = await openDatabase();
    const tx = db.transaction([STORE_WORLDBOOKS, STORE_WORLDBOOK_PARTS], 'readwrite');
    for (const storeName of [STORE_WORLDBOOKS, STORE_WORLDBOOK_PARTS]) {
        const store = tx.objectStore(storeName);
        const cursorRequest = store.index('novelId').openKeyCursor(IDBKeyRange.only(novelId));
        cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) return;
            store.delete(cursor.primaryKey);
            cursor.continue();
        };
    }
    await transactionDone(tx);
}

/** 读取一段已生成的世界书分块结果 */
export async function getWorldbookParts(keys) {
    if (!Array.isArray(keys) || keys.length === 0) return [];
    const db = await openDatabase();
    const tx = db.transaction(STORE_WORLDBOOK_PARTS, 'readonly');
    const store = tx.objectStore(STORE_WORLDBOOK_PARTS);
    return Promise.all(keys.map(key => requestToPromise(store.get(key))));
}

/** 保存一段世界书分块结果，失败重跑时只补缺失块 */
export async function putWorldbookPart(part) {
    const db = await openDatabase();
    const tx = db.transaction(STORE_WORLDBOOK_PARTS, 'readwrite');
    tx.objectStore(STORE_WORLDBOOK_PARTS).put(part);
    await transactionDone(tx);
}

export async function deleteWorldbookPartsForNovel(novelId) {
    const db = await openDatabase();
    const tx = db.transaction(STORE_WORLDBOOK_PARTS, 'readwrite');
    const store = tx.objectStore(STORE_WORLDBOOK_PARTS);
    const cursorRequest = store.index('novelId').openKeyCursor(IDBKeyRange.only(novelId));
    cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        store.delete(cursor.primaryKey);
        cursor.continue();
    };
    await transactionDone(tx);
}

/** 某本小说的全部备忘（只包含本书备忘，不含分组备忘） */
export async function listMemos(novelId) {
    if (!novelId) return [];
    const db = await openDatabase();
    const tx = db.transaction(STORE_MEMOS, 'readonly');
    const index = tx.objectStore(STORE_MEMOS).index('novelId');
    const rows = await requestToPromise(index.getAll(novelId));
    return rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

/** 所有分组备忘（不区分小说，删除小说不会影响它们） */
export async function listGroupMemos() {
    const db = await openDatabase();
    const tx = db.transaction(STORE_MEMOS, 'readonly');
    const index = tx.objectStore(STORE_MEMOS).index('groupId');
    const rows = await requestToPromise(index.getAll());
    return rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

/** 保存一条备忘：novelId 与 groupId 至少有其一 */
export async function saveMemo(memo) {
    if (!memo?.id || (!memo.novelId && !memo.groupId)) {
        throw new Error('备忘缺少 id，且没有归属的小说或分组');
    }
    const db = await openDatabase();
    const tx = db.transaction(STORE_MEMOS, 'readwrite');
    tx.objectStore(STORE_MEMOS).put(memo);
    await transactionDone(tx);
    return memo;
}

/** 删除一条备忘 */
export async function deleteMemo(id) {
    if (!id) return;
    const db = await openDatabase();
    const tx = db.transaction(STORE_MEMOS, 'readwrite');
    tx.objectStore(STORE_MEMOS).delete(id);
    await transactionDone(tx);
}

/** 批量删除备忘（一次事务，用于批量删除选中项） */
export async function deleteMemos(ids) {
    const list = Array.isArray(ids) ? ids.filter(Boolean) : [];
    if (!list.length) return;
    const db = await openDatabase();
    const tx = db.transaction(STORE_MEMOS, 'readwrite');
    const store = tx.objectStore(STORE_MEMOS);
    for (const id of list) store.delete(id);
    await transactionDone(tx);
}

/** 清空某本小说的本书备忘；分组备忘不受影响 */
export async function deleteMemosForNovel(novelId) {
    if (!novelId) return;
    const db = await openDatabase();
    const tx = db.transaction(STORE_MEMOS, 'readwrite');
    const store = tx.objectStore(STORE_MEMOS);
    const cursorRequest = store.index('novelId').openKeyCursor(IDBKeyRange.only(novelId));
    cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        store.delete(cursor.primaryKey);
        cursor.continue();
    };
    await transactionDone(tx);
}

/* ------------------------------------------------------------------ */
/* 备忘分组                                                            */
/* ------------------------------------------------------------------ */

/** 所有分组，按 order / 创建时间排序 */
export async function listMemoGroups() {
    const db = await openDatabase();
    const tx = db.transaction(STORE_MEMO_GROUPS, 'readonly');
    const rows = await requestToPromise(tx.objectStore(STORE_MEMO_GROUPS).getAll());
    return rows.sort((a, b) => (a.order || 0) - (b.order || 0) || (a.createdAt || 0) - (b.createdAt || 0));
}

/** 保存分组（新增或改名） */
export async function saveMemoGroup(group) {
    if (!group?.id || !group?.name) throw new Error('分组缺少 id 或名称');
    const db = await openDatabase();
    const tx = db.transaction(STORE_MEMO_GROUPS, 'readwrite');
    tx.objectStore(STORE_MEMO_GROUPS).put(group);
    await transactionDone(tx);
    return group;
}

/** 删除分组及其中的全部分组备忘 */
export async function deleteMemoGroup(groupId) {
    if (!groupId) return;
    const db = await openDatabase();
    const tx = db.transaction([STORE_MEMO_GROUPS, STORE_MEMOS], 'readwrite');
    tx.objectStore(STORE_MEMO_GROUPS).delete(groupId);
    const store = tx.objectStore(STORE_MEMOS);
    const cursorRequest = store.index('groupId').openKeyCursor(IDBKeyRange.only(groupId));
    cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        store.delete(cursor.primaryKey);
        cursor.continue();
    };
    await transactionDone(tx);
}

/**
 * 清空小说数据。分组和分组备忘不属于任何小说，会被保留；
 * 只删除带 novelId 的本书备忘。
 */
export async function clearAll() {
    const db = await openDatabase();
    const tx = db.transaction([STORE_NOVELS, STORE_CHAPTERS, STORE_CONTENTS, STORE_SUMMARIES, STORE_SUMMARY_PARTS, STORE_WORLDBOOKS, STORE_WORLDBOOK_PARTS, STORE_MEMOS, STORE_BOOKMARKS], 'readwrite');
    for (const name of [STORE_NOVELS, STORE_CHAPTERS, STORE_CONTENTS, STORE_SUMMARIES, STORE_SUMMARY_PARTS, STORE_WORLDBOOKS, STORE_WORLDBOOK_PARTS, STORE_BOOKMARKS]) {
        tx.objectStore(name).clear();
    }
    const memoStore = tx.objectStore(STORE_MEMOS);
    const memoCursor = memoStore.openCursor();
    memoCursor.onsuccess = () => {
        const cursor = memoCursor.result;
        if (!cursor) return;
        if (cursor.value?.novelId) cursor.delete();
        cursor.continue();
    };
    await transactionDone(tx);
}

/* ------------------------------------------------------------------ */
/* 书架分组与批量操作                                                  */
/* ------------------------------------------------------------------ */

/** 书架全部分组，按 order 排序 */
export async function listShelfGroups() {
    const db = await openDatabase();
    const tx = db.transaction(STORE_SHELF_GROUPS, 'readonly');
    const rows = await requestToPromise(tx.objectStore(STORE_SHELF_GROUPS).getAll());
    return rows.sort((a, b) => (a.order || 0) - (b.order || 0) || (a.createdAt || 0) - (b.createdAt || 0));
}

/** 保存一个书架分组（新建或改名 / 改排序） */
export async function saveShelfGroup(group) {
    if (!group?.id || !group?.name) throw new Error('书架分组缺少 id 或名称');
    const db = await openDatabase();
    const tx = db.transaction(STORE_SHELF_GROUPS, 'readwrite');
    tx.objectStore(STORE_SHELF_GROUPS).put(group);
    await transactionDone(tx);
    return group;
}

/**
 * 删除分组：分组里的书不会被删，只是回到「未分组」。
 * 和「阅读」一致——删分组不动书。
 */
export async function deleteShelfGroup(groupId) {
    if (!groupId) return 0;
    const db = await openDatabase();
    const tx = db.transaction([STORE_SHELF_GROUPS, STORE_NOVELS], 'readwrite');
    tx.objectStore(STORE_SHELF_GROUPS).delete(groupId);
    const store = tx.objectStore(STORE_NOVELS);
    let moved = 0;
    const cursorRequest = store.openCursor();
    cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        const value = cursor.value;
        if (value && value.groupId === groupId) {
            cursor.update({ ...value, groupId: '', groupName: '' });
            moved++;
        }
        cursor.continue();
    };
    await transactionDone(tx);
    return moved;
}

/**
 * 批量改字段（分组 / 置顶 / 手动顺序 / 未读数都走这里）。
 * 一个事务扫一遍书架，避免几十本书开几十个事务。
 * @returns {Promise<number>} 实际改了几本
 */
export async function patchNovels(ids, patch) {
    const list = [...new Set((Array.isArray(ids) ? ids : []).filter(Boolean))];
    if (!list.length) return 0;
    const wanted = new Set(list);
    const db = await openDatabase();
    const tx = db.transaction(STORE_NOVELS, 'readwrite');
    const store = tx.objectStore(STORE_NOVELS);
    let changed = 0;
    const cursorRequest = store.openCursor();
    cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        const value = cursor.value;
        if (value && wanted.has(value.id)) {
            cursor.update({ ...value, ...patch, id: value.id });
            changed++;
        }
        cursor.continue();
    };
    await transactionDone(tx);
    return changed;
}

/**
 * 手动排序：一次写入多本书的 manualOrder。
 * @param {Map<string, number>|Record<string, number>} orders
 */
export async function setNovelOrders(orders) {
    const entries = orders instanceof Map ? [...orders.entries()] : Object.entries(orders || {});
    if (!entries.length) return 0;
    const map = new Map(entries.map(([id, order]) => [String(id), Number(order) || 0]));
    const db = await openDatabase();
    const tx = db.transaction(STORE_NOVELS, 'readwrite');
    const store = tx.objectStore(STORE_NOVELS);
    let changed = 0;
    const cursorRequest = store.openCursor();
    cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        const value = cursor.value;
        if (value && map.has(value.id)) {
            cursor.update({ ...value, manualOrder: map.get(value.id) });
            changed++;
        }
        cursor.continue();
    };
    await transactionDone(tx);
    return changed;
}

/** 批量删除（每本仍走 deleteNovel，章节 / 总结 / 世界书 / 备忘一起清） */
export async function deleteNovels(ids) {
    const list = [...new Set((Array.isArray(ids) ? ids : []).filter(Boolean))];
    let removed = 0;
    for (const id of list) {
        await deleteNovel(id);
        removed++;
    }
    return removed;
}

/**
 * 记一次「读过」：只更新 lastReadAt，不动 updatedAt，
 * 免得读一章就把书顶到「更新时间」的最前面。
 */
export async function markNovelRead(novelId, at = Date.now()) {
    if (!novelId) return null;
    const novel = await getNovel(novelId);
    if (!novel) return null;
    const next = { ...novel, lastReadAt: Number(at) || Date.now() };
    const db = await openDatabase();
    const tx = db.transaction(STORE_NOVELS, 'readwrite');
    tx.objectStore(STORE_NOVELS).put(next);
    await transactionDone(tx);
    return next;
}

/* ------------------------------------------------------------------ */
/* 书签                                                                */
/* ------------------------------------------------------------------ */

/** 某本书的全部书签 */
export async function listBookmarks(novelId) {
    if (!novelId) return [];
    const db = await openDatabase();
    const tx = db.transaction(STORE_BOOKMARKS, 'readonly');
    const rows = await requestToPromise(tx.objectStore(STORE_BOOKMARKS).index('novelId').getAll(novelId));
    return rows.sort((a, b) => (a.chapterIndex || 0) - (b.chapterIndex || 0) || (a.page || 0) - (b.page || 0));
}

/** 新增 / 更新书签 */
export async function saveBookmark(bookmark) {
    if (!bookmark?.id || !bookmark?.novelId) throw new Error('书签缺少 id 或小说');
    const db = await openDatabase();
    const tx = db.transaction(STORE_BOOKMARKS, 'readwrite');
    tx.objectStore(STORE_BOOKMARKS).put(bookmark);
    await transactionDone(tx);
    return bookmark;
}

export async function deleteBookmark(id) {
    if (!id) return;
    const db = await openDatabase();
    const tx = db.transaction(STORE_BOOKMARKS, 'readwrite');
    tx.objectStore(STORE_BOOKMARKS).delete(id);
    await transactionDone(tx);
}

/** 估算存储占用量（字节，部分浏览器需要 permissions） */
export async function estimateStorage() {
    try {
        if (navigator.storage?.estimate) {
            const { usage = 0, quota = 0 } = await navigator.storage.estimate();
            return { usage, quota };
        }
    } catch {
        // ignore
    }
    return { usage: 0, quota: 0 };
}
