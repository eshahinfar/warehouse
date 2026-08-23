SET NAMES utf8mb4;
SET time_zone = '+00:00';

-- Safe to run on a dedicated EMPTY test database after php/schema.sql.
-- Test credentials are intentionally known and must never be used for production.

INSERT INTO users (username,password_hash,password_salt,full_name,role,active,created_at,must_change_password)
VALUES
('admin.test','$2y$12$9jbjGZEjmHhQTri/8vmWOux91SxybHL/DkQfS7sOEoyqSTDd6R646',NULL,'Test Administrator','مدیر سیستم',1,'2026-08-23T10:00:00Z',0),
('warehouse.test','$2y$12$/y/GsZIEcejlGjgykYj1Bu8Yy/pX0UPN8CZnXdGyTYwIRmFjWFnIm',NULL,'Test Warehouse User','انباردار',1,'2026-08-23T10:00:00Z',0),
('viewer.test','$2y$12$lzW2Ilgh6HPhJiZpwrC.b.SN2o1Dt6CAUA5NfOtd4VRSEsNEyVKRW',NULL,'Test Viewer','ناظر',1,'2026-08-23T10:00:00Z',0)
ON DUPLICATE KEY UPDATE password_hash=VALUES(password_hash),role=VALUES(role),active=1,must_change_password=0;

INSERT INTO products (code,name,type,unit,stock,min_stock,usage_location,shelf,description,active,created_at,updated_at)
VALUES
('TEST-001','آچار فرانسه آزمایشی','قابل‌برگشت','عدد',20,5,'کارگاه مکانیک','A-01','داده آزمایشی برای تست Warehouse',1,'2026-08-23T10:00:00Z','2026-08-23T10:00:00Z'),
('TEST-002','پیچ‌گوشتی آزمایشی','مصرفی','عدد',35,10,'کارگاه مکانیک','A-02','داده آزمایشی',1,'2026-08-23T10:00:00Z','2026-08-23T10:00:00Z'),
('TEST-003','دریل برقی آزمایشی','قابل‌برگشت','عدد',5,2,'کارگاه برق','B-01','داده آزمایشی',1,'2026-08-23T10:00:00Z','2026-08-23T10:00:00Z'),
('TEST-004','متر فلزی آزمایشی','قابل‌برگشت','عدد',12,3,'کنترل کیفیت','B-02','داده آزمایشی',1,'2026-08-23T10:00:00Z','2026-08-23T10:00:00Z')
ON DUPLICATE KEY UPDATE name=VALUES(name),min_stock=VALUES(min_stock),active=1;

INSERT INTO counters(kind,value) VALUES ('in',0),('out',0),('ret',0),('req',0),('custIssue',0),('custReturn',0),('repIn',0),('repOut',0)
ON DUPLICATE KEY UPDATE value=value;

INSERT INTO transactions (doc_number,product_id,type,quantity,date,source,po_number,requesting_unit,receiver,reason,description,status,created_by_user_id,created_at)
SELECT 'TIN-TEST-001',p.id,'ورود',20,'2026-08-23','تست سیستم','PO-TEST-001',NULL,NULL,'موجودی اولیه آزمایشی','ثبت اولیه داده آزمایشی','معتبر',u.id,'2026-08-23T10:01:00Z'
FROM products p JOIN users u ON u.username='admin.test'
WHERE p.code='TEST-001'
AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.doc_number='TIN-TEST-001');

INSERT INTO requests (doc_number,product_id,quantity,date,priority,status,notes,auto,created_by_user_id,created_at)
SELECT 'REQ-TEST-001',p.id,3,'2026-08-23','عادی','در انتظار','درخواست آزمایشی',0,u.id,'2026-08-23T10:02:00Z'
FROM products p JOIN users u ON u.username='warehouse.test'
WHERE p.code='TEST-003'
AND NOT EXISTS (SELECT 1 FROM requests r WHERE r.doc_number='REQ-TEST-001');

INSERT INTO custody_records (doc_number,product_id,quantity,issue_date,holder,unit,expected_return,condition_out,notes,status,created_by_user_id,created_at)
SELECT 'CUS-TEST-001',p.id,1,'2026-08-23','کاربر آزمایشی','مهندسی','2026-08-30','سالم','امانت آزمایشی','باز',u.id,'2026-08-23T10:03:00Z'
FROM products p JOIN users u ON u.username='warehouse.test'
WHERE p.code='TEST-001'
AND NOT EXISTS (SELECT 1 FROM custody_records c WHERE c.doc_number='CUS-TEST-001');

INSERT INTO repair_records (doc_number,product_id,quantity,send_date,submitted_by,repair_shop,issue_description,status,created_by_user_id,created_at)
SELECT 'REP-TEST-001',p.id,1,'2026-08-23','کاربر آزمایشی','کارگاه تعمیرات داخلی','تست فرآیند تعمیر','در حال تعمیر',u.id,'2026-08-23T10:04:00Z'
FROM products p JOIN users u ON u.username='warehouse.test'
WHERE p.code='TEST-003'
AND NOT EXISTS (SELECT 1 FROM repair_records r WHERE r.doc_number='REP-TEST-001');

INSERT INTO audit_log (timestamp,action,doc_number,change_description,reason,performed_by_user_id)
SELECT '2026-08-23T10:05:00Z','ایجاد داده آزمایشی','TEST-SETUP','داده‌های اولیه برای تست cPanel/MySQL ایجاد شد.','QA',u.id
FROM users u WHERE u.username='admin.test';
