(function productClonerThemeBlock() {
  "use strict";

  const EMBED_EVENT = "product-cloner:embedded-resize";
  const PREVIEW_EVENT = "product-cloner:preview-updated";
  const INTERACTION_EVENT = "product-cloner:user-interacted";
  const MIN_HEIGHT = 0;
  const MAX_HEIGHT = 24000;
  const DEFAULT_HEIGHT = 220;
  const PREVIEW_RETRY_DELAY_MS = 240;
  const PREVIEW_RETRY_MAX_ATTEMPTS = 28;
  const MEDIA_MUTATION_DEBOUNCE_MS = 120;
  const MOUNT_OBSERVER_DEBOUNCE_MS = 60;
  const iframeByWindow = new Map();
  let mountObserver = null;
  let mountDebounceTimer = null;
  let globalStyleMounted = false;

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  function trimSlash(value) {
    return String(value || "").replace(/\/+$/, "");
  }

  function parseBoolean(value) {
    return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
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

  function setImageSource(img, previewUrl) {
    if (!(img instanceof HTMLImageElement)) return;
    img.src = previewUrl;
    img.setAttribute("data-src", previewUrl);
    img.removeAttribute("srcset");
    img.removeAttribute("sizes");
    img.setAttribute("data-pz-preview-applied", "1");

    const pic = img.closest("picture");
    if (pic) {
      const sources = pic.querySelectorAll("source");
      for (const source of sources) {
        source.setAttribute("srcset", previewUrl);
        source.setAttribute("data-srcset", previewUrl);
      }
    }
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

  function applyPreviewAsMainImage(root, previewUrl) {
    const targets = collectFeaturedImages(root);
    if (!targets || targets.length === 0) return false;

    let appliedCount = 0;
    for (const img of targets) {
      if (!img.dataset.pzOriginalSrc) {
        img.dataset.pzOriginalSrc = img.currentSrc || img.src || "";
      }
      setImageSource(img, previewUrl);
      appliedCount += 1;
    }

    window.dispatchEvent(
      new CustomEvent("product-cloner:main-image-updated", {
        detail: {
          previewUrl,
          count: appliedCount,
          element: targets[0] || null,
        },
      })
    );

    return appliedCount > 0;
  }

  function clearPreviewRetry(linked) {
    if (!linked) return;
    if (linked.retryTimer) {
      clearTimeout(linked.retryTimer);
      linked.retryTimer = null;
    }
    if (linked.observerDebounceTimer) {
      clearTimeout(linked.observerDebounceTimer);
      linked.observerDebounceTimer = null;
    }
    linked.retryAttempts = 0;
  }

  function tryApplyPendingPreview(linked) {
    if (!linked || !linked.pendingPreviewUrl) return false;
    if (linked.pendingPreviewUrl === linked.lastAppliedPreviewUrl) return true;

    const ok = applyPreviewAsMainImage(linked.root, linked.pendingPreviewUrl);
    if (ok) {
      linked.lastPreviewUrl = linked.pendingPreviewUrl;
      linked.lastAppliedPreviewUrl = linked.pendingPreviewUrl;
      clearPreviewRetry(linked);
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
    const existing = iframeByWindow.get(iframe.contentWindow) || {};
    const linked = {
      iframe,
      expectedOrigin,
      root,
      userInteracted: Boolean(existing.userInteracted),
      lastPreviewUrl: existing.lastPreviewUrl || "",
      lastAppliedPreviewUrl: existing.lastAppliedPreviewUrl || "",
      pendingPreviewUrl: existing.pendingPreviewUrl || "",
      retryTimer: existing.retryTimer || null,
      retryAttempts: existing.retryAttempts || 0,
      observer: existing.observer || null,
      observerDebounceTimer: existing.observerDebounceTimer || null,
    };
    iframeByWindow.set(iframe.contentWindow, linked);
    bindMediaObserver(linked);
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
      if (!linked.userInteracted) return;
      if (previewUrl === linked.lastAppliedPreviewUrl) return;
      tryApplyPendingPreview(linked);
      return;
    }

    if (payload.type === INTERACTION_EVENT) {
      linked.userInteracted = true;
      if (linked.pendingPreviewUrl) {
        tryApplyPendingPreview(linked);
      }
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
