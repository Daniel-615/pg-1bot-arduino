const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const http = require("http");
const { SerialPort } = require("serialport");
const { ReadlineParser } = require("@serialport/parser-readline");
const { Server } = require("socket.io");
require("dotenv").config({ quiet: true });

const arduino_routes = require("./routes/arduino.routes");
const codey_routes = require("./routes/codey.routes");
const authMiddleware = require("./middleware/auth");
const { LOCAL_AGENT_MODE } = require("./config/config.js");
const verifyToken = authMiddleware;
const { verifySocketToken } = authMiddleware;

const normalizeOrigin = (origin) => origin.trim().replace(/\/$/, "");
const configuredOrigins = [
  process.env.CORS_ORIGINS,
  process.env.FRONTEND_URL,
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "https://1botide.online",
  "https://www.1botide.online",
]
  .filter(Boolean)
  .flatMap((value) => value.split(","))
  .map(normalizeOrigin)
  .filter(Boolean);
const allowAnyOrigin = LOCAL_AGENT_MODE || configuredOrigins.includes("*");
const allowedOrigins = new Set(configuredOrigins);

function corsOrigin(origin, callback) {
  const normalizedOrigin = origin ? normalizeOrigin(origin) : null;

  // Requests without Origin are healthchecks and server-to-server calls.
  if (!normalizedOrigin || allowAnyOrigin || allowedOrigins.has(normalizedOrigin)) {
    return callback(null, true);
  }

  return callback(new Error(`Origen no permitido por CORS: ${normalizedOrigin}`));
}

class AppServer {
  constructor() {
    this.app = express();
    this.server = http.createServer(this.app);
  
     this.PORT = process.env.PORT || 3000;
    this.io = new Server(this.server, {
      cors: {
        origin: corsOrigin,
        credentials: true,
      },
    });
    this.io.use(verifySocketToken);

    this.serialPort = null;

    this.middlewares();
    this.routes();
    this.serialMonitor();
    this.notFound();
    this.errorHandler();
  }

  middlewares() {
    this.app.use(helmet());
    this.app.use(cors({
      origin: corsOrigin,
      credentials: true,
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
    }));
    this.app.use(morgan("dev"));
    this.app.use(express.json());
  }

  routes() {
    this.app.get("/health", (_req, res) => {
      res.json({ ok: true, service: "pg-1bot-backend" });
    });

    this.app.use("/api/arduino", arduino_routes);
    this.app.use("/api/codey", codey_routes);

    this.app.post(
      "/api/arduino/monitor/start",
      verifyToken,
      this.startSerialMonitor.bind(this)
    );
    this.app.post(
      "/api/arduino/monitor/stop",
      verifyToken,
      this.stopSerialMonitor.bind(this)
    );
  }

  serialMonitor() {
    this.io.on("connection", (socket) => {
      console.log("Frontend conectado al serial monitor");

      socket.on("disconnect", () => {
        console.log("Frontend desconectado");
      });
    });
  }

  async startSerialMonitor(req, res) {
    try {
      const port = req.body.port || "COM3";
      const baud = req.body.baud || 115200;

      if (this.serialPort && this.serialPort.isOpen) {
        await new Promise((resolve, reject) => {
          this.serialPort.close((error) => error ? reject(error) : resolve());
        });
      }

      this.serialPort = new SerialPort({
        path: port,
        baudRate: baud,
      });

      const parser = this.serialPort.pipe(
        new ReadlineParser({
          delimiter: "\n",
        })
      );

      parser.on("data", (line) => {
        console.log("ESP32:", line);

        this.io.emit("serial-data", line);
      });

      this.serialPort.on("error", (err) => {
        console.error("Serial error:", err);
      });

      return res.json({
        ok: true,
        message: "Serial monitor started",
        port,
        baud,
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error.message,
      });
    }
  }

  async stopSerialMonitor(req, res) {
    try {
      if (this.serialPort && this.serialPort.isOpen) {
        await new Promise((resolve, reject) => {
          this.serialPort.close((error) => error ? reject(error) : resolve());
        });
      }

      this.serialPort = null;

      return res.json({
        ok: true,
        message: "Serial monitor stopped",
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error.message,
      });
    }
  }

  notFound() {
    this.app.use((req, res) => {
      res
        .status(404)
        .json({
          ok: false,
          message: "Ruta no encontrada",
        });
    });
  }

  errorHandler() {
    this.app.use((err, req, res, _next) => {
      console.error(`[ERROR] ${req.method} ${req.originalUrl}:`, err.stack || err.message);
      const status = err.status || 500;
      res.status(status).json({
        ok: false,
        status,
        message: status >= 500 ? "Error interno del servidor." : err.message,
        error: err.code || (status < 500 ? err.message : undefined),
      });
    });
  }

  listen() {
    const host = LOCAL_AGENT_MODE ? "127.0.0.1" : "0.0.0.0";
    this.server.listen(this.PORT, host, () => {
      console.log(`Servidor corriendo en http://${host}:${this.PORT}`);
      if (LOCAL_AGENT_MODE) {
        console.log("Modo agente local activo: no se requiere archivo .env.");
      }
    });
  }
}

const server = new AppServer();

server.listen();
