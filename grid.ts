#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env --allow-ffi

import sharp from "npm:sharp@0.34.1";
import * as path from "jsr:@std/path";
import { mimeType } from "npm:mime-type@5.0.3/with-db";

const JPEG_QUALITY = 85;
const CELL_SIZE = 360;
const GRID_SIZE = CELL_SIZE * 2;

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
    console.error(`Error creating thumbnail for ${args.path}:`, e);
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
      isMediaFile(path.join(safeDirectory, entry.name)) &&
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
  // Randomly select GRID_SIZE images (or less if not enough)
  const selectedFiles = mediaFiles
    .sort(() => Math.random() - 0.5)
    .slice(0, GRID_SIZE);
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
  const cellsPerRow = GRID_SIZE / CELL_SIZE;
  // Place images in grid
  for (let idx = 0; idx < selectedFiles.length; idx++) {
    const filePath = selectedFiles[idx];
    const row = Math.floor(idx / cellsPerRow);
    const col = idx % cellsPerRow;
    try {
      let image: sharp.Sharp | null;
      if (isVideoFile(filePath)) {
        image = await getVideoThumbnail({
          path: filePath,
          width: CELL_SIZE,
          height: CELL_SIZE,
        });
      } else {
        const imageData = await Deno.readFile(filePath);
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
