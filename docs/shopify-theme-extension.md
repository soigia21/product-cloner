# Theme App Extension: Product Personalizer

## 1) Data flow (embedded full UI)

- Import product ở app admin:
  - Tạo Shopify Draft.
  - Auto sync metafield `personalizer.template_id = <imported-template-id>`.
- Trên storefront product page:
  - App block đọc `product.metafields.personalizer.template_id`.
  - Block mount `iframe` tới app URL:
    - `https://product-cloner.groupaliens.com/?embedded=1&template_id=...`
  - Iframe render full personalized UI (options/conditional/preview canvas/upload) bằng logic hiện tại của app.

## 2) Files added

- `extensions/personalizer-product/shopify.extension.toml`
- `extensions/personalizer-product/blocks/personalizer.liquid`
- `extensions/personalizer-product/assets/personalizer-block.js`
- `src/CustomizerPage.jsx` (embedded mode)

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
- Set `Fallback app URL` = `https://product-cloner.groupaliens.com`.
- Block sẽ nhúng full UI bằng iframe embedded mode.

## 6) Test nhanh

1. Import 1 product mới trong app admin.
2. Verify product draft có metafield `personalizer.template_id`.
3. Mở storefront PDP có gắn block.
4. Check block báo `Personalized UI loaded`.
5. UI personalized hiển thị đầy đủ trong iframe (preview canvas + options conditional + upload).
