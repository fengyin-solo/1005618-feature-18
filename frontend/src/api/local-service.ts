import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// —— 热费结算：口径重算、减免上限、复核工单 ——

export const BILLING_MODULE_KEY = 'heatbilling'
export const SERVICE_MODULE_KEY = 'householdservice'

// 核定用热面积上限（㎡）：超出这个范围一律转人工复核，不自动落账。
export const APPROVED_AREA_LIMIT = 200

// 重算结果工单的单号前缀：挂在客服台账（入户服务）的待确认清单里。
export const RECALC_TICKET_PREFIX = 'RECALC-'

/** 严格解析数值：空串、非有限数都按填错处理。 */
export function parseMeterValue(raw: unknown): number | null {
  const text = String(raw ?? '').trim()
  if (text === '') {
    return null
  }
  const value = Number(text)
  return Number.isFinite(value) ? value : null
}

/** 既有结算口径：应缴金额 = 用热面积 × 热价标准，保留两位小数。 */
export function computePayable(area: number, price: number): number {
  return Math.round(area * price * 100) / 100
}

/** 减免金额的上限就是这张单的应收（应缴）金额；上限本身无效时返回 null。 */
export function reductionCap(row: EntryRow): number | null {
  const cap = parseMeterValue(row['应缴金额'])
  if (cap === null || cap < 0) {
    return null
  }
  return cap
}

type BillingCheck = { area: number; price: number; problems: string[] }

function checkBillingRow(row: EntryRow): BillingCheck {
  const area = parseMeterValue(row['用热面积'])
  const price = parseMeterValue(row['热价标准'])
  const problems: string[] = []
  if (area === null || area <= 0) {
    problems.push('用热面积填错')
  } else if (area > APPROVED_AREA_LIMIT) {
    problems.push(`用热面积 ${area}㎡ 超出核定范围（核定上限 ${APPROVED_AREA_LIMIT}㎡）`)
  }
  if (price === null || price <= 0) {
    problems.push('热价标准填错')
  }
  return { area: area ?? 0, price: price ?? 0, problems }
}

type TicketUpdate = { bill: EntryRow; content: string; review: boolean }

/** 重算结果落客服台账的待确认清单：同一结算编号重复提交也只留一条待确认工单。 */
function syncRecalcTickets(updates: TicketUpdate[]): void {
  if (updates.length === 0) {
    return
  }
  const next = [...listRows(SERVICE_MODULE_KEY)]
  let maxId = next.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0)
  for (const { bill, content, review } of updates) {
    const ticketNo = `${RECALC_TICKET_PREFIX}${String(bill['结算编号'] ?? '')}`
    const payload = {
      报修用户: String(bill['用户名称'] ?? ''),
      服务内容: content,
      处理结果: '待确认',
      服务状态: '待确认',
    }
    const index = next.findIndex(
      (row) => String(row['服务单号']) === ticketNo && String(row.status) === '待受理',
    )
    if (index >= 0) {
      next[index] = { ...next[index], ...payload, abnormal: review }
    } else {
      maxId += 1
      next.push({
        id: maxId,
        status: '待受理',
        pending: true,
        abnormal: review,
        服务单号: ticketNo,
        受理人: '待分配',
        上门时间: '',
        回访日期: '',
        ...payload,
      })
    }
  }
  saveRows(SERVICE_MODULE_KEY, next)
}

export type RecalcResult = ActionResult & {
  recalculated: number
  keptPaid: number
  review: number
}

