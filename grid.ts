#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env --allow-ffi

import sharp from "npm:sharp@0.34.1";
import * as path from "jsr:@std/path@1.1.1";
import { mimeType } from "npm:mime-type@5.0.3/with-db";
import PQueue from "npm:p-queue@8.1.0";

const JPEG_QUALITY = 85;
const CELL_SIZE = 360;
const GRID_SIZE = CELL_SIZE * 2;
const PGRID_VERSION = 2; // Version 1: original format, Version 2: added directories with birthtimes

// Skip complex/unsuitable file types
const skipExtensions = [
  ".psd", // Photoshop files
  ".ai", // Adobe Illustrator files
  ".eps", // Encapsulated PostScript
  ".indd", // Adobe InDesign files
  ".pdf", // PDF files
  ".part", // Part files (downloading)
  // Non-media files
  ".zip",
  ".rar",
  ".7z",
  ".tar",
  ".gz",
  ".bz2",
  ".xz",
  ".wim",
  ".iso",
];
export function shouldSkipFile(filename: string) {
  const lowerName = filename.toLowerCase();
  return skipExtensions.some((ext) => lowerName.endsWith(ext));
}

export function isMediaFile(filename: string) {
  const type = mimeType.lookup(filename);
  if (typeof type !== "string") {
    return false;
  }
  return type.startsWith("image/") || type.startsWith("video/");
}

export function isVideoFile(filename: string) {
  const type = mimeType.lookup(filename);
  if (typeof type !== "string") {
    return false;
  }
  return type.startsWith("video/");
}

export function isImageFile(filename: string) {
  const type = mimeType.lookup(filename);
  if (typeof type !== "string") {
    return false;
  }
  return type.startsWith("image/");
}

export async function temporaryFile(args: { suffix: string }) {
  const tmpDir = await Deno.makeTempDir();
  const tmpFile = await Deno.makeTempFile({
    dir: tmpDir,
    suffix: args.suffix,
  });
  return { tmpFile, tmpDir };
}

export function validatePath(directory: string) {
  const normalizedPath = path.normalize(directory);
  if (normalizedPath.includes("..")) {
    throw new Error("Path traversal detected");
  }
  return normalizedPath;
}

async function getVideoThumbnail(args: {
  path: string;
  width: number;
  height: number;
}) {
  let tmpPath: string | undefined;
  let tmpDir: string | undefined;
  try {
    // Create temporary file for the thumbnail
    const tmp = await temporaryFile({ suffix: ".jpg" });
    tmpPath = tmp.tmpFile;
    tmpDir = tmp.tmpDir;
    // Get video duration and extract frame from middle
    const probeCmd = new Deno.Command("ffprobe", {
      args: [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        args.path,
      ],
      stdout: "piped",
    });
    const probeOutput = await probeCmd.output();
    const duration = Math.min(
      parseFloat(new TextDecoder().decode(probeOutput.stdout)) / 2,
      5
    );
    // Extract frame using ffmpeg
    const ffmpegCmd = new Deno.Command("ffmpeg", {
      args: [
        "-ss",
        duration.toString(),
        "-i",
        args.path,
        "-vframes",
        "1",
        "-vf",
        `scale=${args.width}:${args.height}:force_original_aspect_ratio=increase,crop=${args.width}:${args.height}`,
        "-y",
        tmpPath,
      ],
    });
    await ffmpegCmd.output();
    // Read and process the image with sharp
    const imageData = await Deno.readFile(tmpPath);
    const image = sharp(imageData);
    return image;
  } catch (e) {
    console.error(`[ERROR] Failed to create video thumbnail: ${args.path}`, e);
    return null;
  } finally {
    // Clean up temporary file and directory
    if (tmpPath) {
      try {
        await Deno.remove(tmpPath);
      } catch {
        // Silently ignore cleanup errors
      }
    }
    if (tmpDir) {
      try {
        await Deno.remove(tmpDir, { recursive: true });
      } catch {
        // Silently ignore cleanup errors
      }
    }
  }
}

