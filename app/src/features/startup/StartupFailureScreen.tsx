/**
 * 启动失败屏。
 *
 * 为什么需要这一屏：发布版没有控制台，`setup` 里一旦返回 Err，进程会 panic 成
 * 「双击图标一闪而过」——用户完全不知道发生了什么。Rust 侧现在改成"失败也开窗口"，
 * 把原因挂到 `AppState` 上，这里负责把原因讲成人话。
 *
 * 文案原则（和 `missing_key_policy` 保持一致，别改成"存储失败"）：
 * 1. 先说**数据还在不在**——这是用户唯一真正关心的事；
 * 2. 再说**为什么这次不启动**——尤其"不会新建密钥"要让用户看懂是保护而非故障；
 * 3. 最后给**可执行的三步**，不能只有"重试"。
 */

import { useState } from 'react';
import { Button } from '../../components/ui/Button';
import { useToast } from '../../components/ui/Toast';
import {
  revealStorageFolder,
  type StartupFailure,
  type StartupFailureCode,
} from '../../services/tauri-storage';

interface FailureCopy {
  title: string;
  lead: string;
  steps: readonly string[];
}

/** 每个分类对应的一组文案。新增分类时这里必须同步，否则 tsc 会报缺键。 */
const COPY: Readonly<Record<StartupFailureCode, FailureCopy>> = Object.freeze({
  missing_key: {
    title: '数据还在，但解开它的密钥不在了',
    lead: '数据库文件是完整的，里面仍然是加密后的内容。但 Windows 凭据管理器里保存的那把数据库密钥找不到了——换过 Windows 用户、重装过系统、或用清理工具删过凭据，都会造成这种情况。为了避免用新密钥覆盖旧数据，密岛这次选择不启动。',
    steps: [
      '换回创建保险库时那个 Windows 用户再启动一次（凭据是跟着用户走的）。',
      '如果是重装过系统：用之前的加密备份「覆盖导入」，备份里带着密钥槽。',
      '确认数据已无法找回时，把 vault.db 改名留档，再重新创建保险库。',
    ],
  },
  credential: {
    title: '无法访问 Windows 凭据管理器',
    lead: '数据库密钥存放在 Windows 凭据管理器里（底层是 DPAPI，绑定当前用户）。这次读不到它，所以没法打开保险库。数据本身没有受影响。',
    steps: [
      '确认是用创建保险库时的那个 Windows 用户登录的。',
      '打开「凭据管理器 → Windows 凭据」，看是否还有 KeyIsland 条目。',
      '如果系统刚更新过或凭据服务异常，重启一次再试。',
    ],
  },
  data_dir: {
    title: '无法创建数据目录',
    lead: '密岛需要在自己的数据目录里存放 vault.db，但这次没能创建出来。常见原因：磁盘空间不足、目录权限被策略限制、或安全软件拦截了写入。',
    steps: [
      '确认磁盘还有可用空间。',
      '如果是公司电脑，把密岛加入安全软件 / 组策略的白名单。',
      '点「打开数据文件夹」，确认该位置存在且可写。',
    ],
  },
  database: {
    title: '无法打开数据库文件',
    lead: 'vault.db 存在，但这次打不开。常见原因：另一个密岛进程还占着它、文件被同步盘锁住、或文件已经损坏。',
    steps: [
      '在任务管理器里确认没有第二个密岛在运行。',
      '如果数据目录在 OneDrive / 坚果云等同步盘里，先暂停同步。',
      '点「打开数据文件夹」，把 vault.db 复制一份留档后再排查。',
    ],
  },
  unknown: {
    title: '密岛无法启动',
    lead: '启动时遇到一个未归类的问题。下面是具体原因，通常能直接看出是哪一环出了问题。',
    steps: [
      '点「重试」；如果还是失败，先把 vault.db 复制一份留档。',
      '带着下面的具体原因反馈，能大幅缩短排查时间。',
    ],
  },
});

export interface StartupFailureScreenProps {
  failure: StartupFailure;
}

/** 启动失败时占据整屏，取代设置向导 / 解锁页。 */
export function StartupFailureScreen({ failure }: StartupFailureScreenProps): JSX.Element {
  const toast = useToast();
  const [revealing, setRevealing] = useState(false);
  const copy = COPY[failure.code];

  const handleReveal = (): void => {
    setRevealing(true);
    void revealStorageFolder()
      // Rust 侧给的就是给人看的中文原因（"创建数据目录失败：..."），
      // 比一句笼统的"打开失败"有用得多，所以优先透传。
      .catch((error: unknown) => {
        toast(
          typeof error === 'string' && error.length > 0
            ? error
            : '打开文件夹失败，请手动前往数据目录',
        );
      })
      .finally(() => {
        setRevealing(false);
      });
  };

  return (
    <div className="flex min-h-full items-center justify-center bg-zinc-100 px-4 py-10">
      <div className="w-full max-w-lg rounded-card border border-red-200 bg-white p-6 shadow-card">
        <p className="text-[11px] font-medium tracking-wide text-red-600">启动失败</p>
        <h1 role="alert" className="mt-1 text-base font-semibold text-zinc-900">
          {copy.title}
        </h1>
        <p className="mt-3 text-xs leading-relaxed text-zinc-600">{copy.lead}</p>

        <ul className="mt-3 space-y-1.5">
          {copy.steps.map((step) => (
            <li key={step} className="flex gap-2 text-xs leading-relaxed text-zinc-700">
              <span
                aria-hidden="true"
                className="mt-[6px] h-1 w-1 shrink-0 rounded-full bg-zinc-400"
              />
              <span>{step}</span>
            </li>
          ))}
        </ul>

        {failure.detail.length > 0 ? (
          <div className="mt-4">
            <p className="text-[11px] font-medium text-zinc-700">具体原因</p>
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-zinc-50 p-3 text-[11px] leading-relaxed text-zinc-600 ring-1 ring-zinc-200">
              {failure.detail}
            </pre>
          </div>
        ) : null}

        {failure.dbPath !== null ? (
          <p className="mt-3 text-[11px] text-zinc-500">
            数据文件：<code className="break-all">{failure.dbPath}</code>
          </p>
        ) : null}

        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" loading={revealing} onClick={handleReveal}>
            打开数据文件夹
          </Button>
          <Button size="sm" onClick={() => window.location.reload()}>
            重试
          </Button>
        </div>
      </div>
    </div>
  );
}
