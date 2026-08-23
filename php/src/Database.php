<?php
declare(strict_types=1);

/**
 * PDO/MySQL database layer for the PHP migration.
 *
 * Configuration is read from environment variables so the same code works
 * on cPanel, local development, and other PHP hosts.
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
        $pass = getenv('WAREHOUSE_DB_PASSWORD') ?: '';

        if ($name === '' || $user === '') {
            throw new RuntimeException('Database configuration is incomplete');
        }

        $dsn = "mysql:host={$host};port={$port};dbname={$name};charset=utf8mb4";
        $this->pdo = new PDO($dsn, $user, $pass, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ]);
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

    public function one(string $sql, array $params = []): ?array
    {
        $row = $this->query($sql, $params)->fetch();
        return $row === false ? null : $row;
    }

    public function all(string $sql, array $params = []): array
    {
        return $this->query($sql, $params)->fetchAll();
    }

    public function execute(string $sql, array $params = []): int
    {
        return $this->query($sql, $params)->rowCount();
    }

    public function lastInsertId(): string
    {
        return $this->pdo->lastInsertId();
    }

    public function begin(): void
    {
        $this->pdo->beginTransaction();
    }

    public function commit(): void
    {
        $this->pdo->commit();
    }

    public function rollback(): void
    {
        if ($this->pdo->inTransaction()) {
            $this->pdo->rollBack();
        }
    }

    /** Run a callback atomically and roll back on any Throwable. */
    public function transaction(callable $callback): mixed
    {
        $this->begin();
        try {
            $result = $callback($this);
            $this->commit();
            return $result;
        } catch (Throwable $e) {
            $this->rollback();
            throw $e;
        }
    }
}
