import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ReCode } from './database';
import { FileWatcher } from './watcher';
import { HistoryViewProvider } from './historyView';
import { TimelinePanel } from './timelineView';

// 支持多工作区
interface WorkspaceInstance {
  db: ReCode;
  watcher: FileWatcher;
}

const workspaceInstances: Map<string, WorkspaceInstance> = new Map();
let historyViewProvider: HistoryViewProvider;

export async function activate(context: vscode.ExtensionContext) {
  console.log('ReCode extension is now active!');

  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showWarningMessage(vscode.l10n.t('Please open a workspace to use ReCode'));
    return;
  }

  // 配置驱动：先注册 UI，再延迟初始化工作区（避免阻塞扩展激活）
  // 注册Webview Provider (显示所有工作区的变更)
  historyViewProvider = new HistoryViewProvider(
    context.extensionUri,
    workspaceInstances
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      HistoryViewProvider.viewType,
      historyViewProvider
    )
  );

  // 配置驱动：延迟初始化工作区，不阻塞扩展激活
  setTimeout(async () => {
    for (const folder of workspaceFolders) {
      try {
        await initWorkspace(folder);
      } catch (error) {
        console.error(`ReCode: Failed to init workspace ${folder.name}:`, error);
      }
    }
    // 初始化完成后刷新 UI
    historyViewProvider.refresh();
  }, 500);

  try {

    // 注册命令
    context.subscriptions.push(
      vscode.commands.registerCommand('recode.showHistory', () => {
        vscode.commands.executeCommand('recode.historyView.focus');
      })
    );

    context.subscriptions.push(
      vscode.commands.registerCommand('recode.enable', () => {
        workspaceInstances.forEach(instance => {
          instance.watcher.start();
          instance.watcher.setEnabled(true);
        });
        vscode.workspace
          .getConfiguration('recode')
          .update('enabled', true, vscode.ConfigurationTarget.Workspace);
      })
    );

    context.subscriptions.push(
      vscode.commands.registerCommand('recode.disable', () => {
        workspaceInstances.forEach(instance => {
          instance.watcher.setEnabled(false);
        });
        vscode.workspace
          .getConfiguration('recode')
          .update('enabled', false, vscode.ConfigurationTarget.Workspace);
      })
    );

    context.subscriptions.push(
      vscode.commands.registerCommand('recode.refreshView', () => {
        historyViewProvider.refresh();
      })
    );

    // 注册时间轴命令（配置驱动：通过 recode.timeline.enabled 控制菜单显示）
    context.subscriptions.push(
      vscode.commands.registerCommand('recode.showTimeline', async (uri: vscode.Uri) => {
        // 获取文件路径
        let filePath: string;
        if (uri) {
          filePath = uri.fsPath;
        } else if (vscode.window.activeTextEditor) {
          filePath = vscode.window.activeTextEditor.document.uri.fsPath;
        } else {
          vscode.window.showWarningMessage(vscode.l10n.t('Please open a file first'));
          return;
        }

        // 找到对应的工作区
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
        if (!workspaceFolder) {
          vscode.window.showWarningMessage(vscode.l10n.t('File is not in any workspace'));
          return;
        }

        const workspaceRoot = workspaceFolder.uri.fsPath;
        
        // 打开时间轴面板
        TimelinePanel.createOrShow(
          context.extensionUri,
          filePath,
          workspaceRoot,
          workspaceInstances
        );
      })
    );

    // 注册从时间轴回滚的内部命令
    context.subscriptions.push(
      vscode.commands.registerCommand('recode.rollbackFromTimeline', async (changeId: number, workspaceRoot: string) => {
        const instance = workspaceInstances.get(workspaceRoot);
        if (!instance) {
          vscode.window.showErrorMessage(vscode.l10n.t('Cannot find workspace instance'));
          return;
        }

        const change = instance.db.getChangeById(changeId);
        if (!change) {
          vscode.window.showErrorMessage(vscode.l10n.t('Cannot find change record #{0}', changeId));
          return;
        }

        // 确认回滚
        const confirmRollbackText = vscode.l10n.t('Confirm Rollback');
        const answer = await vscode.window.showWarningMessage(
          vscode.l10n.t('Rollback to version #{0}?', changeId),
          { modal: true },
          confirmRollbackText
        );

        if (answer !== confirmRollbackText) {
          return;
        }

        try {
          const filePath = path.join(workspaceRoot, change.file_path);
          const currentContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';

          // 创建回滚记录
          const diff = `@@ rollback to #${changeId} @@`;
          const rollbackId = instance.db.insertChange(
            change.file_path,
            currentContent,
            change.new_content,
            diff,
            0,
            0,
            null,
            'rollback',
            changeId
          );

          // 标记被覆盖的记录
          instance.db.markCoveredByRollback(change.file_path, rollbackId, changeId);

          // 写入文件（跳过 watcher 记录）
          instance.watcher.setOperationContext(filePath, { skipRecording: true });
          fs.writeFileSync(filePath, change.new_content, 'utf-8');

          vscode.window.showInformationMessage(vscode.l10n.t('Rolled back to #{0} {1}', changeId, change.file_path));
          historyViewProvider.refresh();
        } catch (error) {
          vscode.window.showErrorMessage(vscode.l10n.t('Rollback failed: {0}', String(error)));
        }
      })
    );

    // 注册清理历史记录命令
    const confirmClearText = vscode.l10n.t('Confirm Clear');
    context.subscriptions.push(
      vscode.commands.registerCommand('recode.clearHistory', async () => {
        const answer = await vscode.window.showWarningMessage(
          vscode.l10n.t('Are you sure you want to clear all history? This action cannot be undone!'),
          { modal: true },
          confirmClearText
        );
        
        if (answer === confirmClearText) {
          let totalDeleted = 0;
          workspaceInstances.forEach(instance => {
            totalDeleted += instance.db.clearAll();
          });
          historyViewProvider.refresh();
          vscode.window.showInformationMessage(vscode.l10n.t('Cleared {0} history records', totalDeleted));
        }
      })
    );

    // 延迟清理过期记录，避免影响启动性能
    setTimeout(() => {
      const currentConfig = vscode.workspace.getConfiguration('recode');
      const retentionDays = currentConfig.get<number>('retentionDays', 15);
      const maxHistorySize = currentConfig.get<number>('maxHistorySize', 1000);
      let totalDeleted = 0;
      workspaceInstances.forEach(instance => {
        totalDeleted += instance.db.cleanupOldRecords(retentionDays);
        instance.db.cleanup(maxHistorySize);
      });
      if (totalDeleted > 0) {
        console.log(`ReCode: Cleaned up ${totalDeleted} records older than ${retentionDays} days`);
      }
    }, 30 * 1000); // 30秒后执行

    // 监听配置变化
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('recode.enabled')) {
          const newEnabled = vscode.workspace
            .getConfiguration('recode')
            .get<boolean>('enabled', true);
          workspaceInstances.forEach(instance => {
            instance.watcher.setEnabled(newEnabled);
          });
        }
        
        // 监听保留天数变化，立即执行清理
        if (e.affectsConfiguration('recode.retentionDays')) {
          const newRetentionDays = vscode.workspace
            .getConfiguration('recode')
            .get<number>('retentionDays', 15);
          let deleted = 0;
          workspaceInstances.forEach(instance => {
            deleted += instance.db.cleanupOldRecords(newRetentionDays);
          });
          if (deleted > 0) {
            historyViewProvider.refresh();
          }
        }
      })
    );

    // 监听工作区变化
    context.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(async (e) => {
        // 添加新工作区
        for (const folder of e.added) {
          await initWorkspace(folder);
          console.log(`ReCode: Added workspace ${folder.name}`);
        }

        // 移除工作区
        for (const folder of e.removed) {
          const instance = workspaceInstances.get(folder.uri.fsPath);
          if (instance) {
            instance.watcher.stop();
            instance.db.close();
            workspaceInstances.delete(folder.uri.fsPath);
            console.log(`ReCode: Removed workspace ${folder.name}`);
          }
        }

        historyViewProvider.refresh();
      })
    );

  } catch (error) {
    vscode.window.showErrorMessage(vscode.l10n.t('ReCode initialization failed: {0}', String(error)));
    console.error('ReCode activation error:', error);
  }
}

