const express = require("express");
const multer = require("multer");
const {
  compileAndUpload,
  compileArtifact,
  listPorts,
} = require("../controllers/arduino.controller");
const { createRequestRateLimit } = require("../services/request-rate-limit");
const verifyToken = require("../middleware/auth");

class ArduinoRoutes {
  constructor() {
    this.router = express.Router();

    this.upload = multer({ limits: { fileSize: 5 * 1024 * 1024 } });
    const json_variables = this.prepareVariables();
    this.compileRateLimit = createRequestRateLimit({
      windowMs: Number.parseInt(json_variables.compile_rate_window),
      max: Number.parseInt(json_variables.compile_rate_max),
      message: "Demasiadas solicitudes de compilacion. Intenta nuevamente en unos segundos.",
    });
    this.routes();
  }
  prepareVariables() {
     const compile_rate_window = process.env.COMPILE_RATE_WINDOW_MS || "60000";
     const compile_rate_max = process.env.COMPILE_RATE_MAX || "10";
    return {
      ok: true,
      compile_rate_window,
      compile_rate_max
    }
  }
  routes() {
    this.router.post(
      "/compile",
      verifyToken,
      this.compileRateLimit,
      this.upload.single("file"),
      compileAndUpload
    );

    this.router.post(
      "/compile/artifact",
      verifyToken,
      this.compileRateLimit,
      this.upload.single("file"),
      compileArtifact
    );

    this.router.get(
      "/ports",
      verifyToken,
      listPorts
    );
  }

  getRouter() {
    return this.router;
  }
}

module.exports = new ArduinoRoutes().getRouter();
