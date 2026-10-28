/** SHA-256 摘要工具：用于剪贴板内容摘要（不保存明文）。 */

import { bytesToHex, toArrayBuffer, utf8ToBytes } from './encoding';
import { errors } from '../errors';

/** 计算 SHA-256 摘要字节。 */
export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  try {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', toArrayBuffer(data));
    return new Uint8Array(digest);
  } catch {
    throw errors.cryptoFailed();
  }
}

/** 计算字符串的 SHA-256 十六进制摘要。 */
export async function sha256Hex(text: string): Promise<string> {
  return bytesToHex(await sha256(utf8ToBytes(text)));
}
