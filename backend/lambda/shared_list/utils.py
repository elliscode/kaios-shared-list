import base64
import hashlib
import hmac
import json
import secrets
import time
import os
import re
from urllib.parse import parse_qsl

import boto3

from boto3.dynamodb.types import TypeDeserializer, TypeSerializer
from .logger import log

APP_NAME = os.environ.get("APP_NAME")
DOMAIN_NAMES = os.environ.get("DOMAIN_NAMES", "").split(",")
TABLE_NAME = os.environ.get("DYNAMODB_TABLE_NAME")
ENCRYPTION_KEY = os.environ.get("ENCRYPTION_KEY")
SES_REGION = os.environ.get("SES_REGION", "us-east-1")
SES_SENDER_EMAIL = os.environ.get("SES_SENDER_EMAIL")
SES_REPLY_TO_EMAIL = os.environ.get("SES_REPLY_TO_EMAIL")
SES_TEMPLATE_NAME = os.environ.get("SES_TEMPLATE_NAME")
COOKIE_DOMAIN = os.environ.get("COOKIE_DOMAIN")
EMAIL_REGEX = r"^[^@\s]+@[^@\s]+\.[^@\s]+$"
OTP_TIMEOUT = 5
DELETED_ITEM_RETENTION_DAYS = 4 * 30

digits = "0123456789"
lowercase_letters = "abcdefghijklmnopqrstuvwxyz"
uppercase_letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"

dynamo = boto3.client("dynamodb")
ses = boto3.client("ses", region_name=SES_REGION)


def has_invalid_domain(event):
    return "origin" not in event["headers"] or event["headers"]["origin"].rstrip("/") not in DOMAIN_NAMES


def format_response(event, http_code, body, headers=None, log_this=True):
    if isinstance(body, str):
        body = {"message": body}
    if "origin" in event["headers"] and event["headers"]["origin"].rstrip("/") in DOMAIN_NAMES:
        domain_name = event["headers"]["origin"]
    else:
        log(f'Invalid origin {event["headers"].get("origin")}')
        http_code = 403
        body = {"message": "Forbidden"}
        domain_name = "*"
    all_headers = {
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Origin": domain_name,
        "Access-Control-Allow-Methods": "POST",
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Expose-Headers": "x-csrf-token",
    }
    if headers is not None:
        all_headers.update(headers)
    if log_this:
        log(
            body,
        )
    return {
        "statusCode": http_code,
        "body": json.dumps(body),
        "headers": all_headers,
    }


def parse_body(body):
    if isinstance(body, dict):
        return body
    elif body.startswith("{"):
        return json.loads(body)
    return dict(parse_qsl(body))


def dynamo_obj_to_python_obj(dynamo_obj: dict) -> dict:
    deserializer = TypeDeserializer()
    return {k: deserializer.deserialize(v) for k, v in dynamo_obj.items()}


def python_obj_to_dynamo_obj(python_obj: dict) -> dict:
    serializer = TypeSerializer()
    return {k: serializer.serialize(v) for k, v in python_obj.items()}


def path_equals(event, method, path):
    event_path = event.get("path")
    if not event_path:
        event_path = event.get("requestContext", {}).get("http", {}).get("path")
        stage = event.get("requestContext", {}).get("stage")
        event_path = event_path.removeprefix(f"/{stage}")
    event_method = event.get("httpMethod", event.get("requestContext", {}).get("http", {}).get("method"))
    return event_method == method and (event_path == path or event_path == path + "/" or path == "*")



def parse_cookie(cookie_string):
    cookies = cookie_string.split(" ")
    for cookie in cookies:
        parts = cookie.split("=")
        cookie_name = parts[0].strip(" ;")
        if cookie_name == f"{APP_NAME}-auth-token":
            return parts[1].strip(" ;")
    return None


def get_token(token_string):
    user_data_boto = dynamo.get_item(
        Key=python_obj_to_dynamo_obj({"key1": "token", "key2": token_string}),
        TableName=TABLE_NAME,
    )
    output = None
    if "Item" in user_data_boto:
        output = dynamo_obj_to_python_obj(user_data_boto["Item"])
    return output


