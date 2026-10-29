/**
 * 首次设置向导：主密码 → 提示语 → 恢复密钥。
 *
 * 关键安全点：
 * - 强度校验与 `assertMasterPassword` 使用同一套规则，前端不会放行弱密码；
 * - 恢复码只在本次流程内展示，**不写入任何持久化状态**；
 * - 必须显式勾选"已离线保存"才能完成，避免用户直接跳过导致数据不可恢复。
 */

import { useState, type FormEvent } from 'react';
import { ShieldAlert } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Field, INPUT_CLASS, TEXTAREA_CLASS } from '../../components/ui/Field';
import { PasswordStrength } from '../../components/ui/PasswordStrength';
import { useToast } from '../../components/ui/Toast';
import { useVaultClient } from '../../app/VaultProvider';
import { assessMasterPassword } from '../../core/vault/policy';
import { describeError, t } from '../../lib/i18n';
import { downloadTextFile, writeSystemClipboard } from '../../lib/format';
import type { InitializeVaultResult } from '../../services/vault-client';

/** 步骤编号。 */
type Step = 1 | 2 | 3;

export interface SetupWizardProps {
  /** 初始化成功后回调，由 SessionGate 重新读取状态。 */
  onReady: () => void;
}

/** 首次设置向导。 */
export function SetupWizard({ onReady }: SetupWizardProps): JSX.Element {
  const client = useVaultClient();
  const toast = useToast();

  const [step, setStep] = useState<Step>(1);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [hint, setHint] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<InitializeVaultResult | null>(null);
  const [saved, setSaved] = useState(false);

  const handleStepOne = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setError(null);
    if (password.length === 0) {
      setError('请先设置主密码');
      return;
    }
    if (password !== confirm) {
      setError('两次输入的主密码不一致');
      return;
    }
    // 强度不足时留在第 1 步，并给出具体原因（不是简单置灰按钮）。
    const strength = assessMasterPassword(password);
    if (!strength.acceptable) {
      const reasons = strength.reasons.map((reason) => t(reason, '请加强密码')).join('；');
      setError(`主密码强度不足：${reasons}`);
      return;
    }
    setStep(2);
  };

  const handleStepTwo = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const created = await client.initialize({
        masterPassword: password,
        hint: hint.trim().length === 0 ? null : hint.trim(),
      });
      setResult(created);
      setStep(3);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const handleCopyCode = async (): Promise<void> => {
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

  return (
    <div className="flex min-h-full items-center justify-center bg-page px-4 py-12">
      <main className="w-full max-w-xl rounded-card border border-line bg-surface p-8 shadow-card">
        <header className="mb-6">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-fg-faint">
            第 {step} / 3 步
          </p>
          <h1 className="mt-1 text-xl font-semibold text-fg">
            {step === 1 ? '设置主密码' : step === 2 ? '设置密码提示' : '保存恢复密钥'}
          </h1>
          <p className="mt-2 text-xs leading-5 text-fg-faint">
            {step === 1
              ? '主密码用于解密本地保险库，密岛不会保存它，也无法帮你找回。'
              : step === 2
                ? '提示语只用于帮助你回忆密码，会在解锁页按需显示。'
                : '恢复码是主密码遗忘时唯一的找回途径，请离线保存。'}
          </p>
        </header>

        {step === 1 ? (
          <form onSubmit={handleStepOne} className="flex flex-col gap-4" noValidate>
            <Field label="主密码" htmlFor="setup-password" required hint="至少 8 位，且包含两类字符">
              <input
                id="setup-password"
                type="password"
                autoComplete="new-password"
                className={INPUT_CLASS}
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  setError(null);
                }}
                aria-describedby="setup-strength"
              />
            </Field>
            <div id="setup-strength">
              <PasswordStrength password={password} />
            </div>
            <Field label="再次输入主密码" htmlFor="setup-confirm" required>
              <input
                id="setup-confirm"
                type="password"
                autoComplete="new-password"
                className={INPUT_CLASS}
                value={confirm}
                onChange={(event) => {
                  setConfirm(event.target.value);
                  setError(null);
                }}
              />
            </Field>
            {error !== null ? (
              <p role="alert" className="text-xs font-medium text-red-600 dark:text-red-400">
                {error}
              </p>
            ) : null}
            <Button type="submit" disabled={password.length === 0}>
              下一步
            </Button>
          </form>
        ) : null}

        {step === 2 ? (
          <form onSubmit={(event) => void handleStepTwo(event)} className="flex flex-col gap-4" noValidate>
            <Field
              label="密码提示（可留空）"
              htmlFor="setup-hint"
              hint="不要写密码本身，只写能让你想起它的线索"
            >
              <textarea
                id="setup-hint"
                className={TEXTAREA_CLASS}
                value={hint}
                onChange={(event) => setHint(event.target.value)}
                placeholder="例如：常用的那句歌词首字母"
              />
            </Field>
            {error !== null ? (
              <p role="alert" className="text-xs font-medium text-red-600 dark:text-red-400">
                {error}
              </p>
            ) : null}
            <div className="flex items-center gap-2">
              <Button variant="secondary" onClick={() => setStep(1)}>
                上一步
              </Button>
              <Button type="submit" loading={submitting}>
                创建保险库
              </Button>
            </div>
          </form>
        ) : null}

        {step === 3 && result !== null ? (
          <div className="flex flex-col gap-4">
            <div className="rounded-card border border-amber-200 bg-amber-50 dark:border-amber-500/30 dark:bg-amber-500/10 p-4">
              <p className="flex items-center gap-2 text-xs font-semibold text-amber-800 dark:text-amber-200">
                <ShieldAlert aria-hidden="true" size={14} />
                恢复码丢失 + 主密码遗忘 = 数据不可恢复
              </p>
              <p className="mt-1.5 text-[11px] leading-5 text-amber-700 dark:text-amber-300">
                恢复码等价于备用钥匙，任何拿到它的人都能重设你的主密码。请抄写到纸上或存进离线密码管理器，
                不要截图、不要发到聊天工具里。
              </p>
            </div>

            <div>
              <p className="mb-1.5 text-xs font-medium text-fg-muted">你的恢复码</p>
              <p
                data-testid="recovery-code"
                className="select-all break-all rounded-card border border-line bg-surface-muted px-4 py-3 font-mono text-sm tracking-wider text-fg"
              >
                {result.recoveryCode}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="sm" onClick={() => void handleCopyCode()}>
                复制恢复码
              </Button>
              <Button variant="secondary" size="sm" onClick={handleDownload}>
                下载 .kirk 文件
              </Button>
            </div>

            <label htmlFor="setup-saved" className="flex items-start gap-2 text-xs text-fg-muted">
              <input
                id="setup-saved"
                type="checkbox"
                className="mt-0.5 h-4 w-4 rounded border-line-strong"
                checked={saved}
                onChange={(event) => setSaved(event.target.checked)}
              />
              我已将恢复码离线保存，并理解丢失后无法恢复数据
            </label>

            <Button disabled={!saved} onClick={onReady}>
              进入密岛
            </Button>
          </div>
        ) : null}
      </main>
    </div>
  );
}
