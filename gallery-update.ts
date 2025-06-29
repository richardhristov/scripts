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

// New function to determine the scope and base directory
function determineScope(inputDir: string): {
  baseDir: string;
  scope: {
    coomerparty?: string | null;
    redgifs?: string | null;
    pornhub?: string | null;
  };
} {
  const normalizedDir = path.resolve(inputDir);
  const parts = normalizedDir.split("/");

  // Find gallery-dl in the path
  const galleryDlIndex = parts.findIndex((part) => part === "gallery-dl");
  if (galleryDlIndex === -1) {
    // No gallery-dl found, assume it's the base directory
    return {
      baseDir: normalizedDir,
      scope: {},
    };
  }

  // Determine base directory (everything up to and including gallery-dl)
  const baseDir = parts.slice(0, galleryDlIndex + 1).join("/");

  // Check what comes after gallery-dl
  const scope: {
    coomerparty?: string | null;
    redgifs?: string | null;
    pornhub?: string | null;
  } = {};

  if (parts.length > galleryDlIndex + 1) {
    const nextPart = parts[galleryDlIndex + 1];

    if (nextPart === "coomerparty") {
      scope.coomerparty =
        parts.length > galleryDlIndex + 2 ? parts[galleryDlIndex + 2] : null;
    } else if (nextPart === "redgifs") {
      scope.redgifs = "all";
    } else if (nextPart === "pornhub") {
      scope.pornhub = "all";
    }
  }

  return { baseDir, scope };
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

async function findCoomerUsers(
  baseDir: string,
  coomerpartyPath?: string,
  platformScope?: string | null
) {
  const users: { url: string; directory: string }[] = [];
  const safeBaseDir = validatePath(baseDir);

  // Determine the path to search
  let searchPath: string;
  if (coomerpartyPath) {
    searchPath = coomerpartyPath;
  } else {
    // Check if baseDir already ends with gallery-dl
    if (safeBaseDir.endsWith("gallery-dl")) {
      searchPath = path.join(safeBaseDir, "coomerparty");
    } else {
      searchPath = path.join(safeBaseDir, "gallery-dl", "coomerparty");
    }
  }

  try {
    const coomerpartyInfo = await Deno.stat(searchPath);
    if (!coomerpartyInfo.isDirectory) {
      console.log(`coomerparty is not a directory at ${searchPath}`);
      return users;
    }
    // deno-lint-ignore no-unused-vars
  } catch (e) {
    console.log(`coomerparty directory not found at ${searchPath}`);
    return users;
  }

  // If we have a specific platform scope, only search that platform
  if (platformScope) {
    const platformPath = path.join(searchPath, platformScope);
    try {
      const platformInfo = await Deno.stat(platformPath);
      if (!platformInfo.isDirectory) {
        console.log(`${platformScope} is not a directory at ${platformPath}`);
        return users;
      }
      // deno-lint-ignore no-unused-vars
    } catch (e) {
      console.log(`${platformScope} directory not found at ${platformPath}`);
      return users;
    }

    // Find user directories in this specific platform
    for await (const userEntry of Deno.readDir(platformPath)) {
      if (!userEntry.isDirectory) {
        continue;
      }
      users.push({
        url: buildCoomerUrl({
          platform: platformScope,
          userId: userEntry.name,
        }),
        directory: path.join(platformPath, userEntry.name),
      });
    }
  } else {
    // Iterate through platform directories
    for await (const platformEntry of Deno.readDir(searchPath)) {
      if (
        !platformEntry.isDirectory ||
        !["candfans", "fansly", "onlyfans"].includes(platformEntry.name)
      ) {
        continue;
      }
      const platform = platformEntry.name;
      const platformPath = path.join(searchPath, platformEntry.name);
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
  }

  return users;
}

function buildRedgifsUrl(args: { userId: string }) {
  return `https://www.redgifs.com/users/${args.userId}`;
}

async function findRedgifsUsers(baseDir: string, redgifsPath?: string) {
  const users: { url: string; directory: string }[] = [];
  const safeBaseDir = validatePath(baseDir);

  // Determine the path to search
  let searchPath: string;
  if (redgifsPath) {
    searchPath = redgifsPath;
  } else {
    // Check if baseDir already ends with gallery-dl
    if (safeBaseDir.endsWith("gallery-dl")) {
      searchPath = path.join(safeBaseDir, "redgifs");
    } else {
      searchPath = path.join(safeBaseDir, "gallery-dl", "redgifs");
    }
  }

  try {
    const redgifsInfo = await Deno.stat(searchPath);
    if (!redgifsInfo.isDirectory) {
      console.log(`redgifs is not a directory at ${searchPath}`);
      return users;
    }
    // deno-lint-ignore no-unused-vars
  } catch (e) {
    console.log(`redgifs directory not found at ${searchPath}`);
    return users;
  }
  // Look for Redgifs user directories directly under the search path
  for await (const entry of Deno.readDir(searchPath)) {
    if (!entry.isDirectory) {
      continue;
    }
    users.push({
      url: buildRedgifsUrl({ userId: entry.name }),
      directory: path.join(searchPath, entry.name),
    });
  }
  return users;
}

function buildPornhubUrl(args: { userId: string }) {
  return `https://www.pornhub.com/model/${args.userId}`;
}

async function findPornhubUsers(baseDir: string, pornhubPath?: string) {
  const users: { url: string; directory: string }[] = [];
  const safeBaseDir = validatePath(baseDir);

  // Determine the path to search
  let searchPath: string;
  if (pornhubPath) {
    searchPath = pornhubPath;
  } else {
    // Check if baseDir already ends with gallery-dl
    if (safeBaseDir.endsWith("gallery-dl")) {
      searchPath = path.join(safeBaseDir, "pornhub");
    } else {
      searchPath = path.join(safeBaseDir, "gallery-dl", "pornhub");
    }
  }

  try {
    const pornhubInfo = await Deno.stat(searchPath);
    if (!pornhubInfo.isDirectory) {
      console.log(`pornhub is not a directory at ${searchPath}`);
      return users;
    }
    // deno-lint-ignore no-unused-vars
  } catch (e) {
    console.log(`pornhub directory not found at ${searchPath}`);
    return users;
  }
  // Look for pornhub user directories directly under the search path
  for await (const entry of Deno.readDir(searchPath)) {
    if (!entry.isDirectory) {
      continue;
    }
    users.push({
      url: buildPornhubUrl({ userId: entry.name }),
      directory: path.join(searchPath, entry.name),
    });
  }
  return users;
}

async function downloadGalleryDlUser(args: {
  url: string;
  baseDir: string;
  configPath: string;
}) {
  // Determine the correct working directory (parent of gallery-dl)
  const workingDir = args.baseDir.endsWith("gallery-dl")
    ? path.dirname(args.baseDir)
    : args.baseDir;

  console.log(`gallery-dl: Downloading ${args.url} to ${workingDir}`);
  try {
    const cmd = new Deno.Command("gallery-dl", {
      args: ["--config", args.configPath, args.url],
      cwd: workingDir,
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
  const domain = new URL(args.url).hostname;
  let folder;
  if (domain.endsWith("pornhub.com")) {
    folder = "pornhub";
  }
  if (!folder) {
    throw new Error(`Unsupported domain: ${domain}`);
  }

  // Determine the correct working directory (parent of gallery-dl)
  const workingDir = args.baseDir.endsWith("gallery-dl")
    ? path.dirname(args.baseDir)
    : args.baseDir;

  console.log(`yt-dlp: Downloading ${args.url} to ${workingDir}`);
  try {
    const cmd = new Deno.Command("yt-dlp", {
      args: [
        "-o",
        `gallery-dl/${folder}/%(uploader_id)s/%(title)s.%(ext)s`,
        args.url,
      ],
      cwd: workingDir,
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

async function downloadUserList(args: {
  urls: string[];
  baseDir: string;
  configPath: string;
}) {
  const results = [];
  for (const url of args.urls) {
    const result = await downloadUser({
      url,
      baseDir: args.baseDir,
      configPath: args.configPath,
    });
    results.push(result);
  }
  return results;
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
  const inputDir = Deno.args[0];
  if (!inputDir) {
    console.error("Usage: gallery-update.ts <directory>");
    console.error("Examples:");
    console.error(
      "  gallery-update.ts /path/to/dir                    # Process all platforms"
    );
    console.error(
      "  gallery-update.ts /path/to/dir/gallery-dl         # Process all platforms"
    );
    console.error(
      "  gallery-update.ts /path/to/dir/gallery-dl/coomerparty  # Process only coomerparty"
    );
    console.error(
      "  gallery-update.ts /path/to/dir/gallery-dl/coomerparty/onlyfans  # Process only coomerparty onlyfans"
    );
    console.error(
      "  gallery-update.ts /path/to/dir/gallery-dl/redgifs # Process only redgifs"
    );
    console.error(
      "  gallery-update.ts /path/to/dir/gallery-dl/pornhub # Process only pornhub"
    );
    Deno.exit(1);
  }

  try {
    await checkDependencies();

    // Determine the scope and base directory
    const { baseDir, scope } = determineScope(inputDir);
    await validateBaseDirectory(baseDir);

    // Get absolute path to config file (same directory as this script)
    const scriptDir = path.dirname(path.fromFileUrl(import.meta.url));
    const configPath = path.resolve(scriptDir, "gallery-dl.conf.json");
    // Validate config file
    await validateConfig(configPath);

    console.log(`Using config file: ${configPath}`);
    console.log(`Base directory: ${baseDir}`);
    console.log(`Scope:`, scope);

    // Determine which platforms to process based on scope
    const shouldProcessCoomerparty =
      Object.keys(scope).length === 0 || scope.coomerparty !== undefined;
    const shouldProcessRedgifs =
      Object.keys(scope).length === 0 || scope.redgifs !== undefined;
    const shouldProcessPornhub =
      Object.keys(scope).length === 0 || scope.pornhub !== undefined;

    // Find users based on scope
    const findPromises = [];

    if (shouldProcessCoomerparty) {
      let coomerpartyPath: string | undefined;
      if (scope.coomerparty === null) {
        // We're at the coomerparty level
        coomerpartyPath = inputDir;
      } else if (scope.coomerparty) {
        // We're at a specific platform level
        coomerpartyPath = path.dirname(inputDir);
      }
      findPromises.push(
        findCoomerUsers(
          baseDir,
          coomerpartyPath,
          scope.coomerparty || undefined
        )
      );
    } else {
      findPromises.push(Promise.resolve([]));
    }

    if (shouldProcessRedgifs) {
      let redgifsPath: string | undefined;
      if (scope.redgifs === "all") {
        redgifsPath = inputDir;
      }
      findPromises.push(findRedgifsUsers(baseDir, redgifsPath));
    } else {
      findPromises.push(Promise.resolve([]));
    }

    if (shouldProcessPornhub) {
      let pornhubPath: string | undefined;
      if (scope.pornhub === "all") {
        pornhubPath = inputDir;
      }
      findPromises.push(findPornhubUsers(baseDir, pornhubPath));
    } else {
      findPromises.push(Promise.resolve([]));
    }

    const [coomerUsers, redgifsUsers, pornhubUsers] = await Promise.all(
      findPromises
    );

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
      console.log(`\nFound ${redgifsUsers.length} redgifs users to download:`);
      for (const user of redgifsUsers) {
        console.log(`  - ${user.url}`);
      }
    }
    if (pornhubUsers.length > 0) {
      console.log(`\nFound ${pornhubUsers.length} pornhub users to download:`);
      for (const user of pornhubUsers) {
        console.log(`  - ${user.url}`);
      }
    }

    // Download all users
    console.log("\nStarting downloads...");
    // Process platforms in parallel
    const downloadPromises = [
      downloadUserList({
        urls: shuffleArray(coomerUsers).map((user) => user.url),
        baseDir,
        configPath,
      }),
      downloadUserList({
        urls: shuffleArray(redgifsUsers).map((user) => user.url),
        baseDir,
        configPath,
      }),
      downloadUserList({
        urls: shuffleArray(pornhubUsers).map((user) => user.url),
        baseDir,
        configPath,
      }),
    ];
    // Execute promises in parallel and flatten the results
    const results = (await Promise.all(downloadPromises)).flat();
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
