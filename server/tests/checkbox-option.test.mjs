import assert from "node:assert/strict";
import { loadProduct } from "../services/customily-importer.js";
import { computeVisibility, mapSelectionsToHolders } from "../services/visibility-engine.js";

const PRODUCT_ID =
  "mother-and-daughters-best-friends-forever-from-the-heart-personalized-acrylic-pl-43211607965852";

function run() {
  const product = loadProduct(PRODUCT_ID);
  if (!product) {
    console.log("checkbox-option.test: SKIP (product fixture not found in local data)");
    return;
  }

  const initial = computeVisibility(product.options || [], {}, {});
  assert.ok(
    (initial.visibleOptions || []).some((o) => String(o.id) === "171"),
    "Checkbox option 171 should be visible in default workflow"
  );

  const withChecked = computeVisibility(
    product.options || [],
    { ...initial.selections, "171": "1" },
    { userSelectedOptionIds: ["171"] }
  );

  assert.equal(
    withChecked.selections["171"],
    "1",
    "Checkbox selection must be preserved by visibility engine"
  );

  const mapped = mapSelectionsToHolders(withChecked.visibleOptions, withChecked.selections, {}, {});
  assert.equal(
    mapped.holderSelections["217"],
    "2",
    "Checked checkbox must map to holder DIP key from optionValue"
  );

  console.log("checkbox-option.test: OK");
}

try {
  run();
} catch (error) {
  console.error(error);
  process.exit(1);
}
