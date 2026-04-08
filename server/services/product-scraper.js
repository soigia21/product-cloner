import * as cheerio from "cheerio";

/**
 * Scrape product data từ 1 URL Shopify store
 * Thử .json endpoint trước, fallback sang HTML parsing
 */
export async function scrapeProduct(url) {
  const parsedUrl = validateShopifyUrl(url);

  // Method 1: .json endpoint
  try {
    const product = await fetchProductJson(parsedUrl);
    if (product) return { ...product, sourceUrl: url };
  } catch (e) {
    console.log("JSON endpoint failed, trying HTML fallback...");
  }

  // Method 2: Parse HTML page
  try {
    const product = await fetchProductHtml(parsedUrl);
    if (product) return { ...product, sourceUrl: url };
  } catch (e) {
    console.log("HTML parsing failed:", e.message);
  }

  throw new Error(
    "Không thể lấy dữ liệu sản phẩm. Kiểm tra lại URL hoặc store có thể đã chặn truy cập."
  );
}

function validateShopifyUrl(url) {
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error("URL không hợp lệ. Vui lòng nhập URL đầy đủ (https://...)");
  }

  if (!parsedUrl.pathname.includes("/products/")) {
    throw new Error(
      "URL không phải trang sản phẩm Shopify. URL cần có dạng: https://store.com/products/product-handle"
    );
  }

  parsedUrl.search = "";
  parsedUrl.hash = "";
  return parsedUrl;
}

async function fetchProductJson(url) {
  const jsonUrl = `${url.origin}${url.pathname}.json`;

  const response = await fetch(jsonUrl, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) return null;

  const data = await response.json();
  if (!data?.product) return null;

  return parseProductJson(data.product);
}

function parseProductJson(raw) {
  const normalizedVariants = normalizeRawVariants(raw?.variants);
  const normalizedOptions = normalizeRawOptions(raw, normalizedVariants);
  const normalizedImages = normalizeRawImages(raw);
  const normalizedTags = normalizeTagList(raw?.tags);
  const inferredProductType = inferProductType(raw?.product_type, normalizedTags);

  return {
    title: raw.title || "Untitled Product",
    bodyHtml: raw.body_html || "",
    vendor: raw.vendor || "",
    productType: inferredProductType,
    category: inferredProductType,
    tags: normalizedTags,
    options: normalizedOptions,
    variants: normalizedVariants,
    images: normalizedImages,
  };
}

function normalizeTagList(rawTags) {
  if (Array.isArray(rawTags)) return rawTags.map((tag) => String(tag).trim()).filter(Boolean);
  if (typeof rawTags === "string") return rawTags.split(",").map((tag) => tag.trim()).filter(Boolean);
  return [];
}

function inferProductType(productType, normalizedTags = []) {
  const direct = String(productType || "").trim();
  if (direct) return direct;
  return String(normalizedTags[0] || "").trim();
}

function toMoneyString(value, fallback = "0.00") {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "string") return value;
  const num = Number(value);
  if (Number.isFinite(num)) return num.toFixed(2);
  return fallback;
}

function normalizeConnectionArray(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.edges)) {
    return value.edges.map((edge) => edge?.node).filter(Boolean);
  }
  if (value && Array.isArray(value.nodes)) {
    return value.nodes.filter(Boolean);
  }
  return [];
}

function extractVariantOptionValue(variant, index) {
  const direct = variant?.[`option${index + 1}`];
  if (direct !== undefined && direct !== null && direct !== "") return String(direct);

  if (Array.isArray(variant?.options)) {
    const fromOptionsArray = variant.options[index];
    if (fromOptionsArray !== undefined && fromOptionsArray !== null && fromOptionsArray !== "") {
      return String(fromOptionsArray);
    }
  }

  if (Array.isArray(variant?.selectedOptions)) {
    const fromSelectedOptions = variant.selectedOptions[index]?.value;
    if (fromSelectedOptions !== undefined && fromSelectedOptions !== null && fromSelectedOptions !== "") {
      return String(fromSelectedOptions);
    }
  }

  return null;
}

