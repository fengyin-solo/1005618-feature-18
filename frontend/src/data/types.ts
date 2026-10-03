/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

// 客服台账「待确认清单」：热费侧重算/核算/减免的结果落到这里，按结算单 id 去重。
export type PendingConfirmItem = {
  /** 对应热费结算单 id，重复提交只保留一条 */
  billingId: number
  结算编号: string
  用户名称: string
  用热面积: number
  热价标准: string
  /** 落清单时按当时口径算出的应缴金额快照，读取时仍以结算口径实时复算为准 */
  应缴金额: number | null
  减免金额: number | null
  复核原因: string
  来源: string
  登记时间: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
