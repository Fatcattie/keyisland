/**
 * 用恢复码重新生成 `.kirk` 文件（FR-08.1 的补充路径）。
 *
 * 与「重新生成恢复密钥」的区别必须一眼看清：
 * - 轮换 = 换一把新钥匙，旧码当场作废；
 * - 这里 = **把手上那把钥匙再写成一个文件**，密钥槽一个字节都没动，旧码继续有效。
 *
 * 所以这里没有"已离线保存"的勾选闸门——那不是一次风险操作，只是补一份副本。
 * 界面上也不该出现"旧恢复码已失效"这类措辞，否则用户会以为自己又换了一次钥匙。
 *
 * 存在的原因：恢复密钥不落盘，`keyslots.recovery` 里只有用 KEK-B 包住的 DEK，
 * 所以"把当初下载的那个文件再导一次"在密码学上做不到。还留着 32 位恢复码的人
 * 才有这条路，因此文案要明确写出这个前提。
 */

import { useState, type FormEvent } from 'react';
import { CheckCircle2, Info } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Field, INPUT_CLASS } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Modal';
import { useToast } from '../../components/ui/Toast';
import { useVaultClient } from '../../app/VaultProvider';
import { describeError } from '../../lib/i18n';
import { downloadTextFile } from '../../lib/format';

export interface ExportRecoveryKeyDialogProps {
  open: boolean;
  onClose: () => void;
}

/** 重新生成 `.kirk` 恢复密钥文件对话框。 */
export function ExportRecoveryKeyDialog({
  open,
  onClose,
}: ExportRecoveryKeyDialogProps): JSX.Element {
  const client = useVaultClient();
  const toast = useToast();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 已铸出的文件内容。留着是为了让「再下载一次」不必重新验一遍码。 */
  const [issued, setIssued] = useState<{ recoveryCode: string; kirkJson: string } | null>(null);

  const handleClose = (): void => {
    setCode('');
    setError(null);
    setIssued(null);
    setBusy(false);
    onClose();
  };

  const save = (kirkJson: string): boolean => downloadTextFile('keyisland-recovery.kirk', kirkJson);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (code.trim().length === 0 || busy) {
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const result = await client.exportRecoveryKirk(code);
      setCode('');
      setIssued({ recoveryCode: result.recoveryCode, kirkJson: result.kirkJson });
      // 下载失败不能报成功：这个文件的全部意义就是"真的存在一份"。
      if (save(result.kirkJson)) {
        toast('已生成 keyisland-recovery.kirk，请离线保存');
      } else {
        toast('文件已生成但保存失败，请点「再下载一次」重试');
      }
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title="用恢复码生成 .kirk 文件"
      description="把手上那串恢复码重新写成一个 .kirk 文件。不会更换密钥，旧恢复码继续有效。"
      onClose={handleClose}
      footer={
        <Button variant="secondary" onClick={handleClose}>
          关闭
        </Button>
      }
    >
      <form onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-4" noValidate>
        <div className="rounded-card border border-line bg-surface-muted p-3">
          <p className="flex items-start gap-2 text-[11px] leading-5 text-fg-subtle">
            <Info aria-hidden="true" size={14} className="mt-0.5 shrink-0" />
            只有还留着 32 位恢复码才能用这条路。恢复密钥本身不存进库里，
            所以当初那个 .kirk 文件一旦丢失就无法直接找回——但它和恢复码本来就等价，
            用恢复码重新生成的文件同样能解锁。
          </p>
        </div>

        <Field
          label="恢复码"
          htmlFor="export-kirk-code"
          required
          hint="大小写与分隔符不敏感，例如 ABCD-EFGH-…（这里只收恢复码，不收 .kirk 内容）"
        >
          <input
            id="export-kirk-code"
            className={`${INPUT_CLASS} font-mono text-xs`}
            value={code}
            onChange={(event) => {
              setCode(event.target.value);
              setError(null);
              setIssued(null);
            }}
            placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>

        {error !== null ? (
          <p role="alert" className="text-xs font-medium text-red-600 dark:text-red-400">
            {error}
          </p>
        ) : null}

        {issued !== null ? (
          <div
            data-testid="export-kirk-done"
            className="rounded-card border border-emerald-200 bg-emerald-50 p-3 dark:border-emerald-500/30 dark:bg-emerald-500/10"
          >
            <p className="flex items-start gap-2 text-[11px] leading-5 text-emerald-800 dark:text-emerald-200">
              <CheckCircle2 aria-hidden="true" size={14} className="mt-0.5 shrink-0" />
              <span>
                恢复码验证通过，文件已生成。这把钥匙对应的恢复码是
                <code className="mx-1 break-all font-mono">{issued.recoveryCode}</code>
                ——与原来那串是同一把。
              </span>
            </p>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button type="submit" loading={busy} disabled={code.trim().length === 0}>
            验证并生成 .kirk
          </Button>
          {issued !== null ? (
            <Button
              variant="secondary"
              onClick={() => {
                toast(save(issued.kirkJson) ? '已再次保存 keyisland-recovery.kirk' : '保存失败，请检查下载设置');
              }}
            >
              再下载一次
            </Button>
          ) : null}
        </div>
      </form>
    </Modal>
  );
}
