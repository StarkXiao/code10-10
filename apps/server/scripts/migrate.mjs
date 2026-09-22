#!/usr/bin/env node
/**
 * 数据库初始化（幂等，可反复执行）：
 *   1) prisma generate —— 生成 Client
 *   2) prisma migrate diff —— 由 schema 生成建表 SQL，并落到 prisma/migrations/0001_init/migration.sql
 *   3) 用 Prisma Client 把这份 SQL 应用到 SQLite（仅在还没有表时执行）
 *
 * 为什么不直接用 `prisma db push`：
 *   当前环境（macOS + Node 24）下 Prisma 的 schema engine 子进程在建库这一步会被系统策略拦截，
 *   只报 "Schema engine error"、没有任何细节，且只在部分目录下复现。
 *   换成"生成 SQL + 用 Query Engine 执行"，行为确定、可复现，还顺手留下了一份可读的表结构快照。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(here, '..');
const repoRoot = resolve(serverRoot, '../..');
const schema = resolve(serverRoot, 'prisma/schema.prisma');

process.env.DATABASE_URL ??= `file:${resolve(serverRoot, 'data/app.db')}`;
const migrationsDir = resolve(serverRoot, 'prisma/migrations/0001_init');

// SQLite 文件所在目录必须先存在
for (const dir of [resolve(serverRoot, 'data'), migrationsDir]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function prismaCli(args, options = {}) {
  const { capture = false, withSchema = true } = options;
  const result = spawnSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    withSchema ? ['prisma', ...args, '--schema', schema] : ['prisma', ...args],
    { stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8', cwd: repoRoot, env: process.env },
  );
  return {
    status: result.status ?? 1,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
  };
}

console.log('[migrate] 1/3 prisma generate');
const generate = prismaCli(['generate']);
if (generate.status !== 0) process.exit(generate.status);

console.log('[migrate] 2/3 生成建表 SQL 快照');
// migrate diff 不接受 --schema，只接受 --to-schema-datamodel
const diff = prismaCli(['migrate', 'diff', '--from-empty', '--to-schema-datamodel', schema, '--script'], {
  capture: true,
  withSchema: false,
});
if (diff.status !== 0 || !diff.stdout.trim()) {
  console.error('[migrate] 生成 SQL 失败：', diff.stderr.slice(0, 2000));
  process.exit(1);
}
const sql = diff.stdout;
writeFileSync(resolve(migrationsDir, 'migration.sql'), sql);
console.log(`[migrate] SQL 已写入 prisma/migrations/0001_init/migration.sql（${sql.split('\n').length} 行）`);

console.log('[migrate] 3/3 应用表结构');
const { PrismaClient } = await import('@prisma/client');
const prisma = new PrismaClient();
try {
  const tables = await prisma.$queryRawUnsafe(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma%'",
  );
  if (Array.isArray(tables) && tables.length > 0) {
    console.log(`[migrate] 数据库已有 ${tables.length} 张表，跳过建表`);
  } else {
    const statements = splitStatements(sql);
    for (const statement of statements) {
      await prisma.$executeRawUnsafe(statement);
    }
    console.log(`[migrate] 已执行 ${statements.length} 条建表语句`);
  }

  // 既有数据库的增量升级（只加列/索引，不动数据，可反复执行）。
  // 全量快照 migration.sql 只管新建库；老库靠这里逐列补齐。
  const addedColumns = [
    { table: 'damage_events', column: 'client_op_id', ddl: 'ALTER TABLE "damage_events" ADD COLUMN "client_op_id" TEXT' },
    { table: 'damage_events', column: 'version', ddl: 'ALTER TABLE "damage_events" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1' },
    { table: 'repairs', column: 'client_op_id', ddl: 'ALTER TABLE "repairs" ADD COLUMN "client_op_id" TEXT' },
    { table: 'repairs', column: 'version', ddl: 'ALTER TABLE "repairs" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1' },
  ];
  for (const { table, column, ddl } of addedColumns) {
    const columns = await prisma.$queryRawUnsafe(`PRAGMA table_info("${table}")`);
    if (Array.isArray(columns) && columns.length > 0 && !columns.some((c) => c.name === column)) {
      await prisma.$executeRawUnsafe(ddl);
      console.log(`[migrate] 已为 ${table} 补充列 ${column}`);
    }
  }
  for (const index of [
    'CREATE UNIQUE INDEX IF NOT EXISTS "damage_events_client_op_id_key" ON "damage_events"("client_op_id")',
    'CREATE UNIQUE INDEX IF NOT EXISTS "repairs_client_op_id_key" ON "repairs"("client_op_id")',
  ]) {
    await prisma.$executeRawUnsafe(index);
  }

  const finalTables = await prisma.$queryRawUnsafe(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma%' ORDER BY name",
  );
  console.log(`[migrate] 当前表：${(finalTables ?? []).map((t) => t.name).join(', ')}`);
} finally {
  await prisma.$disconnect();
}
console.log('[migrate] done');

/** 把 Prisma 生成的 SQL 拆成可单独执行的语句（去掉注释与事务包裹） */
function splitStatements(script) {
  const withoutComments = script
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  return withoutComments
    .split(';')
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0 && !/^(BEGIN|COMMIT|PRAGMA\s+foreign_keys)/iu.test(chunk))
    .map((chunk) => `${chunk};`);
}
