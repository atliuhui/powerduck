/**
 * Standalone app entry shared by webapp and chrome app shells.
 *
 * Flow:
 *   1. Mount explorer (file/url/history picker) to <body>.
 *   2. On data selection: read bytes, push to history, swap explorer for workspace.
 *   3. Lazy-load workspace bundle only when needed.
 *   4. Feed bytes via app.loadBytes().
 */

import { mountExplorer, type ExplorerHandle } from './standalone/explorer';
import { readFile, fetchUrl, type LoadedData } from './standalone/data-loader';
import * as history from './standalone/history';

let explorer: ExplorerHandle | null = null;
let workspaceMounted = false;

async function showWorkspace(data: LoadedData): Promise<void> {
  // Lazy-load workspace so heavy data-viz modules load on demand.
  const { app, mountWorkspace } = await import('./workspace');
  if (!workspaceMounted) {
    const previousExplorer = explorer;
    workspaceMounted = true;
    previousExplorer?.unmount();
    explorer = null;
    mountWorkspace(document.body);
  }
  try {
    await app.loadBytes(data.name, data.bytes);
  } catch (err) {
    app.setError('Failed to open file: ' + (err instanceof Error ? err.message : String(err)));
    console.error(err);
  }
}

async function handleLoadFile(file: File): Promise<void> {
  if (!explorer) return;
  explorer.setError('');
  explorer.setLoading(`Reading ${file.name}…`);
  try {
    const data = await readFile(file);
    history.add({ name: data.name, type: 'local', size: data.size });
    await showWorkspace(data);
  } catch (err) {
    explorer?.setError(err instanceof Error ? err.message : String(err));
  }
}

async function handleLoadUrl(url: string, displayName?: string): Promise<void> {
  if (!explorer) return;
  explorer.setError('');
  explorer.setLoading(`Fetching ${displayName ?? url}…`);
  try {
    const data = await fetchUrl(url);
    history.add({ name: displayName ?? data.name, type: 'url', url });
    await showWorkspace(data);
  } catch (err) {
    explorer?.setError(err instanceof Error ? err.message : String(err));
  }
}

export function startStandaloneApp(): void {
  explorer = mountExplorer(document.body, {
    onLoadFile: handleLoadFile,
    onLoadUrl: handleLoadUrl,
  });
}

export function autoStartStandaloneApp(): void {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startStandaloneApp);
  } else {
    startStandaloneApp();
  }
}
