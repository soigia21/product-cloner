(function productClonerThemeBlock() {
  "use strict";

  const EMBED_EVENT = "product-cloner:embedded-resize";
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

  function bindIframeResize(iframe, expectedOrigin) {
    if (!iframe?.contentWindow) return;
    iframeByWindow.set(iframe.contentWindow, { iframe, expectedOrigin });
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

    bindIframeResize(iframe, embedUrl.origin);

    iframe.addEventListener("load", () => {
      bindIframeResize(iframe, embedUrl.origin);
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
    if (!payload || payload.type !== EMBED_EVENT) return;

    const linked = iframeByWindow.get(event.source);
    if (!linked?.iframe) return;
    if (linked.expectedOrigin && event.origin !== linked.expectedOrigin) return;

    const nextHeight = clamp(Number(payload.height) || DEFAULT_HEIGHT, MIN_HEIGHT, MAX_HEIGHT);
    linked.iframe.style.height = `${nextHeight}px`;
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountAll, { once: true });
  } else {
    mountAll();
  }
})();
