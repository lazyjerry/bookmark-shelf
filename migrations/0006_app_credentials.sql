-- 應用程式帳密：給程式以 Basic Auth 呼叫書籤 API，在設定頁新增與刪除。
-- 密碼由伺服器產生、只在建立時顯示一次，這裡只存它的 SHA-256
CREATE TABLE app_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- app- 開頭，由伺服器產生
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  -- 最多每小時更新一次
  last_used_at TEXT
);
