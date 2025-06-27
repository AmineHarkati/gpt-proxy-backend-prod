const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.post("/generate", async (req, res) => {
  const { prompt, tone } = req.body;

  if (!prompt || !tone) {
    return res.status(400).json({ error: "Prompt et tone requis." });
  }

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-3.5-turbo",
        messages: [
          {
            role: "system",
            content: "Tu es un assistant qui rédige des commentaires pertinents pour les réseaux sociaux.",
          },
          {
            role: "user",
            content: `Génère un commentaire ${tone} pour ce post : \"${prompt}\"`,
          },
        ],
        temperature: 0.7,
        max_tokens: 100,
      }),
    });

    const data = await response.json();
    console.log("Réponse OpenAI brute :", data);

    if (!data.choices || !data.choices[0] || !data.choices[0].message) {
      return res.status(500).json({ error: "Réponse invalide ou vide de GPT." });
    }

    res.json({ comment: data.choices[0].message.content.trim() });
  } catch (err) {
    res.status(500).json({ error: "Erreur serveur", details: err.message });
  }
});

app.listen(PORT, () => console.log(`API GPT proxy en ligne sur port ${PORT}`));