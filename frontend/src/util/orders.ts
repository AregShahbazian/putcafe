import type { PivotOrder } from "../api/backend"

/** An order's state as of the replay cursor — `null` means not created yet
 * (hidden). An order whose fill/cancel lies beyond the cursor reads as open,
 * so stepping back honestly re-opens it. */
export function orderStatusAt(o: PivotOrder, cursorT: number): PivotOrder["status"] | null {
  if (o.createdAt > cursorT) return null
  if (o.filledAt !== null && o.filledAt <= cursorT) return "filled"
  if (o.cancelledAt !== null && o.cancelledAt <= cursorT) return "cancelled"
  return "open"
}

export interface OrderAt {
  order: PivotOrder
  status: Exclude<ReturnType<typeof orderStatusAt>, null>
}

/** Orders visible at the cursor, newest first, with their at-cursor status. */
export function ordersAt(orders: PivotOrder[], cursorT: number): OrderAt[] {
  const out: OrderAt[] = []
  for (const order of orders) {
    const status = orderStatusAt(order, cursorT)
    if (status !== null) out.push({ order, status })
  }
  return out.sort((a, b) => b.order.createdAt - a.order.createdAt)
}
