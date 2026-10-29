/**
 * 资产服务：CRUD、三档可见性、收藏。
 *
 * 安全边界：
 * - 明文只存在于解锁态内存（`ItemService` 实例生命周期内）。
 * - 每次写操作都会把整表重新加密后交给 `ItemStorePort`，绝不落明文。
 * - `hidden` 资产不进入普通列表；访问详情需显式 `allowHidden` 授权。
 */

import { errors } from '../errors';
import { decryptItem, encryptItem } from './item-codec';
import { passwordLevel } from './policy';
import {
  VISIBILITY_VALUES,
  type CreateItemInput,
  type EncryptedItemRecord,
  type ItemDetail,
  type ItemPlain,
  type ItemSecretFieldName,
  type ItemSummary,
  type UpdateItemInput,
  type Visibility,
} from './types';

/** 默认分类（PRD 预设之一）。 */
export const DEFAULT_CATEGORY = '其他';

/** 字段长度上限，避免异常数据破坏 UI 与存储。 */
export const ITEM_LIMITS = Object.freeze({
  title: 120,
  platform: 120,
  url: 2048,
  appPath: 512,
  username: 256,
  password: 512,
  notes: 4000,
  category: 40,
  tag: 32,
  tags: 20,
});

/** 持久化端口：只接受密文记录。 */
export interface ItemStorePort {
  loadItems(): Promise<EncryptedItemRecord[]>;
  saveItems(records: EncryptedItemRecord[]): Promise<void>;
}

/** 资产服务依赖。 */
export interface ItemServiceOptions {
  dek: Uint8Array;
  now: () => number;
  store: ItemStorePort;
}

/** 详情读取选项。 */
export interface GetDetailOptions {
  /** 隐藏卡片必须显式授权后才能读取。 */
  allowHidden?: boolean;
  /** 是否返回备注，默认返回（详情即显式查看）。 */
  includeNotes?: boolean;
}

/** 把可选文本归一化：去首尾空格，空串视为 null。 */
function normalizeOptionalText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** 校验必填文本。 */
function requireText(value: string | null | undefined, maxLength: number, messageKey: string): string {
  if (typeof value !== 'string') {
    throw errors.validationFailed(messageKey);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) {
    throw errors.validationFailed(messageKey);
  }
  return trimmed;
}

/** 校验可选文本长度。 */
function optionalText(
  value: string | null | undefined,
  maxLength: number,
  messageKey: string,
): string | null {
  const normalized = normalizeOptionalText(value);
  if (normalized === null) {
    return null;
  }
  if (normalized.length > maxLength) {
    throw errors.validationFailed(messageKey);
  }
  return normalized;
}

/** 校验可见性取值。 */
export function parseVisibility(value: unknown): Visibility {
  if (typeof value !== 'string' || !VISIBILITY_VALUES.includes(value as Visibility)) {
    throw errors.validationFailed('error.invalid_visibility');
  }
  return value as Visibility;
}

/** 归一化标签数组。 */
function normalizeTags(tags: string[] | null | undefined): string[] {
  if (tags === null || tags === undefined) {
    return [];
  }
  if (!Array.isArray(tags)) {
    throw errors.validationFailed('error.invalid_tags');
  }
  const result: string[] = [];
  for (const tag of tags) {
    if (typeof tag !== 'string') {
      throw errors.validationFailed('error.invalid_tags');
    }
    const trimmed = tag.trim();
    if (trimmed.length === 0) {
      continue;
    }
    if (trimmed.length > ITEM_LIMITS.tag) {
      throw errors.validationFailed('error.tag_too_long');
    }
    if (!result.includes(trimmed)) {
      result.push(trimmed);
    }
  }
  if (result.length > ITEM_LIMITS.tags) {
    throw errors.validationFailed('error.too_many_tags');
  }
  return result;
}

/** 校验密码字段：允许空格，但不得为空。 */
function requirePassword(value: string | null | undefined): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw errors.validationFailed('error.password_required');
  }
  if (value.length > ITEM_LIMITS.password) {
    throw errors.validationFailed('error.password_too_long');
  }
  return value;
}

