/**
 * ItemCard 「密码强度点」渲染（FR-03 卡片密码强度提示）。
 *
 * 强度是保存时由明文密码算好的粗粒度元数据，列表展示无需解密。这里只验证：
 * 1. 有 strength 且非「仅账号」卡片 → 显示对应档位的强度点；
 * 2. 缺 strength（旧记录/未迁移） → 不显示，绝不在列表泄露；
 * 3. 「仅账号」可见性（刻意隐藏密码） → 即使有 strength 也不显示，避免泄露强度暗示。
 *
 * 注意：ItemCard 通过 `useVaultClient` / `useToast` 取上下文，必须在 Provider 内渲染。
 * 这里只给它一个最小 mock client（仅覆盖 ItemCard 实际调用的方法），不依赖共享 harness，
 * 避免把无关交互拉进来。
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ItemCard } from '../ItemCard';
import { VaultProvider } from '../../../app/VaultProvider';
import { ToastProvider } from '../../../components/ui/Toast';
import type { VaultClient } from '../../../services/vault-client';
import type { ItemSummary, StrengthLevel } from '../../../core/vault/types';

function makeItem(overrides: Partial<ItemSummary> = {}): ItemSummary {
  return {
    id: 1,
    title: '示例账号',
    platform: 'example.com',
    username: 'user',
    category: 'login',
    tags: [],
    favorite: false,
    visibility: 'normal',
    updatedAt: Date.now(),
    hasUrl: true,
    hasAppTarget: false,
    ...overrides,
  };
}

/** 仅覆盖 ItemCard 实际调用的方法，渲染阶段不会真正触发它们。 */
function makeClient(): VaultClient {
  return {
    revealPassword: vi.fn().mockResolvedValue('secret'),
    copyPassword: vi.fn().mockResolvedValue(undefined),
    copyUsername: vi.fn().mockResolvedValue(undefined),
    setFavorite: vi.fn().mockResolvedValue(undefined),
    recordJump: vi.fn().mockResolvedValue(undefined),
  } as unknown as VaultClient;
}

function renderCard(item: ItemSummary) {
  return render(
    <ToastProvider>
      <VaultProvider client={makeClient()}>
        <ItemCard
          item={item}
          now={Date.now()}
          onEdit={() => undefined}
          onRequestDelete={() => undefined}
          onChanged={vi.fn()}
        />
      </VaultProvider>
    </ToastProvider>,
  );
}

describe('ItemCard 强度点', () => {
  const cases: Array<{ level: StrengthLevel; label: string }> = [
    { level: 'weak', label: '弱' },
    { level: 'medium', label: '中' },
    { level: 'strong', label: '强' },
  ];

  cases.forEach(({ level, label }, index) => {
    it(`显示 ${label} 档强度点`, () => {
      renderCard(makeItem({ id: index + 10, strength: level }));
      expect(screen.getByLabelText(`密码强度：${label}`)).toBeInTheDocument();
    });
  });

  it('缺 strength 字段时不显示强度点（旧记录兼容）', () => {
    renderCard(makeItem({ strength: undefined }));
    expect(screen.queryByLabelText(/密码强度：/)).not.toBeInTheDocument();
    expect(screen.queryByText('强度')).not.toBeInTheDocument();
  });

  it('「仅账号」可见性即使有 strength 也不显示', () => {
    renderCard(makeItem({ visibility: 'username_only', strength: 'strong' }));
    expect(screen.queryByLabelText(/密码强度：/)).not.toBeInTheDocument();
  });
});
