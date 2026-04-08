import assert from "node:assert/strict";
import { computeVisibility } from "../services/visibility-engine.js";

function buildOptions() {
  return [
    {
      id: 182,
      sort_id: 1,
      label: "Number Of Pets",
      type: "Swatch",
      required: true,
      values: [
        { id: 1, value: "1 Pet" },
        { id: 2, value: "2 Pets" },
      ],
      conditions: [],
    },
    {
      id: 889,
      sort_id: 2,
      label: "Gender",
      type: "Dropdown",
      required: true,
      values: [
        { id: 0, value: "Male" },
        { id: 2, value: "Female" },
      ],
      conditions: [
        {
          id: 1,
          action: "show",
          watch_option: 888,
          desired_value: [0],
          combination_operator: "or",
        },
      ],
    },
  ];
}

function run() {
  const options = buildOptions();
  const result = computeVisibility(options, {}, { userSelectedOptionIds: [] });
  const visible = new Set((result.visibleOptions || []).map((o) => String(o.id)));

  assert.equal(visible.has("182"), true, "Controller option should be visible");
  assert.equal(
    visible.has("889"),
    true,
    "Option depending on missing watcher should still be visible when watcher has a stable implicit default"
  );

  console.log("visibility-missing-watcher-default.test: OK");
}

try {
  run();
} catch (error) {
  console.error(error);
  process.exit(1);
}
