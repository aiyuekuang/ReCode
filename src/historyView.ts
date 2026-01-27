import * as vscode from 'vscode';
import { CodeTimeDB, CodeChange } from './database';
import * as path from 'path';
import * as fs from 'fs';

interface WorkspaceInstance {
  db: CodeTimeDB;
  watcher: any;
}

export class HistoryViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'codetimedb.historyView';
  private _view?: vscode.WebviewView;
  private workspaceInstances: Map<string, WorkspaceInstance>;

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
          await this.handleRollback(data.changeId);
          break;
        case 'confirmRollback':
          await this.executeRollback(data.changeIds);
          break;
        case 'restore':
          await this.handleRestore(data.changeId);
          break;
        case 'viewDiff':
          await this.handleViewDiff(data.changeId);
          break;
        case 'refresh':
          this.refresh();
          break;
      }
    });
  }

  public refresh() {
    if (this._view) {
      this._view.webview.html = this._getHtmlForWebview(this._view.webview);
    }
  }

  /**
   * 在所有工作区中查找变更记录
   */
  private findChange(changeId: number): { change: CodeChange; db: CodeTimeDB; root: string } | null {
    for (const [root, instance] of this.workspaceInstances) {
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

  private async handleRollback(changeId: number) {
    const result = this.findChange(changeId);
    if (!result) {
      vscode.window.showErrorMessage(`找不到变更记录 #${changeId}`);
      return;
    }

    const { change, db, root } = result;
    
    // 查找该文件在此之后的所有修改
    const allChanges = db.getChangesByFile(change.file_path, 100);
    const laterChanges = allChanges.filter(c => c.id >= changeId);
    
    // 通知webview显示回滚链路弹窗
    if (this._view) {
      this._view.webview.postMessage({
        type: 'showRollbackModal',
        targetChange: change,
        laterChanges: laterChanges.reverse(), // 按时间正序
        targetRoot: root
      });
    }
  }

  private async executeRollback(changeIds: number[]) {
    if (changeIds.length === 0) return;

    const targetChangeId = Math.min(...changeIds);
    const result = this.findChange(targetChangeId);
    
    if (!result) {
      vscode.window.showErrorMessage(`找不到变更记录`);
      return;
    }

    const { change, root } = result;

    try {
      const filePath = path.join(root, change.file_path);
      const fileExisted = fs.existsSync(filePath);
      
      this.writeFileContent(filePath, change.old_content);
      
      const message = fileExisted 
        ? `✅ 已回滚 ${change.file_path}`
        : `✅ 已恢复已删除的文件 ${change.file_path}`;
      vscode.window.showInformationMessage(message);
      
      setTimeout(() => this.refresh(), 500);
    } catch (error) {
      vscode.window.showErrorMessage(`回滚失败: ${error}`);
    }
  }

  private async handleRestore(changeId: number) {
    const result = this.findChange(changeId);
    
    if (!result) {
      vscode.window.showErrorMessage(`找不到变更记录 #${changeId}`);
      return;
    }

    const { change, root } = result;

    try {
      const filePath = path.join(root, change.file_path);
      const fileExisted = fs.existsSync(filePath);
      
      this.writeFileContent(filePath, change.old_content);
      
      const message = fileExisted 
        ? `✅ 已恢复 ${change.file_path}`
        : `✅ 已恢复已删除的文件 ${change.file_path}`;
      vscode.window.showInformationMessage(message);
      
      setTimeout(() => this.refresh(), 500);
    } catch (error) {
      vscode.window.showErrorMessage(`恢复失败: ${error}`);
    }
  }

  private async handleViewDiff(changeId: number) {
    const result = this.findChange(changeId);
    if (!result) {
      vscode.window.showErrorMessage(`找不到变更记录 #${changeId}`);
      return;
    }

    const { change } = result;

    // 创建临时文件来显示diff
    const oldUri = vscode.Uri.parse(`codetimedb-old:${change.file_path}?id=${changeId}`);
    const newUri = vscode.Uri.parse(`codetimedb-new:${change.file_path}?id=${changeId}`);

    // 注册内容提供器
    const capturedChange = change; // 捕获引用避免闭包问题
    
    const oldDisposable = vscode.workspace.registerTextDocumentContentProvider('codetimedb-old', {
      provideTextDocumentContent: () => capturedChange.old_content
    });

    const newDisposable = vscode.workspace.registerTextDocumentContentProvider('codetimedb-new', {
      provideTextDocumentContent: () => capturedChange.new_content
    });

    // 打开diff视图
    await vscode.commands.executeCommand(
      'vscode.diff',
      oldUri,
      newUri,
      `变更 #${changeId}: ${change.file_path}`
    );

    // 清理
    setTimeout(() => {
      oldDisposable.dispose();
      newDisposable.dispose();
    }, 100);
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
    // 收集所有工作区信息
    const workspaces: Array<{
      name: string;
      root: string;
      changes: Array<CodeChange & { workspaceName: string }>;
      totalChanges: number;
    }> = [];

    const allChanges: Array<CodeChange & { workspaceName: string; isLatestForFile: boolean }> = [];
    
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
      
      const wsChanges = changes.map(change => ({
        ...change,
        workspaceName,
        isLatestForFile: latestIdByFile.get(change.file_path) === change.id
      }));
      
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
    const codiconUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode/codicons', 'dist', 'codicon.css')
    );

    return `<!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'unsafe-inline';">
      <title>CodeTimeDB History</title>
      <link href="${codiconUri}" rel="stylesheet" />
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
        }
        
        .refresh-btn:hover {
          background: var(--vscode-toolbar-hoverBackground);
          opacity: 1;
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
          transition: background 0.1s;
        }
        
        .file-row:first-child {
          border-top: none;
        }
        
        .file-row:hover {
          background: var(--vscode-list-hoverBackground);
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
        }
        
        .btn:hover {
          background: var(--vscode-button-secondaryHoverBackground);
        }
        
        .btn-danger {
          color: var(--vscode-errorForeground, #f48771);
        }
        
        .btn-danger:hover {
          background: var(--vscode-inputValidation-errorBackground, rgba(244, 135, 113, 0.15));
        }
        
        .btn-restore {
          color: var(--vscode-gitDecoration-addedResourceForeground, #4ec9b0);
        }
        
        .btn-restore:hover {
          background: rgba(78, 201, 176, 0.15);
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
        }
        
        .chain-item:hover {
          background: var(--vscode-list-hoverBackground);
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
        
        .chain-item input[type="checkbox"] {
          margin: 0;
          cursor: pointer;
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
        
        .select-actions {
          margin-bottom: 12px;
          display: flex;
          gap: 6px;
        }
        
        .select-actions button {
          font-size: 11px;
          padding: 4px 10px;
          background: transparent;
          color: var(--vscode-button-secondaryForeground);
          border: 1px solid var(--vscode-button-border, var(--vscode-panel-border));
          border-radius: 2px;
          cursor: pointer;
          transition: background 0.15s;
        }
        
        .select-actions button:hover {
          background: var(--vscode-button-secondaryHoverBackground);
        }
      </style>
    </head>
    <body>
      <div class="header">
        <div class="header-title">
          <i class="codicon codicon-history"></i>
          <span>变更历史</span>
        </div>
        <button class="refresh-btn" onclick="refresh()" title="刷新历史记录">
          <i class="codicon codicon-refresh"></i>
        </button>
      </div>
      
      ${showTabs ? `
        <div class="tabs-container">
          <button class="tab active" onclick="switchTab('all')">
            <i class="codicon codicon-list-tree"></i>
            <span>全部</span>
            <span class="tab-count">${allChanges.length}</span>
          </button>
          ${workspaces.map(ws => `
            <button class="tab" onclick="switchTab('${this.escapeHtml(ws.name)}')">
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
            <i class="codicon codicon-chevron-down toggle-icon"></i>
            <span class="group-time">${group.timeLabel}</span>
            ${group.isBatch ? `<span class="batch-badge"><i class="codicon codicon-multiple-windows"></i>批量</span>` : ''}
            <span class="group-summary">${group.changes.length} 个文件</span>
            <span class="group-stats">
              <span class="added">+${group.totalAdded}</span>
              <span class="removed">-${group.totalRemoved}</span>
            </span>
          </div>
          <div class="group-content">
            ${group.changes.map((change: any) => `
              <div class="file-row" data-workspace="${change.workspaceName}">
                <span class="change-id">#${change.id}</span>
                ${this.workspaceInstances.size > 1 ? `<span class="workspace-tag">${change.workspaceName}</span>` : ''}
                <div class="file-info">
                  <i class="codicon codicon-file file-icon"></i>
                  <span class="file-path" title="${this.escapeHtml(change.file_path)}">${this.escapeHtml(change.file_path)}</span>
                </div>
                <span class="file-stats">
                  <span class="added">+${change.lines_added}</span>
                  <span class="removed">-${change.lines_removed}</span>
                </span>
                <div class="file-actions">
                  <button class="btn" onclick="viewDiff(${change.id})" title="查看差异">
                    <i class="codicon codicon-diff"></i>
                  </button>
                  ${change.isLatestForFile ? `
                    <button class="btn btn-restore" onclick="restore(${change.id})" title="恢复：用此版本替换当前文件">
                      <i class="codicon codicon-debug-restart"></i>
                    </button>
                  ` : ''}
                  <button class="btn btn-danger" onclick="rollback(${change.id})" title="回滚：撤销到此版本之前的状态">
                    <i class="codicon codicon-discard"></i>
                  </button>
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      `}).join('')}
      </div>
      
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
            <div class="select-actions">
              <button onclick="selectAll()">全选</button>
              <button onclick="selectNone()">全不选</button>
            </div>
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
        
        // 监听来自扩展的消息
        window.addEventListener('message', event => {
          const message = event.data;
          if (message.type === 'showRollbackModal') {
            showRollbackModal(message.targetChange, message.laterChanges);
          }
        });
        
        function toggleGroup(index) {
          const group = document.querySelector('[data-group="' + index + '"]');
          if (group) {
            group.classList.toggle('collapsed');
          }
        }
        
        function rollback(changeId) {
          vscode.postMessage({ type: 'rollback', changeId });
        }
        
        function restore(changeId) {
          vscode.postMessage({ type: 'restore', changeId });
        }
        
        function viewDiff(changeId) {
          vscode.postMessage({ type: 'viewDiff', changeId });
        }
        
        function refresh() {
          vscode.postMessage({ type: 'refresh' });
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
        
        function showRollbackModal(targetChange, laterChanges) {
          rollbackData = { targetChange, laterChanges };
          
          // 显示文件信息
          document.getElementById('rollbackInfo').innerHTML = 
            '文件: <strong>' + targetChange.file_path + '</strong><br>' +
            '回滚到: #' + targetChange.id + ' 之前的版本<br>' +
            '影响的变更: ' + laterChanges.length + ' 次';
          
          // 生成链路图
          const chainHtml = laterChanges.map((change, index) => {
            const isTarget = index === 0;
            const time = new Date(change.timestamp).toLocaleString('zh-CN', {
              month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
            });
            return '<div class="chain-item ' + (isTarget ? 'target' : '') + '">' +
              '<input type="checkbox" id="cb_' + change.id + '" value="' + change.id + '" checked>' +
              '<div class="chain-item-info">' +
                '<div class="chain-item-id">#' + change.id + (isTarget ? ' (回滚目标)' : '') + '</div>' +
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
        
        function selectAll() {
          document.querySelectorAll('#rollbackChain input[type="checkbox"]').forEach(cb => {
            cb.checked = true;
          });
        }
        
        function selectNone() {
          document.querySelectorAll('#rollbackChain input[type="checkbox"]').forEach(cb => {
            cb.checked = false;
          });
        }
        
        function confirmRollback() {
          const selectedIds = [];
          document.querySelectorAll('#rollbackChain input[type="checkbox"]:checked').forEach(cb => {
            selectedIds.push(parseInt(cb.value));
          });
          
          if (selectedIds.length === 0) {
            return;
          }
          
          vscode.postMessage({ type: 'confirmRollback', changeIds: selectedIds });
          closeModal();
        }
      </script>
    </body>
    </html>`;
  }

  private groupChangesByTime(changes: CodeChange[]) {
    const groups: Array<{
      timeLabel: string;
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
      groups.push({
        timeLabel: this.getTimeBucket(firstChange.timestamp),
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
      const timeBucket = this.getTimeBucket(change.timestamp);

      if (timeBucket !== currentTimeBucket) {
        currentTimeBucket = timeBucket;
        currentGroup = {
          timeLabel: timeBucket,
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

  private getTimeBucket(isoString: string): string {
    const date = new Date(isoString);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / 60000);

    if (minutes < 5) {
      return '刚才';
    } else if (minutes < 30) {
      return `${Math.floor(minutes / 5) * 5}分钟前`;
    } else if (minutes < 120) {
      return `${Math.floor(minutes / 30) * 30}分钟前`;
    } else {
      const hours = Math.floor(minutes / 60);
      if (hours < 24) {
        return `${hours}小时前`;
      } else {
        const days = Math.floor(hours / 24);
        if (days === 1) {
          return '昨天';
        } else if (days < 7) {
          return `${days}天前`;
        } else {
          return date.toLocaleDateString('zh-CN', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
          });
        }
      }
    }
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}
