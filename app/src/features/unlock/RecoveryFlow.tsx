/**
 * 恢复流程：校验恢复凭据 → 设置新主密码。
 *
 * 支持两种凭据形态：
 * - 恢复码文本（自动归一化：去分隔符、Crockford 纠错）；
 * - `.kirk` 文件内容（粘贴 JSON，直接使用其中的 32 字节恢复密钥）。
 *
 * 完成后会话回到锁定态，必须用新主密码解锁 —— 这是刻意的：
 * 恢复流程不应顺带把用户送进解锁态，否则"知道恢复码"就等于"长期会话"。
 */

import { useState, type FormEvent } from 'react';
import { ShieldAlert } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Field, INPUT_CLASS, TEXTAREA_CLASS } from '../../components/ui/Field';
import { PasswordStrength } from '../../components/ui/PasswordStrength';
import { useVaultClient } from '../../app/VaultProvider';
import { normalizeRecoveryCode } from '../../core/vault/recovery';
import { assessMasterPassword } from '../../core/vault/policy';
import { describeError, t } from '../../lib/i18n';

export interface RecoveryFlowProps {
  onCancel: () => void;
  /** 重设成功回调（此时会话已回到锁定态）。 */
  onDone: () => void | Promise<void>;
}

/** 阶段。 */
type Stage = 'verify' | 'reset';

/** 判断输入是否像 `.kirk` JSON。 */
function looksLikeKirk(text: string): boolean {
  return text.trimStart().startsWith('{');
}

/**
 * 读取用户选择的 `.kirk` 文件。
 *
 * 优先用 `Blob.text()`；某些 WebView（以及 jsdom）没有实现它，
 * 退回 `FileReader`。两条路径都只返回文本，不做任何解析之外的处理。
 */
async function readKirkFile(file: File): Promise<string> {
  if (typeof file.text === 'function') {
    return file.text();
  }
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (): void => {
      resolve(typeof reader.result === 'string' ? reader.result : '');
    };
    reader.onerror = (): void => {
      reject(new Error('无法读取该文件'));
    };
    reader.readAsText(file);
  });
}

