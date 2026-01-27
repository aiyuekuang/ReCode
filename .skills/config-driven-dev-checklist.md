# 配置驱动开发质量检查清单

## 使用方法
在完成功能开发后，使用此清单审查代码质量和配置驱动架构的合规性。

---

## 1. 数据配置层 (Data Configuration Layer)

### ✅ 配置字段定义
- [ ] 配置字段有清晰的语义化命名
- [ ] 使用 TypeScript 类型定义保证类型安全
- [ ] 每个配置字段都有注释说明其用途
- [ ] 配置字段使用合适的数据类型（enum, boolean, number, string）

**示例**：
```typescript
export interface CodeChange {
  operation_type: 'edit' | 'rollback';  // ✅ 语义化 + 类型安全
  rollback_to_id: number | null;        // ✅ 关系配置
  covered_by_rollback_id: number | null; // ✅ 状态配置（注释说明）
}
```

### ✅ 数据持久化
- [ ] 配置字段正确持久化到数据库
- [ ] 数据库 schema 包含所有配置字段
- [ ] 提供数据库迁移/升级逻辑
- [ ] 配置字段有合适的默认值

---

## 2. 配置与逻辑分离 (Separation of Configuration and Logic)

### ✅ 操作顺序
- [ ] 先写配置，再执行操作（配置先行原则）
- [ ] 配置变更和文件操作分离
- [ ] 使用注释标注"配置驱动"的关键步骤

**示例**：
```typescript
// ✅ 正确：先配置，再操作
// 1. 创建回滚记录（配置）
const rollbackId = db.insertChange(..., 'rollback', targetChangeId);
// 2. 标记被覆盖的记录（配置）
db.markCoveredByRollback(...);
// 3. 修改文件（操作）
writeFileContent(...);

// ❌ 错误：先操作，再配置
writeFileContent(...);  // 先改文件
db.insertChange(...);    // 后记录
```

### ✅ 配置管理函数
- [ ] 配置操作封装为专职函数
- [ ] 函数命名清晰表达配置意图（如 `markCovered`, `clearCovered`）
- [ ] 配置函数返回影响的记录数
- [ ] 配置操作具有原子性

---

## 3. 单一数据源 (Single Source of Truth)

### ✅ 状态计算
- [ ] UI 状态完全从配置字段计算得出
- [ ] 不在 UI 层维护重复的状态
- [ ] 状态计算逻辑集中在一处
- [ ] 避免状态推导链过长（≤3 层）

**示例**：
```typescript
// ✅ 正确：从配置计算状态
const canRestore = change.operation_type === 'rollback' && isLatest;
const isRollbackTarget = changes.some(c => c.rollback_to_id === change.id);

// ❌ 错误：在 UI 层维护状态
let isRollbackTarget = false;  // 额外的状态变量
if (...) isRollbackTarget = true;
```

---

## 4. 声明式编程 (Declarative Programming)

### ✅ HTML 数据属性
- [ ] 使用 `data-*` 属性存储配置
- [ ] 避免在 JavaScript 中硬编码数据
- [ ] 数据属性命名语义化

**示例**：
```html
<!-- ✅ 正确：使用 data 属性 -->
<div data-change-id="123" data-rollbacked-ids="1,2,3">

<!-- ❌ 错误：在 JS 中硬编码 -->
<div onclick="highlight([1, 2, 3])">
```

### ✅ CSS 类驱动样式
- [ ] 使用 CSS 类表示状态，而非内联样式
- [ ] 通过添加/移除类来改变 UI 状态
- [ ] 类名语义化（如 `.highlight-rollbacked`）

---

## 5. 代码优雅性 (Code Elegance)

### ✅ 魔法数字
- [ ] 所有魔法数字提取为常量
- [ ] 常量有清晰的命名和注释
- [ ] 常量集中定义在类/模块顶部

**示例**：
```typescript
// ✅ 正确
private static readonly REFRESH_DELAY_MS = 300;  // 文件系统同步延迟
setTimeout(() => this.refresh(), HistoryViewProvider.REFRESH_DELAY_MS);

// ❌ 错误
setTimeout(() => this.refresh(), 300);  // 为什么是 300？
```

### ✅ 选择器常量
- [ ] CSS 选择器提取为常量
- [ ] 选择器常量集中定义
- [ ] 使用常量拼接选择器，而非硬编码

**示例**：
```javascript
// ✅ 正确
const SELECTORS = {
  FILE_ROW: '.file-row',
  HIGHLIGHT_CLASS: 'highlight-rollbacked'
};
document.querySelector(SELECTORS.FILE_ROW + '.' + SELECTORS.HIGHLIGHT_CLASS);

// ❌ 错误
document.querySelector('.file-row.highlight-rollbacked');
```

### ✅ SQL 安全
- [ ] 使用参数化查询，避免 SQL 注入
- [ ] 如果 LIMIT 不支持参数化，添加类型校验
- [ ] 对用户输入进行验证和清理

**示例**：
```typescript
// ✅ 正确（无法参数化时）
LIMIT ${Math.floor(Math.abs(maxSize))}  // 类型校验

// ❌ 错误
LIMIT ${maxSize}  // 直接使用
```

---

## 6. 可维护性 (Maintainability)

### ✅ 函数职责
- [ ] 每个函数职责单一
- [ ] 复杂逻辑拆分为小函数
- [ ] 函数名清晰表达意图

### ✅ 注释
- [ ] 关键配置逻辑有注释说明
- [ ] 复杂算法有解释
- [ ] 注释说明"为什么"，而非"是什么"

### ✅ 代码组织
- [ ] 相关代码放在一起
- [ ] 配置定义在顶部
- [ ] 工具函数放在底部

---

## 7. 可测试性 (Testability)

### ✅ 配置层可测试
- [ ] 配置操作可独立测试
- [ ] 状态计算函数可独立测试
- [ ] 避免在测试中依赖 UI

---

## 评分标准

| 维度 | 权重 | 评分 |
|------|------|------|
| 数据配置清晰度 | 15% | /10 |
| 配置与逻辑分离 | 20% | /10 |
| 单一数据源 | 15% | /10 |
| 声明式编程 | 15% | /10 |
| 代码优雅性 | 20% | /10 |
| 可维护性 | 10% | /10 |
| 可测试性 | 5% | /10 |

**综合得分** = Σ(维度得分 × 权重)

- **9.0-10.0**: 优秀 ⭐⭐⭐⭐⭐
- **8.0-8.9**: 良好 ⭐⭐⭐⭐
- **7.0-7.9**: 合格 ⭐⭐⭐
- **< 7.0**: 需改进

---

## 使用示例

```bash
# 1. 完成功能开发
# 2. 运行此检查清单
# 3. 记录得分和改进项
# 4. 优化代码
# 5. 重新评分
```

## 改进建议模板

当某项检查未通过时，记录：
- **问题**：描述当前问题
- **影响**：对代码质量的影响
- **建议**：如何改进
- **优先级**：P0（必须）/ P1（重要）/ P2（可选）
