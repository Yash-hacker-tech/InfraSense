const http = require("http");

require("dotenv").config();

const { createApp } = require("./app");
const { connectDb } = require("./config/db");
const { warmUpOllama } = require("./services/spamDetectionService");

const PORT = process.env.PORT || 5000;

async function start() {
  await connectDb();

  const app = createApp();
  const server = http.createServer(app);

  server.listen(PORT, () => {
    process.stdout.write(`Backend listening on port ${PORT}\n`);

    // Fire warmup in background — does NOT block server startup.
    // This pre-loads the Llama 3 model into GPU VRAM so the first
    // citizen issue submission doesn't stall for ~60 seconds.
    warmUpOllama().catch((err) => {
      process.stderr.write(`[InfraSense AI] Warmup error: ${err?.message || err}\n`);
    });
  });
}

start().catch((err) => {
  process.stderr.write(`${err?.stack || err}\n`);
  process.exit(1);
});
