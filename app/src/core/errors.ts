/**
 * 统一错误模型。
 *
 * 约束（SDD §5.2 / §11.1）：
 * - 对外只暴露 `code` / `messageKey` / `retryable`，不透传底层 SQL 或加密库错误。
 * - 错误消息里绝不包含明文密码、恢复码、DEK 或 KEK。
 */

/** 与 SDD §11.1 错误码表对齐，并按 Phase 1 需要补充内部校验码。 */
export type ErrorCode =
  | 'VAULT_NOT_INITIALIZED'
  | 'VAULT_ALREADY_INITIALIZED'
  | 'VAULT_LOCKED'
  | 'AUTH_INVALID'
  | 'AUTH_COOLDOWN'
  | 'RECOVERY_INVALID'
  | 'RECOVERY_CODE_INVALID'
  | 'PASSWORD_WEAK'
  | 'ITEM_NOT_FOUND'
  | 'ITEM_HIDDEN'
  | 'VALIDATION_FAILED'
  | 'CLIPBOARD_WRITE_FAILED'
  | 'CLIPBOARD_READ_FAILED'
  | 'CRYPTO_FAILED'
  | 'STORAGE_FAILED'
  | 'GENERATOR_INVALID'
  | 'UNSUPPORTED_VERSION'
  | 'INTERNAL_ERROR';

/** 可序列化的错误形状，等价于 SDD 的 Rust `AppError` DTO。 */
export interface AppErrorShape {
  code: ErrorCode;
  messageKey: string;
  retryable: boolean;
}

/** 业务错误基类：所有核心/服务层对外抛出的错误都必须是 AppError。 */
export class AppError extends Error implements AppErrorShape {
  readonly code: ErrorCode;

  readonly messageKey: string;

  readonly retryable: boolean;

  constructor(code: ErrorCode, messageKey: string, retryable = false) {
    // Error.message 仅用于开发期排查，UI 只读取 messageKey。
    super(`${code}: ${messageKey}`);
    this.name = 'AppError';
    this.code = code;
    this.messageKey = messageKey;
    this.retryable = retryable;
  }

  /** 转为可 JSON 序列化的 DTO。 */
  toJSON(): AppErrorShape {
    return { code: this.code, messageKey: this.messageKey, retryable: this.retryable };
  }

  /** 类型守卫：用于把未知异常归一化为 AppError。 */
  static isAppError(value: unknown): value is AppError {
    return value instanceof AppError;
  }
}

/** 把任意异常归一化为 AppError，避免裸字符串或底层错误透传。 */
export function toAppError(error: unknown, fallbackCode: ErrorCode = 'INTERNAL_ERROR'): AppError {
  if (AppError.isAppError(error)) {
    return error;
  }
  return new AppError(fallbackCode, `error.${fallbackCode.toLowerCase()}`, false);
}

/** 快捷构造常用错误。 */
export const errors = {
  vaultLocked(): AppError {
    return new AppError('VAULT_LOCKED', 'error.vault_locked', false);
  },
  vaultNotInitialized(): AppError {
    return new AppError('VAULT_NOT_INITIALIZED', 'error.vault_not_initialized', false);
  },
  vaultAlreadyInitialized(): AppError {
    return new AppError('VAULT_ALREADY_INITIALIZED', 'error.vault_already_initialized', false);
  },
  authInvalid(): AppError {
    return new AppError('AUTH_INVALID', 'error.auth_invalid', true);
  },
  authCooldown(): AppError {
    return new AppError('AUTH_COOLDOWN', 'error.auth_cooldown', true);
  },
  recoveryInvalid(): AppError {
    return new AppError('RECOVERY_INVALID', 'error.recovery_invalid', true);
  },
  recoveryCodeInvalid(): AppError {
    return new AppError('RECOVERY_CODE_INVALID', 'error.recovery_code_invalid', true);
  },
  passwordWeak(): AppError {
    return new AppError('PASSWORD_WEAK', 'error.password_weak', false);
  },
  itemNotFound(): AppError {
    return new AppError('ITEM_NOT_FOUND', 'error.item_not_found', false);
  },
  itemHidden(): AppError {
    return new AppError('ITEM_HIDDEN', 'error.item_hidden', false);
  },
  validationFailed(messageKey = 'error.validation_failed'): AppError {
    return new AppError('VALIDATION_FAILED', messageKey, false);
  },
  cryptoFailed(): AppError {
    return new AppError('CRYPTO_FAILED', 'error.crypto_failed', false);
  },
  storageFailed(): AppError {
    return new AppError('STORAGE_FAILED', 'error.storage_failed', true);
  },
  clipboardWriteFailed(): AppError {
    return new AppError('CLIPBOARD_WRITE_FAILED', 'error.clipboard_write_failed', true);
  },
  clipboardReadFailed(): AppError {
    return new AppError('CLIPBOARD_READ_FAILED', 'error.clipboard_read_failed', true);
  },
  generatorInvalid(messageKey = 'error.generator_invalid'): AppError {
    return new AppError('GENERATOR_INVALID', messageKey, false);
  },
  unsupportedVersion(): AppError {
    return new AppError('UNSUPPORTED_VERSION', 'error.unsupported_version', false);
  },
} as const;
