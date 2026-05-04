const axios = require("axios");
const config = require("../config");
const { STATES } = require("../stateMachine");

/**
 * Low-level Groq chat call. Uses response_format: json_object when we want
 * strict JSON back (no markdown fences, no preamble).
 */
async function chat({ messages, temperature = 0.2, jsonMode = false, maxTokens = 300 }) {
  const body = {
    model:      config.groq.model,
    messages,
    temperature,
    max_tokens: maxTokens,
  };
  if (jsonMode) body.response_format = { type: "json_object" };

  const { data } = await axios.post(config.groq.url, body, {
    headers: {
      Authorization: `Bearer ${config.groq.apiKey}`,
      "Content-Type": "application/json",
    },
    timeout: 12000,
  });
  return data?.choices?.[0]?.message?.content ?? "";
}

/* ─────────────────────────────────────────────────────────────
   LLM TASK 1A: INTENT DETECTION (payment phase)
   ───────────────────────────────────────────────────────────── */
async function detectIntent(userText) {
  const prompt = `Classify the borrower's reply during a loan recovery call.

Return ONLY valid JSON in this schema:
{
  "intent": "PAID" | "WILL_PAY" | "REFUSE" | "DISPUTE" | "UNKNOWN",
  "language": "en" | "hi" | "hinglish",
  "promise_date": string | null
}

Rules:
- PAID:     user says they have already paid / "kar diya" / "paid yesterday"
- WILL_PAY: user agrees to pay (now / today / tomorrow / "kal" / specific date)
- REFUSE:   user refuses / "won't pay" / "paisa nahi hai aur nahi dunga"
- DISPUTE:  user contests the loan / amount / "ye loan mera nahi hai" / "wrong amount"
- UNKNOWN:  silence / unclear / unrelated
- promise_date: extract the date phrase if WILL_PAY (e.g. "tomorrow", "kal", "5th May"); else null
- language: en (English), hi (Devanagari Hindi), hinglish (Roman Hindi mixed with English)

User said: "${userText}"`;

  const raw = await chat({
    messages: [{ role: "user", content: prompt }],
    temperature: 0,
    jsonMode: true,
  });

  return safeParse(raw, { intent: "UNKNOWN", language: "en", promise_date: null });
}

/* ─────────────────────────────────────────────────────────────
   LLM TASK 1B: VERIFY-PHASE INTENT (name only — no OTP / no digits)
   ───────────────────────────────────────────────────────────── */
async function detectVerifyIntent(userText, customerName) {
  const prompt = `Classify a borrower's reply during identity verification on a recovery call.

Return ONLY valid JSON in this schema:
{
  "intent": "VERIFIED" | "NOT_ME" | "UNKNOWN",
  "language": "en" | "hi" | "hinglish"
}

Rules:
- VERIFIED: user confirms identity (yes / yeah / haan / "I am" / "speaking" / "${customerName} bol raha hoon").
- NOT_ME:   user says wrong number / wrong person / "galat number" / "main nahi hoon" / "this is not ${customerName}".
- UNKNOWN:  silence / ambiguous / unrelated.
- Detect language: en, hi (Devanagari), hinglish (Roman Hindi or mixed).

User said: "${userText}"`;

  const raw = await chat({
    messages: [{ role: "user", content: prompt }],
    temperature: 0,
    jsonMode: true,
  });

  return safeParse(raw, { intent: "UNKNOWN", language: "en" });
}

/* ─────────────────────────────────────────────────────────────
   LLM TASK 2: RESPONSE GENERATION
   - polite but firm
   - NEVER asks for OTP / account number / sensitive data
   - NEVER promises a waiver
   - NEVER changes the amount
   - 1–2 short sentences
   - language-matched
   ───────────────────────────────────────────────────────────── */
async function generateReply({ state, language, session, promiseDate, isRetry }) {
  const sys = `You are a polite but firm loan recovery voice agent for ${session.bankName || "an Indian bank"}.

HARD RULES (never violate):
- NEVER ask for an OTP, account number, card number, CVV, password, PIN, or "last 4 digits".
- NEVER offer a loan waiver, discount, settlement, or any amount change.
- NEVER state any amount other than the figures provided to you in the user instruction.
- NEVER threaten, harass, or use aggressive language.
- Speak like a human bank recovery officer — natural, calm, respectful, brief.
- Keep replies SHORT: 1 to 2 sentences, max 25 words.
- Speak in the user's language: "${language}".
  - "en"       → plain English
  - "hi"       → Hindi (Devanagari script ONLY)
  - "hinglish" → Hindi-in-Roman-script mixed naturally with English
- Output ONLY the spoken reply — no markdown, no quotes, no SSML, no labels.`;

  const promiseClause = promiseDate ? ` They committed to pay on: ${promiseDate}.` : "";

  const scripts = {
    [STATES.VERIFY_USER]: isRetry
      ? `I didn't catch that. Politely ask once more: am I speaking with ${session.customerName}? Yes or no.`
      : `Greet politely. Identify yourself as calling from ${session.bankName || "the bank"}'s loan recovery team regarding their loan account. Then ask if you are speaking with ${session.customerName} — yes or no. Do NOT ask for any account number, OTP, or last 4 digits.`,

    [STATES.INTRODUCE_LOAN]:
      `Thank them briefly for confirming. Inform them their EMI of ₹${session.emiAmount} is overdue by ${session.daysOverdue} days, and politely ask when they can make the payment. Two short sentences max.`,

    [STATES.ASK_PAYMENT]:
      `Politely ask when they will make the overdue payment of ₹${session.emiAmount}.`,

    [STATES.HANDLE_RESPONSE]:
      `The user's reply was unclear. Politely ask once more, briefly: when will they pay the overdue ₹${session.emiAmount}?`,

    [STATES.PAID]:
      `The user says they have already paid. Acknowledge politely, tell them you will verify and update records within 24 to 48 hours, thank them. Do NOT confirm receipt yourself.`,

    [STATES.PROMISE_TO_PAY]:
      `The user agreed to pay.${promiseClause} Confirm the commitment briefly, remind them the overdue amount is ₹${session.emiAmount}, thank them. Mark this as a payment commitment.`,

    [STATES.REFUSE]:
      `The user has refused to pay. Politely note the response. Tell them this will be recorded and a recovery officer will contact them, and offer to connect them with support if they want to discuss options. Do NOT threaten.`,

    [STATES.DISPUTE]:
      `The user disputes the loan or amount. Acknowledge their concern, tell them a recovery officer will review the account and call them within 24 hours. Do NOT confirm or deny the dispute.`,

    [STATES.ESCALATE]:
      `Politely tell the customer that a human agent will call them back shortly to assist further, then end.`,

    [STATES.END]:
      `Thank the customer politely and say goodbye. One short sentence.`,
  };

  const instruction = scripts[state] || scripts[STATES.END];

  const raw = await chat({
    messages: [
      { role: "system", content: sys },
      { role: "user",   content: instruction },
    ],
    temperature: 0.3,
  });

  return raw.trim().replace(/^["'`]+|["'`]+$/g, "").replace(/\*+/g, "");
}

/* helpers */
function safeParse(text, fallback) {
  if (!text) return fallback;
  try { return JSON.parse(text); }
  catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) { try { return JSON.parse(match[0]); } catch {} }
    return fallback;
  }
}

module.exports = { detectIntent, detectVerifyIntent, generateReply };
