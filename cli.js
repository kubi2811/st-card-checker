#!/usr/bin/env node
'use strict';
// Dùng dòng lệnh:  node cli.js <RAW.json> <DICH.json> [--fix] [--json]
const fs = require('fs');
const { analyze } = require('./lib/analyzer');
const { applyFixes, detectIndent } = require('./lib/fixer');

(async () => {
  const args = process.argv.slice(2);
  const files = args.filter((a) => !a.startsWith('--'));
  if (files.length < 2) {
    console.log('Cách dùng: node cli.js <RAW.json> <DICH.json> [--fix] [--json]\n  --fix   sửa an toàn (font, URL Markdown, data.*) và ghi <DICH>.fixed.json\n  --json  in toàn bộ báo cáo dạng JSON');
    process.exit(1);
  }
  const rawText = fs.readFileSync(files[0], 'utf8');
  const transText = fs.readFileSync(files[1], 'utf8');
  let trans = JSON.parse(transText);
  if (args.includes('--fix')) {
    const { card, log } = applyFixes(trans, { fonts: true, mdlink: true, dataSync: true });
    const out = files[1].replace(/\.json$/i, '') + '.fixed.json';
    fs.writeFileSync(out, JSON.stringify(card, null, detectIndent(transText)));
    console.log(`Đã sửa ${log.reduce((a, l) => a + l.count, 0)} chỗ → ${out}`);
    trans = card;
  }
  const r = await analyze(JSON.parse(rawText), trans);
  if (args.includes('--json')) { console.log(JSON.stringify({ ...r, decoded: undefined }, null, 2)); return; }
  console.log(`\n${r.meta.rawName}  →  ${r.meta.transName}`);
  console.log(`Lỗi: ${r.meta.totals.error} · Cảnh báo: ${r.meta.totals.warn} · Lưu ý: ${r.meta.totals.info}\n`);
  for (const c of r.checklist) console.log(`${c.pass ? '✅' : '❌'} ${c.title}\n   ${c.detail}`);
  const by = {};
  for (const i of r.issues) if (i.sev !== 'info') (by[i.rule] = by[i.rule] || []).push(i);
  for (const [rule, arr] of Object.entries(by)) {
    console.log(`\n## ${r.rules[rule].title} (${arr.length})`);
    for (const i of arr.slice(0, 8)) console.log(`  - ${i.item}${i.field ? ' [' + i.field + ']' : ''}${i.line ? ' L' + i.line : ''}: ${i.msg.slice(0, 160)}`);
    if (arr.length > 8) console.log(`  … và ${arr.length - 8} mục khác`);
  }
  process.exitCode = r.meta.totals.error ? 2 : 0;
})();
