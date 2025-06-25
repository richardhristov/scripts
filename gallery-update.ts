#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env

import * as path from "jsr:@std/path";

// ============================================================================
// TYPES AND INTERFACES
// ============================================================================

// Platform types for coomer.su
const PLATFORMS = ["candfans", "fansly", "onlyfans"] as const;
type Platform = (typeof PLATFORMS)[number];

interface CoomerUser {
  platform: Platform;
  userId: string;
  directory: string;
}

interface RedgifsUser {
  userId: string;
  directory: string;
}

interface DownloadResult {
  success: boolean;
  user: string;
  error?: string;
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function validatePath(directory: string) {
  const normalizedPath = path.normalize(directory);
  if (normalizedPath.includes("..")) {
    throw new Error("Path traversal detected");
  }
  return normalizedPath;
}

function isPlatformDir(dirName: string): dirName is Platform {
  return PLATFORMS.includes(dirName as Platform);
}

function buildCoomerUrl(args: { platform: Platform; userId: string }) {
  return `https://coomer.su/${args.platform}/user/${args.userId}`;
}

function buildRedgifsUrl(args: { userId: string }) {
  return `https://www.redgifs.com/users/${args.userId}`;
}

// ============================================================================
// DEPENDENCY CHECKING
// ============================================================================

async function checkDependencies() {
  try {
    const checkCmd = new Deno.Command("gallery-dl", {
      args: ["--version"],
      stdout: "piped",
      stderr: "piped",
    });
    await checkCmd.output();
    // deno-lint-ignore no-unused-vars
  } catch (e) {
    console.error("Error: gallery-dl is not installed or not in PATH");
    console.error("Please install gallery-dl: pip install gallery-dl");
    Deno.exit(1);
  }
}

// ============================================================================
// USER DISCOVERY
// ============================================================================

async function findCoomerUsers(baseDir: string) {
  const users: CoomerUser[] = [];
  const safeBaseDir = validatePath(baseDir);
  const coomerpartyPath = path.join(safeBaseDir, "gallery-dl", "coomerparty");

  try {
    const coomerpartyInfo = await Deno.stat(coomerpartyPath);
    if (!coomerpartyInfo.isDirectory) {
      console.log(
        `gallery-dl/coomerparty is not a directory in ${safeBaseDir}`
      );
      return users;
    }
    // deno-lint-ignore no-unused-vars
  } catch (e) {
    console.log(`gallery-dl/coomerparty directory not found in ${safeBaseDir}`);
    return users;
  }

  // Iterate through platform directories
  for await (const platformEntry of Deno.readDir(coomerpartyPath)) {
    if (!platformEntry.isDirectory || !isPlatformDir(platformEntry.name)) {
      continue;
    }

    const platform = platformEntry.name as Platform;
    const platformPath = path.join(coomerpartyPath, platformEntry.name);

    // Find user directories in this platform
    for await (const userEntry of Deno.readDir(platformPath)) {
      if (!userEntry.isDirectory) {
        continue;
      }

      users.push({
        platform,
        userId: userEntry.name,
        directory: path.join(platformPath, userEntry.name),
      });
    }
  }

  return users;
}

async function findRedgifsUsers(baseDir: string) {
  const users: RedgifsUser[] = [];
  const safeBaseDir = validatePath(baseDir);
  const redgifsPath = path.join(safeBaseDir, "gallery-dl", "redgifs");

  try {
    const redgifsInfo = await Deno.stat(redgifsPath);
    if (!redgifsInfo.isDirectory) {
      console.log(`gallery-dl/redgifs is not a directory in ${safeBaseDir}`);
      return users;
    }
    // deno-lint-ignore no-unused-vars
  } catch (e) {
    console.log(`gallery-dl/redgifs directory not found in ${safeBaseDir}`);
    return users;
  }

  // Look for Redgifs user directories directly under gallery-dl/redgifs
  for await (const entry of Deno.readDir(redgifsPath)) {
    if (!entry.isDirectory) {
      continue;
    }

    users.push({
      userId: entry.name,
      directory: path.join(redgifsPath, entry.name),
    });
  }

  return users;
}

// ============================================================================
// DOWNLOAD FUNCTIONS
// ============================================================================

async function downloadUser(args: {
  url: string;
  userDisplay: string;
  baseDir: string;
  configPath: string;
}) {
  console.log(`Downloading ${args.userDisplay} from ${args.url}`);

  try {
    const cmd = new Deno.Command("gallery-dl", {
      args: ["--config", args.configPath, args.url],
      cwd: args.baseDir,
      stdout: "inherit",
      stderr: "inherit",
    });

    const result = await cmd.output();

    if (result.success) {
      console.log(`✓ Successfully downloaded ${args.userDisplay}`);
      return { success: true, user: args.userDisplay };
    } else {
      console.error(`✗ Failed to download ${args.userDisplay}`);
      return {
        success: false,
        user: args.userDisplay,
        error: "Command failed",
      };
    }
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    console.error(`✗ Error downloading ${args.userDisplay}:`, errorMsg);
    return { success: false, user: args.userDisplay, error: errorMsg };
  }
}

// ============================================================================
// CONFIGURATION VALIDATION
// ============================================================================

async function validateConfig(configPath: string) {
  try {
    await Deno.stat(configPath);
    // deno-lint-ignore no-unused-vars
  } catch (e) {
    console.error(`Error: gallery-dl.conf.json not found at ${configPath}`);
    Deno.exit(1);
  }
}

async function validateBaseDirectory(baseDir: string) {
  try {
    const dirInfo = await Deno.stat(baseDir);
    if (!dirInfo.isDirectory) {
      console.error(`Error: ${baseDir} is not a directory`);
      Deno.exit(1);
    }
    // deno-lint-ignore no-unused-vars
  } catch (e) {
    console.error(
      `Error: Directory ${baseDir} does not exist or is not accessible`
    );
    Deno.exit(1);
  }
}

// ============================================================================
// MAIN EXECUTION
// ============================================================================

async function main() {
  const baseDir = Deno.args[0];
  if (!baseDir) {
    console.error("Usage: gallery-update.ts <directory>");
    console.error("The directory should contain a gallery-dl directory");
    Deno.exit(1);
  }

  try {
    // Check dependencies
    await checkDependencies();

    // Validate base directory
    await validateBaseDirectory(baseDir);

    // Get absolute path to config file (same directory as this script)
    const scriptDir = path.dirname(path.fromFileUrl(import.meta.url));
    const configPath = path.resolve(scriptDir, "gallery-dl.conf.json");

    // Validate config file
    await validateConfig(configPath);

    console.log(`Using config file: ${configPath}`);
    console.log(`Processing directory: ${baseDir}`);

    // Find all users
    const [coomerUsers, redgifsUsers] = await Promise.all([
      findCoomerUsers(baseDir),
      findRedgifsUsers(baseDir),
    ]);

    if (coomerUsers.length === 0 && redgifsUsers.length === 0) {
      console.log(
        "No coomerparty or Redgifs users found in the directory structure"
      );
      return;
    }

    // Display found users
    if (coomerUsers.length > 0) {
      console.log(
        `\nFound ${coomerUsers.length} coomerparty users to download:`
      );
      for (const user of coomerUsers) {
        console.log(`  - ${user.platform}/${user.userId}`);
      }
    }

    if (redgifsUsers.length > 0) {
      console.log(`\nFound ${redgifsUsers.length} Redgifs users to download:`);
      for (const user of redgifsUsers) {
        console.log(`  - ${user.userId}`);
      }
    }

    // Download all users
    console.log("\nStarting downloads...");

    const results: DownloadResult[] = [];

    // Download coomer users
    for (const user of coomerUsers) {
      const result = await downloadUser({
        url: buildCoomerUrl({ platform: user.platform, userId: user.userId }),
        userDisplay: `${user.platform}/${user.userId}`,
        baseDir,
        configPath,
      });
      results.push(result);
    }

    // Download Redgifs users
    for (const user of redgifsUsers) {
      const result = await downloadUser({
        url: buildRedgifsUrl({ userId: user.userId }),
        userDisplay: user.userId,
        baseDir,
        configPath,
      });
      results.push(result);
    }

    // Summary
    const successful = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    console.log(`\nDownload Summary:`);
    console.log(`  ✓ Successful: ${successful}`);
    console.log(`  ✗ Failed: ${failed}`);

    if (failed > 0) {
      console.log("\nFailed downloads:");
      for (const result of results.filter((r) => !r.success)) {
        console.log(`  - ${result.user}: ${result.error}`);
      }
    }

    console.log("\nAll downloads completed!");
  } catch (e: unknown) {
    console.error(
      `Error processing directory: ${
        e instanceof Error ? e.message : String(e)
      }`
    );
    Deno.exit(1);
  }
}

// ============================================================================
// SCRIPT ENTRY POINT
// ============================================================================

if (import.meta.main) {
  main();
}
