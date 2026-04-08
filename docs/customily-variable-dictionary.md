# Customily Variable Dictionary

## Dataset

- Source collection: `https://macorner.co/collections/decorative-plaques`
- Scope: page 1, 16 products
- Manifest: `tmp/reports/decorative-plaques-page1-manifest.json`
- Raw unified payloads: `tmp/reports/decorative-plaques-page1/raw-unified/*.json`
- Generated dictionary:
  - JSON: `tmp/reports/decorative-plaques-page1-dictionary.json`
  - CSV: `tmp/reports/decorative-plaques-page1-dictionary.csv`

## Core fields and meaning (evidence-driven)

| JSON path | Meaning | Confidence |
| --- | --- | --- |
| `productConfig.assignedSets` | gate set/option theo Shopify variant | high |
| `productConfig.conf_variants` | mapping giá trị option Shopify hiện tại | high |
| `productConfig.variations` | khai báo dimension variant để evaluate `variation_conditions` | high |
| `productConfig.initial_product_id` | UUID design mặc định | high |
| `option.conditions[].watch_option` | option ID được theo dõi | high |
| `option.conditions[].desired_value` | value ID cần match (`-1` là any selected) | high |
| `option.conditions[].action` | hành vi `show/hide` | high |
| `option.conditions[].combination_operator` | nối điều kiện `or/and` theo thứ tự | high |
| `option.variation_conditions[]` | gate option theo Shopify variant | high |
| `option.values[].selected` | explicit default value từ JSON | high |
| `option.required` | field bắt buộc ở UI/purchase flow | high |
| `option.checked` | hint trạng thái checkbox mặc định | medium |
| `option.hide_visually` | hint ẩn UI, không phải condition logic trực tiếp | high |
| `option.functions[].image_id` | holder ID cho layer ảnh | high |
| `option.values[].image_id` | DIP key chọn ảnh bên trong holder | high |
| `option.functions[].text_id` | holder ID cho text layer | high |
| `option.file_upload_image_id` | holder ID cho Image Upload target | high |
| `option.values[].product_id` | design UUID để switch template/design | high |
| `option.values[].thumb_image` | ảnh thumbnail hiển thị swatch | high |
| `option.values[].sort_id` | thứ tự hiển thị (và fallback key trong vài case) | medium |

## Observed structure summary

- Option types quan sát: `Swatch`, `Dropdown`, `Text Input`, `Checkbox`, `Image Upload`
- Condition keys thực tế: `id`, `watch_option`, `desired_value`, `action`, `combination_operator`
- Function types thực tế: `image`, `text`, `product`

## Lưu ý để tránh đoán mò

1. Không suy diễn logic từ label (ví dụ "Number of daughters").
2. Luôn ưu tiên ID (`option.id`, `value.id`, `image_id`, `text_id`) thay vì index.
3. Kiểm tra cả `variation_conditions` (set-level và option-level), không chỉ `conditions`.
4. Tách rõ 3 lớp:
   - visibility gate
   - default selection policy
   - render binding (holder/text/upload).

