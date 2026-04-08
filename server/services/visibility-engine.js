/**
 * Visibility Engine — Recursive condition cascade
 * Per Blueprint §6
 * 
 * CRITICAL rules from Blueprint:
 * - desired_value is value_cid (field `id` in values array), NOT value index
 * - DIP keys are int, image_id is string — always parseInt() both
 * - Recursive with memo to prevent infinite loops
 * - Auto-default when option becomes visible
 */

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
  const conds = Array.isArray(conditions) ? conditions : [];
  if (conds.length === 0) return true;
  const evaluate = (cond) => conditionMatches(cond);
  let visible = evaluate(conds[0]);
  for (let i = 1; i < conds.length; i++) {
    const cond = conds[i];
    const op = String(cond?.combination_operator || "or").toLowerCase();
    const next = evaluate(cond);
    visible = op === "and" ? visible && next : visible || next;
  }
  return visible;
}

export function deriveSyntheticSelectionsFromProductConfig(productConfig = {}) {
  const variations = Array.isArray(productConfig?.variations) ? productConfig.variations : [];
  const assignedSets = Array.isArray(productConfig?.assignedSets) ? productConfig.assignedSets : [];
  const confVariants = Array.isArray(productConfig?.conf_variants) ? productConfig.conf_variants : [];
  const activeVariant = confVariants[0] || null;
  if (!activeVariant || assignedSets.length === 0) {
    return { selections: {}, anchoredOptionIds: [] };
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

  const syntheticSelections = {};
  const anchoredOptionIds = new Set();
  for (const assignedSet of assignedSets) {
    if (!evaluateVariationConditions(assignedSet?.variation_conditions || [], conditionMatches)) {
      continue;
    }
    for (const entry of assignedSet?.options || []) {
      if (!evaluateVariationConditions(entry?.variation_conditions || [], conditionMatches)) {
        continue;
      }
      const cid = String(entry?.id || "");
      if (!cid) continue;
      // Customily exports set-scoped watcher options expecting desired_value = -1.
      syntheticSelections[cid] = "-1";
      anchoredOptionIds.add(cid);
    }
  }

  return {
    selections: syntheticSelections,
    anchoredOptionIds: [...anchoredOptionIds],
  };
}

function deriveImplicitMissingWatcherSelections(allOptions = [], preselected = {}) {
  const optionIds = new Set((allOptions || []).map((opt) => String(opt?.id)));
  const protectedWatcherIds = new Set(Object.keys(preselected || {}).map(String));
  const candidateValueByWatcher = new Map();
  const ambiguousWatchers = new Set();

  for (const opt of allOptions || []) {
    for (const cond of opt?.conditions || []) {
      const watchCid = String(cond?.watch_option || "");
      if (!watchCid || optionIds.has(watchCid) || protectedWatcherIds.has(watchCid)) continue;

      const action = String(cond?.action || "show").toLowerCase();
      const desired = normalizeDesiredValue(cond?.desired_value).map(String);

      // Only infer stable pseudo-watchers when condition shape is deterministic.
      if (action !== "show" || desired.length !== 1) {
        ambiguousWatchers.add(watchCid);
        continue;
      }

      const inferredValue = desired[0];
      // Keep fallback conservative to prevent broad accidental branches.
      if (inferredValue !== "0" && inferredValue !== "-1") {
        ambiguousWatchers.add(watchCid);
        continue;
      }

      if (!candidateValueByWatcher.has(watchCid)) {
        candidateValueByWatcher.set(watchCid, inferredValue);
        continue;
      }

      if (candidateValueByWatcher.get(watchCid) !== inferredValue) {
        ambiguousWatchers.add(watchCid);
      }
    }
  }

  const inferredSelections = {};
  for (const [watchCid, inferredValue] of candidateValueByWatcher.entries()) {
    if (ambiguousWatchers.has(watchCid)) continue;
    inferredSelections[watchCid] = inferredValue;
  }

  return inferredSelections;
}

function isProductOption(opt) {
  return (opt.functions || []).some((fn) => fn.type === "product");
}

function hasImageBinding(opt) {
  return (opt?.functions || []).some((fn) => fn.type === "image" && fn.image_id);
}

function getAutoDefaultMode(opt) {
  const fromNormalized = String(opt?.auto_default_mode || "").toLowerCase();
  if (fromNormalized) return fromNormalized;

  // Backward-compatible fallback for old imported data without normalized policy.
  const values = opt?.values || [];
  const type = String(opt?.type || "").toLowerCase().replace(/\s+/g, "");
  const conditioned = Boolean(opt?.conditions && opt.conditions.length > 0);
  const hasSelected = values.some((v) => Boolean(v.selected));
  if (isProductOption(opt)) return "first";
  if (values.length === 1) return "single";
  if (hasSelected) return "selected";
  if (conditioned) return opt?.required === true && type === "dropdown" && hasImageBinding(opt) ? "first" : "none";
  return "none";
}

function buildConditionChildrenMap(allOptions = []) {
  const children = new Map();
  for (const opt of allOptions) {
    const oid = String(opt.id);
    for (const cond of opt.conditions || []) {
      const wid = String(cond.watch_option);
      if (!children.has(wid)) children.set(wid, new Set());
      children.get(wid).add(oid);
    }
  }
  return children;
}

function hasDefaultedImageDescendant(optionId, optionMap, conditionChildrenMap) {
  const start = String(optionId);
  const stack = [...(conditionChildrenMap.get(start) || [])];
  const seen = new Set();

  while (stack.length > 0) {
    const oid = String(stack.pop());
    if (seen.has(oid)) continue;
    seen.add(oid);

    const opt = optionMap[oid];
    if (!opt) continue;

    if (hasImageBinding(opt) && getAutoDefaultMode(opt) !== "none") {
      return true;
    }

    for (const child of conditionChildrenMap.get(oid) || []) {
      stack.push(String(child));
    }
  }
  return false;
}

function shouldImplicitControllerDefault(opt, optionMap, conditionChildrenMap) {
  if (!opt) return false;
  if (isProductOption(opt)) return false;
  if (hasImageBinding(opt)) return false;
  if (Boolean((opt.conditions || []).length) === false) return false;
  if (opt.required !== true) return false;
  const type = String(opt?.type || "").toLowerCase().replace(/\s+/g, "");
  if (type !== "dropdown") return false;
  if ((opt.values || []).length !== 2) return false;

  return hasDefaultedImageDescendant(opt.id, optionMap, conditionChildrenMap);
}

function getConditionWatchers(opt) {
  return [...new Set((opt?.conditions || []).map((c) => String(c.watch_option)))];
}

function canAutoDefaultFromWatcher(opt, selections = {}, selectionMeta = {}, userSelectedSet = null) {
  if (!opt?.conditions || opt.conditions.length === 0) return true;
  if (!userSelectedSet) return true;

  const watchers = getConditionWatchers(opt);
  if (watchers.length === 0) return false;

  // Allow when at least one watcher is selected and anchored by user action chain.
  return watchers.some((w) => {
    if (selections[w] === undefined) return false;
    if (userSelectedSet.has(w)) return true;
    return Boolean(selectionMeta[w]?.anchored);
  });
}

function shouldAutoDefault(
  opt,
  selections = {},
  userSelectedSet = null,
  selectionMeta = {}
) {
  const mode = getAutoDefaultMode(opt);

  if (!canAutoDefaultFromWatcher(opt, selections, selectionMeta, userSelectedSet)) {
    return false;
  }
  if (mode === "none") return false;

  // Do not preselect "first" before any user action.
  // This keeps initial state closer to Customily for products that require
  // the buyer to choose a controller (e.g. number/person) first.
  if (mode === "first" && userSelectedSet && userSelectedSet.size === 0) {
    return false;
  }

  return true;
}

function sortedObjectEntries(input = {}) {
  return Object.entries(input || {})
    .map(([k, v]) => [String(k), String(v)])
    .sort((a, b) => a[0].localeCompare(b[0]));
}

function collectSelectedProductDesignKeys(visibleOptions = [], selections = {}) {
  const rows = [];
  for (const opt of visibleOptions || []) {
    if (!isProductOption(opt)) continue;
    const cid = String(opt.id);
    const selectedCid = String(selections[cid] ?? "");
    if (!selectedCid) continue;
    const selectedValue = (opt.values || []).find((v) => String(v.id) === selectedCid);
    const productId = String(selectedValue?.product_id || "").trim();
    if (!productId) continue;
    rows.push(`${cid}:${productId}`);
  }
  rows.sort();
  return rows;
}

function buildImpactSignature(visibleOptions = [], selections = {}, textInputs = {}, uploadInputs = {}) {
  const visibleOptionIds = (visibleOptions || [])
    .map((o) => String(o.id))
    .sort((a, b) => a.localeCompare(b));
  const { holderSelections, textMappings, uploadMappings } = mapSelectionsToHolders(
    visibleOptions,
    selections,
    textInputs,
    uploadInputs
  );
  const selectedProductDesignKeys = collectSelectedProductDesignKeys(visibleOptions, selections);
  return JSON.stringify({
    visibleOptionIds,
    holderSelections: sortedObjectEntries(holderSelections),
    textMappings: sortedObjectEntries(textMappings),
    uploadMappings: sortedObjectEntries(uploadMappings),
    selectedProductDesignKeys,
  });
}

function collectCandidateValueIdsForImpact(option, allOptions = [], currentValueCid = "") {
  const values = [...(option?.values || [])].sort(compareBySortIdThenId);
  const valueIdSet = new Set(values.map((v) => String(v.id)));
  const out = new Set();

  const current = String(currentValueCid || "");
  if (current && valueIdSet.has(current)) out.add(current);

  const watcherId = String(option?.id || "");
  for (const dep of allOptions || []) {
    for (const cond of dep?.conditions || []) {
      if (String(cond?.watch_option || "") !== watcherId) continue;
      for (const rawDesired of normalizeDesiredValue(cond?.desired_value)) {
        const desired = String(rawDesired);
        if (valueIdSet.has(desired)) out.add(desired);
      }
    }
  }

  if (out.size === 0) {
    for (const v of values.slice(0, 2)) out.add(String(v.id));
  } else if (out.size === 1 && values.length > 1) {
    const firstDifferent = values.find((v) => !out.has(String(v.id)));
    if (firstDifferent) out.add(String(firstDifferent.id));
  }

  return [...out];
}

/**
 * Determine hidden options that should be shown in UI because changing their value
 * changes downstream visibility/render behavior.
 */
export function computeUiForceShowOptionIds(allOptions, currentSelections = {}, config = {}) {
  const orderedOptions = [...(allOptions || [])].sort(compareBySortIdThenId);
  if (orderedOptions.length === 0) return [];

  const baseResult = computeVisibility(orderedOptions, currentSelections, config);
  const baseVisibleOptions = baseResult.visibleOptions || [];
  const baseSelections = baseResult.selections || {};
  const textInputs = config?.textInputs || {};
  const uploadInputs = config?.uploadInputs || {};
  const baseSignature = buildImpactSignature(
    baseVisibleOptions,
    baseSelections,
    textInputs,
    uploadInputs
  );

  const baseUserSelectedOptionIds = config?.userSelectedOptionIds
    ? Array.from(config.userSelectedOptionIds).map(String)
    : null;

  const candidates = baseVisibleOptions.filter(
    (opt) =>
      Boolean(opt?.hide_visually) &&
      Array.isArray(opt?.values) &&
      opt.values.length > 1
  );
  if (candidates.length === 0) return [];

  const forceShow = [];
  for (const opt of candidates) {
    const cid = String(opt.id);
    const current = String(baseSelections[cid] ?? "");
    const candidateValueIds = collectCandidateValueIdsForImpact(opt, orderedOptions, current);
    let impactful = false;

    for (const nextValueCid of candidateValueIds) {
      const nextCid = String(nextValueCid || "");
      if (!nextCid || nextCid === current) continue;

      const mutatedSelections = { ...baseSelections, [cid]: nextCid };
      const mutatedUserSelectedOptionIds = baseUserSelectedOptionIds
        ? [...new Set([...baseUserSelectedOptionIds, cid])]
        : config?.userSelectedOptionIds;

      const mutatedResult = computeVisibility(orderedOptions, mutatedSelections, {
        ...config,
        userSelectedOptionIds: mutatedUserSelectedOptionIds,
      });
      const mutatedSignature = buildImpactSignature(
        mutatedResult.visibleOptions || [],
        mutatedResult.selections || {},
        textInputs,
        uploadInputs
      );
      if (mutatedSignature !== baseSignature) {
        impactful = true;
        break;
      }
    }

    if (impactful) {
      forceShow.push(cid);
    }
  }

  return forceShow;
}

/**
 * Check if an option is visible given current selections
 * @param {number|string} optionCid - option CID to check
 * @param {Object[]} allOptions - all options array
 * @param {Object} currentSelections - {optionCid: valueCid}
 * @param {Object} memo - memoization cache
 * @param {Object} optionMap - optional indexed map for O(1) lookup
 * @returns {boolean}
 */
export function isOptionVisible(optionCid, allOptions, currentSelections, memo = {}, optionMap = null) {
  const cid = String(optionCid);
  if (memo[cid] !== undefined) return memo[cid];
  memo[cid] = false; // prevent infinite loop

  const map = optionMap || Object.fromEntries(allOptions.map((o) => [String(o.id), o]));
  const opt = map[cid];
  if (!opt) { memo[cid] = false; return false; }

  // No conditions = always visible (unconditional)
  if (!opt.conditions || opt.conditions.length === 0) {
    memo[cid] = true;
    return true;
  }

  const conds = opt.conditions || [];
  if (conds.length === 0) {
    memo[cid] = false;
    return false;
  }

  const evaluateCondition = (cond) => {
    const watchCid = String(cond.watch_option);
    const watchOpt = map[watchCid];
    const desired = normalizeDesiredValue(cond.desired_value).map(String);
    const action = String(cond.action || "show").toLowerCase();
    const selectedRaw = currentSelections?.[watchCid];
    const selectedValueCid =
      selectedRaw === undefined || selectedRaw === null ? "" : String(selectedRaw);
    const hasWatcherSelection = selectedValueCid !== "";
    // Customily uses desired_value = -1 as "watcher has any selected value".
    const match = desired.includes("-1")
      ? hasWatcherSelection
      : desired.some((v) => v === selectedValueCid);

    // Some Customily exports use set-scoped pseudo watchers (not present in options[]).
    // If caller injected a synthetic selection for that watcher, evaluate directly.
    if (!watchOpt) {
      if (!hasWatcherSelection) return false;
      return action === "hide" ? !match : match;
    }

    // If watcher itself is hidden, this branch is inactive.
    if (!isOptionVisible(watchCid, allOptions, currentSelections, memo, map)) {
      return false;
    }

    return action === "hide" ? !match : match;
  };

  // Combine sequentially using each condition's combination_operator.
  // This matches Customily exports where mixed OR/AND conditions encode
  // expressions like (A OR B) AND C.
  let visible = evaluateCondition(conds[0]);
  for (let i = 1; i < conds.length; i++) {
    const cond = conds[i];
    const op = String(cond.combination_operator || "or").toLowerCase();
    const next = evaluateCondition(cond);
    visible = op === "and" ? visible && next : visible || next;
  }

  memo[cid] = visible;
  return visible;
}

/**
 * Compute all visible options and apply auto-defaults
 * @param {Object[]} allOptions
 * @param {Object} currentSelections - mutable, will be updated with auto-defaults
 * @returns {{ visibleOptions: Object[], selections: Object }}
 */
export function computeVisibility(allOptions, currentSelections, config = {}) {
  const orderedOptions = [...allOptions].sort(compareBySortIdThenId);
  const configuredSyntheticSelections = Object.fromEntries(
    Object.entries(config?.syntheticSelections || {}).map(([k, v]) => [String(k), String(v)])
  );
  const inferredMissingWatcherSelections = deriveImplicitMissingWatcherSelections(
    orderedOptions,
    { ...configuredSyntheticSelections, ...(currentSelections || {}) }
  );
  const syntheticSelections = {
    ...configuredSyntheticSelections,
    ...inferredMissingWatcherSelections,
  };
  const syntheticAnchoredSet = new Set(
    [
      ...Array.from(config?.syntheticAnchoredOptionIds || []).map(String),
      ...Object.keys(inferredMissingWatcherSelections),
    ]
  );
  const selections = { ...syntheticSelections, ...(currentSelections || {}) };
  const userSelectedSet = config?.userSelectedOptionIds
    ? new Set(Array.from(config.userSelectedOptionIds).map(String))
    : null;
  const selectionMeta = {};
  for (const cid of Object.keys(selections)) {
    const sid = String(cid);
    selectionMeta[String(cid)] = {
      anchored: userSelectedSet
        ? userSelectedSet.has(sid) || syntheticAnchoredSet.has(sid)
        : true,
    };
  }
  const optionMap = Object.fromEntries(orderedOptions.map((o) => [String(o.id), o]));
  const conditionChildrenMap = buildConditionChildrenMap(orderedOptions);

  // Multiple passes to handle cascading auto-defaults + hidden cleanup
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    const passMemo = {};
    const visibleById = {};

    for (const opt of orderedOptions) {
      const cid = String(opt.id);
      const visible = isOptionVisible(cid, orderedOptions, selections, passMemo, optionMap);
      visibleById[cid] = visible;
    }

    for (const opt of orderedOptions) {
      const cid = String(opt.id);
      const visible = visibleById[cid];
      const values = opt.values || [];

      // If hidden, remove stale selection so it won't leak into later cascade checks.
      if (!visible) {
        if (selections[cid] !== undefined) {
          delete selections[cid];
          delete selectionMeta[cid];
          changed = true;
        }
        continue;
      }

      // Auto-default only for explicit defaults (or product selector).
      if (values.length > 0) {
        const currentValueCid = selections[cid];
        const valid = currentValueCid !== undefined &&
          values.some((v) => String(v.id) === String(currentValueCid));

        if (valid) {
          continue;
        }

        if (shouldAutoDefault(
          opt,
          selections,
          userSelectedSet,
          selectionMeta
        )) {
          const mode = getAutoDefaultMode(opt);
          const effectiveMode = mode;
          const explicitDefault = values.find((v) => v.selected) || null;
          const defaultVal =
            effectiveMode === "selected" ? explicitDefault :
              effectiveMode === "single" ? (explicitDefault || values[0] || null) :
                effectiveMode === "first" ? (explicitDefault || values[0] || null) :
                  null;
          if (defaultVal) {
            const nextValueCid = String(defaultVal.id);
            if (String(currentValueCid || "") !== nextValueCid) {
              selections[cid] = nextValueCid;
              const anchoredFromWatchers = getConditionWatchers(opt).some((w) =>
                (userSelectedSet && userSelectedSet.has(String(w))) ||
                Boolean(selectionMeta[String(w)]?.anchored)
              );
              selectionMeta[cid] = {
                anchored: isProductOption(opt) ? true : anchoredFromWatchers,
              };
              changed = true;
            }
          } else if (currentValueCid !== undefined) {
            delete selections[cid];
            delete selectionMeta[cid];
            changed = true;
          }
        } else if (currentValueCid !== undefined) {
          delete selections[cid];
          delete selectionMeta[cid];
          changed = true;
        }
      } else if (!isCheckboxOption(opt) && selections[cid] !== undefined) {
        // Text input / non-value options should not hold a value selection.
        // Checkbox is an exception: checked state lives in selections[cid].
        delete selections[cid];
        delete selectionMeta[cid];
        changed = true;
      }
    }

    if (!changed) break;
  }

  // Final visibility pass
  const finalMemo = {};
  const visibleOptions = orderedOptions.filter((opt) =>
    isOptionVisible(String(opt.id), orderedOptions, selections, finalMemo, optionMap)
  );

  return { visibleOptions, selections };
}

