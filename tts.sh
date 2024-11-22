#!/bin/bash

# Default values
VOICE="en-US-AshleyNeural"
RATE=0
PITCH=25
TEXT=""

# Parse named arguments
while [[ "$#" -gt 0 ]]; do
    case $1 in
        --voice) VOICE="$2"; shift ;;
        --rate) RATE="$2"; shift ;;
        --pitch) PITCH="$2"; shift ;;
        *) TEXT="$1" ;;
    esac
    shift
done

# Load environment variables
source .env

# Validate required arguments
if [ -z "$AZURE_TTS_KEY" ]; then
    echo "Error: AZURE_TTS_KEY is not set"
    exit 1
fi

if [ -z "$AZURE_REGION" ]; then
    echo "Error: AZURE_REGION is not set"
    exit 1
fi

if [ -z "$TEXT" ]; then
    echo "Error: no text provided"
    exit 1
fi

# Build SSML
SSML=$(cat << EOF
<speak version="1.0" xml:lang="en-US">
    <voice name="${VOICE}">
        <prosody rate="${RATE}%" pitch="${PITCH}%">
            ${TEXT}
        </prosody>
    </voice>
</speak>
EOF
)

echo "$SSML"

curl -X POST "https://${AZURE_REGION}.tts.speech.microsoft.com/cognitiveservices/v1" \
    -H "Ocp-Apim-Subscription-Key: $AZURE_TTS_KEY" \
    -H "Content-Type: application/ssml+xml" \
    -H "X-Microsoft-OutputFormat: audio-16khz-32kbitrate-mono-mp3" \
    -H "User-Agent: curl" \
    -d "$SSML"
