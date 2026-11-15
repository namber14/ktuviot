// שמירה במכשיר (IndexedDB): הסרטונים האחרונים, קובצי המקור שלהם, והמילון.
const DB_NAME = 'ktuviot-mehirot', DB_VERSION = 1;
const MAX_PROJECTS = 8;
let dbPromise = null;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run(storeName, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const req = fn(tx.objectStore(storeName));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function listProjects() {
  const all = (await run('projects', 'readonly', s => s.getAll())) ?? [];
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}
export const getProject = id => run('projects', 'readonly', s => s.get(id));
export const saveProject = p => run('projects', 'readwrite', s => s.put({ ...p, updatedAt: Date.now() }));
export const putFile = (id, blob) => run('files', 'readwrite', s => s.put(blob, id));
export const getFile = id => run('files', 'readonly', s => s.get(id));

export async function deleteProject(id) {
  await run('projects', 'readwrite', s => s.delete(id));
  await run('files', 'readwrite', s => s.delete(id));
}

/** שומר רק את הסרטונים האחרונים, כדי לא למלא את הטלפון. */
export async function prune() {
  const all = await listProjects();
  for (const p of all.slice(MAX_PROJECTS)) await deleteProject(p.id);
}

export const getDict = async () => (await run('kv', 'readonly', s => s.get('dict'))) ?? [];
export const setDict = dict => run('kv', 'readwrite', s => s.put(dict, 'dict'));
