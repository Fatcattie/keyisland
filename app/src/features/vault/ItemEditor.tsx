/**
 * 资产编辑器。
 *
 * 三条硬约束：
 * 1. 必填校验就地提示（按 messageKey 翻译），不依赖 Toast；
 * 2. 可见性默认沿用原值 —— 编辑 `username_only` / `hidden` 时不会因为保存而自动放开；
 * 3. 生成的密码只写进本地表单状态，保存后才进加密存储。
 */

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { ClipboardPaste, Eye, EyeOff, Wand2 } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Field, INPUT_CLASS, TEXTAREA_CLASS } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Modal';
import { useVaultClient } from '../../app/VaultProvider';
import { useToast } from '../../components/ui/Toast';
import { describeError } from '../../lib/i18n';
import { isGenerateOptionsValid } from '../../core/vault/generator';
import type { GeneratePasswordOptions } from '../../core/vault/generator';
import type { ItemDetail, Visibility } from '../../core/vault/types';

export interface ItemEditorProps {
  open: boolean;
  /** `null` 表示新建。 */
  item: ItemDetail | null;
  onClose: () => void;
  onSaved: () => void;
}

/** 表单状态。 */
interface FormState {
  title: string;
  platform: string;
  url: string;
  appPath: string;
  username: string;
  password: string;
  category: string;
  tags: string;
  notes: string;
  visibility: Visibility;
}

/** 空表单。 */
const EMPTY_FORM: FormState = {
  title: '',
  platform: '',
  url: '',
  appPath: '',
  username: '',
  password: '',
  category: '',
  tags: '',
  notes: '',
  visibility: 'normal',
};

/** 可见性选项。 */
const VISIBILITY_OPTIONS: ReadonlyArray<{ value: Visibility; label: string; hint: string }> = [
  { value: 'normal', label: '普通', hint: '账号与密码都可查看、复制' },
  { value: 'username_only', label: '仅账号', hint: '列表显示账号，密码只能复制、不可预览' },
  { value: 'hidden', label: '隐藏', hint: '不进列表与搜索，需二次验证后才能访问' },
  { value: 'masked', label: '遮罩', hint: '留在列表，但账号与密码遮罩，验证主密码后才显示' },
];

/** 生成长度档位。 */
const LENGTH_PRESETS: readonly number[] = [16, 20, 24];

/** 由详情构造表单。 */
function toFormState(item: ItemDetail | null): FormState {
  if (item === null) {
    return { ...EMPTY_FORM };
  }
  return {
    title: item.title,
    platform: item.platform ?? '',
    url: item.url ?? '',
    appPath: item.appPath ?? '',
    username: item.username ?? '',
    // 详情接口不返回密码明文，编辑时留空表示"不修改"。
    password: '',
    category: item.category,
    tags: item.tags.join(', '),
    notes: item.notes ?? '',
    visibility: item.visibility,
  };
}

