import Fastify from "fastify";

const app = Fastify({ logger: true });

// Simple test route
app.get("/", async () => {
  return {
    status: "OK",
    message: "🎉 Server is running perfectly on Railway"
  };
});

// Another test route (optional)
app.get("/test", async () => {
  return "Hello from /test route 🚀";
});

const PORT = process.env.PORT || 3000;

await app.listen({ port: PORT, host: "0.0.0.0" });

app.log.info(`Test server running on port ${PORT}`);
