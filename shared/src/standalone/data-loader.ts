/**
 * Webapp data loader.
 * Reads bytes from browser data sources (file picker / drag-drop / fetch).
 * Returns promises so callers can await results directly — no event bus needed.
 */

import { FSA_SUPPORTED, putHandle } from './file-handles';

export interface LoadedData {
  name: string;
  bytes: Uint8Array;
  size: number;
}

/** Read a File object into a Uint8Array. */
export function readFile(file: File): Promise<LoadedData> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const bytes = new Uint8Array(reader.result as ArrayBuffer);
      resolve({ name: file.name, bytes, size: file.size });
    };
    reader.onerror = () => reject(new Error(`Failed to read file: ${file.name}`));
    reader.readAsArrayBuffer(file);
  });
}

const FSA_TYPES = [{
  description: 'Data files',
  accept: {
    'application/octet-stream': ['.parquet', '.arrow', '.duckdb'],
    'text/csv': ['.csv', '.tsv', '.txt'],
    'application/json': ['.json', '.jsonl', '.ndjson'],
  },
}];

/**
 * Pick a local file using the File System Access API when available, so the
 * handle can be persisted for one-click reload from history. Returns null if
 * the user cancels. Falls back to null when FSA is not supported — callers
 * should then trigger a classic `<input type=file>` flow.
 */
export async function pickFileWithHandle(): Promise<File | null> {
  if (!FSA_SUPPORTED) return null;
  try {
    const [handle] = await (window as any).showOpenFilePicker({
      id: 'power-duck-data',
      startIn: 'documents',
      types: FSA_TYPES,
      excludeAcceptAllOption: false,
      multiple: false,
    });
    const file: File = await handle.getFile();
    try { await putHandle(file.name, handle); } catch (e) { console.warn('IDB save failed:', e); }
    return file;
  } catch (e: any) {
    if (e?.name === 'AbortError') return null;
    throw e;
  }
}

/** Fetch a URL and return its bytes. */
export async function fetchUrl(url: string): Promise<LoadedData> {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
  }
  const buf = await resp.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let name: string;
  try {
    name = new URL(url).pathname.split('/').pop() || 'data';
  } catch {
    name = 'data';
  }
  return { name, bytes, size: bytes.byteLength };
}

