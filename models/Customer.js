const { Schema, model } = require("mongoose");

const CustomerSchema = new Schema({
  customerId:     { type: String, required: true, unique: true, index: true },
  name:           { type: String, required: true },
  phone:          { type: String, required: true, unique: true, index: true },
  language:       { type: String, enum: ["en", "hi", "hinglish"], default: "en" },
  riskLevel:      { type: String, enum: ["low", "medium", "high"], default: "medium" },
  lastCallStatus: { type: String, default: null },
}, { timestamps: true });

module.exports = model("Customer", CustomerSchema);
