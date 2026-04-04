const DEFAULT_TOKEN_TTL_SEC = 86399;
const REFRESH_SKEW_MS = 60 * 1000;

const tokenCache = new Map();

function normalizeStoreDomain(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";

  if (/^https?:\/\//i.test(value)) {
    try {
      const u = new URL(value);
      return u.host;
    } catch {
      return "";
    }
  }

  return value;
}

function readConfig(env = process.env) {
  const storeDomain = normalizeStoreDomain(env.SHOPIFY_STORE);
  const staticToken = String(env.SHOPIFY_ACCESS_TOKEN || "").trim();
  const clientId = String(env.SHOPIFY_CLIENT_ID || "").trim();
  const clientSecret = String(env.SHOPIFY_CLIENT_SECRET || "").trim();

  const hasStaticToken =
    Boolean(staticToken) &&
    staticToken !== "shpat_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
  const hasClientCredentials = Boolean(clientId && clientSecret);

  const mode = hasStaticToken
    ? "static_token"
    : hasClientCredentials
      ? "client_credentials"
      : "none";

  return {
    storeDomain,
    staticToken: hasStaticToken ? staticToken : "",
    clientId,
    clientSecret,
    mode,
    configured: Boolean(storeDomain && (hasStaticToken || hasClientCredentials)),
  };
}

async function requestToken(storeDomain, clientId, clientSecret) {
  const endpoint = `https://${storeDomain}/admin/oauth/access_token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.access_token) {
    const message = payload?.error_description || payload?.error || JSON.stringify(payload || {});
    throw new Error(`Không thể lấy Shopify access token: ${message || `HTTP ${response.status}`}`);
  }

  const expiresIn = Number(payload.expires_in);
  const ttlSec = Number.isFinite(expiresIn) && expiresIn > 0
    ? expiresIn
    : DEFAULT_TOKEN_TTL_SEC;

  return {
    accessToken: String(payload.access_token),
    expiresAt: Date.now() + ttlSec * 1000,
    scope: payload.scope || "",
  };
}

/**
 * Public helper for status/config checks.
 */
export function getShopifyConfig(env = process.env) {
  return readConfig(env);
}

/**
 * Resolve Shopify Admin token.
 * - static token mode: returns SHOPIFY_ACCESS_TOKEN
 * - client credentials mode: fetch + cache + auto refresh
 */
export async function getToken(env = process.env) {
  const cfg = readConfig(env);
  if (!cfg.configured) {
    throw new Error("Chưa cấu hình Shopify store");
  }

  if (cfg.mode === "static_token") {
    return {
      accessToken: cfg.staticToken,
      source: "static_token",
      expiresAt: null,
      scope: "",
      storeDomain: cfg.storeDomain,
    };
  }

  const cacheKey = `${cfg.storeDomain}|${cfg.clientId}`;
  const cached = tokenCache.get(cacheKey);
  if (
    cached?.accessToken &&
    Number.isFinite(cached?.expiresAt) &&
    cached.expiresAt - REFRESH_SKEW_MS > Date.now()
  ) {
    return {
      accessToken: cached.accessToken,
      source: "client_credentials_cache",
      expiresAt: cached.expiresAt,
      scope: cached.scope || "",
      storeDomain: cfg.storeDomain,
    };
  }

  const next = await requestToken(cfg.storeDomain, cfg.clientId, cfg.clientSecret);
  tokenCache.set(cacheKey, next);
  return {
    accessToken: next.accessToken,
    source: "client_credentials",
    expiresAt: next.expiresAt,
    scope: next.scope || "",
    storeDomain: cfg.storeDomain,
  };
}

