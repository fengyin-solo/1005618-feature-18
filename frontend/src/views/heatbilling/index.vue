<template>
  <section class="page" data-module="heatbilling">
    <header class="page-head">
      <div>
        <h2>热费结算管理</h2>
        <p class="page-desc">维护热费结算单，围绕结算编号、用户名称、用热面积、热价标准做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="runRecalc">口径重算</button>
        <button class="btn" type="button" @click="openCreate">登记热费结算单</button>
        <button class="btn" type="button" @click="exportRows">导出热费结算清单</button>
      </div>
    </header>

    <p class="recalc-hint">
      按新热价标准重算应缴金额；已缴费的照原样保留；用热面积超出核定上限
      {{ approvedLimit }}㎡ 或热价填错的转人工复核，结果落到客服台账待确认清单。
    </p>

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
          <td>
            {{ row.status }}
            <span v-if="row.abnormal" class="warn-tag">转人工复核</span>
          </td>
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
          <td :colspan="columns.length + 2" class="empty-state">暂无热费结算数据，可先登记热费结算单</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条热费结算记录</span>
      <span v-if="infoMessage" class="ok-text">{{ infoMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="reductionRow" class="modal-mask" @click.self="closeReduction">
      <div class="modal-box">
        <h3>办理减免 · {{ reductionRow['结算编号'] }}</h3>
        <p class="modal-desc">
          用户：{{ reductionRow['用户名称'] }}；应收上限（应缴金额）：{{ reductionRow['应缴金额'] }} 元。
          减免金额不能超过应收上限，超出不允许保存。
        </p>
        <label class="filter-item">
          <span>减免金额（元）</span>
          <input v-model="reductionAmount" placeholder="不超过应收上限" />
        </label>
        <p v-if="reductionError" class="error-text">{{ reductionError }}</p>
        <div class="modal-actions">
          <button class="btn primary" type="button" @click="saveReduction">保存减免</button>
          <button class="btn ghost" type="button" @click="closeReduction">取消</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  applyReduction,
  APPROVED_AREA_LIMIT,
  downloadEntries,
  listEntries,
  moduleMeta,
  recalcBilling,
  runAction as applyAction,
  submitBilling,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('heatbilling')
const columns = ["结算编号", "用户名称", "用热面积", "热价标准", "应缴金额", "减免金额", "缴费日期", "收费员", "结算状态"]
const actions = ["提交核算", "登记缴费", "办理减免"]
const statuses = ["待核算", "已核算", "已缴费", "已减免"]
const approvedLimit = APPROVED_AREA_LIMIT

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const infoMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

// 统计与列表读同一份行数据，两处应缴金额始终一致。
const stats = computed(() => {
  const pendingCount = rows.value.filter((row) => String(row.status) === '待核算').length
  const paidCount = rows.value.filter((row) => String(row.status) === '已缴费').length
  const receivable = rows.value
    .filter((row) => String(row.status) !== '已缴费')
    .reduce((sum, row) => sum + (Number(row['应缴金额']) || 0), 0)
  return [
    { label: '待核算用户', value: pendingCount },
    { label: '已缴费用户', value: paidCount },
    { label: '本月应收金额', value: Math.round(receivable * 100) / 100 },
  ]
})
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const reductionRow = ref<EntryRow | null>(null)
const reductionAmount = ref('')
const reductionError = ref('')

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '热费结算单登记入口尚未接入审批流'
}

function runRecalc() {
  errorMessage.value = ''
  const result = recalcBilling()
  infoMessage.value = result.message
  reload()
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  infoMessage.value = ''
  if (action === '办理减免') {
    openReduction(row)
    return
  }
  const result =
    action === '提交核算'
      ? submitBilling(Number(row.id))
      : applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  infoMessage.value = result.message
  reload()
}

function openReduction(row: EntryRow) {
  reductionRow.value = row
  reductionAmount.value = String(row['减免金额'] ?? '')
  reductionError.value = ''
}

function closeReduction() {
  reductionRow.value = null
  reductionError.value = ''
}

function saveReduction() {
  if (!reductionRow.value) {
    return
  }
  const result = applyReduction(Number(reductionRow.value.id), reductionAmount.value)
  if (!result.ok) {
    reductionError.value = result.message
    return
  }
  reductionRow.value = null
  reductionError.value = ''
  infoMessage.value = result.message
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '热费结算列表读取失败'
  }
}

onMounted(reload)
</script>
