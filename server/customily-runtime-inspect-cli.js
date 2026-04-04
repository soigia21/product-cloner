#!/usr/bin/env node
import fs from "fs";
import path from "path";
import process from "process";
import puppeteer from "puppeteer-core";

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function clickPreviewButton(page) {
  return page.evaluate(() => {
    const selectors = [
      "#btn-preview",
      "#btn-preview-desktop",
      "a.customily-preview-button",
      "button.customily-preview-button",
      ".customily-preview-button",
    ];

    function isVisible(el) {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity || 1) === 0) {
        return false;
      }
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }

    for (const s of selectors) {
      const el = document.querySelector(s);
      if (!el || !isVisible(el)) continue;
      el.click();
      return { clicked: true, selector: s, text: (el.textContent || "").trim() };
    }

    const allClickable = Array.from(document.querySelectorAll("a,button,input[type='button'],input[type='submit']"));
    for (const el of allClickable) {
      const text = ((el.textContent || el.value || "").trim() || "").toLowerCase();
      if (!text) continue;
      if (!text.includes("preview") && !text.includes("personaliz")) continue;
      if (!isVisible(el)) continue;
      el.click();
      return { clicked: true, selector: "text-match", text };
    }

    return { clicked: false };
  });
}

async function collectSnapshot(page) {
  return page.evaluate(() => {
    const engraver = window.engraver || null;
    const currentProduct = engraver?.currentProduct || null;

    const canvas = engraver?.canvas || null;
    let canvasWidth = null;
    let canvasHeight = null;
    try {
      canvasWidth = typeof canvas?.getWidth === "function" ? canvas.getWidth() : canvas?.width ?? null;
      canvasHeight = typeof canvas?.getHeight === "function" ? canvas.getHeight() : canvas?.height ?? null;
    } catch {}

    const rawTextObjects = engraver?.textObjects;
    let textObjectsCount = 0;
    if (Array.isArray(rawTextObjects)) textObjectsCount = rawTextObjects.length;
    else if (rawTextObjects && typeof rawTextObjects === "object") textObjectsCount = Object.keys(rawTextObjects).length;

    const previewButtons = Array.from(document.querySelectorAll("#btn-preview,#btn-preview-desktop,.customily-preview-button"))
      .map((el) => {
        const r = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return {
          id: el.id || null,
          cls: el.className || null,
          text: (el.textContent || "").trim() || null,
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
          width: r.width,
          height: r.height,
        };
      });

    return {
      url: window.location.href,
      hasCustomilyShopify: Boolean(window.customilyShopify),
      hasEngraver: Boolean(engraver),
      hasCurrentProduct: Boolean(currentProduct),
      textObjectsCount,
      canvas: { width: canvasWidth, height: canvasHeight },
      previewButtons,
      ready: Boolean(engraver && currentProduct && textObjectsCount > 0),
    };
  });
}

