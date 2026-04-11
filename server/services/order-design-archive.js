import fs from "fs";
import path from "path";
import crypto from "crypto";

const WEBHOOK_HMAC_HEADER = "x-shopify-hmac-sha256";
const ARCHIVE_ROOT_DIR = path.resolve(process.cwd(), "data", "order-designs");

function sanitizeSegment(raw) {
  return String(raw || "")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function safeNowIso() {
  return new Date().toISOString();
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readHeader(req, name) {
  if (!req?.headers) return "";
  const key = String(name || "").toLowerCase();
  const value = req.headers[key];
  if (Array.isArray(value)) return String(value[0] || "");
  return String(value || "");
}

export function verifyShopifyWebhookSignature(rawBodyBuffer, providedHmac, secret) {
  const source = Buffer.isBuffer(rawBodyBuffer)
    ? rawBodyBuffer
    : Buffer.from(String(rawBodyBuffer || ""), "utf8");
  const hmac = String(providedHmac || "").trim();
  const signingSecret = String(secret || "").trim();
  if (!source || source.length === 0 || !hmac || !signingSecret) return false;

  const digest = crypto.createHmac("sha256", signingSecret).update(source).digest("base64");
  const a = Buffer.from(digest, "utf8");
  const b = Buffer.from(hmac, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function assertValidShopifyWebhookSignature(req, secret) {
  const provided = readHeader(req, WEBHOOK_HMAC_HEADER);
  const body = req?.rawBody;
  const ok = verifyShopifyWebhookSignature(body, provided, secret);
  return ok;
}

function normalizeProperties(raw) {
  const out = {};
  if (!raw) return out;
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const key = String(item?.name || item?.key || "").trim();
      if (!key) continue;
      out[key] = String(item?.value ?? item?.last ?? "");
    }
    return out;
  }
  if (typeof raw === "object") {
    for (const [key, value] of Object.entries(raw)) {
      out[String(key)] = String(value ?? "");
    }
  }
  return out;
}

function resolveAbsolutePreviewUrl(rawUrl, requestOrigin = "") {
  const value = String(rawUrl || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value) || value.startsWith("data:image/")) return value;
  if (!requestOrigin) return value;
  try {
    return new URL(value, requestOrigin).toString();
  } catch {
    return value;
  }
}

function resolvePreviewUrlFromProperties(properties = {}, requestOrigin = "") {
  const fallbackKeys = ["_pz_preview_url", "Preview", "_pz_preview"];
  for (const key of fallbackKeys) {
    const raw = String(properties?.[key] || "").trim();
    if (!raw) continue;
    return resolveAbsolutePreviewUrl(raw, requestOrigin);
  }
  return "";
}

function resolveTemplateIdFromProperties(properties = {}) {
  return String(properties?._pz_template_id || properties?._pz_template || "").trim();
}

export function extractPersonalizedLineItems(orderPayload = {}, requestOrigin = "") {
  const lineItems = Array.isArray(orderPayload?.line_items) ? orderPayload.line_items : [];
  const normalized = [];
  for (let idx = 0; idx < lineItems.length; idx += 1) {
    const line = lineItems[idx] || {};
    const properties = normalizeProperties(line.properties || {});
    const templateId = resolveTemplateIdFromProperties(properties);
    const previewUrl = resolvePreviewUrlFromProperties(properties, requestOrigin);
    if (!templateId && !previewUrl) continue;
    normalized.push({
      index: idx,
      lineItemId: String(line.id || ""),
      title: String(line.title || ""),
      productId: String(line.product_id || ""),
      variantId: String(line.variant_id || ""),
      sku: String(line.sku || ""),
      quantity: Number(line.quantity || 0),
      templateId,
      previewUrl,
      properties,
    });
  }
  return normalized;
}

function parseDataUrlImage(url) {
  const raw = String(url || "");
  const m = raw.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/);
  if (!m) return null;
  try {
    return {
      contentType: m[1],
      bytes: Buffer.from(m[2], "base64"),
    };
  } catch {
    return null;
  }
}

