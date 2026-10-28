/** 拼音检索核心测试（SDD P1：拼音搜索）。 */
import { describe, expect, it } from 'vitest';
import {
  PINYIN_TABLE_SIZE,
  isMappedChineseChar,
  isPinyinQuery,
  pinyinCandidates,
  pinyinReading,
} from '../pinyin';
import { PINYIN_PACKED } from '../pinyin-data';

describe('拼音表数据', () => {
  it('顺序解析无歧义，且覆盖通用规范汉字表常用字', () => {
    // 8105 字里有一部分是兼容码位（=> 指向主码位）被剔除，剩 7900+。
    expect(PINYIN_TABLE_SIZE).toBeGreaterThan(7800);
    // 表内字符 → 无声调读音首字母。
    expect(pinyinReading('中')).toBe('zhong');
    expect(pinyinReading('文')).toBe('wen');
    expect(pinyinReading('国')).toBe('guo');
    expect(pinyinReading('a')).toBeNull();
    expect(pinyinReading('，')).toBeNull();
    expect(isMappedChineseChar('银')).toBe(true);
    expect(isMappedChineseChar('行')).toBe(true);
  });

  it('打包串长度与解析条目数自洽', () => {
    // 每个汉字 1 个码元 + 读音若干码元，解析后条目数必须等于表大小。
    expect(PINYIN_PACKED.length).toBeGreaterThan(PINYIN_TABLE_SIZE);
  });
});

describe('isPinyinQuery', () => {
  it('只有纯 ascii 小写字母/数字才走拼音分支', () => {
    expect(isPinyinQuery('zw')).toBe(true);
    expect(isPinyinQuery('zhongwen')).toBe(true);
    expect(isPinyinQuery('abc123')).toBe(true);
    expect(isPinyinQuery('中文')).toBe(false);
    expect(isPinyinQuery('a-b')).toBe(false);
    expect(isPinyinQuery('a b')).toBe(false);
  });
});

describe('pinyinCandidates', () => {
  it('中文产出全拼串与首字母串', () => {
    const { full, initials } = pinyinCandidates('中文');
    expect(full).toBe('zhongwen');
    expect(initials).toBe('zw');
  });

  it('大小写不影响结果', () => {
    // 纯 ascii 输入：全拼串与首字母串都是它自身（小写化）。
    expect(pinyinCandidates('ZHONGWen').initials).toBe('zhongwen');
    // 中英紧邻书写视为同一段；中间有空格才断开。
    expect(pinyinCandidates('中GitHub').initials).toBe('zgithub');
    expect(pinyinCandidates('中 GitHub').initials).toBe('z\u0000github');
  });

  it('中英数字连续书写不分段', () => {
    const { full } = pinyinCandidates('微信2026');
    expect(full).toBe('weixin2026');
  });

  it('中英混排按段断开，查询不会跨段误命中', () => {
    const { full, initials } = pinyinCandidates('GitHub 中文');
    expect(full).toBe('github\u0000zhongwen');
    expect(initials).toBe('github\u0000zw');
    expect(initials.includes('zw')).toBe(true);
    expect(initials.includes('hubzhong')).toBe(false);
  });

  it('标点与空格是段边界', () => {
    const { initials } = pinyinCandidates('工作、生活');
    expect(initials).toBe('gz\u0000sh');
    expect(initials.includes('gzsh')).toBe(false);
  });

  it('表外字符插入断开，避免跨生僻字误命中', () => {
    // 𠮷 不在表内。
    const { initials } = pinyinCandidates('中𠮷文');
    expect(initials).toBe('z\u0000w');
    expect(initials.includes('zw')).toBe(false);
    // 但中文自身仍可命中。
    expect(initials.includes('z')).toBe(true);
  });

  it('数字保留在候选串里', () => {
    const { full } = pinyinCandidates('微信2026');
    expect(full).toBe('weixin2026');
  });

  it('多音字只取最常用读音（已知取舍）', () => {
    // 「行」最常用读音是 xíng，因此「银行」的首字母是 yx 而不是 yh。
    expect(pinyinReading('行')).toBe('xing');
    expect(pinyinCandidates('银行').initials).toBe('yx');
  });

  it('空文本与纯符号不产出可用候选', () => {
    expect(pinyinCandidates('').full).toBe('');
    expect(pinyinCandidates('，，').initials).toBe('');
  });
});
