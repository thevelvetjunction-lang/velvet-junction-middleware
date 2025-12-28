// server.mjs

import Fastify from "fastify";
import formbody from "@fastify/formbody";
import websocket from "@fastify/websocket";
import { createClient, LiveTranscriptionEvents } from "@deepgram/sdk";

const app = Fastify({ logger: true });

await app.register(formbody);
await app.register(websocket);

const PORT = process.env.PORT || 3000;

const apiKey = (process.env.DEEPGRAM_KEY);

if (!apiKey) {
  app.log.error("DEEPGRAM_API_KEY is missing/blank. Check Railway Variables.");
  process.exit(1);
}

app.log.info(`Env loaded. DEEPGRAM_API_KEY length: ${apiKey.length}`);

let deepgram;
try {
  deepgram = createClient(apiKey);
  app.log.info("Deepgram client initialized");
} catch (err) {
  app.log.error({ err }, "Failed to initialize Deepgram client");
  process.exit(1);
}

// Optional auth test
(async () => {
  try {
    const r = await fetch("https://api.deepgram.com/v1/auth/token", {
      headers: { Authorization: `Token ${apiKey}` },
    });
    const text = await r.text();
    app.log.info({ status: r.status, bodyPreview: text.slice(0, 200) }, "Deepgram auth test");
    if (!r.ok) {
      app.log.error("Deepgram auth test failed. Fix the API key before testing calls.");
    }
  } catch (e) {
    app.log.error({ err: e }, "Deepgram auth test request failed");
  }
})();

app.get("/health", async () => ({ status: "ok" }));

app.post("/twilio/voice", async (_request, reply) => {
  try {
    const streamUrl = "wss://velvet-junction-middleware-production.up.railway.app/twilio/stream";

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

app.get("/twilio/stream", { websocket: true }, (connection) => {
  const socket = connection?.socket ?? connection;
  app.log.info("Twilio WebSocket connected");

  let dg;
  let dgOpen = false;
  let dgClosed = false;
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

  try {
    dg = deepgram.listen.live({
      model: "nova-2",
      language: "en",
      encoding: "mulaw",
      sample_rate: 8000,
      interim_results: true,
      punctuate: true,
      smart_format: true,
      endpointing: 300,
      utterance_end_ms: 1000,
      vad_events: true
    });

    app.log.info("Deepgram connection object created");
  } catch (e) {
    app.log.error({ err: e }, "Failed to create Deepgram live connection");
    stopEverything("dg_create_failed");
    return;
  }

  try {
    dg.on(LiveTranscriptionEvents.Open, () => {
      dgOpen = true;
      app.log.info("Deepgram stream OPEN (ready)");

      keepAliveTimer = setInterval(() => {
        try {
          if (typeof dg.keepAlive === "function") dg.keepAlive();
          else if (typeof dg.send === "function") dg.send(Buffer.alloc(0));
        } catch {}
      }, 10000);

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
      const alt = data?.channel?.alternatives?.[0];
      const transcript = alt?.transcript;
      if (!transcript || !transcript.trim()) return;

      if (data.is_final) {
        app.log.info(`Sentence: ${transcript}`);
      }
    });

    dg.on(LiveTranscriptionEvents.Error, (err) => {
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
        "Deepgram Error event"
      );
    });

    dg.on(LiveTranscriptionEvents.Close, (...args) => {
      dgClosed = true;
      app.log.error({ args }, "Deepgram Close event");
    });

  } catch (listenerErr) {
    app.log.error({ err: listenerErr }, "Failed to attach Deepgram listeners");
    stopEverything("dg_listeners_failed");
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
        try {
          if (dg && !dgClosed) dg.finish();
        } catch (e) {
          app.log.warn({ err: e }, "Error finishing Deepgram on stop");
        }
        return;
      }

      if (data.event !== "media") return;

      const audio = Buffer.from(data.media.payload, "base64");

      if (dgClosed) return;

      if (!dgOpen) {
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

process.on("unhandledRejection", (reason) => {
  app.log.error({ reason }, "Unhandled Rejection");
});

process.on("uncaughtException", (err) => {
  app.log.error({ err }, "Uncaught Exception");
});

try {
  await app.listen({ port: PORT, host: "0.0.0.0" });
  app.log.info(`Server listening on port ${PORT}`);
} catch (err) {
  app.log.error({ err }, "Failed to start server");
  process.exit(1);
}
