/**
 * CSV 导入的验收矩阵：真实导出格式 × 解析边界。
 *
 * 为什么值得单独铺一张网：用户手里的 CSV 几乎不会是我们的模板，
 * 而是 Chrome / Edge / LastPass / 1Password / Bitwarden 导出来的东西。
 * 这些文件里有 BOM、CRLF、引号里带逗号和换行、列名千奇百怪。
 * 解析一旦出错，失败方式是"静默少几行"——用户以为导完了，其实丢了一半。
 *
 * 期望值写的是**应该怎样**，不是"现在怎样"。跑出来红的就是待修的真问题。
 */
import { describe, expect, it } from 'vitest';
import { parseCsvRows, previewCsvImport, resolveCsvColumns } from '../csv-import';

/** 把预览结果压成 `[标题, 账号]`，方便断言顺序与条数。 */
function summarize(text: string, override?: Parameters<typeof previewCsvImport>[1]): string[] {
  return previewCsvImport(text, override).items.map((item) => `${item.title}|${item.username}`);
}

describe('CSV 解析 · 词法与换行', () => {
  it('BOM + CRLF + 引号转义（"" 表示一个引号）', () => {
    const rows = parseCsvRows('\uFEFF名称,备注\r\n"a""b","x,y"\r\n');
    expect(rows).toEqual([
      ['名称', '备注'],
      ['a"b', 'x,y'],
    ]);
  });

  it('引号内的换行属于同一个字段，不切成两行', () => {
    const rows = parseCsvRows('name,notes\n"标题","第一行\n第二行"\n');
    expect(rows).toHaveLength(2);
    expect(rows[1][1]).toBe('第一行\n第二行');
  });

  it('文件末尾没有换行时最后一行也要收进来', () => {
    expect(parseCsvRows('a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('只有 \\r 的老式换行也按换行处理', () => {
    expect(parseCsvRows('a,b\r1,2\r')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('中间的空行不产生记录，但会在预览里报「整行为空」', () => {
    const preview = previewCsvImport('名称,账号,密码\nA,u,p\n\nB,u2,p2\n');
    expect(preview.items).toHaveLength(2);
    expect(preview.skipped).toHaveLength(1);
    expect(preview.skipped[0].reason).toBe('整行为空');
  });
});

describe('CSV 格式识别 · 真实导出文件', () => {
  it('Chrome / Edge：name,url,username,password,note', () => {
    const csv = [
      'name,url,username,password,note',
      'GitHub,https://github.com,octo,pw-1,工作账号',
    ].join('\n');
    const preview = previewCsvImport(csv);
    expect(preview.items).toHaveLength(1);
    expect(preview.items[0]).toMatchObject({
      title: 'GitHub',
      username: 'octo',
      url: 'https://github.com',
      notes: '工作账号',
    });
  });

  it('LastPass：url,username,password,extra,name,grouping,fav', () => {
    const csv = [
      'url,username,password,extra,name,grouping,fav',
      'https://mail.example.com,me,pw-2,备用邮箱,Mail,工作,0',
    ].join('\n');
    const preview = previewCsvImport(csv);
    expect(preview.items[0]).toMatchObject({
      title: 'Mail',
      username: 'me',
      url: 'https://mail.example.com',
      notes: '备用邮箱',
    });
  });

  it('1Password：Title,Url,Username,Password,Notes', () => {
    const csv = ['Title,Url,Username,Password,Notes', 'Bank,https://bank.example,me,pw-3,主卡'].join(
      '\n',
    );
    const preview = previewCsvImport(csv);
    expect(preview.items[0]).toMatchObject({ title: 'Bank', username: 'me', notes: '主卡' });
  });

  it('Bitwarden：login_username / login_password / login_uri 也要认', () => {
    const csv = [
      'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp',
      '工作,0,login,Corp,备注,,0,https://corp.example,me@corp.example,pw-4,',
    ].join('\n');
    const preview = previewCsvImport(csv);
    expect(preview.items).toHaveLength(1);
    expect(preview.items[0]).toMatchObject({
      title: 'Corp',
      username: 'me@corp.example',
      password: 'pw-4',
      url: 'https://corp.example',
      category: '工作',
    });
  });

  it('自带的模板（中文表头 + BOM）能原样导回', () => {
    const csv =
      '\uFEFF名称,平台,账号,密码,网址,本地应用目标,分类,标签,备注\r\n' +
      'WiFi,家里,admin,pw-5,,,其他,家庭;常用,客厅路由\r\n';
    const preview = previewCsvImport(csv);
    expect(preview.items[0]).toMatchObject({
      title: 'WiFi',
      platform: '家里',
      username: 'admin',
      tags: ['家庭', '常用'],
      notes: '客厅路由',
    });
  });
});

describe('CSV 映射 · 识别不出时必须说清楚', () => {
  it('表头完全对不上时报「缺少名称/账号/密码列」，而不是导出一堆空卡', () => {
    expect(() => previewCsvImport('a,b,c\n1,2,3\n')).toThrow(/缺少名称/);
  });

  it('手工映射指向不存在的列立刻报错', () => {
    expect(() => resolveCsvColumns(['名称', '账号'], { title: '不存在的列' })).toThrow(
      /不存在的列/,
    );
  });

  it('手工把必填列设为 null 时不允许（否则等于没映射）', () => {
    expect(() => previewCsvImport('名称,账号,密码\nA,u,p\n', { password: null })).toThrow(
      /缺少名称/,
    );
  });
});

describe('CSV 数据 · 缺字段与回退', () => {
  it('短行（字段数少于表头）不崩，缺的字段按空处理', () => {
    const preview = previewCsvImport('名称,账号,密码,网址\nA,u,p\n');
    expect(preview.items[0]).toMatchObject({ title: 'A', username: 'u', password: 'p' });
    expect(preview.items[0].url).toBeUndefined();
  });

  it('标题为空但有账号时，标题回退成账号（而不是丢掉这一行）', () => {
    expect(summarize('名称,账号,密码\n,u,p\n')).toEqual(['u|u']);
  });

  it('缺账号或缺密码的行被跳过，并给出具体原因', () => {
    const preview = previewCsvImport('名称,账号,密码\nA,,p\nB,u,\n');
    expect(preview.items).toHaveLength(0);
    expect(preview.skipped.map((item) => item.reason)).toEqual(['缺少账号', '缺少密码']);
  });

  it('分类为空时落到默认分类，写了就用写的', () => {
    const preview = previewCsvImport('名称,账号,密码,分类\nA,u,p,\nB,u2,p2,工作\n', undefined, {
      defaultCategory: '其他',
    });
    expect(preview.items.map((item) => item.category)).toEqual(['其他', '工作']);
  });

  it('标签支持中英文多种分隔符', () => {
    // 逗号在 CSV 里是分隔符，要留在同一个字段里必须加引号。
    const preview = previewCsvImport('名称,账号,密码,标签\nA,u,p,"甲；乙、丙,丁"\n');
    expect(preview.items[0].tags).toEqual(['甲', '乙', '丙', '丁']);
  });
});
