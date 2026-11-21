import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

// 每個測試檔各自有獨立的 D1，先套用 migrations
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
