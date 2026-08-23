'use strict';

const { db, inTransaction } = require('../db');
const {
  nextDocNumber, getStockStatus, stockSnapshot, addAuditEntry, isoToday, BusinessError
} = require('../business');
const { vId, vInt, vText, vOptionalText, vOptionalDate, vEnum, vReason } = require('../validators');

const routes = [];

const PRODUCT_TYPES = ['مصرفی', 'قابل‌برگشت'];

function serializeProduct(row) {
  const snap = stockSnapshot(row);
  return {
    id: row.id, code: row.code, name: row.name, type: row.type, unit: row.unit,
    stock: row.stock, minStock: row.min_stock, usageLocation: row.usage_location,
    shelf: row.shelf, description: row.description,
    // تفکیک موجودی دفتری از موجودی واقعاً در دسترس
    inCustody: snap.inCustody, inRepair: snap.inRepair, available: snap.available,
    archived: row.active === 0,
    status: getStockStatus(row)
  };
}

routes.push({
  method: 'GET', path: '/api/products', permission: 'products.view',
  handler: (ctx) => {
    const includeArchived = (ctx.query || {}).includeArchived === '1';
    const rows = includeArchived
      ? db.prepare('SELECT * FROM products ORDER BY id DESC').all()
      : db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY id DESC').all();
    return { status: 200, body: { products: rows.map(serializeProduct) } };
  }
});

routes.push({
  method: 'GET', path: '/api/products/usage-locations', permission: 'products.view',
  handler: () => {
    const rows = db.prepare("SELECT DISTINCT usage_location FROM products WHERE usage_location IS NOT NULL AND usage_location != ''").all();
    return { status: 200, body: { usageLocations: rows.map(r => r.usage_location) } };
  }
});

routes.push({
  method: 'POST', path: '/api/products', permission: 'products.edit',
  handler: (ctx) => {
    const b = ctx.body || {};
    const code = vText(b.code, 'کد کالا', { maxLen: 60 });
    const name = vText(b.name, 'نام کالا', { maxLen: 200 });
    const unit = vText(b.unit, 'واحد اندازه‌گیری', { maxLen: 40 });
    const minStock = vInt(b.minStock ?? 0, 'حداقل موجودی', { min: 0 });
    const openingStock = vInt(b.openingStock ?? 0, 'موجودی اولیه', { min: 0 });
    // تاریخ سند موجودی اولیه. اگر انبارگردانی مربوط به هفته‌ی گذشته است،
    // سند باید همان تاریخ را بخورد نه تاریخ امروز؛ وگرنه در کاردکس، اسنادِ
    // پیش از آن تاریخ روی مانده‌ی منفی می‌نشینند و گزارش گیج‌کننده می‌شود.
    const openingStockDate = vOptionalDate(b.openingStockDate, 'تاریخ موجودی اولیه') || isoToday();
    if (openingStock > 0 && openingStockDate > isoToday()) {
      throw new BusinessError('تاریخ موجودی اولیه نمی‌تواند در آینده باشد');
    }
    const productType = vEnum(b.type || 'مصرفی', 'نوع کالا', PRODUCT_TYPES);
    const usageLocation = vOptionalText(b.usageLocation, 'محل مصرف', { maxLen: 200 });
    const shelf = vOptionalText(b.shelf, 'قفسه', { maxLen: 100 });
    const description = vOptionalText(b.description, 'توضیحات');

    return inTransaction(() => {
      const existing = db.prepare('SELECT id, active FROM products WHERE code = ?').get(code);
      if (existing) {
        throw new BusinessError(existing.active === 0
          ? 'کالایی با این کد در بایگانی وجود دارد؛ آن را از بایگانی خارج کنید یا کد دیگری انتخاب کنید'
          : 'این کد کالا قبلاً ثبت شده است', 409);
      }

      const now = new Date().toISOString();
      const result = db.prepare(`INSERT INTO products (code, name, type, unit, stock, min_stock, usage_location, shelf, description, created_at, updated_at, active)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`)
        .run(code, name, productType, unit, openingStock, minStock, usageLocation, shelf, description, now, now);

      const productId = Number(result.lastInsertRowid);

      if (openingStock > 0) {
        const docNumber = nextDocNumber('in');
        db.prepare(`INSERT INTO transactions (doc_number, product_id, type, quantity, date, source, description, created_by_user_id, created_at)
                    VALUES (?, ?, 'ورود', ?, ?, '-', 'موجودی اولیه هنگام تعریف کالا', ?, ?)`)
          .run(docNumber, productId, openingStock, openingStockDate, ctx.user.id, now);
      }

      const row = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
      return { status: 201, body: { product: serializeProduct(row) } };
    });
  }
});

