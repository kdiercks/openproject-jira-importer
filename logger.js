const fs = require("fs");
const path = require("path");

const logDir = path.join(__dirname, "logs");
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const logFile = path.join(logDir, `migration-${Date.now()}.log`);
const logStream = fs.createWriteStream(logFile, { flags: "a" });

const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

console.log = (...args) => {
  const message = args.join(" ") + "\n";
  logStream.write(message);
  process.stderr.write(message);
};

console.error = (...args) => {
  const message = args.join(" ") + "\n";
  logStream.write(`[ERROR] ${message}`);
  originalError(...args);
};

console.warn = (...args) => {
  const message = args.join(" ") + "\n";
  logStream.write(`[WARN] ${message}`);
  originalWarn(...args);
};

process.on("exit", () => {
  logStream.end();
});

process.on("uncaughtException", (err) => {
  logStream.write(`[UNCAUGHT] ${err.stack}\n`);
  logStream.end();
  process.exit(1);
});

originalLog(`Logging to ${logFile}`);
