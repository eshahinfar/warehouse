'use strict';

const { db, inTransaction } = require('../db');
const {
  nextDocNumber, applyStockDelta, stockSnapshot, addAuditEntry, BusinessError
} = require('../business');
const { vId, vInt, vDate, vText, vOptionalText, vEnum, vReason } = require('../validators');

const routes = [];

const REPAIR_RESULTS = ['تعمیر شد', 'نیاز به قطعه یدکی', 'غیرقابل تعمیر - اسقاط'];

function serializeRepair(row) {
  return {
    id: row.id, docNumber: row.doc_number, productId: row.product_id, quantity: row.quantity,
    sendDate: row.send_date, submittedBy: row.submitted_by, repairShop: row.repair_shop,
    issueDescription: row.issue_description, status: row.status, resultDate: row.result_date,
    result: row.result, technician: row.technician, approver: row.approver,
    resultNotes: row.result_notes, resultDocNumber: row.result_doc_number, voidReason: row.void_reason
  };
}

routes.push({
  method: 'GET', path: '/api/repair', permission: 'repair.manage',
  handler: () => {
    const rows = db.prepare('SELECT * FROM repair_records ORDER BY id DESC').all();
    return { status: 200, body: { repairRecords: rows.map(serializeRepair) } };
  }
});

routes.push({
  method: 'POST', path: '/api/repair/send', permission: 'repair.manage',
  handler: (ctx) => {
    const b = ctx.body || {};
    const productId = vId(b.productId, 'انتخاب کالا');
    const qty = vInt(b.quantity, 'تعداد');
    const date = vDate(b.date, 'تاریخ ارسال');
    const submittedBy = vText(b.submittedBy, 'نام تحویل‌دهنده', { maxLen: 200 });
    const issueDescription = vText(b.issueDescription, 'شرح خرابی', { maxLen: 2000 });
    const repairShop = vOptionalText(b.repairShop, 'تعمیرگاه', { maxLen: 200 }) || 'کارگاه تعمیرات داخلی';

    return inTransaction(() => {
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
      if (!product) throw new BusinessError('کالای انتخاب‌شده معتبر نیست', 404);
      if (product.active === 0) throw new BusinessError('این کالا بایگانی شده است');

      // کالایی که در انبار نیست (امانت داده شده یا از قبل در تعمیرگاه است)
      // نمی‌تواند دوباره به تعمیر فرستاده شود.
      const snap = stockSnapshot(product);
      if (qty > snap.available) {
        throw new BusinessError(
          `تعداد قابل ارسال به تعمیر کافی نیست. موجودی دفتری: ${snap.onHand}، ` +
          `نزد کاربران: ${snap.inCustody}، از قبل در تعمیرگاه: ${snap.inRepair}، قابل ارسال: ${snap.available}`
        );
      }

      const docNumber = nextDocNumber('repIn');
      const now = new Date().toISOString();
      const result = db.prepare(`INSERT INTO repair_records (doc_number, product_id, quantity, send_date, submitted_by, repair_shop, issue_description, status, created_by_user_id, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, 'در حال تعمیر', ?, ?)`)
        .run(docNumber, product.id, qty, date, submittedBy, repairShop, issueDescription, ctx.user.id, now);

      const row = db.prepare('SELECT * FROM repair_records WHERE id = ?').get(Number(result.lastInsertRowid));
      return { status: 201, body: { repairRecord: serializeRepair(row) } };
    });
  }
});

// ویرایش رکورد باز تعمیر
routes.push({
  method: 'PUT', path: '/api/repair/:id', permission: 'repair.manage',
  handler: (ctx) => {
    const id = vId(ctx.params.id, 'شناسه رکورد تعمیر');
    const b = ctx.body || {};
    const submittedBy = vText(b.submittedBy, 'نام تحویل‌دهنده', { maxLen: 200 });
    const repairShop = vOptionalText(b.repairShop, 'تعمیرگاه', { maxLen: 200 }) || 'کارگاه تعمیرات داخلی';
    const issueDescription = vText(b.issueDescription, 'شرح خرابی', { maxLen: 2000 });
    const reason = vReason(b.reason);

    return inTransaction(() => {
      const record = db.prepare('SELECT * FROM repair_records WHERE id = ?').get(id);
      if (!record) throw new BusinessError('رکورد تعمیر یافت نشد', 404);
      if (record.status !== 'در حال تعمیر') throw new BusinessError('فقط رکوردهای باز قابل ویرایش هستند');

      db.prepare('UPDATE repair_records SET submitted_by = ?, repair_shop = ?, issue_description = ? WHERE id = ?')
        .run(submittedBy, repairShop, issueDescription, id);

      addAuditEntry({
        action: 'ویرایش رکورد تعمیر',
        docNumber: record.doc_number,
        changeDescription: `اطلاعات سند تعمیر ${record.doc_number} اصلاح شد.`,
        reason, userId: ctx.user.id
      });

      const row = db.prepare('SELECT * FROM repair_records WHERE id = ?').get(id);
      return { status: 200, body: { repairRecord: serializeRepair(row) } };
    });
  }
});

