// server.mjs
import Fastify from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import oauthPlugin from "@fastify/oauth2";


const app = Fastify({ logger: true });

// CORS
await app.register(cors, {
  origin: process.env.FRONTEND_URL
});

// JWT
await app.register(jwt, {
  secret: process.env.JWT_SECRET
});

// Google OAuth
await app.register(oauthPlugin, {
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

// Health check
app.get("/", async () => ({
  status: "Google Login Server Running 🚀"
}));

// Google callback
app.get("/auth/google/callback", async function (request, reply) {
  try {
    const token =
      await this.googleOAuth2.getAccessTokenFromAuthorizationCodeFlow(request);

    const user = await fetch(
      "https://www.googleapis.com/oauth2/v2/userinfo",
      {
        headers: {
          Authorization: `Bearer ${token.access_token}`
        }
      }
    ).then(r => r.json());

    const jwtToken = app.jwt.sign({
      googleId: user.id,
      email: user.email,
      name: user.name,
      picture: user.picture
    }, { expiresIn: "7d" });

    reply.redirect(
      `${process.env.FRONTEND_URL}/login-success?token=${jwtToken}`
    );
  } catch (err) {
    app.log.error(err, "Google login failed");
    reply.status(500).send("Authentication failed");
  }
});

// Start
const PORT = process.env.PORT || 3000;
await app.listen({ port: PORT, host: "0.0.0.0" });
