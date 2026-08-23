'use strict';
/* ======================================================================
   منطق کسب‌وکار مشترک، سمت سرور — این‌جا «منبع حقیقت» است.

   سه تغییر بنیادی نسبت به نسخه قبلی:

   ۱. شماره اسناد دیگر هرگز بازنویسی نمی‌شود. در نسخه قبلی بعد از حذف یک
      سند، همه‌ی اسناد هم‌نوع دوباره شماره‌گذاری می‌شدند؛ نتیجه این بود که
      لاگ حسابرسی به شماره‌ای اشاره می‌کرد که حالا متعلق به سند دیگری بود
      و رسیدهای چاپ‌شده در واحدها با سیستم نمی‌خواندند. حالا حذف جای خود
      را به «ابطال» داده است: سند سر جایش می‌ماند، برچسب «باطل» می‌گیرد و
      از محاسبات موجودی خارج می‌شود. پس شماره‌ها هم پیوسته می‌مانند و هم
      تغییرناپذیر.

   ۲. موجودی از یک مسیر واحد و کنترل‌شده تغییر می‌کند (applyStockDelta)
      که هرگز اجازه‌ی منفی شدن نمی‌دهد. نسخه قبلی در حذف سند از
      Math.max(0, ...) استفاده می‌کرد و موجودی بی‌صدا با دفتر اسناد واگرا
      می‌شد.

   ۳. مفهوم «موجودی قابل تخصیص» اضافه شده: کالایی که امانت داده شده یا در
      تعمیرگاه است، فیزیکاً در انبار نیست و نباید در دسترس شمرده شود.
   ====================================================================== */

const { db, inTransaction } = require('./db');

const DOC_PREFIXES = {
  in: 'IN', out: 'OUT', ret: 'RET', req: 'REQ',
  custIssue: 'CST', custReturn: 'CSR', repIn: 'REP', repOut: 'REPR'
};

class BusinessError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'BusinessError';
    this.status = status;
  }
}

// ----------------------------------------------------------------------
// شماره‌گذاری اسناد — شمارنده فقط به جلو می‌رود و هرگز عقب برنمی‌گردد
// ----------------------------------------------------------------------
function nextDocNumber(kind) {
  const row = db.prepare('SELECT value FROM counters WHERE kind = ?').get(kind);
  const next = (row ? row.value : 0) + 1;
  db.prepare('UPDATE counters SET value = ? WHERE kind = ?').run(next, kind);
  return `${DOC_PREFIXES[kind]}-${String(next).padStart(6, '0')}`;
}

// ----------------------------------------------------------------------
// موجودی
// ----------------------------------------------------------------------

// تنها راه مجاز تغییر موجودی. در صورت منفی شدن، خطا می‌دهد تا عملیات
// (که همیشه داخل یک تراکنش است) کامل برگردانده شود.
function applyStockDelta(productId, delta, contextLabel = 'این عملیات') {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!product) throw new BusinessError('کالا یافت نشد', 404);

  const newStock = product.stock + delta;
  if (newStock < 0) {
    throw new BusinessError(
      `${contextLabel} باعث منفی شدن موجودی «${product.name}» می‌شود ` +
      `(موجودی فعلی: ${product.stock} ${product.unit}). عملیات انجام نشد.`
    );
  }
  db.prepare('UPDATE products SET stock = ?, updated_at = ? WHERE id = ?')
    .run(newStock, new Date().toISOString(), productId);
  return newStock;
}

// موجودی محاسبه‌شده از روی دفتر اسناد معتبر (اسناد باطل شمرده نمی‌شوند)
function stockFromLedger(productId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN type = 'خروج' THEN -quantity ELSE quantity END), 0) AS total
    FROM transactions WHERE product_id = ? AND status = 'معتبر'
  `).get(productId);
  return row.total;
}

function custodyOutstandingQty(productId) {
  return db.prepare(
    "SELECT COALESCE(SUM(quantity),0) AS total FROM custody_records WHERE product_id = ? AND status = 'باز'"
  ).get(productId).total;
}

function repairOutstandingQty(productId) {
  return db.prepare(
    "SELECT COALESCE(SUM(quantity),0) AS total FROM repair_records WHERE product_id = ? AND status = 'در حال تعمیر'"
  ).get(productId).total;
}

// تصویر کامل وضعیت یک کالا: چه چیزی روی کاغذ هست و چه چیزی واقعاً در
// قفسه در دسترس است.
function stockSnapshot(product) {
  const inCustody = custodyOutstandingQty(product.id);
  const inRepair = repairOutstandingQty(product.id);
  return {
    onHand: product.stock,                                  // موجودی دفتری
    inCustody,                                              // نزد کاربران (امانت)
    inRepair,                                               // در تعمیرگاه
    available: product.stock - inCustody - inRepair         // قابل تخصیص
  };
}

// وضعیت کمبود بر اساس «موجودی قابل تخصیص» سنجیده می‌شود، نه موجودی دفتری:
// ده آچاری که همه‌شان دست کاربران است، در عمل صفر آچار در دسترس است.
function getStockStatus(product) {
  const { available } = stockSnapshot(product);
  const min = product.min_stock;
  if (min <= 0) return available <= 0 ? 'critical' : 'ok';
  if (available < min) return 'critical';
  if (available <= min * 1.5) return 'warn';
  return 'ok';
}

// ----------------------------------------------------------------------
// تطبیق موجودی — ابزار مدیر برای یافتن و اصلاح واگرایی احتمالی بین
// products.stock و جمع اسناد (مثلاً ناشی از داده‌های نسخه‌های قبلی)
// ----------------------------------------------------------------------
function stockDiscrepancies() {
  const products = db.prepare('SELECT * FROM products ORDER BY code ASC').all();
  return products
    .map(p => ({
      id: p.id, code: p.code, name: p.name, unit: p.unit,
      storedStock: p.stock, ledgerStock: stockFromLedger(p.id)
    }))
    .filter(r => r.storedStock !== r.ledgerStock);
}

function repairStockFromLedger(userId) {
  return inTransaction(() => {
    const diffs = stockDiscrepancies();
    const now = new Date().toISOString();
    diffs.forEach(d => {
      db.prepare('UPDATE products SET stock = ?, updated_at = ? WHERE id = ?').run(d.ledgerStock, now, d.id);
      addAuditEntry({
        action: 'اصلاح موجودی (تطبیق با دفتر اسناد)',
        docNumber: d.code,
        changeDescription: `موجودی «${d.name}» از ${d.storedStock} به ${d.ledgerStock} ${d.unit} اصلاح شد (مقدار محاسبه‌شده از مجموع اسناد معتبر).`,
        reason: 'اجرای تطبیق موجودی توسط مدیر سیستم',
        userId
      });
    });
    return diffs;
  });
}

// ----------------------------------------------------------------------
function addAuditEntry({ action, docNumber, changeDescription, reason, userId }) {
  db.prepare(`INSERT INTO audit_log (timestamp, action, doc_number, change_description, reason, performed_by_user_id)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(new Date().toISOString(), action, docNumber || null, changeDescription || null, reason || null, userId || null);
}

function isoToday() {
  return new Date().toISOString().split('T')[0];
}

module.exports = {
  BusinessError,
  nextDocNumber,
  applyStockDelta,
  stockFromLedger,
  custodyOutstandingQty,
  repairOutstandingQty,
  stockSnapshot,
  getStockStatus,
  stockDiscrepancies,
  repairStockFromLedger,
  addAuditEntry,
  isoToday,
  DOC_PREFIXES
};
