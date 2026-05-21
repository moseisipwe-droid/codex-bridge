import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import { execSync } from "node:child_process";

const _lastErrorTimers = {};
process.on("uncaughtException", (err) => {
  const key = err.message || "unknown";
  const now = Date.now();
  if (_lastErrorTimers[key] && now - _lastErrorTimers[key] < 10000) return;
  _lastErrorTimers[key] = now;
  log.error("[proxy] uncaught exception:", err.message);
});
process.on("unhandledRejection", (err) => {
  const key = "rej:" + (err.message || "unknown");
  const now = Date.now();
  if (_lastErrorTimers[key] && now - _lastErrorTimers[key] < 10000) return;
  _lastErrorTimers[key] = now;
  log.error("[proxy] unhandled rejection:", err.message || err);
});

const PORT = process.env.PROXY_PORT || 4000;
const HOST = process.env.PROXY_HOST || "127.0.0.1";

// === Logging ===
//
// LOG_LEVEL = silent | error | warn | info (default) | debug
//   silent: nothing
//   error : only console.error wrappers
//   warn  : + warnings
//   info  : + business + access logs (default)
//   debug : + verbose internal traces
// ACCESS_LOG=0 separately suppresses just the per-request access lines.
const LOG_LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
const LOG_LEVEL = LOG_LEVELS[(process.env.LOG_LEVEL || "info").toLowerCase()] ?? LOG_LEVELS.info;
const ACCESS_LOG_ON = process.env.ACCESS_LOG !== "0" && LOG_LEVEL >= LOG_LEVELS.info;
const log = {
  error: (...a) => { if (LOG_LEVEL >= LOG_LEVELS.error) console.error(...a); },
  warn:  (...a) => { if (LOG_LEVEL >= LOG_LEVELS.warn)  console.warn(...a); },
  info:  (...a) => { if (LOG_LEVEL >= LOG_LEVELS.info)  console.log(...a); },
  debug: (...a) => { if (LOG_LEVEL >= LOG_LEVELS.debug) console.log(...a); },
  access: (...a) => { if (ACCESS_LOG_ON) console.log(...a); },
};

// === Admin log ring buffer (for dashboard SSE) ===
const ADMIN_LOG_BUF = [];
const ADMIN_LOG_MAX = 200;
const ADMIN_LOG_LISTENERS = new Set();

{
  const origLog = console.log.bind(console);
  const origErr = console.error.bind(console);
  const origWarn = console.warn.bind(console);
  function pushLog(level, msg) {
    const entry = { ts: Date.now(), level, msg: msg.slice(0, 2000) };
    ADMIN_LOG_BUF.push(entry);
    if (ADMIN_LOG_BUF.length > ADMIN_LOG_MAX) ADMIN_LOG_BUF.shift();
    for (const fn of ADMIN_LOG_LISTENERS) { try { fn(entry); } catch {} }
  }
  // Save original console.log BEFORE replacing it (for log.access to use without duplicates)
  const _rawConsoleLog = origLog;
  console.log = function(...args) {
    pushLog("info", args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" "));
    origLog(...args);
  };
  console.error = function(...args) {
    pushLog("error", args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" "));
    origErr(...args);
  };
  console.warn = function(...args) {
    pushLog("warn", args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" "));
    origWarn(...args);
  };
  // Patch log.access to bypass the "info"-level interceptor (no duplicate entries)
  log.access = (...a) => {
    const msg = a.map(a2 => typeof a2 === "object" ? JSON.stringify(a2) : String(a2)).join(" ");
    pushLog("access", msg);
    if (ACCESS_LOG_ON) _rawConsoleLog(...a);
  };
}

// === Request statistics (for admin dashboard) ===
const requestStats = {
  total: 0, byEndpoint: {}, byProvider: {}, byStatus: {}, recentRequests: [], maxRecent: 50, startTime: Date.now(),
  record(endpoint, provider, statusCode, durationMs) {
    this.total++;
    this.byEndpoint[endpoint] = (this.byEndpoint[endpoint] || 0) + 1;
    const p = provider || "unknown";
    this.byProvider[p] = (this.byProvider[p] || 0) + 1;
    const sb = `${Math.floor(statusCode / 100)}xx`;
    this.byStatus[sb] = (this.byStatus[sb] || 0) + 1;
    this.recentRequests.unshift({ endpoint, provider: p, statusCode, durationMs, time: new Date().toISOString() });
    if (this.recentRequests.length > this.maxRecent) this.recentRequests.pop();
  },
  snapshot() {
    const pconfig = {};
    for (const [name, cfg] of Object.entries(OAI_COMPAT_PROVIDERS)) {
      pconfig[name] = { configured: !!cfg.key, base: cfg.base, models: cfg.models, defaultModel: cfg.defaultModel, custom: !!cfg.custom };
    }
    pconfig.openai = { configured: !!OPENAI_KEY, base: OPENAI_BASE, models: OPENAI_MODELS, defaultModel: OPENAI_MODELS[0] || "gpt-4o", custom: false };
    return { total: this.total, byEndpoint: { ...this.byEndpoint }, byProvider: { ...this.byProvider }, byStatus: { ...this.byStatus }, recentRequests: this.recentRequests.slice(0, 20), uptime: Date.now() - this.startTime, pid: process.pid, port: PORT, enabledProviders: [...enabledProviders], providerConfigs: pconfig };
  },
};

function trackRequest(req, res, provider) {
  const start = Date.now();
  const endpoint = req.method + " " + req.url.split("?")[0].replace(/\/+$/, "");
  res.once("finish", () => { requestStats.record(endpoint, provider || "", res.statusCode, Date.now() - start); });
}

// === Inbound auth ===
//
// Two env vars, both optional:
//
//   PROXY_AUTH_KEY=sk-xxx                       (legacy, single key, no provider lock)
//   PROXY_KEYS=sk-aaa:deepseek,sk-bbb:mimo,sk-ccc:*   (table, optional provider lock)
//
// Each key in the table either:
//   - locks the request to one provider ("deepseek" / "mimo" / "openai") — body.model
//     must resolve to that provider, otherwise 401. If body.model is empty, the
//     provider's default model is used.
//   - is a wildcard ("*") — model field decides routing, same as legacy behaviour.
//
// PROXY_AUTH_KEY (if set) is appended as a wildcard entry, so existing single-key
// setups keep working untouched.
//
// If both env vars are empty, inbound auth is DISABLED — anyone on localhost can
// hit the proxy. /health is always exempt regardless.

const PROXY_AUTH_KEY = (process.env.PROXY_AUTH_KEY || "").trim();
const PROXY_KEYS_RAW = (process.env.PROXY_KEYS || "").trim();

// Map<key, provider | "*">
const PROXY_KEY_TABLE = new Map();
const VALID_LOCK_PROVIDERS = new Set(["deepseek", "mimo", "openai", "*"]);

function loadProxyKeyTable() {
  for (const entry of parseCsv(PROXY_KEYS_RAW)) {
    const idx = entry.lastIndexOf(":");
    if (idx === -1) {
      log.warn(`[proxy] PROXY_KEYS entry missing ':<provider>': "${entry}" — ignored`);
      continue;
    }
    const key = entry.slice(0, idx).trim();
    const provider = entry.slice(idx + 1).trim().toLowerCase();
    if (!key) {
      log.warn(`[proxy] PROXY_KEYS entry has empty key — ignored`);
      continue;
    }
    if (!VALID_LOCK_PROVIDERS.has(provider)) {
      log.warn(`[proxy] PROXY_KEYS entry has unknown provider "${provider}" (allowed: deepseek, mimo, openai, *) — ignored`);
      continue;
    }
    if (PROXY_KEY_TABLE.has(key)) {
      log.warn(`[proxy] PROXY_KEYS entry duplicates key "${key.slice(0, 12)}…" — last wins`);
    }
    PROXY_KEY_TABLE.set(key, provider);
  }
  if (PROXY_AUTH_KEY) {
    if (!PROXY_KEY_TABLE.has(PROXY_AUTH_KEY)) PROXY_KEY_TABLE.set(PROXY_AUTH_KEY, "*");
  }
}
loadProxyKeyTable();

const PROXY_AUTH_ENABLED = PROXY_KEY_TABLE.size > 0;

function getBearerToken(req) {
  const header = req.headers["authorization"] || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

function rejectProxyAuth(req, res, statusCode, message, code) {
  const presented = getBearerToken(req);
  if (process.env.ACCESS_LOG !== "0") {
    log.access(`[access] ${statusCode} auth denied (presented=${presented ? presented.slice(0, 8) + "…" : "<none>"})`);
  }
  sendJson(res, statusCode, {
    error: {
      message,
      type: "invalid_request_error",
      code,
    },
  });
}

function authorizeProxyRequest(req, res, { admin = false } = {}) {
  if (!PROXY_AUTH_ENABLED) return "*";
  if (!admin && isLoopbackRequest(req)) return "*";
  const presented = getBearerToken(req);
  const lock = presented ? PROXY_KEY_TABLE.get(presented) : undefined;
  if (!lock) {
    rejectProxyAuth(
      req,
      res,
      401,
      "Invalid or missing proxy key. Set Authorization: Bearer <key> using one of the keys configured in PROXY_KEYS or PROXY_AUTH_KEY.",
      "proxy_auth_required"
    );
    return null;
  }
  if (admin && lock !== "*") {
    rejectProxyAuth(
      req,
      res,
      403,
      "Admin endpoints require an unrestricted proxy key. Use PROXY_AUTH_KEY or a PROXY_KEYS entry locked to '*'.",
      "proxy_admin_auth_required"
    );
    return null;
  }
  return lock;
}

function isLoopbackRequest(req) {
  const addr = req.socket?.remoteAddress || "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

const DEEPSEEK_BASE = process.env.DEEPSEEK_BASE_URL || process.env.DEEPSEEK_API_BASE || "https://api.deepseek.com/v1";
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || process.env.MY_DS_KEY || "";
const DEEPSEEK_MODELS = parseCsv(process.env.DEEPSEEK_MODELS || "deepseek-v4-pro,deepseek-v4-flash");

const MIMO_BASE = process.env.MIMO_BASE_URL || "https://token-plan-cn.xiaomimimo.com/v1";
const MIMO_KEY = process.env.MIMO_API_KEY || "";
const MIMO_MODELS = parseCsv(process.env.MIMO_MODELS || "mimo-v2.5-pro");

const OPENAI_BASE = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
// Default empty — OpenAI is opt-in, set OPENAI_MODELS or OPENAI_API_KEY explicitly to enable.
const OPENAI_MODELS = parseCsv(process.env.OPENAI_MODELS || "");
const OPENAI_MODEL_PREFIXES = parseCsv(process.env.OPENAI_MODEL_PREFIXES || "gpt-,o1,o3,o4,codex-,chatgpt-");

const DEFAULT_PROVIDER = (process.env.DEFAULT_PROVIDER || "").trim().toLowerCase();

// GitHub token is fetched lazily on first github.com web_fetch call so we don't
// pay the gh-CLI startup cost during proxy boot. Sentinel "unresolved" means
// "haven't checked yet"; "" means "checked, none available".
let _githubToken = process.env.GITHUB_TOKEN || null; // null = not yet resolved
function getGithubToken() {
  if (_githubToken !== null) return _githubToken;
  try { _githubToken = execSync("gh auth token", { encoding: "utf-8", timeout: 3000 }).trim(); }
  catch { _githubToken = ""; }
  return _githubToken;
}

if (!DEEPSEEK_KEY && !OPENAI_KEY && !MIMO_KEY) {
  console.error("At least one upstream provider key is required: set DEEPSEEK_API_KEY, MIMO_API_KEY, and/or OPENAI_API_KEY");
  process.exit(1);
}

// Optional: read MODEL_CATALOG_PATH (the same proxy-models.json Codex uses) so the
// proxy and Codex agree on which models exist. If a model in the catalog has an
// explicit `provider` field, that wins. Otherwise we infer by name (deepseek-* /
// mimo-* / gpt-*). When the file is absent or unreadable we fall back to the
// env-var lists (DEEPSEEK_MODELS, MIMO_MODELS, OPENAI_MODELS) — i.e. backwards
// compatible with the original setup.
const MODEL_CATALOG_PATH = (process.env.MODEL_CATALOG_PATH || "").trim();
function loadCatalogModels(path) {
  try {
    const raw = JSON.parse(fs.readFileSync(path, "utf-8"));
    const out = { deepseek: [], mimo: [], openai: [] };
    for (const m of raw.models || []) {
      if (!m?.slug) continue;
      let p = (m.provider || "").toLowerCase();
      if (!p) {
        const s = m.slug.toLowerCase();
        if (s.startsWith("deepseek")) p = "deepseek";
        else if (s.startsWith("mimo") || s.startsWith("xiaomi")) p = "mimo";
        else if (s.startsWith("gpt-") || s.startsWith("o1") || s.startsWith("o3") || s.startsWith("o4") || s.startsWith("codex-") || s.startsWith("chatgpt-")) p = "openai";
      }
      if (out[p]) out[p].push(m.slug);
    }
    console.log(`[codex-bridge] model_catalog: loaded ${path} (deepseek=${out.deepseek.length}, mimo=${out.mimo.length}, openai=${out.openai.length})`);
    return out;
  } catch (err) {
    console.warn(`[codex-bridge] model_catalog: ${path} unreadable (${err.message}), falling back to env lists`);
    return null;
  }
}
const CATALOG = MODEL_CATALOG_PATH ? loadCatalogModels(MODEL_CATALOG_PATH) : null;
if (CATALOG) {
  if (CATALOG.deepseek.length) DEEPSEEK_MODELS.splice(0, DEEPSEEK_MODELS.length, ...CATALOG.deepseek);
  if (CATALOG.mimo.length) MIMO_MODELS.splice(0, MIMO_MODELS.length, ...CATALOG.mimo);
  if (CATALOG.openai.length) OPENAI_MODELS.splice(0, OPENAI_MODELS.length, ...CATALOG.openai);
}

// OpenAI-compatible Chat Completions upstreams that share the DeepSeek adapter pipeline
// (Responses-API ⇄ Chat-Completions translation, web_fetch injection, streaming bridge, etc.).
// Add new ones (Kimi, Zhipu, ...) by appending another entry — no other code changes needed.
const OAI_COMPAT_PROVIDERS = {
  deepseek: { base: DEEPSEEK_BASE, key: DEEPSEEK_KEY, models: DEEPSEEK_MODELS, defaultModel: DEEPSEEK_MODELS[0] || "deepseek-v4-pro", envKey: "DEEPSEEK_API_KEY" },
  mimo:     { base: MIMO_BASE,     key: MIMO_KEY,     models: MIMO_MODELS,     defaultModel: MIMO_MODELS[0]     || "mimo-v2.5-pro",   envKey: "MIMO_API_KEY"     },
};

// Custom providers from ADDITIONAL_PROVIDERS env var (JSON array)
const ADDITIONAL_PROVIDERS = (() => {
  try { return JSON.parse(process.env.ADDITIONAL_PROVIDERS || '[]'); } catch { return []; }
})();
for (const p of ADDITIONAL_PROVIDERS) {
  if (p.name && p.key) {
    const mods = parseCsv(p.models || '');
    OAI_COMPAT_PROVIDERS[p.name] = {
      base: p.base || 'https://api.openai.com/v1',
      key: p.key,
      models: mods.length ? mods : ['gpt-4o'],
      defaultModel: mods[0] || 'gpt-4o',
      envKey: null,
      custom: true,
    };
  }
}

const enabledProviders = new Set();
for (const [name, cfg] of Object.entries(OAI_COMPAT_PROVIDERS)) {
  if (cfg.key) enabledProviders.add(name);
}
if (OPENAI_KEY) enabledProviders.add("openai");

const providerModels = {
  ...Object.fromEntries(Object.entries(OAI_COMPAT_PROVIDERS).map(([n, c]) => [n, c.models])),
  openai: OPENAI_MODELS,
};

const explicitModelProvider = new Map();
for (const [name, cfg] of Object.entries(OAI_COMPAT_PROVIDERS)) {
  for (const model of cfg.models) explicitModelProvider.set(normalizeModelId(model), name);
}
for (const model of OPENAI_MODELS) explicitModelProvider.set(normalizeModelId(model), "openai");

const modelCatalog = [
  ...Object.entries(OAI_COMPAT_PROVIDERS).flatMap(([name, cfg]) => cfg.models.map((id) => ({ id, object: "model", owned_by: name }))),
  ...OPENAI_MODELS.map((id) => ({ id, object: "model", owned_by: "openai" })),
];

// --- Response store for previous_response_id bridging ---

const responseStore = new Map();
const STORE_TTL = Number(process.env.STORE_TTL_MS) || 60 * 60 * 1000; // 1 hour
const STORE_MAX = Number(process.env.STORE_MAX) || 500;
const MAX_CONSECUTIVE_TOOL_CALLS = Number(process.env.MAX_CONSECUTIVE_TOOL_CALLS) || 20; // circuit breaker threshold
const UPSTREAM_TIMEOUT = Number(process.env.UPSTREAM_TIMEOUT_MS) || 120000; // 2 min, applies to upstream chat/completions/responses calls

// --- Proxy-side web_fetch tool (bypasses sandbox restrictions) ---

const WEB_FETCH_TOOL = {
  type: "function",
  function: {
    name: "web_fetch",
    description: "Fetch content from a URL over HTTP/HTTPS. Use this when you need to retrieve content from a web URL. Returns HTTP status and response body, with HTML pages converted to clean markdown. Supports all HTTP methods.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to fetch (http:// or https://)" },
        method: { type: "string", enum: ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"], description: "HTTP method (default: GET)" },
        headers: { type: "object", description: "Optional HTTP headers as key-value pairs" },
        body: { type: "string", description: "Request body for POST/PUT/PATCH requests" },
      },
      required: ["url"],
    },
  },
};

