# Loan Recovery Voice Bot

Production-style outbound voice bot for loan recovery. Multilingual (English / Hindi / Hinglish), state-machine controlled, MongoDB-backed customer + loan data, AI used only for intent classification and worded responses.

**Behaviour rules (strict, enforced in code):**
- Sounds like a human bank recovery officer — polite, brief, firm.
- Verifies by **name only** (yes / no). Never asks for OTP, account number, card number, CVV, PIN, or "last 4 digits".
- Never offers a waiver, discount, settlement, or amount change.
- Every call is logged to MongoDB for analytics.

## How it works

```
   POST /call (phone)        ┌─────── /voice ───────┐
       │                     │                       │
       ▼                     ▼                       │
 Mongo: lookup customer + loan → place Twilio call
                                 ──► <Play> greeting (Sarvam TTS)
                                 ──► <Gather speech>
                                          │
            caller speaks ────────────────┘
                                          ▼
                                      /process
                                          │
                ┌─────────────────────────┼─────────────────────────┐
                ▼                         ▼                         ▼
        Sarvam STT                 Groq classify             State machine
        (transcript)              intent → JSON              picks next state
                                                                  │
                                                                  ▼
                                                          Groq generate reply
                                                          (controlled, in lang)
                                                                  │
                                                                  ▼
                                                          Sarvam TTS → WAV
                                                                  │
                                                                  ▼
                                                  TwiML <Play> + <Gather>
                                                       (next turn)
                                                                  │
                                              call ends → /status saves CallLog to Mongo
```

The state machine in `stateMachine.js` is the only thing that decides "what happens next." The LLM gets two narrow jobs:

1. **Classify** what the caller said into a fixed set of intents — strict JSON.
2. **Generate** the wording of the bot's reply, in the caller's detected language, with hard rules in the system prompt (no waivers, no amount changes, no OTP/account asks, ≤2 sentences).

This is the safety boundary — the LLM cannot waive a loan, change the amount, hang up, or escalate. Those are all expressed as state transitions in code.

## States

```
START → VERIFY_USER ──VERIFIED──► INTRODUCE_LOAN ──► ASK_PAYMENT
              │                                          │
              │                                          ▼
              │                                  HANDLE_RESPONSE
              │                                          │
              │                  ┌──────┬───────┬────────┴──────┬──────┐
              │                  ▼      ▼       ▼               ▼      ▼
              │                PAID  PROMISE_  REFUSE        DISPUTE  (UNKNOWN→retry)
              │                      TO_PAY      │              │
              ▼                  │       │       │              │
         ESCALATE  ────────────► └───────┴───────┴────► END ◄───┘
        (after MAX_RETRIES UNKNOWN intents OR wrong person)
```

## MongoDB collections

### `customers`
```json
{
  "customerId":     "CUST001",
  "name":           "Rakesh Chauhan",
  "phone":          "+918369262375",
  "language":       "hinglish",
  "riskLevel":      "high",
  "lastCallStatus": "PROMISE_TO_PAY"
}
```

### `loans`
```json
{
  "loanId":      "LN001",
  "customerId":  "CUST001",
  "loanAmount":  125000,
  "emiAmount":   12500,
  "dueDate":     "2024-04-13T00:00:00.000Z",
  "overdueDays": 15,
  "status":      "OVERDUE"
}
```

### `callLogs`
```json
{
  "callId":      "CAxxxxxxxxxxxxxxxx",
  "customerId":  "CUST001",
  "loanId":      "LN001",
  "phone":       "+918369262375",
  "conversation": [
    { "role": "bot",  "state": "VERIFY_USER",     "text": "Hello, ..." },
    { "role": "user", "state": "VERIFY_USER",     "text": "yes" },
    { "role": "bot",  "state": "INTRODUCE_LOAN",  "text": "Your EMI of ₹12,500 ..." },
    { "role": "user", "state": "ASK_PAYMENT",     "text": "kal kar dunga" },
    { "role": "bot",  "state": "PROMISE_TO_PAY",  "text": "Theek hai, ..." }
  ],
  "outcome":     "PROMISE_TO_PAY",
  "promiseDate": "kal",
  "verified":    true,
  "language":    "hinglish",
  "durationMs":  47210,
  "createdAt":   "2026-04-28T08:32:11.420Z"
}
```

Outcomes: `PAID` · `PROMISE_TO_PAY` · `REFUSE` · `DISPUTE` · `ESCALATE` · `WRONG_PERSON` · `UNREACHABLE` · `INCOMPLETE`.

## Setup

### 1. Prereqs

- Node 18+
- MongoDB 6+ (local `mongod`, Docker, or MongoDB Atlas connection string)
- Twilio account with one verified phone number (trial works)
- Groq API key
- Sarvam AI API key (TTS + STT enabled)
- `ngrok` installed

### 2. Install

```bash
npm install
cp .env.example .env
# Fill in MONGODB_URI, GROQ_API_KEY, SARVAM_API_KEY, TWILIO_*, BANK_NAME
```

### 3. Seed dummy data

```bash
npm run seed
```

