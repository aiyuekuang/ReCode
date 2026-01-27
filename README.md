# CodeTimeDB - AI Code History Guard

[![VS Code Marketplace](https://img.shields.io/badge/VS%20Code-Marketplace-blue)](https://marketplace.visualstudio.com/items?itemName=YOUR_PUBLISHER_ID.codetimedb)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

自动追踪代码变更，一键回滚到任意版本。**专为 AI 编码场景设计。**

## ✨ 功能特性

- 🔄 **自动追踪** - 无侵入式监控所有代码文件变化
- ⏪ **一键回滚** - 预览并回滚到任意历史版本
- 📦 **批量检测** - 智能识别 AI 工具的批量修改（10秒窗口）
- 💾 **高效存储** - 使用 SQLite + diff 存储，节省空间
- 🔀 **多工作区支持** - 同时监控多个工作区
- ⚙️ **可配置** - 自定义保留天数、最大记录数等
- 🎯 **通用兼容** - 兼容 Cursor、Copilot、Claude 等所有 AI 工具

## 📥 安装

在 VS Code 中搜索 `CodeTimeDB` 或直接安装：

```bash
ext install YOUR_PUBLISHER_ID.codetimedb
```

或者在 [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=YOUR_PUBLISHER_ID.codetimedb) 下载。

## 🚀 快速开始

1. 安装插件后，左侧活动栏会出现 CodeTimeDB 图标
2. 点击图标打开变更历史面板
3. 开始编辑代码，变更会自动记录
4. 点击 **Diff** 查看变更详情
5. 点击 **回滚到此** 恢复到指定版本

## ⚙️ 配置选项

在 VS Code 设置中搜索 `codetimedb`:

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `codetimedb.enabled` | `true` | 启用/禁用自动追踪 |
| `codetimedb.retentionDays` | `15` | 保留历史记录的天数 (1-365) |
| `codetimedb.maxHistorySize` | `1000` | 最大保留记录数 |
| `codetimedb.debounceDelay` | `2000` | 防抖延迟 (毫秒) |

## 🔧 命令

| 命令 | 说明 |
|------|------|
| `CodeTimeDB: Show History` | 显示变更历史面板 |
| `CodeTimeDB: Enable Tracking` | 启用追踪 |
| `CodeTimeDB: Disable Tracking` | 禁用追踪 |

## 📁 数据存储

变更记录存储在项目根目录的 `.codetimedb/` 文件夹中：
- 自动添加到 `.gitignore`
- 使用 SQLite 数据库
- 只存储 diff，不存储完整文件副本

## 🎯 使用场景

### AI 辅助编程
当使用 Cursor、GitHub Copilot、ChatGPT 等 AI 工具时，AI 可能会对代码做大量修改。CodeTimeDB 会自动将这些批量修改分组，方便你一键回滚。

### 实验性修改
尝试不同的实现方案时，随时可以回滚到之前的版本，无需手动备份。

### 代码审查
查看文件的变更历史，了解代码是如何演变的。

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📄 许可证

MIT License
