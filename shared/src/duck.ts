import * as duckdb from '@duckdb/duckdb-wasm';

// Vite ?url imports become webview-resolvable URLs after build.
import eh_wasm    from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import eh_worker  from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';

// VS Code webviews run in Chromium/Electron, which always supports EH wasm,
// so `selectBundle` will always pick `eh`. The `mvp` entry is only present
// because `DuckDBBundles` requires it; we point it at the EH assets so we
// only ship one wasm/worker pair, and assert at runtime that EH was chosen.
const BUNDLES: duckdb.DuckDBBundles = {
  mvp: { mainModule: eh_wasm, mainWorker: eh_worker },
  eh:  { mainModule: eh_wasm, mainWorker: eh_worker },
};

export interface DuckHandles {
  db: duckdb.AsyncDuckDB;
  conn: duckdb.AsyncDuckDBConnection;
  version: string;
  /** Terminate the worker, close the connection, and release blob URLs. */
  dispose: () => Promise<void>;
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  label: string,
): Promise<Response> {
  const ac = new AbortController();
  const resp = await withTimeout(
    fetch(url, { signal: ac.signal }),
    timeoutMs,
    label,
    () => ac.abort(),
  );
  if (!resp.ok) {
    throw new Error(`${label} failed: ${resp.status} ${resp.statusText}`);
  }
  return resp;
}

export async function initDuckDB(onStage?: (stage: string) => void): Promise<DuckHandles> {
  onStage?.('selecting bundle');
  const bundle = await withTimeout(
    duckdb.selectBundle(BUNDLES),
    20000,
    'DuckDB bundle selection',
  );

  // VS Code webviews live at a custom origin (vscode-webview://...).
  // - We cannot construct a Worker directly from a vscode-resource URL.
  // - importScripts() of the vscode-resource URL is also blocked by CSP.
  // Workaround: fetch the worker source as text and inline it into a blob,
  // so the Worker runs same-origin with the real script content.
  onStage?.('starting worker');
  const workerResp = await fetchWithTimeout(
    bundle.mainWorker!,
    20000,
    'Fetch DuckDB worker script',
  );
  const workerSource = await workerResp.text();
  const workerUrl = URL.createObjectURL(
    new Blob([workerSource], { type: 'text/javascript' }),
  );
  // NOTE: do NOT revoke workerUrl here. DuckDB's worker may resolve relative
  // imports against its own URL; keep the blob alive until dispose().
  const worker = new Worker(workerUrl);

  // Surface worker errors during init by racing them against each await below.
  let workerErrorListener: ((ev: Event) => void) | null = null;
  const workerErrorDuringInit = new Promise<never>((_, reject) => {
    workerErrorListener = (ev: Event) => {
      const msg = (ev as ErrorEvent).message || 'unknown';
      reject(new Error(`DuckDB worker error: ${msg}`));
    };
    worker.addEventListener('error', workerErrorListener, { once: true });
  });

  const logger = new duckdb.ConsoleLogger();
  const db = new duckdb.AsyncDuckDB(logger, worker);

  // The webview Worker cannot reach vscode-resource URLs either, so we
  // pre-fetch the wasm in the main thread and hand DuckDB a same-origin
  // blob URL. This avoids the worker stalling on a forbidden fetch.
  onStage?.('downloading wasm');
  const wasmResp = await Promise.race([
    fetchWithTimeout(bundle.mainModule!, 60000, 'Fetch DuckDB wasm'),
    workerErrorDuringInit,
  ]);
  let wasmBytes: ArrayBuffer | null = await wasmResp.arrayBuffer();
  const wasmBlobUrl = URL.createObjectURL(
    new Blob([wasmBytes], { type: 'application/wasm' }),
  );
  // Blob already owns a copy; drop our reference so GC can reclaim the
  // original ~34MB buffer instead of keeping two copies alive.
  wasmBytes = null;

  onStage?.('instantiating wasm');
  try {
    await Promise.race([
      // VS Code webviews are not cross-origin isolated, so force single-threaded
      // instantiate to avoid pthread worker startup hangs.
      withTimeout(
        db.instantiate(wasmBlobUrl, undefined),
        180000,
        'DuckDB wasm instantiate',
      ),
      workerErrorDuringInit,
    ]);
  } finally {
    URL.revokeObjectURL(wasmBlobUrl);
  }

  // Init succeeded; stop racing worker errors against init.
  if (workerErrorListener) {
    worker.removeEventListener('error', workerErrorListener);
    workerErrorListener = null;
  }

  onStage?.('connecting');
  const conn = await withTimeout(db.connect(), 30000, 'DuckDB connect');

  let version = 'unknown';
  try {
    onStage?.('reading version');
    const r = await conn.query('SELECT version() AS v');
    version = String(r.toArray()[0].toJSON().v);
  } catch (err) {
    console.warn('DuckDB version query failed:', err);
  }

  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    try { await conn.close(); } catch (err) { console.warn('conn.close failed:', err); }
    try { await db.terminate(); } catch (err) { console.warn('db.terminate failed:', err); }
    URL.revokeObjectURL(workerUrl);
  };

  return { db, conn, version, dispose };
}

export { duckdb };

