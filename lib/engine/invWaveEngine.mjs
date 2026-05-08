import {
  TRADING_DAYS,
  alignSeriesByDate,
  annualizedDrift,
  annualizedVolatility,
  autocorrelation,
  clamp,
  conditionalValueAtRisk,
  downsideDeviation,
  ema,
  estimateHurst,
  isFiniteNumber,
  linearRegression,
  logReturns,
  maxDrawdown,
  mean,
  median,
  pearson,
  quantile,
  rsi,
  safeLast,
  scoreFromZ,
  sigmoid,
  simpleReturns,
  stdev,
  trueRangeSeries,
  valueAtRisk,
  weightedMean,
  zScore,
} from "./statistics.mjs";
import { computeWavePhysics } from "./wavePhysics.mjs";

const SECTOR_PRIORS = {
  "Basic Materials": { cyclicality: 0.78, rateSensitivity: 0.48, defensiveness: 0.24, innovation: 0.34, moat: 0.42 },
  "Communication Services": { cyclicality: 0.58, rateSensitivity: 0.45, defensiveness: 0.38, innovation: 0.61, moat: 0.58 },
  "Consumer Cyclical": { cyclicality: 0.82, rateSensitivity: 0.55, defensiveness: 0.18, innovation: 0.42, moat: 0.38 },
  "Consumer Defensive": { cyclicality: 0.28, rateSensitivity: 0.28, defensiveness: 0.78, innovation: 0.26, moat: 0.58 },
  Energy: { cyclicality: 0.86, rateSensitivity: 0.34, defensiveness: 0.18, innovation: 0.32, moat: 0.44 },
  "Financial Services": { cyclicality: 0.68, rateSensitivity: 0.76, defensiveness: 0.27, innovation: 0.36, moat: 0.46 },
  Healthcare: { cyclicality: 0.34, rateSensitivity: 0.31, defensiveness: 0.66, innovation: 0.64, moat: 0.55 },
  Industrials: { cyclicality: 0.72, rateSensitivity: 0.51, defensiveness: 0.28, innovation: 0.39, moat: 0.45 },
  "Real Estate": { cyclicality: 0.64, rateSensitivity: 0.86, defensiveness: 0.39, innovation: 0.21, moat: 0.35 },
  Technology: { cyclicality: 0.61, rateSensitivity: 0.66, defensiveness: 0.24, innovation: 0.86, moat: 0.58 },
  Utilities: { cyclicality: 0.22, rateSensitivity: 0.72, defensiveness: 0.84, innovation: 0.18, moat: 0.48 },
};

const DEFAULT_PRIOR = { cyclicality: 0.55, rateSensitivity: 0.5, defensiveness: 0.45, innovation: 0.45, moat: 0.45 };

function cleanPrices(prices) {
  return prices
    .filter((point) => point?.date && isFiniteNumber(point.close) && point.close > 0)
    .map((point) => ({
      ...point,
      adjClose: isFiniteNumber(point.adjClose) ? point.adjClose : point.close,
      open: isFiniteNumber(point.open) ? point.open : point.close,
      high: isFiniteNumber(point.high) ? point.high : point.close,
      low: isFiniteNumber(point.low) ? point.low : point.close,
      volume: isFiniteNumber(point.volume) ? point.volume : 0,
    }))
    .sort((left, right) => new Date(left.date) - new Date(right.date));
}

function closesFrom(prices) {
  return prices.map((point) => point.adjClose ?? point.close);
}

function raw(value) {
  if (value && typeof value === "object" && "raw" in value) return value.raw;
  return value;
}

function pick(source, paths) {
  for (const path of paths) {
    const parts = path.split(".");
    let current = source;
    for (const part of parts) {
      current = current?.[part];
    }
    const value = raw(current);
    if (typeof value === "string" && value.trim()) return value;
    if (isFiniteNumber(value)) return value;
  }
  return undefined;
}

function scoreLowerBetter(value, fair, expensive) {
  if (!isFiniteNumber(value) || value <= 0) return undefined;
  return 100 * (1 - sigmoid((value - fair) / Math.max(1, expensive - fair)));
}

function scoreHigherBetter(value, fair, strong) {
  if (!isFiniteNumber(value)) return undefined;
  return 100 * sigmoid((value - fair) / Math.max(0.01, strong - fair));
}

function scoreBoundedRatio(value, weak, strong) {
  if (!isFiniteNumber(value)) return undefined;
  return clamp((value - weak) / Math.max(0.01, strong - weak), 0, 1) * 100;
}

function averageKnown(values, fallback = 50) {
  const clean = values.filter(isFiniteNumber);
  return clean.length ? mean(clean) : fallback;
}

