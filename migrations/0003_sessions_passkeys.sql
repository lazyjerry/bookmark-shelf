-- 瀏覽器登入的 Session：Cookie 裡是原始 token，這裡只存它的 SHA-256
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  -- password / passkey
  method TEXT NOT NULL,
  user_agent TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  -- 30 天，使用中每天往後延一次
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_sessions_expires ON sessions (expires_at);

-- Passkey（WebAuthn）憑證
CREATE TABLE passkeys (
  -- credential ID（base64url）
  id TEXT PRIMARY KEY,
  -- COSE 公鑰（base64url）
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]',
  name TEXT NOT NULL DEFAULT '',
  -- 是否同步到雲端（iCloud 鑰匙圈、Google 密碼管理工具）
  backed_up INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

-- WebAuthn challenge：只能用一次，5 分鐘內有效
CREATE TABLE auth_challenges (
  challenge TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('register', 'login')),
  expires_at TEXT NOT NULL
);
