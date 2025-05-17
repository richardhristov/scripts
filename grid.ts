#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env --allow-ffi

import sharp from "npm:sharp@0.34.1";
import * as path from "jsr:@std/path";

const GRID_SIZE = { width: 3, height: 3 };
const CELL_SIZE = { width: 256, height: 256 };
const JPEG_QUALITY = 85;

function isMediaFile(filename: string) {
  const mediaExtensions = [
    // Images
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".webp",
    ".bmp",
    ".tiff",
    ".tif",
    ".heic",
    ".heif",
    ".avif",
    ".svg",
    ".raw",
    ".cr2",
    ".nef",
    ".arw",
    // Videos
    ".mp4",
    ".webm",
    ".mov",
    ".avi",
    ".mkv",
    ".m4v",
    ".mpeg",
    ".mpg",
    ".3gp",
    ".flv",
    ".wmv",
    ".ts",
    ".mts",
    ".m2ts",
    ".vob",
    ".ogv",
  ];
  return mediaExtensions.includes(path.extname(filename).toLowerCase());
}

function isVideoFile(filename: string) {
  const videoExtensions = [
    ".mp4",
    ".webm",
    ".mov",
    ".avi",
    ".mkv",
    ".m4v",
    ".mpeg",
    ".mpg",
    ".3gp",
    ".flv",
    ".wmv",
    ".ts",
    ".mts",
    ".m2ts",
    ".vob",
    ".ogv",
    ".heic",
    ".heif", // Some HEIC/HEIF files can contain video
  ];
  return videoExtensions.includes(path.extname(filename).toLowerCase());
}

async function temporaryFile(options: { suffix: string }) {
  const tmpDir = await Deno.makeTempDir();
  const tmpFile = await Deno.makeTempFile({
    dir: tmpDir,
    suffix: options.suffix,
  });
  return { tmpFile, tmpDir };
}

async function getVideoThumbnail(
  videoPath: string,
  cellSize: { width: number; height: number }
) {
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
        videoPath,
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
        videoPath,
        "-vframes",
        "1",
        "-vf",
        `scale=${cellSize.width}:${cellSize.height}:force_original_aspect_ratio=increase,crop=${cellSize.width}:${cellSize.height}`,
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
    console.error(`Error creating thumbnail for ${videoPath}:`, e);
    return null;
  } finally {
    // Clean up temporary file and directory
    if (tmpPath) {
      try {
        await Deno.remove(tmpPath);
      } catch (e) {
        console.error(`Error cleaning up temporary file ${tmpPath}:`, e);
      }
    }
    if (tmpDir) {
      try {
        await Deno.remove(tmpDir, { recursive: true });
      } catch (e) {
        console.error(`Error cleaning up temporary directory ${tmpDir}:`, e);
      }
    }
  }
}

function validatePath(directory: string) {
  const normalizedPath = path.normalize(directory);
  if (normalizedPath.includes("..")) {
    throw new Error("Path traversal detected");
  }
  return normalizedPath;
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
      `Error: Required dependencies are missing: ${missingCommands.join(", ")}`
    );
    console.error("Please install them using your system's package manager.");
    Deno.exit(1);
  }
}

async function createPreviewGrid(directory: string) {
  // Validate and normalize the directory path
  const safeDirectory = validatePath(directory);

  // Get all media files in directory
  const mediaFiles: string[] = [];
  const scanStart = performance.now();
  for await (const entry of Deno.readDir(safeDirectory)) {
    if (
      entry.isFile &&
      isMediaFile(entry.name) &&
      !entry.name.endsWith("_pgrid.jpg")
    ) {
      mediaFiles.push(path.join(safeDirectory, entry.name));
    }
  }
  const scanEnd = performance.now();
  console.log(
    `Directory scan took ${(scanEnd - scanStart).toFixed(2)}ms (found ${
      mediaFiles.length
    } media files) - ${safeDirectory}`
  );

  if (mediaFiles.length === 0) {
    return false;
  }

  // Randomly select 9 images (or less if not enough)
  const selectedFiles = mediaFiles.sort(() => Math.random() - 0.5).slice(0, 9);

  // Create grid image
  const gridWidth = CELL_SIZE.width * GRID_SIZE.width;
  const gridHeight = CELL_SIZE.height * GRID_SIZE.height;
  const gridImage = sharp({
    create: {
      width: gridWidth,
      height: gridHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  });

  let processedImages = 0;
  const compositeOperations = [];
  const thumbnailStart = performance.now();

  // Place images in grid
  for (let idx = 0; idx < selectedFiles.length; idx++) {
    const filePath = selectedFiles[idx];
    const row = Math.floor(idx / GRID_SIZE.width);
    const col = idx % GRID_SIZE.width;

    try {
      let image: sharp.Sharp | null;

      if (isVideoFile(filePath)) {
        image = await getVideoThumbnail(filePath, CELL_SIZE);
      } else {
        const imageData = await Deno.readFile(filePath);
        image = sharp(imageData);
      }

      if (image) {
        const resizedImage = await image
          .resize(CELL_SIZE.width, CELL_SIZE.height, {
            fit: "cover",
            position: "center",
          })
          .toBuffer();

        const x = col * CELL_SIZE.width;
        const y = row * CELL_SIZE.height;

        compositeOperations.push({
          input: resizedImage,
          left: x,
          top: y,
        });

        processedImages++;
      }
    } catch (e) {
      console.error(`Error processing ${filePath}:`, e);
      continue;
    }
  }

  const thumbnailEnd = performance.now();
  console.log(
    `Thumbnail generation took ${(thumbnailEnd - thumbnailStart).toFixed(
      2
    )}ms (processed ${processedImages} files) - ${safeDirectory}`
  );

  // Only save if we processed at least one image
  if (processedImages > 0) {
    // Apply all composite operations at once
    gridImage.composite(compositeOperations);

    // Save grid with specified JPEG quality
    const dirName = path.basename(safeDirectory);
    const parentDir = path.dirname(safeDirectory);
    const outputPath = path.join(parentDir, `${dirName}_pgrid.jpg`);
    await gridImage.jpeg({ quality: JPEG_QUALITY }).toFile(outputPath);
    return true;
  }

  return false;
}

async function processDirectory(directory: string) {
  // Process current directory
  if (await createPreviewGrid(directory)) {
    console.log(`Created preview for ${directory}`);
  }

  // Process subdirectories
  for await (const entry of Deno.readDir(directory)) {
    if (entry.isDirectory) {
      await processDirectory(path.join(directory, entry.name));
    }
  }
}

// Main execution
if (import.meta.main) {
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

    await processDirectory(rootDir);
    Deno.exit(0);
  } catch (e: unknown) {
    console.error(
      `Error processing directory: ${
        e instanceof Error ? e.message : String(e)
      }`
    );
    Deno.exit(1);
  }
}
