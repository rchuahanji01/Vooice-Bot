const axios = require("axios");
const fs = require("node:fs");
const path = require("node:path");
const FormData = require("form-data");
const { v4: uuidv4 } = require("uuid");
const config = require("../config");

/**
 * Sarvam handles BOTH speech-to-text and text-to-speech.
 *
 * Why Sarvam STT instead of Twilio's <Gather speech>?
 * Twilio's built-in speech recognizer is optimized for English. Hindi and
 * especially Hinglish (Hindi-in-Roman + English code-switching) come back
 * with poor accuracy. Sarvam is purpose-built for Indic languages and
 * handles Hinglish gracefully.
 *
 * The flow we use:
 *   1. <Record> the caller's speech to a Twilio recording URL (.wav)
 *   2. Download it (basic auth, Twilio Account SID + Auth Token)
 *   3. POST to Sarvam STT → transcript + detected language
 *   4. Pass transcript to Groq for intent classification
 *
 * For TTS:
 *   1. POST text to Sarvam TTS → base64 WAV (16-bit PCM, 22050 Hz)
 *   2. Save to ./public/audio/<uuid>.wav
 *   3. Twilio <Play> fetches it via the public ngrok URL
 *
 * Twilio's <Play> verb accepts mp3 and wav directly. Sarvam returns 22050 Hz
 * WAV which Twilio resamples server-side to telephony 8 kHz µ-law — no
 * client-side conversion needed for the demo. For production-grade latency,
 * pre-encode to µ-law 8 kHz with ffmpeg.
 */
const AUDIO_DIR = path.join(__dirname, "..", "public", "audio");
fs.mkdirSync(AUDIO_DIR, { recursive: true });

const LANG_MAP = {
  en:       "en-IN",
  hi:       "hi-IN",
  hinglish: "hi-IN",   // Sarvam reads Hindi-in-Roman fine under hi-IN
};

/* ─────────────────────────────────────────────────────────────
   TEXT-TO-SPEECH
   ───────────────────────────────────────────────────────────── */
async function tts({ text, language = "en" }) {
  const targetLang = LANG_MAP[language] || "en-IN";

  const payload = {
    text,
    target_language_code: targetLang,
    speaker:              "anushka",
    model:                "bulbul:v2",
    enable_preprocessing: true,
  };

  const { data } = await axios.post(config.sarvam.ttsUrl, payload, {
    headers: {
      "api-subscription-key": config.sarvam.apiKey,
      "Content-Type":         "application/json",
    },
    timeout: 15000,
  });

  // Sarvam returns { audios: [base64], ... }
  const audioB64 = Array.isArray(data?.audios) ? data.audios[0] : data?.audio;
  if (!audioB64) throw new Error("Sarvam TTS returned no audio");

  const fileName = `${Date.now()}_${uuidv4().slice(0, 8)}.wav`;
  const filePath = path.join(AUDIO_DIR, fileName);
  fs.writeFileSync(filePath, Buffer.from(audioB64, "base64"));

  const url = `${config.publicBaseUrl.replace(/\/$/, "")}/audio/${fileName}`;
  return { url, filePath, language: targetLang };
}

/* ─────────────────────────────────────────────────────────────
   SPEECH-TO-TEXT (from Twilio recording URL)
   ───────────────────────────────────────────────────────────── */
async function sttFromTwilioRecording(recordingUrl) {
  // Twilio recordings are auth-gated. Download as buffer.
  const audioRes = await axios.get(`${recordingUrl}.wav`, {
    responseType: "arraybuffer",
    auth: {
      username: config.twilio.accountSid,
      password: config.twilio.authToken,
    },
    timeout: 15000,
  });

  // Sarvam STT expects multipart/form-data
  const form = new FormData();
  form.append("file", Buffer.from(audioRes.data), {
    filename:    "audio.wav",
    contentType: "audio/wav",
  });
  form.append("model",         "saarika:v2");
  form.append("language_code", "unknown");   // auto-detect
  form.append("with_timestamps", "false");

  const { data } = await axios.post(config.sarvam.sttUrl, form, {
    headers: {
      "api-subscription-key": config.sarvam.apiKey,
      ...form.getHeaders(),
    },
    timeout:        20000,
    maxBodyLength:  Infinity,
  });

  // Map Sarvam's language codes back to our internal en/hi/hinglish
  const langCode = data?.language_code || "en-IN";
  let language = "en";
  if (langCode.startsWith("hi")) {
    // Sarvam returns hi-IN for both Hindi and Hinglish — heuristic:
    // if transcript contains Roman characters mixed with detected hi, call it hinglish.
    const transcript = data?.transcript || "";
    const hasRoman = /[a-zA-Z]/.test(transcript);
    const hasDeva  = /[\u0900-\u097F]/.test(transcript);
    language = hasRoman && !hasDeva ? "hinglish" : "hi";
  }

  return {
    transcript: data?.transcript || "",
    language,
    rawLangCode: langCode,
  };
}

/* ─────────────────────────────────────────────────────────────
   Cleanup — purge old TTS files
   ───────────────────────────────────────────────────────────── */
function startCleanupJob() {
  const t = setInterval(() => {
    try {
      const now = Date.now();
      for (const f of fs.readdirSync(AUDIO_DIR)) {
        const p = path.join(AUDIO_DIR, f);
        const s = fs.statSync(p);
        if (now - s.mtimeMs > 10 * 60_000) fs.unlinkSync(p);
      }
    } catch (err) {
      console.error("[sarvam] cleanup failed:", err.message);
    }
  }, 60_000);
  t.unref();
}

module.exports = { tts, sttFromTwilioRecording, startCleanupJob, AUDIO_DIR };
