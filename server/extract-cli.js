#!/usr/bin/env node

/**
 * CLI: Extract Customily assets from a Shopify product URL
 * 
 * Usage:
 *   node server/extract-cli.js <product-url> [output-dir]
 * 
 * Example:
 *   node server/extract-cli.js https://macorner.co/products/mother-and-daughter-personalized-acrylic-plaque-birthday-gift-mothers-day-gift-for-mom-daughters-fam100201hptl ./extracted/macorner-mother-daughter
 */

import { extractCustomilyProduct } from "./services/customily-extractor.js";
import path from "path";

const args = process.argv.slice(2);

if (args.length < 1) {
  console.log(`
╔══════════════════════════════════════════════════╗
║       🔧 Customily Asset Extractor CLI           ║
╚══════════════════════════════════════════════════╝

Usage:
  node server/extract-cli.js <product-url> [output-dir]

Arguments:
  product-url   URL sản phẩm Shopify có Customily
  output-dir    Thư mục lưu assets (default: ./extracted/<handle>)

Example:
  node server/extract-cli.js https://macorner.co/products/mother-and-daughter-personalized-acrylic-plaque-birthday-gift-mothers-day-gift-for-mom-daughters-fam100201hptl
`);
  process.exit(1);
}

const productUrl = args[0];
const handleMatch = productUrl.match(/\/products\/([^?#]+)/);
const handle = handleMatch ? handleMatch[1].substring(0, 50) : "product";
const outputDir = args[1] || path.join(process.cwd(), "extracted", handle);

console.log("═".repeat(50));

extractCustomilyProduct(productUrl, outputDir)
  .then((summary) => {
    console.log("\n" + "═".repeat(50));
    console.log("🎉 Done! Files saved to:", outputDir);
    console.log("\nKey files:");
    console.log("  📋 app_config.json    - Config cho app (layers, positions, options)");
    console.log("  🖼️  assets/layers/     - Layer images (PNG)");
    console.log("  🎨 assets/swatches/   - Swatch thumbnails");
    console.log("  🔤 assets/fonts/      - Custom fonts");
    console.log("═".repeat(50));
  })
  .catch((err) => {
    console.error("\n❌ Error:", err.message);
    process.exit(1);
  });
