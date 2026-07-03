TIMESTAMP=$(date +%s)
zip -r sharedlist-${TIMESTAMP}.zip . \
  -x "*.zip" \
  -x "*.DS_Store" \
  -x "*.md" \
  -x "*release.sh" \
  -x "assets/banner.png" \
  -x "assets/banner_large.png" \
  -x "assets/screenshot01.png" \
  -x "assets/screenshot02.png" \
  -x "assets/screenshot03.png" \
  -x "assets/screenshot04.png" \
  -x "assets/favicon.png" \
  -x "assets/apple-touch-icon.png" \
  -x "assets/share.svg"