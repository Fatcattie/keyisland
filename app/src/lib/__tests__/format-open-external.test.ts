/**
 * `openExternal` 的双环境行为。
 *
 * 背景：Tauri 会拦截 `window.open`（默认不允许创建新窗口），
 * 浏览器版能开、桌面版点了没反应**而且不报错**，调用方还会以为成功去记跳转日志。
 * 所以桌面壳必须改走 Rust 的 `open_external`（系统默认浏览器）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn(async () => undefined) }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import { openExternal } from '../format';

function enterDesktopShell(): void {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
}

function leaveDesktopShell(): void {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
}

describe('openExternal · 浏览器', () => {
  let openSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    leaveDesktopShell();
    invokeMock.mockClear();
    openSpy = vi.fn();
    vi.stubGlobal('open', openSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('http 链接走 window.open，并带上 noopener', () => {
    expect(openExternal('https://example.com/login')).toBe(true);
    expect(openSpy).toHaveBeenCalledWith('https://example.com/login', '_blank', 'noopener,noreferrer');
  });

  it('拒绝非 http(s) 协议（javascript: 之类不能放行）', () => {
    expect(openExternal('javascript:alert(1)')).toBe(false);
    expect(openExternal('file:///C:/Windows/System32/cmd.exe')).toBe(false);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('非法 URL 直接返回 false', () => {
    expect(openExternal('不是链接')).toBe(false);
    expect(openSpy).not.toHaveBeenCalled();
  });
});

describe('openExternal · 桌面壳', () => {
  let openSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    enterDesktopShell();
    invokeMock.mockClear();
    openSpy = vi.fn();
    vi.stubGlobal('open', openSpy);
  });

  afterEach(() => {
    leaveDesktopShell();
    vi.unstubAllGlobals();
  });

  it('改走 Rust 命令，而不是被拦截的 window.open', async () => {
    expect(openExternal('https://example.com/login')).toBe(true);
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));

    expect(invokeMock).toHaveBeenCalledWith('open_external', { url: 'https://example.com/login' });
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('协议校验在桌面壳里同样生效（不把非法协议交给 Rust）', () => {
    expect(openExternal('javascript:alert(1)')).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('Rust 侧失败不抛给调用方（与浏览器版被拦截弹窗时一致）', async () => {
    invokeMock.mockRejectedValueOnce(new Error('explorer 启动失败'));
    expect(() => openExternal('https://example.com')).not.toThrow();
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalled());
  });
});
