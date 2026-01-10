import Fastify from "fastify";

console.log("🔥 server.mjs loaded");

const app = Fastify({
  logger: true
});

// VERY IMPORTANT: root route
app.get("/", async (request, reply) => {
  reply
    .code(200)
    .header("content-type", "application/json")
    .send({
      status: "OK",
      message: "🎉 Railway server is alive"
    });
});

const PORT = Number(process.env.PORT) || 8080;

// IMPORTANT: await + 0.0.0.0
await app.listen({
  port: PORT,
  host: "0.0.0.0"
});

console.log("🚀 Fastify listening on", PORT);
