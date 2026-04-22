import { useListAlerts, getListAlertsQueryKey } from "@workspace/api-client-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Badge } from "@/components/ui/badge"
import { Activity, ExternalLink } from "lucide-react"
import { formatDistanceToNow } from "date-fns"

function formatUsd(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`
  return `$${n.toFixed(2)}`
}

const CHAIN_EXPLORERS: Record<string, { tx: string; addr: string; label: string }> = {
  solana:   { tx: "https://solscan.io/tx/{h}",                            addr: "https://solscan.io/account/{h}",                   label: "Solana" },
  ethereum: { tx: "https://etherscan.io/tx/{h}",                          addr: "https://etherscan.io/address/{h}",                 label: "Ethereum" },
  bsc:      { tx: "https://bscscan.com/tx/{h}",                          addr: "https://bscscan.com/address/{h}",                  label: "BSC" },
  base:     { tx: "https://basescan.org/tx/{h}",                         addr: "https://basescan.org/address/{h}",                 label: "Base" },
  arbitrum: { tx: "https://arbiscan.io/tx/{h}",                          addr: "https://arbiscan.io/address/{h}",                  label: "Arbitrum" },
  polygon:  { tx: "https://polygonscan.com/tx/{h}",                      addr: "https://polygonscan.com/address/{h}",              label: "Polygon" },
  avalanche:{ tx: "https://snowscan.xyz/tx/{h}",                         addr: "https://snowscan.xyz/address/{h}",                 label: "Avalanche" },
  optimism: { tx: "https://optimistic.etherscan.io/tx/{h}",              addr: "https://optimistic.etherscan.io/address/{h}",      label: "Optimism" },
}

function explorerUrl(chain: string, type: "tx" | "addr", hash: string) {
  const c = CHAIN_EXPLORERS[chain] ?? CHAIN_EXPLORERS.solana!
  const url = type === "tx" ? c.tx : c.addr
  return url.replace("{h}", hash)
}

function chainLabel(chain: string) {
  return CHAIN_EXPLORERS[chain]?.label ?? chain
}

function TierDots({ tier }: { tier: number }) {
  return <span className="text-sm">{"🟢".repeat(Math.min(tier * 4, 12))}</span>
}

export default function Alerts() {
  const { data: alerts, isLoading } = useListAlerts(
    { limit: 100 },
    { query: { queryKey: getListAlertsQueryKey({ limit: 100 }), refetchInterval: 10_000 } },
  )

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Buy Alerts</h1>
        <p className="text-muted-foreground text-sm mt-0.5">
          Live on-chain buy transactions
          {alerts && alerts.length > 0 && ` · ${alerts.length} recorded`}
        </p>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
            Transaction History
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-3 p-6">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : !alerts || alerts.length === 0 ? (
            <div className="py-16 text-center text-muted-foreground" data-testid="empty-alerts">
              <Activity className="w-10 h-10 mx-auto mb-3 opacity-20" />
              <p className="font-medium">No buy alerts yet</p>
              <p className="text-xs mt-1 max-w-xs mx-auto">
                Configure your token in Settings, start the bot, and real buys will appear here instantly
              </p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {alerts.map((alert) => (
                <div
                  key={alert.id}
                  className="flex items-start gap-4 px-5 py-4"
                  data-testid={`alert-row-${alert.id}`}
                >
                  <div className="pt-0.5 shrink-0">
                    <TierDots tier={alert.tier} />
                  </div>

                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-base">{formatUsd(alert.amountUsd)}</span>
                      <span className="text-sm text-muted-foreground">
                        {alert.amountNative.toFixed(4)} {alert.nativeCurrency}
                      </span>
                      <span className="text-muted-foreground">·</span>
                      <span className="text-sm text-muted-foreground">
                        {alert.tokensReceived.toLocaleString("en-US", { maximumFractionDigits: 0 })} tokens
                      </span>
                    </div>

                    <div className="flex items-center gap-3 flex-wrap text-xs text-muted-foreground">
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4">
                        {chainLabel(alert.chain)}
                      </Badge>

                      <a
                        href={explorerUrl(alert.chain, "addr", alert.buyerAddress)}
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
                          href={explorerUrl(alert.chain, "tx", alert.txSignature)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 hover:text-primary transition-colors"
                          data-testid={`link-tx-${alert.id}`}
                        >
                          TX <ExternalLink className="w-2.5 h-2.5" />
                        </a>
                      )}

                      {alert.marketCap != null && (
                        <span>MCap {formatUsd(alert.marketCap)}</span>
                      )}

                      {alert.priceChangePct != null && (
                        <span className={alert.priceChangePct >= 0 ? "text-emerald-500" : "text-red-500"}>
                          {alert.priceChangePct >= 0 ? "+" : ""}
                          {alert.priceChangePct.toFixed(1)}%
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="text-xs text-muted-foreground shrink-0 text-right pt-0.5">
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
