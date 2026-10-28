/**
 * 解锁页。
 *
 * 行为约定：
 * - 失败次数只用于"何时显示提示"，真正的冷却与计数由核心层维护；
 * - 冷却期展示倒计时并禁用提交，倒计时归零后主动刷新一次会话状态；
 * - "忘记密码？"进入恢复流程，恢复成功后回到锁定态，必须用新密码解锁。
 */

import { useEffect, useState, type FormEvent } from 'react';
import { KeyRound, Lock } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Field, INPUT_CLASS } from '../../components/ui/Field';
import { useVaultClient } from '../../app/VaultProvider';
import { useCountdown } from '../../lib/hooks';
import { describeError } from '../../lib/i18n';
import { formatCountdown } from '../../lib/format';
import type { LockReason, SessionSnapshot } from '../../core/vault/types';
import { RecoveryFlow } from './RecoveryFlow';

export interface UnlockScreenProps {
  snapshot: SessionSnapshot;
  onSessionChange: (snapshot: SessionSnapshot) => void;
}

/** 显示"密码提示"所需的失败次数。 */
const HINT_THRESHOLD = 2;

/**
 * 锁定原因 → 一句人话。
 *
 * 之前 `LockReason` 只在核心层记着、UI 从不显示，用户超时被锁和手动锁定看到的是
 * 同一个界面——"我明明没锁，怎么就锁了？"FR-01 引入系统锁屏锁定后这个问题更明显
 * （切个标签页回来就锁了），所以必须告诉用户原因。
 */
const LOCK_REASON_TEXT: Record<LockReason, string> = {
  manual: '你刚刚手动锁定了保险库',
  timeout: '超过自动锁定时间，已自动上锁',
  system_lock: '系统锁屏或页面切到后台，已自动上锁',
  suspend: '系统休眠，已自动上锁',
  app_exit: '应用已退出，密钥已清空',
  recovery: '恢复密钥流程结束，已自动上锁',
  auth_cooldown: '连续验证失败次数过多，已上锁并进入冷却',
};

/** 解锁页。 */
export function UnlockScreen({ snapshot, onSessionChange }: UnlockScreenProps): JSX.Element {
  const client = useVaultClient();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [failures, setFailures] = useState(0);
  const [hint, setHint] = useState<string | null>(null);
  const [hintLoaded, setHintLoaded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [showRecovery, setShowRecovery] = useState(false);

  const cooling = snapshot.status === 'cooling_down';
  const remaining = useCountdown(cooling ? snapshot.cooldownUntil : null);

  // 倒计时结束：主动刷新会话状态，让提交按钮恢复可用。
  useEffect(() => {
    if (!cooling || remaining > 0) {
      return;
    }
    let cancelled = false;
    void client.status().then((next) => {
      if (!cancelled) {
        onSessionChange(next);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [client, cooling, remaining, onSessionChange]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (cooling || password.length === 0) {
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const next = await client.unlock(password);
      setPassword('');
      setFailures(0);
      onSessionChange(next);
    } catch (caught) {
      setError(describeError(caught));
      setFailures((previous) => previous + 1);
    } finally {
      setSubmitting(false);
    }
  };

  const handleRevealHint = async (): Promise<void> => {
    if (hintLoaded) {
      return;
    }
    try {
      const value = await client.getPasswordHint();
      setHint(value);
      setHintLoaded(true);
    } catch (caught) {
      setError(describeError(caught));
    }
  };

  if (showRecovery) {
    return (
      <RecoveryFlow
        onCancel={() => setShowRecovery(false)}
        onDone={async () => {
          setShowRecovery(false);
          const next = await client.status();
          onSessionChange(next);
        }}
      />
    );
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-zinc-100 px-4 py-12">
      <main className="w-full max-w-md rounded-card border border-zinc-200 bg-white p-8 shadow-card">
        <header className="mb-6 flex flex-col items-center text-center">
          <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-zinc-900 text-white">
            <Lock aria-hidden="true" size={20} />
          </span>
          <h1 className="text-lg font-semibold text-zinc-900">密岛已锁定</h1>
          <p className="mt-1 text-xs leading-5 text-zinc-500">输入主密码继续使用本地保险库</p>
          {snapshot.lockReason !== null ? (
            <p
              data-testid="lock-reason"
              className="mt-3 rounded-pill bg-zinc-100 px-3 py-1.5 text-[11px] leading-4 text-zinc-600"
            >
              {LOCK_REASON_TEXT[snapshot.lockReason]}
            </p>
          ) : null}
        </header>

        <form onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-4" noValidate>
          <Field label="主密码" htmlFor="unlock-password" required>
            <input
              id="unlock-password"
              type="password"
              autoComplete="current-password"
              className={INPUT_CLASS}
              value={password}
              disabled={cooling}
              onChange={(event) => {
                setPassword(event.target.value);
                setError(null);
              }}
            />
          </Field>

          {cooling ? (
            <p
              role="status"
              className="rounded-pill bg-amber-50 px-3 py-2 text-xs font-medium text-amber-700"
            >
              尝试过于频繁，请在 {formatCountdown(remaining)} 后重试
            </p>
          ) : null}

          {error !== null ? (
            <p role="alert" className="text-xs font-medium text-red-600">
              {error}
            </p>
          ) : null}

          <Button type="submit" loading={submitting} disabled={cooling || password.length === 0}>
            <KeyRound aria-hidden="true" size={14} />
            解锁
          </Button>
        </form>

        <div className="mt-4 flex items-center justify-between text-xs">
          {failures >= HINT_THRESHOLD ? (
            hintLoaded ? null : (
              <button
                type="button"
                onClick={() => void handleRevealHint()}
                className="text-zinc-500 underline decoration-dotted underline-offset-4 hover:text-zinc-800"
              >
                显示提示
              </button>
            )
          ) : (
            <span aria-hidden="true" />
          )}
          <button
            type="button"
            onClick={() => setShowRecovery(true)}
            className="text-zinc-500 underline decoration-dotted underline-offset-4 hover:text-zinc-800"
          >
            忘记密码？
          </button>
        </div>

        {hintLoaded ? (
          <p className="mt-3 rounded-pill bg-zinc-50 px-3 py-2 text-xs leading-5 text-zinc-600">
            {hint === null ? '创建保险库时没有设置密码提示。' : `提示：${hint}`}
          </p>
        ) : null}
      </main>
    </div>
  );
}
