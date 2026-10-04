import type { EntryLike, Migration } from './types'

/**
 * 数据库迁移（localStorage 即本系统的数据库）。
 *
 * 迁移方式：
 * - 整库带 schemaVersion 版本号，从旧版本只升不降，按版本号顺序逐版本 up()。
 * - 每个迁移只做「补」不做「删」：新模块补齐示例数据、老记录补齐新字段，
 *   绝不覆盖浏览器里已经积累的业务数据；已有快照始终保留在独立键里，不参与迁移。
 * - up() 全部原地幂等：重复执行结果一致。
 */

export const CURRENT_SCHEMA_VERSION = 2

const DATA_KEY_MODULES = [
  'station',
  'waterlevel',
  'discharge',
  'rainfall',
  'waterquality',
  'crosssection',
  'telemetry',
  'compilation',
  'warning',
  'groundwater',
  'evaporation',
  'cableway',
  'sediment',
  'communication',
  'stationhouse',
  'calibration',
  'inspection',
  'plan',
] as const

/** 巡检核查项：另一个巡检入口同步写入的固定检查项模板。 */
export const INSPECTION_CHECK_ITEMS = [
  '发布批次核对：版本、批次号与发布记录一致',
  '快照核对：发布前快照已生成且可回放',
  '迁移核对：schemaVersion 已升至当前版本，旧数据无丢失',
  '模块清单核对：各模块待处理/异常量与运营概览一致',
  '采样核对：抽样记录字段完整、状态合法',
]

/** 把发布检查项同步写入「巡检记录」业务模块：缺项追加，已有同题检查项不重复。 */
export function syncInspectionCheckItems(
  data: Record<string, unknown>,
  batchId: string,
  appVersion: string,
): { added: number; skipped: number } {
  const list = Array.isArray(data.inspection) ? (data.inspection as EntryLike[]) : []
  const nextId = list.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const today = new Date().toISOString().slice(0, 10)
  let added = 0
  let skipped = 0
  INSPECTION_CHECK_ITEMS.forEach((item, index) => {
    const title = `【发布核查】${item}`
    const exists = list.some(
      (row) => String(row['检查项目'] ?? '').includes(item.slice(0, 12)),
    )
    if (exists) {
      skipped += 1
      return
    }
    list.push({
      id: nextId + index,
      status: '待巡检',
      pending: true,
      abnormal: false,
      记录编号: `INSP-REL-${appVersion.replace(/\./g, '')}-${String(index + 1).padStart(2, '0')}`,
      站点编号: 'RELEASE',
      巡检日期: today,
      巡检人员: '发布流水线',
      检查项目: title,
      发现问题: `发布批次 ${batchId}`,
      处理措施: '按运营概览发布检查流程逐项核查',
      巡检状态: '待巡检',
    })
    added += 1
  })
  data.inspection = list
  return { added, skipped }
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    title: '初始化整库版本号',
    description: '为无版本号的旧 localStorage 数据补上 schemaVersion=1，数据原样保留。',
    up: () => {
      // 只标记版本，数据不动；版本号由调用方在迁移成功后写入。
    },
  },
  {
    version: 2,
    title: '补齐发布核查字段',
    description:
      '给全部业务记录补齐 releasedAt/versionTag 字段（旧数据回填 unknown/legacy-v1，不覆盖已有值）。',
    up: (data) => {
      for (const key of DATA_KEY_MODULES) {
        const rows = data[key]
        if (!Array.isArray(rows)) {
          continue
        }
        for (const row of rows as EntryLike[]) {
          if (typeof row.releasedAt !== 'string') {
            row.releasedAt = 'unknown'
          }
          if (typeof row.versionTag !== 'string') {
            row.versionTag = 'legacy-v1'
          }
        }
      }
    },
  },
]

/** 计算需要执行的迁移链；已是最新版本时返回空数组（重复执行安全）。 */
export function pendingMigrations(from: number): Migration[] {
  return MIGRATIONS.filter((migration) => migration.version > from).sort(
    (a, b) => a.version - b.version,
  )
}
