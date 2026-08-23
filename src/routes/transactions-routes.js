'use strict';

const { db, inTransaction } = require('../db');
const {
  nextDocNumber, applyStockDelta, addAuditEntry, BusinessError
} = require('../business');
const { vId, vInt, vDate, vText, vOptionalText, vReason } = require('../validators');
const config = require('../config');

const routes = [];

function serializeTransaction(row) {
  return {
    id: row.id, docNumber: row.doc_number, productId: row.product_id, type: row.type,
    quantity: row.quantity, date: row.date, source: row.source, poNumber: row.po_number,
    requestingUnit: row.requesting_unit, receiver: row.receiver, reason: row.reason,
    linkedRequestId: row.linked_request_id, returnedBy: row.returned_by, condition: row.condition_text,
    sourceDocId: row.source_doc_id, sourceDocNumber: row.source_doc_number, description: row.description,
    status: row.status || 'معتبر', voidedAt: row.voided_at, voidReason: row.void_reason,
    createdAt: row.created_at
  };
}

function getProductOrThrow(productId) {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!product) throw new BusinessError('کالای انتخاب‌شده معتبر نیست', 404);
  if (product.active === 0) throw new BusinessError(`کالای «${product.name}» بایگانی شده است و سند جدیدی برای آن ثبت نمی‌شود`);
  return product;
}

