import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 10000;

const PAYPAL_CLIENT = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_SECRET = process.env.PAYPAL_SECRET;

const PAYPAL_BASE =
  process.env.NODE_ENV === "production"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";


// ================= HEALTH CHECK =================
app.get("/api/health", (req, res) => {
  res.json({ ok: true, message: "StoreFlight API running ✈️" });
});


// ================= GET TOKEN =================
async function getPayPalToken() {
  const auth = Buffer.from(`${PAYPAL_CLIENT}:${PAYPAL_SECRET}`).toString("base64");

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


// ================= CREATE ORDER =================
app.post("/api/paypal/create-order", async (req, res) => {
  try {
    const { amount } = req.body;

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
              currency_code: "USD",
              value: amount,
            },
          },
        ],
      }),
    });

    const data = await r.json();
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "create order failed" });
  }
});


// ================= CAPTURE ORDER =================
app.post("/api/paypal/capture-order", async (req, res) => {
  try {
    const { orderID } = req.body;

    const token = await getPayPalToken();

    const r = await fetch(
      `${PAYPAL_BASE}/v2/checkout/orders/${orderID}/capture`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    const data = await r.json();
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "capture failed" });
  }
});


// ================= START SERVER =================
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