def get_active_tokens(user_id):
    active_tokens_boto = dynamo.get_item(
        Key=python_obj_to_dynamo_obj({"key1": "active_tokens", "key2": user_id}),
        TableName=TABLE_NAME,
    )
    if "Item" in active_tokens_boto:
        active_tokens = dynamo_obj_to_python_obj(active_tokens_boto["Item"])
        active_tokens["tokens"] = {k: v for k, v in active_tokens["tokens"].items() if v > int(time.time())}
    else:
        active_tokens = {"key1": "active_tokens", "key2": user_id, "tokens": {}}
    return active_tokens


def delete_token(token_id):
    dynamo.delete_item(
        Key=python_obj_to_dynamo_obj({"key1": "token", "key2": token_id}),
        TableName=TABLE_NAME,
    )


def delete_active_tokens(user_id):
    dynamo.delete_item(
        Key=python_obj_to_dynamo_obj({"key1": "active_tokens", "key2": user_id}),
        TableName=TABLE_NAME,
    )


def find_user_id(email):
    email_data_boto = dynamo.get_item(
        Key=python_obj_to_dynamo_obj({"key1": "email", "key2": hash_email(email)}),
        TableName=TABLE_NAME,
    )
    if "Item" not in email_data_boto:
        return None
    email_data = dynamo_obj_to_python_obj(email_data_boto["Item"])
    if 'user_id' not in email_data:
        return None
    return email_data['user_id']

def get_user_data(user_id):
    user_data_boto = dynamo.get_item(
        Key=python_obj_to_dynamo_obj({"key1": "user", "key2": user_id}),
        TableName=TABLE_NAME,
    )
    output = None
    if "Item" in user_data_boto:
        output = dynamo_obj_to_python_obj(user_data_boto["Item"])
    return output


def authenticate(func):
    def wrapper_func(*args, **kwargs):
        event = args[0]
        cookies_list = event.get("cookies") or []
        cookie_string = event["headers"].get("cookie") or "; ".join(cookies_list)
        if not cookie_string:
            return format_response(event=event, http_code=403, body="No active session, please log in")
        cookie = parse_cookie(cookie_string)
        body = parse_body(event["body"])
        csrf_token = body.get("csrf")
        token_data = get_token(cookie)
        if token_data is None or token_data["expiration"] < int(time.time()):
            return format_response(
                event=event,
                http_code=403,
                body="Your session has expired, please log in",
            )
        active_tokens = get_active_tokens(token_data["user_id"])
        if token_data["key2"] not in active_tokens["tokens"].keys():
            return format_response(
                event=event,
                http_code=403,
                body="Your session has expired, please log in",
            )
        if csrf_token is None or token_data["csrf"] != csrf_token:
            delete_token(token_data["key2"])
            return format_response(
                event=event,
                http_code=403,
                body="Your CSRF token is invalid, your session has expired, please re log in",
            )
        user_data = get_user_data(token_data["user_id"])
        return func(event, user_data, body)

    return wrapper_func

def send_email(to_address, otp_code, expiration_time, user_id):

    # Send templated email
    response = ses.send_templated_email(
        Source=SES_SENDER_EMAIL,
        Destination={
            "ToAddresses": [to_address]  # replace with your email
        },
        Template=SES_TEMPLATE_NAME,
        TemplateData=json.dumps({
            "code": str(otp_code),
            "minutes": str(expiration_time),
            "user_id": str(user_id),
        }),
        # Optional: reply-to
        ReplyToAddresses=[SES_REPLY_TO_EMAIL]
    )

    # Print response from SES
    print("Message ID:", response["MessageId"])


def is_valid_email_format(email: str) -> bool:
    if not isinstance(email, str):
        return False

    if not re.match(EMAIL_REGEX, email):
        return False

    if ".." in email:
        return False

    return True


def get_otp(user_id):
    user_data_boto = dynamo.get_item(
        Key=python_obj_to_dynamo_obj({"key1": "otp", "key2": user_id}),
        TableName=TABLE_NAME,
    )
    output = None
    if "Item" in user_data_boto:
        output = dynamo_obj_to_python_obj(user_data_boto["Item"])
    return output

def create_otp(user_id, otp_value, timeout_minutes):
    python_data = {
        "key1": "otp",
        "key2": user_id,
        "otp": otp_value,
        "expiration": int(time.time()) + (timeout_minutes * 60),
        "last_failure": 0,
    }
    dynamo_data = python_obj_to_dynamo_obj(python_data)
    dynamo.put_item(
        TableName=TABLE_NAME,
        Item=dynamo_data,
    )
    return python_data