// ======================================================================
// رسید ورود
// ======================================================================
routes.push({
  method: 'POST', path: '/api/stock-in', permission: 'stock.in',
  handler: (ctx) => {
    const b = ctx.body || {};
    const productId = vId(b.productId, 'انتخاب کالا');
    const qty = vInt(b.quantity, 'تعداد');
    const date = vDate(b.date, 'تاریخ');
    const source = vOptionalText(b.source, 'تأمین‌کننده/منبع', { maxLen: 200 });
    const poNumber = vOptionalText(b.poNumber, 'شماره سفارش خرید', { maxLen: 100 });
    const description = vOptionalText(b.description, 'توضیحات');
    const linkedRequestId = b.linkedRequestId ? vId(b.linkedRequestId, 'درخواست مرتبط') : null;

    return inTransaction(() => {
      const product = getProductOrThrow(productId);
      const now = new Date().toISOString();
      const docNumber = nextDocNumber('in');

      applyStockDelta(product.id, qty, 'ثبت رسید ورود');
      const result = db.prepare(`INSERT INTO transactions (doc_number, product_id, type, quantity, date, source, po_number, linked_request_id, description, created_by_user_id, created_at)
                  VALUES (?, ?, 'ورود', ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(docNumber, product.id, qty, date, source, poNumber, linkedRequestId, description, ctx.user.id, now);

      if (linkedRequestId) {
        db.prepare("UPDATE requests SET status = 'تأمین شده' WHERE id = ? AND status = 'در انتظار'").run(linkedRequestId);
      }

      const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(Number(result.lastInsertRowid));
      return { status: 201, body: { transaction: serializeTransaction(tx) } };
    });
  }
});

// ======================================================================
// حواله خروج
// ======================================================================
routes.push({
  method: 'POST', path: '/api/stock-out', permission: 'stock.out',
  handler: (ctx) => {
    const b = ctx.body || {};
    const productId = vId(b.productId, 'انتخاب کالا');
    const qty = vInt(b.quantity, 'تعداد');
    const date = vDate(b.date, 'تاریخ');
    const receiver = vText(b.receiver, 'نام تحویل‌گیرنده', { maxLen: 200 });
    const requestingUnit = vText(b.requestingUnit, 'واحد درخواست‌کننده', { maxLen: 200 });
    const reason = vOptionalText(b.reason, 'دلیل خروج', { maxLen: 200 });
    const description = vOptionalText(b.description, 'توضیحات');
    const force = !!b.force;

    return inTransaction(() => {
      const product = getProductOrThrow(productId);

      if (product.stock < qty) {
        throw new BusinessError(`موجودی کافی نیست. موجودی فعلی «${product.name}»: ${product.stock} ${product.unit}`);
      }
      if (product.type === 'قابل‌برگشت' && !force) {
        return {
          status: 409,
          body: {
            error: 'این کالا از نوع قابل‌برگشت (ابزار/تجهیز امانی) است. برای پیگیری بازگشت، از «امانت ابزار» استفاده کنید.',
            requiresForce: true
          }
        };
      }

      const now = new Date().toISOString();
      const docNumber = nextDocNumber('out');

      applyStockDelta(product.id, -qty, 'ثبت حواله خروج');
      const result = db.prepare(`INSERT INTO transactions (doc_number, product_id, type, quantity, date, requesting_unit, receiver, reason, description, created_by_user_id, created_at)
                  VALUES (?, ?, 'خروج', ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(docNumber, product.id, qty, date, requestingUnit, receiver, reason, description, ctx.user.id, now);

      const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(Number(result.lastInsertRowid));
      return { status: 201, body: { transaction: serializeTransaction(tx) } };
    });
  }
});

// ======================================================================
// مرجوعی
// ======================================================================
routes.push({
  method: 'POST', path: '/api/returns', permission: 'returns.create',
  handler: (ctx) => {
    const b = ctx.body || {};
    const productId = vId(b.productId, 'انتخاب کالا');
    const qty = vInt(b.quantity, 'تعداد');
    const date = vDate(b.date, 'تاریخ');
    const returnedBy = vText(b.returnedBy, 'نام تحویل‌دهنده', { maxLen: 200 });
    const condition = vOptionalText(b.condition, 'وضعیت کالا', { maxLen: 200 });
    const reason = vOptionalText(b.reason, 'دلیل مرجوعی', { maxLen: 200 });
    const description = vOptionalText(b.description, 'توضیحات');
    const sourceDocId = b.sourceDocId ? vId(b.sourceDocId, 'سند مرجع') : null;

    return inTransaction(() => {
      const product = getProductOrThrow(productId);

      let sourceDocNumber = null;
      if (sourceDocId) {
        const sourceDoc = db.prepare('SELECT * FROM transactions WHERE id = ?').get(sourceDocId);
        if (sourceDoc) sourceDocNumber = sourceDoc.doc_number;
      }

      const now = new Date().toISOString();
      const docNumber = nextDocNumber('ret');

      applyStockDelta(product.id, qty, 'ثبت مرجوعی');
      const result = db.prepare(`INSERT INTO transactions (doc_number, product_id, type, quantity, date, returned_by, condition_text, reason, source_doc_id, source_doc_number, description, created_by_user_id, created_at)
                  VALUES (?, ?, 'مرجوعی', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(docNumber, product.id, qty, date, returnedBy, condition, reason,
          sourceDocId, sourceDocNumber, description, ctx.user.id, now);

      const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(Number(result.lastInsertRowid));
      return { status: 201, body: { transaction: serializeTransaction(tx) } };
    });
  }
});

// ======================================================================
// فهرست اسناد — با صفحه‌بندی و جست‌وجوی سمت پایگاه‌داده
// نسخه قبلی همه‌ی ردیف‌ها را می‌خواند و در جاوااسکریپت فیلتر می‌کرد؛ با
// چند ده هزار سند این کار سرور و مرورگر را کند می‌کرد.
// ======================================================================
routes.push({
  method: 'GET', path: '/api/transactions', permission: 'reports.view',
  handler: (ctx) => {
    const q = ctx.query || {};
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), config.maxPageSize);
    const offset = Math.max(Number(q.offset) || 0, 0);
    const includeVoided = q.includeVoided === '1' || q.includeVoided === 'true';

    let where = 'WHERE 1=1';
    const args = [];
    if (!includeVoided) { where += " AND t.status = 'معتبر'"; }
    if (q.type) { where += ' AND t.type = ?'; args.push(String(q.type)); }
    if (q.productId) { where += ' AND t.product_id = ?'; args.push(vId(q.productId, 'شناسه کالا')); }
    if (q.startDate) { where += ' AND t.date >= ?'; args.push(vDate(q.startDate, 'تاریخ شروع')); }
    if (q.endDate) { where += ' AND t.date <= ?'; args.push(vDate(q.endDate, 'تاریخ پایان')); }

    if (q.search) {
      const term = `%${String(q.search).trim().toLowerCase()}%`;
      where += ` AND (LOWER(t.doc_number) LIKE ? OR LOWER(p.name) LIKE ? OR LOWER(p.code) LIKE ?
                  OR LOWER(COALESCE(t.source,'')) LIKE ? OR LOWER(COALESCE(t.receiver,'')) LIKE ?
                  OR LOWER(COALESCE(t.returned_by,'')) LIKE ?)`;
      for (let i = 0; i < 6; i++) args.push(term);
    }

    const total = db.prepare(
      `SELECT COUNT(*) AS c FROM transactions t LEFT JOIN products p ON p.id = t.product_id ${where}`
    ).get(...args).c;

    const rows = db.prepare(
      `SELECT t.* FROM transactions t LEFT JOIN products p ON p.id = t.product_id
       ${where} ORDER BY t.id DESC LIMIT ? OFFSET ?`
    ).all(...args, limit, offset);

    return {
      status: 200,
      body: { transactions: rows.map(serializeTransaction), total, limit, offset }
    };
  }
});

// ======================================================================
// مدیریت اسناد: ویرایش / ابطال — فقط مدیر سیستم
// ======================================================================
routes.push({
  method: 'PUT', path: '/api/documents/:id', permission: 'documents.manage',
  handler: (ctx) => {
    const id = vId(ctx.params.id, 'شناسه سند');
    const b = ctx.body || {};
    const reason = vReason(b.reason);
    const newQty = vInt(b.quantity, 'تعداد');
    const date = vDate(b.date, 'تاریخ');
    const party = vOptionalText(b.party, 'طرف حساب', { maxLen: 200 });
    const description = vOptionalText(b.description, 'توضیحات');

    return inTransaction(() => {
      const t = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
      if (!t) throw new BusinessError('سند یافت نشد', 404);
      if (t.status === 'باطل') throw new BusinessError('سند باطل‌شده قابل ویرایش نیست');

      const oldQty = t.quantity;
      const oldDate = t.date;
      const oldParty = t.type === 'ورود' ? (t.source || '') : t.type === 'مرجوعی' ? (t.returned_by || '') : (t.receiver || '');
      const oldDescription = t.description || '';

      // اثر خالص ویرایش بر موجودی، از مسیر کنترل‌شده اعمال می‌شود؛ اگر
      // منفی شود، کل تراکنش برمی‌گردد و سند هم تغییر نمی‌کند.
      const sign = (t.type === 'خروج') ? -1 : 1;
      const delta = sign * (newQty - oldQty);
      if (delta !== 0) applyStockDelta(t.product_id, delta, 'این ویرایش');

      const partyColumn = t.type === 'ورود' ? 'source' : t.type === 'مرجوعی' ? 'returned_by' : 'receiver';
      db.prepare(`UPDATE transactions SET quantity = ?, date = ?, description = ?, ${partyColumn} = ? WHERE id = ?`)
        .run(newQty, date, description, party, id);

      const changeParts = [];
      if (oldQty !== newQty) changeParts.push(`تعداد: ${oldQty} ← ${newQty}`);
      if (oldDate !== date) changeParts.push(`تاریخ: ${oldDate} ← ${date}`);
      if (oldParty !== (party || '')) changeParts.push(`طرف حساب: «${oldParty || '-'}» ← «${party || '-'}»`);
      if (oldDescription !== (description || '')) changeParts.push('توضیحات تغییر یافت');
      const changeDescription = changeParts.length > 0 ? changeParts.join(' | ') : 'بدون تغییر در مقادیر';

      addAuditEntry({ action: 'ویرایش سند', docNumber: t.doc_number, changeDescription, reason, userId: ctx.user.id });

      const updated = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
      return { status: 200, body: { transaction: serializeTransaction(updated) } };
    });
  }
});

// ابطال سند (جایگزین حذف فیزیکی).
// سند و شماره‌اش باقی می‌مانند، اثر موجودی برگردانده می‌شود، و سند در
// گزارش‌ها با برچسب «باطل» دیده می‌شود — همان چیزی که یک دفتر انبار
// واقعی هم انجام می‌دهد: سند باطل خط می‌خورد، پاره نمی‌شود.
routes.push({
  method: 'DELETE', path: '/api/documents/:id', permission: 'documents.manage',
  handler: (ctx) => {
    const id = vId(ctx.params.id, 'شناسه سند');
    const reason = vReason((ctx.body || {}).reason);

    return inTransaction(() => {
      const t = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
      if (!t) throw new BusinessError('سند یافت نشد', 404);
      if (t.status === 'باطل') throw new BusinessError('این سند قبلاً باطل شده است');

      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(t.product_id);

      // برگرداندن اثر سند: ورود/مرجوعی کم می‌شود، خروج اضافه.
      const sign = (t.type === 'خروج') ? 1 : -1;
      applyStockDelta(t.product_id, sign * t.quantity, 'ابطال این سند');

      const now = new Date().toISOString();
      db.prepare(`UPDATE transactions SET status = 'باطل', voided_at = ?, void_reason = ?, voided_by_user_id = ? WHERE id = ?`)
        .run(now, reason, ctx.user.id, id);

      const party = t.type === 'ورود' ? (t.source || '-') : t.type === 'مرجوعی' ? (t.returned_by || '-') : (t.receiver || '-');
      const changeDescription = `سند ${t.type} به تعداد ${t.quantity} ${product ? product.unit : ''} برای کالای «${product ? product.name : 'نامشخص'}» (طرف حساب: ${party}) باطل شد و اثر آن بر موجودی برگردانده شد. شماره سند بدون تغییر باقی می‌ماند.`;

      addAuditEntry({ action: 'ابطال سند', docNumber: t.doc_number, changeDescription, reason, userId: ctx.user.id });

      return { status: 200, body: { ok: true, docNumber: t.doc_number, status: 'باطل' } };
    });
  }
});

module.exports = routes;
