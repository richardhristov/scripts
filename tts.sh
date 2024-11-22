#!/bin/bash

# Default values
PITCH=+40Hz
VOICE="en-US-AriaNeural"
TEXT=""

# Parse named arguments
while [[ "$#" -gt 0 ]]; do
    case $1 in
        --pitch) PITCH="$2"; shift ;;
        --voice) VOICE="$2"; shift ;;
        *) TEXT="$1" ;;
    esac
    shift
done

edge-playback --pitch=$PITCH --voice=$VOICE --text "$TEXT"
