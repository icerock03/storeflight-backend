// src/server.js
import express from "express";
import cors from "cors";
import pg from "pg";
import jwt from "jsonwebtoken";

const { Pool } = pg;
const app = express();

/** ENV */
const PORT = process.env.PORT || 10000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const DATABASE_URL = process.env.DATABASE_URL || "";

// Admin JWT
const JWT_SECRET = process.env.JWT_SECRET || "";
const ADMIN_USER = process.env.ADMIN_USER || "";
const ADMIN_PASS = process.env.ADMIN_PASS || "";

// PayPal (optionnel si tu utilises paiement côté front)
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || "";
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || "";
const PAYPAL_ENV = (process.env.PAYPAL_ENV || "sandbox").toLowerCase(); // sandbox | live
const PAYPAL_BASE =
  PAYPAL_ENV === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";

// Resend (optionnel)
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const EMAIL_FROM = process.env.EMAIL_FROM || "StoreFlight <onboarding@resend.dev>";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "thestoresarlau@gmail.com";

/** MIDDLEWARE */
app.use(
  cors({
    origin: CORS_ORIGIN === "*" ? true : CORS_ORIGIN,
    credentials: true,
  })
);
app.use(express.json({ limit: "1mb" }));

/** DB */
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL?.includes("localhost") ? false : { rejectUnauthorized: false },
});

async function initDB() {
  try {
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
        currency TEXT DEFAULT 'EUR',
        payment_method TEXT DEFAULT 'paypal',
        paypal_order_id TEXT,
        paypal_capture_id TEXT,
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log("✅ Database ready");
  } catch (err) {
    console.error("❌ initDB error:", err?.message || err);
  }
}
initDB();

/** HELPERS */
function pickString(v) {
  if (v === undefined || v === null) return "";
  return String(v).trim();
}
function isValidEmail(email) {
  if (!email) return true;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
function badRequest(res, message, extra = {}) {
  return res.status(400).json({ ok: false, error: message, ...extra });
}

/** HEALTH */
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, message: "StoreFlight API running ✈️" });
});

/** =======================
 *  ADMIN (JWT)
 *  ======================= */
function requireAuth(req, res, next) {
  try {
    if (!JWT_SECRET) return res.status(500).json({ ok: false, error: "JWT_SECRET_missing" });

    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!token) return res.status(401).json({ ok: false, error: "missing_token" });

    const decoded = jwt.verify(token, JWT_SECRET);
    req.admin = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: "invalid_token" });
  }
}

app.post("/api/admin/login", (req, res) => {
  if (!JWT_SECRET) return res.status(500).json({ ok: false, error: "JWT_SECRET_missing" });
  if (!ADMIN_USER || !ADMIN_PASS)
    return res.status(500).json({ ok: false, error: "ADMIN_USER_or_PASS_missing" });

  const user = pickString(req.body.user);
  const pass = pickString(req.body.pass);

  if (user !== ADMIN_USER || pass !== ADMIN_PASS) {
    return res.status(401).json({ ok: false, error: "invalid_credentials" });
  }

  const token = jwt.sign({ user }, JWT_SECRET, { expiresIn: "7d" });
  return res.json({ ok: true, token });
});

