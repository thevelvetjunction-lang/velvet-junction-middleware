import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import Fastify from "fastify";
import formbody from "@fastify/formbody";
import websocket from "@fastify/websocket";
import { createClient, LiveTranscriptionEvents } from "@deepgram/sdk";

const app = Fastify({ logger: true });

await app.register(formbody);
await app.register(websocket);

const PORT = process.env.PORT || 3000;

/* -------------------- ENV VALIDATION -------------------- */
if (!process.env.DEEPGRAM_API_KEY) {
  app.log.error("DEEPGRAM_API_KEY is missing. Check Railway Variables.");
  process.exit(1);
}

app.log.info(
  `Env loaded. DEEPGRAM_API_KEY length: ${process.env.DEEPGRAM_API_KEY.length}`
);

/* -------------------- DEEPGRAM -------------------- */
const deepgram = createClient(process.env.DEEPGRAM_API_KEY);
app.log.info("Deepgram client initialized");

/* -------------------- HEALTH -------------------- */
app.get("/health", async () => ({ status: "ok" }));

/* -------------------- TWILIO VOICE -------------------- */
app.post("/twilio/voice", async (request, reply) => {
  // 🔒 LOCKED TO RAILWAY (NO NGROK, NO HEADERS)
  const streamUrl =
    "wss://velvet-junction-middleware-production.up.railway.app/twilio/stream";

  app.log.info(`Twilio will stream audio to: ${streamUrl}`);

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Connecting you now.</Say>
  <Connect>
    <Stream url="${streamUrl}" />
  </Connect>
  <Pause length="600"/>
</Response>`;

  reply.type("application/xml").send(twiml);
});

/* -------------------- TWILIO STREAM -------------------- */
app.get("/twilio/stream", { websocket: true }, (socket) => {
  app.log.info("Twilio WebSocket connected");

  let dg;
  let dgOpen = false;
  let dgClosed = false;
  let frames = 0;
  let queued = [];

  try {
    dg = deepgram.listen.live({
      model: "nova-2",
      language: "en",
      encoding: "mulaw",
      sample_rate: 8000,
      interim_results: true,
      punctuate: true,
      smart_format: true,
    });
  } catch (e) {
    app.log.error({ err: e }, "Failed to create Deepgram connection");
    socket.close();
    return;
  }

  dg.on(LiveTranscriptionEvents.Open, () => {
    dgOpen = true;
    app.log.info("Deepgram stream open");

    for (const buf of queued) {
      try {
        dg.send(buf);
      } catch {}
    }
    queued = [];
  });

  dg.on(LiveTranscriptionEvents.Transcript, (data) => {
    const transcript = data?.channel?.alternatives?.[0]?.transcript;
    if (transcript && transcript.trim()) {
      app.log.info(`Caller said: ${transcript}`);
    }
  });

  dg.on(LiveTranscriptionEvents.Error, (err) => {
    app.log.error({ err }, "Deepgram error");
  });

  dg.on(LiveTranscriptionEvents.Close, () => {
    dgClosed = true;
    app.log.warn("Deepgram stream closed");
  });

  socket.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      if (data.event === "start") {
        app.log.info("Twilio stream started");
        return;
      }

      if (data.event === "stop") {
        app.log.info("Twilio stream stopped");
        return;
      }

      if (data.event !== "media") return;

      const audio = Buffer.from(data.media.payload, "base64");
      frames++;

      if (frames % 50 === 0) {
        app.log.info(`Audio flowing (${frames} frames)`);
      }

      if (dgClosed) return;

      if (!dgOpen) {
        queued.push(audio);
        if (queued.length > 200) queued.shift();
        return;
      }

      dg.send(audio);
    } catch (e) {
      app.log.warn({ err: e }, "Message parse error");
    }
  });

  socket.on("close", () => {
    app.log.info("Twilio WebSocket closed");
    try {
      dg?.finish();
    } catch {}
  });

  socket.on("error", (err) => {
    app.log.error({ err }, "Socket error");
  });
});

/* -------------------- START -------------------- */
await app.listen({ port: PORT, host: "0.0.0.0" });
app.log.info(`Server listening on port ${PORT}`);
