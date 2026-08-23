<?php
declare(strict_types=1);
require_once __DIR__ . '/bootstrap.php';

function txRow(array $r): array {
    return ['id'=>(int)$r['id'],'docNumber'=>$r['doc_number'],'productId'=>(int)$r['product_id'],'type'=>$r['type'],'quantity'=>(int)$r['quantity'],'date'=>$r['date'],'source'=>$r['source'],'poNumber'=>$r['po_number'],'requestingUnit'=>$r['requesting_unit'],'receiver'=>$r['receiver'],'reason'=>$r['reason'],'linkedRequestId'=>$r['linked_request_id']!==null?(int)$r['linked_request_id']:null,'returnedBy'=>$r['returned_by'],'condition'=>$r['condition_text'],'sourceDocId'=>$r['source_doc_id']!==null?(int)$r['source_doc_id']:null,'sourceDocNumber'=>$r['source_doc_number'],'description'=>$r['description'],'status'=>$r['status']?:'معتبر','voidedAt'=>$r['voided_at'],'voidReason'=>$r['void_reason'],'createdAt'=>$r['created_at']];
}
function requiredInt(mixed $v,string $label): int { $n=filter_var($v,FILTER_VALIDATE_INT); if($n===false||$n<=0) throw new BusinessError($label.' نامعتبر است'); return (int)$n; }
function requiredDate(mixed $v,string $label): string { $s=trim((string)$v); if(!preg_match('/^\d{4}-\d{2}-\d{2}$/',$s)) throw new BusinessError($label.' نامعتبر است'); return $s; }

