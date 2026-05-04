const { Schema, model } = require("mongoose");

const LoanSchema = new Schema({
  loanId:      { type: String, required: true, unique: true, index: true },
  customerId:  { type: String, required: true, index: true },
  loanAmount:  { type: Number, required: true },
  emiAmount:   { type: Number, required: true },
  dueDate:     { type: Date,   required: true },
  overdueDays: { type: Number, default: 0 },
  status:      { type: String, enum: ["CURRENT", "OVERDUE", "CLOSED"], default: "OVERDUE" },
}, { timestamps: true });

module.exports = model("Loan", LoanSchema);
