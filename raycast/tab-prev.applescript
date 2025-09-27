#!/usr/bin/osascript

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Tab Quick Prev
# @raycast.mode silent

# Optional parameters:
# @raycast.icon images/satania.jpeg

tell application "System Events"
    -- Get list of running processes that are visible applications
    set appList to (name of every process where background only is false)
    
    -- Get the currently active application
    set currentApp to name of first process where frontmost is true
    
    -- Find the index of current app in the list
    set currentIndex to 0
    repeat with i from 1 to count of appList
        if item i of appList is currentApp then
            set currentIndex to i
            exit repeat
        end if
    end repeat
    
    -- Calculate the previous index (wrap around to last if at beginning)
    set prevIndex to currentIndex - 1
    if prevIndex < 1 then
        set prevIndex to (count of appList)
    end if
    
    -- Activate the previous application
    set prevApp to item prevIndex of appList
    tell process prevApp to set frontmost to true
end tell