#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env --allow-ffi --allow-net

import sharp from "npm:sharp@0.34.1";
import * as path from "jsr:@std/path";
import { load } from "npm:cheerio@1.0.0-rc.12";
import { Buffer } from "node:buffer";

const JPEG_QUALITY = 85;
const CELL_SIZE = 360;
const GRID_SIZE = CELL_SIZE * 2;

async function fetchImages(artist: string) {
  const url = `https://danbooru.donmai.us/posts?tags=${encodeURIComponent(
    artist
  )}`;
  const response = await fetch(url);
  const html = await response.text();
  const $ = load(html);

  const postIds: string[] = [];
  $("article.post-preview")
    .slice(0, 4)
    .each((_, element) => {
      const postId = $(element).attr("data-id");
      if (postId) {
        postIds.push(postId);
      }
    });

  const imagePromises = postIds.map(async (postId) => {
    const postUrl = `https://danbooru.donmai.us/posts/${postId}?q=${encodeURIComponent(
      artist
    )}`;
    const postResponse = await fetch(postUrl);
    const postHtml = await postResponse.text();
    const $post = load(postHtml);

    const sourceUrl = $post("section.image-container").attr("data-file-url");
    if (!sourceUrl) {
      throw new Error(`No source URL found for post ${postId}`);
    }

    // Download and process the image immediately
    const imageResponse = await fetch(sourceUrl);
    const imageBuffer = await imageResponse.arrayBuffer();
    return sharp(Buffer.from(imageBuffer))
      .resize(CELL_SIZE, CELL_SIZE, {
        fit: "cover",
        position: "center",
        background: { r: 0, g: 0, b: 0, alpha: 1 },
      })
      .toBuffer()
      .then((buffer) => ({
        input: buffer,
        left: (postIds.indexOf(postId) % 2) * CELL_SIZE,
        top: Math.floor(postIds.indexOf(postId) / 2) * CELL_SIZE,
      }));
  });

  return Promise.all(imagePromises);
}

async function createGrid(composites: sharp.OverlayOptions[], artist: string) {
  if (composites.length !== 4) {
    throw new Error("Expected exactly 4 images");
  }

  const outputPath = path.join(Deno.cwd(), `${artist}_pgrid.jpg`);
  await sharp({
    create: {
      width: GRID_SIZE,
      height: GRID_SIZE,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 1 },
    },
  })
    .composite(composites)
    .jpeg({ quality: JPEG_QUALITY })
    .toFile(outputPath);

  console.log(`Grid saved to ${outputPath}`);
}

async function processArtist(artist: string) {
  console.log(`Processing artist: ${artist}`);
  const startTime = performance.now();

  try {
    const composites = await fetchImages(artist);
    await createGrid(composites, artist);

    const endTime = performance.now();
    const duration = ((endTime - startTime) / 1000).toFixed(2);
    console.log(`Completed ${artist} in ${duration}s`);
  } catch (error: unknown) {
    console.error(
      `Error processing ${artist}:`,
      error instanceof Error ? error.message : String(error)
    );
  }
}

if (import.meta.main) {
  const artists = Deno.args;
  if (artists.length === 0) {
    console.error("Usage: grid-booru.ts <artist1> [artist2] [artist3] ...");
    Deno.exit(1);
  }

  const startTime = performance.now();

  // Process artists in series
  for (const artist of artists) {
    await processArtist(artist);
  }

  const endTime = performance.now();
  const totalDuration = ((endTime - startTime) / 1000).toFixed(2);
  console.log(`\nTotal processing time: ${totalDuration}s`);
}
