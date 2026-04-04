const API_VERSION = "2025-01";

/**
 * Tạo sản phẩm trên Shopify store qua Admin REST API
 * Dùng REST API thay vì GraphQL cho đơn giản (Custom App)
 */
export async function createProduct(store, accessToken, product, options = {}) {
  const status = options?.status === "active" ? "active" : "draft";
  const url = `https://${store}/admin/api/${API_VERSION}/products.json`;

  // Build product payload cho REST API
  const payload = {
    product: {
      title: product.title,
      body_html: product.bodyHtml,
      vendor: product.vendor || undefined,
      product_type: product.productType || undefined,
      tags: Array.isArray(product.tags) ? product.tags.join(", ") : product.tags || "",
      status,
      // Options
      options: product.options.length > 0
        ? product.options.map((opt) => ({ name: opt.name, values: opt.values }))
        : undefined,
      // Variants
      variants: product.variants.map((v) => ({
        title: v.title,
        price: v.price,
        compare_at_price: v.compareAtPrice || undefined,
        sku: v.sku || undefined,
        option1: v.option1 || undefined,
        option2: v.option2 || undefined,
        option3: v.option3 || undefined,
        weight: v.weight || 0,
        weight_unit: v.weightUnit || "kg",
        requires_shipping: v.requiresShipping ?? true,
        taxable: v.taxable ?? true,
        inventory_management: null,
      })),
      // Images - Shopify sẽ tự download từ URLs
      images: product.images.map((img) => ({
        src: img.src,
        alt: img.alt || product.title,
        position: img.position,
      })),
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();

  if (!response.ok) {
    const errorMsg = data.errors
      ? typeof data.errors === "string"
        ? data.errors
        : JSON.stringify(data.errors)
      : `HTTP ${response.status}`;
    throw new Error(`Shopify API Error: ${errorMsg}`);
  }

  const created = data.product;

  return {
    success: true,
    productId: created.id,
    productTitle: created.title,
    productHandle: created.handle,
    productUrl: `https://${store}/admin/products/${created.id}`,
    status: created.status || status,
    variantsCount: created.variants?.length || 0,
    imagesCount: created.images?.length || 0,
  };
}

/**
 * Update Shopify product status (draft | active)
 */
export async function updateProductStatus(store, accessToken, productId, status) {
  const nextStatus = status === "active" ? "active" : "draft";
  const numericId = String(productId || "").replace(/[^0-9]/g, "");
  if (!numericId) {
    throw new Error("Invalid Shopify product id");
  }

  const url = `https://${store}/admin/api/${API_VERSION}/products/${numericId}.json`;
  const payload = {
    product: {
      id: Number(numericId),
      status: nextStatus,
    },
  };

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  if (!response.ok) {
    const errorMsg = data.errors
      ? typeof data.errors === "string"
        ? data.errors
        : JSON.stringify(data.errors)
      : `HTTP ${response.status}`;
    throw new Error(`Shopify API Error: ${errorMsg}`);
  }

  const updated = data.product || {};
  return {
    success: true,
    productId: updated.id || Number(numericId),
    productTitle: updated.title || "",
    productHandle: updated.handle || "",
    productUrl: `https://${store}/admin/products/${updated.id || numericId}`,
    status: updated.status || nextStatus,
  };
}
