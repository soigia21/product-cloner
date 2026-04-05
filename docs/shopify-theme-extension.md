# Theme App Extension: Product Personalizer

## 1) Data flow

- Import product ở app admin:
  - Tạo Shopify Draft.
  - Auto sync metafield `personalizer.template_id = <imported-template-id>`.
- Trên storefront product page:
  - App block đọc `product.metafields.personalizer.template_id`.
  - Block JS gọi endpoint:
    - App proxy: `/apps/personalizer/template`
    - Hoặc direct API: `https://product-cloner.groupaliens.com/api/storefront/template`
  - Endpoint trả `template` (dữ liệu từ `data/products/<id>/product.json`).

## 2) Files added

- `extensions/personalizer-product/shopify.extension.toml`
- `extensions/personalizer-product/blocks/personalizer.liquid`
- `extensions/personalizer-product/assets/personalizer-block.js`

## 3) API endpoints

- `GET /api/storefront/template?template_id=...`
- `GET /api/storefront/template?product_id=...`
- `GET /api/storefront/template?handle=...`
- Alias app proxy:
  - `GET /apps/personalizer/template?...`
- Force sync metafield:
  - `POST /api/products/:id/sync-template-metafield`

## 4) Shopify App Proxy config

Trong Shopify Dev Dashboard của app:

- App proxy prefix: `apps`
- App proxy subpath: `personalizer`
- Proxy URL: `https://product-cloner.groupaliens.com/apps/personalizer`

## 5) Theme editor

- Vào product template.
- Add block: `Personalizer Block`.
- Mặc định block dùng app proxy `/apps/personalizer`.
- Nếu chưa cấu hình app proxy:
  - Set `App proxy prefix` = empty.
  - Set `Fallback app URL` = `https://product-cloner.groupaliens.com`.

## 6) Test nhanh

1. Import 1 product mới trong app admin.
2. Verify product draft có metafield `personalizer.template_id`.
3. Mở storefront PDP có gắn block.
4. Check block báo `Personalized template loaded (...)`.
5. Mở console:
   - `window.__PRODUCT_CLONER_TEMPLATES` có template data.
