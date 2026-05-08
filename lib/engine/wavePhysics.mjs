import {
  TRADING_DAYS,
  annualizedVolatility,
  clamp,
  ema,
  isFiniteNumber,
  linearRegression,
  logReturns,
  maxDrawdown,
  mean,
  median,
  quantile,
  safeLast,
  scoreFromZ,
  sigmoid,
  stdev,
  trueRangeSeries,
  weightedMean,
  zScore,
} from "./statistics.mjs";

function closesFrom(prices) {
  return prices.map((point) => point.adjClose ?? point.close).filter((value) => isFiniteNumber(value) && value > 0);
}

function volumeValuesFrom(prices) {
  return prices.map((point) => point.volume).filter((value) => isFiniteNumber(value) && value > 0);
}

function detrendedLogWindow(prices, maxWindow = 520) {
  const closes = closesFrom(prices);
  const logCloses = closes.map((value) => Math.log(value));
  const window = logCloses.slice(-Math.min(maxWindow, logCloses.length));
  if (window.length < 40) {
    return {
      logCloses,
      window,
      residuals: window.map((value) => value - mean(window)),
    };
  }
  const trend = linearRegression(window);
  return {
    logCloses,
    window,
    residuals: window.map((value, index) => value - (trend.intercept + trend.slope * index)),
  };
}

function computeSpectrum(residuals) {
  const n = residuals.length;
  const centered = residuals.map((value) => value - mean(residuals));
  const minPeriod = 5;
  const maxPeriod = Math.min(180, Math.floor(n / 2));
  const spectrum = [];

  for (let period = minPeriod; period <= maxPeriod; period += 1) {
    const omega = (2 * Math.PI) / period;
    let cosSum = 0;
    let sinSum = 0;
    for (let index = 0; index < centered.length; index += 1) {
      cosSum += centered[index] * Math.cos(omega * index);
      sinSum += centered[index] * Math.sin(omega * index);
    }
    const power = (cosSum ** 2 + sinSum ** 2) / Math.max(1, n);
    spectrum.push({
      period,
      frequency: 1 / period,
      power,
      phase: Math.atan2(sinSum, cosSum),
    });
  }

  const totalPower = spectrum.reduce((sum, point) => sum + point.power, 0) || 1;
  const weighted = spectrum.map((point) => ({
    ...point,
    share: point.power / totalPower,
  }));
  const peak = [...weighted].sort((left, right) => right.power - left.power)[0] ?? {
    period: 21,
    frequency: 1 / 21,
    power: 0,
    share: 0,
    phase: 0,
  };
  const entropy = weighted.length
    ? -weighted.reduce((sum, point) => sum + (point.share > 0 ? point.share * Math.log(point.share) : 0), 0) /
      Math.log(weighted.length)
    : 1;
  const meanFrequency = weighted.reduce((sum, point) => sum + point.frequency * point.share, 0);
  const frequencySecondMoment = weighted.reduce((sum, point) => sum + point.frequency ** 2 * point.share, 0);
  const spectralBandwidth = meanFrequency
    ? Math.sqrt(Math.max(0, frequencySecondMoment / meanFrequency ** 2 - 1))
    : 1;
  const localPowers = weighted
    .filter((point) => Math.abs(point.period - peak.period) <= Math.max(4, Math.round(peak.period * 0.08)))
    .map((point) => point.power);
  const jonswapPeakEnhancement = peak.power / Math.max(1e-12, median(localPowers));

  return {
    points: weighted.sort((left, right) => left.period - right.period),
    peakPeriod: peak.period,
    peakFrequency: peak.frequency,
    peakPowerShare: peak.share,
    peakPhase: peak.phase,
    spectralEntropy: entropy,
    spectralBandwidth,
    spectralConcentration: clamp(1 - entropy, 0, 1),
    jonswapPeakEnhancement,
  };
}

function rollingVol(values, window) {
  if (values.length < 3) return 0;
  return annualizedVolatility(values.slice(-Math.min(window, values.length)));
}

