import * as cheerio from "cheerio";

function normalizeInputUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || "").trim());
  } catch {
    throw new Error("URL không hợp lệ");
  }

  parsed.hash = "";
  return parsed;
}

function inferTargetType(pathname) {
  const path = String(pathname || "");
  if (/\/products\/[^/?#]+/i.test(path)) return "product";
  if (/\/collections\/[^/?#]+/i.test(path)) return "collection";
  return "unknown";
}

function extractProductHandle(pathname) {
  const m = String(pathname || "").match(/\/products\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]) : "";
}

function extractCollectionHandle(pathname) {
  const m = String(pathname || "").match(/\/collections\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]) : "";
}

function mapCollectionProductsFromJson(products = [], origin) {
  const out = [];
  const seenHandles = new Set();
  for (const product of products || []) {
    const handle = String(product?.handle || "").trim();
    if (!handle || seenHandles.has(handle)) continue;
    seenHandles.add(handle);

    const firstImage =
      (Array.isArray(product?.images) && product.images[0]?.src) ||
      product?.image?.src ||
      "";
    out.push({
      handle,
      title: String(product?.title || handle),
      url: `${origin}/products/${encodeURIComponent(handle)}`,
      image: firstImage ? String(firstImage) : "",
    });
  }
  return out;
}

async function fetchCollectionProductsJson(parsedUrl, collectionHandle) {
  const all = [];
  const safeHandle = encodeURIComponent(collectionHandle);

  for (let page = 1; page <= 24; page += 1) {
    const endpoint = `${parsedUrl.origin}/collections/${safeHandle}/products.json?limit=250&page=${page}`;
    const response = await fetch(endpoint, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      if (page === 1) return [];
      break;
    }

    const data = await response.json().catch(() => ({}));
    const items = Array.isArray(data?.products) ? data.products : [];
    if (items.length === 0) break;
    all.push(...items);
    if (items.length < 250) break;
  }

  return mapCollectionProductsFromJson(all, parsedUrl.origin);
}

function pickFirstImageUrl($node) {
  const img = $node.find("img").first();
  if (!img || img.length === 0) return "";
  return String(
    img.attr("src") ||
    img.attr("data-src") ||
    img.attr("data-original") ||
    img.attr("data-lazy-src") ||
    ""
  ).trim();
}

async function fetchCollectionProductsHtml(parsedUrl) {
  const response = await fetch(parsedUrl.toString(), {
    headers: {
      Accept: "text/html",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    throw new Error(`Cannot load collection page (HTTP ${response.status})`);
  }

  const html = await response.text();
  const $ = cheerio.load(html);
  const out = [];
  const seen = new Set();

  $('a[href*="/products/"]').each((_, el) => {
    const hrefRaw = String($(el).attr("href") || "").trim();
    if (!hrefRaw) return;

    let resolved;
    try {
      resolved = new URL(hrefRaw, parsedUrl.origin);
    } catch {
      return;
    }
    const handle = extractProductHandle(resolved.pathname);
    if (!handle || seen.has(handle)) return;
    seen.add(handle);

    const text = String($(el).attr("title") || $(el).attr("data-product-title") || $(el).text() || "").trim();
    let image = pickFirstImageUrl($(el));
    if (image.startsWith("//")) image = `https:${image}`;
    if (image && !/^https?:\/\//i.test(image)) {
      try {
        image = new URL(image, parsedUrl.origin).toString();
      } catch {
        image = "";
      }
    }

    out.push({
      handle,
      title: text || handle,
      url: `${parsedUrl.origin}/products/${encodeURIComponent(handle)}`,
      image,
    });
  });

  return out;
}

export async function inspectImportTarget(rawUrl) {
  const parsed = normalizeInputUrl(rawUrl);
  const type = inferTargetType(parsed.pathname);

  if (type === "product") {
    const handle = extractProductHandle(parsed.pathname);
    if (!handle) {
      throw new Error("Không nhận diện được product handle từ URL");
    }
    return {
      type: "product",
      normalizedUrl: `${parsed.origin}/products/${encodeURIComponent(handle)}`,
      product: {
        handle,
        url: `${parsed.origin}/products/${encodeURIComponent(handle)}`,
      },
    };
  }

  if (type === "collection") {
    const handle = extractCollectionHandle(parsed.pathname);
    if (!handle) {
      throw new Error("Không nhận diện được collection handle từ URL");
    }

    let products = await fetchCollectionProductsJson(parsed, handle);
    let source = "collection-json";

    if (!Array.isArray(products) || products.length === 0) {
      products = await fetchCollectionProductsHtml(parsed);
      source = "collection-html";
    }

    if (!Array.isArray(products) || products.length === 0) {
      throw new Error("Không tìm thấy product nào trong collection này");
    }

    return {
      type: "collection",
      normalizedUrl: `${parsed.origin}/collections/${encodeURIComponent(handle)}`,
      collection: {
        handle,
        url: `${parsed.origin}/collections/${encodeURIComponent(handle)}`,
      },
      products,
      source,
    };
  }

  throw new Error("Link phải là trang product hoặc collection của Shopify");
}
