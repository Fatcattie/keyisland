/**
 * 主密码强度指示条。
 *
 * 直接复用 `assessMasterPassword`，保证"UI 显示弱"与"后端拒绝提交"永远一致，
 * 不允许出现前端放行、后端报 PASSWORD_WEAK 的错位。
 */

import { assessMasterPassword } from '../../core/vault/policy';
import { t } from '../../lib/i18n';

export interface PasswordStrengthProps {
  password: string;
}

/** 强度档位。 */
type Level = 'weak' | 'medium' | 'strong';

/** 由评分推导档位。 */
function resolveLevel(score: number, acceptable: boolean): Level {
  if (!acceptable) {
    return 'weak';
  }
  if (score >= 4) {
    return 'strong';
  }
  if (score >= 2) {
    return 'medium';
  }
  return 'weak';
}

/** 档位文案与配色。 */
const LEVEL_META: Readonly<Record<Level, { label: string; bar: string; text: string }>> = Object.freeze({
  weak: { label: '弱', bar: 'bg-red-500', text: 'text-red-600 dark:text-red-400' },
  medium: { label: '中', bar: 'bg-amber-500', text: 'text-amber-600 dark:text-amber-400' },
  strong: { label: '强', bar: 'bg-emerald-500', text: 'text-emerald-600 dark:text-emerald-400' },
});

/** 强度条。 */
export function PasswordStrength({ password }: PasswordStrengthProps): JSX.Element {
  const strength = assessMasterPassword(password);
  const level = resolveLevel(strength.score, strength.acceptable);
  const meta = LEVEL_META[level];
  const filled = Math.max(0, Math.min(4, strength.score));

  return (
    <div className="flex flex-col gap-1.5" data-testid="password-strength">
      <div className="flex items-center gap-2">
        <div className="flex flex-1 gap-1" aria-hidden="true">
          {[0, 1, 2, 3].map((index) => (
            <span
              key={index}
              className={`h-1 flex-1 rounded-full ${index < filled ? meta.bar : 'bg-surface-sunken'}`}
            />
          ))}
        </div>
        <span className={`text-[11px] font-medium ${meta.text}`}>强度：{meta.label}</span>
      </div>
      {password.length > 0 && strength.reasons.length > 0 ? (
        <ul className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] leading-4 text-fg-faint">
          {strength.reasons.map((reason) => (
            <li key={reason}>{t(reason, '请加强密码')}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
