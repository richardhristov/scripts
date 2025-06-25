#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env

import * as path from "jsr:@std/path";

// Platform types for coomer.su
const PLATFORMS = ["candfans", "fansly", "onlyfans"] as const;
type Platform = (typeof PLATFORMS)[number];

interface CoomerUser {
  platform: Platform;
  userId: string;
  directory: string;
}

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

function buildCoomerUrl(platform: Platform, userId: string): string {
  return `https://coomer.su/${platform}/user/${userId}`;
}

async function findCoomerUsers(baseDir: string): Promise<CoomerUser[]> {
  const users: CoomerUser[] = [];
  const safeBaseDir = validatePath(baseDir);

  // Check if gallery-dl/coomerparty exists
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

async function downloadUser(
  user: CoomerUser,
  baseDir: string,
  configPath: string
) {
  const url = buildCoomerUrl(user.platform, user.userId);
  console.log(`Downloading ${user.platform}/${user.userId} from ${url}`);

  try {
    const cmd = new Deno.Command("gallery-dl", {
      args: ["--config", configPath, url],
      cwd: baseDir,
      stdout: "inherit",
      stderr: "inherit",
    });

    const result = await cmd.output();

    if (result.success) {
      console.log(`✓ Successfully downloaded ${user.platform}/${user.userId}`);
    } else {
      console.error(`✗ Failed to download ${user.platform}/${user.userId}`);
    }
  } catch (e) {
    console.error(`✗ Error downloading ${user.platform}/${user.userId}:`, e);
  }
}

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
    const dirInfo = await Deno.stat(baseDir);
    if (!dirInfo.isDirectory) {
      console.error(`Error: ${baseDir} is not a directory`);
      Deno.exit(1);
    }

    // Get absolute path to config file (same directory as this script)
    const scriptDir = path.dirname(path.fromFileUrl(import.meta.url));
    const configPath = path.resolve(scriptDir, "gallery-dl.conf.json");

    // Check if config file exists
    try {
      await Deno.stat(configPath);
      // deno-lint-ignore no-unused-vars
    } catch (e) {
      console.error(`Error: gallery-dl.conf.json not found at ${configPath}`);
      Deno.exit(1);
    }

    console.log(`Using config file: ${configPath}`);
    console.log(`Processing directory: ${baseDir}`);

    // Find all coomer users
    const users = await findCoomerUsers(baseDir);

    if (users.length === 0) {
      console.log("No coomerparty users found in the directory structure");
      return;
    }

    console.log(`Found ${users.length} users to download:`);
    for (const user of users) {
      console.log(`  - ${user.platform}/${user.userId}`);
    }

    // Download each user serially
    console.log("\nStarting downloads...");
    for (const user of users) {
      await downloadUser(user, baseDir, configPath);
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

// Main execution
if (import.meta.main) {
  main();
}