function normalizeRawVariants(rawVariants) {
  const variants = normalizeConnectionArray(rawVariants);
  return variants.map((v, index) => {
    const option1 = extractVariantOptionValue(v, 0);
    const option2 = extractVariantOptionValue(v, 1);
    const option3 = extractVariantOptionValue(v, 2);
    const optionParts = [option1, option2, option3].filter(Boolean);

    return {
      title: v?.title || optionParts.join(" / ") || `Variant ${index + 1}`,
      price: toMoneyString(v?.price ?? v?.price_amount, "0.00"),
      compareAtPrice: v?.compare_at_price ?? v?.compareAtPrice ?? null,
      sku: v?.sku || "",
      option1,
      option2,
      option3,
      weight: Number(v?.weight) || 0,
      weightUnit: v?.weight_unit || v?.weightUnit || "kg",
      requiresShipping: v?.requires_shipping ?? v?.requiresShipping ?? true,
      taxable: v?.taxable ?? true,
      inventoryManagement: v?.inventory_management || v?.inventoryManagement || null,
      inventoryPolicy: v?.inventory_policy || v?.inventoryPolicy || null,
      inventoryQuantity: v?.inventory_quantity ?? v?.inventoryQuantity ?? null,
    };
  });
}

function deriveOptionValuesFromVariants(variants, index) {
  const values = [];
  const seen = new Set();
  for (const variant of variants) {
    const value = variant?.[`option${index + 1}`];
    if (!value) continue;
    const key = String(value);
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(key);
  }
  return values;
}

function normalizeRawOptions(raw, normalizedVariants) {
  const variants = Array.isArray(normalizedVariants) ? normalizedVariants : [];
  const optionsWithValues = normalizeConnectionArray(raw?.options_with_values);
  if (optionsWithValues.length > 0) {
    return optionsWithValues.map((opt, index) => ({
      name: opt?.name || `Option ${index + 1}`,
      values: Array.isArray(opt?.values)
        ? opt.values.map((value) => String(value))
        : deriveOptionValuesFromVariants(variants, index),
    }));
  }

  const options = normalizeConnectionArray(raw?.options);
  if (options.length > 0 && typeof options[0] === "object") {
    return options.map((opt, index) => ({
      name: opt?.name || `Option ${index + 1}`,
      values: Array.isArray(opt?.values)
        ? opt.values.map((value) => String(value))
        : deriveOptionValuesFromVariants(variants, index),
    }));
  }

  if (options.length > 0) {
    return options.map((name, index) => ({
      name: String(name || `Option ${index + 1}`),
      values: deriveOptionValuesFromVariants(variants, index),
    }));
  }

  const synthetic = [];
  for (let index = 0; index < 3; index += 1) {
    const values = deriveOptionValuesFromVariants(variants, index);
    if (values.length > 0) {
      synthetic.push({
        name: `Option ${index + 1}`,
        values,
      });
    }
  }
  return synthetic;
}

function normalizeRawImages(raw) {
  const images = normalizeConnectionArray(raw?.images);
  const normalized = images
    .map((img, index) => {
      if (!img) return null;
      if (typeof img === "string") {
        return {
          src: img,
          alt: null,
          position: index + 1,
        };
      }
      const src = img?.src || img?.url || img?.originalSrc || img?.transformedSrc || "";
      if (!src) return null;
      return {
        src,
        alt: img?.alt || img?.altText || null,
        position: Number(img?.position) || index + 1,
      };
    })
    .filter(Boolean);

  if (normalized.length > 0) return normalized;

  const fallbackSrc = raw?.image?.src || raw?.image?.url || raw?.featured_image || raw?.featuredImage?.url || "";
  if (!fallbackSrc) return [];
  return [
    {
      src: fallbackSrc,
      alt: null,
      position: 1,
    },
  ];
}

