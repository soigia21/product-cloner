/**
 * Preview Renderer — Server-side canvas compositing
 * Per Blueprint §8, §4, §5, §9
 * 
 * Uses system-installed fonts (copied to ~/Library/Fonts at import time)
 * and reads font family names directly from TTF metadata.
 */

import { createCanvas, loadImage, registerFont } from "canvas";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { getImage, fetchJSON } from "./image-cache.js";
import {
  computeVisibility,
  computeUiForceShowOptionIds,
  mapSelectionsToHolders,
  deriveSyntheticSelectionsFromProductConfig,
} from "./visibility-engine.js";
import { loadProduct, loadDesign } from "./customily-importer.js";

const APP_BASE = "https://app.customily.com";
const BASE_DESIGN_SIZE = 800;
const DEFAULT_OUTPUT_SIZE = 1556;
// Baseline ratio measured from Customily runtime on default script fonts.
const CUSTOMILY_TEXT_HEIGHT_TO_FONT_RATIO = 0.6613756613756613;
const TARGET_TEXT_HEIGHT_AT_FONT_100 = 100 * CUSTOMILY_TEXT_HEIGHT_TO_FONT_RATIO;
const UPLOADS_DIR = path.resolve(process.cwd(), "data", "uploads");
const UPLOADS_API_PREFIX = "/api/uploads/";

// ===== FONT NAME READER =====

/**
 * Read font family name from TTF name table (nameID=1)
 */
function readTTFFamilyName(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    const numTables = buf.readUInt16BE(4);
    for (let i = 0; i < numTables; i++) {
      const offset = 12 + i * 16;
      const tag = buf.toString("ascii", offset, offset + 4);
      if (tag === "name") {
        const tableOffset = buf.readUInt32BE(offset + 8);
        const count = buf.readUInt16BE(tableOffset + 2);
        const stringOffset = buf.readUInt16BE(tableOffset + 4);
        for (let j = 0; j < count; j++) {
          const recOff = tableOffset + 6 + j * 12;
          const platformID = buf.readUInt16BE(recOff);
          const nameID = buf.readUInt16BE(recOff + 6);
          const length = buf.readUInt16BE(recOff + 8);
          const strOff = buf.readUInt16BE(recOff + 10);
          if (nameID === 1) {
            const start = tableOffset + stringOffset + strOff;
            let name;
            if (platformID === 3 || platformID === 0) {
              let s = "";
              for (let k = 0; k < length; k += 2) {
                s += String.fromCharCode(buf.readUInt16BE(start + k));
              }
              name = s;
            } else {
              name = buf.toString("ascii", start, start + length);
            }
            if (name && name.trim()) return name.trim();
          }
        }
      }
    }
  } catch (e) {
    console.error(`   ❌ Cannot read font name: ${e.message}`);
  }
  return null;
}

// Cache: localPath → family name
const _fontNameCache = new Map();
const _registeredFamilies = new Set(); // aliases successfully registered
const _fontRatioCache = new Map(); // family -> holderHeight/fontSize ratio

function getFontFamilyName(localPath) {
  if (_fontNameCache.has(localPath)) return _fontNameCache.get(localPath);
  const name = readTTFFamilyName(localPath) || "sans-serif";
  _fontNameCache.set(localPath, name);
  return name;
}

