<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h2>运营概览</h2>
        <p class="page-desc">汇总各业务模块的关键指标，先看总量再看异常；底部可执行跨模块发布检查。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="refresh">重新统计</button>
      </div>
    </header>
    <div class="stat-row">
      <article v-for="card in cards" :key="card.label" class="stat-card">
        <span class="stat-label">{{ card.label }}</span>
        <strong class="stat-value">{{ card.value }}</strong>
      </article>
    </div>
    <table class="data-table">
      <thead>
        <tr>
          <th>业务模块</th><th>今日新增</th><th>待处理</th><th>异常量</th><th>待办</th><th>采样数</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in checklist.modules" :key="row.key">
          <td>{{ row.name }}</td>
          <td>{{ row.total }}</td>
          <td>{{ row.pending }}</td>
          <td :class="{ 'error-text': row.abnormal > 0 }">{{ row.abnormal }}</td>
          <td>{{ row.todos }}</td>
          <td>{{ row.sampleSize }}</td>
        </tr>
      </tbody>
      <tfoot>
        <tr>
          <td>合计（{{ checklist.moduleCount }} 个模块）</td>
          <td>{{ checklist.totalRows }}</td>
          <td>{{ checklist.totalPending }}</td>
          <td>{{ checklist.totalAbnormal }}</td>
          <td>{{ checklist.totalTodos }}</td>
          <td>{{ checklist.totalSamples }}</td>
        </tr>
      </tfoot>
    </table>
    <footer class="page-foot">
      <span>数据保存在本机浏览器里，换浏览器或清缓存会回到示例数据；清单生成于 {{ checklist.generatedAt }}</span>
    </footer>

    <ReleasePanel />
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'

import { loadOverview } from '@/api/local-service'
import type { OverviewResult } from '@/data/types'
import { getChecklist } from '@/release/release-store'
import type { ReleaseChecklist } from '@/release/manifest'
import ReleasePanel from '@/views/release/ReleasePanel.vue'

const cards = ref<OverviewResult['cards']>([])
const checklist = ref<ReleaseChecklist>(getChecklist())

function refresh() {
  const payload = loadOverview()
  cards.value = payload.cards
  checklist.value = getChecklist()
}

onMounted(refresh)
</script>
