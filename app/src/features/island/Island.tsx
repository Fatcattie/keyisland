/**
 * 灵动岛（Web 阶段为页面级浮层）。
 *
 * 交互语义与 SDD §6.5 对齐（时序参数见下方"热区唤起"一节，当前生效的是 4px 命中带
 * + 250ms 隐藏；SDD 原文的"离开 2 秒收起"已被热区模式覆盖，见 docs/PHASE-LOG.md）：
 * - 顶部 4px 热区悬停唤出，离开 250ms 后隐藏，Esc 立即收起，点击外部收起；
 * - 展开后搜索框自动聚焦，↑/↓ 选择，Enter 复制密码，Shift+Enter 复制账号；
 * - 岛内不出现密码明文，只显示账号与操作。
 *
 * 生产差异（Phase 1.5 / Tauri）：
 * - 真实热区由 Rust 侧的无边框窗口实现（`window.set_ignore_cursor_events`），
 *   Web 阶段只能用页面顶部的透明条模拟；
 * - 真实灵动岛不抢焦点（`focusable: false` + 独立 webview），
 *   这里必须靠 `autoFocus` + `document.activeElement` 才能拿到键盘事件。
 */

import { useCallback, useEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type WheelEvent } from 'react';
import { motion, type Transition } from 'framer-motion';
import { Command, KeyRound, Lock, Plus, RefreshCw, Search } from 'lucide-react';
import { useVaultClient } from '../../app/VaultProvider';
import { useToast } from '../../components/ui/Toast';
import { useUiStore, type IslandPhase } from '../../stores/ui-store';
import { describeError } from '../../lib/i18n';
import { usePrefersReducedMotion } from '../../lib/hooks';
import { hotzoneBand, isFullscreenActive, isWithinHotzoneX } from '../../lib/hotzone';
import { matchesBinding } from '../../lib/shortcuts';
import { PEEK_HIDE_DELAY_MS } from '../../lib/timing';
import { avatarColor, avatarInitial, avatarTextColor, openExternal } from '../../lib/format';
import { matchesText } from '../../core/vault/search';
import type { ItemSummary, SessionStatus } from '../../core/vault/types';
import { shellPort } from '../../services/window-shell';
import { useQuitViaShell } from '../shell/ShellBridge';
import { ItemJumpMenu } from '../vault/ItemJumpMenu';
import { IslandContextMenu, IslandMenuTrigger } from './IslandContextMenu';
import { IslandScrollPicker } from './IslandScrollPicker';

/** 展开动画结束后的收尾延迟。 */
const CLOSING_DURATION_MS = 180;

/**
 * 热区命中带高度（px）。
 * SDD §1「顶部热区唤起」在 Web 阶段的落地：真实全局热区由 Rust 窗口层
 * （WS_EX_NOACTIVATE + 原生轮询）在 Phase 1.5 实现，本轮行为与之对齐。
 */
const HOTZONE_HEIGHT_PX = 4;

/**
 * 迟滞带（px）。
 * 指针在 4–48px 之间移动时**不**隐藏，让指针能从顶端"走向"灵动岛而不闪断。
 */
const HYSTERESIS_LIMIT_PX = 48;

/**
 * 隐藏延时：折叠胶囊态用短延时（探一下就消失，不遮挡页面顶部点击），
 * 展开态用可配置的长延时（PRD「鼠标离开 2 秒后自动收起」）。见 `lib/timing.ts`。
 */

/** 键盘唤出按钮宽度（px）：Tab 可聚焦，但视觉上完全不可见。 */
const SUMMON_BUTTON_WIDTH_PX = 88;

/**
 * 悬停胶囊多久才展开（ms）。
 *
 * 指针从屏幕上方"路过"顶部时会进到胶囊；立即展开会让岛一直闪。140ms 足够
 * 区分"路过"与"停下来了"，又短到不像延迟。
 */
const HOVER_EXPAND_DELAY_MS = 140;

/**
 * 表面入场动效：从顶部滑下 + 轻微放大，用弹簧而不是缓动曲线，
 * 与 TiltCard 的手感保持一致（SDD §1「动感但不打扰」）。
 *
 * 只做**入场**：退场时表面立刻从 DOM 撤掉。原因有两条——
 * 1. 隐藏语义是"藏起来"，退场动画期间表面仍可被点到，与"指针离开即隐藏"冲突；
 * 2. `revealed` 是渲染开关，保留退场节点会让"已隐藏"这个状态在 DOM 里说谎。
 */
const SURFACE_SPRING: Transition = { type: 'spring', stiffness: 420, damping: 32, mass: 0.7 };

export interface IslandProps {
  status: SessionStatus;
  onLock: () => void;
  onRequestUnlock: () => void;
  /** 右键菜单「设置」项：打开由 SessionGate 持有的设置面板（FR-02）。 */
  onOpenSettings: () => void;
}