function findRetrievalState(prices) {
  const closes = closesFrom(prices);
  const lookback = Math.min(252, closes.length);
  const window = closes.slice(-lookback);
  const current = safeLast(closes);
  const trough = Math.min(...window);
  const troughIndex = window.indexOf(trough);
  const preTroughHigh = Math.max(...window.slice(0, troughIndex + 1));
  const postTroughHigh = Math.max(...window.slice(troughIndex));
  const retrievalDepth = preTroughHigh > 0 && trough > 0 ? Math.log(preTroughHigh / trough) : 0;
  const recoveryFromTrough = trough > 0 && current > 0 ? Math.log(current / trough) : 0;
  const remainingDistanceToCrest = preTroughHigh > 0 && current > 0 ? Math.max(0, Math.log(preTroughHigh / current)) : 0;
  const troughAge = lookback - troughIndex - 1;
  const recoveryCompletion = retrievalDepth ? clamp(recoveryFromTrough / retrievalDepth, 0, 1.5) : 0;

  return {
    retrievalDepth,
    recoveryFromTrough,
    remainingDistanceToCrest,
    recoveryCompletion,
    troughAge,
    troughPrice: trough,
    preTroughHigh,
    postTroughHigh,
  };
}

function classifyBreaker(xi, breakRisk, tsunamiScore, netEnergyFlux) {
  if (tsunamiScore >= 68 && netEnergyFlux > 8 && breakRisk < 72) return "tsunami precursor";
  if (breakRisk >= 76) return "collapsing break";
  if (xi < 0.45) return "spilling";
  if (xi < 1.8) return "plunging";
  return "surging";
}

function classifySetupStage({ tsunamiScore, compressionScore, ignitionScore, breakRisk, recoveryCompletion, netEnergyFlux }) {
  if (breakRisk >= 78 && recoveryCompletion > 0.95) return "spent break";
  if (tsunamiScore >= 72 && ignitionScore >= 58) return "ignition";
  if (tsunamiScore >= 64 && compressionScore >= 58) return "silent retrieval";
  if (netEnergyFlux >= 18) return "energy build";
  if (breakRisk >= 66) return "unstable crest";
  return "ordinary swell";
}

