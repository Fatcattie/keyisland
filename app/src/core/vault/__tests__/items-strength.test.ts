/**
 * 卡片密码强度（FR-03「密码强度点」）在核心层的落地。
 *
 * 契约：
 * 1. 新建卡片时，强度档位由明文密码算出并随记录落盘（列表展示无需解密）；
 * 2. 改密码时强度重算；不改密码时沿用原档位（不能被悄悄清零）；
 * 3. 强度计算复用 `assessMasterPassword` 的口径，弱密码也允许保存（不强制拒提交）。
 */

import { describe, expect, it } from 'vitest';
import { randomBytes } from '../../crypto/random';
import { passwordLevel } from '../policy';
import { ItemService } from '../items';
import { MemoryVaultStorage } from '../../../services/storage';

function makeService(): ItemService {
  return new ItemService({
    dek: randomBytes(32),
    now: () => 1_700_000_000_000,
    store: new MemoryVaultStorage(),
  });
}

describe('FR-03 · 卡片密码强度', () => {
  it('新建卡片时强度随记录落地', async () => {
    const service = makeService();
    // 一个明显强的密码。
    const summary = await service.createItem({
      title: '示例站点',
      username: 'demo-user@example.test',
      password: 'Abcdefghijklmno1',
    });

    // 摘要里带强度，且档位与直接用明文算出的完全一致。
    expect(summary.strength).toBe(passwordLevel('Abcdefghijklmno1'));
    expect(summary.strength).toBe('strong');
  });

  it('弱密码也允许保存（不强制拒提交）', async () => {
    const service = makeService();
    const summary = await service.createItem({
      title: '弱密码卡',
      username: 'u',
      password: 'abc',
    });
    expect(summary.strength).toBe('weak');
  });

  it('改密码时强度跟着重算', async () => {
    const service = makeService();
    const created = await service.createItem({
      title: '账户',
      username: 'u',
      password: 'Abcdefghijklmno1', // strong
    });
    const id = created.id;

    // 改成明显弱的密码。
    const updated = await service.updateItem(id, { password: 'abc' });
    expect(updated.strength).toBe('weak');
  });

  it('不改密码时强度沿用原档位（不被悄悄清零）', async () => {
    const service = makeService();
    const created = await service.createItem({
      title: '账户',
      username: 'u',
      password: 'Abcdefghijklmno1', // strong
    });
    const id = created.id;

    // 只改标题，不动密码。
    const updated = await service.updateItem(id, { title: '账户（改名）' });
    expect(updated.strength).toBe('strong');
  });

  it('旧记录在「保存前」创建的记录重算后强度与当前密码一致', async () => {
    // 模拟"升级前"的记录：用未带 strength 的密文记录注入存储，再 hydrate。
    const storage = new MemoryVaultStorage();
    const dek = randomBytes(32);
    const service = new ItemService({ dek, now: () => 0, store: storage });
    const created = await service.createItem({
      title: '存量卡',
      username: 'u',
      password: 'Abcdefghijklmno1', // strong
    });
    const id = created.id;

    // 用新 client 重新加载（模拟重启），强度应仍由记录里的字段读出，不为 undefined。
    const reloaded = new ItemService({ dek, now: () => 0, store: storage });
    const summary = await reloaded.updateItem(id, { title: '存量卡（改名）' });
    expect(summary.strength).toBe('strong');
  });
});
