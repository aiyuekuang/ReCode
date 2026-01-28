# ReCode - AI Code History Guard

[![VS Code Marketplace](https://img.shields.io/badge/VS%20Code-Marketplace-blue)](https://marketplace.visualstudio.com/items?itemName=ztao.recode)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

[English](./README.md)

自动追踪代码变更，一键回滚到任意版本。**专为 AI 编码场景设计。**

## ✨ 功能特性

- 🔄 **自动追踪** - 无侵入式监控所有代码文件变化
- ⏪ **一键回滚** - 预览并回滚到任意历史版本
- 📦 **批量检测** - 智能识别 AI 工具的批量修改（10秒窗口）
- 💾 **高效存储** - 使用 SQLite + diff 存储，节省空间
- 🔀 **多工作区支持** - 同时监控多个工作区
- ⚙️ **可配置** - 自定义保留天数、最大记录数等
- 🎯 **通用兼容** - 兼容 Cursor、Copilot、Claude 等所有 AI 工具
- 🛡️ **重要文件保护** - 修改配置文件时提醒或确认

## 📥 安装

在 VS Code 中搜索 `ReCode` 或直接安装：

```bash
ext install ztao.recode
```

或者在 [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=ztao.recode) 下载。

## 🚀 快速开始

1. 安装插件后，左侧活动栏会出现 ReCode 图标
2. 点击图标打开变更历史面板
3. 开始编辑代码，变更会自动记录
4. 使用三种操作：
   - **Diff** 🔍 - 查看某次修改的具体内容
   - **恢复** ↩️ - 快速撤销最近一次修改（仅最新记录）
   - **回滚** ⏪ - 回到任意历史版本（需要确认）

## 📖 业务逻辑说明

### 核心概念

ReCode 自动记录每次文件保存,创建一条变更记录：

```
时间线 →
v0 ──[修改1]──> v1 ──[修改2]──> v2 ──[修改3]──> v3 (当前)
    记录#1         记录#2         记录#3
    old: v0        old: v1        old: v2
    new: v1        new: v2        new: v3
```

### 三种操作

#### 1️⃣ 查看差异 (Diff)

**作用**：查看某次修改的具体内容  
**显示**：所有记录  
**效果**：左侧显示 `old_content`，右侧显示 `new_content`

#### 2️⃣ 恢复 (Restore)

**作用**：撤销回滚操作，恢复到回滚前的状态  
**显示**：仅当最新记录是回滚/恢复操作产生的  
**确认**：直接执行  
**示例**：回滚后发现错了，点击"恢复"撤销回滚

#### 3️⃣ 回滚 (Rollback)

**作用**：回到某个历史版本  
**显示**：仅历史记录（非最新）  
**确认**：需要二次确认，显示会被撤销的修改链路  
**示例**：想回到 3 次修改前的版本

### 完整流程示例

```
初始状态：
#1: "a" → "ab"      [回滚]
#2: "ab" → "abc"     [回滚]
#3: "abc" → "abcd"   [无操作] ← 最新，正常编辑
当前文件: "abcd"

└── 用户点击 #1 的"回滚"
    │
    ├─> 文件变为: "ab"
    ├─> 生成记录 #4: "abcd" → "ab" (rollback_from_id=3, rollback_to_id=1)
    └─> #2, #3 变灰（失效）

#1: "a" → "ab"      [回滚] ← 回滚目标
#2: "ab" → "abc"     [回滚] 🔘 变灰
#3: "abc" → "abcd"   [回滚] 🔘 变灰
#4: "abcd" → "ab"    [恢复到 #3] ← 最新
当前文件: "ab"

└── 用户点击 #4 的"恢复到 #3"
    │
    ├─> 文件恢复为: "abcd"
    ├─> 生成记录 #5: "ab" → "abcd" (rollback_from_id=3, rollback_to_id=1)
    └─> #4 变灰，#2, #3 恢复正常

#1: "a" → "ab"      [回滚]
#2: "ab" → "abc"     [回滚] ✓ 恢复正常
#3: "abc" → "abcd"   [回滚] ✓ 恢复正常
#4: "abcd" → "ab"    [回滚] 🔘 变灰
#5: "ab" → "abcd"    [恢复到 #3] ← 最新
当前文件: "abcd"

└── 用户手动编辑并保存
    │
    ├─> 文件变为: "abcdef"
    ├─> 生成记录 #6: "abcd" → "abcdef" (正常编辑)
    └─> 所有记录恢复正常

#1: "a" → "ab"      [回滚]
#2: "ab" → "abc"     [回滚]
#3: "abc" → "abcd"   [回滚]
#4: "abcd" → "ab"    [回滚]
#5: "ab" → "abcd"    [回滚]
#6: "abcd" → "abcdef" [无操作] ← 最新，正常编辑
当前文件: "abcdef"
```

### 按钮显示规则

| 记录类型 | 条件 | 显示的按钮 | 样式 |
|---------|------|-----------|------|
| 最新记录 | 有 `rollback_from_id` | 🔄 恢复到 #X | 正常 |
| 最新记录 | 无 `rollback_from_id` | 无按钮 | 正常 |
| 历史记录 | 在回滚区间内 | ⏪ 回滚 | 🔘 变灰 + 删除线 |
| 历史记录 | 不在回滚区间内 | ⏪ 回滚 | 正常 |

**详细技术文档请查看** [📝 LOGIC.md](./LOGIC.md)

## ⚙️ 配置选项

在 VS Code 设置中搜索 `recode`:

| 配置项 | 默认值 | 说明 |
||--------|--------|------|
| `recode.enabled` | `true` | 启用/禁用自动追踪 |
| `recode.retentionDays` | `15` | 保留历史记录的天数 (1-365) |
| `recode.maxHistorySize` | `1000` | 最大保留记录数 |
| `recode.debounceDelay` | `2000` | 防抖延迟 (毫秒) |
| `recode.protectedFiles` | `[]` | 受保护文件的 glob 模式（如 `package.json`、`.env*`） |
| `recode.protectedFileAction` | `notify` | 修改受保护文件时的处理方式: `none`/`notify`/`confirm` |

## 🔧 命令

| 命令 | 说明 |
|------|------|
| `ReCode: Show History` | 显示变更历史面板 |
| `ReCode: Enable Tracking` | 启用追踪 |
| `ReCode: Disable Tracking` | 禁用追踪 |

## 📁 数据存储

变更记录存储在项目根目录的 `.recode/` 文件夹中：
- 自动添加到 `.gitignore`
- 使用 SQLite 数据库
- 只存储 diff，不存储完整文件副本

## 🎯 使用场景

### AI 辅助编程
当使用 Cursor、GitHub Copilot、ChatGPT 等 AI 工具时，AI 可能会对代码做大量修改。ReCode 会自动将这些批量修改分组，方便你一键回滚。

### 实验性修改
尝试不同的实现方案时，随时可以回滚到之前的版本，无需手动备份。

### 代码审查
查看文件的变更历史，了解代码是如何演变的。

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📄 许可证

MIT License
