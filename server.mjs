import express from "express";
import bodyParser from "body-parser";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import nodemailer from "nodemailer";
import OpenAI from "openai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const API_SHARED_KEY = process.env.API_SHARED_KEY || "secret123";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.error("❌ Missing OPENAI_API_KEY in environment");
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const app = express();
app.use(bodyParser.json({ limit: "50mb" }));

// ------------------------
// Retry wrapper for transcription
// ------------------------
async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function transcribeWithRetry(filePath, { model = "whisper-1", tries = 4 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const file = fs.createReadStream(filePath);
      const r = await openai.audio.transcriptions.create({ file, model });
      return (r?.text || "").trim();
    } catch (err) {
      lastErr = err;
      console.error(
        `⚠️ Transcribe attempt ${attempt} failed:`,
        err?.code || err?.name || err?.message
      );
      if (attempt < tries) await sleep(800 * attempt * attempt); // backoff
    }
  }
  throw lastErr;
}

// ------------------------
// Routes
// ------------------------
app.get("/", (req, res) => {
  res.json({ ok: true, message: "Elder backend running" });
});

app.get("/healthz", (req, res) => {
  res.json({ ok: true, status: "healthy" });
});

app.post("/upload", async (req, res) => {
  try {
    // ------------------------
    // Auth
    // ------------------------
    const key = req.headers["x-api-key"];
    if (key !== API_SHARED_KEY) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const { audioB64, caregiverEmail, elderName } = req.body;
    if (!audioB64 || !caregiverEmail) {
      return res.status(400).json({ ok: false, error: "audioB64 and caregiverEmail required" });
    }

    // ------------------------
    // Save temp audio file
    // ------------------------
    const tmpPath = path.join(__dirname, `upload_${Date.now()}.m4a`);
    fs.writeFileSync(tmpPath, Buffer.from(audioB64, "base64"));

    // ------------------------
    // Transcribe
    // ------------------------
    let transcriptText = "(no transcript)";
    try {
      transcriptText =
        (await transcribeWithRetry(tmpPath, { model: "whisper-1", tries: 4 })) ||
        "(empty transcript)";
    } catch (err) {
      console.error("❌ Transcription error:", err);
      return res.status(500).json({ ok: false, error: "Transcription failed" });
    }

    // ------------------------
    // Email the transcript
    // ------------------------
    try {
      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        }
      });

      const subject = `Elder Interview Transcript ${elderName || ""}`.trim();
      const mail = {
        from: process.env.SMTP_USER,
        to: caregiverEmail,
        subject,
        text: transcriptText
      };

      await transporter.sendMail(mail);
      console.log("✅ Transcript sent to", caregiverEmail);
    } catch (err) {
      console.error("❌ Email send error:", err.message);
      // still return transcript so app knows it worked up to here
      return res.status(500).json({ ok: false, error: "Email send failed" });
    }

    // ------------------------
    // Cleanup + respond
    // ------------------------
    fs.unlinkSync(tmpPath);
    res.json({ ok: true, transcript: transcriptText });
  } catch (err) {
    console.error("❌ Upload error:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// ------------------------
app.listen(PORT, () => {
  console.log(`🚀 API listening on :${PORT}`);
});
