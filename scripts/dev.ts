import { spawn } from "node:child_process";
const children = [
  ["--import", "tsx", "apps/api/src/main.ts"],
  ["--import", "tsx", "apps/worker/src/main.ts"],
  ["node_modules/vite/bin/vite.js", "--config", "apps/web/vite.config.ts"],
].map((args) =>
  spawn(process.execPath, args, { stdio: "inherit", env: process.env }),
);
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill("SIGTERM");
}
for (const child of children) {
  child.on("error", () => stop(1));
  child.on("exit", (code) => {
    if (!stopping) stop(code ?? 1);
  });
}
process.once("SIGINT", () => stop());
process.once("SIGTERM", () => stop());
