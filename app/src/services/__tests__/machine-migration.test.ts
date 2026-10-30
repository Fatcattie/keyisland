/**
 * 换机剧本：A 机器导出 → B 机器恢复 → 数据完全一致。
 *
 * 为什么单独写：`.kib` 覆盖导入、恢复码重设、隐藏/遮罩档位各自都有单元测试，
 * 但没有一条用例把**整条换机路径**串起来跑。而这是密码管理器最核心的价值主张——
 * 用户真正在意的不是"某条路径的某个分支正确"，而是"我换了电脑，东西还在，而且
 * 我还能打开它"。
 *
 * 这里刻意用两个独立的 `MemoryVaultStorage` 代表两台机器，中间不共享任何状态。
 *
 * 覆盖两个剧本：
 * A. 记得旧主密码 → 覆盖导入 → 用旧主密码打开新库；
 * B. 忘了旧主密码 → 用 A 机器那张恢复码重设主密码 → 东西还在。
 *
 * B 的关键在于**恢复密钥跟着 keyslots 一起搬过去了**：`.kib` 里含 keyslots，
 * 覆盖导入会整体替换，所以 A 机器的恢复码在 B 机器上同样有效。这一点最容易被
 * 忽略，也最容易在"备份只带了资产、没带密钥槽"的实现里悄悄失效。
 */

import { describe, expect, it } from 'vitest';
import { ARGON2_TEST_PARAMS } from '../../core/crypto/kdf';
import { MemoryVaultStorage } from '../storage';
import { createVaultClient, type VaultClient } from '../vault-client';

const A_MASTER = 'Machine-A-Master-42!';
const B_TEMP = 'Machine-B-Temp-88!';
const NEW_MASTER = 'Restored-Master-77!';

function newClient(storage: MemoryVaultStorage): VaultClient {
  return createVaultClient({
    storage,
    passwordParams: ARGON2_TEST_PARAMS,
    recoveryParams: ARGON2_TEST_PARAMS,
  });
}

interface MachineA {
  storage: MemoryVaultStorage;
  backup: string;
  recoveryCode: string;
  kirkJson: string;
}

/** A 机器：建库、放三张不同档位的卡、导出备份。 */
async function buildMachineA(): Promise<MachineA> {
  const storage = new MemoryVaultStorage();
  const client = newClient(storage);
  const init = await client.initialize({ masterPassword: A_MASTER });

  await client.createItem({
    title: 'GitHub',
    username: 'octocat',
    password: 'Pass-1-Aa1!',
    url: 'https://github.com',
    category: '开发',
    tags: ['work'],
    favorite: true,
  });
  await client.createItem({
    title: 'Bank',
    username: 'me@example.test',
    password: 'Pass-2-Bb2!',
    category: '金融',
    visibility: 'masked',
  });
  await client.createItem({
    title: 'Secret',
    username: 'ghost@example.test',
    password: 'Pass-3-Cc3!',
    category: '开发',
    visibility: 'hidden',
  });

  return {
    storage,
    backup: await client.exportBackup(A_MASTER),
    recoveryCode: init.recoveryCode,
    kirkJson: init.kirkJson,
  };
}

/** B 机器：全新环境，先建一个只有一张卡的临时库。 */
async function buildMachineB(): Promise<{ storage: MemoryVaultStorage; client: VaultClient }> {
  const storage = new MemoryVaultStorage();
  const client = newClient(storage);
  await client.initialize({ masterPassword: B_TEMP });
  await client.createItem({ title: 'TempOnly', username: 'tmp', password: 'Pass-9-Zz9!' });
  return { storage, client };
}

