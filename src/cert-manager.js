'use strict';
/* ======================================================================
   مدیریت گواهی TLS/SSL

   گواهی از فایل‌های استاندارد Let's Encrypt (fullchain.pem + privkey.pem)
   خوانده می‌شود. این ماژول هیچ گواهی صادر نمی‌کند — صدور گواهی با ابزار
   استاندارد و رایگان certbot انجام می‌شود (نه یک بسته npm، بلکه یک ابزار
   خط‌فرمان مستقل؛ به همین دلیل وابستگی npm اضافه نمی‌شود).

   نکته مهم: certbot هر ۶۰ روز گواهی را به‌صورت خودکار تمدید می‌کند. برای
   این‌که سرور مجبور به ری‌استارت نشود، فایل گواهی هر ساعت بررسی می‌شود و
   در صورت تغییر، با `server.setSecureContext()` بدون قطعی سرویس جایگزین
   می‌شود.
   ====================================================================== */

const fs = require('node:fs');

function loadCertPair(certPath, keyPath) {
  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    throw new Error(`فایل گواهی یافت نشد. مسیرهای بررسی‌شده:\n  ${certPath}\n  ${keyPath}`);
  }
  return {
    cert: fs.readFileSync(certPath, 'utf8'),
    key: fs.readFileSync(keyPath, 'utf8')
  };
}

// هر ساعت بررسی می‌کند که آیا فایل گواهی از آخرین بارگذاری، تازه‌تر شده
// (یعنی certbot آن را تمدید کرده) و در این صورت بدون قطع اتصالات فعال،
// گواهی جدید را جایگزین می‌کند.
function watchAndReloadCert(httpsServer, certPath, keyPath, intervalMs = 60 * 60 * 1000) {
  let lastMtime = fs.statSync(certPath).mtimeMs;

  setInterval(() => {
    try {
      const stat = fs.statSync(certPath);
      if (stat.mtimeMs > lastMtime) {
        const { cert, key } = loadCertPair(certPath, keyPath);
        httpsServer.setSecureContext({ cert, key });
        lastMtime = stat.mtimeMs;
        console.log('[TLS] گواهی جدید بارگذاری شد (تمدید خودکار توسط certbot تشخیص داده شد).');
      }
    } catch (e) {
      console.error('[TLS] خطا در بررسی/بارگذاری گواهی جدید:', e.message);
    }
  }, intervalMs);
}

module.exports = { loadCertPair, watchAndReloadCert };