function inferExtension(sourceUrl, contentType) {
  const byType = String(contentType || "").toLowerCase();
  if (byType === "image/png") return ".png";
  if (byType === "image/jpeg") return ".jpg";
  if (byType === "image/webp") return ".webp";
  if (byType === "image/gif") return ".gif";
  if (byType === "image/bmp") return ".bmp";

  const parsed = String(sourceUrl || "").toLowerCase();
  const ext = path.extname(parsed.split("?")[0] || "");
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"].includes(ext)) {
    return ext === ".jpeg" ? ".jpg" : ext;
  }
  return ".jpg";
}

async function fetchPreviewBinary(previewUrl) {
  const dataUrl = parseDataUrlImage(previewUrl);
  if (dataUrl?.bytes?.length) {
    return {
      bytes: dataUrl.bytes,
      contentType: dataUrl.contentType,
    };
  }

  const response = await fetch(previewUrl, {
    method: "GET",
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`Cannot download preview (${response.status})`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return {
    bytes: Buffer.from(arrayBuffer),
    contentType: String(response.headers.get("content-type") || "image/jpeg"),
  };
}

function buildOrderKey(orderPayload = {}) {
  const orderId = String(orderPayload?.id || "").trim();
  const orderNumber = String(orderPayload?.order_number || "").trim();
  const orderName = sanitizeSegment(orderPayload?.name || "");
  if (orderId) return sanitizeSegment(orderId);
  if (orderNumber) return sanitizeSegment(`order-${orderNumber}`);
  if (orderName) return orderName;
  return sanitizeSegment(`order-${Date.now()}`);
}

export async function archiveOrderPersonalizations(orderPayload = {}, options = {}) {
  const requestOrigin = String(options.requestOrigin || "").trim();
  const personalizedItems = extractPersonalizedLineItems(orderPayload, requestOrigin);
  const orderKey = buildOrderKey(orderPayload);
  const orderDir = path.join(ARCHIVE_ROOT_DIR, orderKey);
  ensureDir(orderDir);

  const results = [];
  for (const item of personalizedItems) {
    const lineKey = sanitizeSegment(item.lineItemId || `line-${item.index + 1}`) || `line-${item.index + 1}`;
    const lineDir = path.join(orderDir, lineKey);
    ensureDir(lineDir);

    let savedPreviewRelativePath = "";
    let previewError = null;
    if (item.previewUrl) {
      try {
        const { bytes, contentType } = await fetchPreviewBinary(item.previewUrl);
        if (bytes?.length > 0) {
          const ext = inferExtension(item.previewUrl, contentType);
          const previewFileName = `preview${ext}`;
          const previewPath = path.join(lineDir, previewFileName);
          fs.writeFileSync(previewPath, bytes);
          savedPreviewRelativePath = path.relative(orderDir, previewPath);
        }
      } catch (error) {
        previewError = String(error?.message || error);
      }
    }

    const lineMeta = {
      savedAt: safeNowIso(),
      lineItemId: item.lineItemId,
      title: item.title,
      quantity: item.quantity,
      productId: item.productId,
      variantId: item.variantId,
      sku: item.sku,
      templateId: item.templateId || null,
      previewUrl: item.previewUrl || null,
      savedPreviewRelativePath: savedPreviewRelativePath || null,
      previewError,
      properties: item.properties || {},
    };
    fs.writeFileSync(path.join(lineDir, "metadata.json"), JSON.stringify(lineMeta, null, 2), "utf8");
    results.push(lineMeta);
  }

  const summary = {
    savedAt: safeNowIso(),
    orderId: String(orderPayload?.id || ""),
    orderName: String(orderPayload?.name || ""),
    orderNumber: String(orderPayload?.order_number || ""),
    customerEmail: String(orderPayload?.email || ""),
    shopDomain: String(orderPayload?.source_name || options.shopDomain || ""),
    personalizedLineItemCount: results.length,
    lineItems: results,
  };
  fs.writeFileSync(path.join(orderDir, "order.json"), JSON.stringify(summary, null, 2), "utf8");

  return {
    orderKey,
    orderDir,
    lineItemCount: results.length,
    lineItems: results,
  };
}

