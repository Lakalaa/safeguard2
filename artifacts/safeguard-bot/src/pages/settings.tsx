import { useEffect, useRef, useState } from "react"
import { useForm } from "react-hook-form"
import {
  useGetBotConfig,
  useUpdateBotConfig,
  getGetBotConfigQueryKey,
  getTokenInfo,
} from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Badge } from "@/components/ui/badge"
import { useToast } from "@/hooks/use-toast"
import { Save, Bot, Target, Link2, BarChart3, Image, Loader2, CheckCircle2, AlertCircle, ExternalLink } from "lucide-react"

interface FormValues {
  telegramToken: string
  chatId: string
  tokenAddress: string
  tokenName: string
  tokenSymbol: string
  minBuyUsd: string
  tier1Min: string
  tier2Min: string
  tier3Min: string
  emojiPerTier: string
  alertImageUrl: string
  dextUrl: string
  screenerUrl: string
  buyUrl: string
  trendingUrl: string
}

interface TokenPreview {
  name: string | null
  symbol: string | null
  priceUsd: number | null
  marketCap: number | null
  priceChange24h: number | null
  dexscreenerUrl: string | null
  dextoolsUrl: string | null
  raydiumUrl: string | null
  found: boolean
}

function formatUsd(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`
  return `$${n.toFixed(4)}`
}

function Section({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: React.ElementType
  title: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon className="w-4 h-4 text-primary" />
          {title}
        </CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="grid gap-4">{children}</CardContent>
    </Card>
  )
}

function Field({
  label,
  hint,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  return (
    <div className="grid gap-1.5">
      <Label className="text-sm font-medium">{label}</Label>
      <Input {...props} />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

export default function Settings() {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const [tokenPreview, setTokenPreview] = useState<TokenPreview | null>(null)
  const [tokenLookupLoading, setTokenLookupLoading] = useState(false)
  const lookupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const { data: config, isLoading } = useGetBotConfig({
    query: { queryKey: getGetBotConfigQueryKey() },
  })

  const updateConfig = useUpdateBotConfig({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetBotConfigQueryKey() })
        toast({ title: "Settings saved" })
      },
      onError: () => toast({ title: "Save failed", variant: "destructive" }),
    },
  })

  const { register, handleSubmit, reset, setValue, watch } = useForm<FormValues>({
    defaultValues: {
      telegramToken: "",
      chatId: "",
      tokenAddress: "",
      tokenName: "",
      tokenSymbol: "",
      minBuyUsd: "1",
      tier1Min: "100",
      tier2Min: "500",
      tier3Min: "1000",
      emojiPerTier: "4",
      alertImageUrl: "",
      dextUrl: "",
      screenerUrl: "",
      buyUrl: "",
      trendingUrl: "",
    },
  })

  useEffect(() => {
    if (config) {
      reset({
        telegramToken: "",
        chatId: config.chatId ?? "",
        tokenAddress: config.tokenAddress ?? "",
        tokenName: config.tokenName ?? "",
        tokenSymbol: config.tokenSymbol ?? "",
        minBuyUsd: String(config.minBuyUsd ?? 1),
        tier1Min: String(config.tier1Min ?? 100),
        tier2Min: String(config.tier2Min ?? 500),
        tier3Min: String(config.tier3Min ?? 1000),
        emojiPerTier: String(config.emojiPerTier ?? 4),
        alertImageUrl: config.alertImageUrl ?? "",
        dextUrl: config.dextUrl ?? "",
        screenerUrl: config.screenerUrl ?? "",
        buyUrl: config.buyUrl ?? "",
        trendingUrl: config.trendingUrl ?? "",
      })
    }
  }, [config, reset])

  // Watch token address and auto-lookup
  const tokenAddress = watch("tokenAddress")
  useEffect(() => {
    if (lookupTimerRef.current) clearTimeout(lookupTimerRef.current)

    const addr = tokenAddress?.trim()
    // Solana addresses are 32–44 chars (base58)
    if (!addr || addr.length < 32 || addr.length > 44) {
      setTokenPreview(null)
      return
    }

    setTokenLookupLoading(true)
    lookupTimerRef.current = setTimeout(async () => {
      try {
        const info = await getTokenInfo({ address: addr })
        setTokenPreview(info)
        if (info.found) {
          if (info.name) setValue("tokenName", info.name)
          if (info.symbol) setValue("tokenSymbol", info.symbol)
          if (info.dexscreenerUrl) setValue("screenerUrl", info.dexscreenerUrl)
          if (info.dextoolsUrl) setValue("dextUrl", info.dextoolsUrl)
          if (info.raydiumUrl) setValue("buyUrl", info.raydiumUrl)
        }
      } catch {
        setTokenPreview(null)
      } finally {
        setTokenLookupLoading(false)
      }
    }, 800)

    return () => {
      if (lookupTimerRef.current) clearTimeout(lookupTimerRef.current)
    }
  }, [tokenAddress, setValue])

  function onSubmit(values: FormValues) {
    const payload: Record<string, unknown> = {}
    if (values.telegramToken) payload.telegramToken = values.telegramToken
    if (values.chatId) payload.chatId = values.chatId
    if (values.tokenAddress) payload.tokenAddress = values.tokenAddress
    if (values.tokenName) payload.tokenName = values.tokenName
    if (values.tokenSymbol) payload.tokenSymbol = values.tokenSymbol
    payload.minBuyUsd = parseFloat(values.minBuyUsd) || 1
    payload.tier1Min = parseFloat(values.tier1Min) || 100
    payload.tier2Min = parseFloat(values.tier2Min) || 500
    payload.tier3Min = parseFloat(values.tier3Min) || 1000
    payload.emojiPerTier = parseInt(values.emojiPerTier) || 4
    payload.alertImageUrl = values.alertImageUrl || null
    payload.dextUrl = values.dextUrl || null
    payload.screenerUrl = values.screenerUrl || null
    payload.buyUrl = values.buyUrl || null
    payload.trendingUrl = values.trendingUrl || null

    updateConfig.mutate({ data: payload as Parameters<typeof updateConfig.mutate>[0]["data"] })
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-48 w-full" />
        ))}
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6" data-testid="settings-form">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Configure your buy alert bot</p>
        </div>
        <Button type="submit" disabled={updateConfig.isPending} data-testid="button-save-settings">
          <Save className="w-4 h-4 mr-2" />
          {updateConfig.isPending ? "Saving..." : "Save"}
        </Button>
      </div>

      <Section icon={Bot} title="Telegram Bot" description="Connect your Telegram bot to send alerts">
        <Field
          label="Bot Token"
          type="password"
          placeholder={
            config?.hasTelegramToken
              ? `Current: ${config.telegramTokenPreview}`
              : "1234567890:ABCdefGHI..."
          }
          hint="From @BotFather on Telegram. Leave blank to keep existing token."
          {...register("telegramToken")}
          data-testid="input-telegram-token"
        />
        <Field
          label="Chat ID"
          placeholder="-1001234567890"
          hint="Your group or channel ID. Use @userinfobot or @get_id_bot to find it."
          {...register("chatId")}
          data-testid="input-chat-id"
        />
      </Section>

      <Section
        icon={Target}
        title="Token to Monitor"
        description="Paste any token contract address (Solana, Ethereum, BSC, Base, Arbitrum, Polygon…) — chain and details auto-detect"
      >
        <div className="grid gap-1.5">
          <Label className="text-sm font-medium">Token Address</Label>
          <div className="relative">
            <Input
              placeholder="Paste any token address — Solana, ETH, BSC, Base, Arbitrum, Polygon…"
              {...register("tokenAddress")}
              data-testid="input-token-address"
              className="pr-9"
            />
            {tokenLookupLoading && (
              <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-muted-foreground" />
            )}
          </div>

          {/* Token preview card */}
          {tokenPreview && !tokenLookupLoading && (
            <div
              className={`rounded-lg border p-3 mt-1 ${
                tokenPreview.found
                  ? "border-emerald-500/30 bg-emerald-500/5"
                  : "border-destructive/30 bg-destructive/5"
              }`}
              data-testid="token-preview"
            >
              {tokenPreview.found ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                    <span className="font-semibold text-sm">
                      {tokenPreview.name}{" "}
                      <span className="text-muted-foreground font-normal">({tokenPreview.symbol})</span>
                    </span>
                    {tokenPreview.priceChange24h !== null && (
                      <Badge
                        variant="outline"
                        className={
                          tokenPreview.priceChange24h >= 0
                            ? "border-emerald-500/50 text-emerald-500"
                            : "border-red-500/50 text-red-500"
                        }
                      >
                        {tokenPreview.priceChange24h >= 0 ? "+" : ""}
                        {tokenPreview.priceChange24h.toFixed(1)}% 24h
                      </Badge>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                    {tokenPreview.priceUsd !== null && (
                      <span>
                        Price: <span className="text-foreground font-medium">{formatUsd(tokenPreview.priceUsd)}</span>
                      </span>
                    )}
                    {tokenPreview.marketCap !== null && (
                      <span>
                        MCap:{" "}
                        <span className="text-foreground font-medium">{formatUsd(tokenPreview.marketCap)}</span>
                      </span>
                    )}
                  </div>
                  <div className="flex gap-3 text-xs">
                    {tokenPreview.dexscreenerUrl && (
                      <a
                        href={tokenPreview.dexscreenerUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 text-primary hover:underline"
                      >
                        DexScreener <ExternalLink className="w-2.5 h-2.5" />
                      </a>
                    )}
                    {tokenPreview.dextoolsUrl && (
                      <a
                        href={tokenPreview.dextoolsUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 text-primary hover:underline"
                      >
                        DexTools <ExternalLink className="w-2.5 h-2.5" />
                      </a>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    ✓ Name, symbol, and links auto-filled below
                  </p>
                </div>
              ) : (
                <div className="flex items-center gap-2 text-sm">
                  <AlertCircle className="w-4 h-4 text-destructive shrink-0" />
                  <span className="text-muted-foreground">
                    Token not found on DexScreener. Fill in details manually below.
                  </span>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Field
            label="Token Name"
            placeholder="e.g. SOSANA"
            {...register("tokenName")}
            data-testid="input-token-name"
          />
          <Field
            label="Symbol"
            placeholder="e.g. SOS"
            {...register("tokenSymbol")}
            data-testid="input-token-symbol"
          />
        </div>

        <Field
          label="Minimum Buy (USD)"
          type="number"
          min="0"
          step="0.01"
          placeholder="1"
          hint="Buys below this amount are ignored."
          {...register("minBuyUsd")}
          data-testid="input-min-buy"
        />
      </Section>

      <Section
        icon={BarChart3}
        title="Tier Thresholds"
        description="How many 🟢 circles appear per tier based on buy size"
      >
        <div className="grid grid-cols-3 gap-4">
          <Field
            label="🟢 Tier 1 (USD)"
            type="number"
            min="0"
            placeholder="100"
            {...register("tier1Min")}
            data-testid="input-tier1"
          />
          <Field
            label="🟢🟢 Tier 2 (USD)"
            type="number"
            min="0"
            placeholder="500"
            {...register("tier2Min")}
            data-testid="input-tier2"
          />
          <Field
            label="🟢🟢🟢 Tier 3 (USD)"
            type="number"
            min="0"
            placeholder="1000"
            {...register("tier3Min")}
            data-testid="input-tier3"
          />
        </div>
        <Field
          label="Circles Per Tier"
          type="number"
          min="1"
          max="8"
          placeholder="4"
          hint="Each tier multiplies by this. Tier 2 = 2× circles, Tier 3 = 3× circles."
          {...register("emojiPerTier")}
          data-testid="input-emoji-per-tier"
        />
      </Section>

      <Section
        icon={Image}
        title="Alert Image"
        description="Optional image or GIF shown at the top of each Telegram alert"
      >
        <Field
          label="Image URL"
          placeholder="https://example.com/banner.gif"
          hint="Must be a publicly accessible image URL."
          {...register("alertImageUrl")}
          data-testid="input-alert-image"
        />
      </Section>

      <Section
        icon={Link2}
        title="Action Links"
        description="Buttons shown at the bottom of every alert — auto-filled when you paste a token address"
      >
        <div className="grid grid-cols-2 gap-4">
          <Field
            label="DexT URL"
            placeholder="https://www.dextools.io/..."
            {...register("dextUrl")}
            data-testid="input-dext-url"
          />
          <Field
            label="Screener URL"
            placeholder="https://dexscreener.com/..."
            {...register("screenerUrl")}
            data-testid="input-screener-url"
          />
          <Field
            label="Buy URL"
            placeholder="https://raydium.io/..."
            {...register("buyUrl")}
            data-testid="input-buy-url"
          />
          <Field
            label="Trending URL"
            placeholder="https://t.me/..."
            {...register("trendingUrl")}
            data-testid="input-trending-url"
          />
        </div>
      </Section>

      <div className="pb-6">
        <Button
          type="submit"
          disabled={updateConfig.isPending}
          className="w-full sm:w-auto"
          data-testid="button-save-settings-bottom"
        >
          <Save className="w-4 h-4 mr-2" />
          {updateConfig.isPending ? "Saving..." : "Save Settings"}
        </Button>
      </div>
    </form>
  )
}
