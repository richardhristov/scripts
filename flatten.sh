#!/bin/bash

# This script flattens a directory structure by moving all files
# to the top-level of the specified directory and renaming them
# with their original path components as prefixes.

# Check if the directory argument is provided
if [ -z "$1" ]; then
    echo "Usage: $0 <directory_to_flatten>"
    exit 1
fi

# Get the directory to flatten
TARGET_DIR="$1"

# Check if the directory exists
if [ ! -d "$TARGET_DIR" ]; then
    echo "Error: Directory '$TARGET_DIR' does not exist."
    exit 1
fi

# Save the current directory
CUR_DIR="$(pwd)"

# Change to the target directory
cd "$TARGET_DIR" || exit

# Find all files in the directory tree
find . -type f -print0 | while IFS= read -r -d '' filepath; do
    # Remove the leading './' from the path
    relpath="${filepath#./}"
    # Replace all '/' with '_'
    newname="${relpath//\//_}"
    # Handle files starting with a dash
    newname="${newname/#-/_}"

    # Check if the new filename already exists to avoid overwriting
    if [ -e "./$newname" ]; then
        i=1
        # Use parameter expansion to handle files without extensions
        if [[ "$newname" == *.* ]]; then
            base="${newname%.*}"
            ext=".${newname##*.}"
        else
            base="$newname"
            ext=""
        fi
        while [ -e "./${base}_$i$ext" ]; do
            i=$((i + 1))
        done
        newname="${base}_$i$ext"
    fi
    # Move the file to the top-level directory with the new name
    mv -- "$filepath" "./$newname"
done

# Remove empty directories
find . -type d -empty -delete

# Change back to the original directory
cd "$CUR_DIR"
