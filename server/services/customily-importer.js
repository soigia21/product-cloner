/**
 * Customily Importer — Import pipeline for Customily products
 * Per Blueprint §10
 * 
 * Flow:
 * 1. Fetch page HTML → extract shop domain, Shopify product ID, handle
 * 2. Fetch unified JSON → extract options, conditions, values
 * 3. Find option with functions[0].type === "product" → get all product_id UUIDs
 * 4. Fetch GetProduct for EACH UUID → save design JSON
 * 5. Check holders with imageLibraryId → fetch Library API → populate DIP
 * 6. Download & cache fonts
 * 7. Save everything to data/{productId}/
 */

import fs from "fs";
import path from "path";
import https from "https";
import { fetchJSON, getFont } from "./image-cache.js";

const DATA_DIR = path.resolve(process.cwd(), "data");
const APP_BASE = "https://app.customily.com";
const SH_BASE = "https://sh.customily.com";

function resolveProductFile(productId) {
  return path.join(DATA_DIR, "products", String(productId), "product.json");
}

function isUuid(value) {
  return /^[a-f0-9-]{36}$/i.test(String(value || ""));
}

function normalizeUuid(value) {
  const v = String(value || "").trim();
  return isUuid(v) ? v : null;
}

function normalizeHandleForId(handle) {
  const raw = String(handle || "product").toLowerCase();
  const normalized = raw
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || "product";
}

function buildImportedProductId(handle, shopifyProductId) {
  const safeHandle = normalizeHandleForId(handle).slice(0, 80);
  const safePid = String(shopifyProductId || "").replace(/[^0-9]/g, "");
  if (safePid) return `${safeHandle}-${safePid}`;
  return safeHandle;
}

function compareBySortIdThenId(a, b) {
  const sa = Number.isFinite(Number(a?.sort_id)) ? Number(a.sort_id) : Number.MAX_SAFE_INTEGER;
  const sb = Number.isFinite(Number(b?.sort_id)) ? Number(b.sort_id) : Number.MAX_SAFE_INTEGER;
  if (sa !== sb) return sa - sb;

  const ia = Number.isFinite(Number(a?.id)) ? Number(a.id) : Number.MAX_SAFE_INTEGER;
  const ib = Number.isFinite(Number(b?.id)) ? Number(b.id) : Number.MAX_SAFE_INTEGER;
  if (ia !== ib) return ia - ib;

  return String(a?.id ?? "").localeCompare(String(b?.id ?? ""));
}

function optionKeyForUnconditionalMerge(opt) {
  const label = String(opt?.label || "").trim().toLowerCase();
  const type = String(opt?.type || "");
  const fnSig = (opt.functions || [])
    .map((fn) => `${fn.type || ""}:${fn.image_id || ""}:${fn.text_id || ""}`)
    .sort()
    .join("|");
  return `${label}|${type}|${fnSig}`;
}

function normalizeDesiredValue(rawDesired) {
  const arr = Array.isArray(rawDesired) ? rawDesired : [rawDesired];
  return arr.filter((v) => v !== undefined && v !== null && String(v) !== "");
}

function evaluateVariationConditions(conditions = [], conditionMatches) {
  if (!Array.isArray(conditions) || conditions.length === 0) return true;
  let acc = Boolean(conditionMatches(conditions[0]));
  for (let i = 1; i < conditions.length; i += 1) {
    const cond = conditions[i];
    const current = Boolean(conditionMatches(cond));
    const op = String(cond?.combination_operator || "and").toLowerCase();
    if (op === "or") acc = acc || current;
    else acc = acc && current;
  }
  return acc;
}

