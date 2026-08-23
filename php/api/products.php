<?php
declare(strict_types=1);
require_once __DIR__ . '/bootstrap.php';

try {
    $user = requireUser($auth);
    $method = $_SERVER['REQUEST_METHOD'];
    $id = isset($_GET['id']) ? (int)$_GET['id'] : null;
    $body = in_array($method, ['POST','PUT','DELETE'], true) ? requestBody() : [];

    if ($method === 'GET') {
        $includeArchived = ($_GET['includeArchived'] ?? '') === '1';
        $rows = $includeArchived
            ? $db->all('SELECT * FROM products ORDER BY id DESC')
            : $db->all('SELECT * FROM products WHERE active = 1 ORDER BY id DESC');
        $products = array_map(function(array $row) use ($business): array {
            $snap = $business->stockSnapshot($row);
            return [
                'id'=>(int)$row['id'],'code'=>$row['code'],'name'=>$row['name'],'type'=>$row['type'],
                'unit'=>$row['unit'],'stock'=>(int)$row['stock'],'minStock'=>(int)$row['min_stock'],
                'usageLocation'=>$row['usage_location'],'shelf'=>$row['shelf'],'description'=>$row['description'],
                'inCustody'=>$snap['inCustody'],'inRepair'=>$snap['inRepair'],'available'=>$snap['available'],
                'archived'=>(int)$row['active'] === 0,'status'=>$business->getStockStatus($row)
            ];
        }, $rows);
        jsonResponse(['products'=>$products]);
    }

    if ($method === 'POST') {
        if ($body['code'] === '' || $body['name'] === '' || $body['unit'] === '') jsonResponse(['error'=>'کد، نام و واحد کالا الزامی است'],400);
        $code=trim((string)$body['code']); $name=trim((string)$body['name']); $unit=trim((string)$body['unit']);
        $type=$body['type'] ?? 'مصرفی'; $min=(int)($body['minStock'] ?? 0); $opening=(int)($body['openingStock'] ?? 0);
        if (!in_array($type,['مصرفی','قابل‌برگشت'],true) || $min<0 || $opening<0) jsonResponse(['error'=>'اطلاعات کالا نامعتبر است'],400);
        $date=$body['openingStockDate'] ?? gmdate('Y-m-d');
        if ($opening>0 && $date>gmdate('Y-m-d')) jsonResponse(['error'=>'تاریخ موجودی اولیه نمی‌تواند در آینده باشد'],400);
        $existing=$db->one('SELECT id,active FROM products WHERE code=?',[$code]);
        if($existing) jsonResponse(['error'=>((int)$existing['active']===0?'کالایی با این کد در بایگانی وجود دارد':'این کد کالا قبلاً ثبت شده است')],409);
        $product=$db->transaction(function(Database $db) use($code,$name,$unit,$type,$min,$opening,$date,$body,$user,$business){
            $now=gmdate(DateTimeInterface::ATOM);
            $db->execute('INSERT INTO products (code,name,type,unit,stock,min_stock,usage_location,shelf,description,created_at,updated_at,active) VALUES (?,?,?,?,?,?,?,?,?,?,?,1)',[$code,$name,$type,$unit,$opening,$min,$body['usageLocation']??null,$body['shelf']??null,$body['description']??null,$now,$now]);
            $id=(int)$db->lastInsertId();
            if($opening>0){$doc=$business->nextDocNumber('in');$db->execute("INSERT INTO transactions (doc_number,product_id,type,quantity,date,source,description,created_by_user_id,created_at) VALUES (?,?,'ورود',?,?,?, 'موجودی اولیه هنگام تعریف کالا',?,?)",[$doc,$id,$opening,$date,'-',$user['id'],$now]);}
            return $db->one('SELECT * FROM products WHERE id=?',[$id]);
        });
        $snap=$business->stockSnapshot($product);
        jsonResponse(['product'=>['id'=>(int)$product['id'],'code'=>$product['code'],'name'=>$product['name'],'type'=>$product['type'],'unit'=>$product['unit'],'stock'=>(int)$product['stock'],'minStock'=>(int)$product['min_stock'],'usageLocation'=>$product['usage_location'],'shelf'=>$product['shelf'],'description'=>$product['description'],'inCustody'=>$snap['inCustody'],'inRepair'=>$snap['inRepair'],'available'=>$snap['available'],'archived'=>false,'status'=>$business->getStockStatus($product)]],201);
    }

    if (!$id) jsonResponse(['error'=>'شناسه کالا الزامی است'],400);
    $product=$db->one('SELECT * FROM products WHERE id=?',[$id]);
    if(!$product) jsonResponse(['error'=>'کالا یافت نشد'],404);

    if($method==='PUT'){
        $code=trim((string)($body['code']??''));$name=trim((string)($body['name']??''));$unit=trim((string)($body['unit']??''));$type=$body['type']??'مصرفی';$min=(int)($body['minStock']??0);
        if($code===''||$name===''||$unit===''||!in_array($type,['مصرفی','قابل‌برگشت'],true)||$min<0) jsonResponse(['error'=>'اطلاعات کالا نامعتبر است'],400);
        $dup=$db->one('SELECT id FROM products WHERE code=? AND id!=?',[$code,$id]); if($dup) jsonResponse(['error'=>'این کد کالا قبلاً برای کالای دیگری ثبت شده است'],409);
        if($product['type']==='قابل‌برگشت' && $type!=='قابل‌برگشت'){ $open=$db->one("SELECT COUNT(*) c FROM custody_records WHERE product_id=? AND status='باز'",[$id]); if((int)$open['c']>0) jsonResponse(['error'=>'این کالا امانت باز دارد؛ نوع کالا قابل تغییر نیست'],400); }
        $db->execute('UPDATE products SET code=?,name=?,type=?,unit=?,min_stock=?,usage_location=?,shelf=?,description=?,updated_at=? WHERE id=?',[$code,$name,$type,$unit,$min,$body['usageLocation']??null,$body['shelf']??null,$body['description']??null,gmdate(DateTimeInterface::ATOM),$id]);
        $row=$db->one('SELECT * FROM products WHERE id=?',[$id]);$snap=$business->stockSnapshot($row);
        jsonResponse(['product'=>['id'=>(int)$row['id'],'code'=>$row['code'],'name'=>$row['name'],'type'=>$row['type'],'unit'=>$row['unit'],'stock'=>(int)$row['stock'],'minStock'=>(int)$row['min_stock'],'usageLocation'=>$row['usage_location'],'shelf'=>$row['shelf'],'description'=>$row['description'],'inCustody'=>$snap['inCustody'],'inRepair'=>$snap['inRepair'],'available'=>$snap['available'],'archived'=>(int)$row['active']===0,'status'=>$business->getStockStatus($row)]]);
    }

    if($method==='DELETE'){
        $reason=trim((string)($body['reason']??''));if($reason==='') jsonResponse(['error'=>'دلیل عملیات الزامی است'],400);
        $counts=[];foreach(['transactions','requests','custody_records','repair_records'] as $t){$r=$db->one("SELECT COUNT(*) c FROM $t WHERE product_id=?",[$id]);$counts[$t]=(int)$r['c'];}
        $open=$db->one("SELECT COUNT(*) c FROM custody_records WHERE product_id=? AND status='باز'",[$id]);if((int)$open['c']>0)jsonResponse(['error'=>'این کالا امانت تسویه‌نشده دارد'],400);
        $total=array_sum($counts);
        if($total===0){$db->execute('DELETE FROM products WHERE id=?',[$id]);$business->addAuditEntry(['action'=>'حذف کالا','docNumber'=>$product['code'],'changeDescription'=>'کالا حذف شد.','reason'=>$reason,'userId'=>$user['id']]);jsonResponse(['ok'=>true,'mode'=>'deleted']);}
        $now=gmdate(DateTimeInterface::ATOM);$db->execute('UPDATE products SET active=0,archived_at=?,updated_at=? WHERE id=?',[$now,$now,$id]);$business->addAuditEntry(['action'=>'بایگانی کالا','docNumber'=>$product['code'],'changeDescription'=>'کالا بایگانی شد و اسناد حفظ شدند.','reason'=>$reason,'userId'=>$user['id']]);jsonResponse(['ok'=>true,'mode'=>'archived','relatedDocuments'=>$total]);
    }

    if($method==='PATCH' || ($method==='POST' && ($_GET['action']??'')==='restore')){
        $db->execute('UPDATE products SET active=1,archived_at=NULL,updated_at=? WHERE id=?',[gmdate(DateTimeInterface::ATOM),$id]);jsonResponse(['ok'=>true]);
    }
    jsonResponse(['error'=>'Method Not Allowed'],405);
} catch (BusinessError $e) { jsonResponse(['error'=>$e->getMessage()],$e->status); }
catch(Throwable $e){ error_log((string)$e); jsonResponse(['error'=>'خطای داخلی سرور'],500); }
