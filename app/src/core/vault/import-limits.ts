/**
 * 导入资源上限（任务 4）：集中定义，UI 与领域解码入口共用同一组数字。
 *
 * ## 为什么需要
 * 导入文件是**不可信输入**。读文件 → JSON.parse → Base64 解码 → 解密 → 再 JSON.parse，
 * 每一步都会复制一份；再加上 Argon2 派生，一个刻意构造的超大文件或超大 KDF 参数
 * 足以让界面卡死或内存耗尽。所有检查都发生在**昂贵步骤之前**，被拒时不修改当前库。
 *
 * ## 数字的依据（产品容量目标：单库 ≤ 20 000 张卡片）
 * - 实测（`npm run perf:items`）：一张典型卡片加密后约 0.6 KB 记录；`.kib` 再经
 *   AES-GCM + Base64（×4/3）+ 外层 JSON，1 万张约 8 MB。
 * - 32 MiB 的备份/资产包上限 ≈ 典型 1 万张卡片的 4 倍余量；字段写满上限（备注 4000 字、
 *   网址 2048 字）的极端卡片约 11 KB，32 MiB 也能容纳约 2900 张。
 * - CSV 是明文表格，一行通常 < 300 字节，8 MiB ≈ 2.7 万行，大于条目上限即可。
 * - `.kirk` 恢复密钥文件只有几百字节，64 KiB 已是百倍余量。
 * - KDF：本应用自己导出的文件一律用 `ARGON2_PARAMS_V1`（64 MiB / 3 轮 / 1 线程）。
 *   密钥槽本地校验允许到 1 GiB（为兼容将来调高参数），但**导入文件**是外来输入，
 *   这里收紧到 256 MiB（默认值的 4 倍）：合法旧文件全部兼容，被篡改成 1 GiB 的文件
 *   在派生前就被拒绝，不会把浏览器 / WebView 的内存拖垮。
 *
 * 超出上限时报 `VALIDATION_FAILED`，文案只说"太大"，**不回显**文件内容、密码或资产。
 */

import { AppError } from '../errors';
import type { Argon2Params } from '../crypto/kdf';

const MiB = 1024 * 1024;

export const IMPORT_LIMITS = Object.freeze({
  /** `.kib` 完整备份：文件字节数 / 粘贴文本字符数上限。 */
  backupMaxBytes: 32 * MiB,
  /** `.kia` 资产迁移包。 */
  assetBundleMaxBytes: 32 * MiB,
  /** CSV 明文表格。 */
  csvMaxBytes: 8 * MiB,
  /** `.kirk` 恢复密钥文件。 */
  kirkMaxBytes: 64 * 1024,
  /** 单次导入的卡片 / CSV 数据行数上限。 */
  maxItems: 20_000,
  /** 导入文件可声明的 Argon2 上限（比本地密钥槽的上限更严）。 */
  kdfMemoryKiBMax: 256 * 1024,
  kdfIterationsMax: 10,
  kdfParallelismMax: 8,
});

/** 面向用户的大小描述，如 "32 MB"。 */
export function formatLimit(bytes: number): string {
  return bytes >= MiB ? `${Math.round(bytes / MiB)} MB` : `${Math.round(bytes / 1024)} KB`;
}

function tooLarge(): AppError {
  return new AppError('VALIDATION_FAILED', 'error.import_too_large', false);
}

/**
 * 粘贴 / 文件文本的长度检查。
 *
 * 用 UTF-16 码元数近似字节数：备份与资产包是 ASCII（Base64 + JSON），两者相等；
 * CSV 含中文时一个字符可能占 3 字节，按字符数放行会略宽松，但量级一致——
 * 这里防的是"数量级失控"，不是精确计费。
 */
export function assertTextWithinLimit(text: string, maxBytes: number): void {
  if (typeof text !== 'string' || text.length > maxBytes) {
    throw tooLarge();
  }
}

/** 文件选择后、读取前：按 `File.size`（真实字节数）拒绝。 */
export function assertFileWithinLimit(file: { size: number }, maxBytes: number): void {
  if (!Number.isFinite(file.size) || file.size > maxBytes) {
    throw tooLarge();
  }
}

/** 是否为导入上限错误（需要原样透出，而不是被折叠成"文件无效"）。 */
export function isImportLimitError(error: unknown): boolean {
  return (
    AppError.isAppError(error) &&
    (error.messageKey === 'error.import_too_large' || error.messageKey === 'error.import_too_many_items')
  );
}

export function assertItemCountWithinLimit(count: number): void {
  if (count > IMPORT_LIMITS.maxItems) {
    throw new AppError('VALIDATION_FAILED', 'error.import_too_many_items', false);
  }
}

/**
 * 导入文件声明的 KDF 参数必须在导入上限内。不合法 / 超限都视为文件无效，
 * 由调用方换成各自的"文件无效"错误（保持原有错误码，不新增分支）。
 */
export function isImportKdfWithinLimit(params: Pick<Argon2Params, 'memoryKiB' | 'iterations' | 'parallelism'>): boolean {
  return (
    typeof params === 'object' &&
    params !== null &&
    typeof params.memoryKiB === 'number' &&
    typeof params.iterations === 'number' &&
    typeof params.parallelism === 'number' &&
    params.memoryKiB <= IMPORT_LIMITS.kdfMemoryKiBMax &&
    params.iterations <= IMPORT_LIMITS.kdfIterationsMax &&
    params.parallelism <= IMPORT_LIMITS.kdfParallelismMax
  );
}