function dedupeConditions(conditions, aliasMap = {}) {
  const out = [];
  const seen = new Set();

  for (const cond of conditions || []) {
    const originalWatch = cond.watch_option;
    const mappedWatch = aliasMap[String(originalWatch)] ?? String(originalWatch);
    const watch_option =
      typeof originalWatch === "number" && Number.isFinite(Number(mappedWatch))
        ? Number(mappedWatch)
        : mappedWatch;

    const desired_value = normalizeDesiredValue(cond.desired_value);
    if (desired_value.length === 0) continue;

    const action = cond.action || "show";
    const combination_operator = cond.combination_operator || "or";
    const key = `${watch_option}|${action}|${combination_operator}|${desired_value.map(String).join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      ...cond,
      watch_option,
      desired_value,
      action,
      combination_operator,
    });
  }

  return out;
}

function chooseCanonicalOption(group, variantDesigns = null) {
  const variantsSet = variantDesigns ? new Set(Object.values(variantDesigns)) : null;
  const ranked = [...group].sort((a, b) => {
    if (variantsSet && (a.functions || []).some((fn) => fn.type === "product")) {
      const aMatch = (a.values || []).filter((v) => variantsSet.has(v.product_id)).length;
      const bMatch = (b.values || []).filter((v) => variantsSet.has(v.product_id)).length;
      if (aMatch !== bMatch) return bMatch - aMatch;
    }
    return compareBySortIdThenId(a, b);
  });
  return ranked[0];
}

function mergeOptionValues(canonical, duplicate) {
  canonical.sort_id = Math.min(
    Number.isFinite(Number(canonical.sort_id)) ? Number(canonical.sort_id) : Number.MAX_SAFE_INTEGER,
    Number.isFinite(Number(duplicate.sort_id)) ? Number(duplicate.sort_id) : Number.MAX_SAFE_INTEGER
  );

  const byId = new Map((canonical.values || []).map((v) => [String(v.id), { ...v }]));
  for (const v of duplicate.values || []) {
    const key = String(v.id);
    if (!byId.has(key)) {
      byId.set(key, { ...v });
      continue;
    }
    const existing = byId.get(key);
    byId.set(key, {
      ...existing,
      product_id: existing.product_id || v.product_id,
      // Selection default is finalized later via consensus across duplicate copies.
      selected: Boolean(existing.selected || v.selected),
    });
  }
  canonical.values = [...byId.values()].sort(compareBySortIdThenId);
}

function mergeOptionFunctions(canonical = [], extra = []) {
  const merged = new Map();
  for (const fn of [...canonical, ...extra]) {
    const key = `${fn?.type || ""}|${fn?.image_id || ""}|${fn?.text_id || ""}`;
    if (!merged.has(key)) merged.set(key, fn);
  }
  return [...merged.values()];
}

function inferAutoDefaultMode(opt) {
  const values = opt?.values || [];
  const type = String(opt?.type || "").toLowerCase().replace(/\s+/g, "");
  const conditioned = Boolean(opt?.conditions && opt.conditions.length > 0);
  const hasSelected = values.some((v) => Boolean(v.selected));
  const isProduct = (opt?.functions || []).some((fn) => fn.type === "product");
  const hasImageBinding = (opt?.functions || []).some((fn) => fn.type === "image" && fn.image_id);

  if (isProduct) return "first";
  if (values.length === 1) return "single";
  if (hasSelected) return "selected";

  if (conditioned) {
    // Keep deterministic image preview options (e.g. quote/title) while
    // leaving navigation dropdowns (person/gender/hair style) for user choice.
    if (opt?.required === true && type === "dropdown" && hasImageBinding) return "first";
    return "none";
  }

  // For unconditioned options without explicit selected=true,
  // avoid forcing first value because Customily often waits for user selection.
  return "none";
}

function findProductVariation(productConfig = {}) {
  return (productConfig?.variations || []).find((variation) =>
    (variation?.functions || []).some((fn) => String(fn?.type || "").toLowerCase() === "product")
  ) || null;
}

function extractVariantDesignsFromProductConfig(productConfig = {}) {
  const out = {};

  const pushValues = (values = []) => {
    for (const val of values) {
      const uuid = normalizeUuid(val?.product_id);
      if (!uuid) continue;
      const key = String(val?.value ?? val?.id ?? `variant_${Object.keys(out).length + 1}`);
      if (!out[key]) out[key] = uuid;
    }
  };

  const productVariation = findProductVariation(productConfig);
  if (productVariation) {
    pushValues(productVariation.values || []);
  }

  if (Object.keys(out).length === 0) {
    for (const variation of productConfig?.variations || []) {
      pushValues(variation.values || []);
    }
  }

  return out;
}

function resolveDefaultDesignUUID({ productConfig = {}, shopifyVariantId = null, variantDesigns = {} }) {
  const fromInitial = normalizeUuid(productConfig?.initial_product_id);
  if (fromInitial) return fromInitial;

  const productVariation = findProductVariation(productConfig);
  if (productVariation && shopifyVariantId) {
    const confVariant = (productConfig?.conf_variants || []).find(
      (variant) => String(variant?.id) === String(shopifyVariantId)
    );

    if (confVariant) {
      const optionKey = `option${productVariation.position}`;
      const selectedVariationValue = confVariant?.[optionKey];
      const matchedValue = (productVariation.values || []).find(
        (value) => String(value?.value) === String(selectedVariationValue)
      );
      const fromVariantMatch = normalizeUuid(matchedValue?.product_id);
      if (fromVariantMatch) return fromVariantMatch;
    }
  }

  const fromMap = Object.values(variantDesigns)
    .map((uuid) => normalizeUuid(uuid))
    .filter(Boolean);
  if (fromMap.length > 0) return fromMap[0];

  const fromConfigMap = Object.values(extractVariantDesignsFromProductConfig(productConfig))
    .map((uuid) => normalizeUuid(uuid))
    .filter(Boolean);
  return fromConfigMap[0] || null;
}

export function normalizeOptions(rawOptions = [], variantDesigns = null) {
  // Track selected defaults per raw duplicate copy:
  // optionId -> [selectedValueIdOrEmpty, ...]
  const selectedVotesByOptionId = new Map();

  function recordSelectedVote(opt) {
    const optionId = String(opt?.id);
    if (!selectedVotesByOptionId.has(optionId)) selectedVotesByOptionId.set(optionId, []);
    const selectedValues = (opt?.values || []).filter((v) => Boolean(v.selected)).map((v) => String(v.id));
    // Keep deterministic single vote per copy; empty string means "no explicit selected".
    selectedVotesByOptionId.get(optionId).push(selectedValues[0] || "");
  }

  const prepared = (rawOptions || []).map((opt) => ({
    ...opt,
    values: [...(opt.values || [])].sort(compareBySortIdThenId),
    conditions: dedupeConditions(opt.conditions || []),
  }));
  for (const opt of prepared) recordSelectedVote(opt);

  // Pass 1: merge exact duplicate logical options by option ID.
  // Some products return duplicated options across multiple sets.
  const byId = new Map();
  for (const opt of prepared) {
    const key = String(opt.id);
    if (!byId.has(key)) {
      byId.set(key, opt);
      continue;
    }

    const canonical = byId.get(key);
    mergeOptionValues(canonical, opt);
    canonical.sort_id = Math.min(
      Number.isFinite(Number(canonical.sort_id)) ? Number(canonical.sort_id) : Number.MAX_SAFE_INTEGER,
      Number.isFinite(Number(opt.sort_id)) ? Number(opt.sort_id) : Number.MAX_SAFE_INTEGER
    );
    canonical.functions = mergeOptionFunctions(canonical.functions || [], opt.functions || []);
    canonical.conditions = dedupeConditions([...(canonical.conditions || []), ...(opt.conditions || [])]);
    canonical.hide_visually = Boolean(canonical.hide_visually || opt.hide_visually);
    canonical.required = canonical.required ?? opt.required;
    canonical.checked = canonical.checked ?? opt.checked;
  }
  const mergedById = [...byId.values()];

  // Apply selected-default consensus after duplicate merge.
  // Prefer the most frequent selected value across duplicate copies, so products
  // with repeated sets still keep a practical default while avoiding random OR merges.
  for (const opt of mergedById) {
    const votes = selectedVotesByOptionId.get(String(opt.id)) || [];
    if (votes.length <= 1) continue;

    const nonEmptyVotes = votes.filter((v) => String(v) !== "");
    let selectedId = null;
    if (nonEmptyVotes.length > 0) {
      const counts = new Map();
      for (const vote of nonEmptyVotes) {
        counts.set(vote, (counts.get(vote) || 0) + 1);
      }
      const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
      selectedId = ranked[0]?.[0] || null;
    }

    opt.values = (opt.values || []).map((v) => ({
      ...v,
      selected: selectedId ? String(v.id) === selectedId : false,
    }));
  }

  const aliasMap = {};
  const removedOptionRefs = new Set();
  // IMPORTANT:
  // Do not merge different option IDs by signature.
  // Even if shape/label/functions look equal, Customily can still rely on distinct IDs
  // for condition graphs and set-scoped defaults. We only merge true duplicates (same ID).

  const deduped = mergedById
    .filter((opt) => !removedOptionRefs.has(opt))
    .map((opt) => ({
      ...opt,
      values: [...(opt.values || [])].sort(compareBySortIdThenId),
      conditions: dedupeConditions(opt.conditions || [], aliasMap),
      auto_default_mode: inferAutoDefaultMode(opt),
    }))
    .sort(compareBySortIdThenId);

  return { options: deduped, optionAliases: aliasMap };
}

/**
 * Fetch page HTML and extract Customily info
 */
async function extractPageInfo(productUrl) {
  const html = await new Promise((resolve, reject) => {
    https.get(productUrl, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      let data = "";
      if (res.statusCode === 301 || res.statusCode === 302) {
        return https.get(res.headers.location, { headers: { "User-Agent": "Mozilla/5.0" } }, (r2) => {
          r2.on("data", (c) => (data += c));
          r2.on("end", () => resolve(data));
        });
      }
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(data));
      res.on("error", reject);
    }).on("error", reject);
  });

  const result = { shopDomain: null, shopifyProductId: null, productHandle: null, publicDomain: null };

  // Handle from URL
  const handleMatch = productUrl.match(/\/products\/([^?#]+)/);
  if (handleMatch) result.productHandle = handleMatch[1];

  // Public domain from URL
  try { result.publicDomain = new URL(productUrl).hostname; } catch {}

  // Shop domain
  const shopPatterns = [
    /Shopify\.shop\s*=\s*["']([^"']+)/,
    /shop=([^&"']+\.myshopify\.com)/,
    /"myshopify_domain"\s*:\s*"([^"]+)"/,
  ];
  for (const p of shopPatterns) {
    const m = html.match(p);
    if (m) { result.shopDomain = m[1]; break; }
  }

  // Shopify product ID
  const pidMatch = html.match(/"product":\s*\{[^}]*"id"\s*:\s*(\d+)/);
  if (pidMatch) result.shopifyProductId = pidMatch[1];

  return result;
}

/**
 * Fetch Library DIP entries for a holder — PARALLEL batches
 * Per Blueprint §2.3
 */
async function fetchLibraryDIP(libraryId, maxPositions = 500) {
  const BATCH_SIZE = 30; // concurrent requests per batch
  const entries = [];
  let done = false;

  for (let batchStart = 1; batchStart <= maxPositions && !done; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE - 1, maxPositions);
    const promises = [];

    for (let pos = batchStart; pos <= batchEnd; pos++) {
      promises.push(
        fetchJSON(`${APP_BASE}/api/Libraries/${libraryId}/Elements/Position/${pos}`)
          .then((data) => (data && data.ImageId ? { pos, path: data.Path } : null))
          .catch(() => null)
      );
    }

    const results = await Promise.all(promises);
    for (const r of results) {
      if (r) entries.push([r.pos, r.path]);
      else { done = true; } // Stop when we hit an empty position
    }
  }

  entries.sort((a, b) => a[0] - b[0]);
  return entries;
}

/**
 * Parse DIP string from design data
 */
function parseDIP(dipString) {
  if (!dipString) return [];
  try {
    return JSON.parse(dipString);
  } catch {
    const entries = [];
    const matches = dipString.matchAll(/\[(\d+),"([^"]+)"\]/g);
    for (const m of matches) {
      entries.push([parseInt(m[1]), m[2]]);
    }
    return entries;
  }
}

function getVariationValueFromVariant(variant, position) {
  const pos = Number(position);
  if (!Number.isFinite(pos) || pos < 1) return "";
  return String(variant?.[`option${pos}`] || "");
}

function resolveAssignedSet(unified) {
  const sets = unified?.sets || [];
  const productConfig = unified?.productConfig || {};
  const assignedSets = productConfig.assignedSets || [];
  const confVariants = productConfig.conf_variants || [];
  const variations = productConfig.variations || [];
  const activeVariant = Array.isArray(confVariants) && confVariants.length > 0 ? confVariants[0] : null;

  if (sets.length <= 1) {
    return {
      activeSet: sets[0] || null,
      activeAssignedSet: Array.isArray(assignedSets) && assignedSets.length > 0 ? assignedSets[0] : null,
      activeVariant,
      variations,
    };
  }


  if (!Array.isArray(assignedSets) || assignedSets.length === 0) {
    return { activeSet: sets[0] || null, activeAssignedSet: null, activeVariant, variations };
  }

  // Use storefront default variant from conf_variants first entry.
  if (!activeVariant) {
    const fallbackAssigned = [...assignedSets].sort(compareBySortIdThenId)[0];
    return {
      activeSet: sets.find((s) => String(s.id) === String(fallbackAssigned?.id)) || sets[0] || null,
      activeAssignedSet: fallbackAssigned || null,
      activeVariant: null,
      variations,
    };
  }

  function conditionMatches(cond) {
    const variation = variations.find((v) => String(v.id) === String(cond.watch_option));
    if (!variation) return false;

    const currentValue = getVariationValueFromVariant(activeVariant, variation.position);
    const desiredValues = normalizeDesiredValue(cond.desired_value).map(String);
    const baseMatch = desiredValues.some((v) => v === currentValue);
    const action = String(cond.action || "show").toLowerCase();
    return action === "show" ? baseMatch : !baseMatch;
  }

  const matchedAssigned = [...assignedSets]
    .filter((entry) => evaluateVariationConditions(entry.variation_conditions || [], conditionMatches))
    .sort(compareBySortIdThenId);

  const selectedAssigned = matchedAssigned[0] || [...assignedSets].sort(compareBySortIdThenId)[0];
  return {
    activeSet: sets.find((s) => String(s.id) === String(selectedAssigned?.id)) || sets[0] || null,
    activeAssignedSet: selectedAssigned || null,
    activeVariant,
    variations,
  };
}

function collectDesignUuidsFromOptionValues(options = []) {
  const out = [];
  const seen = new Set();
  for (const opt of options || []) {
    for (const val of opt?.values || []) {
      const uuid = normalizeUuid(val?.product_id);
      if (!uuid || seen.has(uuid)) continue;
      seen.add(uuid);
      out.push({
        key: `${String(opt?.id)}:${String(val?.id)}`,
        label: String(val?.value || `${String(opt?.id)}:${String(val?.id)}`),
        uuid,
      });
    }
  }
  return out;
}

/**
 * Main import function
 */
export async function importProduct(productUrl) {
  console.log(`\n🔄 Importing product: ${productUrl}\n`);

  // Step 1: Extract page info
  console.log("📌 Step 1: Extracting page info...");
  const pageInfo = await extractPageInfo(productUrl);
  console.log(`   Shop: ${pageInfo.shopDomain}`);
  console.log(`   Product ID: ${pageInfo.shopifyProductId}`);
  console.log(`   Handle: ${pageInfo.productHandle}`);

  if (!pageInfo.productHandle || !pageInfo.shopDomain || !pageInfo.shopifyProductId) {
    throw new Error("Không thể extract thông tin Shopify từ URL này");
  }

  // Step 2: Fetch unified JSON
  console.log("\n📦 Step 2: Fetching unified settings...");
  const headers = {};
  if (pageInfo.publicDomain) {
    headers["Referer"] = `https://${pageInfo.publicDomain}/`;
    headers["Origin"] = `https://${pageInfo.publicDomain}`;
  }
  const unifiedUrl = `${SH_BASE}/api/settings/unified/${pageInfo.productHandle}?shop=${pageInfo.shopDomain}&productId=${pageInfo.shopifyProductId}`;
  const unified = await fetchJSON(unifiedUrl, headers);
  console.log(`   Sets: ${unified.sets?.length || 0}`);

  // Extract options from the assigned set matching storefront default variant.
  // Fallback to flatten all sets for backward compatibility.
  const setContext = resolveAssignedSet(unified);
  const activeSet = setContext?.activeSet || null;
  let rawOptions = [];
  if (activeSet && Array.isArray(activeSet.options) && activeSet.options.length > 0) {
    rawOptions = [...activeSet.options];
    console.log(`   Active set: ${activeSet.id} (${activeSet.options.length} options)`);

    // Some products keep multiple equivalent product options in one set and
    // switch them by Shopify variation (e.g. Size 4x6 vs 6x8).
    // Filter those controlled option IDs using assignedSets.options[].variation_conditions.
    const controlledEntries = setContext?.activeAssignedSet?.options || [];
    if (controlledEntries.length > 0) {
      const controlledIds = new Set(controlledEntries.map((e) => String(e.id)));
      const variationById = Object.fromEntries(
        (setContext?.variations || []).map((v) => [String(v.id), v])
      );
      const activeVariant = setContext?.activeVariant || null;

      const conditionMatches = (cond) => {
        if (!activeVariant) return true;
        const variation = variationById[String(cond.watch_option)];
        if (!variation) return true;
        const currentValue = getVariationValueFromVariant(activeVariant, variation.position);
        const desiredValues = normalizeDesiredValue(cond.desired_value).map(String);
        const baseMatch = desiredValues.some((v) => v === currentValue);
        const action = String(cond.action || "show").toLowerCase();
        return action === "show" ? baseMatch : !baseMatch;
      };

      const allowedControlledIds = new Set(
        controlledEntries
          .filter((entry) => evaluateVariationConditions(entry.variation_conditions || [], conditionMatches))
          .map((entry) => String(entry.id))
      );

      const before = rawOptions.length;
      rawOptions = rawOptions.filter((opt) => {
        const oid = String(opt.id);
        if (!controlledIds.has(oid)) return true;
        return allowedControlledIds.has(oid);
      });

      if (rawOptions.length !== before) {
        console.log(
          `   Variation-gated option filter: ${before} -> ${rawOptions.length} (kept controlled IDs: ${[...allowedControlledIds].join(", ") || "none"})`
        );
      }
    }
  } else {
    for (const set of unified.sets || []) {
      for (const opt of set.options || []) {
        rawOptions.push(opt);
      }
    }
    console.log(`   Active set: fallback flatten (${rawOptions.length} options)`);
  }
  const { options: allOptions, optionAliases } = normalizeOptions(rawOptions);
  const removedCount = rawOptions.length - allOptions.length;
  console.log(`   Options: ${allOptions.length}${removedCount > 0 ? ` (merged ${removedCount} duplicate unconditional options)` : ""}`);

  // Step 3: Find product variant UUIDs
  console.log("\n🔍 Step 3: Finding variant designs...");
  let productOption = null;
  const variantDesigns = {};

  for (const opt of allOptions) {
    if (opt.functions?.some((f) => f.type === "product")) {
      productOption = opt;
      break;
    }
  }

  if (productOption) {
    console.log(`   Product option: "${productOption.label}" (${productOption.values.length} variants)`);
    for (const val of productOption.values) {
      if (isUuid(val.product_id)) {
        variantDesigns[val.value || val.id] = val.product_id;
      }
    }
  } else {
    // Fallback: collect all values that carry product_id across options.
    // Some templates switch design UUID via non-"product" options (e.g. gender).
    const seen = new Set();
    for (const opt of allOptions) {
      for (const val of opt.values || []) {
        const uuid = normalizeUuid(val?.product_id);
        if (!uuid || seen.has(uuid)) continue;
        seen.add(uuid);
        const key = String(val?.value || `${opt.id}:${val.id}`);
        if (!variantDesigns[key]) variantDesigns[key] = uuid;
      }
    }
    if (Object.keys(variantDesigns).length > 0) {
      console.log(`   Fallback from option values: ${Object.keys(variantDesigns).length} design UUIDs`);
    }
  }

  // Some products keep product UUID mapping only in productConfig.variations.
  if (Object.keys(variantDesigns).length === 0) {
    const fromProductConfig = extractVariantDesignsFromProductConfig(unified?.productConfig || {});
    if (Object.keys(fromProductConfig).length > 0) {
      Object.assign(variantDesigns, fromProductConfig);
      console.log(
        `   Fallback from productConfig.variations: ${Object.keys(fromProductConfig).length} variant designs`
      );
    }
  }

  console.log(`   Found ${Object.keys(variantDesigns).length} variant designs`);

  const defaultDesignUUID = resolveDefaultDesignUUID({
    productConfig: unified?.productConfig || {},
    shopifyVariantId: pageInfo.shopifyProductId,
    variantDesigns,
  });
  if (defaultDesignUUID) {
    console.log(`   Default design UUID: ${defaultDesignUUID}`);
  }

  // Step 4: Fetch GetProduct for ALL UUIDs in PARALLEL
  console.log("\n📥 Step 4: Fetching designs (parallel)...");
  const designEntries = [];
  const seenDesignUuids = new Set();
  for (const [label, uuid] of Object.entries(variantDesigns)) {
    const normalized = normalizeUuid(uuid);
    if (!normalized || seenDesignUuids.has(normalized)) continue;
    seenDesignUuids.add(normalized);
    designEntries.push([label, normalized]);
  }
  const normalizedDefaultDesignUUID = normalizeUuid(defaultDesignUUID);
  if (normalizedDefaultDesignUUID && !seenDesignUuids.has(normalizedDefaultDesignUUID)) {
    seenDesignUuids.add(normalizedDefaultDesignUUID);
    designEntries.push(["__default__", normalizedDefaultDesignUUID]);
  }
  for (const entry of collectDesignUuidsFromOptionValues(allOptions)) {
    if (seenDesignUuids.has(entry.uuid)) continue;
    seenDesignUuids.add(entry.uuid);
    designEntries.push([entry.label, entry.uuid]);
  }
  const designResults = await Promise.all(
    designEntries.map(([label, uuid]) => {
      console.log(`   ⚡ ${label} → ${uuid}`);
      const url = `${APP_BASE}/api/Product/GetProduct?productId=${uuid}&clientVersion=3.10.85&useListEPS=true`;
      return fetchJSON(url).then((d) => [uuid, d]);
    })
  );
  const designs = Object.fromEntries(designResults);
  console.log(`   ✅ ${designEntries.length} designs fetched`);

  // Step 5: Check imageLibraryId holders — skip if DIP already in design
  console.log("\n📚 Step 5: Checking hair libraries...");
  const libraryDIPs = {};
  const librariesToFetch = new Set();

  for (const design of Object.values(designs)) {
    for (const holder of design.preview?.imagePlaceHoldersPreview || []) {
      if (holder.imageLibraryId && !libraryDIPs[holder.imageLibraryId]) {
        // Check if DIP is already populated in design data
        const existingDIP = parseDIP(holder.dynamicImagesPath);
        if (existingDIP.length > 10) {
          // DIP already has data — use it directly, skip library fetch
          libraryDIPs[holder.imageLibraryId] = existingDIP;
          console.log(`   ✅ Library ${holder.imageLibraryId}: ${existingDIP.length} entries (from design)`);
        } else {
          librariesToFetch.add(holder.imageLibraryId);
        }
      }
    }
  }

  // Fetch remaining libraries in parallel
  if (librariesToFetch.size > 0) {
    console.log(`   ⚡ Fetching ${librariesToFetch.size} libraries in parallel...`);
    const libResults = await Promise.all(
      [...librariesToFetch].map(async (libId) => {
        const entries = await fetchLibraryDIP(libId);
        console.log(`   ✅ Library ${libId}: ${entries.length} entries`);
        return [libId, entries];
      })
    );
    for (const [libId, entries] of libResults) {
      libraryDIPs[libId] = entries;
    }
  } else {
    console.log("   ✅ All libraries found in design data — no extra fetches needed!");
  }

  const importedProductId = buildImportedProductId(pageInfo.productHandle, pageInfo.shopifyProductId);

  // Step 6: Download fonts
  console.log("\n🔤 Step 6: Downloading fonts...");
  const productDir = path.join(DATA_DIR, "products", importedProductId);
  const fontsDir = path.join(productDir, "fonts");
  if (!fs.existsSync(fontsDir)) fs.mkdirSync(fontsDir, { recursive: true });

  const fontPaths = new Set();
  for (const design of Object.values(designs)) {
    for (const text of design.preview?.textsPreview || []) {
      if (text.fontPath) fontPaths.add(text.fontPath);
    }
  }
  const fonts = {};
  for (const fp of fontPaths) {
    try {
      const localPath = await getFont(fp, fontsDir);
      fonts[fp] = localPath;
      console.log(`   ✅ ${path.basename(fp)}`);
    } catch (e) {
      console.log(`   ❌ ${path.basename(fp)}: ${e.message}`);
    }
  }

  // Step 7: Save everything
  console.log("\n💾 Step 7: Saving product data...");

  const productData = {
    id: importedProductId,
    url: productUrl,
    handle: pageInfo.productHandle,
    shopDomain: pageInfo.shopDomain,
    publicDomain: pageInfo.publicDomain,
    shopifyProductId: pageInfo.shopifyProductId,
    variantDesigns,
    defaultDesignUUID,
    options: allOptions,
    optionAliases,
    settings: unified.settings || {},
    productConfig: unified.productConfig || {},
    fonts,
    libraryDIPs,
    importedAt: new Date().toISOString(),
  };

  fs.writeFileSync(path.join(productDir, "product.json"), JSON.stringify(productData, null, 2));

  // Save designs separately
  const designsDir = path.join(productDir, "designs");
  if (!fs.existsSync(designsDir)) fs.mkdirSync(designsDir, { recursive: true });
  for (const [uuid, design] of Object.entries(designs)) {
    fs.writeFileSync(path.join(designsDir, `${uuid}.json`), JSON.stringify(design, null, 2));
  }

  console.log(`   ✅ Saved to ${productDir}`);
  console.log(`\n🎉 Import complete!`);

  return productData;
}

