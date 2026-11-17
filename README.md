# ST Card Checker

## Sửa / dịch thẻ bằng AI (API dạng OpenAI)

Nhập **URL API** (ví dụ `https://…/v1`) + **API key** → bấm **Tải model** → chọn model → **Bắt đầu sửa bằng AI**. Model nào gọi được qua `/v1/chat/completions` kiểu OpenAI đều dùng được.

Hai chế độ:
- **Sửa bản dịch** (RAW + DỊCH): thay cho cách cũ là gửi cả prompt dài kèm 2 file cho AI.
- **Dịch mới từ RAW** (chỉ RAW): dịch 4 vùng kỹ thuật của thẻ gốc.

Cách tool làm để đỡ tốn token và không làm hỏng code:
1. Bộ kiểm tra tất định (bên dưới) phân tích RAW ↔ DỊCH trước, tự dựng **từ điển thuật ngữ** từ bản dịch có sẵn.
2. Trường nào bị hỏng khung code, lỗi cú pháp hoặc mất URL (ví dụ script loader bị thay bằng danh sách comment) thì **dựng lại từ RAW**.
3. Tên biến/khoá chưa có trong từ điển được dịch trước một lượt, để mọi chỗ (initvar, schema, EJS, JSONPatch, script, regex) dùng cùng một tên.
4. Chỉ những **dòng còn Hán tự** hoặc có lỗi đồng bộ biến (`getwi`, tên biến lạ…) mới được gửi cho AI, theo lô, chạy song song. Dòng rất dài (HTML/JS rút gọn) được cắt nhỏ. Base64 được giải mã ra để dịch, rồi mã hoá lại.
5. Kiểm tra từng dòng AI trả về: nếu thêm/bớt dấu nháy, ngoặc, `;`, `=` hoặc vẫn còn Hán tự thì gửi lại 1 lần, vẫn sai thì giữ nguyên dòng cũ. Sau khi ghép, tool chạy `node --check`; dòng nào gây lỗi cú pháp mới thì hoàn tác dòng đó.
6. Sửa font tiếng Việt, URL Markdown, đồng bộ `data.*`, rồi phân tích lại để so số lỗi trước/sau. Mặc định chạy 2 vòng.

Mẹo khi dùng provider miễn phí/giới hạn:
- Mặc định gộp ~12.000 ký tự mỗi lượt gọi, 3 luồng, **RPM 5**. Provider giới hạn tốc độ (429 “rate limit”) thì giảm RPM/luồng. Provider mạnh thì tăng lên.
- Gặp 429/5xx/mất mạng, tool **tự gọi lại liên tục**. Hết quota thì nhật ký báo đỏ: đổi tài khoản/key bên provider là tool tự chạy tiếp.
- Sai key (401/403) hoặc sai model/URL (404): tool dừng ngay và báo lý do.
- Lỡ tải lại trang hoặc đóng tab: mở lại `http://localhost:4848` là thấy tiếp tiến độ (miễn là chưa tắt cửa sổ đen).
- **Chạy thử N đoạn** (trong Tuỳ chọn nâng cao) để thử model/cấu hình trên một mẫu nhỏ trước khi chạy cả thẻ.

URL, key và các tuỳ chọn được lưu trong trình duyệt của máy đang dùng. Key chỉ được gửi tới máy chủ cục bộ của tool và tới đúng provider đã nhập.

---

Công cụ so sánh **File RAW** (thẻ gốc tiếng Trung) và **File DỊCH** của thẻ nhân vật SillyTavern, kiểm tra tự động theo checklist rà soát bản dịch:

| Checklist | Công cụ kiểm tra gì |
|---|---|
| **Skip đúng phạm vi** | Chỉ đọc 4 vùng lõi: Worldbook có EJS/MVU/initvar · `first_mes`/`alternate_greetings` có khối kỹ thuật · `tavern_helper.scripts` · `regex_scripts`. Không bao giờ đụng `keys`, `secondary_keys`, `button(s)`, mục văn xuôi. |
| **Sạch Hán tự** | Hán tự + dấu câu CJK (`、：｜《》（）＝　`…), chuỗi `\uXXXX`, và cả **Base64 chứa code/văn bản** (tự giải mã). Giữ ngoại lệ `丨` (U+4E28), regex tách dấu kiểu `/[、，,;；/]/`. Ảnh/âm thanh/font Base64 bỏ qua. |
| **Đồng bộ biến & tham chiếu** | Tự dựng **bảng thuật ngữ** bằng cách căn chuỗi RAW↔DỊCH trong Scripts, EJS, initvar, JSONPatch, `<script>` của Regex → báo thuật ngữ bị dịch nhiều kiểu. Tên biến trong JSONPatch/`getvar`/`_.get`/`state['…']` không có trong initvar/schema (gợi ý tên gần đúng). `getwi(…)` trỏ tới comment không tồn tại. Đánh dấu (`<StatusPlaceHolderImpl/>`, `[[…]]`…) không còn khớp `findRegex`. `first_mes`/`alternate_greetings` lệch `data.*`. Tên thẻ trong code. |
| **Cú pháp code** | `node --check` cho toàn bộ script, `<script>` trong Regex (kể cả trong Base64), và EJS (dịch sang JS rồi kiểm tra). So **khung code** với RAW để bắt đoạn bị mất/lặp/dán chồng. URL trong RAW bị mất / bị biến thành link Markdown `[https://…](https://…)`. Đường dẫn `"Cha['Con']"`. |
| **Giao diện & font** | Font không hỗ trợ đủ dấu tiếng Việt (PingFang, YaHei, Songti, Noto Serif SC, SimSun, Georgia, Palatino…), `text-overflow: ellipsis`, `line-clamp`, `overflow: hidden`, `maxlength` chưa nới. |

