'use strict';
// Prompt cho AI — chắt lọc từ checklist dịch thẻ SillyTavern (Hán tự, đồng bộ biến, giữ nguyên code).

const SYSTEM_SEGMENTS = `Bạn là chuyên gia Việt hoá thẻ nhân vật SillyTavern (chara_card_v3): Worldbook EJS/MVU/initvar, tavern_helper scripts (JS), regex_scripts (HTML/CSS/JS), khối kỹ thuật trong lời mở đầu.

NHIỆM VỤ: Mỗi dòng đầu vào có dạng  [[id]] <đoạn>. Mỗi đoạn là MỘT DÒNG (hoặc một mảnh của dòng rất dài) trích từ code/văn bản. Hãy chuyển mọi chữ Hán và dấu câu CJK trong đoạn sang tiếng Việt, giữ nguyên tuyệt đối mọi thứ khác.

QUY TẮC BẮT BUỘC
1. Trả về ĐÚNG các id đã nhận, mỗi id một dòng:  [[id]] <đoạn đã sửa>. Không giải thích, không markdown, không \`\`\`, không gộp hay tách dòng, không thêm id mới.
2. Chỉ sửa phần chữ Trung (văn bản trong chuỗi, comment, nội dung HTML, tên khoá/biến tiếng Trung). Giữ nguyên từng ký tự của: cú pháp JS/CSS/HTML, thẻ & thuộc tính, URL, số, {{user}} {{char}} <% %> $1 \\n \\" \\uXXXX không phải Hán tự, khoảng trắng đầu/cuối.
3. KHÔNG thêm/bớt dấu nháy ' " \`, ngoặc () [] {}, < >, dấu ; = \\ $. Ngoặc kép Trung “” 「」 『』 《》 khi dịch → dùng “ ” hoặc ‘ ’ (nháy cong), TUYỆT ĐỐI không dùng " hay ' thẳng vì sẽ làm vỡ chuỗi JS.
4. Dấu câu CJK → dấu Việt/ASCII:  ，→,  。→.  、→,  ：→:  ；→;  ！→!  ？→?  （）→()  【】→[]  ～→~  ｜→|  …… → …  Không được để sót bất kỳ Hán tự hay dấu câu CJK nào.
5. TÊN BIẾN / KHOÁ / ENUM phải dịch ĐÚNG theo TỪ ĐIỂN được cung cấp (khớp từng chữ, kể cả hoa thường và dấu). Tên chưa có trong từ điển: dịch ngắn gọn, nhất quán, có dấu tiếng Việt.
   - Nếu định danh dạng obj.兵力 mà bản dịch có dấu cách → viết obj['Binh lực'] (KHÔNG được để obj.Binh lực).
   - Khoá object không nháy có dấu cách → đặt trong nháy đơn: {'Binh lực': ...}. Đây là ngoại lệ duy nhất được thêm nháy/ngoặc.
   - Đường dẫn JSONPatch "/A/B" và getvar('stat_data.A.B') dùng đúng tên trong từ điển, giữ dấu / và . phân cách.
6. Regex / chuỗi so khớp (findRegex, new RegExp, .match/.replace, đánh dấu như <状态栏>) phải dịch ĐÚNG Y HỆT cách dịch phần văn bản mà nó so khớp (theo từ điển), để regex vẫn khớp. Lớp ký tự kiểu [\\u4e00-\\u9fa5] giữ nguyên.
7. Văn phong: tiếng Việt tự nhiên, phù hợp bối cảnh truyện; thuật ngữ cổ trang/quân sự Hán Việt khi hợp lý.
8. Đoạn có ghi chú lỗi (GHI CHÚ) → sửa đúng lỗi đó, kể cả khi đoạn không còn Hán tự.
9. Đoạn là mảnh cắt từ dòng dài → chỉ dịch mảnh đó, không tự hoàn thiện cú pháp.`;

