import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.184.0/build/three.module.js";

const form = document.querySelector("#analysisForm");
const tickerInput = document.querySelector("#tickerInput");
const rangeSelect = document.querySelector("#rangeSelect");
const horizonInput = document.querySelector("#horizonInput");
const trainingInput = document.querySelector("#trainingInput");
const stepInput = document.querySelector("#stepInput");
const analyzeButton = document.querySelector("#analyzeButton");
const backtestButton = document.querySelector("#backtestButton");
const statusDot = document.querySelector("#statusDot");
const systemStatus = document.querySelector("#systemStatus");
const instrumentMeta = document.querySelector("#instrumentMeta");
const instrumentName = document.querySelector("#instrumentName");
const posturePill = document.querySelector("#posturePill");
const buyPanel = document.querySelector("#buyPanel");
const buyAction = document.querySelector("#buyAction");
const buySetupScore = document.querySelector("#buySetupScore");
const buySummary = document.querySelector("#buySummary");
const buyLevels = document.querySelector("#buyLevels");
const buyReasons = document.querySelector("#buyReasons");
const metricGrid = document.querySelector("#metricGrid");
const warningPanel = document.querySelector("#warningPanel");
const priceCanvas = document.querySelector("#priceCanvas");
const backtestCanvas = document.querySelector("#backtestCanvas");
const backtestSummary = document.querySelector("#backtestSummary");
const waveSceneEl = document.querySelector("#waveScene");

let lastAnalysis = null;
let waveViz = null;

const metricTips = {
  Current: "Latest adjusted close returned by the price data adapter.",
  Target: "Modeled median path for the selected trading-day horizon.",
  Expected: "Modeled return from current price to target price, not a probability of profit.",
  Confidence: "Signal-coherence and data-quality score. It is not a guarantee.",
  Composite: "Blended score from wave, physics, shape, coast, weather, and risk.",
  Risk: "Volatility, drawdown, beta, classical break risk, and physics break stress.",
  Physics: "Nature-derived formation layer: spectral rhythm, steepness, stored energy, and source/sink flux.",
  Tsunami: "Hidden-wave precursor score. High values mean compression, retrieval, rhythm, and ignition are aligning.",
};

const scoreTargets = {
  wave: [document.querySelector("#waveScore"), document.querySelector("#waveBar"), document.querySelector("#waveDetails")],
  physics: [document.querySelector("#physicsScore"), document.querySelector("#physicsBar"), document.querySelector("#physicsDetails")],
  shape: [document.querySelector("#shapeScore"), document.querySelector("#shapeBar"), document.querySelector("#shapeDetails")],
  coast: [document.querySelector("#coastScore"), document.querySelector("#coastBar"), document.querySelector("#coastDetails")],
  weather: [document.querySelector("#weatherScore"), document.querySelector("#weatherBar"), document.querySelector("#weatherDetails")],
};

function setStatus(message, state = "idle") {
  systemStatus.textContent = message;
  statusDot.className = `status-dot ${state}`;
}

function formatPct(value, digits = 1) {
  if (!Number.isFinite(value)) return "--";
  return `${(value * 100).toFixed(digits)}%`;
}

function formatScore(value) {
  if (!Number.isFinite(value)) return "--";
  return value.toFixed(0);
}

function formatNumber(value, digits = 2) {
  if (!Number.isFinite(value)) return "--";
  return value.toLocaleString(undefined, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
}

function clampValue(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function valueTone(value, positiveThreshold = 0.005, negativeThreshold = -0.005) {
  if (!Number.isFinite(value)) return "neutral";
  if (value > positiveThreshold) return "positive";
  if (value < negativeThreshold) return "negative";
  return "neutral";
}

function scoreTone(value, high = 62, low = 42, invert = false) {
  if (!Number.isFinite(value)) return "neutral";
  if (invert) {
    if (value <= low) return "positive";
    if (value >= high) return "negative";
    return "neutral";
  }
  if (value >= high) return "positive";
  if (value <= low) return "negative";
  return "neutral";
}

function toneColor(tone) {
  if (tone === "positive") return "#4be07d";
  if (tone === "negative") return "#ff5c5c";
  return "#eef7f3";
}

function currencyFormatter(currency = "USD") {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    });
  } catch {
    const fallback = new Intl.NumberFormat(undefined, {
      maximumFractionDigits: 2,
      minimumFractionDigits: 2,
    });
    return {
      format(value) {
        return `${fallback.format(value)} ${currency || ""}`.trim();
      },
    };
  }
}

