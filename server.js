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
  const host = req.headers["x-forwarded-host"] || "velvet-junction-middleware-production.up.railway.app";
  const streamUrl = `wss://${host}/twilio/stream`;

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

  let dgConnection;
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

    if (!dgConnection) {
      app.log.error("Deepgram connection is null or undefined");
      connection.socket.close();
      return;
    }

    dgConnection.on("open", () => {
      app.log.info("✅ Deepgram connection established");
      audioFrameCount = 0;
      totalAudioBytes = 0;
    });

    dgConnection.on("transcriptReceived", (data) => {
      try {
        const transcript = data.channel?.alternatives?.[0]?.transcript;
        if (transcript && transcript.length > 0) {
          app.log.info(`Caller said: ${transcript}`);
        }
      } catch (err) {
        app.log.error("Error processing transcript:", err.message);
      }
    });

    dgConnection.on("error", (err) => {
      app.log.error("Deepgram error:", err.message || err);
    });

    dgConnection.on("close", () => {
      app.log.info(`Deepgram connection closed. Total frames sent: ${audioFrameCount}, Total bytes: ${totalAudioBytes}`);
    });

  } catch (err) {
    app.log.error("Failed to create Deepgram connection:", err.message || err);
    connection.socket.close();
    return;
  }

  connection.socket.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.event === "media") {
        const audio = Buffer.from(msg.media.payload, "base64");
        audioFrameCount++;
        totalAudioBytes += audio.length;
        
        if (audioFrameCount % 10 === 0) {
          app.log.info(`Audio frame #${audioFrameCount}: ${audio.length} bytes (total: ${totalAudioBytes} bytes)`);
        }
        
        if (dgConnection && dgConnection.send) {
          dgConnection.send(audio);
        } else {
          app.log.warn("Deepgram connection not ready, cannot send audio");
        }
      } else if (msg.event === "start") {
        app.log.info("Twilio stream started");
      } else if (msg.event === "stop") {
        app.log.info("Twilio stream stopped");
      }
    } catch (err) {
      app.log.warn("Failed to parse message from Twilio:", err.message);
    }
  });

  connection.socket.on("close", () => {
    try {
      if (dgConnection && dgConnection.finish) {
        dgConnection.finish();
      }
    } catch (err) {
      app.log.error("Error finishing Deepgram connection:", err.message);
    }
    app.log.info("🔌 Twilio stream disconnected");
  });
});

app.get("/health", async () => ({ ok: true }));

app.listen({ port: PORT, host: "0.0.0.0" }).then(() => {
  app.log.info(`Server listening on ${PORT}`);
});
