// server.mjs
import express from "express";
import multer from "multer";
import fs from "fs";
import nodemailer from "nodemailer";
import fetch from "node-fetch";
import path from "path";

const app = express();
const upload = multer({ dest: "uploads/" });

// ================== ENV VARS ==================
const PORT = process.env.PORT || 3000;
const API_SHARED_KEY = process.env.API_SHARED_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const EMAIL_FROM = process.env.EMAIL_FROM;
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = process.env.SMTP_PORT || 587;
const SMTP_SECURE = process.env.SMTP_SECURE === "true";
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;

// ================== TRANSPORTER ==================
const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_SECURE,
  auth: SMTP_USER
    ? {
        user: SMTP_USER,
        pass: SMTP_PASS,
      }
    : undefined,
});

// ================== HEALTH CHECK ==================
app.get("/healthz", (req, res) => {
  res.json({ ok: true });
});

// ================== UPLOAD ENDPOINT ==================
app.post("/upload", upload.single("audio"), async (req, res) => {
  try {
    // Authorization check
    const clientKey = req.headers["x-api-key"];
    if (!clientKey || clientKey !== API_SHARED_KEY) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    if (!req.file) {
      return res.status(400).json({ ok: false, error: "No file uploaded" });
    }

    const audioPath = req.file.path;

    // Send audio to OpenAI for transcription
    const formData = new FormData();
    formData.append("file", fs.createReadStream(audioPath));
    formData.append("model", "gpt-4o-transcribe");

    const openaiRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: formData,
    });

    if (!openaiRes.ok) {
      throw new Error(`OpenAI API error: ${openaiRes.status}`);
    }

    const data = await openaiRes.json();
    const transcript = data.text || "(No transcript returned)";

    // Email transcript
    const mailOptions = {
      from: EMAIL_FROM,
      to: req.body.to || process.env.DEFAULT_TO || SMTP_USER,
      subject: `New Elder Interview Transcript - ${new Date().toLocaleString()}`,
      text: transcript,
    };

    await transporter.sendMail(mailOptions);

    // Cleanup
    fs.unlinkSync(audioPath);

    res.json({ ok: true, transcript });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ================== START SERVER ==================
app.listen(PORT, () => {
  console.log(`✅ Elder Cloud Backend listening on :${PORT}`);
});
