# Decorative Plaques Customily Reverse-Engineering Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chuẩn hóa engine đọc JSON + visibility/render theo dữ liệu thật từ 16 product trong collection `decorative-plaques`, loại bỏ suy đoán, và xử lý regression thiếu hình variant (Dogs).

**Architecture:** Dùng quy trình 3 lớp: (1) thu thập raw artifacts từ web gốc, (2) trích xuất dictionary biến và luật condition từ JSON + runtime gốc, (3) đối chiếu với local `visibility-engine.js`/renderer để tạo patch có test chống hồi quy.

**Tech Stack:** Node.js (scripts + current server services), JSON artifacts, Puppeteer runtime snapshot CLI, test runner hiện có trong `server/tests`.

---

## Scope cố định

### Dataset bắt buộc (16 links trang 1)

1. `https://macorner.co/products/im-as-lucky-as-can-be-the-best-mommy-belongs-to-me-personalized-acrylic-photo-plaque-mom220203pahn`
2. `https://macorner.co/products/im-always-with-you-personalized-acrylic-photo-plaque-mmr240801hutl`
3. `https://macorner.co/products/christian-bible-verse-affirmations-personalized-acrylic-photo-plaque-dau071203lahn`
4. `https://macorner.co/products/happy-1st-fathers-day-thank-you-for-everything-personalized-acrylic-photo-plaque-dad060402lamt`
5. `https://macorner.co/products/happy-1st-mothers-day-thank-you-for-everything-personalized-acrylic-photo-plaque-mom040401lamt`
6. `https://macorner.co/products/first-mom-now-grandma-personalized-acrylic-plaque-mom181201nnmt`
7. `https://macorner.co/products/the-best-dad-times-personalized-acrylic-photo-plaque-dad060401lamt`
8. `https://macorner.co/products/you-were-my-favorite-hello-and-my-hardest-goodbye-personalized-acrylic-photo-plaque-mmr131002hutl`
9. `https://macorner.co/products/when-i-say-i-love-you-more-personalized-acrylic-photo-plaque-cou241102tvht`
10. `https://macorner.co/products/happy-anniversary-my-love-personalized-acrylic-plaque-cou100503lamt`
11. `https://macorner.co/products/im-always-with-you-memorial-gift-personalized-acrylic-photo-plaque-mmr121005hutl`
12. `https://macorner.co/products/the-day-i-found-my-missing-piece-custom-calendar-personalized-acrylic-photo-plaque-cou061101hutl`
13. `https://macorner.co/products/memorial-pet-personalized-heart-shaped-acrylic-plaque-christmas-memorial-loving-gift-for-pet-loss-owners-dog-mom-dog-dad-cat-mom-cat-lover-dog-lover-pet171002laht`
14. `https://macorner.co/products/i-am-always-with-you-personalized-rectangle-acrylic-plaque-mmr240702hutl`
15. `https://macorner.co/products/i-choose-you-personalized-acrylic-photo-plaque-cou301002tvht`
16. `https://macorner.co/products/you-will-always-be-our-missing-piece-personalized-puzzle-piece-acrylic-plaque-christmas-loving-memorial-gift-for-family-members-friends-fam281004tupl`

### Baseline artifact đã có

- `tmp/reports/decorative-plaques-page1-personalized-analysis.json`

---

### Task 1: Freeze manifest + raw unified payloads

**Files:**
- Create: `scripts/analysis/fetch-decorative-plaques-page1.mjs`
- Create: `tmp/reports/decorative-plaques-page1-manifest.json`
- Create: `tmp/reports/decorative-plaques-page1/raw-unified/<handle>.json`
- Create: `tmp/reports/decorative-plaques-page1/raw-product-page/<handle>.html`

- [ ] **Step 1: Tạo script lấy 16 links chuẩn từ collection JSON**

Output cần có:
- handle
- product_url
- shop domain
- shopify product id
- unified settings URL

- [ ] **Step 2: Dump raw HTML + raw unified JSON cho từng product**

Rule:
- Không normalize ở bước này.
- Lưu đúng raw để có thể audit lại.

- [ ] **Step 3: Validate manifest**

Pass khi:
- Đủ đúng 16 products.
- Không có duplicate handle.
- Mỗi product có đủ `shop`, `productId`, `unifiedUrl`.

---

### Task 2: Build biến dictionary từ JSON thật (không suy đoán)

**Files:**
- Create: `scripts/analysis/extract-customily-dictionary.mjs`
- Create: `tmp/reports/decorative-plaques-page1-dictionary.json`
- Create: `tmp/reports/decorative-plaques-page1-dictionary.csv`

- [ ] **Step 1: Trích coverage key-path theo nhóm**

Nhóm bắt buộc:
- `productConfig.*`
- `settings.*`
- `sets[].options[]`
- `options[].conditions[]`
- `options[].variation_conditions[]`
- `options[].values[]`
- `options[].functions[]`

- [ ] **Step 2: Gán semantic role dựa trên evidence**

