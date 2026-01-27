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
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_file_path ON changes(file_path)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_timestamp ON changes(timestamp)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_created_at ON changes(created_at)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_batch_id ON changes(batch_id)`);
    
    this.save();
  }

  insertChange(
    filePath: string,
    oldContent: string,
    newContent: string,
    diff: string,
    linesAdded: number,
    linesRemoved: number,
    batchId: string | null = null
  ): number {
    const timestamp = new Date().toISOString();
    const contentHash = crypto
      .createHash('sha256')
      .update(newContent)
      .digest('hex');

    this.db.run(
      `INSERT INTO changes (
        timestamp, file_path, old_content, new_content,
        diff, content_hash, lines_added, lines_removed, batch_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [timestamp, filePath, oldContent, newContent, diff, contentHash, linesAdded, linesRemoved, batchId]
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
    this.db.run(`
      DELETE FROM changes
      WHERE id NOT IN (
        SELECT id FROM changes
        ORDER BY id DESC
        LIMIT ${maxSize}
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
