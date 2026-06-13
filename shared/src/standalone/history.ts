/**
 * Data source history (localStorage).
 * Stores recent data sources picked by the user.
 *
 * Local files are tracked by name; on supported browsers (Chromium with the
 * File System Access API) the matching FileSystemFileHandle is persisted in
 * IndexedDB by `file-handles.ts`, so clicking a local-history entry can
 * re-read the file directly (after a permission prompt). Browsers without
 * FSA fall back to re-prompting the user with the file picker.
 *
 * Remote URLs can be reloaded directly.
 */

const HISTORY_KEY = 'power-duck:history';
const HISTORY_LIMIT = 50;

export interface HistoryItem {
  name: string;
  /** 'local' = file picker; 'url' = network. */
  type: 'local' | 'url';
  /** Only set when type === 'url'. */
  url?: string;
  /** Only set when type === 'local'; bytes. */
  size?: number;
}

const DEFAULT_HISTORY: HistoryItem[] = [
  {
    name: 'tpch lineitem.parquet',
    type: 'url',
    url: 'https://shell.duckdb.org/data/tpch/0_01/parquet/lineitem.parquet',
  },
  {
    name: 'weather.csv',
    type: 'url',
    url: 'https://raw.githubusercontent.com/duckdb/duckdb-web/main/data/weather.csv',
  },
];

function entryKey(h: HistoryItem): string {
  return h.type === 'local' ? `local:${h.name}` : (h.url ?? '');
}

function read(): HistoryItem[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (raw === null) return [...DEFAULT_HISTORY];
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [...DEFAULT_HISTORY];
    return arr.filter((x): x is HistoryItem =>
      !!x && typeof x === 'object' && typeof (x as HistoryItem).name === 'string',
    );
  } catch {
    return [...DEFAULT_HISTORY];
  }
}

function write(list: HistoryItem[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
  } catch {
    // Quota or storage disabled — silently ignore.
  }
}

export function list(): HistoryItem[] {
  return read();
}

export function add(item: HistoryItem): HistoryItem[] {
  const key = entryKey(item);
  if (!key) return read();
  const current = read().filter((h) => entryKey(h) !== key);
  current.unshift(item);
  if (current.length > HISTORY_LIMIT) current.length = HISTORY_LIMIT;
  write(current);
  return current;
}

export function remove(key: string): HistoryItem[] {
  const current = read().filter((h) => entryKey(h) !== key);
  write(current);
  return current;
}

export function clear(): void {
  write([]);
}

export { entryKey };
