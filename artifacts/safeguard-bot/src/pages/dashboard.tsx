import { useState } from "react"
import { Link } from "wouter"
import {
  useListBots,
  useCreateBot,
  useStartBot,
  useStopBot,
  useDeleteBot,
  getListBotsQueryKey,
} from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useToast } from "@/hooks/use-toast"
import { Plus, Play, Square, Trash2, Settings2, Activity, Coins } from "lucide-react"

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

export default function Dashboard() {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const { data: bots, isLoading } = useListBots()
  const createBot = useCreateBot()
  const startBot = useStartBot()
  const stopBot = useStopBot()
  const deleteBot = useDeleteBot()

  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState("")
  const [deleteId, setDeleteId] = useState<number | null>(null)

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: getListBotsQueryKey() })
  }

  async function handleCreate() {
    if (!newName.trim()) return
    await createBot.mutateAsync({ name: newName.trim() })
    setNewName("")
    setShowCreate(false)
    invalidate()
    toast({ title: "Bot created", description: `"${newName.trim()}" is ready to configure.` })
  }

  async function handleStart(id: number, e: React.MouseEvent) {
    e.preventDefault()
    const result = await startBot.mutateAsync({ id })
    invalidate()
    if (result.running) {
      toast({ title: "Bot started", description: "Now monitoring on-chain buys live." })
    } else {
      toast({ title: "Failed to start", description: result.error ?? "Unknown error", variant: "destructive" })
    }
  }

  async function handleStop(id: number, e: React.MouseEvent) {
    e.preventDefault()
    await stopBot.mutateAsync({ id })
    invalidate()
    toast({ title: "Bot stopped" })
  }

  async function handleDelete(id: number) {
    await deleteBot.mutateAsync({ id })
    setDeleteId(null)
    invalidate()
    toast({ title: "Bot deleted" })
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold">My Bots</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Each bot monitors a different token and sends alerts to its own Telegram group.
          </p>
        </div>
        <Button onClick={() => setShowCreate(true)} className="gap-2">
          <Plus className="w-4 h-4" />
          New Bot
        </Button>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[...Array(3)].map((_, i) => (
            <Card key={i}>
              <CardHeader className="pb-3">
                <Skeleton className="h-5 w-32" />
                <Skeleton className="h-4 w-24 mt-1" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-8 w-full mt-3" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : bots && bots.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {bots.map((bot) => (
            <Link key={bot.id} href={`/bots/${bot.id}`}>
              <Card className="cursor-pointer hover:border-emerald-500/60 hover:shadow-md transition-all duration-200 group h-full">
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle className="text-base font-semibold leading-snug group-hover:text-emerald-400 transition-colors">
                      {bot.name}
                    </CardTitle>
                    <Badge
                      variant={bot.running ? "default" : "secondary"}
                      className={`text-[10px] shrink-0 ${
                        bot.running
                          ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30"
                          : "bg-slate-800 text-slate-400"
                      }`}
                    >
                      {bot.running ? "🟢 Live" : "⚫ Off"}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    {bot.tokenSymbol ? (
                      <>
                        <Coins className="w-3 h-3" />
                        <span>{bot.tokenSymbol}</span>
                        {bot.chain && <span className="text-slate-600">·</span>}
                        {bot.chain && <span>{CHAIN_LABELS[bot.chain] ?? bot.chain}</span>}
                      </>
                    ) : (
                      <span className="text-yellow-500/70 text-[11px]">⚠ Token not configured</span>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="pt-0">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-4">
                    <Activity className="w-3 h-3" />
                    <span>{bot.alertCount.toLocaleString()} alerts sent</span>
                    {bot.error && (
                      <span className="text-red-400 truncate max-w-[110px]" title={bot.error}>
                        · {bot.error}
                      </span>
                    )}
                  </div>
                  <div className="flex gap-2">
                    {bot.running ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1 gap-1.5 text-red-400 border-red-500/30 hover:bg-red-500/10 hover:text-red-300"
                        onClick={(e) => handleStop(bot.id, e)}
                      >
                        <Square className="w-3 h-3" />
                        Stop
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1 gap-1.5 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/10 hover:text-emerald-300"
                        onClick={(e) => handleStart(bot.id, e)}
                      >
                        <Play className="w-3 h-3" />
                        Start
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="gap-1.5 text-muted-foreground hover:text-foreground"
                      onClick={(e) => e.preventDefault()}
                      asChild
                    >
                      <span>
                        <Settings2 className="w-3 h-3" />
                        Configure
                      </span>
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-red-400/50 hover:text-red-400 hover:bg-red-500/10 px-2"
                      onClick={(e) => { e.preventDefault(); setDeleteId(bot.id) }}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <div className="w-16 h-16 rounded-full bg-emerald-500/10 flex items-center justify-center mb-4">
            <Plus className="w-8 h-8 text-emerald-500" />
          </div>
          <h2 className="text-lg font-semibold mb-2">No bots yet</h2>
          <p className="text-muted-foreground text-sm max-w-sm mb-6">
            Create your first bot to start monitoring token buys on-chain and sending real Telegram alerts.
          </p>
          <Button onClick={() => setShowCreate(true)} className="gap-2">
            <Plus className="w-4 h-4" />
            Create your first bot
          </Button>
        </div>
      )}

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create New Bot</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="bot-name">Bot Name</Label>
              <Input
                id="bot-name"
                placeholder="e.g. SOSANA Group, ETH Whale Bot"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                autoFocus
              />
              <p className="text-xs text-muted-foreground">
                Configure token, Telegram settings and tier thresholds after creation.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowCreate(false); setNewName("") }}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={!newName.trim() || createBot.isPending}>
              {createBot.isPending ? "Creating…" : "Create Bot"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteId !== null} onOpenChange={(open) => !open && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this bot?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the bot and all its alert history.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              onClick={() => deleteId !== null && handleDelete(deleteId)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
