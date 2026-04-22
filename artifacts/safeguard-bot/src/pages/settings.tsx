import { useEffect } from "react"
import { useForm } from "react-hook-form"
import {
  useGetBotConfig,
  useUpdateBotConfig,
  getGetBotConfigQueryKey,
} from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { useToast } from "@/hooks/use-toast"
import { Save, Bot, Target, Link2, BarChart3, Image } from "lucide-react"

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

function Section({ icon: Icon, title, description, children }: {
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

function Field({ label, hint, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
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

  const { register, handleSubmit, reset } = useForm<FormValues>({
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
    if (values.alertImageUrl !== undefined) payload.alertImageUrl = values.alertImageUrl || null
    if (values.dextUrl !== undefined) payload.dextUrl = values.dextUrl || null
    if (values.screenerUrl !== undefined) payload.screenerUrl = values.screenerUrl || null
    if (values.buyUrl !== undefined) payload.buyUrl = values.buyUrl || null
    if (values.trendingUrl !== undefined) payload.trendingUrl = values.trendingUrl || null

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
          placeholder={config?.hasTelegramToken ? `Current: ${config.telegramTokenPreview}` : "1234567890:ABCdefGHI..."}
          hint="From @BotFather on Telegram. Leave blank to keep existing token."
          {...register("telegramToken")}
          data-testid="input-telegram-token"
        />
        <Field
          label="Chat ID"
          placeholder="-1001234567890"
          hint="Group or channel ID where alerts will be posted. Use a negative number for groups."
          {...register("chatId")}
          data-testid="input-chat-id"
        />
      </Section>

      <Section icon={Target} title="Token to Monitor" description="Solana token contract address">
        <Field
          label="Token Address"
          placeholder="So11111111111111111111111111111111111111112"
          hint="The Solana mint address of the token to watch for purchases."
          {...register("tokenAddress")}
          data-testid="input-token-address"
        />
        <div className="grid grid-cols-2 gap-4">
          <Field label="Token Name" placeholder="My Token" {...register("tokenName")} data-testid="input-token-name" />
          <Field label="Symbol" placeholder="MTK" {...register("tokenSymbol")} data-testid="input-token-symbol" />
        </div>
        <Field
          label="Minimum Buy (USD)"
          type="number"
          min="0"
          step="0.01"
          placeholder="1"
          hint="Ignore buys below this USD amount."
          {...register("minBuyUsd")}
          data-testid="input-min-buy"
        />
      </Section>

      <Section icon={BarChart3} title="Tier Thresholds" description="Green circle tiers based on USD spent">
        <div className="grid grid-cols-3 gap-4">
          <Field
            label="🟢 Tier 1 (USD)"
            type="number"
            min="0"
            placeholder="100"
            hint="e.g. 4 circles"
            {...register("tier1Min")}
            data-testid="input-tier1"
          />
          <Field
            label="🟢🟢 Tier 2 (USD)"
            type="number"
            min="0"
            placeholder="500"
            hint="e.g. 8 circles"
            {...register("tier2Min")}
            data-testid="input-tier2"
          />
          <Field
            label="🟢🟢🟢 Tier 3 (USD)"
            type="number"
            min="0"
            placeholder="1000"
            hint="e.g. 12 circles"
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
          hint="Number of 🟢 added per tier level."
          {...register("emojiPerTier")}
          data-testid="input-emoji-per-tier"
        />
      </Section>

      <Section icon={Image} title="Alert Image" description="Optional image shown at the top of each alert">
        <Field
          label="Image URL"
          placeholder="https://example.com/banner.gif"
          hint="Public image or GIF URL. Leave blank for text-only alerts."
          {...register("alertImageUrl")}
          data-testid="input-alert-image"
        />
      </Section>

      <Section icon={Link2} title="Action Links" description="Buttons shown at the bottom of each alert">
        <div className="grid grid-cols-2 gap-4">
          <Field label="DexT URL" placeholder="https://www.dextools.io/..." {...register("dextUrl")} data-testid="input-dext-url" />
          <Field label="Screener URL" placeholder="https://dexscreener.com/..." {...register("screenerUrl")} data-testid="input-screener-url" />
          <Field label="Buy URL" placeholder="https://raydium.io/..." {...register("buyUrl")} data-testid="input-buy-url" />
          <Field label="Trending URL" placeholder="https://t.me/..." {...register("trendingUrl")} data-testid="input-trending-url" />
        </div>
      </Section>

      <div className="pb-6">
        <Button type="submit" disabled={updateConfig.isPending} className="w-full sm:w-auto" data-testid="button-save-settings-bottom">
          <Save className="w-4 h-4 mr-2" />
          {updateConfig.isPending ? "Saving..." : "Save Settings"}
        </Button>
      </div>
    </form>
  )
}
