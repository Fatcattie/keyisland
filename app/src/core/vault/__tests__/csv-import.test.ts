/** CSV 导入解析测试。 */
import { describe, expect, it } from 'vitest';
import { csvTemplateText, parseCsvRows, previewCsvImport, resolveCsvColumns } from '../csv-import';


describe('CSV 解析', () => {
  it('模板包含完整字段表头且不含示例密码', () => {
    expect(csvTemplateText()).toContain('名称,平台,账号,密码,网址,本地应用目标,分类,标签,备注');
    expect(csvTemplateText()).not.toContain('请替换为真实密码');
  });
  it('解析引号、转义引号、逗号、CRLF 与 BOM', () => {
    const text = '\uFEFFname,username,password,url,notes\r\nGitHub,dev@example.com,"p,a""ss""1",https://github.com,"line1\r\nline2"\r\n';
    const rows = parseCsvRows(text);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual(['GitHub', 'dev@example.com', 'p,a""ss""1'.replace(/""/g, '"'), 'https://github.com', 'line1\r\nline2']);
  });

  it('支持手工列映射修正自动识别结果', () => {
    const preview = previewCsvImport(
      'service,login,secret\nGitHub,octocat,Pass-1-Aa1!\n',
      { title: 'service', username: 'login', password: 'secret' },
    );
    expect(preview.items[0]).toMatchObject({ title: 'GitHub', username: 'octocat', password: 'Pass-1-Aa1!' });
  });

  it('手工映射可把可选字段设为不导入', () => {
    const preview = previewCsvImport(
      'service,login,secret,extra\nGitHub,octocat,Pass-1-Aa1!,ignore-me\n',
      { title: 'service', username: 'login', password: 'secret', notes: null },
    );
    expect(preview.items[0].notes).toBeUndefined();
    expect(preview.items[0].title).toBe('GitHub');
  });

  it('预览回传实际生效的映射，供界面回填', () => {
    const preview = previewCsvImport('service,login,secret\nGitHub,octocat,Pass-1-Aa1!\n', {
      title: 'service',
      username: 'login',
      password: 'secret',
    });
    expect(preview.mapping).toMatchObject({ title: 'service', username: 'login', password: 'secret' });
    expect(preview.mapping.url).toBeNull();
  });

  it('手工映射指向不存在的列时报错，而不是静默取空', () => {
    expect(() =>
      previewCsvImport('name,username,password\nGitHub,octocat,Pass-1-Aa1!\n', { title: 'name', username: 'nope', password: 'password' }),
    ).toThrow(/不存在的列/);
  });

  it('识别常见表头别名（英文与中文）', () => {
    const en = resolveCsvColumns(['name', 'username', 'password', 'url']);
    expect(en).toMatchObject({ title: 'name', username: 'username', password: 'password', url: 'url' });
    const zh = resolveCsvColumns(['名称', '账号', '密码', '网址', '备注']);
    expect(zh).toMatchObject({ title: '名称', username: '账号', password: '密码', url: '网址', notes: '备注' });
  });

  it('缺少必需列时报错，不猜测列', () => {
    expect(() => resolveCsvColumns(['name', 'username'])).toThrow();
  });

  it('预览：缺账号/密码/空行被跳过并给出原因，其它正常转换', () => {
    const text = [
      'name,username,password,url',
      'GitHub,dev@example.com,Pass-1-Aa1!,https://github.com',
      'NoPass,u@example.com,,',
      'NoUser,,Pass-2-Bb2!,',
      ',,,',
    ].join('\n');
    const preview = previewCsvImport(text);

    expect(preview.totalRows).toBe(4);
    expect(preview.items).toHaveLength(1);
    expect(preview.items[0]).toMatchObject({
      title: 'GitHub',
      username: 'dev@example.com',
      password: 'Pass-1-Aa1!',
      url: 'https://github.com',
      category: '其他',
    });
    expect(preview.skipped).toEqual([
      { line: 3, reason: '缺少密码' },
      { line: 4, reason: '缺少账号' },
      { line: 5, reason: '整行为空' },
    ]);
  });

  it('标题缺失时用账号兜底，空文件报错', () => {
    const preview = previewCsvImport('name,username,password\n,u@example.com,Pass-1-Aa1!\n');
    expect(preview.items).toHaveLength(1);
    expect(preview.items[0].title).toBe('u@example.com');
    expect(() => previewCsvImport('')).toThrow();
  });
});
