import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { scrapeProduct } from "./services/product-scraper.js";
import { createProduct, updateProductStatus, upsertProductTemplateMetafield } from "./services/product-creator.js";
import { extractCustomilyProduct } from "./services/customily-extractor.js";
import { inspectImportTarget } from "./services/import-inspector.js";
import {
  importProduct,
  listProducts,
  loadProduct,
  updateProductMetadata,
  cleanupOldProducts,
  deleteProduct,
} from "./services/customily-importer.js";
import { renderPreview, preRegisterAllFonts, getWorkflowTrace } from "./services/preview-renderer.js";
import { computeVisibility, deriveSyntheticSelectionsFromProductConfig } from "./services/visibility-engine.js";
import { getImage } from "./services/image-cache.js";
import { getShopifyConfig, getToken } from "./services/shopify-auth.js";
import https from "https";
import http from "http";

// Pre-register all custom fonts BEFORE any canvas creation (Blueprint §9.1)
preRegisterAllFonts();

const app = express();
const PORT = process.env.PORT || 3001;
const UPLOADS_DIR = path.resolve(process.cwd(), "data", "uploads");
const DEFAULT_IMPORTED_INVENTORY_QUANTITY = Number.isFinite(Number(process.env.DEFAULT_IMPORTED_INVENTORY_QUANTITY))
  ? Math.max(0, Math.floor(Number(process.env.DEFAULT_IMPORTED_INVENTORY_QUANTITY)))
  : 999;

function buildCloneMetadataFromResult(result = {}) {
  return {
    productId: String(result.productId || ""),
    productTitle: result.productTitle || "",
    productHandle: result.productHandle || "",
    productUrl: result.productUrl || "",
    status: result.status || "draft",
    publication: result.publication || null,
    updatedAt: new Date().toISOString(),
  };
}

function buildCloneSourceFromScraped(scrapedProduct = {}, sourceUrl = "") {
  const firstVariant = scrapedProduct?.variants?.[0] || {};
  const firstImage = scrapedProduct?.images?.[0] || {};
  return {
    title: scrapedProduct?.title || "",
    price: firstVariant?.price || "",
    compareAtPrice: firstVariant?.compareAtPrice || null,
    variantsCount: Array.isArray(scrapedProduct?.variants) ? scrapedProduct.variants.length : 0,
    image: firstImage?.src || "",
    sourceUrl: sourceUrl || "",
  };
}

function buildClonedProductSnapshot(scrapedProduct = {}, sourceUrl = "") {
  return {
    title: scrapedProduct?.title || "",
    bodyHtml: scrapedProduct?.bodyHtml || "",
    vendor: scrapedProduct?.vendor || "",
    productType: scrapedProduct?.productType || "",
    tags: Array.isArray(scrapedProduct?.tags) ? scrapedProduct.tags : [],
    options: Array.isArray(scrapedProduct?.options)
      ? scrapedProduct.options.map((opt) => ({
        name: opt?.name || "",
        values: Array.isArray(opt?.values) ? opt.values : [],
      }))
      : [],
    variants: Array.isArray(scrapedProduct?.variants)
      ? scrapedProduct.variants.map((v) => ({
        title: v?.title || "",
        price: v?.price || "",
        compareAtPrice: v?.compareAtPrice || null,
        sku: v?.sku || "",
        option1: v?.option1 || null,
        option2: v?.option2 || null,
        option3: v?.option3 || null,
        weight: v?.weight || 0,
        weightUnit: v?.weightUnit || "kg",
        requiresShipping: v?.requiresShipping ?? true,
        taxable: v?.taxable ?? true,
      }))
      : [],
    images: Array.isArray(scrapedProduct?.images)
      ? scrapedProduct.images.map((img, idx) => ({
        src: img?.src || "",
        alt: img?.alt || "",
        position: img?.position || idx + 1,
      }))
      : [],
    sourceUrl,
    importedAt: new Date().toISOString(),
  };
}

function normalizeNumericShopifyId(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const gidMatch = raw.match(/Product\/(\d+)/i);
  if (gidMatch) return gidMatch[1];
  return raw.replace(/[^0-9]/g, "");
}