def set_otp(python_data):
    dynamo_data = python_obj_to_dynamo_obj(python_data)
    dynamo.put_item(
        TableName=TABLE_NAME,
        Item=dynamo_data,
    )
    return python_data


def delete_otp(user_id):
    dynamo.delete_item(
        Key=python_obj_to_dynamo_obj({"key1": "otp", "key2": user_id}),
        TableName=TABLE_NAME,
    )


def _keystream(key_bytes, nonce, length):
    stream = b''
    counter = 0
    while len(stream) < length:
        stream += hashlib.sha256(key_bytes + nonce + counter.to_bytes(4, 'big')).digest()
        counter += 1
    return stream[:length]

def encrypt_field(value):
    key_bytes = bytes.fromhex(ENCRYPTION_KEY)
    payload = (value if isinstance(value, str) else json.dumps(value)).encode()
    nonce = secrets.token_bytes(16)
    ciphertext = bytes(a ^ b for a, b in zip(payload, _keystream(key_bytes, nonce, len(payload))))
    return base64.b64encode(nonce + ciphertext).decode()

def decrypt_field(encrypted, as_json=False):
    key_bytes = bytes.fromhex(ENCRYPTION_KEY)
    data = base64.b64decode(encrypted)
    nonce, ciphertext = data[:16], data[16:]
    plaintext = bytes(a ^ b for a, b in zip(ciphertext, _keystream(key_bytes, nonce, len(ciphertext)))).decode()
    return json.loads(plaintext) if as_json else plaintext


def hash_email(email):
    return hmac.new(ENCRYPTION_KEY.encode(), email.lower().encode(), hashlib.sha256).hexdigest()


def get_list(list_id):
    result = dynamo.get_item(
        Key=python_obj_to_dynamo_obj({"key1": "list", "key2": list_id}),
        TableName=TABLE_NAME,
    )
    if "Item" in result:
        expire_list(list_id)
        record = dynamo_obj_to_python_obj(result["Item"])
        record["name"] = decrypt_field(record["name"])
        record["list"] = decrypt_field(record["list"], as_json=True)
        return record
    return None


def store_list(list_id, list_data, name):
    cutoff = int(time.time()) - DELETED_ITEM_RETENTION_DAYS * 24 * 60 * 60
    list_data = {
        k: v for k, v in list_data.items()
        if not (v.get("deleted") and int(v["updated"]) < cutoff)
    }
    python_data = {
        "key1": "list",
        "key2": list_id,
        "name": encrypt_field(name),
        "list": encrypt_field(list_data),
        "expiration": int(time.time()) + 365 * 24 * 60 * 60,
    }
    dynamo.put_item(
        TableName=TABLE_NAME,
        Item=python_obj_to_dynamo_obj(python_data),
    )
    return {"name": name, "list": list_data}


def expire_list(list_id, days=365):
    dynamo.update_item(
        TableName=TABLE_NAME,
        Key=python_obj_to_dynamo_obj({"key1": "list", "key2": list_id}),
        UpdateExpression="SET expiration = :exp",
        ExpressionAttributeValues={":exp": {"N": str(int(time.time()) + days * 24 * 60 * 60)}},
    )


def get_user_list_names(user_data):
    raw = user_data.get("list_names") if user_data else None
    if not raw:
        return {}
    return decrypt_field(raw, as_json=True)


def remove_list_from_user(user_id, name):
    user_data = get_user_data(user_id)
    if user_data is None:
        return
    list_names = get_user_list_names(user_data)
    if name in list_names:
        del list_names[name]
        user_data["list_names"] = encrypt_field(list_names)
        dynamo.put_item(
            TableName=TABLE_NAME,
            Item=python_obj_to_dynamo_obj(user_data),
        )


def add_list_to_user(user_id, list_id, name):
    user_data = get_user_data(user_id)
    if user_data is None:
        return
    list_names = get_user_list_names(user_data)
    if list_names.get(name) != list_id:
        list_names[name] = list_id
        user_data["list_names"] = encrypt_field(list_names)
        dynamo.put_item(
            TableName=TABLE_NAME,
            Item=python_obj_to_dynamo_obj(user_data),
        )


