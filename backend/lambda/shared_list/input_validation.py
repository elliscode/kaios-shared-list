import re

FLOAT_REGEX = "^[\\-]{0,1}\\d*[\\.]{0,1}\\d+$"
ID_REGEX = "^[a-zA-Z0-9]{10}$"


def validate_unix_time(value):
    if isinstance(value, str) and value.isnumeric():
        return value
    elif isinstance(value, int):
        return str(value)
    return None


def validate_id(value):
    if isinstance(value, str) and re.match(ID_REGEX, value):
        return value
    return None


def validate_decimal(value):
    if isinstance(value, str) and re.match(FLOAT_REGEX, value):
        return value
    elif isinstance(value, float):
        return str(value)
    return None


def validate_schema(value, schema):
    if schema["type"] == list or schema["type"] == dict:
        if not isinstance(value, schema["type"]):
            return None
        if schema["type"] == list:
            output = []
            for value_item in value:
                result = validate_schema(value_item, schema["elements"])
                if not result:
                    return None
                output.append(result)
            return output
        if schema["type"] == dict:
            output = {}
            for field in schema["fields"]:
                if "name" not in field:
                    for key, val in value.items():
                        result = validate_schema(val, field['elements'])
                        if not result:
                            return None
                        output[key] = result
                elif field["name"] not in value and not field.get("optional"):
                    return None
                elif field["name"] in value:
                    result = validate_schema(value[field["name"]], field)
                    if result is None:
                        return None
                    output[field["name"]] = result
            return output
    elif callable(schema["type"]):
        result = schema["type"].__call__(value)
        if result is not None:
            return result
        return None
    return None


LOCATION_SHARING_SCHEMA = {
    "type": dict,
    "fields": [
        {"type": validate_id, "name": "id"},
        {"type": validate_decimal, "name": "lat"},
        {"type": validate_decimal, "name": "lon"},
    ],
}

LOCATION_VIEWING_SCHEMA = {
    "type": dict,
    "fields": [
        {"type": validate_id, "name": "id"},
    ],
}


TOKEN_REQUEST_SCHEMA = {
    "type": dict,
    "fields": [
        {"type": validate_id, "name": "id"},
    ],
}

LIST_SCHEMA = {
    "type": dict,
    "fields": [
        {
            "type": list,
            "elements": {
                "type": dict,
                "fields": [
                    {"type": validate_unix_time, "name": "updated"},
                    {"type": str, "name": "display"},
                    {"type": bool, "name": "crossed"},
                    {"type": bool, "name": "deleted"},
                ],
            },
        },
    ],
}

if __name__ == "__main__":
    print(
        validate_schema(
            {
                "broccoli": {"updated": 1234567890, "display": "Broccoli ", "crossed": True, "deleted": False},
                "cheese": {"updated": 1234567891, "display": "  CHEESE  ", "crossed": True, "deleted": False},
                "turnips": {"updated": 1234567892, "display": "turNIPS", "crossed": True, "deleted": False},
                "cheese sticks": {"updated": 1234567893, "display": "Cheese Sticks", "crossed": True, "deleted": False},
                "beef jerky": {"updated": 1234567893, "display": "beef jerky", "crossed": True, "deleted": False},
            },
            LIST_SCHEMA,
        )
    )
    print(
        validate_schema(
            {
                "lat": "40.5123",
                "lon": "-71.4123",
                "id": "a5123zZmfs",
            },
            LOCATION_SHARING_SCHEMA,
        )
    )
    print(
        validate_schema(
            {
                "lat": "40W",
                "lon": "-71S",
                "id": "My-id",
            },
            LOCATION_SHARING_SCHEMA,
        )
    )
    print(
        validate_schema(
            {
                "id": "a5123zZmfs",
            },
            LOCATION_VIEWING_SCHEMA,
        )
    )
