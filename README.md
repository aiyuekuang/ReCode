# ReCode - AI Code History Guard

[![VS Code Marketplace](https://img.shields.io/badge/VS%20Code-Marketplace-blue)](https://marketplace.visualstudio.com/items?itemName=aiyuekuang.recode)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> 🎉 **NEW: [ReCode-MCP](https://github.com/aiyuekuang/ReCode-MCP) is now available!** Let AI assistants (Claude, Cursor, etc.) directly access your code change history.
>
> **MCP Tools:**
> - `query_history` - Query change records by time/file
> - `get_change_diff` - Get detailed diff of any change
> - `search_changes` - Search when code was added/removed
> - `get_statistics` - View change frequency & file activity
> - `list_workspaces` - List all ReCode workspaces
>
> Quick start: `npx recode-mcp`

[中文文档](./README_CN.md)

Automatically track code changes and rollback to any version with one click. **Designed for AI-assisted coding scenarios.**

## ✨ Features

- 🔄 **Auto Tracking** - Non-invasive monitoring of all code file changes
- ⏪ **One-Click Rollback** - Preview and rollback to any historical version
- 📦 **Batch Detection** - Smart detection of AI tool batch modifications (10-second window)
- 💾 **Efficient Storage** - Uses SQLite + diff storage to save space
- 🔀 **Multi-Workspace Support** - Monitor multiple workspaces simultaneously
- ⚙️ **Configurable** - Customize retention days, max history size, etc.
- 🎯 **Universal Compatibility** - Works with Cursor, Copilot, Claude, and all AI tools
- 🛡️ **Protected Files** - Warn or confirm when modifying important config files

## 📥 Installation

Search for `ReCode` in VS Code or install directly:

```bash
ext install ztao.recode
```

Or download from [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=ztao.recode).

## 🚀 Quick Start

1. After installation, the ReCode icon appears in the left activity bar
2. Click the icon to open the change history panel
3. Start editing code, changes are automatically recorded
4. Use three operations:
   - **Diff** 🔍 - View specific changes of a modification
   - **Restore** ↩️ - Quickly undo the most recent modification (latest record only)
   - **Rollback** ⏪ - Return to any historical version (requires confirmation)

## 📖 How It Works

### Core Concept

ReCode automatically records each file save, creating a change record:

```
Timeline →
v0 ──[edit1]──> v1 ──[edit2]──> v2 ──[edit3]──> v3 (current)
    record#1       record#2       record#3
    old: v0        old: v1        old: v2
    new: v1        new: v2        new: v3
```

### Three Operations

#### 1️⃣ View Diff

**Purpose**: View specific content of a modification  
**Display**: All records  
**Effect**: Left side shows `old_content`, right side shows `new_content`

#### 2️⃣ Restore

**Purpose**: Undo a rollback operation, restore to pre-rollback state  
**Display**: Only when the latest record is from a rollback/restore operation  
**Confirmation**: Executes directly  
**Example**: After rollback, realize it was wrong, click "Restore" to undo

#### 3️⃣ Rollback

**Purpose**: Return to a historical version  
**Display**: Only historical records (not latest)  
**Confirmation**: Requires secondary confirmation, shows the modification chain to be undone  
**Example**: Want to go back to the version from 3 modifications ago

### Complete Flow Example

```
Initial state:
#1: "a" → "ab"      [Rollback]
#2: "ab" → "abc"     [Rollback]
#3: "abc" → "abcd"   [No action] ← Latest, normal edit
Current file: "abcd"

└── User clicks "Rollback" on #1
    │
    ├─> File becomes: "ab"
    ├─> Creates record #4: "abcd" → "ab" (rollback_from_id=3, rollback_to_id=1)
    └─> #2, #3 become grayed out (invalidated)

#1: "a" → "ab"      [Rollback] ← Rollback target
#2: "ab" → "abc"     [Rollback] 🔘 Grayed
#3: "abc" → "abcd"   [Rollback] 🔘 Grayed
#4: "abcd" → "ab"    [Restore to #3] ← Latest
Current file: "ab"

└── User clicks "Restore to #3" on #4
    │
    ├─> File restored to: "abcd"
    ├─> Creates record #5: "ab" → "abcd" (rollback_from_id=3, rollback_to_id=1)
    └─> #4 grayed, #2, #3 restored to normal

#1: "a" → "ab"      [Rollback]
#2: "ab" → "abc"     [Rollback] ✓ Restored
#3: "abc" → "abcd"   [Rollback] ✓ Restored
#4: "abcd" → "ab"    [Rollback] 🔘 Grayed
#5: "ab" → "abcd"    [Restore to #3] ← Latest
Current file: "abcd"

└── User manually edits and saves
    │
    ├─> File becomes: "abcdef"
    ├─> Creates record #6: "abcd" → "abcdef" (normal edit)
    └─> All records restored to normal

#1: "a" → "ab"      [Rollback]
#2: "ab" → "abc"     [Rollback]
#3: "abc" → "abcd"   [Rollback]
#4: "abcd" → "ab"    [Rollback]
#5: "ab" → "abcd"    [Rollback]
#6: "abcd" → "abcdef" [No action] ← Latest, normal edit
Current file: "abcdef"
```

### Button Display Rules

| Record Type | Condition | Button Shown | Style |
|-------------|-----------|--------------|-------|
| Latest record | Has `rollback_from_id` | 🔄 Restore to #X | Normal |
| Latest record | No `rollback_from_id` | No button | Normal |
| Historical record | In rollback range | ⏪ Rollback | 🔘 Grayed + Strikethrough |
| Historical record | Not in rollback range | ⏪ Rollback | Normal |

**For detailed technical documentation, see** [📝 LOGIC.md](./LOGIC.md)

## ⚙️ Configuration

Search for `recode` in VS Code settings:

| Setting | Default | Description |
|---------|---------|-------------|
| `recode.enabled` | `true` | Enable/disable automatic tracking |
| `recode.retentionDays` | `15` | Days to retain change history (1-365) |
| `recode.maxHistorySize` | `1000` | Maximum number of records to keep |
| `recode.debounceDelay` | `2000` | Debounce delay in milliseconds |
| `recode.protectedFiles` | `[]` | Glob patterns for protected files (e.g. `package.json`, `.env*`) |
| `recode.protectedFileAction` | `notify` | Action when protected file is modified: `none`, `notify`, `confirm` |

## 🔧 Commands

| Command | Description |
|---------|-------------|
| `ReCode: Show History` | Show change history panel |
| `ReCode: Enable Tracking` | Enable tracking |
| `ReCode: Disable Tracking` | Disable tracking |

## 📁 Data Storage

Change records are stored in the `.recode/` folder in the project root:
- Automatically added to `.gitignore`
- Uses SQLite database
- Only stores diffs, not complete file copies

## 🎯 Use Cases

### AI-Assisted Programming
When using Cursor, GitHub Copilot, ChatGPT, and other AI tools, AI may make extensive code modifications. ReCode automatically groups these batch modifications, making it easy to rollback with one click.

### Experimental Changes
When trying different implementation approaches, you can rollback to previous versions at any time without manual backups.

### Code Review
View file change history to understand how code has evolved.

## 🤝 Contributing

Issues and Pull Requests are welcome!

## 📄 License

MIT License
