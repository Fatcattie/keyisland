/**
 * 主面板：左侧导航 + 顶部工具条 + 卡片网格 + 底部状态条。
 *
 * 数据全部来自 `VaultClient`（真实加密链路），没有任何假数据数组；
 * 唯一的"示例数据"入口在设置面板里，且明确标注仅开发演示。
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckSquare,
  LayoutGrid,
  List,
  Lock,
  Minimize2,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { useVaultClient } from '../../app/VaultProvider';
import { Button } from '../../components/ui/Button';
import { ElasticToggle } from '../../components/ui/ElasticToggle';
import { Modal } from '../../components/ui/Modal';
import { useToast } from '../../components/ui/Toast';
import { useThemeStore } from '../../stores/theme-store';
import { useUiStore } from '../../stores/ui-store';
import { useCountdown } from '../../lib/hooks';
import { describeError } from '../../lib/i18n';
import { formatCountdown } from '../../lib/format';
import { AppError } from '../../core/errors';
import { matchesBinding } from '../../lib/shortcuts';
import { isDesktopShell } from '../../services/tauri-storage';
import { shellPort } from '../../services/window-shell';
import type {
  ItemDetail,
  ItemFilter,
  ItemSummary,
  SessionSnapshot,
  SortMode,
} from '../../core/vault/types';
import { ItemCard } from './ItemCard';
import { ItemEditor } from './ItemEditor';
import { HiddenAccessDialog } from './HiddenAccessDialog';
import { SettingsPanel } from '../settings/SettingsPanel';

/** 预设分类（PRD 分类体系）。 */
const CATEGORIES: readonly string[] = ['开发', '工作', '娱乐', '社交', '购物', '金融', '其他'];

/**
 * 标签导航项的 key 前缀。
 *
 * 导航 key 与分类名共用一个字符串空间，而分类与标签**可以重名**（都有"工作"
 * 很常见）。不加前缀就会出现：点了标签「工作」，实际过滤的是分类「工作」——
 * 结果看起来"少了几张卡"，且没有任何报错。
 */
const TAG_NAV_PREFIX = 'tag:';

/** 导航项。 */
interface NavItem {
  key: string;
  label: string;
  /** 分组标题：相邻同组的项归在一起，分组变化时渲染一个小标题。 */
  group?: '分类' | '标签';
}

/** 排序选项。 */
const SORT_OPTIONS: ReadonlyArray<{ value: SortMode; label: string }> = [
  { value: 'recent_used', label: '最近使用' },
  { value: 'recent_updated', label: '最近更新' },
  { value: 'alpha', label: '字母序' },
];

export interface MainPanelProps {
  snapshot: SessionSnapshot;
  onSessionChange: (snapshot: SessionSnapshot) => void;
  /**
   * 设置面板开合。由 `SessionGate` 持有：灵动岛右键菜单的「设置」项要能打开它，
   * 两个组件隔着层级，状态放共同父级是唯一不引入全局存储的办法。
   */
  settingsOpen: boolean;
  onSettingsOpenChange: (open: boolean) => void;
  /**
   * 是否"挂载但不可见"。
   *
   * 岛形态下主面板不卸载（编辑中的表单、筛选、滚动位置都要留着，CHG-02
   * 「恢复原状态」），只加 `hidden`（`display:none`）与 `aria-hidden`。
   * 用条件渲染会把这些统统丢掉。
   */
  hidden?: boolean;
}

