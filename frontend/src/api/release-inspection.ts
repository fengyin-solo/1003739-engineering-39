import { invalidateCache, listRows, saveRows } from '@/data/local-store'
import { INSPECTION_CHECK_ITEMS } from '@/release/migrations'
import { getLatestBatch } from '@/release/runtime'
import type { EntryRow } from '@/data/types'

/**
 * 另一个巡检入口：巡检记录页对「发布核查项」的读写。
 * 这些核查项由发布流水线的「巡检核查项同步」步骤写入，本入口可以查看、补同步、
 * 对已执行的核查项逐条勾选完成，两边写的是同一份 inspection 数据。
 */

const CHECK_PROBE = '【发布核查】'

export type ReleaseCheckRow = {
  id: number
  title: string
  status: string
  pending: boolean
  batchRef: string
  date: string
}

function isReleaseCheck(row: EntryRow): boolean {
  return String(row['检查项目'] ?? '').startsWith(CHECK_PROBE) || String(row['站点编号']) === 'RELEASE'
}

export function listReleaseChecks(): ReleaseCheckRow[] {
  return listRows('inspection')
    .filter(isReleaseCheck)
    .map((row) => ({
      id: Number(row.id),
      title: String(row['检查项目'] ?? '').replace(CHECK_PROBE, ''),
      status: String(row.status),
      pending: Boolean(row.pending),
      batchRef: String(row['发现问题'] ?? ''),
      date: String(row['巡检日期'] ?? ''),
    }))
}

/** 巡检入口手动补同步：把缺失的核查项按最新发布批次写入（流水线同步的人工兜底）。 */
export function syncReleaseChecksNow(): { added: number; skipped: number; batchId: string } {
  const batch = getLatestBatch()
  const batchId = batch?.batchId ?? `manual-${new Date().toISOString().slice(0, 10)}`
  const appVersion = batch?.appVersion ?? '0.0.0-manual'
  const rows = [...listRows('inspection')]
  const nextId = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const today = new Date().toISOString().slice(0, 10)
  let added = 0
  let skipped = 0
  INSPECTION_CHECK_ITEMS.forEach((item, index) => {
    const probe = item.slice(0, 12)
    if (rows.some((row) => String(row['检查项目'] ?? '').includes(probe))) {
      skipped += 1
      return
    }
    rows.push({
      id: nextId + index,
      status: '待巡检',
      pending: true,
      abnormal: false,
      记录编号: `INSP-REL-${appVersion.replace(/\./g, '')}-${String(index + 1).padStart(2, '0')}`,
      站点编号: 'RELEASE',
      巡检日期: today,
      巡检人员: '巡检入口补同步',
      检查项目: `【发布核查】${item}`,
      发现问题: batchId,
      处理措施: '按运营概览发布检查流程逐项核查',
      巡检状态: '待巡检',
    })
    added += 1
  })
  saveRows('inspection', rows)
  invalidateCache()
  return { added, skipped, batchId }
}

/** 在巡检入口勾选完成一条发布核查项（状态 → 已巡检，待办消除）。 */
export function completeReleaseCheck(id: number): boolean {
  const rows = [...listRows('inspection')]
  const index = rows.findIndex((row) => Number(row.id) === id && isReleaseCheck(row))
  if (index < 0) {
    return false
  }
  rows[index] = {
    ...rows[index],
    status: '已巡检',
    pending: false,
    abnormal: false,
    巡检状态: '已巡检',
  }
  saveRows('inspection', rows)
  invalidateCache()
  return true
}
