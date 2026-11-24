
import http from "node:http";
import fs from "node:fs/promises";

const PORT = Number(process.env.PORT || 3000);
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT = process.env.TELEGRAM_CHAT_ID || "";

const INTERVAL = Math.max(
  600,
  Number(process.env.SCAN_INTERVAL_SECONDS || 600)
) * 1000;

const ALERT_SCORE = Number(process.env.ALERT_SCORE || 80);
const COOLDOWN_HOURS = Number(process.env.ALERT_COOLDOWN_HOURS || 6);

const MIDAS_URL = "https://www.midaskripto.com/kripto-paralar/";
const PAPRIKA_URL = "https://api.coinpaprika.com/v1/tickers";

let state = {
  lastScan: null,
  lastError: null,
  scanned: 0,
  alertsSent: 0,
  skipped: 0,
  cooldowns: {},
  midasAssets: [],
  midasUpdated: null
};

let busy = false;

try {
  state = {
    ...state,
    ...JSON.parse(await fs.readFile("./state.json", "utf8"))
  };
} catch {}

async function save() {
  try {
    await fs.writeFile("./state.json", JSON.stringify(state, null, 2));
  } catch (e) {
    console.error("Kayıt hatası:", e.message);
  }
}

async function get(url) {
  const r = await fetch(url, {
    signal: AbortSignal.timeout(20000),
    headers: { "User-Agent": "CoinRadarAI/1.0" }
  });

  if (!r.ok) {
    throw new Error(`HTTP ${r.status}: ${new URL(url).hostname}`);
  }

  return r.json();
}

async function getText(url) {
  const r = await fetch(url, {
    signal: AbortSignal.timeout(20000),
    headers: { "User-Agent": "Mozilla/5.0 CoinRadarAI/1.0" }
  });

  if (!r.ok) {
    throw new Error(`Midas sayfası HTTP ${r.status}`);
  }

  return r.text();
}

