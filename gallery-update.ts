#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env

import * as path from "jsr:@std/path@1.1.1";
import { parseArgs } from "jsr:@std/cli@1.0.21/parse-args";
import PQueue from "npm:p-queue@8.1.0";
import logUpdate from "npm:log-update@6.1.0";

// Download logger to manage active downloads display
class DownloadLogger {
  private activeDownloads = new Map<string, string>();
  private completedDownloads = new Map<string, string>();
  private updateInterval: number | null = null;
  private totalDownloads = 0;
  private completedCount = 0;

  constructor() {
    // Start periodic updates
    this.updateInterval = setInterval(() => {
      this.updateDisplay();
    }, 100);
  }

  setTotalDownloads(total: number) {
    this.totalDownloads = total;
    this.completedCount = 0;
    this.completedDownloads.clear();
  }

  addDownload(url: string, initialMessage: string = "Starting...") {
    this.activeDownloads.set(url, initialMessage);
    this.updateDisplay();
  }

  updateDownload(url: string, message: string) {
    this.activeDownloads.set(url, message);
    this.updateDisplay();
  }

  removeDownload(url: string) {
    const message = this.activeDownloads.get(url) || "Completed";
    this.activeDownloads.delete(url);
    // Store the completion message, preserving details like file counts
    const cleanMessage = message.includes(" - New:") || message.includes("Error:")
      ? message // Keep messages with file counts or error details
      : message.includes("✓")
        ? "Download completed successfully"
        : message.includes("✗")
          ? "Download failed"
          : "Download completed successfully";
    this.completedDownloads.set(url, cleanMessage);
    this.completedCount++;
    this.updateDisplay();
  }

