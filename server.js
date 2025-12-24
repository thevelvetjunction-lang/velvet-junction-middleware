import "dotenv/config";
import Fastify from "fastify";
import formbody from "@fastify/formbody";
import websocket from "@fastify/websocket";
import { createClient } from "@deepgram/sdk";

const app = Fastify({ logger: true });

await app.register(formbody);
await app.register(websocket);

let deepgram = null;
try {
  deepgram = createClient(process.env.DEEPGRAM_API_KEY);
  app.log.info("✅ Deepgram client initialized");
} catch (err) {
  app.log.error("Failed to initialize Deepgram:", err.message);
}

const PORT = process.env.PORT || 3000;

app.get("/health", async (request, reply) => {
  return { status: "ok" };
});

app.post("/twilio/voice", async (request, reply) => {
  try {
    const host = request.headers["x-forwarded-host"] || "velvet-junction-middleware-production.up.railway.app";
    const streamUrl = `wss://${host}/twilio/stream`;

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Connecting you now.</Say>
  <Connect>
    <Stream url="${streamUrl}" />
  </Connect>
  <Pause length="60"/>
</Response>`;

    reply.type("application/xml").send(twiml);
  } catch (err) {
    app.log.error("Error in /twilio/voice:", err.message);
    reply.status(500).send("Error");
  }
});

app.get("/twilio/stream", { websocket: true }, (socket, request) => {
  app.log.info("✅ Twilio stream connected");

  if (!deepgram) {
    app.log.error("Deepgram not initialized");
    socket.close();
    return;
  }

  let dgConnection = null;
  let audioFrameCount = 0;
  let totalAudioBytes = 0;

  try {
    dgConnection = deepgram.listen.live({
      model: "nova-2",
      language: "en",
      encoding: "mulaw",
      sample_rate: 8000,
      interim_results: true,
      punctuate: true,
    });

    dgConnection.on("open", () => {
      app.log.info("✅ Deepgram connection established");
    });

    dgConnection.on("transcriptReceived", (data) => {
      const transcript = data.channel?.alternatives?.[0]?.transcript;
      if (transcript && transcript.length > 0) {
        app.log.info(`Caller said: ${transcript}`);
      }
    });

    dgConnection.on("error", (err) => {
      app.log.error("Deepgram error:", err.message);
    });

    dgConnection.on("close", () => {
      app.log.info(`Deepgram closed. Frames: ${audioFrameCount}, Bytes: ${totalAudioBytes}`);
    });

  } catch (err) {
    app.log.error("Failed to create Deepgram connection:", err.message);
    socket.close();
    return;
  }

  socket.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.event === "media") {
        const audio = Buffer.from(msg.media.payload, "base64");
        audioFrameCount++;
        totalAudioBytes += audio.length;

        if (audioFrameCount % 10 === 0) {
          app.log.info(`Audio frame #${audioFrameCount}: ${audio.length} bytes`);
        }

        if (dgConnection) {
          dgConnection.send(audio);
        }
      } else if (msg.event === "start") {
        app.log.info("Twilio stream started");
      } else if (msg.event === "stop") {
        app.log.info("Twilio stream stopped");
      }
    } catch (err) {
      app.log.warn("Message parse error:", err.message);
    }
  });

  socket.on("close", () => {
    try {
      if (dgConnection) {
        dgConnection.finish();
      }
    } catch (err) {
      app.log.error("Error closing Deepgram:", err.message);
    }
    app.log.info("🔌 Twilio stream disconnected");
  });

  socket.on("error", (err) => {
    app.log.error("Socket error:", err.message);
  });
});

const start = async () => {
  try {
    await app.listen({ port: PORT, host: "0.0.0.0" });
    app.log.info(`Server listening on port ${PORT}`);
  } catch (err) {
    app.log.error("Failed to start server:", err.message);
    process.exit(1);
  }
};

start();