function detectDominantCycle(logCloses) {
  const windowSize = Math.min(520, logCloses.length);
  if (windowSize < 80) {
    return {
      dominantPeriod: 21,
      frequency: 1 / 21,
      concentration: 0,
      topCycles: [],
      residuals: logCloses.slice(-windowSize),
      confidence: 0,
    };
  }

  const window = logCloses.slice(-windowSize);
  const trend = linearRegression(window);
  const residuals = window.map((value, index) => value - (trend.intercept + trend.slope * index));
  const residualMean = mean(residuals);
  const centered = residuals.map((value) => value - residualMean);
  const minPeriod = 5;
  const maxPeriod = Math.min(160, Math.floor(windowSize / 2));
  const powers = [];

  for (let period = minPeriod; period <= maxPeriod; period += 1) {
    const omega = (2 * Math.PI) / period;
    let cosSum = 0;
    let sinSum = 0;
    for (let index = 0; index < centered.length; index += 1) {
      cosSum += centered[index] * Math.cos(omega * index);
      sinSum += centered[index] * Math.sin(omega * index);
    }
    powers.push({
      period,
      power: (cosSum ** 2 + sinSum ** 2) / centered.length,
      phase: Math.atan2(sinSum, cosSum),
    });
  }

  powers.sort((left, right) => right.power - left.power);
  const totalPower = powers.reduce((sum, item) => sum + item.power, 0) || 1;
  const topCycles = powers.slice(0, 5).map((item) => ({
    period: item.period,
    powerShare: item.power / totalPower,
    phase: item.phase,
  }));
  const dominant = topCycles[0] ?? { period: 21, powerShare: 0, phase: 0 };
  return {
    dominantPeriod: dominant.period,
    frequency: 1 / dominant.period,
    concentration: dominant.powerShare,
    topCycles,
    residuals,
    confidence: clamp(dominant.powerShare / 0.2, 0, 1),
  };
}

function computeWave(prices) {
  const closes = closesFrom(prices);
  const logCloses = closes.map((value) => Math.log(value));
  const returns = logReturns(prices);
  const returnValues = returns.map((point) => point.value);
  const recentReturns = returnValues.slice(-Math.min(252, returnValues.length));
  const annualVol = annualizedVolatility(recentReturns);
  const drift = annualizedDrift(recentReturns);
  const cycle = detectDominantCycle(logCloses);
  const dominantPeriod = Math.round(cycle.dominantPeriod);
  const periodWindow = Math.max(10, Math.min(dominantPeriod, logCloses.length));
  const waveWindow = logCloses.slice(-periodWindow);
  const waveZ = zScore(safeLast(logCloses), waveWindow);
  const acAtCycle = autocorrelation(cycle.residuals, Math.min(dominantPeriod, Math.floor(cycle.residuals.length / 2)));
  const hurst = estimateHurst(logCloses.slice(-Math.min(520, logCloses.length)), 48);
  const trendWindow = logCloses.slice(-Math.min(126, logCloses.length));
  const trend = linearRegression(trendWindow);
  const trendAnnual = trend.slope * TRADING_DAYS;
  const latestClose = safeLast(closes);
  const rangeValues = trueRangeSeries(prices).map((point) => point.value);
  const atr = safeLast(ema(rangeValues, 14), 0);
  const atrPct = latestClose ? atr / latestClose : 0;
  const historicalAtrPct = rangeValues.map((value, index) => {
    const close = closes[index] || latestClose;
    return close ? value / close : 0;
  });
  const atrExpansion = atrPct / Math.max(0.0001, median(historicalAtrPct.slice(-120)));
  const volumeValues = prices.map((point) => point.volume).filter((value) => value > 0);
  const currentVolume = safeLast(volumeValues, 0);
  const volumeZ = zScore(currentVolume, volumeValues.slice(-63));
  const currentRsi = rsi(closes, 14);
  const drawdown = maxDrawdown(prices.slice(-252));
  const recentMomentum = logCloses.length > 64 ? safeLast(logCloses) - logCloses[logCloses.length - 64] : drift / TRADING_DAYS * 63;
  const momentumAnnual = recentMomentum * (TRADING_DAYS / 63);
  const extensionStress = clamp(Math.abs(waveZ) / 2.6, 0, 1);
  const rsiStress = clamp(Math.abs(currentRsi - 50) / 45, 0, 1);
  const rangeStress = clamp((atrExpansion - 0.8) / 1.7, 0, 1);
  const volumeStress = clamp(Math.max(0, volumeZ) / 3, 0, 1);
  const drawdownStress = clamp(Math.abs(drawdown) / 0.35, 0, 1);
  const breakRisk = weightedMean([
    { value: extensionStress * 100, weight: 0.26 },
    { value: rsiStress * 100, weight: 0.12 },
    { value: rangeStress * 100, weight: 0.22 },
    { value: volumeStress * 100, weight: 0.13 },
    { value: drawdownStress * 100, weight: 0.17 },
    { value: (1 - cycle.confidence) * 100, weight: 0.1 },
  ]);
  const repetitionScore = weightedMean([
    { value: clamp((acAtCycle + 0.2) / 0.75, 0, 1) * 100, weight: 0.35 },
    { value: cycle.confidence * 100, weight: 0.4 },
    { value: clamp(1 - Math.abs(hurst - 0.5) / 0.5, 0, 1) * 100, weight: 0.25 },
  ]);
  const trendScore = scoreFromZ(trendAnnual, 0, Math.max(0.08, annualVol));
  const cycleReversionScore = 50 + clamp(-waveZ, -2, 2) * 18;
  const waveScore = weightedMean([
    { value: trendScore, weight: 0.34 },
    { value: clamp(cycleReversionScore, 0, 100), weight: 0.24 },
    { value: 100 - breakRisk, weight: 0.25 },
    { value: repetitionScore, weight: 0.17 },
  ]);

  return {
    score: waveScore,
    latestClose,
    annualVolatility: annualVol,
    annualDrift: drift,
    momentumAnnual,
    trendAnnual,
    trendR2: trend.r2,
    dominantCycleDays: dominantPeriod,
    frequencyPerDay: cycle.frequency,
    frequencyPerYear: cycle.frequency * TRADING_DAYS,
    cycleConcentration: cycle.concentration,
    topCycles: cycle.topCycles,
    waveZ,
    rsi: currentRsi,
    atrPct,
    atrExpansion,
    volumeZ,
    hurst,
    autocorrelationAtCycle: acAtCycle,
    repetitiveness: repetitionScore,
    breakRisk,
    drawdown252: drawdown,
  };
}

