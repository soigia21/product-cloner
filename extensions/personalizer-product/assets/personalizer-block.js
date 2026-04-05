(function productClonerThemeBlock() {
  "use strict";

  const EMBED_EVENT = "product-cloner:embedded-resize";
  const PREVIEW_EVENT = "product-cloner:preview-updated";
  const MIN_HEIGHT = 640;
  const MAX_HEIGHT = 2200;
  const DEFAULT_HEIGHT = 1180;
  const iframeByWindow = new Map();

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

  function findFeaturedImage(root) {
    const selectors = [
      ".product__media-item.is-active img",
      ".product__media-item[aria-hidden='false'] img",
      "media-gallery .product__media img",
      "[data-product-media-container] img",
      "[data-product-media] img",
      ".featured-media img",
      ".product-single__media img",
      ".product-gallery img",
      "main img",
    ];
    const rootSection = root?.closest(".shopify-section, section");
    const candidates = [];
    for (const selector of selectors) {
      const list = document.querySelectorAll(selector);
      for (const img of list) {
        if (!(img instanceof HTMLImageElement)) continue;
        if (!isVisible(img)) continue;
        const width = Number(img.clientWidth || 0);
        const height = Number(img.clientHeight || 0);
        if (width < 80 || height < 80) continue;
        const inSameSection = rootSection && img.closest(".shopify-section, section") === rootSection;
        const score =
          (matchesActiveMedia(img) ? 30 : 0) +
          (inSameSection ? 20 : 0) +
          (selector.includes("is-active") ? 10 : 0) +
          Math.min(width, 1200) / 100;
        candidates.push({ img, score });
      }
      if (candidates.length > 0) break;
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0].img;
  }

  function applyPreviewAsMainImage(root, previewUrl) {
    const img = findFeaturedImage(root);
    if (!img) return false;

    if (!img.dataset.pzOriginalSrc) {
      img.dataset.pzOriginalSrc = img.currentSrc || img.src || "";
    }
    img.src = previewUrl;
    img.removeAttribute("srcset");
    img.removeAttribute("sizes");
    img.setAttribute("data-pz-preview-applied", "1");

    const pic = img.closest("picture");
    if (pic) {
      const sources = pic.querySelectorAll("source");
      for (const source of sources) {
        source.setAttribute("srcset", previewUrl);
      }
    }

    window.dispatchEvent(
      new CustomEvent("product-cloner:main-image-updated", {
        detail: {
          previewUrl,
          element: img,
        },
      })
    );

    return true;
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
    iframeByWindow.set(iframe.contentWindow, {
      iframe,
      expectedOrigin,
      root,
      lastPreviewUrl: "",
    });
  }

  function mountRoot(root) {
    if (!root || root.dataset.pzMounted === "1") return;
    root.dataset.pzMounted = "1";

    const embedUrl = buildEmbedUrl(root);
    if (!embedUrl) {
      setStatus(root, "Missing app_base_url for embedded personalizer.", "pz-status--error");
      return;
    }

    setStatus(root, "Loading personalized customizer...", "pz-status--loading");

    const shell = document.createElement("div");
    shell.className = "pz-embed-shell";

    const iframe = document.createElement("iframe");
    iframe.className = "pz-embed-frame";
    iframe.loading = "lazy";
    iframe.referrerPolicy = "strict-origin-when-cross-origin";
    iframe.allow = "clipboard-read; clipboard-write";
    iframe.src = embedUrl.toString();
    iframe.style.height = `${DEFAULT_HEIGHT}px`;
    shell.appendChild(iframe);
    root.appendChild(shell);

    bindIframeResize(iframe, embedUrl.origin, root);

    iframe.addEventListener("load", () => {
      bindIframeResize(iframe, embedUrl.origin, root);
      setStatus(root, "Personalized UI loaded.", "pz-status--ok");
      setDebug(root, {
        src: iframe.src,
        templateId: root.dataset.templateId || "",
        productId: root.dataset.productId || "",
        handle: root.dataset.productHandle || "",
      });
    });
  }

  function mountAll() {
    const roots = document.querySelectorAll("[data-personalizer-block]");
    for (const root of roots) {
      mountRoot(root);
    }
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
      if (previewUrl === linked.lastPreviewUrl) return;
      linked.lastPreviewUrl = previewUrl;
      applyPreviewAsMainImage(linked.root, previewUrl);
    }
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountAll, { once: true });
  } else {
    mountAll();
  }
})();
