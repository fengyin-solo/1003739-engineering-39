<template>
  <section class="release-panel" data-test="release-panel">
    <header class="release-head">
      <div>
        <h3>跨模块发布检查流水线</h3>
        <p class="release-desc">
          本地开发 → 依赖 → 构建 → 部署环境 → 快照 → 旧版本迁移 → 核对清单 → 巡检同步 → 部署 → 采样。
          任一步失败整批回退，并从失败步骤重试；同版本重复执行只保留一个发布批次。
        </p>
      </div>
      <div class="release-actions">
        <label class="inject-select">
          演练失败于
          <select v-model="failAt">
            <option value="">（不注入）</option>
            <option v-for="step in stepOptions" :key="step.key" :value="step.key">{{ step.name }}</option>
          </select>
        </label>
        <button class="btn primary" type="button" :disabled="running" @click="execute">
          {{ running ? '发布中…' : '执行发布检查' }}
        </button>
        <button class="btn" type="button" :disabled="!reportMarkdown" @click="download">下载发布记录</button>
      </div>
    </header>

    <ol class="step-track">
      <li
        v-for="step in stepList"
        :key="step.key"
        class="step-item"
        :class="`is-${step.status}`"
      >
        <span class="step-index">{{ step.index }}</span>
        <span class="step-name">{{ step.name }}</span>
        <span class="step-badge">{{ statusLabel(step.status) }}</span>
        <small v-if="step.status === 'failed'" class="step-error">{{ step.error }}</small>
      </li>
    </ol>

    <div v-if="batch" class="release-meta">
      <span>批次 {{ batch.batchId }}</span>
      <span>状态：<b :class="`tag-${batch.status}`">{{ batchStatusLabel(batch.status) }}</b></span>
      <span>执行 {{ batch.attempt }} 次</span>
      <span>快照 {{ batch.snapshots.length }} 份（只追加）</span>
      <span v-if="retriedNote" class="retry-note">{{ retriedNote }}</span>
    </div>

    <details v-if="batch?.checklist?.length" open class="release-checklist">
      <summary>模块核对清单（总量 / 待处理 / 异常量 / 待办）</summary>
      <table class="data-table">
        <thead>
          <tr><th>业务模块</th><th>总量</th><th>待处理</th><th>异常量</th><th>待办</th></tr>
        </thead>
        <tbody>
          <tr v-for="row in batch.checklist" :key="row.key">
            <td>{{ row.name }}</td>
            <td>{{ row.total }}</td>
            <td :class="{ 'warn-num': row.pending > 0 }">{{ row.pending }}</td>
            <td :class="{ 'err-num': row.abnormal > 0 }">{{ row.abnormal }}</td>
            <td class="todo-cell">
              <span v-for="todo in row.todos" :key="todo.status" class="todo-chip">
                {{ todo.status }}×{{ todo.count}} → {{ todo.suggest }}
              </span>
              <span v-if="!row.todos.length" class="muted">无待办</span>
            </td>
          </tr>
        </tbody>
      </table>
    </details>

    <details v-if="batch?.events.length" class="release-events">
      <summary>可回放事件时间线（{{ batch.events.length }} 条）</summary>
      <ul class="event-list">
        <li v-for="(event, i) in batch.events" :key="i" :class="`event-${event.kind}`">
          <time>{{ event.at }}</time>
          <span class="event-kind">{{ event.kind }}</span>
          <span>{{ event.message }}</span>
        </li>
      </ul>
    </details>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'

import { exportReleaseMarkdown } from '@/release/pipeline'
import { downloadReport, runBrowserRelease } from '@/release/runtime'
import type { ReleaseBatch, StepKey, StepStatus } from '@/release/types'
import { STEP_NAMES, STEP_ORDER } from '@/release/types'

const emit = defineEmits<{ (event: 'finished'): void }>()

const batch = ref<ReleaseBatch | null>(null)
const reportMarkdown = ref('')
const running = ref(false)
const failAt = ref<StepKey | ''>('')
const retried = ref(false)

const stepOptions = STEP_ORDER.map((key) => ({ key, name: STEP_NAMES[key] }))

const stepList = computed(() =>
  STEP_ORDER.map((key, index) => ({
    key,
    index: index + 1,
    name: STEP_NAMES[key],
    status: (batch.value?.steps[key]?.status ?? 'pending') as StepStatus,
    error: batch.value?.steps[key]?.error ?? '',
  })),
)

const retriedNote = computed(() =>
  retried.value && batch.value?.failedAt
    ? `首轮失败于「${STEP_NAMES[batch.value.failedAt]}」，已整批回退并从该步骤重试成功`
    : '',
)

function statusLabel(status: StepStatus): string {
  return {
    pending: '待执行',
    running: '执行中',
    ok: '通过',
    failed: '失败',
    'rolled-back': '已回退',
    kept: '沿用',
  }[status]
}

function batchStatusLabel(status: ReleaseBatch['status']): string {
  return { running: '进行中', 'rolled-back': '已回退', succeeded: '成功' }[status]
}

async function execute(): Promise<void> {
  running.value = true
  // 让面板状态有时间渲染到「执行中」，大批量核对不卡 UI。
  await new Promise((resolve) => setTimeout(resolve, 30))
  try {
    const result = runBrowserRelease({ injectFailureAt: failAt.value || undefined, autoRetry: true })
    batch.value = result.batch
    reportMarkdown.value = result.reportMarkdown || exportReleaseMarkdown(result.batch)
    retried.value = result.retried
    emit('finished')
  } finally {
    running.value = false
  }
}

function download(): void {
  if (batch.value && reportMarkdown.value) {
    downloadReport(reportMarkdown.value, batch.value.batchId)
  }
}
</script>
