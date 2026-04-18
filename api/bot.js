const express = require("express");

const DATA_API = "https://data-api.polymarket.com";
/** Polygon PoS — public RPC for ERC-20 USDC.e balance (no API key). */
const POLYGON_RPC = "https://polygon-rpc.com";
/** Bridged USDC on Polygon (USDC.e), commonly used on Polymarket. */
const USDC_POLYGON = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const app = express();
app.use(express.json());

function getEnv(name) {
  const v = process.env[name];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function isValidAddress(addr) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(addr || ""));
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 25_000);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(options.headers || {}),
      },
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const errMsg =
        data && typeof data === "object" && data.error
          ? String(data.error)
          : `HTTP ${res.status}`;
      throw new Error(errMsg);
    }
    return data;
  } finally {
    clearTimeout(t);
  }
}

function formatUsd(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "—";
  const x = Number(n);
  const sign = x < 0 ? "-" : "";
  const abs = Math.abs(x);
  return `${sign}$${abs.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatShares(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "—";
  return Number(n).toLocaleString("en-US", {
    maximumFractionDigits: 4,
  });
}

function formatPrice(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "—";
  return Number(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

function formatTs(secOrMs) {
  const n = Number(secOrMs);
  if (!Number.isFinite(n)) return "—";
  const ms = n < 1e12 ? n * 1000 : n;
  try {
    return new Date(ms).toISOString().replace("T", " ").slice(0, 19) + " UTC";
  } catch {
    return "—";
  }
}

function escapeTelegramHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function sendTelegramMessage(token, chatId, text) {
  const url = `https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`;
  const body = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    const desc = data.description || res.statusText || "sendMessage failed";
    throw new Error(desc);
  }
  return data;
}

async function getPortfolioValue(user) {
  const rows = await fetchJson(
    `${DATA_API}/value?user=${encodeURIComponent(user)}`
  );
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const v = rows[0]?.value;
  return typeof v === "number" ? v : Number(v) || 0;
}

async function getOpenPositions(user) {
  const rows = await fetchJson(
    `${DATA_API}/positions?user=${encodeURIComponent(user)}&limit=500&offset=0`
  );
  return Array.isArray(rows) ? rows : [];
}

async function getActivityTrades(user, limit) {
  const rows = await fetchJson(
    `${DATA_API}/activity?user=${encodeURIComponent(user)}&limit=${limit}&type=TRADE&sortBy=TIMESTAMP&sortDirection=DESC`
  );
  return Array.isArray(rows) ? rows : [];
}

async function sumClosedPositionsRealized(user) {
  let offset = 0;
  const pageSize = 50;
  let total = 0;
  const maxPages = 40;
  for (let page = 0; page < maxPages; page += 1) {
    const rows = await fetchJson(
      `${DATA_API}/closed-positions?user=${encodeURIComponent(user)}&limit=${pageSize}&offset=${offset}&sortBy=REALIZEDPNL&sortDirection=DESC`
    );
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const row of rows) {
      const r = row?.realizedPnl;
      total += typeof r === "number" ? r : Number(r) || 0;
    }
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  return total;
}

function padHexTo32(addr) {
  const a = addr.replace(/^0x/i, "").toLowerCase();
  return a.padStart(64, "0");
}

async function getUsdcBalanceOnPolygon(walletAddress) {
  const data = `0x70a08231${padHexTo32(walletAddress)}`;
  const payload = {
    jsonrpc: "2.0",
    id: 1,
    method: "eth_call",
    params: [{ to: USDC_POLYGON, data }, "latest"],
  };
  const res = await fetch(POLYGON_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const j = await res.json().catch(() => ({}));
  const hex = j?.result;
  if (!res.ok || typeof hex !== "string" || !/^0x[0-9a-f]+$/i.test(hex)) {
    throw new Error(
      j?.error?.message || "Could not read USDC balance from Polygon RPC"
    );
  }
  const raw = BigInt(hex);
  const usdc = Number(raw) / 1e6;
  if (!Number.isFinite(usdc)) throw new Error("Invalid USDC balance response");
  return usdc;
}

async function handleCommand(command, wallet) {
  const cmd = (command || "").trim().split(/\s+/)[0]?.toLowerCase() || "";

  if (cmd === "/start") {
    const w = escapeTelegramHtml(wallet);
    return (
      `👋 <b>Welcome to the Polymarket helper bot!</b>\n\n` +
      `I read your linked wallet on-chain and from Polymarket's public data API.\n\n` +
      `📌 <b>Commands</b>\n` +
      `/balance — 💵 USDC (wallet) + 📊 portfolio value\n` +
      `/positions — Open positions with price, size, and unrealized P&amp;L\n` +
      `/history — Last 10 trades\n` +
      `/pnl — Realized vs unrealized P&amp;L summary\n\n` +
      `Wallet: <code>${w}</code>`
    );
  }

  if (cmd === "/balance") {
    const portfolio = await getPortfolioValue(wallet);
    let usdc;
    try {
      usdc = await getUsdcBalanceOnPolygon(wallet);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      throw new Error(`Could not read USDC on Polygon: ${m}`);
    }
    return (
      `💰 <b>Balance &amp; portfolio</b>\n\n` +
      `💵 <b>USDC on Polygon (wallet):</b> ${formatUsd(usdc)}\n` +
      `📊 <b>Position value (Polymarket):</b> ${formatUsd(portfolio)}\n\n` +
      `<i>USDC is read via public Polygon RPC (USDC.e ${escapeTelegramHtml(
        `${USDC_POLYGON.slice(0, 10)}…`
      )}).</i>`
    );
  }

  if (cmd === "/positions") {
    const positions = await getOpenPositions(wallet);
    if (positions.length === 0) {
      return `📭 <b>Open positions</b>\n\nNo open positions found for this wallet.`;
    }
    const lines = positions.slice(0, 25).map((p, i) => {
      const title = escapeTelegramHtml(p.title || "Untitled market");
      const outcome = p.outcome
        ? ` (${escapeTelegramHtml(p.outcome)})`
        : "";
      return (
        `${i + 1}. <b>${title}</b>${outcome}\n` +
        `   💵 Price: ${formatPrice(p.curPrice)} · Shares: ${formatShares(p.size)}\n` +
        `   📈 Unrealized P&amp;L: ${formatUsd(p.cashPnl)}`
      );
    });
    const more =
      positions.length > 25
        ? `\n\n<i>…and ${positions.length - 25} more (showing first 25).</i>`
        : "";
    return `📊 <b>Open positions</b> (${positions.length})\n\n${lines.join("\n\n")}${more}`;
  }

  if (cmd === "/history") {
    const activity = await getActivityTrades(wallet, 10);
    const trades = activity.filter((a) => a?.type === "TRADE");
    if (trades.length === 0) {
      return `📜 <b>Recent trades</b>\n\nNo recent TRADE activity found.`;
    }
    const lines = trades.map((a, i) => {
      const title = escapeTelegramHtml(a.title || "Market");
      const side = a.side === "SELL" ? "🔻 Sell" : "🔼 Buy";
      const amt =
        a.usdcSize !== undefined && a.usdcSize !== null
          ? formatUsd(a.usdcSize)
          : formatUsd(
              a.price !== undefined && a.size !== undefined
                ? Number(a.price) * Number(a.size)
                : NaN
            );
      return (
        `${i + 1}. <b>${title}</b>\n` +
        `   ${side} · ${amt}\n` +
        `   🕐 ${formatTs(a.timestamp)}`
      );
    });
    return `📜 <b>Last trades</b> (up to 10)\n\n${lines.join("\n\n")}`;
  }

  if (cmd === "/pnl") {
    const [openPositions, closedRealized] = await Promise.all([
      getOpenPositions(wallet),
      sumClosedPositionsRealized(wallet),
    ]);
    let unrealized = 0;
    let realizedOpen = 0;
    for (const p of openPositions) {
      const u = p?.cashPnl;
      unrealized += typeof u === "number" ? u : Number(u) || 0;
      const r = p?.realizedPnl;
      realizedOpen += typeof r === "number" ? r : Number(r) || 0;
    }
    const realizedTotal = realizedOpen + closedRealized;
    return (
      `📈 <b>P&amp;L summary</b>\n\n` +
      `✅ <b>Realized (total):</b> ${formatUsd(realizedTotal)}\n` +
      `   <i>Open positions realized component:</i> ${formatUsd(realizedOpen)}\n` +
      `   <i>Closed positions:</i> ${formatUsd(closedRealized)}\n\n` +
      `⏳ <b>Unrealized (open):</b> ${formatUsd(unrealized)}\n\n` +
      `<i>Sourced from Polymarket Data API (positions + closed-positions).</i>`
    );
  }

  return (
    `❓ Unknown command: <code>${escapeTelegramHtml(cmd || "(empty)")}</code>\n\n` +
    `Try /start for the command list.`
  );
}

