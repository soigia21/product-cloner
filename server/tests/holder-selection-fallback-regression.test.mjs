import assert from "node:assert/strict";
import { getWorkflowTrace } from "../services/preview-renderer.js";
import { loadProduct } from "../services/customily-importer.js";

const PRODUCT_ID =
  "a-girl-woman-boy-man-dogs-a-bond-that-cant-be-broken-personalized-custom-shaped--43223949312156";

async function run() {
  if (!loadProduct(PRODUCT_ID)) {
    console.log("holder-selection-fallback-regression.test: SKIP (product fixture not found in local data)");
    return;
  }

  const trace = await getWorkflowTrace(PRODUCT_ID, {}, {}, {});

  const germanShepherdHolder = (trace.imagePlan || []).find(
    (item) => String(item.holderId) === "7"
  );
  assert.ok(germanShepherdHolder, "Expected holder 7 to exist in trace image plan");
  assert.ok(
    germanShepherdHolder.selectedPath,
    "Selected dog breed variant should resolve to a concrete render path"
  );

  const singlePetHolder = (trace.imagePlan || []).find(
    (item) => String(item.holderId) === "115"
  );
  assert.ok(singlePetHolder, "Expected holder 115 to exist in trace image plan");
  assert.ok(
    singlePetHolder.selectedPath,
    "Single-pet placeholder variant should resolve to a concrete render path"
  );

  console.log("holder-selection-fallback-regression.test: OK");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