function getRenderableFontFamily(localPath) {
  const baseFamily = getFontFamilyName(localPath);
  const familyAlias = `customily${crypto.createHash("md5").update(localPath).digest("hex").slice(0, 12)}`;

  // Prefer base family registration for consistent canvas resolution.
  if (baseFamily && _registeredFamilies.has(baseFamily)) {
    return baseFamily;
  }
  if (!baseFamily && _registeredFamilies.has(familyAlias)) {
    return familyAlias;
  }

  try {
    if (baseFamily) {
      registerFont(localPath, { family: baseFamily });
      _registeredFamilies.add(baseFamily);
      return baseFamily;
    }
    registerFont(localPath, { family: familyAlias });
    _registeredFamilies.add(familyAlias);
    return familyAlias;
  } catch (e) {
    // Don't cache failure as final fallback; retry can succeed after env/font changes.
    console.error(`   ⚠️ registerFont failed for ${path.basename(localPath)}: ${e.message}`);
  }
  return baseFamily || "sans-serif";
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

function isImageUploadOption(opt) {
  const t = String(opt?.type || "").toLowerCase().replace(/\s+/g, "");
  return t === "imageupload";
}

/**
 * Install fonts to ~/Library/Fonts for system-level availability
 * Called during product import
 */
export function installFontsToSystem(fontsMap) {
  const userFontsDir = path.join(process.env.HOME, "Library", "Fonts");
  if (!fs.existsSync(userFontsDir)) fs.mkdirSync(userFontsDir, { recursive: true });

  for (const [, localPath] of Object.entries(fontsMap || {})) {
    if (!fs.existsSync(localPath)) continue;
    const destPath = path.join(userFontsDir, path.basename(localPath));
    if (!fs.existsSync(destPath)) {
      fs.copyFileSync(localPath, destPath);
      console.log(`   🔤 Installed font: ${path.basename(localPath)} → ~/Library/Fonts/`);
    }
    // Cache metadata name + render alias
    getFontFamilyName(localPath);
    getRenderableFontFamily(localPath);
  }
}

/**
 * Pre-install all fonts from imported products
 */
export function preRegisterAllFonts() {
  const productsDir = path.resolve(process.cwd(), "data", "products");
  if (!fs.existsSync(productsDir)) return;

  for (const dir of fs.readdirSync(productsDir)) {
    const pf = path.join(productsDir, dir, "product.json");
    if (!fs.existsSync(pf)) continue;
    try {
      const product = JSON.parse(fs.readFileSync(pf, "utf-8"));
      installFontsToSystem(product.fonts);
    } catch {}
  }
  console.log(
    `🔤 Font cache: ${_fontNameCache.size} fonts, registered families: ${_registeredFamilies.size}`
  );
}

// ===== UTILITY FUNCTIONS =====

function parseDIP(dipString) {
  if (!dipString) return [];
  try { return JSON.parse(dipString); } catch {}
  const entries = [];
  const matches = dipString.matchAll(/\[(\d+),"([^"]+)"\]/g);
  for (const m of matches) entries.push([parseInt(m[1]), m[2]]);
  return entries;
}

function resolveFontHeightToSizeRatio(fontFamily, measureCtx, ratioKey = null) {
  if (!fontFamily || !measureCtx) return CUSTOMILY_TEXT_HEIGHT_TO_FONT_RATIO;
  const cacheKey = String(ratioKey || fontFamily);
  if (_fontRatioCache.has(cacheKey)) return _fontRatioCache.get(cacheKey);

  let ratio = CUSTOMILY_TEXT_HEIGHT_TO_FONT_RATIO;
  try {
    measureCtx.save();
    measureCtx.font = `100px "${fontFamily}"`;
    const m = measureCtx.measureText("Ag");
    measureCtx.restore();
    const measuredHeight = Number(m?.actualBoundingBoxAscent || 0) + Number(m?.actualBoundingBoxDescent || 0);
    if (Number.isFinite(measuredHeight) && measuredHeight > 0) {
      ratio = TARGET_TEXT_HEIGHT_AT_FONT_100 / measuredHeight;
    }
  } catch {}

  // Guard rails for broken metrics.
  if (!Number.isFinite(ratio) || ratio <= 0) {
    ratio = CUSTOMILY_TEXT_HEIGHT_TO_FONT_RATIO;
  }
  ratio = Math.max(0.45, Math.min(0.9, ratio));
  _fontRatioCache.set(cacheKey, ratio);
  return ratio;
}

function resolveFixedFontSize(holder, scaleY, fontFamily, measureCtx, ratioKey = null) {
  // Customily derives base text size from holder height with a fixed ratio,
  // then applies output scaling. This keeps clone text size aligned with
  // runtime engraver output across different daughter-count designs.
  const minSize = (holder.minSizePx || 10) * scaleY;
  const maxSize = (holder.maxSizePx || 80) * scaleY;
  const hasInit = Number.isFinite(holder.initFontSize) && holder.initFontSize > 0;
  const hasHeight = Number.isFinite(holder.height) && holder.height > 0;
  const ratio = resolveFontHeightToSizeRatio(fontFamily, measureCtx, ratioKey);
  const preferred = hasInit
    ? holder.initFontSize * scaleY
    : hasHeight
      ? holder.height * ratio * scaleY
      : maxSize;
  return Math.max(minSize, Math.min(maxSize, preferred));
}

function parseColorValue(raw, fallback = "#000000") {
  if (!raw) return fallback;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed?.hex || fallback;
    } catch {
      return raw;
    }
  }
  return raw?.hex || fallback;
}

function resolveScaledLineWidth(rawWidth, scaleY) {
  const width = Number(rawWidth);
  if (!Number.isFinite(width) || width <= 0) return 0;
  const scaled = width * (Number.isFinite(scaleY) && scaleY > 0 ? scaleY : 1);
  return Math.max(1, scaled);
}

function resolveOutputSize(previewWidth) {
  const envSize = Number(process.env.CUSTOMILY_RENDER_SIZE);
  if (Number.isFinite(envSize) && envSize > 0) return Math.round(envSize);
  return DEFAULT_OUTPUT_SIZE;
}

function isUuid(value) {
  return /^[a-f0-9-]{36}$/i.test(String(value || ""));
}

