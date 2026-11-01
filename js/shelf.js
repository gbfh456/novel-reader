/**
 * 小说阅读器 - 书架视图的纯函数
 *
 * 对齐「阅读」的书架能力：分组、排序（阅读时间 / 更新时间 / 书名 / 手动）、
 * 置顶、最近阅读、未读标记、关键字过滤。
 *
 * 这里只做数据整理，方便在 Node 下测试：
 *   IndexedDB 读写在 js/db.js，渲染与交互在 js/ui.js。
 */

/** 书架支持的排序方式（与「阅读」的书架排序菜单一致） */
export const SHELF_SORTS = ['readTime', 'updateTime', 'title', 'manual'];

export const SHELF_SORT_LABELS = {
    readTime: '按阅读时间',
    updateTime: '按更新时间',
    title: '按书名',
    manual: '手动排序',
};

/** 「全部」与「未分组」用两个保留值，不会和真实分组 id 撞上 */
export const SHELF_GROUP_ALL = 'all';
export const SHELF_GROUP_UNGROUPED = '__ungrouped__';

/** 把外部传进来的排序方式收拢到已知值 */
export function normalizeShelfSort(value, fallback = 'readTime') {
    return SHELF_SORTS.includes(value) ? value : fallback;
}

/** 把一堆零散参数补全成一份书架视图配置 */
export function normalizeShelfFilter(raw = {}) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
        groupId: typeof source.groupId === 'string' ? source.groupId : '',
        keyword: String(source.keyword ?? '').trim(),
        sort: normalizeShelfSort(source.sort),
        desc: source.desc !== false,
    };
}

