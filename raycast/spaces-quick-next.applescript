#!/usr/bin/osascript

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Spaces Quick Next
# @raycast.mode silent

# Optional parameters:
# @raycast.icon images/satania.jpeg

set curr to do shell script "vendor/whatspace"
set next to curr+1

tell application "System Events" to key code 17+next using {control down}