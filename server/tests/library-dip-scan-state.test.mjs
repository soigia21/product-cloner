import assert from "node:assert/strict";
import { accumulateLibraryDipScanState } from "../services/customily-importer.js";

function run() {
  const init = { hasSeenEntries: false, consecutiveEmptyBatches: 0 };

  const firstBatch = accumulateLibraryDipScanState(init, [
    null,
    { pos: 2, path: "/img-2.png" },
    null,
  ]);
  assert.equal(firstBatch.done, false, "Must not stop when batch is partially empty");
  assert.equal(firstBatch.hasSeenEntries, true, "Should mark seen entries after first hit");
  assert.equal(firstBatch.consecutiveEmptyBatches, 0, "Hit batch resets empty streak");

  const secondBatch = accumulateLibraryDipScanState(firstBatch, [null, null, null]);
  assert.equal(secondBatch.done, false, "One empty batch after hits must not stop yet");
  assert.equal(secondBatch.consecutiveEmptyBatches, 1);

  const thirdBatch = accumulateLibraryDipScanState(secondBatch, [null, null, null]);
  assert.equal(thirdBatch.done, true, "Two consecutive empty batches should stop scan");

  console.log("✅ library-dip-scan-state.test passed");
}

try {
  run();
} catch (error) {
  console.error(error);
  process.exit(1);
}
