const Fastify = require("fastify");

console.log("🔥 server.js file loaded");

const app = Fastify({
  logger: true
});

app.get("/", async (request, reply) => {
  reply.send({
    status: "OK",
    message: "🎉 Server is running perfectly on Railway (server.js)"
  });
});

app.get("/test", async () => {
  return "Hello from /test route 🚀";
});

const PORT = process.env.PORT || 8080;

app.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`🚀 Fastify listening on port ${PORT}`);
});

// Optional: log when Railway stops container
process.on("SIGTERM", () => {
  console.log("⚠️ SIGTERM received from Railway");
});