async function fetchProductHtml(url) {
  const response = await fetch(url.toString(), {
    headers: {
      Accept: "text/html",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) return null;

  const html = await response.text();
  const $ = cheerio.load(html);

  // Ưu tiên đọc embedded Shopify product JSON để giữ full matrix variants/price
  const embeddedProduct = extractEmbeddedShopifyProduct($, html, url);
  if (embeddedProduct) {
    return parseProductJson(embeddedProduct);
  }

  // Tìm LD+JSON structured data
  let ldJsonProduct = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const json = JSON.parse($(el).html() || "");
      if (json["@type"] === "Product") {
        ldJsonProduct = json;
      } else if (Array.isArray(json["@graph"])) {
        ldJsonProduct = json["@graph"].find((item) => item["@type"] === "Product");
      }
    } catch {}
  });

  if (ldJsonProduct) return parseFromLdJson(ldJsonProduct, $);
  return parseFromMetaTags($);
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractBalancedJson(source, startIndex) {
  if (startIndex < 0 || startIndex >= source.length) return null;
  const opening = source[startIndex];
  const closing = opening === "{" ? "}" : opening === "[" ? "]" : null;
  if (!closing) return null;

  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = startIndex; i < source.length; i += 1) {
    const ch = source[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (ch === "\\") {
      if (inString) escapeNext = true;
      continue;
    }

    if (ch === "\"") {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === opening) depth += 1;
    if (ch === closing) depth -= 1;
    if (depth === 0) {
      return source.slice(startIndex, i + 1);
    }
  }

  return null;
}

function extractJsonAfterMarker(source, marker) {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) return null;

  for (let i = markerIndex + marker.length; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{" || ch === "[") {
      return extractBalancedJson(source, i);
    }
    if (!/\s|=|:/.test(ch)) break;
  }

  return null;
}

function looksLikeShopifyProduct(candidate) {
  if (!candidate || typeof candidate !== "object") return false;
  const variants = normalizeConnectionArray(candidate?.variants);
  if (variants.length === 0) return false;
  const hasIdentity = Boolean(candidate?.title || candidate?.name || candidate?.handle || candidate?.id);
  const firstVariant = variants[0] || {};
  const hasVariantShape = (
    firstVariant?.price !== undefined ||
    firstVariant?.price_amount !== undefined ||
    firstVariant?.option1 !== undefined ||
    Array.isArray(firstVariant?.options) ||
    Array.isArray(firstVariant?.selectedOptions) ||
    firstVariant?.title !== undefined
  );
  return hasIdentity && hasVariantShape;
}

function findEmbeddedProductCandidate(node, depth = 0, seen = new WeakSet()) {
  if (!node || typeof node !== "object") return null;
  if (depth > 12) return null;
  if (seen.has(node)) return null;
  seen.add(node);

  if (looksLikeShopifyProduct(node)) return node;
  if (looksLikeShopifyProduct(node?.product)) return node.product;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findEmbeddedProductCandidate(item, depth + 1, seen);
      if (found) return found;
    }
    return null;
  }

  for (const value of Object.values(node)) {
    const found = findEmbeddedProductCandidate(value, depth + 1, seen);
    if (found) return found;
  }

  return null;
}

function toBodyHtml(raw) {
  const bodyHtml = raw?.body_html || raw?.descriptionHtml || "";
  if (bodyHtml) return String(bodyHtml);
  const description = raw?.description || "";
  if (!description) return "";
  if (/<[a-z][\s\S]*>/i.test(description)) return String(description);
  return `<p>${description}</p>`;
}

