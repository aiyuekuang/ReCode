# ReCode 业务逻辑详解

## 核心概念

### 变更记录 (CodeChange)
每次文件保存都会创建一条变更记录，包含：
- `id` - 唯一标识
- `file_path` - 文件路径
- `old_content` - 修改前的内容
- `new_content` - 修改后的内容
- `timestamp` - 时间戳
- `batch_id` - 批量修改标识（10秒窗口内的修改视为批量）

### 时间线示意图

```
时间线 →
文件 A: v0 ──[修改1]──> v1 ──[修改2]──> v2 ──[修改3]──> v3 (当前)
        记录#1         记录#2         记录#3
        old: v0        old: v1        old: v2
        new: v1        new: v2        new: v3
```

## 三种操作

### 1. 查看差异 (Diff) 🔍

**适用场景**：查看某次修改的具体内容

**操作**：点击任意记录的 Diff 按钮

**效果**：
- 左侧显示 `old_content`（修改前）
- 右侧显示 `new_content`（修改后）
- 高亮显示变化的行

```
记录 #2: v1 → v2
┌──────────────┬──────────────┐
│ 修改前 (v1)  │ 修改后 (v2)  │
│ old_content  │ new_content  │
└──────────────┴──────────────┘
```

---

### 2. 恢复 (Restore) ↩️

**适用场景**：撤销最近一次修改

**限制**：只对**最新记录**（每个文件的最后一条记录）显示

**操作**：点击最新记录的恢复按钮

**效果**：
- 用该记录的 `old_content` 替换当前文件
- 相当于 **Ctrl+Z** 撤销最近一次保存
- **不会弹窗确认，直接执行**

```
当前文件: v3
点击记录 #3 的恢复按钮
└─> 文件内容变为 v2 (old_content)

记录 #3: v2 → v3
恢复 = 用 old_content (v2) 替换当前文件
```

**示例**：
```
记录 #3 (最新): 
  old: "hello"
  new: "hello world"
  
当前文件内容: "hello world"
点击恢复 → 文件变为: "hello"
```

---

### 3. 回滚 (Rollback) ⏪

**适用场景**：回到某个历史版本（可以跨越多次修改）

**限制**：对**所有记录**都可用

**操作**：点击任意记录的回滚按钮

**效果**：
- 显示回滚链路弹窗，展示会被撤销的所有修改
- 可以选择要撤销哪些修改
- 用目标记录的 `new_content` 恢复文件
- **需要二次确认**

```
当前文件: v3
点击记录 #1 的回滚按钮
└─> 弹窗显示会撤销的修改: #1, #2, #3
    └─> 确认后，文件变为 v1 (记录#1的new_content)

记录 #1: v0 → v1
回滚到此 = 用 new_content (v1) 替换当前文件
```

**回滚链路弹窗**：
```
⚠️ 回滚确认

文件: src/index.ts
回滚到: #1 
影响的变更: 3 次

┌─────────────────────────┐
│ ⚪ #3 (回滚目标)        │
│ ✅ 2小时前 +10 -5       │
├─────────────────────────┤
│ ⚪ #2                   │
│ ✅ 3小时前 +20 -10      │
├─────────────────────────┤
│ 🔴 #1                   │
│ ✅ 4小时前 +30 -15      │
└─────────────────────────┘

[全选] [全不选]

[取消] [确认回滚]
```

**示例**：
```
记录 #1:
  old: "a"
  new: "ab"
  
记录 #2:
  old: "ab"
  new: "abc"
  
记录 #3:
  old: "abc"
  new: "abcd"
  
当前文件内容: "abcd"

点击记录 #1 的回滚 → 弹窗确认 → 文件变为: "ab" (记录#1的new_content)
```

---

## 操作对比表

| 操作 | 按钮显示 | 作用 | 是否确认 | 使用的内容 |
|------|---------|----|---------|--------|
| **Diff** | 所有记录 | 查看某次修改的前后对比 | - | old & new |
| **恢复** | 仅最新记录 | 撤销最近一次保存 | ❌ 直接执行 | old_content |
| **回滚** | 仅历史记录 | 回到某个历史版本 | ✅ 需要确认 | new_content |

**重要**：恢复和回滚按钮是**互斥**的，不会同时显示！

---

## 实际案例

### 案例 1：AI 写了 bug，想撤销

```
1. AI 修改了代码并保存
2. 发现有 bug
3. 点击【最新记录】的"恢复"按钮
4. 代码立即回到 AI 修改前的状态 ✅
```

### 案例 2：想回到 3 次修改前的版本

```
当前: v5 (最新)
历史: v4 → v3 → v2 → v1 → v0

想回到 v2:
1. 找到记录 #2 (v1 → v2)
2. 点击"回滚"按钮
3. 弹窗显示会撤销 #2, #3, #4, #5
4. 确认 → 文件变为 v2 ✅
```

