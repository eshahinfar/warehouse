'use strict';

const { db, inTransaction } = require('../db');
const {
  nextDocNumber, applyStockDelta, stockSnapshot, custodyOutstandingQty, addAuditEntry, BusinessError
} = require('../business');
const { vId, vInt, vDate, vText, vOptionalText, vOptionalDate, vEnum, vReason } = require('../validators');

const routes = [];

const RETURN_CONDITIONS = ['سالم', 'آسیب‌دیده', 'نیازمند تعمیر', 'مفقود'];

function serializeCustody(row) {
  return {
    id: row.id, docNumber: row.doc_number, productId: row.product_id, quantity: row.quantity,
    issueDate: row.issue_date, holder: row.holder, unit: row.unit, expectedReturn: row.expected_return,
    conditionOut: row.condition_out, notes: row.notes, status: row.status,
    returnDate: row.return_date, conditionIn: row.condition_in, returnNotes: row.return_notes,
    returnDocNumber: row.return_doc_number, voidReason: row.void_reason
  };
}

routes.push({
  method: 'GET', path: '/api/custody', permission: 'custody.manage',
  handler: () => {
    const rows = db.prepare('SELECT * FROM custody_records ORDER BY id DESC').all();
    return { status: 200, body: { custodyRecords: rows.map(serializeCustody) } };
  }
});

routes.push({
  method: 'POST', path: '/api/custody/issue', permission: 'custody.manage',
  handler: (ctx) => {
    const b = ctx.body || {};
    const productId = vId(b.productId, 'انتخاب ابزار');
    const qty = vInt(b.quantity, 'تعداد');
    const date = vDate(b.date, 'تاریخ تحویل');
    const holder = vText(b.holder, 'نام تحویل‌گیرنده', { maxLen: 200 });
    const unit = vText(b.unit, 'واحد تحویل‌گیرنده', { maxLen: 200 });
    const expectedReturn = vOptionalDate(b.expectedReturn, 'موعد بازگشت');
    const conditionOut = vOptionalText(b.conditionOut, 'وضعیت هنگام تحویل', { maxLen: 200 }) || 'سالم';
    const notes = vOptionalText(b.notes, 'توضیحات');

    if (expectedReturn && expectedReturn < date) {
      throw new BusinessError('موعد بازگشت نمی‌تواند قبل از تاریخ تحویل باشد');
    }

    return inTransaction(() => {
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
      if (!product) throw new BusinessError('ابزار انتخاب‌شده معتبر نیست', 404);
      if (product.active === 0) throw new BusinessError('این ابزار بایگانی شده است');
      if (product.type !== 'قابل‌برگشت') throw new BusinessError('این کالا از نوع قابل‌برگشت نیست');

      const snap = stockSnapshot(product);
      if (qty > snap.available) {
        throw new BusinessError(
          `موجودی قابل تحویل کافی نیست. موجودی دفتری: ${snap.onHand}، ` +
          `نزد کاربران: ${snap.inCustody}، در تعمیرگاه: ${snap.inRepair}، قابل تحویل: ${snap.available}`
        );
      }

      const docNumber = nextDocNumber('custIssue');
      const now = new Date().toISOString();
      const result = db.prepare(`INSERT INTO custody_records (doc_number, product_id, quantity, issue_date, holder, unit, expected_return, condition_out, notes, status, created_by_user_id, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'باز', ?, ?)`)
        .run(docNumber, product.id, qty, date, holder, unit, expectedReturn, conditionOut, notes, ctx.user.id, now);

      const row = db.prepare('SELECT * FROM custody_records WHERE id = ?').get(Number(result.lastInsertRowid));
      return { status: 201, body: { custodyRecord: serializeCustody(row) } };
    });
  }
});

// ویرایش یک امانت باز (نسخه قبلی هیچ راهی برای اصلاح اشتباه تایپی در نام
// تحویل‌گیرنده یا موعد بازگشت نداشت جز دست بردن در فایل پایگاه‌داده)
routes.push({
  method: 'PUT', path: '/api/custody/:id', permission: 'custody.manage',
  handler: (ctx) => {
    const id = vId(ctx.params.id, 'شناسه امانت');
    const b = ctx.body || {};
    const qty = vInt(b.quantity, 'تعداد');
    const holder = vText(b.holder, 'نام تحویل‌گیرنده', { maxLen: 200 });
    const unit = vText(b.unit, 'واحد تحویل‌گیرنده', { maxLen: 200 });
    const expectedReturn = vOptionalDate(b.expectedReturn, 'موعد بازگشت');
    const notes = vOptionalText(b.notes, 'توضیحات');
    const reason = vReason(b.reason);

    return inTransaction(() => {
      const record = db.prepare('SELECT * FROM custody_records WHERE id = ?').get(id);
      if (!record) throw new BusinessError('رکورد امانت یافت نشد', 404);
      if (record.status !== 'باز') throw new BusinessError('فقط امانت‌های باز قابل ویرایش هستند');

      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(record.product_id);
      // افزایش تعداد نباید از موجودی قابل تخصیص فراتر برود
      if (qty > record.quantity) {
        const snap = stockSnapshot(product);
        const extra = qty - record.quantity;
        if (extra > snap.available) {
          throw new BusinessError(`افزایش تعداد ممکن نیست؛ فقط ${snap.available} عدد قابل تخصیص است`);
        }
      }

      db.prepare(`UPDATE custody_records SET quantity = ?, holder = ?, unit = ?, expected_return = ?, notes = ? WHERE id = ?`)
        .run(qty, holder, unit, expectedReturn, notes, id);

      const changes = [];
      if (record.quantity !== qty) changes.push(`تعداد: ${record.quantity} ← ${qty}`);
      if (record.holder !== holder) changes.push(`تحویل‌گیرنده: «${record.holder}» ← «${holder}»`);
      if ((record.expected_return || '') !== (expectedReturn || '')) changes.push(`موعد بازگشت: ${record.expected_return || '-'} ← ${expectedReturn || '-'}`);

      addAuditEntry({
        action: 'ویرایش امانت',
        docNumber: record.doc_number,
        changeDescription: changes.length ? changes.join(' | ') : 'بدون تغییر در مقادیر',
        reason, userId: ctx.user.id
      });

      const row = db.prepare('SELECT * FROM custody_records WHERE id = ?').get(id);
      return { status: 200, body: { custodyRecord: serializeCustody(row) } };
    });
  }
});

