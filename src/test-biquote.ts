const symbols = [
  "EURUSD",
  "GBPUSD",
  "USDJPY",
  "USDTRY",
  "XAUUSD",
  "XAGUSD",
  "BTCUSD",
  "ETHUSD",
  "AAPL",
  "NAS100",
];

const params = new URLSearchParams();

for (const symbol of symbols) {
  params.append("symbols", symbol);
}

const response = await fetch(`https://biquote.io/api/latest?${params}`);

if (!response.ok) {
  throw new Error(`Biquote API error: ${response.status}`);
}

const data: any = await response?.json();

for (const [symbol, quote] of Object.entries(data)) {
  const q = quote as {
    bid: number;
    ask: number;
    mid: number;
    marketState: string;
    quoteAgeSeconds: number;
  };

  console.log(
    `${symbol.padEnd(10)} ${q.mid} | ${q.marketState} | age: ${q.quoteAgeSeconds}s`,
  );
}
