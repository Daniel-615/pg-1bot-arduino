const jwt = require("jsonwebtoken");
const { SECRET_JWT_KEY, LOCAL_AGENT_MODE } = require("../config/config.js");

function isLoopback(address) {
  return address === "::1" || address === "127.0.0.1" || address === "::ffff:127.0.0.1";
}

function getCookieToken(cookieHeader) {
  const cookie = cookieHeader
    ?.split(";")
    .map((part) => part.trim().split("="))
    .find(([name]) => name === "access_token");

  return cookie ? decodeURIComponent(cookie.slice(1).join("=")) : null;
}

function getToken(req) {
  const authorization = req.headers.authorization || "";
  const bearerToken = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  return bearerToken || getCookieToken(req.headers.cookie);
}

function verifyJwt(token) {
  if (!token || !SECRET_JWT_KEY) return null;
  return jwt.verify(token, SECRET_JWT_KEY, { algorithms: ["HS256"] });
}

function verifyToken(req, res, next) {
  if (LOCAL_AGENT_MODE && isLoopback(req.socket.remoteAddress)) {
    req.user = { localAgent: true };
    return next();
  }

  try {
    const user = verifyJwt(getToken(req));
    if (!user) throw new Error("Token ausente");
    req.user = user;
    return next();
  } catch (error) {
    console.warn(`[AUTH] ${req.method} ${req.originalUrl} rechazado: ${error.message}`);
    return res.status(401).json({ ok: false, message: "Token inválido o ausente." });
  }
}

function verifySocketToken(socket, next) {
  if (LOCAL_AGENT_MODE && isLoopback(socket.handshake.address)) {
    socket.user = { localAgent: true };
    return next();
  }

  try {
    const authorization = socket.handshake.headers.authorization || "";
    const bearerToken = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
    const token = socket.handshake.auth?.token || bearerToken;
    const user = verifyJwt(token);
    if (!user) throw new Error("Token ausente");
    socket.user = user;
    return next();
  } catch (error) {
    console.warn(`[AUTH] Socket rechazado: ${error.message}`);
    return next(new Error("No autorizado"));
  }
}

module.exports = verifyToken;
module.exports.verifySocketToken = verifySocketToken;
