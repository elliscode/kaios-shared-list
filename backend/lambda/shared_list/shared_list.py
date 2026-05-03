from shared_list.utils import authenticate, format_response, get_list, store_list, create_id, add_list_id_to_user
from shared_list.list_merge import merge_list
from shared_list.input_validation import validate_id


@authenticate
def store_and_merge_list_route(event, user_data, body):
    list_id = body.get("list_id")
    client_list = body.get("list", {})

    if list_id is not None:
        list_id = validate_id(list_id)
        if list_id is None:
            return format_response(event=event, http_code=400, body="Invalid list_id")

    server_list = {}
    if list_id:
        existing = get_list(list_id)
        if existing:
            server_list = existing.get("list", {})

    merged_list, _ = merge_list(client_list, server_list)

    if not list_id:
        list_id = create_id(10)

    store_list(list_id, merged_list)

    if user_data:
        add_list_id_to_user(user_data["key2"], list_id)

    return format_response(event=event, http_code=200, body={"list_id": list_id, "list": merged_list})