function isTruthyParam(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function getRequestOrigin(req) {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim();
  const forwardedHost = String(req.headers["x-forwarded-host"] || "")
    .split(",")[0]
    .trim();
  const proto = forwardedProto || req.protocol || "https";
  const host = forwardedHost || req.get("host");
  return `${proto}://${host}`;
}

function buildStorefrontTemplatePayload(product, req, options = {}) {
  const includeRaw = Boolean(options.includeRaw);
  const productId = encodeURIComponent(product.id);
  const origin = getRequestOrigin(req);
  const fonts = {};
  for (const [sourcePath, localPath] of Object.entries(product.fonts || {})) {
    const baseName = path.basename(String(localPath || ""));
    if (!baseName) continue;
    fonts[sourcePath] = `${origin}/api/products/${productId}/fonts/${encodeURIComponent(baseName)}`;
  }

  const template = {
    id: product.id,
    url: product.url,
    handle: product.handle,
    shopDomain: product.shopDomain,
    publicDomain: product.publicDomain,
    shopifyProductId: product.shopifyProductId,
    defaultDesignUUID: product.defaultDesignUUID,
    variantDesigns: product.variantDesigns || {},
    options: product.options || [],
    optionAliases: product.optionAliases || {},
    settings: product.settings || {},
    productConfig: product.productConfig || {},
    libraryDIPs: product.libraryDIPs || {},
    fonts,
    importedAt: product.importedAt || null,
  };

  if (includeRaw) {
    return {
      ...template,
      rawProduct: {
        ...product,
        fonts,
      },
    };
  }

  return template;
}

function resolveTemplateFromQuery(query = {}) {
  const templateId = String(query.template_id || "").trim();
  if (templateId) {
    const byTemplate = loadProduct(templateId);
    if (byTemplate) return byTemplate;
  }

  const productId = normalizeNumericShopifyId(query.product_id || query.productId || query.id);
  const handle = String(query.handle || "").trim().toLowerCase();
  const products = listProducts();

  for (const summary of products) {
    const candidate = loadProduct(summary.id);
    if (!candidate) continue;

    if (productId) {
      const candidateProductId = normalizeNumericShopifyId(
        candidate.shopifyClone?.productId || candidate.shopifyProductId
      );
      if (candidateProductId && candidateProductId === productId) return candidate;
    }

    if (handle) {
      const sourceHandle = String(candidate.handle || "").toLowerCase();
      const cloneHandle = String(candidate.shopifyClone?.productHandle || "").toLowerCase();
      if (handle === sourceHandle || handle === cloneHandle) return candidate;
    }
  }

  return null;
}

async function syncTemplateMetafieldToShopify(templateId, shopifyProductId) {
  const cfg = getShopifyConfig();
  if (!cfg.configured) {
    throw new Error("Chưa cấu hình Shopify store");
  }
  const normalizedProductId = normalizeNumericShopifyId(shopifyProductId);
  if (!normalizedProductId) {
    throw new Error("Invalid Shopify product id");
  }
  const tokenInfo = await getToken();
  return upsertProductTemplateMetafield(
    cfg.storeDomain,
    tokenInfo.accessToken,
    normalizedProductId,
    templateId
  );
}

app.use(cors());
app.use(express.json({ limit: "50mb" }));
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Serve static files in production
if (process.env.NODE_ENV === "production") {
  app.use(express.static("dist"));
}

// ===== Product Cloner Routes =====

app.post("/api/scrape", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "Thiếu URL sản phẩm" });
  try {
    const product = await scrapeProduct(url);
    res.json({ success: true, product });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.post("/api/clone", async (req, res) => {
  const { product } = req.body;
  if (!product) return res.status(400).json({ error: "Thiếu dữ liệu sản phẩm" });
  const cfg = getShopifyConfig();
  if (!cfg.configured) {
    return res.status(500).json({ error: "Chưa cấu hình Shopify store" });
  }
  try {
    const tokenInfo = await getToken();
    const result = await createProduct(cfg.storeDomain, tokenInfo.accessToken, product, {
      defaultInventoryQuantity: DEFAULT_IMPORTED_INVENTORY_QUANTITY,
      forcePhysicalProduct: true,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/api/status", (req, res) => {
  const cfg = getShopifyConfig();
  res.json({
    configured: cfg.configured,
    store: cfg.configured ? cfg.storeDomain : null,
    authMode: cfg.mode,
  });
});

// ===== Customily Extractor =====

app.post("/api/extract", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "Thiếu URL" });
  try {
    const handleMatch = url.match(/\/products\/([^?#]+)/);
    const handle = handleMatch ? handleMatch[1].substring(0, 50) : "product";
    const outputDir = path.resolve(process.cwd(), "extracted", handle);
    const summary = await extractCustomilyProduct(url, outputDir);
    res.json({ success: true, summary });
  } catch (error) {
    console.error("Extract error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.use("/extracted", express.static(path.resolve(process.cwd(), "extracted")));
app.use("/api/uploads", express.static(UPLOADS_DIR));

// ===== Personalized Cloner Routes =====

/**
 * Proxy original product page/resources so we can run exact Customily JS in iframe.
 * Route:
 *   /proxy/:id            -> original product URL pathname
 *   /proxy/:id/*          -> proxied path on original host
 */
function proxyOriginalPage(req, res) {
  const product = loadProduct(req.params.id);
  if (!product?.url) {
    return res.status(404).send("Product not found");
  }

  let sourceUrl;
  try {
    sourceUrl = new URL(product.url);
  } catch {
    return res.status(500).send("Invalid source URL");
  }

  const proxyPrefix = `/proxy/${req.params.id}`;
  const afterPrefix = req.originalUrl.startsWith(proxyPrefix)
    ? req.originalUrl.slice(proxyPrefix.length)
    : "";

  let targetPath = afterPrefix;
  if (!targetPath || targetPath === "/") {
    targetPath = sourceUrl.pathname + (sourceUrl.search || "");
  } else if (targetPath.startsWith("?")) {
    targetPath = sourceUrl.pathname + targetPath;
  }

  const clientHeaders = { ...req.headers };
  delete clientHeaders.host;
  delete clientHeaders["content-length"];
  clientHeaders.host = sourceUrl.host;
  clientHeaders.origin = `${sourceUrl.protocol}//${sourceUrl.host}`;
  clientHeaders.referer = `${sourceUrl.protocol}//${sourceUrl.host}${sourceUrl.pathname}`;

  const transport = sourceUrl.protocol === "http:" ? http : https;
  const upstreamReq = transport.request(
    {
      protocol: sourceUrl.protocol,
      hostname: sourceUrl.hostname,
      port: sourceUrl.port || (sourceUrl.protocol === "http:" ? 80 : 443),
      method: req.method,
      path: targetPath,
      headers: clientHeaders,
    },
    (upstreamRes) => {
      const responseHeaders = { ...upstreamRes.headers };

      // Allow embedding proxied page in our app iframe.
      delete responseHeaders["x-frame-options"];
      delete responseHeaders["content-security-policy"];
      delete responseHeaders["content-security-policy-report-only"];

      // Keep redirects within proxy route when redirect target is same source host.
      const location = responseHeaders.location;
      if (typeof location === "string" && location.length > 0) {
        try {
          const locUrl = new URL(location, `${sourceUrl.protocol}//${sourceUrl.host}`);
          if (locUrl.host === sourceUrl.host) {
            responseHeaders.location = `${proxyPrefix}${locUrl.pathname}${locUrl.search || ""}${locUrl.hash || ""}`;
          }
        } catch {}
      }

      res.status(upstreamRes.statusCode || 502);
      for (const [k, v] of Object.entries(responseHeaders)) {
        if (v !== undefined) res.setHeader(k, v);
      }
      upstreamRes.pipe(res);
    }
  );

  upstreamReq.on("error", (error) => {
    console.error("Proxy error:", error.message);
    if (!res.headersSent) res.status(502).send("Proxy request failed");
  });

  req.pipe(upstreamReq);
}

app.use("/proxy/:id", proxyOriginalPage);
app.use("/proxy/:id/*", proxyOriginalPage);

/**
 * POST /api/import — Import a Customily product
 */
app.post("/api/import", async (req, res) => {
  const { url, publish, vendor } = req.body;
  if (!url) return res.status(400).json({ error: "Thiếu URL sản phẩm" });
  const cfg = getShopifyConfig();
  if (!cfg.configured) {
    return res.status(500).json({ success: false, error: "Chưa cấu hình Shopify store" });
  }
  try {
    const [importedProduct, scrapedProduct] = await Promise.all([
      importProduct(url),
      scrapeProduct(url),
    ]);
    const vendorOverride = String(vendor || "").trim();
    const effectiveProduct = vendorOverride
      ? { ...scrapedProduct, vendor: vendorOverride }
      : scrapedProduct;

    const tokenInfo = await getToken();
    const cloneResult = await createProduct(cfg.storeDomain, tokenInfo.accessToken, effectiveProduct, {
      status: publish ? "active" : "draft",
      defaultInventoryQuantity: DEFAULT_IMPORTED_INVENTORY_QUANTITY,
      forcePhysicalProduct: true,
    });
    const shopifyClone = buildCloneMetadataFromResult(cloneResult);
    const cloneSource = buildCloneSourceFromScraped(effectiveProduct, url);
    const clonedProduct = buildClonedProductSnapshot(effectiveProduct, url);
    const warnings = [];
    for (const w of cloneResult.inventoryWarnings || []) {
      warnings.push(`Inventory warning: ${w}`);
    }
    for (const w of cloneResult.publishWarnings || []) {
      warnings.push(w);
    }
    let templateMetafield = null;
    try {
      templateMetafield = await syncTemplateMetafieldToShopify(importedProduct.id, cloneResult.productId);
    } catch (metaError) {
      warnings.push(`Không thể sync metafield personalizer.template_id: ${metaError.message}`);
    }

    updateProductMetadata(importedProduct.id, {
      shopifyClone,
      cloneSource,
      clonedProduct,
      personalizer: templateMetafield
        ? {
          metafield: templateMetafield,
          templateId: importedProduct.id,
        }
        : undefined,
    });

    res.json({
      success: true,
      product: {
        id: importedProduct.id,
        optionsCount: importedProduct.options.length,
        variantsCount: Object.keys(importedProduct.variantDesigns).length,
        shopifyClone,
        cloneSource,
        templateMetafield,
      },
      warnings,
    });
  } catch (error) {
    console.error("Import error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/import/inspect — Detect product/collection and return import candidates.
 */
app.post("/api/import/inspect", async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ success: false, error: "Thiếu URL" });

  try {
    const target = await inspectImportTarget(url);

    if (target.type === "product") {
      let preview = null;
      try {
        const scraped = await scrapeProduct(target.product.url);
        preview = {
          title: scraped?.title || target.product.handle,
          image: scraped?.images?.[0]?.src || "",
          variantsCount: Array.isArray(scraped?.variants) ? scraped.variants.length : 0,
        };
      } catch {
        preview = {
          title: target.product.handle,
          image: "",
          variantsCount: 0,
        };
      }

      return res.json({
        success: true,
        target: {
          type: "product",
          normalizedUrl: target.normalizedUrl,
          product: {
            ...target.product,
            ...preview,
          },
        },
      });
    }

    return res.json({
      success: true,
      target: {
        type: "collection",
        normalizedUrl: target.normalizedUrl,
        collection: target.collection,
        products: target.products || [],
        source: target.source || "",
      },
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message || "Không thể phân tích URL import",
    });
  }
});

/**
 * POST /api/products/:id/save-draft — Ensure Shopify product status is draft
 */
app.post("/api/products/:id/save-draft", async (req, res) => {
  const product = loadProduct(req.params.id);
  if (!product) return res.status(404).json({ success: false, error: "Product not found" });

  const cfg = getShopifyConfig();
  if (!cfg.configured) {
    return res.status(500).json({ success: false, error: "Chưa cấu hình Shopify store" });
  }

  try {
    const tokenInfo = await getToken();
    let result = null;
    let scraped = null;
    const existingProductId = String(product.shopifyClone?.productId || "").replace(/[^0-9]/g, "");
    if (existingProductId) {
      result = await updateProductStatus(cfg.storeDomain, tokenInfo.accessToken, existingProductId, "draft");
    } else {
      scraped = await scrapeProduct(product.url);
      result = await createProduct(cfg.storeDomain, tokenInfo.accessToken, scraped, {
        status: "draft",
        defaultInventoryQuantity: DEFAULT_IMPORTED_INVENTORY_QUANTITY,
        forcePhysicalProduct: true,
      });
    }

    const cloneSource = product.cloneSource || (scraped ? buildCloneSourceFromScraped(scraped, product.url) : null);
    const clonedProduct = product.clonedProduct || (scraped ? buildClonedProductSnapshot(scraped, product.url) : null);
    const shopifyClone = {
      ...(product.shopifyClone || {}),
      ...buildCloneMetadataFromResult(result),
    };
    const warnings = [];
    for (const w of result.inventoryWarnings || []) {
      warnings.push(`Inventory warning: ${w}`);
    }
    for (const w of result.publishWarnings || []) {
      warnings.push(w);
    }
    let templateMetafield = null;
    try {
      templateMetafield = await syncTemplateMetafieldToShopify(product.id, shopifyClone.productId);
    } catch (metaError) {
      warnings.push(`Không thể sync metafield personalizer.template_id: ${metaError.message}`);
    }

    const patch = {
      shopifyClone,
      ...(cloneSource ? { cloneSource } : {}),
      ...(clonedProduct ? { clonedProduct } : {}),
    };
    if (templateMetafield) {
      patch.personalizer = {
        metafield: templateMetafield,
        templateId: product.id,
      };
    }

    updateProductMetadata(product.id, patch);
    res.json({ success: true, productId: product.id, shopifyClone, templateMetafield, warnings });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/products/:id/publish — Set Shopify product status to active
 */
app.post("/api/products/:id/publish", async (req, res) => {
  const product = loadProduct(req.params.id);
  if (!product) return res.status(404).json({ success: false, error: "Product not found" });

  const cfg = getShopifyConfig();
  if (!cfg.configured) {
    return res.status(500).json({ success: false, error: "Chưa cấu hình Shopify store" });
  }

  const existingProductId = String(product.shopifyClone?.productId || "").replace(/[^0-9]/g, "");
  if (!existingProductId) {
    return res.status(400).json({ success: false, error: "Chưa có Shopify Draft để publish" });
  }

  try {
    const tokenInfo = await getToken();
    const result = await updateProductStatus(cfg.storeDomain, tokenInfo.accessToken, existingProductId, "active");
    const shopifyClone = {
      ...(product.shopifyClone || {}),
      ...buildCloneMetadataFromResult(result),
      publishedAt: new Date().toISOString(),
    };
    updateProductMetadata(product.id, { shopifyClone });
    res.json({
      success: true,
      productId: product.id,
      shopifyClone,
      warnings: result.warnings || [],
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/products/:id/sync-template-metafield
 * Force sync personalizer.template_id metafield for an imported template + Shopify product.
 */
app.post("/api/products/:id/sync-template-metafield", async (req, res) => {
  const product = loadProduct(req.params.id);
  if (!product) return res.status(404).json({ success: false, error: "Product not found" });

  const shopifyProductId = normalizeNumericShopifyId(
    req.body?.shopifyProductId || product.shopifyClone?.productId
  );
  if (!shopifyProductId) {
    return res.status(400).json({
      success: false,
      error: "Missing Shopify product id. Create draft first.",
    });
  }

  try {
    const metafield = await syncTemplateMetafieldToShopify(product.id, shopifyProductId);
    updateProductMetadata(product.id, {
      personalizer: {
        metafield,
        templateId: product.id,
      },
    });
    res.json({ success: true, templateId: product.id, shopifyProductId, metafield });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/products — List imported products
 */
app.get("/api/products", (req, res) => {
  res.json({ success: true, products: listProducts() });
});

/**
 * GET /api/products/:id/meta — Full cloned product + Shopify metadata
 */
app.get("/api/products/:id/meta", (req, res) => {
  const product = loadProduct(req.params.id);
  if (!product) return res.status(404).json({ success: false, error: "Product not found" });

  res.json({
    success: true,
    product: {
      id: product.id,
      url: product.url,
      handle: product.handle,
      importedAt: product.importedAt,
      cloneSource: product.cloneSource || null,
      clonedProduct: product.clonedProduct || null,
      shopifyClone: product.shopifyClone || null,
      personalizer: product.personalizer || null,
    },
  });
});

/**
 * GET /api/storefront/template
 * GET /apps/personalizer/template (App Proxy alias)
 * Resolve personalized template JSON by:
 * 1) template_id metafield value
 * 2) Shopify product id
 * 3) product handle
 */
function handleStorefrontTemplateRequest(req, res) {
  const product = resolveTemplateFromQuery(req.query || {});
  if (!product) {
    return res.status(404).json({
      success: false,
      error: "Template not found",
      hint: "Pass template_id or product_id/handle",
    });
  }

  const includeRaw = isTruthyParam(req.query?.full || req.query?.raw);
  const payload = buildStorefrontTemplatePayload(product, req, { includeRaw });
  return res.json({
    success: true,
    templateId: product.id,
    template: payload,
  });
}

app.get("/api/storefront/template", handleStorefrontTemplateRequest);
app.get("/apps/personalizer/template", handleStorefrontTemplateRequest);

/**
 * DELETE /api/products/:id — Delete one imported product
 */
app.delete("/api/products/:id", (req, res) => {
  const removed = deleteProduct(req.params.id);
  if (!removed) {
    return res.status(404).json({ success: false, error: "Product not found" });
  }
  return res.json({ success: true, products: listProducts() });
});

/**
 * POST /api/products/cleanup-old — Remove old personalized imports, keep latest N (default: 1)
 */
app.post("/api/products/cleanup-old", (req, res) => {
  const keepLatest = req.body?.keepLatest ?? 1;
  try {
    const result = cleanupOldProducts(keepLatest);
    res.json({ success: true, ...result, products: listProducts() });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/products/:id/options — Get product options for customizer form
 */
app.get("/api/products/:id/options", (req, res) => {
  const product = loadProduct(req.params.id);
  if (!product) return res.status(404).json({ error: "Product not found" });

  const synthetic = deriveSyntheticSelectionsFromProductConfig(product.productConfig || {});
  // Compute initial visibility with empty selections
  const { visibleOptions, selections } = computeVisibility(product.options, {}, {
    userSelectedOptionIds: [],
    syntheticSelections: synthetic.selections,
    syntheticAnchoredOptionIds: synthetic.anchoredOptionIds,
  });

  res.json({
    success: true,
    options: product.options,
    visibleOptionIds: visibleOptions.map((o) => o.id),
    defaultSelections: selections,
    variantDesigns: product.variantDesigns,
    productId: product.id,
    sourceUrl: product.url || "",
  });
});

/**
 * POST /api/products/:id/visibility — Compute visibility for given selections
 */
app.post("/api/products/:id/visibility", (req, res) => {
  const product = loadProduct(req.params.id);
  if (!product) return res.status(404).json({ error: "Product not found" });

  const { selections, userSelections } = req.body;
  const synthetic = deriveSyntheticSelectionsFromProductConfig(product.productConfig || {});
  const userSelectedOptionIds = userSelections
    ? Object.keys(userSelections)
    : [];
  const { visibleOptions, selections: finalSelections } = computeVisibility(
    product.options,
    selections || {},
    {
      userSelectedOptionIds,
      syntheticSelections: synthetic.selections,
      syntheticAnchoredOptionIds: synthetic.anchoredOptionIds,
    }
  );

  res.json({
    success: true,
    visibleOptionIds: visibleOptions.map((o) => o.id),
    selections: finalSelections,
  });
});

function sanitizeUploadSegment(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function inferImageExtension(fileName, mimeType) {
  const extFromName = path.extname(String(fileName || "")).toLowerCase();
  if (extFromName && [".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"].includes(extFromName)) {
    return extFromName;
  }

  const mime = String(mimeType || "").toLowerCase().trim();
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/png") return ".png";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/gif") return ".gif";
  if (mime === "image/bmp") return ".bmp";
  return ".png";
}

function parseDataUrlImage(dataUrl) {
  const raw = String(dataUrl || "");
  const m = raw.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/);
  if (!m) return null;
  try {
    const buffer = Buffer.from(m[2], "base64");
    if (!buffer || buffer.length === 0) return null;
    return { mimeType: m[1], buffer };
  } catch {
    return null;
  }
}

/**
 * POST /api/products/:id/upload-image — Upload user image for Image Upload options
 */
app.post("/api/products/:id/upload-image", (req, res) => {
  const product = loadProduct(req.params.id);
  if (!product) return res.status(404).json({ success: false, error: "Product not found" });

  const { optionId, fileName, mimeType, dataUrl } = req.body || {};
  const parsed = parseDataUrlImage(dataUrl);
  if (!parsed) {
    return res.status(400).json({ success: false, error: "Invalid image payload" });
  }

  const maxBytes = 20 * 1024 * 1024;
  if (parsed.buffer.length > maxBytes) {
    return res.status(400).json({ success: false, error: "Image too large (max 20MB)" });
  }

  const optionCid = String(optionId || "");
  const safeProductId = sanitizeUploadSegment(req.params.id);
  const ext = inferImageExtension(fileName, mimeType || parsed.mimeType);
  const safeBaseName = sanitizeUploadSegment(path.parse(String(fileName || "upload")).name) || "upload";
  const storedName = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}-${safeBaseName}${ext}`;
  const targetDir = path.join(UPLOADS_DIR, safeProductId);
  const targetPath = path.join(targetDir, storedName);

  try {
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(targetPath, parsed.buffer);
  } catch (error) {
    return res.status(500).json({ success: false, error: `Cannot save upload: ${error.message}` });
  }

  const url = `/api/uploads/${encodeURIComponent(safeProductId)}/${encodeURIComponent(storedName)}`;
  return res.json({
    success: true,
    upload: {
      optionId: optionCid,
      fileName: String(fileName || storedName),
      mimeType: parsed.mimeType,
      size: parsed.buffer.length,
      url,
    },
  });
});

/**
 * POST /api/products/:id/preview — Render preview image
 */
app.post("/api/products/:id/preview", async (req, res) => {
  const product = loadProduct(req.params.id);
  if (!product) return res.status(404).json({ error: "Product not found" });

  const { selections, textInputs, uploadInputs, uploadTransforms } = req.body;
  try {
    const pngBuffer = await renderPreview(
      req.params.id,
      selections || {},
      textInputs || {},
      uploadInputs || {},
      uploadTransforms || {}
    );
    res.set("Content-Type", "image/png");
    res.send(pngBuffer);
  } catch (error) {
    console.error("Preview error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/products/:id/workflow-trace — Debug render workflow internals
 */
app.post("/api/products/:id/workflow-trace", async (req, res) => {
  const product = loadProduct(req.params.id);
  if (!product) return res.status(404).json({ error: "Product not found" });

  const { selections, textInputs, userSelections, uploadInputs, uploadTransforms } = req.body || {};
  const userSelectedOptionIds = userSelections ? Object.keys(userSelections) : [];
  try {
    const trace = await getWorkflowTrace(
      req.params.id,
      selections || {},
      textInputs || {},
      {
        userSelectedOptionIds,
        uploadInputs: uploadInputs || {},
        uploadTransforms: uploadTransforms || {},
      }
    );
    res.json({ success: true, trace });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

function isAllowedCustomilyAssetPath(rawPath) {
  if (!rawPath || typeof rawPath !== "string") return false;
  if (/^https?:\/\//i.test(rawPath)) {
    try {
      const u = new URL(rawPath);
      return /\.?customily\.com$/i.test(u.hostname);
    } catch {
      return false;
    }
  }
  return rawPath.startsWith("/");
}

/**
 * GET /api/assets/image?path=... — Same-origin image bridge for preview canvas.
 * Reduces cross-origin flicker/failures when switching variants.
 */
app.get("/api/assets/image", async (req, res) => {
  const rawPath = decodeURIComponent(String(req.query.path || ""));
  if (!isAllowedCustomilyAssetPath(rawPath)) {
    return res.status(400).json({ success: false, error: "Invalid asset path" });
  }

  try {
    const localFile = await getImage(rawPath);
    if (!fs.existsSync(localFile)) {
      return res.status(404).json({ success: false, error: "Asset not found" });
    }
    res.set("Cache-Control", "public, max-age=604800");
    res.sendFile(localFile);
  } catch (error) {
    res.status(404).json({ success: false, error: error.message || "Asset fetch failed" });
  }
});

/**
 * GET /api/products/:id/fonts/:name — Serve imported font file for same-origin canvas FontFace
 */
app.get("/api/products/:id/fonts/:name", (req, res) => {
  const product = loadProduct(req.params.id);
  if (!product) return res.status(404).json({ error: "Product not found" });

  const requested = decodeURIComponent(req.params.name || "");
  const candidates = Object.values(product.fonts || {});
  const localPath = candidates.find((p) => path.basename(p) === requested);

  if (!localPath || !fs.existsSync(localPath)) {
    return res.status(404).json({ error: "Font not found" });
  }

  res.sendFile(localPath);
});

// Catch-all for SPA
if (process.env.NODE_ENV === "production") {
  app.get("*", (req, res) => {
    res.sendFile("index.html", { root: "dist" });
  });
}

app.listen(PORT, () => {
  console.log(`\n🚀 Product Cloner server running at http://localhost:${PORT}`);
  if (process.env.NODE_ENV !== "production") {
    console.log(`📱 Frontend dev server at http://localhost:5173\n`);
  }
});
