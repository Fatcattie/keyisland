/**
 * 内存存储的端口契约。
 *
 * 这份断言与 `tauri-storage.contract.test.ts` 完全相同——两个实现必须都过，
 * 才能说"桌面版和浏览器版语义一致"。
 */

import { MemoryVaultStorage } from '../storage';
import { runStorageContract } from './support/storage-contract';

runStorageContract('MemoryVaultStorage（浏览器/测试）', () => new MemoryVaultStorage());
