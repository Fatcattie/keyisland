import { defineConfig } from 'vitest/config';

/**
 * 安全对抗性测试专用配置（QA 新增，不改动工程师的 `vite.config.ts`）。
 *
 * 为什么单独一份配置：`vite.config.ts` 的 `test.include` 只覆盖 `src/**`，
 * 而对抗性用例按约定放在 `tests/security/`，与业务测试物理隔离，
 * 避免把"验收证据"混进工程师的日常单测目录。
 *
 * 运行：npm run test:security（见 package.json 的脚本说明，或直接 npx vitest run --config vitest.security.config.ts）
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: ['tests/security/**/*.test.ts'],
    restoreMocks: true,
    clearMocks: true,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
