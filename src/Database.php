<?php
declare(strict_types=1);

/**
 * PDO database layer for the PHP/MySQL migration.
 *
 * Expected environment variables on cPanel:
 *   WAREHOUSE_DB_HOST
 *   WAREHOUSE_DB_PORT (optional, defaults to 3306)
 *   WAREHOUSE_DB_NAME
 *   WAREHOUSE_DB_USER
 *   WAREHOUSE_DB_PASSWORD
 */
final class Database
{
    private PDO $pdo;

    public function __construct()
    {
        $host = getenv('WAREHOUSE_DB_HOST') ?: '127.0.0.1';
        $port = getenv('WAREHOUSE_DB_PORT') ?: '3306';
        $name = getenv('WAREHOUSE_DB_NAME') ?: '';
        $user = getenv('WAREHOUSE_DB_USER') ?: '';
        $password = getenv('WAREHOUSE_DB_PASSWORD') ?: '';

        if ($name === '' || $user === '') {
            throw new RuntimeException('Database configuration is incomplete.');
        }

        $dsn = sprintf(
            'mysql:host=%s;port=%s;dbname=%s;charset=utf8mb4',
            $host,
            $port,
            $name
        );

        $this->pdo = new PDO($dsn, $user, $password, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
            PDO::ATTR_STRINGIFY_FETCHES => false,
        ]);

        $this->pdo->exec("SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci");
    }

    public function pdo(): PDO
    {
        return $this->pdo;
    }

    public function query(string $sql, array $params = []): PDOStatement
    {
        $stmt = $this->pdo->prepare($sql);
        $stmt->execute($params);
        return $stmt;
    }

    public function fetchOne(string $sql, array $params = []): ?array
    {
        $row = $this->query($sql, $params)->fetch();
        return $row === false ? null : $row;
    }

    public function fetchAll(string $sql, array $params = []): array
    {
        return $this->query($sql, $params)->fetchAll();
    }

    public function execute(string $sql, array $params = []): int
    {
        return $this->query($sql, $params)->rowCount();
    }

    public function lastInsertId(): int
    {
        return (int) $this->pdo->lastInsertId();
    }

    public function transaction(callable $callback): mixed
    {
        if ($this->pdo->inTransaction()) {
            return $callback($this);
        }

        $this->pdo->beginTransaction();
        try {
            $result = $callback($this);
            $this->pdo->commit();
            return $result;
        } catch (Throwable $e) {
            if ($this->pdo->inTransaction()) {
                $this->pdo->rollBack();
            }
            throw $e;
        }
    }
}