async function checkDependencies() {
  const requiredCommands = ["ffmpeg", "ffprobe"];
  const missingCommands = [];
  for (const cmd of requiredCommands) {
    try {
      const checkCmd = new Deno.Command(cmd, {
        args: ["-version"],
        stdout: "null",
        stderr: "null",
      });
      await checkCmd.output();
      // deno-lint-ignore no-unused-vars
    } catch (e) {
      missingCommands.push(cmd);
    }
  }
  if (missingCommands.length > 0) {
    console.error(
      `[ERROR] Missing dependencies: ${missingCommands.join(", ")}`
    );
    console.error(
      "[ERROR] Please install using your system's package manager."
    );
    Deno.exit(1);
  }
}

type CacheEntry = {
  fileSize: number;
  mtime: number;
  size: { width: number; height: number };
};
type Cache = Record<string, CacheEntry>;

// Load and merge caches from immediate child directories
async function loadChildCaches(
  directory: string,
  childDirPaths: string[]
): Promise<Cache> {
  const mergedCache: Cache = {};

  for (const childDirPath of childDirPaths) {
    const childDir = path.basename(childDirPath);
    const childCachePath = path.join(directory, `.${childDir}_pgrid.json`);

    try {
      const cacheText = await Deno.readTextFile(childCachePath);
      const childCache: Cache = JSON.parse(cacheText);

      // Transform paths: prefix with child directory name
      for (const [relativePath, cacheEntry] of Object.entries(childCache)) {
        const transformedPath = path.join(childDir, relativePath);
        mergedCache[transformedPath] = cacheEntry;
      }
    } catch {
      // Child cache doesn't exist or is corrupt, skip
    }
  }

  return mergedCache;
}

async function updateMetadataCache(args: {
  mediaFiles: { absolutePath: string; relativePath: string }[];
  directory: string;
  childDirPaths: string[];
}) {
  const cacheStart = performance.now();
  const safeDirectory = validatePath(args.directory);
  const dirName = path.basename(safeDirectory);
  const parentDir = path.dirname(safeDirectory);
  const cachePath = path.join(parentDir, `.${dirName}_pgrid.json`);

  // Load existing cache for this directory
  let oldCache: Cache = {};
  try {
    const cacheText = await Deno.readTextFile(cachePath);
    oldCache = JSON.parse(cacheText);
  } catch {
    oldCache = {};
  }

  // Load and merge caches from child directories (for recovery and efficiency)
  const childCaches = await loadChildCaches(safeDirectory, args.childDirPaths);
  let childCacheHits = 0;
  for (const [relativePath, entry] of Object.entries(childCaches)) {
    // Only add if not already in oldCache (prefer existing parent cache)
    if (!oldCache[relativePath]) {
      oldCache[relativePath] = entry;
      childCacheHits++;
    }
  }
  if (childCacheHits > 0) {
    console.log(
      `[CACHE] Loaded ${childCacheHits} entries from child caches - ${dirName}`
    );
  }
  // Remove deleted files from cache (use relative path as key)
  const currentFileNames = new Set(args.mediaFiles.map((f) => f.relativePath));
  const cleanedCache: Cache = {};
  for (const [name, entry] of Object.entries(oldCache)) {
    if (currentFileNames.has(name)) {
      cleanedCache[name] = entry;
    }
  }
  const newCache: Cache = { ...cleanedCache };
  const queue = new PQueue({ concurrency: 10 });
  let newFilesCount = 0;
  async function processFile(file: {
    absolutePath: string;
    relativePath: string;
  }) {
    const name = file.relativePath;
    let fileSize = 0;
    let mtime = 0;
    try {
      const stat = await Deno.stat(file.absolutePath);
      fileSize = stat.size;
      mtime = stat.mtime?.getTime() ?? 0;
      // deno-lint-ignore no-empty
    } catch {}
    let size = { width: 0, height: 0 };
    const oldEntry = newCache[name];
    if (
      oldEntry &&
      oldEntry.fileSize === fileSize &&
      oldEntry.mtime === mtime
    ) {
      size = oldEntry.size;
    } else {
      // This is a new or modified file
      newFilesCount++;
      try {
        if (isImageFile(file.absolutePath)) {
          const data = await Deno.readFile(file.absolutePath);
          const metadata = await sharp(data).metadata();
          size = { width: metadata.width || 0, height: metadata.height || 0 };
        } else if (isVideoFile(file.absolutePath)) {
          const cmd = new Deno.Command("ffprobe", {
            args: [
              "-v",
              "error",
              "-select_streams",
              "v:0",
              "-show_entries",
              "stream=width,height",
              "-of",
              "json",
              file.absolutePath,
            ],
            stdout: "piped",
            stderr: "null",
          });
          const { stdout } = await cmd.output();
          const probe = JSON.parse(new TextDecoder().decode(stdout));
          if (
            probe.streams &&
            probe.streams[0] &&
            probe.streams[0].width &&
            probe.streams[0].height
          ) {
            size = {
              width: probe.streams[0].width,
              height: probe.streams[0].height,
            };
          }
        }
        // deno-lint-ignore no-empty
      } catch {}
    }
    return { name, entry: { fileSize, mtime, size } };
  }
  const promises = args.mediaFiles.map((file) =>
    queue.add(async () => {
      const result = await processFile(file);
      return result;
    })
  );
  const results = await Promise.all(promises);
  for (const result of results) {
    if (result) {
      newCache[result.name] = result.entry;
    }
  }
  await Deno.writeTextFile(cachePath, JSON.stringify(newCache, null, 2));
  const cacheEnd = performance.now();
  const cacheTime = (cacheEnd - cacheStart) / 1000;
  console.log(
    `[CACHE] ${
      args.mediaFiles.length
    } files (${newFilesCount} new) in ${cacheTime.toFixed(
      2
    )}s - ${path.basename(args.directory)}`
  );
  return { cache: newCache, newFilesCount };
}