You should see:
```
[db] connected → mongodb://127.0.0.1:27017/loanbot
[seed] inserted 3 customers, 3 loans
  CUST001  Rakesh Chauhan     +918369262375  →  EMI ₹12500 / 15d overdue
  CUST002  Priya Verma        +919821012345  →  EMI ₹7500  / 7d overdue
  CUST003  Arjun Mehta        +919900112233  →  EMI ₹18000 / 2d overdue
```

### 4. Start ngrok

```bash
ngrok http 3000
```

Copy the `https://xxxx.ngrok-free.app` URL into `.env` as `PUBLIC_BASE_URL` (no trailing slash).

### 5. Configure your Twilio number's webhook (only for inbound calls)

Twilio Console → Phone Numbers → your number → Voice Configuration:

- **A call comes in** → Webhook → `https://xxxx.ngrok-free.app/voice` → HTTP POST

For **outbound** calls triggered by `/call`, just having `PUBLIC_BASE_URL` in `.env` is enough — Twilio uses that URL when placing the call.

### 6. Run

```bash
npm start
```

You should see:
```
[db] connected → mongodb://127.0.0.1:27017/loanbot
[server] listening on :3000
[server] PUBLIC_BASE_URL: https://xxxx.ngrok-free.app
[server] Bank:            HDFC Bank
[server] Groq model:      llama-3.3-70b-versatile
[server] Sarvam model:    sarvam-m
```

### 7. Trigger an outbound call

The body is just the phone number — the backend looks up the customer + loan from Mongo. **No PII in the request.**

```bash
curl -X POST http://localhost:3000/call \
  -H "Content-Type: application/json" \
  -d '{ "phone": "+918369262375" }'
```

Response:
```json
{
  "ok": true,
  "callSid": "CAxxxxxxxxxxxxxxxx",
  "to": "+918369262375",
  "status": "queued",
  "customer": { "customerId": "CUST001", "name": "Rakesh Chauhan" },
  "loan":     { "loanId": "LN001", "emiAmount": 12500, "overdueDays": 15 }
}
```

`phone` must be in E.164 format. **On a Twilio trial account the number must be verified in Verified Caller IDs first.** Otherwise the call will be rejected.

## Demo conversation

```
BOT (en):   Hello, this is calling from HDFC Bank's loan recovery team.
            Am I speaking with Rakesh Chauhan?
USER (en):  yes
BOT (hin):  Shukriya. Aapki EMI of ₹12,500 fifteen days se overdue hai —
            kab tak payment kar sakte hain?
USER:       kal kar dunga
[Sarvam STT detects: language=hinglish, transcript="kal kar dunga"]
[Groq classifies: intent=WILL_PAY, language=hinglish, promise_date="kal"]
[State: ASK_PAYMENT → PROMISE_TO_PAY]
BOT (hin):  Theek hai, kal payment ke liye dhanyavaad. Aapka due
            amount ₹12,500 hai. Shukriya.
[CALL ENDS]
[CallLog saved to MongoDB → outcome=PROMISE_TO_PAY, promiseDate="kal"]
```

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/call`              | Trigger outbound call. Body: `{ phone }` |
| GET  | `/customer/:phone`   | Fetch customer + their loan(s) |
| GET  | `/calllogs`          | Recent call logs. Query: `?customerId=…&phone=…&limit=20` |
| POST | `/voice`             | Twilio webhook for incoming/answered calls |
| POST | `/process`           | Twilio webhook for each speech turn |
| POST | `/status`            | Twilio call-status callback (persists CallLog) |
| GET  | `/sessions/:callSid` | Inspect live in-memory session state + transcript |
| GET  | `/health`            | Health check (includes Mongo connection state) |
| GET  | `/audio/:file`       | Static — serves Sarvam TTS files for `<Play>` |

## Sample curl requests

```bash
# Look up a customer + their loan
curl http://localhost:3000/customer/+918369262375

# Trigger an outbound recovery call
curl -X POST http://localhost:3000/call \
  -H "Content-Type: application/json" \
  -d '{ "phone": "+918369262375" }'

# Inspect a live session mid-call
curl http://localhost:3000/sessions/CAxxxxxxxxxxxxxxxx

# Fetch the most recent call logs for a customer
curl "http://localhost:3000/calllogs?customerId=CUST001&limit=10"

