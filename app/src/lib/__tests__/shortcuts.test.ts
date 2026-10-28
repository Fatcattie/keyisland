/**
 * 快捷键配置纯逻辑（NFR 可用性「快捷键可在设置中查看与自定义」）。
 *
 * 这套测试只覆盖 `lib/shortcuts.ts` 里的无副作用函数——它们是整套自定义能力的
 * 地基：门面 `setShortcut` 的校验、设置页下拉框的备选项、键盘处理 `matchesBinding`
 * 的命中判定，全都建立在这些函数之上。地基错了，上面所有 UI 都会跟着错。
 *
 * 重点钉住反直觉的地方：
 * - 修饰键必须**逐个相等**，`Ctrl+Enter` 不等于 `Enter`（否则"复制密码"会吃掉"跳转"）；
 * - 解析只接受备选取值，不接受任意组合键（防 `Ctrl+W` 把自己锁门外）；
 * - 残缺存储值回落默认值，但**只回落坏字段**、不丢掉全部自定义。
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SHORTCUTS,
  FIXED_SHORTCUTS,
  SHORTCUT_IDS,
  SHORTCUT_OPTIONS,
  findShortcutConflict,
  formatBinding,
  isConfigurableAction,
  isShortcutId,
  isValidShortcutSpec,
  matchesBinding,
  parseBinding,
  resolveShortcuts,
  sameBinding,
  serializeShortcuts,
} from '../shortcuts';

describe('parseBinding', () => {
  it('解析单键（无修饰符）', () => {
    expect(parseBinding('/')).toEqual({ key: '/' });
  });

  it('解析带修饰符的组合，顺序无关', () => {
    expect(parseBinding('Ctrl+Enter')).toEqual({ key: 'Enter', ctrl: true });
    expect(parseBinding('Shift+Enter')).toEqual({ key: 'Enter', shift: true });
    expect(parseBinding('Alt+Shift+Enter')).toEqual({
      key: 'Enter',
      alt: true,
      shift: true,
    });
  });

  it('未知修饰符（含 Meta）返回 null', () => {
    expect(parseBinding('Meta+Enter')).toBeNull();
    expect(parseBinding('Win+K')).toBeNull();
  });

  it('只有修饰键没有主键（"Ctrl+"）返回 null', () => {
    expect(parseBinding('Ctrl')).toBeNull();
    expect(parseBinding('Ctrl+Shift')).toBeNull();
  });

  it('非字符串返回 null（读老数据时要能容忍坏值）', () => {
    expect(parseBinding(null)).toBeNull();
    expect(parseBinding(42)).toBeNull();
    expect(parseBinding({})).toBeNull();
  });

  it('空白片段返回 null', () => {
    expect(parseBinding('Ctrl++Enter')).toBeNull();
  });
});

describe('formatBinding / parseBinding 互为逆运算', () => {
  it('默认映射的每个取值都能往返', () => {
    for (const action of Object.keys(SHORTCUT_OPTIONS) as Array<keyof typeof SHORTCUT_OPTIONS>) {
      const spec = formatBinding(DEFAULT_SHORTCUTS[action]);
      expect(parseBinding(spec)).toEqual(DEFAULT_SHORTCUTS[action]);
    }
  });
});

describe('isValidShortcutSpec', () => {
  it('只接受该动作的备选项', () => {
    expect(isValidShortcutSpec('focus_search', '/')).toBe(true);
    expect(isValidShortcutSpec('focus_search', 'Ctrl+K')).toBe(true);
    expect(isValidShortcutSpec('focus_search', 'Ctrl+W')).toBe(false);
  });

  it('非可配置动作一律拒绝', () => {
    expect(isValidShortcutSpec('nav_up', 'ArrowUp')).toBe(false);
    expect(isValidShortcutSpec('collapse', 'Escape')).toBe(false);
  });

  it('非字符串取值拒绝', () => {
    expect(isValidShortcutSpec('focus_search', null)).toBe(false);
  });
});

describe('matchesBinding', () => {
  it('主键 + 修饰键必须逐個相等', () => {
    const event = { key: 'Enter', ctrlKey: true, shiftKey: false, altKey: false };
    expect(matchesBinding(event, { key: 'Enter', ctrl: true })).toBe(true);
    // 少了 shift 也要判 false：否则"跳转"(Ctrl+Enter) 会吃掉"复制密码"(Enter)。
    expect(matchesBinding(event, { key: 'Enter' })).toBe(false);
  });

  it('修饰键必须两两精确：多一个或少一个都不算命中', () => {
    // 事件只按了 Enter+Shift：精确命中 Shift+Enter（复制账号）。
    const shiftOnly = { key: 'Enter', ctrlKey: false, shiftKey: true, altKey: false };
    expect(matchesBinding(shiftOnly, { key: 'Enter', shift: true })).toBe(true);
    // 但 Ctrl+Enter（跳转）不匹配——多出来的 ctrl 让命中失败。
    expect(matchesBinding(shiftOnly, { key: 'Enter', ctrl: true })).toBe(false);

    // 事件只按了 Enter+Ctrl：精确命中 Ctrl+Enter，不匹配 Shift+Enter。
    const ctrlOnly = { key: 'Enter', ctrlKey: true, shiftKey: false, altKey: false };
    expect(matchesBinding(ctrlOnly, { key: 'Enter', ctrl: true })).toBe(true);
    expect(matchesBinding(ctrlOnly, { key: 'Enter', shift: true })).toBe(false);
  });

  it('主键不同不命中', () => {
    const event = { key: '/', ctrlKey: false, shiftKey: false, altKey: false };
    expect(matchesBinding(event, { key: 'Enter' })).toBe(false);
  });
});

describe('sameBinding', () => {
  it('逐字段比对，修饰符缺失不等同于 false', () => {
    expect(sameBinding({ key: 'Enter', ctrl: true }, { key: 'Enter', ctrl: true })).toBe(true);
    expect(sameBinding({ key: 'Enter' }, { key: 'Enter', ctrl: true })).toBe(false);
    expect(sameBinding({ key: 'Enter', shift: true }, { key: 'Enter', ctrl: true })).toBe(false);
  });
});

describe('findShortcutConflict', () => {
  it('检出与已占用的动作冲突，返回冲突的 id', () => {
    const map = DEFAULT_SHORTCUTS;
    // copy_password 默认是 Enter；若把 copy_username 也设成 Enter 就冲突。
    expect(findShortcutConflict(map, 'copy_username', { key: 'Enter' })).toBe('copy_password');
  });

  it('无冲突返回 null', () => {
    expect(findShortcutConflict(DEFAULT_SHORTCUTS, 'jump', { key: 'Enter', ctrl: true })).toBeNull();
  });

  it('与自身的当前值不算冲突', () => {
    expect(findShortcutConflict(DEFAULT_SHORTCUTS, 'copy_password', { key: 'Enter' })).toBeNull();
  });
});

describe('resolveShortcuts', () => {
  it('空值回落到完整默认映射', () => {
    expect(resolveShortcuts(undefined)).toEqual(DEFAULT_SHORTCUTS);
    expect(resolveShortcuts(null)).toEqual(DEFAULT_SHORTCUTS);
    expect(resolveShortcuts({})).toEqual(DEFAULT_SHORTCUTS);
  });

  it('部分自定义只覆盖对应字段，坏字段回落而不丢全部', () => {
    const resolved = resolveShortcuts({
      focus_search: 'Ctrl+K',
      copy_password: 'not-a-real-spec',
      jump: 'Ctrl+J',
    });
    expect(resolved.focus_search).toEqual({ key: 'K', ctrl: true });
    expect(resolved.jump).toEqual({ key: 'J', ctrl: true });
    // 坏字段用默认值顶上，但另一处自定义仍保留。
    expect(resolved.copy_password).toEqual(DEFAULT_SHORTCUTS.copy_password);
  });
});

describe('serializeShortcuts', () => {
  it('只为可配置动作产出文本键', () => {
    const out = serializeShortcuts(DEFAULT_SHORTCUTS);
    expect(out.focus_search).toBe('/');
    expect(out.copy_password).toBe('Enter');
    // 固定项（nav_up 等）不进落盘值。
    expect(out.nav_up).toBeUndefined();
  });
});

describe('isConfigurableAction / isShortcutId', () => {
  it('可配置动作判定', () => {
    expect(isConfigurableAction('focus_search')).toBe(true);
    expect(isConfigurableAction('copy_password')).toBe(true);
    expect(isConfigurableAction('nav_up')).toBe(false);
    expect(isConfigurableAction('bogus')).toBe(false);
  });

  it('动作 id 判定含固定项', () => {
    expect(isShortcutId('nav_up')).toBe(true);
    expect(isShortcutId('collapse')).toBe(true);
    expect(isShortcutId('bogus')).toBe(false);
  });
});

describe('DEFAULT_SHORTCUTS 不变式', () => {
  it('全部可配置动作的默认值互不冲突', () => {
    for (const action of Object.keys(SHORTCUT_OPTIONS) as Array<keyof typeof SHORTCUT_OPTIONS>) {
      const binding = DEFAULT_SHORTCUTS[action];
      expect(findShortcutConflict(DEFAULT_SHORTCUTS, action, binding)).toBeNull();
    }
  });

  it('每个可配置动作的默认取值都在其备选项里', () => {
    for (const action of Object.keys(SHORTCUT_OPTIONS) as Array<keyof typeof SHORTCUT_OPTIONS>) {
      const spec = formatBinding(DEFAULT_SHORTCUTS[action]);
      expect((SHORTCUT_OPTIONS[action] as readonly string[]).includes(spec)).toBe(true);
    }
  });

  it('默认值整体互不冲突（含固定项，逐对比对）', () => {
    for (const id of SHORTCUT_IDS) {
      for (const other of SHORTCUT_IDS) {
        if (id === other) {
          continue;
        }
        expect(sameBinding(DEFAULT_SHORTCUTS[id], DEFAULT_SHORTCUTS[other])).toBe(false);
      }
    }
  });

  it('固定项取 FIXED_SHORTCUTS 的取值', () => {
    expect(DEFAULT_SHORTCUTS.nav_up).toEqual(FIXED_SHORTCUTS.nav_up.binding);
    expect(DEFAULT_SHORTCUTS.collapse).toEqual(FIXED_SHORTCUTS.collapse.binding);
  });
});
