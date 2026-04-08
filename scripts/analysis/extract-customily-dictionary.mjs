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

function detectType(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function sampleValue(value) {
  try {
    const raw = JSON.stringify(value);
    if (raw.length <= 120) return raw;
    return `${raw.slice(0, 117)}...`;
  } catch {
    return String(value);
  }
}

function inferRole(pathKey) {
  const key = String(pathKey);
  if (key.endsWith(".watch_option")) {
    return {
      candidateRole: "condition_watcher_option_id",
      confidence: "high",
    };
  }
  if (key.endsWith(".desired_value")) {
    return {
      candidateRole: "condition_desired_value_or_value_ids",
      confidence: "high",
    };
  }
  if (key.endsWith(".combination_operator")) {
    return {
      candidateRole: "condition_boolean_chain_operator",
      confidence: "high",
    };
  }
  if (key.endsWith(".action")) {
    return {
      candidateRole: "condition_visibility_action_show_or_hide",
      confidence: "high",
    };
  }
  if (key.endsWith(".selected")) {
    return {
      candidateRole: "explicit_default_value_flag",
      confidence: "high",
    };
  }
  if (key.endsWith(".required")) {
    return {
      candidateRole: "required_option_gate_for_checkout_or_preview",
      confidence: "high",
    };
  }
  if (key.endsWith(".checked")) {
    return {
      candidateRole: "checkbox_default_state_hint",
      confidence: "medium",
    };
  }
  if (key.endsWith(".hide_visually")) {
    return {
      candidateRole: "ui_visibility_hint_not_condition_engine_gate",
      confidence: "high",
    };
  }
  if (key.endsWith(".variation_conditions")) {
    return {
      candidateRole: "shopify_variant_based_option_or_set_gate",
      confidence: "high",
    };
  }
  if (key.endsWith(".file_upload_image_id")) {
    return {
      candidateRole: "upload_target_holder_id",
      confidence: "high",
    };
  }
  if (key.endsWith(".image_id") && key.includes("option.values")) {
    return {
      candidateRole: "selected_value_to_holder_dip_key",
      confidence: "high",
    };
  }
  if (key.endsWith(".image_id") && key.includes("option.functions")) {
    return {
      candidateRole: "bound_image_holder_id",
      confidence: "high",
    };
  }
  if (key.endsWith(".text_id")) {
    return {
      candidateRole: "bound_text_holder_id",
      confidence: "high",
    };
  }
  if (key.endsWith(".product_id") && key.includes("option.values")) {
    return {
      candidateRole: "design_uuid_switch_for_variant_or_option_value",
      confidence: "high",
    };
  }
  if (key === "productConfig.initial_product_id") {
    return {
      candidateRole: "default_design_uuid_hint",
      confidence: "high",
    };
  }
  if (key === "productConfig.assignedSets") {
    return {
      candidateRole: "active_set_and_option_gate_by_shopify_variant",
      confidence: "high",
    };
  }
  if (key === "productConfig.conf_variants") {
    return {
      candidateRole: "shopify_variant_to_variation_value_mapping",
      confidence: "high",
    };
  }
  if (key === "productConfig.variations") {
    return {
      candidateRole: "shopify_variation_dimension_definition",
      confidence: "high",
    };
  }
  if (key.endsWith(".thumb_image")) {
    return {
      candidateRole: "swatch_thumbnail_asset_url",
      confidence: "high",
    };
  }
  if (key.endsWith(".sort_id")) {
    return {
      candidateRole: "display_order_or_fallback_dip_key_hint",
      confidence: "medium",
    };
  }
  if (key.endsWith(".optionValue")) {
    return {
      candidateRole: "custom_checkbox_or_option_behavior_value",
      confidence: "medium",
    };
  }
  if (key.endsWith(".placeholder")) {
    return {
      candidateRole: "text_input_placeholder",
      confidence: "high",
    };
  }
  if (key.endsWith(".help_text")) {
    return {
      candidateRole: "text_input_help_message",
      confidence: "high",
    };
  }
  if (key.endsWith(".max_length")) {
    return {
      candidateRole: "text_input_max_length",
      confidence: "high",
    };
  }
  return {
    candidateRole: "unknown_or_secondary_ui_setting",
    confidence: "low",
  };
}

function csvEscape(value) {
  const s = String(value ?? "");
  if (!/[",\n]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

function toCsv(rows) {
  const headers = [
    "json_path",
    "frequency",
    "observed_types",
    "sample_values",
    "candidate_role",
    "confidence",
    "evidence_products",
  ];
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.json_path,
        row.frequency,
        row.observed_types.join("|"),
        row.distinct_samples.join(" | "),
        row.candidate_role,
        row.confidence,
        row.evidence_products.join("|"),
      ]
        .map(csvEscape)
        .join(",")
    );
  }
  return lines.join("\n");
}

function pushRecord(map, pathKey, value, handle) {
  const key = String(pathKey);
  if (!map.has(key)) {
    map.set(key, {
      path: key,
      frequency: 0,
      types: new Set(),
      samples: new Set(),
      products: new Set(),
    });
  }
  const row = map.get(key);
  row.frequency += 1;
  row.types.add(detectType(value));
  row.products.add(String(handle));
  if (row.samples.size < 8) {
    row.samples.add(sampleValue(value));
  }
}

function extractFromUnified(unified, handle, map) {
  const productConfig = unified?.productConfig || {};
  for (const [k, v] of Object.entries(productConfig)) {
    pushRecord(map, `productConfig.${k}`, v, handle);
  }

  const settings = unified?.settings || {};
  for (const [k, v] of Object.entries(settings)) {
    pushRecord(map, `settings.${k}`, v, handle);
  }

  const sets = Array.isArray(unified?.sets) ? unified.sets : [];
  for (const set of sets) {
    const options = Array.isArray(set?.options) ? set.options : [];
    for (const opt of options) {
      for (const [k, v] of Object.entries(opt || {})) {
        pushRecord(map, `option.${k}`, v, handle);
      }

      const conditions = Array.isArray(opt?.conditions) ? opt.conditions : [];
      for (const cond of conditions) {
        for (const [k, v] of Object.entries(cond || {})) {
          pushRecord(map, `option.conditions.${k}`, v, handle);
        }
      }

      const variationConditions = Array.isArray(opt?.variation_conditions)
        ? opt.variation_conditions
        : [];
      for (const cond of variationConditions) {
        for (const [k, v] of Object.entries(cond || {})) {
          pushRecord(map, `option.variation_conditions.${k}`, v, handle);
        }
      }

      const values = Array.isArray(opt?.values) ? opt.values : [];
      for (const value of values) {
        for (const [k, v] of Object.entries(value || {})) {
          pushRecord(map, `option.values.${k}`, v, handle);
        }
      }

      const functions = Array.isArray(opt?.functions) ? opt.functions : [];
      for (const fn of functions) {
        for (const [k, v] of Object.entries(fn || {})) {
          pushRecord(map, `option.functions.${k}`, v, handle);
        }
      }
    }
  }

  const assignedSets = Array.isArray(productConfig?.assignedSets)
    ? productConfig.assignedSets
    : [];
  for (const assignedSet of assignedSets) {
    for (const [k, v] of Object.entries(assignedSet || {})) {
      pushRecord(map, `productConfig.assignedSets.${k}`, v, handle);
    }

    const setVariationConditions = Array.isArray(assignedSet?.variation_conditions)
      ? assignedSet.variation_conditions
      : [];
    for (const cond of setVariationConditions) {
      for (const [k, v] of Object.entries(cond || {})) {
        pushRecord(
          map,
          `productConfig.assignedSets.variation_conditions.${k}`,
          v,
          handle
        );
      }
    }

    const assignedOptions = Array.isArray(assignedSet?.options) ? assignedSet.options : [];
    for (const assignedOpt of assignedOptions) {
      for (const [k, v] of Object.entries(assignedOpt || {})) {
        pushRecord(map, `productConfig.assignedSets.options.${k}`, v, handle);
      }
      const optionVariationConditions = Array.isArray(assignedOpt?.variation_conditions)
        ? assignedOpt.variation_conditions
        : [];
      for (const cond of optionVariationConditions) {
        for (const [k, v] of Object.entries(cond || {})) {
          pushRecord(
            map,
            `productConfig.assignedSets.options.variation_conditions.${k}`,
            v,
            handle
          );
        }
      }
    }
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const manifestPath = path.resolve(
    process.cwd(),
    String(args.manifest || "tmp/reports/decorative-plaques-page1-manifest.json")
  );
  const outJsonPath = path.resolve(
    process.cwd(),
    String(args.outJson || "tmp/reports/decorative-plaques-page1-dictionary.json")
  );
  const outCsvPath = path.resolve(
    process.cwd(),
    String(args.outCsv || "tmp/reports/decorative-plaques-page1-dictionary.csv")
  );

  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Manifest not found: ${manifestPath}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  const products = Array.isArray(manifest?.products) ? manifest.products : [];
  if (products.length === 0) throw new Error(`Manifest has no products: ${manifestPath}`);

  const dictionaryMap = new Map();
  const errors = [];
  const loadedHandles = [];

  for (const product of products) {
    if (String(product?.status || "") !== "ok") continue;
    const handle = String(product?.handle || "").trim();
    const unifiedFile = path.resolve(process.cwd(), String(product?.unifiedFile || ""));
    if (!handle || !fs.existsSync(unifiedFile)) {
      errors.push({
        handle,
        unifiedFile: product?.unifiedFile || null,
        error: "missing unified file",
      });
      continue;
    }

    try {
      const unified = JSON.parse(fs.readFileSync(unifiedFile, "utf-8"));
      extractFromUnified(unified, handle, dictionaryMap);
      loadedHandles.push(handle);
    } catch (error) {
      errors.push({
        handle,
        unifiedFile: product?.unifiedFile || null,
        error: String(error?.message || error),
      });
    }
  }

  const rows = [...dictionaryMap.values()]
    .map((row) => {
      const roleInfo = inferRole(row.path);
      return {
        json_path: row.path,
        frequency: row.frequency,
        observed_types: [...row.types].sort(),
        distinct_samples: [...row.samples],
        candidate_role: roleInfo.candidateRole,
        confidence: roleInfo.confidence,
        evidence_products: [...row.products].sort(),
      };
    })
    .sort((a, b) => a.json_path.localeCompare(b.json_path));

  const outJson = {
    generatedAt: new Date().toISOString(),
    source: {
      manifest: path.relative(process.cwd(), manifestPath),
      loadedProducts: loadedHandles.length,
      productsInManifest: products.length,
    },
    summary: {
      dictionaryPathCount: rows.length,
      highConfidenceCount: rows.filter((x) => x.confidence === "high").length,
      mediumConfidenceCount: rows.filter((x) => x.confidence === "medium").length,
      lowConfidenceCount: rows.filter((x) => x.confidence === "low").length,
      errors: errors.length,
    },
    errors,
    rows,
  };

  ensureDir(path.dirname(outJsonPath));
  ensureDir(path.dirname(outCsvPath));
  fs.writeFileSync(outJsonPath, JSON.stringify(outJson, null, 2));
  fs.writeFileSync(outCsvPath, toCsv(rows));

  console.log(`📘 Dictionary JSON: ${path.relative(process.cwd(), outJsonPath)}`);
  console.log(`📄 Dictionary CSV: ${path.relative(process.cwd(), outCsvPath)}`);
  console.log(
    `✅ Paths=${rows.length}, loaded products=${loadedHandles.length}, errors=${errors.length}`
  );
}

main().catch((error) => {
  console.error(`\n❌ ${error?.message || error}`);
  process.exit(1);
});