describe('换机剧本 · 记得旧主密码', () => {
  it('覆盖导入后，B 机器用 A 的主密码打开，旧临时密码失效，临时卡片被整体替换', async () => {
    const a = await buildMachineA();
    const b = await buildMachineB();

    const result = await b.client.importBackup({
      kirkJson: a.backup,
      password: A_MASTER,
      mode: 'overwrite',
      masterPassword: B_TEMP,
    });
    expect(result).toMatchObject({ mode: 'overwrite', totalItems: 3 });

    // 换一个 client 读同一份存储：证明落盘的是新密钥槽，不是内存里的错觉。
    const restored = newClient(b.storage);

    // 临时主密码必须失效——否则"覆盖"就是假的。
    await expect(restored.unlock(B_TEMP)).rejects.toThrow();

    await restored.unlock(A_MASTER);
    const list = await restored.listItems();
    // 隐藏卡不出现在默认列表；临时卡已被整体替换掉。
    expect(list.map((item) => item.title).sort()).toEqual(['Bank', 'GitHub']);
    expect(list.some((item) => item.title === 'TempOnly')).toBe(false);
  });

  it('卡片内容逐项一致：网址、分类、标签、收藏、密码都能读回来', async () => {
    const a = await buildMachineA();
    const b = await buildMachineB();
    await b.client.importBackup({
      kirkJson: a.backup,
      password: A_MASTER,
      mode: 'overwrite',
      masterPassword: B_TEMP,
    });

    const restored = newClient(b.storage);
    await restored.unlock(A_MASTER);
    const github = (await restored.listItems()).find((item) => item.title === 'GitHub');
    expect(github).toBeDefined();

    const detail = await restored.getItem(github!.id);
    expect(detail.url).toBe('https://github.com');
    expect(detail.category).toBe('开发');
    expect(detail.tags).toEqual(['work']);
    expect(detail.favorite).toBe(true);
    expect(detail.username).toBe('octocat');
    await expect(restored.revealPassword(github!.id)).resolves.toBe('Pass-1-Aa1!');
  });

  it('档位跟着走：遮罩卡仍遮罩且账号未授权不可见，隐藏卡仍需授权才出现', async () => {
    const a = await buildMachineA();
    const b = await buildMachineB();
    await b.client.importBackup({
      kirkJson: a.backup,
      password: A_MASTER,
      mode: 'overwrite',
      masterPassword: B_TEMP,
    });

    const restored = newClient(b.storage);
    await restored.unlock(A_MASTER);

    const bank = (await restored.listItems()).find((item) => item.title === 'Bank');
    expect(bank).toBeDefined();
    expect(bank!.visibility).toBe('masked');
    // 未授权时账号被抹：换机不能把遮罩降级成明文。
    expect(bank!.username).toBeUndefined();

    await restored.requestHiddenAccess(A_MASTER);
    const all = await restored.listItems({ includeHidden: true });
    const secret = all.find((item) => item.title === 'Secret');
    expect(secret).toBeDefined();
    expect(secret!.visibility).toBe('hidden');
    // 授权本身不等于放行：隐藏卡还要显式 `allowHidden`（对抗性安全刻意守的边界）。
    await expect(restored.revealPassword(secret!.id)).rejects.toThrow();
    await expect(restored.revealPassword(secret!.id, { allowHidden: true })).resolves.toBe('Pass-3-Cc3!');
  });
});

describe('换机剧本 · 忘了旧主密码', () => {
  it('A 机器的恢复码能在 B 机器重设主密码，数据不丢', async () => {
    const a = await buildMachineA();
    const b = await buildMachineB();
    await b.client.importBackup({
      kirkJson: a.backup,
      password: A_MASTER,
      mode: 'overwrite',
      masterPassword: B_TEMP,
    });

    // 关键：`.kib` 带的是 A 的密钥槽，所以 A 的恢复码在这里同样有效。
    const restored = newClient(b.storage);
    await restored.resetMasterPassword({ recoveryCode: a.recoveryCode, newPassword: NEW_MASTER });

    const reopened = newClient(b.storage);
    await reopened.unlock(NEW_MASTER);
    const list = await reopened.listItems();
    expect(list.map((item) => item.title).sort()).toEqual(['Bank', 'GitHub']);
    const github = list.find((item) => item.title === 'GitHub')!;
    await expect(reopened.revealPassword(github.id)).resolves.toBe('Pass-1-Aa1!');
  });

  it('A 机器的 .kirk 文件同样能重设（与恢复码等价）', async () => {
    const a = await buildMachineA();
    const b = await buildMachineB();
    await b.client.importBackup({
      kirkJson: a.backup,
      password: A_MASTER,
      mode: 'overwrite',
      masterPassword: B_TEMP,
    });

    const restored = newClient(b.storage);
    await restored.resetMasterPasswordWithKirk({ kirkJson: a.kirkJson, newPassword: NEW_MASTER });

    const reopened = newClient(b.storage);
    await reopened.unlock(NEW_MASTER);
    await expect(reopened.listItems()).resolves.toHaveLength(2);
  });

  it('B 机器自己的旧恢复码不能用来开导入后的库（恢复密钥确实被换掉了）', async () => {
    const a = await buildMachineA();
    const storage = new MemoryVaultStorage();
    const b = newClient(storage);
    const bInit = await b.initialize({ masterPassword: B_TEMP });

    await b.importBackup({
      kirkJson: a.backup,
      password: A_MASTER,
      mode: 'overwrite',
      masterPassword: B_TEMP,
    });

    const restored = newClient(storage);
    // 用 B 建库时拿到的恢复码去重设：必须失败，否则说明密钥槽没真的被替换。
    await expect(
      restored.resetMasterPassword({ recoveryCode: bInit.recoveryCode, newPassword: NEW_MASTER }),
    ).rejects.toThrow();
  });
});
