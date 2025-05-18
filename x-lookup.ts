#!/usr/bin/env -S deno run --allow-read --allow-net

import { load } from "npm:cheerio@1.0.0-rc.12";

// Constants
const RATE_LIMIT_DELAY = 1000; // 1 second between requests
const MAX_CONCURRENT_REQUESTS = 5;
const TWITTER_USERNAME_REGEX = /^[A-Za-z0-9_]{1,15}$/;

// Utility function to delay execution
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Validate Twitter username
function isValidTwitterUsername(username: string) {
  return TWITTER_USERNAME_REGEX.test(username);
}

async function findDanbooruTag(twitterUsername: string) {
  const startTime = performance.now();
  const twitterUrl = `https://x.com/${twitterUsername}`;
  const searchUrl = `https://danbooru.donmai.us/artists?commit=Search&search%5Border%5D=created_at&search%5Bany_name_matches%5D=${encodeURIComponent(
    twitterUsername
  )}`;

  try {
    const response = await fetch(searchUrl);

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const html = await response.text();
    const $ = load(html);

    const artistRow = $('tr[id^="artist-"]')
      .filter((_, element) => {
        const danbooruTag = $(element)
          .find(".name-column a.tag-type-1")
          .text()
          .trim();

        // First check if the username matches the Danbooru tag exactly
        if (danbooruTag === twitterUsername) {
          return true;
        }

        // If not, check other names
        const otherNames = $(element)
          .find(".artist-other-name")
          .map((_, el) => $(el).text())
          .get();
        return otherNames.includes(twitterUsername);
      })
      .first();

    if (artistRow.length === 0) {
      return null;
    }

    const danbooruTag = artistRow
      .find(".name-column a.tag-type-1")
      .text()
      .trim();
    const endTime = performance.now();
    console.log(
      `Processed ${twitterUsername} in ${((endTime - startTime) / 1000).toFixed(
        2
      )}s`
    );

    return {
      x: twitterUrl,
      x_username: twitterUsername,
      danbooru_tag: danbooruTag,
    };
  } catch (error) {
    console.error(`Error processing ${twitterUsername}:`, error);
    return null;
  }
}

async function processUsernames(usernames: string[]) {
  const startTime = performance.now();
  const results: { x: string; x_username: string; danbooru_tag: string }[] = [];
  const validUsernames = usernames.filter(isValidTwitterUsername);

  if (validUsernames.length !== usernames.length) {
    console.warn(
      `Skipped ${usernames.length - validUsernames.length} invalid usernames`
    );
  }

  // Process usernames in chunks to limit concurrent requests
  for (let i = 0; i < validUsernames.length; i += MAX_CONCURRENT_REQUESTS) {
    const chunk = validUsernames.slice(i, i + MAX_CONCURRENT_REQUESTS);
    const chunkPromises = chunk.map(async (username) => {
      const result = await findDanbooruTag(username);
      if (result) {
        results.push(result);
      }
      await delay(RATE_LIMIT_DELAY);
    });

    await Promise.all(chunkPromises);

    // Report progress
    const progress = Math.min(
      ((i + chunk.length) / validUsernames.length) * 100,
      100
    );
    console.log(`Progress: ${progress.toFixed(1)}%`);
  }

  const endTime = performance.now();
  console.log(
    `Total processing time: ${((endTime - startTime) / 1000).toFixed(2)}s`
  );
  console.log(JSON.stringify(results, null, 2));
}

if (import.meta.main) {
  let usernames: string[];

  if (Deno.args.length === 0) {
    const decoder = new TextDecoder();
    const buffer = new Uint8Array(1024 * 1024); // 1MB buffer
    const n = await Deno.stdin.read(buffer);
    if (n === null) {
      console.error("No input received from stdin");
      Deno.exit(1);
    }
    const input = decoder.decode(buffer.subarray(0, n));
    usernames = input
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.includes("\x00"));
  } else {
    usernames = Deno.args;
  }

  if (usernames.length === 0) {
    console.error("Usage: x-lookup.ts <username1> [username2] [username3] ...");
    console.error("Or: cat usernames.txt | x-lookup.ts");
    Deno.exit(1);
  }

  await processUsernames(usernames);
}
