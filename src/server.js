// src/server.js
import express from "express";
import cors from "cors";
import pg from "pg";

const { Pool } = pg;

const app = express();

/** =======================
 *  ENV
 *  ======================= */
const PORT = process.env.PORT || 10000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const ADMIN_KEY = process.env.ADMIN_KEY || ""; // <-- set in Render

const DATABASE_URL = process.env.DATABASE_URL;

// PayPal
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || "";
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || "";
const PAYPAL_ENV = (process.env.PAYPAL_ENV || "sandbox").toLowerCase(); // sandbox | live
const PAYPAL_BASE =
  PAYPAL_ENV === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";

// Resend
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const EMAIL_FROM = process.env.EMAIL_FROM || "StoreFlight <onboarding@resend.dev>";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "thestoresarlau@gmail.com";

/** =======================
 *  MIDDLEWARE
 *  ======================= */
app.use(
  cors({
    origin: CORS_ORIGIN === "*" ? true : CORS_ORIGIN,
    credentials: true,
  })
);
app.use(express.json({ limit: "1mb" }));

/** =======================
 *  DB (PostgreSQL)
 *  ======================= */
if (!DATABASE_URL) console.error("❌ DATABASE_URL manquant dans les variables Render.");

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
        paypal_order_id TEXT,
        paypal_capture_id TEXT,
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Safe migrations (if table exists already)
    await pool.query(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS deposit_amount NUMERIC(10,2) DEFAULT 15;`);
    await pool.query(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'EUR';`);
    await pool.query(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS paypal_order_id TEXT;`);
    await pool.query(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS paypal_capture_id TEXT;`);
    await pool.query(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending';`);
    await pool.query(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();`);

    console.log("✅ Database ready");
  } catch (err) {
    console.error("❌ initDB error:", err?.message || err);
  }
}
initDB();

/** =======================
 *  HELPERS
 *  ======================= */
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

function requireAdminKey(req) {
  const key = pickString(req.query.key || req.headers["x-admin-key"]);
  return ADMIN_KEY && key === ADMIN_KEY;
}

/** =======================
 *  HEALTH
 *  ======================= */
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, message: "StoreFlight API running ✈️" });
});

/** =======================
 *  RESERVATIONS
 *  ======================= */

// GET all reservations (public list: OK for now, but admin endpoint is better)
app.get("/api/reservations", async (_req, res) => {
  try {
    const r = await pool.query("SELECT * FROM reservations ORDER BY id DESC;");
    res.json(r.rows);
  } catch (err) {
    console.error("❌ GET /api/reservations error:", err?.message || err);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ✅ ADMIN: list reservations (secure with key)
app.get("/api/admin/reservations", async (req, res) => {
  try {
    if (!ADMIN_KEY) return res.status(500).json({ ok: false, error: "ADMIN_KEY_missing" });
    if (!requireAdminKey(req)) return res.status(401).json({ ok: false, error: "unauthorized" });

    const r = await pool.query("SELECT * FROM reservations ORDER BY id DESC;");
    res.json({ ok: true, reservations: r.rows });
  } catch (err) {
    console.error("❌ GET /api/admin/reservations error:", err?.message || err);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ✅ STEP 1: create reservation as PENDING (before PayPal)
app.post("/api/reservations/create", async (req, res) => {
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

    if (!full_name) return badRequest(res, "full_name obligatoire");
    if (!phone) return badRequest(res, "phone obligatoire");
    if (!service_type) return badRequest(res, "service_type obligatoire");
    if (!isValidEmail(email)) return badRequest(res, "email invalide");

    const insert = await pool.query(
      `INSERT INTO reservations
        (full_name, phone, email, service_type, from_city, to_city, check_in, check_out, travelers, notes,
         deposit_amount, currency, status)
       VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending')
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
      ]
    );

    return res.status(201).json({ ok: true, reservation: insert.rows[0] });
  } catch (err) {
    console.error("❌ POST /api/reservations/create error:", err?.message || err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ✅ STEP 2: finalize reservation after PayPal capture (paid + emails)
app.post("/api/reservations/finalize", async (req, res) => {
  try {
    const reservation_id = Number(req.body.reservation_id);
    const paypal_order_id = pickString(req.body.paypal_order_id);
    const paypal_capture_id = pickString(req.body.paypal_capture_id);

    if (!Number.isFinite(reservation_id)) return badRequest(res, "reservation_id obligatoire");
    if (!paypal_order_id) return badRequest(res, "paypal_order_id obligatoire");
    if (!paypal_capture_id) return badRequest(res, "paypal_capture_id obligatoire");

    const upd = await pool.query(
      `UPDATE reservations
       SET paypal_order_id=$1, paypal_capture_id=$2, status='paid'
       WHERE id=$3
       RETURNING *;`,
      [paypal_order_id, paypal_capture_id, reservation_id]
    );

    const reservation = upd.rows[0];
    if (!reservation) return res.status(404).json({ ok: false, error: "reservation_not_found" });

    // Send emails (non-blocking)
    if (RESEND_API_KEY) {
      try {
        await sendEmailResend({
          to: ADMIN_EMAIL,
          subject: `🧾 Paiement reçu #${reservation.id} - ${reservation.service_type}`,
          html: renderAdminEmail(reservation),
        });

        if (reservation.email) {
          await sendEmailResend({
            to: reservation.email,
            subject: `✅ Paiement confirmé - StoreFlight (#${reservation.id})`,
            html: renderClientEmail(reservation),
          });
        }
      } catch (e) {
        console.error("⚠️ Email warning:", e?.message || e);
      }
    }

    return res.json({ ok: true, reservation });
  } catch (err) {
    console.error("❌ POST /api/reservations/finalize error:", err?.message || err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

/** =======================
 *  PAYPAL
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

// Create order
app.post("/api/paypal/create-order", async (req, res) => {
  try {
    const amount = pickString(req.body.amount || "15.00");
    const currency = pickString(req.body.currency || "EUR");
    const token = await getPayPalAccessToken();

    const r = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [{ amount: { currency_code: currency, value: amount } }],
      }),
    });

    const data = await r.json();
    if (!r.ok) return res.status(400).json({ ok: false, error: "paypal_create_failed", details: data });
    return res.json({ ok: true, order: data });
  } catch (err) {
    console.error("❌ POST /api/paypal/create-order error:", err?.message || err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// Capture order
app.post("/api/paypal/capture-order", async (req, res) => {
  try {
    const orderID = pickString(req.body.orderID);
    if (!orderID) return badRequest(res, "orderID obligatoire");

    const token = await getPayPalAccessToken();

    const r = await fetch(`${PAYPAL_BASE}/v2/checkout/orders/${orderID}/capture`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });

    const data = await r.json();
    if (!r.ok) return res.status(400).json({ ok: false, error: "paypal_capture_failed", details: data });

    const captureId = data?.purchase_units?.[0]?.payments?.captures?.[0]?.id || null;
    return res.json({ ok: true, capture: data, captureId });
  } catch (err) {
    console.error("❌ POST /api/paypal/capture-order error:", err?.message || err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

/** =======================
 *  RESEND EMAIL
 *  ======================= */
async function sendEmailResend({ to, subject, html }) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to: [to],
      subject,
      html,
    }),
  });

  const data = await r.json();
  if (!r.ok) throw new Error(`Resend error: ${r.status} ${JSON.stringify(data)}`);
  return data;
}

function renderClientEmail(resv) {
  return `
    <div style="font-family:Arial,sans-serif;line-height:1.5">
      <h2>✅ Paiement confirmé</h2>
      <p>Bonjour <b>${resv.full_name}</b>,</p>
      <p>Votre paiement a été confirmé et votre réservation est enregistrée.</p>
      <p><b>Service :</b> ${resv.service_type}</p>
      <p><b>Référence :</b> #${resv.id}</p>
      <p><b>Montant :</b> ${resv.deposit_amount} ${resv.currency}</p>
      <p><b>Status :</b> ${resv.status}</p>
      <hr/>
      <p>📞 WhatsApp: 00212627201720 / 00221762383780</p>
      <p>Merci pour votre confiance 🙏</p>
    </div>
  `;
}

function renderAdminEmail(resv) {
  return `
    <div style="font-family:Arial,sans-serif;line-height:1.5">
      <h2>🧾 Paiement reçu #${resv.id}</h2>
      <p><b>Nom :</b> ${resv.full_name}</p>
      <p><b>Téléphone :</b> ${resv.phone}</p>
      <p><b>Email :</b> ${resv.email || "-"}</p>
      <p><b>Service :</b> ${resv.service_type}</p>
      <p><b>De :</b> ${resv.from_city || "-"}</p>
      <p><b>Vers :</b> ${resv.to_city || "-"}</p>
      <p><b>Check-in :</b> ${resv.check_in || "-"}</p>
      <p><b>Check-out :</b> ${resv.check_out || "-"}</p>
      <p><b>Voyageurs :</b> ${resv.travelers}</p>
      <p><b>Notes :</b> ${resv.notes || "-"}</p>
      <p><b>PayPal Order :</b> ${resv.paypal_order_id || "-"}</p>
      <p><b>PayPal Capture :</b> ${resv.paypal_capture_id || "-"}</p>
      <p><b>Status :</b> ${resv.status}</p>
    </div>
  `;
}

/** =======================
 *  404 JSON
 *  ======================= */
app.use((req, res) => {
  res.status(404).json({ ok: false, error: "not_found", path: req.path });
});

/** =======================
 *  START
 *  ======================= */
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`✅ PayPal mode: ${PAYPAL_ENV}`);
});
