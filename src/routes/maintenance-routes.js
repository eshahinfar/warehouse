'use strict';
/* ======================================================================
   ابزارهای نگه‌داری — فقط مدیر سیستم

   مهم‌ترینش تطبیق موجودی است: مقایسه‌ی products.stock با مجموع اسناد
   معتبر. در حالت سالم باید همیشه صفر اختلاف باشد؛ اگر پایگاه‌داده از
   نسخه‌ی قبلی (که موجودی را با Math.max(0,...) قیچی می‌کرد) ارتقا یافته
   باشد، این‌جا اختلاف‌ها دیده و اصلاح می‌شوند.
   ====================================================================== */

const { stockDiscrepancies, repairStockFromLedger } = require('../business');
const { performBackup, getBackupStatus, verifyMirrorTarget } = require('../backup');

const routes = [];

routes.push({
  method: 'GET', path: '/api/maintenance/stock-check', permission: 'maintenance.manage',
  handler: () => {
    const diffs = stockDiscrepancies();
    return {
      status: 200,
      body: {
        discrepancies: diffs,
        ok: diffs.length === 0,
        message: diffs.length === 0
          ? 'موجودی همه‌ی کالاها با دفتر اسناد مطابقت دارد.'
          : `${diffs.length} کالا با دفتر اسناد اختلاف دارد.`
      }
    };
  }
});

routes.push({
  method: 'POST', path: '/api/maintenance/stock-repair', permission: 'maintenance.manage',
  handler: (ctx) => {
    const fixed = repairStockFromLedger(ctx.user.id);
    return {
      status: 200,
      body: {
        fixedCount: fixed.length, fixed,
        message: fixed.length === 0
          ? 'اختلافی برای اصلاح یافت نشد.'
          : `موجودی ${fixed.length} کالا با دفتر اسناد هم‌تراز شد (شرح کامل در لاگ حسابرسی ثبت شد).`
      }
    };
  }
});

// وضعیت پشتیبان‌گیری، از جمله سلامت مسیر آینه‌ای. مسیر دوم هر بار
// بررسی تازه می‌شود تا اگر پوشه‌ی شبکه قطع شده باشد، مدیر همان‌جا ببیند.
routes.push({
  method: 'GET', path: '/api/maintenance/backup-status', permission: 'maintenance.manage',
  handler: () => {
    verifyMirrorTarget();
    return { status: 200, body: getBackupStatus() };
  }
});

routes.push({
  method: 'POST', path: '/api/maintenance/backup-now', permission: 'maintenance.manage',
  handler: () => {
    const result = performBackup();
    return result.ok
      ? { status: 200, body: { ok: true, file: result.file, mirrored: result.mirrored } }
      : { status: 500, body: { error: `ساخت نسخه پشتیبان ناموفق بود: ${result.error}` } };
  }
});

module.exports = routes;
