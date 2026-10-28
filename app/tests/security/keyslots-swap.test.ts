/**
 * 对抗性测试 · 双密钥槽调换与参数篡改（SDD §4.1 / FR-08）。
 *
 * 攻击者模型：能改磁盘上的 keyslots 记录（改槽标签、交换 A/B 槽、降级参数版本），
 * 但不能拿到主密码或恢复密钥。目标是证明这些篡改都会被认证拒绝，
 * 且"改主密码只重写 A 槽"不会误伤 B 槽。
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  ARGON2_TEST_PARAMS,
  base64ToBytes,
  deriveKey,
  randomBytes,
  type Argon2Params,
} from '../../src/core/crypto';
import {
  createDek,
  createKeyslots,
  deriveKekFromPassword,
  isKeyslotsBundle,
  rewrapPasswordSlot,
  rewrapRecoverySlot,
  unwrapDek,
  unwrapDekWithPassword,
  unwrapDekWithRecoveryKey,
  wrapDek,
  type KeyslotsBundle,
} from '../../src/core/vault/keyslots';

/** 虚构主密码（仅用于测试，不涉及任何真实账号）。 */
const MASTER_PASSWORD = 'Fixture-Master-1';
const NEXT_PASSWORD = 'Fixture-Master-2';

const NOW = 1_700_000_000_000;

let bundle: KeyslotsBundle;
let dek: Uint8Array;
let recoveryKey: Uint8Array;

beforeAll(async () => {
  dek = createDek();
  recoveryKey = randomBytes(32);
  bundle = await createKeyslots({
    dek,
    masterPassword: MASTER_PASSWORD,
    recoveryKey,
    now: NOW,
    passwordParams: ARGON2_TEST_PARAMS,
    recoveryParams: ARGON2_TEST_PARAMS,
  });
});

describe('对抗性 · 密钥槽调换', () => {
  it('把 A 槽与 B 槽整条互换后，两个入口都无法解包', async () => {
    const swapped: KeyslotsBundle = { password: bundle.recovery, recovery: bundle.password };

    await expect(unwrapDekWithPassword(swapped, MASTER_PASSWORD)).rejects.toMatchObject({
      code: 'CRYPTO_FAILED',
    });
    await expect(unwrapDekWithRecoveryKey(swapped, recoveryKey)).rejects.toMatchObject({
      code: 'CRYPTO_FAILED',
    });
  });

  it('交换后再把 slot 标签改写成 password，仍然失败（KEK 不同）', async () => {
    const forged = { ...bundle.recovery, slot: 'password' as const };
    const kekA = await deriveKekFromPassword(
      MASTER_PASSWORD,
      base64ToBytes(bundle.password.salt),
      ARGON2_TEST_PARAMS,
    );

    await expect(unwrapDek(forged, kekA)).rejects.toMatchObject({ code: 'CRYPTO_FAILED' });
  });

  it('只改 slot 标签（KEK 正确）也会失败：AAD 绑定槽名', async () => {
    const relabeled = { ...bundle.password, slot: 'recovery' as const };
    const kekA = await deriveKekFromPassword(
      MASTER_PASSWORD,
      base64ToBytes(bundle.password.salt),
      ARGON2_TEST_PARAMS,
    );

    await expect(unwrapDek(relabeled, kekA)).rejects.toMatchObject({ code: 'CRYPTO_FAILED' });
  });

  it('isKeyslotsBundle 拒绝标签错位的集合（加载期第一道防线）', () => {
    expect(isKeyslotsBundle(bundle)).toBe(true);
    expect(isKeyslotsBundle({ password: bundle.recovery, recovery: bundle.password })).toBe(false);
  });

  it('A / B 槽各自使用独立 salt 与 nonce', () => {
    expect(bundle.password.salt).not.toBe(bundle.recovery.salt);
    expect(bundle.password.nonce).not.toBe(bundle.recovery.nonce);
    expect(base64ToBytes(bundle.password.salt).length).toBe(16);
    expect(base64ToBytes(bundle.recovery.salt).length).toBe(16);
  });

  it('包装后的 DEK 不等于明文 DEK（落盘内容不含原始密钥）', () => {
    const wrapped = base64ToBytes(bundle.password.wrappedDek);
    expect(wrapped.length).toBeGreaterThan(dek.length);
    expect(Buffer.from(wrapped).equals(Buffer.from(dek))).toBe(false);
  });
});

