#!/bin/bash
cd lambda/
TIMESTAMP=$(date +%s)
zip -vr ../lambda-release-prod-${TIMESTAMP}.zip . -x "*.DS_Store"
cd ../
aws lambda update-function-code --function-name=shared-list-api-prod --zip-file=fileb://lambda-release-prod-${TIMESTAMP}.zip --no-cli-pager