function computeFundamentalShape(quoteBundle = {}) {
  const fields = {
    shortName: pick(quoteBundle, ["quote.shortName", "quote.longName", "summary.price.shortName", "summary.price.longName"]),
    sector: pick(quoteBundle, ["summary.assetProfile.sector", "quote.sector"]),
    industry: pick(quoteBundle, ["summary.assetProfile.industry", "quote.industry"]),
    marketCap: pick(quoteBundle, ["quote.marketCap", "summary.price.marketCap", "summary.defaultKeyStatistics.enterpriseValue"]),
    trailingPE: pick(quoteBundle, ["quote.trailingPE", "summary.summaryDetail.trailingPE", "summary.defaultKeyStatistics.trailingPE"]),
    forwardPE: pick(quoteBundle, ["quote.forwardPE", "summary.summaryDetail.forwardPE", "summary.defaultKeyStatistics.forwardPE"]),
    priceToBook: pick(quoteBundle, ["quote.priceToBook", "summary.defaultKeyStatistics.priceToBook"]),
    profitMargins: pick(quoteBundle, ["quote.profitMargins", "summary.defaultKeyStatistics.profitMargins", "summary.financialData.profitMargins"]),
    operatingMargins: pick(quoteBundle, ["summary.financialData.operatingMargins"]),
    returnOnEquity: pick(quoteBundle, ["summary.financialData.returnOnEquity"]),
    revenueGrowth: pick(quoteBundle, ["quote.revenueGrowth", "summary.financialData.revenueGrowth"]),
    earningsGrowth: pick(quoteBundle, ["quote.earningsGrowth", "summary.financialData.earningsGrowth"]),
    debtToEquity: pick(quoteBundle, ["summary.financialData.debtToEquity"]),
    currentRatio: pick(quoteBundle, ["summary.financialData.currentRatio"]),
    beta: pick(quoteBundle, ["quote.beta", "summary.defaultKeyStatistics.beta"]),
    dividendYield: pick(quoteBundle, ["quote.dividendYield", "summary.summaryDetail.dividendYield"]),
  };

  const valuationScore = averageKnown([
    scoreLowerBetter(fields.trailingPE, 18, 45),
    scoreLowerBetter(fields.forwardPE, 16, 38),
    scoreLowerBetter(fields.priceToBook, 3, 12),
  ]);
  const profitabilityScore = averageKnown([
    scoreHigherBetter(fields.profitMargins, 0.08, 0.24),
    scoreHigherBetter(fields.operatingMargins, 0.1, 0.28),
    scoreHigherBetter(fields.returnOnEquity, 0.12, 0.32),
  ]);
  const growthScore = averageKnown([
    scoreHigherBetter(fields.revenueGrowth, 0.04, 0.18),
    scoreHigherBetter(fields.earningsGrowth, 0.04, 0.22),
  ]);
  const balanceSheetScore = averageKnown([
    fields.debtToEquity === undefined ? undefined : 100 * (1 - sigmoid((fields.debtToEquity - 80) / 55)),
    scoreBoundedRatio(fields.currentRatio, 0.8, 2.2),
  ]);
  const incomeScore = averageKnown([
    fields.dividendYield === undefined ? undefined : scoreHigherBetter(fields.dividendYield, 0.01, 0.04),
  ], 50);
  const score = weightedMean([
    { value: valuationScore, weight: 0.24 },
    { value: profitabilityScore, weight: 0.27 },
    { value: growthScore, weight: 0.25 },
    { value: balanceSheetScore, weight: 0.16 },
    { value: incomeScore, weight: 0.08 },
  ]);
  const observedFields = Object.values(fields).filter((value) => value !== undefined).length;
  const confidence = clamp((observedFields - 4) / 10, 0.15, 1);

  return {
    score,
    confidence,
    fields,
    subScores: {
      valuation: valuationScore,
      profitability: profitabilityScore,
      growth: growthScore,
      balanceSheet: balanceSheetScore,
      income: incomeScore,
    },
  };
}

function computeCoast(fundamentalShape) {
  const sector = fundamentalShape.fields.sector ?? "Unknown";
  const priors = SECTOR_PRIORS[sector] ?? DEFAULT_PRIOR;
  const beta = isFiniteNumber(fundamentalShape.fields.beta) ? fundamentalShape.fields.beta : 1;
  const betaRisk = clamp((beta - 0.75) / 1.25, 0, 1);
  const domainRisk = clamp(
    priors.cyclicality * 0.34 + priors.rateSensitivity * 0.27 + betaRisk * 0.28 + (1 - priors.defensiveness) * 0.11,
    0,
    1,
  );
  const domainScore = weightedMean([
    { value: priors.moat * 100, weight: 0.28 },
    { value: priors.innovation * 100, weight: 0.22 },
    { value: priors.defensiveness * 100, weight: 0.2 },
    { value: (1 - domainRisk) * 100, weight: 0.3 },
  ]);

  return {
    score: domainScore,
    risk: domainRisk * 100,
    sector,
    industry: fundamentalShape.fields.industry ?? "Unknown",
    beta,
    priors,
  };
}

