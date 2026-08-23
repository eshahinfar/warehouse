<?php
declare(strict_types=1);
require_once __DIR__ . '/bootstrap.php';

try {
 $user=requireUser($auth); if($user['role']!=='مدیر سیستم')jsonResponse(['error'=>'دسترسی غیرمجاز'],403);$path=parse_url($_SERVER['REQUEST_URI']??'',PHP_URL_PATH)?:'';
 if($path==='/api/maintenance/stock-check'){$diffs=$business->stockDiscrepancies();jsonResponse(['discrepancies'=>$diffs,'ok'=>count($diffs)===0,'message'=>count($diffs)===0?'موجودی همه‌ی کالاها با دفتر اسناد مطابقت دارد.':count($diffs).' کالا با دفتر اسناد اختلاف دارد.']);}
 if($path==='/api/maintenance/stock-repair'&&$_SERVER['REQUEST_METHOD']==='POST'){$fixed=$business->repairStockFromLedger((int)$user['id']);jsonResponse(['fixedCount'=>count($fixed),'fixed'=>$fixed,'message'=>count($fixed)===0?'اختلافی برای اصلاح یافت نشد.':'موجودی '.count($fixed).' کالا با دفتر اسناد هم‌تراز شد (شرح کامل در لاگ حسابرسی ثبت شد).']);}
 jsonResponse(['error'=>'Not Found'],404);
}catch(BusinessError $e){jsonResponse(['error'=>$e->getMessage()],$e->status);}catch(Throwable $e){error_log('maintenance.php: '.$e->getMessage());jsonResponse(['error'=>'خطای داخلی سرور'],500);}