async function initWorkspace(folder: vscode.WorkspaceFolder) {
  const workspaceRoot = folder.uri.fsPath;
  
  // 确保 .recode 在 .gitignore 中
  ensureGitignore(workspaceRoot);
  
  // 初始化数据库
  const db = new ReCode(workspaceRoot);
  await db.init();
  
  // 初始化文件监控
  const watcher = new FileWatcher(workspaceRoot, db);
  
  const config = vscode.workspace.getConfiguration('recode');
  const enabled = config.get<boolean>('enabled', true);
  
  if (enabled) {
    watcher.start();
  }
  
  workspaceInstances.set(workspaceRoot, { db, watcher });
  console.log(`ReCode: Initialized workspace ${folder.name}`);
}

/**
 * 确保 .recode 在 .gitignore 中
 */
function ensureGitignore(workspaceRoot: string) {
  const gitignorePath = path.join(workspaceRoot, '.gitignore');
  const entry = '.recode';
  
  try {
    let content = '';
    
    if (fs.existsSync(gitignorePath)) {
      content = fs.readFileSync(gitignorePath, 'utf-8');
      
      // 检查是否已存在
      const lines = content.split('\n').map(l => l.trim());
      if (lines.includes(entry)) {
        return; // 已存在，无需添加
      }
    }
    
    // 添加 .recode 到 .gitignore
    const separator = content && !content.endsWith('\n') ? '\n' : '';
    const newContent = content + separator + '\n# ReCode local database\n' + entry + '\n';
    fs.writeFileSync(gitignorePath, newContent);
    
    console.log('ReCode: Added .recode to .gitignore');
  } catch (error) {
    console.error('ReCode: Failed to update .gitignore:', error);
  }
}

export function deactivate() {
  workspaceInstances.forEach(instance => {
    instance.watcher.stop();
    instance.db.close();
  });
  workspaceInstances.clear();
  console.log('ReCode extension deactivated');
}