function seriesReturn(prices, lookback) {
  const clean = cleanPrices(prices);
  if (clean.length < lookback + 1) return 0;
  const closes = closesFrom(clean);
  const current = safeLast(closes);
  const previous = closes[closes.length - lookback - 1];
  return previous > 0 ? Math.log(current / previous) : 0;
}

function computeWeather(prices, marketContext = {}, coast) {
  const proxies = Object.fromEntries(
    Object.entries(marketContext)
      .filter(([, series]) => Array.isArray(series?.prices) && series.prices.length > 20)
      .map(([symbol, series]) => [symbol, cleanPrices(series.prices)]),
  );
  const spy = proxies.SPY ?? proxies["^GSPC"];
  const qqq = proxies.QQQ;
  const vix = proxies["^VIX"];
  const tnx = proxies["^TNX"];
  const dbc = proxies.DBC;
  const spy63 = spy ? seriesReturn(spy, 63) : 0;
  const spy126 = spy ? seriesReturn(spy, 126) : 0;
  const qqq63 = qqq ? seriesReturn(qqq, 63) : spy63;
  const vixClose = vix ? safeLast(closesFrom(vix)) : 20;
  const vixTrend = vix ? seriesReturn(vix, 21) : 0;
  const tnxChange = tnx ? seriesReturn(tnx, 63) : 0;
  const commodities63 = dbc ? seriesReturn(dbc, 63) : 0;
  const stockReturns = logReturns(prices);
  let marketBeta = coast.beta ?? 1;
  let marketCorrelation = 0;

  if (spy) {
    const spyReturns = logReturns(spy);
    const [stockAligned, spyAligned] = alignSeriesByDate(stockReturns, spyReturns);
    marketCorrelation = pearson(stockAligned, spyAligned);
    const spyVol = stdev(spyAligned);
    marketBeta = spyVol ? marketCorrelation * (stdev(stockAligned) / spyVol) : marketBeta;
  }

  const riskOnScore = weightedMean([
    { value: scoreFromZ(spy63, 0, 0.08), weight: 0.32 },
    { value: scoreFromZ(spy126, 0, 0.12), weight: 0.18 },
    { value: scoreFromZ(qqq63, 0, 0.1), weight: 0.16 },
    { value: 100 * (1 - sigmoid((vixClose - 22) / 7)), weight: 0.22 },
    { value: 100 * (1 - sigmoid((vixTrend - 0.02) / 0.12)), weight: 0.12 },
  ]);
  const ratePenalty = clamp(tnxChange / 0.2, -1, 1) * (coast.priors.rateSensitivity ?? 0.5) * 18;
  const inflationPressure = clamp(commodities63 / 0.12, -1, 1) * (coast.priors.cyclicality ?? 0.5) * 8;
  const score = clamp(riskOnScore - Math.max(0, ratePenalty) + inflationPressure, 0, 100);
  const risk = clamp((100 - riskOnScore) * 0.45 + Math.max(0, ratePenalty) * 1.7 + Math.max(0, vixClose - 18) * 1.4, 0, 100);

  return {
    score,
    risk,
    marketBeta,
    marketCorrelation,
    proxies: {
      spy63,
      spy126,
      qqq63,
      vixClose,
      vixTrend,
      tnxChange,
      commodities63,
    },
    availableProxies: Object.keys(proxies),
  };
}

function computeRisk(prices, wave, weather, wavePhysics) {
  const returnValues = logReturns(prices).map((point) => point.value);
  const recent = returnValues.slice(-Math.min(756, returnValues.length));
  const var95 = valueAtRisk(recent, 0.95);
  const cvar95 = conditionalValueAtRisk(recent, 0.95);
  const annualDownside = downsideDeviation(recent) * Math.sqrt(TRADING_DAYS);
  const riskScore = weightedMean([
    { value: clamp(wave.annualVolatility / 0.55, 0, 1) * 100, weight: 0.2 },
    { value: wave.breakRisk, weight: 0.17 },
    { value: wavePhysics.physicsBreakRisk, weight: 0.17 },
    { value: clamp(Math.abs(wave.drawdown252) / 0.45, 0, 1) * 100, weight: 0.16 },
    { value: weather.risk, weight: 0.17 },
    { value: clamp(Math.max(0, weather.marketBeta - 0.8) / 1.2, 0, 1) * 100, weight: 0.13 },
  ]);
  return {
    score: riskScore,
    annualVolatility: wave.annualVolatility,
    downsideDeviation: annualDownside,
    valueAtRisk95Daily: var95,
    conditionalValueAtRisk95Daily: cvar95,
    maxDrawdown: maxDrawdown(prices),
    drawdown252: wave.drawdown252,
    breakRisk: wave.breakRisk,
    physicsBreakRisk: wavePhysics.physicsBreakRisk,
    beta: weather.marketBeta,
  };
}

