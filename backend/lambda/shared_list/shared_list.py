from shared_list.utils import authenticate, format_response, get_list, store_list, create_id, add_list_to_user, remove_list_from_user, expire_list
from shared_list.list_merge import merge_list
from shared_list.input_validation import validate_id


@authenticate
def store_and_merge_list_route(event, user_data, body):
    name = body.get("name")
    client_list = body.get("list", {})

    if not name or not isinstance(name, str):
        return format_response(event=event, http_code=400, body="name is required")

    list_names = user_data.get("list_names", {}) if user_data else {}
    list_id = list_names.get(name)

    server_list = {}
    if list_id:
        existing = get_list(list_id)
        if existing:
            server_list = existing.get("list", {})

    merged_list, _ = merge_list(client_list, server_list)

    if not list_id:
        list_id = create_id(10)

    store_list(list_id, merged_list, name)

    if user_data:
        add_list_to_user(user_data["key2"], list_id, name)

    return format_response(event=event, http_code=200, body={"list_id": list_id, "name": name, "list": merged_list})


@authenticate
def accept_share_route(event, user_data, body):
    list_id = body.get("list_id")

    if list_id is None:
        return format_response(event=event, http_code=400, body="list_id is required")
    list_id = validate_id(list_id)
    if list_id is None:
        return format_response(event=event, http_code=400, body="Invalid list_id")

    shared_record = get_list(list_id)
    if shared_record is None:
        return format_response(event=event, http_code=404, body="List not found")

    name = shared_record.get("name")
    shared_items = shared_record.get("list", {})

    list_names = user_data.get("list_names", {}) if user_data else {}
    existing_list_id = list_names.get(name)

    if existing_list_id and existing_list_id != list_id:
        existing_record = get_list(existing_list_id)
        existing_items = existing_record.get("list", {}) if existing_record else {}
        merged_items, _ = merge_list(existing_items, shared_items)
        store_list(list_id, merged_items, name)
        expire_list(existing_list_id)
    else:
        merged_items = shared_items

    if user_data:
        add_list_to_user(user_data["key2"], list_id, name)

    return format_response(event=event, http_code=200, body={"list_id": list_id, "name": name, "list": merged_items})


@authenticate
def delete_list_route(event, user_data, body):
    name = body.get("name")
    if not name or not isinstance(name, str):
        return format_response(event=event, http_code=400, body="name is required")

    list_names = user_data.get("list_names", {}) if user_data else {}
    list_id = list_names.get(name)
    if not list_id:
        return format_response(event=event, http_code=404, body="List not found")

    remove_list_from_user(user_data["key2"], name)
    expire_list(list_id)

    return format_response(event=event, http_code=200, body={"name": name})
