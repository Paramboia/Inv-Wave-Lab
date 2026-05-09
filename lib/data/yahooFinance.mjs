const CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart";
const QUOTE_URL = "https://query1.finance.yahoo.com/v7/finance/quote";
const QUOTE_SUMMARY_URL = "https://query2.finance.yahoo.com/v10/finance/quoteSummary";

const DEFAULT_HEADERS = {
  accept: "application/json,text/plain,*/*",
  "user-agent": "inv-wave-lab/0.1 research prototype",
};

let yahooSessionPromise;

export function normalizeSymbol(symbol) {
  let clean = String(symbol ?? "")
    .trim()
    .toUpperCase();
  if (/^[A-Z]{1,6}\.[A-Z]$/.test(clean)) {
    clean = clean.replace(".", "-");
  }
  if (!/^[A-Z0-9.^=_-]{1,24}$/.test(clean)) {
    throw new Error(clean ? "Ticker contains unsupported characters." : "Enter a ticker.");
  }
  return clean;
}

function setCookieHeader(headers) {
  if (typeof headers.getSetCookie === "function") {
    return headers
      .getSetCookie()
      .map((cookie) => cookie.split(";")[0])
      .join("; ");
  }
  const cookie = headers.get("set-cookie");
  return cookie
    ? cookie
        .split(/,(?=[^ ;]+=)/)
        .map((item) => item.split(";")[0])
        .join("; ")
    : "";
}

async function getYahooSession(symbol = "AAPL") {
  if (yahooSessionPromise) return yahooSessionPromise;
  yahooSessionPromise = (async () => {
    try {
      const landing = await fetch(`https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}`, {
        headers: DEFAULT_HEADERS,
      });
      const cookie = setCookieHeader(landing.headers);
      const crumbResponse = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
        headers: {
          ...DEFAULT_HEADERS,
          cookie,
        },
      });
      if (!crumbResponse.ok) throw new Error(`Yahoo crumb unavailable: HTTP ${crumbResponse.status}`);
      const crumb = (await crumbResponse.text()).trim();
      if (!crumb || crumb.includes("<")) throw new Error("Yahoo crumb response was not usable.");
      return { cookie, crumb };
    } catch (error) {
      yahooSessionPromise = undefined;
      throw error;
    }
  })();
  return yahooSessionPromise;
}

async function fetchJson(url, timeoutMs = 12000, extraHeaders = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        ...DEFAULT_HEADERS,
        ...extraHeaders,
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 160)}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJsonWithYahooFallback(url, symbol) {
  try {
    return await fetchJson(url);
  } catch (error) {
    if (!String(error.message).includes("401")) throw error;
    const session = await getYahooSession(symbol);
    const retryUrl = new URL(url);
    retryUrl.searchParams.set("crumb", session.crumb);
    return fetchJson(retryUrl, 12000, { cookie: session.cookie });
  }
}

export async function fetchChart(symbolInput, { range = "5y", interval = "1d" } = {}) {
  const symbol = normalizeSymbol(symbolInput);
  const url = new URL(`${CHART_URL}/${encodeURIComponent(symbol)}`);
  url.searchParams.set("range", range);
  url.searchParams.set("interval", interval);
  url.searchParams.set("includePrePost", "false");
  url.searchParams.set("events", "div,splits,capitalGains");

  const payload = await fetchJsonWithYahooFallback(url, symbol);
  const error = payload?.chart?.error;
  if (error) throw new Error(error.description ?? error.code ?? "Yahoo chart error");
  const result = payload?.chart?.result?.[0];
  if (!result?.timestamp?.length) throw new Error(`No historical chart data returned for ${symbol}.`);

  const quote = result.indicators?.quote?.[0] ?? {};
  const adjClose = result.indicators?.adjclose?.[0]?.adjclose ?? [];
  const prices = result.timestamp
    .map((timestamp, index) => ({
      date: new Date(timestamp * 1000).toISOString().slice(0, 10),
      timestamp,
      open: quote.open?.[index],
      high: quote.high?.[index],
      low: quote.low?.[index],
      close: quote.close?.[index],
      adjClose: adjClose[index] ?? quote.close?.[index],
      volume: quote.volume?.[index] ?? 0,
    }))
    .filter((point) => Number.isFinite(point.close) && point.close > 0);

  return {
    symbol,
    meta: {
      ...result.meta,
      range,
      interval,
    },
    prices,
  };
}

export async function fetchQuote(symbolInput) {
  const symbol = normalizeSymbol(symbolInput);
  const url = new URL(QUOTE_URL);
  url.searchParams.set("symbols", symbol);
  url.searchParams.set(
    "fields",
    [
      "shortName",
      "longName",
      "currency",
      "regularMarketPrice",
      "marketCap",
      "trailingPE",
      "forwardPE",
      "priceToBook",
      "profitMargins",
      "revenueGrowth",
      "earningsGrowth",
      "beta",
      "dividendYield",
      "sector",
      "industry",
    ].join(","),
  );
  const payload = await fetchJsonWithYahooFallback(url, symbol);
  const quote = payload?.quoteResponse?.result?.[0];
  if (!quote) throw new Error(`No quote data returned for ${symbol}.`);
  return quote;
}

export async function fetchQuoteSummary(symbolInput) {
  const symbol = normalizeSymbol(symbolInput);
  const url = new URL(`${QUOTE_SUMMARY_URL}/${encodeURIComponent(symbol)}`);
  url.searchParams.set(
    "modules",
    [
      "assetProfile",
      "summaryDetail",
      "financialData",
      "defaultKeyStatistics",
      "price",
    ].join(","),
  );
  try {
    const payload = await fetchJsonWithYahooFallback(url, symbol);
    return payload?.quoteSummary?.result?.[0] ?? {};
  } catch (error) {
    return {
      unavailable: true,
      error: error.message,
    };
  }
}

export async function fetchInstrumentBundle(symbolInput, { range = "5y", interval = "1d" } = {}) {
  const symbol = normalizeSymbol(symbolInput);
  const [chart, quoteResult, summary] = await Promise.allSettled([
    fetchChart(symbol, { range, interval }),
    fetchQuote(symbol),
    fetchQuoteSummary(symbol),
  ]);

  if (chart.status === "rejected") throw chart.reason;

  return {
    symbol,
    meta: chart.value.meta,
    prices: chart.value.prices,
    quote: quoteResult.status === "fulfilled" ? quoteResult.value : {},
    summary: summary.status === "fulfilled" ? summary.value : {},
    dataWarnings: [
      summary.status === "fulfilled" && summary.value?.unavailable
        ? `Fundamental summary unavailable: ${summary.value.error}`
        : null,
      summary.status === "rejected" ? `Fundamental summary unavailable: ${summary.reason.message}` : null,
    ].filter(Boolean),
  };
}

export async function fetchMarketContext({ range = "5y", interval = "1d" } = {}) {
  const proxySymbols = ["SPY", "QQQ", "^VIX", "^TNX", "DBC"];
  const results = await Promise.allSettled(proxySymbols.map((symbol) => fetchChart(symbol, { range, interval })));
  const context = {};
  for (let index = 0; index < proxySymbols.length; index += 1) {
    const symbol = proxySymbols[index];
    const result = results[index];
    if (result.status === "fulfilled") {
      context[symbol] = result.value;
    } else {
      context[symbol] = {
        symbol,
        prices: [],
        error: result.reason.message,
      };
    }
  }
  return context;
}
