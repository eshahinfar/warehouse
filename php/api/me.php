<?php
declare(strict_types=1);
require_once __DIR__ . '/bootstrap.php';

try {
    $user = requireUser($auth);
    jsonResponse(['user' => $user]);
} catch (Throwable $e) {
    error_log($e->getMessage());
    jsonResponse(['error' => 'خطای داخلی سرور'], 500);
}
