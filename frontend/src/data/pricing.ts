// 热费结算口径（全系统唯一一份，重算、提交核算、客服台账待确认清单都走这里）：
// 应缴金额 = 用热面积 × 现行热价单价，四舍五入保留两位小数。
// 热价标准调整时只改这份配置，再到热费结算页点「按新热价口径重算」即可。

export type HeatPriceStandard = {
  /** 标准名称，结算单「热价标准」字段规范后写这个值 */
  name: string
  /** 现行单价，元/㎡·采暖季 */
  price: number
  /** 历史/口语写法，识别老单据时兼容，命中后按现行价重算 */
  aliases: string[]
}

export type BillingRowInput = {
  用热面积?: string | number | boolean
  热价标准?: string | number | boolean
  [field: string]: string | number | boolean | undefined
}

export type BillingValidation =
  | { ok: true; area: number; standard: HeatPriceStandard; receivable: number }
  | { ok: false; reason: string }

/** 核定用热面积范围（㎡），超出即转人工复核 */
export const AREA_MIN = 10
export const AREA_MAX = 400

/** 现行热价标准（2026 年采暖季调整后） */
export const CURRENT_HEAT_PRICES: readonly HeatPriceStandard[] = [
  {
    name: '居民供热',
    price: 28,
    aliases: ['居民', '居民供热26元/㎡', '居民供热28元/㎡', '居民供热（26元/㎡）', '居民供热（28元/㎡）'],
  },
  {
    name: '非居民供热',
    price: 38,
    aliases: [
      '非居民',
      '公建供热',
      '非居民供热35元/㎡',
      '非居民供热38元/㎡',
      '非居民供热（35元/㎡）',
      '非居民供热（38元/㎡）',
    ],
  },
]

/** 调整前老价，仅用于提示与核对，不再参与计算 */
export const LEGACY_HEAT_PRICES: Record<string, number> = {
  居民供热: 26,
  非居民供热: 35,
}

/** 解析有限、非负的数字；空串、NaN、Infinity 一律视为无效 */
export function parseAmount(value: string | number | boolean | undefined | null): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value === 'boolean' || value === undefined || value === null) {
    return null
  }
  const text = value.trim()
  if (text === '') {
    return null
  }
  const num = Number(text)
  return Number.isFinite(num) ? num : null
}

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

export function formatMoney(value: number | null): string {
  return value === null ? '—' : value.toFixed(2)
}

/** 按「热价标准」字段识别现行标准，兼容老价备注等写法；识别不到就是填错 */
export function resolveStandard(raw: string | number | boolean | undefined | null): HeatPriceStandard | null {
  const text = String(raw ?? '').trim()
  if (!text) {
    return null
  }
  for (const standard of CURRENT_HEAT_PRICES) {
    if (text === standard.name || standard.aliases.includes(text) || text.startsWith(standard.name)) {
      return standard
    }
  }
  return null
}

/** 结算单口径校验：面积要在核定范围、热价要能对上现行标准，任一不满足给出复核原因 */
export function validateBillingRow(row: BillingRowInput): BillingValidation {
  const area = parseAmount(row['用热面积'])
  if (area === null) {
    return { ok: false, reason: '用热面积不是有效数值，转人工复核' }
  }
  if (area < AREA_MIN || area > AREA_MAX) {
    return { ok: false, reason: `用热面积 ${area} ㎡超出核定范围（${AREA_MIN}~${AREA_MAX} ㎡），转人工复核` }
  }
  const standard = resolveStandard(row['热价标准'])
  if (!standard) {
    return { ok: false, reason: `热价标准「${String(row['热价标准'] ?? '')}」不在现行标准内，疑似填错，转人工复核` }
  }
  return { ok: true, area, standard, receivable: round2(area * standard.price) }
}

/** 读一条结算单的应缴金额；口径不合法时返回 null（对应人工复核态） */
export function receivableOf(row: BillingRowInput): number | null {
  const result = validateBillingRow(row)
  return result.ok ? result.receivable : null
}
