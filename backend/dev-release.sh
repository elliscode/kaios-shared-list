#!/bin/bash
cd lambda/
TIMESTAMP=$(date +%s)
zip -vr ../lambda-release-dev-${TIMESTAMP}.zip . -x "*.DS_Store"
cd ../
aws lambda update-function-code --function-name=kaios-gps-location-sharer-backend-dev --zip-file=fileb://lambda-release-dev-${TIMESTAMP}.zip --no-cli-pager