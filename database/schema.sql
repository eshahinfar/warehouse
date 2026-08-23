-- Warehouse Management System
-- MySQL 8+ / MariaDB compatible schema
-- Migration target for the PHP/MySQL deployment.

CREATE TABLE users (
    id INTEGER UNSIGNED NOT NULL AUTO_INCREMENT,
    username VARCHAR(64) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(32) NOT NULL,
    display_name VARCHAR(128) NOT NULL,
    must_change_password TINYINT(1) NOT NULL DEFAULT 1,
    active TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_users_username (username),
    KEY idx_users_active (active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE sessions (
    id VARCHAR(128) NOT NULL,
    user_id INTEGER UNSIGNED NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_sessions_user (user_id),
    KEY idx_sessions_expires (expires_at),
    CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE products (
    id INTEGER UNSIGNED NOT NULL AUTO_INCREMENT,
    code VARCHAR(64) NOT NULL,
    name VARCHAR(255) NOT NULL,
    unit VARCHAR(32) NOT NULL,
    quantity DECIMAL(18,3) NOT NULL DEFAULT 0,
    min_quantity DECIMAL(18,3) NOT NULL DEFAULT 0,
    location VARCHAR(128) NULL,
    description TEXT NULL,
    active TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_products_code (code),
    KEY idx_products_name (name),
    KEY idx_products_active (active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE counters (
    kind VARCHAR(64) NOT NULL,
    value BIGINT UNSIGNED NOT NULL DEFAULT 0,
    PRIMARY KEY (kind)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE transactions (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    document_no VARCHAR(64) NOT NULL,
    product_id INTEGER UNSIGNED NOT NULL,
    type VARCHAR(32) NOT NULL,
    quantity DECIMAL(18,3) NOT NULL,
    unit VARCHAR(32) NOT NULL,
    reference VARCHAR(255) NULL,
    description TEXT NULL,
    user_id INTEGER UNSIGNED NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_transactions_document_no (document_no),
    KEY idx_transactions_product (product_id),
    KEY idx_transactions_type (type),
    KEY idx_transactions_user (user_id),
    KEY idx_transactions_created (created_at),
    CONSTRAINT fk_transactions_product FOREIGN KEY (product_id) REFERENCES products(id),
    CONSTRAINT fk_transactions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE requests (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    request_no VARCHAR(64) NOT NULL,
    requester_name VARCHAR(255) NOT NULL,
    department VARCHAR(255) NULL,
    status VARCHAR(32) NOT NULL,
    description TEXT NULL,
    user_id INTEGER UNSIGNED NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_requests_request_no (request_no),
    KEY idx_requests_status (status),
    KEY idx_requests_user (user_id),
    KEY idx_requests_created (created_at),
    CONSTRAINT fk_requests_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE custody_records (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    record_no VARCHAR(64) NOT NULL,
    item_description TEXT NOT NULL,
    quantity DECIMAL(18,3) NOT NULL DEFAULT 1,
    recipient_name VARCHAR(255) NOT NULL,
    department VARCHAR(255) NULL,
    status VARCHAR(32) NOT NULL,
    issued_at DATETIME NULL,
    returned_at DATETIME NULL,
    user_id INTEGER UNSIGNED NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_custody_record_no (record_no),
    KEY idx_custody_status (status),
    KEY idx_custody_user (user_id),
    CONSTRAINT fk_custody_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE repair_records (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    record_no VARCHAR(64) NOT NULL,
    item_description TEXT NOT NULL,
    quantity DECIMAL(18,3) NOT NULL DEFAULT 1,
    status VARCHAR(32) NOT NULL,
    sent_at DATETIME NULL,
    returned_at DATETIME NULL,
    repairer VARCHAR(255) NULL,
    description TEXT NULL,
    user_id INTEGER UNSIGNED NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_repair_record_no (record_no),
    KEY idx_repair_status (status),
    KEY idx_repair_user (user_id),
    CONSTRAINT fk_repair_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE audit_log (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id INTEGER UNSIGNED NULL,
    action VARCHAR(128) NOT NULL,
    entity_type VARCHAR(64) NULL,
    entity_id VARCHAR(64) NULL,
    details JSON NULL,
    ip_address VARCHAR(45) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_audit_user (user_id),
    KEY idx_audit_action (action),
    KEY idx_audit_entity (entity_type, entity_id),
    KEY idx_audit_created (created_at),
    CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE login_attempts (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    username VARCHAR(64) NOT NULL,
    ip_address VARCHAR(45) NOT NULL,
    success TINYINT(1) NOT NULL DEFAULT 0,
    attempted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_login_username_time (username, attempted_at),
    KEY idx_login_ip_time (ip_address, attempted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