routes.push({
  method: 'PUT', path: '/api/products/:id', permission: 'products.edit',
  handler: (ctx) => {
    const id = vId(ctx.params.id, 'شناسه کالا');
    const b = ctx.body || {};
    const code = vText(b.code, 'کد کالا', { maxLen: 60 });
    const name = vText(b.name, 'نام کالا', { maxLen: 200 });
    const unit = vText(b.unit, 'واحد اندازه‌گیری', { maxLen: 40 });
    const minStock = vInt(b.minStock ?? 0, 'حداقل موجودی', { min: 0 });
    const productType = vEnum(b.type || 'مصرفی', 'نوع کالا', PRODUCT_TYPES);
    const usageLocation = vOptionalText(b.usageLocation, 'محل مصرف', { maxLen: 200 });
    const shelf = vOptionalText(b.shelf, 'قفسه', { maxLen: 100 });
    const description = vOptionalText(b.description, 'توضیحات');

    return inTransaction(() => {
      const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
      if (!existing) throw new BusinessError('کالا یافت نشد', 404);

      const duplicate = db.prepare('SELECT id FROM products WHERE code = ? AND id != ?').get(code, id);
      if (duplicate) throw new BusinessError('این کد کالا قبلاً برای کالای دیگری ثبت شده است', 409);

      // تغییر نوع کالا وقتی امانتی باز دارد، حسابداری امانت را می‌شکند
      if (existing.type === 'قابل‌برگشت' && productType !== 'قابل‌برگشت') {
        const open = db.prepare("SELECT COUNT(*) AS c FROM custody_records WHERE product_id = ? AND status = 'باز'").get(id).c;
        if (open > 0) throw new BusinessError(`این ابزار ${open} امانت باز دارد؛ تا تسویه‌ی آن‌ها نوع کالا قابل تغییر نیست`);
      }

      db.prepare(`UPDATE products SET code = ?, name = ?, type = ?, unit = ?, min_stock = ?, usage_location = ?, shelf = ?, description = ?, updated_at = ?
                  WHERE id = ?`)
        .run(code, name, productType, unit, minStock, usageLocation, shelf, description, new Date().toISOString(), id);

      const row = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
      return { status: 200, body: { product: serializeProduct(row) } };
    });
  }
});

// ======================================================================
// حذف/بایگانی کالا — فقط مدیر سیستم، با ثبت دلیل.
//
// نسخه قبلی کالا را همراه با تمام اسناد تراکنش، درخواست، امانت و تعمیر
// آن پاک می‌کرد؛ یعنی یک کلیک، تاریخچه‌ی چند ساله‌ی انبار را از بین
// می‌برد و گزارش‌های سال‌های قبل را تغییر می‌داد. حالا:
//   - کالای بدون هیچ سندی: واقعاً حذف می‌شود (یک اشتباه تایپی هنگام
//     تعریف کالا، چیزی برای نگه‌داشتن ندارد)
//   - کالای دارای سند: بایگانی می‌شود؛ از فهرست‌ها و انتخاب‌گرها خارج
//     می‌شود ولی اسناد و کاردکس آن دست‌نخورده باقی می‌ماند
// ======================================================================
routes.push({
  method: 'DELETE', path: '/api/products/:id', permission: 'products.delete',
  handler: (ctx) => {
    const id = vId(ctx.params.id, 'شناسه کالا');
    const reason = vReason((ctx.body || {}).reason);

    return inTransaction(() => {
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
      if (!product) throw new BusinessError('کالا یافت نشد', 404);

      const txCount = db.prepare('SELECT COUNT(*) AS c FROM transactions WHERE product_id = ?').get(id).c;
      const reqCount = db.prepare('SELECT COUNT(*) AS c FROM requests WHERE product_id = ?').get(id).c;
      const custCount = db.prepare('SELECT COUNT(*) AS c FROM custody_records WHERE product_id = ?').get(id).c;
      const repCount = db.prepare('SELECT COUNT(*) AS c FROM repair_records WHERE product_id = ?').get(id).c;
      const totalDocs = txCount + reqCount + custCount + repCount;

      const openCustody = db.prepare("SELECT COUNT(*) AS c FROM custody_records WHERE product_id = ? AND status = 'باز'").get(id).c;
      if (openCustody > 0) {
        throw new BusinessError(`این کالا ${openCustody} امانت تسویه‌نشده دارد؛ ابتدا امانت‌ها را تعیین‌تکلیف کنید`);
      }

      if (totalDocs === 0) {
        db.prepare('DELETE FROM products WHERE id = ?').run(id);
        addAuditEntry({
          action: 'حذف کالا',
          docNumber: product.code,
          changeDescription: `کالای «${product.name}» (${product.code}) که هیچ سندی نداشت، حذف شد.`,
          reason, userId: ctx.user.id
        });
        return { status: 200, body: { ok: true, mode: 'deleted' } };
      }

      db.prepare('UPDATE products SET active = 0, archived_at = ?, updated_at = ? WHERE id = ?')
        .run(new Date().toISOString(), new Date().toISOString(), id);

      addAuditEntry({
        action: 'بایگانی کالا',
        docNumber: product.code,
        changeDescription: `کالای «${product.name}» (${product.code}) بایگانی شد. ${totalDocs} سند مرتبط (${txCount} تراکنش، ${reqCount} درخواست، ${custCount} امانت، ${repCount} تعمیر) برای حفظ سوابق و گزارش‌های گذشته دست‌نخورده باقی ماند.`,
        reason, userId: ctx.user.id
      });

      return {
        status: 200,
        body: {
          ok: true, mode: 'archived', relatedDocuments: totalDocs,
          message: `کالا بایگانی شد. ${totalDocs} سند مرتبط برای حفظ سوابق حذف نشد.`
        }
      };
    });
  }
});

// خروج از بایگانی
routes.push({
  method: 'POST', path: '/api/products/:id/restore', permission: 'products.delete',
  handler: (ctx) => {
    const id = vId(ctx.params.id, 'شناسه کالا');
    return inTransaction(() => {
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
      if (!product) throw new BusinessError('کالا یافت نشد', 404);
      if (product.active === 1) throw new BusinessError('این کالا در بایگانی نیست');

      db.prepare('UPDATE products SET active = 1, archived_at = NULL, updated_at = ? WHERE id = ?')
        .run(new Date().toISOString(), id);
      addAuditEntry({
        action: 'خروج کالا از بایگانی',
        docNumber: product.code,
        changeDescription: `کالای «${product.name}» (${product.code}) دوباره فعال شد.`,
        reason: 'درخواست مدیر سیستم', userId: ctx.user.id
      });
      return { status: 200, body: { ok: true } };
    });
  }
});

module.exports = routes;
