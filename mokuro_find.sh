#!/usr/bin/env bash
#
# Usage: mokuro_find.sh /path/to/dir
# 
# 1. Takes a single directory argument.
# 2. Finds all subdirectories in that directory (ignoring "_ocr").
# 3. For each such subdirectory, lists its subdirectories that *do not* have
#    a corresponding .html file of the same name.
# 4. Outputs those qualifying paths in a space-separated list.

# Exit immediately if any command fails or if any variable is uninitialized
set -o errexit
set -o nounset

# Check if exactly one argument was provided
if [[ "$#" -ne 1 ]]; then
  echo "Usage: $0 /path/to/dir" >&2
  exit 1
fi

# The directory we will inspect
TARGET_DIR="$1"

# Check that the argument is indeed a directory
if [[ ! -d "$TARGET_DIR" ]]; then
  echo "Error: '$TARGET_DIR' is not a directory or does not exist." >&2
  exit 1
fi

# Array to hold the results we want to output
RESULTS=()

# Iterate through all items at the root level of TARGET_DIR
for SUBDIR in "$TARGET_DIR"/*; do
  # Check that the item is a directory and its base name is not "_ocr"
  if [[ -d "$SUBDIR" && "$(basename "$SUBDIR")" != "_ocr" ]]; then
    
    # Now look for subdirectories inside SUBDIR
    for SUBSUBDIR in "$SUBDIR"/*; do
      # Only proceed if it is actually a directory
      [[ -d "$SUBSUBDIR" ]] || continue
      
      # Ignore subdirectories named "_ocr"
      if [[ "$(basename "$SUBSUBDIR")" == "_ocr" ]]; then
        continue
      fi
      
      # Check if there's no file with the same base name plus '.html' 
      # inside the current SUBDIR
      BASENAME="$(basename "$SUBSUBDIR")"
      if [[ ! -f "$SUBDIR/$BASENAME.html" ]]; then
        RESULTS+=("$SUBSUBDIR")
      fi
    done
  fi
done

# Print all qualifying paths in a space-separated list
printf '"%s" ' "${RESULTS[@]}"