/** 解析逗号 / 顿号分隔的标签。 */
function parseTags(value: string): string[] {
  return value
    .split(/[,，、]/u)
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

/** 编辑器。 */
export function ItemEditor({ open, item, onClose, onSaved }: ItemEditorProps): JSX.Element {
  const client = useVaultClient();
  const toast = useToast();
  const isEdit = item !== null;

  const [form, setForm] = useState<FormState>(() => toFormState(item));
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /** 密码框是否临时显形。默认遮蔽——编辑器里不该默认把明文摊在屏幕上。 */
  const [passwordVisible, setPasswordVisible] = useState(false);

  const [length, setLength] = useState<number>(20);
  const [useLower, setUseLower] = useState(true);
  const [useUpper, setUseUpper] = useState(true);
  const [useDigits, setUseDigits] = useState(true);
  const [useSymbols, setUseSymbols] = useState(true);

  // 每次打开（或切换编辑对象）都重置表单，避免上一张卡片的残留值。
  useEffect(() => {
    if (!open) {
      return;
    }
    setForm(toFormState(item));
    setErrors({});
    setFormError(null);
    setPasswordVisible(false);
  }, [open, item]);

  const generatorOptions = useMemo<GeneratePasswordOptions>(
    () => ({
      length,
      lowercase: useLower,
      uppercase: useUpper,
      digits: useDigits,
      symbols: useSymbols,
    }),
    [length, useLower, useUpper, useDigits, useSymbols],
  );
  const canGenerate = isGenerateOptionsValid(generatorOptions);

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]): void => {
    setForm((previous) => ({ ...previous, [key]: value }));
    setErrors((previous) => {
      if (previous[key] === undefined) {
        return previous;
      }
      const next = { ...previous };
      delete next[key];
      return next;
    });
  };

  const validate = (): boolean => {
    const next: Partial<Record<keyof FormState, string>> = {};
    if (form.title.trim().length === 0) {
      next.title = '请填写标题';
    }
    if (form.username.trim().length === 0) {
      next.username = '请填写账号';
    }
    if (!isEdit && form.password.length === 0) {
      next.password = '请填写密码';
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setFormError(null);
    if (!validate()) {
      return;
    }
    setSubmitting(true);
    const payload = {
      title: form.title.trim(),
      platform: form.platform.trim().length === 0 ? null : form.platform.trim(),
      url: form.url.trim().length === 0 ? null : form.url.trim(),
      appPath: form.appPath.trim().length === 0 ? null : form.appPath.trim(),
      username: form.username.trim(),
      category: form.category.trim().length === 0 ? null : form.category.trim(),
      tags: parseTags(form.tags),
      notes: form.notes.trim().length === 0 ? null : form.notes.trim(),
      visibility: form.visibility,
    };
    try {
      if (isEdit) {
        await client.updateItem(item.id, {
          ...payload,
          ...(form.password.length > 0 ? { password: form.password } : {}),
        });
      } else {
        await client.createItem({ ...payload, password: form.password });
      }
      onSaved();
      onClose();
    } catch (caught) {
      setFormError(describeError(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const handleGenerate = (): void => {
    try {
      const generated = client.generatePassword(generatorOptions);
      setField('password', generated);
      toast('已生成强密码');
    } catch (caught) {
      setFormError(describeError(caught));
    }
  };

  /**
   * 从系统剪贴板粘贴到指定字段（PRD `prd.md:157`）。
   *
   * 隐私约束：
   * - 粘贴到密码框后**不自动显形**——粘贴来的密码往往是别人给的，直接亮在屏幕上
   *   是最容易被人瞄到的一瞬间；要不要看由用户自己点眼睛决定。
   * - 粘贴内容**绝不**进 toast、日志或任何错误文案，只写进本地表单 state。
   */
  const handlePaste = async (key: 'username' | 'password'): Promise<void> => {
    const text = await client.readClipboardText();
    if (text === null) {
      toast('无法读取剪贴板，请允许浏览器的剪贴板读取权限');
      return;
    }
    if (text.trim().length === 0) {
      toast('剪贴板是空的');
      return;
    }
    setField(key, text.trim());
  };

  return (
    <Modal
      open={open}
      title={isEdit ? '编辑卡片' : '新建卡片'}
      description={isEdit ? '留空密码表示不修改原有密码' : '所有内容都会在本地加密后保存'}
      onClose={onClose}
      widthClass="max-w-2xl"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" form="item-editor-form" loading={submitting}>
            保存
          </Button>
        </>
      }
    >
      <form id="item-editor-form" onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-4" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="标题" htmlFor="editor-title" required error={errors.title ?? null}>
            <input
              id="editor-title"
              className={INPUT_CLASS}
              value={form.title}
              onChange={(event) => setField('title', event.target.value)}
            />
          </Field>
          <Field label="平台" htmlFor="editor-platform">
            <input
              id="editor-platform"
              className={INPUT_CLASS}
              value={form.platform}
              onChange={(event) => setField('platform', event.target.value)}
            />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="账号" htmlFor="editor-username" required error={errors.username ?? null}>
            <div className="flex items-center gap-2">
              <input
                id="editor-username"
                className={INPUT_CLASS}
                autoComplete="off"
                value={form.username}
                onChange={(event) => setField('username', event.target.value)}
              />
              <button
                type="button"
                aria-label="粘贴账号"
                onClick={() => void handlePaste('username')}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-pill border border-zinc-200 bg-white text-zinc-500 transition-colors hover:bg-zinc-50 hover:text-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900/20"
              >
                <ClipboardPaste aria-hidden="true" size={14} />
              </button>
            </div>
          </Field>
          <Field
            label="密码"
            htmlFor="editor-password"
            required={!isEdit}
            error={errors.password ?? null}
            hint={isEdit ? '留空表示不修改' : undefined}
          >
            <div className="flex items-center gap-2">
              <input
                id="editor-password"
                type={passwordVisible ? 'text' : 'password'}
                className={`${INPUT_CLASS} font-mono`}
                autoComplete="off"
                value={form.password}
                onChange={(event) => setField('password', event.target.value)}
              />
              <button
                type="button"
                aria-label="粘贴密码"
                onClick={() => void handlePaste('password')}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-pill border border-zinc-200 bg-white text-zinc-500 transition-colors hover:bg-zinc-50 hover:text-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900/20"
              >
                <ClipboardPaste aria-hidden="true" size={14} />
              </button>
              <button
                type="button"
                aria-label={passwordVisible ? '隐藏密码' : '显示密码'}
                aria-pressed={passwordVisible}
                onClick={() => setPasswordVisible((previous) => !previous)}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-pill border border-zinc-200 bg-white text-zinc-500 transition-colors hover:bg-zinc-50 hover:text-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900/20"
              >
                {passwordVisible ? (
                  <EyeOff aria-hidden="true" size={14} />
                ) : (
                  <Eye aria-hidden="true" size={14} />
                )}
              </button>
            </div>
          </Field>
        </div>

        <section
          aria-label="密码生成器"
          className="flex flex-col gap-2 rounded-card border border-zinc-200 bg-zinc-50 p-3"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-medium text-zinc-600">生成强密码</span>
            {LENGTH_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                aria-pressed={length === preset}
                onClick={() => setLength(preset)}
                className={`rounded-pill px-2.5 py-1 text-[11px] font-medium transition-colors ${
                  length === preset
                    ? 'bg-zinc-900 text-white'
                    : 'bg-white text-zinc-600 ring-1 ring-inset ring-zinc-200'
                }`}
              >
                {preset} 位
              </button>
            ))}
            <div className="flex-1" />
            <Button size="sm" variant="secondary" onClick={handleGenerate} disabled={!canGenerate}>
              <Wand2 aria-hidden="true" size={13} />
              生成
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-[11px] text-zinc-600">
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={useLower} onChange={(event) => setUseLower(event.target.checked)} />
              小写
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={useUpper} onChange={(event) => setUseUpper(event.target.checked)} />
              大写
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={useDigits} onChange={(event) => setUseDigits(event.target.checked)} />
              数字
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={useSymbols} onChange={(event) => setUseSymbols(event.target.checked)} />
              符号
            </label>
          </div>
        </section>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="网址" htmlFor="editor-url">
            <input
              id="editor-url"
              className={INPUT_CLASS}
              placeholder="https://"
              value={form.url}
              onChange={(event) => setField('url', event.target.value)}
            />
          </Field>
          <Field label="本地应用目标" htmlFor="editor-app-path" hint="桌面版可一键启动，Web 阶段仅保存">
            <input
              id="editor-app-path"
              className={INPUT_CLASS}
              value={form.appPath}
              onChange={(event) => setField('appPath', event.target.value)}
            />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="分类" htmlFor="editor-category" hint="留空归入「其他」">
            <input
              id="editor-category"
              className={INPUT_CLASS}
              value={form.category}
              onChange={(event) => setField('category', event.target.value)}
            />
          </Field>
          <Field label="标签" htmlFor="editor-tags" hint="用逗号分隔，例如：工作, 常用">
            <input
              id="editor-tags"
              className={INPUT_CLASS}
              value={form.tags}
              onChange={(event) => setField('tags', event.target.value)}
            />
          </Field>
        </div>

        <Field label="备注" htmlFor="editor-notes">
          <textarea
            id="editor-notes"
            className={TEXTAREA_CLASS}
            value={form.notes}
            onChange={(event) => setField('notes', event.target.value)}
          />
        </Field>

        <Field
          label="可见性"
          htmlFor="editor-visibility"
          hint={
            form.visibility === 'normal'
              ? '账号与密码都可查看、复制'
              : form.visibility === 'username_only'
                ? '当前为受限档位，保存不会自动放开为普通'
                : '当前为隐藏档位，保存不会自动放开为普通'
          }
        >
          <select
            id="editor-visibility"
            className={INPUT_CLASS}
            value={form.visibility}
            onChange={(event) => setField('visibility', event.target.value as Visibility)}
          >
            {VISIBILITY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label} —— {option.hint}
              </option>
            ))}
          </select>
        </Field>

        {formError !== null ? (
          <p role="alert" className="text-xs font-medium text-red-600">
            {formError}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
