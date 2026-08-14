#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";

import {
  ROOTLINE_ERROR_CODES,
  RootlineError,
  createRootlineError,
  createSnapshot,
  createSyncPlan,
  validateRootRelationship,
} from "@rootline/core";
import { NodeFileSystemAdapter, resolveConfig, type ApplyResult } from "./node-adapter.js";

export const EXIT_CODES = Object.freeze({ SUCCESS: 0, FAILURE: 1, USAGE: 2 });

class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

interface CliOptions {
  readonly source?: string | undefined;
  readonly target?: string | undefined;
  readonly dryRun: boolean;
  readonly verbose: boolean;
  readonly auto: boolean;
  readonly json: boolean;
  readonly configPath?: string | undefined;
  readonly help: boolean;
  readonly version: boolean;
}

export interface CliOutput {
  source?: { readonly entries: number; readonly skippedSymlinks: readonly string[] };
  target?: { readonly status: string; readonly entries?: number };
  plan?: { readonly fingerprint: string; readonly missing: readonly string[] };
  directories?: ApplyResult["directories"];
  cancelled?: boolean;
  error?: { readonly code: string; readonly message: string };
}

function version(): string {
  const packagePath = new URL("../package.json", import.meta.url);
  return (JSON.parse(readFileSync(packagePath, "utf8")) as { version: string }).version;
}

function usage(): string {
  return [
    "Usage: folder-sync <source> <target> [options]",
    "",
    "Options:",
    "  -d, --dry-run       Preview folders without creating them",
    "  -v, --verbose       Include scan details in text output",
    "  -a, --auto          Create every missing folder without prompts",
    "      --config <path> Read exclusions from this JSON file",
    "      --json          Emit one JSON document and never prompt",
    "      --version       Print the package version",
  ].join("\n");
}

function parseArguments(arguments_: readonly string[]): CliOptions {
  const positional: string[] = [];
  let dryRun = false;
  let verbose = false;
  let auto = false;
  let json = false;
  let configPath: string | undefined;
  let help = false;
  let showVersion = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (argument === "-d" || argument === "--dry-run") dryRun = true;
    else if (argument === "-v" || argument === "--verbose") verbose = true;
    else if (argument === "-a" || argument === "--auto") auto = true;
    else if (argument === "--json") json = true;
    else if (argument === "-h" || argument === "--help") help = true;
    else if (argument === "--version") showVersion = true;
    else if (argument === "--config") {
      const value = arguments_[index + 1];
      if (!value || value.startsWith("-")) throw configArgumentError();
      configPath = value;
      index += 1;
    } else if (argument.startsWith("-")) {
      throw new UsageError(`Unknown option: ${argument}`);
    } else {
      positional.push(argument);
    }
  }
  if (!help && !showVersion && positional.length !== 2) {
    throw new UsageError("Source and target arguments are required.");
  }
  return { source: positional[0], target: positional[1], dryRun, verbose, auto, json, configPath, help, version: showVersion };
}

function configArgumentError(): UsageError {
  return new UsageError("--config requires a path.");
}

async function confirm(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw createRootlineError({ code: ROOTLINE_ERROR_CODES.CANCELLED, message: "Interactive confirmation requires a terminal." });
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await readline.question(`${message} [Y/n] `)).trim().toLocaleLowerCase() !== "n";
  } finally {
    readline.close();
  }
}

