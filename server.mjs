import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchInstrumentBundle, fetchMarketContext, normalizeSymbol } from "./lib/data/yahooFinance.mjs";
import { analyzeInstrument, runBacktest } from "./lib/engine/invWaveEngine.mjs";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");
const VENDOR_FILES = new Map([
  ["/vendor/three.module.js", join(ROOT, "node_modules", "three", "build", "three.module.js")],
  ["/vendor/three.core.js", join(ROOT, "node_modules", "three", "build", "three.core.js")],
]);
const PORT = Number(process.env.PORT ?? 4173);
const HOST = process.env.HOST ?? "127.0.0.1";
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map();
const ALLOWED_RANGES = new Set(["1y", "2y", "5y", "10y", "max"]);
const EXPECTED_TRADING_DAYS = {
  "1y": 252,
  "2y": 504,
  "5y": 1260,
  "10y": 2520,
};

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

class ApiError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function jsonResponse(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

async function cached(key, loader) {
  const existing = cache.get(key);
  if (existing && Date.now() - existing.createdAt < CACHE_TTL_MS) return existing.value;
  const value = await loader();
  cache.set(key, { value, createdAt: Date.now() });
  return value;
}

function parseRange(value, fallback) {
  const range = value ?? fallback;
  if (!ALLOWED_RANGES.has(range)) {
    throw new ApiError(400, "INVALID_RANGE", `History must be one of ${[...ALLOWED_RANGES].join(", ")}.`, {
      received: range,
    });
  }
  return range;
}

function parseIntParam(searchParams, name, fallback, min, max) {
  const raw = searchParams.get(name);
  if (raw === null || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new ApiError(400, "INVALID_PARAMETER", `${name} must be a whole number.`, { parameter: name, received: raw });
  }
  const parsed = Number.parseInt(raw, 10);
  if (parsed < min || parsed > max) {
    throw new ApiError(400, "INVALID_PARAMETER", `${name} must be between ${min} and ${max}.`, {
      parameter: name,
      received: parsed,
      min,
      max,
    });
  }
  return parsed;
}

function uniqueWarnings(...groups) {
  return [...new Set(groups.flat().filter(Boolean))];
}

function lastDate(prices = []) {
  return prices[prices.length - 1]?.date;
}

function daysBetween(left, right) {
  const leftTime = new Date(`${left}T00:00:00Z`).getTime();
  const rightTime = new Date(`${right}T00:00:00Z`).getTime();
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return 0;
  return Math.round((rightTime - leftTime) / 86_400_000);
}

function computeDataCoverage(prices, requestedRange) {
  const observations = prices.length;
  const startDate = prices[0]?.date ?? null;
  const endDate = lastDate(prices) ?? null;
  const expectedTradingDays = EXPECTED_TRADING_DAYS[requestedRange] ?? null;
  const coverageRatio = expectedTradingDays ? Math.min(1, observations / expectedTradingDays) : null;
  const status =
    observations < 80
      ? "insufficient"
      : observations < 252
        ? "thin"
        : coverageRatio !== null && coverageRatio < 0.8
          ? "partial"
          : "ok";
  const warnings = [];

  if (expectedTradingDays && coverageRatio < 0.8) {
    warnings.push(
      `Requested ${requestedRange} history, but only ${observations.toLocaleString()} trading days were returned from ${startDate} to ${endDate}. Confidence is reduced.`,
    );
  }
  if (observations < 252) {
    warnings.push("Less than one trading year of history is available; cycle, physics, and risk signals are low-confidence.");
  } else if (observations < 504) {
    warnings.push("Less than two trading years of history is available; long-cycle and backtest conclusions are limited.");
  }

  return {
    requestedRange,
    startDate,
    endDate,
    observations,
    expectedTradingDays,
    coverageRatio,
    status,
    warnings,
  };
}

function latestMarketDate(marketContext) {
  return Object.values(marketContext ?? {})
    .map((series) => lastDate(series?.prices ?? []))
    .filter(Boolean)
    .sort()
    .at(-1);
}

function sliceMarketContext(marketContext, asOfDate) {
  const asOf = new Date(`${asOfDate}T23:59:59Z`).getTime();
  const sliced = {};
  for (const [symbol, series] of Object.entries(marketContext ?? {})) {
    if (!Array.isArray(series?.prices)) {
      sliced[symbol] = series;
      continue;
    }
    sliced[symbol] = {
      ...series,
      prices: series.prices.filter((point) => new Date(`${point.date}T00:00:00Z`).getTime() <= asOf),
    };
  }
  return sliced;
}

function recencyWarnings(coverage, marketContext) {
  const warnings = [];
  if (!coverage.endDate) return warnings;
  const today = new Date().toISOString().slice(0, 10);
  const calendarAge = daysBetween(coverage.endDate, today);
  if (calendarAge > 10) {
    warnings.push(`Latest instrument price is ${coverage.endDate}, ${calendarAge} calendar days old. Treat live signals as stale.`);
  }
  const marketDate = latestMarketDate(marketContext);
  if (marketDate && daysBetween(coverage.endDate, marketDate) > 5) {
    warnings.push(`Macro proxies extend beyond the instrument's last price date; macro weather is aligned to ${coverage.endDate}.`);
  }
  return warnings;
}

function classifyError(error) {
  if (error instanceof ApiError) return error;
  const message = error?.message ?? "Unexpected server error";
  if (message.includes("unsupported characters") || message === "Enter a ticker.") {
    return new ApiError(400, "INVALID_TICKER", message);
  }
  if (message.includes("At least 80 trading days")) {
    return new ApiError(422, "INSUFFICIENT_HISTORY", message);
  }
  if (message.includes("Backtest needs at least")) {
    return new ApiError(422, "INSUFFICIENT_BACKTEST_HISTORY", message);
  }
  if (message.includes("No historical chart data") || message.includes("No data found")) {
    return new ApiError(404, "NO_MARKET_DATA", message);
  }
  if (message.startsWith("HTTP ") || message.includes("Yahoo")) {
    return new ApiError(502, "MARKET_DATA_UNAVAILABLE", message);
  }
  return new ApiError(500, "SERVER_ERROR", message);
}

async function handleAnalyze(url, response) {
  const symbol = normalizeSymbol(url.searchParams.get("ticker") ?? url.searchParams.get("symbol") ?? "AAPL");
  const range = parseRange(url.searchParams.get("range"), "5y");
  const horizonDays = parseIntParam(url.searchParams, "horizon", 30, 5, 252);
  const bundle = await cached(`bundle:${symbol}:${range}:1d`, () => fetchInstrumentBundle(symbol, { range, interval: "1d" }));
  const coverage = computeDataCoverage(bundle.prices, range);
  const rawMarketContext = await cached(`market:${range}:1d`, () => fetchMarketContext({ range, interval: "1d" }));
  const marketContext = sliceMarketContext(rawMarketContext, coverage.endDate);
  const analysis = analyzeInstrument({
    symbol,
    prices: bundle.prices,
    quote: {
      meta: bundle.meta,
      quote: bundle.quote,
      summary: bundle.summary,
    },
    marketContext,
    horizonDays,
  });
  jsonResponse(response, 200, {
    ...analysis,
    dataCoverage: coverage,
    dataWarnings: uniqueWarnings(bundle.dataWarnings, coverage.warnings, recencyWarnings(coverage, rawMarketContext), analysis.modelWarnings),
  });
}

async function handleBacktest(url, response) {
  const symbol = normalizeSymbol(url.searchParams.get("ticker") ?? url.searchParams.get("symbol") ?? "AAPL");
  const range = parseRange(url.searchParams.get("range"), "10y");
  const horizonDays = parseIntParam(url.searchParams, "horizon", 30, 5, 252);
  const trainingDays = parseIntParam(url.searchParams, "training", 504, 126, 1260);
  const stepDays = parseIntParam(url.searchParams, "step", 30, 5, 126);
  const bundle = await cached(`bundle:${symbol}:${range}:1d`, () => fetchInstrumentBundle(symbol, { range, interval: "1d" }));
  const coverage = computeDataCoverage(bundle.prices, range);
  const marketContext = await cached(`market:${range}:1d`, () => fetchMarketContext({ range, interval: "1d" }));
  const backtest = runBacktest({
    symbol,
    prices: bundle.prices,
    quote: {
      meta: bundle.meta,
      quote: bundle.quote,
      summary: bundle.summary,
    },
    marketContext,
    horizonDays,
    trainingDays,
    stepDays,
  });
  jsonResponse(response, 200, {
    ...backtest,
    dataCoverage: coverage,
    dataWarnings: uniqueWarnings(bundle.dataWarnings, coverage.warnings, backtest.validationWarnings),
  });
}

async function handleStatic(url, response) {
  const vendorPath = VENDOR_FILES.get(url.pathname);
  if (vendorPath) {
    try {
      const body = await readFile(vendorPath);
      response.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "public, max-age=3600",
      });
      response.end(body);
    } catch {
      jsonResponse(response, 404, { error: "Vendor asset not found" });
    }
    return;
  }

  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const pathname = extname(requestedPath) || requestedPath.endsWith("/") ? requestedPath : `${requestedPath}.html`;
  const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(PUBLIC_DIR, safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    jsonResponse(response, 403, { error: "Forbidden" });
    return;
  }
  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      "content-type": CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream",
      "cache-control": "no-cache",
    });
    response.end(body);
  } catch {
    jsonResponse(response, 404, { error: "Not found" });
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  try {
    if (url.pathname === "/api/analyze") {
      await handleAnalyze(url, response);
      return;
    }
    if (url.pathname === "/api/backtest") {
      await handleBacktest(url, response);
      return;
    }
    if (url.pathname === "/api/health") {
      jsonResponse(response, 200, { ok: true, cacheEntries: cache.size });
      return;
    }
    await handleStatic(url, response);
  } catch (error) {
    const apiError = classifyError(error);
    jsonResponse(response, apiError.status, {
      error: apiError.message,
      code: apiError.code,
      details: apiError.details,
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Inv-Wave Lab running at http://${HOST}:${PORT}`);
});
