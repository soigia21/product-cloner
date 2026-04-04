#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import https from 'https';
import { normalizeOptions, loadProduct, loadDesign } from './services/customily-importer.js';
import { computeVisibility, mapSelectionsToHolders } from './services/visibility-engine.js';

function fetchText(url, headers = {}, redirects = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', ...headers } }, (res) => {
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location && redirects > 0) {
        const next = new URL(res.headers.location, url).toString();
        res.resume();
        return resolve(fetchText(next, headers, redirects - 1));
      }
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if ((res.statusCode || 500) >= 400) {
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        resolve(data);
      });
    });
    req.on('error', reject);
  });
}

function parsePageInfo(productUrl, html) {
  const handleMatch = productUrl.match(/\/products\/([^?#]+)/i);
  const shopMatch = html.match(/Shopify\.shop\s*=\s*["']([^"']+)/i) ||
    html.match(/shop=([^&"']+\.myshopify\.com)/i) ||
    html.match(/"myshopify_domain"\s*:\s*"([^"]+)"/i);
  const productIdMatch = html.match(/"product":\s*\{[^}]*"id"\s*:\s*(\d+)/i);

  return {
    handle: handleMatch ? handleMatch[1] : null,
    shopDomain: shopMatch ? shopMatch[1] : null,
    shopifyProductId: productIdMatch ? productIdMatch[1] : null,
  };
}

function compareBySortIdThenId(a, b) {
  const sa = Number.isFinite(Number(a?.sort_id)) ? Number(a.sort_id) : Number.MAX_SAFE_INTEGER;
  const sb = Number.isFinite(Number(b?.sort_id)) ? Number(b.sort_id) : Number.MAX_SAFE_INTEGER;
  if (sa !== sb) return sa - sb;
  const ia = Number.isFinite(Number(a?.id)) ? Number(a.id) : Number.MAX_SAFE_INTEGER;
  const ib = Number.isFinite(Number(b?.id)) ? Number(b.id) : Number.MAX_SAFE_INTEGER;
  if (ia !== ib) return ia - ib;
  return String(a?.id ?? '').localeCompare(String(b?.id ?? ''));
}

function detectCountOption(options) {
  return options.find((o) => /number\s*of\s*(daughter|children|kid|son|people)/i.test(String(o.label || '')))
    || options.find((o) => (o.functions || []).some((f) => f.type === 'product'));
}

function textVisibilityMatrix(options) {
  const countOpt = detectCountOption(options);
  if (!countOpt || !Array.isArray(countOpt.values) || countOpt.values.length === 0) {
    return [];
  }

  const rows = [];
  for (const v of [...countOpt.values].sort(compareBySortIdThenId)) {
    const seed = { [String(countOpt.id)]: String(v.id) };
    const { visibleOptions, selections } = computeVisibility(options, seed);
    const visibleText = visibleOptions
      .filter((o) => String(o.type || '').toLowerCase().replace(/\s+/g, '') === 'textinput')
      .map((o) => ({ id: String(o.id), label: o.label, sort: o.sort_id }));

    const byHolder = {};
    const { textMappings } = mapSelectionsToHolders(visibleOptions, selections, {});
    for (const hid of Object.keys(textMappings)) {
      byHolder[hid] = textMappings[hid];
    }

    rows.push({
      countLabel: v.value,
      countValueId: String(v.id),
      visibleTextCount: visibleText.length,
      visibleTextOptions: visibleText,
      textHolderCount: Object.keys(byHolder).length,
    });
  }

  return rows;
}

function findOptionMergeRisks(rawOptions, normalized) {
  const rawById = new Map();
  for (const o of rawOptions) rawById.set(String(o.id), o);

  const aliasEntries = Object.entries(normalized.optionAliases || {});
  const risky = [];

  for (const [fromId, toId] of aliasEntries) {
    const from = rawById.get(String(fromId));
    const to = rawById.get(String(toId));
    if (!from || !to) continue;

    const fromSig = (from.functions || []).map((f) => `${f.type}:${f.image_id || ''}:${f.text_id || ''}`).sort().join('|');
    const toSig = (to.functions || []).map((f) => `${f.type}:${f.image_id || ''}:${f.text_id || ''}`).sort().join('|');

    const conditionMismatch = JSON.stringify(from.conditions || []) !== JSON.stringify(to.conditions || []);

    if (conditionMismatch || fromSig !== toSig || String(from.type) !== String(to.type)) {
      risky.push({
        fromId: String(fromId),
        toId: String(toId),
        fromLabel: from.label,
        toLabel: to.label,
        fromType: from.type,
        toType: to.type,
        conditionMismatch,
        functionSignatureMismatch: fromSig !== toSig,
      });
    }
  }

  return risky;
}

function detectTransformGap(design) {
  const holders = design?.preview?.imagePlaceHoldersPreview || [];
  const total = holders.length;

  const stats = {
    total,
    withRotation: holders.filter((h) => Number(h.rotation || 0) !== 0).length,
    withSkew: holders.filter((h) => Number(h.skewX || 0) !== 0 || Number(h.skewY || 0) !== 0).length,
    withFlip: holders.filter((h) => Boolean(h.flipX) || Boolean(h.flipY)).length,
    withClipPath: holders.filter((h) => Boolean(h.clipPath)).length,
    withMaskPath: holders.filter((h) => Boolean(h.maskPath)).length,
    withPerspective: holders.filter((h) => Boolean(h.enablePerspective) || Boolean(h.perspectiveCoords)).length,
  };

  return {
    stats,
    rendererCurrentlySupports: {
      center: true,
      size: true,
      rotation: true,
      opacity: true,
      skew: false,
      flip: false,
      clipPath: false,
      maskPath: false,
      perspective: false,
    },
  };
}

async function main() {
  const productUrl = process.argv[2];
  if (!productUrl) {
    console.log('Usage: node server/workflow-diff-cli.js <product-url>');
    process.exit(1);
  }

  console.log('\n[1/5] Fetching product page + unified settings...');
  const html = await fetchText(productUrl);
  const info = parsePageInfo(productUrl, html);

  if (!info.handle || !info.shopDomain || !info.shopifyProductId) {
    throw new Error('Cannot parse handle/shop/productId from product page');
  }

  const unifiedUrl = `https://sh.customily.com/api/settings/unified/${info.handle}?shop=${info.shopDomain}&productId=${info.shopifyProductId}`;
  const unifiedRaw = await fetchText(unifiedUrl, {
    Referer: new URL(productUrl).origin + '/',
    Origin: new URL(productUrl).origin,
  });
  const unified = JSON.parse(unifiedRaw);
  const rawOptions = (unified.sets || []).flatMap((s) => s.options || []);

  console.log('[2/5] Running local normalize pipeline...');
  const normalized = normalizeOptions(rawOptions, null);

  console.log('[3/5] Running visibility matrix (raw vs normalized)...');
  const rawMatrix = textVisibilityMatrix(rawOptions);
  const normMatrix = textVisibilityMatrix(normalized.options);

  console.log('[4/5] Loading imported product/design for render workflow checks...');
  const localProductId = info.handle.substring(0, 60);
  const localProduct = loadProduct(localProductId);
  let transformGap = null;
  if (localProduct) {
    const firstDesign = Object.values(localProduct.variantDesigns || {})[0];
    const design = firstDesign ? loadDesign(localProductId, firstDesign) : null;
    if (design) transformGap = detectTransformGap(design);
  }

  console.log('[5/5] Building report...');
  const riskyAliases = findOptionMergeRisks(rawOptions, normalized);

  const report = {
    productUrl,
    parsed: info,
    unifiedStats: {
      rawOptions: rawOptions.length,
      normalizedOptions: normalized.options.length,
      removedByNormalize: rawOptions.length - normalized.options.length,
      aliases: Object.keys(normalized.optionAliases || {}).length,
    },
    keyDiffs: {
      riskyAliasMappings: riskyAliases,
      rawTextVisibilityMatrix: rawMatrix,
      normalizedTextVisibilityMatrix: normMatrix,
      transformGap,
    },
    suspectFiles: [
      {
        file: 'server/services/customily-importer.js',
        area: 'normalizeOptions() merge of unconditional duplicates + alias remap',
        reason: 'Can collapse options and alter condition graph / mapping identity.',
      },
      {
        file: 'server/services/visibility-engine.js',
        area: 'shouldAutoDefault() and recursive visibility cascade',
        reason: 'May auto-select too aggressively, causing options to appear before user intent.',
      },
      {
        file: 'server/services/preview-renderer.js',
        area: 'image draw transform support',
        reason: 'Currently does not apply skew/flip/clip/mask/perspective fields from design holders.',
      },
    ],
  };

  const outDir = path.resolve(process.cwd(), 'tmp');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `workflow-diff-${info.handle.substring(0, 50)}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log(`\n✅ Report saved: ${outPath}`);
  console.log(`   Raw options: ${report.unifiedStats.rawOptions}`);
  console.log(`   Normalized options: ${report.unifiedStats.normalizedOptions}`);
  console.log(`   Removed by normalize: ${report.unifiedStats.removedByNormalize}`);
  console.log(`   Risky aliases: ${riskyAliases.length}`);
  if (transformGap) {
    console.log(`   Transform gap: skew=${transformGap.stats.withSkew}, flip=${transformGap.stats.withFlip}, clip=${transformGap.stats.withClipPath}, mask=${transformGap.stats.withMaskPath}`);
  } else {
    console.log('   Transform gap: skipped (product not imported locally yet)');
  }
}

main().catch((err) => {
  console.error(`\n❌ ${err.message}`);
  process.exit(1);
});
