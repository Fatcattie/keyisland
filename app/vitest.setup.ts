import '@testing-library/jest-dom/vitest';
import { webcrypto } from 'node:crypto';

/**
 * jsdom 只实现了 `crypto.getRandomValues`，没有 `crypto.subtle`。
 * 为了让加密测试与浏览器行为一致，这里补齐 Node 的 WebCrypto 实现。
 */
const globalCrypto = globalThis.crypto as Crypto | undefined;
if (!globalCrypto || !globalCrypto.subtle) {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto as unknown as Crypto,
    configurable: true,
    writable: true,
  });
}
