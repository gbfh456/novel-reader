/**
 * 小说阅读器 - SillyTavern 扩展入口
 *
 * 安装位置：
 *   data/<user>/extensions/novel-reader/   （或 public/scripts/extensions/third-party/novel-reader/）
 * 本文件只负责在页面就绪后初始化界面；具体逻辑拆分在 js/ 目录。
 */

import { initUI } from './js/ui.js';

function boot() {
    initUI().catch(error => {
        console.error('[小说阅读器] 初始化失败', error);
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
    boot();
}
