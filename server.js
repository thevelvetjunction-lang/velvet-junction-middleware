import "dotenv/config";
import Fastify from "fastify";
import formbody from "@fastify/formbody";
import websocket from "@fastify/websocket";
import { createClient } from "@deepgram/sdk";

const app = Fastify({ logger: true });

await app.register(formbody);
await app.register(websocket);

// Initialise Deepgram
let deepgram = null;
try {
  deepgram = createClient(process.env.DEEPGRAM_API_KEY);
  app.log.info("✅ Deepgram client initialized");
} catch (err) {
  app.log.error("Failed to initialize Deepgram:", err.message);
}

const PORT = process.env.PORT || 3000;

// Health check
app.get("/health", async () => ({ status: "ok" }));

// Twilio Voice webhook – returns TwiML with a Stream and a Pause to keep the call alive
app.post("/twilio/voice", async (request, reply) => {
  try {
    // Use your Railway domain explicitly to avoid localhost
    const streamUrl = "wss://velvet-junction-middleware-production.up.railway.app/twilio/stream";
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

// WebSocket endpoint for Twilio Media Streams
app.get("/twilio/stream", { websocket: true }, (socket) => {
  app.log.info("✅ Twilio stream connected");

  if (!deepgram) {
    app.log.error("Deepgram not initialized");
    socket.close();
    return;
  }

  let dgConnection;
  let frameCount = 0;
  let totalBytes = 0;

  try {
    dgConnection = deepgram.listen.live({
      model: "nova-2",
      language: "en",
      encoding: "mulaw",
      sample_rate: 8000,
      interim_results: true,
      punctuate: true,
    });

    // Event handlers for the live stream
    dgConnection.on("open", () => {
      app.log.info("✅ Deepgram connection established and ready");
    });

    dgConnection.on("transcriptReceived", (data) => {
      const transcript = data.channel?.alternatives?.[0]?.transcript;
      if (transcript && transcript.length > 0) {
        app.log.info(`Caller said: ${transcript}`);
      }
    });

    dgConnection.on("error", (err) => {
      app.log.error("Deepgram error:", err?.message || err?.toString() || "Unknown error");
    });

    dgConnection.on("close", () => {
      app.log.info(`Deepgram closed. Frames: ${frameCount}, Bytes: ${totalBytes}`);
    });
  } catch (err) {
    app.log.error("Failed to create Deepgram connection:", err.message || err);
    socket.close();
    return;
  }

  // Handle incoming Twilio media messages
  socket.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.event === "media") {
        const audio = Buffer.from(msg.media.payload, "base64");
        frameCount++;
        totalBytes += audio.length;
        // Optional: log every 10 frames
        if (frameCount % 10 === 0) {
          app.log.info(`Audio frame #${frameCount}: ${audio.length} bytes`);
        }
        if (dgConnection) {
          try {
            dgConnection.send(audio);
          } catch (sendErr) {
            app.log.error("Error sending audio to Deepgram:", sendErr.message);
          }
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

// Start the Fastify server
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
