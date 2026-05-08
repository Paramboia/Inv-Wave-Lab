# Inv-Wave Lab

A local research prototype for mapping stock behavior through four quantitative layers:

- **Wave:** price frequency, amplitude, repetition, phase pressure, volatility, and break risk.
- **Physics:** spectral sea-state features inspired by wave formation math: bandwidth, peak enhancement, steepness, instability, shoaling, breaking type, and hidden-wave precursor detection.
- **Shape:** available fundamental quality, growth, profitability, balance sheet, and valuation signals.
- **Coast:** sector and industry priors that approximate the market structure where the company trades.
- **Weather:** macro proxy regime from market, growth, volatility, rates, and commodity instruments.

The app exposes:

- `/api/analyze?ticker=AAPL&range=5y&horizon=30`
- `/api/backtest?ticker=AAPL&range=10y&horizon=30&training=504&step=21`

## Run

```bash
npm start
```

Open `http://localhost:4173`.

## Test

```bash
npm test
```

## Data

The first adapter uses Yahoo Finance-compatible endpoints for historical prices and quote snapshots. That is good enough for research prototyping, but not a production trading data contract. The adapter boundary is intentionally isolated in `lib/data/yahooFinance.mjs` so Polygon, Tiingo, IEX Cloud, Bloomberg, Refinitiv, FactSet, or internal warehouse data can replace it later.

## Model Notes

This is a statistical research tool, not financial advice or an execution system. The target price is the median of a modeled return distribution for the chosen horizon, while the confidence score is a data-quality and signal-coherence score, not a probability of profit.

The physics layer is experimental by design. It adds a "tsunami setup" score for hidden formation patterns where stored drawdown energy, volatility compression, rhythmic coherence, and ignition may appear before the obvious move. It can find interesting historical windows, but it also produces false positives. Use the backtest stratification metrics before trusting any single signal.