async function fetchJson(path) {
  const response = await fetch(path);
  const payload = await response.json();
  if (!response.ok || payload.error) {
    const error = new Error(payload.error ?? `HTTP ${response.status}`);
    error.code = payload.code;
    error.details = payload.details;
    throw error;
  }
  return payload;
}

function infoDotElement(text) {
  const element = document.createElement("span");
  element.className = "info-dot";
  element.tabIndex = 0;
  element.dataset.tip = text;
  element.textContent = "i";
  return element;
}

function metric(label, value, sub = "", tone = "neutral") {
  const element = document.createElement("div");
  element.className = `metric ${tone}`;
  const labelNode = document.createElement("span");
  labelNode.textContent = label;
  if (metricTips[label]) labelNode.appendChild(infoDotElement(metricTips[label]));
  const valueNode = document.createElement("strong");
  valueNode.textContent = value;
  element.append(labelNode, valueNode);
  if (sub) {
    const subNode = document.createElement("small");
    subNode.textContent = sub;
    element.appendChild(subNode);
  }
  return element;
}

function setScore(section, value, rows) {
  const [scoreNode, barNode, detailNode] = scoreTargets[section];
  scoreNode.textContent = formatScore(value);
  scoreNode.className = scoreTone(value);
  barNode.style.width = `${Math.max(0, Math.min(100, value))}%`;
  barNode.style.background = value >= 62 ? "var(--green)" : value <= 42 ? "var(--red)" : "var(--amber)";
  const nodes = [];
  for (const [label, detail, tone = "neutral"] of rows) {
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = label;
    dd.textContent = detail;
    dd.className = tone;
    nodes.push(dt, dd);
  }
  detailNode.replaceChildren(...nodes);
}

function renderBuyOpportunity(analysis) {
  const opportunity = analysis.buyOpportunity;
  if (!opportunity) return;
  const money = currencyFormatter(analysis.currency);
  const tone = opportunity.tone ?? "neutral";
  buyPanel.className = `buy-panel ${tone}`;
  buyAction.textContent = opportunity.action;
  buySetupScore.textContent = formatScore(opportunity.setupScore);
  buySetupScore.className = scoreTone(opportunity.setupScore);
  buySummary.textContent = opportunity.summary;

  const expectedTone = valueTone(analysis.forecast.expectedReturnPct);
  const levelNodes = [
    ["Current", money.format(opportunity.levels.current), "neutral"],
    ["Pullback entry", money.format(opportunity.levels.pullbackEntry), tone === "negative" ? "neutral" : "positive"],
    ["Breakout confirm", money.format(opportunity.levels.breakoutConfirmation), tone === "positive" ? "positive" : "neutral"],
    ["Invalidation", money.format(opportunity.levels.invalidation), "negative"],
    ["Target", money.format(opportunity.levels.target), expectedTone],
    ["Reward / risk", formatNumber(opportunity.rewardRisk, 2), scoreTone(opportunity.rewardRisk * 100, 80, 35)],
  ]
    .map(([label, value, valueClass]) => {
      const item = document.createElement("div");
      const labelNode = document.createElement("span");
      const valueNode = document.createElement("strong");
      item.className = `buy-level ${valueClass}`;
      labelNode.textContent = label;
      valueNode.textContent = value;
      item.append(labelNode, valueNode);
      return item;
    });
  buyLevels.replaceChildren(...levelNodes);

  buyReasons.replaceChildren(
    ...opportunity.reasons.map((reason) => {
      const item = document.createElement("li");
      item.textContent = reason;
      return item;
    }),
  );
}

function renderWarnings(warnings = []) {
  if (!warnings.length) {
    warningPanel.classList.add("hidden");
    warningPanel.textContent = "";
    return;
  }
  warningPanel.classList.remove("hidden");
  warningPanel.replaceChildren(
    ...warnings.map((warning) => {
      const item = document.createElement("div");
      item.textContent = warning;
      return item;
    }),
  );
}

function coverageText(analysis) {
  const coverage = analysis.dataCoverage;
  if (!coverage) return `${analysis.observations.toLocaleString()} observations`;
  const ratio = Number.isFinite(coverage.coverageRatio) ? ` · ${(coverage.coverageRatio * 100).toFixed(0)}% ${coverage.requestedRange} coverage` : "";
  return `${coverage.observations.toLocaleString()} observations · ${coverage.status}${ratio}`;
}