const SYSTEM_TERMS = `Bạn Việt hoá tên biến/khoá/enum/thuật ngữ cho thẻ nhân vật SillyTavern (game nhập vai, bối cảnh trong truyện). Mỗi dòng đầu vào là một thuật ngữ tiếng Trung. Trả về mỗi dòng:  <thuật ngữ gốc> => <tiếng Việt>
Quy tắc: ngắn gọn, có dấu, viết hoa chữ đầu như danh từ riêng nếu là tên; không thêm giải thích; không dùng dấu . / [ ] ' " \` trong bản dịch; các thuật ngữ cùng họ phải dịch nhất quán (ví dụ 兵力/兵力上限 → Binh lực/Binh lực tối đa). Không được để sót Hán tự.`;

function glossaryBlock(entries) {
  if (!entries.length) return '';
  return 'TỪ ĐIỂN (bắt buộc dùng đúng):\n' + entries.map(([zh, vi]) => `${zh} = ${vi}`).join('\n') + '\n\n';
}

function buildSegmentsPrompt({ cardName, label, zone, code, glossary, segments, notes, knownVars }) {
  const codeName = { js: 'JavaScript', ejs: 'EJS (văn bản + <% code %>)', html: 'HTML/CSS/JS', yaml: 'YAML initvar', regex: 'Biểu thức regex', text: 'Văn bản/tên' }[code] || code;
  let u = `Thẻ: ${cardName || '?'}\nMục: ${label} (vùng ${zone}, loại ${codeName})\n\n`;
  u += glossaryBlock(glossary);
  if (knownVars && knownVars.length) u += 'TÊN BIẾN HỢP LỆ (initvar/schema của bản dịch): ' + knownVars.slice(0, 300).join(', ') + '\n\n';
  const ns = segments.filter((s) => notes.get(s.id));
  if (ns.length) u += 'GHI CHÚ LỖI CẦN SỬA:\n' + ns.map((s) => `[[${s.id}]] ${notes.get(s.id)}`).join('\n') + '\n\n';
  u += 'CÁC ĐOẠN:\n' + segments.map((s) => `[[${s.id}]] ${s.core}`).join('\n');
  return [{ role: 'system', content: SYSTEM_SEGMENTS }, { role: 'user', content: u }];
}

function buildTermsPrompt({ cardName, terms, glossary }) {
  let u = `Thẻ: ${cardName || '?'}\n\n`;
  if (glossary.length) u += 'Các thuật ngữ ĐÃ CÓ (dùng làm mẫu để nhất quán):\n' + glossary.slice(0, 200).map(([zh, vi]) => `${zh} => ${vi}`).join('\n') + '\n\n';
  u += 'Cần dịch:\n' + terms.join('\n');
  return [{ role: 'system', content: SYSTEM_TERMS }, { role: 'user', content: u }];
}

function parseSegments(content) {
  const out = new Map();
  const bad = [];
  let last = null;
  for (const line of String(content).replace(/\r/g, '').split('\n')) {
    const m = line.match(/^\s*\[\[(\d+)\]\] ?(.*)$/);
    if (m) { out.set(m[1], m[2]); last = m[1]; continue; }
    if (/^\s*```/.test(line) || !line.trim()) continue;
    if (last) bad.push(last); // dòng tràn → đoạn đó không hợp lệ
  }
  for (const id of bad) out.delete(id);
  return out;
}

function parseTerms(content) {
  const out = new Map();
  for (const line of String(content).split('\n')) {
    const m = line.match(/^\s*[-*]?\s*(.+?)\s*(?:=>|→|=)\s*(.+?)\s*$/);
    if (m) out.set(m[1].trim(), m[2].trim().replace(/^["'`]|["'`]$/g, ''));
  }
  return out;
}

module.exports = { SYSTEM_SEGMENTS, buildSegmentsPrompt, buildTermsPrompt, parseSegments, parseTerms };
