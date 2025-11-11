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
  const nStr = Deno.args[1];

  if (!basePath || !nStr) {
    console.error("Usage: grid-random.ts <base-path> <n>");
    console.error(
      "Reads .pgrid_index.json from the base path and prints N random directories sorted alphabetically."
    );
    Deno.exit(1);
  }

  const n = parseInt(nStr, 10);
  if (isNaN(n) || n < 1) {
    console.error("Error: n must be a positive integer");
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

    // Randomly select n directories (or all if n is greater than available)
    const shuffled = [...entries].sort(() => Math.random() - 0.5);
    const selected = shuffled.slice(0, Math.min(n, entries.length));

    // Sort alphabetically by path
    selected.sort((a, b) => a.path.localeCompare(b.path));

    // Print relative paths
    for (const entry of selected) {
      console.log(entry.path);
    }
  } catch (e) {
    console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    Deno.exit(1);
  }
}
