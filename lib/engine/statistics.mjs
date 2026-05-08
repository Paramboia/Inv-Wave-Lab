export const TRADING_DAYS = 252;

export function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function clamp(value, min = 0, max = 1) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function mean(values) {
  const clean = values.filter(isFiniteNumber);
  if (!clean.length) return 0;
  return clean.reduce((sum, value) => sum + value, 0) / clean.length;
}

export function median(values) {
  const clean = values.filter(isFiniteNumber).sort((a, b) => a - b);
  if (!clean.length) return 0;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
}

export function variance(values) {
  const clean = values.filter(isFiniteNumber);
  if (clean.length < 2) return 0;
  const avg = mean(clean);
  return clean.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (clean.length - 1);
}

export function stdev(values) {
  return Math.sqrt(Math.max(0, variance(values)));
}

export function quantile(values, q) {
  const clean = values.filter(isFiniteNumber).sort((a, b) => a - b);
  if (!clean.length) return 0;
  const position = clamp(q, 0, 1) * (clean.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return clean[lower];
  return clean[lower] + (clean[upper] - clean[lower]) * (position - lower);
}

export function percentileRank(values, current) {
  const clean = values.filter(isFiniteNumber);
  if (!clean.length || !Number.isFinite(current)) return 0.5;
  const below = clean.filter((value) => value <= current).length;
  return below / clean.length;
}

export function zScore(value, values) {
  const sigma = stdev(values);
  if (!sigma) return 0;
  return (value - mean(values)) / sigma;
}

export function sigmoid(value) {
  return 1 / (1 + Math.exp(-value));
}

export function scoreFromZ(value, midpoint = 0, scale = 1) {
  return 100 * sigmoid((value - midpoint) / Math.max(scale, 1e-9));
}

export function weightedMean(parts) {
  const clean = parts.filter((part) => Number.isFinite(part.value) && Number.isFinite(part.weight) && part.weight > 0);
  const totalWeight = clean.reduce((sum, part) => sum + part.weight, 0);
  if (!totalWeight) return 0;
  return clean.reduce((sum, part) => sum + part.value * part.weight, 0) / totalWeight;
}

export function logReturns(prices) {
  const returns = [];
  for (let index = 1; index < prices.length; index += 1) {
    const previous = prices[index - 1].adjClose ?? prices[index - 1].close;
    const current = prices[index].adjClose ?? prices[index].close;
    if (previous > 0 && current > 0) {
      returns.push({
        date: prices[index].date,
        value: Math.log(current / previous),
      });
    }
  }
  return returns;
}

export function simpleReturns(prices) {
  const returns = [];
  for (let index = 1; index < prices.length; index += 1) {
    const previous = prices[index - 1].adjClose ?? prices[index - 1].close;
    const current = prices[index].adjClose ?? prices[index].close;
    if (previous > 0 && current > 0) {
      returns.push({
        date: prices[index].date,
        value: current / previous - 1,
      });
    }
  }
  return returns;
}

export function ema(values, period) {
  if (!values.length) return [];
  const alpha = 2 / (period + 1);
  const output = [values[0]];
  for (let index = 1; index < values.length; index += 1) {
    output.push(alpha * values[index] + (1 - alpha) * output[index - 1]);
  }
  return output;
}

export function rolling(values, window, reducer) {
  const output = [];
  for (let index = 0; index < values.length; index += 1) {
    const start = Math.max(0, index - window + 1);
    output.push(reducer(values.slice(start, index + 1), index));
  }
  return output;
}

export function linearRegression(values) {
  const clean = values
    .map((value, index) => ({ x: index, y: value }))
    .filter((point) => isFiniteNumber(point.y));
  if (clean.length < 2) return { slope: 0, intercept: clean[0]?.y ?? 0, r2: 0 };
  const avgX = mean(clean.map((point) => point.x));
  const avgY = mean(clean.map((point) => point.y));
  const numerator = clean.reduce((sum, point) => sum + (point.x - avgX) * (point.y - avgY), 0);
  const denominator = clean.reduce((sum, point) => sum + (point.x - avgX) ** 2, 0);
  const slope = denominator ? numerator / denominator : 0;
  const intercept = avgY - slope * avgX;
  const residuals = clean.map((point) => point.y - (intercept + slope * point.x));
  const ssResidual = residuals.reduce((sum, value) => sum + value ** 2, 0);
  const ssTotal = clean.reduce((sum, point) => sum + (point.y - avgY) ** 2, 0);
  return {
    slope,
    intercept,
    r2: ssTotal ? clamp(1 - ssResidual / ssTotal, 0, 1) : 0,
  };
}

export function pearson(left, right) {
  const pairs = [];
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (isFiniteNumber(left[index]) && isFiniteNumber(right[index])) pairs.push([left[index], right[index]]);
  }
  if (pairs.length < 3) return 0;
  const leftMean = mean(pairs.map(([value]) => value));
  const rightMean = mean(pairs.map(([, value]) => value));
  let numerator = 0;
  let leftDenominator = 0;
  let rightDenominator = 0;
  for (const [leftValue, rightValue] of pairs) {
    const leftDelta = leftValue - leftMean;
    const rightDelta = rightValue - rightMean;
    numerator += leftDelta * rightDelta;
    leftDenominator += leftDelta ** 2;
    rightDenominator += rightDelta ** 2;
  }
  const denominator = Math.sqrt(leftDenominator * rightDenominator);
  return denominator ? clamp(numerator / denominator, -1, 1) : 0;
}

