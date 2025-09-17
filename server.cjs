// server.cjs — Render-friendly Socket.IO + Target monitor (with preorder handling)

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

// ===== Config: add/remove Target products here =====
const TARGET_PRODUCTS = [
  {
    site: "target",
    name: "Pokémon Prismatic Evolutions Premium Figure Collection",
    url: "https://www.target.com/p/pok-233-mon-trading-card-game-scarlet-38-violet-prismatic-evolutions-premium-figure-collection/-/A-94864079",
  },
  // Add more like:
  // { site: "target", name: "Another Item", url: "https://www.target.com/p/.../-/A-12345678" },
];

// ===== Tuning (env vars optional on Render) =====
const FAST_INTERVAL_MS = Number(process.env.FAST_INTERVAL_MS || 3000); // how often to re-check list
const STAGGER_MS = Number(process.env.STAGGER_MS || 600);              // spacing between items per cycle
const UA =
  process.env.USER_AGENT ||
  "Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari";

// Remember last status so we only emit on change
const lastStatus = new Map(); // url -> "in_stock" | "oos" | "preorder"

// ===== Helpers =====
async function fetchHTML(url) {
  try {
    const res = await axios.get(url, {
      timeout: 8000,
      headers: {
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
      },
      validateStatus: (s) => s >= 200 && s < 400,
    });
    return typeof res.data === "string" ? res.data : "";
  } catch (e) {
    console.log("Fetch failed:", e.message, "->", url);
    return "";
  }
}

// Stricter Target detector with preorder handling
function detectTargetStatus(html) {
  // Hard negative: explicit sold-out phrases anywhere
  if (/\b(sold\s*out|out\s*of\s*stock)\b/i.test(html)) {
    return "oos";
  }

  // JSON flags are most reliable
  const jsonInStock =
    /"availabilityStatus"\s*:\s*"IN_STOCK"/i.test(html) ||
    /"availability"\s*:\s*"(?:https?:\/\/schema\.org\/)?InStock"/i.test(html);

  const jsonOut =
    /"availabilityStatus"\s*:\s*"OUT_OF_STOCK"/i.test(html) ||
    /"availability"\s*:\s*"(?:https?:\/\/schema\.org\/)?OutOfStock"/i.test(html) ||
    /"is_out_of_stock_in_all_store_locations"\s*:\s*true/i.test(html);

  const jsonPre =
    /"availabilityStatus"\s*:\s*"PREORDER"/i.test(html) ||
    /\bpreorder\b/i.test(html);

  // Decide by JSON first
  if (jsonOut && !jsonInStock) return "oos";
  if (jsonPre && !jsonInStock) return "preorder";
  if (jsonInStock && !jsonOut) return "in_stock";

  // Fallback: look for enabled purchase CTAs (avoid disabled/hidden)
  const $ = cheerio.load(html);
  let hasEnabledPurchaseCta = false;
  $("button,a.button").each((_, el) => {
    const text = ($(el).text() || "").toLowerCase();
    const disabled =
      $(el).attr("disabled") != null || $(el).attr("aria-disabled") === "true";
    if (!disabled && /add to cart|ship it|pick up|buy now/.test(text)) {
      hasEnabledPurchaseCta = true;
    }
  });

  if (hasEnabledPurchaseCta && !jsonOut) return "in_stock";
  return "oos";
}

async function checkTargetProduct(p) {
  const html = await fetchHTML(p.url);
  if (!html) return;

  const status = detectTargetStatus(html);
  const prev = lastStatus.get(p.url);

  if (prev !== status) {
    lastStatus.set(p.url, status);
    const payload = {
      type: "stock_update",
      site: p.site,
      name: p.name,
      url: p.url,
      status, // "in_stock" | "oos" | "preorder"
      ts: Date.now(),
    };
    io.emit("stock_update", payload);
    console.log(`[target] ${p.name}: ${prev || "unknown"} -> ${status}`);
  }
}

// Run one cycle over the list (stagger requests a bit)
function runTargetCycle() {
  TARGET_PRODUCTS.forEach((p, i) => {
    setTimeout(() => checkTargetProduct(p), i * STAGGER_MS);
  });
}

// Kick off + repeat
runTargetCycle();
setInterval(runTargetCycle, FAST_INTERVAL_MS);