/** 上次阅读时间（毫秒）；没读过是 0 */
export function readTimeOf(novel) {
    const value = Number(novel?.lastReadAt);
    return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/** 书籍更新时间；老数据没有 updatedAt 时退回创建时间 */
export function updateTimeOf(novel) {
    const value = Number(novel?.updatedAt ?? novel?.createdAt);
    return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/** 置顶时间；> 0 表示置顶（置顶的书永远排在前面） */
export function pinTimeOf(novel) {
    const value = Number(novel?.pinnedAt);
    return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

export function isPinned(novel) {
    return pinTimeOf(novel) > 0;
}

/** 书属于哪个分组；空串 = 未分组 */
export function groupOf(novel) {
    return String(novel?.groupId || '');
}

/** 未读章节数（书源更新章节时写入，书架用来画小红点） */
export function unreadOf(novel) {
    const value = Math.round(Number(novel?.unreadCount) || 0);
    return value > 0 ? value : 0;
}

/** 书架关键字匹配：书名 / 作者 / 来源 / 分组名 */
export function shelfNovelMatches(novel, keyword) {
    const needle = String(keyword || '').trim().toLowerCase();
    if (!needle) return true;
    const haystack = [
        novel?.title,
        novel?.author,
        novel?.sourceName,
        novel?.groupName,
    ].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(needle);
}

/**
 * 每个分组里有多少本书。
 * 分组 id 在书里存在、但分组已被删掉的书，按「未分组」统计。
 */
export function countByGroup(novels, groups = []) {
    const list = Array.isArray(novels) ? novels : [];
    const known = new Set((Array.isArray(groups) ? groups : []).map(group => group.id));
    let ungrouped = 0;
    const perGroup = new Map();
    for (const group of groups || []) perGroup.set(group.id, 0);
    for (const novel of list) {
        const groupId = groupOf(novel);
        if (!groupId || !known.has(groupId)) {
            ungrouped++;
            continue;
        }
        perGroup.set(groupId, (perGroup.get(groupId) || 0) + 1);
    }
    return { all: list.length, ungrouped, groups: perGroup };
}

/** 按分组与关键字过滤 */
export function filterShelfNovels(novels, { groupId = '', keyword = '', groups = [] } = {}) {
    const known = new Set((Array.isArray(groups) ? groups : []).map(group => group.id));
    const scope = groupId || SHELF_GROUP_ALL;
    return (Array.isArray(novels) ? novels : []).filter(novel => {
        if (!shelfNovelMatches(novel, keyword)) return false;
        if (scope === SHELF_GROUP_ALL) return true;
        const group = groupOf(novel);
        const valid = Boolean(group) && (known.size === 0 || known.has(group));
        if (scope === SHELF_GROUP_UNGROUPED) return !valid;
        return valid && group === scope;
    });
}

/**
 * 排序：置顶优先 → 所选排序字段 → 原始顺序兜底。
 * manual 模式按 manualOrder 升序，不受 desc 影响（手动排序没有正倒序）。
 */
export function sortShelfNovels(novels, sort = 'readTime', desc = true) {
    const mode = normalizeShelfSort(sort);
    const dir = desc ? -1 : 1;
    return (Array.isArray(novels) ? novels : [])
        .map((novel, index) => ({ novel, index }))
        .sort((left, right) => {
            const a = left.novel;
            const b = right.novel;
            const pinnedA = isPinned(a);
            const pinnedB = isPinned(b);
            if (pinnedA !== pinnedB) return pinnedA ? -1 : 1;
            if (pinnedA && pinnedB) {
                const pinDiff = pinTimeOf(b) - pinTimeOf(a);
                if (pinDiff) return pinDiff;
            }
            let diff = 0;
            if (mode === 'title') {
                diff = String(a?.title || '').localeCompare(String(b?.title || ''), 'zh-Hans-CN');
            } else if (mode === 'updateTime') {
                diff = updateTimeOf(a) - updateTimeOf(b);
            } else if (mode === 'manual') {
                const orderA = Number(a?.manualOrder) || 0;
                const orderB = Number(b?.manualOrder) || 0;
                diff = (orderA || left.index + 1) - (orderB || right.index + 1);
            } else {
                diff = readTimeOf(a) - readTimeOf(b);
            }
            if (diff) return mode === 'manual' ? diff : diff * dir;
            return left.index - right.index;
        })
        .map(item => item.novel);
}

/** 上次在读的那本书：最近阅读时间最大的那本 */
export function pickResumeNovel(novels) {
    let best = null;
    for (const novel of Array.isArray(novels) ? novels : []) {
        if (!readTimeOf(novel)) continue;
        if (!best || readTimeOf(novel) > readTimeOf(best)) best = novel;
    }
    return best;
}

/**
 * 一次算出书架要用的全部东西。
 * @returns {{items:object[], total:number, shown:number, counts:object, resume:object|null}}
 */
export function buildShelfView(novels, options = {}) {
    const list = Array.isArray(novels) ? novels : [];
    const groups = Array.isArray(options.groups) ? options.groups : [];
    const filter = normalizeShelfFilter(options);
    const filtered = filterShelfNovels(list, { ...filter, groups });
    return {
        items: sortShelfNovels(filtered, filter.sort, filter.desc),
        total: list.length,
        shown: filtered.length,
        counts: countByGroup(list, groups),
        resume: options.includeResume === false ? null : pickResumeNovel(list),
    };
}

/** 分组排序：order 小的在前，同序按名称 */
export function sortShelfGroups(groups) {
    return [...(Array.isArray(groups) ? groups : [])].sort((a, b) => {
        const diff = (Number(a?.order) || 0) - (Number(b?.order) || 0);
        if (diff) return diff;
        return String(a?.name || '').localeCompare(String(b?.name || ''), 'zh-Hans-CN');
    });
}

/** 新分组放到最后 */
export function nextGroupOrder(groups) {
    const list = Array.isArray(groups) ? groups : [];
    return list.reduce((max, group) => Math.max(max, Number(group?.order) || 0), 0) + 1;
}

/** 手动排序：把某本书往上 / 往下挪一格，返回挪动后的顺序（id 数组） */
export function moveInList(items, id, delta) {
    const list = Array.isArray(items) ? items : [];
    const index = list.findIndex(item => item?.id === id);
    const target = index + Math.sign(Number(delta) || 0);
    if (index < 0 || target < 0 || target >= list.length || target === index) return null;
    const next = [...list];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);
    return next.map(item => item.id);
}

/** 手动排序落库用：id → 顺序号（从 1 开始） */
export function orderMapFromIds(ids) {
    const map = new Map();
    (Array.isArray(ids) ? ids : []).forEach((id, index) => {
        if (id) map.set(id, index + 1);
    });
    return map;
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / 昨天 / N 天前 / 日期 */
export function relativeTime(value, now = Date.now()) {
    const time = Number(value) || 0;
    if (!time) return '未读';
    const diff = Math.max(0, Number(now) - time);
    const minute = 60 * 1000;
    const hour = 60 * minute;
    const day = 24 * hour;
    if (diff < minute) return '刚刚';
    if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
    if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
    if (diff < 2 * day) return '昨天';
    if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
    const date = new Date(time);
    const pad = number => String(number).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
