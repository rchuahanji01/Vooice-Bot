const { Schema, model } = require("mongoose");

const TurnSchema = new Schema({
  role:   { type: String, enum: ["bot", "user"], required: true },
  state:  { type: String },
  text:   { type: String },
  intent: { type: String },
  ts:     { type: Date, default: Date.now },
}, { _id: false });

const CallLogSchema = new Schema({
  callId:        { type: String, required: true, unique: true, index: true },
  customerId:    { type: String, index: true },
  loanId:        { type: String, index: true },
  phone:         { type: String, index: true },
  conversation:  { type: [TurnSchema], default: [] },
  outcome:       {
    type: String,
    enum: [
      "PAID", "PROMISE_TO_PAY", "REFUSE", "DISPUTE",
      "ESCALATE", "UNREACHABLE", "WRONG_PERSON", "INCOMPLETE",
    ],
    default: "INCOMPLETE",
  },
  finalState:    { type: String },
  language:      { type: String },
  promiseDate:   { type: String, default: null },
  verified:      { type: Boolean, default: false },
  durationMs:    { type: Number, default: 0 },
}, { timestamps: true });

module.exports = model("CallLog", CallLogSchema);
