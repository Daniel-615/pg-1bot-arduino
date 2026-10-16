const windows = new Map();

function createRequestRateLimit({ windowMs, max, message }) {
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const current = windows.get(key);

    if (windows.size > 10000) {
      for (const [entryKey, entry] of windows) {
        if (entry.resetAt <= now) {
          windows.delete(entryKey);
        }
      }
    }

    if (!current || current.resetAt <= now) {
      windows.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (current.count >= max) {
      res.set('Retry-After', Math.ceil((current.resetAt - now) / 1000));
      return res.status(429).json({ ok: false, error: message });
    }

    current.count += 1;
    return next();
  };
}

module.exports = { createRequestRateLimit };
