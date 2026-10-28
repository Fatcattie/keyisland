import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
// 岛形态的窗口级样式（透明背景 / 面板铺满小窗 / 禁止滚动）。
// 只在 `<html data-app-mode="island">` 下生效，全形态零影响。
import './styles/island-window.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('缺少 #root 挂载节点');
}

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
