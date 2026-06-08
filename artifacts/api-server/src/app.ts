import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "path";
import { fileURLToPath } from "url";
import router from "./routes";
import { logger } from "./lib/logger";
import { botRegistry } from "./bot/botRegistry";
import { startCommandBot } from "./bot/commandBot";
import { pool } from "@workspace/db";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// Serve the React dashboard (built by Vite into artifacts/safeguard-bot/dist/public)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendDist = path.resolve(__dirname, "../../safeguard-bot/dist/public");
app.use(express.static(frontendDist));
app.use((_req, res) => {
  res.sendFile(path.join(frontendDist, "index.html"));
});

// Auto-migrate: ensure custom_commands table exists (safe to run every startup)
pool.query(`
  CREATE TABLE IF NOT EXISTS custom_commands (
    id SERIAL PRIMARY KEY,
    bot_config_id INTEGER REFERENCES bot_config(id) ON DELETE CASCADE,
    command_name TEXT NOT NULL,
    message_text TEXT NOT NULL,
    buttons_json TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`).then(() => logger.info("custom_commands table ready"))
  .catch((err: unknown) => logger.error({ err }, "custom_commands migration failed"));

// Auto-migrate: add presale columns to bot_config (safe to run every startup)
pool.query(`
  ALTER TABLE bot_config
    ADD COLUMN IF NOT EXISTS presale_tagline TEXT,
    ADD COLUMN IF NOT EXISTS presale_quote   TEXT
`).then(() => logger.info("presale columns ready"))
  .catch((err: unknown) => logger.error({ err }, "presale column migration failed"));

botRegistry.autoStartAll().catch((err) => {
  logger.error({ err }, "Failed to auto-start bots");
});

startCommandBot();

export default app;
