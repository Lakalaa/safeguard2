import { useState } from "react"
import { useListAlerts, getListAlertsQueryKey } from "@workspace/api-client-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Activity, ExternalLink } from "lucide-react"
import { formatDistanceToNow } from "date-fns"

function formatUsd(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`
  return `$${n.toFixed(2)}`
}

function TierDots({ tier }: { tier: number }) {
  return <span>{"🟢".repeat(Math.min(tier * 4, 12))}</span>
}

export default function Alerts() {
  const { data: alerts, isLoading } = useListAlerts(
    { limit: 100 },
    { query: { queryKey: getListAlertsQueryKey({ limit: 100 }), refetchInterval: 15_000 } },
  )

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Buy Alerts</h1>
        <p className="text-muted-foreground text-sm mt-0.5">
          All recorded buy transactions
          {alerts && ` · ${alerts.length} total`}
        </p>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Transaction History</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : !alerts || alerts.length === 0 ? (
            <div className="py-16 text-center text-muted-foreground" data-testid="empty-alerts">
              <Activity className="w-10 h-10 mx-auto mb-3 opacity-20" />
              <p className="font-medium">No buy alerts yet</p>
              <p className="text-xs mt-1">
                Configure your bot in Settings and start monitoring
              </p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {alerts.map((alert) => (
                <div
                  key={alert.id}
                  className="py-4 grid grid-cols-[auto_1fr_auto] gap-4 items-center"
                  data-testid={`alert-row-${alert.id}`}
                >
                  <div className="text-xl">
                    <TierDots tier={alert.tier} />
                  </div>

                  <div className="min-w-0">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="font-bold text-base">{formatUsd(alert.amountUsd)}</span>
                      <span className="text-sm text-muted-foreground">
                        ({alert.amountNative.toFixed(3)} SOL)
                      </span>
                      <span className="text-sm text-muted-foreground">
                        &rarr; {alert.tokensReceived.toLocaleString("en-US", { maximumFractionDigits: 0 })} tokens
                      </span>
                    </div>

                    <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                      <a
                        href={`https://solscan.io/account/${alert.buyerAddress}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 hover:text-primary transition-colors font-mono"
                        data-testid={`link-buyer-${alert.id}`}
                      >
                        {alert.buyerAddress.slice(0, 6)}...{alert.buyerAddress.slice(-4)}
                        <ExternalLink className="w-2.5 h-2.5" />
                      </a>

                      {alert.txSignature && (
                        <a
                          href={`https://solscan.io/tx/${alert.txSignature}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 hover:text-primary transition-colors"
                          data-testid={`link-tx-${alert.id}`}
                        >
                          TX
                          <ExternalLink className="w-2.5 h-2.5" />
                        </a>
                      )}

                      {alert.marketCap && (
                        <span>MCap {formatUsd(alert.marketCap)}</span>
                      )}

                      {alert.priceChangePct !== null && alert.priceChangePct !== undefined && (
                        <span className={alert.priceChangePct >= 0 ? "text-emerald-500" : "text-red-500"}>
                          {alert.priceChangePct >= 0 ? "+" : ""}{alert.priceChangePct.toFixed(0)}%
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="text-xs text-muted-foreground text-right shrink-0">
                    {formatDistanceToNow(new Date(alert.sentAt), { addSuffix: true })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
