# components（通用组件占位）

Phase 2 起在此目录实现通用组件：`StatusBadge`（三档可见性角标）、`MaskedSecret`（遮蔽文本）、
`IconButton`（带 `aria-label`）、`ConfirmDialog`（高风险确认）、`Toast`（复制与清理提示）。

约束：通用组件不直接调用 `VaultClient`，通过 props 或 feature 层容器注入行为。
