<?php
declare(strict_types=1);
require_once __DIR__ . '/bootstrap.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['error' => 'Method Not Allowed'], 405);
}

try {
    $token = bearerOrCookieToken();
    if ($token) $auth->destroySession($token);
    clearSessionCookie();
    jsonResponse(['ok' => true]);
} catch (Throwable $e) {
    error_log('logout.php: ' . $e->getMessage());
    jsonResponse(['error' => 'خطای داخلی سرور'], 500);
}
