import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { CodeTimeDB } from './database';
import { FileWatcher } from './watcher';
import { HistoryViewProvider } from './historyView';

// 支持多工作区
interface WorkspaceInstance {
  db: CodeTimeDB;
  watcher: FileWatcher;
}

const workspaceInstances: Map<string, WorkspaceInstance> = new Map();
let historyViewProvider: HistoryViewProvider;

export async function activate(context: vscode.ExtensionContext) {
  console.log('CodeTimeDB extension is now active!');

  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showWarningMessage('CodeTimeDB: 请打开一个工作区才能使用');
    return;
  }

  try {
    // 为每个工作区初始化
    for (const folder of workspaceFolders) {
      await initWorkspace(folder);
    }

    const config = vscode.workspace.getConfiguration('codetimedb');
    const enabled = config.get<boolean>('enabled', true);

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

    // 注册命令
    context.subscriptions.push(
      vscode.commands.registerCommand('codetimedb.showHistory', () => {
        vscode.commands.executeCommand('codetimedb.historyView.focus');
      })
    );

    context.subscriptions.push(
      vscode.commands.registerCommand('codetimedb.enable', () => {
        workspaceInstances.forEach(instance => {
          instance.watcher.start();
          instance.watcher.setEnabled(true);
        });
        vscode.workspace
          .getConfiguration('codetimedb')
          .update('enabled', true, vscode.ConfigurationTarget.Workspace);
      })
    );

    context.subscriptions.push(
      vscode.commands.registerCommand('codetimedb.disable', () => {
        workspaceInstances.forEach(instance => {
          instance.watcher.setEnabled(false);
        });
        vscode.workspace
          .getConfiguration('codetimedb')
          .update('enabled', false, vscode.ConfigurationTarget.Workspace);
      })
    );

    context.subscriptions.push(
      vscode.commands.registerCommand('codetimedb.refreshView', () => {
        historyViewProvider.refresh();
      })
    );

    // 延迟清理过期记录，避免影响启动性能
    setTimeout(() => {
      const currentConfig = vscode.workspace.getConfiguration('codetimedb');
      const retentionDays = currentConfig.get<number>('retentionDays', 15);
      const maxHistorySize = currentConfig.get<number>('maxHistorySize', 1000);
      let totalDeleted = 0;
      workspaceInstances.forEach(instance => {
        totalDeleted += instance.db.cleanupOldRecords(retentionDays);
        instance.db.cleanup(maxHistorySize);
      });
      if (totalDeleted > 0) {
        console.log(`CodeTimeDB: Cleaned up ${totalDeleted} records older than ${retentionDays} days`);
      }
    }, 30 * 1000); // 30秒后执行

    // 监听配置变化
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('codetimedb.enabled')) {
          const newEnabled = vscode.workspace
            .getConfiguration('codetimedb')
            .get<boolean>('enabled', true);
          workspaceInstances.forEach(instance => {
            instance.watcher.setEnabled(newEnabled);
          });
        }
        
        // 监听保留天数变化，立即执行清理
        if (e.affectsConfiguration('codetimedb.retentionDays')) {
          const newRetentionDays = vscode.workspace
            .getConfiguration('codetimedb')
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
          console.log(`CodeTimeDB: Added workspace ${folder.name}`);
        }

        // 移除工作区
        for (const folder of e.removed) {
          const instance = workspaceInstances.get(folder.uri.fsPath);
          if (instance) {
            instance.watcher.stop();
            instance.db.close();
            workspaceInstances.delete(folder.uri.fsPath);
            console.log(`CodeTimeDB: Removed workspace ${folder.name}`);
          }
        }

        historyViewProvider.refresh();
      })
    );

  } catch (error) {
    vscode.window.showErrorMessage(`CodeTimeDB 初始化失败: ${error}`);
    console.error('CodeTimeDB activation error:', error);
  }
}

async function initWorkspace(folder: vscode.WorkspaceFolder) {
  const workspaceRoot = folder.uri.fsPath;
  
  // 确保 .codetimedb 在 .gitignore 中
  ensureGitignore(workspaceRoot);
  
  // 初始化数据库
  const db = new CodeTimeDB(workspaceRoot);
  await db.init();
  
  // 初始化文件监控
  const watcher = new FileWatcher(workspaceRoot, db);
  
  const config = vscode.workspace.getConfiguration('codetimedb');
  const enabled = config.get<boolean>('enabled', true);
  
  if (enabled) {
    watcher.start();
  }
  
  workspaceInstances.set(workspaceRoot, { db, watcher });
  console.log(`CodeTimeDB: Initialized workspace ${folder.name}`);
}

/**
 * 确保 .codetimedb 在 .gitignore 中
 */
function ensureGitignore(workspaceRoot: string) {
  const gitignorePath = path.join(workspaceRoot, '.gitignore');
  const entry = '.codetimedb';
  
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
    
    // 添加 .codetimedb 到 .gitignore
    const separator = content && !content.endsWith('\n') ? '\n' : '';
    const newContent = content + separator + '\n# CodeTimeDB local database\n' + entry + '\n';
    fs.writeFileSync(gitignorePath, newContent);
    
    console.log('CodeTimeDB: Added .codetimedb to .gitignore');
  } catch (error) {
    console.error('CodeTimeDB: Failed to update .gitignore:', error);
  }
}

export function deactivate() {
  workspaceInstances.forEach(instance => {
    instance.watcher.stop();
    instance.db.close();
  });
  workspaceInstances.clear();
  console.log('CodeTimeDB extension deactivated');
}
