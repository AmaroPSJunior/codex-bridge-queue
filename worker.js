const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const DIR = path.join(process.env.HOME, "codex-bridge");
const INBOX = path.join(DIR, "inbox");
const OUTBOX = path.join(DIR, "outbox");

fs.mkdirSync(INBOX, { recursive: true });
fs.mkdirSync(OUTBOX, { recursive: true });

console.log("=== CODEX BRIDGE WORKER ===");
console.log("Aguardando comandos...");
console.log("Inbox:", INBOX);
console.log("Outbox:", OUTBOX);

let busy = false;

async function processQueue() {
  if (busy) return;

  const files = fs.readdirSync(INBOX)
    .filter(f => f.endsWith(".txt"))
    .sort();

  if (!files.length) return;

  busy = true;

  const file = files[0];
  const input = path.join(INBOX, file);
  const processing = input + ".processing";

  try {
    fs.renameSync(input, processing);

    const prompt = fs.readFileSync(processing, "utf8").trim();

    if (!prompt) {
      fs.unlinkSync(processing);
      busy = false;
      return;
    }

    console.log("\n[worker] Executando:", file);

    const child = spawn(
      path.join(process.env.PREFIX, "bin", "codex-bridge"),
      [prompt],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", d => {
      const s = d.toString();
      stdout += s;
      process.stdout.write(s);
    });

    child.stderr.on("data", d => {
      const s = d.toString();
      stderr += s;
      process.stderr.write(s);
    });

    child.on("close", code => {
      const result = [
        "EXIT_CODE=" + code,
        "",
        stdout,
        stderr ? "\n--- STDERR ---\n" + stderr : ""
      ].join("\n");

      fs.writeFileSync(
        path.join(OUTBOX, file),
        result
      );

      fs.unlinkSync(processing);

      console.log("\n[worker] Concluído:", file);
      console.log("[worker] Aguardando próximo comando...");

      busy = false;
    });

  } catch (e) {
    console.error("[worker]", e.message);

    try {
      if (fs.existsSync(processing))
        fs.renameSync(processing, input);
    } catch {}

    busy = false;
  }
}

setInterval(processQueue, 1000);
processQueue();
