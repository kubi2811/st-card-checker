'use strict';
// Bộ nhớ đệm bản dịch trên đĩa (thư mục du-lieu/ trong thư mục tool).
// Mỗi đoạn đã được AI dịch & qua kiểm tra được lưu theo mã băm nội dung → chạy lại (sau khi dừng,
// tắt máy, cập nhật tool, đổi tài khoản…) thì các đoạn đã dịch được dùng lại ngay, không tốn lượt gọi.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = path.join(__dirname, '..', '..', 'du-lieu');
const FILE = path.join(DIR, 'bo-nho-dem.jsonl');
const OUT_DIR = path.join(DIR, 'ket-qua');

let map = null;
function load() {
  if (map) return map;
  map = new Map();
  try {
    for (const line of fs.readFileSync(FILE, 'utf8').split('\n')) {
      if (!line) continue;
      try { const [k, v] = JSON.parse(line); map.set(k, v); } catch (_) { /* dòng hỏng (tắt ngang lúc ghi) → bỏ qua */ }
    }
  } catch (_) { /* chưa có tệp */ }
  return map;
}

const key = (...parts) => crypto.createHash('sha1').update(parts.join('\u0000')).digest('hex');
function get(k) { return load().get(k); }
function set(k, v) {
  load().set(k, v);
  try { fs.mkdirSync(DIR, { recursive: true }); fs.appendFileSync(FILE, JSON.stringify([k, v]) + '\n'); } catch (e) { console.error('[bộ nhớ đệm]', e.message); }
}
function size() { return load().size; }
function clear() { map = new Map(); try { fs.rmSync(FILE, { force: true }); } catch (_) { /* */ } }
function fileBytes() { try { return fs.statSync(FILE).size; } catch (_) { return 0; } }

// Lưu file kết quả vào du-lieu/ket-qua/
function saveResult(name, text) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const safe = String(name || 'ket-qua.json').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
  const file = path.join(OUT_DIR, safe);
  fs.writeFileSync(file, text);
  return file;
}

module.exports = { key, get, set, size, clear, fileBytes, saveResult, DIR, OUT_DIR };