export async function run(
  arguments_: readonly string[],
  cwd = process.cwd(),
  confirmOperation: (message: string) => Promise<boolean> = confirm,
): Promise<{ output: CliOutput; exitCode: number; text?: string }> {
  let options: CliOptions;
  try {
    options = parseArguments(arguments_);
    if (options.help) return { output: {}, exitCode: EXIT_CODES.SUCCESS, text: usage() };
    if (options.version) return { output: {}, exitCode: EXIT_CODES.SUCCESS, text: version() };

    const adapter = new NodeFileSystemAdapter();
    const config = await resolveConfig({ cwd, explicitPath: options.configPath });
    const { sourcePath, targetPath } = await adapter.validateRootPaths(
      resolve(cwd, options.source!),
      resolve(cwd, options.target!),
    );
    validateRootRelationship(sourcePath, targetPath, config.targetCaseSensitive);
    const source = await adapter.scanDirectories(sourcePath, config.exclusions, "source");
    let targetStatus = await adapter.ensureTarget(targetPath, options.dryRun || !options.auto);
    if (targetStatus === "would-create" && !options.dryRun && !options.json) {
      if (!(await confirmOperation("Create the missing target directory?"))) {
        return { output: { cancelled: true }, exitCode: EXIT_CODES.SUCCESS };
      }
      targetStatus = await adapter.ensureTarget(targetPath);
    }
    const target = targetStatus === "would-create"
      ? { snapshot: createSnapshot([]), skippedSymlinks: [] }
      : await adapter.scanDirectories(targetPath, config.exclusions, "target");
    const plan = createSyncPlan(source.snapshot, target.snapshot, config.targetCaseSensitive);
    const output: CliOutput = {
      source: { entries: source.snapshot.entries.length, skippedSymlinks: source.skippedSymlinks },
      target: { status: targetStatus, entries: target.snapshot.entries.length },
      plan: { fingerprint: plan.fingerprint, missing: plan.missing },
    };
    if (plan.missing.length === 0 || options.dryRun) {
      if (options.dryRun && targetStatus !== "would-create") {
        output.directories = plan.missing.map((relativePath) => ({ relativePath, status: "would-create" }));
      }
      return { output, exitCode: EXIT_CODES.SUCCESS };
    }
    if (!options.auto) {
      if (options.json) {
        return { output: { ...output, cancelled: true }, exitCode: EXIT_CODES.SUCCESS };
      }
      if (!(await confirmOperation(`Create ${plan.missing.length} missing folder(s)?`))) {
        return { output: { ...output, cancelled: true }, exitCode: EXIT_CODES.SUCCESS };
      }
    }
    const result = await adapter.applyDirectories(targetPath, plan, {
      exclusions: config.exclusions,
      sourcePath,
    });
    output.directories = result.directories;
    if (result.directories.some((directory) => directory.status === "failed")) {
      output.error = { code: ROOTLINE_ERROR_CODES.PARTIAL_FAILURE, message: "Some directories could not be created." };
      return { output, exitCode: EXIT_CODES.FAILURE };
    }
    return { output, exitCode: EXIT_CODES.SUCCESS };
  } catch (error: unknown) {
    const rootlineError = error instanceof RootlineError
      ? error
      : createRootlineError({
        code: ROOTLINE_ERROR_CODES.CONFIG_INVALID,
        message: error instanceof Error ? error.message : "Unexpected failure.",
      });
    return {
      output: { error: { code: rootlineError.code, message: rootlineError.message } },
      exitCode: error instanceof UsageError ? EXIT_CODES.USAGE : EXIT_CODES.FAILURE,
    };
  }
}

function printResult(result: { output: CliOutput; exitCode: number; text?: string }, json: boolean, verbose: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(result.output)}\n`);
    return;
  }
  if (result.text) {
    process.stdout.write(`${result.text}\n`);
  } else if (result.output.error) {
    process.stderr.write(`Error [${result.output.error.code}]: ${result.output.error.message}\n`);
  } else {
    if (verbose && result.output.source && result.output.target) {
      process.stdout.write(`Source entries: ${result.output.source.entries}\nTarget entries: ${result.output.target.entries ?? 0}\n`);
    }
    process.stdout.write(`${JSON.stringify(result.output, null, 2)}\n`);
  }
}

const invokedAsCommand = process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url));
if (invokedAsCommand) {
  const json = process.argv.includes("--json");
  const verbose = process.argv.includes("--verbose") || process.argv.includes("-v");
  run(process.argv.slice(2)).then((result) => {
    printResult(result, json, verbose);
    process.exitCode = result.exitCode;
  });
}