async function copyGridViewer(targetDirectory: string) {
  try {
    // Get the script directory (where grid.ts is located)
    const scriptDir = path.dirname(new URL(import.meta.url).pathname);
    const sourcePath = path.join(scriptDir, "grid-viewer.html");
    const targetPath = path.join(targetDirectory, "..", "0grid-viewer.html");
    // Copy the file
    await Deno.copyFile(sourcePath, targetPath);
  } catch (e) {
    console.error(
      `[ERROR] Failed to copy grid-viewer.html: ${targetDirectory}`,
      e
    );
  }
}

interface DirectoryScanResult {
  directories: string[];
  // Map from directory path to its media files (with paths relative to that directory)
  mediaFilesByDir: Map<
    string,
    { absolutePath: string; relativePath: string }[]
  >;
  // Map from directory path to its immediate subdirectories
  subdirsByDir: Map<string, string[]>;
}

async function scanAllDirectoriesAndFiles(
  rootDir: string
): Promise<DirectoryScanResult> {
  const scanStart = performance.now();
  console.log(`[SCAN] Starting directory scan: ${rootDir}`);

  const directories: string[] = [];
  const mediaFilesByDir = new Map<
    string,
    { absolutePath: string; relativePath: string }[]
  >();
  const subdirsByDir = new Map<string, string[]>();
  const visited = new Set<string>();
  const queue: string[] = [rootDir];

  let totalMediaFiles = 0;
  let directoriesProcessed = 0;
  const PROGRESS_INTERVAL = 10; // Log progress every N directories

  while (queue.length > 0) {
    const directory = queue.shift()!;

    // Get real path to detect symlink loops
    let realPath: string;
    try {
      realPath = await Deno.realPath(directory);
    } catch {
      continue;
    }

    if (visited.has(realPath)) {
      console.log(`[SCAN] Skipping symlink: ${directory} -> ${realPath}`);
      continue;
    }
    visited.add(realPath);
    directories.push(directory);

    const mediaFiles: { absolutePath: string; relativePath: string }[] = [];
    const subdirs: string[] = [];

    try {
      for await (const entry of Deno.readDir(directory)) {
        if (entry.isDirectory) {
          if (!entry.name.startsWith(".")) {
            const subDirPath = path.join(directory, entry.name);
            subdirs.push(subDirPath);
            queue.push(subDirPath);
          }
        } else if (entry.isFile) {
          const absolutePath = path.join(directory, entry.name);
          if (
            !shouldSkipFile(entry.name) &&
            isMediaFile(absolutePath) &&
            !entry.name.endsWith("_pgrid.jpg")
          ) {
            // Store with path relative to THIS directory (just filename for direct files)
            mediaFiles.push({ absolutePath, relativePath: entry.name });
          }
        }
      }
    } catch (e) {
      console.error(`[SCAN] Error reading directory: ${directory}`, e);
    }

    mediaFilesByDir.set(directory, mediaFiles);
    subdirsByDir.set(directory, subdirs);

    totalMediaFiles += mediaFiles.length;
    directoriesProcessed++;

    // Log progress periodically
    if (directoriesProcessed % PROGRESS_INTERVAL === 0) {
      const elapsed = (performance.now() - scanStart) / 1000;
      const remaining = queue.length;
      console.log(
        `[SCAN] ${directoriesProcessed} dirs, ${totalMediaFiles} files, ${remaining} remaining (${elapsed.toFixed(
          1
        )}s)`
      );
    }
  }

  const scanEnd = performance.now();
  const scanDuration = (scanEnd - scanStart) / 1000;
  const avgTime = (scanDuration * 1000) / directoriesProcessed;
  console.log(
    `[SCAN] Completed in ${scanDuration.toFixed(
      1
    )}s: ${directoriesProcessed} dirs, ${totalMediaFiles} files (${avgTime.toFixed(
      1
    )}ms/dir avg)`
  );

  return { directories, mediaFilesByDir, subdirsByDir };
}

