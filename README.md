# Inv-Wave Lab

Open-source experimental stock research terminal that maps market behavior through quantitative wave layers, wave-formation physics, fundamentals, sector context, macro weather, risk, forecasts, and backtesting.

Live app: https://invwavelab.com/
Repository: https://github.com/Paramboia/Inv-Wave-Lab

## What It Does

Inv-Wave Lab lets you paste a stock ticker and generate a research cockpit with:

- **Wave:** price frequency, amplitude, repetition, phase pressure, volatility, and break risk.
- **Physics:** spectral sea-state features inspired by wave formation math, including bandwidth, peak enhancement, steepness, instability, shoaling, breaking type, and hidden-wave precursor detection.
- **Shape:** available fundamental quality, growth, profitability, balance sheet, and valuation signals.
- **Coast:** sector and industry priors that approximate the market structure where the company trades.
- **Weather:** macro proxy regime from market, growth, volatility, rates, and commodity instruments.
- **Risk and validation:** forecast cones, buying opportunity guidance, risk diagnostics, and historical backtesting.

## Run Locally

```bash
npm install
npm start
```

Open `http://localhost:4173`.

## Test

```bash
npm test
```

## API Endpoints

- `/api/analyze?ticker=AAPL&range=5y&horizon=30`
- `/api/backtest?ticker=AAPL&range=10y&horizon=30&training=504&step=21`

## Data

The first adapter uses Yahoo Finance-compatible endpoints for historical prices and quote snapshots. That is good enough for research prototyping, but not a production trading data contract. The adapter boundary is intentionally isolated in `lib/data/yahooFinance.mjs` so Polygon, Tiingo, IEX Cloud, Bloomberg, Refinitiv, FactSet, or internal warehouse data can replace it later.

## Contributing

Contributions are welcome. Good first areas include:

- Better validation metrics and backtest stratification.
- More transparent model explanations.
- Data adapter hardening and provider alternatives.
- UI accessibility and mobile polish.
- Documentation, examples, and research notes.

Before opening a pull request, run:

```bash
npm test
```

## Model Notes

This is a statistical research tool, not financial advice or an execution system. The target price is the median of a modeled return distribution for the chosen horizon, while the confidence score is a data-quality and signal-coherence score, not a probability of profit.

The physics layer is experimental by design. It adds a "tsunami setup" score for hidden formation patterns where stored drawdown energy, volatility compression, rhythmic coherence, and ignition may appear before the obvious move. It can find interesting historical windows, but it also produces false positives. Use the backtest stratification metrics before trusting any single signal.

## License

MIT. See [LICENSE](LICENSE).
