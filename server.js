import Fastify from "fastify";

const app = Fastify({ logger: true });

// Console log your Railway env variable
console.log("MY API KEY:", process.env.DEEPGRAM_KEY);

app.listen({ port: process.env.PORT || 3000 }, () => {
  console.log("Server started");
});
