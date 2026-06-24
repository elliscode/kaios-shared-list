TIMESTAMP=$(date +%s)
zip -r gpslocationsharer-${TIMESTAMP}.zip . -x "*.zip" -x .DS_Store -x release.sh