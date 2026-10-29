/**
 * 弹性开关（白天 / 黑夜）的契约测试。
 *
 * 动效本身在 jsdom 里测不出手感（没有真实布局与帧），所以这里只钉住**语义**：
 * 它是 `role="switch"`、`aria-checked` 跟着 `checked` 走、点击回报**目标值**而不是
 * "取反指令"、禁用时不触发。手感与视觉靠真机目检。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ElasticToggle } from '../ElasticToggle';

afterEach(() => {
  cleanup();
});

describe('ElasticToggle', () => {
  it('渲染成 role=switch，aria-checked 跟随 checked', () => {
    const { rerender } = render(<ElasticToggle checked={false} onCheckedChange={vi.fn()} />);
    const toggle = screen.getByRole('switch');
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    rerender(<ElasticToggle checked onCheckedChange={vi.fn()} />);
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });

  it('点击回报切换后的目标值', () => {
    const onCheckedChange = vi.fn();
    render(<ElasticToggle checked={false} onCheckedChange={onCheckedChange} />);

    fireEvent.click(screen.getByRole('switch'));
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it('已打开时点击回报 false', () => {
    const onCheckedChange = vi.fn();
    render(<ElasticToggle checked onCheckedChange={onCheckedChange} />);

    fireEvent.click(screen.getByRole('switch'));
    expect(onCheckedChange).toHaveBeenCalledWith(false);
  });

  it('禁用时不触发回调', () => {
    const onCheckedChange = vi.fn();
    render(<ElasticToggle checked={false} disabled onCheckedChange={onCheckedChange} />);

    fireEvent.click(screen.getByRole('switch'));
    expect(onCheckedChange).not.toHaveBeenCalled();
  });

  it('用 label 作为可访问名字', () => {
    render(<ElasticToggle checked={false} label="切换白天 / 黑夜模式" onCheckedChange={vi.fn()} />);
    expect(screen.getByRole('switch', { name: '切换白天 / 黑夜模式' })).toBeInTheDocument();
  });
});