function extractVariantUuidsFromProductConfig(productConfig = {}) {
  const out = [];
  const seen = new Set();
  for (const variation of productConfig?.variations || []) {
    for (const val of variation?.values || []) {
      const uuid = String(val?.product_id || "").trim();
      if (!isUuid(uuid) || seen.has(uuid)) continue;
      seen.add(uuid);
      out.push(uuid);
    }
  }
  return out;
}

function listLocalDesignUuids(productId) {
  const designsDir = path.resolve(process.cwd(), "data", "products", String(productId), "designs");
  if (!fs.existsSync(designsDir)) return [];
  const out = [];
  for (const file of fs.readdirSync(designsDir)) {
    if (!file.endsWith(".json")) continue;
    const uuid = path.basename(file, ".json");
    if (isUuid(uuid)) out.push(uuid);
  }
  return out;
}

function resolveDesignUUID(productId, product, selections, visibleOptions = null) {
  const localUuids = listLocalDesignUuids(productId);
  const pickUuid = (uuid) => {
    return isUuid(uuid) ? String(uuid).trim() : null;
  };
  const optionHasDesignPointer = (opt) => {
    return opt?.functions?.some((f) => f.type === "product");
  };
  const resolveValueUuid = (val) => {
    const fromProductId = pickUuid(val?.product_id);
    if (fromProductId) return fromProductId;
    return pickUuid(val?.value ? product.variantDesigns?.[val.value] : null);
  };

  const scopedOptions = Array.isArray(visibleOptions) && visibleOptions.length > 0
    ? visibleOptions
    : (product.options || []);
  const pointerOptions = scopedOptions.filter((opt) => optionHasDesignPointer(opt));
  const hasExplicitProductSwitch = pointerOptions.length > 0;

  for (const opt of pointerOptions) {

    const selectedCid = selections[String(opt.id)];
    if (selectedCid !== undefined && selectedCid !== null && selectedCid !== "") {
      const val = opt.values?.find((v) => String(v.id) === String(selectedCid));
      const selectedUuid = resolveValueUuid(val);
      if (selectedUuid) return selectedUuid;
    }

    const preselected = opt.values?.find((v) => v?.selected === true);
    const preselectedUuid = resolveValueUuid(preselected);
    if (preselectedUuid) return preselectedUuid;
  }

  // Safe fallback: only when there is exactly one visible explicit product-switch option.
  // This avoids picking unrelated product_id values from other hidden/conditional options.
  if (pointerOptions.length === 1) {
    const onlyPointer = pointerOptions[0];
    const firstWithPointer = onlyPointer.values?.find((v) => resolveValueUuid(v));
    const firstPointerUuid = resolveValueUuid(firstWithPointer);
    if (firstPointerUuid) return firstPointerUuid;
  }

  const uuids = Object.values(product.variantDesigns || {})
    .map((x) => pickUuid(x))
    .filter(Boolean);
  const fromDefault = pickUuid(product?.defaultDesignUUID);
  // Some products expose stale defaultDesignUUID that belongs to another template.
  // Only prefer variantDesigns over default when there is an explicit product-switch option.
  if (fromDefault && (uuids.length === 0 || !hasExplicitProductSwitch || uuids.includes(fromDefault))) return fromDefault;
  if (uuids.length > 0) return uuids[0];
  if (fromDefault) return fromDefault;

  const cfgUuids = extractVariantUuidsFromProductConfig(product?.productConfig || {});
  const fromCfg = cfgUuids
    .map((x) => pickUuid(x))
    .filter(Boolean)[0];
  if (fromCfg) return fromCfg;

  if (localUuids.length > 0) return localUuids[0];
  return null;
}

async function loadDesignWithRemoteFallback(productId, designUUID) {
  const local = loadDesign(productId, designUUID);
  if (local) return local;
  if (!isUuid(designUUID)) return null;

  try {
    const fetched = await fetchJSON(
      `${APP_BASE}/api/Product/GetProduct?productId=${encodeURIComponent(designUUID)}&clientVersion=3.10.85&useListEPS=true`
    );
    if (!fetched || typeof fetched !== "object") return null;

    const designsDir = path.resolve(process.cwd(), "data", "products", String(productId), "designs");
    if (!fs.existsSync(designsDir)) fs.mkdirSync(designsDir, { recursive: true });
    const designFile = path.join(designsDir, `${designUUID}.json`);
    fs.writeFileSync(designFile, JSON.stringify(fetched, null, 2));
    return fetched;
  } catch {
    return null;
  }
}

function resolveTraceFontUrl(productId, product, fontPath) {
  if (!fontPath) return null;
  const localPath = product?.fonts?.[fontPath];
  if (!localPath) return null;
  const fname = path.basename(localPath);
  return `/api/products/${encodeURIComponent(productId)}/fonts/${encodeURIComponent(fname)}`;
}

