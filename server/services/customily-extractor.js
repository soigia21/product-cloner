/**
 * Customily Asset Extractor
 * 
 * Extract toàn bộ assets (hình ảnh, vị trí, config) từ Customily
 * để dùng cho app riêng.
 * 
 * 2 API chính:
 * 1. GetProduct API: layers, positions, sizes, zIndex, dynamic images
 * 2. Unified Settings API: form options, swatch thumbnails, conditions
 */

import fs from "fs";
import path from "path";
import https from "https";

const CDN_BASE = "https://cdn.customily.com";
const APP_BASE = "https://app.customily.com";
const SH_BASE = "https://sh.customily.com";

// ============================================
// HELPERS
// ============================================

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`JSON parse error for ${url}: ${e.message}`));
        }
      });
      res.on("error", reject);
    }).on("error", reject);
  });
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    let fullUrl = url.startsWith("http") ? url : `${CDN_BASE}${url}`;
    // Strip /Content/ prefix - CDN uses paths without it
    fullUrl = fullUrl.replace(/\/Content\//g, "/");
    const dir = path.dirname(destPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    https.get(fullUrl, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${fullUrl}`));
      }
      const file = fs.createWriteStream(destPath);
      res.pipe(file);
      file.on("finish", () => {
        file.close();
        resolve(destPath);
      });
      file.on("error", (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    }).on("error", reject);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================
// STEP 1: Extract info from page HTML
// ============================================

async function extractProductIdFromPage(productUrl) {
  const html = await new Promise((resolve, reject) => {
    https.get(productUrl, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      let data = "";
      if (res.statusCode === 301 || res.statusCode === 302) {
        return https.get(res.headers.location, { headers: { "User-Agent": "Mozilla/5.0" } }, (res2) => {
          res2.on("data", (chunk) => (data += chunk));
          res2.on("end", () => resolve(data));
        });
      }
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data));
      res.on("error", reject);
    }).on("error", reject);
  });

  const result = {
    customilyProductId: null,
    shopDomain: null,
    shopifyProductId: null,
    productHandle: null,
  };

  // Extract product handle from URL
  const handleMatch = productUrl.match(/\/products\/([^?#]+)/);
  if (handleMatch) result.productHandle = handleMatch[1];

  // Find Customily product ID in page source (may not be present in static HTML)
  const idPatterns = [
    /customily[^"]*productId[=:]["']?([a-f0-9-]{36})/i,
    /GetProduct\?productId=([a-f0-9-]{36})/i,
    /"productId"\s*:\s*"([a-f0-9-]{36})"/i,
  ];
  for (const pattern of idPatterns) {
    const match = html.match(pattern);
    if (match) {
      result.customilyProductId = match[1];
      break;
    }
  }

  // Find shop domain
  const shopPatterns = [
    /Shopify\.shop\s*=\s*["']([^"']+)/,
    /shop=([^&"']+\.myshopify\.com)/,
    /"myshopify_domain"\s*:\s*"([^"]+)"/,
  ];
  for (const pattern of shopPatterns) {
    const match = html.match(pattern);
    if (match) {
      result.shopDomain = match[1];
      break;
    }
  }

  // Find Shopify product ID (numeric)
  const spidMatch = html.match(/"product":\s*\{[^}]*"id"\s*:\s*(\d+)/);
  if (spidMatch) result.shopifyProductId = spidMatch[1];

  // Alternative: search for sh.customily.com unified URL
  const unifiedMatch = html.match(/sh\.customily\.com\/api\/settings\/unified\/[^"'\s?]+\?shop=([^&"']+)&productId=(\d+)/);
  if (unifiedMatch) {
    result.shopDomain = unifiedMatch[1];
    result.shopifyProductId = unifiedMatch[2];
  }

  return result;
}

// ============================================
// STEP 2: Fetch Customily APIs
// ============================================

async function fetchProductConfig(customilyProductId) {
  const url = `${APP_BASE}/api/Product/GetProduct?productId=${customilyProductId}`;
  console.log(`  📥 Fetching product config: ${url}`);
  return fetchJSON(url);
}

async function fetchUnifiedSettings(productHandle, shopDomain, shopifyProductId) {
  const url = `${SH_BASE}/api/settings/unified/${productHandle}?shop=${shopDomain}&productId=${shopifyProductId}`;
  console.log(`  📥 Fetching unified settings: ${url}`);
  return fetchJSON(url);
}

// ============================================
// STEP 3: Parse & Extract All Assets
// ============================================

function parseProductLayers(productConfig) {
  const preview = productConfig.preview;
  const layers = {
    canvas: { width: preview.width, height: preview.height, bgColor: preview.bgColor },
    textLayers: [],
    imageLayers: [],
    fonts: [],
  };

  for (const text of preview.textsPreview || []) {
    const fontUrl = text.fontPath ? `${CDN_BASE}${text.fontPath}` : null;
    if (fontUrl && !layers.fonts.includes(fontUrl)) layers.fonts.push(fontUrl);

    layers.textLayers.push({
      id: text.id, uuid: text.uuid,
      centerX: text.centerX, centerY: text.centerY,
      width: text.width, height: text.height,
      rotation: text.rotation, zIndex: text.zIndex,
      color: text.color, fontPath: text.fontPath, fontUrl,
      fontSize: { min: text.minSizePx, max: text.maxSizePx },
      textAlign: text.textAlign, multiline: text.multiline,
      caps: text.caps, visible: text.visible,
    });
  }

  for (const img of preview.imagePlaceHoldersPreview || []) {
    const dynamicImages = [];
    if (img.dynamicImagesPath) {
      try {
        const parsed = JSON.parse(img.dynamicImagesPath);
        for (const [idx, imgPath] of parsed) {
          dynamicImages.push({ index: idx, path: imgPath, url: `${CDN_BASE}${imgPath}` });
        }
      } catch (e) {
        const matches = img.dynamicImagesPath.matchAll(/\[(\d+),"([^"]+)"\]/g);
        for (const m of matches) {
          dynamicImages.push({ index: parseInt(m[1]), path: m[2], url: `${CDN_BASE}${m[2]}` });
        }
      }
    }

    layers.imageLayers.push({
      id: img.id, uuid: img.uuid,
      centerX: img.centerX, centerY: img.centerY,
      width: img.width, height: img.height,
      rotation: img.rotation, zIndex: img.zIndex,
      opacity: img.opacity,
      staticImage: img.imagePath ? `${CDN_BASE}${img.imagePath}` : null,
      dynamicImages,
    });
  }

  layers.imageLayers.sort((a, b) => a.zIndex - b.zIndex);
  layers.textLayers.sort((a, b) => a.zIndex - b.zIndex);
  return layers;
}

function parseOptionsConfig(unifiedSettings) {
  const sets = unifiedSettings.sets || [];
  const options = [];
  const swatchImages = [];

  for (const set of sets) {
    for (const opt of set.options || []) {
      const optionData = {
        id: opt.id, label: opt.label, type: opt.type,
        required: opt.required || false, values: [],
        conditions: opt.conditions || [],
        linkedLayerIds: opt.linkedLayerIds || [],
      };

      for (const val of opt.values || []) {
        const valueData = {
          id: val.id, value: val.value, label: val.label || val.value,
          sortId: val.sort_id, selected: val.selected || false,
          imageId: val.image_id, productId: val.product_id || null,
          thumbnailUrl: val.thumb_image || null, bgColor: val.bg_color || null,
        };

        if (val.thumb_image) {
          swatchImages.push({ optionLabel: opt.label, valueLabel: val.value, url: val.thumb_image });
        }

        optionData.values.push(valueData);
      }
      options.push(optionData);
    }
  }

  return { options, swatchImages, settings: unifiedSettings.settings || {}, productConfig: unifiedSettings.productConfig || {} };
}

// ============================================
// STEP 4: Download All Assets
// ============================================

async function downloadAllAssets(layers, optionsData, outputDir) {
  const assetsDir = path.join(outputDir, "assets");
  const layersDir = path.join(assetsDir, "layers");
  const swatchesDir = path.join(assetsDir, "swatches");
  const fontsDir = path.join(assetsDir, "fonts");

  for (const dir of [layersDir, swatchesDir, fontsDir]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  const downloaded = { layers: 0, swatches: 0, fonts: 0, errors: [] };

  // Download layer images
  console.log("\n  🖼️  Downloading layer images...");
  for (const layer of layers.imageLayers) {
    if (layer.staticImage) {
      const fname = `layer_${layer.id}_static.png`;
      try {
        await downloadFile(layer.staticImage, path.join(layersDir, fname));
        downloaded.layers++;
        console.log(`    ✅ ${fname}`);
      } catch (e) {
        downloaded.errors.push(`Layer ${layer.id} static: ${e.message}`);
      }
      await sleep(100);
    }

    for (const dimg of layer.dynamicImages) {
      const fname = `layer_${layer.id}_dynamic_${dimg.index}.png`;
      try {
        await downloadFile(dimg.url, path.join(layersDir, fname));
        downloaded.layers++;
        console.log(`    ✅ ${fname}`);
      } catch (e) {
        downloaded.errors.push(`Layer ${layer.id} dynamic ${dimg.index}: ${e.message}`);
      }
      await sleep(100);
    }
  }

  // Download swatch thumbnails
  console.log("\n  🎨 Downloading swatch thumbnails...");
  const seenSwatchUrls = new Set();
  for (const swatch of optionsData.swatchImages) {
    if (seenSwatchUrls.has(swatch.url)) continue;
    seenSwatchUrls.add(swatch.url);

    const safeLabel = swatch.optionLabel.replace(/[^a-zA-Z0-9]/g, "_").substring(0, 30);
    const safeValue = swatch.valueLabel.replace(/[^a-zA-Z0-9]/g, "_").substring(0, 20);
    const ext = swatch.url.match(/\.(jpg|png|webp|gif)/i)?.[1] || "jpg";
    const fname = `${safeLabel}_${safeValue}.${ext}`;

    try {
      await downloadFile(swatch.url, path.join(swatchesDir, fname));
      downloaded.swatches++;
    } catch (e) {
      downloaded.errors.push(`Swatch ${swatch.optionLabel}/${swatch.valueLabel}: ${e.message}`);
    }
    await sleep(50);
  }
  console.log(`    ✅ ${downloaded.swatches} swatches downloaded`);

  // Download fonts
  console.log("\n  🔤 Downloading fonts...");
  for (const fontUrl of layers.fonts) {
    const fname = path.basename(fontUrl);
    try {
      await downloadFile(fontUrl, path.join(fontsDir, fname));
      downloaded.fonts++;
      console.log(`    ✅ ${fname}`);
    } catch (e) {
      downloaded.errors.push(`Font ${fname}: ${e.message}`);
    }
    await sleep(100);
  }

  return downloaded;
}

// ============================================
// MAIN EXPORT: Extract Everything
// ============================================

export async function extractCustomilyProduct(productUrl, outputDir) {
  console.log(`\n🔍 Customily Asset Extractor`);
  console.log(`   URL: ${productUrl}`);
  console.log(`   Output: ${outputDir}\n`);

  // Step 1: Extract IDs from page HTML
  console.log("📌 Step 1: Extracting product info from page...");
  const pageInfo = await extractProductIdFromPage(productUrl);
  console.log(`   Shop: ${pageInfo.shopDomain}`);
  console.log(`   Shopify Product ID: ${pageInfo.shopifyProductId}`);
  console.log(`   Handle: ${pageInfo.productHandle}`);

  // Step 2: Fetch Unified Settings first (contains customilyProductId inside values)
  console.log("\n📦 Step 2: Fetching Customily configuration...");

  let unifiedSettings = null;
  if (pageInfo.productHandle && pageInfo.shopDomain && pageInfo.shopifyProductId) {
    unifiedSettings = await fetchUnifiedSettings(
      pageInfo.productHandle,
      pageInfo.shopDomain,
      pageInfo.shopifyProductId
    );
  }

  // Extract Customily Product ID from unified settings option values
  let customilyProductId = pageInfo.customilyProductId;
  if (!customilyProductId && unifiedSettings) {
    const sets = unifiedSettings.sets || [];
    for (const set of sets) {
      for (const opt of set.options || []) {
        for (const val of opt.values || []) {
          if (val.product_id && /^[a-f0-9-]{36}$/.test(val.product_id)) {
            customilyProductId = val.product_id;
            break;
          }
        }
        if (customilyProductId) break;
      }
      if (customilyProductId) break;
    }
  }

  // Fallback: search full JSON string
  if (!customilyProductId && unifiedSettings) {
    const jsonStr = JSON.stringify(unifiedSettings);
    const match = jsonStr.match(/"product_id"\s*:\s*"([a-f0-9-]{36})"/);
    if (match) customilyProductId = match[1];
  }

  console.log(`   Customily Product ID: ${customilyProductId}`);

  if (!customilyProductId) {
    throw new Error("Không tìm thấy Customily Product ID. Trang này có thể không sử dụng Customily.");
  }

  // Fetch GetProduct API for layer data
  const productConfig = await fetchProductConfig(customilyProductId);

  // Step 3: Parse data
  console.log("\n🔧 Step 3: Parsing layers and options...");
  const layers = parseProductLayers(productConfig);
  console.log(`   📐 Canvas: ${layers.canvas.width}x${layers.canvas.height}`);
  console.log(`   🖼️  Image layers: ${layers.imageLayers.length}`);
  console.log(`   📝 Text layers: ${layers.textLayers.length}`);
  console.log(`   🔤 Fonts: ${layers.fonts.length}`);

  let optionsData = { options: [], swatchImages: [], settings: {}, productConfig: {} };
  if (unifiedSettings) {
    optionsData = parseOptionsConfig(unifiedSettings);
    console.log(`   ⚙️  Options: ${optionsData.options.length}`);
    console.log(`   🎨 Swatch images: ${optionsData.swatchImages.length}`);
  }

  // Ensure output directory
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  // Step 4: Download assets
  console.log("\n⬇️  Step 4: Downloading assets...");
  const downloadResult = await downloadAllAssets(layers, optionsData, outputDir);

  // Step 5: Save configuration files
  console.log("\n💾 Step 5: Saving configuration...");

  fs.writeFileSync(path.join(outputDir, "raw_product_config.json"), JSON.stringify(productConfig, null, 2));
  if (unifiedSettings) {
    fs.writeFileSync(path.join(outputDir, "raw_unified_settings.json"), JSON.stringify(unifiedSettings, null, 2));
  }

  // Save parsed, clean config for app use
  const appConfig = {
    productUrl,
    customilyProductId,
    canvas: layers.canvas,
    textLayers: layers.textLayers,
    imageLayers: layers.imageLayers.map((l) => ({
      ...l,
      dynamicImages: l.dynamicImages.map((d) => ({
        ...d,
        localPath: `assets/layers/layer_${l.id}_dynamic_${d.index}.png`,
      })),
      staticLocalPath: l.staticImage ? `assets/layers/layer_${l.id}_static.png` : null,
    })),
    options: optionsData.options,
    fonts: layers.fonts.map((url) => ({
      url,
      localPath: `assets/fonts/${path.basename(url)}`,
    })),
  };

  fs.writeFileSync(path.join(outputDir, "app_config.json"), JSON.stringify(appConfig, null, 2));

  // Summary
  const summary = {
    productUrl,
    customilyProductId,
    canvas: layers.canvas,
    layersCount: layers.imageLayers.length,
    textLayersCount: layers.textLayers.length,
    optionsCount: optionsData.options.length,
    downloaded: downloadResult,
    outputDir,
    files: {
      appConfig: "app_config.json",
      rawProductConfig: "raw_product_config.json",
      rawUnifiedSettings: unifiedSettings ? "raw_unified_settings.json" : null,
      assetsDir: "assets/",
    },
  };

  fs.writeFileSync(path.join(outputDir, "extraction_summary.json"), JSON.stringify(summary, null, 2));

  console.log(`\n✅ Extraction complete!`);
  console.log(`   Layers downloaded: ${downloadResult.layers}`);
  console.log(`   Swatches downloaded: ${downloadResult.swatches}`);
  console.log(`   Fonts downloaded: ${downloadResult.fonts}`);
  if (downloadResult.errors.length > 0) {
    console.log(`   ⚠️  Errors: ${downloadResult.errors.length}`);
    downloadResult.errors.forEach((e) => console.log(`      - ${e}`));
  }
  console.log(`   📁 Output: ${outputDir}`);

  return summary;
}