/**
 * List all imported products
 */
export function listProducts() {
  const productsDir = path.join(DATA_DIR, "products");
  if (!fs.existsSync(productsDir)) return [];

  const products = [];
  for (const dir of fs.readdirSync(productsDir)) {
    const productFile = path.join(productsDir, dir, "product.json");
    if (fs.existsSync(productFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(productFile, "utf-8"));
        products.push({
          id: data.id,
          url: data.url,
          handle: data.handle,
          optionsCount: data.options?.length || 0,
          variantsCount: Object.keys(data.variantDesigns || {}).length,
          shopifyClone: data.shopifyClone || null,
          importedAt: data.importedAt,
        });
      } catch {}
    }
  }
  return products.sort((a, b) => {
    const ta = new Date(a.importedAt || 0).getTime();
    const tb = new Date(b.importedAt || 0).getTime();
    return tb - ta;
  });
}

/**
 * Load product data
 */
export function loadProduct(productId) {
  const productFile = resolveProductFile(productId);
  if (!fs.existsSync(productFile)) return null;
  const data = JSON.parse(fs.readFileSync(productFile, "utf-8"));

  const { options, optionAliases } = normalizeOptions(data.options || [], data.variantDesigns || {});
  data.options = options;
  data.optionAliases = { ...(data.optionAliases || {}), ...optionAliases };

  return data;
}

