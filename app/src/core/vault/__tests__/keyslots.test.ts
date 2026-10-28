import { describe, expect, it } from 'vitest';
import { ARGON2_TEST_PARAMS, base64ToBytes } from '../../crypto';
import { randomBytes } from '../../crypto/random';
import {
  KEYSLOT_VERSION,
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
} from '../keyslots';

const MASTER_PASSWORD = 'Master-Pass-1';
const NEW_PASSWORD = 'Master-Pass-2';
const PARAMS = ARGON2_TEST_PARAMS;

/** 创建一组测试用密钥槽。 */
async function createBundle() {
  const dek = createDek();
  const recoveryKey = randomBytes(32);
  const bundle = await createKeyslots({
    dek,
    masterPassword: MASTER_PASSWORD,
    recoveryKey,
    now: 1_700_000_000_000,
    passwordParams: PARAMS,
    recoveryParams: PARAMS,
  });
  return { dek, recoveryKey, bundle };
}

describe('双密钥槽', () => {
  it('DEK 为 32 字节，两个密钥槽都能解包出同一 DEK', async () => {
    const { dek, recoveryKey, bundle } = await createBundle();

    expect(dek.length).toBe(32);
    const fromPassword = await unwrapDekWithPassword(bundle, MASTER_PASSWORD);
    const fromRecovery = await unwrapDekWithRecoveryKey(bundle, recoveryKey);

    expect(base64ToBytes(bundle.password.wrappedDek).length).toBeGreaterThan(dek.length);
    expect(Buffer.from(fromPassword).toString('hex')).toBe(Buffer.from(dek).toString('hex'));
    expect(Buffer.from(fromRecovery).toString('hex')).toBe(Buffer.from(dek).toString('hex'));
  });

  it('两个密钥槽使用独立 salt 与独立参数记录', async () => {
    const { bundle } = await createBundle();

    expect(bundle.password.salt).not.toBe(bundle.recovery.salt);
    expect(bundle.password.nonce).not.toBe(bundle.recovery.nonce);
    expect(bundle.password.slot).toBe('password');
    expect(bundle.recovery.slot).toBe('recovery');
    expect(bundle.password.version).toBe(KEYSLOT_VERSION);
    expect(bundle.password.kdfParams.version).toBe(PARAMS.version);
    expect(bundle.recovery.kdfParams.algorithm).toBe('argon2id');
  });

  it('修改主密码后旧密码失效、恢复密钥仍有效', async () => {
    const { dek, recoveryKey, bundle } = await createBundle();
    const newPasswordSlot = await rewrapPasswordSlot(dek, NEW_PASSWORD, 1_700_000_001_000, PARAMS);
    const updated = { ...bundle, password: newPasswordSlot };

    await expect(unwrapDekWithPassword(updated, MASTER_PASSWORD)).rejects.toMatchObject({
      code: 'CRYPTO_FAILED',
    });
    await expect(unwrapDekWithPassword(updated, NEW_PASSWORD)).resolves.toBeInstanceOf(Uint8Array);
    await expect(unwrapDekWithRecoveryKey(updated, recoveryKey)).resolves.toBeInstanceOf(Uint8Array);

    // B 槽未被改写
    expect(updated.recovery.wrappedDek).toBe(bundle.recovery.wrappedDek);
    expect(updated.recovery.salt).toBe(bundle.recovery.salt);
  });

  it('轮换恢复密钥后旧恢复密钥失效、主密码仍有效', async () => {
    const { dek, recoveryKey, bundle } = await createBundle();
    const newRecoveryKey = randomBytes(32);
    const newRecoverySlot = await rewrapRecoverySlot(dek, newRecoveryKey, 1_700_000_002_000, PARAMS);
    const updated = { ...bundle, recovery: newRecoverySlot };

    await expect(unwrapDekWithRecoveryKey(updated, recoveryKey)).rejects.toMatchObject({
      code: 'CRYPTO_FAILED',
    });
    await expect(unwrapDekWithRecoveryKey(updated, newRecoveryKey)).resolves.toBeInstanceOf(Uint8Array);
    await expect(unwrapDekWithPassword(updated, MASTER_PASSWORD)).resolves.toBeInstanceOf(Uint8Array);

    expect(updated.password.wrappedDek).toBe(bundle.password.wrappedDek);
  });

  it('密钥槽 AAD 绑定槽名，交换槽名后无法解包', async () => {
    const { bundle } = await createBundle();
    const kek = await deriveKekFromPassword(
      MASTER_PASSWORD,
      base64ToBytes(bundle.password.salt),
      PARAMS,
    );
    const swapped = { ...bundle.password, slot: 'recovery' as const };

    await expect(unwrapDek(swapped, kek)).rejects.toMatchObject({ code: 'CRYPTO_FAILED' });
  });

  it('不支持的密钥槽版本被拒绝', async () => {
    const { bundle } = await createBundle();
    const kek = await deriveKekFromPassword(
      MASTER_PASSWORD,
      base64ToBytes(bundle.password.salt),
      PARAMS,
    );
    await expect(unwrapDek({ ...bundle.password, version: 2 }, kek)).rejects.toMatchObject({
      code: 'UNSUPPORTED_VERSION',
    });
  });

  it('wrapDek 拒绝非 32 字节 DEK 与非标准 salt', async () => {
    const kek = randomBytes(32);
    await expect(
      wrapDek(new Uint8Array(16), kek, 'password', PARAMS, randomBytes(16), 0),
    ).rejects.toMatchObject({ code: 'CRYPTO_FAILED' });
    await expect(
      wrapDek(randomBytes(32), kek, 'password', PARAMS, randomBytes(8), 0),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('密钥槽集合结构校验能识别脏数据', async () => {
    const { bundle } = await createBundle();
    expect(isKeyslotsBundle(bundle)).toBe(true);
    expect(isKeyslotsBundle(null)).toBe(false);
    expect(isKeyslotsBundle({ password: bundle.password })).toBe(false);
    expect(isKeyslotsBundle({ ...bundle, recovery: { ...bundle.recovery, slot: 'password' } })).toBe(false);
  });
});