function isTextInputOption(opt) {
  const t = String(opt?.type || "").toLowerCase().replace(/\s+/g, "");
  return t === "textinput";
}

function isImageUploadOption(opt) {
  const t = String(opt?.type || "").toLowerCase().replace(/\s+/g, "");
  return t === "imageupload";
}

function isCheckboxOption(opt) {
  const t = String(opt?.type || "").toLowerCase().replace(/\s+/g, "");
  return t === "checkbox";
}

function isBinaryCheckboxOption(opt) {
  if (!isCheckboxOption(opt)) return false;
  const values = Array.isArray(opt?.values) ? opt.values : [];
  return values.length <= 2;
}

function resolveUploadInputPath(uploadInput) {
  if (!uploadInput) return null;
  if (typeof uploadInput === "string") {
    return uploadInput.trim() || null;
  }
  const candidates = [uploadInput.url, uploadInput.path, uploadInput.assetPath];
  for (const c of candidates) {
    if (c !== undefined && c !== null && String(c).trim() !== "") {
      return String(c).trim();
    }
  }
  return null;
}

function resolveImageSelectionKey(value) {
  if (!value) return null;
  const candidates = [value.image_id, value.color_id];
  for (const c of candidates) {
    if (c !== undefined && c !== null && String(c) !== "") {
      return String(c);
    }
  }
  const sortId = Number(value.sort_id);
  if (Number.isFinite(sortId) && sortId > 0) {
    return String(Math.trunc(sortId));
  }
  const valueId = Number(value.id);
  if (Number.isFinite(valueId) && valueId >= 0) {
    return String(Math.trunc(valueId) + 1);
  }
  return null;
}

