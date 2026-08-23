<?php
declare(strict_types=1);
require_once __DIR__ . '/bootstrap.php';

try {
    $user=requireUser($auth); $method=$_SERVER['REQUEST_METHOD']; $body=requestBody();
    if($method==='GET'){
        $rows=$db->all('SELECT * FROM custody_records ORDER BY id DESC');
        $items=array_map(fn($r)=>['id'=>(int)$r['id'],'docNumber'=>$r['doc_number'],'productId'=>(int)$r['product_id'],'quantity'=>(int)$r['quantity'],'issueDate'=>$r['issue_date'],'holder'=>$r['holder'],'unit'=>$r['unit'],'expectedReturn'=>$r['expected_return'],'conditionOut'=>$r['condition_out'],'notes'=>$r['notes'],'status'=>$r['status'],'returnDate'=>$r['return_date'],'conditionIn'=>$r['condition_in'],'returnNotes'=>$r['return_notes'],'returnDocNumber'=>$r['return_doc_number'],'voidReason'=>$r['void_reason']],$rows);
        jsonResponse(['custodyRecords'=>$items]);
    }
    if($method==='POST' && str_ends_with(parse_url($_SERVER['REQUEST_URI']??'',PHP_URL_PATH)?:'','/issue')){
        $pid=(int)($body['productId']??0);$qty=(int)($body['quantity']??0);$date=trim((string)($body['date']??''));$holder=trim((string)($body['holder']??''));$unit=trim((string)($body['unit']??''));$expected=$body['expectedReturn']??null;$condition=$body['conditionOut']??'سالم';$notes=$body['notes']??null;
        if($pid<=0||$qty<=0||$date===''||$holder===''||$unit==='') jsonResponse(['error'=>'اطلاعات امانت ناقص است'],400);
        if($expected && $expected<$date) jsonResponse(['error'=>'موعد بازگشت نمی‌تواند قبل از تاریخ تحویل باشد'],400);
        if(!in_array($condition,['سالم','آسیب‌دیده','نیازمند تعمیر','مفقود'],true)) jsonResponse(['error'=>'وضعیت نامعتبر است'],400);
        $row=$db->transaction(function(Database $db)use($pid,$qty,$date,$holder,$unit,$expected,$condition,$notes,$user){$p=$db->one('SELECT * FROM products WHERE id=? FOR UPDATE',[$pid]);if(!$p)throw new BusinessError('ابزار یافت نشد',404);if(!(int)$p['active'])throw new BusinessError('این ابزار بایگانی شده است');if($p['type']!=='قابل‌برگشت')throw new BusinessError('این کالا از نوع قابل‌برگشت نیست');$snap=(new Business($db))->stockSnapshot($p);if($qty>$snap['available'])throw new BusinessError('موجودی قابل تحویل کافی نیست');$b=new Business($db);$doc=$b->nextDocNumber('custIssue');$now=gmdate('c');$db->execute("INSERT INTO custody_records (doc_number,product_id,quantity,issue_date,holder,unit,expected_return,condition_out,notes,status,created_by_user_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,'باز',?,?)",[$doc,$pid,$qty,$date,$holder,$unit,$expected,$condition,$notes,$user['id'],$now]);return $db->one('SELECT * FROM custody_records WHERE id=?',[$db->lastInsertId()]);});
        jsonResponse(['custodyRecord'=>$row],201);
    }
    jsonResponse(['error'=>'Method Not Allowed'],405);
}catch(BusinessError $e){jsonResponse(['error'=>$e->getMessage()],$e->status);}catch(Throwable $e){error_log('custody.php: '.$e->getMessage());jsonResponse(['error'=>'خطای داخلی سرور'],500);}