// --- Jina Reader integration for clean markdown fetches ---

const JINA_BASE = (process.env.JINA_BASE || "https://r.jina.ai").replace(/\/+$/, "");
const JINA_FETCH_TIMEOUT = Number(process.env.JINA_FETCH_TIMEOUT_MS) || 20000;
const JINA_MAX_BODY = Number(process.env.JINA_MAX_BODY) || 80000;

async function jinaRead(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), JINA_FETCH_TIMEOUT);
  try {
    const res = await fetch(`${JINA_BASE}/${url}`, {
      signal: controller.signal,
      headers: {
        "Accept": "text/plain",
        "X-Return-Format": "markdown",
        "User-Agent": "Mozilla/5.0 (compatible; CodexProxy/1.0)",
      },
    });
    clearTimeout(timeout);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return `Jina error: ${res.status} ${res.statusText}\n${text}`.slice(0, JINA_MAX_BODY);
    }
    let text = await res.text();
    if (text.length > JINA_MAX_BODY) {
      text = text.slice(0, JINA_MAX_BODY) + `\n...[content truncated, ${text.length - JINA_MAX_BODY} chars omitted]`;
    }
    return text;
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === "AbortError") return "Jina fetch error: request timed out (20s)";
    return `Jina fetch error: ${err.message}`;
  }
}

const MAX_FETCH_LOOPS = Number(process.env.MAX_FETCH_LOOPS) || 5;
const FETCH_TIMEOUT = Number(process.env.FETCH_TIMEOUT_MS) || 15000;
const FETCH_MAX_BODY = Number(process.env.FETCH_MAX_BODY) || 50000;

async function rawFetch(url, method = "GET", headers = {}, reqBody = null) {
  if (!headers["User-Agent"]) headers["User-Agent"] = "Mozilla/5.0 (compatible; CodexProxy/1.0)";
  if (/api\.github\.com/.test(url) && !headers["Authorization"] && !headers["authorization"]) {
    const tok = getGithubToken();
    if (tok) headers["Authorization"] = `Bearer ${tok}`;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  const fetchOpts = { method, headers, signal: controller.signal, redirect: "follow" };
  // executeWebFetch passes object bodies straight from JSON tool args; coerce to string
  // here so fetch() doesn't get something like "[object Object]" or throw on a Map.
  if (reqBody && /^(POST|PUT|PATCH)$/i.test(method)) {
    if (typeof reqBody === "string" || reqBody instanceof Uint8Array || reqBody instanceof ArrayBuffer) {
      fetchOpts.body = reqBody;
    } else {
      fetchOpts.body = JSON.stringify(reqBody);
      if (!headers["Content-Type"] && !headers["content-type"]) {
        headers["Content-Type"] = "application/json";
      }
    }
  }
  const response = await fetch(url, fetchOpts);
  clearTimeout(timeout);
  const ct = response.headers.get("content-type") || "";
  const status = `HTTP ${response.status} ${response.statusText}`;
  if (/^(HEAD|OPTIONS)$/i.test(method)) {
    const hdrs = [...response.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");
    return `${status}\n${hdrs}`;
  }
  if (/image|audio|video|octet-stream/.test(ct)) {
    return `${status}\nContent-Type: ${ct}\n(binary content, not shown)`;
  }
  let text = await response.text();
  if (text.length > FETCH_MAX_BODY) {
    text = text.slice(0, FETCH_MAX_BODY) + `\n...[truncated, ${text.length - FETCH_MAX_BODY} chars omitted]`;
  }
  return `${status}\n\n${text}`;
}

async function executeWebFetch(argsStr) {
  try {
    const args = typeof argsStr === "string" ? JSON.parse(argsStr) : argsStr;
    const { url, method = "GET", headers = {}, body: reqBody } = args;
    if (!url) return "Error: no URL provided";
    if (method === "GET") return await jinaRead(url);
    return await rawFetch(url, method, headers, reqBody);
  } catch (err) {
    if (err.name === "AbortError") return "Fetch error: request timed out";
    return `Fetch error: ${err.message}`;
  }
}

function parseCsv(value) {
  // Case-insensitive dedup: keep the first-seen casing of each entry.
  const seen = new Set();
  const out = [];
  for (const raw of String(value || "").split(",")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const k = trimmed.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(trimmed);
  }
  return out;
}

function normalizeModelId(model) {
  return String(model || "").trim().toLowerCase();
}

function contentHasUrl(content) {
  if (typeof content === "string") return /https?:\/\//.test(content);
  if (Array.isArray(content)) {
    return content.some((part) => {
      if (typeof part === "string") return /https?:\/\//.test(part);
      if (part && typeof part.text === "string") return /https?:\/\//.test(part.text);
      if (part && typeof part.url === "string") return /https?:\/\//.test(part.url);
      if (part && typeof part.image_url === "string") return /https?:\/\//.test(part.image_url);
      if (part?.image_url?.url && typeof part.image_url.url === "string") return /https?:\/\//.test(part.image_url.url);
      return false;
    });
  }
  return false;
}

function conversationHasUrls(messages) {
  return messages.some((message) => contentHasUrl(message?.content));
}

function ensureWebFetchTool(tools) {
  const list = Array.isArray(tools) ? [...tools] : [];
  const alreadyPresent = list.some((tool) => {
    if (tool?.type !== "function") return false;
    return tool?.function?.name === WEB_FETCH_TOOL.function.name || tool?.name === WEB_FETCH_TOOL.function.name;
  });
  if (!alreadyPresent) list.push(WEB_FETCH_TOOL);
  return list;
}

function ensureWebFetchHint(messages) {
  const hint =
    "[System: You have a `web_fetch` tool available for making HTTP requests. Use it instead of curl, wget, or other shell-based HTTP tools. Call web_fetch with {\"url\": \"...\"} to fetch any URL. It supports GET, HEAD, POST, PUT, DELETE, PATCH, and OPTIONS methods.]";
  const alreadyPresent = messages.some((message) => message?.role === "user" && message?.content === hint);
  if (alreadyPresent) return messages;
  return [...messages, { role: "user", content: hint }];
}

function getFallbackProvider() {
  if (DEFAULT_PROVIDER && enabledProviders.has(DEFAULT_PROVIDER)) return DEFAULT_PROVIDER;
  if (enabledProviders.has("openai")) return "openai";
  for (const name of Object.keys(OAI_COMPAT_PROVIDERS)) {
    if (enabledProviders.has(name)) return name;
  }
  throw new Error("No providers are enabled");
}

// Heuristic name-based routing for OAI-compatible providers when the explicit map misses.
// Order matters: longer/more-specific tokens first so e.g. "deepseek-mimo" wouldn't
// accidentally fall through to MiMo. Keep this list short and add entries when needed.
const OAI_COMPAT_NAME_HINTS = [
  { provider: "deepseek", tokens: ["deepseek"] },
  { provider: "mimo",     tokens: ["mimo", "xiaomi"] },
];

function resolveProviderForModel(model) {
  const normalized = normalizeModelId(model);
  if (normalized) {
    const explicit = explicitModelProvider.get(normalized);
    if (explicit && enabledProviders.has(explicit)) return explicit;
    for (const { provider, tokens } of OAI_COMPAT_NAME_HINTS) {
      if (enabledProviders.has(provider) && tokens.some((t) => normalized.includes(t))) return provider;
    }
    if (enabledProviders.has("openai")) {
      const looksOpenAI = OPENAI_MODEL_PREFIXES.some((prefix) => normalized.startsWith(prefix.toLowerCase()));
      if (looksOpenAI) return "openai";
    }
  }
  return getFallbackProvider();
}

function modelForProvider(cfg, requestedModel) {
  const requested = String(requestedModel || "").trim();
  if (!requested) return cfg.defaultModel;
  const allowed = new Set((cfg.models || []).map((m) => normalizeModelId(m)));
  return allowed.has(normalizeModelId(requested)) ? requested : cfg.defaultModel;
}

// Read with LRU bookkeeping: refreshes insertion order so frequently-used roots
// don't get evicted by the eviction loop in storeResponse.
function touchResponse(id) {
  if (!id) return undefined;
  const entry = responseStore.get(id);
  if (!entry) return undefined;
  // Re-insert to move it to the most-recently-used end of the Map.
  responseStore.delete(id);
  responseStore.set(id, entry);
  return entry;
}

function storeResponse(id, data) {
  if (!id) return;

  if (responseStore.size >= STORE_MAX) {
    const now = Date.now();
    for (const [key, val] of responseStore) {
      if (now - val.storedAt > STORE_TTL) responseStore.delete(key);
    }
    if (responseStore.size >= STORE_MAX) {
      // Insertion order = LRU order because every read goes through touchResponse.
      const oldest = responseStore.keys().next().value;
      responseStore.delete(oldest);
    }
  }

  const isToolCallOnly = Array.isArray(data.output) &&
    data.output.length > 0 &&
    data.output.every((o) => o.type === "function_call");

  let consecutiveToolCalls = 0;
  if (data.previousResponseId) {
    const prev = touchResponse(data.previousResponseId);
    if (prev?.breakerFired) {
      // Hard breaker already fired up-chain — counter has been reset; don't propagate.
      consecutiveToolCalls = 0;
    } else if (isToolCallOnly) {
      consecutiveToolCalls = (prev?.consecutiveToolCalls || 0) + 1;
    }
  }

  responseStore.set(id, { ...data, storedAt: Date.now(), consecutiveToolCalls });
  log.info(
    `[proxy] stored response ${id} (provider=${data.provider || "unknown"}, store size: ${responseStore.size}${consecutiveToolCalls > 0 ? `, consecutive_tc: ${consecutiveToolCalls}` : ""})`
  );
}

function resolveResponseChain(previousResponseId) {
  const chain = [];
  let currentId = previousResponseId;
  const visited = new Set();

  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const stored = touchResponse(currentId);
    if (!stored) {
      log.warn(`[proxy] previous_response_id ${currentId} not found in store`);
      break;
    }
    chain.unshift(stored);
    currentId = stored.previousResponseId;
  }

  const items = [];
  for (const entry of chain) {
    if (Array.isArray(entry.input)) items.push(...entry.input);
    if (Array.isArray(entry.output)) items.push(...entry.output);
  }
  return items;
}

function normalizeInputToArray(input) {
  if (Array.isArray(input)) return input;
  if (typeof input === "string") {
    return [{ type: "message", role: "user", content: [{ type: "input_text", text: input }] }];
  }
  return [];
}

function maybeResolvePreviousResponseChain(body, targetProvider) {
  if (!body.previous_response_id) return;

  const previous = responseStore.get(body.previous_response_id);
  if (!previous) {
    if (targetProvider === "deepseek") {
      log.warn(`[proxy] previous_response_id ${body.previous_response_id} missing; clearing to avoid sending stale ref upstream`);
    }
    delete body.previous_response_id;
    return;
  }

  const needsLocalResolution = targetProvider === "deepseek" || previous.provider !== targetProvider;
  if (!needsLocalResolution) return;

  const chainItems = resolveResponseChain(body.previous_response_id);
  if (chainItems.length === 0) return;

  const currentInput = normalizeInputToArray(body.input);
  body.input = [...chainItems, ...currentInput];
  delete body.previous_response_id;
  log.info(`[proxy] locally resolved previous_response_id across provider boundary -> ${targetProvider} (${chainItems.length} items prepended)`);
}

// --- Shared message-list normalisation ---
//
// Both the Responses-API translator and the Chat-Completions handler need to:
//   1. Re-order tool messages to sit immediately after the assistant tool_calls they answer
//   2. Merge consecutive same-role messages
//   3. Drop text-only assistant messages that follow tool_calls
//   4. Drop orphan tool messages
//   5. Coerce tool_call.arguments / tool.content to strings (only used by the CC path)
// They used to maintain two separate copies. This is the single source of truth.
function normalizeMessages(messages, { coerceStrings = false } = {}) {
  // Pass 1: re-order tool replies adjacent to their tool_calls.
  const work = [...messages];
  const fixed = [];
  for (let i = 0; i < work.length; i++) {
    const msg = work[i];
    if (msg === null) continue;
    if (msg.role === "assistant" && msg.tool_calls) {
      fixed.push(msg);
      const callIds = new Set(msg.tool_calls.map((tc) => tc.id));
      for (let j = i + 1; j < work.length; j++) {
        if (work[j]?.role === "tool" && callIds.has(work[j].tool_call_id)) {
          fixed.push(work[j]);
          work[j] = null;
        }
      }
    } else if (msg.role === "tool") {
      const lastTc = [...fixed].reverse().find((m) => m.role === "assistant" && m.tool_calls);
      if (lastTc) {
        let insertIdx = fixed.indexOf(lastTc) + 1;
        while (insertIdx < fixed.length && fixed[insertIdx].role === "tool") insertIdx++;
        fixed.splice(insertIdx, 0, msg);
        work[i] = null;
      }
    } else {
      fixed.push(msg);
    }
  }

  // Pass 2: merge consecutive same-role and drop trailing text-only assistant after tool_calls.
  const merged = [];
  for (const msg of fixed) {
    const prev = merged[merged.length - 1];
    if (
      prev && prev.role === msg.role && msg.role === "user" &&
      typeof prev.content === "string" && typeof msg.content === "string"
    ) {
      prev.content += "\n\n" + msg.content;
    } else if (
      prev && prev.role === msg.role && msg.role === "assistant" &&
      !prev.tool_calls && !msg.tool_calls &&
      typeof prev.content === "string" && typeof msg.content === "string"
    ) {
      prev.content += "\n\n" + msg.content;
    } else if (
      prev && prev.role === "assistant" && msg.role === "assistant" &&
      !prev.tool_calls && msg.tool_calls
    ) {
      merged[merged.length - 1] = msg;
    } else if (
      prev && prev.role === "assistant" && msg.role === "assistant" &&
      prev.tool_calls && !msg.tool_calls
    ) {
      // Drop text-only assistant after tool_calls.
    } else {
      merged.push(msg);
    }
  }

  // Pass 3: drop orphan tool messages.
  const validated = [];
  for (const msg of merged) {
    if (msg.role === "tool") {
      const prev = validated[validated.length - 1];
      if (prev && (prev.role === "tool" || (prev.role === "assistant" && prev.tool_calls))) {
        validated.push(msg);
      }
    } else {
      validated.push(msg);
    }
  }

  // Pass 4 (chat/completions only): coerce tool_call args + tool content to strings.
  if (coerceStrings) {
    for (const msg of validated) {
      if (msg.role === "assistant" && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (!tc.function) continue;
          const args = tc.function.arguments;
          if (args === undefined || args === null || args === "") {
            tc.function.arguments = "{}";
          } else if (typeof args !== "string") {
            tc.function.arguments = JSON.stringify(args);
          } else {
            try {
              JSON.parse(args);
            } catch {
              log.warn(`[proxy] invalid tool_call arguments for ${tc.function.name} (id: ${tc.id}), wrapping as JSON`);
              tc.function.arguments = JSON.stringify({ input: args });
            }
          }
        }
      }
      if (msg.role === "tool" && typeof msg.content !== "string") {
        msg.content = JSON.stringify(msg.content);
      }
    }
  }

  return validated;
}

