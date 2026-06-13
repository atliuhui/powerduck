import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

const SUPPORTED_EXT = new Set([
  '.parquet', '.csv', '.tsv', '.json', '.jsonl', '.ndjson', '.txt',
]);

export function activate(context: vscode.ExtensionContext): void {
  const open = vscode.commands.registerCommand(
    'powerduck.open',
    async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
      const target = pickTargetUri(uri, uris);
      await openPanel(context, target);
    },
  );
  context.subscriptions.push(open);
}

export function deactivate(): void {
  // no-op
}

function pickTargetUri(
  uri: vscode.Uri | undefined,
  uris: vscode.Uri[] | undefined,
): vscode.Uri | undefined {
  if (uri instanceof vscode.Uri) return uri;
  if (uris && uris.length > 0) return uris[0];
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active && SUPPORTED_EXT.has(path.extname(active.fsPath).toLowerCase())) {
    return active;
  }
  return undefined;
}

async function openPanel(
  context: vscode.ExtensionContext,
  fileUri: vscode.Uri | undefined,
): Promise<void> {
  const title = fileUri
    ? `PowerDuck — ${path.basename(fileUri.fsPath)}`
    : 'PowerDuck';

  const panel = vscode.window.createWebviewPanel(
    'powerduck.viewer',
    title,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview'),
        vscode.Uri.joinPath(context.extensionUri, 'media'),
      ],
    },
  );

  panel.iconPath = {
    light: vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png'),
    dark: vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png'),
  };

  let initialSent = false;
  const onReadyMessage = panel.webview.onDidReceiveMessage(
    async (msg: { type?: string }) => {
      if (!msg || typeof msg.type !== 'string') return;
      if (msg.type === 'ready') {
        if (initialSent) return;
        initialSent = true;
        if (fileUri) {
          await sendFile(panel, fileUri);
        } else {
          panel.webview.postMessage({ type: 'no-initial-file' });
        }
      }
    },
  );
  panel.onDidDispose(() => onReadyMessage.dispose());

  panel.webview.html = await buildHtml(context, panel.webview);
}

async function sendFile(panel: vscode.WebviewPanel, uri: vscode.Uri): Promise<void> {
  // V8's max string length is ~512MB; a single base64 string can't carry very
  // large files. Stream the file in raw 16MB chunks, encoding each chunk to
  // base64 individually so neither side ever materialises a string close to
  // that limit. For file:// URIs use a real fs read stream so we don't load
  // the entire file into the extension host first.
  const CHUNK_SIZE = 16 * 1024 * 1024;
  const name = path.basename(uri.fsPath);

  try {
    if (uri.scheme === 'file') {
      const total = (await fs.promises.stat(uri.fsPath)).size;
      const chunkCount = total === 0 ? 1 : Math.ceil(total / CHUNK_SIZE);

      panel.webview.postMessage({
        type: 'load-file-begin',
        name,
        size: total,
        chunks: chunkCount,
      });

      if (total === 0) {
        panel.webview.postMessage({ type: 'load-file-chunk', index: 0, base64: '' });
      } else {
        const stream = fs.createReadStream(uri.fsPath, { highWaterMark: CHUNK_SIZE });
        let index = 0;
        let carry: Buffer | null = null;
        for await (const part of stream) {
          // highWaterMark is an upper bound; coalesce small reads into full chunks.
          const buf: Buffer = carry
            ? Buffer.concat([carry, part as Buffer])
            : (part as Buffer);
          let offset = 0;
          while (buf.length - offset >= CHUNK_SIZE) {
            const slice = buf.subarray(offset, offset + CHUNK_SIZE);
            panel.webview.postMessage({
              type: 'load-file-chunk',
              index: index++,
              base64: slice.toString('base64'),
            });
            offset += CHUNK_SIZE;
          }
          carry = offset < buf.length ? buf.subarray(offset) : null;
        }
        if (carry && carry.length > 0) {
          panel.webview.postMessage({
            type: 'load-file-chunk',
            index: index++,
            base64: carry.toString('base64'),
          });
        }
      }
    } else {
      // Non-file scheme (e.g. remote FS): fall back to workspace.fs.
      const bytes = await vscode.workspace.fs.readFile(uri);
      const total = bytes.byteLength;
      const chunkCount = total === 0 ? 1 : Math.ceil(total / CHUNK_SIZE);

      panel.webview.postMessage({
        type: 'load-file-begin',
        name,
        size: total,
        chunks: chunkCount,
      });

      for (let i = 0; i < chunkCount; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, total);
        const slice = Buffer.from(
          bytes.buffer,
          bytes.byteOffset + start,
          end - start,
        );
        panel.webview.postMessage({
          type: 'load-file-chunk',
          index: i,
          base64: slice.toString('base64'),
        });
      }
    }

    panel.webview.postMessage({ type: 'load-file-end' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    panel.webview.postMessage({ type: 'error', message });
    vscode.window.showErrorMessage(`PowerDuck: failed to read file — ${message}`);
  }
}

async function buildHtml(
  context: vscode.ExtensionContext,
  webview: vscode.Webview,
): Promise<string> {
  const webviewRoot = vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview');
  const indexPath = path.join(webviewRoot.fsPath, 'index.html');

  let html: string;
  try {
    html = await fs.promises.readFile(indexPath, 'utf8');
  } catch {
    return `<!doctype html><html><body style="font-family:sans-serif;padding:24px">
      <h2>PowerDuck</h2>
      <p>Webview assets are missing. Please run <code>npm run build</code> first.</p>
      <p>Not found: <code>${escapeHtml(indexPath)}</code></p>
    </body></html>`;
  }

  const baseUri = webview.asWebviewUri(webviewRoot).toString().replace(/\/?$/, '/');
  const nonce = makeNonce();

  // Content Security Policy
  //   - script: only our bundle + WASM eval (DuckDB)
  //   - worker: blob: required by DuckDB's worker bootstrap
  //   - connect: webview origin + blob/data, plus the DuckDB extension CDN.
  //     DuckDB-WASM ships the core runtime but lazy-loads format extensions
  //     (e.g. parquet) from https://extensions.duckdb.org on first use.
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data: blob:`,
    `script-src ${webview.cspSource} 'wasm-unsafe-eval' 'nonce-${nonce}'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource} data:`,
    `connect-src ${webview.cspSource} blob: data: https://extensions.duckdb.org`,
    `worker-src ${webview.cspSource} blob:`,
    `child-src ${webview.cspSource} blob:`,
  ].join('; ');

  // Inject <base> so the build's relative URLs resolve under the webview origin.
  // Inject CSP at the very top of <head>.
  html = html.replace(
    /<head([^>]*)>/i,
    `<head$1>\n  <meta http-equiv="Content-Security-Policy" content="${csp}">\n  <base href="${baseUri}">`,
  );

  // Add nonce to every <script> tag emitted by Vite (they otherwise have no nonce).
  html = html.replace(/<script\b([^>]*)>/gi, (_m, attrs: string) => {
    if (/nonce=/.test(attrs)) return `<script${attrs}>`;
    return `<script nonce="${nonce}"${attrs}>`;
  });

  return html;
}

function makeNonce(): string {
  // CSP nonce must be unpredictable; use a CSPRNG.
  return randomBytes(16).toString('base64');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>
  )[c]!);
}
