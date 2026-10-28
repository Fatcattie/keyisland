/**
 * KDF 参数上下界回归测试（QA 验收 P2-4）。
 *
 * 背景：密钥槽元数据是可被篡改的输入。只校验下界时，攻击者把 `memoryKiB`
 * 改成 4 GiB、`iterations` 改成 10 万，就能让客户端在"合法派生"里被拖死。
 * 因此所有数值必须落在闭区间内，越界一律视为 `UNSUPPORTED_VERSION`。
 */

import { describe, expect, it } from 'vitest';
import { AppError } from '../../errors';
import {
  ARGON2_PARAMS_V1,
  ARGON2_PARAM_LIMITS,
  ARGON2_TEST_PARAMS,
  isArgon2Params,
  resolveArgon2Params,
  type Argon2Params,
} from '../kdf';

/** 断言参数被拒绝为不支持的版本。 */
function expectUnsupported(params: Argon2Params): void {
  let thrown: unknown = null;
  try {
    resolveArgon2Params(params);
  } catch (error) {
    thrown = error;
  }
  expect(AppError.isAppError(thrown)).toBe(true);
  expect((thrown as AppError).code).toBe('UNSUPPORTED_VERSION');
  expect(isArgon2Params(params)).toBe(false);
}

describe('Argon2id 参数上下界', () => {
  it('内置参数集都合法', () => {
    expect(isArgon2Params(ARGON2_PARAMS_V1)).toBe(true);
    expect(isArgon2Params(ARGON2_TEST_PARAMS)).toBe(true);
    expect(resolveArgon2Params(ARGON2_PARAMS_V1).memoryKiB).toBe(ARGON2_PARAMS_V1.memoryKiB);
  });

  it('memoryKiB 超过上界（1 GiB）被拒绝', () => {
    expectUnsupported({ ...ARGON2_PARAMS_V1, memoryKiB: ARGON2_PARAM_LIMITS.memoryKiBMax + 1 });
  });

  it('iterations 超过上界被拒绝', () => {
    expectUnsupported({ ...ARGON2_PARAMS_V1, iterations: ARGON2_PARAM_LIMITS.iterationsMax + 1 });
  });

  it('parallelism 超过上界被拒绝', () => {
    expectUnsupported({ ...ARGON2_PARAMS_V1, parallelism: ARGON2_PARAM_LIMITS.parallelismMax + 1 });
  });

  it('saltLength 不等于 16 被拒绝', () => {
    expectUnsupported({ ...ARGON2_PARAMS_V1, saltLength: 8 });
    expectUnsupported({ ...ARGON2_PARAMS_V1, saltLength: 32 });
  });

  it('下界与非数值同样被拒绝（NaN 不能绕过区间比较）', () => {
    expectUnsupported({ ...ARGON2_PARAMS_V1, memoryKiB: 0 });
    expectUnsupported({ ...ARGON2_PARAMS_V1, iterations: 0 });
    expectUnsupported({ ...ARGON2_PARAMS_V1, parallelism: 0 });
    expectUnsupported({ ...ARGON2_PARAMS_V1, memoryKiB: Number.NaN });
  });
});
