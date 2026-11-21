import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { RATE_LIMITS } from '../src/ratelimit';

// 每個測試檔各自有獨立的 D1，先套用 migrations
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// 速率限制預設關閉：測試會連續寫入。要測限制的在 test/ratelimit.test.ts 自己打開
RATE_LIMITS.draft = 0;
RATE_LIMITS.write = 0;