function collectMediaFilesIteratively(
  startDirectory: string,
  scanResult: DirectoryScanResult,
  baseDir: string
): { absolutePath: string; relativePath: string }[] {
  const allFiles: { absolutePath: string; relativePath: string }[] = [];
  const dirQueue: string[] = [startDirectory];

  while (dirQueue.length > 0) {
    const directory = dirQueue.shift()!;

    // Get direct files from this directory
    const directFiles = scanResult.mediaFilesByDir.get(directory) || [];
    for (const file of directFiles) {
      // Compute relative path from baseDir
      const relativePath = path.relative(baseDir, file.absolutePath);
      allFiles.push({ absolutePath: file.absolutePath, relativePath });
    }

    // Add subdirectories to queue
    const subdirs = scanResult.subdirsByDir.get(directory) || [];
    dirQueue.push(...subdirs);
  }

  return allFiles;
}

async function processDirectoryWithScanResult(
  directory: string,
  scanResult: DirectoryScanResult
) {
  const safeDirectory = validatePath(directory);

  // Collect all media files from this directory and subdirectories
  const mediaFiles = collectMediaFilesIteratively(
    safeDirectory,
    scanResult,
    safeDirectory
  );

  if (mediaFiles.length === 0) {
    return { newFilesCount: 0, cache: {} as Cache, dirBirthtime: 0 };
  }

  // Get immediate child directories from scan result
  const childDirPaths = scanResult.subdirsByDir.get(safeDirectory) || [];

  // Collect directory birthtimes for all subdirectories (relative paths)
  const dirBirthtimes: DirectoryBirthtimes = {};
  const allSubdirs = collectAllSubdirectories(safeDirectory, scanResult);
  for (const subdir of allSubdirs) {
    try {
      const stat = await Deno.stat(subdir);
      const relativePath = path.relative(safeDirectory, subdir);
      dirBirthtimes[relativePath] = stat.birthtime?.getTime() ?? 0;
    } catch {
      // Skip directories we can't stat
    }
  }

  // Get birthtime for this directory itself
  let dirBirthtime = 0;
  try {
    const stat = await Deno.stat(safeDirectory);
    dirBirthtime = stat.birthtime?.getTime() ?? 0;
  } catch {
    // Ignore stat errors
  }

  // Update metadata cache for media viewer
  const cacheResult = await updateMetadataCache({
    mediaFiles,
    directory: safeDirectory,
    childDirPaths,
  });
  await processMediaFiles({
    mediaFiles,
    directory: safeDirectory,
    cache: cacheResult.cache,
    dirBirthtimes,
  });
  return { ...cacheResult, dirBirthtime };
}