try {
    $user=requireUser($auth); $method=$_SERVER['REQUEST_METHOD']; $body=requestBody(); $path=parse_url($_SERVER['REQUEST_URI']??'',PHP_URL_PATH)?:'';

    if($method==='GET' && preg_match('~/api/transactions/?$~',$path)) {
        $where=["t.status='معتبر'"]; $args=[]; $q=$_GET;
        if(($q['includeVoided']??'')==='1'||($q['includeVoided']??'')==='true') $where=["1=1"];
        if(($q['type']??'')!==''){ $where[]='t.type=?';$args[]=$q['type']; }
        if(($q['productId']??'')!==''){ $where[]='t.product_id=?';$args[]=requiredInt($q['productId'],'شناسه کالا'); }
        if(($q['startDate']??'')!==''){ $where[]='t.date>=?';$args[]=requiredDate($q['startDate'],'تاریخ شروع'); }
        if(($q['endDate']??'')!==''){ $where[]='t.date<=?';$args[]=requiredDate($q['endDate'],'تاریخ پایان'); }
        if(($q['search']??'')!==''){ $term='%'.mb_strtolower(trim((string)$q['search']),'UTF-8').'%';$where[]="(LOWER(t.doc_number) LIKE ? OR LOWER(p.name) LIKE ? OR LOWER(p.code) LIKE ? OR LOWER(COALESCE(t.source,'')) LIKE ? OR LOWER(COALESCE(t.receiver,'')) LIKE ? OR LOWER(COALESCE(t.returned_by,'')) LIKE ?)";array_push($args,$term,$term,$term,$term,$term,$term); }
        $w='WHERE '.implode(' AND ',$where);$limit=min(max((int)($q['limit']??50),1),500);$offset=max((int)($q['offset']??0),0);
        $total=(int)($db->one("SELECT COUNT(*) c FROM transactions t LEFT JOIN products p ON p.id=t.product_id $w",$args)['c']??0);
        $rows=$db->all("SELECT t.* FROM transactions t LEFT JOIN products p ON p.id=t.product_id $w ORDER BY t.id DESC LIMIT $limit OFFSET $offset",$args);
        jsonResponse(['transactions'=>array_map('txRow',$rows),'total'=>$total,'limit'=>$limit,'offset'=>$offset]);
    }

    if($method!=='POST') jsonResponse(['error'=>'Method Not Allowed'],405);
    $type=strtolower(basename($path));
    if(!in_array($type,['stock-in','stock-out','returns'],true)) jsonResponse(['error'=>'Not Found'],404);
    $pid=requiredInt($body['productId']??0,'انتخاب کالا');$qty=requiredInt($body['quantity']??0,'تعداد');$date=requiredDate($body['date']??'','تاریخ');

    $result=$db->transaction(function(Database $db)use($type,$pid,$qty,$date,$body,$user){
        $p=$db->one('SELECT * FROM products WHERE id=? FOR UPDATE',[$pid]);if(!$p)throw new BusinessError('کالای انتخاب‌شده معتبر نیست',404);if(!(int)$p['active'])throw new BusinessError('کالای «'.$p['name'].'» بایگانی شده است و سند جدیدی برای آن ثبت نمی‌شود');
        $b=new Business($db);$now=gmdate('c');
        if($type==='stock-in'){$doc=$b->nextDocNumber('in');$source=$body['source']??null;$po=$body['poNumber']??null;$linked=$body['linkedRequestId']??null;$desc=$body['description']??null;$b->applyStockDelta($pid,$qty,'ثبت رسید ورود');$db->execute("INSERT INTO transactions (doc_number,product_id,type,quantity,date,source,po_number,linked_request_id,description,created_by_user_id,created_at) VALUES (?,?, 'ورود',?,?,?,?,?,?,?,?)",[$doc,$pid,$qty,$date,$source,$po,$linked,$desc,$user['id'],$now]);if($linked)$db->execute("UPDATE requests SET status='تأمین شده' WHERE id=? AND status='در انتظار'",[(int)$linked]);}
        elseif($type==='stock-out'){$receiver=trim((string)($body['receiver']??''));$unit=trim((string)($body['requestingUnit']??''));if($receiver===''||$unit==='')throw new BusinessError('نام تحویل‌گیرنده و واحد درخواست‌کننده الزامی است');if((int)$p['stock']<$qty)throw new BusinessError('موجودی کافی نیست. موجودی فعلی «'.$p['name'].'»: '.$p['stock'].' '.$p['unit']);if($p['type']==='قابل‌برگشت' && empty($body['force']))return ['requiresForce'=>true,'error'=>'این کالا از نوع قابل‌برگشت (ابزار/تجهیز امانی) است. برای پیگیری بازگشت، از «امانت ابزار» استفاده کنید.'];$doc=$b->nextDocNumber('out');$b->applyStockDelta($pid,-$qty,'ثبت حواله خروج');$db->execute("INSERT INTO transactions (doc_number,product_id,type,quantity,date,requesting_unit,receiver,reason,description,created_by_user_id,created_at) VALUES (?,?, 'خروج',?,?,?,?,?,?,?)",[$doc,$pid,$qty,$date,$unit,$receiver,$body['reason']??null,$body['description']??null,$user['id'],$now]);}
        else {$returned=trim((string)($body['returnedBy']??''));if($returned==='')throw new BusinessError('نام تحویل‌دهنده الزامی است');$sourceId=$body['sourceDocId']??null;$sourceNo=null;if($sourceId){$src=$db->one('SELECT doc_number FROM transactions WHERE id=?',[(int)$sourceId]);$sourceNo=$src['doc_number']??null;}$doc=$b->nextDocNumber('ret');$b->applyStockDelta($pid,$qty,'ثبت مرجوعی');$db->execute("INSERT INTO transactions (doc_number,product_id,type,quantity,date,returned_by,condition_text,reason,source_doc_id,source_doc_number,description,created_by_user_id,created_at) VALUES (?,?, 'مرجوعی',?,?,?,?,?,?,?,?,?)",[$doc,$pid,$qty,$date,$returned,$body['condition']??null,$body['reason']??null,$sourceId,$sourceNo,$body['description']??null,$user['id'],$now]);}
        return $db->one('SELECT * FROM transactions WHERE id=?',[$db->lastInsertId()]);
    });
    if(isset($result['requiresForce'])) jsonResponse($result,409);
    jsonResponse(['transaction'=>txRow($result)],201);
} catch(BusinessError $e){jsonResponse(['error'=>$e->getMessage()],$e->status);}catch(Throwable $e){error_log('transactions.php: '.$e->getMessage());jsonResponse(['error'=>'خطای داخلی سرور'],500);}
