<?php
declare(strict_types=1);
require_once __DIR__ . '/bootstrap.php';

try {
    $user = requireUser($auth);
    $roles = [
        ['key'=>'مدیر سیستم','label'=>'مدیر سیستم'],
        ['key'=>'انباردار','label'=>'انباردار'],
        ['key'=>'درخواست‌دهنده','label'=>'درخواست‌دهنده'],
        ['key'=>'ناظر','label'=>'ناظر (فقط مشاهده)'],
    ];
    $permissions = match ($user['role']) {
        'مدیر سیستم' => ['*'],
        'انباردار' => ['products.view','products.edit','stock.in','stock.out','returns.create','custody.manage','repair.manage','requests.view','requests.create','requests.manage','requests.fulfill','reports.view','dashboard.view'],
        'درخواست‌دهنده' => ['products.view','requests.view','requests.create','dashboard.view'],
        'ناظر' => ['products.view','requests.view','reports.view','dashboard.view'],
        default => [],
    };
    $user['fullName'] = $user['full_name'] ?? '';
    unset($user['full_name']);
    jsonResponse(['user'=>$user,'permissions'=>$permissions,'roles'=>$roles,'minPasswordLength'=>8]);
} catch (Throwable $e) {
    error_log($e->getMessage());
    jsonResponse(['error'=>'خطای داخلی سرور'],500);
}