function clearCanvas(canvas) {
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);
}

function clearBacktestState(message = "") {
  backtestSummary.replaceChildren();
  if (message) {
    const item = document.createElement("span");
    item.className = "negative";
    item.textContent = message;
    backtestSummary.appendChild(item);
  }
  clearCanvas(backtestCanvas);
}

function showAnalysisError(ticker, error) {
  lastAnalysis = null;
  instrumentMeta.textContent = `${ticker || "Ticker"} · ${error.code ?? "ERROR"}`;
  instrumentName.textContent = "Analysis unavailable";
  posturePill.textContent = "Error";
  posturePill.className = "posture-pill reduce";
  buyPanel.className = "buy-panel negative";
  buyAction.textContent = "Data/input error";
  buySetupScore.textContent = "--";
  buySetupScore.className = "negative";
  buySummary.textContent = error.message;
  buyLevels.replaceChildren();
  buyReasons.replaceChildren();
  metricGrid.replaceChildren();
  for (const [scoreNode, barNode, detailNode] of Object.values(scoreTargets)) {
    scoreNode.textContent = "--";
    scoreNode.className = "neutral";
    barNode.style.width = "0%";
    detailNode.replaceChildren();
  }
  clearCanvas(priceCanvas);
  clearBacktestState();
  renderWarnings([error.message]);
}

