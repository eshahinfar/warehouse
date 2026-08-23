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
  // حالت اجرا: 'lan'  → فقط HTTP روی شبکه داخلی (بدون گواهی لازم)
  //            'https' → HTTPS واقعی برای دسترسی اینترنتی با دامنه ثابت
  mode: pick('WAREHOUSE_MODE', 'mode', 'lan'),

  httpPort: Number(pick('PORT', 'httpPort', 8080)),

  // اگر سرور پشت یک reverse proxy (nginx و مانند آن) قرار دارد، این را
  // true کنید تا آی‌پی واقعی کاربر از هدر X-Forwarded-For خوانده شود.
  // در حالت پیش‌فرض عمداً false است: در استقرار مستقیم، اعتماد به این
  // هدر یعنی هر کسی می‌تواند با جعل آن محدودیت تلاش ورود را دور بزند.
  trustProxy: String(pick('TRUST_PROXY', 'trustProxy', false)) === 'true',

  // حداقل طول رمز عبور (نسخه قبلی ۴ کاراکتر را می‌پذیرفت)
  minPasswordLength: Number(pick('MIN_PASSWORD_LENGTH', 'minPasswordLength', 8)),

  // رمز اولیه‌ی حساب مدیر در اولین اجرا. تغییر آن در اولین ورود توسط
  // خودِ سرور اجباری است (نه فقط یک پیام در رابط کاربری).
  initialAdminPassword: String(pick('ADMIN_INITIAL_PASSWORD', 'initialAdminPassword', '111111')),

  // بیشترین تعداد ردیف در یک صفحه‌ی فهرست اسناد
  maxPageSize: Number(pick('MAX_PAGE_SIZE', 'maxPageSize', 200)),

  // فقط در حالت https استفاده می‌شود
  httpsPort: Number(pick('HTTPS_PORT', 'httpsPort', 443)),
  domain: pick('DOMAIN', 'domain', ''),
  certPath: pick('CERT_PATH', 'certPath', ''),      // مسیر fullchain.pem
  keyPath: pick('KEY_PATH', 'keyPath', ''),          // مسیر privkey.pem
  webrootPath: path.resolve(pick('WEBROOT_PATH', 'webrootPath', path.join(__dirname, '..', 'acme-webroot'))),

  // اجازه دسترسی از این آدرس‌ها (برای بررسی هدر Origin روی درخواست‌های
  // تغییردهنده — دفاع در برابر CSRF). به‌صورت خودکار بر اساس domain و
  // پورت‌های بالا هم تکمیل می‌شود.
  extraAllowedOrigins: (pick('EXTRA_ALLOWED_ORIGINS', 'extraAllowedOrigins', '') || '')
    .split(',').map(s => s.trim()).filter(Boolean),

  // محدودیت تلاش ورود (ضدBrute-Force)
  loginRateLimit: {
    maxAttempts: Number(pick('LOGIN_MAX_ATTEMPTS', 'loginMaxAttempts', 5)),
    windowMs: Number(pick('LOGIN_WINDOW_MS', 'loginWindowMs', 10 * 60 * 1000)), // 10 دقیقه
    blockMs: Number(pick('LOGIN_BLOCK_MS', 'loginBlockMs', 15 * 60 * 1000))     // 15 دقیقه قفل
  },

  // پشتیبان‌گیری خودکار زمان‌بندی‌شده از پایگاه‌داده
  backup: {
    enabled: String(pick('BACKUP_ENABLED', 'backupEnabled', true)) !== 'false',
    intervalHours: Number(pick('BACKUP_INTERVAL_HOURS', 'backupIntervalHours', 24)),
    keepCount: Number(pick('BACKUP_KEEP_COUNT', 'backupKeepCount', 30)),
    dir: path.resolve(pick('BACKUP_DIR', 'backupDir', path.join(__dirname, '..', 'backups'))),
    // مسیر دوم (اختیاری) برای نگه‌داشتن یک نسخه خارج از دیسک سرور —
    // مثلاً یک پوشه‌ی شبکه یا فلش دائمی. پشتیبانی که کنار خودِ داده روی
    // همان دیسک بماند، در خرابی دیسک هیچ کمکی نمی‌کند.
    mirrorDir: (pick('BACKUP_MIRROR_DIR', 'backupMirrorDir', '') || '').trim()
  }
};

module.exports = config;
