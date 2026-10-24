-- 帳密改為只由環境變數 AUTH_USER／AUTH_PASS 設定，清掉設定頁存過的帳密
DELETE FROM settings WHERE key IN ('auth_user', 'auth_hash');
