import './styles.css';
import workspaceHtml from './workspace.html?raw';
import * as echarts from 'echarts';
import { initDuckDB, duckdb, type DuckHandles } from './duck';
import { VISUAL_TYPE_ICONS, BUCKET_ICONS, HEADER_ICONS, SCHEMA_ICONS, CONTROL_ICONS, MENU_ICONS, BRAND_ICONS } from './icons';

/* ===================== Types ===================== */
// Date "bins" piggy-back on the Agg union: they are not real aggregations,
// but they share the chip-menu UI and the same dim-vs-measure plumbing.
// At SQL time the dim path detects them via `isDateBin` and emits a
// row-level STRFTIME expression that is *also* added to GROUP BY.
// Only the three most common levels are surfaced in the menu — quarter,
// hour, week-of-year, fiscal year, etc. are reachable via the Custom SQL
// editor (DuckDB's full date function library is available).
type Agg =
  | 'Group' | 'Sum' | 'Avg' | 'Min' | 'Max' | 'Count' | 'CountDistinct'
  | 'Year' | 'YearMonth' | 'Date';
type BucketKey = 'axis' | 'legend' | 'values' | 'columns' | 'filters';
type VisualKey =
  | 'bar' | 'stackedBar' | 'column' | 'stackedColumn'
  | 'line' | 'area' | 'scatter'
  | 'pie' | 'doughnut' | 'table' | 'kpi';

interface FieldRef {
  table: string;
  col: string;
  type: string;
  agg?: Agg;
  op?: string;
  value?: string;
}
type Buckets = Record<BucketKey, FieldRef[]>;

interface ColInfo { name: string; type: string }
/**
 * Column-oriented result snapshot. Arrow vectors are kept alive so we can
 * decode values on demand via `vectors.get(name)!.get(rowIndex)` instead of
 * materialising one JS object per row (which would double memory for large
 * result sets).
 */
interface VisualData {
  cols: ColInfo[];
  rowCount: number;
  vectors: Map<string, any>;
}

interface Visual {
  id: string;
  type: VisualKey;
  table: string;
  buckets: Buckets;
  pos: { c: number; r: number; w: number; h: number };
  data: VisualData | null;
  error: string | null;
  sql?: string | null;
  autoSQL?: string | null;
  customSQL?: string | null;
  _chart?: echarts.ECharts | null;
  _chartRO?: ResizeObserver | null;
  _needsRun?: boolean;
  /** Monotonic token so a late-returning query can't overwrite a newer result. */
  _runToken?: number;
}

interface TableInfo {
  schema: { name: string; type: string }[];
  rowCount: number;
  source: string;
  size: number;
}

interface AppState {
  db: duckdb.AsyncDuckDB | null;
  conn: duckdb.AsyncDuckDBConnection | null;
  tables: Map<string, TableInfo>;
  visuals: Visual[];
  selectedId: string | null;
  visualType: VisualKey;
  buckets: Buckets;
}

/* ===================== Helpers ===================== */
const $ = (id: string) => document.getElementById(id)!;
const $$ = <T extends Element = Element>(sel: string, root: ParentNode = document) =>
  Array.from(root.querySelectorAll<T>(sel));

const emptyBuckets = (): Buckets => ({
  axis: [], legend: [], values: [], columns: [], filters: [],
});

const state: AppState = {
  db: null,
  conn: null,
  tables: new Map(),
  visuals: [],
  selectedId: null,
  visualType: 'bar',
  buckets: emptyBuckets(),
};

const VISUAL_TYPES: { key: VisualKey; icon: string; name: string; buckets: BucketKey[] }[] = [
  { key: 'bar',           icon: VISUAL_TYPE_ICONS.bar,           name: 'Bar',           buckets: ['axis', 'legend', 'values'] },
  { key: 'stackedBar',    icon: VISUAL_TYPE_ICONS.stackedBar,    name: 'Stacked bar',   buckets: ['axis', 'legend', 'values'] },
  { key: 'column',        icon: VISUAL_TYPE_ICONS.column,        name: 'Column',        buckets: ['axis', 'legend', 'values'] },
  { key: 'stackedColumn', icon: VISUAL_TYPE_ICONS.stackedColumn, name: 'Stacked column', buckets: ['axis', 'legend', 'values'] },
  { key: 'line',          icon: VISUAL_TYPE_ICONS.line,          name: 'Line',          buckets: ['axis', 'legend', 'values'] },
  { key: 'area',          icon: VISUAL_TYPE_ICONS.area,          name: 'Area',          buckets: ['axis', 'legend', 'values'] },
  { key: 'scatter',       icon: VISUAL_TYPE_ICONS.scatter,       name: 'Scatter',       buckets: ['axis', 'legend', 'values'] },
  { key: 'pie',           icon: VISUAL_TYPE_ICONS.pie,           name: 'Pie',           buckets: ['legend', 'values'] },
  { key: 'doughnut',      icon: VISUAL_TYPE_ICONS.doughnut,      name: 'Doughnut',      buckets: ['legend', 'values'] },
  { key: 'kpi',           icon: VISUAL_TYPE_ICONS.kpi,           name: 'Card',          buckets: ['values'] },
  { key: 'table',         icon: VISUAL_TYPE_ICONS.table,         name: 'Grid',          buckets: ['columns'] },
];

const BUCKET_LABELS: Record<BucketKey, { label: string; icon: string; hint: string }> = {
  axis:    { label: 'Axis',    icon: BUCKET_ICONS.axis,    hint: 'Category / time' },
  legend:  { label: 'Legend',  icon: BUCKET_ICONS.legend,  hint: 'Group dimension' },
  values:  { label: 'Values',  icon: BUCKET_ICONS.values,  hint: 'Aggregated measure' },
  columns: { label: 'Columns', icon: BUCKET_ICONS.columns, hint: 'Non-aggregated columns auto-group' },
  filters: { label: 'Filters', icon: BUCKET_ICONS.filters, hint: 'Optional conditions' },
};

const AGG_OPTIONS: Agg[] = ['Group', 'Sum', 'Avg', 'Min', 'Max', 'Count', 'CountDistinct'];
const DATE_BIN_OPTIONS: Agg[] = ['Year', 'YearMonth', 'Date'];
function isDateBin(a: Agg | undefined): boolean {
  return a === 'Year' || a === 'YearMonth' || a === 'Date';
}
function aggLabelText(a: Agg): string {
  switch (a) {
    case 'CountDistinct': return 'Count (distinct)';
    case 'YearMonth':     return 'Year-Month';
    case 'Date':          return 'Year-Month-Day';
    default:              return a;
  }
}

interface FilterOp { key: string; label: string; needValue: boolean; hint?: string }
const FILTER_OPS: FilterOp[] = [
  { key: '=',        label: 'Equals',         needValue: true },
  { key: '!=',       label: 'Not equals',     needValue: true },
  { key: '>',        label: 'Greater than',   needValue: true },
  { key: '>=',       label: 'Greater or eq',  needValue: true },
  { key: '<',        label: 'Less than',      needValue: true },
  { key: '<=',       label: 'Less or eq',     needValue: true },
  { key: 'contains', label: 'Contains',       needValue: true },
  { key: 'starts',   label: 'Starts with',    needValue: true },
  { key: 'ends',     label: 'Ends with',      needValue: true },
  { key: 'in',       label: 'In list',        needValue: true, hint: 'Comma-separated values' },
  { key: 'null',     label: 'Is null',        needValue: false },
  { key: 'notnull',  label: 'Is not null',    needValue: false },
];

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function chartTheme() {
  return {
    gridColor: cssVar('--border', '#e1dfdd'),
    tickColor: cssVar('--text-2', '#605e5c'),
    tooltipBg: cssVar('--tooltip-bg', '#252423'),
    tooltipBorder: cssVar('--tooltip-border', '#252423'),
    tooltipText: cssVar('--tooltip-text', '#ffffff'),
  };
}

function setStatus(msg: string, kind: 'loading' | 'ok' | 'err' = 'loading') {
  $('statusText').textContent = msg;
  $('statusDot').className = 'dot ' + kind;
  // Sync welcome overlay so the centered card reflects the same lifecycle as
  // the status bar (Data Wrangler-style empty/loading/error states).
  const card = document.querySelector<HTMLElement>('.welcome-card');
  const message = document.getElementById('welcomeMessage');
  if (!card || !message) return;
  message.textContent = msg;
  const state =
    kind === 'err' ? 'error'
    : kind === 'ok' ? 'empty'
    : 'loading';
  card.setAttribute('data-state', state);
}
function uid() { return 'v' + Math.random().toString(36).slice(2, 9); }
function sanitizeName(name: string) {
  return name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_]/g, '_').replace(/^(\d)/, '_$1');
}
function escapeHtml(s: unknown) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>
  )[c]!);
}
function isNumericType(t: string | undefined) { return /INT|DECIMAL|DOUBLE|FLOAT|REAL|NUMERIC|BIGINT|HUGEINT/i.test(t || ''); }
function isDateType(t: string | undefined)    { return /DATE|TIME/i.test(t || ''); }
function typeIcon(t: string) {
  if (isNumericType(t)) return SCHEMA_ICONS.number;
  if (isDateType(t)) return SCHEMA_ICONS.time;
  if (/BOOL/i.test(t)) return SCHEMA_ICONS.bool;
  return '';
}