**Sửa tự động (tuỳ chọn, chỉ trên File DỊCH):** font chuẩn tiếng Việt, URL Markdown, đồng bộ `data.*`, bỏ ellipsis, thay Hán tự sót bằng bảng thuật ngữ (chỉ trong chuỗi/văn bản, không đụng định danh JS), dấu câu CJK → ASCII (bỏ qua bên trong regex). Base64 dạng code được giải mã → sửa → mã hoá lại đúng chỗ.

Ngoài ra: xem **so sánh song song RAW | DỊCH** tại đúng dòng lỗi, tải **báo cáo .md**, tải **bảng thuật ngữ .csv**, và **xuất gói trích xuất cho AI** (chỉ các mục có lỗi, kèm RAW + DỊCH — tiết kiệm token).

---

## Cài đặt (cho người dùng)

1. Cài **Node.js 18 trở lên** (bản LTS): https://nodejs.org
2. Tải công cụ — chọn 1 trong 2 cách:
   - **Khuyên dùng:** `git clone https://github.com/kubi2811/st-card-checker.git`
   - Hoặc bấm **Code → Download ZIP** trên GitHub rồi giải nén.
3. Chạy:
   - **Windows:** nháy đúp `start.bat`
   - **macOS:** nháy đúp `start.command` (lần đầu nếu bị chặn: chuột phải → Open). Hoặc mở Terminal trong thư mục và gõ `node launcher.js`
   - **Linux:** `./start.sh`

Trình duyệt sẽ tự mở `http://localhost:4848`. Kéo thả File RAW và File DỊCH, rồi bấm **Bắt đầu sửa bằng AI** hoặc **Kiểm tra (không dùng AI)**.

Không cần `npm install` — công cụ không dùng thư viện ngoài.

## Tự cập nhật

- Mỗi lần mở, công cụ hỏi GitHub xem nhánh `main` có commit mới hơn bản đang cài không. Nếu có, **tự tải về và khởi động lại** trước khi mở giao diện.
- Khi đang chạy, cứ **5 phút** kiểm tra một lần; nếu có bản mới sẽ hiện thông báo 🔔 và nút **Cập nhật ngay** ở góc trên.
- Cài bằng `git clone` → cập nhật bằng `git pull`. Cài bằng ZIP → tải từng file mới từ GitHub đúng theo commit, tải xong hết mới ghi đè.
- Tắt tự cập nhật khi mở: đặt `"autoUpdateOnStart": false` trong `config.json`. Đổi chu kỳ: `"checkIntervalMinutes"`.

## Dành cho người phát triển

Chỉ cần commit và push lên `main` — không phải tăng số phiên bản (công cụ so commit SHA). Nên tăng `version` trong `package.json` để hiển thị cho đẹp.

```bash
node server.js --no-update    # chạy server, không tự cập nhật (khi đang sửa code)
node cli.js RAW.json DICH.json          # kiểm tra bằng dòng lệnh
node cli.js RAW.json DICH.json --fix    # sửa an toàn → DICH.fixed.json
```

Cấu trúc:

```
launcher.js        khởi chạy + tự khởi động lại sau khi cập nhật + mở trình duyệt
server.js          máy chủ cục bộ (giao diện + API)
lib/extract.js     trích xuất 4 vùng lõi
lib/analyzer.js    toàn bộ quy tắc kiểm tra
lib/fixer.js       sửa tự động
lib/fonts.js       quy chuẩn font tiếng Việt
lib/jscheck.js     node --check
lib/ai/client.js   gọi API dạng OpenAI (models, chat/completions, thử lại khi 429/5xx)
lib/ai/prompts.js  prompt hệ thống + định dạng [[id]] đoạn
lib/ai/pipeline.js quy trình AI: phân tích → từ điển → gửi đoạn lỗi → kiểm tra → ghép
lib/updater.js     tự cập nhật từ GitHub
public/            giao diện web
```
