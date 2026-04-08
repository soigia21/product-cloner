import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import CustomizerForm from "./components/CustomizerForm.jsx";
import "./customizer.css";

// Measured from Customily runtime (engraver textObject.getFontSize / holder.height).
const CUSTOMILY_TEXT_HEIGHT_TO_FONT_RATIO = 0.6613756613756613;
const TARGET_TEXT_HEIGHT_AT_FONT_100 = 100 * CUSTOMILY_TEXT_HEIGHT_TO_FONT_RATIO;

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Không thể đọc file ảnh"));
    reader.readAsDataURL(file);
  });
}

const DEFAULT_UPLOAD_TRANSFORM = Object.freeze({
  offsetX: 0,
  offsetY: 0,
  scale: 1,
  rotation: 0,
});

function stripHtml(raw) {
  return String(raw || "")
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function inferImportLinkType(rawUrl) {
  const value = String(rawUrl || "").trim();
  if (!value) return "unknown";
  try {
    const parsed = new URL(value);
    const path = String(parsed.pathname || "");
    if (/\/products\/[^/?#]+/i.test(path)) return "product";
    if (/\/collections\/[^/?#]+/i.test(path)) return "collection";
    return "unknown";
  } catch {
    return "unknown";
  }
}

function normalizeUploadTransform(raw) {
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

function ZoomGlyph({ mode = "minus" }) {
  const isPlus = mode === "plus";
  return (
    <svg className="zoom-glyph" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="10" cy="10" r="6.25" />
      <line x1="14.6" y1="14.6" x2="20.25" y2="20.25" />
      <line x1="7" y1="10" x2="13" y2="10" />
      {isPlus ? <line x1="10" y1="7" x2="10" y2="13" /> : null}
    </svg>
  );
}

/**
 * CustomizerPage — Main 2-column layout
 * Left: Live preview (server-rendered)
 * Right: Dynamic customizer form
 */
export default function CustomizerPage() {
  const embeddedContext = useMemo(() => {
    if (typeof window === "undefined") {
      return {
        embedded: false,
        templateId: "",
        productId: "",
        handle: "",
      };
    }
    const qs = new URLSearchParams(window.location.search);
    return {
      embedded:
        ["1", "true", "yes", "on"].includes(String(qs.get("embedded") || "").toLowerCase()),
      templateId: String(qs.get("template_id") || "").trim(),
      productId: String(qs.get("product_id") || "").trim(),
      handle: String(qs.get("handle") || "").trim(),
    };
  }, []);
  const isEmbedded = Boolean(embeddedContext.embedded);

  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const body = document.body;
    const html = document.documentElement;
    if (!body || !html) return undefined;

    if (isEmbedded) {
      body.classList.add("pz-embedded-body");
      html.classList.add("pz-embedded-html");
    } else {
      body.classList.remove("pz-embedded-body");
      html.classList.remove("pz-embedded-html");
    }

    return () => {
      body.classList.remove("pz-embedded-body");
      html.classList.remove("pz-embedded-html");
    };
  }, [isEmbedded]);

  const [importUrl, setImportUrl] = useState("");
  const [importing, setImporting] = useState(false);
  const [inspectingLink, setInspectingLink] = useState(false);
  const [batchImporting, setBatchImporting] = useState(false);
  const [importTarget, setImportTarget] = useState(null);
  const [collectionChecks, setCollectionChecks] = useState({});
  const [collectionImportResults, setCollectionImportResults] = useState({});
  const [collectionResultFilter, setCollectionResultFilter] = useState("all");
  const [batchProgress, setBatchProgress] = useState(null);
  const [importPublish, setImportPublish] = useState(false);
  const [importVendor, setImportVendor] = useState("");
  const [importCategory, setImportCategory] = useState("");
  const [adminView, setAdminView] = useState("import");
  const [savingDraft, setSavingDraft] = useState(false);
  const [publishingProduct, setPublishingProduct] = useState(false);
  const [cleaningOld, setCleaningOld] = useState(false);
  const [deletingProductId, setDeletingProductId] = useState(null);
  const [products, setProducts] = useState([]);
  const [activeProduct, setActiveProduct] = useState(null);
  const [activeProductMeta, setActiveProductMeta] = useState(null);
  const [activeImageIndex, setActiveImageIndex] = useState(0);
  const [storeInfo, setStoreInfo] = useState(null);

  // Customizer state
  const [options, setOptions] = useState([]);
  const [visibleOptionIds, setVisibleOptionIds] = useState([]);
  const [uiForceShowOptionIds, setUiForceShowOptionIds] = useState([]);
  const [selections, setSelections] = useState({});
  const [userSelections, setUserSelections] = useState({});
  const [textInputs, setTextInputs] = useState({});
  const [uploadInputs, setUploadInputs] = useState({});
  const [uploadingUploadOptionIds, setUploadingUploadOptionIds] = useState({});
  const [uploadTransforms, setUploadTransforms] = useState({});
  const [focusedUploadOptionId, setFocusedUploadOptionId] = useState(null);

  // Preview state
  const [previewLoading, setPreviewLoading] = useState(false);
  const [hasCanvasFrame, setHasCanvasFrame] = useState(false);
  const [previewAspectRatio, setPreviewAspectRatio] = useState(1);
  const previewTimerRef = useRef(null);
  const canvasRef = useRef(null);
  const previewRequestRef = useRef(0);
  const previewAbortRef = useRef(null);
  const cloneSummaryRef = useRef(null);
  const imagePromiseCacheRef = useRef(new Map());
  const imageMetaByPathRef = useRef(new Map());
  const fontFamilyCacheRef = useRef(new Map());
  const fontHeightRatioCacheRef = useRef(new Map());
  const latestTraceRef = useRef(null);
  const draggingRef = useRef(null);
  const resizeRef = useRef(null);
  const rotateRef = useRef(null);
  const lastParentPreviewTsRef = useRef(0);
  const sentParentInteractionRef = useRef(false);

  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const resolveEmbeddedTemplateId = useCallback(async () => {
    if (!isEmbedded) return "";
    if (embeddedContext.templateId) return embeddedContext.templateId;

    if (!embeddedContext.productId && !embeddedContext.handle) return "";
    try {
      const qs = new URLSearchParams();
      if (embeddedContext.productId) qs.set("product_id", embeddedContext.productId);
      if (embeddedContext.handle) qs.set("handle", embeddedContext.handle);
      const res = await fetch(`/api/storefront/template?${qs.toString()}`);
      const data = await res.json();
      if (!res.ok || !data?.success || !data?.templateId) return "";
      return String(data.templateId);
    } catch {
      return "";
    }
  }, [isEmbedded, embeddedContext.templateId, embeddedContext.productId, embeddedContext.handle]);

  const activeProductRecord = useMemo(
    () => products.find((p) => String(p.id) === String(activeProduct || "")) || null,
    [products, activeProduct]
  );
  const activeClonedProduct = activeProductMeta?.clonedProduct || null;
  const activeClonedImages = Array.isArray(activeClonedProduct?.images) ? activeClonedProduct.images : [];
  const activeClonedVariants = Array.isArray(activeClonedProduct?.variants) ? activeClonedProduct.variants : [];
  const activeClonedOptions = Array.isArray(activeClonedProduct?.options) ? activeClonedProduct.options : [];
  const safeActiveImageIndex = Math.min(
    Math.max(Number(activeImageIndex) || 0, 0),
    Math.max(activeClonedImages.length - 1, 0)
  );
  const activeMainImage = activeClonedImages[safeActiveImageIndex] || activeClonedImages[0] || null;
  const activeFirstVariant = activeClonedVariants[0] || null;
  const activeDescriptionText = stripHtml(activeClonedProduct?.bodyHtml || "");
  const importLinkTypeHint = useMemo(() => inferImportLinkType(importUrl), [importUrl]);
  const collectionProducts = useMemo(
    () => (importTarget?.type === "collection" ? (importTarget.products || []) : []),
    [importTarget]
  );
  const filteredCollectionProducts = useMemo(() => {
    const mode = String(collectionResultFilter || "all");
    if (mode === "all") return collectionProducts;
    if (mode === "success") {
      return collectionProducts.filter((p) => String(collectionImportResults[String(p?.url || "")]?.status || "") === "success");
    }
    if (mode === "failed") {
      return collectionProducts.filter((p) => String(collectionImportResults[String(p?.url || "")]?.status || "") === "failed");
    }
    return collectionProducts;
  }, [collectionProducts, collectionImportResults, collectionResultFilter]);
  const collectionResultStats = useMemo(() => {
    let success = 0;
    let failed = 0;
    for (const product of collectionProducts) {
      const url = String(product?.url || "");
      const status = String(collectionImportResults[url]?.status || "");
      if (status === "success") success += 1;
      if (status === "failed") failed += 1;
    }
    return {
      all: collectionProducts.length,
      success,
      failed,
    };
  }, [collectionProducts, collectionImportResults]);
  const selectedCollectionCount = useMemo(() => {
    if (!Array.isArray(filteredCollectionProducts) || filteredCollectionProducts.length === 0) return 0;
    let count = 0;
    for (const p of filteredCollectionProducts) {
      const url = String(p?.url || "");
      if (url && collectionChecks[url]) count += 1;
    }
    return count;
  }, [collectionChecks, filteredCollectionProducts]);

  const uploadHolderByOptionId = useMemo(() => {
    const map = {};
    for (const opt of options || []) {
      const type = String(opt?.type || "").toLowerCase().replace(/\s+/g, "");
      if (type === "imageupload" && opt.file_upload_image_id) {
        map[String(opt.id)] = String(opt.file_upload_image_id);
      }
    }
    return map;
  }, [options]);

  const uploadOptionByHolderId = useMemo(() => {
    const map = {};
    for (const [optionId, holderId] of Object.entries(uploadHolderByOptionId)) {
      map[String(holderId)] = String(optionId);
    }
    return map;
  }, [uploadHolderByOptionId]);

  const uploadTransformsByHolderId = useMemo(() => {
    const map = {};
    for (const [optionId, transform] of Object.entries(uploadTransforms || {})) {
      const holderId = uploadHolderByOptionId[String(optionId)];
      if (!holderId) continue;
      map[String(holderId)] = normalizeUploadTransform(transform);
    }
    return map;
  }, [uploadTransforms, uploadHolderByOptionId]);

  const buildUploadTransformsByHolder = useCallback((transformsMap = {}) => {
    const map = {};
    for (const [optionId, transform] of Object.entries(transformsMap || {})) {
      const holderId = uploadHolderByOptionId[String(optionId)];
      if (!holderId) continue;
      map[String(holderId)] = normalizeUploadTransform(transform);
    }
    return map;
  }, [uploadHolderByOptionId]);

  const resolveAssetUrl = (assetPath, kind = "image") => {
    if (!assetPath) return null;
    if (kind === "font") {
      if (/^https?:\/\//i.test(assetPath)) return assetPath;
      const normalized = String(assetPath).replace(/\/Content\//g, "/");
      return `https://app.customily.com${normalized}`;
    }
    return `/api/assets/image?path=${encodeURIComponent(String(assetPath))}`;
  };

  const resolveImageCandidates = (assetPath) => {
    if (!assetPath) return [];
    const raw = String(assetPath);
    if (raw.startsWith("/api/uploads/") || raw.startsWith("blob:") || raw.startsWith("data:image/")) {
      return [raw];
    }
    const urls = [resolveAssetUrl(raw, "image")];

    if (/^https?:\/\//i.test(raw)) {
      urls.push(raw);
    } else {
      const normalized = raw.replace(/\/Content\//g, "/");
      urls.push(`https://cdn.customily.com${normalized}`);
      urls.push(`https://app.customily.com${raw}`);
      if (normalized !== raw) {
        urls.push(`https://app.customily.com${normalized}`);
      }
    }

    return [...new Set(urls.filter(Boolean))];
  };

  const getImage = useCallback((assetPath) => {
    const candidates = resolveImageCandidates(assetPath);
    if (candidates.length === 0) return Promise.resolve(null);
    const cacheKey = String(assetPath);
    if (!imagePromiseCacheRef.current.has(cacheKey)) {
      const promise = (async () => {
        let lastError = null;
        for (const url of candidates) {
          try {
            const img = await new Promise((resolve, reject) => {
              const image = new Image();
              image.crossOrigin = "anonymous";
              image.onload = () => resolve(image);
              image.onerror = () => reject(new Error(`Image load failed: ${url}`));
              image.src = url;
            });
            return img;
          } catch (err) {
            lastError = err;
          }
        }
        throw lastError || new Error(`Image load failed for ${assetPath}`);
      })();
      imagePromiseCacheRef.current.set(cacheKey, promise);
    }
    return imagePromiseCacheRef.current.get(cacheKey);
  }, []);

  const getFontFamily = useCallback(async (fontPath, fontUrl) => {
    if (!fontPath && !fontUrl) return "sans-serif";
    const key = String(fontUrl || fontPath);
    if (fontFamilyCacheRef.current.has(key)) {
      return fontFamilyCacheRef.current.get(key);
    }
    const family = `cly_${key.replace(/[^a-zA-Z0-9]/g, "_").slice(-48)}`;
    const src = fontUrl || resolveAssetUrl(fontPath, "font");
    try {
      const ff = new FontFace(family, `url(${src})`);
      await ff.load();
      document.fonts.add(ff);
      fontFamilyCacheRef.current.set(key, family);
      return family;
    } catch {
      fontFamilyCacheRef.current.set(key, "sans-serif");
      return "sans-serif";
    }
  }, []);

  const parseColor = (raw) => {
    if (!raw) return "#000000";
    if (typeof raw === "string") {
      try {
        const parsed = JSON.parse(raw);
        return parsed?.hex || "#000000";
      } catch {
        return raw;
      }
    }
    return raw?.hex || "#000000";
  };

  const resolveFontHeightToSizeRatio = (fontFamily, measureCtx, ratioKey = null) => {
    if (!fontFamily || !measureCtx) return CUSTOMILY_TEXT_HEIGHT_TO_FONT_RATIO;
    const key = String(ratioKey || fontFamily);
    if (fontHeightRatioCacheRef.current.has(key)) {
      return fontHeightRatioCacheRef.current.get(key);
    }

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
    } catch { }

    if (!Number.isFinite(ratio) || ratio <= 0) {
      ratio = CUSTOMILY_TEXT_HEIGHT_TO_FONT_RATIO;
    }
    ratio = Math.max(0.45, Math.min(0.9, ratio));
    fontHeightRatioCacheRef.current.set(key, ratio);
    return ratio;
  };

  const resolveFixedFontSize = (layer, scaleY, fontFamily, measureCtx, ratioKey = null) => {
    // Match Customily runtime sizing: base size comes from holder height
    // using a fixed ratio, then scaled to output canvas size.
    const minSize = (layer.minSizePx || 10) * scaleY;
    const maxSize = (layer.maxSizePx || 80) * scaleY;
    const hasInit = Number.isFinite(layer.initFontSize) && layer.initFontSize > 0;
    const hasHeight = Number.isFinite(layer.height) && layer.height > 0;
    const ratio = resolveFontHeightToSizeRatio(fontFamily, measureCtx, ratioKey);
    const preferred = hasInit
      ? layer.initFontSize * scaleY
      : hasHeight
        ? layer.height * ratio * scaleY
        : maxSize;
    return Math.max(minSize, Math.min(maxSize, preferred));
  };

  const resolveImageDrawRect = (imgW, imgH, boxW, boxH, fitMode = "contain") => {
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
  };

  const emitPreviewToParent = useCallback((canvas) => {
    if (!isEmbedded || typeof window === "undefined" || !canvas) return;
    if (window.parent === window) return;

    const now = Date.now();
    if (now - lastParentPreviewTsRef.current < 280) return;
    lastParentPreviewTsRef.current = now;

    try {
      const width = Number(canvas.width) || 0;
      const height = Number(canvas.height) || 0;
      if (width <= 0 || height <= 0) return;

      const MAX_EDGE = 960;
      let source = canvas;
      if (Math.max(width, height) > MAX_EDGE) {
        const ratio = MAX_EDGE / Math.max(width, height);
        const nextW = Math.max(1, Math.round(width * ratio));
        const nextH = Math.max(1, Math.round(height * ratio));
        const mini = document.createElement("canvas");
        mini.width = nextW;
        mini.height = nextH;
        const mctx = mini.getContext("2d");
        if (mctx) {
          mctx.drawImage(canvas, 0, 0, nextW, nextH);
          source = mini;
        }
      }

      const previewUrl = source.toDataURL("image/jpeg", 0.88);
      window.parent.postMessage(
        {
          type: "product-cloner:preview-updated",
          templateId: String(activeProduct || embeddedContext.templateId || ""),
          previewUrl,
          width,
          height,
        },
        "*"
      );
    } catch { }
  }, [isEmbedded, activeProduct, embeddedContext.templateId]);

  const notifyInteractionToParent = useCallback((payload = {}) => {
    if (!isEmbedded || typeof window === "undefined") return;
    if (window.parent === window) return;
    if (sentParentInteractionRef.current) return;
    sentParentInteractionRef.current = true;
    try {
      window.parent.postMessage(
        {
          type: "product-cloner:user-interacted",
          templateId: String(activeProduct || embeddedContext.templateId || ""),
          ...payload,
        },
        "*"
      );
    } catch { }
  }, [isEmbedded, activeProduct, embeddedContext.templateId]);

  const drawTraceToCanvas = useCallback(async (trace, requestId = null) => {
    const canvas = canvasRef.current;
    if (!canvas || !trace?.canvas) return;
    const { outputWidth, outputHeight, scaleX, scaleY, bgColor, imagePath: baseImagePath } = trace.canvas;

    // Render next frame offscreen first, then atomically swap to visible canvas.
    // This avoids flicker where old variant is cleared before new images are loaded.
    const stagingCanvas = document.createElement("canvas");
    stagingCanvas.width = outputWidth;
    stagingCanvas.height = outputHeight;
    const ctx = stagingCanvas.getContext("2d");
    if (!ctx) return;

    if (bgColor) {
      ctx.fillStyle = bgColor;
      ctx.fillRect(0, 0, outputWidth, outputHeight);
    }

    const layers = [
      ...(trace.imagePlan || []).map((x) => ({ ...x, _type: "image" })),
      ...(trace.textPlan || []).map((x) => ({ ...x, _type: "text" })),
    ].sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));

    // Preload all fonts first so text measurements use the intended families.
    const uniqueFonts = [
      ...new Map(
        (trace.textPlan || [])
          .filter((t) => Boolean(t.fontPath || t.fontUrl))
          .map((t) => [String(t.fontUrl || t.fontPath), { fontPath: t.fontPath, fontUrl: t.fontUrl }])
      ).values(),
    ];
    await Promise.all(uniqueFonts.map((f) => getFontFamily(f.fontPath, f.fontUrl)));
    if (requestId !== null && requestId !== previewRequestRef.current) return;

    // Preload all images in parallel so variant switch can commit in one swap.
    const uniqueImagePaths = [
      ...new Set(
        [
          ...(baseImagePath ? [baseImagePath] : []),
          ...layers
            .filter((x) => x._type === "image" && x.visible !== false)
            .flatMap((x) => [x.selectedPath, x.maskPath]),
        ]
          .filter(Boolean)
      ),
    ];
    const imageMap = new Map();
    await Promise.all(
      uniqueImagePaths.map(async (imgPath) => {
        try {
          const img = await getImage(imgPath);
          if (img) {
            imageMap.set(imgPath, img);
            imageMetaByPathRef.current.set(String(imgPath), {
              width: Number(img.naturalWidth || img.width) || 0,
              height: Number(img.naturalHeight || img.height) || 0,
            });
          }
        } catch { }
      })
    );
    if (requestId !== null && requestId !== previewRequestRef.current) return;

    if (baseImagePath) {
      const baseImg = imageMap.get(baseImagePath);
      if (baseImg) {
        ctx.drawImage(baseImg, 0, 0, outputWidth, outputHeight);
      }
    }

    const renderLayers = layers;

    const textPlanByHolder = new Map();
    for (const layer of (trace.textPlan || [])) {
      if (layer.visible === false || !layer.text) continue;
      const fontFamily = await getFontFamily(layer.fontPath, layer.fontUrl);
      const boxW = layer.width * scaleX;
      const fittedSize = resolveFixedFontSize(
        layer,
        scaleY,
        fontFamily,
        ctx,
        layer.fontPath || layer.fontUrl || fontFamily
      );

      textPlanByHolder.set(String(layer.holderId), {
        fontFamily,
        boxW,
        fontSize: fittedSize,
      });
    }

    for (const layer of renderLayers) {
      if (requestId !== null && requestId !== previewRequestRef.current) return;
      if (layer.visible === false) continue;

      if (layer._type === "image") {
        if (!layer.selectedPath) continue;
        const img = imageMap.get(layer.selectedPath);
        if (!img) continue;
        const uploadTransform = layer.selectedSource === "upload"
          ? normalizeUploadTransform(uploadTransformsByHolderId[String(layer.holderId)] || layer.uploadTransform || {})
          : normalizeUploadTransform({});
        const cx = layer.centerX * scaleX;
        const cy = layer.centerY * scaleY;
        const boxW = layer.width * scaleX;
        const boxH = layer.height * scaleY;
        const fitMode = layer.fitMode || "contain";
        const { drawW, drawH } = resolveImageDrawRect(
          img.naturalWidth || img.width,
          img.naturalHeight || img.height,
          boxW,
          boxH,
          fitMode
        );
        const drawWWithScale = drawW * uploadTransform.scale;
        const drawHWithScale = drawH * uploadTransform.scale;
        const offsetX = uploadTransform.offsetX * scaleX;
        const offsetY = uploadTransform.offsetY * scaleY;
        const maskImg = layer.maskPath ? imageMap.get(layer.maskPath) : null;
        ctx.save();
        ctx.translate(cx, cy);
        if (layer.rotation) ctx.rotate((layer.rotation * Math.PI) / 180);
        if (layer.opacity !== undefined && layer.opacity !== 1) ctx.globalAlpha = layer.opacity;
        if (layer.limitToPlaceholder || layer.coverMaskArea || layer.hasClipPath) {
          ctx.beginPath();
          ctx.rect(-boxW / 2, -boxH / 2, boxW, boxH);
          ctx.clip();
        }
        if (maskImg) {
          const maskCanvas = document.createElement("canvas");
          maskCanvas.width = Math.max(1, Math.round(boxW));
          maskCanvas.height = Math.max(1, Math.round(boxH));
          const mctx = maskCanvas.getContext("2d");
          if (mctx) {
            const mw = maskCanvas.width;
            const mh = maskCanvas.height;
            mctx.translate(mw / 2 + offsetX, mh / 2 + offsetY);
            if (uploadTransform.rotation) {
              mctx.rotate((uploadTransform.rotation * Math.PI) / 180);
            }
            mctx.drawImage(
              img,
              -drawWWithScale / 2,
              -drawHWithScale / 2,
              drawWWithScale,
              drawHWithScale
            );
            mctx.setTransform(1, 0, 0, 1, 0, 0);
            mctx.globalCompositeOperation = "destination-in";
            mctx.drawImage(maskImg, 0, 0, mw, mh);
            mctx.globalCompositeOperation = "source-over";
            ctx.drawImage(maskCanvas, -boxW / 2, -boxH / 2, boxW, boxH);
          }
        } else {
          ctx.translate(offsetX, offsetY);
          if (uploadTransform.rotation) {
            ctx.rotate((uploadTransform.rotation * Math.PI) / 180);
          }
          ctx.drawImage(
            img,
            -drawWWithScale / 2,
            -drawHWithScale / 2,
            drawWWithScale,
            drawHWithScale
          );
        }
        ctx.restore();
        continue;
      }

      if (!layer.text) continue;
      const textPlan = textPlanByHolder.get(String(layer.holderId));
      if (!textPlan) continue;
      const cx = layer.centerX * scaleX;
      const cy = layer.centerY * scaleY;
      const boxW = textPlan.boxW;
      const fontSize = textPlan.fontSize;
      const fontFamily = textPlan.fontFamily;

      ctx.save();
      ctx.translate(cx, cy);
      if (layer.rotation) ctx.rotate((layer.rotation * Math.PI) / 180);
      if (layer.opacity !== undefined && layer.opacity !== 1) ctx.globalAlpha = layer.opacity;
      ctx.font = `${fontSize}px "${fontFamily}"`;
      ctx.fillStyle = parseColor(layer.color);
      ctx.textBaseline = "middle";
      ctx.textAlign = layer.textAlign || "center";
      let textX = 0;
      if (layer.textAlign === "left") textX = -boxW / 2;
      else if (layer.textAlign === "right") textX = boxW / 2;
      ctx.fillText(layer.text, textX, 0);
      ctx.restore();
    }

    if (requestId !== null && requestId !== previewRequestRef.current) return;

    const displayCtx = canvas.getContext("2d");
    if (!displayCtx) return;
    canvas.width = outputWidth;
    canvas.height = outputHeight;
    displayCtx.clearRect(0, 0, outputWidth, outputHeight);
    displayCtx.drawImage(stagingCanvas, 0, 0);
    if (Number.isFinite(outputWidth) && Number.isFinite(outputHeight) && outputHeight > 0) {
      setPreviewAspectRatio(outputWidth / outputHeight);
    }
    setHasCanvasFrame(true);
    emitPreviewToParent(canvas);
  }, [getFontFamily, getImage, uploadTransformsByHolderId, emitPreviewToParent]);

  const refreshProducts = useCallback(async () => {
    const listRes = await fetch("/api/products");
    const listData = await listRes.json();
    if (!listData.success) return [];
    setProducts(listData.products || []);
    return listData.products || [];
  }, []);

  // Load status + products list (normal mode) OR auto-resolve template (embedded mode)
  useEffect(() => {
    let canceled = false;

    const boot = async () => {
      if (isEmbedded) {
        const embeddedTemplateId = await resolveEmbeddedTemplateId();
        if (canceled) return;
        if (embeddedTemplateId) {
          await selectProduct(embeddedTemplateId);
          return;
        }
        setError("Không tìm thấy template personalized cho product này.");
        return;
      }

      fetch("/api/status")
        .then((r) => r.json())
        .then((data) => {
          if (!canceled) setStoreInfo(data);
        })
        .catch(() => { });

      refreshProducts().catch(() => { });
    };

    boot().catch(() => {
      if (!canceled) setError("Không thể khởi tạo personalized UI");
    });

    return () => {
      canceled = true;
    };
  }, [refreshProducts, isEmbedded, resolveEmbeddedTemplateId]);

  useEffect(() => {
    if (!isEmbedded || typeof window === "undefined") return undefined;
    const notifyParent = () => {
      const contentHeight = Math.max(
        document.documentElement?.scrollHeight || 0,
        document.body?.scrollHeight || 0
      );
      const h = contentHeight > 0 ? contentHeight : 1;
      window.parent?.postMessage(
        {
          type: "product-cloner:embedded-resize",
          height: Math.ceil(h),
        },
        "*"
      );
    };
    notifyParent();
    const t1 = setTimeout(notifyParent, 120);
    const t2 = setTimeout(notifyParent, 500);
    let observer = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => notifyParent());
      observer.observe(document.body);
      observer.observe(document.documentElement);
    }
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      observer?.disconnect();
    };
  }, [
    isEmbedded,
    activeProduct,
    options.length,
    visibleOptionIds.length,
    previewLoading,
    previewAspectRatio,
    focusedUploadOptionId,
  ]);

  const handleInspectImportUrl = async () => {
    const nextUrl = String(importUrl || "").trim();
    if (!nextUrl) return;
    if (storeInfo && !storeInfo.configured) {
      setError("Chưa cấu hình Shopify store");
      return;
    }

    setInspectingLink(true);
    setError(null);
    setNotice(null);

    try {
      const res = await fetch("/api/import/inspect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: nextUrl }),
      });
      const data = await res.json();
      if (!res.ok || !data?.success || !data?.target) {
        setImportTarget(null);
        setCollectionChecks({});
        setCollectionImportResults({});
        setCollectionResultFilter("all");
        setError(data?.error || "Không thể phân tích link import");
        return;
      }

      setImportTarget(data.target);
      if (data.target.type === "collection") {
        const nextChecks = {};
        const nextResults = {};
        for (const product of data.target.products || []) {
          const url = String(product?.url || "");
          if (!url) continue;
          nextChecks[url] = true;
          nextResults[url] = { status: "idle", message: "" };
        }
        setCollectionChecks(nextChecks);
        setCollectionImportResults(nextResults);
        setCollectionResultFilter("all");
      } else {
        setCollectionChecks({});
        setCollectionImportResults({});
        setCollectionResultFilter("all");
      }
    } catch {
      setImportTarget(null);
      setCollectionChecks({});
      setCollectionImportResults({});
      setCollectionResultFilter("all");
      setError("Lỗi kết nối server");
    } finally {
      setInspectingLink(false);
    }
  };

  const importOneProductUrl = async (productUrl) => {
    const url = String(productUrl || "").trim();
    if (!url) throw new Error("Thiếu product URL");

    const res = await fetch("/api/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        publish: Boolean(importPublish),
        vendor: String(importVendor || "").trim(),
        category: String(importCategory || "").trim(),
      }),
    });
    const data = await res.json();
    if (!res.ok || !data?.success) {
      throw new Error(data?.error || `Import thất bại: ${url}`);
    }
    return data;
  };

  const handleImportResolvedProduct = async () => {
    const productUrl = String(importTarget?.product?.url || importTarget?.normalizedUrl || importUrl || "").trim();
    if (!productUrl || importing) return;

    setImporting(true);
    setError(null);
    setNotice(null);

    try {
      const data = await importOneProductUrl(productUrl);
      if (Array.isArray(data?.warnings) && data.warnings.length > 0) {
        setNotice(data.warnings.join(" | "));
      }

      await refreshProducts();
      if (data.product?.id) {
        await selectProduct(data.product.id);
        setAdminView("products");
        setTimeout(() => {
          cloneSummaryRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
        }, 60);
      }
    } catch (error) {
      setError(error?.message || "Import thất bại");
    } finally {
      setImporting(false);
    }
  };

  const handleToggleAllCollection = (checked) => {
    setCollectionChecks((prev) => {
      const next = { ...prev };
      for (const product of filteredCollectionProducts) {
        const url = String(product?.url || "");
        if (!url) continue;
        next[url] = Boolean(checked);
      }
      return next;
    });
  };

  const handleSetCollectionResultFilter = (mode) => {
    const nextMode = String(mode || "all");
    if (!["all", "success", "failed"].includes(nextMode)) return;
    setCollectionResultFilter(nextMode);
  };

  const handleCollectionCheck = (url, checked) => {
    const key = String(url || "");
    if (!key) return;
    setCollectionChecks((prev) => ({
      ...prev,
      [key]: Boolean(checked),
    }));
  };

  const handleImportCollectionSelected = async () => {
    if (batchImporting) return;
    const selected = filteredCollectionProducts.filter((p) => collectionChecks[String(p?.url || "")]);
    if (selected.length === 0) {
      setError("Chưa chọn product nào để import");
      return;
    }

    setBatchImporting(true);
    setError(null);
    setNotice(null);
    const selectedUrlSet = new Set(selected.map((item) => String(item?.url || "")));
    setCollectionImportResults((prev) => {
      const next = { ...prev };
      for (const item of selected) {
        const key = String(item?.url || "");
        if (!key) continue;
        next[key] = {
          status: "queued",
          message: "",
        };
      }
      for (const key of Object.keys(next)) {
        if (!selectedUrlSet.has(key)) {
          if (next[key]?.status === "running") {
            next[key] = { status: "idle", message: "" };
          }
        }
      }
      return next;
    });
    setBatchProgress({
      total: selected.length,
      done: 0,
      success: 0,
      failed: 0,
      current: "",
      errors: [],
    });

    let success = 0;
    let failed = 0;
    const errors = [];
    let lastImportedId = "";
    const warningBag = [];

    for (let i = 0; i < selected.length; i += 1) {
      const item = selected[i];
      const url = String(item?.url || "");
      setCollectionImportResults((prev) => ({
        ...prev,
        [url]: {
          status: "running",
          message: "",
        },
      }));
      setBatchProgress({
        total: selected.length,
        done: i,
        success,
        failed,
        current: url,
        errors,
      });

      try {
        const data = await importOneProductUrl(url);
        success += 1;
        if (data?.product?.id) lastImportedId = String(data.product.id);
        if (Array.isArray(data?.warnings) && data.warnings.length > 0) {
          warningBag.push(`${item?.title || url}: ${data.warnings.join(" | ")}`);
          setCollectionImportResults((prev) => ({
            ...prev,
            [url]: {
              status: "success",
              message: data.warnings.join(" | "),
            },
          }));
        } else {
          setCollectionImportResults((prev) => ({
            ...prev,
            [url]: {
              status: "success",
              message: "",
            },
          }));
        }
      } catch (error) {
        failed += 1;
        const message = error?.message || "Import failed";
        errors.push(`${item?.title || url}: ${message}`);
        setCollectionImportResults((prev) => ({
          ...prev,
          [url]: {
            status: "failed",
            message,
          },
        }));
      }
    }

    setBatchProgress({
      total: selected.length,
      done: selected.length,
      success,
      failed,
      current: "",
      errors,
    });

    try {
      await refreshProducts();
      if (lastImportedId) {
        await selectProduct(lastImportedId);
      }
      setAdminView("products");
    } catch { }

    if (warningBag.length > 0 || errors.length > 0) {
      setNotice([...warningBag, ...errors].join(" | "));
    } else {
      setNotice(`Import thành công ${success}/${selected.length} products.`);
    }

    setBatchImporting(false);
  };

  // Select a product
  const selectProduct = async (productId) => {
    setError(null);
    try {
      const [resOptions, resMeta] = await Promise.all([
        fetch(`/api/products/${productId}/options`),
        fetch(`/api/products/${productId}/meta`).catch(() => null),
      ]);
      const data = await resOptions.json();
      const meta = resMeta ? await resMeta.json() : null;

      if (data.success) {
        setActiveProduct(productId);
        sentParentInteractionRef.current = false;
        setActiveProductMeta(meta?.success ? meta.product : null);
        setActiveImageIndex(0);
        setOptions(data.options);
        setVisibleOptionIds(data.visibleOptionIds);
        setUiForceShowOptionIds(data.uiForceShowOptionIds || []);
        setSelections(data.defaultSelections || {});
        setUserSelections({});
        setTextInputs({});
        setUploadInputs({});
        setUploadingUploadOptionIds({});
        setUploadTransforms({});
        setFocusedUploadOptionId(null);
        latestTraceRef.current = null;
        draggingRef.current = null;
        resizeRef.current = null;
        rotateRef.current = null;
        setHasCanvasFrame(false);
        setPreviewAspectRatio(1);
        // Trigger initial preview
        requestPreview(productId, data.defaultSelections || {}, {}, {}, {
          applyTraceToForm: true,
          uploadInputs: {},
          uploadTransforms: {},
        });
      }
    } catch (err) {
      setError("Không thể load options");
    }
  };

  // Request preview render (debounced)
  const requestPreview = useCallback((
    productId,
    sels,
    texts,
    manual = userSelections,
    options = {}
  ) => {
    const {
      applyTraceToForm = false,
      uploadInputs: uploadOverride = null,
      uploadTransforms: uploadTransformsOverride = null,
    } = options;
    const uploadPayload = uploadOverride || uploadInputs;
    const transformPayload = uploadTransformsOverride || uploadTransformsByHolderId;
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current);

    previewTimerRef.current = setTimeout(async () => {
      const reqId = ++previewRequestRef.current;
      const blockWithLoader = !hasCanvasFrame;
      if (blockWithLoader) setPreviewLoading(true);
      if (previewAbortRef.current) {
        previewAbortRef.current.abort();
      }
      const controller = new AbortController();
      previewAbortRef.current = controller;
      try {
        const res = await fetch(`/api/products/${productId}/workflow-trace`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            selections: sels,
            textInputs: texts,
            userSelections: manual,
            uploadInputs: uploadPayload,
            uploadTransforms: transformPayload,
          }),
          signal: controller.signal,
        });
        if (res.ok) {
          const data = await res.json();
          if (reqId === previewRequestRef.current && data?.success && data?.trace) {
            latestTraceRef.current = data.trace;
            if (applyTraceToForm) {
              setVisibleOptionIds(data.trace.visibleOptionIds || []);
              setUiForceShowOptionIds(data.trace.uiForceShowOptionIds || []);
              setSelections(data.trace.finalSelections || sels || {});
            }
            await drawTraceToCanvas(data.trace, reqId);
          }
        }
      } catch (err) {
        if (err?.name === "AbortError") return;
        console.error("Preview error:", err);
      } finally {
        if (reqId === previewRequestRef.current && blockWithLoader) setPreviewLoading(false);
      }
    }, 120); // lower debounce for snappier variant switching
  }, [
    drawTraceToCanvas,
    userSelections,
    uploadInputs,
    uploadTransformsByHolderId,
    hasCanvasFrame,
  ]);

  useEffect(() => {
    if (!latestTraceRef.current || !hasCanvasFrame) return;
    drawTraceToCanvas(latestTraceRef.current, null).catch(() => { });
  }, [uploadTransformsByHolderId, hasCanvasFrame, drawTraceToCanvas]);

  useEffect(() => {
    if (!focusedUploadOptionId) return;
    if (!uploadInputs?.[String(focusedUploadOptionId)]) {
      setFocusedUploadOptionId(null);
      draggingRef.current = null;
      resizeRef.current = null;
      rotateRef.current = null;
    }
  }, [focusedUploadOptionId, uploadInputs]);

  const clearActiveProductState = useCallback(() => {
    setActiveProduct(null);
    setActiveProductMeta(null);
    setActiveImageIndex(0);
    setOptions([]);
    setVisibleOptionIds([]);
    setUiForceShowOptionIds([]);
    setSelections({});
    setUserSelections({});
    setTextInputs({});
    setUploadInputs({});
    setUploadingUploadOptionIds({});
    setUploadTransforms({});
    setFocusedUploadOptionId(null);
    sentParentInteractionRef.current = false;
    latestTraceRef.current = null;
    draggingRef.current = null;
    resizeRef.current = null;
    rotateRef.current = null;
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext("2d");
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    setHasCanvasFrame(false);
    setPreviewAspectRatio(1);
  }, []);

  // Handle selection change → update visibility + request preview
  const handleSelectionChange = async (optionCid, valueCid) => {
    const cid = String(optionCid);
    const nextVal = valueCid === undefined || valueCid === null ? "" : String(valueCid);
    const newSelections = { ...selections };
    const newUserSelections = { ...userSelections };
    if (nextVal === "") {
      delete newSelections[cid];
      delete newUserSelections[cid];
    } else {
      newSelections[cid] = nextVal;
      newUserSelections[cid] = nextVal;
    }
    setSelections(newSelections);
    setUserSelections(newUserSelections);
    notifyInteractionToParent({
      source: "selection",
      optionId: String(optionCid || ""),
      valueId: String(nextVal || ""),
    });
    // One request for both visibility + render trace to minimize loading flashes.
    requestPreview(
      activeProduct,
      newSelections,
      textInputs,
      newUserSelections,
      { applyTraceToForm: true }
    );
  };

  // Handle text change → request preview
  const handleTextChange = (optionCid, text) => {
    const newTexts = { ...textInputs, [optionCid]: text };
    setTextInputs(newTexts);
    notifyInteractionToParent({
      source: "text",
      optionId: String(optionCid || ""),
    });
    requestPreview(activeProduct, selections, newTexts, userSelections);
  };

  const handleUploadChange = async (optionCid, file) => {
    if (!activeProduct || !file) return;
    setError(null);
    setUploadingUploadOptionIds((prev) => ({ ...prev, [optionCid]: true }));
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const res = await fetch(`/api/products/${activeProduct}/upload-image`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          optionId: optionCid,
          fileName: file.name,
          mimeType: file.type,
          dataUrl,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data?.success || !data?.upload?.url) {
        throw new Error(data?.error || "Upload ảnh thất bại");
      }
      const nextUploads = { ...uploadInputs, [optionCid]: data.upload };
      const nextTransforms = {
        ...uploadTransforms,
        [optionCid]: { ...DEFAULT_UPLOAD_TRANSFORM },
      };
      setUploadInputs(nextUploads);
      setUploadTransforms(nextTransforms);
      setFocusedUploadOptionId(optionCid);
      notifyInteractionToParent({
        source: "upload",
        optionId: String(optionCid || ""),
      });
      requestPreview(activeProduct, selections, textInputs, userSelections, {
        uploadInputs: nextUploads,
        uploadTransforms: buildUploadTransformsByHolder(nextTransforms),
      });
    } catch (err) {
      setError(err?.message || "Không thể upload ảnh");
    } finally {
      setUploadingUploadOptionIds((prev) => {
        const next = { ...prev };
        delete next[optionCid];
        return next;
      });
    }
  };

  const handleUploadClear = (optionCid) => {
    const nextUploads = { ...uploadInputs };
    delete nextUploads[optionCid];
    const nextTransforms = { ...uploadTransforms };
    delete nextTransforms[optionCid];
    setUploadInputs(nextUploads);
    setUploadTransforms(nextTransforms);
    if (String(focusedUploadOptionId || "") === String(optionCid)) {
      setFocusedUploadOptionId(null);
      draggingRef.current = null;
      resizeRef.current = null;
      rotateRef.current = null;
    }
    notifyInteractionToParent({
      source: "upload-clear",
      optionId: String(optionCid || ""),
    });
    requestPreview(activeProduct, selections, textInputs, userSelections, {
      uploadInputs: nextUploads,
      uploadTransforms: buildUploadTransformsByHolder(nextTransforms),
    });
  };

  const updateUploadTransform = useCallback((optionId, updater) => {
    const optionCid = String(optionId);
    setUploadTransforms((prev) => {
      const current = normalizeUploadTransform(prev[optionCid] || DEFAULT_UPLOAD_TRANSFORM);
      const nextValue = typeof updater === "function"
        ? normalizeUploadTransform(updater(current))
        : normalizeUploadTransform(updater);
      return { ...prev, [optionCid]: nextValue };
    });
  }, []);

  const findFocusedUploadLayer = useCallback(() => {
    const optionId = String(focusedUploadOptionId || "");
    if (!optionId) return null;
    const holderId = uploadHolderByOptionId[optionId];
    if (!holderId) return null;
    const trace = latestTraceRef.current;
    if (!trace?.imagePlan) return null;
    return trace.imagePlan.find(
      (layer) =>
        String(layer.holderId) === String(holderId) &&
        layer.visible !== false &&
        layer.selectedSource === "upload" &&
        Boolean(layer.selectedPath)
    ) || null;
  }, [focusedUploadOptionId, uploadHolderByOptionId]);

  const handleUploadActivate = (optionId) => {
    const optionCid = String(optionId);
    if (!uploadInputs?.[optionCid]) return;
    setFocusedUploadOptionId(optionCid);
    draggingRef.current = null;
    resizeRef.current = null;
    rotateRef.current = null;
  };

  const handleUploadTransformAction = (optionId, action, amount = 0) => {
    const optionCid = String(optionId);
    if (!uploadInputs?.[optionCid]) return;
    updateUploadTransform(optionCid, (current) => {
      const next = { ...current };
      if (action === "moveX") next.offsetX += amount;
      else if (action === "moveY") next.offsetY += amount;
      else if (action === "zoom") next.scale = Math.max(0.2, Math.min(4, next.scale + amount));
      else if (action === "rotate") next.rotation += amount;
      else if (action === "reset") return { ...DEFAULT_UPLOAD_TRANSFORM };
      return next;
    });
  };

  useEffect(() => {
    if (!isEmbedded || !activeProduct || options.length > 0) return;
    selectProduct(activeProduct).catch(() => { });
  }, [isEmbedded, activeProduct, options.length]);

  const resolveCanvasPointer = (clientX, clientY) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      x: (clientX - rect.left) * (canvas.width / rect.width),
      y: (clientY - rect.top) * (canvas.height / rect.height),
    };
  };

  const getUploadLayerFrameMetrics = (layer, trace = latestTraceRef.current) => {
    if (!layer || !trace?.canvas) return null;
    const outputWidth = Number(trace.canvas.outputWidth) || 0;
    const outputHeight = Number(trace.canvas.outputHeight) || 0;
    const sx = Number(trace.canvas.scaleX) || 1;
    const sy = Number(trace.canvas.scaleY) || 1;
    if (!outputWidth || !outputHeight) return null;

    const boxW = (Number(layer.width) || 0) * sx;
    const boxH = (Number(layer.height) || 0) * sy;
    const holderCx = (Number(layer.centerX) || 0) * sx;
    const holderCy = (Number(layer.centerY) || 0) * sy;
    if (boxW <= 0 || boxH <= 0) return null;

    const selectedPath = String(layer.selectedPath || "");
    const imageMeta = selectedPath ? imageMetaByPathRef.current.get(selectedPath) : null;
    const imgW = Number(imageMeta?.width) || boxW;
    const imgH = Number(imageMeta?.height) || boxH;
    const fitMode = layer.fitMode || "contain";
    const { drawW, drawH } = resolveImageDrawRect(imgW, imgH, boxW, boxH, fitMode);

    const uploadTransform = layer.selectedSource === "upload"
      ? normalizeUploadTransform(uploadTransformsByHolderId[String(layer.holderId)] || layer.uploadTransform || {})
      : normalizeUploadTransform({});
    const holderRotation = Number(layer.rotation) || 0;
    const holderRotationRad = (holderRotation * Math.PI) / 180;
    const localOffsetX = uploadTransform.offsetX * sx;
    const localOffsetY = uploadTransform.offsetY * sy;
    const worldOffsetX = localOffsetX * Math.cos(holderRotationRad) - localOffsetY * Math.sin(holderRotationRad);
    const worldOffsetY = localOffsetX * Math.sin(holderRotationRad) + localOffsetY * Math.cos(holderRotationRad);

    return {
      outputWidth,
      outputHeight,
      centerX: holderCx + worldOffsetX,
      centerY: holderCy + worldOffsetY,
      width: drawW * uploadTransform.scale,
      height: drawH * uploadTransform.scale,
      rotation: holderRotation + uploadTransform.rotation,
    };
  };

  const isPointInsideUploadFrame = (point, frame) => {
    if (!point || !frame || frame.width <= 0 || frame.height <= 0) return false;
    const rad = (Number(frame.rotation) || 0) * (Math.PI / 180);
    const dx = point.x - frame.centerX;
    const dy = point.y - frame.centerY;
    const cos = Math.cos(-rad);
    const sin = Math.sin(-rad);
    const localX = dx * cos - dy * sin;
    const localY = dx * sin + dy * cos;
    return Math.abs(localX) <= frame.width / 2 && Math.abs(localY) <= frame.height / 2;
  };

  const findUploadLayerByPointer = (clientX, clientY) => {
    const trace = latestTraceRef.current;
    if (!trace?.imagePlan?.length) return null;
    const point = resolveCanvasPointer(clientX, clientY);
    if (!point) return null;
    const sorted = [...trace.imagePlan].sort((a, b) => (b.zIndex || 0) - (a.zIndex || 0));
    for (const layer of sorted) {
      if (layer.visible === false) continue;
      if (layer.selectedSource !== "upload" || !layer.selectedPath) continue;
      const optionId = uploadOptionByHolderId[String(layer.holderId)];
      if (!optionId || !uploadInputs?.[String(optionId)]) continue;
      const frame = getUploadLayerFrameMetrics(layer, trace);
      if (isPointInsideUploadFrame(point, frame)) return layer;
    }
    return null;
  };

  const handleResizeHandlePointerDown = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const layer = findFocusedUploadLayer();
    const trace = latestTraceRef.current;
    if (!layer || !trace?.canvas || !focusedUploadOptionId) return;

    const pointer = resolveCanvasPointer(e.clientX, e.clientY);
    if (!pointer) return;

    const frame = getUploadLayerFrameMetrics(layer, trace);
    if (!frame) return;
    const centerX = frame.centerX;
    const centerY = frame.centerY;
    const startDist = Math.max(
      1,
      Math.hypot(pointer.x - centerX, pointer.y - centerY)
    );

    resizeRef.current = {
      optionId: String(focusedUploadOptionId),
      pointerId: e.pointerId,
      centerX,
      centerY,
      startDist,
      baseScale: normalizeUploadTransform(
        uploadTransforms[String(focusedUploadOptionId)] || DEFAULT_UPLOAD_TRANSFORM
      ).scale,
    };

    if (e.currentTarget?.setPointerCapture) {
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { }
    }
  };

  const handleResizeHandlePointerMove = (e) => {
    const resize = resizeRef.current;
    if (!resize) return;
    e.preventDefault();
    e.stopPropagation();
    const pointer = resolveCanvasPointer(e.clientX, e.clientY);
    if (!pointer) return;
    const currentDist = Math.max(
      1,
      Math.hypot(pointer.x - resize.centerX, pointer.y - resize.centerY)
    );
    const ratio = currentDist / resize.startDist;
    const nextScale = Math.max(0.2, Math.min(4, resize.baseScale * ratio));
    setUploadTransforms((prev) => ({
      ...prev,
      [resize.optionId]: normalizeUploadTransform({
        ...(prev[resize.optionId] || DEFAULT_UPLOAD_TRANSFORM),
        scale: nextScale,
      }),
    }));
  };

  const handleResizeHandlePointerEnd = (e) => {
    const resize = resizeRef.current;
    if (!resize) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.currentTarget?.releasePointerCapture) {
      try { e.currentTarget.releasePointerCapture(resize.pointerId ?? e.pointerId); } catch { }
    }
    resizeRef.current = null;
  };

  const normalizeRadDelta = (delta) => {
    let normalized = delta;
    while (normalized > Math.PI) normalized -= Math.PI * 2;
    while (normalized < -Math.PI) normalized += Math.PI * 2;
    return normalized;
  };

  const handleRotateHandlePointerDown = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const layer = findFocusedUploadLayer();
    const trace = latestTraceRef.current;
    if (!layer || !trace?.canvas || !focusedUploadOptionId) return;
    const pointer = resolveCanvasPointer(e.clientX, e.clientY);
    if (!pointer) return;
    const frame = getUploadLayerFrameMetrics(layer, trace);
    if (!frame) return;
    const startAngle = Math.atan2(pointer.y - frame.centerY, pointer.x - frame.centerX);
    const base = normalizeUploadTransform(
      uploadTransforms[String(focusedUploadOptionId)] || DEFAULT_UPLOAD_TRANSFORM
    );
    rotateRef.current = {
      optionId: String(focusedUploadOptionId),
      pointerId: e.pointerId,
      centerX: frame.centerX,
      centerY: frame.centerY,
      startAngle,
      baseRotation: base.rotation,
    };
    if (e.currentTarget?.setPointerCapture) {
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { }
    }
  };

  const handleRotateHandlePointerMove = (e) => {
    const rotate = rotateRef.current;
    if (!rotate) return;
    e.preventDefault();
    e.stopPropagation();
    const pointer = resolveCanvasPointer(e.clientX, e.clientY);
    if (!pointer) return;
    const currentAngle = Math.atan2(pointer.y - rotate.centerY, pointer.x - rotate.centerX);
    const deltaRad = normalizeRadDelta(currentAngle - rotate.startAngle);
    const deltaDeg = (deltaRad * 180) / Math.PI;
    setUploadTransforms((prev) => ({
      ...prev,
      [rotate.optionId]: normalizeUploadTransform({
        ...(prev[rotate.optionId] || DEFAULT_UPLOAD_TRANSFORM),
        rotation: rotate.baseRotation + deltaDeg,
      }),
    }));
  };

  const handleRotateHandlePointerEnd = (e) => {
    const rotate = rotateRef.current;
    if (!rotate) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.currentTarget?.releasePointerCapture) {
      try { e.currentTarget.releasePointerCapture(rotate.pointerId ?? e.pointerId); } catch { }
    }
    rotateRef.current = null;
  };

  const handleCanvasPointerDown = (e) => {
    const layer = findUploadLayerByPointer(e.clientX, e.clientY);
    if (!layer) {
      if (focusedUploadOptionId) {
        setFocusedUploadOptionId(null);
        draggingRef.current = null;
        resizeRef.current = null;
        rotateRef.current = null;
      }
      return;
    }
    const optionId = uploadOptionByHolderId[String(layer.holderId)];
    if (!optionId) return;
    if (String(focusedUploadOptionId || "") !== String(optionId)) {
      setFocusedUploadOptionId(String(optionId));
    }
    const canvas = canvasRef.current;
    const trace = latestTraceRef.current;
    if (!canvas || !trace?.canvas) return;
    if (!canvas.width || !canvas.height) return;

    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const ratioX = canvas.width / rect.width;
    const ratioY = canvas.height / rect.height;
    draggingRef.current = {
      optionId: String(optionId),
      startClientX: e.clientX,
      startClientY: e.clientY,
      ratioX,
      ratioY,
      base: normalizeUploadTransform(uploadTransforms[String(optionId)] || DEFAULT_UPLOAD_TRANSFORM),
      scaleX: trace.canvas.scaleX || 1,
      scaleY: trace.canvas.scaleY || 1,
      pointerId: e.pointerId,
    };
    if (canvas.setPointerCapture) {
      try { canvas.setPointerCapture(e.pointerId); } catch { }
    }
  };

  const handleCanvasPointerMove = (e) => {
    const drag = draggingRef.current;
    if (!drag) return;
    const deltaClientX = e.clientX - drag.startClientX;
    const deltaClientY = e.clientY - drag.startClientY;
    const deltaCanvasX = deltaClientX * drag.ratioX;
    const deltaCanvasY = deltaClientY * drag.ratioY;
    const deltaDesignX = drag.scaleX ? deltaCanvasX / drag.scaleX : 0;
    const deltaDesignY = drag.scaleY ? deltaCanvasY / drag.scaleY : 0;

    setUploadTransforms((prev) => ({
      ...prev,
      [drag.optionId]: normalizeUploadTransform({
        ...drag.base,
        offsetX: drag.base.offsetX + deltaDesignX,
        offsetY: drag.base.offsetY + deltaDesignY,
      }),
    }));
  };

  const handleCanvasPointerEnd = (e) => {
    const drag = draggingRef.current;
    if (!drag) return;
    const canvas = canvasRef.current;
    if (canvas?.releasePointerCapture) {
      try { canvas.releasePointerCapture(drag.pointerId ?? e.pointerId); } catch { }
    }
    draggingRef.current = null;
  };

  const hasFocusedUpload = Boolean(
    focusedUploadOptionId && uploadInputs?.[String(focusedUploadOptionId)]
  );
  // Embedded mode keeps preview hidden by default,
  // but upload editing needs the canvas/frame visible.
  const hideEmbeddedPreview = isEmbedded && !hasFocusedUpload;
  const focusedUploadLayer = findFocusedUploadLayer();
  const focusedUploadFrameStyle = (() => {
    if (!hasFocusedUpload || !focusedUploadLayer) return null;
    const frame = getUploadLayerFrameMetrics(focusedUploadLayer);
    if (!frame) return null;

    const left = ((frame.centerX - frame.width / 2) / frame.outputWidth) * 100;
    const top = ((frame.centerY - frame.height / 2) / frame.outputHeight) * 100;
    const width = (frame.width / frame.outputWidth) * 100;
    const height = (frame.height / frame.outputHeight) * 100;
    const rotation = Number(frame.rotation) || 0;

    return {
      left: `${left}%`,
      top: `${top}%`,
      width: `${width}%`,
      height: `${height}%`,
      transform: `rotate(${rotation}deg)`,
      transformOrigin: "center center",
    };
  })();
  const focusedUploadTransform = normalizeUploadTransform(
    uploadTransforms?.[String(focusedUploadOptionId || "")] || DEFAULT_UPLOAD_TRANSFORM
  );
  const handleFocusedUploadAction = (action, amount = 0) => {
    if (!focusedUploadOptionId) return;
    handleUploadTransformAction(String(focusedUploadOptionId), action, amount);
  };

  const handleCleanupOld = async () => {
    if (cleaningOld || products.length <= 1) return;
    const ok = window.confirm("Xóa các personalized cũ và chỉ giữ lại bản import mới nhất?");
    if (!ok) return;

    setCleaningOld(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/products/cleanup-old", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keepLatest: 1 }),
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || "Không thể xóa personalized cũ");
        return;
      }

      const nextProducts = data.products || [];
      setProducts(nextProducts);
      const keptIds = new Set(nextProducts.map((p) => p.id));
      if (activeProduct && !keptIds.has(activeProduct)) {
        clearActiveProductState();
      }
    } catch {
      setError("Lỗi kết nối server");
    } finally {
      setCleaningOld(false);
    }
  };

  const handleDeleteProduct = async (productId) => {
    const pid = String(productId || "");
    if (!pid || deletingProductId) return;
    const ok = window.confirm(`Xóa product này?\n${pid}`);
    if (!ok) return;

    setDeletingProductId(pid);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/products/${encodeURIComponent(pid)}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok || !data?.success) {
        setError(data?.error || "Không thể xóa product");
        return;
      }
      const nextProducts = data.products || [];
      setProducts(nextProducts);
      if (String(activeProduct || "") === pid) {
        clearActiveProductState();
      }
    } catch {
      setError("Lỗi kết nối server");
    } finally {
      setDeletingProductId(null);
    }
  };

  const handleSaveDraft = async () => {
    if (!activeProduct || savingDraft || publishingProduct) return;
    setSavingDraft(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/products/${encodeURIComponent(activeProduct)}/save-draft`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok || !data?.success) {
        setError(data?.error || "Không thể lưu Draft");
        return;
      }
      if (Array.isArray(data?.warnings) && data.warnings.length > 0) {
        setNotice(data.warnings.join(" | "));
      }
      await refreshProducts();
    } catch {
      setError("Lỗi kết nối server");
    } finally {
      setSavingDraft(false);
    }
  };

  const handlePublishProduct = async () => {
    if (!activeProduct || savingDraft || publishingProduct) return;
    setPublishingProduct(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/products/${encodeURIComponent(activeProduct)}/publish`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok || !data?.success) {
        setError(data?.error || "Không thể publish product");
        return;
      }
      if (Array.isArray(data?.warnings) && data.warnings.length > 0) {
        setNotice(data.warnings.join(" | "));
      } else {
        setNotice("Publish thành công sang Online Store channel.");
      }
      await refreshProducts();
    } catch {
      setError("Lỗi kết nối server");
    } finally {
      setPublishingProduct(false);
    }
  };

  return (
    <div className={`customizer-page ${isEmbedded ? "embedded-mode" : ""}`}>
      {!isEmbedded && (
        <div className="admin-nav">
          <button
            type="button"
            className={`admin-nav-btn ${adminView === "import" ? "active" : ""}`}
            onClick={() => setAdminView("import")}
          >
            Import
          </button>
          <button
            type="button"
            className={`admin-nav-btn ${adminView === "products" ? "active" : ""}`}
            onClick={() => setAdminView("products")}
          >
            Product Added
          </button>
        </div>
      )}

      {/* Import Section */}
      {!isEmbedded && adminView === "import" && (
        <div className="import-section">
          <div className="import-card">
            <h2>🧩 Import Product / Collection</h2>
            <p className="subtitle">
              Dán link product hoặc collection. Hệ thống sẽ tự nhận dạng và cho phép import hàng loạt.
            </p>
            {storeInfo?.configured ? (
              <div className="store-badge" style={{ marginBottom: 10 }}>
                <span className="dot"></span> Kết nối: {storeInfo.store}
              </div>
            ) : (
              <div className="config-warning" style={{ marginBottom: 10 }}>
                <span className="config-warning-icon">⚠️</span>
                <div className="config-warning-text">
                  Chưa cấu hình Shopify store. Cập nhật <code>.env</code> với <code>SHOPIFY_STORE</code> và <code>SHOPIFY_ACCESS_TOKEN</code>.
                </div>
              </div>
            )}

            <div className="import-bar">
              <input
                type="url"
                value={importUrl}
                onChange={(e) => {
                  const nextValue = e.target.value;
                  setImportUrl(nextValue);
                  setImportTarget(null);
                  setCollectionChecks({});
                  setCollectionImportResults({});
                  setCollectionResultFilter("all");
                  setBatchProgress(null);
                }}
                onKeyDown={(e) => e.key === "Enter" && !inspectingLink && handleInspectImportUrl()}
                placeholder="https://macorner.co/products/... hoặc /collections/..."
                disabled={inspectingLink || importing || batchImporting || (storeInfo && !storeInfo.configured)}
              />
              <button
                className="btn btn-primary"
                onClick={handleInspectImportUrl}
                disabled={!importUrl.trim() || inspectingLink || importing || batchImporting || (storeInfo && !storeInfo.configured)}
              >
                {inspectingLink ? <span className="spinner"></span> : "🔎"}
                {inspectingLink ? "Scanning..." : "Detect Link"}
              </button>
            </div>

            <div className="import-type-hint">
              Nhận dạng:{" "}
              <strong>
                {importLinkTypeHint === "product"
                  ? "Product"
                  : importLinkTypeHint === "collection"
                    ? "Collection"
                    : "Unknown"}
              </strong>
            </div>

            <div className="import-vendor-row">
              <label htmlFor="import-vendor-input">Vendor (optional override)</label>
              <input
                id="import-vendor-input"
                type="text"
                value={importVendor}
                onChange={(e) => setImportVendor(e.target.value)}
                placeholder="Ví dụ: Alienscustom"
                disabled={inspectingLink || importing || batchImporting}
              />
            </div>

            <div className="import-vendor-row">
              <label htmlFor="import-category-input">Category / Product type (optional override)</label>
              <input
                id="import-category-input"
                type="text"
                value={importCategory}
                onChange={(e) => setImportCategory(e.target.value)}
                placeholder="Ví dụ: Acrylic Plaque"
                disabled={inspectingLink || importing || batchImporting}
              />
            </div>

            <label className="import-public-toggle">
              <input
                type="checkbox"
                checked={importPublish}
                onChange={(e) => setImportPublish(Boolean(e.target.checked))}
                disabled={importing || batchImporting}
              />
              <span>Public ngay khi import</span>
            </label>

            {importTarget?.type === "product" && (
              <div className="import-result-card">
                <div className="import-result-title">
                  {importTarget?.product?.title || importTarget?.product?.handle || "Detected Product"}
                </div>
                <div className="import-result-meta">
                  <span>{importTarget?.product?.variantsCount || 0} variants</span>
                  <span>{importTarget?.normalizedUrl}</span>
                </div>
                <button
                  className="btn btn-success btn-sm"
                  onClick={handleImportResolvedProduct}
                  disabled={importing || batchImporting}
                >
                  {importing ? "Đang import..." : importPublish ? "Import + Public" : "Import + Draft"}
                </button>
              </div>
            )}

            {importTarget?.type === "collection" && (
              <div className="collection-import-panel">
                <div className="collection-import-head">
                  <div>
                    <strong>Collection:</strong> {importTarget?.collection?.handle}
                  </div>
                  <div>
                    {selectedCollectionCount}/{filteredCollectionProducts.length} selected
                    {collectionResultFilter !== "all" ? ` (filter/${collectionProducts.length})` : ""}
                  </div>
                </div>

                <div className="collection-result-filters" role="tablist" aria-label="Filter import result">
                  <button
                    type="button"
                    className={`btn btn-ghost btn-sm ${collectionResultFilter === "all" ? "active" : ""}`}
                    onClick={() => handleSetCollectionResultFilter("all")}
                    disabled={batchImporting}
                  >
                    All ({collectionResultStats.all})
                  </button>
                  <button
                    type="button"
                    className={`btn btn-ghost btn-sm ${collectionResultFilter === "success" ? "active" : ""}`}
                    onClick={() => handleSetCollectionResultFilter("success")}
                    disabled={batchImporting}
                  >
                    Success ({collectionResultStats.success})
                  </button>
                  <button
                    type="button"
                    className={`btn btn-ghost btn-sm ${collectionResultFilter === "failed" ? "active" : ""}`}
                    onClick={() => handleSetCollectionResultFilter("failed")}
                    disabled={batchImporting}
                  >
                    Fail ({collectionResultStats.failed})
                  </button>
                </div>

                <div className="collection-import-actions">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => handleToggleAllCollection(true)}
                    disabled={batchImporting}
                  >
                    Tick All
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => handleToggleAllCollection(false)}
                    disabled={batchImporting}
                  >
                    Clear
                  </button>
                  <button
                    type="button"
                    className="btn btn-success btn-sm"
                    onClick={handleImportCollectionSelected}
                    disabled={batchImporting || selectedCollectionCount === 0}
                  >
                    {batchImporting
                      ? `Importing ${batchProgress?.done || 0}/${batchProgress?.total || selectedCollectionCount}...`
                      : (importPublish ? "Import Selected + Public" : "Import Selected + Draft")}
                  </button>
                </div>

                {batchProgress && (
                  <div className="collection-import-progress">
                    <span>Total: {batchProgress.total}</span>
                    <span>Done: {batchProgress.done}</span>
                    <span>Success: {batchProgress.success}</span>
                    <span>Failed: {batchProgress.failed}</span>
                    {batchProgress.current ? <span>Current: {batchProgress.current}</span> : null}
                  </div>
                )}

                <div className="collection-products-list">
                  {filteredCollectionProducts.map((product) => {
                    const url = String(product?.url || "");
                    const checked = Boolean(collectionChecks[url]);
                    const rowResult = collectionImportResults[url] || { status: "idle", message: "" };
                    const rowStatus = String(rowResult.status || "idle");
                    return (
                      <label key={url} className="collection-product-row">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => handleCollectionCheck(url, e.target.checked)}
                          disabled={batchImporting}
                        />
                        <div className="collection-product-main">
                          <div className="collection-product-title-row">
                            <div className="collection-product-title">{product?.title || product?.handle || url}</div>
                            <span className={`import-row-status status-${rowStatus}`}>
                              {rowStatus === "success"
                                ? "Success"
                                : rowStatus === "failed"
                                  ? "Fail"
                                  : rowStatus === "running"
                                    ? "Running"
                                    : rowStatus === "queued"
                                      ? "Queued"
                                      : "Pending"}
                            </span>
                          </div>
                          <div className="collection-product-url">{url}</div>
                          {rowResult?.message ? (
                            <div className="collection-product-message">{rowResult.message}</div>
                          ) : null}
                        </div>
                      </label>
                    );
                  })}
                  {filteredCollectionProducts.length === 0 ? (
                    <div className="collection-products-empty">Không có product nào theo filter hiện tại.</div>
                  ) : null}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="banner banner-error" style={{ marginBottom: 16 }}>
          <span className="banner-icon">❌</span>
          <div className="banner-content">
            <p>{error}</p>
          </div>
        </div>
      )}

      {notice && (
        <div className="banner" style={{ marginBottom: 16, border: "1px solid #f5d6a1", background: "#fff8eb" }}>
          <span className="banner-icon">ℹ️</span>
          <div className="banner-content">
            <p>{notice}</p>
          </div>
        </div>
      )}

      {/* Products Grid */}
      {!isEmbedded && adminView === "products" && products.length > 0 && (
        <>
          <div className="products-toolbar">
            <button
              className="btn btn-ghost btn-sm"
              onClick={handleCleanupOld}
              disabled={products.length <= 1 || cleaningOld}
            >
              {cleaningOld ? "Đang xóa..." : "🗑️ Xóa personalized cũ"}
            </button>
          </div>
          <div className="products-grid">
            {products.map((p) => (
              <div
                key={p.id}
                className={`product-card ${activeProduct === p.id ? "active" : ""}`}
                onClick={() => selectProduct(p.id)}
              >
                <button
                  type="button"
                  className="product-card-close"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    handleDeleteProduct(p.id);
                  }}
                  disabled={Boolean(deletingProductId) || cleaningOld}
                  title="Xóa product"
                  aria-label={`Delete ${p.id}`}
                >
                  {deletingProductId === p.id ? "…" : "×"}
                </button>
                <h3>{p.id}</h3>
                <div className="meta">
                  <span>⚙️ {p.optionsCount} options</span>
                  <span>🎭 {p.variantsCount} variants</span>
                  <span>🛍️ {p.shopifyClone?.status || "not-created"}</span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {!isEmbedded && adminView === "products" && products.length === 0 && (
        <div className="empty-products">
          Chưa có product nào được import. Chuyển qua tab <strong>Import</strong> để thêm mới.
        </div>
      )}

      {!isEmbedded && adminView === "products" && activeProductRecord && (
        <div className="clone-summary-card" ref={cloneSummaryRef}>
          <div className="clone-summary-media">
            {activeProductRecord?.cloneSource?.image ? (
              <img src={activeProductRecord.cloneSource.image} alt={activeProductRecord?.cloneSource?.title || "Product image"} />
            ) : (
              <div className="clone-summary-placeholder">No image</div>
            )}
          </div>

          <div className="clone-summary-content">
            <div className="clone-summary-title-row">
              <h3>{activeProductRecord?.cloneSource?.title || activeProductRecord?.shopifyClone?.productTitle || activeProductRecord.id}</h3>
              <span className="badge badge-info">
                Shopify: {activeProductRecord?.shopifyClone?.status || "not-created"}
              </span>
            </div>

            <div className="clone-summary-meta">
              <span>💵 {activeProductRecord?.cloneSource?.price || "-"}</span>
              <span>🏷️ {activeProductRecord?.cloneSource?.category || activeProductRecord?.cloneSource?.productType || "-"}</span>
              <span>🎭 {activeProductRecord?.cloneSource?.variantsCount || activeProductRecord?.variantsCount || 0} variants</span>
              <span>🆔 {activeProductRecord?.shopifyClone?.productId || "-"}</span>
            </div>

            <div className="clone-summary-actions">
              <button
                className="btn btn-ghost btn-sm"
                onClick={handleSaveDraft}
                disabled={savingDraft || publishingProduct || deletingProductId === activeProductRecord.id}
              >
                {savingDraft ? "Đang lưu..." : "Save Draft"}
              </button>
              <button
                className="btn btn-success btn-sm"
                onClick={handlePublishProduct}
                disabled={
                  savingDraft ||
                  publishingProduct ||
                  !activeProductRecord?.shopifyClone?.productId ||
                  String(activeProductRecord?.shopifyClone?.status || "").toLowerCase() === "active"
                }
              >
                {publishingProduct ? "Đang publish..." : "Public Product"}
              </button>
              {activeProductRecord?.shopifyClone?.productUrl ? (
                <a
                  className="btn btn-ghost btn-sm"
                  href={activeProductRecord.shopifyClone.productUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Mở Shopify Admin
                </a>
              ) : null}
            </div>
          </div>
        </div>
      )}

      {!isEmbedded && adminView === "products" && activeClonedProduct && (
        <div className="product-detail-card">
          <div className="product-detail-gallery">
            <div className="product-detail-main-image">
              {activeMainImage?.src ? (
                <img
                  src={activeMainImage.src}
                  alt={activeMainImage.alt || activeClonedProduct.title || "Product image"}
                />
              ) : (
                <div className="product-detail-no-image">No image</div>
              )}
            </div>

            {activeClonedImages.length > 1 ? (
              <div className="product-detail-thumbs">
                {activeClonedImages.map((img, idx) => (
                  <button
                    key={`${img.src || "image"}-${idx}`}
                    type="button"
                    className={`product-detail-thumb ${idx === safeActiveImageIndex ? "active" : ""}`}
                    onClick={() => setActiveImageIndex(idx)}
                    title={img.alt || `Image ${idx + 1}`}
                  >
                    {img?.src ? <img src={img.src} alt={img.alt || `Image ${idx + 1}`} /> : <span>{idx + 1}</span>}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <div className="product-detail-content">
            <div className="product-detail-title-row">
              <h3>{activeClonedProduct.title || activeProduct}</h3>
              {activeClonedProduct?.sourceUrl ? (
                <a
                  className="btn btn-ghost btn-sm"
                  href={activeClonedProduct.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Mở trang gốc
                </a>
              ) : null}
            </div>

            <div className="product-detail-price">
              <span className="price">{activeFirstVariant?.price || "-"}</span>
              {activeFirstVariant?.compareAtPrice ? (
                <span className="price-compare">{activeFirstVariant.compareAtPrice}</span>
              ) : null}
            </div>

            <div className="product-detail-meta">
              <span>Vendor: {activeClonedProduct.vendor || "-"}</span>
              <span>Category: {activeClonedProduct.category || activeClonedProduct.productType || "-"}</span>
              <span>Variants: {activeClonedVariants.length}</span>
              <span>Images: {activeClonedImages.length}</span>
            </div>

            {Array.isArray(activeClonedProduct.tags) && activeClonedProduct.tags.length > 0 ? (
              <div className="product-detail-tags">
                {activeClonedProduct.tags.map((tag) => (
                  <span key={tag} className="tag">{tag}</span>
                ))}
              </div>
            ) : null}

            {activeClonedOptions.length > 0 ? (
              <div className="product-detail-section">
                <h4>Options</h4>
                <div className="product-detail-options">
                  {activeClonedOptions.map((opt, idx) => (
                    <div key={`${opt?.name || "option"}-${idx}`} className="product-detail-option-row">
                      <strong>{opt?.name || `Option ${idx + 1}`}:</strong>
                      <span>{Array.isArray(opt?.values) ? opt.values.join(", ") : "-"}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {activeClonedVariants.length > 0 ? (
              <div className="product-detail-section">
                <h4>Variants</h4>
                <div className="product-detail-variants">
                  {activeClonedVariants.map((variant, idx) => (
                    <div key={`${variant?.title || "variant"}-${idx}`} className="product-detail-variant-row">
                      <span>{variant?.title || `Variant ${idx + 1}`}</span>
                      <span>{variant?.price || "-"}</span>
                      <span>{variant?.sku || "-"}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {activeDescriptionText ? (
              <div className="product-detail-section">
                <h4>Description</h4>
                <p className="product-detail-description">{activeDescriptionText}</p>
              </div>
            ) : null}
          </div>
        </div>
      )}

      {/* Customizer Layout */}
      {activeProduct && options.length > 0 && (isEmbedded || adminView === "products") && (
        <div className={`customizer-layout ${hideEmbeddedPreview ? "without-preview" : ""}`}>
          {/* Left: Preview */}
          {hideEmbeddedPreview ? (
            <div className="preview-image-wrapper preview-image-wrapper--hidden" aria-hidden="true">
              <canvas ref={canvasRef} className="preview-canvas" />
            </div>
          ) : (
            <div
              className={`preview-image-wrapper ${focusedUploadOptionId ? "upload-editing" : ""}`}
              style={{ aspectRatio: previewAspectRatio }}
            >
              <canvas
                ref={canvasRef}
                className="preview-canvas"
                onPointerDown={handleCanvasPointerDown}
                onPointerMove={handleCanvasPointerMove}
                onPointerUp={handleCanvasPointerEnd}
                onPointerCancel={handleCanvasPointerEnd}
                onPointerLeave={handleCanvasPointerEnd}
              />
              {previewLoading && (
                <div className="preview-loading">
                  <span className="spinner"></span> Đang render...
                </div>
              )}
              {hasFocusedUpload && focusedUploadFrameStyle && (
                <div className="upload-edit-frame" style={focusedUploadFrameStyle}>
                  <button
                    type="button"
                    className="upload-edit-handle handle-tl"
                    onPointerDown={handleResizeHandlePointerDown}
                    onPointerMove={handleResizeHandlePointerMove}
                    onPointerUp={handleResizeHandlePointerEnd}
                    onPointerCancel={handleResizeHandlePointerEnd}
                  />
                  <button
                    type="button"
                    className="upload-edit-handle handle-tr"
                    onPointerDown={handleResizeHandlePointerDown}
                    onPointerMove={handleResizeHandlePointerMove}
                    onPointerUp={handleResizeHandlePointerEnd}
                    onPointerCancel={handleResizeHandlePointerEnd}
                  />
                  <button
                    type="button"
                    className="upload-edit-handle handle-bl"
                    onPointerDown={handleResizeHandlePointerDown}
                    onPointerMove={handleResizeHandlePointerMove}
                    onPointerUp={handleResizeHandlePointerEnd}
                    onPointerCancel={handleResizeHandlePointerEnd}
                  />
                  <button
                    type="button"
                    className="upload-edit-handle handle-br"
                    onPointerDown={handleResizeHandlePointerDown}
                    onPointerMove={handleResizeHandlePointerMove}
                    onPointerUp={handleResizeHandlePointerEnd}
                    onPointerCancel={handleResizeHandlePointerEnd}
                  />
                  <button
                    type="button"
                    className="upload-edit-rotate-btn"
                    onPointerDown={handleRotateHandlePointerDown}
                    onPointerMove={handleRotateHandlePointerMove}
                    onPointerUp={handleRotateHandlePointerEnd}
                    onPointerCancel={handleRotateHandlePointerEnd}
                    title="Xoay ảnh"
                    aria-label="Rotate image"
                  >
                    ↻
                  </button>
                </div>
              )}
              {hasFocusedUpload && (
                <div className="preview-controls-overlay">
                  <div className="preview-controls-row">
                    <button
                      type="button"
                      className="upload-editor-btn"
                      aria-label="Zoom out"
                      onClick={() => handleFocusedUploadAction("zoom", -0.08)}
                    >
                      <ZoomGlyph mode="minus" />
                    </button>
                    <button
                      type="button"
                      className="upload-editor-btn"
                      aria-label="Zoom in"
                      onClick={() => handleFocusedUploadAction("zoom", 0.08)}
                    >
                      <ZoomGlyph mode="plus" />
                    </button>
                    <button type="button" className="upload-editor-btn is-arrow" onClick={() => handleFocusedUploadAction("moveY", -8)}><span className="arrow-glyph">↑</span></button>
                    <button type="button" className="upload-editor-btn is-arrow" onClick={() => handleFocusedUploadAction("moveY", 8)}><span className="arrow-glyph">↓</span></button>
                    <button type="button" className="upload-editor-btn is-arrow" onClick={() => handleFocusedUploadAction("moveX", -8)}><span className="arrow-glyph">←</span></button>
                    <button type="button" className="upload-editor-btn is-arrow" onClick={() => handleFocusedUploadAction("moveX", 8)}><span className="arrow-glyph">→</span></button>
                    <button type="button" className="upload-editor-btn" onClick={() => handleFocusedUploadAction("rotate", -3)}><span className="arrow-glyph">↺</span></button>
                    <button type="button" className="upload-editor-btn" onClick={() => handleFocusedUploadAction("rotate", 3)}><span className="arrow-glyph">↻</span></button>
                    <button type="button" className="upload-editor-btn" onClick={() => handleFocusedUploadAction("reset", 0)}>Reset</button>
                  </div>
                  <div className="preview-controls-hint">
                    X: {focusedUploadTransform.offsetX.toFixed(1)} | Y: {focusedUploadTransform.offsetY.toFixed(1)} | Zoom: {focusedUploadTransform.scale.toFixed(2)} | R: {focusedUploadTransform.rotation.toFixed(1)}°
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Right: Form */}
          <CustomizerForm
            options={options}
            visibleOptionIds={visibleOptionIds}
            uiForceShowOptionIds={uiForceShowOptionIds}
            selections={selections}
            textInputs={textInputs}
            uploadInputs={uploadInputs}
            uploadingUploadOptionIds={uploadingUploadOptionIds}
            focusedUploadOptionId={focusedUploadOptionId}
            onSelectionChange={handleSelectionChange}
            onTextChange={handleTextChange}
            onUploadChange={handleUploadChange}
            onUploadClear={handleUploadClear}
            onUploadActivate={handleUploadActivate}
          />
        </div>
      )}

      {isEmbedded && (!activeProduct || options.length === 0) && (
        <div className="embedded-loading">Loading personalized...</div>
      )}
    </div>
  );
}
