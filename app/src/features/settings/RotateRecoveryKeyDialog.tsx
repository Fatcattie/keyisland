/**
 * 重新生成恢复密钥（PRD FR-08.1「怀疑泄露时轮换」）。
 *
 * 两个步骤，顺序不能反：
 * 1. **先验主密码**——拿到已解锁会话的人如果能直接轮换，就等于能把真正的机主
 *    永久锁在门外（旧恢复码作废、新码在他手里）。所以这一步不是"多此一举"，
 *    而是这条路径唯一的授权点。
 * 2. **再展示新恢复码**——只在本次流程内出现一次，不写入任何持久化状态；
 *    必须显式勾选"已离线保存"才算完成，与首次设置的规则一致。
 *
 * 诚实提示：旧恢复码在本操作成功的**那一刻**就失效，没有过渡期。所以警告文案
 * 写在按钮上方而不是折叠在说明里。
 */

import { useState, type FormEvent } from 'react';
import { ShieldAlert } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Field, INPUT_CLASS } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Modal';
import { useToast } from '../../components/ui/Toast';
import { useVaultClient } from '../../app/VaultProvider';
import { describeError } from '../../lib/i18n';
import { downloadTextFile, writeSystemClipboard } from '../../lib/format';
import type { RotateRecoveryKeyResult } from '../../services/vault-client';

export interface RotateRecoveryKeyDialogProps {
  open: boolean;
  onClose: () => void;
}

/** 重新生成恢复密钥对话框。 */
export function RotateRecoveryKeyDialog({ open, onClose }: RotateRecoveryKeyDialogProps): JSX.Element {
  const client = useVaultClient();
  const toast = useToast();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RotateRecoveryKeyResult | null>(null);
  const [saved, setSaved] = useState(false);

  /** 关闭时清空所有本地状态：恢复码不能留在下一次打开的 DOM 里。 */
  const handleClose = (): void => {
    setPassword('');
    setError(null);
    setResult(null);
    setSaved(false);
    setBusy(false);
    onClose();
  };

  const handleRotate = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (password.length === 0 || busy) {
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const next = await client.rotateRecoveryKey(password);
      setPassword('');
      setResult(next);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  };

  const handleCopy = async (): Promise<void> => {
    if (result === null) {
      return;
    }
    const ok = await writeSystemClipboard(result.recoveryCode);
    toast(ok ? '恢复码已复制，请立刻粘贴到离线位置' : '复制失败，请手动抄写');
  };

  const handleDownload = (): void => {
    if (result === null) {
      return;
    }
    const ok = downloadTextFile('keyisland-recovery.kirk', result.kirkJson);
    toast(ok ? '已导出 keyisland-recovery.kirk' : '当前环境不支持下载，请手动抄写恢复码');
  };

  if (result !== null) {
    return (
      <Modal
        open={open}
        title="新的恢复密钥"
        description="旧的恢复码与 .kirk 文件已经失效，请只保存这一份新的。"
        onClose={handleClose}
        footer={
          <>
            <Button variant="secondary" onClick={handleClose}>
              稍后再说
            </Button>
            <Button disabled={!saved} onClick={handleClose}>
              完成
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="rounded-card border border-amber-200 bg-amber-50 dark:border-amber-500/30 dark:bg-amber-500/10 p-3">
            <p className="flex items-start gap-2 text-[11px] leading-5 text-amber-800 dark:text-amber-200">
              <ShieldAlert aria-hidden="true" size={14} className="mt-0.5 shrink-0" />
              恢复码等价于备用钥匙：任何拿到它的人都能重设你的主密码。请抄写到纸上或存进离线位置，
              不要放在这台电脑上。
            </p>
          </div>
          <div>
            <p className="mb-1.5 text-xs font-medium text-fg-muted">你的新恢复码</p>
            <code
              data-testid="rotated-recovery-code"
              className="block select-all break-all rounded-card bg-accent px-3 py-2.5 font-mono text-[11px] leading-5 text-accent-fg"
            >
              {result.recoveryCode}
            </code>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={() => void handleCopy()}>
                复制恢复码
              </Button>
              <Button variant="secondary" size="sm" onClick={handleDownload}>
                下载 .kirk 文件
              </Button>
            </div>
          </div>
          <label className="flex items-start gap-2 text-[11px] leading-5 text-fg-subtle">
            <input
              type="checkbox"
              className="mt-0.5 h-3.5 w-3.5"
              checked={saved}
              onChange={(event) => setSaved(event.target.checked)}
            />
            <span>我已将新的恢复码离线保存，并理解旧的恢复码已无法找回数据</span>
          </label>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      title="重新生成恢复密钥"
      description="怀疑恢复码泄露时用它换一把新的。主密码不受影响。"
      onClose={handleClose}
      footer={
        <Button variant="secondary" onClick={handleClose}>
          取消
        </Button>
      }
    >
      <form
        id="rotate-recovery-form"
        onSubmit={(event) => void handleRotate(event)}
        className="flex flex-col gap-4"
        noValidate
      >
        <div className="rounded-card border border-red-200 bg-red-50 dark:border-red-500/30 dark:bg-red-500/10 p-3">
          <p className="text-[11px] leading-5 text-red-700 dark:text-red-300">
            生成新恢复码后，<strong>旧恢复码与旧 .kirk 文件立即失效</strong>
            ，没有过渡期。请确认新恢复码已经妥善保存后再关闭这个窗口。
          </p>
        </div>
        <Field label="主密码" htmlFor="rotate-recovery-password" required hint="轮换恢复密钥属于高危操作，需要现验主密码">
          <input
            id="rotate-recovery-password"
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
          <p role="alert" className="text-xs font-medium text-red-600 dark:text-red-400">
            {error}
          </p>
        ) : null}
        <Button type="submit" loading={busy} disabled={password.length === 0}>
          生成新的恢复码
        </Button>
      </form>
    </Modal>
  );
}