function computeDataProfile(prices) {
  const closes = closesFrom(prices);
  const latestClose = safeLast(closes);
  const recent = prices.slice(-Math.min(63, prices.length));
  const recentNotional = recent
    .map((point) => (point.adjClose ?? point.close) * (isFiniteNumber(point.volume) ? point.volume : 0))
    .filter((value) => value > 0);
  const zeroVolumeRatio = recent.length
    ? recent.filter((point) => !isFiniteNumber(point.volume) || point.volume <= 0).length / recent.length
    : 1;
  const medianNotionalVolume = median(recentNotional);
  const volumeDataAvailable = recentNotional.length > 0;
  const historyScore = clamp((prices.length - 80) / (756 - 80), 0, 1) * 100;
  const liquidityScore = volumeDataAvailable
    ? clamp((Math.log10(Math.max(1, medianNotionalVolume)) - 5) / 2, 0, 1) * 100
    : 20;
  const zeroVolumeScore = (1 - zeroVolumeRatio) * 100;
  const priceScore = latestClose < 1 ? 20 : latestClose < 5 ? 62 : 100;
  const reliabilityScore = clamp(
    weightedMean([
      { value: historyScore, weight: 0.35 },
      { value: liquidityScore, weight: 0.3 },
      { value: zeroVolumeScore, weight: 0.2 },
      { value: priceScore, weight: 0.15 },
    ]),
    0,
    100,
  );
  const flags = {
    shortHistory: prices.length < 252,
    limitedHistory: prices.length < 504,
    missingVolume: !volumeDataAvailable,
    thinLiquidity: volumeDataAvailable && medianNotionalVolume < 1_000_000,
    staleVolume: zeroVolumeRatio > 0.2,
    lowPrice: latestClose < 5,
  };
  const warnings = [
    flags.shortHistory ? "Model warning: less than one trading year of stock history; buying guidance is research-only." : null,
    !flags.shortHistory && flags.limitedHistory ? "Model warning: less than two trading years of stock history; cycle evidence is limited." : null,
    flags.missingVolume ? "Model warning: volume data is missing, so liquidity and break-stress signals are low-confidence." : null,
    flags.thinLiquidity ? "Model warning: recent median notional volume is below $1M; signals may be distorted by illiquidity." : null,
    flags.staleVolume ? "Model warning: recent zero-volume ratio is elevated; price formation may be stale or sparse." : null,
    flags.lowPrice ? "Model warning: low-priced securities can have nonlinear liquidity and gap risk." : null,
  ].filter(Boolean);

  return {
    observations: prices.length,
    latestClose,
    medianNotionalVolume,
    zeroVolumeRatio,
    volumeDataAvailable,
    reliabilityScore,
    historyScore,
    liquidityScore,
    flags,
    warnings,
  };
}

function computeForecast({ prices, wave, wavePhysics, fundamentalShape, coast, weather, risk, dataProfile, horizonDays }) {
  const currentPrice = wave.latestClose;
  const trendSignal = clamp(wave.momentumAnnual, -0.75, 0.75) * 0.28 + clamp(wave.trendAnnual, -0.75, 0.75) * 0.17;
  const reversionSignal = clamp(-wave.waveZ * wave.annualVolatility * 0.18, -0.22, 0.22);
  const physicsSignal =
    wavePhysics.directionBias * 0.13 +
    ((wavePhysics.formationScore - 50) / 50) * 0.08 +
    ((wavePhysics.tsunamiSetupScore - 50) / 50) * 0.07 -
    ((wavePhysics.physicsBreakRisk - 50) / 50) * 0.08;
  const factorSignal =
    ((fundamentalShape.score - 50) / 50) * 0.12 +
    ((weather.score - 50) / 50) * 0.1 +
    ((coast.score - 50) / 50) * 0.05 -
    ((wave.breakRisk - 50) / 50) * 0.08;
  const driftSignal = clamp(wave.annualDrift, -0.5, 0.5) * 0.13;
  const expectedAnnualLogReturn = clamp(trendSignal + reversionSignal + physicsSignal + factorSignal + driftSignal, -0.95, 0.95);
  const expectedLogReturn = expectedAnnualLogReturn * (horizonDays / TRADING_DAYS);
  const physicsVolatilityLoad = wavePhysics.physicsBreakRisk / 420 + Math.max(0, wavePhysics.rogueInstability - 55) / 800;
  const horizonVolatility = Math.max(
    0.015,
    wave.annualVolatility * Math.sqrt(horizonDays / TRADING_DAYS) * (1 + risk.score / 300 + physicsVolatilityLoad),
  );
  const targetPrice = currentPrice * Math.exp(expectedLogReturn);
  const interval68 = {
    low: currentPrice * Math.exp(expectedLogReturn - horizonVolatility),
    high: currentPrice * Math.exp(expectedLogReturn + horizonVolatility),
  };
  const interval90 = {
    low: currentPrice * Math.exp(expectedLogReturn - 1.645 * horizonVolatility),
    high: currentPrice * Math.exp(expectedLogReturn + 1.645 * horizonVolatility),
  };
  const signals = [
    wave.score - 50,
    wavePhysics.score - 50,
    fundamentalShape.score - 50,
    coast.score - 50,
    weather.score - 50,
    50 - risk.score,
  ];
  const absoluteSignal = mean(signals.map(Math.abs));
  const agreement = absoluteSignal ? clamp(Math.abs(mean(signals)) / absoluteSignal, 0, 1) : 0.5;
  const historyQuality = clamp(prices.length / 756, 0.2, 1);
  const liquidityQuality = clamp((dataProfile?.reliabilityScore ?? 70) / 100, 0.1, 1);
  const dataQuality =
    historyQuality * 0.45 +
    fundamentalShape.confidence * 0.2 +
    clamp(weather.availableProxies.length / 5, 0, 1) * 0.25 +
    liquidityQuality * 0.1;
  const confidence = clamp(
    18 +
      dataQuality * 30 +
      agreement * 16 +
      (wave.repetitiveness / 100) * 10 +
      (wavePhysics.rhythmScore / 100) * 10 +
      (wavePhysics.formationScore / 100) * 8 -
      (risk.score / 100) * 16 -
      ((100 - (dataProfile?.reliabilityScore ?? 70)) / 100) * 8,
    5,
    92,
  );
  const expectedReturnPct = Math.exp(expectedLogReturn) - 1;

  return {
    horizonDays,
    currentPrice,
    targetPrice,
    expectedReturnPct,
    expectedAnnualLogReturn,
    interval68,
    interval90,
    horizonVolatility,
    physicsSignal,
    confidence,
    agreement,
    dataQuality,
    thesis:
      expectedReturnPct > 0.05
        ? "constructive"
        : expectedReturnPct < -0.05
          ? "defensive"
          : "neutral",
  };
}

