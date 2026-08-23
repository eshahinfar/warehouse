<?php
declare(strict_types=1);
require_once __DIR__ . '/bootstrap.php';

try {
    $user = requireUser($auth);
    $path = parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH) ?: '';

    if ($path === '/api/dashboard') {
        $products = $db->all('SELECT * FROM products WHERE active = 1');
        $critical = 0; $warn = 0;
        foreach ($products as $p) {
            $status = $business->getStockStatus($p);
            if ($status === 'critical') $critical++; elseif ($status === 'warn') $warn++;
        }
        $totalTransactions = (int)($db->one("SELECT COUNT(*) c FROM transactions WHERE status='معتبر'")['c'] ?? 0);
        $custodyOpen = (int)($db->one("SELECT COUNT(*) c FROM custody_records WHERE status='باز'")['c'] ?? 0);
        $repairOpen = (int)($db->one("SELECT COUNT(*) c FROM repair_records WHERE status='در حال تعمیر'")['c'] ?? 0);
        $recent = $db->all("SELECT t.doc_number AS docNumber,t.date,t.type,t.quantity,t.source,t.receiver,t.returned_by AS returnedBy,p.name AS productName FROM transactions t LEFT JOIN products p ON p.id=t.product_id WHERE t.status='معتبر' ORDER BY t.id DESC LIMIT 8");
        jsonResponse(['totalProducts'=>count($products),'criticalCount'=>$critical,'warnCount'=>$warn,'totalTransactions'=>$totalTransactions,'custodyOpenCount'=>$custodyOpen,'repairOpenCount'=>$repairOpen,'recentTransactions'=>$recent]);
    }

    if ($path === '/api/audit-log') {
        $limit = min(max((int)($_GET['limit'] ?? 500), 1), 2000);
        $rows = $db->all('SELECT a.id,a.timestamp,a.action,a.doc_number AS docNumber,a.change_description AS changeDescription,a.reason,u.full_name AS performedBy FROM audit_log a LEFT JOIN users u ON u.id=a.performed_by_user_id ORDER BY a.id DESC LIMIT '.$limit);
        jsonResponse(['auditLog'=>$rows,'limit'=>$limit]);
    }
    jsonResponse(['error'=>'Not Found'],404);
} catch (Throwable $e) {
    error_log('dashboard.php: '.$e->getMessage());
    jsonResponse(['error'=>'خطای داخلی سرور'],500);
}
