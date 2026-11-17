'use strict';
// Trích xuất 4 khu vực lõi từ thẻ nhân vật SillyTavern (chara_card_v2/v3).

const WB_MARKERS = /initvar|mvu_update|mvu_plot|<\/?UpdateVariable>|stat_data|JSONPatch|<%|getMessageVar|getvar|setvar|getwi|getGlobalVar|setGlobalVar|getLocalVar|setLocalVar/i;
const GREETING_MARKERS = /initvar|<\/?UpdateVariable>|<\/?JSONPatch>|<%|getvar|setvar|stat_data/i;

function getScripts(ext) {
  if (!ext) return [];
  let th = ext.tavern_helper ?? ext.TavernHelper;
  let scripts = null;
  if (Array.isArray(th)) {
    // định dạng cũ: [["scripts",[...]],["variables",{}]]
    const kv = th.find((x) => Array.isArray(x) && x[0] === 'scripts');
    if (kv) scripts = kv[1];
  } else if (th && typeof th === 'object') scripts = th.scripts;
  if (!scripts && Array.isArray(ext.TavernHelper_scripts)) {
    scripts = ext.TavernHelper_scripts.flatMap((s) => (s && Array.isArray(s.scripts) ? s.scripts : [s]));
  }
  if (!Array.isArray(scripts)) return [];
  // Hỗ trợ dạng thư mục (folder chứa scripts)
  const flat = [];
  const walk = (arr, base) => arr.forEach((s, i) => {
    if (s && s.type === 'folder' && Array.isArray(s.scripts)) walk(s.scripts, [...base, i, 'scripts']);
    else flat.push({ s, path: [...base, i] });
  });
  walk(scripts, []);
  return flat;
}

function scriptsBasePath(ext) {
  const th = ext.tavern_helper ?? ext.TavernHelper;
  const key = ext.tavern_helper !== undefined ? 'tavern_helper' : 'TavernHelper';
  if (Array.isArray(th)) {
    const idx = th.findIndex((x) => Array.isArray(x) && x[0] === 'scripts');
    return ['data', 'extensions', key, idx, 1];
  }
  if (th && typeof th === 'object' && th.scripts) return ['data', 'extensions', key, 'scripts'];
  return ['data', 'extensions', 'TavernHelper_scripts'];
}

/**
 * Trả về danh sách item: { key, zone, label, inScope, fields:[{name, path, text, code}] }
 * code: 'js' | 'ejs' | 'html' | 'regex' | 'text' | 'yaml'
 */
function extractZones(card, opts = {}) {
  const items = [];
  const data = card.data || {};
  const ext = data.extensions || {};

  // 1. Worldbook
  const entries = (data.character_book && data.character_book.entries) || [];
  entries.forEach((e, i) => {
    if (!e || typeof e !== 'object') return;
    const content = typeof e.content === 'string' ? e.content : '';
    const comment = e.comment || e.name || '';
    const byContent = WB_MARKERS.test(content);
    const byComment = /\[(initvar|mvu_update|mvu_plot)\]/i.test(comment);
    const inScope = byContent || (opts.includeTaggedEntries && byComment);
    const isInitvar = /\[initvar\]/i.test(comment) || (/^\s*#/.test(content) && /initvar/i.test(content.slice(0, 2000)));
    items.push({
      key: 'wb:' + (e.id ?? e.uid ?? i),
      zone: 'worldbook',
      label: comment || `(mục #${e.id ?? i})`,
      comment,
      inScope: inScope || isInitvar,
      byContent,
      isInitvar,
      enabled: !(e.enabled === false || e.disable === true),
      fields: [{ name: 'content', path: ['data', 'character_book', 'entries', i, 'content'], text: content, code: isInitvar ? 'yaml' : 'ejs' }],
    });
  });

  // 2. Lời mở đầu
  const greet = (rootObj, prefix, pathBase) => {
    if (typeof rootObj.first_mes === 'string') {
      items.push(mkGreeting(prefix + 'first_mes', [...pathBase, 'first_mes'], rootObj.first_mes));
    }
    if (Array.isArray(rootObj.alternate_greetings)) {
      rootObj.alternate_greetings.forEach((g, i) => {
        if (typeof g === 'string') items.push(mkGreeting(`${prefix}alternate_greetings[${i}]`, [...pathBase, 'alternate_greetings', i], g));
      });
    }
  };
  greet(card, '', []);
  greet(data, 'data.', ['data']);

  // 3. Scripts
  const base = scriptsBasePath(ext);
  getScripts(ext).forEach(({ s, path }) => {
    if (!s) return;
    const p = [...base, ...path];
    items.push({
      key: 'script:' + (s.id || s.name || path.join('.')),
      zone: 'script',
      label: s.name || '(script)',
      inScope: true,
      fields: [
        { name: 'name', path: [...p, 'name'], text: s.name || '', code: 'text' },
        { name: 'info', path: [...p, 'info'], text: s.info || '', code: 'text' },
        { name: 'content', path: [...p, 'content'], text: s.content || '', code: 'js' },
      ],
    });
  });

  // 4. Regex
  (ext.regex_scripts || []).forEach((r, i) => {
    if (!r) return;
    const p = ['data', 'extensions', 'regex_scripts', i];
    items.push({
      key: 'regex:' + (r.id || r.scriptName || i),
      zone: 'regex',
      label: r.scriptName || `(regex #${i})`,
      inScope: true,
      findRegex: r.findRegex,
      fields: [
        { name: 'scriptName', path: [...p, 'scriptName'], text: r.scriptName || '', code: 'text' },
        { name: 'findRegex', path: [...p, 'findRegex'], text: r.findRegex || '', code: 'regex' },
        { name: 'replaceString', path: [...p, 'replaceString'], text: r.replaceString || '', code: 'html' },
        ...(Array.isArray(r.trimStrings) ? r.trimStrings.map((t, k) => ({ name: `trimStrings[${k}]`, path: [...p, 'trimStrings', k], text: String(t), code: 'text' })) : []),
      ],
    });
  });

  return items;
}

function mkGreeting(key, path, text) {
  return {
    key: 'greet:' + key,
    zone: 'greeting',
    label: key,
    inScope: GREETING_MARKERS.test(text),
    fields: [{ name: 'text', path, text, code: 'ejs' }],
  };
}

function getAt(obj, path) {
  let o = obj;
  for (const k of path) { if (o == null) return undefined; o = o[k]; }
  return o;
}
function setAt(obj, path, val) {
  let o = obj;
  for (let i = 0; i < path.length - 1; i++) o = o[path[i]];
  o[path[path.length - 1]] = val;
}

module.exports = { extractZones, getAt, setAt, WB_MARKERS };
