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

const apiKey = process.env.DEEPGRAM_API_KEY;
const keyStart = apiKey.substring(0, 10);
const keyEnd = apiKey.substring(apiKey.length - 5);
app.log.info(`API Key format: ${keyStart}...${keyEnd}`);

/* -------------------- DEEPGRAM -------------------- */
let deepgram;
try {
  deepgram = createClient(process.env.DEEPGRAM_API_KEY);
  app.log.info("✅ Deepgram client initialized");
} catch (err) {
  app.log.error("❌ Failed to initialize Deepgram:", err.message);
  process.exit(1);
}

/* -------------------- HEALTH -------------------- */
app.get("/health", async () => ({ status: "ok" }));

/* -------------------- TWILIO VOICE -------------------- */
app.post("/twilio/voice", async (request, reply) => {
  try {
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
  } catch (err) {
    app.log.error("Error in /twilio/voice:", err.message);
    reply.status(500).send("Error");
  }
});

/* -------------------- TWILIO STREAM -------------------- */
app.get("/twilio/stream", { websocket: true }, (socket) => {
  app.log.info("✅ Twilio WebSocket connected");

  let dg;
  let dgOpen = false;
  let dgClosed = false;
  let frames = 0;
  let queued = [];

  try {
    app.log.info("Creating Deepgram live connection...");
    
    dg = deepgram.listen.live({
      model: "nova-2",
      language: "en",
      encoding: "mulaw",
      sample_rate: 8000,
      interim_results: true,
      punctuate: true,
      smart_format: true,
    });

    app.log.info("✅ Deepgram connection object created");
    app.log.info(`Deepgram connection type: ${typeof dg}`);
    app.log.info(`Deepgram connection has 'on' method: ${typeof dg.on === 'function'}`);
    
  } catch (e) {
    app.log.error("❌ Failed to create Deepgram connection:", {
      message: e.message,
      stack: e.stack,
      code: e.code
    });
    socket.close();
    return;
  }

  // Attach all event listeners IMMEDIATELY
  try {
    app.log.info("Attaching Deepgram event listeners...");

    dg.on(LiveTranscriptionEvents.Open, () => {
      dgOpen = true;
      app.log.info("✅ Deepgram stream open and ready");

      // Flush queued audio
      app.log.info(`Flushing ${queued.length} queued audio buffers`);
      for (const buf of queued) {
        try {
          dg.send(buf);
        } catch (err) {
          app.log.warn("Error sending queued audio:", err.message);
        }
      }
      queued = [];
    });

    dg.on(LiveTranscriptionEvents.Transcript, (data) => {
      try {
        const transcript = data?.channel?.alternatives?.[0]?.transcript;
        if (transcript && transcript.trim()) {
          app.log.info(`📞 Caller said: ${transcript}`);
        }
      } catch (err) {
        app.log.warn("Error processing transcript:", err.message);
      }
    });

    dg.on(LiveTranscriptionEvents.Error, (err) => {
      app.log.error("❌ Deepgram WebSocket Error Event Fired");
      app.log.error("Error object:", err);
      app.log.error("Error message:", err?.message);
      app.log.error("Error code:", err?.code);
      app.log.error("Error status:", err?.status);
      app.log.error("Error type:", err?.type);
      if (err) {
        app.log.error("Error keys:", Object.keys(err));
        app.log.error("Error toString:", err.toString());
      }
    });

    dg.on(LiveTranscriptionEvents.Close, () => {
      dgClosed = true;
      app.log.info("🔌 Deepgram stream closed");
    });

    app.log.info("✅ All Deepgram event listeners attached successfully");

  } catch (listenerErr) {
    app.log.error("❌ Failed to attach event listeners:", listenerErr.message);
    socket.close();
    return;
  }

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
        app.log.info(`📊 Audio flowing (${frames} frames, dgOpen: ${dgOpen})`);
      }

      if (dgClosed) {
        app.log.warn("Deepgram connection closed, dropping audio");
        return;
      }

      if (!dgOpen) {
        queued.push(audio);
        if (queued.length > 200) queued.shift();
        return;
      }

      try {
        dg.send(audio);
      } catch (sendErr) {
        app.log.error("Error sending audio to Deepgram:", sendErr.message);
      }
    } catch (e) {
      app.log.warn("Message parse error:", e.message);
    }
  });

  socket.on("close", () => {
    app.log.info("Twilio WebSocket closed");
    try {
      if (dg) {
        dg.finish();
      }
    } catch (err) {
      app.log.warn("Error closing Deepgram connection:", err.message);
    }
  });

  socket.on("error", (err) => {
    app.log.error("Socket error:", err.message);
  });
});

/* -------------------- ERROR HANDLERS -------------------- */
process.on("unhandledRejection", (reason, promise) => {
  app.log.error("Unhandled Rejection:", reason);
});

process.on("uncaughtException", (err) => {
  app.log.error("Uncaught Exception:", err.message);
});

/* -------------------- START -------------------- */
try {
  await app.listen({ port: PORT, host: "0.0.0.0" });
  app.log.info(`✅ Server listening on port ${PORT}`);
} catch (err) {
  app.log.error("Failed to start server:", err.message);
  process.exit(1);
}