/** 口径重算：按新热价标准重算应缴金额；已缴费的照原样保留；面积超核定或热价填错的转人工复核。 */
export function recalcBilling(): RecalcResult {
  const rows = listRows(BILLING_MODULE_KEY)
  let recalculated = 0
  let keptPaid = 0
  let review = 0
  const ticketUpdates: TicketUpdate[] = []
  const next = rows.map((row) => {
    if (String(row.status) === '已缴费') {
      keptPaid += 1
      return row
    }
    const { area, price, problems } = checkBillingRow(row)
    if (problems.length > 0) {
      review += 1
      const updated: EntryRow = { ...row, abnormal: true, pending: true }
      ticketUpdates.push({
        bill: updated,
        content: `口径重算转人工复核：${problems.join('；')}`,
        review: true,
      })
      return updated
    }
    const payable = computePayable(area, price)
    recalculated += 1
    const updated: EntryRow = { ...row, 应缴金额: payable, abnormal: false }
    if (String(row.status) === '已减免') {
      // 减免金额按应收金额的上限卡：重算后应收变少时，减免同步压回上限内。
      const reduction = parseMeterValue(row['减免金额']) ?? 0
      updated['减免金额'] = Math.min(reduction, payable)
    }
    ticketUpdates.push({
      bill: updated,
      content: `口径重算待确认：用热面积 ${area}㎡ × 热价标准 ${price} 元/㎡，重算后应缴金额 ${payable} 元`,
      review: false,
    })
    return updated
  })
  saveRows(BILLING_MODULE_KEY, next)
  syncRecalcTickets(ticketUpdates)
  return {
    ok: true,
    recalculated,
    keptPaid,
    review,
    message: `口径重算完成：重算 ${recalculated} 户，已缴费保留 ${keptPaid} 户，转人工复核 ${review} 户，结果已落到客服台账待确认清单`,
  }
}

/** 提交核算：先按既有口径算出应缴金额再转已核算；面积或热价有问题的转人工复核。 */
export function submitBilling(id: number): ActionResult {
  const rows = listRows(BILLING_MODULE_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的热费结算单` }
  }
  const row = rows[index]
  const current = String(row.status)
  if (current === '已核算') {
    return { ok: false, message: '热费结算单已经是「已核算」，不用重复操作' }
  }
  if (current !== '待核算') {
    return { ok: false, message: `热费结算单当前状态「${current}」，不能提交核算` }
  }
  const { area, price, problems } = checkBillingRow(row)
  if (problems.length > 0) {
    const next = [...rows]
    next[index] = { ...row, abnormal: true, pending: true }
    saveRows(BILLING_MODULE_KEY, next)
    syncRecalcTickets([
      { bill: next[index], content: `提交核算转人工复核：${problems.join('；')}`, review: true },
    ])
    return { ok: false, message: `热费结算单已转人工复核：${problems.join('；')}` }
  }
  const payable = computePayable(area, price)
  const next = [...rows]
  next[index] = {
    ...row,
    status: '已核算',
    pending: true,
    abnormal: false,
    应缴金额: payable,
    结算状态: '已核算',
  }
  saveRows(BILLING_MODULE_KEY, next)
  return { ok: true, message: `热费结算单已提交核算，应缴金额 ${payable} 元` }
}

/** 办理减免：减免金额按应收金额的上限卡，超出上限或上限无效都不允许保存。 */
export function applyReduction(id: number, rawAmount: string): ActionResult {
  const rows = listRows(BILLING_MODULE_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的热费结算单` }
  }
  const row = rows[index]
  if (String(row.status) === '已缴费') {
    return { ok: false, message: '已缴费的结算单照原样保留，不能再办理减免' }
  }
  const amount = parseMeterValue(rawAmount)
  if (amount === null || amount < 0) {
    return { ok: false, message: `减免金额「${rawAmount}」不是有效数值，已挡回，未保存` }
  }
  const cap = reductionCap(row)
  if (cap === null) {
    return { ok: false, message: '应收上限（应缴金额）不是有效数值，已挡回，请先口径重算' }
  }
  if (amount > cap) {
    return { ok: false, message: `减免金额 ${amount} 元超出应收上限 ${cap} 元，不允许保存` }
  }
  const next = [...rows]
  next[index] = {
    ...row,
    status: '已减免',
    pending: false,
    abnormal: false,
    减免金额: amount,
    结算状态: '已减免',
  }
  saveRows(BILLING_MODULE_KEY, next)
  return { ok: true, message: `已办理减免 ${amount} 元（应收上限 ${cap} 元），结算单已转「已减免」` }
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
