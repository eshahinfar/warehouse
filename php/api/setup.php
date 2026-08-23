<?php
declare(strict_types=1);
require_once __DIR__ . '/bootstrap.php';

try {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') jsonResponse(['error'=>'Method Not Allowed'],405);
    $count=(int)($db->one('SELECT COUNT(*) c FROM users')['c'] ?? 0);
    if($count>0) jsonResponse(['error'=>'راه‌اندازی اولیه قبلاً انجام شده است'],409);
    $body=requestBody();
    $username=trim((string)($body['username']??''));
    $fullName=trim((string)($body['fullName']??''));
    $password=(string)($body['password']??'');
    if(!preg_match('/^[A-Za-z0-9._-]{3,60}$/',$username)) jsonResponse(['error'=>'نام کاربری معتبر نیست'],400);
    if($fullName==='') jsonResponse(['error'=>'نام و نام خانوادگی الزامی است'],400);
    if(strlen($password)<8) jsonResponse(['error'=>'رمز عبور باید حداقل ۸ کاراکتر باشد'],400);
    if(strcasecmp($password,$username)===0) jsonResponse(['error'=>'رمز عبور نباید با نام کاربری یکسان باشد'],400);
    $hash=$auth->hashPassword($password);$now=gmdate('c');
    $db->execute("INSERT INTO users (username,password_hash,password_salt,full_name,role,active,created_at,must_change_password) VALUES (?,?,NULL,?,'مدیر سیستم',1,?,0)",[$username,$hash,$fullName,$now]);
    jsonResponse(['ok'=>true,'message'=>'مدیر سیستم اولیه ایجاد شد. اکنون endpoint راه‌اندازی اولیه دیگر قابل استفاده نیست.'],201);
}catch(Throwable $e){error_log('setup.php: '.$e->getMessage());jsonResponse(['error'=>'خطای داخلی سرور'],500);}
