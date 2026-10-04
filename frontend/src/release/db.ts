import { MODULES } from '../data/modules'
import type {
  EntryLike,
  ModuleChecklistRow,
  SampleFinding,
  StorageAdapter,
} from './types'

/**
 * 数据库访问层：快照、清单、采样都是纯函数式的数据处理，
 * 只通过 StorageAdapter 读写，方便 Node 侧注入内存存储做回放测试。
 */

export const DB_DATA_KEY = 'hydrology-monitor-station:entries'
export const DB_META_KEY = 'hydrology-monitor-station:db-meta'
export const DB_SNAPSHOTS_KEY = 'hydrology-monitor-station:snapshots'
export const RELEASE_RECORDS_KEY = 'hydrology-monitor-station:releases'

export type DatabaseMeta = {
  schemaVersion: number
  updatedAt: string
}

export function readJson<T>(storage: StorageAdapter, key: string, fallback: T): T {
  const raw = storage.getItem(key)
  if (raw === null) {
    return fallback
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function writeJson(storage: StorageAdapter, key: string, value: unknown): void {
  storage.setItem(key, JSON.stringify(value))
}

export function readDatabase(storage: StorageAdapter): {
  data: Record<string, EntryLike[]>
  meta: DatabaseMeta
} {
  const data = readJson<Record<string, EntryLike[]>>(storage, DB_DATA_KEY, {})
  const meta = readJson<DatabaseMeta | null>(storage, DB_META_KEY, null)
  return {
    data,
    meta: meta ?? { schemaVersion: 0, updatedAt: new Date(0).toISOString() },
  }
}

/** 简单确定性校验和（FNV-1a），用于核对快照内容是否被改动，不追求抗碰撞。 */
export function checksum(value: unknown): string {
  const text = JSON.stringify(value)
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function listSnapshots(
  storage: StorageAdapter,
): {
  id: string
  batchId: string
  appVersion: string
  schemaBefore: number
  schemaAfter: number
  checksum: string
  createdAt: string
  rows: Record<string, EntryLike[]>
}[] {
  return readJson(storage, DB_SNAPSHOTS_KEY, [])
}

/**
 * 生成整库快照。快照只追加，永不覆盖、永不删除；
 * 同一批次重复执行时返回已有快照（保证幂等且不产生重复快照）。
 */
export function appendSnapshot(input: {
  storage: StorageAdapter
  batchId: string
  appVersion: string
  schemaBefore: number
  schemaAfter: number
  rows: Record<string, EntryLike[]>
  now: string
}): { id: string; reused: boolean } {
  const all = listSnapshots(input.storage)
  const existing = all.find((item) => item.batchId === input.batchId)
  if (existing) {
    return { id: existing.id, reused: true }
  }
  const id = `snap-${input.appVersion.replace(/\./g, '-')}-${input.now.replace(/[-:T.Z]/g, '').slice(0, 14)}`
  const record = {
    id,
    batchId: input.batchId,
    appVersion: input.appVersion,
    schemaBefore: input.schemaBefore,
    schemaAfter: input.schemaAfter,
    checksum: checksum(input.rows),
    rows: input.rows,
    createdAt: input.now,
  }
  all.push(record)
  writeJson(input.storage, DB_SNAPSHOTS_KEY, all)
  return { id, reused: false }
}

/** 用指定快照整库还原（回退用）；快照本身不删除。 */
export function restoreSnapshot(
  storage: StorageAdapter,
  snapshotId: string,
): { appVersion: string; schemaVersion: number } {
  const all = listSnapshots(storage)
  const target = all.find((item) => item.id === snapshotId)
  if (!target) {
    throw new Error(`快照 ${snapshotId} 不存在，无法回退`)
  }
  writeJson(storage, DB_DATA_KEY, target.rows)
  writeJson(storage, DB_META_KEY, {
    schemaVersion: target.schemaBefore,
    updatedAt: new Date().toISOString(),
    rolledBackTo: target.id,
  })
  return { appVersion: target.appVersion, schemaVersion: target.schemaBefore }
}

/**
 * 终态判定：状态机里显式放在最后的状态（已撤销/已停用 等收尾态），
 * 加上各模块通用的正向闭环状态。这些状态不再产生待办。
 */
const POSITIVE_TERMINALS = new Set([
  '已通过',
  '已复核',
  '已校核',
  '已刊印',
  '已完成',
  '已验收',
  '已合格',
  '已处置',
  '已批准',
])

export function isTerminalStatus(meta: { statuses: string[] }, status: string): boolean {
  return status === meta.statuses[meta.statuses.length - 1] || POSITIVE_TERMINALS.has(status)
}

/**
 * 模块核对清单：各业务模块的总量、待处理、异常量，以及按非终态状态聚合的待办。
 */
export function buildChecklist(data: Record<string, EntryLike[]>): ModuleChecklistRow[] {
  return MODULES.map((meta) => {
    const rows = data[meta.key] ?? []
    const grouped = new Map<string, number>()
    for (const row of rows) {
      if (!isTerminalStatus(meta, String(row.status))) {
        grouped.set(String(row.status), (grouped.get(String(row.status)) ?? 0) + 1)
      }
    }
    const todos = [...grouped.entries()].map(([status, count]) => {
      // 状态名里找得到对应动作就推荐「状态 → 动作」，否则提示处置。
      const action = Object.entries(meta.actionTargets).find(
        ([, target]) => target === status,
      )?.[0]
      return {
        status,
        count,
        suggest: action ? `执行「${action}」推进状态` : '安排人工处置',
      }
    })
    return {
      key: meta.key,
      name: meta.name,
      total: rows.length,
      pending: rows.filter((row) => row.pending).length,
      abnormal: rows.filter((row) => row.abnormal).length,
      todos,
    }
  })
}

/**
 * 上线采样：确定性等距抽样（首/中/尾固定起点），同一份数据每次抽到同样的记录。
 * 逐条核对：状态合法、pending/abnormal 标记与状态机一致、必填字段（取前三个）非空。
 */
export function sampleData(
  data: Record<string, EntryLike[]>,
  sizePerModule: number,
): SampleFinding[] {
  const findings: SampleFinding[] = []
  for (const meta of MODULES) {
    const rows = data[meta.key] ?? []
    if (rows.length === 0) {
      continue
    }
    const take = Math.min(sizePerModule, rows.length)
    const picked = new Set<number>()
    if (take === rows.length) {
      rows.forEach((_, index) => picked.add(index))
    } else {
      // 等距抽样，起点固定 0，保证可回放。
      const step = rows.length / take
      for (let i = 0; i < take; i += 1) {
        picked.add(Math.min(rows.length - 1, Math.floor(i * step)))
      }
    }
    const requiredFields = meta.fields.slice(0, 3)
    for (const index of [...picked].sort((a, b) => a - b)) {
      const row = rows[index]
      const problems: string[] = []
      if (!meta.statuses.includes(String(row.status))) {
        problems.push(`状态「${row.status}」不在状态机 ${meta.statuses.join('/')} 内`)
      }
      for (const field of requiredFields) {
        if (row[field] === undefined || row[field] === null || String(row[field]) === '') {
          problems.push(`必填字段「${field}」为空`)
        }
      }
      findings.push({
        moduleKey: meta.key,
        id: Number(row.id),
        status: String(row.status),
        ok: problems.length === 0,
        problems,
      })
    }
  }
  return findings
}