function resolveImageDrawRect(imgW, imgH, boxW, boxH, fitMode = "contain") {
  const safeImgW = Number.isFinite(imgW) && imgW > 0 ? imgW : boxW;
  const safeImgH = Number.isFinite(imgH) && imgH > 0 ? imgH : boxH;
  const safeBoxW = Number.isFinite(boxW) && boxW > 0 ? boxW : safeImgW;
  const safeBoxH = Number.isFinite(boxH) && boxH > 0 ? boxH : safeImgH;
  const sx = safeBoxW / safeImgW;
  const sy = safeBoxH / safeImgH;
  const scale = fitMode === "cover" ? Math.max(sx, sy) : Math.min(sx, sy);
  return {
    drawW: safeImgW * scale,
    drawH: safeImgH * scale,
    boxW: safeBoxW,
    boxH: safeBoxH,
  };
}

function resolveUploadedLocalPath(publicPath) {
  const raw = String(publicPath || "");
  if (!raw.startsWith(UPLOADS_API_PREFIX)) return null;
  let relPath = raw.slice(UPLOADS_API_PREFIX.length);
  try {
    relPath = decodeURIComponent(relPath);
  } catch {}
  const absPath = path.resolve(UPLOADS_DIR, relPath);
  if (!absPath.startsWith(UPLOADS_DIR)) return null;
  return absPath;
}

async function resolveRenderableImageFile(assetPath) {
  const uploadedLocal = resolveUploadedLocalPath(assetPath);
  if (uploadedLocal && fs.existsSync(uploadedLocal)) {
    return uploadedLocal;
  }
  return getImage(assetPath);
}

function buildBoundImageHolderSet(options = []) {
  const bound = new Set();
  for (const opt of options) {
    for (const fn of opt.functions || []) {
      if (fn.type === "image" && fn.image_id) {
        bound.add(String(fn.image_id));
      }
    }
    if (isImageUploadOption(opt) && opt.file_upload_image_id) {
      bound.add(String(opt.file_upload_image_id));
    }
  }
  return bound;
}

function normalizeDipKey(rawKey) {
  const n = Number(rawKey);
  if (!Number.isFinite(n) || n <= 0) return null;
  return String(Math.trunc(n));
}

function mergeDipEntries(currentEntries = [], fetchedEntries = []) {
  const merged = new Map();
  for (const entry of currentEntries || []) {
    const key = normalizeDipKey(entry?.[0]);
    if (!key) continue;
    merged.set(key, [Number(key), entry[1]]);
  }
  for (const entry of fetchedEntries || []) {
    const key = normalizeDipKey(entry?.[0]);
    if (!key) continue;
    merged.set(key, [Number(key), entry[1]]);
  }
  return [...merged.values()].sort((a, b) => a[0] - b[0]);
}

async function fetchLibraryEntriesByPositions(libraryId, positions = []) {
  const normalized = [...new Set((positions || [])
    .map((raw) => Number(raw))
    .filter((n) => Number.isFinite(n) && n > 0)
    .map((n) => Math.trunc(n))
  )].sort((a, b) => a - b);
  if (normalized.length === 0) return [];

  const results = await Promise.all(
    normalized.map((pos) =>
      fetchJSON(`${APP_BASE}/api/Libraries/${libraryId}/Elements/Position/${pos}`)
        .then((data) => (data && data.ImageId ? [pos, data.Path] : null))
        .catch(() => null)
    )
  );
  return results.filter(Boolean);
}

async function hydrateMissingLibraryDipEntries(
  product,
  imageHolders = [],
  holderSelections = {},
  holderSelectionCandidates = {}
) {
  const missingByLibrary = new Map();
  const holdersByLibrary = new Map();

  for (const holder of imageHolders || []) {
    const libraryId = String(holder?.imageLibraryId || "").trim();
    if (!libraryId) continue;
    const holderId = String(holder.id);

    const keys = [];
    const selectedKey = normalizeDipKey(holderSelections?.[holderId]);
    if (selectedKey) keys.push(selectedKey);
    for (const rawCandidate of holderSelectionCandidates?.[holderId] || []) {
      const candidate = normalizeDipKey(rawCandidate);
      if (!candidate) continue;
      if (!keys.includes(candidate)) keys.push(candidate);
    }
    if (keys.length === 0) continue;

    const existing = new Set((holder._dip || [])
      .map((entry) => normalizeDipKey(entry?.[0]))
      .filter(Boolean)
    );

    for (const key of keys) {
      if (existing.has(key)) continue;
      if (!missingByLibrary.has(libraryId)) {
        missingByLibrary.set(libraryId, new Set());
      }
      missingByLibrary.get(libraryId).add(Number(key));
    }

    if (!holdersByLibrary.has(libraryId)) {
      holdersByLibrary.set(libraryId, []);
    }
    holdersByLibrary.get(libraryId).push(holder);
  }

  if (missingByLibrary.size === 0) return;

  const fetchedByLibrary = await Promise.all(
    [...missingByLibrary.entries()].map(async ([libraryId, positionsSet]) => {
      const fetched = await fetchLibraryEntriesByPositions(libraryId, [...positionsSet]);
      return [libraryId, fetched];
    })
  );

  for (const [libraryId, fetched] of fetchedByLibrary) {
    if (!fetched || fetched.length === 0) continue;
    for (const holder of holdersByLibrary.get(libraryId) || []) {
      holder._dip = mergeDipEntries(holder._dip || [], fetched);
    }
    if (!product.libraryDIPs) product.libraryDIPs = {};
    product.libraryDIPs[libraryId] = mergeDipEntries(product.libraryDIPs[libraryId] || [], fetched);
  }
}

