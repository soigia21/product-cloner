const API_VERSION = "2025-01";
const TEMPLATE_METAFIELD_NAMESPACE = "personalizer";
const TEMPLATE_METAFIELD_KEY = "template_id";
const TEMPLATE_METAFIELD_TYPE = "single_line_text_field";
const DEFAULT_IMPORTED_INVENTORY_QUANTITY = 999;

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

function normalizeInventoryQuantity(raw, fallback = DEFAULT_IMPORTED_INVENTORY_QUANTITY) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return Math.max(0, Math.floor(Number(fallback) || 0));
  return Math.max(0, Math.floor(n));
}

async function shopifyGraphQL(store, accessToken, query, variables = {}) {
  const url = `https://${store}/admin/api/${API_VERSION}/graphql.json`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  const data = await parseShopifyResponse(response);
  if (!response.ok) {
    const errorMsg = getShopifyErrorMessage(data, response.status);
    throw new Error(`Shopify GraphQL Error: ${errorMsg}`);
  }

  if (Array.isArray(data?.errors) && data.errors.length > 0) {
    throw new Error(
      data.errors
        .map((err) => err?.message || JSON.stringify(err))
        .filter(Boolean)
        .join("; ")
    );
  }

  return data?.data || {};
}

function toProductGid(productId) {
  const numeric = normalizeNumericProductId(productId);
  if (!numeric) return "";
  return `gid://shopify/Product/${numeric}`;
}

async function findOnlineStorePublication(store, accessToken) {
  const query = `
    query ProductClonerPublications {
      publications(first: 30) {
        nodes {
          id
          name
        }
      }
    }
  `;
  const data = await shopifyGraphQL(store, accessToken, query);
  const nodes = Array.isArray(data?.publications?.nodes) ? data.publications.nodes : [];
  if (nodes.length === 0) return null;

  const online = nodes.find((node) => /online\s*store/i.test(String(node?.name || "")));
  return online || nodes[0];
}

async function publishProductToOnlineStore(store, accessToken, productId) {
  const productGid = toProductGid(productId);
  if (!productGid) {
    throw new Error("Invalid Shopify product id for publication");
  }

  const publication = await findOnlineStorePublication(store, accessToken);
  if (!publication?.id) {
    throw new Error("No publication channel found");
  }

  const mutation = `
    mutation ProductClonerPublishProduct($id: ID!, $input: [PublicationInput!]!) {
      publishablePublish(id: $id, input: $input) {
        publishable {
          ... on Product {
            id
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;
  const data = await shopifyGraphQL(store, accessToken, mutation, {
    id: productGid,
    input: [{ publicationId: publication.id }],
  });

  const userErrors = Array.isArray(data?.publishablePublish?.userErrors)
    ? data.publishablePublish.userErrors
    : [];
  if (userErrors.length > 0) {
    const msg = userErrors
      .map((err) => err?.message || "")
      .filter(Boolean)
      .join("; ");
    throw new Error(msg || "Unknown publishablePublish error");
  }

  return {
    publicationId: publication.id,
    publicationName: publication.name || "",
  };
}

async function getPrimaryLocationId(store, accessToken) {
  const url = `https://${store}/admin/api/${API_VERSION}/locations.json?limit=1`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
  });
  const data = await parseShopifyResponse(response);
  if (!response.ok) {
    const errorMsg = getShopifyErrorMessage(data, response.status);
    throw new Error(`Cannot fetch Shopify locations: ${errorMsg}`);
  }
  const first = Array.isArray(data?.locations) ? data.locations[0] : null;
  const locationId = Number(first?.id);
  if (!Number.isFinite(locationId) || locationId <= 0) {
    throw new Error("No Shopify location found");
  }
  return locationId;
}

async function setInventoryLevel(store, accessToken, locationId, inventoryItemId, available) {
  const url = `https://${store}/admin/api/${API_VERSION}/inventory_levels/set.json`;
  const payload = {
    location_id: Number(locationId),
    inventory_item_id: Number(inventoryItemId),
    available: Number(available),
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
    throw new Error(`Cannot set inventory level: ${errorMsg}`);
  }
  return data?.inventory_level || null;
}

