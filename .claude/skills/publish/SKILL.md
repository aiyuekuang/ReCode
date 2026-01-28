---
name: publish
description: 发布扩展到 VS Code Marketplace 和 Open VSX Registry，确保两个市场同步更新。
license: MIT
metadata:
  tags:
    - publish
    - vscode-extension
    - marketplace
---

# 扩展发布工作流（Publish Workflow）

本技能用于将 VS Code 扩展同时发布到 **VS Code Marketplace** 和 **Open VSX Registry**，确保用户在 VS Code 和 Cursor 等编辑器中都能搜索安装。

## 前置条件

1. **Token 配置**（在 `.env` 文件中）：
   - `vsce_token`: VS Code Marketplace 的 Personal Access Token
   - `ovsx_token`: Open VSX Registry 的 Access Token

2. **工具安装**：
   - `vsce`: VS Code 扩展打包和发布工具
   - `ovsx`: Open VSX 发布工具

## 发布步骤

每次发布时，按以下顺序执行：

### 1. 打包扩展

```bash
npx vsce package
```

生成 `.vsix` 文件（如 `recode-0.1.3.vsix`）。

### 2. 发布到 VS Code Marketplace

```bash
source .env && npx vsce publish -p $vsce_token
```

或使用已打包的 vsix 文件：

```bash
source .env && npx vsce publish --packagePath <name>.vsix -p $vsce_token
```

### 3. 发布到 Open VSX Registry

```bash
source .env && ovsx publish <name>.vsix -p $ovsx_token
```

## 完整发布命令（一键执行）

```bash
# 打包并发布到两个市场
npx vsce package && \
source .env && \
npx vsce publish -p $vsce_token && \
ovsx publish *.vsix -p $ovsx_token
```

## 发布前检查清单

- [ ] 更新 `package.json` 中的版本号
- [ ] 更新 `changelog.md`
- [ ] 确保代码编译无错误 (`npm run compile`)
- [ ] 确保 `.env` 中的 token 有效

## 常见问题

### ovsx 命令找不到

安装 ovsx：

```bash
npm install -g ovsx
```

### namespace 被占用

首次发布到 Open VSX 时，如果 publisher namespace 已被占用，需要到 [open-vsx.org](https://open-vsx.org) 申请认领。

### Token 过期

- VS Code Marketplace Token: 在 [Azure DevOps](https://dev.azure.com) 重新生成
- Open VSX Token: 在 [open-vsx.org](https://open-vsx.org) Settings → Access Tokens 重新生成
