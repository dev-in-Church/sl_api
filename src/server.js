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
import { errorHandler } from "./middleware/errorHandler.js";

const app = express();

const allowedOrigins = (process.env.CLIENT_ORIGIN || "http://localhost:3000")
  .split(",")
  .map((origin) => origin.trim());

app.use(helmet());

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests without an Origin header, such as server-to-server requests.
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error("Not allowed by CORS"));
    },
  }),
);

app.use(express.json({ limit: "1mb" }));
app.use(morgan("dev"));

app.get("/health", async (req, res) => {
  res.json({ status: "ok", service: "superleo-api" });
});
app.use("/api/auth", authRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/suppliers", supplierRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/deliveries", deliveryRoutes);
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
});

async function shutdown(signal) {
  console.log(`[SuperLeo API] ${signal} received`);
  await pool.end();
  server.close(() => process.exit(0));
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
