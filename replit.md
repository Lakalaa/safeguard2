# Workspace

## Overview

Multi-tenant crypto buy alert bot dashboard. Each configured bot monitors a different token on any chain (Solana, Ethereum, BSC, Base, Arbitrum, Polygon, Avalanche, Optimism), posts formatted buy alerts to its own Telegram group. Zero simulated data — all monitoring is live on-chain.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Frontend**: React + Vite + shadcn/ui + Wouter routing
- **Build**: esbuild (CJS bundle)

## Architecture

### Packages
- `lib/db` — Drizzle schema: `botConfigTable` (one row per bot), `alertsTable` (FK to botConfigId)
- `lib/api-spec` — OpenAPI spec → codegen target
- `lib/api-zod` — Generated Zod validators; **after every codegen, fix `src/index.ts` to only `export * from "./generated/api";`**
- `lib/api-client-react` — Generated React Query hooks
- `artifacts/api-server` — Express server with multi-bot registry
- `artifacts/safeguard-bot` — React dashboard (dark theme, shadcn)

### Multi-bot Engine
`artifacts/api-server/src/bot/botRegistry.ts` — `BotRegistry` class holds a `Map<configId, BotInstance>`. Each instance has its own monitor (SolanaMonitor or EvmMonitor) and its own Telegram bot client. On server boot, `autoStartAll()` restarts all `isActive=true` bots. Chain detection uses DexScreener API; EVM chains use ethers.js Transfer event filtering.

### API Routes (all under `/api`)
- `GET /bots` — list all with live status + alert counts
- `POST /bots` — create new bot config
- `GET /bots/:id`, `PUT /bots/:id`, `DELETE /bots/:id`
- `POST /bots/:id/start|stop|test`
- `GET /bots/:id/alerts`, `GET /bots/:id/stats`
- `GET /token-info?address=` — DexScreener lookup

### Frontend Pages
- `/` — Dashboard: grid of bot cards, create/delete/start/stop
- `/bots/:id` — Bot detail: stats cards + "Buy Alerts" and "Settings" tabs
- Settings tab: token address (auto-fills from DexScreener), Telegram token/chatId, tier thresholds, image, links

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/db run push-force` — force push (drops+recreates)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

## Critical Notes
- After every codegen run: `lib/api-zod/src/index.ts` must be `export * from "./generated/api";` only — remove any `./generated/api.schemas` export that orval auto-adds.
- Drizzle push command: `pnpm --filter @workspace/db run push` (or `push-force` for dropping).
- Old single-bot routes (`/bot/config`, `/bot/status`, `/bot/start`, `/bot/stop`, `/bot/test`, `/alerts`, `/stats`) are removed — replaced by `/bots/*` multi-bot endpoints.
- `artifacts/api-server/src/bot/buyAlertBot.ts` is superseded by `botRegistry.ts` — kept on disk but no longer imported.
