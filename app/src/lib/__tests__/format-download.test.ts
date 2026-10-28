/**
 * `downloadTextFile` 的行为约定。
 *
 * 这个函数是"用户以为备份成功了"与"备份真的落盘了"之间唯一的判据，
 * 所以两条分支都必须被钉住：
 * - 环境不支持时必须返回 false，调用方才不会谎报"已导出"；
 * - 支持时必须真的点一次 `<a download>`，且**不能**在下载开始前就撤销 URL。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadTextFile } from '../format';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('downloadTextFile', () => {
  it('环境不支持 createObjectURL 时返回 false（调用方据此避免谎报"已导出"）', () => {
    // 用一个不含 createObjectURL 的对象顶替全局 URL，模拟 WebView / 受限环境。
    vi.stubGlobal('URL', {});

    expect(downloadTextFile('keyisland-2026-10-25.kib', '{"v":1}')).toBe(false);
  });

  it('支持时真的发起下载并返回 true', () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:fake', revokeObjectURL });

    expect(downloadTextFile('keyisland-2026-10-25.kib', '{"v":1}')).toBe(true);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('撤销 URL 推迟到宏任务之后，不在 click 当下就废掉', async () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:fake', revokeObjectURL });

    downloadTextFile('keyisland-2026-10-25.kib', '{"v":1}');

    // 同步撤销可能在下载真正开始前就把 URL 失效掉，结果是"没文件、也没报错"。
    expect(revokeObjectURL).not.toHaveBeenCalled();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake');
  });
});
