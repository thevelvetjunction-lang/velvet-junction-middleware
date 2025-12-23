import "dotenv/config";
import Fastify from "fastify";
import formbody from "@fastify/formbody";
import websocket from "@fastify/websocket";
import { createClient } from "@deepgram/sdk";

const app = Fastify({ logger: true });
await app.register(formbody);
await app.register(websocket);

const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

const PORT = process.env.PORT || 3000;

app.post("/twilio/voice", async (req, reply) => {
  const streamUrl = `wss://${req.headers["x-forwarded-host"]}/twilio/stream`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Connecting you now.</Say>
  <Connect>
    <Stream url="${streamUrl}" />
  </Connect>
  <Pause length="60"/>
</Response>`;

  reply.header("Content-Type", "text/xml").send(twiml);
});

app.get("/twilio/stream", { websocket: true }, (connection) => {
  app.log.info("✅ Twilio stream connected");

  const dgConnection = deepgram.listen.live({
    model: "nova-2",
    language: "en",
    encoding: "mulaw",
    sample_rate: 8000,
    interim_results: true,
    punctuate: true,
  });

  dgConnection.on("open", () => {
    app.log.info("✅ Deepgram connection established");

    dgConnection.on("transcriptReceived", (data) => {
      const transcript = data.channel?.alternatives?.[0]?.transcript;
      if (transcript && transcript.length > 0) {
        app.log.info(`Caller said: ${transcript}`);
      }
    });

    dgConnection.on("error", (err) => {
      app.log.error("Deepgram error:", err);
    });

    connection.socket.on("message", (raw) => {
      app.log.info("Receiving a message from Twilio...");
      try {
        const msg = JSON.parse(raw.toString());

        if (msg.event === "media") {
          app.log.info("Twilio media message received");
          const audio = Buffer.from(msg.media.payload, "base64");
          dgConnection.send(audio);
        }
      } catch (err) {
        app.log.warn("Non-JSON message from Twilio:", raw.toString());
      }
    });

    connection.socket.on("close", () => {
      dgConnection.finish();
      app.log.info("🔌 Twilio stream disconnected");
    });
  });
});

app.get("/health", async () => ({ ok: true }));

app.listen({ port: PORT, host: "0.0.0.0" }).then(() => {
  app.log.info(`Server listening on ${PORT}`);
});
