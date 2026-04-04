#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import https from 'https';
import crypto from 'crypto';
import { loadProduct } from './services/customily-importer.js';
import { computeVisibility } from './services/visibility-engine.js';

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
  const scriptMatches = [...html.matchAll(/<script[^>]*src=["']([^"']+)["'][^>]*>/gi)].map((m) => m[1]);

  return {
    handle: handleMatch ? handleMatch[1] : null,
    shopDomain: shopMatch ? shopMatch[1] : null,
    shopifyProductId: productIdMatch ? productIdMatch[1] : null,
    scripts: scriptMatches,
  };
}

function pickCustomilyScripts(scripts) {
  return scripts
    .map((s) => (s.startsWith('//') ? `https:${s}` : s))
    .map((s) => {
      try {
        return new URL(s, 'https://example.com').toString();
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter((s) => /customily|shopify\.script\.unified|cdn\.customily\.com/i.test(s));
}

function hash(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function snippetAround(text, pattern, radius = 140) {
  const idx = text.toLowerCase().indexOf(pattern.toLowerCase());
  if (idx === -1) return null;
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + pattern.length + radius);
  return text.slice(start, end).replace(/\s+/g, ' ');
}

function analyzeBundle(source) {
  const keys = [
    'desired_value',
    'watch_option',
    'combination_operator',
    'sort_id',
    'text_id',
    'image_id',
    '/api/settings/unified/',
    '/api/Product/GetProduct',
  ];

  const snippets = {};
  for (const key of keys) {
    const sn = snippetAround(source, key);
    if (sn) snippets[key] = sn;
  }

  return {
    size: source.length,
    sha256: hash(source),
    keywordHits: Object.fromEntries(keys.map((k) => [k, source.toLowerCase().includes(k.toLowerCase())])),
    snippets,
  };
}

function countVisibilityRisks(product) {
  const risks = {
    textHolderCollisionsByVariantCount: [],
    hiddenWithSelectionRisk: 0,
  };

  const countOption = product.options.find((o) => /number\s*of\s*daughter/i.test(String(o.label || '')));
  if (!countOption || !Array.isArray(countOption.values) || countOption.values.length === 0) {
    return risks;
  }

  for (const countVal of countOption.values) {
    const { visibleOptions, selections } = computeVisibility(product.options, { [String(countOption.id)]: String(countVal.id) });

    let collisions = 0;
    const byTextHolder = {};
    for (const opt of visibleOptions) {
      for (const fn of opt.functions || []) {
        if (fn.type !== 'text' || !fn.text_id) continue;
        const hid = String(fn.text_id);
        if (!byTextHolder[hid]) byTextHolder[hid] = [];
        byTextHolder[hid].push(String(opt.id));
      }
    }
    for (const ids of Object.values(byTextHolder)) {
      if (ids.length > 1) collisions += 1;
    }

    const hiddenSelected = product.options.filter((opt) => {
      const visible = visibleOptions.some((v) => String(v.id) === String(opt.id));
      const selected = selections[String(opt.id)] !== undefined;
      return !visible && selected;
    }).length;

    risks.textHolderCollisionsByVariantCount.push({
      countLabel: countVal.value,
      countValueId: String(countVal.id),
      collisions,
      visibleTextOptions: visibleOptions.filter((o) => (o.functions || []).some((f) => f.type === 'text')).length,
      hiddenSelected,
    });
  }

  risks.hiddenWithSelectionRisk = risks.textHolderCollisionsByVariantCount.reduce((acc, r) => acc + r.hiddenSelected, 0);
  return risks;
}

async function main() {
  const productUrl = process.argv[2];
  if (!productUrl) {
    console.log('Usage: node server/compare-customily-js-cli.js <product-url>');
    process.exit(1);
  }

  console.log(`\n[1/4] Fetching product page...`);
  const html = await fetchText(productUrl);
  const info = parsePageInfo(productUrl, html);

  if (!info.handle || !info.shopDomain || !info.shopifyProductId) {
    throw new Error('Cannot parse handle/shop/productId from product page');
  }

  const unifiedUrl = `https://sh.customily.com/api/settings/unified/${info.handle}?shop=${info.shopDomain}&productId=${info.shopifyProductId}`;
  console.log(`[2/4] Fetching unified settings...`);
  const unifiedRaw = await fetchText(unifiedUrl, {
    Referer: new URL(productUrl).origin + '/',
    Origin: new URL(productUrl).origin,
  });
  const unified = JSON.parse(unifiedRaw);

  console.log(`[3/4] Fetching Customily bundles from page scripts...`);
  const customilyScripts = pickCustomilyScripts(info.scripts);
  const bundleReports = [];
  for (const src of customilyScripts) {
    try {
      const scriptText = await fetchText(src);
      bundleReports.push({ src, ...analyzeBundle(scriptText) });
    } catch (e) {
      bundleReports.push({ src, error: e.message });
    }
  }

  console.log(`[4/4] Comparing with local visibility renderer assumptions...`);
  const localProduct = loadProduct((info.handle || '').substring(0, 60));
  const localDiagnostics = localProduct ? countVisibilityRisks(localProduct) : null;

  const allOptions = (unified.sets || []).flatMap((s) => s.options || []);
  const rawStats = {
    options: allOptions.length,
    textInputOptions: allOptions.filter((o) => String(o.type || '').toLowerCase().replace(/\s+/g, '') === 'textinput').length,
    imageOptions: allOptions.filter((o) => (o.functions || []).some((f) => f.type === 'image')).length,
    conditionedOptions: allOptions.filter((o) => (o.conditions || []).length > 0).length,
    desiredValueArrays: allOptions.reduce((acc, o) => acc + (o.conditions || []).filter((c) => Array.isArray(c.desired_value)).length, 0),
  };

  const report = {
    productUrl,
    parsed: {
      handle: info.handle,
      shopDomain: info.shopDomain,
      shopifyProductId: info.shopifyProductId,
    },
    unifiedUrl,
    unifiedStats: rawStats,
    customilyScripts,
    bundleReports,
    localProductFound: Boolean(localProduct),
    localDiagnostics,
    mismatchHypotheses: [
      'Local renderer remap text by visual order can differ from Customily text_id binding order.',
      'Local renderer normalizes text size across same line; Customily binds size per holder.',
      'Local renderer applies text y-offset and width shrink heuristics that can shift visual output.',
    ],
  };

  const outDir = path.resolve(process.cwd(), 'tmp');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `customily-logic-report-${info.handle.substring(0, 50)}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log(`\n✅ Report saved: ${outPath}`);
  console.log(`   Unified options: ${rawStats.options}, conditioned: ${rawStats.conditionedOptions}`);
  console.log(`   Customily scripts: ${customilyScripts.length}`);
  if (localDiagnostics) {
    const nonZero = localDiagnostics.textHolderCollisionsByVariantCount.filter((r) => r.collisions > 0).length;
    console.log(`   Local diagnostics: collision cases=${nonZero}/${localDiagnostics.textHolderCollisionsByVariantCount.length}`);
  } else {
    console.log('   Local diagnostics: skipped (product not imported locally yet)');
  }
}

main().catch((err) => {
  console.error(`\n❌ ${err.message}`);
  process.exit(1);
});