export function autocorrelation(values, lag) {
  if (lag <= 0 || values.length <= lag + 2) return 0;
  return pearson(values.slice(0, -lag), values.slice(lag));
}

export function maxDrawdown(prices) {
  let peak = -Infinity;
  let maxDd = 0;
  for (const point of prices) {
    const value = point.adjClose ?? point.close;
    if (!isFiniteNumber(value) || value <= 0) continue;
    peak = Math.max(peak, value);
    if (peak > 0) maxDd = Math.min(maxDd, value / peak - 1);
  }
  return maxDd;
}

export function downsideDeviation(values, threshold = 0) {
  const downside = values.filter((value) => value < threshold).map((value) => value - threshold);
  if (!downside.length) return 0;
  return Math.sqrt(downside.reduce((sum, value) => sum + value ** 2, 0) / downside.length);
}

export function trueRangeSeries(prices) {
  const ranges = [];
  for (let index = 0; index < prices.length; index += 1) {
    const point = prices[index];
    const previousClose = index > 0 ? prices[index - 1].close : point.close;
    if (![point.high, point.low, point.close, previousClose].every(isFiniteNumber)) continue;
    ranges.push({
      date: point.date,
      value: Math.max(
        point.high - point.low,
        Math.abs(point.high - previousClose),
        Math.abs(point.low - previousClose),
      ),
    });
  }
  return ranges;
}

export function rsi(closes, period = 14) {
  if (closes.length <= period) return 50;
  let gains = 0;
  let losses = 0;
  const start = closes.length - period;
  for (let index = start + 1; index < closes.length; index += 1) {
    const delta = closes[index] - closes[index - 1];
    if (delta >= 0) gains += delta;
    else losses -= delta;
  }
  if (!losses) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

export function annualizedVolatility(logReturnValues) {
  return stdev(logReturnValues) * Math.sqrt(TRADING_DAYS);
}

export function annualizedDrift(logReturnValues) {
  return mean(logReturnValues) * TRADING_DAYS;
}

export function valueAtRisk(logReturnValues, confidence = 0.95) {
  return quantile(logReturnValues, 1 - confidence);
}

export function conditionalValueAtRisk(logReturnValues, confidence = 0.95) {
  const cutoff = valueAtRisk(logReturnValues, confidence);
  const tail = logReturnValues.filter((value) => value <= cutoff);
  return tail.length ? mean(tail) : cutoff;
}

export function estimateHurst(values, maxLag = 64) {
  const clean = values.filter(isFiniteNumber);
  if (clean.length < maxLag + 10) return 0.5;
  const lags = [];
  const taus = [];
  for (let lag = 2; lag <= maxLag; lag += 1) {
    const diffs = [];
    for (let index = lag; index < clean.length; index += 1) {
      diffs.push(clean[index] - clean[index - lag]);
    }
    const tau = stdev(diffs);
    if (tau > 0) {
      lags.push(Math.log(lag));
      taus.push(Math.log(tau));
    }
  }
  if (lags.length < 3) return 0.5;
  const avgLag = mean(lags);
  const avgTau = mean(taus);
  const numerator = lags.reduce((sum, value, index) => sum + (value - avgLag) * (taus[index] - avgTau), 0);
  const denominator = lags.reduce((sum, value) => sum + (value - avgLag) ** 2, 0);
  return clamp(denominator ? numerator / denominator : 0.5, 0, 1);
}

export function alignSeriesByDate(left, right) {
  const rightByDate = new Map(right.map((point) => [point.date, point.value]));
  const alignedLeft = [];
  const alignedRight = [];
  for (const point of left) {
    const rightValue = rightByDate.get(point.date);
    if (isFiniteNumber(point.value) && isFiniteNumber(rightValue)) {
      alignedLeft.push(point.value);
      alignedRight.push(rightValue);
    }
  }
  return [alignedLeft, alignedRight];
}

export function safeLast(values, fallback = 0) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (isFiniteNumber(values[index])) return values[index];
  }
  return fallback;
}
