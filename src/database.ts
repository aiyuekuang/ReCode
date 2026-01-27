import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
// @ts-ignore
import initSqlJs from 'sql.js';

export interface CodeChange {
  id: number;
  timestamp: string;
  file_path: string;
  old_content: string;
  new_content: string;
  diff: string;
  content_hash: string;
  lines_added: number;
  lines_removed: number;
  batch_id: string | null;
  operation_type: 'edit' | 'rollback';  // edit=普通编辑, rollback=回滚操作
  rollback_to_id: number | null;        // 回滚到哪个记录
  covered_by_rollback_id: number | null; // 被哪个回滚记录覆盖（配置驱动）
  created_at: string;
}

export class CodeTimeDB {
  private db: any;
  private dbPath: string;
  private SQL: any;

  constructor(workspaceRoot: string) {
    const dbDir = path.join(workspaceRoot, '.codetimedb');
    this.dbPath = path.join(dbDir, 'changes.db');

    // 确保目录存在
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    // sql.js是异步初始化的,先不初始化
  }

  async init() {
    this.SQL = await initSqlJs();
    
    // 加载已存在的数据库或创建新的
    if (fs.existsSync(this.dbPath)) {
      const buffer = fs.readFileSync(this.dbPath);
      this.db = new this.SQL.Database(buffer);
    } else {
      this.db = new this.SQL.Database();
    }
    
    this.initDatabase();
  }

  private initDatabase() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        file_path TEXT NOT NULL,
        old_content TEXT,
        new_content TEXT,
        diff TEXT,
        content_hash TEXT,
        lines_added INTEGER DEFAULT 0,
        lines_removed INTEGER DEFAULT 0,
        batch_id TEXT,
        operation_type TEXT DEFAULT 'edit',
        rollback_to_id INTEGER,
        covered_by_rollback_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_file_path ON changes(file_path)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_timestamp ON changes(timestamp)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_created_at ON changes(created_at)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_batch_id ON changes(batch_id)`);
    
    // 升级现有数据库
    try {
      this.db.run(`ALTER TABLE changes ADD COLUMN operation_type TEXT DEFAULT 'edit'`);
    } catch (e) {}
    try {
      this.db.run(`ALTER TABLE changes ADD COLUMN rollback_to_id INTEGER`);
    } catch (e) {}
    try {
      this.db.run(`ALTER TABLE changes ADD COLUMN covered_by_rollback_id INTEGER`);
    } catch (e) {}
    
    this.save();
  }

  insertChange(
    filePath: string,
    oldContent: string,
    newContent: string,
    diff: string,
    linesAdded: number,
    linesRemoved: number,
    batchId: string | null = null,
    operationType: 'edit' | 'rollback' = 'edit',
    rollbackToId: number | null = null
  ): number {
    const timestamp = new Date().toISOString();
    const contentHash = crypto
      .createHash('sha256')
      .update(newContent)
      .digest('hex');

    this.db.run(
      `INSERT INTO changes (
        timestamp, file_path, old_content, new_content,
        diff, content_hash, lines_added, lines_removed, batch_id,
        operation_type, rollback_to_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [timestamp, filePath, oldContent, newContent, diff, contentHash, linesAdded, linesRemoved, batchId, operationType, rollbackToId]
    );

    // 获取最后插入的ID
    const result = this.db.exec('SELECT last_insert_rowid() as id');
    const lastId = result[0].values[0][0];
    
