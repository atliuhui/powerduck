/**
 * Resource explorer — webapp's data picker.
 * Renders a card with: drag-drop dropzone, file picker, URL input, history list.
 * Emits `loadFile` / `loadUrl` callbacks; orchestration lives in main.ts.
 */

import './explorer.css';
import * as history from './history';
import { pickFileWithHandle } from './data-loader';
import { getHandle, ensurePermission, delHandle, FSA_SUPPORTED } from './file-handles';
import { EXPLORER_ICONS, CONTROL_ICONS } from '../icons';

export interface ExplorerHandlers {
  /** User selected a local file (drag, drop, or picker). */
  onLoadFile: (file: File) => Promise<void> | void;
  /** User entered/clicked a URL. */
  onLoadUrl: (url: string, displayName?: string) => Promise<void> | void;
}

export interface ExplorerHandle {
  /** Show an error in the explorer UI. */
  setError: (msg: string) => void;
  /** Show a transient loading message. */
  setLoading: (msg: string) => void;
  /** Remove the explorer UI entirely. */
  unmount: () => void;
}

function fmtSize(bytes?: number): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>
  )[c]!);
}

export function mountExplorer(host: HTMLElement, handlers: ExplorerHandlers): ExplorerHandle {
  const root = document.createElement('div');
  root.className = 'explorer';
  root.innerHTML = `
    <div class="explorer-card">
      <div class="explorer-header">
        <div class="explorer-logo">P</div>
        <div class="explorer-title">PowerDuck</div>
        <div class="explorer-sub">DuckDB-WASM · Apache ECharts</div>
      </div>
      <div class="explorer-body">
        <div class="explorer-dropzone" id="exDropzone" tabindex="0">
          <div class="explorer-dropzone-title">Drop a file here, or click to browse</div>
          <div class="explorer-dropzone-hint">Parquet · CSV · TSV · JSON / NDJSON · Arrow</div>
          <input id="exFileInput" type="file"
                 accept=".parquet,.csv,.tsv,.json,.jsonl,.ndjson,.arrow,.duckdb"
                 hidden />
        </div>

        <div class="explorer-url">
          <input id="exUrlInput" type="url" placeholder="https://example.com/data.parquet" />
          <button id="exLoadUrlBtn" type="button" class="explorer-btn primary">Load</button>
        </div>

        <div class="explorer-error" id="exError"></div>
        <div class="explorer-loading" id="exLoading"></div>

        <div class="explorer-history">
          <div class="explorer-history-head">
            <span>Recent</span>
            <span class="count" id="exHistoryCount"></span>
            <button type="button" class="clear-all" id="exClearHistory" title="Clear history">Clear</button>
          </div>
          <div class="explorer-history-list" id="exHistoryList"></div>
        </div>
      </div>
    </div>
  `;
  host.appendChild(root);

  const dropzone = root.querySelector<HTMLDivElement>('#exDropzone')!;
  const fileInput = root.querySelector<HTMLInputElement>('#exFileInput')!;
  const urlInput = root.querySelector<HTMLInputElement>('#exUrlInput')!;
  const loadUrlBtn = root.querySelector<HTMLButtonElement>('#exLoadUrlBtn')!;
  const errorEl = root.querySelector<HTMLDivElement>('#exError')!;
  const loadingEl = root.querySelector<HTMLDivElement>('#exLoading')!;
  const historyList = root.querySelector<HTMLDivElement>('#exHistoryList')!;
  const historyCount = root.querySelector<HTMLSpanElement>('#exHistoryCount')!;
  const clearHistoryBtn = root.querySelector<HTMLButtonElement>('#exClearHistory')!;

  const setError = (msg: string) => {
    errorEl.textContent = msg;
    if (msg) loadingEl.textContent = '';
  };
  const setLoading = (msg: string) => {
    loadingEl.textContent = msg;
    if (msg) errorEl.textContent = '';
  };

  // --- Click-to-browse + file picker ---
  dropzone.addEventListener('click', () => void pickFile());
  dropzone.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      void pickFile();
    }
  });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) {
      void handlers.onLoadFile(file);
    }
  });

  // Unified file-pick path: try FSA (which persists a handle for one-click
  // reload from history); if not supported or user has no chance to grant it,
  // fall back to the classic <input type=file> flow.
  async function pickFile(): Promise<void> {
    if (FSA_SUPPORTED) {
      try {
        const file = await pickFileWithHandle();
        if (file) {
          void handlers.onLoadFile(file);
          return;
        }
        // null = user cancelled, do nothing
        return;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return;
      }
    }
    fileInput.click();
  }

  // --- Drag & drop ---
  dropzone.addEventListener('dragover', (ev) => {
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
    dropzone.classList.add('over');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('over'));
  dropzone.addEventListener('drop', (ev) => {
    ev.preventDefault();
    dropzone.classList.remove('over');
    const file = ev.dataTransfer?.files?.[0];
    if (file) {
      void handlers.onLoadFile(file);
    }
  });

  // Page-wide drop guard: prevent navigating away when user misses the dropzone.
  const onWindowDragOver = (ev: DragEvent) => ev.preventDefault();
  const onWindowDrop = (ev: DragEvent) => ev.preventDefault();
  window.addEventListener('dragover', onWindowDragOver);
  window.addEventListener('drop', onWindowDrop);

  // --- URL ---
  const doLoadUrl = () => {
    const url = urlInput.value.trim();
    if (!url) {
      setError('Enter a URL first.');
      return;
    }
    void handlers.onLoadUrl(url);
  };
  loadUrlBtn.addEventListener('click', doLoadUrl);
  urlInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      doLoadUrl();
    }
  });

  // --- History ---
  const renderHistory = () => {
    const items = history.list();
    historyCount.textContent = items.length ? `(${items.length})` : '';
    historyList.innerHTML = '';
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'explorer-history-empty';
      empty.textContent = 'No recent sources.';
      historyList.appendChild(empty);
      return;
    }
    for (const h of items) {
      const item = document.createElement('div');
      item.className = 'explorer-history-item';
      item.title = h.type === 'url'
        ? (h.url ?? h.name)
        : `Local file: ${h.name} (click to re-select)`;
      const typeIcon = h.type === 'url' ? EXPLORER_ICONS.url : EXPLORER_ICONS.file;
      const typeClass = h.type === 'url' ? 'type url' : 'type';
      const typeTitle = h.type === 'url' ? 'URL' : 'Local file';
      const meta = h.type === 'url'
        ? ''
        : (h.size ? fmtSize(h.size) : '');
      const displayText = h.type === 'url' ? (h.url ?? h.name) : h.name;
      item.innerHTML = `
        <span class="${typeClass}" title="${typeTitle}" aria-label="${typeTitle}">${typeIcon}</span>
        <span class="name">${escapeHtml(displayText)}</span>
        <span class="meta">${escapeHtml(meta)}</span>
        <button type="button" class="del" title="Remove from history" aria-label="Remove from history">${CONTROL_ICONS.remove}</button>
      `;
      const delBtn = item.querySelector<HTMLButtonElement>('.del')!;
      item.addEventListener('click', (ev) => {
        if ((ev.target as Element).closest('.del')) return;
        if (h.type === 'url' && h.url) {
          urlInput.value = h.url;
          void handlers.onLoadUrl(h.url, h.name);
        } else {
          void openLocalFromHistory(h.name);
        }
      });
      delBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const key = h.type === 'url' ? (h.url ?? '') : `local:${h.name}`;
        history.remove(key);
        if (h.type === 'local') {
          delHandle(h.name).catch(() => { /* ignore */ });
        }
        renderHistory();
      });
      historyList.appendChild(item);
    }
  };

  // Re-open a local file from history by retrieving its persisted handle.
  // Falls back to the file picker if the handle is missing, permission is
  // denied, or the underlying file is no longer accessible.
  async function openLocalFromHistory(name: string): Promise<void> {
    if (!FSA_SUPPORTED) {
      setError(`Please re-select the local file: ${name}`);
      fileInput.click();
      return;
    }
    let handle: FileSystemFileHandle | undefined;
    try { handle = await getHandle(name); } catch { /* ignore */ }
    if (!handle) {
      setError(`No saved handle for "${name}" — please pick it again.`);
      void pickFile();
      return;
    }
    try {
      if (!(await ensurePermission(handle, 'read'))) {
        setError('Permission denied. Please re-select the file.');
        void pickFile();
        return;
      }
      const file = await handle.getFile();
      void handlers.onLoadFile(file);
    } catch (e) {
      try { await delHandle(name); } catch { /* ignore */ }
      setError(`Cannot open "${name}" (${e instanceof Error ? e.message : String(e)}). Please re-select.`);
      void pickFile();
    }
  }
  clearHistoryBtn.addEventListener('click', () => {
    if (confirm('Clear all history?')) {
      history.clear();
      renderHistory();
    }
  });
  renderHistory();

  return {
    setError,
    setLoading,
    unmount: () => {
      window.removeEventListener('dragover', onWindowDragOver);
      window.removeEventListener('drop', onWindowDrop);
      root.remove();
    },
  };
}
