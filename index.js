
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import rateLimit from "express-rate-limit";
import fetch from "node-fetch";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const limiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 5,
  message: { error: "Limite d'utilisation atteinte (5 requêtes par jour)." },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use("/generate", limiter);

app.post("/generate", async (req, res) => {
  const { prompt, tone } = req.body;  

  const fullPrompt = `Génère un commentaire ${tone} pour ce post, en 2 ou 3 lignes maximum, sans répéter le texte original et assure toi de ne pas
  depassé un max_tokens de 300: "${prompt}"`;
  console.log("✅ Prompt envoyé à GPT :", fullPrompt);

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: fullPrompt }],
        temperature: 0.7,
        max_tokens: 300,
      }),
    });

    const data = await response.json();
    console.log("📨 Réponse OpenAI brute :", JSON.stringify(data, null, 2));

    if (data.choices && data.choices[0] && data.choices[0].message) {
      return res.json({ comment: data.choices[0].message.content });
    } else {
      return res.status(500).json({ error: "Réponse invalide de GPT." });
    }
  } catch (error) {
    console.error("Erreur OpenAI :", error);
    return res.status(500).json({ error: "Erreur lors de l'appel GPT." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("✅ API GPT proxy en ligne sur port", PORT);
});