Mỗi biến phải có:
- `json_path`
- `observed_type`
- `distinct_samples`
- `frequency`
- `candidate_role`
- `evidence_products` (danh sách handle chứng minh)
- `confidence` (`high|medium|low`)

- [ ] **Step 3: Đánh dấu biến ảnh hưởng trực tiếp đến engine**

Bắt buộc map đến:
- visibility (`watch_option`, `desired_value`, `action`, `combination_operator`)
- default selection (`selected`, `checked`, `required`, `auto_default_mode`)
- binding ảnh/text (`functions.image_id`, `functions.text_id`, `value.image_id`, `file_upload_image_id`)
- switch design (`value.product_id`, `productConfig.initial_product_id`, `assignedSets`, `variations`, `conf_variants`)

---

### Task 3: Reverse condition logic của Customily từ runtime

**Files:**
- Create: `scripts/analysis/snapshot-customily-runtime.mjs`
- Create: `tmp/reports/decorative-plaques-page1/runtime/<handle>.json`
- Create: `tmp/reports/decorative-plaques-page1/runtime-diff/<handle>.json`

- [ ] **Step 1: Chạy runtime snapshot (Puppeteer) trên site gốc**

Mục tiêu:
- Lấy option visible state theo từng bước chọn variant.
- Lấy selected state do runtime tự đặt.
- Lấy mapping option -> render impact (image holder/text holder).

- [ ] **Step 2: Dựng local simulation bằng `computeVisibility`**

Input:
- options đã normalize từ importer.
- same selection sequence như runtime snapshot.

Output:
- visible options
- resolved selections
- force-show IDs (nếu có)

- [ ] **Step 3: Tạo diff report runtime gốc vs local**

Mỗi mismatch phải phân loại:
- `visibility_mismatch`
- `selection_default_mismatch`
- `binding_mismatch`
- `product_design_switch_mismatch`

---

### Task 4: Rulebook chung + guardrails

**Files:**
- Create: `docs/customily-logic-rulebook.md`
- Create: `docs/customily-variable-dictionary.md`

- [ ] **Step 1: Viết rule precedence theo thứ tự thực thi**

Ví dụ khung (phải xác nhận bằng evidence trước khi finalize):
1. Variation gate (`variation_conditions` trong assigned sets/options)
2. Option conditions (`watch_option`, `desired_value`, `action`, `combination_operator`)
3. Auto default policy
4. Render binding policy
5. Hidden-but-impactful UI policy

- [ ] **Step 2: Gắn minh chứng cho từng rule**

Mỗi rule phải trỏ đến:
- handle minh họa
- raw JSON path
- runtime snapshot key
- local engine function đang xử lý

- [ ] **Step 3: Liệt kê anti-rules (điều không được làm)**

Ví dụ:
- Không dùng heuristic theo label để đoán logic.
- Không hardcode theo từng product.
- Không override default khi chưa có watcher-chain evidence.

---

### Task 5: Patch plan cho regression hiện tại (Dogs không hiện variant image)

**Files:**
- Modify: `server/services/visibility-engine.js`
- Modify: `server/services/preview-renderer.js`
- Modify: `src/components/CustomizerForm.jsx`
- Create: `server/tests/visibility-dogs-variants-regression.test.mjs`
- Create: `server/tests/render-binding-regression.test.mjs`

- [ ] **Step 1: Reproduce bằng fixture thật**

Fixture bắt buộc:
- `a-girl-woman-boy-man-dogs-a-bond-that-cant-be-broken-...`
- `memorial-pet-...-pet171002laht`

- [ ] **Step 2: Khóa expected bằng snapshot test**

Assert:
- option quan trọng không bị mất khỏi UI flow.
- holder ảnh có `selectedPath` hợp lệ khi đổi variant.
- không blank layer khi đổi Dogs-related options.

- [ ] **Step 3: Sửa engine theo rulebook**

Ưu tiên:
- fix nguyên nhân gốc ở parser/visibility/binding
- không thêm product-specific bypass

- [ ] **Step 4: Verify full matrix**

Pass khi:
- 16/16 products không phát sinh mismatch blocker.
- 2 product Dogs hiển thị đầy đủ variant ảnh.
- không hồi quy các bug cũ: auto-select sai, duplicate option, background mất.

---

## Acceptance criteria tổng

- Có raw evidence đầy đủ cho toàn bộ 16 sản phẩm.
- Có dictionary biến + rulebook dùng chung, không dựa label guess.
- Có automated regression tests cho visibility + image binding.
- Có diff report chỉ rõ chênh giữa Customily runtime và local engine cho từng mismatch còn lại.

## Rủi ro và kiểm soát

- Rủi ro: một số product không trả personalized set (ví dụ sets rỗng).  
  Kiểm soát: phân loại “non-personalized/blocked” riêng, không ép fit vào rule chung.

- Rủi ro: runtime JS gốc minified khó truy trace.  
  Kiểm soát: dùng black-box state snapshot và sequence replay thay vì de-minify toàn bộ.

- Rủi ro: heuristics force-show gây hồi quy.  
  Kiểm soát: mọi force-show rule phải có test impact cụ thể theo holder/text mapping.
