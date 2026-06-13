// Render assets/icon.svg into all PNG sizes consumed by sub-packages.
// Outputs:
//   - vscode/assets/icon.png  (128x128)
//   - chrome/icons/icon-16.png / icon-32.png / icon-48.png / icon-128.png
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Resvg } from '@resvg/resvg-js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const svg = readFileSync(resolve(root, 'assets', 'icon.svg'), 'utf8');

function renderTo(path, size) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: size },
    background: 'rgba(0,0,0,0)',
  });
  const png = resvg.render().asPng();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, png);
  console.log(`Wrote ${path} (${png.byteLength} bytes, ${size}x${size})`);
}

renderTo(resolve(root, 'vscode', 'assets', 'icon.png'), 128);
for (const size of [16, 32, 48, 128]) {
  renderTo(resolve(root, 'chrome', 'icons', `icon-${size}.png`), size);
}