function renderAnalysis(analysis) {
  lastAnalysis = analysis;
  const money = currencyFormatter(analysis.currency);
  const forecast = analysis.forecast;

  instrumentMeta.textContent = `${analysis.symbol} · ${analysis.asOf} · ${coverageText(analysis)}`;
  instrumentName.textContent = analysis.name ?? analysis.symbol;
  posturePill.textContent = analysis.posture;
  posturePill.className = `posture-pill ${analysis.posture}`;
  renderBuyOpportunity(analysis);

  metricGrid.replaceChildren(
    metric("Current", money.format(forecast.currentPrice), analysis.currency, "neutral"),
    metric(
      "Target",
      money.format(forecast.targetPrice),
      `${forecast.horizonDays} trading days`,
      valueTone(forecast.targetPrice / forecast.currentPrice - 1),
    ),
    metric("Expected", formatPct(forecast.expectedReturnPct), forecast.thesis, valueTone(forecast.expectedReturnPct)),
    metric(
      "Confidence",
      `${forecast.confidence.toFixed(0)}%`,
      `Agreement ${formatPct(forecast.agreement, 0)}`,
      scoreTone(forecast.confidence, 66, 44),
    ),
    metric("Composite", formatScore(analysis.compositeScore), "0-100 score", scoreTone(analysis.compositeScore)),
    metric("Risk", formatScore(analysis.risk.score), `Vol ${formatPct(analysis.risk.annualVolatility)}`, scoreTone(analysis.risk.score, 65, 40, true)),
    metric("Physics", formatScore(analysis.wavePhysics.score), analysis.wavePhysics.setupStage, scoreTone(analysis.wavePhysics.score)),
    metric(
      "Tsunami",
      formatScore(analysis.wavePhysics.tsunamiSetupScore),
      analysis.wavePhysics.breakerType,
      scoreTone(analysis.wavePhysics.tsunamiSetupScore, 68, 32),
    ),
  );

  setScore("wave", analysis.wave.score, [
    ["Cycle", `${analysis.wave.dominantCycleDays}d`],
    ["Frequency", `${analysis.wave.frequencyPerYear.toFixed(1)}/yr`],
    ["Repetition", formatScore(analysis.wave.repetitiveness), scoreTone(analysis.wave.repetitiveness, 62, 36)],
    ["Break risk", formatScore(analysis.wave.breakRisk), scoreTone(analysis.wave.breakRisk, 64, 38, true)],
    ["Wave z", analysis.wave.waveZ.toFixed(2), valueTone(analysis.wave.waveZ, 0.25, -0.25)],
    ["RSI", analysis.wave.rsi.toFixed(0), analysis.wave.rsi >= 70 ? "negative" : analysis.wave.rsi <= 35 ? "positive" : "neutral"],
  ]);

  setScore("physics", analysis.wavePhysics.score, [
    ["Formation", formatScore(analysis.wavePhysics.formationScore), scoreTone(analysis.wavePhysics.formationScore)],
    ["Tsunami", formatScore(analysis.wavePhysics.tsunamiSetupScore), scoreTone(analysis.wavePhysics.tsunamiSetupScore, 68, 32)],
    ["Stage", analysis.wavePhysics.setupStage],
    ["Breaker", analysis.wavePhysics.breakerType],
    ["BFI", formatNumber(analysis.wavePhysics.benjaminFeirIndex, 2), scoreTone(analysis.wavePhysics.benjaminFeirIndex * 100, 80, 30)],
    ["Steepness", formatScore(analysis.wavePhysics.steepnessPressure), scoreTone(analysis.wavePhysics.steepnessPressure, 70, 35, true)],
    ["Bandwidth", formatNumber(analysis.wavePhysics.spectralBandwidth, 2)],
    ["Flux", formatNumber(analysis.wavePhysics.netEnergyFlux, 1), valueTone(analysis.wavePhysics.netEnergyFlux, 0.1, -0.1)],
  ]);

  setScore("shape", analysis.fundamentalShape.score, [
    ["Valuation", formatScore(analysis.fundamentalShape.subScores.valuation), scoreTone(analysis.fundamentalShape.subScores.valuation)],
    ["Profitability", formatScore(analysis.fundamentalShape.subScores.profitability), scoreTone(analysis.fundamentalShape.subScores.profitability)],
    ["Growth", formatScore(analysis.fundamentalShape.subScores.growth), scoreTone(analysis.fundamentalShape.subScores.growth)],
    ["Balance", formatScore(analysis.fundamentalShape.subScores.balanceSheet), scoreTone(analysis.fundamentalShape.subScores.balanceSheet)],
    ["Data", formatPct(analysis.fundamentalShape.confidence, 0), scoreTone(analysis.fundamentalShape.confidence * 100, 68, 36)],
  ]);

  setScore("coast", analysis.coast.score, [
    ["Sector", analysis.coast.sector],
    ["Industry", analysis.coast.industry],
    ["Beta", analysis.coast.beta.toFixed(2), analysis.coast.beta > 1.35 ? "negative" : analysis.coast.beta < 0.85 ? "positive" : "neutral"],
    ["Domain risk", formatScore(analysis.coast.risk), scoreTone(analysis.coast.risk, 64, 38, true)],
  ]);

  setScore("weather", analysis.weather.score, [
    ["SPY 63d", formatPct(analysis.weather.proxies.spy63), valueTone(analysis.weather.proxies.spy63)],
    ["QQQ 63d", formatPct(analysis.weather.proxies.qqq63), valueTone(analysis.weather.proxies.qqq63)],
    ["VIX", formatNumber(analysis.weather.proxies.vixClose, 1)],
    ["Rates 63d", formatPct(analysis.weather.proxies.tnxChange), valueTone(-analysis.weather.proxies.tnxChange)],
    ["Market beta", analysis.weather.marketBeta.toFixed(2), analysis.weather.marketBeta > 1.35 ? "negative" : analysis.weather.marketBeta < 0.85 ? "positive" : "neutral"],
  ]);

  renderWarnings(analysis.dataWarnings);
  renderWaveScene(analysis);
  drawPriceChart(priceCanvas, analysis);
}

function setupCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(320, Math.floor(rect.width * dpr));
  const height = Math.floor((canvas.height / canvas.width) * width);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext("2d");
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  return {
    context,
    width: width / dpr,
    height: height / dpr,
  };
}

function drawAxes(context, width, height, padding, minY, maxY) {
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#070a0b";
  context.fillRect(0, 0, width, height);
  context.strokeStyle = "rgba(143, 160, 155, 0.18)";
  context.lineWidth = 1;
  context.font = "12px Inter, system-ui, sans-serif";
  context.fillStyle = "#8fa09b";
  for (let line = 0; line <= 4; line += 1) {
    const y = padding.top + ((height - padding.top - padding.bottom) * line) / 4;
    context.beginPath();
    context.moveTo(padding.left, y);
    context.lineTo(width - padding.right, y);
    context.stroke();
    const value = maxY - ((maxY - minY) * line) / 4;
    context.fillText(value.toFixed(2), 10, y + 4);
  }
}

