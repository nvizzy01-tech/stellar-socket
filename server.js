// server.js

// --- Imports ---
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import axios from "axios";
import cheerio from "cheerio";

// --- Express + Socket.IO setup ---
const app = express();
app.get("/", (_req, res) => res.send("OK")); // For Render's health check

const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

io.on("connection", (socket) => {
  console.log("Stellar connected:", socket.id);
  socket.emit("hello", { msg: "It works!" });
});

// --- Target product monitor ---
const TARGET_PRODUCT = {
  site: "target",
  name: "2025 Panini NFL Score Blaster Box",
  url: "https://www.target.com/p/2025-panini-nfl-score-football-trading-card-blaster-box/-/A-94681674"
};

let lastStatus = "unknown";

async function checkTargetOnce() {
  try {
    const { data: html } = await axios.get(TARGET_PRODUCT.url, {
      timeout: 8000,
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache"
      },
      validateStatus: (s) => s >= 200 && s < 400
    });

    // Look for stock indicators in JSON or buttons
    const inJson =
      /"availability"\s*:\s*"(?:https?:\/\/schema\.org\/)?InStock"/i.test(html) ||
      /"availabilityStatus"\s*:\s*"IN_STOCK"/i.test(html);

    let inBtn = false;
    if (!inJson) {
      const $ = cheerio.load(html);
      const btnText = $("button, a.button").text().toLowerCase();
      inBtn = /add to cart|ship it|pick up/.test(btnText);
    }

    const status = inJson || inBtn ? "in_stock" : "oos";

    if (status !== lastStatus) {
      lastStatus = status;
      io.emit("stock_update", {
        type: "stock_update",
        site: TARGET_PRODUCT.site,
        name: TARGET_PRODUCT.name,
        url: TARGET_PRODUCT.url,
        status,
        ts: Date.now()
      });
      console.log(`[target] ${TARGET_PRODUCT.name}: ${status}`);
    }
  } catch (e) {
    console.log("Target check failed:", e.message);
  }
}

// Check every 3 seconds
setInterval(checkTargetOnce, 3000);
checkTargetOnce();

// --- Start server ---
const PORT = process.env.PORT || 8080;
httpServer.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
});
