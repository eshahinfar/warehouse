<?php
declare(strict_types=1);
require_once __DIR__ . '/bootstrap.php';

function productForStock(Database $db, int $id): array {
    $p=$db->one('SELECT * FROM products WHERE id=? FOR UPDATE',[$id]);
    if(!$p) throw new BusinessError('کالای انتخاب‌شده معتبر نیست',404);
    if((int)$p['active']===0) throw new BusinessError('کالای بایگانی‌شده سند جدید نمی‌پذیرد');
    return $p;
}
function txJson(array $r): array {
    return ['id'=>(int)$r['id'],'docNumber'=>$r['doc_number'],'productId'=>(int)$r['product_id'],'type'=>$r['type'],'quantity'=>(int)$r['quantity'],'date'=>$r['date'],'source'=>$r['source'],'poNumber'=>$r['po_number'],'requestingUnit'=>$r['requesting_unit'],'receiver'=>$r['receiver'],'reason'=>$r['reason'],'linkedRequestId'=>$r['linked_request_id']===null?null:(int)$r['linked_request_id'],'returnedBy'=>$r['returned_by'],'condition'=>$r['condition_text'],'sourceDocId'=>$r['source_doc_id']===null?null:(int)$r['source_doc_id'],'sourceDocNumber'=>$r['source_doc_number'],'description'=>$r['description'],'status'=>$r['status']??'معتبر','voidedAt'=>$r['voided_at'],'voidReason'=>$r['void_reason'],'createdAt'=>$r['created_at']];
}
try {
    $user=requireUser($auth); $method=$_SERVER['REQUEST_METHOD']; $b=requestBody();
    $path=basename($_SERVER['SCRIPT_NAME']);
    if($method==='POST' && $path==='stock.php'){
        $action=$_GET['action']??'';
        $pid=(int)($b['productId']??0);$qty=(int)($b['quantity']??0);$date=trim((string)($b['date']??''));
        if($pid<1||$qty<1||!preg_match('/^\d{4}-\d{2}-\d{2}$/',$date))jsonResponse(['error'=>'اطلاعات سند نامعتبر است'],400);
        if($date>gmdate('Y-m-d'))jsonResponse(['error'=>'تاریخ سند نمی‌تواند در آینده باشد'],400);
        if(!in_array($action,['in','out','return'],true))jsonResponse(['error'=>'نوع عملیات نامعتبر است'],400);
        $tx=$db->transaction(function(Database $db)use($action,$pid,$qty,$date,$b,$user,$business){
            $p=productForStock($db,$pid);$now=gmdate(DateTimeInterface::ATOM);$kind=$action==='in'?'in':($action==='out'?'out':'ret');$type=$action==='in'?'ورود':($action==='out'?'خروج':'مرجوعی');
            if($action==='out' && (int)$p['stock']<$qty)throw new BusinessError("موجودی کافی نیست. موجودی فعلی «{$p['name']}»: {$p['stock']} {$p['unit']}");
            if($action==='out' && $p['type']==='قابل‌برگشت' && empty($b['force']))return ['conflict'=>true];
            $business->nextDocNumber($kind); // reserve inside transaction; counter is advanced below through the returned number
            // nextDocNumber was called once; retrieve the generated document from the counter value.
            $prefix=['in'=>'IN','out'=>'OUT','ret'=>'RET'][$kind];$row=$db->one('SELECT value FROM counters WHERE kind=?',[$kind]);$doc=$prefix.'-'.str_pad((string)$row['value'],6,'0',STR_PAD_LEFT);
            $delta=$action==='out'?- $qty:$qty;$business->applyStockDelta($pid,$delta,'ثبت سند');
            $source=$action==='in'?($b['source']??null):null;$po=$action==='in'?($b['poNumber']??null):null;$req=$action==='in'?(!empty($b['linkedRequestId'])?(int)$b['linkedRequestId']:null):null;
            $receiver=$action==='out'?($b['receiver']??null):null;$unit=$action==='out'?($b['requestingUnit']??null):null;$reason=$b['reason']??null;$returned=$action==='return'?($b['returnedBy']??null):null;$condition=$action==='return'?($b['condition']??null):null;$sourceId=$action==='return'?(!empty($b['sourceDocId'])?(int)$b['sourceDocId']:null):null;
            $sourceNo=null;if($sourceId){$s=$db->one('SELECT doc_number FROM transactions WHERE id=?',[$sourceId]);$sourceNo=$s['doc_number']??null;}
            $db->execute("INSERT INTO transactions (doc_number,product_id,type,quantity,date,source,po_number,requesting_unit,receiver,reason,linked_request_id,returned_by,condition_text,source_doc_id,source_doc_number,description,created_by_user_id,created_at,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'معتبر')",[$doc,$pid,$type,$qty,$date,$source,$po,$unit,$receiver,$reason,$req,$returned,$condition,$sourceId,$sourceNo,$b['description']??null,$user['id'],$now]);
            if($req)$db->execute("UPDATE requests SET status='تأمین شده' WHERE id=? AND status='در انتظار'",[$req]);
            $id=(int)$db->lastInsertId();return ['tx'=>$db->one('SELECT * FROM transactions WHERE id=?',[$id])];
        });
        if(!empty($tx['conflict']))jsonResponse(['error'=>'این کالا از نوع قابل‌برگشت است. برای پیگیری بازگشت از «امانت ابزار» استفاده کنید.','requiresForce'=>true],409);
        jsonResponse(['transaction'=>txJson($tx['tx'])],201);
    }
    if($method==='GET'){
        $limit=min(max((int)($_GET['limit']??50),1),500);$offset=max((int)($_GET['offset']??0),0);$where='WHERE 1=1';$args=[];
        if(($_GET['includeVoided']??'')!=='1')$where.=" AND t.status='معتبر'";
        foreach(['type'=>'t.type','productId'=>'t.product_id','startDate'=>'t.date >=','endDate'=>'t.date <='] as $q=>$col){if(isset($_GET[$q])&&$_GET[$q]!==''){if($q==='productId'){$where.=' AND '.$col.'=?';$args[]=(int)$_GET[$q];}elseif($q==='startDate'||$q==='endDate'){$where.=' AND '.$col.' ?';$args[]=$_GET[$q];}else{$where.=' AND '.$col.'=?';$args[]=$_GET[$q];}}}
        if(!empty($_GET['search'])){$s='%'.strtolower(trim((string)$_GET['search'])).'%';$where.=" AND (LOWER(t.doc_number) LIKE ? OR LOWER(p.name) LIKE ? OR LOWER(p.code) LIKE ? OR LOWER(COALESCE(t.source,'')) LIKE ? OR LOWER(COALESCE(t.receiver,'')) LIKE ? OR LOWER(COALESCE(t.returned_by,'')) LIKE ?)";$args=array_merge($args,array_fill(0,6,$s));}
        $total=(int)$db->one("SELECT COUNT(*) c FROM transactions t LEFT JOIN products p ON p.id=t.product_id $where",$args)['c'];
        $rows=$db->all("SELECT t.* FROM transactions t LEFT JOIN products p ON p.id=t.product_id $where ORDER BY t.id DESC LIMIT $limit OFFSET $offset",$args);
        jsonResponse(['transactions'=>array_map('txJson',$rows),'total'=>$total,'limit'=>$limit,'offset'=>$offset]);
    }
    jsonResponse(['error'=>'Method Not Allowed'],405);
} catch(BusinessError $e){jsonResponse(['error'=>$e->getMessage()],$e->status);}catch(Throwable $e){error_log((string)$e);jsonResponse(['error'=>'خطای داخلی سرور'],500);}
