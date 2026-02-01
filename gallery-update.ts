#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env

import * as path from "jsr:@std/path@1.1.1";
import { parseArgs } from "jsr:@std/cli@1.0.21/parse-args";
import PQueue from "npm:p-queue@8.1.0";
import logUpdate from "npm:log-update@6.1.0";

// Download logger to manage active downloads display
interface DownloadInfo {
  newFiles?: number;
  errors?: number;
  detail: string;
  success?: boolean;
}

class DownloadLogger {
  private activeDownloads = new Map<string, DownloadInfo>();
  private completedDownloads = new Map<string, DownloadInfo>();
  private updateInterval: number | null = null;
  private totalDownloads = 0;
  private completedCount = 0;
  private totalNewFiles = 0;
  private totalErrors = 0;

  constructor() {
    // Start periodic updates
    this.updateInterval = setInterval(() => {
      this.updateDisplay();
    }, 100);
  }

  setTotalDownloads(total: number) {
    this.totalDownloads = total;
    this.completedCount = 0;
    this.totalNewFiles = 0;
    this.totalErrors = 0;
    this.completedDownloads.clear();
  }

  addDownload(url: string, initialMessage: string = "Starting...") {
    this.activeDownloads.set(url, { detail: initialMessage });
    this.updateDisplay();
  }

  updateDownload(url: string, info: DownloadInfo) {
    this.activeDownloads.set(url, info);
    this.updateDisplay();
  }

  removeDownload(url: string) {
    const info = this.activeDownloads.get(url) || { detail: "Completed" };
    this.activeDownloads.delete(url);
    this.completedDownloads.set(url, info);
    this.completedCount++;
    this.totalNewFiles += info.newFiles || 0;
    this.totalErrors += info.errors || 0;
    this.updateDisplay();
  }

  private updateDisplay() {
    const lines: string[] = [];

    // Add completed downloads section
    if (this.completedDownloads.size > 0) {
      lines.push("Completed:");
      const completedLines = Array.from(this.completedDownloads.entries()).map(
        ([url, info]) => {
          const shortUrl = this.getShortUrl(url);
          const status = info.success !== false ? "✓" : "✗";
          const stats =
            info.newFiles !== undefined && info.errors !== undefined
              ? `New: ${info.newFiles}, Err: ${info.errors}`
              : "";
          return stats
            ? `  ${status} [${shortUrl}] ${stats}`
            : `  ${status} [${shortUrl}]`;
        }
      );
      lines.push(...completedLines);
      lines.push(""); // Empty line for spacing
    }

    // Add progress header
    if (this.totalDownloads > 0) {
      const progress = this.completedCount;
      const percentage = Math.round((progress / this.totalDownloads) * 100);
      // Include counts from active downloads for real-time totals
      let activeNewFiles = 0;
      let activeErrors = 0;
      for (const info of this.activeDownloads.values()) {
        activeNewFiles += info.newFiles || 0;
        activeErrors += info.errors || 0;
      }
      const currentNewFiles = this.totalNewFiles + activeNewFiles;
      const currentErrors = this.totalErrors + activeErrors;
      lines.push(
        `Progress: ${progress}/${this.totalDownloads} (${percentage}%) - New: ${currentNewFiles}, Err: ${currentErrors}`
      );
      lines.push(""); // Empty line for spacing
    }

    // Add active downloads
    if (this.activeDownloads.size > 0) {
      for (const [url, info] of this.activeDownloads.entries()) {
        const shortUrl = this.getShortUrl(url);
        const stats =
          info.newFiles !== undefined && info.errors !== undefined
            ? `New: ${info.newFiles}, Err: ${info.errors}`
            : "";
        const header = stats ? `[${shortUrl}] ${stats}` : `[${shortUrl}]`;
        lines.push(header);
        if (info.detail) {
          lines.push(info.detail);
        }
      }
    }

    if (lines.length > 0) {
      logUpdate(lines.join("\n"));
    }
  }

