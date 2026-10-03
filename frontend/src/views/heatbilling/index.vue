<template>
  <section class="page" data-module="heatbilling">
    <header class="page-head">
      <div>
        <h2>热费结算管理</h2>
        <p class="page-desc">维护热费结算单，围绕结算编号、用户名称、用热面积、热价标准做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="openCreate">登记热费结算单</button>
        <button class="btn primary" type="button" @click="recalculate">按新热价口径重算</button>
        <button class="btn" type="button" @click="exportRows">导出热费结算清单</button>
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

    <p class="price-note">
      现行热价标准：
      <span v-for="standard in currentPrices" :key="standard.name" class="price-chip">
        {{ standard.name }} {{ standard.price.toFixed(2) }} 元/㎡
      </span>
      （核定用热面积 {{ areaMin }}~{{ areaMax }} ㎡；已缴费单据按老价封存，不参与重算）
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
          <td v-for="column in columns" :key="column">{{ cellText(column, row) }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <template v-if="actionsFor(row).length">
              <button
                v-for="action in actionsFor(row)"
                :key="action"
                class="link"
                type="button"
                @click="runAction(action, row)"
              >
                {{ action }}
              </button>
            </template>
            <span v-else class="muted-text">{{ hintFor(row) }}</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无热费结算数据，可先登记热费结算单</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条热费结算记录，应缴金额统一按「用热面积 × 现行热价」口径计算</span>
      <span v-if="noticeMessage" class="notice-text">{{ noticeMessage }}</span>
      <span v-else-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="reliefOpen" class="modal-mask" @click.self="closeRelief">
      <div class="modal">
        <h3>办理减免</h3>
        <p class="modal-desc">
          {{ reliefForm.结算编号 }} · {{ reliefForm.用户名称 }} · 应收
          {{ reliefForm.receivable === null ? '口径异常' : `${reliefForm.receivable.toFixed(2)} 元` }}
        </p>
        <form class="modal-form" @submit.prevent="confirmRelief">
          <label class="form-item">
            <span>应收上限（元）</span>
            <input v-model="reliefForm.cap" placeholder="按应收金额封顶，不可高于应收" />
          </label>
          <label class="form-item">
            <span>减免金额（元）</span>
            <input v-model="reliefForm.relief" placeholder="不得超过应收上限" />
          </label>
          <p v-if="reliefError" class="error-text">{{ reliefError }}</p>
          <div class="modal-actions">
            <button class="btn ghost" type="button" @click="closeRelief">取消</button>
            <button class="btn primary" type="submit">保存减免</button>
          </div>
        </form>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  recalculateBilling,
  registerPayment,
  saveRelief,
  submitBilling,
} from '@/api/billing-service'
import {
  downloadEntries,
  listEntries,
  moduleMeta,
} from '@/api/local-service'
import { formatMoney, parseAmount, receivableOf, AREA_MIN, AREA_MAX, CURRENT_HEAT_PRICES } from '@/data/pricing'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('heatbilling')
const columns = ["结算编号", "用户名称", "用热面积", "热价标准", "应缴金额", "减免金额", "缴费日期", "收费员", "复核原因"]
const statuses = ["待核算", "已核算", "待复核", "已缴费", "已减免"]
const currentPrices = CURRENT_HEAT_PRICES
const areaMin = AREA_MIN
const areaMax = AREA_MAX

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const stats = computed(() => {
  const count = (status: string) => rows.value.filter((row) => String(row.status) === status).length
  const monthReceivable = rows.value
    .filter((row) => String(row.status) !== '已缴费')
    .reduce((sum, row) => sum + (receivableOf(row) ?? 0), 0)
  return [
    { label: '待核算用户', value: count('待核算') },
    { label: '待复核用户', value: count('待复核') },
    { label: '已缴费用户', value: count('已缴费') },
    { label: '本月应收金额（元）', value: monthReceivable.toFixed(2) },
  ]
})

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 已缴费的照原样保留，直接读封存金额；其余按统一口径实时复算，口径不合法显示待复核。
function cellText(column: string, row: EntryRow): string {
  if (column === '应缴金额') {
    if (String(row.status) === '已缴费') {
      return formatMoney(parseAmount(row[column]))
    }
    const live = receivableOf(row)
    return live === null ? '待人工复核' : formatMoney(live)
  }
  if (column === '复核原因' && !row[column]) {
    return '—'
  }
  const value = row[column]
  return value === undefined || value === '' ? '—' : String(value)
}

function actionsFor(row: EntryRow): string[] {
  switch (String(row.status)) {
    case '待核算':
      return ['提交核算']
    case '已核算':
    case '已减免':
      return ['登记缴费', '办理减免']
    default:
      return []
  }
}

function hintFor(row: EntryRow): string {
  if (String(row.status) === '已缴费') {
    return '已缴费，照原样保留'
  }
  if (String(row.status) === '待复核') {
    return '等待人工复核'
  }
  return ''
}

const reliefOpen = ref(false)
const reliefError = ref('')
const reliefForm = reactive<{ id: number; 结算编号: string; 用户名称: string; receivable: number | null; cap: string; relief: string }>({
  id: 0,
  结算编号: '',
  用户名称: '',
  receivable: null,
  cap: '',
  relief: '',
})

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '热费结算单登记入口尚未接入审批流'
  noticeMessage.value = ''
}

function recalculate() {
  const summary = recalculateBilling()
  const clamped = summary.reliefClamped.length
    ? `，其中 ${summary.reliefClamped.length} 户减免金额超出新应收已夹回上限`
    : ''
  noticeMessage.value = `重算完成：${summary.updated} 单按新热价更新，${summary.review} 单转人工复核，${summary.skipped} 单已缴费保留${clamped}；结果已进入客服台账待确认清单`
  errorMessage.value = ''
  reload()
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  if (action === '办理减免') {
    openRelief(row)
    return
  }
  const result = action === '提交核算' ? submitBilling(Number(row.id)) : registerPayment(Number(row.id))
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  reload()
}

function openRelief(row: EntryRow) {
  reliefForm.id = Number(row.id)
  reliefForm.结算编号 = String(row['结算编号'] ?? '')
  reliefForm.用户名称 = String(row['用户名称'] ?? '')
  reliefForm.receivable = receivableOf(row)
  reliefForm.cap = reliefForm.receivable === null ? '' : String(reliefForm.receivable)
  reliefForm.relief = String(parseAmount(row['减免金额']) ?? '')
  reliefError.value = ''
  reliefOpen.value = true
}

function closeRelief() {
  reliefOpen.value = false
  reliefError.value = ''
}

function confirmRelief() {
  const result = saveRelief(reliefForm.id, reliefForm.cap, reliefForm.relief)
  if (!result.ok) {
    reliefError.value = result.message
    return
  }
  noticeMessage.value = result.message
  errorMessage.value = ''
  closeRelief()
  reload()
}

function reload() {
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