@authenticate
def me_route(event, user_data, body):
    return format_response(event=event, http_code=200, body={"list_names": get_user_list_names(user_data), "user_id": user_data["key2"]})


def otp_route(event):
    body = parse_body(event["body"])
    email = (body.get("email") or "").strip()

    if not email:
        return format_response(event=event, http_code=400, body="email is required")
    if not is_valid_email_format(email):
        return format_response(event=event, http_code=400, body="Invalid email")

    # get or create user data
    user_id = find_user_id(email)
    user_data = get_user_data(user_id) if user_id else None
    if user_data is None:
        # New user — generate a random ID so email addresses don't appear as keys in the DB
        user_id = user_id or create_id(10)
        dynamo.put_item(TableName=TABLE_NAME, Item=python_obj_to_dynamo_obj({"key1": "email", "key2": hash_email(email), "user_id": user_id}))
        dynamo.put_item(TableName=TABLE_NAME, Item=python_obj_to_dynamo_obj({"key1": "user", "key2": user_id}))

    # generate and set OTP
    otp_data = get_otp(user_id)
    body_value = {
        "email": email,
        "status": f"OTP already exists for {email}, please log in",
    }
    if otp_data is None or otp_data["expiration"] < int(time.time()):
        otp_value = "".join(secrets.choice(digits) for i in range(6))
        otp_data = create_otp(user_id, otp_value, OTP_TIMEOUT)
        send_email(email, otp_value, OTP_TIMEOUT, user_id)
        body_value = {"email": email}

    return format_response(event=event, http_code=200, body=body_value)


def create_id(length):
    return "".join(secrets.choice(digits + lowercase_letters + uppercase_letters) for i in range(length))


def create_token(user_id):
    python_data = {
        "key1": "token",
        "key2": create_id(32),
        "csrf": create_id(32),
        "user_id": user_id,  # .          m    d    h    m    s
        "expiration": int(time.time()) + (4 * 30 * 24 * 60 * 60),
    }
    dynamo_data = python_obj_to_dynamo_obj(python_data)
    dynamo.put_item(
        TableName=TABLE_NAME,
        Item=dynamo_data,
    )
    return python_data


def track_token(token_data):
    active_tokens = get_active_tokens(token_data["user_id"])
    token_id = token_data["key2"]
    active_tokens["tokens"][token_id] = token_data["expiration"]
    dynamo.put_item(
        TableName=TABLE_NAME,
        Item=python_obj_to_dynamo_obj(active_tokens),
    )


def login_route(event):
    body = parse_body(event["body"])
    email = (body.get("email") or "").strip()
    submitted_otp = (body.get("otp") or "").strip()

    if not email or not submitted_otp:
        return format_response(event=event, http_code=400, body="email and otp are required")

    # get user data
    user_id = find_user_id(email)
    user_data = get_user_data(user_id) if user_id else None
    if user_data is None:
        return format_response(event=event, http_code=400, body="No user exists")

    # get otp
    otp_data = get_otp(user_id)
    if otp_data is None or otp_data["expiration"] < int(time.time()):
        return format_response(
            event=event,
            http_code=400,
            body="OTP expired, please wait 30 seconds and try to log in again",
        )
    diff = otp_data["last_failure"] + 30 - int(time.time())
    if diff > 0:
        return format_response(
            event=event,
            http_code=403,
            body=f"Please wait {diff} seconds before trying to log in again",
        )

    if submitted_otp != otp_data["otp"]:
        otp_data["last_failure"] = int(time.time())
        set_otp(otp_data)
        return format_response(event=event, http_code=403, body="Incorrect OTP, please try again")

    # delete the OTP
    delete_otp(user_id)
    # log in the user and send them the data
    token_data = create_token(user_id)
    # store this token in the list of sessions we track, for clearing sessions manually by the user
    track_token(token_data)

    # generate the date_string
    date_string = time.strftime("%a, %d %b %Y %H:%M:%S GMT", time.gmtime(time.time() + (4 * 30 * 24 * 60 * 60)))

    return format_response(
        event=event,
        http_code=200,
        body={
            "message": "successfully logged in",
        },
        headers={
            "x-csrf-token": token_data["csrf"],
            "Set-Cookie": f'{APP_NAME}-auth-token={token_data["key2"]}; Domain={COOKIE_DOMAIN}; Expires={date_string}; Secure; HttpOnly',
        },
    )