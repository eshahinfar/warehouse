<?php
declare(strict_types=1);

final class Auth
{
    private const SESSION_DURATION_SECONDS = 43200; // 12 hours
    private Database $db;

    public function __construct(Database $db)
    {
        $this->db = $db;
    }

    public function hashPassword(string $password): array
    {
        $salt = random_bytes(16);
        $hash = hash('sha512', $salt . $password);
        return [bin2hex($hash), bin2hex($salt)];
    }

    public function verifyPassword(string $password, string $storedHash, string $storedSalt): bool
    {
        $hash = hash('sha512', hex2bin($storedSalt) . $password);
        return hash_equals($storedHash, $hash);
    }

    public function createSession(int $userId): string
    {
        $token = bin2hex(random_bytes(32));
        $now = new DateTimeImmutable('now', new DateTimeZone('UTC'));
        $expires = $now->modify('+' . self::SESSION_DURATION_SECONDS . ' seconds');

        $this->db->execute(
            'INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
            [$token, $userId, $now->format(DateTimeInterface::ATOM), $expires->format(DateTimeInterface::ATOM)]
        );

        return $token;
    }

    public function getSessionUser(?string $token): ?array
    {
        if (!$token) return null;

        $session = $this->db->one('SELECT * FROM sessions WHERE token = ?', [$token]);
        if (!$session) return null;

        if (strtotime($session['expires_at']) < time()) {
            $this->destroySession($token);
            return null;
        }

        $user = $this->db->one(
            'SELECT id, username, full_name, role, active, must_change_password FROM users WHERE id = ?',
            [$session['user_id']]
        );

        return ($user && (int)$user['active'] === 1) ? $user : null;
    }

    public function destroySession(string $token): void
    {
        $this->db->execute('DELETE FROM sessions WHERE token = ?', [$token]);
    }

    public function cleanupExpiredSessions(): void
    {
        $this->db->execute('DELETE FROM sessions WHERE expires_at < ?', [gmdate(DateTimeInterface::ATOM)]);
    }
}
