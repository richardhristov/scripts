#!/bin/sh
set -euo pipefail
IFS=$'\n\t'

python -m venv ./voice_env
source ./voice_env/bin/activate
pip install f5-tts-mlx
deactivate
