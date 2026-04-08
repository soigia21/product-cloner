# Customily Logic Rulebook (Local Engine Alignment)

## Purpose

Rulebook này định nghĩa thứ tự xử lý chuẩn khi render Personalized local, dựa trên dữ liệu thật đã quét từ 16 products trong collection decorative-plaques.

## Rule precedence (must-follow)

1. **Shopify variation gate**
   - Nguồn: `productConfig.assignedSets[].variation_conditions`, `assignedSets[].options[].variation_conditions`
   - Ý nghĩa: chọn set/option hợp lệ theo biến thể Shopify đang active.

2. **Option visibility conditions**
   - Nguồn: `option.conditions[]`
   - Keys: `watch_option`, `desired_value`, `action`, `combination_operator`
   - Quy tắc:
     - evaluate theo thứ tự conditions.
     - `combination_operator` là phép nối tuần tự.
     - `desired_value = -1` nghĩa là watcher có bất kỳ lựa chọn nào.

3. **Default selection resolution**
   - Ưu tiên:
     1. selection user
     2. explicit `values[].selected`
     3. policy nội bộ (`auto_default_mode`) khi đủ điều kiện watcher-chain
   - `required` là constraint nghiệp vụ, không tự động đồng nghĩa với "always first".

4. **Render binding resolution**
   - Image binding:
     - holder ID: `functions[].image_id`
     - selected key: ưu tiên `values[].image_id`, fallback `sort_id`/id policy
   - Text binding:
     - holder ID: `functions[].text_id`
   - Upload binding:
     - holder ID: `file_upload_image_id`

5. **UI visibility hint layer**
   - `hide_visually` chỉ điều khiển hiển thị control trên form.
   - Không được dùng để bỏ qua logic condition/render.
   - Nếu option hidden nhưng tác động render, xử lý qua cơ chế force-show có test bảo vệ.

## Guardrails

1. Không hardcode theo handle cụ thể.
2. Không map bằng label text.
3. Không dùng index vị trí value thay cho `value.id` trừ khi có fallback policy rõ ràng.
4. Không convert mọi `Checkbox` thành boolean nếu option có nhiều value trạng thái.

## Regression focus hiện tại

- Product nhóm Dogs có rủi ro cao do:
  - option count lớn
  - condition chain sâu
  - nhiều option image-binding có giá trị sentinel
  - có option type `Checkbox` nhưng không phải boolean thuần.

## Verification artifacts

- Manifest + raw data: `tmp/reports/decorative-plaques-page1-manifest.json`
- Dictionary: `tmp/reports/decorative-plaques-page1-dictionary.json`
- Runtime diff summary: `tmp/reports/decorative-plaques-page1/runtime-summary.json`