/** 主面板。 */
export function MainPanel({
  snapshot,
  onSessionChange,
  settingsOpen,
  onSettingsOpenChange,
  hidden = false,
}: MainPanelProps): JSX.Element {
  const client = useVaultClient();
  const toast = useToast();

  const category = useUiStore((state) => state.filters.category);
  const sort = useUiStore((state) => state.filters.sort);
  const setCategory = useUiStore((state) => state.setCategory);
  const setSort = useUiStore((state) => state.setSort);
  const viewMode = useUiStore((state) => state.viewMode);
  /** 快捷键自定义（NFR 可用性）：聚焦搜索的组合键读这里。 */
  const shortcuts = useUiStore((state) => state.shortcuts);
  const setViewMode = useUiStore((state) => state.setViewMode);
  const openIsland = useUiStore((state) => state.openIsland);
  /** 主题：只在这里读一次，开关与文案共用。 */
  const themeMode = useThemeStore((state) => state.mode);
  const setThemeMode = useThemeStore((state) => state.setMode);

  /**
   * 导航里的分类 = 预设 ∪ 数据里出现过的分类（PRD FR-03「分类可自定义」）。
   *
   * 自定义分类本来就写得进去（编辑器是自由输入），但导航只列预设，导致用户
   * 建了「工具」之后在左侧找不到它，只能靠搜索——这才是不完整的地方。
   *
   * 只统计**非隐藏**卡片：隐藏卡片连"存在"都不该暴露，它的分类出现在导航里
   * 同样是泄漏（"家里有个叫 私密 的分类"本身就是信息）。
   */
  const [categories, setCategories] = useState<readonly string[]>(CATEGORIES);
  /**
   * 导航里的标签 = 数据里出现过的标签（PRD FR-03「左侧导航：全部 / 收藏 / 分类 /
   * **标签** / 隐藏卡片」）。
   *
   * 与分类不同，标签没有预设：它是用户随手打的，只能从数据里统计。
   * 同样只统计**非隐藏**卡片——"有个叫 私密 的标签"本身就是信息泄漏。
   */
  const [tags, setTags] = useState<readonly string[]>([]);
  /** 标签是否已经成功统计过一次（用来区分"还没加载"与"真的没有标签"）。 */
  const tagsLoadedRef = useRef(false);
  /**
   * 最新选中的导航 key。
   *
   * 用 ref 而不是把 `category` 塞进统计 effect 的依赖：那会让每次点导航都多跑一次
   * `listItems()`（要解密全部卡片），而统计结果并不会因为"选中项变了"而变化。
   */
  const categoryRef = useRef(category);

  useEffect(() => {
    categoryRef.current = category;
  }, [category]);

  const [query, setQuery] = useState('');
  const [items, setItems] = useState<ItemSummary[]>([]);
  const [hiddenItems, setHiddenItems] = useState<ItemSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<ItemDetail | null>(null);
  const [hiddenDialogOpen, setHiddenDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ItemSummary | null>(null);
  // —— 批量删除（PRD `prd.md:138`「批量删除需输入主密码」）——
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<number>>(() => new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkPassword, setBulkPassword] = useState('');
  const [bulkDeleting, setBulkDeleting] = useState(false);
  /**
   * 隐私访问授权到期时间（遮罩 / 隐藏卡片）。`HiddenAccessDialog` 授权成功后写入，
   * 供卡片判断是否解除遮罩。授权本身由门面维护，这里只是 UI 镜像，便于即时重渲染。
   */
  const [hiddenGrantUntil, setHiddenGrantUntil] = useState<number | null>(null);
  const grantTimerRef = useRef<number | null>(null);
  /** 唤起授权对话框的用途：`category` = 隐藏卡片分类视图；`reveal` = 遮罩卡片揭示。 */
  const hiddenPurposeRef = useRef<'category' | 'reveal'>('category');
  /**
   * 遮罩卡片上"用户本来想做的动作"（编辑 / 复制 / 删除 / 跳转）。
   * 验证主密码通过后立即续跑，避免"验证完回到列表什么都没发生"的死路。
   */
  const pendingRevealActionRef = useRef<(() => void) | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const sessionRemaining = useCountdown(snapshot.unlockedUntil);
  const now = Date.now();
  /** 隐私授权当前是否生效（驱动遮罩卡片的字段显示）。 */
  const hiddenAccessActive = hiddenGrantUntil !== null && Date.now() < hiddenGrantUntil;

  const navItems = useMemo<NavItem[]>(() => {
    const list: NavItem[] = [
      { key: 'all', label: '全部' },
      { key: 'favorite', label: '收藏' },
    ];
    for (const name of categories) {
      list.push({ key: name, label: name, group: '分类' });
    }
    for (const name of tags) {
      list.push({ key: `${TAG_NAV_PREFIX}${name}`, label: name, group: '标签' });
    }
    list.push({ key: 'hidden', label: '隐藏卡片' });
    return list;
  }, [categories, tags]);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      if (category === 'hidden') {
        if (hiddenItems === null) {
          setItems([]);
          return;
        }
        const list = await client.listItems({ includeHidden: true, sort });
        const hidden = list.filter((item) => item.visibility === 'hidden');
        setHiddenItems(hidden);
        setItems(hidden);
        return;
      }
      const filter: ItemFilter = { sort };
      const trimmed = query.trim();
      if (trimmed.length > 0) {
        filter.text = trimmed;
      }
      if (category === 'favorite') {
        filter.favoriteOnly = true;
      } else if (category.startsWith(TAG_NAV_PREFIX)) {
        // 标签过滤走 `filter.tag`，与分类是两个独立维度。
        filter.tag = category.slice(TAG_NAV_PREFIX.length);
      } else if (category !== 'all') {
        filter.category = category;
      }
      setItems(await client.searchItems(filter));
    } catch (caught) {
      toast(describeError(caught));
    } finally {
      setLoading(false);
    }
  }, [category, client, hiddenItems, query, sort, toast]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /**
   * 重新统计分类与标签（列表每次变化后跑一次）。
   *
   * 只在结果真的不同时才 setState：否则每次 reload 都会因为"新的等值数组"
   * 触发一次多余渲染（列表越长越明显）。
   */
  useEffect(() => {
    let cancelled = false;
    void client
      .listItems({})
      .then((list) => {
        if (cancelled) {
          return;
        }
        const merged = [...CATEGORIES];
        const collectedTags = new Set<string>();
        for (const item of list) {
          const name = item.category.trim();
          if (name.length > 0 && !merged.includes(name)) {
            merged.push(name);
          }
          for (const raw of item.tags) {
            const tag = raw.trim();
            if (tag.length > 0) {
              collectedTags.add(tag);
            }
          }
        }
        setCategories((previous) =>
          previous.length === merged.length && previous.every((name, index) => name === merged[index])
            ? previous
            : merged,
        );
        // 标签按字典序：统计顺序来自列表顺序，会随"最近更新"变动而抖动，
        // 用户每次看到的顺序都不一样。
        const nextTags = [...collectedTags].sort((left, right) => left.localeCompare(right, 'zh-Hans-CN'));
        setTags((previous) =>
          previous.length === nextTags.length && previous.every((name, index) => name === nextTags[index])
            ? previous
            : nextTags,
        );
        // 当前选中的标签已经不存在了（最后一张带它的卡被删掉 / 改标签）→ 回到「全部」。
        // 否则用户会停在一个没有任何导航项高亮的空列表上，看不出发生了什么。
        // `tagsLoadedRef` 用来区分"首次加载前"（此时 tags 本来就是空的，不该重置）。
        if (tagsLoadedRef.current) {
          const current = categoryRef.current;
          if (current.startsWith(TAG_NAV_PREFIX) && !collectedTags.has(current.slice(TAG_NAV_PREFIX.length))) {
            setCategory('all');
          }
        }
        tagsLoadedRef.current = true;
      })
      .catch(() => {
        // 分类 / 标签导航是附属信息：读不到就继续用预设，不影响列表本身。
      });
    return () => {
      cancelled = true;
    };
  }, [client, items, setCategory]);

  /**
   * 自动锁定兜底。
   *
   * `useCountdown` 只负责让底栏数字变小，不会改变会话状态；`SessionGate` 也只在
   * `window focus` 时刷新。用户离开 30 分钟再回来，DEK 已被清掉，但卡片标题与账号
   * 还挂在屏幕上——虽然读不到密码，仍属于不该保留的信息暴露。
   * 因此倒计时归零时主动向 client 确认一次状态，由 `onSessionChange` 把画面切回解锁屏。
   */
  useEffect(() => {
    if (snapshot.unlockedUntil === null || sessionRemaining > 0) {
      return;
    }
    let cancelled = false;
    void client
      .status()
      .then((next) => {
        if (!cancelled) {
          onSessionChange(next);
        }
      })
      .catch(() => {
        // 状态查询失败时保留当前画面，下一次 focus / 手动操作仍会再次触发刷新。
      });
    return () => {
      cancelled = true;
    };
  }, [client, onSessionChange, sessionRemaining, snapshot.unlockedUntil]);

  /**
   * 聚焦搜索框（NFR 可用性「快捷键可自定义」，默认 `/`）。
   *
   * 组合键来自用户配置。用 `matchesBinding` 而不是 `event.key !== '/'`：
   * 备选里有 `Ctrl+K`，只判 key 会让用户设了 `Ctrl+K` 之后按 `/` 依然生效
   * （或反过来），配置形同虚设。
   *
   * 焦点在输入框 / 可编辑区时不生效：那时用户正在打字，`/` 和 `Ctrl+K`
   * 都应该是普通字符输入，抢占会让人打不出斜杠。
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!matchesBinding(event, shortcuts.focus_search)) {
        return;
      }
      const target = event.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName.toLowerCase();
        if (tag === 'input' || tag === 'textarea' || target.isContentEditable) {
          return;
        }
      }
      event.preventDefault();
      searchRef.current?.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [shortcuts]);

  // —— 批量选择 ——

  /**
   * 退出选择模式并清空选中。所有"上下文变了"的路径都必须调用它。
   *
   * 退出时强制 `reload()`：选择模式存续期间没有任何刷新入口（搜索/排序/新建/
   * 卡片上的编辑删除全不在 DOM 里），若用户在另一窗口删了卡，`selectedIds` 里的
   * 幽灵 id 与本面板的列表会一直错到退出为止。退出这一刻刷新，既清掉幽灵 id，
   * 也让"已选 N 张"下次进入时从真实状态起算（QA 复验建议 3）。
   */
  const exitSelectMode = useCallback((): void => {
    setSelectMode(false);
    setSelectedIds(new Set());
    void reload();
  }, [reload]);

  const toggleSelect = useCallback((id: number): void => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  /** 全选只覆盖当前 `items`（即当前分类/搜索视图），不会碰到视图外的卡片。 */
  const allSelected = items.length > 0 && items.every((item) => selectedIds.has(item.id));

  const toggleSelectAll = (): void => {
    setSelectedIds(allSelected ? new Set() : new Set(items.map((item) => item.id)));
  };

  /**
   * 列表变化后清理已不存在的 id。
   *
   * 没有这一步，删除/切换视图后 `selectedIds` 里会残留幽灵 id，
   * 「已选 N 张」的数字就会说谎。
   */
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) {
        return prev;
      }
      const alive = new Set(items.map((item) => item.id));
      const next = new Set([...prev].filter((id) => alive.has(id)));
      // 内容没变时返回原引用，避免无谓的重渲染。
      return next.size === prev.size ? prev : next;
    });
  }, [items]);

  /** 搜索词变化时退出选择模式（选中集是基于旧结果集的，不能跨查询复用）。 */
  const handleQueryChange = (value: string): void => {
    if (selectMode) {
      exitSelectMode();
    }
    setQuery(value);
  };

  const handleNav = (key: string): void => {
    if (key === 'hidden' && hiddenItems === null) {
      hiddenPurposeRef.current = 'category';
      setHiddenDialogOpen(true);
      return;
    }
    // 切换分类 = 换了一组卡片，选中集必须作废。
    exitSelectMode();
    setCategory(key);
  };

  /** 安排授权到期自动清除 UI 镜像（精确一点，避免授权失效后卡片仍显示明文）。 */
  const scheduleGrantClear = useCallback((until: number): void => {
    if (grantTimerRef.current !== null) {
      window.clearTimeout(grantTimerRef.current);
    }
    grantTimerRef.current = window.setTimeout(
      () => setHiddenGrantUntil(null),
      Math.max(0, until - Date.now()),
    );
  }, []);

  /**
   * 遮罩卡片发起隐私访问授权（验证主密码后才会解除遮罩）。
   * `afterGrant` 是用户原本想做的动作，授权成功后由 `onGranted` 续跑。
   */
  const openRevealAccess = useCallback((afterGrant?: () => void): void => {
    hiddenPurposeRef.current = 'reveal';
    pendingRevealActionRef.current = afterGrant ?? null;
    setHiddenDialogOpen(true);
  }, []);

  const handleCreate = (): void => {
    setEditing(null);
    setEditorOpen(true);
  };

  const handleEdit = async (item: ItemSummary): Promise<void> => {
    try {
      const detail = await client.getItem(item.id, { allowHidden: category === 'hidden' });
      setEditing(detail);
      setEditorOpen(true);
    } catch (caught) {
      toast(describeError(caught));
    }
  };

  const handleConfirmDelete = async (): Promise<void> => {
    if (deleteTarget === null) {
      return;
    }
    try {
      await client.deleteItem(deleteTarget.id);
      setDeleteTarget(null);
      await reload();
    } catch (caught) {
      toast(describeError(caught));
    }
  };

  /** 关闭批量删除弹窗：**必须**清掉密码，别让它长时间留在内存 state 里。 */
  const closeBulkDialog = (): void => {
    setBulkOpen(false);
    setBulkPassword('');
  };

  /**
   * 提交批量删除。
   *
   * 失败时弹窗**保持打开**、密码框清空、选中态不动——用户多半只是打错了密码，
   * 关掉弹窗再重新选一遍是纯粹的折磨。
   */
  const handleBulkDelete = async (): Promise<void> => {
    const ids = [...selectedIds];
    if (ids.length === 0) {
      return;
    }
    setBulkDeleting(true);
    try {
      const result = await client.deleteItems(ids, bulkPassword);
      // **必须报 `result.deleted`，不能报 `ids.length`**：选中集可能含幽灵 id
      // （另一处把卡删了而本面板还没刷新），`deleteMany` 会静默跳过它们。
      // 报 `ids.length` 就等于拿没删掉的张数充数，用户会以为删干净了（QA 复验 P2-2）。
      toast(`已删除 ${result.deleted} 张卡片`);
      closeBulkDialog();
      // `exitSelectMode` 内部已触发 reload，这里不再重复请求一次。
      exitSelectMode();
    } catch (caught) {
      // 冷却中要给出剩余时间，只回一句"稍后再试"等于没说。
      if (AppError.isAppError(caught) && caught.code === 'AUTH_COOLDOWN') {
        const next = await client.status().catch(() => null);
        const until = next?.cooldownUntil ?? null;
        if (until !== null) {
          const seconds = Math.max(0, Math.ceil((until - Date.now()) / 1000));
          toast(`尝试过于频繁，请 ${seconds} 秒后再试`);
        } else {
          toast(describeError(caught));
        }
      } else {
        toast(describeError(caught));
      }
      setBulkPassword('');
    } finally {
      setBulkDeleting(false);
    }
  };

  const handleLock = async (): Promise<void> => {
    try {
      onSessionChange(await client.lock('manual'));
    } catch (caught) {
      toast(describeError(caught));
    }
  };

  const emptySearch = query.trim().length > 0;

  return (
    <div
      className={`flex min-h-full flex-col bg-page${hidden ? ' hidden' : ''}`}
      aria-hidden={hidden ? true : undefined}
    >
      <div className="mx-auto flex w-full max-w-7xl flex-1 gap-6 px-6 pb-16 pt-12">
        {/* 左侧导航 */}
        <aside className="hidden w-48 shrink-0 flex-col gap-1 lg:flex" aria-label="资产导航">
          <div className="mb-3 flex items-center gap-2 px-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-accent-fg">
              <ShieldCheck aria-hidden="true" size={14} />
            </span>
            <span className="text-sm font-semibold text-fg">密岛</span>
          </div>
          {navItems.map((item, index) => {
            const active = category === item.key;
            // 分组变化时插入小标题：分类与标签可以重名（都有「工作」很常见），
            // 不加分组标题的话同一列会出现两个一模一样的「工作」，点哪个才对说不清。
            const showGroupHeading = item.group !== undefined && navItems[index - 1]?.group !== item.group;
            return (
              <Fragment key={item.key}>
                {showGroupHeading ? (
                  <p className="mt-3 mb-0.5 px-3 text-[10px] font-semibold tracking-wide text-fg-faint">
                    {item.group}
                  </p>
                ) : null}
                <button
                  type="button"
                  aria-current={active ? 'page' : undefined}
                  onClick={() => handleNav(item.key)}
                  className={`rounded-pill px-3 py-2 text-left text-xs font-medium transition-colors ${
                    active
                      ? 'bg-surface text-fg shadow-card'
                      : 'text-fg-subtle hover:bg-surface/60 hover:text-fg'
                  }`}
                >
                  {item.label}
                </button>
              </Fragment>
            );
          })}
          <div className="mt-auto flex flex-col gap-1">
            {/**
             * 主题开关放在侧栏底部（与「设置 / 立即锁定」同组）：
             * 主题是"整个应用的外观"，不是某个面板的局部选项，放在导航末尾
             * 比塞进设置二级页更好找——主流桌面软件的换肤开关基本都在这个位置。
             */}
            <div className="mb-1 flex items-center justify-between rounded-pill px-3 py-1.5">
              <span className="text-xs font-medium text-fg-subtle">
                {themeMode === 'dark' ? '黑夜' : '白天'}
              </span>
              <ElasticToggle
                checked={themeMode === 'dark'}
                onCheckedChange={(next) => setThemeMode(next ? 'dark' : 'light')}
                label="切换白天 / 黑夜模式"
              />
            </div>
            <button
              type="button"
              onClick={() => onSettingsOpenChange(true)}
              className="flex items-center gap-2 rounded-pill px-3 py-2 text-left text-xs font-medium text-fg-subtle transition-colors hover:bg-surface/60 hover:text-fg"
            >
              <Settings aria-hidden="true" size={13} />
              设置
            </button>
            <button
              type="button"
              onClick={handleLock}
              className="rounded-pill px-3 py-2 text-left text-xs font-medium text-fg-subtle transition-colors hover:bg-surface/60 hover:text-fg"
            >
              立即锁定
            </button>
          </div>
        </aside>

        {/* 主内容 */}
        <main className="flex min-w-0 flex-1 flex-col gap-4">
          <header className="flex flex-wrap items-center gap-3">
            {selectMode ? (
              <>
                <span className="text-sm font-medium text-fg" data-testid="bulk-count">
                  已选 {selectedIds.size} 张
                </span>
                <Button variant="secondary" size="md" onClick={toggleSelectAll}>
                  {allSelected ? '取消全选' : '全选'}
                </Button>
                <Button
                  variant="danger"
                  size="md"
                  disabled={selectedIds.size === 0}
                  onClick={() => setBulkOpen(true)}
                >
                  <Trash2 aria-hidden="true" size={14} />
                  删除所选
                </Button>
                <Button variant="ghost" size="md" onClick={exitSelectMode}>
                  退出
                </Button>
              </>
            ) : (
              <>
                <div className="relative min-w-[220px] flex-1">
                  <Search
                    aria-hidden="true"
                    size={14}
                    className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-fg-faint"
                  />
                  <input
                    ref={searchRef}
                    id="main-search"
                    type="search"
                    aria-label="搜索资产"
                    placeholder="搜索标题、平台、账号、标签…（按 / 聚焦）"
                    value={query}
                    onChange={(event) => handleQueryChange(event.target.value)}
                    className="h-10 w-full rounded-pill border border-line bg-surface pl-9 pr-4 text-sm text-fg placeholder:text-fg-faint focus:border-line-strong focus:outline-none focus:ring-2 focus:ring-accent/10"
                  />
                </div>
                {/* PRD FR-03「右侧卡片网格（可切列表视图）」。 */}
                <div
                  role="group"
                  aria-label="展示方式"
                  className="flex items-center gap-0.5 rounded-pill border border-line bg-surface p-0.5"
                >
                  <button
                    type="button"
                    aria-label="网格视图"
                    aria-pressed={viewMode === 'grid'}
                    title="网格视图"
                    onClick={() => setViewMode('grid')}
                    className={
                      viewMode === 'grid'
                        ? 'rounded-full bg-accent p-1.5 text-accent-fg'
                        : 'rounded-full p-1.5 text-fg-faint transition-colors hover:bg-surface-sunken hover:text-fg'
                    }
                  >
                    <LayoutGrid aria-hidden="true" size={14} />
                  </button>
                  <button
                    type="button"
                    aria-label="列表视图"
                    aria-pressed={viewMode === 'list'}
                    title="列表视图"
                    onClick={() => setViewMode('list')}
                    className={
                      viewMode === 'list'
                        ? 'rounded-full bg-accent p-1.5 text-accent-fg'
                        : 'rounded-full p-1.5 text-fg-faint transition-colors hover:bg-surface-sunken hover:text-fg'
                    }
                  >
                    <List aria-hidden="true" size={14} />
                  </button>
                </div>
                <label className="sr-only" htmlFor="vault-sort">
                  排序方式
                </label>
                <select
                  id="vault-sort"
                  value={sort}
                  onChange={(event) => setSort(event.target.value as SortMode)}
                  className="h-10 rounded-pill border border-line bg-surface px-3 text-xs text-fg-muted focus:border-line-strong focus:outline-none"
                >
                  {SORT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                {items.length > 0 ? (
                  <Button
                    variant="secondary"
                    size="md"
                    onClick={() => {
                      setSelectedIds(new Set());
                      setSelectMode(true);
                    }}
                  >
                    <CheckSquare aria-hidden="true" size={14} />
                    选择
                  </Button>
                ) : null}
                <Button variant="secondary" size="md" onClick={openIsland}>
                  <Sparkles aria-hidden="true" size={13} />
                  预览灵动岛
                </Button>
                {/**
                 * 「收进岛」：与点窗口 × / 最小化 — 完全等价的一个入口。
                 *
                 * 为什么要有：把主面板收进托盘后应用仍在后台，这是本次变更
                 * **改变了用户预期**的地方（关窗口不再等于退出）。在工具栏上
                 * 放一个明示入口，比让用户去点 × 再猜"它去哪了"友好得多。
                 *
                 * 浏览器版禁用并说明原因：那里没有托盘，也没有第二形态，
                 * 摆一个点了没反应的按钮就是假按钮。
                 */}
                <Button
                  variant="secondary"
                  size="md"
                  disabled={!isDesktopShell()}
                  data-testid="collapse-to-island"
                  title={
                    isDesktopShell()
                      ? '收进系统托盘，灵动岛继续可用（等同于关闭窗口）'
                      : '收进托盘需要 Tauri 原生能力，Web 阶段不可用'
                  }
                  onClick={() => void shellPort().enterIsland()}
                >
                  <Minimize2 aria-hidden="true" size={13} />
                  收进岛
                </Button>
                <Button
                  variant="secondary"
                  size="md"
                  onClick={() => void handleLock()}
                  aria-label="立即锁定"
                  title="立即锁定：锁定后主面板关闭，且无法复制或存储账密"
                >
                  <Lock aria-hidden="true" size={14} />
                  锁定
                </Button>
                <Button onClick={handleCreate}>
                  <Plus aria-hidden="true" size={14} />
                  新建卡片
                </Button>
              </>
            )}
          </header>

          <div className="flex items-center justify-between px-1">
            <h1 className="text-sm font-semibold text-fg">
              {category === 'hidden' ? '隐藏卡片' : navItems.find((item) => item.key === category)?.label ?? '全部'}
            </h1>
            <span className="text-[11px] text-fg-faint">{items.length} 张</span>
          </div>

          {loading ? (
            <p className="px-1 text-xs text-fg-faint">正在解密资产…</p>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 rounded-card border border-dashed border-line-strong bg-surface/60 py-16 text-center">
              <p className="text-sm font-medium text-fg-muted">
                {emptySearch ? '没有匹配的资产' : category === 'hidden' ? '还没有隐藏卡片' : '还没有资产'}
              </p>
              <p className="text-xs text-fg-faint">
                {emptySearch ? '换个关键词试试，或清空搜索条件' : '点击右上角「新建卡片」开始'}
              </p>
            </div>
          ) : (
            <div
              data-testid="item-list"
              data-view={viewMode}
              className={
                viewMode === 'grid'
                  ? 'grid gap-4 md:grid-cols-2 xl:grid-cols-3'
                  : 'flex flex-col gap-2'
              }
            >
              {items.map((item) => (
                <ItemCard
                  key={item.id}
                  item={item}
                  now={now}
                  allowHidden={category === 'hidden'}
                  hiddenAccessActive={hiddenAccessActive}
                  onRequestHiddenAccess={openRevealAccess}
                  onEdit={(target) => void handleEdit(target)}
                  onRequestDelete={setDeleteTarget}
                  onChanged={() => void reload()}
                  selectMode={selectMode}
                  selected={selectedIds.has(item.id)}
                  onToggleSelect={toggleSelect}
                />
              ))}
            </div>
          )}
        </main>
      </div>

      {/* 底部状态条 */}
      <footer className="sticky bottom-0 border-t border-line bg-surface/80 px-6 py-2 backdrop-blur">
        <div className="mx-auto flex w-full max-w-7xl items-center justify-between text-[11px] text-fg-faint">
          <span className="flex items-center gap-1.5">
            <ShieldCheck aria-hidden="true" size={12} className="text-emerald-600" />
            本地加密 · 无云端连接
          </span>
          <span>
            {snapshot.unlockedUntil === null
              ? '本次开机内保持解锁'
              : `会话剩余 ${formatCountdown(sessionRemaining)}`}
          </span>
        </div>
      </footer>

      <ItemEditor
        open={editorOpen}
        item={editing}
        onClose={() => setEditorOpen(false)}
        onSaved={() => void reload()}
      />

      <HiddenAccessDialog
        open={hiddenDialogOpen}
        purpose={hiddenPurposeRef.current === 'reveal' ? 'reveal' : 'hidden'}
        onClose={() => {
          setHiddenDialogOpen(false);
          setHiddenItems(null);
          pendingRevealActionRef.current = null;
          if (category === 'hidden') {
            setCategory('all');
          }
        }}
        onGranted={(hidden, grant) => {
          // 授权生效：写入 UI 镜像并安排到期清除；遮罩卡片随后会解除遮罩。
          setHiddenGrantUntil(grant.grantedUntil);
          scheduleGrantClear(grant.grantedUntil);
          if (hiddenPurposeRef.current === 'category') {
            // 隐藏卡片分类视图：展示隐藏列表并切到该分类。
            setHiddenItems(hidden);
            setItems(hidden);
            setCategory('hidden');
          } else {
            // 卡片揭示：授权已生效。列表此前在"未授权"状态下拉取、账号已被抹掉，
            // 必须重新拉取一次才能把账号补回来（否则卡片会显示成 '—'）。
            setHiddenDialogOpen(false);
            const afterGrant = pendingRevealActionRef.current;
            pendingRevealActionRef.current = null;
            // 刷新完再续跑用户原本的动作（编辑 / 复制 / 删除 / 跳转）。
            // 顺序不能反：动作要在拿到明文数据之后执行，否则复制到的还是空值。
            const runAfterGrant = (): void => afterGrant?.();
            void reload().then(runAfterGrant, runAfterGrant);
          }
        }}
        /**
         * 授权到期：必须把隐藏列表本身一起清空并退出隐藏视图，
         * 同时清除遮罩卡片的 UI 镜像。只关弹窗的话，隐藏卡片的标题与账号名、
         * 遮罩卡片的明文会继续留在主面板上。
         */
        onExpired={() => {
          if (grantTimerRef.current !== null) {
            window.clearTimeout(grantTimerRef.current);
            grantTimerRef.current = null;
          }
          setHiddenGrantUntil(null);
          setHiddenDialogOpen(false);
          setHiddenItems(null);
          pendingRevealActionRef.current = null;
          if (category === 'hidden') {
            setCategory('all');
          }
          void reload();
        }}
      />

      <Modal
        open={deleteTarget !== null}
        title="删除卡片"
        description={deleteTarget === null ? undefined : `确定删除「${deleteTarget.title}」？此操作不可撤销。`}
        onClose={() => setDeleteTarget(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeleteTarget(null)}>
              取消
            </Button>
            <Button variant="danger" onClick={() => void handleConfirmDelete()}>
              删除
            </Button>
          </>
        }
      >
        <p className="text-xs leading-6 text-fg-subtle">
          删除后该卡片的账号与密码将无法恢复，恢复码也不能找回已删除的内容。
        </p>
      </Modal>

      <Modal
        open={bulkOpen}
        title="删除所选卡片"
        description={`将删除 ${selectedIds.size} 张卡片，此操作不可撤销。`}
        onClose={closeBulkDialog}
        footer={
          <>
            <Button variant="secondary" onClick={closeBulkDialog}>
              取消
            </Button>
            <Button
              variant="danger"
              disabled={bulkDeleting}
              onClick={() => void handleBulkDelete()}
            >
              {bulkDeleting ? '删除中…' : '删除'}
            </Button>
          </>
        }
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void handleBulkDelete();
          }}
        >
          <label className="text-xs font-medium text-fg-muted" htmlFor="bulk-master-password">
            主密码
          </label>
          <input
            id="bulk-master-password"
            type="password"
            autoComplete="current-password"
            aria-label="主密码"
            placeholder="输入主密码以确认"
            value={bulkPassword}
            onChange={(event) => setBulkPassword(event.target.value)}
            className="mt-2 h-10 w-full rounded-pill border border-line bg-surface px-4 text-sm text-fg placeholder:text-fg-faint focus:border-line-strong focus:outline-none focus:ring-2 focus:ring-accent/10"
          />
          <p className="mt-3 text-xs leading-5 text-fg-faint">
            批量删除属于高危操作，需要重新验证主密码。删除后账号与密码都无法恢复，恢复码也不能找回已删除的内容。
          </p>
        </form>
      </Modal>

      <SettingsPanel
        open={settingsOpen}
        snapshot={snapshot}
        onClose={() => onSettingsOpenChange(false)}
        onSessionChange={onSessionChange}
        onDataChanged={() => {
          setHiddenItems(null);
          void reload();
        }}
        onLocateItem={(title) => {
          onSettingsOpenChange(false);
          exitSelectMode();
          setCategory('all');
          setQuery(title);
          window.setTimeout(() => searchRef.current?.focus(), 0);
        }}
      />
    </div>
  );
}
