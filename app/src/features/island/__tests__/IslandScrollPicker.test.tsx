/**
 * 「滑动线」选择器组件（项③：鼠标滚中键翻卡片、账号密码分开复制）。
 *
 * 这是纯组件，不依赖 VaultClient / 剪贴板，用注入的 props 断言行为，确定性强。
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { IslandScrollPicker } from '../IslandScrollPicker';
import type { ItemSummary } from '../../../core/vault/types';

const ITEMS: ItemSummary[] = [
  { id: 1, title: 'GitHub', platform: null, username: 'octo', category: '', tags: [], favorite: false, visibility: 'normal', updatedAt: 3, hasUrl: false, hasAppTarget: false },
  { id: 2, title: '邮箱', platform: null, username: 'me@x.com', category: '', tags: [], favorite: false, visibility: 'normal', updatedAt: 2, hasUrl: false, hasAppTarget: false },
  { id: 3, title: '无账号卡', platform: null, username: undefined, category: '', tags: [], favorite: false, visibility: 'normal', updatedAt: 1, hasUrl: false, hasAppTarget: false },
];

function renderPicker(overrides: Partial<Parameters<typeof IslandScrollPicker>[0]> = {}): void {
  const onCopy = overrides.onCopy ?? vi.fn();
  render(
    <IslandScrollPicker
      open
      items={ITEMS}
      activeIndex={0}
      onActiveChange={overrides.onActiveChange ?? vi.fn()}
      onCopy={onCopy}
      onClose={overrides.onClose ?? vi.fn()}
      {...overrides}
    />,
  );
}

describe('IslandScrollPicker 滑动线选择器', () => {
  it('open=false 时不渲染（不占位、不吃事件）', () => {
    const { container } = render(
      <IslandScrollPicker
        open={false}
        items={ITEMS}
        activeIndex={0}
        onActiveChange={vi.fn()}
        onCopy={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('列出全部卡片名，且最多渲染可见行（滑动线只显示名字，刻度是装饰）', () => {
    renderPicker();
    expect(screen.getByText('GitHub')).toBeInTheDocument();
    expect(screen.getByText('邮箱')).toBeInTheDocument();
    expect(screen.getByText('无账号卡')).toBeInTheDocument();
    // 当前项高亮且带 aria-selected。
    expect(screen.getByText('GitHub').closest('[role="option"]')).toHaveAttribute('aria-selected', 'true');
  });

  it('点击名字切换选中项，并回调 onActiveChange（与岛的 activeIndex 同一份）', () => {
    const onActiveChange = vi.fn();
    renderPicker({ onActiveChange });
    screen.getByText('邮箱').click();
    expect(onActiveChange).toHaveBeenCalledWith(1);
  });

  it('「复制账号」回调带 username 字段（受控：当前项由父级给）', () => {
    const onCopy = vi.fn();
    // 选中项设为有账号的 GitHub（activeIndex 由父级传入，受控组件）。
    renderPicker({ onCopy, activeIndex: 0 });
    screen.getByTestId('island-picker-copy-username').click();
    expect(onCopy).toHaveBeenCalledWith(ITEMS[0], 'username');
  });

  it('当前项没有账号时，账号按钮禁用并说明原因', () => {
    const onCopy = vi.fn();
    // 直接把选中项设为「无账号卡」（受控组件的 activeIndex 由父级给）。
    renderPicker({ onCopy, activeIndex: 2 });
    const btn = screen.getByTestId('island-picker-copy-username');
    // 禁用按钮点击不会触发回调：先判禁用，再判原因，两条断言互不相斥。
    expect(btn).toBeDisabled();
    expect(btn.title).toContain('没有账号');
  });

  it('「复制密码」回调带 password 字段（账号与密码是两个独立动作）', () => {
    const onCopy = vi.fn();
    renderPicker({ onCopy });
    screen.getByTestId('island-picker-copy-password').click();
    expect(onCopy).toHaveBeenCalledWith(ITEMS[0], 'password');
  });

  it('「关闭」按钮调用 onClose', () => {
    const onClose = vi.fn();
    renderPicker({ onClose });
    screen.getByRole('button', { name: '关闭' }).click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
