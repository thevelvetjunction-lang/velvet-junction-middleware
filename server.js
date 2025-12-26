// server.mjs
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

/* -------------------- ENV -------------------- */
const apiKey = (process.env.DEEPGRAM_API_KEY || "").trim();

if (!apiKey) {
  app.log.error("DEEPGRAM_API_KEY is missing/blank. Check Railway Variables.");
  process.exit(1);
}

app.log.info(`Env loaded. DEEPGRAM_API_KEY length: ${apiKey.length}`);

/* -------------------- DEEPGRAM CLIENT -------------------- */
let deepgram;
try {
  deepgram = createClient(apiKey);
  app.log.info("✅ Deepgram client initialized");
} catch (err) {
  app.log.error({ err }, "❌ Failed to initialize Deepgram client");
  process.exit(1);
}

/* -------------------- OPTIONAL: AUTH TEST ON BOOT -------------------- */
(async () => {
  try {
    const r = await fetch("https://api.deepgram.com/v1/auth/token", {
      headers: { Authorization: `Token ${apiKey}` },
    });
    const text = await r.text();
    app.log.info(
      { status: r.status, bodyPreview: text.slice(0, 200) },
      "Deepgram auth test"
    );
    if (!r.ok) {
      app.log.error(
        "Deepgram auth test failed. Fix the API key before testing calls."
      );
    }
  } catch (e) {
    app.log.error({ err: e }, "Deepgram auth test request failed (network/runtime)");
  }
})();

/* -------------------- HEALTH -------------------- */
app.get("/health", async () => ({ status: "ok" }));

/* -------------------- TWILIO VOICE WEBHOOK -------------------- */
app.post("/twilio/voice", async (_request, reply) => {
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
    app.log.error({ err }, "Error in /twilio/voice");
    reply.status(500).send("Error");
  }
});

/* -------------------- TWILIO STREAM WS -------------------- */
// NOTE: @fastify/websocket passes (connection, req). connection.socket is the ws.
app.get("/twilio/stream", { websocket: true }, (connection /*, req */) => {
  const socket = connection?.socket ?? connection; // support either shape
  app.log.info("✅ Twilio WebSocket connected");

  let dg;
  let dgOpen = false;
  let dgClosed = false;
  let frames = 0;
  let queued = [];
  let keepAliveTimer = null;

  const stopEverything = (why = "stopEverything") => {
    try {
      if (keepAliveTimer) clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    } catch {}

    try {
      if (dg && !dgClosed) dg.finish();
    } catch (e) {
      app.log.warn({ err: e }, "Error finishing Deepgram");
    }

    try {
      if (socket?.readyState === 1) socket.close();
    } catch {}

    app.log.info({ why }, "Stopped stream");
  };

  /* -------------------- CREATE DEEPGRAM LIVE CONNECTION -------------------- */
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
    app.log.info(`Deepgram connection has 'on' method: ${typeof dg.on === "function"}`);
  } catch (e) {
    app.log.error({ err: e }, "❌ Failed to create Deepgram live connection");
    stopEverything("dg_create_failed");
    return;
  }

  /* -------------------- DEEPGRAM EVENTS -------------------- */
  try {
    app.log.info("Attaching Deepgram event listeners...");

    dg.on(LiveTranscriptionEvents.Open, () => {
      dgOpen = true;
      app.log.info("✅ Deepgram stream OPEN (ready)");

      // Keepalive: ping every 10s (prevents idle disconnect)
      try {
        keepAliveTimer = setInterval(() => {
          try {
            // some SDK versions expose keepAlive(); otherwise no-op
            if (typeof dg.keepAlive === "function") dg.keepAlive();
            else if (typeof dg.send === "function") dg.send(Buffer.alloc(0));
          } catch {}
        }, 10000);
      } catch {}

      // Flush queued audio
      app.log.info(`Flushing ${queued.length} queued audio buffers`);
      for (const buf of queued) {
        try {
          dg.send(buf);
        } catch (err) {
          app.log.warn({ err }, "Error sending queued audio");
        }
      }
      queued = [];
    });

    dg.on(LiveTranscriptionEvents.Transcript, (data) => {
      const transcript = data?.channel?.alternatives?.[0]?.transcript;
      if (transcript && transcript.trim()) {
        app.log.info(`📞 Caller said: ${transcript}`);
      }
    });

    dg.on(LiveTranscriptionEvents.Error, (err) => {
      // The SDK sometimes gives an empty-looking object; stringify to force info out
      app.log.error(
        {
          message: err?.message,
          code: err?.code,
          status: err?.status,
          type: err?.type,
          raw: err,
          rawString: (() => {
            try {
              return JSON.stringify(err);
            } catch {
              return String(err);
            }
          })(),
        },
        "❌ Deepgram Error event"
      );
    });

    dg.on(LiveTranscriptionEvents.Close, (...args) => {
      dgClosed = true;
      app.log.error({ args }, "🔌 Deepgram Close event (details)");
    });

    app.log.info("✅ All Deepgram event listeners attached successfully");
  } catch (listenerErr) {
    app.log.error({ err: listenerErr }, "❌ Failed to attach Deepgram listeners");
    stopEverything("dg_listeners_failed");
    return;
  }

  /* -------------------- TWILIO WS EVENTS -------------------- */
  socket.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      if (data.event === "start") {
        app.log.info("Twilio stream started");
        return;
      }

      if (data.event === "stop") {
        app.log.info("Twilio stream stopped");
        // Finish Deepgram immediately so it flushes + closes cleanly
        try {
          if (dg && !dgClosed) dg.finish();
        } catch (e) {
          app.log.warn({ err: e }, "Error finishing Deepgram on stop");
        }
        return;
      }

      if (data.event !== "media") return;

      const audio = Buffer.from(data.media.payload, "base64");
      frames++;

      if (frames % 50 === 0) {
        app.log.info(`📊 Audio flowing (${frames} frames, dgOpen: ${dgOpen})`);
      }

      if (dgClosed) return;

      if (!dgOpen) {
        // queue until open (cap queue)
        queued.push(audio);
        if (queued.length > 400) queued.shift();
        return;
      }

      dg.send(audio);
    } catch (e) {
      app.log.warn({ err: e }, "Message parse/send error");
    }
  });

  socket.on("close", () => {
    app.log.info("Twilio WebSocket closed");
    stopEverything("twilio_socket_close");
  });

  socket.on("error", (err) => {
    app.log.error({ err }, "Twilio socket error");
    stopEverything("twilio_socket_error");
  });
});

/* -------------------- PROCESS ERROR HANDLERS -------------------- */
process.on("unhandledRejection", (reason) => {
  app.log.error({ reason }, "Unhandled Rejection");
});

process.on("uncaughtException", (err) => {
  app.log.error({ err }, "Uncaught Exception");
});

/* -------------------- START -------------------- */
try {
  await app.listen({ port: PORT, host: "0.0.0.0" });
  app.log.info(`✅ Server listening on port ${PORT}`);
} catch (err) {
  app.log.error({ err }, "Failed to start server");
  process.exit(1);
}
