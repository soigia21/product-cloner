import assert from "node:assert/strict";
import { mapSelectionsToHolders } from "../services/visibility-engine.js";

function makeImageBoundSwatchOption() {
  return {
    id: 28,
    type: "Swatch",
    functions: [{ type: "image", image_id: "7" }],
    values: [
      { id: 0, sort_id: 1, image_id: "266", value: "German Shepherd 1" },
      { id: 1, sort_id: 2, image_id: "267", value: "German Shepherd 2" },
    ],
  };
}

function run() {
  const option = makeImageBoundSwatchOption();
  const mapped = mapSelectionsToHolders([option], { "28": "0" }, {}, {});

  assert.strictEqual(
    mapped.holderSelections["7"],
    "266",
    "Selected value must map to its explicit image_id"
  );
  assert.deepStrictEqual(
    mapped.holderSelectionCandidates["7"],
    ["266"],
    "Explicit image_id must not add numeric fallback candidates"
  );

  console.log("✅ image-selection-candidate-regression.test passed");
}

try {
  run();
} catch (error) {
  console.error(error);
  process.exit(1);
}
