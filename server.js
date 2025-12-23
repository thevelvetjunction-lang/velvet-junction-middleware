import Fastify from "fastify";
import formbody from "@fastify/formbody";
import websocket from "@fastify/websocket";

const app = Fastify({ logger: true });
await app.register(formbody);
await app.register(websocket);

const PORT = process.env.PORT || 3000;

app.post("/twilio/voice", async (req, reply) => {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const streamUrl = `wss://${host}/twilio/stream`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Connecting you now.</Say>
  <Connect>
    <Stream url="${streamUrl}" />
  </Connect>
</Response>`;

  reply.header("Content-Type", "text/xml").send(twiml);
});

app.get("/twilio/stream", { websocket: true }, (connection) => {
  app.log.info("✅ Twilio stream connected");

  connection.socket.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.event === "start") app.log.info("▶️ stream start");
      if (msg.event === "stop") app.log.info("⏹️ stream stop");
    } catch {
      app.log.warn("Non-JSON message");
    }
  });

  connection.socket.on("close", () => {
    app.log.info("🔌 Twilio stream disconnected");
  });
});

app.get("/health", async () => ({ ok: true }));

app.listen({ port: PORT, host: "0.0.0.0" }).then(() => {
  app.log.info(`Server listening on ${PORT}`);
});