    this.save();
    return lastId as number;
  }

  getRecentChanges(limit: number = 100): CodeChange[] {
    const result = this.db.exec(
      `SELECT * FROM changes ORDER BY id DESC LIMIT ?`,
      [limit]
    );

    if (result.length === 0) {
      return [];
    }

    return this.rowsToObjects(result[0]) as CodeChange[];
  }

  getChangeById(id: number): CodeChange | undefined {
    const result = this.db.exec('SELECT * FROM changes WHERE id = ?', [id]);
    
    if (result.length === 0 || result[0].values.length === 0) {
      return undefined;
    }

    const rows = this.rowsToObjects(result[0]);
    return rows[0] as CodeChange;
  }

  getChangesByFile(filePath: string, limit: number = 50): CodeChange[] {
    const result = this.db.exec(
      `SELECT * FROM changes WHERE file_path = ? ORDER BY id DESC LIMIT ?`,
      [filePath, limit]
    );

    if (result.length === 0) {
      return [];
    }

    return this.rowsToObjects(result[0]) as CodeChange[];
  }

  cleanup(maxSize: number) {
    // 保留最近的 maxSize 条记录
    // 注：SQL.js 的 LIMIT 子句不支持参数化，但 maxSize 来自内部配置，安全可控
    this.db.run(`
      DELETE FROM changes
      WHERE id NOT IN (
        SELECT id FROM changes
        ORDER BY id DESC
        LIMIT ${Math.floor(Math.abs(maxSize))}
      )
    `);
    this.save();
  }

  /**
   * 清理超过指定天数的记录
   * @param days 保留天数
   * @returns 删除的记录数
   */
  cleanupOldRecords(days: number): number {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);
    const cutoffISO = cutoffDate.toISOString();

    // 先获取要删除的数量
    const countResult = this.db.exec(
      `SELECT COUNT(*) as count FROM changes WHERE timestamp < ?`,
      [cutoffISO]
    );
    const deleteCount = countResult.length > 0 ? countResult[0].values[0][0] : 0;

    // 执行删除
    this.db.run(
      `DELETE FROM changes WHERE timestamp < ?`,
      [cutoffISO]
    );
    
    if (deleteCount > 0) {
      this.save();
    }
    
    return deleteCount as number;
  }

  /**
   * 删除指定记录
   * @param id 记录ID
   * @returns 是否删除成功
   */
  deleteChange(id: number): boolean {
    try {
      this.db.run('DELETE FROM changes WHERE id = ?', [id]);
      this.save();
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * 标记被回滚覆盖的记录（配置驱动）
   * @param filePath 文件路径
   * @param rollbackId 回滚记录ID
   * @param rollbackToId 回滚目标ID
   * @returns 标记的记录数
   */
  markCoveredByRollback(filePath: string, rollbackId: number, rollbackToId: number): number {
    try {
      // 标记 (rollbackToId, rollbackId) 区间内的记录
      const countResult = this.db.exec(
        'SELECT COUNT(*) as count FROM changes WHERE file_path = ? AND id > ? AND id < ?',
        [filePath, rollbackToId, rollbackId]
      );
      const affectedCount = countResult.length > 0 ? countResult[0].values[0][0] : 0;
      
      this.db.run(
        'UPDATE changes SET covered_by_rollback_id = ? WHERE file_path = ? AND id > ? AND id < ?',
        [rollbackId, filePath, rollbackToId, rollbackId]
      );
      
      if (affectedCount > 0) {
        this.save();
      }
      
      return affectedCount as number;
    } catch (e) {
      console.error('Error marking covered records:', e);
      return 0;
    }
  }

  /**
   * 清除被指定回滚记录覆盖的标记（配置驱动）
   * @param rollbackId 回滚记录ID
   * @returns 清除的记录数
   */
  clearCoveredByRollback(rollbackId: number): number {
    try {
      const countResult = this.db.exec(
        'SELECT COUNT(*) as count FROM changes WHERE covered_by_rollback_id = ?',
        [rollbackId]
      );
      const affectedCount = countResult.length > 0 ? countResult[0].values[0][0] : 0;
      
      this.db.run(
        'UPDATE changes SET covered_by_rollback_id = NULL WHERE covered_by_rollback_id = ?',
        [rollbackId]
      );
      
      if (affectedCount > 0) {
        this.save();
      }
      
      return affectedCount as number;
    } catch (e) {
      console.error('Error clearing covered records:', e);
      return 0;
    }
  }

  /**
   * 清空所有历史记录
   * @returns 删除的记录数
   */
  clearAll(): number {
    // 先获取总数
    const countResult = this.db.exec('SELECT COUNT(*) FROM changes');
    const totalCount = countResult.length > 0 ? countResult[0].values[0][0] as number : 0;
    
    // 清空表
    this.db.run('DELETE FROM changes');
    
    // 重置自增 ID
    this.db.run('DELETE FROM sqlite_sequence WHERE name="changes"');
    
    this.save();
    return totalCount;
  }

  /**
   * 获取数据库统计信息
   */
  getStats(): { totalRecords: number; oldestRecord: string | null; newestRecord: string | null; dbSize: number } {
    const countResult = this.db.exec('SELECT COUNT(*) FROM changes');
    const totalRecords = countResult.length > 0 ? countResult[0].values[0][0] as number : 0;

    const oldestResult = this.db.exec('SELECT MIN(timestamp) FROM changes');
    const oldestRecord = oldestResult.length > 0 ? oldestResult[0].values[0][0] as string | null : null;

    const newestResult = this.db.exec('SELECT MAX(timestamp) FROM changes');
    const newestRecord = newestResult.length > 0 ? newestResult[0].values[0][0] as string | null : null;

    // 获取数据库文件大小
    let dbSize = 0;
    if (fs.existsSync(this.dbPath)) {
      const stat = fs.statSync(this.dbPath);
      dbSize = stat.size;
    }

    return { totalRecords, oldestRecord, newestRecord, dbSize };
  }

  private save() {
    // 将数据库保存到文件
    const data = this.db.export();
    fs.writeFileSync(this.dbPath, data);
  }

  private rowsToObjects(result: any): any[] {
    const columns = result.columns;
    const values = result.values;
    
    return values.map((row: any[]) => {
      const obj: any = {};
      columns.forEach((col: string, index: number) => {
        obj[col] = row[index];
      });
      return obj;
    });
  }

  close() {
    this.save();
    this.db.close();
  }
}
