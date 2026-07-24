import { unlinkSync, existsSync } from "fs";

// Remove stray lockfiles from other package managers
for (const file of ["package-lock.json", "yarn.lock"]) {
  if (existsSync(file)) unlinkSync(file);
}

// Enforce pnpm usage
const agent = process.env.npm_config_user_agent || "";
if (!agent.startsWith("pnpm")) {
  console.error("Use pnpm instead");
  process.exit(1);
}