function drawPriceChart(canvas, analysis) {
  const { context, width, height } = setupCanvas(canvas);
  const prices = analysis.priceHistory ?? [];
  if (prices.length < 2) {
    context.clearRect(0, 0, width, height);
    return;
  }
  const padding = { top: 18, right: 24, bottom: 34, left: 54 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const historyWidth = plotWidth * 0.82;
  const forecastWidth = plotWidth * 0.18;
  const current = analysis.forecast.currentPrice;
  const values = prices.map((point) => point.close).concat([
    analysis.forecast.interval90.low,
    analysis.forecast.interval90.high,
    analysis.forecast.targetPrice,
  ]);
  const minY = Math.min(...values) * 0.985;
  const maxY = Math.max(...values) * 1.015;
  const y = (value) => padding.top + (1 - (value - minY) / (maxY - minY || 1)) * plotHeight;
  const x = (index) => padding.left + (index / Math.max(1, prices.length - 1)) * historyWidth;
  const forecastX = padding.left + historyWidth + forecastWidth;
  const forecastTone = valueTone(analysis.forecast.expectedReturnPct);
  const forecastColor = toneColor(forecastTone);

  drawAxes(context, width, height, padding, minY, maxY);

  context.save();
  context.fillStyle =
    forecastTone === "positive"
      ? "rgba(75, 224, 125, 0.15)"
      : forecastTone === "negative"
        ? "rgba(255, 92, 92, 0.13)"
        : "rgba(238, 247, 243, 0.1)";
  context.beginPath();
  context.moveTo(x(prices.length - 1), y(current));
  context.lineTo(forecastX, y(analysis.forecast.interval68.high));
  context.lineTo(forecastX, y(analysis.forecast.interval68.low));
  context.closePath();
  context.fill();

  context.strokeStyle = "#eef7f3";
  context.lineWidth = 2;
  context.beginPath();
  prices.forEach((point, index) => {
    const px = x(index);
    const py = y(point.close);
    if (index === 0) context.moveTo(px, py);
    else context.lineTo(px, py);
  });
  context.stroke();

  context.strokeStyle = forecastColor;
  context.setLineDash([6, 5]);
  context.beginPath();
  context.moveTo(x(prices.length - 1), y(current));
  context.lineTo(forecastX, y(analysis.forecast.targetPrice));
  context.stroke();
  context.setLineDash([]);

  context.fillStyle = forecastColor;
  context.beginPath();
  context.arc(forecastX, y(analysis.forecast.targetPrice), 4, 0, Math.PI * 2);
  context.fill();

  context.strokeStyle = "rgba(255, 189, 74, 0.35)";
  context.beginPath();
  context.moveTo(padding.left + historyWidth, padding.top);
  context.lineTo(padding.left + historyWidth, height - padding.bottom);
  context.stroke();

  context.fillStyle = "#8fa09b";
  context.fillText(prices[0].date, padding.left, height - 12);
  context.fillText(prices[prices.length - 1].date, padding.left + historyWidth - 76, height - 12);
  context.fillText(`+${analysis.forecast.horizonDays}d`, forecastX - 42, height - 12);
  context.restore();
}

function interpolate(values, position) {
  if (!values.length) return 0;
  const index = Math.max(0, Math.min(values.length - 1, position));
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return values[lower];
  return values[lower] + (values[upper] - values[lower]) * (index - lower);
}

function disposeWaveObjects() {
  if (!waveViz) return;
  for (const object of waveViz.objects) {
    object.geometry?.dispose();
    if (Array.isArray(object.material)) object.material.forEach((material) => material.dispose());
    else object.material?.dispose();
    waveViz.surfaceGroup?.remove(object);
  }
  waveViz.objects = [];
}

function bindWaveSceneControls() {
  const endDrag = (event) => {
    if (!waveViz?.dragging) return;
    waveViz.dragging = false;
    waveViz.pointerId = null;
    waveSceneEl.classList.remove("dragging");
    try {
      waveSceneEl.releasePointerCapture?.(event.pointerId);
    } catch {
      // The pointer may already be released by the browser.
    }
  };

  waveSceneEl.addEventListener("pointerdown", (event) => {
    if (!waveViz) return;
    waveViz.dragging = true;
    waveViz.pointerId = event.pointerId;
    waveViz.lastPointerX = event.clientX;
    waveViz.lastPointerY = event.clientY;
    waveSceneEl.classList.add("dragging");
    waveSceneEl.setPointerCapture?.(event.pointerId);
  });

  waveSceneEl.addEventListener("pointermove", (event) => {
    if (!waveViz?.dragging || waveViz.pointerId !== event.pointerId) return;
    const dx = event.clientX - waveViz.lastPointerX;
    const dy = event.clientY - waveViz.lastPointerY;
    waveViz.userRotationY += dx * 0.008;
    waveViz.userRotationX = clampValue(waveViz.userRotationX + dy * 0.006, -0.72, 0.72);
    waveViz.lastPointerX = event.clientX;
    waveViz.lastPointerY = event.clientY;
  });

  waveSceneEl.addEventListener("pointerup", endDrag);
  waveSceneEl.addEventListener("pointercancel", endDrag);
  waveSceneEl.addEventListener("pointerleave", endDrag);
}

function createWaveViz() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050708);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  camera.position.set(5.6, 4.5, 6.8);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x050708, 1);
  waveSceneEl.appendChild(renderer.domElement);

  const ambient = new THREE.AmbientLight(0x88fff0, 0.55);
  scene.add(ambient);
  const key = new THREE.DirectionalLight(0xffbd4a, 1.8);
  key.position.set(-3, 6, 4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xff4fb8, 1.1);
  rim.position.set(5, 3, -4);
  scene.add(rim);

  const grid = new THREE.GridHelper(7.8, 18, 0x266d65, 0x132827);
  grid.position.y = -1.9;
  scene.add(grid);

  const surfaceGroup = new THREE.Group();
  scene.add(surfaceGroup);

  const readout = document.createElement("div");
  readout.className = "scene-readout";
  waveSceneEl.appendChild(readout);

  waveViz = {
    scene,
    camera,
    renderer,
    readout,
    surfaceGroup,
    objects: [],
    targetTilt: 0,
    userRotationX: 0,
    userRotationY: 0,
    dragging: false,
    pointerId: null,
    lastPointerX: 0,
    lastPointerY: 0,
  };
  bindWaveSceneControls();
  resizeWaveScene();
  animateWaveScene();
}

