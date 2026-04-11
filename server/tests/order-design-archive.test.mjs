import assert from "node:assert/strict";
import crypto from "crypto";
import {
  verifyShopifyWebhookSignature,
  extractPersonalizedLineItems,
} from "../services/order-design-archive.js";

async function run() {
  const secret = "unit-test-secret";
  const payload = JSON.stringify({ id: 123, line_items: [] });
  const validHmac = crypto.createHmac("sha256", secret).update(payload).digest("base64");

  assert.equal(
    verifyShopifyWebhookSignature(Buffer.from(payload), validHmac, secret),
    true,
    "Webhook signature should be valid when body + secret match"
  );
  assert.equal(
    verifyShopifyWebhookSignature(Buffer.from(payload), "invalid", secret),
    false,
    "Webhook signature should fail with invalid digest"
  );

  const orderPayload = {
    line_items: [
      {
        id: 11,
        title: "Personalized Plaque",
        quantity: 1,
        properties: [
          { name: "_pz_template_id", value: "tpl-001" },
          { name: "_pz_preview_url", value: "/api/uploads/tpl-001/preview.jpg" },
          { name: "Preview", value: "preview.jpg" },
        ],
      },
      {
        id: 12,
        title: "Normal Product",
        quantity: 1,
        properties: [{ name: "Gift Box", value: "Yes" }],
      },
      {
        id: 13,
        title: "Preview-only",
        quantity: 2,
        properties: [{ name: "Preview", value: "https://cdn.example.com/pz.jpg" }],
      },
    ],
  };

  const extracted = extractPersonalizedLineItems(orderPayload, "https://product-cloner.groupaliens.com");
  assert.equal(extracted.length, 2, "Should only keep personalized line items");
  assert.equal(extracted[0].templateId, "tpl-001");
  assert.equal(
    extracted[0].previewUrl,
    "https://product-cloner.groupaliens.com/api/uploads/tpl-001/preview.jpg",
    "Relative preview URL should be resolved with request origin"
  );
  assert.equal(extracted[1].templateId, "");
  assert.equal(extracted[1].previewUrl, "https://cdn.example.com/pz.jpg");

  console.log("order-design-archive.test: OK");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

