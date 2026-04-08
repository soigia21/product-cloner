import assert from "node:assert/strict";
import { computeVisibility } from "../services/visibility-engine.js";

function buildOptions() {
  return [
    {
      id: 252,
      sort_id: 1,
      label: "Number Of Daughters",
      type: "Swatch",
      required: true,
      values: [
        { id: 0, value: "Mother & 1 Daughter" },
        { id: 1, value: "Mother & 2 Daughters" },
      ],
      conditions: [],
    },
    {
      id: 28,
      sort_id: 2,
      label: "Mother's Name",
      type: "Text Input",
      required: true,
      values: [],
      conditions: [
        {
          id: 1,
          action: "show",
          watch_option: 252,
          desired_value: [-1],
          combination_operator: "or",
        },
      ],
    },
  ];
}

function run() {
  const options = buildOptions();

  const initial = computeVisibility(options, {}, { userSelectedOptionIds: [] });
  const initialVisible = new Set((initial.visibleOptions || []).map((o) => String(o.id)));
  assert.equal(initialVisible.has("252"), true, "Controller option should be visible initially");
  assert.equal(initialVisible.has("28"), false, "Dependent option should be hidden before selection");

  const withSelection = computeVisibility(
    options,
    { "252": "0" },
    { userSelectedOptionIds: ["252"] }
  );
  const selectedVisible = new Set((withSelection.visibleOptions || []).map((o) => String(o.id)));
  assert.equal(
    selectedVisible.has("28"),
    true,
    "desired_value=-1 must match any selected watcher value"
  );

  console.log("visibility-wildcard-minus-one.test: OK");
}

try {
  run();
} catch (error) {
  console.error(error);
  process.exit(1);
}
