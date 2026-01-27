# 安装和运行指南

## 项目已创建完成! 🎉

VS Code插件的所有代码已经生成,现在需要安装依赖并测试。

## 安装步骤

### 1. 安装依赖

等网络恢复后,在项目目录执行:

```bash
cd /Users/suconnect/Desktop/code/codetimedb-vscode
yarn install
```

或者使用npm:

```bash
npm install
```

如果网络一直有问题,可以尝试切换npm镜像源:

```bash
# 使用淘宝镜像
npm config set registry https://registry.npmmirror.com
yarn config set registry https://registry.npmmirror.com

# 然后重新安装
yarn install
```

### 2. 编译TypeScript

```bash
yarn compile
# 或
npm run compile
```

### 3. 在VS Code中调试

1. 用VS Code打开这个项目文件夹
2. 按 `F5` 启动调试
3. 会打开一个新的VS Code窗口(Extension Development Host)
4. 在新窗口中打开任意项目文件夹
5. 查看左侧活动栏,应该能看到数据库图标
6. 点击图标打开CodeTimeDB侧边栏

### 4. 测试功能

在新窗口中:

1. **编辑代码** - 修改任意.ts/.js/.vue等文件
2. **查看历史** - 2秒后侧边栏会显示新的变更记录
3. **查看Diff** - 点击"查看Diff"按钮对比代码变化
4. **回滚代码** - 点击"回滚到这"恢复之前的版本

## 项目结构

```
codetimedb-vscode/
├── src/
│   ├── extension.ts      # 插件入口
│   ├── database.ts       # SQLite数据库操作
│   ├── watcher.ts        # 文件监控逻辑
│   └── historyView.ts    # Webview UI界面
├── package.json          # 插件配置
├── tsconfig.json         # TypeScript配置
└── README.md            # 说明文档
```

## 核心功能说明

### 自动监控
- 启动后自动缓存所有代码文件
- 监听文件变化事件
- 2秒防抖延迟(避免快速连续保存产生重复记录)

### 数据存储
- 使用SQLite存储在 `.codetimedb/changes.db`
- 记录完整的旧内容和新内容
- 生成unified diff格式
- 统计增删行数

### UI界面
- 侧边栏表格展示
- 相对时间显示(如"5分钟前")
- 一键回滚按钮
- Diff查看器

## 打包发布

编译成.vsix安装包:

```bash
# 安装打包工具
npm install -g @vscode/vsce

# 打包
vsce package
```

会生成 `codetimedb-0.1.0.vsix` 文件,可以直接安装到VS Code:

```
Extensions -> 点击... -> Install from VSIX...
```

## 开发调试技巧

### 查看日志
- 在Extension Development Host窗口
- 打开"帮助" -> "切换开发人员工具"
- 查看Console标签的输出

### 修改代码后
- 在原窗口修改代码
- 按 `Cmd+Shift+P` -> "Reload Window" 重新加载插件

### 数据库查询
可以用SQLite客户端查看数据:

```bash
sqlite3 .codetimedb/changes.db
# 查看所有记录
SELECT id, timestamp, file_path, lines_added, lines_removed FROM changes ORDER BY id DESC LIMIT 10;
```

## 常见问题

### Q: 插件没有启动?
A: 检查是否打开了工作区文件夹(不是单个文件)

### Q: 没有记录到变更?
A: 
1. 检查配置 `codetimedb.enabled` 是否为true
2. 确认修改的是代码文件(.ts/.js等)
3. 查看控制台是否有错误

### Q: 回滚失败?
A: 确保文件没有被其他程序锁定,检查文件权限

## 下一步优化

如果想继续完善功能,可以:

1. **优化diff算法** - 使用更精确的diff库(如`diff`)
2. **批量回滚** - 支持选中多条记录一次性回滚
3. **分支功能** - 像Git一样创建变更分支
4. **搜索过滤** - 按文件名、时间范围搜索
5. **快捷键** - 添加快捷键操作
6. **状态栏提示** - 显示最近变更数量
7. **导出功能** - 导出变更历史为JSON

## 联系方式

如有问题可以提Issue或联系作者。

---

祝使用愉快! 🚀