function normalizeEmbeddedProduct(raw) {
  const variants = normalizeConnectionArray(raw?.variants).map((variant) => ({
    ...variant,
    compare_at_price: variant?.compare_at_price ?? variant?.compareAtPrice ?? null,
    inventory_management: variant?.inventory_management ?? variant?.inventoryManagement ?? null,
    inventory_policy: variant?.inventory_policy ?? variant?.inventoryPolicy ?? null,
    inventory_quantity: variant?.inventory_quantity ?? variant?.inventoryQuantity ?? null,
    weight_unit: variant?.weight_unit ?? variant?.weightUnit ?? "kg",
    requires_shipping: variant?.requires_shipping ?? variant?.requiresShipping ?? true,
  }));
  const images = normalizeConnectionArray(raw?.images);
  const tags = normalizeTagList(
    Array.isArray(raw?.productTags) ? raw.productTags : raw?.tags
  );
  const inferredProductType = inferProductType(raw?.product_type || raw?.productType, tags);

  return {
    title: raw?.title || raw?.name || "Untitled Product",
    body_html: toBodyHtml(raw),
    vendor: raw?.vendor || raw?.brand?.name || "",
    product_type: inferredProductType,
    category: inferredProductType,
    tags,
    options: raw?.options_with_values || raw?.options || [],
    variants,
    images,
    featured_image: raw?.featured_image || raw?.featuredImage || raw?.image || null,
  };
}

