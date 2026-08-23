'use strict';
/* ======================================================================
   پشتیبان‌گیری خودکار زمان‌بندی‌شده از پایگاه‌داده

   از دستور استاندارد SQLite «VACUUM INTO» استفاده می‌شود که یک نسخه‌ی
   سازگار و کامل از پایگاه‌داده در لحظه‌ی درخواست می‌سازد (safe hot backup)
   بدون قفل کردن دیتابیس برای کاربران دیگر.

   دو اصلاح نسبت به نسخه قبلی:
     ۱. نام فایل تا دقت ثانیه است. قبلاً دقت دقیقه بود و اگر سرور دو بار
        در یک دقیقه راه‌اندازی می‌شد، VACUUM INTO با خطای «output file
        already exists» شکست می‌خورد.
     ۲. امکان نگه‌داشتن یک نسخه‌ی آینه‌ای در مسیر دوم (پوشه شبکه، فلش
        دائمی و...). پشتیبانی که کنار خود داده روی همان دیسک بماند، در
        خرابی دیسک هیچ کمکی نمی‌کند.
   ====================================================================== */

const fs = require('node:fs');
const path = require('node:path');
const { db } = require('./db');
const config = require('./config');

// وضعیت آخرین پشتیبان‌گیری — برای نمایش در تب حسابرسی. بدون این، خرابیِ
// خاموشِ مسیر آینه‌ای (مثلاً قطع شدن پوشه شبکه) فقط در لاگ ترمینال دیده
// می‌شد و کسی متوجه نمی‌شد ماه‌هاست پشتیبان بیرونی گرفته نمی‌شود.
const backupStatus = {
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastFile: null,
  lastError: null,
  mirrorConfigured: false,
  mirrorPath: '',
  mirrorOk: null,
  mirrorError: null,
  lastMirrorAt: null
};

function getBackupStatus() {
  return { ...backupStatus, dir: config.backup.dir, keepCount: config.backup.keepCount,
    intervalHours: config.backup.intervalHours, enabled: config.backup.enabled };
}

// بررسی می‌کند مسیر آینه‌ای واقعاً قابل نوشتن است. یک پوشه‌ی شبکه ممکن
// است هنگام راه‌اندازی سرور هنوز mount نشده باشد یا سرویس ویندوز به درایو
// نگاشته‌شده دسترسی نداشته باشد؛ بهتر است همان اول بفهمیم تا شش ماه بعد.
function verifyMirrorTarget() {
  backupStatus.mirrorConfigured = !!config.backup.mirrorDir;
  backupStatus.mirrorPath = config.backup.mirrorDir || '';
  if (!config.backup.mirrorDir) {
    backupStatus.mirrorOk = null;
    return { ok: false, configured: false };
  }
  try {
    fs.mkdirSync(config.backup.mirrorDir, { recursive: true });
    const probe = path.join(config.backup.mirrorDir, '.write-test');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    backupStatus.mirrorOk = true;
    backupStatus.mirrorError = null;
    return { ok: true, configured: true };
  } catch (e) {
    backupStatus.mirrorOk = false;
    backupStatus.mirrorError = e.message;
    return { ok: false, configured: true, error: e.message };
  }
}

