// server.mjs
import express from "express";
import nodemailer from "nodemailer";
import fs from "fs";
import temp from "temp";
import { OpenAI } from "openai";

/**
 * ================== ENV VARS (Render → Environment) ==================
 * PORT                (Render sets this automatically)
 * API_SHARED_KEY      u7Y3pK9dL2mQ5aX0sR8vB4cT1hZ
 * OPENAI_API_KEY      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
 *
 * EMAIL_FROM          "Elder Recorder <capadocia@gmail.com>"
 * SMTP_HOST           smtp.gmail.com
 * SMTP_PORT           587
 * SMTP_SECURE         "false"
 * SMTP_USER           capadocia@gmail.com
 * SMTP_PASS           gnzz vmaj tnut dckx
 * =====================================================================
 */

const {
  PORT = 3000,
  API_SHARED_KEY,
  OPENAI_API_KEY,
  EMAIL_FROM = '"Elder Recorder" <capadocia@gmail.com>',
  SMTP_HOST,
  SMTP_PORT = 587,
  SMTP_SECURE = "false",
  SMTP_USER,
  SMTP_PASS,
} = process.env;

const app = express();
app.use(express.json({ limit: "50mb" }));

// --------- health (no auth) ---------
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// --------- tolerant auth middleware for everything else ---------
app.use((req, res, next) => {
  if (req.path === "/healthz") return next();

  const headerKey =
    (req.headers["x-shared-key"] ??
      req.headers["x-api-key"] ??
      (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "")) || "";

  const k = String(headerKey).trim();
  const expected = String(API_SHARED_KEY || "").trim();

  if (!expected) {
    console.warn("[AUTH] API_SHARED_KEY not set on server — allowing request");
    return next();
  }
  if (k && k === expected) return next();

  console.warn("[AUTH] Mismatch", {
    gotLen: k.length,
    expLen: expected.length,
    gotPreview: k.slice(0, 4) + "…",
    expPreview: expected.slice(0, 4) + "…",
    path: req.path,
  });

  return res.status(401).json({ ok: false, error: "Unauthorized" });
});

// --------- email transport ---------
const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: Number(SMTP_PORT),
  secure: String(SMTP_SECURE).toLowerCase() === "true",
  auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
});

// --------- OpenAI client ---------
if (!OPENAI_API_KEY) {
  console.warn("[OPENAI] Missing OPENAI_API_KEY — transcription will fail.");
}
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// helpers
async function base64ToTempFile(base64, filename = "audio.m4a") {
  const info = temp.openSync({ prefix: "elder_", suffix: "_" + filename });
  fs.writeFileSync(info.path, Buffer.from(base64, "base64"));
  return info.path;
}

async function transcribe(filePath) {
  // Try GPT-4o Transcribe first; fall back to whisper-1 if unavailable.
  const stream = fs.createReadStream(filePath);
  try {
    const r = await openai.audio.transcriptions.create({
      file: stream,
      model: "gpt-4o-transcribe",
    });
    return (r?.text || "").trim();
  } catch (e) {
    console.warn("[OPENAI] gpt-4o-transcribe failed, trying whisper-1:", e?.message || e);
  }
  const stream2 = fs.createReadStream(filePath);
  const r2 = await openai.audio.transcriptions.create({
    file: stream2,
    model: "whisper-1",
  });
  return (r2?.text || "").trim();
}

/**
 * POST /upload
 * Body JSON:
 * {
 *   elderName?: string,
 *   caregiverEmail: string,   // required
 *   ccEmail?: string,
 *   bccEmail?: string,
 *   replyDisplayName?: string,
 *   audioFileName?: string,   // e.g. interview_YYYYMMDD_HHMMSS.m4a
 *   audioB64: string          // base64 of AAC/M4A
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
      audioB64,
    } = req.body || {};

    if (!caregiverEmail || !audioB64) {
      return res
        .status(400)
        .json({ ok: false, error: "audioB64 and caregiverEmail required" });
    }

    // 1) persist temp audio
    const tmpPath = await base64ToTempFile(audioB64, audioFileName);

    // 2) transcribe (text only)
    let transcriptText = "";
    try {
      transcriptText = await transcribe(tmpPath);
      if (!transcriptText) transcriptText = "(empty transcript)";
    } catch (e) {
      console.error("[OPENAI] Transcription failed:", e);
      return res.status(500).json({ ok: false, error: "Transcription failed" });
    }

    // 3) email transcript (no audio)
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
      try {
        fs.unlinkSync(tmpPath);
      } catch {}
    }

    return res.json({
      ok: true,
      transcriptText,
      deliveredAtISO: new Date().toISOString(),
    });
  } catch (e) {
    console.error("[UPLOAD] Unexpected error:", e);
    return res
      .status(500)
      .json({ ok: false, error: "Unexpected server error" });
  }
});

// start
app.listen(PORT, () =>
  console.log(`API listening on :${PORT}  (health at /healthz)`)
);
