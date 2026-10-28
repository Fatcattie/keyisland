/**
 * 隐藏卡片授权弹窗。
 *
 * 语义（SDD §5.3 / P2-2）：
 * - 点击侧栏"隐藏卡片"必须二次验证主密码，授权窗口 120 秒；
 * - 授权到期立即退出隐藏视图，并明确告知用户；
 * - 密码错误不发放任何授权，同时显示剩余可试次数（来自会话失败计数）。
 */

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '../../components/ui/Button';
import { Field, INPUT_CLASS } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Modal';
import { useToast } from '../../components/ui/Toast';
import { useVaultClient } from '../../app/VaultProvider';
import { useCountdown } from '../../lib/hooks';
import { describeError } from '../../lib/i18n';
import { formatCountdown } from '../../lib/format';
import { MAX_FAILED_ATTEMPTS } from '../../core/vault/session';
import type { HiddenAccessGrant } from '../../services/vault-client';
import type { ItemSummary } from '../../core/vault/types';

export interface HiddenAccessDialogProps {
  open: boolean;
  onClose: () => void;
  /** 授权成功后把隐藏列表交给父组件渲染。 */
  onGranted: (items: ItemSummary[], grant: HiddenAccessGrant) => void;
  /**
   * 授权到期回调。
   *
   * 父组件必须在这里**清空隐藏列表并退出隐藏视图**——只关闭弹窗的话，
   * 隐藏卡片的标题与账号名会继续留在主面板上。
   * 未提供时退化为 `onClose()`。
   */
  onExpired?: () => void;
  /**
   * 用途，决定弹窗文案与授权后的行为：
   * - `hidden`（默认）：进入"隐藏卡片"分类，授权后展示整组隐藏卡片；
   * - `reveal`：解除某张 `masked` 卡片的遮罩，授权后仅放开字段显示（不切换分类）。
   */
  purpose?: 'hidden' | 'reveal';
  /** 注入时钟，测试可完全控制倒计时。 */
  now?: () => number;
}

/** 授权弹窗。 */
export function HiddenAccessDialog({
  open,
  onClose,
  onGranted,
  onExpired,
  purpose = 'hidden',
  now,
}: HiddenAccessDialogProps): JSX.Element {
  const client = useVaultClient();
  const toast = useToast();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [grant, setGrant] = useState<HiddenAccessGrant | null>(null);
  const [attemptsLeft, setAttemptsLeft] = useState<number | null>(null);

  // 注入时钟放进 ref，保证 `clock` 引用稳定，不会让到期检测的 effect 反复重建。
  const clockRef = useRef(now);
  clockRef.current = now;
  const clock = useCallback((): number => (clockRef.current ?? Date.now)(), []);

  const remaining = useCountdown(grant === null ? null : grant.grantedUntil, clock);

  // 关闭时清空密码，避免下次打开残留。
  useEffect(() => {
    if (!open) {
      setPassword('');
      setError(null);
      setGrant(null);
      setAttemptsLeft(null);
    }
  }, [open]);

  // 授权到期：退出隐藏视图并提示。
  // 直接比较时间戳而不是依赖 `remaining`：授权刚生效的那一次提交里 `remaining`
  // 还是上一帧的 0，用它判断会导致"一授权就过期"。
  useEffect(() => {
    if (grant === null) {
      return;
    }
    const check = (): void => {
      if (clock() < grant.grantedUntil) {
        return;
      }
      setGrant(null);
      toast(purpose === 'reveal' ? '卡片遮罩已恢复' : '隐藏卡片授权已过期');
      // 有 `onExpired` 时由父组件负责关闭弹窗 + 清空隐藏列表；
      // 否则至少要把弹窗关掉，避免停留在一个已失效的授权面板上。
      if (onExpired !== undefined) {
        onExpired();
      } else {
        onClose();
      }
    };
    check();
    const timer = window.setInterval(check, 500);
    return () => {
      window.clearInterval(timer);
    };
  }, [grant, clock, toast, onClose, onExpired]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (password.length === 0) {
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const granted = await client.requestHiddenAccess(password);
      // `reveal` 用途只是解除单张 `masked` 卡片的遮罩，不需要拉取隐藏列表；
      // 只有 `hidden` 用途才去取整组隐藏卡片。
      const hidden = purpose === 'hidden' ? (await client.listItems({ includeHidden: true })).filter((item) => item.visibility === 'hidden') : [];
      setPassword('');
      setGrant(granted);
      setAttemptsLeft(null);
      onGranted(hidden, granted);
    } catch (caught) {
      setError(describeError(caught));
      // 失败计数在核心层维护，这里只做展示。
      try {
        const snapshot = await client.status();
        setAttemptsLeft(Math.max(0, MAX_FAILED_ATTEMPTS - snapshot.passwordFailures));
      } catch {
        setAttemptsLeft(null);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title={purpose === 'reveal' ? '验证以显示卡片' : '访问隐藏卡片'}
      description={
        purpose === 'reveal'
          ? '该卡片的账号与密码已隐藏，验证主密码后可临时显示'
          : '隐藏卡片不进入列表与搜索，需要再次验证主密码'
      }
      onClose={onClose}
      footer={
        <Button variant="secondary" onClick={onClose}>
          关闭
        </Button>
      }
    >
      {grant === null ? (
        <form onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-4" noValidate>
          <Field label="主密码" htmlFor="hidden-access-password" required>
            <input
              id="hidden-access-password"
              type="password"
              autoComplete="current-password"
              className={INPUT_CLASS}
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                setError(null);
              }}
            />
          </Field>
          {error !== null ? (
            <div role="alert" className="text-xs font-medium text-red-600">
              <p>{error}</p>
              {attemptsLeft !== null ? (
                <p className="mt-1 font-normal text-red-500">还可尝试 {attemptsLeft} 次</p>
              ) : null}
            </div>
          ) : null}
          <Button type="submit" loading={submitting} disabled={password.length === 0}>
            验证并查看
          </Button>
        </form>
      ) : (
        <div className="flex flex-col gap-2">
          <p role="status" className="rounded-pill bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-700">
            授权剩余 {formatCountdown(remaining)}
          </p>
          <p className="text-[11px] leading-5 text-zinc-500">
            {purpose === 'reveal'
              ? '已临时解除遮罩，到期后会自动恢复隐藏。'
              : '隐藏列表已展示在主面板中，到期后会自动退出并清除授权。'}
          </p>
        </div>
      )}
    </Modal>
  );
}
