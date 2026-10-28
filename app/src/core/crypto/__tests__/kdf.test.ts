import { describe, expect, it } from 'vitest';
import {
  ARGON2_PARAMS_V1,
  ARGON2_TEST_PARAMS,
  deriveKey,
  isArgon2Params,
  resolveArgon2Params,
} from '../kdf';
import { randomBytes } from '../random';
import { bytesToBase64 } from '../encoding';

describe('Argon2id 密钥派生', () => {
  it('相同密码与相同 salt 的派生结果可复现', async () => {
    const salt = randomBytes(16);
    const first = await deriveKey('master-pass-1', salt, ARGON2_TEST_PARAMS);
    const second = await deriveKey('master-pass-1', salt, ARGON2_TEST_PARAMS);

    expect(first.length).toBe(32);
    expect(bytesToBase64(first)).toBe(bytesToBase64(second));
  });

  it('不同 salt 的派生结果不同', async () => {
    const password = 'master-pass-1';
    const saltA = randomBytes(16);
    const saltB = randomBytes(16);

    const keyA = await deriveKey(password, saltA, ARGON2_TEST_PARAMS);
    const keyB = await deriveKey(password, saltB, ARGON2_TEST_PARAMS);

    expect(bytesToBase64(keyA)).not.toBe(bytesToBase64(keyB));
  });

  it('不同密码的派生结果不同', async () => {
    const salt = randomBytes(16);
    const keyA = await deriveKey('master-pass-1', salt, ARGON2_TEST_PARAMS);
    const keyB = await deriveKey('master-pass-2', salt, ARGON2_TEST_PARAMS);

    expect(bytesToBase64(keyA)).not.toBe(bytesToBase64(keyB));
  });

  it('支持字节型输入（恢复密钥路径）', async () => {
    const salt = randomBytes(16);
    const secret = randomBytes(32);
    const fromBytes = await deriveKey(secret, salt, ARGON2_TEST_PARAMS);
    const again = await deriveKey(secret, salt, ARGON2_TEST_PARAMS);

    expect(bytesToBase64(fromBytes)).toBe(bytesToBase64(again));
  });

  it('salt 过短时拒绝派生', async () => {
    await expect(deriveKey('master-pass-1', new Uint8Array(4), ARGON2_TEST_PARAMS)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('生产参数为 64 MiB / 3 次迭代并标记版本', () => {
    expect(ARGON2_PARAMS_V1.version).toBe(1);
    expect(ARGON2_PARAMS_V1.memoryKiB).toBe(65536);
    expect(ARGON2_PARAMS_V1.iterations).toBe(3);
    expect(ARGON2_PARAMS_V1.hashLength).toBe(32);
    expect(isArgon2Params(ARGON2_PARAMS_V1)).toBe(true);
  });

  it('未知参数版本解析失败', () => {
    expect(() => resolveArgon2Params({ ...ARGON2_TEST_PARAMS, version: 99 })).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_VERSION' }),
    );
    expect(() => resolveArgon2Params({ memoryKiB: 1 })).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_VERSION' }),
    );
  });
});
