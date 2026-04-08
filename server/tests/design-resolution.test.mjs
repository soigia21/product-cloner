import assert from "node:assert/strict";
import { getWorkflowTrace } from "../services/preview-renderer.js";
import { loadProduct } from "../services/customily-importer.js";

const PRODUCT_ID =
  "mother-daughter-best-friends-forever-floral-style-personalized-acrylic-plaque-mo-44630090350748";

async function run() {
  if (!loadProduct(PRODUCT_ID)) {
    console.log("design-resolution.test: SKIP (product fixture not found in local data)");
    return;
  }

  const traceDefault = await getWorkflowTrace(PRODUCT_ID, {}, {}, {});
  assert.equal(
    traceDefault.designUUID,
    "e870ec29-9d7c-4b39-b0b8-9479678181bc",
    "Default design UUID should stay on the product default template"
  );
  assert.equal(
    traceDefault.canvas.imagePath,
    null,
    "Default template uses holder-based background (no direct preview.imagePath)"
  );

  const traceWoman = await getWorkflowTrace(PRODUCT_ID, { "1188": "1" }, {}, {});
  assert.equal(
    traceWoman.designUUID,
    "e870ec29-9d7c-4b39-b0b8-9479678181bc",
    "Non-product switch option must not change design UUID to unrelated template"
  );

  console.log("design-resolution.test: OK");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
