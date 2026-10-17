import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import express from "express";
import helmet from "helmet";
import { registerApiRoutes } from "./cindrela/server/src/controllers/apiController.js";
import { adminLimiter, apiLimiter, authLimiter, paymentLimiter } from "./cindrela/server/src/config/security.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
const schema = `
  CREATE TABLE IF NOT EXISTS orders (
    order_id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    request_hash TEXT NOT NULL,
    customer_name TEXT NOT NULL,
    customer_email TEXT NOT NULL,
    customer_phone TEXT NOT NULL,
    address_line_1 TEXT NOT NULL,
    address_line_2 TEXT NOT NULL,
    city TEXT NOT NULL,
    state TEXT NOT NULL,
    pincode TEXT NOT NULL,
    total INTEGER NOT NULL CHECK (total > 0),
    payment_method TEXT NOT NULL CHECK (payment_method = 'cod'),
    payment_status TEXT NOT NULL DEFAULT 'pending_collection',
    order_status TEXT NOT NULL DEFAULT 'confirmed',
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS order_items (
    order_id TEXT NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL,
    product_name TEXT NOT NULL,
    size TEXT NOT NULL,
    unit_price INTEGER NOT NULL CHECK (unit_price > 0),
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    PRIMARY KEY (order_id, product_id, size)
  );
  CREATE INDEX IF NOT EXISTS orders_created_at_idx ON orders(created_at);
`;

export function createApp({ dbPath = process.env.DB_PATH } = {}) {
  const defaultDataDir = process.env.FASHIONHUB_DATA_DIR ||
    (process.platform === "win32"
      ? path.join(process.env.LOCALAPPDATA || homedir(), "FashionHub")
      : path.join(process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share"), "fashionhub"));
  const resolvedDbPath = path.resolve(dbPath || path.join(defaultDataDir, "fashionhub.sqlite"));
  mkdirSync(path.dirname(resolvedDbPath), { recursive: true });
  const db = new DatabaseSync(resolvedDbPath);
  const uploadDirectory = path.join(path.dirname(resolvedDbPath), "uploads");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(schema);

  const app = express();
  app.disable("x-powered-by");
  if (process.env.TRUST_PROXY === "true") app.set("trust proxy", 1);
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
        imgSrc: ["'self'", "data:", "https://images.unsplash.com", "https://placehold.co"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"]
      }
    }
  }));
  app.use("/api", apiLimiter);
  app.use("/api/auth", authLimiter);
  app.use("/api/admin", adminLimiter);
  app.use("/api", (request, response, next) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
      const origin = request.get("Origin");
      if (origin && origin !== `${request.protocol}://${request.get("host")}`) {
        return response.status(403).json({ error: "Cross-origin requests are not allowed." });
      }
    }
    next();
  });
  app.use(express.json({ limit: "32kb", strict: true }));

  app.get("/", (_request, response) => response.sendFile(path.join(directory, "index.html")));
  registerApiRoutes(app, db, { paymentLimiter, uploadDirectory });
  app.use("/uploads", express.static(uploadDirectory, {
    dotfiles: "deny",
    fallthrough: false,
    index: false,
    maxAge: process.env.NODE_ENV === "production" ? "1y" : 0,
    immutable: process.env.NODE_ENV === "production",
    setHeaders(response) {
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      response.setHeader("Content-Disposition", "inline");
    }
  }));
  app.use((error, _request, response, _next) => {
    if (error.type === "entity.too.large") {
      return response.status(413).json({ error: "JSON request bodies are limited to 32 KiB." });
    }
    if (error instanceof SyntaxError && error.status === 400 && "body" in error) {
      return response.status(400).json({ error: "Invalid JSON request." });
    }
    console.error("FashionHub request failed:", error.message);
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 500
      ? error.status
      : 500;
    response.status(status).json({
      error: status === 400 ? "Invalid JSON request." : "The request could not be completed."
    });
  });
  return { app, db };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { app, db } = createApp();
  const port = Number(process.env.PORT || 3000);
  const server = app.listen(port, () => console.log(`FashionHub running at http://localhost:${port}`));
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => server.close(() => {
      db.close();
      process.exit(0);
    }));
  }
}