function cleanText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeName(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

async function fetchMidasAssets() {
  const first = await getText(MIDAS_URL);

  const pageNumbers = [...first.matchAll(/[?&]page=(\d+)/g)]
    .map(m => Number(m[1]))
    .filter(Number.isFinite);

  const maxPage = Math.min(30, Math.max(1, ...pageNumbers));
  const pages = [first];

  for (let page = 2; page <= maxPage; page++) {
    pages.push(await getText(`${MIDAS_URL}?page=${page}`));
  }

  const assets = new Map();

  for (const html of pages) {
    const links = html.matchAll(
      /<a\b[^>]*href=["']([^"']*\/kripto-paralar\/[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi
    );

    for (const match of links) {
      const text = cleanText(match[2]);
      const symbolMatch = text.match(/·\s*([A-Z0-9]{2,20})\b/);

      if (!symbolMatch) continue;

      const symbol = symbolMatch[1].toUpperCase();

      // Örneğin: Bitcoin 1 · BTC
      const name = text
        .replace(/\s+\d+\s*·\s*[A-Z0-9]{2,20}\b.*$/i, "")
        .trim();

      if (!name || !symbol) continue;

      assets.set(symbol, { symbol, name });
    }
  }

  if (assets.size < 50) {
    throw new Error(
      `Midas coin listesi yeterince okunamadı (${assets.size}). Eski liste korunuyor.`
    );
  }

  return [...assets.values()];
}

async function refreshMidasAssets() {
  const age = state.midasUpdated
    ? Date.now() - new Date(state.midasUpdated).getTime()
    : Infinity;

  // Midas listesini 6 saatte bir yenile.
  if (state.midasAssets.length > 50 && age < 6 * 3600000) {
    return state.midasAssets;
  }

  try {
    const assets = await fetchMidasAssets();

    state.midasAssets = assets;
    state.midasUpdated = new Date().toISOString();

    console.log(`Midas listesi güncellendi: ${assets.length} coin`);
    await save();

    return assets;
  } catch (e) {
    console.error("Midas liste hatası:", e.message);

    if (state.midasAssets.length > 50) {
      console.log("Önceki Midas listesi kullanılacak.");
      return state.midasAssets;
    }

    throw e;
  }
}

function matchCoins(midasAssets, tickers) {
  const grouped = new Map();

  for (const coin of tickers) {
    const symbol = String(coin.symbol || "").toUpperCase();

    if (!grouped.has(symbol)) grouped.set(symbol, []);
    grouped.get(symbol).push(coin);
  }

  const matched = [];

  for (const asset of midasAssets) {
    const candidates = grouped.get(asset.symbol) || [];

    if (candidates.length === 1) {
      matched.push({
        midas: asset,
        ticker: candidates[0]
      });
      continue;
    }

    if (candidates.length > 1) {
      const exact = candidates.filter(
        c => normalizeName(c.name) === normalizeName(asset.name)
      );

      if (exact.length === 1) {
        matched.push({ midas: asset, ticker: exact[0] });
      } else {
        console.log(`Belirsiz coin eşleşmesi atlandı: ${asset.symbol}`);
        state.skipped++;
      }
    } else {
      state.skipped++;
    }
  }

  return matched;
}

function analyze(asset, ticker) {
  const q = ticker.quotes?.USD;

  if (!q || !Number.isFinite(q.price)) return null;

  const change1h = Number(q.percent_change_1h || 0);
  const change6h = Number(q.percent_change_6h || 0);
  const change24h = Number(q.percent_change_24h || 0);
  const change7d = Number(q.percent_change_7d || 0);
  const volumeChange = Number(q.volume_24h_change_24h || 0);
  const volume = Number(q.volume_24h || 0);

  let score = 50;
  const reasons = [];

  if (change1h > 0.3) {
    score += 8;
    reasons.push("1 saatlik momentum pozitif");
  }

  if (change6h > 1) {
    score += 10;
    reasons.push("6 saatlik trend pozitif");
  }

  if (change24h > 1 && change24h < 12) {
    score += 8;
    reasons.push("24 saatlik yükseliş dengeli");
  }

  if (change24h >= 12) {
    score -= 5;
    reasons.push("24 saatlik hareket aşırı yükselmiş olabilir");
  }

  if (change7d > 3) {
    score += 5;
    reasons.push("haftalık momentum pozitif");
  }

  if (volumeChange > 20) {
    score += 12;
    reasons.push("işlem hacmi belirgin artıyor");
  } else if (volumeChange > 5) {
    score += 6;
    reasons.push("işlem hacmi artıyor");
  }

  if (change1h < -1) {
    score -= 8;
    reasons.push("son 1 saatte satış baskısı");
  }

  if (change6h < -3) {
    score -= 12;
    reasons.push("6 saatlik trend negatif");
  }

  if (change24h < -8) {
    score -= 12;
    reasons.push("günlük düşüş riski");
  }

  if (change7d < -15) {
    score -= 8;
    reasons.push("haftalık performans zayıf");
  }

  if (volume < 1000000) {
    score -= 8;
    reasons.push("küresel işlem hacmi düşük");
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  return {
    symbol: asset.symbol,
    name: asset.name,
    price: q.price,
    change1h,
    change6h,
    change24h,
    change7d,
    volume,
    volumeChange,
    score,
    reasons,
    sourceUpdated: ticker.last_updated
  };
}

async function sendTelegram(message) {
  if (!TOKEN || !CHAT) {
    console.log("Telegram ayarlanmamış:", message);
    return false;
  }

  const r = await fetch(
    `https://api.telegram.org/bot${TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT,
        text: message,
        disable_web_page_preview: true
      })
    }
  );

  const j = await r.json();

  if (!r.ok || !j.ok) {
    throw new Error(j.description || "Telegram gönderilemedi");
  }

  return true;
}

async function scan() {
  if (busy) return;
  busy = true;
  state.skipped = 0;

  try {
    const midasAssets = await refreshMidasAssets();

    // Tek API isteğiyle CoinPaprika'nın desteklediği
    // ilk 2000 coin için piyasa verisini al.
    const tickers = await get(PAPRIKA_URL);

    const matched = matchCoins(midasAssets, tickers);
    const results = matched
      .map(item => analyze(item.midas, item.ticker))
      .filter(Boolean);

    state.scanned = results.length;
    state.lastScan = new Date().toISOString();
    state.lastError = null;

    const ranked = results.sort((a, b) => b.score - a.score);

    for (const c of ranked) {
      const opportunity = c.score >= ALERT_SCORE;
      const risk = c.score <= 25;

      if (!opportunity && !risk) continue;

      const kind = opportunity ? "opportunity" : "risk";
      const key = `${c.symbol}:${kind}`;

      if (
        Date.now() - (state.cooldowns[key] || 0) <
        COOLDOWN_HOURS * 3600000
      ) {
        continue;
      }

      const msg = [
        `COIN RADAR AI | ${opportunity ? "🟢 FIRSAT ADAYI" : "🔴 RİSK UYARISI"}`,
        "",
        `${c.name} (${c.symbol})`,
        `Radar skoru: ${c.score}/100`,
        `CoinPaprika fiyatı: $${c.price}`,
        `1 saat: ${c.change1h.toFixed(2)}%`,
        `6 saat: ${c.change6h.toFixed(2)}%`,
        `24 saat: ${c.change24h.toFixed(2)}%`,
        `7 gün: ${c.change7d.toFixed(2)}%`,
        `Hacim değişimi: ${c.volumeChange.toFixed(2)}%`,
        "",
        `Nedenler: ${c.reasons.join(", ") || "Sınırlı veri"}`,
        "",
        `Veri güncellemesi: ${c.sourceUpdated || "Bilinmiyor"}`,
        "Kaynak: CoinPaprika",
        "Coin Midas listesinden eşleştirildi.",
        "",
        "Bu skor yükseliş olasılığı değildir ve yatırım tavsiyesi değildir."
      ].join("\n");

      try {
        await sendTelegram(msg);
        state.cooldowns[key] = Date.now();
        state.alertsSent++;
      } catch (e) {
        state.lastError = e.message;
        console.error("Bildirim hatası:", e.message);
      }
    }

    console.log(
      `Tarama tamamlandı: ${results.length} coin | ` +
      `${state.skipped} eşleşmeyen/belirsiz`
    );

  } catch (e) {
    state.lastError = e.message;
    console.error("Tarama hatası:", e.message);
  } finally {
    busy = false;
    await save();
  }
}

http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/health") {
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8"
    });

    res.end(JSON.stringify({
      service: "COIN RADAR AI",
      status: busy ? "scanning" : "running",
      source: "CoinPaprika",
      marketFilter: "Midas Kripto listesi",
      scanIntervalSeconds: INTERVAL / 1000,
      midasCoinCount: state.midasAssets.length,
      midasListUpdated: state.midasUpdated,
      lastScan: state.lastScan,
      scanned: state.scanned,
      skipped: state.skipped,
      alertsSent: state.alertsSent,
      telegramConfigured: !!(TOKEN && CHAT),
      lastError: state.lastError
    }, null, 2));
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
}).listen(PORT, () => {
  console.log("COIN RADAR AI çalışıyor. Port:", PORT);
});

await scan();
setInterval(scan, INTERVAL);