function resolveSelectedImagePath(
  holder,
  holderSelections,
  holderSelectionCandidates,
  boundHolderIds,
  uploadMappings = {},
  settings = {}
) {
  const hid = String(holder.id);
  const uploadedPath = uploadMappings?.[hid];
  if (uploadedPath) {
    const uploadShouldCover =
      Boolean(settings?.uploadedImageCovers) ||
      Boolean(holder?.coverMaskArea) ||
      Boolean(holder?.maskPath);
    return {
      selDipKey: null,
      selectedPath: uploadedPath,
      selectedSource: "upload",
      fitMode: uploadShouldCover ? "cover" : "contain",
    };
  }

  const rawSelectedDipKey = holderSelections[hid];
  let selDipKey =
    rawSelectedDipKey !== undefined && rawSelectedDipKey !== null && String(rawSelectedDipKey) !== ""
      ? String(rawSelectedDipKey)
      : null;
  let selectedPath = null;
  let selectedSource = null;
  const dipEntries = holder._dip || [];
  const candidateKeys = [];
  if (selDipKey) candidateKeys.push(selDipKey);
  const extraCandidates = Array.isArray(holderSelectionCandidates?.[hid])
    ? holderSelectionCandidates[hid]
    : [];
  for (const rawCandidate of extraCandidates) {
    const candidate = String(rawCandidate || "").trim();
    if (!candidate) continue;
    if (candidateKeys.includes(candidate)) continue;
    candidateKeys.push(candidate);
  }

  if (candidateKeys.length > 0) {
    for (let idx = 0; idx < candidateKeys.length; idx++) {
      const candidate = candidateKeys[idx];
      const entry = dipEntries.find((e) => parseInt(e[0]) === parseInt(candidate));
      if (entry) {
        selectedPath = entry[1];
        selDipKey = String(entry[0]);
        selectedSource = idx === 0 ? "dip" : "dip-fallback";
        break;
      }
    }
  }

  if (!selectedPath && !boundHolderIds.has(hid) && dipEntries.length > 0) {
    selectedPath = dipEntries[0]?.[1] || null;
    if (selectedPath) selectedSource = "fallback";
  }

  return {
    selDipKey,
    selectedPath,
    selectedSource,
    fitMode: holder.coverMaskArea ? "cover" : "contain",
  };
}

function normalizeUploadTransform(raw = {}) {
  const offsetX = Number(raw?.offsetX);
  const offsetY = Number(raw?.offsetY);
  const scale = Number(raw?.scale);
  const rotation = Number(raw?.rotation);
  return {
    offsetX: Number.isFinite(offsetX) ? offsetX : 0,
    offsetY: Number.isFinite(offsetY) ? offsetY : 0,
    scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
    rotation: Number.isFinite(rotation) ? rotation : 0,
  };
}

async function drawImageWithMask({
  ctx,
  img,
  maskImg = null,
  boxW,
  boxH,
  drawW,
  drawH,
  offsetX = 0,
  offsetY = 0,
  rotation = 0,
}) {
  if (!maskImg) {
    ctx.save();
    ctx.translate(offsetX, offsetY);
    if (rotation) ctx.rotate((rotation * Math.PI) / 180);
    ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
    ctx.restore();
    return;
  }

  const layerCanvas = createCanvas(Math.max(1, Math.round(boxW)), Math.max(1, Math.round(boxH)));
  const lctx = layerCanvas.getContext("2d");
  const lcw = layerCanvas.width;
  const lch = layerCanvas.height;
  lctx.translate(lcw / 2 + offsetX, lch / 2 + offsetY);
  if (rotation) lctx.rotate((rotation * Math.PI) / 180);
  lctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
  lctx.setTransform(1, 0, 0, 1, 0, 0);
  lctx.globalCompositeOperation = "destination-in";
  lctx.drawImage(maskImg, 0, 0, lcw, lch);
  lctx.globalCompositeOperation = "source-over";
  ctx.drawImage(layerCanvas, -boxW / 2, -boxH / 2, boxW, boxH);
}

// ===== MAIN RENDER =====

