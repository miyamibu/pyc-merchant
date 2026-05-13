import { spawn } from "node:child_process";

function runCommand(cmd, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    proc.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    proc.once("exit", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`command failed (${cmd} ${args.join(" ")}):\n${stdout}\n${stderr}`));
      }
    });
  });
}

const smoke = await runCommand("node", ["scripts/smoke-test.mjs"]);

let smokeSummary = null;
try {
  smokeSummary = JSON.parse(smoke.stdout);
} catch (_error) {
  smokeSummary = { raw_stdout: smoke.stdout.trim() };
}

const requiredRealPaymentEnv = [
  "REAL_PAYMENT_MODE",
  "REAL_PAYMENT_STORE_NAME",
  "REAL_PAYMENT_WALLET_NAME",
  "REAL_PAYMENT_DEVICE_CLASS",
  "REAL_PAYMENT_OPERATOR",
];

const missingRealPaymentEnv = requiredRealPaymentEnv.filter((key) => !String(process.env[key] || "").trim());
const realPayment = process.env.REAL_PAYMENT_MODE === "1"
  ? (
      missingRealPaymentEnv.length > 0
        ? {
            status: "external_pending",
            missing_env: missingRealPaymentEnv,
            reason: "実JPYC少額決済は外部ウォレット操作と実機環境が必要",
          }
        : {
            status: "external_pending",
            reason: "REAL_PAYMENT_MODE=1 だが、送金実行そのものは利用者ウォレット側の手動操作が必要",
          }
    )
  : {
      status: "external_pending",
      reason: "REAL_PAYMENT_MODE=1 を有効化していないため、実JPYC少額決済は未実行",
    };

console.log(
  JSON.stringify(
    {
      status: "pass",
      smoke: smokeSummary,
      real_payment: realPayment,
    },
    null,
    2
  )
);
