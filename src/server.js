require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

// CORS (si tu as un front Pages / Netlify)
const corsOrigin = process.env.CORS_ORIGIN || "*";
app.use(
  cors({
    origin: corsOrigin === "*" ? true : corsOrigin,
    credentials: true,
  })
);

// DB (optionnel — si DATABASE_URL existe)
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
  : null;

// PayPal base URL
const PAYPAL_ENV = (process.env.PAYPAL_ENV || "sandbox").toLowerCase();
const PAYPAL_BASE =
  PAYPAL_ENV === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

async function getPayPalToken() {
  const clientId = mustEnv("PAYPAL_CLIENT_ID");
  const secret = mustEnv("PAYPAL_CLIENT_SECRET");

  const basic = Buffer.from(`${clientId}:${secret}`).toString("base64");

  const body = new URLSearchParams();
  body.append("grant_type", "client_credentials");

  const r = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const data = await r.json();
  if (!r.ok) {
    console.error("PayPal token error:", data);
    throw new Error(data?.error_description || "PayPal token failed");
  }

  return data.access_token;
}

// ✅ HEALTH
app.get("/api/health", (req, res) => {
  res.json({ ok: true, message: "StoreFlight API running ✈️" });
});

// ✅ TEST DB (optionnel)
app.get("/api/db-check", async (req, res) => {
  try {
    if (!pool) return res.status(400).json({ ok: false, message: "No DATABASE_URL set" });
    const r = await pool.query("SELECT NOW() as now");
    res.json({ ok: true, now: r.rows[0].now });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "db error" });
  }
});

// ✅ CREATE ORDER (retourne un vrai ID)
app.post("/api/paypal/create-order", async (req, res) => {
  try {
    const { amount, currency } = req.body;

    if (!amount) {
      return res.status(400).json({ error: "amount is required" });
    }

    const token = await getPayPalToken();

    const r = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [
          {
            amount: {
              currency_code: currency || "USD",
              value: String(amount),
            },
          },
        ],
      }),
    });

    const data = await r.json();

    if (!r.ok) {
      console.error("Create order error:", data);
      return res.status(500).json({ error: "paypal_create_order_failed", details: data });
    }

    // ✅ IMPORTANT : renvoyer l'order id
    res.json({
      id: data.id,
      status: data.status,
      links: data.links,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "create order failed" });
  }
});

// ✅ CAPTURE ORDER
app.post("/api/paypal/capture-order", async (req, res) => {
  try {
    const { orderID } = req.body;
    if (!orderID) {
      return res.status(400).json({ error: "orderID is required" });
    }

    const token = await getPayPalToken();

    const r = await fetch(`${PAYPAL_BASE}/v2/checkout/orders/${orderID}/capture`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    });

    const data = await r.json();

    if (!r.ok) {
      console.error("Capture error:", data);
      return res.status(500).json({ error: "paypal_capture_failed", details: data });
    }

    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "capture order failed" });
  }
});

// Render port
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Server running on port", PORT));
