#!/usr/bin/env node
import { runCli } from "../server/cli.js";

try {
  const code = await runCli();
  process.exitCode = code;
} catch (caught) {
  console.error(caught instanceof Error ? caught.message : String(caught));
  process.exitCode = 1;
}
