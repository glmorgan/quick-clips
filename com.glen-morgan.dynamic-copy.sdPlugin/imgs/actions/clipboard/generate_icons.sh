#!/bin/bash

# Empty state - gray clipboard icon positioned in upper portion
magick -size 144x144 xc:none \
  -fill "#555555" \
  -draw "roundrectangle 52,30 92,80 4,4" \
  -draw "rectangle 62,25 82,35" \
  -draw "roundrectangle 67,27 77,33 2,2" \
  empty.png

magick -size 288x288 xc:none \
  -fill "#555555" \
  -draw "roundrectangle 104,60 184,160 8,8" \
  -draw "rectangle 124,50 164,70" \
  -draw "roundrectangle 134,54 154,66 4,4" \
  empty@2x.png

# Filled state - blue clipboard with checkmark positioned in upper portion
magick -size 144x144 xc:none \
  -fill "#4A90E2" \
  -draw "roundrectangle 52,30 92,80 4,4" \
  -draw "rectangle 62,25 82,35" \
  -draw "roundrectangle 67,27 77,33 2,2" \
  -fill "white" -stroke "white" -strokewidth 3 \
  -draw "polyline 60,50 68,58 84,42" \
  filled.png

magick -size 288x288 xc:none \
  -fill "#4A90E2" \
  -draw "roundrectangle 104,60 184,160 8,8" \
  -draw "rectangle 124,50 164,70" \
  -draw "roundrectangle 134,54 154,66 4,4" \
  -fill "white" -stroke "white" -strokewidth 6 \
  -draw "polyline 120,100 136,116 168,84" \
  filled@2x.png

# Locked state - blue clipboard with text lines and green lock (matching Stream Deck style)
magick -size 144x144 xc:none \
  -fill "#4A90E2" \
  -draw "roundrectangle 42,25 102,95 6,6" \
  -draw "rectangle 52,20 92,30" \
  -draw "roundrectangle 57,22 87,28 2,2" \
  -fill "#2E5C8A" \
  -draw "rectangle 50,40 94,43" \
  -draw "rectangle 50,50 94,53" \
  -draw "rectangle 50,60 80,63" \
  -fill "#4CAF50" -stroke "#4CAF50" -strokewidth 2.5 \
  -draw "circle 90,80 95,80" \
  -fill "none" \
  -draw "arc 86,71 94,79 180,0" \
  -fill "#4CAF50" \
  -draw "roundrectangle 86,79 94,89 1,1" \
  locked.png

magick -size 288x288 xc:none \
  -fill "#4A90E2" \
  -draw "roundrectangle 84,50 204,190 12,12" \
  -draw "rectangle 104,40 184,60" \
  -draw "roundrectangle 114,44 174,56 4,4" \
  -fill "#2E5C8A" \
  -draw "rectangle 100,80 188,86" \
  -draw "rectangle 100,100 188,106" \
  -draw "rectangle 100,120 160,126" \
  -fill "#4CAF50" -stroke "#4CAF50" -strokewidth 5 \
  -draw "circle 180,160 190,160" \
  -fill "none" \
  -draw "arc 172,142 188,158 180,0" \
  -fill "#4CAF50" \
  -draw "roundrectangle 172,158 188,178 2,2" \
  locked@2x.png

echo "Icons generated successfully"
