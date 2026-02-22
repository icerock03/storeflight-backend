import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import pg from "pg";
import { Resend } from "resend";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

/* ================= DB ================= */
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

await pool.query(`
CREATE TABLE IF NOT EXISTS reservations(
id SERIAL PRIMARY KEY,
full_name TEXT,
phone TEXT,
email TEXT,
service_type TEXT,
from_city TEXT,
to_city TEXT,
check_in TEXT,
check_out TEXT,
travelers INT,
notes TEXT,
payment_status TEXT,
created_at TIMESTAMP DEFAULT NOW()
);
`);

console.log("DB ready");

/* ================= HEALTH ================= */
app.get("/api/health", (req, res) => {
  res.json({ ok: true, message: "StoreFlight API running ✈️" });
});

/* ================= PAYPAL ================= */
const PAYPAL_BASE = "https://api-m.paypal.com";

async function getToken() {
  const auth = Buffer.from(
    process.env.PAYPAL_CLIENT_ID +
    ":" +
    process.env.PAYPAL_CLIENT_SECRET
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
  return data.access_token;
}

app.post("/api/paypal/create-order", async (req, res) => {
  try {
    const token = await getToken();

    const r = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [
          {
            amount: { currency_code: "EUR", value: "15.00" },
          },
        ],
      }),
    });

    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "paypal create error" });
  }
});

app.post("/api/paypal/capture-order", async (req, res) => {
  try {
    const token = await getToken();

    const r = await fetch(
      `${PAYPAL_BASE}/v2/checkout/orders/${req.body.orderID}/capture`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    const data = await r.json();
    res.json(data);
  } catch {
    res.status(500).json({ error: "capture error" });
  }
});

/* ================= EMAIL ================= */
const resend = new Resend(process.env.RESEND_API_KEY);

async function sendEmails(reservation) {
  const htmlClient = `
  <h2>Merci pour votre demande ✈️</h2>
  <p>Bonjour ${reservation.full_name},</p>
  <p>Nous avons bien reçu votre demande de <b>${reservation.service_type}</b>.</p>
  <p>Notre équipe vous contactera bientôt.</p>
  <hr>
  <p>The Store Flight</p>
  `;

  const htmlAdmin = `
  <h2>Nouvelle réservation</h2>
  <p><b>Nom:</b> ${reservation.full_name}</p>
  <p><b>Téléphone:</b> ${reservation.phone}</p>
  <p><b>Service:</b> ${reservation.service_type}</p>
  <p><b>Trajet:</b> ${reservation.from_city} → ${reservation.to_city}</p>
  <p><b>Dates:</b> ${reservation.check_in} / ${reservation.check_out}</p>
  <p><b>Voyageurs:</b> ${reservation.travelers}</p>
  <p><b>Notes:</b> ${reservation.notes}</p>
  `;

  await resend.emails.send({
    from: "The Store Flight <onboarding@resend.dev>",
    to: reservation.email,
    subject: "Confirmation de demande",
    html: htmlClient,
  });

  await resend.emails.send({
    from: "StoreFlight <onboarding@resend.dev>",
    to: process.env.ADMIN_EMAIL,
    subject: "Nouvelle réservation",
    html: htmlAdmin,
  });
}

/* ================= RESERVATION ================= */
app.post("/api/reservations", async (req, res) => {
  try {
    const data = req.body;

    const q = await pool.query(
      `INSERT INTO reservations
      (full_name,phone,email,service_type,from_city,to_city,check_in,check_out,travelers,notes,payment_status)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *`,
      [
        data.full_name,
        data.phone,
        data.email,
        data.service_type,
        data.from_city,
        data.to_city,
        data.check_in,
        data.check_out,
        data.travelers,
        data.notes,
        "paid",
      ]
    );

    await sendEmails(q.rows[0]);

    res.json(q.rows[0]);
  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "reservation error" });
  }
});

/* ================= LIST ================= */
app.get("/api/reservations", async (req, res) => {
  const r = await pool.query(
    "SELECT * FROM reservations ORDER BY id DESC"
  );
  res.json(r.rows);
});

/* ================= START ================= */
app.listen(PORT, () => console.log("SERVER LIVE 🚀"));