function computeBuyOpportunity({ forecast, wave, wavePhysics, weather, risk, compositeScore, dataProfile }) {
  const current = forecast.currentPrice;
  const upsidePct = forecast.expectedReturnPct;
  const pullbackPct = clamp(wave.atrPct * 1.6 + Math.max(0, wave.waveZ - 0.7) * 0.018, 0.025, 0.14);
  const breakoutPct = clamp(wave.atrPct * 1.1 + Math.max(0, 50 - wave.repetitiveness) / 2000, 0.018, 0.12);
  const invalidationPct = clamp(wave.atrPct * 3.2 + risk.score / 900, 0.06, 0.26);
  const pullbackEntry = current * (1 - pullbackPct);
  const breakoutConfirmation = current * (1 + breakoutPct);
  const invalidation = current * (1 - invalidationPct);
  const downsidePct = current > 0 ? Math.max(0, (current - invalidation) / current) : 0;
  const rewardRisk = downsidePct ? Math.max(0, upsidePct) / downsidePct : 0;
  const setupScore = weightedMean([
    { value: scoreFromZ(upsidePct, 0.02, 0.06), weight: 0.25 },
    { value: forecast.confidence, weight: 0.17 },
    { value: compositeScore, weight: 0.18 },
    { value: 100 - risk.score, weight: 0.17 },
    { value: wavePhysics.score, weight: 0.14 },
    { value: weather.score, weight: 0.09 },
  ]);
  const overextended = wave.waveZ > 1.35 || wave.rsi > 67;
  const hiddenWave = wavePhysics.tsunamiSetupScore >= 68 && wavePhysics.directionBias > 0.12;
  const constructive = upsidePct > 0.025 && setupScore >= 56 && risk.score < 68;
  const strong = upsidePct > 0.07 && setupScore >= 63 && risk.score < 58 && rewardRisk >= 0.55;
  const avoid = upsidePct < -0.035 || (risk.score > 74 && setupScore < 58) || compositeScore < 40;

  let action = "Watchlist only";
  let tone = "neutral";
  let summary = "No clear buying opportunity yet.";

  if (avoid) {
    action = "Avoid / reduce";
    tone = "negative";
    summary = "Risk or downside pressure dominates the modeled setup.";
  } else if (strong && !overextended) {
    action = "Buyable now";
    tone = "positive";
    summary = "The forecast, risk, and formation signals are aligned enough for a current-price entry.";
  } else if (constructive && overextended) {
    action = "Wait for pullback";
    tone = "neutral";
    summary = "The setup is constructive, but the current wave is stretched. Let it reset before entry.";
  } else if (constructive) {
    action = "Starter / confirmation";
    tone = "positive";
    summary = "A small starter or a breakout confirmation is supported, but risk sizing matters.";
  } else if (hiddenWave) {
    action = "Speculative hidden-wave watch";
    tone = "neutral";
    summary = "The physics layer sees a stored-energy pattern, but the broader setup is not confirmed.";
  }

  const dataLimited = dataProfile?.flags?.shortHistory;
  const liquidityLimited = dataProfile?.flags?.missingVolume || dataProfile?.flags?.thinLiquidity || dataProfile?.flags?.staleVolume;
  if (!avoid && dataLimited) {
    action = "Data quality watch";
    tone = "neutral";
    summary = "The setup is research-only because the listed trading history is too short for a full wave regime read.";
  } else if (!avoid && liquidityLimited) {
    action = "Liquidity watch";
    tone = "neutral";
    summary = "The setup is not buy-rated because liquidity or volume quality is limiting signal reliability.";
  }

  const reasons = [
    upsidePct > 0
      ? `Modeled ${forecast.horizonDays}d upside is ${(upsidePct * 100).toFixed(1)}%.`
      : `Modeled ${forecast.horizonDays}d return is ${(upsidePct * 100).toFixed(1)}%.`,
    `Risk score is ${risk.score.toFixed(0)} and confidence is ${forecast.confidence.toFixed(0)}%.`,
    hiddenWave
      ? `Hidden-wave score is elevated at ${wavePhysics.tsunamiSetupScore.toFixed(0)}.`
      : `Hidden-wave score is ${wavePhysics.tsunamiSetupScore.toFixed(0)}, not a strong tsunami setup.`,
    overextended
      ? `Current wave is stretched: wave z ${wave.waveZ.toFixed(2)}, RSI ${wave.rsi.toFixed(0)}.`
      : `Current wave is not severely stretched: wave z ${wave.waveZ.toFixed(2)}, RSI ${wave.rsi.toFixed(0)}.`,
    dataProfile?.reliabilityScore < 65
      ? `Data reliability is constrained at ${dataProfile.reliabilityScore.toFixed(0)}/100.`
      : `Data reliability is ${dataProfile?.reliabilityScore.toFixed(0) ?? "--"}/100.`,
  ];

  return {
    action,
    tone,
    summary,
    setupScore,
    rewardRisk,
    levels: {
      current,
      pullbackEntry,
      breakoutConfirmation,
      invalidation,
      target: forecast.targetPrice,
    },
    flags: {
      overextended,
      hiddenWave,
      constructive,
      strong,
      avoid,
    },
    reasons,
  };
}

