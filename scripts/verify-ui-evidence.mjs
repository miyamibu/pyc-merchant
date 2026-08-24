import { fileURLToPath } from "node:url";
import path from "node:path";
import { verifyCiEvidenceDirectory } from "./ui-evidence-contract.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

function sanitizeMessage(message) {
  if (typeof message !== "string") message = String(message ?? "");
  let sanitized = message
    .replace(/[\r\n\t\f\v\0-\x1F\x7F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (sanitized.length > 1024) {
    sanitized = sanitized.slice(0, 1024);
  }
  return sanitized || "verification failed";
}

function normalizeCode(code) {
  if (typeof code !== "string" || code.trim().length === 0) {
    return "UI_EVIDENCE_VERIFY_FAILED";
  }
  const normalized = code.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  return normalized || "UI_EVIDENCE_VERIFY_FAILED";
}

export async function runUiEvidenceVerificationCli({
  root = ROOT,
  env = process.env,
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr,
  verifier = verifyCiEvidenceDirectory,
  nowMs = Date.now(),
} = {}) {
  let evidenceDir = "";
  let seenEvidenceDirFlag = false;

  try {
    if (argv.length === 0) {
      const error = new Error("--evidence-dir が必要です。");
      error.code = "MISSING_EVIDENCE_DIR_FLAG";
      throw error;
    }

    for (let index = 0; index < argv.length; index += 1) {
      const arg = argv[index];
      if (arg === "--evidence-dir") {
        if (seenEvidenceDirFlag) {
          const error = new Error("--evidence-dir 指定は 1 回のみ許可されます。");
          error.code = "DUPLICATE_EVIDENCE_DIR_FLAG";
          throw error;
        }
        if (index + 1 >= argv.length) {
          const error = new Error("--evidence-dir には値が必要です。");
          error.code = "MISSING_EVIDENCE_DIR_VALUE";
          throw error;
        }
        const value = argv[index + 1].trim();
        if (value.length === 0) {
          const error = new Error("--evidence-dir の値が空です。");
          error.code = "EMPTY_EVIDENCE_DIR_VALUE";
          throw error;
        }
        evidenceDir = value;
        seenEvidenceDirFlag = true;
        index += 1;
      } else if (arg.startsWith("--evidence-dir=")) {
        if (seenEvidenceDirFlag) {
          const error = new Error("--evidence-dir 指定は 1 回のみ許可されます。");
          error.code = "DUPLICATE_EVIDENCE_DIR_FLAG";
          throw error;
        }
        const value = arg.slice("--evidence-dir=".length).trim();
        if (value.length === 0) {
          const error = new Error("--evidence-dir の値が空です。");
          error.code = "EMPTY_EVIDENCE_DIR_VALUE";
          throw error;
        }
        evidenceDir = value;
        seenEvidenceDirFlag = true;
      } else if (arg.startsWith("--")) {
        const error = new Error(`未知の引数です: ${arg}`);
        error.code = "UNKNOWN_ARGUMENT";
        throw error;
      } else {
        const error = new Error(`未知の引数です: ${arg}`);
        error.code = "UNKNOWN_ARGUMENT";
        throw error;
      }
    }

    if (!seenEvidenceDirFlag) {
      const error = new Error("--evidence-dir が必要です。");
      error.code = "MISSING_EVIDENCE_DIR_FLAG";
      throw error;
    }

    const result = await verifier({ root, env, evidenceDir, nowMs });
    const output = {
      ok: true,
      status: "passed",
      evidence_directory: result.evidenceDirectory,
      relative_evidence_directory: result.relativeEvidenceDirectory,
    };
    stdout.write(JSON.stringify(output) + "\n");
    return 0;
  } catch (error) {
    const code = normalizeCode(error?.code);
    const message = sanitizeMessage(error?.message);
    const output = {
      ok: false,
      code,
      message,
    };
    stderr.write(JSON.stringify(output) + "\n");
    return 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  runUiEvidenceVerificationCli()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      const code = normalizeCode(error?.code);
      const message = sanitizeMessage(error?.message);
      const output = { ok: false, code, message };
      process.stderr.write(JSON.stringify(output) + "\n");
      process.exitCode = 1;
    });
}