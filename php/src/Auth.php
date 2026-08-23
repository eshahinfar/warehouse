<?php
declare(strict_types=1);

final class Auth
{
    private const SESSION_DURATION_SECONDS = 43200; // 12 hours

    public function __construct(private Database $db)
    {
    }

    public function hashPassword(string $password): string
    {
        $hash = password_hash($password, PASSWORD_DEFAULT);
        if ($hash === false) {
            throw new RuntimeException('Password hashing failed');
        }
        return $hash;
    }

    public function verifyPassword(string $password, string $storedHash): bool
    {
        return password_verify($password, $storedHash);
    }

    public function needsRehash(string $storedHash): bool
    {
        return password_needs_rehash($storedHash, PASSWORD_DEFAULT);
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
            'SELECT id, username, full_name, role, active, must_change_password, password_hash FROM users WHERE id = ?',
            [$session['user_id']]
        );

        if (!$user || (int)$user['active'] !== 1) return null;
        unset($user['password_hash']);
        return $user;
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
