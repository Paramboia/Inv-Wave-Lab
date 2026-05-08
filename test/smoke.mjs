import assert from "node:assert/strict";
import { normalizeSymbol } from "../lib/data/yahooFinance.mjs";
import { analyzeInstrument, runBacktest } from "../lib/engine/invWaveEngine.mjs";

function rng(seed = 7) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function businessDates(count) {
  const dates = [];
  const date = new Date("2020-01-01T00:00:00Z");
  while (dates.length < count) {
    const day = date.getUTCDay();
    if (day !== 0 && day !== 6) dates.push(date.toISOString().slice(0, 10));
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return dates;
}

function makeSeries(symbol, count, startPrice, seed, drift = 0.00025, amplitude = 0.012) {
  const random = rng(seed);
  const dates = businessDates(count);
  let price = startPrice;
  return {
    symbol,
    prices: dates.map((date, index) => {
      const cycle = Math.sin((index / 31) * Math.PI * 2) * amplitude;
      const shock = (random() - 0.5) * 0.018;
      price *= Math.exp(drift + cycle * 0.08 + shock);
      const range = price * (0.01 + random() * 0.018);
      return {
        date,
        open: price * (1 + (random() - 0.5) * 0.006),
        high: price + range,
        low: Math.max(0.1, price - range),
        close: price,
        adjClose: price,
        volume: 12_000_000 + Math.round(random() * 4_000_000 + index * 900),
      };
    }),
  };
}

const instrument = makeSeries("WAVE", 900, 100, 11, 0.00032, 0.016);
const marketContext = {
  SPY: makeSeries("SPY", 900, 410, 1, 0.00018, 0.008),
  QQQ: makeSeries("QQQ", 900, 340, 2, 0.00022, 0.01),
  "^VIX": makeSeries("^VIX", 900, 20, 3, -0.00002, 0.006),
  "^TNX": makeSeries("^TNX", 900, 42, 4, 0.00002, 0.004),
  DBC: makeSeries("DBC", 900, 25, 5, 0.00004, 0.006),
};

const quote = {
  quote: {
    shortName: "Wave Systems",
    currency: "USD",
    trailingPE: 22,
    forwardPE: 18,
    priceToBook: 5,
    profitMargins: 0.18,
    revenueGrowth: 0.13,
    earningsGrowth: 0.16,
    beta: 1.1,
  },
  summary: {
    assetProfile: {
      sector: "Technology",
      industry: "Research Software",
    },
    financialData: {
      operatingMargins: { raw: 0.22 },
      returnOnEquity: { raw: 0.27 },
      debtToEquity: { raw: 32 },
      currentRatio: { raw: 1.8 },
    },
  },
};

const analysis = analyzeInstrument({
  symbol: "WAVE",
  prices: instrument.prices,
  quote,
  marketContext,
  horizonDays: 30,
});

assert.equal(analysis.symbol, "WAVE");
assert.ok(analysis.forecast.targetPrice > 0);
assert.ok(analysis.forecast.confidence >= 5);
assert.ok(analysis.buyOpportunity.action);
assert.ok(Number.isFinite(analysis.buyOpportunity.setupScore));
assert.ok(Number.isFinite(analysis.dataProfile.reliabilityScore));
assert.ok(analysis.wave.dominantCycleDays >= 5);
assert.ok(analysis.wavePhysics.spectralPeakPeriod >= 5);
assert.ok(Number.isFinite(analysis.wavePhysics.tsunamiSetupScore));
assert.ok(analysis.priceHistory.length <= 420);

const backtest = runBacktest({
  symbol: "WAVE",
  prices: instrument.prices,
  quote,
  marketContext,
  horizonDays: 30,
  trainingDays: 504,
  stepDays: 42,
});

assert.ok(backtest.sampleSize > 0);
assert.ok(Number.isFinite(backtest.metrics.meanAbsoluteError));
assert.ok(Number.isFinite(backtest.metrics.directionalAccuracy));
assert.ok(Number.isFinite(backtest.metrics.tsunamiSetupHitRate));
assert.equal(backtest.validation.avoidsCurrentFundamentalLookahead, true);
assert.equal(backtest.validation.windowsOverlap, false);
assert.ok(backtest.validationWarnings.some((warning) => warning.includes("excludes current quote/fundamental")));

assert.equal(normalizeSymbol("brk.b"), "BRK-B");
assert.throws(() => normalizeSymbol(""), /Enter a ticker/);

const shortHistory = makeSeries("IPO", 120, 40, 21, 0.0002, 0.012);
const shortAnalysis = analyzeInstrument({
  symbol: "IPO",
  prices: shortHistory.prices,
  marketContext,
  horizonDays: 30,
});
assert.equal(shortAnalysis.buyOpportunity.action, "Data quality watch");
assert.equal(shortAnalysis.dataProfile.flags.shortHistory, true);

const zeroVolume = makeSeries("DRY", 220, 12, 31, 0.0001, 0.006);
zeroVolume.prices = zeroVolume.prices.map((point) => ({ ...point, volume: 0 }));
const zeroVolumeAnalysis = analyzeInstrument({
  symbol: "DRY",
  prices: zeroVolume.prices,
  marketContext,
  horizonDays: 30,
});
assert.equal(zeroVolumeAnalysis.dataProfile.flags.missingVolume, true);
assert.ok(zeroVolumeAnalysis.modelWarnings.some((warning) => warning.includes("volume data is missing")));

console.log("Smoke test passed");