export async function renderPreview(
  productId,
  selections = {},
  textInputs = {},
  uploadInputs = {},
  uploadTransforms = {},
  config = {}
) {
  const product = loadProduct(productId);
  if (!product) throw new Error(`Product not found: ${productId}`);

  const synthetic = deriveSyntheticSelectionsFromProductConfig(product.productConfig || {});
  // Resolve visibility/defaults first so design UUID follows the same finalized selections.
  const { visibleOptions, selections: finalSelections } = computeVisibility(product.options, selections, {
    userSelectedOptionIds: config?.userSelectedOptionIds || null,
    syntheticSelections: synthetic.selections,
    syntheticAnchoredOptionIds: synthetic.anchoredOptionIds,
  });

  const designUUID = resolveDesignUUID(productId, product, finalSelections, visibleOptions);
  if (!designUUID) throw new Error("No design UUID found");

  const design = await loadDesignWithRemoteFallback(productId, designUUID);
  if (!design) throw new Error(`Design not found: ${designUUID}`);

  const preview = design.preview;
  const designWidth = Number(preview?.width) || BASE_DESIGN_SIZE;
  const designHeight = Number(preview?.height) || BASE_DESIGN_SIZE;
  const outputWidth = resolveOutputSize(designWidth);
  const outputHeight = Math.max(1, Math.round((designHeight / designWidth) * outputWidth));
  const scaleX = outputWidth / designWidth;
  const scaleY = outputHeight / designHeight;

  // Build fontPath → system font family name map
  const fontFamilyMap = {};
  for (const [fontPath, localPath] of Object.entries(product.fonts || {})) {
    fontFamilyMap[fontPath] = getRenderableFontFamily(localPath);
  }

  const { holderSelections, holderSelectionCandidates, textMappings, uploadMappings } = mapSelectionsToHolders(
    visibleOptions,
    finalSelections,
    textInputs,
    uploadInputs
  );

  // Create canvas
  const canvas = createCanvas(outputWidth, outputHeight);
  const ctx = canvas.getContext("2d");

  // Background
  if (preview.bgColor) {
    ctx.fillStyle = preview.bgColor;
    ctx.fillRect(0, 0, outputWidth, outputHeight);
  }
  if (preview.imagePath) {
    try {
      const localFile = await resolveRenderableImageFile(preview.imagePath);
      const bgImg = await loadImage(localFile);
      ctx.drawImage(bgImg, 0, 0, outputWidth, outputHeight);
    } catch (e) {
      console.error(`   ⚠️ Failed to render base image: ${e.message}`);
    }
  }

  // Collect holders
  const imageHolders = (preview.imagePlaceHoldersPreview || []).map((h) => ({ ...h, _type: "image" }));
  const textHolders = (preview.textsPreview || []).map((h) => ({ ...h, _type: "text" }));

  // Parse DIP
  for (const holder of imageHolders) {
    holder._dip = parseDIP(holder.dynamicImagesPath);
    if (holder.imageLibraryId && product.libraryDIPs?.[holder.imageLibraryId]) {
      holder._dip = product.libraryDIPs[holder.imageLibraryId];
    }
  }
  await hydrateMissingLibraryDipEntries(
    product,
    imageHolders,
    holderSelections,
    holderSelectionCandidates
  );

  const boundHolderIds = buildBoundImageHolderSet(product.options || []);

  // Render all layers by zIndex (images + text mixed, same as original stack order)
  const allLayers = [...imageHolders, ...textHolders].sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));
  const textPlanByHolderId = {};

  // Pre-compute text sizes per holder (exact holder mapping, no cross-holder remap).
  const draftTextPlans = [];
  for (const holder of textHolders) {
    if (holder.visible === false) continue;
    const hid = String(holder.id);
    const text = textMappings[hid];
    if (!text) continue;

    let fontFamily = "sans-serif";
    if (holder.fontPath && fontFamilyMap[holder.fontPath]) {
      fontFamily = fontFamilyMap[holder.fontPath];
    }

    const boxW = holder.width * scaleX;
    const minSize = (holder.minSizePx || 10) * scaleY;
    const maxSize = (holder.maxSizePx || 80) * scaleY;
    const fontSize = resolveFixedFontSize(
      holder,
      scaleY,
      fontFamily,
      ctx,
      holder.fontPath || fontFamily
    );

    draftTextPlans.push({
      holder,
      hid,
      text,
      fontFamily,
      minSize,
      maxSize,
      fontSize,
      boxW,
    });
  }

  for (const p of draftTextPlans) {
    textPlanByHolderId[p.hid] = {
      ...p,
      normalizedFontFamily: p.fontFamily,
      normalizedSize: p.fontSize,
    };
  }

  for (const holder of allLayers) {
    if (holder._type === "image") {
      if (holder.visible === false) continue;

      const hid = String(holder.id);
      const { selectedPath: imgPath, fitMode, selectedSource } = resolveSelectedImagePath(
        holder,
        holderSelections,
        holderSelectionCandidates,
        boundHolderIds,
        uploadMappings,
        product.settings || {}
      );

      if (!imgPath) continue;

      try {
        const localFile = await resolveRenderableImageFile(imgPath);
        const img = await loadImage(localFile);
        const maskFile = holder.maskPath ? await resolveRenderableImageFile(holder.maskPath).catch(() => null) : null;
        const maskImg = maskFile ? await loadImage(maskFile).catch(() => null) : null;

        const cx = holder.centerX * scaleX;
        const cy = holder.centerY * scaleY;
        const boxW = holder.width * scaleX;
        const boxH = holder.height * scaleY;
        const uploadTransform = selectedSource === "upload"
          ? normalizeUploadTransform(uploadTransforms?.[hid] || {})
          : normalizeUploadTransform({});
        const { drawW, drawH } = resolveImageDrawRect(img.width, img.height, boxW, boxH, fitMode);
        const drawWWithScale = drawW * uploadTransform.scale;
        const drawHWithScale = drawH * uploadTransform.scale;
        const offsetX = uploadTransform.offsetX * scaleX;
        const offsetY = uploadTransform.offsetY * scaleY;

        ctx.save();
        ctx.translate(cx, cy);
        if (holder.rotation) ctx.rotate((holder.rotation * Math.PI) / 180);
        if (holder.opacity !== undefined && holder.opacity !== 1) ctx.globalAlpha = holder.opacity;
        if (holder.isLimitImageToPlaceholder || holder.coverMaskArea || holder.clipPath) {
          ctx.beginPath();
          ctx.rect(-boxW / 2, -boxH / 2, boxW, boxH);
          ctx.clip();
        }
        await drawImageWithMask({
          ctx,
          img,
          maskImg,
          boxW,
          boxH,
          drawW: drawWWithScale,
          drawH: drawHWithScale,
          offsetX,
          offsetY,
          rotation: uploadTransform.rotation,
        });
        ctx.restore();
      } catch (e) {
        console.error(`   ⚠️ Failed to render holder ${hid}: ${e.message}`);
      }
      continue;
    }

    // Text layer
    if (holder.visible === false) continue;

    const hid = String(holder.id);
    const plan = textPlanByHolderId[hid];
    if (!plan) continue;

    const cx = holder.centerX * scaleX;
    const cy = holder.centerY * scaleY;
    const boxW = plan.boxW;

    const fontFamily = plan.normalizedFontFamily;
    const text = holder.caps ? String(plan.text || "").toUpperCase() : String(plan.text || "");
    if (!text) continue;

    const color = parseColorValue(holder.color, "#000000");
    const outlineColor = parseColorValue(holder.outlineColor, color);
    const strokeColor = parseColorValue(holder.strokeColor, "#000000");
    const outlineWidth = resolveScaledLineWidth(holder.outlineWidth, scaleY);
    const strokeWidth = resolveScaledLineWidth(holder.strokeWidth, scaleY);

    const fontSize = plan.normalizedSize;

    ctx.save();
    ctx.translate(cx, cy);
    if (holder.rotation) ctx.rotate((holder.rotation * Math.PI) / 180);
    if (holder.opacity !== undefined && holder.opacity !== 1) ctx.globalAlpha = holder.opacity;

    ctx.font = `${fontSize}px "${fontFamily}"`;
    ctx.fillStyle = color;
    ctx.textBaseline = "middle";
    ctx.textAlign = holder.textAlign || "center";

    let textX = 0;
    if (holder.textAlign === "left") textX = -boxW / 2;
    else if (holder.textAlign === "right") textX = boxW / 2;

    if (outlineWidth > 0) {
      ctx.lineJoin = "round";
      ctx.miterLimit = 2;
      ctx.lineWidth = outlineWidth;
      ctx.strokeStyle = outlineColor;
      ctx.strokeText(text, textX, 0);
    }

    if (strokeWidth > 0) {
      ctx.lineJoin = "round";
      ctx.miterLimit = 2;
      ctx.lineWidth = strokeWidth;
      ctx.strokeStyle = strokeColor;
      ctx.strokeText(text, textX, 0);
    }

    ctx.fillText(text, textX, 0);
    ctx.restore();
  }

  return canvas.toBuffer("image/png");
}

