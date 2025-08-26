import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import OpenAI from "openai";
import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Multer setup for audio upload
const upload = multer({ dest: "uploads/" });

// OpenAI setup
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Email setup (use Gmail app password or any SMTP)
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// Health check
app.get("/healthz", (req, res) => {
  res.json({ ok: true, status: "healthy" });
});

// Upload endpoint
app.post("/upload", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) {
      console.error("[UPLOAD] No file received");
      return res.status(400).json({ error: "No audio uploaded" });
    }

    const audioPath = path.resolve(req.file.path);
    console.log(`[UPLOAD] Received file: ${audioPath}`);

    // Step 1: Transcribe with OpenAI
    console.log("[OPENAI] Sending to Whisper...");
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioPath),
      model: "gpt-4o-mini-transcribe", // or "whisper-1"
    });

    const transcript = transcription.text;
    console.log("[OPENAI] Transcript:", transcript);

    // Step 2: Email transcript
    const caregiverEmail = req.body.caregiverEmail || process.env.DEFAULT_EMAIL;
    if (!caregiverEmail) {
      console.error("[EMAIL] No caregiver email provided");
    } else {
      await transporter.sendMail({
        from: `"Elder Recorder" <${process.env.EMAIL_USER}>`,
        to: caregiverEmail,
        subject: "New Elder Interview Transcript",
        text: transcript,
      });
      console.log(`[EMAIL] Sent transcript to ${caregiverEmail}`);
    }

    // Step 3: Respond to app
    res.json({ ok: true, transcript });

    // Clean up file
    fs.unlinkSync(audioPath);
  } catch (err) {
    console.error("[SERVER ERROR]", err);
    res.status(500).json({ error: err.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 API listening on :${PORT}`);
});
