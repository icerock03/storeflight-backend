import express from "express";
import pkg from "pg";
const { Pool } = pkg;

const app = express();
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// créer table auto au démarrage
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
      deposit_amount_eur NUMERIC(10,2) DEFAULT 15,
      status TEXT DEFAULT 'pending',
      payment_method TEXT DEFAULT 'paypal',
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  console.log("Database ready ✅");
}
initDB();


// route test
app.get("/", (req,res)=>{
  res.send("StoreFlight API running ✈️");
});

// créer réservation
app.post("/api/reservations", async (req,res)=>{
  try {
    const r = await pool.query(`
      INSERT INTO reservations
      (full_name,phone,email,service_type,from_city,to_city,check_in,check_out,travelers,notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING *
    `,
    [
      req.body.full_name,
      req.body.phone,
      req.body.email,
      req.body.service_type,
      req.body.from_city,
      req.body.to_city,
      req.body.check_in,
      req.body.check_out,
      req.body.travelers,
      req.body.notes
    ]);

    res.json(r.rows[0]);

  } catch(err){
    console.error(err);
    res.status(500).json({error:"Erreur serveur"});
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log("Server running on", PORT));
