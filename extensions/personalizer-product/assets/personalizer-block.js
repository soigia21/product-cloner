(function productClonerThemeBlock() {
  "use strict";

  const EMBED_EVENT = "product-cloner:embedded-resize";
  const PREVIEW_EVENT = "product-cloner:preview-updated";
  const INTERACTION_EVENT = "product-cloner:user-interacted";
  const EDIT_STATE_EVENT = "product-cloner:upload-edit-state";
  const EDIT_ACTION_EVENT = "product-cloner:upload-edit-action";
  const MIN_HEIGHT = 0;
  const MAX_HEIGHT = 24000;
  const DEFAULT_HEIGHT = 220;
  const PREVIEW_RETRY_DELAY_MS = 240;
  const PREVIEW_RETRY_MAX_ATTEMPTS = 28;
  const PREVIEW_UPLOAD_DEBOUNCE_MS = 460;
  const PREVIEW_UPLOAD_TIMEOUT_MS = 9000;
  const MEDIA_MUTATION_DEBOUNCE_MS = 120;
  const MOUNT_OBSERVER_DEBOUNCE_MS = 60;
  const CART_PROP_TEMPLATE_ID = "properties[_pz_template_id]";
  const CART_PROP_PREVIEW_URL = "properties[_pz_preview_url]";
  const CART_PROP_PREVIEW_PUBLIC = "properties[Preview]";
  const iframeByWindow = new Map();
  let mountObserver = null;
  let mountDebounceTimer = null;
  let globalStyleMounted = false;
  let cartSubmitListenerBound = false;
  let previewModalNode = null;

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  function trimSlash(value) {
    return String(value || "").replace(/\/+$/, "");
  }

  function parseBoolean(value) {
    return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
  }

  function escapeSelectorValue(value) {
    const raw = String(value || "");
    if (typeof CSS !== "undefined" && CSS && typeof CSS.escape === "function") {
      return CSS.escape(raw);
    }
    return raw.replace(/["\\]/g, "\\$&");
  }

  function isVisible(el) {
    if (!el) return false;
    if (el.getClientRects().length === 0) return false;
    const style = window.getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0;
  }

  function matchesActiveMedia(el) {
    if (!el) return false;
    const node = el.closest(
      ".is-active, [aria-hidden='false'], [data-media-active='true'], .slick-current, .swiper-slide-active"
    );
    return Boolean(node);
  }

  function getRootSection(root) {
    return root?.closest(".shopify-section, section") || null;
  }

  function ensureGlobalStyle() {
    if (globalStyleMounted) return;
    const id = "pz-theme-block-global-style";
    if (document.getElementById(id)) {
      globalStyleMounted = true;
      return;
    }
    const style = document.createElement("style");
    style.id = id;
    style.textContent = "[data-pz-hidden-single-option='1']{display:none !important;}";
    document.head.appendChild(style);
    globalStyleMounted = true;
  }

  function isVariantOptionControlName(name) {
    const key = String(name || "").trim().toLowerCase();
    if (!key) return false;
    return (
      key.startsWith("options[") ||
      key === "option1" ||
      key === "option2" ||
      key === "option3"
    );
  }

  function findOptionWrapper(el) {
    if (!el) return null;
    return (
      el.closest(
        "[data-option-index], [data-option-position], [data-product-option], .product-form__input, .selector-wrapper, .variant-input-wrap, .product-option, fieldset"
      ) ||
      el.parentElement ||
      null
    );
  }

  function setOptionWrapperHidden(wrapper, hidden) {
    if (!wrapper) return;
    if (hidden) {
      wrapper.setAttribute("data-pz-hidden-single-option", "1");
      return;
    }
    wrapper.removeAttribute("data-pz-hidden-single-option");
  }

  function distinctSelectValues(select) {
    const values = new Set();
    for (const option of Array.from(select?.options || [])) {
      if (!option) continue;
      if (option.disabled) continue;
      const val = String(option.value || "").trim();
      if (!val) continue;
      values.add(val);
    }
    return values;
  }

  function hideSingleValueVariantOptions(root) {
    const section = getRootSection(root) || document;
    if (!section) return;
    ensureGlobalStyle();

    const touched = new Set();

    const selects = section.querySelectorAll("select[name], select[data-option-index], select[data-option-position]");
    for (const select of selects) {
      if (!(select instanceof HTMLSelectElement)) continue;
      if (!isVariantOptionControlName(select.name) && !select.hasAttribute("data-option-index") && !select.hasAttribute("data-option-position")) {
        continue;
      }
      const wrapper = findOptionWrapper(select);
      if (!wrapper) continue;
      touched.add(wrapper);
      const count = distinctSelectValues(select).size;
      setOptionWrapperHidden(wrapper, count <= 1);
    }

    const optionInputs = Array.from(section.querySelectorAll("input[type='radio'][name], input[type='checkbox'][name]"))
      .filter((input) => isVariantOptionControlName(input.name));
    const grouped = new Map();
    for (const input of optionInputs) {
      const key = String(input.name || "");
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(input);
    }
    for (const inputs of grouped.values()) {
      if (!inputs || inputs.length === 0) continue;
      const wrapper = findOptionWrapper(inputs[0]);
      if (!wrapper) continue;
      touched.add(wrapper);
      const values = new Set();
      for (const input of inputs) {
        if (!(input instanceof HTMLInputElement)) continue;
        if (input.disabled) continue;
        const val = String(input.value || "").trim();
        if (!val) continue;
        values.add(val);
      }
      setOptionWrapperHidden(wrapper, values.size <= 1);
    }

    const containerCandidates = section.querySelectorAll(
      "[data-option-index], [data-option-position], [data-product-option], .product-form__input, .selector-wrapper, .variant-input-wrap, fieldset"
    );
    for (const container of containerCandidates) {
      if (!(container instanceof HTMLElement)) continue;
      if (touched.has(container)) continue;
      const buttons = container.querySelectorAll("[data-option-value], [data-value]");
      if (!buttons || buttons.length === 0) continue;
      const values = new Set();
      for (const btn of buttons) {
        const val = String(
          btn.getAttribute("data-option-value") ||
          btn.getAttribute("data-value") ||
          ""
        ).trim();
        if (!val) continue;
        values.add(val);
      }
      if (values.size === 0) continue;
      setOptionWrapperHidden(container, values.size <= 1);
    }
  }

  function isAddToCartForm(form) {
    if (!(form instanceof HTMLFormElement)) return false;
    const action = String(form.getAttribute("action") || "").toLowerCase();
    if (action.includes("/cart/add")) return true;
    if (form.matches("form[action*='/cart/add'], form[action*='/cart/add.js']")) return true;
    const submit = form.querySelector("button[type='submit'], input[type='submit']");
    const variantInput = form.querySelector("input[name='id'], select[name='id']");
    return Boolean(submit && variantInput);
  }

  function resolveCandidateCartForms(root) {
    const section = getRootSection(root);
    const selectors = [
      "form[action*='/cart/add']",
      "form[action*='/cart/add.js']",
      "form[data-type='add-to-cart-form']",
      "product-form form",
      "form.product-form",
    ];
    const map = new Map();
    const collect = (scope) => {
      if (!scope || !scope.querySelectorAll) return;
      for (const selector of selectors) {
        for (const form of scope.querySelectorAll(selector)) {
          if (!(form instanceof HTMLFormElement)) continue;
          if (!isAddToCartForm(form)) continue;
          if (!map.has(form)) map.set(form, form);
        }
      }
    };
    collect(section);
    const localForms = [...map.values()];
    if (localForms.length > 0) return localForms;
    collect(document);
    return [...map.values()];
  }

  function findLinkedForForm(form) {
    if (!(form instanceof HTMLFormElement)) return null;
    const formSection = getRootSection(form);
    let best = null;
    let bestScore = -Infinity;
    for (const linked of iframeByWindow.values()) {
      if (!linked?.root || !linked.root.isConnected) continue;
      const root = linked.root;
      const rootSection = getRootSection(root);
      let score = 0;
      if (formSection && rootSection && formSection === rootSection) score += 120;
      if (formSection && rootSection && formSection.contains(root)) score += 24;
      if (root.contains(form)) score += 50;
      if (form.contains(root)) score += 14;
      if (isVisible(root)) score += 8;
      if (score > bestScore) {
        best = linked;
        bestScore = score;
      }
    }
    if (bestScore < 18) return null;
    return best;
  }

  function setHiddenFormValue(form, name, value) {
    if (!(form instanceof HTMLFormElement)) return;
    const key = String(name || "").trim();
    if (!key) return;
    const val = String(value || "");
    let input = form.querySelector(`input[type='hidden'][name="${escapeSelectorValue(key)}"]`);
    if (!input) {
      input = document.createElement("input");
      input.type = "hidden";
      input.name = key;
      form.appendChild(input);
    }
    input.value = val;
  }

  function removeHiddenFormValue(form, name) {
    if (!(form instanceof HTMLFormElement)) return;
    const key = String(name || "").trim();
    if (!key) return;
    const input = form.querySelector(`input[type='hidden'][name="${escapeSelectorValue(key)}"]`);
    if (input) input.remove();
  }

  function resolvePreviewDisplayUrl(linked) {
    if (!linked) return "";
    const uploaded = String(linked.lastUploadedPreviewUrl || "").trim();
    if (uploaded) return uploaded;
    const pending = String(linked.pendingPreviewUrl || linked.lastAppliedPreviewUrl || "").trim();
    if (pending.startsWith("data:image/")) return pending;
    return "";
  }

  function syncCartProperties(linked) {
    if (!linked?.root) return;
    const templateId = String(linked.root.dataset.templateId || "").trim();
    const previewUrl = String(linked.lastUploadedPreviewUrl || "").trim();
    const forms = resolveCandidateCartForms(linked.root);
    for (const form of forms) {
      if (!(form instanceof HTMLFormElement)) continue;
      if (templateId) {
        setHiddenFormValue(form, CART_PROP_TEMPLATE_ID, templateId);
      } else {
        removeHiddenFormValue(form, CART_PROP_TEMPLATE_ID);
      }

      if (linked.userInteracted && previewUrl) {
        setHiddenFormValue(form, CART_PROP_PREVIEW_URL, previewUrl);
        setHiddenFormValue(form, CART_PROP_PREVIEW_PUBLIC, previewUrl);
      } else {
        removeHiddenFormValue(form, CART_PROP_PREVIEW_URL);
        removeHiddenFormValue(form, CART_PROP_PREVIEW_PUBLIC);
      }
    }
  }

  function ensurePreviewModal() {
    if (previewModalNode && previewModalNode.isConnected) return previewModalNode;
    const node = document.createElement("div");
    node.className = "pz-preview-modal";
    node.setAttribute("hidden", "hidden");
    node.innerHTML = `
      <div class="pz-preview-modal-inner" role="dialog" aria-modal="true" aria-label="Personalized Preview">
        <button type="button" class="pz-preview-close" aria-label="Close preview">×</button>
        <img class="pz-preview-modal-image" alt="Personalized preview" />
      </div>
    `;
    const close = () => node.setAttribute("hidden", "hidden");
    node.addEventListener("click", (event) => {
      if (event.target === node) close();
    });
    const closeBtn = node.querySelector(".pz-preview-close");
    if (closeBtn) {
      closeBtn.addEventListener("click", (event) => {
        event.preventDefault();
        close();
      });
    }
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") close();
    });
    document.body.appendChild(node);
    previewModalNode = node;
    return node;
  }

  function openPreviewModal(url) {
    const src = String(url || "").trim();
    if (!src) return;
    const modal = ensurePreviewModal();
    const image = modal.querySelector(".pz-preview-modal-image");
    if (image instanceof HTMLImageElement) {
      image.src = src;
    }
    modal.removeAttribute("hidden");
  }

  function ensurePreviewButton(linked) {
    if (!linked?.root) return null;
    let button = linked.previewButton;
    if (button instanceof HTMLButtonElement && button.isConnected) return button;

    let row = linked.root.querySelector(".pz-preview-row");
    if (!(row instanceof HTMLElement)) {
      row = document.createElement("div");
      row.className = "pz-preview-row";
      linked.root.appendChild(row);
    }
    button = row.querySelector(".pz-preview-btn");
    if (!(button instanceof HTMLButtonElement)) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "pz-preview-btn";
      button.textContent = "Preview";
      row.appendChild(button);
    }
    if (button.dataset.pzBound !== "1") {
      button.dataset.pzBound = "1";
      button.addEventListener("click", (event) => {
        event.preventDefault();
        const previewUrl = String(button.dataset.previewUrl || "");
        if (!previewUrl) return;
        openPreviewModal(previewUrl);
      });
    }
    linked.previewButton = button;
    return button;
  }

  function syncPreviewButton(linked) {
    if (!linked) return;
    const button = ensurePreviewButton(linked);
    if (!(button instanceof HTMLButtonElement)) return;
    const previewUrl = linked.userInteracted ? resolvePreviewDisplayUrl(linked) : "";
    button.dataset.previewUrl = previewUrl;
    button.disabled = !previewUrl;
    button.setAttribute("aria-disabled", button.disabled ? "true" : "false");
  }

  function toAbsoluteUrl(base, maybeUrl) {
    const raw = String(maybeUrl || "").trim();
    if (!raw) return "";
    if (/^https?:\/\//i.test(raw) || raw.startsWith("data:image/")) return raw;
    const origin = trimSlash(base);
    if (!origin) return raw;
    try {
      return new URL(raw, `${origin}/`).toString();
    } catch {
      return raw;
    }
  }

  async function uploadPreviewSnapshot(linked, options = {}) {
    if (!linked?.root) return "";
    const force = Boolean(options.force);
    const sourceDataUrl = String(linked.pendingPreviewUrl || linked.lastAppliedPreviewUrl || "").trim();
    if (!sourceDataUrl.startsWith("data:image/")) return "";

    if (!force && linked.lastUploadedPreviewSource === sourceDataUrl && linked.lastUploadedPreviewUrl) {
      return linked.lastUploadedPreviewUrl;
    }
    if (linked.previewUploadPromise) {
      return linked.previewUploadPromise;
    }

    const appBase = trimSlash(linked.root.dataset.appBaseUrl || "");
    const templateId = String(linked.root.dataset.templateId || "").trim();
    if (!appBase || !templateId) return "";

    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timeoutTimer = setTimeout(() => {
      try {
        controller?.abort();
      } catch { }
    }, PREVIEW_UPLOAD_TIMEOUT_MS);

    const requestUrl = `${appBase}/api/products/${encodeURIComponent(templateId)}/upload-image`;
    const payload = {
      optionId: "_preview_snapshot",
      fileName: `preview-${Date.now()}.jpg`,
      mimeType: "image/jpeg",
      dataUrl: sourceDataUrl,
    };

    linked.previewUploadPromise = fetch(requestUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      mode: "cors",
      credentials: "omit",
      signal: controller ? controller.signal : undefined,
    })
      .then(async (res) => {
        let body = null;
        try {
          body = await res.json();
        } catch { }
        if (!res.ok || !body?.success || !body?.upload?.url) {
          throw new Error(body?.error || `Upload failed (${res.status})`);
        }
        const absolute = toAbsoluteUrl(appBase, body.upload.url);
        linked.lastUploadedPreviewSource = sourceDataUrl;
        linked.lastUploadedPreviewUrl = absolute;
        return absolute;
      })
      .catch((error) => {
        console.warn("[Personalizer Block] Preview snapshot upload failed", error);
        return linked.lastUploadedPreviewUrl || "";
      })
      .finally(() => {
        clearTimeout(timeoutTimer);
        linked.previewUploadPromise = null;
        syncPreviewButton(linked);
        syncCartProperties(linked);
      });

    return linked.previewUploadPromise;
  }

  function schedulePreviewUpload(linked) {
    if (!linked?.userInteracted) return;
    const sourceDataUrl = String(linked.pendingPreviewUrl || linked.lastAppliedPreviewUrl || "").trim();
    if (!sourceDataUrl.startsWith("data:image/")) return;
    if (linked.lastUploadedPreviewSource === sourceDataUrl && linked.lastUploadedPreviewUrl) return;
    if (linked.previewUploadTimer) {
      clearTimeout(linked.previewUploadTimer);
    }
    linked.previewUploadTimer = setTimeout(() => {
      linked.previewUploadTimer = null;
      uploadPreviewSnapshot(linked).catch(() => { });
    }, PREVIEW_UPLOAD_DEBOUNCE_MS);
  }

  function restoreOriginalImageSource(img) {
    if (!(img instanceof HTMLImageElement)) return;
    const original = String(img.dataset.pzOriginalSrc || "").trim();
    if (!original) return;

    const current = String(img.currentSrc || img.src || "");
    if (img.dataset.pzPreviewApplied !== "1" && !current.startsWith("data:image/")) return;

    img.src = original;
    img.setAttribute("data-src", original);
    img.removeAttribute("srcset");
    img.removeAttribute("sizes");
    img.removeAttribute("data-pz-preview-applied");

    const pic = img.closest("picture");
    if (!pic) return;
    const sources = pic.querySelectorAll("source");
    for (const source of sources) {
      source.setAttribute("srcset", original);
      source.setAttribute("data-srcset", original);
    }
  }

  function restoreLegacyReplacedImages(root) {
    const scope = getRootSection(root) || document;
    const replaced = scope.querySelectorAll("img[data-pz-preview-applied='1']");
    for (const img of replaced) {
      restoreOriginalImageSource(img);
    }
  }

  function ensureMainPreviewCanvas(linked, host) {
    if (!linked || !(host instanceof HTMLElement)) return null;
    let canvas = linked.previewCanvas;
    if (!(canvas instanceof HTMLCanvasElement)) {
      canvas = document.createElement("canvas");
      canvas.className = "pz-main-preview-canvas";
      canvas.setAttribute("hidden", "hidden");
      linked.previewCanvas = canvas;
    }
    if (window.getComputedStyle(host).position === "static") {
      host.style.position = "relative";
    }
    if (canvas.parentElement !== host) {
      host.appendChild(canvas);
    }
    linked.previewCanvasHost = host;
    return canvas;
  }

  function syncPreviewCanvasBounds(host, image, canvas) {
    if (!(host instanceof HTMLElement) || !(image instanceof HTMLImageElement) || !(canvas instanceof HTMLCanvasElement)) {
      return false;
    }
    const hostRect = host.getBoundingClientRect();
    const imageRect = image.getBoundingClientRect();
    const drawWidth = Math.max(1, Math.round(imageRect.width));
    const drawHeight = Math.max(1, Math.round(imageRect.height));
    if (drawWidth <= 1 || drawHeight <= 1) return false;
    const dpr = Math.max(1, Math.min(Number(window.devicePixelRatio) || 1, 2.5));
    const bitmapWidth = Math.max(1, Math.round(drawWidth * dpr));
    const bitmapHeight = Math.max(1, Math.round(drawHeight * dpr));

    const left = Math.max(0, imageRect.left - hostRect.left);
    const top = Math.max(0, imageRect.top - hostRect.top);

    canvas.style.left = `${left}px`;
    canvas.style.top = `${top}px`;
    canvas.style.width = `${drawWidth}px`;
    canvas.style.height = `${drawHeight}px`;
    canvas.dataset.pzDpr = String(dpr);

    if (canvas.width !== bitmapWidth) canvas.width = bitmapWidth;
    if (canvas.height !== bitmapHeight) canvas.height = bitmapHeight;
    return true;
  }

  function paintPreviewToCanvas(linked, canvas, previewUrl) {
    if (!linked || !(canvas instanceof HTMLCanvasElement)) return false;
    const token = Number(linked.previewRenderToken || 0) + 1;
    linked.previewRenderToken = token;
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      if (token !== linked.previewRenderToken) return;
      if (!(canvas instanceof HTMLCanvasElement)) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const w = Number(canvas.width) || 0;
      const h = Number(canvas.height) || 0;
      if (w <= 0 || h <= 0) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, w, h);
      canvas.removeAttribute("hidden");
    };
    img.onerror = () => { };
    img.src = previewUrl;
    return true;
  }

  function collectFeaturedImages(root) {
    const selectors = [
      "media-gallery .product__media-item.is-active img",
      ".product__media-item.is-active img",
      ".product__media-item[aria-hidden='false'] img",
      "media-gallery .product__media img",
      "[data-product-media-container] img",
      "[data-product-media] img",
      "[data-media-id] img",
      ".product__media img",
      ".featured-media img",
      ".product-gallery__image img",
      ".product-single__media img",
      ".product-gallery img",
      "main img",
    ];
    const rootSection = getRootSection(root);
    const seen = new Map();

    for (const selector of selectors) {
      const list = document.querySelectorAll(selector);
      for (const img of list) {
        if (!(img instanceof HTMLImageElement)) continue;
        if (!isVisible(img)) continue;
        const width = Number(img.clientWidth || img.naturalWidth || 0);
        const height = Number(img.clientHeight || img.naturalHeight || 0);
        if (width < 120 || height < 120) continue;
        const inSameSection = rootSection && img.closest(".shopify-section, section") === rootSection;
        const inMediaContainer = Boolean(
          img.closest(
            "media-gallery, .product__media, [data-product-media], [data-media-id], .product-gallery, .product-single__media, .featured-media"
          )
        );
        const isThumb = Boolean(
          img.closest(
            ".thumbnail, .product__media-thumbnail, [data-thumbnail], .product-gallery__thumbnail, .product-thumbnails"
          )
        );
        const areaScore = Math.min((width * height) / 14000, 160);
        const score =
          areaScore +
          (matchesActiveMedia(img) ? 30 : 0) +
          (inMediaContainer ? 18 : 0) +
          (inSameSection ? 20 : 0) +
          (selector.includes("is-active") ? 8 : 0) -
          (isThumb ? 26 : 0);
        const prev = seen.get(img);
        if (!prev || score > prev.score) {
          seen.set(img, { img, score });
        }
      }
    }

    const candidates = [...seen.values()];
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.score - a.score);
    const topScore = candidates[0].score;
    return candidates
      .filter((entry) => entry.score >= topScore - 14)
      .slice(0, 6)
      .map((entry) => entry.img);
  }

  function applyPreviewAsMainImage(linked, previewUrl) {
    if (!linked) return false;
    const hostInfo = resolveMainImageHost(linked.root);
    if (!hostInfo?.host || !hostInfo?.image) return false;
    const host = hostInfo.host;
    const image = hostInfo.image;
    if (!(image instanceof HTMLImageElement)) return false;
    if (!image.dataset.pzOriginalSrc) {
      image.dataset.pzOriginalSrc = image.currentSrc || image.src || "";
    }
    restoreOriginalImageSource(image);

    const canvas = ensureMainPreviewCanvas(linked, host);
    if (!(canvas instanceof HTMLCanvasElement)) return false;
    if (!syncPreviewCanvasBounds(host, image, canvas)) return false;
    if (!paintPreviewToCanvas(linked, canvas, previewUrl)) return false;

    window.dispatchEvent(
      new CustomEvent("product-cloner:main-image-updated", {
        detail: {
          previewUrl,
          count: 1,
          element: image,
          canvas,
          host,
        },
      })
    );

    return true;
  }

  function normalizeEditTransform(raw) {
    const offsetX = Number(raw?.offsetX);
    const offsetY = Number(raw?.offsetY);
    const scale = Number(raw?.scale);
    const rotation = Number(raw?.rotation);
    return {
      offsetX: Number.isFinite(offsetX) ? offsetX : 0,
      offsetY: Number.isFinite(offsetY) ? offsetY : 0,
      scale: Number.isFinite(scale) ? scale : 1,
      rotation: Number.isFinite(rotation) ? rotation : 0,
    };
  }

  function clearEditHideTimer(linked) {
    if (!linked) return;
    if (linked.editHideTimer) {
      clearTimeout(linked.editHideTimer);
      linked.editHideTimer = null;
    }
  }

  function postEditAction(linked, action, amount = 0) {
    if (!linked?.iframe?.contentWindow) return;
    try {
      linked.iframe.contentWindow.postMessage(
        {
          type: EDIT_ACTION_EVENT,
          action,
          amount,
        },
        linked.expectedOrigin || "*"
      );
    } catch { }
  }

  function createEditButton(linked, label, action, amount = 0, className = "") {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `pz-main-edit-btn ${className}`.trim();
    btn.textContent = label;
    btn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      postEditAction(linked, action, amount);
    });
    return btn;
  }

  function ensureMainEditBar(linked) {
    if (!linked) return null;
    if (linked.editBar && linked.editBar instanceof HTMLElement) return linked.editBar;

    const bar = document.createElement("div");
    bar.className = "pz-main-edit-bar";
    bar.setAttribute("hidden", "hidden");

    const row = document.createElement("div");
    row.className = "pz-main-edit-row";
    const controls = [
      ["-", "zoom", -0.08],
      ["+", "zoom", 0.08],
      ["↑", "moveY", -8, "is-arrow"],
      ["↓", "moveY", 8, "is-arrow"],
      ["←", "moveX", -8, "is-arrow"],
      ["→", "moveX", 8, "is-arrow"],
      ["↺", "rotate", -3, "is-arrow"],
      ["↻", "rotate", 3, "is-arrow"],
      ["Reset", "reset", 0],
    ];
    for (const [label, action, amount, className] of controls) {
      row.appendChild(createEditButton(linked, label, action, amount, className || ""));
    }

    const state = document.createElement("div");
    state.className = "pz-main-edit-state";
    state.textContent = "";

    bar.appendChild(row);
    bar.appendChild(state);
    linked.editBar = bar;
    return bar;
  }

  function resolveMainImageHost(root) {
    const targets = collectFeaturedImages(root);
    if (targets && targets.length > 0) {
      const image = targets[0];
      let host =
        image.closest(
          "[data-product-media-container], .product__media-item, .product__media, .featured-media, .product-single__media, .product-gallery__image, .product-main-image, [data-media-id], figure"
        ) ||
        image.parentElement ||
        null;
      if (host instanceof HTMLElement && host.tagName === "PICTURE" && host.parentElement instanceof HTMLElement) {
        host = host.parentElement;
      }
      if (host instanceof HTMLElement) {
        return { image, host };
      }
    }

    const section = getRootSection(root) || document;
    const fallback = section.querySelector(
      "media-gallery img, .product__media img, [data-product-media-container] img, [data-product-media] img, [data-media-id] img, .featured-media img, .product-gallery img, .product-single__media img, img.product-featured-media"
    );
    if (!(fallback instanceof HTMLImageElement)) return null;
    let fallbackHost =
      fallback.closest(
        "[data-product-media-container], .product__media-item, .product__media, .featured-media, .product-single__media, .product-gallery__image, .product-main-image, [data-media-id], figure"
      ) ||
      fallback.parentElement ||
      null;
    if (fallbackHost instanceof HTMLElement && fallbackHost.tagName === "PICTURE" && fallbackHost.parentElement instanceof HTMLElement) {
      fallbackHost = fallbackHost.parentElement;
    }
    if (!(fallbackHost instanceof HTMLElement)) return null;
    return { image: fallback, host: fallbackHost };
  }

  function syncMainEditBar(linked) {
    if (!linked) return;
    const bar = ensureMainEditBar(linked);
    if (!bar) return;

    const editable = Boolean(linked.editState?.editable);
    if (!editable) {
      bar.setAttribute("hidden", "hidden");
      return;
    }
    clearEditHideTimer(linked);

    const hostInfo = resolveMainImageHost(linked.root);
    let host = hostInfo?.host || null;
    if (!host && linked.previewCanvasHost && linked.previewCanvasHost.isConnected) {
      host = linked.previewCanvasHost;
    }
    if (!host && linked.editBarHost && linked.editBarHost.isConnected) {
      host = linked.editBarHost;
    }
    if (!host) {
      bar.setAttribute("hidden", "hidden");
      return;
    }
    if (window.getComputedStyle(host).position === "static") {
      host.style.position = "relative";
    }

    if (linked.editBarHost !== host || bar.parentElement !== host) {
      host.appendChild(bar);
      linked.editBarHost = host;
    }

    const transform = normalizeEditTransform(linked.editState?.transform || {});
    const stateNode = bar.querySelector(".pz-main-edit-state");
    if (stateNode) {
      stateNode.textContent = `X: ${transform.offsetX.toFixed(1)} | Y: ${transform.offsetY.toFixed(1)} | Zoom: ${transform.scale.toFixed(2)} | R: ${transform.rotation.toFixed(1)}°`;
    }

    bar.removeAttribute("hidden");
  }

  function clearPreviewRetry(linked) {
    if (!linked) return;
    clearEditHideTimer(linked);
    if (linked.retryTimer) {
      clearTimeout(linked.retryTimer);
      linked.retryTimer = null;
    }
    if (linked.observerDebounceTimer) {
      clearTimeout(linked.observerDebounceTimer);
      linked.observerDebounceTimer = null;
    }
    if (linked.previewUploadTimer) {
      clearTimeout(linked.previewUploadTimer);
      linked.previewUploadTimer = null;
    }
    linked.retryAttempts = 0;
  }

  function tryApplyPendingPreview(linked) {
    if (!linked || !linked.pendingPreviewUrl) return false;
    if (linked.pendingPreviewUrl === linked.lastAppliedPreviewUrl) {
      const refreshed = applyPreviewAsMainImage(linked, linked.pendingPreviewUrl);
      if (refreshed) {
        clearPreviewRetry(linked);
        syncMainEditBar(linked);
        syncPreviewButton(linked);
        syncCartProperties(linked);
        return true;
      }
    }

    const ok = applyPreviewAsMainImage(linked, linked.pendingPreviewUrl);
    if (ok) {
      linked.lastPreviewUrl = linked.pendingPreviewUrl;
      linked.lastAppliedPreviewUrl = linked.pendingPreviewUrl;
      clearPreviewRetry(linked);
      schedulePreviewUpload(linked);
      syncMainEditBar(linked);
      syncPreviewButton(linked);
      syncCartProperties(linked);
      return true;
    }

    linked.retryAttempts = Number(linked.retryAttempts || 0) + 1;
    if (linked.retryAttempts > PREVIEW_RETRY_MAX_ATTEMPTS) {
      clearPreviewRetry(linked);
      return false;
    }

    if (linked.retryTimer) clearTimeout(linked.retryTimer);
    linked.retryTimer = setTimeout(() => {
      linked.retryTimer = null;
      tryApplyPendingPreview(linked);
    }, PREVIEW_RETRY_DELAY_MS);
    return false;
  }

  function bindMediaObserver(linked) {
    if (!linked || linked.observer || typeof MutationObserver === "undefined") return;
    const observeRoot = getRootSection(linked.root) || document.body;
    if (!observeRoot) return;

    const observer = new MutationObserver(() => {
      if (linked.observerDebounceTimer) clearTimeout(linked.observerDebounceTimer);
      linked.observerDebounceTimer = setTimeout(() => {
        linked.observerDebounceTimer = null;
        hideSingleValueVariantOptions(linked.root);
        if (linked.pendingPreviewUrl) {
          tryApplyPendingPreview(linked);
        }
        syncMainEditBar(linked);
      }, MEDIA_MUTATION_DEBOUNCE_MS);
    });

    observer.observe(observeRoot, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "src", "srcset", "aria-hidden", "data-media-active"],
    });
    linked.observer = observer;
  }

  function getStatusNode(root) {
    return root.querySelector(".pz-status");
  }

  function setStatus(root, text, className) {
    const node = getStatusNode(root);
    if (!node) return;
    node.className = `pz-status ${className || ""}`.trim();
    node.textContent = String(text || "");
  }

  function ensureDebugNode(root) {
    let debugNode = root.querySelector(".pz-debug");
    if (!debugNode) {
      debugNode = document.createElement("pre");
      debugNode.className = "pz-debug";
      root.appendChild(debugNode);
    }
    return debugNode;
  }

  function setDebug(root, payload) {
    if (!parseBoolean(root.dataset.showDebug)) return;
    const debugNode = ensureDebugNode(root);
    debugNode.textContent = JSON.stringify(payload, null, 2);
  }

  function buildEmbedUrl(root) {
    const appBase = trimSlash(root.dataset.appBaseUrl);
    if (!appBase) return null;

    let url;
    try {
      url = new URL(`${appBase}/`, window.location.origin);
    } catch {
      return null;
    }

    const params = url.searchParams;
    params.set("embedded", "1");
    params.set("hide_preview", "1");
    params.set("preview_target", "main_image");

    const templateId = String(root.dataset.templateId || "").trim();
    const productId = String(root.dataset.productId || "").trim();
    const productHandle = String(root.dataset.productHandle || "").trim();

    if (templateId) params.set("template_id", templateId);
    if (productId) params.set("product_id", productId);
    if (productHandle) params.set("handle", productHandle);
    return url;
  }

  function bindIframeResize(iframe, expectedOrigin, root) {
    if (!iframe?.contentWindow) return;

    // Cleanup stale links when iframe contentWindow rotates (navigation/reload).
    for (const [win, stale] of iframeByWindow.entries()) {
      if (win === iframe.contentWindow) continue;
      if (!stale || stale.iframe !== iframe) continue;
      clearPreviewRetry(stale);
      if (stale.observer) {
        try { stale.observer.disconnect(); } catch { }
        stale.observer = null;
      }
      iframeByWindow.delete(win);
    }

    let linked = iframeByWindow.get(iframe.contentWindow);
    if (!linked) {
      linked = {
        iframe,
        expectedOrigin,
        root,
        userInteracted: false,
        lastPreviewUrl: "",
        lastAppliedPreviewUrl: "",
        pendingPreviewUrl: "",
        retryTimer: null,
        retryAttempts: 0,
        observer: null,
        observerDebounceTimer: null,
        editState: { editable: false, optionId: "", transform: normalizeEditTransform({}) },
        editBar: null,
        editBarHost: null,
        editHideTimer: null,
        uploadFocused: false,
        previewCanvas: null,
        previewCanvasHost: null,
        previewRenderToken: 0,
        previewButton: null,
        previewUploadTimer: null,
        previewUploadPromise: null,
        lastUploadedPreviewSource: "",
        lastUploadedPreviewUrl: "",
        lastFocusAt: 0,
        lastEditStateAt: 0,
      };
      iframeByWindow.set(iframe.contentWindow, linked);
    }

    // Keep the same object reference so observer/message callbacks always see latest state.
    linked.iframe = iframe;
    linked.expectedOrigin = expectedOrigin;
    linked.root = root;
    linked.userInteracted = Boolean(linked.userInteracted);
    linked.lastPreviewUrl = String(linked.lastPreviewUrl || "");
    linked.lastAppliedPreviewUrl = String(linked.lastAppliedPreviewUrl || "");
    linked.pendingPreviewUrl = String(linked.pendingPreviewUrl || "");
    linked.retryTimer = linked.retryTimer || null;
    linked.retryAttempts = Number(linked.retryAttempts || 0);
    linked.observer = linked.observer || null;
    linked.observerDebounceTimer = linked.observerDebounceTimer || null;
    if (!linked.editState || typeof linked.editState !== "object") {
      linked.editState = { editable: false, optionId: "", transform: normalizeEditTransform({}) };
    } else {
      linked.editState = {
        editable: Boolean(linked.editState.editable),
        optionId: String(linked.editState.optionId || ""),
        transform: normalizeEditTransform(linked.editState.transform || {}),
      };
    }
    linked.editBar = linked.editBar || null;
    linked.editBarHost = linked.editBarHost || null;
    linked.editHideTimer = linked.editHideTimer || null;
    linked.uploadFocused = Boolean(linked.uploadFocused);
    linked.previewCanvas = linked.previewCanvas || null;
    linked.previewCanvasHost = linked.previewCanvasHost || null;
    linked.previewRenderToken = Number(linked.previewRenderToken || 0);
    linked.previewButton = linked.previewButton || null;
    linked.previewUploadTimer = linked.previewUploadTimer || null;
    linked.previewUploadPromise = linked.previewUploadPromise || null;
    linked.lastUploadedPreviewSource = String(linked.lastUploadedPreviewSource || "");
    linked.lastUploadedPreviewUrl = String(linked.lastUploadedPreviewUrl || "");
    linked.lastFocusAt = Number(linked.lastFocusAt || 0);
    linked.lastEditStateAt = Number(linked.lastEditStateAt || 0);

    restoreLegacyReplacedImages(root);
    syncPreviewButton(linked);
    syncCartProperties(linked);
    bindMediaObserver(linked);
    syncMainEditBar(linked);
    if (linked.userInteracted && linked.pendingPreviewUrl) {
      tryApplyPendingPreview(linked);
    }
  }

  function mountRoot(root) {
    if (!root || root.dataset.pzMounted === "1") return;
    root.dataset.pzMounted = "1";

    try {
      const embedUrl = buildEmbedUrl(root);
      if (!embedUrl) {
        console.error("[Personalizer Block] Missing app_base_url for embedded personalizer");
        return;
      }

      const shell = document.createElement("div");
      shell.className = "pz-embed-shell";

      const iframe = document.createElement("iframe");
      iframe.className = "pz-embed-frame";
      iframe.loading = "lazy";
      iframe.referrerPolicy = "strict-origin-when-cross-origin";
      iframe.allow = "clipboard-read; clipboard-write";
      iframe.setAttribute("scrolling", "no");
      iframe.src = embedUrl.toString();
      iframe.style.height = `${DEFAULT_HEIGHT}px`;
      iframe.style.overflow = "visible";
      shell.appendChild(iframe);
      root.appendChild(shell);

      bindIframeResize(iframe, embedUrl.origin, root);
      hideSingleValueVariantOptions(root);

      iframe.addEventListener("load", () => {
        bindIframeResize(iframe, embedUrl.origin, root);
        hideSingleValueVariantOptions(root);
        setDebug(root, {
          src: iframe.src,
          templateId: root.dataset.templateId || "",
          productId: root.dataset.productId || "",
          handle: root.dataset.productHandle || "",
        });
      });
    } catch (error) {
      root.dataset.pzMounted = "0";
      console.error("[Personalizer Block] Failed to initialize personalizer", error);
    }
  }

  function mountAll() {
    ensureGlobalStyle();
    ensureCartSubmitListener();
    const roots = document.querySelectorAll("[data-personalizer-block]");
    for (const root of roots) {
      mountRoot(root);
    }
  }

  function scheduleMountAll() {
    if (mountDebounceTimer) clearTimeout(mountDebounceTimer);
    mountDebounceTimer = setTimeout(() => {
      mountDebounceTimer = null;
      mountAll();
    }, MOUNT_OBSERVER_DEBOUNCE_MS);
  }

  function ensureMountObserver() {
    if (mountObserver || typeof MutationObserver === "undefined") return;
    mountObserver = new MutationObserver((mutations) => {
      let shouldMount = false;
      for (const mutation of mutations || []) {
        if (mutation.type !== "childList") continue;
        if ((mutation.addedNodes && mutation.addedNodes.length > 0) || (mutation.removedNodes && mutation.removedNodes.length > 0)) {
          shouldMount = true;
          break;
        }
      }
      if (shouldMount) scheduleMountAll();
    });

    mountObserver.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true,
    });
  }

  async function handleCartFormSubmit(event) {
    const form = event?.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (!isAddToCartForm(form)) return;
    if (form.dataset.pzBypassSubmit === "1") {
      form.dataset.pzBypassSubmit = "0";
      return;
    }

    const linked = findLinkedForForm(form);
    if (!linked?.root) return;

    syncCartProperties(linked);
    if (!linked.userInteracted) return;

    const sourceDataUrl = String(linked.pendingPreviewUrl || linked.lastAppliedPreviewUrl || "").trim();
    if (!sourceDataUrl.startsWith("data:image/")) return;
    if (linked.lastUploadedPreviewSource === sourceDataUrl && linked.lastUploadedPreviewUrl) {
      syncCartProperties(linked);
      return;
    }

    event.preventDefault();
    const submitter = event.submitter instanceof HTMLElement ? event.submitter : null;
    const canDisableSubmitter = submitter && "disabled" in submitter;
    const oldSubmitterDisabled = canDisableSubmitter ? Boolean(submitter.disabled) : false;
    if (canDisableSubmitter) submitter.disabled = true;

    try {
      await uploadPreviewSnapshot(linked, { force: true });
      syncCartProperties(linked);
    } catch { }
    finally {
      if (canDisableSubmitter) {
        submitter.disabled = oldSubmitterDisabled;
      }
    }

    form.dataset.pzBypassSubmit = "1";
    if (typeof form.requestSubmit === "function") {
      try {
        if (submitter) {
          form.requestSubmit(submitter);
        } else {
          form.requestSubmit();
        }
        return;
      } catch { }
    }
    form.submit();
  }

  function ensureCartSubmitListener() {
    if (cartSubmitListenerBound) return;
    document.addEventListener("submit", (event) => {
      handleCartFormSubmit(event).catch(() => { });
    }, true);
    cartSubmitListenerBound = true;
  }

  window.addEventListener("message", (event) => {
    const payload = event?.data;
    if (!payload || !payload.type) return;

    const linked = iframeByWindow.get(event.source);
    if (!linked?.iframe) return;
    if (linked.expectedOrigin && event.origin !== linked.expectedOrigin) return;

    if (payload.type === EMBED_EVENT) {
      const nextHeight = clamp(Number(payload.height) || DEFAULT_HEIGHT, MIN_HEIGHT, MAX_HEIGHT);
      linked.iframe.style.height = `${nextHeight}px`;
      return;
    }

    if (payload.type === PREVIEW_EVENT) {
      const previewUrl = String(payload.previewUrl || "");
      if (!previewUrl.startsWith("data:image/")) return;
      linked.pendingPreviewUrl = previewUrl;
      syncPreviewButton(linked);
      syncCartProperties(linked);
      if (!linked.userInteracted) return;
      if (previewUrl === linked.lastAppliedPreviewUrl) return;
      tryApplyPendingPreview(linked);
      schedulePreviewUpload(linked);
      syncMainEditBar(linked);
      return;
    }

    if (payload.type === INTERACTION_EVENT) {
      linked.userInteracted = true;
      const source = String(payload.source || "");
      const rawInteractionAt = Number(payload.sentAt);
      const interactionAt = Number.isFinite(rawInteractionAt) ? rawInteractionAt : Date.now();
      if (source === "upload-focus") {
        linked.lastFocusAt = Math.max(Number(linked.lastFocusAt || 0), interactionAt);
        linked.uploadFocused = true;
        clearEditHideTimer(linked);
        linked.editState = {
          editable: true,
          optionId: String(payload.optionId || ""),
          transform: linked.editState?.transform || normalizeEditTransform({}),
        };
      } else if (source === "upload-clear") {
        linked.uploadFocused = false;
        clearEditHideTimer(linked);
        linked.editState = {
          editable: false,
          optionId: "",
          transform: linked.editState?.transform || normalizeEditTransform({}),
        };
      }
      if (linked.pendingPreviewUrl) {
        tryApplyPendingPreview(linked);
      }
      schedulePreviewUpload(linked);
      syncPreviewButton(linked);
      syncCartProperties(linked);
      syncMainEditBar(linked);
      return;
    }

    if (payload.type === EDIT_STATE_EVENT) {
      const rawEventAt = Number(payload.sentAt);
      const eventAt = Number.isFinite(rawEventAt) ? rawEventAt : Date.now();
      if (eventAt < Number(linked.lastEditStateAt || 0)) return;
      linked.lastEditStateAt = eventAt;
      const nextEditable = Boolean(payload.editable);
      const nextOptionId = String(payload.optionId || "");
      const nextTransform = normalizeEditTransform(payload.transform || {});
      if (nextEditable) {
        linked.lastFocusAt = Math.max(Number(linked.lastFocusAt || 0), eventAt);
        linked.uploadFocused = true;
        clearEditHideTimer(linked);
        linked.editState = {
          editable: true,
          optionId: nextOptionId,
          transform: nextTransform,
        };
        syncPreviewButton(linked);
        syncMainEditBar(linked);
        return;
      }

      if (linked.uploadFocused) {
        // In embedded mode we can receive transient editable=false during React re-renders.
        // Keep bar visible while upload is still focused; only hide on explicit upload-clear.
        clearEditHideTimer(linked);
        linked.editState = {
          editable: true,
          optionId: linked.editState?.optionId || nextOptionId,
          transform: nextTransform,
        };
        syncMainEditBar(linked);
        return;
      }

      if (eventAt < Number(linked.lastFocusAt || 0)) {
        return;
      }
      clearEditHideTimer(linked);
      linked.editHideTimer = setTimeout(() => {
        if (!linked) return;
        if (eventAt < Number(linked.lastFocusAt || 0)) return;
        linked.editHideTimer = null;
        linked.uploadFocused = false;
        linked.editState = {
          editable: false,
          optionId: nextOptionId,
          transform: nextTransform,
        };
        syncMainEditBar(linked);
      }, 260);
    }
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      mountAll();
      ensureMountObserver();
    }, { once: true });
  } else {
    mountAll();
    ensureMountObserver();
  }

  document.addEventListener("shopify:section:load", scheduleMountAll);
  document.addEventListener("shopify:section:reorder", scheduleMountAll);
  document.addEventListener("shopify:block:select", scheduleMountAll);
})();
