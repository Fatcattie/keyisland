/**
 * 会话门：按 `client.status()` 分发到设置向导 / 解锁页 / 主面板 + 灵动岛。
 *
 * 两个刷新时机：
 * 1. 启动时读一次状态（决定首屏）；
 * 2. 窗口重新获得焦点时再读一次 —— Web 阶段没有后台定时器，
 *    靠 focus 事件模拟"切回应用时发现已自动锁定"。
 *
 * 另有一个主动锁定时机：页面转入后台时按 FR-01 触发系统锁屏锁定（可关）。
 */

import { useCallback, useEffect, useState } from 'react';
import { useVaultClient } from '../../app/VaultProvider';
import { useToast } from '../../components/ui/Toast';
import { Island } from '../island/Island';
import { IslandWindowChrome } from '../shell/IslandWindowChrome';
import { SetupWizard } from '../setup/SetupWizard';
import { UnlockScreen } from '../unlock/UnlockScreen';
import { MainPanel } from '../vault/MainPanel';
import { describeError } from '../../lib/i18n';
import { shellPort } from '../../services/window-shell';
import { useUiStore } from '../../stores/ui-store';
import type { SessionSnapshot } from '../../core/vault/types';

/** 会话门。 */
export function SessionGate(): JSX.Element {
  const client = useVaultClient();
  const toast = useToast();
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [booted, setBooted] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  // 设置面板开合放在这里：主面板和灵动岛右键菜单都要能开它，共同父级持有
  // 是唯一不引入全局存储的办法（FR-02 右键菜单「设置」项）。
  const [settingsOpen, setSettingsOpen] = useState(false);
  /**
   * 窗口形态（镜像自 Rust）。只影响"渲染哪一层外壳"，不参与任何会话判断：
   * 岛形态下自动锁定、切后台即锁、复制 TTL 全部照旧（PRD CHG-07）。
   */
  const appMode = useUiStore((state) => state.appMode);
  /** 会话状态的唯一写入者（`ShellBridge` 只读它、再单向推给 Rust）。 */
  const setSessionStatus = useUiStore((state) => state.setSessionStatus);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await client.status();
      setSnapshot(next);
      setBootError(null);
    } catch (caught) {
      setBootError(describeError(caught));
    } finally {
      setBooted(true);
    }
  }, [client]);

  /**
   * 锁定前的备份轻提示（PRD FR-06「超过 7 天未备份时，当日首次锁定前轻提示一次」）。
   *
   * "当日只一次"的记账在门面里（`takeBackupReminder`），这里只负责显示；
   * 所有锁定入口（手动 / 系统事件）都调同一个函数，不会出现某个入口漏提醒。
   * 失败静默：提醒不该挡住锁定。
   */
  const remindBackup = useCallback(async (): Promise<void> => {
    try {
      const message = await client.takeBackupReminder();
      if (message !== null) {
        toast(message);
      }
    } catch {
      // 忽略：备份提醒是附属动作。
    }
  }, [client, toast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onFocus = (): void => {
      void refresh();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  /**
   * PRD FR-01「系统锁屏、休眠立即锁定（默认开，可关）」。
   *
   * Web 端**拿不到**操作系统的锁屏 / 休眠事件，`visibilitychange → hidden`
   * 是唯一能同时覆盖这两者的近似信号（系统锁屏或休眠时，页面必然转为 hidden）。
   * 代价是"切到别的标签页"也会触发——方向上是"多锁不漏锁"，对密码库可接受；
   * 嫌烦的用户可以在设置里关掉（默认按 PRD 为开）。
   *
   * 开关判断与空操作都在门面 `lockForSystemEvent()` 里，这里不做二次判断：
   * 监听点越多，各自判断一次就必然有一处写错。
   */
  useEffect(() => {
    const onVisibilityChange = (): void => {
      if (document.visibilityState !== 'hidden') {
        return;
      }
      void client
        .lockForSystemEvent()
        .then((next) => {
          // 只有状态真的变了才换快照。开关关掉时门面会返回一份"什么都没变"的
          // 新快照，照单全收等于每次切标签页都白渲染一次（也会让测试里出现
          // 与用户操作无关的 setState）。
          setSnapshot((previous) =>
            previous !== null && previous.status === next.status ? previous : next,
          );
          if (next.status === 'locked') {
            void remindBackup();
          }
        })
        .catch(() => {
          // 锁定失败不该把用户丢在空白页：退回普通刷新，至少状态是准的。
          void refresh();
        });
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [client, refresh, remindBackup]);

  /**
   * 闲置超时自动锁定：到期点主动 `refresh()` 一次。
   *
   * `session` 的超时判定是"惰性"的——只在 `status()` 被调用时才落锁。
   * 没有这个定时器时，用户把页面开着不动，到期后主面板仍会留在屏幕上
   * （卡片标题/平台照旧可见），直到下一次 focus 或操作才切换成解锁页。
   * 这直接违背"上锁后主面板打不开"：锁确实落了，但 UI 没退场。
   *
   * 这里在 `unlockedUntil` 到期点（+250ms 缓冲，确保 `now >= unlockedUntil`
   * 真的触发落锁）主动查一次状态，让"到期即上锁、主面板收起"在无人操作时也成立。
   * 策略为"不自动锁"时 `unlockedUntil` 为 null，不排定时器。
   */
  useEffect(() => {
    if (
      snapshot === null ||
      snapshot.status !== 'unlocked' ||
      snapshot.unlockedUntil === null
    ) {
      return;
    }
    const delay = Math.max(0, snapshot.unlockedUntil - Date.now()) + 250;
    const timer = window.setTimeout(() => {
      void refresh();
    }, delay);
    return () => {
      window.clearTimeout(timer);
    };
  }, [snapshot, refresh]);

  const handleLock = useCallback(async (): Promise<void> => {
    try {
      setSnapshot(await client.lock('manual'));
      void remindBackup();
    } catch {
      // 锁定失败不应阻塞 UI，下次 focus 会重新同步状态。
      await refresh();
    }
  }, [client, refresh, remindBackup]);

  /**
   * 会话状态镜像进 `ui-store`。
   *
   * 这条 effect 激活了 `setSessionStatus` 这个"声明了很久但没有任何调用点"的
   * action。为什么由会话门来写：它本来就是**唯一**知道最新 `snapshot` 的地方。
   * 让桥自己去 `client.status()` 再读一遍，会额外触发一次惰性落锁判定，
   * 等于多开一个写状态的入口。
   *
   * 岛形态下同样要写：托盘要显示"已锁定/已解锁"，而托盘不知道形态。
   */
  useEffect(() => {
    if (snapshot === null) {
      return;
    }
    setSessionStatus(snapshot.status, snapshot.cooldownUntil);
  }, [snapshot, setSessionStatus]);

  /**
   * 托盘 / 右键菜单的「锁定保险库」→ 执行**同一个**前端锁定动作。
   *
   * 为什么不是 Rust 自己锁：会话（DEK）只在 webview 内存里，Rust 侧没有会话、
   * 也没有密钥（安全不变式 S4）。它只能发一条请求，锁定动作与"点岛内立即锁定"
   * 必须完全同源，否则两条路径的审计与备份提醒会不一致。
   */
  useEffect(() => {
    const shell = shellPort();
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void shell
      .onLockRequested(() => {
        void handleLock();
      })
      .then((off) => {
        if (disposed) {
          off();
          return;
        }
        unlisten = off;
      })
      .catch(() => {
        // 浏览器环境没有这条事件（端口已 no-op）；订阅失败也不该影响会话。
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [handleLock]);

  /** 锁定态下的"去解锁"：岛形态里不在岛上验密，只把主面板叫回来。 */
  const handleRequestUnlock = useCallback((): void => {
    if (useUiStore.getState().appMode === 'island') {
      void shellPort().showMain();
    }
    void refresh();
  }, [refresh]);

  /**
   * 岛形态里打开设置：设置面板挂在 `MainPanel` 里，而主面板在岛形态下是隐藏的。
   * 所以必须**先还原主面板**再开面板，否则用户点了「设置」什么都看不到。
   */
  const handleOpenSettings = useCallback((): void => {
    setSettingsOpen(true);
    if (useUiStore.getState().appMode === 'island') {
      void shellPort().showMain();
    }
  }, []);

  if (!booted) {
    return (
      <div className="flex min-h-full items-center justify-center bg-page">
        <p role="status" className="text-xs text-fg-faint">
          正在准备本地保险库…
        </p>
      </div>
    );
  }

  if (bootError !== null) {
    return (
      <div className="flex min-h-full items-center justify-center bg-page px-4">
        <div className="w-full max-w-md rounded-card border border-red-200 bg-surface p-6 text-center shadow-card">
          <p role="alert" className="text-sm font-semibold text-red-700 dark:text-red-300">
            {bootError}
          </p>
          <button
            type="button"
            onClick={() => void refresh()}
            className="mt-4 rounded-pill bg-accent px-4 py-2 text-xs font-medium text-accent-fg"
          >
            重试
          </button>
        </div>
      </div>
    );
  }

  if (snapshot === null) {
    return (
      <div className="flex min-h-full items-center justify-center bg-page">
        <p role="status" className="text-xs text-fg-faint">
          正在准备本地保险库…
        </p>
      </div>
    );
  }

  if (snapshot.status === 'uninitialized') {
    return <SetupWizard onReady={() => void refresh()} />;
  }

  /**
   * 岛形态（窗口已缩小为 320×44 / 400×460 的小组件）。
   *
   * 两条不可退让的约束：
   *
   * 1. **未锁定时 `MainPanel` 保持挂载**，只加 `hidden` + `aria-hidden`：
   *    编辑中的表单、筛选、滚动位置、`settingsOpen` 都还在，切回全形态时
   *    "恢复原状态"（CHG-02）。条件渲染会把这些统统丢掉。
   * 2. **锁定后不保留主面板**：解锁屏之外不该有任何资产留在 DOM 里
   *    （安全不变式 S5「锁定后不残留资产」）。锁定本来就已经清掉 DEK，
   *    编辑态不再有意义。
   *
   * 注意这个分支必须排在下面 `status !== 'unlocked'` 之前：岛形态下锁定
   * 不该渲染整屏的解锁页——那是全形态的界面，塞进 400px 窗口只会溢出。
   */
  if (appMode === 'island') {
    return (
      <>
        {snapshot.status === 'unlocked' ? (
          <MainPanel
            snapshot={snapshot}
            onSessionChange={setSnapshot}
            settingsOpen={settingsOpen}
            onSettingsOpenChange={setSettingsOpen}
            hidden
          />
        ) : null}
        <IslandWindowChrome
          status={snapshot.status}
          onLock={() => void handleLock()}
          onRequestUnlock={handleRequestUnlock}
          onOpenSettings={handleOpenSettings}
        />
      </>
    );
  }

  if (snapshot.status !== 'unlocked') {
    return <UnlockScreen snapshot={snapshot} onSessionChange={setSnapshot} />;
  }

  return (
    <>
      <MainPanel
        snapshot={snapshot}
        onSessionChange={setSnapshot}
        settingsOpen={settingsOpen}
        onSettingsOpenChange={setSettingsOpen}
      />
      <Island
        status={snapshot.status}
        onLock={() => void handleLock()}
        onRequestUnlock={handleRequestUnlock}
        onOpenSettings={() => setSettingsOpen(true)}
      />
    </>
  );
}
