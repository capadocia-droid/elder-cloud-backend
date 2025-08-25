// server.mjs
import express from "express";
import nodemailer from "nodemailer";
import fs from "fs";
import temp from "temp";
import { OpenAI } from "openai";

/**
 * ========= ENV VARS (set these in Render → Environment) =========
 *  PORT                (Render sets this automatically)
 *  OPENAI_API_KEY      e.g. sk-...
 *  API_SHARED_KEY      e.g. yoursecret         <-- must match the app
 *
 *  EMAIL_FROM          e.g. "Elder Recorder <no-reply@example.com>"
 *  SMTP_HOST           e.g. smtp.sendgrid.net (or your provider)
 *  SMTP_PORT           e.g. 587
 *  SMTP_SECURE         "false" or "true"
 *  SMTP_USER           smtp username (or leave undefined for unauth)
 *  SMTP_PASS           smtp password
 * ================================================================
 */

const {
  PORT = 3000,
  OPENAI_API_KEY,
  API_SHARED_KEY,
  EMAIL_FROM = '"Elder Recorder" <no-reply@example.com>',
  SMTP_HOST,
  SMTP_PORT = 587,
  SMTP_SECURE = "false",
  SMTP_USER,
  SMTP_PASS
} = process.env;

if (!OPENAI_API_KEY) {
  throw new Error("Missing OPENAI_API_KEY");
}

const app = express();
app.use(express.json({ limit: "50mb" }));

// ---------- OPEN HEALTH CHECK (no auth) ----------
app.get("/healthz", (_, res) => res.json({ ok: true }));

// ---------- AUTH MIDDLEWARE (all other routes) ----------
app.use((req, res, next) => {
  if (req.path === "/healthz") return next();
  const k = req.headers["x-shared-key"];
  if (!API_SHARED_KEY || k === API_SHARED_KEY) return next();
  return res.status(401).json({ ok: false, error: "Unauthorized" });
});

// ---------- EMAIL TRANSPORT ----------
const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: Number(SMTP_PORT),
  secure: String(SMTP_SECURE).toLowerCase() === "true",
  auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined
});

// ---------- OPENAI ----------
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// helper: write base64 audio to temp file and return path
async function base64ToTempFile(base64, filename = "audio.m4a") {
  const info = temp.openSync({ prefix: "elder_", suffix: "_" + filename });
  fs.writeFileSync(info.path, Buffer.from(base64, "base64"));
  return info.path;
}

/**
 * POST /upload
 * Body:
 * {
 *   elderName?: string,
 *   caregiverEmail: string,
 *   ccEmail?: string,
 *   bccEmail?: string,
 *   replyDisplayName?: string,
 *   audioFileName?: string,
 *   audioB64: string   // base64 audio (m4a / aac)
 * }
 * Returns: { ok: true, transcriptText, deliveredAtISO }
 */
app.post("/upload", async (req, res) => {
  try {
    const {
      elderName,
      caregiverEmail,
      ccEmail,
      bccEmail,
      replyDisplayName,
      audioFileName = "interview.m4a",
      audioB64
    } = req.body || {};

    if (!audioB64 || !caregiverEmail) {
      return res.status(400).json({ ok: false, error: "audioB64 and caregiverEmail required" });
    }

    // 1) Save temp audio file
    const tmpPath = await base64ToTempFile(audioB64, audioFileName);

    // 2) Transcribe with OpenAI (text-only)
    //    model options (as of mid-2025): "gpt-4o-transcribe" or "whisper-1"
    const file = fs.createReadStream(tmpPath);
    const tr = await openai.audio.transcriptions.create({
      file,
      model: "gpt-4o-transcribe"
    });
    const transcriptText = (tr?.text || "").trim() || "(empty transcript)";

    // 3) Email transcript only (no audio)
    const header = [
      elderName ? `Elder: ${elderName}` : null,
      replyDisplayName ? `Recorded by: ${replyDisplayName}` : null,
      audioFileName ? `File: ${audioFileName}` : null
    ]
      .filter(Boolean)
      .join("\n");

    const emailText = (header ? header + "\n\n" : "") + transcriptText;

    await transporter.sendMail({
      from: EMAIL_FROM,
      to: caregiverEmail,
      cc: ccEmail || undefined,
      bcc: bccEmail || undefined,
      subject: `Transcript – ${audioFileName}`,
      text: emailText,
      attachments: [
        { filename: (audioFileName.replace(/\.[^/.]+$/, "") || "transcript") + ".txt", content: emailText }
      ]
    });

    // 4) Cleanup temp file
    try { fs.unlinkSync(tmpPath); } catch {}

    return res.json({
      ok: true,
      transcriptText,
      deliveredAtISO: new Date().toISOString()
    });
  } catch (e) {
    console.error("Upload error:", e);
    return res.status(500).json({ ok: false, error: "Transcription/email failed" });
  }
});

// ---------- START ----------
app.listen(PORT, () => console.log(`API listening on :${PORT}`));

