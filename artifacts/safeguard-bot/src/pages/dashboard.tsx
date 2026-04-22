import { useGetBotStatus, useGetStats, useListAlerts, useStartBot, useStopBot, useTestAlert, getGetBotStatusQueryKey, getGetStatsQueryKey, getListAlertsQueryKey } from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Play, Square, AlertCircle, Zap, TrendingUp, DollarSign, Activity, Send } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { formatDistanceToNow } from "date-fns"
import { Link } from "wouter"

function formatUsd(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`
  return `$${n.toFixed(2)}`
}

function TierDots({ tier }: { tier: number }) {
  const count = Math.min(tier * 4, 12)
  return (
    <span className="text-xs" data-testid={`tier-dots-${tier}`}>
      {"🟢".repeat(count)}
    </span>
  )
}

export default function Dashboard() {
  const queryClient = useQueryClient()
  const { toast } = useToast()

  const { data: status, isLoading: statusLoading } = useGetBotStatus({
    query: { queryKey: getGetBotStatusQueryKey(), refetchInterval: 10_000 },
  })
  const { data: stats, isLoading: statsLoading } = useGetStats({
    query: { queryKey: getGetStatsQueryKey() },
  })
  const { data: alerts, isLoading: alertsLoading } = useListAlerts(
    { limit: 8 },
    { query: { queryKey: getListAlertsQueryKey({ limit: 8 }) } },
  )

  const startBot = useStartBot({
    mutation: {
      onSuccess: (data) => {
        queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() })
        if (data.error) {
          toast({ title: "Could not start bot", description: data.error, variant: "destructive" })
        } else {
          toast({ title: "Bot started", description: "Monitoring for buy transactions." })
        }
      },
      onError: () => toast({ title: "Error", description: "Failed to start bot.", variant: "destructive" }),
    },
  })

  const stopBot = useStopBot({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() })
        toast({ title: "Bot stopped" })
      },
    },
  })

  const testAlert = useTestAlert({
    mutation: {
      onSuccess: (data) => {
        if (data.success) toast({ title: "Test alert sent", description: data.message })
        else toast({ title: "Test failed", description: data.message, variant: "destructive" })
      },
    },
  })

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Buy alert monitoring</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => testAlert.mutate({})}
          disabled={testAlert.isPending}
          data-testid="button-send-test"
        >
          <Send className="w-3.5 h-3.5 mr-2" />
          {testAlert.isPending ? "Sending..." : "Send Test"}
        </Button>
      </div>

      {/* Bot Status */}
      <Card data-testid="bot-status-card">
        <CardContent className="p-5">
          {statusLoading ? (
            <Skeleton className="h-14 w-full" />
          ) : (
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div
                  className={`w-2.5 h-2.5 rounded-full shrink-0 ${status?.running ? "bg-emerald-500 shadow-[0_0_8px_2px_rgba(16,185,129,0.4)]" : "bg-zinc-400"}`}
                />
                <div>
                  <div className="font-semibold text-sm" data-testid="status-running">
                    {status?.running ? "Active — monitoring buys" : "Stopped"}
                  </div>
                  {status?.running && status.monitoringToken && (
                    <div className="text-xs text-muted-foreground font-mono mt-0.5" data-testid="status-token">
                      {status.monitoringToken.slice(0, 8)}...{status.monitoringToken.slice(-6)}
                    </div>
                  )}
                  {status?.error && (
                    <div className="flex items-center gap-1 text-xs text-destructive mt-0.5" data-testid="status-error">
                      <AlertCircle className="w-3 h-3 shrink-0" />
                      {status.error}
                    </div>
                  )}
                  {status?.lastCheckAt && (
                    <div className="text-xs text-muted-foreground mt-0.5">
                      Last check {formatDistanceToNow(new Date(status.lastCheckAt), { addSuffix: true })}
                    </div>
                  )}
                </div>
              </div>

              <div className="flex gap-2 shrink-0">
                {status?.running ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => stopBot.mutate({})}
                    disabled={stopBot.isPending}
                    data-testid="button-stop-bot"
                  >
                    <Square className="w-3 h-3 mr-1.5" />
                    {stopBot.isPending ? "Stopping..." : "Stop"}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    onClick={() => startBot.mutate({})}
                    disabled={startBot.isPending}
                    data-testid="button-start-bot"
                  >
                    <Play className="w-3 h-3 mr-1.5" />
                    {startBot.isPending ? "Starting..." : "Start Bot"}
                  </Button>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          {
            label: "Total Alerts",
            value: statsLoading ? null : (stats?.totalAlerts ?? 0).toLocaleString(),
            icon: Activity,
            color: "text-blue-500",
            testid: "stat-total-alerts",
          },
          {
            label: "Volume",
            value: statsLoading ? null : formatUsd(stats?.totalVolumeUsd ?? 0),
            icon: DollarSign,
            color: "text-emerald-500",
            testid: "stat-volume",
          },
          {
            label: "Avg Buy",
            value: statsLoading ? null : formatUsd(stats?.avgBuyUsd ?? 0),
            icon: TrendingUp,
            color: "text-yellow-500",
            testid: "stat-avg-buy",
          },
          {
            label: "Today",
            value: statsLoading ? null : (stats?.alertsToday ?? 0).toLocaleString(),
            icon: Zap,
            color: "text-purple-500",
            testid: "stat-today",
          },
        ].map((s) => (
          <Card key={s.label} data-testid={s.testid}>
            <CardContent className="p-5">
              {s.value === null ? (
                <Skeleton className="h-12 w-full" />
              ) : (
                <div>
                  <div className={`flex items-center gap-1.5 text-xs font-medium text-muted-foreground mb-2`}>
                    <s.icon className={`w-3.5 h-3.5 ${s.color}`} />
                    {s.label}
                  </div>
                  <div className="text-2xl font-bold">{s.value}</div>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Recent Alerts */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base font-semibold">Recent Buy Alerts</CardTitle>
            {alerts && alerts.length > 0 && (
              <Link href="/alerts" className="text-xs text-primary hover:underline">
                View all
              </Link>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {alertsLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : !alerts || alerts.length === 0 ? (
            <div className="py-12 text-center text-muted-foreground" data-testid="empty-alerts">
              <Activity className="w-8 h-8 mx-auto mb-3 opacity-20" />
              <p className="text-sm font-medium">No alerts yet</p>
              <p className="text-xs mt-1">Start the bot and add it to a Telegram group to receive buy alerts</p>
            </div>
          ) : (
            <div className="divide-y divide-border -mx-2">
              {alerts.map((alert) => (
                <div key={alert.id} className="flex items-center gap-4 px-2 py-3" data-testid={`alert-row-${alert.id}`}>
                  <div className="shrink-0">
                    <TierDots tier={alert.tier} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2">
                      <span className="font-semibold text-sm">{formatUsd(alert.amountUsd)}</span>
                      <span className="text-xs text-muted-foreground">({alert.amountNative.toFixed(3)} SOL)</span>
                    </div>
                    <div className="text-xs text-muted-foreground font-mono truncate mt-0.5">
                      {alert.buyerAddress.slice(0, 8)}...{alert.buyerAddress.slice(-6)}
                    </div>
                  </div>
                  <div className="text-xs text-muted-foreground shrink-0 text-right">
                    {alert.marketCap && (
                      <div className="font-medium text-foreground/70">{formatUsd(alert.marketCap)}</div>
                    )}
                    <div>{formatDistanceToNow(new Date(alert.sentAt), { addSuffix: true })}</div>
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