// --- Request translation: Responses API -> Chat Completions (DeepSeek path only) ---

// Codex CLI's effort enum is: none | minimal | low | medium | high | xhigh.
//
// Each upstream accepts a different subset (verified via probe):
//   DeepSeek (deepseek-v4-*): low | medium | high | max | xhigh
//     - default = thinking ON (no field needed)
//     - to disable thinking: send `thinking: { type: "disabled" }`
//       (NB: `enable_thinking: false` is silently ignored by DeepSeek)
//   MiMo (mimo-v2.5-*):       low | medium | high
//     - same `thinking: { type: "disabled" }` to disable
//
// Translation rules (per provider):
//
//   Codex effort       DeepSeek                          MiMo
//   ----------------   --------------------------------  --------------------------------
//   none               thinking:{type:"disabled"}        thinking:{type:"disabled"}
//   minimal            reasoning_effort:"low"            reasoning_effort:"low"
//   low / medium / high reasoning_effort:<same>          reasoning_effort:<same>
//   xhigh              reasoning_effort:"xhigh"          reasoning_effort:"high" (clamped)
//
// `max` is NOT in Codex's enum (Codex would refuse it during config parse), so it
// can't reach the proxy from a Codex client. We still accept it here for direct
// callers that want DeepSeek's extended max tier; MiMo clamps it like xhigh.
// Anything else is passed through as-is and the upstream gets to 400 it.
function applyEffortTranslation(req, effort, provider) {
  if (!effort) return;
  const e = String(effort).toLowerCase().trim();
  if (e === "none") {
    req.thinking = { type: "disabled" };
    return;
  }
  if (e === "minimal") {
    req.reasoning_effort = "low";
    return;
  }
  if (provider === "mimo" && (e === "max" || e === "xhigh")) {
    req.reasoning_effort = "high";
    return;
  }
  req.reasoning_effort = e;
}

function responsesRequestToChatCompletions(body, provider) {
  const messages = [];

  if (body.instructions) {
    messages.push({
      role: "user",
      content: "[System Instructions] " + body.instructions + "\n\nNote: Be efficient with tool calls. Avoid repeating the same tool call unnecessarily.",
    });
  }

  // Build a callId -> reasoning_content map from responseStore. We capture
  // upstream `delta.reasoning_content` on each turn and stash it on the stored
  // entry; here we replay it so DeepSeek's thinking-mode tool-call round-trip
  // doesn't 400 on a missing `reasoning_content`. Scanning all entries is fine
  // because the store is hard-capped (STORE_MAX, default 500). Only build the
  // index for DeepSeek — MiMo / OpenAI don't accept reasoning_content fields.
  const reasoningByCallId = new Map();
  if (provider === "deepseek") {
    for (const entry of responseStore.values()) {
      if (!entry.reasoningContent) continue;
      for (const out of entry.output || []) {
        if (out.type === "function_call" && out.call_id) {
          reasoningByCallId.set(out.call_id, entry.reasoningContent);
        }
      }
    }
  }

  if (typeof body.input === "string") {
    messages.push({ role: "user", content: body.input });
  } else if (Array.isArray(body.input)) {
    let pendingToolCalls = [];
    const flushPendingToolCalls = () => {
      if (pendingToolCalls.length === 0) return;
      const msg = { role: "assistant", content: null, tool_calls: pendingToolCalls };
      // Attach reasoning if any of the calls in this batch has one cached.
      // (DeepSeek emits one reasoning per response, shared by all tool_calls.)
      for (const tc of pendingToolCalls) {
        const r = reasoningByCallId.get(tc.id);
        if (r) { msg.reasoning_content = r; break; }
      }
      messages.push(msg);
      pendingToolCalls = [];
    };

    for (const item of body.input) {
      // Tolerate items without explicit `type`: if it has a role/content shape,
      // treat it as a plain message (Codex CLI / cc-switch health probe sends
      // `[{role,content}]` without setting type, and OpenAI's Responses API
      // accepts that form too).
      const itemType = item.type || (item.role ? "message" : undefined);
      if (itemType === "message") {
        const role = (item.role === "developer" || item.role === "system") ? "user" : item.role;
        let content;

        if (typeof item.content === "string") {
          content = item.content;
        } else if (Array.isArray(item.content)) {
          content = item.content.map((block) => {
            if (block.type === "input_text") return { type: "text", text: block.text };
            if (block.type === "output_text") return { type: "text", text: block.text };
            if (block.type === "input_image") {
              const rawUrl = block.image_url || block.url || "";
              const url = typeof rawUrl === "object" ? (rawUrl.url || "") : rawUrl;
              return { type: "image_url", image_url: { url } };
            }
            return block;
          });
          if (content.length === 1 && content[0].type === "text") {
            content = content[0].text;
          }
        }

        if (pendingToolCalls.length > 0 && role === "assistant") {
          flushPendingToolCalls();
        } else {
          flushPendingToolCalls();
          messages.push({ role, content });
        }
      } else if (itemType === "function_call") {
        pendingToolCalls.push({
          id: item.call_id || item.id,
          type: "function",
          function: { name: item.name, arguments: item.arguments },
        });
      } else if (itemType === "input_image") {
        flushPendingToolCalls();
        const rawUrl = item.image_url || item.url || "";
        const url = typeof rawUrl === "object" ? (rawUrl.url || "") : rawUrl;
        messages.push({ role: "user", content: [{ type: "image_url", image_url: { url } }] });
      } else if (itemType === "function_call_output") {
        flushPendingToolCalls();
        let output = item.output;
        if (Array.isArray(output)) output = JSON.stringify(output);
        else if (output === null || output === undefined) output = "";
        else if (typeof output !== "string") output = String(output);
        messages.push({ role: "tool", tool_call_id: item.call_id, content: output });
      }
    }

    flushPendingToolCalls();
  }

  const merged = normalizeMessages(messages);

  const TOOL_OUTPUT_MAX = 2000;
  const KEEP_RECENT_FULL = 10;
  for (let i = 0; i < Math.max(0, merged.length - KEEP_RECENT_FULL); i++) {
    const msg = merged[i];
    if (msg.role === "tool" && typeof msg.content === "string" && msg.content.length > TOOL_OUTPUT_MAX) {
      msg.content = msg.content.slice(0, TOOL_OUTPUT_MAX) + "\n...[output truncated, " + (msg.content.length - TOOL_OUTPUT_MAX) + " chars removed]";
    }
  }

  const MAX_MESSAGES = 55;
  let finalMessages = merged;
  if (merged.length > MAX_MESSAGES) {
    const head = merged.slice(0, 2);
    let tail = merged.slice(-(MAX_MESSAGES - 3));
    // 跳过首尾孤立的 tool / assistant(tc) 对，避免上游收到残缺的 tool_calls 链
    while (tail.length > 0) {
      if (tail[0].role === "tool") {
        tail.shift();
      } else if (tail[0].role === "assistant" && tail[0].tool_calls) {
        tail.shift();
      } else {
        break;
      }
    }
    finalMessages = [
      ...head,
      {
        role: "user",
        content: "[Earlier conversation trimmed. Do not repeat previous statements or tool calls you already made. Continue with the current task. If you have enough information, respond to the user instead of making more tool calls.]",
      },
      ...tail,
    ];
    log.info(`[proxy] trimmed ${merged.length} -> ${finalMessages.length} messages`);
  }

  // After trim we may have left orphan tool messages — re-normalise to drop them.
  if (merged.length > MAX_MESSAGES) {
    finalMessages = normalizeMessages(finalMessages);
  }

  const req = {
    model: body.model,
    messages: finalMessages,
    stream: body.stream || false,
  };

  if (body.temperature != null) req.temperature = body.temperature;
  if (body.top_p != null) req.top_p = body.top_p;
  req.max_tokens = body.max_output_tokens || 16384;

  if (body.tools?.length > 0) {
    const supported = body.tools.filter((t) => t.type === "function");
    if (supported.length > 0) {
      req.tools = supported.map((t) => {
        if (!t.function) {
          return {
            type: "function",
            function: { name: t.name, description: t.description, parameters: t.parameters },
          };
        }
        return t;
      });
    }
  }

  if (body.tool_choice != null) {
    if (typeof body.tool_choice === "object" && body.tool_choice.name) {
      req.tool_choice = { type: "function", function: { name: body.tool_choice.name } };
    } else {
      req.tool_choice = body.tool_choice;
    }
  }

  applyEffortTranslation(req, body.reasoning?.effort, provider);
  if (body.parallel_tool_calls != null) req.parallel_tool_calls = body.parallel_tool_calls;

  // DeepSeek thinking-mode + tool-call round-trip safety net.
  //
  // When DeepSeek runs in thinking mode (the default unless we send
  // `thinking:{type:"disabled"}`), it requires the original `reasoning_content`
  // to be sent back attached to any prior assistant tool_call message; otherwise
  // it 400s with "The `reasoning_content` in the thinking mode must be passed
  // back to the API.". Codex CLI does NOT round-trip `reasoning_content` through
  // this proxy (we strip it from the upstream stream and Codex stores nothing
  // we can replay), so any conversation that includes an assistant tool_call
  // must run with thinking disabled — otherwise the very next turn dies.
  //
  // We trigger this defensively whenever the request body contains an assistant
  // message with `tool_calls` and `req.thinking` isn't already disabled. This
  // also covers the case where the client sends `reasoning:{}` without an
  // explicit effort (then applyEffortTranslation is a no-op and DeepSeek would
  // default to thinking ON).
  if (provider === "deepseek" && req.thinking?.type !== "disabled") {
    // 只检查最后一条 assistant 消息，避免历史轮次中的 tool_calls 误判
    const lastAssistant = [...finalMessages].reverse().find((m) => m.role === "assistant");
    const hasAssistantToolCalls = lastAssistant && Array.isArray(lastAssistant.tool_calls) && lastAssistant.tool_calls.length > 0 && !lastAssistant.reasoning_content;
    if (hasAssistantToolCalls) {
      req.thinking = { type: "disabled" };
      delete req.reasoning_effort;
      log.info("[proxy] deepseek: assistant tool_calls without reasoning_content -> forcing thinking:disabled");
    }
  }

  return req;
}

// --- Response translation: Chat Completions -> Responses (DeepSeek path) ---

function uid() {
  return crypto.randomBytes(12).toString("base64url");
}

function chatCompletionToResponse(cc, model, previousResponseId, metadata) {
  const responseId = `resp_${uid()}`;
  const output = [];
  const choice = cc.choices?.[0];

  if (!choice) {
    return {
      id: responseId,
      object: "response",
      created_at: cc.created || Math.floor(Date.now() / 1000),
      status: "completed",
      model: model || cc.model,
      output: [],
      usage: translateUsage(cc.usage),
    };
  }

  const msg = choice.message;

  if (msg.tool_calls?.length > 0) {
    for (const tc of msg.tool_calls) {
      output.push({
        type: "function_call",
        id: `fc_${uid()}`,
        call_id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
        status: "completed",
      });
    }
  }

  let text = msg.content || "";
  text = text.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();
  if (text) {
    output.push({
      type: "message",
      id: `msg_${uid()}`,
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    });
  }

  if (msg.refusal) {
    const msgItem = output.find((o) => o.type === "message") || {
      type: "message",
      id: `msg_${uid()}`,
      status: "completed",
      role: "assistant",
      content: [],
    };
    msgItem.content.push({ type: "refusal", refusal: msg.refusal });
    if (!output.find((o) => o.type === "message")) output.push(msgItem);
  }

  let status = "completed";
  let incompleteDetails = null;
  if (choice.finish_reason === "length") {
    status = "incomplete";
    incompleteDetails = { reason: "max_output_tokens" };
  } else if (choice.finish_reason === "content_filter") {
    status = "incomplete";
    incompleteDetails = { reason: "content_filter" };
  }

  return {
    id: responseId,
    object: "response",
    created_at: cc.created || Math.floor(Date.now() / 1000),
    status,
    model: model || cc.model,
    output,
    previous_response_id: previousResponseId || null,
    metadata: metadata || {},
    usage: translateUsage(cc.usage),
    incomplete_details: incompleteDetails,
  };
}

