const mongoose = require("mongoose");
const config = require("./config");

mongoose.set("strictQuery", true);

async function connect() {
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  await mongoose.connect(config.mongoUri, {
    serverSelectionTimeoutMS: 8000,
  });
  console.log(`[db] connected → ${config.mongoUri}`);
  return mongoose.connection;
}

async function disconnect() {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
}

module.exports = { connect, disconnect, mongoose };
