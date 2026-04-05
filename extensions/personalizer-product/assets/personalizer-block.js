(function productClonerThemeBlock() {
  "use strict";

  function byId(id) {
    return typeof id === "string" ? document.getElementById(id) : null;
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

  function setDebug(root, payload) {
    if (String(root.dataset.showDebug || "").toLowerCase() !== "true") return;
    let debugNode = root.querySelector(".pz-debug");
    if (!debugNode) {
      debugNode = document.createElement("pre");
      debugNode.className = "pz-debug";
      root.appendChild(debugNode);
    }
    debugNode.textContent = JSON.stringify(payload, null, 2);
  }

  function trimSlash(value) {
    return String(value || "").replace(/\/+$/, "");
  }

  function getTemplateEndpoint(root) {
    const proxyPrefix = trimSlash(root.dataset.proxyPrefix);
    if (proxyPrefix) return `${proxyPrefix}/template`;

    const appBaseUrl = trimSlash(root.dataset.appBaseUrl);
    if (appBaseUrl) return `${appBaseUrl}/api/storefront/template`;
    return "";
  }

  function buildQuery(root) {
    const params = new URLSearchParams();
    const templateId = String(root.dataset.templateId || "").trim();
    const productId = String(root.dataset.productId || "").trim();
    const productHandle = String(root.dataset.productHandle || "").trim();

    if (templateId) params.set("template_id", templateId);
    if (productId) params.set("product_id", productId);
    if (productHandle) params.set("handle", productHandle);
    return params;
  }

  async function mountRoot(root) {
    if (!root || root.dataset.pzMounted === "1") return;
    root.dataset.pzMounted = "1";

    const endpoint = getTemplateEndpoint(root);
    if (!endpoint) {
      setStatus(
        root,
        "Missing endpoint. Set App proxy prefix or fallback app URL in block settings.",
        "pz-status--error"
      );
      return;
    }

    const query = buildQuery(root);
    if (!query.get("template_id") && !query.get("product_id") && !query.get("handle")) {
      setStatus(root, "Missing template_id/product_id/handle for personalization.", "pz-status--error");
      return;
    }

    const url = `${endpoint}?${query.toString()}`;
    setStatus(root, "Loading personalized template...", "pz-status--loading");

    try {
      const response = await fetch(url, { credentials: "include" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = await response.json();
      if (!payload?.success || !payload?.template) {
        throw new Error(payload?.error || "Template payload is invalid");
      }

      const template = payload.template;
      const optionsCount = Array.isArray(template.options) ? template.options.length : 0;
      const variantsCount = Object.keys(template.variantDesigns || {}).length;
      setStatus(
        root,
        `Personalized template loaded (${optionsCount} options, ${variantsCount} variant designs).`,
        "pz-status--ok"
      );

      root.__personalizerTemplate = template;
      root.dataset.pzTemplateId = String(payload.templateId || template.id || "");
      setDebug(root, {
        templateId: payload.templateId || template.id || "",
        source: {
          handle: template.handle || "",
          productId: template.shopifyProductId || root.dataset.productId || "",
        },
        optionsCount,
        variantsCount,
      });

      window.__PRODUCT_CLONER_TEMPLATES = window.__PRODUCT_CLONER_TEMPLATES || {};
      if (root.dataset.pzTemplateId) {
        window.__PRODUCT_CLONER_TEMPLATES[root.dataset.pzTemplateId] = template;
      }

      root.dispatchEvent(
        new CustomEvent("product-cloner:template-loaded", {
          bubbles: true,
          detail: {
            templateId: root.dataset.pzTemplateId,
            template,
            endpoint: url,
          },
        })
      );
    } catch (error) {
      setStatus(root, `Cannot load personalized template: ${error.message}`, "pz-status--error");
      setDebug(root, { error: error.message, endpoint: url });
    }
  }

  function mountAll() {
    const roots = document.querySelectorAll("[data-personalizer-block]");
    for (const root of roots) {
      mountRoot(root);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountAll, { once: true });
  } else {
    mountAll();
  }

  const appSectionMain = byId("MainContent");
  if (appSectionMain) {
    const observer = new MutationObserver(() => mountAll());
    observer.observe(appSectionMain, { childList: true, subtree: true });
  }
})();
