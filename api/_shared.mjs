import { fetchInstrumentBundle, fetchMarketContext, normalizeSymbol } from "../lib/data/yahooFinance.mjs";
import { analyzeInstrument, runBacktest } from "../lib/engine/invWaveEngine.mjs";

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = globalThis.__INV_WAVE_CACHE__ ?? new Map();
globalThis.__INV_WAVE_CACHE__ = cache;

const ALLOWED_RANGES = new Set(["1y", "2y", "5y", "10y", "max"]);
const EXPECTED_TRADING_DAYS = {
  "1y": 252,
  "2y": 504,
  "5y": 1260,
  "10y": 2520,
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
  response.setHeader?.("content-type", "application/json; charset=utf-8");
  response.setHeader?.("cache-control", "no-store");
  if (typeof response.status === "function" && typeof response.json === "function") {
    response.status(status).json(payload);
    return;
  }
  response.writeHead?.(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
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

export function createHandler(routeHandler) {
  return async function handler(request, response) {
    const host = request.headers?.host ?? "localhost";
    const url = new URL(request.url ?? "/", `https://${host}`);
    try {
      await routeHandler(url, response);
    } catch (error) {
      const apiError = classifyError(error);
      jsonResponse(response, apiError.status, {
        error: apiError.message,
        code: apiError.code,
        details: apiError.details,
      });
    }
  };
}

export async function analyzeRoute(url, response) {
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

export async function backtestRoute(url, response) {
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

export async function healthRoute(_url, response) {
  jsonResponse(response, 200, { ok: true, runtime: "vercel", cacheEntries: cache.size });
}