describe('对抗性 · 槽记录参数篡改', () => {
  it('未知 kdfParams 版本被拒绝（不能静默降级）', async () => {
    const forged = {
      ...bundle.password,
      kdfParams: { ...bundle.password.kdfParams, version: 99 },
    };
    const kekA = await deriveKekFromPassword(
      MASTER_PASSWORD,
      base64ToBytes(bundle.password.salt),
      ARGON2_TEST_PARAMS,
    );

    await expect(unwrapDek(forged, kekA)).rejects.toMatchObject({ code: 'UNSUPPORTED_VERSION' });
  });

  it('kdfParams 结构非法（算法被换 / 缺字段）被拒绝', async () => {
    const kekA = await deriveKekFromPassword(
      MASTER_PASSWORD,
      base64ToBytes(bundle.password.salt),
      ARGON2_TEST_PARAMS,
    );

    const wrongAlgorithm = {
      ...bundle.password,
      kdfParams: { ...bundle.password.kdfParams, algorithm: 'argon2i' } as unknown as Argon2Params,
    };
    await expect(unwrapDek(wrongAlgorithm, kekA)).rejects.toMatchObject({
      code: 'UNSUPPORTED_VERSION',
    });

    const missingIterations = {
      ...bundle.password,
      kdfParams: { ...bundle.password.kdfParams, iterations: undefined } as unknown as Argon2Params,
    };
    await expect(unwrapDek(missingIterations, kekA)).rejects.toMatchObject({
      code: 'UNSUPPORTED_VERSION',
    });
  });

  it('密钥槽格式版本被升级到未知值时拒绝', async () => {
    const kekA = await deriveKekFromPassword(
      MASTER_PASSWORD,
      base64ToBytes(bundle.password.salt),
      ARGON2_TEST_PARAMS,
    );

    await expect(unwrapDek({ ...bundle.password, version: 2 }, kekA)).rejects.toMatchObject({
      code: 'UNSUPPORTED_VERSION',
    });
  });

  it('wrapDek 拒绝非 16 字节 salt，deriveKey 拒绝短于 8 字节的 salt', async () => {
    const kek = randomBytes(32);

    await expect(
      wrapDek(dek, kek, 'password', ARGON2_TEST_PARAMS, randomBytes(8), NOW),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    await expect(
      deriveKey(MASTER_PASSWORD, randomBytes(4), ARGON2_TEST_PARAMS),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('对抗性 · 改密 / 轮换只动自己的槽', () => {
  it('重写 A 槽后 B 槽逐字段不变，且 A 槽换了 salt 与 nonce', async () => {
    const before = bundle.recovery;
    const rewritten = await rewrapPasswordSlot(dek, NEXT_PASSWORD, NOW + 1, ARGON2_TEST_PARAMS);

    expect(rewritten.salt).not.toBe(bundle.password.salt);
    expect(rewritten.nonce).not.toBe(bundle.password.nonce);
    expect(rewritten.slot).toBe('password');
    // B 槽必须原样保留，否则恢复码会失效
    expect(bundle.recovery).toEqual(before);
  });

  it('重写 B 槽后 A 槽逐字段不变，且新恢复密钥可解包、旧密钥失效', async () => {
    const before = bundle.password;
    const nextRecoveryKey = randomBytes(32);
    const rewritten = await rewrapRecoverySlot(
      dek,
      nextRecoveryKey,
      NOW + 2,
      ARGON2_TEST_PARAMS,
    );
    const nextBundle: KeyslotsBundle = { password: bundle.password, recovery: rewritten };

    expect(nextBundle.password).toEqual(before);
    expect(rewritten.nonce).not.toBe(bundle.recovery.nonce);

    const unwrapped = await unwrapDekWithRecoveryKey(nextBundle, nextRecoveryKey);
    expect(Buffer.from(unwrapped).equals(Buffer.from(dek))).toBe(true);

    await expect(unwrapDekWithRecoveryKey(nextBundle, recoveryKey)).rejects.toMatchObject({
      code: 'CRYPTO_FAILED',
    });
  });
});
