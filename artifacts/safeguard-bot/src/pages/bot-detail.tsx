import { useEffect, useRef, useState } from "react"
import { useParams, Link, useLocation } from "wouter"
import { useForm } from "react-hook-form"
import {
  useGetBot,
  useUpdateBot,
  useStartBot,
  useStopBot,
  useTestBot,
  useGetBotAlerts,
  useGetBotStats,
  useGetTokenInfo,
  getGetBotQueryKey,
  getGetBotAlertsQueryKey,
  getGetBotStatsQueryKey,
  getListBotsQueryKey,
} from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useToast } from "@/hooks/use-toast"
import {
  Play,
  Square,
  Send,
  ChevronLeft,
  ExternalLink,
  Activity,
  DollarSign,
  TrendingUp,
  Zap,
  Search,
  Eye,
  EyeOff,
} from "lucide-react"
import { formatDistanceToNow } from "date-fns"

const CHAIN_LABELS: Record<string, string> = {
  solana: "Solana",
  ethereum: "Ethereum",
  bsc: "BSC",
  base: "Base",
  arbitrum: "Arbitrum",
  polygon: "Polygon",
  avalanche: "Avalanche",
  optimism: "Optimism",
}

function formatUsd(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`
  return `$${n.toFixed(2)}`
}

type FormValues = {
  name: string
  telegramToken: string
  chatId: string
  tokenAddress: string
  tokenName: string
  tokenSymbol: string
  chain: string
  minBuyUsd: number
  alertImageUrl: string
  dextUrl: string
  screenerUrl: string
  buyUrl: string
  trendingUrl: string
  emojiPerTier: number
  tier1Min: number
  tier2Min: number
  tier3Min: number
  alertStyle: string
  presaleTagline: string
  presaleQuote: string
}

export default function BotDetail() {
  const params = useParams<{ id: string }>()
  const id = parseInt(params.id ?? "0")
  const [, navigate] = useLocation()
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const [showToken, setShowToken] = useState(false)
  const [tokenLookupAddr, setTokenLookupAddr] = useState("")
  const lookupAddrRef = useRef("")

  const { data: bot, isLoading: botLoading } = useGetBot(id)
  const { data: alerts, isLoading: alertsLoading } = useGetBotAlerts(id)
  const { data: stats } = useGetBotStats(id)
  const startBot = useStartBot()
  const stopBot = useStopBot()
  const testBot = useTestBot()
  const updateBot = useUpdateBot()

  const tokenInfoEnabled = tokenLookupAddr.length > 30
  const { data: tokenInfo, isFetching: tokenInfoFetching } = useGetTokenInfo(
    { address: tokenLookupAddr },
    { enabled: tokenInfoEnabled },
  )

  const form = useForm<FormValues>()
  const { register, handleSubmit, reset, setValue, watch } = form
  const watchedStyle = watch("alertStyle")

  useEffect(() => {
    if (bot) {
      reset({
        name: bot.name ?? "",
        telegramToken: "",
        chatId: bot.chatId ?? "",
        tokenAddress: bot.tokenAddress ?? "",
        tokenName: bot.tokenName ?? "",
        tokenSymbol: bot.tokenSymbol ?? "",
        chain: bot.chain ?? "solana",
        minBuyUsd: bot.minBuyUsd ?? 1,
        alertImageUrl: bot.alertImageUrl ?? "",
        dextUrl: bot.dextUrl ?? "",
        screenerUrl: bot.screenerUrl ?? "",
        buyUrl: bot.buyUrl ?? "",
        trendingUrl: bot.trendingUrl ?? "",
        emojiPerTier: bot.emojiPerTier ?? 4,
        tier1Min: bot.tier1Min ?? 100,
        tier2Min: bot.tier2Min ?? 500,
        tier3Min: bot.tier3Min ?? 1000,
        alertStyle: bot.alertStyle ?? "sosana",
        presaleTagline: bot.presaleTagline ?? "",
        presaleQuote: bot.presaleQuote ?? "",
      })
    }
  }, [bot, reset])

  const watchedAddress = watch("tokenAddress")

  useEffect(() => {
    const addr = watchedAddress ?? ""
    if (addr.length > 30 && addr !== lookupAddrRef.current) {
      lookupAddrRef.current = addr
      const t = setTimeout(() => setTokenLookupAddr(addr), 800)
      return () => clearTimeout(t)
    }
  }, [watchedAddress])

  useEffect(() => {
    if (tokenInfo?.found && tokenInfo.name) {
      if (tokenInfo.name) setValue("tokenName", tokenInfo.name)
      if (tokenInfo.symbol) setValue("tokenSymbol", tokenInfo.symbol)
      if (tokenInfo.chainId) setValue("chain", tokenInfo.chainId)
      if (tokenInfo.dexscreenerUrl) setValue("screenerUrl", tokenInfo.dexscreenerUrl)
      if (tokenInfo.dextoolsUrl) setValue("dextUrl", tokenInfo.dextoolsUrl)
      toast({ title: "Token found", description: `${tokenInfo.name} (${tokenInfo.symbol}) auto-filled.` })
    }
  }, [tokenInfo, setValue, toast])

  function invalidateBot() {
    queryClient.invalidateQueries({ queryKey: getGetBotQueryKey(id) })
    queryClient.invalidateQueries({ queryKey: getListBotsQueryKey() })
  }

  async function handleStart() {
    const result = await startBot.mutateAsync({ id })
    invalidateBot()
    if (result.running) {
      toast({ title: "Bot started", description: "Monitoring on-chain buys live." })
    } else {
      toast({ title: "Failed to start", description: result.error ?? "Unknown error", variant: "destructive" })
    }
  }

  async function handleStop() {
    await stopBot.mutateAsync({ id })
    invalidateBot()
    toast({ title: "Bot stopped" })
  }

  async function handleTest() {
    const result = await testBot.mutateAsync({ id })
    toast({
      title: result.success ? "Test sent!" : "Test failed",
      description: result.message,
      variant: result.success ? "default" : "destructive",
    })
  }

  async function onSave(values: FormValues) {
    const payload: Record<string, unknown> = { ...values }
    if (!values.telegramToken) delete payload.telegramToken
    await updateBot.mutateAsync({ id, ...payload })
    invalidateBot()
    toast({ title: "Settings saved" })
  }

  if (botLoading) {
    return (
      <div className="p-6 max-w-4xl mx-auto space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-64" />
        <div className="grid grid-cols-2 gap-4 mt-6">
          {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-24" />)}
        </div>
      </div>
    )
  }

  if (!bot) {
    return (
      <div className="p-6 text-center">
        <p className="text-muted-foreground">Bot not found.</p>
        <Link href="/">
          <Button variant="link">← Back to bots</Button>
        </Link>
      </div>
    )
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Link href="/">
          <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground">
            <ChevronLeft className="w-4 h-4" />
            My Bots
          </Button>
        </Link>
        <span className="text-muted-foreground">/</span>
        <h1 className="text-lg font-semibold">{bot.name}</h1>
        <Badge
          className={`ml-1 text-[11px] ${
            bot.running
              ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30"
              : "bg-slate-800 text-slate-400"
          }`}
        >
          {bot.running ? "🟢 Live" : "⚫ Off"}
        </Badge>
        <div className="flex gap-2 ml-auto">
          {bot.running ? (
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5 text-red-400 border-red-500/30 hover:bg-red-500/10"
              onClick={handleStop}
              disabled={stopBot.isPending}
            >
              <Square className="w-3.5 h-3.5" />
              Stop
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/10"
              onClick={handleStart}
              disabled={startBot.isPending}
            >
              <Play className="w-3.5 h-3.5" />
              Start
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={handleTest}
            disabled={testBot.isPending}
          >
            <Send className="w-3.5 h-3.5" />
            Test
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        {[
          { label: "Total Alerts", value: stats?.totalAlerts.toLocaleString() ?? "—", icon: Activity },
          { label: "Total Volume", value: stats ? formatUsd(stats.totalVolumeUsd) : "—", icon: DollarSign },
          { label: "Avg Buy", value: stats ? formatUsd(stats.avgBuyUsd) : "—", icon: TrendingUp },
          { label: "Today", value: stats?.alertsToday.toLocaleString() ?? "—", icon: Zap },
        ].map(({ label, value, icon: Icon }) => (
          <Card key={label}>
            <CardContent className="p-4">
              <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                <Icon className="w-3.5 h-3.5" />
                {label}
              </div>
              <div className="text-xl font-bold">{value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Tabs defaultValue="alerts">
        <TabsList className="mb-4">
          <TabsTrigger value="alerts">Buy Alerts</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="alerts">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium text-muted-foreground">Recent Buys</CardTitle>
            </CardHeader>
            <CardContent>
              {alertsLoading ? (
                <div className="space-y-3">
                  {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
                </div>
              ) : alerts && alerts.length > 0 ? (
                <div className="divide-y divide-border">
                  {alerts.map((alert) => {
                    const explorerBase =
                      alert.chain === "solana"
                        ? "https://solscan.io/tx/"
                        : "https://etherscan.io/tx/"
                    return (
                      <div key={alert.id} className="py-3 flex items-center justify-between gap-4 text-sm">
                        <div className="flex items-center gap-3 min-w-0">
                          <span className="text-lg shrink-0">{"🟢".repeat(Math.min(alert.tier * 2, 6))}</span>
                          <div className="min-w-0">
                            <div className="font-medium truncate max-w-[180px]" title={alert.buyerAddress}>
                              {alert.buyerAddress.slice(0, 6)}…{alert.buyerAddress.slice(-4)}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {formatDistanceToNow(new Date(alert.sentAt), { addSuffix: true })}
                              {" · "}{CHAIN_LABELS[alert.chain] ?? alert.chain}
                            </div>
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <div className="font-semibold text-emerald-400">{formatUsd(alert.amountUsd)}</div>
                          <div className="text-xs text-muted-foreground">
                            {alert.amountNative.toFixed(3)} {alert.nativeCurrency}
                          </div>
                        </div>
                        {alert.txSignature && (
                          <a
                            href={`${explorerBase}${alert.txSignature}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-muted-foreground hover:text-foreground shrink-0"
                          >
                            <ExternalLink className="w-3.5 h-3.5" />
                          </a>
                        )}
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div className="text-center py-12 text-muted-foreground text-sm">
                  No alerts yet. Start the bot to begin monitoring on-chain buys.
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="settings">
          <form onSubmit={handleSubmit(onSave)} className="space-y-6">
            <Card>
              <CardHeader><CardTitle className="text-sm">Bot Info</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>Bot Name</Label>
                  <Input {...register("name")} placeholder="e.g. SOSANA Group" />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="text-sm">Telegram</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>Bot Token</Label>
                  <div className="relative">
                    <Input
                      {...register("telegramToken")}
                      type={showToken ? "text" : "password"}
                      placeholder={bot.hasTelegramToken ? "Leave blank to keep current" : "Paste token from @BotFather"}
                      className="pr-10"
                    />
                    <button
                      type="button"
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      onClick={() => setShowToken((v) => !v)}
                    >
                      {showToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                  {bot.hasTelegramToken && (
                    <p className="text-xs text-muted-foreground">
                      Current: {bot.telegramTokenPreview}
                    </p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label>Chat ID</Label>
                  <Input {...register("chatId")} placeholder="-1001234567890" />
                  <p className="text-xs text-muted-foreground">
                    Add your bot to the group, then use @userinfobot to get the chat ID.
                  </p>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm">Token</CardTitle>
                  {tokenInfoFetching && (
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Search className="w-3 h-3 animate-pulse" /> Looking up…
                    </span>
                  )}
                  {tokenInfo?.found && (
                    <span className="text-xs text-emerald-400">✓ Token found</span>
                  )}
                  {tokenInfo && !tokenInfo.found && (
                    <span className="text-xs text-yellow-500">Token not found on DexScreener</span>
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>Token Address</Label>
                  <Input
                    {...register("tokenAddress")}
                    placeholder="Paste any token address (Solana, ETH, BSC, Base…)"
                    className="font-mono text-xs"
                  />
                  <p className="text-xs text-muted-foreground">
                    Paste the address and name/symbol/chain will auto-fill from DexScreener.
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Token Name</Label>
                    <Input {...register("tokenName")} placeholder="Auto-filled" />
                  </div>
                  <div className="space-y-2">
                    <Label>Symbol</Label>
                    <Input {...register("tokenSymbol")} placeholder="Auto-filled" />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Chain</Label>
                  <Input {...register("chain")} placeholder="Auto-detected (solana / ethereum / bsc / base…)" />
                </div>
                <div className="space-y-2">
                  <Label>Minimum Buy (USD)</Label>
                  <Input {...register("minBuyUsd", { valueAsNumber: true })} type="number" min={0} step={0.01} />
                  <p className="text-xs text-muted-foreground">Buys below this amount won't trigger an alert.</p>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="text-sm">Alert Appearance</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>Alert Style</Label>
                  <select
                    {...register("alertStyle")}
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  >
                    <option value="sosana">Sosana (default)</option>
                    <option value="simple">Simple (clean)</option>
                    <option value="wave">Wave</option>
                    <option value="evm">EVM</option>
                    <option value="trending">Trending</option>
                    <option value="presale">Presale</option>
                  </select>
                  <p className="text-xs text-muted-foreground">Choose how buy alerts look in Telegram.</p>
                </div>
                {(watchedStyle === "presale" || watchedStyle === "simple") && (
                  <>
                    <div className="space-y-2">
                      <Label>Presale Tagline</Label>
                      <textarea
                        {...register("presaleTagline")}
                        rows={2}
                        placeholder="A smart move just happened. The presale window won't stay open forever."
                        className="flex min-h-[60px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      />
                      <p className="text-xs text-muted-foreground">Shown below the header on each buy alert.</p>
                    </div>
                    <div className="space-y-2">
                      <Label>Presale Quote</Label>
                      <Input {...register("presaleQuote")} placeholder='"Don&apos;t watch from the sidelines 👀"' />
                      <p className="text-xs text-muted-foreground">Italic quote line at the bottom of each alert.</p>
                    </div>
                  </>
                )}
                <div className="space-y-2">
                  <Label>Alert Image URL</Label>
                  <Input {...register("alertImageUrl")} placeholder="https://… (optional, sent as photo)" />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Emojis per Tier</Label>
                    <Input {...register("emojiPerTier", { valueAsNumber: true })} type="number" min={1} max={20} />
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-4">
                  {(["tier1Min", "tier2Min", "tier3Min"] as const).map((field, i) => (
                    <div key={field} className="space-y-2">
                      <Label>Tier {i + 1} Min ($)</Label>
                      <Input {...register(field, { valueAsNumber: true })} type="number" min={0} />
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="text-sm">Action Links</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                {(
                  [
                    ["dextUrl", "DexTools URL", "https://dextools.io/… (auto-filled)"],
                    ["screenerUrl", "DexScreener URL", "https://dexscreener.com/… (auto-filled)"],
                    ["buyUrl", "Buy URL", "Your preferred exchange — Raydium, Jupiter, Uniswap, or any link"],
                    ["trendingUrl", "Trending URL", "https://…"],
                  ] as const
                ).map(([field, label, placeholder]) => (
                  <div key={field} className="space-y-2">
                    <Label>{label}</Label>
                    <Input {...register(field)} placeholder={placeholder} />
                  </div>
                ))}
                <p className="text-xs text-muted-foreground">
                  These appear as inline links at the bottom of each alert message.
                </p>
              </CardContent>
            </Card>

            <div className="flex justify-end">
              <Button type="submit" disabled={updateBot.isPending}>
                {updateBot.isPending ? "Saving…" : "Save Settings"}
              </Button>
            </div>
          </form>
        </TabsContent>
      </Tabs>
    </div>
  )
}
