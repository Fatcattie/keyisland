/**
 * 读取用户选择的文本文件，**读之前**先按 `File.size` 检查上限（任务 4）。
 *
 * 优先用 `Blob.text()`；某些 WebView（以及 jsdom）没有实现它，退回 `FileReader`。
 * 超限时抛 `VALIDATION_FAILED / error.import_too_large`，文件内容一个字节都不读。
 */

import { assertFileWithinLimit } from '../core/vault/import-limits';

export async function readTextFile(file: File, maxBytes: number): Promise<string> {
  assertFileWithinLimit(file, maxBytes);
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
