'use strict';
// Kiểm tra cú pháp JS bằng `node --check` (đúng như checklist yêu cầu).
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const TMP = path.join(os.tmpdir(), 'st-card-checker');
fs.mkdirSync(TMP, { recursive: true });
const cache = new Map();

function runCheck(code, ext) {
  return new Promise((resolve) => {
    const file = path.join(TMP, crypto.randomBytes(8).toString('hex') + ext);
    fs.writeFileSync(file, code);
    execFile(process.execPath, ['--check', file], { timeout: 30000, maxBuffer: 4 << 20 }, (err, _so, se) => {
      fs.unlink(file, () => {});
      if (!err) return resolve({ ok: true });
      const msg = String(se || err.message);
      const lm = msg.match(new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':(\\d+)'));
      const line = lm ? Number(lm[1]) : null;
      const lines = msg.split('\n').map((s) => s.trim()).filter(Boolean);
      const errLine = lines.find((l) => /Error/.test(l)) || lines[lines.length - 1] || 'Lỗi cú pháp';
      resolve({ ok: false, line, message: errLine.replace(file, '<code>') });
    });
  });
}

// Thử dạng module trước (cho phép import/top-level await), sau đó dạng script thường.
async function checkSyntax(code) {
  const h = crypto.createHash('sha1').update(code).digest('hex');
  if (cache.has(h)) return cache.get(h);
  const p = (async () => {
    const asModule = await runCheck(code, '.mjs');
    if (asModule.ok) return asModule;
    const asScript = await runCheck(code, '.cjs');
    if (asScript.ok) return asScript;
    return asModule;
  })();
  cache.set(h, p);
  return p;
}

// Giới hạn song song
async function pool(tasks, n = 6) {
  const res = new Array(tasks.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, async () => {
    while (i < tasks.length) { const k = i++; res[k] = await tasks[k](); }
  }));
  return res;
}

module.exports = { checkSyntax, pool };
