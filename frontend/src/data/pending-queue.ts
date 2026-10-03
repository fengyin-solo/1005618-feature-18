import type { PendingConfirmItem } from './types'

// 客服台账待确认清单的本地持久化：与结算数据分开存，互不影响重置。
const STORAGE_KEY = 'district-heating:billing-pending-confirm'

function readStorage(): PendingConfirmItem[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return []
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    return []
  }
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as PendingConfirmItem[]) : []
  } catch {
    return []
  }
}

let cache: PendingConfirmItem[] | null = null

export function listPendingConfirm(): PendingConfirmItem[] {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

function persist(items: PendingConfirmItem[]): void {
  cache = items
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items))
  }
}

/** 按结算单 id 去重落清单：已存在则更新为最新口径，只留一条 */
export function upsertPendingConfirm(item: PendingConfirmItem): PendingConfirmItem[] {
  const items = listPendingConfirm()
  const index = items.findIndex((entry) => entry.billingId === item.billingId)
  if (index >= 0) {
    items[index] = { ...items[index], ...item }
  } else {
    items.unshift(item)
  }
  persist(items)
  return items
}

/** 客服确认后移走这一条 */
export function removePendingConfirm(billingId: number): PendingConfirmItem[] {
  persist(listPendingConfirm().filter((entry) => entry.billingId !== billingId))
  return listPendingConfirm()
}
