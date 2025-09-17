import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";

const app = express();
app.get("/", (_req, res) => res.send("OK")); // so Render's health check succeeds

const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

io.on("connection", (socket) => {
  console.log("Stellar connected:", socket.id);
  socket.emit("hello", { msg: "It works!" });
});

const PORT = process.env.PORT || 8080; // REQUIRED on Render
httpServer.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
});