# Health
curl http://localhost:3000/health
```

## How multi-language works

- Customer's preferred `language` from MongoDB seeds the session, so the **first turn** can already be in their language.
- Sarvam STT auto-detects language on each user turn (`en-IN` / `hi-IN`). We further classify Hinglish vs Hindi by checking whether the transcript contains Roman characters.
- Groq is told the detected language in the system prompt and generates the reply accordingly:
  - `en` → plain English
  - `hi` → Hindi (Devanagari script only)
  - `hinglish` → Hindi-in-Roman + English mixed
- Sarvam TTS synthesizes the reply with the matching voice (`hi-IN` for both `hi` and `hinglish` — Sarvam reads Roman Hindi correctly under that locale).

## Speech recognition: Sarvam STT vs Twilio Gather

The call requires both Sarvam STT *and* `<Gather input="speech">`. We satisfy both:

1. **Twilio's `<Gather speech>`** is used for end-of-speech detection and turn-taking — it's better than `<Record>` at knowing when the caller has stopped speaking.
2. **Sarvam STT** is used for the actual transcript when a recording is available (better Indic-language accuracy).
3. If Sarvam STT fails or returns empty, we fall back to Twilio's built-in `SpeechResult`.

You can swap to a pure `<Record>` flow by replacing `buildGatherResponse` with `buildRecordResponse` in `routes/voice.js` and `routes/process.js`. That maximizes Sarvam STT accuracy at the cost of slightly higher per-turn latency.

## Audio format

Sarvam TTS returns 22050 Hz 16-bit PCM WAV. Twilio's `<Play>` accepts WAV directly and resamples server-side to telephony 8 kHz µ-law. No client-side conversion needed for the demo. For sub-second production latency, pre-encode to µ-law 8 kHz with ffmpeg before serving.

## Configuration

| Var                  | Default                                       | Effect |
|----------------------|-----------------------------------------------|--------|
| `MONGODB_URI`        | `mongodb://127.0.0.1:27017/loanbot`           | Mongo connection string |
| `BANK_NAME`          | `HDFC Bank`                                   | Spoken in greeting |
| `MAX_RETRIES`        | `3`                                           | UNKNOWN intents allowed before ESCALATE |
| `LLM_MODEL`          | `llama-3.3-70b-versatile`                     | Groq model |
| `SARVAM_MODEL`       | `sarvam-m`                                    | Sarvam model preference |

## Outcomes & logging

Every completed call writes a `callLogs` document with:

- `outcome` — `PAID`, `PROMISE_TO_PAY`, `REFUSE`, `DISPUTE`, `ESCALATE`, `WRONG_PERSON`, `UNREACHABLE`, `INCOMPLETE`
- `conversation` — full turn-by-turn transcript (role, state, text, intent)
- `promiseDate` — extracted by Groq when intent=WILL_PAY
- `verified` — whether the customer confirmed identity
- `durationMs`

The customer's `lastCallStatus` is also updated on every call so the next-best-action layer has fresh context.

## Troubleshooting

**"MongoDB connect failed"** — make sure `mongod` is running locally (`mongod --dbpath ...`) or your `MONGODB_URI` points at a reachable Atlas cluster.

**"no customer found for phone"** — `npm run seed` first, and use one of the seeded phones (or insert your own).

**"Twilio call is silent"** — `PUBLIC_BASE_URL` doesn't match your live ngrok URL. ngrok generates a new URL each restart unless you have a paid static domain.

**"Bot replies in English even though I spoke Hindi"** — Check the customer's `language` field in MongoDB and the `[process] Sarvam STT` logs for the detected language.

**"Sarvam TTS returns no audio"** — Falls back to Twilio's `<Say>` (Polly Aditi voice) so the call won't go silent. Check `SARVAM_API_KEY` and account TTS access.

**"Trial account: number not verified"** — On Twilio trial you can only call numbers added to Verified Caller IDs. Add the test number in Twilio Console.

**"Intent is always UNKNOWN"** — Check `[process] Sarvam STT` — if the transcript is empty, the recording isn't being captured. Verify ngrok is forwarding HTTPS correctly.

## Project structure

```
loanbot/
├── server.js                 Express bootstrap, /call /customer /calllogs /health /sessions
├── config.js                 Env loader
├── db.js                     Mongoose connect helper
├── stateMachine.js           Pure transition logic (no I/O, no AI)
├── sessionStore.js           In-memory CallSid → live session
├── seed.js                   Insert dummy customers + loans
├── models/
│   ├── Customer.js           Mongoose schema
│   ├── Loan.js               Mongoose schema
│   └── CallLog.js            Mongoose schema (full transcript + outcome)
├── routes/
│   ├── voice.js              POST /voice + /status (persists CallLog)
│   └── process.js            POST /process — per-turn pipeline
├── services/
│   ├── llm.js                Groq: detectIntent + detectVerifyIntent + generateReply
│   ├── sarvam.js             Sarvam TTS + STT (Twilio recording → transcript)
│   └── twilio.js             TwiML builders + outbound call helper
├── public/audio/             Generated TTS files (auto-cleaned every minute)
├── .env.example
├── .gitignore
├── package.json
└── README.md
```

## Production notes

- Move `sessionStore` to Redis (Twilio retries can land on a different pod).
- Add Twilio webhook signature validation (`twilio.webhook()` middleware).
- Persist transcripts to a CRM / S3 in addition to Mongo (RBI mandates call recording for collections).
- Rate-limit `/call` and add auth — public endpoint shouldn't let anyone trigger calls.
- For sub-second latency, switch to Twilio Media Streams + Sarvam Streaming TTS.
- Replace name-only verification with a strong second factor handled via a SECURE channel (SMS-link or app push), never asked over the phone — RBI / fraud guidelines forbid asking for OTP / account digits on outbound recovery calls.
# Vooice-Bot
