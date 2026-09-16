// Thin promise wrapper over IndexedDB. Everything lives on the device.

const DB_NAME = 'fieldnotes';
const DB_VERSION = 3;

let handle = null;

export function open() {
  if (handle) return Promise.resolve(handle);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('observations')) {
        const obs = db.createObjectStore('observations', { keyPath: 'id' });
        obs.createIndex('createdAt', 'createdAt');
        obs.createIndex('entityIds', 'entityIds', { multiEntry: true });
      }
      if (!db.objectStoreNames.contains('entities')) {
        const ent = db.createObjectStore('entities', { keyPath: 'id' });
        ent.createIndex('key', 'key', { unique: true });
      }
      if (!db.objectStoreNames.contains('questions')) {
        db.createObjectStore('questions', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('relations')) {
        db.createObjectStore('relations', { keyPath: 'id' });
      }
      // Holds the single wrapped-master-key record. Never encrypted itself —
      // it is what makes decryption possible.
      if (!db.objectStoreNames.contains('vault')) {
        db.createObjectStore('vault', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => { handle = req.result; resolve(handle); };
    req.onerror = () => reject(req.error);
  });
}

function run(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.onerror = () => reject(tx.error);
    tx.oncomplete = () => resolve(req ? req.result : undefined);
  }));
}

export const getAll = store => run(store, 'readonly', s => s.getAll());
export const get = (store, id) => run(store, 'readonly', s => s.get(id));
export const put = (store, value) => run(store, 'readwrite', s => s.put(value));
export const del = (store, id) => run(store, 'readwrite', s => s.delete(id));
export const clear = store => run(store, 'readwrite', s => s.clear());

export function putMany(store, values) {
  return open().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    values.forEach(v => os.put(v));
    tx.onerror = () => reject(tx.error);
    tx.oncomplete = () => resolve();
  }));
}
