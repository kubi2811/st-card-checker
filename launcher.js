'use strict';
// Trình khởi chạy: chạy server.js, tự khởi động lại sau khi cập nhật (mã thoát 42), mở trình duyệt lần đầu.
const { fork, exec } = require('child_process');
const path = require('path');

const major = Number(process.versions.node.split('.')[0]);
if (major < 18) {
  console.error(`Cần Node.js >= 18 (bạn đang dùng ${process.versions.node}). Tải tại https://nodejs.org`);
  process.exit(1);
}

let opened = false;
const noOpen = process.argv.includes('--no-open');

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

function start(justUpdated) {
  const env = { ...process.env };
  if (justUpdated) env.STCC_JUST_UPDATED = '1';
  const child = fork(path.join(__dirname, 'server.js'), process.argv.slice(2), { env, stdio: 'inherit' });
  child.on('message', (m) => {
    if (m && m.type === 'ready' && !opened) { opened = true; if (!noOpen) openBrowser(m.url); }
  });
  child.on('exit', (code) => {
    if (code === 42) { console.log('  Đang khởi động lại với phiên bản mới…'); setTimeout(() => start(true), 500); }
    else process.exit(code || 0);
  });
}
start(false);