function translateUsage(u) {
  if (!u) return { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  return {
    input_tokens: u.prompt_tokens || 0,
    output_tokens: u.completion_tokens || 0,
    total_tokens: u.total_tokens || 0,
    input_tokens_details: { cached_tokens: u.prompt_tokens_details?.cached_tokens || 0 },
    output_tokens_details: { reasoning_tokens: u.completion_tokens_details?.reasoning_tokens || 0 },
  };
}

// --- Streaming translation for DeepSeek chat completions -> Responses SSE ---

function buildStreamingResponseEvents(responseId, model, previousResponseId, metadata) {
  const baseResponse = {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "in_progress",
    model,
    output: [],
    previous_response_id: previousResponseId || null,
    metadata: metadata || {},
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  };

  return {
    created: () => `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: baseResponse })}\n\n`,
    inProgress: () => `event: response.in_progress\ndata: ${JSON.stringify({ type: "response.in_progress", response: baseResponse })}\n\n`,
    outputItemAdded: (index, item) => `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: index, item })}\n\n`,
    contentPartAdded: (outIdx, contentIdx, part) => `event: response.content_part.added\ndata: ${JSON.stringify({ type: "response.content_part.added", output_index: outIdx, content_index: contentIdx, part })}\n\n`,
    textDelta: (outIdx, contentIdx, delta) => `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", output_index: outIdx, content_index: contentIdx, delta })}\n\n`,
    textDone: (outIdx, contentIdx, text) => `event: response.output_text.done\ndata: ${JSON.stringify({ type: "response.output_text.done", output_index: outIdx, content_index: contentIdx, text })}\n\n`,
    contentPartDone: (outIdx, contentIdx, part) => `event: response.content_part.done\ndata: ${JSON.stringify({ type: "response.content_part.done", output_index: outIdx, content_index: contentIdx, part })}\n\n`,
    outputItemDone: (outIdx, item) => `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: outIdx, item })}\n\n`,
    fnCallArgsDelta: (outIdx, callId, delta) => `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: "response.function_call_arguments.delta", output_index: outIdx, call_id: callId, delta })}\n\n`,
    fnCallArgsDone: (outIdx, callId, args) => `event: response.function_call_arguments.done\ndata: ${JSON.stringify({ type: "response.function_call_arguments.done", output_index: outIdx, call_id: callId, arguments: args })}\n\n`,
    completed: (response) => `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`,
  };
}

async function handleStreamingResponse(req, upstreamRes, res, model, previousResponseId, metadata) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const teardown = wireClientCancel(res, upstreamRes);
  const responseId = `resp_${uid()}`;
  const events = buildStreamingResponseEvents(responseId, model, previousResponseId, metadata);
  await writeWithBackpressure(res, events.created());
  await writeWithBackpressure(res, events.inProgress());

  let fullText = "";
  let reasoningContent = "";
  let inThink = false;
  let messageStarted = false;
  let completionSent = false;
  const toolCalls = new Map();
  let outputIndex = 0;
  let textOutputIdx = -1;
  let buffer = "";
  let streamOutput = null;
  const decoder = new TextDecoder();

  try {
    for await (const chunk of upstreamRes.body) {
      if (clientGone(res)) break;
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") {
          if (!completionSent) {
            completionSent = true;
            streamOutput = await sendCompletion(res, events, responseId, model, fullText, toolCalls, outputIndex, textOutputIdx, null, null, previousResponseId, metadata);
          }
          continue;
        }

        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }

        const delta = parsed.choices?.[0]?.delta;
        const finishReason = parsed.choices?.[0]?.finish_reason;
        if (!delta && !finishReason) continue;

        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            const tcOutIdx = (messageStarted && textOutputIdx === 0) ? outputIndex + idx + 1 : outputIndex + idx;
            if (!toolCalls.has(idx)) {
              const callId = tc.id || `call_${uid()}`;
              const fcId = `fc_${uid()}`;
              toolCalls.set(idx, { id: fcId, callId, name: tc.function?.name || "", arguments: "", outputIdx: tcOutIdx });
              await writeWithBackpressure(res, events.outputItemAdded(tcOutIdx, {
                type: "function_call",
                id: fcId,
                call_id: callId,
                name: tc.function?.name || "",
                arguments: "",
                status: "in_progress",
              }));
            }
            if (tc.function?.arguments) {
              const tcData = toolCalls.get(idx);
              tcData.arguments += tc.function.arguments;
              await writeWithBackpressure(res, events.fnCallArgsDelta(tcData.outputIdx, tcData.callId, tc.function.arguments));
            }
          }
          if (finishReason && !completionSent) {
            completionSent = true;
            streamOutput = await sendCompletion(res, events, responseId, model, fullText, toolCalls, outputIndex, textOutputIdx, finishReason, parsed.usage, previousResponseId, metadata);
          }
          continue;
        }

        if (typeof delta?.reasoning_content === "string") {
          // Capture but don't forward — Codex CLI doesn't round-trip Responses-API
          // reasoning items through this proxy. We stash the raw string on the
          // stored response and replay it on the next turn (see
          // `responsesRequestToChatCompletions`) so DeepSeek's thinking-mode
          // tool-call round-trip doesn't 400 on a missing `reasoning_content`.
          reasoningContent += delta.reasoning_content;
          continue;
        }

        if (delta?.content) {
          let text = delta.content;
          if (text.includes("<think>")) { inThink = true; text = text.replace(/<think>/g, ""); }
          if (text.includes("</think>")) { inThink = false; text = text.replace(/<\/think>/g, ""); }
          if (inThink || !text) continue;

          if (!messageStarted) {
            messageStarted = true;
            textOutputIdx = outputIndex + toolCalls.size;
            await writeWithBackpressure(res, events.outputItemAdded(textOutputIdx, {
              type: "message",
              id: `msg_${uid()}`,
              status: "in_progress",
              role: "assistant",
              content: [],
            }));
            await writeWithBackpressure(res, events.contentPartAdded(textOutputIdx, 0, { type: "output_text", text: "", annotations: [] }));
          }

          fullText += text;
          await writeWithBackpressure(res, events.textDelta(textOutputIdx, 0, text));
        }

        if (finishReason && !completionSent) {
          completionSent = true;
          streamOutput = await sendCompletion(res, events, responseId, model, fullText, toolCalls, outputIndex, textOutputIdx, finishReason, parsed.usage, previousResponseId, metadata);
        }
      }
    }
  } finally {
    teardown();
  }

  if (clientGone(res)) {
    log.warn(`[proxy] client disconnected mid-stream (${responseId})`);
    try { res.end(); } catch { /* ignore */ }
    return { responseId, output: streamOutput || [], reasoningContent };
  }

  if (!completionSent) {
    completionSent = true;
    const wasGenerating = fullText.length > 0 || toolCalls.size > 0;
    const fallbackReason = wasGenerating ? "length" : "stop";
    log.warn(`[proxy] stream ended without finish_reason (wasGenerating=${wasGenerating}, reason=${fallbackReason})`);
    streamOutput = await sendCompletion(res, events, responseId, model, fullText, toolCalls, outputIndex, textOutputIdx, fallbackReason, null, previousResponseId, metadata);
  }

  res.end();
  return { responseId, output: streamOutput || [], reasoningContent };
}

async function sendCompletion(res, events, responseId, model, fullText, toolCalls, outputIndex, textOutputIdx, finishReason, usage, previousResponseId, metadata) {
  for (const [idx, tc] of toolCalls) {
    const tcIdx = tc.outputIdx != null ? tc.outputIdx : outputIndex + idx;
    await writeWithBackpressure(res, events.fnCallArgsDone(tcIdx, tc.callId, tc.arguments));
    await writeWithBackpressure(res, events.outputItemDone(tcIdx, {
      type: "function_call",
      id: tc.id,
      call_id: tc.callId,
      name: tc.name,
      arguments: tc.arguments,
      status: "completed",
    }));
  }

  const msgOutIdx = textOutputIdx >= 0 ? textOutputIdx : outputIndex + toolCalls.size;
  const trimmed = fullText.trim();
  if (trimmed) {
    const donePart = { type: "output_text", text: trimmed, annotations: [] };
    await writeWithBackpressure(res, events.textDone(msgOutIdx, 0, trimmed));
    await writeWithBackpressure(res, events.contentPartDone(msgOutIdx, 0, donePart));
    await writeWithBackpressure(res, events.outputItemDone(msgOutIdx, {
      type: "message",
      id: `msg_${uid()}`,
      status: "completed",
      role: "assistant",
      content: [donePart],
    }));
  }

  const outputItems = [];
  for (const [idx, tc] of toolCalls) {
    const tcIdx = tc.outputIdx != null ? tc.outputIdx : outputIndex + idx;
    outputItems.push({
      sortIdx: tcIdx,
      item: {
        type: "function_call",
        id: tc.id,
        call_id: tc.callId,
        name: tc.name,
        arguments: tc.arguments,
        status: "completed",
      },
    });
  }
  if (trimmed) {
    outputItems.push({
      sortIdx: msgOutIdx,
      item: {
        type: "message",
        id: `msg_${uid()}`,
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: trimmed, annotations: [] }],
      },
    });
  }
  outputItems.sort((a, b) => a.sortIdx - b.sortIdx);
  const finalOutput = outputItems.map((o) => o.item);

  let status = "completed";
  let incompleteDetails = null;
  if (finishReason === "length") {
    status = "incomplete";
    incompleteDetails = { reason: "max_output_tokens" };
  }

  const finalResponse = {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    output: finalOutput,
    previous_response_id: previousResponseId || null,
    metadata: metadata || {},
    usage: translateUsage(usage),
    incomplete_details: incompleteDetails,
  };

  await writeWithBackpressure(res, events.completed(finalResponse));
  return finalOutput;
}

async function sendResponseAsStream(res, response, req) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const events = buildStreamingResponseEvents(response.id, response.model, response.previous_response_id, response.metadata);
  await writeWithBackpressure(res, events.created());
  await writeWithBackpressure(res, events.inProgress());

  for (let i = 0; i < response.output.length; i++) {
    if (clientGone(res)) break;
    const item = response.output[i];
    if (item.type === "function_call") {
      await writeWithBackpressure(res, events.outputItemAdded(i, { ...item, status: "in_progress", arguments: "" }));
      await writeWithBackpressure(res, events.fnCallArgsDelta(i, item.call_id, item.arguments));
      await writeWithBackpressure(res, events.fnCallArgsDone(i, item.call_id, item.arguments));
      await writeWithBackpressure(res, events.outputItemDone(i, item));
    } else if (item.type === "message") {
      await writeWithBackpressure(res, events.outputItemAdded(i, { ...item, status: "in_progress", content: [] }));
      for (let ci = 0; ci < item.content.length; ci++) {
        const part = item.content[ci];
        if (part.type === "output_text") {
          await writeWithBackpressure(res, events.contentPartAdded(i, ci, { type: "output_text", text: "", annotations: [] }));
          const text = part.text;
          for (let c = 0; c < text.length; c += 80) {
            if (clientGone(res)) break;
            await writeWithBackpressure(res, events.textDelta(i, ci, text.slice(c, c + 80)));
          }
          await writeWithBackpressure(res, events.textDone(i, ci, text));
          await writeWithBackpressure(res, events.contentPartDone(i, ci, part));
        }
      }
      await writeWithBackpressure(res, events.outputItemDone(i, item));
    }
  }

  await writeWithBackpressure(res, events.completed(response));
  res.end();
}

// --- Generic upstream helpers ---

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

