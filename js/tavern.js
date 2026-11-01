/**
 * 小说阅读器 - 与 SillyTavern 本体的桥接
 *
 * 这里只做四件事：
 * 1. 把世界书写进酒馆的世界书列表（走酒馆自己的 saveWorldInfo / 接口，不直接改文件）；
 * 2. 把世界书绑定到角色卡；
 * 3. 角色卡内嵌世界书时自动导入并绑定，省掉「更多… → 导入角色卡的世界书」；
 * 4. 读出「当前选用」的对话补全预设，并监听预设切换，供文风页跟随预设的排版。
 *
 * 全部通过 SillyTavern.getContext() 暴露的 API 完成；拿不到上下文时静默降级。
 * 插件不写预设：文风由用户自己复制进预设。
 */

const CONTEXT_KEYS = ['saveWorldInfo', 'updateWorldInfoList', 'convertCharacterBook', 'getWorldInfoNames'];
const CHARACTER_LINK_ENDPOINT = '/api/characters/merge-attributes';
const CHARACTER_IMPORT_ENDPOINT = '/api/characters/import';
/** Chat Completion 预设的 prompt_order 用 100001 作为全局假人 id，旧预设可能写 100000 */
const CHAT_PRESET_DUMMY_ID = 100001;
const CHAT_PRESET_LEGACY_ID = 100000;
/** 等待酒馆自己弹出「导入内嵌世界书」对话框的时间 */
const DIALOG_GRACE_MS = 500;
/** 重名时最多往后找到第几个备用名 */
const UNIQUE_NAME_TRIES = 99;

