#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env --allow-ffi --allow-net

import sharp from "npm:sharp@0.34.1";

interface MediaItem {
  path: string;
  type: "image" | "video";
  name: string;
  size: { width: number; height: number };
  fileSize?: number;
  mtime?: number;
}

interface MediaCacheEntry {
  name: string;
  size: { width: number; height: number };
  fileSize: number;
  mtime: number;
}

const SUPPORTED_IMAGE_EXTENSIONS = [
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".bmp",
  ".tiff",
];
const SUPPORTED_VIDEO_EXTENSIONS = [
  ".mp4",
  ".webm",
  ".avi",
  ".mov",
  ".mkv",
  ".flv",
  ".wmv",
];

async function getMediaFiles(
  dirPath: string,
  cache: Record<string, MediaCacheEntry>
): Promise<MediaItem[]> {
  const mediaItems: MediaItem[] = [];

  try {
    for await (const entry of Deno.readDir(dirPath)) {
      if (entry.isFile) {
        const ext = entry.name
          .toLowerCase()
          .substring(entry.name.lastIndexOf("."));
        if (
          [
            ...SUPPORTED_IMAGE_EXTENSIONS,
            ...SUPPORTED_VIDEO_EXTENSIONS,
          ].includes(ext)
        ) {
          const type = SUPPORTED_IMAGE_EXTENSIONS.includes(ext)
            ? "image"
            : "video";
          const fullPath = `${dirPath}/${entry.name}`;
          let size = { width: 0, height: 0 };
          let fileSize = 0;
          let mtime = 0;
          try {
            const stat = await Deno.stat(fullPath);
            fileSize = stat.size;
            mtime = stat.mtime ? stat.mtime.getTime() : 0;
          } catch (e) {
            console.warn(`Could not stat file ${fullPath}:`, e);
          }
          if (type === "image") {
            const cacheEntry = cache[entry.name];
            if (
              cacheEntry &&
              cacheEntry.fileSize === fileSize &&
              cacheEntry.mtime === mtime
            ) {
              size = cacheEntry.size;
            } else {
              try {
                const imageData = await Deno.readFile(fullPath);
                const image = sharp(imageData);
                const metadata = await image.metadata();
                if (metadata.width && metadata.height) {
                  size = { width: metadata.width, height: metadata.height };
                }
              } catch (e) {
                console.warn(`Could not read image size for ${fullPath}:`, e);
              }
            }
          } else if (type === "video") {
            const cacheEntry = cache[entry.name];
            if (
              cacheEntry &&
              cacheEntry.fileSize === fileSize &&
              cacheEntry.mtime === mtime
            ) {
              size = cacheEntry.size;
            } else {
              try {
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
                    fullPath,
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
              } catch (e) {
                console.warn(`Could not get video size for ${fullPath}:`, e);
              }
            }
          }
          mediaItems.push({
            path: fullPath,
            type,
            name: entry.name,
            size,
            fileSize,
            mtime,
          });
        }
      }
    }
  } catch (error) {
    console.error(`Error scanning directory: ${error}`);
  }

  return mediaItems.sort((a, b) => a.name.localeCompare(b.name));
}