  private getShortUrl(url: string): string {
    try {
      // Just remove the protocol (https://) and show the full URL
      return url.replace(/^https?:\/\//, "");
    } catch {
      return url;
    }
  }

  done() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    logUpdate.done();
  }

  clear() {
    this.activeDownloads.clear();
    this.completedDownloads.clear();
    logUpdate.clear();
  }
}

function validatePath(directory: string) {
  const normalizedPath = path.normalize(directory);
  if (normalizedPath.includes("..")) {
    throw new Error("Path traversal detected");
  }
  return normalizedPath;
}

// New function to determine the scope and base directory
function determineScope(inputDir: string): {
  baseDir: string;
  scope: {
    coomer?: string | null;
    kemono?: string | null;
    redgifs?: string | null;
    pornhub?: string | null;
    danbooru?: string | null;
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
    coomer?: string | null;
    kemono?: string | null;
    redgifs?: string | null;
    pornhub?: string | null;
    danbooru?: string | null;
  } = {};

  if (parts.length > galleryDlIndex + 1) {
    const nextPart = parts[galleryDlIndex + 1];

    if (nextPart === "coomer") {
      scope.coomer =
        parts.length > galleryDlIndex + 2 ? parts[galleryDlIndex + 2] : null;
    } else if (nextPart === "kemono") {
      scope.kemono =
        parts.length > galleryDlIndex + 2 ? parts[galleryDlIndex + 2] : null;
    } else if (nextPart === "redgifs") {
      scope.redgifs = "all";
    } else if (nextPart === "pornhub") {
      scope.pornhub = "all";
    } else if (nextPart === "danbooru") {
      scope.danbooru = "all";
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

// Service configuration for user discovery
interface ServiceConfig {
  name: string;
  buildUrl: (args: { platform?: string; userId: string }) => string;
  platforms?: string[]; // If defined, has platform subdirectories
}

const SERVICES = {
  coomer: {
    name: "coomer",
    buildUrl: ({ platform, userId }) =>
      `https://coomer.st/${platform}/user/${userId}`,
    platforms: ["candfans", "fansly", "onlyfans"],
  },
  kemono: {
    name: "kemono",
    buildUrl: ({ platform, userId }) =>
      `https://kemono.cr/${platform}/user/${userId}`,
    platforms: [
      "patreon",
      "fanbox",
      "gumroad",
      "subscribestar",
      "dlsite",
      "fantia",
    ],
  },
  redgifs: {
    name: "redgifs",
    buildUrl: ({ userId }) => `https://www.redgifs.com/users/${userId}`,
  },
  pornhub: {
    name: "pornhub",
    buildUrl: ({ userId }) => `https://www.pornhub.com/model/${userId}`,
  },
  danbooru: {
    name: "danbooru",
    buildUrl: ({ userId }) =>
      `https://danbooru.donmai.us/posts?tags=${encodeURIComponent(
        userId
      )}+&z=5`,
  },
} as const satisfies Record<string, ServiceConfig>;

type UserEntry = { url: string; directory: string; birthtime: number };

async function getDirectoryBirthtime(dir: string): Promise<number> {
  try {
    const stat = await Deno.stat(dir);
    return stat.birthtime?.getTime() ?? 0;
  } catch {
    return 0;
  }
}

async function findUsers(
  config: ServiceConfig,
  baseDir: string,
  customPath?: string,
  platformScope?: string | null
): Promise<UserEntry[]> {
  const users: UserEntry[] = [];
  const safeBaseDir = validatePath(baseDir);

  // Determine the path to search
  let searchPath: string;
  if (customPath) {
    searchPath = customPath;
  } else if (safeBaseDir.endsWith("gallery-dl")) {
    searchPath = path.join(safeBaseDir, config.name);
  } else {
    searchPath = path.join(safeBaseDir, "gallery-dl", config.name);
  }

  // Check if search path exists
  try {
    const info = await Deno.stat(searchPath);
    if (!info.isDirectory) {
      console.log(`${config.name} is not a directory at ${searchPath}`);
      return users;
    }
  } catch {
    console.log(`${config.name} directory not found at ${searchPath}`);
    return users;
  }

  // Service with platform subdirectories (coomer, kemono)
  if (config.platforms) {
    if (platformScope) {
      // Search specific platform only
      const platformPath = path.join(searchPath, platformScope);
      try {
        const info = await Deno.stat(platformPath);
        if (!info.isDirectory) {
          console.log(`${platformScope} is not a directory at ${platformPath}`);
          return users;
        }
      } catch {
        console.log(`${platformScope} directory not found at ${platformPath}`);
        return users;
      }

      for await (const userEntry of Deno.readDir(platformPath)) {
        if (!userEntry.isDirectory) continue;
        const userDir = path.join(platformPath, userEntry.name);
        users.push({
          url: config.buildUrl({
            platform: platformScope,
            userId: userEntry.name,
          }),
          directory: userDir,
          birthtime: await getDirectoryBirthtime(userDir),
        });
      }
    } else {
      // Search all valid platforms
      for await (const platformEntry of Deno.readDir(searchPath)) {
        if (!platformEntry.isDirectory) continue;
        if (!config.platforms.includes(platformEntry.name)) continue;

        const platform = platformEntry.name;
        const platformPath = path.join(searchPath, platform);

        for await (const userEntry of Deno.readDir(platformPath)) {
          if (!userEntry.isDirectory) continue;
          const userDir = path.join(platformPath, userEntry.name);
          users.push({
            url: config.buildUrl({ platform, userId: userEntry.name }),
            directory: userDir,
            birthtime: await getDirectoryBirthtime(userDir),
          });
        }
      }
    }
  } else {
    // Service without platform subdirectories (redgifs, pornhub, danbooru)
    for await (const entry of Deno.readDir(searchPath)) {
      if (!entry.isDirectory) continue;
      const userDir = path.join(searchPath, entry.name);
      users.push({
        url: config.buildUrl({ userId: entry.name }),
        directory: userDir,
        birthtime: await getDirectoryBirthtime(userDir),
      });
    }
  }

  return users;
}

async function downloadGalleryDlUser(args: {
  url: string;
  baseDir: string;
  configPath: string;
  logger: DownloadLogger;
  directory: string;
}) {
  // Determine the correct working directory (parent of gallery-dl)
  const workingDir = args.baseDir.endsWith("gallery-dl")
    ? path.dirname(args.baseDir)
    : args.baseDir;

  args.logger.addDownload(
    args.url,
    `Starting gallery-dl download... (to: ${workingDir})`
  );

  let newFiles = 0; // Declare outside try block so it's accessible in catch
  let errors = 0;

  try {
    // Always use pipe mode for easier parsing
    // Check if there are any .part files (incomplete downloads)
    // If there are, don't use skip=abort since we want to complete them
    let hasPartFiles = false;
    try {
      const findCmd = new Deno.Command("find", {
        args: [args.directory, "-name", "*.part", "-print", "-quit"],
        stdout: "piped",
      });
      const findResult = await findCmd.output();
      hasPartFiles = findResult.stdout.length > 0;
    } catch {
      // If find fails, assume no part files
      hasPartFiles = false;
    }

    // 95% of the time, add skip=abort:5 to stop after 5 consecutive existing files
    // But never add it if there are incomplete downloads
    const shouldAddSkip = !hasPartFiles && Math.random() < 0.95;
    const cmdArgs = ["--config", args.configPath, "-o", "output.mode=pipe"];
    if (shouldAddSkip) {
      cmdArgs.push("-o", "skip=abort:5");
    }
    cmdArgs.push(args.url);

    const cmd = new Deno.Command("gallery-dl", {
      args: cmdArgs,
      cwd: workingDir,
      stdout: "piped",
      stderr: "piped",
    });

    const process = cmd.spawn();
    let lastOutput = "Starting...";

    // Handle stdout
    const stdoutReader = process.stdout?.getReader();
    if (stdoutReader) {
      const decoder = new TextDecoder();
      (async () => {
        try {
          while (true) {
            const { done, value } = await stdoutReader.read();
            if (done) break;

            const text = decoder.decode(value, { stream: true });
            const lines = text.split("\n").filter((line) => line.trim());
            for (const line of lines) {
              // In pipe mode, lines starting with # indicate existing files
              // Count only new files (lines without #)
              if (!line.startsWith("#") && line.trim()) {
                newFiles++;
              }
            }
            if (lines.length > 0) {
              lastOutput = lines[lines.length - 1];
              args.logger.updateDownload(args.url, {
                newFiles,
                errors,
                detail: lastOutput,
              });
            }
          }
          // deno-lint-ignore no-unused-vars
        } catch (e) {
          // Ignore errors when process ends
        }
      })();
    }

    // Handle stderr
    const stderrReader = process.stderr?.getReader();
    if (stderrReader) {
      const decoder = new TextDecoder();
      (async () => {
        try {
          while (true) {
            const { done, value } = await stderrReader.read();
            if (done) break;

            const text = decoder.decode(value, { stream: true });
            const lines = text.split("\n").filter((line) => line.trim());
            for (const line of lines) {
              // Count errors from stderr
              if (
                line.toLowerCase().includes("error") ||
                line.toLowerCase().includes("failed")
              ) {
                errors++;
              }
              // Update lastOutput for each error line so it's visible
              if (line.trim()) {
                lastOutput = line;
                args.logger.updateDownload(args.url, {
                  newFiles,
                  errors,
                  detail: lastOutput,
                });
              }
            }
          }
          // deno-lint-ignore no-unused-vars
        } catch (e) {
          // Ignore errors when process ends
        }
      })();
    }

    const result = await process.status;

    if (result.success) {
      args.logger.updateDownload(args.url, {
        newFiles,
        errors,
        detail: "✓ Completed",
        success: true,
      });
      args.logger.removeDownload(args.url);
      return { success: true, user: args.url, newFiles, errors };
    } else {
      args.logger.updateDownload(args.url, {
        newFiles,
        errors,
        detail: "✗ Failed",
        success: false,
      });
      args.logger.removeDownload(args.url);
      return {
        success: false,
        url: args.url,
        error: "Command failed",
        newFiles,
        errors,
      };
    }
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    args.logger.updateDownload(args.url, {
      newFiles,
      errors,
      detail: `✗ Error: ${errorMsg}`,
      success: false,
    });
    args.logger.removeDownload(args.url);
    return {
      success: false,
      user: args.url,
      error: errorMsg,
      newFiles,
      errors,
    };
  }
}

async function downloadYtDlpUser(args: {
  url: string;
  baseDir: string;
  logger: DownloadLogger;
  directory: string;
}) {
  // Determine the correct working directory (parent of gallery-dl)
  const workingDir = args.baseDir.endsWith("gallery-dl")
    ? path.dirname(args.baseDir)
    : args.baseDir;

  args.logger.addDownload(args.url, "Starting yt-dlp download...");

  try {
    // Use download archive to prevent re-downloading videos (in the uploader's folder)
    const archivePath = path.join(args.directory, ".yt-dlp-archive.txt");

    // Count existing entries in archive file before download
    let beforeCount = 0;
    try {
      const archiveContent = await Deno.readTextFile(archivePath);
      beforeCount = archiveContent
        .split("\n")
        .filter((line) => line.trim()).length;
    } catch {
      // File doesn't exist yet, that's fine
      beforeCount = 0;
    }

    const cmd = new Deno.Command("yt-dlp", {
      args: [
        "--download-archive",
        archivePath,
        "-o",
        path.join(args.directory, "%(title)s.%(ext)s"),
        args.url,
      ],
      cwd: workingDir,
      stdout: "piped",
      stderr: "piped",
    });

    const process = cmd.spawn();
    let lastOutput = "Starting...";

    // Handle stdout
    const stdoutReader = process.stdout?.getReader();
    if (stdoutReader) {
      const decoder = new TextDecoder();
      (async () => {
        try {
          while (true) {
            const { done, value } = await stdoutReader.read();
            if (done) break;

            const text = decoder.decode(value, { stream: true });
            const lines = text.split("\n").filter((line) => line.trim());
            if (lines.length > 0) {
              lastOutput = lines[lines.length - 1];
              args.logger.updateDownload(args.url, { detail: lastOutput });
            }
          }
          // deno-lint-ignore no-unused-vars
        } catch (e) {
          // Ignore errors when process ends
        }
      })();
    }

    // Handle stderr
    const stderrReader = process.stderr?.getReader();
    if (stderrReader) {
      const decoder = new TextDecoder();
      (async () => {
        try {
          while (true) {
            const { done, value } = await stderrReader.read();
            if (done) break;

            const text = decoder.decode(value, { stream: true });
            const lines = text.split("\n").filter((line) => line.trim());
            if (lines.length > 0) {
              lastOutput = lines[lines.length - 1];
              args.logger.updateDownload(args.url, { detail: lastOutput });
            }
          }
          // deno-lint-ignore no-unused-vars
        } catch (e) {
          // Ignore errors when process ends
        }
      })();
    }

    const result = await process.status;

    // Count entries in archive file after download (for both success and failure)
    let afterCount = 0;
    try {
      const archiveContent = await Deno.readTextFile(archivePath);
      afterCount = archiveContent
        .split("\n")
        .filter((line) => line.trim()).length;
    } catch {
      afterCount = beforeCount;
    }

    const newFiles = afterCount - beforeCount;
    const errors = result.success ? 0 : 1; // Simple error count for yt-dlp

    if (result.success) {
      args.logger.updateDownload(args.url, {
        newFiles,
        errors,
        detail: "✓ Completed",
        success: true,
      });
      args.logger.removeDownload(args.url);
      return { success: true, user: args.url, newFiles, errors };
    } else {
      args.logger.updateDownload(args.url, {
        newFiles,
        errors,
        detail: "✗ Failed",
        success: false,
      });
      args.logger.removeDownload(args.url);
      return {
        success: false,
        url: args.url,
        error: "Command failed",
        newFiles,
        errors,
      };
    }
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    // For exceptions, we can't reliably count, so use 0 new files and 1 error
    args.logger.updateDownload(args.url, {
      newFiles: 0,
      errors: 1,
      detail: `✗ Error: ${errorMsg}`,
      success: false,
    });
    args.logger.removeDownload(args.url);
    return {
      success: false,
      user: args.url,
      error: errorMsg,
      newFiles: 0,
      errors: 1,
    };
  }
}

async function downloadUser(args: {
  url: string;
  baseDir: string;
  configPath: string;
  logger: DownloadLogger;
  directory: string;
}) {
  const domain = new URL(args.url).hostname;
  if (domain.endsWith("pornhub.com")) {
    return await downloadYtDlpUser({
      url: args.url,
      baseDir: args.baseDir,
      logger: args.logger,
      directory: args.directory,
    });
  }
  return await downloadGalleryDlUser(args);
}

async function downloadUsersParallel(args: {
  users: Array<{ url: string; directory: string; platform: string }>;
  baseDir: string;
  configPath: string;
  parallelCount: number;
}) {
  const results: Array<{
    success: boolean;
    user?: string;
    url?: string;
    error?: string;
    newFiles?: number;
    errors?: number;
  }> = [];

  const logger = new DownloadLogger();
  logger.setTotalDownloads(args.users.length);
  const queue = new PQueue({ concurrency: args.parallelCount });

  const downloadPromises = args.users.map((user) => {
    return queue.add(async () => {
      const result = await downloadUser({
        url: user.url,
        baseDir: args.baseDir,
        configPath: args.configPath,
        logger: logger,
        directory: user.directory,
      });
      results.push(result);
      return result;
    });
  });

  await Promise.all(downloadPromises);
  logger.done();
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
  const flags = parseArgs(Deno.args, {
    string: ["parallel", "p"],
    alias: { p: "parallel" },
    default: { parallel: "1" },
  });

  const inputDir = flags._[0] as string;
  const parallelCount = parseInt(flags.parallel || "1", 10);

  if (!inputDir) {
    console.error("Usage: gallery-update.ts [options] <directory>");
    Deno.exit(1);
  }

  if (isNaN(parallelCount) || parallelCount < 1) {
    console.error("Error: Parallel count must be a positive number");
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
    console.log(`Parallel downloads: ${parallelCount}`);
    console.log(`Scope:`, scope);

    // Find users for each service based on scope
    const serviceNames = Object.keys(SERVICES) as Array<keyof typeof SERVICES>;
    const allUsers: Array<UserEntry & { platform: string }> = [];

    for (const serviceName of serviceNames) {
      const config = SERVICES[serviceName];
      const scopeValue = scope[serviceName as keyof typeof scope];
      const shouldProcess =
        Object.keys(scope).length === 0 || scopeValue !== undefined;

      if (!shouldProcess) continue;

      // Determine custom path based on scope
      let customPath: string | undefined;
      if (scopeValue === null) {
        // We're at the service level (e.g., gallery-dl/coomer)
        customPath = inputDir;
      } else if (scopeValue && scopeValue !== "all") {
        // We're at a specific platform level (e.g., gallery-dl/coomer/onlyfans)
        customPath = path.dirname(inputDir);
      } else if (scopeValue === "all") {
        // We're at a service without platforms (e.g., gallery-dl/redgifs)
        customPath = inputDir;
      }

      const platformScope =
        scopeValue && scopeValue !== "all" ? scopeValue : undefined;
      const users = await findUsers(config, baseDir, customPath, platformScope);

      if (users.length > 0) {
        console.log(
          `\nFound ${users.length} ${serviceName} users to download:`
        );
        for (const user of users) {
          console.log(`  - ${user.url}`);
        }
        allUsers.push(
          ...users.map((user) => ({ ...user, platform: serviceName }))
        );
      }
    }

    // Sort all users by birthtime (newest directories first)
    allUsers.sort((a, b) => b.birthtime - a.birthtime);

    // Download all users with parallelization
    console.log("\nStarting downloads with live progress...");

    if (allUsers.length === 0) {
      console.log("No users found to download.");
      return;
    }

    // Process downloads with parallelization
    const results = await downloadUsersParallel({
      users: allUsers,
      baseDir,
      configPath,
      parallelCount,
    });

    // Per-user summary
    console.log(`\nPer-User Summary:`);
    for (const result of results) {
      const shortUrl =
        result.user?.replace(/^https?:\/\//, "") ||
        result.url?.replace(/^https?:\/\//, "") ||
        "Unknown";
      const newFiles = result.newFiles || 0;
      const errors = result.errors || 0;
      const status = result.success ? "✓" : "✗";
      console.log(`  ${status} [${shortUrl}] New: ${newFiles}, Err: ${errors}`);
    }

    // Overall summary
    const successful = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;
    const totalNewFiles = results.reduce(
      (sum, r) => sum + (r.newFiles || 0),
      0
    );
    const totalErrors = results.reduce((sum, r) => sum + (r.errors || 0), 0);
    console.log(`\nOverall Summary:`);
    console.log(`  ✓ Successful: ${successful}`);
    console.log(`  ✗ Failed: ${failed}`);
    console.log(`  📥 New files: ${totalNewFiles}`);
    console.log(`  ❌ Errors: ${totalErrors}`);
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
