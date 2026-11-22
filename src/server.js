import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { checkDatabaseConnection, pool } from "./config/db.js";
import authRoutes from "./routes/auth.routes.js";
import adminRoutes from "./routes/admin.routes.js";
import supplierRoutes from "./routes/supplier.routes.js";
import reportRoutes from "./routes/report.routes.js";
import deliveryRoutes from "./routes/delivery.routes.js";
import paymentsRoutes from "./routes/payments.routes.js";
import mpesaRoutes from "./routes/mpesa.routes.js";
import { errorHandler } from "./middleware/errorHandler.js";

const app = express();

const allowedOrigins = (process.env.CLIENT_ORIGIN || "http://localhost:3000")
  .split(",")
  .map((origin) => origin.trim());

app.use(helmet());

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests without an Origin header, such as server-to-server requests
      // (this is also how Safaricom's M-Pesa callbacks arrive).
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error("Not allowed by CORS"));
    },
  }),
);

app.use(express.json({ limit: "1mb" }));

// The M-Pesa callback URLs contain a secret, so hide it in the request log.
morgan.token("safe-url", (req) =>
  req.originalUrl.replace(
    /(\/api\/mpesa\/b2c\/(?:result|timeout)\/)[^/?]+/,
    "$1***",
  ),
);
app.use(
  morgan(":method :safe-url :status :response-time ms - :res[content-length]"),
);

app.get("/health", async (req, res) => {
  res.json({ status: "ok", service: "superleo-api" });
});
app.use("/api/auth", authRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/suppliers", supplierRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/deliveries", deliveryRoutes);
app.use("/api/payments", paymentsRoutes); // managers / admins only (auth is inside the router)
app.use("/api/mpesa", mpesaRoutes); // public: called by Safaricom, protected by the URL secret
app.use(errorHandler);

const port = Number(process.env.PORT || 4000);
const server = app.listen(port, async () => {
  console.log(`[SuperLeo API] listening on http://localhost:${port}`);
  if (!process.env.DATABASE_URL) {
    console.error("[SuperLeo DB] ERROR: DATABASE_URL is not configured");
    return;
  }
  try {
    await checkDatabaseConnection();
    console.log("[SuperLeo DB] connected successfully");
  } catch (error) {
    console.error("[SuperLeo DB] connection failed:", error.message);
  }
  if (process.env.MPESA_ENABLED === "true") {
    const missing = [
      "MPESA_CONSUMER_KEY",
      "MPESA_CONSUMER_SECRET",
      "MPESA_SHORTCODE",
      "MPESA_INITIATOR_NAME",
      "MPESA_CALLBACK_BASE_URL",
      "MPESA_CALLBACK_SECRET",
    ].filter((name) => !process.env[name]);
    if (!process.env.MPESA_SECURITY_CREDENTIAL)
      for (const name of ["MPESA_INITIATOR_PASSWORD", "MPESA_CERT_PATH"])
        if (!process.env[name]) missing.push(name);
    if ((process.env.MPESA_CALLBACK_SECRET || "").length < 16)
      missing.push("MPESA_CALLBACK_SECRET (needs 16+ characters)");
    console.log(
      missing.length
        ? `[SuperLeo M-Pesa] enabled, but missing: ${missing.join(", ")}`
        : `[SuperLeo M-Pesa] payouts enabled (${process.env.MPESA_ENV || "sandbox"})`,
    );
  } else {
    console.log(
      "[SuperLeo M-Pesa] payouts are off (set MPESA_ENABLED=true to turn on)",
    );
  }
});

async function shutdown(signal) {
  console.log(`[SuperLeo API] ${signal} received`);
  await pool.end();
  server.close(() => process.exit(0));
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
