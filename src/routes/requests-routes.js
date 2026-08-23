'use strict';

const { db, inTransaction } = require('../db');
const {
  nextDocNumber, stockSnapshot, addAuditEntry, isoToday, BusinessError
} = require('../business');
const { vId, vInt, vDate, vOptionalText, vEnum, vReason } = require('../validators');
const config = require('../config');

const routes = [];

const PRIORITIES = ['عادی', 'فوری', 'بحرانی'];

function serializeRequest(row) {
  return {
    id: row.id, docNumber: row.doc_number, productId: row.product_id, quantity: row.quantity,
    date: row.date, priority: row.priority, status: row.status, notes: row.notes, auto: !!row.auto
  };
}

routes.push({
  method: 'GET', path: '/api/requests', permission: 'requests.view',
  handler: (ctx) => {
    const q = ctx.query || {};
    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), config.maxPageSize);
    const offset = Math.max(Number(q.offset) || 0, 0);

    let where = 'WHERE 1=1';
    const args = [];
    if (q.status) { where += ' AND r.status = ?'; args.push(String(q.status)); }
    if (q.search) {
      const term = `%${String(q.search).trim().toLowerCase()}%`;
      where += ' AND (LOWER(r.doc_number) LIKE ? OR LOWER(p.name) LIKE ? OR LOWER(p.code) LIKE ?)';
      args.push(term, term, term);
    }

    const total = db.prepare(`SELECT COUNT(*) AS c FROM requests r LEFT JOIN products p ON p.id = r.product_id ${where}`).get(...args).c;
    const rows = db.prepare(
      `SELECT r.* FROM requests r LEFT JOIN products p ON p.id = r.product_id ${where} ORDER BY r.id DESC LIMIT ? OFFSET ?`
    ).all(...args, limit, offset);

    return { status: 200, body: { requests: rows.map(serializeRequest), total, limit, offset } };
  }
});

routes.push({
  method: 'POST', path: '/api/requests', permission: 'requests.create',
  handler: (ctx) => {
    const b = ctx.body || {};
    const productId = vId(b.productId, 'انتخاب کالا');
    const qty = vInt(b.quantity, 'تعداد');
    const date = vDate(b.date, 'تاریخ');
    const priority = vEnum(b.priority || 'عادی', 'اولویت', PRIORITIES);
    const notes = vOptionalText(b.notes, 'توضیحات');

    return inTransaction(() => {
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
      if (!product) throw new BusinessError('کالای انتخاب‌شده معتبر نیست', 404);
      if (product.active === 0) throw new BusinessError('این کالا بایگانی شده است و درخواست جدیدی برای آن ثبت نمی‌شود');

      const docNumber = nextDocNumber('req');
      const now = new Date().toISOString();
      const result = db.prepare(`INSERT INTO requests (doc_number, product_id, quantity, date, priority, status, notes, auto, created_by_user_id, created_at)
                  VALUES (?, ?, ?, ?, ?, 'در انتظار', ?, 0, ?, ?)`)
        .run(docNumber, productId, qty, date, priority, notes, ctx.user.id, now);

      const row = db.prepare('SELECT * FROM requests WHERE id = ?').get(Number(result.lastInsertRowid));
      return { status: 201, body: { request: serializeRequest(row) } };
    });
  }
});

routes.push({
  method: 'PUT', path: '/api/requests/:id', permission: 'requests.manage',
  handler: (ctx) => {
    const id = vId(ctx.params.id, 'شناسه درخواست');
    const b = ctx.body || {};
    const productId = vId(b.productId, 'انتخاب کالا');
    const qty = vInt(b.quantity, 'تعداد');
    const date = vDate(b.date, 'تاریخ');
    const priority = vEnum(b.priority || 'عادی', 'اولویت', PRIORITIES);
    const notes = vOptionalText(b.notes, 'توضیحات');

    return inTransaction(() => {
      const existing = db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
      if (!existing) throw new BusinessError('درخواست یافت نشد', 404);
      if (existing.status !== 'در انتظار') throw new BusinessError('فقط درخواست‌های «در انتظار» قابل ویرایش هستند');

      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
      if (!product) throw new BusinessError('کالای انتخاب‌شده معتبر نیست', 404);

      db.prepare('UPDATE requests SET product_id = ?, quantity = ?, date = ?, priority = ?, notes = ? WHERE id = ?')
        .run(productId, qty, date, priority, notes, id);

      const row = db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
      return { status: 200, body: { request: serializeRequest(row) } };
    });
  }
});

// لغو درخواست — جایگزین حذف فیزیکی. شماره درخواست باقی می‌ماند، پس
// ارجاع‌های رسیدهای ورود («تأمین درخواست REQ-000012») همیشه معتبر است.
routes.push({
  method: 'POST', path: '/api/requests/:id/cancel', permission: 'requests.manage',
  handler: (ctx) => {
    const id = vId(ctx.params.id, 'شناسه درخواست');
    const reason = vReason((ctx.body || {}).reason);

    return inTransaction(() => {
      const existing = db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
      if (!existing) throw new BusinessError('درخواست یافت نشد', 404);
      if (existing.status === 'لغو شده') throw new BusinessError('این درخواست قبلاً لغو شده است');
      if (existing.status === 'تأمین شده') throw new BusinessError('درخواست تأمین‌شده قابل لغو نیست');

      db.prepare("UPDATE requests SET status = 'لغو شده' WHERE id = ?").run(id);
      addAuditEntry({
        action: 'لغو درخواست',
        docNumber: existing.doc_number,
        changeDescription: `درخواست ${existing.doc_number} به تعداد ${existing.quantity} لغو شد.`,
        reason, userId: ctx.user.id
      });
      return { status: 200, body: { ok: true } };
    });
  }
});

routes.push({
  method: 'POST', path: '/api/requests/auto-generate', permission: 'requests.manage',
  handler: (ctx) => {
    return inTransaction(() => {
      const products = db.prepare('SELECT * FROM products WHERE active = 1').all();
      let count = 0;
      const now = new Date().toISOString();

      products.forEach(product => {
        // بر اساس موجودی قابل تخصیص، نه موجودی دفتری: ابزاری که همه‌اش
        // دست کاربران است هم باید تأمین شود.
        const { available } = stockSnapshot(product);
        if (available >= product.min_stock) return;

        const existingOpen = db.prepare("SELECT id FROM requests WHERE product_id = ? AND status = 'در انتظار'").get(product.id);
        if (existingOpen) return;

        const requiredQty = Math.max(product.min_stock * 2 - available, 1);
        const docNumber = nextDocNumber('req');
        db.prepare(`INSERT INTO requests (doc_number, product_id, quantity, date, priority, status, notes, auto, created_by_user_id, created_at)
                    VALUES (?, ?, ?, ?, 'بحرانی', 'در انتظار', 'تولید خودکار — موجودی قابل تخصیص زیر حداقل تعیین‌شده', 1, ?, ?)`)
          .run(docNumber, product.id, requiredQty, isoToday(), ctx.user.id, now);
        count++;
      });

      return { status: 200, body: { createdCount: count } };
    });
  }
});

module.exports = routes;
