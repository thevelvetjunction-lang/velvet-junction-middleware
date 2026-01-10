// server.mjs
import Fastify from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import oauthPlugin from "@fastify/oauth2";

const app = Fastify({ logger: true });

// CORS
// Note: Agar process.env.FRONTEND_URL set nahi hai to ye bhi undefined ho sakta hai. 
// Testing ke liye aap '*' use kar sakte hain, par production me mat karna.
await app.register(cors, {
  origin: process.env.FRONTEND_URL || "*" 
});

// ✅ JWT (Static Secret Pass kiya hai testing ke liye)
await app.register(jwt, {
  secret: "my_super_secret_temp_key" // 👈 Hardcoded secret
});

// Google OAuth
// ⚠️ Dhyan rahe: Agar Railway par GOOGLE_CLIENT_ID set nahi hai, 
// to code yahan aakar fir crash ho sakta hai.
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
  callbackUri: "https://velvet-junction-middleware-production.up.railway.app/auth/google/callback"
});

// Health check
app.get("/", async () => ({
  status: "Google Login Server Running 🚀"
}));

// Google callback
app.get("/auth/google/callback", async function (request, reply) {
  try {
    const token = await this.googleOAuth2.getAccessTokenFromAuthorizationCodeFlow(request);

    const user = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${token.access_token}` }
    }).then(r => r.json());

    // JWT Sign karte waqt ab ye upar wala static secret use karega
    const jwtToken = app.jwt.sign({
      googleId: user.id,
      email: user.email,
      name: user.name,
      picture: user.picture
    }, { expiresIn: "7d" });

    // Redirect
    reply.redirect(`${process.env.FRONTEND_URL}/login-success?token=${jwtToken}`);
  } catch (err) {
    app.log.error(err, "Google login failed");
    reply.status(500).send("Authentication failed");
  }
});

// Start
const PORT = process.env.PORT || 3000;
await app.listen({ port: PORT, host: "0.0.0.0" });