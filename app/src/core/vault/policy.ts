/**
 * 主密码强度策略（PRD FR-01：长度至少 8，弱强度不能完成初始化）。
 */

import { errors } from '../errors';

/** 主密码最小长度。 */
export const MIN_MASTER_PASSWORD_LENGTH = 8;

/** 主密码最大长度，避免 Argon2 处理超长输入造成资源浪费。 */
export const MAX_MASTER_PASSWORD_LENGTH = 256;

/** 强度评估结果。 */
export interface PasswordStrength {
  /** 0–4 分。 */
  score: number;
  acceptable: boolean;
  /** 面向 UI 的提示 key，不含密码内容。 */
  reasons: string[];
}

/** 统计密码覆盖的字符类别数量。 */
function countCharacterClasses(password: string): number {
  let classes = 0;
  if (/[a-z]/u.test(password)) classes += 1;
  if (/[A-Z]/u.test(password)) classes += 1;
  if (/[0-9]/u.test(password)) classes += 1;
  if (/[^A-Za-z0-9]/u.test(password)) classes += 1;
  return classes;
}

/** 评估主密码强度，不返回密码本身。 */
export function assessMasterPassword(password: string): PasswordStrength {
  const reasons: string[] = [];
  const length = password.length;
  const classes = countCharacterClasses(password);

  if (length < MIN_MASTER_PASSWORD_LENGTH) {
    reasons.push('password.too_short');
  }
  if (length > MAX_MASTER_PASSWORD_LENGTH) {
    reasons.push('password.too_long');
  }
  if (classes < 2) {
    reasons.push('password.too_simple');
  }
  if (length > 0 && /^(.)\1*$/u.test(password)) {
    reasons.push('password.repeated');
  }

  let score = 0;
  if (length >= MIN_MASTER_PASSWORD_LENGTH) score += 1;
  if (length >= 12) score += 1;
  if (classes >= 3) score += 1;
  if (length >= 16) score += 1;

  const acceptable =
    length >= MIN_MASTER_PASSWORD_LENGTH &&
    length <= MAX_MASTER_PASSWORD_LENGTH &&
    classes >= 2 &&
    !(length > 0 && /^(.)\1*$/u.test(password));

  return { score, acceptable, reasons };
}

/** 断言主密码可用，否则抛 `PASSWORD_WEAK`。 */
export function assertMasterPassword(password: string): void {
  const strength = assessMasterPassword(password);
  if (!strength.acceptable) {
    throw errors.passwordWeak();
  }
}

/** 密码强度档位（粗粒度，用于卡片「强度点」展示，不暴露具体密码）。 */
export type StrengthLevel = 'weak' | 'medium' | 'strong';

/**
 * 由密码推导强度档位，供卡片展示。
 *
 * 复用 `assessMasterPassword` 的评分，但与主密码不同：**不强制"弱则拒保存"**——
 * 卡片里存的是用户既有的密码，弱也要能保存（那是他的现网密码，不是他在设新主密码）。
 * 这里只把评分映射成三个档位，供 UI 给个提示，绝不在保存路径上拦它。
 *
 * 与 `PasswordStrength` 组件共用同一映射，保证"主密码设置时的档位"与
 * "卡片上的档位"口径一致（同一套评分算法）。
 */
export function passwordLevel(password: string): StrengthLevel {
  const { score, acceptable } = assessMasterPassword(password);
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
