// src/server.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const { Pool } = require("pg");

const app = express();

/* =========================
   CONFIG
========================= */
const PORT = process.env.PORT || 10000;

const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

app.use(
  cors({
    origin: CORS_ORIGIN === "*" ? true : CORS_ORIGIN,
    credentials: true,
  })
);

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

/* =========================
   DB (PostgreSQL)
========================= */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.DATABASE_URL && process.env.DATABASE_URL.includes("render.com")
      ? { rejectUnauthorized: false }
      : false,
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reservations (
      id SERIAL PRIMARY KEY,
      full_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT,
      service_type TEXT NOT NULL,
      from_city TEXT,
      to_city TEXT,
      check_in DATE,
      check_out DATE,
      travelers INT DEFAULT 1,
      notes TEXT,
      deposit_amount NUMERIC(10,2) DEFAULT 15,
      status TEXT DEFAULT 'pending',
      payment_method TEXT DEFAULT 'paypal',
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  console.log("Database ready ✅");
}
initDB().catch((err) => console.error("DB init error:", err));

/* =========================
   STATIC WEBSITE (HTML)
   - Tes fichiers sont à la racine du repo : index.html, services.html, etc.
   - Ton dossier assets/ est aussi à la racine.
   Render lance: node src/server.js
   Donc ici on remonte d’un dossier: ../
========================= */
const ROOT_DIR = path.join(__dirname, "..");
app.use(express.static(ROOT_DIR)); // sert index.html, services.html, assets/ etc.

app.get("/", (req, res) => {
  // Si index.html existe à la racine, il sera servi
  res.sendFile(path.join(ROOT_DIR, "index.html"));
});

/* =========================
   HEALTH CHECK
========================= */
app.get("/api/health", (req, res) => {
  res.json({ ok: true, message: "StoreFlight API running ✈️" });
});

/* =========================
   RESERVATIONS API
========================= */

// GET all reservations
app.get("/api/reservations", async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM reservations ORDER BY id DESC");
    res.json(r.rows);
  } catch (err) {
    console.error("GET /api/reservations error:", err);
    res.status(500).json({ error: "server_error" });
  }
});

// POST create reservation
app.post("/api/reservations", async (req, res) => {
  try {
    const {
      full_name,
      phone,
      email,
      service_type,
      from_city,
      to_city,
      check_in,
      check_out,
      travelers = 1,
      notes,
      deposit_amount = 15,
      status = "pending",
      payment_method = "paypal",
    } = req.body;

    if (!full_name || !phone || !service_type) {
      return res.status(400).json({ error: "missing_required_fields" });
    }

    const q = `
      INSERT INTO reservations
      (full_name, phone, email, service_type, from_city, to_city, check_in, check_out, travelers, notes, deposit_amount, status, payment_method)
      VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING *;
    `;

    const values = [
      full_name,
      phone,
      email || null,
      service_type,
      from_city || null,
      to_city || null,
      check_in || null,
      check_out || null,
      travelers,
      notes || null,
      deposit_amount,
      status,
      payment_method,
    ];

    const r = await pool.query(q, values);
    res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error("POST /api/reservations error:", err);
    res.status(500).json({ error: "server_error" });
  }
});

// GET reservation by id
app.get("/api/reservations/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const r = await pool.query("SELECT * FROM reservations WHERE id=$1", [id]);
    if (r.rows.length === 0) return res.status(404).json({ error: "not_found" });
    res.json(r.rows[0]);
  } catch (err) {
    console.error("GET /api/reservations/:id error:", err);
    res.status(500).json({ error: "server_error" });
  }
});

/* =========================
   PAYPAL
========================= */
const PAYPAL_ENV = (process.env.PAYPAL_ENV || "sandbox").toLowerCase().trim();
const PAYPAL_BASE =
  PAYPAL_ENV === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";

function mustHavePayPalEnv() {
  if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) {
    throw new Error("Missing PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET in env");
  }
}

// ✅ TOKEN PAYPAL (corrigé, pas de r undefined)
async function getPayPalToken() {
  mustHavePayPalEnv();

  const auth = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
  ).toString("base64");

  const r = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  const data = await r.json();

  if (!r.ok) {
    console.error("PayPal token error:", data);
    throw new Error(data?.error_description || "paypal_token_error");
  }

  return data.access_token;
}

/**
 * POST /api/paypal/create-order
 * Body: { "amount": "15.00", "currency": "USD" }
 */
app.post("/api/paypal/create-order", async (req, res) => {
  try {
    const { amount = "15.00", currency = "USD" } = req.body || {};
    const token = await getPayPalToken();

    const orderBody = {
      intent: "CAPTURE",
      purchase_units: [
        {
          amount: {
            currency_code: currency,
            value: String(amount),
          },
        },
      ],
      application_context: {
        brand_name: "The Store Flight",
        landing_page: "NO_PREFERENCE",
        user_action: "PAY_NOW",
      },
    };

    const r = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(orderBody),
    });

    const data = await r.json();

    if (!r.ok) {
      console.error("PayPal create-order error:", data);
      return res.status(500).json({ error: "paypal_create_order_failed", details: data });
    }

    // lien d'approbation
    const approveLink = Array.isArray(data.links)
      ? data.links.find((l) => l.rel === "approve")?.href
      : null;

    res.json({
      id: data.id,
      status: data.status,
      approveLink,
      raw: data,
    });
  } catch (err) {
    console.error("POST /api/paypal/create-order error:", err);
    res.status(500).json({ error: "server_error", message: err.message });
  }
});

/**
 * POST /api/paypal/capture-order
 * Body: { "orderID": "XXXX" }
 */
app.post("/api/paypal/capture-order", async (req, res) => {
  try {
    const { orderID } = req.body || {};
    if (!orderID) return res.status(400).json({ error: "missing_orderID" });

    const token = await getPayPalToken();

    const r = await fetch(`${PAYPAL_BASE}/v2/checkout/orders/${orderID}/capture`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    const data = await r.json();

    if (!r.ok) {
      console.error("PayPal capture error:", data);
      return res.status(500).json({ error: "paypal_capture_failed", details: data });
    }

    res.json(data);
  } catch (err) {
    console.error("POST /api/paypal/capture-order error:", err);
    res.status(500).json({ error: "server_error", message: err.message });
  }
});

/* =========================
   404 API
========================= */
app.use("/api", (req, res) => {
  res.status(404).json({ error: "not_found" });
});

/* =========================
   START
========================= */
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`PayPal mode: ${PAYPAL_ENV} | Base: ${PAYPAL_BASE}`);
});