// Wrap fetch with an AbortController so a stuck upstream eventually fails
// instead of hanging the request forever. Defaults to UPSTREAM_TIMEOUT (env-tunable).
async function fetchWithTimeout(url, opts, timeoutMs = UPSTREAM_TIMEOUT) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  // Honour caller-provided signal too (chain abort).
  if (opts.signal) {
    opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

// Wire client-disconnect to upstream cancel so Ctrl+C in Codex CLI doesn't leave
// the upstream stream running. Returns a teardown fn the caller invokes on success.
//
// IMPORTANT: we listen on `res` (ServerResponse), not `req` (IncomingMessage). On
// Node's http server, `req.destroyed` becomes `true` and `req` emits `close` as
// soon as the request body is fully consumed — even while the client is still
// happily waiting for the response. Listening on `req.close` would therefore fire
// a false "client gone" the moment we finished reading the POST body and would
// kill the upstream stream before any chunk got out. `res.close` only fires when
// the underlying socket actually goes away.
//
// `clientGone(res)` is the corresponding "is the socket actually dead?" check
// used inside the SSE loops below; it must NOT consult req.destroyed for the same
// reason.
function wireClientCancel(res, upstreamRes) {
  if (!res || !upstreamRes?.body) return () => {};
  let cancelled = false;
  const onClose = () => {
    if (cancelled) return;
    cancelled = true;
    try { upstreamRes.body.cancel?.(); } catch { /* ignore */ }
  };
  res.once("close", onClose);
  return () => {
    cancelled = true;
    res.off("close", onClose);
  };
}

// True iff the response socket is gone — i.e. the client really disconnected.
// Use this in SSE loops instead of `req.destroyed`, which falsely turns true the
// moment the request body finishes streaming in.
//
// `res.destroyed` flips true on socket teardown. `res.closed` flips true when the
// underlying socket emits 'close'. We deliberately do NOT check `res.writableEnded`
// because that becomes true after our own `res.end()` call — and we don't want
// "we finished writing" to look like "client disappeared".
function clientGone(res) {
  return !!(res && (res.destroyed || res.closed));
}

// Backpressure-aware write. Honours res.write's false return by awaiting drain
// before resolving. Use in SSE loops so slow clients don't blow up memory.
function writeWithBackpressure(res, chunk) {
  if (res.write(chunk)) return;
  return new Promise((resolve) => res.once("drain", resolve));
}

async function readJsonBody(req, res) {
  let rawBody = "";
  for await (const chunk of req) rawBody += chunk;
  try {
    return JSON.parse(rawBody);
  } catch {
    sendJson(res, 400, { error: "Invalid JSON" });
    return null;
  }
}

async function sendUpstreamError(upstreamRes, res) {
  const errText = await upstreamRes.text();
  log.error(`[proxy] upstream error: ${upstreamRes.status} ${errText}`);
  if (!res.headersSent) {
    res.writeHead(upstreamRes.status, { "Content-Type": upstreamRes.headers.get("content-type") || "application/json" });
    res.end(errText);
  }
}

async function pipeResponsesStreamAndCapture(req, upstreamRes, res, onCompleted) {
  res.writeHead(upstreamRes.status, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const teardown = wireClientCancel(res, upstreamRes);
  let buffer = "";
  const decoder = new TextDecoder();

  const handleBlock = (block) => {
    const lines = block.split("\n");
    let eventType = "";
    const dataLines = [];

    for (const line of lines) {
      if (line.startsWith("event:")) eventType = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }

    const data = dataLines.join("\n");
    if (!data || data === "[DONE]") return;

    try {
      const parsed = JSON.parse(data);
      if (eventType === "response.completed" || parsed.type === "response.completed") {
        onCompleted(parsed.response || parsed);
      }
    } catch {
      // Ignore parse failures in streamed event capture; stream still passes through.
    }
  };

  try {
    for await (const chunk of upstreamRes.body) {
      if (clientGone(res)) break;
      await writeWithBackpressure(res, chunk);
      buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");

      let splitIdx;
      while ((splitIdx = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, splitIdx);
        buffer = buffer.slice(splitIdx + 2);
        handleBlock(block);
      }
    }

    if (buffer.trim()) handleBlock(buffer);
  } finally {
    teardown();
  }
  res.end();
}

async function forwardOpenAIResponses(req, body, res, originalInput, originalPreviousResponseId) {
  // OpenAI Responses API doesn't accept thinking:{type:"disabled"}; "none" means
  // strip the reasoning hint entirely. Other values pass through unchanged
  // (OpenAI accepts the same enum names: minimal/low/medium/high).
  const eff = body.reasoning?.effort;
  if (eff) {
    const e = String(eff).toLowerCase().trim();
    if (e === "none") delete body.reasoning;
    else if (e === "xhigh") body.reasoning = { ...body.reasoning, effort: "high" };
    // minimal / low / medium / high pass through.
  }

  const upstreamRes = await fetchWithTimeout(`${OPENAI_BASE}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!upstreamRes.ok) {
    await sendUpstreamError(upstreamRes, res);
    return;
  }

  if (body.stream) {
    await pipeResponsesStreamAndCapture(req, upstreamRes, res, (completedResponse) => {
      if (completedResponse?.id && Array.isArray(completedResponse.output)) {
        storeResponse(completedResponse.id, {
          provider: "openai",
          input: originalInput,
          output: completedResponse.output,
          previousResponseId: originalPreviousResponseId || null,
        });
      }
    });
    return;
  }

  const response = await upstreamRes.json();
  if (response?.id && Array.isArray(response.output)) {
    storeResponse(response.id, {
      provider: "openai",
      input: originalInput,
      output: response.output,
      previousResponseId: originalPreviousResponseId || null,
    });
  }
  sendJson(res, upstreamRes.status, response);
}

async function forwardOpenAIChatCompletions(req, body, res) {
  // Same effort normalisation as the responses path. Chat Completions uses the
  // flat `reasoning_effort` field; either form may arrive from callers.
  const eff = body.reasoning_effort || body.reasoning?.effort;
  if (eff) {
    const e = String(eff).toLowerCase().trim();
    delete body.reasoning_effort;
    delete body.reasoning;
    if (e === "none") {
      // Drop entirely — OpenAI doesn't support disabling thinking via a flag.
    } else if (e === "xhigh") {
      body.reasoning_effort = "high";
    } else {
      body.reasoning_effort = e;
    }
  }

  const upstreamRes = await fetchWithTimeout(`${OPENAI_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!upstreamRes.ok) {
    await sendUpstreamError(upstreamRes, res);
    return;
  }

  if (body.stream) {
    res.writeHead(upstreamRes.status, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const teardown = wireClientCancel(res, upstreamRes);
    try {
      for await (const chunk of upstreamRes.body) {
        if (clientGone(res)) break;
        await writeWithBackpressure(res, chunk);
      }
    } finally {
      teardown();
    }
    res.end();
    return;
  }

  const response = await upstreamRes.json();
  sendJson(res, upstreamRes.status, response);
}

// Run the model in a loop, feeding back any web_fetch tool_calls it makes until
// either (a) it stops requesting fetches, (b) it asks for the same URL twice in
// a row (stuck loop), or (c) MAX_FETCH_LOOPS is hit. Returns the final upstream
// chat-completions response with web_fetch tool_calls stripped from the message.
//
// `prefix` is just for log lines so callers can distinguish responses-path vs
// chat-completions-path output.
async function runWebFetchLoop({ baseRequest, initialMessages, upstreamUrl, upstreamKey, prefix = "" }) {
  let loopMessages = [...initialMessages];
  let finalCcResponse = null;
  let fetchLoopCount = 0;
  const fetchCache = new Map();
  let prevFetchUrls = "";
  const tag = prefix ? `${prefix}: ` : "";

  for (let loop = 0; loop <= MAX_FETCH_LOOPS; loop++) {
    const loopReq = { ...baseRequest, messages: loopMessages, stream: false };
    const upstreamRes = await fetchWithTimeout(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${upstreamKey}`,
      },
      body: JSON.stringify(loopReq),
    }, UPSTREAM_TIMEOUT);

    if (!upstreamRes.ok) {
      return { ok: false, errorRes: upstreamRes };
    }

    const ccResponse = await upstreamRes.json();
    const msg = ccResponse.choices?.[0]?.message;
    const webFetchCalls = (msg?.tool_calls || []).filter((tc) => tc.function?.name === "web_fetch");
    const currentFetchUrls = webFetchCalls.map((tc) => {
      try { return JSON.parse(tc.function.arguments).url; }
      catch { return ""; }
    }).sort().join("|");
    const isStuckLoop = webFetchCalls.length > 0 && currentFetchUrls === prevFetchUrls;

    if (webFetchCalls.length === 0 || loop === MAX_FETCH_LOOPS || isStuckLoop) {
      if (isStuckLoop) {
        log.warn(`[proxy] ${tag}web_fetch loop stuck — model re-requested same URL(s), breaking early at loop ${loop + 1}`);
      }
      if (loop === MAX_FETCH_LOOPS && webFetchCalls.length > 0) {
        log.warn(`[proxy] ${tag}web_fetch MAX_FETCH_LOOPS (${MAX_FETCH_LOOPS}) exhausted — stripping remaining fetches`);
      }
      if (msg?.tool_calls) {
        msg.tool_calls = msg.tool_calls.filter((tc) => tc.function?.name !== "web_fetch");
        if (msg.tool_calls.length === 0) {
          delete msg.tool_calls;
          if (ccResponse.choices[0].finish_reason === "tool_calls") {
            ccResponse.choices[0].finish_reason = "stop";
          }
        }
      }
      finalCcResponse = ccResponse;
      fetchLoopCount = loop;
      break;
    }

    prevFetchUrls = currentFetchUrls;
    log.info(`[proxy] ${tag}executing ${webFetchCalls.length} web_fetch call(s) (loop ${loop + 1}/${MAX_FETCH_LOOPS})`);
    const results = await Promise.all(webFetchCalls.map(async (tc) => {
      const fetchUrl = (() => {
        try { return JSON.parse(tc.function.arguments).url; }
        catch { return "unknown"; }
      })();
      if (fetchCache.has(fetchUrl)) {
        log.info(`[proxy] ${tag}web_fetch ${fetchUrl} -> ${fetchCache.get(fetchUrl).length} chars (cached)`);
        return { role: "tool", tool_call_id: tc.id, content: fetchCache.get(fetchUrl) };
      }
      const content = await executeWebFetch(tc.function.arguments);
      fetchCache.set(fetchUrl, content);
      log.info(`[proxy] ${tag}web_fetch ${fetchUrl} -> ${content.length} chars`);
      return { role: "tool", tool_call_id: tc.id, content };
    }));

    loopMessages = [
      ...loopMessages,
      { role: "assistant", content: null, tool_calls: webFetchCalls },
      ...results,
    ];
  }

  if (fetchLoopCount > 0) {
    log.info(`[proxy] ${tag}web_fetch resolved after ${fetchLoopCount} loop(s)`);
  }
  return { ok: true, response: finalCcResponse };
}

// --- OAI-compatible handlers (DeepSeek, MiMo, ...) ---

async function handleOaiCompatResponses(req, provider, body, res, originalInput) {
  const cfg = OAI_COMPAT_PROVIDERS[provider];
  if (!cfg || !cfg.key) {
    sendJson(res, 400, { error: { message: `${cfg?.envKey || provider.toUpperCase() + "_API_KEY"} is not configured` } });
    return;
  }

  const originalPreviousResponseId = body.previous_response_id || null;
  maybeResolvePreviousResponseChain(body, provider);

  if (originalPreviousResponseId) {
    const prevStored = touchResponse(originalPreviousResponseId);
    const consecutiveTc = prevStored?.consecutiveToolCalls || 0;
    if (consecutiveTc >= MAX_CONSECUTIVE_TOOL_CALLS) {
      log.warn(`[proxy] CIRCUIT BREAKER: ${consecutiveTc} consecutive tool-call-only responses detected — injecting stop-loop nudge`);
      const nudge = {
        type: "message",
        role: "user",
        content: [{
          type: "input_text",
          text: `[SYSTEM: You have made ${consecutiveTc} consecutive tool calls without responding to the user. You MUST now stop making tool calls and provide a text response summarizing your progress, findings, and any remaining work. Do NOT make any more tool calls in this response.]`,
        }],
      };
      const currentInput = normalizeInputToArray(body.input);
      body.input = [...currentInput, nudge];
    } else if (consecutiveTc >= Math.floor(MAX_CONSECUTIVE_TOOL_CALLS * 0.75)) {
      log.warn(`[proxy] tool-call loop warning: ${consecutiveTc}/${MAX_CONSECUTIVE_TOOL_CALLS} consecutive tool-call responses`);
    }
  }

  const chatReq = responsesRequestToChatCompletions(body, provider);
  chatReq.model = modelForProvider(cfg, chatReq.model);
  const useModel = chatReq.model;
  const isStream = chatReq.stream;

  const upstreamUrl = `${cfg.base}/chat/completions`;
  const upstreamKey = cfg.key;
  const routeLabel = `${provider}(${chatReq.model})`;

  let hardBreakerFired = false;
  if (originalPreviousResponseId) {
    const prevStored = touchResponse(originalPreviousResponseId);
    const consecutiveTc = prevStored?.consecutiveToolCalls || 0;
    if (consecutiveTc >= MAX_CONSECUTIVE_TOOL_CALLS + 3) {
      log.warn("[proxy] HARD CIRCUIT BREAKER: stripping all tools to force text response");
      delete chatReq.tools;
      delete chatReq.tool_choice;
      hardBreakerFired = true;
    }
  }

  const hasConversationUrls = conversationHasUrls(chatReq.messages);
  if (hasConversationUrls) {
    chatReq.tools = ensureWebFetchTool(chatReq.tools);
    chatReq.messages = ensureWebFetchHint(chatReq.messages);
  }

  log.info(
    `[proxy] ${routeLabel} | stream=${isStream} | messages=${chatReq.messages.length}${hasConversationUrls ? " | web_fetch_injected" : ""} | roles=[${chatReq.messages.map((m) => m.role + (m.tool_calls ? "(tc)" : "")).join(",")}]`
  );

  if (hasConversationUrls) {
    const result = await runWebFetchLoop({
      baseRequest: chatReq,
      initialMessages: chatReq.messages,
      upstreamUrl,
      upstreamKey,
      prefix: "",
    });
    if (!result.ok) {
      await sendUpstreamError(result.errorRes, res);
      return;
    }
    const responsesResponse = chatCompletionToResponse(result.response, useModel, originalPreviousResponseId, body.metadata);
    storeResponse(responsesResponse.id, {
      provider,
      input: originalInput,
      output: responsesResponse.output,
      previousResponseId: originalPreviousResponseId,
      breakerFired: hardBreakerFired,
      reasoningContent: result.response?.choices?.[0]?.message?.reasoning_content || "",
    });

    if (isStream) await sendResponseAsStream(res, responsesResponse, req);
    else sendJson(res, 200, responsesResponse);
    return;
  }

  const upstreamRes = await fetchWithTimeout(upstreamUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${upstreamKey}`,
    },
    body: JSON.stringify(chatReq),
  });

  if (!upstreamRes.ok) {
    await sendUpstreamError(upstreamRes, res);
    return;
  }

  if (isStream) {
    const { responseId: streamRespId, output: streamOutput, reasoningContent: streamReasoning } = await handleStreamingResponse(
      req,
      upstreamRes,
      res,
      useModel,
      originalPreviousResponseId,
      body.metadata
    );
    storeResponse(streamRespId, {
      provider,
      input: originalInput,
      output: streamOutput,
      previousResponseId: originalPreviousResponseId,
      breakerFired: hardBreakerFired,
      reasoningContent: streamReasoning || "",
    });
    return;
  }

  const ccResponse = await upstreamRes.json();
  const responsesResponse = chatCompletionToResponse(ccResponse, useModel, originalPreviousResponseId, body.metadata);
  const nonStreamReasoning = ccResponse.choices?.[0]?.message?.reasoning_content || "";
  storeResponse(responsesResponse.id, {
    provider,
    input: originalInput,
    output: responsesResponse.output,
    reasoningContent: nonStreamReasoning,
    previousResponseId: originalPreviousResponseId,
    breakerFired: hardBreakerFired,
  });
  sendJson(res, 200, responsesResponse);
}

async function handleOaiCompatChatCompletions(req, provider, body, res) {
  const cfg = OAI_COMPAT_PROVIDERS[provider];
  if (!cfg || !cfg.key) {
    sendJson(res, 400, { error: { message: `${cfg?.envKey || provider.toUpperCase() + "_API_KEY"} is not configured` } });
    return;
  }

  body.model = modelForProvider(cfg, body.model);
  const isStream = body.stream || false;

  const validated = normalizeMessages(body.messages || [], { coerceStrings: true });
  body.messages = validated;
  if (!body.max_tokens) body.max_tokens = 16384;

  // Translate effort hints on the chat/completions path too. Either:
  //   - body.reasoning_effort (Chat Completions native field)
  //   - body.reasoning?.effort (Responses-style field, in case caller mixes them)
  // are normalised through the same per-provider translator that the responses path uses.
  const ccEffort = body.reasoning_effort || body.reasoning?.effort;
  if (ccEffort) {
    delete body.reasoning_effort;
    delete body.reasoning;
    applyEffortTranslation(body, ccEffort, provider);
  }

  const ccHasUrls = conversationHasUrls(validated);

  if (ccHasUrls) {
    body.tools = ensureWebFetchTool(body.tools);
    body.messages = ensureWebFetchHint(body.messages);
  }

  log.info(`[proxy] chat/completions ${provider}(${body.model}) | stream=${isStream} | messages=${body.messages.length}${ccHasUrls ? " | web_fetch_injected" : ""} | roles=[${body.messages.map((m) => m.role + (m.tool_calls ? "(tc)" : "")).join(",")}]`);

  if (ccHasUrls) {
    const result = await runWebFetchLoop({
      baseRequest: body,
      initialMessages: body.messages,
      upstreamUrl: `${cfg.base}/chat/completions`,
      upstreamKey: cfg.key,
      prefix: "cc",
    });
    if (!result.ok) {
      await sendUpstreamError(result.errorRes, res);
      return;
    }
    const finalCcResponse = result.response;

    if (isStream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const msg = finalCcResponse.choices?.[0]?.message;
      if (msg?.tool_calls) {
        for (let i = 0; i < msg.tool_calls.length; i++) {
          const tc = msg.tool_calls[i];
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.function.name, arguments: "" } }] } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: tc.function.arguments } }] } }] })}\n\n`);
        }
      }
      if (msg?.content) {
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: msg.content } }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finalCcResponse.choices[0].finish_reason }], usage: finalCcResponse.usage })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    sendJson(res, 200, finalCcResponse);
    return;
  }

  const upstreamRes = await fetchWithTimeout(`${cfg.base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.key}`,
    },
    body: JSON.stringify(body),
  });

  if (!upstreamRes.ok) {
    await sendUpstreamError(upstreamRes, res);
    return;
  }

  if (isStream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const teardown = wireClientCancel(res, upstreamRes);
    try {
      for await (const chunk of upstreamRes.body) {
        if (clientGone(res)) break;
        await writeWithBackpressure(res, chunk);
      }
    } finally {
      teardown();
    }
    res.end();
    return;
  }

  const data = await upstreamRes.json();
  sendJson(res, 200, data);
}

// --- Admin dashboard HTML (served at /admin/) ---

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Codex Bridge</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0d1117;color:#c9d1d9;padding:24px;font-size:14px;min-height:100vh}
header{display:flex;align-items:center;gap:12px;margin-bottom:24px}
header h1{font-size:20px;font-weight:600;color:#f0f6fc}
.status-dot{width:10px;height:10px;border-radius:50%;display:inline-block;flex-shrink:0}
.status-dot.running{background:#3fb950;box-shadow:0 0 8px #3fb95080}
.status-dot.stopped{background:#f85149;box-shadow:0 0 8px #f8514980}
.status-dot.connecting{background:#d29922;box-shadow:0 0 8px #d2992280}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:24px}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px}
.card .label{font-size:12px;color:#8b949e;margin-bottom:4px}
.card .value{font-size:24px;font-weight:600;color:#f0f6fc}
.card .sub{font-size:12px;color:#8b949e;margin-top:4px}
.section{margin-bottom:24px}
.section h2{font-size:16px;font-weight:600;color:#f0f6fc;margin-bottom:12px}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:8px 12px;border-bottom:1px solid #21262d;font-size:13px}
th{color:#8b949e;font-weight:500;font-size:12px;text-transform:uppercase;letter-spacing:.5px;border-bottom-color:#30363d}
td{color:#c9d1d9;font-family:ui-monospace,SFMono-Regular,SF Mono,Menlo,Consolas,monospace;font-size:12px}
.badge{display:inline-block;padding:1px 7px;border-radius:12px;font-size:11px;font-weight:500}
.badge.deepseek{background:#1f6feb33;color:#58a6ff}
.badge.mimo{background:#d2a8ff33;color:#bc8cff}
.badge.openai{background:#3fb95033;color:#3fb950}
.providers{display:flex;gap:12px;flex-wrap:wrap}
.provider-card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:12px 16px;min-width:150px}
.provider-card .name{font-size:13px;font-weight:500;color:#f0f6fc;margin-bottom:4px}
.provider-card .status{font-size:12px}
.log-container{background:#0d1117;border:1px solid #30363d;border-radius:8px;height:280px;overflow-y:auto;padding:12px;font-family:ui-monospace,SFMono-Regular,SF Mono,Menlo,Consolas,monospace;font-size:12px;line-height:1.5}
.log-container .entry{white-space:pre-wrap;word-break:break-all;-webkit-user-select:text;user-select:text;cursor:text}
.log-container .level-info{color:#c9d1d9}
.log-container .level-warn{color:#d29922}
.log-container .level-error{color:#f85149}
.log-container .level-access{color:#58a6ff}
.log-container .level-debug{color:#8b949e}
.log-container .time{color:#8b949e;margin-right:8px}
.config-editor textarea{width:100%;height:360px;background:#0d1117;border:1px solid #30363d;border-radius:8px;color:#c9d1d9;font-family:ui-monospace,SFMono-Regular,SF Mono,Menlo,Consolas,monospace;font-size:13px;padding:12px;resize:vertical;tab-size:2}
.config-editor button,.pf-save{background:#238636;color:#fff;border:none;border-radius:6px;padding:8px 16px;font-size:14px;cursor:pointer}
.config-editor button:hover,.pf-save:hover{background:#2ea043}
.config-editor button:disabled,.pf-save:disabled{opacity:.5;cursor:not-allowed}
.config-editor button.secondary,.pf-btn-secondary{background:#21262d;color:#c9d1d9}
.config-editor button.secondary:hover,.pf-btn-secondary:hover{background:#30363d}
.pf-btn{background:#238636;color:#fff;border:none;border-radius:6px;padding:6px 14px;font-size:13px;cursor:pointer}
.pf-btn:hover{background:#2ea043}
.error{color:#f85149;font-size:13px;margin-top:8px}
.success{color:#3fb950;font-size:13px;margin-top:8px}

.provider-card{background:#161b22;border:1px solid #30363d;border-radius:8px;margin-bottom:8px;overflow:hidden}
.pc-header{display:flex;align-items:center;gap:8px;padding:10px 14px;cursor:pointer;user-select:none}
.pc-header:hover{background:#1c2128}
.pc-chevron{font-size:11px;color:#8b949e;transition:transform .15s}
.provider-card.expanded .pc-chevron{transform:rotate(90deg)}
.pc-icon{width:22px;height:22px;border-radius:5px;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:#fff;flex-shrink:0}
.pc-icon-deepseek{background:#1f6feb}
.pc-icon-mimo{background:#a371f7}
.pc-icon-openai{background:#238636}
.pc-title{font-size:14px;font-weight:500;color:#f0f6fc;flex:1}
.pc-status{font-size:12px;padding:2px 8px;border-radius:10px}
.pc-status.on{background:#3fb95022;color:#3fb950}
.pc-status.off{background:#8b949e22;color:#8b949e}
.pc-body{padding:0 14px 14px;display:none}
.provider-card.expanded .pc-body{display:block}
.pf-field{margin-bottom:10px}
.pf-field label{display:block;font-size:12px;color:#8b949e;margin-bottom:3px}
.pf-label-row{display:flex;align-items:center;gap:8px;margin-bottom:3px}
.pf-label-row label{margin-bottom:0}
.pf-reset{background:0;border:none;color:#58a6ff;font-size:11px;cursor:pointer;padding:0}
.pf-reset:hover{text-decoration:underline}
.pf-input{width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:7px 10px;font-family:inherit}
.pf-input:focus{outline:0;border-color:#1f6feb}
.pf-field-row{display:flex;gap:12px}
.pf-textarea{width:100%;height:200px;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-family:ui-monospace,SFMono-Regular,SF Mono,Menlo,Consolas,monospace;font-size:13px;padding:10px;resize:vertical;tab-size:2;margin-top:8px}
.pf-advanced summary{cursor:pointer;color:#8b949e;font-size:13px;padding:4px 0}
.pf-advanced summary:hover{color:#c9d1d9}
.tabs{display:flex;gap:2px;margin-bottom:16px;border-bottom:1px solid #30363d}
.tab{padding:8px 16px;font-size:13px;cursor:pointer;color:#8b949e;border:1px solid transparent;border-radius:6px 6px 0 0;margin-bottom:-1px;user-select:none}
.tab:hover{color:#c9d1d9}
.tab.active{color:#f0f6fc;border-color:#30363d;border-bottom-color:#0d1117;background:#0d1117}
.tab-content{display:none}
.tab-content.active{display:block}
</style>
</head>
<body>
<header>
<span class="status-dot connecting" id="statusDot"></span>
<h1>Codex Bridge</h1>
<span id="subtitle" style="color:#8b949e;font-size:13px">connecting...</span>
</header>
<div class="tabs">
<div class="tab active" data-tab="overview">概览</div>
<div class="tab" data-tab="requests">请求</div>
<div class="tab" data-tab="config">配置</div>
</div>
<div class="tab-content active" id="tab-overview">
<div class="cards">
<div class="card"><div class="label">状态</div><div class="value" id="stat-status">-</div></div>
<div class="card"><div class="label">运行时间</div><div class="value" id="stat-uptime">-</div></div>
<div class="card"><div class="label">总请求</div><div class="value" id="stat-total">-</div></div>
<div class="card"><div class="label">已启用供应商</div><div class="value" id="stat-providers">-</div>
<div class="sub" id="stat-providers-sub" style="font-size:12px;color:#8b949e;margin-top:4px"></div></div>
</div>
<div class="section">
<h2>供应商</h2>
<div class="providers" id="providers"></div>
</div>
<div class="section">
<h2>实时日志</h2>
<div class="log-container" id="logContainer"><!--LOGS--></div>
</div>
</div>
<div class="tab-content" id="tab-requests">
<div class="cards" style="grid-template-columns:repeat(auto-fit,minmax(120px,1fr))">
<div class="card"><div class="label">2xx</div><div class="value" id="stat-2xx">-</div></div>
<div class="card"><div class="label">4xx</div><div class="value" id="stat-4xx">-</div></div>
<div class="card"><div class="label">5xx</div><div class="value" id="stat-5xx">-</div></div>
</div>
<div class="section">
<h2>按端点</h2>
<table><thead><tr><th>端点</th><th>次数</th></tr></thead><tbody id="endpointTable"></tbody></table>
</div>
<div class="section">
<h2>按供应商</h2>
<table><thead><tr><th>供应商</th><th>次数</th></tr></thead><tbody id="providerTable"></tbody></table>
</div>
<div class="section">
<h2>最近请求</h2>
<table><thead><tr><th>时间</th><th>端点</th><th>供应商</th><th>状态</th><th>耗时</th></tr></thead><tbody id="recentTable"></tbody></table>
</div>
</div>
<div class="tab-content" id="tab-config">
<div class="section">
<h2>供应商设置</h2>

<div class="provider-card" id="pc-deepseek">
<div class="pc-header" onclick="togglePC('deepseek')">
<span class="pc-chevron">▶</span>
<span class="pc-icon pc-icon-deepseek">D</span>
<span class="pc-title">DeepSeek</span>
<span class="pc-status off" id="st-deepseek">未配置</span>
</div>
<div class="pc-body">
<div class="pf-field">
<label>API Key</label>
<input type="password" id="ds-key" placeholder="sk-..." class="pf-input" oninput="updateStatus('deepseek')">
</div>
<div class="pf-field">
<div class="pf-label-row">
<label>Base URL</label>
<button class="pf-reset" id="r-ds-base" style="display:none" onclick="resetPC('ds-base','https://api.deepseek.com/v1')">恢复默认</button>
</div>
<input type="text" id="ds-base" value="https://api.deepseek.com/v1" class="pf-input" oninput="showPCR('ds-base','https://api.deepseek.com/v1')">
</div>
<div class="pf-field">
<div class="pf-label-row">
<label>模型</label>
<button class="pf-reset" id="r-ds-models" style="display:none" onclick="resetPC('ds-models','deepseek-v4-pro,deepseek-v4-flash')">恢复默认</button>
</div>
<input type="text" id="ds-models" value="deepseek-v4-pro,deepseek-v4-flash" class="pf-input" oninput="showPCR('ds-models','deepseek-v4-pro,deepseek-v4-flash')">
</div>
</div>
</div>

<div class="provider-card" id="pc-mimo">
<div class="pc-header" onclick="togglePC('mimo')">
<span class="pc-chevron">▶</span>
<span class="pc-icon pc-icon-mimo">M</span>
<span class="pc-title">小米 MiMo</span>
<span class="pc-status off" id="st-mimo">未配置</span>
</div>
<div class="pc-body">
<div class="pf-field">
<label>API Key</label>
<input type="password" id="mm-key" placeholder="sk-..." class="pf-input" oninput="updateStatus('mimo')">
</div>
<div class="pf-field">
<div class="pf-label-row">
<label>Base URL</label>
<button class="pf-reset" id="r-mm-base" style="display:none" onclick="resetPC('mm-base','https://token-plan-cn.xiaomimimo.com/v1')">恢复默认</button>
</div>
<input type="text" id="mm-base" value="https://token-plan-cn.xiaomimimo.com/v1" class="pf-input" oninput="showPCR('mm-base','https://token-plan-cn.xiaomimimo.com/v1')">
</div>
<div class="pf-field">
<div class="pf-label-row">
<label>模型</label>
<button class="pf-reset" id="r-mm-models" style="display:none" onclick="resetPC('mm-models','mimo-v2.5-pro')">恢复默认</button>
</div>
<input type="text" id="mm-models" value="mimo-v2.5-pro" class="pf-input" oninput="showPCR('mm-models','mimo-v2.5-pro')">
</div>
</div>
</div>

<div class="provider-card" id="pc-openai">
<div class="pc-header" onclick="togglePC('openai')">
<span class="pc-chevron">▶</span>
<span class="pc-icon pc-icon-openai">O</span>
<span class="pc-title">OpenAI</span>
<span class="pc-status off" id="st-openai">未配置</span>
</div>
<div class="pc-body">
<div class="pf-field">
<label>API Key</label>
<input type="password" id="oa-key" placeholder="sk-..." class="pf-input" oninput="updateStatus('openai')">
</div>
<div class="pf-field">
<div class="pf-label-row">
<label>Base URL</label>
<button class="pf-reset" id="r-oa-base" style="display:none" onclick="resetPC('oa-base','https://api.openai.com/v1')">恢复默认</button>
</div>
<input type="text" id="oa-base" value="https://api.openai.com/v1" class="pf-input" oninput="showPCR('oa-base','https://api.openai.com/v1')">
</div>
<div class="pf-field">
<div class="pf-label-row">
<label>模型</label>
<button class="pf-reset" id="r-oa-models" style="display:none" onclick="resetPC('oa-models','gpt-4o')">恢复默认</button>
</div>
<input type="text" id="oa-models" value="gpt-4o" class="pf-input" oninput="showPCR('oa-models','gpt-4o')">
</div>
</div>
</div>

<h2 style="margin-top:24px">代理设置</h2>

<div class="pf-field">
<label>默认供应商</label>
<select id="default-provider" class="pf-input">
<option value="">自动</option>
<option value="deepseek">DeepSeek</option>
<option value="mimo">MiMo</option>
<option value="openai">OpenAI</option>
</select>
</div>

<div class="pf-field-row">
<div class="pf-field" style="flex:0 0 100px">
<label>端口</label>
<input type="text" id="proxy-port" value="4000" class="pf-input">
</div>
<div class="pf-field" style="flex:1">
<label>鉴权密钥</label>
<input type="password" id="auth-key" placeholder="留空 = 无鉴权" class="pf-input">
</div>
</div>

<div style="display:flex;gap:8px;align-items:center;margin-top:16px">
<button id="saveSettings" class="pf-save">保存并重启代理</button>
<span id="settingsMsg"></span>
</div>

<details class="pf-advanced" style="margin-top:20px">
<summary>高级：直接编辑 .env</summary>
<textarea id="configEditor" class="pf-textarea" spellcheck="false"></textarea>
<div style="display:flex;gap:8px;align-items:center;margin-top:6px">
<button id="saveConfig" class="pf-btn">保存</button>
<button id="reloadConfig" class="pf-btn pf-btn-secondary">重新加载</button>
<span id="configMsg"></span>
</div>
</details>
</div>
</div>
<script>
(function(){
  var $=function(id){return document.getElementById(id)};
  function xhrGet(url,ok,err){var x=new XMLHttpRequest();x.open('GET',url,true);x.onload=function(){if(x.status===200)ok(x.responseText);else if(err)err()};x.onerror=function(){if(err)err()};x.send()}
  function xhrPut(url,body,ok,err){var x=new XMLHttpRequest();x.open('PUT',url,true);x.setRequestHeader('Content-Type','application/json');x.onload=function(){if(x.status===200)ok();else if(err)err()};x.onerror=function(){if(err)err()};x.send(JSON.stringify(body))}
  function xhrPost(url,body,ok,err){var x=new XMLHttpRequest();x.open('POST',url,true);x.setRequestHeader('Content-Type','application/json');x.onload=function(){if(x.status===200)ok();else if(err)err()};x.onerror=function(){if(err)err()};x.send(JSON.stringify(body||{}))}
  function esc(s){return String(s).replace(/[<>&"]/g,function(c){return '&#'+c.charCodeAt(0)+';'})}
  function ago(ms){var s=Math.floor(ms/1000);if(s<60)return s+'s';if(s<3600)return Math.floor(s/60)+'m '+s%60+'s';return Math.floor(s/3600)+'h '+Math.floor((s%3600)/60)+'m'}
  function fmtTime(d){return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')+':'+String(d.getSeconds()).padStart(2,'0')}

  function render(d){
    setText('stat-total',d.total);setText('stat-uptime',ago(d.uptime));
    setText('stat-2xx',d.byStatus['2xx']||0);setText('stat-4xx',d.byStatus['4xx']||0);setText('stat-5xx',d.byStatus['5xx']||0);
    setText('stat-status','运行中');setText('subtitle',':'+d.port);
    var dot=$('statusDot');if(dot)dot.className='status-dot running';
    setHtml('endpointTable',Object.entries(d.byEndpoint).map(function(kv){return '<tr><td>'+esc(kv[0])+'</td><td>'+kv[1]+'</td></tr>'}).join(''));
    setHtml('providerTable',Object.entries(d.byProvider).map(function(kv){return '<tr><td><span class="badge '+esc(kv[0])+'">'+esc(kv[0])+'</span></td><td>'+kv[1]+'</td></tr>'}).join(''));
    setHtml('recentTable',d.recentRequests.map(function(r){return '<tr><td>'+fmtTime(new Date(r.time))+'</td><td>'+esc(r.endpoint)+'</td><td><span class="badge '+(r.provider||'')+'">'+esc(r.provider||'-')+'</span></td><td>'+r.statusCode+'</td><td>'+(r.durationMs||'-')+'ms</td></tr>'}).join(''));
    // Enabled providers count
    var ep=d.enabledProviders||[];var pc=d.providerConfigs||{};
    setText('stat-providers',ep.length);
    var sub=ep.map(function(n){var known={deepseek:'DeepSeek',mimo:'MiMo',openai:'OpenAI'};return (known[n]||n)}).join(', ');
    setText('stat-providers-sub',sub||'无');
    // Provider cards in overview
    var pd=$('providers');if(pd){
      var names=Object.keys(pc);var known={deepseek:'DeepSeek',mimo:'MiMo',openai:'OpenAI'};
      pd.innerHTML=names.length?names.map(function(n){
        var cfg=pc[n];var ok=cfg&&cfg.configured;
        var label=(known[n]||n);var statusHtml=ok?'<span style="color:#3fb950">&#x2713; 已配置</span>':'<span style="color:#8b949e">&#x2014; 未配置</span>';
        var modelsHtml=ok?'<span style="color:#8b949e;font-size:11px">'+esc((cfg.models||[]).join(', '))+'</span>':'';
        var count=d.byProvider[n]||0;
        return '<div class="provider-card"><div class="name">'+label+'</div><div class="status" style="font-size:12px">'+statusHtml+'</div><div style="margin-top:2px">'+modelsHtml+'</div><div style="margin-top:2px;font-size:11px;color:#8b949e">'+count+' 请求</div></div>';
      }).join('') : '<div class="provider-card"><div class="name" style="color:#8b949e">暂无供应商</div></div>';
    }
  }
  function setText(id,v){var e=$(id);if(e)e.textContent=v!=null?v:'-';}
  function setHtml(id,h){var e=$(id);if(e)e.innerHTML=h||'';}

  function fetchStatus(){
    xhrGet('/admin/api/status',
      function(t){try{render(JSON.parse(t))}catch(_){}},
      function(){setText('stat-status','等待连接');setText('subtitle','等待代理...');var dot=$('statusDot');if(dot)dot.className='status-dot connecting'}
    );
  }

  function pollLogs(){
    var c=$('logContainer');if(!c)return;
    var lastTs=0;
    for(var i=0;i<c.children.length;i++){
      var ts=c.children[i].getAttribute && parseInt(c.children[i].getAttribute('data-ts'),10);
      if(ts>lastTs)lastTs=ts;
    }
    setInterval(function(){
      var x=new XMLHttpRequest();
      x.open('GET','/admin/api/logs-recent',true);
      x.onload=function(){
        if(x.status!==200)return;
        try{
          var entries=JSON.parse(x.responseText);
          if(!entries||!entries.length)return;
          for(var i=0;i<entries.length;i++){
            var d=entries[i];
            if(d.ts<=lastTs)continue;
            lastTs=d.ts;
            var div=document.createElement('div');div.className='entry';div.setAttribute('data-ts',d.ts);
            div.innerHTML='<span class="time">'+fmtTime(new Date(d.ts))+'</span><span class="level-'+d.level+'">'+esc(d.msg)+'</span>';
            c.appendChild(div);
          }
          c.scrollTop=c.scrollHeight;
          while(c.children.length>500)c.removeChild(c.firstChild);
        }catch(_){}
      };
      x.send();
    },1500);
  }

  // --- Provider card UI ---
  function togglePC(name){
    var card=$('pc-'+name);
    if(card)card.classList.toggle('expanded');
  }

  function showPCR(id,def){
    var r=$('r-'+id);
    var e=$(id);
    if(r&&e)r.style.display=e.value!==def?'':'none';
  }

  function resetPC(id,def){
    var e=$(id);if(e)e.value=def;
    showPCR(id,def);
  }

  function updateStatus(name){
    var key={'deepseek':'ds','mimo':'mm','openai':'oa'}[name];
    var e=$(key+'-key');
    var st=$('st-'+name);
    if(!e||!st)return;
    if(e.value.trim()){
      st.textContent='\u5df2\u914d\u7f6e';
      st.className='pc-status on';
    }else{
      st.textContent='\u672a\u914d\u7f6e';
      st.className='pc-status off';
    }
  }

  function parseEnv(text){
    var map={};
    text.split('\n').forEach(function(line){
      var m=line.match(/^\s*([\w_]+)\s*=\s*(.*?)\s*$/);
      if(m)map[m[1]]=m[2];
    });
    return map;
  }

  function loadStructuredConfig(){
    xhrGet('/admin/api/config',
      function(t){
        try{var d=JSON.parse(t)}catch(_){return}
        var e=$('configEditor');if(e)e.value=d.content;
        var env=parseEnv(d.content);

      function setVal(id,key,fallback){
        var el=$(id);if(el)el.value=env[key]||fallback;
      }

      // DeepSeek
      var dsKeyEl=$('ds-key');if(dsKeyEl)dsKeyEl.value=env['DEEPSEEK_API_KEY']||env['MY_DS_KEY']||'';
      var dsBase=env['DEEPSEEK_BASE_URL']||env['DEEPSEEK_API_BASE']||'https://api.deepseek.com/v1';
      var dsEl=$('ds-base');if(dsEl)dsEl.value=dsBase;
      setVal('ds-models','DEEPSEEK_MODELS','deepseek-v4-pro,deepseek-v4-flash');

      // MiMo
      setVal('mm-key','MIMO_API_KEY','');
      setVal('mm-base','MIMO_BASE_URL','https://token-plan-cn.xiaomimimo.com/v1');
      setVal('mm-models','MIMO_MODELS','mimo-v2.5-pro');

      // OpenAI
      setVal('oa-key','OPENAI_API_KEY','');
      setVal('oa-base','OPENAI_BASE_URL','https://api.openai.com/v1');
      setVal('oa-models','OPENAI_MODELS','gpt-4o');

      // Server
      setVal('default-provider','DEFAULT_PROVIDER','');
      setVal('proxy-port','PROXY_PORT','4000');
      setVal('auth-key','PROXY_AUTH_KEY','');

      updateStatus('deepseek');updateStatus('mimo');updateStatus('openai');
      showPCR('ds-base','https://api.deepseek.com/v1');
      showPCR('ds-models','deepseek-v4-pro,deepseek-v4-flash');
      showPCR('mm-base','https://token-plan-cn.xiaomimimo.com/v1');
      showPCR('mm-models','mimo-v2.5-pro');
      showPCR('oa-base','https://api.openai.com/v1');
      showPCR('oa-models','gpt-4o');
    },
    function(){var m=$('settingsMsg');if(m){m.textContent='\u52a0\u8f7d\u5931\u8d25';m.className='error'}}
  );
  }

  function buildEnv(){
    var lines=[
      '# Codex Bridge Configuration',
      '# Auto-generated. Edit via the Settings panel.',
      '',
    ];
    function add(k,v){if(v.trim())lines.push(k+'='+v.trim())}

    var dsKey=$('ds-key');if(dsKey)add('DEEPSEEK_API_KEY',dsKey.value);
    var dsBase=$('ds-base');if(dsBase&&dsKey&&dsKey.value.trim())add('DEEPSEEK_BASE_URL',dsBase.value);
    var dsModels=$('ds-models');if(dsModels&&dsKey&&dsKey.value.trim())add('DEEPSEEK_MODELS',dsModels.value);

    var mmKey=$('mm-key');if(mmKey)add('MIMO_API_KEY',mmKey.value);
    var mmBase=$('mm-base');if(mmBase&&mmKey&&mmKey.value.trim())add('MIMO_BASE_URL',mmBase.value);
    var mmModels=$('mm-models');if(mmModels&&mmKey&&mmKey.value.trim())add('MIMO_MODELS',mmModels.value);

    var oaKey=$('oa-key');if(oaKey)add('OPENAI_API_KEY',oaKey.value);
    var oaBase=$('oa-base');if(oaBase&&oaKey&&oaKey.value.trim())add('OPENAI_BASE_URL',oaBase.value);
    var oaModels=$('oa-models');if(oaModels&&oaKey&&oaKey.value.trim())add('OPENAI_MODELS',oaModels.value);

    var dp=$('default-provider');if(dp)add('DEFAULT_PROVIDER',dp.value);
    var pp=$('proxy-port');if(pp)add('PROXY_PORT',pp.value);
    var ak=$('auth-key');if(ak)add('PROXY_AUTH_KEY',ak.value);

    // All keys handled by form fields (even if empty — user intentionally cleared them)
    var formKeys=['DEEPSEEK_API_KEY','MY_DS_KEY','DEEPSEEK_BASE_URL','DEEPSEEK_MODELS','MIMO_API_KEY','MIMO_BASE_URL','MIMO_MODELS','OPENAI_API_KEY','OPENAI_BASE_URL','OPENAI_MODELS','DEFAULT_PROVIDER','PROXY_PORT','PROXY_AUTH_KEY'];

    // Preserve unknown keys from the raw editor
    var raw=$('configEditor');
    if(raw){
      raw.value.split('\n').forEach(function(line){
        var m=line.match(/^\s*([\w_]+)\s*=/);
        if(m&&formKeys.indexOf(m[1])===-1)lines.push(line);
      });
    }

    lines.push('');
    return lines.join('\n');
  }

  function loadConfig(){
    xhrGet('/admin/api/config',
      function(t){try{var d=JSON.parse(t);var e=$('configEditor');if(e)e.value=d.content}catch(_){}},
      function(){var m=$('configMsg');if(m){m.textContent='\u52a0\u8f7d\u5931\u8d25';m.className='error'}}
    );
  }

  function init(){
    // Save structured settings
    var ss=$('saveSettings');if(ss)ss.onclick=function(){
      ss.disabled=true;var m=$('settingsMsg');if(m){m.textContent='';m.className=''}
      var content=buildEnv();
      xhrPut('/admin/api/config',{content:content},
        function(){
          if(m){m.textContent='\u5df2\u4fdd\u5b58\uFF0C\u6B63\u5728\u91CD\u542F...';m.className='success'}
          var e=$('configEditor');if(e)e.value=content;
          // Trigger restart — proxy will exit, macOS app will restart it
          xhrPost('/admin/api/restart',{},
            function(){},
            function(){if(m){m.textContent='\u91CD\u542F\u5931\u8D25';m.className='error'};ss.disabled=false}
          );
        },
        function(){if(m){m.textContent='\u4fdd\u5b58\u5931\u8d25';m.className='error'};ss.disabled=false}
      );
    };

    // Raw .env editor
    var sb=$('saveConfig');if(sb)sb.onclick=function(){
      sb.disabled=true;var m=$('configMsg');if(m){m.textContent='';m.className=''}
      var e=$('configEditor');if(!e){sb.disabled=false;return}
      xhrPut('/admin/api/config',{content:e.value},
        function(){if(m){m.textContent='\u5df2\u4fdd\u5b58';m.className='success'}
          setTimeout(function(){fetchStatus()},1000);
          sb.disabled=false
        },
        function(){if(m){m.textContent='\u4fdd\u5b58\u5931\u8d25';m.className='error'};sb.disabled=false}
      );
    };
    var rc=$('reloadConfig');if(rc)rc.onclick=loadConfig;

    // Tab switching
    var tabs=document.querySelectorAll('.tab');
    for(var i=0;i<tabs.length;i++){
      tabs[i].addEventListener('click',function(){
        var allTabs=document.querySelectorAll('.tab');for(var j=0;j<allTabs.length;j++)allTabs[j].classList.remove('active');
        var allContent=document.querySelectorAll('.tab-content');for(var j=0;j<allContent.length;j++)allContent[j].classList.remove('active');
        this.classList.add('active');
        var target=$(this.getAttribute('data-tab')==='overview'?'tab-overview':this.getAttribute('data-tab')==='requests'?'tab-requests':'tab-config');
        if(target)target.classList.add('active');
        if(this.getAttribute('data-tab')==='config'){loadConfig();loadStructuredConfig()}
      });
    }

    fetchStatus();setInterval(fetchStatus,2000);
    pollLogs();
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
</script>
</body>
</html>`;