/**
 * Debug trace: expose workflow internals for one render request.
 * Used to diff clone workflow vs expected Customily behavior.
 */
export async function getWorkflowTrace(productId, selections = {}, textInputs = {}, config = {}) {
  const product = loadProduct(productId);
  if (!product) throw new Error(`Product not found: ${productId}`);

  const synthetic = deriveSyntheticSelectionsFromProductConfig(product.productConfig || {});
  const { visibleOptions, selections: finalSelections } = computeVisibility(product.options, selections, {
    ...config,
    syntheticSelections: synthetic.selections,
    syntheticAnchoredOptionIds: synthetic.anchoredOptionIds,
  });
  const uiForceShowOptionIds = computeUiForceShowOptionIds(product.options, finalSelections, {
    ...config,
    syntheticSelections: synthetic.selections,
    syntheticAnchoredOptionIds: synthetic.anchoredOptionIds,
    textInputs,
    uploadInputs: config?.uploadInputs || {},
  });
  const designUUID = resolveDesignUUID(productId, product, finalSelections, visibleOptions);
  if (!designUUID) throw new Error("No design UUID found");

  const design = await loadDesignWithRemoteFallback(productId, designUUID);
  if (!design) throw new Error(`Design not found: ${designUUID}`);

  const preview = design.preview;
  const designWidth = Number(preview?.width) || BASE_DESIGN_SIZE;
  const designHeight = Number(preview?.height) || BASE_DESIGN_SIZE;
  const outputWidth = resolveOutputSize(designWidth);
  const outputHeight = Math.max(1, Math.round((designHeight / designWidth) * outputWidth));
  const scaleX = outputWidth / designWidth;
  const scaleY = outputHeight / designHeight;
  const uploadInputs = config?.uploadInputs || {};
  const uploadTransforms = config?.uploadTransforms || {};

  const { holderSelections, holderSelectionCandidates, textMappings, uploadMappings } = mapSelectionsToHolders(
    visibleOptions,
    finalSelections,
    textInputs,
    uploadInputs
  );
  const imageHolders = (preview.imagePlaceHoldersPreview || []).map((h) => ({ ...h, _dip: parseDIP(h.dynamicImagesPath) }));
  const textHolders = preview.textsPreview || [];

  for (const holder of imageHolders) {
    if (holder.imageLibraryId && product.libraryDIPs?.[holder.imageLibraryId]) {
      holder._dip = product.libraryDIPs[holder.imageLibraryId];
    }
  }
  await hydrateMissingLibraryDipEntries(
    product,
    imageHolders,
    holderSelections,
    holderSelectionCandidates
  );

  const boundHolderIds = buildBoundImageHolderSet(product.options || []);

  const imagePlan = imageHolders.map((holder) => {
    const hid = String(holder.id);
    const { selDipKey, selectedPath, selectedSource, fitMode } = resolveSelectedImagePath(
      holder,
      holderSelections,
      holderSelectionCandidates,
      boundHolderIds,
      uploadMappings,
      product.settings || {}
    );

    return {
      holderId: hid,
      zIndex: holder.zIndex || 0,
      visible: holder.visible !== false,
      centerX: holder.centerX,
      centerY: holder.centerY,
      width: holder.width,
      height: holder.height,
      rotation: holder.rotation || 0,
      opacity: holder.opacity !== undefined ? holder.opacity : 1,
      selectedDipKey: selDipKey || null,
      selectedPath,
      selectedSource,
      fitMode,
      maskPath: holder.maskPath || null,
      limitToPlaceholder: Boolean(holder.isLimitImageToPlaceholder),
      coverMaskArea: Boolean(holder.coverMaskArea),
      hasClipPath: Boolean(holder.clipPath),
      uploadTransform: normalizeUploadTransform(uploadTransforms?.[hid] || {}),
    };
  });

  const textPlan = textHolders.map((holder) => {
    const hid = String(holder.id);
    const fontPath = holder.fontPath || null;
    return {
      holderId: hid,
      zIndex: holder.zIndex || 0,
      visible: holder.visible !== false,
      centerX: holder.centerX,
      centerY: holder.centerY,
      width: holder.width,
      height: holder.height,
      rotation: holder.rotation || 0,
      fontPath,
      fontUrl: resolveTraceFontUrl(productId, product, fontPath),
      text: textMappings[hid] || "",
      minSizePx: holder.minSizePx,
      maxSizePx: holder.maxSizePx,
      initFontSize: holder.initFontSize,
      textAlign: holder.textAlign || "center",
      caps: Boolean(holder.caps),
      color: holder.color || "#000000",
      outlineWidth: holder.outlineWidth ?? 0,
      outlineColor: holder.outlineColor || null,
      strokeWidth: holder.strokeWidth ?? 0,
      strokeColor: holder.strokeColor || null,
      opacity: holder.opacity !== undefined ? holder.opacity : 1,
    };
  });

  return {
    productId,
    designUUID,
    canvas: {
      designWidth,
      designHeight,
      outputWidth,
      outputHeight,
      scaleX,
      scaleY,
      bgColor: preview?.bgColor || null,
      imagePath: preview?.imagePath || null,
    },
    visibleOptionIds: visibleOptions.map((o) => String(o.id)),
    uiForceShowOptionIds: uiForceShowOptionIds.map((id) => String(id)),
    finalSelections,
    holderSelections,
    uploadMappings,
    uploadTransforms,
    textMappings,
    imagePlan,
    textPlan,
  };
}