function collectAllSubdirectories(
  startDirectory: string,
  scanResult: DirectoryScanResult
): string[] {
  const result: string[] = [];
  const queue: string[] = [startDirectory];

  while (queue.length > 0) {
    const dir = queue.shift()!;
    const subdirs = scanResult.subdirsByDir.get(dir) || [];
    for (const subdir of subdirs) {
      result.push(subdir);
      queue.push(subdir);
    }
  }

  return result;
}

async function processMediaFiles(args: {
  mediaFiles: { absolutePath: string; relativePath: string }[];
  directory: string;
  cache: Cache;
  dirBirthtimes: DirectoryBirthtimes;
}) {
  const cellsPerRow = GRID_SIZE / CELL_SIZE;
  const cellsPerColumn = GRID_SIZE / CELL_SIZE;
  const totalCells = cellsPerRow * cellsPerColumn;
  // Randomly select GRID_SIZE images (or less if not enough)
  const selectedFiles = args.mediaFiles
    .sort(() => Math.random() - 0.5)
    .slice(0, totalCells);
  // Create grid image
  const gridImage = sharp({
    create: {
      width: GRID_SIZE,
      height: GRID_SIZE,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  });
  let processedImages = 0;
  const compositeOperations = [];
  const thumbnailStart = performance.now();
  // Place images in grid
  for (let idx = 0; idx < selectedFiles.length; idx++) {
    const file = selectedFiles[idx];
    const row = Math.floor(idx / cellsPerRow);
    const col = idx % cellsPerRow;
    try {
      let image: sharp.Sharp | null;
      if (isVideoFile(file.absolutePath)) {
        const videoStart = performance.now();
        image = await getVideoThumbnail({
          path: file.absolutePath,
          width: CELL_SIZE,
          height: CELL_SIZE,
        });
        const videoEnd = performance.now();
        const videoTime = (videoEnd - videoStart) / 1000;
        console.log(`[VIDEO] ${file.relativePath} (${videoTime.toFixed(2)}s)`);
      } else {
        const imageData = await Deno.readFile(file.absolutePath);
        image = sharp(imageData);
      }
      if (image) {
        const resizedImage = await image
          .resize(CELL_SIZE, CELL_SIZE, {
            fit: "cover",
            position: "center",
          })
          .toBuffer();
        const x = col * CELL_SIZE;
        const y = row * CELL_SIZE;
        compositeOperations.push({
          input: resizedImage,
          left: x,
          top: y,
        });
        processedImages++;
      }
    } catch (e) {
      console.error(`[ERROR] Failed to process: ${file.relativePath}`, e);
      continue;
    }
  }
  const thumbnailEnd = performance.now();
  const thumbnailTime = (thumbnailEnd - thumbnailStart) / 1000;
  const dirName = path.basename(args.directory);
  console.log(
    `[THUMB] ${processedImages} files in ${thumbnailTime.toFixed(
      2
    )}s - ${dirName}`
  );
  // Only save if we processed at least one image
  if (processedImages > 0) {
    // Apply all composite operations at once
    gridImage.composite(compositeOperations);
    // Save grid with specified JPEG quality
    const dirName = path.basename(args.directory);
    const parentDir = path.dirname(args.directory);
    const outputPath = path.join(parentDir, `${dirName}_pgrid.jpg`);
    // Generate JPEG buffer
    const jpegBuffer = await gridImage
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer();
    // Prepare metadata (include version, cache, and directory birthtimes)
    const metadata = {
      version: PGRID_VERSION,
      files: args.cache,
      directories: args.dirBirthtimes,
    };
    const metadataJson = JSON.stringify(metadata);
    const metadataBuffer = new TextEncoder().encode(metadataJson);
    // Create a special marker to identify our metadata
    const marker = new TextEncoder().encode("\n<!--PGGRID_METADATA:");
    const endMarker = new TextEncoder().encode("-->\n");
    // Combine JPEG + marker + metadata + end marker
    const finalBuffer = new Uint8Array(
      jpegBuffer.length +
        marker.length +
        metadataBuffer.length +
        endMarker.length
    );
    finalBuffer.set(jpegBuffer, 0);
    finalBuffer.set(marker, jpegBuffer.length);
    finalBuffer.set(metadataBuffer, jpegBuffer.length + marker.length);
    finalBuffer.set(
      endMarker,
      jpegBuffer.length + marker.length + metadataBuffer.length
    );
    // Write the combined file
    await Deno.writeFile(outputPath, finalBuffer);
    // Copy grid-viewer.html to the directory where pgrid was created
    await copyGridViewer(args.directory);
  }
}

export interface DirectoryIndexEntry {
  path: string;
  latestMtime: number;
  fileCount: number;
  birthtime: number;
}

export interface DirectoryBirthtimes {
  [relativePath: string]: number;
}

export interface DirectoryIndexData {
  version: number;
  directories: DirectoryIndexEntry[];
  generated: number;
}

function getDirectoryInfo(cache: Cache) {
  let latestMtime = 0;
  let fileCount = 0;
  for (const entry of Object.values(cache)) {
    fileCount++;
    if (entry.mtime > latestMtime) {
      latestMtime = entry.mtime;
    }
  }
  return { latestMtime, fileCount };
}

async function writeDirectoryIndex(
  directory: string,
  entries: DirectoryIndexEntry[]
) {
  const indexPath = path.join(directory, ".pgrid_index.json");
  const indexData: DirectoryIndexData = {
    version: PGRID_VERSION,
    directories: entries,
    generated: Date.now(),
  };
  await Deno.writeTextFile(indexPath, JSON.stringify(indexData, null, 2));
}

interface ProcessStats {
  totalNewFiles: number;
  indexEntries: DirectoryIndexEntry[];
  pgridsGenerated: number;
  pgridsSkipped: number;
  totalFilesProcessed: number;
}

async function processAllDirectories(rootDir: string): Promise<ProcessStats> {
  // Single scan to collect all directories, files, and subdirectory relationships
  const scanResult = await scanAllDirectoriesAndFiles(rootDir);

  // Sort by depth (deepest first) for proper index aggregation
  const allDirectories = [...scanResult.directories];
  allDirectories.sort((a, b) => {
    const depthA = a.split(path.SEPARATOR).length;
    const depthB = b.split(path.SEPARATOR).length;
    return depthB - depthA; // Deepest first
  });

  // Track results per directory for index aggregation
  const dirResults = new Map<
    string,
    { cache: Cache; indexEntries: DirectoryIndexEntry[] }
  >();

  let totalNewFiles = 0;
  let pgridsGenerated = 0;
  let pgridsSkipped = 0;
  let totalFilesProcessed = 0;

  // Process each directory (deepest first)
  console.log(`[PROCESS] Starting: ${allDirectories.length} directories`);
  const processStart = performance.now();
  let directoriesProcessed = 0;
  const PROGRESS_INTERVAL = 10; // Log progress every N directories

  for (const directory of allDirectories) {
    const result = await processDirectoryWithScanResult(directory, scanResult);

    totalNewFiles += result?.newFilesCount || 0;
    const filesInDir = Object.keys(result.cache).length;
    totalFilesProcessed += filesInDir;

    const allIndexEntries: DirectoryIndexEntry[] = [];

    // Check if this directory has a pgrid
    const dirInfo = getDirectoryInfo(result.cache);
    if (dirInfo.fileCount > 0) {
      pgridsGenerated++;
      const relativePath = path.relative(rootDir, directory);
      allIndexEntries.push({
        path: relativePath || ".",
        latestMtime: dirInfo.latestMtime,
        fileCount: dirInfo.fileCount,
        birthtime: result.dirBirthtime,
      });
    } else if (filesInDir === 0) {
      pgridsSkipped++;
    }

    // Collect index entries from already-processed subdirectories (using cached data)
    const subdirs = scanResult.subdirsByDir.get(directory) || [];
    for (const subDirPath of subdirs) {
      const subDirResult = dirResults.get(subDirPath);
      if (subDirResult) {
        allIndexEntries.push(...subDirResult.indexEntries);
      }
    }

    // Write index file for this directory if we have any entries
    if (allIndexEntries.length > 0) {
      await writeDirectoryIndex(directory, allIndexEntries);
    }

    // Store results for parent directory to aggregate
    dirResults.set(directory, {
      cache: result.cache,
      indexEntries: allIndexEntries,
    });

    directoriesProcessed++;

    // Log progress periodically
    if (directoriesProcessed % PROGRESS_INTERVAL === 0) {
      const elapsed = (performance.now() - processStart) / 1000;
      const remaining = allDirectories.length - directoriesProcessed;
      console.log(
        `[PROCESS] ${directoriesProcessed}/${
          allDirectories.length
        } dirs, ${pgridsGenerated} pgrids, ${remaining} remaining (${elapsed.toFixed(
          1
        )}s)`
      );
    }
  }

  const processEnd = performance.now();
  const processDuration = (processEnd - processStart) / 1000;
  const avgTime = (processDuration * 1000) / directoriesProcessed;
  console.log(
    `[PROCESS] Completed in ${processDuration.toFixed(
      1
    )}s: ${directoriesProcessed} dirs, ${pgridsGenerated} pgrids (${avgTime.toFixed(
      1
    )}ms/dir avg)`
  );

  // Get the root's index entries
  const rootResult = dirResults.get(rootDir);

  return {
    totalNewFiles,
    indexEntries: rootResult?.indexEntries || [],
    pgridsGenerated,
    pgridsSkipped,
    totalFilesProcessed,
  };
}

// Main execution
if (import.meta.main) {
  const scriptStart = performance.now();
  const rootDir = Deno.args[0];
  if (!rootDir) {
    console.error("Usage: grid.ts <directory>");
    Deno.exit(1);
  }
  try {
    // Check for required dependencies first
    await checkDependencies();
    const dirInfo = await Deno.stat(rootDir);
    if (!dirInfo.isDirectory) {
      console.error(`Error: ${rootDir} is not a directory`);
      Deno.exit(1);
    }
    const result = await processAllDirectories(rootDir);
    const scriptEnd = performance.now();
    const totalTime = (scriptEnd - scriptStart) / 1000;
    console.log(`\n[SUMMARY] Completed in ${totalTime.toFixed(1)}s`);
    console.log(
      `[SUMMARY] ${result.totalFilesProcessed} files (${
        result.totalNewFiles
      } new, ${result.totalFilesProcessed - result.totalNewFiles} cached)`
    );
    console.log(
      `[SUMMARY] ${result.pgridsGenerated} pgrids generated, ${result.pgridsSkipped} skipped`
    );
    console.log(`[SUMMARY] Index: ${result.indexEntries.length} directories`);
    Deno.exit(0);
  } catch (e: unknown) {
    const scriptEnd = performance.now();
    const totalTime = (scriptEnd - scriptStart) / 1000;
    console.error(
      `[ERROR] Failed after ${totalTime.toFixed(1)}s: ${
        e instanceof Error ? e.message : String(e)
      }`
    );
    Deno.exit(1);
  }
}