async function applyDefaultInventoryLevels(store, accessToken, productPayload = {}, defaultQuantity) {
  const variants = Array.isArray(productPayload?.variants) ? productPayload.variants : [];
  const inventoryItemIds = variants
    .map((v) => Number(v?.inventory_item_id))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (inventoryItemIds.length === 0) {
    return { updatedCount: 0, warnings: ["No inventory_item_id found on created variants"] };
  }

  const locationId = await getPrimaryLocationId(store, accessToken);
  const warnings = [];
  let updatedCount = 0;

  for (const itemId of inventoryItemIds) {
    try {
      await setInventoryLevel(store, accessToken, locationId, itemId, defaultQuantity);
      updatedCount += 1;
    } catch (err) {
      warnings.push(`inventory_item_id ${itemId}: ${err.message}`);
    }
  }

  return { locationId, updatedCount, warnings };
}

/**
 * Tạo sản phẩm trên Shopify store qua Admin REST API
 * Dùng REST API thay vì GraphQL cho đơn giản (Custom App)
 */
export async function createProduct(store, accessToken, product, options = {}) {
  const status = options?.status === "active" ? "active" : "draft";
  const forcePhysicalProduct = options?.forcePhysicalProduct === true;
  const defaultInventoryQuantity = normalizeInventoryQuantity(
    options?.defaultInventoryQuantity,
    DEFAULT_IMPORTED_INVENTORY_QUANTITY
  );
  const resolvedProductType = String(product?.productType || product?.category || "").trim();
  const url = `https://${store}/admin/api/${API_VERSION}/products.json`;

  // Build product payload cho REST API
  const payload = {
    product: {
      title: product.title,
      body_html: product.bodyHtml,
      vendor: product.vendor || undefined,
      product_type: resolvedProductType || undefined,
      tags: Array.isArray(product.tags) ? product.tags.join(", ") : product.tags || "",
      status,
      published_scope: status === "active" ? "global" : undefined,
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
        requires_shipping: forcePhysicalProduct ? true : (v.requiresShipping ?? true),
        taxable: v.taxable ?? true,
        inventory_management: v.inventoryManagement || "shopify",
        inventory_policy: v.inventoryPolicy || "continue",
        inventory_quantity: normalizeInventoryQuantity(v.inventoryQuantity, defaultInventoryQuantity),
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
  let inventoryWarnings = [];
  let inventoryUpdatedCount = 0;
  let inventoryLocationId = null;
  try {
    const applied = await applyDefaultInventoryLevels(
      store,
      accessToken,
      created,
      defaultInventoryQuantity
    );
    inventoryWarnings = applied.warnings || [];
    inventoryUpdatedCount = Number(applied.updatedCount) || 0;
    inventoryLocationId = applied.locationId || null;
  } catch (error) {
    inventoryWarnings = [error.message];
  }

  let publication = null;
  let publishWarnings = [];
  if (status === "active") {
    try {
      publication = await publishProductToOnlineStore(store, accessToken, created.id);
    } catch (error) {
      publishWarnings = [`Online Store publication warning: ${error.message}`];
    }
  }

  return {
    success: true,
    productId: created.id,
    productTitle: created.title,
    productHandle: created.handle,
    productUrl: `https://${store}/admin/products/${created.id}`,
    status: created.status || status,
    variantsCount: created.variants?.length || 0,
    imagesCount: created.images?.length || 0,
    defaultInventoryQuantity,
    inventoryUpdatedCount,
    inventoryLocationId,
    inventoryWarnings,
    publication,
    publishWarnings,
  };
}

/**
 * Update Shopify product status (draft | active)
 */
export async function updateProductStatus(store, accessToken, productId, status, options = {}) {
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
      published_scope: nextStatus === "active" ? "global" : undefined,
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
  let publication = null;
  const warnings = [];
  if (nextStatus === "active" && options?.publishToOnlineStore !== false) {
    try {
      publication = await publishProductToOnlineStore(store, accessToken, numericId);
    } catch (error) {
      warnings.push(`Online Store publication warning: ${error.message}`);
    }
  }

  return {
    success: true,
    productId: updated.id || Number(numericId),
    productTitle: updated.title || "",
    productHandle: updated.handle || "",
    productUrl: `https://${store}/admin/products/${updated.id || numericId}`,
    status: updated.status || nextStatus,
    publication,
    warnings,
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
