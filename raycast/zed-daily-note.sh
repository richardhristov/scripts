#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Zed Daily Note
# @raycast.mode silent

# Optional parameters:
# @raycast.icon images/zed.png

NOTES_DIR="$HOME/Documents/vault.nosync"
JOURNAL_DIR="$NOTES_DIR/journal"

# Today's filename (YYYY-MM-DD.md)
FILENAME="$(date +%F).md"
FILEPATH="$JOURNAL_DIR/$FILENAME"

if [ ! -f "$FILEPATH" ]; then
  touch "$FILEPATH"
fi

zed $NOTES_DIR $FILEPATH