'use strict';
/* ======================================================================
   ابزارهای کمکی HTTP خام (بدون Express) — پارس بدنه JSON، کوکی، ارسال
   پاسخ، و سرو فایل استاتیک.
   ====================================================================== */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./config');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon'
};

function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    try { cookies[key] = decodeURIComponent(val); } catch (e) { cookies[key] = val; }
  });
  return cookies;
}

function readJsonBody(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('حجم درخواست بیش از حد مجاز است'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        const parsed = raw ? JSON.parse(raw) : {};
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(new Error('بدنه درخواست باید یک شیء JSON باشد'));
        }
        resolve(parsed);
      } catch (e) {
        reject(new Error('بدنه درخواست JSON معتبر نیست'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function setSessionCookie(res, token, secure) {
  const secureFlag = secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=43200${secureFlag}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
}

function getClientIp(req) {
  // فقط وقتی به X-Forwarded-For اعتماد می‌کنیم که صراحتاً در config
  // اعلام شده باشد سرور پشت یک reverse proxy است — در غیر این صورت هر
  // کاربری می‌تواند این هدر را جعل کند و محدودیت تلاش ورود را دور بزند.
  if (config.trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function serveStatic(req, res, publicDir) {
  const normalizedRoot = path.resolve(publicDir);
  let urlPath;
  try {
    urlPath = decodeURIComponent(req.url.split('?')[0]);
  } catch (e) {
    res.writeHead(400); res.end('Bad Request'); return;
  }
  if (urlPath === '/') urlPath = '/index.html';
  if (urlPath.includes('\0')) { res.writeHead(400); res.end('Bad Request'); return; }

  const filePath = path.normalize(path.join(normalizedRoot, urlPath));

  // جلوگیری از خروج از پوشه‌ی عمومی.
  // نکته: بررسی صرفِ startsWith(root) کافی نیست — مسیری مثل
  // «/../public-secret/x» هم با آن شرط رد نمی‌شد چون رشته‌اش با «public»
  // شروع می‌شود. مقایسه باید با جداکننده‌ی مسیر انجام شود.
  if (filePath !== normalizedRoot && !filePath.startsWith(normalizedRoot + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (statErr, stat) => {
    if (statErr || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('یافت نشد');
      return;
    }

    // ETag بر اساس زمان تغییر و اندازه فایل: بعد از به‌روزرسانی سامانه،
    // مرورگرها نسخه‌ی جدید app.js را می‌گیرند (نسخه قبلی هیچ هدر کشی
    // نداشت و مرورگر ممکن بود ماه‌ها فایل قدیمی را نگه دارد).
    const etag = '"' + crypto.createHash('sha1')
      .update(`${stat.mtimeMs}-${stat.size}`).digest('hex').slice(0, 20) + '"';

    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
      res.end();
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('یافت نشد');
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Cache-Control': 'no-cache',   // یعنی «کش کن ولی هر بار با ETag اعتبارسنجی کن»
        ETag: etag
      });
      res.end(data);
    });
  });
}

module.exports = { parseCookies, readJsonBody, sendJson, setSessionCookie, clearSessionCookie, serveStatic, getClientIp };
