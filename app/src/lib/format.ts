/**
 * 纯函数工具：时间格式化、头像色、外部跳转、减少动效检测。
 * 这里不依赖 React，便于单独测试与在任意层复用。
 */

/** 补零。 */
function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** 格式化为 `2024-05-01 12:30`。 */
export function formatDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / 日期。 */
export function formatRelative(timestamp: number, now: number): string {
  const diff = now - timestamp;
  if (!Number.isFinite(diff)) {
    return '—';
  }
  if (diff < 60_000) {
    return '刚刚';
  }
  if (diff < 3_600_000) {
    return `${Math.floor(diff / 60_000)} 分钟前`;
  }
  if (diff < 86_400_000) {
    return `${Math.floor(diff / 3_600_000)} 小时前`;
  }
  if (diff < 7 * 86_400_000) {
    return `${Math.floor(diff / 86_400_000)} 天前`;
  }
  return formatDateTime(timestamp);
}

/** 把剩余毫秒格式化成倒计时文本：`29 秒` / `1:05`。 */
export function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) {
    return `${seconds} 秒`;
  }
  return `${minutes}:${pad(seconds)}`;
}

/** 取标题首字母（中文取首字），用于卡片头像。 */
export function avatarInitial(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return '?';
  }
  return trimmed.slice(0, 1).toUpperCase();
}

/**
 * 由文本稳定派生一个色相（0–359）。
 * 同一标题永远得到同一颜色，且不需要持久化。
 */
export function avatarHue(text: string): number {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) % 360;
  }
  return hash;
}

/** 头像背景色（浅色系，保证白底卡片上的对比度）。 */
export function avatarColor(text: string): string {
  const hue = avatarHue(text);
  return `hsl(${hue} 62% 92%)`;
}

/** 头像前景色。 */
export function avatarTextColor(text: string): string {
  const hue = avatarHue(text);
  return `hsl(${hue} 45% 34%)`;
}

/**
 * 是否应禁用倾斜 / 展开动画。
 *
 * 注意：这是"关闭动效"而不是"加速动效"（SDD §6.3）——
 * 倾斜与光晕会直接不参与计算，避免眩晕用户仍看到 3D 抖动。
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * 打开外部链接。
 * 只接受 http/https，避免 `javascript:` 之类的伪协议被执行。
 */
export function openExternal(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }

  // 桌面壳：Tauri 会拦截 `window.open`（默认不允许创建新窗口），
  // 表现为"点了没反应、也不报错"，但调用方会以为成功并记一条跳转日志。
  // 所以这里改走系统默认浏览器。
  // 用动态 import 是为了让 `lib/` 不在顶层依赖 `services/`（分层方向：
  // services → lib，反向依赖会绕成环）；顺带浏览器版不执行这段分支。
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    void import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke('open_external', { url: parsed.toString() }))
      .catch(() => {
        // 打开失败不抛给调用方：与浏览器版被拦截弹窗时保持一致（尽力而为）。
      });
    return true;
  }

  if (typeof window === 'undefined' || typeof window.open !== 'function') {
    return false;
  }
  window.open(parsed.toString(), '_blank', 'noopener,noreferrer');
  return true;
}

/** 尽力写入系统剪贴板，返回是否成功（失败不抛，由调用方决定提示）。 */
export async function writeSystemClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      return false;
    }
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * 触发文件下载，返回是否真的发起了下载。
 *
 * **调用方必须检查返回值**：返回 false 时文件没有落盘，此时再提示"已导出"
 * 会让用户以为自己有备份——对密码库来说这是最危险的一类谎报。
 *
 * jsdom 默认没有 `URL.createObjectURL`，所以单测里要 stub 全局 `URL` 才能走成功分支
 * （见 `__tests__/format-download.test.ts`）；真实浏览器与 WebView2 里它存在。
 */
export function downloadTextFile(filename: string, content: string, mime = 'application/json'): boolean {
  if (typeof document === 'undefined' || typeof URL === 'undefined') {
    return false;
  }
  if (typeof URL.createObjectURL !== 'function') {
    return false;
  }
  const blob = new Blob([content], { type: mime });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  // 必须挂到文档里再点：脱离文档的 <a> 在部分引擎（含 WebView2）里 click()
  // 不会触发下载，也不报错——典型的"点了没反应"。
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === 'function') {
    // 推迟到下一个宏任务再撤销。紧跟 click() 同步撤销，有可能在下载真正开始
    // 之前就把 URL 废掉，结果是"没有文件、也没有错误"。
    // 回调里再包一层 try：定时器执行时测试环境可能已经拆掉桩了。
    setTimeout(() => {
      try {
        URL.revokeObjectURL(objectUrl);
      } catch {
        // 撤销失败不影响已发起的下载。
      }
    }, 0);
  }
  return true;
}
