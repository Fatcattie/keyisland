import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Vite 构建 + Vitest 测试统一配置。
 * 说明：测试环境统一使用 jsdom（剪贴板与 React 组件测试需要 DOM），
 * WebCrypto 缺失部分由 `vitest.setup.ts` 注入 Node 的 webcrypto 实现。
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // 桌面壳（`npm run desktop:dev`）把 devUrl 写死成 5173，端口被占用时
    // 必须**响亮地失败**，而不是悄悄换到 5174 让 Tauri 一直等一个不存在的服务。
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'es2022',
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    restoreMocks: true,
    clearMocks: true,
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