### 案例 3：AI 批量修改了多个文件

```
批量修改组:
  ├─ file1.ts: v1 → v2
  ├─ file2.ts: v1 → v2
  └─ file3.ts: v1 → v2

想全部撤销:
1. 展开批量组
2. 对每个文件的最新记录点"恢复"
3. 三个文件都回到修改前 ✅
```

---

## 按钮显示逻辑

```typescript
// 伪代码
for (const change of changes) {
  const isLatest = (change.id === maxIdForThisFile);
  
  显示按钮:
    - Diff: ✅ 总是显示
    - 恢复: isLatest ? ✅ : ❌  (仅最新记录)
    - 回滚: isLatest ? ❌ : ✅  (仅历史记录)
}
```

**关键点**：恢复和回滚是互斥的，每条记录只会显示其中一个！

### 为什么恢复只显示在最新记录？

因为恢复的语义是"撤销最近一次保存"，相当于 Ctrl+Z：
- 最新记录的 `old_content` = 当前文件的上一个版本
- 非最新记录的 `old_content` = 更早的版本（已经不是当前文件的上一个版本）

### 为什么回滚只显示在历史记录？

因为回滚是"跳转到某个历史版本"：
- 最新记录已经是当前版本，不需要回滚
- 如果想撤销最新修改，应该用“恢复”按钮
- 历史记录的 `new_content` 代表曾经的某个版本，可以回滚到那个状态

### 为什么不同时显示两个按钮？

- **恢夏** = “撤销最近一次修改”，只对最新记录有意义
- **回滚** = “回到某个历史版本”，只对历史记录有意义
- 对最新记录显示回滚按钮没有意义，因为当前就已经是这个版本了

---

## 数据流图

```
用户编辑文件
    ↓
保存 (Ctrl+S)
    ↓
FileWatcher 监听到变化
    ↓
读取文件内容 (new_content)
    ↓
从数据库读取上一个版本 (old_content)
    ↓
创建变更记录
    ├─ old_content
    ├─ new_content
    ├─ lines_added
    ├─ lines_removed
    ├─ batch_id (如果10秒内多次修改)
    └─ timestamp
    ↓
存入 SQLite 数据库
    ↓
UI 刷新显示最新记录
```

---

## 技术实现细节

### 1. 批量检测逻辑
```typescript
const BATCH_WINDOW = 10000; // 10秒
if (lastSaveTime && now - lastSaveTime < BATCH_WINDOW) {
  batch_id = generateBatchId();
}
```

### 2. 最新记录判断
```typescript
const latestIdByFile = new Map<string, number>();
for (const change of changes) {
  const current = latestIdByFile.get(change.file_path);
  if (!current || change.id > current) {
    latestIdByFile.set(change.file_path, change.id);
  }
}

const isLatestForFile = (latestIdByFile.get(file_path) === change.id);
```

### 3. 恢复操作
```typescript
async handleRestore(changeId) {
  const change = findChange(changeId);
  // 直接用 old_content 覆盖文件
  fs.writeFileSync(filePath, change.old_content);
}
```

### 4. 回滚操作
```typescript
async handleRollback(changeId) {
  const change = findChange(changeId);
  const laterChanges = getAllChangesAfter(changeId);
  
  // 显示弹窗，让用户选择要撤销哪些
  showModal(change, laterChanges);
}

async executeRollback(selectedIds) {
  const targetChange = findChange(min(selectedIds));
  // 用目标记录的 new_content 覆盖文件
  fs.writeFileSync(filePath, targetChange.new_content);
}
```

---

## 常见问题

### Q: 恢复和回滚有什么区别？
A: 
- **恢复**：快速撤销最近一次保存，相当于 Ctrl+Z
- **回滚**：回到任意历史版本，可以跨越多次修改

### Q: 为什么有的记录只有回滚按钮，没有恢复按钮？
A: 恢复按钮只对**最新记录**显示。如果你看到的记录不是最新的，说明这个文件后来又被修改过了。

### Q: 回滚会删除历史记录吗？
A: 不会。回滚只是恢复文件内容，所有历史记录仍然保留。

### Q: 如何完全回到某次修改前的状态？
A: 用"回滚"功能，选择目标记录即可。

---

## 改进建议

当前实现的问题：
1. ✅ 恢复使用 `old_content` - 正确
2. ❌ 回滚也使用 `old_content` - 错误，应该使用 `new_content`

需要修复的代码：
```typescript
// 当前（错误）
async executeRollback(changeIds) {
  const change = findChange(min(changeIds));
  fs.writeFileSync(filePath, change.old_content); // ❌
}

// 应该改为
async executeRollback(changeIds) {
  const change = findChange(min(changeIds));
  fs.writeFileSync(filePath, change.new_content); // ✅
}
```
