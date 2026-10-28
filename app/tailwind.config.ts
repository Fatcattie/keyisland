import type { Config } from 'tailwindcss';

/**
 * 设计令牌与 SDD §6.3 / §6.4 对齐：
 * 白底卡片、1px zinc-200 边框、圆润立体灵动岛、柔和阴影。
 */
const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        island: {
          shell: '#0b0b0d',
          inner: '#141417',
          border: '#26262b',
        },
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
