<?php
declare(strict_types=1);

require_once __DIR__ . '/../src/Database.php';
require_once __DIR__ . '/../src/Auth.php';
require_once __DIR__ . '/../src/Business.php';

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: SAMEORIGIN');
header('Referrer-Policy: strict-origin-when-cross-origin');

function jsonResponse(array $body, int $status = 200): never
{
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function requestBody(): array
{
    $raw = file_get_contents('php://input');
    if ($raw === false || trim($raw) === '') return [];
    $data = json_decode($raw, true);
    if (!is_array($data)) jsonResponse(['error' => 'بدنه درخواست JSON معتبر نیست'], 400);
    return $data;
}

function bearerOrCookieToken(): ?string
{
    if (!empty($_COOKIE['session'])) return (string)$_COOKIE['session'];
    $header = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
    if (preg_match('/^Bearer\s+(.+)$/i', $header, $m)) return $m[1];
    return null;
}

function requireUser(Auth $auth): array
{
    $user = $auth->getSessionUser(bearerOrCookieToken());
    if (!$user) jsonResponse(['error' => 'ورود به سامانه الزامی است'], 401);
    return $user;
}

function setSessionCookie(string $token): void
{
    setcookie('session', $token, [
        'expires' => time() + 43200,
        'path' => '/',
        'secure' => (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off'),
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
}

function clearSessionCookie(): void
{
    setcookie('session', '', [
        'expires' => time() - 3600,
        'path' => '/',
        'secure' => (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off'),
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
}

$db = new Database();
$auth = new Auth($db);
$business = new Business($db);
