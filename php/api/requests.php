<?php
declare(strict_types=1);
require_once __DIR__ . '/bootstrap.php';

try {
    $user = requireUser($auth);
    $method = $_SERVER['REQUEST_METHOD'];
    $body = requestBody();

    if ($method === 'GET') {
        $where = ['1=1']; $args = [];
        $status = trim((string)($_GET['status'] ?? ''));
        $search = trim((string)($_GET['search'] ?? ''));
        $limit = min(max((int)($_GET['limit'] ?? 100, 1), 1), 500);
        $offset = max((int)($_GET['offset'] ?? 0), 0);
        if ($status !== '') { $where[] = 'r.status = ?'; $args[] = $status; }
        if ($search !== '') { $where[] = '(LOWER(r.doc_number) LIKE ? OR LOWER(p.name) LIKE ? OR LOWER(p.code) LIKE ?)'; $term='%'.mb_strtolower($search,'UTF-8').'%'; array_push($args,$term,$term,$term); }
        $w = implode(' AND ', $where);
        $total = (int)($db->one("SELECT COUNT(*) c FROM requests r LEFT JOIN products p ON p.id=r.product_id WHERE $w", $args)['c'] ?? 0);
        $rows = $db->all("SELECT r.* FROM requests r LEFT JOIN products p ON p.id=r.product_id WHERE $w ORDER BY r.id DESC LIMIT $limit OFFSET $offset", $args);
        $items = array_map(fn($r)=>['id'=>(int)$r['id'],'docNumber'=>$r['doc_number'],'productId'=>(int)$r['product_id'],'quantity'=>(int)$r['quantity'],'date'=>$r['date'],'priority'=>$r['priority'],'status'=>$r['status'],'notes'=>$r['notes'],'auto'=>(bool)$r['auto']], $rows);
        jsonResponse(['requests'=>$items,'total'=>$total,'limit'=>$limit,'offset'=>$offset]);
    }

    $id = null;
    if (preg_match('~/api/requests/(\d+)(?:/cancel)?$~', $_SERVER['REQUEST_URI'] ?? '', $m)) $id=(int)$m[1];
    $isCancel = str_ends_with(parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH) ?: '', '/cancel');

    if ($method === 'POST' && $isCancel && $id) {
        $reason = trim((string)($body['reason'] ?? ''));
        if ($reason === '') jsonResponse(['error'=>'علت لغو الزامی است'],400);
        $db->transaction(function(Database $db) use($id,$reason,$user){
            $r=$db->one('SELECT * FROM requests WHERE id=? FOR UPDATE',[$id]);
            if(!$r) throw new BusinessError('درخواست یافت نشد',404);
            if($r['status']==='لغو شده') throw new BusinessError('این درخواست قبلاً لغو شده است');
            if($r['status']==='تأمین شده') throw new BusinessError('درخواست تأمین‌شده قابل لغو نیست');
            $db->execute("UPDATE requests SET status='لغو شده' WHERE id=?",[$id]);
            (new Business($db))->addAuditEntry(['action'=>'لغو درخواست','docNumber'=>$r['doc_number'],'changeDescription'=>'درخواست '.$r['doc_number'].' لغو شد.','reason'=>$reason,'userId'=>$user['id']]);
        });
        jsonResponse(['ok'=>true]);
    }

    if ($method === 'POST' && !$id) {
        $productId=(int)($body['productId']??0); $qty=(int)($body['quantity']??0); $date=trim((string)($body['date']??'')); $priority=$body['priority']??'عادی'; $notes=$body['notes']??null;
        if($productId<=0||$qty<=0||$date==='') jsonResponse(['error'=>'اطلاعات درخواست ناقص است'],400);
        if(!in_array($priority,['عادی','فوری','بحرانی'],true)) jsonResponse(['error'=>'اولویت نامعتبر است'],400);
        $row=$db->transaction(function(Database $db) use($productId,$qty,$date,$priority,$notes,$user){
            $p=$db->one('SELECT * FROM products WHERE id=?',[$productId]); if(!$p) throw new BusinessError('کالا یافت نشد',404); if(!(int)$p['active']) throw new BusinessError('این کالا بایگانی شده است');
            $b=new Business($db); $doc=$b->nextDocNumber('req'); $now=(new DateTimeImmutable('now',new DateTimeZone('UTC')))->format(DateTimeInterface::ATOM);
            $db->execute("INSERT INTO requests (doc_number,product_id,quantity,date,priority,status,notes,auto,created_by_user_id,created_at) VALUES (?,?,?,?,?,'در انتظار',?,0,?,?)",[$doc,$productId,$qty,$date,$priority,$notes,$user['id'],$now]);
            return $db->one('SELECT * FROM requests WHERE id=?',[$db->lastInsertId()]);
        });
        jsonResponse(['request'=>['id'=>(int)$row['id'],'docNumber'=>$row['doc_number'],'productId'=>(int)$row['product_id'],'quantity'=>(int)$row['quantity'],'date'=>$row['date'],'priority'=>$row['priority'],'status'=>$row['status'],'notes'=>$row['notes'],'auto'=>(bool)$row['auto']]],201);
    }

    jsonResponse(['error'=>'Method Not Allowed'],405);
} catch (BusinessError $e) { jsonResponse(['error'=>$e->getMessage()],$e->status); }
catch(Throwable $e){ error_log('requests.php: '.$e->getMessage()); jsonResponse(['error'=>'خطای داخلی سرور'],500); }