/** 明文资产 → 摘要（不含密码）。 */
export function toItemSummary(item: ItemPlain): ItemSummary {
  const summary: ItemSummary = {
    id: item.id,
    title: item.title,
    platform: item.platform,
    category: item.category,
    tags: [...item.tags],
    favorite: item.favorite,
    visibility: item.visibility,
    updatedAt: item.updatedAt,
    hasUrl: item.url !== null,
    hasAppTarget: item.appPath !== null,
    strength: item.strength,
  };
  if (item.visibility !== 'hidden') {
    summary.username = item.username;
  }
  return summary;
}

/** 明文资产 → 详情（不含密码）。 */
function toItemDetail(item: ItemPlain, includeNotes: boolean): ItemDetail {
  const detail: ItemDetail = {
    ...toItemSummary(item),
    url: item.url,
    appPath: item.appPath,
    passwordUpdatedAt: item.passwordUpdatedAt,
  };
  // 详情读取已通过隐藏卡片授权校验，因此始终返回账号。
  detail.username = item.username;
  if (includeNotes && item.notes !== null) {
    detail.notes = item.notes;
  }
  return detail;
}

/** 资产服务。 */
export class ItemService {
  private readonly items = new Map<number, ItemPlain>();

  private nextId = 1;

  private hydrated = false;

  private readonly dek: Uint8Array;

  private readonly now: () => number;

  private readonly store: ItemStorePort;

  constructor(options: ItemServiceOptions) {
    this.dek = options.dek;
    this.now = options.now;
    this.store = options.store;
  }

  /** 从存储加载并解密全部资产；幂等。 */
  async hydrate(): Promise<void> {
    if (this.hydrated) {
      return;
    }
    const records = await this.store.loadItems();
    for (const record of records) {
      const item = await decryptItem(record, this.dek);
      this.items.set(item.id, item);
      if (item.id >= this.nextId) {
        this.nextId = item.id + 1;
      }
    }
    this.hydrated = true;
  }

  /** 当前内存中的资产数量（含隐藏卡片）。 */
  size(): number {
    return this.items.size;
  }

  /** 创建单个资产。 */
  async createItem(input: CreateItemInput): Promise<ItemSummary> {
    const created = await this.createItems([input]);
    return created[0];
  }

  /** 批量创建资产：所有输入先校验，最后只写盘一次，避免导入半途留下半批数据。 */
  async createItems(inputs: readonly CreateItemInput[]): Promise<ItemSummary[]> {
    await this.hydrate();
    if (inputs.length === 0) {
      return [];
    }
    const now = this.now();
    const originalNextId = this.nextId;
    const created: ItemPlain[] = [];
    try {
      for (const input of inputs) {
        const id = this.nextId;
        const item: ItemPlain = {
          id,
          title: requireText(input.title, ITEM_LIMITS.title, 'error.title_required'),
          platform: optionalText(input.platform, ITEM_LIMITS.platform, 'error.platform_too_long'),
          url: optionalText(input.url, ITEM_LIMITS.url, 'error.url_too_long'),
          appPath: optionalText(input.appPath, ITEM_LIMITS.appPath, 'error.app_path_too_long'),
          username: requireText(input.username, ITEM_LIMITS.username, 'error.username_required'),
          password: requirePassword(input.password),
          notes: optionalText(input.notes, ITEM_LIMITS.notes, 'error.notes_too_long'),
          category:
            optionalText(input.category, ITEM_LIMITS.category, 'error.category_too_long') ?? DEFAULT_CATEGORY,
          tags: normalizeTags(input.tags),
          visibility: input.visibility === undefined ? 'normal' : parseVisibility(input.visibility),
          favorite: input.favorite === true,
          passwordUpdatedAt: now,
          createdAt: now,
          updatedAt: now,
          strength: passwordLevel(input.password),
        };
        this.items.set(id, item);
        this.nextId = id + 1;
        created.push(item);
      }
      await this.flush();
      return created.map(toItemSummary);
    } catch (error) {
      for (const item of created) {
        this.items.delete(item.id);
      }
      this.nextId = originalNextId;
      throw error;
    }
  }