function applyUiIcons() {
  $('workareaTitle').innerHTML = `${HEADER_ICONS.dashboard} Dashboard`;
  $('newVisualBtn').innerHTML = `${CONTROL_ICONS.newVisual} New visual`;
  $('refreshBtn').innerHTML = `${CONTROL_ICONS.refresh} Refresh`;
  $('clearPageBtn').innerHTML = `${CONTROL_ICONS.removeAll} Remove all`;
  $('visualizationsTitle').innerHTML = `${HEADER_ICONS.visualizations} Visualizations`;
  $('dataTitle').innerHTML = `${HEADER_ICONS.data} Data`;
  $('sqlTitle').innerHTML = `${BUCKET_ICONS.sql} SQL`;
  $('sqlResetBtn').innerHTML = CONTROL_ICONS.sqlReset;
  $('sqlCopyBtn').innerHTML = CONTROL_ICONS.sqlCopy;
  $('sqlApplyBtn').innerHTML = CONTROL_ICONS.sqlApply;
}
function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'number') return v;
  const n = Number(v); return Number.isFinite(n) ? n : null;
}
function labelOf(v: unknown): string {
  if (v === null || v === undefined) return '(blank)';
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
function quoteIdent(name: string) { return '"' + name.replace(/"/g, '""') + '"'; }
function toDateValue(v: unknown, type: string): Date | null {
  if (v instanceof Date) return v;
  const t = (type || '').toUpperCase();
  let n: number | null = null;
  if (typeof v === 'bigint') n = Number(v);
  else if (typeof v === 'number') n = v;
  if (n === null || !Number.isFinite(n)) return null;
  // DuckDB Arrow encodes:
  //  - DATE32 as days since epoch
  //  - TIMESTAMP_MS as ms, TIMESTAMP / TIMESTAMP_US as microseconds, TIMESTAMP_NS as nanoseconds
  if (t === 'DATE' || t.startsWith('DATE')) return new Date(n * 86400000);
  if (t.includes('TIMESTAMP_NS')) return new Date(n / 1e6);
  if (t.includes('TIMESTAMP_MS')) return new Date(n);
  if (t.includes('TIMESTAMP')) return new Date(n / 1000); // TIMESTAMP / TIMESTAMP_US
  if (t.includes('TIME')) return new Date(n);
  return null;
}
function formatDate(d: Date, type: string): string {
  const t = (type || '').toUpperCase();
  const iso = d.toISOString();
  if (t === 'DATE' || t.startsWith('DATE')) return iso.slice(0, 10);
  return iso.replace('T', ' ').replace(/\.\d+Z$/, '');
}
function formatCell(v: unknown, type: string): { html: string; cls: string } {
  if (v === null || v === undefined) return { html: 'NULL', cls: '' };
  if (isDateType(type)) {
    const d = toDateValue(v, type);
    if (d && !isNaN(d.getTime())) return { html: escapeHtml(formatDate(d, type)), cls: '' };
  }
  if (typeof v === 'bigint') return { html: v.toLocaleString(), cls: 'num' };
  if (typeof v === 'number') {
    let s: string;
    if (Number.isInteger(v)) {
      s = v.toLocaleString();
    } else if (Math.abs(v) >= 1) {
      s = v.toLocaleString(undefined, { maximumFractionDigits: 2 });
    } else if (v === 0) {
      s = '0';
    } else if (Math.abs(v) < 1e-4) {
      s = v.toExponential(3);
    } else {
      s = v.toLocaleString(undefined, { maximumFractionDigits: 6 });
    }
    return { html: s, cls: 'num' };
  }
  if (v instanceof Date) return { html: v.toISOString(), cls: '' };
  if (typeof v === 'object') return { html: escapeHtml(JSON.stringify(v)), cls: '' };
  return { html: escapeHtml(String(v)), cls: isNumericType(type) ? 'num' : '' };
}
function readerFor(fileName: string) {
  const ext = fileName.toLowerCase().split('.').pop();
  if (ext === 'csv' || ext === 'tsv' || ext === 'txt') return `read_csv_auto('${fileName}')`;
  if (ext === 'json' || ext === 'ndjson' || ext === 'jsonl') return `read_json_auto('${fileName}')`;
  return `read_parquet('${fileName}')`;
}

function base64ToBytes(base64: string): Uint8Array {
  const bin = atob(base64);
  const len = bin.length;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ===================== DuckDB lifecycle ===================== */
let _duckReadyResolve!: () => void;
let _duckReadyReject!: (err: unknown) => void;
const duckReady: Promise<void> = new Promise((resolve, reject) => {
  _duckReadyResolve = resolve;
  _duckReadyReject = reject;
});

async function bootstrap() {
  try {
    const handles: DuckHandles = await initDuckDB((stage) => {
      setStatus(`Initializing DuckDB (${stage})...`, 'loading');
    });
    state.db = handles.db;
    state.conn = handles.conn;
    if (handles.version) $('dbVer').textContent = 'DuckDB ' + handles.version;
    setStatus('Ready — waiting for data', 'ok');
    _duckReadyResolve();
  } catch (e) {
    setStatus('Initialization failed: ' + (e as Error).message, 'err');
    _duckReadyReject(e);
    console.error(e);
  }
}

async function fetchSchema(tableName: string) {
  const result = await state.conn!.query(`DESCRIBE ${quoteIdent(tableName)}`);
  return result.toArray().map((r: any) => {
    const j = r.toJSON();
    return { name: j.column_name as string, type: j.column_type as string };
  });
}
async function fetchRowCount(tableName: string) {
  try {
    const r = await state.conn!.query(`SELECT COUNT(*) AS c FROM ${quoteIdent(tableName)}`);
    return Number(r.toArray()[0].toJSON().c);
  } catch { return 0; }
}

async function registerBytes(name: string, bytes: Uint8Array) {
  await clearAllTables();
  const tableName = sanitizeName(name);
  setStatus(`Loading ${name}...`, 'loading');
  await state.db!.registerFileBuffer(name, bytes);
  await state.conn!.query(`CREATE OR REPLACE VIEW ${quoteIdent(tableName)} AS SELECT * FROM ${readerFor(name)}`);
  const schema = await fetchSchema(tableName);
  const rowCount = await fetchRowCount(tableName);
  state.tables.set(tableName, { schema, rowCount, source: name, size: bytes.byteLength });
  refreshAfterTableChange();
  setStatus(`Loaded ${tableName} (${rowCount.toLocaleString()} rows)`, 'ok');
}

async function clearAllTables() {
  for (const name of Array.from(state.tables.keys())) {
    try { await state.conn!.query(`DROP VIEW IF EXISTS ${quoteIdent(name)}`); } catch { /* ignore */ }
  }
  state.tables.clear();
  state.visuals = [];
  state.selectedId = null;
  state.buckets = emptyBuckets();
}

function refreshAfterTableChange() {
  renderFieldsTree();
  renderReportPage();
  renderDropzones();
  updateRibbonState();
  updateTableInfo();
}

function updateRibbonState() {
  const hasData = state.tables.size > 0;
  const hasVisuals = state.visuals.length > 0;
  const newBtn = $('newVisualBtn') as HTMLButtonElement;
  const refreshBtn = $('refreshBtn') as HTMLButtonElement;
  const clearBtn = $('clearPageBtn') as HTMLButtonElement;
  newBtn.disabled = false;
  refreshBtn.disabled = !hasVisuals;
  clearBtn.disabled = !hasVisuals;
  newBtn.setAttribute('aria-disabled', String(newBtn.disabled));
  refreshBtn.setAttribute('aria-disabled', String(refreshBtn.disabled));
  clearBtn.setAttribute('aria-disabled', String(clearBtn.disabled));
  document.querySelector('.main')!.classList.toggle('locked', !hasData);
}

function updateTableInfo() {
  if (!state.tables.size) { $('tableInfo').textContent = ''; return; }
  const totalRows = Array.from(state.tables.values()).reduce((s, t) => s + (t.rowCount || 0), 0);
  $('tableInfo').textContent = `${state.tables.size} tables · ${totalRows.toLocaleString()} rows`;
}

/* ===================== Fields panel ===================== */
function renderFieldsTree() {
  const tree = $('fieldsTree');
  if (!state.tables.size) {
    tree.innerHTML = '<div class="fields-empty">No data loaded yet</div>';
    return;
  }
  tree.innerHTML = '';
  for (const [name, info] of state.tables) {
    const tn = document.createElement('div');
    tn.className = 'ft-table expanded';
    tn.setAttribute('role', 'treeitem');
    tn.setAttribute('aria-expanded', 'true');
    const head = document.createElement('div');
    head.className = 'ft-table-head';
    head.setAttribute('role', 'button');
    head.tabIndex = 0;
    head.setAttribute('aria-label', `Toggle table ${name}`);
    head.innerHTML = `
      <span class="caret">${SCHEMA_ICONS.caret}</span>
      ${SCHEMA_ICONS.table}
      <span class="name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
    `;
    const toggle = () => {
      const nextExpanded = tn.classList.toggle('expanded');
      tn.setAttribute('aria-expanded', String(nextExpanded));
    };
    head.onclick = () => toggle();
    head.onkeydown = (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      toggle();
    };
    tn.appendChild(head);
    const cols = document.createElement('div');
    cols.className = 'ft-cols';
    cols.setAttribute('role', 'group');
    info.schema.forEach(col => {
      const c = document.createElement('div');
      c.className = 'ft-col';
      c.draggable = true;
      c.setAttribute('role', 'treeitem');
      c.dataset.table = name;
      c.dataset.col = col.name;
      c.dataset.type = col.type;
      c.title = `${name}.${col.name} (${col.type}) — drag to the Axis / Legend / Values bucket`;
      c.innerHTML = `
        <span class="ico">${typeIcon(col.type)}</span>
        <span>${escapeHtml(col.name)}</span>
      `;
      c.addEventListener('dragstart', (ev) => {
        c.classList.add('dragging');
        ev.dataTransfer!.effectAllowed = 'copy';
        ev.dataTransfer!.setData('application/x-pd-field', JSON.stringify({
          table: name, col: col.name, type: col.type,
        }));
      });
      c.addEventListener('dragend', () => c.classList.remove('dragging'));
      cols.appendChild(c);
    });
    tn.appendChild(cols);
    tree.appendChild(tn);
  }
}

/* ===================== Visual type picker ===================== */
function renderVisualTypes() {
  const grid = $('visualTypes');
  grid.innerHTML = '';
  VISUAL_TYPES.forEach(t => {
    const b = document.createElement('button');
    b.className = 'vt-btn' + (t.key === state.visualType ? ' active' : '');
    b.setAttribute('aria-label', `Visual type: ${t.name}`);
    b.setAttribute('aria-pressed', String(t.key === state.visualType));
    b.innerHTML = `${t.icon}<span class="tip">${t.name}</span>`;
    b.onclick = () => {
      state.visualType = t.key;
      const sel = getSelectedVisual();
      if (sel) { sel.type = t.key; refreshSelectedVisual(); }
      renderVisualTypes();
      renderDropzones();
    };
    grid.appendChild(b);
  });
}

/* ===================== Dropzones ===================== */
function renderDropzones() {
  const host = $('dropzones');
  const sel = getSelectedVisual();
  const vt = VISUAL_TYPES.find(v => v.key === (sel ? sel.type : state.visualType));
  const buckets: Buckets = sel ? sel.buckets : state.buckets;
  const allBuckets: BucketKey[] = [...(vt?.buckets || []), 'filters'];
  host.innerHTML = '';
  allBuckets.forEach(bk => {
    const meta = BUCKET_LABELS[bk];
    const zone = document.createElement('div');
    zone.className = 'dropzone';
    zone.dataset.bucket = bk;
    zone.innerHTML = `
      <div class="dropzone-head">
        <span class="ico">${meta.icon}</span>
        <span>${meta.label}</span>
        <span class="hint">${meta.hint}</span>
      </div>
      <div class="dropzone-body"></div>
    `;
    const body = zone.querySelector('.dropzone-body') as HTMLElement;
    const items = buckets[bk];
    if (!items.length) {
      body.innerHTML = `<div class="dropzone-empty">Drop fields here</div>`;
    } else {
      items.forEach((f, idx) => {
        const chip = document.createElement('span');
        chip.className = 'field-chip';
        chip.draggable = true;
        const showAgg = (bk === 'values' || bk === 'columns' || bk === 'axis');
        const isFilter = (bk === 'filters');
        const defaultAgg: Agg = (bk === 'values') ? 'Sum' : 'Group';
        const aggLabel = showAgg ? `<span class="agg" title="Click to switch aggregation">${aggLabelText(f.agg || defaultAgg)}</span>` : '';
        let filterLabel = '';
        if (isFilter) {
          const opMeta = FILTER_OPS.find(o => o.key === (f.op || 'notnull')) || FILTER_OPS[0];
          const valPart = opMeta.needValue && f.value !== undefined && f.value !== ''
            ? ` ${escapeHtml(String(f.value).length > 20 ? String(f.value).slice(0, 18) + '…' : String(f.value))}`
            : '';
          const cls = opMeta.needValue && (f.value === undefined || f.value === '') ? 'agg filter pending' : 'agg filter';
          filterLabel = `<span class="${cls}" title="Click to set filter condition">${escapeHtml(opMeta.label)}${valPart}</span>`;
        }
        chip.innerHTML = `
          ${aggLabel}${filterLabel}
          <span class="name" title="${escapeHtml(f.table)}.${escapeHtml(f.col)} — drag to reorder">${escapeHtml(f.col)}</span>
          <span class="x" title="Remove">${CONTROL_ICONS.remove}</span>
        `;
        (chip.querySelector('.x') as HTMLElement).onclick = (e) => {
          e.stopPropagation();
          items.splice(idx, 1);
          if (sel) { refreshSelectedVisual(); renderDropzones(); }
          else renderDropzones();
        };
        const aggEl = chip.querySelector('.agg') as HTMLElement | null;
        if (aggEl) {
          aggEl.onclick = (e) => {
            e.stopPropagation();
            if (isFilter) {
              showFilterMenu(e, f, () => {
                if (sel) refreshSelectedVisual();
                renderDropzones();
              });
            } else {
              showAggMenu(e, f, bk, () => {
                if (sel) refreshSelectedVisual();
                renderDropzones();
              });
            }
          };
        }
        chip.addEventListener('dragstart', (ev) => {
          ev.stopPropagation();
          ev.dataTransfer!.effectAllowed = 'move';
          ev.dataTransfer!.setData('application/x-pd-reorder', JSON.stringify({ bucket: bk, index: idx }));
          chip.classList.add('dragging');
        });
        chip.addEventListener('dragend', () => {
          chip.classList.remove('dragging');
          body.querySelectorAll('.field-chip').forEach(c => c.classList.remove('drop-before', 'drop-after'));
        });
        chip.addEventListener('dragover', (ev) => {
          if (!ev.dataTransfer!.types.includes('application/x-pd-reorder')) return;
          ev.preventDefault();
          ev.stopPropagation();
          ev.dataTransfer!.dropEffect = 'move';
          const r = chip.getBoundingClientRect();
          const before = (ev.clientX - r.left) < r.width / 2;
          chip.classList.toggle('drop-before', before);
          chip.classList.toggle('drop-after', !before);
        });
        chip.addEventListener('dragleave', () => {
          chip.classList.remove('drop-before', 'drop-after');
        });
        chip.addEventListener('drop', (ev) => {
          if (!ev.dataTransfer!.types.includes('application/x-pd-reorder')) return;
          ev.preventDefault();
          ev.stopPropagation();
          chip.classList.remove('drop-before', 'drop-after');
          const raw = ev.dataTransfer!.getData('application/x-pd-reorder');
          if (!raw) return;
          const { bucket: srcBk, index: srcIdx } = JSON.parse(raw);
          if (srcBk !== bk) return;
          const r = chip.getBoundingClientRect();
          const before = (ev.clientX - r.left) < r.width / 2;
          let dstIdx = idx + (before ? 0 : 1);
          if (srcIdx < dstIdx) dstIdx--;
          if (srcIdx === dstIdx) return;
          const [moved] = items.splice(srcIdx, 1);
          items.splice(dstIdx, 0, moved);
          if (sel) refreshSelectedVisual();
          renderDropzones();
        });
        body.appendChild(chip);
      });
    }
    body.addEventListener('dragover', (e) => {
      const types = e.dataTransfer!.types;
      const isNewField = types.includes('application/x-pd-field');
      const isReorder = types.includes('application/x-pd-reorder');
      if (!isNewField && !isReorder) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = isReorder ? 'move' : 'copy';
      zone.classList.add('over');
    });
    body.addEventListener('dragleave', () => zone.classList.remove('over'));
    body.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('over');
      const reorderRaw = e.dataTransfer!.getData('application/x-pd-reorder');
      if (reorderRaw) {
        const { bucket: srcBk, index: srcIdx } = JSON.parse(reorderRaw);
        if (srcBk !== bk) return;
        if (srcIdx === items.length - 1) return;
        const [moved] = items.splice(srcIdx, 1);
        items.push(moved);
        if (sel) refreshSelectedVisual();
        renderDropzones();
        return;
      }
      const raw = e.dataTransfer!.getData('application/x-pd-field');
      if (!raw) return;
      const field = JSON.parse(raw) as FieldRef;
      const target: Buckets = sel ? sel.buckets : state.buckets;
      if (sel) {
        if (sel.table && field.table !== sel.table) {
          setStatus(`Visual supports a single table only (${sel.table})`, 'err');
          return;
        }
      } else {
        const allFields = (Object.values(state.buckets) as FieldRef[][]).flat();
        if (allFields.length && allFields[0].table !== field.table) {
          setStatus('The current visual supports a single table only', 'err');
          return;
        }
      }
      const entry: FieldRef = { table: field.table, col: field.col, type: field.type };
      if (bk === 'values') {
        entry.agg = isNumericType(field.type) ? 'Sum' : 'Count';
      } else if (bk === 'columns') {
        entry.agg = isNumericType(field.type) ? 'Sum' : 'Group';
      } else if (bk === 'filters') {
        entry.op = 'notnull';
        entry.value = '';
      }
      if (target[bk].some(f => f.col === entry.col && f.agg === entry.agg)) return;
      target[bk].push(entry);
      if (sel) { sel.table = sel.table || field.table; refreshSelectedVisual(); }
      renderDropzones();
    });
    host.appendChild(zone);
  });
}

function showAggMenu(evt: MouseEvent, field: FieldRef, bucket: BucketKey, onChange: () => void) {
  closeMenus();
  const menu = document.createElement('div');
  menu.className = 'menu';

  // Build the option list based on field type and bucket role.
  //  - Values (measure): numeric → Sum/Avg/Min/Max/Count(*); date → Count only.
  //  - Dim buckets: Group + Count + (numeric → Sum/Avg/…, date → Year/Quarter/…).
  const isDate = isDateType(field.type);
  const isNum  = isNumericType(field.type);
  let options: Agg[];
  if (bucket === 'values') {
    if (isDate)      options = ['Count', 'CountDistinct'];
    else if (isNum)  options = ['Sum', 'Avg', 'Min', 'Max', 'Count', 'CountDistinct'];
    else             options = ['Count', 'CountDistinct'];
  } else {
    if (isDate)      options = ['Group', ...DATE_BIN_OPTIONS, 'Count', 'CountDistinct'];
    else if (isNum)  options = AGG_OPTIONS;
    else             options = ['Group', 'Count', 'CountDistinct'];
  }

  const effectiveAgg: Agg = field.agg ?? (bucket === 'values' ? 'Sum' : 'Group');
  options.forEach(opt => {
    const item = document.createElement('div');
    item.className = 'item';
    const label = opt === 'Group' ? 'Group (no aggregation)' : aggLabelText(opt);
    item.innerHTML = `<span class="ck">${effectiveAgg === opt ? MENU_ICONS.check : ''}</span>${label}`;
    item.onclick = () => { field.agg = opt; closeMenus(); onChange(); };
    menu.appendChild(item);
  });
  document.body.appendChild(menu);
  const r = (evt.target as HTMLElement).getBoundingClientRect();
  menu.style.left = r.left + 'px';
  menu.style.top = (r.bottom + 4) + 'px';
}
function showFilterMenu(evt: MouseEvent, field: FieldRef, onChange: () => void) {
  closeMenus();
  const menu = document.createElement('div');
  menu.className = 'menu filter-menu';
  const currentOp = field.op || 'notnull';
  const opMeta = FILTER_OPS.find(o => o.key === currentOp) || FILTER_OPS[0];
  menu.innerHTML = `
    <div class="filter-header">
      <span class="filter-header-label">Filter</span>
      <span class="filter-col-tag" title="${escapeHtml(field.col)}">${escapeHtml(field.col)}</span>
    </div>
    <div class="filter-field">
      <label>Operator</label>
      <select class="filter-op">
        ${FILTER_OPS.map(o => `<option value="${o.key}" ${o.key === currentOp ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}
      </select>
    </div>
    <div class="filter-field filter-value-row" ${opMeta.needValue ? '' : 'hidden'}>
      <label>Value</label>
      <input class="filter-value" type="text" value="${escapeHtml(field.value ?? '')}" placeholder="${escapeHtml(opMeta.hint || 'Type a value and press Enter')}" />
    </div>
    <div class="filter-actions">
      <button class="btn-secondary filter-clear">${CONTROL_ICONS.sqlReset}<span>Reset</span></button>
      <button class="btn-primary filter-apply">${MENU_ICONS.check}<span>Apply</span></button>
    </div>
  `;
  document.body.appendChild(menu);
  const r = (evt.target as HTMLElement).getBoundingClientRect();
  menu.style.left = r.left + 'px';
  menu.style.top = (r.bottom + 4) + 'px';
  const opSel = menu.querySelector('.filter-op') as HTMLSelectElement;
  const valRow = menu.querySelector('.filter-value-row') as HTMLElement;
  const valInput = menu.querySelector('.filter-value') as HTMLInputElement;
  opSel.onchange = () => {
    const m = FILTER_OPS.find(o => o.key === opSel.value)!;
    valRow.hidden = !m.needValue;
    valInput.placeholder = m.hint || 'Type a value and press Enter';
  };
  const apply = () => {
    field.op = opSel.value;
    const m = FILTER_OPS.find(o => o.key === field.op)!;
    field.value = m.needValue ? valInput.value : '';
    closeMenus();
    onChange();
  };
  (menu.querySelector('.filter-apply') as HTMLElement).onclick = apply;
  (menu.querySelector('.filter-clear') as HTMLElement).onclick = () => {
    field.op = 'notnull';
    field.value = '';
    closeMenus();
    onChange();
  };
  valInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); apply(); }
  });
  menu.addEventListener('click', (e) => e.stopPropagation());
  setTimeout(() => valInput.focus(), 0);
}

function closeMenus() { $$('.menu').forEach(m => m.remove()); }
document.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  if (!target.closest('.menu') && !target.classList.contains('agg')) closeMenus();
});

/* ===================== Visuals ===================== */
function getSelectedVisual() {
  return state.visuals.find(v => v.id === state.selectedId) || null;
}

function addVisual(type?: VisualKey) {
  const firstTable = state.tables.keys().next().value;
  if (!firstTable) { setStatus('Load data first', 'err'); return; }
  const visual: Visual = {
    id: uid(),
    type: type || state.visualType,
    table: firstTable,
    buckets: emptyBuckets(),
    pos: { c: 1, r: 1, w: VISUAL_W, h: VISUAL_H },
    data: null,
    error: null,
  };
  state.visuals.push(visual);
  state.selectedId = visual.id;
  state.visualType = visual.type;
  reflowVisualPositions();
  renderReportPage();
  renderVisualTypes();
  renderDropzones();
  updateRibbonState();
}

const VISUAL_W = 12;
const VISUAL_H = 4;
const VISUAL_COLS = 12;
const SQL_ROW_LIMIT = 5000;

function disposeVisualChart(v: Visual) {
  if (v._chart) {
    try { v._chart.dispose(); } catch { /* ignore */ }
    v._chart = null;
  }
  if (v._chartRO) {
    try { v._chartRO.disconnect(); } catch { /* ignore */ }
    v._chartRO = null;
  }
}

function reflowVisualPositions() {
  const perRow = Math.max(1, Math.floor(VISUAL_COLS / VISUAL_W));
  state.visuals.forEach((v, i) => {
    const colIdx = i % perRow;
    const rowIdx = Math.floor(i / perRow);
    v.pos = {
      c: 1 + colIdx * VISUAL_W,
      r: 1 + rowIdx * VISUAL_H,
      w: VISUAL_W,
      h: VISUAL_H,
    };
  });
}

function removeVisual(id: string) {
  const v = state.visuals.find(x => x.id === id);
  if (v) disposeVisualChart(v);
  state.visuals = state.visuals.filter(v => v.id !== id);
  if (state.selectedId === id) state.selectedId = null;
  reflowVisualPositions();
  renderReportPage();
  renderDropzones();
  updateRibbonState();
}

function selectVisual(id: string) {
  if (state.selectedId === id) return;
  // Visual cards stop event propagation to avoid the page-level deselect
  // handler, which also prevents the global document click listener from
  // closing any open popup (aggregation / filter). Close them here so
  // switching visuals doesn't leave a stale menu floating around.
  closeMenus();
  state.selectedId = id;
  const v = getSelectedVisual();
  if (v) state.visualType = v.type;
  updateSelectionHighlight();
  renderVisualTypes();
  renderDropzones();
  syncSqlEditor();
}

function renderReportPage() {
  const page = $('reportPage');
  page.classList.toggle('empty', state.visuals.length === 0);
  state.visuals.forEach(disposeVisualChart);
  page.innerHTML = '';
  $('visualCount').textContent = `${state.visuals.length} visuals`;
  state.visuals.forEach(v => {
    const el = document.createElement('div');
    el.className = 'visual' + (v.id === state.selectedId ? ' selected' : '');
    el.dataset.id = v.id;
    el.style.gridColumn = `${v.pos.c} / span ${v.pos.w}`;
    el.style.gridRow = `${v.pos.r} / span ${v.pos.h}`;
    el.onclick = (e) => { e.stopPropagation(); selectVisual(v.id); };
    el.innerHTML = `
      <div class="visual-header">
        <span class="visual-title">${escapeHtml(visualTitle(v))}</span>
        <div class="visual-actions">
          <button data-act="export" title="Export CSV" aria-label="Export visual as CSV">${CONTROL_ICONS.export}</button>
          <button data-act="refresh" title="Refresh" aria-label="Refresh visual">${CONTROL_ICONS.refresh}</button>
          <button data-act="remove" title="Remove" aria-label="Remove visual">${CONTROL_ICONS.remove}</button>
        </div>
      </div>
      <div class="visual-body" id="vb-${v.id}">
        <div class="visual-empty">Configure fields on the right to populate this visual</div>
      </div>
    `;
    (el.querySelector('[data-act="remove"]') as HTMLElement).onclick = (e) => { e.stopPropagation(); removeVisual(v.id); };
    (el.querySelector('[data-act="refresh"]') as HTMLElement).onclick = (e) => { e.stopPropagation(); runVisual(v); };
    (el.querySelector('[data-act="export"]') as HTMLElement).onclick = (e) => { e.stopPropagation(); exportVisualCSV(v); };
    page.appendChild(el);
    if (v._needsRun || !v.data) {
      v._needsRun = false;
      runVisual(v);
    } else {
      renderVisualResult(v);
    }
  });
  page.onclick = () => {
    if (state.selectedId === null) return;
    state.selectedId = null;
    page.querySelectorAll('.visual.selected').forEach(n => n.classList.remove('selected'));
    renderDropzones();
    syncSqlEditor();
  };
}

function updateSelectionHighlight() {
  const page = $('reportPage');
  page.querySelectorAll<HTMLElement>('.visual').forEach(n => {
    n.classList.toggle('selected', n.dataset.id === state.selectedId);
  });
}

function visualTitle(v: Visual): string {
  const vt = VISUAL_TYPES.find(t => t.key === v.type);
  if (v.type === 'table') {
    const cols = v.buckets.columns;
    if (!cols.length) return vt?.name || 'Table';
    const parts = cols.map(f => f.agg === 'Group' ? f.col : `${f.agg}(${f.col})`);
    return parts.join(', ');
  }
  const vals = v.buckets.values.map(f => `${f.agg || ''}(${f.col})`).join(', ');
  const dim = (v.buckets.axis[0] || v.buckets.legend[0])?.col;
  if (vals && dim) return `${vals} by ${dim}`;
  if (vals) return vals;
  return vt?.name || 'New visual';
}

function refreshSelectedVisual() {
  const sel = getSelectedVisual();
  if (sel) {
    const el = document.querySelector(`.visual[data-id="${sel.id}"] .visual-title`);
    if (el) el.textContent = visualTitle(sel);
    runVisual(sel);
  }
}

/* ===================== SQL building ===================== */
function aggExpr(field: FieldRef): string {
  const c = quoteIdent(field.col);
  // Cast numeric aggregates to DOUBLE so DECIMAL results don't come back
  // as raw Arrow Uint32 buffers (which then stringify to giant quoted digits).
  switch (field.agg) {
    case 'Avg': return `CAST(AVG(${c}) AS DOUBLE)`;
    case 'Min': return `CAST(MIN(${c}) AS DOUBLE)`;
    case 'Max': return `CAST(MAX(${c}) AS DOUBLE)`;
    case 'Count': return `COUNT(${c})`;
    case 'CountDistinct': return `COUNT(DISTINCT ${c})`;
    // Date bins: row-level STRFTIME expressions. These are dimensions, not
    // aggregations — the caller must put the expression into GROUP BY too.
    // The format strings are chosen so the resulting VARCHAR sorts in the
    // natural chronological order (e.g. '2024-01' < '2024-02'). For other
    // granularities (quarter, hour, ISO week, fiscal year, ...) use the
    // Custom SQL editor with DuckDB date functions.
    case 'Year':      return `STRFTIME(${c}, '%Y')`;
    case 'YearMonth': return `STRFTIME(${c}, '%Y-%m')`;
    case 'Date':      return `STRFTIME(${c}, '%Y-%m-%d')`;
    case 'Sum':
    default: return `CAST(SUM(${c}) AS DOUBLE)`;
  }
}

// SELECT alias encoding. Two formats are supported; the SHORT form is what
// `encodeFieldAlias` emits by default, the LONG form is recognised by the
// decoder so users can hand-write more readable aliases in custom SQL.
//
//   short:  {b}{rrr}_{encodedCol}_{n}        e.g. agrp_Category_1
//   long:   {bucket}_{role}_{encodedCol}_{n} e.g. axis_group_Category_1
//
// Parts:
//   bucket = axis | legend | values | columns
//            (`filters` never produces a SELECT alias — predicates live in
//             WHERE — so it is not part of the alias namespace)
//   b      = bucket first letter           (a / l / v / c)
//   role   = group | sum | avg | min | max | count | countdistinct
//          | year | yearmonth | date
//   rrr    = 3-letter role code:           grp / sum / avg / min / max
//                                          / cnt / cdt / yer / ymo / dat
//   encodedCol = encodeURIComponent(col)   (`_` is left as-is — see note)
//   n      = 1-based ordinal within the bucket, ALWAYS emitted
//
// `_` inside the col payload doesn't need escaping: both decoder regexes
// anchor the trailing `_\d+` to end-of-string with a greedy `.+` in front,
// so the LAST `_n` is always the ordinal.
const ALIAS_PATTERN_SHORT = /^([alvc])(grp|sum|avg|min|max|cnt|cdt|yer|ymo|dat)_(.+)_([0-9]+)$/;
const ALIAS_PATTERN_LONG = /^(axis|legend|values|columns)_(group|sum|avg|min|max|count|countdistinct|year|yearmonth|date)_(.+)_([0-9]+)$/;

const BUCKET_TO_CODE: Record<BucketKey, string> = {
  axis: 'a',
  legend: 'l',
  values: 'v',
  columns: 'c',
  filters: '', // not emitted in SELECT
};
const CODE_TO_BUCKET: Record<string, BucketKey> = {
  a: 'axis',
  l: 'legend',
  v: 'values',
  c: 'columns',
};

const ROLE_TO_CODE: Record<string, string> = {
  group: 'grp',
  sum: 'sum',
  avg: 'avg',
  min: 'min',
  max: 'max',
  count: 'cnt',
  countdistinct: 'cdt',
  year: 'yer',
  yearmonth: 'ymo',
  date: 'dat',
};
const CODE_TO_ROLE: Record<string, string> = Object.fromEntries(
  Object.entries(ROLE_TO_CODE).map(([k, v]) => [v, k]),
);

function aggToRole(bucket: BucketKey, agg: Agg | undefined): string {
  if (bucket === 'filters') return 'raw';
  const normalized = agg || (bucket === 'values' ? 'Sum' : 'Group');
  switch (normalized) {
    case 'Group': return 'group';
    case 'Sum': return 'sum';
    case 'Avg': return 'avg';
    case 'Min': return 'min';
    case 'Max': return 'max';
    case 'Count': return 'count';
    case 'CountDistinct': return 'countdistinct';
    case 'Year': return 'year';
    case 'YearMonth': return 'yearmonth';
    case 'Date': return 'date';
    default: return 'group';
  }
}

function roleToAgg(role: string): Agg | undefined {
  switch (role.toLowerCase()) {
    case 'group': return 'Group';
    case 'sum': return 'Sum';
    case 'avg': return 'Avg';
    case 'min': return 'Min';
    case 'max': return 'Max';
    case 'count': return 'Count';
    case 'countdistinct': return 'CountDistinct';
    case 'year': return 'Year';
    case 'yearmonth': return 'YearMonth';
    case 'date': return 'Date';
    default: return undefined;
  }
}

function encodeFieldAlias(bucket: BucketKey, field: FieldRef, seq: number): string {
  const role = aggToRole(bucket, field.agg);
  const b = BUCKET_TO_CODE[bucket];
  const r = ROLE_TO_CODE[role] || 'grp';
  const source = encodeURIComponent(field.col);
  // Always emit the ordinal (1-based) so trailing `_\d+` is unambiguous.
  return `${b}${r}_${source}_${seq + 1}`;
}

function decodeFieldAlias(alias: string): { bucket: BucketKey; agg: Agg | undefined; col: string; seq: number } | null {
  // Short form (default emit).
  let m = alias.match(ALIAS_PATTERN_SHORT);
  if (m) {
    const bucket = CODE_TO_BUCKET[m[1]];
    const role = CODE_TO_ROLE[m[2]];
    if (!bucket || !role) return null;
    const seq = Number(m[4]);
    if (!Number.isFinite(seq) || seq <= 0) return null;
    let col = m[3];
    try { col = decodeURIComponent(col); } catch { /* keep raw payload */ }
    return { bucket, agg: roleToAgg(role), col, seq };
  }
  // Long form (hand-written aliases).
  m = alias.match(ALIAS_PATTERN_LONG);
  if (m) {
    const bucket = m[1] as BucketKey;
    const role = m[2];
    const seq = Number(m[4]);
    if (!Number.isFinite(seq) || seq <= 0) return null;
    let col = m[3];
    try { col = decodeURIComponent(col); } catch { /* keep raw payload */ }
    return { bucket, agg: roleToAgg(role), col, seq };
  }
  return null;
}

function resolveResultCol(bucket: BucketKey, field: FieldRef, seq: number, cols: ColInfo[]): string {
  const name = encodeFieldAlias(bucket, field, seq);
  if (cols.some(c => c.name === name)) return name;
  return name;
}

function unquoteSqlIdent(raw: string): string {
  const t = raw.trim();
  if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).replace(/""/g, '"');
  return t;
}

function unquoteSqlString(raw: string): string {
  const t = raw.trim();
  if (t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  return t;
}

function splitWhereByAnd(whereSql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inSingle = false;
  let depth = 0;
  for (let i = 0; i < whereSql.length; i++) {
    const ch = whereSql[i];
    const next = whereSql[i + 1];
    if (ch === "'" && inSingle && next === "'") {
      cur += "''";
      i++;
      continue;
    }
    if (ch === "'") {
      inSingle = !inSingle;
      cur += ch;
      continue;
    }
    if (!inSingle) {
      if (ch === '(') depth++;
      if (ch === ')' && depth > 0) depth--;
      if (depth === 0 && /^\s+AND\s+/i.test(whereSql.slice(i))) {
        if (cur.trim()) out.push(cur.trim());
        const m = whereSql.slice(i).match(/^\s+AND\s+/i)!;
        i += m[0].length - 1;
        cur = '';
        continue;
      }
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function parseSimpleFilterPredicate(pred: string, typeByCol: Map<string, string>, table: string): FieldRef | null {
  const p = pred.trim();

  let m = p.match(/^("[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)\s+IS\s+NOT\s+NULL$/i);
  if (m) {
    const col = unquoteSqlIdent(m[1]);
    return { table, col, type: typeByCol.get(col) || 'VARCHAR', op: 'notnull', value: '' };
  }
  m = p.match(/^("[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)\s+IS\s+NULL$/i);
  if (m) {
    const col = unquoteSqlIdent(m[1]);
    return { table, col, type: typeByCol.get(col) || 'VARCHAR', op: 'null', value: '' };
  }

  m = p.match(/^("[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)\s*(=|!=|>=|<=|>|<)\s*(.+)$/i);
  if (m) {
    const col = unquoteSqlIdent(m[1]);
    const op = m[2];
    const rhs = m[3].trim();
    const val = unquoteSqlString(rhs);
    return { table, col, type: typeByCol.get(col) || 'VARCHAR', op, value: val };
  }

  return null;
}

function parseFiltersFromSql(sql: string, typeByCol: Map<string, string>, table: string): FieldRef[] {
  const whereMatch = sql.match(/\bWHERE\b([\s\S]*?)(?=\bGROUP\s+BY\b|\bORDER\s+BY\b|\bLIMIT\b|$)/i);
  if (!whereMatch) return [];
  const body = whereMatch[1].trim();
  if (!body) return [];
  const preds = splitWhereByAnd(body);
  const out: FieldRef[] = [];
  for (const pred of preds) {
    const parsed = parseSimpleFilterPredicate(pred, typeByCol, table);
    if (parsed) out.push(parsed);
  }
  return out;
}

function restoreBucketsFromSqlAliases(v: Visual, sql: string): number {
  const schema = state.tables.get(v.table)?.schema || [];
  const typeByCol = new Map(schema.map(s => [s.name, s.type]));

  const restored: Buckets = emptyBuckets();
  const seqSeen = new Set<string>();
  const aliasRegex = /\bAS\s+(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_$]*))/gi;
  let m: RegExpExecArray | null;
  while ((m = aliasRegex.exec(sql)) !== null) {
    const alias = m[1] || m[2];
    const decoded = decodeFieldAlias(alias);
    if (!decoded) continue;
    const key = `${decoded.bucket}::${decoded.seq}`;
    if (seqSeen.has(key)) continue;
    seqSeen.add(key);

    const entry: FieldRef = {
      table: v.table,
      col: decoded.col,
      type: typeByCol.get(decoded.col) || 'VARCHAR',
    };
    if (decoded.bucket === 'filters') {
      entry.op = 'notnull';
      entry.value = '';
    } else if (decoded.agg) {
      entry.agg = decoded.agg;
    }
    restored[decoded.bucket].push(entry);
  }

  const restoredFilters = parseFiltersFromSql(sql, typeByCol, v.table);
  const restoredCount = (restored.axis.length + restored.legend.length + restored.values.length + restored.columns.length);
  if (!restoredCount && !restoredFilters.length) return 0;

  v.buckets.axis = restored.axis;
  v.buckets.legend = restored.legend;
  v.buckets.values = restored.values;
  v.buckets.columns = restored.columns;
  v.buckets.filters = restoredFilters;
  return restoredCount + restoredFilters.length;
}

/**
 * Build a SELECT expression for a *raw* (non-aggregated) column.
 * For numeric DECIMAL / BIGINT / HUGEINT, Arrow JS exposes the underlying
 * BigInt and refuses to convert anything above Number.MAX_SAFE_INTEGER
 * ("X is not safe to convert to a number"). Casting to DOUBLE in SQL keeps
 * the precision JS can actually represent and avoids that runtime error.
 */
function rawColExpr(field: FieldRef): string {
  const c = quoteIdent(field.col);
  return isNumericType(field.type) ? `CAST(${c} AS DOUBLE)` : c;
}

function sqlQuoteValue(val: string | number | null | undefined, type: string) {
  if (val === null || val === undefined) return 'NULL';
  const s = String(val).trim();
  if (isNumericType(type) && s !== '' && !isNaN(Number(s))) return String(Number(s));
  return "'" + s.replace(/'/g, "''") + "'";
}
function buildFilterPredicate(f: FieldRef): string | null {
  const col = quoteIdent(f.col);
  const op = f.op || '=';
  const v = f.value;
  if (op === 'null')    return `${col} IS NULL`;
  if (op === 'notnull') return `${col} IS NOT NULL`;
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const esc = (s: string) => String(s).replace(/'/g, "''");
  switch (op) {
    case '=': case '!=': case '>': case '>=': case '<': case '<=':
      return `${col} ${op} ${sqlQuoteValue(v, f.type)}`;
    case 'contains': return `CAST(${col} AS VARCHAR) ILIKE '%${esc(v)}%'`;
    case 'starts':   return `CAST(${col} AS VARCHAR) ILIKE '${esc(v)}%'`;
    case 'ends':     return `CAST(${col} AS VARCHAR) ILIKE '%${esc(v)}'`;
    case 'in': {
      const items = String(v).split(',').map(s => s.trim()).filter(Boolean);
      if (!items.length) return null;
      return `${col} IN (${items.map(it => sqlQuoteValue(it, f.type)).join(', ')})`;
    }
  }
  return null;
}
function buildWhereClause(filters: FieldRef[] | undefined) {
  if (!filters || !filters.length) return '';
  const parts = filters.map(buildFilterPredicate).filter((p): p is string => !!p);
  return parts.length ? ' WHERE ' + parts.join(' AND ') : '';
}
function buildVisualSQL(v: Visual): string | null {
  const { buckets, table } = v;
  if (!table) return null;

  if (v.type === 'table') {
    const cols = buckets.columns;
    if (!cols.length) return null;
    const selectParts: string[] = [];
    const groupParts: string[] = [];
    cols.forEach((f, i) => {
      const alias = encodeFieldAlias('columns', f, i);
      if (f.agg && isDateBin(f.agg)) {
        const expr = aggExpr(f);
        selectParts.push(`${expr} AS ${quoteIdent(alias)}`);
        groupParts.push(expr);
      } else if (f.agg === 'Group') {
        selectParts.push(`${rawColExpr(f)} AS ${quoteIdent(alias)}`);
        groupParts.push(quoteIdent(f.col));
      } else {
        selectParts.push(`${aggExpr(f)} AS ${quoteIdent(alias)}`);
      }
    });
    let sql = `SELECT ${selectParts.join(', ')} FROM ${quoteIdent(table)}`;
    sql += buildWhereClause(buckets.filters);
    if (groupParts.length) {
      sql += ` GROUP BY ${groupParts.join(', ')}`;
      sql += ` ORDER BY ${groupParts.join(', ')}`;
    }
    sql += ` LIMIT ${SQL_ROW_LIMIT}`;
    return sql;
  }

  const vt = VISUAL_TYPES.find(t => t.key === v.type);
  const allowed = new Set(vt?.buckets || []);
  const dims: FieldRef[] = [
    ...(allowed.has('axis')   ? buckets.axis   : []),
    ...(allowed.has('legend') ? buckets.legend : []),
  ];
  const measures = allowed.has('values') ? buckets.values : [];
  if (!dims.length && !measures.length) return null;

  const selectParts: string[] = [];
  const groupParts: string[] = [];
  dims.forEach((d, i) => {
    const dimBucket: BucketKey = i < buckets.axis.length ? 'axis' : 'legend';
    const dimSeq = dimBucket === 'axis' ? i : (i - buckets.axis.length);
    const alias = encodeFieldAlias(dimBucket, d, dimSeq);
    if (d.agg && isDateBin(d.agg)) {
      // Date bin: row-level expression that also defines the grouping.
      const expr = aggExpr(d);
      selectParts.push(`${expr} AS ${quoteIdent(alias)}`);
      groupParts.push(expr);
    } else if (d.agg && d.agg !== 'Group') {
      // Aggregated dimension (e.g. Axis = Avg(UnitPrice)) collapses rows
      // alongside the measures; it must not appear in GROUP BY.
      selectParts.push(`${aggExpr(d)} AS ${quoteIdent(alias)}`);
    } else {
      selectParts.push(`${rawColExpr(d)} AS ${quoteIdent(alias)}`);
      groupParts.push(quoteIdent(d.col));
    }
  });
  if (measures.length) {
    measures.forEach((m, i) => {
      selectParts.push(`${aggExpr(m)} AS ${quoteIdent(encodeFieldAlias('values', m, i))}`);
    });
  } else {
    selectParts.push(`COUNT(*) AS ${quoteIdent('Count')}`);
  }
  let sql = `SELECT ${selectParts.join(', ')} FROM ${quoteIdent(table)}`;
  sql += buildWhereClause(buckets.filters);
  if (groupParts.length) sql += ` GROUP BY ${groupParts.join(', ')}`;
  if (groupParts.length) sql += ` ORDER BY ${groupParts.join(', ')}`;
  sql += ` LIMIT ${SQL_ROW_LIMIT}`;
  return sql;
}

async function runVisual(v: Visual) {
  const body = document.getElementById('vb-' + v.id);
  if (!body) return;
  const autoSql = buildVisualSQL(v);
  v.autoSQL = autoSql;
  const newSql = v.customSQL || autoSql;
  syncSqlEditor();
  if (!newSql) {
    v.sql = null;
    v.data = null;
    v.error = null;
    body.innerHTML = '<div class="visual-empty">Configure fields on the right to populate this visual</div>';
    return;
  }
  if (newSql === v.sql && v.data && !v.error) {
    renderVisualBody(v, body);
    return;
  }
  v.sql = newSql;
  body.innerHTML = '<div class="visual-empty">Loading...</div>';
  // Token guard: rapid field edits can spawn overlapping queries; only the
  // most recently issued one is allowed to commit its result.
  const token = (v._runToken ?? 0) + 1;
  v._runToken = token;
  try {
    const result = await state.conn!.query(newSql);
    if (v._runToken !== token) return;
    const cols: ColInfo[] = result.schema.fields.map((f: any) => ({
      name: f.name as string,
      type: String(f.type),
    }));
    const vectors = new Map<string, any>();
    for (let i = 0; i < cols.length; i++) {
      vectors.set(cols[i].name, result.getChildAt(i));
    }
    v.data = { cols, rowCount: result.numRows, vectors };
    v.error = null;
    renderVisualBody(v, body);
  } catch (e) {
    if (v._runToken !== token) return;
    console.error(e);
    v.error = (e as Error).message;
    v.data = null;
    body.innerHTML = `<div class="visual-empty" style="color:var(--err)">Query failed: ${escapeHtml((e as Error).message)}</div>`;
  }
}

/** Returns a fast accessor for a column; falls back to a null-producing getter
 *  when the column is absent so callers don't need to special-case it. */
function colGetter(data: VisualData, name: string): (i: number) => any {
  const vec = data.vectors.get(name);
  if (!vec) return () => null;
  return (i: number) => vec.get(i);
}

function renderVisualBody(v: Visual, body: HTMLElement) {
  const data = v.data!;
  if (!data.rowCount) {
    body.innerHTML = '<div class="visual-empty">No data</div>';
    return;
  }
  body.innerHTML = '';
  if (v.type === 'kpi') {
    renderKPI(v, body, data);
  } else if (v.type === 'table') {
    renderTable(v, body, data);
  } else {
    renderChart(v, body, data);
  }
}

function renderVisualResult(v: Visual) {
  const body = document.getElementById('vb-' + v.id);
  if (!body) return;
  if (v.error) {
    body.innerHTML = `<div class="visual-empty" style="color:var(--err)">Query failed: ${escapeHtml(v.error)}</div>`;
    return;
  }
  if (!v.data) {
    body.innerHTML = '<div class="visual-empty">Configure fields on the right to populate this visual</div>';
    return;
  }
  renderVisualBody(v, body);
}

function renderKPI(v: Visual, body: HTMLElement, data: VisualData) {
  const measure = v.buckets.values[0];
  const numCol = measure
    ? data.cols.find(c => c.name === resolveResultCol('values', measure, 0, data.cols))
    : data.cols.find(c => isNumericType(c.type));
  if (!numCol) {
    body.innerHTML = '<div class="visual-empty">Add a numeric field</div>';
    return;
  }
  const get = colGetter(data, numCol.name);
  let val = 0;
  for (let i = 0; i < data.rowCount; i++) {
    const n = toNum(get(i));
    if (n !== null) val += n;
  }
  const formatted = Number.isInteger(val)
    ? val.toLocaleString()
    : val.toLocaleString(undefined, { maximumFractionDigits: 2 });
  body.innerHTML = `
    <div class="visual-kpi">
      <div class="value">${formatted}</div>
      <div class="label">${escapeHtml(measure ? (measure.agg + ' of ' + measure.col) : numCol.name)}</div>
    </div>
  `;
}

function renderTable(_v: Visual, body: HTMLElement, data: VisualData) {
  const max = Math.min(data.rowCount, 200);
  const cols = data.cols;
  const getters = cols.map(c => colGetter(data, c.name));
  const head = cols.map(c => `<th>${escapeHtml(c.name)}</th>`).join('');
  const tbodyParts: string[] = [];
  for (let i = 0; i < max; i++) {
    let row = '<tr>';
    for (let j = 0; j < cols.length; j++) {
      const cell = formatCell(getters[j](i), cols[j].type);
      row += `<td class="${cell.cls}">${cell.html}</td>`;
    }
    row += '</tr>';
    tbodyParts.push(row);
  }
  body.innerHTML = `
    <div class="visual-table-wrap">
      <table class="visual-table">
        <thead><tr>${head}</tr></thead>
        <tbody>${tbodyParts.join('')}</tbody>
      </table>
    </div>
  `;
}

function renderChart(v: Visual, body: HTMLElement, data: VisualData) {
  body.innerHTML = '<div class="echarts-host"></div>';
  const host = body.querySelector('.echarts-host') as HTMLElement;
  Object.assign(host.style, { width: '100%', height: '100%' });

  const cols = data.cols;
  const rowCount = data.rowCount;

  const vtMeta = VISUAL_TYPES.find(t => t.key === v.type);
  const allowedB = new Set(vtMeta?.buckets || []);
  const axisField = allowedB.has('axis') ? v.buckets.axis[0] : undefined;
  const legendField = allowedB.has('legend') ? v.buckets.legend[0] : undefined;
  const valueFields = v.buckets.values.length
    ? v.buckets.values
    : [{ col: 'Count', agg: undefined as Agg | undefined, _isCount: true } as FieldRef & { _isCount: true }];

  const axisResultCol = axisField
    ? resolveResultCol('axis', axisField, 0, cols)
    : undefined;
  const legendResultCol = legendField
    ? resolveResultCol('legend', legendField, 0, cols)
    : undefined;

  const xName = axisResultCol || legendResultCol || cols[0].name;
  const yColsInResult = valueFields.map((m: any, i: number) => {
    if (m._isCount) return 'Count';
    return resolveResultCol('values', m, i, cols);
  });

  const isStacked = v.type === 'stackedBar' || v.type === 'stackedColumn';
  let visualKind: string = v.type;
  if (v.type === 'stackedBar') visualKind = 'bar';
  if (v.type === 'stackedColumn') visualKind = 'column';

  const isCircular = visualKind === 'pie' || visualKind === 'doughnut';
  const isHorizontal = visualKind === 'column';

  const theme = chartTheme();
  const baseTextStyle = { fontFamily: 'inherit', fontSize: 11, color: theme.tickColor };
  const tooltipStyle = {
    backgroundColor: theme.tooltipBg,
    borderColor: theme.tooltipBorder,
    textStyle: { color: theme.tooltipText, fontSize: 12 },
    extraCssText: 'box-shadow: 0 2px 8px rgba(0,0,0,0.2);',
  };
  const gridConfig = { left: 8, right: 8, top: 28, bottom: 8, containLabel: true };

  let option: any;

  if (isCircular) {
    const getX = colGetter(data, xName);
    const getY = colGetter(data, yColsInResult[0]);
    const pieData = new Array(rowCount);
    for (let i = 0; i < rowCount; i++) {
      pieData[i] = { name: labelOf(getX(i)), value: toNum(getY(i)) ?? 0 };
    }
    option = {
      tooltip: { trigger: 'item', ...tooltipStyle },
      legend: { type: 'scroll', bottom: 0, textStyle: baseTextStyle, itemWidth: 12, itemHeight: 8 },
      series: [{
        type: 'pie',
        radius: visualKind === 'doughnut' ? ['45%', '70%'] : '70%',
        center: ['50%', '45%'],
        avoidLabelOverlap: true,
        label: { show: false },
        labelLine: { show: false },
        data: pieData,
      }],
    };
  } else if (visualKind === 'scatter') {
    const getX = colGetter(data, xName);
    let series: any[];
    if (legendField && yColsInResult.length === 1) {
      // One series per legend value, so points get split & color-coded by it.
      const yCol = yColsInResult[0];
      const getY = colGetter(data, yCol);
      const getLegend = colGetter(data, legendResultCol!);
      const buckets = new Map<string, [number, number][]>();
      const order: string[] = [];
      for (let i = 0; i < rowCount; i++) {
        const x = toNum(getX(i));
        const yv = toNum(getY(i));
        if (x === null || yv === null) continue;
        const lbl = labelOf(getLegend(i));
        let arr = buckets.get(lbl);
        if (!arr) { arr = []; buckets.set(lbl, arr); order.push(lbl); }
        arr.push([x, yv]);
      }
      series = order.map(lbl => ({
        name: lbl, type: 'scatter', symbolSize: 6, data: buckets.get(lbl)!,
      }));
    } else {
      series = yColsInResult.map(y => {
        const getY = colGetter(data, y);
        const points: [number, number][] = [];
        for (let i = 0; i < rowCount; i++) {
          const x = toNum(getX(i));
          const yv = toNum(getY(i));
          if (x !== null && yv !== null) points.push([x, yv]);
        }
        return { name: y, type: 'scatter', symbolSize: 6, data: points };
      });
    }
    option = {
      tooltip: { trigger: 'item', ...tooltipStyle },
      legend: { top: 0, textStyle: baseTextStyle, itemWidth: 12, itemHeight: 8 },
      grid: gridConfig,
      xAxis: { type: 'value', axisLabel: baseTextStyle, axisLine: { lineStyle: { color: theme.gridColor } }, splitLine: { lineStyle: { color: theme.gridColor } } },
      yAxis: { type: 'value', axisLabel: baseTextStyle, axisLine: { lineStyle: { color: theme.gridColor } }, splitLine: { lineStyle: { color: theme.gridColor } } },
      series,
    };
  } else {
    const seriesType = (visualKind === 'line' || visualKind === 'area') ? 'line' : 'bar';
    const isArea = visualKind === 'area';

    let categories: any[]; let series: any[];
    if (legendField && axisField && yColsInResult.length === 1) {
      const yCol = yColsInResult[0];
      const getAxis = colGetter(data, axisResultCol!);
      const getLegend = colGetter(data, legendResultCol!);
      const getY = colGetter(data, yCol);
      // Index rows by (axisLabel, legendLabel) once so series construction
      // is O(rows + categories*legends) instead of O(rows*categories*legends).
      const index = new Map<string, Map<string, number | null>>();
      const legendOrder: string[] = [];
      const legendSeen = new Set<string>();
      for (let i = 0; i < rowCount; i++) {
        const a = labelOf(getAxis(i));
        const l = labelOf(getLegend(i));
        let inner = index.get(a);
        if (!inner) { inner = new Map(); index.set(a, inner); }
        inner.set(l, toNum(getY(i)));
        if (!legendSeen.has(l)) { legendSeen.add(l); legendOrder.push(l); }
      }
      categories = [...index.keys()];
      series = legendOrder.map(lv => ({
        name: lv,
        type: seriesType,
        stack: isStacked ? 'total' : undefined,
        areaStyle: isArea ? {} : undefined,
        smooth: seriesType === 'line' ? 0.2 : false,
        symbol: 'circle',
        symbolSize: 5,
        data: categories.map(xv => {
          const inner = index.get(xv);
          return inner ? (inner.get(lv) ?? null) : null;
        }),
      }));
    } else {
      const getX = colGetter(data, xName);
      categories = new Array(rowCount);
      for (let i = 0; i < rowCount; i++) categories[i] = labelOf(getX(i));
      series = yColsInResult.map(y => {
        const getY = colGetter(data, y);
        const seriesData = new Array(rowCount);
        for (let i = 0; i < rowCount; i++) seriesData[i] = toNum(getY(i));
        return {
          name: y,
          type: seriesType,
          stack: isStacked ? 'total' : undefined,
          areaStyle: isArea ? {} : undefined,
          smooth: seriesType === 'line' ? 0.2 : false,
          symbol: 'circle',
          symbolSize: 5,
          data: seriesData,
        };
      });
    }

    const catAxis = {
      type: 'category', data: categories,
      axisLabel: { ...baseTextStyle, rotate: 0, hideOverlap: true },
      axisLine: { lineStyle: { color: theme.gridColor } },
      axisTick: { lineStyle: { color: theme.gridColor } },
    };
    const valAxis = {
      type: 'value',
      axisLabel: baseTextStyle,
      axisLine: { show: false },
      splitLine: { lineStyle: { color: theme.gridColor } },
    };

    option = {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, ...tooltipStyle },
      legend: { top: 0, textStyle: baseTextStyle, itemWidth: 12, itemHeight: 8 },
      grid: gridConfig,
      xAxis: isHorizontal ? valAxis : catAxis,
      yAxis: isHorizontal ? catAxis : valAxis,
      series,
    };
  }

  disposeVisualChart(v);
  v._chart = echarts.init(host, null, { renderer: 'canvas' });
  v._chart.setOption(option);

  v._chartRO = new ResizeObserver(() => { try { v._chart && v._chart.resize(); } catch { /* ignore */ } });
  v._chartRO.observe(host);
}

function refreshVisualTheme() {
  if (!state.visuals.length) return;
  renderReportPage();
}

const themeClassObserver = new MutationObserver((mutations) => {
  for (const m of mutations) {
    if (m.type === 'attributes' && m.attributeName === 'class') {
      refreshVisualTheme();
      break;
    }
  }
});

themeClassObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });

/* ===================== Ribbon / file loading ===================== */
function clearWorkspaceVisuals() {
  if (!state.visuals.length) return;

  state.visuals.forEach(disposeVisualChart);

  state.visuals = [];
  state.selectedId = null;
  state.buckets = emptyBuckets();
  closeMenus();

  renderReportPage();
  renderVisualTypes();
  renderDropzones();
  updateRibbonState();
  syncSqlEditor();
}

function exportVisualCSV(v: Visual) {
  if (!v || !v.data) { setStatus('Nothing to export', 'err'); return; }
  const data = v.data;
  const cols = data.cols;
  const getters = cols.map(c => colGetter(data, c.name));
  const lines = [cols.map(c => c.name).join(',')];
  for (let i = 0; i < data.rowCount; i++) {
    const cells: string[] = new Array(cols.length);
    for (let j = 0; j < cols.length; j++) {
      const x = getters[j](i);
      if (x === null || x === undefined) { cells[j] = ''; continue; }
      const s = (typeof x === 'object') ? JSON.stringify(x) : String(x);
      cells[j] = /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }
    lines.push(cells.join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const safeName = (visualTitle(v) || 'visual').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);
  a.href = url; a.download = `${safeName}.csv`; a.click();
  URL.revokeObjectURL(url);
}

/* ===================== SQL editor ===================== */
function syncSqlEditor() {
  const ta = $('sqlEditor') as HTMLTextAreaElement;
  const badge = $('sqlBadge');
  const sel = getSelectedVisual();
  if (!sel) {
    ta.value = '';
    ta.disabled = true;
    ta.setAttribute('aria-disabled', 'true');
    ta.placeholder = 'Select a visual to inspect and edit its SQL';
    badge.hidden = true;
    badge.setAttribute('aria-hidden', 'true');
    return;
  }
  ta.disabled = false;
  ta.setAttribute('aria-disabled', 'false');
  if (document.activeElement !== ta) {
    ta.value = sel.customSQL || sel.autoSQL || buildVisualSQL(sel) || '';
  }
  badge.hidden = !sel.customSQL;
  badge.setAttribute('aria-hidden', String(!sel.customSQL));
}
function applySqlEdit() {
  const sel = getSelectedVisual();
  if (!sel) { setStatus('Select a visual first', 'err'); return; }
  const val = ($('sqlEditor') as HTMLTextAreaElement).value.trim();
  if (!val) { setStatus('SQL is empty', 'err'); return; }
  const auto = buildVisualSQL(sel);
  sel.autoSQL = auto;
  sel.customSQL = (val === (auto || '').trim()) ? null : val;
  if (sel.customSQL) {
    const restored = restoreBucketsFromSqlAliases(sel, sel.customSQL);
    if (restored > 0) {
      renderDropzones();
      const titleEl = document.querySelector(`.visual[data-id="${sel.id}"] .visual-title`);
      if (titleEl) titleEl.textContent = visualTitle(sel);
    }
  }
  runVisual(sel);
  syncSqlEditor();
}
function resetSqlEdit() {
  const sel = getSelectedVisual();
  if (!sel) return;
  sel.customSQL = null;
  runVisual(sel);
  syncSqlEditor();
}
async function copySqlEdit() {
  const ta = $('sqlEditor') as HTMLTextAreaElement;
  const text = (ta.value || '').trim();
  const btn = $('sqlCopyBtn');
  if (!text) { setStatus('SQL is empty, nothing to copy', 'err'); return; }
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      ta.focus(); ta.select(); document.execCommand('copy');
    }
    const orig = btn.innerHTML;
    btn.innerHTML = MENU_ICONS.check;
    btn.classList.add('ok');
    setTimeout(() => { btn.innerHTML = orig; btn.classList.remove('ok'); }, 1200);
  } catch (err) {
    setStatus('Copy failed: ' + ((err as Error)?.message || String(err)), 'err');
  }
}
/* ===================== Host API ===================== */
// Exposed to host (vscode webview / webapp). Hosts wire their data sources
// (vscode-bridge message bus, browser File API / fetch) to this API.

interface PendingFile {
  name: string;
  size: number;
  chunks: number;
  /** Pre-allocated destination buffer; chunks are written directly into it. */
  buffer: Uint8Array;
  offset: number;
  received: number;
}
let pendingFile: PendingFile | null = null;

async function ingestBytes(name: string, bytes: Uint8Array) {
  if (!state.db || !state.conn) {
    try {
      await duckReady;
    } catch (e) {
      setStatus('DuckDB initialization failed: ' + (e as Error).message, 'err');
      return;
    }
  }
  await registerBytes(name, bytes);
}

/**
 * Public API for hosts to push data into the app.
 * Webapp uses loadBytes directly. The vscode host can also use the chunked
 * helpers to handle the extension's load-file-begin/chunk/end protocol.
 */
export const app = {
  /** Load a complete file into the app. */
  loadBytes(name: string, bytes: Uint8Array): Promise<void> {
    return ingestBytes(name, bytes);
  },
  /** Display an error message in the status bar. */
  setError(message: string): void {
    setStatus(message, 'err');
  },
  /** Display an info/loading message in the status bar. */
  setStatus(message: string, kind: 'loading' | 'ok' | 'err' = 'loading'): void {
    setStatus(message, kind);
  },
  /** Begin a chunked file transfer (used by vscode host). */
  beginChunkedLoad(name: string, size: number, chunks: number): void {
    pendingFile = {
      name,
      size,
      chunks,
      // Allocate the final buffer up front so we never hold two copies of
      // the file at once (chunks + merged buffer) - halves peak memory.
      buffer: new Uint8Array(size),
      offset: 0,
      received: 0,
    };
    const mb = (size / (1024 * 1024)).toFixed(1);
    setStatus(`Loading ${name} (${mb} MB)...`, 'loading');
  },
  /** Append a chunk to the pending file. */
  appendChunk(index: number, bytes: Uint8Array): void {
    if (!pendingFile) throw new Error('Got file chunk without begin');
    if (index !== pendingFile.received) {
      throw new Error(`Out-of-order chunk: got ${index}, expected ${pendingFile.received}`);
    }
    if (pendingFile.offset + bytes.byteLength > pendingFile.size) {
      throw new Error('Chunk overflows declared file size');
    }
    pendingFile.buffer.set(bytes, pendingFile.offset);
    pendingFile.offset += bytes.byteLength;
    pendingFile.received++;
    if (pendingFile.chunks > 1) {
      const pct = Math.round((pendingFile.received / pendingFile.chunks) * 100);
      setStatus(`Loading ${pendingFile.name}... ${pct}%`, 'loading');
    }
  },
  /** Finalize a chunked file transfer and ingest the assembled bytes. */
  async endChunkedLoad(): Promise<void> {
    if (!pendingFile) throw new Error('Got file end without begin');
    const pf = pendingFile;
    pendingFile = null;
    if (pf.received !== pf.chunks) {
      throw new Error(`Missing chunks: got ${pf.received}, expected ${pf.chunks}`);
    }
    if (pf.offset !== pf.size) {
      throw new Error(`Reassembled size mismatch: got ${pf.offset}, expected ${pf.size}`);
    }
    await ingestBytes(pf.name, pf.buffer);
  },
  /** Reset chunked-load state after an error. */
  resetChunkedLoad(): void {
    pendingFile = null;
  },
};

// Start DuckDB; host wires data ingress through `app`.
function _initWelcomeIcon() {
  const welcomeIconEl = document.getElementById('welcomeIcon');
  if (welcomeIconEl) welcomeIconEl.innerHTML = BRAND_ICONS.bookDatabaseColor;
}

/* ===================== Initialization ===================== */
function _initWorkspace() {
  _initWelcomeIcon();
  applyUiIcons();
  renderVisualTypes();
  renderDropzones();
  renderFieldsTree();
  syncSqlEditor();
  updateRibbonState();
  ($('newVisualBtn') as HTMLButtonElement).onclick = () => addVisual(state.visualType);
  ($('refreshBtn') as HTMLButtonElement).onclick = () => state.visuals.forEach(runVisual);
  ($('clearPageBtn') as HTMLButtonElement).onclick = clearWorkspaceVisuals;
  ($('sqlApplyBtn') as HTMLElement).onclick = applySqlEdit;
  ($('sqlResetBtn') as HTMLElement).onclick = resetSqlEdit;
  ($('sqlCopyBtn') as HTMLElement).onclick = copySqlEdit;
  $('sqlEditor').addEventListener('keydown', (e) => {
    const ev = e as KeyboardEvent;
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
      ev.preventDefault();
      applySqlEdit();
    } else if (ev.key === 'Tab') {
      ev.preventDefault();
      const ta = ev.target as HTMLTextAreaElement;
      const s = ta.selectionStart, end = ta.selectionEnd;
      ta.value = ta.value.slice(0, s) + '  ' + ta.value.slice(end);
      ta.selectionStart = ta.selectionEnd = s + 2;
    }
  });
  void bootstrap();
}

/**
 * Mount the workspace UI into a host element.
 * Injects the workspace HTML template, wires DOM events, starts DuckDB.
 * Idempotent: subsequent calls are no-ops.
 *
 * @param host - The element to render the workspace into. Defaults to document.body.
 */
let _mounted = false;
export function mountWorkspace(host: HTMLElement = document.body): void {
  if (_mounted) return;
  _mounted = true;
  host.insertAdjacentHTML('beforeend', workspaceHtml);
  _initWorkspace();
}
