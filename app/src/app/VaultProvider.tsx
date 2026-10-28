/**
 * VaultClient 的 React 注入点。
 *
 * 为什么用 Context 而不是模块级单例：
 * - 测试可以为每个用例注入独立的 client（不同存储、不同注入时钟）；
 * - Phase 1.5 换成 Tauri `invoke` 实现时，只需要替换这一处的实例来源。
 */

import { createContext, useContext, type ReactNode } from 'react';
import type { VaultClient } from '../services/vault-client';

const VaultClientContext = createContext<VaultClient | null>(null);

export interface VaultProviderProps {
  client: VaultClient;
  children: ReactNode;
}

/** 注入 VaultClient。 */
export function VaultProvider({ client, children }: VaultProviderProps): JSX.Element {
  return <VaultClientContext.Provider value={client}>{children}</VaultClientContext.Provider>;
}

/** 取 VaultClient；未注入时直接抛错，避免静默降级成假数据。 */
export function useVaultClient(): VaultClient {
  const client = useContext(VaultClientContext);
  if (client === null) {
    throw new Error('useVaultClient 必须在 VaultProvider 内使用');
  }
  return client;
}
