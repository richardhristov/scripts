#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env

import * as path from "jsr:@std/path";

function validatePath(directory: string) {
  const normalizedPath = path.normalize(directory);
  if (normalizedPath.includes("..")) {
    throw new Error("Path traversal detected");
  }
  return normalizedPath;
}

function shuffleArray<T>(array: T[]): T[] {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
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

function buildCoomerUrl(args: { platform: string; userId: string }) {
  return `https://coomer.su/${args.platform}/user/${args.userId}`;
}

async function findCoomerUsers(baseDir: string) {
  const users: { url: string; directory: string }[] = [];
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
    if (
      !platformEntry.isDirectory ||
      !["candfans", "fansly", "onlyfans"].includes(platformEntry.name)
    ) {
      continue;
    }
    const platform = platformEntry.name;
    const platformPath = path.join(coomerpartyPath, platformEntry.name);
    // Find user directories in this platform
    for await (const userEntry of Deno.readDir(platformPath)) {
      if (!userEntry.isDirectory) {
        continue;
      }
      users.push({
        url: buildCoomerUrl({ platform, userId: userEntry.name }),
        directory: path.join(platformPath, userEntry.name),
      });
    }
  }
  return users;
}

function buildRedgifsUrl(args: { userId: string }) {
  return `https://www.redgifs.com/users/${args.userId}`;
}

async function findRedgifsUsers(baseDir: string) {
  const users: { url: string; directory: string }[] = [];
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
      url: buildRedgifsUrl({ userId: entry.name }),
      directory: path.join(redgifsPath, entry.name),
    });
  }
  return users;
}

function buildPornhubUrl(args: { userId: string }) {
  return `https://www.pornhub.com/model/${args.userId}`;
}

async function findPornhubUsers(baseDir: string) {
  const users: { url: string; directory: string }[] = [];
  const safeBaseDir = validatePath(baseDir);
  const pornhubPath = path.join(safeBaseDir, "gallery-dl", "pornhub");
  try {
    const pornhubInfo = await Deno.stat(pornhubPath);
    if (!pornhubInfo.isDirectory) {
      console.log(`gallery-dl/pornhub is not a directory in ${safeBaseDir}`);
      return users;
    }
    // deno-lint-ignore no-unused-vars
  } catch (e) {
    console.log(`gallery-dl/pornhub directory not found in ${safeBaseDir}`);
    return users;
  }
  // Look for pornhub user directories directly under gallery-dl/pornhub
  for await (const entry of Deno.readDir(pornhubPath)) {
    if (!entry.isDirectory) {
      continue;
    }
    users.push({
      url: buildPornhubUrl({ userId: entry.name }),
      directory: path.join(pornhubPath, entry.name),
    });
  }
  return users;
}

async function downloadGalleryDlUser(args: {
  url: string;
  baseDir: string;
  configPath: string;
}) {
  console.log(`gallery-dl: Downloading ${args.url} to ${args.baseDir}`);
  try {
    const cmd = new Deno.Command("gallery-dl", {
      args: ["--config", args.configPath, args.url],
      cwd: args.baseDir,
      stdout: "inherit",
      stderr: "inherit",
    });
    const result = await cmd.output();
    if (result.success) {
      console.log(`✓ Successfully downloaded ${args.url}`);
      return { success: true, user: args.url };
    } else {
      console.error(`✗ Failed to download ${args.url}`);
      return {
        success: false,
        url: args.url,
        error: "Command failed",
      };
    }
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    console.error(`✗ Error downloading ${args.url}:`, errorMsg);
    return { success: false, user: args.url, error: errorMsg };
  }
}

async function downloadYtDlpUser(args: { url: string; baseDir: string }) {
  const baseFolder = path.basename(args.baseDir);
  // Validate the baseFolder to prevent path traversal
  if (
    baseFolder.includes("..") ||
    baseFolder.includes("/") ||
    baseFolder.includes("\\")
  ) {
    throw new Error("Invalid base folder name detected");
  }
  console.log(`yt-dlp: Downloading ${args.url} to ${args.baseDir}`);
  try {
    const cmd = new Deno.Command("yt-dlp", {
      args: [
        "-o",
        `gallery-dl/${baseFolder}/%(uploader_id)s/%(title)s.%(ext)s`,
        args.url,
      ],
      cwd: args.baseDir,
      stdout: "inherit",
      stderr: "inherit",
    });
    const result = await cmd.output();
    if (result.success) {
      console.log(`✓ Successfully downloaded ${args.url}`);
      return { success: true, user: args.url };
    } else {
      console.error(`✗ Failed to download ${args.url}`);
      return {
        success: false,
        url: args.url,
        error: "Command failed",
      };
    }
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    console.error(`✗ Error downloading ${args.url}:`, errorMsg);
    return { success: false, user: args.url, error: errorMsg };
  }
}

async function downloadUser(args: {
  url: string;
  baseDir: string;
  configPath: string;
}) {
  const domain = new URL(args.url).hostname;
  if (domain.endsWith("pornhub.com")) {
    return await downloadYtDlpUser(args);
  }
  return await downloadGalleryDlUser(args);
}

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

async function main() {
  const baseDir = Deno.args[0];
  if (!baseDir) {
    console.error("Usage: gallery-update.ts <directory>");
    console.error("The directory should contain a gallery-dl directory");
    Deno.exit(1);
  }
  try {
    await checkDependencies();
    await validateBaseDirectory(baseDir);
    // Get absolute path to config file (same directory as this script)
    const scriptDir = path.dirname(path.fromFileUrl(import.meta.url));
    const configPath = path.resolve(scriptDir, "gallery-dl.conf.json");
    // Validate config file
    await validateConfig(configPath);
    console.log(`Using config file: ${configPath}`);
    console.log(`Processing directory: ${baseDir}`);
    // Find all users
    const [coomerUsers, redgifsUsers, pornhubUsers] = await Promise.all([
      findCoomerUsers(baseDir),
      findRedgifsUsers(baseDir),
      findPornhubUsers(baseDir),
    ]);
    // Display found users
    if (coomerUsers.length > 0) {
      console.log(
        `\nFound ${coomerUsers.length} coomerparty users to download:`
      );
      for (const user of coomerUsers) {
        console.log(`  - ${user.url}`);
      }
    }
    if (redgifsUsers.length > 0) {
      console.log(`\nFound ${redgifsUsers.length} Redgifs users to download:`);
      for (const user of redgifsUsers) {
        console.log(`  - ${user.url}`);
      }
    }
    if (pornhubUsers.length > 0) {
      console.log(`\nFound ${pornhubUsers.length} Pornhub users to download:`);
      for (const user of pornhubUsers) {
        console.log(`  - ${user.url}`);
      }
    }
    // Download all users
    console.log("\nStarting downloads...");
    // Shuffle users for random download order
    const shuffledUsers = shuffleArray([
      ...coomerUsers,
      ...redgifsUsers,
      ...pornhubUsers,
    ]);
    if (shuffledUsers.length === 0) {
      console.log("No users to download");
      return;
    }
    const results = [];
    // Download users
    for (const user of shuffledUsers) {
      const result = await downloadUser({
        url: user.url,
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

if (import.meta.main) {
  main();
}
