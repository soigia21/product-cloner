#!/usr/bin/env node

import fs from "fs";
import path from "path";
import {
  normalizeOptions,
} from "../../server/services/customily-importer.js";
import {
  computeVisibility,
  deriveSyntheticSelectionsFromProductConfig,
  mapSelectionsToHolders,
} from "../../server/services/visibility-engine.js";

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

function compareBySortIdThenId(a, b) {
  const sa = Number.isFinite(Number(a?.sort_id)) ? Number(a.sort_id) : Number.MAX_SAFE_INTEGER;
  const sb = Number.isFinite(Number(b?.sort_id)) ? Number(b.sort_id) : Number.MAX_SAFE_INTEGER;
  if (sa !== sb) return sa - sb;
  const ia = Number.isFinite(Number(a?.id)) ? Number(a.id) : Number.MAX_SAFE_INTEGER;
  const ib = Number.isFinite(Number(b?.id)) ? Number(b.id) : Number.MAX_SAFE_INTEGER;
  if (ia !== ib) return ia - ib;
  return String(a?.id ?? "").localeCompare(String(b?.id ?? ""));
}

function normalizeDesiredValue(rawDesired) {
  const arr = Array.isArray(rawDesired) ? rawDesired : [rawDesired];
  return arr.filter((v) => v !== undefined && v !== null && String(v) !== "");
}

