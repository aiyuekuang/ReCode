import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ReCode } from './database';

// 简单的gitignore解析器
class GitIgnoreParser {
  private patterns: Array<{ pattern: RegExp; negated: boolean }> = [];

  constructor(gitignorePath: string) {
    this.loadGitignore(gitignorePath);
  }

  private loadGitignore(gitignorePath: string) {
    // 默认忽略的模式
    const defaultIgnores = [
      'node_modules',
      '.git',
      '.recode',
      'dist',
      'build',
      '.next',
      '.nuxt',
      '.output',
      'coverage',
      '.cache',
      '.umi',
      '.idea',
      '.vscode',
      '*.log',
      '*.lock',
      'package-lock.json',
      'yarn.lock',
      'pnpm-lock.yaml'
    ];

    defaultIgnores.forEach(p => this.addPattern(p));

    // 读取.gitignore文件
    if (fs.existsSync(gitignorePath)) {
      try {
        const content = fs.readFileSync(gitignorePath, 'utf-8');
        const lines = content.split('\n');
        
        for (const line of lines) {
          const trimmed = line.trim();
          // 跳过空行和注释
          if (!trimmed || trimmed.startsWith('#')) {
            continue;
          }
          this.addPattern(trimmed);
        }
      } catch (error) {
        console.error('ReCode: Error reading .gitignore:', error);
      }
    }
  }

  private addPattern(pattern: string) {
    let negated = false;
    let p = pattern;

    // 处理取反模式
    if (p.startsWith('!')) {
      negated = true;
      p = p.slice(1);
    }

    // 转换为正则表达式
    const regexPattern = p
      .replace(/\./g, '\\.')           // 转义.
      .replace(/\*\*/g, '{{GLOBSTAR}}') // 保留**
      .replace(/\*/g, '[^/]*')          // *匹配非/
      .replace(/{{GLOBSTAR}}/g, '.*')   // **匹配任意
      .replace(/\?/g, '[^/]');          // ?匹配单字符

    // 如果模式不以/开头,可以匹配任意深度
    const fullPattern = p.startsWith('/') 
      ? `^${regexPattern.slice(1)}` 
      : `(^|/)${regexPattern}`;

    try {
      this.patterns.push({
        pattern: new RegExp(fullPattern),
        negated
      });
    } catch (e) {
      // 无效的正则,跳过
    }
  }

  isIgnored(relativePath: string): boolean {
    let ignored = false;

    for (const { pattern, negated } of this.patterns) {
      if (pattern.test(relativePath)) {
        ignored = !negated;
      }
    }

    return ignored;
  }
}

// 操作上下文：配置驱动的核心
export interface OperationContext {
  skipRecording: boolean;    // 是否跳过记录（恢复时使用）
  operationType?: 'rollback'; // 操作类型（回滚时使用）
  rollbackToId?: number;     // 回滚目标 ID
}

export class FileWatcher {
  private fileCache: Map<string, string> = new Map();
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private db: ReCode;
  private workspaceRoot: string;
  private watcher: vscode.FileSystemWatcher | null = null;
  private enabled: boolean = true;
  private gitignore: GitIgnoreParser;
  
  // 批次检测
  private currentBatchId: string | null = null;
  private batchTimer: NodeJS.Timeout | null = null;
  private readonly BATCH_TIMEOUT = 10000; // 10秒内的修改属于同一批次
  
  // 操作上下文：标记当前操作类型，让 watcher 知道如何记录
  private pendingOperations: Map<string, OperationContext> = new Map();

  constructor(workspaceRoot: string, db: ReCode) {
    this.workspaceRoot = workspaceRoot;
    this.db = db;
    
    // 加载.gitignore
    const gitignorePath = path.join(workspaceRoot, '.gitignore');
    this.gitignore = new GitIgnoreParser(gitignorePath);
  }

  start() {
    this.initFileCache();
    this.setupWatcher();
  }

  stop() {
    if (this.watcher) {
      this.watcher.dispose();
      this.watcher = null;
    }
    this.debounceTimers.forEach(timer => clearTimeout(timer));
    this.debounceTimers.clear();
    
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
  }

  /**
   * 设置操作上下文：在修改文件前调用，让 watcher 知道这是什么类型的操作
   */
  setOperationContext(filePath: string, context: OperationContext) {
    this.pendingOperations.set(filePath, context);
  }
  
  /**
   * 清除操作上下文
   */
  clearOperationContext(filePath: string) {
    this.pendingOperations.delete(filePath);
  }

  private initFileCache() {
    // 初始化时加载所有文件的当前内容
    vscode.workspace.findFiles(
      '**/*',
      '**/node_modules/**'
    ).then(files => {
      files.forEach(file => {
        // 只缓存文本文件
        if (this.isTextFile(file.fsPath)) {
          this.cacheFile(file.fsPath);
        }
      });
      console.log(`ReCode: Cached ${this.fileCache.size} files`);
    });
  }

  private isTextFile(filePath: string): boolean {
    // 排除常见的二进制文件
    const binaryExtensions = [
      '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.webp', '.bmp',
      '.mp3', '.mp4', '.wav', '.avi', '.mov', '.webm',
      '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
      '.zip', '.rar', '.tar', '.gz', '.7z',
      '.exe', '.dll', '.so', '.dylib',
      '.ttf', '.otf', '.woff', '.woff2', '.eot',
      '.db', '.sqlite', '.sqlite3'
    ];
    
    const ext = path.extname(filePath).toLowerCase();
    return !binaryExtensions.includes(ext);
  }

