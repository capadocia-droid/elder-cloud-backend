// server.mjs
import express from "express";
import fs from "fs";
import temp from "temp";
import nodemailer from "nodemailer";
import { OpenAI } from "openai";

/**
 * ================== ENV VARS (Render → Environment) ==================
 * PORT                (Render sets this automatically)
 * API_SHARED_KEY      ← must match the app's constant / pairing key
 * OPENAI_API_KEY      e.g. sk-...
 *
 * EMAIL_FROM          e.g. "Elder Recorder <no-reply@example.com>"
 * SMTP_HOST           e.g. smtp.gmail.com (or your provider)
 * SMTP_PORT           e.g. 587
 * SMTP_SECURE         "false" or "true"
 * SMTP_USER           smtp username (omit if your host doesn't need auth)
 * SMTP_PASS           smtp password
 * =====================================================================
 */

const {
  PORT = 3000,
  API_SHARED_KEY,
  OPENAI_API_KEY,
  EMAIL_FROM = '"Elder Recorder" <no-reply@example.com>',
  SMTP_HOST,
  SMTP_PORT = 587,
  SMTP_SECURE = "false",
  SMTP_USER,
  SMTP_PASS,
} = process.env;

// ---------- Express ----------
const app = express();
app.use(express.json({ limit: "50mb" }));

// ---------- Health check ----------
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// ---------- Auth middleware ----------
app.use((req, res, next) => {
  if (req.path === "/healthz") return next();

  const headerKey =
    (req.headers["x-shared-key"] ??
      req.headers["x-api-key"] ??
      (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "")) || "";

  const k = String(headerKey).trim();
  const expected = String(API_SHARED_KEY || "").trim();

  if (!expected) {
    console.warn("[AUTH] API_SHARED_KEY not set — allowing all requests");
    return next();
  }
  if (k && k === expected) return next();

  console.warn("[AUTH] Unauthorized", {
    gotLen: k.length,
    expLen: expected.length,
    gotPreview: k.slice(0, 4) + "…",
    expPreview: expected.slice(0, 4) + "…",
  });

  return res.status(401).json({ ok: false, error: "Unauthorized" });
});

// ---------- Nodemailer ----------
const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: Number(SMTP_PORT),
  secure: String(SMTP_SECURE).toLowerCase() === "true",
  auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
});

// ---------- OpenAI ----------
if (!OPENAI_API_KEY) {
  console.warn("[OPENAI] Missing OPENAI_API_KEY — transcription will fail");
}
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ---------- Helpers ----------
async function base64ToTempFile(base64, filename = "audio.m4a") {
  const info = temp.openSync({ prefix: "elder_", suffix: "_" + filename });
  fs.writeFileSync(info.path, Buffer.from(base64, "base64"));
  return info.path;
}

async function transcribe(filePath) {
  try {
    const stream = fs.createReadStream(filePath);
    const r = await openai.audio.transcriptions.create({
      file: stream,
      model: "gpt-4o-transcribe",
    });
    return (r?.text || "").trim();
  } catch (e) {
    console.warn("[OPENAI] gpt-4o-transcribe failed, trying whisper-1:", e?.message || e);
    const stream2 = fs.createReadStream(filePath);
    const r2 = await openai.audio.transcriptions.create({
      file: stream2,
      model: "whisper-1",
    });
    return (r2?.text || "").trim();
  }
}

// ---------- Upload endpoint ----------
/**
 * POST /upload
 * Body JSON:
 * {
 *   elderName?: string,
 *   caregiverEmail: string,   // required
 *   ccEmail?: string,
 *   bccEmail?: string,
 *   replyDisplayName?: string,
 *   audioFileName?: string,
 *   audioB64: string          // base64 audio (m4a)
 * }
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
      audioB64,
    } = req.body || {};

    if (!caregiverEmail || !audioB64) {
      return res
        .status(400)
        .json({ ok: false, error: "audioB64 and caregiverEmail required" });
    }

    // 1) Save audio temp file
    const tmpPath = await base64ToTempFile(audioB64, audioFileName);

    // 2) Transcribe
    let transcriptText = "";
    try {
      transcriptText = await transcribe(tmpPath);
      if (!transcriptText) transcriptText = "(empty transcript)";
    } catch (e) {
      console.error("[OPENAI] Transcription failed:", e);
      return res.status(500).json({ ok: false, error: "Transcription failed" });
    }

    // 3) Email transcript only
    const headerLines = [
      elderName ? `Elder: ${elderName}` : null,
      replyDisplayName ? `Recorded by: ${replyDisplayName}` : null,
      audioFileName ? `File: ${audioFileName}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    const emailBody = (headerLines ? headerLines + "\n\n" : "") + transcriptText;

    try {
      await transporter.sendMail({
        from: EMAIL_FROM,
        to: caregiverEmail,
        cc: ccEmail || undefined,
        bcc: bccEmail || undefined,
        subject: `Transcript – ${audioFileName}`,
        text: emailBody,
        attachments: [
          {
            filename:
              (audioFileName.replace(/\.[^/.]+$/, "") || "transcript") + ".txt",
            content: emailBody,
          },
        ],
      });
    } catch (e) {
      console.error("[EMAIL] sendMail failed:", e);
      return res.status(500).json({ ok: false, error: "Email send failed" });
    } finally {
      try { fs.unlinkSync(tmpPath); } catch {}
    }

    return res.json({
      ok: true,
      transcriptText,
      deliveredAtISO: new Date().toISOString(),
    });
  } catch (e) {
    console.error("[UPLOAD] Unexpected error:", e);
    return res.status(500).json({ ok: false, error: "Unexpected server error" });
  }
});

// ---------- Start ----------
app.listen(PORT, () =>
  console.log(`✅ Elder Cloud Backend listening on :${PORT}`)
);
