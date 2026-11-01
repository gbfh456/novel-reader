import assert from 'node:assert/strict';
import { installFakeIndexedDB } from './idb-shim.mjs';
installFakeIndexedDB();
const db = await import('../js/db.js');

const meta = { id: 'b1', title: '源书', author: '作者', chapterCount: 2, sourceId: 'https://s.test', bookUrl: 'https://s.test/book/1', tocUrl: 'https://s.test/toc/1', origin: 'https://s.test' };
await db.saveNovel(meta, [
    { title: '第1章', url: 'https://s.test/1' },
    { title: '第2章', url: 'https://s.test/2' },
]);
let chapters = await db.getChapterList('b1');
assert.equal(chapters.length, 2);
assert.equal(chapters[0].url, 'https://s.test/1');
assert.equal(chapters[0].cached, false);
assert.equal(await db.getChapterContent('b1', 0), '');

await db.saveChapterContent('b1', 0, '第一章正文', ['https://img.test/0.jpg']);
assert.deepEqual(await db.getChapterImages('b1', 0), ['https://img.test/0.jpg']);
assert.equal((await db.getChapterList('b1'))[0].imageCount, 1);
assert.equal((await db.getChapterList('b1'))[0].cached, true);
await db.saveChapterContent('b1', 1, '', ['https://img.test/1.jpg']);
assert.equal((await db.getChapterList('b1'))[1].cached, true, '只有图片也算已缓存');
await db.saveChapterContent('b1', 0, '第一章正文');
chapters = await db.getChapterList('b1');
assert.equal(chapters[0].cached, true);
assert.equal(chapters[0].charCount, 5);
assert.equal(await db.getChapterContent('b1', 0), '第一章正文');

await db.appendChapters('b1', [{ title: '第3章', url: 'https://s.test/3' }]);
chapters = await db.getChapterList('b1');
assert.equal(chapters.length, 3);
assert.equal(chapters[2].index, 2);

await db.deleteChapterContents('b1', [0]);
assert.equal(await db.getChapterContent('b1', 0), '');
assert.equal((await db.getChapterList('b1'))[0].cached, false);

await db.saveChapterContent('b1', 1, '第二章正文');
await db.replaceChapters('b1', [{ title: '新第1章', url: 'https://n.test/1' }, { title: '新第2章', url: 'https://n.test/2' }]);
chapters = await db.getChapterList('b1');
assert.equal(chapters.length, 2);
assert.equal(chapters[0].title, '新第1章');
assert.equal(chapters[0].url, 'https://n.test/1');
assert.equal(await db.getChapterContent('b1', 1), '', '换源后旧正文清空');

await db.saveBookmark({ id: 'bk1', novelId: 'b1', chapterIndex: 0, page: 1, chapterTitle: '新第1章', createdAt: 10 });
await db.saveBookmark({ id: 'bk2', novelId: 'b1', chapterIndex: 1, page: 0, chapterTitle: '新第2章', createdAt: 20 });
let bookmarks = await db.listBookmarks('b1');
assert.equal(bookmarks.length, 2);
assert.equal(bookmarks[0].id, 'bk1');
await db.deleteBookmark('bk1');
assert.equal((await db.listBookmarks('b1')).length, 1);
await db.deleteNovels(['b1']);
assert.equal((await db.listBookmarks('b1')).length, 0, '删书连带删书签');

console.log('章节缓存/替换/书签 OK');
