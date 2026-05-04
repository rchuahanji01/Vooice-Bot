require("dotenv").config();

module.exports = {
  port:           parseInt(process.env.PORT || "3000", 10),
  publicBaseUrl:  process.env.PUBLIC_BASE_URL || "",
  bankName:       process.env.BANK_NAME || "HDFC Bank",

  mongoUri:       process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/loanbot",

  groq: {
    apiKey: process.env.GROQ_API_KEY,
    model:  process.env.LLM_MODEL || "llama-3.3-70b-versatile",
    url:    "https://api.groq.com/openai/v1/chat/completions",
  },

  sarvam: {
    apiKey: process.env.SARVAM_API_KEY,
    model:  process.env.SARVAM_MODEL || "sarvam-m",
    ttsUrl: "https://api.sarvam.ai/text-to-speech",
    sttUrl: "https://api.sarvam.ai/speech-to-text",
  },

  twilio: {
    accountSid:  process.env.TWILIO_ACCOUNT_SID,
    authToken:   process.env.TWILIO_AUTH_TOKEN,
    phoneNumber: process.env.TWILIO_PHONE_NUMBER,
  },

  maxRetries: parseInt(process.env.MAX_RETRIES || "3", 10),
};
