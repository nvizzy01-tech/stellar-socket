// server.cjs — Target + Walmart monitors with auto-slowdown (Render-friendly)

const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");
const axios = require("axios");
const cheerio = require("cheerio");

// ===== Basic server (health check) =====
const app = express();
app.get("/", (_req, res) => res.send("OK"));

const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

io.on("connection", (socket) => {
  console.log("Stellar connected:", socket.id);
  socket.emit("hello", { msg: "Socket online." });
});

const PORT = process.env.PORT || 8080;
httpServer.listen(PORT, () => console.log(`Listening on port ${PORT}`));

// ===== Config =====
const PRODUCTS = [
  {
    site: "target",
    name: "Pokémon Prismatic Evolutions Premium Figure Collection",
    url: "https://www.target.com/p/pok-233-mon-trading-card-game-scarlet-38-violet-prismatic-evolutions-premium-figure-collection/-/A-94864079",
  },
  {
    site: "walmart",
    name: "Pokémon Prismatic Booster Bundle",
    url: "https://www.walmart.com/ip/seort/14803962651",
  },
  {
    site: "walmart",
    name: "Magic x Avatar: The Last Airbender Collector Booster",
    url: "https://www.walmart.com/ip/seort/17727051635",
  },
];

// ===== Tuning =====
const BASE_FAST = Number(process.env.FAST_INTERVAL_MS || 3000);
const BASE_SLOW = Number(process.env.SLOW_INTERVAL_MS || 10000);
const STAGGER_MS = Number(process.env.STAGGER_MS || 600);
const UA =
  process.env.USER_AGENT ||
  "Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari";
const WALMART_REQUIRE_FIRST_PARTY = true;

// ===== Auto-slowdown state =====
let currentInterval = BASE_FAST;
let consecutiveErrors = 0;
let cycleTimer = null;

function adjustInterval(ok) {
  if (ok) {
    if (consecutiveErrors > 0) consecutiveErrors = 0;
    if (currentInterval > BASE_FAST) {
      currentInterval = Math.max(BASE_FAST, currentInterval - 1000);
      console.log(`✅ Healthy again. Speeding up to ${currentInterval}ms`);
    }
  } else {
    consecutiveErrors++;
    if (consecutiveErrors >= 3 && currentInterval < BASE_SLOW) {
      currentInterval = Math.min(BASE_SLOW, currentInterval + 2000);
      console.log(`⚠️ Multiple errors. Slowing down to ${currentInterval}ms`);
      consecutiveErrors = 0; // reset counter after backoff
    }
  }
  restartScheduler();
}

// ===== Fetch helper =====
async function fetchHTML(url) {
  try {
    const res = await axios.get(url, {
      timeout: 9000,
      headers: {
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
      },
      validateStatus: (s) => s >= 200 && s < 400,
      maxRedirects: 5,
    });
    adjustInterval(true); // success
    return typeof res.data === "string" ? res.data : "";
  } catch (e) {
    console.log("Fetch failed:", e.message, "->", url);
    adjustInterval(false); // failure
    return "";
  }
}

// ===== Target detector (preorder-safe) =====
function detectTargetStatus(html) {
  if (/\b(sold\s*out|out\s*of\s*stock)\b/i.test(html)) return "oos";

  const jsonInStock =
    /"availabilityStatus"\s*:\s*"IN_STOCK"/i.test(html) ||
    /"availability"\s*:\s*"(?:https?:\/\/schema\.org\/)?InStock"/i.test(html);

  const jsonOut =
    /"availabilityStatus"\s*:\s*"OUT_OF_STOCK"/i.test(html) ||
    /"availability"\s*:\s*"(?:https?:\/\/schema\.org\/)?OutOfStock"/i.test(html);

  const jsonPre = /"availabilityStatus"\s*:\s*"PREORDER"/i.test(html);

  if (jsonOut && !jsonInStock) return "oos";
  if (jsonPre && !jsonInStock) return "preorder";
  if (jsonInStock && !jsonOut) return "in_stock";

  return "oos";
}

// ===== Walmart detector (first-party filter) =====
function detectWalmartStatus(html) {
  const saysSoldOut =
    /\b(sold\s*out|out\s*of\s*stock)\b/i.test(html) ||
    /"availabilityStatus"\s*:\s*"OUT_OF_STOCK"/i.test(html);
  if (saysSoldOut) return { status: "oos", isFirstParty: false };

  const hasFPText = /\bsold\s*(and|&)?\s*shipped\s*by\s*walmart\b/i.test(html);
  const sellerIsWalmart = /"sellerName"\s*:\s*"Walmart"/i.test(html);
  const sellerFirstParty =
    /"sellerType"\s*:\s*"FIRST_PARTY"/i.test(html) ||
    /"isWalmartSeller"\s*:\s*true/i.test(html);

  const isFirstParty = hasFPText || sellerIsWalmart || sellerFirstParty;

  const jsonInStock =
    /"availabilityStatus"\s*:\s*"IN_STOCK"/i.test(html) ||
    /"buttonState"\s*:\s*"ADD_TO_CART"/i.test(html) ||
    /"availability"\s*:\s*"(?:https?:\/\/schema\.org\/)?InStock"/i.test(html);

  if (jsonInStock && isFirstParty) return { status: "in_stock", isFirstParty: true };
  if (jsonInStock && !isFirstParty) return { status: "third_party", isFirstParty: false };
  return { status: "oos", isFirstParty };
}

// ===== Checkers =====
async function checkTarget(p) {
  const html = await fetchHTML(p.url);
  if (!html) return;
  handleStatusUpdate(p, detectTargetStatus(html));
}

async function checkWalmart(p) {
  const html = await fetchHTML(p.url);
  if (!html) return;
  const { status, isFirstParty } = detectWalmartStatus(html);
  const effectiveStatus =
    WALMART_REQUIRE_FIRST_PARTY && status === "third_party" ? "oos" : status;
  handleStatusUpdate(p, effectiveStatus, { isFirstParty, rawStatus: status });
}

// ===== Status update =====
const lastStatus = new Map();

function handleStatusUpdate(p, status, extra = {}) {
  const prev = lastStatus.get(p.url);
  if (prev === status) return;

  lastStatus.set(p.url, status);

  const payload = {
    type: "stock_update",
    site: p.site,
    name: p.name,
    url: p.url,
    status,
    ts: Date.now(),
    ...extra,
  };

  io.emit("stock_update", payload);
  console.log(
    `[${p.site}] ${p.name}: ${prev || "unknown"} -> ${status}`,
    extra.isFirstParty !== undefined ? `(first-party: ${!!extra.isFirstParty})` : ""
  );
}

// ===== Scheduler with auto-slowdown =====
function runCycle() {
  PRODUCTS.forEach((p, i) => {
    setTimeout(() => {
      if (p.site === "target") checkTarget(p);
      if (p.site === "walmart") checkWalmart(p);
    }, i * STAGGER_MS);
  });
}

function restartScheduler() {
  if (cycleTimer) clearInterval(cycleTimer);
  cycleTimer = setInterval(runCycle, currentInterval);
}

runCycle();
restartScheduler();
