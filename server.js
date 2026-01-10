const express = require("express");
const passport = require("./passport");
const jwt = require("jsonwebtoken");
const cors = require("cors");

const app = express();

app.use(cors({
  origin: process.env.FRONTEND_URL
}));

app.use(passport.initialize());

// 1️⃣ Start Google Login
app.get("/auth/google",
  passport.authenticate("google", {
    scope: ["profile", "email"]
  })
);

// 2️⃣ Google Callback
app.get("/auth/google/callback",
  passport.authenticate("google", { session: false }),
  (req, res) => {

    const user = {
      googleId: req.user.id,
      name: req.user.displayName,
      email: req.user.emails[0].value,
      photo: req.user.photos?.[0]?.value || ""
    };

    const token = jwt.sign(user, process.env.JWT_SECRET, {
      expiresIn: "7d"
    });

    res.redirect(
      `${process.env.FRONTEND_URL}/login-success?token=${token}`
    );
  }
);

app.get("/", (_, res) => {
  res.send("Velvet Junction Auth Running 🚀");
});

app.listen(process.env.PORT || 3000);
