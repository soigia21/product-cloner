import assert from "node:assert/strict";
import { computeUiForceShowOptionIds, computeVisibility } from "../services/visibility-engine.js";

function buildOptions() {
  return [
    {
      id: 182,
      sort_id: 1,
      label: "Number Of Pets",
      type: "Swatch",
      required: true,
      hide_visually: false,
      values: [
        { id: 1, value: "1 Pet" },
        { id: 2, value: "2 Pets" },
      ],
      conditions: [],
    },
    {
      id: 613,
      sort_id: 2,
      label: "Choose Your Pet #1",
      type: "Dropdown",
      required: true,
      hide_visually: true,
      values: [
        { id: 0, value: "Cat", selected: false },
        { id: 1, value: "Dog", selected: true },
      ],
      conditions: [
        { id: 1, action: "show", watch_option: 182, desired_value: [2], combination_operator: "or" },
      ],
    },
    {
      id: 2,
      sort_id: 3,
      label: "Find Your Dog Breeds",
      type: "Dropdown",
      required: true,
      hide_visually: false,
      values: [
        { id: 44, value: "German Shepherd", selected: true },
        { id: 6, value: "Australian Shepherd", selected: false },
      ],
      conditions: [
        { id: 1, action: "show", watch_option: 613, desired_value: [1], combination_operator: "or" },
      ],
    },
    {
      id: 28,
      sort_id: 4,
      label: "German Shepherd",
      type: "Swatch",
      required: true,
      hide_visually: false,
      values: [{ id: 0, value: "Default", selected: true }],
      conditions: [
        { id: 1, action: "show", watch_option: 2, desired_value: [44], combination_operator: "or" },
      ],
    },
    {
      id: 884,
      sort_id: 5,
      label: "Hidden Marker",
      type: "Swatch",
      required: false,
      hide_visually: true,
      values: [{ id: 0, value: "Marker", selected: true }],
      conditions: [
        { id: 1, action: "show", watch_option: 182, desired_value: [2], combination_operator: "or" },
      ],
    },
  ];
}

function run() {
  const options = buildOptions();
  const baseSelections = { "182": "2" };
  const config = { userSelectedOptionIds: ["182"] };

  const base = computeVisibility(options, baseSelections, config);
  const visibleIds = new Set((base.visibleOptions || []).map((o) => String(o.id)));
  assert.equal(visibleIds.has("613"), true, "Hidden pet selector should be in logical visible set");
  assert.equal(visibleIds.has("2"), true, "Breed selector should be visible when pet=#Dog branch active");

  const forced = new Set(
    computeUiForceShowOptionIds(options, baseSelections, config).map((id) => String(id))
  );
  assert.equal(
    forced.has("613"),
    true,
    "Impactful hidden selector should be auto-unhidden"
  );
  assert.equal(
    forced.has("884"),
    false,
    "Non-impactful hidden marker should remain hidden"
  );

  console.log("visibility-impact-unhide.test: OK");
}

try {
  run();
} catch (error) {
  console.error(error);
  process.exit(1);
}