/**
 * Update raw imported product JSON metadata.
 * Useful for attaching Shopify clone info after import.
 */
export function updateProductMetadata(productId, patch = {}) {
  const productFile = resolveProductFile(productId);
  if (!fs.existsSync(productFile)) return null;

  const current = JSON.parse(fs.readFileSync(productFile, "utf-8"));
  const next = { ...current, ...patch };
  fs.writeFileSync(productFile, JSON.stringify(next, null, 2));
  return next;
}

/**
 * Delete one imported product by ID (remove data/products/{id})
 */
export function deleteProduct(productId) {
  const productDir = path.join(DATA_DIR, "products", productId);
  if (!fs.existsSync(productDir)) return false;
  fs.rmSync(productDir, { recursive: true, force: true });
  return true;
}

/**
 * Remove old imported personalized products, keep N latest.
 */
export function cleanupOldProducts(keepLatest = 1) {
  const keep = Math.max(0, Number(keepLatest) || 0);
  const products = listProducts();
  const toDelete = products.slice(keep).map((p) => p.id);

  for (const id of toDelete) {
    deleteProduct(id);
  }

  return {
    removedCount: toDelete.length,
    removedIds: toDelete,
    keptCount: Math.min(keep, products.length),
  };
}

/**
 * Load design JSON for a variant UUID
 */
export function loadDesign(productId, designUuid) {
  const designFile = path.join(DATA_DIR, "products", productId, "designs", `${designUuid}.json`);
  if (!fs.existsSync(designFile)) return null;
  return JSON.parse(fs.readFileSync(designFile, "utf-8"));
}