// --- HTTP server ---

const server = http.createServer(async (req, res) => {
  // Lightweight access log so we can see what cc-switch / Codex actually sends.
  // Toggle off by setting ACCESS_LOG=0 in .env.
  if (process.env.ACCESS_LOG !== "0") {
    const ua = req.headers["user-agent"] || "";
    log.access(`[access] ${req.method} ${req.url} ua="${ua.slice(0, 60)}"`);
  }

  // Inbound auth gate. /health stays open so cc-switch's reachability ping works
  // without a key (and so smoke tests can verify the server is up before auth kicks in).
  // On success, req.lockedProvider is set to "deepseek" / "mimo" / "openai" / "*".
  req.lockedProvider = "*";
  if (PROXY_AUTH_ENABLED) {
    const isPublic = req.url === "/health" || req.url === "/";
    if (!isPublic) {
      const lock = authorizeProxyRequest(req, res, { admin: req.url.startsWith("/admin/") });
      if (!lock) return;
      req.lockedProvider = lock;
    }
  }

  if (req.method === "GET" && (req.url === "/health" || req.url === "/")) {
    sendJson(res, 200, {
      status: "ok",
      proxy: "codex-bridge",
      providers: [...enabledProviders],
      default_provider: getFallbackProvider(),
    });
    return;
  }

  // Admin dashboard routes. When inbound auth is configured, these require an
  // unrestricted proxy key because /api/config can read/write local secrets.
  if (req.url.startsWith("/admin/")) {
    const p = req.url.slice(6);
    if (p === "" || p === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      const logRows = ADMIN_LOG_BUF.slice(-100).map(e => {
        const cls = e.level === "error" ? "level-error" : e.level === "warn" ? "level-warn" : e.level === "access" ? "level-access" : "level-info";
        const time = new Date(e.ts).toLocaleTimeString("zh-CN", {hour12: false});
        const msg = String(e.msg).replace(/[<>&"]/g, c => `&#${c.charCodeAt(0)};`);
        return `<div class="entry" data-ts="${e.ts}"><span class="time">${time}</span><span class="${cls}">${msg}</span></div>`;
      }).join("\n") || `<div class="entry" style="color:#8b949e">等待日志...</div>`;
      const html = ADMIN_HTML.replace("<!--LOGS-->", logRows);
      res.end(html);
      return;
    }
    if (p === "/api/status") { sendJson(res, 200, requestStats.snapshot()); return; }
    if (p === "/api/restart" && req.method === "POST") {
      sendJson(res, 200, { ok: true, message: "重启中..." });
      setTimeout(() => process.exit(0), 500);
      return;
    }
    if (p === "/api/logs") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "Access-Control-Allow-Origin": "*" });
      try { for (const e of ADMIN_LOG_BUF) res.write(`data: ${JSON.stringify(e)}\n\n`); } catch {}
      const fn = (e) => { try { res.write(`data: ${JSON.stringify(e)}\n\n`); } catch {} };
      ADMIN_LOG_LISTENERS.add(fn);
      const iv = setInterval(() => { try { res.write(": keepalive\n\n"); } catch {} }, 15000);
      res.on("close", () => { ADMIN_LOG_LISTENERS.delete(fn); clearInterval(iv); });
      return;
    }
    if (p === "/api/logs-recent") {
      sendJson(res, 200, ADMIN_LOG_BUF.slice(-100));
      return;
    }
    if (p === "/api/config") {
      if (req.method === "GET") {
        try { const envPath = process.env._ENV_FILE || process.cwd() + "/.env"; sendJson(res, 200, { content: fs.readFileSync(envPath, "utf-8"), path: envPath }); }
        catch (err) { sendJson(res, 500, { error: err.message }); }
        return;
      }
      if (req.method === "PUT") {
        const body = await readJsonBody(req, res);
        if (!body) return;
        try { const envPath = process.env._ENV_FILE || process.cwd() + "/.env"; fs.writeFileSync(envPath, body.content, "utf-8"); sendJson(res, 200, { ok: true }); }
        catch (err) { sendJson(res, 500, { error: err.message }); }
        return;
      }
    }
    sendJson(res, 404, { error: "Admin endpoint not found" });
    return;
  }

  if ((req.method === "GET" || req.method === "POST") && req.url.startsWith("/cop")) {
    let url = "";
    let method = "GET";
    let body2 = null;
    let headers2 = {};

    if (req.method === "GET") {
      const parsed = new URL(req.url, "http://localhost");
      url = parsed.searchParams.get("url") || "";
    } else {
      const parsedBody = await readJsonBody(req, res);
      if (!parsedBody) return;
      url = parsedBody.url || "";
      method = parsedBody.method || "GET";
      body2 = parsedBody.body || null;
      headers2 = parsedBody.headers || {};
    }

    if (!url) {
      sendJson(res, 400, { error: "url parameter required" });
      return;
    }

    trackRequest(req, res, "cop");
    log.info(`[proxy] /cop ${method} ${url}`);
    const content = await executeWebFetch({ url, method, headers: headers2, body: body2 });
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(content);
    return;
  }

  if (req.method === "GET" && (req.url === "/v1/models" || req.url === "/models")) {
    trackRequest(req, res, "models");
    sendJson(res, 200, {
      object: "list",
      data: modelCatalog,
      default_provider: getFallbackProvider(),
    });
    return;
  }

  if (req.method === "POST" && (req.url === "/v1/responses" || req.url === "/responses")) {
    const body = await readJsonBody(req, res);
    if (!body) return;

    if (process.env.ACCESS_LOG !== "0") {
      const inputType = Array.isArray(body.input) ? `array(${body.input.length})` : typeof body.input;
      log.access(`[access] /v1/responses body keys=${Object.keys(body).join(",")} model=${body.model || "<none>"} input=${inputType} stream=${!!body.stream}`);
    }

    try {
      // If the inbound key locks the request to one provider, fill in the provider's
      // default model when body.model is missing — this lets cc-switch probes (which
      // omit `model` entirely) still get a sensible synthetic response.
      const lock = req.lockedProvider || "*";
      if (lock !== "*" && (!body.model || !String(body.model).trim())) {
        const lockCfg = OAI_COMPAT_PROVIDERS[lock];
        if (lockCfg) body.model = lockCfg.defaultModel;
        else if (lock === "openai") body.model = OPENAI_MODELS[0] || "";
      }

      const provider = resolveProviderForModel(body.model);
      trackRequest(req, res, provider);

      // Provider-lock enforcement: the inbound key dictates which upstream is allowed.
      // If body.model resolves to a different provider, refuse (the user almost certainly
      // forgot to /model after switching cc-switch profile, or is reusing a key).
      if (lock !== "*" && provider !== lock) {
        if (process.env.ACCESS_LOG !== "0") {
          log.access(`[access] 401 provider lock mismatch (key locks=${lock}, model=${body.model || "<none>"} -> provider=${provider})`);
        }
        sendJson(res, 401, {
          error: {
            message: `This proxy key is locked to provider "${lock}", but the request model "${body.model || "<none>"}" routes to "${provider}". Either switch model or use a different key.`,
            type: "invalid_request_error",
            code: "proxy_provider_lock",
          },
        });
        return;
      }

      const originalInput = normalizeInputToArray(body.input);

      // Health-check / probe short-circuit: cc-switch (and similar managers) ping the
      // proxy with empty or input-less bodies just to verify reachability. Forwarding
      // those upstream produces a 400 ("Empty input messages") which surfaces in the UI
      // as "供应商拒绝了请求格式". Detect probes (no input AND no previous_response_id)
      // and answer locally without touching the upstream provider.
      const hasInput = originalInput.length > 0 || (typeof body.input === "string" && body.input.trim().length > 0);
      const hasPrevious = !!body.previous_response_id;
      if (!hasInput && !hasPrevious) {
        if (process.env.ACCESS_LOG !== "0") {
          log.access(`[access] /v1/responses probe short-circuit (provider=${provider})`);
        }
        const probeId = `resp_probe_${Math.random().toString(36).slice(2, 12)}`;
        sendJson(res, 200, {
          id: probeId,
          object: "response",
          created_at: Math.floor(Date.now() / 1000),
          status: "completed",
          model: body.model || (OAI_COMPAT_PROVIDERS[provider]?.defaultModel) || "probe",
          output: [
            {
              type: "message",
              id: `msg_probe_${Math.random().toString(36).slice(2, 10)}`,
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: "ok", annotations: [] }],
            },
          ],
          previous_response_id: null,
          metadata: { probe: true },
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
          incomplete_details: null,
        });
        return;
      }

      if (provider === "openai") {
        if (!OPENAI_KEY) {
          sendJson(res, 400, { error: { message: "OPENAI_API_KEY is not configured" } });
          return;
        }
        const originalPreviousResponseId = body.previous_response_id || null;
        maybeResolvePreviousResponseChain(body, "openai");
        log.info(`[proxy] responses openai(${body.model || OPENAI_MODELS[0] || "default"}) | stream=${!!body.stream}`);
        await forwardOpenAIResponses(req, body, res, originalInput, originalPreviousResponseId);
        return;
      }

      if (OAI_COMPAT_PROVIDERS[provider]) {
        await handleOaiCompatResponses(req, provider, body, res, originalInput);
        return;
      }

      sendJson(res, 400, { error: { message: `Unknown provider resolved: ${provider}` } });
    } catch (err) {
      log.error("[proxy] responses route error:", err.message, err.cause);
      if (!res.headersSent) sendJson(res, 500, { error: { message: err.message } });
    }
    return;
  }

  if (req.method === "POST" && (req.url === "/v1/chat/completions" || req.url === "/chat/completions")) {
    const body = await readJsonBody(req, res);
    if (!body) return;

    try {
      const lock = req.lockedProvider || "*";
      if (lock !== "*" && (!body.model || !String(body.model).trim())) {
        const lockCfg = OAI_COMPAT_PROVIDERS[lock];
        if (lockCfg) body.model = lockCfg.defaultModel;
        else if (lock === "openai") body.model = OPENAI_MODELS[0] || "";
      }
      const provider = resolveProviderForModel(body.model);
      trackRequest(req, res, provider);
      if (lock !== "*" && provider !== lock) {
        if (process.env.ACCESS_LOG !== "0") {
          log.access(`[access] 401 provider lock mismatch (key locks=${lock}, model=${body.model || "<none>"} -> provider=${provider})`);
        }
        sendJson(res, 401, {
          error: {
            message: `This proxy key is locked to provider "${lock}", but the request model "${body.model || "<none>"}" routes to "${provider}". Either switch model or use a different key.`,
            type: "invalid_request_error",
            code: "proxy_provider_lock",
          },
        });
        return;
      }
      if (provider === "openai") {
        if (!OPENAI_KEY) {
          sendJson(res, 400, { error: { message: "OPENAI_API_KEY is not configured" } });
          return;
        }
        log.info(`[proxy] chat/completions openai(${body.model || OPENAI_MODELS[0] || "default"}) | stream=${!!body.stream}`);
        await forwardOpenAIChatCompletions(req, body, res);
        return;
      }

      if (OAI_COMPAT_PROVIDERS[provider]) {
        await handleOaiCompatChatCompletions(req, provider, body, res);
        return;
      }

      sendJson(res, 400, { error: { message: `Unknown provider resolved: ${provider}` } });
    } catch (err) {
      log.error("[proxy] chat/completions route error:", err.message);
      if (!res.headersSent) sendJson(res, 500, { error: { message: err.message } });
    }
    return;
  }

  sendJson(res, 404, { error: "Not found. Use POST /v1/responses" });
});

