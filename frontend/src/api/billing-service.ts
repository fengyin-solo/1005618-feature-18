import { listRows, saveRows } from '@/data/local-store'
import { upsertPendingConfirm } from '@/data/pending-queue'
import {
  parseAmount,
  receivableOf,
  round2,
  validateBillingRow,
} from '@/data/pricing'
import type { ActionResult, EntryRow, PendingConfirmItem } from '@/data/types'

// 热费结算业务动作：金额一律走 pricing.ts 的统一口径，本文件只做状态流转、
// 人工复核分流、减免上限校验，以及客服台账待确认清单的去重落地。

const KEY = 'heatbilling'
const CENT = 0.005

export type RecalcSummary = {
  updated: number
  review: number
  skipped: number
  reliefClamped: number[]
}

function nowStamp(): string {
  const date = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  )
}

function toQueueItem(row: EntryRow, source: string, reason = ''): PendingConfirmItem {
  const area = parseAmount(row['用热面积'])
  return {
    billingId: Number(row.id),
    结算编号: String(row['结算编号'] ?? ''),
    用户名称: String(row['用户名称'] ?? ''),
    用热面积: area ?? 0,
    热价标准: String(row['热价标准'] ?? ''),
    应缴金额: receivableOf(row),
    减免金额: parseAmount(row['减免金额']),
    复核原因: reason,
    来源: source,
    登记时间: nowStamp(),
  }
}

function patchRow(rows: EntryRow[], id: number, patch: Partial<EntryRow>): EntryRow[] {
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return rows
  }
  const next = [...rows]
  next[index] = { ...next[index], ...patch } as EntryRow
  saveRows(KEY, next)
  return next
}

/**
 * 按新热价口径批量重算：
 * - 已缴费的结算单原样保留，金额、状态都不动，也不进待确认清单；
 * - 用热面积超出核定范围或热价不在现行标准内 → 转人工复核（待复核/异常），不改金额；
 * - 其余按「面积 × 现行热价」重算应缴金额，热价标准规范为现行名称；
 * - 已减免户减免金额超过新应收上限的，夹到应收上限；
 * - 结果按结算单 id 去重落到客服台账待确认清单。
 */
export function recalculateBilling(): RecalcSummary {
  const rows = listRows(KEY)
  const summary: RecalcSummary = { updated: 0, review: 0, skipped: 0, reliefClamped: [] }
  const next: EntryRow[] = []

  for (const row of rows) {
    if (String(row.status) === '已缴费') {
      // 钱已经收了，调价不追溯，照原样保留
      summary.skipped += 1
      next.push(row)
      continue
    }

    const result = validateBillingRow(row)
    if (!result.ok) {
      summary.review += 1
      next.push({
        ...row,
        status: '待复核',
        pending: true,
        abnormal: true,
        复核原因: result.reason,
      })
      upsertPendingConfirm(toQueueItem(row, '热价调整重算', result.reason))
      continue
    }

    const patch = {
      ...row,
      热价标准: result.standard.name,
      应缴金额: result.receivable,
      复核原因: '',
      abnormal: false,
      pending: true,
    } as EntryRow

    // 已减免户：减免金额按新应收重新卡上限，超出的夹回应收
    if (String(row.status) === '已减免') {
      const relief = parseAmount(row['减免金额'])
      if (relief !== null && relief > result.receivable + CENT) {
        patch.减免金额 = result.receivable
        summary.reliefClamped.push(Number(row.id))
      }
    }

    // 待复核的单子数据恢复正常后回到已核算；待核算的单子还没提交过，保持待核算
    if (String(row.status) === '待复核') {
      patch.status = '已核算'
    }
    summary.updated += 1
    next.push(patch)
    upsertPendingConfirm(toQueueItem(patch, '热价调整重算'))
  }

  saveRows(KEY, next)
  return summary
}

