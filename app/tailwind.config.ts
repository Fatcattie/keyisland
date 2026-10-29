import type { Config } from 'tailwindcss';

/**
 * 设计令牌与 SDD §6.3 / §6.4 对齐：
 * 白底卡片、1px zinc-200 边框、圆润立体灵动岛、柔和阴影。
 *
 * ## 主题（2026-10-29 新增白天 / 黑夜）
 *
 * `surface` / `line` / `fg` / `accent` 这组**语义色**由 CSS 变量驱动
 * （见 `src/index.css` 的 `:root` 与 `.dark`），亮色取值与原来的 zinc 刻度
 * 逐位相等 —— 所以没切到深色时像素级不变。
 *
 * 组件只允许用语义色，不要在业务代码里再写 `bg-white` / `text-zinc-900`：
 * 那样每加一个主题就要回头翻一遍全仓，且一定会漏。
 *
 * 灵动岛例外：它是"贴在桌面上的浮层"，两种主题下都保持深色（见 `island` 色组
 * 与 `styles/island-window.css`），所以岛内部件继续用硬编码的 white/black。
 */
const semantic = (name: string): string => `rgb(var(--ki-${name}) / <alpha-value>)`;

const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        island: {
          shell: '#0b0b0d',
          inner: '#141417',
          border: '#26262b',
        },
        // ---- 语义色（随主题翻转）----
        /** 页面底（比卡片更"凹"的一层）。 */
        page: semantic('page'),
        surface: semantic('surface'),
        'surface-muted': semantic('surface-muted'),
        'surface-sunken': semantic('surface-sunken'),
        line: semantic('line'),
        'line-subtle': semantic('line-subtle'),
        'line-strong': semantic('line-strong'),
        fg: semantic('fg'),
        'fg-muted': semantic('fg-muted'),
        'fg-subtle': semantic('fg-subtle'),
        'fg-faint': semantic('fg-faint'),
        accent: semantic('accent'),
        'accent-fg': semantic('accent-fg'),
        // 整行按钮的 hover 底色：亮色=白（与改造前一致），深色=比侧栏亮一档的灰。
        hover: semantic('hover'),
      },
      borderRadius: {
        card: '0.75rem',
        island: '1.875rem',
        pill: '1rem',
      },
      boxShadow: {
        card: '0 1px 2px rgba(24, 24, 27, 0.06), 0 8px 24px -12px rgba(24, 24, 27, 0.18)',
        island: '0 18px 48px -12px rgba(0, 0, 0, 0.55)',
      },
      fontFamily: {
        sans: ['"Microsoft YaHei UI"', 'Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};

export default config;
