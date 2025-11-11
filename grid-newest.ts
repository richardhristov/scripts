#!/usr/bin/env -S deno run --allow-read

import * as path from "jsr:@std/path@1.1.1";
import type { DirectoryIndexData } from "./grid.ts";

async function readIndex(basePath: string) {
  const indexPath = path.join(basePath, ".pgrid_index.json");

  try {
    const indexText = await Deno.readTextFile(indexPath);
    const indexData: DirectoryIndexData = JSON.parse(indexText);
    return indexData.directories;
  } catch (e) {
    throw new Error(
      `Failed to read index file at ${indexPath}. Make sure you've run grid.ts first. Error: ${
        e instanceof Error ? e.message : String(e)
      }`
    );
  }
}

if (import.meta.main) {
  const basePath = Deno.args[0];

  if (!basePath) {
    console.error("Usage: grid-newest.ts <base-path>");
    console.error(
      "Reads .pgrid_index.json from the base path and prints directories sorted by newest modified file."
    );
    Deno.exit(1);
  }

  try {
    const baseStat = await Deno.stat(basePath);
    if (!baseStat.isDirectory) {
      console.error(`Error: ${basePath} is not a directory`);
      Deno.exit(1);
    }

    const normalizedBasePath = path.resolve(basePath);
    const entries = await readIndex(normalizedBasePath);

    // Sort by oldest first (ascending), so newest are at the bottom
    const sorted = [...entries].sort((a, b) => a.latestMtime - b.latestMtime);

    // Format dates and calculate column widths for alignment
    const formatted = sorted.map((entry) => {
      const date = new Date(entry.latestMtime);
      const dateStr = date.toLocaleString();
      return { path: entry.path, date: dateStr };
    });

    // Find max path length for alignment
    const maxPathLength = Math.max(
      ...formatted.map((f) => f.path.length),
      "Path".length
    );

    // Print header
    console.log(
      `${"Path".padEnd(maxPathLength)}  ${"Latest Modified".padEnd(20)}`
    );
    console.log(`${"-".repeat(maxPathLength)}  ${"-".repeat(20)}`);

    // Print rows
    for (const entry of formatted) {
      console.log(
        `${entry.path.padEnd(maxPathLength)}  ${entry.date.padEnd(20)}`
      );
    }
  } catch (e) {
    console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    Deno.exit(1);
  }
}
