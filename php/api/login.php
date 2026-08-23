<?php
declare(strict_types=1);
require_once __DIR__ . '/bootstrap.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['error' => 'Method Not Allowed'], 405);
}

try {
    $body = requestBody();
    $username = trim((string)($body['username'] ?? ''));
    $password = (string)($body['password'] ?? '');

    if ($username === '' || $password === '') {
        jsonResponse(['error' => 'نام کاربری و رمز عبور الزامی است'], 400);
    }

    $user = $db->one(
        'SELECT id, username, password_hash, full_name, role, active, must_change_password FROM users WHERE username = ?',
        [$username]
    );

    if (!$user || (int)$user['active'] !== 1 || !password_verify($password, $user['password_hash'])) {
        jsonResponse(['error' => 'نام کاربری یا رمز عبور اشتباه است'], 401);
    }

    $token = $auth->createSession((int)$user['id']);
    setSessionCookie($token);

    $permissions = match ($user['role']) {
        'مدیر سیستم' => ['*'],
        'انباردار' => ['products.view','products.edit','stock.in','stock.out','returns.create','custody.manage','repair.manage','requests.view','requests.create','requests.manage','requests.fulfill','reports.view','dashboard.view'],
        'درخواست‌دهنده' => ['products.view','requests.view','requests.create','dashboard.view'],
        'ناظر' => ['products.view','requests.view','reports.view','dashboard.view'],
        default => [],
    };

    if (password_needs_rehash($user['password_hash'], PASSWORD_DEFAULT)) {
        $newHash = password_hash($password, PASSWORD_DEFAULT);
        $db->execute('UPDATE users SET password_hash = ? WHERE id = ?', [$newHash, $user['id']]);
    }

    jsonResponse([
        'user' => [
            'id' => (int)$user['id'],
            'username' => $user['username'],
            'fullName' => $user['full_name'],
            'role' => $user['role'],
            'mustChangePassword' => (bool)$user['must_change_password'],
        ],
        'permissions' => $permissions,
    ]);
} catch (Throwable $e) {
    error_log('login.php: ' . $e->getMessage());
    jsonResponse(['error' => 'خطای داخلی سرور'], 500);
}
