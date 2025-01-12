#!/bin/sh
set -euo pipefail
IFS=$'\n\t'

python -m venv ./f5_env
source ./f5_env/bin/activate
pip install f5-tts-mlx
deactivate
