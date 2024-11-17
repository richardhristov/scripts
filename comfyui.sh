#!/bin/bash

# Default values
HOST=""
WORKFLOW=""
REPEATS=1
TEXTS=()

# Parse named arguments
while [[ "$#" -gt 0 ]]; do
    case $1 in
        --host) HOST="$2"; shift ;;
        --workflow) WORKFLOW="$2"; shift ;;
        --repeats) REPEATS="$2"; shift ;;
        *) TEXTS+=("$1") ;;
    esac
    shift
done

# Validate required arguments
if [ -z "$HOST" ]; then
    echo "Error: --host is required"
    echo "Usage: $0 --host <host> --workflow <workflow> [--repeats <n>] <text1> <text2> ..."
    exit 1
fi

if [ -z "$WORKFLOW" ]; then
    echo "Error: --workflow is required"
    echo "Usage: $0 --host <host> --workflow <workflow> [--repeats <n>] <text1> <text2> ..."
    exit 1
fi

if [ ${#TEXTS[@]} -eq 0 ]; then
    echo "Error: at least one text argument is required"
    echo "Usage: $0 --host <host> --workflow <workflow> [--repeats <n>] <text1> <text2> ..."
    exit 1
fi

# Process each text
for TEXT in "${TEXTS[@]}"; do
    # Read and process JSON workflow file
    json=$(cat "./comfyui_workflows/$WORKFLOW.json")
    json=$(echo "$json" | sed "s/__TEXT__/$TEXT/g")
    json=$(echo "$json" | sed "s/__HOST__/$HOST/g")
    json=$(echo "$json" | sed "s/__WORKFLOW__/$WORKFLOW/g")

    # Make API request n times
    for ((i=1; i<=$REPEATS; i++)); do
        rand=$(($RANDOM * 1000000000))
        current_json=$(echo "$json" | sed "s/-1/$rand/g")
        
        curl "http://$HOST:8188/api/prompt" \
            -H 'Accept: */*' \
            -H 'Accept-Language: en-US,en;q=0.9' \
            -H 'Cache-Control: max-age=0' \
            -H 'Connection: keep-alive' \
            -H 'Content-Type: application/json' \
            -H "Origin: http://$HOST:8188" \
            -H "Referer: http://$HOST:8188/" \
            -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' \
            --data-raw "$current_json" \
            --insecure
    done
done
