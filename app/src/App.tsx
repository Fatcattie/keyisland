/**
 * 应用入口。
 *
 * 职责只有四件事：
 * 1. 创建唯一一个 `VaultClient`（内存存储 + 浏览器剪贴板）；
 * 2. 桌面壳里先探测启动是否成功，失败则整屏显示原因；
 * 3. 注入 Toast 与 Vault 两个 Provider；
 * 4. 挂载会话门，由它决定显示哪一屏。
 *
 * 这里不持有任何密钥或明文：密码只在各功能组件的本地 state 里短暂存在。
 */

import { useEffect, useRef, useState } from 'react';
import { ToastProvider } from './components/ui/Toast';
import { VaultProvider } from './app/VaultProvider';
import { SessionGate } from './features/session/SessionGate';
import { ShellBridge } from './features/shell/ShellBridge';
import { StartupFailureScreen } from './features/startup/StartupFailureScreen';
import { createVaultClient, type VaultClient } from './services/vault-client';
import { MemoryVaultStorage } from './services/storage';
import {
  TauriVaultStorage,
  isDesktopShell,
  readStartupFailure,
  type StartupFailure,
} from './services/tauri-storage';

export default function App(): JSX.Element {
  const clientRef = useRef<VaultClient | null>(null);
  if (clientRef.current === null) {
    clientRef.current = createVaultClient({
      // 桌面壳里落盘（SQLite + 每值 AES-GCM），浏览器里仍是内存存储——
      // 浏览器版定位是"预览/演示"，不承诺持久化（SDD §0.3 也不许用 localStorage 存密文）。
      storage: isDesktopShell() ? new TauriVaultStorage() : new MemoryVaultStorage(),
      autoLockPolicy: '30m',
    });
  }
  const client = clientRef.current;

  /**
   * 启动状态：`undefined` = 还在探测，`null` = 正常，对象 = 启动失败。
   *
   * 浏览器版没有壳可探测，直接当正常——否则预览页会白屏一秒。
   */
  const [startup, setStartup] = useState<StartupFailure | null | undefined>(
    isDesktopShell() ? undefined : null,
  );

  useEffect(() => {
    if (!isDesktopShell()) {
      return;
    }
    let cancelled = false;
    void readStartupFailure()
      .then((failure) => {
        if (!cancelled) {
          setStartup(failure);
        }
      })
      .catch(() => {
        // 兜底：探测本身抛错也绝不能把应用卡在"正在准备"那一屏。
        // 当成正常启动，后续 `storage_*` 报错会由 SessionGate 的 bootError 接住。
        if (!cancelled) {
          setStartup(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 页面卸载/隐藏时释放会话与剪贴板任务。
  // 注意：不用 effect 的 cleanup，否则 React 严格模式的双挂载会把客户端销毁。
  useEffect(() => {
    const handlePageHide = (): void => {
      void client.dispose();
    };
    window.addEventListener('pagehide', handlePageHide);
    return () => {
      window.removeEventListener('pagehide', handlePageHide);
    };
  }, [client]);

  if (startup === undefined) {
    return (
      <div className="flex min-h-full items-center justify-center bg-zinc-100">
        <p role="status" className="text-xs text-zinc-500">
          正在准备本地保险库…
        </p>
      </div>
    );
  }

  if (startup !== null) {
    // 失败屏自己要用 toast（"打开文件夹失败"），所以仍然包一层 Provider。
    return (
      <ToastProvider>
        <StartupFailureScreen failure={startup} />
      </ToastProvider>
    );
  }

  return (
    <ToastProvider>
      <VaultProvider client={client}>
        {/**
         * 外壳桥挂在 `SessionGate` **外侧**：它只做"窗口形态 / 会话镜像"的
         * 副作用，与"当前该显示哪一屏"无关。挂在里面的话，解锁屏与建库向导
         * 那两条早退分支会把它一起挡掉——而那正是托盘状态最需要正确的时刻。
         */}
        <ShellBridge />
        <SessionGate />
      </VaultProvider>
    </ToastProvider>
  );
}
