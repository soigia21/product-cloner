import assert from "node:assert/strict";
import { computeVisibility } from "../services/visibility-engine.js";

function makeOption({
  id,
  sort_id,
  type = "Dropdown",
  auto_default_mode = "none",
  required = true,
  conditions = [],
  values = [],
}) {
  return {
    id,
    sort_id,
    type,
    auto_default_mode,
    required,
    conditions,
    values,
    functions: [],
  };
}

function run() {
  const options = [
    makeOption({
      id: 2,
      sort_id: 1,
      type: "Dropdown",
      auto_default_mode: "selected",
      conditions: [
        { watch_option: 612, desired_value: [1], action: "show", combination_operator: "or" },
      ],
      values: [
        { id: 44, value: "German Shepherd", selected: true },
        { id: 0, value: "Afghanistan Hound", selected: false },
      ],
    }),
    makeOption({
      id: 612,
      sort_id: 2,
      type: "Dropdown",
      auto_default_mode: "selected",
      required: false,
      conditions: [
        { watch_option: 182, desired_value: [1], action: "show", combination_operator: "or" },
      ],
      values: [
        { id: 1, value: "Dog", selected: true },
        { id: 2, value: "Cat", selected: false },
      ],
    }),
    makeOption({
      id: 182,
      sort_id: 3,
      type: "Swatch",
      auto_default_mode: "first",
      conditions: [],
      values: [{ id: 1, value: "1 Pet", selected: true }],
    }),
    makeOption({
      id: 28,
      sort_id: 4,
      type: "Swatch",
      auto_default_mode: "selected",
      conditions: [
        { watch_option: 2, desired_value: [44], action: "show", combination_operator: "or" },
      ],
      values: [
        { id: 0, value: "German Shepherd 1", selected: true, image_id: "266" },
        { id: 1, value: "German Shepherd 2", selected: false, image_id: "267" },
      ],
    }),
  ];

  const initialSelections = {
    "2": "44",
    "28": "1",
  };
  const result = computeVisibility(options, initialSelections, {
    userSelectedOptionIds: ["2", "28"],
  });

  assert.equal(
    String(result.selections["28"]),
    "1",
    "User-selected hidden value must survive temporary hidden passes"
  );

  console.log("✅ visibility-preserve-user-hidden-selection.test passed");
}

try {
  run();
} catch (error) {
  console.error(error);
  process.exit(1);
}
