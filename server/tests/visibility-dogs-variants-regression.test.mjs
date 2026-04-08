import assert from "assert";
import { mapSelectionsToHolders } from "../services/visibility-engine.js";

function makeDogsLikeMultiStateCheckbox() {
  return {
    id: 768,
    type: "Checkbox",
    optionValue: 2,
    functions: [{ type: "image", image_id: "18" }],
    values: [
      { id: 0, image_id: "601", sort_id: 1, value: "State 1" },
      { id: 1, image_id: "602", sort_id: 2, value: "State 2" },
      { id: 2, image_id: "603", sort_id: 3, value: "State 3" },
      { id: 3, image_id: "604", sort_id: 4, value: "State 4" },
    ],
  };
}

function run() {
  const option = makeDogsLikeMultiStateCheckbox();
  const visibleOptions = [option];

  const sel1 = mapSelectionsToHolders(visibleOptions, { "768": "1" }, {}, {});
  assert.strictEqual(
    sel1.holderSelections["18"],
    "602",
    "Multi-state checkbox must map using selected value.image_id"
  );

  const sel2 = mapSelectionsToHolders(visibleOptions, { "768": "2" }, {}, {});
  assert.strictEqual(
    sel2.holderSelections["18"],
    "603",
    "Multi-state checkbox must keep per-value mapping for image holder"
  );

  console.log("✅ visibility-dogs-variants-regression.test passed");
}

try {
  run();
} catch (error) {
  console.error(error);
  process.exit(1);
}

