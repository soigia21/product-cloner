/**
 * Image Cache — Download CDN images and cache locally
 * Per Blueprint §8.1, §12
 */

import fs from "fs";
import path from "path";
import https from "https";
import crypto from "crypto";

const CACHE_DIR = path.resolve(process.cwd(), "data", "cache");

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

function normalizeImageCandidates(urlOrPath) {
  const raw = String(urlOrPath || "");
  if (!raw) return [];

  // Absolute URL: keep as-is first.
  if (/^https?:\/\//i.test(raw)) {
    return [raw];
  }

  const normalized = raw.replace(/\/Content\//g, "/");
  const candidates = [
    `https://cdn.customily.com${normalized}`,
    `https://app.customily.com${raw}`,
  ];
  if (normalized !== raw) {
    candidates.push(`https://app.customily.com${normalized}`);
  }
  return [...new Set(candidates)];
}

/**
 * Get cached file path for a URL
 */
function getCachePath(url) {
  const hash = crypto.createHash("md5").update(url).digest("hex");
  const ext = path.extname(url).split("?")[0] || ".png";
  return path.join(CACHE_DIR, `${hash}${ext}`);
}

/**
 * Download a file from URL to destPath
 */
function downloadToFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const dir = path.dirname(destPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadToFile(res.headers.location, destPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const file = fs.createWriteStream(destPath);
      res.pipe(file);
      file.on("finish", () => { file.close(); resolve(destPath); });
      file.on("error", (err) => { fs.unlink(destPath, () => {}); reject(err); });
    }).on("error", reject);
  });
}

/**
 * Get image — download from CDN if not cached
 * @returns {string} absolute path to cached file
 */
export async function getImage(urlOrPath) {
  const candidates = normalizeImageCandidates(urlOrPath);
  if (candidates.length === 0) {
    throw new Error("Invalid image path");
  }

  let lastError = null;
  for (const url of candidates) {
    const cachePath = getCachePath(url);
    if (fs.existsSync(cachePath)) {
      return cachePath;
    }
    try {
      await downloadToFile(url, cachePath);
      return cachePath;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error(`Failed to fetch image: ${urlOrPath}`);
}

/**
 * Download font from app.customily.com (NOT cdn!)
 * Per Blueprint §9.3, §13.8
 */
export async function getFont(fontPath, destDir) {
  const fname = path.basename(fontPath);
  const destPath = path.join(destDir, fname);

  if (fs.existsSync(destPath)) return destPath;

  // Fonts must be fetched from app.customily.com
  const url = `https://app.customily.com${fontPath}`;
  await downloadToFile(url, destPath);
  return destPath;
}

/**
 * Fetch JSON from URL
 */
export function fetchJSON(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = {
      headers: { "User-Agent": "Mozilla/5.0", ...headers },
    };
    https.get(url, opts, (res) => {
      let data = "";
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchJSON(res.headers.location, headers).then(resolve).catch(reject);
      }
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
      });
      res.on("error", reject);
    }).on("error", reject);
  });
}
