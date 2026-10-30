/**
 * CSV 导入解析（SDD Phase 5）。
 *
 * 设计约束：
 * - 纯函数、不碰网络与存储，方便单测；
 * - **永远不打印、不缓存密码明文**：解析结果里的 `password` 只在内存中
 *   短暂存在，随后被 `VaultClient.createItem` 逐条加密，之后立即释放；
 * - 无法识别的列不猜：只有标题缺失或凭据缺失的行才会被跳过，并给出原因。
 */

import type { CreateItemInput, Visibility } from './types';
import { DEFAULT_CATEGORIES } from './categories';

/**
 * 导入时的默认值。
 *
 * 语义是**兜底而不是覆盖**：CSV 里写了分类就用 CSV 的，没写才落到默认分类；
 * 隐私档位 CSV 里没有这一列，所以一律用这里的值。
 *
 * 为什么要能选档位：批量导入的账号往往是最该防偷看的（老网站、共享账号），
 * 全都以「普通」进来，等于把风险一次性摊在屏幕上。
 */
export interface CsvImportOptions {
  /** 分类为空时的兜底值，默认「其他」。 */
  defaultCategory?: string;
  /** 所有导入卡片的隐私档位，默认「普通」。 */
  defaultVisibility?: Visibility;
}

/** 可直接用 Excel / WPS 打开的 UTF-8 CSV 模板。 */
export const CSV_TEMPLATE =
  '\uFEFF名称,平台,账号,密码,网址,本地应用目标,分类,标签,备注\r\n';

export function csvTemplateText(): string {
  return CSV_TEMPLATE;
}

/** 解析出的原始行（按列名取值）。 */
export interface CsvRow {
  [column: string]: string;
}

/** 列名映射结果；null 表示不导入该可选字段。 */
export interface CsvColumnMapping {
  title: string;
  username: string;
  password: string;
  url: string | null;
  notes: string | null;
  platform?: string | null;
  appPath?: string | null;
  category?: string | null;
  tags?: string | null;
}

export type CsvFieldKey = keyof CsvColumnMapping;

/**
 * 常见导出格式的表头别名（大小写不敏感、忽略空格与符号）。
 *
 * 别名表就是"用户能直接把别家的导出文件丢进来"的全部家当，所以按真实导出文件补：
 * - Chrome / Edge：`name,url,username,password,note`
 * - LastPass：`url,username,password,extra,name,grouping,fav`
 * - 1Password：`Title,Url,Username,Password,Notes`
 * - Bitwarden：`folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp`
 *
 * Bitwarden 那三个 `login_*` 列是关键：缺了它们，一份完全正常的 Bitwarden 导出会报
 * 「表头缺少名称/账号/密码列」，而数据其实一条不少——这是最容易劝退用户的一种失败。
 * `folder` / `grouping` 都按"分类"收（它们本来就是别家的文件夹）。
 */
const HEADER_ALIASES: Readonly<Record<keyof CsvColumnMapping, readonly string[]>> = Object.freeze({
  title: ['name', 'title', 'account', 'entry', 'item', '名称', '标题', '条目'],
  username: [
    'username',
    'login',
    'user',
    'email',
    'account name',
    'login username',
    '账号',
    '用户名',
  ],
  password: ['password', 'pass', 'login password', '密码'],
  url: ['url', 'website', 'uri', 'login uri', '网址', '链接'],
  notes: ['notes', 'note', 'comment', 'extra', '备注'],
  platform: ['platform', 'service', 'site', '平台'],
  appPath: ['app path', 'apppath', 'local app', '本地应用目标'],
  category: ['category', 'folder', 'grouping', '分类'],
  tags: ['tags', 'tag', '标签'],
});

