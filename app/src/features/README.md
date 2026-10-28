# features（功能模块占位）

Phase 2 起在此目录实现：

- `island/`：灵动岛收缩/展开、搜索、最近使用、快捷复制、Toast。
- `vault/`：主面板、卡片网格/列表、`TiltCard`、资产编辑器、删除确认。
- `unlock/`：主密码解锁、密码提示、恢复码流程、重设主密码。
- `settings/`：自动锁定档位、剪贴板 TTL、防截屏、Windows Hello。
- `backup/`：`.kib` 导出与覆盖/合并恢复。

约束：所有敏感数据操作必须经 `src/services/vault-client.ts`，组件不得直接接触 DEK、KEK 或存储端口。
