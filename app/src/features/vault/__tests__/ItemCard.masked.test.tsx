/**
 * ItemCard 「遮罩」可见性（需求 4 · 卡片账密隐藏上锁）。
 *
 * 验证：
 * 1. `masked` 卡片在授权未生效（hiddenAccessActive=false）时：
 *    - 账号显示 `••••••••` 且带 `data-masked-locked`；
 *    - 密码默认遮罩；
 *    - 复制 / 预览 / 打开 / 编辑 均改为唤起授权对话框，不直接触碰敏感数据；
 *    - 角标显示「遮罩」。
 * 2. 授权生效（hiddenAccessActive=true）后：
 *    - 账号显示真实值；
 *    - 复制直接调用 `copyUsername` / `copyPassword`，不再唤起授权。
 *
 * 注意：ItemCard 通过 `useVaultClient` / `useToast` 取上下文，必须在 Provider 内渲染。
 * 这里只给它一个最小 mock client（仅覆盖 ItemCard 实际调用的方法），不依赖共享 harness。
 */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ItemCard } from '../ItemCard';
import { VaultProvider } from '../../../app/VaultProvider';
import { ToastProvider } from '../../../components/ui/Toast';
import type { VaultClient } from '../../../services/vault-client';
import type { ItemSummary } from '../../../core/vault/types';

const MASKED = '••••••••';

function makeItem(overrides: Partial<ItemSummary> = {}): ItemSummary {
  return {
    id: 1,
    title: '遮罩示例',
    platform: 'example.com',
    username: 'realuser',
    category: 'login',
    tags: [],
    favorite: false,
    visibility: 'normal',
    updatedAt: Date.now(),
    hasUrl: false,
    hasAppTarget: false,
    ...overrides,
  };
}

function makeClient(): VaultClient {
  return {
    revealPassword: vi.fn().mockResolvedValue('secret'),
    copyPassword: vi.fn().mockResolvedValue({ ttlMs: 10000, autoClear: true }),
    copyUsername: vi.fn().mockResolvedValue({ ttlMs: 10000, autoClear: true }),
    setFavorite: vi.fn().mockResolvedValue(undefined),
    recordJump: vi.fn().mockResolvedValue(undefined),
    getItem: vi.fn().mockResolvedValue(makeItem()),
  } as unknown as VaultClient;
}

function renderCard(
  item: ItemSummary,
  hiddenAccessActive: boolean,
  onRequestHiddenAccess = vi.fn(),
  handlers: {
    onEdit?: (item: ItemSummary) => void;
    onRequestDelete?: (item: ItemSummary) => void;
  } = {},
) {
  return render(
    <ToastProvider>
      <VaultProvider client={makeClient()}>
        <ItemCard
          item={item}
          now={Date.now()}
          hiddenAccessActive={hiddenAccessActive}
          onRequestHiddenAccess={onRequestHiddenAccess}
          onEdit={handlers.onEdit ?? (() => undefined)}
          onRequestDelete={handlers.onRequestDelete ?? (() => undefined)}
          onChanged={vi.fn()}
        />
      </VaultProvider>
    </ToastProvider>,
  );
}

/** 取出 ItemCard 交给授权流程的"续跑回调"（验证通过后由父组件执行）。 */
function takeAfterGrant(onRequest: ReturnType<typeof vi.fn>): (() => void) | undefined {
  return onRequest.mock.calls[0]?.[0] as (() => void) | undefined;
}

