// VS Code webview entry point.
// Imports the shared app (which auto-bootstraps) and wires the VS Code
// message bus to the app's data ingress API.

import { app, mountWorkspace } from '@powerduck/shared';
import { getVsCode, onMessage } from './vscode-bridge';

mountWorkspace();

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

onMessage(async (m) => {
  try {
    if (m.type === 'load-file') {
      const bytes = base64ToBytes(m.base64);
      if (typeof m.size === 'number' && bytes.byteLength !== m.size) {
        throw new Error(
          `Decoded payload size mismatch: got ${bytes.byteLength}, expected ${m.size}`,
        );
      }
      await app.loadBytes(m.name, bytes);
    } else if (m.type === 'load-file-begin') {
      app.beginChunkedLoad(m.name, m.size, m.chunks);
    } else if (m.type === 'load-file-chunk') {
      app.appendChunk(m.index, base64ToBytes(m.base64));
    } else if (m.type === 'load-file-end') {
      await app.endChunkedLoad();
    } else if (m.type === 'error') {
      app.setError(m.message);
    }
  } catch (e) {
    app.resetChunkedLoad();
    app.setError('Failed to open file: ' + (e as Error).message);
    console.error(e);
  }
});

// Tell the extension we're ready to receive the initial file.
getVsCode()?.postMessage({ type: 'ready' });
