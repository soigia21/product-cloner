#!/usr/bin/env node

import fs from "fs";
import path from "path";

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const cur = argv[i];
    if (!cur.startsWith("--")) continue;
    const key = cur.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function writeText(filePath, content) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content);
}

async function fetchJson(url, headers = {}, timeoutMs = 30000) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0",
      ...headers,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} at ${url}`);
  }
  return response.json();
}

async function fetchText(url, headers = {}, timeoutMs = 30000) {
  const response = await fetch(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": "Mozilla/5.0",
      ...headers,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} at ${url}`);
  }
  return response.text();
}

function extractShopDomain(html) {
  const patterns = [
    /Shopify\.shop\s*=\s*["']([^"']+)/i,
    /shop=([^&"']+\.myshopify\.com)/i,
    /"myshopify_domain"\s*:\s*"([^"]+)"/i,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

function extractShopifyProductId(html) {
  const match = html.match(/"product":\s*\{[^}]*"id"\s*:\s*(\d+)/i);
  return match?.[1] || null;
}

function sanitizeFileSegment(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function buildUnifiedUrl(handle, shopDomain, productId) {
  return `https://sh.customily.com/api/settings/unified/${encodeURIComponent(handle)}?shop=${encodeURIComponent(shopDomain)}&productId=${encodeURIComponent(productId)}`;
}

async function main() {
  const args = parseArgs(process.argv);
  const collectionUrl = String(
    args.collection || "https://macorner.co/collections/decorative-plaques"
  ).trim();
  const page = Number(args.page || 1);
  const limit = Number(args.limit || 16);
  const outRoot = path.resolve(
    process.cwd(),
    String(args.out || "tmp/reports/decorative-plaques-page1")
  );

  if (!Number.isFinite(page) || page < 1) throw new Error(`Invalid --page: ${args.page}`);
  if (!Number.isFinite(limit) || limit < 1) throw new Error(`Invalid --limit: ${args.limit}`);

  const parsed = new URL(collectionUrl);
  const collectionHandleMatch = parsed.pathname.match(/\/collections\/([^/?#]+)/i);
  if (!collectionHandleMatch?.[1]) {
    throw new Error(`Invalid collection URL: ${collectionUrl}`);
  }
  const collectionHandle = decodeURIComponent(collectionHandleMatch[1]);
  const productsJsonUrl = `${parsed.origin}/collections/${encodeURIComponent(collectionHandle)}/products.json?limit=${limit}&page=${page}`;

  console.log(`🔎 Fetching collection products: ${productsJsonUrl}`);
  const collectionJson = await fetchJson(productsJsonUrl);
  const products = Array.isArray(collectionJson?.products) ? collectionJson.products : [];
  if (products.length === 0) {
    throw new Error(`No products found at ${productsJsonUrl}`);
  }

  const rawHtmlDir = path.join(outRoot, "raw-product-page");
  const rawUnifiedDir = path.join(outRoot, "raw-unified");
  ensureDir(rawHtmlDir);
  ensureDir(rawUnifiedDir);

  const manifestEntries = [];
  for (let index = 0; index < products.length; index += 1) {
    const product = products[index];
    const handle = String(product?.handle || "").trim();
    if (!handle) continue;

    const title = String(product?.title || handle).trim();
    const productUrl = `${parsed.origin}/products/${encodeURIComponent(handle)}`;
    const safe = sanitizeFileSegment(handle) || `product_${index + 1}`;
    const htmlFile = path.join(rawHtmlDir, `${safe}.html`);
    const unifiedFile = path.join(rawUnifiedDir, `${safe}.json`);

    const entry = {
      index: index + 1,
      handle,
      title,
      productUrl,
      htmlFile: path.relative(process.cwd(), htmlFile),
      unifiedFile: path.relative(process.cwd(), unifiedFile),
      status: "pending",
      shopDomain: null,
      shopifyProductId: null,
      unifiedUrl: null,
      error: null,
    };

    try {
      const html = await fetchText(productUrl);
      writeText(htmlFile, html);

      const shopDomain = extractShopDomain(html);
      const shopifyProductId = extractShopifyProductId(html);
      if (!shopDomain || !shopifyProductId) {
        throw new Error(`Missing page info (shop=${shopDomain}, productId=${shopifyProductId})`);
      }

      const unifiedUrl = buildUnifiedUrl(handle, shopDomain, shopifyProductId);
      const unified = await fetchJson(unifiedUrl, {
        Referer: `${parsed.origin}/`,
        Origin: parsed.origin,
      });
      writeJson(unifiedFile, unified);

      entry.shopDomain = shopDomain;
      entry.shopifyProductId = shopifyProductId;
      entry.unifiedUrl = unifiedUrl;
      entry.status = "ok";
    } catch (error) {
      entry.status = "error";
      entry.error = String(error?.message || error);
    }

    manifestEntries.push(entry);
    console.log(
      `${entry.status === "ok" ? "✅" : "❌"} [${entry.index}/${products.length}] ${entry.handle}`
    );
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    source: {
      collectionUrl,
      productsJsonUrl,
      page,
      limit,
      collectionHandle,
    },
    stats: {
      total: manifestEntries.length,
      ok: manifestEntries.filter((x) => x.status === "ok").length,
      error: manifestEntries.filter((x) => x.status === "error").length,
    },
    products: manifestEntries,
  };

  const manifestPath = path.resolve(
    process.cwd(),
    String(args.manifest || "tmp/reports/decorative-plaques-page1-manifest.json")
  );
  writeJson(manifestPath, manifest);
  writeJson(path.join(outRoot, "manifest.json"), manifest);

  console.log(`\n📦 Manifest: ${path.relative(process.cwd(), manifestPath)}`);
  console.log(`🧾 Raw HTML: ${path.relative(process.cwd(), rawHtmlDir)}`);
  console.log(`🧾 Raw Unified: ${path.relative(process.cwd(), rawUnifiedDir)}`);
  console.log(`✅ Done: ${manifest.stats.ok}/${manifest.stats.total} products`);
}

main().catch((error) => {
  console.error(`\n❌ ${error?.message || error}`);
  process.exit(1);
});

