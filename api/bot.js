const express = require("express");

const DATA_API = "https://data-api.polymarket.com";

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

/** Telegram sends `/cmd@BotName` in groups; strip @suffix so we still match. */
function parseCommandToken(text) {
  if (typeof text !== "string") return "";
  const first = text.trim().split(/\s+/)[0] || "";
  if (!first.startsWith("/")) return "";
  const base = first.includes("@") ? first.slice(0, first.indexOf("@")) : first;
  return base.toLowerCase();
}

function stripHtmlForTelegramFallback(html) {
  return String(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

async function sendTelegramMessage(token, chatId, text) {
  const url = `https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`;
  const payloadHtml = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payloadHtml),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.ok) return data;

  const desc = String(data.description || "");
  const parseErr =
    /parse entities|can't parse|parse mode/i.test(desc) ||
    data.error_code === 400;
  if (parseErr) {
    const res2 = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: stripHtmlForTelegramFallback(text),
        disable_web_page_preview: true,
      }),
    });
    const data2 = await res2.json().catch(() => ({}));
    if (res2.ok && data2.ok) return data2;
    throw new Error(data2.description || desc || "sendMessage failed");
  }
  throw new Error(desc || res.statusText || "sendMessage failed");
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

async function getActivity(user, limit, type) {
  const query = [
    `user=${encodeURIComponent(user)}`,
    `limit=${Number(limit) || 10}`,
    "sortBy=TIMESTAMP",
    "sortDirection=DESC",
  ];
  if (type) {
    query.push(`type=${encodeURIComponent(type)}`);
  }
  const rows = await fetchJson(`${DATA_API}/activity?${query.join("&")}`);
  return Array.isArray(rows) ? rows : [];
}

function readActivityUsdSize(activity) {
  const usdc = Number(activity?.usdcSize);
  if (Number.isFinite(usdc)) return usdc;
  const price = Number(activity?.price);
  const size = Number(activity?.size);
  if (Number.isFinite(price) && Number.isFinite(size)) return price * size;
  return NaN;
}

function activityCashDelta(activity) {
  const type = String(activity?.type || "").toUpperCase();
  const usdc = readActivityUsdSize(activity);
  if (!Number.isFinite(usdc)) return 0;

  if (type === "TRADE") {
    const side = String(activity?.side || "").toUpperCase();
    if (side === "BUY") return -Math.abs(usdc);
    if (side === "SELL") return Math.abs(usdc);
    return 0;
  }

  if (type === "REDEEM" || type === "REWARD" || type === "CONVERSION") {
    return usdc;
  }

  if (type === "SPLIT" || type === "MERGE") {
    return usdc;
  }

  return 0;
}

function formatSignedUsd(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "—";
  if (x === 0) return formatUsd(0);
  const sign = x > 0 ? "+" : "-";
  return `${sign}${formatUsd(Math.abs(x))}`;
}

function formatHistoryLine(activity, idx) {
  const type = String(activity?.type || "").toUpperCase();
  const title = escapeTelegramHtml(activity?.title || "Market");
  const outcome = activity?.outcome
    ? ` (${escapeTelegramHtml(activity.outcome)})`
    : "";
  const timeText = formatTs(activity?.timestamp);
  const usdc = readActivityUsdSize(activity);
  const sharesText = Number.isFinite(Number(activity?.size))
    ? formatShares(activity.size)
    : "—";

  if (type === "TRADE") {
    const side = String(activity?.side || "").toUpperCase();
    const isBuy = side === "BUY";
    const action = isBuy ? "➕ Bought" : side === "SELL" ? "➖ Sold" : "🔁 Trade";
    const signed = Number.isFinite(usdc)
      ? formatSignedUsd(isBuy ? -Math.abs(usdc) : Math.abs(usdc))
      : "—";
    return (
      `${idx + 1}. ${action} <b>${title}</b>${outcome}\n` +
      `   💵 ${signed} · Shares: ${sharesText}\n` +
      `   🕐 ${timeText}`
    );
  }

  if (type === "REDEEM") {
    const won = Number.isFinite(usdc) && usdc > 0;
    const action = won ? "✅ Claimed" : "❌ Lost";
    const value = won ? formatSignedUsd(usdc) : "—";
    return (
      `${idx + 1}. ${action} <b>${title}</b>\n` +
      `   💵 ${value}\n` +
      `   🕐 ${timeText}`
    );
  }

  if (type === "REWARD") {
    const value = Number.isFinite(usdc) ? formatSignedUsd(usdc) : "—";
    return (
      `${idx + 1}. 🎁 Reward <b>${title}</b>\n` +
      `   💵 ${value}\n` +
      `   🕐 ${timeText}`
    );
  }

  if (type === "CONVERSION") {
    const delta = activityCashDelta(activity);
    const value = Number.isFinite(Number(delta)) ? formatSignedUsd(delta) : "—";
    return (
      `${idx + 1}. 🔄 Conversion <b>${title}</b>\n` +
      `   💵 ${value}\n` +
      `   🕐 ${timeText}`
    );
  }

  if (type === "SPLIT" || type === "MERGE") {
    const delta = activityCashDelta(activity);
    const value = Number.isFinite(Number(delta)) ? formatSignedUsd(delta) : "—";
    const action = type === "SPLIT" ? "🧩 Split" : "🧩 Merge";
    return (
      `${idx + 1}. ${action} <b>${title}</b>\n` +
      `   💵 ${value}\n` +
      `   🕐 ${timeText}`
    );
  }

  return (
    `${idx + 1}. ℹ️ ${escapeTelegramHtml(type || "ACTIVITY")} <b>${title}</b>\n` +
    `   🕐 ${timeText}`
  );
}