/** 文件名 / 世界书名里不能出现的字符 */
const UNSAFE_FILE_CHARS = /[<>:"/\\|?*\u0000-\u001F]/g;

function getContext() {
    return globalThis.SillyTavern?.getContext?.() || null;
}


/** 当前是否运行在酒馆页面里 */
export function isInTavern() {
    const context = getContext();
    return Boolean(context && CONTEXT_KEYS.every(key => typeof context[key] === 'function'));
}

/** 酒馆世界书列表（实时） */
export function tavernWorldbookNames() {
    const context = getContext();
    if (!context) return [];
    try {
        return context.getWorldInfoNames?.() || [];
    } catch {
        return [];
    }
}

/** 酒馆里是否已经有同名的世界书 */
export function worldbookExists(name) {
    const target = String(name || '').trim().toLowerCase();
    if (!target) return false;
    return tavernWorldbookNames().some(item => String(item).trim().toLowerCase() === target);
}

/** 酒馆里现有的角色名（用于重名判断） */
export function tavernCharacterNames() {
    const characters = getContext()?.characters;
    if (!Array.isArray(characters)) return [];
    return characters
        .map(character => String(character?.name || '').trim())
        .filter(Boolean);
}

/**
 * 重名时返回「名字（2）」「名字（3）」……这样的备用名，保证导入的东西都在、不互相覆盖。
 * @param {string} base 想要的名称
 * @param {(candidate:string)=>boolean} exists 判断某个名称是否已被占用
 * @param {{max?:number, limit?:number}} [options]
 * @returns {string}
 */
export function uniqueName(base, exists, { max = UNIQUE_NAME_TRIES, limit = 80 } = {}) {
    const wanted = String(base || '').trim().slice(0, limit);
    const isTaken = typeof exists === 'function' ? exists : () => false;
    if (!wanted) return '';
    if (!isTaken(wanted)) return wanted;
    for (let index = 2; index <= max; index++) {
        const suffix = `（${index}）`;
        const candidate = `${wanted.slice(0, Math.max(1, limit - suffix.length))}${suffix}`;
        if (!isTaken(candidate)) return candidate;
    }
    const suffix = `（${Date.now().toString(36)}）`;
    return `${wanted.slice(0, Math.max(1, limit - suffix.length))}${suffix}`;
}


/** 当前打开的角色 id，没有则 -1 */
export function selectedCharacterId() {
    const context = getContext();
    if (!context) return -1;
    const raw = context.characterId;
    const id = Number(raw);
    if (raw === undefined || raw === null || raw === '' || !Number.isInteger(id) || id < 0) return -1;
    return context.characters?.[id] ? id : -1;
}

export function selectedCharacter() {
    const id = selectedCharacterId();
    if (id < 0) return null;
    return getContext()?.characters?.[id] || null;
}

function syncCharacterWorldUi(name) {
    const $ = globalThis.$;
    if (typeof $ !== 'function') return;
    try {
        $('#character_world').val(name);
        $('#set_character_world, #world_button').addClass('world_set');
    } catch (error) {
        console.warn('[小说阅读器] 刷新角色世界书下拉框失败', error);
    }
}

/**
 * 写入世界书（已存在则覆盖），并刷新酒馆的世界书列表。
 * @param {string} name 世界书名
 * @param {{entries:object}} data toSillyTavernWorldbook() 的结果
 * @returns {Promise<{existed:boolean}>}
 */
export async function saveWorldbookToTavern(name, data) {
    const context = getContext();
    const bookName = String(name || '').trim();
    if (!context || typeof context.saveWorldInfo !== 'function') {
        throw new Error('没有找到酒馆上下文，无法写入世界书');
    }
    if (!bookName) throw new Error('世界书名不能为空');
    if (!data?.entries || !Object.keys(data.entries).length) {
        throw new Error('没有可写入的世界书条目');
    }
    const existed = worldbookExists(bookName);
    await context.saveWorldInfo(bookName, data, true);
    await context.updateWorldInfoList?.();
    return { existed };
}

/**
 * 把一张 V2 角色卡直接导进酒馆的角色列表。
 * 卡里内嵌的世界书应当先被摘掉：世界书已经由 saveWorldbookToTavern 单独写入，
 * 再带一份内嵌书会让酒馆弹「是否导入内嵌世界书」，等于写两遍。
 *
 * @param {object} card toCharacterCard() 的结果
 * @param {{fileName?:string}} [options]
 * @returns {Promise<{avatar:string, name:string}>}
 */
export async function importCharacterCardToTavern(card, { fileName = '' } = {}) {
    const context = getContext();
    if (!context) throw new Error('没有找到酒馆上下文，无法导入角色卡');
    const name = String(card?.data?.name || '').trim();
    if (!name) throw new Error('角色卡缺少名字');
    const safeName = (String(fileName || name).replace(UNSAFE_FILE_CHARS, '_').trim() || 'character').slice(0, 60);

    const blob = new Blob([JSON.stringify(card, null, 2)], { type: 'application/json' });
    const formData = new FormData();
    formData.append('avatar', blob, `${safeName}.json`);
    formData.append('file_type', 'json');
    formData.append('user_name', String(context.name1 || 'User'));

    const headers = typeof context.getRequestHeaders === 'function'
        ? context.getRequestHeaders({ omitContentType: true })
        : {};
    const response = await fetch(CHARACTER_IMPORT_ENDPOINT, {
        method: 'POST',
        body: formData,
        headers,
        cache: 'no-cache',
    });
    if (!response.ok) throw new Error(`酒馆导入角色卡失败（HTTP ${response.status}）`);
    const data = await response.json().catch(() => ({}));
    if (data?.error) throw new Error('酒馆拒绝了这张角色卡，文件可能不完整');

    // 刷新角色列表，让新卡立刻出现在侧边栏里
    try {
        await context.getCharacters?.();
    } catch (error) {
        console.warn('[小说阅读器] 刷新角色列表失败', error);
    }
    return { avatar: data?.file_name ? `${data.file_name}.png` : '', name };
}

/** 从 prompt_order 里挑出当前聊天实际生效的那一份启用状态 */
function pickPromptOrder(promptOrder) {
    if (!Array.isArray(promptOrder) || !promptOrder.length) return [];
    const list = promptOrder.find(item => String(item?.character_id) === String(CHAT_PRESET_DUMMY_ID))
        || promptOrder.find(item => String(item?.character_id) === String(CHAT_PRESET_LEGACY_ID))
        || promptOrder[0];
    return Array.isArray(list?.order) ? list.order : [];
}

/**
 * 读取酒馆「当前选用」的对话补全预设。
 *
 * 数据源优先级：
 *   1. chatCompletionSettings（即酒馆运行中的 oai_settings）——预设切换后由酒馆把
 *      该预设的 prompts / prompt_order 整体写进来，是真正在用的那一份；
 *   2. 预设管理器里的存档——运行中数据缺失时兜底。
 *
 * @returns {{name:string, prompts:object[], source:string, isGroup:boolean, readAt:number}|null}
 */
export function readSelectedChatPreset() {
    const context = getContext();
    if (!context) return null;

    let manager = null;
    try {
        manager = context.getPresetManager?.('openai') || null;
    } catch (error) {
        console.warn('[小说阅读器] 读取预设管理器失败', error);
    }

    const live = context.chatCompletionSettings || null;
    let name = '';
    try {
        name = String(manager?.getSelectedPresetName?.() || '').trim();
    } catch {
        name = '';
    }
    if (!name) name = String(live?.preset_settings_openai || '').trim();

    let prompts = Array.isArray(live?.prompts) ? live.prompts : null;
    let promptOrder = live?.prompt_order;

    if (!prompts?.length && name) {
        try {
            const saved = manager?.getCompletionPresetByName?.(name);
            if (Array.isArray(saved?.prompts) && saved.prompts.length) {
                prompts = saved.prompts;
                promptOrder = saved.prompt_order;
            }
        } catch (error) {
            console.warn('[小说阅读器] 读取预设存档失败', error);
        }
    }

    if (!Array.isArray(prompts) || !prompts.length) return null;

    const order = pickPromptOrder(promptOrder);
    const enabledById = new Map();
    const orderById = new Map();
    order.forEach((item, index) => {
        const identifier = String(item?.identifier || '').trim();
        if (!identifier) return;
        enabledById.set(identifier, item?.enabled !== false);
        orderById.set(identifier, index);
    });

    const entries = prompts.map((prompt, index) => {
        const identifier = String(prompt?.identifier || `prompt-${index}`);
        return {
            identifier,
            name: String(prompt?.name || '').trim() || identifier,
            role: String(prompt?.role || 'system'),
            content: String(prompt?.content || ''),
            marker: Boolean(prompt?.marker),
            systemPrompt: Boolean(prompt?.system_prompt),
            enabled: enabledById.has(identifier) ? enabledById.get(identifier) : prompt?.enabled !== false,
            order: orderById.has(identifier) ? orderById.get(identifier) : order.length + index,
        };
    });

    return {
        name,
        prompts: entries,
        /** 酒馆当前接口：只有 openai（对话补全）才真正使用这份预设 */
        api: String(context.mainApi || ''),
        source: String(live?.chat_completion_source || ''),
        isGroup: Boolean(context.groupId),
        readAt: Date.now(),
    };
}

/**
 * 监听「酒馆换了预设」。切换预设会连着触发两个事件，调用方需要自行防抖。
 *
 * @param {() => void} handler
 * @returns {() => void} 取消监听
 */
export function installPresetChangeWatcher(handler) {
    const context = getContext();
    const eventSource = context?.eventSource;
    const eventTypes = context?.eventTypes;
    if (!eventSource?.on || typeof handler !== 'function') return () => {};

    const events = [
        eventTypes?.OAI_PRESET_CHANGED_AFTER,
        eventTypes?.PRESET_CHANGED,
        eventTypes?.CHATCOMPLETION_SOURCE_CHANGED,
    ].filter(Boolean);
    if (!events.length) return () => {};

    let lastRun = 0;
    let timer = null;
    const run = () => {
        const now = Date.now();
        if (now - lastRun < 250) return;
        lastRun = now;
        try {
            handler();
        } catch (error) {
            console.warn('[小说阅读器] 预设切换回调失败', error);
        }
    };
    const listener = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            run();
        }, 60);
    };

    events.forEach(event => eventSource.on(event, listener));
    return () => {
        if (timer) clearTimeout(timer);
        events.forEach(event => {
            try {
                eventSource.removeListener?.(event, listener);
            } catch {
                // ignore
            }
        });
    };
}

