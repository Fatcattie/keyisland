/**
 * messageKey → 中文文案。
 *
 * 约束（SDD §11.1）：UI 只读 `AppError.messageKey`，绝不展示 `error.message`
 * 或底层加密库的错误信息，避免把内部细节泄漏给用户。
 */

import { AppError } from '../core/errors';

/** 默认兜底文案。 */
const FALLBACK = '操作失败，请稍后重试';

/** 全部文案表：覆盖 `errors.ts` 中出现的每一个 messageKey。 */
const MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  // —— 会话与认证 ——
  'error.vault_locked': '保险库已锁定，请先解锁',
  'error.vault_not_initialized': '尚未创建保险库',
  'error.vault_already_initialized': '保险库已存在，无需重复创建',
  'error.auth_invalid': '主密码不正确',
  'error.auth_cooldown': '尝试过于频繁，请稍后再试',
  'error.recovery_invalid': '恢复码或恢复文件不正确',
  'error.recovery_code_invalid': '恢复码格式不正确',
  'error.recovery_code_mismatch': '恢复码与恢复密钥不匹配',
  'error.password_weak': '主密码强度不足',
  'error.unsupported_version': '数据版本不受支持，请升级应用',
  'error.invalid_keyslot': '密钥槽数据异常，无法解锁',

  // —— 资产 ——
  'error.item_not_found': '找不到该资产',
  'error.item_hidden': '该卡片受保护，需要先验证主密码',
  'error.invalid_visibility': '可见性取值不合法',
  'error.invalid_tags': '标签格式不正确',
  'error.tag_too_long': '单个标签过长',
  'error.too_many_tags': '标签数量过多',
  'error.title_required': '请填写标题',
  'error.platform_too_long': '平台名称过长',
  'error.url_too_long': '网址过长',
  'error.app_path_too_long': '应用路径过长',
  'error.username_required': '请填写账号',
  'error.password_required': '请填写密码',
  'error.password_too_long': '密码过长',
  'error.notes_too_long': '备注过长',
  'error.category_too_long': '分类名称过长',

  // —— 剪贴板 ——
  'error.clipboard_write_failed': '无法写入剪贴板，请检查系统权限',
  'error.clipboard_read_failed': '无法读取剪贴板',
  'error.clipboard_empty_value': '没有可复制的内容',
  'error.clipboard_invalid_ttl': '自动清理时长不合法',

  // —— 灵动岛热区（FR-02）——
  'error.hotzone_invalid_width': '热区宽度需在 120–1200px 之间',
  'error.hotzone_invalid_align': '热区位置取值不合法',
  'error.shortcut_action_invalid': '该快捷键不可自定义',
  'error.shortcut_invalid': '该快捷键不适用于此操作',
  'error.shortcut_conflict': '该组合键已分配给其他操作',
  'error.collapse_delay_invalid': '收起延时取值不合法',
  'error.dwell_delay_invalid': '停留时长取值不合法',

  // —— 生成器 ——
  'error.generator_invalid': '密码生成配置不合法',
  'error.generator_length_integer': '长度必须是整数',
  'error.generator_length_too_short': '长度至少 12 位',
  'error.generator_length_too_long': '长度最多 64 位',
  'error.generator_no_charset': '至少启用一类字符',

  // —— 存储与加密 ——
  'error.storage_failed': '本地存储读写失败，请重试',
  'error.crypto_failed': '加解密失败，数据可能已损坏',
  'error.internal_error': '内部错误，请重试',
  'error.invalid_salt_length': '密钥槽参数异常',
  'error.kdf_salt_too_short': '密钥派生参数异常',
  'error.invalid_base64': '数据编码异常',
  'error.invalid_random_length': '随机数长度异常',
  'error.invalid_random_bound': '随机数范围异常',

  // —— 备份与恢复 ——
  'error.backup_invalid': '备份文件无法读取，可能是密码错误或文件已损坏',
  'error.backup_password_required': '请输入备份时使用的主密码',
  'error.backup_merge_unsupported': '该备份来自另一个保险库，不能合并导入，请改用「覆盖导入」',

  // —— 密码策略（`policy.ts` 的 reasons） ——
  'password.too_short': '至少 8 个字符',
  'password.too_long': '最多 256 个字符',
  'password.too_simple': '至少包含两类字符（大小写 / 数字 / 符号）',
  'password.repeated': '不能是同一个字符重复',
});

/**
 * 取文案。
 * @param messageKey 来自 `AppError.messageKey` 或密码策略的 reason key。
 * @param fallback 未命中时的兜底文案。
 */
export function t(messageKey: string | null | undefined, fallback: string = FALLBACK): string {
  if (typeof messageKey !== 'string' || messageKey.length === 0) {
    return fallback;
  }
  return MESSAGES[messageKey] ?? fallback;
}

/** 把任意异常翻译成可展示的中文文案。 */
export function describeError(error: unknown): string {
  if (AppError.isAppError(error)) {
    return t(error.messageKey);
  }
  return FALLBACK;
}