/** 恢复流程。 */
export function RecoveryFlow({ onCancel, onDone }: RecoveryFlowProps): JSX.Element {
  const client = useVaultClient();
  const [stage, setStage] = useState<Stage>('verify');
  const [credential, setCredential] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const isKirk = looksLikeKirk(credential);

  const handlePickFile = async (file: File | undefined): Promise<void> => {
    if (file === undefined) {
      return;
    }
    try {
      const text = await readKirkFile(file);
      if (!looksLikeKirk(text)) {
        setError('这个文件不是 .kirk 恢复文件，请重新选择');
        return;
      }
      setCredential(text);
      setFileName(file.name);
      setError(null);
    } catch {
      setError('无法读取该文件，请确认它仍然存在且有读取权限');
    }
  };

  const handleVerify = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setError(null);
    const trimmed = credential.trim();
    if (trimmed.length === 0) {
      setError('请输入恢复码，或粘贴 .kirk 文件内容');
      return;
    }
    setSubmitting(true);
    try {
      if (looksLikeKirk(trimmed)) {
        await client.recoverWithKirk(trimmed);
      } else {
        await client.recover(normalizeRecoveryCode(trimmed));
      }
      setStage('reset');
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const handleReset = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setError(null);
    if (newPassword !== confirm) {
      setError('两次输入的新主密码不一致');
      return;
    }
    const strength = assessMasterPassword(newPassword);
    if (!strength.acceptable) {
      const reasons = strength.reasons.map((reason) => t(reason, '请加强密码')).join('；');
      setError(`新主密码强度不足：${reasons}`);
      return;
    }
    setSubmitting(true);
    try {
      const trimmed = credential.trim();
      if (looksLikeKirk(trimmed)) {
        await client.resetMasterPasswordWithKirk({ kirkJson: trimmed, newPassword });
      } else {
        await client.resetMasterPassword({
          recoveryCode: normalizeRecoveryCode(trimmed),
          newPassword,
        });
      }
      setNewPassword('');
      setConfirm('');
      await onDone();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center bg-zinc-100 px-4 py-12">
      <main className="w-full max-w-lg rounded-card border border-zinc-200 bg-white p-8 shadow-card">
        <header className="mb-5">
          <h1 className="text-lg font-semibold text-zinc-900">
            {stage === 'verify' ? '用恢复凭据验证身份' : '设置新的主密码'}
          </h1>
          <p className="mt-1 text-xs leading-5 text-zinc-500">
            {stage === 'verify'
              ? '输入 32 位恢复码（大小写与分隔符不敏感），或直接粘贴 .kirk 文件内容。'
              : '新主密码只重写密码槽，恢复码继续有效。'}
          </p>
        </header>

        <div className="mb-5 flex items-start gap-2 rounded-card border border-amber-200 bg-amber-50 px-3 py-2.5">
          <ShieldAlert aria-hidden="true" size={14} className="mt-0.5 text-amber-700" />
          <p className="text-[11px] leading-5 text-amber-700">
            主密码与恢复密钥同时丢失，数据将永久不可恢复 —— 密岛没有服务器，也没有后门。
          </p>
        </div>

        {stage === 'verify' ? (
          <form onSubmit={(event) => void handleVerify(event)} className="flex flex-col gap-4" noValidate>
            <Field
              label="选择 .kirk 恢复文件"
              htmlFor="recovery-kirk-file"
              hint="保存恢复密钥时下载的 .kirk 文件；也可以直接粘贴下面的内容"
            >
              <input
                id="recovery-kirk-file"
                type="file"
                accept=".kirk,application/json"
                className={INPUT_CLASS}
                onChange={(event) => {
                  void handlePickFile(event.target.files?.[0]);
                }}
              />
            </Field>
            {fileName !== null ? (
              <p className="text-[11px] text-zinc-500">
                已载入文件：{fileName}（{credential.length} 个字符）
              </p>
            ) : null}
            <Field
              label="恢复码 / .kirk 内容"
              htmlFor="recovery-credential"
              required
              hint={isKirk ? '已识别为 .kirk 文件内容' : '例如 ABCD-EFGH-…'}
            >
              <textarea
                id="recovery-credential"
                className={`${TEXTAREA_CLASS} font-mono text-xs`}
                value={credential}
                onChange={(event) => {
                  setCredential(event.target.value);
                  setFileName(null);
                  setError(null);
                }}
                placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
              />
            </Field>
            {error !== null ? (
              <p role="alert" className="text-xs font-medium text-red-600">
                {error}
              </p>
            ) : null}
            <div className="flex items-center gap-2">
              <Button variant="secondary" onClick={onCancel}>
                返回解锁
              </Button>
              <Button type="submit" loading={submitting} disabled={credential.trim().length === 0}>
                验证
              </Button>
            </div>
          </form>
        ) : (
          <form onSubmit={(event) => void handleReset(event)} className="flex flex-col gap-4" noValidate>
            <Field label="新主密码" htmlFor="recovery-new-password" required>
              <input
                id="recovery-new-password"
                type="password"
                autoComplete="new-password"
                className={INPUT_CLASS}
                value={newPassword}
                onChange={(event) => {
                  setNewPassword(event.target.value);
                  setError(null);
                }}
              />
            </Field>
            <PasswordStrength password={newPassword} />
            <Field label="再次输入新主密码" htmlFor="recovery-confirm" required>
              <input
                id="recovery-confirm"
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
              <p role="alert" className="text-xs font-medium text-red-600">
                {error}
              </p>
            ) : null}
            <Button type="submit" loading={submitting} disabled={newPassword.length === 0}>
              重设主密码
            </Button>
          </form>
        )}
      </main>
    </div>
  );
}
