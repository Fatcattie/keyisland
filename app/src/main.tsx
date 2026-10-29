import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
// 岛形态的窗口级样式（透明背景 / 面板铺满小窗 / 禁止滚动）。
// 只在 `<html data-app-mode="island">` 下生效，全形态零影响。
import './styles/island-window.css';
import { applyTheme, useThemeStore } from './stores/theme-store';

// 在首帧之前把主题写到 <html>：晚一步就会先闪一下白底再变深色。
applyTheme(useThemeStore.getState().mode);

const container = document.getElementById('root');
if (!container) {
  throw new Error('缺少 #root 挂载节点');
}

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
