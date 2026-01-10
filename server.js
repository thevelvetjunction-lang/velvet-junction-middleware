import Fastify from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import oauthPlugin from "@fastify/oauth2";
import dotenv from "dotenv";

dotenv.config();

const fastify = Fastify({ logger: true });

// CORS
await fastify.register(cors, {
  origin: process.env.FRONTEND_URL
});

// JWT
await fastify.register(jwt, {
  secret: process.env.JWT_SECRET
});

// Google OAuth
await fastify.register(oauthPlugin, {
  name: "googleOAuth2",
  scope: ["profile", "email"],
  credentials: {
    client: {
      id: process.env.GOOGLE_CLIENT_ID,
      secret: process.env.GOOGLE_CLIENT_SECRET
    },
    auth: oauthPlugin.GOOGLE_CONFIGURATION
  },
  startRedirectPath: "/auth/google",
  callbackUri:
    "https://velvet-junction-middleware-production.up.railway.app/auth/google/callback"
});

// Root
fastify.get("/", async () => {
  return { status: "Fastify Auth Running 🚀" };
});

// Callback
fastify.get("/auth/google/callback", async function (request, reply) {
  const token =
    await this.googleOAuth2.getAccessTokenFromAuthorizationCodeFlow(request);

  const userInfo = await fetch(
    "https://www.googleapis.com/oauth2/v2/userinfo",
    {
      headers: {
        Authorization: `Bearer ${token.access_token}`
      }
    }
  ).then(res => res.json());

  const jwtToken = fastify.jwt.sign({
    googleId: userInfo.id,
    email: userInfo.email,
    name: userInfo.name,
    photo: userInfo.picture
  });

  reply.redirect(
    `${process.env.FRONTEND_URL}/login-success?token=${jwtToken}`
  );
});

// Listen
const port = process.env.PORT || 3000;
await fastify.listen({ port, host: "0.0.0.0" });
