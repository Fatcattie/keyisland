/**
 * 功能层测试脚手架。
 *
 * 原则（团队约定）：测试必须走**真实** `createVaultClient` + `MemoryVaultStorage`
 * + `ARGON2_TEST_PARAMS`，绝不 mock 加密层 —— 否则测不到真实的错误码与状态迁移。
 * 只有两个东西被替换：
 * - 剪贴板端口（jsdom 没有 `navigator.clipboard`）；
 * - 时钟（可注入，避免依赖真实时间）。
 */

import { render, type RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { ToastProvider } from '../../../components/ui/Toast';
import { VaultProvider } from '../../../app/VaultProvider';
import { createVaultClient, type VaultClient } from '../../../services/vault-client';
import { MemoryVaultStorage } from '../../../services/storage';
import { ARGON2_TEST_PARAMS } from '../../../core/crypto/kdf';
import { FakeClipboardPort } from '../../../services/__tests__/support/fakes';
import type { AutoLockPolicy } from '../../../core/vault/types';

/** 满足强度策略的主密码（≥8 位 + 三类字符）。 */
export const MASTER_PASSWORD = 'Alpha-Bravo-7788';

/** 一个必然不匹配的凭据。 */
export const OTHER_PASSWORD = 'Charlie-Delta-9900';

/** 测试用时钟起点：取当前时间，便于 UI 倒计时与真实时间对齐。 */
const BASE_TIME = Date.now();

export interface TestClient {
  client: VaultClient;
  clipboard: FakeClipboardPort;
  now: () => number;
  advance: (ms: number) => void;
}

/** 创建一套完全隔离的 client + 剪贴板替身 + 可控时钟。 */
export function createTestClient(autoLockPolicy: AutoLockPolicy = '30m'): TestClient {
  let current = BASE_TIME;
  const clipboard = new FakeClipboardPort();
  const client = createVaultClient({
    storage: new MemoryVaultStorage(),
    now: () => current,
    clipboard,
    autoLockPolicy,
    clipboardTtlMs: 30_000,
    passwordParams: ARGON2_TEST_PARAMS,
    recoveryParams: ARGON2_TEST_PARAMS,
  });
  return {
    client,
    clipboard,
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

/** 用 Toast + Vault 两个 Provider 包裹后渲染。 */
export function renderWithProviders(client: VaultClient, ui: ReactElement): RenderResult {
  return render(
    <ToastProvider>
      <VaultProvider client={client}>{ui}</VaultProvider>
    </ToastProvider>,
  );
}
