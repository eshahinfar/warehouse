<?php
declare(strict_types=1);

final class BusinessError extends RuntimeException
{
    public function __construct(string $message, public int $status = 400)
    {
        parent::__construct($message);
    }
}

/**
 * Core warehouse business rules migrated from src/business.js.
 * Route handlers should call this service instead of issuing SQL directly.
 */
final class Business
{
    private const DOC_PREFIXES = [
        'in' => 'IN', 'out' => 'OUT', 'ret' => 'RET', 'req' => 'REQ',
        'custIssue' => 'CST', 'custReturn' => 'CSR', 'repIn' => 'REP', 'repOut' => 'REPR',
    ];

    public function __construct(private Database $db)
    {
    }

    public function nextDocNumber(string $kind): string
    {
        if (!isset(self::DOC_PREFIXES[$kind])) {
            throw new BusinessError('نوع شماره سند نامعتبر است');
        }

        // FOR UPDATE makes counter allocation safe when two users create documents concurrently.
        $row = $this->db->one('SELECT value FROM counters WHERE kind = ? FOR UPDATE', [$kind]);
        $next = ((int)($row['value'] ?? 0)) + 1;

        if ($row) {
            $this->db->execute('UPDATE counters SET value = ? WHERE kind = ?', [$next, $kind]);
        } else {
            $this->db->execute('INSERT INTO counters (kind, value) VALUES (?, ?)', [$kind, $next]);
        }

        return self::DOC_PREFIXES[$kind] . '-' . str_pad((string)$next, 6, '0', STR_PAD_LEFT);
    }

    public function applyStockDelta(int $productId, int $delta, string $contextLabel = 'این عملیات'): int
    {
        $product = $this->db->one('SELECT * FROM products WHERE id = ? FOR UPDATE', [$productId]);
        if (!$product) {
            throw new BusinessError('کالا یافت نشد', 404);
        }

        $newStock = (int)$product['stock'] + $delta;
        if ($newStock < 0) {
            throw new BusinessError(
                $contextLabel . ' باعث منفی شدن موجودی «' . $product['name'] . '» می‌شود ' .
                '(موجودی فعلی: ' . $product['stock'] . ' ' . $product['unit'] . '). عملیات انجام نشد.'
            );
        }

        $now = (new DateTimeImmutable('now', new DateTimeZone('UTC')))->format(DateTimeInterface::ATOM);
        $this->db->execute(
            'UPDATE products SET stock = ?, updated_at = ? WHERE id = ?',
            [$newStock, $now, $productId]
        );
        return $newStock;
    }

    public function stockFromLedger(int $productId): int
    {
        $row = $this->db->one(
            "SELECT COALESCE(SUM(CASE WHEN type = 'خروج' THEN -quantity ELSE quantity END), 0) AS total
             FROM transactions WHERE product_id = ? AND status = 'معتبر'",
            [$productId]
        );
        return (int)($row['total'] ?? 0);
    }

    public function custodyOutstandingQty(int $productId): int
    {
        $row = $this->db->one(
            "SELECT COALESCE(SUM(quantity), 0) AS total FROM custody_records WHERE product_id = ? AND status = 'باز'",
            [$productId]
        );
        return (int)($row['total'] ?? 0);
    }

    public function repairOutstandingQty(int $productId): int
    {
        $row = $this->db->one(
            "SELECT COALESCE(SUM(quantity), 0) AS total FROM repair_records WHERE product_id = ? AND status = 'در حال تعمیر'",
            [$productId]
        );
        return (int)($row['total'] ?? 0);
    }

    public function stockSnapshot(array $product): array
    {
        $inCustody = $this->custodyOutstandingQty((int)$product['id']);
        $inRepair = $this->repairOutstandingQty((int)$product['id']);
        return [
            'onHand' => (int)$product['stock'],
            'inCustody' => $inCustody,
            'inRepair' => $inRepair,
            'available' => (int)$product['stock'] - $inCustody - $inRepair,
        ];
    }

    public function getStockStatus(array $product): string
    {
        $available = $this->stockSnapshot($product)['available'];
        $min = (int)$product['min_stock'];
        if ($min <= 0) return $available <= 0 ? 'critical' : 'ok';
        if ($available < $min) return 'critical';
        if ($available <= $min * 1.5) return 'warn';
        return 'ok';
    }

    public function stockDiscrepancies(): array
    {
        $products = $this->db->all('SELECT * FROM products ORDER BY code ASC');
        $result = [];
        foreach ($products as $product) {
            $ledger = $this->stockFromLedger((int)$product['id']);
            if ((int)$product['stock'] !== $ledger) {
                $result[] = [
                    'id' => (int)$product['id'],
                    'code' => $product['code'],
                    'name' => $product['name'],
                    'unit' => $product['unit'],
                    'storedStock' => (int)$product['stock'],
                    'ledgerStock' => $ledger,
                ];
            }
        }
        return $result;
    }

    public function repairStockFromLedger(int $userId): array
    {
        return $this->db->transaction(function () use ($userId): array {
            $diffs = $this->stockDiscrepancies();
            $now = (new DateTimeImmutable('now', new DateTimeZone('UTC')))->format(DateTimeInterface::ATOM);
            foreach ($diffs as $d) {
                $this->db->execute(
                    'UPDATE products SET stock = ?, updated_at = ? WHERE id = ?',
                    [$d['ledgerStock'], $now, $d['id']]
                );
                $this->addAuditEntry([
                    'action' => 'اصلاح موجودی (تطبیق با دفتر اسناد)',
                    'docNumber' => $d['code'],
                    'changeDescription' => 'موجودی «' . $d['name'] . '» از ' . $d['storedStock'] . ' به ' . $d['ledgerStock'] . ' ' . $d['unit'] . ' اصلاح شد (مقدار محاسبه‌شده از مجموع اسناد معتبر).',
                    'reason' => 'اجرای تطبیق موجودی توسط مدیر سیستم',
                    'userId' => $userId,
                ]);
            }
            return $diffs;
        });
    }

    public function addAuditEntry(array $entry): void
    {
        $now = (new DateTimeImmutable('now', new DateTimeZone('UTC')))->format(DateTimeInterface::ATOM);
        $this->db->execute(
            'INSERT INTO audit_log (timestamp, action, doc_number, change_description, reason, performed_by_user_id) VALUES (?, ?, ?, ?, ?, ?)',
            [$now, $entry['action'], $entry['docNumber'] ?? null, $entry['changeDescription'] ?? null, $entry['reason'] ?? null, $entry['userId'] ?? null]
        );
    }

    public function isoToday(): string
    {
        return gmdate('Y-m-d');
    }
}