/**
 * 把世界书绑定到角色（写进 characters[chid].data.extensions.world）。
 * 通过角色的 merge-attributes 接口落盘，不改动角色其它字段。
 */
export async function linkWorldToCharacter(chid, name) {
    const context = getContext();
    const id = Number(chid);
    const bookName = String(name || '').trim();
    const character = context?.characters?.[id];
    if (!character) throw new Error('没有找到要绑定的角色');
    if (!bookName) throw new Error('世界书名不能为空');
    if (!character.avatar) throw new Error('这个角色还没有头像文件，暂时不能绑定');

    character.data = character.data || {};
    character.data.extensions = character.data.extensions || {};
    const previousWorld = character.data.extensions.world || '';
    character.data.extensions.world = bookName;

    const headers = typeof context.getRequestHeaders === 'function'
        ? context.getRequestHeaders()
        : { 'Content-Type': 'application/json' };
    const response = await fetch(CHARACTER_LINK_ENDPOINT, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            avatar: character.avatar,
            data: { extensions: { world: bookName } },
        }),
    });
    if (!response.ok) {
        character.data.extensions.world = previousWorld;
        throw new Error(`酒馆保存角色失败（HTTP ${response.status}）`);
    }
    // 只有当这个角色还开在角色面板里时才动界面，避免把别的角色的下拉框改掉
    if (Number(context.characterId) === id) {
        syncCharacterWorldUi(bookName);
    }
    return character;
}

