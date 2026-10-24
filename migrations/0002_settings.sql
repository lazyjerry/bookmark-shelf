-- 個人設定（key/value）：profile_name 姓名；auth_user、auth_hash 為設定頁更新後的登入帳密
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