  /** 更新资产；未传 `visibility` 时保持原值（降级保护）。 */
  async updateItem(id: number, input: UpdateItemInput): Promise<ItemSummary> {
    await this.hydrate();
    const existing = this.requireItem(id);
    const now = this.now();

    const next: ItemPlain = { ...existing };

    if (input.title !== undefined) {
      next.title = requireText(input.title, ITEM_LIMITS.title, 'error.title_required');
    }
    if (input.platform !== undefined) {
      next.platform = optionalText(input.platform, ITEM_LIMITS.platform, 'error.platform_too_long');
    }
    if (input.url !== undefined) {
      next.url = optionalText(input.url, ITEM_LIMITS.url, 'error.url_too_long');
    }
    if (input.appPath !== undefined) {
      next.appPath = optionalText(input.appPath, ITEM_LIMITS.appPath, 'error.app_path_too_long');
    }
    if (input.username !== undefined) {
      next.username = requireText(input.username, ITEM_LIMITS.username, 'error.username_required');
    }
    if (input.password !== undefined) {
      const password = requirePassword(input.password);
      if (password !== existing.password) {
        next.password = password;
        next.passwordUpdatedAt = now;
        // 密码变了，强度档位必须跟着重算——否则卡片上会显示过时的档位。
        next.strength = passwordLevel(password);
      }
    }
    if (input.notes !== undefined) {
      next.notes = optionalText(input.notes, ITEM_LIMITS.notes, 'error.notes_too_long');
    }
    if (input.category !== undefined) {
      next.category =
        optionalText(input.category, ITEM_LIMITS.category, 'error.category_too_long') ?? DEFAULT_CATEGORY;
    }
    if (input.tags !== undefined) {
      next.tags = normalizeTags(input.tags);
    }
    if (input.visibility !== undefined) {
      next.visibility = parseVisibility(input.visibility);
    }
    if (input.favorite !== undefined) {
      next.favorite = input.favorite === true;
    }

    next.updatedAt = now;
    this.items.set(id, next);
    await this.flush();
    return toItemSummary(next);
  }

  /** 删除资产。 */
  async deleteItem(id: number): Promise<void> {
    await this.hydrate();
    if (!this.items.has(id)) {
      throw errors.itemNotFound();
    }
    this.items.delete(id);
    await this.flush();
  }

  /**
   * 批量删除：一次 flush，要么全删要么全不删。
   *
   * 与 `deleteItem` 的差别：不存在的 id 静默跳过，不抛 `ITEM_NOT_FOUND`。
   * 批量场景里只要有一条失效就整体失败，用户会陷入"删不掉也说不清为什么"的困境。
   *
   * 原子性来自 `flush()`：它是**一次整体写盘**，不是逐条写。所以这里刻意
   * 不用 `for (id) await this.deleteItem(id)` 的循环——那样每条都写一次盘，
   * 中途抛错（或进程被杀）会留下"删了一半"的状态，而且 N 条要付 N 次 I/O。
   *
   * @param ids 待删除的 id（允许重复、允许不存在）。
   * @returns 实际被删除的 id（顺序与入参一致）。
   */
  async deleteMany(ids: readonly number[]): Promise<number[]> {
    await this.hydrate();
    const removed: number[] = [];
    for (const id of ids) {
      if (this.items.delete(id)) {
        removed.push(id);
      }
    }
    if (removed.length > 0) {
      await this.flush();
    }
    return removed;
  }

  /** 读取详情；隐藏卡片必须显式授权。 */
  async getDetail(id: number, options: GetDetailOptions = {}): Promise<ItemDetail> {
    await this.hydrate();
    const item = this.requireItem(id);
    if (item.visibility === 'hidden' && options.allowHidden !== true) {
      throw errors.itemHidden();
    }
    return toItemDetail(item, options.includeNotes !== false);
  }

