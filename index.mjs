/**
 * 小说阅读器 —— 服务端插件入口（和前端扩展同一个仓库）
 *
 * 酒馆的插件加载器按 index.js → index.cjs → index.mjs 顺序探测 plugins/<目录>/，
 * 所以这个文件只在「把本仓库克隆/复制到 plugins/ 下」时才会被加载；
 * 作为前端扩展装在 public/scripts/extensions/third-party/ 时，浏览器只读 manifest.json 里的 frontend.js。
 *
 * 真正的实现在 ./server/index.mjs（番茄桥接：托管本地下载器 + 转发下载器 API + 按 book_id 取整本 txt）。
 */

export { info, init, exit } from './server/index.mjs';