function buildWaveSurface(analysis) {
  const prices = analysis.priceHistory ?? [];
  const closes = prices.map((point) => point.close).filter(Number.isFinite);
  const logs = closes.map((value) => Math.log(value));
  const minLog = Math.min(...logs);
  const maxLog = Math.max(...logs);
  const span = Math.max(0.0001, maxLog - minLog);
  const normalized = logs.map((value) => ((value - minLog) / span - 0.5) * 2);
  const physics = analysis.wavePhysics;
  const cols = 88;
  const rows = 34;
  const width = 7.6;
  const depth = 4.6;
  const positions = [];
  const colors = [];
  const indices = [];
  const color = new THREE.Color();
  const peakPeriod = Math.max(5, physics.spectralPeakPeriod || 30);
  const peakFrequency = Math.max(0.03, 30 / peakPeriod);
  const concentration = Math.max(0.05, physics.spectralConcentration || 0.1);
  const storedEnergy = Math.max(0.05, physics.storedEnergyScore / 100);
  const breakStress = Math.max(0.05, physics.physicsBreakRisk / 100);
  const tsunami = Math.max(0.05, physics.tsunamiSetupScore / 100);
  const direction = physics.directionBias || 0;
  const phase = direction * Math.PI * 0.6;

  for (let row = 0; row < rows; row += 1) {
    const v = row / (rows - 1);
    const band = (v - 0.5) * 2;
    const bandEnvelope = Math.exp(-Math.abs(band) * (1.15 + concentration));
    const crossRipple = Math.sin(v * Math.PI * (2.2 + peakFrequency * 4));
    for (let col = 0; col < cols; col += 1) {
      const u = col / (cols - 1);
      const priceNorm = interpolate(normalized, u * (normalized.length - 1));
      const x = (u - 0.5) * width;
      const z = (v - 0.5) * depth;
      const rhythm = Math.sin(u * Math.PI * 2 * (2.2 + peakFrequency * 2.6) + phase);
      const harmonic = Math.sin(u * Math.PI * 2 * 5.1 - v * Math.PI * 1.7);
      const storedLift = Math.pow(Math.max(0, u - 0.18), 1.45) * storedEnergy * 0.85;
      const ridge = rhythm * bandEnvelope * (0.42 + tsunami * 0.4);
      const y = priceNorm * 0.92 + ridge + harmonic * 0.11 * concentration + crossRipple * 0.15 * breakStress + storedLift - 0.08;
      positions.push(x, y, z);

      const stressMix = Math.max(0, Math.min(1, breakStress * 0.75 + Math.abs(y) * 0.12));
      const energyMix = Math.max(0, Math.min(1, tsunami * 0.55 + storedEnergy * 0.35 + Math.max(0, direction) * 0.18));
      if (stressMix > 0.74) {
        color.setRGB(1, 0.28 + energyMix * 0.18, 0.72);
      } else if (energyMix > 0.58) {
        color.setRGB(1, 0.7 + energyMix * 0.12, 0.28);
      } else {
        color.setRGB(0.17 + energyMix * 0.1, 0.72 + energyMix * 0.22, 0.88);
      }
      colors.push(color.r, color.g, color.b);
    }
  }

  for (let row = 0; row < rows - 1; row += 1) {
    for (let col = 0; col < cols - 1; col += 1) {
      const current = row * cols + col;
      indices.push(current, current + cols, current + 1);
      indices.push(current + 1, current + cols, current + cols + 1);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setIndex(indices);
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();

  const surface = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      metalness: 0.18,
      roughness: 0.42,
      transparent: true,
      opacity: 0.92,
      side: THREE.DoubleSide,
    }),
  );

  const wireframe = new THREE.Mesh(
    geometry.clone(),
    new THREE.MeshBasicMaterial({
      color: 0x45f5d0,
      wireframe: true,
      transparent: true,
      opacity: 0.16,
    }),
  );

  return [surface, wireframe];
}