  /** 读取摘要；隐藏卡片必须显式授权。 */
  async getSummary(id: number, options: GetDetailOptions = {}): Promise<ItemSummary> {
    await this.hydrate();
    const item = this.requireItem(id);
    if (item.visibility === 'hidden' && options.allowHidden !== true) {
      throw errors.itemHidden();
    }
    return toItemSummary(item);
  }

  /**
   * 列出资产。
   * 默认排除 `hidden`；`includeHidden` 仅用于隐藏卡片列表（需二次认证）。
   */
  async list(options: { includeHidden?: boolean } = {}): Promise<ItemSummary[]> {
    await this.hydrate();
    const result: ItemSummary[] = [];
    for (const item of this.items.values()) {
      if (item.visibility === 'hidden' && options.includeHidden !== true) {
        continue;
      }
      result.push(toItemSummary(item));
    }
    return result.sort((left, right) => right.updatedAt - left.updatedAt || right.id - left.id);
  }

  /** 设置收藏。 */
  async setFavorite(id: number, favorite: boolean): Promise<ItemSummary> {
    await this.hydrate();
    const item = this.requireItem(id);
    const next: ItemPlain = { ...item, favorite, updatedAt: this.now() };
    this.items.set(id, next);
    await this.flush();
    return toItemSummary(next);
  }

  /** 设置可见性。 */
  async setVisibility(id: number, visibility: Visibility): Promise<ItemSummary> {
    await this.hydrate();
    const item = this.requireItem(id);
    const next: ItemPlain = {
      ...item,
      visibility: parseVisibility(visibility),
      updatedAt: this.now(),
    };
    this.items.set(id, next);
    await this.flush();
    return toItemSummary(next);
  }

  /**
   * 预览密码明文。
   * `username_only` 一律不允许预览（该档位靠复制取用）；
   * `hidden` 需要显式授权，与 `getDetail` 的 `allowHidden` 同一语义。
   */
  async revealPassword(id: number, options: GetDetailOptions = {}): Promise<string> {
    await this.hydrate();
    const item = this.requireItem(id);
    if (item.visibility === 'username_only') {
      throw errors.itemHidden();
    }
    if (item.visibility === 'hidden' && options.allowHidden !== true) {
      throw errors.itemHidden();
    }
    return item.password;
  }

  /** 预览账号。`hidden` 卡片需要授权，其他档位常显。 */
  async revealUsername(id: number, options: GetDetailOptions = {}): Promise<string> {
    await this.hydrate();
    const item = this.requireItem(id);
    if (item.visibility === 'hidden' && options.allowHidden !== true) {
      throw errors.itemHidden();
    }
    return item.username;
  }

  /**
   * 取用于复制的字段值（内部路径，不返回给 UI 展示）。
   * `hidden` 需要授权；`username_only` 允许复制密码（这正是该档位的用途）。
   */
  async copySecret(
    id: number,
    field: ItemSecretFieldName,
    options: GetDetailOptions = {},
  ): Promise<{ value: string; visibility: Visibility }> {
    await this.hydrate();
    const item = this.requireItem(id);
    if (item.visibility === 'hidden' && options.allowHidden !== true) {
      throw errors.itemHidden();
    }
    const value = field === 'password' ? item.password : item.username;
    return { value, visibility: item.visibility };
  }

  /** 清空内存明文缓存（锁定时调用）。 */
  dispose(): void {
    this.items.clear();
    this.hydrated = false;
  }

  /** 读取资产，不存在则抛 `ITEM_NOT_FOUND`。 */
  private requireItem(id: number): ItemPlain {
    const item = this.items.get(id);
    if (!item) {
      throw errors.itemNotFound();
    }
    return item;
  }

  /** 把当前内存资产整体加密后写回存储。 */
  private async flush(): Promise<void> {
    const records: EncryptedItemRecord[] = [];
    for (const item of this.items.values()) {
      records.push(await encryptItem(item, this.dek));
    }
    try {
      await this.store.saveItems(records);
    } catch {
      throw errors.storageFailed();
    }
  }
}
