import { defineConfig } from 'vitest/config';

/**
 * 性能对照专用配置（任务 5）：不进 `npm run verify`，避免慢用例拖累日常单测。
 *
 * 运行：npm run perf:items
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/perf/**/*.perf.ts'],
    testTimeout: 600_000,
  },
});
