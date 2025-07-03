import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import fetch from "node-fetch";
import Stripe from "stripe";
import { Pool } from "pg";
import bodyParser from "body-parser";

dotenv.config();

const app = express();
app.use(cors());
app.use((req, res, next) => {
   if (req.originalUrl === "/webhook") {
     next(); // ne pas parser JSON ici
   } else {
     express.json()(req, res, next); // parser JSON ailleurs
   }
});

const PORT = process.env.PORT || 3000;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ✅ Connexion PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

(async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    userId TEXT PRIMARY KEY,
    email TEXT,
    credits INTEGER DEFAULT 0
  );`);
})();

// ✅ Génération de commentaire avec suivi crédits
app.post("/generate", async (req, res) => {
  const { prompt, tone, userId } = req.body;

  console.log("📩 Reçu /generate avec :", { prompt, tone, userId });

  if (!userId) {
    console.error("❌ userId manquant");
    return res.status(400).json({ error: "userId requis." });
  }

  try {
    const result = await pool.query("SELECT * FROM users WHERE userId = $1", [userId]);
    let user = result.rows[0];
    console.log("👤 Utilisateur récupéré :", user);

    if (!user) {
      console.log("➕ Nouvel utilisateur, insertion en base...");
      await pool.query("INSERT INTO users (userId, email, credits) VALUES ($1, $2, $3)", [userId, '', 5]);
      const newUserResult = await pool.query("SELECT * FROM users WHERE userId = $1", [userId]);
      user = newUserResult.rows[0];
    }

    const credits = user?.credits ?? 0;
    console.log(`💰 Crédits restants pour ${userId} : ${credits}`);

    if (credits <= 0) {
      console.warn("🚫 Plus de crédits");
      return res.status(429).json({ error: "❌ Vous n'avez plus de crédits." });
    }

    const fullPrompt = `Génère un commentaire ${tone} pour ce post, en 2 ou 3 lignes maximum, sans répéter le texte original et assure toi de ne pas dépasser un max_tokens de 300 : "${prompt}"`;

    console.log("📤 Envoi à OpenAI :", fullPrompt);

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: fullPrompt }],
        max_tokens: 300,
      }),
    });

    const data = await response.json();
    console.log("📥 Réponse OpenAI :", data);

    const comment = data.choices?.[0]?.message?.content;

    if (!comment) {
      console.error("❌ Réponse vide ou invalide de GPT :", data);
      return res.status(500).json({ error: "Réponse vide ou invalide de GPT." });
    }

    await pool.query("UPDATE users SET credits = credits - 1 WHERE userId = $1", [userId]);
    console.log(`✅ Crédit décrémenté pour ${userId}`);

    res.json({ comment });
  } catch (error) {
    console.error("❌ Erreur globale dans /generate :", error);
    res.status(500).json({ error: "Erreur interne du serveur." });
  }
});

// 🔁 Lancement du paiement Stripe
app.get("/payment/start", async (req, res) => {
  const { userId, email } = req.query;

  if (!userId || !email) {
    return res.status(400).json({ error: "userId et email requis." });
  }

  await pool.query("INSERT INTO users (userId, email, credits) VALUES ($1, $2, $3) ON CONFLICT (userId) DO NOTHING", [userId, email, 0]);

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [{
        price_data: {
          currency: "eur",
          product_data: { name: "Pack de 50 commentaires GPT" },
          unit_amount: 500,
        },
        quantity: 1,
      }],
      mode: "payment",
      success_url: `https://auto-comment-extension.vercel.app/success?userId=${userId}`,
      cancel_url: `https://auto-comment-extension.vercel.app/cancel`,
      metadata: { userId },
      customer_email: email
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Erreur Stripe :", err);
    res.status(500).json({ error: "Erreur lors de la création de la session Stripe." });
  }
});

// ✅ Webhook Stripe : créditer
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Erreur Webhook :", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const userId = session.metadata?.userId;
    const email = session.customer_details?.email || "";

    if (userId) {
      await pool.query(
        "INSERT INTO users (userId, email, credits) VALUES ($1, $2, $3) ON CONFLICT(userId) DO UPDATE SET credits = users.credits + 50, email = excluded.email",
        [userId, email, 50]
      );
      console.log(`🎉 Paiement validé - 50 crédits ajoutés pour ${userId}, email : ${email}`);
    }
  }

  res.json({ received: true });
});

app.get("/user/credits", async (req, res) => {
  const { userId } = req.query;

  if (!userId) return res.status(400).json({ error: "userId requis." });

  try {
    const result = await pool.query("SELECT credits FROM users WHERE userId = $1", [userId]);
    const user = result.rows[0];
    const credits = user?.credits ?? 0;
    res.json({ credits });
  } catch (e) {
    console.error("Erreur récupération crédits :", e);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

app.post("/recover", async (req, res) => {
  const { email, newUserId } = req.body;

  if (!email || !newUserId) {
    return res.status(400).json({ error: "Email et nouvel userId requis." });
  }

  const result = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
  const existingUser = result.rows[0];

  if (!existingUser) {
    return res.status(404).json({ error: "Aucun compte trouvé avec cet email." });
  }

  await pool.query("UPDATE users SET userId = $1 WHERE email = $2", [newUserId, email]);
  console.log(`🔁 userId mis à jour pour ${email} -> ${newUserId}`);

  res.json({ success: true, message: "Crédits récupérés avec succès." });
});

app.listen(PORT, () => {
  console.log(`✅ API GPT proxy en ligne sur port ${PORT}`);
});
