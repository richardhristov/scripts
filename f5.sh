#!/bin/sh
set -euo pipefail
IFS=$'\n\t'

source ./f5_env/bin/activate
cat "./f5_media/$1.txt" | xargs -0 -I XX python -m f5_tts_mlx.generate --text "$2" --ref-audio "./f5_media/$1.wav" --ref-text XX --output ~/Downloads/$(date +%s).wav
deactivate
