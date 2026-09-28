import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

// 用 node:sqlite 模拟 D1 的 prepare / bind / all / batch；batch 与 D1 一样整批事务。
export async function readMigrations(...names) {
  const sources = await Promise.all(names.map(name => readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8')));
  return sources.join('\n');
}

class SqliteD1Statement {
  constructor(owner, sql, values = []) {
    this.owner = owner;
    this.sql = sql;
    this.values = values;
  }
  bind(...values) { return new SqliteD1Statement(this.owner, this.sql, values); }
  _execute() {
    const statement = this.owner.sqlite.prepare(this.sql);
    const results = statement.all(...this.values).map(row => ({ ...row }));
    return { success: true, results, meta: {} };
  }
  async all() { return this._execute(); }
  async run() { return this._execute(); }
  async first(column) {
    const row = this._execute().results[0] || null;
    return column && row ? row[column] : row;
  }
}

export class SqliteD1 {
  constructor(migrationSql) {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec(migrationSql);
  }
  prepare(sql) { return new SqliteD1Statement(this, sql); }
  async batch(statements) {
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map(statement => statement._execute());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }
  rows(sql, ...values) { return this.sqlite.prepare(sql).all(...values).map(row => ({ ...row })); }
}