  private updateDisplay() {
    const lines: string[] = [];

    // Add completed downloads section
    if (this.completedDownloads.size > 0) {
      lines.push("Completed:");
      const completedLines = Array.from(this.completedDownloads.entries()).map(
        ([url, message]) => {
          const shortUrl = this.getShortUrl(url);
          return `  ✓ [${shortUrl}] ${message}`;
        },
      );
      lines.push(...completedLines);
      lines.push(""); // Empty line for spacing
    }

    // Add progress header
    if (this.totalDownloads > 0) {
      const progress = this.completedCount;
      const percentage = Math.round((progress / this.totalDownloads) * 100);
      lines.push(
        `Progress: ${progress}/${this.totalDownloads} (${percentage}%)`,
      );
      lines.push(""); // Empty line for spacing
    }

    // Add active downloads
    if (this.activeDownloads.size > 0) {
      const downloadLines = Array.from(this.activeDownloads.entries()).flatMap(
        ([url, message]) => {
          const shortUrl = this.getShortUrl(url);
          return [`[${shortUrl}]`, `${message}`];
        },
      );
      lines.push(...downloadLines);
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

function buildCoomerUrl(args: { platform: string; userId: string }) {
  return `https://coomer.st/${args.platform}/user/${args.userId}`;
}

function buildKemonoUrl(args: { platform: string; userId: string }) {
  return `https://kemono.cr/${args.platform}/user/${args.userId}`;
}

async function findCoomerUsers(
  baseDir: string,
  coomerPath?: string,
  platformScope?: string | null,
) {
  const users: { url: string; directory: string }[] = [];
  const safeBaseDir = validatePath(baseDir);

  // Determine the path to search
  let searchPath: string;
  if (coomerPath) {
    searchPath = coomerPath;
  } else {
    // Check if baseDir already ends with gallery-dl
    if (safeBaseDir.endsWith("gallery-dl")) {
      searchPath = path.join(safeBaseDir, "coomer");
    } else {
      searchPath = path.join(safeBaseDir, "gallery-dl", "coomer");
    }
  }

  try {
    const coomerInfo = await Deno.stat(searchPath);
    if (!coomerInfo.isDirectory) {
      console.log(`coomer is not a directory at ${searchPath}`);
      return users;
    }
    // deno-lint-ignore no-unused-vars
  } catch (e) {
    console.log(`coomer directory not found at ${searchPath}`);
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

async function findKemonoUsers(
  baseDir: string,
  kemonoPath?: string,
  platformScope?: string | null,
) {
  const users: { url: string; directory: string }[] = [];
  const safeBaseDir = validatePath(baseDir);

  // Determine the path to search
  let searchPath: string;
  if (kemonoPath) {
    searchPath = kemonoPath;
  } else {
    // Check if baseDir already ends with gallery-dl
    if (safeBaseDir.endsWith("gallery-dl")) {
      searchPath = path.join(safeBaseDir, "kemono");
    } else {
      searchPath = path.join(safeBaseDir, "gallery-dl", "kemono");
    }
  }

  try {
    const kemonoInfo = await Deno.stat(searchPath);
    if (!kemonoInfo.isDirectory) {
      console.log(`kemono is not a directory at ${searchPath}`);
      return users;
    }
    // deno-lint-ignore no-unused-vars
  } catch (e) {
    console.log(`kemono directory not found at ${searchPath}`);
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
        url: buildKemonoUrl({
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
        ![
          "patreon",
          "fanbox",
          "gumroad",
          "subscribestar",
          "dlsite",
          "fantia",
        ].includes(platformEntry.name)
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
          url: buildKemonoUrl({ platform, userId: userEntry.name }),
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

function buildDanbooruUrl(args: { userId: string }) {
  const encodedUserId = encodeURIComponent(args.userId);
  return `https://danbooru.donmai.us/posts?tags=${encodedUserId}+&z=5`;
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

async function findDanbooruUsers(baseDir: string, danbooruPath?: string) {
  const users: { url: string; directory: string }[] = [];
  const safeBaseDir = validatePath(baseDir);

  // Determine the path to search
  let searchPath: string;
  if (danbooruPath) {
    searchPath = danbooruPath;
  } else {
    // Check if baseDir already ends with gallery-dl
    if (safeBaseDir.endsWith("gallery-dl")) {
      searchPath = path.join(safeBaseDir, "danbooru");
    } else {
      searchPath = path.join(safeBaseDir, "gallery-dl", "danbooru");
    }
  }

  try {
    const danbooruInfo = await Deno.stat(searchPath);
    if (!danbooruInfo.isDirectory) {
      console.log(`danbooru is not a directory at ${searchPath}`);
      return users;
    }
    // deno-lint-ignore no-unused-vars
  } catch (e) {
    console.log(`danbooru directory not found at ${searchPath}`);
    return users;
  }
  // Look for Danbooru user directories directly under the search path
  for await (const entry of Deno.readDir(searchPath)) {
    if (!entry.isDirectory) {
      continue;
    }
    users.push({
      url: buildDanbooruUrl({ userId: entry.name }),
      directory: path.join(searchPath, entry.name),
    });
  }
  return users;
}

async function downloadGalleryDlUser(args: {
  url: string;
  baseDir: string;
  configPath: string;
  logger: DownloadLogger;
}) {
  // Determine the correct working directory (parent of gallery-dl)
  const workingDir = args.baseDir.endsWith("gallery-dl")
    ? path.dirname(args.baseDir)
    : args.baseDir;

  args.logger.addDownload(
    args.url,
    `Starting gallery-dl download... (to: ${workingDir})`,
  );

  let newFiles = 0; // Declare outside try block so it's accessible in catch

  try {
    // Always use pipe mode for easier parsing
    // 95% of the time, add skip=abort:5 to stop after 5 consecutive existing files
    const shouldAddSkip = Math.random() < 0.95;
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
              args.logger.updateDownload(
                args.url,
                `New: ${newFiles} | ${lastOutput}`,
              );
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
              lastOutput = `ERROR: ${lines[lines.length - 1]}`;
              args.logger.updateDownload(args.url, lastOutput);
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
      args.logger.updateDownload(args.url, `✓ Completed - New: ${newFiles}`);
      args.logger.removeDownload(args.url);
      return { success: true, user: args.url, newFiles };
    } else {
      args.logger.updateDownload(args.url, `✗ Failed - New: ${newFiles}`);
      args.logger.removeDownload(args.url);
      return {
        success: false,
        url: args.url,
        error: "Command failed",
        newFiles,
      };
    }
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    args.logger.updateDownload(args.url, `✗ Error: ${errorMsg} - New: ${newFiles}`);
    args.logger.removeDownload(args.url);
    return { success: false, user: args.url, error: errorMsg, newFiles };
  }
}

async function downloadYtDlpUser(args: {
  url: string;
  baseDir: string;
  logger: DownloadLogger;
}) {
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

  args.logger.addDownload(args.url, "Starting yt-dlp download...");

  try {
    // Use download archive to prevent re-downloading videos
    const archivePath = path.join(workingDir, `gallery-dl/${folder}/.yt-dlp-archive.txt`);
    
    // Count existing entries in archive file before download
    let beforeCount = 0;
    try {
      const archiveContent = await Deno.readTextFile(archivePath);
      beforeCount = archiveContent.split("\n").filter((line) => line.trim()).length;
    } catch {
      // File doesn't exist yet, that's fine
      beforeCount = 0;
    }
    
    const cmd = new Deno.Command("yt-dlp", {
      args: [
        "--download-archive",
        `gallery-dl/${folder}/.yt-dlp-archive.txt`,
        "-o",
        `gallery-dl/${folder}/%(uploader_id)s/%(title)s.%(ext)s`,
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
              args.logger.updateDownload(args.url, lastOutput);
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
              lastOutput = `ERROR: ${lines[lines.length - 1]}`;
              args.logger.updateDownload(args.url, lastOutput);
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
      afterCount = archiveContent.split("\n").filter((line) => line.trim()).length;
    } catch {
      afterCount = beforeCount;
    }
    
    const newFiles = afterCount - beforeCount;

    if (result.success) {
      args.logger.updateDownload(args.url, `✓ Completed - New: ${newFiles}`);
      args.logger.removeDownload(args.url);
      return { success: true, user: args.url, newFiles };
    } else {
      args.logger.updateDownload(args.url, `✗ Failed - New: ${newFiles}`);
      args.logger.removeDownload(args.url);
      return {
        success: false,
        url: args.url,
        error: "Command failed",
        newFiles,
      };
    }
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    // For exceptions, we can't reliably count, so use 0
    args.logger.updateDownload(args.url, `✗ Error: ${errorMsg}`);
    args.logger.removeDownload(args.url);
    return { success: false, user: args.url, error: errorMsg, newFiles: 0 };
  }
}

async function downloadUser(args: {
  url: string;
  baseDir: string;
  configPath: string;
  logger: DownloadLogger;
}) {
  const domain = new URL(args.url).hostname;
  if (domain.endsWith("pornhub.com")) {
    return await downloadYtDlpUser({
      url: args.url,
      baseDir: args.baseDir,
      logger: args.logger,
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
      `Error: Directory ${baseDir} does not exist or is not accessible`,
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

    // Determine which platforms to process based on scope
    const shouldProcessCoomer =
      Object.keys(scope).length === 0 || scope.coomer !== undefined;
    const shouldProcessKemono =
      Object.keys(scope).length === 0 || scope.kemono !== undefined;
    const shouldProcessRedgifs =
      Object.keys(scope).length === 0 || scope.redgifs !== undefined;
    const shouldProcessPornhub =
      Object.keys(scope).length === 0 || scope.pornhub !== undefined;
    const shouldProcessDanbooru =
      Object.keys(scope).length === 0 || scope.danbooru !== undefined;

    // Find users based on scope
    const findPromises = [];

    if (shouldProcessCoomer) {
      let coomerPath: string | undefined;
      if (scope.coomer === null) {
        // We're at the coomer level
        coomerPath = inputDir;
      } else if (scope.coomer) {
        // We're at a specific platform level
        coomerPath = path.dirname(inputDir);
      }
      findPromises.push(
        findCoomerUsers(baseDir, coomerPath, scope.coomer || undefined),
      );
    } else {
      findPromises.push(Promise.resolve([]));
    }

    if (shouldProcessKemono) {
      let kemonoPath: string | undefined;
      if (scope.kemono === null) {
        // We're at the kemono level
        kemonoPath = inputDir;
      } else if (scope.kemono) {
        // We're at a specific platform level
        kemonoPath = path.dirname(inputDir);
      }
      findPromises.push(
        findKemonoUsers(baseDir, kemonoPath, scope.kemono || undefined),
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

    if (shouldProcessDanbooru) {
      let danbooruPath: string | undefined;
      if (scope.danbooru === "all") {
        danbooruPath = inputDir;
      }
      findPromises.push(findDanbooruUsers(baseDir, danbooruPath));
    } else {
      findPromises.push(Promise.resolve([]));
    }

    const [
      coomerUsers,
      kemonoUsers,
      redgifsUsers,
      pornhubUsers,
      danbooruUsers,
    ] = await Promise.all(findPromises);

    // Display found users
    if (coomerUsers.length > 0) {
      console.log(`\nFound ${coomerUsers.length} coomer users to download:`);
      for (const user of coomerUsers) {
        console.log(`  - ${user.url}`);
      }
    }
    if (kemonoUsers.length > 0) {
      console.log(`\nFound ${kemonoUsers.length} kemono users to download:`);
      for (const user of kemonoUsers) {
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
    if (danbooruUsers.length > 0) {
      console.log(
        `\nFound ${danbooruUsers.length} danbooru users to download:`,
      );
      for (const user of danbooruUsers) {
        console.log(`  - ${user.url}`);
      }
    }

    // Download all users with parallelization
    console.log("\nStarting downloads with live progress...");

    // Combine all users and shuffle them
    const allUsers = shuffleArray([
      ...coomerUsers.map((user) => ({ ...user, platform: "coomer" })),
      ...kemonoUsers.map((user) => ({ ...user, platform: "kemono" })),
      ...redgifsUsers.map((user) => ({ ...user, platform: "redgifs" })),
      ...pornhubUsers.map((user) => ({ ...user, platform: "pornhub" })),
      ...danbooruUsers.map((user) => ({ ...user, platform: "danbooru" })),
    ]);

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

    // Summary
    const successful = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;
    const totalNewFiles = results.reduce(
      (sum, r) => sum + (r.newFiles || 0),
      0,
    );
    console.log(`\nDownload Summary:`);
    console.log(`  ✓ Successful: ${successful}`);
    console.log(`  ✗ Failed: ${failed}`);
    console.log(`  📥 New files: ${totalNewFiles}`);
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
      }`,
    );
    Deno.exit(1);
  }
}

if (import.meta.main) {
  main();
}
