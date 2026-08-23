# Warehouse — cPanel / PHP / MySQL deployment

This branch (`php-mysql-migration`) contains the PHP + MySQL deployment target. Do not deploy the Node/SQLite server to cPanel.

## 1. cPanel requirements

- Apache with `.htaccess` support (`mod_rewrite` enabled)
- PHP 8.1+ (8.2/8.3 recommended)
- PDO and `pdo_mysql`
- MySQL 8.x or MariaDB 10.5+
- HTTPS enabled for `warehouse.mehranhadi.ir`

## 2. Create the database

In cPanel → MySQL Databases:

1. Create a database, e.g. `warehouse_db`.
2. Create a dedicated database user.
3. Give that user **ALL PRIVILEGES** on this database.

In phpMyAdmin, select the new database and import:

`php/schema.sql`

## 3. Upload the application

The public web root should contain the contents of `public/`:

```text
public_html/
├── index.html
├── app.js
├── jalali.js
├── .htaccess
├── api/
└── src/
```

Copy:

- `public/*` → `public_html/`
- `php/api/*` → `public_html/api/`
- `php/src/*` → `public_html/src/`
- `php/config.example.php` → `public_html/config.php`

Do NOT upload the Node.js `src/` directory over the PHP `src/` directory. The PHP classes are under `php/src/`.

## 4. Configure MySQL

Edit `public_html/config.php`:

```php
<?php
return [
    'host' => 'localhost',
    'port' => 3306,
    'name' => 'YOUR_CPANEL_DATABASE',
    'user' => 'YOUR_CPANEL_DATABASE_USER',
    'password' => 'YOUR_DATABASE_PASSWORD',
];
```

Do not commit real credentials to GitHub.

## 5. Create the first administrator

After importing the schema and configuring `config.php`, send one POST request to:

`https://warehouse.mehranhadi.ir/api/setup`

JSON body:

```json
{
  "username": "admin",
  "fullName": "Warehouse Administrator",
  "password": "CHOOSE-A-STRONG-PASSWORD"
}
```

The setup endpoint only works while the `users` table is empty. After the first administrator exists it returns HTTP 409 and cannot create another initial account.

Immediately log in and verify the account.

## 6. First smoke test

Open:

`https://warehouse.mehranhadi.ir/`

Then verify, in order:

1. Login
2. `/api/me`
3. Product list
4. Create a test product
5. Stock-in
6. Stock-out
7. Return
8. Request creation/cancellation
9. Custody issue/return
10. Repair send/complete
11. Dashboard
12. Reports
13. Audit log
14. User management

## 7. Security checks

- HTTPS must be enabled.
- Keep `config.php` out of Git.
- The public `.htaccess` blocks direct access to `/src` and `config.php`.
- The PHP source directory also has its own deny rule.
- Remove or disable the initial setup endpoint after the first administrator is created if your host permits it; it is already inert once any user exists.

## 8. Backup

Use cPanel → Cron Jobs + `mysqldump` if shell access is available, or the host's MySQL backup facility. Backups should be stored outside `public_html` or in a private backup destination.

## 9. Rollback

Keep the current Render deployment running until the cPanel smoke test passes. Only then point the production DNS/domain to the cPanel application.
