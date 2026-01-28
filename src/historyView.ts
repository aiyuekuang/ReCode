import * as vscode from 'vscode';
import { ReCode, CodeChange } from './database';
import * as path from 'path';
import * as fs from 'fs';

interface WorkspaceInstance {
  db: ReCode;
  watcher: any;
}

export class HistoryViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'recode.historyView';
  private _view?: vscode.WebviewView;
  private workspaceInstances: Map<string, WorkspaceInstance>;
  
  // 配置常量
  private static readonly REFRESH_DELAY_MS = 300;  // 文件系统同步延迟
  private static readonly DISPOSE_DELAY_MS = 100;  // 临时资源清理延迟
  private static readonly MAX_HISTORY = 100;  // 最大历史记录数

  constructor(
    private readonly _extensionUri: vscode.Uri,
    workspaceInstances: Map<string, WorkspaceInstance>
  ) {
    this.workspaceInstances = workspaceInstances;
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // 处理来自webview的消息
    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case 'rollback':
          await this.handleRollback(data.changeId, data.workspaceName);
          break;
        case 'confirmRollback':
          await this.executeRollback(data.targetChangeId, data.workspaceName);
          break;
        case 'batchRollback':
          await this.handleBatchRollback(data.changeIds, data.workspaceNames);
          break;
        case 'restore':
          await this.handleRestore(data.changeId, data.workspaceName);
          break;
        case 'viewDiff':
          await this.handleViewDiff(data.changeId, data.workspaceName);
          break;
        case 'clearHistory':
          await this.handleClearHistory();
          break;
        case 'openSettings':
          vscode.commands.executeCommand('workbench.action.openSettings', 'recode');
          break;
      }
    });
  }

  public refresh() {
    if (this._view) {
      this._view.webview.html = this._getHtmlForWebview(this._view.webview);
    }
  }

  private async handleClearHistory() {
    const confirmClearText = vscode.l10n.t('Confirm Clear');
    const answer = await vscode.window.showWarningMessage(
      vscode.l10n.t('Are you sure you want to clear all history? This action cannot be undone!'),
      { modal: true },
      confirmClearText
    );
    
    if (answer === confirmClearText) {
      let totalDeleted = 0;
      for (const [, instance] of this.workspaceInstances) {
        totalDeleted += instance.db.clearAll();
      }
      this.refresh();
      vscode.window.showInformationMessage(vscode.l10n.t('Cleared {0} history records', totalDeleted));
    }
  }

  /**
   * 在指定工作区中查找变更记录
   * @param changeId 变更记录 ID
   * @param workspaceName 可选的工作区名称，用于精确定位
   */
  private findChange(changeId: number, workspaceName?: string): { change: CodeChange; db: ReCode; root: string } | null {
    for (const [root, instance] of this.workspaceInstances) {
      // 如果指定了工作区名称，先检查是否匹配
      if (workspaceName && path.basename(root) !== workspaceName) {
        continue;
      }
      const change = instance.db.getChangeById(changeId);
      if (change) {
        return { change, db: instance.db, root };
      }
    }
    return null;
  }

  /**
   * 写入文件内容，自动创建目录
   */
  private writeFileContent(filePath: string, content: string): boolean {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, content, 'utf-8');
    return fs.existsSync(filePath);
  }

  private async handleRollback(changeId: number, workspaceName?: string) {
    const result = this.findChange(changeId, workspaceName);
    if (!result) {
      vscode.window.showErrorMessage(vscode.l10n.t('Cannot find change record #{0}', changeId));
      return;
    }

    const { change, db, root } = result;
    
    // 查找该文件在此之后的所有修改
    const allChanges = db.getChangesByFile(change.file_path, HistoryViewProvider.MAX_HISTORY);
    const laterChanges = allChanges.filter(c => c.id >= changeId);
    
    // 通知webview显示回滚链路弹窗（不需要 reverse，保持从新到旧）
    if (this._view) {
      this._view.webview.postMessage({
        type: 'showRollbackModal',
        targetChange: change,
        laterChanges: laterChanges, // 保持倒序（从新到旧）
        targetRoot: root,
        workspaceName: path.basename(root)
      });
    }
  }

  private async executeRollback(targetChangeId: number, workspaceName?: string) {
    const result = this.findChange(targetChangeId, workspaceName);
    
    if (!result) {
      vscode.window.showErrorMessage(vscode.l10n.t('Cannot find change record #{0}', targetChangeId));
      return;
    }

    const { change, db, root } = result;
    const instance = this.workspaceInstances.get(root);
    if (!instance) {
      vscode.window.showErrorMessage(vscode.l10n.t('Cannot find workspace instance'));
      return;
    }

    try {
      const filePath = path.join(root, change.file_path);
      const currentContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
      
      // 配置驱动：先配置，再操作
      // 1. 手动创建回滚记录（不经过 watcher）
      const diff = this.generateSimpleDiff(currentContent, change.new_content);
      const rollbackId = db.insertChange(
        change.file_path,
        currentContent,
        change.new_content,
        diff,
        0,
        0,
        null,
        'rollback',
        targetChangeId
      );
      
      // 2. 立即标记被覆盖的记录（配置驱动）
      const affectedCount = db.markCoveredByRollback(change.file_path, rollbackId, targetChangeId);
      console.log(`Created rollback record #${rollbackId}, marked ${affectedCount} records as covered`);
      
      // 3. 修改文件（跳过 watcher 记录）
      instance.watcher.setOperationContext(filePath, {
        skipRecording: true
      });
      this.writeFileContent(filePath, change.new_content);
      
      vscode.window.showInformationMessage(vscode.l10n.t('Rolled back to #{0} {1}', change.id, change.file_path));
      
      // 等待文件系统更新后刷新
      setTimeout(() => this.refresh(), HistoryViewProvider.REFRESH_DELAY_MS);
    } catch (error) {
      vscode.window.showErrorMessage(vscode.l10n.t('Rollback failed: {0}', String(error)));
    }
  }

  /**
   * 配置驱动：处理批量回滚
   * @param changeIds 要回滚的变更记录 ID 数组
   * @param workspaceNames 对应的工作区名称数组
   */
  private async handleBatchRollback(changeIds: number[], workspaceNames?: string[]) {
    if (!changeIds || changeIds.length === 0) {
      return;
    }

    // 1. 确认操作
    const confirmRollbackText = vscode.l10n.t('Confirm Rollback');
    const answer = await vscode.window.showWarningMessage(
      vscode.l10n.t('Are you sure you want to batch rollback {0} files? This will rollback to the selected versions.', changeIds.length),
      { modal: true },
      confirmRollbackText
    );
    
    if (answer !== confirmRollbackText) {
      return;
    }

    // 2. 收集所有变更记录，并按文件分组
    const changesByFile = new Map<string, Array<{ change: CodeChange; db: ReCode; root: string }>>();
    
    for (let i = 0; i < changeIds.length; i++) {
      const changeId = changeIds[i];
      const workspaceName = workspaceNames?.[i];
      const result = this.findChange(changeId, workspaceName);
      if (!result) {
        console.warn(`找不到变更记录 #${changeId}，跳过`);
        continue;
      }
      
      const { change } = result;
      const fileKey = `${result.root}::${change.file_path}`;
      
      if (!changesByFile.has(fileKey)) {
        changesByFile.set(fileKey, []);
      }
      changesByFile.get(fileKey)!.push(result);
    }

    // 3. 对每个文件，找到最旧的变更记录作为回滚目标
    const rollbackTargets: Array<{ change: CodeChange; db: ReCode; root: string }> = [];
    
    for (const [, changes] of changesByFile) {
      // 按 ID 排序（从旧到新）
      changes.sort((a, b) => a.change.id - b.change.id);
      // 取最旧的记录作为回滚目标
      rollbackTargets.push(changes[0]);
    }

    // 4. 批量执行回滚
    let successCount = 0;
    let failCount = 0;
    const batchId = `batch_${Date.now()}`;

    for (const { change, db, root } of rollbackTargets) {
      const instance = this.workspaceInstances.get(root);
      if (!instance) {
        console.error(`找不到工作区实例: ${root}`);
        failCount++;
        continue;
      }

      try {
        const filePath = path.join(root, change.file_path);
        const currentContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
        
        // 创建回滚记录（配置驱动：带 batch_id）
        const diff = this.generateSimpleDiff(currentContent, change.new_content);
        const rollbackId = db.insertChange(
          change.file_path,
          currentContent,
          change.new_content,
          diff,
          0,
          0,
          batchId,
          'rollback',
          change.id
        );
        
        // 标记被覆盖的记录
        db.markCoveredByRollback(change.file_path, rollbackId, change.id);
        
        // 修改文件（跳过 watcher 记录）
        instance.watcher.setOperationContext(filePath, {
          skipRecording: true
        });
        this.writeFileContent(filePath, change.new_content);
        
        successCount++;
      } catch (error) {
        console.error(`回滚失败 #${change.id}:`, error);
        failCount++;
      }
    }

    // 5. 显示结果
    if (failCount === 0) {
      vscode.window.showInformationMessage(vscode.l10n.t('Batch rollback successful: {0} files', successCount));
    } else {
      vscode.window.showWarningMessage(vscode.l10n.t('Batch rollback completed: {0} successful, {1} failed', successCount, failCount));
    }

    // 等待文件系统更新后刷新
    setTimeout(() => this.refresh(), HistoryViewProvider.REFRESH_DELAY_MS);
  }
  
  // 简单的 diff 生成
  private generateSimpleDiff(oldContent: string, newContent: string): string {
    const oldLines = oldContent.split('\n').length;
    const newLines = newContent.split('\n').length;
    return `@@ -1,${oldLines} +1,${newLines} @@`;
  }

  private async handleRestore(changeId: number, workspaceName?: string) {
    const result = this.findChange(changeId, workspaceName);
    if (!result) {
      vscode.window.showErrorMessage(vscode.l10n.t('Cannot find change record #{0}', changeId));
      return;
    }

    const { change, db, root } = result;
    if (change.operation_type !== 'rollback') {
      vscode.window.showErrorMessage(vscode.l10n.t('This record is not a rollback operation'));
      return;
    }

    const instance = this.workspaceInstances.get(root);
    if (!instance) {
      vscode.window.showErrorMessage(vscode.l10n.t('Cannot find workspace instance'));
      return;
    }

    try {
      const filePath = path.join(root, change.file_path);
      
      // 1. 设置操作上下文：跳过记录（配置驱动）
      instance.watcher.setOperationContext(filePath, {
        skipRecording: true
      });
      
      // 2. 恢复文件（watcher 跳过记录）
      this.writeFileContent(filePath, change.old_content);
      
      // 3. 清除被这个回滚记录覆盖的标记（配置驱动）
      db.clearCoveredByRollback(changeId);
      
      // 4. 删除这条回滚记录
      db.deleteChange(changeId);
      
      vscode.window.showInformationMessage(vscode.l10n.t('Restored to pre-rollback state'));
      
      setTimeout(() => this.refresh(), HistoryViewProvider.REFRESH_DELAY_MS);
    } catch (error) {
      vscode.window.showErrorMessage(vscode.l10n.t('Restore failed: {0}', String(error)));
      instance.watcher.clearOperationContext(path.join(root, change.file_path));
    }
  }


  private async handleViewDiff(changeId: number, workspaceName?: string) {
    const result = this.findChange(changeId, workspaceName);
    if (!result) {
      vscode.window.showErrorMessage(vscode.l10n.t('Cannot find change record #{0}', changeId));
      return;
    }

    const { change } = result;

    // 创建临时文件来显示diff
    const oldUri = vscode.Uri.parse(`recode-old:${change.file_path}?id=${changeId}`);
    const newUri = vscode.Uri.parse(`recode-new:${change.file_path}?id=${changeId}`);

    // 注册内容提供器
    const capturedChange = change; // 捕获引用避免闭包问题
    
    const oldDisposable = vscode.workspace.registerTextDocumentContentProvider('recode-old', {
      provideTextDocumentContent: () => capturedChange.old_content
    });

    const newDisposable = vscode.workspace.registerTextDocumentContentProvider('recode-new', {
      provideTextDocumentContent: () => capturedChange.new_content
    });

    // 打开diff视图
    await vscode.commands.executeCommand(
      'vscode.diff',
      oldUri,
      newUri,
      vscode.l10n.t('Change #{0}: {1}', changeId, change.file_path)
    );

    // 清理
    setTimeout(() => {
      oldDisposable.dispose();
      newDisposable.dispose();
    }, HistoryViewProvider.DISPOSE_DELAY_MS);
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
    // 收集所有工作区信息
    const workspaces: Array<{
      name: string;
      root: string;
      changes: Array<CodeChange & { workspaceName: string }>;
      totalChanges: number;
    }> = [];

    const allChanges: Array<CodeChange & { workspaceName: string; isLatestForFile: boolean; canRestore: boolean; isRollbackTarget: boolean; rollbackedRecords?: CodeChange[] }> = [];
    
    for (const [root, instance] of this.workspaceInstances) {
      const workspaceName = path.basename(root);
      const changes = instance.db.getRecentChanges(100);
      
      // 计算每个文件的最新记录 ID
      const latestIdByFile = new Map<string, number>();
      
      for (const change of changes) {
        const current = latestIdByFile.get(change.file_path);
        if (!current || change.id > current) {
          latestIdByFile.set(change.file_path, change.id);
        }
      }
      
      const wsChanges = changes.map(change => {
        const isLatest = latestIdByFile.get(change.file_path) === change.id;
        
        // 如果这是一条回滚记录，但不是最新记录，说明后面有新的编辑，恢复已无意义
        const canRestore = change.operation_type === 'rollback' && isLatest;
        
        // 判断是否是回滚目标：检查是否有回滚记录指向这个 ID
        const isRollbackTarget = changes.some(c => 
          c.operation_type === 'rollback' && 
          c.rollback_to_id === change.id &&
          c.file_path === change.file_path
        );
        
        // 如果是回滚记录，找出被回滚的所有记录
        let rollbackedRecords: CodeChange[] | undefined;
        if (change.operation_type === 'rollback' && change.rollback_to_id) {
          rollbackedRecords = changes.filter(c => 
            c.file_path === change.file_path &&
            c.covered_by_rollback_id === change.id
          );
        }
        
        return {
          ...change,
          workspaceName,
          isLatestForFile: isLatest,
          canRestore,  // 是否可以恢复
          isRollbackTarget,  // 是否是回滚目标
          rollbackedRecords  // 被这次回滚覆盖的记录
        };
      });
      
      workspaces.push({
        name: workspaceName,
        root,
        changes: wsChanges,
        totalChanges: changes.length
      });
      
      allChanges.push(...wsChanges);
    }

    // 按时间排序
    allChanges.sort((a, b) => {
      return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
    });

    const groups = this.groupChangesByTime(allChanges);
    const showTabs = workspaces.length > 1;

    // 获取 Codicon 字体 URI
    const codiconCssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css')
    );
    const codiconFontUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.ttf')
    );

    return `<!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource} data:; script-src 'unsafe-inline';">
      <title>ReCode History</title>
      <style>
        @font-face {
          font-family: "codicon";
          font-display: block;
          src: url("${codiconFontUri}") format("truetype");
        }
      </style>
      <link href="${codiconCssUri}" rel="stylesheet" />
      <style>
        * {
          box-sizing: border-box;
        }
        
        body {
          padding: 0;
          margin: 0;
          color: var(--vscode-foreground);
          font-family: var(--vscode-font-family);
          font-size: var(--vscode-font-size);
          line-height: 1.5;
        }
        
        .header {
          padding: 12px 16px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          border-bottom: 1px solid var(--vscode-panel-border);
          background: var(--vscode-sideBar-background);
        }
        
        .header-title {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 13px;
          font-weight: 600;
          color: var(--vscode-foreground);
        }
        
        .refresh-btn {
          background: transparent;
          color: var(--vscode-foreground);
          border: none;
          padding: 4px 8px;
          cursor: pointer;
          border-radius: 4px;
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 13px;
          opacity: 0.8;
          transition: opacity 0.2s, background 0.2s;
          position: relative;
        }
        
        .refresh-btn:hover {
          background: var(--vscode-toolbar-hoverBackground);
          opacity: 1;
        }
        
        /* Header button tooltip */
        .refresh-btn[title]:hover::after {
          content: attr(title);
          position: absolute;
          top: calc(100% + 6px);
          left: 50%;
          transform: translateX(-50%);
          padding: 4px 8px;
          background: var(--vscode-editorHoverWidget-background);
          border: 1px solid var(--vscode-editorHoverWidget-border);
          color: var(--vscode-editorHoverWidget-foreground);
          font-size: 11px;
          white-space: nowrap;
          border-radius: 3px;
          z-index: 10000;
          pointer-events: none;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
        }
        
        .content-area {
          padding: 8px;
        }
        
        .group {
          margin-bottom: 4px;
          border: 1px solid var(--vscode-panel-border);
          border-radius: 4px;
          overflow: hidden;
          background: var(--vscode-editor-background);
        }
        
        .group-header {
          display: flex;
          align-items: center;
          padding: 8px 12px;
          cursor: pointer;
          user-select: none;
          transition: background 0.15s;
          position: relative;
        }
        
        .group-header:hover {
          background: var(--vscode-list-hoverBackground);
        }
        
        .toggle-icon {
          margin-right: 8px;
          transition: transform 0.2s ease;
          color: var(--vscode-foreground);
          opacity: 0.8;
        }
        
        .group.collapsed .toggle-icon {
          transform: rotate(-90deg);
        }
        
        .group-header:hover .toggle-icon {
          opacity: 1;
        }
        
        .group-time {
          font-weight: 500;
          margin-right: 12px;
          font-size: 12px;
          color: var(--vscode-foreground);
          display: flex;
          align-items: baseline;
          gap: 6px;
        }
        
        .group-time-detail {
          font-size: 10px;
          font-weight: 400;
          color: var(--vscode-descriptionForeground);
          opacity: 0.8;
        }
        
        .batch-badge {
          background: var(--vscode-badge-background);
          color: var(--vscode-badge-foreground);
          padding: 2px 6px;
          border-radius: 2px;
          font-size: 11px;
          margin-right: 8px;
          display: inline-flex;
          align-items: center;
          gap: 4px;
        }
        
        .group-summary {
          font-size: 11px;
          color: var(--vscode-descriptionForeground);
          opacity: 0.9;
        }
        
        .group-stats {
          margin-left: auto;
          font-family: var(--vscode-editor-font-family);
          font-size: 11px;
          display: flex;
          gap: 8px;
        }
        
        .group-content {
          border-top: 1px solid var(--vscode-panel-border);
        }
        
        .group.collapsed .group-content {
          display: none;
        }
        
        .file-row {
          display: flex;
          align-items: center;
          padding: 6px 12px 6px 32px;
          border-top: 1px solid var(--vscode-panel-border);
          transition: background 0.1s, opacity 0.2s;
        }
        
        .file-row:first-child {
          border-top: none;
        }
        
        .file-row:hover {
          background: var(--vscode-list-hoverBackground);
        }
        
        /* 被回滚覆盖的记录 */
        .file-row.rolled-back {
          opacity: 0.5;
        }
        
        .file-row.rolled-back .file-path {
          color: var(--vscode-descriptionForeground);
          text-decoration: line-through;
        }
        
        /* hover 回滚图标时高亮被回滚的记录 */
        .file-row.highlight-rollbacked {
          background: rgba(255, 200, 0, 0.15) !important;
          transition: background 0.2s ease;
        }
        
        /* hover 时高亮分组头部 */
        .group-header.highlight-rollbacked {
          background: rgba(255, 200, 0, 0.15) !important;
          transition: background 0.2s ease;
        }
        
        .file-info {
          flex: 1;
          display: flex;
          align-items: center;
          gap: 8px;
          overflow: hidden;
        }
        
        .file-icon {
          opacity: 0.7;
          flex-shrink: 0;
        }
        
        .file-path {
          font-family: var(--vscode-editor-font-family);
          font-size: 12px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          color: var(--vscode-foreground);
        }
        
        .file-stats {
          font-family: var(--vscode-editor-font-family);
          font-size: 11px;
          margin: 0 12px;
          min-width: 70px;
          text-align: right;
          display: flex;
          gap: 8px;
          justify-content: flex-end;
          flex-shrink: 0;
        }
        
        .added { color: var(--vscode-gitDecoration-addedResourceForeground, #4ec9b0); }
        .removed { color: var(--vscode-gitDecoration-deletedResourceForeground, #f48771); }
        
        .file-actions {
          display: flex;
          gap: 4px;
          flex-shrink: 0;
        }
        
        .btn {
          background: transparent;
          color: var(--vscode-button-secondaryForeground);
          border: 1px solid var(--vscode-button-border, transparent);
          padding: 3px 8px;
          cursor: pointer;
          border-radius: 2px;
          font-size: 11px;
          white-space: nowrap;
          transition: background 0.1s;
          position: relative;
        }
        
        .btn:hover {
          background: var(--vscode-button-secondaryHoverBackground);
        }
        
        /* 通用 tooltip 样式 */
        .btn[title]:hover::after {
          content: attr(title);
          position: absolute;
          bottom: calc(100% + 6px);
          right: 0;
          padding: 4px 8px;
          background: var(--vscode-editorHoverWidget-background);
          border: 1px solid var(--vscode-editorHoverWidget-border);
          color: var(--vscode-editorHoverWidget-foreground);
          font-size: 11px;
          white-space: nowrap;
          border-radius: 3px;
          z-index: 10000;
          pointer-events: none;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
        }
        
        .btn-danger {
          color: var(--vscode-errorForeground, #f48771);
        }
        
        .btn-danger:hover {
          background: var(--vscode-inputValidation-errorBackground, rgba(244, 135, 113, 0.15));
        }
        
        
        .empty {
          padding: 48px 24px;
          text-align: center;
          color: var(--vscode-descriptionForeground);
        }
        
        .empty-icon {
          font-size: 48px;
          opacity: 0.5;
          margin-bottom: 16px;
        }
        
        .empty p:first-of-type {
          font-size: 14px;
          margin: 0 0 8px 0;
        }
        
        .empty p:last-of-type {
          font-size: 12px;
          margin: 0;
          opacity: 0.8;
        }
        
        .change-id {
          font-size: 10px;
          color: var(--vscode-descriptionForeground);
          font-family: var(--vscode-editor-font-family);
          opacity: 0.7;
          flex-shrink: 0;
          margin-right: 8px;
        }
        
        .workspace-tag {
          background: var(--vscode-badge-background);
          color: var(--vscode-badge-foreground);
          padding: 2px 6px;
          border-radius: 2px;
          font-size: 10px;
          font-family: var(--vscode-editor-font-family);
          flex-shrink: 0;
        }
        
        /* Tab 样式 */
        .tabs-container {
          display: flex;
          gap: 4px;
          padding: 8px 8px 4px;
          flex-wrap: wrap;
          border-bottom: 1px solid var(--vscode-panel-border);
        }
        
        .tab {
          padding: 6px 10px;
          background: transparent;
          color: var(--vscode-foreground);
          border: none;
          border-radius: 4px 4px 0 0;
          cursor: pointer;
          font-size: 12px;
          display: flex;
          align-items: center;
          gap: 6px;
          opacity: 0.7;
          transition: opacity 0.2s, background 0.2s;
          border-bottom: 2px solid transparent;
          position: relative;
        }
        
        /* Tab tooltip */
        .tab[title]:hover::after {
          content: attr(title);
          position: absolute;
          top: calc(100% + 8px);
          left: 50%;
          transform: translateX(-50%);
          padding: 4px 8px;
          background: var(--vscode-editorHoverWidget-background);
          border: 1px solid var(--vscode-editorHoverWidget-border);
          color: var(--vscode-editorHoverWidget-foreground);
          font-size: 11px;
          white-space: nowrap;
          border-radius: 3px;
          z-index: 10000;
          pointer-events: none;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
        }
        
        .tab:hover {
          opacity: 1;
          background: var(--vscode-tab-hoverBackground);
        }
        
        .tab.active {
          opacity: 1;
          background: var(--vscode-tab-activeBackground);
          border-bottom-color: var(--vscode-activityBarBadge-background);
        }
        
        .tab-count {
          background: var(--vscode-badge-background);
          color: var(--vscode-badge-foreground);
          padding: 1px 5px;
          border-radius: 9px;
          font-size: 10px;
          font-weight: 600;
        }
        
        .workspace-content {
          display: none;
        }
        
        .workspace-content.active {
          display: block;
        }
        
        /* 回滚弹窗样式 */
        .modal-overlay {
          display: none;
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0, 0, 0, 0.6);
          z-index: 1000;
          justify-content: center;
          align-items: center;
        }
        
        .modal-overlay.show {
          display: flex;
        }
        
        .modal {
          background: var(--vscode-editor-background);
          border: 1px solid var(--vscode-panel-border);
          border-radius: 6px;
          width: 90%;
          max-width: 520px;
          max-height: 80%;
          overflow: hidden;
          display: flex;
          flex-direction: column;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
        }
        
        .modal-header {
          padding: 14px 16px;
          border-bottom: 1px solid var(--vscode-panel-border);
          display: flex;
          justify-content: space-between;
          align-items: center;
          background: var(--vscode-sideBar-background);
        }
        
        .modal-title {
          display: flex;
          align-items: center;
          gap: 8px;
          margin: 0;
          font-size: 13px;
          font-weight: 600;
        }
        
        .modal-close {
          background: none;
          border: none;
          color: var(--vscode-foreground);
          cursor: pointer;
          opacity: 0.7;
          padding: 4px;
          border-radius: 4px;
          display: flex;
          align-items: center;
          transition: opacity 0.2s, background 0.2s;
        }
        
        .modal-close:hover {
          opacity: 1;
          background: var(--vscode-toolbar-hoverBackground);
        }
        
        .modal-body {
          padding: 16px;
          overflow-y: auto;
          flex: 1;
        }
        
        .rollback-info {
          background: var(--vscode-inputValidation-warningBackground);
          border-left: 3px solid var(--vscode-inputValidation-warningBorder);
          padding: 12px;
          border-radius: 4px;
          margin-bottom: 16px;
          font-size: 12px;
          line-height: 1.6;
        }
        
        .rollback-info strong {
          color: var(--vscode-foreground);
          font-weight: 600;
        }
        
        .rollback-chain {
          position: relative;
          padding-left: 24px;
        }
        
        .rollback-chain::before {
          content: '';
          position: absolute;
          left: 8px;
          top: 8px;
          bottom: 8px;
          width: 2px;
          background: var(--vscode-panel-border);
        }
        
        .chain-item {
          position: relative;
          padding: 10px 12px;
          margin-bottom: 6px;
          background: var(--vscode-input-background);
          border: 1px solid var(--vscode-input-border);
          border-radius: 4px;
          display: flex;
          align-items: center;
          gap: 10px;
          transition: background 0.15s, border-color 0.15s;
          cursor: pointer;
        }
        
        .chain-item:hover {
          background: var(--vscode-list-hoverBackground);
          border-color: var(--vscode-focusBorder);
        }
        
        .chain-item::before {
          content: '';
          position: absolute;
          left: -18px;
          top: 50%;
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: var(--vscode-descriptionForeground);
          transform: translateY(-50%);
          border: 2px solid var(--vscode-editor-background);
        }
        
        .chain-item.target::before {
          background: var(--vscode-errorForeground, #f48771);
          width: 10px;
          height: 10px;
        }
        
        
        .chain-item-info {
          flex: 1;
        }
        
        .chain-item-id {
          font-size: 10px;
          color: var(--vscode-descriptionForeground);
        }
        
        .chain-item-time {
          font-size: 11px;
          color: var(--vscode-descriptionForeground);
        }
        
        .chain-item-stats {
          font-family: monospace;
          font-size: 11px;
        }
        
        .modal-footer {
          padding: 12px 16px;
          border-top: 1px solid var(--vscode-panel-border);
          display: flex;
          justify-content: flex-end;
          gap: 8px;
          background: var(--vscode-sideBar-background);
        }
        
        .modal-btn {
          padding: 6px 14px;
          border: none;
          border-radius: 2px;
          cursor: pointer;
          font-size: 13px;
          transition: background 0.15s;
        }
        
        .modal-btn-cancel {
          background: var(--vscode-button-secondaryBackground);
          color: var(--vscode-button-secondaryForeground);
        }
        
        .modal-btn-cancel:hover {
          background: var(--vscode-button-secondaryHoverBackground);
        }
        
        .modal-btn-confirm {
          background: var(--vscode-button-background);
          color: var(--vscode-button-foreground);
        }
        
        .modal-btn-confirm:hover {
          background: var(--vscode-button-hoverBackground);
        }
        
        /* 回滚信息图标 */
        .rollback-info-icon {
          color: var(--vscode-descriptionForeground);
          margin-left: 6px;
          cursor: help;
          opacity: 0.7;
          transition: opacity 0.2s;
        }
        
        .rollback-info-icon:hover {
          opacity: 1;
        }
        
        /* Tooltip 容器 */
        .rollback-tooltip {
          position: fixed;
          background: var(--vscode-editorHoverWidget-background);
          border: 1px solid var(--vscode-editorHoverWidget-border);
          color: var(--vscode-editorHoverWidget-foreground);
          padding: 8px 12px;
          border-radius: 4px;
          font-size: 11px;
          white-space: pre-line;
          z-index: 1000;
          pointer-events: none;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
          max-width: 300px;
          display: none;
        }
        
        .rollback-tooltip.show {
          display: block;
        }
        
        /* 批量选择样式 */
        .group-checkbox,
        .file-checkbox {
          appearance: none;
          -webkit-appearance: none;
          margin-right: 8px;
          cursor: pointer;
          width: 14px;
          height: 14px;
          flex-shrink: 0;
          border: 1px solid var(--vscode-checkbox-border, var(--vscode-foreground));
          border-radius: 3px;
          background: transparent;
          position: relative;
          opacity: 0.7;
          transition: opacity 0.15s, border-color 0.15s;
        }
        
        .group-checkbox:hover,
        .file-checkbox:hover {
          opacity: 1;
          border-color: var(--vscode-focusBorder);
        }
        
        .group-checkbox:checked,
        .file-checkbox:checked {
          background: var(--vscode-checkbox-background, var(--vscode-button-background));
          border-color: var(--vscode-checkbox-background, var(--vscode-button-background));
          opacity: 1;
        }
        
        .group-checkbox:checked::after,
        .file-checkbox:checked::after {
          content: '';
          position: absolute;
          left: 4px;
          top: 1px;
          width: 4px;
          height: 8px;
          border: solid var(--vscode-checkbox-foreground, #fff);
          border-width: 0 2px 2px 0;
          transform: rotate(45deg);
        }
        
        .group-checkbox {
          margin-left: 4px;
        }
        
        /* 半选状态 */
        .group-checkbox:indeterminate {
          opacity: 1;
          background: var(--vscode-checkbox-background, var(--vscode-button-background));
          border-color: var(--vscode-checkbox-background, var(--vscode-button-background));
        }
        
        .group-checkbox:indeterminate::after {
          content: '';
          position: absolute;
          left: 3px;
          top: 5px;
          width: 6px;
          height: 2px;
          background: var(--vscode-checkbox-foreground, #fff);
        }
        
        /* 选中行高亮 */
        .file-row.selected {
          background: rgba(14, 99, 156, 0.2);
        }
        
        /* 批量回滚按钮 */
        .batch-rollback-btn {
          color: var(--vscode-errorForeground, #f48771) !important;
        }
        
        .batch-rollback-btn:hover {
          background: var(--vscode-inputValidation-errorBackground, rgba(244, 135, 113, 0.15)) !important;
        }
        
        .batch-count {
          margin-left: 4px;
          font-weight: 600;
        }
        
      </style>
    </head>
    <body>
      <div class="header">
        <div class="header-title">
          <i class="codicon codicon-history"></i>
          <span>${vscode.l10n.t('Change History')}</span>
        </div>
        <div style="display: flex; gap: 4px;">
          <button id="batchRollbackBtn" class="refresh-btn batch-rollback-btn" onclick="batchRollback()" title="${vscode.l10n.t('Batch Rollback')}" style="display: none;">
            <i class="codicon codicon-discard"></i>
            <span class="batch-count">0</span>
          </button>
          <button class="refresh-btn" onclick="clearHistory()" title="${vscode.l10n.t('Clear History')}">
            <i class="codicon codicon-trash"></i>
          </button>
          <button class="refresh-btn" onclick="openSettings()" title="${vscode.l10n.t('Settings')}">
            <i class="codicon codicon-settings-gear"></i>
          </button>
        </div>
      </div>
      
      ${showTabs ? `
        <div class="tabs-container">
          <button class="tab active" onclick="switchTab('all')" title="显示所有工作区的变更记录">
            <i class="codicon codicon-list-tree"></i>
            <span>全部</span>
            <span class="tab-count">${allChanges.length}</span>
          </button>
          ${workspaces.map(ws => `
            <button class="tab" onclick="switchTab('${this.escapeHtml(ws.name)}')" title="显示 ${this.escapeHtml(ws.name)} 的变更记录">
              <i class="codicon codicon-folder"></i>
              <span>${this.escapeHtml(ws.name)}</span>
              <span class="tab-count">${ws.totalChanges}</span>
            </button>
          `).join('')}
        </div>
      ` : ''}
      
      <div class="content-area">
      
      ${groups.length === 0 ? `
        <div class="empty">
          <div class="empty-icon"><i class="codicon codicon-inbox"></i></div>
          <p>暂无变更记录</p>
          <p>当你编辑代码时，变更会自动记录在这里</p>
        </div>
      ` : groups.map((group, index) => {
        // 获取这个分组涉及的工作区
        const wsNames = [...new Set(group.changes.map((c: any) => c.workspaceName))];
        return `
        <div class="group ${index > 2 ? 'collapsed' : ''}" data-group="${index}" data-workspaces="${wsNames.join(',')}">
          <div class="group-header" onclick="toggleGroup(${index})">
            ${group.changes.some((c: any) => !c.covered_by_rollback_id && c.operation_type !== 'rollback' && !c.isRollbackTarget) ? `
              <input type="checkbox" class="group-checkbox" 
                data-group-index="${index}"
                onchange="toggleGroupSelection(this, ${index})"
                onclick="event.stopPropagation()"
                title="全选/取消本组">
            ` : ''}
            <i class="codicon codicon-chevron-down toggle-icon"></i>
            <div class="group-time">
              <span>${group.timeLabel}</span>
              <span class="group-time-detail">${group.timeDetail}</span>
            </div>
            ${group.isBatch ? `<span class="batch-badge"><i class="codicon codicon-multiple-windows"></i></span>` : ''}
            <span class="group-summary">${group.changes.length} 个文件</span>
            <span class="group-stats">
              <span class="added">+${group.totalAdded}</span>
              <span class="removed">-${group.totalRemoved}</span>
            </span>
          </div>
          <div class="group-content">
            ${group.changes.map((change: any) => {
              // 生成 tooltip 内容和 ID 列表（包含 workspaceName 以区分不同工作区）
              let tooltipContent = '';
              let rollbackedIds = '';
              if (change.operation_type === 'rollback' && change.rollbackedRecords && change.rollbackedRecords.length > 0) {
                tooltipContent = `回滚了 ${change.rollbackedRecords.length} 条记录:\n` +
                  change.rollbackedRecords.map((r: any) => `#${r.id} (+${r.lines_added}/-${r.lines_removed})`).join('\n');
                // 格式: workspaceName:id,workspaceName:id
                rollbackedIds = change.rollbackedRecords.map((r: any) => `${change.workspaceName}:${r.id}`).join(',');
              }
              
              // 配置：判断是否可选择（可回滚的记录）
              const isSelectable = !change.covered_by_rollback_id && change.operation_type !== 'rollback' && !change.isRollbackTarget;
              
              return `
              <div class="file-row ${change.covered_by_rollback_id ? 'rolled-back' : ''}" data-workspace="${change.workspaceName}" data-change-id="${change.id}" data-selectable="${isSelectable}">
                ${isSelectable ? `
                  <input type="checkbox" class="file-checkbox" 
                    data-change-id="${change.id}"
                    data-group-index="${index}"
                    onchange="toggleFileSelection(this, ${change.id}, ${index})">
                ` : ''}
                <span class="change-id">#${change.id}</span>
                ${this.workspaceInstances.size > 1 ? `<span class="workspace-tag">${change.workspaceName}</span>` : ''}
                <div class="file-info">
                  <i class="codicon codicon-file file-icon"></i>
                  <span class="file-path" title="${this.escapeHtml(change.file_path)}">${this.escapeHtml(change.file_path)}</span>
                  ${change.operation_type === 'rollback' && tooltipContent ? `
                    <i class="codicon codicon-info rollback-info-icon" 
                       data-tooltip="${this.escapeHtml(tooltipContent)}"
                       data-rollbacked-ids="${rollbackedIds}"
                       onmouseenter="highlightRollbackedRecords(this)"
                       onmouseleave="clearHighlightRollbackedRecords()"></i>
                  ` : ''}
                </div>
                <span class="file-stats">
                  <span class="added">+${change.lines_added}</span>
                  <span class="removed">-${change.lines_removed}</span>
                </span>
                <div class="file-actions">
                  <button class="btn" onclick="viewDiff(this, ${change.id})" title="查看差异">
                    <i class="codicon codicon-diff"></i>
                  </button>
                  ${change.canRestore ? `
                    <button class="btn" onclick="restore(this, ${change.id})" title="恢复回滚">
                      <i class="codicon codicon-debug-restart"></i>
                    </button>
                  ` : !change.covered_by_rollback_id && change.operation_type !== 'rollback' && !change.isRollbackTarget ? `
                    <button class="btn btn-danger" onclick="rollback(this, ${change.id})" title="回滚到此版本">
                      <i class="codicon codicon-discard"></i>
                    </button>
                  ` : ''}
                </div>
              </div>
              `;
            }).join('')}
          </div>
        </div>
      `}).join('')}
      </div>
      
      <!-- Tooltip -->
      <div class="rollback-tooltip" id="rollbackTooltip"></div>
      
      <!-- 回滚弹窗 -->
      <div class="modal-overlay" id="rollbackModal">
        <div class="modal">
          <div class="modal-header">
            <h3 class="modal-title">
              <i class="codicon codicon-warning"></i>
              <span>回滚确认</span>
            </h3>
            <button class="modal-close" onclick="closeModal()" title="关闭">
              <i class="codicon codicon-close"></i>
            </button>
          </div>
          <div class="modal-body">
            <div class="rollback-info" id="rollbackInfo"></div>
            <div class="rollback-chain" id="rollbackChain"></div>
          </div>
          <div class="modal-footer">
            <button class="modal-btn modal-btn-cancel" onclick="closeModal()">取消</button>
            <button class="modal-btn modal-btn-confirm" onclick="confirmRollback()">确认回滚</button>
          </div>
        </div>
      </div>
      
      <script>
        const vscode = acquireVsCodeApi();
        let currentTab = 'all';
        let rollbackData = null;
        
        // 配置：CSS 选择器常量（必须在 selectionState 之前定义）
        const SELECTORS = {
          FILE_ROW: '.file-row',
          GROUP: '.group',
          GROUP_HEADER: '.group-header',
          HIGHLIGHT_CLASS: 'highlight-rollbacked',
          TOOLTIP: '#rollbackTooltip',
          MODAL: '#rollbackModal'
        };
        
        // 配置：批量选择状态管理
        // 使用 workspace:changeId 组合作为唯一标识，避免不同工作区相同 ID 冲突
        const selectionState = {
          selectedKeys: new Set(),  // 当前选中的 workspace:changeId 集合
          
          // 生成唯一标识
          makeKey(workspace, changeId) {
            return workspace + ':' + changeId;
          },
          
          // 添加选中
          add(workspace, changeId) {
            this.selectedKeys.add(this.makeKey(workspace, changeId));
            this.updateUI();
          },
          
          // 移除选中
          remove(workspace, changeId) {
            this.selectedKeys.delete(this.makeKey(workspace, changeId));
            this.updateUI();
          },
          
          // 批量添加
          addMultiple(items) {
            items.forEach(item => this.selectedKeys.add(this.makeKey(item.workspace, item.changeId)));
            this.updateUI();
          },
          
          // 批量移除
          removeMultiple(items) {
            items.forEach(item => this.selectedKeys.delete(this.makeKey(item.workspace, item.changeId)));
            this.updateUI();
          },
          
          // 清空选中
          clear() {
            this.selectedKeys.clear();
            this.updateUI();
          },
          
          // 获取选中数量
          count() {
            return this.selectedKeys.size;
          },
          
          // 判断是否选中
          has(workspace, changeId) {
            return this.selectedKeys.has(this.makeKey(workspace, changeId));
          },
          
          // 获取所有选中项（解析为 workspace 和 changeId）
          getAll() {
            const result = [];
            this.selectedKeys.forEach(key => {
              const [workspace, changeId] = key.split(':');
              result.push({ workspace, changeId: parseInt(changeId) });
            });
            return result;
          },
          
          // 更新 UI 显示
          updateUI() {
            // 1. 更新批量回滚按钮显示
            const batchBtn = document.getElementById('batchRollbackBtn');
            if (batchBtn) {
              if (this.count() > 0) {
                batchBtn.style.display = 'flex';
                const countSpan = batchBtn.querySelector('.batch-count');
                if (countSpan) {
                  countSpan.textContent = this.count();
                }
              } else {
                batchBtn.style.display = 'none';
              }
            }
            
            // 2. 更新文件行的选中样式
            document.querySelectorAll(SELECTORS.FILE_ROW).forEach(row => {
              const workspace = row.getAttribute('data-workspace');
              const changeId = parseInt(row.getAttribute('data-change-id'));
              if (this.has(workspace, changeId)) {
                row.classList.add('selected');
              } else {
                row.classList.remove('selected');
              }
            });
            
            // 3. 更新所有组的 checkbox 状态（checked/indeterminate/unchecked）
            document.querySelectorAll('.group-checkbox').forEach(groupCheckbox => {
              const groupIndex = parseInt(groupCheckbox.getAttribute('data-group-index'));
              this.updateGroupCheckboxState(groupIndex);
            });
          },
          
          // 更新组 checkbox 的状态（全选、半选、未选）
          updateGroupCheckboxState(groupIndex) {
            const groupCheckbox = document.querySelector('.group-checkbox[data-group-index="' + groupIndex + '"]');
            if (!groupCheckbox) { return; }
            
            // 获取该组内所有可选择的文件
            const group = document.querySelector('[data-group="' + groupIndex + '"]');
            if (!group) { return; }
            
            const selectableRows = Array.from(group.querySelectorAll(SELECTORS.FILE_ROW + '[data-selectable="true"]'));
            const selectedCount = selectableRows.filter(row => {
              const workspace = row.getAttribute('data-workspace');
              const changeId = parseInt(row.getAttribute('data-change-id'));
              return this.has(workspace, changeId);
            }).length;
            
            if (selectedCount === 0) {
              // 未选：unchecked
              groupCheckbox.checked = false;
              groupCheckbox.indeterminate = false;
            } else if (selectedCount === selectableRows.length && selectableRows.length > 0) {
              // 全选：checked
              groupCheckbox.checked = true;
              groupCheckbox.indeterminate = false;
            } else {
              // 半选：indeterminate
              groupCheckbox.checked = false;
              groupCheckbox.indeterminate = true;
            }
          }
        };
        
        // 配置：切换单个文件的选中状态
        function toggleFileSelection(checkbox, changeId, groupIndex) {
          const row = checkbox.closest(SELECTORS.FILE_ROW);
          const workspace = row ? row.getAttribute('data-workspace') : '';
          if (checkbox.checked) {
            selectionState.add(workspace, changeId);
          } else {
            selectionState.remove(workspace, changeId);
          }
        }
        
        // 配置：切换组的全选/取消全选
        function toggleGroupSelection(groupCheckbox, groupIndex) {
          const group = document.querySelector('[data-group="' + groupIndex + '"]');
          if (!group) { return; }
          
          // 获取该组内所有可选择的文件（同时获取 workspace 和 changeId）
          const selector = SELECTORS.FILE_ROW + '[data-selectable="true"]';
          const selectableRows = Array.from(group.querySelectorAll(selector));
          const items = selectableRows.map(row => ({
            workspace: row.getAttribute('data-workspace'),
            changeId: parseInt(row.getAttribute('data-change-id'))
          }));
          
          if (groupCheckbox.checked) {
            // 全选
            selectionState.addMultiple(items);
            selectableRows.forEach(row => {
              const checkbox = row.querySelector('.file-checkbox');
              if (checkbox) { checkbox.checked = true; }
            });
          } else {
            // 取消全选
            selectionState.removeMultiple(items);
            selectableRows.forEach(row => {
              const checkbox = row.querySelector('.file-checkbox');
              if (checkbox) { checkbox.checked = false; }
            });
          }
        }
        
        // 配置：执行批量回滚
        function batchRollback() {
          if (selectionState.count() === 0) {
            return;
          }
          // 从 selectionState 获取所有选中项
          const items = selectionState.getAll();
          const changeIds = items.map(item => item.changeId);
          const workspaceNames = items.map(item => item.workspace);
          
          vscode.postMessage({
            type: 'batchRollback',
            changeIds,
            workspaceNames
          });
          selectionState.clear();
        }
        
        // 监听来自扩展的消息
        window.addEventListener('message', event => {
          const message = event.data;
          if (message.type === 'showRollbackModal') {
            showRollbackModal(message.targetChange, message.laterChanges, message.workspaceName);
          }
        });
        
        function toggleGroup(index) {
          const group = document.querySelector('[data-group="' + index + '"]');
          if (group) {
            group.classList.toggle('collapsed');
          }
        }
        
        function rollback(btn, changeId) {
          const row = btn.closest(SELECTORS.FILE_ROW);
          const workspaceName = row ? row.getAttribute('data-workspace') : null;
          vscode.postMessage({ type: 'rollback', changeId, workspaceName });
        }
        
        function restore(btn, changeId) {
          const row = btn.closest(SELECTORS.FILE_ROW);
          const workspaceName = row ? row.getAttribute('data-workspace') : null;
          vscode.postMessage({ type: 'restore', changeId, workspaceName });
        }
        
        function viewDiff(btn, changeId) {
          const row = btn.closest(SELECTORS.FILE_ROW);
          const workspaceName = row ? row.getAttribute('data-workspace') : null;
          vscode.postMessage({ type: 'viewDiff', changeId, workspaceName });
        }
        
        // 从弹窗中调用，使用 rollbackData 中的 workspaceName
        function viewDiffDirect(changeId) {
          const workspaceName = rollbackData ? rollbackData.workspaceName : null;
          vscode.postMessage({ type: 'viewDiff', changeId, workspaceName });
        }
        
        function clearHistory() {
          vscode.postMessage({ type: 'clearHistory' });
        }
        
        function openSettings() {
          vscode.postMessage({ type: 'openSettings' });
        }
        
        // 配置驱动：hover 图标时高亮被回滚的记录 + 显示 tooltip
        function highlightRollbackedRecords(iconElement, event) {
          const rollbackedIds = iconElement.getAttribute('data-rollbacked-ids');
          const tooltipText = iconElement.getAttribute('data-tooltip');
          
          // 1. 显示 tooltip
          if (tooltipText) {
            const tooltip = document.querySelector(SELECTORS.TOOLTIP);
            tooltip.textContent = tooltipText;
            tooltip.classList.add('show');
            
            // 定位 tooltip
            const rect = iconElement.getBoundingClientRect();
            tooltip.style.left = rect.left + 'px';
            tooltip.style.top = (rect.top - tooltip.offsetHeight - 8) + 'px';
          }
          
          // 2. 高亮被回滚的记录 + 它们所在的分组头部
          if (rollbackedIds) {
            const items = rollbackedIds.split(',');
            const highlightedGroups = new Set();  // 记录已高亮的分组
            
            items.forEach(item => {
              // 格式: workspaceName:id
              const [workspace, id] = item.split(':');
              // 同时匹配 workspace 和 changeId
              const row = document.querySelector(SELECTORS.FILE_ROW + '[data-workspace="' + workspace + '"][data-change-id="' + id + '"]');
              if (row) {
                // 高亮记录
                row.classList.add(SELECTORS.HIGHLIGHT_CLASS);
                
                // 找到这个 row 所在的 group 并高亮其 header
                const group = row.closest(SELECTORS.GROUP);
                if (group && !highlightedGroups.has(group)) {
                  const header = group.querySelector(SELECTORS.GROUP_HEADER);
                  if (header) {
                    header.classList.add(SELECTORS.HIGHLIGHT_CLASS);
                    highlightedGroups.add(group);
                  }
                }
              }
            });
          }
        }
        
        function clearHighlightRollbackedRecords() {
          // 隐藏 tooltip
          const tooltip = document.querySelector(SELECTORS.TOOLTIP);
          tooltip.classList.remove('show');
          
          // 移除所有高亮样式（记录 + 分组头部）
          document.querySelectorAll(SELECTORS.FILE_ROW + '.' + SELECTORS.HIGHLIGHT_CLASS).forEach(row => {
            row.classList.remove(SELECTORS.HIGHLIGHT_CLASS);
          });
          document.querySelectorAll(SELECTORS.GROUP_HEADER + '.' + SELECTORS.HIGHLIGHT_CLASS).forEach(header => {
            header.classList.remove(SELECTORS.HIGHLIGHT_CLASS);
          });
        }
        
        function switchTab(tabName) {
          currentTab = tabName;
          
          document.querySelectorAll('.tab').forEach(tab => {
            tab.classList.remove('active');
          });
          event.target.closest('.tab').classList.add('active');
          
          document.querySelectorAll('.group').forEach(group => {
            if (tabName === 'all') {
              group.style.display = '';
            } else {
              const workspaces = group.getAttribute('data-workspaces') || '';
              if (workspaces.split(',').includes(tabName)) {
                group.style.display = '';
              } else {
                group.style.display = 'none';
              }
            }
          });
          
          document.querySelectorAll('.file-row').forEach(row => {
            if (tabName === 'all') {
              row.style.display = '';
            } else {
              const ws = row.getAttribute('data-workspace');
              if (ws === tabName) {
                row.style.display = '';
              } else {
                row.style.display = 'none';
              }
            }
          });
        }
        
        function showRollbackModal(targetChange, laterChanges, workspaceName) {
          rollbackData = { targetChange, laterChanges, workspaceName };
          
          // 找到目标记录的索引
          const targetIndex = laterChanges.findIndex(c => c.id === targetChange.id);
          
          // 显示文件信息
          document.getElementById('rollbackInfo').innerHTML = 
            '文件: <strong>' + targetChange.file_path + '</strong><br>' +
            '回滚到: <strong>#' + targetChange.id + '</strong> (' + new Date(targetChange.timestamp).toLocaleString('zh-CN') + ')<br>' +
            '将被回滚的变更: <strong>' + targetIndex + '</strong> 次';
          
          // 生成链路图（从新到旧，可点击查看 diff）
          const chainHtml = laterChanges.map((change, index) => {
            const isTarget = change.id === targetChange.id;
            const time = new Date(change.timestamp).toLocaleString('zh-CN', {
              month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
            });
            return '<div class="chain-item ' + (isTarget ? 'target' : '') + '" onclick="viewDiffDirect(' + change.id + ')" title="点击查看差异">' +
              '<div class="chain-item-info">' +
                '<div class="chain-item-id">#' + change.id + (isTarget ? ' <span style="color: var(--vscode-errorForeground);">(回滚目标)</span>' : '') + '</div>' +
                '<div class="chain-item-time">' + time + '</div>' +
              '</div>' +
              '<div class="chain-item-stats">' +
                '<span class="added">+' + change.lines_added + '</span> ' +
                '<span class="removed">-' + change.lines_removed + '</span>' +
              '</div>' +
            '</div>';
          }).join('');
          
          document.getElementById('rollbackChain').innerHTML = chainHtml;
          document.getElementById('rollbackModal').classList.add('show');
        }
        
        function closeModal() {
          document.getElementById('rollbackModal').classList.remove('show');
          rollbackData = null;
        }
        
        function confirmRollback() {
          if (!rollbackData) {
            return;
          }
          
          // 传递目标记录ID和工作区名称
          vscode.postMessage({ 
            type: 'confirmRollback', 
            targetChangeId: rollbackData.targetChange.id,
            workspaceName: rollbackData.workspaceName
          });
          closeModal();
        }
        
      </script>
    </body>
    </html>`;
  }

  private groupChangesByTime(changes: CodeChange[]) {
    const groups: Array<{
      timeLabel: string;
      timeDetail: string;
      changes: CodeChange[];
      totalAdded: number;
      totalRemoved: number;
      isBatch: boolean;
    }> = [];

    // 先按batch_id分组
    const batchMap = new Map<string, CodeChange[]>();
    const noBatchChanges: CodeChange[] = [];

    for (const change of changes) {
      if (change.batch_id) {
        if (!batchMap.has(change.batch_id)) {
          batchMap.set(change.batch_id, []);
        }
        batchMap.get(change.batch_id)!.push(change);
      } else {
        noBatchChanges.push(change);
      }
    }

    // 处理批次组
    for (const [, batchChanges] of batchMap) {
      const firstChange = batchChanges[0];
      const { label, detail } = this.getTimeBucket(firstChange.timestamp);
      groups.push({
        timeLabel: label,
        timeDetail: detail,
        changes: batchChanges,
        totalAdded: batchChanges.reduce((sum, c) => sum + c.lines_added, 0),
        totalRemoved: batchChanges.reduce((sum, c) => sum + c.lines_removed, 0),
        isBatch: true
      });
    }

    // 处理无批次的变更(按时间分组)
    let currentGroup: any = null;
    let currentTimeBucket = '';

    for (const change of noBatchChanges) {
      const { label, detail } = this.getTimeBucket(change.timestamp);

      if (label !== currentTimeBucket) {
        currentTimeBucket = label;
        currentGroup = {
          timeLabel: label,
          timeDetail: detail,
          changes: [],
          totalAdded: 0,
          totalRemoved: 0,
          isBatch: false
        };
        groups.push(currentGroup);
      }

      currentGroup.changes.push(change);
      currentGroup.totalAdded += change.lines_added;
      currentGroup.totalRemoved += change.lines_removed;
    }

    // 按时间排序(最新的在前)
    groups.sort((a, b) => {
      const timeA = new Date(a.changes[0].timestamp).getTime();
      const timeB = new Date(b.changes[0].timestamp).getTime();
      return timeB - timeA;
    });

    return groups;
  }

  private getTimeBucket(isoString: string): { label: string; detail: string } {
    const date = new Date(isoString);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / 60000);
    
    // 详细时间（时:分:秒）
    const timeDetail = date.toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });

    let label: string;
    if (minutes < 5) {
      label = '刚才';
    } else if (minutes < 30) {
      label = `${Math.floor(minutes / 5) * 5}分钟前`;
    } else if (minutes < 120) {
      label = `${Math.floor(minutes / 30) * 30}分钟前`;
    } else {
      const hours = Math.floor(minutes / 60);
      if (hours < 24) {
        label = `${hours}小时前`;
      } else {
        const days = Math.floor(hours / 24);
        if (days === 1) {
          label = '昨天';
        } else if (days < 7) {
          label = `${days}天前`;
        } else {
          label = date.toLocaleDateString('zh-CN', {
            month: '2-digit',
            day: '2-digit'
          });
        }
      }
    }
    
    return { label, detail: timeDetail };
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;')
      .replace(/\n/g, '&#10;');
  }
}
