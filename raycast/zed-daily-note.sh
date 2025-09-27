#!/bin/bash

NOTES_DIR="$HOME/Documents/vault.nosync"
JOURNAL_DIR="$NOTES_DIR/journal"

# Today's filename (YYYY-MM-DD.md)
FILENAME="$(date +%F).md"
FILEPATH="$JOURNAL_DIR/$FILENAME"

if [ ! -f "$FILEPATH" ]; then
  touch "$FILEPATH"
fi

zed $NOTES_DIR $FILEPATH