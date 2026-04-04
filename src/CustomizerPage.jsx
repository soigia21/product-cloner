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
  const [importUrl, setImportUrl] = useState("");
  const [importing, setImporting] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [publishingProduct, setPublishingProduct] = useState(false);
  const [cleaningOld, setCleaningOld] = useState(false);
  const [deletingProductId, setDeletingProductId] = useState(null);
  const [products, setProducts] = useState([]);
  const [activeProduct, setActiveProduct] = useState(null);
  const [storeInfo, setStoreInfo] = useState(null);

  // Customizer state
  const [options, setOptions] = useState([]);
  const [visibleOptionIds, setVisibleOptionIds] = useState([]);
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

  const [error, setError] = useState(null);

  const activeProductRecord = useMemo(
    () => products.find((p) => String(p.id) === String(activeProduct || "")) || null,
    [products, activeProduct]
  );

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
  }, [getFontFamily, getImage, uploadTransformsByHolderId]);

  const refreshProducts = useCallback(async () => {
    const listRes = await fetch("/api/products");
    const listData = await listRes.json();
    if (!listData.success) return [];
    setProducts(listData.products || []);
    return listData.products || [];
  }, []);

  // Load products list
  useEffect(() => {
    fetch("/api/status")
      .then((r) => r.json())
      .then((data) => setStoreInfo(data))
      .catch(() => {});

    refreshProducts().catch(() => { });
  }, [refreshProducts]);

  // Import product
  const handleImport = async () => {
    if (!importUrl.trim()) return;
    if (storeInfo && !storeInfo.configured) {
      setError("Chưa cấu hình Shopify store");
      return;
    }
    setImporting(true);
    setError(null);

    try {
      const res = await fetch("/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: importUrl }),
      });
      const data = await res.json();

      if (data.success) {
        setImportUrl("");
        // Refresh products list
        await refreshProducts();
        // Auto-select the imported product
        if (data.product?.id) {
          await selectProduct(data.product.id);
          setTimeout(() => {
            cloneSummaryRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
          }, 60);
        }
      } else {
        setError(data.error || "Import thất bại");
      }
    } catch (err) {
      setError("Lỗi kết nối server");
    } finally {
      setImporting(false);
    }
  };

  // Select a product
  const selectProduct = async (productId) => {
    setError(null);
    try {
      const res = await fetch(`/api/products/${productId}/options`);
      const data = await res.json();

      if (data.success) {
        setActiveProduct(productId);
        setOptions(data.options);
        setVisibleOptionIds(data.visibleOptionIds);
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
    }, 180); // reduce latency while still coalescing rapid changes
  }, [drawTraceToCanvas, userSelections, uploadInputs, uploadTransformsByHolderId, hasCanvasFrame]);

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
    setOptions([]);
    setVisibleOptionIds([]);
    setSelections({});
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
    try {
      const res = await fetch(`/api/products/${encodeURIComponent(activeProduct)}/save-draft`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok || !data?.success) {
        setError(data?.error || "Không thể lưu Draft");
        return;
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
    try {
      const res = await fetch(`/api/products/${encodeURIComponent(activeProduct)}/publish`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok || !data?.success) {
        setError(data?.error || "Không thể publish product");
        return;
      }
      await refreshProducts();
    } catch {
      setError("Lỗi kết nối server");
    } finally {
      setPublishingProduct(false);
    }
  };

  return (
    <div className="customizer-page">
      {/* Import Section */}
      <div className="import-section">
        <div className="import-card">
          <h2>🧩 Product + Personalized Importer</h2>
          <p className="subtitle">
            Nhập link sản phẩm Shopify có Customily → Import sẽ tự tạo Shopify Draft
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
              onChange={(e) => setImportUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !importing && handleImport()}
              placeholder="https://macorner.co/products/..."
              disabled={importing || (storeInfo && !storeInfo.configured)}
            />
            <button
              className="btn btn-primary"
              onClick={handleImport}
              disabled={!importUrl.trim() || importing || (storeInfo && !storeInfo.configured)}
            >
              {importing ? <span className="spinner"></span> : "📥"}
              {importing ? "Importing..." : "Import + Create Draft"}
            </button>
          </div>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="banner banner-error" style={{ marginBottom: 16 }}>
          <span className="banner-icon">❌</span>
          <div className="banner-content">
            <p>{error}</p>
          </div>
        </div>
      )}

      {/* Products Grid */}
      {products.length > 0 && (
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

      {activeProductRecord && (
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

      {/* Customizer Layout */}
      {activeProduct && options.length > 0 && (
        <div className="customizer-layout">
          {/* Left: Preview */}
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

          {/* Right: Form */}
          <CustomizerForm
            options={options}
            visibleOptionIds={visibleOptionIds}
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
    </div>
  );
}