server.timeout = 0;
server.keepAliveTimeout = 300000;
server.headersTimeout = 300000;
server.requestTimeout = 0;

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[codex-bridge] Port ${PORT} is already in use — exiting`);
    process.exit(1);
  }
  console.error(`[codex-bridge] Server error:`, err.message);
});

server.listen(PORT, HOST, () => {
  console.log(`[codex-bridge] Listening on http://${HOST}:${PORT}`);
  console.log(`[codex-bridge] Default provider: ${getFallbackProvider()}`);
  for (const [name, cfg] of Object.entries(OAI_COMPAT_PROVIDERS)) {
    const label = name.charAt(0).toUpperCase() + name.slice(1);
    console.log(`[codex-bridge] ${label.padEnd(8)}: ${cfg.key ? `${cfg.base} | models=${cfg.models.join(", ")}` : "DISABLED"}`);
  }
  console.log(`[codex-bridge] OpenAI  : ${OPENAI_KEY ? `${OPENAI_BASE} | models=${OPENAI_MODELS.join(", ")}` : "DISABLED"}`);
  console.log(`[codex-bridge] GitHub  : ${process.env.GITHUB_TOKEN ? "authenticated (env)" : "lazy (will run `gh auth token` on first api.github.com fetch)"}`);
  if (!PROXY_AUTH_ENABLED) {
    console.log(`[codex-bridge] Inbound : OPEN on ${HOST} — set PROXY_AUTH_KEY or PROXY_KEYS to lock down`);
  } else {
    console.log(`[codex-bridge] Inbound : auth required (${PROXY_KEY_TABLE.size} key${PROXY_KEY_TABLE.size === 1 ? "" : "s"} loaded)`);
    for (const [key, lock] of PROXY_KEY_TABLE) {
      const lockLabel = lock === "*" ? "any provider" : `locked to ${lock}`;
      console.log(`[codex-bridge]           ${key.slice(0, 16)}… (${key.length} chars) — ${lockLabel}`);
    }
  }
});