function getVariationValueFromVariant(variant, position) {
  const pos = Number(position);
  if (!Number.isFinite(pos) || pos < 1) return "";
  return String(variant?.[`option${pos}`] || "");
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

function resolveAssignedSet(unified) {
  const sets = Array.isArray(unified?.sets) ? unified.sets : [];
  const productConfig = unified?.productConfig || {};
  const assignedSets = Array.isArray(productConfig?.assignedSets)
    ? productConfig.assignedSets
    : [];
  const confVariants = Array.isArray(productConfig?.conf_variants)
    ? productConfig.conf_variants
    : [];
  const variations = Array.isArray(productConfig?.variations)
    ? productConfig.variations
    : [];
  const activeVariant = confVariants[0] || null;

  if (sets.length <= 1) {
    return {
      activeSet: sets[0] || null,
      activeAssignedSet: assignedSets[0] || null,
      activeVariant,
      variations,
    };
  }
  if (assignedSets.length === 0) {
    return {
      activeSet: sets[0] || null,
      activeAssignedSet: null,
      activeVariant,
      variations,
    };
  }

  if (!activeVariant) {
    const fallbackAssigned = [...assignedSets].sort(compareBySortIdThenId)[0] || null;
    return {
      activeSet: sets.find((s) => String(s.id) === String(fallbackAssigned?.id)) || sets[0] || null,
      activeAssignedSet: fallbackAssigned,
      activeVariant: null,
      variations,
    };
  }

  const variationById = Object.fromEntries(
    variations.map((v) => [String(v?.id), v])
  );
  const conditionMatches = (cond) => {
    const variation = variationById[String(cond?.watch_option)];
    if (!variation) return false;
    const currentValue = getVariationValueFromVariant(activeVariant, variation.position);
    const desiredValues = normalizeDesiredValue(cond?.desired_value).map(String);
    const baseMatch = desiredValues.some((v) => v === currentValue);
    const action = String(cond?.action || "show").toLowerCase();
    return action === "show" ? baseMatch : !baseMatch;
  };

  const matchedAssigned = [...assignedSets]
    .filter((entry) =>
      evaluateVariationConditions(entry?.variation_conditions || [], conditionMatches)
    )
    .sort(compareBySortIdThenId);

  const selectedAssigned = matchedAssigned[0] || [...assignedSets].sort(compareBySortIdThenId)[0];
  return {
    activeSet: sets.find((s) => String(s.id) === String(selectedAssigned?.id)) || sets[0] || null,
    activeAssignedSet: selectedAssigned || null,
    activeVariant,
    variations,
  };
}

function extractRawOptionsFromUnified(unified) {
  const context = resolveAssignedSet(unified);
  const activeSet = context?.activeSet || null;
  if (activeSet && Array.isArray(activeSet?.options) && activeSet.options.length > 0) {
    return activeSet.options;
  }
  return (unified?.sets || []).flatMap((set) => set?.options || []);
}

function evaluateConditionStrict(cond, map, allOptions, selections, memo) {
  const watchCid = String(cond?.watch_option || "");
  const watchOption = map[watchCid];
  const desiredValues = normalizeDesiredValue(cond?.desired_value).map(String);
  const action = String(cond?.action || "show").toLowerCase();
  const currentRaw = selections?.[watchCid];
  const current = currentRaw === undefined || currentRaw === null ? "" : String(currentRaw);
  const hasWatcherSelection = current !== "";
  const matched = desiredValues.includes("-1")
    ? hasWatcherSelection
    : desiredValues.some((v) => v === current);

  if (watchOption && !isOptionVisibleStrict(watchCid, allOptions, selections, memo, map)) {
    return false;
  }
  return action === "hide" ? !matched : matched;
}

function isOptionVisibleStrict(optionCid, allOptions, selections, memo = {}, optionMap = null) {
  const cid = String(optionCid);
  if (memo[cid] !== undefined) return memo[cid];
  memo[cid] = false;

  const map = optionMap || Object.fromEntries(allOptions.map((o) => [String(o.id), o]));
  const opt = map[cid];
  if (!opt) return false;
  const conditions = Array.isArray(opt?.conditions) ? opt.conditions : [];
  if (conditions.length === 0) {
    memo[cid] = true;
    return true;
  }

  let visible = evaluateConditionStrict(conditions[0], map, allOptions, selections, memo);
  for (let i = 1; i < conditions.length; i += 1) {
    const cond = conditions[i];
    const op = String(cond?.combination_operator || "or").toLowerCase();
    const next = evaluateConditionStrict(cond, map, allOptions, selections, memo);
    visible = op === "and" ? visible && next : visible || next;
  }
  memo[cid] = visible;
  return visible;
}

function computeVisibilityStrict(allOptions, seedSelections = {}) {
  const ordered = [...(allOptions || [])].sort(compareBySortIdThenId);
  const optionMap = Object.fromEntries(ordered.map((o) => [String(o.id), o]));
  const selections = Object.fromEntries(
    Object.entries(seedSelections || {}).map(([k, v]) => [String(k), String(v)])
  );

  for (let pass = 0; pass < 8; pass += 1) {
    let changed = false;
    const memo = {};
    const visibleById = {};

    for (const opt of ordered) {
      const cid = String(opt.id);
      visibleById[cid] = isOptionVisibleStrict(cid, ordered, selections, memo, optionMap);
    }

    for (const opt of ordered) {
      const cid = String(opt.id);
      const values = Array.isArray(opt?.values) ? opt.values : [];
      if (!visibleById[cid]) {
        if (selections[cid] !== undefined) {
          delete selections[cid];
          changed = true;
        }
        continue;
      }

      if (values.length === 0) continue;
      const current = selections[cid];
      const isValid =
        current !== undefined &&
        values.some((v) => String(v?.id) === String(current));
      if (isValid) continue;

      const explicit = values.find((v) => Boolean(v?.selected));
      if (explicit) {
        selections[cid] = String(explicit.id);
        changed = true;
      } else if (current !== undefined) {
        delete selections[cid];
        changed = true;
      }
    }
    if (!changed) break;
  }

  const finalMemo = {};
  const visibleOptions = ordered.filter((opt) =>
    isOptionVisibleStrict(String(opt.id), ordered, selections, finalMemo, optionMap)
  );
  return { visibleOptions, selections };
}

function buildScenarioSeeds(options) {
  const controllers = [...options]
    .filter(
      (opt) =>
        (!opt?.conditions || opt.conditions.length === 0) &&
        Array.isArray(opt?.values) &&
        opt.values.length > 1
    )
    .sort(compareBySortIdThenId)
    .slice(0, 4);

  const seeds = [{ id: "initial-empty", selections: {} }];
  for (const opt of controllers) {
    const cid = String(opt.id);
    const values = [...(opt.values || [])].sort(compareBySortIdThenId);
    if (values[0]) {
      seeds.push({
        id: `controller-${cid}-first-${values[0].id}`,
        selections: { [cid]: String(values[0].id) },
      });
    }
    if (values[1]) {
      seeds.push({
        id: `controller-${cid}-second-${values[1].id}`,
        selections: { [cid]: String(values[1].id) },
      });
    }
  }

  if (controllers.length >= 2) {
    const a = controllers[0];
    const b = controllers[1];
    const aVals = [...(a.values || [])].sort(compareBySortIdThenId).slice(0, 2);
    const bVals = [...(b.values || [])].sort(compareBySortIdThenId).slice(0, 2);
    for (const av of aVals) {
      for (const bv of bVals) {
        seeds.push({
          id: `cross-${a.id}-${av.id}__${b.id}-${bv.id}`,
          selections: {
            [String(a.id)]: String(av.id),
            [String(b.id)]: String(bv.id),
          },
        });
      }
    }
  }

  const dedup = new Map();
  for (const seed of seeds) {
    const signature = JSON.stringify(
      Object.entries(seed.selections).sort((x, y) => x[0].localeCompare(y[0]))
    );
    if (!dedup.has(signature)) dedup.set(signature, seed);
  }
  return [...dedup.values()];
}

function sortedEntries(input = {}) {
  return Object.entries(input || {}).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
}

function diffSelectionMap(left, right) {
  const keys = new Set([...Object.keys(left || {}), ...Object.keys(right || {})].map(String));
  const diffs = [];
  for (const key of [...keys].sort((a, b) => a.localeCompare(b))) {
    const lv = left?.[key] === undefined ? null : String(left[key]);
    const rv = right?.[key] === undefined ? null : String(right[key]);
    if (lv !== rv) diffs.push({ optionId: key, local: lv, strict: rv });
  }
  return diffs;
}

function diffVisibleOptionIds(localVisibleIds, strictVisibleIds) {
  const localSet = new Set((localVisibleIds || []).map(String));
  const strictSet = new Set((strictVisibleIds || []).map(String));
  const onlyLocal = [...localSet].filter((id) => !strictSet.has(id)).sort((a, b) => a.localeCompare(b));
  const onlyStrict = [...strictSet].filter((id) => !localSet.has(id)).sort((a, b) => a.localeCompare(b));
  return { onlyLocal, onlyStrict };
}

function diffHolderSelections(localMap, strictMap) {
  const keys = new Set([
    ...Object.keys(localMap || {}).map(String),
    ...Object.keys(strictMap || {}).map(String),
  ]);
  const diffs = [];
  for (const key of [...keys].sort((a, b) => a.localeCompare(b))) {
    const lv = localMap?.[key] === undefined ? null : String(localMap[key]);
    const rv = strictMap?.[key] === undefined ? null : String(strictMap[key]);
    if (lv !== rv) diffs.push({ holderId: key, local: lv, strict: rv });
  }
  return diffs;
}

function summarizeMismatch(scenarios = []) {
  const summary = {
    scenarios: scenarios.length,
    withAnyMismatch: 0,
    visibleMismatch: 0,
    selectionMismatch: 0,
    holderMismatch: 0,
  };
  for (const scenario of scenarios) {
    const hasVisible = scenario.diff.visible.onlyLocal.length > 0 || scenario.diff.visible.onlyStrict.length > 0;
    const hasSelection = scenario.diff.selections.length > 0;
    const hasHolder = scenario.diff.holderSelections.length > 0;
    if (hasVisible || hasSelection || hasHolder) summary.withAnyMismatch += 1;
    if (hasVisible) summary.visibleMismatch += 1;
    if (hasSelection) summary.selectionMismatch += 1;
    if (hasHolder) summary.holderMismatch += 1;
  }
  return summary;
}

function pickMismatchScenarios(scenarios = []) {
  return scenarios
    .filter((scenario) => {
      const hasVisible = scenario.diff.visible.onlyLocal.length > 0 || scenario.diff.visible.onlyStrict.length > 0;
      const hasSelection = scenario.diff.selections.length > 0;
      const hasHolder = scenario.diff.holderSelections.length > 0;
      return hasVisible || hasSelection || hasHolder;
    })
    .map((scenario) => ({
      id: scenario.id,
      seedSelections: scenario.seedSelections,
      visibleCounts: {
        local: scenario.local.visibleOptionIds.length,
        strict: scenario.strict.visibleOptionIds.length,
      },
      diff: scenario.diff,
    }));
}

async function main() {
  const args = parseArgs(process.argv);
  const manifestPath = path.resolve(
    process.cwd(),
    String(args.manifest || "tmp/reports/decorative-plaques-page1-manifest.json")
  );
  const outRoot = path.resolve(
    process.cwd(),
    String(args.out || "tmp/reports/decorative-plaques-page1")
  );
  const runtimeDir = path.join(outRoot, "runtime");
  const runtimeDiffDir = path.join(outRoot, "runtime-diff");
  ensureDir(runtimeDir);
  ensureDir(runtimeDiffDir);

  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Manifest not found: ${manifestPath}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  const products = (manifest?.products || []).filter((x) => String(x?.status) === "ok");
  if (products.length === 0) {
    throw new Error(`No success products in manifest: ${manifestPath}`);
  }

  const summary = [];
  for (const product of products) {
    const handle = String(product?.handle || "").trim();
    const unifiedPath = path.resolve(process.cwd(), String(product?.unifiedFile || ""));
    if (!handle || !fs.existsSync(unifiedPath)) {
      summary.push({
        handle,
        status: "error",
        error: `Missing unified file: ${product?.unifiedFile || "null"}`,
      });
      continue;
    }

    try {
      const unified = JSON.parse(fs.readFileSync(unifiedPath, "utf-8"));
      const rawOptions = extractRawOptionsFromUnified(unified);
      const normalized = normalizeOptions(rawOptions, null).options || [];
      const synthetic = deriveSyntheticSelectionsFromProductConfig(unified?.productConfig || {});
      const scenarioSeeds = buildScenarioSeeds(normalized);

      const scenarios = [];
      for (const seed of scenarioSeeds) {
        const seedSelections = Object.fromEntries(
          Object.entries(seed.selections || {}).map(([k, v]) => [String(k), String(v)])
        );
        const local = computeVisibility(normalized, seedSelections, {
          syntheticSelections: synthetic.selections,
          syntheticAnchoredOptionIds: synthetic.anchoredOptionIds,
          userSelectedOptionIds: Object.keys(seedSelections),
        });
        const strict = computeVisibilityStrict(normalized, {
          ...synthetic.selections,
          ...seedSelections,
        });

        const localHolders = mapSelectionsToHolders(local.visibleOptions, local.selections, {}, {});
        const strictHolders = mapSelectionsToHolders(strict.visibleOptions, strict.selections, {}, {});

        scenarios.push({
          id: seed.id,
          seedSelections,
          local: {
            visibleOptionIds: local.visibleOptions.map((o) => String(o.id)),
            selections: sortedEntries(local.selections),
            holderSelections: sortedEntries(localHolders.holderSelections),
            textMappings: sortedEntries(localHolders.textMappings),
          },
          strict: {
            visibleOptionIds: strict.visibleOptions.map((o) => String(o.id)),
            selections: sortedEntries(strict.selections),
            holderSelections: sortedEntries(strictHolders.holderSelections),
            textMappings: sortedEntries(strictHolders.textMappings),
          },
          diff: {
            visible: diffVisibleOptionIds(
              local.visibleOptions.map((o) => String(o.id)),
              strict.visibleOptions.map((o) => String(o.id))
            ),
            selections: diffSelectionMap(local.selections, strict.selections),
            holderSelections: diffHolderSelections(
              localHolders.holderSelections,
              strictHolders.holderSelections
            ),
          },
        });
      }

      const mismatchSummary = summarizeMismatch(scenarios);
      const runtimePayload = {
        generatedAt: new Date().toISOString(),
        handle,
        productUrl: product.productUrl || null,
        productId: product.shopifyProductId || null,
        optionsCount: normalized.length,
        syntheticSelections: synthetic,
        scenarios,
        mismatchSummary,
      };
      const runtimeDiffPayload = {
        generatedAt: runtimePayload.generatedAt,
        handle,
        mismatchSummary,
        mismatchScenarios: pickMismatchScenarios(scenarios),
      };

      fs.writeFileSync(
        path.join(runtimeDir, `${handle}.json`),
        JSON.stringify(runtimePayload, null, 2)
      );
      fs.writeFileSync(
        path.join(runtimeDiffDir, `${handle}.json`),
        JSON.stringify(runtimeDiffPayload, null, 2)
      );

      summary.push({
        handle,
        status: "ok",
        options: normalized.length,
        scenarios: scenarios.length,
        mismatchSummary,
      });
      console.log(
        `✅ ${handle}: scenarios=${scenarios.length}, mismatch=${mismatchSummary.withAnyMismatch}`
      );
    } catch (error) {
      summary.push({
        handle,
        status: "error",
        error: String(error?.message || error),
      });
      console.log(`❌ ${handle}: ${error?.message || error}`);
    }
  }

  const summaryPayload = {
    generatedAt: new Date().toISOString(),
    sourceManifest: path.relative(process.cwd(), manifestPath),
    results: summary,
    stats: {
      total: summary.length,
      ok: summary.filter((x) => x.status === "ok").length,
      error: summary.filter((x) => x.status === "error").length,
      productsWithMismatch: summary.filter(
        (x) => x.status === "ok" && (x?.mismatchSummary?.withAnyMismatch || 0) > 0
      ).length,
    },
  };

  const summaryPath = path.join(outRoot, "runtime-summary.json");
  fs.writeFileSync(summaryPath, JSON.stringify(summaryPayload, null, 2));
  console.log(`\n📄 Runtime summary: ${path.relative(process.cwd(), summaryPath)}`);
}

main().catch((error) => {
  console.error(`\n❌ ${error?.message || error}`);
  process.exit(1);
});