/** 酒馆自己正在弹「内嵌世界书」对话框吗？ */
function stEmbeddedDialogOpen() {
    const nodes = globalThis.document?.querySelectorAll?.('.popup, #dialogue_popup, dialog, .dialog') || [];
    for (const node of nodes) {
        const text = String(node?.textContent || '');
        if (/embedded World\/Lorebook|内嵌.*世界书|导入.*世界书/i.test(text)) return true;
    }
    return false;
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 角色卡打开时，如果内嵌了世界书、角色又还没绑定世界书，就自动导入并绑定。
 * 这样做不依赖酒馆「导入角色卡时询问」的开关，也不受「同一头像只提示一次」的限制。
 *
 * @param {object} options
 * @param {() => boolean} [options.isEnabled]
 * @param {(info:{character:object,name:string,existed:boolean}) => void} [options.onImported]
 * @param {(error:Error, info:{character:object,name:string}) => void} [options.onError]
 * @returns {() => void} 取消监听
 */
export function installEmbeddedWorldbookAutoImport({ isEnabled = () => true, onImported = () => {}, onError = () => {} } = {}) {
    const context = getContext();
    const eventSource = context?.eventSource;
    const eventTypes = context?.eventTypes;
    if (!eventSource?.on || !eventTypes?.CHARACTER_EDITOR_OPENED) return () => {};

    const handled = new Set();

    const handler = async (chid) => {
        if (!isEnabled() || !isInTavern()) return;
        const current = getContext();
        const character = current?.characters?.[Number(chid)];
        const book = character?.data?.character_book;
        if (!character || !Array.isArray(book?.entries) || !book.entries.length) return;

        const name = String(book.name || `${character.name}'s Lorebook`).trim().slice(0, 80);
        const linked = String(character?.data?.extensions?.world || '').trim();
        if (linked && tavernWorldbookNames().includes(linked)) return;

        const key = `${character.avatar || character.name}::${name}`;
        if (handled.has(key)) return;
        handled.add(key);

        try {
            // 酒馆自己开着询问框时交给它处理，避免两个流程同时写世界书
            await delay(DIALOG_GRACE_MS);
            if (stEmbeddedDialogOpen()) {
                handled.delete(key);
                return;
            }
            const stillLinked = String(character?.data?.extensions?.world || '').trim();
            if (stillLinked && tavernWorldbookNames().includes(stillLinked)) return;

            const existed = worldbookExists(name);
            if (!existed) {
                const converted = current.convertCharacterBook(book);
                await current.saveWorldInfo(name, converted, true);
                await current.updateWorldInfoList?.();
            }
            await linkWorldToCharacter(Number(chid), name);
            onImported({ character, name, existed });
        } catch (error) {
            handled.delete(key);
            onError(error instanceof Error ? error : new Error(String(error)), { character, name });
        }
    };

    eventSource.on(eventTypes.CHARACTER_EDITOR_OPENED, handler);
    return () => {
        try {
            eventSource.removeListener?.(eventTypes.CHARACTER_EDITOR_OPENED, handler);
        } catch {
            // ignore
        }
    };
}