async function getPastDayPnl(user) {
  const rows = await getActivity(user, 200);
  const sinceSec = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
  return rows.reduce((sum, row) => {
    const ts = Number(row?.timestamp);
    if (!Number.isFinite(ts) || ts < sinceSec) return sum;
    return sum + activityCashDelta(row);
  }, 0);
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

async function handleCommand(command, wallet) {
  const cmd = parseCommandToken(command);

  if (cmd === "/start") {
    const w = escapeTelegramHtml(wallet);
    return (
      `👋 <b>Welcome to the Polymarket helper bot!</b>\n\n` +
      `Data comes from Polymarket's public Data API (no chain RPC).\n\n` +
      `📌 <b>Commands</b>\n` +
      `/balance — 📊 Portfolio snapshot (value + past day P&amp;L)\n` +
      `/positions — Open positions with price, size, and unrealized P&amp;L\n` +
      `/history — Recent trades and claims\n` +
      `/pnl — Realized vs unrealized P&amp;L summary\n\n` +
      `Wallet: <code>${w}</code>`
    );
  }

  if (cmd === "/balance") {
    const [portfolio, pastDayPnl] = await Promise.all([
      getPortfolioValue(wallet),
      getPastDayPnl(wallet),
    ]);
    return (
      `💰 <b>Portfolio</b>\n\n` +
      `📊 <b>Total position value:</b> ${formatUsd(portfolio)}\n` +
      `🪙 <b>Available to trade (est.):</b> ${formatUsd(portfolio)}\n` +
      `📈 <b>Past day P&amp;L:</b> ${formatSignedUsd(pastDayPnl)}\n\n` +
      `<i><code>/value</code> returns position value only; available-to-trade cash is estimated from that same value.</i>\n` +
      `<i>Past day P&amp;L is inferred from recent activity (trades + redeems/rewards).</i>`
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
    const activity = await getActivity(wallet, 40);
    const supportedTypes = new Set([
      "TRADE",
      "REDEEM",
      "REWARD",
      "CONVERSION",
      "SPLIT",
      "MERGE",
    ]);
    const rows = activity.filter((a) =>
      supportedTypes.has(String(a?.type || "").toUpperCase())
    );

    if (rows.length === 0) {
      return `📜 <b>Recent activity</b>\n\nNo recent activity found.`;
    }
    const lines = rows.slice(0, 15).map((a, i) => formatHistoryLine(a, i));
    const more =
      rows.length > 15
        ? `\n\n<i>…and ${rows.length - 15} more (showing latest 15).</i>`
        : "";
    return `📜 <b>Recent activity</b> (latest first)\n\n${lines.join("\n\n")}${more}`;
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

  const msg =
    body?.message ||
    body?.edited_message ||
    body?.channel_post ||
    body?.edited_channel_post;
  const chatId = msg?.chat?.id;
  const text = msg?.text;

  if (chatId === undefined || chatId === null) {
    return { ok: true, skipped: true };
  }

  if (typeof text !== "string" || !text.trim().startsWith("/")) {
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

function healthText() {
  return (
    "Polymarket Telegram bot\n\n" +
    "Webhook: POST /api/bot (same payload as Telegram sendWebhook)\n" +
    "Set BOT_TOKEN and WALLET_ADDRESS in Vercel env, then setWebhook to https://<your-domain>/api/bot"
  );
}

app.get("/", (_req, res) => {
  res.status(200).type("text/plain").send(healthText());
});

app.get("/api/bot", (_req, res) => {
  res.status(200).type("text/plain").send(healthText());
});

module.exports = app;
module.exports._internals = {
  handleCommand,
  getActivity,
  getPastDayPnl,
  formatHistoryLine,
};