export function analyzeInstrument({ symbol, prices, quote = {}, marketContext = {}, horizonDays = 30 }) {
  const clean = cleanPrices(prices);
  if (clean.length < 80) {
    throw new Error("At least 80 trading days are required for inv-wave analysis.");
  }

  const wave = computeWave(clean);
  const fundamentalShape = computeFundamentalShape(quote);
  const coast = computeCoast(fundamentalShape);
  const weather = computeWeather(clean, marketContext, coast);
  const wavePhysics = computeWavePhysics({ prices: clean, coast, weather });
  const risk = computeRisk(clean, wave, weather, wavePhysics);
  const dataProfile = computeDataProfile(clean);
  const compositeScore = weightedMean([
    { value: wave.score, weight: 0.24 },
    { value: wavePhysics.score, weight: 0.16 },
    { value: fundamentalShape.score, weight: 0.21 },
    { value: coast.score, weight: 0.11 },
    { value: weather.score, weight: 0.16 },
    { value: 100 - risk.score, weight: 0.12 },
  ]);
  const forecast = computeForecast({
    prices: clean,
    wave,
    wavePhysics,
    fundamentalShape,
    coast,
    weather,
    risk,
    dataProfile,
    horizonDays,
  });
  const buyOpportunity = computeBuyOpportunity({
    forecast,
    wave,
    wavePhysics,
    weather,
    risk,
    compositeScore,
    dataProfile,
  });

  return {
    symbol,
    generatedAt: new Date().toISOString(),
    observations: clean.length,
    asOf: clean[clean.length - 1].date,
    currency: quote?.quote?.currency ?? quote?.meta?.currency ?? "USD",
    name: fundamentalShape.fields.shortName ?? quote?.meta?.shortName ?? symbol,
    compositeScore,
    posture:
      buyOpportunity.tone === "positive" &&
      (compositeScore >= 64 ||
        (wavePhysics.tsunamiSetupScore >= 72 && wavePhysics.directionBias > 0.2 && risk.score < 74))
        ? "accumulate"
        : buyOpportunity.tone === "negative" || (compositeScore <= 42 && forecast.expectedReturnPct < 0)
          ? "reduce"
          : "watch",
    forecast,
    buyOpportunity,
    wave,
    wavePhysics,
    fundamentalShape,
    coast,
    weather,
    risk,
    dataProfile,
    modelWarnings: dataProfile.warnings,
    priceHistory: clean.slice(-420).map((point) => ({
      date: point.date,
      close: point.adjClose ?? point.close,
      volume: point.volume,
    })),
  };
}

function sliceMarketContext(marketContext, asOfDate) {
  const sliced = {};
  const asOf = new Date(asOfDate).getTime();
  for (const [symbol, value] of Object.entries(marketContext ?? {})) {
    if (!Array.isArray(value?.prices)) continue;
    sliced[symbol] = {
      ...value,
      prices: value.prices.filter((point) => new Date(point.date).getTime() <= asOf),
    };
  }
  return sliced;
}

