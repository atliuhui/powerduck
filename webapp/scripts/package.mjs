// Zip webapp/dist into a versioned archive (DEFLATE compressed) next to package.json.
import { createWriteStream, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { Buffer } from "node:buffer";
import { deflateRawSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const distDir = join(root, "dist");
const pkg = createRequire(import.meta.url)(join(root, "package.json"));
const zipPath = join(root, `power-duck-webapp-${pkg.version}.zip`);

rmSync(zipPath, { force: true });

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

let crcTable;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let v = n;
      for (let k = 0; k < 8; k++) v = (v & 1) ? (0xEDB88320 ^ (v >>> 1)) : (v >>> 1);
      crcTable[n] = v >>> 0;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = (crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

const out = createWriteStream(zipPath);
const central = [];
let offset = 0;

function writeBuf(b) { out.write(b); offset += b.length; }

const files = walk(distDir).sort();
for (const full of files) {
  const rel = relative(distDir, full).split("\\").join("/");
  const data = readFileSync(full);
  const compressed = deflateRawSync(data, { level: 9 });
  const useStore = compressed.length >= data.length;
  const payload = useStore ? data : compressed;
  const method = useStore ? 0 : 8;
  const nameBuf = Buffer.from(rel, "utf8");
  const crc = crc32(data);
  const usize = data.length;
  const csize = payload.length;
  const localOffset = offset;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(0, 10);
  local.writeUInt16LE(0, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(csize, 18);
  local.writeUInt32LE(usize, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  writeBuf(local);
  writeBuf(nameBuf);
  writeBuf(payload);

  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);
  cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(0, 8);
  cd.writeUInt16LE(method, 10);
  cd.writeUInt16LE(0, 12);
  cd.writeUInt16LE(0, 14);
  cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(csize, 20);
  cd.writeUInt32LE(usize, 24);
  cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt16LE(0, 30);
  cd.writeUInt16LE(0, 32);
  cd.writeUInt16LE(0, 34);
  cd.writeUInt16LE(0, 36);
  cd.writeUInt32LE(0, 38);
  cd.writeUInt32LE(localOffset, 42);
  central.push(Buffer.concat([cd, nameBuf]));
}

const cdStart = offset;
for (const c of central) writeBuf(c);
const cdSize = offset - cdStart;

const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(0, 4);
end.writeUInt16LE(0, 6);
end.writeUInt16LE(central.length, 8);
end.writeUInt16LE(central.length, 10);
end.writeUInt32LE(cdSize, 12);
end.writeUInt32LE(cdStart, 16);
end.writeUInt16LE(0, 20);
writeBuf(end);

out.end(() => {
  const finalSize = statSync(zipPath).size;
  console.log(`[webapp:package] ${zipPath} (${(finalSize/1024/1024).toFixed(2)} MB)`);
});