/** 归一化表头：小写、去掉非字母数字（中文保留）。 */
function normalizeHeader(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/["']/g, '')
    .replace(/[\s_\-.]/g, '');
}

/** 按别名归一化后再匹配，中文别名原样比较。 */
function matchColumn(raw: string, aliases: readonly string[]): string | null {
  const normalized = normalizeHeader(raw);
  const normalizedAlias = aliases.find((alias) => normalizeHeader(alias) === normalized);
  if (normalizedAlias !== undefined) {
    return raw;
  }
  // 中文别名不带空格时直接比较。
  const compact = normalized.replace(/[\s]/g, '');
  return aliases.some((alias) => normalizeHeader(alias) === compact) ? raw : null;
}

/** 解析一段 CSV 文本为行数组（支持引号、转义引号、CRLF、BOM）。 */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  const input = text.replace(/^\uFEFF/, '');

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (inQuotes) {
      if (character === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"') {
      inQuotes = true;
      continue;
    }
    if (character === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (character === '\r') {
      // 统一按 \n 处理，吞掉单独的 \r。
      if (input[index + 1] === '\n') {
        index += 1;
      }
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
      continue;
    }
    if (character === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
      continue;
    }
    field += character;
  }
  row.push(field);
  // 末尾的纯空行（例如文件以换行结尾）不产生记录。
  if (row.length > 1 || row[0].length > 0) {
    rows.push(row);
  }
  return rows;
}

/** 把表头行解析为列名映射；识别不出必需列时抛错。 */
export function resolveCsvColumns(
  header: readonly string[],
  override?: Partial<Record<CsvFieldKey, string | null>>,
): CsvColumnMapping {
  // 手工映射指向不存在的列时立刻报错：静默取空值会让用户以为"导入成功但字段没了"。
  if (override !== undefined) {
    for (const column of Object.values(override)) {
      if (typeof column === 'string' && !header.includes(column)) {
        throw new Error(`CSV 映射指向不存在的列：${column}`);
      }
    }
  }

  const find = (key: keyof CsvColumnMapping): string | null => {
    if (override !== undefined && key in override) {
      return override[key] ?? null;
    }
    for (const column of header) {
      if (matchColumn(column, HEADER_ALIASES[key]) !== null) {
        return column;
      }
    }
    return null;
  };

  const title = find('title');
  const username = find('username');
  const password = find('password');
  if (title === null || username === null || password === null) {
    throw new Error('CSV 表头缺少名称/账号/密码列');
  }
  return {
    title,
    username,
    password,
    url: find('url'),
    notes: find('notes'),
    platform: find('platform'),
    appPath: find('appPath'),
    category: find('category'),
    tags: find('tags'),
  };
}

/** 跳过某一行原因。 */
export interface CsvSkipReason {
  /** 行号（从 1 开始，含表头）。 */
  line: number;
  reason: string;
}

/** 转换结果：可导入的条目 + 被跳过的行。 */
export interface CsvImportPreview {
  items: CreateItemInput[];
  skipped: CsvSkipReason[];
  /** 数据总行数（不含表头）。 */
  totalRows: number;
  /**
   * 本次预览**实际生效**的列映射。
   *
   * 必须回传：界面拿它来回填下拉框，才能保证"显示的就是正在用的"。
   * 否则用户清空某个必填列后，自动识别又把它捡回来，界面显示空、实际却有值。
   */
  mapping: CsvColumnMapping;
}

/** 从 CSV 文本得到待创建条目。跳过项只给原因，不包含任何字段内容。 */
export function previewCsvImport(
  text: string,
  override?: Partial<Record<CsvFieldKey, string | null>>,
  options: CsvImportOptions = {},
): CsvImportPreview {
  const defaultCategory = options.defaultCategory ?? DEFAULT_CATEGORIES[DEFAULT_CATEGORIES.length - 1];
  const defaultVisibility = options.defaultVisibility ?? 'normal';
  const rows = parseCsvRows(text);
  if (rows.length === 0) {
    throw new Error('CSV 文件为空');
  }
  const mapping = resolveCsvColumns(rows[0], override);
  if (mapping.title === null || mapping.username === null || mapping.password === null) {
    throw new Error('CSV 映射缺少名称/账号/密码列');
  }

  const items: CreateItemInput[] = [];
  const skipped: CsvSkipReason[] = [];
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    const get = (column: string | null): string => {
      if (column === null) {
        return '';
      }
      const position = rows[0].indexOf(column);
      return position >= 0 ? (row[position] ?? '').trim() : '';
    };
    const title = get(mapping.title);
    const username = get(mapping.username);
    const password = get(mapping.password);
    const url = get(mapping.url);
    const notes = get(mapping.notes);
    const platform = get(mapping.platform ?? null);
    const appPath = get(mapping.appPath ?? null);
    const category = get(mapping.category ?? null);
    const tags = get(mapping.tags ?? null);

    if (title.length === 0 && username.length === 0) {
      skipped.push({ line: index + 1, reason: '整行为空' });
      continue;
    }
    if (username.length === 0 || password.length === 0) {
      // 账号或密码缺失：这条记录没有迁移价值，跳过并提示用户手工补。
      skipped.push({ line: index + 1, reason: username.length === 0 ? '缺少账号' : '缺少密码' });
      continue;
    }
    const item: CreateItemInput = {
      title: title.length > 0 ? title : username,
      username,
      password,
      // CSV 自带分类优先；没写才用用户选的默认分类。
      category: category.length > 0 ? category : defaultCategory,
      visibility: defaultVisibility,
    };
    if (url.length > 0) {
      item.url = url;
    }
    if (notes.length > 0) {
      item.notes = notes;
    }
    if (platform.length > 0) {
      item.platform = platform;
    }
    if (appPath.length > 0) {
      item.appPath = appPath;
    }
    if (tags.length > 0) {
      item.tags = tags.split(/[;,，；、]/).map((tag) => tag.trim()).filter(Boolean);
    }
    items.push(item);
  }

  return { items, skipped, totalRows: rows.length - 1, mapping };
}
