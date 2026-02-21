import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import pkg from "pg";

dotenv.config();
const { Pool } = pkg;

const app = express();
app.use(cors());
app.use(express.json());

/* =========================
   DATABASE
========================= */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
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

initDB();

/* =========================
   HEALTH CHECK
========================= */
app.get("/api/health", (req, res) => {
  res.json({ ok: true, message: "StoreFlight API running ✈️" });
});

/* =========================
   PAYPAL CONFIG
========================= */
const PAYPAL_BASE =
  process.env.PAYPAL_ENV === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";

/* =========================
   GET ACCESS TOKEN
========================= */
async function getPayPalToken() {
  const auth = Buffer.from(
    process.env.PAYPAL_CLIENT_ID +
      ":" +
      process.env.PAYPAL_CLIENT_SECRET
  ).toString("base64");

  const r = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });

  const data = await r.json();

  if (!data.access_token) {
    console.error("PAYPAL TOKEN ERROR:", data);
    throw new Error("PayPal auth failed");
  }

  return data.access_token;
}

/* =========================
   CREATE ORDER
========================= */
app.post("/api/paypal/create-order", async (req, res) => {
  try {
    const { amount, currency } = req.body;

    const token = await getPayPalToken();

    const r = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [
          {
            amount: {
              currency_code: currency || "USD",
              value: amount || "15.00"
            }
          }
        ]
      })
    });

    const data = await r.json();
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "paypal create order failed" });
  }
});

/* =========================
   CAPTURE ORDER
========================= */
app.post("/api/paypal/capture-order", async (req, res) => {
  try {
    const { orderID } = req.body;

    const token = await getPayPalToken();

    const r = await fetch(
      `${PAYPAL_BASE}/v2/checkout/orders/${orderID}/capture`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    );

    const data = await r.json();
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "paypal capture failed" });
  }
});

/* =========================
   SAVE RESERVATION
========================= */
app.post("/api/reservation", async (req, res) => {
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
      travelers,
      notes
    } = req.body;

    const result = await pool.query(
      `
      INSERT INTO reservations
      (full_name, phone, email, service_type, from_city, to_city, check_in, check_out, travelers, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING *
      `,
      [
        full_name,
        phone,
        email,
        service_type,
        from_city,
        to_city,
        check_in,
        check_out,
        travelers,
        notes
      ]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "reservation failed" });
  }
});

/* =========================
   LIST RESERVATIONS
========================= */
app.get("/api/reservations", async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM reservations ORDER BY id DESC"
  );
  res.json(result.rows);
});

/* =========================
   SERVER START
========================= */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log("Server running on port " + PORT)
);
