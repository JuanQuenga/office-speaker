// Builds the Rust engine for this machine and copies it to engine/dist,
// where electron-builder picks it up. CI builds macOS universal binaries itself.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const engineDir = join(root, "engine");
const exe = process.platform === "win32" ? "speaker-engine.exe" : "speaker-engine";
const cargoHome = process.env.CARGO_HOME ?? join(homedir(), ".cargo");
const cargo = process.env.CARGO ?? (process.env.PATH?.includes(".cargo") ? "cargo" : join(cargoHome, "bin", "cargo"));

execFileSync(cargo, ["build", "--release", "--locked"], { cwd: engineDir, stdio: "inherit" });
mkdirSync(join(engineDir, "dist"), { recursive: true });
copyFileSync(join(engineDir, "target", "release", exe), join(engineDir, "dist", exe));
console.log(`engine ready: engine/dist/${exe}`);
