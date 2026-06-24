TIMESTAMP=$(date +%s)
zip -r sharedlist-${TIMESTAMP}.zip . -x "*.zip" -x *.DS_Store -x *release.sh