async function collectFullDump(page) {
  return page.evaluate(() => {
    const engraver = window.engraver || null;
    const currentProduct = engraver?.currentProduct || null;
    const canvas = engraver?.canvas || null;

    function numberOrNull(v) {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }

    function normalizeTextObject(obj, index, key = null) {
      if (!obj || typeof obj !== "object") return null;
      const runtimeFontSize = typeof obj.getFontSize === "function"
        ? numberOrNull(obj.getFontSize())
        : numberOrNull(obj?._cacheContext?.trueFontSize);
      return {
        index,
        key,
        id: obj.id ?? obj.textId ?? obj.holderId ?? null,
        text: obj.text ?? obj.value ?? "",
        fontSize: numberOrNull(obj.fontSize),
        runtimeFontSize,
        runtimeFontToHeightRatio:
          runtimeFontSize && numberOrNull(obj.height) ? runtimeFontSize / numberOrNull(obj.height) : null,
        scaleX: numberOrNull(obj.scaleX),
        scaleY: numberOrNull(obj.scaleY),
        width: numberOrNull(obj.width),
        height: numberOrNull(obj.height),
        left: numberOrNull(obj.left),
        top: numberOrNull(obj.top),
        angle: numberOrNull(obj.angle),
        originX: obj.originX ?? null,
        originY: obj.originY ?? null,
        textAlign: obj.textAlign ?? null,
        fontFamily: obj.fontFamily ?? null,
        visible: obj.visible !== false,
        uuid: obj.uuid ?? null,
        rawKeySample: Object.keys(obj).slice(0, 40),
      };
    }

    const textObjects = [];
    const rawTextObjects = engraver?.textObjects;
    if (Array.isArray(rawTextObjects)) {
      rawTextObjects.forEach((obj, idx) => {
        const normalized = normalizeTextObject(obj, idx);
        if (normalized) textObjects.push(normalized);
      });
    } else if (rawTextObjects && typeof rawTextObjects === "object") {
      Object.entries(rawTextObjects).forEach(([k, obj], idx) => {
        const normalized = normalizeTextObject(obj, idx, k);
        if (normalized) textObjects.push(normalized);
      });
    }

    const previewTexts = (currentProduct?.preview?.textsPreview || []).map((t) => ({
      id: t.id,
      centerX: numberOrNull(t.centerX),
      centerY: numberOrNull(t.centerY),
      width: numberOrNull(t.width),
      height: numberOrNull(t.height),
      minSizePx: numberOrNull(t.minSizePx),
      maxSizePx: numberOrNull(t.maxSizePx),
      initFontSize: numberOrNull(t.initFontSize),
      textAlign: t.textAlign || null,
      fontPath: t.fontPath || null,
      rotation: numberOrNull(t.rotation),
      zIndex: numberOrNull(t.zIndex),
    }));

    const textOptions = (currentProduct?.options || [])
      .filter((o) => String(o?.type || "").toLowerCase().replace(/\s+/g, "") === "textinput")
      .map((o) => ({
        id: o.id,
        label: o.label,
        sort_id: o.sort_id,
        placeholder: o.placeholder || null,
        help_text: o.help_text || null,
        max_length: o.max_length ?? null,
        functions: o.functions || [],
      }))
      .sort((a, b) => Number(a.sort_id || 0) - Number(b.sort_id || 0));

    let canvasWidth = null;
    let canvasHeight = null;
    try {
      canvasWidth = typeof canvas?.getWidth === "function" ? canvas.getWidth() : canvas?.width ?? null;
      canvasHeight = typeof canvas?.getHeight === "function" ? canvas.getHeight() : canvas?.height ?? null;
    } catch {}

    return {
      timestamp: new Date().toISOString(),
      location: window.location.href,
      hasCustomilyShopify: Boolean(window.customilyShopify),
      hasEngraver: Boolean(engraver),
      engraverKeys: engraver ? Object.keys(engraver).slice(0, 200) : [],
      currentProduct: {
        id: currentProduct?.id ?? null,
        name: currentProduct?.name ?? null,
        previewWidth: numberOrNull(currentProduct?.preview?.width),
        previewHeight: numberOrNull(currentProduct?.preview?.height),
        textsPreviewCount: (currentProduct?.preview?.textsPreview || []).length,
        imagePlaceholdersCount: (currentProduct?.preview?.imagePlaceHoldersPreview || []).length,
        optionsCount: (currentProduct?.options || []).length,
      },
      canvas: {
        width: numberOrNull(canvasWidth),
        height: numberOrNull(canvasHeight),
      },
      textObjects,
      previewTexts,
      textOptions,
    };
  });
}

async function main() {
  const args = parseArgs(process.argv);
  const productId = args.product || args.id || "mother-and-daughter-personalized-acrylic-plaque-birthday-gif";
  const forceProduct = args.forceProduct || args.forceProductId || null;
  const baseUrl = args.baseUrl || process.env.BASE_URL || "http://localhost:3001";
  const url = args.url || `${baseUrl.replace(/\/$/, "")}/proxy/${encodeURIComponent(productId)}`;
  const outPath = args.out || path.resolve(process.cwd(), "tmp", "customily-runtime-inspect-proxy.json");
  const headless = args.headless === "false" ? false : true;

  const defaultChromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const executablePath = args.chromePath || process.env.CHROME_PATH || defaultChromePath;

  const browser = await puppeteer.launch({
    headless,
    executablePath,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-features=site-per-process,Translate",
    ],
    defaultViewport: { width: 1600, height: 1200 },
  });

  try {
    const page = await browser.newPage();

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 180000 });
    await page.waitForFunction(() => Boolean(window.customilyShopify || window.engraver), { timeout: 180000 });

    // Initial click in case Customily requires user action to mount preview state.
    await clickPreviewButton(page);

    let last = null;
    const maxAttempts = 90;
    for (let i = 0; i < maxAttempts; i += 1) {
      last = await collectSnapshot(page);
      if (last.ready) break;

      if (i % 10 === 0) {
        await clickPreviewButton(page);
      }

      await sleep(1000);
    }

    // Fallback: force-load a known Customily product id for deterministic runtime inspection.
    if ((!last || !last.ready) && forceProduct) {
      await page.evaluate(async (pid) => {
        if (!window.engraver || typeof window.engraver.setProduct !== "function") return;
        await window.engraver.setProduct(pid, { images: [] });
      }, forceProduct);
      await sleep(1000);
      last = await collectSnapshot(page);
    }

    const dump = await collectFullDump(page);
    dump.bootstrap = {
      requestedUrl: url,
      snapshot: last,
      headless,
      executablePath,
      localTimestamp: new Date().toISOString(),
    };

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(dump, null, 2));

    console.log(`Wrote runtime inspect JSON: ${outPath}`);
    console.log(`Ready: ${Boolean(last?.ready)}, textObjects: ${dump.textObjects.length}`);
    console.log(`Canvas: ${dump.canvas.width}x${dump.canvas.height}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
