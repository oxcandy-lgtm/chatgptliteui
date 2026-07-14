// @ts-check
import { build } from "esbuild";
import { rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const repo = join(root, "..");
const dist = join(repo, "dist");

// --- minimal PNG encoder (Node builtins only) -------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function makePng(size, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const rowLen = size * 4 + 1;
  const raw = Buffer.alloc(rowLen * size);
  for (let y = 0; y < size; y++) {
    const off = y * rowLen;
    raw[off] = 0; // filter none
    for (let x = 0; x < size; x++) {
      const p = off + 1 + x * 4;
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
      raw[p + 3] = 255;
    }
  }
  const idat = deflateSync(raw);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- helpers ----------------------------------------------------------------
function ensureDir(p) {
  mkdirSync(p, { recursive: true });
}

function textCopy(from, to) {
  writeFileSync(to, readFileSync(from, "utf-8"), "utf-8");
}

function fail(msg) {
  console.error(`[build] ${msg}`);
  process.exit(1);
}

// --- main -------------------------------------------------------------------
rmSync(dist, { recursive: true, force: true });
ensureDir(join(dist, "content"));
ensureDir(join(dist, "popup"));
ensureDir(join(dist, "options"));
ensureDir(join(dist, "icons"));

// Bundle content script as IIFE (classic script injection in MV3).
await build({
  entryPoints: [join(repo, "src/content/index.ts")],
  bundle: true,
  format: "iife",
  target: "es2022",
  outfile: join(dist, "content/content.js"),
  sourcemap: false,
  minify: false,
  logLevel: "silent",
}).catch(fail);

// Bundle popup and options as ES modules (loaded via <script type="module">).
for (const page of ["popup", "options"]) {
  await build({
    entryPoints: [join(repo, `src/${page}/${page}.ts`)],
    bundle: true,
    format: "esm",
    target: "es2022",
    outfile: join(dist, page, `${page}.js`),
    sourcemap: false,
    minify: false,
    logLevel: "silent",
  }).catch(fail);
}

// Copy static HTML/CSS.
textCopy(join(repo, "src/popup/popup.html"), join(dist, "popup/popup.html"));
textCopy(join(repo, "src/popup/popup.css"), join(dist, "popup/popup.css"));
textCopy(join(repo, "src/options/options.html"), join(dist, "options/options.html"));
textCopy(join(repo, "src/options/options.css"), join(dist, "options/options.css"));

// Concatenate style layers into the single content.css referenced by manifest.
const variables = readFileSync(join(repo, "src/styles/variables.css"), "utf-8");
const injected = readFileSync(join(repo, "src/styles/injected.css"), "utf-8");
writeFileSync(
  join(dist, "content/content.css"),
  `${variables}\n/* ---- injected ---- */\n${injected}\n`,
  "utf-8",
);

// Generate placeholder icons (solid color, no external assets).
const ICONS = [16, 32, 48, 128];
for (const size of ICONS) {
  writeFileSync(join(dist, "icons", `icon-${size}.png`), makePng(size, [28, 34, 54]));
}

// Copy manifest.
textCopy(join(repo, "manifest.json"), join(dist, "manifest.json"));

// Verify all manifest-referenced files exist in dist.
const manifest = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf-8"));
const referenced = ["icons/icon-16.png", "icons/icon-32.png", "icons/icon-48.png", "icons/icon-128.png"];
for (const cs of manifest.content_scripts ?? []) {
  for (const f of [...(cs.js ?? []), ...(cs.css ?? [])]) referenced.push(f);
}
if (manifest.action?.default_popup) referenced.push(manifest.action.default_popup);
if (manifest.options_ui?.page) referenced.push(manifest.options_ui.page);

for (const rel of referenced) {
  if (!existsSync(join(dist, rel))) fail(`manifest references missing dist file: ${rel}`);
}

console.log("[build] ok — dist written");