function extractHandleFromProductUrl(url) {
  const pathname = String(url?.pathname || "");
  const match = pathname.match(/\/products\/([^/?#]+)/i);
  if (!match) return "";
  return decodeURIComponent(match[1]).trim().toLowerCase();
}

function getCandidateHandle(candidate) {
  const direct = String(candidate?.handle || "").trim().toLowerCase();
  if (direct) return direct;

  const productUrl = String(candidate?.url || candidate?.onlineStoreUrl || "").trim();
  if (!productUrl) return "";
  const match = productUrl.match(/\/products\/([^/?#]+)/i);
  if (!match) return "";
  return decodeURIComponent(match[1]).trim().toLowerCase();
}

function extractEmbeddedShopifyProduct($, html, url) {
  const scripts = $("script").toArray();
  const expectedHandle = extractHandleFromProductUrl(url);
  let fallbackCandidate = null;
  const captureCandidate = (candidate) => {
    if (!candidate) return false;
    if (!fallbackCandidate) fallbackCandidate = candidate;
    if (!expectedHandle) return true;
    const candidateHandle = getCandidateHandle(candidate);
    return candidateHandle && candidateHandle === expectedHandle;
  };

  for (const script of scripts) {
    const type = String($(script).attr("type") || "").toLowerCase();
    const id = String($(script).attr("id") || "").toLowerCase();
    const hasProductJsonAttr = $(script).attr("data-product-json") !== undefined;
    if (!(type === "application/json" || hasProductJsonAttr || id.includes("productjson") || id.includes("product-json"))) {
      continue;
    }

    const parsed = safeJsonParse($(script).html() || "");
    if (!parsed) continue;
    const candidate = findEmbeddedProductCandidate(parsed);
    if (!candidate) continue;
    if (captureCandidate(candidate)) return normalizeEmbeddedProduct(candidate);
  }

  const markers = [
    "var meta =",
    "window.meta =",
    "ShopifyAnalytics.meta =",
    "window.ShopifyAnalytics.meta =",
    "window.__PRELOADED_STATE__ =",
    "window.__INITIAL_STATE__ =",
    "__NEXT_DATA__",
    "\"product\":",
  ];

  for (const script of scripts) {
    const text = $(script).html() || "";
    if (!text) continue;
    for (const marker of markers) {
      const rawJson = extractJsonAfterMarker(text, marker);
      if (!rawJson) continue;
      const parsed = safeJsonParse(rawJson);
      if (!parsed) continue;
      const candidate = findEmbeddedProductCandidate(parsed);
      if (!candidate) continue;
      if (captureCandidate(candidate)) return normalizeEmbeddedProduct(candidate);
    }
  }

  // Fallback cuối: scan toàn bộ HTML cho object "product"
  for (const marker of ["\"product\":", "window.__INITIAL_STATE__ =", "window.__PRELOADED_STATE__ ="]) {
    const rawJson = extractJsonAfterMarker(html, marker);
    if (!rawJson) continue;
    const parsed = safeJsonParse(rawJson);
    if (!parsed) continue;
    const candidate = findEmbeddedProductCandidate(parsed);
    if (!candidate) continue;
    if (captureCandidate(candidate)) return normalizeEmbeddedProduct(candidate);
  }

  return fallbackCandidate ? normalizeEmbeddedProduct(fallbackCandidate) : null;
}

function parseFromLdJson(ldJson, $) {
  const title = ldJson.name || $("title").text().split("|")[0]?.trim() || "Product";
  const description = ldJson.description || $('meta[name="description"]').attr("content") || "";
  const tags = normalizeTagList($('meta[property="product:tag"]').attr("content") || "");
  const inferredProductType = inferProductType(
    $('meta[property="product:type"]').attr("content") || "",
    tags
  );

  const offers = Array.isArray(ldJson.offers) ? ldJson.offers : ldJson.offers ? [ldJson.offers] : [];

  const variants = offers.map((offer, idx) => ({
    title: offer.name || `Variant ${idx + 1}`,
    price: offer.price || "0.00",
    compareAtPrice: null,
    sku: offer.sku || "",
    option1: offer.name || null,
    option2: null,
    option3: null,
    weight: 0,
    weightUnit: "kg",
    requiresShipping: true,
    taxable: true,
  }));

  const imageUrls = [];
  if (ldJson.image) {
    const imgs = Array.isArray(ldJson.image) ? ldJson.image : [ldJson.image];
    imgs.forEach((img) => {
      if (typeof img === "string") imageUrls.push(img);
      else if (img?.url) imageUrls.push(img.url);
    });
  }

  if (imageUrls.length === 0) {
    $('img[src*="cdn.shopify"]').each((_, el) => {
      const src = $(el).attr("src");
      if (src && !imageUrls.includes(src)) {
        imageUrls.push(src.startsWith("//") ? `https:${src}` : src);
      }
    });
  }

  return {
    title,
    bodyHtml: `<p>${description}</p>`,
    vendor: ldJson.brand?.name || "",
    productType: inferredProductType,
    category: inferredProductType,
    tags,
    options: variants.length > 1 ? [{ name: "Title", values: variants.map((v) => v.title) }] : [],
    variants: variants.length > 0 ? variants : [{
      title: "Default Title", price: "0.00", compareAtPrice: null, sku: "",
      option1: "Default Title", option2: null, option3: null,
      weight: 0, weightUnit: "kg", requiresShipping: true, taxable: true,
    }],
    images: imageUrls.map((src, idx) => ({ src, alt: null, position: idx + 1 })),
  };
}

function parseFromMetaTags($) {
  const title = $('meta[property="og:title"]').attr("content") || $("title").text().split("|")[0]?.trim();
  if (!title) return null;

  const description = $('meta[property="og:description"]').attr("content") || $('meta[name="description"]').attr("content") || "";
  const price = $('meta[property="og:price:amount"]').attr("content") || $('meta[property="product:price:amount"]').attr("content") || "0.00";
  const tags = normalizeTagList($('meta[property="product:tag"]').attr("content") || "");
  const inferredProductType = inferProductType(
    $('meta[property="product:type"]').attr("content") || "",
    tags
  );

  const imageUrls = [];
  const ogImage = $('meta[property="og:image"]').attr("content");
  if (ogImage) imageUrls.push(ogImage.startsWith("//") ? `https:${ogImage}` : ogImage);

  $('img[src*="cdn.shopify"]').each((_, el) => {
    const src = $(el).attr("src");
    if (src) {
      const fullSrc = src.startsWith("//") ? `https:${src}` : src;
      if (!imageUrls.includes(fullSrc)) imageUrls.push(fullSrc);
    }
  });

  return {
    title,
    bodyHtml: `<p>${description}</p>`,
    vendor: "",
    productType: inferredProductType,
    category: inferredProductType,
    tags,
    options: [],
    variants: [{
      title: "Default Title", price, compareAtPrice: null, sku: "",
      option1: "Default Title", option2: null, option3: null,
      weight: 0, weightUnit: "kg", requiresShipping: true, taxable: true,
    }],
    images: imageUrls.map((src, idx) => ({ src, alt: null, position: idx + 1 })),
  };
}
