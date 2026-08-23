'use strict';
/* ======================================================================
   لایه‌های سخت‌سازی امنیتی

   ۱. محدودسازی تلاش ورود (ضدBrute-Force) — حالا در پایگاه‌داده ذخیره
      می‌شود، نه فقط در حافظه؛ پس با ری‌استارت سرور (یا کرش عمدی توسط
      مهاجم) قفل باز نمی‌شود.
   ۲. هدرهای امنیتی HTTP استاندارد (HSTS، CSP، ضدClickjacking، ...)
      CSP دیگر به 'unsafe-inline' برای اسکریپت نیاز ندارد، چون همه‌ی
      onclickهای درون‌خطی فرانت‌اند به شنونده‌ی رویداد تبدیل شده‌اند.
   ۳. بررسی Origin روی درخواست‌های تغییردهنده (دفاع CSRF).

      نکته‌ی مهم (باگ اصلاح‌شده): نسخه قبلی فقط localhost را مجاز
      می‌دانست، بنابراین هر مرورگری که با آدرس شبکه داخلی
      (http://192.168.1.23:8080) وصل می‌شد حتی نمی‌توانست لاگین کند —
      یعنی کل محصول در شبکه کار نمی‌کرد. حالا آدرس‌های IPv4 محلی سرور
      به‌صورت خودکار مجاز می‌شوند و در صورت تغییر آی‌پی (DHCP) هم فهرست
      دوباره ساخته می‌شود.
   ====================================================================== */

const os = require('node:os');
const config = require('./config');
const { db } = require('./db');

// ---------------------------------------------------------------------
// ۱. محدودسازی تلاش ورود (ماندگار در پایگاه‌داده)
// ---------------------------------------------------------------------
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

// پاک‌سازی دوره‌ای رکوردهای قدیمی
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

// ---------------------------------------------------------------------
// ۲. هدرهای امنیتی
// ---------------------------------------------------------------------
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

// ---------------------------------------------------------------------
// ۳. بررسی Origin برای درخواست‌های تغییردهنده (دفاع CSRF)
// ---------------------------------------------------------------------
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
    // حالت شبکه داخلی: هر آدرس IPv4 خود این کامپیوتر یک مبدأ معتبر است،
    // چون همکاران دقیقاً با همان آدرس‌ها به سامانه وصل می‌شوند.
    for (const addr of localIpv4Addresses()) {
      origins.add(`http://${addr}:${config.httpPort}`);
    }
  }

  config.extraAllowedOrigins.forEach(o => origins.add(o));
  return origins;
}

let allowedOrigins = buildAllowedOrigins();

// آی‌پی سرور ممکن است با DHCP عوض شود؛ هر ۱۰ دقیقه فهرست بازسازی می‌شود
// تا سامانه بعد از تغییر آی‌پی بدون ری‌استارت به کار ادامه دهد.
function refreshAllowedOrigins() {
  allowedOrigins = buildAllowedOrigins();
}

function isOriginAllowed(originHeader) {
  if (!originHeader) return true; // کلاینت‌های غیرمرورگری (curl، ابزار داخلی) Origin نمی‌فرستند
  if (allowedOrigins.has(originHeader)) return true;
  // بازسازی یک‌باره در صورت تغییر آی‌پی، بعد یک تلاش دوباره
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
