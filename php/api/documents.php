<?php
declare(strict_types=1);
require_once __DIR__ . '/bootstrap.php';

try{
 $user=requireUser($auth);$method=$_SERVER['REQUEST_METHOD'];$body=requestBody();$path=parse_url($_SERVER['REQUEST_URI']??'',PHP_URL_PATH)?:'';
 if(!preg_match('~/api/documents/(\d+)$~',$path,$m))jsonResponse(['error'=>'Not Found'],404);$id=(int)$m[1];
 if($method==='PUT'){
  $reason=trim((string)($body['reason']??''));if($reason==='')jsonResponse(['error'=>'علت تغییر الزامی است'],400);$qty=requiredInt($body['quantity']??0,'تعداد');$date=requiredDate($body['date']??'','تاریخ');$party=$body['party']??null;$desc=$body['description']??null;
  $row=$db->transaction(function(Database $db)use($id,$reason,$qty,$date,$party,$desc,$user){$t=$db->one('SELECT * FROM transactions WHERE id=? FOR UPDATE',[$id]);if(!$t)throw new BusinessError('سند یافت نشد',404);if($t['status']==='باطل')throw new BusinessError('سند باطل‌شده قابل ویرایش نیست');$sign=$t['type']==='خروج'?-1:1;$delta=$sign*($qty-(int)$t['quantity']);if($delta!==0)(new Business($db))->applyStockDelta((int)$t['product_id'],$delta,'این ویرایش');$col=$t['type']==='ورود'?'source':($t['type']==='مرجوعی'?'returned_by':'receiver');$db->execute("UPDATE transactions SET quantity=?,date=?,description=?,{$col}=? WHERE id=?",[$qty,$date,$desc,$party,$id]);(new Business($db))->addAuditEntry(['action'=>'ویرایش سند','docNumber'=>$t['doc_number'],'changeDescription'=>'تعداد/تاریخ/طرف حساب یا توضیحات سند تغییر کرد.','reason'=>$reason,'userId'=>$user['id']]);return $db->one('SELECT * FROM transactions WHERE id=?',[$id]);});
  jsonResponse(['transaction'=>txRow($row)]);
 }
 if($method==='DELETE'){
  $reason=trim((string)($body['reason']??''));if($reason==='')jsonResponse(['error'=>'علت ابطال الزامی است'],400);
  $row=$db->transaction(function(Database $db)use($id,$reason,$user){$t=$db->one('SELECT * FROM transactions WHERE id=? FOR UPDATE',[$id]);if(!$t)throw new BusinessError('سند یافت نشد',404);if($t['status']==='باطل')throw new BusinessError('سند قبلاً باطل شده است');$sign=$t['type']==='خروج'?1:-1;(new Business($db))->applyStockDelta((int)$t['product_id'],$sign*(int)$t['quantity'],'ابطال سند');$now=gmdate('c');$db->execute("UPDATE transactions SET status='باطل',voided_at=?,void_reason=?,voided_by_user_id=? WHERE id=?",[$now,$reason,$user['id'],$id]);(new Business($db))->addAuditEntry(['action'=>'ابطال سند','docNumber'=>$t['doc_number'],'changeDescription'=>'سند '.$t['doc_number'].' باطل شد و اثر موجودی آن برگشت داده شد.','reason'=>$reason,'userId'=>$user['id']]);return $db->one('SELECT * FROM transactions WHERE id=?',[$id]);});
  jsonResponse(['transaction'=>txRow($row)]);
 }
 jsonResponse(['error'=>'Method Not Allowed'],405);
}catch(BusinessError $e){jsonResponse(['error'=>$e->getMessage()],$e->status);}catch(Throwable $e){error_log('documents.php: '.$e->getMessage());jsonResponse(['error'=>'خطای داخلی سرور'],500);}
