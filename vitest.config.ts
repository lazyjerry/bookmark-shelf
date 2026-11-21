import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// 測試跑在真的 Workers runtime。AI 關閉、帳密是測試專用值，對外 fetch 在測試裡以 vi.spyOn 攔截
export default defineConfig(async () => {
  const migrations = await readD1Migrations('migrations');
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        remoteBindings: false,
        miniflare: {
          bindings: { AUTH_USER: 'admin', AUTH_PASS: 'test-pass', AI_ENABLED: 'false', TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: { setupFiles: ['./test/setup.ts'] },
  };
});
