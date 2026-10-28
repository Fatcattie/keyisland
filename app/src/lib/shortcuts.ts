/**
 * 应用内快捷键配置（NFR 可用性：「所有快捷键可在设置中查看与自定义」）。
 *
 * ## 为什么只有一部分可配置
 *
 * PRD 写的是"所有快捷键"，但拆开看其实是两类：
 *
 * 1. **应用自己定义的语义键**——复制密码、复制账号、跳转、聚焦搜索。这些换一个
 *    组合键不影响任何规范，用户也完全有理由想换（左手单手操作、与其他软件冲突）。
 * 2. **平台约定键**——↑↓ 移动、Esc 关闭、Tab 在弹窗内循环。这些不是密岛的选择，
 *    是 APG（WAI-ARIA Authoring Practices）与浏览器原生行为：`role="option"` 的
 *    列表用 ↑↓、对话框用 Esc、弹窗内 Tab 循环都是无障碍规范的要求。把它们做成
 *    可配置等于让用户能把应用改得不合规，而设置页不会告诉用户后果。
 *
 * 所以这里只把第一类暴露成可配置，第二类在设置页里**照常列出但标为固定并说明
 * 原因**。诚实的部分交付好过假装全都能改。
 *
 * ## 冲突为什么必须在服务端也拦
 *
 * 设置页会把"已被别的动作占用"的选项置灰，但置灰只是 UI 层的便利。门面必须自己
 * 校验：调用方可以是任何代码（脚本、未来的批量配置、被改错的旧数据），靠 UI
 * 保证不变式迟早会破。所以 `setShortcut` 自己做完整校验并抛 `VALIDATION_FAILED`。
 */

/** 单个组合键。`key` 取 `KeyboardEvent.key` 的原始值（`Enter` / `ArrowUp` / `/`）。 */
export interface KeyBinding {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}

/** 可配置的动作。 */
export type ShortcutAction =
  | 'focus_search'
  | 'copy_password'
  | 'copy_username'
  | 'jump';

/** 全部动作（含固定项），用于设置页完整展示。 */
export type ShortcutId = ShortcutAction | 'nav_up' | 'nav_down' | 'collapse';

/** 动作 → 组合键 的完整映射。 */
export type ShortcutMap = Readonly<Record<ShortcutId, KeyBinding>>;

/** 固定不开放配置的动作，附原因（设置页原样展示）。 */
export const FIXED_SHORTCUTS: Readonly<Record<
  'nav_up' | 'nav_down' | 'collapse',
  { binding: KeyBinding; reason: string }
>> = {
  nav_up: {
    binding: { key: 'ArrowUp' },
    reason: '列表选项的标准导航键（WAI-ARIA APG），更换会让读屏用户失去预期',
  },
  nav_down: {
    binding: { key: 'ArrowDown' },
    reason: '列表选项的标准导航键（WAI-ARIA APG），更换会让读屏用户失去预期',
  },
  collapse: {
    binding: { key: 'Escape' },
    reason: '关闭浮层的通用约定键，浏览器与读屏用户都已形成预期',
  },
};

/** 可配置动作的备选取值（`select` 的选项来源，也用于校验）。 */
export const SHORTCUT_OPTIONS: Readonly<Record<ShortcutAction, readonly string[]>> = {
  focus_search: ['/', 'Ctrl+K'],
  copy_password: ['Enter', 'Ctrl+Enter', 'Alt+Enter'],
  copy_username: ['Shift+Enter', 'Ctrl+Shift+Enter', 'Alt+Shift+Enter'],
  jump: ['Ctrl+Enter', 'Ctrl+J', 'Alt+Enter'],
};

/** 全部动作 id，顺序即设置页展示顺序。 */
export const SHORTCUT_IDS: readonly ShortcutId[] = [
  'focus_search',
  'nav_up',
  'nav_down',
  'copy_password',
  'copy_username',
  'jump',
  'collapse',
];

/** 动作的人类可读名称（设置页表格第一列）。 */
export const SHORTCUT_LABELS: Readonly<Record<ShortcutId, string>> = {
  focus_search: '聚焦搜索框',
  nav_up: '上一个结果',
  nav_down: '下一个结果',
  copy_password: '复制密码',
  copy_username: '复制账号',
  jump: '打开跳转目标',
  collapse: '收起 / 关闭',
};

/** 默认映射：全部互不冲突（`setShortcut` 的唯一性校验依赖这一点）。 */
export const DEFAULT_SHORTCUTS: ShortcutMap = {
  focus_search: { key: '/' },
  copy_password: { key: 'Enter' },
  copy_username: { key: 'Enter', shift: true },
  jump: { key: 'Enter', ctrl: true },
  nav_up: FIXED_SHORTCUTS.nav_up.binding,
  nav_down: FIXED_SHORTCUTS.nav_down.binding,
  collapse: FIXED_SHORTCUTS.collapse.binding,
};

/** 是否为可配置动作。 */
export function isConfigurableAction(value: unknown): value is ShortcutAction {
  return value === 'focus_search' || value === 'copy_password' || value === 'copy_username' || value === 'jump';
}

/** 是否为已知动作 id（含固定项）。 */
export function isShortcutId(value: unknown): value is ShortcutId {
  return typeof value === 'string' && (SHORTCUT_IDS as readonly string[]).includes(value);
}

