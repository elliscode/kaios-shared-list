import json
import traceback

from shared_list.logger import log
from shared_list.utils import (
    path_equals,
    format_response,
    has_invalid_domain,
)


def lambda_handler(event, context):
    try:
        log(json.dumps(event.get("headers")))
        result = route(event)
        log(result["statusCode"])
        return result
    except Exception:
        traceback.print_exc()
        return format_response(event=event, http_code=500, body="Internal server error")


# Only using POST because I want to prevent CORS preflight checks, and setting a
# custom header counts as "not a simple request" or whatever, so I need to pass
# in the CSRF token (don't want to pass as a query parameter), so that really
# only leaves POST as an option, as GET has its body removed by AWS somehow
#
# see https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS#simple_requests
def route(event):
    if has_invalid_domain(event=event):
        return format_response(event=event, http_code=403, body={"message": "Forbidden"})
    if path_equals(event=event, method="POST", path="/ping"):
        return format_response(event=event, http_code=200, body="pong")
    return format_response(event=event, http_code=403, body={"message": "Forbidden"})
