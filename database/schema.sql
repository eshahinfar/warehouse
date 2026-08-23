-- Warehouse Management System
-- MySQL 8+ / MariaDB 10.5+ compatible

CREATE TABLE users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  username VARCHAR(191) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  password_salt VARCHAR(255) NULL,
  full_name VARCHAR(255) NOT NULL,
  role VARCHAR(64) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at VARCHAR(64) NOT NULL,
  must_change_password TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (id), UNIQUE KEY uq_users_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE sessions (
  token VARCHAR(255) NOT NULL, user_id BIGINT UNSIGNED NOT NULL,
  created_at VARCHAR(64) NOT NULL, expires_at VARCHAR(64) NOT NULL,
  PRIMARY KEY (token), KEY idx_sessions_user_id (user_id), KEY idx_sessions_expires_at (expires_at),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE products (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, code VARCHAR(191) NOT NULL, name VARCHAR(255) NOT NULL,
  type VARCHAR(64) NOT NULL DEFAULT 'مصرفی', unit VARCHAR(64) NOT NULL, stock INT NOT NULL DEFAULT 0,
  min_stock INT NOT NULL DEFAULT 0, usage_location VARCHAR(255) NULL, shelf VARCHAR(255) NULL,
  description TEXT NULL, created_at VARCHAR(64) NOT NULL, updated_at VARCHAR(64) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1, archived_at VARCHAR(64) NULL,
  PRIMARY KEY (id), UNIQUE KEY uq_products_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE counters (
  kind VARCHAR(64) NOT NULL, value BIGINT NOT NULL DEFAULT 0, PRIMARY KEY (kind)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE transactions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, doc_number VARCHAR(191) NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL, type VARCHAR(64) NOT NULL, quantity INT NOT NULL,
  date VARCHAR(64) NOT NULL, source VARCHAR(255) NULL, po_number VARCHAR(255) NULL,
  requesting_unit VARCHAR(255) NULL, receiver VARCHAR(255) NULL, reason TEXT NULL,
  linked_request_id BIGINT UNSIGNED NULL, returned_by VARCHAR(255) NULL, condition_text TEXT NULL,
  source_doc_id BIGINT UNSIGNED NULL, source_doc_number VARCHAR(191) NULL, description TEXT NULL,
  created_by_user_id BIGINT UNSIGNED NULL, created_at VARCHAR(64) NOT NULL,
  status VARCHAR(64) NOT NULL DEFAULT 'معتبر', voided_at VARCHAR(64) NULL, void_reason TEXT NULL,
  voided_by_user_id BIGINT UNSIGNED NULL, PRIMARY KEY (id), UNIQUE KEY uq_transactions_doc_number (doc_number),
  KEY idx_transactions_product (product_id), KEY idx_transactions_date (date), KEY idx_transactions_status (status),
  KEY idx_transactions_created_by (created_by_user_id), KEY idx_transactions_source_doc_id (source_doc_id),
  KEY idx_transactions_linked_request_id (linked_request_id),
  CONSTRAINT fk_transactions_product FOREIGN KEY (product_id) REFERENCES products(id),
  CONSTRAINT fk_transactions_user FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_transactions_voided_by FOREIGN KEY (voided_by_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE requests (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, doc_number VARCHAR(191) NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL, quantity INT NOT NULL, date VARCHAR(64) NOT NULL,
  priority VARCHAR(64) NOT NULL DEFAULT 'عادی', status VARCHAR(64) NOT NULL DEFAULT 'در انتظار',
  notes TEXT NULL, auto TINYINT(1) NOT NULL DEFAULT 0, created_by_user_id BIGINT UNSIGNED NULL,
  created_at VARCHAR(64) NOT NULL, PRIMARY KEY (id), UNIQUE KEY uq_requests_doc_number (doc_number),
  KEY idx_requests_product (product_id), KEY idx_requests_status (status), KEY idx_requests_created_by (created_by_user_id),
  CONSTRAINT fk_requests_product FOREIGN KEY (product_id) REFERENCES products(id),
  CONSTRAINT fk_requests_user FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE custody_records (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, doc_number VARCHAR(191) NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL, quantity INT NOT NULL, issue_date VARCHAR(64) NOT NULL,
  holder VARCHAR(255) NOT NULL, unit VARCHAR(255) NOT NULL, expected_return VARCHAR(64) NULL,
  condition_out TEXT NULL, notes TEXT NULL, status VARCHAR(64) NOT NULL DEFAULT 'باز',
  return_date VARCHAR(64) NULL, condition_in TEXT NULL, return_notes TEXT NULL, return_doc_number VARCHAR(191) NULL,
  created_by_user_id BIGINT UNSIGNED NULL, created_at VARCHAR(64) NOT NULL, void_reason TEXT NULL,
  PRIMARY KEY (id), UNIQUE KEY uq_custody_doc_number (doc_number), KEY idx_custody_product (product_id),
  KEY idx_custody_status (status), KEY idx_custody_created_by (created_by_user_id),
  CONSTRAINT fk_custody_product FOREIGN KEY (product_id) REFERENCES products(id),
  CONSTRAINT fk_custody_user FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE repair_records (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, doc_number VARCHAR(191) NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL, quantity INT NOT NULL, send_date VARCHAR(64) NOT NULL,
  submitted_by VARCHAR(255) NOT NULL, repair_shop VARCHAR(255) NULL, issue_description TEXT NOT NULL,
  status VARCHAR(64) NOT NULL DEFAULT 'در حال تعمیر', result_date VARCHAR(64) NULL, result TEXT NULL,
  technician VARCHAR(255) NULL, approver VARCHAR(255) NULL, result_notes TEXT NULL,
  result_doc_number VARCHAR(191) NULL, source_custody_id BIGINT UNSIGNED NULL,
  created_by_user_id BIGINT UNSIGNED NULL, created_at VARCHAR(64) NOT NULL, void_reason TEXT NULL,
  PRIMARY KEY (id), UNIQUE KEY uq_repair_doc_number (doc_number), KEY idx_repair_product (product_id),
  KEY idx_repair_status (status), KEY idx_repair_created_by (created_by_user_id),
  CONSTRAINT fk_repair_product FOREIGN KEY (product_id) REFERENCES products(id),
  CONSTRAINT fk_repair_custody FOREIGN KEY (source_custody_id) REFERENCES custody_records(id) ON DELETE SET NULL,
  CONSTRAINT fk_repair_user FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE audit_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, timestamp VARCHAR(64) NOT NULL, action VARCHAR(128) NOT NULL,
  doc_number VARCHAR(191) NULL, change_description TEXT NULL, reason TEXT NULL,
  performed_by_user_id BIGINT UNSIGNED NULL, PRIMARY KEY (id), KEY idx_audit_timestamp (timestamp),
  KEY idx_audit_action (action), KEY idx_audit_doc_number (doc_number),
  CONSTRAINT fk_audit_user FOREIGN KEY (performed_by_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE login_attempts (
  ip VARCHAR(191) NOT NULL, attempts LONGTEXT NOT NULL, blocked_until BIGINT NULL, PRIMARY KEY (ip)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO counters (kind, value) VALUES
('in',0),('out',0),('ret',0),('req',0),('custIssue',0),('custReturn',0),('repIn',0),('repOut',0)
ON DUPLICATE KEY UPDATE value = VALUES(value);