/**
 * 把 `Ctrl+Shift+Enter` 这样的文本解析成组合键。
 *
 * 解析失败返回 `null` 而不是抛错：调用方有两类——读老数据时要能容忍坏值，
 * 只有"用户刚提交的新值"才需要报错。区分这两件事的是 `isValidShortcutSpec`。
 */
export function parseBinding(spec: unknown): KeyBinding | null {
  if (typeof spec !== 'string') {
    return null;
  }
  const parts = spec.split('+').map((part) => part.trim());
  if (parts.length === 0 || parts.some((part) => part.length === 0)) {
    return null;
  }
  const key = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1);
  const binding: KeyBinding = { key };
  for (const modifier of modifiers) {
    if (modifier === 'Ctrl') {
      binding.ctrl = true;
    } else if (modifier === 'Shift') {
      binding.shift = true;
    } else if (modifier === 'Alt') {
      binding.alt = true;
    } else {
      // 未知修饰符（含 Meta：PRD 定案仅 Windows，不给 Mac 用户一个用不了的选项）。
      return null;
    }
  }
  // 只有修饰键没有主键（"Ctrl+"）不合法。
  if (key === 'Ctrl' || key === 'Shift' || key === 'Alt') {
    return null;
  }
  return binding;
}

/** 序列化回文本形式，与 `parseBinding` 互为逆运算。 */
export function formatBinding(binding: KeyBinding): string {
  const parts: string[] = [];
  if (binding.ctrl === true) {
    parts.push('Ctrl');
  }
  if (binding.shift === true) {
    parts.push('Shift');
  }
  if (binding.alt === true) {
    parts.push('Alt');
  }
  parts.push(binding.key);
  return parts.join('+');
}

/**
 * 该动作是否接受这个取值。
 *
 * 只接受备选取值里的，不接受"任意合法组合键"：设置页是下拉框，能选出来的只有
 * 这几个；放开任意值只会让"越界该报错还是该夹取"重新变成争议，还会让
 * 用户设出 `Ctrl+W`（关标签页）这种把自己锁在外面的组合。
 */
export function isValidShortcutSpec(action: unknown, spec: unknown): spec is string {
  if (!isConfigurableAction(action) || typeof spec !== 'string') {
    return false;
  }
  return (SHORTCUT_OPTIONS[action] as readonly string[]).includes(spec);
}

/** 事件是否命中这个组合键。修饰键必须**逐个相等**，不能只判"按下了就算"。 */
export function matchesBinding(
  event: { key: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean },
  binding: KeyBinding,
): boolean {
  return (
    event.key === binding.key &&
    event.ctrlKey === (binding.ctrl === true) &&
    event.shiftKey === (binding.shift === true) &&
    event.altKey === (binding.alt === true)
  );
}

/**
 * 把可能残缺的存储值解析成完整映射。
 *
 * 逐字段回落：某个动作的值缺失或非法时只用默认值顶上，**不**把整份配置丢掉——
 * 一个坏字段就让用户的所有自定义全部重置，比那一个字段用默认值糟糕得多。
 */
export function resolveShortcuts(value: unknown): ShortcutMap {
  const source =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const resolved = { ...DEFAULT_SHORTCUTS };
  for (const action of Object.keys(SHORTCUT_OPTIONS) as ShortcutAction[]) {
    const spec = source[action];
    if (isValidShortcutSpec(action, spec)) {
      const binding = parseBinding(spec);
      if (binding !== null) {
        resolved[action] = binding;
      }
    }
  }
  return resolved;
}

/** 序列化成可落盘的形式（动作 → 文本）。 */
export function serializeShortcuts(map: ShortcutMap): Record<string, string> {
  const out: Record<string, string> = {};
  for (const action of Object.keys(SHORTCUT_OPTIONS) as ShortcutAction[]) {
    out[action] = formatBinding(map[action]);
  }
  return out;
}

/**
 * 两个组合键是否等价（用于唯一性校验）。
 *
 * 必须比文本：`Ctrl+Enter` 与 `Ctrl+Enter` 显然相同，但 `Shift+Enter` 与
 * `Ctrl+Shift+Enter` 文本不同、语义也不同，只有逐个字段比才不会误判。
 */
export function sameBinding(a: KeyBinding, b: KeyBinding): boolean {
  return (
    a.key === b.key &&
    (a.ctrl === true) === (b.ctrl === true) &&
    (a.shift === true) === (b.shift === true) &&
    (a.alt === true) === (b.alt === true)
  );
}

/**
 * 在现有映射下把某个动作改成新值，检查是否与别的动作冲突。
 *
 * 返回冲突的动作 id，没有冲突返回 `null`。刻意**不**在这里做修改——
 * 校验与变更分开，调用方（门面）才能决定是报错还是别的处理。
 */
export function findShortcutConflict(
  map: ShortcutMap,
  action: ShortcutAction,
  binding: KeyBinding,
): ShortcutId | null {
  for (const id of SHORTCUT_IDS) {
    if (id === action) {
      continue;
    }
    if (sameBinding(map[id], binding)) {
      return id;
    }
  }
  return null;
}
