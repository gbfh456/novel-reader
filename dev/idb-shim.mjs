/**
 * 极简 IndexedDB 替身：只实现本插件用到的部分，用来在 Node 下跑一遍书架的数据层。
 * 不是完整实现，语义按 IndexedDB 的常见行为简化（异步回调、事务完成事件、游标）。
 */

const clone = value => JSON.parse(JSON.stringify(value));

class FakeRequest {
    constructor() {
        this.onsuccess = null;
        this.onerror = null;
        this.result = undefined;
        this.error = null;
    }
}

class FakeIndex {
    constructor(store, keyPath) {
        this.store = store;
        this.keyPath = keyPath;
    }

    openCursor(range) {
        const request = new FakeRequest();
        const entries = [...this.store.data.entries()]
            .filter(([, value]) => !range || value[this.keyPath] === range.value);
        let position = 0;
        const step = () => {
            if (position >= entries.length) {
                request.result = null;
                request.onsuccess?.();
                return;
            }
            const [primaryKey, stored] = entries[position++];
            request.result = {
                primaryKey,
                value: clone(stored),
                update: next => this.store.data.set(primaryKey, clone(next)),
                delete: () => this.store.data.delete(primaryKey),
                continue: () => setTimeout(step, 0),
            };
            request.onsuccess?.();
        };
        setTimeout(step, 0);
        return request;
    }

    openKeyCursor(range) {
        const request = new FakeRequest();
        const entries = [...this.store.data.entries()]
            .filter(([, value]) => !range || value[this.keyPath] === range.value);
        let position = 0;
        const step = () => {
            if (position >= entries.length) {
                request.result = null;
                request.onsuccess?.();
                return;
            }
            const [primaryKey] = entries[position++];
            request.result = {
                primaryKey,
                continue: () => setTimeout(step, 0),
            };
            request.onsuccess?.();
        };
        setTimeout(step, 0);
        return request;
    }

    getAll(key) {
        const request = new FakeRequest();
        const rows = [...this.store.data.values()]
            .filter(value => value[this.keyPath] === key)
            .map(clone);
        setTimeout(() => {
            request.result = rows;
            request.onsuccess?.();
        }, 0);
        return request;
    }
}

class FakeStore {
    constructor(name, options = {}) {
        this.name = name;
        this.keyPath = options.keyPath || 'id';
        this.data = new Map();
        this.indexes = new Map();
    }

    createIndex(name, keyPath) {
        this.indexes.set(name, new FakeIndex(this, keyPath));
    }

    index(name) {
        const index = this.indexes.get(name);
        if (!index) throw new Error(`没有索引 ${name}`);
        return index;
    }

    _later(fn) {
        const request = new FakeRequest();
        setTimeout(() => {
            try {
                fn(request);
                request.onsuccess?.();
            } catch (error) {
                request.error = error;
                request.onerror?.();
            }
        }, 0);
        return request;
    }

    put(value) {
        return this._later(request => {
            this.data.set(value[this.keyPath], clone(value));
            request.result = value[this.keyPath];
        });
    }

    get(key) {
        return this._later(request => {
            request.result = this.data.has(key) ? clone(this.data.get(key)) : undefined;
        });
    }

    getAll() {
        return this._later(request => {
            request.result = [...this.data.values()].map(clone);
        });
    }

    delete(key) {
        return this._later(() => {
            this.data.delete(key);
        });
    }

    clear() {
        return this._later(() => {
            this.data.clear();
        });
    }

    openKeyCursor(range = null) {
        const request = new FakeRequest();
        const keys = [...this.data.keys()].filter(key => !range || key === range.value);
        let position = 0;
        const step = () => {
            if (position >= keys.length) {
                request.result = null;
                request.onsuccess?.();
                return;
            }
            request.result = {
                primaryKey: keys[position++],
                continue: () => setTimeout(step, 0),
            };
            request.onsuccess?.();
        };
        setTimeout(step, 0);
        return request;
    }

    openCursor(range = null, keysOnly = false) {
        const keys = [...this.data.keys()];
        const wanted = range ? keys.filter(key => key === range.value) : keys;
        let position = 0;
        const request = new FakeRequest();
        const step = () => {
            if (position >= wanted.length) {
                request.result = null;
                request.onsuccess?.();
                return;
            }
            const key = wanted[position++];
            const value = this.data.get(key);
            request.result = {
                primaryKey: key,
                value: clone(value),
                update: next => this.data.set(key, clone(next)),
                delete: () => this.data.delete(key),
                continue: () => setTimeout(step, 0),
            };
            request.onsuccess?.();
        };
        setTimeout(step, 0);
        return request;
    }
}

class FakeTransaction {
    constructor(stores) {
        this.stores = stores;
        this.oncomplete = null;
        this.onerror = null;
        this.onabort = null;
        setTimeout(() => this.oncomplete?.(), 15);
    }

    objectStore(name) {
        const store = this.stores.get(name);
        if (!store) throw new Error(`没有对象仓库 ${name}`);
        return store;
    }
}

class FakeDatabase {
    constructor(name) {
        this.name = name;
        this.stores = new Map();
        this.objectStoreNames = { contains: name => this.stores.has(name) };
    }

    createObjectStore(name, options = {}) {
        const store = new FakeStore(name, options);
        this.stores.set(name, store);
        return store;
    }

    deleteObjectStore(name) {
        this.stores.delete(name);
    }

    transaction(names) {
        const list = Array.isArray(names) ? names : [names];
        const stores = new Map();
        for (const name of list) {
            if (!this.stores.has(name)) throw new Error(`事务里没有 ${name}`);
            stores.set(name, this.stores.get(name));
        }
        return new FakeTransaction(stores);
    }
}

export function installFakeIndexedDB({ version = 0 } = {}) {
    const databases = new Map();
    globalThis.IDBKeyRange = { only: value => ({ value }) };
    globalThis.indexedDB = {
        open(name, targetVersion) {
            const request = new FakeRequest();
            setTimeout(() => {
                let db = databases.get(name);
                const oldVersion = db ? db.version : 0;
                if (!db) {
                    db = new FakeDatabase(name);
                    databases.set(name, db);
                }
                const upgrade = !db.version || targetVersion > db.version;
                db.version = targetVersion;
                request.result = db;
                if (upgrade) {
                    request.transaction = new FakeTransaction(new Map());
                    const onUpgrade = request.onupgradeneeded;
                    if (onUpgrade) {
                        request.onupgradeneeded = null;
                        // 升级回调里用到的 createObjectStore 直接挂到 db 上
                        db.transaction = (names => FakeDatabase.prototype.transaction.call(db, names));
                        onUpgrade.call(request, { target: { result: db } });
                    }
                    void oldVersion;
                }
                request.onsuccess?.();
            }, 0);
            return request;
        },
    };
    return databases;
}

export function resetFakeIndexedDB() {
    delete globalThis.indexedDB;
    delete globalThis.IDBKeyRange;
}