  private cacheFile(filePath: string) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      this.fileCache.set(filePath, content);
    } catch (error) {
      // 忽略读取失败
    }
  }

  private setupWatcher() {
    // 监控所有文件的变化
    this.watcher = vscode.workspace.createFileSystemWatcher(
      '**/*'
    );

    this.watcher.onDidChange(uri => {
      if (!this.enabled) return;
      this.handleFileChange(uri.fsPath);
    });

    this.watcher.onDidCreate(uri => {
      if (!this.enabled) return;
      this.cacheFile(uri.fsPath);
    });

    this.watcher.onDidDelete(uri => {
      this.fileCache.delete(uri.fsPath);
      this.debounceTimers.delete(uri.fsPath);
    });
  }

  private handleFileChange(filePath: string) {
    // 排除二进制文件
    if (!this.isTextFile(filePath)) {
      return;
    }
    
    // 检查gitignore
    const relativePath = path.relative(this.workspaceRoot, filePath);
    if (this.gitignore.isIgnored(relativePath)) {
      return;
    }

    // 防抖处理
    const existingTimer = this.debounceTimers.get(filePath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const config = vscode.workspace.getConfiguration('recode');
    const debounceDelay = config.get<number>('debounceDelay', 2000);

    const timer = setTimeout(() => {
      this.recordChange(filePath);
      this.debounceTimers.delete(filePath);
    }, debounceDelay);

    this.debounceTimers.set(filePath, timer);
  }

  private recordChange(filePath: string) {
    try {
      const oldContent = this.fileCache.get(filePath) || '';
      const newContent = fs.readFileSync(filePath, 'utf-8');

      // 内容没变化则跳过
      if (oldContent === newContent) {
        this.pendingOperations.delete(filePath);
        return;
      }

      // 获取操作上下文（配置驱动）
      const ctx = this.pendingOperations.get(filePath);
      this.pendingOperations.delete(filePath);
      
      // 如果配置了跳过记录（恢复操作），则只更新缓存
      if (ctx?.skipRecording) {
        this.fileCache.set(filePath, newContent);
        console.log(`ReCode: Skipped recording for ${path.relative(this.workspaceRoot, filePath)} - restore`);
        return;
      }

      // 检查批次（回滚操作不进入批次）
      const batchId = ctx?.operationType === 'rollback' ? null : this.getCurrentBatchId();
      const operationType = ctx?.operationType || 'edit';
      const rollbackToId = ctx?.rollbackToId || null;

      // 生成 diff
      const diff = this.generateDiff(oldContent, newContent, filePath);
      const { linesAdded, linesRemoved } = this.countDiffLines(diff);

      // 存入数据库
      const relativePath = path.relative(this.workspaceRoot, filePath);
      const changeId = this.db.insertChange(
        relativePath,
        oldContent,
        newContent,
        diff,
        linesAdded,
        linesRemoved,
        batchId,
        operationType,
        rollbackToId
      );

      // 更新缓存
      this.fileCache.set(filePath, newContent);

      const typeLabel = operationType === 'rollback' ? ' [rollback]' : '';
      console.log(`ReCode: Recorded change #${changeId} for ${relativePath}${typeLabel}`);
      
      // 发送事件通知UI更新
      vscode.commands.executeCommand('recode.refreshView');

    } catch (error) {
      console.error('ReCode: Error recording change:', error);
    }
  }

  private getCurrentBatchId(): string {
    // 如果已经有批次ID,继续使用
    if (!this.currentBatchId) {
      this.currentBatchId = this.generateBatchId();
    }

    // 重置批次计时器
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
    }

    // 10秒后结束当前批次
    this.batchTimer = setTimeout(() => {
      console.log(`ReCode: Batch ${this.currentBatchId} ended`);
      this.currentBatchId = null;
      this.batchTimer = null;
    }, this.BATCH_TIMEOUT);

    return this.currentBatchId;
  }

  private generateBatchId(): string {
    // 生成简单的UUID
    return `batch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private generateDiff(oldContent: string, newContent: string, filePath: string): string {
    const oldLines = oldContent.split('\n');
    const newLines = newContent.split('\n');

    // 简单的diff生成(使用vscode内置diff算法)
    const diffLines: string[] = [];
    diffLines.push(`--- a/${path.basename(filePath)}`);
    diffLines.push(`+++ b/${path.basename(filePath)}`);

    // 这里简化处理,实际可以用更复杂的diff算法
    const maxLen = Math.max(oldLines.length, newLines.length);
    let hunkStart = -1;
    let changes: string[] = [];

    for (let i = 0; i < maxLen; i++) {
      const oldLine = oldLines[i] || '';
      const newLine = newLines[i] || '';

      if (oldLine !== newLine) {
        if (hunkStart === -1) {
          hunkStart = i;
        }
        if (oldLine) {
          changes.push(`-${oldLine}`);
        }
        if (newLine) {
          changes.push(`+${newLine}`);
        }
      } else if (hunkStart !== -1 && changes.length > 0) {
        // 输出一个hunk
        diffLines.push(`@@ -${hunkStart + 1},${i - hunkStart} +${hunkStart + 1},${i - hunkStart} @@`);
        diffLines.push(...changes);
        hunkStart = -1;
        changes = [];
      }
    }

    // 最后一个hunk
    if (changes.length > 0) {
      diffLines.push(`@@ -${hunkStart + 1},${maxLen - hunkStart} +${hunkStart + 1},${maxLen - hunkStart} @@`);
      diffLines.push(...changes);
    }

    return diffLines.join('\n');
  }

  private countDiffLines(diff: string): { linesAdded: number; linesRemoved: number } {
    const lines = diff.split('\n');
    let linesAdded = 0;
    let linesRemoved = 0;

    for (const line of lines) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        linesAdded++;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        linesRemoved++;
      }
    }

    return { linesAdded, linesRemoved };
  }
}
