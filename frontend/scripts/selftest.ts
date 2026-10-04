/**
 * 发布流水线自测（内存存储模拟浏览器 localStorage）：
 * 1. 正常发布成功；
 * 2. 注入失败 → 整批回退 → 重试成功；
 * 3. 已有快照不丢；
 * 4. 同版本重复执行只有一个批次；
 * 5. 旧版本（无 schemaVersion）数据迁移后字段补齐且业务数据保留；
 * 6. 巡检两个入口写的是同一份数据。
 */
import assert from 'node:assert/strict'
import { SEED_ROWS } from '../src/data/seed'
import {
  DB_DATA_KEY,
  DB_META_KEY,
  DB_SNAPSHOTS_KEY,
  readJson,
  writeJson,
} from '../src/release/db'
import { runReleaseWithRetry } from '../src/release/runner'
import { listBatches } from '../src/release/pipeline'
import { syncInspectionCheckItems } from '../src/release/migrations'
import type { ReleaseOptions, StepKey, StorageAdapter } from '../src/release/types'

class MemoryStorage implements StorageAdapter {
  map = new Map<string, string>()
  getItem(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null
  }
  setItem(key: string, value: string) {
    this.map.set(key, value)
  }
  removeItem(key: string) {
    this.map.delete(key)
  }
}

function options(storage: StorageAdapter, injectFailureAt?: StepKey): ReleaseOptions {
  return {
    storage,
    runtime: {
      appVersion: '1.2.3',
      sourceHash: 'abcdef123456',
      builtAt: new Date('2026-10-04T00:00:00Z').toISOString(),
      requiredDeps: [
        { name: 'vue', declared: '^3.4.21' },
        { name: 'vue-router', declared: '^4.3.0' },
        { name: 'pinia', declared: '^2.1.7' },
      ],
    },
    injectFailureAt,
    autoRetry: true,
    sampleSize: 2,
    now: (() => {
      let n = 0
      return () => new Date(Date.UTC(2026, 9, 4, 0, 0, 0) + n++ * 1000)
    })(),
  }
}

// 1 & 2 & 3：失败-回退-重试，快照不丢
{
  const storage = new MemoryStorage()
  writeJson(storage, DB_DATA_KEY, SEED_ROWS)
  const outcome = runReleaseWithRetry(options(storage, 'sample'))
  assert.equal(outcome.phases[0].status, 'rolled-back')
  assert.equal(outcome.phases[0].failedAt, 'sample')
  assert.equal(outcome.phases[1].status, 'succeeded')
  assert.equal(outcome.batch.status, 'succeeded')
  assert.equal(outcome.batch.attempt, 2)
  const snapshots = readJson(storage, DB_SNAPSHOTS_KEY, [])
  assert.equal(snapshots.length, 1, '整批回退后快照仍保留且不重复')

  // 4：重复执行只有一个批次
  runReleaseWithRetry(options(storage))
  const batches = listBatches(storage)
  assert.equal(batches.length, 1, '同版本只保留一个发布批次')
  assert.equal(batches[0].batchId, 'rel-1.2.3')
}

// 5：旧版本数据迁移，业务数据保留、字段补齐
{
  const storage = new MemoryStorage()
  const legacy = JSON.parse(JSON.stringify(SEED_ROWS))
  // 模拟旧库：无 schemaVersion，记录也没有新字段
  writeJson(storage, DB_DATA_KEY, legacy)
  writeJson(storage, DB_META_KEY, { schemaVersion: 0 })
  const before = readJson(storage, DB_DATA_KEY, {})
  const stationName = before.station[0]['站点名称']
  runReleaseWithRetry(options(storage))
  const after = readJson(storage, DB_DATA_KEY, {})
  const meta = readJson(storage, DB_META_KEY, { schemaVersion: 0 })
  assert.equal(meta.schemaVersion, 2)
  assert.equal(after.station[0]['站点名称'], stationName, '旧业务数据原样保留')
  assert.equal(after.station[0].releasedAt, 'unknown')
  assert.equal(after.station[0].versionTag, 'legacy-v1')
}

// 6：巡检核查项同步幂等，且两个入口共享 inspection
{
  const storage = new MemoryStorage()
  writeJson(storage, DB_DATA_KEY, SEED_ROWS)
  runReleaseWithRetry(options(storage))
  const after1 = readJson(storage, DB_DATA_KEY, {})
  const count1 = after1.inspection.length
  // 再同步一次（模拟巡检页补同步），不重复
  const r = syncInspectionCheckItems(after1, 'rel-1.2.3', '1.2.3')
  assert.equal(r.added, 0)
  assert.equal(after1.inspection.length, count1, '补同步不产生重复核查项')
  assert.ok(count1 > SEED_ROWS.inspection.length, '核查项确实写进了巡检模块')
}

console.log('全部自测通过 ✓')
