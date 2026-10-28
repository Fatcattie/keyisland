/**
 * 拼音检索（SDD P1：拼音搜索）。
 *
 * 目标：让用户在搜索框里既能用**拼音全拼**（`zhongwen`）也能用**拼音首字母**
 * （`zw`）搜到中文标题，而不是必须先记住完整汉字。
 *
 * 设计取舍（见 `docs/adr/ADR-013-pinyin-search.md`）：
 * - 数据是《通用规范汉字表》8105 字的最常用读音，无声调；多音字只取最常用读音，
 *   因此"行(háng)"这类字按最常用读音命中，属已知取舍；
 * - 只服务检索，不改变任何存储结构：`title` 等字段仍按原样加密落盘；
 * - 命中判定是"候选串包含查询串"，因此首字母检索天然是子串语义
 *   （`文` 能命中，`中` 单独也能命中），不引入分词器。
 *
 * 性能：`READING_BY_CHAR` 在模块加载时构建一次（约 7900 次插入），
 * 之后每次检索对每个字符只做一次 Map 查找；`searchItems` 仍是单次 O(n) 遍历。
 */

import { PINYIN_PACKED } from './pinyin-data';

/** 段内断开符：候选串之间用 `\u0000` 断开，查询串不可能包含它。 */
const SEGMENT_GAP = '\u0000';

/** ascii 小写字母（拼音读音只由它构成）。 */
function isAsciiLower(char: string): boolean {
  return char >= 'a' && char <= 'z';
}

/** ascii 字母或数字：保留在候选串里，让中英混排也能连续匹配。 */
function isAsciiAlnum(char: string): boolean {
  return (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9');
}

/** 汉字 → 无声调读音。模块加载时构建一次。 */
const READING_BY_CHAR: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  let index = 0;
  while (index < PINYIN_PACKED.length) {
    // 汉字本身一定不是 ascii 小写字母，紧跟其后的读音一定是。
    const char = PINYIN_PACKED[index];
    let cursor = index + 1;
    while (cursor < PINYIN_PACKED.length && isAsciiLower(PINYIN_PACKED[cursor])) {
      cursor += 1;
    }
    map.set(char, PINYIN_PACKED.slice(index + 1, cursor));
    index = cursor;
  }
  return map;
})();

/** 取单个字符的无声调读音；表外字符（生僻字、符号、emoji）返回 `null`。 */
export function pinyinReading(char: string): string | null {
  return READING_BY_CHAR.get(char) ?? null;
}

/** 拼音表收录的汉字数量（测试与文档用）。 */
export const PINYIN_TABLE_SIZE = READING_BY_CHAR.size;

/** 查询是否值得做拼音匹配：只有纯 ascii 小写字母/数字时才需要。 */
const ASCII_QUERY = /^[a-z0-9]+$/;

/** 查询串是否可以走拼音分支（供上层提前跳过无谓计算）。 */
export function isPinyinQuery(needle: string): boolean {
  return ASCII_QUERY.test(needle);
}

/**
 * 生成一段文本的拼音候选串。
 *
 * 规则：
 * - 文本按"中文字符 / ascii 字母数字"切成连续段，标点空格是段边界；
 * - 每个段产出**全拼串**与**首字母串**，段与段之间用 `\u0000` 断开，
 *   因此查询串不可能跨段误匹配（`GitHub 中文` 不会命中 `hubzhong`）；
 * - 段内出现表外非 ascii 字符（生僻字、emoji）时插入断开符，
 *   避免 `中X文` 被首字母 `zw` 命中。
 *
 * @returns `[全拼串, 首字母串]`，任一为 `undefined` 表示该文本没有可用候选。
 */
export function pinyinCandidates(text: string): { full: string; initials: string } {
  const lower = text.toLowerCase();
  let full = '';
  let initials = '';
  let gapPending = false;

  const flushGap = (): void => {
    if (full.length > 0 || initials.length > 0) {
      full += SEGMENT_GAP;
      initials += SEGMENT_GAP;
      gapPending = false;
    }
  };

  for (const char of lower) {
    const reading = READING_BY_CHAR.get(char);
    if (reading !== undefined) {
      if (gapPending) {
        flushGap();
      }
      full += reading;
      initials += reading[0];
      continue;
    }
    if (isAsciiAlnum(char)) {
      if (gapPending) {
        flushGap();
      }
      full += char;
      initials += char;
      continue;
    }
    // 段边界或表外字符：标记插入断开符。
    gapPending = true;
  }

  return { full, initials };
}

/** 单个字符是否是拼音表收录的汉字。 */
export function isMappedChineseChar(char: string): boolean {
  return READING_BY_CHAR.has(char);
}
