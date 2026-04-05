const API_VERSION = "2025-01";
const TEMPLATE_METAFIELD_NAMESPACE = "personalizer";
const TEMPLATE_METAFIELD_KEY = "template_id";
const TEMPLATE_METAFIELD_TYPE = "single_line_text_field";

function normalizeNumericProductId(productId) {
  const raw = String(productId || "").trim();
  if (!raw) return "";

  const gidMatch = raw.match(/Product\/(\d+)/i);
  if (gidMatch) return gidMatch[1];

  return raw.replace(/[^0-9]/g, "");
}

async function parseShopifyResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function getShopifyErrorMessage(data, fallbackStatus) {
  const errorMsg = data?.errors
    ? typeof data.errors === "string"
      ? data.errors
      : JSON.stringify(data.errors)
    : `HTTP ${fallbackStatus}`;
  return errorMsg;
}

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

  const data = await parseShopifyResponse(response);

  if (!response.ok) {
    const errorMsg = getShopifyErrorMessage(data, response.status);
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
  const numericId = normalizeNumericProductId(productId);
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

  const data = await parseShopifyResponse(response);
  if (!response.ok) {
    const errorMsg = getShopifyErrorMessage(data, response.status);
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

/**
 * Upsert product metafield personalizer.template_id
 */
export async function upsertProductTemplateMetafield(
  store,
  accessToken,
  productId,
  templateId,
  options = {}
) {
  const numericProductId = normalizeNumericProductId(productId);
  if (!numericProductId) {
    throw new Error("Invalid Shopify product id");
  }

  const value = String(templateId || "").trim();
  if (!value) {
    throw new Error("Invalid template id");
  }

  const namespace = String(options.namespace || TEMPLATE_METAFIELD_NAMESPACE).trim();
  const key = String(options.key || TEMPLATE_METAFIELD_KEY).trim();
  const type = String(options.type || TEMPLATE_METAFIELD_TYPE).trim();

  const listUrl = `https://${store}/admin/api/${API_VERSION}/products/${numericProductId}/metafields.json?namespace=${encodeURIComponent(namespace)}&key=${encodeURIComponent(key)}`;
  const listResponse = await fetch(listUrl, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
  });
  const listData = await parseShopifyResponse(listResponse);

  if (!listResponse.ok) {
    const errorMsg = getShopifyErrorMessage(listData, listResponse.status);
    throw new Error(`Shopify API Error: ${errorMsg}`);
  }

  const existing = Array.isArray(listData?.metafields) && listData.metafields.length > 0
    ? listData.metafields[0]
    : null;

  if (existing?.id) {
    const updateUrl = `https://${store}/admin/api/${API_VERSION}/metafields/${existing.id}.json`;
    const updatePayload = {
      metafield: {
        id: existing.id,
        value,
        type,
      },
    };
    const updateResponse = await fetch(updateUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify(updatePayload),
    });
    const updateData = await parseShopifyResponse(updateResponse);
    if (!updateResponse.ok) {
      const errorMsg = getShopifyErrorMessage(updateData, updateResponse.status);
      throw new Error(`Shopify API Error: ${errorMsg}`);
    }
    const metafield = updateData?.metafield || {};
    return {
      id: metafield.id || existing.id,
      namespace: metafield.namespace || namespace,
      key: metafield.key || key,
      value: metafield.value || value,
      type: metafield.type || type,
      ownerId: numericProductId,
      updatedAt: new Date().toISOString(),
    };
  }

  const createUrl = `https://${store}/admin/api/${API_VERSION}/products/${numericProductId}/metafields.json`;
  const createPayload = {
    metafield: {
      namespace,
      key,
      value,
      type,
    },
  };
  const createResponse = await fetch(createUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify(createPayload),
  });
  const createData = await parseShopifyResponse(createResponse);
  if (!createResponse.ok) {
    const errorMsg = getShopifyErrorMessage(createData, createResponse.status);
    throw new Error(`Shopify API Error: ${errorMsg}`);
  }

  const metafield = createData?.metafield || {};
  return {
    id: metafield.id || null,
    namespace: metafield.namespace || namespace,
    key: metafield.key || key,
    value: metafield.value || value,
    type: metafield.type || type,
    ownerId: numericProductId,
    updatedAt: new Date().toISOString(),
  };
}
