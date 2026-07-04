# Lectio — Đọc sách báo tiếng Anh

Web đọc PDF/Word tiếng Anh, ngắt câu tuỳ chỉnh, bôi đen từ để dịch (Claude API), và kho từ vựng ôn tập kiểu spaced repetition.

## Cấu trúc project

```
lectio/
├── api/
│   └── translate.js     ← Serverless function, giữ API key an toàn ở server
├── src/
│   ├── App.jsx           ← Toàn bộ logic + UI của app
│   └── main.jsx          ← Điểm khởi chạy React
├── index.html
├── package.json
├── vite.config.js
├── vercel.json
└── .env.example
```

## Vì sao cần backend riêng cho việc dịch?

Gọi thẳng Gemini API từ trình duyệt sẽ làm lộ **API key** cho bất kỳ ai mở DevTools xem code — rất nguy hiểm vì người khác có thể lấy key đó dùng (và bạn phải trả tiền/bị khoá). Vì vậy `api/translate.js` đóng vai trò trung gian: frontend gọi `/api/translate`, server (Vercel) gọi Gemini bằng key bí mật lưu trong biến môi trường, không bao giờ gửi key về trình duyệt.

## Chạy thử ở máy local

### 1. Cài đặt

```bash
npm install
```

### 2. Lấy API key

Tạo key miễn phí tại [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey) (đăng nhập bằng tài khoản Google).

### 3. Cấu hình biến môi trường

```bash
cp .env.example .env.local
# Mở .env.local, dán Gemini API key thật vào (dạng GEMINI_API_KEY=...)
```

### 4. Chạy

Vite tự nó không chạy được serverless functions (`api/`). Có 2 cách:

**Cách A — dùng Vercel CLI (khuyên dùng, giả lập đúng môi trường production):**

```bash
npm install -g vercel
vercel dev
```

**Cách B — chỉ chạy frontend (không dịch được, chỉ xem giao diện):**

```bash
npm run dev
```

## Đưa lên GitHub

```bash
git init
git add .
git commit -m "Initial commit: Lectio reading app"
git branch -M main
git remote add origin https://github.com/<tên-bạn>/lectio.git
git push -u origin main
```

File `.gitignore` đã loại trừ `node_modules/`, `dist/`, và mọi file `.env*` — **API key thật sẽ không bao giờ bị đẩy lên GitHub** miễn là bạn không chỉnh sửa `.gitignore`.

## Deploy miễn phí lên Vercel

1. Vào [vercel.com](https://vercel.com), đăng nhập bằng GitHub
2. **Add New → Project**, chọn repo `lectio` vừa push
3. Vercel tự nhận diện Vite, không cần chỉnh build settings
4. Trước khi bấm Deploy, vào **Environment Variables**, thêm:
   - Key: `GEMINI_API_KEY`
   - Value: API key thật của bạn (lấy tại [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey))
5. Bấm **Deploy** — xong, có link public dạng `lectio-xxxx.vercel.app`

Mỗi lần `git push` lên `main`, Vercel tự build và deploy lại.

## Lưu trữ dữ liệu

Tài liệu và kho từ vựng được lưu bằng `localStorage` của trình duyệt — nghĩa là dữ liệu **chỉ tồn tại trên trình duyệt/thiết bị bạn đang dùng**, không đồng bộ qua thiết bị khác, và sẽ mất nếu bạn xoá dữ liệu trình duyệt. Đây là lựa chọn có chủ đích để giữ mọi thứ đơn giản và riêng tư — không cần tài khoản, không cần database.

Nếu sau này muốn đồng bộ nhiều thiết bị, cần thêm: tài khoản người dùng + database thật (ví dụ Supabase, Firebase) thay cho `localStorage`.

## Giới hạn cần biết

- **Gói miễn phí của Gemini** (`gemini-2.5-flash`) có giới hạn theo số request/phút và request/ngày — đủ thoải mái cho việc tra từ vựng cá nhân. Xem giới hạn hiện tại tại [ai.google.dev/gemini-api/docs/rate-limits](https://ai.google.dev/gemini-api/docs/rate-limits). Nếu dùng quá giới hạn miễn phí, Google sẽ trả lỗi tạm thời (429) thay vì tính phí ngay — bạn có thể bật billing nếu muốn nâng giới hạn.
- Trích xuất PDF hoạt động tốt nhất với sách/báo dạng text thuần; PDF dạng ảnh scan hoặc layout nhiều cột phức tạp có thể bị lẫn thứ tự đoạn văn.
- Tách câu dùng regex có danh sách viết tắt phổ biến (Mr., U.S., e.g....) để giảm lỗi cắt câu sai, nhưng không hoàn hảo 100%.
- `api/translate.js` viết theo chuẩn Vercel serverless function. Nếu deploy sang Netlify, cần chuyển sang định dạng Netlify Functions (`netlify/functions/translate.js`) — cấu trúc logic gần như giữ nguyên, chỉ khác cách export handler.
