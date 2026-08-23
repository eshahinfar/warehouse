'use strict';
/* ======================================================================
   تنظیمات مرکزی سرور
   ابتدا از فایل config.json (در ریشه پروژه) خوانده می‌شود؛ هر مقدار را
   می‌توان با متغیر محیطی هم‌نام بازنویسی کرد (برای استقرارهای سرویسی).
   نیازی به بسته dotenv نیست — همه‌چیز با ابزارهای داخلی Node انجام می‌شود.
   ====================================================================== */

const fs = require('node:fs');
const path = require('node:path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

let fileConfig = {};
if (fs.existsSync(CONFIG_PATH)) {
  try {
    fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    console.error('خطا در خواندن config.json — از مقادیر پیش‌فرض استفاده می‌شود:', e.message);
  }
}

function pick(envKey, fileKey, defaultValue) {
  if (process.env[envKey] !== undefined) return process.env[envKey];
  if (fileConfig[fileKey] !== undefined) return fileConfig[fileKey];
  return defaultValue;
}

const config = {
  // حالت اجرا: 'lan'  → HTTP محلی/پشت reverse proxy
  //            'https' → HTTPS مستقیم با گواهی TLS مدیریت‌شده توسط برنامه
  mode: pick('WAREHOUSE_MODE', 'mode', 'lan'),

  httpPort: Number(pick('PORT', 'httpPort', 8080)),

  // اگر برنامه پشت reverse proxy (مثل Render/nginx) قرار دارد، این را true کنید
  // تا آی‌پی واقعی کاربر از X-Forwarded-For خوانده شود.
  trustProxy: String(pick('TRUST_PROXY', 'trustProxy', false)) === 'true',

  minPasswordLength: Number(pick('MIN_PASSWORD_LENGTH', 'minPasswordLength', 8)),
  initialAdminPassword: String(pick('ADMIN_INITIAL_PASSWORD', 'initialAdminPassword', '111111')),
  maxPageSize: Number(pick('MAX_PAGE_SIZE', 'maxPageSize', 200)),

  httpsPort: Number(pick('HTTPS_PORT', 'httpsPort', 443)),
  domain: pick('DOMAIN', 'domain', ''),
  certPath: pick('CERT_PATH', 'certPath', ''),
  keyPath: pick('KEY_PATH', 'keyPath', ''),
  webrootPath: path.resolve(pick('WEBROOT_PATH', 'webrootPath', path.join(__dirname, '..', 'acme-webroot'))),

  // آدرس عمومی برنامه در استقرارهای پشت reverse proxy، مثل Render.
  // اگر تنظیم شود، همان Origin به‌صورت خودکار برای CSRF مجاز می‌شود.
  publicUrl: String(pick('PUBLIC_URL', 'publicUrl', '')).trim().replace(/\/$/, ''),

  // اجازه دسترسی از این آدرس‌ها برای دفاع CSRF.
  extraAllowedOrigins: (pick('EXTRA_ALLOWED_ORIGINS', 'extraAllowedOrigins', '') || '')
    .split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean),

  loginRateLimit: {
    maxAttempts: Number(pick('LOGIN_MAX_ATTEMPTS', 'loginMaxAttempts', 5)),
    windowMs: Number(pick('LOGIN_WINDOW_MS', 'loginWindowMs', 10 * 60 * 1000)),
    blockMs: Number(pick('LOGIN_BLOCK_MS', 'loginBlockMs', 15 * 60 * 1000))
  },

  backup: {
    enabled: String(pick('BACKUP_ENABLED', 'backupEnabled', true)) !== 'false',
    intervalHours: Number(pick('BACKUP_INTERVAL_HOURS', 'backupIntervalHours', 24)),
    keepCount: Number(pick('BACKUP_KEEP_COUNT', 'backupKeepCount', 30)),
    dir: path.resolve(pick('BACKUP_DIR', 'backupDir', path.join(__dirname, '..', 'backups'))),
    mirrorDir: (pick('BACKUP_MIRROR_DIR', 'backupMirrorDir', '') || '').trim()
  }
};

module.exports = config;
