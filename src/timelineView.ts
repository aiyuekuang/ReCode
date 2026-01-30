import * as vscode from 'vscode';
import { ReCode, CodeChange } from './database';
import * as path from 'path';

interface WorkspaceInstance {
  db: ReCode;
  watcher: any;
}

/**
 * 时间轴视图面板
 * 配置驱动：通过 recode.timeline.maxNodes 控制最大节点数
 */
export class TimelinePanel {
  public static currentPanel: TimelinePanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];
  
  // 当前显示的文件信息
  private _filePath: string;
  private _workspaceRoot: string;
  private _workspaceInstances: Map<string, WorkspaceInstance>;

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    filePath: string,
    workspaceRoot: string,
    workspaceInstances: Map<string, WorkspaceInstance>
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._filePath = filePath;
    this._workspaceRoot = workspaceRoot;
    this._workspaceInstances = workspaceInstances;

    // 初始化内容
    this._update();

    // 监听面板关闭
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    // 监听消息
    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.type) {
          case 'viewDiff':
            await this._handleViewDiff(message.changeId);
            break;
          case 'viewRangeDiff':
            await this._handleViewRangeDiff(message.fromId, message.toId);
            break;
          case 'rollback':
            await this._handleRollback(message.changeId);
            break;
        }
      },
      null,
      this._disposables
    );
  }

  /**
   * 创建或显示时间轴面板
   */
  public static createOrShow(
    extensionUri: vscode.Uri,
    filePath: string,
    workspaceRoot: string,
    workspaceInstances: Map<string, WorkspaceInstance>
  ) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    // 如果已存在面板，更新内容
    if (TimelinePanel.currentPanel) {
      TimelinePanel.currentPanel._filePath = filePath;
      TimelinePanel.currentPanel._workspaceRoot = workspaceRoot;
      TimelinePanel.currentPanel._update();
      TimelinePanel.currentPanel._panel.reveal(column);
      return;
    }

    // 创建新面板
    const panel = vscode.window.createWebviewPanel(
      'recodeTimeline',
      vscode.l10n.t('Timeline'),
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [extensionUri],
        retainContextWhenHidden: true
      }
    );

    TimelinePanel.currentPanel = new TimelinePanel(
      panel,
      extensionUri,
      filePath,
      workspaceRoot,
      workspaceInstances
    );
  }

  /**
   * 处理查看 Diff
   */
  private async _handleViewDiff(changeId: number) {
    const instance = this._workspaceInstances.get(this._workspaceRoot);
    if (!instance) { return; }

    const change = instance.db.getChangeById(changeId);
    if (!change) { return; }

    const oldUri = vscode.Uri.parse(`recode-old:${change.file_path}?id=${changeId}`);
    const newUri = vscode.Uri.parse(`recode-new:${change.file_path}?id=${changeId}`);

    const oldDisposable = vscode.workspace.registerTextDocumentContentProvider('recode-old', {
      provideTextDocumentContent: () => change.old_content
    });

    const newDisposable = vscode.workspace.registerTextDocumentContentProvider('recode-new', {
      provideTextDocumentContent: () => change.new_content
    });

    await vscode.commands.executeCommand(
      'vscode.diff',
      oldUri,
      newUri,
      vscode.l10n.t('Change #{0}: {1}', changeId, change.file_path)
    );

    setTimeout(() => {
      oldDisposable.dispose();
      newDisposable.dispose();
    }, 100);
  }

  /**
   * 处理范围 Diff（对比两个版本）
   */
  private async _handleViewRangeDiff(fromId: number, toId: number) {
    const instance = this._workspaceInstances.get(this._workspaceRoot);
    if (!instance) { return; }

    const fromChange = instance.db.getChangeById(fromId);
    const toChange = instance.db.getChangeById(toId);
    if (!fromChange || !toChange) { return; }

    // fromChange 的 new_content 是起始版本
    // toChange 的 new_content 是结束版本
    const oldUri = vscode.Uri.parse(`recode-range-old:${fromChange.file_path}?from=${fromId}&to=${toId}`);
    const newUri = vscode.Uri.parse(`recode-range-new:${toChange.file_path}?from=${fromId}&to=${toId}`);

    const oldDisposable = vscode.workspace.registerTextDocumentContentProvider('recode-range-old', {
      provideTextDocumentContent: () => fromChange.new_content
    });

    const newDisposable = vscode.workspace.registerTextDocumentContentProvider('recode-range-new', {
      provideTextDocumentContent: () => toChange.new_content
    });

    await vscode.commands.executeCommand(
      'vscode.diff',
      oldUri,
      newUri,
      `#${fromId} → #${toId}: ${fromChange.file_path}`
    );

    setTimeout(() => {
      oldDisposable.dispose();
      newDisposable.dispose();
    }, 100);
  }

  /**
   * 处理回滚（发送命令到主扩展）
   */
  private async _handleRollback(changeId: number) {
    // 触发 historyView 的回滚流程
    vscode.commands.executeCommand('recode.rollbackFromTimeline', changeId, this._workspaceRoot);
  }

  /**
   * 更新面板内容
   */
  private _update() {
    const webview = this._panel.webview;
    const relativePath = path.relative(this._workspaceRoot, this._filePath);
    this._panel.title = vscode.l10n.t('Timeline: {0}', path.basename(this._filePath));
    webview.html = this._getHtmlForWebview(webview, relativePath);
  }

  /**
   * 生成 Webview HTML
   */
  private _getHtmlForWebview(webview: vscode.Webview, relativePath: string): string {
    const instance = this._workspaceInstances.get(this._workspaceRoot);
    
    // 配置驱动：读取 maxNodes 配置
    const config = vscode.workspace.getConfiguration('recode');
    const maxNodes = config.get<number>('timeline.maxNodes', 100);
    
    const changes: CodeChange[] = instance 
      ? instance.db.getFileTimeline(relativePath, maxNodes)
      : [];

    // 获取 Codicon 字体 URI
    const codiconCssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css')
    );
    const codiconFontUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.ttf')
    );

    // 空状态
    if (changes.length === 0) {
      return this._getEmptyHtml(webview, codiconCssUri, codiconFontUri, relativePath);
    }

    // 计算时间轴布局
    const timelineData = this._calculateTimelineLayout(changes);

    return `<!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource} data:; script-src 'unsafe-inline';">
      <title>${vscode.l10n.t('Timeline')}</title>
      <style>
        @font-face {
          font-family: "codicon";
          font-display: block;
          src: url("${codiconFontUri}") format("truetype");
        }
      </style>
      <link href="${codiconCssUri}" rel="stylesheet" />
      <style>
        * { box-sizing: border-box; }
        
        body {
          padding: 0;
          margin: 0;
          color: var(--vscode-foreground);
          font-family: var(--vscode-font-family);
          font-size: var(--vscode-font-size);
          background: var(--vscode-editor-background);
        }
        
        .header {
          padding: 16px 20px;
          border-bottom: 1px solid var(--vscode-panel-border);
          background: var(--vscode-sideBar-background);
        }
        
        .header-title {
          display: flex;
          align-items: center;
          gap: 10px;
          font-size: 14px;
          font-weight: 600;
          margin-bottom: 4px;
        }
        
        .header-path {
          font-size: 12px;
          color: var(--vscode-descriptionForeground);
          font-family: var(--vscode-editor-font-family);
        }
        
        .timeline-container {
          padding: 24px 20px;
          overflow-x: auto;
        }
        
        .timeline-hint {
          font-size: 11px;
          color: var(--vscode-descriptionForeground);
          margin-bottom: 16px;
          display: flex;
          align-items: center;
          gap: 6px;
        }
        
        .timeline-svg {
          display: block;
          min-width: 100%;
          height: 140px;
        }
        
        .timeline-line {
          stroke: var(--vscode-panel-border);
          stroke-width: 2;
        }
        
        .timeline-node {
          cursor: pointer;
        }
        
        .timeline-node .node-circle {
          stroke: var(--vscode-editor-background);
          stroke-width: 2;
          transition: stroke 0.15s, stroke-width 0.15s;
        }
        
        .timeline-node:hover .node-circle {
          stroke: var(--vscode-focusBorder, #007acc);
          stroke-width: 3;
        }
        
        .timeline-node.selected .node-circle {
          stroke: var(--vscode-focusBorder, #007acc);
          stroke-width: 4;
        }
        
        .node-edit { fill: var(--vscode-gitDecoration-addedResourceForeground, #4ec9b0); }
        .node-rollback { fill: var(--vscode-gitDecoration-deletedResourceForeground, #f48771); }
        .node-batch { fill: var(--vscode-activityBarBadge-background, #007acc); }
        .node-current { fill: var(--vscode-editorWarning-foreground, #cca700); }
        
        .node-label {
          font-size: 10px;
          fill: var(--vscode-descriptionForeground);
          text-anchor: middle;
          pointer-events: none;
        }
        
        .date-label {
          font-size: 9px;
          fill: var(--vscode-descriptionForeground);
          text-anchor: middle;
          opacity: 0.7;
        }
        
        .date-divider {
          stroke: var(--vscode-panel-border);
          stroke-width: 1;
          stroke-dasharray: 4,4;
          opacity: 0.5;
        }
        
        .selection-range {
          fill: rgba(14, 99, 156, 0.2);
          rx: 4;
        }
        
        .detail-panel {
          margin-top: 24px;
          padding: 16px;
          background: var(--vscode-input-background);
          border: 1px solid var(--vscode-input-border);
          border-radius: 6px;
        }
        
        .detail-title {
          font-size: 13px;
          font-weight: 600;
          margin-bottom: 12px;
          display: flex;
          align-items: center;
          gap: 8px;
        }
        
        .detail-row {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 8px;
          font-size: 12px;
        }
        
        .detail-label {
          color: var(--vscode-descriptionForeground);
          min-width: 70px;
        }
        
        .detail-value {
          font-family: var(--vscode-editor-font-family);
        }
        
        .detail-actions {
          margin-top: 16px;
          display: flex;
          gap: 8px;
        }
        
        .btn {
          padding: 6px 12px;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-size: 12px;
          display: flex;
          align-items: center;
          gap: 6px;
          transition: background 0.15s;
        }
        
        .btn-primary {
          background: var(--vscode-button-background);
          color: var(--vscode-button-foreground);
        }
        
        .btn-primary:hover {
          background: var(--vscode-button-hoverBackground);
        }
        
        .btn-secondary {
          background: var(--vscode-button-secondaryBackground);
          color: var(--vscode-button-secondaryForeground);
        }
        
        .btn-secondary:hover {
          background: var(--vscode-button-secondaryHoverBackground);
        }
        
        .btn-danger {
          background: transparent;
          color: var(--vscode-errorForeground, #f48771);
          border: 1px solid var(--vscode-errorForeground, #f48771);
        }
        
        .btn-danger:hover {
          background: rgba(244, 135, 113, 0.15);
        }
        
        .stats {
          display: flex;
          gap: 12px;
        }
        
        .stat-added { color: var(--vscode-gitDecoration-addedResourceForeground, #4ec9b0); }
        .stat-removed { color: var(--vscode-gitDecoration-deletedResourceForeground, #f48771); }
        
        .legend {
          display: flex;
          gap: 16px;
          margin-top: 16px;
          padding-top: 16px;
          border-top: 1px solid var(--vscode-panel-border);
          font-size: 11px;
          color: var(--vscode-descriptionForeground);
        }
        
        .legend-item {
          display: flex;
          align-items: center;
          gap: 6px;
        }
        
        .legend-dot {
          width: 10px;
          height: 10px;
          border-radius: 50%;
        }
        
        .legend-dot.edit { background: var(--vscode-gitDecoration-addedResourceForeground, #4ec9b0); }
        .legend-dot.rollback { background: var(--vscode-gitDecoration-deletedResourceForeground, #f48771); }
        .legend-dot.batch { background: var(--vscode-activityBarBadge-background, #007acc); }
        
        .legend-flag {
          display: inline-block;
          width: 0;
          height: 0;
          border-left: 10px solid #cca700;
          border-top: 5px solid transparent;
          border-bottom: 5px solid transparent;
        }
        
      </style>
    </head>
    <body>
      <div class="header">
        <div class="header-title">
          <i class="codicon codicon-git-commit"></i>
          <span>${vscode.l10n.t('Timeline')}</span>
        </div>
        <div class="header-path">${this._escapeHtml(relativePath)}</div>
      </div>
      
      <div class="timeline-container">
        <div class="timeline-hint">
          <i class="codicon codicon-info"></i>
          ${vscode.l10n.t('Click to select, Shift+click to select range')}
        </div>
        
        <svg class="timeline-svg" viewBox="0 0 ${timelineData.width} 140" preserveAspectRatio="xMinYMid meet">
          <!-- 时间轴主线 -->
          <line class="timeline-line" x1="40" y1="50" x2="${timelineData.width - 40}" y2="50"/>
          
          <!-- 选中范围高亮（由 JS 控制） -->
          <rect class="selection-range" id="selectionRange" x="0" y="30" width="0" height="40" style="display:none;"/>
          
          <!-- 日期分隔线和刻度 -->
          ${this._generateDateMarkers(changes, timelineData)}
          
          <!-- 版本节点 -->
          ${timelineData.nodes.map((node, index) => {
            const change = changes.find(c => c.id === node.id);
            const tooltipText = change 
              ? `#${change.id} | ${new Date(change.timestamp).toLocaleString()} | +${change.lines_added} / -${change.lines_removed}`
              : '';
            // 当前版本用旗子，其他用圆形
            const shape = node.isLast 
              ? `<g class="node-flag">
                  <rect x="-1" y="-14" width="3" height="22" fill="#cca700"/>
                  <polygon points="2,-14 16,-6 2,2" fill="#cca700"/>
                </g>`
              : `<circle class="node-circle ${node.nodeClass}" r="8"/>`;
            return `
            <g class="timeline-node" data-id="${node.id}" data-index="${index}" transform="translate(${node.x}, 50)">
              <title>${tooltipText}</title>
              ${shape}
              <text class="node-label" y="28">#${node.id}</text>
            </g>
          `}).join('')}
          
          <!-- 箭头 -->
          <polygon points="${timelineData.width - 35},50 ${timelineData.width - 45},45 ${timelineData.width - 45},55" 
                   fill="var(--vscode-panel-border)"/>
        </svg>
        
        <!-- 详情面板 -->
        <div class="detail-panel" id="detailPanel" style="display:none;">
          <div class="detail-title" id="detailTitle"></div>
          <div id="detailContent"></div>
          <div class="detail-actions" id="detailActions"></div>
        </div>
        
        <!-- 图例 -->
        <div class="legend">
          <div class="legend-item">
            <div class="legend-dot edit"></div>
            <span>${vscode.l10n.t('Normal edit')}</span>
          </div>
          <div class="legend-item">
            <div class="legend-dot rollback"></div>
            <span>${vscode.l10n.t('Rollback')}</span>
          </div>
          <div class="legend-item">
            <div class="legend-dot batch"></div>
            <span>${vscode.l10n.t('Batch edit')}</span>
          </div>
          <div class="legend-item">
            <span class="legend-flag"></span>
            <span>${vscode.l10n.t('Current version')}</span>
          </div>
        </div>
      </div>
      
      <script>
        const vscode = acquireVsCodeApi();
        const changes = ${JSON.stringify(changes)};
        
        let selectedIds = [];
        let lastClickedIndex = null;
        
        // 节点点击处理
        document.querySelectorAll('.timeline-node').forEach(node => {
          node.addEventListener('click', (e) => {
            const id = parseInt(node.dataset.id);
            const index = parseInt(node.dataset.index);
            
            if (e.shiftKey && lastClickedIndex !== null) {
              // Shift + 点击：选择范围
              const start = Math.min(lastClickedIndex, index);
              const end = Math.max(lastClickedIndex, index);
              selectedIds = [];
              for (let i = start; i <= end; i++) {
                selectedIds.push(changes[i].id);
              }
            } else {
              // 普通点击：单选
              selectedIds = [id];
              lastClickedIndex = index;
            }
            
            updateSelection();
            updateDetailPanel();
          });
        });
        
        // 更新选中状态
        function updateSelection() {
          document.querySelectorAll('.timeline-node').forEach(node => {
            const id = parseInt(node.dataset.id);
            if (selectedIds.includes(id)) {
              node.classList.add('selected');
            } else {
              node.classList.remove('selected');
            }
          });
          
          // 更新范围高亮
          const rangeRect = document.getElementById('selectionRange');
          if (selectedIds.length > 1) {
            const firstNode = document.querySelector('[data-id="' + selectedIds[0] + '"]');
            const lastNode = document.querySelector('[data-id="' + selectedIds[selectedIds.length - 1] + '"]');
            if (firstNode && lastNode) {
              const x1 = parseFloat(firstNode.getAttribute('transform').match(/translate\\((\\d+)/)[1]);
              const x2 = parseFloat(lastNode.getAttribute('transform').match(/translate\\((\\d+)/)[1]);
              rangeRect.setAttribute('x', Math.min(x1, x2) - 15);
              rangeRect.setAttribute('width', Math.abs(x2 - x1) + 30);
              rangeRect.style.display = '';
            }
          } else {
            rangeRect.style.display = 'none';
          }
        }
        
        // 更新详情面板
        function updateDetailPanel() {
          const panel = document.getElementById('detailPanel');
          const title = document.getElementById('detailTitle');
          const content = document.getElementById('detailContent');
          const actions = document.getElementById('detailActions');
          
          if (selectedIds.length === 0) {
            panel.style.display = 'none';
            return;
          }
          
          panel.style.display = '';
          
          if (selectedIds.length === 1) {
            // 单选：显示版本详情
            const change = changes.find(c => c.id === selectedIds[0]);
            if (!change) return;
            
            const typeLabel = change.operation_type === 'rollback' 
              ? '${vscode.l10n.t('Rollback')}' 
              : (change.batch_id ? '${vscode.l10n.t('Batch edit')}' : '${vscode.l10n.t('Normal edit')}');
            
            title.innerHTML = '<i class="codicon codicon-versions"></i> ${vscode.l10n.t('Version')} #' + change.id;
            content.innerHTML = \`
              <div class="detail-row">
                <span class="detail-label">📅 ${vscode.l10n.t('Time span')}:</span>
                <span class="detail-value">\${new Date(change.timestamp).toLocaleString()}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">📝 ${vscode.l10n.t('Type')}:</span>
                <span class="detail-value">\${typeLabel}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">📊 ${vscode.l10n.t('Total changes')}:</span>
                <span class="stats">
                  <span class="stat-added">+\${change.lines_added}</span>
                  <span class="stat-removed">-\${change.lines_removed}</span>
                </span>
              </div>
            \`;
            
            const isLast = change.id === changes[changes.length - 1].id;
            actions.innerHTML = \`
              <button class="btn btn-primary" onclick="viewDiff(\${change.id})">
                <i class="codicon codicon-diff"></i> ${vscode.l10n.t('Compare with previous')}
              </button>
              \${!isLast ? \`
                <button class="btn btn-danger" onclick="rollback(\${change.id})">
                  <i class="codicon codicon-discard"></i> ${vscode.l10n.t('Rollback to this version')}
                </button>
              \` : ''}
            \`;
          } else {
            // 多选：显示范围信息
            const fromChange = changes.find(c => c.id === selectedIds[0]);
            const toChange = changes.find(c => c.id === selectedIds[selectedIds.length - 1]);
            
            const totalAdded = selectedIds.reduce((sum, id) => {
              const c = changes.find(ch => ch.id === id);
              return sum + (c ? c.lines_added : 0);
            }, 0);
            const totalRemoved = selectedIds.reduce((sum, id) => {
              const c = changes.find(ch => ch.id === id);
              return sum + (c ? c.lines_removed : 0);
            }, 0);
            
            title.innerHTML = '<i class="codicon codicon-git-compare"></i> ${vscode.l10n.t('Selected range')}: #' + fromChange.id + ' → #' + toChange.id + ' (' + selectedIds.length + ' ${vscode.l10n.t('versions')})';
            content.innerHTML = \`
              <div class="detail-row">
                <span class="detail-label">📅 ${vscode.l10n.t('Time span')}:</span>
                <span class="detail-value">\${new Date(fromChange.timestamp).toLocaleString()} → \${new Date(toChange.timestamp).toLocaleString()}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">📊 ${vscode.l10n.t('Total changes')}:</span>
                <span class="stats">
                  <span class="stat-added">+\${totalAdded}</span>
                  <span class="stat-removed">-\${totalRemoved}</span>
                </span>
              </div>
            \`;
            
            actions.innerHTML = \`
              <button class="btn btn-primary" onclick="viewRangeDiff(\${fromChange.id}, \${toChange.id})">
                <i class="codicon codicon-diff"></i> ${vscode.l10n.t('Compare range')}
              </button>
              <button class="btn btn-danger" onclick="rollback(\${fromChange.id})">
                <i class="codicon codicon-discard"></i> ${vscode.l10n.t('Rollback to start')}
              </button>
            \`;
          }
        }
        
        // 操作函数
        function viewDiff(id) {
          vscode.postMessage({ type: 'viewDiff', changeId: id });
        }
        
        function viewRangeDiff(fromId, toId) {
          vscode.postMessage({ type: 'viewRangeDiff', fromId, toId });
        }
        
        function rollback(id) {
          vscode.postMessage({ type: 'rollback', changeId: id });
        }
      </script>
    </body>
    </html>`;
  }

  /**
   * 计算时间轴布局
   */
  private _calculateTimelineLayout(changes: CodeChange[]): {
    width: number;
    nodes: Array<{
      id: number;
      x: number;
      nodeClass: string;
      isLast: boolean;
    }>;
  } {
    const nodeSpacing = 60; // 节点间距
    const padding = 60; // 左右padding
    const width = Math.max(400, padding * 2 + (changes.length - 1) * nodeSpacing);

    const nodes = changes.map((change, index) => {
      const isLast = index === changes.length - 1;
      let nodeClass = 'node-edit';
      
      if (isLast) {
        nodeClass = 'node-current';
      } else if (change.operation_type === 'rollback') {
        nodeClass = 'node-rollback';
      } else if (change.batch_id) {
        nodeClass = 'node-batch';
      }

      return {
        id: change.id,
        x: padding + index * nodeSpacing,
        nodeClass,
        isLast
      };
    });

    return { width, nodes };
  }

  /**
   * 生成日期标记（分隔线 + 日期标签）
   */
  private _generateDateMarkers(
    changes: CodeChange[],
    timelineData: { width: number; nodes: Array<{ id: number; x: number; nodeClass: string; isLast: boolean }> }
  ): string {
    if (changes.length === 0) return '';
    
    const markers: string[] = [];
    let lastDate = '';
    
    changes.forEach((change, index) => {
      const date = new Date(change.timestamp);
      const dateStr = date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
      const node = timelineData.nodes[index];
      
      if (dateStr !== lastDate) {
        // 新的一天，添加分隔线和日期标签
        if (lastDate !== '') {
          // 不是第一个节点，添加分隔线
          markers.push(`<line class="date-divider" x1="${node.x - 30}" y1="20" x2="${node.x - 30}" y2="80"/>`);
        }
        // 添加日期标签
        markers.push(`<text class="date-label" x="${node.x}" y="105">${dateStr}</text>`);
        lastDate = dateStr;
      }
    });
    
    return markers.join('\n          ');
  }

  /**
   * 空状态 HTML
   */
  private _getEmptyHtml(
    webview: vscode.Webview,
    codiconCssUri: vscode.Uri,
    codiconFontUri: vscode.Uri,
    relativePath: string
  ): string {
    return `<!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource} data:;">
      <title>${vscode.l10n.t('Timeline')}</title>
      <style>
        @font-face {
          font-family: "codicon";
          font-display: block;
          src: url("${codiconFontUri}") format("truetype");
        }
      </style>
      <link href="${codiconCssUri}" rel="stylesheet" />
      <style>
        body {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          height: 100vh;
          margin: 0;
          color: var(--vscode-foreground);
          font-family: var(--vscode-font-family);
          background: var(--vscode-editor-background);
        }
        .empty-icon {
          font-size: 64px;
          opacity: 0.4;
          margin-bottom: 16px;
        }
        .empty-title {
          font-size: 16px;
          margin-bottom: 8px;
        }
        .empty-desc {
          font-size: 12px;
          color: var(--vscode-descriptionForeground);
        }
        .empty-path {
          margin-top: 16px;
          font-size: 11px;
          color: var(--vscode-descriptionForeground);
          font-family: var(--vscode-editor-font-family);
        }
      </style>
    </head>
    <body>
      <div class="empty-icon"><i class="codicon codicon-git-commit"></i></div>
      <div class="empty-title">${vscode.l10n.t('No history for this file')}</div>
      <div class="empty-desc">${vscode.l10n.t('This file has no change records yet')}</div>
      <div class="empty-path">${this._escapeHtml(relativePath)}</div>
    </body>
    </html>`;
  }

  private _escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  public dispose() {
    TimelinePanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) {
        x.dispose();
      }
    }
  }
}