function renderWaveScene(analysis) {
  if (!waveSceneEl) return;
  if (!waveViz) createWaveViz();
  disposeWaveObjects();
  const objects = buildWaveSurface(analysis);
  for (const object of objects) {
    waveViz.surfaceGroup.add(object);
    waveViz.objects.push(object);
  }
  waveViz.targetTilt = Math.max(-0.22, Math.min(0.22, analysis.wavePhysics.directionBias * 0.18));
  waveViz.surfaceGroup.rotation.set(
    -0.48 + waveViz.targetTilt + waveViz.userRotationX,
    -0.28 + waveViz.userRotationY,
    0,
  );
  waveViz.readout.replaceChildren(
    ...[
      analysis.wavePhysics.setupStage,
      `peak ${analysis.wavePhysics.spectralPeakPeriod}d`,
      `band ${formatNumber(analysis.wavePhysics.spectralBandwidth, 2)}`,
      `flux ${formatNumber(analysis.wavePhysics.netEnergyFlux, 1)}`,
      "drag to inspect",
    ].map((label) => {
      const item = document.createElement("span");
      item.textContent = label;
      return item;
    }),
  );
}

function resizeWaveScene() {
  if (!waveViz || !waveSceneEl) return;
  const rect = waveSceneEl.getBoundingClientRect();
  const width = Math.max(320, rect.width);
  const height = Math.max(280, rect.height);
  waveViz.camera.aspect = width / height;
  waveViz.camera.updateProjectionMatrix();
  waveViz.renderer.setSize(width, height, false);
}

function animateWaveScene() {
  if (!waveViz) return;
  if (waveViz.surfaceGroup) {
    const targetX = -0.48 + waveViz.targetTilt + waveViz.userRotationX;
    const targetY = -0.28 + waveViz.userRotationY;
    waveViz.surfaceGroup.rotation.x += (targetX - waveViz.surfaceGroup.rotation.x) * 0.14;
    waveViz.surfaceGroup.rotation.y += (targetY - waveViz.surfaceGroup.rotation.y) * 0.14;
  }
  waveViz.renderer.render(waveViz.scene, waveViz.camera);
  window.requestAnimationFrame(animateWaveScene);
}

