import json
from shared_list.input_validation import validate_schema, LIST_SCHEMA


def merge_list(client_list, server_list):
    """
    Merge client_list into server_list based on 'updated' timestamps.

    Args:
        client_list (dict): {item_key: {updated, display, crossed, deleted}}
        server_list (dict): same format as client_list

    Returns:
        tuple:
            merged_list (dict): merged dictionary of all items
            modified_items (dict): items that changed compared to server_list
    """
    client_list = validate_schema(client_list, LIST_SCHEMA)
    server_list = validate_schema(server_list, LIST_SCHEMA)
    if not client_list:
        return (server_list or {}, {})

    merged_list = server_list.copy()
    modified_items = {}

    for key, client_item in client_list.items():
        server_item = server_list.get(key)

        # If server has no such item, or client is newer, merge it
        if (not server_item) or (client_item["updated"] > server_item["updated"]):
            merged_list[key] = client_item
            modified_items[key] = client_item
        else:
            # server item is newer or same, keep server's
            merged_list[key] = server_item

    # Include server items that client did not have (unchanged)
    for key, server_item in server_list.items():
        if key not in merged_list:
            merged_list[key] = server_item

    return merged_list, modified_items


if __name__ == "__main__":
    print(json.dumps(merge_list(
        client_list=
            {
                "broccoli": {"updated": 1234567890, "display": "Broccoli ", "crossed": False, "deleted": False},
                "cheese": {"updated": 1234567891, "display": "  CHEESE  ", "crossed": False, "deleted": False},
                "turnips": {"updated": 1234560008, "display": "turNIPS", "crossed": True, "deleted": False},
                "cheese sticks": {"updated": 1234567893, "display": "Cheese Sticks", "crossed": False, "deleted": False},
                "beef jerky": {"updated": 1234569999, "display": "beef jerky", "crossed": True, "deleted": True},
            },
        server_list=
        {
            "broccoli": {"updated": 1234567890, "display": "Broccoli ", "crossed": False, "deleted": False},
            "cheese": {"updated": 1234567891, "display": "  CHEESE  ", "crossed": False, "deleted": False},
            "turnips": {"updated": 1234567892, "display": "turNIPS", "crossed": False, "deleted": False},
            "cheese sticks": {"updated": 1234567893, "display": "Cheese Sticks", "crossed": False, "deleted": False},
            "beef jerky": {"updated": 1234567893, "display": "beef jerky", "crossed": False, "deleted": False},
        },
    ), indent=2))

    print(json.dumps(merge_list({
        "broccoli": {"updated": 1773527423, "display": "Broccoli", "crossed": False, "deleted": False},
        "cheese": {"updated": 1773529999, "display": "Cheese", "crossed": True, "deleted": False},
    }, {
        "broccoli": {"updated": 1773527423, "display": "Broccoli", "crossed": False, "deleted": False},
        "cheese": {"updated": 1773524152, "display": "Cheese", "crossed": False, "deleted": False},
    }), indent=2))
