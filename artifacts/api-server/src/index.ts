import app from "./app";
import { logger } from "./lib/logger";

// Prevent Telegram 403/network errors (unhandled promise rejections) from
// crashing the process — log them and keep running.
process.on("unhandledRejection", (reason) => {
  logger.warn({ reason: String(reason) }, "Unhandled promise rejection — continuing");
});

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Keep-alive: ping own healthz every 10 minutes so Render free tier
  // never spins down due to inactivity (spin-down threshold is 15 min).
  const selfUrl =
    process.env["RENDER_EXTERNAL_URL"] ??
    "https://safeguard-bot-nagr.onrender.com";

  setInterval(() => {
    fetch(`${selfUrl}/api/healthz`)
      .then(() => logger.info("keep-alive ping sent"))
      .catch((e: unknown) => logger.warn({ err: String(e) }, "keep-alive ping failed"));
  }, 10 * 60 * 1000); // every 10 minutes
});
