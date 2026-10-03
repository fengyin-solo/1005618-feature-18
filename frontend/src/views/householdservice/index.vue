<template>
  <section class="page" data-module="householdservice">
    <header class="page-head">
      <div>
        <h2>入户服务管理</h2>
        <p class="page-desc">维护入户服务单，围绕服务单号、报修用户、服务内容、受理人做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记入户服务单</button>
        <button class="btn" type="button" @click="exportRows">导出入户服务清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

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
          <td :colspan="columns.length + 2" class="empty-state">暂无入户服务数据，可先登记入户服务单</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条入户服务记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <section class="ledger-block">
      <header class="page-head">
        <div>
          <h3>客服台账 · 待确认清单</h3>
          <p class="page-desc">热价调整重算、提交核算与办理减免的结果按结算单落到这里（重复提交只保留一条）；应缴金额与热费结算页同一口径实时复算。</p>
        </div>
        <div class="page-actions">
          <button class="btn" type="button" @click="reloadQueue">刷新清单</button>
        </div>
      </header>
      <table class="data-table">
        <thead>
          <tr>
            <th>结算编号</th>
            <th>用户名称</th>
            <th>用热面积（㎡）</th>
            <th>热价标准</th>
            <th>应缴金额（元）</th>
            <th>减免金额（元）</th>
            <th>复核原因</th>
            <th>来源</th>
            <th>登记时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in queue" :key="item.billingId">
            <td>{{ item.结算编号 }}</td>
            <td>{{ item.用户名称 }}</td>
            <td>{{ item.用热面积 }}</td>
            <td>{{ item.热价标准 }}</td>
            <td>{{ queueReceivable(item) }}</td>
            <td>{{ item.减免金额 === null ? '—' : item.减免金额.toFixed(2) }}</td>
            <td>{{ item.复核原因 || '—' }}</td>
            <td>{{ item.来源 }}</td>
            <td>{{ item.登记时间 }}</td>
            <td class="row-actions">
              <button class="link" type="button" @click="confirmQueue(item.billingId)">确认</button>
            </td>
          </tr>
          <tr v-if="!queue.length">
            <td colspan="10" class="empty-state">待确认清单为空，热费侧重算或核算后会自动落入这里</td>
          </tr>
        </tbody>
      </table>
      <footer class="page-foot">
        <span>待确认 {{ queue.length }} 条</span>
      </footer>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { liveReceivable } from '@/api/billing-service'
import { listPendingConfirm, removePendingConfirm } from '@/data/pending-queue'
import { formatMoney } from '@/data/pricing'
import type { EntryRow, PendingConfirmItem } from '@/data/types'

const meta = moduleMeta('householdservice')
const columns = ["服务单号", "报修用户", "服务内容", "受理人", "上门时间", "处理结果", "回访日期", "服务状态"]
const actions = ["受理报修", "登记处理", "完成回访"]
const statuses = ["待受理", "已安排", "已处理", "已回访"]
const stats = [{"label": "待受理服务单", "value": 0}, {"label": "已处理服务单", "value": 0}, {"label": "待回访服务单", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const queue = ref<PendingConfirmItem[]>([])
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '入户服务单登记入口尚未接入审批流'
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
    errorMessage.value = error instanceof Error ? error.message : '入户服务列表读取失败'
  }
}

// 待确认清单的应缴金额走结算口径实时复算，保证两处读到的金额一致
function queueReceivable(item: PendingConfirmItem): string {
  return formatMoney(liveReceivable(item))
}

function reloadQueue() {
  queue.value = listPendingConfirm()
}

function confirmQueue(billingId: number) {
  queue.value = removePendingConfirm(billingId)
}

onMounted(() => {
  reload()
  reloadQueue()
})
</script>