/**
 * Map selections to holder image selections
 * Per Blueprint §7:
 *   - functions[].type === "image", functions[].image_id → the HOLDER ID
 *   - selectedValue.image_id → the DIP KEY within that holder
 *   - functions[].type === "text", functions[].text_id → the TEXT HOLDER ID
 *   - type === "Image Upload", file_upload_image_id → the upload HOLDER ID
 *
 * @param {Object[]} visibleOptions
 * @param {Object} selections - {optionCid: valueCid}
 * @param {Object} textInputs - {optionCid: "text"}
 * @param {Object} uploadInputs - {optionCid: {url}|"/api/uploads/..."}
 * @returns {{ holderSelections: Object, textMappings: Object, uploadMappings: Object }}
 */
export function mapSelectionsToHolders(
  visibleOptions,
  selections,
  textInputs = {},
  uploadInputs = {}
) {
  const holderSelections = {}; // holderId → DIP key
  const textMappings = {}; // textHolderId → text string
  const uploadMappings = {}; // uploadHolderId → uploaded image path

  for (const opt of visibleOptions) {
    const cid = String(opt.id);
    const textInput = isTextInputOption(opt);
    const imageUploadInput = isImageUploadOption(opt);
    const checkboxInput = isCheckboxOption(opt);
    const selectedRaw = selections[cid];
    const selectedValueCid =
      selectedRaw === undefined || selectedRaw === null ? "" : String(selectedRaw);
    if (!selectedValueCid && !textInput && !imageUploadInput) continue;

    const selectedValue = opt.values?.find((v) => String(v.id) === selectedValueCid);
    const checkboxChecked =
      checkboxInput &&
      isBinaryCheckboxOption(opt) &&
      selectedValueCid !== "" &&
      selectedValueCid !== "0" &&
      selectedValueCid.toLowerCase() !== "false";
    const imageSelectionKey =
      checkboxInput && isBinaryCheckboxOption(opt)
        ? checkboxChecked
          ? String(opt.optionValue || "2")
          : resolveImageSelectionKey(selectedValue)
        : resolveImageSelectionKey(selectedValue);

    // Image binding: option.functions[].image_id = holder, value.image_id = DIP key
    if (opt.functions && imageSelectionKey) {
      for (const fn of opt.functions) {
        if (fn.type === "image" && fn.image_id) {
          holderSelections[String(fn.image_id)] = imageSelectionKey;
        }
      }
    }

    // Text binding: option.functions[].text_id = text holder
    if (opt.functions && textInput) {
      for (const fn of opt.functions) {
        if (fn.type === "text" && fn.text_id) {
          textMappings[String(fn.text_id)] = textInputs[cid] || "";
        }
      }
    }

    // Image Upload binding: option.file_upload_image_id = upload target holder
    if (imageUploadInput && opt.file_upload_image_id) {
      const uploadedPath = resolveUploadInputPath(uploadInputs[cid]);
      if (uploadedPath) {
        uploadMappings[String(opt.file_upload_image_id)] = uploadedPath;
      }
    }
  }

  return { holderSelections, textMappings, uploadMappings };
}