function drawBacktestChart(canvas, backtest) {
  const { context, width, height } = setupCanvas(canvas);
  const trades = backtest.trades ?? [];
  if (trades.length < 2) {
    context.clearRect(0, 0, width, height);
    return;
  }
  const padding = { top: 18, right: 24, bottom: 34, left: 54 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const values = trades.flatMap((trade) => [trade.predictedReturn, trade.actualReturn]);
  const maxAbs = Math.max(0.02, ...values.map((value) => Math.abs(value))) * 1.15;
  const y = (value) => padding.top + (1 - (value + maxAbs) / (maxAbs * 2)) * plotHeight;
  const x = (index) => padding.left + (index / Math.max(1, trades.length - 1)) * plotWidth;

  drawAxes(context, width, height, padding, -maxAbs, maxAbs);
  context.strokeStyle = "rgba(143, 160, 155, 0.28)";
  context.beginPath();
  context.moveTo(padding.left, y(0));
  context.lineTo(width - padding.right, y(0));
  context.stroke();

  const drawLine = (key, color) => {
    context.strokeStyle = color;
    context.lineWidth = 2;
    context.beginPath();
    trades.forEach((trade, index) => {
      const px = x(index);
      const py = y(trade[key]);
      if (index === 0) context.moveTo(px, py);
      else context.lineTo(px, py);
    });
    context.stroke();
  };

  drawLine("actualReturn", "#eef7f3");
  drawLine("predictedReturn", "#45f5d0");
  context.fillStyle = "#8fa09b";
  context.fillText(trades[0].asOf, padding.left, height - 12);
  context.fillText(trades[trades.length - 1].asOf, width - padding.right - 82, height - 12);
}

async function loadAnalysis() {
  const ticker = tickerInput.value.trim().toUpperCase();
  const range = rangeSelect.value;
  const horizon = horizonInput.value;
  setStatus(`Analyzing ${ticker}`, "loading");
  analyzeButton.disabled = true;
  backtestButton.disabled = true;
  renderWarnings([]);
  try {
    const analysis = await fetchJson(`/api/analyze?ticker=${encodeURIComponent(ticker)}&range=${range}&horizon=${horizon}`);
    renderAnalysis(analysis);
    setStatus(`Ready ${analysis.symbol}`, "ready");
  } catch (error) {
    setStatus(error.message, "error");
    showAnalysisError(ticker, error);
  } finally {
    analyzeButton.disabled = false;
    backtestButton.disabled = false;
  }
}

async function runValidation() {
  const ticker = tickerInput.value.trim().toUpperCase();
  const horizon = horizonInput.value;
  const training = trainingInput.value;
  const step = stepInput.value;
  setStatus(`Backtesting ${ticker}`, "loading");
  backtestButton.disabled = true;
  analyzeButton.disabled = true;
  clearBacktestState();
  renderWarnings([]);
  try {
    const backtest = await fetchJson(
      `/api/backtest?ticker=${encodeURIComponent(ticker)}&range=10y&horizon=${horizon}&training=${training}&step=${step}`,
    );
    const tsunamiTone = backtest.metrics.tsunamiSetupCount
      ? scoreTone(backtest.metrics.tsunamiSetupHitRate * 100, 58, 44)
      : "neutral";
    const summaryItems = [
      ["neutral", `N ${backtest.sampleSize}`],
      [backtest.validation?.avoidsCurrentFundamentalLookahead ? "positive" : "negative", backtest.validation?.avoidsCurrentFundamentalLookahead ? "No lookahead" : "Lookahead"],
      [backtest.validation?.windowsOverlap ? "negative" : "positive", backtest.validation?.windowsOverlap ? "Overlap" : "Independent"],
      [scoreTone(backtest.metrics.directionalAccuracy * 100, 56, 48), `Dir ${formatPct(backtest.metrics.directionalAccuracy, 0)}`],
      [valueTone(backtest.metrics.informationCoefficient, 0.05, -0.05), `IC ${formatNumber(backtest.metrics.informationCoefficient, 2)}`],
      [scoreTone(backtest.metrics.meanAbsoluteError * 100, 10, 4, true), `MAE ${formatPct(backtest.metrics.meanAbsoluteError)}`],
      [scoreTone(backtest.metrics.interval68HitRate * 100, 70, 50), `68 hit ${formatPct(backtest.metrics.interval68HitRate, 0)}`],
      [tsunamiTone, `Tsu ${backtest.metrics.tsunamiSetupCount}/${formatPct(backtest.metrics.tsunamiSetupHitRate, 0)}`],
    ];
    backtestSummary.replaceChildren(
      ...summaryItems.map(([tone, item]) => {
        const node = document.createElement("span");
        node.className = tone;
        node.textContent = item;
        return node;
      }),
    );
    drawBacktestChart(backtestCanvas, backtest);
    renderWarnings(backtest.dataWarnings);
    setStatus(`Backtest ready ${ticker}`, "ready");
  } catch (error) {
    setStatus(error.message, "error");
    clearBacktestState(error.message);
    renderWarnings([error.message]);
  } finally {
    backtestButton.disabled = false;
    analyzeButton.disabled = false;
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  loadAnalysis();
});

backtestButton.addEventListener("click", runValidation);

window.addEventListener("resize", () => {
  if (lastAnalysis) {
    drawPriceChart(priceCanvas, lastAnalysis);
    resizeWaveScene();
  }
});

loadAnalysis();
