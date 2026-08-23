'use strict';
/* ======================================================================
   لایه‌های سخت‌سازی امنیتی

   Originهای مجاز علاوه بر localhost و آدرس‌های LAN می‌توانند از طریق
   PUBLIC_URL / EXTRA_ALLOWED_ORIGINS برای استقرار پشت reverse proxy
   (مانند Render) تعریف شوند.
   ====================================================================== */

const os = require('node:os');
const config = require('./config');
const { db } = require('./db');

function getLoginState(ip) {
  const row = db.prepare('SELECT * FROM login_attempts WHERE ip = ?').get(ip);
  if (!row) return { attempts: [], blockedUntil: null };
  let attempts = [];
  try { attempts = JSON.parse(row.attempts) || []; } catch (e) { attempts = []; }
  return { attempts, blockedUntil: row.blocked_until || null };
}

function saveLoginState(ip, state) {
  db.prepare(`INSERT INTO login_attempts (ip, attempts, blocked_until) VALUES (?, ?, ?)
              ON CONFLICT(ip) DO UPDATE SET attempts = excluded.attempts, blocked_until = excluded.blocked_until`)
    .run(ip, JSON.stringify(state.attempts), state.blockedUntil);
}

function checkLoginRateLimit(ip) {
  const state = getLoginState(ip);
  const now = Date.now();
  if (state.blockedUntil && state.blockedUntil > now) {
    return { allowed: false, retryAfterSeconds: Math.ceil((state.blockedUntil - now) / 1000) };
  }
  if (state.blockedUntil && state.blockedUntil <= now) {
    state.blockedUntil = null;
    state.attempts = [];
    saveLoginState(ip, state);
  }
  const recent = state.attempts.filter(t => now - t < config.loginRateLimit.windowMs);
  if (recent.length >= config.loginRateLimit.maxAttempts) {
    state.attempts = recent;
    state.blockedUntil = now + config.loginRateLimit.blockMs;
    saveLoginState(ip, state);
    return { allowed: false, retryAfterSeconds: Math.ceil(config.loginRateLimit.blockMs / 1000) };
  }
  if (recent.length !== state.attempts.length) {
    state.attempts = recent;
    saveLoginState(ip, state);
  }
  return { allowed: true };
}

function recordLoginFailure(ip) {
  const state = getLoginState(ip);
  state.attempts.push(Date.now());
  saveLoginState(ip, state);
}

function recordLoginSuccess(ip) {
  db.prepare('DELETE FROM login_attempts WHERE ip = ?').run(ip);
}

function cleanupLoginAttempts() {
  const now = Date.now();
  const rows = db.prepare('SELECT ip, attempts, blocked_until FROM login_attempts').all();
  const del = db.prepare('DELETE FROM login_attempts WHERE ip = ?');
  for (const row of rows) {
    let attempts = [];
    try { attempts = JSON.parse(row.attempts) || []; } catch (e) { /* noop */ }
    const stillBlocked = row.blocked_until && row.blocked_until > now;
    const hasRecent = attempts.some(t => now - t < config.loginRateLimit.windowMs);
    if (!stillBlocked && !hasRecent) del.run(row.ip);
  }
}

function applySecurityHeaders(res, isHttps) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; connect-src 'self' ws: wss:; form-action 'self'; " +
    "base-uri 'self'; object-src 'none'; frame-ancestors 'none';");
  if (isHttps) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

function localIpv4Addresses() {
  const result = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) result.push(net.address);
    }
  }
  return result;
}

function buildAllowedOrigins() {
  const origins = new Set();
  origins.add(`http://localhost:${config.httpPort}`);
  origins.add(`http://127.0.0.1:${config.httpPort}`);

  if (config.mode === 'https' && config.domain) {
    origins.add(`https://${config.domain}`);
    if (config.httpsPort !== 443) origins.add(`https://${config.domain}:${config.httpsPort}`);
  } else {
    for (const addr of localIpv4Addresses()) {
      origins.add(`http://${addr}:${config.httpPort}`);
    }
  }

  if (config.publicUrl) origins.add(config.publicUrl);
  config.extraAllowedOrigins.forEach(o => origins.add(o));
  return origins;
}

let allowedOrigins = buildAllowedOrigins();

function refreshAllowedOrigins() {
  allowedOrigins = buildAllowedOrigins();
}

function isOriginAllowed(originHeader) {
  if (!originHeader) return true;
  if (allowedOrigins.has(originHeader)) return true;
  refreshAllowedOrigins();
  return allowedOrigins.has(originHeader);
}

function describeAllowedOrigins() {
  return Array.from(allowedOrigins);
}

module.exports = {
  checkLoginRateLimit,
  recordLoginFailure,
  recordLoginSuccess,
  cleanupLoginAttempts,
  applySecurityHeaders,
  isOriginAllowed,
  refreshAllowedOrigins,
  describeAllowedOrigins
};