/** 灵动岛。 */
export function Island({ status, onLock, onRequestUnlock, onOpenSettings }: IslandProps): JSX.Element {
  const client = useVaultClient();
  const toast = useToast();

  const island = useUiStore((state) => state.island);
  const openIsland = useUiStore((state) => state.openIsland);
  const closeIsland = useUiStore((state) => state.closeIsland);
  const finishOpening = useUiStore((state) => state.finishOpening);
  const finishClosing = useUiStore((state) => state.finishClosing);
  const setQuery = useUiStore((state) => state.setQuery);
  const setActiveIndex = useUiStore((state) => state.setActiveIndex);
  /** 热区几何（FR-02）：镜像自元数据，设置页改完会写回这里。 */
  const hotzone = useUiStore((state) => state.hotzone);
  const setHotzone = useUiStore((state) => state.setHotzone);
  /** 展开态收起延时（FR-02）：同样镜像自元数据。 */
  const collapseDelayMs = useUiStore((state) => state.collapseDelayMs);
  const setCollapseDelay = useUiStore((state) => state.setCollapseDelay);
  /** 展开态停留时长（无操作多久自动隐藏）：与收起延时分开，见 `lib/timing.ts`。 */
  const dwellDelayMs = useUiStore((state) => state.dwellDelayMs);
  /** 快捷键自定义（NFR 可用性）：镜像自元数据，keydown 是同步路径不能等 Promise。 */
  const shortcuts = useUiStore((state) => state.shortcuts);
  const setShortcuts = useUiStore((state) => state.setShortcuts);

  const expanded = island.phase === 'expanded';
  const unlocked = status === 'unlocked';

  /** 系统"减少动效"开关：开启时表面直接出现，不做位移与缩放。 */
  const reducedMotion = usePrefersReducedMotion();
  /**
   * 入场：从**屏幕顶边之外**滑下来。
   *
   * `y: -44` 比表面高度还靠上，等于起点整块在顶边外侧——桌面上窗口会把这段
   * 裁掉，视觉上就是"岛从顶部边缘滑出来"（用户需求：鼠标回到原位置，岛从原来
   * 顶部位置滑出）。用 -16 只能看到"抖一下"，读不出方向。
   *
   * `transformOrigin: 'top center'` 让缩放锚在顶边，配合纵向位移才像"抽出来"，
   * 而不是"从中心胀开"。
   */
  const surfaceMotion = reducedMotion
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: 0.12 } as Transition }
    : {
        initial: { y: -44, opacity: 0, scale: 0.96 },
        animate: { y: 0, opacity: 1, scale: 1 },
        transition: SURFACE_SPRING,
      };

  const [items, setItems] = useState<ItemSummary[]>([]);
  // 快捷新建（SDD Phase 3）：不解锁主面板就能在岛内建卡并生成密码。
  const [createOpen, setCreateOpen] = useState(false);
  const [createTitle, setCreateTitle] = useState('');
  const [createUsername, setCreateUsername] = useState('');
  const [createPassword, setCreatePassword] = useState('');
  const [creating, setCreating] = useState(false);
  /** 右键菜单（PRD FR-02）。右键与「菜单」按钮共用同一份开合状态。 */
  const [menuOpen, setMenuOpen] = useState(false);
  /** 滚轮「滑动线」选择器是否开着（见 `IslandScrollPicker`）。 */
  const [pickerOpen, setPickerOpen] = useState(false);
  /**
   * 桌面壳是否提供原生能力（开机自启 / 退出）。
   *
   * 只读一次：端口类型在应用生命周期内不会变（要么是 Tauri 壳要么是浏览器
   * no-op），每次渲染都问一遍没有意义。Web 预览为 `false`，菜单里两项如实
   * 禁用并说明"仅桌面版可用"——不给用户摆一个点了没反应的按钮。
   */
  const [nativeAvailable] = useState(() => shellPort().available());
  /**
   * 开机自启的**真实**状态，`null` = 还不知道（没读过 / 读失败）。
   *
   * 必须从壳里读，不能在前端自己存：用户可能刚在任务管理器的"启动"页把它
   * 关掉，也可能装了两份密岛。每次打开菜单都重读一次，菜单上写的才是真的。
   */
  const [autostartEnabled, setAutostartEnabled] = useState<boolean | null>(null);
  /** 退出统一走 `dispose() → shell_quit`（清剪贴板再退），复用同一份实现。 */
  const quitViaShell = useQuitViaShell();
  /**
   * 跳转二选一菜单（PRD FR-07.1「卡片**与灵动岛**提供跳转操作」）。
   *
   * 存 id 而不是布尔：菜单里的「在浏览器打开」要知道跳的是哪张卡。
   * 另有一份 ref 同步给 `scheduleHide` —— 定时器回调读到的是闭包快照，
   * 状态在排程之后才变的话，闭包里永远是旧值。
   */
  const [jumpMenuId, setJumpMenuId] = useState<number | null>(null);
  const jumpMenuOpenRef = useRef(false);
  /** 菜单定位锚点：右键落在哪一行就贴哪一行（`ItemJumpMenu` 按它算位置）。 */
  const jumpAnchorRef = useRef<HTMLElement | null>(null);
  /**
   * 视口宽度：热区的 `left/width` 与命中判定都基于它。
   *
   * 单独存 state 而不是渲染时直接读 `window.innerWidth`：窗口一改大小，
   * 命中区间就变了，但 React 不会因为 `innerWidth` 变化而重渲染——热区会
   * 停在旧位置，直到下一次无关的状态更新才"突然跳过去"。
   */
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === 'undefined' ? 0 : window.innerWidth,
  );
  const panelRef = useRef<HTMLDivElement | null>(null);
  const capsuleRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const hideTimer = useRef<number | null>(null);
  /** 停留计时器（「停留时长」）：无操作到点自动隐藏。 */
  const dwellTimer = useRef<number | null>(null);
  /** 悬停展开的意图计时器：指针扫过顶部时不立刻展开。 */
  const hoverTimer = useRef<number | null>(null);
  /**
   * 空闲超时隐藏后，抑制"悬停即展开"，直到指针真正离开表面。
   *
   * 没有它就会闪烁：面板在指针还压在上面时被收起，指针随即落在胶囊上触发
   * `pointerenter`，面板立刻又展开，再等一轮再收——用户看到的是抽风。
   */
  const suppressHoverExpandRef = useRef(false);
  /** 最后一次"用户在动"的时刻（移动/按键/滚轮），供停留计时判断是否真的空闲。 */
  const lastInteractionRef = useRef(0);
  /**
   * 灵动岛表面是否已经"被唤起"。
   * 默认 false：页面加载后除了热区命中带，屏幕上不应该出现任何灵动岛可见表面。
   */
  const [revealed, setRevealed] = useState(false);

  /** 相位放进 ref：隐藏定时器回调里要读最新相位，又不想让它频繁重建。 */
  const phaseRef = useRef<IslandPhase>(island.phase);
  phaseRef.current = island.phase;

  /** 搜索词放进 ref：判断"用户是否在键盘上工作"。 */
  const queryRef = useRef(island.query);
  queryRef.current = island.query;

  /** 快捷新建表单是否打开：填表单属于"正在工作"，不能随指针离开被销毁。 */
  const createOpenRef = useRef(createOpen);
  createOpenRef.current = createOpen;

  /** 是否由键盘唤出：键盘用户不该被"指针离开"打断。 */
  const keyboardSummonedRef = useRef(false);

  /**
   * 复位快捷新建表单。
   *
   * 主动 dismiss（Esc / 点击外部）必须调用它，否则下次唤出会看到上次残留的标题，
   * 而且 `createOpen` 一直为真 → 隐藏被无条件顺延 → 岛再也收不起来。
   */
  const resetCreateState = useCallback((): void => {
    setCreateOpen(false);
    setCreateTitle('');
    setCreateUsername('');
    setCreatePassword('');
  }, []);

  // `openIsland` 只负责进入 opening；Web 阶段没有真实窗口动画，
  // 因此这里立即收尾到 expanded（Tauri 版本会改由窗口动画完成回调触发）。
  useEffect(() => {
    if (island.phase === 'opening') {
      finishOpening();
    }
  }, [island.phase, finishOpening]);

  // 展开时拉取最近使用（最多 6 条，由核心层保证顺序与上限）。
  useEffect(() => {
    if (!expanded || !unlocked) {
      return;
    }
    let cancelled = false;
    void client
      .getIslandItems()
      .then((recent) => {
        if (!cancelled) {
          setItems(recent);
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          toast(describeError(caught));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [client, expanded, unlocked, toast]);

  // 展开后聚焦搜索框。
  useEffect(() => {
    if (expanded) {
      inputRef.current?.focus();
    }
  }, [expanded]);

  // 收起动画结束后复位状态。
  useEffect(() => {
    if (island.phase !== 'closing') {
      return;
    }
    const timer = window.setTimeout(() => {
      finishClosing();
    }, CLOSING_DURATION_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [island.phase, finishClosing]);

  // 点击外部收起。
  useEffect(() => {
    if (!expanded) {
      return;
    }
    const onPointerDown = (event: PointerEvent): void => {
      const panel = panelRef.current;
      if (panel !== null && event.target instanceof Node && panel.contains(event.target)) {
        return;
      }
      // 用户主动 dismiss：表面也要一起撤掉，否则胶囊会一直挂在屏幕上；
      // 同时复位快捷新建，避免下次唤出看到残留表单（也会让隐藏被永久顺延）。
      resetCreateState();
      setRevealed(false);
      closeIsland();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [closeIsland, expanded, resetCreateState]);

  // 卸载时清掉所有定时器（延时分两档：胶囊 250ms / 展开态可配置，见 scheduleHide）。
  useEffect(
    () => () => {
      if (hideTimer.current !== null) {
        window.clearTimeout(hideTimer.current);
      }
      if (dwellTimer.current !== null) {
        window.clearTimeout(dwellTimer.current);
      }
      if (hoverTimer.current !== null) {
        window.clearTimeout(hoverTimer.current);
      }
    },
    [],
  );

  /**
   * 展开后开始「停留计时」，收起后停表。实现放在 `armDwell` / `cancelDwell`
   * 定义之后（依赖数组在渲染期求值，提前引用会撞暂时性死区）。
   */


  /**
   * 指针此刻是否落在灵动岛表面（面板或折叠胶囊）内部。
   *
   * 两条判据，任一成立即在岛内：
   * 1. `event.target` 是面板/胶囊的子孙节点（绝大多数情况）；
   * 2. 坐标落在面板/胶囊的矩形内 —— 面板是 30px 圆角，圆角外的四角窄条上
   *    `target` 会退化成 `body`，只靠第 1 条会在这些角落误判成"已离开"。
   *
   * jsdom 的 `getBoundingClientRect()` 全是 0，`width > 0` 的判断会自动跳过第 2 条，
   * 测试里仍然只走第 1 条。
   */
  const isPointerInside = useCallback(
    (target: EventTarget | null, clientX?: number, clientY?: number): boolean => {
      const panel = panelRef.current;
      const capsule = capsuleRef.current;
      if (target instanceof Node) {
        if (panel !== null && panel.contains(target)) {
          return true;
        }
        if (capsule !== null && capsule.contains(target)) {
          return true;
        }
      }
      if (typeof clientX !== 'number' || typeof clientY !== 'number') {
        return false;
      }
      for (const surface of [panel, capsule]) {
        if (surface === null) {
          continue;
        }
        const rect = surface.getBoundingClientRect();
        if (
          rect.width > 0 &&
          rect.height > 0 &&
          clientX >= rect.left &&
          clientX <= rect.right &&
          clientY >= rect.top &&
          clientY <= rect.bottom
        ) {
          return true;
        }
      }
      return false;
    },
    [],
  );

  /**
   * 用户是否正在用键盘干活。
   *
   * 展开态会**自动聚焦**搜索框（便利而非用户意图），所以只看"内部有焦点"是不够的：
   * 鼠标唤出的面板会被这条规则永久钉住。因此只在三种明确意图下顺延——
   * 1. 用户用键盘唤出；
   * 2. 已经输入过搜索词；
   * 3. 快捷新建表单正开着（标题还没填完，绝对不能弄丢）。
   */
  const isUserWorking = useCallback((): boolean => {
    return (
      keyboardSummonedRef.current ||
      queryRef.current.trim().length > 0 ||
      createOpenRef.current
    );
  }, []);

  const cancelHide = useCallback((): void => {
    if (hideTimer.current !== null) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }, []);

  /** 灵动岛内部是否还持有键盘焦点（打字时不允许面板消失）。 */
  const hasInternalFocus = useCallback((): boolean => {
    const active = document.activeElement;
    if (active === null || active === document.body) {
      return false;
    }
    const panel = panelRef.current;
    if (panel !== null && panel.contains(active)) {
      return true;
    }
    const capsule = capsuleRef.current;
    return capsule !== null && capsule.contains(active);
  }, []);

  /**
   * 真正执行隐藏：撤掉表面 + 收起面板。
   *
   * 两条触发路径共用（指针离开后的 `scheduleHide`、空闲到点的 `armDwell`），
   * 所以"隐藏"这件事只有一处实现——分开写必然出现一处忘了复位键盘唤出标记，
   * 于是下一次唤出面板立刻被"键盘优先"永久钉住。
   *
   * `suppressHoverExpandRef`：隐藏那一刻指针**还停在表面上**（空闲超时这条路径
   * 就是如此），说明用户没走、只是没动。此时若放任"悬停即展开"，面板会在
   * 收起动画刚结束时又被展开，形成无限闪烁。置位后由 `pointerleave` 解除。
   */
  const hideNow = useCallback((): void => {
    if (createOpenRef.current) {
      return;
    }
    // 跳转菜单开着时**无条件**顺延：菜单 portal 到了 body，指针已经离开岛内，
    // 照常隐藏会把菜单连面带岛一起撤掉，用户根本没机会点。
    if (jumpMenuOpenRef.current) {
      return;
    }
    if (isUserWorking() && hasInternalFocus()) {
      return;
    }
    // 先读 `:hover` 再撤表面：节点一旦卸载，`:hover` 恒为 false。
    // jsdom 不支持 `:hover`，`matches` 会抛错——包一层 try，测试环境按"不在表面"处理。
    let stillOver = false;
    try {
      stillOver =
        (panelRef.current?.matches(':hover') ?? false) ||
        (capsuleRef.current?.matches(':hover') ?? false);
    } catch {
      stillOver = false;
    }
    suppressHoverExpandRef.current = stillOver;
    setRevealed(false);
    // 展开/半展开态必须一起收起，否则面板会被永久钉在屏幕上。
    if (phaseRef.current !== 'collapsed') {
      closeIsland();
    }
    keyboardSummonedRef.current = false;
  }, [closeIsland, hasInternalFocus, isUserWorking]);

  /**
   * 安排隐藏：延时后收起面板并把整个表面从 DOM 里撤掉。
   *
   * 延时按当前相位取：
   * - 折叠胶囊态 → `PEEK_HIDE_DELAY_MS`（250ms）。胶囊只是"探了个头"，
   *   短延时让它不遮挡页面顶部的点击；
   * - 展开态 → `collapseDelayMs`（PRD FR-02「鼠标离开 2 秒后自动收起」，
   *   SDD §6.5「默认 2s，可配置」）。
   *
   * **已排队的隐藏不重复排**：延时从 250ms 变成 2 秒后，若每次 `mousemove`
   * 都清掉重排，用户在页面上随便晃两下鼠标，面板就永远不会收起——定时器被
   * 无限续期。指针回到岛内 / 迟滞带时由 `cancelHide()` 取消，那才是真正
   * 应该中断倒计时的时刻。
   */
  const scheduleHide = useCallback((): void => {
    if (hideTimer.current !== null) {
      // 倒计时已经在走，保持原到期时间。
      return;
    }
    const delay = phaseRef.current === 'collapsed' ? PEEK_HIDE_DELAY_MS : collapseDelayMs;
    hideTimer.current = window.setTimeout(() => {
      hideTimer.current = null;
      hideNow();
    }, delay);
  }, [collapseDelayMs, hideNow]);

  /**
   * 停留计时（「停留时长」）：展开后**无操作**到点就收，指针停在岛上也照样收。
   *
   * 与 `scheduleHide` 的分工：
   * - `scheduleHide` 是"指针走了"——外部事件，延时 `collapseDelayMs`；
   * - `armDwell` 是"人走了但指针还留着"——内部空闲，延时 `dwellDelayMs`。
   *
   * 到点时先看空闲了多久：用户刚刚还在动（`lastInteractionRef` 很新）就只补足
   * 剩余时间，而不是把整段时间重来一遍——否则一次误触就会让面板多留一整轮。
   */
  const armDwell = useCallback((): void => {
    if (dwellTimer.current !== null) {
      window.clearTimeout(dwellTimer.current);
      dwellTimer.current = null;
    }
    // 胶囊态由 `scheduleHide` 的 250ms 管，不叠一层长计时。
    if (phaseRef.current === 'collapsed') {
      return;
    }
    lastInteractionRef.current = Date.now();
    dwellTimer.current = window.setTimeout(() => {
      dwellTimer.current = null;
      const idle = Date.now() - lastInteractionRef.current;
      // 用相对阈值：任何停留时长（含测试用的 40ms 小档）都能正确补足剩余时间，
      // 而不是被固定的 100ms 偏移吃掉（小档位下 `idle < -60` 恒为 false，会直接隐藏）。
      if (idle < dwellDelayMs * 0.5) {
        dwellTimer.current = window.setTimeout(() => {
          dwellTimer.current = null;
          hideNow();
        }, Math.max(0, dwellDelayMs - idle));
        return;
      }
      hideNow();
    }, dwellDelayMs);
  }, [dwellDelayMs, hideNow]);

  const cancelDwell = useCallback((): void => {
    if (dwellTimer.current !== null) {
      window.clearTimeout(dwellTimer.current);
      dwellTimer.current = null;
    }
  }, []);

  /**
   * 展开后开始「停留计时」，收起后停表。
   *
   * 依赖里带 `dwellDelayMs`：用户在设置里改完停留时长，下一轮立刻按新值计时，
   * 不必等岛收起再展开。
   */
  useEffect(() => {
    if (!expanded) {
      cancelDwell();
      return;
    }
    armDwell();
    return cancelDwell;
  }, [expanded, armDwell, cancelDwell]);

  /** 视口宽度跟随窗口变化（热区的横向区间要跟着重算）。 */
  useEffect(() => {
    const onResize = (): void => {
      setViewportWidth(window.innerWidth);
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
    };
  }, []);

  /**
   * 从元数据拉一次热区配置与收起延时，写进 store 供渲染与命中判定同步使用。
   *
   * 失败静默：读不到就用默认值（300px 居中 / 2 秒），**不能**因此让整个岛挂掉——
   * 热区是唤出入口，它出问题等于应用不可用。下次挂载会重试。
   */
  useEffect(() => {
    let cancelled = false;
    void client
      .getHotzoneConfig()
      .then((config) => {
        if (!cancelled) {
          setHotzone(config);
        }
      })
      .catch(() => {
        /* 读不到就用默认值。 */
      });
    void client
      .getCollapseDelay()
      .then((delay) => {
        if (!cancelled) {
          setCollapseDelay(delay);
        }
      })
      .catch(() => {
        /* 读不到就用默认值。 */
      });
    void client
      .getShortcuts()
      .then((next) => {
        if (!cancelled) {
          setShortcuts(next);
        }
      })
      .catch(() => {
        /* 读不到就用默认值。 */
      });
    return () => {
      cancelled = true;
    };
  }, [client, setCollapseDelay, setHotzone, setShortcuts]);

  /** 热区在视口中的横向区间；渲染与命中判定共用这一份计算。 */
  const hotzoneRect = hotzoneBand(hotzone, viewportWidth || 1024);

  /**
   * 顶部热区监听。
   *
   * - 指针落在灵动岛表面内：什么都不做（并取消任何待执行的隐藏）；
   * - `clientY <= HOTZONE_HEIGHT_PX` **且横坐标落在配置的热区带内**：唤出
   *   （渲染折叠胶囊态）；浏览器处于全屏时跳过唤出；
   * - `clientY > HYSTERESIS_LIMIT_PX`：安排隐藏；
   * - 其余（4–48px 迟滞带）：什么都不做，让指针能顺畅"走向"灵动岛。
   *
   * 横向区间来自 `hotzoneBand()`（PRD FR-02「可配置宽度与位置」），与渲染出的
   * 命中带用同一份计算。早期版本只看 Y：整条顶边都是热区，用户点浏览器标签栏
   * 或页面顶部的按钮都会被"顺手唤出"。
   *
   * **务必先判"指针是否在岛内"**：面板从 `top-2` 起、高约 306px，
   * 除了顶部几十 px，其余区域的 `clientY` 全都 > 48。早期版本只看 `clientY`
   * 就安排隐藏，结果鼠标在面板里往下移到列表区（y≈120）就把自己人当外人，
   * 250ms 后面板被撤掉——点列表项、点「新建」、点「立即锁定」全都不可能完成。
   *
   * 同时监听 `pointermove` 与 `mousemove`：后者是不支持 PointerEvent 的
   * 环境（含 jsdom）的回退，两者都是幂等的。
   */
  useEffect(() => {
    /**
     * 只取 `clientY`。
     *
     * 这里刻意做防御：jsdom 没有 `PointerEvent`，`fireEvent.pointerMove`
     * 落到我们手里的是一个没有坐标的普通 `Event`（`clientY === undefined`）。
     * 生产环境（真实浏览器 / WebView2）一定带坐标，所以不能反过来
     * "没坐标就当顶部"；遇到未知坐标直接忽略，交给 `mousemove` 兜底。
     */
    const onMove = (event: Event): void => {
      const clientY = (event as Partial<MouseEvent>).clientY;
      const clientX = (event as Partial<MouseEvent>).clientX;
      if (typeof clientY !== 'number') {
        return;
      }
      if (isPointerInside(event.target, clientX, clientY)) {
        // 指针在岛内：取消待执行的隐藏，并告诉停留计时"人还在"。
        cancelHide();
        lastInteractionRef.current = Date.now();
        return;
      }
      if (clientY <= HOTZONE_HEIGHT_PX && isWithinHotzoneX(clientX, hotzone, viewportWidth)) {
        cancelHide();
        /**
         * 全屏时**不唤出**（PRD FR-02 验收要点「全屏应用前台时鼠标划过顶部不弹出」）。
         *
         * 命中判定放在全屏判断之前：全屏下指针划过顶部同样不该触发隐藏，
         * 否则用户全屏看视频时把鼠标甩到顶边，会把一个已经展开的岛收掉。
         *
         * Web 阶段只能看到浏览器自身的全屏（F11 / Fullscreen API）。系统里另开的
         * 全屏游戏在浏览器进程之外，这里看不到——设置页对此有明确说明。
         */
        if (isFullscreenActive(document)) {
          return;
        }
        // 鼠标唤出：不启用"键盘优先"保护（否则自动聚焦会让面板永远收不起来）。
        keyboardSummonedRef.current = false;
        setRevealed(true);
        return;
      }
      if (clientY <= HYSTERESIS_LIMIT_PX) {
        // 迟滞带：不仅"不安排新的隐藏"，还要**取消已排队的隐藏**。
        // 否则指针从下方快速回到顶端附近时，之前那次 scheduleHide 仍会到期，
        // 在指针离岛只有几十 px 时把岛藏掉。
        cancelHide();
        return;
      }
      scheduleHide();
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('mousemove', onMove, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('mousemove', onMove);
      cancelHide();
    };
  }, [cancelHide, hotzone, isPointerInside, scheduleHide, viewportWidth]);

  /** 键盘唤出：露出表面并展开，随后把焦点交给搜索框。 */
  const revealAndOpen = useCallback((): void => {
    cancelHide();
    keyboardSummonedRef.current = true;
    setRevealed(true);
    if (phaseRef.current === 'collapsed') {
      openIsland();
    }
  }, [cancelHide, openIsland]);

  /**
   * 打开卡片配置的网址（PRD FR-07.1）。
   *
   * 与 `ItemCard.openUrl` 同规则：**真的打开了才记账**。目标由门面裁成
   * origin + pathname，query 里的 token 不会进日志。
   *
   * 为什么每次都要 `getItem()`：列表项里只有 `hasUrl` 布尔值（"有没有网址"），
   * 完整 URL 存在加密详情里。想省这一次请求就得把 URL 明文塞进摘要——
   * 那会让列表渲染路径持有全部登录链接，与"明文只在必要时短暂出现"冲突。
   */
  const openItemUrl = useCallback(
    (id: number): void => {
      void client
        .getItem(id)
        .then((detail) => {
          if (detail.url !== null && openExternal(detail.url)) {
            void client.recordJump(id, detail.url).catch(() => {
              // 记账失败不影响跳转本身。
            });
            return;
          }
          toast('无法打开该链接');
        })
        .catch((caught: unknown) => {
          toast(describeError(caught));
        });
    },
    [client, toast],
  );

  /**
   * 灵动岛侧的跳转入口（PRD FR-07.1「卡片**与灵动岛**提供跳转操作」）。
   *
   * 判定规则与 `ItemCard.handleOpen` **逐条一致**：单目标直接跳、双目标弹二选一
   * 菜单、只有本地应用给桌面版提示。两处不同源就会出现"卡片上点了弹菜单、
   * 岛上点了直接开网页"的分裂行为——用户没有任何理由理解这个差异。
   *
   * 入口有两处，都不占列表空间：右键卡片（鼠标）与 Ctrl+Enter（键盘）。
   * 不在每行塞图标：列表行高只有 32px，主路径是"搜到 → Enter 复制密码"，
   * 多一个常驻图标会让高频操作变拥挤，也改变 listbox 的语义
   * （`role="option"` 里不该有可聚焦子元素）。
   */
  const handleJump = (item: ItemSummary, anchor: HTMLElement | null): void => {
    cancelHide();
    if (item.hasUrl && item.hasAppTarget) {
      jumpAnchorRef.current = anchor;
      jumpMenuOpenRef.current = true;
      setJumpMenuId(item.id);
      return;
    }
    if (item.hasUrl) {
      openItemUrl(item.id);
      return;
    }
    if (item.hasAppTarget) {
      toast('桌面版将启动本地应用（Web 阶段不执行本地路径）');
      return;
    }
    toast('该卡片没有配置跳转目标');
  };

  /** 关掉跳转菜单（供 `ItemJumpMenu` 与菜单项共用）。 */
  const closeJumpMenu = useCallback((): void => {
    jumpMenuOpenRef.current = false;
    jumpAnchorRef.current = null;
    setJumpMenuId(null);
  }, []);

  /** 面板不仅要失去焦点保护，还要在看得到的时候才参与隐藏判断。 */
  const handlePanelPointerEnter = useCallback((): void => {
    cancelHide();
    lastInteractionRef.current = Date.now();
  }, [cancelHide]);

  const handlePanelPointerLeave = useCallback((): void => {
    // 指针真的离开了：解除"空闲隐藏后不许悬停展开"的抑制。
    suppressHoverExpandRef.current = false;
    scheduleHide();
  }, [scheduleHide]);

  /**
   * 悬停胶囊即展开（「鼠标移到原位置，岛从顶部滑出」）。
   *
   * 桌面壳里岛形态的窗口就是这枚胶囊，页面热区帮不上忙——指针能碰到的只有它，
   * 所以唤出必须由 `pointerenter` 驱动，而不是等用户点。
   *
   * 用 140ms 的意图延时而不是立即展开：指针从屏幕上方"路过"顶部时也会进到胶囊，
   * 立刻展开会让岛一直在闪。140ms 足够区分"路过"和"停下来了"。
   */
  const handleCapsulePointerEnter = useCallback((): void => {
    cancelHide();
    lastInteractionRef.current = Date.now();
    if (!unlocked || suppressHoverExpandRef.current) {
      return;
    }
    if (hoverTimer.current !== null) {
      window.clearTimeout(hoverTimer.current);
    }
    hoverTimer.current = window.setTimeout(() => {
      hoverTimer.current = null;
      openIsland();
    }, HOVER_EXPAND_DELAY_MS);
  }, [cancelHide, openIsland, unlocked]);

  const handleCapsulePointerLeave = useCallback((): void => {
    if (hoverTimer.current !== null) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    suppressHoverExpandRef.current = false;
    scheduleHide();
  }, [scheduleHide]);

  /**
   * 滚轮唤出 / 翻动「滑动线」选择器（用户需求：鼠标移到岛上滚中键）。
   *
   * 实现见 `handleItemClick` 之后的同名函数：那里 `visible` / `activeIndex`
   * 已经算好，`useCallback` 的依赖数组才不会撞上暂时性死区。
   */

  /**
   * 焦点离开灵动岛时撤销"键盘唤出"的顺延资格。
   *
   * 否则键盘唤出后焦点一直挂在搜索框上，指针怎么移都不会收起，面板会长期滞留
   * （QA 复验的 P2-5）。这里只撤销资格、不立即隐藏：用户可能只是点了面板空白，
   * 指针还在岛内，立刻隐藏会把面板从鼠标底下抽走。
   */
  const handleSurfaceBlur = useCallback((event: FocusEvent<HTMLElement>): void => {
    const next = event.relatedTarget;
    if (next instanceof Node) {
      const panel = panelRef.current;
      const capsule = capsuleRef.current;
      if ((panel !== null && panel.contains(next)) || (capsule !== null && capsule.contains(next))) {
        return;
      }
    }
    keyboardSummonedRef.current = false;
  }, []);

  const needle = island.query.trim().toLowerCase();
  const visible = needle.length === 0
    ? items
    : // 复用核心层的匹配规则：支持标题/平台/账号/分类/标签，并带拼音全拼与首字母
      // （与主面板 `searchItems` 保持一致，避免"主面板能搜到、岛里搜不到"）。
      // 这里只过滤不排序，保持 `getRecentItems` 的最近使用顺序。
      items.filter((item) => matchesText(item, needle));

  /**
   * 渲染期夹取活动下标，**双边**。
   *
   * 只夹上界（`Math.min`）时，注入负数（如 -5）会原样透传：`visible[-5]` 是 undefined，
   * 于是 `[aria-selected="true"]` 一个都没有 —— 选中态整体消失、Enter 变成空操作。
   * 下界必须一起夹。
   */
  const activeIndex = visible.length === 0
    ? 0
    : Math.max(0, Math.min(island.activeIndex, visible.length - 1));

  /**
   * 列表此刻是否**真的**渲染出来了。
   *
   * 表单态 / 锁定态 / 空结果都不渲染 `<ul role="listbox">`，此时 `aria-expanded`、
   * `aria-controls`、`aria-activedescendant` 必须一起闭嘴：否则屏幕阅读器会被告知
   * "列表已展开"，而 `aria-activedescendant` 指向的节点根本不在文档里（axe-core 的
   * `aria-valid-attr-value` 会报 dangling 引用）。
   */
  const listVisible = unlocked && !createOpen && visible.length > 0;

  /**
   * 把活动项滚进可视区。
   *
   * 条目多于可视高度时，按住 ↓ 会让选中项跑出容器。这里用 `block: 'nearest'`
   * 且**不加** `behavior: 'smooth'`：连续按 ↓ 时平滑滚动会排队、看起来发卡。
   *
   * 防 `island-option-undefined` 靠的是 `aria-activedescendant` 里的
   * `visible[activeIndex] !== undefined` 守卫，**不是**上面的夹取 —— 夹取只保证
   * 下标落在合法区间，列表清空那一刻仍可能算出一个指向空数组的 0。
   *
   * jsdom 没有实现 `scrollIntoView`，必须做能力守卫，否则所有 island 用例会集体报错。
   */
  useEffect(() => {
    const panel = panelRef.current;
    if (panel === null) {
      return;
    }
    const selected = panel.querySelector('[aria-selected="true"]');
    if (selected === null) {
      return;
    }
    if (typeof selected.scrollIntoView === 'function') {
      selected.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex, visible.length, revealed]);

  /**
   * 按 id 复制字段。
   *
   * 键盘路径可以用 `visible[activeIndex]` 的闭包值，鼠标点击不行：`setActiveIndex(index)`
   * 是异步的，点击回调里读到的 `activeIndex` 还是上一次的值。所以这里按 id 查，
   * 键盘与鼠标两条路径共用同一份复制逻辑。
   */
  const copyItemField = async (itemId: number | undefined, field: 'password' | 'username'): Promise<void> => {
    if (itemId === undefined) {
      return;
    }
    try {
      const receipt =
        field === 'password'
          ? await client.copyPassword(itemId)
          : await client.copyUsername(itemId);
      // 关闭自动清理时不能说"N 秒后自动清空"——那是错的，也会让用户以为密码会自己消失。
      toast(
        receipt.autoClear
          ? `已复制${field === 'password' ? '密码' : '账号'} · ${Math.round(receipt.ttlMs / 1000)} 秒后自动清空`
          : `已复制${field === 'password' ? '密码' : '账号'} · 不会自动清空`,
      );
    } catch (caught) {
      toast(describeError(caught));
    }
  };

  /**
   * 生成一个新密码并复制（PRD FR-02 快捷按钮「生成密码」）。
   *
   * 岛内不显示明文（SDD：岛内只显示账号与操作），所以这里的落点是"复制 + 提示"。
   * 不要求解锁：不读写库内数据，锁定时生成一个密码去别处用是合理需求。
   */
  const handleGeneratePassword = async (): Promise<void> => {
    try {
      const receipt = await client.copyGeneratedPassword();
      toast(
        receipt.autoClear
          ? `已复制新生成的密码 · ${Math.round(receipt.ttlMs / 1000)} 秒后自动清空`
          : '已复制新生成的密码 · 不会自动清空',
      );
    } catch (caught) {
      toast(describeError(caught));
    }
  };

  /** 复制高亮项（Enter / Shift+Enter 路径）。 */
  const copyField = async (field: 'password' | 'username'): Promise<void> => {
    await copyItemField(visible[activeIndex]?.id, field);
  };

  /**
   * 点击卡片：先高亮它，再复制密码。
   *
   * 不收起岛 —— 与 Enter 路径保持一致（复制完还想再复制账号，收起就得多唤出一次）。
   */
  const handleItemClick = (index: number, itemId: number): void => {
    setActiveIndex(index);
    void copyItemField(itemId, 'password');
  };

  /**
   * 滚轮唤出 / 翻动「滑动线」选择器（用户需求：鼠标移到岛上滚中键）。
   *
   * 两条分支刻意不对称：
   * - 选择器**没开**：只有当滚轮不是发生在"真的能滚的列表"里时才拦截。
   *   列表 50 条时用户滚轮是想看后面的卡，抢过来变成"翻选择器"就是倒退。
   * - 选择器**开着**：滚轮归选择器，`preventDefault` 掉列表滚动，避免两层一起动。
   *
   * 必须放在 `visible` / `activeIndex` 之后：`useCallback` 的依赖数组在渲染期
   * 求值，提前引用会撞上暂时性死区。
   */
  const handleWheel = useCallback(
    (event: WheelEvent<HTMLElement>): void => {
      if (!unlocked || visible.length === 0 || event.deltaY === 0) {
        return;
      }
      if (!pickerOpen) {
        const target = event.target;
        const scroller =
          target instanceof Element ? target.closest('[data-island-scroller]') : null;
        if (scroller !== null && scroller.scrollHeight > scroller.clientHeight + 1) {
          // 列表自己能滚：这一滚归列表。
          return;
        }
        event.preventDefault();
        lastInteractionRef.current = Date.now();
        setPickerOpen(true);
        // 往下滚从第一张开始，往上滚从最后一张开始——方向感与列表一致。
        setActiveIndex(event.deltaY > 0 ? 0 : visible.length - 1);
        return;
      }
      event.preventDefault();
      lastInteractionRef.current = Date.now();
      const next = activeIndex + (event.deltaY > 0 ? 1 : -1);
      setActiveIndex(Math.max(0, Math.min(next, visible.length - 1)));
    },
    [activeIndex, pickerOpen, setActiveIndex, unlocked, visible.length],
  );

  /** 重新拉取最近使用（新建卡片后刷新列表）。 */
  const refreshRecent = async (): Promise<void> => {
    try {
      setItems(await client.getIslandItems());
    } catch (caught) {
      // 刷新失败不影响刚创建的卡片，只提示，不打断闭环。
      toast(describeError(caught));
    }
  };

  /** 打开快捷新建：用当前搜索词预填标题，并预生成一个密码。 */
  const openCreate = (): void => {
    setCreateTitle(needle.length > 0 ? needle : '');
    setCreateUsername('');
    setCreatePassword(client.generatePassword());
    setCreateOpen(true);
  };

  /**
   * 右键菜单「打开主面板」。
   *
   * **桌面壳（岛形态）下必须走 `shell.showMain()`**：主面板此时只是 `hidden`，
   * 窗口也只有 320/400 宽，光对搜索框 `focus()` 是看不见的——用户点了菜单项
   * 会觉得"没反应"（线上反馈的原 bug）。
   *
   * Web / 预览下 `showMain` 是 no-op，`focus()` 仍然给出可见反馈。两者都做，
   * 就不需要在这里判环境。
   */
  const handleOpenMainPanel = useCallback((): void => {
    void shellPort().showMain();
    window.setTimeout(() => {
      document.getElementById('main-search')?.focus();
    }, 0);
  }, []);

  /**
   * 每次打开菜单重读一次开机自启状态。
   *
   * 缓存在 state 里是为了渲染时能同步取用（菜单项文案要立刻正确），但**真值
   * 在注册表**：用户可能在系统"启动应用"里手动关掉，也可能刚装完另一份副本。
   * 打开菜单时刷新，代价是一次注册表读，换来菜单上写的一定是当下的事实。
   */
  useEffect(() => {
    if (!menuOpen || !nativeAvailable) {
      return;
    }
    let cancelled = false;
    void shellPort()
      .getAutostart()
      .then((enabled) => {
        if (!cancelled) {
          setAutostartEnabled(enabled);
        }
      })
      .catch(() => {
        // 端口内部已静默（返回 null），这里只是兜底。
      });
    return () => {
      cancelled = true;
    };
  }, [menuOpen, nativeAvailable]);

  /**
   * 切换开机自启。
   *
   * 用壳返回的**落地状态**回写，而不是自己 `!autostartEnabled` 取反：写注册表
   * 可能失败（被策略拦、被安全软件拦），失败时菜单必须回到真实状态，否则用户
   * 会以为已经开好了，下次开机才发现没有。
   */
  const handleToggleAutostart = useCallback((): void => {
    void shellPort()
      .setAutostart(!(autostartEnabled === true))
      .then((next) => {
        if (next === null) {
          toast('开机自启设置失败，可能被系统策略拦截');
          return;
        }
        setAutostartEnabled(next);
        toast(next ? '已开启开机自启' : '已关闭开机自启');
      })
      .catch(() => {
        toast('开机自启设置失败');
      });
  }, [autostartEnabled, toast]);

  // 岛收起时菜单与滑动线必须一起关：面板卸载后状态仍在，下次唤出会看到一份幽灵菜单。
  useEffect(() => {
    if (!expanded) {
      setMenuOpen(false);
      setPickerOpen(false);
    }
  }, [expanded]);

  /** 提交快捷新建：建卡后立即复制密码，完成 5 秒闭环。 */
  const handleCreate = async (): Promise<void> => {
    const title = createTitle.trim();
    if (title.length === 0) {
      toast('请填写标题');
      return;
    }
    // 密码现在可自定义：允许改成任意值，但不能为空——按钮承诺「创建并复制密码」，
    // 空密码复制出去只会让用户以为没生效。不改就保留预生成的那个。
    if (createPassword.length === 0) {
      toast('请填写或生成密码');
      return;
    }
    setCreating(true);
    try {
      const created = await client.createItem({
        title,
        username: createUsername.trim(),
        password: createPassword,
      });
      await client.copyPassword(created.id);
      toast('已创建卡片，密码已复制到剪贴板');
      resetCreateState();
      await refreshRecent();
      closeIsland();
    } catch (caught) {
      toast(describeError(caught));
    } finally {
      setCreating(false);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // 任何按键都算"人还在"：重排「停留计时」定时器（不只更新标记）。
    // 只更新 `lastInteractionRef` 并不会让已排好的隐藏定时器作废——岛仍会被收走，
    // 这正是项②"在岛上操作时不应被空闲隐藏"要修的点。
    armDwell();
    if (event.key === 'Escape') {
      event.preventDefault();
      // 滑动线开着时 Esc 只关它：用户是在退出"翻卡"这一层，不是退出整个岛。
      if (pickerOpen) {
        setPickerOpen(false);
        return;
      }
      // 快捷新建里的 Esc 只退出新建，不收起整个岛。
      if (createOpen) {
        // 退出新建时连表单内容一起清掉，避免下次打开看到上次的残留。
        resetCreateState();
        return;
      }
      // 用户主动 dismiss：表面也要一起撤掉，否则面板没了但胶囊还留在屏幕上。
      resetCreateState();
      setRevealed(false);
      closeIsland();
      return;
    }
    if (!unlocked) {
      return;
    }
    /**
     * 快捷新建表单里的按键归表单和原生输入框所有，面板这一层必须让路。
     *
     * 表单提交靠浏览器的**隐式提交**（输入框里按 Enter 触发表单的 submit 事件），
     * 面板若在这一层 `preventDefault()`，隐式提交会被掐掉、`onSubmit` 永不触发 ——
     * 卡建不出来。更糟的是 Enter 会落到下面的 `copyField`，而表单开着时列表已经
     * 换成表单了，`visible[activeIndex]` 仍是旧列表，于是复制了**另一张卡**的密码
     * （QA 抓到的 P1）。
     *
     * 顺带挡掉的第二件事：表单开着时按 ↑↓ 不会再去改那个**已经看不见的**列表的选中项。
     * 旧行为下用户填完标题顺手按一下 ↓，后台列表高亮会莫名其妙跳一格，提交后
     * 列表回来时高亮已经不在原来的位置了。
     *
     * 注意必须放在 Esc 分支**之后**：Esc 在表单里只退出新建，不能一起被让路。
     */
    if (createOpen) {
      return;
    }
    /**
     * 以下四个动作的组合键全部来自用户配置（NFR 可用性「快捷键可自定义」）。
     *
     * 为什么用 `matchesBinding` 逐个比修饰键，而不是像从前那样
     * `event.key === 'Enter' && event.ctrlKey`：用户可选的组合里既有裸 `Enter`
     * 也有 `Ctrl+Enter` / `Shift+Enter` / `Alt+Enter`。若只判 `event.key`，
     * 用户把复制密码设成 `Alt+Enter` 后，按 Ctrl+Enter 依然会触发复制——
     * 那是把密码送到一个用户没要求的地方去。逐个比修饰键后，
     * 每个组合只会命中它自己那一个动作。
     *
     * ↑↓ 与 Esc 是固定项（APG 规范），不走配置，见 `lib/shortcuts.ts`。
     */
    if (matchesBinding(event, shortcuts.nav_down)) {
      event.preventDefault();
      setActiveIndex(visible.length === 0 ? 0 : (activeIndex + 1) % visible.length);
      return;
    }
    if (matchesBinding(event, shortcuts.nav_up)) {
      event.preventDefault();
      setActiveIndex(visible.length === 0 ? 0 : (activeIndex - 1 + visible.length) % visible.length);
      return;
    }
    /**
     * 跳转（PRD FR-07.1「卡片与灵动岛提供跳转操作」）。
     *
     * 必须放在复制密码分支**之前**。从前这里靠"先判 ctrlKey"来保证顺序；
     * 改成配置驱动后，`matchesBinding` 已经通过修饰键逐個比对把两类组合分开了
     * （复制密码设成 `Alt+Enter` 时，Ctrl+Enter 不会命中它），所以顺序本身不再
     * 承载正确性。但保留这个顺序仍然是便宜的保险：万一将来的备选列表里出现
     * 一个既是另一个动作前缀的组合，先判特异性高的那个。
     *
     * 锚点取当前高亮行：菜单要贴着它出现，键盘用户看不到自己在右键哪一行。
     */
    if (matchesBinding(event, shortcuts.jump)) {
      event.preventDefault();
      const selected = visible[activeIndex];
      if (selected !== undefined) {
        const anchor =
          panelRef.current?.querySelector<HTMLElement>('[aria-selected="true"]') ?? null;
        handleJump(selected, anchor);
      }
      return;
    }
    if (matchesBinding(event, shortcuts.copy_username)) {
      event.preventDefault();
      void copyField('username');
      return;
    }
    if (matchesBinding(event, shortcuts.copy_password)) {
      event.preventDefault();
      void copyField('password');
      return;
    }
  };

  return (
    <>
      {/**
       * 热区命中带：4px 高、宽度与水平位置可配置（PRD FR-02），视觉上完全不可见。
       *
       * 刻意用 `pointer-events-none`：唤起靠的是 window 上的 mousemove（事件照样冒泡到
       * window），所以命中带不需要接收事件；一旦接收，就会吃掉页面最顶端那一条的点击
       * （QA 复验的 P2-2）。它现在纯粹是"热区"这个概念在 DOM 里的锚点，
       * 同时让用户（和测试）能看到设置到底改了哪一段。
       *
       * `left/width` 用内联样式而不是 Tailwind 类：宽度是运行时变量，
       * Tailwind 的静态类扫不到任意像素值。
       */}
      <div
        data-testid="island-hotzone"
        data-align={hotzone.align}
        data-width={hotzone.widthPx}
        aria-hidden="true"
        className="pointer-events-none fixed top-0 z-40 h-1 bg-transparent"
        style={{ left: `${hotzoneRect.left}px`, width: `${hotzoneRect.width}px` }}
      />

      {/**
       * 键盘可达的唤出入口。
       * 不能用 `display:none` / `visibility:hidden`，否则 Tab 不到；
       * 用 `opacity-0` + 4px 高度保持可聚焦但不可见。
       * 同样 `pointer-events-none`：鼠标用户靠顶部热区唤出，这里只服务键盘，
       * 因此不该截获顶部中央那 88px 的点击。键盘 Enter/Space 触发的 click 不受影响。
       * 键盘用户 Tab 到这里时给一个可见焦点提示（WCAG 2.4.7），
       * 焦点随即被交到搜索框，提示也就随之消失。
       */}
      <button
        type="button"
        role="button"
        aria-label="唤出灵动岛"
        data-testid="island-summon"
        onFocus={revealAndOpen}
        onClick={revealAndOpen}
        className="group pointer-events-none fixed top-0 left-1/2 z-40 flex h-1 -translate-x-1/2 items-center justify-center rounded-b bg-transparent opacity-0 focus-visible:h-6 focus-visible:bg-zinc-900/90 focus-visible:opacity-100 focus-visible:outline-none"
        style={{ width: SUMMON_BUTTON_WIDTH_PX }}
      >
        <span aria-hidden="true" className="hidden text-[10px] font-medium text-white group-focus-visible:inline">
          密岛
        </span>
      </button>

      {/* 非唤起态只保留热区与键盘入口：搜索框、胶囊、面板都不进 DOM。 */}
      {revealed || island.phase !== 'collapsed' ? (
        <>
          {!expanded ? (
            <motion.div
              {...surfaceMotion}
              className="pointer-events-none fixed inset-x-0 top-2 z-40 flex justify-center"
            >
              <button
                ref={capsuleRef}
                type="button"
                aria-label="展开密岛"
                onPointerEnter={handleCapsulePointerEnter}
                onPointerLeave={handleCapsulePointerLeave}
                onWheel={handleWheel}
                onBlur={handleSurfaceBlur}
                onClick={() => {
                  if (!unlocked) {
                    onRequestUnlock();
                    return;
                  }
                  openIsland();
                }}
                className="pointer-events-auto flex items-center gap-2 rounded-full px-4 py-1.5 text-[11px] font-medium text-white shadow-island transition-transform hover:scale-[1.02] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                style={{
                  background: 'linear-gradient(135deg, #1e3a8a 0%, #0b1220 55%, #0b0b0d 100%)',
                }}
              >
                <span className="flex h-4 w-4 items-center justify-center rounded-full bg-white/15 text-[9px]">
                  {items.length > 0 ? avatarInitial(items[0].title) : '密'}
                </span>
                <span>密岛</span>
                <span className="text-white/50">·</span>
                <span className={unlocked ? 'text-emerald-300' : 'text-amber-300'}>
                  {unlocked ? '已解锁' : '已锁定'}
                </span>
              </button>
            </motion.div>
          ) : null}

          {expanded ? (
            // 面板保持 `fixed`（页面级浮层）；`fixed` 本身即绝对定位菜单的包含块，
            // 不需要再叠 `relative`——两个 position 工具类会互相覆盖。
            <motion.div
              {...surfaceMotion}
              ref={panelRef}
              role="dialog"
              aria-label="密岛灵动岛"
              data-testid="island-panel"
              onKeyDown={handleKeyDown}
              onBlur={handleSurfaceBlur}
              onPointerEnter={handlePanelPointerEnter}
              onPointerLeave={handlePanelPointerLeave}
              onWheel={handleWheel}
              onContextMenu={(event) => {
                // 右键菜单（PRD FR-02）：拦住浏览器默认菜单，在岛内开自己的。
                event.preventDefault();
                setMenuOpen(true);
              }}
              className="fixed left-1/2 top-2 z-50 flex w-[640px] max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-col overflow-hidden rounded-[30px] border border-white/10 text-white shadow-island"
              style={{
                height: '306px',
                background:
                  'radial-gradient(120% 80% at 50% -10%, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0) 60%), linear-gradient(160deg, #16203a 0%, #0b1220 45%, #0b0b0d 100%)',
                boxShadow:
                  'inset 0 1px 0 rgba(255,255,255,0.22), inset 0 -18px 32px -18px rgba(0,0,0,0.9), 0 18px 48px -12px rgba(0,0,0,0.55)',
              }}
            >
          {/* 顶部内高光 */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-10 top-0 h-px bg-white/35"
          />

          <header className="flex items-center gap-3 px-5 pb-2 pt-4">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white/10 text-[10px] font-semibold">
              {unlocked ? '密' : '锁'}
            </span>
            <div className="relative flex-1">
              <Search
                aria-hidden="true"
                size={13}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-white/40"
              />
              <input
                ref={inputRef}
                data-testid="island-input"
                role="combobox"
                aria-label="密岛搜索"
                aria-expanded={listVisible}
                aria-controls={listVisible ? 'island-listbox' : undefined}
                aria-autocomplete="list"
                aria-activedescendant={
                  listVisible && visible[activeIndex] !== undefined
                    ? `island-option-${visible[activeIndex].id}`
                    : undefined
                }
                placeholder={unlocked ? '搜索资产…' : '已锁定，请先解锁'}
                disabled={!unlocked}
                value={island.query}
                onChange={(event) => setQuery(event.target.value)}
                className="h-8 w-full rounded-full border border-white/10 bg-white/10 pl-8 pr-3 text-xs text-white placeholder:text-white/40 focus:border-white/25 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
              />
            </div>
            <button
              type="button"
              aria-label="生成密码"
              title="生成强密码并复制到剪贴板"
              data-testid="island-generate-password"
              disabled={!unlocked}
              onClick={() => void handleGeneratePassword()}
              className="flex items-center rounded-full bg-white/10 px-2 py-1 text-white/80 transition-colors hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 disabled:cursor-not-allowed disabled:text-white/30 disabled:hover:bg-white/10"
            >
              <KeyRound aria-hidden="true" size={12} />
            </button>
            <button
              type="button"
              onClick={openCreate}
              className="flex items-center gap-1 rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-medium text-white/80 transition-colors hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
            >
              <Plus aria-hidden="true" size={11} />
              新建
            </button>
            <button
              type="button"
              onClick={onLock}
              className="flex items-center gap-1 rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-medium text-white/80 transition-colors hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
            >
              <Lock aria-hidden="true" size={11} />
              立即锁定
            </button>
            {/* 键盘可达的菜单入口：右键菜单不能只有鼠标一条路（PRD FR-02）。 */}
            <IslandMenuTrigger onClick={() => setMenuOpen((prev) => !prev)} />
          </header>

          <IslandContextMenu
            open={menuOpen}
            unlocked={unlocked}
            onClose={() => setMenuOpen(false)}
            onOpenMainPanel={handleOpenMainPanel}
            onCreate={openCreate}
            onOpenSettings={onOpenSettings}
            onLock={onLock}
            nativeAvailable={nativeAvailable}
            autostartEnabled={autostartEnabled}
            onToggleAutostart={handleToggleAutostart}
            // Web 预览没有进程可退：不传即保持禁用，而不是给个点了没反应的按钮。
            onQuit={nativeAvailable ? () => void quitViaShell() : undefined}
          />

          {/**
           * 滚轮「滑动线」选择器（用户需求：鼠标移到岛上滚中键翻卡片）。
           *
           * 与搜索列表共用同一份 `activeIndex`，所以 Enter / ⇧Enter 的复制语义
           * 在这里天然一致——不存在"滑动线指着 A、Enter 复制了 B"的分裂。
           */}
          <IslandScrollPicker
            open={pickerOpen && unlocked && !createOpen}
            items={visible}
            activeIndex={activeIndex}
            onActiveChange={setActiveIndex}
            onCopy={(item, field) => {
              void copyItemField(item.id, field);
            }}
            onClose={() => setPickerOpen(false)}
          />

          {/**
           * 跳转二选一菜单（PRD FR-07.1）。复用卡片的同一份组件：两处菜单项、
           * 定位方式、Esc 行为都必须一致，否则同一个功能在两个地方手感不同。
           */}
          <ItemJumpMenu
            open={jumpMenuId !== null}
            anchorRef={jumpAnchorRef}
            onClose={closeJumpMenu}
            onOpenUrl={() => {
              const id = jumpMenuId;
              closeJumpMenu();
              if (id !== null) {
                openItemUrl(id);
              }
            }}
            onLaunchApp={() => {
              closeJumpMenu();
              toast('桌面版将启动本地应用（Web 阶段不执行本地路径）');
            }}
          />

          <div
            data-island-scroller
            className="min-h-0 flex-1 overflow-y-auto px-3 pb-2"
          >
            {createOpen && unlocked ? (
              <form
                className="flex h-full flex-col gap-2 py-1"
                onSubmit={(event) => {
                  event.preventDefault();
                  void handleCreate();
                }}
              >
                {/**
                 * 星号必须是 label 的**兄弟节点**，不能塞进 `<label>` 里：
                 * 塞进去会改变 accessible name，`getByLabelText('标题')` 立刻失效，
                 * 读屏用户也会听到「标题 星号」。`aria-hidden` 让星号不进无障碍树，
                 * 语义由 input 上的 `aria-required` 承担。
                 */}
                <div className="flex items-center gap-1">
                  <label className="text-[11px] text-white/60" htmlFor="island-create-title">
                    标题
                  </label>
                  <span aria-hidden="true" className="text-[11px] text-rose-300/70">
                    *
                  </span>
                </div>
                <input
                  id="island-create-title"
                  aria-required="true"
                  value={createTitle}
                  onChange={(event) => setCreateTitle(event.target.value)}
                  placeholder="例如 GitHub"
                  className="h-8 w-full rounded-full border border-white/10 bg-white/10 px-3 text-xs text-white placeholder:text-white/40 focus:border-white/25 focus:outline-none"
                />
                <div className="flex items-center gap-1">
                  <label className="text-[11px] text-white/60" htmlFor="island-create-username">
                    账号
                  </label>
                  <span aria-hidden="true" className="text-[11px] text-rose-300/70">
                    *
                  </span>
                </div>
                <input
                  id="island-create-username"
                  aria-required="true"
                  value={createUsername}
                  onChange={(event) => setCreateUsername(event.target.value)}
                  placeholder="user@example.com"
                  className="h-8 w-full rounded-full border border-white/10 bg-white/10 px-3 text-xs text-white placeholder:text-white/40 focus:border-white/25 focus:outline-none"
                />
                <label className="text-[11px] text-white/60" htmlFor="island-create-password">
                  密码
                </label>
                <div className="flex items-center gap-1.5">
                  {/**
                   * 密码可自定义（用户需求）：不再只读。默认仍预生成一个强密码，
                   * 用户可直接改；「重新生成」随时换一个新的。
                   * `autoComplete=new-password` 避免浏览器把登录密码自动填进来，
                   * `spellCheck=false` 免得密码被标红波浪线。
                   */}
                  <input
                    id="island-create-password"
                    value={createPassword}
                    onChange={(event) => setCreatePassword(event.target.value)}
                    placeholder="可自定义，或点「重新生成」"
                    autoComplete="new-password"
                    spellCheck={false}
                    className="h-8 min-w-0 flex-1 rounded-full border border-white/10 bg-white/10 px-3 font-mono text-xs text-white placeholder:text-white/40 focus:border-white/25 focus:outline-none"
                  />
                  <button
                    type="button"
                    aria-label="重新生成密码"
                    onClick={() => setCreatePassword(client.generatePassword())}
                    className="flex h-8 items-center gap-1 rounded-full bg-white/10 px-2.5 text-[11px] text-white/80 transition-colors hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
                  >
                    <RefreshCw aria-hidden="true" size={11} />
                    重新生成
                  </button>
                </div>
                <div className="mt-auto flex items-center justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setCreateOpen(false)}
                    className="rounded-full px-3 py-1 text-[11px] text-white/60 transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    disabled={creating}
                    className="rounded-full bg-white px-3 py-1 text-[11px] font-semibold text-zinc-900 transition-opacity hover:opacity-90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
                  >
                    {creating ? '创建中…' : '创建并复制密码'}
                  </button>
                </div>
              </form>
            ) : !unlocked ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
                <p className="text-xs text-white/60">保险库已锁定，无法读取资产</p>
                <button
                  type="button"
                  onClick={onRequestUnlock}
                  className="rounded-full bg-white px-3 py-1 text-[11px] font-semibold text-zinc-900"
                >
                  去解锁
                </button>
              </div>
            ) : visible.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
                <p className="text-xs text-white/70">
                  {needle.length === 0 ? '还没有卡片' : '没有匹配的资产'}
                </p>
                <p className="text-[11px] text-white/35">
                  {needle.length === 0
                    ? '点右上角「新建」创建第一张卡，主面板建的卡也会立即出现在这里'
                    : '换个关键词试试，或点右上角「新建」建这张卡'}
                </p>
              </div>
            ) : (
              <ul id="island-listbox" role="listbox" aria-label="最近使用" className="flex flex-col gap-0.5">
                {visible.map((item, index) => (
                  <li
                    key={item.id}
                    id={`island-option-${item.id}`}
                    role="option"
                    aria-selected={index === activeIndex}
                    /**
                     * 阻止 mousedown 的默认行为 = 不让焦点被抢走。
                     *
                     * `<li role="option">` 不可聚焦，按 HTML 的 focusing steps，
                     * mousedown 会把焦点移到最近的可聚焦祖先、没有就落到 `body`。
                     * 焦点一落到 body，面板上的 ↑↓/Enter/Esc 全部失效——用户点一下卡，
                     * 之后想按 Enter 复制账号、按 Esc 收起都没反应，只能重新点回搜索框。
                     *
                     * `preventDefault()` 只掐掉"焦点转移"这一步，**不影响 click**：
                     * 复制逻辑照常跑。这是 APG combobox 的标准做法（焦点恒在输入框，
                     * 靠 `aria-activedescendant` 播报高亮）。
                     *
                     * 刻意用 `mousedown` 而不是 `pointerdown`：后者在触摸/笔场景会连带
                     * 影响滚动与长按，语义太宽；也刻意**不给 `<li>` 加 `tabIndex`**，
                     * 否则焦点会真的跑进列表，与面板层的 ↑↓ 处理打架。
                     */
                    onMouseDown={(event) => {
                      event.preventDefault();
                    }}
                    onContextMenu={(event) => {
                      // 右键卡片 = 跳转（PRD FR-07.1）。`stopPropagation` 不能省：
                      // 面板容器上挂着岛级右键菜单，不拦的话两扇门会一起开。
                      event.preventDefault();
                      event.stopPropagation();
                      handleJump(item, event.currentTarget);
                    }}
                    onClick={() => {
                      handleItemClick(index, item.id);
                    }}
                    className={`flex cursor-pointer items-center gap-2.5 rounded-2xl px-3 py-2 text-xs transition-colors active:scale-[0.99] ${
                      index === activeIndex ? 'bg-white/15' : 'hover:bg-white/10'
                    }`}
                  >
                    <span
                      aria-hidden="true"
                      className="flex h-6 w-6 items-center justify-center rounded-lg text-[10px] font-semibold"
                      style={{
                        backgroundColor: avatarColor(item.title),
                        color: avatarTextColor(item.title),
                      }}
                    >
                      {avatarInitial(item.title)}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-medium text-white/90">
                      {item.title}
                    </span>
                    {/**
                     * 账号单独可点：整行点击是「复制密码」，账号必须有独立的复制入口，
                     * 否则用户只能去主面板拿账号（线上反馈的 bug）。
                     * `stopPropagation` 是必须的——不然点账号会连带触发整行的复制密码。
                     */}
                    <button
                      type="button"
                      title={item.username ? '点击复制账号' : undefined}
                      aria-label={item.username ? `复制 ${item.title} 的账号` : undefined}
                      disabled={!item.username}
                      onMouseDown={(event) => {
                        // 与整行一致：保住搜索框焦点，否则之后的 ↑↓/Enter 会失效。
                        event.preventDefault();
                      }}
                      onClick={(event) => {
                        event.stopPropagation();
                        void copyItemField(item.id, 'username');
                      }}
                      className="max-w-[160px] truncate rounded px-1 text-white/45 transition-colors hover:bg-white/10 hover:text-white/80 focus-visible:bg-white/10 focus-visible:text-white/80 focus-visible:outline-none disabled:cursor-default disabled:hover:bg-transparent"
                    >
                      {item.username ?? '—'}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <footer className="flex items-center justify-between border-t border-white/10 px-5 py-2 text-[10px] text-white/40">
            <span className="flex items-center gap-1.5">
              <Command aria-hidden="true" size={11} />
              ↑↓ 选择 · Enter 复制密码 · ⇧Enter 复制账号 · Ctrl+Enter 打开链接 · Esc 收起
            </span>
            <span>{visible.length} 项</span>
          </footer>
            </motion.div>
          ) : null}
        </>
      ) : null}
    </>
  );
}
