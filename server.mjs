import express from "express";
import nodemailer from "nodemailer";
import fs from "fs";
import temp from "temp";
import { OpenAI } from "openai";

const {
  PORT = 3000,
  OPENAI_API_KEY,
  SMTP_HOST,
  SMTP_PORT = 587,
  SMTP_SECURE = "false",
  SMTP_USER,
  SMTP_PASS,
  EMAIL_FROM = '"Elder Recorder" <no-reply@example.com>',
  API_SHARED_KEY
} = process.env;

if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

const app = express();
app.use(express.json({ limit: "50mb" }));

// simple header auth
app.use((req, res, next) => {
  const k = req.headers["x-api-key"];
  if (!API_SHARED_KEY || k === API_SHARED_KEY) return next();
  return res.status(401).json({ ok: false, error: "Unauthorized" });
});

// mailer
const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: Number(SMTP_PORT),
  secure: String(SMTP_SECURE).toLowerCase() === "true",
  auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined
});

// openai
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// helper: base64 → temp file
async function base64ToTempFile(base64, filename = "audio.m4a") {
  const info = temp.openSync({ prefix: "elder_", suffix: "_" + filename });
  fs.writeFileSync(info.path, Buffer.from(base64, "base64"));
  return info.path;
}

app.post("/upload", async (req, res) => {
  try {
    const { id, audioBase64, filename = "audio.m4a", emailTo, emailCc, emailBcc, elderName, replyDisplayName, language } = req.body;
    if (!audioBase64 || !emailTo) {
      return res.status(400).json({ ok: false, error: "audioBase64 and emailTo required" });
    }

    const tmpPath = await base64ToTempFile(audioBase64, filename);

    // transcribe (text only) with OpenAI
    const file = fs.createReadStream(tmpPath);
    const tr = await openai.audio.transcriptions.create({
      file,
      model: "gpt-4o-transcribe",
      ...(language ? { language } : {})
    });
    const transcriptText = (tr?.text || "").trim() || "(empty transcript)";

    // compose email body
    const header = [
      elderName ? `Elder: ${elderName}` : null,
      filename ? `File: ${filename}` : null
    ].filter(Boolean).join("\n");
    const emailText = (header ? header + "\n\n" : "") + transcriptText;

    await transporter.sendMail({
      from: EMAIL_FROM,
      to: emailTo,
      cc: emailCc || undefined,
      bcc: emailBcc || undefined,
      subject: `Transcript – ${filename}`,
      text: emailText,
      attachments: [{ filename: (filename || "transcript") + ".txt", content: emailText }]
    });

    try { fs.unlinkSync(tmpPath); } catch {}
    return res.json({ ok: true, transcriptText, deliveredAtISO: new Date().toISOString() });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "Transcription/email failed" });
  }
});

app.get("/healthz", (_, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`API listening on :${PORT}`));
