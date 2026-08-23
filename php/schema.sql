SET NAMES utf8mb4;
SET time_zone = '+00:00';

CREATE TABLE IF NOT EXISTS users (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  username VARCHAR(60) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  password_salt VARCHAR(255) NULL,
  full_name VARCHAR(160) NOT NULL,
  role VARCHAR(60) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at VARCHAR(40) NOT NULL,
  must_change_password TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (id), UNIQUE KEY uq_users_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sessions (
  token CHAR(64) NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  created_at VARCHAR(40) NOT NULL,
  expires_at VARCHAR(40) NOT NULL,
  PRIMARY KEY (token), KEY idx_sessions_user (user_id),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS products (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  code VARCHAR(100) NOT NULL,
  name VARCHAR(255) NOT NULL,
  type VARCHAR(60) NOT NULL DEFAULT 'مصرفی',
  unit VARCHAR(60) NOT NULL,
  stock INT NOT NULL DEFAULT 0,
  min_stock INT NOT NULL DEFAULT 0,
  usage_location VARCHAR(255) NULL,
  shelf VARCHAR(120) NULL,
  description TEXT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  archived_at VARCHAR(40) NULL,
  created_at VARCHAR(40) NOT NULL,
  updated_at VARCHAR(40) NOT NULL,
  PRIMARY KEY (id), UNIQUE KEY uq_products_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS counters (
  kind VARCHAR(30) NOT NULL,
  value INT NOT NULL DEFAULT 0,
  PRIMARY KEY (kind)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO counters(kind,value) VALUES ('in',0),('out',0),('ret',0),('req',0),('custIssue',0),('custReturn',0),('repIn',0),('repOut',0);

CREATE TABLE IF NOT EXISTS transactions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  doc_number VARCHAR(60) NOT NULL,
  product_id INT UNSIGNED NOT NULL,
  type VARCHAR(30) NOT NULL,
  quantity INT NOT NULL,
  date DATE NOT NULL,
  source VARCHAR(255) NULL,
  po_number VARCHAR(100) NULL,
  requesting_unit VARCHAR(255) NULL,
  receiver VARCHAR(255) NULL,
  reason VARCHAR(500) NULL,
  linked_request_id BIGINT UNSIGNED NULL,
  returned_by VARCHAR(255) NULL,
  condition_text VARCHAR(255) NULL,
  source_doc_id BIGINT UNSIGNED NULL,
  source_doc_number VARCHAR(60) NULL,
  description TEXT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'معتبر',
  voided_at VARCHAR(40) NULL,
  void_reason VARCHAR(500) NULL,
  voided_by_user_id INT UNSIGNED NULL,
  created_by_user_id INT UNSIGNED NULL,
  created_at VARCHAR(40) NOT NULL,
  PRIMARY KEY (id), UNIQUE KEY uq_transactions_doc (doc_number),
  KEY idx_tx_product (product_id), KEY idx_tx_date (date), KEY idx_tx_status (status),
  CONSTRAINT fk_tx_product FOREIGN KEY (product_id) REFERENCES products(id),
  CONSTRAINT fk_tx_user FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_tx_void_user FOREIGN KEY (voided_by_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS requests (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  doc_number VARCHAR(60) NOT NULL,
  product_id INT UNSIGNED NOT NULL,
  quantity INT NOT NULL,
  date DATE NOT NULL,
  priority VARCHAR(30) NOT NULL DEFAULT 'عادی',
  status VARCHAR(40) NOT NULL DEFAULT 'در انتظار',
  notes TEXT NULL,
  auto TINYINT(1) NOT NULL DEFAULT 0,
  created_by_user_id INT UNSIGNED NULL,
  created_at VARCHAR(40) NOT NULL,
  PRIMARY KEY(id), UNIQUE KEY uq_requests_doc(doc_number), KEY idx_req_product(product_id),
  CONSTRAINT fk_req_product FOREIGN KEY(product_id) REFERENCES products(id),
  CONSTRAINT fk_req_user FOREIGN KEY(created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS custody_records (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  doc_number VARCHAR(60) NOT NULL,
  product_id INT UNSIGNED NOT NULL,
  quantity INT NOT NULL,
  issue_date DATE NOT NULL,
  holder VARCHAR(255) NOT NULL,
  unit VARCHAR(255) NOT NULL,
  expected_return DATE NULL,
  condition_out VARCHAR(100) NULL,
  notes TEXT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'باز',
  return_date DATE NULL,
  condition_in VARCHAR(100) NULL,
  return_notes TEXT NULL,
  return_doc_number VARCHAR(60) NULL,
  void_reason VARCHAR(500) NULL,
  created_by_user_id INT UNSIGNED NULL,
  created_at VARCHAR(40) NOT NULL,
  PRIMARY KEY(id), UNIQUE KEY uq_custody_doc(doc_number), KEY idx_custody_product(product_id),
  CONSTRAINT fk_custody_product FOREIGN KEY(product_id) REFERENCES products(id),
  CONSTRAINT fk_custody_user FOREIGN KEY(created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS repair_records (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  doc_number VARCHAR(60) NOT NULL,
  product_id INT UNSIGNED NOT NULL,
  quantity INT NOT NULL,
  send_date DATE NOT NULL,
  submitted_by VARCHAR(255) NOT NULL,
  repair_shop VARCHAR(255) NULL,
  issue_description TEXT NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'در حال تعمیر',
  result_date DATE NULL,
  result VARCHAR(100) NULL,
  technician VARCHAR(255) NULL,
  approver VARCHAR(255) NULL,
  result_notes TEXT NULL,
  result_doc_number VARCHAR(60) NULL,
  source_custody_id BIGINT UNSIGNED NULL,
  void_reason VARCHAR(500) NULL,
  created_by_user_id INT UNSIGNED NULL,
  created_at VARCHAR(40) NOT NULL,
  PRIMARY KEY(id), UNIQUE KEY uq_repair_doc(doc_number), KEY idx_repair_product(product_id),
  CONSTRAINT fk_repair_product FOREIGN KEY(product_id) REFERENCES products(id),
  CONSTRAINT fk_repair_custody FOREIGN KEY(source_custody_id) REFERENCES custody_records(id) ON DELETE SET NULL,
  CONSTRAINT fk_repair_user FOREIGN KEY(created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  timestamp VARCHAR(40) NOT NULL,
  action VARCHAR(255) NOT NULL,
  doc_number VARCHAR(100) NULL,
  change_description TEXT NULL,
  reason TEXT NULL,
  performed_by_user_id INT UNSIGNED NULL,
  PRIMARY KEY(id), KEY idx_audit_time(id),
  CONSTRAINT fk_audit_user FOREIGN KEY(performed_by_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS login_attempts (
  ip VARCHAR(100) NOT NULL,
  attempts TEXT NOT NULL,
  blocked_until BIGINT NULL,
  PRIMARY KEY(ip)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
