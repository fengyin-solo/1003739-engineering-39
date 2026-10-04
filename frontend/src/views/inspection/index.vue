<template>
  <section class="page" data-module="inspection">
    <header class="page-head">
      <div>
        <h2>巡检记录管理</h2>
        <p class="page-desc">维护巡检记录，围绕记录编号、站点编号、巡检日期、巡检人员做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记巡检记录</button>
        <button class="btn" type="button" @click="exportRows">导出巡检记录清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <section class="release-check-panel">
      <header class="release-check-head">
        <div>
          <h3>发布核查项（与运营概览发布流水线同步）</h3>
          <p class="page-desc">发布流水线执行「巡检核查项同步」时写入同一批核查项；此处可补同步、逐条核查完成。</p>
        </div>
        <button class="btn" type="button" @click="syncChecks">补同步核查项</button>
      </header>
      <table class="data-table" v-if="releaseChecks.length">
        <thead>
          <tr><th>核查项</th><th>关联批次</th><th>日期</th><th>状态</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in releaseChecks" :key="item.id">
            <td>{{ item.title }}</td>
            <td>{{ item.batchRef }}</td>
            <td>{{ item.date }}</td>
            <td>{{ item.status }}</td>
            <td>
              <button v-if="item.pending" class="link" type="button" @click="finishCheck(item.id)">核查完成</button>
              <span v-else class="muted">已闭环</span>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty-state">还没有发布核查项，先到运营概览执行发布检查，或点「补同步核查项」</p>
      <span v-if="checkMessage" class="sync-message">{{ checkMessage }}</span>
    </section>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无巡检记录数据，可先登记巡检记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条巡检记录记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  completeReleaseCheck,
  listReleaseChecks,
  syncReleaseChecksNow,
  type ReleaseCheckRow,
} from '@/api/release-inspection'
import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('inspection')
const columns = ["记录编号", "站点编号", "巡检日期", "巡检人员", "检查项目", "发现问题", "处理措施", "巡检状态"]
const actions = ["完成巡检", "报告故障", "确认处置"]
const statuses = ["待巡检", "已巡检", "发现故障", "已处置"]
const stats = [{"label": "本月巡检次数", "value": 0}, {"label": "已巡检站点", "value": 0}, {"label": "待处置故障", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const releaseChecks = ref<ReleaseCheckRow[]>([])
const checkMessage = ref('')
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function loadReleaseChecks() {
  releaseChecks.value = listReleaseChecks()
}

function syncChecks() {
  const result = syncReleaseChecksNow()
  checkMessage.value = `已补同步：新增 ${result.added} 项，跳过已存在 ${result.skipped} 项（批次 ${result.batchId}）`
  loadReleaseChecks()
  reload()
}

function finishCheck(id: number) {
  completeReleaseCheck(id)
  loadReleaseChecks()
  reload()
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '巡检记录登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '巡检记录列表读取失败'
  }
}

onMounted(() => {
  reload()
  loadReleaseChecks()
})
</script>
