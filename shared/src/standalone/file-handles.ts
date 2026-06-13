/**
 * IndexedDB-backed storage for FileSystemFileHandle.
 *
 * Chromium browsers expose the File System Access API which lets us persist
 * a handle to a user-picked file and re-read it later (after a permission
 * prompt). We keep the handle map keyed by file name in a tiny IDB store.
 */

const IDB_NAME = 'power-duck';
const IDB_STORE = 'handles';

export const FSA_SUPPORTED =
  typeof window !== 'undefined' && typeof (window as any).showOpenFilePicker === 'function';

function idbOpen(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putHandle(name: string, handle: FileSystemFileHandle): Promise<void> {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(handle, name);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getHandle(name: string): Promise<FileSystemFileHandle | undefined> {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(name);
    req.onsuccess = () => resolve(req.result as FileSystemFileHandle | undefined);
    req.onerror = () => reject(req.error);
  });
}

export async function delHandle(name: string): Promise<void> {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(name);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function ensurePermission(handle: FileSystemFileHandle, mode: 'read' | 'readwrite' = 'read'): Promise<boolean> {
  const h = handle as any;
  if (typeof h.queryPermission !== 'function') return true;
  const opts = { mode };
  if ((await h.queryPermission(opts)) === 'granted') return true;
  return (await h.requestPermission(opts)) === 'granted';
}