export function runBacktest({
  symbol,
  prices,
  quote = {},
  marketContext = {},
  horizonDays = 30,
  trainingDays = 504,
  stepDays = 30,
  useCurrentFundamentals = false,
} = {}) {
  const clean = cleanPrices(prices);
  if (clean.length < trainingDays + horizonDays + 20) {
    throw new Error(`Backtest needs at least ${trainingDays + horizonDays + 20} trading days.`);
  }
  const trades = [];
  const validationWarnings = [
    useCurrentFundamentals
      ? "Backtest uses the current quote/fundamental snapshot; results can contain lookahead bias."
      : "Backtest excludes current quote/fundamental fields to avoid lookahead bias; historical validation is price/macro/physics focused.",
    stepDays < horizonDays
      ? `Backtest windows overlap because step days (${stepDays}) are below horizon days (${horizonDays}); metrics are not independent samples.`
      : null,
  ].filter(Boolean);
  const historicalQuote = useCurrentFundamentals ? quote : {};

  for (let index = trainingDays; index < clean.length - horizonDays; index += stepDays) {
    const window = clean.slice(0, index + 1);
    const current = clean[index].adjClose ?? clean[index].close;
    const future = clean[index + horizonDays].adjClose ?? clean[index + horizonDays].close;
    const marketSlice = sliceMarketContext(marketContext, clean[index].date);
    const analysis = analyzeInstrument({
      symbol,
      prices: window,
      quote: historicalQuote,
      marketContext: marketSlice,
      horizonDays,
    });
    const predictedReturn = Math.log(analysis.forecast.targetPrice / current);
    const actualReturn = Math.log(future / current);
    trades.push({
      asOf: clean[index].date,
      exitDate: clean[index + horizonDays].date,
      currentPrice: current,
      predictedTarget: analysis.forecast.targetPrice,
      actualPrice: future,
      predictedReturn,
      actualReturn,
      confidence: analysis.forecast.confidence,
      compositeScore: analysis.compositeScore,
      predictedDirection: Math.sign(predictedReturn),
      actualDirection: Math.sign(actualReturn),
      physicsScore: analysis.wavePhysics.score,
      physicsFormationScore: analysis.wavePhysics.formationScore,
      tsunamiSetupScore: analysis.wavePhysics.tsunamiSetupScore,
      physicsDirectionBias: analysis.wavePhysics.directionBias,
      physicsBreakRisk: analysis.wavePhysics.physicsBreakRisk,
      setupStage: analysis.wavePhysics.setupStage,
      interval68Low: analysis.forecast.interval68.low,
      interval68High: analysis.forecast.interval68.high,
    });
  }

  const predicted = trades.map((trade) => trade.predictedReturn);
  const actual = trades.map((trade) => trade.actualReturn);
  const errors = trades.map((trade) => trade.predictedReturn - trade.actualReturn);
  const absoluteErrors = errors.map(Math.abs);
  const directionHits = trades.filter((trade) => trade.predictedDirection === trade.actualDirection || Math.abs(trade.actualReturn) < 0.005).length;
  const intervalHits = trades.filter((trade) => trade.actualPrice >= trade.interval68Low && trade.actualPrice <= trade.interval68High).length;
  const longBiasTrades = trades.filter((trade) => trade.predictedReturn > 0);
  const shortOrAvoidTrades = trades.filter((trade) => trade.predictedReturn <= 0);
  const physicsConstructiveTrades = trades.filter((trade) => trade.physicsScore >= 58 && trade.physicsDirectionBias > 0.12);
  const tsunamiSetupTrades = trades.filter((trade) => trade.tsunamiSetupScore >= 64 && trade.physicsDirectionBias > 0.08);

  return {
    symbol,
    horizonDays,
    trainingDays,
    stepDays,
    sampleSize: trades.length,
    validation: {
      mode: useCurrentFundamentals ? "current_fundamentals" : "price_macro_physics_only",
      avoidsCurrentFundamentalLookahead: !useCurrentFundamentals,
      windowsOverlap: stepDays < horizonDays,
    },
    validationWarnings,
    metrics: {
      meanAbsoluteError: mean(absoluteErrors),
      rootMeanSquareError: Math.sqrt(mean(errors.map((value) => value ** 2))),
      bias: mean(errors),
      informationCoefficient: pearson(predicted, actual),
      directionalAccuracy: trades.length ? directionHits / trades.length : 0,
      interval68HitRate: trades.length ? intervalHits / trades.length : 0,
      averagePredictedReturn: mean(predicted),
      averageActualReturn: mean(actual),
      hitRateWhenConstructive: longBiasTrades.length
        ? longBiasTrades.filter((trade) => trade.actualReturn > 0).length / longBiasTrades.length
        : 0,
      avoidHitRate: shortOrAvoidTrades.length
        ? shortOrAvoidTrades.filter((trade) => trade.actualReturn <= 0).length / shortOrAvoidTrades.length
        : 0,
      physicsConstructiveCount: physicsConstructiveTrades.length,
      physicsConstructiveHitRate: physicsConstructiveTrades.length
        ? physicsConstructiveTrades.filter((trade) => trade.actualReturn > 0).length / physicsConstructiveTrades.length
        : 0,
      tsunamiSetupCount: tsunamiSetupTrades.length,
      tsunamiSetupHitRate: tsunamiSetupTrades.length
        ? tsunamiSetupTrades.filter((trade) => trade.actualReturn > 0).length / tsunamiSetupTrades.length
        : 0,
      averageActualReturnWhenTsunami: tsunamiSetupTrades.length
        ? mean(tsunamiSetupTrades.map((trade) => trade.actualReturn))
        : 0,
      p90AbsoluteError: quantile(absoluteErrors, 0.9),
    },
    trades,
  };
}

export const __private__ = {
  cleanPrices,
  computeWave,
  computeFundamentalShape,
  computeCoast,
  computeWeather,
  computeWavePhysics,
  computeDataProfile,
  detectDominantCycle,
};