// ابطال سند تعمیری که اشتباهی ثبت شده
routes.push({
  method: 'POST', path: '/api/repair/:id/void', permission: 'repair.manage',
  handler: (ctx) => {
    const id = vId(ctx.params.id, 'شناسه رکورد تعمیر');
    const reason = vReason((ctx.body || {}).reason);

    return inTransaction(() => {
      const record = db.prepare('SELECT * FROM repair_records WHERE id = ?').get(id);
      if (!record) throw new BusinessError('رکورد تعمیر یافت نشد', 404);
      if (record.status !== 'در حال تعمیر') throw new BusinessError('فقط رکورد باز قابل ابطال است');

      db.prepare("UPDATE repair_records SET status = 'باطل', void_reason = ? WHERE id = ?").run(reason, id);
      addAuditEntry({
        action: 'ابطال سند تعمیر',
        docNumber: record.doc_number,
        changeDescription: `سند ارسال به تعمیر ${record.doc_number} باطل شد؛ کالا به موجودی قابل تخصیص بازگشت.`,
        reason, userId: ctx.user.id
      });
      return { status: 200, body: { ok: true } };
    });
  }
});

routes.push({
  method: 'POST', path: '/api/repair/:id/complete', permission: 'repair.manage',
  handler: (ctx) => {
    const id = vId(ctx.params.id, 'شناسه رکورد تعمیر');
    const b = ctx.body || {};
    const date = vDate(b.date, 'تاریخ تکمیل');
    const result = vEnum(b.result, 'نتیجه تعمیر', REPAIR_RESULTS);
    const approver = vText(b.approver, 'نام تأییدکننده تعمیرات', { maxLen: 200 });
    const technician = vOptionalText(b.technician, 'نام تعمیرکار', { maxLen: 200 });
    const resultNotes = vOptionalText(b.resultNotes, 'توضیحات نتیجه');

    return inTransaction(() => {
      const record = db.prepare('SELECT * FROM repair_records WHERE id = ?').get(id);
      if (!record) throw new BusinessError('رکورد تعمیر یافت نشد', 404);
      if (record.status !== 'در حال تعمیر') throw new BusinessError('این رکورد قبلاً تکمیل یا باطل شده است');
      if (date < record.send_date) throw new BusinessError('تاریخ تکمیل نمی‌تواند قبل از تاریخ ارسال باشد');

      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(record.product_id);
      const resultDocNumber = nextDocNumber('repOut');
      const newStatus = result === 'نیاز به قطعه یدکی' ? 'در حال تعمیر' : 'تکمیل شده';
      const now = new Date().toISOString();

      db.prepare(`UPDATE repair_records SET status = ?, result_date = ?, result = ?, technician = ?, approver = ?, result_notes = ?, result_doc_number = ? WHERE id = ?`)
        .run(newStatus, date, result, technician, approver, resultNotes, resultDocNumber, id);

      let stockAdjusted = false;
      if (result === 'غیرقابل تعمیر - اسقاط' && product) {
        applyStockDelta(product.id, -record.quantity, 'ثبت اسقاط پس از تعمیر ناموفق');
        const outDoc = nextDocNumber('out');
        db.prepare(`INSERT INTO transactions (doc_number, product_id, type, quantity, date, requesting_unit, receiver, reason, description, created_by_user_id, created_at)
                    VALUES (?, ?, 'خروج', ?, ?, 'تعمیر و نگهداری', ?, 'ضایعات', ?, ?, ?)`)
          .run(outDoc, product.id, record.quantity, date, record.submitted_by,
            `کسر موجودی به دلیل اسقاط پس از تعمیر ناموفق (سند تعمیر مرجع: ${record.doc_number})`, ctx.user.id, now);
        stockAdjusted = true;
      }

      const row = db.prepare('SELECT * FROM repair_records WHERE id = ?').get(id);
      return { status: 200, body: { repairRecord: serializeRepair(row), stockAdjusted } };
    });
  }
});

module.exports = routes;