async function processUpdate(body) {
  const token = getEnv("BOT_TOKEN");
  const wallet = getEnv("WALLET_ADDRESS");

  if (!token) {
    throw new Error("BOT_TOKEN is not configured");
  }
  if (!wallet || !isValidAddress(wallet)) {
    throw new Error("WALLET_ADDRESS must be a valid 0x-prefixed address");
  }

  const msg = body?.message || body?.edited_message;
  const chatId = msg?.chat?.id;
  const text = msg?.text;

  if (chatId === undefined || chatId === null) {
    return { ok: true, skipped: true };
  }

  if (typeof text !== "string" || !text.startsWith("/")) {
    await sendTelegramMessage(
      token,
      chatId,
      "ℹ️ Send a command like /start to begin."
    );
    return { ok: true };
  }

  let reply;
  try {
    reply = await handleCommand(text, wallet);
  } catch (e) {
    const errText =
      e instanceof Error ? e.message : "Something went wrong. Please try again.";
    reply = `⚠️ <b>Could not fetch data</b>\n\n${escapeTelegramHtml(errText)}`;
  }

  await sendTelegramMessage(token, chatId, reply);
  return { ok: true };
}

function bindHandler(routePath) {
  app.post(routePath, async (req, res) => {
    try {
      const result = await processUpdate(req.body || {});
      res.status(200).json(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Internal error";
      res.status(500).json({ ok: false, error: msg });
    }
  });
}

bindHandler("/");
bindHandler("/api/bot");

app.get("/", (_req, res) => {
  res.status(200).send("Polymarket Telegram bot — POST /api/bot");
});

module.exports = app;
