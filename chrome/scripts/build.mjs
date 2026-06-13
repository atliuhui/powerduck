// Finalize the Chrome extension under chrome/dist after Vite build:
// copy manifest/background/icons and remove source maps to keep the zip lean.
import { cpSync, existsSync, rmSync, statSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const outDir = join(root, "dist");

if (!existsSync(outDir) || !statSync(outDir).isDirectory()) {
  console.error(`[chrome:build] dist not found at ${outDir}. Run \`vite build\` first.`);
  process.exit(1);
}

// 1) Overlay extension-specific files.
cpSync(join(root, "manifest.json"), join(outDir, "manifest.json"));
cpSync(join(root, "src", "background.js"), join(outDir, "background.js"));
cpSync(join(root, "icons"), join(outDir, "icons"), { recursive: true });

// 2) Remove sourcemaps recursively.
function removeMaps(dir) {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, name.name);
    if (name.isDirectory()) {
      removeMaps(full);
      continue;
    }
    if (name.isFile() && full.endsWith(".map")) {
      rmSync(full, { force: true });
    }
  }
}

removeMaps(outDir);

console.log(`[chrome:build] Extension assembled at ${outDir}`);
