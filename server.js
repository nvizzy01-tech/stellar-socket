import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

io.on("connection", (socket) => {
  console.log("Stellar connected!", socket.id);
  // This will send a test message when Stellar connects
  socket.emit("hello", { msg: "It works!" });
});

httpServer.listen(8080, () => {
  console.log("Listening on http://localhost:8080");
});
