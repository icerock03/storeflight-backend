import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import pg from "pg";
import { Resend } from "resend";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 10000;

/* ================= DB ================= */
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reservations(
      id SERIAL PRIMARY KEY,
      full_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT,
      service_type TEXT NOT NULL,
      from_city TEXT,
      to_city TEXT,
      check_in TEXT,
      check_out TEXT,
      travelers INT DEFAULT 1,
      notes TEXT,
      payment_status TEXT DEFAULT 'paid',
      paypal_order_id TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log("DB ready ✅");
}

/* ================= HEALTH ================= */
app.get("/api/health", (req, res) => {
  res.json({ ok: true, message: "StoreFlight API running ✈️" });
});

/* ================= PAYPAL ================= */
const PAYPAL_ENV = (process.env.PAYPAL_ENV || "live").toLowerCase();
const PAYPAL_BASE =
  PAYPAL_ENV === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";

async function getPayPalToken() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;

  if (!clientId || !secret) throw new Error("Missing PayPal env vars");

  const auth = Buffer.from(`${clientId}:${secret}`).toString("base64");

  const r = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  const data = await r.json();
  if (!r.ok) throw new Error(data?.error_description || "PayPal token failed");
  return data.access_token;
}

app.post("/api/paypal/create-order", async (req, res) => {
  try {
    const token = await getPayPalToken();

    const r = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [{ amount: { currency_code: "EUR", value: "15.00" } }],
      }),
    });

    const data = await r.json();
    return res.status(r.status).json(data);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "paypal_create_order_failed" });
  }
});

app.post("/api/paypal/capture-order", async (req, res) => {
  try {
    const { orderID } = req.body || {};
    if (!orderID) return res.status(400).json({ error: "missing_orderID" });

    const token = await getPayPalToken();

    const r = await fetch(
      `${PAYPAL_BASE}/v2/checkout/orders/${orderID}/capture`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    const data = await r.json();
    return res.status(r.status).json(data);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "paypal_capture_failed" });
  }
});

/* ================= EMAIL (Resend) =================
   IMPORTANT:
   - Tu ne peux PAS envoyer depuis thestoresarlau@gmail.com via Resend.
   - Resend exige un domaine vérifié.
   - Pour l’instant on utilise onboarding@resend.dev (ok pour démarrer).
==================================================== */
const resend = new Resend(process.env.RESEND_API_KEY);
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "thestoresarlau@gmail.com";

async function sendEmails({ clientEmail, full_name, service_type, phone }) {
  // Email client (si email fourni)
  if (clientEmail) {
    await resend.emails.send({
      from: "The Store Flight <onboarding@resend.dev>",
      to: clientEmail,
      subject: "Confirmation - The Store Flight",
      html: `
        <h2>Merci pour votre demande ✈️</h2>
        <p>Bonjour <b>${full_name}</b>,</p>
        <p>Nous avons bien reçu votre demande : <b>${service_type}</b>.</p>
        <p>Nous vous contacterons rapidement sur WhatsApp/Téléphone : <b>${phone}</b>.</p>
        <p>— The Store Flight</p>
      `,
    });
  }

  // Email admin (toujours)
  await resend.emails.send({
    from: "The Store Flight <onboarding@resend.dev>",
    to: ADMIN_EMAIL,
    subject: "Nouvelle demande payée (15€)",
    html: `
      <h2>Nouvelle demande</h2>
      <p><b>Nom:</b> ${full_name}</p>
      <p><b>Téléphone:</b> ${phone}</p>
      <p><b>Email client:</b> ${clientEmail || "-"}</p>
      <p><b>Service:</b> ${service_type}</p>
    `,
  });
}

/* ================= RESERVATIONS ================= */
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
      notes = "",
      paypal_order_id = "",
    } = req.body || {};

    if (!full_name || !phone || !service_type) {
      return res.status(400).json({ error: "missing_required_fields" });
    }

    const q = await pool.query(
      `
      INSERT INTO reservations
      (full_name, phone, email, service_type, from_city, to_city, check_in, check_out, travelers, notes, paypal_order_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *;
      `,
      [
        full_name,
        phone,
        email || null,
        service_type,
        from_city || null,
        to_city || null,
        check_in || null,
        check_out || null,
        Number(travelers) || 1,
        notes,
        paypal_order_id,
      ]
    );

    // emails
    await sendEmails({
      clientEmail: email || "",
      full_name,
      service_type,
      phone,
    });

    return res.status(201).json(q.rows[0]);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "reservation_create_failed" });
  }
});

app.get("/api/reservations", async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM reservations ORDER BY id DESC LIMIT 200");
    return res.json(r.rows);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "reservations_list_failed" });
  }
});

/* ================= START ================= */
initDB()
  .then(() => {
    app.listen(PORT, () => console.log("SERVER LIVE 🚀", PORT));
  })
  .catch((e) => {
    console.error("Startup failed:", e);
    process.exit(1);
  });