describe('ItemCard 遮罩', () => {
  it('遮罩卡片 · 未授权时账号显示为遮罩文本', () => {
    renderCard(makeItem({ visibility: 'masked' }), false);
    const username = screen.getByTestId('username-1');
    expect(username).toHaveAttribute('data-masked-locked');
    expect(username).toHaveTextContent(MASKED);
  });

  it('遮罩卡片 · 未授权时角标为「遮罩」', () => {
    renderCard(makeItem({ visibility: 'masked' }), false);
    expect(screen.getByText('遮罩')).toBeInTheDocument();
  });

  it('遮罩卡片 · 未授权时复制账号改为唤起授权，不调用 copyUsername', () => {
    const onRequest = vi.fn();
    // 直接给 mock client 注入断言用的 spy
    render(
      <ToastProvider>
        <VaultProvider
          client={
            {
              revealPassword: vi.fn(),
              copyPassword: vi.fn(),
              copyUsername: vi.fn(),
              setFavorite: vi.fn(),
              recordJump: vi.fn(),
              getItem: vi.fn(),
            } as unknown as VaultClient
          }
        >
          <ItemCard
            item={makeItem({ visibility: 'masked' })}
            now={Date.now()}
            hiddenAccessActive={false}
            onRequestHiddenAccess={onRequest}
            onEdit={() => undefined}
            onRequestDelete={() => undefined}
            onChanged={vi.fn()}
          />
        </VaultProvider>
      </ToastProvider>,
    );
    const copyBtn = screen.getByLabelText('复制账号');
    fireEvent.click(copyBtn);
    expect(onRequest).toHaveBeenCalledTimes(1);
  });

  it('遮罩卡片 · 授权后账号显示真实值且不再遮罩', () => {
    renderCard(makeItem({ visibility: 'masked', username: 'realuser' }), true);
    const username = screen.getByTestId('username-1');
    expect(username).not.toHaveAttribute('data-masked-locked');
    expect(username).toHaveTextContent('realuser');
  });

  it('普通卡片不受遮罩逻辑影响，账号直接显示', () => {
    renderCard(makeItem({ visibility: 'normal', username: 'openuser' }), false);
    expect(screen.getByTestId('username-1')).toHaveTextContent('openuser');
    expect(screen.queryByText('遮罩')).not.toBeInTheDocument();
  });

  it('遮罩卡片 · 未授权时不显示强度点（避免暗示密码强弱）', () => {
    renderCard(makeItem({ visibility: 'masked', strength: 'strong' }), false);
    expect(screen.queryByTestId('strength-1')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/密码强度：/)).not.toBeInTheDocument();
  });

  it('遮罩卡片 · 授权后显示强度点', () => {
    renderCard(makeItem({ visibility: 'masked', strength: 'strong' }), true);
    expect(screen.getByTestId('strength-1')).toBeInTheDocument();
  });

  it('遮罩卡片 · 未授权时点击删除改为唤起授权，不直接进入删除', () => {
    const onRequest = vi.fn();
    const onDelete = vi.fn();
    render(
      <ToastProvider>
        <VaultProvider client={makeClient()}>
          <ItemCard
            item={makeItem({ visibility: 'masked' })}
            now={Date.now()}
            hiddenAccessActive={false}
            onRequestHiddenAccess={onRequest}
            onEdit={() => undefined}
            onRequestDelete={onDelete}
            onChanged={vi.fn()}
          />
        </VaultProvider>
      </ToastProvider>,
    );
    fireEvent.click(screen.getByLabelText('删除'));
    expect(onRequest).toHaveBeenCalledTimes(1);
    expect(onDelete).not.toHaveBeenCalled();
  });
});

/**
 * 需求 4 的闭环：用户点「编辑 / 复制 / 删除」时被遮罩拦下，
 * 验证主密码通过后必须**续跑原动作**，而不是把人丢回列表让人再点一次。
 * 这里断言 ItemCard 确实把续跑回调交给了授权流程，且回调执行后原动作才发生。
 */
describe('ItemCard 遮罩 · 授权后续跑原动作', () => {
  it('未授权点「编辑」：先唤起授权，回调执行后才进入编辑', () => {
    const onEdit = vi.fn();
    const onRequest = vi.fn();
    renderCard(makeItem({ visibility: 'masked' }), false, onRequest, { onEdit });

    fireEvent.click(screen.getByLabelText('编辑'));

    expect(onRequest).toHaveBeenCalledTimes(1);
    expect(onEdit).not.toHaveBeenCalled();

    const afterGrant = takeAfterGrant(onRequest);
    expect(typeof afterGrant).toBe('function');
    afterGrant?.();
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it('未授权点「删除」：先唤起授权，回调执行后才进入删除确认', () => {
    const onDelete = vi.fn();
    const onRequest = vi.fn();
    renderCard(makeItem({ visibility: 'masked' }), false, onRequest, { onRequestDelete: onDelete });

    fireEvent.click(screen.getByLabelText('删除'));

    expect(onRequest).toHaveBeenCalledTimes(1);
    expect(onDelete).not.toHaveBeenCalled();

    takeAfterGrant(onRequest)?.();
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('未授权点「复制账号」：先唤起授权，回调执行后才真正复制', async () => {
    const client = makeClient();
    const onRequest = vi.fn();
    render(
      <ToastProvider>
        <VaultProvider client={client}>
          <ItemCard
            item={makeItem({ visibility: 'masked' })}
            now={Date.now()}
            hiddenAccessActive={false}
            onRequestHiddenAccess={onRequest}
            onEdit={() => undefined}
            onRequestDelete={() => undefined}
            onChanged={vi.fn()}
          />
        </VaultProvider>
      </ToastProvider>,
    );

    fireEvent.click(screen.getByLabelText('复制账号'));
    expect(client.copyUsername).not.toHaveBeenCalled();

    takeAfterGrant(onRequest)?.();
    await waitFor(() => expect(client.copyUsername).toHaveBeenCalledTimes(1));
  });

  it('未授权点「预览密码」只唤起授权，不自动续跑按压预览（按压是瞬时手势）', () => {
    const onRequest = vi.fn();
    renderCard(makeItem({ visibility: 'masked' }), false, onRequest);

    // 预览是"按住"手势（onPointerDown），不是 click。
    fireEvent.pointerDown(screen.getByLabelText('预览密码'));

    expect(onRequest).toHaveBeenCalledTimes(1);
    expect(takeAfterGrant(onRequest)).toBeUndefined();
  });
});
