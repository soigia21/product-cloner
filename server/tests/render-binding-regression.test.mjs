import assert from "assert";
import { mapSelectionsToHolders } from "../services/visibility-engine.js";

function makeBinaryCheckboxOption() {
  return {
    id: 55,
    type: "Checkbox",
    optionValue: 2,
    functions: [{ type: "image", image_id: "200" }],
    values: [
      { id: 0, image_id: "1", sort_id: 1, value: "Off" },
      { id: 1, image_id: "9", sort_id: 2, value: "On" },
    ],
  };
}

function makeNumericZeroSelectionOption() {
  return {
    id: 10,
    type: "Swatch",
    functions: [{ type: "image", image_id: "300" }],
    values: [
      { id: 0, image_id: "55", sort_id: 1, value: "Default" },
      { id: 1, image_id: "56", sort_id: 2, value: "Alt" },
    ],
  };
}

function run() {
  const binary = makeBinaryCheckboxOption();
  const zeroSelection = makeNumericZeroSelectionOption();
  const visibleOptions = [binary, zeroSelection];

  const unchecked = mapSelectionsToHolders(
    visibleOptions,
    { "55": "0", "10": 0 },
    {},
    {}
  );
  assert.strictEqual(
    unchecked.holderSelections["200"],
    "1",
    "Unchecked binary checkbox should map from selected value"
  );
  assert.strictEqual(
    unchecked.holderSelections["300"],
    "55",
    "Numeric 0 selection must not be dropped during holder mapping"
  );

  const checked = mapSelectionsToHolders(visibleOptions, { "55": "1", "10": "0" }, {}, {});
  assert.strictEqual(
    checked.holderSelections["200"],
    "2",
    "Checked binary checkbox should map from optionValue override"
  );

  console.log("✅ render-binding-regression.test passed");
}

try {
  run();
} catch (error) {
  console.error(error);
  process.exit(1);
}

