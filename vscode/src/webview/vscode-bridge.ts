// Thin typed wrapper around the VS Code webview message bus.
//
// `acquireVsCodeApi` is injected by the webview host; we don't import it.

export interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState<T = unknown>(): T | undefined;
  setState<T>(state: T): void;
}

declare global {
  interface Window {
    acquireVsCodeApi?: () => VsCodeApi;
  }
}

let _api: VsCodeApi | undefined;

export function getVsCode(): VsCodeApi | undefined {
  if (_api) return _api;
  if (typeof window.acquireVsCodeApi === 'function') {
    try {
      _api = window.acquireVsCodeApi();
      return _api;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export type InboundMessage =
  | { type: 'load-file'; name: string; base64: string; size?: number }
  | { type: 'load-file-begin'; name: string; size: number; chunks: number }
  | { type: 'load-file-chunk'; index: number; base64: string }
  | { type: 'load-file-end' }
  | { type: 'no-initial-file' }
  | { type: 'error'; message: string };

export function onMessage(handler: (m: InboundMessage) => void): void {
  window.addEventListener('message', (ev) => {
    const data = ev.data as InboundMessage | undefined;
    if (data && typeof (data as { type?: unknown }).type === 'string') {
      handler(data);
    }
  });
}
