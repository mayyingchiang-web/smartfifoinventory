import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

// Ensure the Gemini API key exists
const apiKey = process.env.GEMINI_API_KEY;

let ai: GoogleGenAI | null = null;
if (apiKey) {
  ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  // We need larger payload limits for base64 camera images
  app.use(express.json({ limit: "15mb" }));
  app.use(express.urlencoded({ limit: "15mb", extended: true }));

  // API Route for Gemini-powered OCR
  app.post("/api/extract-labels", async (req, res) => {
    try {
      if (!ai) {
        return res.status(500).json({
          error: "GEMINI_API_KEY is not configured on this server. Please check the Settings -> Secrets panel.",
        });
      }

      const { image } = req.body;
      if (!image) {
        return res.status(400).json({ error: "Missing image payload." });
      }

      // Parse the base64 components
      const matches = image.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-+.]+);base64,(.+)$/);
      if (!matches || matches.length !== 3) {
        return res.status(400).json({ error: "Invalid base64 image data uri format." });
      }

      const mimeType = matches[1];
      const base64Data = matches[2];

      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: [
          {
            inlineData: {
              mimeType,
              data: base64Data,
            },
          },
          "Extract the Lot Number / Batch Code AND the Expiry Date / Expiration Date shown on this clinical packaging/label or vaccine container. Convert the expiry date strictly into YYYY-MM-DD. For instance, if you see 'EXP: 12/2028' use '2028-12-31'; if 'EXP: JUN 2027' use '2027-06-30'. Return accurate, reliable values based strictly on visual text.",
        ],
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              lot: {
                type: Type.STRING,
                description: "Extracted Lot code or Batch identifier. Prefer uppercase. E.g. 'L24A15' or 'LOT-B23'. Leave empty if not visible.",
              },
              expiryDate: {
                type: Type.STRING,
                description: "Extracted Expiration date converted to YYYY-MM-DD format. Leave empty if not visible.",
              },
            },
            required: ["lot", "expiryDate"],
          },
        },
      });

      const text = response.text;
      if (!text) {
        throw new Error("No text returned by the visual AI model.");
      }

      const parsed = JSON.parse(text);
      res.json(parsed);
    } catch (error: any) {
      console.error("Gemini Vision Label extraction error:", error);
      res.status(500).json({
        error: error.message || "Failed to process image and extract labels using Gemini.",
      });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server loaded and running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
