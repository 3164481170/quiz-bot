/**
 * 打发布包：生成 quiz-bot-v1.7.0.zip
 *
 * 特点：
 *   - 包内顶层是一个 quiz-bot/ 目录，解压后不会散落一地
 *   - 自动排除 node_modules / logs / __pycache__ / 嵌套的旧 zip
 *   - 逐文件 CRC32 校验，生成后自检
 *
 *   node tools/make-zip.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const VERSION = '1.7.0';
const PKG_NAME = 'quiz-bot';
const OUT = path.join(ROOT, PKG_NAME + '-v' + VERSION + '.zip');

const EXCLUDE_DIRS = new Set(['node_modules', '__pycache__', '.git', '.pnpm', 'logs',
                              '.venv', 'venv', '.idea', '.vscode']);
const EXCLUDE_FILES = new Set(['config.json', '.DS_Store', 'Thumbs.db']);
const EXCLUDE_EXT = ['.pyc', '.zip', '.log', '.tmp', '.bak'];

function walk(dir, base, out) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = base ? base + '/' + name : name;
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      if (EXCLUDE_DIRS.has(name)) continue;
      walk(full, rel, out);
    } else {
      if (EXCLUDE_FILES.has(name)) continue;
      if (EXCLUDE_EXT.some(e => name.toLowerCase().endsWith(e))) continue;
      // 只排除 macOS 的 AppleDouble 元数据文件（._xxx）。
      // 注意：不能按 "_" 开头一刀切 —— 那会把 Python 必需的 __init__.py 也排除掉。
      if (name.startsWith('._')) continue;
      out.push({ rel, full, size: st.size });
    }
  }
  return out;
}

/* ---------- CRC32 ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0 ^ (-1);
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xFF];
  return (c ^ (-1)) >>> 0;
}
function dosDateTime(d) {
  return {
    time: ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31),
    date: (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31)
  };
}

/* ---------- 打包 ---------- */
const files = walk(ROOT, PKG_NAME, []);
files.sort((a, b) => a.rel.localeCompare(b.rel));

console.log('='.repeat(64));
console.log('  打包 ' + PKG_NAME + ' v' + VERSION);
console.log('='.repeat(64));
console.log('');
console.log('包含 ' + files.length + ' 个文件：');
let totalRaw = 0;
for (const f of files) {
  totalRaw += f.size;
  console.log('  ' + f.rel.padEnd(52) + (f.size / 1024).toFixed(1).padStart(8) + ' KB');
}
console.log('');
console.log('原始大小: ' + (totalRaw / 1024).toFixed(1) + ' KB');

const chunks = [];
const central = [];
let offset = 0;
const { time: dosTime, date: dosDate } = dosDateTime(new Date());

for (const f of files) {
  const data = fs.readFileSync(f.full);
  const nameBuf = Buffer.from(f.rel, 'utf8');
  const crc = crc32(data);
  const deflated = zlib.deflateRawSync(data, { level: 9 });
  const useDeflate = deflated.length < data.length;
  const payload = useDeflate ? deflated : data;
  const method = useDeflate ? 8 : 0;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(dosTime, 10);
  local.writeUInt16LE(dosDate, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  chunks.push(local, nameBuf, payload);

  const cen = Buffer.alloc(46);
  cen.writeUInt32LE(0x02014b50, 0);
  cen.writeUInt16LE(20, 4);
  cen.writeUInt16LE(20, 6);
  cen.writeUInt16LE(0x0800, 8);
  cen.writeUInt16LE(method, 10);
  cen.writeUInt16LE(dosTime, 12);
  cen.writeUInt16LE(dosDate, 14);
  cen.writeUInt32LE(crc, 16);
  cen.writeUInt32LE(payload.length, 20);
  cen.writeUInt32LE(data.length, 24);
  cen.writeUInt16LE(nameBuf.length, 28);
  cen.writeUInt32LE(offset, 42);
  central.push(cen, nameBuf);

  offset += local.length + nameBuf.length + payload.length;
}

const centralBuf = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralBuf.length, 12);
end.writeUInt32LE(offset, 16);

if (fs.existsSync(OUT)) fs.unlinkSync(OUT);
fs.writeFileSync(OUT, Buffer.concat([...chunks, centralBuf, end]));
const zipSize = fs.statSync(OUT).size;

console.log('压缩后: ' + (zipSize / 1024).toFixed(1) + ' KB');
console.log('');
console.log('已生成: ' + OUT);

/* ---------- 自检：重新读回并解压校验 ---------- */
console.log('');
console.log('自检中…');
const buf = fs.readFileSync(OUT);
let eocd = -1;
for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) {
  if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
}
if (eocd < 0) { console.log('  ✗ ZIP 结构无效'); process.exit(1); }
const count = buf.readUInt16LE(eocd + 10);
let p = buf.readUInt32LE(eocd + 16);
let ok = 0, bad = 0;
for (let n = 0; n < count; n++) {
  const method = buf.readUInt16LE(p + 10);
  const crc = buf.readUInt32LE(p + 16);
  const csize = buf.readUInt32LE(p + 20);
  const usize = buf.readUInt32LE(p + 24);
  const nlen = buf.readUInt16LE(p + 28);
  const elen = buf.readUInt16LE(p + 30);
  const clen = buf.readUInt16LE(p + 32);
  const lo = buf.readUInt32LE(p + 42);
  const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
  const lnlen = buf.readUInt16LE(lo + 26);
  const lelen = buf.readUInt16LE(lo + 28);
  const raw = buf.slice(lo + 30 + lnlen + lelen, lo + 30 + lnlen + lelen + csize);
  let out;
  try { out = method === 8 ? zlib.inflateRawSync(raw) : raw; }
  catch (e) { console.log('  ✗ 解压失败 ' + name); bad++; p += 46 + nlen + elen + clen; continue; }
  if (out.length !== usize || crc32(out) !== crc) { console.log('  ✗ 校验失败 ' + name); bad++; }
  else ok++;
  p += 46 + nlen + elen + clen;
}
console.log('  文件校验: ' + ok + ' / ' + count + ' 通过，' + bad + ' 个异常');

// 抽查：油猴脚本内容是否与本地一致
const idx = files.findIndex(f => f.rel.endsWith('userscript/quizbot.user.js'));
if (idx >= 0) {
  const local = fs.readFileSync(files[idx].full);
  const localCrc = crc32(local);
  const found = (() => {
    let q = buf.readUInt32LE(eocd + 16);
    for (let n = 0; n < count; n++) {
      const nlen = buf.readUInt16LE(q + 28);
      const elen = buf.readUInt16LE(q + 30);
      const clen = buf.readUInt16LE(q + 32);
      const nm = buf.slice(q + 46, q + 46 + nlen).toString('utf8');
      if (nm === files[idx].rel) return buf.readUInt32LE(q + 16);
      q += 46 + nlen + elen + clen;
    }
    return -1;
  })();
  console.log('  油猴脚本 CRC 一致: ' + (found === localCrc ? '是 ✔' : '否 ✗'));
}

console.log('');
if (bad) { console.log('打包失败：有 ' + bad + ' 个文件校验不通过'); process.exit(1); }
console.log('打包完成 ✔');
