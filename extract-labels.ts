import { GoogleGenAI, Type } from "@google/genai";

export default async (request: Request) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "GEMINI_API_KEY is not configured. Please set it in Netlify environment variables." },
      { status: 500 }
    );
  }

  const ai = new GoogleGenAI({ apiKey });

  let body: { image?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { image } = body;
  if (!image) {
    return Response.json({ error: "Missing image payload." }, { status: 400 });
  }

  const matches = image.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-+.]+);base64,(.+)$/);
  if (!matches || matches.length !== 3) {
    return Response.json({ error: "Invalid base64 image data uri format." }, { status: 400 });
  }

  const mimeType = matches[1];
  const base64Data = matches[2];

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          inlineData: { mimeType, data: base64Data },
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
    if (!text) throw new Error("No text returned by the visual AI model.");

    return Response.json(JSON.parse(text));
  } catch (error: any) {
    console.error("Gemini Vision Label extraction error:", error);
    return Response.json(
      { error: error.message || "Failed to process image and extract labels using Gemini." },
      { status: 500 }
    );
  }
};

export const config = { path: "/api/extract-labels" };
