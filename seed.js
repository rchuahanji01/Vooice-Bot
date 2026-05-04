/**
 * Seed dummy customers + loans for local development.
 * Usage: npm run seed
 */
const { connect, disconnect } = require("./db");
const Customer = require("./models/Customer");
const Loan = require("./models/Loan");

const today = new Date();
const daysAgo = (n) => new Date(today.getTime() - n * 86400000);

const customers = [
  {
    customerId: "CUST001",
    name: "Rakesh Chauhan",
    phone: "+918369262375",
    language: "hinglish",
    riskLevel: "high",
    lastCallStatus: null,
  },
  {
    customerId: "CUST002",
    name: "Priya Verma",
    phone: "+919821012345",
    language: "hi",
    riskLevel: "medium",
    lastCallStatus: "PROMISE_TO_PAY",
  },
  {
    customerId: "CUST003",
    name: "Arjun Mehta",
    phone: "+919900112233",
    language: "en",
    riskLevel: "low",
    lastCallStatus: "PAID",
  },
];

const loans = [
  {
    loanId: "LN001",
    customerId: "CUST001",
    loanAmount: 125000,
    emiAmount: 12500,
    dueDate: daysAgo(15),
    overdueDays: 15,
    status: "OVERDUE",
  },
  {
    loanId: "LN002",
    customerId: "CUST002",
    loanAmount: 75000,
    emiAmount: 7500,
    dueDate: daysAgo(7),
    overdueDays: 7,
    status: "OVERDUE",
  },
  {
    loanId: "LN003",
    customerId: "CUST003",
    loanAmount: 200000,
    emiAmount: 18000,
    dueDate: daysAgo(2),
    overdueDays: 2,
    status: "OVERDUE",
  },
];

async function main() {
  await connect();

  await Customer.deleteMany({ customerId: { $in: customers.map(c => c.customerId) } });
  await Loan.deleteMany({ loanId: { $in: loans.map(l => l.loanId) } });

  await Customer.insertMany(customers);
  await Loan.insertMany(loans);

  console.log(`[seed] inserted ${customers.length} customers, ${loans.length} loans`);
  for (const c of customers) {
    const l = loans.find(x => x.customerId === c.customerId);
    console.log(`  ${c.customerId}  ${c.name.padEnd(18)} ${c.phone}  →  ${l ? `EMI ₹${l.emiAmount} / ${l.overdueDays}d overdue` : "(no loan)"}`);
  }

  await disconnect();
}

main().catch((err) => {
  console.error("[seed] failed:", err);
  process.exit(1);
});