app.get("/api/admin/reservations", requireAuth, async (_req, res) => {
  try {
    const r = await pool.query("SELECT * FROM reservations ORDER BY id DESC;");
    return res.json({ ok: true, reservations: r.rows });
  } catch (err) {
    console.error("❌ GET /api/admin/reservations:", err?.message || err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

/** =======================
 *  RESERVATIONS PUBLIC
 *  ======================= */

// GET all reservations (je te conseille de supprimer en prod, ou de le protéger)
app.get("/api/reservations", async (_req, res) => {
  try {
    const r = await pool.query("SELECT * FROM reservations ORDER BY id DESC;");
    res.json(r.rows);
  } catch (err) {
    console.error("❌ GET /api/reservations error:", err?.message || err);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// CREATE reservation
app.post("/api/reservations", async (req, res) => {
  try {
    const full_name = pickString(req.body.full_name);
    const phone = pickString(req.body.phone);
    const email = pickString(req.body.email);
    const service_type = pickString(req.body.service_type);

    const from_city = pickString(req.body.from_city);
    const to_city = pickString(req.body.to_city);
    const check_in = req.body.check_in ? pickString(req.body.check_in) : null;
    const check_out = req.body.check_out ? pickString(req.body.check_out) : null;
    const travelers = Number(req.body.travelers || 1);
    const notes = pickString(req.body.notes);

    const deposit_amount = Number(req.body.deposit_amount || 15);
    const currency = pickString(req.body.currency || "EUR") || "EUR";
    const payment_method = pickString(req.body.payment_method || "paypal") || "paypal";

    const paypal_order_id = pickString(req.body.paypal_order_id);
    const paypal_capture_id = pickString(req.body.paypal_capture_id);

    if (!full_name) return badRequest(res, "full_name obligatoire");
    if (!phone) return badRequest(res, "phone obligatoire");
    if (!service_type) return badRequest(res, "service_type obligatoire");
    if (!isValidEmail(email)) return badRequest(res, "email invalide");

    const insert = await pool.query(
      `INSERT INTO reservations
        (full_name, phone, email, service_type, from_city, to_city, check_in, check_out, travelers, notes,
         deposit_amount, currency, payment_method, paypal_order_id, paypal_capture_id, status)
       VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING *;`,
      [
        full_name,
        phone,
        email || null,
        service_type,
        from_city || null,
        to_city || null,
        check_in,
        check_out,
        Number.isFinite(travelers) ? travelers : 1,
        notes || null,
        Number.isFinite(deposit_amount) ? deposit_amount : 15,
        currency,
        payment_method,
        paypal_order_id || null,
        paypal_capture_id || null,
        paypal_capture_id ? "paid" : "pending",
      ]
    );

    const reservation = insert.rows[0];

    // Email optionnel
    if (RESEND_API_KEY) {
      try {
        await sendEmailResend({
          to: ADMIN_EMAIL,
          subject: `🧾 Nouvelle réservation #${reservation.id} - ${service_type}`,
          html: renderAdminEmail(reservation),
        });

        if (email) {
          await sendEmailResend({
            to: email,
            subject: `✅ Réservation confirmée - StoreFlight (#${reservation.id})`,
            html: renderClientEmail(reservation),
          });
        }
      } catch (e) {
        console.error("⚠️ Email warning:", e?.message || e);
      }
    }

    return res.status(201).json({ ok: true, reservation });
  } catch (err) {
    console.error("❌ POST /api/reservations error:", err?.message || err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

/** =======================
 *  PAYPAL (optionnel)
 *  ======================= */
async function getPayPalAccessToken() {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
    throw new Error("PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET manquants");
  }

  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString("base64");

  const r = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  const data = await r.json();
  if (!r.ok) throw new Error(`PayPal token error: ${r.status} ${JSON.stringify(data)}`);
  return data.access_token;
}

app.post("/api/paypal/create-order", async (req, res) => {
  try {
    const amount = pickString(req.body.amount || "15.00");
    const currency = pickString(req.body.currency || "EUR");
    const token = await getPayPalAccessToken();

    const r = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [{ amount: { currency_code: currency, value: amount } }],
      }),
    });

    const data = await r.json();
    if (!r.ok) return res.status(400).json({ ok: false, error: "paypal_create_failed", details: data });

    return res.json({ ok: true, order: data });
  } catch (err) {
    console.error("❌ /api/paypal/create-order:", err?.message || err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

/** =======================
 *  RESEND
 *  ======================= */
async function sendEmailResend({ to, subject, html }) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: EMAIL_FROM, to: [to], subject, html }),
  });

  const data = await r.json();
  if (!r.ok) throw new Error(`Resend error: ${r.status} ${JSON.stringify(data)}`);
  return data;
}

function renderClientEmail(res) {
  return `
    <div style="font-family:Arial,sans-serif;line-height:1.5">
      <h2>✅ Réservation confirmée</h2>
      <p>Bonjour <b>${res.full_name}</b>,</p>
      <p>Référence : <b>#${res.id}</b></p>
      <p>Service : <b>${res.service_type}</b></p>
      <p>Montant : <b>${res.deposit_amount} ${res.currency}</b></p>
      <hr/>
      <p>📞 WhatsApp: 00212627201720 / 00221762383780</p>
    </div>
  `;
}

function renderAdminEmail(res) {
  return `
    <div style="font-family:Arial,sans-serif;line-height:1.5">
      <h2>🧾 Nouvelle réservation #${res.id}</h2>
      <p><b>Nom :</b> ${res.full_name}</p>
      <p><b>Téléphone :</b> ${res.phone}</p>
      <p><b>Email :</b> ${res.email || "-"}</p>
      <p><b>Service :</b> ${res.service_type}</p>
      <p><b>Status :</b> ${res.status}</p>
      <p><b>Order :</b> ${res.paypal_order_id || "-"}</p>
      <p><b>Capture :</b> ${res.paypal_capture_id || "-"}</p>
    </div>
  `;
}

/** 404 */
app.use((req, res) => {
  res.status(404).json({ ok: false, error: "not_found", path: req.path });
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
