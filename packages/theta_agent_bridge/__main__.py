import json
import sys

from .bridge import handle_request


def main() -> None:
    raw = sys.stdin.read()
    try:
        request = json.loads(raw) if raw.strip() else {}
        response = handle_request(request)
    except Exception as exc:  # Keep the bridge protocol stable on unexpected errors.
        response = {
            "status": "error",
            "error": {
                "type": exc.__class__.__name__,
                "message": str(exc),
            },
        }

    print(json.dumps(response, ensure_ascii=False))


if __name__ == "__main__":
    main()