function formatTimestampForFilename(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

function uniqueDestination(dir, baseName) {
  let candidate = path.join(dir, `${baseName}.db`);
  let counter = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${baseName}_${counter}.db`);
    counter++;
  }
  return candidate;
}

function performBackup() {
  backupStatus.lastAttemptAt = new Date().toISOString();
  try {
    if (!fs.existsSync(config.backup.dir)) {
      fs.mkdirSync(config.backup.dir, { recursive: true });
    }
    const baseName = `warehouse-backup_${formatTimestampForFilename(new Date())}`;
    const destPath = uniqueDestination(config.backup.dir, baseName);

    db.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);
    backupStatus.lastSuccessAt = new Date().toISOString();
    backupStatus.lastFile = path.basename(destPath);
    backupStatus.lastError = null;
    console.log(`[پشتیبان‌گیری] نسخه پشتیبان جدید ذخیره شد: ${path.basename(destPath)}`);

    let mirrored = false;
    if (config.backup.mirrorDir) {
      try {
        if (!fs.existsSync(config.backup.mirrorDir)) {
          fs.mkdirSync(config.backup.mirrorDir, { recursive: true });
        }
        const mirrorPath = uniqueDestination(config.backup.mirrorDir, baseName);
        fs.copyFileSync(destPath, mirrorPath);
        mirrored = true;
        backupStatus.mirrorOk = true;
        backupStatus.mirrorError = null;
        backupStatus.lastMirrorAt = new Date().toISOString();
        console.log(`[پشتیبان‌گیری] نسخه آینه‌ای ذخیره شد: ${mirrorPath}`);
      } catch (e) {
        backupStatus.mirrorOk = false;
        backupStatus.mirrorError = e.message;
        console.error('[پشتیبان‌گیری] خطا در ساخت نسخه آینه‌ای (مسیر دوم در دسترس نیست):', e.message);
      }
    }

    cleanupOldBackups(config.backup.dir);
    if (config.backup.mirrorDir) cleanupOldBackups(config.backup.mirrorDir);

    return { ok: true, file: path.basename(destPath), mirrored };
  } catch (e) {
    backupStatus.lastError = e.message;
    console.error('[پشتیبان‌گیری] خطا در ساخت نسخه پشتیبان:', e.message);
    return { ok: false, error: e.message };
  }
}

function cleanupOldBackups(dir) {
  try {
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir)
      .filter(f => f.startsWith('warehouse-backup_') && f.endsWith('.db'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);

    files.slice(config.backup.keepCount).forEach(f => {
      fs.unlinkSync(path.join(dir, f.name));
      console.log(`[پشتیبان‌گیری] نسخه قدیمی حذف شد: ${f.name}`);
    });
  } catch (e) {
    console.error('[پشتیبان‌گیری] خطا در پاک‌سازی نسخه‌های قدیمی:', e.message);
  }
}

function startScheduledBackups() {
  if (!config.backup.enabled) {
    console.log('[پشتیبان‌گیری] پشتیبان‌گیری خودکار غیرفعال است (backupEnabled=false)');
    return;
  }
  const intervalMs = config.backup.intervalHours * 60 * 60 * 1000;
  console.log(`[پشتیبان‌گیری] پشتیبان‌گیری خودکار هر ${config.backup.intervalHours} ساعت فعال شد (مسیر: ${config.backup.dir})`);
  const mirror = verifyMirrorTarget();
  if (mirror.configured && mirror.ok) {
    console.log(`[پشتیبان‌گیری] مسیر آینه‌ای بررسی و تأیید شد: ${config.backup.mirrorDir}`);
  } else if (mirror.configured) {
    console.error('╔══════════════════════════════════════════════════════════╗');
    console.error(` مسیر آینه‌ای پشتیبان قابل نوشتن نیست: ${config.backup.mirrorDir}`);
    console.error(` علت: ${mirror.error}`);
    console.error(' پشتیبان‌گیری محلی ادامه دارد، ولی نسخه‌ی بیرونی ساخته نمی‌شود.');
    console.error(' اگر پوشه شبکه است: در ویندوز، سرویس‌ها به درایوهای نگاشته‌شده');
    console.error(' (:Z ,:Y) دسترسی ندارند؛ مسیر کامل UNC بنویسید مثل');
    console.error(' \\\\server-backup\\warehouse — و سرویس را با کاربری اجرا کنید');
    console.error(' که به آن اشتراک دسترسی نوشتن دارد.');
    console.error('╚══════════════════════════════════════════════════════════╝');
  } else {
    console.log('[پشتیبان‌گیری] هشدار: نسخه پشتیبان فقط روی همان دیسک سرور است.');
    console.log('   خرابی دیسک یعنی از دست رفتن هم‌زمان داده و پشتیبان.');
    console.log('   یک مسیر دوم (پوشه شبکه/هارد اکسترنال) در config.json → backupMirrorDir تنظیم کنید.');
  }

  performBackup();
  setInterval(performBackup, intervalMs);
}

module.exports = { startScheduledBackups, performBackup, getBackupStatus, verifyMirrorTarget };
