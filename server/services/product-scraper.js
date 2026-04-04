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
  return {
    title: raw.title || "Untitled Product",
    bodyHtml: raw.body_html || "",
    vendor: raw.vendor || "",
    productType: raw.product_type || "",
    tags: typeof raw.tags === "string"
      ? raw.tags.split(",").map((t) => t.trim()).filter(Boolean)
      : Array.isArray(raw.tags) ? raw.tags : [],
    options: (raw.options || []).map((opt) => ({
      name: opt.name || "Option",
      values: opt.values || [],
    })),
    variants: (raw.variants || []).map((v) => ({
      title: v.title || "Default",
      price: v.price || "0.00",
      compareAtPrice: v.compare_at_price || null,
      sku: v.sku || "",
      option1: v.option1 || null,
      option2: v.option2 || null,
      option3: v.option3 || null,
      weight: v.weight || 0,
      weightUnit: v.weight_unit || "kg",
      requiresShipping: v.requires_shipping ?? true,
      taxable: v.taxable ?? true,
    })),
    images: (raw.images || []).map((img, idx) => ({
      src: img.src || "",
      alt: img.alt || null,
      position: img.position || idx + 1,
    })),
  };
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

function parseFromLdJson(ldJson, $) {
  const title = ldJson.name || $("title").text().split("|")[0]?.trim() || "Product";
  const description = ldJson.description || $('meta[name="description"]').attr("content") || "";

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
    productType: "",
    tags: [],
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
    productType: "",
    tags: [],
    options: [],
    variants: [{
      title: "Default Title", price, compareAtPrice: null, sku: "",
      option1: "Default Title", option2: null, option3: null,
      weight: 0, weightUnit: "kg", requiresShipping: true, taxable: true,
    }],
    images: imageUrls.map((src, idx) => ({ src, alt: null, position: idx + 1 })),
  };
}