function generateHTML(mediaItems: MediaItem[], dirPath: string): string {
  // Create a virtualized grid that only loads visible items
  const itemsHTML = mediaItems
    .map((item, index) => {
      let aspectStyle = "";
      if (item.size.width > 0 && item.size.height > 0) {
        aspectStyle = `style=\"aspect-ratio: ${item.size.width} / ${item.size.height};\"`;
      }
      return `<div class="media-item" data-index="${index}" data-type="${item.type}" data-src="file://${item.path}" ${aspectStyle}>
        <div class="media-placeholder">
          Loading...
        </div>
      </div>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Media Viewer - ${dirPath.split("/").pop()}</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #0a0a0a;
            color: #fff;
            overflow-x: hidden;
            user-select: none;
        }

        .header {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            background: rgba(0, 0, 0, 0.9);
            backdrop-filter: blur(10px);
            padding: 1rem;
            z-index: 1000;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .header h1 {
            font-size: 1.5rem;
            font-weight: 600;
        }

        .controls {
            display: flex;
            gap: 1rem;
            align-items: center;
            font-size: 0.9rem;
            opacity: 0.8;
        }
        
        #zoom-slider {
            vertical-align: middle;
        }

        :root {
            --item-width: 22vw;
            --gap: 8px;
        }
        .masonry-grid {
            margin-top: 80px;
            column-width: var(--item-width);
            column-gap: var(--gap);
        }
        .media-item {
            display: inline-block;
            width: 100%;
            margin: 0 0 var(--gap) 0;
            break-inside: avoid;
            border: none;
            border-radius: 0;
            overflow: hidden;
            cursor: pointer;
            background: #1a1a1a;
            transition: box-shadow 0.2s;
            position: relative;
            box-sizing: border-box;
        }
        .media-item.selected {
            outline: 3px solid #ff6b6b;
        }
        .media-item img,
        .media-item video {
            width: 100%;
            height: auto;
            display: block;
            object-fit: cover;
        }
        .media-item video {
            background: #000;
        }
        .media-placeholder {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: #1a1a1a;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #666;
        }
        .media-item.loaded .media-placeholder {
            display: none;
            opacity: 0;
            pointer-events: none;
        }
        .fullscreen-overlay {
            display: flex;
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.95);
            z-index: 2000;
            justify-content: center;
            align-items: center;
            padding: 2rem;
            opacity: 0;
            pointer-events: none;
            transition: opacity 0.3s ease;
        }
        .fullscreen-overlay.active {
            opacity: 1;
            pointer-events: all;
        }
        .fullscreen-content {
            max-width: 100vw;
            max-height: 100vh;
            position: relative;
        }
        .fullscreen-content img,
        .fullscreen-content video {
            max-width: 100vw;
            max-height: 100vh;
            object-fit: contain;
        }
        .loading {
            text-align: center;
            padding: 2rem;
            font-size: 1.2rem;
            opacity: 0.7;
        }
        .scroll-indicator {
            position: fixed;
            bottom: 2rem;
            right: 2rem;
            background: rgba(0, 0, 0, 0.8);
            color: white;
            padding: 0.5rem 1rem;
            border-radius: 20px;
            font-size: 0.9rem;
            z-index: 1000;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>${dirPath.split("/").pop()}</h1>
        <div class="controls">
            <span>Zoom: <input type="range" id="zoom-slider" min="12" max="40" value="22" step="1"></span>
            <span>← → Arrow keys to navigate</span>
            <span>Space to maximize</span>
            <span>ESC to close</span>
        </div>
    </div>

    <div class="masonry-grid" id="grid">
        ${itemsHTML}
    </div>

    <div class="fullscreen-overlay" id="fullscreen">
        <div class="fullscreen-content" id="fullscreen-media"></div>
    </div>

    <div class="scroll-indicator" id="scrollIndicator">
        <span id="currentIndex">0</span> / <span id="totalCount">${
          mediaItems.length
        }</span>
    </div>

    <script>
        let currentIndex = 0;
        let items = [];
        let isFullscreen = false;

        document.addEventListener('DOMContentLoaded', function() {
            items = Array.from(document.querySelectorAll('.media-item'));
            updateSelection();
            updateScrollIndicator();

            // Load images/videos into grid
            items.forEach((item, index) => {
                const type = item.dataset.type;
                const src = item.dataset.src;
                if (type === 'image') {
                    const img = document.createElement('img');
                    img.src = src;
                    img.onload = () => {
                        item.classList.add('loaded');
                    };
                    img.onerror = () => item.querySelector('.media-placeholder').textContent = 'Failed to load';
                    item.appendChild(img);
                } else if (type === 'video') {
                    const video = document.createElement('video');
                    video.src = src;
                    video.muted = true;
                    video.loop = true;
                    video.playsInline = true;
                    video.onloadeddata = () => {
                        item.classList.add('loaded');
                    };
                    video.onerror = () => item.querySelector('.media-placeholder').textContent = 'Failed to load';
                    item.appendChild(video);
                }
            });

            // Click to select items
            items.forEach((item, index) => {
                item.addEventListener('click', () => {
                    currentIndex = index;
                    updateSelection();
                    updateScrollIndicator();
                    scrollToCurrent();
                });
            });

            // Zoom slider: adjust CSS column width
            const zoomSlider = document.getElementById('zoom-slider');
            zoomSlider.addEventListener('input', (e) => {
                const width = e.target.value + 'vw';
                document.documentElement.style.setProperty('--item-width', width);
            });
        });

        // Keyboard navigation
        document.addEventListener('keydown', function(e) {
            if (isFullscreen) {
                if (e.key === 'Escape' || e.key === ' ') {
                    e.preventDefault();
                    closeFullscreen();
                }
                return;
            }
            // Calculate number of columns based on current CSS column layout
            const grid = document.getElementById('grid');
            const firstItem = items[0];
            let columns = 1;
            if (grid && firstItem) {
                const gap = parseInt(getComputedStyle(grid).getPropertyValue('column-gap')) || 0;
                const itemWidth = firstItem.offsetWidth + gap;
                columns = Math.max(1, Math.floor((grid.clientWidth + gap) / itemWidth));
            }
            switch(e.key) {
                case 'ArrowLeft':
                    e.preventDefault();
                    currentIndex = Math.max(0, currentIndex - columns);
                    break;
                case 'ArrowRight':
                    e.preventDefault();
                    currentIndex = Math.min(items.length - 1, currentIndex + columns);
                    break;
                case 'ArrowUp':
                    e.preventDefault();
                    currentIndex = Math.max(0, currentIndex - 1);
                    break;
                case 'ArrowDown':
                    e.preventDefault();
                    currentIndex = Math.min(items.length - 1, currentIndex + 1);
                    break;
                case ' ':
                    e.preventDefault();
                    openFullscreen();
                    break;
                case 'Home':
                    e.preventDefault();
                    currentIndex = 0;
                    break;
                case 'End':
                    e.preventDefault();
                    currentIndex = items.length - 1;
                    break;
            }
            updateSelection();
            updateScrollIndicator();
            scrollToCurrent();
        });
        function updateSelection() {
            items.forEach((item, index) => {
                item.classList.toggle('selected', index === currentIndex);
            });
        }
        function updateScrollIndicator() {
            document.getElementById('currentIndex').textContent = currentIndex + 1;
            document.getElementById('totalCount').textContent = items.length;
        }
        function scrollToCurrent() {
            if (items[currentIndex]) {
                items[currentIndex].scrollIntoView({
                    behavior: 'smooth',
                    block: 'center'
                });
            }
        }
        function openFullscreen() {
            const currentItem = items[currentIndex];
            if (!currentItem) return;
            const fullscreenMedia = document.getElementById('fullscreen-media');
            const type = currentItem.dataset.type;
            const src = currentItem.dataset.src;
            if (type === 'image') {
                fullscreenMedia.innerHTML = "<img src=" + src + " alt=" + "Image " + (currentIndex + 1) + ">";
            } else {
                const ext = src.split('.').pop();
                fullscreenMedia.innerHTML = "<video autoplay muted loop controls><source src=" + src + " type=" + "video/" + ext + "></video>";
            }
            document.getElementById('fullscreen').classList.add('active');
            isFullscreen = true;
        }
        function closeFullscreen() {
            document.getElementById('fullscreen').classList.remove('active');
            isFullscreen = false;
            document.getElementById('fullscreen-media').innerHTML = '';
        }
    </script>
</body>
</html>`;
}

async function main() {
  const args = Deno.args;

  if (args.length === 0) {
    console.error("Usage: media-viewer.ts <directory>");
    console.error("Example: media-viewer.ts ./porn");
    Deno.exit(1);
  }

  const dirPath = args[0];

  // Check if directory exists
  try {
    await Deno.stat(dirPath);
  } catch {
    console.error(`Directory not found: ${dirPath}`);
    Deno.exit(1);
  }

  const dirName = dirPath.split("/").pop();
  const parentDir = dirPath.substring(0, dirPath.lastIndexOf("/"));
  const outputPath = `${parentDir}/${dirName}_viewer.html`;
  const cachePath = `${parentDir}/${dirName}_viewer.json`;

  // Load cache if exists
  let cache: Record<string, MediaCacheEntry> = {};
  try {
    const cacheText = await Deno.readTextFile(cachePath);
    cache = JSON.parse(cacheText);
  } catch {}

  console.log(`Scanning directory: ${dirPath}`);
  const mediaItems = await getMediaFiles(dirPath, cache);

  if (mediaItems.length === 0) {
    console.log("No media files found in the directory");
    Deno.exit(0);
  }

  console.log(`Found ${mediaItems.length} media files`);

  // Update cache
  const newCache: Record<string, MediaCacheEntry> = {};
  for (const item of mediaItems) {
    newCache[item.name] = {
      name: item.name,
      size: item.size,
      fileSize: item.fileSize!,
      mtime: item.mtime!,
    };
  }
  await Deno.writeTextFile(cachePath, JSON.stringify(newCache, null, 2));

  // Generate HTML
  const html = generateHTML(mediaItems, dirPath);

  // Write to file one level up from the input directory
  await Deno.writeTextFile(outputPath, html);

  console.log(`Generated viewer: ${outputPath}`);
  console.log(`Generated cache: ${cachePath}`);
  console.log(`Open this file in your browser to start browsing efficiently!`);
}

if (import.meta.main) {
  main().catch(console.error);
}
