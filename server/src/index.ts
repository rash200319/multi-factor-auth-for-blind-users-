import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { PORT, ORIGIN } from "./config.js";
import { registerRouter } from "./routes/register.js";
import { authRouter } from "./routes/auth.js";
import { stepupRouter } from "./routes/stepup.js";
import { recoveryRouter } from "./routes/recovery.js";
import { sessionRouter } from "./routes/session.js";
import "./db/index.js"; // ensures schema is applied before routes handle traffic

const app = express();

app.use(cors({ origin: ORIGIN, credentials: true }));
app.use(express.json());
app.use(cookieParser());

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use("/register", registerRouter);
app.use("/auth", authRouter);
app.use("/stepup", stepupRouter);
app.use("/recovery", recoveryRouter);
app.use("/", sessionRouter);

// Last-resort error handler: never leak stack traces or internals to the
// client, and never let an unhandled exception surface a secret value.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "internal error" });
});

app.listen(PORT, () => {
  console.log(`MFA server listening on http://localhost:${PORT} (expects TLS-terminating proxy in production)`);
});