/** 提交核算：按统一口径算应缴金额；面积/热价不合法的不硬算，转人工复核。重复提交不新增清单。 */
export function submitBilling(id: number): ActionResult {
  const rows = listRows(KEY)
  const row = rows.find((entry) => Number(entry.id) === id)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${id} 的热费结算单` }
  }
  if (String(row.status) === '已核算') {
    return { ok: false, message: '该结算单已经是「已核算」，不用重复操作' }
  }
  if (String(row.status) === '已缴费') {
    return { ok: false, message: '该结算单已缴费，按原口径保留，不能重新核算' }
  }

  const result = validateBillingRow(row)
  if (!result.ok) {
    patchRow(rows, id, {
      status: '待复核',
      pending: true,
      abnormal: true,
      复核原因: result.reason,
    })
    upsertPendingConfirm(toQueueItem({ ...row, 复核原因: result.reason }, '提交核算', result.reason))
    return { ok: true, message: `面积或热价不合法，已转人工复核：${result.reason}` }
  }

  patchRow(rows, id, {
    status: '已核算',
    pending: true,
    abnormal: false,
    热价标准: result.standard.name,
    应缴金额: result.receivable,
    复核原因: '',
  })
  const updated = { ...row, status: '已核算', 热价标准: result.standard.name, 应缴金额: result.receivable }
  upsertPendingConfirm(toQueueItem(updated, '提交核算'))
  return { ok: true, message: `核算完成，应缴金额 ${result.receivable.toFixed(2)} 元，已进入客服待确认清单` }
}

/** 登记缴费：已缴费照原样保留，重复登记直接挡回 */
export function registerPayment(id: number): ActionResult {
  const rows = listRows(KEY)
  const row = rows.find((entry) => Number(entry.id) === id)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${id} 的热费结算单` }
  }
  if (String(row.status) === '已缴费') {
    return { ok: false, message: '该结算单已经缴费，不用重复登记' }
  }
  if (String(row.status) === '待复核') {
    return { ok: false, message: '该结算单在人工复核中，复核完成后才能登记缴费' }
  }
  patchRow(rows, id, { status: '已缴费', pending: false, abnormal: false, 缴费日期: nowStamp().slice(0, 10) })
  return { ok: true, message: '缴费已登记，结算单按原口径封存保留' }
}

/**
 * 办理减免：
 * - 应收上限必须是大于 0 的有效值，且不能高于该单按口径算出的应收金额；
 * - 减免金额必须在 0 到应收上限之间，超出上限不允许保存；
 * - 保存后进入客服待确认清单（按结算单 id 去重）。
 */
export function saveRelief(id: number, capRaw: string, reliefRaw: string): ActionResult {
  const rows = listRows(KEY)
  const row = rows.find((entry) => Number(entry.id) === id)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${id} 的热费结算单` }
  }
  if (String(row.status) === '已缴费') {
    return { ok: false, message: '该结算单已缴费照原样保留，不能再办理减免' }
  }

  const receivable = receivableOf(row)
  if (receivable === null) {
    const invalid = validateBillingRow(row)
    return {
      ok: false,
      message: invalid.ok ? '当前应缴金额无法按口径计算，请先转人工复核' : `面积或热价不合法，请先转人工复核：${invalid.reason}`,
    }
  }

  const cap = parseAmount(capRaw)
  if (cap === null) {
    return { ok: false, message: '应收上限填写无效，请输入大于 0 的数字' }
  }
  if (cap <= 0) {
    return { ok: false, message: '应收上限必须大于 0，请重新填写' }
  }
  if (cap > receivable + CENT) {
    return { ok: false, message: `应收上限不能高于按口径计算的应收金额 ${receivable.toFixed(2)} 元` }
  }

  const relief = parseAmount(reliefRaw)
  if (relief === null) {
    return { ok: false, message: '减免金额填写无效，请输入不小于 0 的数字' }
  }
  if (relief < 0) {
    return { ok: false, message: '减免金额不能为负数' }
  }
  if (relief > cap + CENT) {
    return { ok: false, message: `减免金额超出应收上限 ${cap.toFixed(2)} 元，不允许保存` }
  }

  const clampedRelief = round2(relief)
  patchRow(rows, id, {
    status: '已减免',
    pending: false,
    abnormal: false,
    减免金额: clampedRelief,
    应收上限: round2(cap),
    复核原因: '',
  })
  const updated: EntryRow = {
    ...row,
    status: '已减免',
    减免金额: clampedRelief,
    应收上限: round2(cap),
  }
  upsertPendingConfirm(toQueueItem(updated, '办理减免'))
  return { ok: true, message: `减免 ${clampedRelief.toFixed(2)} 元已保存，进入客服待确认清单` }
}

/** 客服台账读取应缴金额：以结算单当前口径实时复算为准，保证两处读到的金额一致 */
export function liveReceivable(item: PendingConfirmItem): number | null {
  const row = listRows(KEY).find((entry) => Number(entry.id) === item.billingId)
  return row ? receivableOf(row) : item.应缴金额
}
