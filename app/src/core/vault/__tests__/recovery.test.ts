import { describe, expect, it } from 'vitest';
import {
  KIRK_MAGIC,
  KIRK_VERSION,
  RECOVERY_CODE_LENGTH,
  createKirkFile,
  createRecoveryMaterial,
  decodeRecoveryCode,
  deriveRecoveryKey,
  encodeRecoveryCode,
  formatRecoveryCode,
  generateRecoverySecret,
  isValidRecoveryCodeFormat,
  normalizeRecoveryCode,
  parseKirkFile,
  recoveryKeyFromCode,
  serializeKirkFile,
} from '../recovery';
import { base64ToBytes, bytesToBase64 } from '../../crypto/encoding';

const NOW = 1_700_000_000_000;

describe('恢复码', () => {
  it('生成 32 位分组恢复码（8 组 4 位）', async () => {
    const material = await createRecoveryMaterial(NOW);

    expect(material.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){7}$/u);
    expect(normalizeRecoveryCode(material.code)).toHaveLength(RECOVERY_CODE_LENGTH);
  });

  it('归一化处理大小写、空格、连字符与易混淆字符', () => {
    expect(normalizeRecoveryCode(' abcd-efgh  jkmn ')).toBe('ABCDEFGHJKMN');
    expect(normalizeRecoveryCode('oil')).toBe('011');
    expect(normalizeRecoveryCode('O-I-L')).toBe('011');
    expect(normalizeRecoveryCode('u')).toBe('V');
  });

  it('格式校验：长度与字母表', () => {
    const secret = generateRecoverySecret();
    const code = encodeRecoveryCode(secret);

    expect(isValidRecoveryCodeFormat(code)).toBe(true);
    expect(isValidRecoveryCodeFormat(code.toLowerCase())).toBe(true);
    expect(isValidRecoveryCodeFormat('ABCD')).toBe(false);
    expect(isValidRecoveryCodeFormat('!'.repeat(RECOVERY_CODE_LENGTH))).toBe(false);
  });

  it('编码与解码可往返', () => {
    const secret = generateRecoverySecret();
    const decoded = decodeRecoveryCode(encodeRecoveryCode(secret));
    expect(bytesToBase64(decoded)).toBe(bytesToBase64(secret));
  });

  it('非法字符或长度抛 RECOVERY_CODE_INVALID', () => {
    expect(() => decodeRecoveryCode('!'.repeat(RECOVERY_CODE_LENGTH))).toThrowError(
      expect.objectContaining({ code: 'RECOVERY_CODE_INVALID' }),
    );
    expect(() => decodeRecoveryCode('ABCD')).toThrowError(
      expect.objectContaining({ code: 'RECOVERY_CODE_INVALID' }),
    );
  });

  it('恢复码与恢复密钥等价（同一秘密）', async () => {
    const material = await createRecoveryMaterial(NOW);
    const fromCode = await recoveryKeyFromCode(material.code);

    expect(bytesToBase64(fromCode)).toBe(bytesToBase64(material.recoveryKey));
    expect(fromCode).toHaveLength(32);
  });

  it('格式化输出保持 8 组 4 位', async () => {
    const material = await createRecoveryMaterial(NOW);
    expect(formatRecoveryCode(normalizeRecoveryCode(material.code))).toBe(material.code);
  });

  it('deriveRecoveryKey 拒绝非 20 字节秘密', async () => {
    await expect(deriveRecoveryKey(new Uint8Array(32))).rejects.toMatchObject({
      code: 'RECOVERY_CODE_INVALID',
    });
  });
});

describe('.kirk 恢复密钥文件', () => {
  it('包含 magic、版本、创建时间与恢复密钥，不含主密码', async () => {
    const material = await createRecoveryMaterial(NOW);

    expect(material.kirk.magic).toBe(KIRK_MAGIC);
    expect(material.kirk.version).toBe(KIRK_VERSION);
    expect(material.kirk.createdAt).toBe(NOW);
    expect(base64ToBytes(material.kirk.recoveryKey)).toHaveLength(32);

    const text = material.kirkJson;
    expect(text).toContain(KIRK_MAGIC);
    expect(text).not.toContain('masterPassword');
    expect(text).not.toContain('password');
  });

  it('序列化与解析可往返', async () => {
    const material = await createRecoveryMaterial(NOW);
    const parsed = parseKirkFile(serializeKirkFile(material.kirk));

    expect(parsed).toEqual(material.kirk);
  });

  it('magic 不匹配时拒绝解析', async () => {
    const material = await createRecoveryMaterial(NOW);
    const broken = JSON.stringify({ ...material.kirk, magic: 'KIRK2' });

    expect(() => parseKirkFile(broken)).toThrowError(
      expect.objectContaining({ code: 'RECOVERY_CODE_INVALID' }),
    );
  });

  it('版本不支持时拒绝解析', async () => {
    const material = await createRecoveryMaterial(NOW);
    const broken = JSON.stringify({ ...material.kirk, version: 2 });

    expect(() => parseKirkFile(broken)).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_VERSION' }),
    );
  });

  it('非 JSON 或密钥长度异常时拒绝解析', async () => {
    expect(() => parseKirkFile('not-json')).toThrowError(
      expect.objectContaining({ code: 'RECOVERY_CODE_INVALID' }),
    );
    const material = await createRecoveryMaterial(NOW);
    const broken = JSON.stringify({ ...material.kirk, recoveryKey: bytesToBase64(new Uint8Array(16)) });
    expect(() => parseKirkFile(broken)).toThrowError(
      expect.objectContaining({ code: 'RECOVERY_CODE_INVALID' }),
    );
  });

  it('createKirkFile 拒绝非 32 字节密钥', () => {
    expect(() => createKirkFile(new Uint8Array(16), NOW)).toThrowError(
      expect.objectContaining({ code: 'RECOVERY_CODE_INVALID' }),
    );
  });
});