// ابطال یک سند امانت که اشتباهی ثبت شده (بدون بازگشت واقعی ابزار)
routes.push({
  method: 'POST', path: '/api/custody/:id/void', permission: 'custody.manage',
  handler: (ctx) => {
    const id = vId(ctx.params.id, 'شناسه امانت');
    const reason = vReason((ctx.body || {}).reason);

    return inTransaction(() => {
      const record = db.prepare('SELECT * FROM custody_records WHERE id = ?').get(id);
      if (!record) throw new BusinessError('رکورد امانت یافت نشد', 404);
      if (record.status !== 'باز') throw new BusinessError('فقط امانت باز قابل ابطال است؛ امانت تسویه‌شده را نمی‌توان باطل کرد');

      db.prepare("UPDATE custody_records SET status = 'باطل', void_reason = ? WHERE id = ?").run(reason, id);
      addAuditEntry({
        action: 'ابطال سند امانت',
        docNumber: record.doc_number,
        changeDescription: `سند امانت ${record.doc_number} (تحویل‌گیرنده: ${record.holder}، تعداد: ${record.quantity}) باطل شد؛ ابزار به موجودی قابل تخصیص بازگشت.`,
        reason, userId: ctx.user.id
      });
      return { status: 200, body: { ok: true } };
    });
  }
});

routes.push({
  method: 'POST', path: '/api/custody/:id/return', permission: 'custody.manage',
  handler: (ctx) => {
    const id = vId(ctx.params.id, 'شناسه امانت');
    const b = ctx.body || {};
    const date = vDate(b.date, 'تاریخ بازگشت');
    const conditionIn = vEnum(b.conditionIn, 'وضعیت بازگشت', RETURN_CONDITIONS);
    const notes = vOptionalText(b.notes, 'توضیحات');

    if ((conditionIn === 'آسیب‌دیده' || conditionIn === 'مفقود') && !notes) {
      throw new BusinessError('برای وضعیت آسیب‌دیده یا مفقود، ثبت توضیحات الزامی است');
    }

    return inTransaction(() => {
      const record = db.prepare('SELECT * FROM custody_records WHERE id = ?').get(id);
      if (!record) throw new BusinessError('رکورد امانت یافت نشد', 404);
      if (record.status !== 'باز') throw new BusinessError('این رکورد قبلاً تسویه یا باطل شده است');
      if (date < record.issue_date) throw new BusinessError('تاریخ بازگشت نمی‌تواند قبل از تاریخ تحویل باشد');

      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(record.product_id);
      const returnDocNumber = nextDocNumber('custReturn');
      const now = new Date().toISOString();

      db.prepare(`UPDATE custody_records SET status = 'بسته', return_date = ?, condition_in = ?, return_notes = ?, return_doc_number = ? WHERE id = ?`)
        .run(date, conditionIn, notes, returnDocNumber, id);

      const extra = {};

      if (conditionIn === 'مفقود' && product) {
        // کسر موجودی از مسیر کنترل‌شده؛ اگر به هر دلیل موجودی کافی نباشد
        // کل عملیات برمی‌گردد و امانت هم بسته نمی‌شود.
        applyStockDelta(product.id, -record.quantity, 'ثبت مفقودی ابزار');
        const outDoc = nextDocNumber('out');
        db.prepare(`INSERT INTO transactions (doc_number, product_id, type, quantity, date, requesting_unit, receiver, reason, description, created_by_user_id, created_at)
                    VALUES (?, ?, 'خروج', ?, ?, ?, ?, 'ضایعات', ?, ?, ?)`)
          .run(outDoc, product.id, record.quantity, date, record.unit, record.holder,
            `کسر موجودی به دلیل مفقودی ابزار امانی (سند امانت مرجع: ${record.doc_number})`, ctx.user.id, now);
        extra.stockAdjusted = true;
        extra.outDocNumber = outDoc;
      } else if (conditionIn === 'نیازمند تعمیر') {
        const repDoc = nextDocNumber('repIn');
        db.prepare(`INSERT INTO repair_records (doc_number, product_id, quantity, send_date, submitted_by, repair_shop, issue_description, status, source_custody_id, created_by_user_id, created_at)
                    VALUES (?, ?, ?, ?, ?, 'کارگاه تعمیرات داخلی', ?, 'در حال تعمیر', ?, ?, ?)`)
          .run(repDoc, record.product_id, record.quantity, date, record.holder,
            `ایجاد خودکار پس از بازگشت از امانت (سند امانت: ${record.doc_number}). شرح: ${notes || '-'}`,
            record.id, ctx.user.id, now);
        extra.repairDocNumber = repDoc;
      }

      const row = db.prepare('SELECT * FROM custody_records WHERE id = ?').get(id);
      return { status: 200, body: { custodyRecord: serializeCustody(row), returnDocNumber, ...extra } };
    });
  }
});

module.exports = routes;