export function computeWavePhysics({ prices, coast, weather }) {
  const closes = closesFrom(prices);
  const latestClose = safeLast(closes);
  const { residuals, logCloses } = detrendedLogWindow(prices);
  const spectrum = computeSpectrum(residuals);
  const returnSeries = logReturns(prices).map((point) => point.value);
  const recentReturns = returnSeries.slice(-Math.min(252, returnSeries.length));
  const vol21 = rollingVol(returnSeries, 21);
  const vol63 = rollingVol(returnSeries, 63);
  const vol126 = rollingVol(returnSeries, 126);
  const vol252 = rollingVol(returnSeries, 252);
  const volBaseline = Math.max(0.01, median([vol63, vol126, vol252].filter((value) => value > 0)));
  const compressionRatio = vol21 / volBaseline;
  const compressionScore = clamp((1.18 - compressionRatio) / 0.78, 0, 1) * 100;
  const ranges = trueRangeSeries(prices).map((point) => point.value);
  const atr = safeLast(ema(ranges, 14), 0);
  const atrPct = latestClose ? atr / latestClose : 0;
  const atrPctSeries = ranges.map((value, index) => {
    const close = closes[index] ?? latestClose;
    return close ? value / close : 0;
  });
  const atrExpansion = atrPct / Math.max(0.0001, median(atrPctSeries.slice(-126)));
  const volumes = volumeValuesFrom(prices);
  const currentVolume = safeLast(volumes, 0);
  const volumeZ = zScore(currentVolume, volumes.slice(-63));
  const significantMoveHeight = 4 * stdev(residuals);
  const significantMovePct = Math.exp(significantMoveHeight) - 1;
  const waveNumber = (2 * Math.PI) / Math.max(1, spectrum.peakPeriod);
  const waveSteepness = (waveNumber * significantMoveHeight) / 2;
  const steepnessPressure = clamp(waveSteepness / 0.03, 0, 1) * 100;
  const benjaminFeirIndex = Math.SQRT2 * (waveSteepness / Math.max(0.035, spectrum.spectralBandwidth));
  const rogueInstability = clamp(benjaminFeirIndex / 0.22, 0, 1) * 100;
  const retrieval = findRetrievalState(prices);
  const recentMomentum21 = logCloses.length > 22 ? safeLast(logCloses) - logCloses[logCloses.length - 22] : 0;
  const recentMomentum63 = logCloses.length > 64 ? safeLast(logCloses) - logCloses[logCloses.length - 64] : 0;
  const ignitionScore = weightedMean([
    { value: scoreFromZ(recentMomentum21, 0, Math.max(0.03, vol21 / Math.sqrt(TRADING_DAYS) * Math.sqrt(21))), weight: 0.42 },
    { value: scoreFromZ(recentMomentum63, 0, Math.max(0.06, vol63 / Math.sqrt(TRADING_DAYS) * Math.sqrt(63))), weight: 0.28 },
    { value: clamp(Math.max(0, volumeZ) / 2.8, 0, 1) * 100, weight: 0.18 },
    { value: clamp((weather?.score ?? 50) / 100, 0, 1) * 100, weight: 0.12 },
  ]);
  const storedEnergyScore = weightedMean([
    { value: clamp(retrieval.retrievalDepth / 0.45, 0, 1) * 100, weight: 0.38 },
    { value: clamp(Math.abs(maxDrawdown(prices.slice(-252))) / 0.45, 0, 1) * 100, weight: 0.32 },
    { value: clamp(significantMovePct / 0.7, 0, 1) * 100, weight: 0.3 },
  ]);
  const rhythmScore = weightedMean([
    { value: clamp(spectrum.peakPowerShare / 0.055, 0, 1) * 100, weight: 0.38 },
    { value: clamp((1 - spectrum.spectralBandwidth) / 0.72, 0, 1) * 100, weight: 0.32 },
    { value: clamp(spectrum.jonswapPeakEnhancement / 2.2, 0, 1) * 100, weight: 0.3 },
  ]);
  const recoveryWindowScore = clamp(1 - Math.abs(retrieval.recoveryCompletion - 0.58) / 0.58, 0, 1) * 100;
  const notYetSpentScore = clamp(1 - Math.max(0, retrieval.recoveryCompletion - 1.05) / 0.45, 0, 1) * 100;
  const tsunamiSetupScore = weightedMean([
    { value: storedEnergyScore, weight: 0.28 },
    { value: rhythmScore, weight: 0.22 },
    { value: compressionScore, weight: 0.18 },
    { value: recoveryWindowScore, weight: 0.14 },
    { value: ignitionScore, weight: 0.12 },
    { value: notYetSpentScore, weight: 0.06 },
  ]);
  const coastSlope = clamp(((coast?.risk ?? 45) / 100) * 0.7 + Math.max(0, (weather?.marketBeta ?? 1) - 0.8) * 0.18, 0.15, 1.25);
  const surfSimilarity = coastSlope / Math.sqrt(Math.max(0.02, steepnessPressure / 100));
  const shoalingGain = weightedMean([
    { value: clamp((1.15 - compressionRatio) / 0.9, 0, 1) * 100, weight: 0.28 },
    { value: clamp((coast?.risk ?? 45) / 100, 0, 1) * 100, weight: 0.22 },
    { value: clamp(Math.max(0, (weather?.marketBeta ?? 1) - 0.75) / 1.25, 0, 1) * 100, weight: 0.24 },
    { value: clamp(Math.max(0, 0.2 - Math.min(0.2, spectrum.spectralBandwidth)) / 0.2, 0, 1) * 100, weight: 0.26 },
  ]);
  const windInput = weightedMean([
    { value: ignitionScore, weight: 0.4 },
    { value: clamp((weather?.score ?? 50) / 100, 0, 1) * 100, weight: 0.25 },
    { value: clamp(Math.max(0, volumeZ + 0.4) / 3.2, 0, 1) * 100, weight: 0.18 },
    { value: scoreFromZ(recentMomentum63, 0, 0.16), weight: 0.17 },
  ]);
  const nonlinearTransfer = weightedMean([
    { value: rogueInstability, weight: 0.4 },
    { value: rhythmScore, weight: 0.35 },
    { value: clamp(spectrum.peakPowerShare / 0.07, 0, 1) * 100, weight: 0.25 },
  ]);
  const whitecappingDissipation = weightedMean([
    { value: clamp((atrExpansion - 0.85) / 1.35, 0, 1) * 100, weight: 0.38 },
    { value: steepnessPressure, weight: 0.25 },
    { value: clamp(Math.max(0, retrieval.recoveryCompletion - 0.95) / 0.55, 0, 1) * 100, weight: 0.22 },
    { value: clamp(vol21 / Math.max(0.01, vol126) - 0.75, 0, 1) * 100, weight: 0.15 },
  ]);
  const bottomFriction = weightedMean([
    { value: 100 - (weather?.score ?? 50), weight: 0.45 },
    { value: coast?.risk ?? 45, weight: 0.25 },
    { value: clamp(Math.max(0, (weather?.marketBeta ?? 1) - 1.2) / 1, 0, 1) * 100, weight: 0.3 },
  ]);
  const netEnergyFlux = clamp(
    windInput * 0.3 + nonlinearTransfer * 0.22 + shoalingGain * 0.2 - whitecappingDissipation * 0.25 - bottomFriction * 0.17,
    -100,
    100,
  );
  const physicsBreakRisk = weightedMean([
    { value: steepnessPressure, weight: 0.24 },
    { value: rogueInstability, weight: 0.2 },
    { value: whitecappingDissipation, weight: 0.24 },
    { value: clamp((atrExpansion - 0.75) / 1.4, 0, 1) * 100, weight: 0.16 },
    { value: clamp(Math.abs(maxDrawdown(prices.slice(-126))) / 0.32, 0, 1) * 100, weight: 0.16 },
  ]);
  const directionBias = clamp(
    recentMomentum63 * 180 + netEnergyFlux / 55 + (tsunamiSetupScore - 50) / 70 - (whitecappingDissipation - 50) / 95,
    -1,
    1,
  );
  const formationScore = weightedMean([
    { value: tsunamiSetupScore, weight: 0.34 },
    { value: clamp((netEnergyFlux + 30) / 70, 0, 1) * 100, weight: 0.22 },
    { value: rhythmScore, weight: 0.16 },
    { value: 100 - physicsBreakRisk, weight: 0.18 },
    { value: ignitionScore, weight: 0.1 },
  ]);
  const score = clamp(50 + directionBias * 18 + (formationScore - 50) * 0.28 - Math.max(0, physicsBreakRisk - 65) * 0.16, 0, 100);
  const breakerType = classifyBreaker(surfSimilarity, physicsBreakRisk, tsunamiSetupScore, netEnergyFlux);
  const setupStage = classifySetupStage({
    tsunamiScore: tsunamiSetupScore,
    compressionScore,
    ignitionScore,
    breakRisk: physicsBreakRisk,
    recoveryCompletion: retrieval.recoveryCompletion,
    netEnergyFlux,
  });

  return {
    score,
    formationScore,
    directionBias,
    setupStage,
    breakerType,
    spectralPeakPeriod: spectrum.peakPeriod,
    spectralPeakPowerShare: spectrum.peakPowerShare,
    spectralBandwidth: spectrum.spectralBandwidth,
    spectralConcentration: spectrum.spectralConcentration,
    spectralEntropy: spectrum.spectralEntropy,
    jonswapPeakEnhancement: spectrum.jonswapPeakEnhancement,
    significantMoveHeight,
    significantMovePct,
    waveSteepness,
    steepnessPressure,
    benjaminFeirIndex,
    rogueInstability,
    surfSimilarity,
    tsunamiSetupScore,
    compressionRatio,
    compressionScore,
    ignitionScore,
    storedEnergyScore,
    rhythmScore,
    shoalingGain,
    physicsBreakRisk,
    netEnergyFlux,
    sourceTermBudget: {
      windInput,
      nonlinearTransfer,
      shoalingGain,
      whitecappingDissipation,
      bottomFriction,
      netEnergyFlux,
    },
    retrieval,
    volatility: {
      vol21,
      vol63,
      vol126,
      vol252,
      compressionRatio,
      atrPct,
      atrExpansion,
    },
    spectrum: spectrum.points
      .sort((left, right) => right.power - left.power)
      .slice(0, 12)
      .map((point) => ({
        period: point.period,
        frequency: point.frequency,
        powerShare: point.share,
        phase: point.phase,
      })),
    notes: [
      tsunamiSetupScore >= 68
        ? "Stored drawdown energy, compression, and rhythm are aligned."
        : "No strong hidden-wave precursor from the current tape.",
      physicsBreakRisk >= 70
        ? "Steepness and dissipation imply high break risk."
        : "Break stress is not the dominant physics signal.",
      spectrum.spectralBandwidth < 0.35
        ? "Energy is narrow-band and more rhythm-like."
        : "Energy is broad-band and less tsunami-like.",
    ],
  };
}
